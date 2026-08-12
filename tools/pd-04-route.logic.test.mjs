// PD-04 答疑功能模块路由检索 · 脱库逻辑测试（零依赖 node:test，无 MySQL、不 spawn server）
//   server.mjs 启动即 await db.init() 失败 process.exit(1)、无法整体 import → 从源码抽被测函数体沙箱 eval（测真实源码，抓漂移）。
//   覆盖：
//     ① routeQuestion tier-1：别名整串命中强 bonus / 关键词 IDF 打分命中 / 阈值 miss
//     ② routeQuestion tier-3：精确名（config/table/api）反查直接强命中
//     ③ routeQuestion tier-2：questionRoutes 没到阈值 → specs 兜底
//     ④ extractSection：按 anchor/section 标题定位截取；定位不到退回前段
//     ⑤ loadModuleMap / loadRouteContext：读产品仓地图 + 读被引 spec 章节 + answerFacts 置顶注入
//     ⑥ 无地图 → loadModuleMap 返 null（consult 回落 specSearch，向后兼容）
//     ⑦ routingDiag：路由决策进诊断（含无地图 enabled:false）
//   用法：node --test tools/pd-04-route.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

test('大功能地图可读取：gitOut 显式放大 maxBuffer，避免默认上限使路由静默失效', () => {
  const gitOutSource = extractFn(SRC, 'gitOut');
  assert.match(gitOutSource, /maxBuffer:\s*32\s*\*\s*1024\s*\*\s*1024/);
  assert.match(gitOutSource, /r\.status\s*===\s*0/);
});

function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  // 跳过参数列表（可能含解构 `{}`）：先配平参数括号 `(...)`，再从其后第一个 `{` 起取函数体。
  const parenOpen = src.indexOf('(', start);
  let pd = 0, parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) { if (src[i] === '(') pd++; else if (src[i] === ')') { pd--; if (pd === 0) { parenClose = i; break; } } }
  const braceOpen = src.indexOf('{', parenClose);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } } }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}
function extractConst(src, name) { const m = src.match(new RegExp('const ' + name + ' = ([^;]+);')); assert.ok(m, `应有常量 ${name}`); return m[1]; }

// —— kbTokenize（中文 bigram + 英文词）：路由打分的分词基元，直接抽真身 —— //
const kbTokenize = new Function(extractFn(SRC, 'kbTokenize') + '\nreturn kbTokenize;')();

// —— 抽路由三层 + 打分 + 章节截取 + 诊断，同一沙箱共享（互相调用）—— //
//   注入常量 + kbTokenize；safeRef/specSources/specFileText/moduleMapRepo 由 fixture 注入（读文件用）。
function buildRoutingSandbox(deps) {
  const consts =
    `const ROUTE_MATCH_MIN = ${extractConst(SRC, 'ROUTE_MATCH_MIN')};\n` +
    `const ROUTE_ALIAS_BONUS = ${extractConst(SRC, 'ROUTE_ALIAS_BONUS')};\n` +
    `const ROUTE_EXACT_TIER3 = ${extractConst(SRC, 'ROUTE_EXACT_TIER3')};\n` +
    `const SPEC_MIN_RELEVANT = ${extractConst(SRC, 'SPEC_MIN_RELEVANT')};\n` +
    `const MAP_REL = ${extractConst(SRC, 'MAP_REL')};\n` +
    `const MAP_TEXT_CACHE = new Map();\n`;
  const body = consts +
    extractFn(SRC, 'routeScorer') + '\n' +
    extractFn(SRC, 'routeQuestion') + '\n' +
    extractFn(SRC, 'extractSection') + '\n' +
    extractFn(SRC, 'loadModuleMap') + '\n' +
    extractFn(SRC, 'moduleMapRepo') + '\n' +
    extractFn(SRC, 'loadRouteContext') + '\n' +
    extractFn(SRC, 'assembleConsultSpecHits') + '\n' +
    extractFn(SRC, 'routingDiag') + '\n' +
    'return { routeScorer, routeQuestion, extractSection, loadModuleMap, moduleMapRepo, loadRouteContext, assembleConsultSpecHits, routingDiag, ROUTE_MATCH_MIN, SPEC_MIN_RELEVANT };';
  return new Function('kbTokenize', 'safeRef', 'specSources', 'specFileText', body)(
    kbTokenize, deps.safeRef, deps.specSources, deps.specFileText,
  );
}

