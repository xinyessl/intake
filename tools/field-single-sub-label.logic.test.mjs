// 单子系统产品「系统」显示 = 产品名（实施端）· 脱库逻辑测试
//   决策（2026-08-25）：单子系统的产品，实施端「系统」显示一律用产品名（尊重运营端设的产品名），
//     避免 Gitee/GitLab 单仓 full_name（如 xinye666/wzh2.0）当子系统名显示出来（丑）。多子系统产品不变（仍 desc||name）。
//   铁律：只改「英文 name → 给人看的标签」这层；匹配键（curSub/data-sub/selectSub 传值、curSys/&system=）恒用英文 name，不动。
//   做法：直接从 public/field.html 抽取并执行真实的 subLabel / sysLabel / renderProdDD，沙箱跑，不用「字符串存在」代替行为。
//   用法：node --test tools/field-single-sub-label.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELD = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

// 抽真身：兼容 async function（本次三函数都是普通 function，仍按 lessons L19 用兼容写法）
function extractFn(src, name) {
  let start = src.indexOf('async function ' + name + '(');
  if (start < 0) start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `应能找到 function ${name}`);
  // 先配平参数括号 (...)，再取函数体 { }（防解构参数把配平提前截断，见 lessons L21）
  const paren = src.indexOf('(', start);
  let pd = 0, parenClose = -1;
  for (let i = paren; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')' && --pd === 0) { parenClose = i; break; }
  }
  const open = src.indexOf('{', parenClose);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${name} 大括号未配平`);
}

function makeSubLabel(state) {
  return new Function('state', extractFn(FIELD, 'subLabel') + '\nreturn subLabel;')(state);
}
function makeSysLabel(state) {
  return new Function('state', extractFn(FIELD, 'sysLabel') + '\nreturn sysLabel;')(state);
}

// —— 极简 DOM 桩：只需 createElement + appendChild + setAttribute + className/innerHTML/textContent + addEventListener，
//    足够跑通 renderProdDD 并采集每个 opt 的 data-sub（匹配键）与显示 innerHTML。
function makeDomEnv() {
  function El() {
    this.children = [];
    this.attrs = {};
    this.className = '';
    this.innerHTML = '';
    this.textContent = '';
  }
  El.prototype.appendChild = function (c) { this.children.push(c); return c; };
  El.prototype.setAttribute = function (k, v) { this.attrs[k] = v; };
  El.prototype.getAttribute = function (k) { return this.attrs[k]; };
  El.prototype.addEventListener = function () {};
  const dd = new El();
  const document = { createElement: function () { return new El(); } };
  const $ = function (id) { return id === 'fProdDD' ? dd : null; };
  const escapeHtml = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  return { El, dd, document, $, escapeHtml };
}

function makeRenderProdDD(state, env) {
  const selected = [];
  const selectSub = function (nm) { selected.push(nm); };   // 采集 selectSub 传入的键（应为英文 name）
  const fn = new Function('state', '$', 'document', 'escapeHtml', 'selectSub', 'subLabel',
    extractFn(FIELD, 'subLabel') + '\n' + extractFn(FIELD, 'renderProdDD') + '\nreturn renderProdDD;'
  )(state, env.$, env.document, env.escapeHtml, selectSub, null);
  return { fn, selected };
}

// ============ subLabel（医院视图子项目标签） ============

test('subLabel · 单子系统产品 → 显产品名（不是 Gitee full_name）', () => {
  const state = { subOptions: [{ product: '病案归档系统', subs: [{ name: 'xinye666/wzh2.0', desc: '' }] }] };
  const subLabel = makeSubLabel(state);
  assert.equal(subLabel('xinye666/wzh2.0'), '病案归档系统', '单子系统产品：显产品名而非丑的英文 full_name');
});

test('subLabel · 单子系统产品即使有 desc 也优先显产品名（决策：单仓统一用产品名）', () => {
  const state = { subOptions: [{ product: '病案归档系统', subs: [{ name: 'xinye666/wzh2.0', desc: '归档子系统' }] }] };
  const subLabel = makeSubLabel(state);
  assert.equal(subLabel('xinye666/wzh2.0'), '病案归档系统', '单子系统：产品名优先于 desc');
});

test('subLabel · 多子系统产品 → 仍显 desc||name（不受影响）', () => {
  const state = { subOptions: [{ product: '合理用药系统', subs: [
    { name: 'audit', desc: '审方' }, { name: 'intervene', desc: '干预' },
  ] }] };
  const subLabel = makeSubLabel(state);
  assert.equal(subLabel('audit'), '审方', '多子系统：显 desc');
  assert.equal(subLabel('intervene'), '干预', '多子系统：显 desc');
});

test('subLabel · 多子系统产品某子系统 desc 空 → 回退英文 name', () => {
  const state = { subOptions: [{ product: '合理用药系统', subs: [
    { name: 'audit', desc: '审方' }, { name: 'report', desc: '' },
  ] }] };
  const subLabel = makeSubLabel(state);
  assert.equal(subLabel('report'), 'report', '多子系统 desc 空 → 回退 name');
});

test('subLabel · 未命中 / 空值 → 原样返回（键不动）', () => {
  const state = { subOptions: [{ product: '病案归档系统', subs: [{ name: 'xinye666/wzh2.0', desc: '' }] }] };
  const subLabel = makeSubLabel(state);
  assert.equal(subLabel('unknown/repo'), 'unknown/repo', '未命中回退原名');
  assert.equal(subLabel(''), '', '空值原样');
});

// ============ sysLabel（系统视图系统标签） ============

test('sysLabel · 单子系统产品（该 project 仅 1 系统）→ 显 productName', () => {
  const state = { systems: [
    { key: '', name: 'xinye666/wzh2.0', desc: '', project: 'bagd', productName: '病案归档系统' },
  ] };
  const sysLabel = makeSysLabel(state);
  assert.equal(sysLabel('xinye666/wzh2.0'), '病案归档系统', '单系统产品：显 productName');
});

test('sysLabel · 单子系统产品即使有 desc 也优先 productName', () => {
  const state = { systems: [
    { key: '', name: 'xinye666/wzh2.0', desc: '归档', project: 'bagd', productName: '病案归档系统' },
  ] };
  const sysLabel = makeSysLabel(state);
  assert.equal(sysLabel('xinye666/wzh2.0'), '病案归档系统', '单系统：productName 优先于 desc');
});

test('sysLabel · 多子系统产品（同 project 多系统）→ 仍显 desc||name', () => {
  const state = { systems: [
    { name: 'audit', desc: '审方', project: 'pwrs', productName: '合理用药系统' },
    { name: 'intervene', desc: '干预', project: 'pwrs', productName: '合理用药系统' },
  ] };
  const sysLabel = makeSysLabel(state);
  assert.equal(sysLabel('audit'), '审方', '多系统：显 desc');
  assert.equal(sysLabel('intervene'), '干预', '多系统：显 desc');
});

test('sysLabel · 多子系统产品 desc 空 → 回退英文 name（不误显 productName）', () => {
  const state = { systems: [
    { name: 'audit', desc: '审方', project: 'pwrs', productName: '合理用药系统' },
    { name: 'report', desc: '', project: 'pwrs', productName: '合理用药系统' },
  ] };
  const sysLabel = makeSysLabel(state);
  assert.equal(sysLabel('report'), 'report', '多系统 desc 空 → 回退 name（不用 productName）');
});

test('sysLabel · 多产品混合：单系统产品显产品名、多系统产品显 desc（按 project 计数区分）', () => {
  const state = { systems: [
    { name: 'xinye666/wzh2.0', desc: '', project: 'bagd', productName: '病案归档系统' },   // 单
    { name: 'audit', desc: '审方', project: 'pwrs', productName: '合理用药系统' },            // 多
    { name: 'intervene', desc: '干预', project: 'pwrs', productName: '合理用药系统' },        // 多
  ] };
  const sysLabel = makeSysLabel(state);
  assert.equal(sysLabel('xinye666/wzh2.0'), '病案归档系统', '单系统产品 → 产品名');
  assert.equal(sysLabel('audit'), '审方', '多系统产品 → desc');
});

test('sysLabel · 未命中 / 空值 → 原样返回（键不动）', () => {
  const state = { systems: [{ name: 'audit', desc: '审方', project: 'pwrs', productName: 'X' }] };
  const sysLabel = makeSysLabel(state);
  assert.equal(sysLabel('nope'), 'nope', '未命中回退原名');
  assert.equal(sysLabel(''), '', '空值原样');
});

// ============ renderProdDD（子项目下拉）· 键不动 + 单子系统省组头 + 显示产品名 ============

test('renderProdDD · 单子系统产品：data-sub 仍为英文 name（匹配键不动）、显示为产品名、不渲染冗余组头', () => {
  const state = { curSub: '', subOptions: [
    { product: '病案归档系统', subs: [{ name: 'xinye666/wzh2.0', desc: '' }] },
  ] };
  const env = makeDomEnv();
  const { fn } = makeRenderProdDD(state, env);
  fn();
  const nodes = env.dd.children;
  // 首项恒为「全部子项目」(data-sub='')
  assert.equal(nodes[0].attrs['data-sub'], '', '首项=全部子项目 data-sub=""');
  // 单子系统：无 .grp 组头，直接一条 opt
  const grps = nodes.filter(n => n.className.indexOf('grp') >= 0);
  assert.equal(grps.length, 0, '单子系统产品不渲染冗余 .grp 组头');
  const opts = nodes.filter(n => /\bopt sub\b/.test(n.className));
  assert.equal(opts.length, 1, '恰一条子系统 opt');
  // 匹配键：data-sub 恒为英文 name（一个字不动）
  assert.equal(opts[0].attrs['data-sub'], 'xinye666/wzh2.0', '★ data-sub 仍是英文 name（匹配键不动）');
  // 显示：产品名（不是 xinye666/wzh2.0）
  assert.ok(opts[0].innerHTML.indexOf('病案归档系统') >= 0, '★ opt 显示为产品名');
  assert.ok(opts[0].innerHTML.indexOf('xinye666/wzh2.0') < 0, '★ opt 不显示丑的英文 full_name');
});

test('renderProdDD · 单子系统产品：selectSub 仍传英文 name（点击回调键不动）', () => {
  const state = { curSub: '', subOptions: [
    { product: '病案归档系统', subs: [{ name: 'xinye666/wzh2.0', desc: '' }] },
  ] };
  // 单独把 selectSub 采集出来：改造 makeRenderProdDD 无法直接触发 click（addEventListener 是空桩），
  // 故用源码断言 selectSub(nm) 传的是 nm（英文 name）——与 fs-02 A2b 现有断言一致，键不动。
  const renderBody = (FIELD.match(/function renderProdDD\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(renderBody, '能截取 renderProdDD 函数体');
  assert.match(renderBody, /selectSub\(nm\)/, 'selectSub 传英文 name（过滤键不动）');
  assert.match(renderBody, /setAttribute\('data-sub', nm\)/, 'data-sub=英文 name（过滤键不动）');
  void state;
});

test('renderProdDD · 多子系统产品：渲染组头 + 每条 opt data-sub=英文 name、显示 desc', () => {
  const state = { curSub: '', subOptions: [
    { product: '合理用药系统', subs: [
      { name: 'audit', desc: '审方' }, { name: 'intervene', desc: '干预' },
    ] },
  ] };
  const env = makeDomEnv();
  const { fn } = makeRenderProdDD(state, env);
  fn();
  const nodes = env.dd.children;
  const grps = nodes.filter(n => n.className.indexOf('grp') >= 0);
  assert.equal(grps.length, 1, '多子系统产品保留 .grp 组头');
  assert.equal(grps[0].textContent, '合理用药系统', '组头=产品名');
  const opts = nodes.filter(n => /\bopt sub\b/.test(n.className));
  assert.equal(opts.length, 2, '两条子系统 opt');
  // 键不动 + 显示 desc
  assert.equal(opts[0].attrs['data-sub'], 'audit', 'data-sub=英文 name');
  assert.equal(opts[1].attrs['data-sub'], 'intervene', 'data-sub=英文 name');
  assert.ok(opts[0].innerHTML.indexOf('审方') >= 0, '多子系统 opt 显 desc「审方」');
  assert.ok(opts[1].innerHTML.indexOf('干预') >= 0, '多子系统 opt 显 desc「干预」');
});

test('renderProdDD · 台账空（无 subOptions）→ 只全部子项目 + 空提示，不崩', () => {
  const state = { curSub: '', subOptions: [] };
  const env = makeDomEnv();
  const { fn } = makeRenderProdDD(state, env);
  fn();
  const nodes = env.dd.children;
  assert.equal(nodes[0].attrs['data-sub'], '', '仍有全部子项目项');
  const empty = nodes.filter(n => n.className.indexOf('f-proddd-empty') >= 0);
  assert.equal(empty.length, 1, '空态提示存在');
});
