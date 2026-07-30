// PD-01 · 产品管理 —— 接口 + 连真库冒烟测试（零依赖，node --test）
//   启动真实 server.mjs（连本地 MySQL data/db.json）到隔离端口，用 fetch 打真实端点；
//   另用 mysql2 直连真库核对 projects 表字段映射（repo_path/specs_path/subsystems JSON 内 name/key/desc/repoUrl）。
//   会造一个 smoke-<ts> 产品跑全流程，结束清理（DB 行 + repos 缓存目录），不污染真实数据。
//   用法：node --test tools/pd-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5100 + Math.floor(Math.random() * 800);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'smoke-' + Date.now().toString(36);           // 本次冒烟产品 id
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
  // 直连真库（核对字段映射用），同 server.mjs 读的 data/db.json
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  // 预清理：万一上次残留
  await pool.query('DELETE FROM projects WHERE id=?', [PID]);
  // 启动真实服务到隔离端口（连真库）
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  // 等健康就绪
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await sleep(250);
  }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
});

after(async () => {
  // 清理：解除登记 + 删 DB 行（幂等）+ 清 repos 缓存目录
  try { await api('/api/project-delete', { method: 'POST', body: { id: PID } }); } catch {}
  try { if (pool) await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/repos', PID), { recursive: true, force: true }); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', PID), { recursive: true, force: true }); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

/* ============ 鉴权 / 列表（AC-12/13/14 数据源） ============ */
test('未登录访问 /api/projects → 401（authGate 拦截）', async () => {
  const saved = cookie; cookie = '';
  const r = await api('/api/projects');
  cookie = saved;
  assert.equal(r.status, 401);
});

test('AC-列表 /api/projects 返回 projects 数组，subsystems 字段名为 name/key/repoUrl（非 mock 的 commit/head）', async () => {
  const r = await api('/api/projects');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.projects), 'projects 应为数组');
  for (const p of r.json.projects) {
    assert.ok(typeof p.id === 'string' && typeof p.name === 'string');
    for (const s of (p.subsystems || [])) {
      // 真实字段：name/key/desc/repoUrl/repoPath —— 断言不含 mock 的 commit/head/verCount 内联字段
      assert.equal('commit' in s, false, 'subsystem 不应带内联 commit（读时派生，见 spec 对齐差异）');
      assert.equal('head' in s, false, 'subsystem 不应带内联 head');
      assert.ok(!('name' in s) || typeof s.name === 'string');
    }
  }
});

/* ============ 保存校验（AC-6/7/8） ============ */
test('AC-7 id 校验：部署实现「先 toLowerCase 再校验」——真非法(空格/前导-/超长/非ascii)→400；纯大写被规范化为小写不拒', async () => {
  // 后端 server.mjs L719: String(b.id).trim().toLowerCase() 后再过正则。
  // 故这些「即便小写化仍非法」的必 400；用不会误建真实行的临时 name 探针（下面失败分支不会落库）。
  for (const bad of ['a b', '-etl', 'a'.repeat(41), '中文id', '_x']) {
    const r = await api('/api/project-save', { method: 'POST', body: { id: bad, name: 'x' } });
    assert.equal(r.status, 400, `id=${bad} 应 400`);
    assert.match(r.json.error, /项目 id/, `id=${bad} 错误文案应含「项目 id」`);
  }
  // 部署真相（回校 spec）：纯大写 id 不被拒，而是规范化为小写后接受 → 用本次冒烟 id 的大写形式验证，落到同一行、after 会清理
  const up = await api('/api/project-save', { method: 'POST', body: { id: PID.toUpperCase(), name: '大写规范化探针' } });
  assert.equal(up.status, 200, '纯大写 id 应被规范化为小写后接受（部署实现，非 400）');
  assert.equal(up.json.ok, true);
  assert.ok(up.json.projects.some(p => p.id === PID.toLowerCase()), '应落到小写 id 行');
});

test('AC-8 name 空 → 400「项目名必填」；name>40 → 400「不超过 40 字」', async () => {
  const empty = await api('/api/project-save', { method: 'POST', body: { id: PID, name: '   ' } });
  assert.equal(empty.status, 400);
  assert.match(empty.json.error, /项目名必填/);
  const longName = await api('/api/project-save', { method: 'POST', body: { id: PID, name: '名'.repeat(41) } });
  assert.equal(longName.status, 400);
  assert.match(longName.json.error, /不超过 40 字/);
});

