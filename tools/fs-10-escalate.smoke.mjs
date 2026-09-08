// FS-10 · 咨询转人工 + 运营回复 + 经验库反哺 端到端冒烟（真 HTTP · 无 MySQL 也能跑）。
//   复用 cti-register.mjs loader hook 把 ./db.mjs 换成 cti-db-stub（no-op 写库 + 从 fixture 读 accounts/projects），
//   其余全真（真路由/真内存 CACHE/真 kb 逻辑/真 kbRetrieveScored 关键词召回）。
//   验证链路：
//     1) impl 登录 + admin 登录（fixture 两账号）
//     2) impl consult（无模型走降级，落 type=consult，拿 convId）
//     3) impl consult-escalate → escalated 态；再点一次 → alreadyEscalated（幂等）
//     4) admin consult-escalations → 列到该条（待回复），倒序；impl 调该端点 → 403（admin 限定）
//     5) admin consult-human-reply → chat 末条 human:true；escalations 变「已回复」；空 reply → 400；impl → 403
//     6) admin consult-kb-draft → 返 {q,a}（无模型走兜底=原问题/人工回复）；impl → 403
//     7) admin kb-save source=escalated → 存 KB；kb-list 断言 source=escalated
//     8) 反哺闭环：admin consult 再问同类问题 → 或直接断言 kb-list 有该条（新条目在内存 CACHE.kb，下次 kbRetrieveScored 可召回）
//     9) 白名单：escalate ∈ FIELD_OK∩FS08；escalations/human-reply/kb-draft 均不在任何 field/link 白名单
//   用法：node --test tools/fs-10-escalate.smoke.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'fs10smoke';
const MY_SITE = 'FS10现场医院';
const FIELD_U = 'fs10impl', FIELD_PW = 'Fs10Pass99', FIELD_NAME = 'FS10实施工';
const ADMIN_U = 'fs10admin', ADMIN_PW = 'Fs10Admin99', ADMIN_NAME = 'FS10运营';

