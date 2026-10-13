// test/events.test.js — EventHub fan-out: lifecycle events reach every client,
// message events only the client watching that session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventHub } from '../lib/events.js';

function client(sessionID) {
  const got = [];
  return { sessionID, got, write(o) { got.push(o.type); } };
}

test('session lifecycle events go to all clients, message events only to the watcher', () => {
  const hub = new EventHub({});
  const a = client('ses_a');
  const b = client(null);
  hub.clients.add(a);
  hub.clients.add(b);
  hub._dispatch({ payload: { type: 'session.status', properties: { sessionID: 'ses_x', status: { type: 'busy' } } } });
  hub._dispatch({ payload: { type: 'message.part.delta', properties: { sessionID: 'ses_a', delta: 'hi' } } });
  hub._dispatch({ payload: { type: 'message.part.delta', properties: { sessionID: 'ses_x', delta: 'hi' } } });
  hub._dispatch({ payload: { type: 'session.diff', properties: { sessionID: 'ses_x', diff: [] } } });
  hub._dispatch({ payload: { type: 'config.updated', properties: { key: 'secret' } } });
  assert.deepEqual(a.got, ['session.status', 'message.part.delta']);
  assert.deepEqual(b.got, ['session.status']);
});
