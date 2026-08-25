// FS-03 · 系统视图 · 跨医院聚合 · 归档版本模型 —— 静态 + 连真库冒烟（零依赖 node --test）
//   事实源：docs/specs/FS-03-系统视图与版本模型.md（AC-1~21；NH-1~4 已裁决 2026-07-22）
//           + 真实库 db.mjs(projects/accounts/intakes) + 文件台账 data/customers.json
//           + server.mjs（新增 GET /api/field/systems ＋ /api/field/submissions?dimension=sys ＋ 复用 /api/versions）。
//   做什么：
//     A 静态：public/field.html 系统视图 DOM（系统下拉 .f-sysdd 按产品分组·可搜·显中文[2026-07-23 裁决替代平铺 tab] / 提示条 .f-xnote / 隐藏 .f-tabs2 与 .prod /
//             归档 chip .f-ver-menu tag 版本下拉 / 现场版本只读）；系统来源为 /api/field/systems（非硬编码）；
//             两类版本来源不互串（系统视图=/api/versions、医院视图=customers products）；无 FS-01 禁词误伤；无隐形字符。
//     B 连真库：造隔离产品（子系统「审方/干预」，审方仓带 git tag v2.1/v2.0/v1.9）+ 跨两医院多 subsystem 工单
//             + customers.json 两医院带 products + impl 账号（绑两医院）→ 登录调：
//             /api/field/systems 返回【全部产品】子系统（即便某产品该医院没上，其子系统也在 tab 集）；
//             /api/field/submissions?dimension=sys 跨两医院、按 subsystem 只回该系统记录、按 sites 收敛（越权医院不出）；
//             /api/versions?project= tag 倒序（v2.1 在前）；未登录 401。
//   清理：账号 by id + DB 兜底删 intakes/projects/accounts；customers.json 原本无则整删、有则还原；temp git repo 删除。
//   用法：node --test tools/fs-03.test.mjs   （连真库需本地 MySQL，凭据取 data/db.json；随机高位端口）
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6020 + Math.floor(Math.random() * 120); // 随机高位端口，避免多套件并发撞车
const BASE = `http://127.0.0.1:${PORT}`;
const TAG = Date.now().toString(36);
const PID = 'fs03smoke-' + TAG;                       // 隔离产品（子系统 审方/干预）
const SITE_A = 'FS03甲医院-' + TAG, SITE_B = 'FS03乙医院-' + TAG, SITE_X = 'FS03越权医院-' + TAG;
const U_IMPL = 'fs03impl_' + TAG;                     // 现场 impl（绑 甲+乙 两医院；不含越权医院）
const PW = 'fs03pass!';
const CUST_FILE = path.join(ROOT, 'data', 'customers.json');
const REPO_DIR = path.join(os.tmpdir(), 'fs03repo-' + TAG);   // 审方子系统仓（本地 git，带 tag，验 /api/versions 倒序）

let srv = null, pool = null;
let custPreexisted = false, custBackup = null;
const created = { accountIds: [], custIds: [] };

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

