// FS-05 实施端批次消费（第 4-6 期）· 按批次视图 / 下载更新包 / 一键改版本 / 逐单现场验证 —— 接口 + 连真库冒烟 + 前端静态断言
//   范围：GET /api/field/batches · POST /api/batch-download · POST /api/customer-version · POST /api/intake-verify（复用真库 intake-transition 流转）。
//   护栏：
//     · 批次/客户均文件存（data/batches.json、data/customers.json），与 BP-01/CU-01 同范式——测前备份、测后还原/整删，绝不污染真文件。
//     · 工单↔批次回链 = intake.data.batch（=e.batch，随 data JSON 落库，不加库列）——直连库 SELECT data 断言。
//     · 4 端点在 FIELD_OK（现场 impl 可调）+ 端点内按 user.sites 二次收敛——越权医院/别账号数据不泄露（AC-F/AC-20/21）。
//   隔离：工单/产品落隔离 PID，账号带 TAG；after 精确删 by id + DB 兜底 + batches.json/customers.json 还原。
//   用法：node --test --test-concurrency=1 tools/fs-05.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5900 + Math.floor(Math.random() * 90);        // 随机高位端口（与其他套件不同频段）
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'fs05smoke-' + TAG;                             // 隔离产品
const SITE_A = 'FS05甲医院-' + TAG;                          // impl 负责医院
const SITE_B = 'FS05乙医院-' + TAG;                          // 越权医院（别的现场，impl 不该见）
const U_IMPL = 'fs05impl_' + TAG;                           // 现场 impl 账号（绑 SITE_A）
const U_OTHER = 'fs05other_' + TAG;                         // 另一 impl（绑 SITE_B，测越权隔离）
const PW = 'Abcd1234';
const BATCHES_FILE = path.join(ROOT, 'data/batches.json');
const CUSTOMERS_FILE = path.join(ROOT, 'data/customers.json');
let srv = null, pool = null;
let batchesBackup = null, batchesExisted = false, custBackup = null, custExisted = false;
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

async function newTicket(title, { site = SITE_A, subsystem = 'kwsb', type = 'requirement' } = {}) {
  const r = await api('/api/intake-submit', { method: 'POST', body: { project: PID, type, title, role: '产品经理', bg: 'x', reqDesc: 'y', desc: 'z', steps: 's', site, subsystem, version: 'v1' }, jar: admin });
  assert.equal(r.json?.ok, true, '造工单应成功：' + JSON.stringify(r.json));
  return r.json.id;
}
async function commit(id, batch) {
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项', ...(batch ? { batch } : {}) }, jar: admin });
  assert.equal(r.json?.ok, true, '落实应成功：' + JSON.stringify(r.json));
  return r.json;
}
async function dbData(id) {
  const [rows] = await pool.query('SELECT data FROM intakes WHERE project_id=? AND id=?', [PID, id]);
  if (!rows.length) return null;
  const r = rows[0]; return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}
function readBatchesFile(id) {
  try { const arr = JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8')).batches || []; return id ? arr.find(x => x.id === id) : arr; } catch { return id ? null : []; }
}
function readCustomer(name) {
  try { const arr = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')).customers || []; return arr.find(c => (c.name || '').trim() === String(name).trim()) || null; } catch { return null; }
}
// 建一个批次并发布（可下载）：归入指定 ticketIds（先 commit），返回 batchId。
async function arrangeAndRelease(pkgVersion) {
  const ar = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: admin });
  assert.equal(ar.json?.ok, true, '定档建批应成功：' + JSON.stringify(ar.json));
  const bid = ar.json.item.id;
  const rl = await api('/api/batch-release', { method: 'POST', body: { id: bid, pkgVersion, releaseNote: '本批修复若干问题', artifactUrl: 'https://example.com/pkg-' + pkgVersion + '.zip' }, jar: admin });
  assert.equal(rl.json?.ok, true, '发布更新包应成功：' + JSON.stringify(rl.json));
  return bid;
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  try { batchesBackup = fs.readFileSync(BATCHES_FILE, 'utf8'); batchesExisted = true; } catch { batchesExisted = false; }
  try { custBackup = fs.readFileSync(CUSTOMERS_FILE, 'utf8'); custExisted = true; } catch { custExisted = false; }

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在隔离端口起来');

  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, jar: admin });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');

  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS-05 冒烟产品', subsystems: [
    { key: 'kwsb', name: 'kwsb', desc: '库房设备' }, { key: 'adr', name: 'adr', desc: '药品不良反应' }
  ] }, jar: admin });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');

  // impl 账号绑 SITE_A（负责甲医院）；another 账号绑 SITE_B（负责乙医院，测越权隔离）
  const acc = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '实施甲', password: PW, sites: [SITE_A], projects: [PID] }, jar: admin });
  assert.equal(acc.json?.ok, true, '前置：造 impl 账号应成功：' + JSON.stringify(acc.json));
  created.accountIds.push((acc.json.accounts || []).find(x => x.username === U_IMPL).id);
  const acc2 = await api('/api/account-save', { method: 'POST', body: { username: U_OTHER, role: 'impl', name: '实施乙', password: PW, sites: [SITE_B], projects: [PID] }, jar: admin });
  assert.equal(acc2.json?.ok, true, '前置：造 other 账号应成功');
  created.accountIds.push((acc2.json.accounts || []).find(x => x.username === U_OTHER).id);
  await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
  await api('/api/login', { method: 'POST', body: { username: U_OTHER, password: PW }, jar: other });

  // 造甲医院客户台账（新形状 products[].subsystems[].version）+ 乙医院（越权隔离用）
  //   impl:{name} 与 impl 账号 name 一致，避免 customer-save 双向写穿把 SITE_A 从 impl 账号移走。
  const rc = await api('/api/customer-save', { method: 'POST', body: { name: SITE_A, impl: { name: '实施甲' }, products: [
    { project: PID, subsystems: [{ name: 'kwsb', version: 'v2.0' }, { name: 'adr', version: 'v1.5' }] }
  ] }, jar: admin });
  assert.equal(rc.json?.ok, true, '前置：造甲医院台账应成功：' + JSON.stringify(rc.json));
  const rc2 = await api('/api/customer-save', { method: 'POST', body: { name: SITE_B, impl: { name: '实施乙' }, products: [
    { project: PID, subsystems: [{ name: 'kwsb', version: 'v2.0' }] }
  ] }, jar: admin });
  assert.equal(rc2.json?.ok, true, '前置：造乙医院台账应成功');
  // 再次登录 impl/other，确保拿到最新 sites（customer-save 后 sites 未被移走，重登拿最新会话）
  await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
  await api('/api/login', { method: 'POST', body: { username: U_OTHER, password: PW }, jar: other });
});

