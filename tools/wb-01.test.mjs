// WB-01 · 运营工作台 —— 接口 + 连真库冒烟测试（零依赖，node --test）
//   【裁决：前端事实源 = 部署实现（intake_bak/public/console.html + /api/overview），非原型】
//   工作台已部署工作（读时派生看板）。本单不重写，只：核对部署 vs spec → 回校 spec 成部署真相 →
//   补测试 + 连真库冒烟。代码增量 = 0（部署 /api/overview + console.html 已完整）。
//   覆盖的 AC（回校后按部署现状）：
//     · AC-1  /api/overview 结构含 projects/totals/recent/model
//     · AC-2  totals 键齐 + total=requirement+bug + consult 不计入
//     · AC-3~5 待处理/沟通中/已处理 计数按旧粗粒度 status（lifecycleToStatus）正确
//     · AC-5  【TK-01 新态对齐·关键】暂缓/已驳回 经 lifecycleToStatus 并入「已处理」，不漏算/错算
//     · AC-6  已归档 恒 0（旧归档态并入已处理，遗留保留键）
//     · AC-8  projects：count 正确、hasRepo 反映绑仓
//     · AC-9  recent ≤12、按 submittedAt 倒序、排除 consult、字段齐
//     · AC-13 未登录 → 401
//     · AC-14 空态（隔离新产品无进件）→ 计数 0、接口 200、不报错
//   连真库冒烟：mysql2 直连本地真库（data/db.json → 127.0.0.1:3306 intake），
//     核对聚合数字与真实 intakes.status/type + data JSON 一致（护栏：只 mock 抓不到列名/口径错配）。
//   为不污染真库：所有工单落在隔离产品 PID 下，after 精确删产品 + 兜底 DELETE FROM intakes/projects/kb_entries WHERE project_id=PID。
//   用法：node --test tools/wb-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5940 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'wb01smoke-' + Date.now().toString(36);   // 本次冒烟隔离产品（所有测试工单落这里，after 整体清）
let srv = null, cookie = '', pool = null;

function api(p, { method = 'GET', body, noCookie = false } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie && !noCookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const sc = r.headers.get('set-cookie'); if (sc && !noCookie) cookie = sc.split(';')[0];
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, ct, json: await r.json().catch(() => null) };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 造一条隔离进件，返回 id（可指定 type/title/site/version）
async function newTicket({ type = 'requirement', title, site = 'WB01现场', version = 'v1.0' }) {
  const body = { project: PID, type, title, role: '产品经理', site, version };
  if (type === 'bug') { body.desc = '现象描述'; body.steps = '步骤'; } else { body.bg = '背景'; body.reqDesc = '需求描述'; }
  const r = await api('/api/intake-submit', { method: 'POST', body });
  assert.equal(r.json?.ok, true, '造工单应成功：' + JSON.stringify(r.json));
  return r.json.id;
}
async function trans(id, to, extra = {}) {
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to, ...extra } });
  assert.equal(r.json?.ok, true, `流转到「${to}」应成功：` + JSON.stringify(r.json));
  return r.json;
}
// 取 overview 里本隔离产品的口径（从 recent 过滤 + projects 定位）
function overview() { return api('/api/overview'); }
function projRow(ov) { return (ov.json?.projects || []).find(p => p.id === PID); }
function myRecent(ov) { return (ov.json?.recent || []).filter(r => r.project === PID); }

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  // 隔离产品：不绑仓（hasRepo=false）用于 AC-8
  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'WB-01 冒烟产品', subsystems: [{ key: 'a', name: '子系统甲' }] } });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
});

after(async () => {
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID } }); } catch {}
  // 兜底清库：绝不污染真库
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ============ 真库结构护栏：确认聚合读的真实列/口径未臆造 ============
test('[真库冒烟·结构] intakes 有 status/type/data 列，lifecycleToStatus 口径可用（不臆造列）', async () => {
  const [cols] = await pool.query('SHOW COLUMNS FROM intakes');
  const byName = Object.fromEntries(cols.map(c => [c.Field, c]));
  for (const f of ['project_id', 'id', 'type', 'status', 'lifecycle', 'data', 'submitted_at']) assert.ok(byName[f], `intakes 应有列 ${f}`);
  assert.match(byName.status.Type, /varchar\(20\)/i, 'status 应 VARCHAR(20)（旧粗粒度桶）');
  assert.match(byName.data.Type, /json/i, 'data 应 JSON 列（submittedAt/type 等从 data 反序列化）');
});

