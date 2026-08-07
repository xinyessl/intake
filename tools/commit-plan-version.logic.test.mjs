// commit-plan 建单「版本服务端派生」· 脱库逻辑测试
//   背景（修 bug）：/api/intake-commit-plan 建单时 version 原本直接取 b.version（前端 archive.version）——
//     现场停在「全部子项目/未选具体版本」时 b.version 为空 → 工单 version='' → 后台工单列表版本列显 —。
//   修法：改「服务端派生」——按提交医院(site)在客户台账登记的「该产品·该工单子系统」现场版本取；
//     兜底链：custSubVersion(子系统命中) → custProductVersion(产品级一致) → b.version(前端传值) → ''。
//   子系统名键匹配：e.subsystem(itSub) 存英文 key（如 pkb）；customer.products[].subsystems[].name 也存英文 key；
//     custSubVersion 按 s.name===subsystem 命中；命中不了（中文名/待定/未登记）回退产品级。
//   本地 MySQL 常 ECONNREFUSED、server 启动即 db.init() 退出——故走静态断言（抓接线漂移）+ 忠实复刻派生逻辑（抓行为回归）。
//   连真库冒烟走 prod（见交付说明），本组只保证逻辑/接线不回归。
//   用法：node --test tools/commit-plan-version.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

/* ============ A. 后端接线（派生逻辑挂在 commit-plan 建单处，且不再直接用 b.version 建单） ============ */
test('A1 commit-plan 端点存在', () => {
  assert.ok(/url\.pathname === '\/api\/intake-commit-plan'/.test(SRC), '应有 /api/intake-commit-plan 端点');
});
test('A2 commit-plan 段内定义 deriveVersion 派生函数（按 site 找 customer + 兜底链）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-commit-plan'"), SRC.indexOf("url.pathname === '/api/consult'"));
  assert.ok(/const custForVer = loadCustomers\(\)\.find\(c => \(c\.name \|\| ''\)\.trim\(\) === String\(site \|\| ''\)\.trim\(\)\)/.test(seg), '按 site↔customer.name 找客户');
  assert.ok(/const prodVer = custForVer \? custProductVersion\(custForVer, proj\.id\)/.test(seg), '产品级一致版本作回退');
  assert.ok(/const deriveVersion = \(itSub\) =>/.test(seg), '有 deriveVersion 派生函数');
  assert.ok(/custSubVersion\(custForVer, proj\.id, itSub\)/.test(seg), '优先按子系统取现场版本');
  assert.ok(/String\(bySub \|\| prodVer \|\| version \|\| ''\)\.trim\(\)/.test(seg), '兜底链：子系统→产品级→b.version→空');
});
test('A3 new 分支建单用 deriveVersion(itSub)，不再直接用 version', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-commit-plan'"), SRC.indexOf("url.pathname === '/api/consult'"));
  assert.ok(/const e = \{ id, type: itType, project: proj\.id, version: deriveVersion\(itSub\),/.test(seg), 'new 建单 version 取 deriveVersion(itSub)');
  // append 分支不涉及 version（只补内容），确保没被误改
  assert.ok(!/appended\.push[\s\S]{0,200}deriveVersion/.test(seg), 'append 分支不改 version');
});

/* ============ B. 忠实复刻派生逻辑：命中 / 回退产品级 / 回退 b.version / 空 ============ */
// 复刻 server.mjs 的 custSubVersion / custProductVersion（L204/L215）
function custSubVersion(cust, productId, subsystem) {
  if (!cust || !Array.isArray(cust.products)) return '';
  const pr = cust.products.find(p => p && p.project === productId); if (!pr) return '';
  if (Array.isArray(pr.subsystems)) { const ms = subsystem ? pr.subsystems.find(s => s && s.name === subsystem) : null; return (ms && ms.version) || ''; }
  return pr.version || '';
}
function custProductVersion(cust, productId) {
  if (!cust || !Array.isArray(cust.products)) return '';
  const pr = cust.products.find(p => p && p.project === productId); if (!pr) return '';
  if (Array.isArray(pr.subsystems)) {
    const vers = pr.subsystems.map(s => String((s && s.version) || '').trim()).filter(Boolean);
    if (!vers.length) return '';
    const uniq = [...new Set(vers)];
    return uniq.length === 1 ? uniq[0] : '';
  }
  return String(pr.version || '').trim();
}
// 复刻 commit-plan 里的 deriveVersion（bySub || prodVer || version || ''）
function makeDerive(cust, productId, frontendVersion) {
  const prodVer = cust ? custProductVersion(cust, productId) : '';
  return (itSub) => {
    const bySub = cust ? custSubVersion(cust, productId, itSub) : '';
    return String(bySub || prodVer || frontendVersion || '').trim();
  };
}

