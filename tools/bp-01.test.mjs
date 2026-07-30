// BP-01 第 1 期 · 批次数据模型 + 运营「定档建批」 + 批次列表/详情 —— 接口 + 连真库冒烟 + 前端静态断言（零依赖 node --test）
//   本期范围（BP-01 分期第 1 步）：data/batches.json 文件存 + POST /api/batch-arrange（定档建批·跨院合并·按子系统）
//     + GET /api/batches（列表·筛选·倒序·ticketCount）+ GET /api/batch-detail（按子系统分组中文 desc + 覆盖医院去重）。
//     导清单/上传包/闭环 = 后续期，不在本文件。
//   护栏：
//     · 批次为文件存（data/batches.json），与 customers.json 同范式，绝不改库、不加 batches 表——测前备份、测后还原/整删，绝不污染真 batches。
//     · 工单↔批次回链 = intake.data.batch（=工单对象顶层 e.batch，随 data JSON 落库，不加库列，复用 tk-01 L1305 范式）——直连库 SELECT data 解析断言。
//     · 三端点均 admin：未进 authGate 的 FIELD_OK/LINK_OK → 非 admin(impl) 调用应 403。
//   隔离：所有工单/产品落隔离 PID，账号带 TAG；after 精确删 by id + DB 兜底 + batches.json 还原。
//   用法：node --test --test-concurrency=1 tools/bp-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5700 + Math.floor(Math.random() * 200);   // 随机高位端口（与其他套件不同频段，避免并发撞）
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'bp01smoke-' + TAG;                          // 隔离产品（所有测试工单落这里，after 整体清）
const U_IMPL = 'bp01impl_' + TAG;                        // 非 admin 账号（测 403）
const PW = 'Abcd1234';
const BATCHES_FILE = path.join(ROOT, 'data/batches.json');
let srv = null, pool = null;
let batchesBackup = null, batchesExisted = false;       // batches.json 备份/存在标记（测后还原）
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
const admin = jar(), impl = jar();

// 造一条隔离工单（需求/BUG，指定 site + subsystem），返回 id
async function newTicket(title, { site = 'BP01甲', subsystem = 'kwsb', type = 'requirement' } = {}) {
  const r = await api('/api/intake-submit', { method: 'POST', body: { project: PID, type, title, role: '产品经理', bg: 'x', reqDesc: 'y', site, subsystem, version: 'v1' }, jar: admin });
  assert.equal(r.json?.ok, true, '造工单应成功：' + JSON.stringify(r.json));
  return r.json.id;
}
// 落实（→已立项）
async function commit(id, batch) {
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项', ...(batch ? { batch } : {}) }, jar: admin });
  assert.equal(r.json?.ok, true, '落实应成功：' + JSON.stringify(r.json));
  return r.json;
}
// 直连库读某工单 data JSON（核 batch 回链字段映射）
async function dbData(id) {
  const [rows] = await pool.query('SELECT data FROM intakes WHERE project_id=? AND id=?', [PID, id]);
  if (!rows.length) return null;
  const r = rows[0]; return typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
}
// 直连读 data/batches.json（核 pkgVersion/status 落文件）
function readBatchesFile(id) {
  try { const arr = JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8')).batches || []; return id ? arr.find(x => x.id === id) : arr; } catch { return id ? null : []; }
}
// 通用工单流转（admin），可强制关闭
async function transition(id, to) {
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to }, jar: admin });
  assert.equal(r.json?.ok, true, `流转 ${id}→${to} 应成功：` + JSON.stringify(r.json));
  return r.json;
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });

  // batches.json 备份（存在则记内容还原、不存在则测后整删——绝不污染真 batches）
  try { batchesBackup = fs.readFileSync(BATCHES_FILE, 'utf8'); batchesExisted = true; } catch { batchesExisted = false; }

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在隔离端口起来');

  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, jar: admin });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');

  // 隔离产品：定义两个子系统（带中文 desc，供 batch-detail 分组显中文）
  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'BP-01 冒烟产品', subsystems: [
    { key: 'kwsb', name: 'kwsb', desc: '库房设备' }, { key: 'adr', name: 'adr', desc: '药品不良反应' }
  ] }, jar: admin });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');

  // 造非 admin(impl) 账号并登录（测 403）
  const acc = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '实施甲', password: PW, sites: ['BP01甲'], projects: [PID] }, jar: admin });
  assert.equal(acc.json?.ok, true, '前置：造 impl 账号应成功：' + JSON.stringify(acc.json));
  const a = (acc.json.accounts || []).find(x => x.username === U_IMPL); assert.ok(a && a.id, 'impl 账号应有 id'); created.accountIds.push(a.id);
  const li = await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
  assert.equal(li.json?.ok, true, '前置：impl 登录应成功');
});

