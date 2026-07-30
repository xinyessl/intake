// KB-01 · 经验库 —— 接口 + 连真库冒烟测试（零依赖，node --test）
//   启动真实 server.mjs（连本地 MySQL data/db.json）到隔离端口，用 fetch 打真实端点；
//   另用 mysql2 直连真库核对 kb_entries 表字段映射（q/a/subsystem/module/tags(JSON)/source/from_ref/created_at）。
//   覆盖：kb-list / kb-save（新增·编辑·空 q/a→400·q 截断·【KB-01 微扩】source+from_ref 落库）/ kb-delete /
//         kb-from-consult（正常·空→400）/ intake-transition→已关闭 自动沉淀 kbSunk true→false（AC-14/15）。
//   + 前端静态断言：public/kb.html 已 re-target 至臻遴原型（六列 data-table / 8-20-50 分页 / 查看+编辑抽屉自实现 /
//     来源筛选 / n100 计数 / 接真实端点 + 真实字段 q/a/from/at / uiConfirm 删除）——无需 server。
//   全程用隔离 smoke 产品 + kb-<ts> 前缀，结束清理 DB 行，不污染真实数据（跑完 kb_entries 无残留测试行）。
//   用法：node --test tools/kb-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5200 + Math.floor(Math.random() * 700);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'kbsmoke-' + Date.now().toString(36);          // 本次冒烟隔离产品 id
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

before(async () => {
  // 直连真库（核对字段映射用），同 server.mjs 读的 data/db.json（本地 127.0.0.1:3306 intake 库）
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  // 预清理：万一上次残留（本产品 kb 行 + 产品行）
  await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]);
  await pool.query('DELETE FROM projects WHERE id=?', [PID]);
  // 启动真实服务到隔离端口（连真库）
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  // 造一个隔离产品（带一个子系统，供 AC-3 子系统落库/展示核对）
  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'KB 冒烟产品', subsystems: [{ key: 'core', name: '核心子系统', desc: '用药审查规则' }] } });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
});

after(async () => {
  // 清理：删本产品全部 kb 行 + 解除登记 + 删产品行（幂等），跑完真库无残留测试数据
  try { if (pool) await pool.query('DELETE FROM kb_entries WHERE project_id=?', [PID]); } catch {}
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID } }); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/kb', PID + '.json'), { force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', PID), { recursive: true, force: true }); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

/* ============ 鉴权（§6 数据权限：kb-list/save/delete 仅管理端） ============ */
test('AC-鉴权 未登录访问 /api/kb-list → 401（authGate 拦截，非 FIELD_OK）', async () => {
  const saved = cookie; cookie = '';
  const r = await api('/api/kb-list?project=' + PID);
  cookie = saved;
  assert.equal(r.status, 401);
});

/* ============ AC-1 列表加载 + AC-7 空态 ============ */
test('AC-1/AC-7 空产品 kb-list → entries 空数组（产品存在但无条目）', async () => {
  const r = await api('/api/kb-list?project=' + PID);
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.entries));
  assert.equal(r.json.entries.length, 0, '新产品应无经验条目');
});

test('AC-1 不存在产品 kb-list → entries 空数组（projById 返回 null，不兜底）', async () => {
  const r = await api('/api/kb-list?project=__no_such_proj__');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.entries, []);
});

/* ============ AC-8 人工新增 + AC-9 必填 + AC-10 长度 ============ */
test('AC-9 kb-save 空 q 或空 a → 400「问题和解法都要填」（服务端纵深校验）', async () => {
  const r1 = await api('/api/kb-save', { method: 'POST', body: { project: PID, q: '', a: '有答案' } });
  assert.equal(r1.status, 400);
  assert.match(r1.json.error, /问题和解法都要填/);
  const r2 = await api('/api/kb-save', { method: 'POST', body: { project: PID, q: '有问题', a: '' } });
  assert.equal(r2.status, 400);
});

