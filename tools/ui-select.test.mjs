#!/usr/bin/env node
/* ============================================================
   UI-01 · 运营端统一自定义下拉组件 —— 验证/回归测试（零依赖 node:test）
   ------------------------------------------------------------
   基线（2026-07-23 用户裁决）：运营后台所有 <select class="select"> 统一走 ui.js 注入的
   自定义下拉组件（.ui-sel-*），替代 OS 原生下拉弹窗。原生 <select> 保留为数据源，
   选中回写 select.value + 派发 change{bubbles:true}，故各页 change 依赖不变。
   面板 position:fixed（逃祖先 overflow 裁剪）+ z-index 9600；支持 optgroup / 键盘 / 值同步 /
   优雅降级。不碰 submit.html 的 .fancy、不碰 field.html 的 .f-proddd（field.html 不引 ui.js）。

   两组用例：
     A) ui.js 源码静态断言（机制/关键行为在源里存在）——恒可跑。
     B) 无 jsdom 的手搓 fake DOM 跑真增强函数（载入 ui.js 源、eval），实跑 load-bearing 路径：
        选项点击 → select.value 变 + change 事件 + syncFromSelect + optgroup + disabled 跳过。
     C) 管理页 / field.html 静态护栏回归（.select 存在会被增强；field.html 0 处 ui.js）。

   用法：node --test tools/ui-select.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');
const uiJs = read('assets/ui.js');

/* ============================================================
   A 组 · ui.js 源码静态断言（自定义下拉机制/关键行为存在）
   ============================================================ */

