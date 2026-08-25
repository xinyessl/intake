// Git 集成 · GitLab + Gitee 双 provider · 脱库逻辑测试（mock fetch·抽真身函数沙箱 eval）
//   背景：Git 集成原写死 GitLab（glApi 打 <baseUrl>/api/v4 + PRIVATE-TOKEN）。贴 Gitee 地址会 404。
//         本次按 provider 分流：gitProvider(cfg) 判定（cfg.provider 显式优先，否则 baseUrl host 含 gitee.com→gitee）；
//         gitInspect gitee 分支（单仓 /repos/{o}/{r}、owner /orgs/{o}/repos 兜 /users/{o}/repos）；authGitUrl 两 provider 注入 token。
//   本地 MySQL 常 ECONNREFUSED、server.mjs 启动即 await db.init() 失败退出——故全部从 server.mjs 源码抽真身函数沙箱 eval + mock fetch。
//     · 注入可控 readGitCfg / gitBase / GITEE_API_BASE / fetch，测真实源码（非重写副本，能抓漂移）。
//   覆盖 AC（PD-01 新增 AC-26）：
//     A gitProvider 判定（gitee.com→gitee、gitlab host→gitlab、无 baseUrl 缺省 gitlab、显式 provider 优先）
//     B gitInspect gitee URL→API 路径映射（单仓 /repos/o/r；owner /orgs/o/repos 成功；owner /orgs 失败兜 /users/o/repos）
//     C authGitUrl 两 provider 注入正确（gitlab/gitee 均 oauth2:{token}@；已带凭证先剥后注入不叠加）
//     D GitLab 分支不回归（gitProvider=gitlab 时 gitInspect 仍打 /api/v4、组/单仓两分支不变）
//   用法：node --test tools/git-provider.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

// —— 从源码抽出具名函数体（兼容 function / async function），沙箱 eval —— //
//   注意（见 docs/lessons.md）：先配平参数括号 (...) 再找函数体 { ，避免解构参数误截。本批函数参数皆非解构，但仍用稳健版。
function extractFn(src, name) {
  const asyncStart = src.indexOf('async function ' + name + '(');
  const plainStart = src.indexOf('function ' + name + '(');
  const start = asyncStart >= 0 ? asyncStart : plainStart;
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  // 先配平参数括号 (...)
  const parenOpen = src.indexOf('(', start);
  let pd = 0, parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') { pd--; if (pd === 0) { parenClose = i; break; } }
  }
  assert.ok(parenClose > parenOpen, `应能配平 ${name} 的参数括号`);
  const braceOpen = src.indexOf('{', parenClose);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}

// 构建沙箱：注入可控 readGitCfg / fetch / gitBase / GITEE_API_BASE；返回真身函数。
//   CFG 与 FETCH 是可变闭包变量，各用例前重置以驱动不同 provider / API 响应。
function buildSandbox() {
  let CFG = {};                 // 当前 git-config（readGitCfg 返回它）
  const CALLS = [];             // 记录每次 fetch 的 url（断言路径映射）
  let RESP = () => { throw new Error('no-mock'); };   // (url)=>{ok,json} 决定 mock 响应
  const readGitCfg = () => CFG;
  const gitBase = () => (CFG.baseUrl || '').replace(/\/$/, '');
  const fetchMock = async (url) => {
    CALLS.push(String(url));
    const r = RESP(String(url));           // {ok, status?, body}
    return { ok: r.ok !== false, status: r.status || (r.ok === false ? 404 : 200), json: async () => r.body };
  };
  const fns = new Function(
    'readGitCfg', 'gitBase', 'GITEE_API_BASE', 'fetch', 'URL', 'encodeURIComponent',
    extractFn(SRC, 'sanId') + '\n' +
    extractFn(SRC, 'gitProvider') + '\n' +
    extractFn(SRC, 'authGitUrl') + '\n' +
    extractFn(SRC, 'gitUrlPath') + '\n' +
    extractFn(SRC, 'giteeApi') + '\n' +
    extractFn(SRC, 'glApi') + '\n' +
    extractFn(SRC, 'gitInspectGitee') + '\n' +
    extractFn(SRC, 'gitInspect') + '\n' +
    'return { sanId, gitProvider, authGitUrl, gitUrlPath, giteeApi, glApi, gitInspectGitee, gitInspect };'
  )(readGitCfg, gitBase, 'https://gitee.com/api/v5', fetchMock, URL, encodeURIComponent);
  return {
    fns,
    setCfg: c => { CFG = c || {}; },
    setResp: fn => { RESP = fn; },
    calls: CALLS,
  };
}

