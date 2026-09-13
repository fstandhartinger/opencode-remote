// lib/upstream.js — tiny basic-auth client for the upstream `opencode serve` API.
// Never echoes upstream error bodies (they may contain config) and never logs secrets.

export class UpstreamError extends Error {
  /**
   * @param {number} status upstream HTTP status (0 for network error)
   * @param {string} statusText upstream status text (safe: cannot contain config)
   * @param {string} op short operation label for diagnostics
   */
  constructor(status, statusText, op) {
    super(`upstream ${status} ${statusText || 'error'} (${op})`);
    this.name = 'UpstreamError';
    this.status = status;
    this.upstreamOp = op;
  }
}

/**
 * Thin basic-auth wrapper around the upstream `opencode serve` REST/SSE API.
 * @param {object} cfg {opencodeUrl, opencodeUsername, opencodePassword, fetchImpl?}
 */
export class Upstream {
  constructor({ opencodeUrl, opencodeUsername = 'opencode', opencodePassword = '', fetchImpl } = {}) {
    if (!opencodeUrl) throw new Error('opencodeUrl required');
    this.baseUrl = String(opencodeUrl).replace(/\/+$/, '');
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.username = opencodeUsername ?? 'opencode';
    this.password = opencodePassword ?? '';
    this._auth = null;
  }

  basicAuth() {
    if (!this._auth) {
      this._auth = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
    }
    return this._auth;
  }

  /**
   * Raw fetch against upstream (for streaming the SSE hub). Returns Response as-is.
   */
  async raw(path, opts = {}) {
    return this.fetchImpl(this.baseUrl + path, {
      method: opts.method ?? 'GET',
      headers: {
        Accept: opts.accept ?? 'application/json',
        Authorization: this.basicAuth(),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
  }

  /**
   * Fetch upstream; throw UpstreamError on non-2xx (never echoing the body).
   */
  async fetch(path, opts = {}) {
    const op = opts.op ?? String(path);
    let res;
    try {
      res = await this.fetchImpl(this.baseUrl + path, {
        method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
        headers: {
          Accept: 'application/json',
          Authorization: this.basicAuth(),
          ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (err) {
      const e = new UpstreamError(0, String(err && err.message || 'fetch failed'), op);
      e.cause = err;
      throw e;
    }
    if (!res.ok) throw new UpstreamError(res.status, res.statusText, op);
    return res;
  }

  /** fetch + res.json(); 204 / empty → undefined. */
  async json(path, opts = {}) {
    const res = await this.fetch(path, opts);
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    return JSON.parse(text);
  }

  /**
   * Raw streaming fetch for the SSE hub (no error conversion beyond !ok check).
   */
  async openEventStream() {
    const res = await this.fetchImpl(this.baseUrl + '/global/event', {
      headers: { Accept: 'text/event-stream', Authorization: this.basicAuth() },
    });
    if (!res.ok) throw new UpstreamError(res.status, res.statusText, 'GET /global/event');
    return res;
  }
}