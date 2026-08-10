/* 统一弹窗组件：window.uiConfirm / uiAlert / uiPrompt —— Element-UI 风格，替代原生 confirm/alert/prompt。
   所有管理端页面在 nav.js 之前 <script defer> 引入（nav.js 的改密也用它）。 */
(function () {
  if (window.uiConfirm) return;
  var css = ''
    + '.ui-mask{position:fixed;inset:0;background:rgba(15,39,68,.45);z-index:9000;display:flex;align-items:flex-start;justify-content:center;opacity:0;transition:opacity .16s}'
    + '.ui-mask.on{opacity:1}'
    + '.ui-dlg{margin-top:15vh;width:min(420px,92vw);background:#fff;border-radius:12px;box-shadow:0 14px 44px rgba(15,39,68,.22);transform:translateY(-14px) scale(.98);transition:transform .16s;overflow:hidden;font-family:inherit}'
    + '.ui-mask.on .ui-dlg{transform:none}'
    + '.ui-dlg-h{display:flex;align-items:center;gap:10px;padding:17px 20px 8px;font-size:16px;font-weight:700;color:#1B2430}'
    + '.ui-dlg-h .ui-ic{width:21px;height:21px;flex:0 0 auto;display:grid;place-items:center;border-radius:50%;font-size:13px;font-weight:700;color:#fff;line-height:1}'
    + '.ui-dlg-b{padding:2px 20px 18px 51px;font-size:14px;line-height:1.65;color:#5B6675;white-space:pre-wrap;word-break:break-word}'
    + '.ui-dlg-b.no-ic{padding-left:20px}'
    + '.ui-dlg-b input{width:100%;margin-top:11px;border:1px solid #CBD3DD;border-radius:8px;padding:9px 11px;font-size:14px;color:#1B2430;outline:none;box-sizing:border-box;font-family:inherit}'
    + '.ui-dlg-b input:focus{border-color:#1A6DBE;box-shadow:0 0 0 3px rgba(26,109,190,.14)}'
    + '.ui-dlg-f{display:flex;justify-content:flex-end;gap:10px;padding:4px 20px 18px}'
    + '.ui-btn{border:1px solid #CBD3DD;background:#fff;color:#5B6675;font-size:13.5px;font-weight:600;border-radius:8px;padding:8px 18px;cursor:pointer;transition:.12s;font-family:inherit}'
    + '.ui-btn:hover{border-color:#93A0AE;color:#1B2430}'
    + '.ui-btn.pri{background:#1A6DBE;border-color:#1A6DBE;color:#fff}.ui-btn.pri:hover{background:#155A9E;border-color:#155A9E}'
    + '.ui-btn.danger{background:#C0392B;border-color:#C0392B;color:#fff}.ui-btn.danger:hover{background:#a93226;border-color:#a93226}'
    + '.ui-ic.q,.ui-ic.info{background:#1A6DBE}.ui-ic.warn{background:#E08A1E}.ui-ic.err{background:#C0392B}.ui-ic.ok{background:#1E9E63}'
    + '.ui-pw{position:relative;margin-top:11px}.ui-pw input{margin-top:0;padding-right:40px}'
    + '.ui-pw-eye{position:absolute;top:0;right:6px;height:100%;width:30px;display:flex;align-items:center;justify-content:center;padding:0;border:none;background:transparent;color:#8A94A6;cursor:pointer}'
    + '.ui-pw-eye:hover{color:#1A6DBE}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  function open(o) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div'); mask.className = 'ui-mask';
      var chars = { warn: '!', err: '✕', q: '?', ok: '✓', info: 'i' };
      var showIcon = o.type !== 'none';
      var iconHtml = showIcon ? '<span class="ui-ic ' + (o.type || 'info') + '">' + (chars[o.type] || 'i') + '</span>' : '';
      var isPw = o.input && (o.inputType === 'password');
      var phAttr = o.inputPlaceholder ? ' placeholder="' + esc(o.inputPlaceholder) + '"' : '';
      var eyeShow = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="2.2"></circle><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"></path></svg>';
      var eyeHide = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"></path><path d="M10.6 10.6a2 2 0 0 0 2.8 2.8"></path><path d="M9.8 5.1A9.5 9.5 0 0 1 12 5c6.5 0 10 7 10 7a13.6 13.6 0 0 1-2.2 2.9M6.2 6.2A13.4 13.4 0 0 0 2 12s3.5 7 10 7a9.4 9.4 0 0 0 3.7-.7"></path></svg>';
      var inputHtml = o.input
        ? (isPw
            ? '<div class="ui-pw"><input type="password"' + phAttr + '><button type="button" class="ui-pw-eye" tabindex="-1" aria-label="显示密码">' + eyeShow + '</button></div>'
            : '<input type="' + (o.inputType || 'text') + '"' + phAttr + '>')
        : '';
      mask.innerHTML =
        '<div class="ui-dlg" role="dialog" aria-modal="true">'
        + '<div class="ui-dlg-h">' + iconHtml + esc(o.title) + '</div>'
        + '<div class="ui-dlg-b' + (showIcon ? '' : ' no-ic') + '">' + esc(o.message) + inputHtml + '</div>'
        + '<div class="ui-dlg-f">'
        + (o.showCancel ? '<button class="ui-btn" data-act="cancel">' + esc(o.cancelText) + '</button>' : '')
        + '<button class="ui-btn ' + (o.danger ? 'danger' : 'pri') + '" data-act="ok">' + esc(o.okText) + '</button>'
        + '</div></div>';
      document.body.appendChild(mask);
      requestAnimationFrame(function () { mask.classList.add('on'); });
      var inp = mask.querySelector('input');
      if (inp) { inp.value = o.inputValue || ''; setTimeout(function () { inp.focus(); inp.select(); }, 30); }
      var pwEye = mask.querySelector('.ui-pw-eye');
      if (pwEye && inp) {
        pwEye.addEventListener('click', function () {
          var reveal = inp.type === 'password';
          inp.type = reveal ? 'text' : 'password';
          pwEye.innerHTML = reveal ? eyeHide : eyeShow;
          pwEye.setAttribute('aria-label', reveal ? '隐藏密码' : '显示密码');
          inp.focus();
        });
      }
      function done(val) { mask.classList.remove('on'); document.removeEventListener('keydown', onKey); setTimeout(function () { mask.remove(); }, 170); resolve(val); }
      function ok() { done(o.input ? inp.value : true); }
      function cancel() { done(o.input ? null : false); }
      mask.addEventListener('click', function (e) { if (e.target === mask) return cancel(); var a = e.target.closest('[data-act]'); if (!a) return; a.dataset.act === 'ok' ? ok() : cancel(); });
      function onKey(e) { if (e.key === 'Escape') cancel(); else if (e.key === 'Enter' && (!o.input || document.activeElement === inp)) { e.preventDefault(); ok(); } }
      document.addEventListener('keydown', onKey);
    });
  }
  window.uiConfirm = function (message, opts) { opts = opts || {}; return open({ title: opts.title || '确认', message: message, type: opts.danger ? 'warn' : 'q', showCancel: true, okText: opts.okText || '确定', cancelText: opts.cancelText || '取消', danger: !!opts.danger }).then(function (v) { return v === true; }); };
  window.uiAlert = function (message, opts) { opts = opts || {}; return open({ title: opts.title || '提示', message: message, type: opts.type || 'info', showCancel: false, okText: opts.okText || '知道了' }).then(function () { }); };
  window.uiPrompt = function (message, opts) { opts = opts || {}; return open({ title: opts.title || '请输入', message: message, type: 'q', showCancel: true, input: true, inputType: opts.inputType || 'text', inputValue: opts.value || '', inputPlaceholder: opts.placeholder || '', okText: opts.okText || '确定', cancelText: opts.cancelText || '取消' }); };
})();