// —— fixture 模块地图（含 questionRoutes / specs / indexes）—— //
const FIXTURE_MAP = {
  version: 't1', title: '功能模块地图（fixture）',
  questionRoutes: [
    {
      id: 'QR-ORDER-INSTRUCTION',
      title: '医嘱干预中查看药品说明书／说明书地址如何配置',
      aliases: ['医嘱干预查看说明书', '说明书按钮不显示', '说明书打不开', 'order_instruction'],
      keywords: ['医嘱干预', '说明书', '地址', '配置', 'order_instruction'],
      primaryRefs: [{ specId: 'PWRS-SYS-06', section: '7. order_instruction 的完整配置答案', title: '跨系统配置中心', path: 'docs/specs/PWRS-SYS-06.md', anchor: '7-orderinstruction-的完整配置答案' }],
      contextRefs: [{ specId: 'PWRS-CLIN-04', section: '医嘱审核标记', title: '医嘱审核标记', path: 'docs/specs/PWRS-CLIN-04.md', anchor: null }],
      answerFacts: ['配置项是 usercenter 的 order_instruction，不在 PWRS 本地维护。', 'open 控制入口，value 保存 URL。'],
      mustNotConfuse: ['gy_engine', '臆造 /drug/manual 等不存在的配置'],
      searchText: '医嘱干预中查看药品说明书 说明书地址如何配置 医嘱干预查看说明书 说明书按钮不显示 order_instruction 医嘱干预 说明书 地址 配置',
    },
    {
      id: 'QR-LOGIN',
      title: '登录鉴权与会话保持',
      aliases: ['登录不上', '会话过期', 'token 失效'],
      keywords: ['登录', '鉴权', 'token', '会话'],
      primaryRefs: [{ specId: 'PWRS-ACC-01', section: '4. 接口契约', title: '登录鉴权', path: 'docs/specs/PWRS-ACC-01.md', anchor: '4-接口契约' }],
      contextRefs: [], answerFacts: ['token 由 usercenter 颁发。'], mustNotConfuse: [],
      searchText: '登录鉴权与会话保持 登录不上 会话过期 token 失效 登录 鉴权 token 会话',
    },
  ],
  specs: [
    { id: 'PWRS-SYS-06', title: '跨系统配置中心与生效规则', module: '系统配置', domain: 'SYS', summary: 'order_instruction 配置答案', headings: [{ level: 2, title: '7. order_instruction 的完整配置答案', anchor: '7' }], path: 'docs/specs/PWRS-SYS-06.md' },
    { id: 'PWRS-STAT-09', title: '统计报表导出与药占比口径', module: '统计报表', domain: 'STAT', summary: '药占比 抗菌药物使用强度 报表导出 excel', headings: [{ level: 2, title: '3. 药占比口径', anchor: '3' }], path: 'docs/specs/PWRS-STAT-09.md' },
    { id: 'PWRS-ACC-01', title: '登录鉴权', module: '账户与权限', domain: 'ACC', summary: '登录 token 会话', headings: [], path: 'docs/specs/PWRS-ACC-01.md' },
  ],
  indexes: {
    configs: [{ key: 'gy_engine', specs: ['PWRS-SYS-06'] }, { key: 'audit_drug_instruction', specs: ['PWRS-SYS-06'] }],
    tables: [{ table: 'auth_user_login_error', specs: ['PWRS-ACC-01'] }],
    apis: [{ api: 'GET /api/config/all', specId: 'PWRS-SYS-06', title: '跨系统配置中心' }],
  },
};

