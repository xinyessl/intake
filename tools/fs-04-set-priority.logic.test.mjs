// FS-04 · AC-32（per-ticket 紧急程度）· 脱库逻辑测试 + 连真库冒烟（MySQL 可用时）
//   背景：紧急程度从「顶部全局一个」改成「每张已建单卡片各设各的」（一次对话多张单、各条不同）。
//   本地 MySQL 常 ECONNREFUSED 3306、server.mjs 启动即 await db.init() 失败退出——故：
//     · A/B/C 组：从 server.mjs 源码抽 normPriority 真身 + 静态断言（白名单/响应/AI 提示词）+ 复刻 set-priority 核心逻辑（忠实重写，可抓漂移）。
//     · D 组：连真库冒烟——MySQL 起得来才跑（spawn 真 server + 打真实端点 + mysql2 核对 intakes.priority 列），否则整组 skip。
//   覆盖 AC-32：① intake-chat 建两张单各自 priority=AI 判（非全局覆盖）② set-priority 改一张只该张变 ③ 越权 site 拒
//              ④ 非法档回落原值 ⑤ consult 拒（仅 requirement/bug 可设）⑥ 端点进两处白名单 ⑦ 响应带 priority ⑧ AI 提示词让 AI 判 priority
//   用法：node --test tools/fs-04-set-priority.logic.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

// —— 从源码抽出具名函数体，沙箱 eval（测真实源码，非重写副本，能抓漂移） —— //
function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}
// normPriority 依赖模块级 PRIORITY_SET —— 一起注入沙箱
const PRIORITY_SET = new Set(['紧急', '高', '中', '低']);
const normPriority = new Function('PRIORITY_SET', extractFn(SRC, 'normPriority') + '\nreturn normPriority;')(PRIORITY_SET);
const isAdmin = (u) => !!(u && (u.role === 'admin' || u.role === 'dev'));

/* ================= A. normPriority 真身（四档校验/回落） ================= */
test('A1 normPriority：合法四档原样返回', () => {
  ['紧急', '高', '中', '低'].forEach(v => assert.equal(normPriority(v, '中'), v, v + ' 应原样'));
});
test('A2 normPriority：非法/空 → 回落 fallback（默认中）', () => {
  assert.equal(normPriority('P0', '中'), '中', '非法档回落 fallback');
  assert.equal(normPriority('', '高'), '高', '空回落传入 fallback');
  assert.equal(normPriority(null, '低'), '低', 'null 回落 fallback');
  assert.equal(normPriority('  中  ', '中'), '中', 'trim 后合法');
  assert.equal(normPriority('xx'), '中', '无 fallback 默认中');
});

