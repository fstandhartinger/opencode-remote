// server.js — opencode-remote backend.
// Password-protected browser remote for `opencode serve`.
// Plain node:http, ESM, no build step.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Upstream, UpstreamError } from './lib/upstream.js';
import { verifyPassword, signToken, verifyToken, LoginRateLimiter, COOKIE_NAME } from './lib/auth.js';
import { validateDirectory, validateExistingDirectory, isValidSessionId, isValidPermissionId, shellQuote } from './lib/validate.js';
import { sanitizeModels, splitFeatured } from './lib/models.js';
import { EventHub } from './lib/events.js';
import { VaultHelper, VaultError, encryptBundle, decryptBundle, validatePassword, digestSession, toolOutputNames, newLockId, sha256 } from './lib/vault.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT || 8080);
const APP_PASSWORD = process.env.APP_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const OPENCODE_URL = process.env.OPENCODE_URL;
const OPENCODE_USERNAME = process.env.OPENCODE_USERNAME || 'opencode';
const OPENCODE_PASSWORD = process.env.OPENCODE_PASSWORD || '';
const DEFAULT_DIRECTORY = process.env.DEFAULT_DIRECTORY || '/home/flori/Dev';
const ALLOWED_DIR_PREFIX = process.env.ALLOWED_DIR_PREFIX || '/home/flori/';
// Where a new session runs when the Directory field is left empty.
const NEW_SESSION_DIRECTORY = process.env.NEW_SESSION_DIRECTORY || '/home/flori/Dev/temp';
// Automated health probes create a session every few minutes under /tmp; they
// drown out real work in the session list unless hidden.
const PROBE_DIR_PREFIX = '/tmp/';
// Host-side vault helper (blob store, opencode import, purge). Encryption is off without it.
const VAULT_URL = process.env.VAULT_URL || '';
const VAULT_TOKEN = process.env.VAULT_TOKEN || '';
const PRIVATE_TITLE_PREFIX = 'Private chat \u00b7 ';

if (!APP_PASSWORD) {
  console.error('APP_PASSWORD is required');
  process.exit(1);
}
if (!SESSION_SECRET) {
  console.error('SESSION_SECRET is required');
  process.exit(1);
}
if (!OPENCODE_URL) {
  console.error('OPENCODE_URL is required');
  process.exit(1);
}

const upstream = new Upstream({
  opencodeUrl: OPENCODE_URL,
  opencodeUsername: OPENCODE_USERNAME,
  opencodePassword: OPENCODE_PASSWORD,
});
const limiter = new LoginRateLimiter();
const hub = new EventHub(upstream);
const vault = new VaultHelper({ url: VAULT_URL, token: VAULT_TOKEN });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
};

function json(res, status, data, extraHeaders = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...SECURITY_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

function noContent(res) {
  res.writeHead(204, { ...SECURITY_HEADERS });
  res.end();
}

function sendError(res, status, message, extraHeaders = {}) {
  json(res, status, { error: message, status }, extraHeaders);
}

// The reverse proxy (Traefik) appends the real peer address as the LAST
// X-Forwarded-For entry; earlier entries are client-controlled and spoofable,
// so keying the login rate limit on them would let an attacker reset it.
function clientIP(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) {
    const last = xff.split(',').pop().trim();
    if (last) return last;
  }
  return req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : 'unknown';
}

function readBody(req, limitBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function parseJsonBody(req) {
  const ct = req.headers['content-type'] || '';
  if (!ct.toLowerCase().includes('application/json')) {
    throw new Error('Content-Type must be application/json');
  }
  const text = await readBody(req);
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('invalid JSON body');
  }
}

// ---- session cookie ----
function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function setSessionCookie(res, token) {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=' + (30 * 24 * 60 * 60),
  ].join('; ');
  res.setHeader('Set-Cookie', attrs);
}

function clearSessionCookie(res) {
  const attrs = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict',
    'Path=/',
    'Max-Age=0',
  ].join('; ');
  res.setHeader('Set-Cookie', attrs);
}

// ---- CSRF / same-origin check for mutating routes ----
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const host = req.headers.host;
  if (!host) return false;
  try {
    const u = new URL(origin);
    return u.host === host;
  } catch {
    return false;
  }
}

function isAuthed(req) {
  const token = getCookie(req, COOKIE_NAME);
  return !!token && verifyToken(token, SESSION_SECRET);
}

// ---- upstream URL building ----
function qp(params) {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
  }
  return parts.length ? '?' + parts.join('&') : '';
}

// ---- directory browser / fs list ----
const FS_LIST_ENDPOINT = '/file';