// ============ AC-13 未登录 → 401 ============
test('[AC-13] 未登录 GET /api/overview → 401，不返回聚合数据', async () => {
  const r = await api('/api/overview', { noCookie: true });
  assert.equal(r.status, 401, '未登录应 401');
  assert.ok(!r.json?.totals, '401 不应带聚合数据');
});

// ============ AC-1/AC-14 隔离新产品无进件：结构齐 + 计数 0（空态降级）============
test('[AC-1/AC-14] /api/overview 结构含 projects/totals/recent/model；隔离产品初始 count=0 且接口 200', async () => {
  const ov = await overview();
  assert.equal(ov.status, 200);
  assert.match(ov.ct, /application\/json/, 'Content-Type 应为 json');
  const j = ov.json;
  for (const k of ['projects', 'totals', 'recent', 'model']) assert.ok(k in j, `overview 应含字段 ${k}`);
  assert.ok(Array.isArray(j.projects) && Array.isArray(j.recent), 'projects/recent 应为数组');
  const pr = projRow(ov);
  assert.ok(pr, '产品概览应含隔离产品');
  assert.equal(pr.count, 0, '隔离产品初始应 0 条进件（空态不报错）');
  assert.equal(pr.hasRepo, false, '未绑仓 → hasRepo=false（AC-8）');
});

// ============ AC-2/AC-8 造多条 → totals 增量、total=req+bug、count 正确 ============
test('[AC-2/AC-8] 造需求×2 + BUG×1：total 增 3、requirement/bug 分类正确、count=3、total=req+bug', async () => {
  const ov0 = await overview();
  const t0 = ov0.json.totals;
  await newTicket({ type: 'requirement', title: 'WB-需求A' });
  await newTicket({ type: 'requirement', title: 'WB-需求B' });
  await newTicket({ type: 'bug', title: 'WB-BUG-C' });

  const ov1 = await overview();
  const t1 = ov1.json.totals;
  assert.equal(t1.total - t0.total, 3, 'total 应增 3');
  assert.equal(t1.requirement - t0.requirement, 2, 'requirement 应增 2');
  assert.equal(t1.bug - t0.bug, 1, 'bug 应增 1');
  assert.equal(t1.total, t1.requirement + t1.bug, 'AC-2: total = requirement + bug（全局自洽）');
  const pr = projRow(ov1);
  assert.equal(pr.count, 3, 'AC-8: 隔离产品 count=3');
});

// ============ AC-3/AC-4 待处理/沟通中 计数（旧粗粒度 status）============
test('[AC-3/AC-4] 一条推到「分析中」→ 计入沟通中；新造一条留「待处理」→ 计入待处理', async () => {
  const ov0 = await overview();
  const t0 = ov0.json.totals;
  const id = await newTicket({ type: 'requirement', title: 'WB-流转到分析中' });     // 待处理
  // 待处理 → 分析中（status=沟通中）
  await trans(id, '分析中');
  const ovA = await overview();
  const tA = ovA.json.totals;
  assert.equal(tA['沟通中'] - t0['沟通中'], 1, 'AC-4: 进入分析中 → 沟通中 +1');
  // 新造一条留在待处理
  await newTicket({ type: 'bug', title: 'WB-留待处理' });
  const ovB = await overview();
  assert.equal(ovB.json.totals['待处理'] - tA['待处理'], 1, 'AC-3: 新建 BUG 留待处理 → 待处理 +1');
});

