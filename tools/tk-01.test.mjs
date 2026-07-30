// TK-01 · 工单管理 —— 接口 + 连真库冒烟测试 + 前端静态断言（零依赖，node --test）
//   【2026-07-21 裁决 re-target 原型】前端事实源 = 原型结构化单页 admin/tickets.html；public/inbox.html 重做成
//     流水线5环 + 富筛选(选择即查) + .data-table + 处理决策抽屉(三选一) + 查看抽屉 + 代提抽屉，数据接真实端点。
//     本文件末尾新增「前端静态断言」验证 inbox.html DOM 已按原型重做（AC-1/3/4/8/11~22/30）；后端连真库用例全部保留。
//   工单流转已工作，本单做「不破坏现有流转」的真实增量：
//     · 状态机新增 暂缓 / 已驳回 两态 + 合法流转（待处理/分析中→暂缓/已驳回；暂缓可复议→分析中/已立项/已重开；已驳回→已重开）。
//     · 落实开发（to=已立项）时把归入批次写进 data.batch（放 JSON、不加库列）；BP-01 未上线时批次可空、不阻断（NH-2）。
//     · stewardUC（steward UC 号）读写，落 data JSON。
//   做什么：
//     · 启动真实 server.mjs（连本地 MySQL data/db.json）到隔离端口；用 fetch 打真实端点。
//     · 覆盖 AC-13/15/17/18/27/28/29（+ 落实归批次、data.batch/stewardUC 落库回读、history 留痕）。
//     · 回归：既有流转链路（待处理→已立项→开发中→已出包→待验证→已关闭）仍正常，deriveLifecycle/lifecycleToStatus 兼容。
//     · 连真库冒烟：mysql2 直连真库，核对新态工单 lifecycle/status 列 + data JSON 内 batch/stewardUC/history 字段映射（护栏：只 mock 抓不到列名错配）。
//   为不污染真实数据：所有工单落在隔离产品 PID 下，after 精确删产品 + 兜底 DELETE FROM intakes/projects WHERE project_id=PID。
//   用法：node --test tools/tk-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'tk01smoke-' + Date.now().toString(36);   // 本次冒烟隔离产品（所有测试工单落这里，after 整体清）
let srv = null, cookie = '', pool = null;

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
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 造一条隔离工单（需求），返回 id
async function newTicket(title) {
  const r = await api('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'requirement', title, role: '产品经理', bg: 'x', reqDesc: 'y', site: 'TK01现场' } });
  assert.equal(r.json?.ok, true, '造工单应成功：' + JSON.stringify(r.json));
  return r.json.id;
}
// 直连真库读某工单原始行（lifecycle/status 列 + data JSON），核字段映射
async function dbRow(id) {
  const [rows] = await pool.query('SELECT lifecycle, status, data FROM intakes WHERE project_id=? AND id=?', [PID, id]);
  if (!rows.length) return null;
  const r = rows[0];
  const data = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  return { lifecycle: r.lifecycle, status: r.status, data };
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'TK-01 冒烟产品', subsystems: [{ key: 'a', name: '子系统甲' }] } });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
});

after(async () => {
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID } }); } catch {}
  // 兜底清库：删本次隔离产品的所有工单 + 产品行，绝不污染真库
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ============ 真库结构护栏：确认新态不越权改库（沿用现有列，暂缓/已驳回落 lifecycle 列 ≤20）============
test('[真库冒烟·结构] intakes 列基线未变（lifecycle/status VARCHAR(20)、data JSON），未新增库列', async () => {
  const [cols] = await pool.query('SHOW COLUMNS FROM intakes');
  const byName = Object.fromEntries(cols.map(c => [c.Field, c]));
  // 逐字核对：本单新增字段 batch/stewardUC 必须落 data JSON，绝不新增库列
  const expected = ['project_id', 'id', 'type', 'version', 'site', 'subsystem', 'module', 'title', 'priority', 'severity', 'env', 'freq', 'status', 'lifecycle', 'assignee', 'reporter', 'submitted_at', 'data', 'created_at', 'updated_at'];
  for (const f of expected) assert.ok(byName[f], `intakes 应有列 ${f}`);
  assert.equal(cols.length, expected.length, 'intakes 列数应仍为 20（本单不加库列，batch/stewardUC 放 data JSON）');
  assert.match(byName.lifecycle.Type, /varchar\(20\)/i, 'lifecycle 应 VARCHAR(20)（新态「暂缓/已驳回」≤20 安全）');
  assert.match(byName.status.Type, /varchar\(20\)/i, 'status 应 VARCHAR(20)');
  assert.match(byName.data.Type, /json/i, 'data 应为 JSON 列（batch/stewardUC/history 都嵌这里）');
});

