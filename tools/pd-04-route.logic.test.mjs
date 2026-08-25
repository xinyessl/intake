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
    extractFn(SRC, 'consultContextFollowupIntent') + '\n' +
    extractFn(SRC, 'consultScopeTechnicalTokens') + '\n' +
    extractFn(SRC, 'contextualRouteQuestion') + '\n' +
    extractFn(SRC, 'extractSection') + '\n' +
    extractFn(SRC, 'routeEvidenceExcerpt') + '\n' +
    extractFn(SRC, 'loadModuleMap') + '\n' +
    extractFn(SRC, 'moduleMapRepo') + '\n' +
    extractFn(SRC, 'loadRouteContext') + '\n' +
    extractFn(SRC, 'assembleConsultSpecHits') + '\n' +
    extractFn(SRC, 'routingDiag') + '\n' +
    'return { routeScorer, routeQuestion, contextualRouteQuestion, extractSection, routeEvidenceExcerpt, loadModuleMap, moduleMapRepo, loadRouteContext, assembleConsultSpecHits, routingDiag, ROUTE_MATCH_MIN, SPEC_MIN_RELEVANT };';
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

test('承接型诊断追问衰减继承上一轮专用QR；显式新实体覆盖且不串话', () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = {
    questionRoutes: [
      {
        id: 'QR-PATIENT-SOURCE', title: '患者列表接口与数据源',
        aliases: ['患者列表从哪个接口获取数据'],
        keywords: ['患者列表', 'pwrs_patient', 'listProxyPatients', 'ETL'],
        answerFacts: ['患者页先调PWRS接口，再按条件走本地或Proxy。'],
        searchText: '患者列表从哪个接口获取数据 患者列表 pwrs_patient listProxyPatients ETL',
      },
      {
        id: 'DQ-PATIENT-EMPTY', title: '患者列表为空诊断',
        aliases: ['患者列表为空'], keywords: ['患者', '列表', '为空', '没数据', '排查'],
        answerFacts: ['通用列表排查'], searchText: '患者列表为空 没数据 看不到 怎么排查',
      },
      {
        id: 'DQ-ORDER-EMPTY', title: '医嘱查询不到诊断',
        aliases: ['医嘱查询不到'], keywords: ['医嘱', '查询不到', '医嘱状态', '排查'],
        answerFacts: ['医嘱排查'], searchText: '医嘱查询不到 医嘱状态 排查',
      },
    ], specs: [], indexes: {},
  };
  const history = [
    { role: 'user', content: '患者列表从哪个接口获取数据，后面查哪个ETL？' },
    { role: 'assistant', content: '历史自由文本不能作为证据。' },
    { role: 'user', content: '那页面一个患者都看不到，实施现场先查什么？' },
  ];
  const inherited = S.contextualRouteQuestion(map, history, history[2].content, '');
  assert.equal(inherited.route.id, 'QR-PATIENT-SOURCE');
  assert.equal(inherited.inherited, true);
  assert.match(inherited.answerFacts.join('\n'), /先调PWRS接口/);
  assert.ok(inherited.score > 0);

  const switchedMessages = history.slice(0, 2).concat({ role: 'user', content: '那医嘱查询不到要怎么排查？' });
  const switched = S.contextualRouteQuestion(map, switchedMessages, switchedMessages[2].content, '');
  assert.equal(switched.route.id, 'DQ-ORDER-EMPTY');
  assert.equal(switched.contextOverride, true);
  assert.equal(switched.inherited, undefined);

  const unrelated = S.contextualRouteQuestion(map, history.slice(0, 2).concat({ role: 'user', content: '这个红色按钮该点哪个？' }), '这个红色按钮该点哪个？', '');
  assert.equal(unrelated.matched, false, '无承接提示、无证据按钮不能继承患者route');
  assert.equal(unrelated.contextOverride, true);

  for (const followUp of [
    '回到这里，第一步已经看过了，没发现异常。接下来呢？',
    '第一步都查过了，没发现异常，下一步怎么做？',
    '接口已经通了，返回也是 HTTP 200，但页面没变化，下一步看哪？',
  ]) {
    const routed = S.contextualRouteQuestion(map, history.slice(0, 2).concat({ role: 'user', content: followUp }), followUp, '');
    assert.equal(routed.route.id, 'QR-PATIENT-SOURCE', followUp);
    assert.equal(routed.inherited, true, followUp);
    assert.match(routed.answerFacts.join('\n'), /先调PWRS接口/);
  }

  const chained = '接口也通了，下一步看哪？';
  const chainedRoute = S.contextualRouteQuestion(map, [
    history[0],
    history[1],
    { role: 'user', content: '第一步已经看过了，没发现异常，接下来呢？' },
    { role: 'assistant', content: '中间答案仍不能作为事实证据。' },
    { role: 'user', content: chained },
  ], chained, '');
  assert.equal(chainedRoute.route.id, 'QR-PATIENT-SOURCE', '连续两轮无业务名的进度追问仍回溯最近已核route');
  assert.equal(chainedRoute.inherited, true);

  const progressSwitched = '接口已经通了。换个问题，医嘱查询不到怎么排查？';
  const progressRoute = S.contextualRouteQuestion(map, history.slice(0, 2).concat({ role: 'user', content: progressSwitched }), progressSwitched, '');
  assert.equal(progressRoute.route.id, 'DQ-ORDER-EMPTY', '排查进度句中显式新实体仍覆盖旧route');
  assert.equal(progressRoute.contextOverride, true);
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
    '旧收藏链接只有患者号和住院号，系统会自动补当前院区吗？',
    '院区参数没带，先用默认院区顶一下可以吗？',
    '页面只有 districtCode，能把它当 hospitalId 补到患者身份里吗？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'DQ-003', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /固定使用 hospitalId \+ patientId \+ visitId/);
    assert.match(hit.answerFacts.join('\n'), /缺少 hospitalId 时必须拒绝.*重新选择医院\/院区.*从患者列表重新进入/);
    assert.match(hit.answerFacts.join('\n'), /历史深链、旧链接和收藏链接.*不得自动补齐或兼容放行/);
    assert.match(hit.answerFacts.join('\n'), /不得回退 token 当前院区、默认院区或 districtCode/);
    assert.match(hit.mustNotConfuse.join('\n'), /districtCode 仅限内部上游路由/);
    assert.match(hit.mustNotConfuse.join('\n'), /不得臆造历史兼容、系统自动补齐.*本地唯一约束/);
  }
});

test('真实PWRS地图回归：患者安全身份上下文在追问中持续，显式登录新实体必须切题', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const messages = [
    { role: 'user', content: '跨院区时一名患者靠哪几个字段才算唯一？' },
    { role: 'assistant', content: '历史兼容和本地唯一约束都只是模型猜测，不能进入事实账本。' },
    { role: 'user', content: '如果这是以前收藏的旧链接，缺了院区还能自动补吗？' },
  ];
  const inherited = S.contextualRouteQuestion(map, messages, messages.at(-1).content, '');
  assert.equal(inherited.route.id, 'DQ-003');
  assert.match(inherited.answerFacts.join('\n'), /历史深链、旧链接和收藏链接.*不得自动补齐或兼容放行/);
  assert.doesNotMatch(inherited.answerFacts.join('\n'), /本地唯一约束/);

  const switchedQuestion = '患者身份先放下，登录 token 到底是谁签发的？';
  const switched = S.contextualRouteQuestion(map, [...messages, { role: 'assistant', content: '继续。' }, { role: 'user', content: switchedQuestion }], switchedQuestion, '');
  assert.notEqual(switched.route.id, 'DQ-003');
  assert.match(switched.answerFacts.join('\n'), /usercenter.*签发|统一用户中心.*签发/i);
  assert.doesNotMatch(switched.answerFacts.join('\n'), /历史深链|默认院区/);
});

