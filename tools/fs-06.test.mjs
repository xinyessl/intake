// FS-06 · 免登录提交链接（访客模式）—— A 前端/常量静态 + B 连真库冒烟（零依赖 node --test）
//   启动真实 server.mjs（连本地 MySQL data/db.json）到隔离随机端口，用 fetch 打真实端点；mysql2 直连真库核对归属列。
//   本条大半是复用（♻️）：生成 /api/submit-link + 校验 linkUserFrom + 访客白名单 LINK_OK + 干净提交页 applyLinkLock 均已落地。
//   本套件价值：把这套已有能力逐条 AC 可回归验证（生成/打开/归属/校验/越权拒/吊销），并核对访客提交归属服务端强制。
//   token 在测内用 data/link-secret 同法自算（signToken/b64u），得以伪造「过期/篡改签名」token 验拒绝分支。
//   ⚠️ AC-F2「换 link-secret 整体吊销」会改 data/link-secret：本套件 before 备份、after 无条件还原，绝不弄坏用户密钥。
//   ⚠️ 端口随机高位（6400+rand(120)）；一起跑必须 node --test --test-concurrency=1；after 清造出的产品/工单 + 核对真库只剩 hlyy。
//   用法：node --test tools/fs-06.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || (6400 + Math.floor(Math.random() * 120));
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'fs06smoke-' + Date.now().toString(36);          // 隔离产品
const LINK_SITE = 'FS06现场医院_' + Date.now().toString(36); // token 预置现场
const LINK_VER = 'v9.9.0';                                   // token 预置版本
const OTHER_PID = 'fs06other-' + Date.now().toString(36);    // 篡改探针：访客改传的另一产品 id
const REL_PID = 'fs06rel-' + Date.now().toString(36);        // KB-02 相关度门槛：隔离产品，塞一条强相关 + 一条弱匹配 KB
const LINK_SECRET_FILE = path.join(ROOT, 'data/link-secret');

let srv = null, adminCookie = '', pool = null, hlyyBefore = 0, secretBackup = null;
const createdIntakeIds = [];   // 本测建的工单 id（after 兜底删）
function track(id) { if (id && !createdIntakeIds.includes(id)) createdIntakeIds.push(id); }

function req(p, { method = 'GET', body, cookie, token, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  if (token) headers.Cookie = (headers.Cookie ? headers.Cookie + '; ' : '') + 'intake_link=' + token;
  return fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined })
    .then(async r => raw
      ? ({ status: r.status, text: await r.text().catch(() => ''), setCookie: r.headers.get('set-cookie'), location: r.headers.get('location') })
      : ({ status: r.status, setCookie: r.headers.get('set-cookie'), location: r.headers.get('location'), json: await r.json().catch(() => null) }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// —— token 自算（与 server.mjs signToken/b64u 一致），用于伪造过期/篡改 token ——
function b64u(x) { return Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function sign(payload, secret) { const p = b64u(JSON.stringify(payload)); return p + '.' + b64u(crypto.createHmac('sha256', secret).update(p).digest()); }
function secretNow() { return fs.readFileSync(LINK_SECRET_FILE, 'utf8').trim(); }
function decodePayload(tok) { const p = String(tok).split('.')[0]; return JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); }

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  // 备份密钥文件（AC-F2 会改它）→ after 无条件还原
  secretBackup = fs.readFileSync(LINK_SECRET_FILE);
  // 真库 hlyy 基线（after 核对不变）
  const [[hb]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']);
  hlyyBefore = hb.n;
  // 预清理残留
  await pool.query('DELETE FROM intakes WHERE project_id IN (?,?,?)', [PID, OTHER_PID, REL_PID]);
  await pool.query('DELETE FROM kb_entries WHERE project_id IN (?,?,?)', [PID, OTHER_PID, REL_PID]);
  await pool.query('DELETE FROM projects WHERE id IN (?,?,?)', [PID, OTHER_PID, REL_PID]);
  // 启动真实服务
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  // 管理员登录
  const lg = await req('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  adminCookie = lg.setCookie.split(';')[0];
  // 造两个隔离产品：目标产品 + 篡改探针另一产品
  // 子系统含一个「英文 name='audit' / 中文 desc='审方'」双键项，供 B-KB 断言 consult kb 事件的 subsystemLabel 解析成中文（用户 2026-07-23 反馈：子系统应显中文 audit→审方）
  const ps = await req('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS06 冒烟产品', subsystems: [{ key: 'core', name: '审方子系统', desc: 'x' }, { key: 's1', name: 'audit', desc: '审方' }] }, cookie: adminCookie });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
  const po = await req('/api/project-save', { method: 'POST', body: { id: OTHER_PID, name: 'FS06 篡改探针产品' }, cookie: adminCookie });
  assert.equal(po.json?.ok, true, '前置：造篡改探针产品应成功');
  // KB-02 相关度门槛：隔离产品（子系统含 audit→审方 / report→报表 双键，供 KB 条目落位 + 展示中文）
  const pr = await req('/api/project-save', { method: 'POST', body: { id: REL_PID, name: 'FS06 相关度门槛产品', subsystems: [{ key: 'a', name: 'audit', desc: '审方' }, { key: 'r', name: 'report', desc: '报表' }] }, cookie: adminCookie });
  assert.equal(pr.json?.ok, true, '前置：造相关度门槛产品应成功');
});

after(async () => {
  try { await req('/api/project-delete', { method: 'POST', body: { id: PID }, cookie: adminCookie }); } catch {}
  try { await req('/api/project-delete', { method: 'POST', body: { id: OTHER_PID }, cookie: adminCookie }); } catch {}
  try { await req('/api/project-delete', { method: 'POST', body: { id: REL_PID }, cookie: adminCookie }); } catch {}
  // project-delete 不级联删 intakes/kb_entries（见 lessons）→ 手动兜底删本测三产品全部工单/经验库 + 主档
  try { if (pool) { await pool.query('DELETE FROM intakes WHERE project_id IN (?,?,?)', [PID, OTHER_PID, REL_PID]); await pool.query('DELETE FROM kb_entries WHERE project_id IN (?,?,?)', [PID, OTHER_PID, REL_PID]); await pool.query('DELETE FROM projects WHERE id IN (?,?,?)', [PID, OTHER_PID, REL_PID]); } } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', PID), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', OTHER_PID), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', REL_PID), { recursive: true, force: true }); } catch {}
  // 删本测往经验库塞的条目文件（data/kb/<pid>.json；FS-06 KB 引用冒烟造的）
  try { fs.rmSync(path.join(ROOT, 'data/kb', PID + '.json'), { force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/kb', OTHER_PID + '.json'), { force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/kb', REL_PID + '.json'), { force: true }); } catch {}
  // 无条件还原密钥文件（AC-F2 可能改过）
  try { if (secretBackup) fs.writeFileSync(LINK_SECRET_FILE, secretBackup); } catch (e) { console.error('还原 link-secret 失败', e); }
  // 核对真库 hlyy 基线未被污染 + 无 fs06 残留产品
  try { const [[ha]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']); assert.equal(ha.n, hlyyBefore, 'after：真库 hlyy 工单数应回到基线（未污染）'); } catch (e) { console.error(e); }
  try { const [rp] = await pool.query("SELECT id FROM projects WHERE id LIKE 'fs06%'"); assert.equal(rp.length, 0, 'after：真库不应残留 fs06* 产品'); } catch (e) { console.error(e); }
  try { const [rk] = await pool.query("SELECT id FROM kb_entries WHERE project_id LIKE 'fs06%'"); assert.equal(rk.length, 0, 'after：真库不应残留 fs06* 经验库条目'); } catch (e) { console.error(e); }
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

/* ================= A. 静态断言（server.mjs 常量 + submit.html 访客锁定） ================= */
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const SUBMIT_HTML = fs.readFileSync(path.join(ROOT, 'public/submit.html'), 'utf8');

test('A-E1 LINK_OK 集合与 §4.3 契约逐项一致（访客可访问的白名单端点）', () => {
  const m = SRC.match(/const LINK_OK = new Set\((\[[^\]]*\])\)/);
  assert.ok(m, '定位 LINK_OK');
  const got = JSON.parse(m[1].replace(/'/g, '"'));
  const want = ['/', '/submit.html', '/api/intake-submit', '/api/intake-chat', '/api/consult', '/api/projects', '/api/customers', '/api/versions', '/api/spec-modules', '/api/model-config'];
  assert.deepEqual([...got].sort(), [...want].sort(), 'LINK_OK 与契约一致');
});

test('A-E2/A6 submit-link 与工单查看类端点均不在 LINK_OK（访客不可生成链接/查列表/查详情/管账号）', () => {
  const m = SRC.match(/const LINK_OK = new Set\((\[[^\]]*\])\)/);
  const got = new Set(JSON.parse(m[1].replace(/'/g, '"')));
  for (const p of ['/api/submit-link', '/api/intake-list', '/api/intake-detail', '/api/intake-transition', '/api/accounts', '/api/account-save']) {
    assert.ok(!got.has(p), `${p} 不在 LINK_OK（deny-by-default 拒绝访客）`);
  }
});

test('A-A1 signToken 结构：payload.hmac，含且仅含一个「.」；自算与 server.mjs 同法可互验', () => {
  const secret = secretNow();
  const payload = { project: PID, site: LINK_SITE, ver: LINK_VER, type: 'bug', exp: Date.now() + 86400000 };
  const tok = sign(payload, secret);
  assert.equal(tok.split('.').length, 2, 'token 含一个「.」（payload.sig 两段）');
  assert.deepEqual(decodePayload(tok), payload, 'payload 段可解回原对象');
});

test('A-D1/D2/F3 verifyToken 语义（自算复现）：过期→拒、篡改签名→拒；linkSecret 24字节 hex', () => {
  const secret = secretNow();
  assert.match(secret, /^[0-9a-f]{48}$/, 'link-secret = 24 字节随机 hex（48 字符）');
  // 篡改签名段：改 sig 最后一位 → HMAC 不匹配
  const good = sign({ project: PID, exp: Date.now() + 86400000 }, secret);
  const [p, sig] = good.split('.');
  const badSig = p + '.' + (sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A'));
  const reSig = b64u(crypto.createHmac('sha256', secret).update(badSig.split('.')[0]).digest());
  assert.notEqual(reSig, badSig.split('.')[1], '篡改签名后重算 HMAC 不匹配（verifyToken 会返回 null）');
  assert.match(SRC, /function verifyToken\(tok\)[\s\S]*?j\.exp && j\.exp < Date\.now\(\)\) \? null/, 'server 端 verifyToken 有 exp 过期判定');
});

test('A-B3 submit.html applyLinkLock：me.link 时锁类型/项目/版本/现场 + 隐藏「我的提交」+ 显示锁定提示', () => {
  assert.match(SUBMIT_HTML, /async function applyLinkLock\(me\)/, '有 applyLinkLock');
  const fn = SUBMIT_HTML.match(/async function applyLinkLock\(me\)\{[\s\S]*?\n\}/)[0];
  assert.match(fn, /me\.ptype==='bug'\|\|me\.ptype==='requirement'\|\|me\.ptype==='consult'/, '① ptype 命中三类之一→锁类型');
  assert.match(fn, /pointerEvents='none'/, '① 类型切换器禁用');
  assert.match(fn, /me\.project[\s\S]*?lockEl\(\$\('#mProject'\)\)/, '② 选中并锁定所属系统');
  assert.match(fn, /me\.ver[\s\S]*?lockEl\(\$\('#mVersion'\)\)/, '③ 锁定版本下拉');
  assert.match(fn, /me\.site[\s\S]*?lockEl\(\$\('#mSite'\)\)/, '④ 锁定现场');
  assert.match(fn, /#lockNote'\)\.classList\.add\('on'\)/, '⑤ 显示链接已锁定提示 #lockNote');
  assert.match(fn, /#mineBtn'\)\.style\.display='none'/, '⑤ 隐藏「我的提交」入口 #mineBtn');
  // 初始化：me.link 为真才调 applyLinkLock（对齐 FS-04 对话提交，仍走 intake-chat/consult）
  assert.match(SUBMIT_HTML, /if\(me\.link\) applyLinkLock\(me\)/, 'me.link 时应用访客锁定');
});

test('A-B4/FS-04 submit.html 是干净提交页：不套后台 shell.js，且用 intake-chat/consult 对话提交', () => {
  assert.doesNotMatch(SUBMIT_HTML, /assets\/shell\.js/, '不引后台 shell.js（无后台外壳）');
  assert.match(SUBMIT_HTML, /\/api\/intake-chat/, '走 intake-chat 对话进件（对齐 FS-04）');
  assert.match(SUBMIT_HTML, /\/api\/consult/, '走 consult 咨询（对齐 FS-04）');
});

/* ================= B. 连真库冒烟 ================= */

test('B-A1/A3 管理员生成链接：返回 {ok,token,path,days}；token 结构 + payload 字段正确', async () => {
  const r = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID, site: LINK_SITE, ver: LINK_VER, type: 'bug', days: 30 } });
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true, '生成成功');
  assert.ok(r.json.token && r.json.token.split('.').length === 2, 'token 含一个「.」');
  assert.equal(r.json.path, '/submit.html?token=' + r.json.token, 'path=/submit.html?token=<token>（相对路径；绝对地址由 FS-08 提供）');
  assert.equal(r.json.days, 30, 'days 回显 30');
  const p = decodePayload(r.json.token);
  assert.equal(p.project, PID, 'payload.project=产品 id');
  assert.equal(p.site, LINK_SITE, 'payload.site');
  assert.equal(p.ver, LINK_VER, 'payload.ver');
  assert.equal(p.type, 'bug', 'payload.type=bug');
  const wantExp = Date.now() + 30 * 86400000;
  assert.ok(Math.abs(p.exp - wantExp) < 60000, 'payload.exp≈now+30天');
});

test('B-A1 days 缺省 → 365', async () => {
  const r = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID } });
  assert.equal(r.json?.days, 365, 'days 缺省 365');
});

test('B-A2 产品不存在 → 400 {ok:false,"项目不存在"}，不签发 token（真实实现返 400，非 spec 早稿写的 200）', async () => {
  const r = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: '__不存在的产品__' } });
  assert.equal(r.status, 400, 'projById 为空 → 400（真实 server.mjs L678）');
  assert.equal(r.json?.ok, false, 'ok:false');
  assert.equal(r.json?.error, '项目不存在', 'error=项目不存在');
  assert.ok(!r.json.token, '不返回 token');
});