test('A1 [机制] MutationObserver 自动增强，选择器锁 select.select:not([data-enh])', () => {
  assert.match(uiJs, /select\.select:not\(\[data-enh\]\)/, '扫描选择器锁定 select.select:not([data-enh])');
  assert.match(uiJs, /new MutationObserver\(/, '用 MutationObserver 监听动态新增的 select');
  assert.match(uiJs, /\.observe\([^)]*\{\s*childList:\s*true,\s*subtree:\s*true\s*\}/, 'observe body 子树 childList+subtree（时机无关）');
  assert.match(uiJs, /if \(document\.readyState === 'loading'\) document\.addEventListener\('DOMContentLoaded', boot\)/, '初次扫描 + DOMContentLoaded 兜底');
});

test('A2 [防重] data-enh 标记防重复增强，multiple 留原生', () => {
  assert.match(uiJs, /sel\.dataset\.enh\s*=\s*'1'/, '增强后打 data-enh="1"');
  assert.match(uiJs, /if \(!sel \|\| sel\.dataset\.enh \|\| sel\.multiple\)/, '已增强 / multiple 直接跳过');
});

test('A3 [定位] 面板 position:fixed 挂 body + getBoundingClientRect + z-index 9600（逃 overflow 裁剪）', () => {
  assert.match(uiJs, /getBoundingClientRect\(\)/, '用 getBoundingClientRect 定位');
  assert.match(uiJs, /position:fixed;z-index:9600/, '面板 position:fixed + z-index:9600（盖过 drawer/modal 300/310 与弹窗 9000）');
  assert.match(uiJs, /document\.body\.appendChild\(pop\)/, '面板挂到 document.body（逃祖先 overflow 裁剪）');
  // 上翻/下翻空间判断
  assert.match(uiJs, /window\.innerHeight - r\.bottom/, '据下方剩余空间决定上翻/下翻');
});

test('A4 [回写] 选中 → set select.value/selectedIndex + 派发 change{bubbles:true}（保各页 change 依赖）', () => {
  assert.match(uiJs, /sel\.selectedIndex\s*=\s*optIndex/, '选中写回 select.selectedIndex');
  assert.match(uiJs, /sel\.dispatchEvent\(new Event\('change',\s*\{\s*bubbles:\s*true\s*\}\)\)/, '派发冒泡 change 事件');
});

test('A5 [值同步] 定义 syncFromSelect + defineProperty 覆盖 value/selectedIndex setter + 监听 change/childList', () => {
  assert.match(uiJs, /function syncFromSelect\(\)/, '定义 syncFromSelect');
  assert.match(uiJs, /Object\.defineProperty\(sel,\s*'value'/, '覆盖 value setter（代码 sel.value=.. 触发同步，编辑回显靠这个）');
  assert.match(uiJs, /Object\.defineProperty\(sel,\s*'selectedIndex'/, '覆盖 selectedIndex setter');
  assert.match(uiJs, /sel\.addEventListener\('change',\s*syncLabel\)/, '监听 select 自身 change 对齐触发器');
  assert.match(uiJs, /observe\(sel,\s*\{\s*childList:\s*true\s*\}\)/, 'MutationObserver 监听选项变化（innerHTML 换选项）');
  assert.match(uiJs, /attributeFilter:\s*\['disabled'\]/, 'MutationObserver 监听 disabled 变化');
});

test('A6 [optgroup] 面板支持 <optgroup>：组头 + 组内缩进', () => {
  assert.match(uiJs, /OPTGROUP/, '按 tagName===OPTGROUP 识别分组');
  assert.match(uiJs, /ui-sel-grp/, '渲染不可点组头 .ui-sel-grp');
  assert.match(uiJs, /ui-sel-opt\.sub|' sub'|ui-sel-opt sub/, '组内选项加 .sub 缩进类');
});

test('A7 [降级] try/catch 包裹增强，失败复原原生 select（不隐藏）', () => {
  assert.match(uiJs, /catch \(err\)/, '增强主体 try/catch');
  assert.match(uiJs, /delete sel\.dataset\.enh/, '失败清 data-enh 允许原生可用');
  assert.match(uiJs, /native select kept/, '失败保留原生 select 的注释/日志');
});

test('A8 [键盘] 触发器可聚焦 + Arrow/Enter/Esc/Space 键盘操作', () => {
  assert.match(uiJs, /trigger\.addEventListener\('keydown'/, '触发器绑 keydown');
  assert.match(uiJs, /e\.key === 'ArrowDown'/, 'ArrowDown 移高亮/展开');
  assert.match(uiJs, /e\.key === 'ArrowUp'/, 'ArrowUp 移高亮');
  assert.match(uiJs, /e\.key === 'Enter' \|\| e\.key === ' '/, 'Enter/Space 选中/展开');
  assert.match(uiJs, /e\.key === 'Escape'/, 'Esc 关闭');
});

test('A9 [暴露] window.enhanceUiSelect + 守卫双重定义 + 样式从 ui.js 注入', () => {
  assert.match(uiJs, /window\.enhanceUiSelect\s*=\s*enhanceUiSelect/, '暴露 window.enhanceUiSelect');
  assert.match(uiJs, /if \(window\.enhanceUiSelect\) return/, '守卫防重复定义');
  assert.match(uiJs, /data-ui-sel/, '样式从 ui.js 注入 <style data-ui-sel>');
  // 未破坏原有助手 / 老 .fancy
  assert.match(uiJs, /window\.uiConfirm\s*=/, '未破坏 uiConfirm');
  assert.match(uiJs, /window\.enhanceSelect\s*=/, '老 .fancy 增强器（submit.html 用）保留');
});

test('A10 [无隐形字符] ui.js 无零宽/控制字符', () => {
  const bad = [0x200B, 0x200C, 0x200D, 0xFEFF, 0x00A0, 0x2028, 0x2029, 0x202F, 0x2060, 0x180E];
  const hits = [];
  for (let i = 0; i < uiJs.length; i++) {
    const c = uiJs.charCodeAt(i);
    if (bad.includes(c)) hits.push([i, c.toString(16)]);
    else if ((c < 0x20 && c !== 9 && c !== 10 && c !== 13) || (c >= 0x7f && c <= 0x9f)) hits.push([i, c.toString(16)]);
  }
  assert.equal(hits.length, 0, '无隐形/控制字符：' + JSON.stringify(hits.slice(0, 10)));
});

/* ============================================================
   B 组 · 手搓 fake DOM 实跑增强函数（无 jsdom · 零依赖）
   ------------------------------------------------------------
   目标：真实执行「选项点击 → select.value 变 + change 事件」这条 load-bearing 路径，
   以及 syncFromSelect / optgroup / disabled 跳过。载入 ui.js 源码进 vm 沙箱，
   用最小 fake DOM 支撑执行。
   ============================================================ */

// —— 极简 fake DOM —— //
function makeEl(tag) {
  tag = (tag || 'div').toUpperCase();
  const listeners = {};
  const el = {
    tagName: tag, nodeType: 1, children: [], childNodes: [], parentNode: null,
    style: {}, dataset: {}, attributes: {}, _text: '', tabIndex: 0, disabled: false,
    className: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => x && this._s.add(x)); el._syncClass(); },
      remove(...c) { c.forEach(x => this._s.delete(x)); el._syncClass(); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); el._syncClass(); return on; },
      contains(c) { return this._s.has(c); },
    },
    _syncClass() { /* className stays authoritative when set directly */ },
    get textContent() { return this._text; },
    set textContent(v) { this._text = String(v == null ? '' : v); },
    setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'class') this.className = String(v); },
    getAttribute(k) { return k in this.attributes ? this.attributes[k] : (k === 'class' ? this.className : null); },
    removeAttribute(k) { delete this.attributes[k]; },
    appendChild(c) { c.parentNode = this; this.children.push(c); this.childNodes.push(c); return c; },
    insertBefore(nw, ref) {
      nw.parentNode = this;
      const i = this.children.indexOf(ref);
      if (i < 0) { this.children.push(nw); this.childNodes.push(nw); }
      else { this.children.splice(i, 0, nw); this.childNodes.splice(i, 0, nw); }
      return nw;
    },
    removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); this.childNodes.splice(i, 1); c.parentNode = null; } return c; },
    insertAdjacentHTML() { /* svg chevron/check — noop for logic */ },
    set innerHTML(v) { this._html = v; this.children = []; this.childNodes = []; },
    get innerHTML() { return this._html || ''; },
    addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    removeEventListener(t, fn) { if (listeners[t]) listeners[t] = listeners[t].filter(f => f !== fn); },
    dispatchEvent(ev) { (listeners[ev.type] || []).slice().forEach(fn => fn(ev)); return true; },
    _fire(type, ev) { (listeners[type] || []).slice().forEach(fn => fn(Object.assign({ type, preventDefault() {}, target: this }, ev || {}))); },
    matches() { return false; },
    querySelectorAll() { return []; },
    querySelector() { return null; },
    contains(n) { let p = n; while (p) { if (p === this) return true; p = p.parentNode; } return false; },
    getBoundingClientRect() { getBoundingClientRect._calls = (getBoundingClientRect._calls || 0) + 1; return { left: 20, top: 100, right: 220, bottom: 130, width: 200, height: 30 }; },
    scrollIntoView() {},
    focus() {}, click() {},
  };
  return el;
}
function getBoundingClientRect() {} // marker only

