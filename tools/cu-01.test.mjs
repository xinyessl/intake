// CU-01 · 客户 / 医院管理 —— 接口 + 连真库冒烟测试（零依赖，node --test）
//   【2026-07-21 re-target 原型 + 扩字段】客户仍走文件存储 data/customers.json（与 model-config/git-config 同范式，
//   不迁 MySQL、MySQL 无 customers 表——已核 db.mjs 仅 5 表；迁库=NEEDS-HUMAN）。
//   在最简结构上扩字段：{ id, name, level, region, impl:{name,phone}, status, products:[{project,version}], updatedAt }；
//   ticketCount 由 GET/save/delete 读时按 site↔客户名派生（不落文件、不入库）。
//
//   做什么：
//     · 启动真实 server.mjs（连本地 MySQL data/db.json，仅用于账号/会话；客户本身走文件）到隔离端口；
//     · 用 fetch 打真实端点 /api/customers、/api/customer-save、/api/customer-delete；
//     · 断言：新增/编辑（带 id 整条覆盖）、名称必填→400、名称按 60 截断、产品去重 + 无效产品过滤 + ≤40、
//             精确删除不误删、删不存在 id→404、缺 id→400、updatedAt 写入；
//             扩字段 level/region/impl/status 落文件 + 回读、非法 level/status 归一到默认、ticketCount 读时派生。
//     · 连真库冒烟：mysql2 直连真库核对 —— 确认 customers 表【不存在】（部署真相，扩字段仍走文件不建表）、
//             intakes.site 列【存在】（工单数派生的关联源，字段映射核对）。
//   为不污染真实数据：before 备份 data/customers.json（含「不存在」态），after 完整还原；
//     所有测试客户名带 CU01-<ts> 前缀、按 id 精确删，隔离产品跑完删除。
//   用法：node --test tools/cu-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5400 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'cu01smoke-' + Date.now().toString(36);        // 本次冒烟隔离产品 id（供 normCustomer 产品有效性校验）
const TAG = 'CU01-' + Date.now().toString(36);             // 本次测试客户名前缀（隔离 + 便于清理）
const CUST_FILE = path.join(ROOT, 'data', 'customers.json');
let srv = null, cookie = '', pool = null;
let backup = { existed: false, content: null };
const createdIds = [];                                     // 记录本次造的客户 id，兜底清理