test('AC-8 人工新增（不带 source/from_ref）→ from=manual、at=时间戳、tags 数组；列表出现该条', async () => {
  const body = { project: PID, q: '审方误报：两药提示冲突但可联用', a: '临床可联用，规则加白名单即可。**注意**监测。', subsystem: '核心子系统', module: '用药审查规则', tags: ['误报', '相互作用'] };
  const r = await api('/api/kb-save', { method: 'POST', body });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const rec = r.json.entries.find(e => e.q.startsWith('审方误报'));
  assert.ok(rec, '返回条目应含新增条');
  assert.equal(rec.from, 'manual', '缺省来源 → from=manual（与旧实现一致）');
  assert.match(rec.at, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'at 为 yyyy-MM-dd HH:mm 时间戳');
  assert.ok(Array.isArray(rec.tags) && rec.tags.length === 2, 'tags 为数组');
  assert.equal(rec.subsystem, '核心子系统');
});

test('AC-10 q 超 400 → 服务端截断到 400（对齐现有实现）', async () => {
  const longQ = 'X'.repeat(500);
  const r = await api('/api/kb-save', { method: 'POST', body: { project: PID, q: longQ, a: '答' } });
  assert.equal(r.json.ok, true);
  const rec = r.json.entries.find(e => e.q.startsWith('X'));
  assert.equal(rec.q.length, 400, 'q 应被截断到 400');
});