// —— fixture 产品仓：把 FIXTURE_MAP 落到 docs/specs/00-功能模块地图.json + 造几份被引 spec —— //
function makeFixtureRepo(withMap = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd04-repo-'));
  const sp = path.join(dir, 'docs', 'specs'); fs.mkdirSync(sp, { recursive: true });
  if (withMap) fs.writeFileSync(path.join(sp, '00-功能模块地图.json'), JSON.stringify(FIXTURE_MAP));
  // 被引 spec：含 front-matter + 多级标题，供 extractSection 定位截取
  fs.writeFileSync(path.join(sp, 'PWRS-SYS-06.md'),
    '---\nid: PWRS-SYS-06\n---\n\n## 6. 上一节\n上一节内容。\n\n## 7. order_instruction 的完整配置答案\n' +
    '配置项 order_instruction 在 usercenter 系统设置里维护。open 控制入口显示，value 存 URL。\n\n### 7.1 子节\n子节细节。\n\n## 8. 下一节\n下一节内容不应被截进来。\n');
  fs.writeFileSync(path.join(sp, 'PWRS-CLIN-04.md'),
    '---\nid: PWRS-CLIN-04\n---\n\n## 医嘱审核标记\n医嘱审核标记说明。OrderAudit/OrderSign。\n\n## 其它\n其它内容。\n');
  fs.writeFileSync(path.join(sp, 'PWRS-ACC-01.md'),
    '---\nid: PWRS-ACC-01\n---\n\n## 4. 接口契约\nPOST /api/login 登录接口。\n\n## 5. 数据契约\nauth_user 表。\n');
  return dir;
}
// 真身 safeRef（tag 校验），无 tag 走工作树读法（specFileText 用 fs.readFileSync）
const safeRef = new Function(extractFn(SRC, 'safeRef') + '\nreturn safeRef;')();
const specFileText = new Function('fs', 'path', 'gitOut', extractFn(SRC, 'specFileText') + '\nreturn specFileText;')(fs, path, () => '');
function makeDeps(repoDir) {
  return { safeRef, specFileText, specSources: (proj) => (proj && proj.repoPath) ? [{ sub: '', repoPath: proj.repoPath }] : [] };
}

test('AC-2 tier-1 别名整串命中 → 强 bonus 命中，超阈值', () => {
  const S = buildRoutingSandbox(makeDeps());
  const r = S.routeQuestion(FIXTURE_MAP, '医嘱干预查看说明书怎么弄', '');
  assert.equal(r.matched, true, '应命中');
  assert.equal(r.tier, 1);
  assert.equal(r.route.id, 'QR-ORDER-INSTRUCTION');
  assert.ok(r.score >= S.ROUTE_MATCH_MIN, '分数超阈值');
  assert.deepEqual(r.answerFacts, FIXTURE_MAP.questionRoutes[0].answerFacts, '带出 answerFacts');
  assert.deepEqual(r.mustNotConfuse, FIXTURE_MAP.questionRoutes[0].mustNotConfuse);
});

test('专用 QR 与泛化 DQ 小分差竞争时优先 QR；明显更相关的 DQ 仍可命中', () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = {
    questionRoutes: [
      { id: 'DQ-001', title: '泛化列表数据对不上', aliases: [], keywords: ['列表', '页面', '路径', '数据', '不一致'], answerFacts: ['泛化排查'] },
      { id: 'QR-CARE-PAGE', title: '监护列表与详情页', aliases: ['我的监护列表页和具体监护详情页'], keywords: ['我的监护', '列表页', '详情页', '路径'], answerFacts: ['确定路径'] },
    ],
    specs: [], indexes: {},
  };
  const specific = S.routeQuestion(map, '我要区分我的监护列表页和具体监护详情页，两个路径是什么？', '');
  assert.equal(specific.route.id, 'QR-CARE-PAGE');

  const diagnostic = S.routeQuestion(map, '列表数据不一致怎么排查？', '');
  assert.equal(diagnostic.route.id, 'DQ-001');
});

test('接口权限自然问法族优先专用QR，并同时保留功能授权缺口与业务数据边界', () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = {
    questionRoutes: [
      { id: 'DQ-002', title: '菜单按钮或功能入口看不到', aliases: ['菜单权限异常'], keywords: ['服务端', '权限', '接口', '菜单'], answerFacts: ['泛化权限排查'] },
      {
        id: 'QR-INTERFACE-AUTH-BOUNDARY', title: '接口级功能授权缺口与业务数据边界',
        aliases: ['服务端现在有没有方法级权限校验', '方法级接口授权是否已经落地', '没有权限注解是否等于没有任何权限控制', '接口侧是不是只做认证不做任何校验'],
        keywords: ['@RequiresPermissions', '@RequiresRoles', '权限注解', '方法级', '权限校验', 'token', '接口级授权', 'owner', '院区', '数据作用域'],
        answerFacts: ['当前基本没有方法级权限注解', '具体业务仍可能执行 owner 与院区数据作用域校验'],
        mustNotConfuse: ['不得把缺少权限注解表述为接口侧仅认证或所有业务接口都会成功'],
      },
    ],
    specs: [], indexes: {},
  };
  for (const question of [
    'PWRS 服务端现在有方法级权限校验吗？',
    '服务端是否有方法级授权？',
    '权限注解有没有落地？',
    '没有注解是不是接口只做认证？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'QR-INTERFACE-AUTH-BOUNDARY', question);
    assert.match(hit.answerFacts.join('\n'), /owner.*院区/);
    assert.match(hit.mustNotConfuse.join('\n'), /仅认证/);
  }
});