test('真实PWRS地图回归：tag35当前院区裁决压过废止授权方案，患教请求叠加全局患者身份', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    '切换院区后同号患者像串人了，第一步怎么缩小范围？',
    '换另一个账号就正常，这是不是授权院区集合不同？',
    '账号没有绑定目标院区，患者查询是不是应该拒绝？',
    '列表要按账号授权院区集合缩小结果吗？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'DQ-003', `${question}，topN=${JSON.stringify(hit.topN)}`);
    const facts = hit.answerFacts.join('\n');
    const mnc = hit.mustNotConfuse.join('\n');
    assert.match(facts, /院区、病区、科室.*搜索\/上下文条件.*不是账号位置授权/);
    assert.match(facts, /不得按账号绑定.*授权院区集合.*缩小/);
    assert.match(facts, /换账号后正常只是一条相关性线索/);
    assert.match(mnc, /不得复活已废止的账号授权院区、授权院区集合、未授权院区拒绝/);
  }

  for (const question of [
    '患教推荐排序这一段，请求和响应都抓到了，重点核对哪几个地方？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'QR-EDU-RECOMMEND-SORT', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /hospitalId \+ patientId \+ visitId/);
    assert.match(hit.mustNotConfuse.join('\n'), /不得.*遗漏 hospitalId/);
  }

  for (const question of [
    '推荐模板接口抓包时，患者身份参数最少核哪几个？',
    '患教推荐顺序异常，患者请求先对哪些身份字段？',
  ]) {
    const identity = S.routeQuestion(map, question, '');
    assert.equal(identity.route.id, 'DQ-003', `身份边界题可由全局患者身份路由回答，topN=${JSON.stringify(identity.topN)}`);
    assert.match(identity.answerFacts.join('\n'), /hospitalId \+ patientId \+ visitId/);
    assert.match(identity.mustNotConfuse.join('\n'), /districtCode.*仅限内部上游路由/);
  }
});

test('真实PWRS地图回归：tag35只继承当前route事实，字段类型显式切题并止于本问', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const messages = [
    { role: 'user', content: '跨院区时一名患者靠哪几个字段才算唯一？' },
    { role: 'assistant', content: '我猜第一步是比较两个账号的授权院区集合。' },
    { role: 'user', content: '第一步看过了没异常，接下来呢？' },
  ];
  const inherited = S.contextualRouteQuestion(map, messages, messages.at(-1).content, '');
  assert.equal(inherited.route.id, 'DQ-003');
  assert.equal(inherited.inherited, true);
  assert.doesNotMatch(inherited.answerFacts.join('\n'), /比较两个账号的授权院区集合/);
  assert.match(inherited.mustNotConfuse.join('\n'), /不得复活已废止/);

  const switchedQuestion = 'pwrs_patient.p_id 是 PostgreSQL 原生 uuid 吗？';
  const switched = S.contextualRouteQuestion(map, [...messages, { role: 'assistant', content: '继续。' }, { role: 'user', content: switchedQuestion }], switchedQuestion, '');
  assert.equal(switched.route.id, 'QR-PATIENT-ID-COLUMN-TYPE');
  assert.match(switched.answerFacts.join('\n'), /p_id 虽保存 UUID 字符串.*不是 PostgreSQL 原生 uuid/);
  assert.match(switched.mustNotConfuse.join('\n'), /只问 p_id.*止于 p_id.*不得主动扩写其它列、本地身份元组、索引、唯一约束/);
  assert.doesNotMatch(switched.answerFacts.join('\n'), /授权院区集合|历史深链/);
});

test('真实PWRS地图回归：患者列表接口、数据源与ETL局部未知走专用QR', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    '患者视图的患者列表从哪个接口获取数据，查哪个etl',
    '患者视图列表调用什么接口？后面查哪个 ETL？',
    'Web 患者列表的数据来源和 ETL interfaceCode 是什么？',
    '患者列表是查 PWRS 本地表还是查 HIS？',
    '查自己和查医院分别走什么数据源？',
    'POST /pwrsapi/patients/search 后面调用哪个服务？',
    '患者视图的数据最终来自 V_IPT_PATIENT 吗？',
    '全部患者列表查哪个接口、哪张表？',
    '患者列表的 Controller、Service、Proxy 调用链是什么？',
    '患者视图最终就是 V_IPT_PATIENT，对吧？',
    '患者视图最终肯定不是 V_IPT_PATIENT，对吗？',
    '患者视图最终的 ETL interfaceCode 是什么？',
    '患者列表为空实施现场先查什么？',
    '患者一个都看不到怎么排查？',
    '患者列表没数据从哪里查起？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'QR-PATIENT-LIST-SOURCE', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /POST \/pwrsapi\/patients\/search/);
    assert.match(hit.answerFacts.join('\n'), /pwrs_patient[\s\S]*listProxyPatients/);
    assert.match(hit.mustNotConfuse.join('\n'), /不得仅凭 V_IPT_PATIENT.*interfaceCode/);
    assert.match(hit.mustNotConfuse.join('\n'), /未知或未经核实[\s\S]*不得用“是”或“不是”/);
    if (/为空|看不到|没数据/.test(question)) assert.match(hit.answerFacts.join('\n'), /Network[\s\S]*pwrs_patient[\s\S]*listProxyPatients/);
  }
  const repoPath = path.resolve(path.dirname(process.env.PWRS_REAL_MAP), '..', '..');
  const project = { id: 'pwrs', repoPath };
  const worktreeDeps = {
    safeRef: () => '',
    specSources: proj => [{ sub: '', repoPath: proj.repoPath }],
    specFileText: (repo, ref, rel) => fs.readFileSync(path.join(repo, rel), 'utf8'),
  };
  const W = buildRoutingSandbox(worktreeDeps);
  const loadedMap = W.loadModuleMap(project, '');
  const routed = W.routeQuestion(loadedMap, '患者视图的患者列表从哪个接口获取数据，查哪个etl', '');
  const context = W.loadRouteContext(project, '', routed, 7);
  assert.match(context.specHits[0].text, /人工整理的经确认事实[\s\S]*页面先调用 PWRS 患者列表接口/);
  assert.match(context.specHits.map(item => item.text).join('\n'), /患者视图列表接口、数据源与 ETL 证据边界/);

  const followUp = '那页面一个患者都看不到，实施现场先查什么？';
  const inherited = W.contextualRouteQuestion(loadedMap, [
    { role: 'user', content: '患者视图的患者列表从哪个接口获取数据，查哪个etl' },
    { role: 'assistant', content: '上一轮自由文本不参与证据。' },
    { role: 'user', content: followUp },
  ], followUp, '');
  assert.equal(inherited.route.id, 'QR-PATIENT-LIST-SOURCE');
  assert.match(inherited.answerFacts.join('\n'), /Network[\s\S]*Proxy\/ETL/);
});

test('真实PWRS地图回归：患者数据源QR不抢患者身份DQ、检验ETL或完全无证据问法', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  assert.equal(S.routeQuestion(map, '两个院区有相同 patientId 和 visitId，页面该怎么避免串人？', '').route.id, 'DQ-003');
  assert.equal(S.routeQuestion(map, '检验报告存在但小项搜不到，ETL 应查哪个接口？', '').route.id, 'DQ-005');
  assert.notEqual(S.routeQuestion(map, '这个红色按钮没反应，该点哪个固定重试入口？', '').route?.id, 'QR-PATIENT-LIST-SOURCE');
});