// ============ AC-28 扩展枚举被接受：未知态仍 400，但 暂缓/已驳回 不再是未知态 ============
test('[AC-28] to=不存在的态 → 400「未知目标状态」；暂缓/已驳回 已入白名单不再报未知', async () => {
  const id = await newTicket('AC28-未知态');
  const bad = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '子虚乌有态' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json?.ok, false);
  assert.match(bad.json?.error || '', /未知目标状态/);
  // 暂缓 是合法态（从待处理可达）——不应报「未知目标状态」
  const good = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '暂缓', note: '排期紧张先缓' } });
  assert.equal(good.json?.ok, true, '暂缓应被接受：' + JSON.stringify(good.json));
});

// ============ AC-17 分支③暂缓 → 新增态 暂缓 + history 留痕 + 归「已处理」聚合 ============
test('[AC-17] 待处理→暂缓：lifecycle=暂缓、status=已处理、history 追加决策留痕', async () => {
  const id = await newTicket('AC17-暂缓');
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '暂缓', note: '等客户确认预算' } });
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.lifecycle, '暂缓');
  assert.equal(r.json?.item?.status, '已处理', '暂缓应映射旧 status=已处理（进「已关闭」聚合环）');
  // 真库回读：lifecycle 列 + data.history 留痕字段映射
  const row = await dbRow(id);
  assert.equal(row.lifecycle, '暂缓', '真库 lifecycle 列应落「暂缓」');
  assert.equal(row.status, '已处理', '真库 status 列应落「已处理」');
  const last = row.data.history[row.data.history.length - 1];
  assert.equal(last.to, '暂缓');
  assert.equal(last.from, '待处理');
  assert.equal(last.note, '等客户确认预算', 'history 应留决策原因');
  assert.ok(last.by && last.at, 'history 应含操作人 + 时间戳');
});

// ============ AC-18 分支③驳回 → 新增态 已驳回 ============
test('[AC-18] 待处理→已驳回：lifecycle=已驳回、history 留痕', async () => {
  const id = await newTicket('AC18-驳回');
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已驳回', note: '不符合产品方向' } });
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.lifecycle, '已驳回');
  const row = await dbRow(id);
  assert.equal(row.lifecycle, '已驳回');
  assert.equal(row.status, '已处理');
  const last = row.data.history[row.data.history.length - 1];
  assert.equal(last.to, '已驳回');
  assert.equal(last.note, '不符合产品方向');
});

// ============ 暂缓可复议、已驳回不复议（TRANSITIONS 扩展合法性）============
test('[扩展·复议] 暂缓→分析中/已立项 合法；已驳回→已立项 非法(400)、→已重开 合法', async () => {
  // 暂缓 → 已立项（复议直接立项）
  const idA = await newTicket('复议-暂缓转立项');
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: idA, to: '暂缓', note: '缓' } });
  const rA = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: idA, to: '已立项' } });
  assert.equal(rA.json?.ok, true, '暂缓→已立项 应合法（可复议）');

  // 已驳回 → 已立项 非法（驳回不复议）
  const idB = await newTicket('驳回-不可复议');
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: idB, to: '已驳回', note: '驳' } });
  const bad = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: idB, to: '已立项' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json?.ok, false);
  assert.match(bad.json?.error || '', /不能从「已驳回」直接流转到「已立项」/);
  // 已驳回 → 已重开 合法
  const ok = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: idB, to: '已重开' } });
  assert.equal(ok.json?.ok, true, '已驳回→已重开 应合法');
});

