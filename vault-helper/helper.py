#!/usr/bin/env python3
"""opencode-remote vault helper — host-side companion of the opencode-remote app.

Runs on the Sandy host next to `opencode serve` (systemd: opencode-remote-vault.service),
bound to the coolify bridge only, bearer-token protected. It does the few things the
app container cannot do through the opencode HTTP API:

- stores the encrypted chat blobs (ciphertext only; the password and the crypto stay
  in the app container) under VAULT_DIR, 0600, written atomically
- re-imports a decrypted session with `opencode import` (plaintext only in a 0700
  tmpfs directory under /dev/shm, removed right after)
- purges plaintext remnants after the app deleted a session through the API:
  leftover event rows, truncated tool-output files, then VACUUM + WAL checkpoint

Never logs request bodies. Stdlib only.
"""
import base64
import hashlib
import hmac
import json
import os
import re
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get('VAULT_HOST', '172.30.1.1')
PORT = int(os.environ.get('VAULT_PORT', '4097'))
TOKEN = os.environ.get('VAULT_TOKEN', '')
HOME = os.path.expanduser('~')
VAULT_DIR = os.environ.get('VAULT_DIR', os.path.join(HOME, '.local/share/opencode-remote-vault'))
OPENCODE_DATA = os.environ.get('OPENCODE_DATA', os.path.join(HOME, '.local/share/opencode'))
OPENCODE_BIN = os.environ.get('OPENCODE_BIN', os.path.join(HOME, '.opencode/bin/opencode'))
ALLOWED_DIR_PREFIX = os.environ.get('ALLOWED_DIR_PREFIX', HOME + '/')
FALLBACK_DIR = os.environ.get('FALLBACK_DIR', os.path.join(HOME, 'Dev/temp'))
MAX_BODY = 200 * 1024 * 1024
MAX_TOOL_OUTPUT_TOTAL = 32 * 1024 * 1024

LOCK_ID = re.compile(r'^lk_[a-z0-9]{20}$')
SESSION_ID = re.compile(r'^ses_[A-Za-z0-9]{8,64}$')
TOOL_OUTPUT_NAME = re.compile(r'^tool_[A-Za-z0-9]{8,64}$')
META_KEYS = {'label', 'state', 'sessionID', 'createdAt', 'updatedAt', 'blobSha256', 'blobBytes', 'messageCount', 'private'}

# One mutating operation at a time: index rewrites, imports and VACUUM must not interleave.
mutex = threading.Lock()


class HTTPError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


# ---------------------------------------------------------------------------
# blob store
# ---------------------------------------------------------------------------
def ensure_dirs():
    os.makedirs(os.path.join(VAULT_DIR, 'blobs'), mode=0o700, exist_ok=True)
    os.chmod(VAULT_DIR, 0o700)
    os.chmod(os.path.join(VAULT_DIR, 'blobs'), 0o700)


def atomic_write(path, data):
    d = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(dir=d, prefix='.tmp-')
    try:
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
        dfd = os.open(d, os.O_RDONLY)
        try:
            os.fsync(dfd)
        finally:
            os.close(dfd)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def index_path():
    return os.path.join(VAULT_DIR, 'index.json')


def blob_path(lock_id):
    return os.path.join(VAULT_DIR, 'blobs', lock_id + '.ocv')


def read_index():
    try:
        with open(index_path(), 'rb') as f:
            data = json.loads(f.read() or b'{}')
        return data if isinstance(data, dict) else {}
    except FileNotFoundError:
        return {}


def write_index(idx):
    atomic_write(index_path(), json.dumps(idx, indent=1, sort_keys=True).encode())


def clean_meta(meta):
    if not isinstance(meta, dict):
        raise HTTPError(400, 'meta must be an object')
    out = {}
    for k, v in meta.items():
        if k not in META_KEYS:
            continue
        if k == 'label' and (not isinstance(v, str) or len(v) > 120):
            raise HTTPError(400, 'invalid label')
        if k == 'state' and v not in ('locked', 'unlocked'):
            raise HTTPError(400, 'invalid state')
        if k == 'sessionID' and v is not None and not (isinstance(v, str) and SESSION_ID.match(v)):
            raise HTTPError(400, 'invalid sessionID')
        out[k] = v
    return out