test('真实PWRS地图回归：业务规则正反例能召回“预期行为→冲突才排查”事实', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const cases = [
    ['反馈已经发送，现场不能改正文，先抓什么？', 'QR-FEEDBACK-SEND-DEDUP', /预期行为[\s\S]*已发送仍能改删/],
    ['患教只是点了保存，患者端显示待完成，这正常吗？', 'QR-EDU-DRAFT-COMPLETE', /eduState=false[\s\S]*完成接口成功后仍未完成/],
    ['老师看得到学员入院评估，但保存时报非创建人，正常吗？', 'QR-ADMISSION-ASSESS-SAVE', /CREATOR 是规则内预期[\s\S]*创建人本人被拒绝/],
    ['配置改完普通刷新还是旧值，没库权限先查什么？', 'QR-CONFIG-NOT-EFFECTIVE', /符合现有缓存规则[\s\S]*重新登录/],
  ];
  for (const [q, id, fact] of cases) {
    const hit = S.routeQuestion(map, q, '');
    assert.equal(hit.route.id, id, `${q} topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), fact);
  }
  const feedbackSafety = S.routeQuestion(map, '不点编辑删除，怎么判断反馈锁定和按钮有没有发请求？', '');
  assert.equal(feedbackSafety.route.id, 'QR-FEEDBACK-SEND-DEDUP');
  assert.match(feedbackSafety.answerFacts.join('\n'), /只能读取当前已显示状态、已有截图与已经发生的请求响应/);
  assert.match(feedbackSafety.answerFacts.join('\n'), /不能让实施点击编辑或删除补抓请求/);
  assert.match(feedbackSafety.mustNotConfuse.join('\n'), /不得一处说不要操作.*另一处又建议点击编辑\/删除/);
  const switched = S.contextualRouteQuestion(map, [
    { role: 'user', content: '药师反馈发出去还能改吗？' },
    { role: 'assistant', content: '旧自由文本不是证据。' },
    { role: 'user', content: '那患教只是保存，患者端为什么还是待完成？' },
  ], '那患教只是保存，患者端为什么还是待完成？', '');
  assert.equal(switched.route.id, 'QR-EDU-DRAFT-COMPLETE');
  assert.equal(switched.contextOverride, true, '显式患教新实体必须覆盖反馈route');
});

test('真实PWRS地图回归：医生采纳结果三值、原因必填与药师端闭环走 DQ-009', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const questions = [
    '医生这边已经选了“其他”，提交前还缺什么？提交后药师能看到哪些信息？',
    '医生采纳结果录入弹窗怎么填，什么情况下原因必填？',
    '医嘱干预选不采纳以后是不是必须写理由？',
    '医生选择其他并提交，药师工作站列表会显示什么？',
    '采纳、不采纳、其他三种结果，哪些可以不写原因？',
    '医生意见提交以后，药师详情时间线能看到录入人和时间吗？',
    '药师给了不合理结论，医生端的不采纳是系统自动判的吗？',
    '这条干预医生已经回复了，为什么药师端还要看采纳结果和意见？',
    '医生点提交后，采纳结果会不会改变干预本身的已完成状态？',
  ];
  for (const question of questions) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'DQ-009', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /1=采纳、2=不采纳、3=其他/);
    assert.match(hit.answerFacts.join('\n'), /不采纳\/其他必须填写原因/);
    assert.match(hit.answerFacts.join('\n'), /列表显示医生采纳结果[\s\S]*详情\/时间线显示结果、意见、录入来源、录入人和时间/);
    assert.match(hit.mustNotConfuse.join('\n'), /不是医生采纳结果/);
  }
});

test('真实PWRS地图回归：采纳结果闭环路由不抢体温单、药师反馈或无证据按钮问法', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  assert.equal(S.routeQuestion(map, '体温单不传 startDate 默认看几天？', '').route.id, 'QR-LINE-CHART-SEVEN-DAY-WINDOW');
  assert.equal(S.routeQuestion(map, '药师反馈发出去以后还能改正文或删除吗？', '').route.id, 'QR-FEEDBACK-SEND-DEDUP');
  assert.notEqual(S.routeQuestion(map, '这个红色按钮点了没反应，我应该点哪个？', '').route?.id, 'DQ-009');
});

test('真实PWRS地图回归：动作结果型短追问继承医生采纳闭环；显式新实体仍覆盖且无证据不污染', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const priorQuestion = '上面“不合理”是药师的结论，那下面“不采纳”是谁选的？会把已完成状态改掉吗？';
  for (const followUp of [
    '药师想复核这次反馈，列表和详情分别看哪部分？',
    '填完以后呢，药师端先去哪看？',
    '提交后药师在哪里看结果和医生意见？',
  ]) {
    const hit = S.contextualRouteQuestion(map, [
      { role: 'user', content: priorQuestion },
      { role: 'assistant', content: '历史自由文本不作为事实证据。' },
      { role: 'user', content: followUp },
    ], followUp, '');
    assert.equal(hit.route.id, 'DQ-009', `${followUp}，direct=${JSON.stringify(hit.directCandidate)}`);
    assert.ok(hit.inherited === true || hit.route.id === 'DQ-009', '应直接命中或继承同一已核route');
    assert.match(hit.answerFacts.join('\n'), /列表显示医生采纳结果[\s\S]*详情\/时间线显示结果、意见/);
  }

  const switched = S.contextualRouteQuestion(map, [
    { role: 'user', content: priorQuestion },
    { role: 'assistant', content: '历史自由文本不作为事实证据。' },
    { role: 'user', content: '那先不说医生反馈了，登录 token 是 PWRS 自己签的吗？' },
  ], '那先不说医生反馈了，登录 token 是 PWRS 自己签的吗？', '');
  assert.notEqual(switched.route.id, 'DQ-009');
  assert.equal(switched.contextOverride, true);

  const unsupported = S.contextualRouteQuestion(map, [
    { role: 'user', content: priorQuestion },
    { role: 'assistant', content: '历史自由文本不作为事实证据。' },
    { role: 'user', content: '这个红色按钮没拍到，你直接说点哪个？' },
  ], '这个红色按钮没拍到，你直接说点哪个？', '');
  assert.notEqual(unsupported.route?.id, 'DQ-009');
  assert.equal(unsupported.contextOverride, true);
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

test('真实PWRS地图回归：风险预警异常检验四种问法命中近五天而非调度诊断', {
  skip: !process.env.PWRS_REAL_MAP,
}, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    '患者主页的异常检验默认查最近几天？',
    '旧 Pad 注释写近两天，当前 Proxy 语义到底按几天？',
    '实施看到风险预警区没选日期，系统默认时间窗是多少？',
    '异常检验和体温单一样，默认都是 7 天吧？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'QR-ABNORMAL-EXAM-DAYS', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /风险预警区.*未选日期.*近 5 天/);
    assert.match(hit.mustNotConfuse.join('\n'), /数据不更新的调度诊断/);
  }
});

test('真实PWRS地图回归：同组医嘱owner、待收费共享例外、配置消费时机均命中专用事实', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const groups = [
    ['QR-ORDER-AUDIT-GROUP-OWNER', ['别的药师已经审核过同一组医嘱，我还能覆盖吗？','同一个 groupNo 已存在他人记录，再 POST /order/audit 会怎样？','只要 groupNo 相同，后提交的人就能更新原审核，对吧？','非创建人重复提交同组医嘱的错误码和数据结果是什么？'], /ORDER_NOT_USER[\s\S]*原审核记录/],
    ['QR-CHARGE-DRAFT-SHARED-OWNER', ['没绑定收费药师的待收费单，其他药师能编辑吗？','收费单永远只允许创建人操作，没有共享例外，对吧？','一条待收费记录绑定了药师后，别人还能继续删吗？','共享待收费例外由哪两个状态条件决定？'], /charge_status=0.*charge_user_id 为空/],
    ['QR-CONFIG-NOT-EFFECTIVE', ['配置改了以后只按浏览器刷新就一定生效吗？','配置在数据库改成功，所有打开的客户端会实时推送更新，对吧？','管理员改开关后老会话还是旧值，最可能的消费边界是什么？','Web、Pad、后端下次调用三类配置消费时机有什么差异？'], /后端.*下一次对应调用/],
  ];
  for (const [routeId, questions, facts] of groups) for (const question of questions) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, routeId, `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), facts);
  }
});

test('真实PWRS地图回归：Pad API封装无Controller的自然问法命中跨端断链而非菜单入口', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    'Pad API 封装找得到、服务端 Controller 找不到，说明书应该怎么写？',
    '前端定义了接口，但后端没有对应路由，能直接写成已实现吗？',
    '客户端有消费者，服务端端点缺失时规格如何标注？',
    'Web 能调通但 Pad 只有 API 封装，这算数据库数据丢了吗？',
    '共享数据库与跨端功能一致性为什么不是一回事？',
    '共用同一张表或 Service 是否代表 Web 和 Pad 的入口、字段与能力完全相同？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'DQ-007', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /接口断链.*调用无法命中/);
    assert.match(hit.mustNotConfuse.join('\n'), /封装存在不等于服务端契约存在/);
  }
});

test('真实PWRS地图回归：跨端共享数据消歧不抢患教模板私有/共享可见性', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    '只要模板匹配患者，是否共享都能被所有药师看到，对吧？',
    '一个模板 shared=false，但正好匹配患者，我不是创建人能不能进推荐？',
    '别人没共享的个人患教模板我能看到吗？',
    '推荐结果对共享模板和本人私有模板的可见规则是什么？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route.id, 'QR-EDU-TEMPLATE-VISIBILITY', `${question}，topN=${JSON.stringify(hit.topN)}`);
  }
});

