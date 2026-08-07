// 发布闭环·版本回写（BP-01 / FS-05）· 脱库逻辑测试
//   背景：走完发布流程（定档建批→出包→现场下载→逐单验证 pass）后，现场医院版本要按新包版本 bt.pkgVersion 更新。
//   本地 MySQL 常 ECONNREFUSED 3306、server.mjs 启动即 await db.init() 失败退出——故从源码**抽真身函数**沙箱 eval（测真实源码·抓漂移），不重写副本。
//   覆盖：
//     A. bumpCustomerVersion（纯函数·抽真身）：新形状写子系统 / 旧形状写产品级 / subsystem 空=整产品 / 幂等 / 找不到产品·子系统跳过。
//     B. bumpSiteVersionForBatch（抽真身 + 注入 IO 桩）：per-hospital 全关闭才更 / 无 pkgVersion 不更 / 只更该批覆盖到的子系统 / 台账无医院跳过 / 留痕 versionLog。
//   用法：node --test tools/publish-version-bump.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

// —— 从源码抽出具名函数体（配平大括号），供沙箱 eval —— //
function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}

// bumpCustomerVersion 纯函数无外部依赖 —— 直接抽真身
const bumpCustomerVersion = new Function(extractFn(SRC, 'bumpCustomerVersion') + '\nreturn bumpCustomerVersion;')();

/* ================= A. bumpCustomerVersion（纯函数真身） ================= */

test('A1 新形状：指定子系统 → 只更该子系统 version', () => {
  const c = { name: 'X院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }, { name: 'audit', version: '2.7' }] }] };
  const r = bumpCustomerVersion(c, 'hlyy', 'pkb', '2.8');
  assert.equal(r.changed, true);
  assert.deepEqual(r.bumped, [{ subsystem: 'pkb', fromVer: '2.7', toVer: '2.8' }]);
  assert.equal(c.products[0].subsystems.find(s => s.name === 'pkb').version, '2.8', 'pkb 更到 2.8');
  assert.equal(c.products[0].subsystems.find(s => s.name === 'audit').version, '2.7', 'audit 不动');
});

test('A2 新形状：subsystem 空 = 整包升级 → 所有已登记子系统都更', () => {
  const c = { name: 'X院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }, { name: 'audit', version: '2.6' }] }] };
  const r = bumpCustomerVersion(c, 'hlyy', '', '2.8');
  assert.equal(r.changed, true);
  assert.equal(r.bumped.length, 2, '两个子系统都更');
  assert.ok(c.products[0].subsystems.every(s => s.version === '2.8'), '全更到 2.8');
});

test('A3 旧形状：产品级 version（subsystem 忽略）', () => {
  const c = { name: 'X院', products: [{ project: 'psp', version: 'v2.0' }] };
  const r = bumpCustomerVersion(c, 'psp', 'anything', 'v2.1');
  assert.equal(r.changed, true);
  assert.deepEqual(r.bumped, [{ subsystem: '', fromVer: 'v2.0', toVer: 'v2.1' }]);
  assert.equal(c.products[0].version, 'v2.1');
});

test('A4 幂等：已是目标版本 → 不写、changed=false', () => {
  const c = { name: 'X院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.8' }] }] };
  const r = bumpCustomerVersion(c, 'hlyy', 'pkb', '2.8');
  assert.equal(r.changed, false);
  assert.equal(r.bumped.length, 0);
});

test('A5 找不到产品 → 跳过不报错', () => {
  const c = { name: 'X院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }] }] };
  const r = bumpCustomerVersion(c, 'nope', 'pkb', '2.8');
  assert.equal(r.changed, false);
});

test('A6 新形状·台账没登记的子系统 → 跳过不新增（避免臆造）', () => {
  const c = { name: 'X院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }] }] };
  const r = bumpCustomerVersion(c, 'hlyy', 'audit', '2.8');   // audit 未登记
  assert.equal(r.changed, false, '未登记子系统不更');
  assert.equal(c.products[0].subsystems.length, 1, '不新增子系统条目');
});

test('A7 护栏：空 newVer / 无 products → 不更', () => {
  assert.equal(bumpCustomerVersion({ name: 'X', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }] }] }, 'hlyy', 'pkb', '').changed, false);
  assert.equal(bumpCustomerVersion({ name: 'X' }, 'hlyy', 'pkb', '2.8').changed, false);
  assert.equal(bumpCustomerVersion(null, 'hlyy', 'pkb', '2.8').changed, false);
});

test('A8 版本号 30 位截断（对齐 customer-version）', () => {
  const c = { name: 'X院', products: [{ project: 'psp', version: 'v1' }] };
  const long = 'v' + '9'.repeat(40);
  const r = bumpCustomerVersion(c, 'psp', '', long);
  assert.equal(c.products[0].version.length, 30, '截断到 30');
  assert.equal(r.bumped[0].toVer.length, 30);
});

/* ================= B. bumpSiteVersionForBatch（抽真身 + 注入 IO 桩） ================= */
// 该函数依赖 loadIntake / deriveLifecycle / loadCustomers / saveCustomers / nowStamp / bumpCustomerVersion —— 用桩注入，验证「全关闭判定 + 只更本批覆盖子系统 + 幂等 + 留痕」编排逻辑。

function makeBumpSite({ intakes, customers }) {
  let saved = null;
  const deps = {
    bumpCustomerVersion,
    deriveLifecycle: (e) => e.lifecycle || '待处理',
    nowStamp: () => '2026-08-07 12:00',
    loadIntake: (proj, id) => { const e = intakes[id]; return e ? JSON.parse(JSON.stringify(e)) : null; },
    loadCustomers: () => JSON.parse(JSON.stringify(customers)),
    saveCustomers: (list) => { saved = list; },
  };
  const fn = new Function(
    'bumpCustomerVersion', 'deriveLifecycle', 'nowStamp', 'loadIntake', 'loadCustomers', 'saveCustomers',
    extractFn(SRC, 'bumpSiteVersionForBatch') + '\nreturn bumpSiteVersionForBatch;'
  )(deps.bumpCustomerVersion, deps.deriveLifecycle, deps.nowStamp, deps.loadIntake, deps.loadCustomers, deps.saveCustomers);
  return { fn, getSaved: () => saved };
}