# ---------------------------------------------------------------------------
# opencode database / files
# ---------------------------------------------------------------------------
def db_connect():
    conn = sqlite3.connect(os.path.join(OPENCODE_DATA, 'opencode.db'), timeout=20, isolation_level=None)
    conn.execute('PRAGMA busy_timeout = 20000')
    return conn


def session_rows_left(conn, sid):
    q = [
        ('session', 'SELECT count(*) FROM session WHERE id = ?'),
        ('message', 'SELECT count(*) FROM message WHERE session_id = ?'),
        ('part', 'SELECT count(*) FROM part WHERE session_id = ?'),
        ('session_message', 'SELECT count(*) FROM session_message WHERE session_id = ?'),
        ('session_input', 'SELECT count(*) FROM session_input WHERE session_id = ?'),
        ('todo', 'SELECT count(*) FROM todo WHERE session_id = ?'),
        ('event', 'SELECT count(*) FROM event WHERE aggregate_id = ?'),
    ]
    return {name: conn.execute(sql, (sid,)).fetchone()[0] for name, sql in q}


def purge(session_ids, tool_outputs):
    report = {'sessions': {}, 'toolOutputsRemoved': 0}
    conn = db_connect()
    try:
        for sid in session_ids:
            left = session_rows_left(conn, sid)
            if left['session'] or left['message'] or left['part']:
                raise HTTPError(409, 'session still exists in opencode; delete it first')
            # Session.remove clears the event log in opencode 1.18; this only catches
            # rows left behind by an interrupted delete. Safe: the session is gone.
            if left['event'] or left['session_message'] or left['session_input'] or left['todo']:
                conn.execute('BEGIN IMMEDIATE')
                conn.execute('DELETE FROM event WHERE aggregate_id = ?', (sid,))
                conn.execute('DELETE FROM event_sequence WHERE aggregate_id = ?', (sid,))
                conn.execute('DELETE FROM session_message WHERE session_id = ?', (sid,))
                conn.execute('DELETE FROM session_input WHERE session_id = ?', (sid,))
                conn.execute('DELETE FROM todo WHERE session_id = ?', (sid,))
                conn.execute('COMMIT')
            report['sessions'][sid] = left
        # Freed pages still hold the deleted text: rebuild the file, then fold the WAL
        # back in and truncate it. Both are ordinary SQLite transactions and safe while
        # opencode serve has the database open; they wait (busy_timeout) for writers.
        # temp_store=MEMORY keeps VACUUM's scratch copy of all chats out of /tmp.
        report['clean'] = True
        conn.execute('PRAGMA temp_store = MEMORY')
        try:
            conn.execute('VACUUM')
        except sqlite3.OperationalError as e:
            report['clean'] = False
            report['reason'] = 'VACUUM did not run (%s); freed pages may still hold text until the next cleanup' % str(e)[:60]
        report['checkpoint'] = None
        for _ in range(20):
            busy, log, ckpt = conn.execute('PRAGMA wal_checkpoint(TRUNCATE)').fetchone()
            report['checkpoint'] = [busy, log, ckpt]
            if busy == 0:
                break
            time.sleep(0.5)
        if report['checkpoint'] and report['checkpoint'][0] != 0:
            report['clean'] = False
            report['reason'] = 'the database log could not be truncated (another opencode process was reading); old pages may remain until the next cleanup'
    finally:
        conn.close()
    # Revert diffs live outside the database (opencode storage/session_diff/<id>.json).
    for sid in session_ids:
        try:
            os.unlink(os.path.join(OPENCODE_DATA, 'storage', 'session_diff', sid + '.json'))
        except FileNotFoundError:
            pass
    tdir = os.path.join(OPENCODE_DATA, 'tool-output')
    for name in tool_outputs:
        p = os.path.join(tdir, name)
        try:
            size = os.path.getsize(p)
            with open(p, 'r+b') as f:  # overwrite before unlinking (best effort; no guarantee on SSD/journaling)
                f.write(b'\0' * size)
                f.flush()
                os.fsync(f.fileno())
            os.unlink(p)
            report['toolOutputsRemoved'] += 1
        except FileNotFoundError:
            pass
    try:
        report['walBytes'] = os.path.getsize(os.path.join(OPENCODE_DATA, 'opencode.db-wal'))
    except FileNotFoundError:
        report['walBytes'] = 0
    return report


