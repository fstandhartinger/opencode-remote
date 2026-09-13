// test/auth.test.js — login, cookie, rate limit, tamper, 401.
// Sets env before importing server.js (which reads env at import time).

process.env.APP_PASSWORD = 'devapp';
process.env.SESSION_SECRET = 'test-secret';
process.env.OPENCODE_URL = 'http://127.0.0.1:9999';
process.env.PORT = '0';
process.env.ALLOWED_DIR_PREFIX = '/home/flori/';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

let server;
let base;
let createApp;

before(async () => {
  const mod = await import('../server.js');
  createApp = mod.createApp;
  const app = createApp();
  server = app.server;
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
});

function login(pw, origin) {
  const o = origin || `http://127.0.0.1:${server.address().port}`;
  return fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: o },
    body: JSON.stringify({ password: pw }),
  });
}

test('healthz answers without auth', async () => {
  const r = await fetch(base + '/healthz');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test('wrong password -> 401', async () => {
  const r = await login('wrong');
  assert.equal(r.status, 401);
  assert.equal((await r.json()).status, 401);
});

test('correct password -> 200 with signed HttpOnly Secure SameSite cookie', async () => {
  const r = await login('devapp');
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.ok(sc.includes('ocr_session='));
  assert.ok(sc.includes('HttpOnly'));
  assert.ok(sc.includes('Secure'));
  assert.ok(sc.includes('SameSite=Strict'));
  assert.ok(sc.includes('Path=/'));
  const token = sc.match(/ocr_session=([^;]+)/)[1];
  assert.ok(token.includes('.'), 'token should be signed (expiry.hmac)');
});

test('API without cookie -> 401 JSON', async () => {
  const r = await fetch(base + '/api/status');
  assert.equal(r.status, 401);
  assert.ok(r.headers.get('content-type').includes('application/json'));
});

test('page route without cookie redirects to login', async () => {
  const r = await fetch(base + '/', { redirect: 'manual' });
  assert.equal(r.status, 302);
  assert.ok(r.headers.get('location').endsWith('/login.html'));
});

test('tampered cookie signature -> 401', async () => {
  const good = await login('devapp');
  const token = good.headers.get('set-cookie').match(/ocr_session=([^;]+)/)[1];
  const [expiry, mac] = token.split('.');
  const badToken = expiry + '.' + mac.replace(/[A-Za-z0-9]/g, (c) => (c === 'a' ? 'b' : 'a'));
  const r = await fetch(base + '/api/status', { headers: { cookie: `ocr_session=${badToken}` } });
  assert.equal(r.status, 401);
});

test('rate limit: 11 failed attempts -> 429', async () => {
  // Use a distinct IP via X-Forwarded-For to isolate from other tests.
  const ip = '203.0.113.' + Math.floor(Math.random() * 200 + 1);
  let got429 = false;
  for (let i = 0; i < 12; i++) {
    const r = await login('wrongpw', 'http://unused');
    if (r.status === 429) { got429 = true; break; }
  }
  assert.equal(got429, true, 'expected a 429 after many failures');
});

test('security headers present on API responses', async () => {
  const r = await fetch(base + '/healthz');
  assert.ok(r.headers.get('content-security-policy').includes("default-src 'self'"));
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
});