test('真实PWRS地图回归：tag25五个失败问法与十五个自然变体命中四类专用路由', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const groups = [
    {
      id: 'QR-ORDER-AUDIT-PAGINATION',
      questions: [
        '这个医嘱干预历史列表重新筛选后页码该不该重置，现场只有图怎么留证？',
        '那我在第三页保存一条干预后，页码应该留在第三页吗？',
        '医嘱干预分页在保存记录后会不会跳回首页？',
        '历史列表已经翻到第五页，修改干预后正常应显示哪一页？',
        '筛选条件改了以后是否必须回到第一页，说明书有定义吗？',
        '保存后当前页已经没有数据，医嘱干预列表应怎么回退？',
      ],
      fact: /只有该页已无有效数据时.*最后一个有效页/,
    },
    {
      id: 'QR-MEDICAL-CONSULT-VISIBILITY',
      questions: [
        '用药咨询患者端看不到，现场要查哪个落库状态？',
        '那这个用药咨询的已读未读和标记，到底是患者端还是药师端？',
        '医生给药师发的用药咨询，患者本人能在系统里看到吗？',
        '实施说患者手机上没有咨询列表，这是已知功能还是新需求？',
        '用药咨询的回复是给医生看的，还是也已经有患者查看入口？',
        '用药咨询标记和未读数在药师工作台还是患者端？',
      ],
      fact: /现有 Spec 没有患者端查看该用药咨询的能力/,
    },
    {
      id: 'QR-STAT-ORDER-AUDIT-DRILLDOWN',
      questions: [
        '统计分析里医嘱干预这一行，怎么跟原业务记录对上？',
        '工作量统计下钻的干预记录，跨页能直接拿 groupNo 当唯一关联键吗？',
        '统计弹窗一条医嘱干预，回业务列表应核对哪些可见信息？',
        '医嘱干预统计下钻到详情，用 audit 主键能保证是同一条吗？',
        '统计这条和原始干预对不上，只有截图时最少留哪些证据？',
      ],
      fact: /没有确认 groupNo、audit 主键.*唯一关联键/,
    },
    {
      id: 'QR-ASSESS-DRUG-DOCTOR-INBOX',
      questions: [
        '药物重整医生端全部、已读、未读、星标四组是怎么分的？',
        '医生看了重整单以后再看一次，已读会被取消吗？',
        '我的药物重整列表里，星标再点一次是取消还是保持？',
      ],
      fact: /all\/read\/unRead\/mask 四组/,
    },
  ];
  let count = 0;
  for (const { id, questions, fact } of groups) for (const question of questions) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route?.id, id, `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), fact);
    count++;
  }
  assert.ok(count >= 20, '应覆盖5个失败问法与至少10个自然变体');
});

test('真实PWRS地图回归：tag26新路由不抢 token、患者列表、无证据红按钮或采纳闭环', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const cases = [
    ['token 是 PWRS 自己签发的吗？', 'QR-TOKEN-AUTH-CHAIN'],
    ['患者视图的患者列表从哪个接口获取数据？', 'QR-PATIENT-LIST-SOURCE'],
    ['医生选择不采纳以后是不是必须写理由？', 'DQ-009'],
  ];
  for (const [question, id] of cases) assert.equal(S.routeQuestion(map, question, '').route?.id, id, question);
  const red = S.routeQuestion(map, '这个红色按钮点了没反应，你直接说应该点哪个重试入口？', '');
  assert.ok(!['QR-ORDER-AUDIT-PAGINATION', 'QR-MEDICAL-CONSULT-VISIBILITY', 'QR-STAT-ORDER-AUDIT-DRILLDOWN', 'QR-ASSESS-DRUG-DOCTOR-INBOX'].includes(red.route?.id));
});

test('真实PWRS地图回归：多组一次返回的页签只读验证，不要求逐页请求或改状态', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  for (const question of [
    '医生端药物重整首次加载已返回四组，切tab没发新请求是筛选失效吗？',
    '全部已读未读星标怎么只读核对，别让我点开记录改状态？',
    '药物重整页签本地切换没走网络请求，只看全部、已读、未读和星标各组成员能验证吗？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route?.id, 'QR-ASSESS-DRUG-DOCTOR-INBOX', `${question}，topN=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /一次返回 all\/read\/unRead\/mask 四组/);
    assert.match(hit.answerFacts.join('\n'), /不要求每次切页都重新发请求/);
    assert.match(hit.answerFacts.join('\n'), /只读验证[\s\S]*数量和成员集合[\s\S]*read 与 unRead 互斥/);
    assert.match(hit.mustNotConfuse.join('\n'), /不得通过点开未读或切换星标.*改变业务状态/);
  }
  const followUp = '那用药咨询患者端看不到怎么办？';
  const changed = S.contextualRouteQuestion(map, [
    { role: 'user', content: '药物重整四个页签怎么只读验证？' },
    { role: 'assistant', content: '上一轮答案不作为事实。' },
    { role: 'user', content: followUp },
  ], followUp, '');
  assert.equal(changed.route?.id, 'QR-MEDICAL-CONSULT-VISIBILITY', '显式新实体必须覆盖上一轮药物重整路由');
});

test('真实PWRS地图回归：退出跳转已核事实跨多轮诊断持续生效，显式新实体仍覆盖', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const q21 = '医院报的退出跳转问题，换了另一个账号就正常了，这个线索说明先看哪边？';
  const q22 = '回到退出跳转这里，第一步看过了，没发现异常。接下来呢？';
  const q23 = '退出跳转这一段，接口是通的，返回也是 200，但页面还是没变化，下一步看哪？';
  const messages = [{ role: 'user', content: q21 }];
  const first = S.routeQuestion(map, q21, '');
  assert.equal(first.route?.id, 'DQ-001', `Q21 topN=${JSON.stringify(first.topN)}`);
  messages.push({ role: 'assistant', content: '助手自由文本不作证据。' }, { role: 'user', content: q22 });
  const second = S.contextualRouteQuestion(map, messages, q22, '');
  assert.equal(second.route?.id, 'DQ-001', `Q22 direct=${JSON.stringify(second.directCandidate)}`);
  messages.push({ role: 'assistant', content: '仍只使用地图事实。' }, { role: 'user', content: q23 });
  const third = S.contextualRouteQuestion(map, messages, q23, '');
  assert.equal(third.route?.id, 'DQ-001', `Q23 direct=${JSON.stringify(third.directCandidate)}`);
  const facts = third.answerFacts.join('\n');
  assert.match(facts, /LcUtils\.getPortalDomain\(\)/);
  assert.match(facts, /hostname:9999/);
  assert.match(facts, /生产环境指向当前域名/);
  assert.match(facts, /根路径 \/login/);
  assert.match(facts, /不得加 \/pwrs\//);
  assert.match(facts, /PWRS 自己端口 8083/);
  assert.match(facts, /HTTP 200 只确认传输成功/);

  const switchedQuestion = '换个问题，患者列表的身份键是什么？';
  const switched = S.contextualRouteQuestion(map, messages.concat(
    { role: 'assistant', content: '旧功能到此结束。' },
    { role: 'user', content: switchedQuestion },
  ), switchedQuestion, '');
  assert.notEqual(switched.route?.id, 'DQ-001', '显式患者新实体不得继承退出route');
});

test('真实PWRS地图回归：Q30-Q33 配置作用域事实跨现场限制持续生效', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const questions = [
    '改一条系统配置只会影响当前医院吗？',
    '医院电话里只说“A 医院改了配置，B 医院看到的值也跟着变”。我应该先让他们做哪个验证？',
    '医院配置隔离这一段，按这个顺序查到第二步就对不上了，后面先停还是继续？',
    '刚才这个医院配置隔离问题，我目前只能确认请求发出去了，后端具体走到哪还不知道。你先说能确定的部分。',
  ];
  const messages = [];
  for (const [index, question] of questions.entries()) {
    messages.push({ role: 'user', content: question });
    const hit = S.contextualRouteQuestion(map, messages, question, '');
    assert.equal(hit.route?.id, 'DQ-012', `${question}，direct=${JSON.stringify(hit.directCandidate)}`);
    assert.match(hit.answerFacts.join('\n'), /usercenter sys_config/);
    assert.match(hit.answerFacts.join('\n'), /未按医院过滤/);
    assert.match(hit.answerFacts.join('\n'), /影响共用(?:同一)? usercenter 的机构/);
    if (index === 3) assert.equal(hit.inherited, true, '承接式部分证据轮应显式标记来自事实账本');
    messages.push({ role: 'assistant', content: '这段助手文字可能含示例或假设，但不进入事实账本。' });
  }
});

