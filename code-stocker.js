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
    return out;

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
  function groupLabel(el) {
    var c = classKey(src0, el).split(' ')[0];
    var base = el.tag === 'li' ? 'List' : (c ? c.replace(/^[a-z]{1,4}[-_]/i, '').replace(/[-_]+/g, ' ') : el.tag);
    return base.charAt(0).toUpperCase() + base.slice(1);
  }
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
  function readCode(content) {
    // Fast path: whole document is in the DOM (no .cm-gap spacers from virtualisation).
    if (!content.querySelector('.cm-gap') && content.querySelectorAll('.cm-line').length) return domCode(content);
    var v = cmView(content); if (v) return v.state.doc.toString();
    // Virtualised: let CodeMirror serialise the full selection through its own copy handler.
    var got = null, h = function (e) { if (e.clipboardData) got = e.clipboardData.getData('text/plain'); };
    SD.addEventListener('copy', h);
    try { selectAll(content); SD.execCommand('copy'); } catch (e) {}
    SD.removeEventListener('copy', h);
    return got != null ? got : domCode(content);
  }
  var strategies = [
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
      if (readCode(content) === text) return strategies[i].name;
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
    '.sqf-grid{flex:1;overflow:auto;padding:0 16px 16px;display:grid;grid-template-columns:1fr 1fr;gap:8px;align-content:start}',
    '.sqf-th{border:1px solid #e3e3e3;border-radius:var(--r,4px);background:#fff;padding:0;cursor:pointer;text-align:left;font:inherit;overflow:hidden}',
    '.sqf-th img{display:block;width:100%;aspect-ratio:1/1;height:auto;object-fit:cover;background:#f3f3f3}.sqf-th span{display:block;padding:4px 6px;font-size:10.5px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}',
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
    var panel = h('div', { class: 'sqf', role: 'complementary', 'aria-label': 'Code Stocker' }, [
      h('div', { class: 'sqf-top' }, [h('div', { class: 'r' }, [h('span', { class: 'sqf-t', text: 'Code Stocker' }), status])]),
      h('div', { class: 'sqf-tools' }, [search, chips]),
      body,
      h('div', { class: 'sqf-foot', text: 'Edits update the editor. Nothing is live until you click Save.' })
    ]);
    S.panel = panel; S.body = body; S.status = status; S.search = search;
    var host = canNest(S.dialog) ? S.dialog : SD.body;
    host.appendChild(panel);
    ['mousedown', 'mouseup', 'click', 'dblclick', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'focusin', 'focusout', 'contextmenu'].forEach(function (t) {
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
    function coreOf(s, root) { var e = find(root, path); if (!e) return ''; return s.slice(e.innerStart, e.innerEnd).trim(); }
    var ta = h('textarea', { rows: 1, 'aria-label': label });
    var err = h('div', { class: 'sqf-err', hidden: true });
    function fit() { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 180) + 'px'; }
    ta.value = coreOf(src, parse(src));
    ta.addEventListener('input', function () {
      var root = parse(S.src), e = find(root, path); if (!e) return;
      var msg = lintText(ta.value, e, S.src);
      ta.classList.toggle('inv', !!msg); err.hidden = !msg; err.textContent = msg;
      fit();
      if (msg) return;
      apply(function (s, r) {
        var e2 = find(r, path); if (!e2) return null;
        var raw = s.slice(e2.innerStart, e2.innerEnd), lead = /^\s*/.exec(raw)[0], trail = /\s*$/.exec(raw.slice(lead.length))[0];
        return splice(s, e2.innerStart, e2.innerEnd, lead + ta.value + trail);
      });
      refresh();
    });
    track(ta, function (s, r) { return coreOf(s, r); });
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
      var lget = function (s, r) { var e = find(r, path); return e ? s.slice(e.innerStart, e.innerEnd) : ''; };
      lab.value =lget(src, parse(src));
      lab.addEventListener('input', function () {
        var e = find(parse(S.src), path); if (!e) return;
        var msg = lintText(lab.value, e, S.src); lab.classList.toggle('inv', !!msg); if (msg) return;
        apply(function (s, r) { var e2 = find(r, path); return e2 ? splice(s, e2.innerStart, e2.innerEnd, lab.value) : null; }); refresh();
      });
      track(lab, lget);
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
  var origXHR = shell.XMLHttpRequest.prototype.open, origFetch = shell.fetch, myXHR, myFetch;
  try {                                                         // passively learn the library id whenever Squarespace itself calls the media API
    myXHR = function (m, u) { try { rememberLib(libIdFrom(String(u))); } catch (e) {} return origXHR.apply(this, arguments); };
    myFetch = function (a) { try { rememberLib(libIdFrom(typeof a === 'string' ? a : a && a.url)); } catch (e) {} return origFetch.apply(this, arguments); };
    shell.XMLHttpRequest.prototype.open = myXHR; shell.fetch = myFetch;
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
    var items = [], next = '', total = 0, libId = '', busy = false, fallback = false;
    var grid = h('div', { class: 'sqf-grid' }), more = h('button', { type: 'button', class: 'sqf-btn', text: 'Load more', onclick: function () { load(); } });
    var info = h('div', { class: 'sqf-note', style: 'padding:0 16px 8px' });
    var q = h('input', { type: 'text', placeholder: 'Search (date, size, name)', 'aria-label': 'Search images' });
    var manual = h('input', { type: 'text', placeholder: 'Or paste an image URL, press Enter' });
    var ov = h('div', { class: 'sqf-pick' }, [
      h('div', { class: 'sqf-h' }, [h('span', { class: 'sqf-t', text: 'Asset Library' }), h('button', { type: 'button', class: 'sqf-ib', text: '×', 'aria-label': 'Close', onclick: shut })]),
      h('div', { class: 'sqf-tools' }, [q, h('div', { style: 'height:8px' }), manual]),
      info, grid
    ]);
    function draw() {
      grid.textContent = '';
      var t = q.value.toLowerCase().trim(), list = items.filter(function (a) { return !t || a.q.indexOf(t) > -1; });
      if (!list.length) grid.appendChild(h('div', { class: 'sqf-empty', text: busy ? 'Loading…' : 'No images found' + (next ? ' yet. Try Load more.' : '.') }));
      list.forEach(function (a) {
        grid.appendChild(h('button', { type: 'button', class: 'sqf-th', title: a.label, onclick: function () { done(a.url); shut(); } }, [h('img', { src: a.thumb, alt: '', loading: 'lazy' }), h('span', { text: a.label })]));
      });
      if (next && !fallback) { more.disabled = busy; more.textContent = busy ? 'Loading…' : 'Load more (' + items.length + ' of ' + total + ')'; more.style.gridColumn = '1 / -1'; grid.appendChild(more); }
      info.textContent = fallback ? 'Could not reach the Asset Library, showing images found on this page. Open the library once in the editor and try again.' : (total ? total + ' images in your library' : '');
    }
    function take(j) {
      var a = (j && j.assets) || {}; next = a.next || ''; total = a.total || total || 0;
      (a.assetRecords || []).forEach(function (r) { if (r && r.assetUrl && (!r.assetType || r.assetType === 'IMAGE')) items.push(norm(r)); });
    }
    function load() {
      if (busy) return; busy = true; draw();
      var go;
      if (libId) go = libGet(libId, next || MEDIA + 'user/libraries/' + libId + '/folders/root/assets?order=DESC&orderBy=CREATED_AT&assetTypes=IMAGE&limit=72&offset=0').then(take);
      else {                                                    // find a library id that the API accepts
        var ids = libCandidates(), i = 0;
        var tryNext = function () {
          if (i >= ids.length) return Promise.reject(new Error('no library id'));
          var id = ids[i++];
          return libGet(id, MEDIA + 'user/libraries/' + id + '/folders/root/assets?order=DESC&orderBy=CREATED_AT&assetTypes=IMAGE&limit=72&offset=0').then(function (j) { libId = id; rememberLib(id); take(j); }, tryNext);
        };
        go = tryNext();
      }
      go.then(function () { busy = false; draw(); }, function () {
        busy = false;
        if (!items.length) { fallback = true; items = assetCandidates().map(function (a) { return { url: a.url, thumb: a.url, name: a.name, label: a.name, q: a.name.toLowerCase() }; }); }
        draw();
      });
    }
    q.addEventListener('input', draw);
    manual.addEventListener('keydown', function (e) { if (e.key === 'Enter' && manual.value.trim()) { done(manual.value.trim()); shut(); } });
    S.panel.appendChild(ov); draw(); load(); q.focus();
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
        h('summary', {}, [h('span', { class: 'k', text: idx + 1 }), h('span', { class: 'n', text: title || 'Item ' + (idx + 1) }), editOnly ? null : up, editOnly ? null : dn, editOnly ? null : rm]),
        h('div', { class: 'sqf-in' }, renderNodes(it.nodes, src, root))
      ]);
      if (S.open[key] !== false && (S.open[key] || n <= 3 && idx === 0)) det.open = true;
      det.addEventListener('toggle', function () { S.open[key] = det.open; });
      box.appendChild(det);
    });
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
    if (!nodes.length) S.body.appendChild(h('div', { class: 'sqf-empty', text: S.src.trim() ? 'No editable text, links or images found in this code.' : 'This Code Block is empty. Add HTML and its fields appear here.' }));
    renderNodes(nodes, S.src, root).forEach(function (n) { S.body.appendChild(n); });
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
  function applyFilter() {
    var fs = S.body.querySelectorAll('.sqf-f');
    Array.prototype.forEach.call(fs, function (f) {
      var okKind = S.filter === 'all' || f.getAttribute('data-kind') === S.filter;
      var okQ = !S.q || (f.__q && f.__q().toLowerCase().indexOf(S.q) > -1);
      f.hidden = !(okKind && okQ);
    });
    Array.prototype.forEach.call(S.body.querySelectorAll('details.sqf-it'), function (d) { d.hidden = !d.querySelector('.sqf-f:not([hidden])'); });
    Array.prototype.forEach.call(S.body.querySelectorAll('.sqf-rep'), function (g) { g.hidden = (S.q || S.filter !== 'all') && !g.querySelector('.sqf-f:not([hidden])'); });
  }

  /* ───────────────────────── 7. Write queue + external-edit resync ───────────────────────── */
  function queueWrite() {
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
        var cur = readCode(S.content);
        if (cur === S.src) return;
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
    var content = dlg.querySelector('.cm-editor .cm-content'), text = readCode(content);
    if (!looksLikeHtml(text)) return;                              // e.g. a CSS editor — leave alone
    S.dialog = dlg; S.content = content; S.src = text; S.open = {}; S.q = ''; S.filter = 'all';
    buildPanel(); skin(dlg); render(); watchContent(); place();
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
    clearTimeout(S.timer); clearTimeout(S.resyncT);
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
    try { if (shell.XMLHttpRequest.prototype.open === myXHR) shell.XMLHttpRequest.prototype.open = origXHR; if (shell.fetch === myFetch) shell.fetch = origFetch; } catch (e) {}
    RT.forEach(function (t) { SD.removeEventListener(t, rec, true); });
    mo.disconnect(); clearInterval(iv); closePanel(); styleEl.remove();
    document.removeEventListener('dblclick', onDbl, true); shell.removeEventListener('resize', place);
    delete shell.__codeStocker;
  }
  shell.__codeStocker = { version: '0.1.0', dispose: dispose, state: S, parse: parse, strategy: function () { return S.how; } };
})();
