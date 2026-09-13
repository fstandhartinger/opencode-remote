// lib/events.js — keeps ONE upstream connection to /global/event, reconnects with
// backoff, fans out to browser SSE clients, and filters events by session / type.

const WHITELIST = new Set([
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'session.idle',
  'session.error',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'permission.asked',
  'permission.replied',
  'question.asked',
  'todo.updated',
  'session.diff',
  'server.connected',
]);

// The raw event shape is {directory, project, payload:{type, properties}}.
// We only ever forward {type, properties} for whitelisted types.

/**
 * @param {Upstream} upstream
 */
export class EventHub {
  constructor(upstream, { reconnectBaseMs = 1000, maxBackoffMs = 15000 } = {}) {
    this.upstream = upstream;
    this.clients = new Set(); // {write(obj), close(), sessionID}
    this.reconnectBaseMs = reconnectBaseMs;
    this.maxBackoffMs = maxBackoffMs;
    this.attempt = 0;
    this.streaming = false;
    this._stopped = false;
  }

  /** Add a browser SSE client. Returns an unsubscribe function. */
  subscribe(client) {
    this.clients.add(client);
    this._ensureStream();
    return () => this.clients.delete(client);
  }

  _ensureStream() {
    if (this.streaming || this._stopped) return;
    this.streaming = true;
    this._run().catch(() => {});
  }

  async _run() {
    while (!this._stopped && this.clients.size > 0) {
      try {
        const res = await this.upstream.openEventStream();
        this.attempt = 0;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, idx).trim();
            buf = buf.slice(idx + 1);
            if (line.startsWith('data:')) {
              const payload = line.slice(5).trim();
              if (payload) {
                try {
                  const ev = JSON.parse(payload);
                  this._dispatch(ev);
                } catch { /* ignore malformed line */ }
              }
            }
          }
        }
      } catch (err) {
        // upstream went away; back off and retry while clients remain
      }
      if (this._stopped || this.clients.size === 0) break;
      this.attempt += 1;
      const delay = Math.min(this.reconnectBaseMs * 2 ** this.attempt, this.maxBackoffMs);
      await new Promise((r) => setTimeout(r, delay));
    }
    this.streaming = false;
  }

  _dispatch(raw) {
    const payload = raw && raw.payload;
    if (!payload) return;
    const type = payload.type;
    if (!WHITELIST.has(type)) return;
    const props = payload.properties || {};
    const envelope = { type, properties: props };

    // Never forward config/provider payloads — handled by the whitelist above,
    // which does not include 'config' or 'provider' event types.

    for (const c of Array.from(this.clients)) {
      const sid = c.sessionID;
      if (sid) {
        // Filter by session
        const evSession = props.sessionID ||
          (props.info && props.info.sessionID) ||
          (props.part && props.part.sessionID) ||
          (props.messageID && null) ||
          null;
        if (evSession !== sid) continue;
        c.write(envelope);
      } else {
        // List view: forward only session.* events
        if (type.startsWith('session.')) c.write(envelope);
      }
    }
  }

  stop() {
    this._stopped = true;
    this.clients.clear();
  }
}