test('真实PWRS地图回归：配置、退出、反馈、权限的部分证据问法继承已核route，新实体仍切题', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const S = buildRoutingSandbox(makeDeps());
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const cases = [
    {
      routeId: 'DQ-012',
      start: '改一条系统配置只会影响当前医院吗？',
      follow: '上午反馈的配置串院问题，数据库没权限，只靠页面和接口响应，能先排除什么？',
      facts: /未按医院过滤/,
    },
    {
      routeId: 'DQ-001',
      start: 'PWRS 退出以后应该跳到哪个地址？',
      follow: '这次复测只看到页面地址，后端日志拿不到，还缺什么？',
      facts: /getPortalDomain\(\)[\s\S]*\/login/,
    },
    {
      routeId: 'QR-FEEDBACK-SEND-DEDUP',
      start: '药师反馈发出去以后还能改正文或删除吗？',
      follow: '上午反馈的锁定问题，数据库无权限，只靠页面能先排除什么？',
      facts: /发送后正文锁定/,
    },
    {
      routeId: 'QR-LOGIN-PERMISSION',
      start: '我看不到某个菜单，是不是后台接口也一定返回403？',
      follow: '刚才菜单和接口权限这块，我目前只能确认请求发出了，复测还缺什么？',
      facts: /菜单不可见不能推出后端接口一定 403/,
    },
  ];
  for (const item of cases) {
    const hit = S.contextualRouteQuestion(map, [
      { role: 'user', content: item.start },
      { role: 'assistant', content: '假设后端使用 fake_table；该模型猜测不得继承。' },
      { role: 'user', content: item.follow },
    ], item.follow, '');
    assert.equal(hit.route?.id, item.routeId, `${item.follow}，direct=${JSON.stringify(hit.directCandidate)}`);
    assert.equal(hit.inherited, true);
    assert.match(hit.answerFacts.join('\n'), item.facts);
    assert.doesNotMatch(hit.answerFacts.join('\n'), /fake_table/, 'assistant 自由文本不能写入route事实');
  }

  const switchedQuestion = '换个问题，药师反馈发送后正文还能改吗？';
  const switched = S.contextualRouteQuestion(map, [
    { role: 'user', content: '改一条系统配置只会影响当前医院吗？' },
    { role: 'assistant', content: '配置主题结束。' },
    { role: 'user', content: '刚才配置我只看到请求发出，后端日志没权限查。' },
    { role: 'assistant', content: '仍不把自由文本当证据。' },
    { role: 'user', content: switchedQuestion },
  ], switchedQuestion, '');
  assert.equal(switched.route?.id, 'QR-FEEDBACK-SEND-DEDUP');
  assert.notEqual(switched.route?.id, 'DQ-012');
});

test('真实PWRS地图回归：调度截图、旧时间、同步中断与受控补跑自然问法命中DQ-013', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  for (const question of [
    '监控截图最后成功时间停在三天前，是不是调度停了？',
    '只看到最后成功时间很旧，实施先查什么，能直接恢复吗？',
    '同步任务运行中断了，现在可以重跑还是要先确认范围？',
    'ETL 能不能先补跑昨天的数据？',
    '批处理明确幂等，重新触发前还要核对当前运行态和谁授权吗？',
    'PWRS 自己没有定时，由外部调度触发，这个事实现场怎么继续核对？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route?.id, 'DQ-013', `${question}，top=${JSON.stringify(hit.topN)}`);
    const facts = hit.answerFacts.join('\n');
    assert.match(facts, /PWRS 内部 @Scheduled 当前禁用/);
    assert.match(facts, /只属于现场观测/);
    assert.match(facts, /不能据此断言调度停止、平台故障或责任归属/);
    assert.match(facts, /幂等\/补偿契约.*目标时间窗.*当前运行态与授权/);
  }
});

test('真实PWRS地图回归：调度事实可在同主题诊断继承，显式新实体切题且普通事实不被抢', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  const follow = '第一步看过了，后面先怎么处理？';
  const inherited = S.contextualRouteQuestion(map, [
    { role: 'user', content: 'PWRS 的患者同步是谁定时触发的？' },
    { role: 'assistant', content: '已按模块地图确认外部调度边界。' },
    { role: 'user', content: follow },
  ], follow, '');
  assert.equal(inherited.route?.id, 'DQ-013');
  assert.equal(inherited.inherited, true);

  const switchedQuestion = '换个问题，药师反馈发送后正文还能改吗？';
  const switched = S.contextualRouteQuestion(map, [
    { role: 'user', content: '同步最后成功时间停在昨天，能不能重跑？' },
    { role: 'assistant', content: '旧时间只是观测证据。' },
    { role: 'user', content: switchedQuestion },
  ], switchedQuestion, '');
  assert.equal(switched.route?.id, 'QR-FEEDBACK-SEND-DEDUP');
  assert.notEqual(switched.route?.id, 'DQ-013');

  for (const question of ['token 是谁签发的？', '这个红色按钮点哪个？', '患者列表从哪个接口取数？']) {
    const hit = S.routeQuestion(map, question, '');
    assert.notEqual(hit.route?.id, 'DQ-013', question);
  }
});

test('真实PWRS地图回归：下载导出附件与模板文件验收自然问法命中DQ-014并保留完整制品门', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  for (const question of [
    '导出接口返回 200 就算成功了吗？',
    '附件下载返回 200，响应其实是 JSON 错误体，怎么判断？',
    '下载文件后缀是 docx，但 magic 不是 ZIP，能算成功吗？',
    'PDF 有 header 但没有 EOF 和 xref，还算结构完整吗？',
    'DOCX 的 central directory 或必要 entries 损坏，实施怎么留证？',
    '模板下载文件非空也能打开，还需要验 MIME、签名和正文吗？',
    '医院报导出坏文件，换账号就正常了，先查数据范围还是文件本体？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route?.id, 'DQ-014', `${question}，top=${JSON.stringify(hit.topN)}`);
    const facts = hit.answerFacts.join('\n');
    assert.match(facts, /响应体是文件字节而不是 JSON\/HTML 错误体/);
    assert.match(facts, /bytes>0/);
    assert.match(facts, /magic\/签名与扩展名及 Content-Type\/MIME 一致/);
    assert.match(facts, /PDF.*header、EOF\/xref/);
    assert.match(facts, /DOCX\/XLSX\/ZIP.*central directory.*必要 entries/);
    assert.match(facts, /格式未知.*实际文件名、扩展名和 MIME.*不得硬猜/);
    assert.match(facts, /换账号后正常.*同环境、同入口、同筛选和同一已有记录/);
    assert.match(facts, /不得修改权限、模板或业务数据来验证/);
  }
});

test('真实PWRS地图回归：导出事实可继承，显式医嘱审核切题且普通事实不被抢', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  const follow = '回到导出文件这里，第一步看过了，没发现异常。接下来呢？';
  const inherited = S.contextualRouteQuestion(map, [
    { role: 'user', content: '导出接口返回 200 就算成功了吗？' },
    { role: 'assistant', content: '只复述已核 route，不提供自由猜测。' },
    { role: 'user', content: follow },
  ], follow, '');
  assert.equal(inherited.route?.id, 'DQ-014');
  assert.equal(inherited.inherited, true);
  assert.match(inherited.answerFacts.join('\n'), /magic\/签名.*MIME/);

  const switchedQuestion = '换个问题，非创建人重复提交同组医嘱的错误码和数据结果是什么？';
  const switched = S.contextualRouteQuestion(map, [
    { role: 'user', content: '附件下载是 JSON 错误体，怎么验文件？' },
    { role: 'assistant', content: '继续按文件制品门只读核对。' },
    { role: 'user', content: switchedQuestion },
  ], switchedQuestion, '');
  assert.notEqual(switched.route?.id, 'DQ-014');
  assert.match(switched.answerFacts.join('\n'), /ORDER_NOT_USER/);

  for (const question of ['token 是谁签发的？', '这个红色按钮点哪个？', '患者列表从哪个接口取数？']) {
    const hit = S.routeQuestion(map, question, '');
    assert.notEqual(hit.route?.id, 'DQ-014', question);
  }
});