test('真实PWRS地图回归：接口权限问法族不再被泛化DQ抢路由', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    'PWRS 服务端现在有方法级权限校验吗？',
    '服务端是否有方法级授权？',
    '权限注解有没有落地？',
    '没有注解是不是接口只做认证？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'QR-INTERFACE-AUTH-BOUNDARY', `${question}，topN=${JSON.stringify(hit.topN)}`);
  }
});

test('真实PWRS地图回归：患者产品身份键与Proxy路由字段不混写', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    '跨院区时一名患者靠哪几个字段才算唯一？',
    '历史深链只有 patientId+visitId，还能不能自动认院区？',
    '两个院区有相同 patientId 和 visitId，页面该怎么避免串人？',
    '少了 hospitalId 时直接拿 token 当前院区补上就行吧？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'DQ-003', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /固定使用 hospitalId \+ patientId \+ visitId/);
    assert.match(hit.mustNotConfuse.join('\n'), /districtCode 仅限内部上游路由/);
  }
});

test('真实PWRS地图回归：体温单七天窗口四种问法命中且不足七天不截到今天', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    '体温单不传 startDate 默认看几天？',
    '体温单翻页或换范围时什么时候必须显式传 startDate？',
    '刚入院三天的患者打开体温单，默认窗口怎么受入院日期影响？',
    '患者主页异常检验是 5 天，所以体温单也应是 5 天，对吗？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'QR-LINE-CHART-SEVEN-DAY-WINDOW', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /不足 7 天仍从入院日起连续生成 7 个日期槽/);
    assert.match(hit.mustNotConfuse.join('\n'), /不得.*只到今天/);
  }
});

test('AC-2 tier-1 关键词 IDF 打分命中（无整串别名，纯关键词重叠）', () => {
  const S = buildRoutingSandbox(makeDeps());
  const r = S.routeQuestion(FIXTURE_MAP, '医嘱干预的时候说明书地址在哪里配置', '');
  assert.equal(r.matched, true);
  assert.equal(r.route.id, 'QR-ORDER-INSTRUCTION');
  assert.ok(Array.isArray(r.topN) && r.topN.length >= 1, 'topN 供诊断');
});

test('AC-2 阈值 miss：完全无关问题 → 不命中', () => {
  const S = buildRoutingSandbox(makeDeps());
  const r = S.routeQuestion(FIXTURE_MAP, '今天天气怎么样', '');
  assert.equal(r.matched, false, '无关问题不应命中');
  assert.equal(r.tier, 0);
  assert.ok(Array.isArray(r.topN), 'miss 仍给 topN 供诊断');
});

test('AC-2 tier-3 精确名反查：query 含 config key → 直接强命中所属 spec', () => {
  const S = buildRoutingSandbox(makeDeps());
  const r = S.routeQuestion(FIXTURE_MAP, '这个 gy_engine 是干嘛的怎么配', '');
  assert.equal(r.matched, true);
  assert.equal(r.tier, 3, 'tier-3 精确反查');
  assert.equal(r.score, S.ROUTE_MATCH_MIN >= 0 ? r.score : 0);
  assert.ok(r.specRefs && r.specRefs.some(x => x.specId === 'PWRS-SYS-06'), '映射到 gy_engine 所属 spec');
});

test('AC-2 tier-3 精确名反查：query 含 api 路径 → 命中', () => {
  const S = buildRoutingSandbox(makeDeps());
  const r = S.routeQuestion(FIXTURE_MAP, '调用 /api/config/all 拿什么', '');
  assert.equal(r.matched, true);
  assert.equal(r.tier, 3);
  assert.ok(r.specRefs.some(x => x.specId === 'PWRS-SYS-06'));
});

test('AC-2 tier-2 specs 兜底：questionRoutes 没到阈值但 specs 命中', () => {
  const S = buildRoutingSandbox(makeDeps());
  // 「药占比 抗菌药物」只在 specs[PWRS-STAT-09] 里，无对应 questionRoute
  const r = S.routeQuestion(FIXTURE_MAP, '药占比抗菌药物使用强度报表怎么导出 excel', '');
  assert.equal(r.matched, true);
  assert.equal(r.tier, 2, 'tier-2 specs 兜底');
  assert.ok(r.specRefs.some(x => x.specId === 'PWRS-STAT-09'));
});

