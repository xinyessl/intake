// FS-06 现场实施代办清单 —— 连真实数据结构冒烟（客户/批次文件存，无 MySQL 表；账号/会话走真库）
//   ⚠️ 本测试 spawn 真实 server.mjs，需要 MySQL 在跑（登录/账号读真库）。本地 MySQL 当前不可用（ECONNREFUSED 3306）→ 未能本地运行，
//      留待有库环境 / 线上冒烟执行（编排器部署后连线上真库跑）。纯文件存逻辑已由 tools/fs-06-checklist.logic.test.mjs 本地覆盖（11/11 绿）。
//   覆盖：
//     场景1 部署清单（2026-08-03：完成度按 (医院,产品) 分记）：deploy-template-save/get（仅管理员存·title 空 400·截断）
//        → 每院每产品 customer-deploy-task {site,product,taskId,done} 勾选/取消（越权 403·product 不属/缺失 400·幂等·留痕 by/at·嵌套落态·taskId 不存在 400）
//        → 产品A勾不影响产品B → /api/customers 派生聚合 deployDone/deployTotal（M×P）→ 模板删项分母随之变。
//     场景2 更新包清单：batch-update 定义 implTasks（按 id 合并保留完成态）→ batch-task 全局勾选（幂等·doneBy/doneAt 留痕·不存在项 400）→ batchOut/field 批次视图带 implTasks。
//   护栏：customers.json/batches.json 测前备份、测后还原；账号带 TAG、after 精确删 + DB 兜底；deploy-template.json 测前备份还原。
//   用法：node --test --test-concurrency=1 tools/fs-06-checklist.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5800 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'fs06ck-' + TAG;
const PID2 = 'fs06ck2-' + TAG;      // 第二产品（验部署完成度按 (医院,产品) 分记：勾产品A不影响产品B + 聚合进度 M×P）
const S_A = 'CK甲院-' + TAG;         // impl 负责
const S_B = 'CK乙院-' + TAG;         // impl 负责（第二院，验各院进度独立）
const S_OTHER = 'CK越权院-' + TAG;   // impl 不负责（测越权 403）
const U_IMPL = 'fs06ckimpl_' + TAG;
const U_OTHER = 'fs06ckother_' + TAG;
const PW = 'Abcd1234';
const CUSTOMERS_FILE = path.join(ROOT, 'data/customers.json');
const BATCHES_FILE = path.join(ROOT, 'data/batches.json');
const TPL_FILE = path.join(ROOT, 'data/deploy-template.json');
let srv = null, pool = null;
let custBackup = null, custExisted = false, batchBackup = null, batchExisted = false, tplBackup = null, tplExisted = false;
const created = { accountIds: [] };