test('真实PWRS地图回归：权限与归属后续排查保持事实并优先只读证据，显式新实体仍切题', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  for (const question of [
    'PWRS 服务端现在有方法级权限校验吗？',
    '方法授权和业务归属问题下一步怎么只读排查？',
    '不改数据怎么对照 owner 和院区拦截？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route?.id, 'QR-INTERFACE-AUTH-BOUNDARY', `${question}，top=${JSON.stringify(hit.topN)}`);
    const facts = hit.answerFacts.join('\n');
    assert.match(facts, /当前 PWRS Controller 基本没有方法级/);
    assert.match(facts, /已有正常与异常记录、已经发生的请求响应和历史日志审计/);
    assert.match(facts, /不得为了验证 owner 或范围规则而新建、修改、删除或提交业务记录/);
    assert.match(facts, /隔离测试环境或专用数据.*执行授权.*回滚清理方案.*幂等性与影响范围/);
  }

  const follow = '医院报的方法授权与业务归属问题，这一步正常，但问题还在。你直接告诉我下一个检查点。';
  const inherited = S.contextualRouteQuestion(map, [
    { role: 'user', content: 'PWRS 服务端现在有方法级权限校验吗？' },
    { role: 'assistant', content: '只复述已核 route，不提供自由猜测。' },
    { role: 'user', content: follow },
  ], follow, '');
  assert.equal(inherited.route?.id, 'QR-INTERFACE-AUTH-BOUNDARY');
  assert.match(inherited.answerFacts.join('\n'), /不得为了验证 owner 或范围规则而新建、修改、删除或提交业务记录/);

  const rephrase = '回到方法授权与业务归属这里，我没太听懂，换成实施能照着做的话再说一遍。';
  const rephrased = S.contextualRouteQuestion(map, [
    { role: 'user', content: 'PWRS 服务端现在有方法级权限校验吗？' },
    { role: 'assistant', content: '方法级和业务归属是不同层。' },
    { role: 'user', content: follow },
    { role: 'assistant', content: '继续只读核对已有证据。' },
    { role: 'user', content: rephrase },
  ], rephrase, '');
  assert.equal(rephrased.route?.id, 'QR-INTERFACE-AUTH-BOUNDARY');

  const weakFollow = '这一步正常了，但问题还在，直接告诉我下一个检查点。';
  const weakInherited = S.contextualRouteQuestion(map, [
    { role: 'user', content: 'PWRS 服务端现在有方法级权限校验吗？' },
    { role: 'assistant', content: '只使用route事实。' },
    { role: 'user', content: weakFollow },
  ], weakFollow, '');
  assert.equal(weakInherited.route?.id, 'QR-INTERFACE-AUTH-BOUNDARY');
  assert.equal(weakInherited.inherited, true);

  const switchedQuestion = '换个问题，药师反馈发送后正文还能改吗？';
  const switched = S.contextualRouteQuestion(map, [
    { role: 'user', content: '方法授权和业务归属下一步怎么查？' },
    { role: 'assistant', content: '继续按权限事实账本。' },
    { role: 'user', content: switchedQuestion },
  ], switchedQuestion, '');
  assert.equal(switched.route?.id, 'QR-FEEDBACK-SEND-DEDUP');
  assert.notEqual(switched.route?.id, 'QR-INTERFACE-AUTH-BOUNDARY');
});

