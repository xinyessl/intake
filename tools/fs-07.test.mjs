// FS-07 · 经验库入口（现场检索）—— 后端接口 + 连真库冒烟（零依赖，node --test）
//   启动真实 server.mjs（连本地 MySQL data/db.json）到隔离端口，用 fetch 打真实端点；mysql2 直连真库核对列名映射。
//   覆盖后端 AC（前端入口 AC-1/2/4/6/7 UI 部分 deferred，待 FS-01 field.html）：
//     · AC-8 权限纵深：现场账号（本测造隔离 impl）调 /api/kb-search → 200（已进 FIELD_OK）；
//       调 /api/kb-save、/api/kb-delete → 403（未进 FIELD_OK）；未登录 → 401。
//     · AC-3/AC-5 检索（全库聚合）：真实产品 hlyy 用真实关键词「审方」不带 project 调 → 命中该产品条目、
//       带正确 project(产品 id)+productName(产品名)、字段映射 q/a/subsystem/from_ref↔from/created_at↔at 无错配；
//       无 token 命中 q → 空数组；给 project=hlyy 过滤 → 只回该产品；跨产品聚合（hlyy + 隔离产品）一次 q 同列表召回按分排序。
//     · AC-7 只读：检索前后 kb_entries 行数不变（无写库残留）。
//   全程用隔离产品 + 隔离 impl 账号；after 钩子清 kb_entries/intakes/projects 行 + data/kb、data/intake-store 文件 + 删账号，不污染真库。
//   用法：node --test tools/fs-07.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5300 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'fs07smoke-' + Date.now().toString(36);         // 隔离产品（跨产品聚合用）
const FIELD_U = 'fs07impl_' + Date.now().toString(36);      // 隔离现场账号（role=impl）
const FIELD_PW = 'Fs07Pass99';
const REAL_PID = 'hlyy';                                     // 真实产品（真库已有 kb 条目）
const REAL_KW = '审方';                                     // 真实条目关键词（hlyy: 审方里阿司匹林和氯吡格雷…）

let srv = null, adminCookie = '', fieldCookie = '', pool = null, fieldId = '';

function req(p, { method = 'GET', body, cookie } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, setCookie: r.headers.get('set-cookie'), json: await r.json().catch(() => null) }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  // 预清理残留
  await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]);
  await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]);
  await pool.query('DELETE FROM projects WHERE id=?', [PID]);
  await pool.query('DELETE FROM accounts WHERE username=?', [FIELD_U]);
  // 启动真实服务
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  // 管理员登录
  const lg = await req('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  adminCookie = lg.setCookie.split(';')[0];
  // 造隔离产品 + 一条 kb 条目（跨产品聚合验证；用与 REAL_KW 同关键词「审方」使一次检索能跨两产品召回）
  // 子系统含一个「英文 name / 中文 desc」双键项（s1: name='audit', desc='审方'），复现用户反馈「子系统显英文 audit 应显中文 审方」的场景，验证 subsystemLabel 服务端解析中文 desc
  const ps = await req('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS07 冒烟产品', subsystems: [{ key: 'core', name: '审方子系统', desc: '审方规则' }, { key: 's1', name: 'audit', desc: '审方' }] }, cookie: adminCookie });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
  const kb = await req('/api/kb-save', { method: 'POST', body: { project: PID, q: '审方规则误报，如何加白名单', a: '在**审方**规则里加白名单即可。', subsystem: '审方子系统', module: '审方规则', tags: ['审方', '误报'] }, cookie: adminCookie });
  assert.equal(kb.json?.ok, true, '前置：隔离产品造 kb 条目应成功');
  // 再造一条 subsystem=英文 name 'audit' 的条目，供断言 subsystemLabel 解析成中文 desc '审方'（且原 subsystem='audit' 仍在）
  const kb2 = await req('/api/kb-save', { method: 'POST', body: { project: PID, q: 'audit 子系统审方白名单如何配置', a: '在 **audit** 子系统里配置白名单即可。', subsystem: 'audit', module: '', tags: ['审方', 'audit'] }, cookie: adminCookie });
  assert.equal(kb2.json?.ok, true, '前置：隔离产品造英文子系统 kb 条目应成功');
  // 造隔离现场账号（role=impl，known password）
  const ac = await req('/api/account-save', { method: 'POST', body: { username: FIELD_U, role: 'impl', name: 'FS07现场', password: FIELD_PW, projects: [PID], sites: ['测试医院'], enabled: 1 }, cookie: adminCookie });
  assert.equal(ac.json?.ok, true, '前置：造隔离现场账号应成功');
  fieldId = (ac.json.accounts.find(a => a.username === FIELD_U) || {}).id || '';
  assert.ok(fieldId, '前置：应取到现场账号 id（供 after 删除）');
  // 现场账号登录（must_change=1 不阻塞登录，session 照发）
  const flg = await req('/api/login', { method: 'POST', body: { username: FIELD_U, password: FIELD_PW } });
  assert.equal(flg.json?.ok, true, '前置：现场账号登录应成功');
  fieldCookie = flg.setCookie.split(';')[0];
});