// 造本地 git 仓 + tag（v1.9/v2.0/v2.1）验 /api/versions 倒序；无 remote，refreshRepos fetch 静默失败，listVersions 仍能读 tag
function makeRepoWithTags(dir, tags) {
  fs.mkdirSync(dir, { recursive: true });
  const run = (args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  spawnSync('git', ['init', dir], { encoding: 'utf8' });
  run(['config', 'user.email', 'fs03@test.local']);
  run(['config', 'user.name', 'fs03']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fs03 smoke repo\n');
  run(['add', '.']);
  run(['commit', '-m', 'init']);
  for (const t of tags) run(['tag', t]);
}

// 直插一条工单到库（server 未起时插，spawn 后 loadAll 读入缓存）；data JSON 存整份内存对象（与 upsertIntake 一致）
async function insertIntake({ id, type, title, site, subsystem, lifecycle, submittedAt }) {
  const e = {
    id, type, project: PID, version: 'v1.0', site, subsystem: subsystem || '', module: '', title,
    priority: '中', severity: '', env: '', freq: '', reporter: 'FS03测试',
    status: '待处理', lifecycle, assignee: '', submittedAt, updatedAt: submittedAt,
    history: [{ from: '', to: lifecycle, by: 'FS03测试', byRole: 'field', at: submittedAt, note: '提交' }], chat: []
  };
  await pool.query(
    `INSERT INTO intakes (project_id,id,type,version,site,subsystem,module,title,priority,status,lifecycle,reporter,submitted_at,data)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [PID, id, type, 'v1.0', site, subsystem || '', '', title, '中', '待处理', lifecycle, 'FS03测试', submittedAt, JSON.stringify(e)]
  );
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });

  custPreexisted = fs.existsSync(CUST_FILE);
  if (custPreexisted) custBackup = fs.readFileSync(CUST_FILE, 'utf8');

  // 审方子系统仓：带 tag v1.9/v2.0/v2.1（验 /api/versions 倒序 → v2.1 在前）
  makeRepoWithTags(REPO_DIR, ['v1.9', 'v2.0', 'v2.1']);

  // 隔离产品：子系统「审方」(带 repoPath) + 「干预」（无 repoPath）；先插库，再起 server（loadAll 读缓存）
  await pool.query(`INSERT INTO projects (id,name,subsystems) VALUES (?,?,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name),subsystems=VALUES(subsystems)`,
    [PID, 'FS-03 冒烟产品', JSON.stringify([{ key: 's1', name: '审方', repoPath: REPO_DIR }, { key: 's2', name: '干预' }])]);

  // 跨两医院多子系统工单：甲医院 审方(需求) + 干预(BUG)；乙医院 审方(需求)；越权医院 审方(需求)
  await insertIntake({ id: 'fs03-A-audit', type: 'requirement', title: '甲-审方需求', site: SITE_A, subsystem: '审方', lifecycle: '待处理', submittedAt: '2026-07-17 10:00' });
  await insertIntake({ id: 'fs03-A-interv', type: 'bug', title: '甲-干预BUG', site: SITE_A, subsystem: '干预', lifecycle: '开发中', submittedAt: '2026-07-17 11:00' });
  await insertIntake({ id: 'fs03-B-audit', type: 'requirement', title: '乙-审方需求', site: SITE_B, subsystem: '审方', lifecycle: '已立项', submittedAt: '2026-07-17 12:00' });
  await insertIntake({ id: 'fs03-X-audit', type: 'requirement', title: '越权-审方需求', site: SITE_X, subsystem: '审方', lifecycle: '待处理', submittedAt: '2026-07-17 09:00' });

  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let up = false;
  for (let i = 0; i < 80; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) { up = true; break; } } catch {} await sleep(250); }
  assert.ok(up, 'server 应在测试端口起来');

  const lg = await login('admin', 'admin123', admin);
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');

  // 造 impl：绑 甲+乙（不含越权医院 SITE_X → 验 sites 收敛）
  const ra = await api('/api/account-save', { method: 'POST', body: { username: U_IMPL, role: 'impl', name: 'FS03实施', password: PW, sites: [SITE_A, SITE_B] }, jar: admin });
  assert.equal(ra.json?.ok, true, '造 impl 账号应成功：' + JSON.stringify(ra.json));
  const acc = (ra.json.accounts || []).find(a => a.username === U_IMPL);
  assert.ok(acc && acc.id, '造账号应返回 id'); created.accountIds.push(acc.id);

  // 造 customers.json：甲医院上隔离产品（现场版本 v1.0）；乙医院无 products（验医院视图 chip「未上线产品」占位）
  //   ⚠️ impl:{name:'FS03实施'} 必与 impl 账号 name 一致：customer-save 会「双向写穿 account.sites（一院一实施）」，
  //      不带 impl 则按空名解绑，把该医院从 impl 账号 sites 清掉 → me.sites 空 → 越权收敛失效（B2/B3 曾因此漏 SITE_X）。见 lessons。
  const rc1 = await api('/api/customer-save', { method: 'POST', body: { name: SITE_A, products: [{ project: PID, version: 'v1.0' }], impl: { name: 'FS03实施' } }, jar: admin });
  assert.equal(rc1.json?.ok, true, '造甲医院客户记录应成功：' + JSON.stringify(rc1.json));
  const custA = (rc1.json.customers || []).find(c => c.name === SITE_A);
  assert.ok(custA && custA.id, '甲客户记录应返回 id'); created.custIds.push(custA.id);
  const rc2 = await api('/api/customer-save', { method: 'POST', body: { name: SITE_B, products: [], impl: { name: 'FS03实施' } }, jar: admin });
  assert.equal(rc2.json?.ok, true, '造乙医院客户记录应成功');
  const custB = (rc2.json.customers || []).find(c => c.name === SITE_B);
  assert.ok(custB && custB.id, '乙客户记录应返回 id'); created.custIds.push(custB.id);

  await login(U_IMPL, PW, impl);
});

after(async () => {
  for (const id of created.accountIds) { try { await api('/api/account-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  for (const id of created.custIds) { try { await api('/api/customer-delete', { method: 'POST', body: { id }, jar: admin }); } catch {} }
  try {
    if (!custPreexisted) { if (fs.existsSync(CUST_FILE)) fs.unlinkSync(CUST_FILE); }
    else if (custBackup != null) fs.writeFileSync(CUST_FILE, custBackup);
  } catch {}
  try { if (pool) await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { if (pool) await pool.query('DELETE FROM accounts WHERE username=?', [U_IMPL]); } catch {}
  try { fs.rmSync(REPO_DIR, { recursive: true, force: true }); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ============ A. field.html 系统视图静态断言 ============
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

test('A1 系统视图=下拉控件（2026-07-23 裁决替代平铺 tab）：触发器 .f-sysdd-cur（默认「全部系统」ti-stack-2）+ 面板搜索框 + 全部系统项 + 各子系统项（ti-git-fork）（AC-1/3/4/5）', () => {
  // 不再平铺系统 tab：无 mkSysTab、无系统 tab class 输出（.f-htab.sys 已删）
  assert.doesNotMatch(FIELD_HTML, /mkSysTab/, '平铺系统 tab 构造 mkSysTab 已移除');
  assert.doesNotMatch(FIELD_HTML, /['"]f-htab sys['"]|f-htab sys/, '不再输出平铺系统 tab class "f-htab sys"');
  // 下拉容器 + 触发器 + 面板 + 列表
  assert.match(FIELD_HTML, /function buildSysDropdown/, '含系统视图下拉构造 buildSysDropdown');
  assert.match(FIELD_HTML, /f-sysdd-cur/, '含下拉触发器 .f-sysdd-cur（深色顶栏，参照 .f-mode）');
  assert.match(FIELD_HTML, /f-sysdd-panel/, '含下拉面板 .f-sysdd-panel');
  assert.match(FIELD_HTML, /f-sysdd-list/, '含下拉列表容器 .f-sysdd-list');
  assert.match(FIELD_HTML, /id="fSysSearch"/, '面板顶部含搜索框 #fSysSearch');
  assert.match(FIELD_HTML, /renderTabs[\s\S]{0,400}buildSysDropdown/, '系统视图分支渲染下拉（renderTabs sys 分支 → buildSysDropdown）');
  // 触发器默认「全部系统」（ti-stack-2）、选了显中文 sysLabel；列表项：全部系统 + 子系统（ti-git-fork）
  assert.match(FIELD_HTML, /全部系统/, '含「全部系统」文案（触发器默认 + 列表首项）');
  assert.match(FIELD_HTML, /ti-stack-2/, '全部系统图标 ti-stack-2');
  assert.match(FIELD_HTML, /ti-git-fork/, '子系统项图标 ti-git-fork');
  // 触发器显中文：默认全部系统，选了某系统显 sysLabel（desc 中文优先）
  assert.match(FIELD_HTML, /f-sysdd-cur[\s\S]{0,400}sysLabel\(state\.curSys\)/, '触发器显当前系统中文名（sysLabel(state.curSys)）');
});

test('A2 系统下拉来源 = /api/field/systems（非硬编码）；按 productName 分组 + 搜索按 中文desc/英文name 过滤 + 选中触发 onSystemTab(值用 name)（AC-2/5/NH-2）', () => {
  assert.match(FIELD_HTML, /\/api\/field\/systems/, '拉取 /api/field/systems');
  assert.match(FIELD_HTML, /state\.systems/, '下拉渲染读 state.systems（后端来源）');
  // 不得有硬编码子系统名常量数组（如原型 SUB_PRODUCT 里的 审方/干预/点评… 直接列成数组）
  assert.doesNotMatch(FIELD_HTML, /\[\s*['"]审方['"]\s*,\s*['"]干预['"]/, '无硬编码系统名数组（应后端取数）');
  assert.doesNotMatch(FIELD_HTML, /SUB_PRODUCT\s*=/, '无硬编码 SUB_PRODUCT 映射常量（改由 productOfSystem 反查后端 systems）');
  // 面板列表渲染函数：按产品分组（组头 productName） + 显中文 desc（label = desc || name）+ data-sys=英文 name
  assert.match(FIELD_HTML, /function renderSysList/, '含面板列表渲染 renderSysList');
  assert.match(FIELD_HTML, /renderSysList[\s\S]{0,1200}productName/, 'renderSysList 按 productName 分组');
  // 2026-08-25：组内显示改走 sysLabel(nm)——单子系统产品→产品名，多子系统→中文 desc||name（原直接 s0.desc||nm 已改，见 lessons 显示标签教训）
  assert.match(FIELD_HTML, /renderSysList[\s\S]{0,1200}label\s*=\s*sysLabel\(nm\)/, '组内显示走 sysLabel(nm)（单子系统→产品名，否则 desc||name）');
  assert.match(FIELD_HTML, /data-sys/, '子系统项 data-sys=英文 name（值/过滤/&system= 用 name）');
  // 搜索：即输即过滤，按 中文 desc 或 英文 name 匹配（label 与 nm 双路 indexOf）
  assert.match(FIELD_HTML, /state\.sysQuery/, '搜索词进 state.sysQuery（即输即过滤）');
  assert.match(FIELD_HTML, /fSysSearch[\s\S]{0,600}sb\.querySelector\('input'\)\.addEventListener\('input'/, '搜索框 input 事件即输即过滤');
  assert.match(FIELD_HTML, /label\.toLowerCase\(\)\.indexOf\(q\)\s*<\s*0\s*&&\s*nm\.toLowerCase\(\)\.indexOf\(q\)\s*<\s*0/, '搜索按 中文 desc(label) 或 英文 name(nm) 匹配');
  // 选中 → onSystemTab(name)（值用英文 name；全部系统 → onSystemTab(null)）
  assert.match(FIELD_HTML, /function onSystemSelect/, '含选中处理 onSystemSelect');
  assert.match(FIELD_HTML, /onSystemSelect\(null\)/, '「全部系统」项 → onSystemSelect(null)');
  assert.match(FIELD_HTML, /onSystemSelect\(sys\)/, '子系统项 → onSystemSelect(sys)（sys=英文 name）');
  assert.match(FIELD_HTML, /function onSystemTab[\s\S]{0,200}state\.curSys\s*=\s*sys/, 'onSystemTab 用传入 name 设 curSys（值=name，匹配 intakes.subsystem）');
});

test('A2b 系统下拉：稳定排序(依后端返回序) + 空清单降级(只「全部系统」+ 空提示) + 点外部/Esc 关闭（复用 closeAllMenus）', () => {
  // 稳定排序：依 state.systems 遍历序建组（不排序、不随机）
  assert.match(FIELD_HTML, /renderSysList[\s\S]{0,1600}for\s*\(var i = 0; i < state\.systems\.length/, '按 state.systems 返回序遍历（稳定排序）');
  // 空清单降级：系统为空 → 只「全部系统」+ 空提示；有系统但搜索无命中 → 提示
  assert.match(FIELD_HTML, /f-proddd-empty/, '空态复用 .f-proddd-empty 提示');
  assert.match(FIELD_HTML, /state\.systems\.length\s*\?\s*'未找到匹配的系统'\s*:\s*'暂无系统'/, '空态两文案：无系统「暂无系统」/ 搜索无命中「未找到匹配的系统」');
  // 关闭：closeAllMenus 覆盖系统下拉（点外部 document click / Esc 均走它）
  // 窗口 400→700：closeAllMenus 内新增 fVerDetail（版本明细面板，2026-07-24 问题③）关闭分支，把 fSysDD 后移（仍限 closeAllMenus 体内）
  assert.match(FIELD_HTML, /function closeAllMenus[\s\S]{0,700}fSysDD/, 'closeAllMenus 关闭系统下拉 #fSysDD');
  assert.match(FIELD_HTML, /Escape[\s\S]{0,300}fSysDD/, 'Esc 关闭系统下拉');
});

test('A3 跨医院提示条 .f-xnote 两态文案（选某系统 / 全部系统）（AC-8/9）', () => {
  assert.match(FIELD_HTML, /class="f-xnote"|className = 'f-xnote'|\.f-xnote/, '含提示条 .f-xnote');
  assert.match(FIELD_HTML, /ti-affiliate/, '提示条图标 ti-affiliate');
  assert.match(FIELD_HTML, /只看「/, '选某系统文案「跨…只看『X』系统…」');
  assert.match(FIELD_HTML, /已忽略医院维度/, '全部系统文案「已忽略医院维度…」');
  assert.match(FIELD_HTML, /全部医院/, '两态均强调「全部医院」');
});

test('A4 系统视图隐藏 .f-tabs2 与 .prod、显示 #fListSystem（intakeShowSystem）；切回恢复（intakeShowHospitalMode）（AC-11/12）', () => {
  assert.match(FIELD_HTML, /id="fListSystem"/, '含系统聚合容器 #fListSystem');
  assert.match(FIELD_HTML, /function intakeShowSystem/, '含 intakeShowSystem（隐藏医院视图控件）');
  assert.match(FIELD_HTML, /function intakeShowHospitalMode/, '含 intakeShowHospitalMode（恢复控件）');
  // intakeShowSystem 里隐藏 fTabs2 / fProdWrap、显示 fListSystem
  assert.match(FIELD_HTML, /intakeShowSystem[\s\S]{0,400}fTabs2[\s\S]{0,200}display\s*=\s*'none'/, 'intakeShowSystem 隐藏 fTabs2');
  assert.match(FIELD_HTML, /intakeShowSystem[\s\S]{0,600}fProdWrap[\s\S]{0,200}display\s*=\s*'none'/, 'intakeShowSystem 隐藏 fProdWrap（.prod）');
});

test('A5 归档 chip 系统视图分支：📦产品·子系统·版本▾ + tag 下拉（最新在前/首项「最新」/选中打勾/头部提示）（AC-13/14/15/16/17）', () => {
  assert.match(FIELD_HTML, /function updateCtx/, '含归档上下文 updateCtx');
  assert.match(FIELD_HTML, /function renderSysChip/, '含系统视图 chip 渲染 renderSysChip');
  assert.match(FIELD_HTML, /f-ver-menu/, '含 tag 版本下拉 .f-ver-menu');
  assert.match(FIELD_HTML, /运营维护版本\(tag\) · 提问基于此版本/, '下拉头部提示文案');
  assert.match(FIELD_HTML, /class="latest">最新/, '首项标「最新」徽标');
  assert.match(FIELD_HTML, /ti-check chk/, '选中项打勾 .chk');
  assert.match(FIELD_HTML, /ti-package/, '系统视图 chip 产品图标 ti-package');
  assert.match(FIELD_HTML, /全部系统 · 各系统按运营版本/, 'AC-16：全部系统退化文案');
  assert.match(FIELD_HTML, /f-ver-empty|>—</, 'AC-17：空 tag 占位（—）');
});

test('A6 归档 chip 医院视图分支：🏥医院·现场版本 只读并列、无下拉；未上产品占位（AC-18/19/20）', () => {
  assert.match(FIELD_HTML, /function renderHospChip/, '含医院视图 chip 渲染 renderHospChip');
  assert.match(FIELD_HTML, /现场版本：/, '医院视图 chip「现场版本：」文案');
  assert.match(FIELD_HTML, /ti-building-hospital/, '医院视图 chip 医院图标');
  assert.match(FIELD_HTML, /未上线产品/, 'AC-20：未上产品占位「未上线产品」');
  // 医院视图 chip 源自 customers.products（现场版本），不出现 f-ver-menu 下拉（只读）
  // 2026-07-24 问题②：renderHospChip 首段加了「选中子系统」early-return 分支，产品级现场版本列后移，窗口相应放宽（仍限 renderHospChip 内）
  assert.match(FIELD_HTML, /renderHospChip[\s\S]{0,1200}\.products/, '现场版本来自 customers.products（未选子系统分支）');
});

test('A7 两类版本来源不互串（系统视图=/api/versions git tag；医院视图=customers products）（AC-21）', () => {
  // renderSysChip 分支通过 ensureVersions→/api/versions 取 tag；renderHospChip 分支读 customers.products.version
  assert.match(FIELD_HTML, /function ensureVersions/, '含 ensureVersions（系统视图取 /api/versions tag）');
  assert.match(FIELD_HTML, /ensureVersions[\s\S]{0,200}\/api\/versions/, 'ensureVersions 调 /api/versions');
  // renderSysChip 不读 customers 版本；renderHospChip 不调 /api/versions —— 收窄断言到两函数体
  const sysBody = (FIELD_HTML.match(/function renderSysChip[\s\S]*?\n  }\n/) || [''])[0];
  const hospBody = (FIELD_HTML.match(/function renderHospChip[\s\S]*?\n  }\n/) || [''])[0];
  assert.ok(sysBody.length, 'renderSysChip 函数体可定位');
  assert.ok(hospBody.length, 'renderHospChip 函数体可定位');
  assert.doesNotMatch(sysBody, /customers/, '系统视图 chip 不读 customers 现场版本');
  assert.doesNotMatch(hospBody, /\/api\/versions/, '医院视图 chip 不调 /api/versions tag');
});

test('A7b 医院视图归档版本按所选子系统取（新形状按子系统 version / 旧形状兜底产品级 version）（2026-07-23 子系统版本模型）', () => {
  // currentArchive 医院视图：选了子系统 → version=subVersion(curSub)（该医院对该子系统维护的版本）；未选 → 回退产品级 version（旧形状）
  const caBody = (FIELD_HTML.match(/function currentArchive\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(caBody, '能截取 currentArchive 函数体');
  assert.match(caBody, /if \(state\.curSub\) out\.version = subVersion\(state\.curSub\)/, 'currentArchive 医院视图：选了子系统 → 取 subVersion(curSub)');
  assert.match(caBody, /else if \(chosen\) out\.version = chosen\.version \|\| ''/, 'currentArchive 医院视图：未选子系统 → 回退产品级 version（旧形状兜底）');
  // renderHospChip：选了子系统时在系统段显该子系统版本（选中子系统分支保持不变）
  const hospBody = (FIELD_HTML.match(/function renderHospChip\(ctx, site\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(hospBody, '能截取 renderHospChip 函数体');
  assert.match(hospBody, /var sv = subVersion\(state\.curSub\)/, 'renderHospChip 选中子系统时取该子系统版本 subVersion(curSub)');
  // 2026-07-24 问题③：全部子项目态各子系统版本明细移入 renderVerDetailRows 弹出面板（不再在归档条平铺），
  //   新形状「按子系统各自版本 / 旧形状兜底产品级 version」逻辑现落该函数体。
  const rvdBody = (FIELD_HTML.match(/function renderVerDetailRows\(cust\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(rvdBody, '能截取 renderVerDetailRows 函数体');
  assert.match(rvdBody, /pr\.subsystems && Array\.isArray\(pr\.subsystems\)/, '版本明细面板支持新形状（含 subsystems 时列各子系统各自版本）');
  assert.match(rvdBody, /pr\.version/, '版本明细面板旧形状兜底产品级 version');
  // 仍不调 /api/versions（现场版本源自 customers，非运营 tag，保 A7 语义）——归档条 + 明细面板均不调
  assert.doesNotMatch(hospBody, /\/api\/versions/, '医院视图 chip 仍不调 /api/versions tag（现场版本源自台账）');
  assert.doesNotMatch(rvdBody, /\/api\/versions/, '版本明细面板仍不调 /api/versions tag（现场版本源自台账）');
});

test('A8 引 theme.css + 无隐形字符 + 无 FS-01 禁词误伤（系统视图文案避开 发包/决策/账号管理）', () => {
  assert.match(FIELD_HTML, /\/assets\/theme\.css/, '引 theme.css 设计系统');
  const bad = [...FIELD_HTML].filter(c => [0x200b, 0x200c, 0x200d, 0xfeff, 0x00a0, 0x2028, 0x2029].includes(c.codePointAt(0)));
  assert.equal(bad.length, 0, '无隐形/零宽字符');
  for (const kw of ['账号管理', '发包', '决策', 'accounts.html', 'inbox.html']) {
    assert.doesNotMatch(FIELD_HTML, new RegExp(kw), `无 FS-01 禁词：${kw}（见 lessons L-008）`);
  }
  assert.doesNotMatch(FIELD_HTML, /assets\/shell\.js/, '不引后台 shell.js');
});

test('A9 系统视图记录可点击 reopen（2026-07-24 扩展 req/bug）：mkSysItem 镜像 mkItem — isReopenable 判可点 + bindReopen 按类型分派（consult→reopenConsult、req/bug→reopenIntake）', () => {
  const sysBody = (FIELD_HTML.match(/function mkSysItem\(it\)[\s\S]*?\n  \}/) || [''])[0];
  assert.ok(sysBody, '能截取 mkSysItem 函数体');
  // 用 isReopenable(it) 判可点 clickable（consult/requirement/bug 均可，与 mkItem 一致）
  assert.match(sysBody, /isReopenable\(it\) \? ' clickable'/, "mkSysItem 用 isReopenable(it) 判 .clickable（三类均可点）");
  // 调 bindReopen 绑点击（cursor:pointer + 按类型分派）
  assert.match(sysBody, /bindReopen\(el, it\)/, "mkSysItem 调 bindReopen（绑点击 + 按类型分派）");
  // bindReopen：consult→reopenConsult；req/bug→reopenIntake
  const brBody = (FIELD_HTML.match(/function bindReopen\(el, it\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(brBody, /cursor = 'pointer'/, 'bindReopen 设 cursor:pointer');
  assert.match(brBody, /it\.type === 'consult'\) reopenConsult\(it\); else reopenIntake\(it\)/, 'bindReopen 按类型分派：consult→reopenConsult、req/bug→reopenIntake');
  // reopenConsult / reopenIntake 通用（已有）：靠 it.project + it.id 调 intake-detail（server mapItem 已输出 project）
  assert.match(FIELD_HTML, /function reopenConsult\(it\)/, '含通用 reopenConsult(it)');
  assert.match(FIELD_HTML, /function reopenIntake\(it\)/, '含通用 reopenIntake(it)');
  assert.match(FIELD_HTML, /reopenConsult[\s\S]{0,400}intake-detail\?project=' \+ encodeURIComponent\(it\.project\)/, 'reopenConsult 靠 it.project 调 intake-detail');
});

// ============ B. 连真库冒烟 /api/field/systems · /api/field/submissions?dimension=sys · /api/versions ============

test('B1 /api/field/systems：返回【全部产品】子系统（含隔离产品 审方/干预 + 真库 hlyy 各子系统），字段 key/name/project/productName（AC-2/NH-2）', async () => {
  const r = await api('/api/field/systems', { jar: impl });
  assert.equal(r.status, 200, '现场 impl 可调（在 FIELD_OK）');
  const systems = r.json.systems || [];
  assert.ok(Array.isArray(systems) && systems.length, 'systems 非空');
  // 字段形状
  const s0 = systems[0];
  assert.ok('key' in s0 && 'name' in s0 && 'project' in s0 && 'productName' in s0, '每项含 key/name/project/productName：' + JSON.stringify(s0));
  // 全部产品口径：隔离产品的「审方/干预」都在（即便 impl 只绑甲/乙医院、乙没上该产品，其子系统仍在 tab 集）
  const names = systems.map(s => s.name);
  assert.ok(names.includes('审方') && names.includes('干预'), 'tab 集含隔离产品子系统 审方/干预（全部产品口径，不按已上产品收敛）');
  // 隔离产品子系统的反查产品正确
  const audit = systems.find(s => s.name === '审方' && s.project === PID);
  assert.ok(audit, '审方 反查到隔离产品（project=PID）');
  assert.equal(audit.productName, 'FS-03 冒烟产品', '审方 productName=隔离产品名（供归档 chip）');
});

test('B2 系统视图聚合：选「审方」→ 跨甲+乙两医院、只审方记录、按 sites 收敛（越权医院不出）（AC-6/7/10）', async () => {
  const r = await api('/api/field/submissions?dimension=sys&system=' + encodeURIComponent('审方'), { jar: impl });
  assert.equal(r.status, 200);
  assert.equal(r.json.dimension, 'sys');
  const all = [].concat(...((r.json.groups || []).map(g => g.items || [])));
  // 只审方
  assert.ok(all.every(i => i.subsystem === '审方'), '过滤后全部 subsystem=审方');
  // 跨甲+乙两医院
  const sites = new Set(all.map(i => i.site));
  assert.ok(sites.has(SITE_A) && sites.has(SITE_B), '跨甲+乙两医院聚合');
  // 越权医院 SITE_X 一条不出（sites 收敛）
  assert.ok(!all.some(i => i.site === SITE_X), '越权医院 SITE_X 记录一条不泄露（按 me.sites 收敛）');
  // 我造的审方工单 甲/乙 各 1 条命中
  assert.ok(all.some(i => i.id === 'fs03-A-audit') && all.some(i => i.id === 'fs03-B-audit'), '含甲/乙审方工单');
  assert.ok(!all.some(i => i.id === 'fs03-X-audit'), '不含越权审方工单');
});

test('B3 系统视图「全部系统」→ 各子系统分组（审方/干预），跨两医院；越权医院不出（AC-7/9/10）', async () => {
  const r = await api('/api/field/submissions?dimension=sys', { jar: impl });
  assert.equal(r.status, 200);
  const groups = r.json.groups || [];
  // 我造数覆盖 审方(甲+乙) + 干预(甲) → 至少这两个系统分组存在
  const byKey = {}; groups.forEach(g => { byKey[g.key] = g; });
  assert.ok(byKey['审方'], '含「审方」分组');
  assert.ok(byKey['干预'], '含「干预」分组');
  // 审方组含甲+乙、干预组含甲；均无越权医院
  const all = [].concat(...groups.map(g => g.items || []));
  assert.ok(!all.some(i => i.site === SITE_X), '全部系统聚合也不泄露越权医院');
  const auditSites = new Set((byKey['审方'].items || []).map(i => i.site));
  assert.ok(auditSites.has(SITE_A) && auditSites.has(SITE_B), '审方组跨甲+乙');
});

test('B4 /api/versions?project=<隔离产品> → tag 倒序（v2.1 在前），形状 {versions,syncedAt}（AC-14）', async () => {
  const r = await api('/api/versions?project=' + encodeURIComponent(PID), { jar: impl });
  assert.equal(r.status, 200, '现场可调 /api/versions（在 FIELD_OK）');
  const vs = r.json.versions || [];
  assert.ok(Array.isArray(vs), 'versions 是数组');
  assert.ok('syncedAt' in r.json, '含 syncedAt 字段');
  // 审方仓 tag v1.9/v2.0/v2.1 → 倒序最新在前
  assert.deepEqual(vs, ['v2.1', 'v2.0', 'v1.9'], 'tag 倒序（最新 v2.1 在前）：' + JSON.stringify(vs));
});

test('B5 /api/versions 空 tag 产品（真库 hlyy 无 repoPath）→ versions:[] 不报错（AC-17）', async () => {
  const r = await api('/api/versions?project=hlyy', { jar: impl });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.versions), 'hlyy versions 是数组（无 repoPath → 空，不 500）');
});

test('B6 未登录 → /api/field/systems 401/302（AC 数据权限）', async () => {
  const anon = jar();
  const r = await api('/api/field/systems', { jar: anon });
  assert.ok(r.status === 401 || r.status === 302, '未登录应 401/302，实际：' + r.status);
  assert.ok(!(r.json && Array.isArray(r.json.systems) && r.json.systems.length), '未登录不返系统清单');
});

test('B7 医院视图现场版本源：/api/customers 甲医院 products v1.0（现场版本，非 tag）（AC-18/21）', async () => {
  const rc = await api('/api/customers', { jar: impl });
  assert.equal(rc.status, 200);
  const custA = (rc.json.customers || []).find(c => c.name === SITE_A);
  assert.ok(custA, '台账含甲医院');
  const pr = (custA.products || []).find(p => p.project === PID);
  assert.ok(pr, '甲医院 products 含隔离产品');
  assert.equal(pr.version, 'v1.0', '现场版本 v1.0（customers products[].version，非 /api/versions 的 tag v2.1）');
  // 乙医院无 products → 医院视图 chip 应「未上线产品」
  const custB = (rc.json.customers || []).find(c => c.name === SITE_B);
  assert.ok(custB && (!custB.products || custB.products.length === 0), '乙医院无 products（验医院视图占位）');
});

test('B8 admin 不受 sites 约束：系统视图聚合可见甲+乙+越权全部（对照现场收敛）', async () => {
  const r = await api('/api/field/submissions?dimension=sys&system=' + encodeURIComponent('审方'), { jar: admin });
  assert.equal(r.status, 200);
  const all = [].concat(...((r.json.groups || []).map(g => g.items || [])));
  const mine = all.filter(i => i.id.startsWith('fs03-'));
  assert.ok(mine.some(i => i.site === SITE_X), '管理员可见越权医院审方记录（不受 sites 约束，反证现场收敛生效）');
});