function jar() { return { cookie: '' }; }
function api(p, { method = 'GET', body, jar: j } = {}) {
  const hd = { 'Content-Type': 'application/json' };
  if (j && j.cookie) hd.Cookie = j.cookie;
  return fetch(BASE + p, { method, headers: hd, body: body ? JSON.stringify(body) : undefined }).then(async r => {
    const sc = r.headers.get('set-cookie'); if (j && sc) j.cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const admin = jar(), impl = jar(), other = jar();
function readCustomer(name) {
  try { const arr = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')).customers || []; return arr.find(c => (c.name || '').trim() === String(name).trim()) || null; } catch { return null; }
}
function readBatch(id) {
  try { const arr = JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8')).batches || []; return arr.find(b => b.id === id) || null; } catch { return null; }
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  try { custBackup = fs.readFileSync(CUSTOMERS_FILE, 'utf8'); custExisted = true; } catch { custExisted = false; }
  try { batchBackup = fs.readFileSync(BATCHES_FILE, 'utf8'); batchExisted = true; } catch { batchExisted = false; }
  try { tplBackup = fs.readFileSync(TPL_FILE, 'utf8'); tplExisted = true; } catch { tplExisted = false; }

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在隔离端口起来（需 MySQL）');

  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, jar: admin });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功');

  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS-06 清单冒烟', subsystems: [{ key: 'kwsb', name: 'kwsb', desc: '库房' }] }, jar: admin });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
  const ps2 = await api('/api/project-save', { method: 'POST', body: { id: PID2, name: 'FS-06 清单冒烟B', subsystems: [{ key: 'kwsb', name: 'kwsb', desc: '库房' }] }, jar: admin });
  assert.equal(ps2.json?.ok, true, '前置：造第二隔离产品应成功');

  // impl 绑甲/乙院；other 绑越权院
  const acc = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '清单实施', password: PW, sites: [S_A, S_B], projects: [PID, PID2] }, jar: admin });
  assert.equal(acc.json?.ok, true, '前置：造 impl 账号应成功');
  created.accountIds.push((acc.json.accounts || []).find(x => x.username === U_IMPL).id);
  const acc2 = await api('/api/account-save', { method: 'POST', body: { username: U_OTHER, role: 'impl', name: '越权实施', password: PW, sites: [S_OTHER], projects: [PID] }, jar: admin });
  assert.equal(acc2.json?.ok, true, '前置：造 other 账号应成功');
  created.accountIds.push((acc2.json.accounts || []).find(x => x.username === U_OTHER).id);

  // 造 3 家客户（impl.name 与账号 name 一致，避免 customer-save 写穿把 site 移走）
  //   S_A 上两个产品（PID+PID2，验部署完成度按产品分记 + 聚合 M×P）；S_B/S_OTHER 单产品 PID。
  for (const [name, implName, prods] of [
    [S_A, '清单实施', [{ project: PID, subsystems: [{ name: 'kwsb', version: 'v1' }] }, { project: PID2, subsystems: [{ name: 'kwsb', version: 'v1' }] }]],
    [S_B, '清单实施', [{ project: PID, subsystems: [{ name: 'kwsb', version: 'v1' }] }]],
    [S_OTHER, '越权实施', [{ project: PID, subsystems: [{ name: 'kwsb', version: 'v1' }] }]],
  ]) {
    const r = await api('/api/customer-save', { method: 'POST', body: { name, impl: { name: implName }, products: prods }, jar: admin });
    assert.equal(r.json?.ok, true, '前置：造 ' + name + ' 台账应成功：' + JSON.stringify(r.json));
  }
  await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
  await api('/api/login', { method: 'POST', body: { username: U_OTHER, password: PW }, jar: other });
});

