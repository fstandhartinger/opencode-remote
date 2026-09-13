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
    res.writeHead(200, { 'Content-Type': type, ...SECURITY_HEADERS });
    fs.createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function isStaticPublicUrl(p) {
  return p === '/login.html' || p === '/styles.css' || p === '/login.css' || p === '/login.js' || p === '/app.js' || p === '/markdown.js' || p === '/favicon.svg' || p === '/favicon.ico';
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
    const questionMatch = pathname.match(/^\/api\/questions\/([^/]+)\/reject$/);
    if (questionMatch && method === 'POST') {
      const qid = decodeURIComponent(questionMatch[1]);
      if (!isValidPermissionId(qid)) return sendError(res, 400, 'invalid question id');
      const body = await parseJsonBody(req);
      const v = validateExistingDirectory(body.directory || DEFAULT_DIRECTORY);
      if (!v.ok) return sendError(res, 400, v.error);
      await upstream.fetch('/question/' + qid + '/reject' + qp({ directory: v.dir }), { method: 'POST' });
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

  const params = { roots: 'true', limit: String(limit) };
  if (search) params.search = search;
  if (cursor) params.cursor = cursor;

  const sessions = await upstream.json('/experimental/session' + qp(params));
  if (!Array.isArray(sessions)) return sendError(res, 502, 'bad upstream data');

  // Merge busy status where cheap (distinct directories, max 10 parallel).
  const sessionsJson = await mergeStatus(sessions);
  // A short page means there is nothing older to fetch.
  const nextCursor = sessions.length >= limit ? (sessions[sessions.length - 1].time?.updated ?? null) : null;
  return json(res, 200, { sessions: sessionsJson, cursor: nextCursor });
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

  const [session, messages] = await Promise.all([
    upstream.json('/session/' + id + qp({ directory: v.dir })),
    upstream.json('/session/' + id + '/message' + qp({ directory: v.dir, limit, before })),
  ]);
  return json(res, 200, { session, messages });
}

// ---------------------------------------------------------------------------
// API: create session (optionally creating the directory first)
// ---------------------------------------------------------------------------
async function apiCreateSession(res, body) {
  const rawDir = body.directory;
  const createDirectory = body.createDirectory === true;
  const title = typeof body.title === 'string' && body.title ? body.title : undefined;
  const prompt = typeof body.prompt === 'string' ? body.prompt : undefined;
  const model = body.model;

  if (!prompt) return sendError(res, 400, 'prompt required');
  if (!model || typeof model.providerID !== 'string' || typeof model.modelID !== 'string') {
    return sendError(res, 400, 'model required');
  }

  const v = validateDirectory(rawDir, ALLOWED_DIR_PREFIX);
  if (!v.ok) return sendError(res, 400, v.error);

  const dir = v.dir;

  if (createDirectory) {
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