test('B-A4 days 夹取到 [1,3650]：0→365、-5→1、9999→3650', async () => {
  const r0 = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID, days: 0 } });
  assert.equal(r0.json?.days, 365, 'days=0 → 夹为默认 365（+0||365）');
  const rn = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID, days: -5 } });
  assert.equal(rn.json?.days, 1, 'days=-5 → Math.max(1,-5)=1');
  const rb = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID, days: 9999 } });
  assert.equal(rb.json?.days, 3650, 'days=9999 → Math.min(3650,..)=3650');
});

test('B-A5 type 非 bug|requirement|consult（如「任意」/缺省）→ payload.type=空串（不锁类型）', async () => {
  const r = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID, type: '任意' } });
  assert.equal(decodePayload(r.json.token).type, '', 'type 非法 → 空串');
  const r2 = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID } });
  assert.equal(decodePayload(r2.json.token).type, '', 'type 缺省 → 空串');
  const r3 = await req('/api/submit-link', { method: 'POST', cookie: adminCookie, body: { project: PID, type: 'requirement' } });
  assert.equal(decodePayload(r3.json.token).type, 'requirement', 'type=requirement 合法保留');
});

test('B-A6 非管理员/访客调 submit-link → 403（不在 LINK_OK/FIELD_OK，deny-by-default）', async () => {
  // 访客（带有效 token）调 submit-link → 403
  const tok = sign({ project: PID, site: LINK_SITE, ver: LINK_VER, type: '', exp: Date.now() + 86400000 }, secretNow());
  const r = await req('/api/submit-link', { method: 'POST', token: tok, body: { project: PID } });
  assert.equal(r.status, 403, '访客调 submit-link → 403');
  assert.equal(r.json?.error, 'forbidden', 'error=forbidden');
});

// —— 有效访客 token（贯穿 B 后续用例）——
function guestToken(over = {}) {
  return sign({ project: PID, site: LINK_SITE, ver: LINK_VER, type: '', exp: Date.now() + 86400000, ...over }, secretNow());
}

test('B-B1 有效 token GET /submit.html?token= → 200 + Set-Cookie intake_link（HttpOnly/SameSite=Lax/Path=/）', async () => {
  const tok = guestToken();
  const r = await req('/submit.html?token=' + tok, { raw: true });
  assert.equal(r.status, 200, '放行提交页 HTML');
  assert.ok(r.text.includes('applyLinkLock'), '返回的是 submit.html');
  assert.ok(r.setCookie && r.setCookie.includes('intake_link=' + tok), 'Set-Cookie 写入 intake_link=<token>');
  assert.match(r.setCookie, /HttpOnly/, 'HttpOnly');
  assert.match(r.setCookie, /SameSite=Lax/, 'SameSite=Lax');
  assert.match(r.setCookie, /Path=\//, 'Path=/');
  assert.match(r.setCookie, /Max-Age=31536000/, 'Max-Age=365 天');
});

test('B-B2 GET /api/me 带 token → {me:{role:link,link:true,name,project,site,ver,ptype}}', async () => {
  const tok = guestToken({ type: 'bug' });
  const r = await req('/api/me', { token: tok });
  assert.equal(r.status, 200);
  const me = r.json?.me;
  assert.ok(me, '返回 me');
  assert.equal(me.role, 'link', 'role=link');
  assert.equal(me.link, true, 'link=true');
  assert.equal(me.project, PID, 'project=预置产品');
  assert.equal(me.site, LINK_SITE, 'site=预置现场');
  assert.equal(me.ver, LINK_VER, 'ver=预置版本');
  assert.equal(me.ptype, 'bug', 'ptype=预置类型');
  assert.equal(me.name, LINK_SITE, 'name=site（link.site||"现场"）');
});

test('B-C2/C4 访客 intake-submit：project 强制=link.project（前端篡改 project 被忽略）+ site/version/reporter/byRole 取 link', async () => {
  const tok = guestToken();
  // 前端篡改：传另一产品 id，且传空 site/version（应回退 link 值）
  const r = await req('/api/intake-submit', { method: 'POST', token: tok, body: { project: OTHER_PID, type: 'requirement', title: 'FS06访客需求', desc: '访客提交测试' } });
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true, '访客建单成功');
  track(r.json.id);
  const [rows] = await pool.query('SELECT project_id,site,version,reporter,data FROM intakes WHERE id=?', [r.json.id]);
  assert.equal(rows.length, 1, '落库一条');
  const row = rows[0], d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  assert.equal(row.project_id, PID, '★ project_id 强制=link.project（篡改的 OTHER_PID 被忽略）');
  assert.notEqual(row.project_id, OTHER_PID, '★ 绝不串到访客传的其它产品');
  assert.equal(row.site, LINK_SITE, 'site 回退 link.site');
  assert.equal(row.version, LINK_VER, 'version 回退 link.ver');
  assert.equal(row.reporter, LINK_SITE, 'reporter=link.name（=site）');
  assert.equal(d.history?.[0]?.byRole, 'field', 'history[0].byRole=field');
  // 篡改产品下不应有任何工单
  const [oth] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', [OTHER_PID]);
  assert.equal(oth[0].n, 0, '★ 篡改探针产品 OTHER_PID 下无任何工单');
});

test('B-C3/C4 访客 consult：project 强制=link.project（篡改被忽略）+ type=consult + reporter/role', async () => {
  const tok = guestToken();
  const resp = await fetch(BASE + '/api/consult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: 'intake_link=' + tok },
    body: JSON.stringify({ project: OTHER_PID, messages: [{ role: 'user', content: '审方白名单怎么配？' }] }),   // 篡改 project
  });
  assert.equal(resp.status, 200, 'consult 200（SSE）');
  const textBody = await resp.text();
  let convId = '';
  textBody.split('\n').forEach(l => { l = l.trim(); if (l.indexOf('data:') !== 0) return; let o = null; try { o = JSON.parse(l.slice(5).trim()); } catch { return; } if (o && o.done) convId = o.convId || ''; });
  assert.ok(convId, 'done 返回 convId');
  track(convId);
  const [rows] = await pool.query('SELECT project_id,type,site,version,reporter,data FROM intakes WHERE id=?', [convId]);
  assert.equal(rows.length, 1, 'consult 落库一条');
  const row = rows[0], d = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  assert.equal(row.project_id, PID, '★ consult project_id 强制=link.project（篡改的 OTHER_PID 被忽略）');
  assert.equal(row.type, 'consult', 'type=consult');
  assert.equal(row.site, LINK_SITE, 'site 回退 link.site');
  assert.equal(row.version, LINK_VER, 'version 回退 link.ver');
  assert.equal(row.reporter, LINK_SITE, 'reporter=link.name');
  assert.equal(d.role, 'field', 'role=field');
  const [oth] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', [OTHER_PID]);
  assert.equal(oth[0].n, 0, '★ 篡改探针产品下无 consult');
});

/* ---- FS-06 引用可见：命中且模型实际开始答复时 consult SSE 回传 kb 事件，答复内展示「已参考经验(N条)」 ----
   造隔离产品 + 往其经验库塞一条 q/a（走 kb-save，落 DB+文件+CACHE，供 kbSearch 命中）→ 调 consult 带能命中该 KB 的 query
   → 断言 SSE 流里出现 kb 事件且含塞入那条（q 匹配）。无命中分支：query 不匹配任何 KB → 断言不发 kb（或 kb 空）。
   after 钩子已加 kb_entries + data/kb/<pid>.json 清理 + 残留断言。 */
const KB_TOKEN = 'zx88931port';                                   // 稀有 alphanumeric token（kbTokenize 收 len>1 英文词）；q/query 都含它→保证命中且几乎不撞真实 KB
const KB_Q = 'FS06冒烟：' + KB_TOKEN + ' 端口连不上怎么处理';       // 塞入经验库的「问」
const KB_A = '把 ' + KB_TOKEN + ' 端口白名单加进 **网关配置**，重启后即可连通。\n\n步骤：\n- 打开配置\n- 加白名单';   // 「答」含 markdown（前端用 md() 渲染）