// ---------------------------------------------------------------------------
// Static serving (login assets) — never serves under /api
// ---------------------------------------------------------------------------
const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  let p = urlPath === '/' ? '/index.html' : urlPath;
  // Prevent path traversal out of public/
  const safe = path.posix.normalize(p).replace(/^(\.\.(\/|\\|$))+/, '');
  const file = path.join(PUBLIC_DIR, safe);
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return false;
    const ext = path.extname(file);
    const type = STATIC_MIME[ext] || 'application/octet-stream';
    // No build step means no hashed filenames: force revalidation so a phone never
    // keeps running an old views.js against a newer backend after a deploy.
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', ...SECURITY_HEADERS });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function isStaticPublicUrl(p) {
  return p === '/login.html' || p === '/styles.css' || p === '/theme.js' || p === '/login.css' || p === '/login.js' || p === '/app.js' || p === '/markdown.js' || p === '/favicon.svg' || p === '/favicon.ico';
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
async function handle(req, res) {
  const method = req.method;
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const isApi = pathname.startsWith('/api/') || pathname === '/api';

  // 1) healthz — no auth, no upstream
  if (pathname === '/healthz' && method === 'GET') return json(res, 200, { ok: true });

  // 2) Login page + login assets (no auth)
  if (pathname === '/login' && method === 'GET') {
    if (serveStatic(res, '/login.html')) return;
    return sendError(res, 404, 'not found');
  }
  if (isStaticPublicUrl(pathname) && method === 'GET') {
    if (serveStatic(res, pathname)) return;
    return sendError(res, 404, 'not found');
  }

  // 3) POST /login
  if (pathname === '/login' && method === 'POST') {
    return handleLogin(req, res);
  }

  // 4) POST /logout
  if (pathname === '/logout' && method === 'POST') {
    clearSessionCookie(res);
    return noContent(res);
  }

  // ---- everything else requires auth ----
  if (!isAuthed(req)) {
    if (isApi) return sendError(res, 401, 'unauthorized');
    // page route → redirect to login
    res.writeHead(302, { Location: '/login.html', ...SECURITY_HEADERS });
    return res.end();
  }

  // 5) static app assets require auth too (serve after auth)
  if (!isApi && method === 'GET') {
    if (pathname === '/') {
      if (serveStatic(res, '/index.html')) return;
      return sendError(res, 404, 'not found');
    }
    if (serveStatic(res, pathname)) return;
    return sendError(res, 404, 'not found');
  }

  // 6) API routes
  if (isApi) {
    return handleApi(req, res, url, method);
  }

  return sendError(res, 404, 'not found');
}

// ---------------------------------------------------------------------------
// Login handler
// ---------------------------------------------------------------------------
async function handleLogin(req, res) {
  const ip = clientIP(req);
  if (limiter.blocked(ip)) return sendError(res, 429, 'too many attempts');

  const body = await parseJsonBody(req).catch(() => ({}));
  const password = typeof body.password === 'string' ? body.password : '';

  if (!verifyPassword(password, APP_PASSWORD)) {
    const over = limiter.fail(ip);
    if (over) return sendError(res, 429, 'too many attempts');
    return sendError(res, 401, 'incorrect password');
  }

  limiter.clear(ip);
  const { token } = signToken(SESSION_SECRET);
  setSessionCookie(res, token);
  return json(res, 200, { ok: true });
}