/* ================= A. gitProvider 判定 ================= */
test('A1 baseUrl host 含 gitee.com → gitee', () => {
  const s = buildSandbox();
  assert.equal(s.fns.gitProvider({ baseUrl: 'https://gitee.com/xinye666', token: 't' }), 'gitee');
  assert.equal(s.fns.gitProvider({ baseUrl: 'https://gitee.com', token: 't' }), 'gitee');
});
test('A2 baseUrl 是 gitlab host → gitlab', () => {
  const s = buildSandbox();
  assert.equal(s.fns.gitProvider({ baseUrl: 'https://gitlab.lcpharmacy.cn', token: 't' }), 'gitlab');
  assert.equal(s.fns.gitProvider({ baseUrl: 'https://gitlab.example.com/g', token: 't' }), 'gitlab');
});
test('A3 无 baseUrl / 空配置 → 缺省 gitlab（向后兼容）', () => {
  const s = buildSandbox();
  assert.equal(s.fns.gitProvider({}), 'gitlab');
  assert.equal(s.fns.gitProvider({ token: 't' }), 'gitlab');
});
test('A4 cfg.provider 显式优先（覆盖 host 推断）', () => {
  const s = buildSandbox();
  // host 是 gitlab 但显式声明 gitee → 以显式为准
  assert.equal(s.fns.gitProvider({ baseUrl: 'https://git.mycorp.com', provider: 'gitee', token: 't' }), 'gitee');
  // host 含 gitee 但显式声明 gitlab（自建 gitee 反代等）→ 以显式为准
  assert.equal(s.fns.gitProvider({ baseUrl: 'https://gitee.com/x', provider: 'gitlab', token: 't' }), 'gitlab');
  // 非法 provider 值忽略，回落 host 推断
  assert.equal(s.fns.gitProvider({ baseUrl: 'https://gitee.com/x', provider: 'github', token: 't' }), 'gitee');
});
test('A5 gitProvider 无参 → 读 readGitCfg()（默认参数分支）', () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/xinye666', token: 't' });
  assert.equal(s.fns.gitProvider(), 'gitee');
  s.setCfg({ baseUrl: 'https://gitlab.lcpharmacy.cn', token: 't' });
  assert.equal(s.fns.gitProvider(), 'gitlab');
});

