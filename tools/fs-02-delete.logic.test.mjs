// FS-02 删除（现场提交记录软删除）· 脱库逻辑测试（零依赖 node:test，无 MySQL、不 spawn server）
//   本地 MySQL 常 ECONNREFUSED 3306，且 server.mjs 启动即 await db.init() 失败 process.exit(1)、无法 import。
//   → 直接从 server.mjs 源码抽出被测函数体（intakeDeleteGuard）在沙箱里 eval，测真实源码（非重写副本，能抓漂移）。
//   覆盖：① 已转工单/已归批禁删 ② 越权 site 拒绝 ③ 正常可删 ④ 不存在/已删幂等 ⑤ 管理员放行
//         ⑥ listIntake 过滤 deleted ⑦ batch-arrange 跳过 deleted ⑧ mapItem 的 deletable 计算 ⑨ 白名单两 Set 均含 /api/intake-delete
//   用法：node --test tools/fs-02-delete.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

// —— 从源码抽出 intakeDeleteGuard 的完整函数体（从 `function intakeDeleteGuard` 到其闭合大括号），在沙箱 eval —— //
function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  // 从函数名后第一个 `{` 起做括号配平，取到匹配的 `}`
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}

// intakeDeleteGuard 依赖 isAdmin（server.mjs 内 role==='admin'||'dev'）→ 沙箱注入等价 stub。
const isAdmin = (u) => !!(u && (u.role === 'admin' || u.role === 'dev'));
const guardSrc = extractFn(SRC, 'intakeDeleteGuard');
// eslint-disable-next-line no-new-func
const intakeDeleteGuard = new Function('isAdmin', guardSrc + '\nreturn intakeDeleteGuard;')(isAdmin);

const fieldUser = { role: 'impl', name: '张实施', sites: ['山东省立医院', '济南中心医院'] };
const otherUser = { role: 'impl', name: '李某', sites: ['郑州人民医院'] };
const adminUser = { role: 'admin', name: '管理员', sites: [] };

test('AC-DEL-1 已转工单的咨询（convertedTo 有值）→ 禁删', () => {
  const e = { id: 'C-1', type: 'consult', site: '山东省立医院', convertedTo: 'REQ-9' };
  const r = intakeDeleteGuard(e, fieldUser);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'converted');
  assert.match(r.error, /已转工单/);
});

test('AC-DEL-2 已归批的需求/BUG（batch 有值）→ 禁删', () => {
  const e = { id: 'REQ-2', type: 'requirement', site: '山东省立医院', batch: 'B-01' };
  const r = intakeDeleteGuard(e, fieldUser);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'batched');
  assert.match(r.error, /已归批/);
});

test('AC-DEL-2b batch 为纯空白串 → 不算已归批，可删', () => {
  const e = { id: 'REQ-3', type: 'requirement', site: '山东省立医院', batch: '   ' };
  assert.equal(intakeDeleteGuard(e, fieldUser).ok, true);
});

test('AC-DEL-3 现场账号删不在自己 sites 的记录 → 无权（forbidden）', () => {
  const e = { id: 'BUG-1', type: 'bug', site: '郑州人民医院' };   // 不在 fieldUser.sites
  const r = intakeDeleteGuard(e, fieldUser);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'forbidden');
  assert.match(r.error, /无权/);
});

test('AC-DEL-3b 现场账号删自己 sites 内记录 → 放行', () => {
  const e = { id: 'BUG-2', type: 'bug', site: '济南中心医院' };
  assert.equal(intakeDeleteGuard(e, fieldUser).ok, true);
  // 另一现场账号（郑州）删同一条 → 越权拒
  assert.equal(intakeDeleteGuard(e, otherUser).ok, false);
});

test('AC-DEL-4 管理员不受 sites 限制 → 任意记录可删', () => {
  const e = { id: 'REQ-5', type: 'requirement', site: '任意医院' };
  assert.equal(intakeDeleteGuard(e, adminUser).ok, true);
});

test('AC-DEL-5 记录不存在 → not_found', () => {
  const r = intakeDeleteGuard(null, fieldUser);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'not_found');
});

test('AC-DEL-6 已删记录再删 → 幂等 gone（端点侧当成功从清单移除）', () => {
  const e = { id: 'REQ-6', type: 'requirement', site: '山东省立医院', deleted: true };
  const r = intakeDeleteGuard(e, fieldUser);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'gone');
});

test('AC-DEL-6b 守卫顺序：已删优先于禁删/越权（deleted 先判）', () => {
  const e = { id: 'X', type: 'consult', site: '郑州人民医院', deleted: true, convertedTo: 'R-1', batch: 'B-1' };
  assert.equal(intakeDeleteGuard(e, fieldUser).code, 'gone');   // 即便同时越权+已转工单+已归批，先返 gone
});

