// FS-05 维保到期回写 + 待办提醒 —— 连真实数据结构冒烟（客户文件存 data/customers.json，无 MySQL 表）
//   覆盖：
//     (a) POST /api/customer-maintain：回写 maintainEnd 变更 + maintainLog 追加 + 幂等（重复同值不再追加日志）+ 越权 403 + 非法格式 400 + 客户不存在 400。
//     (b) GET /api/notifications 维保项 daysLeft 边界：today(0)命中 / +15 命中 / +16 不命中 / -1 命中(已过期)，无 off-by-one；kind 字段区分。
//   护栏：customers.json 文件存，测前备份、测后还原/整删，绝不污染真文件。账号带 TAG、after 精确删 by id + DB 兜底。
//   用法：node --test --test-concurrency=1 tools/fs-05-maintain.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5700 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'fs05mt-' + TAG;
const S_TODAY = 'MT今天院-' + TAG;     // maintainEnd=今天（daysLeft=0 → 命中）
const S_P15 = 'MT剩15院-' + TAG;       // 今天+15（daysLeft=15 → 命中·边界）
const S_P16 = 'MT剩16院-' + TAG;       // 今天+16（daysLeft=16 → 不命中·边界）
const S_M1 = 'MT过期院-' + TAG;        // 今天-1（daysLeft=-1 → 命中·已过期）
const S_OTHER = 'MT越权院-' + TAG;     // 别的现场（impl 不该见，测越权/隔离）
const U_IMPL = 'fs05mtimpl_' + TAG;
const U_OTHER = 'fs05mtother_' + TAG;
const PW = 'Abcd1234';
const CUSTOMERS_FILE = path.join(ROOT, 'data/customers.json');
let srv = null, pool = null, custBackup = null, custExisted = false;
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

// 本地日期 + N 天 → yyyy-MM-dd（与后端 date-only 口径对齐：用本地年月日构造，再格式化）
function dateStr(offsetDays) {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + offsetDays);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function readCustomer(name) {
  try { const arr = JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')).customers || []; return arr.find(c => (c.name || '').trim() === String(name).trim()) || null; } catch { return null; }
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  try { custBackup = fs.readFileSync(CUSTOMERS_FILE, 'utf8'); custExisted = true; } catch { custExisted = false; }

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在隔离端口起来');

  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' }, jar: admin });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功');

  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS-05 维保冒烟', subsystems: [{ key: 'kwsb', name: 'kwsb', desc: '库房' }] }, jar: admin });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');

  // impl 绑 4 家「可见」医院；other 绑越权院
  const acc = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '维保实施', password: PW, sites: [S_TODAY, S_P15, S_P16, S_M1], projects: [PID] }, jar: admin });
  assert.equal(acc.json?.ok, true, '前置：造 impl 账号应成功：' + JSON.stringify(acc.json));
  created.accountIds.push((acc.json.accounts || []).find(x => x.username === U_IMPL).id);
  const acc2 = await api('/api/account-save', { method: 'POST', body: { username: U_OTHER, role: 'impl', name: '越权实施', password: PW, sites: [S_OTHER], projects: [PID] }, jar: admin });
  assert.equal(acc2.json?.ok, true, '前置：造 other 账号应成功');
  created.accountIds.push((acc2.json.accounts || []).find(x => x.username === U_OTHER).id);

  // 造 5 家客户台账（含各自 maintainEnd）；impl.name 与账号 name 一致，避免 customer-save 写穿把 site 移走
  const rows = [
    [S_TODAY, dateStr(0), '维保实施'],
    [S_P15, dateStr(15), '维保实施'],
    [S_P16, dateStr(16), '维保实施'],
    [S_M1, dateStr(-1), '维保实施'],
    [S_OTHER, dateStr(0), '越权实施'],
  ];
  for (const [name, me, implName] of rows) {
    const r = await api('/api/customer-save', { method: 'POST', body: { name, impl: { name: implName }, maintainEnd: me, products: [{ project: PID, subsystems: [{ name: 'kwsb', version: 'v1' }] }] }, jar: admin });
    assert.equal(r.json?.ok, true, '前置：造 ' + name + ' 台账应成功：' + JSON.stringify(r.json));
  }
  // 重登 impl/other 拿最新 sites
  await api('/api/login', { method: 'POST', body: { username: U_IMPL, password: PW }, jar: impl });
  await api('/api/login', { method: 'POST', body: { username: U_OTHER, password: PW }, jar: other });
});