after(async () => {
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID }, jar: admin }); } catch {}
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]); } catch {}
  try { if (pool && created.accountIds.length) await pool.query(`DELETE FROM accounts WHERE id IN (${created.accountIds.map(() => '?').join(',')})`, created.accountIds); } catch {}
  try { if (batchesExisted && batchesBackup != null) fs.writeFileSync(BATCHES_FILE, batchesBackup); else if (fs.existsSync(BATCHES_FILE)) fs.unlinkSync(BATCHES_FILE); } catch {}
  try { if (custExisted && custBackup != null) fs.writeFileSync(CUSTOMERS_FILE, custBackup); else if (fs.existsSync(CUSTOMERS_FILE)) fs.unlinkSync(CUSTOMERS_FILE); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ================= AC-4/AC-F · GET /api/field/batches 按批次视图 + 越权隔离 =================
let BATCH_1 = null;   // 供后续下载/验证复用（含 甲·kwsb + 甲·adr + 乙·kwsb）
test('[AC-4/AC-F] field/batches 只回该账号相关批次 + 只含甲医院单（乙医院/别账号单不泄露）', async () => {
  // 3 单：甲·kwsb、甲·adr、乙·kwsb（乙的对 impl 越权）
  const t1 = await newTicket('甲kwsb-A', { site: SITE_A, subsystem: 'kwsb' }); await commit(t1);
  const t2 = await newTicket('甲adr-A', { site: SITE_A, subsystem: 'adr', type: 'bug' }); await commit(t2);
  const t3 = await newTicket('乙kwsb-越权', { site: SITE_B, subsystem: 'kwsb' }); await commit(t3);
  BATCH_1 = await arrangeAndRelease('v2.1');

  // impl（绑甲）视角：只回该批 + 只含甲医院两单，绝不含乙医院单
  const r = await api('/api/field/batches', { jar: impl });
  assert.equal(r.status, 200);
  const groups = r.json?.groups || [];
  const g = groups.find(x => x.batchId === BATCH_1);
  assert.ok(g, 'impl 应能看到相关批次 ' + BATCH_1);
  assert.equal(g.status, '可下载', '批次为可下载态');
  assert.equal(g.pkgVersion, 'v2.1', '带包版本');
  assert.ok(g.artifactUrl, '带 artifactUrl');
  const allTickets = (g.subGroups || []).flatMap(sg => sg.tickets || []);
  const ids = allTickets.map(t => t.id);
  assert.ok(ids.includes(t1) && ids.includes(t2), 'impl 应见甲医院两单');
  assert.ok(!ids.includes(t3), 'AC-F：乙医院单不得泄露给 impl');
  for (const t of allTickets) assert.equal(t.site, SITE_A, 'AC-F：批次视图只含甲医院单');
  // 覆盖我负责医院列表只含甲
  assert.deepEqual(g.hospitals, [SITE_A], 'hospitals 只含甲医院');
  // 子系统中文分组
  const subMap = Object.fromEntries((g.subGroups || []).map(sg => [sg.subsystem, sg]));
  assert.equal(subMap.kwsb?.subsystemLabel, '库房设备', 'kwsb 显中文 desc');
  assert.equal(subMap.adr?.subsystemLabel, '药品不良反应', 'adr 显中文 desc');

  // other（绑乙）视角：只见乙医院单，见不到甲医院单
  const ro = await api('/api/field/batches', { jar: other });
  const go = (ro.json?.groups || []).find(x => x.batchId === BATCH_1);
  assert.ok(go, 'other 也覆盖该批（有乙医院单）');
  const oIds = (go.subGroups || []).flatMap(sg => sg.tickets || []).map(t => t.id);
  assert.ok(oIds.includes(t3), 'other 应见乙医院单');
  assert.ok(!oIds.includes(t1) && !oIds.includes(t2), 'AC-21：other 见不到甲医院单');
  assert.deepEqual(go.hospitals, [SITE_B], 'other 覆盖医院只含乙');
});

// ================= 排期时间 · field/batches 输出带 scheduleDate（实施端按批次视图批次头展示排期）=================
test('[排期] batch-update 设 scheduleDate → field/batches 批次头返回 scheduleDate（实施端可见排期）', async () => {
  // 给 BATCH_1 设排期（admin 端），实施端按批次视图应能读到该字段
  const up = await api('/api/batch-update', { method: 'POST', body: { id: BATCH_1, scheduleDate: '2026-08-15' }, jar: admin });
  assert.equal(up.json?.ok, true, 'batch-update 设排期应成功：' + JSON.stringify(up.json));
  assert.equal(up.json.item.scheduleDate, '2026-08-15', 'batch-update 返回体带 scheduleDate');
  assert.equal(readBatchesFile(BATCH_1).scheduleDate, '2026-08-15', 'batches.json 落 scheduleDate');
  // 实施端（绑甲）按批次视图：该批 group 应带 scheduleDate（根因回归：原 field/batches 输出漏此字段）
  const r = await api('/api/field/batches', { jar: impl });
  assert.equal(r.status, 200);
  const g = (r.json?.groups || []).find(x => x.batchId === BATCH_1);
  assert.ok(g, 'impl 应能看到批次 ' + BATCH_1);
  assert.equal(g.scheduleDate, '2026-08-15', 'field/batches 批次 group 带 scheduleDate（实施端可见排期）');
  // 造一个未排期批次：field/batches 该 group 的 scheduleDate 应为空串（前端渲染「未排期」）
  const t = await newTicket('未排期批次单', { site: SITE_A, subsystem: 'kwsb' }); await commit(t);
  const bid2 = await arrangeAndRelease('v2.9');   // 未设排期
  const r2 = await api('/api/field/batches', { jar: impl });
  const g2 = (r2.json?.groups || []).find(x => x.batchId === bid2);
  assert.ok(g2, 'impl 应能看到未排期批次 ' + bid2);
  assert.equal(g2.scheduleDate, '', '未排期批次 scheduleDate 为空串');
});

// ================= 排期时间 · field/submissions（按类型卡）每条工单挂 batchSchedule =================
test('[排期·按类型] field/submissions 归批工单带 batchSchedule=批次排期；未归批工单为空', async () => {
  // 依赖上一用例：BATCH_1 已设 scheduleDate=2026-08-15，含甲医院 t1(kwsb·requirement)/t2(adr·bug)。
  // impl（绑甲）按类型视图 groupBy=type，选甲医院：归入 BATCH_1 的单应带 batchSchedule='2026-08-15'。
  const r = await api('/api/field/submissions?groupBy=type&hospitalId=' + encodeURIComponent(SITE_A), { jar: impl });
  assert.equal(r.status, 200, 'field/submissions 应 200');
  const items = (r.json?.groups || []).flatMap(g => g.items || []);
  assert.ok(items.length, '甲医院应有工单');
  const batched = items.filter(it => it.batchId);   // 已归批的单
  assert.ok(batched.length >= 1, '至少一条归批工单（BATCH_1 覆盖的甲医院单）');
  for (const it of batched) {
    if (it.batchId === BATCH_1) assert.equal(it.batchSchedule, '2026-08-15', `归入 BATCH_1 的单 ${it.id} batchSchedule=批次排期`);
  }
  // 造一条未归批甲医院单：batchSchedule 应为空串（无批次/无排期不显）
  const tNo = await newTicket('未归批单', { site: SITE_A, subsystem: 'kwsb' });   // 未 commit、未归批
  const r2 = await api('/api/field/submissions?groupBy=type&hospitalId=' + encodeURIComponent(SITE_A), { jar: impl });
  const itNo = (r2.json?.groups || []).flatMap(g => g.items || []).find(x => x.id === tNo);
  assert.ok(itNo, '未归批单应出现在清单');
  assert.equal(itNo.batchId, '', '未归批单 batchId 为空');
  assert.equal(itNo.batchSchedule, '', '未归批单 batchSchedule 为空串（不显计划交付）');
});

// ================= 排期时间 · field/submissions（系统视图 dimension=sys）也挂 batchSchedule =================
test('[排期·系统视图] field/submissions?dimension=sys 归批工单同样带 batchSchedule（sys 分支复用同一 mapItem）', async () => {
  // 系统视图跨全部负责医院聚合，BATCH_1 覆盖的甲医院单（如 kwsb 子系统）应在系统视图卡也带 batchSchedule。
  const r = await api('/api/field/submissions?dimension=sys', { jar: impl });
  assert.equal(r.status, 200, 'field/submissions?dimension=sys 应 200');
  const items = (r.json?.groups || []).flatMap(g => g.items || []);
  assert.ok(items.length, '系统视图应有工单');
  const batched = items.filter(it => it.batchId === BATCH_1);
  assert.ok(batched.length >= 1, '系统视图至少一条归入 BATCH_1 的单');
  for (const it of batched) {
    assert.equal(it.batchSchedule, '2026-08-15', `系统视图归入 BATCH_1 的单 ${it.id} batchSchedule=批次排期`);
  }
});

// ================= AC-5/6/8/22 · POST /api/batch-download 下载 + 幂等 + 覆盖单转待验证 =================
test('[AC-5/6/22] batch-download：downloads+1、重复不叠加（幂等）、甲医院覆盖工单已出包→待验证；返回 bumps 只含我负责医院', async () => {
  const before = readBatchesFile(BATCH_1);
  assert.equal(before.downloads || 0, 0, '下载前 downloads=0');
  const tids = before.ticketIds.slice();   // 含甲两单 + 乙一单

  const r = await api('/api/batch-download', { method: 'POST', body: { batchId: BATCH_1 }, jar: impl });
  assert.equal(r.json?.ok, true, '下载应成功：' + JSON.stringify(r.json));
  assert.equal(r.json.downloads, 1, 'downloads+1');
  assert.equal(r.json.counted, true, '本次计数');
  assert.equal(r.json.pkgVersion, 'v2.1');
  assert.ok(r.json.artifactUrl, '返回 artifactUrl');
  // bumps 只含甲医院（我负责）× kwsb/adr，fromVer=现场当前版本，toVer=包版本
  const bumps = r.json.bumps || [];
  assert.ok(bumps.length >= 2, 'bumps 至少两条（kwsb/adr）');
  for (const bp of bumps) { assert.equal(bp.site, SITE_A, 'AC-8：bumps 只含我负责医院'); assert.equal(bp.toVer, 'v2.1'); }
  const kwsbBump = bumps.find(b => b.subsystem === 'kwsb'); assert.equal(kwsbBump.fromVer, 'v2.0', 'kwsb fromVer=现场当前 v2.0');
  const adrBump = bumps.find(b => b.subsystem === 'adr'); assert.equal(adrBump.fromVer, 'v1.5', 'adr fromVer=v1.5');

  // 甲医院覆盖工单直连库：已出包→待验证；乙医院单不被 impl 触发（越权收敛）
  for (const id of tids) {
    const d = await dbData(id);
    if (d.site === SITE_A) { assert.equal(d.lifecycle, '待验证', `甲医院单 ${id} 应转待验证`); assert.ok((d.history || []).some(h => h.to === '待验证' && h.byRole === 'system'), '有系统下载留痕'); }
    else { assert.equal(d.lifecycle, '已出包', `乙医院单 ${id} 不被 impl 下载触发（仍已出包）`); }
  }

  // 重复下载：downloads 不叠加（幂等）
  const r2 = await api('/api/batch-download', { method: 'POST', body: { batchId: BATCH_1 }, jar: impl });
  assert.equal(r2.json?.ok, true);
  assert.equal(r2.json.downloads, 1, 'AC-6：重复下载不叠加');
  assert.equal(r2.json.counted, false, '第二次不计数');
  assert.equal(readBatchesFile(BATCH_1).downloads, 1, 'batches.json downloads 仍为 1');
});

test('[AC-8/越权] 非「可下载」批次拒；越权账号下载拒', async () => {
  // 开发中批次（新建一单 → arrange，不发布）→ 下载拒
  const t = await newTicket('开发中单', { site: SITE_A, subsystem: 'kwsb' }); await commit(t);
  const ar = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: admin });
  const devBatch = ar.json.item.id;
  const rd = await api('/api/batch-download', { method: 'POST', body: { batchId: devBatch }, jar: impl });
  assert.equal(rd.json?.ok, false, '开发中批次不可下载');
  assert.match(rd.json?.error || '', /尚未发布/, '提示尚未发布更新包');
  // 把它发布，供后续 other 越权测试用（该批只含甲医院单）
  await api('/api/batch-release', { method: 'POST', body: { id: devBatch, pkgVersion: 'v2.2', artifactUrl: 'https://x/y.zip' }, jar: admin });
  // other（绑乙）下载「只含甲医院单」的批次 → 该批不覆盖乙医院 → 403
  const ro = await api('/api/batch-download', { method: 'POST', body: { batchId: devBatch }, jar: other });
  assert.equal(ro.json?.ok, false, 'other 下载不覆盖其医院的批次应拒');
  assert.equal(ro.status, 403, '越权应 403');
});