test('AC-DEL-7 三类型（咨询/需求/BUG）均可删（无禁删态时）', () => {
  for (const t of ['consult', 'requirement', 'bug']) {
    const e = { id: t, type: t, site: '山东省立医院' };
    assert.equal(intakeDeleteGuard(e, fieldUser).ok, true, `${t} 应可删`);
  }
});

// —— 源码级断言：过滤/白名单/deletable 计算就在真实 server.mjs 里 —— //

test('AC-DEL-8 listIntake 过滤 deleted（软删记录不再出现在任何 listIntake 消费点）', () => {
  const line = SRC.split('\n').find(l => l.includes('function listIntake'));
  assert.ok(line, '应能找到 listIntake 定义');
  assert.match(line, /\.filter\(e\s*=>\s*!e\.deleted( &&[^)]*)?\)/, 'listIntake 必须先滤掉 e.deleted（覆盖 intake-list/field-submissions/aggregate/export/todo 等所有消费点）；FS-04 AC-36 追加排除 intake-conv 会话记录不影响此保证');
});

test('AC-DEL-9 batch-arrange 归批扫描跳过 deleted（软删记录不被扫进新批次）', () => {
  // batch-arrange 用 Object.values(store) 直扫，不走 listIntake → 必须显式 continue deleted
  assert.match(SRC, /if\s*\(e\.deleted\)\s*continue;/, 'batch-arrange 循环须显式跳过 e.deleted 记录');
});

test('AC-DEL-10 mapItem 下发 deletable = 非 convertedTo 且非 batch（前端显隐用）', () => {
  const line = SRC.split('\n').find(l => l.includes('deletable:'));
  assert.ok(line, 'mapItem 应下发 deletable 字段');
  assert.match(line, /deletable:\s*!conv\s*&&\s*!bid/, 'deletable = 非已转工单(conv) 且 非已归批(bid)');
  assert.match(line, /convertedTo:\s*conv/, 'mapItem 同时下发 convertedTo（前端判定/审计）');
});

test('AC-DEL-11 intake-detail 对已删记录返回 404（不可 reopen）', () => {
  assert.match(SRC, /e\.deleted\)\s*return send\(res,\s*404[\s\S]{0,60}记录已删除/, 'intake-detail 命中 e.deleted → 404 记录已删除');
});

test('AC-DEL-12 consult-to-intake 拒绝已删咨询（src.deleted 参与守卫）', () => {
  assert.match(SRC, /src\.type\s*!==\s*'consult'\s*\|\|\s*src\.deleted/, 'consult-to-intake 守卫含 src.deleted');
});

test('AC-DEL-13 /api/intake-delete 同时在 FIELD_OK 与 FS08_FIELD_API 两个白名单（漏一个→实施域 originGate deny，实测坑）', () => {
  function extractSet(name) {
    const re = new RegExp(name + '\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)');
    const m = SRC.match(re);
    assert.ok(m, `应能抽到 ${name} 的 new Set([...])`);
    return m[1].split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  const fieldOk = new Set(extractSet('FIELD_OK'));
  const fs08 = new Set(extractSet('FS08_FIELD_API'));
  assert.ok(fieldOk.has('/api/intake-delete'), '/api/intake-delete 必须在 FIELD_OK');
  assert.ok(fs08.has('/api/intake-delete'), '/api/intake-delete 必须在 FS08_FIELD_API（否则实施域被 deny→forbidden）');
});

test('AC-DEL-14 端点软删写 e.deleted/deletedAt/deletedBy + history 留痕（不真删库/磁盘）', () => {
  // 抽取 /api/intake-delete 端点块，断言软删三标记 + history.push 留痕 + saveIntake
  const idx = SRC.indexOf("url.pathname === '/api/intake-delete'");
  assert.ok(idx >= 0, '应能找到 /api/intake-delete 端点');
  const block = SRC.slice(idx, idx + 2200);
  assert.match(block, /e\.deleted\s*=\s*true/, '写 e.deleted=true');
  assert.match(block, /e\.deletedAt\s*=/, '写 e.deletedAt');
  assert.match(block, /e\.deletedBy\s*=/, '写 e.deletedBy');
  assert.match(block, /history\.push\([\s\S]{0,120}已删除[\s\S]{0,60}删除/, "history 留痕 to:'已删除' note:'删除'");
  assert.match(block, /await saveIntake\(proj,\s*e\)/, '复用 saveIntake 落库（缓存+MySQL data JSON+导出，不加库列、不真删）');
});