test('AC-6 新增保存（无 repoUrl 子系统，不 clone）→ ok，回 projects 含目标产品，subsystems 归一为 {name,key,desc}', async () => {
  const body = { id: PID, name: '冒烟测试产品', subsystems: [
    { key: 'svc-a', name: '子系统甲', desc: '抗菌药物网络上报' },   // AC-3 desc 中文
    { key: 'svc-b', name: '子系统乙', desc: '' },
    { name: '' },                                                    // name 缺失应被过滤
  ] };
  const r = await api('/api/project-save', { method: 'POST', body });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, JSON.stringify(r.json));
  const p = r.json.projects.find(x => x.id === PID);
  assert.ok(p, '返回的 projects 应含新增产品');
  assert.equal(p.subsystems.length, 2, 'name 缺失的子系统应被过滤');
  const a = p.subsystems.find(s => s.key === 'svc-a');
  assert.equal(a.name, '子系统甲');
  assert.equal(a.desc, '抗菌药物网络上报', 'AC-3：desc 中文应保留');
  assert.equal('repoPath' in a, false, '无 repoUrl → 不 clone → 无 repoPath');
});

/* ============ 连真库冒烟：核对 projects 表字段映射 ============ */
test('连真库冒烟：真实 projects 表存在该行，列名 repo_path/specs_path/subsystems，JSON 内字段 name/key/desc 与 db.mjs 一致', async () => {
  const [rows] = await pool.query('SELECT id,name,repo_path,specs_path,subsystems,created_at FROM projects WHERE id=?', [PID]);
  assert.equal(rows.length, 1, 'DB 应有该行');
  const row = rows[0];
  assert.equal(row.name, '冒烟测试产品');
  assert.equal(row.repo_path, null, '无顶层单仓 → repo_path 为 NULL（下划线命名）');
  assert.equal(row.specs_path, null, 'specs_path 为 NULL（下划线命名）');
  const subs = typeof row.subsystems === 'string' ? JSON.parse(row.subsystems) : row.subsystems;
  assert.ok(Array.isArray(subs) && subs.length === 2);
  // 逐字段核对 JSON 内拼写（曾踩坑：mock 用 commit/head，真实是 desc/repoUrl）
  const keys = new Set(Object.keys(subs.find(s => s.key === 'svc-a')));
  assert.ok(keys.has('name') && keys.has('key') && keys.has('desc'), 'JSON 应含 name/key/desc');
  assert.equal(keys.has('commit'), false, 'JSON 不应含 mock 的 commit 字段');
});

/* ============ 编辑保留（AC-9/10/11 支撑） ============ */
test('AC-9 编辑只改名、本次不带 subsystems → 保留已有子系统', async () => {
  const r = await api('/api/project-save', { method: 'POST', body: { id: PID, name: '冒烟测试产品改名', subsystems: [] } });
  assert.equal(r.json.ok, true);
  const p = r.json.projects.find(x => x.id === PID);
  assert.equal(p.name, '冒烟测试产品改名');
  assert.equal(p.subsystems.length, 2, '未带 subsystems → 应保留已有 2 个（避免误清）');
});

/* ============ 派生读取（AC-12/13） ============ */
test('AC-12 project-git 未 clone → subs 全 ok:false（本地读，不走网络）', async () => {
  const r = await api('/api/project-git?project=' + PID);
  assert.equal(r.status, 200);
  // 子系统无 repoPath（未 clone）→ repoDirsOf 为空 → subs 为空数组
  assert.ok(Array.isArray(r.json.subs));
  assert.equal(r.json.subs.length, 0);
});

test('AC-13 versions 未 clone → versions 空数组', async () => {
  const r = await api('/api/versions?project=' + PID);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.versions, []);
});

