// 更新包「按版本独立维护 + 跨版本累积」—— 连真实数据结构冒烟（version-releases/customers 文件存；账号/会话走真库）
//   ⚠️ 本测试 spawn 真实 server.mjs，需要 MySQL 在跑（登录/账号读真库）。本地 MySQL 当前不可用（ECONNREFUSED 3306）→ 未能本地运行，
//      留待有库环境 / 线上冒烟执行。纯逻辑（区间/累积/左连/勾选/合并SQL）已由 tools/version-plan.logic.test.mjs 本地覆盖（17/17 绿）。
//   覆盖：
//     · version-release-save 仅管理员（field 403）；title/name 空 400；补 id；产品不存在 400；roundtrip 读回。
//     · version-releases 管理员+field 可读，返回 gitTags + versions（已登记挂 tasks/sqls）。
//     · field/update-plan 按 sites 越权 403；结构（fromVersion/toVersion/versionsInRange/tasks/sqls/进度）。
//     · field/update-toggle 越权 403；幂等；写 customer.updateProgress 嵌套 + by/at 留痕；kind task/sql 分桶。
//     · field/update-sql-merged Content-Type text/plain + Content-Disposition attachment；空区间也 200 含说明注释。
//   护栏：version-releases.json/customers.json 测前备份、测后还原；账号带 TAG、after 精确删 + DB 兜底。
//   用法：node --test --test-concurrency=1 tools/version-plan.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'vp-' + TAG;                 // 隔离产品（无 git 仓 → listVersions 返回 []；用登记版本做 orphan 路径 + 结构断言）
const S_A = 'VP甲院-' + TAG;             // impl 负责
const S_OTHER = 'VP越权院-' + TAG;       // impl 不负责（测越权 403）
const U_IMPL = 'vpimpl_' + TAG;
const U_OTHER = 'vpother_' + TAG;
const PW = 'Abcd1234';
const VR_FILE = path.join(ROOT, 'data/version-releases.json');
const CUSTOMERS_FILE = path.join(ROOT, 'data/customers.json');
let srv = null, pool = null;
let vrBackup = null, vrExisted = false, custBackup = null, custExisted = false;
const created = { accountIds: [] };

function jar() { return { cookie: '' }; }
function api(p, { method = 'GET', body, jar: j, raw } = {}) {
  const hd = { 'Content-Type': 'application/json' };
  if (j && j.cookie) hd.Cookie = j.cookie;
  return fetch(BASE + p, { method, headers: hd, body: body ? JSON.stringify(body) : undefined }).then(async r => {
    const sc = r.headers.get('set-cookie'); if (j && sc) j.cookie = sc.split(';')[0];
    if (raw) return { status: r.status, headers: r.headers, text: await r.text().catch(() => '') };
    return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const admin = jar(), impl = jar(), other = jar();
function readCustomer(name) {
  try { const arr = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')).customers || []; return arr.find(c => (c.name || '').trim() === String(name).trim()) || null; } catch { return null; }
}
function readReleases() { try { return JSON.parse(fs.readFileSync(VR_FILE, 'utf8')); } catch { return {}; } }

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  try { vrBackup = fs.readFileSync(VR_FILE, 'utf8'); vrExisted = true; } catch { vrExisted = false; }
  try { custBackup = fs.readFileSync(CUSTOMERS_FILE, 'utf8'); custExisted = true; } catch { custExisted = false; }

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在隔离端口起来（需 MySQL）');

  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, jar: admin });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功');

  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: '版本累积冒烟', subsystems: [{ key: 'kwsb', name: 'kwsb', desc: '库房' }] }, jar: admin });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');

  const acc = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '版本实施', password: PW, sites: [S_A], projects: [PID] }, jar: admin });
  assert.equal(acc.json?.ok, true, '前置：造 impl 账号应成功');
  created.accountIds.push((acc.json.accounts || []).find(x => x.username === U_IMPL).id);
  const acc2 = await api('/api/account-save', { method: 'POST', body: { username: U_OTHER, role: 'impl', name: '越权实施', password: PW, sites: [S_OTHER], projects: [PID] }, jar: admin });
  assert.equal(acc2.json?.ok, true, '前置：造 other 账号应成功');
  created.accountIds.push((acc2.json.accounts || []).find(x => x.username === U_OTHER).id);

  // 造两家客户；S_A 该产品旧形状产品级 version=1.0（作 fromVersion 起点）
  for (const [name, implName, prods] of [
    [S_A, '版本实施', [{ project: PID, version: '1.0' }]],
    [S_OTHER, '越权实施', [{ project: PID, version: '1.0' }]],
  ]) {
    const r = await api('/api/customer-save', { method: 'POST', body: { name, impl: { name: implName }, products: prods }, jar: admin });
    assert.equal(r.json?.ok, true, '前置：造 ' + name + ' 台账应成功：' + JSON.stringify(r.json));
  }
  await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
  await api('/api/login', { method: 'POST', body: { username: U_OTHER, password: PW }, jar: other });
});