after(async () => {
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID }, jar: admin }); } catch {}
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  // DB 兜底：删本次隔离产品所有工单/产品/kb + 造的账号
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]); } catch {}
  try { if (pool && created.accountIds.length) await pool.query(`DELETE FROM accounts WHERE id IN (${created.accountIds.map(() => '?').join(',')})`, created.accountIds); } catch {}
  // batches.json 还原：原本存在→写回备份；原本不存在→整删（本套件产的批次不落进真 batches）
  try { if (batchesExisted && batchesBackup != null) fs.writeFileSync(BATCHES_FILE, batchesBackup); else if (fs.existsSync(BATCHES_FILE)) fs.unlinkSync(BATCHES_FILE); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ============ AC-1/AC-4 定档建批：跨院合并 · 只收已立项非 consult · 回链 data.batch · 按子系统分组 ============
test('[AC-1/AC-4] batch-arrange 归入全部已立项单（跨医院甲/乙、子系统 kwsb/adr）；待处理/待处理单不收；回链 data.batch；detail 按子系统分组中文', async () => {
  // 3 条已立项：甲·kwsb、乙·kwsb、乙·adr；1 条待处理（不收）
  const t1 = await newTicket('AC1-甲kwsb', { site: 'BP01甲', subsystem: 'kwsb' }); await commit(t1);
  const t2 = await newTicket('AC1-乙kwsb', { site: 'BP01乙', subsystem: 'kwsb' }); await commit(t2);
  const t3 = await newTicket('AC1-乙adr', { site: 'BP01乙', subsystem: 'adr', type: 'bug' }); await commit(t3);
  const tPending = await newTicket('AC1-待处理不收', { site: 'BP01甲', subsystem: 'kwsb' });   // 不落实，保持待处理

  const r = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: admin });
  assert.equal(r.json?.ok, true, '定档建批应成功：' + JSON.stringify(r.json));
  const bt = r.json.item;
  assert.match(bt.id, /^B-\d+$/, '批次编号形如 B-<seq>');
  assert.equal(bt.status, '开发中', '初始态开发中');
  assert.equal(bt.product, PID);
  assert.equal(bt.ticketCount, 3, '应含 3 条已立项单（待处理不收）');
  for (const id of [t1, t2, t3]) assert.ok(bt.ticketIds.includes(id), '批次应含 ' + id);
  assert.ok(!bt.ticketIds.includes(tPending), '待处理单不应被收');

  // 回链：直连库读 data.batch = 批次 id（核 intakes.data JSON 嵌套 batch 字段映射）
  for (const id of [t1, t2, t3]) {
    const d = await dbData(id);
    assert.equal(d.batch, bt.id, `工单 ${id} 的 data.batch 应回链到批次 ${bt.id}`);
  }
  const dp = await dbData(tPending); assert.ok(!dp.batch, '未落实单不应有 batch');

  // detail：按子系统分组（中文 desc）+ 覆盖医院去重
  const det = await api('/api/batch-detail?id=' + bt.id, { jar: admin });
  const groups = det.json?.groups || [];
  const subs = Object.fromEntries(groups.map(g => [g.subsystem, g]));
  assert.ok(subs.kwsb && subs.adr, '应按 kwsb/adr 分组');
  assert.equal(subs.kwsb.subsystemLabel, '库房设备', 'kwsb 分组应显中文 desc');
  assert.equal(subs.adr.subsystemLabel, '药品不良反应', 'adr 分组应显中文 desc');
  assert.equal(subs.kwsb.tickets.length, 2, 'kwsb 应有 2 单');
  assert.equal(subs.adr.tickets.length, 1, 'adr 应有 1 单');
  const hosps = det.json?.hospitals || [];
  assert.equal(hosps.length, 2, '覆盖医院去重后应为 2（甲/乙）');
  assert.ok(hosps.includes('BP01甲') && hosps.includes('BP01乙'));
  // detail 工单条目字段齐全
  const one = subs.adr.tickets[0];
  for (const k of ['id', 'type', 'title', 'site', 'version', 'module']) assert.ok(k in one, 'detail 工单应含字段 ' + k);
  assert.equal(one.type, 'bug', 'adr 那条是 bug');
});

// ============ AC-2 无可归批单 → 不建空批 ============
test('[AC-2] 该产品无「已立项且未归批」工单 → {ok:false}，不建空批次', async () => {
  // 此时该产品的 3 条已立项都已归批（AC-1 后），无新已立项单
  const before = (await api('/api/batches?product=' + PID, { jar: admin })).json.items.length;
  const r = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: admin });
  assert.equal(r.json?.ok, false, '无可归批单应 ok:false');
  assert.match(r.json?.error || '', /没有已落实待分批|无可归批/, '应给出无可归批提示');
  const after = (await api('/api/batches?product=' + PID, { jar: admin })).json.items.length;
  assert.equal(after, before, '不应创建空批次');
});

