// PD-01 · 子系统分支+tag 多选（每子系统各自定版本清单来源）· 脱库逻辑测试 + 连真库冒烟（MySQL 可用时）
//   背景：产品编辑抽屉里每个子系统各自「分支多选 + tag多选」，选中的 tag/分支作为该子系统「版本清单来源」，
//         收窄现在「该仓全部 git tag 并集」。没选的子系统行为与改造前一模一样（回落全 tag）。
//   本地 MySQL 常 ECONNREFUSED 3306、server.mjs 启动即 await db.init() 失败退出——故：
//     · A/B/C 组：从 server.mjs 源码抽真身函数（parseGitRefs/subsystemVersionList/normRefList/sortBranches/verCmpDesc/branchRank）沙箱 eval + 静态断言（端点/白名单）。测真实源码，能抓漂移。
//     · D 组：连真库冒烟——MySQL 起得来才跑（spawn 真 server + 打真实端点 + mysql2 核对 projects.subsystems JSON），否则整组 skip。
//   覆盖 AC：① parseGitRefs（heads/tags 前缀剥离、丢 ^{}、排序）② subsystemVersionList「选中优先 vs 未选回落全tag」③ normRefList（非数组/超长/去重）
//            ④ /api/git-refs 端点存在 + admin 域（不进 field 白名单）⑤ project-save 落库 branches/tags（连真库）
//   用法：node --test tools/pd-01-git-refs.logic.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'public/projects.html'), 'utf8');

// —— 从源码抽出具名函数体，沙箱 eval（测真实源码，非重写副本，能抓漂移） —— //
function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}
// parseGitRefs 依赖 sortBranches → branchRank → verCmpDesc；一起注入沙箱，测真实实现
const sandbox = new Function(
  extractFn(SRC, 'verCmpDesc') + '\n' +
  extractFn(SRC, 'branchRank') + '\n' +
  extractFn(SRC, 'sortBranches') + '\n' +
  extractFn(SRC, 'parseGitRefs') + '\n' +
  extractFn(SRC, 'normRefList') + '\n' +
  extractFn(SRC, 'subsystemVersionList') + '\n' +
  'return { verCmpDesc, branchRank, sortBranches, parseGitRefs, normRefList, subsystemVersionList };'
)();
const { parseGitRefs, normRefList, subsystemVersionList, sortBranches } = sandbox;

/* ================= A. parseGitRefs 真身（ls-remote 输出解析） ================= */
test('A1 parseGitRefs：剥离 refs/heads、refs/tags 前缀', () => {
  const out = [
    'abc123\trefs/heads/main',
    'def456\trefs/heads/feature-x',
    'aaa111\trefs/tags/v1.0.0',
    'bbb222\trefs/tags/v2.1.0',
  ].join('\n');
  const r = parseGitRefs(out);
  assert.deepEqual(r.branches, ['main', 'feature-x'], 'branches 剥前缀 + main 置顶');
  assert.deepEqual(r.tags, ['v2.1.0', 'v1.0.0'], 'tags 剥前缀 + 版本倒序');
});
test('A2 parseGitRefs：丢弃 ^{} 解引用行（否则版本号里混进 v1.0^{}）', () => {
  const out = [
    'aaa\trefs/tags/v1.0.0',
    'bbb\trefs/tags/v1.0.0^{}',   // annotated tag 的解引用行 → 必须丢
    'ccc\trefs/tags/v1.2.0',
    'ddd\trefs/tags/v1.2.0^{}',
  ].join('\n');
  const r = parseGitRefs(out);
  assert.deepEqual(r.tags, ['v1.2.0', 'v1.0.0'], '无 ^{} 残留、去重、倒序');
  assert.ok(!r.tags.some(t => t.includes('^{}')), '绝无 ^{} 混入');
});
test('A3 parseGitRefs：默认分支优先级 main>master>develop/dev>release/*>字母序', () => {
  const out = [
    'a\trefs/heads/zzz',
    'b\trefs/heads/release/2.0',
    'c\trefs/heads/dev',
    'd\trefs/heads/master',
    'e\trefs/heads/main',
    'f\trefs/heads/abc',
  ].join('\n');
  const r = parseGitRefs(out);
  assert.deepEqual(r.branches, ['main', 'master', 'dev', 'release/2.0', 'abc', 'zzz'], '主干置顶、其余字母序');
});
test('A4 parseGitRefs：空输入 / 空行 / 只有 ref 无 sha 都不崩', () => {
  assert.deepEqual(parseGitRefs('').branches, []);
  assert.deepEqual(parseGitRefs('').tags, []);
  assert.deepEqual(parseGitRefs('\n\n  \n').tags, []);
  const r = parseGitRefs('refs/heads/main\nrefs/tags/v1.0');   // 无 sha 也兼容
  assert.deepEqual(r.branches, ['main']);
  assert.deepEqual(r.tags, ['v1.0']);
});
test('A5 parseGitRefs：数字感知倒序（v2.10 > v2.9）', () => {
  const out = ['a\trefs/tags/v2.9.0', 'b\trefs/tags/v2.10.0', 'c\trefs/tags/v2.2.0'].join('\n');
  assert.deepEqual(parseGitRefs(out).tags, ['v2.10.0', 'v2.9.0', 'v2.2.0'], 'numeric 倒序，v2.10 排 v2.9 前');
});