test('真实PWRS地图回归：JWT 前缀精确边界与患教链路命中专用事实，显式切题不串', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  for (const question of [
    '业务路径中间带 comm 会不会绕过 JWT？',
    '/comm/ 和 /comm 是不是同一个白名单前缀？',
    '/community 会命中免鉴权 allowlist 吗？',
    '现有请求只看到路径，怎么按 startsWith 判断是否免鉴权？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route?.id, 'QR-JWT-ANON-PREFIX', `${question}，top=${JSON.stringify(hit.topN)}`);
    const facts = hit.answerFacts.join('\n') + '\n' + hit.mustNotConfuse.join('\n');
    assert.match(facts, /前缀为 \/comm\/、\/external、\/swagger、\/v3\/api-docs/);
    assert.match(facts, /路径中间包含 comm.*不会命中/);
    assert.match(facts, /\/comm\/ 带尾斜杠/);
  }

  for (const question of [
    '没有患者签名就绝对不能完成患教，对吧？',
    '业务保存成功但患者没收到，能直接推出签名失败吗？',
    '患教完成、消息送达和签名是不是同一个状态？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.ok(['QR-EDU-DRAFT-COMPLETE', 'QR-CONSULT-WORKFLOW-SEPARATION', 'DQ-010'].includes(hit.route?.id), `${question}，top=${JSON.stringify(hit.topN)}`);
    assert.match(hit.answerFacts.join('\n'), /保存|消息|完成|签名/);
  }

  for (const question of [
    '患教规则已经确认签名非必填，能让创建人点一次完成验证吗？',
    '患教没有患者签名能不能完成，完成后还能重开吗？',
  ]) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.route?.id, 'QR-EDU-DRAFT-COMPLETE', `${question}，top=${JSON.stringify(hit.topN)}`);
    const facts = hit.answerFacts.join('\n') + '\n' + hit.mustNotConfuse.join('\n');
    assert.match(facts, /患者签名始终非必填/);
    assert.match(facts, /只有患教创建人可以完成/);
    assert.match(facts, /完成后记录只读、不可再次完成或重开/);
    assert.match(facts, /不得把监护单、查房或其它模块/);
  }

  const switchedQuestion = '换个问题，PWRS 的 token 到底是谁签发的？';
  const switched = S.contextualRouteQuestion(map, [
    { role: 'user', content: '业务路径中间带 comm 会不会绕过 JWT？' },
    { role: 'assistant', content: '只复述精确前缀事实。' },
    { role: 'user', content: switchedQuestion },
  ], switchedQuestion, '');
  assert.notEqual(switched.route?.id, 'QR-JWT-ANON-PREFIX');
  assert.match(switched.answerFacts.join('\n'), /usercenter.*签发|统一用户中心.*签发/i);
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

test('Q0009 长接口章节：800字紧凑节选保留全部接口签名与状态/数据边界，不只留下第一个接口', () => {
  const S = buildRoutingSandbox(makeDeps());
  const filler = '普通字段说明'.repeat(90);
  const full = `## 接口契约\n### 4.1 列表\nGET /auditapi/audit/ipt/collects\n${filler}\n### 4.2 新增\nPOST /auditapi/audit/ipt/task/collect\n${filler}\n### 4.3 取消\nDELETE /auditapi/audit/ipt/collect\n${filler}\n### 4.4 导出\nGET /auditapi/comm/ipt/collects/excel\n${filler}\n软删除写 audit_ipt_collect.deleted=1，不物理删除。\n## 下一节\n不应进入。`;
  const section = S.extractSection(full, { section: '接口契约', anchor: '接口契约' });
  assert.ok(section.length > 900, '精确章节定位不再在 900 字静默截断');
  assert.doesNotMatch(section, /不应进入/);
  const excerpt = S.routeEvidenceExcerpt(section, 800);
  assert.ok(excerpt.length <= 800, '实际 route hit 保持紧凑');
  assert.match(excerpt, /GET \/auditapi\/audit\/ipt\/collects/);
  assert.match(excerpt, /POST \/auditapi\/audit\/ipt\/task\/collect/);
  assert.match(excerpt, /DELETE \/auditapi\/audit\/ipt\/collect/);
  assert.match(excerpt, /GET \/auditapi\/comm\/ipt\/collects\/excel/);
  assert.match(excerpt, /audit_ipt_collect\.deleted=1/);
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
  assert.equal(ctx.specHits.find(h => h.section !== 'answerFacts')?.routeRefKind, 'context', '已有 answerFacts 时精确 contextRef 先读并保留引用类型');
  assert.ok(ctx.specHits.some(h => h.routeRefKind === 'primary'), '仍保留 primary 引用供事实主线使用');
  assert.deepEqual(ctx.mustNotConfuse, FIXTURE_MAP.questionRoutes[0].mustNotConfuse, '带出 mustNotConfuse');
});

test('AC-9 loadRouteContext：已有 answerFacts 时先读 contextRefs，primary 不得挤掉第六条精确上下文', () => {
  const repo = makeFixtureRepo(true);
  const S = buildRoutingSandbox(makeDeps(repo));
  const sp = path.join(repo, 'docs', 'specs');
  for (let i = 0; i < 6; i++) fs.writeFileSync(path.join(sp, `CTX-${i}.md`), `---\nid: CTX-${i}\n---\n\n## 精确上下文${i}\n契约正文${i}。\n`);
  const ref = i => ({ path: `docs/specs/CTX-${i}.md`, section: '精确上下文' + i, anchor: '精确上下文' + i, specId: 'CTX-' + i });
  S.loadModuleMap({ id: 'pwrs', repoPath: repo }, '');
  const ctx = S.loadRouteContext({ id: 'pwrs', repoPath: repo }, '', {
    answerFacts: ['已有经确认事实。'],
    primaryRefs: [{ path: 'docs/specs/PWRS-SYS-06.md', section: '7. order_instruction 的完整配置答案', anchor: '7-orderinstruction-的完整配置答案', specId: 'PWRS-SYS-06' }],
    contextRefs: Array.from({ length: 6 }, (_, i) => ref(i)),
  });
  const refs = ctx.specHits.filter(h => h.section !== 'answerFacts');
  assert.equal(refs.length, 6, 'loadRouteContext 自身 cap 仍为 6');
  assert.ok(refs.every(h => h.routeRefKind === 'context'), '六条精确 contextRefs 全部先进入 load cap，宽泛 primary 不抢位');
});

test('AC-6 无地图产品：loadModuleMap 返 null（consult 回落 specSearch，向后兼容）', () => {
  const repo = makeFixtureRepo(false);   // 不写地图文件
  const S = buildRoutingSandbox(makeDeps(repo));
  const map = S.loadModuleMap({ id: 'nomap', repoPath: repo }, '');
  assert.equal(map, null, '无地图 → null，consult 走原 specSearch 分支');
});

test('AC-6 无地图产品：consult 源码分支——map=null 才走 specSearch（源码级断言）', () => {
  // 有地图 → route 命中/miss 走新分支；无地图（map falsy）→ specHits = specSearch(...)（原行为）
  assert.match(SRC, /const map = loadModuleMap\(proj, cver\); if \(map\) route = contextualRouteQuestion\(map, msgs, qtext, sub\)/, 'consult 先加载地图，再结合当前对话做可审计路由');
  assert.match(SRC, /specHits = specSearch\(proj, cver, retrievalQuery, 5, sub\);\s+\/\/ 无地图产品/, '无地图分支仍用 specSearch');
  // PD-04 修复：miss 固定话术条件多了 specNoSpec（specSearch 底座也弱/空）——specSearch 强匹配时即便路由 miss 也不再走固定话术。
  assert.match(SRC, /const noAnswer = !conversationMode && !safeDiagnostic && routeMiss && specNoSpec && !\(b\.deep && codeHits && codeHits\.length\)/, '纯事实题 miss 且 specSearch 弱/空→noAnswer；纯对话/混合表达与安全诊断不走机械短路');
});

// —— PD-04 修复：specSearch 作底座、路由作加成（assembleConsultSpecHits 纯函数单测）—— //
const RH = (m, t, x = '') => ({ subsystem: '', module: m, title: t, section: '', text: x || (m + t) });   // route hit（含 answerFacts 顶段 module='模块地图'）
const SH = (m, t, score, x = '') => ({ subsystem: '', module: m, title: t, text: x || (m + t), score });   // specSearch scored hit

test('PD-04修复 路由命中：answerFacts 最高、最强 search 纠偏、人工精确引用保留并去重', () => {
  const S = buildRoutingSandbox(makeDeps());
  const routeHits = [{ ...RH('模块地图', '经确认事实（最高优先，据此作答）', 'answerFacts 内容'), section: 'answerFacts' }, RH('PWRS-SYS-06', '收费配置', '收费章节正文')];
  const searchHits = [SH('PWRS-ACT-01', '系统激活注册', 16.5, '激活包上传、激活状态门禁'), SH('PWRS-SYS-06', '收费配置', 4.3, '收费章节正文')];   // 末条与 route 重复
  const asm = S.assembleConsultSpecHits(true, routeHits, searchHits, S.SPEC_MIN_RELEVANT);
  assert.equal(asm.specHits[0].title, '经确认事实（最高优先，据此作答）', 'answerFacts 顶段置前（最高优）');
  assert.equal(asm.specHits[1].title, '系统激活注册', 'answerFacts 后仅先放最强 specSearch 作错路由纠偏');
  assert.equal(asm.specHits[2].title, '收费配置', '纠偏位后保留人工 route 指向的精确章节');
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
  assert.equal(asm.specHits[0].title, '搜索0', '没有 answerFacts 时，最强 specSearch 仍置首作错路由纠偏');
  assert.ok(asm.specHits.some(h => h.title === '路由0'), '同时保留人工 route 精确引用');
});

test('Q0009 MK-02：人工 contextRefs 在 cap 内保住导出、表、软删、权限与入口，directEvidence 不混入宽泛搜索', () => {
  const S = buildRoutingSandbox(makeDeps());
  const routeHits = [
    { ...RH('模块地图', '经确认事实（最高优先，据此作答）', '住院医嘱标记支持列表、新增和取消。'), section: 'answerFacts' },
    { ...RH('AUD-MK-02', '验证问题', '把入口、接口或数据到外部依赖串起来。'), routeRefKind: 'primary' },
    { ...RH('AUD-MK-02', '接口契约', '列表 GET /auditapi/audit/ipt/collects；新增 POST /auditapi/audit/ipt/task/collect；取消 DELETE /auditapi/audit/ipt/collect；导出 GET /comm/ipt/collects/excel。'), routeRefKind: 'context' },
    { ...RH('AUD-MK-02', '数据契约', '持久化表 audit_ipt_collect，记录住院医嘱标记。'), routeRefKind: 'context' },
    { ...RH('AUD-MK-02', '状态边界', '取消采用软删除，更新 deleted=1。'), routeRefKind: 'context' },
    { ...RH('AUD-MK-02', '权限与安全', '调用接口需要有效登录身份，并按既有权限边界执行。'), routeRefKind: 'context' },
    { ...RH('AUD-MK-02', '前端入口与外部依赖', '住院医嘱审核任务提供标记入口，链路依赖既有审核任务与导出能力。'), routeRefKind: 'context' },
  ];
  const searchHits = Array.from({ length: 5 }, (_, i) => SH('AUD-OVERVIEW-' + i, '宽泛检索' + i, 100 - i, '相邻模块的宽泛搜索正文' + i));
  const asm = S.assembleConsultSpecHits(true, routeHits, searchHits, S.SPEC_MIN_RELEVANT, 7);
  const modelContext = asm.specHits.map(h => h.text).join('\n');
  const direct = asm.directEvidenceHits.map(h => h.text).join('\n');

  assert.equal(asm.specHits[0].section, 'answerFacts', 'answerFacts 仍为第一优先级');
  assert.equal(asm.specHits[1].title, '宽泛检索0', '最强 specSearch 仅占第二位作错路由纠偏');
  assert.equal(asm.specHits.length, 7, '实际模型上下文不超过统一 cap');
  assert.match(modelContext, /GET \/comm\/ipt\/collects\/excel/, '导出接口精确引用进入实际模型上下文');
  assert.match(modelContext, /audit_ipt_collect/, '表契约进入实际模型上下文');
  assert.match(modelContext, /deleted=1/, '软删除状态边界进入实际模型上下文');
  assert.match(modelContext, /权限边界/, '权限与安全引用进入实际模型上下文');
  assert.match(modelContext, /住院医嘱审核任务提供标记入口/, '前端入口引用进入实际模型上下文');
  assert.equal(asm.specHits.filter(h => /^宽泛检索/.test(h.title)).length, 1, '宽泛 specSearch 最多占一个纠偏位，不再挤掉精确 contextRefs');
  assert.match(direct, /GET \/comm\/ipt\/collects\/excel/);
  assert.match(direct, /audit_ipt_collect/);
  assert.match(direct, /deleted=1/);
  assert.doesNotMatch(direct, /相邻模块的宽泛搜索正文/, 'directEvidence 仅来自人工 route 已实际注入的证据，不混入相邻模块搜索');
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
  assert.match(SRC, /route\.directEvidenceFacts = \(asm\.directEvidenceHits \|\| \[\]\)\.map\([^\n]+\.text\)[^\n]+\.filter\(Boolean\)/, '发布前审计只接收实际注入的人工 route 证据，不把宽泛 search 当 directEvidence');
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

test('真实PWRS地图回归：患者类诊断补全全局三元身份，Pad监护链路事实完整', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  const cases = [
    ['AI药历没生成，现场抓什么请求参数排查？', 'QR-AI-MEDICINE-STATUS'],
    ['患者关注按患者和药师怎么判断？', 'QR-PATIENT-FOCUS-OWNER'],
    ['实施照着走 Pad 监护列表到详情的完整链是什么？', 'QR-PAD-CARE-ROUTE'],
    ['Pad 监护详情数据从哪个 GET 接口读取？', 'QR-PAD-CARE-ROUTE'],
    ['care order 是详情读取接口还是下监护医嘱？', 'QR-PAD-CARE-ROUTE'],
  ];
  for (const [question, expected] of cases) {
    const hit = S.routeQuestion(map, question, '');
    assert.equal(hit.matched, true, question);
    assert.equal(hit.route.id, expected, question);
    if (/药历|关注|监护/.test(question)) {
      assert.match(hit.answerFacts.join('\n'), /hospitalId \+ patientId \+ visitId/, question);
    }
  }
  const care = S.routeQuestion(map, '点监护记录前是否先同步患者上下文，详情请求是什么？', '');
  const facts = care.answerFacts.join('\n');
  assert.match(facts, /tablet\/pages\/ucenter\/info\/custody\.vue/);
  assert.match(facts, /先同步\/确认.*患者上下文/);
  assert.match(facts, /tablet\/pages\/patient\/info\/custody\.vue\?careTypeId=<监护ID>/);
  assert.match(facts, /GET \/pwrsapi\/applet\/follow\/care\?careTypeId=<监护ID>/);
  assert.match(facts, /\/care\/order 是下监护医嘱.*不是.*详情读取接口/);
});

test('真实PWRS地图审计：凡同时出现 patientId 与 visitId 的 route 都不得漏全局 hospitalId', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const offenders = (map.questionRoutes || []).filter((route) => {
    const facts = [...(route.answerFacts || []), ...(route.mustNotConfuse || [])].join('\n');
    return /patientId/i.test(facts) && /visitId/i.test(facts) && !/hospitalId/i.test(facts);
  }).map((route) => route.id);
  assert.deepEqual(offenders, []);
});

test('真实PWRS地图回归：今天视图、自定义表单和患者号链按显式实体切换且后续继承', { skip: !process.env.PWRS_REAL_MAP }, () => {
  const map = JSON.parse(fs.readFileSync(process.env.PWRS_REAL_MAP, 'utf8'));
  const S = buildRoutingSandbox(makeDeps());
  const todayMessages = [
    { role: 'user', content: '工作台今天日期和星期调用哪个接口？' },
    { role: 'assistant', content: '历史回答只用于对话位置，不作事实证据。' },
  ];
  const today = S.contextualRouteQuestion(map, todayMessages, '现在卡在“今天视图显示的年份或星期和浏览器理解不一致”。给我一个能直接照着走的排查顺序。', '');
  assert.equal(today.route.id, 'QR-WORKBENCH-TODAY');
  assert.match(today.answerFacts.join(' '), /服务端 JVM 当前时区/);
  const screenshotOnly = S.contextualRouteQuestion(map, todayMessages.concat(
    { role: 'user', content: '现在卡在“今天视图显示的年份或星期和浏览器理解不一致”。给我一个能直接照着走的排查顺序。' },
    { role: 'assistant', content: '历史回答不作证据。' },
  ), '现场还卡在今天视图时间这里，我只拿得到这张截图，没有日志，够不够？', '');
  assert.equal(screenshotOnly.route.id, 'QR-WORKBENCH-TODAY');
  assert.equal(screenshotOnly.inherited, true);
  assert.equal(screenshotOnly.directCandidate?.id, 'DQ-013');
  assert.doesNotMatch(screenshotOnly.answerFacts.join(' '), /外部调度|\/comm\/\*/);
  const capturedRequest = S.contextualRouteQuestion(map, todayMessages.concat(
    { role: 'user', content: '现在卡在“今天视图显示的年份或星期和浏览器理解不一致”。给我一个能直接照着走的排查顺序。' },
    { role: 'assistant', content: '历史回答不作证据。' },
    { role: 'user', content: '现场还卡在今天视图时间这里，我只拿得到这张截图，没有日志，够不够？' },
    { role: 'assistant', content: '历史回答不作证据。' },
  ), '关于今天视图时间，请求和响应都抓到了，重点核对哪几个地方？', '');
  assert.equal(capturedRequest.route.id, 'QR-WORKBENCH-TODAY');
  assert.equal(capturedRequest.inherited, true);
  assert.equal(capturedRequest.directCandidate?.id, 'DQ-013');
  assert.match(capturedRequest.answerFacts.join(' '), /GET \/pwrsapi\/month\/view\/today/);
  assert.doesNotMatch(capturedRequest.answerFacts.join(' '), /外部调度|\/comm\/\*/);
  const explicitAboutSwitch = S.contextualRouteQuestion(map, todayMessages, '关于自定义表单的 form_id、element_id 和结果 content，重点核对怎么关联？', '');
  assert.equal(explicitAboutSwitch.route.id, 'QR-CUSTOM-FORM-RELATION');
  assert.notEqual(explicitAboutSwitch.inherited, true, '“关于”只打开上下文裁决，显式新实体仍须切到当前 route');

  const form = S.contextualRouteQuestion(map, todayMessages.concat(
    { role: 'user', content: '自定义表单的 form_id、element_id 和结果 content 分别怎么关联？' },
    { role: 'assistant', content: '历史回答不作证据。' },
  ), '医院报的自定义表单关联问题，按这个顺序查到第二步就对不上了，后面先停还是继续？', '');
  assert.equal(form.route.id, 'QR-CUSTOM-FORM-RELATION');
  assert.match(form.answerFacts.join(' '), /element_id/);

  const patientMessages = [
    { role: 'user', content: 'pwrs_patient.patient_id 在 PostgreSQL 里是什么类型和长度？' },
    { role: 'assistant', content: '历史回答不作证据。' },
  ];
  for (const question of [
    '医院说这个患者号有时会少一位，我先查请求还是先查库？',
    '上午反馈的患者号字段问题，数据库这边暂时没权限查。仅靠页面和接口响应能先排除什么？',
    '患者号字段这一段，按这个顺序查到第二步就对不上了，后面先停还是继续？',
  ]) {
    const hit = S.contextualRouteQuestion(map, patientMessages, question, '');
    assert.equal(hit.route.id, 'QR-PATIENT-ID-COLUMN-TYPE', question);
    assert.match(hit.answerFacts.join(' '), /character varying\(50\)/);
    assert.ok(Array.isArray(hit.focusTechnicalTokens), `应保留技术焦点：${question}`);
    assert.ok(hit.focusTechnicalTokens.includes('pwrs_patient'), question);
    assert.ok(hit.focusTechnicalTokens.includes('patient_id'), question);
  }

  const firstPatientFollowup = S.contextualRouteQuestion(
    map,
    patientMessages,
    '医院电话里只说“对接方把患者号当数字传，长号码开始丢位”。我应该先让他们做哪个验证？',
    '',
  );
  const chainedPatientFollowup = S.contextualRouteQuestion(map, patientMessages.concat(
    { role: 'user', content: '医院电话里只说“对接方把患者号当数字传，长号码开始丢位”。我应该先让他们做哪个验证？' },
    { role: 'assistant', content: '历史回答不作证据。' },
  ), '患者号字段这一段，按这个顺序查到第二步就对不上了，后面先停还是继续？', '');
  assert.equal(firstPatientFollowup.route.id, 'QR-PATIENT-ID-COLUMN-TYPE');
  assert.deepEqual(firstPatientFollowup.focusTechnicalTokens, ['pwrs_patient', 'patient_id']);
  assert.equal(chainedPatientFollowup.route.id, 'QR-PATIENT-ID-COLUMN-TYPE');
  assert.ok(chainedPatientFollowup.focusTechnicalTokens.includes('pwrs_patient'), JSON.stringify(chainedPatientFollowup.focusTechnicalTokens));
  assert.ok(chainedPatientFollowup.focusTechnicalTokens.includes('patient_id'), JSON.stringify(chainedPatientFollowup.focusTechnicalTokens));

  const switched = S.contextualRouteQuestion(map, patientMessages, '换个问题，PWRS 的 token 到底是谁签发的？', '');
  assert.equal(switched.route.id, 'QR-TOKEN-AUTH-CHAIN');
  assert.notEqual(switched.inherited, true);
});