// ---------------------------------------------------------------------------
// API handlers
// ---------------------------------------------------------------------------
async function handleApi(req, res, url, method) {
  const pathname = url.pathname;

  // Mutating routes require JSON content-type + same-origin.
  const isMutation = method === 'POST' || method === 'PUT' || method === 'DELETE' || method === 'PATCH';
  if (isMutation) {
    if (!sameOrigin(req)) return sendError(res, 403, 'cross-origin request rejected');
    const ct = req.headers['content-type'] || '';
    if (!ct.toLowerCase().includes('application/json')) {
      return sendError(res, 415, 'Content-Type must be application/json');
    }
  }

  try {
    // ---- status ----
    if (pathname === '/api/status' && method === 'GET') {
      return await apiStatus(res);
    }

    // ---- config (non-secret UI defaults) ----
    if (pathname === '/api/config' && method === 'GET') {
      return json(res, 200, { newSessionDirectory: NEW_SESSION_DIRECTORY, allowedPrefix: ALLOWED_DIR_PREFIX, vault: vault.enabled });
    }

    // ---- models ----
    if (pathname === '/api/models' && method === 'GET') {
      return await apiModels(res);
    }

    // ---- sessions ----
    if (pathname === '/api/sessions' && method === 'GET') {
      return await apiSessionsList(res, url);
    }
    if (pathname === '/api/sessions' && method === 'POST') {
      const body = await parseJsonBody(req);
      return await apiCreateSession(res, body);
    }

    // ---- sessions/:id and sessions/:id/(prompt|abort) ----
    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(?:\/(prompt|abort))?$/);
    if (sessionMatch) {
      const id = decodeURIComponent(sessionMatch[1]);
      const sub = sessionMatch[2];
      if (!isValidSessionId(id)) return sendError(res, 400, 'invalid session id');
      if (!sub && method === 'GET') return await apiSessionGet(res, id, url);
      if (!sub && method === 'DELETE') {
        const body = await parseJsonBody(req);
        return await apiSessionDelete(res, id, body);
      }
      if (method === 'POST') {
        const body = await parseJsonBody(req);
        const action = sub || body.action;
        if (action === 'prompt') return await apiPrompt(res, id, body);
        if (action === 'abort') return await apiAbort(res, id, body);
        return sendError(res, 400, 'unknown action');
      }
      return sendError(res, 405, 'method not allowed');
    }

    // ---- permissions ----
    if (pathname === '/api/permissions' && method === 'GET') {
      const dir = url.searchParams.get('directory');
      const d = dir || DEFAULT_DIRECTORY;
      return await apiGetPermissions(res, d);
    }
    const permMatch = pathname.match(/^\/api\/permissions\/([^/]+)\/reply$/);
    if (permMatch && method === 'POST') {
      const rid = decodeURIComponent(permMatch[1]);
      if (!isValidPermissionId(rid)) return sendError(res, 400, 'invalid permission id');
      const body = await parseJsonBody(req);
      const d = body.directory || DEFAULT_DIRECTORY;
      return await apiPermissionReply(res, rid, d, body.reply);
    }

    // ---- questions ----
    if (pathname === '/api/questions' && method === 'GET') {
      const v = validateExistingDirectory(url.searchParams.get('directory') || DEFAULT_DIRECTORY);
      if (!v.ok) return sendError(res, 400, v.error);
      const data = await upstream.json('/question' + qp({ directory: v.dir }));
      return json(res, 200, { questions: Array.isArray(data) ? data : [] });
    }
    const questionMatch = pathname.match(/^\/api\/questions\/([^/]+)\/(reject|reply)$/);
    if (questionMatch && method === 'POST') {
      const qid = decodeURIComponent(questionMatch[1]);
      if (!isValidPermissionId(qid)) return sendError(res, 400, 'invalid question id');
      const body = await parseJsonBody(req);
      const v = validateExistingDirectory(body.directory || DEFAULT_DIRECTORY);
      if (!v.ok) return sendError(res, 400, v.error);
      if (questionMatch[2] === 'reject') {
        await upstream.fetch('/question/' + qid + '/reject' + qp({ directory: v.dir }), { method: 'POST' });
        return noContent(res);
      }
      const answers = sanitizeAnswers(body.answers);
      if (!answers) return sendError(res, 400, 'invalid answers');
      await upstream.json('/question/' + qid + '/reply' + qp({ directory: v.dir }), { body: { answers } });
      return noContent(res);
    }

    // ---- directories ----
    if (pathname === '/api/directories/suggest' && method === 'GET') {
      return await apiDirectoriesSuggest(res);
    }
    if (pathname === '/api/directories' && method === 'GET') {
      const p = url.searchParams.get('path');
      const base = p ? p : DEFAULT_DIRECTORY;
      const v = validateDirectory(base, ALLOWED_DIR_PREFIX);
      if (!v.ok) return sendError(res, 400, v.error);
      return await apiListDirectory(res, v.dir);
    }

    // ---- vault (encrypted chats) ----
    if (pathname.startsWith('/api/vault')) {
      if (!vault.enabled) return sendError(res, 404, 'encryption is not configured');
      if (pathname === '/api/vault' && method === 'GET') return await apiVaultList(res);
      if (pathname === '/api/vault/encrypt' && method === 'POST') return await apiVaultEncrypt(res, await parseJsonBody(req));
      const vm = pathname.match(/^\/api\/vault\/(lk_[a-z0-9]{20})(?:\/(decrypt))?$/);
      if (vm && vm[2] === 'decrypt' && method === 'POST') return await apiVaultDecrypt(res, vm[1], await parseJsonBody(req));
      if (vm && !vm[2] && method === 'DELETE') return await apiVaultDelete(res, vm[1]);
      return sendError(res, 404, 'not found');
    }

    // ---- events (SSE) ----
    if (pathname === '/api/events' && method === 'GET') {
      return apiEvents(req, res, url);
    }

    return sendError(res, 404, 'not found');
  } catch (err) {
    if (err && err.name === 'UpstreamError') {
      // An upstream 401/403 means OUR opencode credentials are wrong. Passing it
      // through would make the browser think its own session expired and loop
      // on the login page.
      const st = err.status === 401 || err.status === 403 || !err.status ? 502 : err.status;
      return sendError(res, st, shortUpstreamMessage(err));
    }
    if (err && err.name === 'VaultError') {
      const st = { password: 400, corrupt: 422, format: 422, state: 409, verify: 500 }[err.code] || (err.status === 409 ? 409 : 502);
      return sendError(res, st, err.message, { 'X-Vault-Error': err.code });
    }
    if (err && err.message === 'body too large') return sendError(res, 413, 'body too large');
    if (err && err.message === 'invalid JSON body') return sendError(res, 400, 'invalid JSON');
    if (err && err.message && err.message.startsWith('Content-Type')) return sendError(res, 415, err.message);
    console.error('handler error:', err && err.stack || err);
    return sendError(res, 500, 'internal error');
  }
}