// ============ AC-5【TK-01 新态对齐·关键】暂缓/已驳回 并入「已处理」，不漏算 ============
test('[AC-5·TK-01] 暂缓 + 已驳回 各一条 → totals.已处理 +2（经 lifecycleToStatus 并入，不单列不漏算）', async () => {
  const ov0 = await overview();
  const done0 = ov0.json.totals['已处理'];

  const idBaowei = await newTicket({ type: 'requirement', title: 'WB-暂缓工单' });
  await trans(idBaowei, '暂缓', { note: '等预算' });
  const idBohui = await newTicket({ type: 'bug', title: 'WB-驳回工单' });
  await trans(idBohui, '已驳回', { note: '不符方向' });

  const ov1 = await overview();
  assert.equal(ov1.json.totals['已处理'] - done0, 2, 'AC-5: 暂缓+已驳回 应各并入「已处理」，共 +2');

  // 真库回读核对：这两条的 status 列 = 已处理、lifecycle 列保留细粒度（暂缓/已驳回）
  const [rows] = await pool.query('SELECT id, status, lifecycle FROM intakes WHERE project_id=? AND id IN (?,?)', [PID, idBaowei, idBohui]);
  const byId = Object.fromEntries(rows.map(r => [r.id, r]));
  assert.equal(byId[idBaowei].status, '已处理', '真库：暂缓工单 status 列应为「已处理」（进聚合桶）');
  assert.equal(byId[idBaowei].lifecycle, '暂缓', '真库：lifecycle 列保留「暂缓」细粒度');
  assert.equal(byId[idBohui].status, '已处理', '真库：已驳回工单 status 列应为「已处理」');
  assert.equal(byId[idBohui].lifecycle, '已驳回', '真库：lifecycle 列保留「已驳回」');

  // recent 中这两条 status 展示为「已处理」（前端状态点按此上色）
  const mine = myRecent(ov1);
  const rb = mine.find(r => r.id === idBaowei);
  assert.ok(rb && rb.status === '已处理', 'recent: 暂缓工单展示 status=已处理');
});

// ============ AC-6 已归档 恒 0（lifecycleToStatus 不产出「已归档」）============
test('[AC-6] totals.已归档 恒为 0（旧归档态已并入已处理，遗留保留键）', async () => {
  const ov = await overview();
  assert.equal(ov.json.totals['已归档'], 0, 'lifecycleToStatus 值域仅 待处理/沟通中/已处理 → 已归档 恒 0');
});

// ============ AC-9 recent ≤12、按 submittedAt 倒序、字段齐 ============
test('[AC-9] recent ≤12、按 submittedAt 倒序、每项字段齐（id/project/type/title/status/submittedAt）', async () => {
  const ov = await overview();
  const rec = ov.json.recent || [];
  assert.ok(rec.length <= 12, 'recent 至多 12 条');
  for (const it of rec) {
    for (const k of ['id', 'project', 'projectName', 'type', 'title', 'status', 'submittedAt']) assert.ok(k in it, `recent 项应含字段 ${k}`);
  }
  for (let i = 1; i < rec.length; i++) {
    assert.ok((rec[i - 1].submittedAt || '') >= (rec[i].submittedAt || ''), 'recent 应按 submittedAt 倒序（最新在前）');
  }
  // 本隔离产品的进件应出现在 recent（造的第一批 submittedAt 最新）
  assert.ok(myRecent(ov).length >= 1, '隔离产品进件应出现在 recent');
});

// ============ AC-12 model 状态字段存在（configured/provider）============
test('[AC-12] overview.model 含 configured/provider（modelchip 据此渲染）', async () => {
  const ov = await overview();
  const m = ov.json.model || {};
  assert.ok('configured' in m, 'model 应含 configured');
  assert.ok('provider' in m, 'model 应含 provider');
  assert.equal(typeof m.configured, 'boolean', 'configured 应为布尔');
});

// ============ 前端静态断言（re-target 原型 · 2026-07-21）：console.html 结构 ============
//   本次纯前端重做，无 mysql/http，直接读 public/console.html 断言原型元素落地（AC-7/7b/9/9b/12/12b）。
const CONSOLE = fs.readFileSync(path.join(ROOT, 'public/console.html'), 'utf8');