// 读一次 consult SSE 全流，收集所有解析出的事件对象
async function consultEvents(body, cookie) {
  const resp = await fetch(BASE + '/api/consult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  const text = await resp.text();
  const evs = [];
  text.split('\n').forEach(l => { l = l.trim(); if (l.indexOf('data:') !== 0) return; let o = null; try { o = JSON.parse(l.slice(5).trim()); } catch { return; } if (o) evs.push(o); });
  return { status: resp.status, evs };
}

test('B-KB1 往隔离产品经验库塞一条（kb-save 落 DB+CACHE，供 consult 命中）', async () => {
  const r = await req('/api/kb-save', { method: 'POST', cookie: adminCookie, body: { project: PID, q: KB_Q, a: KB_A, subsystem: 'audit', module: '网关' } });   // subsystem 存英文 name 'audit'（模拟真库），consult kb 事件应回 subsystemLabel='审方'（中文 desc）
  assert.equal(r.status, 200, 'kb-save 200');
  assert.equal(r.json?.ok, true, 'ok:true');
  // DB 落一条（kb_entries）
  const [rows] = await pool.query('SELECT q,a FROM kb_entries WHERE project_id=?', [PID]);
  assert.equal(rows.length, 1, 'kb_entries 落库一条');
  assert.ok(rows[0].q.includes(KB_TOKEN), '库里的问含种子 token');
});

test('B-KB2 命中且模型实际开始答复 → consult SSE 回传 kbInjected 引用；首 token 前失败则不误报', async () => {
  const { status, evs } = await consultEvents({
    project: PID, messages: [{ role: 'user', content: KB_TOKEN + ' 端口连不上，怎么处理？' }],
  }, adminCookie);
  assert.equal(status, 200, 'consult 200（SSE）');
  const kbEv = evs.find(o => Array.isArray(o.kb));
  const done = evs.find(o => o.done);
  if (!kbEv) {
    assert.equal(done?.kbHits || 0, 0, '未配模型/首 token 前失败时不展示引用且计数为 0');
    if (done && done.convId) track(done.convId);
    return;
  }
  assert.ok(kbEv, '★ SSE 流里出现 kb 事件（{kb:[...]}）');
  assert.equal(kbEv.kbInjected, true, '引用事件明确声明已注入本次模型请求');
  assert.ok(kbEv.kb.length >= 1, 'kb 至少一条');
  const hit = kbEv.kb.find(h => String(h.q || '').includes(KB_TOKEN));
  assert.ok(hit, '★ kb 含塞入那条（q 匹配种子 token）');
  assert.ok(String(hit.a || '').includes(KB_TOKEN), 'kb 条目带真实答（a）');
  assert.equal(hit.subsystem, 'audit', 'kb 条目带原 subsystem（英文 name，未被覆盖）');
  assert.equal(hit.subsystemLabel, '审方', '★ kb 事件带 subsystemLabel（英文 audit → 中文 desc「审方」，供答复引用区显中文）');
  assert.equal(hit.module, '网关', 'kb 条目带 module');
  // kb 事件应在流式答复(v)/done 之前（前端先占位渲染引用区）
  const iKb = evs.findIndex(o => Array.isArray(o.kb));
  const iDone = evs.findIndex(o => o.done);
  if (iDone >= 0) assert.ok(iKb >= 0 && iKb < iDone, 'kb 事件先于 done');
  // done 仍带 kbHits（旧契约保留，向后兼容）
  assert.ok(done && done.kbHits >= 1, 'done.kbHits>=1（旧计数契约保留）');
  // 落库的 consult 会话清理
  if (done && done.convId) track(done.convId);
});

test('B-KB3 无命中经验库 → 不发 kb 事件（query 与任何 KB 都不重叠）', async () => {
  const { status, evs } = await consultEvents({
    project: PID, messages: [{ role: 'user', content: 'zzqqxxnomatch99 完全不相干的问题abcdxyz' }],
  }, adminCookie);
  assert.equal(status, 200, 'consult 200（SSE）');
  const kbEv = evs.find(o => Array.isArray(o.kb) && o.kb.length);
  assert.ok(!kbEv, '★ 无命中 → 不发非空 kb 事件');
  const done = evs.find(o => o.done);
  assert.ok(!done || !done.kbHits, 'done.kbHits=0/缺省（无命中）');
  if (done && done.convId) track(done.convId);
});

/* ---- 静态断言：field.html 渲染 kb 引用区 + 解析 kb 事件 + server.mjs 回传/无命中措辞 ---- */
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

test('B-KB4 field.html 含「已参考经验」引用区，并只解析 kbInjected=true 的 SSE 事件', () => {
  assert.match(FIELD_HTML, /\.f-kb-cite\b/, '含 .f-kb-cite 样式类');
  assert.match(FIELD_HTML, /f-kb-cite-item/, '含 .f-kb-cite-item 条目类');
  assert.match(FIELD_HTML, /已参考经验（/, '渲染准确的「已参考经验」标题');
  assert.match(FIELD_HTML, /function renderKbCite\s*\(/, '有 renderKbCite 渲染函数');
  assert.match(FIELD_HTML, /o && o\.kbInjected === true \? normalizeKbRefs\(o\.kb\) : \[\]/, '只有 kbInjected=true 才接受引用');
  assert.match(FIELD_HTML, /md\(String\(h\.a/, 'KB 答案用 md() 渲染（含 markdown）');
  // 子系统显中文：引用区 meta 用 subsystemLabel（中文 desc）优先，回退 subsystem（英文 name）
  const rcBody = (FIELD_HTML.match(/function renderKbCite\(bub, kb\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(rcBody, /h\.subsystemLabel \|\| h\.subsystem/, '引用区子系统用 subsystemLabel（中文）优先，回退 subsystem（英文）');
});

test('B-KB5 server.mjs：命中回传精简 kb 字段 + 无命中不谎称经验库', () => {
  assert.match(SRC, /if \(!kbInjected && kbRefs\.length\) \{ kbInjected = true; sse\(\{ kb: kbRefs, kbInjected: true \}\); \}/, '首个模型片段内才发已注入引用事件');
  assert.match(SRC, /function consultKbRefs\(projId, hits\)/, 'kb 字段经服务端统一精简并供 SSE/历史持久化共用');
  assert.match(SRC, /subsystemLabel: kbSubLabel\(projId, h && h\.subsystem\)/, '引用带 subsystemLabel（英文 name → 中文 desc）');
  assert.match(SRC, /kbHits: kbInjected \? kbRefs\.length : 0/, 'done 计数按真实注入门控');
  assert.match(SRC, /本次未检索到相关经验库条目/, '无命中：提示不声称根据经验库');
  assert.match(SRC, /不要声称「根据历史经验库/, '无命中：明确禁止谎称「根据历史经验库」');
});

/* ---- KB-02 相关度门槛：consult 的经验库命中按 minScore=2 过滤弱匹配（弱匹配既不注入也不发 kb 事件，不展示）----
   隔离产品 REL_PID 塞两条 KB：一条与问题「强相关」（共享多个 query token），一条只共享 1 个常见词（弱匹配）。
   ① 问一个强相关到 STRONG、只蹭到 WEAK 一个词的问题 → kb 事件只含 STRONG、不含 WEAK（minScore=2 生效）。
   ② 问一个与两条都强相关的问题 → 两条都在（门槛不误伤真相关）。
   种子用稀有 alphanumeric token 保证隔离；after 已按 REL_PID 精确清理 kb_entries/data-kb/主档。 */
const REL_TOK = 'zx88931task';                                     // 稀有 token：强相关条目 + 问题都含它，弱匹配条目不含
const REL_STRONG_Q = 'FS06相关度：审方规则大于5级' + REL_TOK + '药师没拿到任务怎么办';   // 强相关「问」（含 REL_TOK + 多个中文 bigram 与问题重叠）
const REL_STRONG_A = '因为' + REL_TOK + '审方规则配置了大于5级药师才分派，需调整规则后重试。';   // 强相关「答」
const REL_WEAK_Q = 'FS06相关度：药师排班表怎么导出到excel';         // 弱匹配「问」：只与问题共享「药师」一个 bigram
const REL_WEAK_A = '在报表页选药师排班，点导出按钮即可生成 excel。';   // 弱匹配「答」

test('B-KB-REL0 往相关度产品塞两条 KB（一条强相关 + 一条只共享 1 个常见词的弱匹配）', async () => {
  const r1 = await req('/api/kb-save', { method: 'POST', cookie: adminCookie, body: { project: REL_PID, q: REL_STRONG_Q, a: REL_STRONG_A, subsystem: 'audit', module: '任务分派' } });
  assert.equal(r1.json?.ok, true, '强相关条目 kb-save ok');
  const r2 = await req('/api/kb-save', { method: 'POST', cookie: adminCookie, body: { project: REL_PID, q: REL_WEAK_Q, a: REL_WEAK_A, subsystem: 'report', module: '报表' } });
  assert.equal(r2.json?.ok, true, '弱匹配条目 kb-save ok');
  const [rows] = await pool.query('SELECT q FROM kb_entries WHERE project_id=?', [REL_PID]);
  assert.equal(rows.length, 2, 'kb_entries 落库两条');
});

test('B-KB-REL1 连真库：问强相关问题 → kb 事件只含强相关那条、不含弱匹配（minScore=2 过滤单常见词弱匹配）', async () => {
  const { status, evs } = await consultEvents({
    project: REL_PID, subsystem: 'audit',
    messages: [{ role: 'user', content: '审方规则大于5级药师没拿到任务' + REL_TOK }],   // STRONG=14、WEAK=1（只蹭到「药师」）
  }, adminCookie);
  assert.equal(status, 200, 'consult 200（SSE）');
  const kbEv = evs.find(o => Array.isArray(o.kb));
  const done = evs.find(o => o.done);
  if (!kbEv) { assert.equal(done?.kbHits || 0, 0, '未配模型/首 token 前失败时不误报引用'); if (done?.convId) track(done.convId); return; }
  assert.equal(kbEv.kbInjected, true, 'SSE 引用为模型已实际开始使用');
  const qs = kbEv.kb.map(h => String(h.q || ''));
  assert.ok(qs.some(q => q.includes(REL_TOK)), '★ 强相关那条在（含 REL_TOK）');
  assert.ok(!qs.some(q => q.includes('排班表')), '★ 弱匹配那条不在（sc=1 被 minScore=2 过滤，不注入不展示）');
  assert.equal(done.kbHits, 1, '★ done.kbHits=1（只强相关一条命中，弱匹配未计入）');
  if (done && done.convId) track(done.convId);   // REL_PID 的 consult 会话 after 按 project_id 兜底清
});

test('B-KB-REL2 连真库：问与两条都强相关的问题 → 两条都在（门槛不误伤真相关）', async () => {
  const { status, evs } = await consultEvents({
    project: REL_PID, subsystem: 'audit',
    messages: [{ role: 'user', content: '审方规则' + REL_TOK + '药师没拿到任务，另外药师排班表怎么导出到excel' }],   // STRONG=11、WEAK=10（对两条都多 token 命中）
  }, adminCookie);
  assert.equal(status, 200, 'consult 200（SSE）');
  const kbEv = evs.find(o => Array.isArray(o.kb));
  const done = evs.find(o => o.done);
  if (!kbEv) { assert.equal(done?.kbHits || 0, 0, '未配模型/首 token 前失败时不误报引用'); if (done?.convId) track(done.convId); return; }
  assert.equal(kbEv.kbInjected, true, 'SSE 引用为模型已实际开始使用');
  const qs = kbEv.kb.map(h => String(h.q || ''));
  assert.ok(qs.some(q => q.includes(REL_TOK)), '★ 强相关那条在');
  assert.ok(qs.some(q => q.includes('排班表')), '★ 弱匹配那条这次也在（因 query 对它也多 token 命中 sc>=2，门槛不误伤真相关）');
  assert.equal(done.kbHits, 2, '★ done.kbHits=2（两条都强相关命中）');
  if (done && done.convId) track(done.convId);   // REL_PID 的 consult 会话 after 按 project_id 兜底清
});

test('B-KB-REL3 逻辑层：kbSearch(minScore=2) 过滤 sc=1、minScore=1（drawer 默认）不过滤（回归护栏）', () => {
  // 复刻 server.mjs kbSearch 的打分/门槛逻辑（同口径 kbTokenize），验 minScore 语义；drawer /api/kb-search 与其它调用方走默认 minScore=1，行为不变。
  function kbTokenize(s) { s = String(s || '').toLowerCase(); const out = []; const cjk = s.match(/[一-鿿]/g) || []; for (let i = 0; i < cjk.length - 1; i++) out.push(cjk[i] + cjk[i + 1]); (s.match(/[a-z0-9]+/g) || []).forEach(w => { if (w.length > 1) out.push(w); }); return out; }
  function kbSearch(entries, query, n, minScore) {
    const q = new Set(kbTokenize(query)); if (!q.size) return [];
    const lo = Math.max(1, minScore | 0);
    return entries.map(e => { const toks = kbTokenize([e.q, e.a, e.subsystem, e.module, (e.tags || []).join(' ')].join(' ')); let sc = 0; const seen = new Set(); for (const t of toks) if (q.has(t) && !seen.has(t)) { sc++; seen.add(t); } return { e, sc }; })
      .filter(x => x.sc >= lo).sort((a, b) => b.sc - a.sc).slice(0, n).map(x => x.e);
  }
  const entries = [
    { q: REL_STRONG_Q, a: REL_STRONG_A, subsystem: 'audit', module: '任务分派', tags: [] },
    { q: REL_WEAK_Q, a: REL_WEAK_A, subsystem: 'report', module: '报表', tags: [] },
  ];
  const query = '审方规则大于5级药师没拿到任务' + REL_TOK;   // 对 STRONG 多 token 命中，对 WEAK 只命中「药师」1 token
  const def = kbSearch(entries, query, 5, 1);                 // drawer 默认门槛（不过滤弱匹配）
  assert.equal(def.length, 2, '★ minScore=1（drawer 默认）：sc=1 弱匹配保留（其它调用方行为不变）');
  const strict = kbSearch(entries, query, 5, 2);              // consult 门槛（过滤弱匹配）
  assert.equal(strict.length, 1, '★ minScore=2（consult）：sc=1 弱匹配被过滤');
  assert.ok(String(strict[0].q).includes(REL_TOK), '保留的是强相关那条');
});

test('B-KB-REL4 server.mjs：consult 走 kbRetrieveScored 语义混合召回并显式收紧 minScore=2（未配 embedding 时退回关键词 minScore=2，等价旧 kbSearch 门槛）', () => {
  // PD-03：consult 改用带分变体 kbRetrieveScored（同 kbRetrieve 召回口径，额外带 score 供检索诊断），hits 由 .map(x=>x.e) 派生；仍传 minScore=2（收紧关键词弱匹配门槛）
  assert.match(SRC, /kbScored = await kbRetrieveScored\(proj\.id, qtext, 5, 2\); hits = kbScored\.map\(x => x\.e\)/, '★ consult 调用 kbRetrieveScored 传 minScore=2、hits 由 .e 派生（语义混合 + 关键词门槛收紧）');
  // kbRetrieveScored 复用 _kbScored/同 minScore/同排序/同 slice（与 kbRetrieve 召回口径一致），额外透出 score
  assert.match(SRC, /async function kbRetrieveScored\(projId, query, n = 5, minScore = 1\)/, '★ kbRetrieveScored 默认 minScore=1（同 kbRetrieve 历史门槛）');
  // kbRetrieve/_kbScored 签名带 minScore（关键词门槛沿用），默认 1（保留兼容）
  assert.match(SRC, /async function kbRetrieve\(projId, query, n = 5, minScore = 1\)/, '★ kbRetrieve 默认 minScore=1（历史行为，保留）');
  assert.match(SRC, /function _kbScored\(projId, query, qtok, qv, minScore = 1\)/, '_kbScored 带 minScore 作关键词门槛');
  // kbSearch 签名仍带 minScore 默认 1（保留、未删）
  assert.match(SRC, /function kbSearch\(projId, query, n = 5, minScore = 1\)/, 'kbSearch 默认 minScore=1（保留兼容）');
  // 收紧到 minScore=2 的检索恰是「consult 口径」的两处：consult 答题（L2839）+ PD-03 retrieval-replay 回放（刻意复刻 consult 检索口径做对比）。
  //   kb-search 跨产品用 _kbScored(...,1) 默认门槛不受影响；此断言防「别处 KB 检索误改门槛」。
  const retrCalls = [...SRC.matchAll(/kbRetrieveScored?\(([^)]*)\)/g)].map(m => m[0]).filter(s => !/function kbRetrieveScored?/.test(s));
  const withMin2 = retrCalls.filter(s => /,\s*2\s*\)/.test(s));
  assert.equal(withMin2.length, 2, '★ 仅「consult 口径」两处 kbRetrieveScored 传 minScore=2（consult 答题 + retrieval-replay 回放），其它检索默认门槛不受影响');
  // 两处都是带分变体（回放复刻 consult 口径）
  assert.ok(withMin2.every(s => /kbRetrieveScored/.test(s)), '两处 minScore=2 均为 kbRetrieveScored');
});

/* ---- KB-02 · 前端「正在思考中…」等待期动效（field.html）：AI 气泡在首个 token 前显动效，首个 o.v 到达即清 ---- */
test('B-THINK1 field.html 含「正在思考中…」思考动效（.f-thinking + 三点 keyframes + setThinking 开关）', () => {
  // 动效元素/类 + 文案
  assert.match(FIELD_HTML, /\.f-thinking\b/, '含 .f-thinking 动效类');
  assert.match(FIELD_HTML, /正在思考中…/, '含「正在思考中…」文案');
  // 纯 CSS 三点跳动 @keyframes
  assert.match(FIELD_HTML, /@keyframes fThink\b/, '含三点跳动 @keyframes fThink');
  assert.match(FIELD_HTML, /\.f-thinking .dots i\s*\{[^}]*animation:\s*fThink/, '三点复用 fThink 动画');
  // setThinking 开关函数（on 挂动效 / off 清动效，幂等）
  const stBody = (FIELD_HTML.match(/function setThinking\(bub, on\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(stBody, '有 setThinking 函数');
  assert.match(stBody, /classList\.add\('thinking'\)/, 'on 时气泡加 .thinking');
  assert.match(stBody, /正在思考中…/, 'on 时占位为「正在思考中…」动效');
  assert.match(stBody, /classList\.remove\('thinking'\)/, 'off 时去 .thinking');
  assert.match(stBody, /bub\._thinking/, '用 bub._thinking 标记幂等');
});

test('B-THINK2 field.html：sendConsult 建气泡即挂动效，首个 o.v 到达清除，done/停止/错误兜底清除', () => {
  const scBody = (FIELD_HTML.match(/function sendConsult\(imgs\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(scBody, '截取 sendConsult 函数体');
  assert.match(scBody, /setThinking\(bub, true\)/, '★ sendConsult 建气泡后挂思考动效');
  // 流式路径：首个 o.v 到达先清动效再逐字渲染
  assert.match(scBody, /if \(o\.v != null\) \{ setThinking\(bub, false\);/, '★ 首个 o.v 到达 → setThinking(bub,false) 清动效，转逐字渲染');
  // done/停止/错误兜底：finishConsult 清动效
  const fcBody = (FIELD_HTML.match(/function finishConsult\(bub, acc, aborted, kbRefs\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(fcBody, /setThinking\(bub, false\)/, '★ finishConsult（done/停止/错误）兜底清思考动效');
  // 退化整体读取路径（onConsultEvent）也清
  const oceBody = (FIELD_HTML.match(/function onConsultEvent\([^)]*\) \{[\s\S]*?\n  \}/) || [''])[0];
  assert.match(oceBody || FIELD_HTML, /if \(o\.v != null\) \{ setThinking\(bub, false\);/, '退化路径 onConsultEvent 首个 o.v 也清动效');
});

test('B-THINK3 field.html：intake（提需求/报BUG）等待期空气泡也用同款动效（回复到达即清）', () => {
  const siBody = (FIELD_HTML.match(/function sendIntake\(imgs\)[\s\S]*?\n  \}\);\n  \}/) || FIELD_HTML.match(/function sendIntake\(imgs\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(siBody, /setThinking\(thinking, true\)/, '★ intake 等待期也挂思考动效（覆盖 intake-chat 等待期空气泡）');
  assert.match(siBody, /setThinking\(thinking, false\)/, '★ intake 回复到达/网络异常时清思考动效');
});

/* ================= B-DEEP · 「深入思考」开关（FS-06 AC-C10）=================
   前端：field.html 加「深入思考」开关（仅 consult 显示 · chat.deep 状态 · 点击切换 · sendConsult 传 deep · 快照/草稿含 deep）。
   后端已支持（server.mjs L1128 `const codeHits = b.deep ? codeSearch(...) : null`）——本套件不改 server.mjs，只验前端 + deep 参数被接受、SSE 正常出流、落库 type=consult。 */

test('A-DEEP1 field.html 静态：含「深入思考」开关（文案 + .f-deep 元素/样式 + 仅 consult 显隐 + chat.deep 状态）', () => {
  // 开关 UI：文案 + 元素 + 样式类 + hint（title）
  assert.match(FIELD_HTML, /深入思考/, '含「深入思考」文案');
  assert.match(FIELD_HTML, /id="fDeep"/, '含开关元素 #fDeep');
  assert.match(FIELD_HTML, /class="f-deep"/, '开关用 .f-deep 类');
  assert.match(FIELD_HTML, /\.f-deep\s*\{/, '含 .f-deep 样式');
  assert.match(FIELD_HTML, /\.f-deep\.on\b/, '开态高亮样式 .f-deep.on');
  assert.match(FIELD_HTML, /\.f-deep\.hide\b/, '隐藏样式 .f-deep.hide（非 consult 模式隐藏）');
  // 2026-07-24 问题①：on 态要明显（实心主色底 + 白字），一眼可辨开关是否开启
  const deepOnRule = (FIELD_HTML.match(/\.f-deep\.on \{[^}]*\}/) || [''])[0];
  assert.ok(deepOnRule, '能截取 .f-deep.on 规则');
  assert.match(deepOnRule, /background:\s*var\(--color-primary\)/, '★ .f-deep.on 实心主色底（明显已开启态）');
  assert.match(deepOnRule, /color:\s*#fff/, '★ .f-deep.on 白字（与 off 态中性描边拉开对比）');
  // 开关放在咨询提交区（f-rtool 工具条内，靠近 f-toggle）
  assert.match(FIELD_HTML, /id="fToggle"[\s\S]{0,400}id="fDeep"/, '开关紧邻类型切换器 f-toggle（同在 f-rtool 工具条）');
  // chat.deep 状态（默认 false）
  assert.match(FIELD_HTML, /deep:\s*false/, 'chat 初始 deep:false（默认关）');
  // 显隐：仅 consult 可见（syncDeep 按 submitKind 显隐）
  const sdBody = (FIELD_HTML.match(/function syncDeep\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(sdBody, '能截取 syncDeep 函数体');
  assert.match(sdBody, /chat\.submitKind === 'consult'/, '★ syncDeep 仅 consult 显示（提需求/报BUG 隐藏）');
  assert.match(sdBody, /classList\.toggle\('hide',\s*!show\)/, 'syncDeep 非 consult 隐藏开关');
  assert.match(sdBody, /classList\.toggle\('on',\s*show && !!chat\.deep\)/, 'syncDeep 据 chat.deep 高亮');
  // setSubmitKind 里调 syncDeep（切 consult/intake 同步显隐）
  const sskBody = (FIELD_HTML.match(/function setSubmitKind\(k\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(sskBody, /syncDeep\(\)/, '★ setSubmitKind 调 syncDeep（切模式同步开关显隐）');
});

test('A-DEEP2 field.html 静态：点击开关切换 chat.deep（仅 consult 生效）', () => {
  const tdBody = (FIELD_HTML.match(/function toggleDeep\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(tdBody, '能截取 toggleDeep 函数体');
  assert.match(tdBody, /chat\.submitKind !== 'consult'\)\s*return/, '★ toggleDeep 非 consult 不响应');
  assert.match(tdBody, /chat\.deep = !chat\.deep/, 'toggleDeep 翻转 chat.deep');
  assert.match(tdBody, /syncDeep\(\)/, 'toggleDeep 刷新按钮态');
  assert.match(tdBody, /saveDraft\(\)/, 'toggleDeep 存草稿（刷新恢复）');
  // 点击绑定
  assert.match(FIELD_HTML, /\$\('fDeep'\)[\s\S]{0,120}addEventListener\('click',\s*toggleDeep\)/, '★ #fDeep 绑 click → toggleDeep');
});

test('A-DEEP3 field.html 静态：sendConsult 发送体含 deep（仅咨询路径）', () => {
  const scBody = (FIELD_HTML.match(/function sendConsult\(imgs\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(scBody, '能截取 sendConsult 函数体');
  assert.match(scBody, /deep:\s*!!chat\.deep/, '★ sendConsult payload 含 deep: !!chat.deep');
  // intake 路径（sendIntake）不带 deep（intake-chat 无 deep 语义）
  const siBody = (FIELD_HTML.match(/function sendIntake\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.doesNotMatch(siBody, /deep:/, '★ sendIntake（提需求/报BUG）不带 deep（intake 无 deep 语义）');
});

test('A-DEEP4 field.html 静态：deep 纳入 per-system 快照/恢复 + 草稿存取；新对话重置为关', () => {
  // 快照含 deep
  const snapBody = (FIELD_HTML.match(/function snapshotConversation\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(snapBody, /deep:\s*!!chat\.deep/, '★ snapshotConversation 含 deep（每系统会话各记各的）');
  // 恢复含 deep
  const restBody = (FIELD_HTML.match(/function restoreConversation\(snap\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(restBody, /chat\.deep = !!snap\.deep/, '★ restoreConversation 恢复 deep');
  // 草稿存取含 deep
  assert.match(FIELD_HTML, /deep:\s*!!chat\.deep,\s*input:/, '★ saveDraft 存 deep');
  assert.match(FIELD_HTML, /chat\.deep = !!d\.deep/, '★ restoreDraft 恢复 deep');
  // 新对话重置 deep=false
  const ncBody = (FIELD_HTML.match(/function newConversation\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(ncBody, /chat\.deep = false/, '★ newConversation 重置 deep=false（新会话默认关）');
});

test('A-DEEP5 server.mjs：b.deep 为真才检索源码注入（后端已支持，本条不改 server）', () => {
  assert.match(SRC, /const codeHits = b\.deep \? codeSearch\(/, '★ server.mjs：b.deep 时才 codeSearch 检索源码（后端已支持）');
  assert.match(SRC, /consultSystem\(proj,[\s\S]*?,\s*codeHits\)/, 'consultSystem 收 codeHits（deep 分支：源码片段注入系统提示）');
});

test('B-DEEP-C1 连真库：consult 带 deep:true → 端点接受、SSE 正常出流、落库 type=consult', async () => {
  const { status, evs } = await consultEvents({
    project: PID, subsystem: 'audit', deep: true,
    messages: [{ role: 'user', content: '审方白名单的判定逻辑是怎么实现的？' }],
  }, adminCookie);
  assert.equal(status, 200, '★ consult 带 deep:true → 200（端点接受 deep 参数）');
  const done = evs.find(o => o.done);
  assert.ok(done, '★ SSE 正常出流：有 done 事件（本地无 clone 源码仓时 codeSearch 少/空，consult 仍正常答）');
  assert.ok(done.convId, 'done 带 convId');
  track(done.convId);
  // 落库核对：type=consult、归属正确
  const [rows] = await pool.query('SELECT project_id,type FROM intakes WHERE id=?', [done.convId]);
  assert.equal(rows.length, 1, 'deep 咨询落库一条');
  assert.equal(rows[0].project_id, PID, 'project_id=隔离产品');
  assert.equal(rows[0].type, 'consult', '★ type=consult（deep 不改变落库形态）');
});

test('B-DEEP-C2 连真库：consult 带 deep:false / 不带 deep → 默认路径正常（不检索源码）', async () => {
  // deep:false
  const r1 = await consultEvents({
    project: PID, subsystem: 'audit', deep: false,
    messages: [{ role: 'user', content: '审方白名单怎么用？' }],
  }, adminCookie);
  assert.equal(r1.status, 200, 'deep:false → 200');
  const d1 = r1.evs.find(o => o.done);
  assert.ok(d1 && d1.convId, 'deep:false → SSE 正常出流 + done');
  track(d1.convId);
  // 不带 deep（默认）
  const r2 = await consultEvents({
    project: PID, subsystem: 'audit',
    messages: [{ role: 'user', content: '审方规则在哪里配置？' }],
  }, adminCookie);
  assert.equal(r2.status, 200, '不带 deep → 200（默认路径）');
  const d2 = r2.evs.find(o => o.done);
  assert.ok(d2 && d2.convId, '不带 deep → SSE 正常出流 + done');
  track(d2.convId);
});

/* ---- 问题②：点击咨询记录带回对话续聊（consult 同 convId 续存不建重单）----
   连真库冒烟：经 /api/consult 生成一条 type=consult（持久化到 CACHE+DB，带 chat）→ intake-detail 返回 chat（供前端恢复会话）。
   （直插 DB 不行：server 已起、intake-detail 读 CACHE，未 loadAll；故走真实 consult 端点建单，最贴近实际。）
   + field/submissions 返回的 item 已带 project（供前端拉 detail）。+ field.html 静态断言 reopen 恢复逻辑。 */
let REOPEN_ID = '';
async function makeConsult() {
  const { evs } = await consultEvents({
    project: PID, subsystem: 'audit', messages: [{ role: 'user', content: '审方白名单怎么配置才能续聊' }],   // 带 subsystem，供 B-RO5 验续聊保留
  }, adminCookie);
  const done = evs.find(o => o.done);
  REOPEN_ID = (done && done.convId) || '';
  if (REOPEN_ID) track(REOPEN_ID);
  return REOPEN_ID;
}

test('B-RO1 连真库：intake-detail 返回 consult 的 chat（供点击记录恢复会话续聊）', async () => {
  await makeConsult();
  assert.ok(REOPEN_ID, 'consult 建单返回 convId（记录 id）');
  const r = await req('/api/intake-detail?project=' + encodeURIComponent(PID) + '&id=' + encodeURIComponent(REOPEN_ID), { cookie: adminCookie });
  assert.equal(r.status, 200, 'intake-detail 200');
  const item = r.json?.item;
  assert.ok(item, '返回 item');
  assert.equal(item.id, REOPEN_ID, 'item.id=consult 记录 id（=convId）');
  assert.equal(item.type, 'consult', 'type=consult');
  assert.equal(item.project, PID, 'item.project=隔离产品（供续问归属锁定）');
  assert.ok(Array.isArray(item.chat) && item.chat.length >= 2, 'item.chat 含用户问 + AI 答（恢复会话数据源）');
  const firstUser = item.chat.find(m => m.role === 'user');
  assert.ok(firstUser && /审方白名单/.test(firstUser.text), 'chat 含用户问（text 字段）');
  const anyAssistant = item.chat.find(m => m.role === 'assistant');
  assert.ok(anyAssistant && typeof anyAssistant.text === 'string', 'chat 含 AI 答（assistant.text，前端用 md() 渲染）');
});

test('B-RO2 field/submissions 返回 item 带 project（供 reopen 拉 detail）', async () => {
  // admin 不受 sites 约束；按 project 定位隔离产品那条 consult，核对返回 item 带 project 字段
  const r = await req('/api/field/submissions?dimension=hosp&groupBy=type&project=' + encodeURIComponent(PID), { cookie: adminCookie });
  assert.equal(r.status, 200, 'field/submissions 200');
  const all = [].concat(...((r.json.groups || []).map(x => x.items || [])));
  const it = all.find(i => i.id === REOPEN_ID);
  assert.ok(it, 'consult 记录出现在提交清单：' + JSON.stringify(all.map(x => x.id)));
  assert.equal(it.project, PID, '★ item 带 project（前端据此调 intake-detail?project=<pid>）');
  assert.equal(it.type, 'consult', 'type=consult');
});

test('B-RO3 field.html：记录点击分派（consult→reopenConsult、req/bug→reopenIntake）+ 三类均 clickable（bindReopen 统一）', () => {
  // 2026-07-24：需求/BUG 记录也可点击 reopen（不再只 consult），mkItem 用 isReopenable 判可点、bindReopen 按类型分派
  const mkItemBody = (FIELD_HTML.match(/function mkItem\(it, meta\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(mkItemBody, '能截取 mkItem 函数体');
  assert.match(mkItemBody, /isReopenable\(it\) \? ' clickable' : ''/, 'mkItem 用 isReopenable(it) 判可点（consult/requirement/bug 均可）');
  assert.match(mkItemBody, /bindReopen\(el, it\)/, 'mkItem 调 bindReopen 绑点击（按类型分派）');
  // isReopenable：三类 + 有 project+id 才可点
  const irBody = (FIELD_HTML.match(/function isReopenable\(it\)[\s\S]*?\n  \}/) || [''])[0] || FIELD_HTML;
  assert.match(irBody, /consult/, 'isReopenable 含 consult');
  assert.match(irBody, /requirement/, 'isReopenable 含 requirement');
  assert.match(irBody, /bug/, 'isReopenable 含 bug');
  assert.match(irBody, /it\.project && it\.id/, 'isReopenable 要求 project+id（缺则不可点）');
  // bindReopen：consult→reopenConsult，其余（req/bug）→reopenIntake
  const brBody = (FIELD_HTML.match(/function bindReopen\(el, it\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(brBody, '能截取 bindReopen 函数体');
  assert.match(brBody, /cursor = 'pointer'/, '可点记录 cursor:pointer（视觉可点）');
  assert.match(brBody, /it\.type === 'consult'\) reopenConsult\(it\); else reopenIntake\(it\)/, '★ 按类型分派：consult→reopenConsult；req/bug→reopenIntake');
  // reopenConsult：拉 intake-detail?project=&id= → 恢复 messages/convId/reopenProject/setSubmitKind('consult') + 逐条渲染气泡
  const roBody = (FIELD_HTML.match(/function reopenConsult\(it\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(roBody, '能截取 reopenConsult 函数体');
  assert.match(roBody, /\/api\/intake-detail\?project='/, '调 intake-detail?project=<pid>&id=<id>');
  assert.match(roBody, /chat\.messages = msgs/, '恢复 chat.messages（item.chat→{role,content}）');
  assert.match(roBody, /m\.text/, '消息文本取自 item.chat[].text');
  assert.match(roBody, /chat\.convId = item\.convId \|\| item\.id/, 'chat.convId = convId||id（consult convId=记录 id）');
  assert.match(roBody, /chat\.reopenProject = item\.project \|\| it\.project/, '★ 锁 chat.reopenProject（续问 append 到同一条 consult）');
  assert.match(roBody, /chat\.reopenSubsystem = item\.subsystem/, '★ 锁 chat.reopenSubsystem（续问保留原子系统、不被清空）');
  assert.match(roBody, /setSubmitKind\('consult'\)/, '切到咨询答疑模式');
  assert.match(roBody, /appendBubble\(m\.role === 'user' \? 'me' : 'ai', m\.content\)/, '逐条消息渲染进气泡（assistant md()/user 转义，appendBubble 内处理）');
  assert.match(roBody, /saveDraft\(\)/, '恢复后存草稿（刷新不丢）');
});

test('B-RO3i field.html：reopenIntake（需求/BUG 记录 reopen）恢复会话 + savedId=工单 id + 锁 reopenIntakeProject + 显归档卡片', () => {
  const riBody = (FIELD_HTML.match(/function reopenIntake\(it\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(riBody, '能截取 reopenIntake 函数体');
  // 仅 requirement/bug（consult 走 reopenConsult）
  assert.match(riBody, /it\.type !== 'requirement' && it\.type !== 'bug'/, '仅 requirement/bug 受理（consult 走 reopenConsult）');
  assert.match(riBody, /\/api\/intake-detail\?project=' \+ encodeURIComponent\(it\.project\)/, '拉 intake-detail?project=<pid>&id=<id>');
  assert.match(riBody, /chat\.messages = msgs/, '恢复 chat.messages（item.chat→气泡流）');
  assert.match(riBody, /m\.text/, '消息文本取自 item.chat[].text');
  // ★ 安全续聊铁律：savedId=工单 id（标记已建单）+ reopenIntakeProject=工单 project（续聊 append 定位）
  assert.match(riBody, /chat\.savedId = item\.id \|\| it\.id/, '★ chat.savedId=工单 id（标记已建单、续聊不再建新单）');
  assert.match(riBody, /chat\.reopenIntakeProject = item\.project \|\| it\.project/, '★ chat.reopenIntakeProject=工单 project（续聊走 intake-reply 定位同一张单）');
  assert.match(riBody, /chat\.reopenProject = ''; chat\.reopenSubsystem = ''/, '清 consult 续聊锁定（本次是 intake reopen）');
  assert.match(riBody, /setSubmitKind\('intake'\)/, '切到提需求/报BUG 模式');
  assert.match(riBody, /appendBubble\(m\.role === 'user' \? 'me' : 'ai', m\.content\)/, '逐条消息渲染进气泡');
  assert.match(riBody, /appendArchiveCard\(\{ id: chat\.savedId/, '★ 显「已建单 <id>（<类型>）」归档卡片（复用 appendArchiveCard）');
  assert.match(riBody, /saveDraft\(\)/, '恢复后存草稿（刷新不丢）');
});

test('B-RO3s field.html：安全续聊（杜绝重单）—— reopen 的已建单再发言走 intake-reply（append 同单），不走 intake-chat 再建单', () => {
  // sendChat 分派：intake 模式 + savedId + reopenIntakeProject → sendIntakeReply（intake-reply）；否则 sendIntake（intake-chat）
  const scBody = (FIELD_HTML.match(/function sendChat\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(scBody, '能截取 sendChat 函数体');
  assert.match(scBody, /chat\.savedId && chat\.reopenIntakeProject\) sendIntakeReply\(text\)/, '★ 已建单（savedId+reopenIntakeProject）→ sendIntakeReply（append 同单）');
  assert.match(scBody, /else sendIntake\(imgs\)/, '否则（新对话）→ sendIntake（intake-chat 建单）');
  // sendIntakeReply：调 intake-reply，带 project=reopenIntakeProject + id=savedId + message；绝不调 intake-chat
  const srBody = (FIELD_HTML.match(/function sendIntakeReply\(text\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(srBody, '能截取 sendIntakeReply 函数体');
  assert.match(srBody, /\/api\/intake-reply/, '★ 走 intake-reply（append 同单，服务端不建新单）');
  assert.doesNotMatch(srBody, /intake-chat/, '★ sendIntakeReply 绝不调 intake-chat（避免重单）');
  assert.match(srBody, /project: chat\.reopenIntakeProject, id: chat\.savedId, message: text/, 'intake-reply 入参 project+id+message 锁定同一张单');
  assert.match(srBody, /chat\.messages\.push\(\{ role: 'assistant', content: reply \}\)/, 'AI 续答落进本地消息流');
  // newConversation 清 reopenIntakeProject（新对话不再锁旧工单，恢复正常建单路径）
  assert.match(FIELD_HTML, /function newConversation\(\)[\s\S]{0,400}chat\.reopenIntakeProject = ''/, 'newConversation 清 chat.reopenIntakeProject');
  // 快照/草稿带 reopenIntakeProject（切系统/刷新不丢续聊锁定，切回续聊仍走 intake-reply）
  assert.match(FIELD_HTML, /reopenIntakeProject: chat\.reopenIntakeProject \|\| ''/, 'snapshot/saveDraft 带 reopenIntakeProject');
  assert.match(FIELD_HTML, /chat\.reopenIntakeProject = snap\.reopenIntakeProject \|\| ''/, 'restoreConversation 恢复 reopenIntakeProject');
  assert.match(FIELD_HTML, /chat\.reopenIntakeProject = d\.reopenIntakeProject \|\| ''/, 'restoreDraft 恢复 reopenIntakeProject');
});

test('B-RO3b field.html：系统视图记录同样可点击 reopen（mkSysItem 镜像 mkItem：isReopenable+bindReopen，靠 it.project 复用 · 问题②）', () => {
  const mkSysBody = (FIELD_HTML.match(/function mkSysItem\(it\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(mkSysBody, '能截取 mkSysItem 函数体');
  assert.match(mkSysBody, /isReopenable\(it\) \? ' clickable'/, '系统视图用 isReopenable 判可点（与医院视图 mkItem 一致）');
  assert.match(mkSysBody, /bindReopen\(el, it\)/, '系统视图调 bindReopen 绑点击（consult→reopenConsult、req/bug→reopenIntake）');
  // it 带 project（server mapItem 输出 project，sys 维度复用同一 mapItem）→ reopen 靠 it.project+it.id 调 intake-detail，无需改 server
  assert.match(FIELD_HTML, /reopenConsult[\s\S]{0,400}\/api\/intake-detail\?project=' \+ encodeURIComponent\(it\.project\)/, 'reopenConsult 靠 it.project 拉 detail（系统视图 item 已带 project，无需改 server）');
  assert.match(FIELD_HTML, /reopenIntake[\s\S]{0,600}\/api\/intake-detail\?project=' \+ encodeURIComponent\(it\.project\)/, 'reopenIntake 靠 it.project 拉 detail（无需改 server）');
});

test('B-RO4 field.html：续聊 project 归属锁定 + newConversation 清 reopenProject（不误建新记录）', () => {
  // currentArchive：reopenProject 有值且 consult → project 锁 reopenProject（保证续问同 convId+同 project append）
  const caBody = (FIELD_HTML.match(/function currentArchive\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(caBody, '能截取 currentArchive 函数体');
  assert.match(caBody, /if \(chat\.reopenProject && chat\.submitKind === 'consult'\)/, 'reopenProject+consult → project 锁到原 consult');
  assert.match(caBody, /out\.project = chat\.reopenProject/, '★ currentArchive project=reopenProject（续问归属不漂）');
  assert.match(caBody, /out\.subsystem = chat\.reopenSubsystem/, '★ currentArchive subsystem=reopenSubsystem（续问保留原子系统，server 端 subsystem 不被清空）');
  // sendConsult 用 currentArchive().project + convId 续存 → 同一条 consult
  assert.match(FIELD_HTML, /function sendConsult\(imgs\)[\s\S]{0,400}currentArchive\(\)/, 'sendConsult 用 currentArchive() 取 project');
  assert.match(FIELD_HTML, /convId: chat\.convId \|\| undefined/, 'sendConsult 带 convId（同 convId 续存不建重单）');
  // newConversation 清 reopenProject + reopenSubsystem（开新对话不再锁旧 consult 的 project/子系统）
  assert.match(FIELD_HTML, /function newConversation\(\)[\s\S]{0,260}chat\.reopenProject = ''/, 'newConversation 清 chat.reopenProject');
  assert.match(FIELD_HTML, /function newConversation\(\)[\s\S]{0,300}chat\.reopenSubsystem = ''/, 'newConversation 清 chat.reopenSubsystem');
  // 草稿持久化带 reopenSubsystem（刷新不丢续聊锁定的子系统）
  assert.match(FIELD_HTML, /reopenSubsystem: chat\.reopenSubsystem \|\| ''/, 'saveDraft 带 reopenSubsystem');
  assert.match(FIELD_HTML, /chat\.reopenSubsystem = d\.reopenSubsystem \|\| ''/, 'restoreDraft 恢复 reopenSubsystem');
  // server.mjs consult 端按 b.project + convId 续存（prev = store[convId]... type==='consult'）
  assert.match(SRC, /const prev = convId && store\[convId\] && store\[convId\]\.type === 'consult' \? store\[convId\] : null/, 'server consult 按 convId+type 续存（同一条 append，不建重单）');
});

test('B-RO5 连真库：reopen 续聊保留原子系统——带 subsystem 的 consult 续问后 subsystem 仍在（不被清空）', async () => {
  // makeConsult 已带 subsystem: 'audit'；先核对建单时 subsystem 落库
  await makeConsult();
  assert.ok(REOPEN_ID, '带 subsystem 的 consult 建单成功');
  const [before] = await pool.query('SELECT type,subsystem FROM intakes WHERE project_id=? AND id=?', [PID, REOPEN_ID]);
  assert.equal(before.length, 1, 'consult 落库一条');
  assert.equal(before[0].type, 'consult', 'type=consult');
  assert.equal(before[0].subsystem, 'audit', '★ 建单时 subsystem=audit 落库');
  // 模拟前端 reopen 续聊：拉 detail 拿 item.subsystem → 续问带 convId + 同 subsystem（前端 currentArchive 的 reopenSubsystem 行为）
  const det = await req('/api/intake-detail?project=' + encodeURIComponent(PID) + '&id=' + encodeURIComponent(REOPEN_ID), { cookie: adminCookie });
  const reopenSub = det.json?.item?.subsystem || '';
  assert.equal(reopenSub, 'audit', 'intake-detail 返回原子系统（前端据此设 reopenSubsystem）');
  const prevChat = (det.json?.item?.chat || []).map(m => ({ role: m.role, content: m.text }));
  const { evs } = await consultEvents({
    project: PID, subsystem: reopenSub, convId: REOPEN_ID,   // ★ 续问带 reopenSubsystem（前端 currentArchive 保留）
    messages: [...prevChat, { role: 'user', content: '续问：白名单还要注意什么' }],
  }, adminCookie);
  const done = evs.find(o => o.done);
  assert.equal(done?.convId, REOPEN_ID, '续问同 convId（append 不建重单）');
  const [after] = await pool.query('SELECT subsystem FROM intakes WHERE project_id=? AND id=?', [PID, REOPEN_ID]);
  assert.equal(after.length, 1, '续问后仍是同一条 consult（不建重单）');
  assert.equal(after[0].subsystem, 'audit', '★★ 续问后 subsystem 仍为 audit（未被清空——修 reopen 续聊丢 subsystem 隐患）');
});

/* ---- B（2026-07-24）：需求/BUG 记录 reopen 续聊安全性——建一张 BUG → reopen → 再发一句 → 断言工单数没 +1、同单 chat 追加。
   核心：前端 reopen 续聊走 intake-reply（append 同单），绝不走 intake-chat 再建单。此处直打 intake-reply 端点验「不建重单」。 */
test('B-RI1 连真库：建 BUG → reopen（intake-detail 返回 chat）→ intake-reply 续聊 → 工单数不变、同单 chat 追加（杜绝重单）', async () => {
  // 1) 建一张 BUG（intake-submit 直接建单，不依赖模型）
  const sub = await req('/api/intake-submit', { method: 'POST', cookie: adminCookie, body: { project: PID, type: 'bug', title: 'FS06续聊BUG', version: 'v1.0.0', subsystem: 'audit', desc: '登录报错' } });
  assert.equal(sub.status, 200, 'intake-submit 200');
  const RID = sub.json?.id; assert.ok(RID, '建单返回工单 id'); track(RID);
  const [[b0]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', [PID]);   // 建单后工单基线数
  // 2) reopen：intake-detail 返回该单（供前端恢复会话）——含 type/project/chat
  const det = await req('/api/intake-detail?project=' + encodeURIComponent(PID) + '&id=' + encodeURIComponent(RID), { cookie: adminCookie });
  assert.equal(det.status, 200, 'intake-detail 200');
  const item = det.json?.item;
  assert.ok(item, '返回 item');
  assert.equal(item.type, 'bug', 'type=bug（reopenIntake 据此显归档卡类型 + 走 intake 模式）');
  assert.equal(item.project, PID, 'item.project=隔离产品（前端锁 reopenIntakeProject，供 intake-reply 定位）');
  assert.ok(Array.isArray(item.chat), 'item.chat 是数组（恢复会话数据源）');
  const chatLen0 = item.chat.length;
  // 3) 安全续聊：走 intake-reply（前端 sendIntakeReply 的服务端行为）——append 同单、不建新单
  const rep = await req('/api/intake-reply', { method: 'POST', cookie: adminCookie, body: { project: PID, id: RID, message: '补充：只有 Chrome 下才复现' } });
  assert.equal(rep.status, 200, 'intake-reply 200');
  assert.equal(rep.json?.ok, true, 'intake-reply ok');
  // 4) 断言：工单总数没 +1（★★ 杜绝重单）
  const [[b1]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', [PID]);
  assert.equal(b1.n, b0.n, '★★ intake-reply 续聊后工单总数不变（不建重单）');
  // 5) 断言：同单仍在，且 chat 追加了补充留言（含用户补充 + AI 回复）
  const det2 = await req('/api/intake-detail?project=' + encodeURIComponent(PID) + '&id=' + encodeURIComponent(RID), { cookie: adminCookie });
  const item2 = det2.json?.item;
  assert.ok(item2 && item2.id === RID, '仍是同一张单');
  assert.ok(item2.chat.length > chatLen0, '★ 同单 chat 已追加（不是另起新单）');
  const appended = item2.chat.some(m => m.role === 'user' && /只有 Chrome 下才复现/.test(m.text || ''));
  assert.ok(appended, '★ 追加的补充留言落在同一张单的 chat 里');
});

test('A-RO 静态：field.html 咨询必选子系统守卫 + 续聊不拦 + 引导选择（仅 consult 生效，intake 不受影响）', () => {
  // 守卫函数存在且仅在 consult 且非续聊、无子系统时拦截
  const gBody = (FIELD_HTML.match(/function guardConsultSubsystem\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(gBody, '能截取 guardConsultSubsystem 函数体');
  assert.match(gBody, /if \(chat\.reopenProject\) return false/, '★ 续聊（reopenProject 非空）永不拦（保留原子系统、不误建）');
  assert.match(gBody, /if \(arch\.subsystem\) return false/, '★ 已有子系统 → 放行');
  assert.match(gBody, /所属的子系统/, '拦截提示引导选择子系统');
  assert.match(gBody, /state\.mode === 'hosp'/, '医院视图分支：展开子项目下拉引导');
  assert.match(gBody, /\$\('fProdWrap'\)/, '医院视图引导展开 fProdWrap 子项目下拉');
  assert.match(gBody, /\$\('fSysCur'\)/, '系统视图引导展开系统下拉');
  // sendChat 仅在 consult 时调守卫（intake/提需求报BUG 不受影响，走 AI 自动判子系统）
  const scBody = (FIELD_HTML.match(/function sendChat\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(scBody, '能截取 sendChat 函数体');
  assert.match(scBody, /chat\.submitKind === 'consult' && guardConsultSubsystem\(\)\) return/, '★ sendChat 仅 consult 触发必选守卫（intake 不受影响）');
  // 守卫在清输入前触发：拦住时输入内容保留、便于选完再发
  assert.ok(scBody.indexOf('guardConsultSubsystem()) return') < scBody.indexOf("input.value = '';"), '守卫在清空输入前 → 拦住时保留输入');
});

test('A-CTX 静态：归档条去「归档到」label + 系统视图子系统显中文（sysLabel）', () => {
  // ① 去掉「归档到」label：元素与 f-actx-lbl 类均已移除
  assert.doesNotMatch(FIELD_HTML, /f-actx-lbl/, '★ 已移除 .f-actx-lbl 元素与 CSS（归档条不再有「归档到」前缀）');
  assert.doesNotMatch(FIELD_HTML, /归档到/, '★ 无「归档到」文案');
  // 归档条仍从 #fCtx 起（产品图标），f-rtool 结构不变
  assert.match(FIELD_HTML, /<div class="f-rtool" id="fActx">\s*<span class="f-ctx" id="fCtx">/, '归档条直接从 #fCtx 开始（无 label 前缀）');
  // ② renderSysChip 子系统显中文：用 sysLabel(sysName)（audit→审方），不再裸显英文 name
  const scBody = (FIELD_HTML.match(/function renderSysChip[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(scBody, '能截取 renderSysChip 函数体');
  assert.match(scBody, /escapeHtml\(sysLabel\(sysName\)\)/, '★ 系统视图归档 chip 子系统用 sysLabel(sysName) 显中文 desc');
  // chip innerHTML 不再裸拼 escapeHtml(sysName)（英文名）——现只出现 escapeHtml(sysLabel(sysName))
  assert.doesNotMatch(scBody, /escapeHtml\(sysName\)/, '不再裸用 escapeHtml(sysName)（英文名），须经 sysLabel 中文化');
  // renderHospChip 现渲染所选子系统（2026-07-23 问题① + 2026-07-24 问题②：
  //   curSub 非空 → 显「· 系统：<subLabel(curSub)> · 版本：<subVersion>」并 early return，不再挂产品级「现场版本」；curSub 为空 → 保持产品级「现场版本」列）
  const hcBody = (FIELD_HTML.match(/function renderHospChip[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(hcBody, '能截取 renderHospChip 函数体');
  assert.match(hcBody, /if \(state\.curSub\)[\s\S]*?subLabel\(state\.curSub\)/, '★ renderHospChip 选中子系统时显 subLabel(state.curSub) 中文名（问题①；子系统版本模型后改 if 分支）');
  const hcSubBranch = (hcBody.match(/if \(state\.curSub\) \{[\s\S]*?return;\s*\n    \}/) || [''])[0];
  assert.ok(hcSubBranch, '能截取 renderHospChip curSub 非空分支块');
  assert.match(hcSubBranch, /subVersion\(state\.curSub\)/, '★ 选中子系统分支取 subVersion(state.curSub)（问题②：显该子系统版本）');
  assert.match(hcSubBranch, /版本：/, '★ 选中子系统分支显「· 版本：」段');
  assert.doesNotMatch(hcSubBranch, /现场版本/, '★ 选中子系统分支不再挂产品级「现场版本」（问题②去冗余）');
});

test('B-C1 访客 intake-chat：project 强制=link.project（AI 未配走降级也不串产品；有配则归档同 project）', async () => {
  const tok = guestToken();
  const r = await req('/api/intake-chat', { method: 'POST', token: tok, body: { project: OTHER_PID, type: 'intake', messages: [{ role: 'user', content: '审方任务推送不到药师端' }] } });
  assert.equal(r.status, 200, 'intake-chat 不 500（降级不抛异常）');
  assert.equal(r.json?.ok, true, 'ok:true');
  if (r.json.savedId) {
    track(r.json.savedId);
    const [rows] = await pool.query('SELECT project_id,data FROM intakes WHERE id=?', [r.json.savedId]);
    const d = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
    assert.equal(rows[0].project_id, PID, '★ intake-chat 归档 project_id 强制=link.project');
    assert.equal(d.history?.[0]?.byRole, 'field', 'byRole=field');
  }
  // 无论有无建单，篡改产品下都不应落工单
  const [oth] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', [OTHER_PID]);
  assert.equal(oth[0].n, 0, '★ 篡改探针产品下无 intake-chat 归档');
});

test('B-D1 过期 token → 访客身份不成立：/api/me 无 me；/api/intake-submit 401；/submit.html 302 login', async () => {
  const expired = guestToken({ exp: Date.now() - 1000 });
  const me = await req('/api/me', { token: expired });
  assert.equal(me.json?.me, null, '过期 token → /api/me me:null（未认证）');
  const sub = await req('/api/intake-submit', { method: 'POST', token: expired, body: { project: PID, type: 'requirement', title: 'x' } });
  assert.equal(sub.status, 401, '过期 token 访问 /api/* → 401 need-login');
  assert.equal(sub.json?.error, 'need-login', 'error=need-login');
  const page = await req('/submit.html', { token: expired, raw: true });
  assert.equal(page.status, 302, '过期 token 访问受限页 → 302');
  assert.equal(page.location, '/login.html', '302 到 /login.html');
});

test('B-D2 篡改签名 token → 拒（HMAC 验签失败）', async () => {
  const good = guestToken();
  const [p, sig] = good.split('.');
  const tampered = p + '.' + (sig.slice(0, -1) + (sig.slice(-1) === 'A' ? 'B' : 'A'));
  const me = await req('/api/me', { token: tampered });
  assert.equal(me.json?.me, null, '篡改签名 → 访客身份不成立');
  const sub = await req('/api/intake-submit', { method: 'POST', token: tampered, body: { project: PID, type: 'requirement', title: 'x' } });
  assert.equal(sub.status, 401, '篡改 token → 401');
});

test('B-D3 token 有效但 project 已删 → linkUserFrom 返 null（产品删除天然使其链接失效）', async () => {
  // 为 OTHER_PID 签一个有效 token，然后删除 OTHER_PID
  const tok = sign({ project: OTHER_PID, site: LINK_SITE, ver: '', type: '', exp: Date.now() + 86400000 }, secretNow());
  // 先确认有效
  const ok = await req('/api/me', { token: tok });
  assert.equal(ok.json?.me?.project, OTHER_PID, '删产品前：token 有效、me.project=OTHER_PID');
  // 删除 OTHER_PID（+ 兜底删其工单，前面 chat 用例可能未落，这里保证干净）
  await req('/api/project-delete', { method: 'POST', body: { id: OTHER_PID }, cookie: adminCookie });
  await pool.query('DELETE FROM intakes WHERE project_id=?', [OTHER_PID]);
  const gone = await req('/api/me', { token: tok });
  assert.equal(gone.json?.me, null, '★ 产品删除后：token 的 me 变 null（!projById → 拒）');
  const sub = await req('/api/intake-submit', { method: 'POST', token: tok, body: { project: OTHER_PID, type: 'requirement', title: 'x' } });
  assert.equal(sub.status, 401, '产品已删 token → 401');
  // 重建 OTHER_PID 供 after 清理一致（无害）
  await req('/api/project-save', { method: 'POST', body: { id: OTHER_PID, name: 'FS06 篡改探针产品' }, cookie: adminCookie });
});

test('B-D4 缺失 token（无 query 无 cookie）→ 未登录访问 /api/intake-submit → 401', async () => {
  const r = await req('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'requirement', title: 'x' } });
  assert.equal(r.status, 401, '无 token 无登录 → 401 need-login');
});

test('B-E1 有效访客访问 LINK_OK 内端点 → 放行（intake-submit/projects/versions 等）', async () => {
  const tok = guestToken();
  const pr = await req('/api/projects', { token: tok });
  assert.equal(pr.status, 200, '/api/projects 放行');
  const ver = await req('/api/versions?project=' + PID, { token: tok });
  assert.equal(ver.status, 200, '/api/versions 放行');
  const page = await req('/submit.html', { token: tok, raw: true });
  assert.equal(page.status, 200, '/submit.html 放行');
});

test('B-E2 访客访问 LINK_OK 外的 /api/* → 403（intake-list/detail/transition/accounts/submit-link）', async () => {
  const tok = guestToken();
  for (const p of ['/api/intake-list?project=' + PID, '/api/intake-detail?project=' + PID + '&id=x', '/api/accounts']) {
    const r = await req(p, { token: tok });
    assert.equal(r.status, 403, `${p} → 403`);
    assert.equal(r.json?.error, 'forbidden', 'error=forbidden');
  }
  const tr = await req('/api/intake-transition', { method: 'POST', token: tok, body: { project: PID, id: 'x', to: '处理中' } });
  assert.equal(tr.status, 403, 'intake-transition → 403');
});

test('B-E3 访客访问 LINK_OK 外的非 /api 页面 → 302 /login.html（inbox/projects/accounts.html）', async () => {
  const tok = guestToken();
  for (const p of ['/inbox.html', '/projects.html', '/accounts.html']) {
    const r = await req(p, { token: tok, raw: true });
    assert.equal(r.status, 302, `${p} → 302`);
    assert.equal(r.location, '/login.html', '302 到 /login.html');
  }
});

test('B-E4 登录 Cookie 优先于 link：同时带登录会话 + link token → 走登录鉴权（管理员放行 inbox，link 让位）', async () => {
  const tok = guestToken();
  // 管理员登录 Cookie + link token 同时带 → 走登录（管理员），访问 inbox.html（LINK_OK 外）应放行
  const r = await fetch(BASE + '/inbox.html', {
    headers: { Cookie: adminCookie + '; intake_link=' + tok }, redirect: 'manual',
  });
  assert.equal(r.status, 200, '登录优先：管理员带 link token 访问 inbox.html → 200（link 让位，不被降级为访客 302）');
});

test('B-F1 exp 到期即单条失效（AC-D1 复用）：过期 token 全链路被拒', async () => {
  const expired = guestToken({ exp: Date.now() - 86400000 });
  const r = await req('/api/me', { token: expired });
  assert.equal(r.json?.me, null, 'exp 到期 → 该 token 自动失效');
});

test('B-F2 换 data/link-secret → 所有旧 token 整体失效（备份+还原，不弄坏用户密钥）', async () => {
  const oldTok = guestToken();
  // 确认旧 token 现在有效
  const before = await req('/api/me', { token: oldTok });
  assert.equal(before.json?.me?.link, true, '换密钥前：旧 token 有效');
  // 换密钥（写入新随机 hex）→ 服务端 linkSecret() 逐次读文件，立即生效
  const fresh = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(LINK_SECRET_FILE, fresh);
  try {
    const after = await req('/api/me', { token: oldTok });
    assert.equal(after.json?.me, null, '★ 换密钥后：旧 token HMAC 验签失败 → 整体失效');
    // 用新密钥签发的 token 应有效（验证换密钥后新链接照常工作）
    const newTok = sign({ project: PID, site: LINK_SITE, ver: LINK_VER, type: '', exp: Date.now() + 86400000 }, fresh);
    const nm = await req('/api/me', { token: newTok });
    assert.equal(nm.json?.me?.link, true, '新密钥签发的 token 有效');
  } finally {
    fs.writeFileSync(LINK_SECRET_FILE, secretBackup);   // 立即还原（after 还会再兜一次）
  }
  // 还原后旧 token 又有效
  const restored = await req('/api/me', { token: oldTok });
  assert.equal(restored.json?.me?.link, true, '还原密钥后：旧 token 恢复有效（未弄坏用户密钥）');
});

/* ================= 咨询附截图（FS-06/FS-04 · 2026-07-24 裁决：MVP 附图 + AI 多模态看图） =================
   consult 存图镜像 intake-chat/submit：≤6 张 data URL 落 intake-store/<proj>/media/<convId>/img-N.png、记 e.media；
   detail.html 已按 e.media 展示（对 consult 同样生效）；/api/intake-media 只读取回 + 防穿越。
   连真库冒烟：consult 带 images → 落库 media 文件 + e.media + intake-media 能取；after 已按 PID 精确清 intake-store/工单。 */
const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgAAACAAAB4iG8MwAAAABJRU5ErkJggg==';

test('B-IMG1 consult 带 images → 落库 media 文件 + e.media 记录（存图镜像 intake-chat）', async () => {
  const { status, evs } = await consultEvents({
    project: PID, subsystem: 'audit', version: 'v1', site: LINK_SITE,
    messages: [{ role: 'user', content: '看这个报错截图怎么回事 imgsmoke1' }], images: [PNG_1x1],
  }, adminCookie);
  assert.equal(status, 200, 'consult 200（SSE）');
  const done = evs.find(o => o.done); assert.ok(done && done.convId, 'done 带 convId');
  const convId = done.convId; track(convId);
  // ① DB：intakes.data JSON 里含 media（media 挂在 data JSON，非独立列，见 lessons L-058）
  const [rows] = await pool.query('SELECT data FROM intakes WHERE project_id=? AND id=?', [PID, convId]);
  assert.equal(rows.length, 1, 'consult 落库一条');
  const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
  assert.ok(Array.isArray(data.media) && data.media.length >= 1, '★ e.media 至少一条（consult 存图生效）');
  assert.match(data.media[0], new RegExp('^media/' + convId.replace(/[-.]/g, '\\$&') + '/img-1\\.png$'), 'media 路径 = media/<convId>/img-1.png');
  // ② 文件真落地 intake-store/<pid>/media/<convId>/img-1.png
  const file = path.join(ROOT, 'data/intake-store', PID, data.media[0]);
  assert.ok(fs.existsSync(file), '★ 截图文件真落地磁盘');
  assert.ok(fs.statSync(file).size > 0, '截图文件非空');
});

test('B-IMG2 /api/intake-media 能取到 consult 截图 + 防穿越仍生效', async () => {
  // 先建一条带图 consult 拿 media 路径
  const { evs } = await consultEvents({
    project: PID, subsystem: 'audit', messages: [{ role: 'user', content: 'media 取回冒烟 imgsmoke2' }], images: [PNG_1x1],
  }, adminCookie);
  const done = evs.find(o => o.done); const convId = done.convId; track(convId);
  const [rows] = await pool.query('SELECT data FROM intakes WHERE project_id=? AND id=?', [PID, convId]);
  const _d = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data; const media = _d.media[0];
  // ① intake-media 取回（PNG 二进制，200）
  const ok = await req('/api/intake-media?project=' + encodeURIComponent(PID) + '&file=' + encodeURIComponent(media), { cookie: adminCookie, raw: true });
  assert.equal(ok.status, 200, '★ /api/intake-media 取 consult 截图 → 200');
  assert.ok(ok.text.length > 0, '返回非空图片内容');
  // ② 防穿越：file 带 ../ 逃逸 → 404（不泄露 intake-store 外文件）
  const esc = await req('/api/intake-media?project=' + encodeURIComponent(PID) + '&file=' + encodeURIComponent('../../../server.mjs'), { cookie: adminCookie, raw: true });
  assert.equal(esc.status, 404, '★ 穿越路径 ../../../server.mjs → 404（防穿越生效）');
});

test('B-IMG3 consult 续聊同 convId 追加图 → 累加不覆盖（累计封顶 6 张）', async () => {
  // 第一轮：带 2 张
  const r1 = await consultEvents({
    project: PID, subsystem: 'audit', messages: [{ role: 'user', content: '续聊存图第一轮 imgsmoke3' }], images: [PNG_1x1, PNG_1x1],
  }, adminCookie);
  const convId = r1.evs.find(o => o.done).convId; track(convId);
  const [r1rows] = await pool.query('SELECT data FROM intakes WHERE project_id=? AND id=?', [PID, convId]);
  const _d1 = typeof r1rows[0].data === 'string' ? JSON.parse(r1rows[0].data) : r1rows[0].data; assert.equal(_d1.media.length, 2, '第一轮落 2 张');
  // 第二轮：同 convId 再带 3 张 → 累计 5 张（不覆盖前 2 张）
  const r2 = await consultEvents({
    project: PID, subsystem: 'audit', convId, messages: [
      { role: 'user', content: '续聊存图第一轮 imgsmoke3' }, { role: 'assistant', content: '好的' },
      { role: 'user', content: '续聊存图第二轮 imgsmoke3b' },
    ], images: [PNG_1x1, PNG_1x1, PNG_1x1],
  }, adminCookie);
  assert.equal(r2.evs.find(o => o.done).convId, convId, '★ 续聊仍同一 convId（不新建）');
  const [r2rows] = await pool.query('SELECT data FROM intakes WHERE project_id=? AND id=?', [PID, convId]);
  const _d2 = typeof r2rows[0].data === 'string' ? JSON.parse(r2rows[0].data) : r2rows[0].data; const media2 = _d2.media;
  assert.equal(media2.length, 5, '★ 累加到 5 张（前 2 张未被覆盖）');
  assert.ok(media2.includes('media/' + convId + '/img-1.png') && media2.includes('media/' + convId + '/img-5.png'), '序号累加 img-1..img-5');
  // 磁盘 5 个文件都在
  const dir = path.join(ROOT, 'data/intake-store', PID, 'media', convId);
  assert.equal(fs.readdirSync(dir).filter(f => /^img-\d+\.png$/.test(f)).length, 5, '磁盘 5 张截图并存');
});

/* ---- 静态断言：consult 后端存图 + 多模态 + field.html 选图/粘贴/发送 UI（附图交互） ---- */

test('B-IMG4 server.mjs：consult 存图（累加不覆盖 media/<convId>）+ callModelStream 传 images（多模态看图）', () => {
  // consult 落库 rec 带 media（累加 prevMedia）
  assert.match(SRC, /const prevMedia = \(prev && Array\.isArray\(prev\.media\)\) \? prev\.media\.slice\(\) : \[\];/, 'consult 续聊取 prev.media 累加');
  assert.match(SRC, /path\.join\(intakeDir\(proj\), 'media', convId\)/, 'consult 存图目录用 convId');
  assert.match(SRC, /const room = Math\.max\(0, 6 - prevMedia\.length\)/, '累计封顶 6 张');
  // consult callModelStream 传 images（多模态）
  const cs = (SRC.match(/url\.pathname === '\/api\/consult'[\s\S]*?sse\(\{ done: true/) || [''])[0];
  assert.match(cs, /images:\s*imgs/, 'consult callModelStream 带 images（AI 结合图答疑）');
  assert.match(cs, /const imgs = \(Array\.isArray\(b\.images\) \? b\.images : \[\]\)\.slice\(0, 6\)/, 'consult 取 b.images ≤6');
});

test('B-IMG5 field.html：选图/粘贴/预览/发送 UI + 用户气泡显图（附图交互）', () => {
  // 入口 + 隐藏 file input + 预览条
  assert.match(FIELD_HTML, /id="fImgBtn"/, '有图片入口按钮');
  assert.match(FIELD_HTML, /accept="image\/\*"/, 'file input accept=image/*');
  assert.match(FIELD_HTML, /id="fImgPreview"/, '有缩略图预览条');
  // 选图 + 粘贴
  assert.match(FIELD_HTML, /function addImageFiles\(files\)/, '有 addImageFiles（选图/粘贴共用）');
  assert.match(FIELD_HTML, /addEventListener\('paste'/, '输入框绑 paste（粘贴取图）');
  assert.match(FIELD_HTML, /getAsFile\(\)/, 'paste 从 clipboardData 取图片 File');
  // 发送带 images（consult + intake 各带）
  assert.match(FIELD_HTML, /function sendConsult\(imgs\)/, 'sendConsult 带 imgs');
  const scl = (FIELD_HTML.match(/function sendConsult\(imgs\)[\s\S]*?var payload = \{[\s\S]*?\};/) || [''])[0];
  assert.match(scl, /images:\s*\(Array\.isArray\(imgs\)/, 'consult payload 带 images（有图才带·向后兼容）');
  // 用户气泡显所附截图
  assert.match(FIELD_HTML, /function bubbleImgs\(imgs\)/, '用户气泡内缩略图 bubbleImgs');
  assert.match(FIELD_HTML, /\.f-bub-imgs\b/, '气泡截图样式 .f-bub-imgs');
  // 图片是输入态，不进草稿/快照
  const save = (FIELD_HTML.match(/function saveDraft\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.doesNotMatch(save, /images/, 'saveDraft 不塞 images（输入态不进端存储）');
  // 禁 localStorage（含注释）
  assert.doesNotMatch(FIELD_HTML, /localStorage/, 'field.html 全程不用 localStorage（FS-01 A5）');
});