function shortUpstreamMessage(err) {
  const m = err && err.upstreamOp;
  if (m) return `upstream error (${m})`;
  return 'upstream error';
}

// ---------------------------------------------------------------------------
// API: status
// ---------------------------------------------------------------------------
async function apiStatus(res) {
  let opencode = 'down';
  let version = '';
  try {
    const data = await upstream.json('/global/health');
    opencode = 'up';
    version = data && data.version !== undefined ? String(data.version) : '';
  } catch { /* keep down */ }
  return json(res, 200, { opencode, version });
}

// ---------------------------------------------------------------------------
// API: models
// ---------------------------------------------------------------------------
async function apiModels(res) {
  const providers = await upstream.json('/config/providers');
  const models = sanitizeModels(providers);
  const { featured, more } = splitFeatured(models);
  return json(res, 200, { featured, more });
}

// ---------------------------------------------------------------------------
// API: sessions list
// ---------------------------------------------------------------------------
async function apiSessionsList(res, url) {
  const cursor = url.searchParams.get('cursor');
  const search = url.searchParams.get('search');
  const limitRaw = url.searchParams.get('limit');
  let limit = 50;
  if (limitRaw && /^\d+$/.test(limitRaw)) limit = Math.min(Number(limitRaw), 200);

  const hideProbes = url.searchParams.get('hideProbes') === '1';
  if (cursor && !/^\d+$/.test(cursor)) return sendError(res, 400, 'invalid cursor');

  // With probes hidden, scan bigger upstream pages until `limit` real sessions
  // are found (probes can outnumber real sessions 10:1).
  const pageSize = hideProbes ? 500 : limit;
  const out = [];
  let upCursor = cursor || null;
  let exhausted = false;
  for (let page = 0; page < (hideProbes ? 6 : 1) && out.length < limit; page++) {
    const params = { roots: 'true', limit: String(pageSize) };
    if (search) params.search = search;
    if (upCursor) params.cursor = upCursor;
    const sessions = await upstream.json('/experimental/session' + qp(params));
    if (!Array.isArray(sessions)) return sendError(res, 502, 'bad upstream data');
    for (const s of sessions) {
      if (out.length >= limit) break;
      if (hideProbes && isProbeSession(s)) continue;
      out.push(s);
    }
    if (sessions.length < pageSize) { exhausted = true; break; }
    upCursor = sessions[sessions.length - 1].time?.updated ?? null;
    if (!upCursor) { exhausted = true; break; }
  }

  // Merge busy status where cheap (distinct directories, max 10 parallel).
  const sessionsJson = await mergeStatus(out);
  let nextCursor = null;
  if (out.length >= limit) nextCursor = out[out.length - 1].time?.updated ?? null;
  else if (!exhausted && upCursor) nextCursor = upCursor;
  return json(res, 200, { sessions: sessionsJson.map(listSession), cursor: nextCursor });
}

function isProbeSession(s) {
  return !!(s && typeof s.directory === 'string' && s.directory.startsWith(PROBE_DIR_PREFIX));
}

// The list only needs a few fields; upstream sessions also carry permission
// rule sets and token counters that would bloat the payload.
function listSession(s) {
  return {
    id: s.id,
    title: s.title,
    slug: s.slug,
    directory: s.directory,
    model: s.model ? { id: s.model.id, providerID: s.model.providerID } : undefined,
    cost: s.cost,
    time: s.time,
    summary: s.summary,
    busy: s.busy,
  };
}