// 共享 markdown 渲染：window.mdToHtml —— 提交页、经验库、详情页统一用（先转义再解析，安全）
window.mdToHtml = function (src) {
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const blocks = [];
  src = String(src == null ? '' : src).replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, (m, c) => { blocks.push(c.replace(/\n$/, '')); return 'CODE' + (blocks.length - 1) + ''; });
  const inline = t => {
    t = esc(t);
    t = t.replace(/`([^`]+)`/g, (m, c) => '<code>' + c + '</code>');
    t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return t;
  };
  const splitTableRow = row => {
    let s = String(row == null ? '' : row).trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = []; let cur = '';
    for (let x = 0; x < s.length; x++) {
      if (s[x] === '\\' && s[x + 1] === '|') { cur += '|'; x++; continue; }
      if (s[x] === '|') { cells.push(cur.trim()); cur = ''; continue; }
      cur += s[x];
    }
    cells.push(cur.trim());
    return cells;
  };
  const tableAlign = cell => {
    const s = String(cell || '').trim();
    if (!/^:?-{3,}:?$/.test(s)) return null;
    return s.startsWith(':') && s.endsWith(':') ? 'center' : (s.endsWith(':') ? 'right' : 'left');
  };
  const tableAt = (lines, idx) => {
    if (idx + 1 >= lines.length || !lines[idx].includes('|')) return null;
    const heads = splitTableRow(lines[idx]), divs = splitTableRow(lines[idx + 1]);
    if (!heads.length || heads.length !== divs.length) return null;
    const aligns = divs.map(tableAlign);
    return aligns.every(a => a != null) ? { heads, aligns } : null;
  };
  const cbRe = /^CODE(\d+)$/, ulRe = /^\s*[-*+•–]\s+/, olRe = /^\s*\d+[.、)]\s+/;
  const L = src.split('\n'); let h = '', i = 0;
  const isBreak = (s, idx) => /^\s*$/.test(s) || /^\s*#{1,4}\s/.test(s) || ulRe.test(s) || olRe.test(s) || /^\s*>\s?/.test(s) || cbRe.test(s) || /^\s*(?:-{3,}|\*{3,})\s*$/.test(s) || !!tableAt(L, idx);
  while (i < L.length) {
    const ln = L[i]; const cb = ln.match(cbRe);
    if (cb) { h += '<pre><code>' + esc(blocks[+cb[1]]) + '</code></pre>'; i++; continue; }
    if (/^\s*$/.test(ln)) { i++; continue; }
    const tbl = tableAt(L, i);
    if (tbl) {
      const th = tbl.heads.map((cell, ci) => '<th class="md-align-' + tbl.aligns[ci] + '">' + inline(cell) + '</th>').join('');
      const rows = []; i += 2;
      while (i < L.length && L[i].trim() !== '' && L[i].includes('|')) {
        let cells = splitTableRow(L[i]);
        while (cells.length < tbl.heads.length) cells.push('');
        cells = cells.slice(0, tbl.heads.length);
        rows.push('<tr>' + cells.map((cell, ci) => '<td class="md-align-' + tbl.aligns[ci] + '">' + inline(cell) + '</td>').join('') + '</tr>');
        i++;
      }
      h += '<div class="md-table-wrap" role="region" aria-label="Markdown 表格" tabindex="0"><table class="md-table"><thead><tr>' + th + '</tr></thead><tbody>' + rows.join('') + '</tbody></table></div>';
      continue;
    }
    if (/^\s*(?:-{3,}|\*{3,})\s*$/.test(ln)) { h += '<hr class="md-divider">'; i++; continue; }
    const hm = ln.match(/^\s*(#{1,4})\s+(.*)$/); if (hm) { const lv = hm[1].length; h += '<h' + lv + '>' + inline(hm[2]) + '</h' + lv + '>'; i++; continue; }
    if (/^\s*>\s?/.test(ln)) { const b = []; while (i < L.length && /^\s*>\s?/.test(L[i])) { b.push(L[i].replace(/^\s*>\s?/, '')); i++; } h += '<blockquote>' + b.map(inline).join('<br>') + '</blockquote>'; continue; }
    if (ulRe.test(ln)) { h += '<ul>'; while (i < L.length && ulRe.test(L[i])) { h += '<li>' + inline(L[i].replace(ulRe, '')) + '</li>'; i++; } h += '</ul>'; continue; }
    if (olRe.test(ln)) { h += '<ol>'; while (i < L.length && olRe.test(L[i])) { h += '<li>' + inline(L[i].replace(olRe, '')) + '</li>'; i++; } h += '</ol>'; continue; }
    const b = []; while (i < L.length && !isBreak(L[i], i)) { b.push(L[i]); i++; } h += '<p>' + b.map(inline).join('<br>') + '</p>';
  }
  return h;
};

// 管道表格的共享视觉：横向滚动而不是撑破窄屏；所有使用 ui.js 的页面自动获得。
(function () {
  if (window.__mdTableStyles) return;
  window.__mdTableStyles = true;
  var st = document.createElement('style'); st.setAttribute('data-md-table', '');
  st.textContent = '.md-body{min-width:0;max-width:100%;box-sizing:border-box;overflow-wrap:anywhere;word-break:break-word}'
    + '.md-body pre{max-width:100%;box-sizing:border-box;overflow-x:auto;white-space:pre}'
    + '.md-body :not(pre)>code{white-space:normal;overflow-wrap:anywhere;word-break:break-word}'
    + '.md-table-wrap{width:100%;min-width:0;max-width:100%;box-sizing:border-box;overflow-x:auto;-webkit-overflow-scrolling:touch;margin:8px 0;border:1px solid #D9E0E8;border-radius:8px;background:#fff}'
    + '.md-table{width:max-content;min-width:100%;border-collapse:collapse;line-height:1.5}'
    + '.md-table th,.md-table td{min-width:8em;padding:8px 10px;border-right:1px solid #D9E0E8;border-bottom:1px solid #D9E0E8;text-align:left;vertical-align:top;white-space:normal}'
    + '.md-table th{background:#F5F7FA;color:#1B2430;font-weight:700}.md-table tr:last-child td{border-bottom:0}'
    + '.md-table th:last-child,.md-table td:last-child{border-right:0}.md-table .md-align-center{text-align:center}.md-table .md-align-right{text-align:right}'
    + '.md-divider{border:0;border-top:1px solid #D9E0E8;margin:10px 0}';
  document.head.appendChild(st);
})();

/* 自定义下拉：接管带 .fancy 的原生 <select>，弹层用浅色 div 画（挂 body + fixed 定位，避免容器 overflow 裁剪）。
   保留原 select 的 value / change 语义，代码里 sel.value=.. 与 innerHTML 换选项都会自动同步显示。
   用法：给 <select> 加 class="fancy"，本脚本 DOM 就绪后自动增强。 */
(function () {
  if (window.enhanceSelect) return;
  function enhanceSelect(sel) {
    if (!sel || sel.dataset.enhanced || sel.multiple) return;
    sel.dataset.enhanced = '1';
    var wrap = document.createElement('div'); wrap.className = 'sel-wrap';
    sel.parentNode.insertBefore(wrap, sel); wrap.appendChild(sel);
    var btn = document.createElement('button'); btn.type = 'button'; btn.className = 'sel-btn';
    var txt = document.createElement('span'); txt.className = 'sel-txt';
    var chev = document.createElement('i'); chev.className = 'ti ti-chevron-down sel-chev';
    btn.appendChild(txt); btn.appendChild(chev); wrap.appendChild(btn);
    var pop = document.createElement('div'); pop.className = 'sel-pop'; pop.style.display = 'none';
    function curOpt() { var i = sel.selectedIndex; return i >= 0 ? sel.options[i] : null; }
    function syncLabel() { var o = curOpt(); txt.textContent = o ? o.textContent : ''; txt.classList.toggle('ph', !o || o.value === ''); wrap.classList.toggle('disabled', sel.disabled); }
    function buildPop() {
      pop.innerHTML = ''; var opts = sel.options, ci = sel.selectedIndex;
      for (var i = 0; i < opts.length; i++) (function (i, o) {
        var it = document.createElement('div'); it.className = 'sel-opt' + (i === ci ? ' cur' : '');
        var lb = document.createElement('span'); lb.textContent = o.textContent; lb.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis';
        var ck = document.createElement('i'); ck.className = 'ti ti-check sel-ck';
        it.appendChild(lb); it.appendChild(ck);
        it.addEventListener('click', function () { if (!sel.disabled && sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('change', { bubbles: true })); } syncLabel(); close(); });
        pop.appendChild(it);
      })(i, opts[i]);
    }
    function place() {
      var r = btn.getBoundingClientRect(); pop.style.minWidth = r.width + 'px'; pop.style.left = r.left + 'px';
      var below = window.innerHeight - r.bottom, need = Math.min(pop.scrollHeight || 300, 300);
      if (below < need + 8 && r.top > below) { pop.style.top = 'auto'; pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
      else { pop.style.bottom = 'auto'; pop.style.top = (r.bottom + 4) + 'px'; }
    }
    function open() {
      if (sel.disabled || !sel.options.length) return;
      buildPop(); document.body.appendChild(pop); pop.style.display = 'block'; place(); wrap.classList.add('open');
      setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
      window.addEventListener('scroll', close, true); window.addEventListener('resize', close);
    }
    function close() {
      if (!wrap.classList.contains('open')) return;
      wrap.classList.remove('open'); pop.style.display = 'none'; if (pop.parentNode) pop.parentNode.removeChild(pop);
      document.removeEventListener('mousedown', outside, true); window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close);
    }
    function outside(e) { if (!wrap.contains(e.target) && !pop.contains(e.target)) close(); }
    btn.addEventListener('click', function (e) { e.preventDefault(); wrap.classList.contains('open') ? close() : open(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    new MutationObserver(function () { syncLabel(); if (wrap.classList.contains('open')) buildPop(); }).observe(sel, { childList: true });
    new MutationObserver(syncLabel).observe(sel, { attributes: true, attributeFilter: ['disabled'] });
    var vd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(sel, 'value', { configurable: true, get: function () { return vd.get.call(sel); }, set: function (v) { vd.set.call(sel, v); syncLabel(); } });
    var sid = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
    Object.defineProperty(sel, 'selectedIndex', { configurable: true, get: function () { return sid.get.call(sel); }, set: function (v) { sid.set.call(sel, v); syncLabel(); } });
    syncLabel();
  }
  window.enhanceSelect = enhanceSelect;
  function enhanceAll() { var l = document.querySelectorAll('select.fancy'); for (var i = 0; i < l.length; i++) enhanceSelect(l[i]); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', enhanceAll); else enhanceAll();
})();

/* ============================================================
   运营端统一自定义下拉：接管所有 <select class="select">（UI-01 · 2026-07-23 裁决）
   —— 用自定义面板替代 OS 原生下拉弹窗，复用 theme.css 设计 token。
   机制：MutationObserver(document.body,subtree) + 初次扫描，凡 select.select:not([data-enh])
        都增强；data-enh 防重；原生 <select> 保留在 DOM 作数据源（选中回写 value + 派发
        change{bubbles:true}），故各页 select.value / addEventListener('change') 逻辑不变。
   面板 position:fixed 挂 body（逃祖先 overflow 裁剪，实施端下拉踩过的老坑）+ z-index:9600
        （盖过 drawer/modal 300/310 与 ui.js 弹窗 9000）。支持 optgroup / 键盘 / 值同步 / 优雅降级。
   注意：只接管 .select（运营后台），不碰 submit.html 的 .fancy（上面那套）；实施端 field.html
        自带独立下拉、且不引 ui.js，天然隔离。样式由本文件注入 <style data-ui-sel>。
   ============================================================ */
(function () {
  if (window.enhanceUiSelect) return;
  // —— 注入组件样式（用 theme.css token；trigger 复刻收起态 .select 外观）——
  var CSS = ''
    + '.ui-sel-wrap{position:relative;display:inline-block;width:100%;min-width:0}'
    + '.ui-sel-trigger{width:100%;height:34px;box-sizing:border-box;display:flex;align-items:center;gap:6px;'
    +   'padding:0 30px 0 12px;border:1px solid var(--color-border-strong,#CBD3DD);border-radius:var(--radius,6px);'
    +   'background:var(--color-surface,#fff);font-size:13px;color:var(--color-text,#1F2733);font-family:inherit;'
    +   'text-align:left;cursor:pointer;outline:none;transition:border-color .12s,box-shadow .12s;position:relative}'
    + '.ui-sel-trigger:focus,.ui-sel-wrap.open .ui-sel-trigger{border-color:var(--color-primary,#0F2744);box-shadow:var(--shadow-focus,0 0 0 3px rgba(15,39,68,.18))}'
    + '.ui-sel-trigger.disabled{background:var(--color-bg,#F5F7FA);color:var(--color-text-tertiary,#98A1AD);cursor:not-allowed;box-shadow:none}'
    + '.ui-sel-txt{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
    + '.ui-sel-txt.ph{color:var(--color-text-tertiary,#98A1AD)}'
    + '.ui-sel-chev{position:absolute;right:10px;top:50%;transform:translateY(-50%);width:16px;height:16px;flex:0 0 auto;'
    +   'pointer-events:none;color:var(--color-text-secondary,#5A6573);transition:transform .15s}'
    + '.ui-sel-wrap.open .ui-sel-chev{transform:translateY(-50%) rotate(180deg)}'
    // filter-bar 里收小到 30px / 12.5px（镜像 theme.css 的 .filter-bar .select 规则）
    + '.filter-bar .ui-sel-trigger{height:30px;font-size:12.5px;padding-right:28px}'
    + '.filter-bar .ui-sel-chev{right:8px}'
    // 面板
    + '.ui-sel-pop{position:fixed;z-index:9600;background:var(--color-surface,#fff);border:1px solid var(--color-border,#E3E8EF);'
    +   'border-radius:var(--radius,6px);box-shadow:var(--shadow-card-hover,0 6px 22px rgba(15,39,68,.14));'
    +   'max-height:280px;overflow-y:auto;overflow-x:hidden;padding:4px;font-size:13px;color:var(--color-text,#1F2733);'
    +   'font-family:inherit;box-sizing:border-box}'
    + '.ui-sel-grp{padding:6px 10px 3px;font-size:11px;font-weight:600;letter-spacing:.4px;text-transform:uppercase;'
    +   'color:var(--color-text-tertiary,#98A1AD);pointer-events:none}'
    + '.ui-sel-opt{display:flex;align-items:center;gap:8px;padding:7px 10px;border-radius:var(--radius,6px);cursor:pointer;'
    +   'line-height:1.3;white-space:normal;word-break:break-word}'
    + '.ui-sel-opt:hover,.ui-sel-opt.hl{background:var(--color-surface-alt,#FAFBFD)}'
    + '.ui-sel-opt.on{background:var(--color-primary-light,#E8EDF3);color:var(--color-primary,#0F2744);font-weight:600}'
    + '.ui-sel-opt.on:hover,.ui-sel-opt.on.hl{background:var(--color-primary-light,#E8EDF3)}'
    + '.ui-sel-opt.sub{padding-left:22px}'
    + '.ui-sel-opt-lb{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}'
    + '.ui-sel-check{flex:0 0 auto;width:15px;height:15px;opacity:0;color:var(--color-primary,#0F2744)}'
    + '.ui-sel-opt.on .ui-sel-check{opacity:1}'
    + '.ui-sel-empty{padding:12px 10px;color:var(--color-text-tertiary,#98A1AD);text-align:center}';
  try { var st = document.createElement('style'); st.setAttribute('data-ui-sel', '1'); st.textContent = CSS; (document.head || document.documentElement).appendChild(st); } catch (e) {}

  var CHEV = '<svg class="ui-sel-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
  var CHECK = '<svg class="ui-sel-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';

  function enhanceUiSelect(sel) {
    if (!sel || sel.dataset.enh || sel.multiple) return;
    // multiple 明确留原生（size>1 的多选同理）
    try {
      sel.dataset.enh = '1';
      // wrapper：插到 select 前，把 select 移进去
      var wrap = document.createElement('div');
      wrap.className = 'ui-sel-wrap';
      // 继承原 select 的行内 width（如 kb page-size width:auto）与非 .select 的附带 class（如 cprod 的 flex）
      if (sel.style && sel.style.width) wrap.style.width = sel.style.width;
      var extra = (sel.className || '').split(/\s+/).filter(function (c) { return c && c !== 'select' && c !== 'page-size-select'; });
      // 把附带布局 class 也标到 wrap，便于页面 CSS（如 .cprod{flex:1}）作用到外层
      extra.forEach(function (c) { wrap.classList.add(c); });
      if (/\bpage-size-select\b/.test(sel.className)) wrap.classList.add('ui-sel-psize');
      sel.parentNode.insertBefore(wrap, sel);
      wrap.appendChild(sel);
      // 原生 select 隐藏但保留（作数据源）
      sel.style.position = 'absolute';
      sel.style.opacity = '0';
      sel.style.pointerEvents = 'none';
      sel.style.width = '100%';
      sel.style.height = '100%';
      sel.style.left = '0';
      sel.style.top = '0';
      sel.setAttribute('aria-hidden', 'true');
      sel.tabIndex = -1;

      // trigger 按钮
      var trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'ui-sel-trigger';
      var txt = document.createElement('span');
      txt.className = 'ui-sel-txt';
      trigger.appendChild(txt);
      trigger.insertAdjacentHTML('beforeend', CHEV);
      wrap.appendChild(trigger);

      var pop = null, hlIdx = -1;

      function curOpt() { var i = sel.selectedIndex; return i >= 0 && sel.options[i] ? sel.options[i] : null; }
      function syncLabel() {
        var o = curOpt();
        txt.textContent = o ? (o.textContent || '') : '';
        txt.classList.toggle('ph', !o || o.value === '');
        var dis = !!sel.disabled;
        trigger.classList.toggle('disabled', dis);
        trigger.disabled = dis;
      }
      // syncFromSelect：外部代码改了 select.value / 选项后，把触发器文案对齐（并在面板打开时重建）
      function syncFromSelect() { syncLabel(); if (isOpen()) buildPop(); }

      function isOpen() { return wrap.classList.contains('open'); }

      // 组装面板项（支持 <optgroup>：组头不可点 + 组内缩进）
      function buildPop() {
        if (!pop) return;
        pop.innerHTML = '';
        var ci = sel.selectedIndex, flatIdx = [];
        var kids = sel.children, hasGroup = false;
        for (var k = 0; k < kids.length; k++) { if (kids[k].tagName === 'OPTGROUP') { hasGroup = true; break; } }
        if (!sel.options.length) {
          var em = document.createElement('div'); em.className = 'ui-sel-empty'; em.textContent = '无选项'; pop.appendChild(em); return;
        }
        function addOpt(o, sub) {
          var idx = o.index; // 原生 option.index = 在 select.options 里的下标
          var it = document.createElement('div');
          it.className = 'ui-sel-opt' + (idx === ci ? ' on' : '') + (sub ? ' sub' : '');
          var lb = document.createElement('span'); lb.className = 'ui-sel-opt-lb'; lb.textContent = o.textContent || '';
          it.appendChild(lb);
          it.insertAdjacentHTML('beforeend', CHECK);
          it.setAttribute('data-oi', String(idx));
          it.addEventListener('mousedown', function (e) { e.preventDefault(); pick(idx); });
          it.addEventListener('mouseenter', function () { highlight(flatIdx.indexOf(idx)); });
          pop.appendChild(it);
          flatIdx.push(idx);
        }
        if (hasGroup) {
          for (var c = 0; c < kids.length; c++) {
            var node = kids[c];
            if (node.tagName === 'OPTGROUP') {
              var gh = document.createElement('div'); gh.className = 'ui-sel-grp'; gh.textContent = node.label || ''; pop.appendChild(gh);
              var gopts = node.children;
              for (var g = 0; g < gopts.length; g++) if (gopts[g].tagName === 'OPTION') addOpt(gopts[g], true);
            } else if (node.tagName === 'OPTION') {
              addOpt(node, false);
            }
          }
        } else {
          for (var i = 0; i < sel.options.length; i++) addOpt(sel.options[i], false);
        }
        pop._flat = flatIdx;
        hlIdx = flatIdx.indexOf(ci); if (hlIdx < 0 && flatIdx.length) hlIdx = 0;
        paintHl();
      }
      function paintHl() {
        if (!pop) return;
        var items = pop.querySelectorAll('.ui-sel-opt');
        for (var i = 0; i < items.length; i++) items[i].classList.toggle('hl', i === hlIdx);
      }
      function highlight(i) { if (i < 0) return; hlIdx = i; paintHl(); }

      function pick(optIndex) {
        if (sel.disabled) return;
        if (sel.selectedIndex !== optIndex) {
          sel.selectedIndex = optIndex;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        syncLabel();
        close();
      }

      function place() {
        if (!pop) return;
        var r = trigger.getBoundingClientRect();
        pop.style.minWidth = r.width + 'px';
        pop.style.left = r.left + 'px';
        var below = window.innerHeight - r.bottom;
        var need = Math.min(pop.scrollHeight || 280, 280);
        if (below < need + 8 && r.top > below) { pop.style.top = 'auto'; pop.style.bottom = (window.innerHeight - r.top + 4) + 'px'; }
        else { pop.style.bottom = 'auto'; pop.style.top = (r.bottom + 4) + 'px'; }
      }
      function open() {
        if (sel.disabled || !sel.options.length || isOpen()) return;
        pop = document.createElement('div');
        pop.className = 'ui-sel-pop';
        buildPop();
        document.body.appendChild(pop);
        wrap.classList.add('open');
        place();
        setTimeout(function () { document.addEventListener('mousedown', outside, true); }, 0);
        window.addEventListener('scroll', close, true);
        window.addEventListener('resize', close);
        scrollHlIntoView();
      }
      function close() {
        if (!isOpen()) return;
        wrap.classList.remove('open');
        if (pop && pop.parentNode) pop.parentNode.removeChild(pop);
        pop = null;
        document.removeEventListener('mousedown', outside, true);
        window.removeEventListener('scroll', close, true);
        window.removeEventListener('resize', close);
      }
      function outside(e) { if (!wrap.contains(e.target) && (!pop || !pop.contains(e.target))) close(); }
      function scrollHlIntoView() {
        if (!pop) return;
        var items = pop.querySelectorAll('.ui-sel-opt');
        if (items[hlIdx] && items[hlIdx].scrollIntoView) { try { items[hlIdx].scrollIntoView({ block: 'nearest' }); } catch (e) {} }
      }

      trigger.addEventListener('click', function (e) { e.preventDefault(); if (trigger.disabled) return; isOpen() ? close() : open(); });
      trigger.addEventListener('keydown', function (e) {
        var flat = pop && pop._flat;
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (!isOpen()) { open(); return; }
          if (flat && hlIdx < flat.length - 1) { highlight(hlIdx + 1); scrollHlIntoView(); }
        } else if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (!isOpen()) { open(); return; }
          if (flat && hlIdx > 0) { highlight(hlIdx - 1); scrollHlIntoView(); }
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (!isOpen()) { open(); return; }
          if (flat && hlIdx >= 0) pick(flat[hlIdx]);
        } else if (e.key === 'Escape') {
          if (isOpen()) { e.preventDefault(); close(); }
        }
      });

      // 值同步：① 覆盖 value/selectedIndex 的 setter，代码 sel.value=.. 会触发 syncLabel（openEdit 编辑回显靠这个）
      try {
        var vd = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        if (vd && vd.set) Object.defineProperty(sel, 'value', { configurable: true, get: function () { return vd.get.call(sel); }, set: function (v) { vd.set.call(sel, v); syncFromSelect(); } });
        var sid = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'selectedIndex');
        if (sid && sid.set) Object.defineProperty(sel, 'selectedIndex', { configurable: true, get: function () { return sid.get.call(sel); }, set: function (v) { sid.set.call(sel, v); syncFromSelect(); } });
      } catch (e) {}
      // ② 监听 select 自身 change（用户/代码派发）→ 对齐
      sel.addEventListener('change', syncLabel);
      // ③ 选项变化（innerHTML 换选项）/ disabled 变化 → 重同步并（若开）重建面板
      try {
        new MutationObserver(syncFromSelect).observe(sel, { childList: true });
        new MutationObserver(syncLabel).observe(sel, { attributes: true, attributeFilter: ['disabled'] });
      } catch (e) {}

      sel.__uiSelSync = syncFromSelect; // 暴露到元素上，便于外部强制同步
      syncLabel();
    } catch (err) {
      // 优雅降级：增强失败 → 复原原生 select，保证页面可用
      try {
        delete sel.dataset.enh;
        sel.style.position = ''; sel.style.opacity = ''; sel.style.pointerEvents = '';
        sel.style.width = ''; sel.style.height = ''; sel.style.left = ''; sel.style.top = '';
        sel.removeAttribute('aria-hidden'); sel.tabIndex = 0;
      } catch (e2) {}
      if (window.console && console.warn) console.warn('[ui-sel] enhance failed, native select kept:', err);
    }
  }

  function scan(root) {
    var list = (root || document).querySelectorAll('select.select:not([data-enh])');
    for (var i = 0; i < list.length; i++) enhanceUiSelect(list[i]);
  }
  window.enhanceUiSelect = enhanceUiSelect;
  window.scanUiSelects = scan;

  function boot() {
    scan(document);
    // 时机无关：监听 body 子树，新增/动态创建的 select.select（如 customers 关联产品行）也即时增强
    try {
      new MutationObserver(function (muts) {
        for (var m = 0; m < muts.length; m++) {
          var added = muts[m].addedNodes;
          for (var a = 0; a < added.length; a++) {
            var n = added[a];
            if (n.nodeType !== 1) continue;
            if (n.matches && n.matches('select.select:not([data-enh])')) enhanceUiSelect(n);
            if (n.querySelectorAll) scan(n);
          }
        }
      }).observe(document.body || document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