/* ============ KB-01 微扩（本单唯一实质增量）：kb-save 接受 source / from_ref ============ */
test('KB-01 微扩：kb-save 带 source=auto + from_ref=工单id → 落库 source=auto、from_ref=工单id（对齐 BUG沉淀口径）', async () => {
  const TICKET = 'BUG-KB01-SMOKE';
  const r = await api('/api/kb-save', { method: 'POST', body: { project: PID, q: '来源工单的经验', a: '已修复，见提交。', source: 'auto', from_ref: TICKET } });
  assert.equal(r.json.ok, true);
  const rec = r.json.entries.find(e => e.q === '来源工单的经验');
  assert.ok(rec, '返回应含该条');
  assert.equal(rec.from, TICKET, '内存 from = 工单 id（replaceKB 依此派生）');
  // 连真库回读：断言真实列名 from_ref（下划线）+ source
  const [rows] = await pool.query('SELECT source, from_ref FROM kb_entries WHERE project_id=? AND id=?', [PID, rec.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, 'auto', '库 source 应派生为 auto');
  assert.equal(rows[0].from_ref, TICKET, '库 from_ref（下划线列名）应为工单 id');
});

test('KB-01 微扩：kb-save 带 source=consult → 落库 source=consult、from_ref=consult', async () => {
  const r = await api('/api/kb-save', { method: 'POST', body: { project: PID, q: '答疑沉淀条', a: '排名按处方合格率算。', source: 'consult' } });
  assert.equal(r.json.ok, true);
  const rec = r.json.entries.find(e => e.q === '答疑沉淀条');
  const [rows] = await pool.query('SELECT source, from_ref FROM kb_entries WHERE project_id=? AND id=?', [PID, rec.id]);
  assert.equal(rows[0].source, 'consult');
  assert.equal(rows[0].from_ref, 'consult');
});

test('KB-01 微扩：kb-save 显式 source=manual → 落库 source=manual、from_ref=manual（与缺省等价）', async () => {
  const r = await api('/api/kb-save', { method: 'POST', body: { project: PID, q: '显式人工条', a: '手工补充。', source: 'manual' } });
  assert.equal(r.json.ok, true);
  const rec = r.json.entries.find(e => e.q === '显式人工条');
  const [rows] = await pool.query('SELECT source, from_ref FROM kb_entries WHERE project_id=? AND id=?', [PID, rec.id]);
  assert.equal(rows[0].source, 'manual');
  assert.equal(rows[0].from_ref, 'manual');
});

/* ============ AC-11 编辑回填 + 保存（保留 from/at/id） ============ */
test('AC-11 编辑（带 id）→ 原地更新，保留 from/at/id，计数不变', async () => {
  // 先取一条已存在的 manual 条
  const list0 = (await api('/api/kb-list?project=' + PID)).json.entries;
  const target = list0.find(e => e.q.startsWith('审方误报'));
  assert.ok(target);
  const beforeCount = list0.length, beforeAt = target.at, beforeFrom = target.from;
  const r = await api('/api/kb-save', { method: 'POST', body: { project: PID, id: target.id, q: '审方误报（已修订）', a: target.a, subsystem: target.subsystem, module: '用药审查规则v2', tags: ['误报'] } });
  assert.equal(r.json.ok, true);
  const after = r.json.entries.find(e => e.id === target.id);
  assert.equal(after.q, '审方误报（已修订）', '问题应更新');
  assert.equal(after.module, '用药审查规则v2', '模块应更新');
  assert.equal(after.from, beforeFrom, 'from 应保留（编辑不改来源）');
  assert.equal(after.at, beforeAt, 'at 应保留');
  assert.equal(r.json.entries.length, beforeCount, '编辑不改变条目数');
});

/* ============ 连真库冒烟：真实 kb_entries 列名映射核对 ============ */
test('连真库冒烟：真实 kb_entries 行的列名 q/a/subsystem/module/tags(JSON)/source/from_ref/created_at 映射无错配', async () => {
  const list = (await api('/api/kb-list?project=' + PID)).json.entries;
  const rec = list.find(e => e.q.startsWith('审方误报'));
  assert.ok(rec, '应能读回编辑后的条目');
  const [rows] = await pool.query(
    'SELECT id,project_id,q,a,subsystem,module,tags,source,from_ref,created_at FROM kb_entries WHERE project_id=? AND id=?',
    [PID, rec.id]);
  assert.equal(rows.length, 1, 'DB 应有该行');
  const row = rows[0];
  assert.equal(row.q, '审方误报（已修订）', 'q 列');
  assert.equal(row.subsystem, '核心子系统', 'subsystem 列（中文子系统名）');
  assert.equal(row.module, '用药审查规则v2', 'module 列');
  const tags = typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags;
  assert.ok(Array.isArray(tags) && tags[0] === '误报', 'tags 为 JSON 数组');
  assert.equal(row.source, 'manual', 'source 列（内存 from=manual → 派生 manual）');
  assert.equal(row.from_ref, 'manual', 'from_ref 列（下划线命名，manual 存原样）');
  assert.equal(row.created_at, rec.at, 'created_at 列 ↔ 内存 at（映射一致）');
  // 断言真实列集合与 db.mjs DDL 一致（无臆造列）
  const [cols] = await pool.query('SHOW COLUMNS FROM kb_entries');
  const names = new Set(cols.map(c => c.Field));
  for (const n of ['id', 'project_id', 'q', 'a', 'subsystem', 'module', 'tags', 'source', 'from_ref', 'created_at']) {
    assert.ok(names.has(n), `kb_entries 应含列 ${n}`);
  }
});

/* ============ AC-13 删除 ============ */
test('AC-13 kb-delete → 条目移除、计数 -1、DB 行删除', async () => {
  const list = (await api('/api/kb-list?project=' + PID)).json.entries;
  const target = list.find(e => e.q === '显式人工条');
  assert.ok(target);
  const before = list.length;
  const r = await api('/api/kb-delete', { method: 'POST', body: { project: PID, id: target.id } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.entries.length, before - 1, '计数 -1');
  assert.equal(r.json.entries.some(e => e.id === target.id), false, '该条已移除');
  const [rows] = await pool.query('SELECT id FROM kb_entries WHERE project_id=? AND id=?', [PID, target.id]);
  assert.equal(rows.length, 0, 'DB 行应已删除');
});

/* ============ AC-16 答疑一键沉淀 ============ */
test('AC-16 kb-from-consult 正常 → from=consult、subsystem/module 空、tags 空；空 q/a → 400', async () => {
  const r = await api('/api/kb-from-consult', { method: 'POST', body: { project: PID, q: '点评报告医生排名怎么算', a: '按处方合格率降序。' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  const rec = (await api('/api/kb-list?project=' + PID)).json.entries.find(e => e.q === '点评报告医生排名怎么算');
  assert.ok(rec, '答疑沉淀条应入库');
  assert.equal(rec.from, 'consult');
  assert.equal(rec.subsystem, '');
  assert.deepEqual(rec.tags, []);
  const [rows] = await pool.query('SELECT source, from_ref FROM kb_entries WHERE project_id=? AND id=?', [PID, rec.id]);
  assert.equal(rows[0].source, 'consult');
  assert.equal(rows[0].from_ref, 'consult');
  // 空校验
  const bad = await api('/api/kb-from-consult', { method: 'POST', body: { project: PID, q: '', a: '' } });
  assert.equal(bad.status, 400);
});

/* ============ AC-14/15 工单解决自动沉淀 + 去重 ============ */
test('AC-14/15 intake-transition→已关闭 触发 kbAddFromIntake：首次 kbSunk=true 落 source=auto/from_ref=工单id；再次 kbSunk=false 不重复', async () => {
  // 造一个 bug 工单（带版本；intake-submit 即便无模型配置也会建单）
  const sub = await api('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'bug', version: 'v1.0', title: '导出偶尔缺当天数据', desc: '月末导出报表偶尔少当天', subsystem: '核心子系统', module: '报表导出' } });
  assert.equal(sub.json?.ok, true, '建单应成功');
  const ticketId = sub.json.id;
  // 强制关闭并带 resolution.note（intakeSolution 优先取 resolution.note，确定性、不依赖 AI）
  const t1 = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: ticketId, to: '已关闭', resolution: { note: '定位到跨日边界，已修复。', fixedVersion: 'v1.1' } } });
  assert.equal(t1.json?.ok, true);
  assert.equal(t1.json.kbSunk, true, '首次关闭 → 自动沉淀 kbSunk=true');
  // 连真库核对自动沉淀行：source=auto、from_ref=工单id
  const [r1] = await pool.query('SELECT source, from_ref, q FROM kb_entries WHERE project_id=? AND from_ref=?', [PID, ticketId]);
  assert.equal(r1.length, 1, '应落一条 from_ref=工单id 的自动沉淀');
  assert.equal(r1[0].source, 'auto', '自动沉淀 source=auto');
  assert.equal(r1[0].from_ref, ticketId, 'from_ref=工单 id（去重键）');
  // 再次关闭：先重开（已关闭→已重开合法），再强制关闭（已重开→已关闭走特殊放行）→ 去重不重复插入
  const reopen = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: ticketId, to: '已重开', note: '复现，重开' } });
  assert.equal(reopen.json?.ok, true, '已关闭→已重开应合法');
  const t2 = await api('/api/intake-transition', { method: 'POST', body: { project: PID, id: ticketId, to: '已关闭', resolution: { note: '再次修复关闭' } } });
  assert.equal(t2.json?.ok, true);
  assert.equal(t2.json.kbSunk, false, '同一工单再次关闭 → kbSunk=false（按 from_ref=工单id 去重）');
  const [r2] = await pool.query('SELECT COUNT(*) n FROM kb_entries WHERE project_id=? AND from_ref=?', [PID, ticketId]);
  assert.equal(r2[0].n, 1, '去重后仍只有 1 条');
});