/* ================= B. gitInspect gitee 分支：URL → API 路径映射 ================= */
test('B1 单仓 owner/repo → GET /repos/{owner}/{repo}，subsystems 仅它一个（真 Gitee 响应形状）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/xinye666', token: 'GITEE_TOK' });
  s.setResp((url) => {
    assert.match(url, /^https:\/\/gitee\.com\/api\/v5\/repos\/xinye666\/wzh2\.0\?/, '打 /repos/{owner}/{repo}');
    assert.match(url, /access_token=GITEE_TOK/, 'access_token 查询参数认证');
    // 真 Gitee：无 clone_url 字段；html_url 已自带 .git
    return { ok: true, body: { path: 'wzh2.0', name: 'wzh2.0', full_name: 'xinye666/wzh2.0', description: '万知汇 2.0', html_url: 'https://gitee.com/xinye666/wzh2.0.git', ssh_url: 'git@gitee.com:xinye666/wzh2.0.git', private: true, namespace: { type: 'personal', path: 'xinye666' } } };
  });
  const r = await s.fns.gitInspect('https://gitee.com/xinye666/wzh2.0');
  assert.equal(r.id, 'wzh2-0', 'id=sanId(仓名)');
  assert.equal(r.name, 'xinye666/wzh2.0', 'name=full_name');
  assert.equal(r.gitUrl, 'https://gitee.com/xinye666/wzh2.0', '顶层 gitUrl 去掉 html_url 自带的 .git');
  assert.equal(r.subsystems.length, 1, '单仓 → 1 个子系统');
  const sub = r.subsystems[0];
  assert.equal(sub.key, 'wzh2.0');
  assert.equal(sub.name, 'xinye666/wzh2.0');
  assert.equal(sub.desc, '万知汇 2.0', 'desc=description trim');
  assert.equal(sub.repoUrl, 'https://gitee.com/xinye666/wzh2.0.git', 'repoUrl 归一为单个 .git（非 .git.git）');
  assert.doesNotMatch(sub.repoUrl, /\.git\.git$/, '绝不出现 .git.git');
});
test('B1a 单仓：有 clone_url 时优先用 clone_url（并归一）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/o', token: 't' });
  s.setResp(() => ({ ok: true, body: { path: 'r', name: 'r', clone_url: 'https://gitee.com/o/r.git', html_url: 'https://gitee.com/o/r.git' } }));
  const r = await s.fns.gitInspect('https://gitee.com/o/r');
  assert.equal(r.subsystems[0].repoUrl, 'https://gitee.com/o/r.git', 'clone_url 优先、归一为单个 .git');
});
test('B1b 单仓：html_url 不带 .git 时也归一为单个 .git', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/o', token: 't' });
  s.setResp(() => ({ ok: true, body: { path: 'r', name: 'r', html_url: 'https://gitee.com/o/r' } }));   // 无 clone_url、html_url 无 .git
  const r = await s.fns.gitInspect('https://gitee.com/o/r');
  assert.equal(r.subsystems[0].repoUrl, 'https://gitee.com/o/r.git', 'html_url+.git 归一');
});
test('B2 owner（无/）→ 先 GET /orgs/{owner}/repos，成功即列全部仓当子系统', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/xinye666', token: 't' });
  s.setResp((url) => {
    assert.match(url, /^https:\/\/gitee\.com\/api\/v5\/orgs\/xinye666\/repos\?/, '先打 /orgs/{owner}/repos');
    assert.match(url, /type=all&per_page=100/, '带 type=all&per_page=100');
    // 真 Gitee：html_url 自带 .git
    return { ok: true, body: [
      { path: 'wzh2.0', name: 'wzh2.0', full_name: 'xinye666/wzh2.0', description: '万知汇', html_url: 'https://gitee.com/xinye666/wzh2.0.git' },
      { path: 'core', name: 'core', full_name: 'xinye666/core', description: '', html_url: 'https://gitee.com/xinye666/core.git' },
    ] };
  });
  const r = await s.fns.gitInspect('https://gitee.com/xinye666');
  assert.equal(r.id, 'xinye666', 'id=sanId(owner)');
  assert.equal(r.name, 'xinye666', 'name=owner');
  assert.equal(r.gitUrl, 'https://gitee.com/xinye666', 'gitUrl=https://gitee.com/{owner}');
  assert.equal(r.subsystems.length, 2, '组下 2 仓 → 2 子系统');
  assert.equal(r.subsystems[0].key, 'wzh2.0');
  assert.equal(r.subsystems[0].repoUrl, 'https://gitee.com/xinye666/wzh2.0.git', '归一为单个 .git');
  assert.doesNotMatch(r.subsystems[0].repoUrl, /\.git\.git$/, '绝不 .git.git');
  assert.equal(r.subsystems[1].repoUrl, 'https://gitee.com/xinye666/core.git', 'core 同样归一');
  assert.equal(s.calls.length, 1, '组织命中即不再打 /users');
});
test('B3 owner：/orgs 404 → 兜 GET /users/{owner}/repos（个人账号有公开仓）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/xinye666', token: 't' });
  let step = 0;
  s.setResp((url) => {
    step++;
    if (step === 1) { assert.match(url, /\/orgs\/xinye666\/repos\?/, '第一步打 /orgs'); return { ok: false, status: 404, body: { message: 'Not Found' } }; }
    assert.match(url, /\/users\/xinye666\/repos\?/, '/orgs 失败后兜 /users');
    assert.match(url, /type=all&per_page=100/);
    return { ok: true, body: [{ path: 'wzh2.0', name: 'wzh2.0', full_name: 'xinye666/wzh2.0', html_url: 'https://gitee.com/xinye666/wzh2.0.git' }] };
  });
  const r = await s.fns.gitInspect('https://gitee.com/xinye666');
  assert.equal(r.subsystems.length, 1, '/users 兜底列出仓');
  assert.equal(r.subsystems[0].key, 'wzh2.0');
  assert.equal(r.subsystems[0].repoUrl, 'https://gitee.com/xinye666/wzh2.0.git', '归一 .git');
  assert.equal(s.calls.length, 2, '先 /orgs 再 /users 两次调用');
});
test('B3b owner 三级兜底：/orgs 404 + /users 空 → /user/repos 按 owner 过滤（个人号私有仓）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/xinye666', token: 't' });
  let step = 0;
  s.setResp((url) => {
    step++;
    if (step === 1) { assert.match(url, /\/orgs\/xinye666\/repos\?/, '第一步 /orgs'); return { ok: false, status: 404, body: { message: 'Not Found' } }; }
    if (step === 2) { assert.match(url, /\/users\/xinye666\/repos\?/, '第二步 /users'); return { ok: true, body: [] }; }   // 公开仓为空（私有不列）
    assert.match(url, /\/user\/repos\?/, '第三步兜当前 token 名下全部仓 /user/repos');
    assert.match(url, /type=all&per_page=100/);
    // 混合 owner：只有 namespace.path===xinye666 或 full_name 以 xinye666/ 开头的才该被取
    return { ok: true, body: [
      { path: 'wzh2.0', name: 'wzh2.0', full_name: 'xinye666/wzh2.0', private: true, html_url: 'https://gitee.com/xinye666/wzh2.0.git', namespace: { type: 'personal', path: 'xinye666' } },
      { path: 'other', name: 'other', full_name: 'momo_hz/other', private: true, html_url: 'https://gitee.com/momo_hz/other.git', namespace: { type: 'personal', path: 'momo_hz' } },
      { path: 'byname', name: 'byname', full_name: 'xinye666/byname', private: false, html_url: 'https://gitee.com/xinye666/byname.git' },   // 无 namespace，靠 full_name 前缀命中
    ] };
  });
  const r = await s.fns.gitInspect('https://gitee.com/xinye666');
  assert.equal(s.calls.length, 3, '三级都走：/orgs → /users → /user/repos');
  assert.equal(r.subsystems.length, 2, '只取 owner=xinye666 的两仓（momo_hz 被过滤）');
  const keys = r.subsystems.map(x => x.key).sort();
  assert.deepEqual(keys, ['byname', 'wzh2.0'], 'namespace.path 命中 + full_name 前缀命中');
  assert.ok(r.subsystems.every(x => x.repoUrl.endsWith('.git') && !x.repoUrl.endsWith('.git.git')), 'repoUrl 全部归一为单 .git');
  assert.equal(r.subsystems.find(x => x.key === 'wzh2.0').repoUrl, 'https://gitee.com/xinye666/wzh2.0.git');
});
test('B3c owner 三级都空 → subsystems 空数组，不报错', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/nobody', token: 't' });
  s.setResp((url) => {
    if (url.includes('/orgs/')) return { ok: false, status: 404, body: { message: 'Not Found' } };
    if (url.includes('/users/')) return { ok: true, body: [] };
    return { ok: true, body: [{ full_name: 'someoneelse/x', html_url: 'https://gitee.com/someoneelse/x.git', namespace: { path: 'someoneelse' } }] };   // 无一命中 owner
  });
  const r = await s.fns.gitInspect('https://gitee.com/nobody');
  assert.equal(r.subsystems.length, 0, '无匹配 → 空 subsystems（不抛）');
  assert.equal(r.id, 'nobody');
});
test('B4 giteeApi：!ok 抛 message（Gitee 错误提示原样透出）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/o', token: 't' });
  s.setResp(() => ({ ok: false, status: 401, body: { message: '401 Unauthorized: Access token 无效' } }));
  await assert.rejects(() => s.fns.gitInspect('https://gitee.com/o/r'), /Access token 无效/, 'Gitee message 透出');
});
test('B5 giteeApi：未配 token → 明确报错，不打网络', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/o' });   // 无 token
  await assert.rejects(() => s.fns.gitInspect('https://gitee.com/o/r'), /未配置 Git 集成/);
  assert.equal(s.calls.length, 0, '无 token 不发请求');
});
test('B6 giteeApi：pathq 已带 ? 时用 & 拼 access_token（不产生双 ?）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/o', token: 't' });
  s.setResp((url) => {
    assert.ok((url.match(/\?/g) || []).length === 1, '只有一个 ?');
    assert.match(url, /per_page=100&access_token=t$/, '带 ? 的路径用 & 追加 access_token');
    return { ok: true, body: [] };
  });
  await s.fns.gitInspect('https://gitee.com/o');
});
test('B7 cloneOf 归一：既无 clone_url 也无 html_url → repoUrl 空串（不拼出裸 .git）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitee.com/o', token: 't' });
  s.setResp(() => ({ ok: true, body: { path: 'r', name: 'r' } }));   // 两地址字段都缺
  const r = await s.fns.gitInspect('https://gitee.com/o/r');
  assert.equal(r.subsystems[0].repoUrl, '', '无任何克隆地址 → 空串');
});

