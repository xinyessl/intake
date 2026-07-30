// AM-01 · 账号管理 —— 接口 + 连真库冒烟测试（零依赖，node --test）
//
//   事实源对齐（见 docs/lessons.md）：
//     · accounts 真实列 = id,username,role,name,salt,hash,must_change,projects(JSON),sites(JSON),enabled(TINYINT DEFAULT 1),created_at
//     · 负责医院 = sites（不是 hospitals）；状态 = enabled 0/1（不是中文 status）；密码 salt/hash（scrypt 不可逆）
//     · 判管理员用 isAdmin（admin/dev 都算）——真库 admin 账号 role 实为遗留 dev；服务页角色 3 类 admin/pm/impl
//
//   做什么：
//     · 启动真实 server.mjs（连本地 MySQL data/db.json）到隔离端口；
//     · 用 fetch 打真实端点 /api/accounts、/api/account-save、/api/account-delete、/api/account-reset-password、/api/login；
//     · 断言 AC-6/7/8/10/11/13/14/15/16/17/18/19/20/21 + enabled 落地（列/映射/登录拦截）；
//     · 连真库冒烟：mysql2 直连核对 accounts 真实列（含 enabled）、sites/salt/hash 字段映射、造的账号真的落库。
//   为不污染真实数据：所有测试账号用户名带 am01_<ts> 前缀，after 按精确 id 全删 + 直连真库兜底 DELETE。
//   用法：node --test tools/am-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5600 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TS = Date.now().toString(36);
const TAG = 'am01_' + TS;                 // 本次测试账号用户名前缀（隔离 + 便于清理）
const PID = 'am01smoke' + TS;             // 隔离产品 id（供负责产品绑定）
let srv = null, cookie = '', pool = null;
const createdUsernames = [];              // 记录本次造的账号用户名，兜底清理

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
// 无 cookie 的裸请求（测停用账号登录 / 非管理员权限时，不复用 admin 会话）
function raw(p, { method = 'GET', body, cookie: ck } = {}) {
  return fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(ck ? { Cookie: ck } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => { const sc = r.headers.get('set-cookie'); return { status: r.status, cookie: sc ? sc.split(';')[0] : '', json: await r.json().catch(() => null) }; });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const accById = (list, id) => list.find(a => a.id === id);
const accByUser = (list, u) => list.find(a => a.username === u);

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'AM-01 冒烟产品' } });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
});

after(async () => {
  // 按 id 精确删本次造的账号
  const r = await api('/api/accounts');
  const mine = (r.json?.accounts || []).filter(a => createdUsernames.includes(a.username));
  for (const a of mine) { try { await api('/api/account-delete', { method: 'POST', body: { id: a.id } }); } catch {} }
  // 直连真库兜底清理（含被停用/删不掉的边角）
  try { for (const u of createdUsernames) await pool.query('DELETE FROM accounts WHERE username=?', [u]); } catch {}
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID } }); } catch {}
  try { await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ---- 连真库冒烟：核对 accounts 真实列（禁止臆造），字段映射 ----
test('[真库冒烟] accounts 表真实列含 enabled，负责医院列名为 sites（非 hospitals），密码为 salt/hash（无明文 password）', async () => {
  const [cols] = await pool.query('SHOW COLUMNS FROM accounts');
  const fields = cols.map(c => c.Field);
  for (const f of ['id', 'username', 'role', 'name', 'phone', 'salt', 'hash', 'must_change', 'projects', 'sites', 'enabled', 'created_at'])
    assert.ok(fields.includes(f), `accounts 应有列 ${f}`);
  assert.ok(!fields.includes('hospitals'), '真库无 hospitals 列（负责医院是 sites）');
  assert.ok(!fields.includes('password'), '真库无明文 password 列（密码是 salt/hash）');
  const enabledCol = cols.find(c => c.Field === 'enabled');
  assert.match(enabledCol.Type, /tinyint/i, 'enabled 应为 TINYINT');
  // 手机号列：ensureColumn 已给存量表补上（起服务触发 init）；类型 VARCHAR(20)
  const phoneCol = cols.find(c => c.Field === 'phone');
  assert.match(phoneCol.Type, /varchar\(20\)/i, 'phone 应为 VARCHAR(20)（ensureColumn 给存量表补列）');
});

// ---- GET /api/accounts 出参含 enabled + sites ----
test('[AC-1 pubUser] GET /api/accounts 每条含 enabled(0/1) 与 sites 数组，密码 salt/hash 不外泄', async () => {
  const r = await api('/api/accounts');
  assert.ok(Array.isArray(r.json?.accounts), '应返回 accounts 数组');
  const a = r.json.accounts[0];
  assert.ok('enabled' in a && (a.enabled === 0 || a.enabled === 1), 'pubUser 应含 enabled(0/1)');
  assert.ok(Array.isArray(a.sites), 'pubUser 应含 sites 数组（负责医院）');
  assert.ok(!('salt' in a) && !('hash' in a) && !('password' in a), 'pubUser 不应外泄 salt/hash/password');
});

// ---- AC-6/7：新增校验（用户名格式 / 密码必填） ----
test('[AC-6] 新建账号用户名非法格式 → 400', async () => {
  const r = await api('/api/account-save', { method: 'POST', body: { username: 'x', role: 'pm', name: '短', password: 'Abcd1234' } });
  assert.equal(r.status, 400, '1 位用户名应被拒（正则 2~32）');
});
test('[AC-8] 新建账号缺初始密码 → 400', async () => {
  const u = TAG + '_nopw';
  const r = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '无密码' } });
  assert.equal(r.status, 400, '新建无密码应 400');
});