const PROJ = { id: 'hlyy' };

test('B1 该院全单已关闭 → 只更本批覆盖到的子系统到 pkgVersion + 留痕', () => {
  const intakes = {
    T1: { id: 'T1', site: '安吉县人民医院', subsystem: 'pkb', lifecycle: '已关闭' },
    T2: { id: 'T2', site: '安吉县人民医院', subsystem: 'audit', lifecycle: '已关闭' },
    T3: { id: 'T3', site: '别的医院', subsystem: 'pkb', lifecycle: '待验证' },
  };
  const customers = [{ name: '安吉县人民医院', products: [{ project: 'hlyy', subsystems: [
    { name: 'pkb', version: '2.7' }, { name: 'audit', version: '2.7' }, { name: 'report', version: '2.7' },
  ] }] }];
  const bt = { id: 'B-01', product: 'hlyy', pkgVersion: '2.8', ticketIds: ['T1', 'T2', 'T3'] };
  const { fn, getSaved } = makeBumpSite({ intakes, customers });
  const r = fn(bt, PROJ, '安吉县人民医院');
  assert.equal(r.changed, true);
  assert.equal(r.bumped.length, 2, 'pkb+audit 两个覆盖到的子系统更');
  const saved = getSaved();
  const subs = saved[0].products[0].subsystems;
  assert.equal(subs.find(s => s.name === 'pkb').version, '2.8');
  assert.equal(subs.find(s => s.name === 'audit').version, '2.8');
  assert.equal(subs.find(s => s.name === 'report').version, '2.7', '本批没覆盖 report → 不动');
  assert.ok(Array.isArray(saved[0].versionLog) && saved[0].versionLog.length === 2, '留痕两条 versionLog');
  assert.equal(saved[0].versionLog[0].by, '系统·发布闭环');
  assert.equal(saved[0].versionLog[0].batch, 'B-01');
});

test('B2 该院还有单未关闭 → 不更（还没验完）', () => {
  const intakes = {
    T1: { id: 'T1', site: '安吉县人民医院', subsystem: 'pkb', lifecycle: '已关闭' },
    T2: { id: 'T2', site: '安吉县人民医院', subsystem: 'audit', lifecycle: '待验证' },
  };
  const customers = [{ name: '安吉县人民医院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }, { name: 'audit', version: '2.7' }] }] }];
  const bt = { id: 'B-01', product: 'hlyy', pkgVersion: '2.8', ticketIds: ['T1', 'T2'] };
  const { fn, getSaved } = makeBumpSite({ intakes, customers });
  const r = fn(bt, PROJ, '安吉县人民医院');
  assert.equal(r.changed, false, '未全关闭 → 不更');
  assert.equal(getSaved(), null, '不写盘');
});

test('B3 无 pkgVersion（没出包）→ 不更', () => {
  const intakes = { T1: { id: 'T1', site: '安吉县人民医院', subsystem: 'pkb', lifecycle: '已关闭' } };
  const customers = [{ name: '安吉县人民医院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }] }] }];
  const { fn } = makeBumpSite({ intakes, customers });
  assert.equal(fn({ id: 'B-01', product: 'hlyy', pkgVersion: '', ticketIds: ['T1'] }, PROJ, '安吉县人民医院').changed, false);
  assert.equal(fn({ id: 'B-01', product: 'hlyy', pkgVersion: '-', ticketIds: ['T1'] }, PROJ, '安吉县人民医院').changed, false, '占位 - 也不更');
});

test('B4 台账无该医院 → 跳过不报错', () => {
  const intakes = { T1: { id: 'T1', site: '幽灵医院', subsystem: 'pkb', lifecycle: '已关闭' } };
  const customers = [{ name: '安吉县人民医院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.7' }] }] }];
  const { fn } = makeBumpSite({ intakes, customers });
  assert.equal(fn({ id: 'B-01', product: 'hlyy', pkgVersion: '2.8', ticketIds: ['T1'] }, PROJ, '幽灵医院').changed, false);
});

test('B5 幂等：现场已是 pkgVersion → 不重复写', () => {
  const intakes = { T1: { id: 'T1', site: '安吉县人民医院', subsystem: 'pkb', lifecycle: '已关闭' } };
  const customers = [{ name: '安吉县人民医院', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.8' }] }] }];
  const { fn, getSaved } = makeBumpSite({ intakes, customers });
  const r = fn({ id: 'B-01', product: 'hlyy', pkgVersion: '2.8', ticketIds: ['T1'] }, PROJ, '安吉县人民医院');
  assert.equal(r.changed, false);
  assert.equal(getSaved(), null, '幂等不写盘');
});

test('B6 覆盖工单无子系统标注 → 整产品（旧形状写产品级）', () => {
  const intakes = { T1: { id: 'T1', site: 'X院', subsystem: '', lifecycle: '已关闭' } };
  const customers = [{ name: 'X院', products: [{ project: 'psp', version: 'v2.0' }] }];
  const { fn, getSaved } = makeBumpSite({ intakes, customers });
  const r = fn({ id: 'B-02', product: 'psp', pkgVersion: 'v2.1', ticketIds: ['T1'] }, PROJ, 'X院');
  assert.equal(r.changed, true);
  assert.equal(getSaved()[0].products[0].version, 'v2.1');
});