test('AC-3 extractSection：按 anchor 定位截取正确章节，不越界到下一同级标题', () => {
  const S = buildRoutingSandbox(makeDeps());
  const full = fs.readFileSync(path.join(makeFixtureRepo(), 'docs', 'specs', 'PWRS-SYS-06.md'), 'utf8');
  const sec = S.extractSection(full, { section: '7. order_instruction 的完整配置答案', anchor: '7-orderinstruction-的完整配置答案' });
  assert.match(sec, /order_instruction/, '截到目标章节');
  assert.match(sec, /7\.1 子节/, '含子节（更低级标题）');
  assert.doesNotMatch(sec, /下一节内容不应被截进来/, '不越界到下一同级 ## 8');
  assert.doesNotMatch(sec, /上一节内容/, '不含上一节');
});

test('AC-3 extractSection：anchor 定位不到 → 退回该 spec 前段（不空返）', () => {
  const S = buildRoutingSandbox(makeDeps());
  const full = fs.readFileSync(path.join(makeFixtureRepo(), 'docs', 'specs', 'PWRS-SYS-06.md'), 'utf8');
  const sec = S.extractSection(full, { section: '不存在的章节标题xyz', anchor: '不存在xyz' });
  assert.ok(sec.length > 0, '退回前段而非空');
  assert.doesNotMatch(sec, /^---/, '去掉 front-matter');
});

test('AC-1/AC-5 loadModuleMap 读产品仓地图；loadRouteContext 读被引章节 + answerFacts 置顶', () => {
  const repo = makeFixtureRepo(true);
  const S = buildRoutingSandbox(makeDeps());
  // 用真身 specSources 依赖：这里注入 proj.repoPath = repo
  const S2 = buildRoutingSandbox(makeDeps(repo));
  const proj = { id: 'pwrs', repoPath: repo };
  const map = S2.loadModuleMap(proj, '');   // 无 ver → 工作树读法
  assert.ok(map && Array.isArray(map.questionRoutes), '读到地图');
  const route = S2.routeQuestion(map, '医嘱干预查看说明书', '');
  assert.equal(route.matched, true);
  const ctx = S2.loadRouteContext(proj, '', route);
  // answerFacts 置顶段
  assert.equal(ctx.specHits[0].section, 'answerFacts', 'answerFacts 段置顶');
  assert.match(ctx.specHits[0].text, /order_instruction/, 'answerFacts 注入原文');
  assert.match(ctx.specHits[0].text, /优先据此|不要臆造/, 'answerFacts 段点明优先据此作答');
  // 被引 primaryRef 章节读进来
  const joined = ctx.specHits.map(h => h.text).join('\n');
  assert.match(joined, /配置项 order_instruction 在 usercenter/, '读到 primaryRef 指定章节正文');
  assert.deepEqual(ctx.mustNotConfuse, FIXTURE_MAP.questionRoutes[0].mustNotConfuse, '带出 mustNotConfuse');
});

test('AC-6 无地图产品：loadModuleMap 返 null（consult 回落 specSearch，向后兼容）', () => {
  const repo = makeFixtureRepo(false);   // 不写地图文件
  const S = buildRoutingSandbox(makeDeps(repo));
  const map = S.loadModuleMap({ id: 'nomap', repoPath: repo }, '');
  assert.equal(map, null, '无地图 → null，consult 走原 specSearch 分支');
});

test('AC-6 无地图产品：consult 源码分支——map=null 才走 specSearch（源码级断言）', () => {
  // 有地图 → route 命中/miss 走新分支；无地图（map falsy）→ specHits = specSearch(...)（原行为）
  assert.match(SRC, /const map = loadModuleMap\(proj, cver\); if \(map\) route = routeQuestion\(map, retrievalQuery, sub\)/, 'consult 先加载地图再路由');
  assert.match(SRC, /specHits = specSearch\(proj, cver, retrievalQuery, 5, sub\);\s+\/\/ 无地图产品/, '无地图分支仍用 specSearch');
  // PD-04 修复：miss 固定话术条件多了 specNoSpec（specSearch 底座也弱/空）——specSearch 强匹配时即便路由 miss 也不再走固定话术。
  assert.match(SRC, /const noAnswer = routeMiss && specNoSpec && !\(b\.deep && codeHits && codeHits\.length\)/, 'miss 且 specSearch 弱/空 且（非 deep 或 deep 无源码）→ noAnswer');
});