/* ================= B. 静态断言（改动落地：全局删净 / 白名单 / 响应 / AI 提示词 / 卡片选择器） ================= */
test('B1 server：intake-chat 建单不再被全局 b.priority 覆盖 → 按 rec.priority 规范到四档', () => {
  // 建单 record 的 priority 取 normPriority(rec.priority,'中')，且不出现 normPriority(b.priority,...) 那种全局覆盖
  assert.match(SRC, /priority: normPriority\(rec\.priority, '中'\)/, 'intake-chat record priority = normPriority(rec.priority,中)');
  assert.doesNotMatch(SRC, /normPriority\(b\.priority, rec\.priority/, '不再有 normPriority(b.priority, rec.priority…) 的全局覆盖');
});
test('B2 server：intake-chat 响应体带 priority（现场卡片默认档）', () => {
  assert.match(SRC, /let savedId = '', savedPriority = ''/, '声明 savedPriority');
  assert.match(SRC, /savedPriority = e\.priority/, '建单后回带该单 priority');
  assert.match(SRC, /ok: true, reply, savedId, priority: savedPriority/, '响应 {ok,reply,savedId,priority}');
});
test('B3 server：/api/intake-submit 仍是单工单路径、priority=normPriority(b.priority,中)（保留正确）', () => {
  assert.match(SRC, /priority: normPriority\(b\.priority, '中'\)/, 'intake-submit 保留 normPriority(b.priority,中)');
});
test('B4 server：新端点 /api/intake-set-priority 存在且方法为 POST', () => {
  assert.match(SRC, /url\.pathname === '\/api\/intake-set-priority' && req\.method === 'POST'/, '路由存在');
});
test('B5 server：set-priority 关键守卫齐全（type 门/site 收敛/normPriority 回落原值/history 留痕/saveIntake）', () => {
  const seg = SRC.slice(SRC.indexOf("/api/intake-set-priority' && req.method"), SRC.indexOf("if (url.pathname === '/api/overview'"));
  assert.match(seg, /e\.type !== 'requirement' && e\.type !== 'bug'/, '仅 requirement/bug 可设（consult 拒）');
  assert.match(seg, /user\.sites\.map\(String\)\.includes\(String\(e\.site \|\| ''\)\)/, 'site ∈ user.sites 收敛（管理员不限）');
  assert.match(seg, /normPriority\(b\.priority, from/, '显式选择：合法用之，非法回落原值 from');
  assert.match(seg, /note: '调整紧急程度→'/, 'history 留痕「调整紧急程度→」');
  assert.match(seg, /await saveIntake\(proj, e\)/, '落库 saveIntake');
  assert.match(seg, /priority: e\.priority/, '返回 {ok,priority}');
});
test('B6 server：/api/intake-set-priority 同进 FIELD_OK + FS08_FIELD_API（现场域外层闸放行）', () => {
  const fieldOk = SRC.match(/const FIELD_OK = new Set\(\[[\s\S]*?\]\)/)[0];
  const fs08 = SRC.match(/const FS08_FIELD_API = new Set\(\[[\s\S]*?\]\)/)[0];
  assert.match(fieldOk, /'\/api\/intake-set-priority'/, '在 FIELD_OK');
  assert.match(fs08, /'\/api\/intake-set-priority'/, '在 FS08_FIELD_API（否则 field 域被 originGate deny）');
});
test('B7 server：AI 提示词让 AI 按严重度/影响面判 priority（四档），不总是「中」', () => {
  const p = SRC.slice(SRC.indexOf('function intakeChatSystem'), SRC.indexOf('async function intakeAI'));
  assert.match(p, /priority 必填/, '提示 priority 必填');
  assert.match(p, /紧急\/高\/中\/低/, '限定四档取值');
  assert.match(p, /严重度|影响面/, '按严重度/影响面判定');
});
test('B8 field：全局紧急程度选择器已删净（无 #fPriSel / .f-pri / chat.priority 状态 / syncPriority / setPriority）', () => {
  assert.doesNotMatch(FIELD_HTML, /id="fPriSel"/, '删了全局 select #fPriSel');
  assert.doesNotMatch(FIELD_HTML, /class="f-pri"/, '删了全局 .f-pri 容器');
  assert.doesNotMatch(FIELD_HTML, /function syncPriority/, '删了 syncPriority');
  assert.doesNotMatch(FIELD_HTML, /function setPriority\b/, '删了 setPriority');
  assert.doesNotMatch(FIELD_HTML, /chat\.priority\s*=/, '无 chat.priority 赋值残留');
  // intake-chat 提交 body 不再带全局 priority
  const call = FIELD_HTML.match(/api\('\/api\/intake-chat'[\s\S]*?images:[\s\S]*?\}\)/)[0];
  assert.doesNotMatch(call, /priority:/, 'intake-chat body 不再带全局 priority');
});
test('B9 field：每张卡片有 per-ticket 选择器（buildTicketPriPicker + setTicketPriority + .f-arch-pri + 打 /api/intake-set-priority）', () => {
  assert.match(FIELD_HTML, /function buildTicketPriPicker\(project, id, defPri\)/, '有 buildTicketPriPicker');
  assert.match(FIELD_HTML, /function setTicketPriority\(project, id, priority, selEl\)/, '有 setTicketPriority');
  assert.match(FIELD_HTML, /class="f-arch-pri"|className = 'f-arch-pri'/, '卡片紧急程度容器 .f-arch-pri');
  assert.match(FIELD_HTML, /api\('\/api\/intake-set-priority'/, 'change → POST /api/intake-set-priority');
  assert.match(FIELD_HTML, /已设为/, '成功 toast「已设为…」');
  // appendArchiveCard 建卡时挂选择器，且四档配色 CSS 齐（紧急/高/中/低 data-pri）
  ['紧急', '高', '中', '低'].forEach(v => assert.match(FIELD_HTML, new RegExp('data-pri="' + v + '"'), '配色 CSS data-pri=' + v));
  // 建单/reopen 建卡都把 priority + project 传进 appendArchiveCard
  // 2026-08-06：多单直建后建卡改遍历 savedIds → appendArchiveCard({ id: t.id, ..., priority: t.priority, project: archive.project })（原 b.savedId 单卡形已被多卡逻辑替代，见 CHG-FS04-对话多单直建）。
  assert.match(FIELD_HTML, /appendArchiveCard\(\{ id: t\.id,[\s\S]*?priority: t\.priority, project: archive\.project \}\)/, '新建单卡片（多单遍历 savedIds）带 t.priority + project');
  assert.match(FIELD_HTML, /appendArchiveCard\(\{ id: chat\.savedId, type: item\.type[\s\S]*?priority: item\.priority, project:/, 'reopen 卡片带 item.priority + project');
});

/* ================= C. 复刻 set-priority 核心逻辑（忠实重写）——验 per-ticket 语义（只动一张单） ================= */
// 忠实复刻 handler 的判定链（type 门 → site 收敛 → normPriority 回落原值 → 只改本单 e.priority + 留痕）
function setPriorityCore(store, { project, id }, priority, user) {
  const e = store[id];
  if (!e || e.deleted) return { status: 404, body: { ok: false, error: '工单不存在' } };
  if (e.type !== 'requirement' && e.type !== 'bug') return { status: 400, body: { ok: false, error: '仅需求/BUG 可设紧急程度' } };
  if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(String(e.site || '')))) return { status: 403, body: { ok: false, error: '无权设置该工单紧急程度' } };
  const from = e.priority || '中';
  const to = normPriority(priority, from || '中');
  if (to !== from) { e.priority = to; e.history = e.history || []; e.history.push({ from, to, note: '调整紧急程度→' + to }); }
  return { status: 200, body: { ok: true, priority: e.priority } };
}
const mkStore = () => ({
  'REQ-1': { id: 'REQ-1', type: 'requirement', site: '济南中心医院', priority: '中', history: [] },
  'BUG-2': { id: 'BUG-2', type: 'bug', site: '济南中心医院', priority: '高', history: [] },
  'CON-3': { id: 'CON-3', type: 'consult', site: '济南中心医院', priority: '' },
});
const fieldUser = { role: 'impl', sites: ['济南中心医院'] };
const otherUser = { role: 'impl', sites: ['郑州人民医院'] };
const admin = { role: 'admin', sites: [] };

test('C1 改一张单只该张变、别张不变（per-ticket 核心）', () => {
  const s = mkStore();
  const r = setPriorityCore(s, { project: 'p', id: 'REQ-1' }, '紧急', fieldUser);
  assert.equal(r.status, 200); assert.equal(r.body.priority, '紧急');
  assert.equal(s['REQ-1'].priority, '紧急', 'REQ-1 变紧急');
  assert.equal(s['BUG-2'].priority, '高', 'BUG-2 不受影响（仍高）');
  assert.equal(s['REQ-1'].history.at(-1).note, '调整紧急程度→紧急', '留痕');
});
test('C2 越权 site → 403（该单 site 不在 user.sites）', () => {
  const s = mkStore();
  const r = setPriorityCore(s, { project: 'p', id: 'REQ-1' }, '低', otherUser);
  assert.equal(r.status, 403);
  assert.equal(s['REQ-1'].priority, '中', '越权不落库');
});
test('C3 非法档 → 回落原值、不改、无留痕', () => {
  const s = mkStore();
  const r = setPriorityCore(s, { project: 'p', id: 'BUG-2' }, 'P0', fieldUser);
  assert.equal(r.status, 200); assert.equal(r.body.priority, '高', '非法回落原值高');
  assert.equal(s['BUG-2'].priority, '高', '未变');
  assert.equal(s['BUG-2'].history.length, 0, '同值不刷 history');
});
test('C4 consult 工单拒设（仅 requirement/bug 可设）', () => {
  const s = mkStore();
  const r = setPriorityCore(s, { project: 'p', id: 'CON-3' }, '紧急', fieldUser);
  assert.equal(r.status, 400);
});
test('C5 管理员不受 site 限制', () => {
  const s = mkStore();
  const r = setPriorityCore(s, { project: 'p', id: 'REQ-1' }, '低', admin);
  assert.equal(r.status, 200); assert.equal(s['REQ-1'].priority, '低');
});

/* ================= D. 连真库冒烟（MySQL 起得来才跑，否则整组 skip） ================= */
import { spawn } from 'node:child_process';
let mysql = null, pool = null, MYSQL_UP = false, srv = null;
const PORT = 6400 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'fs04pri-' + Date.now().toString(36);
const MY_SITE = 'FS04Pri现场_' + Date.now().toString(36);
const OTHER_SITE = 'FS04Pri越权_' + Date.now().toString(36);
const FIELD_U = 'fs04pri_' + Date.now().toString(36), FIELD_PW = 'Fs04Pri99', FIELD_NAME = 'FS04Pri实施';
let adminCookie = '', fieldCookie = '', fieldId = '', hlyyBefore = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function req(p, { method = 'GET', body, cookie } = {}) {
  return fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, setCookie: r.headers.get('set-cookie'), json: await r.json().catch(() => null) }));
}