after(async () => {
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID }, jar: admin }); } catch {}
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID2 }, jar: admin }); } catch {}
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  try { if (pool) await pool.query('DELETE FROM projects WHERE id IN (?,?)', [PID, PID2]); } catch {}
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id IN (?,?)', [PID, PID2]); } catch {}
  try { if (pool && created.accountIds.length) await pool.query(`DELETE FROM accounts WHERE id IN (${created.accountIds.map(() => '?').join(',')})`, created.accountIds); } catch {}
  try { if (custExisted && custBackup != null) fs.writeFileSync(CUSTOMERS_FILE, custBackup); else if (fs.existsSync(CUSTOMERS_FILE)) fs.unlinkSync(CUSTOMERS_FILE); } catch {}
  try { if (batchExisted && batchBackup != null) fs.writeFileSync(BATCHES_FILE, batchBackup); else if (fs.existsSync(BATCHES_FILE)) fs.unlinkSync(BATCHES_FILE); } catch {}
  try { if (tplExisted && tplBackup != null) fs.writeFileSync(TPL_FILE, tplBackup); else if (fs.existsSync(TPL_FILE)) fs.unlinkSync(TPL_FILE); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ================= 场景1：标准部署清单模板 + 每院勾选 =================
let TID1 = '', TID2 = '';
test('S1-1 管理员存部署清单模板：title 空 400 / 正常存 + 补 id / 截断', async () => {
  const bad = await api('/api/deploy-template-save', { method: 'POST', body: { tasks: [{ title: '  ' }] }, jar: admin });
  assert.equal(bad.status, 400, 'title 空应 400');
  const r = await api('/api/deploy-template-save', { method: 'POST', body: { tasks: [{ title: '部署数据库', desc: '执行建库脚本' }, { title: '配置网络', desc: '' }] }, jar: admin });
  assert.equal(r.json?.ok, true, '正常存应 ok：' + JSON.stringify(r.json));
  assert.equal(r.json.tasks.length, 2);
  assert.ok(r.json.tasks[0].id && r.json.tasks[1].id, '缺 id 应补');
  TID1 = r.json.tasks[0].id; TID2 = r.json.tasks[1].id;
});
test('S1-2 非管理员不能存模板（403），但可读模板', async () => {
  const save = await api('/api/deploy-template-save', { method: 'POST', body: { tasks: [{ title: 'x' }] }, jar: impl });
  assert.equal(save.status, 403, 'field 存模板应 403（authGate 挡）');
  const get = await api('/api/deploy-template', { method: 'GET', jar: impl });
  assert.equal(get.json?.ok, true, 'field 应可读模板');
  assert.equal(get.json.tasks.length, 2);
});
test('S1-3 impl 勾选自己负责医院【某产品】部署清单项 → 嵌套落态 + 留痕 by/at + 幂等 + 该产品进度', async () => {
  const r = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID, taskId: TID1, done: true }, jar: impl });
  assert.equal(r.json?.ok, true, '勾选应 ok：' + JSON.stringify(r.json));
  assert.equal(r.json.changed, true);
  assert.equal(r.json.product, PID, '回传所勾产品');
  assert.deepEqual([r.json.deployDone, r.json.deployTotal], [1, 2], '甲院 PID 产品进度 1/2（单产品分母=模板项数）');
  const c = readCustomer(S_A);
  // 嵌套形状：deployTasks[PID][TID1]
  assert.equal(c.deployTasks[PID][TID1].done, true, 'deployTasks 按产品嵌套落完成态');
  assert.equal(c.deployTasks[PID][TID1].by, U_IMPL, '留痕 by=username');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(c.deployTasks[PID][TID1].at || ''), '留痕 at=nowStamp');
  // 幂等：重复勾同项不再改
  const r2 = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID, taskId: TID1, done: true }, jar: impl });
  assert.equal(r2.json.changed, false, '同态幂等不 changed');
});
test('S1-3b 按产品各自记进度：产品A勾不影响产品B（同一标准模板，每系统各自完成态）', async () => {
  // S_A 的 PID 已勾 TID1（S1-3）；此刻勾 PID2 的 TID2 → PID2 进度 1/2，PID 仍 1/2、互不影响
  const r = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID2, taskId: TID2, done: true }, jar: impl });
  assert.equal(r.json?.ok, true, 'PID2 勾选应 ok：' + JSON.stringify(r.json));
  assert.deepEqual([r.json.deployDone, r.json.deployTotal], [1, 2], 'PID2 产品进度 1/2');
  const c = readCustomer(S_A);
  assert.equal(c.deployTasks[PID][TID1].done, true, 'PID 完成态不受 PID2 勾选影响');
  assert.ok(!c.deployTasks[PID][TID2], 'PID 下未勾 TID2');
  assert.equal(c.deployTasks[PID2][TID2].done, true, 'PID2 完成态独立落 TID2');
  assert.ok(!c.deployTasks[PID2][TID1], 'PID2 下未勾 TID1（不受 PID 影响）');
  // 复原 PID2（后续 S1-6 聚合按已知态断言）
  await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID2, taskId: TID2, done: false }, jar: impl });
});
test('S1-3c product 不属该院 → 400', async () => {
  // S_B 只上了 PID（没上 PID2）→ 对 PID2 勾选应 400
  const bad = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_B, product: PID2, taskId: TID1, done: true }, jar: impl });
  assert.equal(bad.status, 400, 'product 不在该院 products → 400');
  // 缺 product → 400
  const noProd = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, taskId: TID1, done: true }, jar: impl });
  assert.equal(noProd.status, 400, '缺 product → 400');
});
test('S1-4 取消勾选 → 删该产品下该键；taskId 不存在 → 400', async () => {
  const r = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID, taskId: TID1, done: false }, jar: impl });
  assert.equal(r.json.changed, true);
  assert.deepEqual([r.json.deployDone, r.json.deployTotal], [0, 2], '取消后 PID 产品 0/2');
  const c = readCustomer(S_A);
  assert.ok(!(c.deployTasks[PID] && c.deployTasks[PID][TID1]), '取消后删该产品下该键');
  const bad = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID, taskId: 'tNOPE', done: true }, jar: impl });
  assert.equal(bad.status, 400, 'taskId 不在模板应 400');
});
test('S1-5 越权：impl 勾不属自己 sites 的医院 → 403', async () => {
  const r = await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_OTHER, product: PID, taskId: TID1, done: true }, jar: impl });
  assert.equal(r.status, 403, '越权应 403');
});
test('S1-6 各院/各产品进度独立 + /api/customers 派生聚合 deployDone/deployTotal（M×P）', async () => {
  // 甲院 PID 勾 TID1、TID2（该产品全完成 2/2）+ PID2 勾 TID1（1/2）；乙院 PID 只勾 TID1（1/2）
  await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID, taskId: TID1, done: true }, jar: impl });
  await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID, taskId: TID2, done: true }, jar: impl });
  await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_A, product: PID2, taskId: TID1, done: true }, jar: impl });
  await api('/api/customer-deploy-task', { method: 'POST', body: { site: S_B, product: PID, taskId: TID1, done: true }, jar: impl });
  const r = await api('/api/customers', { method: 'GET', jar: admin });
  const byName = Object.fromEntries((r.json.customers || []).map(c => [c.name, c]));
  // 甲院：M=2，P=2 → 分母 4；分子 = PID(2) + PID2(1) = 3
  assert.deepEqual([byName[S_A].deployDone, byName[S_A].deployTotal], [3, 4], '甲院聚合 3/4（M2×P2=4，PID 2 + PID2 1）');
  // 乙院：M=2，P=1 → 分母 2；分子 = PID(1)
  assert.deepEqual([byName[S_B].deployDone, byName[S_B].deployTotal], [1, 2], '乙院聚合 1/2（M2×P1）');
  // 越权院：未勾任何项 → 0/2
  assert.deepEqual([byName[S_OTHER].deployDone, byName[S_OTHER].deployTotal], [0, 2], '越权院 0/2');
});
test('S1-7 模板删项 → 各院分母随之变（M×P），已删项完成态不计入分子', async () => {
  // 删掉 TID2（模板只剩 TID1，M=1）；甲院 PID 原本勾了 TID1+TID2、PID2 勾了 TID1
  const r = await api('/api/deploy-template-save', { method: 'POST', body: { tasks: [{ id: TID1, title: '部署数据库', desc: '执行建库脚本' }] }, jar: admin });
  assert.equal(r.json?.ok, true);
  const c = await api('/api/customers', { method: 'GET', jar: admin });
  const a = (c.json.customers || []).find(x => x.name === S_A);
  // 甲院：M=1，P=2 → 分母 2；分子 = PID(TID1 仍在→1) + PID2(TID1→1) = 2；TID2 已删不计
  assert.deepEqual([a.deployDone, a.deployTotal], [2, 2], '删 TID2 后甲院聚合 2/2（M1×P2；各产品 TID1 计入，TID2 不计）');
  const b = (c.json.customers || []).find(x => x.name === S_B);
  assert.deepEqual([b.deployDone, b.deployTotal], [1, 1], '删 TID2 后乙院 1/1（M1×P1）');
});