// ================= AC-9/10/11/12/13 · POST /api/customer-version 一键改版本 =================
test('[AC-10/11] customer-version：回写新形状 products[].subsystems[].version（v2.0→v2.1）+ 同值幂等', async () => {
  const r = await api('/api/customer-version', { method: 'POST', body: { site: SITE_A, project: PID, subsystem: 'kwsb', version: 'v2.1' }, jar: impl });
  assert.equal(r.json?.ok, true, '改版本应成功：' + JSON.stringify(r.json));
  assert.equal(r.json.changed, true, '值有变更');
  assert.equal(r.json.fromVer, 'v2.0'); assert.equal(r.json.toVer, 'v2.1');
  // 直连 customers.json 断言新形状回写 + versionLog 留痕
  const c = readCustomer(SITE_A);
  const pr = c.products.find(p => p.project === PID);
  const ms = pr.subsystems.find(s => s.name === 'kwsb');
  assert.equal(ms.version, 'v2.1', 'customers.json kwsb 版本回写为 v2.1');
  assert.ok((c.versionLog || []).some(l => l.subsystem === 'kwsb' && l.toVer === 'v2.1'), 'versionLog 记一条改版本留痕');
  const logCntBefore = (c.versionLog || []).length;
  // GET /api/customers 回读为 v2.1
  const rd = await api('/api/customers', { jar: impl });
  const cc = (rd.json?.customers || []).find(x => (x.name || '').trim() === SITE_A);
  const cms = cc.products.find(p => p.project === PID).subsystems.find(s => s.name === 'kwsb');
  assert.equal(cms.version, 'v2.1', 'GET /api/customers 回读 kwsb=v2.1');

  // 同值幂等：再调 v2.1 → changed:false、不重复留痕
  const r2 = await api('/api/customer-version', { method: 'POST', body: { site: SITE_A, project: PID, subsystem: 'kwsb', version: 'v2.1' }, jar: impl });
  assert.equal(r2.json?.ok, true);
  assert.equal(r2.json.changed, false, 'AC-11：同值不改');
  const c2 = readCustomer(SITE_A);
  assert.equal((c2.versionLog || []).length, logCntBefore, 'AC-11：同值不重复留痕');
});

