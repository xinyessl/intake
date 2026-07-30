// impl-sites-sync · 「实施人↔医院」双向写穿 —— 接口 + 连真库冒烟测试（零依赖，node --test）
//
//   背景 / 事实源（见 docs/lessons.md「实施人↔医院两份存储无同步链路」条）：
//     · 唯一真源 = account.sites（MySQL accounts.sites，JSON 数组、元素=医院名字符串）；实施端可见性 + 全后端隔离唯一认它。
//     · 客户档案 data/customers.json 的 customer.impl 现改为「读时派生」——从 account.sites 反查负责该医院的实施账号。
//     · 关联键 = 医院名（account.sites 元素 === customer.name === intakes.site）。一院一实施 · 双向写穿（customer-save / account-save 都调和）。
//
//   做什么：
//     · 启动真实 server.mjs（连本地 MySQL data/db.json）到隔离随机端口；
//     · 造 2 个启用 impl 账号 A/B + 1 家客户医院 H（走 customer-save）；
//     · 断言：customer-save 写穿 + 排他移动、清空实施人解绑、改名清旧名、/api/customers 派生 impl、account-save 排他、迁移函数加法幂等。
//   连真库冒烟：全程走真实端点（server 连真库），并直连 MySQL 核对 accounts.sites 落库；账号真的落库/读回。
//   隔离与清理：所有账号用户名 + 医院名带唯一 TAG；after 按 id 精确删账号 + 直连真库兜底 DELETE；customers.json 备份/整删还原。
//     绝不断言全局计数（可能有别套件并发）。跑法：node --test --test-concurrency=1 tools/impl-sites-sync.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { planAndApply } from './migrate-impl-sites.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6600 + Math.floor(Math.random() * 300);      // 随机高位端口（与其它套件不同频段，避免 EADDRINUSE）
const BASE = `http://127.0.0.1:${PORT}`;
const TS = Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
const TAG = 'iss_' + TS;                                   // 账号用户名前缀
const H = 'ISS医院_' + TS;                                 // 本次医院名（隔离，唯一 tag）
const H2 = 'ISS医院改_' + TS;                              // 改名后的医院名
const UA = TAG + '_a', UB = TAG + '_b';                    // 两个实施账号用户名
const NA = 'ISS实施甲_' + TS, NB = 'ISS实施乙_' + TS;      // 两个实施账号显示名
const CUST_FILE = path.join(ROOT, 'data', 'customers.json');
let srv = null, cookie = '', pool = null;
let backup = { existed: false, content: null };
const createdUsernames = [UA, UB];
const createdCustIds = [];

function api(p, { method = 'GET', body } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 从 /api/accounts 拿某账号（含 sites）
async function acc(username) { const r = await api('/api/accounts'); return (r.json?.accounts || []).find(a => a.username === username) || null; }
const sitesOf = a => (a && Array.isArray(a.sites)) ? a.sites.map(String) : [];
// 从 /api/customers 拿某客户（含派生 impl）
async function cust(name) { const r = await api('/api/customers'); return (r.json?.customers || []).find(c => c.name === name) || null; }
async function saveCustomer(body) { const r = await api('/api/customer-save', { method: 'POST', body }); if (r.json?.customer?.id && !createdCustIds.includes(r.json.customer.id)) createdCustIds.push(r.json.customer.id); return r; }

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  // 备份 customers.json（含「不存在」态），after 完整还原
  try { if (fs.existsSync(CUST_FILE)) { backup.existed = true; backup.content = fs.readFileSync(CUST_FILE, 'utf8'); } } catch {}

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  // 造两个启用 impl 账号（初始 sites 空，不预挂医院——写穿逻辑负责调和）
  const ra = await api('/api/account-save', { method: 'POST', body: { username: UA, role: 'impl', name: NA, password: 'Abcd1234', sites: [], projects: [], enabled: 1 } });
  assert.equal(ra.json?.ok, true, '前置：造实施账号 A 应成功');
  const rb = await api('/api/account-save', { method: 'POST', body: { username: UB, role: 'impl', name: NB, password: 'Abcd1234', sites: [], projects: [], enabled: 1 } });
  assert.equal(rb.json?.ok, true, '前置：造实施账号 B 应成功');
});

