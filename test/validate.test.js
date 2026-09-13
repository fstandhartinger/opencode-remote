// test/validate.test.js — directory validation.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDirectory, shellQuote, isValidSessionId, isValidPermissionId } from '../lib/validate.js';

const PREFIX = '/home/flori/';

function v(dir) {
  return validateDirectory(dir, PREFIX);
}

test('accepts a valid absolute path under the prefix', () => {
  const r = v('/home/flori/Dev/my-app');
  assert.equal(r.ok, true);
  assert.equal(r.dir, '/home/flori/Dev/my-app');
});

test('rejects relative paths', () => {
  assert.equal(v('relative/path').ok, false);
  assert.equal(v('~/Dev').ok, false);
  assert.equal(v('Dev').ok, false);
});

test('rejects .. traversal', () => {
  assert.equal(v('/home/flori/Dev/../etc').ok, false);
  assert.equal(v('/home/flori/..').ok, false);
  assert.equal(v('/home/flori/Dev/foo/../../bar').ok, false);
});

test('rejects prefix escape', () => {
  assert.equal(v('/home/other/Dev').ok, false);
  assert.equal(v('/home/floriX').ok, false);
  assert.equal(v('/tmp').ok, false);
  assert.equal(v('/home/flori').ok, false); // must be strictly under
});

test('rejects quotes and other unsafe chars', () => {
  assert.equal(v("/home/flori/Dev/a'b").ok, false);
  assert.equal(v('/home/flori/Dev/$(rm)').ok, false);
  assert.equal(v('/home/flori/Dev/`x`').ok, false);
  assert.equal(v('/home/flori/Dev/; rm -rf /').ok, false);
});

test('normalizes and rejects escape attempts', () => {
  assert.equal(v('/home/flori/Dev/foo/..').ok, false);
  assert.equal(v('/home/flori//Dev').ok, true);
});

test('id validation', () => {
  assert.equal(isValidSessionId('ses_Abc123'), true);
  assert.equal(isValidSessionId('ses_'), false);
  assert.equal(isValidSessionId('ses_Abc 123'), false);
  assert.equal(isValidSessionId('Abc'), false);
  assert.equal(isValidPermissionId('per_abc123'), true);
  assert.equal(isValidPermissionId('per_abc-123'), false);
});

test('shellQuote single-quote escapes safely', () => {
  assert.equal(shellQuote('/home/flori/Dev/a b'), "'/home/flori/Dev/a b'");
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});