after(async () => {
  try { if (fieldId) await req('/api/account-delete', { method: 'POST', body: { id: fieldId }, cookie: adminCookie }); } catch {}
  try { if (pool) await pool.query('DELETE FROM accounts WHERE username=?', [FIELD_U]); } catch {}
  try { await req('/api/project-delete', { method: 'POST', body: { id: PID }, cookie: adminCookie }); } catch {}
  // project-delete 不级联删 kb_entries/intakes（见 lessons）→ 手动兜底删
  try { if (pool) { await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]); await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); await pool.query('DELETE FROM projects WHERE id=?', [PID]); } } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/kb', PID + '.json'), { force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', PID), { recursive: true, force: true }); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

/* ============ AC-8 权限纵深（FIELD_OK 白名单 deny-by-default）============ */
test('AC-8 现场账号（impl）调 /api/kb-search → 200（已进 FIELD_OK）', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent(REAL_KW), { cookie: fieldCookie });
  assert.equal(r.status, 200, '现场账号应可调 kb-search');
  assert.ok(Array.isArray(r.json.entries), '返回 entries 数组');
});

test('AC-8 现场账号调 /api/kb-save → 403（未进 FIELD_OK，纵深）', async () => {
  const r = await req('/api/kb-save', { method: 'POST', body: { project: REAL_PID, q: '越权写', a: '不应成功' }, cookie: fieldCookie });
  assert.equal(r.status, 403, '现场账号写经验库应被 authGate 拒（forbidden）');
});

test('AC-8 现场账号调 /api/kb-delete → 403（未进 FIELD_OK，纵深）', async () => {
  const r = await req('/api/kb-delete', { method: 'POST', body: { project: REAL_PID, id: 'whatever' }, cookie: fieldCookie });
  assert.equal(r.status, 403, '现场账号删经验库应被 authGate 拒（forbidden）');
});

test('AC-8 现场账号调 /api/kb-list → 403（kb-list 维持仅管理端、不加白名单）', async () => {
  const r = await req('/api/kb-list?project=' + REAL_PID, { cookie: fieldCookie });
  assert.equal(r.status, 403, 'kb-list 不在 FIELD_OK → 现场 403（方案 A：现场只走 kb-search）');
});

test('鉴权 未登录调 /api/kb-search → 401', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent(REAL_KW));
  assert.equal(r.status, 401, '未登录访问 API → need-login 401');
});

/* ============ AC-3/AC-5 检索（全库聚合 + 标产品 + 字段映射）============ */
test('AC-3/AC-5 连真库冒烟：真实关键词全库检索命中 hlyy、带 project+productName、列名映射无错配', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent(REAL_KW), { cookie: fieldCookie });
  assert.equal(r.status, 200);
  const hit = r.json.entries.find(e => e.project === REAL_PID);
  assert.ok(hit, '全库检索「审方」应命中真实产品 hlyy 的条目');
  // 标产品：project=产品 id、productName=产品名（取自 projects 表）
  assert.equal(hit.project, REAL_PID, 'project=产品 id');
  assert.equal(hit.productName, '合理用药', 'productName=projById(hlyy).name（真库产品名）');
  // 内存形状字段（列名映射：from_ref↔from、created_at↔at）
  for (const k of ['id', 'q', 'a', 'subsystem', 'module', 'tags', 'from', 'at']) assert.ok(k in hit, `结果应含内存字段 ${k}`);
  assert.ok(Array.isArray(hit.tags), 'tags 为数组');
  // 连真库回读该条，核对 q/a/subsystem/from_ref/created_at 与结果映射一致
  const [rows] = await pool.query('SELECT q,a,subsystem,module,tags,from_ref,created_at FROM kb_entries WHERE project_id=? AND id=?', [REAL_PID, hit.id]);
  assert.equal(rows.length, 1, 'DB 应有该行');
  const row = rows[0];
  assert.equal(hit.q, row.q, 'q 映射一致');
  assert.equal(hit.a, row.a, 'a 映射一致');
  assert.equal(hit.subsystem, row.subsystem || '', 'subsystem 映射一致');
  assert.equal(hit.from, row.from_ref || 'manual', 'from ↔ from_ref（下划线列名）映射无错配');
  assert.equal(hit.at, row.created_at || '', 'at ↔ created_at 映射无错配');
});