test('[AC-10 旧形状] customer-version 回写旧形状 products[].version', async () => {
  // 造一个旧形状客户（产品级 version，无 subsystems）
  const oldSite = 'FS05旧形状-' + TAG;
  const rc = await api('/api/customer-save', { method: 'POST', body: { name: oldSite, products: [{ project: PID, version: 'v1.0' }] }, jar: admin });
  assert.equal(rc.json?.ok, true);
  // impl 账号 sites 现只含 SITE_A → 给 impl 加上 oldSite 以便测（重登拿新 sites）
  const acc = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '实施甲', sites: [SITE_A, oldSite], projects: [PID], enabled: 1 }, jar: admin });
  assert.equal(acc.json?.ok, true);
  await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
  // 旧形状：不带 subsystem，改产品级 version
  const r = await api('/api/customer-version', { method: 'POST', body: { site: oldSite, project: PID, version: 'v1.2' }, jar: impl });
  assert.equal(r.json?.ok, true, '旧形状改版本应成功：' + JSON.stringify(r.json));
  assert.equal(r.json.fromVer, 'v1.0'); assert.equal(r.json.toVer, 'v1.2');
  const c = readCustomer(oldSite);
  const pr = c.products.find(p => p.project === PID);
  assert.equal(pr.version, 'v1.2', '旧形状 products[].version 回写为 v1.2');
  assert.ok(!Array.isArray(pr.subsystems), '旧形状仍无 subsystems（未误升级）');
  // 恢复 impl sites 只含 SITE_A（避免影响后续越权用例语义）
  await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '实施甲', sites: [SITE_A], projects: [PID], enabled: 1 }, jar: admin });
  await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
});

