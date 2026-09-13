# opencode-remote — implementation spec

You are implementing a small web app in this repository (`/home/flori/Dev/opencode-remote`).
We own this server, the repo and the opencode instance. Work only inside this repo
directory. Do not touch `~/.config/opencode`, systemd, docker, or other projects.

## What it is

A password-protected, mobile-friendly browser remote control for the `opencode serve`
instance running on this host. Florian uses it from his phone and laptop to:

1. See all existing and historic opencode sessions (across all projects/directories).
2. Open a session and read its full transcript, live-updating while the agent works.
3. Start a new coding session: choose a working directory, the LLM, a title, and a first prompt.
4. Send follow-up prompts to a session (optionally switching model), abort a running session,
   and answer permission requests.

It is deployed as a Docker container (Coolify) on the `coolify` docker network. The container
reaches opencode at `OPENCODE_URL` (production: `http://172.30.1.1:4096`) with HTTP basic
auth (`OPENCODE_USERNAME` / `OPENCODE_PASSWORD`).

## Stack (keep it small)

- Node 22, plain JavaScript (ESM), **no build step**. Backend: `server.js` using `node:http`
  (a tiny router is fine; `express` is also acceptable). Frontend: static files in `public/`
  (`index.html`, `app.js`, `styles.css`) — vanilla JS, no framework, no CDN.
  Markdown rendering: vendor a small renderer or write a minimal safe one (escape HTML first,
  then support code fences, inline code, bold, italics, links, lists, headings). Never inject
  unescaped model output into the DOM.
- `Dockerfile` (node:22-alpine, non-root user, `EXPOSE 8080`, `CMD ["node","server.js"]`).
- `npm test` runs `node --test` tests.
- `README.md` with env vars, local dev, and deploy notes.

## Environment variables

| var | meaning |
|---|---|
| `PORT` | default 8080 |
| `APP_PASSWORD` | shared secret for the login gate (required; refuse to start without it) |
| `SESSION_SECRET` | HMAC key for the session cookie (required) |
| `OPENCODE_URL` | e.g. `http://172.30.1.1:4096` |
| `OPENCODE_USERNAME` | default `opencode` |
| `OPENCODE_PASSWORD` | basic-auth password for opencode serve |
| `DEFAULT_DIRECTORY` | default `/home/flori/Dev` |
| `ALLOWED_DIR_PREFIX` | default `/home/flori/` — new sessions may only use dirs under this |

## Security requirements (non-negotiable — this app controls an agent with shell access)

1. **Login**: `POST /login` with the password; constant-time compare (`crypto.timingSafeEqual`
   on SHA-256 digests). On success set cookie `ocr_session` = signed token
   (`expiry.hmac`), `HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=30 days`.
   `POST /logout` clears it. In-memory rate limit: max 10 failed attempts per IP per 15 min
   (use `X-Forwarded-For` first hop, fallback socket address) → 429.
2. Every route except `GET /healthz`, `GET /login` (page), `POST /login`, and the static
   login assets requires a valid cookie; API returns 401 JSON, page routes redirect to login.