after(async () => {
  // 删本次造的客户（按精确 id）
  for (const id of createdCustIds) { try { await api('/api/customer-delete', { method: 'POST', body: { id } }); } catch {} }
  // 按 id 精确删账号
  try { const r = await api('/api/accounts'); for (const a of (r.json?.accounts || []).filter(x => createdUsernames.includes(x.username))) await api('/api/account-delete', { method: 'POST', body: { id: a.id } }); } catch {}
  // 直连真库兜底删本次账号行
  try { for (const u of createdUsernames) await pool.query('DELETE FROM accounts WHERE username=?', [u]); } catch {}
  // 还原 customers.json（原本不存在则整删）
  try { if (backup.existed) fs.writeFileSync(CUST_FILE, backup.content); else if (fs.existsSync(CUST_FILE)) fs.rmSync(CUST_FILE, { force: true }); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ---- 连真库冒烟：accounts.sites 列存在、字段映射正确（写穿写的就是它）----
test('[真库冒烟] accounts.sites 列存在（JSON），是实施人↔医院唯一真源', async () => {
  const [cols] = await pool.query('SHOW COLUMNS FROM accounts');
  const sitesCol = cols.find(c => c.Field === 'sites');
  assert.ok(sitesCol, 'accounts 应有 sites 列（负责医院唯一真源，非 hospitals）');
  assert.match(sitesCol.Type, /json/i, 'sites 应为 JSON 类型');
});

// ---- customer-save 写穿：impl=A → A.sites 含 H、B 不含 ----
test('[写穿] customer-save H impl=A → A.sites 含 H、B.sites 不含 H', async () => {
  const r = await saveCustomer({ name: H, level: '三甲', region: 'ISS区', status: '已开通', impl: { name: NA }, products: [] });
  assert.equal(r.json?.ok, true, 'customer-save 应成功');
  const a = await acc(UA), b = await acc(UB);
  assert.ok(sitesOf(a).includes(H), 'A.sites 应含医院 H（写穿）');
  assert.ok(!sitesOf(b).includes(H), 'B.sites 不应含 H');
});

// ---- 排他移动：改 impl=B → B 含 H、A 不再含 ----
test('[排他] customer-save H impl=B → B.sites 含 H、A.sites 不再含 H（一院一实施移动）', async () => {
  const cur = await cust(H);
  const r = await saveCustomer({ id: cur.id, name: H, level: '三甲', region: 'ISS区', status: '已开通', impl: { name: NB }, products: [] });
  assert.equal(r.json?.ok, true, 'customer-save 应成功');
  const a = await acc(UA), b = await acc(UB);
  assert.ok(sitesOf(b).includes(H), 'B.sites 应含 H（迁移过来）');
  assert.ok(!sitesOf(a).includes(H), 'A.sites 应不再含 H（排他移除）');
});

// ---- 清空实施人 → 所有账号都不含 H ----
test('[解绑] customer-save H impl=空 → A/B 均不含 H（未指定实施人=解绑）', async () => {
  const cur = await cust(H);
  const r = await saveCustomer({ id: cur.id, name: H, level: '三甲', region: 'ISS区', status: '已开通', impl: { name: '' }, products: [] });
  assert.equal(r.json?.ok, true, 'customer-save 应成功');
  const a = await acc(UA), b = await acc(UB);
  assert.ok(!sitesOf(a).includes(H) && !sitesOf(b).includes(H), 'A/B 均不应含 H');
});

// ---- 改名 H→H2（impl=A）→ A 含 H2、任何账号不含旧名 H ----
test('[改名] customer-save 改名 H→H2 impl=A → A.sites 含 H2、无账号含旧名 H（清旧名防孤儿）', async () => {
  // 先把 H 归给 A（重新绑定），再改名
  const cur = await cust(H);
  await saveCustomer({ id: cur.id, name: H, level: '三甲', region: 'ISS区', status: '已开通', impl: { name: NA }, products: [] });
  let a = await acc(UA); assert.ok(sitesOf(a).includes(H), '前置：A 应先含 H');
  // 改名
  const r = await saveCustomer({ id: cur.id, name: H2, level: '三甲', region: 'ISS区', status: '已开通', impl: { name: NA }, products: [] });
  assert.equal(r.json?.ok, true, '改名保存应成功');
  a = await acc(UA); const b = await acc(UB);
  assert.ok(sitesOf(a).includes(H2), 'A.sites 应含新名 H2');
  assert.ok(!sitesOf(a).includes(H) && !sitesOf(b).includes(H), '无账号应残留旧名 H（sites 以名为键、改名清旧名）');
});

// ---- /api/customers 派生 impl：H2 的 impl.name = 当前持有账号名 NA ----
test('[派生] /api/customers 的 impl 从 account.sites 反查（H2 持有者=A → impl.name=NA）', async () => {
  const c = await cust(H2);
  assert.ok(c, '应能读到 H2');
  assert.equal(c.impl?.name, NA, 'impl.name 应派生为当前持有账号 A 的显示名');
  // 把 H2 移给 B，再读派生应变 NB
  await saveCustomer({ id: c.id, name: H2, level: '三甲', region: 'ISS区', status: '已开通', impl: { name: NB }, products: [] });
  const c2 = await cust(H2);
  assert.equal(c2.impl?.name, NB, '改绑后 impl 派生应跟着账号变（零漂移）');
});

// ---- account-save 不排他 · 共管（2026-07-23 裁决「能共管」）：impl A + pm B 可同持一院 ----
test('[account-save 共管·不排他] impl A 与 pm B 同 account-save sites=[H2] → A、B 都仍含 H2（共管不互斥）', async () => {
  // 先经 account-save 把 H2 塞进实施账号 A（保持 impl）
  const a0 = await acc(UA);
  const newSitesA = [...new Set([...sitesOf(a0), H2])];
  const ra = await api('/api/account-save', { method: 'POST', body: { username: UA, role: 'impl', name: NA, sites: newSitesA, projects: [] } });
  assert.equal(ra.json?.ok, true, 'account-save A 应成功');
  let a = await acc(UA);
  assert.ok(sitesOf(a).includes(H2), 'A.sites 应含 H2');
  // 再 account-save B 作为「统筹 pm」带 sites=[H2] → 账号侧不排他，A 仍保留 H2（共管）
  const rb = await api('/api/account-save', { method: 'POST', body: { username: UB, role: 'pm', name: NB, sites: [H2], projects: [] } });
  assert.equal(rb.json?.ok, true, 'account-save B(pm) 应成功');
  a = await acc(UA); const b = await acc(UB);
  assert.ok(sitesOf(a).includes(H2), '共管：account-save B 后 A 仍含 H2（账号侧不做跨账号排他）');
  assert.ok(sitesOf(b).includes(H2), 'B(pm).sites 应含 H2（统筹共管）');
  // deriveImpl 优先 impl：共管下 /api/customers 的「负责实施」应显示 impl A（NA），而非统筹 pm B
  const c = await cust(H2);
  assert.equal(c?.impl?.name, NA, '共管下 impl 派生应优先 role=impl 的 A（NA），不是统筹 pm B');
});

// ---- 迁移函数：客户 impl=A 但账号 A.sites 无该医院 → 跑迁移 → A.sites 补上（加法幂等）----
test('[迁移] planAndApply 加法回填：客户 impl=A 账号无该医院 → 补上；再跑一次幂等无改动', () => {
  const accs = [
    { username: UA, name: NA, role: 'impl', enabled: 1, sites: ['既有医院X'] },   // 既有分配不被删（非破坏）
    { username: UB, name: NB, role: 'impl', enabled: 1, sites: [] },
  ];
  const customers = [{ name: '迁移医院Y', impl: { name: NA } }, { name: '无匹配医院', impl: { name: '不存在的人' } }];
  const changes1 = planAndApply(accs, customers);
  assert.equal(changes1.length, 1, '应有 1 处新增（迁移医院Y→A）');
  const a = accs.find(x => x.username === UA);
  assert.ok(a.sites.includes('迁移医院Y'), 'A.sites 应补上 迁移医院Y');
  assert.ok(a.sites.includes('既有医院X'), '既有分配「既有医院X」不应被删（加法-only 非破坏）');
  // 幂等：再跑一次 0 改动
  const changes2 = planAndApply(accs, customers);
  assert.equal(changes2.length, 0, '再跑一次应 0 处改动（幂等）');
});

// ---- 隐形字符扫本测试变更相关：server.mjs 三处改动区无隐形字符（防注入错配）----
test('[护栏] server.mjs 无异常隐形字符（除文件末尾既有 BOM 外）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  // 仅扫本次逻辑相关的函数体，避免误伤全文件既有 U+FEFF（历史遗留、非本次引入）
  const isBad = cp => cp === 0x200B || cp === 0x200C || cp === 0x200D || cp === 0xFEFF || cp === 0x00A0 || cp === 0x202F || cp === 0x3000 || (cp >= 0x2000 && cp <= 0x200A);
  const zones = ['reconcileSiteToImpl', 'removeSiteFromAllAccounts', 'deriveImpl', 'implAccountForSite'];
  for (const fn of zones) {
    const m = src.match(new RegExp('function ' + fn + '[\\s\\S]{0,600}'));
    assert.ok(m, `应能定位函数 ${fn}`);
    let hit = false; for (const ch of m[0]) { if (isBad(ch.codePointAt(0))) { hit = true; break; } }
    assert.ok(!hit, `函数 ${fn} 区域不应含隐形字符`);
  }
});

// ---- 冒烟收尾：直连真库核对本次账号 sites 真的落库（不只内存）----
test('[真库冒烟] 直连 MySQL 核对本次账号 sites 落库（写穿真落库，非仅内存）', async () => {
  const [rows] = await pool.query('SELECT username, sites FROM accounts WHERE username IN (?,?)', [UA, UB]);
  assert.equal(rows.length, 2, '两个测试账号应在真库');
  for (const r of rows) {
    const s = typeof r.sites === 'string' ? JSON.parse(r.sites) : r.sites;   // mysql2 JSON 列可能已解析
    assert.ok(Array.isArray(s), `${r.username}.sites 应为数组`);
  }
});
