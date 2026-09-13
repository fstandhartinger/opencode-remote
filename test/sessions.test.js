// test/sessions.test.js — fake upstream to test POST /api/sessions and that
// unknown /api paths 404 (no generic proxying).

process.env.APP_PASSWORD = 'devapp';
process.env.SESSION_SECRET = 'test-secret';
process.env.PORT = '0';
process.env.ALLOWED_DIR_PREFIX = '/home/flori/';
// The fake upstream below only accepts basic auth opencode:devpw.
process.env.OPENCODE_USERNAME = 'opencode';
process.env.OPENCODE_PASSWORD = 'devpw';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// --- fake upstream server ---
let upstreamServer;
let upstreamPort;
let createApp;
let appServer;
let base;

const calls = [];

function makeUpstream() {
  return http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body: parsed });

      if (req.headers.authorization !== 'Basic b3BlbmNvZGU6ZGV2cHc=') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }

      if (path === '/session' && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: 'ses_new', directory: parsed.title ? '/home/flori/' : (url.searchParams.get('directory') || ''), title: parsed.title || '' }));
        return;
      }
      if (path.startsWith('/session/') && path.endsWith('/shell') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (path.startsWith('/session/') && path.endsWith('/prompt_async') && req.method === 'POST') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (path.startsWith('/session/') && req.method === 'DELETE') {
        res.writeHead(204);
        res.end();
        return;
      }
      if (path.startsWith('/session/') && path.endsWith('/abort') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('true');
        return;
      }
      if (path.startsWith('/question/') && path.endsWith('/reject') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('true');
        return;
      }
      if (path.startsWith('/session/') && path.endsWith('/message') && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('[]');
        return;
      }
      if (/^\/session\/ses_[A-Za-z0-9]+$/.test(path) && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ id: path.split('/')[2], directory: url.searchParams.get('directory') }));
        return;
      }
      if (path === '/file' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([
          { name: 'app', path: 'app/', absolute: '/home/flori/Dev/app', type: 'directory' },
          { name: 'README.md', path: 'README.md', absolute: '/home/flori/Dev/README.md', type: 'file' },
        ]));
        return;
      }
      if (path === '/config/providers' && req.method === 'GET') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
  });
}

before(async () => {
  process.env.OPENCODE_URL = 'http://127.0.0.1:0'; // placeholder, replaced below
  upstreamServer = makeUpstream();
  await new Promise((r) => upstreamServer.listen(0, '127.0.0.1', r));
  upstreamPort = upstreamServer.address().port;
  process.env.OPENCODE_URL = `http://127.0.0.1:${upstreamPort}`;

  const mod = await import('../server.js');
  createApp = mod.createApp;
  const app = createApp();
  appServer = app.server;
  await new Promise((r) => appServer.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${appServer.address().port}`;
});

after(() => {
  if (upstreamServer) upstreamServer.close();
  if (appServer) appServer.close();
});

async function authed() {
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  const r = await fetch(base + '/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ password: 'devapp' }),
  });
  const sc = r.headers.get('set-cookie');
  const token = sc.match(/ocr_session=([^;]+)/)[1];
  return `ocr_session=${token}`;
}

test('unknown /api path -> 404, no generic proxying', async () => {
  const cookie = await authed();
  const r = await fetch(base + '/api/does-not-exist', {
    headers: { cookie, Origin: `http://127.0.0.1:${appServer.address().port}` },
  });
  assert.equal(r.status, 404);
  // ensure no request was forwarded to upstream for that path
  assert.ok(!calls.some((c) => c.path === '/does-not-exist'));
});

test('POST /api/sessions without createDirectory -> creates session and prompts', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  const r = await fetch(base + '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({
      directory: '/home/flori/Dev/myapp',
      model: { providerID: 'chutes', modelID: 'moonshotai/Kimi-K3-TEE' },
      prompt: 'hello',
    }),
  });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.session.id, 'ses_new');

  const create = calls.filter((c) => c.method === 'POST' && c.path === '/session');
  assert.equal(create.length, 1, 'should create exactly one session');
  // no createDirectory => no mkdir helper session and no shell call
  assert.ok(!calls.some((c) => c.path.includes('/shell')), 'no shell call when createDirectory false');

  const promptCalls = calls.filter((c) => c.path.endsWith('/prompt_async'));
  assert.equal(promptCalls.length, 1);
  const pc = promptCalls[0];
  assert.equal(pc.query.directory, '/home/flori/Dev/myapp');
  assert.deepEqual(pc.body.model, { providerID: 'chutes', modelID: 'moonshotai/Kimi-K3-TEE' });
  assert.equal(pc.body.parts[0].text, 'hello');
});

