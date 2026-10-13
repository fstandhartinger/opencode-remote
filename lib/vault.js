// lib/vault.js — per-chat encryption for opencode-remote.
//
// Blob format v1 (all integers unsigned, big-endian where >1 byte):
//   magic "OCRVAULT" (8) | version=1 (1) | kdf=1 scrypt (1) | log2 N (1) | r (1) | p (1)
//   | salt (16) | nonce (12) | AES-256-GCM ciphertext (n) | tag (16)
// The 41-byte header is the GCM additional data, so any change to the parameters,
// salt or nonce fails authentication. The plaintext is gzip(JSON bundle).
// The password only ever exists in memory here; it is never logged or stored.

import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

export const MAGIC = Buffer.from('OCRVAULT', 'ascii');
export const VERSION = 1;
const KDF_SCRYPT = 1;
const HEADER_LEN = 8 + 5 + 16 + 12;
const TAG_LEN = 16;
// N = 2^17, r = 8 → 128 MiB and roughly a third of a second per derivation.
export const DEFAULT_KDF = { logN: 17, r: 8, p: 1 };
const MAX_PLAINTEXT = 256 * 1024 * 1024;

export class VaultError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'VaultError';
    this.code = code; // 'password' | 'corrupt' | 'format' | 'state' | 'helper' | 'verify'
  }
}

export function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (pw.length > 1024) return 'Password is too long.';
  return null;
}

async function deriveKey(password, salt, { logN, r, p }) {
  const N = 2 ** logN;
  return scrypt(Buffer.from(password.normalize('NFC'), 'utf8'), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
}

export async function encryptBundle(bundle, password, kdf = DEFAULT_KDF) {
  const err = validatePassword(password);
  if (err) throw new VaultError('password', err);
  const salt = crypto.randomBytes(16);
  const nonce = crypto.randomBytes(12);
  const header = Buffer.concat([
    MAGIC,
    Buffer.from([VERSION, KDF_SCRYPT, kdf.logN, kdf.r, kdf.p]),
    salt,
    nonce,
  ]);
  const key = await deriveKey(password, salt, kdf);
  try {
    const plain = await gzip(Buffer.from(JSON.stringify(bundle), 'utf8'));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(header);
    const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([header, ct, cipher.getAuthTag()]);
  } finally {
    key.fill(0);
  }
}

export function parseHeader(blob) {
  if (!Buffer.isBuffer(blob) || blob.length < HEADER_LEN + TAG_LEN) throw new VaultError('corrupt', 'Encrypted file is truncated.');
  if (!blob.subarray(0, 8).equals(MAGIC)) throw new VaultError('corrupt', 'Not an encrypted chat file.');
  const [version, kdfId, logN, r, p] = blob.subarray(8, 13);
  if (version !== VERSION) throw new VaultError('format', `Unsupported file version ${version}.`);
  // Bounds keep a damaged or hostile header from asking for gigabytes of scrypt memory.
  if (kdfId !== KDF_SCRYPT || logN < 14 || logN > 20 || r < 1 || r > 16 || p < 1 || p > 4) {
    throw new VaultError('corrupt', 'Encrypted file header is damaged.');
  }
  return {
    header: blob.subarray(0, HEADER_LEN),
    kdf: { logN, r, p },
    salt: blob.subarray(13, 29),
    nonce: blob.subarray(29, HEADER_LEN),
    ct: blob.subarray(HEADER_LEN, blob.length - TAG_LEN),
    tag: blob.subarray(blob.length - TAG_LEN),
  };
}

export async function decryptBundle(blob, password) {
  if (typeof password !== 'string' || !password) throw new VaultError('password', 'Wrong password.');
  const h = parseHeader(blob);
  const key = await deriveKey(password, h.salt, h.kdf);
  let plain;
  try {
    const d = crypto.createDecipheriv('aes-256-gcm', key, h.nonce);
    d.setAAD(h.header);
    d.setAuthTag(h.tag);
    plain = Buffer.concat([d.update(h.ct), d.final()]);
  } catch {
    // GCM cannot tell a wrong password from a modified file; the caller checks the
    // stored blob hash first so a failure here almost always means a wrong password.
    throw new VaultError('password', 'Wrong password (or the file was modified).');
  } finally {
    key.fill(0);
  }
  let json;
  try {
    json = await gunzip(plain, { maxOutputLength: MAX_PLAINTEXT });
  } catch {
    throw new VaultError('corrupt', 'Decrypted data is damaged.');
  }
  try {
    return JSON.parse(json.toString('utf8'));
  } catch {
    throw new VaultError('corrupt', 'Decrypted data is damaged.');
  }
}

// ---------------------------------------------------------------------------
// bundle helpers
// ---------------------------------------------------------------------------

// Stable JSON (sorted keys) so a digest survives a DB round trip that reorders keys.
export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  }
  return JSON.stringify(v);
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/** Per-session message count + content digest, used to prove a round trip. */
export function digestSession(exp) {
  const msgs = Array.isArray(exp.messages) ? exp.messages : [];
  const perMessage = msgs.map((m) => sha256(canonical({ info: m.info, parts: m.parts })));
  return { id: exp.info && exp.info.id, messageCount: msgs.length, partCount: msgs.reduce((n, m) => n + (m.parts || []).length, 0), sha256: sha256(perMessage.join('\n')) };
}

const TOOL_OUTPUT_RE = /tool-output\/(tool_[A-Za-z0-9]{8,64})/g;

/** Names of truncated tool-output files a session refers to. */
export function toolOutputNames(sessions) {
  const names = new Set();
  const text = JSON.stringify(sessions);
  for (const m of text.matchAll(TOOL_OUTPUT_RE)) names.add(m[1]);
  return [...names];
}

export function newLockId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(20);
  let s = 'lk_';
  for (const b of bytes) s += alphabet[b % 36];
  return s;
}

// ---------------------------------------------------------------------------
// helper client (host-side companion: blob store, import, purge)
// ---------------------------------------------------------------------------
export class VaultHelper {
  constructor({ url, token, fetchImpl } = {}) {
    this.url = url ? String(url).replace(/\/+$/, '') : '';
    this.token = token || '';
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
  }

  get enabled() { return !!(this.url && this.token); }

  async call(method, path, body) {
    let res;
    try {
      res = await this.fetchImpl(this.url + path, {
        method,
        headers: { Authorization: 'Bearer ' + this.token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new VaultError('helper', 'Vault helper unreachable.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      const e = new VaultError('helper', (data && typeof data.error === 'string' ? data.error : 'vault helper error') + ` (${res.status})`);
      e.status = res.status;
      throw e;
    }
    return data;
  }

  index() { return this.call('GET', '/index').then((d) => (d && d.entries) || {}); }
  async getBlob(id) { const d = await this.call('GET', `/entry/${id}/blob`); return Buffer.from(d.blob, 'base64'); }
  put(id, meta, blob) { return this.call('PUT', `/entry/${id}`, blob ? { meta, blob: blob.toString('base64') } : { meta }).then((d) => d.entry); }
  remove(id) { return this.call('DELETE', `/entry/${id}`); }
  readToolOutputs(names) { return names.length ? this.call('POST', '/tool-output/read', { names }).then((d) => d.files || {}) : Promise.resolve({}); }
  importSessions(directory, sessions, files) { return this.call('POST', '/import', { directory, sessions, files }); }
  purge(sessionIDs, toolOutputs) { return this.call('POST', '/purge', { sessionIDs, toolOutputs }); }
}