// —— PD-04 修复：specSearch 作底座、路由作加成（assembleConsultSpecHits 纯函数单测）—— //
const RH = (m, t, x = '') => ({ subsystem: '', module: m, title: t, section: '', text: x || (m + t) });   // route hit（含 answerFacts 顶段 module='模块地图'）
const SH = (m, t, score, x = '') => ({ subsystem: '', module: m, title: t, text: x || (m + t), score });   // specSearch scored hit

test('PD-04修复 路由命中：specHits = 路由内容(置前) + specSearch 底座（去重合并），answerFacts 仍最高优', () => {
  const S = buildRoutingSandbox(makeDeps());
  const routeHits = [{ ...RH('模块地图', '经确认事实（最高优先，据此作答）', 'answerFacts 内容'), section: 'answerFacts' }, RH('PWRS-SYS-06', '收费配置', '收费章节正文')];
  const searchHits = [SH('PWRS-ACT-01', '系统激活注册', 16.5, '激活包上传、激活状态门禁'), SH('PWRS-SYS-06', '收费配置', 4.3, '收费章节正文')];   // 末条与 route 重复
  const asm = S.assembleConsultSpecHits(true, routeHits, searchHits, S.SPEC_MIN_RELEVANT);
  assert.equal(asm.specHits[0].title, '经确认事实（最高优先，据此作答）', 'answerFacts 顶段置前（最高优）');
  assert.equal(asm.specHits[1].title, '系统激活注册', 'answerFacts 后应先放本轮 specSearch 强匹配，再放宽泛 route 章节');
  const joined = asm.specHits.map(h => h.text).join('\n');
  assert.match(joined, /激活包上传/, 'specSearch 强匹配「激活注册」也进 specHits（路由错配不再盖掉强 specSearch）');
  // 去重：route 的「收费配置」与 specSearch 的「收费配置」同 module|title|text → 只保留一条
  const dupCount = asm.specHits.filter(h => h.title === '收费配置').length;
  assert.equal(dupCount, 1, 'route 与 specSearch 重复章节去重（保留一条）');
  assert.equal(asm.usedSpecSearch, true, '标记用了 specSearch 底座');
  assert.equal(asm.noSpec, false);
});

test('PD-04修复 路由命中：cap≤7（route+specSearch 合并不超上限）', () => {
  const S = buildRoutingSandbox(makeDeps());
  const routeHits = Array.from({ length: 4 }, (_, i) => RH('R' + i, '路由' + i, '路由正文' + i));
  const searchHits = Array.from({ length: 6 }, (_, i) => SH('E' + i, '搜索' + i, 10 - i, '搜索正文' + i));
  const asm = S.assembleConsultSpecHits(true, routeHits, searchHits, S.SPEC_MIN_RELEVANT);
  assert.ok(asm.specHits.length <= 7, 'cap≤7');
  assert.equal(asm.specHits[0].title, '搜索0', '没有 answerFacts 时，当前问题的精准 specSearch 结果置前');
});

test('PD-04修复 路由未命中但 specSearch 强（首条≥阈值）→ 用 specSearch，不 miss', () => {
  const S = buildRoutingSandbox(makeDeps());
  const searchHits = [SH('PWRS-ACT-01', '系统激活注册', 16.5, '激活包上传、激活状态门禁'), SH('X', 'Y', 3.0)];
  const asm = S.assembleConsultSpecHits(false, [], searchHits, S.SPEC_MIN_RELEVANT);
  assert.equal(asm.noSpec, false, 'specSearch 够强 → 不走 miss');
  assert.ok(asm.specHits.length >= 1 && asm.specHits[0].title === '系统激活注册', '喂 specSearch 强匹配（激活注册）');
  assert.equal(asm.usedSpecSearch, true);
});

test('PD-04修复 路由未命中且 specSearch 弱（首条<阈值）→ 空 specHits + noSpec（上层走 miss 固定话术）', () => {
  const S = buildRoutingSandbox(makeDeps());
  const weak = [SH('P', '检验相关', 2.1, '检验搜索出的弱内容')];   // 2.1 < SPEC_MIN_RELEVANT(8)
  const asm = S.assembleConsultSpecHits(false, [], weak, S.SPEC_MIN_RELEVANT);
  assert.deepEqual(asm.specHits, [], 'specSearch 弱 → 不注入片段（不让 AI 据跑题编）');
  assert.equal(asm.noSpec, true, 'noSpec=true → 上层 noAnswer 走固定话术');
  assert.equal(asm.usedSpecSearch, false);
});