// ============ AC-3/AC-8 同产品先后多批：二次定档只含新的已立项单，已归批不重复 ============
test('[AC-3/AC-8] 追加一条已立项 T3 后再定档 → 新开第二批只含 T3，已归批单不重复', async () => {
  const t3 = await newTicket('AC3-新已立项', { site: 'BP01丙', subsystem: 'kwsb' }); await commit(t3);
  const r = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: admin });
  assert.equal(r.json?.ok, true, '二次定档应成功（有新已立项单）');
  const bt2 = r.json.item;
  assert.equal(bt2.ticketCount, 1, '第二批只含新的 1 单');
  assert.deepEqual(bt2.ticketIds, [t3], '第二批只含 T3（已归批的不重复）');
  const d = await dbData(t3); assert.equal(d.batch, bt2.id, 'T3 回链到第二批');
  // 列表应有两批
  const list = (await api('/api/batches?product=' + PID, { jar: admin })).json.items;
  assert.equal(list.length, 2, '同产品应有先后两批');
});

// ============ AC-5 列表：筛选 + 倒序 + ticketCount ============
test('[AC-5] batches 列表：product/status 筛选生效、按 createdAt 倒序、挂 ticketCount/productName', async () => {
  const all = (await api('/api/batches?product=' + PID, { jar: admin })).json.items;
  assert.ok(all.length >= 2, '应有 ≥2 批');
  for (const b of all) { assert.ok('ticketCount' in b, '应挂 ticketCount'); assert.equal(b.productName, 'BP-01 冒烟产品', '应挂冗余 productName'); }
  // 倒序（新在前）：相邻 createdAt 降序
  for (let i = 1; i < all.length; i++) assert.ok(String(all[i - 1].createdAt) >= String(all[i].createdAt), '应按 createdAt 倒序');
  // status 筛选：全为开发中
  const dev = (await api('/api/batches?product=' + PID + '&status=开发中', { jar: admin })).json.items;
  assert.equal(dev.length, all.length, '本期批次都是开发中');
  const done = (await api('/api/batches?product=' + PID + '&status=已交付', { jar: admin })).json.items;
  assert.equal(done.length, 0, '无已交付批次');
});

