// Minimal, safe markdown renderer.
// Strategy: escape ALL HTML first, then apply block and inline transformations
// on the escaped text. No markdown output is ever injected unescaped.
(function () {
  'use strict';

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Safely build attribute values (already-escaped text -> strip any leftovers)
  function attr(v) {
    return escapeHtml(v).replace(/\n/g, ' ');
  }

  // Inline renderer operating on already-escaped text. Split the escaped input
  // on special characters so we don't re-process the tags we generate.
  function renderInline(escaped) {
    let s = escaped;
    // code spans: `...` (content escaped already, so just wrap)
    s = s.replace(/`([^`]+)`/g, function (m, code) {
      return '<code>' + code + '</code>';
    });
    // bold **...**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic *...*
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    // italic _..._
    s = s.replace(/(^|[^A-Za-z0-9_])_([^_\n]+)_/g, '$1<em>$2</em>');
    // links [text](url) — keep only safe-ish urls (http/https/mailto/#)
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m, text, url) {
      if (/^(https?:|mailto:|#|\/)/i.test(url)) {
        var rel = url[0] === '#' ? '' : ' rel="noreferrer noopener" target="_blank"';
        return '<a href="' + attr(url) + '"' + rel + '>' + text + '</a>';
      }
      return text + ' (' + url + ')';
    });
    // bare http(s) urls (when not already inside an <a>)
    s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, function (m, pre, url) {
      return pre + '<a href="' + attr(url) + '" rel="noreferrer noopener" target="_blank">' + url + '</a>';
    });
    return s;
  }

  function render(text) {
    if (text === null || text === undefined) return '';
    var escaped = escapeHtml(String(text));
    var lines = escaped.replace(/\r\n/g, '\n').split('\n');

    var out = [];
    var i = 0;
    var listStack = []; // 'ul' | 'ol'
    var inFence = null;
    var fenceBuf = [];

    function closeListsTo(level) {
      while (listStack.length > level) {
        out.push('</' + listStack.pop() + '>');
      }
    }

    function closeAllLists() { closeListsTo(0); }

    while (i < lines.length) {
      var line = lines[i];

      // fenced code block
      var fence = line.match(/^\s*(```|~~~)(.*)$/);
      if (fence) {
        if (inFence === null) {
          inFence = true;
          fenceBuf = [];
          closeAllLists();
          out.push('<pre class="code"><code class="lang-' + attr(fence[2].trim()) + '">');
          i++;
          continue;
        } else {
          inFence = null;
          out.push('\n' + fenceBuf.join('\n') + '</code></pre>');
          fenceBuf = [];
          i++;
          continue;
        }
      }
      if (inFence) {
        fenceBuf.push(line);
        i++;
        continue;
      }

      var trimmed = line.trim();

      // blank line
      if (!trimmed) {
        closeAllLists();
        out.push('');
        i++;
        continue;
      }

      // headings
      var h = trimmed.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        closeAllLists();
        var lvl = h[1].length;
        out.push('<h' + lvl + '>' + renderInline(h[2]) + '</h' + lvl + '>');
        i++;
        continue;
      }

      // unordered list item
      var ul = trimmed.match(/^[-*+]\s+(.*)$/);
      if (ul) {
        if (listStack[listStack.length - 1] !== 'ul') {
          closeListsTo(0);
          listStack.push('ul');
          out.push('<ul>');
        }
        out.push('<li>' + renderInline(ul[1]) + '</li>');
        i++;
        continue;
      }

      // ordered list item
      var ol = trimmed.match(/^\d+[.)]\s+(.*)$/);
      if (ol) {
        if (listStack[listStack.length - 1] !== 'ol') {
          closeListsTo(0);
          listStack.push('ol');
          out.push('<ol>');
        }
        out.push('<li>' + renderInline(ol[1]) + '</li>');
        i++;
        continue;
      }

      // blockquote
      var bq = trimmed.match(/^&gt;\s?(.*)$/);
      if (bq) {
        closeAllLists();
        out.push('<blockquote>' + renderInline(bq[1]) + '</blockquote>');
        i++;
        continue;
      }

      // horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        closeAllLists();
        out.push('<hr>');
        i++;
        continue;
      }

      // paragraph: gather consecutive non-blank, non-special lines
      closeAllLists();
      var para = [line];
      i++;
      while (i < lines.length) {
        var nxt = lines[i];
        if (!nxt.trim() || /^(```|~~~)/.test(nxt.trim()) ||
            /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|&gt;)/.test(nxt.trim())) {
          break;
        }
        para.push(nxt);
        i++;
      }
      out.push('<p>' + renderInline(para.join('\n')) + '</p>');
    }
    if (inFence) {
      out.push('\n' + fenceBuf.join('\n') + '</code></pre>');
    }
    closeAllLists();
    return out.join('\n');
  }

  window.Markdown = { render: render };
})();