function sanitizeAnswers(answers) {
  if (!Array.isArray(answers) || answers.length > 20) return null;
  const out = [];
  for (const a of answers) {
    if (!Array.isArray(a) || a.length > 20) return null;
    const row = [];
    for (const x of a) {
      if (typeof x !== 'string' || x.length > 4000) return null;
      row.push(x);
    }
    out.push(row);
  }
  return out;
}

async function mergeStatus(sessions) {
  const dirs = [];
  for (const s of sessions) {
    const d = s.directory;
    if (d && dirs.length < 10 && !dirs.includes(d)) dirs.push(d);
  }
  const map = new Map();
  const results = await Promise.allSettled(
    dirs.map((d) => upstream.json('/session/status' + qp({ directory: d })))
  );
  results.forEach((r, i) => {
    if (r.status === 'fulfilled' && r.value && typeof r.value === 'object') map.set(dirs[i], r.value);
  });
  // Annotate sessions with busy state
  for (const s of sessions) {
    const d = s.directory;
    if (d && map.has(d)) {
      const st = map.get(d)[s.id];
      s.busy = !!(st && st.type === 'busy');
    }
  }
  return sessions;
}

// ---------------------------------------------------------------------------
// API: single session + messages
// ---------------------------------------------------------------------------
async function apiSessionGet(res, id, url) {
  const dir = url.searchParams.get('directory') || DEFAULT_DIRECTORY;
  if (!isValidSessionId(id)) return sendError(res, 400, 'invalid session id');
  // Existing sessions may live anywhere (e.g. /tmp); ALLOWED_DIR_PREFIX only
  // restricts where NEW sessions are created.
  const v = validateExistingDirectory(dir);
  if (!v.ok) return sendError(res, 400, v.error);

  const before = url.searchParams.get('before');
  if (before && !/^msg_[A-Za-z0-9]+$/.test(before)) return sendError(res, 400, 'invalid before');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw && /^\d+$/.test(limitRaw) ? String(Math.min(Number(limitRaw), 500)) : '200';

  const [session, messages, statuses] = await Promise.all([
    upstream.json('/session/' + id + qp({ directory: v.dir })),
    upstream.json('/session/' + id + '/message' + qp({ directory: v.dir, limit, before })),
    before ? null : upstream.json('/session/status' + qp({ directory: v.dir })).catch(() => null),
  ]);
  const st = statuses && typeof statuses === 'object' ? statuses[id] : null;
  return json(res, 200, { session, messages, status: st && st.type ? st.type : 'idle' });
}

// ---------------------------------------------------------------------------
// API: create session (optionally creating the directory first)
// ---------------------------------------------------------------------------
async function apiCreateSession(res, body) {
  const rawDir = body.directory;
  const createDirectory = body.createDirectory === true;
  // A private chat gets a preset title: opencode only runs its title generator
  // (small_model) while a session still has the default "New session - <ISO>" title.
  const isPrivate = body.private === true;
  const title = isPrivate ? PRIVATE_TITLE_PREFIX + berlinStamp(new Date())
    : typeof body.title === 'string' && body.title ? body.title : undefined;
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
  const model = body.model;

  if (!prompt) return sendError(res, 400, 'prompt required');
  if (!model || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') {
    return sendError(res, 400, 'model required');
  }

  const useDefault = typeof rawDir !== 'string' || rawDir.trim() === '';
  const v = validateDirectory(useDefault ? NEW_SESSION_DIRECTORY : rawDir.trim(), ALLOWED_DIR_PREFIX);
  if (!v.ok) return sendError(res, 400, v.error);

  const dir = v.dir;

  if ((createDirectory || useDefault) && !(await directoryExists(dir))) {
    // 1) create a helper session in ALLOWED_DIR_PREFIX
    let helper;
    try {
      helper = await upstream.json('/session' + qp({ directory: ALLOWED_DIR_PREFIX }), {
        body: { title: 'opencode-remote mkdir helper' },
      });
    } catch (err) {
      if (err && err.name === 'UpstreamError') return sendError(res, err.status || 502, shortUpstreamMessage(err));
      throw err;
    }
    const helperId = helper && helper.id;
    try {
      // 2) run mkdir -p -- '<dir>' via the shell endpoint
      await upstream.json('/session/' + helperId + '/shell' + qp({ directory: ALLOWED_DIR_PREFIX }), {
        body: { agent: 'build', command: 'mkdir -p -- ' + shellQuote(dir) },
      });
    } finally {
      // 3) delete the helper session
      if (helperId) {
        await upstream.fetch('/session/' + helperId + qp({ directory: ALLOWED_DIR_PREFIX }), { method: 'DELETE' }).catch(() => {});
      }
    }
  }

  // Create the real session
  const session = await upstream.json('/session' + qp({ directory: dir }), {
    body: title ? { title } : {},
  });
  const sessionId = session && session.id;
  if (!sessionId) return sendError(res, 502, 'bad upstream response');

  // Send the prompt asynchronously
  await upstream.json('/session/' + sessionId + '/prompt_async' + qp({ directory: dir }), {
    body: { model: { providerID: model.providerID, modelID: model.modelID }, parts: [{ type: 'text', text: prompt }] },
  }).catch((err) => {
    // If the prompt fails, still return the session (agent will surface error).
    // We ignore the failure here but log a safe message.
    console.error('prompt_async failed:', shortUpstreamMessage(err));
  });

  return json(res, 200, { session });
}