// ---- AC-8/11/20：新建 impl 落库（salt/hash/must_change=1 + sites + projects） ----
test('[AC-8/11/20] 新建实施账号：落 salt/hash + must_change=1，sites=所绑医院，projects=所绑产品', async () => {
  const u = TAG + '_impl';
  createdUsernames.push(u);
  const r = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '实施甲', password: 'Abcd1234', sites: ['测试医院A', '测试医院B'], projects: [PID], enabled: 1 } });
  assert.equal(r.json?.ok, true, '新建实施账号应成功');
  // 连真库核对字段映射（列名严格为 sites / salt / hash / must_change / enabled）
  const [rows] = await pool.query('SELECT role,name,salt,hash,must_change,enabled,sites,projects FROM accounts WHERE username=?', [u]);
  assert.equal(rows.length, 1, '账号应真的落库');
  const row = rows[0];
  assert.equal(row.role, 'impl', 'role 应 impl');
  assert.ok(row.salt && row.hash, 'salt/hash 应写入（scrypt）');
  assert.equal(row.must_change, 1, '新建 must_change=1（强制首登改密）');
  assert.equal(row.enabled, 1, 'enabled 默认 1');
  const sites = typeof row.sites === 'string' ? JSON.parse(row.sites) : row.sites;
  assert.deepEqual(sites, ['测试医院A', '测试医院B'], 'sites 应存所绑医院（负责医院=sites 列）');
  const projs = typeof row.projects === 'string' ? JSON.parse(row.projects) : row.projects;
  assert.deepEqual(projs, [PID], 'projects 应存所绑产品');
});

// ---- AC-11：管理员 sites=["全部"]；pm sites=["—"]（由前端算、后端原样存）----
test('[AC-11] admin 存 sites=["全部"]、pm 存 sites=["—"]', async () => {
  const ua = TAG + '_adm', up = TAG + '_pm';
  createdUsernames.push(ua, up);
  await api('/api/account-save', { method: 'POST', body: { username: ua, role: 'admin', name: '管理甲', password: 'Abcd1234', sites: ['全部'], projects: [] } });
  await api('/api/account-save', { method: 'POST', body: { username: up, role: 'pm', name: '产品甲', password: 'Abcd1234', sites: ['—'], projects: [PID] } });
  const r = await api('/api/accounts');
  assert.deepEqual(accByUser(r.json.accounts, ua).sites, ['全部'], 'admin sites=["全部"]');
  assert.deepEqual(accByUser(r.json.accounts, up).sites, ['—'], 'pm sites=["—"]');
});