test('[AC-12/13] customer-version 异常：客户不存在/产品不属/空版本 → 400；越权 site → 403', async () => {
  const r1 = await api('/api/customer-version', { method: 'POST', body: { site: 'no-such-hosp-xyz', project: PID, subsystem: 'kwsb', version: 'v9' }, jar: admin });
  assert.equal(r1.status, 400); assert.match(r1.json?.error || '', /客户不存在/);
  const r2 = await api('/api/customer-version', { method: 'POST', body: { site: SITE_A, project: 'no-such-prod', version: 'v9' }, jar: admin });
  assert.equal(r2.status, 400); assert.match(r2.json?.error || '', /产品不属/);
  const r3 = await api('/api/customer-version', { method: 'POST', body: { site: SITE_A, project: PID, subsystem: 'kwsb', version: '  ' }, jar: admin });
  assert.equal(r3.status, 400); assert.match(r3.json?.error || '', /版本号为空/);
  // 越权：impl（绑甲）改乙医院版本 → 403
  const r4 = await api('/api/customer-version', { method: 'POST', body: { site: SITE_B, project: PID, subsystem: 'kwsb', version: 'v9' }, jar: impl });
  assert.equal(r4.status, 403, 'AC-13：越权 site → 403');
  // 乙医院版本未被改动
  assert.equal(readCustomer(SITE_B).products.find(p => p.project === PID).subsystems.find(s => s.name === 'kwsb').version, 'v2.0', '越权未改乙医院数据');
});