// fake <select> with real getters/setters overrideable
function makeSelect(opts, { multiple = false, disabled = false, group = null } = {}) {
  const sel = makeEl('select');
  sel.className = 'select';
  sel.multiple = multiple;
  sel.disabled = disabled;
  sel._options = opts.map((o, i) => {
    const op = makeEl('option'); op.value = o.value; op.textContent = o.label; op.index = i;
    op.tagName = 'OPTION'; return op;
  });
  sel._selectedIndex = opts.findIndex(o => o.selected);
  if (sel._selectedIndex < 0) sel._selectedIndex = opts.length ? 0 : -1;
  // options collection
  Object.defineProperty(sel, 'options', { configurable: true, get() { return sel._options; } });
  // selectedIndex — plain data prop, overrideable by ui.js via defineProperty on the instance
  Object.defineProperty(sel, 'selectedIndex', {
    configurable: true,
    get() { return sel._selectedIndex; },
    set(v) { sel._selectedIndex = v; },
  });
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get() { const o = sel._options[sel._selectedIndex]; return o ? o.value : ''; },
    set(v) { const i = sel._options.findIndex(o => o.value === v); if (i >= 0) sel._selectedIndex = i; },
  });
  // children: flat options, or an optgroup wrapper
  if (group) {
    const og = makeEl('optgroup'); og.tagName = 'OPTGROUP'; og.label = group;
    sel._options.forEach(o => og.children.push(o));
    sel.children = [og]; sel.childNodes = [og];
  } else {
    sel.children = sel._options.slice(); sel.childNodes = sel._options.slice();
  }
  return sel;
}