/* ================= B. subsystemVersionList：选中优先 vs 未选回落全 tag（核心向后兼容） ================= */
test('B1 未选（tags/branches 皆空）→ 回落该仓全 tag（老产品行为不变）', () => {
  const all = ['v2.0', 'v1.0'];
  assert.deepEqual(subsystemVersionList([], [], all), all, '空选 → 原样全 tag');
  assert.deepEqual(subsystemVersionList(null, undefined, all), all, 'null/undefined 也回落');
});
test('B2 有选 tag → 只用所选 tag（版本倒序），不再是全 tag 并集', () => {
  const all = ['v3.0', 'v2.0', 'v1.0'];
  const r = subsystemVersionList(['v1.0', 'v3.0'], [], all);
  assert.deepEqual(r, ['v3.0', 'v1.0'], '只含所选、倒序、v2.0 被收窄掉');
});
test('B3 有选 branch → 分支作「滚动版本」排在 tag 之后（版本字符串=分支名）', () => {
  const r = subsystemVersionList(['v2.0'], ['main', 'develop'], ['v2.0', 'v1.0']);
  assert.deepEqual(r, ['v2.0', 'main', 'develop'], 'tag 在前、branch 在后（main 优先于 develop）');
});
test('B4 只选 branch（无 tag）→ 清单 = 分支名，回落逻辑不触发', () => {
  const r = subsystemVersionList([], ['main'], ['v9.9']);
  assert.deepEqual(r, ['main'], '有选 branch 即视为已选，不回落全 tag');
});
test('B5 选中项去重 + tag/branch 同名不重复（branch 去掉已在 tag 里的）', () => {
  const r = subsystemVersionList(['v1.0', 'v1.0'], ['v1.0', 'main'], []);
  assert.deepEqual(r, ['v1.0', 'main'], 'tag 去重、branch 里的 v1.0 与 tag 撞被过滤');
});

/* ================= C. normRefList：project-save 落库前归一化（非数组/超长/去重/上限） ================= */
test('C1 非数组 → []', () => {
  assert.deepEqual(normRefList(null), []);
  assert.deepEqual(normRefList(undefined), []);
  assert.deepEqual(normRefList('main'), []);
  assert.deepEqual(normRefList({}), []);
});
test('C2 trim + 去空 + 去重', () => {
  assert.deepEqual(normRefList(['  v1.0 ', 'v1.0', '', '  ', 'main']), ['v1.0', 'main']);
});
test('C3 单元素 ≤200 字符（超长截断）', () => {
  const long = 'x'.repeat(300);
  const r = normRefList([long]);
  assert.equal(r.length, 1);
  assert.equal(r[0].length, 200, '截断到 200');
});
test('C4 数组 ≤100（超长上限截断）', () => {
  const many = Array.from({ length: 250 }, (_, i) => 'v' + i);
  assert.equal(normRefList(many).length, 100, '最多 100 个');
});
test('C5 数字元素被字符串化收下、非字符串/数字元素丢弃', () => {
  assert.deepEqual(normRefList([1, 2, {}, [], null, 'v3']), ['1', '2', 'v3']);
});

