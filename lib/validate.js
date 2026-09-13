// lib/validate.js — validation of directories, session IDs and permission IDs.

import path from 'node:path';

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
const PERMISSION_ID_RE = /^[A-Za-z0-9_]+$/;
const DIR_RE = /^[A-Za-z0-9._/ -]+$/;

export function isValidSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

export function isValidPermissionId(id) {
  return typeof id === 'string' && PERMISSION_ID_RE.test(id);
}

/**
 * Validate a working directory for new sessions.
 * Must be absolute, normalized, contain no `..`, start with ALLOWED_DIR_PREFIX,
 * and match the safe character set.
 * @param {string} dir
 * @param {string} allowedPrefix
 * @returns {{ok: true, dir: string} | {ok: false, error: string}}
 */
export function validateDirectory(dir, allowedPrefix) {
  if (typeof dir !== 'string' || dir.length === 0) {
    return { ok: false, error: 'directory required' };
  }
  if (!dir.startsWith('/')) return { ok: false, error: 'directory must be absolute' };
  const normalized = path.posix.normalize(dir);
  // Reject any attempt to escape via '..' even if it resolves back in.
  if (dir.split('/').includes('..') || normalized.split('/').includes('..')) {
    return { ok: false, error: 'directory may not contain ..' };
  }
  if (!DIR_RE.test(normalized)) {
    return { ok: false, error: 'directory contains disallowed characters' };
  }
  if (!allowedPrefix || normalized === allowedPrefix ||
      (allowedPrefix.endsWith('/') && normalized.startsWith(allowedPrefix)) ||
      normalized.startsWith(allowedPrefix + '/')) {
    // allowed
  } else {
    return { ok: false, error: `directory must be under ${allowedPrefix}` };
  }
  return { ok: true, dir: normalized };
}

/**
 * Validate the directory of an EXISTING session (reading, prompting, aborting,
 * permissions). Historic sessions can live outside ALLOWED_DIR_PREFIX (e.g. /tmp),
 * so only require a safe absolute path; the value is only ever passed to upstream
 * as a URL query parameter, never to a shell.
 * @param {string} dir
 * @returns {{ok: true, dir: string} | {ok: false, error: string}}
 */
export function validateExistingDirectory(dir) {
  return validateDirectory(dir, '/');
}

/**
 * Validate that a directory used in a session's path is within the allowed prefix.
 * Returns false if the dir is outside the allowed prefix or empty.
 */
export function directoryAllowed(dir, allowedPrefix) {
  const v = validateDirectory(dir, allowedPrefix);
  return v.ok;
}

/**
 * Single-quote escape a shell path segment for the mkdir command. The directory
 * regex already forbids quotes, so a simple wrapper around quote() suffices.
 * @param {string} s
 * @returns {string}
 */
export function shellQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}