after(async () => {
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID }, jar: admin }); } catch {}
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  try { if (pool) await pool.query('DELETE FROM projects WHERE id = ?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id = ?', [PID]); } catch {}
  try { if (pool && created.accountIds.length) await pool.query(`DELETE FROM accounts WHERE id IN (${created.accountIds.map(() => '?').join(',')})`, created.accountIds); } catch {}
  try { if (vrExisted && vrBackup != null) fs.writeFileSync(VR_FILE, vrBackup); else if (fs.existsSync(VR_FILE)) fs.unlinkSync(VR_FILE); } catch {}
  try { if (custExisted && custBackup != null) fs.writeFileSync(CUSTOMERS_FILE, custBackup); else if (fs.existsSync(CUSTOMERS_FILE)) fs.unlinkSync(CUSTOMERS_FILE); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ============ 版本发版登记（version-release-save · 仅管理员）============
let VT1 = '', VS1 = '';
test('R-1 管理员登记 1.1 版本（delta 任务 + SQL）：补 id + roundtrip', async () => {
  const r = await api('/api/version-release-save', { method: 'POST', body: {
    product: PID, version: '1.1',
    tasks: [{ title: '停应用服务', desc: '优雅停机' }],
    sqls: [{ name: '加字段', content: 'ALTER TABLE t ADD COLUMN c INT;' }]
  }, jar: admin });
  assert.equal(r.json?.ok, true, '登记应 ok：' + JSON.stringify(r.json));
  assert.equal(r.json.tasks.length, 1);
  assert.equal(r.json.sqls.length, 1);
  assert.ok(r.json.tasks[0].id.startsWith('vt'), '任务 id 补 vt 前缀');
  assert.ok(r.json.sqls[0].id.startsWith('vs'), 'SQL id 补 vs 前缀');
  VT1 = r.json.tasks[0].id; VS1 = r.json.sqls[0].id;
  // 落文件
  const rel = readReleases()[PID] || {};
  assert.ok(rel['1.1'] && rel['1.1'].tasks.length === 1, 'version-releases.json 落该产品该版本');
});
test('R-2 title/name 空 → 400；产品不存在 → 400', async () => {
  const badT = await api('/api/version-release-save', { method: 'POST', body: { product: PID, version: '1.2', tasks: [{ title: '  ' }] }, jar: admin });
  assert.equal(badT.status, 400, 'title 空应 400');
  const badS = await api('/api/version-release-save', { method: 'POST', body: { product: PID, version: '1.2', sqls: [{ name: '', content: 'x' }] }, jar: admin });
  assert.equal(badS.status, 400, 'name 空应 400');
  const badP = await api('/api/version-release-save', { method: 'POST', body: { product: 'nope-' + TAG, version: '1.0', tasks: [{ title: 'x' }] }, jar: admin });
  assert.equal(badP.status, 400, '产品不存在应 400');
});
test('R-3 非管理员不能登记（403），但可读版本登记', async () => {
  const save = await api('/api/version-release-save', { method: 'POST', body: { product: PID, version: '1.1', tasks: [{ title: 'x' }] }, jar: impl });
  assert.equal(save.status, 403, 'field 登记应 403（authGate 挡·未入白名单）');
  const get = await api('/api/version-releases?product=' + encodeURIComponent(PID), { method: 'GET', jar: impl });
  assert.equal(get.json?.ok, true, 'field 应可读版本登记');
  assert.ok(Array.isArray(get.json.gitTags), '返回 gitTags 数组');
  assert.ok(Array.isArray(get.json.versions), '返回 versions 数组');
  // 无 git 仓 → 1.1 是 orphan（登记有、tag 无），也应带出来
  const v11 = get.json.versions.find(v => v.version === '1.1');
  assert.ok(v11 && v11.tasks.length === 1, '登记版本 1.1 带出 tasks（orphan 路径也不丢）');
});

// ============ 累积更新计划（field/update-plan）============
test('P-1 impl 拉自己院更新计划：结构完整（from/to/versionsInRange/tasks/sqls/进度）', async () => {
  const r = await api('/api/field/update-plan?site=' + encodeURIComponent(S_A) + '&product=' + PID + '&target=1.1', { method: 'GET', jar: impl });
  assert.equal(r.json?.ok, true, '拉计划应 ok：' + JSON.stringify(r.json));
  assert.equal(r.json.fromVersion, '1.0', 'fromVersion = 该院该产品现场版本');
  assert.equal(r.json.toVersion, '1.1');
  assert.ok('versionsInRange' in r.json && 'tasks' in r.json && 'sqls' in r.json, '带 versionsInRange/tasks/sqls');
  assert.ok('taskDone' in r.json && 'taskTotal' in r.json && 'sqlDone' in r.json && 'sqlTotal' in r.json, '带四个进度计数');
  // 无 git tag 时 listVersions=[] → range=[] → 累积为空（区间以 git tag 为准；本用例验结构 + 空区间兜底不崩）。
});
test('P-2 越权院 → 403', async () => {
  const r = await api('/api/field/update-plan?site=' + encodeURIComponent(S_A) + '&product=' + PID + '&target=1.1', { method: 'GET', jar: other });
  assert.equal(r.status, 403, '非负责医院拉计划应 403');
});

// ============ 勾选/取消（field/update-toggle）============
test('T-1 impl 勾选一条任务 → updateProgress 嵌套落态 + by/at 留痕 + 幂等', async () => {
  const r = await api('/api/field/update-toggle', { method: 'POST', body: { site: S_A, product: PID, version: '1.1', kind: 'task', itemId: VT1, done: true }, jar: impl });
  assert.equal(r.json?.ok, true, '勾选应 ok：' + JSON.stringify(r.json));
  assert.equal(r.json.changed, true);
  const c = readCustomer(S_A);
  assert.ok(c.updateProgress && c.updateProgress[PID] && c.updateProgress[PID]['1.1'] && c.updateProgress[PID]['1.1'].tasks[VT1].done === true, '嵌套 updateProgress[product][version].tasks[id].done');
  assert.ok(c.updateProgress[PID]['1.1'].tasks[VT1].by && c.updateProgress[PID]['1.1'].tasks[VT1].at, 'by/at 留痕');
  // 幂等：再勾一次 changed=false
  const r2 = await api('/api/field/update-toggle', { method: 'POST', body: { site: S_A, product: PID, version: '1.1', kind: 'task', itemId: VT1, done: true }, jar: impl });
  assert.equal(r2.json.changed, false, '重复勾选幂等 changed=false');
});
test('T-2 kind sql 独立分桶（同版本 task/sql 不串）+ 取消假删', async () => {
  const r = await api('/api/field/update-toggle', { method: 'POST', body: { site: S_A, product: PID, version: '1.1', kind: 'sql', itemId: VS1, done: true }, jar: impl });
  assert.equal(r.json.changed, true);
  const c = readCustomer(S_A);
  assert.equal(c.updateProgress[PID]['1.1'].sqls[VS1].done, true, 'sql 桶独立落态');
  assert.equal(c.updateProgress[PID]['1.1'].tasks[VT1].done, true, 'task 桶不受影响');
  // 取消 → 假删该键
  const un = await api('/api/field/update-toggle', { method: 'POST', body: { site: S_A, product: PID, version: '1.1', kind: 'sql', itemId: VS1, done: false }, jar: impl });
  assert.equal(un.json.changed, true);
  assert.equal(VS1 in (readCustomer(S_A).updateProgress[PID]['1.1'].sqls || {}), false, '取消 → 假删 sql 键');
});
test('T-3 越权院勾选 → 403', async () => {
  const r = await api('/api/field/update-toggle', { method: 'POST', body: { site: S_A, product: PID, version: '1.1', kind: 'task', itemId: VT1, done: true }, jar: other });
  assert.equal(r.status, 403, '非负责医院勾选应 403');
});

// ============ 合并 SQL 下载（field/update-sql-merged）============
test('M-1 合并下载：Content-Type text/plain + Content-Disposition attachment + 文件头注释', async () => {
  const r = await api('/api/field/update-sql-merged?site=' + encodeURIComponent(S_A) + '&product=' + PID + '&target=1.1', { method: 'GET', jar: impl, raw: true });
  assert.equal(r.status, 200, '合并下载 200');
  assert.match(r.headers.get('content-type') || '', /text\/plain/, 'Content-Type text/plain');
  assert.match(r.headers.get('content-disposition') || '', /attachment; filename=".*\.sql"/, 'attachment + .sql 文件名');
  assert.match(r.text, /更新 SQL 合并脚本/, '文件头注释');
  // 无 git tag → 区间空 → 含「暂无已登记的 SQL 脚本」说明注释（不 500）
});
test('M-2 越权院合并下载 → 403', async () => {
  const r = await api('/api/field/update-sql-merged?site=' + encodeURIComponent(S_A) + '&product=' + PID + '&target=1.1', { method: 'GET', jar: other, raw: true });
  assert.equal(r.status, 403, '非负责医院合并下载应 403');
});