test('AC-5 无 token 命中的关键词 → 空数组', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent('zzxxqqnoexistkeyword张三李四不存在词'), { cookie: fieldCookie });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.entries, [], '无命中 → 空数组');
});

test('AC-2 空/缺失 q → 空数组（温和风格）', async () => {
  const r1 = await req('/api/kb-search?q=', { cookie: fieldCookie });
  assert.deepEqual(r1.json.entries, [], '空 q → 空数组');
  const r2 = await req('/api/kb-search', { cookie: fieldCookie });
  assert.deepEqual(r2.json.entries, [], '缺 q → 空数组');
});

test('AC-2/AC-5 project=hlyy 可选过滤 → 只回该产品条目', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent(REAL_KW) + '&project=' + REAL_PID, { cookie: fieldCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.entries.length > 0, 'hlyy 过滤应有命中');
  assert.ok(r.json.entries.every(e => e.project === REAL_PID), '过滤后每条 project 都为 hlyy');
  assert.ok(r.json.entries.every(e => e.project !== PID), '不含隔离产品条目');
});

test('AC-5 未知 project 过滤 → 空数组（projById 返回 null，不兜底）', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent(REAL_KW) + '&project=__no_such__', { cookie: fieldCookie });
  assert.deepEqual(r.json.entries, [], '未知产品 → 空数组');
});

test('AC-5 跨产品聚合：一次「审方」全库检索能同列表召回 hlyy + 隔离产品、按分排序', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent('审方 白名单') + '&n=20', { cookie: fieldCookie });
  assert.equal(r.status, 200);
  const pset = new Set(r.json.entries.map(e => e.project));
  assert.ok(pset.has(REAL_PID), '应含真实产品 hlyy 命中');
  assert.ok(pset.has(PID), '应含隔离产品命中（跨产品聚合）');
  // 隔离产品条目带产品名
  const mine = r.json.entries.find(e => e.project === PID);
  assert.equal(mine.productName, 'FS07 冒烟产品', '隔离产品条目 productName 正确');
});

test('AC-5 n 参数封顶 20', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent(REAL_KW) + '&n=999', { cookie: fieldCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.entries.length <= 20, 'n 超 20 应封顶到 20');
});

/* ============ 问题③：经验库打开浏览全部（all=1 端点）============ */
test('浏览 all=1 无 q → 返回全库条目（跨产品聚合，含隔离产品那条 + 带 project/productName）', async () => {
  const r = await req('/api/kb-search?all=1', { cookie: fieldCookie });
  assert.equal(r.status, 200, 'all=1 应 200');
  assert.ok(Array.isArray(r.json.entries), '返回 entries 数组');
  assert.ok(r.json.entries.length > 0, 'all=1 全库应有条目（非空）');
  const mine = r.json.entries.find(e => e.project === PID);
  assert.ok(mine, '★ all=1 含隔离产品那条（造的 kb 条目）');
  assert.equal(mine.productName, 'FS07 冒烟产品', '隔离产品条目带 productName');
  assert.match(mine.q, /白名单/, '条目带真实问 q');
  assert.ok('a' in mine && 'subsystem' in mine, '条目带 a/subsystem（供前端问+答渲染）');
  // 跨产品：应含真实产品 hlyy 的条目（全库聚合）
  assert.ok(r.json.entries.some(e => e.project === REAL_PID), 'all=1 跨产品含 hlyy 条目');
});

test('浏览 all=1 封顶 50（不臆造无上限）', async () => {
  const r = await req('/api/kb-search?all=1', { cookie: fieldCookie });
  assert.ok(r.json.entries.length <= 50, 'all=1 封顶 ≤50');
});