let srv = null, fieldCookie = '', adminCookie = '', tmpData = '', tmpFix = '', convId = '';
function scrypt(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }
function req(p, { method = 'GET', body, cookie } = {}) {
  return fetch(BASE + p, {
    method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => ({ status: r.status, setCookie: r.headers.get('set-cookie'), json: await r.json().catch(() => null) }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  tmpFix = fs.mkdtempSync(path.join(os.tmpdir(), 'fs10-fix-'));
  const s1 = crypto.randomBytes(16).toString('hex'), s2 = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(tmpFix, 'accounts.json'), JSON.stringify([
    { id: 'uFs10i', username: FIELD_U, role: 'impl', name: FIELD_NAME, projects: [PID], sites: [MY_SITE], salt: s1, hash: scrypt(FIELD_PW, s1), mustChange: false, enabled: 1 },
    { id: 'uFs10a', username: ADMIN_U, role: 'admin', name: ADMIN_NAME, projects: [], sites: [], salt: s2, hash: scrypt(ADMIN_PW, s2), mustChange: false, enabled: 1 },
  ]));
  fs.writeFileSync(path.join(tmpFix, 'projects.json'), JSON.stringify([
    { id: PID, name: 'FS10冒烟产品', subsystems: [{ name: 'billing', desc: '收费' }] },
  ]));
  tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'fs10-data-'));
  srv = spawn('node', ['--import', path.join(ROOT, 'tools/cti-register.mjs'), path.join(ROOT, 'server.mjs')], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), INTAKE_DATA: tmpData, CTI_FIXTURE: tmpFix, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; srv.stdout.on('data', d => { out += d; }); srv.stderr.on('data', d => { out += d; });
  for (let i = 0; i < 60; i++) { await sleep(200); try { const r = await req('/api/health'); if (r.status === 200) break; } catch {} if (i === 59) { console.error(out); throw new Error('server 未起来'); } }
});
after(async () => {
  if (srv) try { srv.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmpFix, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('登录 impl + admin，造一条 consult 拿 convId', async () => {
  const l1 = await req('/api/login', { method: 'POST', body: { username: FIELD_U, password: FIELD_PW } });
  assert.ok(l1.json && l1.json.ok, '现场登录 ' + JSON.stringify(l1.json));
  fieldCookie = (l1.setCookie || '').split(';')[0];
  const l2 = await req('/api/login', { method: 'POST', body: { username: ADMIN_U, password: ADMIN_PW } });
  assert.ok(l2.json && l2.json.ok, '运营登录 ' + JSON.stringify(l2.json));
  adminCookie = (l2.setCookie || '').split(';')[0];

  const r = await fetch(BASE + '/api/consult', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: fieldCookie },
    body: JSON.stringify({ project: PID, site: MY_SITE, subsystem: 'billing', messages: [{ role: 'user', content: '收费模块结算按钮点了没反应，是配置问题吗？' }] }),
  });
  const text = await r.text();
  for (const line of text.split('\n')) { const s = line.trim(); if (!s.startsWith('data:')) continue; let o = null; try { o = JSON.parse(s.slice(5).trim()); } catch {} if (o && o.done && o.convId) convId = o.convId; }
  assert.ok(convId && convId.startsWith('ZX-'), 'consult 落库拿 convId：' + convId);
});

test('AC-1/2 转人工：置 escalated 态，再点幂等 alreadyEscalated', async () => {
  const r1 = await req('/api/consult-escalate', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId } });
  assert.equal(r1.status, 200); assert.ok(r1.json && r1.json.ok);
  // 详情断言 escalated 字段落地
  const d = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: adminCookie });
  const e = d.json && d.json.item; assert.ok(e);
  assert.equal(e.escalated, true, 'escalated=true');
  assert.equal(e.humanActive, true, 'humanActive=true（进入人工服务模式·持续双向对话增强）');
  assert.ok(e.escalatedAt, 'escalatedAt 有值');
  assert.equal(e.escalatedBy, FIELD_NAME, 'escalatedBy=发起人');
  assert.match(String(e.escalateQuestion || ''), /结算按钮/, 'escalateQuestion=最后一条 user 快照');
  assert.equal(e.type, 'consult', '仍是 consult（不转工单）');
  const firstAt = e.escalatedAt;
  const r2 = await req('/api/consult-escalate', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId } });
  assert.equal(r2.status, 200); assert.ok(r2.json && r2.json.alreadyEscalated, '幂等 alreadyEscalated');
  const d2 = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: adminCookie });
  assert.equal(d2.json.item.escalatedAt, firstAt, 'escalatedAt 不被后一次覆盖');
});

test('AC-3 权限：escalations admin 可列（待回复·倒序）；impl 调 escalations → 403', async () => {
  const r = await req('/api/consult-escalations', { method: 'POST', cookie: adminCookie, body: {} });
  assert.equal(r.status, 200);
  const items = (r.json && r.json.items) || [];
  const it = items.find(x => x.id === convId);
  assert.ok(it, 'escalations 列到该条');
  assert.equal(it.status, '待回复');
  assert.equal(it.site, MY_SITE);
  assert.match(String(it.escalateQuestion || ''), /结算按钮/);
  // impl 越权访问 admin 端点 → 403
  const r2 = await req('/api/consult-escalations', { method: 'POST', cookie: fieldCookie, body: {} });
  assert.equal(r2.status, 403, 'impl 访问 escalations → 403（admin 限定）');
});

test('AC-5 人工回复：append human:true，escalations 转「已回复」；空 reply→400；impl→403', async () => {
  const rEmpty = await req('/api/consult-human-reply', { method: 'POST', cookie: adminCookie, body: { project: PID, convId, reply: '  ' } });
  assert.equal(rEmpty.status, 400, '空回复 400');
  const rImpl = await req('/api/consult-human-reply', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId, reply: 'x' } });
  assert.equal(rImpl.status, 403, 'impl 回复 → 403');
  const r = await req('/api/consult-human-reply', { method: 'POST', cookie: adminCookie, body: { project: PID, convId, reply: '结算按钮无反应通常是**收费权限**未开：到系统配置→角色权限里给该操作员勾选结算权限即可。' } });
  assert.equal(r.status, 200); assert.ok(r.json && r.json.ok);
  const d = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: adminCookie });
  const e = d.json.item; const chat = e.chat || [];
  const last = chat[chat.length - 1];
  assert.equal(last.role, 'assistant'); assert.equal(last.human, true, 'human:true 标记');
  assert.equal(last.byRole, 'admin'); assert.equal(last.by, ADMIN_NAME);
  assert.match(last.text, /收费权限/);
  assert.equal(e.humanReplied, true); assert.ok(e.humanReplyAt);
  const r2 = await req('/api/consult-escalations', { method: 'POST', cookie: adminCookie, body: { status: '已回复' } });
  assert.ok((r2.json.items || []).some(x => x.id === convId), 'escalations 按已回复筛出该条');
});