// ---- AC-13：编辑留空密码不改原 salt/hash；未带 enabled 保留原值 ----
test('[AC-13] 编辑留空密码不动 salt/hash；未带 enabled 保留原值', async () => {
  const u = TAG + '_edit';
  createdUsernames.push(u);
  await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '原名', password: 'Abcd1234', projects: [PID], sites: ['—'], enabled: 1 } });
  const [before] = await pool.query('SELECT salt,hash FROM accounts WHERE username=?', [u]);
  // 编辑：只改姓名，不传 password、不传 enabled
  const r = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '改后名', projects: [PID], sites: ['—'] } });
  assert.equal(r.json?.ok, true, '编辑应成功');
  const [after] = await pool.query('SELECT name,salt,hash,enabled FROM accounts WHERE username=?', [u]);
  assert.equal(after[0].name, '改后名', '姓名应更新');
  assert.equal(after[0].salt, before[0].salt, '留空密码 → salt 不变');
  assert.equal(after[0].hash, before[0].hash, '留空密码 → hash 不变');
  assert.equal(after[0].enabled, 1, '未带 enabled → 保留原值 1');
});

// ---- AC-14/15：改密专用端点（旧密码失效、新密码可登录、must_change=1）----
test('[AC-14/15] account-reset-password：旧密码 verifyPw 失败、新密码可登录、must_change=1', async () => {
  const u = TAG + '_pw';
  createdUsernames.push(u);
  const s = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '改密对象', password: 'OldPass99', projects: [PID], sites: ['—'] } });
  assert.equal(s.json?.ok, true);
  const acc = accByUser(s.json.accounts, u);
  // 用旧密码先登录一次消费 must_change（新建就是 1），再重置
  const rr = await api('/api/account-reset-password', { method: 'POST', body: { id: acc.id, password: 'NewPass88' } });
  assert.equal(rr.json?.ok, true, '重置应成功');
  const [row] = await pool.query('SELECT must_change FROM accounts WHERE username=?', [u]);
  assert.equal(row[0].must_change, 1, '重置后 must_change=1（强制对方下次改密）');
  // 旧密码登录失败、新密码成功（裸请求，不复用 admin 会话）
  const oldLogin = await raw('/api/login', { method: 'POST', body: { username: u, password: 'OldPass99' } });
  assert.equal(oldLogin.json?.ok, false, '旧密码应登录失败');
  const newLogin = await raw('/api/login', { method: 'POST', body: { username: u, password: 'NewPass88' } });
  assert.equal(newLogin.json?.ok, true, '新密码应登录成功');
});

// ---- AC-16/17：停用落 enabled=0，停用账号正确密码登录被拒；启用恢复登录 ----
test('[AC-16/17] 停用 enabled=0 落库；停用账号正确密码登录被拒；启用后恢复', async () => {
  const u = TAG + '_dis';
  createdUsernames.push(u);
  const s = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '被停用', password: 'Live1234', projects: [PID], sites: ['—'], enabled: 1 } });
  const acc = accByUser(s.json.accounts, u);
  // 启用态先登录成功（回归）
  const ok1 = await raw('/api/login', { method: 'POST', body: { username: u, password: 'Live1234' } });
  assert.equal(ok1.json?.ok, true, '启用账号应能登录');
  // 停用（account-save 带 enabled=0，回传原 role/sites/projects）
  const dis = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '被停用', projects: [PID], sites: ['—'], enabled: 0 } });
  assert.equal(dis.json?.ok, true);
  const [row] = await pool.query('SELECT enabled FROM accounts WHERE username=?', [u]);
  assert.equal(row[0].enabled, 0, '停用应落 enabled=0');
  // 停用后正确密码仍被拒（AC-17）
  const denied = await raw('/api/login', { method: 'POST', body: { username: u, password: 'Live1234' } });
  assert.equal(denied.json?.ok, false, '停用账号应被拒登录');
  assert.match(denied.json?.error || '', /停用/, '拒登提示应含「停用」');
  // 重新启用后恢复登录
  await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '被停用', projects: [PID], sites: ['—'], enabled: 1 } });
  const ok2 = await raw('/api/login', { method: 'POST', body: { username: u, password: 'Live1234' } });
  assert.equal(ok2.json?.ok, true, '重新启用后应恢复登录');
});