// ============ AC-13 分支①落实开发 → 已立项 + 归批次写 data.batch（BP-01 未上线可空）============
test('[AC-13] 落实开发 to=已立项 带 batch：lifecycle=已立项、data.batch 落库回读、history 留痕', async () => {
  const id = await newTicket('AC13-落实带批次');
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项', batch: 'B-3701', assignee: '开发甲', note: '本迭代排期' } });
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.lifecycle, '已立项');
  const row = await dbRow(id);
  assert.equal(row.lifecycle, '已立项');
  assert.equal(row.data.batch, 'B-3701', 'data.batch 应落库（放 JSON、非新列）');
  assert.equal(row.data.assignee, '开发甲');
  const last = row.data.history[row.data.history.length - 1];
  assert.equal(last.to, '已立项');
});

// ============ AC-13/NH-2 落实不带批次退化：允许、data.batch 留空、不阻断 ============
test('[AC-13·NH-2] 落实开发不带批次：流转成功、data.batch 留空、不阻断（BP-01 未上线退化）', async () => {
  const id = await newTicket('NH2-落实不带批次');
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项' } });
  assert.equal(r.json?.ok, true, '不带批次应仍允许落实（NH-2 推荐默认）');
  assert.equal(r.json?.lifecycle, '已立项');
  const row = await dbRow(id);
  assert.equal(row.lifecycle, '已立项');
  assert.ok(row.data.batch == null || row.data.batch === '', 'data.batch 应留空（未选批次不阻断）');
});

// ============ stewardUC 读写：落 data JSON、回读一致 ============
test('[扩展·stewardUC] 流转时携带 stewardUC 落 data JSON、真库回读一致', async () => {
  const id = await newTicket('stewardUC-回写');
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项', batch: 'B-9', stewardUC: 'UC-8842' } });
  const row = await dbRow(id);
  assert.equal(row.data.stewardUC, 'UC-8842', 'data.stewardUC 应落库回读（放 JSON、非新列）');
  // detail 接口也应带出 stewardUC（前端只读展示）
  const d = await api(`/api/intake-detail?project=${PID}&id=${id}`);
  assert.equal(d.json?.item?.stewardUC, 'UC-8842', 'intake-detail 应回带 stewardUC 供前端展示');
  assert.equal(d.json?.item?.batch, 'B-9', 'intake-detail 应回带 batch');
});

// ============ AC-15 分支②直接答复 → 已回复 + reply 进 chat + kbSunk ============
test('[AC-15] 直接答复 to=已回复：reply 进 chat(role=dev)、kbSunk=true、history 留痕', async () => {
  const id = await newTicket('AC15-直接答复');
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已回复', reply: '此功能已在 v2 支持，请升级' } });
  assert.equal(r.json?.ok, true);
  assert.equal(r.json?.lifecycle, '已回复');
  assert.equal(r.json?.kbSunk, true, '答复应自动沉淀经验库（to=已回复 触发）');
  const row = await dbRow(id);
  const devMsg = (row.data.chat || []).find(m => m.role === 'dev');
  assert.ok(devMsg && /已在 v2 支持/.test(devMsg.text), 'reply 应 push 进 chat（role=dev）');
});

// ============ AC-27 非法流转拒绝（现有链路合法性未被破坏）============
test('[AC-27] 待验证→已立项 非法 → 400，工单状态不变、无 history 追加', async () => {
  const id = await newTicket('AC27-非法流转');
  // 推到待验证
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项' } });
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '开发中' } });
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已出包', resolution: { fixedVersion: 'v1' } } });
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '待验证' } });
  const before = await dbRow(id);
  const histLen = before.data.history.length;
  const bad = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json?.error || '', /不能从「待验证」直接流转到「已立项」/);
  const after = await dbRow(id);
  assert.equal(after.lifecycle, '待验证', '非法流转后状态不变');
  assert.equal(after.data.history.length, histLen, '非法流转不应追加 history');
});