// ================= AC-15/16/18/20 · POST /api/intake-verify 逐单验证 =================
test('[AC-15/17] intake-verify pass：待验证→已关闭；全单验证过 → 批次已交付（闭环联动）', async () => {
  // BATCH_1 的甲医院两单已在待验证（AC-5 下载后）；乙医院单仍已出包（impl 未触发）。
  const bt = readBatchesFile(BATCH_1);
  const tids = bt.ticketIds.slice();
  // 逐一：甲两单 impl 验证过（pass）；乙单需 other 也验证过才闭环
  const jiaIds = []; let yiId = null;
  for (const id of tids) { const d = await dbData(id); if (d.site === SITE_A) jiaIds.push(id); else yiId = id; }
  // 先让乙单也进待验证（other 下载）→ other 验证过
  const rod = await api('/api/batch-download', { method: 'POST', body: { batchId: BATCH_1 }, jar: other });
  assert.equal(rod.json?.ok, true, 'other 下载（覆盖乙医院）应成功');
  assert.equal((await dbData(yiId)).lifecycle, '待验证', '乙单转待验证');

  // impl 验证甲第一单 pass → 已关闭；批次尚未全闭 → 不交付
  const rv1 = await api('/api/intake-verify', { method: 'POST', body: { project: PID, id: jiaIds[0], result: 'pass' }, jar: impl });
  assert.equal(rv1.json?.ok, true); assert.equal(rv1.json.lifecycle, '已关闭', 'AC-15：pass→已关闭');
  assert.equal(rv1.json.batchDelivered, false, '尚未全闭·批次未交付');
  assert.equal((await dbData(jiaIds[0])).lifecycle, '已关闭');
  assert.ok(((await dbData(jiaIds[0])).history || []).some(h => h.to === '已关闭' && /现场验证/.test(h.note || '')), 'history 记现场验证留痕');

  // 验证剩余单（甲第二单 impl + 乙单 other）→ 最后一单 pass 后批次已交付
  await api('/api/intake-verify', { method: 'POST', body: { project: PID, id: jiaIds[1], result: 'pass' }, jar: impl });
  const rvLast = await api('/api/intake-verify', { method: 'POST', body: { project: PID, id: yiId, result: 'pass' }, jar: other });
  assert.equal(rvLast.json?.ok, true);
  assert.equal(rvLast.json.batchDelivered, true, 'AC-17：全单验证过 → 批次已交付（闭环）');
  assert.equal(readBatchesFile(BATCH_1).status, '已交付', 'batches.json 批次转已交付');
});

test('[AC-16] intake-verify 非「待验证」态拒（如已关闭再验证）', async () => {
  const bt = readBatchesFile(BATCH_1);
  const closed = bt.ticketIds[0];   // 已在上一用例关闭
  const r = await api('/api/intake-verify', { method: 'POST', body: { project: PID, id: closed, result: 'pass' }, jar: impl });
  assert.equal(r.status, 400); assert.match(r.json?.error || '', /待验证/, 'AC-16：非待验证态拒');
});

test('[AC-18/19] intake-verify fail：待验证→已重开 + note 留痕；批次态不回退', async () => {
  // 新建一单 → commit → 建批 → 发布 → impl 下载（转待验证）→ fail 打回
  const t = await newTicket('fail验证单', { site: SITE_A, subsystem: 'adr', type: 'bug' }); await commit(t);
  const bid = await arrangeAndRelease('v2.3');
  await api('/api/batch-download', { method: 'POST', body: { batchId: bid }, jar: impl });
  assert.equal((await dbData(t)).lifecycle, '待验证', '下载后转待验证');
  const r = await api('/api/intake-verify', { method: 'POST', body: { project: PID, id: t, result: 'fail', note: '现场发现新问题ABC' }, jar: impl });
  assert.equal(r.json?.ok, true); assert.equal(r.json.lifecycle, '已重开', 'AC-18：fail→已重开');
  assert.equal(r.json.batchDelivered, false);
  const d = await dbData(t);
  assert.equal(d.lifecycle, '已重开');
  assert.ok((d.history || []).some(h => h.to === '已重开' && /现场发现新问题ABC/.test(h.note || '')), 'note 反馈进 history 留痕');
  assert.equal(readBatchesFile(bid).status, '可下载', 'AC-19：批次态不回退（仍可下载）');
});

