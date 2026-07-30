// FS-02 · 医院视图 · 提交清单（按类型 P1 + 按批次 P2 降级） —— 静态 + 连真库冒烟（零依赖 node --test）
//   事实源：docs/specs/FS-02-医院视图提交清单.md（P1：AC-1~13 + AC-18/19/20；P2：仅 AC-15 降级）
//           + 真实库 db.mjs(projects/accounts/intakes) + 文件台账 data/customers.json + server.mjs(/api/field/submissions)。
//   做什么：
//     A 静态：public/field.html 含 医院视图下拉 .f-sysdd（触发器 #fHospCur 显 curSite / 面板搜索 #fHospSearch + 列表 #fHospList[me.sites 平铺·无「全部医院」]
//             + 底部 🔒「医院由运营端分配」提示 / 空态 / position:fixed 逃裁剪 / onHospSelect 切 curSite→onHospitalChange 即选即查，2026-07-23 裁决替代平铺医院 tab）/
//             .f-ph / f-tabs2（按批次/按类型）/ .f-proddd（首项全部子项目 + .grp 产品分组 + .opt.sub 子系统）/
//             fListType 三组容器；引 theme.css；无越权后台入口；无隐形字符；类型描边色 --ticket-*；时间 yyyy-MM-dd HH:mm。
//     B 连真库：造隔离产品 + 该产品下多 type 工单（甲医院 requirement/bug/consult + 乙医院 requirement）直插库（server loadAll 读入缓存）
//             + 造 customers.json 甲医院记录带 products（验精确子项目下拉）+ 造 impl 账号（绑甲医院）→ 登录调 /api/field/submissions：
//             groupBy=type 三桶正确 / subsystem 过滤生效 / groupBy=batch → degraded / 越权 hospitalId=乙医院被忽略（AC-18）/ 未登录 401（AC-19）
//             / 子项目下拉数据来自 customers.products（buildSubOptions 精确取数）。
//   清理：账号 by id + DB 兜底删 intakes/projects/accounts；customers.json 原本不存在则整删、存在则只删本次加的那条（不污染真台账）。
//   用法：PORT 随机高位，node --test tools/fs-02.test.mjs   （连真库需本地 MySQL，凭据取 data/db.json）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5820 + Math.floor(Math.random() * 120); // 随机高位端口，避免多套件并发撞车
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'fs02smoke-' + TAG;                       // 隔离产品
const SITE_A = 'FS02甲医院-' + TAG, SITE_B = 'FS02乙医院-' + TAG;
const U_IMPL = 'fs02impl_' + TAG;                     // 现场 impl 账号（只绑甲医院）
const PW = 'fs02pass!';
const CUST_FILE = path.join(ROOT, 'data', 'customers.json');

let srv = null, pool = null;
let custPreexisted = false, custBackup = null;        // 台账原状：不存在则测后整删，存在则还原
const created = { accountIds: [], custId: null };

