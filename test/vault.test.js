// test/vault.test.js — blob format, wrong password, tampering, round-trip digests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptBundle, decryptBundle, parseHeader, digestSession, canonical, toolOutputNames, newLockId, validatePassword, MAGIC } from '../lib/vault.js';

// Small scrypt parameters keep the suite fast; production uses DEFAULT_KDF (2^17).
const FAST = { logN: 14, r: 8, p: 1 };
const bundle = {
  format: 'opencode-remote-vault', v: 1,
  sessions: [{ info: { id: 'ses_abc12345', title: 'secret title' }, messages: [
    { info: { id: 'msg_1', role: 'user' }, parts: [{ id: 'prt_1', type: 'text', text: 'canary-XYZ äöü 🔒' }] },
    { info: { id: 'msg_2', role: 'assistant' }, parts: [{ id: 'prt_2', type: 'tool', state: { metadata: { outputPath: '/home/flori/.local/share/opencode/tool-output/tool_11567c6f5001I9H21jBZRrRMur' } } }] },
  ] }],
};

test('round trip restores the identical bundle', async () => {
  const blob = await encryptBundle(bundle, 'correct horse', FAST);
  assert.ok(blob.subarray(0, 8).equals(MAGIC));
  assert.ok(!blob.includes(Buffer.from('canary-XYZ')), 'no plaintext in the blob');
  assert.ok(!blob.includes(Buffer.from('secret title')));
  const back = await decryptBundle(blob, 'correct horse');
  assert.deepEqual(back, bundle);
  assert.deepEqual(digestSession(back.sessions[0]), digestSession(bundle.sessions[0]));
});

test('two encryptions of the same data differ (fresh salt + nonce)', async () => {
  const a = await encryptBundle(bundle, 'correct horse', FAST);
  const b = await encryptBundle(bundle, 'correct horse', FAST);
  assert.ok(!a.equals(b));
  assert.ok(!parseHeader(a).salt.equals(parseHeader(b).salt));
  assert.ok(!parseHeader(a).nonce.equals(parseHeader(b).nonce));
});

test('wrong password fails cleanly', async () => {
  const blob = await encryptBundle(bundle, 'correct horse', FAST);
  await assert.rejects(decryptBundle(blob, 'correct horsf'), (e) => e.name === 'VaultError' && e.code === 'password');
  await assert.rejects(decryptBundle(blob, ''), (e) => e.code === 'password');
});

test('any flipped byte is detected (header, ciphertext, tag)', async () => {
  const blob = await encryptBundle(bundle, 'correct horse', FAST);
  for (const i of [20, 35, 45, blob.length - 20, blob.length - 1]) {
    const bad = Buffer.from(blob);
    bad[i] ^= 0x01;
    await assert.rejects(decryptBundle(bad, 'correct horse'), (e) => e.name === 'VaultError', 'byte ' + i);
  }
});

test('truncated, foreign and hostile headers are rejected before key derivation', async () => {
  const blob = await encryptBundle(bundle, 'correct horse', FAST);
  await assert.rejects(decryptBundle(blob.subarray(0, 40), 'correct horse'), (e) => e.code === 'corrupt');
  await assert.rejects(decryptBundle(Buffer.concat([Buffer.from('NOTVAULT'), blob.subarray(8)]), 'correct horse'), (e) => e.code === 'corrupt');
  const v2 = Buffer.from(blob); v2[8] = 2;
  await assert.rejects(decryptBundle(v2, 'correct horse'), (e) => e.code === 'format');
  const huge = Buffer.from(blob); huge[10] = 30; // 2^30 scrypt would need 128 GiB
  await assert.rejects(decryptBundle(huge, 'correct horse'), (e) => e.code === 'corrupt');
});

test('password policy', () => {
  assert.ok(validatePassword('short'));
  assert.equal(validatePassword('long enough'), null);
  return assert.rejects(encryptBundle(bundle, 'short', FAST), (e) => e.code === 'password');
});

test('digest ignores key order but not content', () => {
  const a = { info: { id: 's', b: 1, a: 2 }, messages: [{ info: { x: 1, y: 2 }, parts: [] }] };
  const b = { info: { a: 2, id: 's', b: 1 }, messages: [{ info: { y: 2, x: 1 }, parts: [] }] };
  assert.equal(canonical({ b: 1, a: [1, { d: 1, c: 2 }] }), '{"a":[1,{"c":2,"d":1}],"b":1}');
  assert.deepEqual(digestSession(a), digestSession(b));
  b.messages[0].info.y = 3;
  assert.notEqual(digestSession(a).sha256, digestSession(b).sha256);
});

test('tool-output names and lock ids', () => {
  assert.deepEqual(toolOutputNames(bundle.sessions), ['tool_11567c6f5001I9H21jBZRrRMur']);
  const id = newLockId();
  assert.match(id, /^lk_[a-z0-9]{20}$/);
  assert.notEqual(id, newLockId());
});

test('default KDF parameters derive within the memory limit', async () => {
  const blob = await encryptBundle({ x: 1 }, 'correct horse');
  assert.equal(parseHeader(blob).kdf.logN, 17);
  assert.deepEqual(await decryptBundle(blob, 'correct horse'), { x: 1 });
});