test('[AC-20] intake-verify 越权：impl 验证乙医院单 → 403，不改工单', async () => {
  // 造乙医院单 → commit → 建批发布 → other 下载转待验证
  const t = await newTicket('乙单-越权验证', { site: SITE_B, subsystem: 'kwsb' }); await commit(t);
  const bid = await arrangeAndRelease('v2.4');
  await api('/api/batch-download', { method: 'POST', body: { batchId: bid }, jar: other });
  assert.equal((await dbData(t)).lifecycle, '待验证');
  const r = await api('/api/intake-verify', { method: 'POST', body: { project: PID, id: t, result: 'pass' }, jar: impl });
  assert.equal(r.status, 403, 'AC-20：impl 验证乙医院单越权拒');
  assert.equal((await dbData(t)).lifecycle, '待验证', '越权未改工单');
});

// ================= 鉴权：非登录 401 =================
test('[鉴权] 4 端点未登录 → 401', async () => {
  const g = jar();
  assert.equal((await api('/api/field/batches', { jar: g })).status, 401);
  assert.equal((await api('/api/batch-download', { method: 'POST', body: { batchId: BATCH_1 }, jar: g })).status, 401);
  assert.equal((await api('/api/customer-version', { method: 'POST', body: { site: SITE_A, project: PID, version: 'v9' }, jar: g })).status, 401);
  assert.equal((await api('/api/intake-verify', { method: 'POST', body: { project: PID, id: 'x', result: 'pass' }, jar: g })).status, 401);
});

// ================= 真库结构护栏：未新增表、intakes 列基线未变 =================
test('[真库·结构] 未新增 batches/customers 表；intakes 列仍 20（batch/lifecycle 落 data JSON）', async () => {
  const [b] = await pool.query("SHOW TABLES LIKE 'batches'"); assert.equal(b.length, 0, '无 batches 表（文件存）');
  const [c] = await pool.query("SHOW TABLES LIKE 'customers'"); assert.equal(c.length, 0, '无 customers 表（文件存）');
  const [cols] = await pool.query('SHOW COLUMNS FROM intakes'); assert.equal(cols.length, 20, 'intakes 列仍 20');
});

// ================= 前端静态断言：field.html 按批次视图真实渲染（非降级）+ 下载/改版本/验证 UI =================
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

test('[前端·按批次视图] loadSubmissions groupBy=batch → loadBatchView 调 /api/field/batches（非降级占位）', () => {
  assert.match(FIELD_HTML, /function loadBatchView/, '有 loadBatchView');
  assert.match(FIELD_HTML, /\/api\/field\/batches/, '调 field/batches 真实端点');
  assert.match(FIELD_HTML, /state\.groupBy === 'batch'.*loadBatchView|loadBatchView\(\); return;/, 'batch 分支走 loadBatchView');
  assert.doesNotMatch(FIELD_HTML, /function renderBatchDegraded/, '旧降级占位函数已移除');
  assert.doesNotMatch(FIELD_HTML, /批次分组暂未开放/, '旧降级文案已移除');
});

test('[前端·下载] mkPkgCard「下载更新包」+ doBatchDownload 调 batch-download + 已下载态 .done', () => {
  assert.match(FIELD_HTML, /function mkPkgCard/, '有更新包卡');
  assert.match(FIELD_HTML, /下载更新包/, '有下载按钮文案');
  assert.match(FIELD_HTML, /function doBatchDownload/, '有下载处理函数');
  assert.match(FIELD_HTML, /\/api\/batch-download/, '调 batch-download');
  assert.match(FIELD_HTML, /f-dl-btn/, '有下载按钮样式类');
  assert.match(FIELD_HTML, /已下载/, '下载后转已下载');
});

test('[前端·改版本] 改版本条 + doBumpVersion 调 customer-version', () => {
  assert.match(FIELD_HTML, /function renderBumpRows/, '有改版本条渲染');
  assert.match(FIELD_HTML, /一键改版本/, '有一键改版本按钮');
  assert.match(FIELD_HTML, /function doBumpVersion/, '有改版本处理函数');
  assert.match(FIELD_HTML, /\/api\/customer-version/, '调 customer-version');
  assert.match(FIELD_HTML, /已改版本/, '成功后转已改版本');
});

test('[前端·逐单验证] mkBatchItem 逐单「确认验证过」/「反馈问题」+ doVerify 调 intake-verify', () => {
  assert.match(FIELD_HTML, /function mkBatchItem/, '有批次逐单渲染');
  assert.match(FIELD_HTML, /确认验证过/, '有确认验证过按钮');
  assert.match(FIELD_HTML, /反馈问题/, '有反馈问题按钮');
  assert.match(FIELD_HTML, /function doVerify/, '有验证处理函数');
  assert.match(FIELD_HTML, /\/api\/intake-verify/, '调 intake-verify');
  assert.match(FIELD_HTML, /canVerify/, '按 canVerify 显验证入口');
  assert.match(FIELD_HTML, /f-verify-btn/, '有验证按钮样式');
});