// ---- AC-19：不能停用最后一个启用管理员 ----
test('[AC-19] 停用最后一个启用管理员被拒（真库仅 admin 一个 isAdmin 账号）', async () => {
  const r = await api('/api/accounts');
  const admins = (r.json.accounts || []).filter(a => a.role === 'admin' || a.role === 'dev');
  const enabledAdmins = admins.filter(a => (a.enabled == null ? 1 : (a.enabled ? 1 : 0)) === 1);
  if (enabledAdmins.length !== 1) return;   // 环境已有多个启用管理员时跳过（不制造零管理员风险）
  const only = enabledAdmins[0];
  const dis = await api('/api/account-save', { method: 'POST', body: { username: only.username, role: only.role, name: only.name, projects: only.projects || [], sites: only.sites || [], enabled: 0 } });
  assert.equal(dis.status, 400, '停用最后一个启用管理员应 400');
  assert.match(dis.json?.error || '', /管理员/, '错误提示应含「管理员」');
  // 确认真库仍启用（保护生效）
  const [row] = await pool.query('SELECT enabled FROM accounts WHERE username=?', [only.username]);
  assert.equal(row[0].enabled, 1, '保护后管理员仍为启用');
});

// ---- AC-21：删除物理删；删最后一个启用管理员被拒 ----
test('[AC-21] account-delete 物理删账号；删最后一个启用管理员被拒', async () => {
  const u = TAG + '_del';
  const s = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '待删', password: 'Del12345', projects: [PID], sites: ['—'] } });
  const acc = accByUser(s.json.accounts, u);
  const del = await api('/api/account-delete', { method: 'POST', body: { id: acc.id } });
  assert.equal(del.json?.ok, true, '删除应成功');
  const [rows] = await pool.query('SELECT COUNT(*) c FROM accounts WHERE username=?', [u]);
  assert.equal(rows[0].c, 0, '账号应被物理删除');
  // 删最后一个启用管理员被拒
  const r = await api('/api/accounts');
  const enabledAdmins = (r.json.accounts || []).filter(a => (a.role === 'admin' || a.role === 'dev') && (a.enabled == null ? 1 : (a.enabled ? 1 : 0)) === 1);
  if (enabledAdmins.length === 1) {
    const del2 = await api('/api/account-delete', { method: 'POST', body: { id: enabledAdmins[0].id } });
    assert.equal(del2.status, 400, '删最后一个启用管理员应 400');
    assert.match(del2.json?.error || '', /管理员/, '提示应含「管理员」');
  }
});

// ---- AC-18：非管理员调账号写接口 → 403（authGate 白名单 deny-by-default）----
test('[AC-18] 非管理员（pm）调 account-save / account-reset-password → 403', async () => {
  const u = TAG + '_pmact';
  createdUsernames.push(u);
  const s = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'pm', name: '现场PM', password: 'Field123', projects: [PID], sites: ['—'] } });
  assert.equal(s.json?.ok, true);
  // 以该 pm 账号登录（裸会话）
  const login = await raw('/api/login', { method: 'POST', body: { username: u, password: 'Field123' } });
  // 若该账号被强制改密拦截登录会话仍建立（me 返回），用其 cookie 打写接口
  const pmCookie = login.cookie;
  assert.ok(pmCookie, 'pm 登录应拿到会话 cookie');
  const save403 = await raw('/api/account-save', { method: 'POST', cookie: pmCookie, body: { username: TAG + '_hack', role: 'admin', name: 'x', password: 'Abcd1234' } });
  assert.equal(save403.status, 403, 'pm 调 account-save 应 403');
  const rst403 = await raw('/api/account-reset-password', { method: 'POST', cookie: pmCookie, body: { id: 'whatever', password: 'Abcd1234' } });
  assert.equal(rst403.status, 403, 'pm 调 account-reset-password 应 403');
  const del403 = await raw('/api/account-delete', { method: 'POST', cookie: pmCookie, body: { id: 'whatever' } });
  assert.equal(del403.status, 403, 'pm 调 account-delete 应 403');
});