before(async () => {
  try {
    mysql = (await import('mysql2/promise')).default;
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
    pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci', connectTimeout: 2500 });
    await pool.query('SELECT 1');
    MYSQL_UP = true;
  } catch { MYSQL_UP = false; if (pool) { try { await pool.end(); } catch {} pool = null; } return; }
  const [[hb]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']); hlyyBefore = hb.n;
  await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]);
  await pool.query('DELETE FROM projects WHERE id=?', [PID]);
  await pool.query('DELETE FROM accounts WHERE username=?', [FIELD_U]);
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await req('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  adminCookie = (lg.setCookie || '').split(';')[0];
  await req('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS04Pri 冒烟产品', subsystems: [{ key: 'core', name: '审方', desc: '' }] }, cookie: adminCookie });
  const ac = await req('/api/account-save', { method: 'POST', body: { username: FIELD_U, role: 'impl', name: FIELD_NAME, password: FIELD_PW, projects: [PID], sites: [MY_SITE], enabled: 1 }, cookie: adminCookie });
  fieldId = (ac.json?.accounts?.find(a => a.username === FIELD_U) || {}).id || '';
  const flg = await req('/api/login', { method: 'POST', body: { username: FIELD_U, password: FIELD_PW } });
  fieldCookie = (flg.setCookie || '').split(';')[0];
});
after(async () => {
  if (!MYSQL_UP) return;
  try { if (fieldId) await req('/api/account-delete', { method: 'POST', body: { id: fieldId }, cookie: adminCookie }); } catch {}
  try { await req('/api/project-delete', { method: 'POST', body: { id: PID }, cookie: adminCookie }); } catch {}
  try { await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); await pool.query('DELETE FROM projects WHERE id=?', [PID]); await pool.query('DELETE FROM accounts WHERE username=?', [FIELD_U]); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', PID), { recursive: true, force: true }); } catch {}
  try { const [[ha]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']); assert.equal(ha.n, hlyyBefore, 'after：真库 hlyy 基线未污染'); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// 直接用 intake-submit 造两张不同 priority 的单（不依赖真模型 · AI 建单不稳定），验 per-ticket set-priority 落库
test('D1 连真库：造两张单（各自 priority）→ set-priority 改一张，只该张变、库列同步', { skip: !MYSQL_UP ? '本地 MySQL 不可用（ECONNREFUSED），跳过连真库冒烟' : false }, async () => {
  // 造单 A（需求·中）
  const a = await req('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'requirement', site: MY_SITE, subsystem: '审方', title: 'AC32冒烟-需求A', reqDesc: 'x', priority: '中' }, cookie: fieldCookie });
  const idA = a.json?.id; assert.ok(idA, '单A 建成功');
  // 造单 B（BUG·高，需版本）
  const b = await req('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'bug', version: 'v1.0', site: MY_SITE, subsystem: '审方', title: 'AC32冒烟-BUG-B', desc: 'y', steps: 'z', priority: '高' }, cookie: fieldCookie });
  const idB = b.json?.id; assert.ok(idB, '单B 建成功');
  // 初始各自 priority
  const [[ra0]] = await pool.query('SELECT priority FROM intakes WHERE project_id=? AND id=?', [PID, idA]);
  const [[rb0]] = await pool.query('SELECT priority FROM intakes WHERE project_id=? AND id=?', [PID, idB]);
  assert.equal(ra0.priority, '中', '单A 初始中');
  assert.equal(rb0.priority, '高', '单B 初始高');
  // set-priority：只改单A → 紧急
  const sp = await req('/api/intake-set-priority', { method: 'POST', body: { project: PID, id: idA, priority: '紧急' }, cookie: fieldCookie });
  assert.equal(sp.status, 200); assert.equal(sp.json?.priority, '紧急', '响应 priority=紧急');
  const [[ra1]] = await pool.query('SELECT priority FROM intakes WHERE project_id=? AND id=?', [PID, idA]);
  const [[rb1]] = await pool.query('SELECT priority FROM intakes WHERE project_id=? AND id=?', [PID, idB]);
  assert.equal(ra1.priority, '紧急', '单A 库列已改为紧急（per-ticket）');
  assert.equal(rb1.priority, '高', '单B 未受影响（仍高）');
  // 留痕落 data JSON
  const [[dj]] = await pool.query("SELECT JSON_EXTRACT(data,'$.history') h, JSON_EXTRACT(data,'$.priority') p FROM intakes WHERE project_id=? AND id=?", [PID, idA]);
  assert.match(String(dj.h || ''), /调整紧急程度→紧急/, 'history 留痕落 data JSON');
  assert.match(String(dj.p || ''), /紧急/, 'data.priority 同步');
});
test('D2 连真库：非法档回落原值 + consult 拒 + 越权 403', { skip: !MYSQL_UP ? '本地 MySQL 不可用，跳过' : false }, async () => {
  const a = await req('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'requirement', site: MY_SITE, subsystem: '审方', title: 'AC32冒烟-回落', reqDesc: 'x', priority: '低' }, cookie: fieldCookie });
  const id = a.json?.id;
  // 非法档 → 回落原值（低）
  const bad = await req('/api/intake-set-priority', { method: 'POST', body: { project: PID, id, priority: 'P0' }, cookie: fieldCookie });
  assert.equal(bad.status, 200); assert.equal(bad.json?.priority, '低', '非法回落原值低');
  const [[r]] = await pool.query('SELECT priority FROM intakes WHERE project_id=? AND id=?', [PID, id]);
  assert.equal(r.priority, '低', '库列未变');
  // 越权：管理员在 OTHER_SITE 建一张单，现场账号（只 MY_SITE）改它 → 403
  const o = await req('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'requirement', site: OTHER_SITE, subsystem: '审方', title: 'AC32冒烟-越权单', reqDesc: 'x', priority: '中' }, cookie: adminCookie });
  const oid = o.json?.id;
  const deny = await req('/api/intake-set-priority', { method: 'POST', body: { project: PID, id: oid, priority: '紧急' }, cookie: fieldCookie });
  assert.equal(deny.status, 403, '越权 site → 403');
});