// Build a sandbox with fake document/window and load ui.js, capturing enhanceUiSelect
function loadUi() {
  const head = makeEl('head');
  const body = makeEl('body');
  const created = [];
  const doc = {
    readyState: 'complete',
    head, body, documentElement: makeEl('html'),
    createElement: tag => { const e = makeEl(tag); created.push(e); return e; },
    addEventListener() {}, removeEventListener() {},
    querySelectorAll: () => [],
  };
  // HTMLSelectElement.prototype with value/selectedIndex descriptors — ui.js reads these
  // via Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').get.call(sel).
  // They must delegate to the SAME underlying storage the fake select uses (_selectedIndex +
  // _options), otherwise ui.js's overridden setter writes to a disconnected slot and the
  // trigger label goes blank (real browsers back these onto the element's native store).
  function HTMLSelectElement() {}
  Object.defineProperty(HTMLSelectElement.prototype, 'value', {
    configurable: true,
    get() { const o = this._options && this._options[this._selectedIndex]; return o ? o.value : ''; },
    set(v) { if (this._options) { const i = this._options.findIndex(o => o.value === v); if (i >= 0) this._selectedIndex = i; } },
  });
  Object.defineProperty(HTMLSelectElement.prototype, 'selectedIndex', {
    configurable: true,
    get() { return this._selectedIndex; },
    set(v) { this._selectedIndex = v; },
  });
  const win = { addEventListener() {}, removeEventListener() {}, innerHeight: 800, innerWidth: 1200 };
  const sandbox = {
    window: win, document: doc,
    HTMLSelectElement,
    MutationObserver: class { constructor(cb) { this.cb = cb; } observe() {} disconnect() {} },
    Event: class { constructor(type, o) { this.type = type; this.bubbles = !!(o && o.bubbles); } },
    setTimeout: (fn) => { try { fn(); } catch (e) {} return 0; },
    console,
  };
  win.document = doc;
  vm.createContext(sandbox);
  vm.runInContext(uiJs, sandbox, { filename: 'ui.js' });
  return { win, doc, body, sandbox };
}

test('B1 [实跑] 增强创建 trigger + 打 data-enh，原生 select 隐藏保留', () => {
  const { win, body } = loadUi();
  const sel = makeSelect([{ value: 'a', label: 'A', selected: true }, { value: 'b', label: 'B' }]);
  const host = body; host.appendChild(sel);
  win.enhanceUiSelect(sel);
  assert.equal(sel.dataset.enh, '1', '打了 data-enh');
  // wrap 插到 select 前并把 select 移进去
  const wrap = sel.parentNode;
  assert.equal(wrap.className, 'ui-sel-wrap', 'select 被移入 .ui-sel-wrap');
  // trigger 存在
  const trigger = wrap.children.find(c => c.className === 'ui-sel-trigger');
  assert.ok(trigger, '创建了 .ui-sel-trigger 触发器');
  // 原生 select 隐藏（opacity 0）但仍在 DOM
  assert.equal(sel.style.opacity, '0', '原生 select 隐藏（opacity:0）');
  assert.ok(wrap.children.includes(sel), '原生 select 仍在 DOM 作数据源');
  // trigger 文案 = 当前选项
  const txt = trigger.children.find(c => c.className === 'ui-sel-txt');
  assert.equal(txt.textContent, 'A', '触发器显示当前选中项文案');
});

