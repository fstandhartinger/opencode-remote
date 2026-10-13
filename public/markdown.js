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
    // code spans: `...` (content escaped already). Park them behind placeholders
    // so the emphasis/link rules below never touch their content.
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (m, code) {
      codes.push('<code>' + code + '</code>');
      return '\u0000' + (codes.length - 1) + '\u0000';
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
    return s.replace(/\u0000(\d+)\u0000/g, function (m, n) { return codes[Number(n)]; });
  }

  function splitRow(row) {
    return row.replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
  }

  // Escaped diff lines -> one span per line, coloured by its first character.
  function diffLines(lines) {
    return lines.map(function (l) {
      var cls = 'dl';
      if (/^(\+\+\+|---|diff |index |Index: |={3,})/.test(l)) cls = 'dl dl-meta';
      else if (l[0] === '+') cls = 'dl dl-add';
      else if (l[0] === '-') cls = 'dl dl-del';
      else if (l.slice(0, 2) === '@@') cls = 'dl dl-hunk';
      return '<span class="' + cls + '">' + (l || ' ') + '</span>';
    }).join('');
  }

  // A fenced block with a header (language + copy button; the click handler is
  // delegated in views.js because the CSP forbids inline handlers).
  function codeBlock(buf, lang) {
    var isDiff = lang === 'diff' || lang === 'patch';
    var body = isDiff ? diffLines(buf) : buf.join('\n');
    return '<div class="codeblock"><div class="cb-head"><span class="cb-lang">' + attr(lang || 'text') +
      '</span><button type="button" class="copy-btn" data-copy="code">Copy</button></div>' +
      '<pre class="code' + (isDiff ? ' diff' : '') + '"><code>' + body + '</code></pre></div>';
  }

  // Render raw (unescaped) diff text, e.g. from an edit tool's metadata.
  function renderDiff(text) {
    return '<pre class="code diff"><code>' + diffLines(escapeHtml(String(text || '')).replace(/\r\n/g, '\n').split('\n')) + '</code></pre>';
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
    var fenceLang = '';

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
          fenceLang = fence[2].trim().split(/\s+/)[0] || '';
          closeAllLists();
          i++;
          continue;
        } else {
          inFence = null;
          out.push(codeBlock(fenceBuf, fenceLang));
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

      // table: | a | b | followed by a |---|---| separator row
      if (/^\|.*\|$/.test(trimmed) && i + 1 < lines.length && /^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(lines[i + 1].trim())) {
        closeAllLists();
        var head = splitRow(trimmed);
        var rows = [];
        i += 2;
        while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) {
          rows.push(splitRow(lines[i].trim()));
          i++;
        }
        var t = '<div class="table-wrap"><table><thead><tr>' +
          head.map(function (c) { return '<th>' + renderInline(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
        rows.forEach(function (r) {
          t += '<tr>' + r.map(function (c) { return '<td>' + renderInline(c) + '</td>'; }).join('') + '</tr>';
        });
        out.push(t + '</tbody></table></div>');
        continue;
      }

      // paragraph: gather consecutive non-blank, non-special lines
      closeAllLists();
      var para = [line];
      i++;
      while (i < lines.length) {
        var nxt = lines[i];
        if (!nxt.trim() || /^(```|~~~)/.test(nxt.trim()) ||
            /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|&gt;|\|)/.test(nxt.trim())) {
          break;
        }
        para.push(nxt);
        i++;
      }
      out.push('<p>' + renderInline(para.join('\n')) + '</p>');
    }
    if (inFence) {
      out.push(codeBlock(fenceBuf, fenceLang));
    }
    closeAllLists();
    return out.join('\n');
  }

  window.Markdown = { render: render, renderDiff: renderDiff, escape: escapeHtml };
})();