// ============ AC-29 强制关闭放行（任意非关闭态→已关闭）；已回复态也可强关 ============
test('[AC-29] 暂缓→已关闭 强制关闭放行，history 追加', async () => {
  const id = await newTicket('AC29-强制关闭');
  await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '暂缓', note: '缓' } });
  const r = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已关闭', note: '不再跟进' } });
  assert.equal(r.json?.ok, true, '任意非关闭态→已关闭 应放行（强制关闭）');
  const row = await dbRow(id);
  assert.equal(row.lifecycle, '已关闭');
  assert.equal(row.data.history[row.data.history.length - 1].to, '已关闭');
});

// ============ 回归：既有完整流转链路仍正常（不破坏部署）============
test('[回归] 待处理→已立项→开发中→已出包→待验证→已关闭 全链路仍通、kbSunk、列表 lifecycle 正确', async () => {
  const id = await newTicket('回归-完整链路');
  assert.equal((await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已立项', assignee: '甲' } })).json?.ok, true);
  assert.equal((await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '开发中' } })).json?.ok, true);
  // 非法：开发中→待验证 应被拒（证明合法性校验未松动）
  assert.equal((await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '待验证' } })).json?.ok, false);
  assert.equal((await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已出包', resolution: { fixedVersion: 'v9.9' } } })).json?.ok, true);
  assert.equal((await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '待验证' } })).json?.ok, true);
  const close = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id, to: '已关闭', note: '通过' } });
  assert.equal(close.json?.ok, true);
  assert.equal(close.json?.kbSunk, true, '关闭自动沉淀经验库（回归 to=已关闭 未受影响）');
  const list = await api('/api/intake-list?project=' + PID);
  assert.ok(list.json?.items?.some(x => x.id === id && x.lifecycle === '已关闭'), '列表应带出 lifecycle=已关闭');
});

// ============ 列表 AC-1/AC-2：字段齐全 + 更新时间倒序（部署 intake-list 现状）============
test('[AC-1/AC-2] intake-list 出参含 lifecycle/updatedAt 等字段，且默认按 updatedAt 倒序', async () => {
  const list = await api('/api/intake-list?project=' + PID);
  const items = list.json?.items || [];
  assert.ok(items.length >= 2, '应有多条工单');
  const s = items[0];
  for (const k of ['id', 'type', 'title', 'subsystem', 'version', 'site', 'priority', 'reporter', 'lifecycle', 'submittedAt', 'updatedAt']) {
    assert.ok(k in s, `列表项应含字段 ${k}`);
  }
  // 倒序：相邻项 updatedAt(降序) —— 部署 listIntake 用 localeCompare 倒序
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1].updatedAt || items[i - 1].submittedAt || '';
    const b = items[i].updatedAt || items[i].submittedAt || '';
    assert.ok(a >= b, '列表应按 updatedAt 倒序（最新在前）');
  }
});

// ============ 前端静态断言：public/inbox.html 已 re-target 成原型工单管理单页 ============
//   不起浏览器，直接读 HTML 断言原型 DOM/组件类/映射存在（AC-1/3/4/8/11~22/30 的界面落地证据）。
//   之所以做静态断言：抓「re-target 是否真做了」的回归——避免 inbox 又被改回旧「列表+归并」两视图。
const INBOX_HTML = fs.readFileSync(path.join(ROOT, 'public/inbox.html'), 'utf8');

