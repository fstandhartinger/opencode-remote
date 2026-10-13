// opencode-remote views: app shell (sidebar + main), new-session screen and the
// live session transcript. Depends on App (window.App) and Markdown (window.Markdown).
// The transcript renders incrementally (one DOM node per message and per part),
// so streaming deltas never rebuild the whole timeline or collapse open tool calls.
(function () {
  'use strict';

  var A = null; // App
  var PAGE = 40;

  var state = {
    config: { newSessionDirectory: '/home/flori/Dev/temp' },
    // sidebar
    sessions: [],
    cursor: null,
    hasMore: false,
    search: '',
    hideProbes: readPref('ocr-hide-probes', true),
    listLoading: false,
    listSeq: 0,
    busy: {},          // sessionID -> 'busy' | 'retry'
    errors: readJSON('ocr-errors', {}), // sessionID -> message (last run failed)
    models: { featured: [], more: [] },
    modelsLoaded: false,
    suggestDirs: [],
    opencodeStatus: null,
    // current route
    route: null,
    sessionID: null,
    directory: '',
    session: null,
    messages: [],
    permissions: [],
    questions: [],
    hasOlder: false,
    oldestID: null,
    loadingOlder: false,
    atBottom: true,
    openParts: {},     // partID -> true for expanded tool/reasoning blocks
    hadDisconnect: false,
    // encrypted chats (lock entries from the vault helper)
    vault: { enabled: false, entries: [] }
  };
  var PRIVATE_PREFIX = 'Private chat \u00b7 ';
  var LIMITS_TEXT = 'Encryption protects the stored history on Sandy: while a chat is locked, its messages exist only as ciphertext and nobody can read them without your password. ' +
    'It does not undo what already happened: the model provider processed every message when it was sent, a decrypted chat is plaintext on disk again until you encrypt it, ' +
    'and backups taken while it was decrypted keep that plaintext. There is no recovery: if you lose this password, the chat is gone.';

  var dom = {};        // shell nodes
  var msgEls = {};     // messageID -> element
  var partEls = {};    // partID -> element
  var pending = {};    // partID -> true (re-render scheduled)
  var rafPending = false;

  // ---------- small helpers ----------
  function readPref(k, dflt) {
    try { var v = localStorage.getItem(k); return v === null ? dflt : v === '1'; } catch (e) { return dflt; }
  }
  function writePref(k, v) { try { localStorage.setItem(k, v ? '1' : '0'); } catch (e) {} }
  function readJSON(k, dflt) {
    try { var v = JSON.parse(localStorage.getItem(k)); return v || dflt; } catch (e) { return dflt; }
  }
  function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  function el(tag, cls, text) { return A.el(tag, cls, text); }
  function icon(name, cls) {
    var s = document.createElement('span');
    s.className = 'icon' + (cls ? ' ' + cls : '');
    s.setAttribute('aria-hidden', 'true');
    s.innerHTML = ICONS[name] || ICONS.dot;
    return s;
  }
  function btn(cls, label, onClick, iconName) {
    var b = el('button', cls);
    b.type = 'button';
    if (iconName) b.appendChild(icon(iconName));
    if (label) b.appendChild(el('span', 'btn-label', label));
    if (onClick) b.addEventListener('click', onClick);
    return b;
  }

  var SVG = function (body) {
    return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + body + '</svg>';
  };
  var ICONS = {
    menu: SVG('<path d="M4 6h16M4 12h16M4 18h16"/>'),
    plus: SVG('<path d="M12 5v14M5 12h14"/>'),
    x: SVG('<path d="M18 6 6 18M6 6l12 12"/>'),
    send: SVG('<path d="M12 19V5M5 12l7-7 7 7"/>'),
    stop: '<svg viewBox="0 0 24 24" width="14" height="14"><rect x="5" y="5" width="14" height="14" rx="2" fill="currentColor"/></svg>',
    folder: SVG('<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'),
    terminal: SVG('<path d="m4 17 6-5-6-5M12 19h8"/>'),
    file: SVG('<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'),
    edit: SVG('<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>'),
    search: SVG('<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>'),
    globe: SVG('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
    list: SVG('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
    bot: SVG('<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 4v4M9 13h.01M15 13h.01"/>'),
    tool: SVG('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>'),
    check: SVG('<path d="M20 6 9 17l-5-5"/>'),
    alert: SVG('<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>'),
    help: SVG('<circle cx="12" cy="12" r="9"/><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01"/>'),
    sun: SVG('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
    moon: SVG('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    logout: SVG('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>'),
    trash: SVG('<path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/>'),
    copy: SVG('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
    down: SVG('<path d="M12 5v14M5 12l7 7 7-7"/>'),
    up: SVG('<path d="m18 15-6-6-6 6"/>'),
    chevron: SVG('<path d="m9 18 6-6-6-6"/>'),
    lock: SVG('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>'),
    unlock: SVG('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>'),
    eye: SVG('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>'),
    dot: '<svg viewBox="0 0 24 24" width="10" height="10"><circle cx="12" cy="12" r="5" fill="currentColor"/></svg>'
  };

  function shortDir(d) { return A.homeShort(d); }
  function modelKey(m) { return m ? m.providerID + '/' + m.modelID : ''; }
  function sessionModelID(s) { return s && s.model ? (s.model.id || s.model.modelID || '') : ''; }
  function sessionStatus(id) {
    if (state.busy[id]) return 'running';
    if (state.errors[id]) return 'error';
    return 'idle';
  }
  function errText(e) {
    if (!e) return '';
    if (typeof e === 'string') return e;
    if (e.data && e.data.message) return String(e.data.message);
    if (e.message) return String(e.message);
    if (e.name) return String(e.name);
    try { return JSON.stringify(e); } catch (x) { return 'error'; }
  }
  // Stopping a run surfaces upstream as MessageAbortedError; that is the user's
  // own action, not a failure.
  function isAbort(e) {
    return !!e && (e.name === 'MessageAbortedError' || /^aborted$/i.test(errText(e)));
  }

  function setError(id, msg) {
    if (msg) state.errors[id] = String(msg).slice(0, 300);
    else delete state.errors[id];
    var keys = Object.keys(state.errors);
    if (keys.length > 60) delete state.errors[keys[0]];
    writeJSON('ocr-errors', state.errors);
  }
  function sessionHref(s) {
    return '#/s/' + encodeURIComponent(s.id) + '?d=' + encodeURIComponent(s.directory || '');
  }
  function toast(text, kind) {
    var t = el('div', 'toast' + (kind ? ' ' + kind : ''), text);
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('out'); }, 2600);
    setTimeout(function () { t.remove(); }, 3000);
  }
  function copyText(text, b) {
    function done() {
      if (!b) return;
      var lbl = b.querySelector('.btn-label') || b;
      var old = lbl.textContent;
      lbl.textContent = 'Copied';
      b.classList.add('copied');
      setTimeout(function () { lbl.textContent = old; b.classList.remove('copied'); }, 1400);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text); done(); });
    } else { fallbackCopy(text); done(); }
  }
  function fallbackCopy(text) {
    var ta = el('textarea', 'offscreen');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) {}
    ta.remove();
  }

  // ---------- init / shell ----------
  function init(App) {
    A = App;
    buildShell();
    A.api('/api/config').then(function (c) {
      if (c) state.config = c;
      refreshDirHint();
      state.configLoaded = true;
      if (c && c.vault) {
        state.vault.enabled = true;
        loadVault().then(function () { if (state.route === 'lock') lockView(state.lockID); });
        refreshVaultControls();
      } else if (state.route === 'lock') lockView(state.lockID);
    }).catch(function () {});
    loadModels();
    A.api('/api/directories/suggest').then(function (d) {
      state.suggestDirs = (d && d.directories) || [];
      renderRecentDirs();
    }).catch(function () {});
    fetchList(false);
    A.loadStatus();
    setInterval(A.loadStatus, 60000);

    // Delegated copy buttons (markdown code blocks); the CSP forbids inline handlers.
    document.addEventListener('click', function (e) {
      var b = e.target.closest && e.target.closest('.copy-btn[data-copy="code"]');
      if (!b) return;
      var block = b.closest('.codeblock');
      var code = block && block.querySelector('pre');
      if (code) copyText(code.textContent, b);
    });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { closeDrawer(); closeModal(); }
    });
  }

  function buildShell() {
    var root = document.getElementById('app');
    root.innerHTML = '';
    var shell = el('div', 'shell');

    var sb = el('aside', 'sidebar');
    sb.id = 'sidebar';
    var head = el('div', 'sb-head');
    var brand = el('a', 'brand');
    brand.href = '#/new';
    brand.appendChild(el('span', 'brand-mark'));
    brand.appendChild(document.createTextNode('opencode '));
    brand.appendChild(el('span', 'brand-dim', 'remote'));
    head.appendChild(brand);
    var closeBtn = btn('icon-btn sb-close', '', closeDrawer, 'x');
    closeBtn.setAttribute('aria-label', 'Close menu');
    head.appendChild(closeBtn);
    sb.appendChild(head);

    var newBtn = el('a', 'btn primary block new-session-btn');
    newBtn.href = '#/new';
    newBtn.appendChild(icon('plus'));
    newBtn.appendChild(el('span', 'btn-label', 'New session'));
    sb.appendChild(newBtn);

    var searchWrap = el('div', 'sb-search');
    searchWrap.appendChild(icon('search'));
    var si = el('input', 'sb-search-input');
    si.type = 'search';
    si.placeholder = 'Search sessions';
    si.autocomplete = 'off';
    si.setAttribute('aria-label', 'Search sessions');
    var tmr = null;
    si.addEventListener('input', function () {
      clearTimeout(tmr);
      tmr = setTimeout(function () {
        state.search = si.value.trim();
        fetchList(false);
      }, 250);
    });
    searchWrap.appendChild(si);
    sb.appendChild(searchWrap);

    var filter = el('label', 'sb-filter');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.checked = state.hideProbes;
    cb.addEventListener('change', function () {
      state.hideProbes = cb.checked;
      writePref('ocr-hide-probes', cb.checked);
      fetchList(false);
    });
    filter.appendChild(cb);
    filter.appendChild(el('span', null, 'Hide automated /tmp sessions'));
    sb.appendChild(filter);

    var list = el('nav', 'sb-list');
    list.id = 'sb-list';
    list.setAttribute('aria-label', 'Sessions');
    sb.appendChild(list);

    var foot = el('div', 'sb-foot');
    var conn = el('div', 'conn');
    conn.id = 'conn';
    conn.appendChild(el('span', 'conn-dot'));
    conn.appendChild(el('span', 'conn-label', 'connecting\u2026'));
    foot.appendChild(conn);
    var themeBtn = btn('icon-btn', '', toggleTheme, currentTheme() === 'dark' ? 'sun' : 'moon');
    themeBtn.id = 'theme-btn';
    themeBtn.title = 'Toggle light/dark';
    themeBtn.setAttribute('aria-label', 'Toggle light or dark theme');
    foot.appendChild(themeBtn);
    var out = btn('icon-btn', '', logout, 'logout');
    out.title = 'Sign out';
    out.setAttribute('aria-label', 'Sign out');
    foot.appendChild(out);
    sb.appendChild(foot);

    var backdrop = el('div', 'backdrop');
    backdrop.addEventListener('click', closeDrawer);

    var main = el('main', 'main');
    main.id = 'main';

    shell.appendChild(sb);
    shell.appendChild(backdrop);
    shell.appendChild(main);
    root.appendChild(shell);
    dom = { shell: shell, sidebar: sb, list: list, main: main, search: si };
  }

  function openDrawer() { dom.shell.classList.add('drawer-open'); }
  function closeDrawer() { if (dom.shell) dom.shell.classList.remove('drawer-open'); }

  function currentTheme() { return document.documentElement.getAttribute('data-theme') || 'dark'; }
  function toggleTheme() {
    var t = currentTheme() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', t);
    try { localStorage.setItem('ocr-theme', t); } catch (e) {}
    var b = document.getElementById('theme-btn');
    if (b) { b.innerHTML = ''; b.appendChild(icon(t === 'dark' ? 'sun' : 'moon')); }
  }

  function logout() {
    fetch('/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      .finally(function () { window.location.replace('/login.html'); });
  }

  function setOpenCodeStatus(s) {
    state.opencodeStatus = s;
    var b = document.getElementById('banner');
    var down = s && s.opencode === 'down';
    if (b) {
      b.hidden = !down;
      b.textContent = down ? 'opencode is unreachable \u2014 data may be stale.' : '';
    }
    var c = document.getElementById('conn');
    if (c) {
      c.className = 'conn ' + (down ? 'down' : 'up');
      c.querySelector('.conn-label').textContent = down ? 'opencode offline' : ('opencode ' + (s && s.version ? 'v' + s.version : 'online'));
    }
  }

  function topbar(titleNode, extra) {
    var bar = el('header', 'topbar');
    var m = btn('icon-btn menu-btn', '', openDrawer, 'menu');
    m.setAttribute('aria-label', 'Open sessions');
    bar.appendChild(m);
    bar.appendChild(titleNode);
    if (extra) extra.forEach(function (x) { bar.appendChild(x); });
    return bar;
  }

  // ---------- SIDEBAR LIST ----------
  function fetchList(append) {
    var seq = ++state.listSeq;
    state.listLoading = true;
    if (!append) { state.cursor = null; renderList(); }
    var q = '/api/sessions?limit=' + PAGE;
    if (append && state.cursor) q += '&cursor=' + encodeURIComponent(state.cursor);
    if (state.search) q += '&search=' + encodeURIComponent(state.search);
    if (state.hideProbes) q += '&hideProbes=1';
    A.api(q).then(function (data) {
      if (seq !== state.listSeq) return;
      state.listLoading = false;
      var rows = (data && data.sessions) || [];
      rows.forEach(function (s) {
        if (s.busy) state.busy[s.id] = 'busy';
        else if (s.busy === false) delete state.busy[s.id];
      });
      state.sessions = append ? state.sessions.concat(rows) : rows;
      state.cursor = data && data.cursor ? data.cursor : null;
      state.hasMore = !!state.cursor;
      renderList();
    }).catch(function () {
      if (seq !== state.listSeq) return;
      state.listLoading = false;
      renderList(true);
    });
  }

  function dayBucket(ts) {
    if (!ts) return 'Older';
    var d = new Date(ts);
    var now = new Date();
    var start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    if (d.getTime() >= start) return 'Today';
    if (d.getTime() >= start - 86400000) return 'Yesterday';
    if (d.getTime() >= start - 6 * 86400000) return 'Previous 7 days';
    if (d.getTime() >= start - 29 * 86400000) return 'Previous 30 days';
    return 'Older';
  }

  function renderList(failed) {
    var list = dom.list;
    if (!list) return;
    var keep = list.scrollTop;
    list.innerHTML = '';
    if (state.listLoading && !state.sessions.length) {
      for (var i = 0; i < 6; i++) list.appendChild(el('div', 'sb-skel'));
      return;
    }
    if (failed && !state.sessions.length) {
      list.appendChild(el('div', 'sb-empty', 'Could not load sessions.'));
      list.appendChild(btn('btn small', 'Retry', function () { fetchList(false); }));
      return;
    }
    var locked = lockedEntries();
    if (locked.length) {
      list.appendChild(el('div', 'sb-group', 'Encrypted'));
      locked.forEach(function (e) { list.appendChild(lockRow(e)); });
    }
    if (!state.sessions.length) {
      if (!locked.length) list.appendChild(el('div', 'sb-empty', state.search ? 'No sessions match.' : 'No sessions yet.'));
      return;
    }
    var lastBucket = null;
    state.sessions.forEach(function (s) {
      var b = dayBucket(s.time && s.time.updated);
      if (b !== lastBucket) {
        list.appendChild(el('div', 'sb-group', b));
        lastBucket = b;
      }
      list.appendChild(sessionRow(s));
    });
    if (state.hasMore) {
      var more = btn('btn ghost small block', state.listLoading ? 'Loading\u2026' : 'Load more', function () { fetchList(true); });
      list.appendChild(more);
    }
    list.scrollTop = keep;
  }

  function sessionRow(s) {
    var st = sessionStatus(s.id);
    var row = el('a', 'sb-row status-' + st + (s.id === state.sessionID ? ' active' : ''));
    row.href = sessionHref(s);
    row.dataset.id = s.id;
    var ind = el('span', 'sb-ind');
    ind.title = st === 'running' ? 'Running' : st === 'error' ? 'Last run failed' : 'Idle';
    row.appendChild(ind);
    var body = el('span', 'sb-row-body');
    var titleLine = el('span', 'sb-title', s.title || s.slug || 'Untitled session');
    body.appendChild(titleLine);
    var meta = el('span', 'sb-meta');
    if (unlockedEntryFor(s.id)) meta.appendChild(el('span', 'sb-tag warn', 'decrypted'));
    else if (isPrivateTitle(s.title)) meta.appendChild(el('span', 'sb-tag', 'private'));
    meta.appendChild(el('span', 'sb-dir', shortDir(s.directory)));
    var t = A.relTime(s.time && s.time.updated);
    if (st === 'running') meta.appendChild(el('span', 'sb-state', 'running'));
    else if (st === 'error') meta.appendChild(el('span', 'sb-state err', 'error'));
    else if (t) meta.appendChild(el('span', 'sb-time', t));
    body.appendChild(meta);
    row.appendChild(body);
    row.addEventListener('click', closeDrawer);
    return row;
  }

  // ---------- encrypted chats ----------
  function isPrivateTitle(t) { return typeof t === 'string' && t.indexOf(PRIVATE_PREFIX) === 0; }
  function lockedEntries() {
    var q = (state.search || '').toLowerCase();
    return state.vault.entries.filter(function (e) {
      return e.state === 'locked' && (!q || String(e.label).toLowerCase().indexOf(q) !== -1);
    });
  }
  function unlockedEntryFor(sessionID) {
    if (!sessionID) return null;
    for (var i = 0; i < state.vault.entries.length; i++) {
      var e = state.vault.entries[i];
      if (e.state === 'unlocked' && e.sessionID === sessionID) return e;
    }
    return null;
  }
  function loadVault() {
    if (!state.vault.enabled) return Promise.resolve();
    return A.api('/api/vault').then(function (d) {
      state.vault.entries = (d && d.entries) || [];
      state.vault.loaded = true;
      renderList();
      refreshVaultControls();
    }).catch(function () {});
  }
  function lockRow(e) {
    var row = el('a', 'sb-row lock-row' + (state.route === 'lock' && state.lockID === e.id ? ' active' : ''));
    row.href = '#/lock/' + encodeURIComponent(e.id);
    row.dataset.lock = e.id;
    row.appendChild(icon('lock', 'sb-lock'));
    var body = el('span', 'sb-row-body');
    body.appendChild(el('span', 'sb-title', e.label));
    var meta = el('span', 'sb-meta');
    meta.appendChild(el('span', 'sb-dir', e.messageCount + (e.messageCount === 1 ? ' message' : ' messages')));
    var t = A.relTime(e.updatedAt);
    if (t) meta.appendChild(el('span', 'sb-time', 'locked ' + t));
    body.appendChild(meta);
    row.appendChild(body);
    row.addEventListener('click', closeDrawer);
    return row;
  }

  // Masked plain-text field (not type=password) so no browser password manager offers
  // to store it; the value never touches localStorage.
  function secretInput(id, placeholder) {
    var i = el('input', 'text-input masked');
    i.id = id;
    i.type = 'text';
    i.placeholder = placeholder;
    i.setAttribute('aria-label', placeholder);
    i.autocomplete = 'off';
    i.autocapitalize = 'off';
    i.spellcheck = false;
    i.setAttribute('autocorrect', 'off');
    i.setAttribute('data-form-type', 'other');
    i.setAttribute('data-1p-ignore', '');
    i.setAttribute('data-lpignore', 'true');
    i.setAttribute('data-bwignore', '');
    return i;
  }
  function limitsDetails() {
    var d = el('details', 'limits');
    d.appendChild(el('summary', null, 'What encryption does and does not protect'));
    d.appendChild(el('p', null, LIMITS_TEXT));
    return d;
  }
  function refreshVaultControls() {
    var b = document.getElementById('encrypt-btn');
    if (b) b.hidden = !(state.vault.enabled && state.session && !state.session.parentID);
    if (state.route === 'session') renderHeader();
  }

  function openEncrypt() {
    closeModal();
    var s = state.session || {};
    var existing = unlockedEntryFor(state.sessionID);
    var overlay = el('div', 'modal-overlay');
    var box = el('form', 'modal vault-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Encrypt this chat');
    var head = el('div', 'modal-head');
    var h = el('h3', 'modal-title');
    h.appendChild(icon('lock'));
    h.appendChild(document.createTextNode(' Encrypt this chat'));
    head.appendChild(h);
    head.appendChild(btn('icon-btn', '', closeModal, 'x'));
    box.appendChild(head);
    box.appendChild(el('p', 'modal-text', 'The whole history is encrypted with your password and removed from opencode on Sandy. ' +
      'It stays in the sidebar as a locked entry; Decrypt brings it back so you can continue.'));
    var lbl = el('input', 'text-input');
    lbl.id = 'vault-label';
    lbl.maxLength = 80;
    lbl.autocomplete = 'off';
    lbl.placeholder = existing ? existing.label : (isPrivateTitle(s.title) ? s.title : 'Label (optional; default: Encrypted chat \u00b7 date)');
    lbl.setAttribute('aria-label', 'Label shown while locked');
    box.appendChild(el('label', 'field-label', 'Label while locked (optional; the chat title is never shown)'));
    box.appendChild(lbl);
    var pw1 = secretInput('vault-pw1', 'Password (at least 8 characters)');
    var pw2 = secretInput('vault-pw2', 'Repeat password');
    box.appendChild(pw1);
    box.appendChild(pw2);
    box.appendChild(el('div', 'vault-warn', 'If you lose this password the chat is gone. There is no recovery.'));
    box.appendChild(limitsDetails());
    var err = el('div', 'form-error');
    err.hidden = true;
    box.appendChild(err);
    var actions = el('div', 'modal-btns');
    actions.appendChild(btn('btn', 'Cancel', closeModal));
    var go = el('button', 'btn primary');
    go.type = 'submit';
    go.id = 'vault-encrypt-go';
    go.appendChild(icon('lock'));
    go.appendChild(el('span', 'btn-label', 'Encrypt'));
    actions.appendChild(go);
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    pw1.focus();
    var sid = state.sessionID;
    var dir = state.directory || s.directory;
    box.addEventListener('submit', function (ev) {
      ev.preventDefault();
      err.hidden = true;
      if (pw1.value.length < 8) return fail('Use at least 8 characters.');
      if (pw1.value !== pw2.value) return fail('The two passwords do not match.');
      if (state.busy[sid]) return fail('The agent is still working. Stop it or wait until it is idle.');
      go.disabled = true;
      go.querySelector('.btn-label').textContent = 'Encrypting\u2026';
      var body = { sessionID: sid, directory: dir, password: pw1.value, label: lbl.value.trim() };
      pw1.value = ''; pw2.value = '';
      A.api('/api/vault/encrypt', { method: 'POST', body: body }).then(function (r) {
        body.password = null;
        closeModal();
        state.sessions = state.sessions.filter(function (x) { return x.id !== sid; });
        toast('Chat encrypted and removed from opencode');
        loadVault().then(function () { window.location.hash = '#/lock/' + encodeURIComponent(r.entry.id); });
      }).catch(function (e) {
        body.password = null;
        go.disabled = false;
        go.querySelector('.btn-label').textContent = 'Encrypt';
        fail(e.message || 'Encryption failed. Nothing was deleted.');
      });
    });
    function fail(m) { err.textContent = m; err.hidden = false; }
  }

  function lockView(id) {
    resetSession();
    state.route = 'lock';
    state.lockID = id;
    A.connectEvents(null);
    renderList();
    var main = dom.main;
    main.innerHTML = '';
    var e = null;
    state.vault.entries.forEach(function (x) { if (x.id === id) e = x; });
    var titleBox = el('div', 'tb-main');
    titleBox.appendChild(el('div', 'tb-title', e ? e.label : 'Encrypted chat'));
    titleBox.appendChild(el('div', 'tb-sub', 'encrypted'));
    main.appendChild(topbar(titleBox));
    var wrap = el('div', 'new-wrap');
    var card = el('form', 'lock-card');
    card.id = 'lock-form';
    var badge = el('div', 'lock-badge');
    badge.appendChild(icon('lock'));
    card.appendChild(badge);
    card.appendChild(el('h1', 'lock-title', e ? e.label : 'Encrypted chat'));
    if (!e) {
      var known = state.configLoaded && (!state.vault.enabled || state.vault.loaded);
      card.appendChild(el('p', 'hero-sub', !known ? 'Loading\u2026' : state.vault.enabled ? 'This encrypted chat no longer exists.' : 'Encryption is not available.'));
      wrap.appendChild(card);
      main.appendChild(wrap);
      return;
    }
    if (e.state !== 'locked') {
      card.appendChild(el('p', 'hero-sub', 'This chat is currently decrypted.'));
      var open = el('a', 'btn primary', 'Open the chat');
      open.href = '#/s/' + encodeURIComponent(e.sessionID);
      card.appendChild(open);
      wrap.appendChild(card);
      main.appendChild(wrap);
      return;
    }
    card.appendChild(el('p', 'hero-sub', e.messageCount + (e.messageCount === 1 ? ' message' : ' messages') +
      ' \u00b7 locked ' + (A.relTime(e.updatedAt) || '') + (e.private ? ' \u00b7 private' : '')));
    var pw = secretInput('lock-pw', 'Password');
    card.appendChild(pw);
    var err = el('div', 'form-error');
    err.id = 'lock-err';
    err.hidden = true;
    card.appendChild(err);
    var go = el('button', 'btn primary block');
    go.type = 'submit';
    go.id = 'decrypt-btn';
    go.appendChild(icon('unlock'));
    go.appendChild(el('span', 'btn-label', 'Decrypt'));
    card.appendChild(go);
    card.appendChild(limitsDetails());
    var del = btn('btn ghost small', 'Delete encrypted chat', function () {
      if (!window.confirm('Delete this encrypted chat for good? It cannot be recovered.')) return;
      A.api('/api/vault/' + encodeURIComponent(id), { method: 'DELETE', body: {} }).then(function () {
        toast('Encrypted chat deleted');
        loadVault().then(function () { window.location.hash = '#/new'; });
      }).catch(function (x) { toast(x.message || 'Delete failed', 'err'); });
    }, 'trash');
    del.classList.add('lock-delete');
    card.appendChild(del);
    wrap.appendChild(card);
    main.appendChild(wrap);
    if (!window.matchMedia('(pointer: coarse)').matches) pw.focus();
    card.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (!pw.value) { pw.focus(); return; }
      err.hidden = true;
      go.disabled = true;
      go.querySelector('.btn-label').textContent = 'Decrypting\u2026';
      var body = { password: pw.value };
      pw.value = '';
      A.api('/api/vault/' + encodeURIComponent(id) + '/decrypt', { method: 'POST', body: body }).then(function (r) {
        body.password = null;
        toast('Chat decrypted (' + r.verified.messages + ' messages)');
        loadVault();
        fetchList(false);
        window.location.hash = '#/s/' + encodeURIComponent(r.sessionID) + '?d=' + encodeURIComponent(r.directory);
      }).catch(function (x) {
        body.password = null;
        go.disabled = false;
        go.querySelector('.btn-label').textContent = 'Decrypt';
        err.textContent = x.message || 'Decryption failed.';
        err.hidden = false;
        pw.focus();
      });
    });
  }

  function upsertListSession(info) {
    if (!info || !info.id) return;
    if (state.hideProbes && info.directory && info.directory.indexOf('/tmp/') === 0) return;
    var idx = -1;
    state.sessions.forEach(function (s, i) { if (s.id === info.id) idx = i; });
    if (idx >= 0) {
      var merged = Object.assign({}, state.sessions[idx], info);
      state.sessions.splice(idx, 1);
      state.sessions.unshift(merged);
    } else {
      if (info.parentID) return; // child (sub-agent) sessions stay out of the list
      if (state.search) return;
      state.sessions.unshift(info);
    }
    state.sessions.sort(function (a, b) { return ((b.time && b.time.updated) || 0) - ((a.time && a.time.updated) || 0); });
    scheduleListRender();
  }

  var listTimer = null;
  function scheduleListRender() {
    if (listTimer) return;
    listTimer = setTimeout(function () { listTimer = null; renderList(); }, 150);
  }

  // ---------- models ----------
  function loadModels() {
    return A.api('/api/models').then(function (m) {
      state.models = m || { featured: [], more: [] };
      state.modelsLoaded = true;
      document.querySelectorAll('select.model-select').forEach(function (sel) { fillModelSelect(sel); });
    }).catch(function () {
      document.querySelectorAll('select.model-select').forEach(function (sel) {
        sel.innerHTML = '';
        sel.appendChild(el('option', null, 'Models unavailable'));
      });
    });
  }

  function modelLabel(m) {
    var free = /:free$/.test(m.modelID) || m.providerID === 'chutes';
    return m.modelName + ' \u00b7 ' + m.providerName + (free ? ' \u00b7 free' : '');
  }

  function fillModelSelect(sel) {
    var prefer = sel.dataset.prefer || '';
    sel.innerHTML = '';
    ['featured', 'more'].forEach(function (gn) {
      var models = state.models[gn] || [];
      if (!models.length) return;
      var og = el('optgroup');
      og.label = gn === 'featured' ? 'Recommended' : 'More models';
      models.forEach(function (m) {
        var o = el('option', null, modelLabel(m));
        o.value = modelKey(m);
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (prefer && !sel.querySelector('option[value="' + cssEsc(prefer) + '"]')) {
      var own = el('option', null, 'Session model \u2014 ' + prefer.split('/').slice(1).join('/'));
      own.value = prefer;
      sel.insertBefore(own, sel.firstChild);
    }
    var last = A.getLastModel();
    var want = prefer || (last ? modelKey(last) : '');
    if (want && sel.querySelector('option[value="' + cssEsc(want) + '"]')) sel.value = want;
    if (!sel.options.length) sel.appendChild(el('option', null, state.modelsLoaded ? 'No models' : 'Loading models\u2026'));
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  function modelSelect(prefer) {
    var sel = el('select', 'model-select pill');
    sel.setAttribute('aria-label', 'Model');
    if (prefer) sel.dataset.prefer = prefer;
    fillModelSelect(sel);
    return sel;
  }

  function selectedModel(sel) {
    var val = sel.value || '';
    var slash = val.indexOf('/');
    if (slash === -1) return null;
    return { providerID: val.slice(0, slash), modelID: val.slice(slash + 1) };
  }

  // ---------- composer (shared by new + session) ----------
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, Math.round(window.innerHeight * 0.4)) + 'px';
  }

  // Enter sends, Shift+Enter inserts a newline (IME composition is left alone).
  function wireComposer(ta, submit) {
    ta.addEventListener('input', function () { autosize(ta); });
    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault();
        submit();
      }
    });
  }

  // ---------- NEW SESSION VIEW ----------
  function recentDirs() {
    var r = readJSON('ocr-recent-dirs', []);
    var all = [];
    r.concat(state.suggestDirs).forEach(function (d) {
      if (d && all.indexOf(d) === -1 && d !== state.config.newSessionDirectory) all.push(d);
    });
    return all.slice(0, 6);
  }
  function rememberDir(d) {
    var r = readJSON('ocr-recent-dirs', []).filter(function (x) { return x !== d; });
    r.unshift(d);
    writeJSON('ocr-recent-dirs', r.slice(0, 10));
  }

  function newView() {
    state.route = 'new';
    resetSession();
    highlightActive();
    A.connectEvents(null);
    var main = dom.main;
    main.innerHTML = '';
    main.appendChild(topbar(el('div', 'tb-title', 'New session')));

    var wrap = el('div', 'new-wrap');
    var center = el('div', 'new-center');
    center.appendChild(el('h1', 'hero', 'What should we build?'));
    center.appendChild(el('p', 'hero-sub', 'Starts an opencode agent on Sandy. It keeps running when you close this tab.'));

    var form = el('form', 'composer-card big');
    form.id = 'new-form';
    var ta = el('textarea', 'composer-input');
    ta.id = 'prompt-input';
    ta.rows = 3;
    ta.placeholder = 'Describe the task\u2026';
    ta.setAttribute('aria-label', 'First prompt');
    form.appendChild(ta);

    var bar = el('div', 'composer-bar');
    var dirPill = btn('pill dir-pill', '', function () { dirInput.focus(); dirInput.select(); }, 'folder');
    dirPill.id = 'dir-pill';
    dirPill.title = 'Working directory';
    bar.appendChild(dirPill);
    var sel = modelSelect(null);
    sel.id = 'model-select';
    bar.appendChild(sel);
    bar.appendChild(el('span', 'spacer'));
    var send = el('button', 'send-btn');
    send.type = 'submit';
    send.setAttribute('aria-label', 'Start session');
    send.appendChild(icon('send'));
    bar.appendChild(send);
    form.appendChild(bar);
    center.appendChild(form);

    // directory section
    var dirBox = el('div', 'dir-box');
    var lbl = el('label', 'field-label', 'Working directory');
    lbl.setAttribute('for', 'dir-input');
    dirBox.appendChild(lbl);
    var dirRow = el('div', 'dir-row');
    var dirInput = el('input', 'text-input');
    dirInput.id = 'dir-input';
    dirInput.type = 'text';
    dirInput.placeholder = state.config.newSessionDirectory + ' (default)';
    dirInput.autocomplete = 'off';
    dirInput.autocapitalize = 'off';
    dirInput.spellcheck = false;
    dirInput.addEventListener('input', refreshDirHint);
    dirRow.appendChild(dirInput);
    dirRow.appendChild(btn('btn', 'Browse', function () { openBrowse(dirInput); }, 'folder'));
    dirBox.appendChild(dirRow);
    var chips = el('div', 'chips');
    chips.id = 'dir-chips';
    dirBox.appendChild(chips);
    var createRow = el('label', 'check-row');
    var cb = el('input');
    cb.type = 'checkbox';
    cb.id = 'create-dir';
    cb.checked = true;
    createRow.appendChild(cb);
    createRow.appendChild(el('span', null, 'Create the folder if it does not exist'));
    dirBox.appendChild(createRow);
    center.appendChild(dirBox);

    var privRow = el('label', 'check-row private-row');
    var priv = el('input');
    priv.type = 'checkbox';
    priv.id = 'private-chat';
    privRow.appendChild(priv);
    privRow.appendChild(icon('lock'));
    var privText = el('span');
    privText.appendChild(el('strong', null, 'Private chat'));
    privText.appendChild(document.createTextNode(' \u2014 no automatic title: the chat gets a neutral name and the title model never sees it. You can encrypt it any time.'));
    privRow.appendChild(privText);
    center.appendChild(privRow);

    var err = el('div', 'form-error');
    err.id = 'new-err';
    err.hidden = true;
    center.appendChild(err);
    center.appendChild(el('p', 'hint', 'Enter to start \u00b7 Shift+Enter for a new line'));

    wrap.appendChild(center);
    main.appendChild(wrap);

    function submit() { submitNew(form, ta, dirInput, sel, cb, send, err, priv); }
    wireComposer(ta, submit);
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    renderRecentDirs();
    refreshDirHint();
    if (!window.matchMedia('(pointer: coarse)').matches) ta.focus();
  }

  function effectiveDir() {
    var di = document.getElementById('dir-input');
    var v = di ? di.value.trim() : '';
    return v || state.config.newSessionDirectory;
  }

  function refreshDirHint() {
    var di = document.getElementById('dir-input');
    if (di) di.placeholder = state.config.newSessionDirectory + ' (default)';
    var pill = document.getElementById('dir-pill');
    if (!pill) return;
    var lbl = pill.querySelector('.btn-label');
    if (!lbl) { lbl = el('span', 'btn-label'); pill.appendChild(lbl); }
    var d = effectiveDir();
    lbl.textContent = d.replace(/\/+$/, '').split('/').pop() || d;
    pill.title = 'Working directory: ' + d;
    document.querySelectorAll('#dir-chips .chip').forEach(function (c) {
      c.classList.toggle('on', c.dataset.dir === d);
    });
  }

  function renderRecentDirs() {
    var chips = document.getElementById('dir-chips');
    if (!chips) return;
    chips.innerHTML = '';
    var di = document.getElementById('dir-input');
    function chip(d, label) {
      var c = btn('chip', label || shortDir(d), function () {
        if (di) di.value = d === state.config.newSessionDirectory ? '' : d;
        refreshDirHint();
      });
      c.dataset.dir = d;
      c.title = d;
      chips.appendChild(c);
    }
    chip(state.config.newSessionDirectory, shortDir(state.config.newSessionDirectory) + ' \u00b7 default');
    recentDirs().forEach(function (d) { chip(d); });
    refreshDirHint();
  }

  function submitNew(form, ta, dirInput, sel, cb, send, errBox, priv) {
    var prompt = ta.value.trim();
    var directory = dirInput.value.trim();
    var model = selectedModel(sel);
    errBox.hidden = true;
    if (!prompt) { ta.focus(); return; }
    if (!model) { showErr('Pick a model first.'); return; }
    if (form.dataset.busy) return;
    form.dataset.busy = '1';
    send.disabled = true;
    send.classList.add('loading');
    var body = { directory: directory, prompt: prompt, model: model, createDirectory: cb.checked, private: !!(priv && priv.checked) };
    A.saveLastModel(model);
    A.api('/api/sessions', { method: 'POST', body: body }).then(function (res) {
      var s = (res && res.session) || res;
      var dir = s.directory || directory || state.config.newSessionDirectory;
      rememberDir(dir);
      upsertListSession(Object.assign({}, s, { directory: dir }));
      state.busy[s.id] = 'busy';
      state.pendingPrompt = { sessionID: s.id, text: prompt };
      window.location.hash = '#/s/' + encodeURIComponent(s.id) + '?d=' + encodeURIComponent(dir);
    }).catch(function (e) {
      delete form.dataset.busy;
      send.disabled = false;
      send.classList.remove('loading');
      showErr(e.message || 'Could not start the session.');
    });
    function showErr(m) { errBox.textContent = m; errBox.hidden = false; }
  }

  // ---------- directory browser ----------
  function closeModal() {
    var m = document.querySelector('.modal-overlay');
    if (m) m.remove();
  }

  function openBrowse(target) {
    closeModal();
    var overlay = el('div', 'modal-overlay');
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });
    var box = el('div', 'modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', 'Choose a directory');
    var head = el('div', 'modal-head');
    head.appendChild(el('h3', 'modal-title', 'Choose a directory'));
    head.appendChild(btn('icon-btn', '', closeModal, 'x'));
    box.appendChild(head);
    var input = el('input', 'text-input mono');
    input.value = target.value.trim() || state.config.newSessionDirectory;
    input.autocapitalize = 'off';
    input.spellcheck = false;
    box.appendChild(input);
    var list = el('div', 'browse-list');
    box.appendChild(list);
    var actions = el('div', 'modal-btns');
    actions.appendChild(btn('btn', 'Cancel', closeModal));
    actions.appendChild(btn('btn primary', 'Use this folder', function () {
      target.value = input.value.trim().replace(/\/+$/, '') || '';
      closeModal();
      refreshDirHint();
    }));
    box.appendChild(actions);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    function load(path) {
      path = path.replace(/\/+$/, '') || '/';
      input.value = path;
      list.innerHTML = '';
      list.appendChild(el('div', 'browse-loading', 'Loading\u2026'));
      A.api('/api/directories?path=' + encodeURIComponent(path)).then(function (d) {
        list.innerHTML = '';
        var parent = path.replace(/\/[^/]+$/, '');
        if (parent && parent.length >= (state.config.allowedPrefix || '/home/flori/').replace(/\/$/, '').length) {
          var up = btn('browse-item up', '..', function () { load(parent); }, 'up');
          list.appendChild(up);
        }
        var dirs = (d && d.directories) || [];
        if (!dirs.length) list.appendChild(el('div', 'browse-empty', 'No subfolders'));
        dirs.forEach(function (dir) {
          var name = dir.split('/').pop();
          list.appendChild(btn('browse-item', name, function () { load(dir); }, 'folder'));
        });
      }).catch(function (err) {
        list.innerHTML = '';
        list.appendChild(el('div', 'browse-empty', err.message || 'Cannot list this folder'));
      });
    }
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); load(input.value.trim()); } });
    load(input.value);
  }

  // ---------- SESSION VIEW ----------
  function resetSession() {
    state.sessionID = null;
    state.directory = '';
    state.session = null;
    state.messages = [];
    state.permissions = [];
    state.questions = [];
    state.hasOlder = false;
    state.oldestID = null;
    state.atBottom = true;
    state.openParts = {};
    msgEls = {};
    partEls = {};
    pending = {};
  }

  function highlightActive() {
    if (!dom.list) return;
    dom.list.querySelectorAll('.sb-row').forEach(function (r) {
      r.classList.toggle('active', r.dataset.id === state.sessionID);
    });
  }

  function sessionView(id, dir) {
    var keepPending = state.pendingPrompt && state.pendingPrompt.sessionID === id ? state.pendingPrompt : null;
    resetSession();
    state.route = 'session';
    state.sessionID = id;
    state.directory = dir || '';
    state.pendingPrompt = keepPending;
    highlightActive();

    var main = dom.main;
    main.innerHTML = '';
    var titleBox = el('div', 'tb-main');
    titleBox.appendChild(el('div', 'tb-title', '\u2026'));
    titleBox.appendChild(el('div', 'tb-sub', shortDir(dir)));
    var badge = el('span', 'status-badge');
    badge.id = 'status-badge';
    var priv = el('span', 'status-badge private-badge');
    priv.id = 'private-badge';
    priv.hidden = true;
    var enc = btn('btn small encrypt-btn', 'Encrypt', openEncrypt, 'lock');
    enc.id = 'encrypt-btn';
    enc.title = 'Encrypt this chat with a password';
    enc.setAttribute('aria-label', 'Encrypt this chat');
    enc.hidden = true;
    var del = btn('icon-btn', '', deleteSession, 'trash');
    del.title = 'Delete session';
    del.setAttribute('aria-label', 'Delete session');
    var bar = topbar(titleBox, [priv, badge, enc, del]);
    bar.id = 'session-topbar';
    main.appendChild(bar);

    var tl = el('div', 'timeline');
    tl.id = 'timeline';
    var inner = el('div', 'tl-inner');
    inner.id = 'tl-inner';
    inner.appendChild(el('div', 'tl-loading', 'Loading session\u2026'));
    tl.appendChild(inner);
    tl.addEventListener('scroll', onScroll, { passive: true });
    main.appendChild(tl);

    var jump = btn('jump-btn', '', function () { scrollToBottom(true); }, 'down');
    jump.id = 'jump-btn';
    jump.setAttribute('aria-label', 'Scroll to latest');
    jump.hidden = true;
    main.appendChild(jump);

    main.appendChild(sessionComposer());
    A.connectEvents(id);
    fetchSession(true);
  }

  function fetchSession(first) {
    var id = state.sessionID;
    var q = '/api/sessions/' + encodeURIComponent(id);
    if (state.directory) q += '?directory=' + encodeURIComponent(state.directory);
    return A.api(q).then(function (d) {
      if (state.sessionID !== id) return;
      state.session = d.session || {};
      if (!state.directory && state.session.directory) state.directory = state.session.directory;
      state.messages = sortMessages(d.messages || []);
      state.hasOlder = state.messages.length >= 200;
      state.oldestID = state.hasOlder ? state.messages[0].info.id : null;
      if (d.status && d.status !== 'idle') state.busy[id] = d.status;
      else if (d.status === 'idle') delete state.busy[id];
      if (state.pendingPrompt && state.messages.some(function (m) { return m.info.role === 'user'; })) state.pendingPrompt = null;
      renderHeader();
      renderTimeline();
      if (first) {
        scrollToBottom(true);
        fetchPending();
        var sel = document.getElementById('composer-model');
        if (sel) { sel.dataset.prefer = currentModelKey(); fillModelSelect(sel); }
      }
      renderComposerState();
    }).catch(function (err) {
      if (state.sessionID !== id) return;
      // An old link to a chat that has since been encrypted: show its lock screen.
      var locked = state.vault.entries.filter(function (e) { return e.state === 'locked' && e.sessionID === id; })[0];
      if (locked && err.status === 404) { window.location.hash = '#/lock/' + encodeURIComponent(locked.id); return; }
      var inner = document.getElementById('tl-inner');
      if (!inner || state.messages.length) return;
      inner.innerHTML = '';
      var box = el('div', 'empty-state');
      box.appendChild(el('div', 'empty-title', 'Could not load this session'));
      box.appendChild(el('div', 'empty-sub', err.message || ''));
      var a = el('a', 'btn', 'Start a new session');
      a.href = '#/new';
      box.appendChild(a);
      inner.appendChild(box);
    });
  }

  function currentModelKey() {
    // Prefer the model of the latest assistant message, then the session's.
    for (var i = state.messages.length - 1; i >= 0; i--) {
      var inf = state.messages[i].info;
      if (inf.role === 'assistant' && inf.providerID && inf.modelID) return inf.providerID + '/' + inf.modelID;
      if (inf.role === 'user' && inf.model && inf.model.providerID) return inf.model.providerID + '/' + inf.model.modelID;
    }
    var s = state.session;
    return sessionModelID(s) ? s.model.providerID + '/' + sessionModelID(s) : '';
  }

  function sortMessages(arr) {
    return arr.slice().sort(function (a, b) {
      var ta = (a.info.time && a.info.time.created) || 0;
      var tb = (b.info.time && b.info.time.created) || 0;
      return ta - tb || (a.info.id < b.info.id ? -1 : 1);
    });
  }

  function fetchPending() {
    var dir = state.directory;
    if (!dir) return;
    var id = state.sessionID;
    A.api('/api/permissions?directory=' + encodeURIComponent(dir)).then(function (d) {
      if (state.sessionID !== id) return;
      state.permissions = ((d && d.permissions) || []).filter(function (p) { return p.sessionID === id; });
      renderLive();
    }).catch(function () {});
    A.api('/api/questions?directory=' + encodeURIComponent(dir)).then(function (d) {
      if (state.sessionID !== id) return;
      state.questions = ((d && d.questions) || []).filter(function (q) { return q.sessionID === id; });
      renderLive();
    }).catch(function () {});
  }

  function deleteSession() {
    var s = state.session || {};
    if (!window.confirm('Delete this session? This cannot be undone.')) return;
    A.api('/api/sessions/' + encodeURIComponent(state.sessionID), {
      method: 'DELETE', body: { directory: state.directory || s.directory }
    }).then(function () {
      var id = state.sessionID;
      state.sessions = state.sessions.filter(function (x) { return x.id !== id; });
      renderList();
      toast('Session deleted');
      window.location.hash = '#/new';
    }).catch(function (e) { toast(e.message || 'Delete failed', 'err'); });
  }

  function renderHeader() {
    var s = state.session || {};
    var bar = document.getElementById('session-topbar');
    if (!bar) return;
    bar.querySelector('.tb-title').textContent = s.title || s.slug || 'Session';
    var sub = [shortDir(s.directory || state.directory)];
    var mk = currentModelKey();
    if (mk) sub.push(mk.split('/').slice(1).join('/').split('/').pop());
    var cost = A.fmtCost(s.cost);
    if (cost) sub.push(cost);
    bar.querySelector('.tb-sub').textContent = sub.join(' \u00b7 ');
    var st = sessionStatus(state.sessionID);
    var badge = document.getElementById('status-badge');
    badge.className = 'status-badge ' + st;
    badge.textContent = st === 'running' ? (state.busy[state.sessionID] === 'retry' ? 'Retrying' : 'Running') : st === 'error' ? 'Error' : 'Idle';
    var pb = document.getElementById('private-badge');
    if (pb) {
      var unl = unlockedEntryFor(state.sessionID);
      pb.hidden = !(unl || isPrivateTitle(s.title));
      pb.className = 'status-badge private-badge' + (unl ? ' warn' : '');
      pb.textContent = unl ? '\ud83d\udd13 Decrypted' : '\ud83d\udd12 Private';
      pb.title = unl ? 'Decrypted from an encrypted chat: plaintext on disk until you encrypt it again' : 'Private chat: no automatic title';
    }
    var eb = document.getElementById('encrypt-btn');
    if (eb) eb.hidden = !(state.vault.enabled && !s.parentID && s.id);
    document.title = (s.title || 'Session') + ' \u2014 opencode remote';
  }

  // ---------- composer ----------
  function sessionComposer() {
    var dock = el('div', 'composer-dock');
    var form = el('form', 'composer-card');
    form.id = 'composer-form';
    var ta = el('textarea', 'composer-input');
    ta.id = 'composer-input';
    ta.rows = 1;
    ta.placeholder = 'Message the agent\u2026';
    ta.setAttribute('aria-label', 'Message');
    form.appendChild(ta);
    var bar = el('div', 'composer-bar');
    var sel = modelSelect(null);
    sel.id = 'composer-model';
    bar.appendChild(sel);
    bar.appendChild(el('span', 'spacer'));
    var stop = el('button', 'stop-btn');
    stop.type = 'button';
    stop.id = 'stop-btn';
    stop.hidden = true;
    stop.setAttribute('aria-label', 'Stop');
    stop.title = 'Stop the agent';
    stop.appendChild(icon('stop'));
    stop.appendChild(el('span', 'btn-label', 'Stop'));
    stop.addEventListener('click', abortSession);
    bar.appendChild(stop);
    var send = el('button', 'send-btn');
    send.type = 'submit';
    send.id = 'send-btn';
    send.setAttribute('aria-label', 'Send');
    send.appendChild(icon('send'));
    bar.appendChild(send);
    form.appendChild(bar);
    dock.appendChild(form);
    dock.appendChild(el('div', 'hint dock-hint', 'Enter to send \u00b7 Shift+Enter for a new line'));

    function submit() {
      var text = ta.value.trim();
      if (!text || form.dataset.busy) return;
      var model = selectedModel(sel);
      if (!model) { toast('Pick a model first', 'err'); return; }
      form.dataset.busy = '1';
      send.disabled = true;
      A.api('/api/sessions/' + encodeURIComponent(state.sessionID) + '/prompt', {
        method: 'POST', body: { directory: state.directory, text: text, model: model }
      }).then(function () {
        A.saveLastModel(model);
        ta.value = '';
        autosize(ta);
        state.busy[state.sessionID] = 'busy';
        setError(state.sessionID, null);
        renderHeader();
        renderComposerState();
        renderLive();
        scrollToBottom(true);
      }).catch(function (e) {
        toast(e.message || 'Send failed', 'err');
      }).finally(function () {
        delete form.dataset.busy;
        send.disabled = false;
      });
    }
    wireComposer(ta, submit);
    form.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
    return dock;
  }

  function abortSession() {
    var b = document.getElementById('stop-btn');
    if (b) b.disabled = true;
    A.api('/api/sessions/' + encodeURIComponent(state.sessionID) + '/abort', {
      method: 'POST', body: { directory: state.directory }
    }).then(function () {
      toast('Stopping\u2026');
    }).catch(function (e) {
      toast(e.message || 'Stop failed', 'err');
    }).finally(function () { if (b) b.disabled = false; });
  }

  function renderComposerState() {
    var running = !!state.busy[state.sessionID];
    var stop = document.getElementById('stop-btn');
    if (stop) stop.hidden = !running;
    var ta = document.getElementById('composer-input');
    if (ta) ta.placeholder = running ? 'Queue a follow-up\u2026' : 'Message the agent\u2026';
  }

  // ---------- timeline ----------
  function onScroll() {
    var tl = document.getElementById('timeline');
    if (!tl) return;
    state.atBottom = (tl.scrollHeight - tl.scrollTop - tl.clientHeight) < 80;
    var j = document.getElementById('jump-btn');
    if (j) j.hidden = state.atBottom;
  }

  function scrollToBottom(force) {
    var tl = document.getElementById('timeline');
    if (!tl) return;
    if (force || state.atBottom) {
      tl.scrollTop = tl.scrollHeight;
      state.atBottom = true;
      var j = document.getElementById('jump-btn');
      if (j) j.hidden = true;
    }
  }

  function renderTimeline() {
    var inner = document.getElementById('tl-inner');
    if (!inner) return;
    var tl = document.getElementById('timeline');
    var wasBottom = state.atBottom;
    var keep = tl.scrollTop;
    inner.innerHTML = '';
    msgEls = {};
    partEls = {};
    if (state.hasOlder) {
      var older = btn('btn ghost small load-older', 'Load earlier messages', loadOlder);
      inner.appendChild(older);
    }
    var visible = 0;
    state.messages.forEach(function (m) {
      var n = messageDOM(m);
      inner.appendChild(n);
      visible++;
    });
    if (!visible && !state.pendingPrompt && !state.busy[state.sessionID]) {
      var e = el('div', 'empty-state');
      e.appendChild(el('div', 'empty-title', 'No messages yet'));
      e.appendChild(el('div', 'empty-sub', 'Send a message below to start.'));
      inner.appendChild(e);
    }
    var live = el('div', 'tl-live');
    live.id = 'tl-live';
    inner.appendChild(live);
    renderLive();
    if (wasBottom) scrollToBottom(true);
    else tl.scrollTop = keep;
  }

  function loadOlder() {
    if (state.loadingOlder || !state.oldestID) return;
    state.loadingOlder = true;
    var id = state.sessionID;
    var q = '/api/sessions/' + encodeURIComponent(id) + '?directory=' + encodeURIComponent(state.directory) +
      '&before=' + encodeURIComponent(state.oldestID) + '&limit=200';
    A.api(q).then(function (d) {
      state.loadingOlder = false;
      if (state.sessionID !== id) return;
      var older = sortMessages(d.messages || []);
      var tl = document.getElementById('timeline');
      var fromBottom = tl.scrollHeight - tl.scrollTop;
      state.messages = older.concat(state.messages);
      state.hasOlder = older.length >= 200;
      state.oldestID = state.hasOlder ? older[0].info.id : null;
      state.atBottom = false;
      renderTimeline();
      tl.scrollTop = tl.scrollHeight - fromBottom;
    }).catch(function () { state.loadingOlder = false; });
  }

  function messageDOM(m) {
    var info = m.info || {};
    var role = info.role === 'user' ? 'user' : 'assistant';
    // Intermediate steps (the model stopped to call tools) read as one answer.
    var wrap = el('div', 'msg ' + role + (info.finish === 'tool-calls' ? ' step' : ''));
    wrap.dataset.id = info.id;
    var body = el('div', role === 'user' ? 'bubble' : 'msg-body');
    wrap.appendChild(body);
    (m.parts || []).forEach(function (p) {
      var n = partDOM(p, role);
      if (n) { partEls[p.id] = n; body.appendChild(n); }
    });
    if (info.error) wrap.appendChild(errorDOM(info.error));
    wrap.appendChild(msgFoot(m));
    msgEls[info.id] = wrap;
    return wrap;
  }

  function msgFoot(m) {
    var info = m.info || {};
    var foot = el('div', 'msg-foot');
    if (info.role === 'assistant') {
      if (info.modelID) foot.appendChild(el('span', 'mf-model', String(info.modelID).split('/').pop()));
      var cost = A.fmtCost(info.cost);
      if (cost) foot.appendChild(el('span', null, cost));
      if (info.time && info.time.completed && info.time.created) {
        foot.appendChild(el('span', null, fmtDur(info.time.completed - info.time.created)));
      }
    }
    var t = info.time && info.time.created;
    if (t) {
      var ts = el('span', 'mf-time', A.relTime(t));
      ts.title = new Date(t).toLocaleString();
      foot.appendChild(ts);
    }
    var hasText = (m.parts || []).some(function (p) { return p.type === 'text' && p.text && !p.synthetic; });
    if (hasText) {
      var c = btn('mini-btn', 'Copy', null, 'copy');
      c.addEventListener('click', function () {
        var txt = (m.parts || []).filter(function (p) { return p.type === 'text' && !p.synthetic; })
          .map(function (p) { return p.text; }).join('\n\n');
        copyText(txt, c);
      });
      foot.appendChild(c);
    }
    return foot;
  }

  function refreshFoot(m) {
    var w = msgEls[m.info.id];
    if (!w) return;
    var old = w.querySelector(':scope > .msg-foot');
    var nf = msgFoot(m);
    if (old) w.replaceChild(nf, old); else w.appendChild(nf);
    var oldErr = w.querySelector(':scope > .err-card');
    if (oldErr) oldErr.remove();
    var oldStop = w.querySelector(':scope > .stopped-note');
    if (oldStop) oldStop.remove();
    if (m.info.error) w.insertBefore(errorDOM(m.info.error), nf);
    w.classList.toggle('step', m.info.finish === 'tool-calls');
  }

  function fmtDur(ms) {
    if (!(ms > 0)) return '';
    if (ms < 1000) return ms + 'ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
    return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
  }

  function errorDOM(e) {
    if (isAbort(e)) return el('div', 'stopped-note', 'Stopped');
    return errorCard(errText(e));
  }

  function errorCard(text) {
    var c = el('div', 'err-card');
    c.appendChild(icon('alert'));
    c.appendChild(el('div', 'err-text', text));
    return c;
  }

  // ---------- parts ----------
  function partDOM(p, role) {
    if (role === 'user') {
      if (p.type === 'text') {
        if (p.synthetic) return null;
        return el('div', 'part user-text', p.text || '');
      }
      if (p.type === 'file') return fileChip(p);
      return null;
    }
    switch (p.type) {
      case 'text': return textPart(p);
      case 'reasoning': return reasoningPart(p);
      case 'tool': return toolPart(p);
      case 'patch': return patchPart(p);
      case 'file': return fileChip(p);
      case 'agent': return labelPart('Agent: ' + (p.name || p.agent || ''));
      case 'subtask': return labelPart('Subtask: ' + (p.description || p.prompt || '').slice(0, 120));
      case 'compaction': return labelPart('Conversation compacted');
      case 'retry': return labelPart('Retrying' + (p.attempt ? ' (attempt ' + p.attempt + ')' : ''));
      case 'step-start':
      case 'step-finish':
      case 'snapshot':
        return null;
      default: return null;
    }
  }

  function textPart(p) {
    var d = el('div', 'part md');
    d.innerHTML = window.Markdown.render(p.text || '');
    return d;
  }

  function reasoningPart(p) {
    var running = !(p.time && p.time.end);
    var d = el('details', 'part fold thinking' + (running ? ' running' : ''));
    d.open = !!state.openParts[p.id];
    d.addEventListener('toggle', function () { state.openParts[p.id] = d.open; });
    var sum = el('summary');
    sum.appendChild(icon('chevron', 'chev'));
    sum.appendChild(el('span', 'fold-name', running ? 'Thinking\u2026' : 'Thought'));
    if (!running && p.time && p.time.start) sum.appendChild(el('span', 'fold-dim', fmtDur(p.time.end - p.time.start)));
    d.appendChild(sum);
    var b = el('div', 'fold-body md');
    b.innerHTML = window.Markdown.render(p.text || '');
    d.appendChild(b);
    return d;
  }

  var TOOL_ICONS = {
    bash: 'terminal', read: 'file', write: 'edit', edit: 'edit', patch: 'edit', apply_patch: 'edit', multiedit: 'edit',
    grep: 'search', glob: 'search', list: 'folder', ls: 'folder', webfetch: 'globe', websearch: 'globe',
    todowrite: 'list', todoread: 'list', task: 'bot', question: 'help'
  };

  function relPath(p) {
    if (!p) return '';
    var d = state.directory || '';
    if (d && p.indexOf(d + '/') === 0) return p.slice(d.length + 1);
    return shortDir(p);
  }

  function toolSummary(p) {
    var st = p.state || {};
    var inp = st.input || {};
    switch (p.tool) {
      case 'bash': return String(inp.command || st.title || '').split('\n')[0];
      case 'read': case 'write': case 'edit': case 'multiedit': return relPath(inp.filePath || inp.path || '') || st.title || '';
      case 'grep': return (inp.pattern || '') + (inp.path ? '  in ' + relPath(inp.path) : '');
      case 'glob': return inp.pattern || '';
      case 'list': case 'ls': return relPath(inp.path || '') || '.';
      case 'webfetch': return inp.url || '';
      case 'task': return inp.description || st.title || '';
      case 'todowrite': return Array.isArray(inp.todos) ? inp.todos.length + ' items' : '';
      default: return st.title || '';
    }
  }

  function toolPart(p) {
    var st = p.state || {};
    var status = st.status || 'pending';
    var d = el('details', 'part fold tool st-' + status);
    d.open = !!state.openParts[p.id];
    d.addEventListener('toggle', function () {
      state.openParts[p.id] = d.open;
      if (d.open && !d.dataset.filled) fillTool(d, p);
    });
    var sum = el('summary');
    sum.appendChild(icon('chevron', 'chev'));
    sum.appendChild(icon(TOOL_ICONS[p.tool] || 'tool', 'tool-ic'));
    sum.appendChild(el('span', 'fold-name', p.tool || 'tool'));
    sum.appendChild(el('span', 'fold-arg', toolSummary(p)));
    var md = st.metadata || {};
    var fd = md.filediff;
    if (fd && (fd.additions || fd.deletions)) {
      var stat = el('span', 'diffstat');
      stat.appendChild(el('span', 'add', '+' + (fd.additions || 0)));
      stat.appendChild(el('span', 'del', '\u2212' + (fd.deletions || 0)));
      sum.appendChild(stat);
    }
    var tail = el('span', 'fold-status');
    if (status === 'running' || status === 'pending') tail.appendChild(el('span', 'spinner'));
    else if (status === 'completed') {
      tail.appendChild(icon('check', 'ok'));
      if (st.time && st.time.end) tail.appendChild(el('span', 'fold-dim', fmtDur(st.time.end - st.time.start)));
    } else if (status === 'error') tail.appendChild(icon('alert', 'bad'));
    sum.appendChild(tail);
    d.appendChild(sum);
    if (d.open) fillTool(d, p);
    return d;
  }

  // Tool bodies are built lazily on first expand: outputs can be large.
  function fillTool(d, p) {
    d.dataset.filled = '1';
    var st = p.state || {};
    var md = st.metadata || {};
    var inp = st.input || {};
    var body = el('div', 'fold-body tool-body');
    if (st.status === 'error' && st.error) body.appendChild(errorCard(String(st.error)));
    var diff = typeof md.diff === 'string' && md.diff ? md.diff : null;
    if (diff) {
      var dv = el('div', 'diff-view');
      dv.innerHTML = window.Markdown.renderDiff(clip(diff, 60000));
      body.appendChild(dv);
    } else if (p.tool === 'bash') {
      body.appendChild(preBlock('$ ' + (inp.command || ''), 'cmd'));
      var outText = typeof md.output === 'string' ? md.output : st.output;
      if (outText) body.appendChild(preBlock(clip(String(outText), 30000)));
    } else if (p.tool === 'todowrite' && Array.isArray(inp.todos)) {
      var ul = el('ul', 'todo-list');
      inp.todos.forEach(function (t) {
        var li = el('li', 'todo ' + (t.status || ''), t.content || '');
        ul.appendChild(li);
      });
      body.appendChild(ul);
    } else if (p.tool === 'write' && typeof inp.content === 'string') {
      body.appendChild(preBlock(clip(inp.content, 30000)));
    } else if (p.tool === 'read' && st.output) {
      body.appendChild(preBlock(clip(String(st.output), 30000)));
    } else {
      if (inp && Object.keys(inp).length) body.appendChild(preBlock(clip(JSON.stringify(inp, null, 2), 20000), 'input'));
      if (st.output) body.appendChild(preBlock(clip(String(st.output), 30000)));
    }
    if (!body.childNodes.length) body.appendChild(el('div', 'fold-dim', st.status === 'running' ? 'Running\u2026' : 'No output'));
    var old = d.querySelector('.tool-body');
    if (old) old.remove();
    d.appendChild(body);
  }

  function clip(s, n) { return s.length > n ? s.slice(0, n) + '\n\u2026 (' + (s.length - n) + ' more characters)' : s; }

  function preBlock(text, cls) {
    var wrap = el('div', 'codeblock' + (cls ? ' ' + cls : ''));
    var pre = el('pre', 'code');
    pre.textContent = text;
    var cb = btn('copy-btn floating', 'Copy');
    cb.addEventListener('click', function () { copyText(text.replace(/^\$ /, ''), cb); });
    wrap.appendChild(cb);
    wrap.appendChild(pre);
    return wrap;
  }

  function patchPart(p) {
    var files = p.files || [];
    var d = el('details', 'part fold patch');
    d.open = !!state.openParts[p.id];
    d.addEventListener('toggle', function () { state.openParts[p.id] = d.open; });
    var sum = el('summary');
    sum.appendChild(icon('chevron', 'chev'));
    sum.appendChild(icon('edit', 'tool-ic'));
    sum.appendChild(el('span', 'fold-name', 'Changed ' + files.length + ' file' + (files.length === 1 ? '' : 's')));
    d.appendChild(sum);
    var b = el('div', 'fold-body');
    files.forEach(function (f) { b.appendChild(el('div', 'patch-file mono', relPath(f))); });
    d.appendChild(b);
    return d;
  }

  function fileChip(p) {
    var c = el('div', 'part file-chip');
    c.appendChild(icon('file'));
    c.appendChild(el('span', null, p.filename || relPath(p.url && p.url.replace(/^file:\/\//, '')) || 'file'));
    return c;
  }

  function labelPart(text) { return el('div', 'part label-part', text); }

  // ---------- live area: permissions, questions, working indicator ----------
  function renderLive() {
    var live = document.getElementById('tl-live');
    if (!live) return;
    live.innerHTML = '';
    if (state.pendingPrompt && state.pendingPrompt.sessionID === state.sessionID &&
        !state.messages.some(function (m) { return m.info.role === 'user'; })) {
      var u = el('div', 'msg user pending');
      var bub = el('div', 'bubble');
      bub.appendChild(el('div', 'part user-text', state.pendingPrompt.text));
      u.appendChild(bub);
      live.appendChild(u);
    }
    state.permissions.forEach(function (p) { live.appendChild(permissionCard(p)); });
    state.questions.forEach(function (q) { live.appendChild(questionCard(q)); });
    var running = !!state.busy[state.sessionID];
    if (running && !state.permissions.length && !state.questions.length) {
      var w = el('div', 'working');
      var dots = el('span', 'dots');
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      dots.appendChild(el('i'));
      w.appendChild(dots);
      w.appendChild(el('span', null, state.busy[state.sessionID] === 'retry' ? 'Retrying\u2026' : 'Working\u2026'));
      live.appendChild(w);
    }
    if (!running && state.errors[state.sessionID]) {
      live.appendChild(errorCard('Last run failed: ' + state.errors[state.sessionID]));
    }
    scrollToBottom(false);
  }

  function permissionCard(p) {
    var c = el('div', 'card perm-card');
    var h = el('div', 'card-head');
    h.appendChild(icon('alert'));
    h.appendChild(el('span', null, 'Permission needed'));
    c.appendChild(h);
    var md = p.metadata || {};
    var what = el('div', 'card-body');
    what.appendChild(el('span', 'perm-kind', p.permission || 'action'));
    var desc = md.description || md.title || (p.permission === 'bash' && md.command) || '';
    if (desc) what.appendChild(el('div', 'perm-desc', String(desc)));
    var pats = (p.patterns || []).filter(Boolean);
    if (pats.length) {
      var pre = el('pre', 'code perm-pat');
      pre.textContent = pats.join('\n');
      what.appendChild(pre);
    }
    c.appendChild(what);
    var acts = el('div', 'card-actions');
    function reply(r) {
      acts.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
      A.api('/api/permissions/' + encodeURIComponent(p.id) + '/reply', {
        method: 'POST', body: { directory: state.directory, reply: r }
      }).then(function () {
        state.permissions = state.permissions.filter(function (x) { return x.id !== p.id; });
        renderLive();
      }).catch(function (e) {
        toast(e.message || 'Reply failed', 'err');
        acts.querySelectorAll('button').forEach(function (b) { b.disabled = false; });
      });
    }
    acts.appendChild(btn('btn primary', 'Allow once', function () { reply('once'); }));
    acts.appendChild(btn('btn', 'Always allow', function () { reply('always'); }));
    acts.appendChild(btn('btn danger', 'Deny', function () { reply('reject'); }));
    c.appendChild(acts);
    return c;
  }

  function questionCard(q) {
    var c = el('div', 'card question-card');
    var h = el('div', 'card-head');
    h.appendChild(icon('help'));
    h.appendChild(el('span', null, 'The agent has a question'));
    c.appendChild(h);
    var picks = [];
    var customs = [];
    (q.questions || []).forEach(function (qi, idx) {
      picks[idx] = [];
      var blk = el('div', 'card-body q-block');
      if (qi.header) blk.appendChild(el('div', 'q-header', qi.header));
      blk.appendChild(el('div', 'q-text', qi.question || ''));
      var opts = el('div', 'q-opts');
      (qi.options || []).forEach(function (o) {
        var ob = btn('q-opt', o.label, function () {
          var i = picks[idx].indexOf(o.label);
          if (qi.multiple) {
            if (i === -1) picks[idx].push(o.label); else picks[idx].splice(i, 1);
          } else {
            picks[idx] = i === -1 ? [o.label] : [];
          }
          opts.querySelectorAll('.q-opt').forEach(function (x) {
            x.classList.toggle('on', picks[idx].indexOf(x.dataset.label) !== -1);
          });
        });
        ob.dataset.label = o.label;
        if (o.description) ob.title = o.description;
        if (o.description) ob.appendChild(el('span', 'q-desc', o.description));
        opts.appendChild(ob);
      });
      blk.appendChild(opts);
      if (qi.custom !== false) {
        var ci = el('input', 'text-input q-custom');
        ci.placeholder = 'Or type your own answer';
        customs[idx] = ci;
        blk.appendChild(ci);
      }
      c.appendChild(blk);
    });
    var acts = el('div', 'card-actions');
    function done() {
      state.questions = state.questions.filter(function (x) { return x.id !== q.id; });
      renderLive();
    }
    acts.appendChild(btn('btn primary', 'Send answer', function () {
      var answers = picks.map(function (p, i) {
        var a = p.slice();
        var cv = customs[i] && customs[i].value.trim();
        if (cv) a.push(cv);
        return a;
      });
      A.api('/api/questions/' + encodeURIComponent(q.id) + '/reply', {
        method: 'POST', body: { directory: state.directory, answers: answers }
      }).then(done).catch(function (e) { toast(e.message || 'Reply failed', 'err'); });
    }));
    acts.appendChild(btn('btn', 'Dismiss', function () {
      A.api('/api/questions/' + encodeURIComponent(q.id) + '/reject', {
        method: 'POST', body: { directory: state.directory }
      }).then(done).catch(function (e) { toast(e.message || 'Dismiss failed', 'err'); });
    }));
    c.appendChild(acts);
    return c;
  }

  // ---------- incremental updates ----------
  function findMessage(id) {
    for (var i = 0; i < state.messages.length; i++) if (state.messages[i].info.id === id) return state.messages[i];
    return null;
  }

  function upsertMessageInfo(info) {
    if (!info || !info.id) return;
    var m = findMessage(info.id);
    if (m) {
      m.info = Object.assign({}, m.info, info);
      refreshFoot(m);
      if (info.role === 'assistant' && info.error && !isAbort(info.error)) setError(state.sessionID, errText(info.error));
      return;
    }
    m = { info: info, parts: [] };
    state.messages.push(m);
    if (info.role === 'user' && state.pendingPrompt) state.pendingPrompt = null;
    var last = state.messages.length > 1 ? state.messages[state.messages.length - 2] : null;
    var inOrder = !last || ((last.info.time && last.info.time.created) || 0) <= ((info.time && info.time.created) || 0);
    if (!inOrder) {
      state.messages = sortMessages(state.messages);
      renderTimeline();
      return;
    }
    var inner = document.getElementById('tl-inner');
    var live = document.getElementById('tl-live');
    if (!inner || !live) return;
    var empty = inner.querySelector('.empty-state');
    if (empty) empty.remove();
    inner.insertBefore(messageDOM(m), live);
    renderLive();
    scrollToBottom(false);
  }

  function upsertPart(part) {
    if (!part || !part.messageID) return;
    var m = findMessage(part.messageID);
    if (!m) return;
    var existing = null;
    for (var i = 0; i < m.parts.length; i++) if (m.parts[i].id === part.id) existing = m.parts[i];
    if (existing) Object.assign(existing, part);
    else m.parts.push(part);
    queuePart(part.id);
  }

  function applyDelta(props) {
    var m = findMessage(props.messageID);
    if (!m || !props.field) return;
    var p = null;
    for (var i = 0; i < m.parts.length; i++) if (m.parts[i].id === props.partID) p = m.parts[i];
    if (!p) return;
    p[props.field] = (p[props.field] || '') + (props.delta || '');
    queuePart(p.id);
  }

  function removePart(partID, messageID) {
    var m = findMessage(messageID);
    if (!m) return;
    m.parts = m.parts.filter(function (p) { return p.id !== partID; });
    if (partEls[partID]) { partEls[partID].remove(); delete partEls[partID]; }
  }

  function removeMessage(messageID) {
    state.messages = state.messages.filter(function (m) { return m.info.id !== messageID; });
    if (msgEls[messageID]) { msgEls[messageID].remove(); delete msgEls[messageID]; }
  }

  // Coalesce bursts of deltas into one DOM update per part per animation frame.
  function queuePart(id) {
    pending[id] = true;
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(flushParts);
  }

  function flushParts() {
    rafPending = false;
    var ids = Object.keys(pending);
    pending = {};
    var wasBottom = state.atBottom;
    ids.forEach(function (id) {
      var found = null, msg = null;
      state.messages.forEach(function (m) {
        m.parts.forEach(function (p) { if (p.id === id) { found = p; msg = m; } });
      });
      if (!found) return;
      var role = msg.info.role === 'user' ? 'user' : 'assistant';
      var n = partDOM(found, role);
      var old = partEls[id];
      if (old && old.parentNode) {
        if (n) old.parentNode.replaceChild(n, old); else old.remove();
      } else if (n) {
        var w = msgEls[msg.info.id];
        if (!w) return;
        var body = w.querySelector(role === 'user' ? '.bubble' : '.msg-body');
        body.appendChild(n);
      }
      if (n) partEls[id] = n; else delete partEls[id];
      var w2 = msgEls[msg.info.id];
      if (w2 && !w2.querySelector(':scope > .msg-foot .mini-btn') && found.type === 'text') refreshFoot(msg);
    });
    if (wasBottom) scrollToBottom(true);
  }

  // ---------- events ----------
  function handleEvent(ev) {
    var payload = (ev && ev.payload) || ev || {};
    var props = payload.properties || {};
    var type = payload.type;
    var sID = props.sessionID || (props.info && props.info.sessionID) || (props.part && props.part.sessionID) || null;
    var listID = type && type.indexOf('session.') === 0 ? (props.info ? props.info.id : props.sessionID) : null;

    // sidebar
    if (type === 'session.updated' || type === 'session.created') {
      upsertListSession(props.info);
    } else if (type === 'session.deleted') {
      var did = props.info ? props.info.id : props.sessionID;
      state.sessions = state.sessions.filter(function (s) { return s.id !== did; });
      scheduleListRender();
    } else if (type === 'session.status' && listID) {
      var stt = props.status ? props.status.type : 'idle';
      if (stt === 'idle') delete state.busy[listID];
      else { state.busy[listID] = stt; setError(listID, null); }
      scheduleListRender();
    } else if (type === 'session.idle' && listID) {
      delete state.busy[listID];
      scheduleListRender();
    } else if (type === 'session.error' && props.sessionID && !isAbort(props.error)) {
      setError(props.sessionID, errText(props.error) || 'error');
      scheduleListRender();
    }

    // open session
    var inSession = state.sessionID && (sID === state.sessionID || listID === state.sessionID);
    if (!inSession) return;
    switch (type) {
      case 'message.updated': upsertMessageInfo(props.info); break;
      case 'message.part.updated': upsertPart(props.part); break;
      case 'message.part.delta': applyDelta(props); break;
      case 'message.part.removed': removePart(props.partID, props.messageID); break;
      case 'message.removed': removeMessage(props.messageID); break;
      case 'session.updated':
        if (props.info && props.info.id === state.sessionID) { state.session = Object.assign({}, state.session, props.info); renderHeader(); }
        break;
      case 'session.status':
      case 'session.idle':
        renderHeader();
        renderComposerState();
        renderLive();
        if (!state.busy[state.sessionID]) settle();
        break;
      case 'session.error':
        renderHeader();
        renderLive();
        break;
      case 'permission.asked':
        if (!state.permissions.some(function (x) { return x.id === props.id; })) state.permissions.push(props);
        renderLive();
        break;
      case 'permission.replied':
        state.permissions = state.permissions.filter(function (x) { return x.id !== (props.requestID || props.permissionID); });
        renderLive();
        break;
      case 'question.asked':
        if (!state.questions.some(function (x) { return x.id === props.id; })) state.questions.push(props);
        renderLive();
        break;
      case 'question.replied':
      case 'question.rejected':
        state.questions = state.questions.filter(function (x) { return x.id !== props.requestID; });
        renderLive();
        break;
    }
  }

  // After a run ends, reload once so the transcript matches the server exactly
  // (final costs, titles, parts that arrived while the stream reconnected).
  var settleTimer = null;
  function settle() {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(function () { if (state.sessionID) fetchSession(false); }, 400);
  }

  function onConnect() {
    if (state.hadDisconnect) {
      state.hadDisconnect = false;
      if (state.sessionID) { fetchSession(false); fetchPending(); }
      fetchList(false);
    }
  }
  function onReconnect() { state.hadDisconnect = true; }

  // ---------- navigation ----------
  function nav() {
    var h = window.location.hash || '#/';
    var path = h.replace(/^#/, '') || '/';
    var qi = path.indexOf('?');
    var qs = qi === -1 ? '' : path.slice(qi + 1);
    var bare = qi === -1 ? path : path.slice(0, qi);
    var parts = bare.split('/').filter(Boolean);
    var params = {};
    qs.split('&').forEach(function (kv) {
      if (!kv) return;
      var eq = kv.indexOf('=');
      if (eq === -1) params[decodeURIComponent(kv)] = '';
      else params[decodeURIComponent(kv.slice(0, eq))] = decodeURIComponent(kv.slice(eq + 1));
    });
    closeDrawer();
    closeModal();
    document.title = 'opencode remote';
    if (parts[0] === 's' && parts[1]) { state.lockID = null; sessionView(decodeURIComponent(parts[1]), params.d || ''); return; }
    if (parts[0] === 'lock' && parts[1]) { lockView(decodeURIComponent(parts[1])); return; }
    state.lockID = null;
    newView();
  }

  window.Views = {
    init: init,
    nav: nav,
    handleEvent: handleEvent,
    onConnect: onConnect,
    onReconnect: onReconnect,
    setOpenCodeStatus: setOpenCodeStatus
  };
})();