def read_tool_outputs(names):
    tdir = os.path.join(OPENCODE_DATA, 'tool-output')
    files, total = {}, 0
    for name in names:
        p = os.path.join(tdir, name)
        try:
            with open(p, 'rb') as f:
                data = f.read(MAX_TOOL_OUTPUT_TOTAL + 1)
        except FileNotFoundError:
            continue
        total += len(data)
        if total > MAX_TOOL_OUTPUT_TOTAL:
            raise HTTPError(413, 'tool outputs too large')
        files[name] = base64.b64encode(data).decode()
    return files


def resolve_directory(d):
    if isinstance(d, str) and d.startswith('/') and '\0' not in d:
        real = os.path.realpath(d)
        allowed = (real + '/').startswith(ALLOWED_DIR_PREFIX) or real.startswith('/tmp/')
        if allowed and os.path.isdir(real):
            return real
    os.makedirs(FALLBACK_DIR, exist_ok=True)
    return FALLBACK_DIR


def child_env():
    env = {k: v for k, v in os.environ.items() if k not in ('VAULT_TOKEN',)}
    env['OPENAI_API_KEY'] = ''
    env['HOME'] = HOME
    return env


def import_sessions(directory, sessions, files):
    if not isinstance(sessions, list) or not sessions:
        raise HTTPError(400, 'sessions required')
    for s in sessions:
        sid = s.get('info', {}).get('id') if isinstance(s, dict) else None
        if not (isinstance(sid, str) and SESSION_ID.match(sid)) or not isinstance(s.get('messages'), list):
            raise HTTPError(400, 'invalid session export')
    cwd = resolve_directory(directory)
    shm = '/dev/shm' if os.path.isdir('/dev/shm') else None
    tmp = tempfile.mkdtemp(prefix='ocv-', dir=shm)
    os.chmod(tmp, 0o700)
    imported = []
    try:
        for i, s in enumerate(sessions):
            p = os.path.join(tmp, '%d.json' % i)
            fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'w') as f:
                json.dump(s, f)
            r = subprocess.run([OPENCODE_BIN, 'import', p], cwd=cwd, env=child_env(),
                               stdin=subprocess.DEVNULL, capture_output=True, timeout=180)
            out = r.stdout.decode(errors='replace')
            if r.returncode != 0 or 'Imported session' not in out:
                raise HTTPError(502, 'opencode import failed (exit %d)' % r.returncode)
            imported.append(s['info']['id'])
            os.unlink(p)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    tdir = os.path.join(OPENCODE_DATA, 'tool-output')
    restored = 0
    for name, b64 in (files or {}).items():
        if not TOOL_OUTPUT_NAME.match(name):
            continue
        os.makedirs(tdir, exist_ok=True)
        atomic_write(os.path.join(tdir, name), base64.b64decode(b64))
        restored += 1
    return {'imported': imported, 'directory': cwd, 'toolOutputsRestored': restored}


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = 'ocr-vault'
    sys_version = ''

    def log_message(self, fmt, *args):  # method + path + status only, never bodies
        pass

    def send_json(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def authed(self):
        h = self.headers.get('Authorization', '')
        return bool(TOKEN) and h.startswith('Bearer ') and hmac.compare_digest(h[7:].encode(), TOKEN.encode())

    def body_json(self):
        try:
            n = int(self.headers.get('Content-Length') or 0)
        except ValueError:
            raise HTTPError(400, 'bad Content-Length')
        if n < 0 or n > MAX_BODY:
            raise HTTPError(413, 'body too large')
        raw = self.rfile.read(n) if n else b''
        try:
            return json.loads(raw or b'{}')
        except ValueError:
            raise HTTPError(400, 'invalid JSON')

    def dispatch(self, method):
        path = self.path.split('?', 1)[0]
        if path == '/healthz' and method == 'GET':
            return self.send_json(200, {'ok': True})
        if not self.authed():
            return self.send_json(401, {'error': 'unauthorized'})
        try:
            self.route(method, path)
        except HTTPError as e:
            self.send_json(e.status, {'error': e.message})
        except Exception as e:  # never echo details that could contain content
            print('vault-helper error: %s %s: %s' % (method, path, type(e).__name__), flush=True)
            self.send_json(500, {'error': 'internal error'})

    def route(self, method, path):
        m = re.match(r'^/entry/([^/]+)(/blob)?$', path)
        if path == '/index' and method == 'GET':
            return self.send_json(200, {'entries': read_index()})
        if m:
            lock_id = m.group(1)
            if not LOCK_ID.match(lock_id):
                raise HTTPError(400, 'invalid lock id')
            if m.group(2) and method == 'GET':
                try:
                    with open(blob_path(lock_id), 'rb') as f:
                        data = f.read()
                except FileNotFoundError:
                    raise HTTPError(404, 'not found')
                return self.send_json(200, {'blob': base64.b64encode(data).decode()})
            if not m.group(2) and method == 'PUT':
                # Create or replace: blob (optional) + metadata. The blob is renamed into
                # place before the index points at its new hash.
                body = self.body_json()
                meta = clean_meta(body.get('meta') or {})
                with mutex:
                    idx = read_index()
                    entry = dict(idx.get(lock_id) or {})
                    if 'blob' in body:
                        data = base64.b64decode(body['blob'], validate=True)
                        atomic_write(blob_path(lock_id), data)
                        entry['blobSha256'] = hashlib.sha256(data).hexdigest()
                        entry['blobBytes'] = len(data)
                    elif lock_id not in idx:
                        raise HTTPError(404, 'not found')
                    meta.pop('blobSha256', None)
                    meta.pop('blobBytes', None)
                    entry.update(meta)
                    idx[lock_id] = entry
                    write_index(idx)
                return self.send_json(200, {'entry': entry})
            if not m.group(2) and method == 'DELETE':
                with mutex:
                    idx = read_index()
                    idx.pop(lock_id, None)
                    write_index(idx)
                    try:
                        os.unlink(blob_path(lock_id))
                    except FileNotFoundError:
                        pass
                return self.send_json(200, {'ok': True})
        if path == '/tool-output/read' and method == 'POST':
            names = [n for n in (self.body_json().get('names') or []) if isinstance(n, str) and TOOL_OUTPUT_NAME.match(n)]
            return self.send_json(200, {'files': read_tool_outputs(names[:500])})
        if path == '/import' and method == 'POST':
            body = self.body_json()
            with mutex:
                return self.send_json(200, import_sessions(body.get('directory'), body.get('sessions'), body.get('files')))
        if path == '/purge' and method == 'POST':
            body = self.body_json()
            sids = body.get('sessionIDs') or []
            if not isinstance(sids, list) or not sids or not all(isinstance(s, str) and SESSION_ID.match(s) for s in sids):
                raise HTTPError(400, 'invalid sessionIDs')
            outs = [n for n in (body.get('toolOutputs') or []) if isinstance(n, str) and TOOL_OUTPUT_NAME.match(n)]
            with mutex:
                return self.send_json(200, purge(sids, outs))
        raise HTTPError(404, 'not found')

    def do_GET(self):
        self.dispatch('GET')

    def do_PUT(self):
        self.dispatch('PUT')

    def do_POST(self):
        self.dispatch('POST')

    def do_DELETE(self):
        self.dispatch('DELETE')


def main():
    if len(TOKEN) < 32:
        raise SystemExit('VAULT_TOKEN (>= 32 chars) is required')
    os.umask(0o077)
    ensure_dirs()
    srv = ThreadingHTTPServer((HOST, PORT), Handler)
    print('vault-helper listening on %s:%d' % (HOST, PORT), flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