// 真实 prod 数据形状：安吉县人民医院·hlyy·各子系统均 2.7.260723-1（英文 key name）
const anji = { name: '安吉县人民医院', products: [{ project: 'hlyy', subsystems: [
  { name: 'audit', version: '2.7.260723-1' }, { name: 'report', version: '2.7.260723-1' },
  { name: 'intervene', version: '2.7.260723-1' }, { name: 'review', version: '2.7.260723-1' },
  { name: 'pkb', version: '2.7.260723-1' } ] }] };

test('B1 子系统命中（itSub=pkb，英文 key）→ 取现场子系统版本', () => {
  const d = makeDerive(anji, 'hlyy', '');   // 前端未传版本（bug 场景）
  assert.equal(d('pkb'), '2.7.260723-1', 'pkb 应命中安吉现场版本');
  assert.equal(d('audit'), '2.7.260723-1', 'audit 同样命中');
});
test('B2 子系统命中不了（中文名/待定）→ 回退产品级一致版本', () => {
  const d = makeDerive(anji, 'hlyy', '');
  assert.equal(d('审方'), '2.7.260723-1', '中文名不命中子系统 → 回退产品级一致版本');
  assert.equal(d('待定'), '2.7.260723-1', '待定不命中 → 回退产品级');
  assert.equal(d(''), '2.7.260723-1', '空子系统 → 回退产品级');
});
test('B3 产品级不一致时回退到前端传值 b.version', () => {
  const mixed = { name: '某院', products: [{ project: 'hlyy', subsystems: [
    { name: 'pkb', version: '2.7.1' }, { name: 'audit', version: '2.7.2' } ] }] };
  const d = makeDerive(mixed, 'hlyy', '3.0.0');
  assert.equal(d('pkb'), '2.7.1', '命中子系统时仍取子系统版本（优先）');
  assert.equal(d('审方'), '3.0.0', '不命中子系统 + 产品级不一致 → 回退 b.version');
});
test('B4 客户未登记该产品 / 无客户 → 回退 b.version → 空', () => {
  const other = { name: '未登记院', products: [{ project: 'pams', version: '1.0' }] };
  const d1 = makeDerive(other, 'hlyy', '9.9.9');
  assert.equal(d1('pkb'), '9.9.9', '客户没登记 hlyy → 回退 b.version');
  const d2 = makeDerive(null, 'hlyy', '');
  assert.equal(d2('pkb'), '', '无客户 + 无 b.version → 空（不臆造）');
});
test('B5 旧形状 { project, version }（产品级 version）→ 命中产品级', () => {
  const legacy = { name: '老院', products: [{ project: 'hlyy', version: '2.5.0' }] };
  const d = makeDerive(legacy, 'hlyy', '');
  assert.equal(d('pkb'), '2.5.0', '旧形状子系统兜底同产品级 version');
  assert.equal(d('待定'), '2.5.0', '旧形状不分子系统');
});
test('B6 bug 复现：前端 b.version 为空 + 现场有版本 → 不再空（本 bug 核心）', () => {
  const d = makeDerive(anji, 'hlyy', '');   // 前端 archive.version 空（现场停在「未选具体版本」）
  assert.equal(d('pkb'), '2.7.260723-1', '前端空但现场有版本 → 工单版本不再是 ——');
  assert.notEqual(d('pkb'), '', '绝不再落空版本');
});