function berlinStamp(d) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const p = Object.fromEntries(f.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

// Upstream lists an existing directory with 200 and answers 500 for a missing one.
async function directoryExists(dir) {
  try {
    await upstream.json(FS_LIST_ENDPOINT + qp({ path: '.', directory: dir }));
    return true;
  } catch {
    return false;
  }
}

async function apiSessionDelete(res, id, body) {
  const v = validateExistingDirectory(body.directory || DEFAULT_DIRECTORY);
  if (!v.ok) return sendError(res, 400, v.error);
  await upstream.fetch('/session/' + id + qp({ directory: v.dir }), { method: 'DELETE' });
  return noContent(res);
}

// ---------------------------------------------------------------------------
// API: prompt / abort
// ---------------------------------------------------------------------------
async function apiPrompt(res, id, body) {
  const dir = body.directory || DEFAULT_DIRECTORY;
  const text = body.text;
  const model = body.model;
  const v = validateExistingDirectory(dir);
  if (!v.ok) return sendError(res, 400, v.error);
  if (typeof text !== 'string' || !text) return sendError(res, 400, 'text required');
  if (!model || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') {
    return sendError(res, 400, 'model required');
  }
  await upstream.json('/session/' + id + '/prompt_async' + qp({ directory: v.dir }), {
    body: { model: { providerID: model.providerID, modelID: model.modelID }, parts: [{ type: 'text', text }] },
  });
  return noContent(res);
}

async function apiAbort(res, id, body) {
  const dir = body.directory || DEFAULT_DIRECTORY;
  const v = validateExistingDirectory(dir);
  if (!v.ok) return sendError(res, 400, v.error);
  await upstream.fetch('/session/' + id + '/abort' + qp({ directory: v.dir }), { method: 'POST' });
  return noContent(res);
}

// ---------------------------------------------------------------------------
// API: permissions
// ---------------------------------------------------------------------------
async function apiGetPermissions(res, dir) {
  const v = validateExistingDirectory(dir);
  if (!v.ok) return sendError(res, 400, v.error);
  const data = await upstream.json('/permission' + qp({ directory: v.dir }));
  return json(res, 200, { permissions: Array.isArray(data) ? data : [] });
}

async function apiPermissionReply(res, rid, dir, reply) {
  if (!['once', 'always', 'reject'].includes(reply)) return sendError(res, 400, 'invalid reply');
  const v = validateExistingDirectory(dir);
  if (!v.ok) return sendError(res, 400, v.error);
  await upstream.json('/permission/' + rid + '/reply' + qp({ directory: v.dir }), {
    body: { reply },
  });
  return noContent(res);
}

// ---------------------------------------------------------------------------
// API: directories
// ---------------------------------------------------------------------------
async function apiDirectoriesSuggest(res) {
  let dirs = [];
  try {
    const projects = await upstream.json('/project');
    if (Array.isArray(projects)) {
      for (const p of projects) {
        const w = p && p.worktree;
        if (w) dirs.push(w);
      }
    }
  } catch { /* ignore */ }
  // dedupe + prune
  dirs = [...new Set(dirs)].filter((d) => d && validateDirectory(d, ALLOWED_DIR_PREFIX).ok);
  return json(res, 200, { directories: dirs });
}

// Upstream `GET /file?path=.&directory=<dir>` lists <dir> as
// [{name, path, absolute, type:"file"|"directory"}] (verified on opencode 1.18.18).
// The frontend expects {directories: [absolute paths]}.
async function apiListDirectory(res, dir) {
  let entries = [];
  try {
    const data = await upstream.json(FS_LIST_ENDPOINT + qp({ path: '.', directory: dir }));
    if (Array.isArray(data)) entries = data;
  } catch {
    // fall back to datalist suggestions; return empty listing
    return json(res, 200, { path: dir, directories: [] });
  }
  const directories = entries
    .filter((e) => e && e.type === 'directory' && typeof e.name === 'string')
    .map((e) => path.posix.join(dir, e.name))
    .filter((p) => validateDirectory(p, ALLOWED_DIR_PREFIX).ok)
    .sort();
  return json(res, 200, { path: dir, directories });
}

// ---------------------------------------------------------------------------
// API: vault — encrypt / decrypt a whole chat
// ---------------------------------------------------------------------------
// Encrypt: export (session + sub-agent children + tool outputs) → encrypt → verify by
// decrypting in memory → store ciphertext → delete the session in opencode → purge
// remnants. Decrypt: verify blob hash → decrypt → `opencode import` → re-export and
// compare per-session digests. The password lives only in this request's memory.
const vaultBusy = new Set();

function publicEntry(id, e) {
  return {
    id,
    label: e.label || 'Encrypted chat',
    state: e.state || 'locked',
    sessionID: e.sessionID || null,
    createdAt: e.createdAt || null,
    updatedAt: e.updatedAt || null,
    messageCount: e.messageCount || 0,
    private: !!e.private,
  };
}

async function apiVaultList(res) {
  const idx = await vault.index();
  const entries = Object.entries(idx).map(([id, e]) => publicEntry(id, e))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  return json(res, 200, { entries });
}

async function exportTree(rootId, dir) {
  const out = [];
  const seen = new Set();
  async function walk(id) {
    if (seen.has(id) || seen.size > 200) return;
    seen.add(id);
    const [info, messages] = await Promise.all([
      upstream.json('/session/' + id + qp({ directory: dir })),
      upstream.json('/session/' + id + '/message' + qp({ directory: dir })),
    ]);
    if (!info || !Array.isArray(messages)) throw new VaultError('helper', 'export failed');
    out.push({ info, messages });
    const kids = await upstream.json('/session/' + id + '/children' + qp({ directory: dir }));
    for (const k of Array.isArray(kids) ? kids : []) if (k && isValidSessionId(k.id)) await walk(k.id);
  }
  await walk(rootId);
  return out;
}

function sameDigests(a, b) {
  if (a.length !== b.length) return false;
  const m = new Map(a.map((d) => [d.id, d]));
  return b.every((d) => { const x = m.get(d.id); return x && x.messageCount === d.messageCount && x.partCount === d.partCount && x.sha256 === d.sha256; });
}

async function apiVaultEncrypt(res, body) {
  const id = body.sessionID;
  const password = body.password;
  if (!isValidSessionId(id)) return sendError(res, 400, 'invalid session id');
  const pwErr = validatePassword(password);
  if (pwErr) return sendError(res, 400, pwErr);
  const v = validateExistingDirectory(body.directory || DEFAULT_DIRECTORY);
  if (!v.ok) return sendError(res, 400, v.error);
  const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
  if (vaultBusy.has(id)) return sendError(res, 409, 'already in progress');
  vaultBusy.add(id);
  try {
    const statuses = await upstream.json('/session/status' + qp({ directory: v.dir })).catch(() => null);
    const st = statuses && statuses[id];
    if (st && st.type && st.type !== 'idle') return sendError(res, 409, 'The agent is still working in this chat. Stop it first.');

    const sessions = await exportTree(id, v.dir);
    const root = sessions[0].info;
    if (root.parentID) return sendError(res, 400, 'open the main chat to encrypt it');
    const toolOutputs = toolOutputNames(sessions);
    const files = await vault.readToolOutputs(toolOutputs);
    const digests = sessions.map(digestSession);
    const now = Date.now();
    const bundle = { format: 'opencode-remote-vault', v: 1, createdAt: now, root: id, directory: root.directory || v.dir, sessions, files, digests };
    const blob = await encryptBundle(bundle, password);
    // Prove the blob opens with this password before anything is deleted.
    const check = await decryptBundle(blob, password);
    if (!sameDigests(check.sessions.map(digestSession), digests)) throw new VaultError('verify', 'Encryption self-check failed; nothing was deleted.');

    const idx = await vault.index();
    let lockId = Object.keys(idx).find((k) => idx[k].sessionID === id);
    const prev = lockId ? idx[lockId] : null;
    if (!lockId) lockId = newLockId();
    const isPrivate = typeof root.title === 'string' && root.title.startsWith(PRIVATE_TITLE_PREFIX);
    const entryLabel = label || (prev && prev.label) || (isPrivate ? root.title : 'Encrypted chat · ' + berlinStamp(new Date(root.time && root.time.created || now)));
    const messageCount = digests.reduce((n, d) => n + d.messageCount, 0);
    // Store first (state stays "unlocked" until the plaintext is really gone).
    await vault.put(lockId, { label: entryLabel, state: 'unlocked', sessionID: id, createdAt: (prev && prev.createdAt) || now, updatedAt: now, messageCount, private: isPrivate }, blob);

    await upstream.fetch('/session/' + id + qp({ directory: v.dir }), { method: 'DELETE' });
    try {
      await upstream.json('/session/' + id + qp({ directory: v.dir }));
      throw new VaultError('state', 'opencode did not delete the chat; it stays readable.');
    } catch (err) {
      if (!(err && err.name === 'UpstreamError' && err.status === 404)) throw err;
    }
    const purge = await vault.purge(sessions.map((s) => s.info.id), toolOutputs);
    const entry = await vault.put(lockId, { state: 'locked', updatedAt: Date.now() });
    return json(res, 200, { entry: publicEntry(lockId, entry), purged: { toolOutputs: purge.toolOutputsRemoved, walBytes: purge.walBytes } });
  } finally {
    vaultBusy.delete(id);
  }
}

async function apiVaultDecrypt(res, lockId, body) {
  if (typeof body.password !== 'string' || !body.password) return sendError(res, 400, 'password required');
  if (vaultBusy.has(lockId)) return sendError(res, 409, 'already in progress');
  vaultBusy.add(lockId);
  try {
    const idx = await vault.index();
    const e = idx[lockId];
    if (!e) return sendError(res, 404, 'not found');
    if (e.state !== 'locked') return sendError(res, 409, 'this chat is already decrypted');
    const blob = await vault.getBlob(lockId);
    if (!e.blobSha256 || sha256(blob) !== e.blobSha256) throw new VaultError('corrupt', 'The encrypted file is damaged (checksum mismatch).');
    const bundle = await decryptBundle(blob, body.password);
    if (!bundle || bundle.format !== 'opencode-remote-vault' || !Array.isArray(bundle.sessions) || !bundle.sessions.length) {
      throw new VaultError('corrupt', 'Decrypted data is not a chat.');
    }
    const want = Array.isArray(bundle.digests) ? bundle.digests : bundle.sessions.map(digestSession);
    if (!sameDigests(bundle.sessions.map(digestSession), want)) throw new VaultError('corrupt', 'Decrypted chat fails its integrity check.');

    const imp = await vault.importSessions(bundle.directory, bundle.sessions, bundle.files || {});
    const dir = imp.directory;
    const back = [];
    for (const s of bundle.sessions) {
      const [info, messages] = await Promise.all([
        upstream.json('/session/' + s.info.id + qp({ directory: dir })),
        upstream.json('/session/' + s.info.id + '/message' + qp({ directory: dir })),
      ]);
      back.push({ info, messages });
    }
    const got = back.map(digestSession);
    const counts = got.every((d, i) => d.messageCount === want[i].messageCount && d.partCount === want[i].partCount);
    const exact = sameDigests(got, want);
    if (!counts) throw new VaultError('verify', 'Imported chat is incomplete; the encrypted copy is kept unchanged.');
    const entry = await vault.put(lockId, { state: 'unlocked', sessionID: bundle.root, updatedAt: Date.now() });
    return json(res, 200, { entry: publicEntry(lockId, entry), sessionID: bundle.root, directory: dir, verified: { messages: got.reduce((n, d) => n + d.messageCount, 0), exact } });
  } finally {
    vaultBusy.delete(lockId);
  }
}

async function apiVaultDelete(res, lockId) {
  await vault.remove(lockId);
  return noContent(res);
}

// ---------------------------------------------------------------------------
// API: events (SSE)
// ---------------------------------------------------------------------------
function apiEvents(req, res, url) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...SECURITY_HEADERS,
  });
  res.write('retry: 3000\n\n');

  const sessionID = url.searchParams.get('sessionID');
  const client = {
    sessionID: sessionID ? decodeURIComponent(sessionID) : null,
    write(obj) {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    },
  };
  const unsub = hub.subscribe(client);

  const ping = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 20000);

  const cleanup = () => {
    clearInterval(ping);
    unsub();
  };
  res.on('close', cleanup);
  res.on('error', cleanup);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
export function createApp() {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendError(res, 500, 'internal error');
      else res.end();
    });
  });
  return { server, upstream, hub };
}

export function start(port = PORT) {
  const { server } = createApp();
  server.listen(port, () => {
    console.log(`opencode-remote listening on :${port}`);
  });
  return server;
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  start(PORT);
}

export { upstream, handle };