after(async () => {
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID }, jar: admin }); } catch {}
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool && created.accountIds.length) await pool.query(`DELETE FROM accounts WHERE id IN (${created.accountIds.map(() => '?').join(',')})`, created.accountIds); } catch {}
  try { if (custExisted && custBackup != null) fs.writeFileSync(CUSTOMERS_FILE, custBackup); else if (fs.existsSync(CUSTOMERS_FILE)) fs.unlinkSync(CUSTOMERS_FILE); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ---------- (a) customer-maintain 回写：变更 + 留痕 + 幂等 + 越权 + 校验 ----------
test('A1 impl 回写自己负责医院维保 → 200 + maintainEnd 变更 + maintainLog 追加', async () => {
  const to = dateStr(90);
  const r = await api('/api/customer-maintain', { method: 'POST', body: { site: S_TODAY, maintainEnd: to }, jar: impl });
  assert.equal(r.status, 200, '应 200：' + JSON.stringify(r.json));
  assert.equal(r.json?.ok, true);
  const c = readCustomer(S_TODAY);
  assert.equal(c.maintainEnd, to, 'customers.json maintainEnd 应已变更');
  assert.ok(Array.isArray(c.maintainLog) && c.maintainLog.length >= 1, 'maintainLog 应追加');
  const last = c.maintainLog[c.maintainLog.length - 1];
  assert.equal(last.to, to, '留痕 to=新值');
  assert.equal(last.site, S_TODAY, '留痕 site');
  assert.equal(last.by, U_IMPL, '留痕 by=操作账号 username');
  assert.ok(last.from !== undefined, '留痕含 from（旧值）');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(last.at || ''), '留痕 at=nowStamp 格式');
});

test('A2 幂等：重复提交同值 → 不再追加 maintainLog（返回 ok 但日志长度不变）', async () => {
  const to = dateStr(90);   // 与 A1 相同
  const before = (readCustomer(S_TODAY).maintainLog || []).length;
  const r = await api('/api/customer-maintain', { method: 'POST', body: { site: S_TODAY, maintainEnd: to }, jar: impl });
  assert.equal(r.json?.ok, true, '幂等仍返回 ok');
  const after = (readCustomer(S_TODAY).maintainLog || []).length;
  assert.equal(after, before, '同值幂等：maintainLog 长度不变（不写不留痕）');
});

test('A3 越权：impl 改不属于自己 sites 的医院 → 403', async () => {
  const r = await api('/api/customer-maintain', { method: 'POST', body: { site: S_OTHER, maintainEnd: dateStr(30) }, jar: impl });
  assert.equal(r.status, 403, '越权应 403：' + JSON.stringify(r.json));
});

test('A4 校验：非法日期格式 → 400，客户不存在 → 400', async () => {
  const bad = await api('/api/customer-maintain', { method: 'POST', body: { site: S_TODAY, maintainEnd: '2027/03/31' }, jar: impl });
  assert.equal(bad.status, 400, '格式非法应 400');
  const empty = await api('/api/customer-maintain', { method: 'POST', body: { site: S_TODAY, maintainEnd: '' }, jar: impl });
  assert.equal(empty.status, 400, '空值（本期不支持清空）应 400');
  const nf = await api('/api/customer-maintain', { method: 'POST', body: { site: '不存在的院-' + TAG, maintainEnd: dateStr(10) }, jar: admin });
  assert.equal(nf.status, 400, '客户不存在应 400');
});