3. **Login field markup** — the app is on a shared `*.app.mintapis.com` domain, so do NOT use
   `type="password"` (Chrome would offer other apps' saved logins). Use exactly:
   ```html
   <input id="pw" type="text" class="masked" placeholder="Password" aria-label="Password"
          name="opencode-remote-access-code" autocomplete="off" autocapitalize="off"
          autocorrect="off" spellcheck="false" data-form-type="other"
          data-1p-ignore data-lpignore="true" data-bwignore>
   ```
   CSS `#pw.masked{-webkit-text-security:disc;text-security:disc;letter-spacing:.12em}`,
   a reveal toggle that swaps the `masked` class, and the JS fallback: if
   `CSS.supports('-webkit-text-security','disc')` and `CSS.supports('text-security','disc')`
   are both false, set `pw.type='password'` and remove `masked`.
4. **Never a generic proxy.** The backend exposes only the explicit `/api/*` routes below and
   builds the upstream URL itself. Validate IDs with `^ses_[A-Za-z0-9]+$`,
   `^per_[A-Za-z0-9]+$` / permission IDs by a strict `^[A-Za-z0-9_]+$`.
5. **Never leak provider secrets.** Upstream `GET /config/providers` returns raw API keys
   (`key`, `options.apiKey`, headers). The models endpoint must build a new object containing
   only `{providerID, providerName, modelID, modelName}`. Likewise, the event stream must
   forward only the whitelisted event types below, and must never forward `config`/provider
   payloads. Write a unit test that feeds a providers payload containing keys and asserts no
   `key`/`apiKey`/`headers` value appears in the output.
6. Mutating API routes require `Content-Type: application/json` and a same-origin check
   (`Origin` header, when present, must match `Host`), as CSRF defence in addition to SameSite.
7. Security headers on all responses: `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`,
   `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
8. Never log passwords, cookies, or the opencode password. Upstream errors are returned as
   `{error: "<short message>", status}` without echoing upstream bodies that might contain config.

## Upstream opencode API (verified against opencode 1.18.18 on this host)

Samples of real payloads are in `/home/flori/Dev/opencode-remote-samples/`:
`openapi.json` (full spec, 480 KB — grep it, do not read it whole), `key-endpoints.json`,
`messages.json` (a session with user text, assistant reasoning, a bash tool call, text, step
parts), `expsessions.json`, `projects.json`, `global-events-sample.txt` (SSE stream).

All upstream calls use basic auth. Relevant endpoints:

- `GET /experimental/session?limit=N&cursor=...&search=...&roots=true` → array of sessions across
  **all** projects (fields: id, slug, projectID, directory, title, model{id,providerID},
  cost, tokens, summary, time{created,updated}, parentID for subagent children). Check the
  spec for how the cursor is returned (response header or field) and implement pagination.
  Use `roots=true` for the list so subagent child sessions don't clutter it.
- `GET /session/{id}?directory=DIR` → one session.
- `GET /session/{id}/message?directory=DIR&limit=N` → array of `{info, parts[]}`.
  Part types to render: `text`, `reasoning` (collapsed by default), `tool` (show `tool`
  name + `state.status`; collapsible `state.input` and `state.output`/`state.error`),
  `step-start` (ignore), `step-finish` (tokens/cost, subtle), `patch` (list files),
  `file`, `agent`, `subtask`, `compaction`, unknown → small grey label.
  `info` of assistant messages has `modelID`, `providerID`, `cost`, `tokens`, `error`.
  Show `info.error` prominently if present.
- `POST /session?directory=DIR` body `{title}` → new session.
- `POST /session/{id}/prompt_async?directory=DIR` body
  `{model:{providerID,modelID}, parts:[{type:"text",text}]}` → 204; work happens async.
- `POST /session/{id}/abort?directory=DIR`.
- `GET /session/status?directory=DIR` → map of sessionID → `{type:"busy"|"idle"|"retry",...}`.
- `POST /session/{id}/shell?directory=DIR` — check its body schema in openapi.json; used only to
  `mkdir -p` a new directory (see below).
- `GET /permission?directory=DIR` and `POST /permission/{requestID}/reply?directory=DIR`
  body `{reply:"once"|"always"|"reject"}`.
- `GET /config/providers` → providers with models (CONTAINS SECRETS, sanitize!).
- `GET /project` → projects with `worktree` (use for directory suggestions).
- `GET /api/fs/list` — look up the query params in openapi.json; use for a directory browser.
- `GET /global/event` → SSE, each line `data: {"directory","project","payload":{"type","properties"}}`.
  Useful types: `session.updated`, `session.status`, `session.idle`, `session.error`,
  `message.updated`, `message.part.updated`, `message.part.delta` (if present — streaming text),
  `message.removed`, `permission.asked`/`permission.updated` (check spec for exact names),
  `todo.updated`. Ignore `sync`, `plugin.added`, `tui.*`, `server.*` except `server.connected`.

## Backend API (what the frontend uses)

- `GET /healthz` → `{ok:true}` (no auth, no upstream call — must answer even if opencode is down).
- `GET /api/status` → `{opencode: "up"|"down", version}` (calls upstream `/global/health`).
- `GET /api/models` → sanitized list. Upstream auto-detects HUNDREDS of models from many
  providers — only include providers `chutes`, `openrouter`, `abliteration`, `cavoti`.
  Return `{featured:[...], more:[...]}`: `featured` is this **preferred order** (only those
  actually present upstream), `more` is every other model of those four providers, sorted by
  provider then name (UI shows it in a separate "More models" optgroup set):
  1. chutes / moonshotai/Kimi-K3-TEE  ← default selection
  2. abliteration / abliterated-model-large-v2
  3. openrouter / nex-agi/nex-n2.5-pro:free
  4. openrouter / z-ai/glm-5.3-flash
  5. cavoti / glm-5.3-flash
  6. openrouter / deepseek/deepseek-v4.1-flash
  7. openrouter / openai/gpt-5.6-luna
  8. chutes / zai-org/GLM-5.2-TEE
  Group by provider in the `<select>` (`<optgroup>`), label free ones ("Chutes — free",
  "OpenRouter :free"). Remember the last chosen model in `localStorage`.
- `GET /api/sessions?cursor&search&limit` → list (plus busy status merged where cheap:
  query `/session/status` for the distinct directories on the page, max 10 parallel).
- `GET /api/sessions/:id?directory=` → `{session, messages}`.
- `POST /api/sessions` `{directory, title?, model:{providerID,modelID}, prompt, createDirectory?:bool}`:
  validate `directory` is absolute, normalized (`path.posix.normalize`, no `..`), starts
  with `ALLOWED_DIR_PREFIX`, matches `^[A-Za-z0-9._/ -]+$`. If `createDirectory`, first create
  a helper session in `ALLOWED_DIR_PREFIX` and run `mkdir -p -- '<dir>'` via the shell
  endpoint (single-quote-escape safely; the regex above already forbids quotes), then
  delete the helper session. Then create the session, send the prompt with the model,
  return `{session}`.
- `POST /api/sessions/:id/prompt` `{directory, text, model}`.
- `POST /api/sessions/:id/abort` `{directory}`.
- `GET /api/permissions?directory=` and `POST /api/permissions/:rid/reply` `{directory, reply}`.
- `GET /api/directories?path=` → directory listing for the picker (dirs only), constrained to
  `ALLOWED_DIR_PREFIX`; plus `GET /api/directories/suggest` → distinct recent session
  directories + project worktrees.
- `GET /api/events?sessionID=` → SSE to the browser. Backend keeps ONE upstream connection to
  `/global/event` (reconnect with backoff), fans out to browser clients, filtering by
  `payload.properties.sessionID` (or `properties.info.sessionID` / `properties.part.sessionID`)
  when `sessionID` is given; without it, forward only `session.updated`/`session.status`
  for the list view. Send `: ping` comments every 20 s. Set `X-Accel-Buffering: no`.

## Frontend

Single page with hash routing: `#/` session list, `#/new` new session, `#/s/<id>?d=<dir>`
session view. Dark, dense, readable, works at 380 px width (Florian uses his phone).

- **List**: search box, rows with title, directory (shortened `~/…`), model name, relative
  updated time, cost ($ with 3 decimals), a pulsing dot when busy. "Load more" pagination.
  Big "New session" button. Live refresh via `/api/events`.
- **New session**: directory input with suggestions (datalist from `/api/directories/suggest`)
  plus a "Browse" folder picker using `/api/directories`, checkbox "create if missing",
  model `<select>`, optional title, big prompt textarea (Ctrl/Cmd+Enter submits). On submit
  navigate to the session view.
- **Session view**: header (title, directory, model, status, total cost, Abort button when
  busy). Transcript: user messages as bubbles, assistant parts rendered as described above;
  auto-scroll to bottom only if the user is already near the bottom. Live updates: apply
  `message.updated` / `message.part.updated` (upsert by part id; for `message.part.delta`
  append `delta` to the part's field) — and re-fetch the full message list on `session.idle`
  and on SSE reconnect to self-heal. Pending permission requests appear as a banner with
  Allow once / Always / Reject. Composer at bottom: textarea + model select (defaults to the
  session's last used model) + Send.
- Show an unobtrusive banner if `/api/status` reports opencode down.

## Tests (`test/*.test.js`, `node --test`)

- auth: login success/failure, cookie signature tamper → 401, rate limit → 429.
- models sanitization strips secrets and applies preferred order.
- directory validation rejects `..`, relative paths, prefix escapes, quotes.
- a fake upstream (`node:http` server in the test) to test `POST /api/sessions` sends the
  right upstream calls, and that unknown `/api/*` paths 404 (no generic proxying).

## Integration check (do this before you finish)

There is a disposable local opencode you may start for testing — do NOT use port 4096:

```bash
cd /tmp/ocrc && OPENCODE_SERVER_PASSWORD=devpw timeout 900 opencode serve --hostname 127.0.0.1 --port 4597 &
cd /home/flori/Dev/opencode-remote && APP_PASSWORD=devapp SESSION_SECRET=x OPENCODE_URL=http://127.0.0.1:4597 OPENCODE_PASSWORD=devpw PORT=8787 node server.js &
```

Then with curl: log in, list sessions, list models (verify no secrets), create a session in
`/tmp/ocrc` with model `chutes/moonshotai/Kimi-K3-TEE` and prompt "reply with the word pong",
wait, fetch messages and confirm an assistant reply exists, and read a few seconds of
`/api/events`. Kill both processes afterwards. Report what passed.

## Done means

`npm test` green, integration check passed, `docker build` is NOT required (docker is not
available to you), files committed in git with a clear message (do not push). Finish with a
short report: files created, test results, integration check output, and any spec item you
could not implement.
