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
- `public/` — vanilla JS SPA (`app.js`, `views.js`, `markdown.js`, `styles.css`).

## Environment

| var | meaning |
|---|---|
| `APP_PASSWORD` | shared login secret (required) |
| `SESSION_SECRET` | cookie HMAC key (required; rotate to log everyone out) |
| `OPENCODE_URL` | `http://172.30.1.1:4096` in production |
| `OPENCODE_USERNAME` / `OPENCODE_PASSWORD` | basic auth for opencode serve |
| `DEFAULT_DIRECTORY` | default `/home/flori/Dev` |
| `ALLOWED_DIR_PREFIX` | new sessions only under this prefix, default `/home/flori/` |
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