/* ================= C. authGitUrl 两 provider token 注入 ================= */
test('C1 gitlab https 地址注入 oauth2:{token}@', () => {
  const s = buildSandbox();
  const u = s.fns.authGitUrl('https://gitlab.lcpharmacy.cn/g/core.git', { token: 'glpat-XXX' });
  assert.equal(u, 'https://oauth2:glpat-XXX@gitlab.lcpharmacy.cn/g/core.git');
});
test('C2 gitee https 地址注入 oauth2:{token}@（同形式，真仓已验可 clone/ls-remote）', () => {
  const s = buildSandbox();
  const u = s.fns.authGitUrl('https://gitee.com/xinye666/wzh2.0.git', { token: 'GITEE_TOK' });
  assert.equal(u, 'https://oauth2:GITEE_TOK@gitee.com/xinye666/wzh2.0.git');
});
test('C3 已带旧凭证的地址 → 先剥后注入，不叠加（防轮换后 oauth2:a@oauth2:b@）', () => {
  const s = buildSandbox();
  const u = s.fns.authGitUrl('https://oauth2:OLD@gitee.com/o/r.git', { token: 'NEW' });
  assert.equal(u, 'https://oauth2:NEW@gitee.com/o/r.git', '旧 oauth2:OLD@ 被剥、重嵌新 token');
});
test('C4 无 token / 无 repoUrl → 原样返回（不注入空凭证）', () => {
  const s = buildSandbox();
  assert.equal(s.fns.authGitUrl('https://gitee.com/o/r.git', {}), 'https://gitee.com/o/r.git');
  assert.equal(s.fns.authGitUrl('', { token: 't' }), '');
});