test('浏览 all=1 + project=PID → 只回该产品全部条目', async () => {
  const r = await req('/api/kb-search?all=1&project=' + PID, { cookie: fieldCookie });
  assert.equal(r.status, 200);
  assert.ok(r.json.entries.length > 0, '该产品有条目');
  assert.ok(r.json.entries.every(e => e.project === PID), 'all=1 带 project 过滤 → 只回该产品');
});

test('浏览 all=1 未知 project → 空数组（projById null，不兜底）', async () => {
  const r = await req('/api/kb-search?all=1&project=__no_such__', { cookie: fieldCookie });
  assert.deepEqual(r.json.entries, [], '未知产品 all=1 → 空数组');
});

test('契约保护：q 空且无 all（现有行为）→ 空数组（不被 all 分支破坏 L-记录温和空态）', async () => {
  const r1 = await req('/api/kb-search?q=', { cookie: fieldCookie });
  assert.deepEqual(r1.json.entries, [], 'q 空无 all → 空数组（现有契约不变）');
  const r2 = await req('/api/kb-search', { cookie: fieldCookie });
  assert.deepEqual(r2.json.entries, [], '缺 q 无 all → 空数组（现有契约不变）');
});

test('现场账号（impl）可调 all=1（已在 FIELD_OK，只读浏览）', async () => {
  const r = await req('/api/kb-search?all=1', { cookie: fieldCookie });
  assert.equal(r.status, 200, '现场账号浏览全库 200');
});

/* ============ AC-7 只读：检索无写库副作用 ============ */
test('AC-7 检索为纯读：kb_entries 行数检索前后不变（无写库残留）', async () => {
  const cnt = async () => (await pool.query('SELECT COUNT(*) n FROM kb_entries'))[0][0].n;
  const before = await cnt();
  for (let i = 0; i < 3; i++) await req('/api/kb-search?q=' + encodeURIComponent(REAL_KW), { cookie: fieldCookie });
  const after = await cnt();
  assert.equal(after, before, '检索不写库（行数不变）');
});

/* ============ 子系统显中文：kb-search 返回 subsystemLabel（英文 name → 中文 desc）============
   用户 2026-07-23 反馈：经验库/引用「子系统：audit」应显中文（audit→审方）。
   服务端加 subsystemLabel（解析该产品 subsystems[].desc），原 subsystem(英文 name) 保留。 */
test('★ all=1 条目带 subsystemLabel 且为中文 desc（audit→审方），原 subsystem=英文 name 仍在', async () => {
  const r = await req('/api/kb-search?all=1&project=' + PID, { cookie: fieldCookie });
  assert.equal(r.status, 200);
  const hit = r.json.entries.find(e => e.subsystem === 'audit');
  assert.ok(hit, 'all=1 应含 subsystem=audit 的隔离条目');
  assert.equal(hit.subsystem, 'audit', '原 subsystem 仍是英文 name（供搜索/过滤，未被覆盖）');
  assert.equal(hit.subsystemLabel, '审方', '★ subsystemLabel 解析为中文 desc「审方」（用户反馈的核心）');
});

test('★ q 检索条目带 subsystemLabel 中文 desc（audit→审方），原 subsystem 仍英文', async () => {
  const r = await req('/api/kb-search?q=' + encodeURIComponent('audit 白名单') + '&project=' + PID, { cookie: fieldCookie });
  assert.equal(r.status, 200);
  const hit = r.json.entries.find(e => e.subsystem === 'audit');
  assert.ok(hit, 'q 检索应召回 subsystem=audit 的条目');
  assert.equal(hit.subsystemLabel, '审方', '★ q 检索条目 subsystemLabel=中文 desc「审方」');
  assert.equal(hit.subsystem, 'audit', 'q 检索条目原 subsystem 仍英文 name');
});

test('subsystemLabel 查不到子系统目录 → 回退原 subsystem（不为 undefined）', async () => {
  // hlyy 真库条目：subsystem 若非产品目录里的 name，subsystemLabel 回退原值（含空）
  const r = await req('/api/kb-search?all=1', { cookie: fieldCookie });
  const hits = r.json.entries.filter(e => e.project === REAL_PID);
  for (const h of hits) assert.ok('subsystemLabel' in h, 'hlyy 每条也带 subsystemLabel 字段（加法字段，全分支覆盖）');
});

