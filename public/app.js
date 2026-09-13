// opencode-remote frontend entry point.
// Handles login page logic, API helpers, router, state, and live SSE updates.
// View rendering lives in views.js (and markdown.js renders safe HTML).
(function () {
  'use strict';

  function $(sel, root) {
    root = root || document;
    return root.querySelector(sel);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function on(sel, evt, fn, root) {
    (root || document).addEventListener(evt, function (e) {
      var t = e.target.closest ? e.target.closest(sel) : null;
      if (t) fn(e, t);
    });
  }

  // --- login page ---
  function initLogin() {
    var pw = document.getElementById('pw');
    var form = document.getElementById('login-form');
    var errEl = document.getElementById('login-error');
    var btn = document.getElementById('login-btn');
    var reveal = document.getElementById('reveal');
    if (!form || !pw) return;

    // Mask fallback for browsers that don't support text-security.
    var supportsWebkit = (typeof CSS !== 'undefined' && CSS.supports)
      ? CSS.supports('-webkit-text-security', 'disc') : false;
    var supportsStandard = (typeof CSS !== 'undefined' && CSS.supports)
      ? CSS.supports('text-security', 'disc') : false;
    if (!supportsWebkit && !supportsStandard) {
      pw.type = 'password';
      pw.classList.remove('masked');
    }

    if (reveal) {
      reveal.addEventListener('click', function () {
        if (pw.classList.contains('masked')) {
          pw.classList.remove('masked');
          reveal.setAttribute('aria-pressed', 'true');
        } else {
          pw.classList.add('masked');
          reveal.setAttribute('aria-pressed', 'false');
        }
        pw.focus();
      });
    }

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (btn) btn.disabled = true;
      if (errEl) errEl.hidden = true;
      fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw.value })
      }).then(function (r) {
        if (r.status === 429) throw { msg: 'Too many attempts. Try again in a few minutes.' };
        if (r.ok) { window.location.href = '/'; return; }
        throw { msg: 'Incorrect access code.' };
      }).catch(function (err) {
        if (btn) btn.disabled = false;
        var msg = err && err.msg ? err.msg : 'Network error. Check your connection.';
        if (errEl) { errEl.textContent = msg; errEl.hidden = false; }
      });
    });
  }

  // --- shared API helper ---
  var apiBase = '';

  function api(path, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(apiBase + path, opts).then(function (res) {
      if (res.status === 401) {
        window.location.replace('/login.html');
        var u = new Error('unauthorized');
        u.status = 401;
        throw u;
      }
      if (res.status === 204) return null;
      var ct = res.headers.get('content-type') || '';
      if (ct.indexOf('application/json') !== -1) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var m = data && data.error ? data.error : ('HTTP ' + res.status);
            var e = new Error(m);
            e.status = res.status;
            throw e;
          }
          return data;
        });
      }
      return res.text();
    });
  }

  // --- time utils ---
  function relTime(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var diff = Date.now() - d.getTime();
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 0) return 'soon';
    var mins = Math.floor(diff / 60000);
    if (mins < 60) return mins + 'm ago';
    var hrs = Math.floor(diff / 3600000);
    if (hrs < 24) return hrs + 'h ago';
    var days = Math.floor(diff / 86400000);
    if (days < 7) return days + 'd ago';
    return d.toLocaleDateString();
  }

  function fmtCost(c) {
    if (c === null || c === undefined) return '';
    var n = Number(c);
    if (isNaN(n) || n <= 0) return '';
    return '$' + n.toFixed(3);
  }

  function homeShort(dir) {
    if (!dir) return '';
    // strip the /home/<user> prefix => ~/...
    var m = String(dir).match(/^\/home\/[^/]+(\/.*|$)/);
    if (m) return '~' + (m[1] || '');
    return dir;
  }

  // --- global listeners for live events / status ---
  // (assigned once by index.html's main script)
  var globalState = { busy: false };

  // --- router + boot (assigned by index.html) ---
  var Router = {
    current: null,
    nav: function () {}
  };

  document.addEventListener('DOMContentLoaded', function () {
    if (document.body.getAttribute('data-page') === 'login') {
      initLogin();
    } else {
      boot();
    }
  });

  function boot() {
    // dynamic import of views (separate file, still a same-origin script)
    var s = document.createElement('script');
    s.src = 'views.js';
    s.onload = function () {
      Router.nav = window.Views.nav;
      window.Views.init(window.App);
      window.App.router();
    };
    document.head.appendChild(s);
  }

  // --- SSE connection ---
  function connectEvents(sessionID) {
    closeEvents();
    var url = '/api/events' + (sessionID ? ('?sessionID=' + encodeURIComponent(sessionID)) : '');
    var es = new EventSource(url);
    es.onopen = function () { window.Views && window.Views.onConnect && window.Views.onConnect(); };
    es.onerror = function () {
      // EventSource auto-reconnects; notify views to self-heal
      window.Views && window.Views.onReconnect && window.Views.onReconnect();
    };
    es.onmessage = function (ev) {
      var data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      window.Views && window.Views.handleEvent(data);
    };
    Router.es = es;
  }

  function closeEvents() {
    if (Router.es) { Router.es.close(); Router.es = null; }
  }

  function loadStatus() {
    api('/api/status').then(function (s) {
      window.Views && window.Views.setOpenCodeStatus(s);
    }).catch(function () {
      window.Views && window.Views.setOpenCodeStatus({ opencode: 'down' });
    });
  }

  function router() {
    if (Router.nav) Router.nav();
  }

  // Expose internals for views.js
  window.App = {
    api: api,
    el: el,
    on: on,
    router: router,
    connectEvents: connectEvents,
    closeEvents: closeEvents,
    relTime: relTime,
    fmtCost: fmtCost,
    homeShort: homeShort,
    getLastModel: function () {
      try { return JSON.parse(localStorage.getItem('ocr-last-model')) || null; }
      catch (e) { return null; }
    },
    saveLastModel: function (m) {
      try { localStorage.setItem('ocr-last-model', JSON.stringify(m)); } catch (e) {}
    },
    loadStatus: loadStatus
  };

  window.addEventListener('hashchange', function () {
    closeEvents();
    if (Router.nav) Router.nav();
  });
})();