const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
test('FS-10 增强·持续双向人工对话：实施 human-message（含截图）落 chat（user human byRole:field + media）', async () => {
  // impl 在人工服务中发消息 → 直接进 chat、不调 AI；带一张截图 → 落盘 media
  const r = await req('/api/consult-human-message', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId, text: '还是不行，我把报错截图发你', images: [PNG_1PX] } });
  assert.equal(r.status, 200, 'impl human-message 允许（∈ FIELD_OK∩FS08）');
  assert.ok(r.json && r.json.ok);
  assert.ok(Array.isArray(r.json.media) && r.json.media.length === 1, '本轮截图落盘并回相对路径');
  const d = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: adminCookie });
  const e = d.json.item; const chat = e.chat || [];
  const last = chat[chat.length - 1];
  assert.equal(last.role, 'user', '现场人工消息 role=user');
  assert.equal(last.human, true, 'human:true 标记');
  assert.equal(last.byRole, 'field', 'byRole=field（区别运营 admin）');
  assert.equal(last.by, FIELD_NAME);
  assert.match(last.text, /报错截图/);
  assert.ok(Array.isArray(last.media) && last.media.length === 1, '截图挂到本条消息 media');
  assert.equal(e.humanReplied, false, '现场发言后回到「待回复」态');
  assert.ok(e.lastFieldMsgAt, 'lastFieldMsgAt 有值');
  // 空消息（无文本无图）→ 400
  const rEmpty = await req('/api/consult-human-message', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId, text: '  ' } });
  assert.equal(rEmpty.status, 400, '空消息 400');
});

test('FS-10 增强：运营 human-reply 带截图（运营也能发图）→ chat 末条含 media', async () => {
  const r = await req('/api/consult-human-reply', { method: 'POST', cookie: adminCookie, body: { project: PID, convId, reply: '看到了，这是权限问题，附我这边配置截图', images: [PNG_1PX] } });
  assert.equal(r.status, 200); assert.ok(r.json && r.json.ok);
  const d = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: adminCookie });
  const chat = d.json.item.chat || []; const last = chat[chat.length - 1];
  assert.equal(last.role, 'assistant'); assert.equal(last.human, true); assert.equal(last.byRole, 'admin');
  assert.ok(Array.isArray(last.media) && last.media.length === 1, '运营回复截图落盘 + 挂消息 media');
});

test('FS-10 增强：/api/field/conversations + escalations 透出 humanActive + 最后消息摘要', async () => {
  const rc = await req('/api/field/conversations', { cookie: fieldCookie });
  const ci = (rc.json.items || []).find(x => x.kind === 'consult' && x.id === convId);
  assert.ok(ci, 'conversations 列到该 consult');
  assert.equal(ci.humanActive, true, 'conversations 透出 humanActive=true');
  const rq = await req('/api/consult-escalations', { method: 'POST', cookie: adminCookie, body: {} });
  const qi = (rq.json.items || []).find(x => x.id === convId);
  assert.ok(qi, 'escalations 列到该条');
  assert.equal(qi.humanActive, true, 'escalations 透出 humanActive=true（进行中人工会话）');
  assert.ok(qi.lastMsgText, 'escalations 带最后消息摘要');
  assert.ok(['field', 'admin', 'ai', 'system'].includes(qi.lastMsgRole), 'lastMsgRole 归一');
});