test('[前端·外壳] inbox.html 仍是 UI-01 靛蓝外壳（引 theme.css + data-shell=admin + data-nav=inbox）', () => {
  assert.match(INBOX_HTML, /\/assets\/theme\.css/, '应引 theme.css（靛蓝 #3A4CA8 外壳唯一样式源）');
  assert.match(INBOX_HTML, /data-shell=["']admin["']/, '应有 data-shell=admin 套壳');
  assert.match(INBOX_HTML, /data-nav=["']inbox["']/, '导航高亮应为 inbox（工单管理）');
  assert.match(INBOX_HTML, /src=["']\/assets\/shell\.js["']/, '应引注入式 shell.js');
});

test('[前端·AC-3/4 流水线] inbox.html 含 .pipeline 5 环 + 点环筛选 + 原型环标签', () => {
  assert.match(INBOX_HTML, /class=["']pipeline["']|id=["']pipeline["']/, '应有状态流水线 .pipeline 容器');
  for (const label of ['待评审', '已落实', '开发中', '已交付', '已关闭']) {
    assert.ok(INBOX_HTML.includes(label), `流水线应含环标签「${label}」`);
  }
  assert.match(INBOX_HTML, /pipeline-step|pipeClick|ps-count/, '应有可点击的流水线环 + 计数');
});

test('[前端·AC-1 列表] inbox.html 用 .data-table 且含原型 10 列表头（编号/子系统/更新时间/操作 等）', () => {
  assert.match(INBOX_HTML, /class=["']data-table["']/, '列表应用 theme.css 的 .data-table');
  for (const col of ['编号', '类型', '标题', '子系统', '版本', '状态', '提交人', '更新时间', '操作']) {
    assert.ok(INBOX_HTML.includes(col), `列表表头应含「${col}」列`);
  }
});

test('[前端·子系统显中文] inbox.html 子系统一律显 subLabel(desc)、筛选/存值仍用英文 name（与实施端 field.html 一致）', () => {
  // 1) subLabel helper 存在，且从 curProjectObj.subsystems 查 desc、查不到回退原 name
  assert.match(INBOX_HTML, /function subLabel\s*\(/, '应有 subLabel(name→desc) helper（子系统显中文）');
  assert.match(INBOX_HTML, /curProjectObj[\s\S]{0,80}subsystems/, 'subLabel 应从 curProjectObj.subsystems 查');
  assert.match(INBOX_HTML, /s\.desc\s*\|\|/, 'subLabel 应取 desc、回退 name（desc||name||name）');
  // 2) 筛选下拉：option value=英文 name、显示 subLabel(中文)
  assert.match(INBOX_HTML, /<option value="\$\{esc\(s\)\}">\$\{esc\(subLabel\(s\)\)\}<\/option>/, '子系统筛选下拉 value=英文 name、显示 subLabel');
  // 3) 列表「子系统」列显 subLabel
  assert.match(INBOX_HTML, /esc\(subLabel\(i\.subsystem\)\)/, '列表子系统列应显 subLabel(i.subsystem)');
  // 4) 代提抽屉子系统下拉：value=英文 name、textContent=desc(中文)
  assert.match(INBOX_HTML, /o\.value=s\.name\|\|s\.key;\s*o\.textContent=s\.desc\|\|s\.name\|\|s\.key/, '代提子系统下拉 value=name、显示 desc');
  // 5) 查看/处理明细「产品·子系统」用 subLabel
  assert.match(INBOX_HTML, /subLabel\(t\.subsystem\)/, '处理抽屉明细子系统用 subLabel');
  assert.match(INBOX_HTML, /subLabel\(e\.subsystem\)/, '查看抽屉明细子系统用 subLabel');
  // 6) 筛选/提交取值绝不改成 desc：仍读 option.value（英文 name），匹配 intakes.subsystem
  assert.match(INBOX_HTML, /f\.sub=\$\('#fSub'\)\.value/, '筛选值仍取 #fSub.value（英文 name）');
  assert.match(INBOX_HTML, /i\.subsystem!==f\.sub/, '列表过滤仍按英文 name 匹配 intakes.subsystem');
  assert.match(INBOX_HTML, /subsystem:\$\('#ctSub'\)\.value/, '代提提交 subsystem 仍取 #ctSub.value（英文 name）');
});

test('[前端·数据形状] inbox.html 接真实端点 + type 英文映射中文 + lifecycle→UI标签映射（非 mock-data.js）', () => {
  assert.ok(!/mock-data\.js/.test(INBOX_HTML), '不得引原型 mock-data.js（必须接真实数据）');
  assert.match(INBOX_HTML, /\/api\/intake-list/, '应调真实 /api/intake-list 取数');
  assert.match(INBOX_HTML, /\/api\/intake-transition/, '处理决策应调真实 /api/intake-transition');
  assert.match(INBOX_HTML, /\/api\/intake-submit/, '代提工单应调真实 /api/intake-submit');
  // type 英文→中文映射（真实 type 是 bug/requirement/consult）
  assert.match(INBOX_HTML, /requirement|bug/, '应处理真实英文 type');
  // lifecycle→UI 标签映射：至少映射待处理/已立项 到 待评审/已落实
  assert.match(INBOX_HTML, /待处理|分析中/, '状态映射应覆盖真实 lifecycle 待处理/分析中');
});

test('[前端·AC-11~20 处理决策抽屉] #processDrawer 三选一（落实/答复/暂缓·驳回）+ 三分支表单字段', () => {
  assert.match(INBOX_HTML, /id=["']processDrawer["']/, '应有处理决策抽屉 #processDrawer');
  assert.match(INBOX_HTML, /decision-option/, '三选一应用 .decision-option（theme.css）');
  // 三分支：落实(已立项/batch) / 答复(已回复/reply) / 暂缓·驳回(暂缓/已驳回/原因)
  assert.match(INBOX_HTML, /落实|立项/, '分支①落实开发');
  assert.match(INBOX_HTML, /答复|回复/, '分支②直接答复');
  assert.match(INBOX_HTML, /暂缓/, '分支③暂缓');
  assert.match(INBOX_HTML, /驳回/, '分支③驳回');
  // 抽屉里要能选批次（BP-01 未上线 → 文本输入/占位）
  assert.match(INBOX_HTML, /批次|batch/i, '落实分支应有归入批次入口（NH-2 文本占位）');
});

test('[前端·AC-17/18 新态] inbox.html 状态映射/流水线含新增 暂缓 + 已驳回（L-002 前端镜像同步）', () => {
  assert.ok(INBOX_HTML.includes('暂缓'), '前端状态映射应含新态「暂缓」');
  assert.ok(INBOX_HTML.includes('已驳回'), '前端状态映射应含新态「已驳回」');
});

test('[前端·AC-22 查看抽屉 + AC-30 代提抽屉] #viewDrawer + #createDrawer 存在', () => {
  assert.match(INBOX_HTML, /id=["']viewDrawer["']/, '应有查看抽屉 #viewDrawer');
  assert.match(INBOX_HTML, /id=["']createDrawer["']/, '应有后台代提工单抽屉 #createDrawer');
  assert.match(INBOX_HTML, /detail\.html/, '查看抽屉应能衔接 detail.html 看完整详情');
});

test('[前端·AC-8 分页 + AC-9 重置 + AC-5 即选即查] 分页器 + 每页数选择 + 重置 + change 触发', () => {
  assert.match(INBOX_HTML, /page-size-select|每页|条\/页/, '应有每页条数选择（原型 10/20/50）');
  assert.match(INBOX_HTML, /pager|分页|goPage/, '应有分页器');
  assert.match(INBOX_HTML, /重置|reset/i, '应有筛选重置');
  assert.match(INBOX_HTML, /range-box|type=["']date["']/, '日期范围用单个 .range-box');
});

test('[前端·抽屉开关自实现] 不依赖 shell.js 的 UI.openDrawer（部署 shell.js 无此 API），用 .drawer.open/.drawer-mask', () => {
  // 关键：部署 shell.js 未提供 window.UI.openDrawer；inbox.html 必须自写 open/close（否则点「处理」抽屉打不开）
  assert.match(INBOX_HTML, /classList\.(add|toggle|remove)\(['"]open['"]\)|\.open|openDrawer|drawerOpen/i, '应自实现抽屉开关（.open 类）');
});
