// Applies the saved (or system) colour theme before first paint.
(function () {
  'use strict';
  var t = null;
  try { t = localStorage.getItem('ocr-theme'); } catch (e) {}
  if (t !== 'light' && t !== 'dark') {
    t = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  document.documentElement.setAttribute('data-theme', t);
})();