test('FS-10 增强·结束人工服务：仅运营 human-end 置 humanActive=false + 系统提示 + 幂等；impl→403', async () => {
  // impl 无权结束
  const rImpl = await req('/api/consult-human-end', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId } });
  assert.equal(rImpl.status, 403, 'impl 调 human-end → 403（admin 限定）');
  // admin 结束
  const r = await req('/api/consult-human-end', { method: 'POST', cookie: adminCookie, body: { project: PID, convId } });
  assert.equal(r.status, 200); assert.ok(r.json && r.json.ok);
  const d = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: adminCookie });
  const e = d.json.item; const chat = e.chat || [];
  assert.equal(e.humanActive, false, 'humanActive=false（结束人工服务）');
  assert.ok(e.humanEndedAt && e.humanEndedBy, '记 humanEndedAt/By');
  const last = chat[chat.length - 1];
  assert.equal(last.system, true, '末条=系统提示消息');
  assert.match(last.text, /人工服务已结束/);
  // 幂等：再点返 alreadyEnded、不重复追加系统提示
  const chatLenBefore = chat.length;
  const r2 = await req('/api/consult-human-end', { method: 'POST', cookie: adminCookie, body: { project: PID, convId } });
  assert.equal(r2.status, 200); assert.ok(r2.json && r2.json.alreadyEnded, '幂等 alreadyEnded');
  const d2 = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: adminCookie });
  assert.equal((d2.json.item.chat || []).length, chatLenBefore, '幂等不重复追加系统提示');
});

test('FS-10 增强·结束后拒发：human-message 在非人工模式（humanActive=false）→ 409（前端据此恢复 AI 答疑）', async () => {
  const r = await req('/api/consult-human-message', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId, text: '结束后又发一条' } });
  assert.equal(r.status, 409, '非人工模式发 human-message → 409');
  assert.equal(r.json && r.json.humanActive, false, '回 humanActive:false 供前端切回 AI 模式');
});

test('FS-10 增强·白名单：human-message ∈ FIELD_OK∩FS08；human-end 不在任何 field/link 白名单（admin 限定）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  function grab(name) { const i = src.indexOf(name + ' = new Set(['); const j = src.indexOf('])', i); const body = src.slice(src.indexOf('[', i) + 1, j); return [...body.matchAll(/'([^']+)'/g)].map(m => m[1]); }
  const link = new Set(grab('const LINK_OK'));
  const fok = new Set(grab('const FIELD_OK'));
  const fs08 = new Set(grab('const FS08_FIELD_API'));
  assert.ok(fok.has('/api/consult-human-message') && fs08.has('/api/consult-human-message'), 'human-message ∈ FIELD_OK∩FS08（实施可发）');
  for (const ep of ['/api/consult-human-end', '/api/consult-human-reply', '/api/consult-escalations', '/api/consult-kb-draft']) {
    assert.ok(!link.has(ep) && !fok.has(ep) && !fs08.has(ep), ep + ' 不在任何 field/link 白名单（admin 限定）');
  }
});

test('FS-10 实时性增强：/api/field/conversations consult 项透出 humanReplyAt（实施端轮询判「新回复」所需）', async () => {
  // 实施端（impl）拉对话记录数据源，该条 consult 应带 escalated/humanReplied/humanReplyAt（人工回复后）。
  const r = await req('/api/field/conversations', { cookie: fieldCookie });
  assert.equal(r.status, 200);
  const items = (r.json && r.json.items) || [];
  const it = items.find(x => x.kind === 'consult' && x.id === convId);
  assert.ok(it, 'conversations 列到该 consult');
  assert.equal(it.escalated, true, '透出 escalated=true');
  assert.equal(it.humanReplied, true, '透出 humanReplied=true');
  assert.ok(Object.prototype.hasOwnProperty.call(it, 'humanReplyAt'), '出参含 humanReplyAt 字段');
  assert.ok(it.humanReplyAt, 'humanReplyAt 有值（人工回复后）→ 前端可据此判新');
});

test('AC-7 kb-draft：admin 返 {q,a}（无模型兜底=原问题/人工回复）；impl→403', async () => {
  const rImpl = await req('/api/consult-kb-draft', { method: 'POST', cookie: fieldCookie, body: { project: PID, convId } });
  assert.equal(rImpl.status, 403, 'impl kb-draft → 403');
  const r = await req('/api/consult-kb-draft', { method: 'POST', cookie: adminCookie, body: { project: PID, convId } });
  assert.equal(r.status, 200); assert.ok(r.json && r.json.ok);
  assert.match(r.json.q, /结算按钮/, 'q 兜底=原问题');
  // a 兜底=最后一条 human 运营回复（跳过 system 系统提示「人工服务已结束」）——本会话最后的运营回复是「这是权限问题…」
  assert.match(r.json.a, /权限问题/, 'a 兜底=最后一条人工回复（不含 system 系统提示）');
  assert.doesNotMatch(r.json.a, /人工服务已结束/, 'a 不能是 system 系统提示消息');
  assert.equal(r.json.subsystem, 'billing');
});