test('PD-04修复 路由未命中且 specSearch 空 → noSpec（miss 固定话术）', () => {
  const S = buildRoutingSandbox(makeDeps());
  const asm = S.assembleConsultSpecHits(false, [], [], S.SPEC_MIN_RELEVANT);
  assert.deepEqual(asm.specHits, []);
  assert.equal(asm.noSpec, true);
});

test('PD-04修复 consult 端组装接线（源码级）：assembleConsultSpecHits + specSearch 始终作底座 + specTop 进诊断', () => {
  // specSearch 底座（specSearchScored）在有地图时也跑一次，一处两用（喂模型 + 诊断）
  assert.match(SRC, /searchScored = specSearchScored\(proj, cver, retrievalQuery, 5, sub\)/, 'consult 始终跑 specSearchScored 作底座');
  assert.match(SRC, /assembleConsultSpecHits\(!!route\.matched, routeHits, searchScored, SPEC_MIN_RELEVANT\)/, '有地图分支用 assembleConsultSpecHits 合成 specHits');
  // buildRetrieval 复用同一 searchScored（不再单独重算 specScored）
  assert.match(SRC, /buildRetrieval\(\{ query: qtext, deep: !!b\.deep, ver: cver, subsystem: sub \}, searchScored, kbScored, codeHits\)/, '诊断复用同一 searchScored');
  // routing 带上 specTop / usedSpecSearch 方便回放判断
  assert.match(SRC, /retrieval\.routing\.specTop = Math\.round\(searchTop \* 1000\) \/ 1000/, 'routing.specTop 透出 specSearch 首条分');
  assert.match(SRC, /retrieval\.routing\.usedSpecSearch = usedSpecSearch/, 'routing.usedSpecSearch 透出是否用了底座');
});

test('AC-4 miss 固定话术：不调模型，SSE 固定文案（源码级断言）', () => {
  assert.match(SRC, /if \(noAnswer\) \{[\s\S]*?说明书里没有找到相关描述/, 'noAnswer → 固定话术');
  assert.match(SRC, /建议转成工单或联系开发确认/, '话术含转工单建议');
  // 固定话术分支在 callModelStream 之前、且自身不调用模型
  const start = SRC.indexOf('if (noAnswer) {');
  const call = SRC.indexOf('await callModelStream', start);
  const naEnd = SRC.indexOf('} else if (!cfg.apiKey)', start);
  assert.ok(start >= 0 && naEnd > start && (call < 0 || call > naEnd), 'noAnswer 分支内不调 callModelStream');
});

test('AC-7 routingDiag：路由决策进诊断；无地图 enabled:false', () => {
  const S = buildRoutingSandbox(makeDeps());
  const hit = S.routeQuestion(FIXTURE_MAP, '医嘱干预查看说明书', '');
  const d = S.routingDiag(true, hit);
  assert.equal(d.enabled, true);
  assert.equal(d.matched, true);
  assert.equal(d.tier, 1);
  assert.equal(d.routeId, 'QR-ORDER-INSTRUCTION');
  assert.equal(d.threshold, S.ROUTE_MATCH_MIN);
  assert.ok(Array.isArray(d.topN) && d.topN.length >= 1);
  // miss 也进诊断
  const miss = S.routeQuestion(FIXTURE_MAP, '今天天气怎么样', '');
  const dm = S.routingDiag(true, miss);
  assert.equal(dm.enabled, true);
  assert.equal(dm.matched, false);
  // 无地图 → enabled:false
  assert.deepEqual(S.routingDiag(false, null), { enabled: false });
});

test('AC-7 retrieval.routing 挂进 consult + 回放（源码级断言）', () => {
  assert.match(SRC, /retrieval\.routing = routingDiag\(hasMap, route\)/, 'consult 与回放把 routing 挂进 retrieval');
  // consult 与 replay 两处
  const occ = (SRC.match(/retrieval\.routing = routingDiag\(hasMap, route\)/g) || []).length;
  assert.ok(occ >= 2, 'consult + retrieval-replay 均接入路由诊断');
});