/* ================= D. GitLab 分支不回归（provider=gitlab 逐字不变） ================= */
test('D1 provider=gitlab：gitInspect 组地址仍打 /api/v4/groups + /groups/{id}/projects', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitlab.lcpharmacy.cn', token: 'glpat-X' });
  let step = 0;
  s.setResp((url) => {
    step++;
    if (step === 1) { assert.match(url, /^https:\/\/gitlab\.lcpharmacy\.cn\/api\/v4\/groups\/steward%2Fpsp$/, '第一步 /api/v4/groups/{path}'); return { ok: true, body: { id: 42, name: 'PSP', path: 'psp', full_path: 'steward/psp', web_url: 'https://gitlab.lcpharmacy.cn/steward/psp', description: '' } }; }
    assert.match(url, /^https:\/\/gitlab\.lcpharmacy\.cn\/api\/v4\/groups\/42\/projects\?/, '第二步 /api/v4/groups/{id}/projects');
    return { ok: true, body: [{ path: 'core', name: '核心', description: '核心仓', http_url_to_repo: 'https://gitlab.lcpharmacy.cn/steward/psp/core.git' }] };
  });
  const r = await s.fns.gitInspect('https://gitlab.lcpharmacy.cn/steward/psp');
  assert.equal(r.id, 'psp');
  assert.equal(r.subsystems.length, 1);
  assert.equal(r.subsystems[0].key, 'core');
  assert.equal(r.subsystems[0].repoUrl, 'https://gitlab.lcpharmacy.cn/steward/psp/core.git', 'GitLab 用 http_url_to_repo（不回归）');
  assert.ok(s.calls.every(u => u.includes('PRIVATE-TOKEN') === false), 'GitLab 走 header 认证，url 不带 token');
  assert.ok(s.calls.every(u => !u.includes('gitee')), 'GitLab 绝不打 gitee api');
});
test('D2 provider=gitlab：非组地址回退 /api/v4/projects/{path}（单仓，不回归）', async () => {
  const s = buildSandbox();
  s.setCfg({ baseUrl: 'https://gitlab.lcpharmacy.cn', token: 'glpat-X' });
  let step = 0;
  s.setResp((url) => {
    step++;
    if (step === 1) { assert.match(url, /\/api\/v4\/groups\//, '先试 group'); return { ok: false, status: 404, body: { message: '404 Group Not Found' } }; }
    assert.match(url, /^https:\/\/gitlab\.lcpharmacy\.cn\/api\/v4\/projects\/g%2Fcore$/, 'group 失败回退 /projects/{path}');
    return { ok: true, body: { path: 'core', name: '核心', description: '核心仓', web_url: 'https://gitlab.lcpharmacy.cn/g/core', http_url_to_repo: 'https://gitlab.lcpharmacy.cn/g/core.git' } };
  });
  const r = await s.fns.gitInspect('https://gitlab.lcpharmacy.cn/g/core');
  assert.equal(r.subsystems.length, 1);
  assert.equal(r.subsystems[0].repoUrl, 'https://gitlab.lcpharmacy.cn/g/core.git');
  assert.ok(s.calls.every(u => u.includes('/api/v4/')), '全程走 GitLab v4');
});
test('D3 authGitUrl gitlab 注入形式与改造前逐字一致（原 replace 语义）', () => {
  const s = buildSandbox();
  // 原逻辑：String(repoUrl).replace(/^(https?:\/\/)/, m => m+'oauth2:'+token+'@')
  const repoUrl = 'https://gitlab.lcpharmacy.cn/steward/psp/core.git', tok = 'glpat-TESTONLY-fake';
  const expect = repoUrl.replace(/^(https?:\/\/)/, (m) => m + 'oauth2:' + tok + '@');
  assert.equal(s.fns.authGitUrl(repoUrl, { token: tok }), expect, 'GitLab authUrl 与原逐字相同');
});
