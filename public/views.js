// opencode-remote views: list, new-session, and session transcript.
// Depends on App (window.App) and Markdown (window.Markdown).
(function () {
  'use strict';

  var A = null; // App
  var state = {
    sessions: [],
    hasMore: true,
    search: '',
    busySet: {},
    models: { featured: [], more: [] },
    directorySuggest: [],
    opencodeStatus: null,
    loading: false,
    // session view
    session: null,
    messages: [],
    permissions: [],
    questions: [],
    sessionID: null,
    directory: '',
    atBottom: true,
    oldersBefore: null,
    hasOlder: true,
    loadingMoreOlder: false,
    lastError: null
  };

  var appRoot = null;

  function init(App) {
    A = App;
    appRoot = document.getElementById('app');
  }

  function setOpenCodeStatus(s) {
    state.opencodeStatus = s;
    renderStatusBanner();
  }

  function renderStatusBanner() {
    var b = document.getElementById('banner');
    if (!b) return;
    if (state.opencodeStatus && state.opencodeStatus.opencode === 'down') {
      b.textContent = 'opencode is unreachable \u2014 data may be stale.';
      b.hidden = false;
      b.classList.add('warn');
    } else {
      b.hidden = true;
      b.classList.remove('warn');
    }
  }

  function shortDir(dir) { return A.homeShort(dir); }
  function statusOf(sid) { return state.busySet[sid] || null; }

  // ---------- LIST VIEW ----------
  function listView() {
    state.sessions = [];
    state.hasMore = true;
    state.search = '';
    state.cursor = null;
    state.loading = false;
    renderList();
    A.connectEvents(null);
    A.loadStatus();
    fetchList(false);
  }

  function buildListDOM() {
    var c = document.createElement('div');
    c.className = 'list-view';

    var header = A.el('div', 'list-header');
    header.appendChild(A.el('h1', 'title', 'Sessions'));
    var newBtn = A.el('a', 'btn primary new-btn', 'New session');
    newBtn.href = '#/new';
    header.appendChild(newBtn);
    c.appendChild(header);

    var searchWrap = A.el('div', 'search-wrap');
    var si = A.el('input', 'search-input');
    si.type = 'search';
    si.placeholder = 'Search sessions\u2026';
    si.autocomplete = 'off';
    si.value = state.search;
    var t = null;
    si.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        state.search = si.value.trim();
        state.sessions = [];
        state.cursor = null;
        state.hasMore = true;
        fetchList(false);
      }, 250);
    });
    searchWrap.appendChild(si);
    c.appendChild(searchWrap);

    var list = A.el('div', 'session-list');
    list.id = 'session-list';
    c.appendChild(list);

    var moreBtn = A.el('button', 'btn load-more', 'Load more');
    moreBtn.id = 'load-more';
    moreBtn.hidden = true;
    moreBtn.addEventListener('click', function () { fetchList(true); });
    c.appendChild(moreBtn);

    return c;
  }

  function renderList() {
    appRoot.innerHTML = '';
    appRoot.appendChild(buildListDOM());
    renderListItems();
  }

  function renderListItems() {
    var list = document.getElementById('session-list');
    if (!list) return;
    if (state.loading && state.sessions.length === 0) {
      list.textContent = 'Loading\u2026';
      return;
    }
    list.textContent = '';
    if (state.sessions.length === 0) {
      list.appendChild(A.el('div', 'empty', 'No sessions found.'));
      var lb = document.getElementById('load-more');
      if (lb) lb.hidden = true;
      return;
    }
    state.sessions.forEach(function (s) { list.appendChild(sessionRow(s)); });
    var lb2 = document.getElementById('load-more');
    if (lb2) lb2.hidden = !state.hasMore;
  }

  function sessionRow(s) {
    var row = A.el('a', 'session-row');
    row.href = '#/s/' + encodeURIComponent(s.id) + '?d=' + encodeURIComponent(s.directory || '');
    var busy = statusOf(s.id);
    var top = A.el('div', 'row-top');
    var ttl = A.el('span', 'row-title', s.title || s.slug || s.id);
    top.appendChild(ttl);
    if (busy) top.appendChild(A.el('span', 'dot', '\u2022'));
    row.appendChild(top);

    var meta = A.el('div', 'row-meta');
    if (s.directory) meta.appendChild(A.el('span', 'row-dir', shortDir(s.directory)));
    if (s.model && s.model.modelID) {
      meta.appendChild(A.el('span', 'row-model', String(s.model.modelID).split('/').pop()));
    }
    var cost = A.fmtCost(s.cost);
    if (cost) meta.appendChild(A.el('span', 'row-cost', cost));
    var updated = A.relTime(s.time && s.time.updated);
    if (updated) meta.appendChild(A.el('span', 'row-time', updated));
    row.appendChild(meta);

    if (s.summary) {
      var sum = A.el('div', 'row-summary', String(s.summary).slice(0, 160));
      row.appendChild(sum);
    }
    return row;
  }

  function fetchList(append) {
    state.loading = true;
    var q = '/api/sessions?limit=50';
    if (state.cursor) q += '&cursor=' + encodeURIComponent(state.cursor);
    if (state.search) q += '&search=' + encodeURIComponent(state.search);
    A.api(q).then(function (data) {
      state.loading = false;
      var sessions = Array.isArray(data) ? data : (data.sessions || []);
      var cursor = null;
      if (data && data.cursor) cursor = data.cursor;
      // merge busy status if the backend included it per session
      if (Array.isArray(data) && data.length) {
        data.forEach(function (s) {
          if (s && s.status) {
            if (s.status === 'idle') delete state.busySet[s.id];
            else state.busySet[s.id] = s.status;
          }
        });
      }
      if (!append) state.sessions = sessions;
      else state.sessions = state.sessions.concat(sessions);
      state.cursor = cursor;
      state.hasMore = sessions.length > 0;
      renderListItems();
    }).catch(function () {
      state.loading = false;
      var list = document.getElementById('session-list');
      if (list && state.sessions.length === 0) list.textContent = 'Failed to load sessions.';
    });
  }

  // ---------- NEW SESSION VIEW ----------
  function buildNewDOM() {
    var c = A.el('div', 'new-view');

    var back = A.el('a', 'btn back', '\u2190 Sessions');
    back.href = '#/';
    c.appendChild(back);

    c.appendChild(A.el('h1', 'title', 'New session'));

    var form = A.el('form', 'new-form');
    form.id = 'new-form';

    var lblDir = A.el('label', 'lbl', 'Directory');
    var dirWrap = A.el('div', 'dir-row');
    var dirInput = A.el('input', 'text-input');
    dirInput.id = 'dir-input';
    dirInput.type = 'text';
    dirInput.placeholder = '/home/flori/Dev/\u2026';
    dirInput.autocomplete = 'off';
    dirInput.setAttribute('list', 'dir-suggest');

    var createChk = A.el('label', 'chk');
    var cb = A.el('input');
    cb.id = 'create-dir';
    cb.type = 'checkbox';
    createChk.appendChild(cb);
    createChk.appendChild(document.createTextNode(' create if missing'));

    var browseBtn = A.el('button', 'btn browse', 'Browse');
    browseBtn.type = 'button';
    browseBtn.id = 'browse-btn';
    browseBtn.addEventListener('click', function () {
      var overlay = buildBrowseOverlay();
      document.body.appendChild(overlay);
    });

    dirWrap.appendChild(dirInput);
    dirWrap.appendChild(browseBtn);
    dirWrap.appendChild(createChk);

    var dl = A.el('datalist', null);
    dl.id = 'dir-suggest';

    var lblModel = A.el('label', 'lbl', 'Model');
    var modelSel = A.el('select', 'select', null);
    modelSel.id = 'model-select';

    var lblTitle = A.el('label', 'lbl', 'Title (optional)');
    var titleInput = A.el('input', 'text-input');
    titleInput.id = 'title-input';
    titleInput.type = 'text';

    var lblPrompt = A.el('label', 'lbl', 'Prompt');
    var prompt = A.el('textarea', 'prompt-input');
    prompt.id = 'prompt-input';
    prompt.placeholder = 'What should the agent do?\n(Ctrl+Enter or Cmd+Enter to submit)';
    prompt.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)) {
        e.preventDefault();
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    });

    var errBox = A.el('div', 'err');
    errBox.id = 'new-err';

    var submitBtn = A.el('button', 'btn primary', 'Create');
    submitBtn.type = 'submit';

    form.appendChild(lblDir);
    form.appendChild(dirWrap);
    form.appendChild(dl);
    form.appendChild(lblModel);
    form.appendChild(modelSel);
    form.appendChild(lblTitle);
    form.appendChild(titleInput);
    form.appendChild(lblPrompt);
    form.appendChild(prompt);
    form.appendChild(errBox);
    form.appendChild(submitBtn);
    form.addEventListener('submit', submitNew);
    c.appendChild(form);
    return c;
  }

  function newView() {
    appRoot.innerHTML = '';
    appRoot.appendChild(buildNewDOM());
    A.loadStatus();
    A.api('/api/models').then(function (m) {
      state.models = m || { featured: [], more: [] };
      fillModelSelect();
    }).catch(function () {
      var sel = document.getElementById('model-select');
      if (sel) {
        sel.innerHTML = '';
        sel.appendChild(A.el('option', null, 'Models unavailable'));
      }
    });
    A.api('/api/directories/suggest').then(function (d) {
      state.directorySuggest = d && d.directories ? d.directories : (Array.isArray(d) ? d : []);
      fillSuggestions();
    }).catch(function () {});
    // prefill with last model if available
    var last = A.getLastModel ? A.getLastModel() : null;
    if (last) {
      var ls = document.getElementById('model-select');
      if (ls) {
        ls.dataset.last = last.providerID + '/' + last.modelID;
      }
    }
  }

  function fillModelSelect() {
    var sel = document.getElementById('model-select');
    if (!sel) return;
    sel.innerHTML = '';
    var groups = ['featured', 'more'];
    groups.forEach(function (gn) {
      var models = state.models[gn] || [];
      if (!models.length) return;
      var og = A.el('optgroup', null);
      og.label = gn === 'featured' ? 'Featured' : 'More models';
      models.forEach(function (m) {
        var o = A.el('option', null);
        o.value = m.providerID + '/' + m.modelID;
        o.textContent = m.providerName + ' \u2014 ' + m.modelName + (m.modelID.indexOf(':free') !== -1 ? ' :free' : '');
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (!sel.options.length) sel.appendChild(A.el('option', null, 'No models'));
    var last = sel.dataset.last;
    if (last) {
      var opt = sel.querySelector('option[value="' + last + '"]');
      if (opt) sel.value = last;
    }
  }

  function fillSuggestions() {
    var dl = document.getElementById('dir-suggest');
    if (!dl) return;
    dl.innerHTML = '';
    state.directorySuggest.forEach(function (d) {
      dl.appendChild(A.el('option', null, d));
    });
  }

  function submitNew(e) {
    e.preventDefault();
    var btn = e.target.querySelector('button[type=submit]');
    if (btn) btn.disabled = true;
    var directory = (document.getElementById('dir-input').value || '').trim();
    var title = (document.getElementById('title-input').value || '').trim();
    var prompt = (document.getElementById('prompt-input').value || '').trim();
    var modelVal = document.getElementById('model-select').value || '';
    var createDirectory = document.getElementById('create-dir').checked;
    var slash = modelVal.indexOf('/');
    var providerID = slash === -1 ? modelVal : modelVal.slice(0, slash);
    var modelID = slash === -1 ? '' : modelVal.slice(slash + 1);
    var errBox = document.getElementById('new-err');
    if (!directory || !prompt) {
      if (errBox) { errBox.textContent = 'Directory and prompt are required.'; errBox.hidden = false; }
      if (btn) btn.disabled = false;
      return;
    }
    var body = {
     ['directory']: directory,
      prompt: prompt,
      model: { providerID: providerID, modelID: modelID },
      createDirectory: createDirectory
    };
    if (title) body.title = title;
    if (modelID) A.saveLastModel(body.model);
    A.api('/api/sessions', { method: 'POST', body: body }).then(function (res) {
      var s = res.session || res;
      window.location.hash = '#/s/' + encodeURIComponent(s.id) + '?d=' + encodeURIComponent(directory);
    }).catch(function (err) {
      if (errBox) { errBox.textContent = err.message || 'Failed to create session.'; errBox.hidden = false; }
      if (btn) btn.disabled = false;
    });
  }

  function buildBrowseOverlay() {
    var overlay = A.el('div', 'modal-overlay');
    var box = A.el('div', 'modal');
    box.appendChild(A.el('h3', 'modal-title', 'Browse directory'));
    var pathRow = A.el('div', 'browse-path');
    var input = A.el('input', 'text-input');
    input.id = 'browse-path';
    input.value = (document.getElementById('dir-input') && document.getElementById('dir-input').value) || '/home/flori/';
    pathRow.appendChild(input);
    box.appendChild(pathRow);
    var list = A.el('div', 'browse-list');
    box.appendChild(list);
    var btnRow = A.el('div', 'modal-btns');
    var ok = A.el('button', 'btn primary', 'Use this directory');
    var cancel = A.el('button', 'btn', 'Cancel');
    btnRow.appendChild(ok);
    btnRow.appendChild(cancel);
    box.appendChild(btnRow);
    overlay.appendChild(box);

    function load(path) {
      list.textContent = '';
      list.appendChild(A.el('div', 'browse-loading', 'Loading\u2026'));
      A.api('/api/directories?path=' + encodeURIComponent(path)).then(function (d) {
        list.textContent = '';
        var dirs = d && d.directories ? d.directories : (Array.isArray(d) ? d : []);
        if (!dirs.length) list.appendChild(A.el('div', 'empty', '(no subdirectories)'));
        dirs.forEach(function (dir) {
          var item = A.el('div', 'browse-item', dir);
          item.addEventListener('click', function () { input.value = dir; load(dir); });
          list.appendChild(item);
        });
      }).catch(function (err) {
        list.textContent = 'Error: ' + (err.message || '');
      });
    }
    input.addEventListener('change', function () { load(input.value); });
    ok.addEventListener('click', function () {
      var di = document.getElementById('dir-input');
      if (di) di.value = input.value;
      document.body.removeChild(overlay);
    });
    cancel.addEventListener('click', function () { document.body.removeChild(overlay); });
    load(input.value);
    return overlay;
  }

  // ---------- SESSION VIEW ----------
  function sessionView(id, dir, params) {
    state.session = null;
    state.messages = [];
    state.permissions = [];
    state.questions = [];
    state.sessionID = id;
    state.directory = dir || '';
    state.atBottom = true;
    state.oldersBefore = null;
    state.hasOlder = false;
    state.loadingMoreOlder = false;
    state.lastError = null;

    appRoot.innerHTML = '';
    var c = A.el('div', 'session-view');
    c.id = 'session-view';
    c.appendChild(A.el('div', 'session-loading', 'Loading session\u2026'));
    appRoot.appendChild(c);

    A.loadStatus();
    A.connectEvents(id);
    fetchSession();
  }

  function fetchSession() {
    var q = '/api/sessions/' + encodeURIComponent(state.sessionID);
    if (state.directory) q += '?directory=' + encodeURIComponent(state.directory);
    A.api(q).then(function (d) {
      state.session = d.session;
      state.messages = d.messages || [];
      state.hasOlder = (d.messages || []).length >= 200;
      if (state.hasOlder) state.oldersBefore = oldestMessageID(state.messages);
      renderSession();
      scrollToBottom(true);
    }).catch(function (err) {
      var view = document.getElementById('session-view');
      if (!view) return;
      view.innerHTML = '';
      view.appendChild(A.el('div', 'empty', 'Failed to load session: ' + (err.message || '')));
      var back = A.el('a', 'btn', '\u2190 Back');
      back.href = '#/';
      view.appendChild(back);
    });
  }

  function oldestMessageID(messages) {
    var oldest = null;
    messages.forEach(function (m) {
      if (m && m.info && m.info.id) {
        if (!oldest || m.info.id < oldest) oldest = m.info.id;
      }
    });
    return oldest;
  }

  function renderSession() {
    var view = document.getElementById('session-view');
    if (!view) return;
    view.innerHTML = '';
    view.appendChild(headerDOM());
    view.appendChild(permBanner());
    view.appendChild(timelineDOM());
    view.appendChild(composerDOM());
  }

  function headerDOM() {
    var s = state.session || {};
    var h = A.el('div', 'session-header');
    var top = A.el('div', 'head-top');
    var back = A.el('a', 'btn', '\u2190');
    back.href = '#/';
    back.title = 'Back to sessions';
    top.appendChild(back);
    top.appendChild(A.el('h1', 'head-title', s.title || s.slug || s.id));
    var st = statusOf(s.id);
    if (st) top.appendChild(A.el('span', 'dot', '\u2022'));
    h.appendChild(top);

    var meta = A.el('div', 'head-meta');
    if (s.directory) meta.appendChild(A.el('span', 'meta-dir', shortDir(s.directory)));
    if (s.model && s.model.modelID) meta.appendChild(A.el('span', 'meta-model', s.model.providerID + ' / ' + s.model.modelID));
    var cost = A.fmtCost(s.cost);
    if (cost) meta.appendChild(A.el('span', 'meta-cost', cost));
    var updated = A.relTime(s.time && s.time.updated);
    if (updated) meta.appendChild(A.el('span', 'meta-time', updated));
    h.appendChild(meta);

    if (st) {
      var abort = A.el('button', 'btn danger abort', 'Abort');
      abort.addEventListener('click', function () {
        A.api('/api/sessions/' + encodeURIComponent(s.id) + '/abort', {
          method: 'POST', body: { directory: s.directory }
        }).catch(function () {});
      });
      h.appendChild(abort);
    }
    if (state.lastError) {
      h.appendChild(A.el('div', 'msg-error', 'Session error: ' + state.lastError));
    }
    return h;
  }

  function permBanner() {
    var wrap = A.el('div', 'perm-banners');
    var all = state.permissions.concat(state.questions.map(function (q) {
      return { id: q.id, permission: 'question', patterns: q.questions || [], metadata: null, _question: true };
    }));
    if (!all.length) return wrap;
    all.forEach(function (p) {
      var b = A.el('div', 'perm-banner');
      b.appendChild(A.el('div', 'perm-head', p._question ? 'Question' : 'Permission request'));
      var desc = A.el('div', 'perm-desc');
      var what = (p.permission || '');
      var pat = (p.patterns && p.patterns.length) ? (' \u2014 ' + p.patterns.join(', ')) : '';
      var met = (p.metadata && (p.metadata.description || p.metadata.title));
      desc.textContent = what + pat + (met ? ('\n' + met) : '');
      b.appendChild(desc);
      var btns = A.el('div', 'perm-btns');
      if (p._question) {
        var rq = A.el('button', 'btn perm-reject', 'Reject');
        rq.addEventListener('click', function () {
          A.api('/api/questions/' + encodeURIComponent(p.id) + '/reject', {
            method: 'POST', body: { directory: state.directory }
          }).then(function () {
            state.questions = state.questions.filter(function (x) { return x.id !== p.id; });
            renderPermBanners();
          }).catch(function () {});
        });
        btns.appendChild(rq);
      } else {
        ['once', 'always', 'reject'].forEach(function (r) {
          var b2 = A.el('button', 'btn perm-' + r, r);
          b2.addEventListener('click', function () {
            A.api('/api/permissions/' + encodeURIComponent(p.id) + '/reply', {
              method: 'POST', body: { directory: state.directory, reply: r }
            }).then(function () {
              state.permissions = state.permissions.filter(function (x) { return x.id !== p.id; });
              renderPermBanners();
            }).catch(function () {});
          });
          btns.appendChild(b2);
        });
      }
      b.appendChild(btns);
      wrap.appendChild(b);
    });
    return wrap;
  }

  function composerDOM() {
    var c = A.el('div', 'composer');
    var form = A.el('form', 'composer-form');
    form.id = 'composer-form';
    var row = A.el('div', 'composer-row');
    var ta = A.el('textarea', 'composer-input');
    ta.placeholder = 'Send a follow-up message\u2026';
    ta.setAttribute('rows', '2');
    row.appendChild(ta);
    var send = A.el('button', 'btn primary send-btn', 'Send');
    send.type = 'submit';
    row.appendChild(send);
    form.appendChild(row);

    var modelRow = A.el('div', 'composer-model-row');
    var sel = A.el('select', 'select composer-model');
    sel.id = 'composer-model';
    modelRow.appendChild(sel);
    form.appendChild(modelRow);

    ta.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'Enter' || e.keyCode === 13)) {
        e.preventDefault();
        form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    });
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var text = ta.value.trim();
      if (!text) return;
      send.textContent = '\u2026';
      send.disabled = true;
      var val = sel.value || '';
      var slash = val.indexOf('/');
      var model = { providerID: slash === -1 ? val : val.slice(0, slash), modelID: slash === -1 ? '' : val.slice(slash + 1) };
      A.api('/api/sessions/' + encodeURIComponent(state.sessionID) + '/prompt', {
        method: 'POST',
        body: { directory: state.directory, text: text, model: model }
      }).then(function () {
        if (model.modelID) A.saveLastModel(model);
        ta.value = '';
        send.textContent = 'Send';
        send.disabled = false;
        state.atBottom = true;
        scrollToBottom(true);
      }).catch(function (err) {
        send.textContent = 'Send';
        send.disabled = false;
        if (err.message) {
          var e2 = A.el('div', 'send-error', err.message);
          form.parentNode.insertBefore(e2, form.nextSibling);
          setTimeout(function () { e2.remove(); }, 3000);
        }
      });
    });
    fillComposerModelSelect(sel);
    return c;
  }

  function fillComposerModelSelect(sel) {
    sel.innerHTML = '';
    var current = (state.session && state.session.model)
      ? state.session.model.providerID + '/' + state.session.model.modelID : null;
    var last = A.getLastModel ? A.getLastModel() : null;
    var groups = ['featured', 'more'];
    groups.forEach(function (gn) {
      var models = state.models[gn] || [];
      if (!models.length) return;
      var og = A.el('optgroup', null);
      og.label = gn === 'featured' ? 'Featured' : 'More models';
      models.forEach(function (m) {
        var o = A.el('option', null);
        o.value = m.providerID + '/' + m.modelID;
        o.textContent = m.providerName + ' \u2014 ' + m.modelName + (m.modelID.indexOf(':free') !== -1 ? ' :free' : '');
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    var want = null;
    if (current && sel.querySelector('option[value="' + current + '"]')) want = current;
    else if (last && sel.querySelector('option[value="' + last.providerID + '/' + last.modelID + '"]')) {
      want = last.providerID + '/' + last.modelID;
    }
    if (want) sel.value = want;
  }

  function timelineDOM() {
    var tl = A.el('div', 'timeline');
    tl.id = 'timeline';
    tl.addEventListener('scroll', onTimelineScroll);
    if (state.hasOlder) {
      var older = A.el('button', 'btn load-older', 'Load older messages');
      older.id = 'load-older';
      older.addEventListener('click', loadOlder);
      tl.appendChild(older);
    }
    state.messages.forEach(function (m) { tl.appendChild(messageDOM(m)); });
    return tl;
  }

  function onTimelineScroll() {
    var tl = document.getElementById('timeline');
    if (!tl) return;
    state.atBottom = (tl.scrollHeight - tl.scrollTop - tl.clientHeight) < 120;
  }

  function loadOlder() {
    if (state.loadingMoreOlder || !state.oldersBefore) return;
    state.loadingMoreOlder = true;
    var q = '/api/sessions/' + encodeURIComponent(state.sessionID) +
      '?directory=' + encodeURIComponent(state.directory) +
      '&before=' + encodeURIComponent(state.oldersBefore) + '&limit=200';
    A.api(q).then(function (d) {
      state.loadingMoreOlder = false;
      var oldMsgs = d.messages || [];
      var keep = 0;
      var tl = document.getElementById('timeline');
      if (tl) keep = tl.scrollHeight;
      state.messages = oldMsgs.concat(state.messages);
      state.oldersBefore = oldMsgs.length ? oldestMessageID(oldMsgs) : null;
      state.hasOlder = oldMsgs.length >= 200;
      renderSession();
      var tl2 = document.getElementById('timeline');
      if (tl2) tl2.scrollTop = tl2.scrollHeight - keep;
    }).catch(function () {
      state.loadingMoreOlder = false;
    });
  }

  function messageDOM(m) {
    var info = m.info || {};
    var wrap = A.el('div', 'msg msg-' + info.role);
    var body = A.el('div', 'msg-body');
    var parts = m.parts || [];
    if (info.error) {
      var e = A.el('div', 'msg-error', String(info.error));
      body.appendChild(e);
    }
    parts.forEach(function (p) { body.appendChild(partDOM(p)); });
    if (!parts.length) body.appendChild(A.el('div', 'msg-empty', '(empty message)'));
    wrap.appendChild(body);
    var foot = A.el('div', 'msg-foot');
    if (info.modelID) foot.appendChild(A.el('span', 'msg-model', String(info.modelID).split('/').pop()));
    var cost = A.fmtCost(info.cost);
    if (cost) foot.appendChild(A.el('span', 'msg-cost', cost));
    var created = A.relTime(info.time && info.time.created);
    if (created) foot.appendChild(A.el('span', 'msg-time', created));
    if (foot.childNodes.length) wrap.appendChild(foot);
    return wrap;
  }

  function partDOM(p) {
    switch (p.type) {
      case 'text': return textPart(p);
      case 'reasoning': return reasoningPart(p);
      case 'tool': return toolPart(p);
      case 'patch': return patchPart(p);
      case 'step-finish': return stepFinishPart(p);
      case 'file': return filePart(p);
      case 'agent': return labelPart('agent', p.title || p.agent || p.modelID || 'agent');
      case 'subtask': return labelPart('subtask', p.title || 'subtask');
      case 'compaction': return labelPart('compaction', p.summary || 'compaction');
      case 'step-start': return A.el('div', 'part-step', '');
      default: return unknownPart(p);
    }
  }

  function textPart(p) {
    var d = A.el('div', 'part part-text');
    var inner = A.el('div', 'md');
    inner.innerHTML = window.Markdown.render(p.text || '');
    d.appendChild(inner);
    return d;
  }

  function reasoningPart(p) {
    var d = A.el('div', 'part part-reasoning');
    var btn = A.el('button', 'reasoning-toggle', '\u25b8 reasoning');
    var body = A.el('div', 'reasoning-body md');
    body.innerHTML = window.Markdown.render(p.text || '');
    body.hidden = true;
    btn.addEventListener('click', function () {
      body.hidden = !body.hidden;
      btn.textContent = body.hidden ? '\u25b8 reasoning' : '\u25be reasoning';
    });
    d.appendChild(btn);
    d.appendChild(body);
    return d;
  }

  function toolPart(p) {
    var st = p.state || {};
    var d = A.el('div', 'part part-tool');
    var head = A.el('div', 'tool-head');
    head.appendChild(A.el('span', 'tool-name', p.tool || 'tool'));
    var status = st.status || 'unknown';
    head.appendChild(A.el('span', 'tool-status ' + status, status));
    if (st.title) head.appendChild(A.el('span', 'tool-title', String(st.title)));
    if (st.error) head.appendChild(A.el('span', 'tool-error', String(st.error)));
    d.appendChild(head);
    if (st.input !== undefined || st.output !== undefined) {
      var details = A.el('details', 'tool-details');
      details.appendChild(A.el('summary', null, 'details'));
      if (st.input !== undefined) {
        var pre = A.el('pre', 'tool-pre');
        pre.textContent = typeof st.input === 'string' ? st.input : JSON.stringify(st.input, null, 2);
        details.appendChild(pre);
      }
      if (st.output !== undefined) {
        var pre2 = A.el('pre', 'tool-pre');
        pre2.textContent = st.output;
        details.appendChild(pre2);
      }
      d.appendChild(details);
    }
    return d;
  }

  function patchPart(p) {
    var d = A.el('div', 'part part-patch');
    var files = (p.files || []).slice(0, 4);
    d.appendChild(A.el('div', 'patch-head', 'patch \u00b7 ' + files.length + ' file' + (files.length === 1 ? '' : 's')));
    files.forEach(function (f) {
      d.appendChild(A.el('div', 'patch-file', f));
    });
    return d;
  }

  function stepFinishPart(p) {
    var d = A.el('div', 'part part-step-finish');
    var parts = [];
    if (p.reason) parts.push(p.reason);
    var cost = A.fmtCost(p.cost);
    if (cost) parts.push(cost);
    d.textContent = parts.join(' \u00b7 ');
    return d;
  }

  function filePart(p) {
    var d = A.el('div', 'part part-file');
    d.textContent = p.path || p.file || 'file';
    return d;
  }

  function labelPart(kind, label) {
    var d = A.el('div', 'part part-' + kind);
    d.textContent = label || kind;
    return d;
  }

  function unknownPart(p) {
    var d = A.el('div', 'part part-unknown');
    d.textContent = 'unknown part: ' + (p.type || '');
    return d;
  }

  function scrollToBottom(force) {
    var tl = document.getElementById('timeline');
    if (!tl) return;
    if (force || state.atBottom) tl.scrollTop = tl.scrollHeight;
  }

  function fetchPermissions() {
    if (!state.directory) { state.permissions = []; return; }
    A.api('/api/permissions?directory=' + encodeURIComponent(state.directory)).then(function (d) {
      state.permissions = d && d.permissions ? d.permissions : (Array.isArray(d) ? d : []);
      renderPermBanners();
    }).catch(function () {});
  }

  // ---------- event handling ----------
  function handleEvent(ev) {
    var payload = ev.payload || {};
    var props = payload.properties || {};
    var type = payload.type;
    var sID = props.sessionID ||
      (props.info && props.info.sessionID) ||
      (props.part && props.part.sessionID) ||
      null;
    var inSession = state.sessionID && sID === state.sessionID;

    if (inSession) {
      if (type === 'message.updated') upsertMessageInfo(props.info);
      else if (type === 'message.part.updated') upsertPart(props.part);
      else if (type === 'message.part.delta') applyDelta(props);
      else if (type === 'message.part.removed') removePart(props.partID, props.messageID);
      else if (type === 'message.removed') removeMessage(props.messageID);
      else if (type === 'session.status') onSessionStatus(props.status);
      else if (type === 'session.idle') {
        delete state.busySet[state.sessionID];
        renderHeader();
        fetchSession();
      } else if (type === 'session.updated' && props.info) {
        state.session = Object.assign({}, state.session, props.info);
        renderHeader();
      } else if (type === 'session.error') {
        state.lastError = props.error;
        renderHeader();
      } else if (type === 'permission.asked') {
        state.permissions.push({ id: props.id, sessionID: props.sessionID, permission: props.permission, patterns: props.patterns, metadata: props.metadata });
        renderPermBanners();
      } else if (type === 'permission.replied') {
        state.permissions = state.permissions.filter(function (x) { return x.id !== props.requestID; });
        renderPermBanners();
      } else if (type === 'question.asked') {
        state.questions.push({ id: props.id, sessionID: props.sessionID, questions: props.questions });
        renderPermBanners();
      }
    }

    // List view events
    if (type === 'session.updated' && props.info) {
      upsertListSession(props.info);
    } else if (type === 'session.status' && props.sessionID) {
      var st = props.status ? props.status.type : 'idle';
      if (st === 'idle') delete state.busySet[props.sessionID];
      else state.busySet[props.sessionID] = st;
      renderListItems();
    } else if (type === 'session.idle' && props.sessionID) {
      delete state.busySet[props.sessionID];
      renderListItems();
    } else if (type === 'session.created' && props.info) {
      if (!state.sessions.some(function (s) { return s.id === props.info.id; })) {
        state.sessions.unshift(props.info);
        renderListItems();
      }
    } else if (type === 'session.deleted' && props.sessionID) {
      state.sessions = state.sessions.filter(function (s) { return s.id !== props.sessionID; });
      renderListItems();
    }
  }

  function upsertListSession(info) {
    if (!info || !info.id) return;
    var found = state.sessions.some(function (s) { return s.id === info.id; });
    if (found) {
      state.sessions = state.sessions.map(function (s) {
        return s.id === info.id ? Object.assign({}, s, info) : s;
      });
    } else {
      state.sessions.unshift(info);
    }
    renderListItems();
  }

  function upsertMessageInfo(info) {
    if (!info || !info.id) return;
    var found = false;
    state.messages.forEach(function (m) {
      if (m.info.id === info.id) { m.info = Object.assign({}, m.info, info); found = true; }
    });
    if (!found) {
      state.messages.push({ info: info, parts: [] });
      state.messages.sort(function (a, b) { return (a.info.time.created || 0) - (b.info.time.created || 0); });
    }
    updateTimeline();
  }

  function upsertPart(part) {
    if (!part || !part.messageID) return;
    var msg = findMessage(part.messageID);
    if (!msg) return;
    var found = false;
    msg.parts.forEach(function (p) {
      if (p.id === part.id) { Object.assign(p, part); found = true; }
    });
    if (!found) msg.parts.push(part);
    updateTimeline();
  }

  function applyDelta(props) {
    var msg = findMessage(props.messageID);
    if (!msg) return;
    msg.parts.forEach(function (p) {
      if (p.id === props.partID && props.field) {
        if (!p[props.field]) p[props.field] = '';
        p[props.field] += props.delta || '';
      }
    });
    updateTimeline();
  }

  function removePart(partID, messageID) {
    var msg = findMessage(messageID);
    if (!msg) return;
    msg.parts = msg.parts.filter(function (p) { return p.id !== partID; });
    updateTimeline();
  }

  function removeMessage(messageID) {
    state.messages = state.messages.filter(function (m) { return m.info.id !== messageID; });
    updateTimeline();
  }

  function findMessage(id) {
    var found = null;
    state.messages.forEach(function (m) { if (m.info.id === id) found = m; });
    return found;
  }

  function updateTimeline() {
    var tl = document.getElementById('timeline');
    if (!tl) return;
    var nearBottom = state.atBottom;
    var keep = tl.scrollTop;
    renderMessagesOnly();
    tl.scrollTop = keep;
    if (nearBottom) scrollToBottom(true);
  }

  function renderMessagesOnly() {
    var tl = document.getElementById('timeline');
    if (!tl) return;
    var keep = tl.scrollTop;
    tl.innerHTML = '';
    if (state.hasOlder) {
      var older = A.el('button', 'btn load-older', 'Load older messages');
      older.id = 'load-older';
      older.addEventListener('click', loadOlder);
      tl.appendChild(older);
    }
    state.messages.forEach(function (m) { tl.appendChild(messageDOM(m)); });
    tl.scrollTop = keep;
  }

  function renderHeader() {
    var view = document.getElementById('session-view');
    if (!view) return;
    var oldH = view.querySelector('.session-header');
    if (oldH) oldH.remove();
    view.insertBefore(headerDOM(), view.firstChild);
  }

  function renderPermBanners() {
    var view = document.getElementById('session-view');
    if (!view) return;
    var old = view.querySelector('.perm-banners');
    if (old) old.remove();
    var nb = permBanner();
    var header = view.querySelector('.session-header');
    if (header && header.nextSibling) header.parentNode.insertBefore(nb, header.nextSibling);
    else view.insertBefore(nb, view.firstChild);
  }

  function onSessionStatus(statusObj) {
    var st = statusObj ? statusObj.type : 'idle';
    if (st === 'idle') { delete state.busySet[state.sessionID]; fetchSession(); }
    else { state.busySet[state.sessionID] = st; renderHeader(); }
  }

  function onConnect() {
    if (state.sessionID) fetchSession();
  }
  function onReconnect() {
    if (state.sessionID) fetchSession();
  }

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
    if (parts.length === 0) { listView(); return; }
    if (parts[0] === 'new') { newView(); return; }
    if (parts[0] === 's' && parts[1]) { sessionView(parts[1], params.d || '', params); return; }
    listView();
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