test('[AC-7·前端] 5 张 stat-card（grid-cols-5）· 前 3 卡派生自 totals 且可下钻 ?pipe=', () => {
  assert.ok(/grid-cols-5/.test(CONSOLE), '统计卡应用 .grid-cols-5 栅格');
  // 用 theme.css 组件类 .stat-card（护栏：不自造卡片样式）
  assert.ok(/class="stat-card/.test(CONSOLE) || /stat-card \$\{/.test(CONSOLE), '应用 theme.css .stat-card');
  assert.ok(/stat-card-value/.test(CONSOLE) && /stat-card-label/.test(CONSOLE) && /stat-card-icon/.test(CONSOLE), 'stat-card 应含 value/label/icon 子元素');
  // 5 张卡的 label 全在
  for (const label of ['待评审', '进行中', '已处理', '本周待发包批次', '本月已交付']) {
    assert.ok(CONSOLE.includes(label), `统计卡应含「${label}」卡`);
  }
  // 前 3 卡值派生自三桶
  assert.ok(/t\['待处理'\]/.test(CONSOLE) && /t\['沟通中'\]/.test(CONSOLE) && /t\['已处理'\]/.test(CONSOLE), '前 3 卡值应派生自 totals.待处理/沟通中/已处理');
  // 下钻走 ?pipe=（inbox 端 lifecycle 精确筛选）
  assert.ok(/inbox\.html\?pipe=待评审/.test(CONSOLE), '待评审卡应下钻 ?pipe=待评审');
  assert.ok(/inbox\.html\?pipe=开发中/.test(CONSOLE), '进行中卡应下钻 ?pipe=开发中');
  assert.ok(/inbox\.html\?pipe=已关闭/.test(CONSOLE), '已处理卡应下钻 ?pipe=已关闭');
});

test('[AC-7b·前端] 批次/本月交付两卡为占位（0/—）+ NEEDS-HUMAN，不臆造数值、不可点击', () => {
  // 占位标记 ph:'batch' / ph:'month'，占位卡不加 clickable、无 location.href
  assert.ok(/ph:\s*'batch'/.test(CONSOLE), '本周待发包批次卡应标 ph:batch 占位');
  assert.ok(/ph:\s*'month'/.test(CONSOLE), '本月已交付卡应标 ph:month 占位');
  // 占位卡值硬编码 '0' / '—'（不从后端臆造）
  assert.ok(/value:'0'|value:\s*'0'/.test(CONSOLE), '批次占位值应为 0');
  assert.ok(CONSOLE.includes("value:'—'") || /value:\s*'—'/.test(CONSOLE), '本月交付占位值应为 —');
  // NEEDS-HUMAN 可视提示存在
  assert.ok(/NEEDS-HUMAN/.test(CONSOLE), '占位区应有 NEEDS-HUMAN 提示');
  // 占位卡不带 clickable（renderStats 里 clickable=!s.ph）
  assert.ok(/clickable\s*=\s*!s\.ph/.test(CONSOLE), '占位卡应据 s.ph 关闭 clickable');
});

test('[AC-9/9b·前端] 最近工单 data-table：列头齐 + 现场用 site + 更新时间用 submittedAt（不臆造 customer/updatedAt）', () => {
  assert.ok(/class="data-table"/.test(CONSOLE), '最近工单应用 theme.css .data-table');
  for (const th of ['编号 / 类型', '标题', '现场', '状态', '更新时间']) {
    assert.ok(CONSOLE.includes(th), `最近工单表头应含「${th}」`);
  }
  // 现场用 i.site（非原型 customer）、时间用 i.submittedAt（非 updatedAt）
  assert.ok(/i\.site/.test(CONSOLE), '现场列应用真实字段 i.site');
  assert.ok(/fmtTime\(i\.submittedAt\)/.test(CONSOLE), '更新时间列应用 fmtTime(i.submittedAt)');
  assert.ok(!/i\.customer/.test(CONSOLE), '不应臆造 i.customer（真实端点无此字段，L-004）');
  assert.ok(!/i\.updateTime|i\.updatedAt/.test(CONSOLE), '最近工单不应臆造 i.updatedAt（recent 只给 submittedAt）');
  // 行下钻详情（AC-10）
  assert.ok(/detail\.html\?project=\$\{encodeURIComponent\(i\.project\)\}&id=\$\{encodeURIComponent\(i\.id\)\}/.test(CONSOLE), '行点击应跳 detail.html?project=&id=');
});

test('[AC-11·前端] fmtTime 输出 yyyy-MM-dd HH:mm、空值 —', () => {
  // 从 console.html 抽出 fmtTime 函数体执行断言（单行定义，取该行 { … } 内部）
  const line = CONSOLE.split('\n').find(l => l.includes('function fmtTime(v)'));
  assert.ok(line, '应含 fmtTime 定义（单行）');
  const body = line.slice(line.indexOf('{') + 1, line.lastIndexOf('}'));
  const fmtTime = new Function('v', body);
  assert.equal(fmtTime('2026-07-17 09:40:12'), '2026-07-17 09:40', '空格分隔串 → yyyy-MM-dd HH:mm');
  assert.equal(fmtTime('2026-07-17T09:40:00'), '2026-07-17 09:40', 'ISO 串 → yyyy-MM-dd HH:mm');
  assert.equal(fmtTime(''), '—', '空值 → —');
  assert.equal(fmtTime(null), '—', 'null → —');
});

test('[AC-12b·前端] 本周批次 panel 为占位（暂未开放 + NEEDS-HUMAN），不臆造批次数据', () => {
  assert.ok(/本周批次/.test(CONSOLE), '应有本周批次 panel');
  assert.ok(/暂未开放|BP-01/.test(CONSOLE), '批次 panel 应显占位/未开放说明');
  // 全走 theme.css 组件类 .card（护栏）
  assert.ok(/class="card"/.test(CONSOLE), 'panel 应用 theme.css .card');
});

test('[前端·外壳护栏] body data-shell=admin data-nav=console + 引 theme.css（未破坏 UI-01 外壳）', () => {
  assert.ok(/data-shell="admin"/.test(CONSOLE), 'body 应 data-shell="admin"（UI-01 外壳）');
  assert.ok(/data-nav="console"/.test(CONSOLE), 'body 应 data-nav="console"');
  assert.ok(/\/assets\/theme\.css/.test(CONSOLE), '应引 theme.css');
  assert.ok(/\/assets\/shell\.js/.test(CONSOLE), '应引 shell.js 注入外壳');
  // 不再引旧 nav.js（.topnav 已废弃）
  assert.ok(!/topnav/.test(CONSOLE), '不应残留旧 .topnav 结构');
});

// ============ 交叉核对：overview.totals 与直连真库 SQL 聚合一致（护栏：口径不飘）============
test('[真库冒烟·交叉核对] overview 隔离产品计数 == 直连真库 SQL 聚合（status/type 口径一致）', async () => {
  const ov = await overview();
  const pr = projRow(ov);
  // 直连真库：本隔离产品 非 consult 进件数（count 口径）
  const [[{ n: nonConsult }]] = await pool.query(
    `SELECT COUNT(*) n FROM intakes WHERE project_id=? AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.type')) <> 'consult'`, [PID]);
  assert.equal(pr.count, Number(nonConsult), 'overview 产品 count 应等于真库非 consult 进件数');
  // 直连真库：本产品各 status 桶（用 status 列，与 overview 同口径）
  const [buckets] = await pool.query(
    `SELECT status, COUNT(*) n FROM intakes WHERE project_id=? AND JSON_UNQUOTE(JSON_EXTRACT(data,'$.type')) <> 'consult' GROUP BY status`, [PID]);
  const dbBy = Object.fromEntries(buckets.map(b => [b.status, Number(b.n)]));
  // overview totals 是全局的，无法直接减出单产品；改为断言"本产品各态数量 ≤ 全局对应桶"且总和自洽
  const mineTotal = Object.values(dbBy).reduce((a, b) => a + b, 0);
  assert.equal(pr.count, mineTotal, '本产品 status 桶求和应等于 count（口径自洽）');
  for (const st of Object.keys(dbBy)) {
    assert.ok((ov.json.totals[st] || 0) >= dbBy[st], `全局 totals.${st} 应 ≥ 本产品该桶数（${dbBy[st]}）`);
  }
});