test('A5 管理员不受 sites 限制：可改任意医院维保', async () => {
  const to = dateStr(120);
  const r = await api('/api/customer-maintain', { method: 'POST', body: { site: S_OTHER, maintainEnd: to }, jar: admin });
  assert.equal(r.json?.ok, true, '管理员改任意院应成功');
  assert.equal(readCustomer(S_OTHER).maintainEnd, to);
});

// ---------- (b) notifications 维保项 daysLeft 边界 ----------
test('B1 notifications 维保项 daysLeft 边界（无 off-by-one）+ kind 区分', async () => {
  // 先把 A1 改过的 S_TODAY 还原回今天（A1 改成了 +90），确保边界用例干净
  await api('/api/customer-maintain', { method: 'POST', body: { site: S_TODAY, maintainEnd: dateStr(0) }, jar: impl });
  const r = await api('/api/notifications', { method: 'GET', jar: impl });
  assert.equal(r.status, 200);
  const items = (r.json && r.json.items) || [];
  const mts = items.filter(x => x.kind === 'maintain');
  const bySite = Object.fromEntries(mts.map(x => [x.site, x]));

  // today(0) 命中 daysLeft=0
  assert.ok(bySite[S_TODAY], 'today 应命中');
  assert.equal(bySite[S_TODAY].daysLeft, 0, 'today daysLeft=0（无 off-by-one）');
  // +15 命中 daysLeft=15（边界含）
  assert.ok(bySite[S_P15], '+15 应命中（≤15 含边界）');
  assert.equal(bySite[S_P15].daysLeft, 15, '+15 daysLeft=15');
  // +16 不命中
  assert.ok(!bySite[S_P16], '+16 不应命中（>15）');
  // -1 命中 daysLeft=-1（已过期）
  assert.ok(bySite[S_M1], '-1 应命中（已过期）');
  assert.equal(bySite[S_M1].daysLeft, -1, '-1 daysLeft=-1');
  // 越权院不在 impl 的维保提醒里
  assert.ok(!bySite[S_OTHER], '越权院不应出现在 impl 待办');
  // 已过期排在临期前（daysLeft 升序）：过期项 index < 剩15项 index
  const idxM1 = mts.findIndex(x => x.site === S_M1), idxP15 = mts.findIndex(x => x.site === S_P15);
  assert.ok(idxM1 >= 0 && idxP15 >= 0 && idxM1 < idxP15, '已过期(-1)应排在临期(+15)之前');
  // 结构字段
  assert.equal(bySite[S_TODAY].maintainEnd, dateStr(0), '维保项带 maintainEnd');
  assert.ok(typeof r.json.count === 'number' && r.json.count >= mts.length, 'count 含维保项');
});

test('B2 管理员 notifications：全部医院维保可见（含越权院）', async () => {
  const r = await api('/api/notifications', { method: 'GET', jar: admin });
  const mts = ((r.json && r.json.items) || []).filter(x => x.kind === 'maintain');
  const sites = new Set(mts.map(x => x.site));
  // admin 全部医院可见：S_OTHER 此时 maintainEnd=dateStr(120)（A5 改过）→ daysLeft>15 不命中；
  //   但 S_TODAY/S_P15/S_M1 应对 admin 可见
  assert.ok(sites.has(S_TODAY) && sites.has(S_P15) && sites.has(S_M1), 'admin 应见到全部命中医院的维保项');
});

test('B3 工单待办项带 kind:ticket（不破坏原有结构）', async () => {
  const r = await api('/api/notifications', { method: 'GET', jar: admin });
  const items = (r.json && r.json.items) || [];
  // 所有非维保项都应带 kind:'ticket'
  const nonMaintain = items.filter(x => x.kind !== 'maintain');
  for (const it of nonMaintain) assert.equal(it.kind, 'ticket', '工单项应带 kind:ticket');
});
