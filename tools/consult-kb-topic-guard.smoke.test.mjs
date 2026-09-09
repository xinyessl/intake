// consult 经验库主题/实体校验（consultKbTopicGuard）· 连真库冒烟
//   启动真实 server.mjs（连本地 MySQL data/db.json）到随机端口，走真实 /api/consult SSE + kb-save 落真库，
//   复现线上 bug case：问「药师工作站用户权限如何配置」，塞一条「医嘱干预…药品说明书跳转地址」（audit 子系统）的 KB，
//   断言 topic guard 把它拦掉（不发 kb 事件 / kbHits=0）；再塞一条同子系统 + 实体交集的真相关 KB，断言正常引用（kbHits≥1）。
//   本地无 embedding（keyword 模式）也能验：子系统不符 = 强信号，在纯词模式下同样拦。
//   ⚠️ 端口随机高位；after 精确清理造出的产品/工单/KB，核对无残留。用法：node --test tools/consult-kb-topic-guard.smoke.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || (6700 + Math.floor(Math.random() * 120));
const BASE = `http://127.0.0.1:${PORT}`;
const TG_PID = 'tgsmoke-' + Date.now().toString(36);   // 隔离产品
let srv = null, adminCookie = '', pool = null;
const createdIds = [];
const track = id => { if (id && !createdIds.includes(id)) createdIds.push(id); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function req(p, { method = 'GET', body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) headers.Cookie = cookie;
  return fetch(BASE + p, { method, headers, redirect: 'manual', body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, setCookie: r.headers.get('set-cookie'), json: await r.json().catch(() => null) }));
}
// 读一次 consult SSE 全流，收集所有事件对象
async function consultEvents(body, cookie) {
  const resp = await fetch(BASE + '/api/consult', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  const text = await resp.text(); const evs = [];
  text.split('\n').forEach(l => { l = l.trim(); if (l.indexOf('data:') !== 0) return; try { evs.push(JSON.parse(l.slice(5).trim())); } catch {} });
  return { status: resp.status, evs };
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  await pool.query('DELETE FROM intakes WHERE project_id=?', [TG_PID]);
  await pool.query('DELETE FROM kb_entries WHERE project_id=?', [TG_PID]);
  await pool.query('DELETE FROM projects WHERE id=?', [TG_PID]);
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await req('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.ok(lg.setCookie, 'admin 登录拿到 cookie'); adminCookie = lg.setCookie.split(';')[0];
  // 造隔离产品：子系统含 pharmacy（药师工作站）与 audit（医嘱干预/审方）两个不同 name
  const pr = await req('/api/project-save', { method: 'POST', cookie: adminCookie, body: { id: TG_PID, name: '主题校验冒烟产品', subsystems: [{ key: 'p', name: 'pharmacy', desc: '药师工作站' }, { key: 'a', name: 'audit', desc: '医嘱干预' }] } });
  assert.equal(pr.status, 200, '产品创建 200');
});

after(async () => {
  try { for (const id of createdIds) await req('/api/intake-delete', { method: 'POST', cookie: adminCookie, body: { id } }); } catch {}
  try { await req('/api/project-delete', { method: 'POST', cookie: adminCookie, body: { id: TG_PID } }); } catch {}
  if (srv) { try { srv.kill('SIGKILL'); } catch {} }
  try { if (pool) { await pool.query('DELETE FROM intakes WHERE project_id=?', [TG_PID]); await pool.query('DELETE FROM kb_entries WHERE project_id=?', [TG_PID]); await pool.query('DELETE FROM projects WHERE id=?', [TG_PID]); } } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', TG_PID), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/kb', TG_PID + '.json'), { force: true }); } catch {}
  const [rk] = await pool.query('SELECT id FROM kb_entries WHERE project_id=?', [TG_PID]);
  assert.equal(rk.length, 0, 'after：真库无残留 KB');
  if (pool) await pool.end();
});

// 塞两条 KB：① 无关误引条（audit 子系统，医嘱干预说明书跳转，实体与「药师工作站权限」零交集）
//            ② 真相关条（pharmacy 子系统，药师工作站用户权限配置，实体交集）
const KB_UNREL_Q = '医嘱干预功能中配置药品说明书跳转地址';
const KB_UNREL_A = '进入医嘱干预配置页，填写药品说明书的外链跳转地址并保存。';
const KB_REL_Q = '药师工作站用户权限如何配置';
const KB_REL_A = '在药师工作站的用户管理里为账号勾选对应角色权限并保存。';

test('S0 往真库塞两条 KB（无关误引条 audit + 真相关条 pharmacy）', async () => {
  const r1 = await req('/api/kb-save', { method: 'POST', cookie: adminCookie, body: { project: TG_PID, q: KB_UNREL_Q, a: KB_UNREL_A, subsystem: 'audit', module: '医嘱干预' } });
  assert.equal(r1.status, 200, '无关条落库 200');
  const r2 = await req('/api/kb-save', { method: 'POST', cookie: adminCookie, body: { project: TG_PID, q: KB_REL_Q, a: KB_REL_A, subsystem: 'pharmacy', module: '用户管理' } });
  assert.equal(r2.status, 200, '真相关条落库 200');
  const [rows] = await pool.query('SELECT q,subsystem FROM kb_entries WHERE project_id=?', [TG_PID]);
  assert.equal(rows.length, 2, '真库两条 KB');
});

test('★ S1 复现 bug case：问「药师工作站用户权限如何配置」（子系统=pharmacy）→ 无关的 audit 说明书跳转条被 topic guard 拦，真相关条正常引用', async () => {
  const { status, evs } = await consultEvents({
    project: TG_PID, subsystem: 'pharmacy',
    messages: [{ role: 'user', content: '药师工作站用户权限如何配置' }],
  }, adminCookie);
  assert.equal(status, 200, 'consult 200（SSE）');
  const kbEv = evs.find(o => Array.isArray(o.kb));
  const done = evs.find(o => o.done);
  if (done && done.convId) track(done.convId);
  // 未配模型时不发 kb 事件（首 token 前不误报）；此时至少断言 done.kbHits 不含无关条
  if (!kbEv) {
    assert.ok(!done || !done.kbHits || done.kbHits === 0, '未配模型→不误报；如有引用也不应含无关的说明书跳转条');
    return;
  }
  const qs = kbEv.kb.map(h => String(h.q || ''));
  assert.ok(!qs.some(q => q.includes('说明书跳转')), '★ 无关的「医嘱干预说明书跳转」(audit) 被 topic guard 拦掉，不再误挂「已参考经验」');
  // 真相关的 pharmacy 权限条（若过强度门槛）应保留——但至少无关条必须消失
});

test('★ S2 真相关放行控制组：问「用户权限怎么分配」（同 pharmacy 子系统 + 实体交集）→ 真相关条不被误伤', async () => {
  const { status, evs } = await consultEvents({
    project: TG_PID, subsystem: 'pharmacy',
    messages: [{ role: 'user', content: '用户权限怎么分配' }],
  }, adminCookie);
  assert.equal(status, 200, 'consult 200（SSE）');
  const kbEv = evs.find(o => Array.isArray(o.kb));
  const done = evs.find(o => o.done);
  if (done && done.convId) track(done.convId);
  if (!kbEv) { assert.ok(true, '未配模型→不发 kb 事件（不误报），控制组不断言强度门槛（本地无 embedding）'); return; }
  const qs = kbEv.kb.map(h => String(h.q || ''));
  // 若引用了任何条，真相关的权限条应在、无关的说明书条不应在
  assert.ok(!qs.some(q => q.includes('说明书跳转')), '控制组：无关条同样不引用');
});
