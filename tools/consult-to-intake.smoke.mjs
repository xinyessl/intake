// FS-04 · 咨询「转工单」(/api/consult-to-intake) 端到端冒烟 —— 无 MySQL 也能跑真 HTTP。
//   本机无 MySQL（server boot `await db.init()` 失败即 exit），按 lessons L041 用 module.register loader hook
//   把 ./db.mjs 换成 db-stub（no-op + 从 fixture 目录读 accounts/projects 供鉴权/登录），其余全真（真路由/真文件存/真逻辑）。
//   验证链路（全真 HTTP · 走登录）：
//     1) impl 账号登录 → consult（无模型 → 降级文案，但仍落 type=consult 记录，拿 convId）
//     2) consult-to-intake {convId, type:requirement, title} → 建单成功、返回 id（XQ- 前缀）
//     3) intake-detail 断言：新工单 type=requirement/lifecycle=待处理/reporter=登录人/desc 含【咨询背景】+ Q:/A:/history note=由咨询转工单
//     4) 咨询记录被标 convertedTo=<新单 id>（防重复留痕）
//     5) BUG 无版本 → 400「报BUG 需产品版本」；越权 site 收敛（这里 consult 记录 site 收敛已在 consult 侧；转单沿用 src.site → convergeSite）
//     6) 白名单双 Set 无漂移（consult-to-intake ∈ FIELD_OK ∩ FS08_FIELD_API，且 FIELD_OK/api ⊆ FS08）
//   用法：node --test tools/consult-to-intake.smoke.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6800 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'ctismoke';                 // 隔离产品
const MY_SITE = 'CTI现场医院';           // 现场账号负责的医院
const FIELD_U = 'ctiimpl';              // 隔离现场账号（role=impl）
const FIELD_PW = 'CtiPass99';
const FIELD_NAME = 'CTI实施工';

let srv = null, fieldCookie = '', tmpData = '', tmpFix = '', convId = '';

function scrypt(pw, salt) { return crypto.scryptSync(String(pw), salt, 64).toString('hex'); }

function req(p, { method = 'GET', body, cookie, raw = false } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => raw
    ? ({ status: r.status, text: await r.text().catch(() => '') })
    : ({ status: r.status, setCookie: r.headers.get('set-cookie'), json: await r.json().catch(() => null) }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

before(async () => {
  // 1) fixture 目录：db-stub 从这里读 accounts/projects（真实结构，非 mock 字段）
  tmpFix = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-fix-'));
  const salt = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(tmpFix, 'accounts.json'), JSON.stringify([
    { id: 'uCti1', username: FIELD_U, role: 'impl', name: FIELD_NAME, projects: [PID], sites: [MY_SITE], salt, hash: scrypt(FIELD_PW, salt), mustChange: false, enabled: 1 },
  ]));
  fs.writeFileSync(path.join(tmpFix, 'projects.json'), JSON.stringify([
    { id: PID, name: 'CTI冒烟产品', subsystems: [{ name: 'billing', desc: '收费' }] },
  ]));

  // 2) 数据目录（INTAKE_DATA）：空目录 → 无 model-api.json（consult 走降级）；intake-store 落这里
  tmpData = fs.mkdtempSync(path.join(os.tmpdir(), 'cti-data-'));

  // 3) 起真 server（loader hook stub db.mjs），独立 PORT + INTAKE_DATA + CTI_FIXTURE
  srv = spawn('node', ['--import', path.join(ROOT, 'tools/cti-register.mjs'), path.join(ROOT, 'server.mjs')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), INTAKE_DATA: tmpData, CTI_FIXTURE: tmpFix, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  srv.stdout.on('data', d => { out += d; });
  srv.stderr.on('data', d => { out += d; });
  // 等端口可用
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    try { const r = await req('/api/health'); if (r.status === 200) break; } catch {}
    if (i === 59) { console.error('server boot output:\n' + out); throw new Error('server 未起来'); }
  }
});

after(async () => {
  if (srv) try { srv.kill('SIGKILL'); } catch {}
  try { fs.rmSync(tmpFix, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(tmpData, { recursive: true, force: true }); } catch {}
});

test('登录现场账号 + 造一条咨询记录（无模型走降级，但落 type=consult 拿 convId）', async () => {
  const lg = await req('/api/login', { method: 'POST', body: { username: FIELD_U, password: FIELD_PW } });
  assert.equal(lg.status, 200);
  assert.ok(lg.json && lg.json.ok, '登录成功 ' + JSON.stringify(lg.json));
  fieldCookie = (lg.setCookie || '').split(';')[0];
  assert.ok(fieldCookie.startsWith('intake_sess='));

  // consult 是 SSE，直接 fetch 读全文，抽 done{convId}
  const r = await fetch(BASE + '/api/consult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: fieldCookie },
    body: JSON.stringify({ project: PID, site: MY_SITE, subsystem: 'billing', messages: [{ role: 'user', content: '收费模块结算按钮点了没反应，是配置问题吗？' }] }),
  });
  assert.equal(r.status, 200);
  const text = await r.text();
  // 解析 SSE：找 done 事件里的 convId
  for (const line of text.split('\n')) {
    const s = line.trim(); if (!s.startsWith('data:')) continue;
    let o = null; try { o = JSON.parse(s.slice(5).trim()); } catch {}
    if (o && o.done && o.convId) convId = o.convId;
  }
  assert.ok(convId, 'consult 返回了 convId（记录已落库）：' + text.slice(0, 300));
  assert.ok(convId.startsWith('ZX-'), 'convId 为咨询前缀 ZX-：' + convId);
});

test('consult-to-intake：需求 → 建单成功，desc 含咨询背景，reporter/history 正确，咨询标 convertedTo', async () => {
  const r = await req('/api/consult-to-intake', {
    method: 'POST', cookie: fieldCookie,
    body: { convId, project: PID, type: 'requirement', title: '结算按钮无反应需排查修复' },
  });
  assert.equal(r.status, 200);
  assert.ok(r.json && r.json.ok && r.json.id, '建单返回 ok+id：' + JSON.stringify(r.json));
  const newId = r.json.id;
  assert.ok(newId.startsWith('XQ-'), '需求前缀 XQ-：' + newId);

  // 拉工单详情断言字段映射（连真存储：CACHE + intake-store 文件）
  const d = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(newId), { cookie: fieldCookie });
  assert.equal(d.status, 200);
  const it = d.json && d.json.item; assert.ok(it, '工单详情存在');
  assert.equal(it.type, 'requirement');
  assert.equal(it.lifecycle, '待处理');
  assert.equal(it.status, '待处理');
  assert.equal(it.reporter, FIELD_NAME, 'reporter=登录人（服务端取，不信前端）');
  assert.equal(it.site, MY_SITE, 'site 沿用咨询 site（在账号 sites 内、不收敛）');
  assert.equal(it.subsystem, 'billing');
  assert.equal(it.title, '结算按钮无反应需排查修复');
  // desc 咨询背景：含标题头 + Q:/A: 逐条
  assert.match(it.desc || '', /【咨询背景】/, 'desc 含【咨询背景】');
  assert.match(it.desc || '', /Q: 收费模块结算按钮/, 'desc 含原问句 Q:');
  // history 留痕
  assert.ok(Array.isArray(it.history) && it.history.length >= 1);
  assert.equal(it.history[0].to, '待处理');
  assert.equal(it.history[0].note, '由咨询转工单');
  assert.equal(it.history[0].by, FIELD_NAME);

  // 咨询记录被标 convertedTo=newId
  const cd = await req('/api/intake-detail?project=' + PID + '&id=' + encodeURIComponent(convId), { cookie: fieldCookie });
  const conv = cd.json && cd.json.item; assert.ok(conv, '咨询记录仍在');
  assert.equal(conv.convertedTo, newId, '咨询标 convertedTo=<新单 id>（防重复/留痕）');
});

