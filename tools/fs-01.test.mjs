// FS-01 · 实施端外壳 · 登录门 · 工作空间隔离 · 维度切换 —— 静态 + 连真库冒烟 + 服务层隔离/越权（零依赖 node --test）
//   事实源：docs/specs/FS-01-实施端外壳与登录隔离.md（NH-1~5 已裁决）+ 真实库 db.mjs(accounts/sessions/intakes) + server.mjs(login/me/logout/authGate/scopedForField)。
//   做什么：
//     A 静态：public/field.html 含登录门/顶栏固定占位「收件 · 实施端」/维度切换(下拉+竖线+平铺tab)/无后台管理入口；引 theme.css；无隐形字符。
//     B 连真库：造 impl 账号 → /api/login 拿 cookie → /api/me 返回该用户(role/sites 正确) → /api/logout 失效；错密码/停用/未登录调受保护接口的边界。
//     C 服务层隔离/越权：造 3 个 impl 账号各绑不同 sites + 跨 site 工单集 → 各自 intake-list 只见自己 sites；越权传参被忽略；别家工单详情 403；甲乙互不可见；pm 受限；admin 不受限（验证 field→impl 归一后 scopedForField 修复生效 AC-20）。
//   数据准备：所有账号/工单/产品测后必删（account-delete 按 id + DB 兜底删 accounts/intakes/projects），不污染真库。
//   用法：node --test tools/fs-01.test.mjs   （连真库需本地 MySQL，凭据取 data/db.json）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'fs01smoke-' + TAG;                       // 隔离产品，所有测试工单落这里
const SITE_A = 'FS01甲医院-' + TAG, SITE_B = 'FS01乙医院-' + TAG, SITE_C = 'FS01丙医院-' + TAG;
const U_A = 'fs01a_' + TAG, U_B = 'fs01b_' + TAG, U_PM = 'fs01pm_' + TAG;   // 现场账号（impl×2 + pm×1）
const PW = 'fs01pass!';

let srv = null, pool = null;
const created = { accountIds: [] };   // 造的账号 id，after 逐个删