/* ============ 前端静态断言：public/kb.html 已 re-target 至臻遴原型（无需 server） ============ */
test('前端 re-target 原型：kb.html 用 UI-01 外壳 + theme.css 组件类（data-shell/data-nav/list-layout）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/kb.html'), 'utf8');
  assert.match(html, /data-shell="admin"/, 'body 应挂 UI-01 后台外壳');
  assert.match(html, /data-nav="kb"/, 'nav 高亮应为 kb');
  assert.match(html, /data-content-layout="list"/, '全高内滚页需 list 布局（L-003）');
  assert.match(html, /\/assets\/theme\.css/, '应引 theme.css（UI-01 事实源）');
  assert.match(html, /\/assets\/shell\.js/, '应引 shell.js（注入式外壳）');
  assert.doesNotMatch(html, /\/assets\/nav\.js/, '不再引废弃 nav.js（UI-01 已删 .topnav）');
});

test('前端 re-target 原型：筛选栏四项（产品/子系统/来源/关键词回车）+ 新增按钮', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/kb.html'), 'utf8');
  assert.match(html, /class="filter-bar"/, '用 theme.css .filter-bar');
  assert.match(html, /class="filter-grid"/, '四列 .filter-grid');
  assert.match(html, /id="fProduct"/, '产品下拉');
  assert.match(html, /id="fSub"/, '子系统下拉');
  assert.match(html, /id="fSource"/, '来源下拉（原型新增筛选）');
  assert.match(html, /<option value="manual">人工<\/option>/, '来源选项 人工');
  assert.match(html, /<option value="consult">答疑<\/option>/, '来源选项 答疑');
  assert.match(html, /<option value="auto">自动<\/option>/, '来源选项 自动');
  assert.match(html, /id="fKw"/, '关键词框');
  assert.match(html, /addEventListener\('keydown'[\s\S]*?Enter/, '关键词回车触发（自由文本框，全局规范 #11）');
  assert.match(html, /id="addBtn"/, '新增经验按钮');
});

