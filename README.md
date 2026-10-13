# opencode-remote

Password-protected, mobile-friendly browser remote control for the `opencode serve`
instance on the Sandy server. List current and historic sessions, read transcripts
live, start new coding sessions with a chosen model and working directory, send
follow-ups, abort, and answer permission requests.

Live: https://opencode-remote.app.mintapis.com (Sandy PaaS / Coolify app `opencode-remote`)

## Architecture

```
browser ──HTTPS──> Traefik ──> opencode-remote container (this repo, node:22, :8080)
                                   │  allowlisted /api/* routes only, basic auth
                                   ▼
                     opencode serve on the Sandy host, 172.30.1.1:4096
                     (systemd: opencode-remote-serve.service, bound to the coolify bridge)
```

- `server.js` — node:http router: login gate, `/api/*` routes, static files.
- `lib/auth.js` — constant-time password check, HMAC-signed cookie, login rate limit.
- `lib/upstream.js` — basic-auth client for opencode serve; never echoes upstream bodies.
- `lib/models.js` — turns `/config/providers` (which contains raw API keys!) into
  `{providerID, providerName, modelID, modelName}` only, with a featured order.
- `lib/events.js` — one upstream `/global/event` SSE connection, whitelisted event
  types fanned out to browsers, filtered per session.
- `lib/validate.js` — directory and ID validation.
- `lib/vault.js` — per-chat encryption (scrypt → AES-256-GCM blob format, round-trip digests)
  and the client for the host-side vault helper.
- `vault-helper/helper.py` — host-side companion (systemd `opencode-remote-vault.service`,
  `172.30.1.1:4097`, bearer token): encrypted blob store, `opencode import`, purge of remnants.
- `public/` — vanilla JS SPA (`app.js`, `views.js`, `markdown.js`, `styles.css`, `theme.js`).

## UI

Chat-style layout (sidebar with session history + main pane), modelled on the Chutes chat app:
- sidebar: sessions grouped by day with live status (running / idle / error), search,
  automated `/tmp` probe sessions hidden by default; an off-canvas drawer on phones
- new session: one screen with the first prompt, model picker and working directory
  (empty = `NEW_SESSION_DIRECTORY`, recent-directory chips, folder browser)
- transcript: incremental streaming render, markdown with copyable code blocks and tables,
  collapsible tool calls (diffs for edits, command + output for bash), collapsible reasoning
- inline permission and question cards; sticky composer (Enter sends, Shift+Enter newline)
  with a Stop button while the agent runs; delete session; dark/light theme

## Encrypted and private chats

- **Private chat** (checkbox on the new-chat form): the session is created with the title
  `Private chat · <Berlin date time>`. opencode 1.18 only runs its title generator
  (`small_model`) while a session still has the default `New session - <ISO>` title
  (`SessionPrompt.ensureTitle` / `Session.isDefaultTitle`), so the first message never goes
  to the title model. Compaction uses the chat's own model.
- **Encrypt** (button in a chat): the app exports the chat through the opencode API (the
  session, sub-agent child sessions, every message and part, plus referenced truncated
  tool-output files), encrypts it in the container (scrypt N=2^17 r=8 p=1 → AES-256-GCM,
  random salt and nonce, versioned 41-byte header as additional data), decrypts it once in
  memory to prove the blob opens, stores the ciphertext through the helper
  (`~/.local/share/opencode-remote-vault`, 0600, atomic rename), deletes the session in
  opencode and asks the helper to purge remnants (leftover event rows, tool-output files,
  `VACUUM` + `wal_checkpoint(TRUNCATE)`). The sidebar keeps a 🔒 entry with a neutral label.
- **Decrypt**: checks the stored SHA-256 of the blob (damaged file vs. wrong password),
  decrypts, re-imports with `opencode import` (plaintext only in a 0700 `/dev/shm` dir),
  then re-reads the chat through the API and compares per-session message counts and
  content digests. Re-encrypting replaces the ciphertext of the same entry.
- The password exists only in request memory: masked text field (not stored by password
  managers), never logged, never in browser storage. No recovery.
- **Limits:** this protects the stored history on Sandy. The model provider processed the
  messages when they were sent; a decrypted chat is plaintext on disk until it is encrypted
  again; backups made while it was decrypted are not affected; deleted SQLite pages are
  rebuilt by VACUUM, but SSD/filesystem-level remnants of overwritten blocks are out of reach.

## Environment

| var | meaning |
|---|---|
| `APP_PASSWORD` | shared login secret (required) |
| `SESSION_SECRET` | cookie HMAC key (required; rotate to log everyone out) |
| `OPENCODE_URL` | `http://172.30.1.1:4096` in production |
| `OPENCODE_USERNAME` / `OPENCODE_PASSWORD` | basic auth for opencode serve |
| `DEFAULT_DIRECTORY` | fallback directory for permission/question calls, default `/home/flori/Dev` |
| `NEW_SESSION_DIRECTORY` | where a new session runs when Directory is left empty, default `/home/flori/Dev/temp` (created on demand) |
| `ALLOWED_DIR_PREFIX` | new sessions only under this prefix, default `/home/flori/` |
| `VAULT_URL` / `VAULT_TOKEN` | vault helper (`http://172.30.1.1:4097`, token from `~/.config/opencode-remote-vault.env`); without them Encrypt is hidden |
| `PORT` | default 8080 |

## Security notes

This app controls an agent with shell access on the host. The rules it keeps:
explicit route allowlist (no generic proxy), secrets stripped from model data and
events, same-origin + JSON content type on mutations, strict CSP, the login rate
limit keyed on the proxy-appended X-Forwarded-For hop, the shared-secret login field
kept out of the browser password manager (all Sandy apps share `app.mintapis.com`),
and new-session directories restricted to `ALLOWED_DIR_PREFIX` with a strict
character set before they reach the `mkdir` shell call.

## Develop

```bash
npm test
APP_PASSWORD=dev SESSION_SECRET=dev OPENCODE_URL=http://127.0.0.1:4597 OPENCODE_PASSWORD=devpw PORT=8787 node server.js
```

Provider configuration (Chutes, OpenRouter, Abliteration, Cavoti) lives in
`~/.config/opencode/opencode.json` on the host, not in this repo.
