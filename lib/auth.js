// lib/auth.js — cookie signing, constant-time login, in-memory per-IP rate limiting.
// Never logs passwords or cookies.

import crypto from 'node:crypto';

const MAX_ATTEMPTS = 10;
const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * SHA-256 digest, constant-time compare against a stored digest.
 * @param {string} candidate
 * @param {string} secret
 */
export function verifyPassword(candidate, secret) {
  const a = crypto.createHash('sha256').update(candidate).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function b64url(buf) {
  return buf.toString('base64url');
}

/**
 * Sign a session token: `expiry.hmac` where expiry is a base64url timestamp.
 * @param {string} sessionSecret
 * @returns {{token: string, expiresAt: number}}
 */
export function signToken(sessionSecret) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const expiry = b64url(Buffer.from(String(expiresAt)));
  const mac = crypto.createHmac('sha256', sessionSecret).update(expiry).digest('base64url');
  return { token: `${expiry}.${mac}`, expiresAt };
}

/**
 * Verify a session token. Returns boolean; also rejects expired tokens.
 * @param {string} token
 * @param {string} sessionSecret
 */
export function verifyToken(token, sessionSecret) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const expiry = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', sessionSecret).update(expiry).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const ts = Number(Buffer.from(expiry, 'base64url').toString());
  if (!Number.isFinite(ts) || ts <= Date.now()) return false;
  return true;
}

const COOKIE_NAME = 'ocr_session';

export { COOKIE_NAME };

/**
 * In-memory rate limiter for login failures. Each entry holds a count and a
 * reset timestamp. Old windows are pruned lazily.
 */
export class LoginRateLimiter {
  constructor({ max = MAX_ATTEMPTS, windowMs = WINDOW_MS } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.map = new Map();
  }

  _key(ip) {
    return ip;
  }

  /**
   * Record a failed attempt for this IP.
   * @returns {boolean} true if the IP is now over the limit
   */
  fail(ip) {
    const now = Date.now();
    let e = this.map.get(ip);
    if (!e || e.reset <= now) e = { count: 0, reset: now + this.windowMs };
    e.count += 1;
    this.map.set(ip, e);
    return e.count > this.max;
  }

  /** Whether the IP is currently blocked (over limit within the window). */
  blocked(ip) {
    const now = Date.now();
    const e = this.map.get(ip);
    return !!e && e.reset > now && e.count > this.max;
  }

  /** Successful login clears the counter for this IP. */
  clear(ip) {
    this.map.delete(ip);
  }

  /**
   * Best-effort purge of expired entries to avoid unbounded growth.
   */
  prune() {
    const now = Date.now();
    for (const [k, e] of this.map) {
      if (e.reset <= now) this.map.delete(k);
    }
  }
}