/* ============ 静态断言：server.mjs kbSubLabel helper + kb-search all=1 分支不破坏 q 空态契约 ============ */
test('静态：server.mjs 有 kbSubLabel helper（查产品 subsystems[].name → desc||name，回退原名）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.match(src, /function kbSubLabel\(projId, subName\)/, '有 kbSubLabel(projId, subName) helper');
  assert.match(src, /\.find\(x => x && \(x\.name === subName\)\)/, 'helper 按 subsystems[].name 精确匹配');
  assert.match(src, /\(s\.desc \|\| s\.name\)\) \|\| subName \|\| ''/, 'helper 取 desc||name，查不到回退 subName');
});
test('静态：server.mjs kb-search 有 all=1 浏览分支（all&&!q → 全库），且 q 空无 all 仍返空数组', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const seg = (src.match(/url\.pathname === '\/api\/kb-search'\)[\s\S]*?scored\.slice\(0, n\)/) || [''])[0];
  assert.ok(seg, '能截取 kb-search 端点体');
  assert.match(seg, /const browseAll = url\.searchParams\.get\('all'\) === '1'/, '解析 all=1');
  assert.match(seg, /if \(browseAll && !qtext\)/, 'all=1 且无 q → 浏览全库分支');
  assert.match(seg, /out\.length >= CAP/, '浏览封顶（CAP）');
  assert.match(seg, /\{ \.\.\.e, project: pid, productName: name, subsystemLabel: kbSubLabel\(pid, e\.subsystem\) \}/, '浏览条目带 project/productName/subsystemLabel（子系统中文 desc 展示用）');
  assert.match(seg, /subsystemLabel: kbSubLabel\(pid, e\.subsystem\) \}\);/, 'q 检索分支也带 subsystemLabel（两处一致）');
  // q 空且无 all → 空数组（现有契约不变，在浏览分支之后）
  assert.match(seg, /if \(!qtext\) return send\(res, 200, JSON\.stringify\(\{ entries: \[\] \}\)\)/, 'q 空无 all → 空数组（温和空态契约保留）');
});

/* ============ 静态断言：FIELD_OK 白名单精确（kb-search in / kb-save·kb-delete·kb-list out）============ */
test('静态：server.mjs FIELD_OK 含 kb-search，且不含 kb-save/kb-delete/kb-list', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const m = src.match(/const FIELD_OK = new Set\((\[[^\]]*\])\)/);
  assert.ok(m, '应能定位 FIELD_OK 白名单');
  const list = JSON.parse(m[1].replace(/'/g, '"'));
  assert.ok(list.includes('/api/kb-search'), 'FIELD_OK 应含 /api/kb-search');
  assert.ok(!list.includes('/api/kb-save'), 'FIELD_OK 绝不含 /api/kb-save');
  assert.ok(!list.includes('/api/kb-delete'), 'FIELD_OK 绝不含 /api/kb-delete');
  assert.ok(!list.includes('/api/kb-list'), 'FIELD_OK 不含 /api/kb-list（维持仅管理端）');
});

/* ============ 前端静态断言：public/field.html 经验库检索面板（AC-1/2/3/4/6/7/8）============
   纯字符串/DOM 断言，不起浏览器；验证面板骨架 + 触发方式 + 渲染字段 + 空态占位 + 无编辑入口。 */
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