// ---- 手机号 phone：新建落库 + pubUser 出参 + 编辑改 phone + 停用/启用（不带 phone）保留原值 ----
test('[phone] 新建账号带 phone：SELECT phone FROM accounts 落库正确；/api/accounts + pubUser 出参含 phone', async () => {
  const u = TAG + '_phone';
  createdUsernames.push(u);
  const r = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '有手机', phone: '13800138000', password: 'Abcd1234', sites: ['测试医院A'], enabled: 1 } });
  assert.equal(r.json?.ok, true, '新建带 phone 账号应成功');
  // 连真库核对：phone 列真的落库
  const [rows] = await pool.query('SELECT phone FROM accounts WHERE username=?', [u]);
  assert.equal(rows.length, 1, '账号应真的落库');
  assert.equal(rows[0].phone, '13800138000', 'phone 应落 accounts.phone 列');
  // /api/accounts 出参含 phone（pubUser）
  const list = await api('/api/accounts');
  const acc = accByUser(list.json.accounts, u);
  assert.equal(acc.phone, '13800138000', 'pubUser/api accounts 出参应含 phone');
});

test('[phone] 编辑改 phone 生效；phone 超 20 位按列宽截断', async () => {
  const u = TAG + '_phedit';
  createdUsernames.push(u);
  await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '改机', phone: '13800000001', password: 'Abcd1234', sites: ['测试医院A'], enabled: 1 } });
  // 改 phone
  const e = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '改机', phone: '13999999999', sites: ['测试医院A'] } });
  assert.equal(e.json?.ok, true, '编辑改 phone 应成功');
  const [row] = await pool.query('SELECT phone FROM accounts WHERE username=?', [u]);
  assert.equal(row[0].phone, '13999999999', '编辑后 phone 应更新');
  // 超长截断（>20 位）
  const long = '123456789012345678901234567890';   // 30 位
  await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '改机', phone: long, sites: ['测试医院A'] } });
  const [row2] = await pool.query('SELECT phone FROM accounts WHERE username=?', [u]);
  assert.ok(row2[0].phone.length <= 20, 'phone 应按 VARCHAR(20) 截断到 ≤20 位');
  assert.equal(row2[0].phone, long.slice(0, 20), 'phone 截断取前 20 位');
});

test('[phone] 停用/启用（payload 不带 phone）保留原 phone，不被清空', async () => {
  const u = TAG + '_phkeep';
  createdUsernames.push(u);
  const s = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '保号', phone: '13700137000', password: 'Abcd1234', sites: ['测试医院A'], enabled: 1 } });
  const acc = accByUser(s.json.accounts, u);
  // 停用（doToggle 语义：不带 phone）
  const dis = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '保号', projects: [], sites: ['测试医院A'], enabled: 0 } });
  assert.equal(dis.json?.ok, true, '停用应成功');
  const [row] = await pool.query('SELECT phone,enabled FROM accounts WHERE username=?', [u]);
  assert.equal(row[0].enabled, 0, '停用落 enabled=0');
  assert.equal(row[0].phone, '13700137000', '未带 phone 的提交应保留原 phone（不清空）');
});

test('[phone] phone 选填：不填 phone 新建 → 落库为空串、不报错', async () => {
  const u = TAG + '_phempty';
  createdUsernames.push(u);
  const r = await api('/api/account-save', { method: 'POST', body: { username: u, role: 'impl', name: '无号', password: 'Abcd1234', sites: ['测试医院A'], enabled: 1 } });
  assert.equal(r.json?.ok, true, '不填 phone 应能新建（选填）');
  const [row] = await pool.query('SELECT phone FROM accounts WHERE username=?', [u]);
  assert.equal(row[0].phone || '', '', '不填 phone → 落空串（可空）');
});