test('前端 re-target 原型：六列 data-table + 8/20/50 分页（含 pager）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/kb.html'), 'utf8');
  assert.match(html, /class="data-table"/, '表格用 theme.css .data-table（非旧手风琴 .kbrow）');
  assert.doesNotMatch(html, /class="kbrow"/, '不再有旧手风琴 .kbrow');
  for (const th of ['问题 / 现象', '子系统', '来源', '标签', '时间', '操作'])
    assert.ok(html.includes(th), `表头应含「${th}」列`);
  assert.match(html, /class="pagination"/, '分页栏');
  assert.match(html, /id="pageSize"/, '每页数选择');
  assert.match(html, /value="8"[\s\S]*value="20"[\s\S]*value="50"/, '8/20/50 每页数选项');
  assert.match(html, /class="pager"|id="pager"/, '页码 pager');
});

test('前端 re-target 原型：查看抽屉 + 编辑抽屉（含来源/来源工单）+ 自实现 open/close（无 UI.openDrawer）', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/kb.html'), 'utf8');
  assert.match(html, /id="viewDrawer"/, '查看抽屉');
  assert.match(html, /id="editDrawer"/, '编辑抽屉');
  assert.match(html, /class="evidence-quote"/, '查看抽屉 Markdown 引用块');
  assert.match(html, /id="edQ"[^>]*maxlength="100"/, '问题框 maxlength=100（AC-10 计数）');
  assert.match(html, /id="edQCount"/, 'n/100 字数计数');
  assert.match(html, /id="edSource"/, '抽屉「来源」下拉（原型暴露）');
  assert.match(html, /id="edSrcTicket"/, '抽屉「来源工单」输入（映射 from_ref）');
  assert.doesNotMatch(html, /id="edProduct"/, '抽屉内无产品选择器（产品取页面 #fProduct）');
  // 部署 shell.js 无 UI.openDrawer → 必须自实现（L-004）
  assert.doesNotMatch(html, /UI\.openDrawer/, '不得依赖不存在的 UI.openDrawer');
  assert.match(html, /function openDrawer\(/, '自实现 openDrawer');
  assert.match(html, /function closeDrawer\(/, '自实现 closeDrawer');
  assert.match(html, /class="drawer-mask"/, '用 theme.css .drawer-mask');
});

test('前端 re-target 原型：接真实端点 + 真实字段名（q/a/from/at）、删除走 uiConfirm', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/kb.html'), 'utf8');
  assert.match(html, /\/api\/kb-list\?project=/, '列表接 /api/kb-list');
  assert.match(html, /\/api\/kb-save/, '保存接 /api/kb-save');
  assert.match(html, /\/api\/kb-delete/, '删除接 /api/kb-delete');
  assert.match(html, /\/api\/projects/, '产品下拉接 /api/projects');
  // 真实内存字段（非原型 mock 的 question/answer/sourceTicket/time）
  assert.match(html, /e\.q|k\.q/, '用真实字段 q（非 question）');
  assert.match(html, /e\.a|k\.a/, '用真实字段 a（非 answer）');
  assert.match(html, /\.from\b/, '来源用真实 from（非 sourceTicket）');
  assert.match(html, /k\.at|e\.at|fmtTime\(k\.at\)/, '时间用真实 at（非 time）');
  assert.doesNotMatch(html, /\.question\b|\.answer\b|\.sourceTicket\b/, '不得用原型 mock 字段名');
  assert.match(html, /uiConfirm\(/, '删除走共享 uiConfirm（danger 二次确认）');
  assert.match(html, /source[\s\S]{0,40}from_ref/, 'kb-save 入参带 source/from_ref（微扩已具备）');
});