function jar() { return { cookie: '' }; }
function api(p, { method = 'GET', body, jar: j } = {}) {
  const hd = { 'Content-Type': 'application/json' };
  if (j && j.cookie) hd.Cookie = j.cookie;
  return fetch(BASE + p, { method, headers: hd, body: body ? JSON.stringify(body) : undefined }).then(async r => {
    const sc = r.headers.get('set-cookie');
    if (j && sc) j.cookie = sc.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => null) };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const admin = jar(), impl = jar();
async function login(username, password, j) { return api('/api/login', { method: 'POST', body: { username, password }, jar: j }); }

// 直插一条工单到库（server 未起时插，spawn 后 loadAll 读入缓存）；data JSON 存整份内存对象（与 upsertIntake 一致）
async function insertIntake({ id, type, title, site, subsystem, lifecycle, submittedAt }) {
  const e = {
    id, type, project: PID, version: 'v1.0', site, subsystem: subsystem || '', module: '', title,
    priority: '中', severity: '', env: '', freq: '', reporter: 'FS02测试',
    status: '待处理', lifecycle, assignee: '', submittedAt, updatedAt: submittedAt,
    history: [{ from: '', to: lifecycle, by: 'FS02测试', byRole: 'field', at: submittedAt, note: '提交' }], chat: []
  };
  await pool.query(
    `INSERT INTO intakes (project_id,id,type,version,site,subsystem,module,title,priority,status,lifecycle,reporter,submitted_at,data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PID, id, type, 'v1.0', site, subsystem || '', '', title, '中', '待处理', lifecycle, 'FS02测试', submittedAt, JSON.stringify(e)]
  );
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });

  // 台账原状备份（测后精确还原，绝不污染真台账）
  custPreexisted = fs.existsSync(CUST_FILE);
  if (custPreexisted) custBackup = fs.readFileSync(CUST_FILE, 'utf8');

  // 隔离产品（含子系统「审方/干预」）+ 跨医院多 type 工单：先插库，再起 server（loadAll 读入缓存）
  // 子系统带中文 desc（双键：value=英文/原始 name 匹配 intakes.subsystem、display=中文 desc）——供问题①下拉显中文断言 + B6 desc 回读
  await pool.query(`INSERT INTO projects (id,name,subsystems) VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name),subsystems=VALUES(subsystems)`,
    [PID, 'FS-02 冒烟产品', JSON.stringify([{ key: 's1', name: '审方', desc: '审方系统' }, { key: 's2', name: '干预', desc: '用药干预' }])]);
  // 甲医院：需求×2（一条子系统=审方、一条=干预）、BUG×1（审方）、咨询×2（审方/干预）
  await insertIntake({ id: 'XQ-fs02-1', type: 'requirement', title: '甲-审方需求', site: SITE_A, subsystem: '审方', lifecycle: '待处理', submittedAt: '2026-07-16 10:20' });
  await insertIntake({ id: 'XQ-fs02-2', type: 'requirement', title: '甲-干预需求', site: SITE_A, subsystem: '干预', lifecycle: '已立项', submittedAt: '2026-07-16 11:00' });
  await insertIntake({ id: 'BUG-fs02-1', type: 'bug', title: '甲-审方BUG', site: SITE_A, subsystem: '审方', lifecycle: '开发中', submittedAt: '2026-07-16 12:00' });
  await insertIntake({ id: 'ZX-fs02-1', type: 'consult', title: '甲-审方咨询', site: SITE_A, subsystem: '审方', lifecycle: '已答复', submittedAt: '2026-07-16 13:00' });
  await insertIntake({ id: 'ZX-fs02-2', type: 'consult', title: '甲-干预咨询', site: SITE_A, subsystem: '干预', lifecycle: '已答复', submittedAt: '2026-07-16 14:00' });
  // 乙医院（越权对照）：需求×1
  await insertIntake({ id: 'XQ-fs02-9', type: 'requirement', title: '乙-需求', site: SITE_B, subsystem: '审方', lifecycle: '待处理', submittedAt: '2026-07-16 09:00' });

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在测试端口起来');

  const lg = await login('admin', 'admin123', admin);
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');

  // 造 impl 账号：只绑甲医院
  const ra = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: '甲实施', password: PW, sites: [SITE_A] }, jar: admin });
  assert.equal(ra.json?.ok, true, '造 impl 账号应成功：' + JSON.stringify(ra.json));
  const acc = (ra.json.accounts || []).find(a => a.username === U_IMPL);
  assert.ok(acc && acc.id, '造账号应返回 id'); created.accountIds.push(acc.id);

  // 造 customers.json 甲医院记录 + products（PID）——验精确子项目下拉来自 customers.products。
  //   ⚠️ impl:{name:'甲实施'} 必须与 impl 账号 name 一致：customer-save 会「双向写穿 account.sites（一院一实施）」——
  //      不带 impl 则按空名解绑，会把 SITE_A 从 impl 账号 sites 清掉，导致 me.sites 空、越权收敛失效（B3 曾因此漏乙医院）。见 lessons。
  const rc = await api('/api/customer-save', { method: 'POST', body: { name: SITE_A, products: [{ project: PID, version: 'v1.0' }], impl: { name: '甲实施' } }, jar: admin });
  assert.equal(rc.json?.ok, true, '造客户记录应成功：' + JSON.stringify(rc.json));
  const cust = (rc.json.customers || []).find(c => c.name === SITE_A);
  assert.ok(cust && cust.id, '客户记录应返回 id'); created.custId = cust.id;
  assert.ok(Array.isArray(cust.products) && cust.products.some(p => p.project === PID), '客户 products 应含隔离产品（projById 校验通过）');

  await login(U_IMPL, PW, impl);
});

after(async () => {
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  if (created.custId) { try { await api('/api/customer-delete', { method: 'POST', body: { id: created.custId }, jar: admin }); } catch {} }
  // 台账精确还原：原本无 → 整删；原本有 → 还原备份（customer-delete 若已删干净仍确保恢复原文件）
  try {
    if (!custPreexisted) { if (fs.existsSync(CUST_FILE)) fs.unlinkSync(CUST_FILE); }
    else if (custBackup != null) fs.writeFileSync(CUST_FILE, custBackup);
  } catch {}
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM accounts WHERE username=?', [U_IMPL]); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ============ A. field.html 提交清单静态断言 ============
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

// §6.2 实施端状态映射（2026-07-24 修订）：分析中/已立项 不再误显「开发中」，与运营端对齐。
test('A-STATUS server.mjs FIELD_STATUS_MAP：分析中→待评审、已立项→已受理·排期、开发中→开发中（与运营端对齐）', () => {
  const m = SRC.match(/const FIELD_STATUS_MAP = \{[\s\S]*?\n\};/);
  assert.ok(m, '定位 FIELD_STATUS_MAP');
  const map = m[0];
  // AI 刚初判、运营尚未受理 → 待评审（不再显「开发中（已受理）」）
  assert.match(map, /'分析中':\s*\{\s*label:\s*'待评审',\s*tag:\s*'tag-warning'\s*\}/, "分析中→{待评审, tag-warning}");
  // 已受理立项、待开发 → 已受理·排期（不再显「开发中（已受理）」）
  assert.match(map, /'已立项':\s*\{\s*label:\s*'已受理·排期',\s*tag:\s*'tag-primary'\s*\}/, "已立项→{已受理·排期, tag-primary}");
  // 开发中 保持不变
  assert.match(map, /'开发中':\s*\{\s*label:\s*'开发中',\s*tag:\s*'tag-primary'\s*\}/, "开发中→{开发中, tag-primary}（不变）");
  // 兜底不变：未命中键 → { label: lc||'待评审', tag:'tag-gray' }
  assert.match(SRC, /function fieldStatusLabel\(lc\) \{ return FIELD_STATUS_MAP\[lc\] \|\| \{ label: lc \|\| '待评审', tag: 'tag-gray' \}; \}/, 'fieldStatusLabel 兜底不变');
  // 旧误映射彻底消失（防回归）：不再有「开发中（已受理）」标签
  assert.doesNotMatch(map, /开发中（已受理）/, "★ 不再出现旧误标签「开发中（已受理）」");
});

test('A0a 医院视图=下拉控件（2026-07-23 裁决替代平铺医院 tab）：触发器 #fHospCur 显 curSite + 面板搜索 #fHospSearch + 列表 #fHospList（AC-1/3）', () => {
  // 不再平铺医院 tab：mkTab 已移除（renderTabs 医院分支只塞下拉，末尾不再逐个 f-htab 医院 tab）
  assert.doesNotMatch(FIELD_HTML, /function mkTab/, '平铺医院 tab 构造 mkTab 已移除');
  // 复用系统视图那套 .f-sysdd* 样式（id/state 不同）
  assert.match(FIELD_HTML, /function buildHospDropdown/, '含医院视图下拉构造 buildHospDropdown');
  assert.match(FIELD_HTML, /\.id\s*=\s*'fHospDD'/, '含下拉容器 #fHospDD（wrap.id=fHospDD）');
  assert.match(FIELD_HTML, /\.id\s*=\s*'fHospCur'/, '含下拉触发器 #fHospCur（cur.id=fHospCur，复用 .f-sysdd-cur）');
  assert.match(FIELD_HTML, /cur\.className\s*=\s*'f-sysdd-cur'/, '触发器复用 .f-sysdd-cur 样式');
  assert.match(FIELD_HTML, /panel\.className\s*=\s*'f-sysdd-panel'/, '面板复用 .f-sysdd-panel（position:fixed）');
  assert.match(FIELD_HTML, /id="fHospSearch"/, '面板顶部含搜索框 #fHospSearch');
  assert.match(FIELD_HTML, /placeholder="搜索医院"/, '搜索框 placeholder=搜索医院');
  assert.match(FIELD_HTML, /\.id\s*=\s*'fHospList'/, '含下拉列表容器 #fHospList（list.id=fHospList）');
  assert.match(FIELD_HTML, /list\.className\s*=\s*'f-sysdd-list'/, '列表复用 .f-sysdd-list 样式');
  assert.match(FIELD_HTML, /ti-building-hospital/, '医院图标 ti-building-hospital');
  // 医院视图分支渲染下拉（renderTabs 非 sys 分支 → buildHospDropdown）
  assert.match(FIELD_HTML, /renderTabs[\s\S]{0,600}buildHospDropdown/, '医院视图分支渲染下拉');
  // 触发器显当前所选医院 curSite（无选中但有 sites 显「选择医院」；无 sites 显「尚未分配医院」）
  assert.match(FIELD_HTML, /fHospCur[\s\S]{0,600}state\.curSite/, '触发器显 state.curSite');
  assert.match(FIELD_HTML, /选择医院/, '无选中有 sites → 「选择医院」');
});

test('A0b 医院下拉 position:fixed 逃 #fHtabs 裁剪（打开时 getBoundingClientRect 定位，同系统下拉）（AC-1）', () => {
  // 复用 .f-sysdd-panel（position:fixed）；打开时按触发器 getBoundingClientRect 设 top/left
  assert.match(FIELD_HTML, /\.f-sysdd-panel\s*\{[^}]*position:\s*fixed/, '.f-sysdd-panel position:fixed（面板逃 overflow 裁剪）');
  assert.match(FIELD_HTML, /buildHospDropdown[\s\S]{0,900}getBoundingClientRect\(\)[\s\S]{0,200}panel\.style\.top/, '打开医院下拉时按触发器 getBoundingClientRect 定位 panel');
});

test('A0c 医院下拉列表 = me.sites 平铺（无分组、无「全部医院」）+ 搜索按医院名过滤 + 即选即查（AC-1/3）', () => {
  assert.match(FIELD_HTML, /function renderHospList/, '含面板列表渲染 renderHospList');
  // 单选一家：renderHospList 里无「全部」聚合项（区别于系统下拉的「全部系统」；不误伤 FS-03 系统视图跨医院提示文案）
  const hospListBody = (FIELD_HTML.match(/function renderHospList[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(hospListBody.length > 0, '能截取 renderHospList 函数体');
  assert.doesNotMatch(hospListBody, /全部医院|全部\s*<|['"]全部['"]/, '医院视图单选一家 → renderHospList 内无「全部医院/全部」聚合项');
  // 遍历 state.sites 平铺
  assert.match(FIELD_HTML, /renderHospList[\s\S]{0,1400}state\.sites/, 'renderHospList 遍历 state.sites 平铺');
  // 搜索按医院名过滤（hospQuery）：input 监听里 state.hospQuery = this.value → renderHospList
  assert.match(FIELD_HTML, /addEventListener\('input',\s*function\s*\(\)\s*\{\s*state\.hospQuery\s*=\s*this\.value/, '搜索框 input → state.hospQuery（即输即过滤）');
  assert.match(FIELD_HTML, /renderHospList[\s\S]{0,1400}indexOf\(q\)/, 'renderHospList 按医院名 indexOf 过滤');
  // 选中 → onHospSelect(site)：切 curSite + 关面板 + onHospitalChange（即选即查，AC-3）
  assert.match(FIELD_HTML, /function onHospSelect[\s\S]{0,300}state\.curSite\s*=\s*site/, 'onHospSelect 设 curSite=选中医院');
  assert.match(FIELD_HTML, /function onHospSelect[\s\S]{0,300}onHospitalChange\(\)/, 'onHospSelect → onHospitalChange 重载清单（即选即查）');
  // 当前项高亮 .opt.on
  assert.match(FIELD_HTML, /renderHospList[\s\S]{0,1400}state\.curSite\s*===\s*site[\s\S]{0,60}on/, '当前所选医院项 .opt.on 高亮');
});

test('A0d 医院下拉 🔒「医院由运营端分配」提示在面板内 + 空态/搜索无命中（AC-2/4）', () => {
  // 🔒 提示（AC-18 语义保留）放面板内（f-hospdd-lock），保留 .f-htab-note 与文案（FS-01 A4 也依赖）
  assert.match(FIELD_HTML, /f-hospdd-lock/, '🔒 提示节点 .f-hospdd-lock（面板内）');
  assert.match(FIELD_HTML, /医院由运营端分配/, '🔒 提示文案「医院由运营端分配」');
  assert.match(FIELD_HTML, /f-htab-note f-hospdd-lock/, '🔒 提示复用 .f-htab-note（FS-01 A4 依赖）+ 面板内 .f-hospdd-lock 样式');
  // 空态：无 sites → 「尚未分配医院，请联系运营端」（AC-4 语义）
  assert.match(FIELD_HTML, /尚未分配医院[，,]?\s*请联系运营端/, '空 sites → 「尚未分配医院，请联系运营端」');
  // 搜索无命中 → 「未找到匹配的医院」
  assert.match(FIELD_HTML, /未找到匹配的医院/, '搜索无命中 → 「未找到匹配的医院」');
});

test('A0e 医院下拉开关：closeAllMenus/Esc 关面板 + state 有 hospOpen/hospQuery + logout 重置（AC-1）', () => {
  // state 初始化含 hospOpen/hospQuery
  assert.match(FIELD_HTML, /hospOpen:\s*false/, 'state 初始化 hospOpen:false');
  assert.match(FIELD_HTML, /hospQuery:\s*''/, "state 初始化 hospQuery:''");
  // closeAllMenus 处理医院下拉
  assert.match(FIELD_HTML, /closeAllMenus[\s\S]{0,900}fHospDD/, 'closeAllMenus 关医院下拉 #fHospDD');
  assert.match(FIELD_HTML, /fHospDD[\s\S]{0,200}state\.hospOpen\s*=\s*false[\s\S]{0,60}hospQuery\s*=\s*''/, 'closeAllMenus 重置 hospOpen/hospQuery');
  // Esc 关医院下拉
  assert.match(FIELD_HTML, /Escape[\s\S]{0,600}fHospDD/, 'Esc 关医院下拉');
  // logout 重置 hospOpen/hospQuery（doLogout 里的 state 重置对象含之）
  assert.match(FIELD_HTML, /mode:\s*'hosp'[\s\S]{0,400}hospOpen:\s*false,\s*hospQuery:\s*''/, 'logout 重置 state 含 hospOpen:false/hospQuery');
});

test('A1 子控件条 .f-ph：提交清单标题 + f-tabs2（按批次/按类型）+ 全部子项目触发器 .prod（AC-5）', () => {
  assert.match(FIELD_HTML, /class="f-ph"/, '含子控件条 .f-ph');
  assert.match(FIELD_HTML, /提交清单/, '含标题「提交清单」');
  assert.match(FIELD_HTML, /id="fTabs2"/, '含 f-tabs2 容器');
  assert.match(FIELD_HTML, /class="f-tabs2"/, '含 .f-tabs2 类');
  assert.match(FIELD_HTML, /data-g="batch"[^>]*>[^<]*按批次/, '含「按批次」tab（data-g=batch）');
  assert.match(FIELD_HTML, /data-g="type"[^>]*>[^<]*按类型/, '含「按类型」tab（data-g=type）');
  assert.match(FIELD_HTML, /class="prod"/, '含子项目下拉触发器 .prod');
  assert.match(FIELD_HTML, /id="fProdLabel"/, '含触发器文案 #fProdLabel');
  assert.match(FIELD_HTML, /全部子项目/, '默认文案「全部子项目」');
});

test('A2 子项目下拉容器 .f-proddd（按产品分组 .grp + 组内 .opt.sub），首项「全部子项目」（AC-6）', () => {
  assert.match(FIELD_HTML, /id="fProdDD"/, '含下拉容器 #fProdDD');
  assert.match(FIELD_HTML, /class="f-proddd"/, '含 .f-proddd 类');
  // 分组渲染：产品分组标题 .grp + 组内子系统 .opt.sub（JS 里构建）
  assert.match(FIELD_HTML, /\.grp/, '含产品分组标题 .grp 样式/逻辑');
  assert.match(FIELD_HTML, /opt sub/, '含组内子系统项 .opt.sub');
  assert.match(FIELD_HTML, /全部子项目/, '首项「全部子项目」');
});

test('A2b 问题①子项目下拉双键：value=英文 name（过滤键）/ display=中文 desc（同系统视图 sysLabel）', () => {
  // buildSubOptions 产出 {name,desc}（不再是 [名] 字符串数组）
  const buildBody = (FIELD_HTML.match(/function buildSubOptions\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(buildBody, '能截取 buildSubOptions 函数体');
  assert.match(buildBody, /return\s*\{\s*name:\s*nm,\s*desc:\s*dc\s*\|\|\s*nm\s*\}/, 'buildSubOptions 每项产出 {name, desc:desc||name}（双键）');
  // renderProdDD：data-sub=英文 name（过滤值不变）、显示 desc||name（中文优先）
  const renderBody = (FIELD_HTML.match(/function renderProdDD\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(renderBody, '能截取 renderProdDD 函数体');
  assert.match(renderBody, /var nm = sub\.name,\s*label = sub\.desc \|\| sub\.name/, 'renderProdDD 取 name（过滤键）+ label=desc||name（显示）');
  assert.match(renderBody, /setAttribute\('data-sub', nm\)/, 'data-sub=英文 name（过滤键不变）');
  assert.match(renderBody, /escapeHtml\(label\)/, '下拉项显示 label（中文 desc 优先）');
  assert.match(renderBody, /selectSub\(nm\)/, 'selectSub 传英文 name（过滤值不变）');
  // subLabel 映射（name→desc）供选中标签 + 空态显示中文
  assert.match(FIELD_HTML, /function subLabel\(nm\)/, '含 subLabel(name→desc) 映射');
  // selectSub 选中标签显 desc（中文），不是英文 name
  assert.match(FIELD_HTML, /setProdLabel\(state\.curSub \? subLabel\(state\.curSub\)/, 'selectSub 选中时标签显 subLabel(desc)');
  // 空态提示也用 subLabel 显中文（不再裸显英文 curSub）
  assert.match(FIELD_HTML, /subLabel\(state\.curSub\) \+ '」子项目下暂无记录/, '空态提示用 subLabel(desc) 显中文');
  // 过滤仍按英文 name：loadSubmissions 的 &subsystem= 用 state.curSub（=name），不改成 desc
  assert.match(FIELD_HTML, /&subsystem=' \+ encodeURIComponent\(state\.curSub\)/, '过滤 &subsystem= 仍用 state.curSub（英文 name），不改成 desc');
});

test('A2c 问题①医院视图归档条随子系统刷新：selectSub 调 updateCtx + renderHospChip 选中子系统显 subLabel 中文名', () => {
  // selectSub 末尾调 updateCtx()（归档条随所选子系统刷新）
  const selBody = (FIELD_HTML.match(/function selectSub\(sub\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(selBody, '能截取 selectSub 函数体');
  assert.match(selBody, /updateCtx\(\)/, 'selectSub 末尾调 updateCtx()（切子系统刷新归档条）');
  // renderHospChip 两分支（2026-07-24 问题②/③）：
  //   ① curSub 非空 → 显「· 系统：<subLabel> · 版本：<subVersion 或 —>」，early return，不再挂产品级「现场版本」
  //   ② curSub 空（全部子项目）→ 紧凑「· 现场版本：<产品名>」+ 版本明细 icon（不再平铺所有子系统版本；点 icon 弹面板逐产品列各子系统版本）
  const hospBody = (FIELD_HTML.match(/function renderHospChip\(ctx, site\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(hospBody, '能截取 renderHospChip 函数体');
  assert.match(hospBody, /if \(state\.curSub\)[\s\S]*?subLabel\(state\.curSub\)/, 'renderHospChip 有 curSub 非空分支，显 subLabel(state.curSub) 中文名');
  assert.match(hospBody, /系统：/, '选中子系统分支前缀「系统：」（放医院名之后）');
  // 选中子系统分支：截取 if(state.curSub){...return;} 块，须含「版本：」+ subVersion 且以 return 结束（不落到产品级现场版本）
  const subBranch = (hospBody.match(/if \(state\.curSub\) \{[\s\S]*?return;\s*\n    \}/) || [''])[0];
  assert.ok(subBranch, '能截取 curSub 非空分支块（含 early return）');
  assert.match(subBranch, /版本：/, '★ 选中子系统分支显「· 版本：」（该子系统版本，不再挂产品级现场版本）');
  assert.match(subBranch, /subVersion\(state\.curSub\)/, '★ 版本取 subVersion(state.curSub)（该医院该子系统维护的版本，旧形状兜底产品级）');
  assert.doesNotMatch(subBranch, /现场版本/, '★ 选中子系统分支不含「现场版本」（去掉冗余产品级版本列）');
  // 全部子项目态（curSub 空）：紧凑摘要 + 版本明细 icon，★不再平铺所有子系统版本
  assert.match(hospBody, /现场版本：/, '全部子项目态仍显「现场版本：」前缀（后接紧凑产品名摘要）');
  assert.match(hospBody, /f-verdd-btn/, '★ 全部子项目态含版本明细 icon 按钮 .f-verdd-btn（替代平铺）');
  assert.match(hospBody, /ti-list-details/, '★ icon 用 ti-list-details（查看各子系统版本入口）');
  assert.match(hospBody, /查看各子系统版本/, '★ icon title=「查看各子系统版本」');
  assert.match(hospBody, /renderVerDetailRows\(cust\)/, '★ 面板内容由 renderVerDetailRows(cust) 生成（逐产品列各子系统版本）');
  // ★不再在归档条里平铺各子系统「产品·子系统 <ver>」并列（问题③：又长又换行）——全部子项目分支不再拼 subsystems.map 版本并列
  // 截取"现场版本：紧凑摘要"这一段（从「现场版本：」到 innerHTML 结束），不应含 ms.version 平铺
  const allSubBranch = hospBody.slice(hospBody.indexOf('分支②'));
  assert.doesNotMatch(allSubBranch, /pr\.subsystems[\s\S]{0,120}\bms\.version\b[\s\S]{0,120}join\(' · '\)/, '★ 全部子项目态不再平铺各子系统版本并列（不含 subsystems.map(...ms.version...).join(" · ")）');
  // 版本明细面板渲染函数存在：逐产品 → 各子系统 + 版本；position:fixed 定位（复用 .f-sysdd-panel）
  assert.match(FIELD_HTML, /function renderVerDetailRows\(cust\)/, '★ 含版本明细面板渲染函数 renderVerDetailRows');
  const rvdBody = (FIELD_HTML.match(/function renderVerDetailRows\(cust\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(rvdBody, '能截取 renderVerDetailRows 函数体');
  assert.match(rvdBody, /pr\.subsystems && Array\.isArray\(pr\.subsystems\)/, '面板新形状：列该医院维护的子系统 + 各自版本');
  assert.match(rvdBody, /pr\.version/, '面板旧形状兜底：列该产品全部子系统 @ 产品级 version');
  assert.match(rvdBody, /f-verdd-grp|f-verdd-row/, '面板逐产品分组 + 逐子系统行（.f-verdd-grp/.f-verdd-row）');
  assert.match(rvdBody, /暂无子系统版本信息/, '面板无子系统数据兜底「暂无子系统版本信息」');
  // 面板 position:fixed 逃 overflow 裁剪 + getBoundingClientRect 定位
  assert.match(hospBody, /getBoundingClientRect\(\)/, '★ icon 面板打开时 getBoundingClientRect 定位（position:fixed 逃裁剪）');
  assert.match(FIELD_HTML, /\.f-verdd-panel[\s\S]{0,200}\.f-sysdd-panel[\s\S]{0,400}position:\s*fixed|\.f-sysdd-panel\s*\{[^}]*position:\s*fixed/, '版本明细面板复用 .f-sysdd-panel（position:fixed）');
  // closeAllMenus / Esc 接入版本明细面板（和其它下拉一致的关闭逻辑）
  const closeBody = (FIELD_HTML.match(/function closeAllMenus\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(closeBody, /fVerDetail/, '★ closeAllMenus 关闭版本明细面板 #fVerDetail');
  // 问题①（2026-07-24）：版本明细面板 .open 加在面板自身而非父级 .f-sysdd，须自带 .f-verdd-panel.open{display:block} 才显示（早前漏 → 点 icon 无反应）
  assert.match(FIELD_HTML, /\.f-verdd-panel\.open\s*\{[^}]*display:\s*block/, '★ 版本明细面板有 .f-verdd-panel.open{display:block} 规则（点 icon → add("open") → 真正显示，问题①修）');
});

test('A2e 问题②（2026-07-24）归档条不重复显示医院名（顶栏已有医院选择器）：renderHospChip 各分支不再以 escapeHtml(site) 起头', () => {
  const hospBody = (FIELD_HTML.match(/function renderHospChip\(ctx, site\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(hospBody, '能截取 renderHospChip 函数体');
  // ★ 归档条不再显示医院名：函数体内一律不含 escapeHtml(site)（site 仅用于数据取值：customers 匹配/currentArchive/过滤，不显示）
  assert.doesNotMatch(hospBody, /escapeHtml\(site\)/, '★ renderHospChip 不再显示医院名（各分支不含 escapeHtml(site)，顶栏已有医院选择器，去重复占位）');
  // ★ site 仍作数据取值用（customers 匹配保留），只是不显示
  assert.match(hospBody, /\(state\.customers\[i\]\.name \|\| ''\)\.trim\(\) === String\(site\)\.trim\(\)/, '★ site 仍用于 customers 匹配（数据取值不动，只去显示）');
  // 各分支直接从「现场版本：」/「系统：」起头（无孤立「 · 」前缀、无医院图标前缀）
  const subBranch = (hospBody.match(/if \(state\.curSub\) \{[\s\S]*?return;\s*\n    \}/) || [''])[0];
  assert.match(subBranch, /ctx\.innerHTML = '系统：/, '★ 选中子系统分支 innerHTML 直接从「系统：」起头（无医院名/图标/孤立「 · 」前缀）');
  // 全部子项目态 + 无产品占位分支：innerHTML 从「现场版本：」起头
  assert.match(hospBody, /ctx\.innerHTML = '现场版本：' \+ \(prodNames \|\| '—'\)/, '★ 全部子项目态 innerHTML 直接从「现场版本：<产品名>」起头（去医院名前缀）');
  assert.match(hospBody, /ctx\.innerHTML = '现场版本：未上线产品'/, '★ 无产品/无医院占位直接「现场版本：未上线产品」（去医院名前缀）');
});

test('A2d 新模型消费：buildSubOptions 新形状(pr.subsystems)只列维护的子系统 + 记 version；旧形状兜底全显（向后兼容）', () => {
  const buildBody = (FIELD_HTML.match(/function buildSubOptions\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(buildBody, '能截取 buildSubOptions 函数体');
  // 新形状分支：pr.subsystems 存在 → 只列这些子系统，各带 version
  assert.match(buildBody, /pr\.subsystems && Array\.isArray\(pr\.subsystems\)/, '有新形状分支（判 pr.subsystems 是数组）');
  assert.match(buildBody, /version:\s*\(ms && ms\.version\) \|\| ''/, '新形状每项带 version（该医院维护的子系统版本）');
  assert.match(buildBody, /descOf\[nm\] \|\| nm/, '新形状 desc 从产品目录 catalog 查 name→desc（中文优先）');
  // 旧形状兜底分支：无 pr.subsystems → 列该产品全部子系统 catalog，version 预填产品级 pr.version
  assert.match(buildBody, /var pv = pr\.version \|\| '';/, '旧形状兜底取产品级 version');
  assert.match(buildBody, /catalog\.map\(function \(o\) \{ return \{ name: o\.name, desc: o\.desc, version: pv \}; \}\)/, '旧形状兜底列全部子系统 @ 产品级 version（保持现状「全部子系统」行为）');
  // subVersion(name→version) 映射供归档条取所选子系统版本
  assert.match(FIELD_HTML, /function subVersion\(nm\)/, '含 subVersion(name→version) 映射');
});

test('A3 精确取数：子项目下拉来自 customers.products → projMap.subsystems（不臆造表）（§5.2/6.4）', () => {
  assert.match(FIELD_HTML, /\/api\/customers/, '拉取 /api/customers 台账');
  assert.match(FIELD_HTML, /buildSubOptions/, '含 buildSubOptions 精确取数');
  // 按当前医院名匹配 customers.name，取 products[].project → projMap[pid].subsystems
  assert.match(FIELD_HTML, /\.products/, '按医院 products 取已上产品');
  assert.match(FIELD_HTML, /projMap/, '映射到产品目录 subsystems');
  assert.match(FIELD_HTML, /运营端未维护该医院上线产品/, '台账空→空提示');
});

test('A4 按类型三组容器 fListType + 组顺序 需求/BUG/咨询 + 空组不渲染（AC-10/12）', () => {
  assert.match(FIELD_HTML, /id="fListType"/, '含按类型视图容器 #fListType');
  assert.match(FIELD_HTML, /id="fListBatch"/, '含按批次视图容器 #fListBatch');
  assert.match(FIELD_HTML, /requirement['"]?\s*,\s*['"]bug['"]?\s*,\s*['"]consult/, '组顺序 requirement/bug/consult 稳定');
  assert.match(FIELD_HTML, /需求/, '组标题「需求」');
  assert.match(FIELD_HTML, /BUG/, '组标题「BUG」');
  assert.match(FIELD_HTML, /咨询/, '组标题「咨询」');
  // 空组不渲染注释/逻辑存在
  assert.match(FIELD_HTML, /f-type-grp/, '含分组容器 .f-type-grp');
  assert.match(FIELD_HTML, /f-item/, '含条目 .f-item');
});

test('A5 条目结构 AC-11：类型描边色 --ticket-* + 状态标签 + 上下文子系统·医院 + 时间 yyyy-MM-dd HH:mm', () => {
  assert.match(FIELD_HTML, /--ticket-req/, '类型描边色引用 --ticket-req');
  assert.match(FIELD_HTML, /--ticket-bug/, '类型描边色引用 --ticket-bug');
  assert.match(FIELD_HTML, /--ticket-consult/, '类型描边色引用 --ticket-consult');
  assert.match(FIELD_HTML, /f-item-ctx/, '含上下文行 .f-item-ctx');
  assert.match(FIELD_HTML, /statusTag/, '用后端 statusTag 状态标签类');
  assert.match(FIELD_HTML, /function fmtTime/, '含共享时间格式化 fmtTime');
  // fmtTime 目标格式 yyyy-MM-dd HH:mm
  assert.match(FIELD_HTML, /\$1-\$2-\$3 \$4:\$5|getFullYear\(\) \+ '-'/, 'fmtTime 产出 yyyy-MM-dd HH:mm');
});

test('A6 即选即查：切 tab / 选子系统即刷新（无独立查询按钮）（AC-7/9，全局规范⑪）', () => {
  assert.match(FIELD_HTML, /setGroupBy/, '含 setGroupBy（切 tab 即刷新）');
  assert.match(FIELD_HTML, /selectSub/, '含 selectSub（选子系统即刷新）');
  assert.match(FIELD_HTML, /loadSubmissions/, '含 loadSubmissions（重新请求）');
  // 提交清单区不应出现「查询/搜索」按钮（子项目/tab 均即选即查）
  assert.doesNotMatch(FIELD_HTML, /f-ph[\s\S]{0,400}<button[^>]*>[^<]*查询/, '子控件条内无「查询」按钮');
});

test('A7 引 theme.css + 无隐形字符 + 无后台管理越权入口', () => {
  assert.match(FIELD_HTML, /\/assets\/theme\.css/, '引 theme.css 设计系统');
  const bad = [...FIELD_HTML].filter(c => [0x200b, 0x200c, 0x200d, 0xfeff, 0x00a0, 0x2028, 0x2029].includes(c.codePointAt(0)));
  assert.equal(bad.length, 0, '无隐形/零宽字符');
  // 现场端不出现后台管理页链接（accounts/projects/inbox 等运营页）
  for (const p of ['/accounts.html', '/projects.html', '/inbox.html', '/console.html', '/customers.html', '/kb.html']) {
    assert.doesNotMatch(FIELD_HTML, new RegExp(p.replace(/[.]/g, '\\.')), `不含后台页链接 ${p}`);
  }
});

test('A8 按批次视图前端：groupBy=batch → loadBatchView 调 /api/field/batches 真实渲染（FS-05 已上线，推翻旧降级占位）', () => {
  // 【FS-05 变更】原 AC-15「按批次恒降级占位（renderBatchDegraded/批次分组暂未开放）」已被 FS-05 实施侧批次消费取代：
  //   按批次视图现走 /api/field/batches 真实渲染（下载/改版本/逐单验证）。故 field.html 不再有 renderBatchDegraded 降级分支。
  assert.match(FIELD_HTML, /function loadBatchView/, '按批次视图走 loadBatchView（FS-05）');
  assert.match(FIELD_HTML, /state\.groupBy === 'batch'.*loadBatchView|loadBatchView\(\); return;/, 'groupBy=batch 分支调 loadBatchView');
  assert.match(FIELD_HTML, /\/api\/field\/batches/, '按批次视图调 /api/field/batches 真实端点');
  // 旧降级占位彻底移除（renderBatchDegraded / 批次分组暂未开放 / f-degraded）
  assert.doesNotMatch(FIELD_HTML, /function renderBatchDegraded/, '旧降级占位函数 renderBatchDegraded 已移除（FS-05 替换为真实批次视图）');
  assert.doesNotMatch(FIELD_HTML, /批次分组暂未开放/, '旧降级文案已移除');
  assert.doesNotMatch(FIELD_HTML, /f-degraded/, '旧 .f-degraded 提示条已删');
  // FS-05 按批次视图核心 UI：更新包卡/下载、改版本条、逐单验证入口
  assert.match(FIELD_HTML, /下载更新包/, '含「下载更新包」');
  assert.match(FIELD_HTML, /一键改版本/, '含「一键改版本」');
  assert.match(FIELD_HTML, /确认验证过/, '含逐单「确认验证过」');
});

// ============ B. 连真库冒烟 /api/field/submissions ============

test('B1 groupBy=type：甲医院三桶（需求2/BUG1/咨询2），组顺序稳定，字段来自真库（AC-10/11）', async () => {
  const r = await api('/api/field/submissions?dimension=hosp&groupBy=type&hospitalId=' + encodeURIComponent(SITE_A), { jar: impl });
  assert.equal(r.status, 200, '应 200');
  assert.equal(r.json.degraded, false, 'type 非降级');
  assert.equal(r.json.groupBy, 'type');
  const g = {}; (r.json.groups || []).forEach(x => { g[x.key] = x; });
  assert.ok(g.requirement && g.requirement.count === 2, '需求组 2 条：' + JSON.stringify(r.json.groups.map(x => [x.key, x.count])));
  assert.ok(g.bug && g.bug.count === 1, 'BUG 组 1 条');
  assert.ok(g.consult && g.consult.count === 2, '咨询组 2 条');
  // 组顺序 需求→BUG→咨询
  assert.deepEqual(r.json.groups.map(x => x.key), ['requirement', 'bug', 'consult'], '组顺序稳定');
  // 字段来自真库 + §6.2 状态标签映射 + 时间格式
  const it = g.requirement.items.find(i => i.id === 'XQ-fs02-1');
  assert.ok(it, '含真库工单 XQ-fs02-1');
  assert.equal(it.site, SITE_A, 'site=甲医院');
  assert.equal(it.subsystem, '审方', 'subsystem=审方（真库）');
  assert.equal(it.lifecycle, '待处理', 'lifecycle=待处理（真库）');
  assert.equal(it.statusLabel, '待评审', '待处理→待评审（§6.2）');
  assert.equal(it.statusTag, 'tag-warning', '待评审 tag-warning');
  assert.match(it.submittedAt, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, '时间 yyyy-MM-dd HH:mm');
  // 连真库状态映射（2026-07-24 修订）：已立项 → 已受理·排期；开发中 → 开发中（分析中→待评审见 A-STATUS 静态断言）
  const it2 = g.requirement.items.find(i => i.id === 'XQ-fs02-2');
  assert.ok(it2 && it2.lifecycle === '已立项', 'lifecycle=已立项（真库）');
  assert.equal(it2.statusLabel, '已受理·排期', '★ 已立项→已受理·排期（受理立项、待开发，不再误显「开发中（已受理）」）');
  assert.equal(it2.statusTag, 'tag-primary', '已受理·排期 tag-primary');
  const itb = g.bug.items.find(i => i.id === 'BUG-fs02-1');
  assert.ok(itb && itb.lifecycle === '开发中', 'lifecycle=开发中（真库）');
  assert.equal(itb.statusLabel, '开发中', '开发中→开发中（不变）');
  assert.equal(itb.statusTag, 'tag-primary', '开发中 tag-primary');
  // 排期字段：这些 fs02 单未归批 → batchSchedule 为空串（字段须存在，供按类型卡显「计划交付」；FS-05 批次场景带值见 fs-05）
  assert.ok('batchSchedule' in it, 'item 带 batchSchedule 字段');
  assert.equal(it.batchSchedule, '', '未归批工单 batchSchedule 空串');
  assert.equal(itb.batchSchedule, '', '未归批工单 batchSchedule 空串');
});

test('B2 subsystem 过滤：subsystem=审方 → 只剩审方记录（需求1/BUG1/咨询1），干预被滤（AC-7/13）', async () => {
  const r = await api('/api/field/submissions?dimension=hosp&groupBy=type&hospitalId=' + encodeURIComponent(SITE_A) + '&subsystem=' + encodeURIComponent('审方'), { jar: impl });
  assert.equal(r.status, 200);
  const g = {}; (r.json.groups || []).forEach(x => { g[x.key] = x; });
  assert.equal(g.requirement.count, 1, '审方需求 1 条');
  assert.equal(g.bug.count, 1, '审方 BUG 1 条');
  assert.equal(g.consult.count, 1, '审方咨询 1 条');
  // 全部记录 subsystem 都是审方
  const all = [].concat(...(r.json.groups.map(x => x.items)));
  assert.ok(all.every(i => i.subsystem === '审方'), '过滤后全部 subsystem=审方');
});

test('B3 越权收敛：impl（只绑甲医院）请求 hospitalId=乙医院 → 忽略越权，乙记录 0（AC-18）', async () => {
  const r = await api('/api/field/submissions?dimension=hosp&groupBy=type&hospitalId=' + encodeURIComponent(SITE_B), { jar: impl });
  assert.equal(r.status, 200);
  const all = [].concat(...((r.json.groups || []).map(x => x.items || [])));
  // 越权医院被裁掉 → 返回其 sites 内数据（甲医院），乙医院记录一条不出
  assert.ok(all.every(i => i.site === SITE_A), '越权 hospitalId=乙被忽略，只见甲医院数据');
  assert.ok(!all.some(i => i.site === SITE_B), '乙医院记录一条不泄露');
});

test('B4 submissions?groupBy=batch → 仍返 degraded:true（遗留后端契约·前端已改走 /api/field/batches，此分支保留不破坏，FS-05）', async () => {
  // 【FS-05 说明】前端按批次视图现调 /api/field/batches（见 A8/fs-05.test.mjs）；submissions 的 groupBy=batch 遗留降级契约保留、
  //   前端不再消费——保留断言以确保未误删/未改成 500（向后兼容）。真实按批次数据/隔离/闭环在 fs-05.test.mjs 覆盖。
  const r = await api('/api/field/submissions?dimension=hosp&groupBy=batch&hospitalId=' + encodeURIComponent(SITE_A), { jar: impl });
  assert.equal(r.status, 200, 'batch 降级仍 200，不 500');
  assert.equal(r.json.degraded, true, 'degraded:true');
  assert.equal(r.json.groupBy, 'batch');
  assert.ok(Array.isArray(r.json.groups) && r.json.groups.length === 0, 'groups 空');
  assert.match(String(r.json.msg || ''), /批次/, '降级提示含「批次」');
});

test('B5 未登录 → 401，不返数据（AC-19）', async () => {
  const anon = jar();
  const r = await api('/api/field/submissions?dimension=hosp&groupBy=type', { jar: anon });
  assert.ok(r.status === 401 || r.status === 302, '未登录应 401/302（authGate/端点双保险），实际：' + r.status);
  assert.ok(!(r.json && r.json.groups && r.json.groups.length), '不返回任何分组数据');
});

test('B6 精确子项目下拉：customers.json 甲医院 products→隔离产品 subsystems（审方/干预）（§5.2/6.4）', async () => {
  // 台账真实回读：/api/customers 应含本次造的甲医院记录 + products=隔离产品
  const rc = await api('/api/customers', { jar: impl });
  assert.equal(rc.status, 200);
  const cust = (rc.json.customers || []).find(c => c.name === SITE_A);
  assert.ok(cust, '台账含甲医院记录（现场账号可读 /api/customers）');
  assert.ok(cust.products.some(p => p.project === PID), '甲医院 products 含隔离产品');
  // 产品目录回读子系统（前端 buildSubOptions 精确取数依据）
  const rp = await api('/api/projects', { jar: impl });
  const proj = (rp.json.projects || []).find(p => p.id === PID);
  assert.ok(proj, '产品目录含隔离产品');
  const subs = (proj.subsystems || []).map(s => typeof s === 'string' ? s : s.name);
  assert.ok(subs.includes('审方') && subs.includes('干预'), '子系统含 审方/干预（下拉分组数据源，name=过滤键）');
  // 问题①双键数据源：产品子系统带中文 desc（前端下拉 display=desc||name）
  const audit = (proj.subsystems || []).find(s => typeof s !== 'string' && s.name === '审方');
  assert.ok(audit && audit.desc === '审方系统', '子系统「审方」带 desc=审方系统（下拉显中文 desc 的数据源）');
});

test('B6b 新形状连真库：造带 subsystems:[{name,version}] 的医院 → /api/customers 回读子系统各自版本（buildSubOptions 新形状消费源）', async () => {
  // 新形状客户：只维护「审方 v2.1」（不含干预）→ 实施端下拉应只列审方（A2d 静态验消费逻辑，此处验数据源真库回读）
  const siteC = 'FS02丙医院-' + TAG;
  const rc = await api('/api/customer-save', { method: 'POST', body: { name: siteC, products: [{ project: PID, subsystems: [{ name: '审方', version: 'v2.1' }] }] }, jar: admin });
  assert.equal(rc.json?.ok, true, '新形状造客户应成功：' + JSON.stringify(rc.json));
  const cid = (rc.json.customers || []).find(c => c.name === siteC)?.id;
  assert.ok(cid, '新形状客户返回 id');
  try {
    const got = (await api('/api/customers', { jar: admin })).json.customers.find(c => c.name === siteC);
    assert.ok(got, '台账回读含新形状客户');
    const pr = got.products.find(p => p.project === PID);
    assert.ok(pr && Array.isArray(pr.subsystems), '产品含 subsystems 数组（新形状）');
    assert.deepEqual(pr.subsystems, [{ name: '审方', version: 'v2.1' }], '只维护审方 v2.1（不含干预），版本回读一致');
    assert.ok(!('version' in pr), '新形状无产品级 version 字段');
  } finally {
    await api('/api/customer-delete', { method: 'POST', body: { id: cid }, jar: admin });   // 即时清理，不留残留
  }
});

test('B7 admin 不受 sites 约束：管理员请求可见甲+乙全部（对照现场收敛）', async () => {
  const r = await api('/api/field/submissions?dimension=hosp&groupBy=type', { jar: admin });
  assert.equal(r.status, 200);
  const all = [].concat(...((r.json.groups || []).map(x => x.items || [])));
  const mine = all.filter(i => i.id.startsWith('XQ-fs02') || i.id.startsWith('BUG-fs02') || i.id.startsWith('ZX-fs02'));
  assert.ok(mine.some(i => i.site === SITE_A), '管理员见甲医院');
  assert.ok(mine.some(i => i.site === SITE_B), '管理员见乙医院（不受 sites 约束）');
});