test('前端 AC-1：经验库入口 #fKbBtn 存在且点击打开面板（openKb），不再跳 /kb.html', () => {
  assert.match(FIELD_HTML, /id="fKbBtn"/, '顶栏应有经验库入口 #fKbBtn');
  assert.match(FIELD_HTML, /\$\('fKbBtn'\)\.addEventListener\('click'[\s\S]*?openKb\(\)/, '点 #fKbBtn 应 openKb() 打开面板');
  assert.doesNotMatch(FIELD_HTML, /fKbBtn'\)[\s\S]{0,80}window\.location\.href = '\/kb\.html'/, '不应再跳转 /kb.html');
});

test('前端 问题③：打开经验库即浏览全库（openKb→kbBrowseAll 拉 all=1），清空关键词回到浏览全部', () => {
  // openKb 打开时调 kbBrowseAll（不再一开是空 hollow）
  assert.match(FIELD_HTML, /function openKb\(\)[\s\S]*?kbBrowseAll\(\)/, 'openKb 打开时调 kbBrowseAll（浏览全库）');
  // kbBrowseAll 调 /api/kb-search?all=1
  const baBody = (FIELD_HTML.match(/function kbBrowseAll\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(baBody, '能截取 kbBrowseAll 函数体');
  assert.match(baBody, /\/api\/kb-search\?all=1/, 'kbBrowseAll 调 kb-search?all=1');
  assert.match(baBody, /mkKbItem\(e\)/, '复用现有 mkKbItem 渲染（问+答+产品徽标）');
  assert.match(baBody, /经验库暂无内容/, '真的一条都没有 → 「经验库暂无内容」（hollow 仅全库 0 条时显示）');
  // doKbSearch：清空关键词 → 回到浏览全部（不再显「输入关键词后开始检索」）
  const dsBody = (FIELD_HTML.match(/function doKbSearch\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(dsBody, /if \(!q\) \{ kbBrowseAll\(\); return; \}/, '清空关键词 → kbBrowseAll（覆盖上次检索结果）');
  // 关键词回车/点搜索仍走现有 ?q= 精确检索
  assert.match(dsBody, /\/api\/kb-search\?q='/, '有关键词 → ?q= 精确检索（覆盖浏览结果）');
});

test('前端 AC-1：抽屉自实现 open/close（.drawer/.drawer-mask），不依赖 UI.openDrawer', () => {
  assert.match(FIELD_HTML, /<aside class="drawer f-kb-drawer" id="fKbDrawer"/, '面板用 theme.css .drawer');
  assert.match(FIELD_HTML, /<div class="drawer-mask" id="fKbMask"/, '有 .drawer-mask 遮罩');
  assert.match(FIELD_HTML, /\$\('fKbDrawer'\)\.classList\.add\('open'\)/, '自实现 open：classList.add(\'open\')');
  assert.match(FIELD_HTML, /\$\('fKbDrawer'\)\.classList\.remove\('open'\)/, '自实现 close：classList.remove(\'open\')');
  assert.doesNotMatch(FIELD_HTML, /UI\.openDrawer\(/, '不得调用不存在的 UI.openDrawer()');
});

test('前端 AC-2：检索框 + 搜索按钮，回车或点按钮触发（非即输即查）', () => {
  assert.match(FIELD_HTML, /id="fKbInput"/, '有关键词自由文本框');
  assert.match(FIELD_HTML, /id="fKbSearchBtn"/, '有搜索按钮');
  assert.match(FIELD_HTML, /\$\('fKbSearchBtn'\)\.addEventListener\('click', doKbSearch\)/, '点按钮触发 doKbSearch');
  assert.match(FIELD_HTML, /\$\('fKbInput'\)\.addEventListener\('keydown'[\s\S]*?Enter[\s\S]*?doKbSearch\(\)/, '回车触发 doKbSearch');
  // 不即输即查：文本框不绑 input/keyup 直接查
  assert.doesNotMatch(FIELD_HTML, /\$\('fKbInput'\)\.addEventListener\('input'/, '文本框不得绑 input 即输即查');
});

test('前端 AC-2：调 /api/kb-search 且不传 project（全库所有产品）', () => {
  assert.match(FIELD_HTML, /api\('\/api\/kb-search\?q='/, '调 /api/kb-search 带 q');
  // 全库：kb-search 调用里不拼 project= 参数
  const call = FIELD_HTML.match(/api\('\/api\/kb-search\?q='[^)]*\)/);
  assert.ok(call, '应能定位 kb-search 调用');
  assert.doesNotMatch(call[0], /project=/, '前端 kb-search 不传 project（全库检索）');
});

test('前端 AC-3：结果渲染 所属产品(productName)/问题 q/子系统/来源徽标', () => {
  assert.match(FIELD_HTML, /productName/, '渲染读 productName（区分产品）');
  assert.match(FIELD_HTML, /f-kb-prod/, '有产品 chip 类 .f-kb-prod');
  assert.match(FIELD_HTML, /e\.q\b/, '渲染问题 e.q');
  assert.match(FIELD_HTML, /子系统/, '结果显示子系统');
  assert.match(FIELD_HTML, /src-manual|src-consult|src-auto/, '来源徽标类 .src-*');
  assert.match(FIELD_HTML, /manual:\s*'人工'[\s\S]*consult:\s*'答疑'[\s\S]*auto:\s*'自动'/, '来源徽标文案 人工/答疑/自动');
});

test('前端 子系统显中文：mkKbItem 用 subsystemLabel（中文 desc）优先，回退 subsystem（英文 name）', () => {
  const mkBody = (FIELD_HTML.match(/function mkKbItem\(e\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(mkBody, '能截取 mkKbItem 函数体');
  assert.match(mkBody, /e\.subsystemLabel \|\| e\.subsystem/, '★ 子系统显示用 subsystemLabel（中文）优先，回退 subsystem（英文）');
});

test('前端 子系统显中文：renderKbCite 引用区 meta 用 subsystemLabel 优先', () => {
  const rcBody = (FIELD_HTML.match(/function renderKbCite\(bub, kb\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(rcBody, '能截取 renderKbCite 函数体');
  assert.match(rcBody, /h\.subsystemLabel \|\| h\.subsystem/, '★ 引用区子系统也用 subsystemLabel（中文）优先，回退 subsystem（英文）');
});

test('前端 AC-4：展开看解法 e.a 用受控 Markdown md()（先转义 & < > 再解析）', () => {
  assert.match(FIELD_HTML, /function md\(src\)/, '有受控 Markdown 函数 md()');
  // 先转义 & < >
  assert.match(FIELD_HTML, /replace\(\/\[&<>\]\/g/, 'md() 先转义 & < > 防 XSS');
  // **加粗** / `code`（块级解析器：标题/列表/段落；行内加粗与代码）
  assert.match(FIELD_HTML, /<strong>\$1<\/strong>/, 'md() 支持 **加粗**');
  assert.match(FIELD_HTML, /<code>'\s*\+\s*c\s*\+\s*'<\/code>/, 'md() 支持 `code`');
  // 段落内换行用 <br> 连接（块级解析器 flushPara：para.join('<br>')）——替代早稿的整体 /\n/→<br>
  assert.match(FIELD_HTML, /para\.join\('<br>'\)/, 'md() 段落内换行 → <br>（块级解析器）');
  assert.match(FIELD_HTML, /md\(e\.a/, '展开解法用 md(e.a) 渲染');
  assert.match(FIELD_HTML, /classList\.toggle\('open'\)/, '点击展开/收起 toggle open');
});

test('前端 AC-6：空态「未找到相关经验」+「去 AI 对话提交」占位（FS-04 禁用态）', () => {
  assert.match(FIELD_HTML, /未找到相关经验/, '空态提示文案');
  assert.match(FIELD_HTML, /去 AI 对话提交/, '空态有「去 AI 对话提交」入口');
  assert.match(FIELD_HTML, /btn\.disabled = true/, 'FS-04 入口做禁用态占位');
  assert.match(FIELD_HTML, /FS-04/, '标注 FS-04（即将上线）');
  assert.match(FIELD_HTML, /TODO\(FS-04\)/, '代码留 TODO(FS-04) 注释');
});

test('前端 AC-7/AC-8：面板内无任何新增/编辑/删除按钮（现场只读）', () => {
  // 面板不调写库端点
  assert.doesNotMatch(FIELD_HTML, /kb-save/, 'field.html 不得调 kb-save');
  assert.doesNotMatch(FIELD_HTML, /kb-delete/, 'field.html 不得调 kb-delete');
  // 抽屉内无「新增/编辑/删除」按钮文案
  const drawer = FIELD_HTML.match(/<aside class="drawer f-kb-drawer"[\s\S]*?<\/aside>/);
  assert.ok(drawer, '应能定位经验库抽屉 DOM');
  assert.doesNotMatch(drawer[0], /新增|编辑|删除/, '抽屉内无 新增/编辑/删除 按钮');
});

test('前端：field.html 无隐形字符（nbsp/零宽/BOM 等）', () => {
  const bad = [];
  for (let i = 0; i < FIELD_HTML.length; i++) {
    const c = FIELD_HTML.codePointAt(i);
    if (c === 0x00A0 || c === 0x00AD || (c >= 0x200B && c <= 0x200F) ||
        c === 0x2028 || c === 0x2029 || (c >= 0x202A && c <= 0x202E) ||
        c === 0x2060 || c === 0x202F || c === 0xFEFF) bad.push(i);
  }
  assert.equal(bad.length, 0, '不得含隐形字符，实际 ' + bad.length + ' 个（偏移 ' + bad.slice(0, 5).join(',') + '）');
});