// ============ 第 2 期 · AC-9/10/11 导出开发清单（json + md · 按子系统 · 描述/验收/涉及医院/截图 URL）============
let CHECKLIST_BATCH = null;   // 供上传包/闭环期复用（含 kwsb 2 单 + adr 1 单，来自 AC-1）
let SCHED_BATCH = null;       // 排期时间用例：带排期建的一批（AC-19/20/21）
test('[AC-9/10/11] batch-checklist：format=json 按子系统分组含 描述/验收/涉及医院/截图URL；format=md 返回可下载 markdown（Content-Disposition attachment）', async () => {
  // 用 AC-1 建的第一批（kwsb 2 单 + adr 1 单）
  const list = (await api('/api/batches?product=' + PID, { jar: admin })).json.items;
  // 取工单数=3 的那批（AC-1 建的），且状态为开发中
  const big = list.find(b => b.ticketCount === 3 && b.status === '开发中');
  assert.ok(big, '应能找到 AC-1 建的 3 单开发中批次');
  CHECKLIST_BATCH = big.id;

  // format=json：按子系统分组 + 字段齐全
  const rj = await api('/api/batch-checklist?id=' + big.id + '&format=json', { jar: admin });
  assert.equal(rj.status, 200);
  const j = rj.json;
  assert.equal(j.product, PID, 'json 应带 product');
  assert.equal(j.productName, 'BP-01 冒烟产品', 'json 应带 productName');
  const gm = Object.fromEntries((j.groups || []).map(g => [g.subsystem, g]));
  assert.ok(gm.kwsb && gm.adr, 'json 应按 kwsb/adr 分组');
  assert.equal(gm.kwsb.subsystemLabel, '库房设备', '分组显中文 desc');
  assert.equal(gm.kwsb.items.length, 2, 'kwsb 2 单');
  assert.equal(gm.adr.items.length, 1, 'adr 1 单');
  const it = gm.kwsb.items[0];
  for (const k of ['ticketId', 'type', 'title', 'desc', 'accept', 'ai', 'hospitals', 'siteVersion', 'media']) assert.ok(k in it, '清单条目应含字段 ' + k);
  assert.ok(Array.isArray(it.hospitals), 'hospitals 是数组（涉及医院）');
  assert.ok(Array.isArray(it.media), 'media 是数组（截图 URL）');
  // 造工单时 reqDesc='y' → 描述择 reqDesc（bug 用 desc，本条是需求）
  assert.ok(it.desc.length > 0 || gm.kwsb.items.some(x => x.desc.length > 0), '需求单描述取 reqDesc/bg（非空）');

  // format=md：markdown 下载（Content-Type text/markdown + Content-Disposition attachment）+ 含各工单
  const r = await fetch(BASE + '/api/batch-checklist?id=' + encodeURIComponent(big.id) + '&format=md', { headers: { Cookie: admin.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/markdown/, 'md 应 Content-Type text/markdown');
  assert.match(r.headers.get('content-disposition') || '', /attachment/, 'md 应 Content-Disposition attachment（可下载）');
  const md = await r.text();
  assert.match(md, /^# 开发清单/m, 'md 应有一级标题「开发清单」');
  assert.match(md, /## 库房设备/, 'md 应按子系统中文分节（库房设备）');
  assert.match(md, /## 药品不良反应/, 'md 应有 adr 中文分节');
  assert.match(md, /\*\*描述\*\*/, 'md 每单含「描述」');
  assert.match(md, /\*\*验收标准\*\*/, 'md 每单含「验收标准」');
  // 无截图的单不报错（本批工单无 media，md 无「截图」段但整体正常返回）
  assert.ok(md.length > 50, 'md 内容完整');
});

// ============ 默认 format=md（不带 format 参数即下载 md）============
test('[AC-10] 不带 format 参数默认返回可下载 md', async () => {
  const r = await fetch(BASE + '/api/batch-checklist?id=' + encodeURIComponent(CHECKLIST_BATCH), { headers: { Cookie: admin.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /text\/markdown/, '默认应为 md');
  assert.match(r.headers.get('content-disposition') || '', /attachment/, '默认应 attachment 下载');
});

// ============ 第 3 期 · AC-12 上传包 → 可下载 + 覆盖工单转「已出包」+ fixedVersion ============
test('[AC-12] batch-release：批次转「可下载」+ pkgVersion 落 batches.json（直连文件）+ 覆盖工单直连库 lifecycle=已出包 + resolution.fixedVersion', async () => {
  const before = readBatchesFile(CHECKLIST_BATCH);
  assert.equal(before.status, '开发中', '上传包前应为开发中');
  const tids = before.ticketIds.slice();
  assert.equal(tids.length, 3, '该批 3 单');

  const r = await api('/api/batch-release', { method: 'POST', body: { id: CHECKLIST_BATCH, pkgVersion: '2.7.x', releaseNote: '修复库房设备若干问题', artifactUrl: 'https://example.com/psp-2.7.x.zip' }, jar: admin });
  assert.equal(r.json?.ok, true, '上传包应成功：' + JSON.stringify(r.json));
  assert.equal(r.json.item.status, '可下载', '批次转可下载');
  assert.equal(r.json.pushed, 3, '3 单推进到已出包');

  // 直连 batches.json 断言落存
  const after = readBatchesFile(CHECKLIST_BATCH);
  assert.equal(after.status, '可下载', 'batches.json status=可下载');
  assert.equal(after.pkgVersion, '2.7.x', 'pkgVersion 落文件');
  assert.equal(after.artifactUrl, 'https://example.com/psp-2.7.x.zip', 'artifactUrl 落文件');
  assert.equal(after.releaseNote, '修复库房设备若干问题', 'releaseNote 落文件');
  assert.ok(after.releaseTime, 'releaseTime 已记');
  assert.ok((after.history || []).some(h => h.action === 'release'), 'history 记 release 留痕');

  // 覆盖工单直连库：lifecycle=已出包 + resolution.fixedVersion=2.7.x + history 有「系统·发包」留痕
  for (const id of tids) {
    const d = await dbData(id);
    assert.equal(d.lifecycle, '已出包', `工单 ${id} 应转已出包`);
    assert.equal(d.resolution?.fixedVersion, '2.7.x', `工单 ${id} 应回写 fixedVersion`);
    assert.ok((d.history || []).some(h => h.to === '已出包' && h.byRole === 'system'), `工单 ${id} 应有系统发包留痕`);
  }
});

// ============ AC-14 非「开发中」批次 release → ok:false ============
test('[AC-14] 已「可下载」批次再次 release → {ok:false}，不改数据', async () => {
  const before = readBatchesFile(CHECKLIST_BATCH);
  const r = await api('/api/batch-release', { method: 'POST', body: { id: CHECKLIST_BATCH, pkgVersion: '9.9', artifactUrl: 'https://x/y.zip' }, jar: admin });
  assert.equal(r.json?.ok, false, '非开发中批次 release 应 ok:false');
  assert.match(r.json?.error || '', /仅开发中/, '应提示仅开发中可上传包');
  const after = readBatchesFile(CHECKLIST_BATCH);
  assert.equal(after.pkgVersion, before.pkgVersion, 'pkgVersion 不被覆盖');
});

// ============ AC-15 必填校验：pkgVersion/artifactUrl 空 → 400 ============
test('[AC-15] batch-release 缺 pkgVersion 或 artifactUrl → 400，不改数据', async () => {
  // 用第二批（AC-3 建的，1 单，开发中）
  const list = (await api('/api/batches?product=' + PID, { jar: admin })).json.items;
  const small = list.find(b => b.status === '开发中');
  assert.ok(small, '应有一个开发中批次（AC-3 建的第二批）');
  const r1 = await api('/api/batch-release', { method: 'POST', body: { id: small.id, artifactUrl: 'https://x/y.zip' }, jar: admin });
  assert.equal(r1.status, 400); assert.equal(r1.json?.ok, false);
  const r2 = await api('/api/batch-release', { method: 'POST', body: { id: small.id, pkgVersion: 'v1' }, jar: admin });
  assert.equal(r2.status, 400); assert.equal(r2.json?.ok, false);
  const after = readBatchesFile(small.id);
  assert.equal(after.status, '开发中', '校验失败不改批次态');
});

// ============ 第 3 期 · AC-16/17/18 闭环判定 ============
test('[AC-16/17/18] batch-deliver-check：工单未全闭→ok:false+pending；全部已关闭→ok:true+批次已交付', async () => {
  const before = readBatchesFile(CHECKLIST_BATCH);
  const tids = before.ticketIds.slice();
  assert.equal(before.status, '可下载', '闭环前应为可下载');

  // AC-16：3 单都在「已出包」，无一已关闭 → ok:false + pending=全部
  const r0 = await api('/api/batch-deliver-check', { method: 'POST', body: { id: CHECKLIST_BATCH }, jar: admin });
  assert.equal(r0.json?.ok, false, '工单未全闭应 ok:false');
  assert.equal(r0.json?.delivered, false);
  assert.deepEqual((r0.json?.pending || []).sort(), tids.slice().sort(), 'pending 应含全部未闭单');
  assert.equal(readBatchesFile(CHECKLIST_BATCH).status, '可下载', 'AC-18：批次态不回退，仍可下载');

  // 关闭 2 单（admin 强制 已出包→已关闭）→ 仍 ok:false（1 单未闭）
  await transition(tids[0], '已关闭');
  await transition(tids[1], '已关闭');
  const r1 = await api('/api/batch-deliver-check', { method: 'POST', body: { id: CHECKLIST_BATCH }, jar: admin });
  assert.equal(r1.json?.ok, false, '2/3 已闭仍未全闭 → ok:false');
  assert.deepEqual(r1.json?.pending, [tids[2]], 'pending 只剩第 3 单');
  assert.equal(readBatchesFile(CHECKLIST_BATCH).status, '可下载', '仍可下载');

  // AC-17：关闭第 3 单 → 全闭 → ok:true + 批次已交付
  await transition(tids[2], '已关闭');
  const r2 = await api('/api/batch-deliver-check', { method: 'POST', body: { id: CHECKLIST_BATCH }, jar: admin });
  assert.equal(r2.json?.ok, true, '全闭应 ok:true');
  assert.equal(r2.json?.delivered, true);
  assert.equal(r2.json.item.status, '已交付', '批次转已交付');
  const fin = readBatchesFile(CHECKLIST_BATCH);
  assert.equal(fin.status, '已交付', 'batches.json status=已交付');
  assert.ok(fin.deliveredAt, 'deliveredAt 已记');
  assert.ok((fin.history || []).some(h => h.action === 'deliver'), 'history 记 deliver 留痕');
  // 已交付批次能被 status 筛选查到
  const delivered = (await api('/api/batches?product=' + PID + '&status=已交付', { jar: admin })).json.items;
  assert.ok(delivered.some(b => b.id === CHECKLIST_BATCH), 'status=已交付 能查到该批');
});

// ============ 排期时间 scheduleDate：建批可带 + 列表/详情返回 + batch-update 可改（AC-19/20/21）============
//   放在闭环测试之后：此时 CHECKLIST_BATCH 已「已交付」，用它验「任意状态批次都可改排期」。
test('[AC-19] batch-arrange 带 scheduleDate → 落库；不带 → 空；非法日期 → 空（不报错）', async () => {
  // 造一条新已立项单 → 带合法排期建批
  const t1 = await newTicket('SCHED-合法排期', { site: 'BP01甲', subsystem: 'kwsb' }); await commit(t1);
  const r1 = await api('/api/batch-arrange', { method: 'POST', body: { product: PID, scheduleDate: '2026-08-15' }, jar: admin });
  assert.equal(r1.json?.ok, true, '带排期建批应成功：' + JSON.stringify(r1.json));
  assert.equal(r1.json.item.scheduleDate, '2026-08-15', '返回体带排期');
  SCHED_BATCH = r1.json.item.id;
  assert.equal(readBatchesFile(SCHED_BATCH).scheduleDate, '2026-08-15', 'scheduleDate 落 batches.json');

  // 不带 scheduleDate → 空串
  const t2 = await newTicket('SCHED-不带排期', { site: 'BP01甲', subsystem: 'kwsb' }); await commit(t2);
  const r2 = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: admin });
  assert.equal(r2.json?.ok, true);
  assert.equal(r2.json.item.scheduleDate, '', '不带排期 → 空串');
  assert.equal(readBatchesFile(r2.json.item.id).scheduleDate, '', '空排期落 batches.json 为空');

  // 非法日期 → 存空（不报错）
  const t3 = await newTicket('SCHED-非法排期', { site: 'BP01甲', subsystem: 'kwsb' }); await commit(t3);
  const r3 = await api('/api/batch-arrange', { method: 'POST', body: { product: PID, scheduleDate: '2026/8/15' }, jar: admin });
  assert.equal(r3.json?.ok, true, '非法日期不应报错、正常建批');
  assert.equal(r3.json.item.scheduleDate, '', '非法日期规范化为空');
});

test('[AC-20] batches 列表 + batch-detail 返回体含 scheduleDate', async () => {
  const list = (await api('/api/batches?product=' + PID, { jar: admin })).json.items;
  for (const b of list) assert.ok('scheduleDate' in b, '列表每项应含 scheduleDate 字段');
  const withSched = list.find(b => b.id === SCHED_BATCH);
  assert.ok(withSched, '应能查到带排期的批次');
  assert.equal(withSched.scheduleDate, '2026-08-15', '列表回读排期一致');
  const det = await api('/api/batch-detail?id=' + SCHED_BATCH, { jar: admin });
  assert.ok('scheduleDate' in (det.json?.item || {}), 'detail.item 应含 scheduleDate');
  assert.equal(det.json.item.scheduleDate, '2026-08-15', 'detail 回读排期一致');
});

test('[AC-21] batch-update 改排期：成功 + 回读一致 + 任意状态可改 + 清空 + 非 admin 403 + 非法 id 404', async () => {
  // 改成功（开发中批次）
  const r1 = await api('/api/batch-update', { method: 'POST', body: { id: SCHED_BATCH, scheduleDate: '2026-08-20' }, jar: admin });
  assert.equal(r1.json?.ok, true, '改排期应成功：' + JSON.stringify(r1.json));
  assert.equal(r1.json.item.scheduleDate, '2026-08-20', '返回体为新排期');
  assert.equal(readBatchesFile(SCHED_BATCH).scheduleDate, '2026-08-20', 'batches.json 落新排期');
  assert.ok((readBatchesFile(SCHED_BATCH).history || []).some(h => h.action === 'update'), 'history 记 update 留痕');
  // 回读一致（batch-detail）
  const det = await api('/api/batch-detail?id=' + SCHED_BATCH, { jar: admin });
  assert.equal(det.json.item.scheduleDate, '2026-08-20', 'detail 回读一致');

  // 非法日期 → 规范化为空（清排期）
  const rBad = await api('/api/batch-update', { method: 'POST', body: { id: SCHED_BATCH, scheduleDate: 'xxx' }, jar: admin });
  assert.equal(rBad.json?.ok, true);
  assert.equal(rBad.json.item.scheduleDate, '', '非法日期清空排期（不报错）');

  // 任意状态可改：已交付批次（CHECKLIST_BATCH 前序已交付）也能改排期
  const finBatch = readBatchesFile(CHECKLIST_BATCH);
  assert.equal(finBatch.status, '已交付', 'CHECKLIST_BATCH 应已交付（前序测试）');
  const rDelivered = await api('/api/batch-update', { method: 'POST', body: { id: CHECKLIST_BATCH, scheduleDate: '2026-09-01' }, jar: admin });
  assert.equal(rDelivered.json?.ok, true, '已交付批次也应可改排期');
  assert.equal(rDelivered.json.item.scheduleDate, '2026-09-01', '已交付批次排期改成功');
  assert.equal(readBatchesFile(CHECKLIST_BATCH).status, '已交付', '改排期不改批次状态');

  // 非 admin(impl) → 403（未进 FIELD_OK/LINK_OK 白名单）
  const rForbid = await api('/api/batch-update', { method: 'POST', body: { id: SCHED_BATCH, scheduleDate: '2026-08-25' }, jar: impl });
  assert.equal(rForbid.status, 403, '非 admin 改排期应 403');

  // 非法 id → 404
  const r404 = await api('/api/batch-update', { method: 'POST', body: { id: 'B-no-such', scheduleDate: '2026-08-25' }, jar: admin });
  assert.equal(r404.status, 404, '不存在的批次改排期应 404');
  assert.equal(r404.json?.ok, false);
});

// ============ 非 admin 三期六端点 → 403 ============
test('[鉴权] 非 admin(impl) 调 batch-arrange / batches / batch-detail / batch-checklist / batch-release / batch-deliver-check 均 403（authGate deny-by-default）', async () => {
  const r1 = await api('/api/batch-arrange', { method: 'POST', body: { product: PID }, jar: impl });
  assert.equal(r1.status, 403, 'impl 调 batch-arrange 应 403');
  const r2 = await api('/api/batches', { jar: impl });
  assert.equal(r2.status, 403, 'impl 调 batches 应 403');
  const r3 = await api('/api/batch-detail?id=B-01', { jar: impl });
  assert.equal(r3.status, 403, 'impl 调 batch-detail 应 403');
  const r4 = await api('/api/batch-checklist?id=B-01', { jar: impl });
  assert.equal(r4.status, 403, 'impl 调 batch-checklist 应 403');
  const r5 = await api('/api/batch-release', { method: 'POST', body: { id: 'B-01', pkgVersion: 'v1', artifactUrl: 'https://x/y.zip' }, jar: impl });
  assert.equal(r5.status, 403, 'impl 调 batch-release 应 403');
  const r6 = await api('/api/batch-deliver-check', { method: 'POST', body: { id: 'B-01' }, jar: impl });
  assert.equal(r6.status, 403, 'impl 调 batch-deliver-check 应 403');
  const r7 = await api('/api/batch-update', { method: 'POST', body: { id: 'B-01', scheduleDate: '2026-08-01' }, jar: impl });
  assert.equal(r7.status, 403, 'impl 调 batch-update 应 403');
});

// ============ 产品不存在 → 400 ============
test('[边界] batch-arrange 产品不存在 → 400', async () => {
  const r = await api('/api/batch-arrange', { method: 'POST', body: { product: 'no-such-product-xyz' }, jar: admin });
  assert.equal(r.status, 400);
  assert.equal(r.json?.ok, false);
});

// ============ 连真库·结构护栏：未新增 batches 表（文件存），intakes 列基线未变 ============
test('[真库冒烟·结构] 未新增 batches 表（批次文件存），intakes 列数仍 20、data 为 JSON（batch 落 data）', async () => {
  const [tbls] = await pool.query("SHOW TABLES LIKE 'batches'");
  assert.equal(tbls.length, 0, '绝不新增 MySQL batches 表（BP-01 文件存 data/batches.json）');
  const [cols] = await pool.query('SHOW COLUMNS FROM intakes');
  assert.equal(cols.length, 20, 'intakes 列数应仍为 20（batch 放 data JSON，不加库列）');
  const data = cols.find(c => c.Field === 'data'); assert.match(data.Type, /json/i, 'data 应为 JSON 列（batch 嵌这里）');
});

// ============ 前端静态断言：batches.html 套壳规范 + shell.js NAVS 加了批次项 ============
const BATCHES_HTML = fs.readFileSync(path.join(ROOT, 'public/batches.html'), 'utf8');
const SHELL_JS = fs.readFileSync(path.join(ROOT, 'public/assets/shell.js'), 'utf8');

test('[前端·外壳] batches.html 引 theme.css/ui.js/shell.js + data-shell=admin + data-nav=batches，且不自写 page-content', () => {
  assert.match(BATCHES_HTML, /\/assets\/theme\.css/, '应引 theme.css');
  assert.match(BATCHES_HTML, /src=["']\/assets\/ui\.js["']/, '应引 ui.js（.select 增强 + uiConfirm 等）');
  assert.match(BATCHES_HTML, /src=["']\/assets\/shell\.js["']/, '应引注入式 shell.js');
  assert.match(BATCHES_HTML, /data-shell=["']admin["']/, '应 data-shell=admin 套壳');
  assert.match(BATCHES_HTML, /data-nav=["']batches["']/, '导航高亮 batches');
  // 不自写 page-content（shell.js 会自动包一层；自写会双层嵌套版式发虚，见 lessons）
  assert.equal((BATCHES_HTML.match(/class="page-content/g) || []).length, 0, '页面绝不能自写 .page-content（含 list-layout 变体）');
});

test('[前端·接真实端点] batches.html 调 /api/batch-arrange /api/batches /api/batch-detail，不引 mock-data.js', () => {
  assert.ok(!/mock-data\.js/.test(BATCHES_HTML), '不得引原型 mock-data.js');
  assert.match(BATCHES_HTML, /\/api\/batch-arrange/, '定档建批调真实端点');
  assert.match(BATCHES_HTML, /\/api\/batches/, '列表调真实端点');
  assert.match(BATCHES_HTML, /\/api\/batch-detail/, '详情调真实端点');
  // 时间统一格式 yyyy-MM-dd HH:mm（共享 fmtTime）
  assert.match(BATCHES_HTML, /function fmtTime\s*\(/, '应有共享时间格式化 fmtTime');
});

test('[前端·shell.js NAVS] shell.js 导航新增「批次管理」→ /batches.html（其它导航项保留）', () => {
  assert.match(SHELL_JS, /id:\s*["']batches["']/, 'NAVS 应含 batches 项');
  assert.match(SHELL_JS, /href:\s*["']\/batches\.html["']/, 'batches 项应指向 /batches.html');
  assert.match(SHELL_JS, /label:\s*["']批次管理["']/, 'batches 项标签「批次管理」');
  // 既有导航未被删
  for (const id of ['console', 'inbox', 'customers', 'projects', 'kb', 'model-config', 'accounts']) {
    assert.ok(new RegExp('id:\\s*["\']' + id + '["\']').test(SHELL_JS), '既有导航 ' + id + ' 应保留');
  }
});

// ============ 第 2-3 期前端：导清单按钮 + 预览 + 上传包表单 + 包信息（详情抽屉新 UI）============
test('[前端·第2-3期] batches.html 详情抽屉：导出清单(md 下载)+预览(json)+上传包表单(开发中)+包信息(可下载)，调三新端点', () => {
  // 导出清单：md 下载链接 + 预览按钮
  assert.match(BATCHES_HTML, /\/api\/batch-checklist\?id=/, '导清单调 batch-checklist');
  assert.match(BATCHES_HTML, /format=md/, '导出为 md 下载');
  assert.match(BATCHES_HTML, /format=json/, '预览取 json');
  assert.match(BATCHES_HTML, /导出开发清单/, '有「导出开发清单」按钮');
  // 上传包表单调 batch-release，含三字段输入
  assert.match(BATCHES_HTML, /\/api\/batch-release/, '上传包调 batch-release');
  assert.match(BATCHES_HTML, /relPkgVersion/, '有包版本输入');
  assert.match(BATCHES_HTML, /relArtifactUrl/, '有包地址输入');
  assert.match(BATCHES_HTML, /relNote/, '有更新说明输入');
  assert.match(BATCHES_HTML, /function doRelease/, '有上传包提交函数');
  // 状态分支：开发中显表单，可下载显包信息
  assert.match(BATCHES_HTML, /b\.status===['"]开发中['"]/, '开发中态显上传包表单');
  assert.match(BATCHES_HTML, /包信息/, '非开发中显包信息');
  // 状态徽标含三态
  assert.match(BATCHES_HTML, /['"]可下载['"]/, '状态含可下载');
  assert.match(BATCHES_HTML, /['"]已交付['"]/, '状态含已交付');
});

// ============ 排期时间前端：定档对话可填 + 详情可改（batch-update）+ 列表显示 ============
test('[前端·排期] batches.html：定档对话含排期 date 输入并随 batch-arrange 带 scheduleDate；详情抽屉改排期调 batch-update；列表显示排期', () => {
  // 定档对话：<input type=date id=arSchedule> + arrange body 带 scheduleDate
  assert.match(BATCHES_HTML, /id=["']arSchedule["']/, '定档对话有排期日期输入 arSchedule');
  assert.match(BATCHES_HTML, /type=["']date["']/, '用原生 date 输入（yyyy-MM-dd，不走 ui.js 增强）');
  assert.match(BATCHES_HTML, /batch-arrange[\s\S]{0,200}scheduleDate/, 'batch-arrange 请求体带 scheduleDate');
  // 详情抽屉：改排期内联编辑 + batch-update 端点
  assert.match(BATCHES_HTML, /\/api\/batch-update/, '改排期调 batch-update');
  assert.match(BATCHES_HTML, /function saveSchedule/, '有改排期提交函数 saveSchedule');
  assert.match(BATCHES_HTML, /改排期/, '详情有「改排期」入口');
  assert.match(BATCHES_HTML, /id=["']schInput["']/, '详情有排期编辑输入 schInput');
  // 列表 + 详情显示排期（未设显「未排期」）
  assert.match(BATCHES_HTML, /未排期/, '排期未设时显「未排期」');
  assert.match(BATCHES_HTML, /排期时间（计划交付）/, '详情有排期时间标签');
});