test('[前端·排期] mkBatchGroup 批次头渲染排期时间（g.scheduleDate → 计划交付；空则未排期）', () => {
  assert.match(FIELD_HTML, /function mkBatchGroup/, '有批次分组渲染');
  assert.match(FIELD_HTML, /g\.scheduleDate/, 'mkBatchGroup 消费 g.scheduleDate');
  assert.match(FIELD_HTML, /bsched/, '有排期样式类 .bsched');
  assert.match(FIELD_HTML, /计划交付/, '有排期文案「计划交付」');
  assert.match(FIELD_HTML, /未排期/, '未排期占位文案');
  assert.doesNotMatch(FIELD_HTML, /发包时间/, '不用「发包」类 A6 禁词描述排期');
});

test('[前端·排期·按类型卡] mkItem 消费 it.batchSchedule → 顶行醒目 chip「计划交付 <date>」（无排期不显、非底部灰字）', () => {
  // mkItem（按类型卡）读 it.batchSchedule，有值时在顶行（类型/状态标签之后）追加醒目 chip「计划交付 <date>」。
  const mk = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkItem'), FIELD_HTML.indexOf('function isReopenable'));
  assert.match(mk, /it\.batchSchedule/, 'mkItem 消费 it.batchSchedule');
  assert.match(mk, /计划交付/, 'mkItem 有「计划交付」文案');
  assert.match(mk, /f-sched-chip/, 'mkItem 用醒目 chip .f-sched-chip 渲染排期');
  assert.doesNotMatch(mk, /isched/, 'mkItem 不再用底部灰字 .isched（避免重复、太不起眼）');
  // 有排期才显（条件渲染），无排期不追加
  assert.match(mk, /sched\s*\?/, 'mkItem 条件渲染：有排期才显');
  // chip 位于顶行 .f-item-top（类型/状态标签行）内，而非底部上下文行 .f-item-ctx
  const topStart = mk.indexOf("'<div class=\"f-item-top\">'");
  const ctxStart = mk.indexOf("'<div class=\"f-item-ctx\">'");
  const chipAt = mk.indexOf('f-sched-chip');
  assert.ok(topStart >= 0 && ctxStart > topStart, '能定位顶行与上下文行');
  assert.ok(chipAt > topStart && chipAt < ctxStart, 'f-sched-chip 渲染在顶行（.f-item-top 之内、.f-item-ctx 之前）');
});

test('[前端·排期·系统视图卡] mkSysItem 同样在顶行显醒目 chip「计划交付 <date>」（无排期不显）', () => {
  // mkSysItem（系统视图卡）镜像 mkItem：读 it.batchSchedule，顶行加同款 f-sched-chip。
  const sysBody = (FIELD_HTML.match(/function mkSysItem\(it\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(sysBody, '能截取 mkSysItem 函数体');
  assert.match(sysBody, /it\.batchSchedule/, 'mkSysItem 消费 it.batchSchedule');
  assert.match(sysBody, /计划交付/, 'mkSysItem 有「计划交付」文案');
  assert.match(sysBody, /f-sched-chip/, 'mkSysItem 用醒目 chip .f-sched-chip 渲染排期');
  assert.match(sysBody, /sched\s*\?/, 'mkSysItem 条件渲染：有排期才显');
  const topStart = sysBody.indexOf("'<div class=\"f-item-top\">'");
  const ctxStart = sysBody.indexOf("'<div class=\"f-item-ctx\">'");
  const chipAt = sysBody.indexOf('f-sched-chip');
  assert.ok(topStart >= 0 && ctxStart > topStart, '能定位顶行与上下文行');
  assert.ok(chipAt > topStart && chipAt < ctxStart, 'f-sched-chip 渲染在顶行（.f-item-top 之内、.f-item-ctx 之前）');
});

test('[前端·排期·样式] .f-sched-chip 样式类存在且醒目（强调色字 + 浅底，区别于状态标签）', () => {
  const rule = (FIELD_HTML.match(/\.f-sched-chip\s*\{[^}]*\}/) || [''])[0];
  assert.ok(rule, '有 .f-sched-chip 样式规则');
  assert.match(rule, /--color-accent/, 'chip 用强调色 token（醒目、区别于状态标签）');
});

test('[前端·护栏] 无 A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）+ 无 localStorage + 无零宽字符', () => {
  for (const kw of ['账号管理', '发包', '决策', 'accounts.html', 'inbox.html']) {
    assert.doesNotMatch(FIELD_HTML, new RegExp(kw), '无 A6 禁词：' + kw);
  }
  assert.doesNotMatch(FIELD_HTML, /localStorage/, '无 localStorage');
  assert.doesNotMatch(FIELD_HTML, /[​-‍﻿ ]/, '无零宽/BOM/非断空格');
});