/* ================= D. 静态断言（端点存在 + admin 域·不进 field 白名单 + 前端接线） ================= */
test('D1 server：新端点 /api/git-refs 存在且为 POST', () => {
  assert.match(SRC, /url\.pathname === '\/api\/git-refs' && req\.method === 'POST'/, '路由存在');
});
test('D2 server：/api/git-refs 是 admin 域 —— 不进 FIELD_OK / FS08_FIELD_API / LINK_OK 白名单', () => {
  const linkOk = SRC.match(/const LINK_OK = new Set\(\[[\s\S]*?\]\)/)[0];
  const fieldOk = SRC.match(/const FIELD_OK = new Set\(\[[\s\S]*?\]\)/)[0];
  const fs08 = SRC.match(/const FS08_FIELD_API = new Set\(\[[\s\S]*?\]\)/)[0];
  assert.doesNotMatch(linkOk, /git-refs/, 'git-refs 不进 LINK_OK（非访客链接面）');
  assert.doesNotMatch(fieldOk, /git-refs/, 'git-refs 不进 FIELD_OK（非 field 域）');
  assert.doesNotMatch(fs08, /git-refs/, 'git-refs 不进 FS08_FIELD_API（非 field 域）');
});
test('D3 server：lsRemoteRefs 用 git ls-remote --heads --tags（只读，不 clone）+ token 注入 + 超时', () => {
  const fn = extractFn(SRC, 'lsRemoteRefs');
  assert.match(fn, /ls-remote', '--heads', '--tags'/, 'ls-remote --heads --tags');
  // 2026-08-25 Gitee 支持：token 注入抽到共享 authGitUrl(provider 化)，cloneRepo/lsRemoteRefs 复用同一函数（原内联 oauth2:'+c.token+'@ 语义在 authGitUrl 内，逐字不变见 git-provider.logic.test C/D）
  assert.match(fn, /authGitUrl\(repoUrl, c\)/, 'token 注入走共享 authGitUrl（同 cloneRepo）');
  assert.match(fn, /timeout: 20000/, '20s 超时');
  assert.match(fn, /未配置 Git token/, '无 token 明确提示');
  assert.doesNotMatch(fn, /\bclone\b/, '绝不 clone（只读 ls-remote）');
});
test('D4 server：project-save 归一化并持久化 subsystems[].{branches,tags}（normRefList）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/project-save'"), SRC.indexOf("url.pathname === '/api/project-delete'"));
  assert.match(seg, /branches: normRefList\(s\.branches\), tags: normRefList\(s\.tags\)/, 'subsIn 归一化 branches/tags');
  assert.match(seg, /if \(s\.branches\.length\) o\.branches = s\.branches; if \(s\.tags\.length\) o\.tags = s\.tags;/, '非空才落字段（附加式，向后兼容）');
});
test('D5 server：versionsBySubsystem / listVersions 用 subsystemVersionList（选中优先、未选回落）', () => {
  const vbs = extractFn(SRC, 'versionsBySubsystem');
  const lv = extractFn(SRC, 'listVersions');
  assert.match(vbs, /subsystemVersionList\(/, 'versionsBySubsystem 走 subsystemVersionList');
  assert.match(lv, /subsystemVersionList\(s && s\.tags, s && s\.branches, allTags\)/, 'listVersions 走 subsystemVersionList');
});
test('D6 前端：编辑抽屉每子系统各有分支/tag 多选控件 + 打 /api/git-refs + 保存带 branches/tags', () => {
  assert.match(HTML, /function refFieldHtml\(k,kind,label,icon\)/, 'refFieldHtml 渲染单个 ref 多选');
  assert.match(HTML, /refFieldHtml\(k,'branch','分支'/, '分支多选');
  assert.match(HTML, /refFieldHtml\(k,'tag','tag'/, 'tag 多选');
  assert.match(HTML, /fetch\('\/api\/git-refs'/, '拉 refs 打 /api/git-refs');
  assert.match(HTML, /return \{\.\.\.s, branches, tags\}/, '保存 payload 各子系统带 branches/tags');
  assert.match(HTML, /可搜索|ref-search/, 'tag 面板可搜索过滤');
  assert.match(HTML, /已失效/, '已选但 remote 已无的 ref 标「已失效」不静默丢');
});

/* ================= E. 连真库冒烟（MySQL 起得来才跑，否则整组 skip） ================= */
import { spawn } from 'node:child_process';
let mysql = null, pool = null, MYSQL_UP = false, srv = null;
const PORT = 6550 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'pd01refs-' + Date.now().toString(36);
let adminCookie = '', projBefore = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function req(p, { method = 'GET', body, cookie } = {}) {
  return fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined })
    .then(async r => ({ status: r.status, setCookie: r.headers.get('set-cookie'), json: await r.json().catch(() => null) }));
}

before(async () => {
  try {
    mysql = (await import('mysql2/promise')).default;
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
    pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci', connectTimeout: 2500 });
    await pool.query('SELECT 1');
    MYSQL_UP = true;
  } catch { MYSQL_UP = false; if (pool) { try { await pool.end(); } catch {} pool = null; } return; }
  const [[pb]] = await pool.query('SELECT COUNT(*) n FROM projects'); projBefore = pb.n;
  await pool.query('DELETE FROM projects WHERE id=?', [PID]);
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  const lg = await req('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  adminCookie = (lg.setCookie || '').split(';')[0];
});
after(async () => {
  if (!MYSQL_UP) return;
  try { await req('/api/project-delete', { method: 'POST', body: { id: PID }, cookie: adminCookie }); } catch {}
  try { await pool.query('DELETE FROM projects WHERE id=?', [PID]); } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/repos', PID), { recursive: true, force: true }); } catch {}
  try { const [[pa]] = await pool.query('SELECT COUNT(*) n FROM projects'); assert.equal(pa.n, projBefore, 'after：真库 projects 基线未污染'); } catch {}
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

test('E1 连真库：project-save 落 subsystems[].{branches,tags} 进 projects.subsystems JSON（字段名核对）', { skip: !MYSQL_UP ? '本地 MySQL 不可用（ECONNREFUSED），跳过连真库冒烟' : false }, async () => {
  // 无 repoUrl（不触发 clone/网络），只验 branches/tags 落库 —— 抓「代码列名/JSON字段名 vs 真实库」错配
  const save = await req('/api/project-save', {
    method: 'POST', cookie: adminCookie,
    body: { id: PID, name: 'PD01 refs 冒烟', subsystems: [
      { key: 'core', name: '核心', desc: '核心仓', branches: ['main', 'develop'], tags: ['v2.0', 'v1.0'] },
      { key: 'web', name: '前端', branches: [], tags: [] },   // 未选 → 落库不应带 branches/tags 字段
    ] },
  });
  assert.equal(save.status, 200); assert.equal(save.json?.ok, true, 'project-save ok');
  // 直查真库 projects.subsystems JSON（列名 subsystems，非驼峰）
  const [[row]] = await pool.query('SELECT subsystems FROM projects WHERE id=?', [PID]);
  const subs = typeof row.subsystems === 'string' ? JSON.parse(row.subsystems) : row.subsystems;
  const core = subs.find(s => s.key === 'core'), web = subs.find(s => s.key === 'web');
  assert.deepEqual(core.branches, ['main', 'develop'], 'core.branches 落库');
  assert.deepEqual(core.tags, ['v2.0', 'v1.0'], 'core.tags 落库');
  assert.equal(core.name, '核心', 'name 原字段不丢');
  assert.equal(core.desc, '核心仓', 'desc 原字段不丢');
  assert.ok(!('branches' in web), '未选子系统不落 branches 字段（附加式，向后兼容）');
  assert.ok(!('tags' in web), '未选子系统不落 tags 字段');
});

test('E2 连真库：/api/versions 未选子系统回落全 tag、行为与改造前一致（向后兼容）', { skip: !MYSQL_UP ? '本地 MySQL 不可用，跳过' : false }, async () => {
  // 该产品子系统无 repoPath（未 clone），versions 应为空数组、不崩（回落逻辑读不到 tag 时 = 空）
  const v = await req('/api/versions?project=' + encodeURIComponent(PID), { cookie: adminCookie });
  assert.equal(v.status, 200);
  assert.ok(Array.isArray(v.json?.versions), 'versions 是数组');
  assert.ok(v.json?.bySub && typeof v.json.bySub === 'object', 'bySub 存在');
  // 有选的 core：即使没 clone，也应吐所选 tag+branch（版本清单来源=所选，不依赖本地 tag）
  assert.deepEqual(v.json.bySub['核心'], ['v2.0', 'v1.0', 'main', 'develop'], 'core 版本清单=所选 tag(倒序)+branch(滚动)');
  assert.deepEqual(v.json.bySub['前端'], [], '未选 + 未 clone → 空（回落全 tag 但仓不存在 = 空）');
});

test('E3 连真库：/api/git-refs 未配 token → 各仓 error 提示、整体不 500', { skip: !MYSQL_UP ? '本地 MySQL 不可用，跳过' : false }, async () => {
  const r = await req('/api/git-refs', { method: 'POST', cookie: adminCookie, body: { subsystems: [{ key: 'core', repoUrl: 'https://gitlab.example.com/g/core.git' }] } });
  assert.equal(r.status, 200, '整体不 500');
  assert.equal(r.json?.ok, true);
  const core = r.json?.refs?.core;
  assert.ok(core, 'core 有条目');
  assert.ok(Array.isArray(core.branches) && Array.isArray(core.tags), 'branches/tags 是数组');
  // 未配 token 或拉取失败 → error 非空（本地测试环境通常未配 gitlab token）
  assert.ok(typeof core.error === 'string', 'error 字段存在（未配 token / 拉取失败明确提示，不静默空）');
});

test('E4 连真库：/api/git-refs 越权 —— 未登录/非 admin 被 authGate 挡（deny-by-default）', { skip: !MYSQL_UP ? '本地 MySQL 不可用，跳过' : false }, async () => {
  const r = await req('/api/git-refs', { method: 'POST', body: { subsystems: [{ key: 'core', repoUrl: 'https://x/core.git' }] } });   // 无 cookie
  assert.ok(r.status === 401 || r.status === 403, 'git-refs 需登录（admin 域）→ 401/403，未静默放行');
});