// 独立 cookie 罐（每个身份一份，互不串）
function jar() { return { cookie: '' }; }
function api(p, { method = 'GET', body, jar: j } = {}) {
  const hd = { 'Content-Type': 'application/json' };
  if (j && j.cookie) hd.Cookie = j.cookie;
  return fetch(BASE + p, { method, headers: hd, body: body ? JSON.stringify(body) : undefined }).then(async r => {
    const sc = r.headers.get('set-cookie');
    if (j && sc) j.cookie = sc.split(';')[0];
    return { status: r.status, setCookie: sc, json: await r.json().catch(() => null) };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const admin = jar();
async function login(username, password, j) { return api('/api/login', { method: 'POST', body: { username, password }, jar: j }); }

// 造现场账号（impl/pm），记 id 供 after 删；返回 id
async function makeAccount(username, role, sites) {
  const r = await api('/api/account-save', { method: 'POST', body: { username, role, name: username, password: PW, sites }, jar: admin });
  assert.equal(r.json?.ok, true, `造账号 ${username} 应成功：` + JSON.stringify(r.json));
  const acc = (r.json.accounts || []).find(a => a.username === username);
  assert.ok(acc && acc.id, `造账号 ${username} 应返回 id`);
  created.accountIds.push(acc.id);
  return acc;
}

// 造一条工单（管理员身份，指定 site），返回 id
async function newTicket(site, title) {
  const r = await api('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'requirement', title, role: '产品经理', bg: 'x', reqDesc: 'y', site }, jar: admin });
  assert.equal(r.json?.ok, true, '造工单应成功：' + JSON.stringify(r.json));
  return r.json.id;
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在隔离端口起来');

  const lg = await login('admin', 'admin123', admin);
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');

  // 隔离产品 + 跨 site 工单集：甲 2 条、乙 2 条、丙 1 条
  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS-01 冒烟产品', subsystems: [{ key: 'a', name: '子系统甲' }] }, jar: admin });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
  await newTicket(SITE_A, 'FS01甲-1'); await newTicket(SITE_A, 'FS01甲-2');
  await newTicket(SITE_B, 'FS01乙-1'); await newTicket(SITE_B, 'FS01乙-2');
  await newTicket(SITE_C, 'FS01丙-1');

  // 现场账号：甲(impl→只甲)、乙(impl→只乙)、pm(→甲+丙，验证 pm 也受 sites 约束)
  await makeAccount(U_A, 'impl', [SITE_A]);
  await makeAccount(U_B, 'impl', [SITE_B]);
  await makeAccount(U_PM, 'pm', [SITE_A, SITE_C]);
});

after(async () => {
  // 删造的账号（按 id，admin 身份）
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  // 兜底清库：删本次隔离产品的工单/产品/经验库 + 账号行（绝不污染真库）
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]); } catch {}
  try { if (pool) for (const un of [U_A, U_B, U_PM]) await pool.query('DELETE FROM accounts WHERE username=?', [un]); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ============ A. field.html 外壳静态断言 ============
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

test('A1 登录门元素：#fLogin/.f-login + 账号/密码(type=password)/#loginErr + 演示账号 chip + 安全提示（AC-1/2）', () => {
  assert.match(FIELD_HTML, /id="fLogin"/, '含登录门 #fLogin');
  assert.match(FIELD_HTML, /class="f-login"/, '含 .f-login');
  assert.match(FIELD_HTML, /id="loginUser"/, '含账号输入 #loginUser');
  assert.match(FIELD_HTML, /id="loginPwd"[^>]*type="password"/, '密码输入 type=password');
  assert.match(FIELD_HTML, /id="loginErr"/, '含内联错误 #loginErr');
  for (const u of ['zhanggong', 'ligong', 'zhaogong']) assert.match(FIELD_HTML, new RegExp(u), `含演示账号 ${u}`);
  assert.match(FIELD_HTML, /账号之间数据相互独立/, '含安全提示文案');
});

test('A2 顶栏固定占位「收件 · 实施端」（NH-2，不臆造 me.org）', () => {
  assert.match(FIELD_HTML, /收件 · 实施端/, '顶栏/品牌含固定占位「收件 · 实施端」');
  assert.doesNotMatch(FIELD_HTML, /me\.org/, '不读/不臆造 me.org');
});

test('A3 维度切换：#fMode 下拉(#fModeCur/#fModeMenu 含 hosp/sys) → 竖线 .f-topdiv → 平铺 tab #fHtabs（AC-16/19）', () => {
  assert.match(FIELD_HTML, /id="fMode"/, '维度选择器 #fMode');
  assert.match(FIELD_HTML, /id="fModeCur"/, '当前项 #fModeCur');
  assert.match(FIELD_HTML, /id="fModeMenu"/, '弹菜单 #fModeMenu');
  assert.match(FIELD_HTML, /data-m="hosp"/, '含 医院视图项 data-m=hosp');
  assert.match(FIELD_HTML, /data-m="sys"/, '含 系统视图项 data-m=sys');
  assert.match(FIELD_HTML, /class="f-topdiv"/, '含竖分隔线 .f-topdiv');
  assert.match(FIELD_HTML, /id="fHtabs"/, '含实体 tab #fHtabs');
  // 顺序：fMode 在 fHtabs 之前
  assert.ok(FIELD_HTML.indexOf('id="fMode"') < FIELD_HTML.indexOf('id="fHtabs"'), 'fMode 应在 fHtabs 之前');
});

test('A4 医院视图末尾灰色不可点「医院由运营端分配」（AC-18，不自助添加医院/产品）', () => {
  assert.match(FIELD_HTML, /医院由运营端分配/, '含「医院由运营端分配」提示');
  assert.match(FIELD_HTML, /f-htab-note/, '用不可点 .f-htab-note 承载');
});

test('A5 登录/退出/恢复走真实端点，不含前端 mock 登录（AC-3/7/8）', () => {
  assert.match(FIELD_HTML, /\/api\/login/, '登录调 /api/login');
  assert.match(FIELD_HTML, /\/api\/logout/, '退出调 /api/logout');
  assert.match(FIELD_HTML, /\/api\/me/, '恢复态调 /api/me');
  assert.doesNotMatch(FIELD_HTML, /任意密码/, '不含原型「任意密码前端 mock 登录」逻辑');
  // 不往 localStorage 存密码/明文用户（NH-3：凭 Cookie + /api/me 恢复）
  assert.doesNotMatch(FIELD_HTML, /localStorage/, '不使用 localStorage 存登录态/密码');
});

test('A6 无后台管理菜单/入口（AC-15：无 账号管理/发包/决策 入口）', () => {
  // 不注入后台外壳 shell.js（那是运营端）
  assert.doesNotMatch(FIELD_HTML, /assets\/shell\.js/, '不引后台 shell.js');
  for (const kw of ['账号管理', '发包', '决策', 'accounts.html', 'inbox.html']) {
    assert.doesNotMatch(FIELD_HTML, new RegExp(kw), `无后台入口关键词：${kw}`);
  }
});

test('A7 引 theme.css 设计系统（视觉与运营后台统一）', () => {
  assert.match(FIELD_HTML, /\/assets\/theme\.css/, '引 theme.css');
});

test('A8 无隐形/异常字符（BOM/零宽/非断空格）', () => {
  assert.doesNotMatch(FIELD_HTML, /[​-‍﻿ ]/, 'field.html 不含零宽/BOM/非断空格');
});

// ============ B. 连真库冒烟：login / me / logout ============
test('B1 造的 impl 账号：/api/login 正确密码 → {ok:true,me}，Set-Cookie 含 intake_sess，me.role/sites 正确（AC-3）', async () => {
  const j = jar();
  const r = await login(U_A, PW, j);
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true, '正确密码应登录成功');
  assert.ok(r.json.me, '返回 me');
  assert.equal(r.json.me.role, 'impl', 'role=impl（field→impl 归一）');
  assert.ok(Array.isArray(r.json.me.sites), 'me.sites 是数组');
  assert.deepEqual(r.json.me.sites, [SITE_A], 'me.sites 正是绑定的 [SITE_A]');
  assert.match(r.setCookie || '', /intake_sess=/, 'Set-Cookie 含 intake_sess');
  // 带 cookie /api/me → me 非 null（AC-7）
  const me = await api('/api/me', { jar: j });
  assert.ok(me.json?.me, '带 cookie /api/me 返回 me 非 null');
  assert.equal(me.json.me.username, U_A);
  assert.equal(me.json.authEnabled, true, 'authEnabled=true');
});

test('B2 错密码 → {ok:false, 用户名或密码错误}（AC-4）', async () => {
  const j = jar();
  const r = await login(U_A, 'wrong-pw', j);
  assert.equal(r.json?.ok, false);
  assert.equal(r.json.error, '用户名或密码错误');
  assert.ok(!(r.setCookie || '').includes('intake_sess='), '错密码不下发会话 Cookie');
});

test('B3 停用账号密码正确 → {ok:false, 账号已停用…}（AC-6）', async () => {
  const un = 'fs01dis_' + TAG;
  const acc = await makeAccount(un, 'impl', [SITE_A]);
  // 停用
  const dis = await api('/api/account-save', { method: 'POST', body: { username: un, role: 'impl', name: un, sites: [SITE_A], enabled: 0 }, jar: admin });
  assert.equal(dis.json?.ok, true, '停用应成功');
  const r = await login(un, PW, jar());
  assert.equal(r.json?.ok, false);
  assert.equal(r.json.error, '账号已停用，请联系管理员');
});

test('B4 /api/logout 清会话 → 之后无 cookie /api/me → me:null（AC-8/9）', async () => {
  const j = jar();
  await login(U_A, PW, j);
  const out = await api('/api/logout', { jar: j });
  assert.equal(out.json?.ok, true, 'logout ok');
  assert.match(out.setCookie || '', /Max-Age=0/, '清 Cookie（Max-Age=0）');
  // 用退出后（已清）的罐再查：token 已失效
  const me = await api('/api/me', { jar: j });
  assert.equal(me.json?.me, null, '退出后 /api/me 返回 me:null');
});

test('B5 未登录调受保护接口 → 401 need-login（登录门后端硬约束）', async () => {
  const r = await api('/api/intake-list?project=' + PID, { jar: jar() });   // 无 cookie
  assert.equal(r.status, 401, '未登录调 /api/intake-list 应 401');
  assert.equal(r.json?.error, 'need-login');
});

test('B6 /field.html 未登录也可加载（页面自带登录门；数据仍走受 gate 的 API）（AC-1）', async () => {
  const r = await fetch(BASE + '/field.html', { headers: {} });
  assert.equal(r.status, 200, '/field.html 未登录返回 200（外壳页放行、数据 API 仍受保护）');
  const html = await r.text();
  assert.match(html, /id="fLogin"/, '返回的正是含登录门的 field.html');
});

// ============ C. 服务层隔离 / 越权（AC-11~14/20） ============
test('C1 impl(甲) intake-list 只见自己 sites 的工单（AC-11）', async () => {
  const j = jar(); await login(U_A, PW, j);
  const r = await api('/api/intake-list?project=' + PID, { jar: j });
  assert.equal(r.status, 200);
  const items = r.json?.items || [];
  assert.ok(items.length >= 2, '甲应看到甲医院工单');
  assert.ok(items.every(it => it.site === SITE_A), '甲只见 SITE_A 工单：' + JSON.stringify(items.map(i => i.site)));
  assert.ok(!items.some(it => it.site === SITE_B || it.site === SITE_C), '甲看不到乙/丙工单');
});

test('C2 impl(甲) 越权传参(带别家 site/hospitalId/project 参数) 被服务层忽略（AC-12）', async () => {
  const j = jar(); await login(U_A, PW, j);
  // 前端篡改：塞乙医院的 site / hospitalId，及重复 project
  const r = await api(`/api/intake-list?project=${PID}&site=${encodeURIComponent(SITE_B)}&hospitalId=${encodeURIComponent(SITE_B)}`, { jar: j });
  const items = r.json?.items || [];
  assert.ok(items.every(it => it.site === SITE_A), '越权传参被忽略，仍只见 SITE_A：' + JSON.stringify(items.map(i => i.site)));
  assert.ok(!items.some(it => it.site === SITE_B), '拿不到乙医院数据');
});

test('C3 impl(甲) 访问别家医院工单详情 → 403（AC-13）', async () => {
  // 乙医院的一条工单 id（管理员查得到）
  const rl = await api('/api/intake-list?project=' + PID, { jar: admin });
  const bItem = (rl.json?.items || []).find(it => it.site === SITE_B);
  assert.ok(bItem, '前置：管理员能查到乙医院工单');
  const j = jar(); await login(U_A, PW, j);
  const r = await api(`/api/intake-detail?project=${PID}&id=${bItem.id}`, { jar: j });
  assert.equal(r.status, 403, '甲查乙工单详情应 403');
  assert.equal(r.json?.item, null);
  assert.equal(r.json?.error, '无权查看该工单');
  // 自己医院工单详情可看（对照）
  const rlA = await api('/api/intake-list?project=' + PID, { jar: j });
  const aItem = (rlA.json?.items || [])[0];
  const okD = await api(`/api/intake-detail?project=${PID}&id=${aItem.id}`, { jar: j });
  assert.equal(okD.status, 200); assert.ok(okD.json?.item, '自己医院工单详情可看');
});

test('C4 甲、乙无交集账号互不可见（AC-14）', async () => {
  const jA = jar(); await login(U_A, PW, jA);
  const jB = jar(); await login(U_B, PW, jB);
  const rA = await api('/api/intake-list?project=' + PID, { jar: jA });
  const rB = await api('/api/intake-list?project=' + PID, { jar: jB });
  const sitesA = new Set((rA.json?.items || []).map(i => i.site));
  const sitesB = new Set((rB.json?.items || []).map(i => i.site));
  assert.ok(sitesA.has(SITE_A) && !sitesA.has(SITE_B), '甲只见甲');
  assert.ok(sitesB.has(SITE_B) && !sitesB.has(SITE_A), '乙只见乙');
});

test('C5 pm(设了 sites=甲+丙) 同样受 sites 约束（NH-5 / AC-20）', async () => {
  const j = jar(); await login(U_PM, PW, j);
  const me = await api('/api/me', { jar: j });
  assert.equal(me.json?.me.role, 'pm', 'role=pm');
  const r = await api('/api/intake-list?project=' + PID, { jar: j });
  const sites = new Set((r.json?.items || []).map(i => i.site));
  assert.ok(sites.has(SITE_A) && sites.has(SITE_C), 'pm 见 甲+丙');
  assert.ok(!sites.has(SITE_B), 'pm 看不到乙（未绑定）');
});

test('C6 admin(isAdmin 含 dev) 不受限，见全部 sites（对照 AC-20：修复只影响非管理员）', async () => {
  const r = await api('/api/intake-list?project=' + PID, { jar: admin });
  const sites = new Set((r.json?.items || []).map(i => i.site));
  assert.ok(sites.has(SITE_A) && sites.has(SITE_B) && sites.has(SITE_C), '管理员见 甲+乙+丙 全部');
});

test('C7 回归证据：impl 的 intake-list 非空且已过滤（scopedForField 对 role=impl 生效，非原样返回全集）（AC-20）', async () => {
  const j = jar(); await login(U_A, PW, j);
  const rImpl = await api('/api/intake-list?project=' + PID, { jar: j });
  const rAdmin = await api('/api/intake-list?project=' + PID, { jar: admin });
  const nImpl = (rImpl.json?.items || []).length, nAdmin = (rAdmin.json?.items || []).length;
  assert.ok(nImpl > 0, 'impl 能看到自己 sites 的工单（非空）');
  assert.ok(nImpl < nAdmin, `impl(${nImpl}) 严格少于 admin(${nAdmin})：证明已过滤、未原样返回全集（field→impl 归一缺口已修）`);
});