test('POST /api/sessions with createDirectory -> helper session, mkdir shell, delete helper, then create + prompt', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const r = await fetch(base + '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({
      directory: '/home/flori/Dev/newdir',
      model: { providerID: 'chutes', modelID: 'moonshotai/Kimi-K3-TEE' },
      prompt: 'make it',
      createDirectory: true,
    }),
  });
  assert.equal(r.status, 200);

  // Two POST /session calls: one helper + one real
  const creates = calls.filter((c) => c.method === 'POST' && c.path === '/session');
  assert.equal(creates.length, 2, 'expect helper + real session');

  const shellCalls = calls.filter((c) => c.path.includes('/shell'));
  assert.equal(shellCalls.length, 1);
  const shell = shellCalls[0];
  assert.equal(shell.body.agent, 'build');
  assert.ok(shell.body.command.includes('mkdir -p'));
  assert.ok(shell.body.command.includes('/home/flori/Dev/newdir'));

  // helper session deleted
  const deletes = calls.filter((c) => c.method === 'DELETE' && c.path.includes('/session/'));
  assert.equal(deletes.length, 1);
});

test('GET /api/sessions/:id works for historic sessions outside the prefix and forwards before/limit', async () => {
  const cookie = await authed();
  calls.length = 0;
  const r = await fetch(base + '/api/sessions/ses_abc123?directory=' + encodeURIComponent('/tmp/ocrc') + '&before=msg_old1&limit=50', {
    headers: { cookie },
  });
  assert.equal(r.status, 200);
  const msg = calls.find((c) => c.path === '/session/ses_abc123/message');
  assert.equal(msg.query.directory, '/tmp/ocrc');
  assert.equal(msg.query.before, 'msg_old1');
  assert.equal(msg.query.limit, '50');
});

test('GET /api/sessions/:id rejects traversal and bad before ids', async () => {
  const cookie = await authed();
  const bad = await fetch(base + '/api/sessions/ses_abc123?directory=' + encodeURIComponent('/tmp/../etc'), { headers: { cookie } });
  assert.equal(bad.status, 400);
  const badBefore = await fetch(base + '/api/sessions/ses_abc123?directory=%2Ftmp&before=' + encodeURIComponent('x&y'), { headers: { cookie } });
  assert.equal(badBefore.status, 400);
});

test('POST /api/sessions/:id/prompt and /abort use explicit sub-routes', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const p = await fetch(base + '/api/sessions/ses_abc123/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/tmp/ocrc', text: 'more', model: { providerID: 'chutes', modelID: 'm' } }),
  });
  assert.equal(p.status, 204);
  const pc = calls.find((c) => c.path === '/session/ses_abc123/prompt_async');
  assert.equal(pc.query.directory, '/tmp/ocrc');
  assert.equal(pc.body.parts[0].text, 'more');

  const a = await fetch(base + '/api/sessions/ses_abc123/abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/tmp/ocrc' }),
  });
  assert.equal(a.status, 204);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/session/ses_abc123/abort'));
});

test('POST /api/questions/:id/reject forwards to upstream', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const r = await fetch(base + '/api/questions/que_abc/reject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/home/flori/Dev' }),
  });
  assert.equal(r.status, 204);
  assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/question/que_abc/reject'));
});

test('cross-origin mutation is rejected', async () => {
  const cookie = await authed();
  const r = await fetch(base + '/api/sessions/ses_abc123/abort', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: 'https://evil.example' },
    body: JSON.stringify({ directory: '/tmp/ocrc' }),
  });
  assert.equal(r.status, 403);
});

test('GET /api/directories returns absolute subdirectory paths only', async () => {
  const cookie = await authed();
  const r = await fetch(base + '/api/directories?path=' + encodeURIComponent('/home/flori/Dev'), { headers: { cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.directories, ['/home/flori/Dev/app']);
});

test('upstream 401 (wrong opencode credentials) surfaces as 502, not 401', async () => {
  const cookie = await authed();
  const r = await fetch(base + '/api/models', { headers: { cookie } });
  assert.equal(r.status, 502);
});

test('POST /api/sessions rejects directory outside prefix', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  const r = await fetch(base + '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({
      directory: '/etc',
      model: { providerID: 'chutes', modelID: 'moonshotai/Kimi-K3-TEE' },
      prompt: 'hi',
    }),
  });
  assert.equal(r.status, 400);
  assert.ok(!calls.some((c) => c.method === 'POST' && c.path === '/session'));
});