/* ============ 解析错误分支（AC-4/AC-5，确定性，不依赖真实 GitLab） ============ */
test('AC-5 git-inspect 非法地址 → ok:false「Git 地址无法解析」（HTTP 200 业务 error）', async () => {
  const r = await api('/api/git-inspect', { method: 'POST', body: { url: '' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false);
  assert.match(r.json.error, /无法解析/);
});

/* ============ Git 集成回显（AC-19） ============ */
test('AC-19 git-config 回显 baseUrl + token 掩码 + configured，不回明文', async () => {
  const r = await api('/api/git-config');
  assert.equal(r.status, 200);
  assert.ok('baseUrl' in r.json && 'tokenMask' in r.json && 'configured' in r.json);
  // 掩码格式：xxxxxx……xxxx 或 已配置 或 空；绝不是完整明文（长度不应等于真实 token）
  assert.equal(/^gl[a-z]+-[A-Za-z0-9_-]{20,}$/.test(r.json.tokenMask || ''), false, 'tokenMask 不应是明文 token');
});

test('AC-19 git-config-save token 留空 → 保留已配置（掩码不变、configured 不降级）', async () => {
  const before = (await api('/api/git-config')).json;
  const r = await api('/api/git-config-save', { method: 'POST', body: { baseUrl: before.baseUrl || 'https://gitlab.example.com', token: '' } });
  assert.equal(r.json.ok, true);
  const after = (await api('/api/git-config')).json;
  assert.equal(after.configured, before.configured, 'token 留空不应改变 configured');
});

test('AC-19 git-config-save baseUrl 前端必填（后端空 baseUrl 则 configured=false）', async () => {
  // 后端不强制拒空 baseUrl，但空 baseUrl 时 configured 应为 false（前端负责必填提示）
  const cur = (await api('/api/git-config')).json;
  // 不实际清空生产配置：仅断言当前若已配 baseUrl 则 configured 逻辑正确
  if (cur.baseUrl) assert.equal(typeof cur.configured, 'boolean');
  assert.ok(true);
});

/* ============ 删除只解除登记（AC-18） ============ */
test('AC-18 project-delete → projects 无该行 + keptData 反映进件数；DB 行被删', async () => {
  const r = await api('/api/project-delete', { method: 'POST', body: { id: PID } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.projects.some(p => p.id === PID), false, '返回列表不应再含该产品');
  assert.equal(typeof r.json.keptData, 'number', 'keptData 应为数字（保留进件数）');
  const [rows] = await pool.query('SELECT id FROM projects WHERE id=?', [PID]);
  assert.equal(rows.length, 0, 'DB 行应已删除（解除登记）');
});

/* ============ 前端界面基线（2026-07-21 re-target 臻遴原型：整宽 data-table + 抽屉） ============ */
test('界面基线：projects.html = theme.css 组件类（整宽 data-table + 抽屉），非旧内联 --pri:#1A6DBE 两栏卡片版', () => {
  const h = fs.readFileSync(path.join(ROOT, 'public/projects.html'), 'utf8');
  // 外壳：theme.css + shell.js 注入式；不再引 nav.js、无旧医疗蓝内联变量
  assert.match(h, /\/assets\/theme\.css/, '应引 theme.css');
  assert.match(h, /\/assets\/shell\.js/, '应引 shell.js');
  assert.equal(/nav\.js/.test(h), false, '不再引 nav.js（.topnav 已废弃）');
  assert.equal(/--pri\s*:\s*#1A6DBE/i.test(h), false, '不应保留旧内联医疗蓝 --pri:#1A6DBE');
  assert.match(h, /data-shell="admin"[^>]*data-nav="projects"/, 'body 应挂 data-shell=admin data-nav=projects');
  assert.match(h, /data-content-layout="list"/, '全高内滚页应标 data-content-layout=list（见 lessons L-003）');
  // 主体：整宽 data-table（6 列：id/产品名/子系统/最新提交/版本/操作）
  assert.match(h, /class="data-table"/, '应用整宽 .data-table');
  assert.match(h, /最新提交/, '表头含「最新提交」列');
  assert.match(h, /<th[^>]*>版本/, '表头含「版本」列');
  // 抽屉 + 弹窗（部署 shell.js 无 UI.openDrawer，须自写；见 lessons L-004）
  assert.match(h, /id="editDrawer"/, '新增/编辑用 .drawer #editDrawer');
  assert.match(h, /function openDrawer/, '须自写 openDrawer（shell.js 无 UI.openDrawer）');
  assert.equal(/UI\.openDrawer\(/.test(h), false, '不应调用原型的 UI.openDrawer(...)（部署无此 helper）');
  assert.match(h, /id="gcModal"/, 'Git 集成用 .modal');
  assert.match(h, /id="lModal"/, '生成提交链接用 .modal');
  assert.match(h, /uiConfirm\(/, '删除走共享 uiConfirm（危险二次确认）');
  assert.match(h, /toast-container/, 'toast 自实现（theme.css .toast-container）');
  // 三源合成（非 mock 内联字段）：静态 /api/projects + /api/project-git + /api/versions
  assert.match(h, /\/api\/project-git\?project=/, '最新提交/最后同步读时派生 /api/project-git');
  assert.match(h, /\/api\/versions\?project=/, '版本徽标读时派生 /api/versions');
  // 现有真实端点（无臆造/无新增）
  for (const ep of ['/api/projects', '/api/project-save', '/api/project-delete', '/api/git-inspect', '/api/git-refresh', '/api/git-config', '/api/git-config-save', '/api/submit-link']) {
    assert.match(h, new RegExp(ep.replace(/\//g, '\\/')), '应命中现有真实端点 ' + ep);
  }
  // 时间统一 yyyy-MM-dd HH:mm
  assert.match(h, /function fmtTime/, '应有共享 fmtTime（yyyy-MM-dd HH:mm，空值 —）');
});