test('B2 [load-bearing] 点击选项 → select.value 变 + change{bubbles:true} 触发（各页 change 依赖靠这个）', () => {
  const { win, body } = loadUi();
  const sel = makeSelect([{ value: 'a', label: 'A', selected: true }, { value: 'b', label: 'B' }]);
  body.appendChild(sel);
  let changeFired = 0, changeBubbles = false;
  sel.addEventListener('change', ev => { changeFired++; changeBubbles = ev.bubbles; });
  win.enhanceUiSelect(sel);
  const wrap = sel.parentNode;
  const trigger = wrap.children.find(c => c.className === 'ui-sel-trigger');
  // 打开面板
  trigger._fire('click');
  // 面板挂到 body
  const pop = body.children.find(c => c.className === 'ui-sel-pop');
  assert.ok(pop, '打开后面板挂到 document.body');
  // 找到第二项（value=b）并 mousedown 选中
  const optB = pop.children.find(c => (c.className || '').indexOf('ui-sel-opt') === 0 && c.getAttribute('data-oi') === '1');
  assert.ok(optB, '面板渲染了第 2 个选项');
  optB._fire('mousedown', { preventDefault() {} });
  assert.equal(sel.value, 'b', 'select.value 回写为 b');
  assert.equal(sel.selectedIndex, 1, 'select.selectedIndex 回写为 1');
  assert.equal(changeFired, 1, 'change 事件恰好派发一次');
  assert.equal(changeBubbles, true, 'change 事件 bubbles:true');
  // 面板关闭并从 body 移除
  assert.ok(!body.children.find(c => c.className === 'ui-sel-pop'), '选中后面板关闭移除');
});

test('B3 [值同步] 代码 sel.value=.. → syncFromSelect 更新触发器文案', () => {
  const { win, body } = loadUi();
  const sel = makeSelect([{ value: 'a', label: 'A', selected: true }, { value: 'b', label: '乙级' }]);
  body.appendChild(sel);
  win.enhanceUiSelect(sel);
  const wrap = sel.parentNode;
  const trigger = wrap.children.find(c => c.className === 'ui-sel-trigger');
  const txt = trigger.children.find(c => c.className === 'ui-sel-txt');
  assert.equal(txt.textContent, 'A', '初始文案 A');
  // 模拟 openEdit 里的 $('#edLevel').value='乙级'
  sel.value = 'b';
  assert.equal(txt.textContent, '乙级', 'value setter 触发同步 → 触发器显示 乙级（编辑回显）');
  // 也测暴露的 __uiSelSync
  assert.equal(typeof sel.__uiSelSync, 'function', '元素上暴露 __uiSelSync');
});

test('B4 [optgroup] 分组渲染组头 + 组内 .sub 缩进', () => {
  const { win, body } = loadUi();
  const sel = makeSelect([{ value: 'x', label: 'X', selected: true }, { value: 'y', label: 'Y' }], { group: '华东产品' });
  body.appendChild(sel);
  win.enhanceUiSelect(sel);
  const wrap = sel.parentNode;
  const trigger = wrap.children.find(c => c.className === 'ui-sel-trigger');
  trigger._fire('click');
  const pop = body.children.find(c => c.className === 'ui-sel-pop');
  const grp = pop.children.find(c => c.className === 'ui-sel-grp');
  assert.ok(grp, '渲染了 optgroup 组头 .ui-sel-grp');
  assert.equal(grp.textContent, '华东产品', '组头文案 = optgroup.label');
  const subOpt = pop.children.find(c => (c.className || '').indexOf('sub') >= 0);
  assert.ok(subOpt, '组内选项带 .sub 缩进类');
});

