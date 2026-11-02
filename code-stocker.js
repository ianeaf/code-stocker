/*! code-stocker — Code Stocker: a fields panel for Squarespace Code Blocks. Original work, no dependencies. */
(function () {
  'use strict';

  /* ───────────────────────── 1. Edit-mode guard ───────────────────────── */
  var shell, SD;
  try {
    if (window.parent === window) return;                    // public site / top window
    shell = window.parent;
    SD = shell.document;                                     // throws if cross-origin
    if (!/^\/config(\/|$)/.test(shell.location.pathname)) return;
  } catch (e) { return; }

  if (shell.__codeStocker) { try { shell.__codeStocker.dispose(); } catch (e) {} }

  var PANEL_W = 320;
  var S = {                                                   // session state
    dialog: null, content: null, src: '', panel: null, body: null, status: null,
    controls: [], sig: '', open: {}, q: '', filter: 'all', timer: 0, mo: null, resyncT: 0, lastBlock: null
  };
  var disposers = [];

  /* ───────────────────────── 2. Offset-aware HTML parser ─────────────────────────
     We never re-serialise. Every element knows its exact source offsets, so edits are
     string splices and everything else (whitespace, entities, <style>, <script>) stays byte-identical. */
  var VOID = { area: 1, base: 1, br: 1, col: 1, embed: 1, hr: 1, img: 1, input: 1, link: 1, meta: 1, source: 1, track: 1, wbr: 1 };
  var RAW = { script: 1, style: 1, textarea: 1, title: 1 };
  var PCLOSE = { address: 1, article: 1, aside: 1, blockquote: 1, details: 1, div: 1, dl: 1, fieldset: 1, figure: 1, footer: 1, form: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, main: 1, nav: 1, ol: 1, p: 1, pre: 1, section: 1, table: 1, ul: 1 };
  var RE_NAME = /[A-Za-z][^\s\/>]*/y, RE_ANAME = /[^\s=>\/"']+/y, RE_END = /<\/([A-Za-z][^\s>\/]*)[^>]*>/y, RE_WS = /\s/;

  function parse(src) {
    var n = src.length;
    var root = { tag: '#root', attrs: {}, children: [], parent: null, start: 0, openEnd: 0, innerStart: 0, innerEnd: n, end: n, closed: true, stray: 0 };
    var cur = root, i = 0;
    function close(el, at, explicit, endAt) { el.innerEnd = at; el.end = endAt; el.closed = explicit; }
    while (i < n) {
      var lt = src.indexOf('<', i); if (lt < 0) break;
      var c1 = src.charAt(lt + 1);
      if (src.substr(lt, 4) === '<!--') { var ce = src.indexOf('-->', lt + 4); i = ce < 0 ? n : ce + 3; continue; }
      if (c1 === '!' || c1 === '?') { var ge = src.indexOf('>', lt); i = ge < 0 ? n : ge + 1; continue; }
      if (c1 === '/') {
        RE_END.lastIndex = lt; var m = RE_END.exec(src);
        if (!m) { i = lt + 1; continue; }
        var name = m[1].toLowerCase(), e = cur;
        while (e !== root && e.tag !== name) e = e.parent;
        if (e === root) { root.stray++; i = lt + m[0].length; continue; }
        while (cur !== e) { close(cur, lt, false, lt); cur = cur.parent; }
        close(e, lt, true, lt + m[0].length); cur = e.parent; i = lt + m[0].length; continue;
      }
      RE_NAME.lastIndex = lt + 1; var nm = RE_NAME.exec(src);
      if (!nm) { i = lt + 1; continue; }
      var tag = nm[0].toLowerCase(), j = lt + 1 + nm[0].length, attrs = {}, selfClose = false;
      for (;;) {
        var ws = j; while (j < n && RE_WS.test(src.charAt(j))) j++;
        if (j >= n || src.charAt(j) === '>') break;
        if (src.charAt(j) === '/') { if (src.charAt(j + 1) === '>') { selfClose = true; break; } j++; continue; }
        RE_ANAME.lastIndex = j; var an = RE_ANAME.exec(src);
        if (!an) { j++; continue; }
        var a = { start: ws, end: 0, vStart: -1, vEnd: -1, quote: '' }; j += an[0].length;
        var k = j; while (k < n && RE_WS.test(src.charAt(k))) k++;
        if (src.charAt(k) === '=') {
          k++; while (k < n && RE_WS.test(src.charAt(k))) k++;
          var q = src.charAt(k);
          if (q === '"' || q === "'") { var qe = src.indexOf(q, k + 1); if (qe < 0) qe = n; a.quote = q; a.vStart = k + 1; a.vEnd = qe; j = Math.min(qe + 1, n); }
          else { var vs = k; while (k < n && !/[\s>]/.test(src.charAt(k))) k++; a.vStart = vs; a.vEnd = k; j = k; }
        }
        a.end = j;
        var lname = an[0].toLowerCase(); if (!attrs[lname]) attrs[lname] = a;
      }
      if (j >= n) break;
      var tagEnd = selfClose ? j + 2 : j + 1;
      while (cur !== root && ((cur.tag === 'p' && PCLOSE[tag]) || (cur.tag === 'li' && tag === 'li') || ((cur.tag === 'dt' || cur.tag === 'dd') && (tag === 'dt' || tag === 'dd')))) { close(cur, lt, false, lt); cur = cur.parent; }
      var el = { tag: tag, attrs: attrs, parent: cur, children: [], start: lt, openEnd: j, innerStart: tagEnd, innerEnd: tagEnd, end: tagEnd, closed: true };
      cur.children.push(el);
      if (VOID[tag] || selfClose) { i = tagEnd; continue; }
      if (RAW[tag]) {
        var re = new RegExp('</' + tag + '\\s*>', 'ig'); re.lastIndex = tagEnd; var rm = re.exec(src);
        if (rm) { el.innerEnd = rm.index; el.end = rm.index + rm[0].length; } else { el.innerEnd = el.end = n; el.closed = false; }
        el.raw = true; i = el.end; continue;
      }
      cur = el; i = tagEnd;
    }
    while (cur !== root) { close(cur, n, false, n); cur = cur.parent; }
    return root;
  }
  function pathOf(el) { var p = []; while (el.parent) { p.unshift(el.parent.children.indexOf(el)); el = el.parent; } return p; }
  function find(root, path) { var e = root; for (var i = 0; i < path.length; i++) { e = e.children[path[i]]; if (!e) return null; } return e; }
  function attr(src, el, name) { var a = el.attrs[name]; return a && a.vStart >= 0 ? src.slice(a.vStart, a.vEnd) : ''; }
  function splice(src, a, b, s) { return src.slice(0, a) + s + src.slice(b); }

  /* attribute edits */
  function escAttr(v, q) { return q === "'" ? v.replace(/'/g, '&#39;') : v.replace(/"/g, '&quot;'); }
  function setAttr(src, el, name, val) {
    var a = el.attrs[name], q = a && a.quote ? a.quote : '"';
    if (a && a.vStart >= 0) return a.quote ? splice(src, a.vStart, a.vEnd, escAttr(val, q)) : splice(src, a.start, a.end, ' ' + name + '="' + escAttr(val, '"') + '"');
    if (a) return splice(src, a.start, a.end, ' ' + name + '="' + escAttr(val, '"') + '"');
    return splice(src, el.openEnd, el.openEnd, ' ' + name + '="' + escAttr(val, '"') + '"');
  }
  function removeAttr(src, el, name) { var a = el.attrs[name]; return a ? splice(src, a.start, a.end, '') : src; }

  /* ───────────────────────── 3. Field detection ───────────────────────── */
  var TEXT = { h1: 'Heading 1', h2: 'Heading 2', h3: 'Heading 3', h4: 'Heading 4', p: 'Paragraph', li: 'List item', button: 'Button label', summary: 'Question', figcaption: 'Caption' };
  var INLINE = { strong: 1, em: 1, b: 1, i: 1, a: 1, br: 1, span: 1, u: 1 };
  var TYPED_OK = { strong: 1, em: 1, b: 1, i: 1, a: 1, br: 1, u: 1 };
  var SKIP = { script: 1, style: 1, svg: 1, noscript: 1, template: 1, textarea: 1, select: 1 };

  function inlineOnly(el) { for (var i = 0; i < el.children.length; i++) { var c = el.children[i]; if (!INLINE[c.tag] || !inlineOnly(c)) return false; } return true; }
  function plain(s) { return s.replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, ''); }
  function textual(src, el) { return !el.raw && inlineOnly(el) && plain(src.slice(el.innerStart, el.innerEnd)) !== ''; }
  function onlyAnchor(src, el) {
    if (el.children.length !== 1 || el.children[0].tag !== 'a') return false;
    var a = el.children[0];
    return src.slice(el.innerStart, a.start).trim() === '' && src.slice(a.end, el.innerEnd).trim() === '';
  }
  function sig(el, d) {
    if (d > 5) return el.tag;
    return el.tag + '.' + (el.attrs['class'] ? 'c' : '') + '[' + el.children.filter(function (c) { return !SKIP[c.tag]; }).map(function (c) { return sig(c, d + 1); }).join(',') + ']';
  }
  function classKey(src, el) { return (attr(src, el, 'class') || '').trim().replace(/\s+/g, ' '); }
  function repeatable(src, el) { return el.tag === 'li' || (el.children.length > 0 && !textual(src, el) && !INLINE[el.tag]); }

  /* Build a tree of {type:'text'|'link'|'image'|'repeater'} nodes from the source. */
  function collectAll(src, root) {
    var out = [];
    collect(root, out);
    out.blocks = findBlocks();
    return out;

    /* "Blocks" = the top-level parts of the code, for the accordion. Descend through single wrapper elements. */
    function leaf(el) { return !!TEXT[el.tag] || el.tag === 'img' || el.tag === 'a'; }
    function groups(el) {
      var kids = el.children.filter(function (c) { return !SKIP[c.tag]; }), res = [];
      for (var i = 0; i < kids.length;) {
        var c = kids[i], sg = sig(c, 0) + '|' + classKey(src, c), j = i + 1;
        while (j < kids.length && sig(kids[j], 0) + '|' + classKey(src, kids[j]) === sg) j++;
        var nodes = [];
        if (j - i >= 2 && repeatable(src, c)) { var run = kids.slice(i, j), items = run.map(function (k) { var n = []; one(k, n); return { el: k, nodes: n }; }); if (items.some(function (it) { return it.nodes.length; })) res.push({ el: c, rep: true, nodes: [{ type: 'repeater', parent: el, els: run, items: items, label: groupLabel(c) }] }); i = j; continue; }
        one(c, nodes); if (nodes.length) res.push({ el: c, nodes: nodes }); i++;
      }
      return res;
    }
    function count(nodes) { var n = 0; nodes.forEach(function (x) { n += x.type === 'repeater' ? x.items.reduce(function (a, it) { return a + count(it.nodes); }, 0) : 1; }); return n; }
    function snip(n) { return src.slice(n.el.innerStart, n.el.innerEnd).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 44); }
    function firstSnippet(nodes, headingOnly) {
      var i, n, r;
      for (i = 0; i < nodes.length; i++) { n = nodes[i]; if (n.type === 'text' && /^h[1-4]$/.test(n.el.tag) && (r = snip(n))) return r; }
      for (i = 0; i < nodes.length; i++) { n = nodes[i]; if (n.type === 'repeater' && n.items.length && (r = firstSnippet(n.items[0].nodes, headingOnly))) return r; }
      if (headingOnly) return '';
      for (i = 0; i < nodes.length; i++) { n = nodes[i]; if (n.type === 'text' && (r = snip(n))) return r; }
      return '';
    }
    function kindName(nodes) {
      var t = {}; nodes.forEach(function (n) { t[n.type] = 1; });
      return t.image && !t.text ? 'Image' : (t.link && !t.text ? 'Link' : 'Section');
    }
    function findBlocks() {
      var cont = root, g = [];
      for (var d = 0; d < 6; d++) {
        g = groups(cont);
        if (g.length === 1 && !g[0].rep && !leaf(g[0].el) && g[0].el.children.length) cont = g[0].el; else break;
      }
      var blocks = [], loose = null;
      g.forEach(function (x) {
        if (!x.rep && leaf(x.el)) { if (!loose) { loose = { key: 'loose' + blocks.length, title: '', nodes: [] }; blocks.push(loose); } x.nodes.forEach(function (n) { loose.nodes.push(n); }); return; }
        loose = null;
        blocks.push({ el: x.rep ? null : x.el, key: pathOf(x.el).join('/'), title: '', nodes: x.nodes });
      });
      blocks.forEach(function (b) {
        b.count = count(b.nodes); b.sub = '';
        if (b.nodes.length === 1 && b.nodes[0].type === 'repeater') {          // a repeated group: name it by the first few entries
          var names = b.nodes[0].items.map(function (it) { return firstSnippet(it.nodes); }).filter(Boolean).slice(0, 3);
          b.title = names.length ? names.join(' · ') : b.nodes[0].label;
        } else b.title = firstSnippet(b.nodes) || kindName(b.nodes);
      });
      return blocks;
    }

    function collect(el, out) {
      var kids = el.children.filter(function (c) { return !SKIP[c.tag]; });
      for (var i = 0; i < kids.length;) {
        var c = kids[i], s = sig(c, 0) + '|' + classKey(src, c), j = i + 1;
        while (j < kids.length && sig(kids[j], 0) + '|' + classKey(src, kids[j]) === s) j++;
        if (j - i >= 2 && repeatable(src, c)) {
          var items = kids.slice(i, j).map(function (k) { var nodes = []; one(k, nodes); return { el: k, nodes: nodes }; });
          if (items.some(function (it) { return it.nodes.length; })) out.push({ type: 'repeater', parent: el, els: kids.slice(i, j), items: items, label: groupLabel(c) });
          i = j; continue;
        }
        one(c, out); i++;
      }
    }
    function one(c, out) {
      if (SKIP[c.tag]) return;
      var p = pathOf(c);
      if (c.tag === 'a' && c.attrs.href) {
        out.push({ type: 'link', path: p, el: c });
        if (c.children.length) collect(c, out);
        return;
      }
      if (c.tag === 'img') { out.push({ type: 'image', path: p, el: c }); return; }
      if (TEXT[c.tag] && textual(src, c) && !onlyAnchor(src, c)) out.push({ type: 'text', path: p, el: c });
      collect(c, out);
    }
  }
  function groupLabel(el) { return el.tag === 'li' ? 'List' : el.tag === 'a' ? 'Links' : 'Items'; }
  var src0 = '';

  /* ───────────────────────── 4. Layout safety for add/remove/reorder ───────────────────────── */
  function cssRules(root, src) {
    var css = ''; (function walk(e) { e.children.forEach(function (c) { if (c.tag === 'style') css += src.slice(c.innerStart, c.innerEnd) + '\n'; else walk(c); }); })(root);
    css = css.replace(/\/\*[\s\S]*?\*\//g, '');
    var rules = []; css.replace(/([^{}]+)\{([^{}]*)\}/g, function (m, sel, body) { rules.push({ sels: sel.split(','), body: body }); return m; });
    return rules;
  }
  function refersTo(sel, src, el) {
    var cls = classKey(src, el).split(' ').filter(Boolean), id = attr(src, el, 'id');
    if (id && sel.indexOf('#' + id) > -1) return true;
    if (cls.length) return cls.some(function (c) { return new RegExp('\\.' + c.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '(?![\\w-])').test(sel); });
    return new RegExp('(^|[\\s>+~])' + el.tag + '(?![\\w-])').test(sel);
  }
  function fixedColumns(v) {
    v = v.trim(); if (/repeat\(\s*(auto-fit|auto-fill)/i.test(v)) return false;
    if (/repeat\(\s*\d+/i.test(v)) return true;
    var depth = 0, tracks = 0, inTok = false;
    for (var i = 0; i < v.length; i++) {
      var ch = v.charAt(i);
      if (ch === '(') depth++; else if (ch === ')') depth--;
      if (depth === 0 && /\s/.test(ch)) inTok = false; else if (!inTok) { inTok = true; tracks++; }
    }
    return tracks > 1;
  }
  function layoutCheck(src, root, rep) {
    var rules = cssRules(root, src), item = rep.els[0], cont = rep.parent;
    for (var r = 0; r < rules.length; r++) {
      for (var s = 0; s < rules[r].sels.length; s++) {
        var sel = rules[r].sels[s];
        var pos = /:(nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|only-child|first-of-type|last-of-type)/.exec(sel);
        if (pos && refersTo(sel, src, item)) return 'the CSS styles items by position (:' + pos[1] + ')';
        if (cont.tag !== '#root' && refersTo(sel, src, cont)) {
          var g = /grid-template-columns\s*:\s*([^;]+)/i.exec(rules[r].body);
          if (g && fixedColumns(g[1])) return 'the layout is a fixed grid (' + g[1].trim().replace(/\s+/g, ' ') + ')';
          if (/grid-template-areas\s*:/i.test(rules[r].body)) return 'the layout uses named grid areas';
        }
      }
    }
    return '';
  }

  /* ───────────────────────── 5. CodeMirror bridge (read / write) ───────────────────────── */
  var isMac = /Mac|iPhone|iPad/.test(shell.navigator.platform || '');
  function cmView(content) {
    var c = [content, content.parentNode, content.closest && content.closest('.cm-editor')];
    for (var i = 0; i < c.length; i++) {
      var n = c[i]; if (!n) continue;
      var v = (n.cmView && (n.cmView.view || (n.cmView.rootView && n.cmView.rootView.view))) || (n.cmTile && n.cmTile.view) || (n.cmView && n.cmView.editorView);
      if (v && v.state && v.state.doc && typeof v.dispatch === 'function') return v;
    }
    return null;
  }
  function domCode(content) {
    return Array.prototype.map.call(content.querySelectorAll('.cm-line'), function (l) { return l.textContent.replace(/​/g, ''); }).join('\n');
  }
  function sendKey(content, key, code, kc) {
    var o = { key: key, code: code, keyCode: kc, which: kc, ctrlKey: !isMac, metaKey: isMac, bubbles: true, cancelable: true };
    content.dispatchEvent(new shell.KeyboardEvent('keydown', o));
  }
  function selectAll(content) { content.focus(); sendKey(content, 'a', 'KeyA', 65); }
  function isVirtual(content) {                                 // CodeMirror only keeps lines near the viewport in the DOM
    var sc = content.closest && content.closest('.cm-scroller');
    return !!content.querySelector('.cm-gap') || !!(sc && sc.scrollHeight > sc.clientHeight + 4);
  }
  /* Returns the FULL document text, or null if it cannot be read with certainty (never a partial read). */
  function readCode(content, allowCopy) {
    var v = cmView(content); if (v) return v.state.doc.toString();             // exact
    if (!isVirtual(content) && content.querySelectorAll('.cm-line').length) return domCode(content);
    if (!allowCopy) return null;
    var got = null, h = function (e) { if (e.clipboardData) got = e.clipboardData.getData('text/plain'); };
    SD.addEventListener('copy', h);                                            // CodeMirror's own copy handler serialises the whole doc
    try { selectAll(content); SD.execCommand('copy'); } catch (e) {}
    SD.removeEventListener('copy', h);
    return got;
  }
  var strategies = [
    function view(content, text) {                              // smallest possible change through CodeMirror itself
      var v = cmView(content); if (!v) return;
      var cur = v.state.doc.toString(), a = 0, max = Math.min(cur.length, text.length);
      while (a < max && cur.charCodeAt(a) === text.charCodeAt(a)) a++;
      var e = 0; while (e < max - a && cur.charCodeAt(cur.length - 1 - e) === text.charCodeAt(text.length - 1 - e)) e++;
      v.dispatch({ changes: { from: a, to: cur.length - e, insert: text.slice(a, text.length - e) }, userEvent: 'input.paste' });
    },
    function paste(content, text) {
      selectAll(content);
      var dt = new shell.DataTransfer(); dt.setData('text/plain', text);
      content.dispatchEvent(new shell.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    function insertText(content, text) { selectAll(content); SD.execCommand('insertText', false, text); },
    function beforeInput(content, text) {
      selectAll(content);
      var dt = new shell.DataTransfer(); dt.setData('text/plain', text);
      content.dispatchEvent(new shell.InputEvent('beforeinput', { inputType: 'insertFromPaste', data: null, dataTransfer: dt, bubbles: true, cancelable: true }));
    },
    function internals(content, text) {
      var v = cmView(content); if (!v) return;
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: text } });
    }
  ];
  function writeCode(content, text) {
    for (var i = 0; i < strategies.length; i++) {
      try { strategies[i](content, text); } catch (e) {}
      if (readCode(content, true) === text) return strategies[i].name;
    }
    return null;
  }

  /* ───────────────────────── 6. Panel UI ───────────────────────── */
  var CSS = [
    '.sqf{position:fixed;z-index:2147483000;width:' + PANEL_W + 'px;display:flex;flex-direction:column;background:#fff;color:#1a1a1a;border:1px solid #d6d6d6;border-radius:var(--R,6px);overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,.14);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;box-sizing:border-box}',
    '.sqf *{box-sizing:border-box}',
    '.sqf-h{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 10px;border-bottom:1px solid #ececec}',
    '.sqf-top{background:#FFD60A;color:#111;padding:12px 16px 12px;border-bottom:1px solid #111}',
    '.sqf-top .r{display:flex;justify-content:space-between;align-items:baseline}',
    '.sqf .sqf-top .sqf-s{color:#111;opacity:.7}.sqf .sqf-top .sqf-s.bad{color:#8a0000;opacity:1}',
    '.sqf-t{font-size:11px;letter-spacing:.12em;text-transform:uppercase;font-weight:700}',
    '.sqf-s{font-size:11px;color:#777}.sqf-s.bad{color:#b3261e}',
    '.sqf-tools{padding:10px 16px;border-bottom:1px solid #ececec}',
    '.sqf-chips{display:flex;gap:6px;margin-top:8px}',
    '.sqf-chip{border:1px solid #d6d6d6;background:#fff;border-radius:999px;padding:2px 10px;font:inherit;font-size:11px;cursor:pointer;color:#444}',
    '.sqf-chip[aria-pressed=true]{background:#1a1a1a;border-color:#1a1a1a;color:#fff}',
    '.sqf-b{flex:1;overflow:auto;padding:4px 16px 16px}',
    '.sqf-l{display:block;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;color:#555;margin:14px 0 6px}',
    '.sqf textarea{min-height:34px;line-height:1.4;overflow:hidden}',
    '.sqf input[type=text],.sqf textarea{width:100%;border:1px solid #cfcfcf;border-radius:var(--r,4px);padding:7px 9px;font:inherit;color:#1a1a1a;background:#fff;resize:none;display:block}',
    '.sqf input[type=text]:focus,.sqf textarea:focus{outline:none;border-color:#1a1a1a}',
    '.sqf .inv{border-color:#b3261e!important}.sqf-err{color:#b3261e;font-size:11px;margin-top:4px}',
    '.sqf-card{border:1px solid #e3e3e3;border-radius:var(--r,4px);padding:0 12px 12px;margin-top:14px}',
    '.sqf-card>.sqf-l:first-child{margin-top:12px}',
    '.sqf-row{display:flex;align-items:center;justify-content:space-between;border:1px solid #cfcfcf;border-radius:var(--r,4px);padding:8px 10px;margin-top:10px}',
    '.sqf-row span{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;color:#555}',
    '.sqf-sw{width:30px;height:18px;border-radius:9px;background:#cfcfcf;position:relative;border:0;cursor:pointer;padding:0}',
    '.sqf-sw::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:#fff;transition:left .12s}',
    '.sqf-sw[aria-checked=true]{background:#1a1a1a}.sqf-sw[aria-checked=true]::after{left:14px}',
    '.sqf-rep{margin-top:18px}',
    '.sqf-rh{display:flex;justify-content:space-between;align-items:baseline;border-bottom:1px solid #1a1a1a;padding-bottom:6px}',
    '.sqf-rh b{font-size:11px;letter-spacing:.12em;text-transform:uppercase}',
    '.sqf-note{font-size:11px;color:#777;margin-top:6px}',
    '.sqf-it{border:1px solid #e3e3e3;border-radius:var(--r,4px);margin-top:8px}',
    '.sqf-it>summary{display:flex;align-items:center;gap:6px;padding:8px 10px;cursor:pointer;font-size:12px;list-style:none}',
    '.sqf-it>summary::-webkit-details-marker{display:none}',
    '.sqf-it>summary .n{flex:1;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
    '.sqf-it>summary .k{color:#888;font-size:10.5px;letter-spacing:.08em;text-transform:uppercase}',
    '.sqf-ib{border:1px solid #cfcfcf;background:#fff;border-radius:var(--r,4px);width:22px;height:22px;line-height:1;cursor:pointer;font-size:12px;padding:0}',
    '.sqf-ib:disabled{opacity:.35;cursor:default}',
    '.sqf-in{padding:0 12px 12px}',
    '.sqf-btn{display:block;width:100%;margin-top:10px;border:1px solid #1a1a1a;background:#fff;border-radius:var(--r,4px);padding:7px;font:inherit;font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;font-weight:600;cursor:pointer}',
    '.sqf-btn.s{width:auto;display:inline-block;margin:0 0 0 8px;padding:5px 9px}',
    '.sqf-img{display:flex;gap:8px;align-items:flex-start}.sqf-img img{width:56px;height:56px;aspect-ratio:1/1;object-fit:cover;border:1px solid #e3e3e3;border-radius:var(--r,4px);background:#f3f3f3}',
    '.sqf-img>div{flex:1;min-width:0}',
    '.sqf-pick{position:absolute;inset:0;background:#fff;z-index:2;display:flex;flex-direction:column;border-radius:var(--r,4px)}',
    '.sqf-grid{flex:1;overflow:auto;padding:0 16px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(62px,1fr));gap:6px;align-content:start;grid-auto-rows:auto}',
    '.sqf-th{position:relative;display:block;width:100%;height:0;padding:0 0 100% 0;border:0;box-shadow:inset 0 0 0 1px #e3e3e3;border-radius:var(--r,4px);background:#f0f0f0;cursor:pointer;overflow:hidden}',
    '.sqf-th img{position:absolute;left:0;top:0;width:100%;height:100%;object-fit:contain;display:block}',
    '.sqf-th span{position:absolute;left:0;right:0;bottom:0;padding:10px 4px 3px;font-size:9px;line-height:1.1;color:#fff;background:linear-gradient(transparent,rgba(0,0,0,.65));overflow:hidden;white-space:nowrap;text-overflow:ellipsis;opacity:0;transition:opacity .12s;text-align:left}',
    '.sqf-th:hover span,.sqf-th:focus-visible span{opacity:1}',
    '.sqf-th:hover{box-shadow:inset 0 0 0 2px #111}',
    '.sqf [hidden]{display:none!important}',
    '.sqf .g{color:#aaa;font-size:11px;letter-spacing:-2px;opacity:0;transition:opacity .1s;width:10px;flex:none;cursor:grab;user-select:none}',
    '.sqf-bh:hover .g,.sqf-it>summary:hover .g{opacity:1}',
    '.sqf-grab{cursor:grab}.sqf-grab:active{cursor:grabbing}',
    '.sqf .dragging{opacity:.45}',
    '.sqf .drop-before{box-shadow:0 -2px 0 0 #111}.sqf .drop-after{box-shadow:0 2px 0 0 #111}',
    '.sqf.drag-blocks .sqf-bb{display:none!important}.sqf.drag-items .sqf-in{display:none!important}',
    '.sqf-blk{border:1px solid #e3e3e3;border-radius:var(--r,4px);margin-top:10px;background:#fff}',
    '.sqf-bh{display:flex;width:100%;align-items:center;gap:8px;background:none;border:0;padding:10px 12px;cursor:pointer;font:inherit;text-align:left;color:inherit}',
    '.sqf-bh .a{font-size:10px;transition:transform .12s;color:#555}.sqf-blk.on>.sqf-bh .a{transform:rotate(90deg)}',
    '.sqf-bh .t{flex:1;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12.5px;font-weight:600}',
    '.sqf-bh .s{display:block;text-transform:none;letter-spacing:0;font-weight:400;color:#777;font-size:11px;overflow:hidden;text-overflow:ellipsis}',
    '.sqf-bh .c{font-size:11px;color:#777;background:#f0f0f0;border-radius:999px;padding:1px 7px}',
    '.sqf-blk.on>.sqf-bh{border-bottom:1px solid #ececec;background:#fffbe0}',
    '.sqf-bb{display:none;padding:0 12px 12px}.sqf-blk.on>.sqf-bb,.sqf.flt .sqf-bb{display:block}',
    '.sqf-rt{display:flex;align-items:center}',
    '.sqf-plus{width:24px;height:24px;margin-left:8px;border:1px solid #111;background:#fff;border-radius:var(--r,4px);cursor:pointer;font-size:17px;line-height:1;padding:0;color:#111}',
    '.sqf-plus:hover{background:#111;color:#FFD60A}',
    '.sqf-up .sqf-im{display:flex;gap:10px;align-items:center;margin-top:12px}.sqf-up .sqf-im img{width:48px;height:48px;object-fit:contain;background:#f0f0f0;border-radius:var(--r,4px)}',
    '.sqf-up .sqf-im b{display:block;font-size:12px;word-break:break-all}',
    '.sqf-empty{color:#777;padding:18px 0;font-size:12px}',
    '.sqf-foot{border-top:1px solid #ececec;padding:8px 16px;font-size:11px;color:#777}'
  ].join('\n');

  function h(tag, props, kids) {
    var e = SD.createElement(tag), k;
    for (k in (props || {})) {
      var v = props[k];
      if (k === 'text') e.textContent = v; else if (k === 'class') e.className = v;
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? SD.createTextNode(c) : c); });
    return e;
  }
  function css() { var st = h('style', { 'data-sqf': '1', text: CSS }); SD.head.appendChild(st); return st; }

  function buildPanel() {
    var status = h('span', { class: 'sqf-s', text: 'Synced' });
    var search = h('input', { type: 'text', placeholder: 'Search content', 'aria-label': 'Search content', oninput: function () { S.q = this.value.toLowerCase(); applyFilter(); } });
    var chips = h('div', { class: 'sqf-chips' }, ['all', 'text', 'link', 'image'].map(function (f) {
      return h('button', { class: 'sqf-chip', type: 'button', 'data-f': f, 'aria-pressed': f === 'all', text: f.charAt(0).toUpperCase() + f.slice(1), onclick: function () { S.filter = f; Array.prototype.forEach.call(chips.children, function (c) { c.setAttribute('aria-pressed', c.getAttribute('data-f') === f); }); applyFilter(); } });
    }));
    var body = h('div', { class: 'sqf-b' });
    var fileI = h('input', { type: 'file', accept: 'image/*', hidden: true, onchange: function () { if (this.files && this.files[0]) addImage(this.files[0]); this.value = ''; } });
    var plus = h('button', { type: 'button', class: 'sqf-plus', text: '+', title: 'Add image (auto-compress, rename, alt text)', 'aria-label': 'Add image', onclick: function () { fileI.click(); } });
    var panel = h('div', { class: 'sqf', role: 'complementary', 'aria-label': 'Code Stocker' }, [
      h('div', { class: 'sqf-top' }, [h('div', { class: 'r' }, [h('span', { class: 'sqf-t', text: 'Code Stocker' }), h('span', { class: 'sqf-rt' }, [status, plus, fileI])])]),
      h('div', { class: 'sqf-tools' }, [search, chips]),
      body,
      h('div', { class: 'sqf-foot', text: 'Edits update the editor. Nothing is live until you click Save.' })
    ]);
    S.panel = panel; S.body = body; S.status = status; S.search = search;
    var host = canNest(S.dialog) ? S.dialog : SD.body;
    host.appendChild(panel);
    ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'focusin', 'focusout', 'contextmenu', 'dragstart', 'dragenter', 'dragover', 'dragleave', 'drop', 'dragend'].forEach(function (t) {
      panel.addEventListener(t, function (e) { e.stopPropagation(); });      // keep Squarespace's outside-click / shortcut handlers blind to the panel
    });
  }
  function canNest(dlg) {                                          // position:fixed only escapes the dialog if it has no transform-like containing block
    try {
      var c = shell.getComputedStyle(dlg);
      return (c.transform === 'none' || !c.transform) && (c.filter === 'none' || !c.filter) && (c.perspective === 'none' || !c.perspective) && (!c.contain || c.contain === 'none') && !/transform|filter|perspective/.test(c.willChange || '') && (!c.backdropFilter || c.backdropFilter === 'none');
    } catch (e) { return false; }
  }
  function setStatus(msg, bad) { if (!S.status) return; S.status.textContent = msg; S.status.className = 'sqf-s' + (bad ? ' bad' : ''); }

  /* generic control factory — every control re-reads its value from the live source */
  function track(el, get) { S.controls.push({ el: el, get: get }); return el; }

  function apply(fn) {
    var root = parse(S.src), ns = fn(S.src, root);
    if (ns == null || ns === S.src) return false;
    S.src = ns; queueWrite(); return true;
  }

  /* ── inner-text editing ──
     The box shows only what a person reads. Structural whitespace and empty decorative elements (e.g. <span class="dot"></span>)
     at either end are kept out of the box and restored untouched. Attributes of inline tags (class, href…) are hidden in the box
     and put back on write, so typing can never land "inside" a class or alter one. */
  var EMPTY_FIRST = /^<(span|i|b|em|strong|u)\b[^>]*>\s*<\/\1\s*>/i, EMPTY_LAST = /<(span|i|b|em|strong|u)\b[^>]*>\s*<\/\1\s*>$/i;
  function splitInner(raw) {
    var lead = /^\s*/.exec(raw)[0], rest = raw.slice(lead.length), m;
    while ((m = EMPTY_FIRST.exec(rest))) { var w = /^\s*/.exec(rest.slice(m[0].length))[0]; lead += m[0] + w; rest = rest.slice(m[0].length + w.length); }
    var trail = '';
    for (;;) {
      var changed = false, t = /\s*$/.exec(rest)[0];
      if (t) { trail = t + trail; rest = rest.slice(0, rest.length - t.length); changed = true; }
      m = EMPTY_LAST.exec(rest);
      if (m) { trail = m[0] + trail; rest = rest.slice(0, rest.length - m[0].length); changed = true; }
      if (!changed) break;
    }
    return { lead: lead, core: rest, trail: trail };
  }
  var RE_START = /<([a-zA-Z][\w-]*)(\s[^>]*?)?(\/?)>/g;
  function toDisplay(core) {
    return core.replace(RE_START, function (m, n, a) { return a && /[^\s\/]/.test(a) ? '<' + n + '>' : m; }).replace(/\s*\n\s*/g, ' ');
  }
  function fromDisplay(value, origCore) {                       // bare tags take their original attributes back, in order
    var q = {}; origCore.replace(RE_START, function (m, n) { (q[n.toLowerCase()] = q[n.toLowerCase()] || []).push(m); return m; });
    return value.replace(/<([a-zA-Z][\w-]*)>/g, function (m, n) { var l = q[n.toLowerCase()]; return l && l.length ? l.shift() : m; });
  }
  function bindInner(ctl, path, onErr) {
    var ws = { lead: '', trail: '' };
    function sync(src, root) {
      var e = find(root, path); if (!e) return '';
      var sp = splitInner(src.slice(e.innerStart, e.innerEnd)); ws.lead = sp.lead; ws.trail = sp.trail;
      return toDisplay(sp.core);
    }
    ctl.value = sync(S.src, parse(S.src));
    ctl.addEventListener('input', function () {
      var e = find(parse(S.src), path); if (!e) return;
      var cur = splitInner(S.src.slice(e.innerStart, e.innerEnd)).core, restored = fromDisplay(ctl.value, cur);
      var msg = lintText(restored, e, S.src);
      ctl.classList.toggle('inv', !!msg); if (onErr) onErr(msg);
      if (msg) return;
      apply(function (s2, r2) { var e2 = find(r2, path); return e2 ? splice(s2, e2.innerStart, e2.innerEnd, ws.lead + restored + ws.trail) : null; });
      refresh();
    });
    ctl.addEventListener('blur', function () {                   // accidental leading/trailing spaces never reach the code
      var t = ctl.value.replace(/^\s+|\s+$/g, ''); if (t !== ctl.value) { ctl.value = t; ctl.dispatchEvent(new shell.Event('input', { bubbles: true })); }
    });
    track(ctl, sync);
  }

  function lintText(value, el, src) {
    if (/<!|<\?/.test(value)) return 'Comments and declarations are not allowed here.';
    var had = {}; (function w(e) { e.children.forEach(function (c) { had[c.tag] = 1; w(c); }); })(el);
    var tags = value.match(/<\/?[A-Za-z][\w-]*/g) || [];
    for (var i = 0; i < tags.length; i++) { var t = tags[i].replace(/[<\/]/g, '').toLowerCase(); if (!TYPED_OK[t] && !had[t]) return '<' + t + '> is not allowed in text fields.'; }
    var r = parse(value), bad = r.stray > 0;
    (function w(e) { e.children.forEach(function (c) { if (!c.closed && !VOID[c.tag]) bad = true; w(c); }); })(r);
    return bad ? 'Unbalanced tags.' : '';
  }

  function textField(node, src) {
    var el = node.el, label = TEXT[el.tag] + (el.tag === 'p' ? (/sqsrte-large/.test(attr(src, el, 'class')) ? ' · Large' : /sqsrte-small/.test(attr(src, el, 'class')) ? ' · Small' : '') : '');
    var path = node.path;
    var ta = h('textarea', { rows: 1, 'aria-label': label });
    var err = h('div', { class: 'sqf-err', hidden: true });
    function fit() {                                              // only measurable while visible; re-run whenever a section opens
      if (!ta.offsetParent) return;
      ta.style.height = 'auto'; var sh = ta.scrollHeight + 2;
      ta.style.height = Math.max(34, Math.min(sh, 260)) + 'px'; ta.style.overflowY = sh > 260 ? 'auto' : 'hidden';
    }
    ta.__fit = fit;
    bindInner(ta, path, function (msg) { err.hidden = !msg; err.textContent = msg; });
    ta.addEventListener('input', fit);
    var wrap = h('div', { class: 'sqf-f', 'data-kind': 'text' }, [h('label', { class: 'sqf-l', text: label }), ta, err]);
    wrap.__q = function () { return label + ' ' + ta.value; };
    requestAnimationFrame(fit);
    return wrap;
  }

  function simpleInput(path, get, set, label, ph) {
    var inp = h('input', { type: 'text', 'aria-label': label, placeholder: ph || '' });
    inp.value = get(S.src, parse(S.src));
    inp.addEventListener('input', function () { apply(function (s, r) { var e = find(r, path); return e ? set(s, e, inp.value) : null; }); refresh(); });
    track(inp, function (s, r) { return get(s, r); });
    return inp;
  }

  function linkField(node, src) {
    var path = node.path, el = node.el;
    var url = simpleInput(path, function (s, r) { var e = find(r, path); return e ? attr(s, e, 'href') : ''; }, function (s, e, v) { return setAttr(s, e, 'href', v); }, 'Link URL', 'https://');
    var kids = [h('label', { class: 'sqf-l', text: 'Attach link' }), url];
    var labelOK = el.children.every(function (c) { return INLINE[c.tag] && inlineOnly(c); });
    var lab;
    if (labelOK) {
      lab = h('input', { type: 'text', 'aria-label': 'Link label' });
      bindInner(lab, path);
      kids.push(h('label', { class: 'sqf-l', text: 'Label' }), lab);
    }
    var sw = h('button', { type: 'button', class: 'sqf-sw', role: 'switch', 'aria-label': 'Open in new tab' });
    var isNew = function (s, r) { var e = find(r, path); return !!e && attr(s, e, 'target') === '_blank'; };
    sw.setAttribute('aria-checked', isNew(src, parse(src)));
    sw.addEventListener('click', function () {
      var on = sw.getAttribute('aria-checked') !== 'true';
      apply(function (s, r) {
        var e = find(r, path); if (!e) return null;
        if (!on) return attr(s, e, 'target') === '_blank' ? removeAttr(s, e, 'target') : s;
        s = setAttr(s, e, 'target', '_blank');
        var e2 = find(parse(s), path), rel = attr(s, e2, 'rel');
        if (!/\bnoopener\b/.test(rel)) s = setAttr(s, e2, 'rel', (rel ? rel + ' ' : '') + 'noopener');
        return s;
      });
      refresh();
    });
    S.controls.push({ el: sw, get: isNew, bool: true });
    kids.push(h('div', { class: 'sqf-row' }, [h('span', { text: 'Open in new tab' }), sw]));
    var card = h('div', { class: 'sqf-card sqf-f', 'data-kind': 'link' }, kids);
    card.__q = function () { return 'link ' + url.value + ' ' + (lab ? lab.value : ''); };
    return card;
  }

  function imageField(node, src) {
    var path = node.path;
    var thumb = h('img', { alt: '' });
    var srcI = simpleInput(path, function (s, r) { var e = find(r, path); return e ? attr(s, e, 'src') : ''; }, function (s, e, v) { return setAttr(s, e, 'src', v); }, 'Image source', 'Image URL');
    var altI = simpleInput(path, function (s, r) { var e = find(r, path); return e ? attr(s, e, 'alt') : ''; }, function (s, e, v) { return e.attrs.alt ? setAttr(s, e, 'alt', v) : setAttr(s, e, 'alt', v); }, 'Alt text', 'Describe the image');
    function sync() { thumb.src = srcI.value; }
    srcI.addEventListener('input', sync); sync();
    var pick = h('button', { type: 'button', class: 'sqf-btn', text: 'Choose from library', onclick: function () { openPicker(function (url) { srcI.value = url; srcI.dispatchEvent(new shell.Event('input', { bubbles: true })); }); } });
    var card = h('div', { class: 'sqf-card sqf-f', 'data-kind': 'image' }, [
      h('label', { class: 'sqf-l', text: 'Image' }),
      h('div', { class: 'sqf-img' }, [thumb, h('div', {}, [srcI])]),
      pick,
      h('label', { class: 'sqf-l', text: 'Alt text' }), altI
    ]);
    card.__q = function () { return 'image ' + srcI.value + ' ' + altI.value; };
    return card;
  }

  /* Image picker — lists images the editor already has loaded (page + shell), searchable by filename.
     Squarespace's real Asset Library is internal; hook it in via window.__codeStockerAssets (see README). */
  function assetCandidates() {
    var seen = {}, out = [];
    function add(u) {
      if (!u || /^data:/.test(u) || seen[u]) return; seen[u] = 1;
      var name = ''; try { name = decodeURIComponent(u.split('?')[0].split('/').pop()); } catch (e) { name = u; }
      out.push({ url: u, name: name });
    }
    var docs = [SD]; try { docs.push(window.document); } catch (e) {}
    docs.forEach(function (d) {
      Array.prototype.forEach.call(d.querySelectorAll('img'), function (i) { add(i.getAttribute('data-src') || i.currentSrc || i.src); });
      Array.prototype.forEach.call(d.querySelectorAll('[style*="background-image"]'), function (n) { var m = /url\(["']?([^"')]+)/.exec(n.getAttribute('style')); if (m) add(m[1]); });
    });
    try { (shell.__codeStockerAssets ? shell.__codeStockerAssets() : []).forEach(function (a) { add(typeof a === 'string' ? a : a.url); }); } catch (e) {}
    return out;
  }
  /* ── Real Asset Library (media-api.squarespace.com). Uses the editor's own login cookie + X-Library-Id. ── */
  var LIB_KEY = 'codeStocker.libId', MEDIA = 'https://media-api.squarespace.com/';
  function libIdFrom(u) { var m = /\/libraries\/([0-9a-f]{20,})/i.exec(u || ''); return m && m[1]; }
  function rememberLib(id) { if (!id) return; S.libId = id; try { shell.localStorage.setItem(LIB_KEY, id); } catch (e) {} }
  var origXHR = shell.XMLHttpRequest.prototype.open, origFetch = shell.fetch, origSRH = shell.XMLHttpRequest.prototype.setRequestHeader, myXHR, myFetch, mySRH;
  try {                                                         // passively learn the library id whenever Squarespace itself calls the media API
    myXHR = function (m, u) { try { rememberLib(libIdFrom(String(u))); } catch (e) {} return origXHR.apply(this, arguments); };
    myFetch = function (a) { try { rememberLib(libIdFrom(typeof a === 'string' ? a : a && a.url)); } catch (e) {} return origFetch.apply(this, arguments); };
    mySRH = function (k, v) { try { if (/^x-sqsp-source$/i.test(k)) S.sqspSource = v; } catch (e) {} return origSRH.apply(this, arguments); };
    shell.XMLHttpRequest.prototype.open = myXHR; shell.fetch = myFetch; shell.XMLHttpRequest.prototype.setRequestHeader = mySRH;
  } catch (e) {}
  function libCandidates() {
    var c = [S.libId], seen = {};
    try { c.push(shell.localStorage.getItem(LIB_KEY)); } catch (e) {}
    [shell, window].forEach(function (w) { try { w.performance.getEntriesByType('resource').forEach(function (r) { c.push(libIdFrom(r.name)); }); } catch (e) {} });
    try { var ctx = window.Static && window.Static.SQUARESPACE_CONTEXT; if (ctx) { c.push(ctx.website && ctx.website.id); c.push(ctx.websiteId); } } catch (e) {}
    return c.filter(function (x) { return x && /^[0-9a-f]{20,}$/i.test(x) && !seen[x] && (seen[x] = 1); });
  }
  function libGet(id, url) {
    return origFetch.call(shell, url, { credentials: 'include', headers: { 'X-Library-Id': id } }).then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); });
  }
  function norm(r) {
    var sm = r.stringMetaData || {}, nm = r.numericMetadata || {};
    var name = r.name || r.fileName || r.filename || r.originalFilename || r.title || sm.originalFilename || sm.fileName || sm.name || '';
    var d = r.createdAt ? new Date(r.createdAt) : null, date = d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';
    var dim = nm.originalWidth && nm.originalHeight ? nm.originalWidth + '×' + nm.originalHeight : '';
    var thumb = r.assetUrl + (r.assetUrl.indexOf('?') > -1 ? '&' : '?') + 'format=300w';
    return { url: r.assetUrl, thumb: thumb, name: name, label: name || [date, dim].filter(Boolean).join(' · ') || r.id, q: [name, date, dim, r.id, sm.fileExtension, r.assetSource].join(' ').toLowerCase() };
  }
  function openPicker(done) {
    S.picking = true;
    function shut() { S.picking = false; setTimeout(function () { ov.remove(); }, 0); }
    var items = [], next = '', total = 0, libId = '', busy = false, fallback = false, cache = {};
    var grid = h('div', { class: 'sqf-grid' }), sentinel = h('div', { style: 'grid-column:1/-1;min-height:28px;text-align:center;font-size:11px;color:#777;padding-top:6px' });
    var info = h('div', { class: 'sqf-note', style: 'padding:0 16px 8px' });
    var q = h('input', { type: 'text', placeholder: 'Search (date, size, name)', 'aria-label': 'Search images' });
    var manual = h('input', { type: 'text', placeholder: 'Or paste an image URL, press Enter' });
    var ov = h('div', { class: 'sqf-pick' }, [
      h('div', { class: 'sqf-h', style: 'justify-content:flex-start;gap:10px' }, [h('button', { type: 'button', class: 'sqf-ib', text: '←', 'aria-label': 'Back', onclick: shut }), h('span', { class: 'sqf-t', text: 'Asset Library' })]),
      h('div', { class: 'sqf-tools' }, [q, h('div', { style: 'height:8px' }), manual]),
      info, grid
    ]);
    function tile(a) {
      return cache[a.url] || (cache[a.url] = h('button', { type: 'button', class: 'sqf-th', title: a.label, onclick: function () { done(a.url); shut(); } }, [h('img', { src: a.thumb, alt: '', loading: 'lazy' }), h('span', { text: a.label })]));
    }
    function draw() {
      grid.textContent = '';
      var t = q.value.toLowerCase().trim(), list = items.filter(function (a) { return !t || a.q.indexOf(t) > -1; });
      list.forEach(function (a) { grid.appendChild(tile(a)); });
      sentinel.textContent = busy ? 'Loading…' : (!list.length ? 'No images found' + (next ? ' yet' : '') : '');
      grid.appendChild(sentinel);
      info.textContent = fallback ? 'Could not reach the Asset Library, showing images found on this page. Open the library once in the editor and try again.' : (total ? total + ' images in your library' : '');
      requestAnimationFrame(more);
    }
    function more() {                                           // infinite scroll: load while the end of the grid is near the viewport
      if (!next || busy || fallback || !ov.isConnected) return;
      var g = grid.getBoundingClientRect(), s = sentinel.getBoundingClientRect();
      if (s.top < g.bottom + 400) load();
    }
    function take(j) {
      var a = (j && j.assets) || {}; next = a.next || ''; total = a.total || total || 0;
      (a.assetRecords || []).forEach(function (r) { if (r && r.assetUrl && (!r.assetType || r.assetType === 'IMAGE')) items.push(norm(r)); });
    }
    function load() {
      if (busy) return; busy = true; draw();
      var go;
      if (libId) go = libGet(libId, next || MEDIA + 'user/libraries/' + libId + '/folders/root/assets?order=DESC&orderBy=CREATED_AT&assetTypes=IMAGE&limit=72&offset=0').then(take);
      else {
        var ids = libCandidates(), i = 0;
        var tryNext = function () {
          if (i >= ids.length) return Promise.reject(new Error('no library id'));
          var id = ids[i++];
          return libGet(id, MEDIA + 'user/libraries/' + id + '/folders/root/assets?order=DESC&orderBy=CREATED_AT&assetTypes=IMAGE&limit=72&offset=0').then(function (j) { libId = id; rememberLib(id); S.libId = id; take(j); }, tryNext);
        };
        go = tryNext();
      }
      go.then(function () { busy = false; draw(); }, function () {
        busy = false;
        if (!items.length) { fallback = true; items = assetCandidates().map(function (a) { return { url: a.url, thumb: a.url, name: a.name, label: a.name, q: a.name.toLowerCase() }; }); }
        draw();
      });
    }
    grid.addEventListener('scroll', more);
    q.addEventListener('input', draw);
    manual.addEventListener('keydown', function (e) { if (e.key === 'Enter' && manual.value.trim()) { done(manual.value.trim()); shut(); } });
    S.panel.appendChild(ov); draw(); load(); q.focus();
  }

  /* ── "+" add image: quick scan → compress under 500 KB → SEO file name → alt text → upload → insert ── */
  var MAXB = 500 * 1024;
  function kb(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function slug(t) { return t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60); }
  function nameAlt(base) {
    var sl = slug(base), generic = !sl || sl.length < 3 || /^\d+$/.test(sl) || /^(img|dsc|dscn|image|photo|pxl|screenshot|screen-shot|untitled|capture|download|unnamed)(-|$)/.test(sl);
    var d = new Date(), stamp = d.getFullYear() + ('0' + (d.getMonth() + 1)).slice(-2) + ('0' + d.getDate()).slice(-2);
    var name = generic ? 'image-' + stamp + '-' + Math.random().toString(36).slice(2, 6) : sl;
    var alt = generic ? 'Image' : sl.replace(/-/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); });
    return { name: name, alt: alt };
  }
  function squeeze(file) {                                      // resolves {blob, ext, changed}
    var t = file.type, ext = (t.split('/')[1] || 'img').replace('jpeg', 'jpg');
    if (!/^image\/(jpeg|png|webp)$/.test(t)) return Promise.resolve({ blob: file, ext: ext.replace('svg+xml', 'svg'), changed: false });
    return shell.createImageBitmap(file).then(function (bmp) {
      var w = bmp.width, h2 = bmp.height, scale = Math.min(1, 2400 / Math.max(w, h2));
      if (file.size <= MAXB && scale === 1) return { blob: file, ext: ext, changed: false };
      var q = 0.86, type = 'image/webp', tries = 0;
      function once() {
        var c = SD.createElement('canvas'); c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h2 * scale));
        c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
        return new Promise(function (res) { c.toBlob(res, type, q); }).then(function (b) {
          if (b && b.type !== type) { type = 'image/jpeg'; return once(); }   // browser can't encode WebP
          if (!b) throw new Error('Could not compress this image');
          if (b.size <= MAXB || ++tries > 24) return { blob: b, ext: type === 'image/webp' ? 'webp' : 'jpg', changed: true };
          if (q > 0.6) q -= 0.12; else { scale *= Math.max(0.5, Math.sqrt(MAXB / b.size) * 0.92); q = 0.7; }
          return once();
        });
      }
      return once();
    });
  }
  function deepUrl(o) {
    if (!o || typeof o !== 'object') return '';
    if (typeof o.assetUrl === 'string') return o.assetUrl;
    var k, v, r;
    for (k in o) { v = o[k]; if (typeof v === 'string' && /^https:\/\/images\.squarespace-cdn\.com\//.test(v)) return v; }
    for (k in o) { r = typeof o[k] === 'object' && deepUrl(o[k]); if (r) return r; }
    return '';
  }
  function uploadDefault(blob, name) {                          // POST media-api /uploads/image (multipart "image"); reply may be an async job
    var ids = libCandidates(); if (!ids.length) return Promise.reject(new Error('Library not found. Open the Asset Library once, then retry'));
    var id = ids[0], listUrl = MEDIA + 'user/libraries/' + id + '/folders/root/assets?order=DESC&orderBy=CREATED_AT&assetTypes=IMAGE&limit=6&offset=0';
    var before = {};
    function ping(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    function newest() { return libGet(id, listUrl).then(function (j) { return ((j && j.assets && j.assets.assetRecords) || []).filter(function (r) { return r && r.assetUrl; }); }); }
    function waitForAsset(waitMs, tries) {                      // job status URL is unknown, so watch for a new record at the top of the library
      return ping(waitMs).then(newest).then(function (recs) {
        var fresh = recs.filter(function (r) { return !before[r.id]; });
        if (fresh.length) return fresh[0].assetUrl;
        if (tries <= 1) throw new Error('Upload was accepted but the image has not appeared in the library yet. Check the Asset Library in a minute');
        return waitForAsset(Math.max(1000, waitMs), tries - 1);
      });
    }
    return newest().catch(function () { return []; }).then(function (recs) {
      recs.forEach(function (r) { before[r.id] = 1; });
      var fd = new shell.FormData(); fd.append('image', blob, name);
      var hd = { 'Accept': 'application/json', 'X-Library-Id': id }; if (S.sqspSource) hd['X-sqsp-source'] = S.sqspSource;
      return origFetch.call(shell, MEDIA + 'uploads/image', { method: 'POST', credentials: 'include', headers: hd, body: fd });
    }).then(function (r) {
      return r.text().then(function (t) {
        if (!r.ok) throw new Error('Upload failed (HTTP ' + r.status + ') ' + t.replace(/\s+/g, ' ').slice(0, 140));
        var j = null; try { j = JSON.parse(t); } catch (e) {}
        var u = deepUrl(j);
        rememberLib(id);
        if (u) return u;
        if (j && (j.jobId || j.checkStatusAfterMs)) return waitForAsset(Math.max(800, +j.checkStatusAfterMs || 1000), 30);
        throw new Error('Upload succeeded but the reply had no image URL: ' + t.replace(/\s+/g, ' ').slice(0, 140));
      });
    });
  }
  function uploadAsset(blob, name) {                            // override with window.parent.__codeStockerUpload = async (blob, name) => url
    var f = shell.__codeStockerUpload;
    return (typeof f === 'function' ? Promise.resolve(f(blob, name)) : uploadDefault(blob, name)).then(function (r) { return typeof r === 'string' ? r : r.url; });
  }
  function insertImage(url, alt) {
    apply(function (src, root) {
      var esc = function (v) { return v.replace(/"/g, '&quot;'); }, tag = '<img src="' + esc(url) + '" alt="' + esc(alt) + '">';
      var tops = root.children.filter(function (c) { return c.tag !== 'style' && c.tag !== 'script'; });
      if (!tops.length) return src + (src && !/\n$/.test(src) ? '\n' : '') + tag + '\n';
      var last = tops[tops.length - 1], at = last.innerEnd, ls = src.lastIndexOf('\n', at - 1) + 1, indent = /^[ \t]*/.exec(src.slice(ls, at))[0];
      if (ls > last.innerStart - 1 && /^[ \t]*$/.test(src.slice(ls, at))) return splice(src, ls, ls, indent + '  ' + tag + '\n');   // closing tag sits on its own line
      return splice(src, at, at, tag);
    });
  }
  function addImage(file) {
    var msg = h('div', { class: 'sqf-note', text: 'Compressing…' });
    var card = h('div', { class: 'sqf-card sqf-up' }, [h('label', { class: 'sqf-l', text: 'Adding image' }), msg]);
    S.notice = card; S.body.insertBefore(card, S.body.firstChild); S.body.scrollTop = 0;
    var meta = nameAlt(file.name.replace(/\.[^.]+$/, ''));
    squeeze(file).then(function (res) {
      var fname = meta.name + '.' + res.ext, blob = res.blob;
      var sizeTxt = res.changed ? kb(blob.size) + ' (was ' + kb(file.size) + ')' : kb(blob.size);
      msg.textContent = 'Uploading ' + fname + ' · ' + sizeTxt + '… (Squarespace may take a few seconds to process it)';
      var local = URL.createObjectURL(blob);
      return uploadAsset(blob, fname).then(function (url) {
        insertImage(url, meta.alt); render();
        var alt = meta.alt, altI = h('input', { type: 'text', 'aria-label': 'Alt text', hidden: true });
        altI.value = alt;
        var altTxt = h('div', { class: 'sqf-note', text: 'Alt: ' + alt });
        var pen = h('button', { type: 'button', class: 'sqf-ib', text: '✎', title: 'Edit alt text', 'aria-label': 'Edit alt text', onclick: function () { altI.hidden = !altI.hidden; if (!altI.hidden) altI.focus(); } });
        altI.addEventListener('input', function () {
          apply(function (s2, r2) { var found = null; (function w(e) { e.children.forEach(function (c) { if (!found && c.tag === 'img' && attr(s2, c, 'src') === url.replace(/"/g, '&quot;')) found = c; w(c); }); })(r2); return found ? setAttr(s2, found, 'alt', altI.value) : null; });
          altTxt.textContent = 'Alt: ' + altI.value; refresh();
        });
        var done = h('div', { class: 'sqf-card sqf-up' }, [h('label', { class: 'sqf-l', text: 'Image added' }),
          h('div', { class: 'sqf-im' }, [h('img', { src: local, alt: '' }), h('div', { style: 'flex:1;min-width:0' }, [h('b', { text: fname }), h('div', { class: 'sqf-note', style: 'margin:2px 0 0', text: sizeTxt }), altTxt]), pen]), altI]);
        S.notice = done; S.body.insertBefore(done, S.body.firstChild);
      }, function (err) {
        msg.textContent = err.message + '. Compressed to ' + fname + ' (' + sizeTxt + ') but not added to your code.';
        card.appendChild(h('a', { class: 'sqf-btn', href: local, download: fname, text: 'Download compressed file', style: 'text-decoration:none;text-align:center;color:inherit' }));
      });
    }).catch(function (e) { msg.textContent = 'Could not process this image: ' + e.message; });
  }

  function repeaterView(node, src, root) {
    var why = layoutCheck(src, root, node);
    var editOnly = !!why, n = node.items.length;
    var box = h('div', { class: 'sqf-rep sqf-g' });
    box.appendChild(h('div', { class: 'sqf-rh' }, [h('b', { text: node.label + ' · ' + n }), h('span', { class: 'sqf-s', text: editOnly ? 'Edit only' : '' })]));
    if (editOnly) box.appendChild(h('div', { class: 'sqf-note', text: 'Add, remove and reorder are off because ' + why + '.' }));
    var ipaths = node.items.map(function (it) { return pathOf(it.el); });
    node.items.forEach(function (it, idx) {
      var key = ipaths[idx].join('/');
      var title = firstText(it, src);
      var up = h('button', { type: 'button', class: 'sqf-ib', text: '↑', 'aria-label': 'Move up', disabled: editOnly || idx === 0, onclick: function (e) { e.preventDefault(); e.stopPropagation(); move(ipaths, idx, -1); } });
      var dn = h('button', { type: 'button', class: 'sqf-ib', text: '↓', 'aria-label': 'Move down', disabled: editOnly || idx === n - 1, onclick: function (e) { e.preventDefault(); e.stopPropagation(); move(ipaths, idx, 1); } });
      var rm = h('button', { type: 'button', class: 'sqf-ib', text: '×', 'aria-label': 'Remove', disabled: editOnly || n < 2, onclick: function (e) { e.preventDefault(); e.stopPropagation(); remove(ipaths, idx); } });
      var det = h('details', { class: 'sqf-it', 'data-k': key }, [
        h('summary', {}, [editOnly ? null : h('span', { class: 'g', text: '⋮⋮', title: 'Drag to reorder' }), h('span', { class: 'k', text: idx + 1 }), h('span', { class: 'n', text: title || 'Item ' + (idx + 1) }), editOnly ? null : up, editOnly ? null : dn, editOnly ? null : rm]),
        h('div', { class: 'sqf-in' }, renderNodes(it.nodes, src, root))
      ]);
      if (S.open[key] !== false && (S.open[key] || n <= 3 && idx === 0)) det.open = true;
      det.addEventListener('toggle', function () { S.open[key] = det.open; refit(); });
      box.appendChild(det);
    });
    if (!editOnly && n > 1) {
      var dets = Array.prototype.slice.call(box.querySelectorAll('details.sqf-it'));
      dnd(dets.map(function (d) { return { el: d, handle: d.firstChild }; }), function (f, t) {
        apply(function (s2, r2) { return reorderEls(s2, r2, ipaths, f, t); }); render();
      }, 'drag-items');
    }
    if (!editOnly) box.appendChild(h('button', { type: 'button', class: 'sqf-btn', text: '+ Add item', onclick: function () { addItem(ipaths); } }));
    return box;
  }
  function firstText(it, src) {
    for (var i = 0; i < it.nodes.length; i++) if (it.nodes[i].type === 'text') { var e = it.nodes[i].el; return plain(src.slice(e.innerStart, e.innerEnd)) ? src.slice(e.innerStart, e.innerEnd).replace(/<[^>]*>/g, '').trim().slice(0, 48) : ''; }
    return '';
  }
  function renderNodes(nodes, src, root) {
    return nodes.map(function (nd) {
      if (nd.type === 'text') return textField(nd, src);
      if (nd.type === 'link') return linkField(nd, src);
      if (nd.type === 'image') return imageField(nd, src);
      return repeaterView(nd, src, root);
    });
  }

  /* reorder: sibling elements keep their slots in the file; only their contents are permuted */
  function reorderEls(src, root, paths, from, to) {
    var els = paths.map(function (p) { return find(root, p); });
    if (els.some(function (e) { return !e; })) return null;
    var order = els.map(function (e, i) { return i; }); order.splice(to, 0, order.splice(from, 1)[0]);
    var texts = els.map(function (e) { return src.slice(e.start, e.end); }), out = src.slice(0, els[0].start);
    for (var i = 0; i < els.length; i++) { out += texts[order[i]]; if (i < els.length - 1) out += src.slice(els[i].end, els[i + 1].start); }
    return out + src.slice(els[els.length - 1].end);
  }
  function orderCheck(src, root, els) {                         // reasons reordering would change more than order
    var rules = cssRules(root, src);
    for (var r = 0; r < rules.length; r++) for (var q = 0; q < rules[r].sels.length; q++) {
      var sel = rules[r].sels[q], pos = /:(nth-child|nth-of-type|nth-last-child|nth-last-of-type|first-child|last-child|only-child|first-of-type|last-of-type)/.exec(sel);
      if (pos && els.some(function (e) { return refersTo(sel, src, e); })) return 'the CSS styles these by position (:' + pos[1] + ')';
    }
    return '';
  }
  /* drag & drop sorting. items: [{el, handle}]. onMove(from, to) gets final indices. */
  function dnd(items, onMove, cls) {
    var from = -1;
    function clear() { items.forEach(function (it) { it.el.classList.remove('dragging', 'drop-before', 'drop-after'); }); S.panel.classList.remove(cls); from = -1; }
    items.forEach(function (it, i) {
      it.handle.draggable = true; it.handle.classList.add('sqf-grab');
      it.handle.addEventListener('dragstart', function (e) {
        from = i; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', 'code-stocker'); } catch (x) {}
        try { e.dataTransfer.setDragImage(it.handle, 20, 14); } catch (x) {}
        setTimeout(function () { it.el.classList.add('dragging'); S.panel.classList.add(cls); }, 0);   // collapse bodies after the drag image is taken
      });
      it.handle.addEventListener('dragend', clear);
      it.el.addEventListener('dragover', function (e) {
        if (from < 0) return;
        e.preventDefault(); e.dataTransfer.dropEffect = 'move';
        var r = it.el.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2;
        items.forEach(function (o) { o.el.classList.remove('drop-before', 'drop-after'); });
        it.el.classList.add(after ? 'drop-after' : 'drop-before');
      });
      it.el.addEventListener('drop', function (e) {
        if (from < 0) return; e.preventDefault(); e.stopPropagation();
        var r = it.el.getBoundingClientRect(), after = e.clientY > r.top + r.height / 2, to = i + (after ? 1 : 0), f = from;
        if (f < to) to--; clear();
        if (to !== f) onMove(f, to);
      });
    });
  }

  /* structural operations (only reachable when layoutCheck passed) */
  function move(ipaths, idx, d) {
    apply(function (s, r) {
      var a = find(r, ipaths[idx]), b = find(r, ipaths[idx + d]); if (!a || !b) return null;
      if (d < 0) { var t = a; a = b; b = t; }                      // a is earlier in the file
      var A = s.slice(a.start, a.end), B = s.slice(b.start, b.end), mid = s.slice(a.end, b.start);
      return splice(s, a.start, b.end, B + mid + A);
    });
    render();
  }
  function remove(ipaths, idx) {
    apply(function (s, r) {
      var e = find(r, ipaths[idx]); if (!e) return null;
      var from = e.start; while (from > 0 && /[ \t]/.test(s.charAt(from - 1))) from--;
      if (from > 0 && s.charAt(from - 1) === '\n') from--;
      return splice(s, from, e.end, '');
    });
    render();
  }
  function addItem(ipaths) {
    apply(function (s, r) {
      var last = find(r, ipaths[ipaths.length - 1]); if (!last) return null;
      var ls = last.start; while (ls > 0 && /[ \t]/.test(s.charAt(ls - 1))) ls--;
      var gap = s.slice(ls, last.start), nl = s.charAt(ls - 1) === '\n' ? '\n' : '';
      var clone = s.slice(last.start, last.end).replace(/(\sid\s*=\s*)("[^"]*"|'[^']*')/gi, '');
      return splice(s, last.end, last.end, nl + gap + clone);
    });
    S.open[ipaths[ipaths.length - 1].slice(0, -1).concat(ipaths[ipaths.length - 1][ipaths[ipaths.length - 1].length - 1] + 1).join('/')] = true;
    render();
  }

  /* render / refresh / filter */
  function signature(nodes) { return nodes.map(function (n) { return n.type === 'repeater' ? 'R' + n.items.length + '(' + n.items.map(function (i) { return signature(i.nodes); }).join('|') + ')' : n.type[0] + n.path.join('.'); }).join(','); }
  function render() {
    if (!S.panel) return;
    var scroll = S.body.scrollTop; src0 = S.src;
    var root = parse(S.src), nodes = collectAll(S.src, root);
    S.controls = []; S.body.textContent = ''; S.sig = signature(nodes);
    if (S.notice) S.body.appendChild(S.notice);
    if (!nodes.length) S.body.appendChild(h('div', { class: 'sqf-empty', text: S.src.trim() ? 'No editable text, links or images found in this code.' : 'This Code Block is empty. Add HTML and its fields appear here.' }));
    var blocks = nodes.blocks || [], total = blocks.reduce(function (a, b) { return a + b.count; }, 0);
    if (blocks.length >= 2 && (total > 8 || blocks.length > 3)) {          // long code: one section open at a time
      if (!blocks.some(function (b) { return b.key === S.blk; }) && S.blk !== '') S.blk = blocks[0].key;
      var boxes = [];
      blocks.forEach(function (b) {
        var bh = h('div', { role: 'button', tabindex: 0, class: 'sqf-bh', 'aria-expanded': b.key === S.blk }, [
          b.el ? h('span', { class: 'g', text: '⋮⋮', title: 'Drag to reorder' }) : null,
          h('span', { class: 'a', text: '▸' }),
          h('span', { class: 't' }, [b.title, b.sub ? h('span', { class: 's', text: b.sub }) : null]),
          h('span', { class: 'c', text: b.count })]);
        var box = h('div', { class: 'sqf-blk' + (b.key === S.blk ? ' on' : ''), 'data-k': b.key }, [bh, h('div', { class: 'sqf-bb' }, renderNodes(b.nodes, S.src, root))]);
        bh.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); bh.click(); } });
        bh.addEventListener('click', function () {
          S.blk = S.blk === b.key ? '' : b.key;
          Array.prototype.forEach.call(S.body.querySelectorAll('.sqf-blk'), function (x) { var on = x.getAttribute('data-k') === S.blk; x.classList.toggle('on', on); x.firstChild.setAttribute('aria-expanded', on); });
          refit();
        });
        S.body.appendChild(box); boxes.push(box);
      });
      var mv = blocks.map(function (b, i) { return { b: b, box: boxes[i] }; }).filter(function (x) { return x.b.el; });
      if (mv.length >= 2) {
        var why = orderCheck(S.src, root, mv.map(function (x) { return x.b.el; }));
        if (why) mv.forEach(function (x) { var g = x.box.querySelector('.sqf-bh .g'); if (g) g.remove(); });
        if (why) S.body.insertBefore(h('div', { class: 'sqf-note', text: 'Reordering sections is off because ' + why + '.' }), S.notice && S.notice.parentNode === S.body ? S.notice.nextSibling : S.body.firstChild);
        else {
          var bpaths = mv.map(function (x) { return pathOf(x.b.el); });
          dnd(mv.map(function (x) { return { el: x.box, handle: x.box.firstChild }; }), function (f, t) {
            var cur = S.blk, curIdx = bpaths.map(function (p) { return p.join('/'); }).indexOf(cur);
            apply(function (s2, r2) { return reorderEls(s2, r2, bpaths, f, t); });
            if (curIdx > -1) {                                      // keep the open section open after it moves
              var ord = bpaths.map(function (p, i) { return i; }); ord.splice(t, 0, ord.splice(f, 1)[0]);
              S.blk = bpaths[ord.indexOf(curIdx)].join('/');
            }
            render();
          }, 'drag-blocks');
        }
      }
    } else renderNodes(nodes, S.src, root).forEach(function (n) { S.body.appendChild(n); });
    applyFilter(); S.body.scrollTop = scroll;
  }
  function refresh() {                                            // in-place value sync; re-render only if structure moved
    src0 = S.src;
    var root = parse(S.src), nodes = collectAll(S.src, root);
    if (signature(nodes) !== S.sig) { render(); return; }
    S.controls.forEach(function (c) {
      if (c.el === SD.activeElement) return;
      var v = c.get(S.src, root);
      if (c.bool) c.el.setAttribute('aria-checked', v); else if (c.el.value !== v) c.el.value = v;
    });
  }
  function refit() { requestAnimationFrame(function () { if (!S.body) return; Array.prototype.forEach.call(S.body.querySelectorAll('textarea'), function (t) { if (t.__fit) t.__fit(); }); }); }
  function applyFilter() {
    var fs = S.body.querySelectorAll('.sqf-f');
    Array.prototype.forEach.call(fs, function (f) {
      var okKind = S.filter === 'all' || f.getAttribute('data-kind') === S.filter;
      var okQ = !S.q || (f.__q && f.__q().toLowerCase().indexOf(S.q) > -1);
      f.hidden = !(okKind && okQ);
    });
    Array.prototype.forEach.call(S.body.querySelectorAll('details.sqf-it'), function (d) { d.hidden = !d.querySelector('.sqf-f:not([hidden])'); });
    var flt = !!(S.q || S.filter !== 'all'); S.panel.classList.toggle('flt', flt);
    Array.prototype.forEach.call(S.body.querySelectorAll('.sqf-blk'), function (b) { b.hidden = flt && !b.querySelector('.sqf-f:not([hidden])'); });
    refit();
    Array.prototype.forEach.call(S.body.querySelectorAll('.sqf-rep'), function (g) { g.hidden = (S.q || S.filter !== 'all') && !g.querySelector('.sqf-f:not([hidden])'); });
  }

  /* ───────────────────────── 7. Write queue + external-edit resync ───────────────────────── */
  function queueWrite() {
    if (S.locked) return;
    clearTimeout(S.timer); S.pending = true; setStatus('Editing…');
    S.timer = setTimeout(function () {
      S.pending = false;
      if (!S.content || !S.content.isConnected) return;
      var used = writeCode(S.content, S.src);
      if (used) { setStatus('Synced · not saved'); S.how = used; }
      else setStatus('Could not write to the editor', true);
    }, 180);
  }
  function watchContent() {
    if (S.mo) S.mo.disconnect();
    S.mo = new shell.MutationObserver(function () {
      clearTimeout(S.resyncT);
      S.resyncT = setTimeout(function () {
        if (!S.content || S.pending) return;     // never clobber an unsent edit
        var cur = readCode(S.content, false);
        if (cur === null || cur === S.src) return;
        S.src = cur; render();
      }, 400);
    });
    S.mo.observe(S.content, { childList: true, subtree: true, characterData: true });
  }

  /* ───────────────────────── 8. Dialog lifecycle ───────────────────────── */
  function findDialog() {
    var ds = SD.querySelectorAll('[role="dialog"]');
    for (var i = 0; i < ds.length; i++) if (ds[i].querySelector('.cm-editor .cm-content')) return ds[i];
    return null;
  }
  function looksLikeHtml(t) { t = t.trim(); return t === '' || t.charAt(0) === '<'; }
  function openFor(dlg) {
    var content = dlg.querySelector('.cm-editor .cm-content'), text = readCode(content, true);
    S.locked = text === null; if (S.locked) text = '';
    if (!looksLikeHtml(text)) return;                              // e.g. a CSS editor — leave alone
    S.dialog = dlg; S.content = content; S.src = text; S.open = {}; S.q = ''; S.filter = 'all';
    buildPanel(); skin(dlg); render(); watchContent(); place();
    if (S.locked) { S.body.textContent = ''; S.body.appendChild(h('div', { class: 'sqf-empty', text: 'This code is too long for Code Stocker to read safely in this editor, so it is paused and your code is untouched.' })); setStatus('Paused', true); }
  }
  function skin(dlg) {                                         // borrow the admin shell's own font and corner radii
    try {
      var cs = shell.getComputedStyle(dlg), st = S.panel.style;
      if (cs.fontFamily) st.fontFamily = cs.fontFamily;
      var R = parseFloat(cs.borderRadius); if (R > 0) st.setProperty('--R', Math.min(R, 16) + 'px');
      var ctl = dlg.querySelector('input:not([type=checkbox]):not([type=radio]), select, button'), r = ctl && parseFloat(shell.getComputedStyle(ctl).borderRadius);
      if (r > 0) st.setProperty('--r', Math.min(r, 12) + 'px');
    } catch (e) {}
  }
  function closePanel() {
    S.picking = false; S.verified = false;
    clearTimeout(S.timer); clearTimeout(S.resyncT); S.blk = undefined;
    if (S.mo) S.mo.disconnect();
    if (S.panel) S.panel.remove();
    S.panel = S.body = S.dialog = S.content = null; S.controls = [];
  }
  function place() {
    if (!S.panel || !S.dialog) return;
    var r = S.dialog.getBoundingClientRect(), W = shell.innerWidth, H = shell.innerHeight, left;
    if (r.right + 12 + PANEL_W <= W) left = r.right + 12;
    else if (r.left - 12 - PANEL_W >= 0) left = r.left - 12 - PANEL_W;
    else left = W - PANEL_W - 8;
    var top = Math.max(8, r.top), height = Math.max(240, Math.min(r.height || H - 16, H - top - 8));
    var st = S.panel.style; st.left = left + 'px'; st.top = top + 'px'; st.height = height + 'px';
    if (S.panel.parentNode !== SD.body && !S.verified) verifyMount(left, top);
  }
  function verifyMount(left, top) {                            // if nesting made the panel clipped / shifted / hidden, go back to <body>
    var pn = S.panel;
    var test = function () {
      if (!pn || !pn.isConnected || pn.parentNode === SD.body) return;
      var r = pn.getBoundingClientRect(), hit = SD.elementFromPoint(r.left + r.width / 2, r.top + Math.min(40, r.height / 2));
      var ok = r.width > 0 && Math.abs(r.left - left) < 3 && Math.abs(r.top - top) < 3 && hit && pn.contains(hit);
      if (!ok) { SD.body.appendChild(pn); if (shell.console) shell.console.warn('[code-stocker] nested mount failed, moved panel to <body>'); }
    };
    S.verified = true; setTimeout(test, 60); setTimeout(test, 600);
  }
  var ring = [];
  function rec(e) {
    ring.push((e.type) + ' ' + ((e.target && e.target.tagName) || '') + '.' + (((e.target && e.target.className) || '') + '').toString().slice(0, 30) + ' inPanel=' + !!(S.panel && S.panel.contains(e.target)) + ' @' + Math.round(performance.now()));
    if (ring.length > 12) ring.shift();
  }
  var RT = ['pointerdown', 'mousedown', 'click', 'focusin', 'focusout', 'keydown']; RT.forEach(function (t) { SD.addEventListener(t, rec, true); });
  function check() {
    var d = findDialog();
    if (S.dialog && (!S.dialog.isConnected || d !== S.dialog)) { if (S.picking && shell.console) shell.console.warn('[code-stocker] dialog closed while picker open. Last events:\n' + ring.join('\n')); closePanel(); }
    if (d && !S.dialog) openFor(d);
    else { if (S.panel && !S.panel.isConnected) SD.body.appendChild(S.panel); place(); }
  }

  /* ───────────────────────── 9. Boot ───────────────────────── */
  var styleEl = css();
  var raf = 0, mo = new shell.MutationObserver(function () { if (raf) return; raf = shell.requestAnimationFrame(function () { raf = 0; check(); }); });
  mo.observe(SD.body, { childList: true, subtree: true });
  var iv = setInterval(place, 300);
  var onDbl = function (e) { var b = e.target.closest && e.target.closest('.sqs-block-codemodule'); if (b) S.lastBlock = b.id; };
  document.addEventListener('dblclick', onDbl, true);
  shell.addEventListener('resize', place);
  check();

  function dispose() {
    try { if (shell.XMLHttpRequest.prototype.open === myXHR) shell.XMLHttpRequest.prototype.open = origXHR; if (shell.fetch === myFetch) shell.fetch = origFetch; if (shell.XMLHttpRequest.prototype.setRequestHeader === mySRH) shell.XMLHttpRequest.prototype.setRequestHeader = origSRH; } catch (e) {}
    RT.forEach(function (t) { SD.removeEventListener(t, rec, true); });
    mo.disconnect(); clearInterval(iv); closePanel(); styleEl.remove();
    document.removeEventListener('dblclick', onDbl, true); shell.removeEventListener('resize', place);
    delete shell.__codeStocker;
  }
  shell.__codeStocker = { version: '0.1.0', dispose: dispose, state: S, parse: parse, strategy: function () { return S.how; } };
})();