test('AC-8/9 沉淀 KB source=escalated + 反哺闭环（新条目可被检索到）', async () => {
  const save = await req('/api/kb-save', { method: 'POST', cookie: adminCookie, body: { project: PID, q: '收费模块结算按钮点了没反应怎么办', a: '结算按钮无反应通常是收费权限未开，到系统配置给操作员勾选结算权限即可。', subsystem: 'billing', source: 'escalated', from_ref: convId } });
  assert.equal(save.status, 200); assert.ok(save.json && save.json.ok);
  // kb-list 断言 source=escalated 落地
  const list = await req('/api/kb-list?project=' + PID, { cookie: adminCookie });
  const entries = (list.json && list.json.entries) || [];
  const hit = entries.find(x => /结算按钮/.test(x.q || ''));
  assert.ok(hit, '新 KB 条目在库');
  assert.equal(hit.from, 'escalated', 'from=escalated（内存对象）');
  // 反哺：kb-search（走 kbRetrieveScored 同款关键词召回 _kbScored）对同类问题命中新条目
  const kr = await req('/api/kb-search?project=' + PID + '&q=' + encodeURIComponent('结算按钮没反应'), { cookie: adminCookie });
  const found = (kr.json && kr.json.entries) || [];
  assert.ok(found.some(x => /结算按钮/.test(x.q || '')), '下次同类问题可检索到该新条目（反哺闭环）');
});

test('AC-3/4 白名单归属：escalate ∈ FIELD_OK∩FS08；escalations/human-reply/kb-draft 全不在任何 field/link 白名单', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  function grab(name) { const i = src.indexOf(name + ' = new Set(['); const j = src.indexOf('])', i); const body = src.slice(src.indexOf('[', i) + 1, j); return [...body.matchAll(/'([^']+)'/g)].map(m => m[1]); }
  const link = new Set(grab('const LINK_OK'));
  const fok = new Set(grab('const FIELD_OK'));
  const fs08 = new Set(grab('const FS08_FIELD_API'));
  assert.ok(fok.has('/api/consult-escalate') && fs08.has('/api/consult-escalate'), 'escalate ∈ FIELD_OK∩FS08（实施可发起）');
  for (const ep of ['/api/consult-escalations', '/api/consult-human-reply', '/api/consult-kb-draft']) {
    assert.ok(!link.has(ep) && !fok.has(ep) && !fs08.has(ep), ep + ' 不在任何 field/link 白名单（admin 限定 · deny-by-default）');
  }
  // 无漂移：FIELD_OK 的 /api 端点全 ∈ FS08_FIELD_API
  const drift = [...fok].filter(x => x.startsWith('/api/') && !fs08.has(x));
  assert.deepEqual(drift, [], 'FIELD_OK/api ⊆ FS08（无漂移）');
});

test('AC-10 隔离 lsy consult：/api/consult 分发行 + answer_audit + consultAnswerSemanticAudit 未被本次改动碰到', () => {
  // 静态守卫：确认新端点是「另起 if 分支」而非改到 consult 主体（新端点串在 server 里、consult 主体标识仍在）
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  assert.ok(src.includes("url.pathname === '/api/consult' && req.method === 'POST'"), 'consult 主分发仍在');
  assert.ok(src.includes('consultAnswerSemanticAudit') || src.includes('answer_audit') || src.includes('answerStream'), 'consult 答复流标识仍在');
  for (const ep of ['/api/consult-escalate', '/api/consult-escalations', '/api/consult-human-reply', '/api/consult-kb-draft']) {
    assert.ok(src.includes(`url.pathname === '${ep}' && req.method === 'POST'`), ep + ' 是独立 if 分支（外挂）');
  }
});