// ================= 场景2：更新包实施任务清单 + 全局勾选 =================
let BID = '', BT1 = '', BT2 = '';
test('S2-1 建批 + batch-update 定义 implTasks（补 id / done=false）', async () => {
  // batch-arrange 只归入「已立项且未归批」工单——先造一条工单并流转到已立项，才能建批。
  const sub = await api('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'bug', title: 'CK冒烟工单-' + TAG, subsystem: 'kwsb', site: S_A, version: 'v1', desc: '清单冒烟用工单' }, jar: admin });
  assert.equal(sub.json?.ok !== false, true, '造工单应成功：' + JSON.stringify(sub.json));
  const tid = sub.json.id || (sub.json.item && sub.json.item.id);
  assert.ok(tid, '拿到工单 id');
  // 流转 待处理 → 已立项（合法路径）
  const tr = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: tid, to: '已立项' }, jar: admin });
  assert.equal(tr.json?.ok !== false, true, '流转已立项应成功：' + JSON.stringify(tr.json));
  const arr = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: admin });
  assert.equal(arr.json?.ok, true, '建批应 ok：' + JSON.stringify(arr.json));
  BID = arr.json.item.id;
  const up = await api('/api/batch-update', { method: 'POST', body: { id: BID, implTasks: [{ title: '停应用服务', desc: '优雅停机' }, { title: '灰度放量' }] }, jar: admin });
  assert.equal(up.json?.ok, true, '定义清单应 ok：' + JSON.stringify(up.json));
  const tasks = up.json.item.implTasks;
  assert.equal(tasks.length, 2);
  assert.ok(tasks[0].id && tasks[1].id, '补 id');
  assert.equal(tasks[0].done, false, '新项 done=false');
  BT1 = tasks[0].id; BT2 = tasks[1].id;
  assert.deepEqual([up.json.item.implDone, up.json.item.implTotal], [0, 2], '进度 0/2');
});
test('S2-2 impl 全局勾选批次清单项 → doneBy/doneAt 留痕 + 幂等', async () => {
  const r = await api('/api/batch-task', { method: 'POST', body: { batchId: BID, taskId: BT1, done: true }, jar: impl });
  assert.equal(r.json?.ok, true, '勾选应 ok：' + JSON.stringify(r.json));
  assert.equal(r.json.changed, true);
  const bt = readBatch(BID);
  const it = bt.implTasks.find(x => x.id === BT1);
  assert.equal(it.done, true);
  assert.equal(it.doneBy, '清单实施', 'doneBy=账号显示名');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(it.doneAt || ''), 'doneAt=nowStamp');
  assert.deepEqual([r.json.item.implDone, r.json.item.implTotal], [1, 2], '进度 1/2');
  // 幂等
  const r2 = await api('/api/batch-task', { method: 'POST', body: { batchId: BID, taskId: BT1, done: true }, jar: impl });
  assert.equal(r2.json.changed, false, '同态幂等');
});
test('S2-3 batch-update 重定义清单：按 id 合并保留已勾完成态，删项即删，新项 done=false', async () => {
  // 改 BT1 标题（保留完成态）、删 BT2、加一条新项
  const up = await api('/api/batch-update', { method: 'POST', body: { id: BID, implTasks: [{ id: BT1, title: '停应用服务（优雅）', desc: '' }, { title: '回归验证' }] }, jar: admin });
  assert.equal(up.json?.ok, true);
  const tasks = up.json.item.implTasks;
  assert.equal(tasks.length, 2);
  const t1 = tasks.find(x => x.id === BT1);
  assert.equal(t1.title, '停应用服务（优雅）', '改标题');
  assert.equal(t1.done, true, '保留完成态');
  assert.equal(t1.doneBy, '清单实施', '保留 doneBy');
  assert.ok(!tasks.find(x => x.id === BT2), 'BT2 已删');
  const nu = tasks.find(x => x.id !== BT1);
  assert.equal(nu.done, false, '新项 done=false');
});
test('S2-4 batch-task 取消 → 清 doneBy/doneAt；不存在项 → 400', async () => {
  const r = await api('/api/batch-task', { method: 'POST', body: { batchId: BID, taskId: BT1, done: false }, jar: impl });
  assert.equal(r.json.changed, true);
  const it = readBatch(BID).implTasks.find(x => x.id === BT1);
  assert.equal(it.done, false); assert.equal(it.doneBy, ''); assert.equal(it.doneAt, '');
  const bad = await api('/api/batch-task', { method: 'POST', body: { batchId: BID, taskId: 'nope', done: true }, jar: impl });
  assert.equal(bad.status, 400, '不存在项应 400');
});
test('S2-5 field 批次视图 /api/field/batches 手拼 group 带 implTasks + 进度（多出口透传·防经验库坑）', async () => {
  // 该批覆盖工单在 S_A（impl 负责）→ field/batches 应返回它，且手拼 group 必须带 implTasks + implDone/implTotal
  const r = await api('/api/field/batches', { method: 'GET', jar: impl });
  const g = (r.json.groups || []).find(x => x.batchId === BID);
  assert.ok(g, 'impl 应在 field/batches 看到该批：' + JSON.stringify((r.json.groups || []).map(x => x.batchId)));
  assert.ok(Array.isArray(g.implTasks), 'field/batches group 带 implTasks（手拼出口透传，别只补 batchOut）');
  assert.ok('implDone' in g && 'implTotal' in g, 'field/batches group 带进度');
  assert.equal(g.implTotal, 2, '清单 2 项');
  // batch-detail（batchOut 出口）也带
  const d = await api('/api/batch-detail?id=' + encodeURIComponent(BID), { jar: admin });
  assert.ok(Array.isArray(d.json.item.implTasks) && 'implDone' in d.json.item, 'batch-detail item 带 implTasks + 进度');
});