// ---- 静态断言：抽屉产品卡「子系统清单」= 每子系统 [☑勾选] 中文名 [版本下拉]（2026-07-23 裁决「维护到子系统+各自版本」）----
//   恒可跑（读源文件、不启服务）。护栏：产品卡展开子系统清单（勾选框 .subck-in + 子系统中文名 + 版本下拉 .cver）；
//   版本下拉仍是 <select class="select cver">（被 ui.js 增强）+ 含「未指定」+ 按产品拉 /api/versions 填充（fetchVersions/fillVerOptions）；
//   换产品 change 重建子系统清单；collectProducts 产出 {project, subsystems:[{name,version}]}（只收勾选）。
const CUST_HTML = fs.readFileSync(path.join(ROOT, 'public', 'customers.html'), 'utf8');
test('[静态·子系统清单] 产品卡展开子系统清单：每子系统 [☑勾选]+中文名+版本下拉 .cver（select），换产品重建清单', () => {
  // 每个产品卡下有子系统清单容器（.subsyslist）+ 建子系统行的 makeSubsysRow
  assert.match(CUST_HTML, /list\.className='subsyslist'/, '产品卡内有子系统清单容器 .subsyslist');
  assert.match(CUST_HTML, /function makeSubsysRow\(/, '存在 makeSubsysRow（建单个子系统行）');
  assert.match(CUST_HTML, /function buildSubsysList\(/, '存在 buildSubsysList（按产品重建子系统清单）');
  // 子系统行含勾选框（是否上线）+ 子系统中文名（sub.desc||sub.name）
  assert.match(CUST_HTML, /ck\.type='checkbox';\s*ck\.className='subck-in'/, '子系统行含勾选框 .subck-in（是否上线）');
  assert.match(CUST_HTML, /nm\.textContent=sub\.desc\|\|sub\.name/, '子系统名显中文（sub.desc||sub.name）');
  // 版本下拉仍是 <select class="select cver">（被 ui.js 增强）
  assert.match(CUST_HTML, /createElement\('select'\)[^;]*;\s*v\.className\s*=\s*'select cver'/,
    '.cver 应为 document.createElement("select") + className="select cver"（选择型，被 ui.js 增强）');
  assert.match(CUST_HTML, /<option value="">未指定<\/option>/, '版本下拉含「未指定」占位项（value=""）');
  // 按产品拉 /api/versions 填充版本 + 缓存 + 保留历史值
  assert.match(CUST_HTML, /const VER_CACHE\s*=\s*\{\}/, '存在版本缓存 VER_CACHE');
  assert.match(CUST_HTML, /function fetchVersions\(/, '存在 fetchVersions（按产品拉版本 + 缓存）');
  assert.match(CUST_HTML, /\/api\/versions\?project=/, '按产品调 /api/versions?project=');
  assert.match(CUST_HTML, /function fillVerOptions\(/, '存在 fillVerOptions（填版本选项 + 保留历史值 + 无版本提示）');
  assert.match(CUST_HTML, /vs\.indexOf\(cur\)<0/, '不在 tag 列表里的历史版本值作为选项保留（避免下拉丢值）');
  // 换产品 change 时重建子系统清单（新产品的子系统，全不勾）
  assert.match(CUST_HTML, /s\.addEventListener\('change'[\s\S]*?buildSubsysList\(s\.value/, '.cprod change 时按新产品重建子系统清单');
  // 子系统数据源 = 该产品定义的 subsystems（subsystemsOf 从 PROJECTS 查，name=过滤/后端校验键、desc=中文）
  assert.match(CUST_HTML, /function subsystemsOf\(/, '存在 subsystemsOf（产品→子系统 [{name,desc}]，不臆造）');
  // collectProducts 产出 {project, subsystems:[{name,version}]}（只收勾选的子系统）
  assert.match(CUST_HTML, /out\.push\(\{\s*project:pid,\s*subsystems:subs\s*\}\)/, 'collectProducts 产出 {project, subsystems:[...]}');
  assert.match(CUST_HTML, /subs\.push\(\{\s*name:sr\.dataset\.sub,\s*version:/, '只收勾选子系统 {name, version}');
});

// ---- 静态断言：collectProducts 读值必须用 select.cprod / select.cver（防 2026-07-23「保存失败」回归）----
//   根因：ui.js 自定义下拉增强器把原 select 的附带 class（.cprod/.cver）复制到它生成的 <div class="ui-sel-wrap cprod/cver"> 上，
//   且该 wrapper 在 DOM 顺序里排在原生 select 之前；裸 `.cprod`/`.cver` 会先命中那个 DIV（无 .value → undefined），
//   导致 pid/version 全落空 → collectProducts 返回 []，保存把客户产品清空（用户看到「保存失败/没反应」）。
//   修法：读值用 `select.cprod`/`select.cver` 精确选原生 <select>，绕开 wrapper DIV。
test('[静态·防回归] collectProducts 用 select.cprod / select.cver 读原生 select，绕开 ui.js wrapper DIV', () => {
  assert.match(CUST_HTML, /r\.querySelector\('select\.cprod'\)/, 'collectProducts 用 select.cprod（不是裸 .cprod）读产品下拉，绕开 ui-sel-wrap DIV');
  assert.match(CUST_HTML, /sr\.querySelector\('select\.cver'\)/, 'collectProducts 用 select.cver（不是裸 .cver）读版本下拉，绕开 ui-sel-wrap DIV');
  // 明确不再有裸 `r.querySelector('.cprod')` / `sr.querySelector('.cver')`（否则又会命中 wrapper DIV）
  assert.doesNotMatch(CUST_HTML, /r\.querySelector\('\.cprod'\)/, '不得用裸 .cprod（会命中 wrapper DIV）');
  assert.doesNotMatch(CUST_HTML, /sr\.querySelector\('\.cver'\)/, '不得用裸 .cver（会命中 wrapper DIV）');
});

// ---- 静态断言：防清空护栏（编辑已有客户 + 收集到 0 产品 + 原本有产品 → 二次确认，防静默清空）----
//   数据保护：2026-07-23 线上「安吉县人民医院」产品被 collectProducts 读值 bug 清空成 []（已从备份恢复）。
//   除根因修复外，加护栏作最后防线——即便未来再有收集/误删导致空产品，编辑已有客户清空前也必弹确认。
test('[静态·防清空护栏] 编辑已有客户 + 收集 0 产品 + 原本有产品 → uiConfirm 二次确认才提交', () => {
  const m = CUST_HTML.match(/async function saveCustomer\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找到 saveCustomer 函数体');
  const body = m[1];
  // 取原客户产品数（编辑态才有 editId）
  assert.match(body, /const\s+orig\s*=\s*editId\s*\?\s*CUSTOMERS\.find\(/, '取原客户 orig（编辑态按 editId 查）');
  assert.match(body, /origCount\s*=.*orig[\s\S]*?products[\s\S]*?length/, '算原客户产品数 origCount');
  // 护栏条件：编辑态 + 收集空 + 原本有产品
  assert.match(body, /if\(\s*editId\s*&&\s*products\.length===0\s*&&\s*origCount>0\s*\)/, '护栏条件：editId && products.length===0 && origCount>0');
  // 二次确认 + 取消则中止（return，不提交）
  assert.match(body, /await\s+uiConfirm\([\s\S]*?清空[\s\S]*?\)/, '空产品清空前 uiConfirm 二次确认');
  assert.match(body, /if\(!ok\)\s*return;/, '取消确认 → return 中止保存（不提交清空）');
  // 护栏在 fetch 之前（先拦再发请求）
  const guardIdx = body.indexOf('origCount>0');
  const fetchIdx = body.indexOf('/api/customer-save');
  assert.ok(guardIdx >= 0 && fetchIdx >= 0 && guardIdx < fetchIdx, '护栏判断在 fetch(/api/customer-save) 之前');
});

// ---- 静态断言：collectProducts() 调用必须在 saveCustomer 的 try 块内（防静默失败）----
//   保证任何前端收集异常都被 catch → toast('保存失败：'+e.message) 可见 + finally 恢复按钮，不再静默无反应。
test('[静态·防静默失败] saveCustomer 中 collectProducts() 在 try 块内调用', () => {
  // 截取 saveCustomer 函数体
  const m = CUST_HTML.match(/async function saveCustomer\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, '找到 saveCustomer 函数体');
  const body = m[1];
  const tryIdx = body.indexOf('try{');
  const collectIdx = body.indexOf('collectProducts()');
  assert.ok(tryIdx >= 0, 'saveCustomer 含 try 块');
  assert.ok(collectIdx >= 0, 'saveCustomer 调用 collectProducts()');
  assert.ok(collectIdx > tryIdx, 'collectProducts() 调用位置在 try{ 之后（即在 try 块内，异常可被 catch）');
  // catch 分支要能显式提示保存失败（错误可见）
  assert.match(body, /catch\s*\(\s*e\s*\)\s*\{[\s\S]*?toast\(\s*'保存失败：'\s*\+\s*e\.message/, 'catch 里 toast 显式提示「保存失败：」+错误信息');
});

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

  // 备份 data/customers.json（含「文件不存在」态）——after 完整还原，绝不污染真实客户台账
  try {
    if (fs.existsSync(CUST_FILE)) { backup.existed = true; backup.content = fs.readFileSync(CUST_FILE, 'utf8'); }
  } catch {}

  // 启动真实服务到隔离端口（连真库）
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  // 造一个隔离产品——normCustomer 会校验 products[].project 必须命中 projById，否则被过滤掉。
  //   带两个子系统（审方/干预）：新形状 subsystems[].name 校验命中该产品子系统全集的数据源。
  const ps = await api('/api/project-save', { method: 'POST', body: { id: PID, name: 'CU-01 冒烟产品', subsystems: [{ key: 's1', name: '审方', desc: '审方系统' }, { key: 's2', name: '干预', desc: '用药干预' }] } });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
});

after(async () => {
  // 清理：删本次造的客户（按精确 id），删隔离产品
  for (const id of createdIds) { try { await api('/api/customer-delete', { method: 'POST', body: { id } }); } catch {} }
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID } }); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  // 还原 customers.json 到测试前状态（原本不存在则删掉）
  try {
    if (backup.existed) fs.writeFileSync(CUST_FILE, backup.content);
    else if (fs.existsSync(CUST_FILE)) fs.rmSync(CUST_FILE, { force: true });
  } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

// ---- 连真库冒烟：确认部署真相（customers 表不存在 / intakes.site 列存在）----
test('[真库冒烟] MySQL 无 customers 表（扩字段仍走文件不建表），intakes.site 列存在（工单数派生源）', async () => {
  const [tables] = await pool.query('SHOW TABLES');
  const names = tables.map(r => Object.values(r)[0]);
  assert.ok(!names.includes('customers'), '护栏：扩 level/region/impl/status 后 MySQL 仍不应有 customers 表（客户存 data/customers.json，迁库=NEEDS-HUMAN）');
  // 5 表基线仍在（不臆造、不改库的护栏）
  for (const t of ['projects', 'accounts', 'sessions', 'intakes', 'kb_entries']) {
    assert.ok(names.includes(t), `基线表 ${t} 应存在`);
  }
  // intakes.site 列存在：工单数派生若落地时的关联源（AC-18/19 待决策项的字段映射核对）
  const [cols] = await pool.query('SHOW COLUMNS FROM intakes');
  const fields = cols.map(c => c.Field);
  assert.ok(fields.includes('site'), 'intakes 应有 site 列（工单「现场/医院」，ticketCount 派生的关联源）');
  const siteCol = cols.find(c => c.Field === 'site');
  assert.match(siteCol.Type, /varchar\(80\)/i, 'intakes.site 应为 VARCHAR(80)（与 db.mjs 一致）');
});

// ---- GET /api/customers（扩字段结构：{ customers:[...] } 每条 {id,name,level,region,impl,status,products,updatedAt,ticketCount}）----
test('[AC-1] GET /api/customers 返回 { customers:[...] }（扩字段结构 + ticketCount 派生）', async () => {
  const r = await api('/api/customers');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json?.customers), 'customers 应为数组');
  for (const c of r.json.customers) {
    assert.ok('id' in c && 'name' in c, '每条客户含 id/name');
    assert.ok('ticketCount' in c, '每条客户含读时派生的 ticketCount');
  }
});

// ---- POST /api/customer-save 新增 ----
test('[AC-9] customer-save 新增：返回 ok + 写入 updatedAt + products 保留有效产品', async () => {
  const name = TAG + '-协和';
  const r = await api('/api/customer-save', { method: 'POST', body: { name, products: [{ project: PID, version: 'v2.0' }] } });
  assert.equal(r.json?.ok, true, '新增应 ok');
  const rec = r.json.customer;
  assert.ok(rec.id, '返回新记录含 id');
  createdIds.push(rec.id);
  assert.equal(rec.name, name);
  assert.deepEqual(rec.products, [{ project: PID, version: 'v2.0' }], 'products 保留有效产品 + 版本');
  assert.match(rec.updatedAt || '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/, 'updatedAt 写入且为 yyyy-MM-dd HH:mm');
  // 列表能查到
  const lst = await api('/api/customers');
  assert.ok(lst.json.customers.some(c => c.id === rec.id), '列表出现该客户');
});

// ---- 扩字段：level/region/impl/status 落文件 + 回读（re-target 原型核心）----
test('[AC-4/5/6/7] customer-save 扩字段 level/region/status 保存 + GET 回读一致（impl 现为读时派生，见 impl-sites-sync）', async () => {
  const name = TAG + '-扩字段';
  // 【2026-07-23 模型裁决】impl 不再存客户档案回读，而是从 account.sites 读时派生（唯一真源）。
  //   此处传 impl.name=不存在的账号「张工」→ 无账号 sites 含本医院 → 派生 impl={name:'',phone:''}。
  //   impl 的写穿/派生正确性由 tools/impl-sites-sync.test.mjs（连真库·造真实 impl 账号）覆盖；本用例只核 level/region/status 文件字段。
  const body = { name, level: '三乙', region: '华东·江苏', status: '未开通',
    impl: { name: '张工', phone: '138-0010-0100' }, products: [{ project: PID, version: 'v1.0' }] };
  const r = await api('/api/customer-save', { method: 'POST', body });
  assert.equal(r.json?.ok, true, '扩字段新增应 ok');
  const rec = r.json.customer; createdIds.push(rec.id);
  assert.equal(rec.level, '三乙', 'level 落库');
  assert.equal(rec.region, '华东·江苏', 'region 落库');
  assert.equal(rec.status, '未开通', 'status 落库');
  assert.deepEqual(rec.impl, { name: '', phone: '' }, 'impl 读时派生：无账号持有本医院 → 空（不再回读客户档案死值）');
  // GET 回读一致（level/region/status 真正读文件回来；impl 派生同上）
  const got = (await api('/api/customers')).json.customers.find(c => c.id === rec.id);
  assert.equal(got.level, '三乙'); assert.equal(got.region, '华东·江苏'); assert.equal(got.status, '未开通');
  assert.deepEqual(got.impl, { name: '', phone: '' }, 'GET 回读 impl 派生一致（无持有账号→空）');
});

// ---- 扩字段归一：非法 level/status → 默认；缺 impl → {name:'',phone:''} ----
test('[AC-6] 非法 level/status 归一到默认（三甲/已开通），缺 impl 归一到空对象', async () => {
  const name = TAG + '-归一';
  const r = await api('/api/customer-save', { method: 'POST', body: { name, level: '四甲', status: 'xxx', region: '', products: [] } });
  assert.equal(r.json?.ok, true);
  const rec = r.json.customer; createdIds.push(rec.id);
  assert.equal(rec.level, '三甲', '非法 level → 默认三甲');
  assert.equal(rec.status, '已开通', '非法 status → 默认已开通');
  assert.deepEqual(rec.impl, { name: '', phone: '' }, '缺 impl → {name:"",phone:""}');
  assert.equal(rec.region, '', '空 region → 空串（不必填后端不拦，前端拦）');
});

// ---- ticketCount 读时派生：新客户名无对应工单 → 0（关联键 site↔name）----
test('[AC-18] ticketCount 读时派生：无同名工单的客户 ticketCount=0', async () => {
  const name = TAG + '-无工单-' + Math.random().toString(36).slice(2, 6);
  const r = await api('/api/customer-save', { method: 'POST', body: { name, products: [] } });
  createdIds.push(r.json.customer.id);
  assert.equal(r.json.customer.ticketCount, 0, '新客户名不匹配任何 intakes.site → ticketCount=0');
  const got = (await api('/api/customers')).json.customers.find(c => c.id === r.json.customer.id);
  assert.equal(got.ticketCount, 0, 'GET 回读 ticketCount 派生一致=0');
});

// ---- 名称必填校验（后端纵深防御）----
test('[AC-10] customer-save 名称为空 → 400 { ok:false, error:请填客户名称 }', async () => {
  const r = await api('/api/customer-save', { method: 'POST', body: { name: '   ', products: [] } });
  assert.equal(r.status, 400, '空名称应 400');
  assert.equal(r.json?.ok, false);
  assert.match(r.json?.error || '', /客户名称/, '错误信息提示名称');
});

// ---- 名称长度：normCustomer 截 60（原型 40 vs 代码 60 统一取值 = NEEDS-HUMAN；此处核代码实际=60）----
test('[AC-12] customer-save 名称按 60 截断（代码实际；原型 40 vs 60 统一属 NEEDS-HUMAN）', async () => {
  const longName = TAG + '-' + 'x'.repeat(100);
  const r = await api('/api/customer-save', { method: 'POST', body: { name: longName, products: [] } });
  assert.equal(r.json?.ok, true);
  createdIds.push(r.json.customer.id);
  assert.equal(r.json.customer.name.length, 60, '部署 normCustomer 截断至 60 字符');
  assert.equal(r.json.customer.name, longName.slice(0, 60), '截断为前 60 字符');
});

// ---- 编辑：带 id 整条覆盖（不新增），扩字段一并被覆盖 ----
test('[AC-13/7] customer-save 带 id → 整条覆盖更新（含扩字段，不新增）', async () => {
  const name = TAG + '-省立';
  const add = await api('/api/customer-save', { method: 'POST', body: { name, level: '三甲', region: '山东·济南', status: '已开通', products: [] } });
  const id = add.json.customer.id; createdIds.push(id);
  const before = (await api('/api/customers')).json.customers.length;
  const edit = await api('/api/customer-save', { method: 'POST', body: { id, name: name + '(改)', level: '三乙', region: '山东·青岛', status: '未开通', impl: { name: '李工', phone: '139' }, products: [{ project: PID, version: 'v3.4.1' }] } });
  assert.equal(edit.json?.ok, true);
  const after = (await api('/api/customers')).json.customers.length;
  assert.equal(after, before, '编辑不应改变总数（整条覆盖，非新增）');
  const rec = edit.json.customers.find(c => c.id === id);
  assert.equal(rec.name, name + '(改)', '名称被更新');
  assert.equal(rec.level, '三乙', 'level 被覆盖');
  assert.equal(rec.region, '山东·青岛', 'region 被覆盖');
  assert.equal(rec.status, '未开通', 'status 被覆盖');
  assert.deepEqual(rec.impl, { name: '', phone: '' }, 'impl 读时派生：无账号「李工」持有本医院 → 空（模型裁决：impl 唯一真源=account.sites，不回读客户档案）');
  assert.deepEqual(rec.products, [{ project: PID, version: 'v3.4.1' }], '产品被覆盖为新值');
});

// ---- 产品去重 + 无效产品过滤 + ≤40 ----
test('[AC-14/15] 产品去重 + 无效产品（未登记）被过滤', async () => {
  const name = TAG + '-去重';
  const r = await api('/api/customer-save', { method: 'POST', body: { name, products: [
    { project: PID, version: 'v1' },
    { project: PID, version: 'v2' },          // 同产品重复 → 去重，保留第一条
    { project: '__不存在的产品__', version: 'v9' }, // 无效产品 → 过滤
  ] } });
  assert.equal(r.json?.ok, true);
  createdIds.push(r.json.customer.id);
  assert.equal(r.json.customer.products.length, 1, '重复产品去重 + 无效产品过滤后只剩 1 条');
  assert.equal(r.json.customer.products[0].project, PID);
  assert.equal(r.json.customer.products[0].version, 'v1', '去重保留第一条出现的版本');
});

// ---- 连真库冒烟：版本下拉数据源 /api/versions + 选中版本经 customer-save 回读（后端未改，version 仍自由字符串存文件）----
test('[连真库·版本下拉] GET /api/versions?project= 返回 {versions:[...]}（下拉数据源）；选中的版本经 customer-save 回读一致', async () => {
  // 版本下拉的数据源端点：隔离产品无本地 clone 的 repo → versions 为空数组（不报错，前端仅显「未指定」）
  const vr = await api('/api/versions?project=' + PID);
  assert.equal(vr.status, 200, '/api/versions 应 200');
  assert.ok(Array.isArray(vr.json?.versions), '/api/versions 返回 { versions:[...] }（前端 fetchVersions 填 .cver 选项的数据源）');
  // 前端改成「从下拉选版本」后，选中的 version 仍经 collectProducts → customer-save 原样存文件、回读一致
  const name = TAG + '-版本选择';
  const r = await api('/api/customer-save', { method: 'POST', body: { name, products: [{ project: PID, version: 'v3.4.1' }] } });
  assert.equal(r.json?.ok, true);
  createdIds.push(r.json.customer.id);
  assert.deepEqual(r.json.customer.products, [{ project: PID, version: 'v3.4.1' }], '选中的版本原样存（后端未改，version 仍自由字符串）');
  const got = (await api('/api/customers')).json.customers.find(c => c.id === r.json.customer.id);
  assert.equal(got.products[0].version, 'v3.4.1', 'GET 回读版本一致（前端只改填法，存储/回读不变）');
});

// ==== 新形状「维护到子系统 + 各自版本」（2026-07-23 裁决）：连真库存读 + 防臆造 + 向后兼容 ====

// ---- 新形状：products[].subsystems=[{name,version}] 存 → 回读一致（name 命中该产品子系统全集）----
test('[AC-19 新形状] customer-save 存带 subsystems:[{name,version}] 的产品 → 回读一致', async () => {
  const name = TAG + '-子系统版本';
  const body = { name, products: [{ project: PID, subsystems: [{ name: '审方', version: 'v2.1' }, { name: '干预', version: 'v1.9' }] }] };
  const r = await api('/api/customer-save', { method: 'POST', body });
  assert.equal(r.json?.ok, true, '新形状新增应 ok');
  const rec = r.json.customer; createdIds.push(rec.id);
  assert.equal(rec.products.length, 1, '1 个产品');
  assert.ok(Array.isArray(rec.products[0].subsystems), '产品含 subsystems 数组（新形状）');
  assert.deepEqual(rec.products[0], { project: PID, subsystems: [{ name: '审方', version: 'v2.1' }, { name: '干预', version: 'v1.9' }] },
    '各子系统各自版本原样存（无产品级 version）');
  // GET 回读一致
  const got = (await api('/api/customers')).json.customers.find(c => c.id === rec.id);
  assert.deepEqual(got.products[0].subsystems, [{ name: '审方', version: 'v2.1' }, { name: '干预', version: 'v1.9' }], 'GET 回读子系统各自版本一致');
});

// ---- 防臆造：不属该产品的子系统 name 被丢弃；version 按 30 截断；同 name 去重 ----
test('[AC-19 防臆造] subsystems 里不属该产品的 name 被丢弃 + version 按 30 截断 + 同 name 去重', async () => {
  const name = TAG + '-防臆造';
  const longVer = 'v'.repeat(40);   // 40 字符 → 截 30
  const body = { name, products: [{ project: PID, subsystems: [
    { name: '审方', version: longVer },
    { name: '不存在的子系统', version: 'v9' },   // 不属该产品 → 丢弃
    { name: '审方', version: 'v3' },              // 同 name 重复 → 去重（保留第一条）
  ] }] };
  const r = await api('/api/customer-save', { method: 'POST', body });
  assert.equal(r.json?.ok, true);
  const rec = r.json.customer; createdIds.push(rec.id);
  const subs = rec.products[0].subsystems;
  assert.equal(subs.length, 1, '不属该产品的子系统被丢弃 + 同 name 去重后只剩 1 条（审方）');
  assert.equal(subs[0].name, '审方');
  assert.equal(subs[0].version.length, 30, 'version 按 30 截断');
  assert.equal(subs[0].version, longVer.slice(0, 30), '截断为前 30 字符');
});

// ---- 无勾选子系统的产品：subsystems=[] 仍保留该产品（不误删，实施端兜底显全部）----
test('[AC-19] 无勾选子系统的产品保留（subsystems=[]，不丢弃）', async () => {
  const name = TAG + '-空子系统';
  const r = await api('/api/customer-save', { method: 'POST', body: { name, products: [{ project: PID, subsystems: [] }] } });
  assert.equal(r.json?.ok, true);
  const rec = r.json.customer; createdIds.push(rec.id);
  assert.equal(rec.products.length, 1, '无勾选子系统仍保留产品（避免误删）');
  assert.deepEqual(rec.products[0], { project: PID, subsystems: [] }, 'subsystems=[]（空数组），实施端兜底显全部');
});

// ---- 向后兼容：旧形状 {project,version}（无 subsystems 字段）仍可存读，不被破坏 ----
test('[AC-19 兼容] 旧形状 {project,version} 仍可存读（不强迁、不删老字段）', async () => {
  const name = TAG + '-旧形状兼容';
  const r = await api('/api/customer-save', { method: 'POST', body: { name, products: [{ project: PID, version: 'v2.0' }] } });
  assert.equal(r.json?.ok, true, '旧形状仍可存');
  const rec = r.json.customer; createdIds.push(rec.id);
  assert.deepEqual(rec.products, [{ project: PID, version: 'v2.0' }], '旧形状 {project,version} 原样保留（无 subsystems 字段，兼容）');
  assert.ok(!('subsystems' in rec.products[0]), '旧形状不被强升级为 subsystems（消费方兜底处理，行为不变）');
  const got = (await api('/api/customers')).json.customers.find(c => c.id === rec.id);
  assert.deepEqual(got.products, [{ project: PID, version: 'v2.0' }], 'GET 回读旧形状一致');
});

// ---- 逻辑桩（vm · 提取 customers.html 真身 collectProducts）：模拟 ui.js 增强后的 DOM，验证读值健壮不清空、缺元素不抛 ----
//   背景：2026-07-23「保存失败」回归根因 = ui.js 自定义下拉增强把原 select 的 .cprod/.cver class 复制到它生成的
//   <div class="ui-sel-wrap cprod/cver">（DOM 顺序排在原生 select 前）；裸 querySelector('.cprod') 先命中 DIV（无 .value）
//   → pid 落空 → collectProducts 返回 []（产品被清空）。此用例用最小 DOM 桩「还原增强后结构」直接跑真身函数，
//   断言修复后（select.cprod / select.cver）能正确读到值、且缺元素时不抛。只连真库/只 mock 都抓不到这个 wrapper 污染，故用 DOM 桩。
test('[逻辑桩·防回归] collectProducts 在 ui.js 增强后（wrapper DIV 带同名 class）仍正确收集，缺元素不抛', async () => {
  const vm = await import('node:vm');
  // 提取真身 collectProducts（function collectProducts(){ ... return out; }）
  const m = CUST_HTML.match(/function collectProducts\(\)\{[\s\S]*?return out; \}/);
  assert.ok(m, '提取 collectProducts 真身');
  const src = m[0];

  // —— 最小 DOM 桩：只实现桩内用到的 querySelector('.cls' | 'tag.cls') / querySelectorAll / .value / .checked / dataset —— //
  // 元素：{tag, cls:Set, value, checked, dataset, kids:[]}；querySelector 按文档预序（kids 顺序）返回首个匹配。
  function el(tag, cls, opts = {}) {
    return { tag: tag.toUpperCase(), cls: new Set((cls || '').split(/\s+/).filter(Boolean)),
      value: opts.value, checked: opts.checked, dataset: opts.dataset || {}, kids: opts.kids || [] };
  }
  function matches(node, sel) {
    sel = sel.trim();
    const dot = sel.indexOf('.');
    if (dot > 0) { const tag = sel.slice(0, dot).toUpperCase(); const cls = sel.slice(dot + 1); return node.tag === tag && node.cls.has(cls); }
    if (sel.startsWith('.')) return node.cls.has(sel.slice(1));
    return node.tag === sel.toUpperCase();
  }
  function descendants(node) { let out = []; for (const k of node.kids) { out.push(k); out = out.concat(descendants(k)); } return out; }
  function attach(node) {
    node.querySelector = sel => { for (const d of descendants(node)) if (matches(d, sel)) return d; return null; };
    node.querySelectorAll = sel => descendants(node).filter(d => matches(d, sel)).map(d => (attach(d), d));
    // querySelectorAll 结果也要能 forEach（数组天然可以）
    for (const k of node.kids) attach(k);
    return node;
  }

  // 构造 ui.js 增强后的产品卡结构：
  //   .prow
  //     .prow-hd
  //       div.ui-sel-wrap.cprod   ← wrapper（增强器复制了 .cprod class，且排在原生 select 前！无 .value）
  //         select.select.cprod  (value=hlyy)  ← 原生 select（数据源）
  //     .subsyslist
  //       .subsysrow (dataset.sub=audit)
  //         label.subck > input.subck-in (checked)
  //         div.ui-sel-wrap.cver  ← wrapper（复制了 .cver，排在原生 cver select 前，无 .value）
  //           select.select.cver (value=v2.0)  ← 原生
  function makeProw({ prodValue, subs }) {
    const prodNativeSel = el('select', 'select cprod', { value: prodValue });
    const prodWrap = el('div', 'ui-sel-wrap cprod', { kids: [prodNativeSel] });   // wrapper 在前、内含 select
    const subRows = subs.map(s => {
      const ck = el('input', 'subck-in', { checked: s.checked });
      const verNative = el('select', 'select cver', { value: s.version });
      const verWrap = el('div', 'ui-sel-wrap cver', { kids: [verNative] });
      const label = el('label', 'subck', { kids: [ck] });
      return el('div', 'subsysrow', { dataset: { sub: s.name }, kids: [label, verWrap] });
    });
    const hd = el('div', 'prow-hd', { kids: [prodWrap] });
    const list = el('div', 'subsyslist', { kids: subRows });
    return el('div', 'prow', { kids: [hd, list] });
  }

  const edProdRows = el('div', '', { kids: [
    // 产品卡1：hlyy + 勾选 audit@v2.0（旧形状回填后升级场景）+ 未勾选 report
    makeProw({ prodValue: 'hlyy', subs: [
      { name: 'audit', checked: true, version: 'v2.0' },
      { name: 'report', checked: false, version: '' },
    ] }),
    // 产品卡2：空产品（未选产品）——pid 落空应跳过、不抛
    makeProw({ prodValue: '', subs: [] }),
    // 产品卡3：结构缺元素（子系统行无 .cver select，模拟极端 DOM 缺失）——不应抛，version 兜底 ''
    (() => { const p = makeProw({ prodValue: 'hlyy2', subs: [{ name: 'audit', checked: true, version: 'vX' }] });
      // 移除该行内的 select.cver（保留 wrapper DIV 与 checkbox）
      const row = p.kids[1].kids[0]; row.kids[1].kids = []; return p; })(),
  ] });
  attach(edProdRows);

  // document 桩：$$('#edProdRows .prow') → edProdRows 下所有 .prow
  const document = { querySelectorAll: sel => {
    if (sel === '#edProdRows .prow') return edProdRows.querySelectorAll('.prow');
    return [];
  } };
  const sandbox = { document, $$: sel => document.querySelectorAll(sel), Set, Array, console };
  vm.createContext(sandbox);
  vm.runInContext(src + '\nglobalThis.__collect = collectProducts;', sandbox);

  let out;
  assert.doesNotThrow(() => { out = sandbox.__collect(); }, 'collectProducts 不抛（含缺元素行）');
  out = JSON.parse(JSON.stringify(out));   // 跨 vm realm 回主 realm 普通对象，供 deepStrictEqual 比对（否则原型不同判不等）

  // 卡1：hlyy，只勾选的 audit@v2.0（未勾选的 report 不收）——修复前这里会因命中 wrapper DIV 而 pid=undefined → 整卡丢失
  const hlyy = out.find(p => p.project === 'hlyy');
  assert.ok(hlyy, 'hlyy 产品被正确收集（未被 wrapper DIV 污染吞掉）');
  assert.deepEqual(hlyy.subsystems, [{ name: 'audit', version: 'v2.0' }], '只收勾选的 audit + 正确读到版本 v2.0（走 select.cver）');
  // 卡2：空产品被跳过（pid 落空）
  assert.ok(!out.some(p => p.project === ''), '空产品卡（未选产品）被跳过');
  // 卡3：hlyy2 缺 .cver select，version 兜底空串，不抛
  const hlyy2 = out.find(p => p.project === 'hlyy2');
  assert.ok(hlyy2, 'hlyy2 产品被收集（读到 select.cprod）');
  assert.deepEqual(hlyy2.subsystems, [{ name: 'audit', version: '' }], '缺 .cver select 时 version 兜底为空串（缺元素不抛）');
});

// ---- 精确删除：只删指定 id，其余不动 ----
test('[AC-17] customer-delete 精确删除不误删；不存在 id→404；缺 id→400', async () => {
  const a = await api('/api/customer-save', { method: 'POST', body: { name: TAG + '-删A', products: [] } });
  const b = await api('/api/customer-save', { method: 'POST', body: { name: TAG + '-删B', products: [] } });
  const idA = a.json.customer.id, idB = b.json.customer.id;
  createdIds.push(idA, idB);
  // 删 A
  const del = await api('/api/customer-delete', { method: 'POST', body: { id: idA } });
  assert.equal(del.json?.ok, true);
  const list = del.json.customers;
  assert.ok(!list.some(c => c.id === idA), 'A 被删');
  assert.ok(list.some(c => c.id === idB), 'B 未被误删');
  // 删不存在 → 404
  const nf = await api('/api/customer-delete', { method: 'POST', body: { id: 'c_nonexistent_xyz' } });
  assert.equal(nf.status, 404, '删不存在 id 应 404');
  assert.equal(nf.json?.ok, false);
  // 缺 id → 400
  const noId = await api('/api/customer-delete', { method: 'POST', body: {} });
  assert.equal(noId.status, 400, '缺 id 应 400');
});
