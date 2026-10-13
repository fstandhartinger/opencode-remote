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
// Directories the fake upstream reports as existing (others answer /file with 500).
const MISSING_DIRS = new Set(['/home/flori/Dev/newdir', '/home/flori/Dev/missing-default']);
const FAKE_SESSIONS = [];
for (let i = 0; i < 30; i++) {
  FAKE_SESSIONS.push({ id: 'ses_p' + i, directory: '/tmp/llm-health-opencode-probe', title: 'probe', time: { updated: 10000 - i * 10 } });
}
FAKE_SESSIONS.splice(5, 0, { id: 'ses_real1', directory: '/home/flori/Dev/a', title: 'real one', time: { updated: 9955 }, permission: [{ x: 1 }] });
FAKE_SESSIONS.push({ id: 'ses_real2', directory: '/home/flori/Dev/b', title: 'real two', time: { updated: 1 } });

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
      if (path === '/file' && req.method === 'GET' && MISSING_DIRS.has(url.searchParams.get('directory'))) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      if (path === '/experimental/session' && req.method === 'GET') {
        const lim = Number(url.searchParams.get('limit'));
        const cur = url.searchParams.get('cursor');
        const rows = FAKE_SESSIONS.filter((x) => !cur || x.time.updated < Number(cur)).slice(0, lim);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(rows));
        return;
      }
      if (path === '/session/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(url.searchParams.get('directory') === '/home/flori/Dev/a' ? { ses_real1: { type: 'busy' } } : {}));
        return;
      }
      if (path.startsWith('/question/') && path.endsWith('/reply') && req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('true');
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
test('POST /api/sessions with an empty directory runs in the default directory', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const r = await fetch(base + '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '  ', model: { providerID: 'chutes', modelID: 'm' }, prompt: 'hi' }),
  });
  assert.equal(r.status, 200);
  const create = calls.find((c) => c.method === 'POST' && c.path === '/session');
  assert.equal(create.query.directory, '/home/flori/Dev/temp');
  // the default directory exists upstream, so no mkdir helper
  assert.ok(!calls.some((c) => c.path.includes('/shell')));
  const pc = calls.find((c) => c.path.endsWith('/prompt_async'));
  assert.equal(pc.query.directory, '/home/flori/Dev/temp');
});

test('POST /api/sessions with createDirectory skips mkdir when the directory exists', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const r = await fetch(base + '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/home/flori/Dev/exists', model: { providerID: 'chutes', modelID: 'm' }, prompt: 'hi', createDirectory: true }),
  });
  assert.equal(r.status, 200);
  assert.ok(!calls.some((c) => c.path.includes('/shell')));
  assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/session').length, 1);
});

test('GET /api/config exposes the new-session default directory', async () => {
  const cookie = await authed();
  const r = await fetch(base + '/api/config', { headers: { cookie } });
  const d = await r.json();
  assert.equal(d.newSessionDirectory, '/home/flori/Dev/temp');
});

test('GET /api/sessions?hideProbes=1 skips /tmp probe sessions across upstream pages', async () => {
  const cookie = await authed();
  const r = await fetch(base + '/api/sessions?limit=2&hideProbes=1', { headers: { cookie } });
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.deepEqual(d.sessions.map((x) => x.id), ['ses_real1', 'ses_real2']);
  assert.equal(d.sessions[0].busy, true);
  // list rows are slimmed down
  assert.equal(d.sessions[0].permission, undefined);

  const all = await (await fetch(base + '/api/sessions?limit=3', { headers: { cookie } })).json();
  assert.deepEqual(all.sessions.map((x) => x.id), ['ses_p0', 'ses_p1', 'ses_p2']);
  assert.equal(all.cursor, FAKE_SESSIONS[2].time.updated);

  const bad = await fetch(base + '/api/sessions?cursor=abc', { headers: { cookie } });
  assert.equal(bad.status, 400);
});

test('DELETE /api/sessions/:id deletes upstream', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const r = await fetch(base + '/api/sessions/ses_abc123', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/home/flori/Dev/temp' }),
  });
  assert.equal(r.status, 204);
  const del = calls.find((c) => c.method === 'DELETE' && c.path === '/session/ses_abc123');
  assert.equal(del.query.directory, '/home/flori/Dev/temp');
});

test('POST /api/questions/:id/reply forwards validated answers', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const ok = await fetch(base + '/api/questions/que_abc/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/home/flori/Dev', answers: [['Yes']] }),
  });
  assert.equal(ok.status, 204);
  const c = calls.find((x) => x.path === '/question/que_abc/reply');
  assert.deepEqual(c.body, { answers: [['Yes']] });
  const bad = await fetch(base + '/api/questions/que_abc/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/home/flori/Dev', answers: [[{ x: 1 }]] }),
  });
  assert.equal(bad.status, 400);
});

test('POST /api/sessions with private:true presets a neutral title so opencode never generates one', async () => {
  const cookie = await authed();
  const origin = `http://127.0.0.1:${appServer.address().port}`;
  calls.length = 0;
  const r = await fetch(base + '/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie, Origin: origin },
    body: JSON.stringify({ directory: '/home/flori/Dev/myapp', model: { providerID: 'chutes', modelID: 'x' }, prompt: 'secret', private: true, title: 'ignored' }),
  });
  assert.equal(r.status, 200);
  const create = calls.find((c) => c.method === 'POST' && c.path === '/session');
  assert.match(create.body.title, /^Private chat · \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  // opencode's isDefaultTitle() only matches "New session - <ISO>"; ours must never match it.
  assert.ok(!/^(New session - |Child session - )\d{4}-\d{2}-\d{2}T/.test(create.body.title));
});

test('vault routes 404 when no vault helper is configured', async () => {
  const cookie = await authed();
  const r = await fetch(base + '/api/vault', { headers: { cookie } });
  assert.equal(r.status, 404);
  const c = await fetch(base + '/api/config', { headers: { cookie } });
  assert.equal((await c.json()).vault, false);
});