test('BUG 无版本 → 400「报BUG 需产品版本」', async () => {
  const r = await req('/api/consult-to-intake', {
    method: 'POST', cookie: fieldCookie,
    body: { convId, project: PID, type: 'bug', title: '转成 BUG' },
  });
  assert.equal(r.status, 400);
  assert.match((r.json && r.json.error) || '', /版本/, '无版本报 BUG → 400 版本必填');
});

test('缺 convId / 非 consult 记录 → 400', async () => {
  const r1 = await req('/api/consult-to-intake', { method: 'POST', cookie: fieldCookie, body: { project: PID, type: 'requirement', title: 'x' } });
  assert.equal(r1.status, 400);
  const r2 = await req('/api/consult-to-intake', { method: 'POST', cookie: fieldCookie, body: { convId: 'ZX-99999999-99', project: PID, type: 'requirement', title: 'x' } });
  assert.equal(r2.status, 400);
  assert.match((r2.json && r2.json.error) || '', /咨询记录不存在/);
});

test('白名单双 Set 无漂移：consult-to-intake ∈ FIELD_OK ∩ FS08_FIELD_API，且 FIELD_OK/api ⊆ FS08', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  function grab(name) { const i = src.indexOf(name + ' = new Set(['); const j = src.indexOf('])', i); const body = src.slice(src.indexOf('[', i) + 1, j); return [...body.matchAll(/'([^']+)'/g)].map(m => m[1]).filter(x => x.startsWith('/api/')); }
  const fok = grab('const FIELD_OK'); const fs08 = new Set(grab('const FS08_FIELD_API'));
  assert.ok(fok.includes('/api/consult-to-intake'), 'consult-to-intake ∈ FIELD_OK');
  assert.ok(fs08.has('/api/consult-to-intake'), 'consult-to-intake ∈ FS08_FIELD_API');
  const drift = fok.filter(x => !fs08.has(x));
  assert.deepEqual(drift, [], 'FIELD_OK 的 /api 端点全 ∈ FS08_FIELD_API（无漂移）');
});