test('B5 [disabled] disabled select → 触发器禁用 + 打开无面板', () => {
  const { win, body } = loadUi();
  const sel = makeSelect([{ value: 'a', label: 'A', selected: true }], { disabled: true });
  body.appendChild(sel);
  win.enhanceUiSelect(sel);
  const wrap = sel.parentNode;
  const trigger = wrap.children.find(c => c.className === 'ui-sel-trigger');
  assert.equal(trigger.disabled, true, '触发器 disabled');
  assert.ok(trigger.classList.contains('disabled'), '触发器带 .disabled 灰态');
  trigger._fire('click');
  assert.ok(!body.children.find(c => c.className === 'ui-sel-pop'), 'disabled 点击不打开面板');
});

test('B6 [定位] 打开面板调用了 getBoundingClientRect（fixed 定位逃 overflow）', () => {
  const { win, body } = loadUi();
  const sel = makeSelect([{ value: 'a', label: 'A', selected: true }, { value: 'b', label: 'B' }]);
  body.appendChild(sel);
  win.enhanceUiSelect(sel);
  const wrap = sel.parentNode;
  const trigger = wrap.children.find(c => c.className === 'ui-sel-trigger');
  getBoundingClientRect._calls = 0;
  trigger._fire('click');
  assert.ok(getBoundingClientRect._calls > 0, 'open→place 调用了 trigger.getBoundingClientRect');
  const pop = body.children.find(c => c.className === 'ui-sel-pop');
  assert.equal(pop.style.position === undefined ? '' : pop.style.position, ''); // position 来自注入 CSS，非行内
  assert.ok(pop.style.left && pop.style.top !== undefined, 'fixed 面板设置了 left/top 行内定位');
});

test('B7 [multiple] multiple select 留原生（不增强）', () => {
  const { win, body } = loadUi();
  const sel = makeSelect([{ value: 'a', label: 'A' }], { multiple: true });
  body.appendChild(sel);
  win.enhanceUiSelect(sel);
  assert.notEqual(sel.dataset.enh, '1', 'multiple 未被增强');
  assert.equal(sel.parentNode, body, 'multiple 未被包进 .ui-sel-wrap');
});

/* ============================================================
   C 组 · 管理页 / field.html 静态护栏（回归）
   ============================================================ */

test('C1 [覆盖] customers/inbox/kb/accounts/projects 仍含 <select class="select"> 且引 ui.js（会被增强）', () => {
  const pages = ['customers.html', 'inbox.html', 'kb.html', 'accounts.html', 'projects.html'];
  for (const p of pages) {
    const html = read(p);
    assert.match(html, /<select class="select/, `${p} 含 <select class="select">（将被自定义下拉增强）`);
    assert.match(html, /\/assets\/ui\.js/, `${p} 引 ui.js`);
  }
});

test('C2 [护栏] field.html 不引 ui.js（0 处）—— 实施端 .f-proddd 天然隔离', () => {
  const html = read('field.html');
  assert.equal((html.match(/ui\.js/g) || []).length, 0, 'field.html 0 处 ui.js 引用（自定义下拉不侵入实施端）');
  assert.doesNotMatch(uiJs, /f-proddd|f-sysdd/, 'ui.js 不引用 field.html 的 .f-proddd/.f-sysdd 类');
});

test('C3 [隔离] submit.html 的 .fancy 老增强器仍在（.select 与 .fancy 互不重叠）', () => {
  const submit = read('submit.html');
  assert.match(submit, /class="fancy"/, 'submit.html 仍用 .fancy（老增强器）');
  // .select 与 .fancy 不同时出现在同一 select（否则双重接管）
  assert.doesNotMatch(submit, /class="[^"]*\bselect\b[^"]*\bfancy\b|class="[^"]*\bfancy\b[^"]*\bselect\b/, 'submit 无同时 .select+.fancy 的 select');
});
