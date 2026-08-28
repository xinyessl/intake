import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, `应找到 ${name}`);
  const parenOpen = src.indexOf('(', start);
  let pd = 0, parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')' && --pd === 0) { parenClose = i; break; }
  }
  const braceOpen = src.indexOf('{', parenClose);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
  }
  assert.ok(end > braceOpen, `${name} 大括号应配平`);
  return src.slice(start, end + 1);
}

const mode = new Function(extractFn(SRC, 'consultConversationMode') + '\nreturn consultConversationMode;')();
const classify = new Function('consultConversationMode', extractFn(SRC, 'consultConversationTurn') + '\nreturn consultConversationTurn;')(mode);
const guard = new Function(extractFn(SRC, 'consultConversationGuard') + '\nreturn consultConversationGuard;')();
const safeDiagnosticIntent = new Function(extractFn(SRC, 'consultSafeDiagnosticIntent') + '\nreturn consultSafeDiagnosticIntent;')();
const audienceMode = new Function('consultSafeDiagnosticIntent', extractFn(SRC, 'consultAudienceMode') + '\nreturn consultAudienceMode;')(safeDiagnosticIntent);
const audienceGuard = new Function('consultAudienceMode', extractFn(SRC, 'consultAudienceGuard') + '\nreturn consultAudienceGuard;')(audienceMode);
const routeConstants = ['ROUTE_MATCH_MIN', 'ROUTE_ALIAS_BONUS', 'ROUTE_EXACT_TITLE_MIN_RATIO', 'ROUTE_EXACT_TIER3']
  .map(name => SRC.match(new RegExp(`const ${name} = [^;]+;`))?.[0] || '').join('\n');
const routeQuestion = new Function(
  routeConstants + '\n'
    + extractFn(SRC, 'kbTokenize') + '\n'
    + extractFn(SRC, 'routeScorer') + '\n'
    + extractFn(SRC, 'consultExplicitOperationContracts') + '\n'
    + extractFn(SRC, 'routeHasDirectOperationEvidence') + '\n'
    + extractFn(SRC, 'routeQuestion') + '\nreturn routeQuestion;',
)();
const consultScopeTechnicalTokens = new Function(
  extractFn(SRC, 'consultScopeTechnicalTokens') + '\nreturn consultScopeTechnicalTokens;',
)();
const contextualRouteQuestion = new Function(
  'routeQuestion', 'consultScopeTechnicalTokens',
  extractFn(SRC, 'consultContextFollowupIntent') + '\n'
    + extractFn(SRC, 'contextualRouteQuestion') + '\nreturn contextualRouteQuestion;',
)(routeQuestion, consultScopeTechnicalTokens);
const assembleConsultSpecHits = new Function(extractFn(SRC, 'assembleConsultSpecHits') + '\nreturn assembleConsultSpecHits;')();
const loadRouteContext = new Function(
  'safeRef', 'moduleMapRepo', 'specFileText',
  extractFn(SRC, 'extractSection') + '\n'
    + extractFn(SRC, 'routeEvidenceExcerpt') + '\n'
    + extractFn(SRC, 'loadRouteContext') + '\nreturn loadRouteContext;',
)(value => String(value || ''), () => path.resolve(ROOT, '../psp/audit'), () => '');
const loadRouteContextWithRepository = new Function(
  'safeRef', 'moduleMapRepo', 'specFileText',
  extractFn(SRC, 'extractSection') + '\n'
    + extractFn(SRC, 'routeEvidenceExcerpt') + '\n'
    + extractFn(SRC, 'loadRouteContext') + '\nreturn loadRouteContext;',
)(
  value => String(value || ''),
  () => path.resolve(ROOT, '../psp/audit'),
  (repoPath, ref, rel) => {
    try {
      return ref
        ? execFileSync('git', ['-c', 'core.quotepath=false', 'show', `${ref}:${rel}`], { cwd: repoPath, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
        : fs.readFileSync(path.join(repoPath, rel), 'utf8');
    } catch { return ''; }
  },
);

function runtimeRouteWithContext(route) {
  const context = loadRouteContext({}, '', route);
  const assembled = assembleConsultSpecHits(true, context.specHits, [], 8, 7);
  return {
    ...route,
    directEvidenceFacts: (assembled.directEvidenceHits || []).map(hit => String((hit && hit.text) || '')).filter(Boolean),
  };
}

function runtimeRouteWithRepositoryContext(route, ref = '') {
  const context = loadRouteContextWithRepository({}, ref, route);
  const assembled = assembleConsultSpecHits(true, context.specHits, [], 8, 7);
  return {
    ...route,
    directEvidenceFacts: (assembled.directEvidenceHits || []).map(hit => String((hit && hit.text) || '')).filter(Boolean),
  };
}

test('答疑受众按问句意图分层：普通业务默认产品，现场诊断归实施，明确技术契约才归研发', () => {
  for (const q of ['医嘱标记现在是怎么实现的？', '这个功能是什么？', '支持哪些业务场景？', '业务规则和状态边界是什么？']) {
    assert.equal(audienceMode(q), 'product', q);
  }
  for (const q of ['现场怎么排查？', '复测到这里下一步怎么查？', '转开发前给我一份只读清单', '只有截图，怎么判断到哪一层？', '今天视图请求和响应抓到了，重点核什么？', '怎么只读核对时间？', '怎么只读核时间？', '我没完全听懂医嘱标记的排查建议，换成实施可以逐项照做的只读清单。']) {
    assert.equal(audienceMode(q), 'implementation', q);
  }
  for (const q of ['具体接口路径和字段是什么？', 'p_id 列类型是什么？', 'p_id column type 是什么？', '从 Controller 到 Mapper 的开发链路在哪？', 'SQL 查哪张表？', '这段代码在哪个 Java 类实现？']) {
    assert.equal(audienceMode(q), 'developer', q);
  }
});

test('产品答复首屏业务化且不暴露源码名；实施给只读步骤和判断边界；研发保留完整技术契约', () => {
  const product = audienceGuard('医嘱标记现在是怎么实现的？');
  assert.match(product, /第一屏直接说业务结论、适用对象\/场景、状态边界和用户影响/);
  assert.match(product, /不要输出源码文件名、Java 类\/方法名/);
  assert.match(product, /Controller\/Service\/Mapper\/DTO\/VO/);
  assert.match(product, /不要主动谈“接口路径、字段、状态值、Java 模型、源码、研发参考、技术依据”/);
  assert.match(product, /业务结论与对象范围已经答清后立即停止/);
  assert.match(product, /用户下一轮明确追问这些技术契约时再按研发受众展开/);

  const implementation = audienceGuard('现场复测失败，怎么排查和留证？');
  assert.match(implementation, /2~4 个可照做的只读编号步骤/);
  assert.match(implementation, /看什么\/记录什么/);
  assert.match(implementation, /看到不同结果分别能判断到哪/);
  assert.match(implementation, /答案末尾的“研发参考”小节/);

  const developer = audienceGuard('接口、字段、Java 类和 Mapper 调用链是什么？');
  assert.match(developer, /可以完整展开有当前证据支持的接口方法与路径、字段、表、类\/方法和调用链/);
  assert.match(developer, /不得为了简洁删掉本轮明确追问的技术契约/);
});

test('模型流式正常结束但无正文时切备用，全部为空时返回明确错误而非空气泡', async () => {
  const attempts = [];
  const stream = new Function(
    'modelCandidates',
    'callModelStreamOnce',
    'async ' + extractFn(SRC, 'callModelStream') + '\nreturn callModelStream;',
  )(
    cfg => cfg.candidates,
    async (candidate, _opts, onDelta) => {
      attempts.push(candidate.id);
      if (candidate.id === 'empty') return '';
      if (candidate.id === 'space') { onDelta('   '); return '   '; }
      onDelta('备用回答'); return '备用回答';
    },
  );
  const chunks = [];
  const answer = await stream({ candidates: [{ id: 'empty' }, { id: 'ok' }] }, {}, piece => chunks.push(piece));
  assert.equal(answer, '备用回答');
  assert.deepEqual(attempts, ['empty', 'ok']);
  assert.deepEqual(chunks, ['备用回答']);

  attempts.length = 0; chunks.length = 0;
  const whitespaceAnswer = await stream({ candidates: [{ id: 'space' }, { id: 'ok' }] }, {}, piece => { if (String(piece).trim()) chunks.push(piece); });
  assert.equal(whitespaceAnswer, '备用回答', '只有空白 chunk 仍应视为首个可见正文前失败');
  assert.deepEqual(attempts, ['space', 'ok']);

  await assert.rejects(
    stream({ candidates: [{ id: 'empty' }] }, {}, () => {}),
    /模型返回空内容/,
    '全部候选都空时必须交给上层输出明确错误文案',
  );
});

test('纯寒暄、情绪反馈、表达偏好和换种说法属于对话性表达', () => {
  for (const q of [
    '你好',
    '谢谢！',
    '你也太冷漠了吧',
    '你说话有点像机器人',
    '别这么冷冰冰的',
    '能不能说得温柔一点？',
    '我没听懂',
    '换个说法',
    '你刚才是什么意思？',
    '行，那你简单点说',
    '好，你说简单一点',
    '别那么官方，直白点',
    '我没听懂，再说一遍',
    '麻烦换一种说法吧',
  ]) assert.equal(classify(q), true, q);
});

test('系统事实题或情绪夹带事实追问仍走证据门', () => {
  for (const q of [
    '这个红色按钮该点哪个固定重试入口？',
    '你也太冷漠了吧，这个按钮到底点哪个？',
    '谢谢，那患者列表查哪个 ETL？',
    '能不能告诉我接口路径？',
    '为什么菜单不可见？',
    'V_IPT_PATIENT 是最终 interfaceCode 吗？',
    '简单点说，最终 ETL 就是 V_IPT_PATIENT 吗？',
    '直白点说，这个按钮到底点哪个？',
    '别那么官方，告诉我接口路径',
    '我没听懂，患者列表到底查哪张表？',
  ]) assert.equal(classify(q), false, q);
});

test('三态分流：纯对话、混合意图、纯事实严格区分', () => {
  assert.equal(mode('行，那你简单点说'), 'pure');
  assert.equal(mode('别这么冷漠，直白点告诉我这个按钮到底点哪个'), 'mixed');
  assert.equal(mode('我没完全听懂医嘱标记的排查建议，换成实施可以逐项照做的只读清单。'), 'mixed');
  assert.equal(mode('简单点说，最终 ETL 就是 V_IPT_PATIENT 吗？'), 'mixed');
  assert.equal(mode('这个红色按钮到底点哪个？'), '');
});

test('助手身份问法独立分流，人员/来源事实中的“谁”不绕证据门', () => {
  for (const q of ['你好，你是谁？', '你是干嘛的', '你能帮我什么？', '怎么称呼你', '你叫什么名字？']) {
    assert.equal(mode(q), 'identity', q);
  }
  for (const q of ['token 谁签发？', '这条记录谁创建的？', '谁有权限删除？', '患者来自谁？', '哪个开发负责这个接口？']) {
    assert.equal(mode(q), '', q);
  }
  const text = guard('你好，你是谁？', 'identity');
  assert.match(text, /药师工作站的答疑助手/);
  assert.match(text, /实施、产品和开发之间的桥梁/);
  assert.match(text, /有证据会直接回答，缺现场信息会继续追问，不会瞎猜/);
  assert.match(text, /不要提底层模型/);
});

test('对话性守卫只在命中时注入，允许承接但禁止新增无证据事实', () => {
  assert.equal(guard('接口在哪里', false), '');
  const text = guard('你也太冷漠了吧', true);
  assert.match(text, /不是新增系统事实问题/);
  assert.match(text, /自然、有人情味/);
  assert.match(text, /不得借机新增没有正文证据的具体系统事实/);
  assert.match(text, /不要套用“说明书未覆盖\/建议转工单”/);
  assert.match(text, /下一轮仍须重新按 Spec\/源码证据门判断/);
  const mixed = guard('别这么冷漠，告诉我按钮点哪个', 'mixed');
  assert.match(mixed, /同时包含表达诉求与系统事实问题/);
  assert.match(mixed, /不能随便指错/);
  assert.match(mixed, /不得以“当前资料无法确认”这句固定模板开头/);
});

test('consult 接线：对话性表达不走固定miss，事实题仍保留原证据短路', () => {
  const start = SRC.indexOf("if (url.pathname === '/api/consult'");
  const end = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const route = SRC.slice(start, end);
  assert.match(route, /const conversationMode = consultConversationMode\(qtext\)/);
  assert.match(route, /const noAnswer = !conversationMode && !safeDiagnostic && routeMiss && specNoSpec/);
  assert.match(route, /consultConversationGuard\(qtext, conversationMode\)/);
  assert.match(route, /retrieval\.conversationIntent = !!conversationMode/);
  assert.match(route, /retrieval\.conversationIntentMode = conversationMode/);
  assert.match(route, /if \(noAnswer\)[\s\S]*?说明书里没有找到相关描述/);
});

test('检索回放也标记对话意图，便于诊断事实miss与对话绕行', () => {
  const start = SRC.indexOf("if (url.pathname === '/api/retrieval-replay'");
  const end = SRC.indexOf("if (url.pathname === '/api/retrieval-log'", start);
  const replay = SRC.slice(start, end);
  assert.match(replay, /retrieval\.conversationIntentMode = consultConversationMode\(query\)/);
});

test('实施诊断守卫在 route 命中或缺失时都给安全最小留证，不机械索要 spec', () => {
  const intent = new Function(extractFn(SRC, 'consultSafeDiagnosticIntent') + '\nreturn consultSafeDiagnosticIntent;')();
  const fn = new Function('consultSafeDiagnosticIntent', extractFn(SRC, 'consultDiagnosticGuard') + '\nreturn consultDiagnosticGuard;')(intent);
  assert.equal(fn('患者接口是什么？', { matched: true }), '');
  const text = fn('那页面一个患者都看不到，实施现场先查什么？', { matched: true });
  assert.match(text, /命中的 route 能确认的业务事实/);
  assert.match(text, /作为本轮判断基线/);
  assert.match(text, /不能抹掉 route\/正文此前已确认的系统事实/);
  assert.match(text, /不能因此整体降级成“说明书未覆盖”/);
  assert.match(text, /本轮现场已确认.*仍局部未知/);
  assert.match(text, /2~4 步观察型、非破坏/);
  assert.match(text, /没有请求 \/ 请求失败 \/ 响应正常但页面错误/);
  assert.match(text, /不得编造按钮名、接口路径、字段名、数据库表、状态值/);
  assert.match(text, /不得建议反复提交、重复保存、重试/);
  assert.match(text, /首次加载会一次返回多个分组/);
  assert.match(text, /不能要求每切一个页签都必须发新请求/);
  assert.match(text, /除非正文\/源码\/接口契约明确要求逐页请求/);
  assert.match(text, /各组数量、成员集合.*互斥\/包含关系/);
  assert.match(text, /不得通过点开未读、切换已读、星标、审批或提交.*改变业务状态/);

  for (const q of [
    '我只有一张截图，拿不到 spec，转开发前最少补什么？',
    '先别让我找 spec，这个红色按钮没反应怎么留证？',
    '现场要复现这个问题，最少记录哪些东西？',
  ]) {
    assert.equal(intent(q), true, q);
    const miss = fn(q, { matched: false });
    assert.match(miss, /不能因此只机械索要 spec/);
    assert.match(miss, /先基于当前页面和本次请求完成上述留证/);
  }
  assert.equal(intent('密码最少要几位？'), false, '业务取值中的“最少要”不是现场诊断意图');

  const inherited = fn('接口是通的，返回也是 200，但页面没变化，下一步看哪？', { matched: true, inherited: true });
  assert.match(inherited, /从同会话主题事实账本继承的 route/);
  assert.match(inherited, /只把.*未确认的细节局部标为未知/);
});

test('已核规则应用守卫：先判预期行为，冲突时才收最少证据，route miss 不放松证据门', () => {
  const fn = new Function(extractFn(SRC, 'consultRuleApplicationGuard') + '\nreturn consultRuleApplicationGuard;')();
  assert.equal(fn('这个红色按钮点哪个？', { matched: false }), '', '无证据按钮保持安全门');
  assert.equal(fn('反馈接口路径是什么？', { matched: true }), '', '单纯事实问答无需诊断守卫');
  for (const q of [
    '反馈已经发送了，现场还想改正文，先抓什么？',
    '患教只是暂存，患者端却显示没完成，这正常吗？',
    '老师看得到学员评估，但保存时报非创建人，接下来查什么？',
    '普通刷新后配置还是旧值，我没有数据库权限怎么办？',
  ]) {
    const text = fn(q, { matched: true });
    assert.match(text, /先应用已核规则/);
    assert.match(text, /预期行为/);
    assert.match(text, /与已核规则冲突/);
    assert.match(text, /最少证据/);
    assert.match(text, /条件式结论/);
    assert.match(text, /不得整体回复“当前资料无法确认”/);
    assert.match(text, /只追问一个/);
    assert.match(text, /历史 assistant 自由文本始终不是证据/);
    assert.match(text, /已确认事实必须继续作为判断基线/);
    assert.match(text, /不能因为用户改问排查步骤.*就说“说明书未覆盖”/);
  }

  const inherited = fn('第一步看过了，下一步呢？', { matched: true, inherited: true });
  assert.match(inherited, /从同会话主题事实账本继承/);
});

test('同主题事实账本只继承 route/spec/source，部分现场证据不能抹掉已核事实', () => {
  const intent = new Function(extractFn(SRC, 'consultContextFollowupIntent') + '\nreturn consultContextFollowupIntent;')();
  const fn = new Function('consultContextFollowupIntent', extractFn(SRC, 'consultEvidenceLedgerGuard') + '\nreturn consultEvidenceLedgerGuard;')(intent);
  for (const q of [
    '上午反馈的问题，数据库没权限查，只靠页面还能先排除什么？',
    '目前只能确认请求发出去了，复测还缺什么？',
    '这次仅靠接口响应，先说能确定的部分。',
  ]) {
    const text = fn(q, { matched: true, inherited: true });
    assert.match(text, /同主题已核事实账本/);
    assert.match(text, /历史 assistant 的解释、示例、猜测和假设不进入账本/);
    assert.match(text, /只能继承 route\/spec\/source 证据/);
    assert.match(text, /承接型泛化诊断，只允许沿当前继承 route/);
    assert.match(text, /不得主动引入用户未点名的新业务实体/);
    assert.match(text, /不得列出该相邻实体的接口、字段、表名、按钮或状态/);
    assert.match(text, /先陈述持续有效的已知规则/);
    assert.match(text, /禁止把第③项扩大成“说明书未覆盖整个主题”/);
  }
  assert.equal(fn('患者接口是什么？', { matched: false }), '');
  assert.equal(fn('患者接口是什么？', { matched: true }), '', '非同主题追问不注入账本守卫');
});

test('批处理/同步/调度守卫：观测不直接定故障，补跑须满足副作用前置条件', () => {
  const fn = new Function(extractFn(SRC, 'consultOperationalSafetyGuard') + '\nreturn consultOperationalSafetyGuard;')();
  const route = {
    matched: true,
    inherited: true,
    route: { title: '患者、监控或统计数据长时间不更新' },
    answerFacts: ['PWRS 内部不定时，由外部调度触发。'],
    mustNotConfuse: ['非幂等任务补跑前必须评估重复数据。'],
  };
  for (const q of [
    '监控截图最后成功时间停在三天前，是不是调度停了，直接恢复吗？',
    '同步任务中断了，实施能不能先补跑一次？',
    'ETL 好久没有新增，下一步怎么查？',
    '这个批处理明确是幂等的，现在可以重新触发吗？',
  ]) {
    const text = fn(q, route);
    assert.match(text, /观测与副作用安全边界/);
    assert.match(text, /只是当前观测证据/);
    assert.match(text, /不得据此断言“调度停了”“某平台故障”/);
    assert.match(text, /恢复、重跑、补跑、重新触发、手动执行.*可能有副作用/);
    assert.match(text, /未确认.*幂等或补偿契约、目标时间窗和数据范围、当前运行态、执行 Owner\/授权之前，不得建议直接执行/);
    assert.match(text, /即使用户明确说任务幂等/);
    assert.match(text, /1\. 对照经确认的预期计划.*2\. 只读取得.*3\. 确认任务 Owner.*4\. 再决定升级/);
    assert.match(text, /系统内部不定时、由外部调度触发/);
    assert.match(text, /不得由此外推真实调度平台、频率、任务名、部署位置、错误状态或责任人/);
  }

  assert.equal(fn('这个红色按钮应该点哪个？', { matched: false }), '');
  assert.equal(fn('token 是谁签发的？', { matched: false }), '');
  assert.equal(fn('反馈发送后正文还能改吗？', { matched: true, route: { title: '反馈锁定' }, answerFacts: ['发送后锁定'] }), '');
});

test('下载/导出/附件制品守卫：200、非空与能打开均不充分，须校验签名结构正文', () => {
  const fn = new Function(extractFn(SRC, 'consultFileArtifactGuard') + '\nreturn consultFileArtifactGuard;')();
  const route = {
    matched: true,
    inherited: true,
    route: { title: '导出接口返回 200，但文件为空、损坏或下载不到' },
    answerFacts: ['HTTP 200 不能证明文件有效，必须验证文件本体。'],
    mustNotConfuse: ['响应头不证明文件内容有效。'],
  };
  for (const q of [
    '导出接口 200，文件也非空，能打开就算成功了吗？',
    '附件下载回来其实是 JSON 错误体，该怎么只读验收？',
    '模板文件后缀是 docx，但 magic 对不上怎么办？',
    'PDF 缺 EOF，DOCX 的 zip central directory 损坏，还能算成功吗？',
    '换个账号下载就正常，先看权限范围还是文件本体？',
  ]) {
    const text = fn(q, route);
    assert.match(text, /文件下载\/导出制品的只读验收门/);
    assert.match(text, /HTTP 200、业务 code=0.*长度非零.*能打开.*不能单独证明/);
    assert.match(text, /JSON\/HTML 错误页/);
    assert.match(text, /文件长度大于 0/);
    assert.match(text, /magic\/文件签名与声明扩展名、Content-Type\/MIME 一致/);
    assert.match(text, /PDF.*header、EOF\/xref/);
    assert.match(text, /DOCX\/XLSX\/ZIP.*central directory/);
    assert.match(text, /\[Content_Types\]\.xml、word\/document\.xml/);
    assert.match(text, /\[Content_Types\]\.xml、xl\/workbook\.xml/);
    assert.match(text, /具体格式未知.*不得硬猜/);
    assert.match(text, /同一环境、同一入口、同一筛选条件和同一已有记录/);
    assert.match(text, /不得为了验证而修改权限、模板、业务数据/);
  }
  for (const q of ['token 是谁签发的？', '患者列表从哪个接口取数？', '这个红色按钮点哪个？']) {
    assert.equal(fn(q, { matched: false }), '', q);
  }
});

test('通用非破坏诊断守卫：写操作不能包装成只做一次，四项条件齐备才可受控验证', () => {
  const safeIntent = new Function(extractFn(SRC, 'consultSafeDiagnosticIntent') + '\nreturn consultSafeDiagnosticIntent;')();
  const fn = new Function('consultSafeDiagnosticIntent', extractFn(SRC, 'consultNonDestructiveDiagnosticGuard') + '\nreturn consultNonDestructiveDiagnosticGuard;')(safeIntent);
  const route = {
    matched: true,
    inherited: true,
    route: { title: '方法授权与业务归属' },
    answerFacts: ['当前基本没有方法级权限注解', '具体业务仍可能执行 owner 与院区数据作用域校验'],
    mustNotConfuse: ['token 有效不等于业务归属校验通过'],
  };
  for (const q of [
    '医院报的方法授权与业务归属问题，这一步正常但问题还在，下一个检查点是什么？',
    '能不能新建一条再改删一条，只做一次抓请求？',
    '收费异常用测试数据提交一次验证，之后可以回滚吧？',
    '患教签名和审批状态怎么现场复测？',
    '打开未读记录再切星标，怎么判断筛选有没有生效？',
  ]) {
    const text = fn(q, route);
    assert.match(text, /实施现场诊断默认只读、非破坏/);
    assert.match(text, /新建、修改、删除、保存、提交、完成、审批、签名、切换星标、打开会导致已读/);
    assert.match(text, /“只做一次”“测试数据”“之后能回滚”都不能自动/);
    assert.match(text, /已有正常记录与异常记录、历史日志\/审计、用户刚才已经发生的请求与响应/);
    assert.match(text, /隔离测试环境或专用测试数据/);
    assert.match(text, /明确执行授权/);
    assert.match(text, /回滚\/清理方案/);
    assert.match(text, /幂等性与影响范围/);
    assert.match(text, /任一项没有确认.*升级开发或产品确认/);
    assert.match(text, /方法授权、owner、机构范围或状态规则仍须作为判断基线/);
  }
  const readOnly = fn('刷新页面并切只读页签、查看不会标已读的详情，可以这样验证吗？', route);
  assert.match(readOnly, /刷新、切换已确认是纯前端或只读的页签、查看已确认不会触发已读或业务状态变化的详情/);
  assert.equal(fn('token 是谁签发的？', { matched: true, route: { title: '登录 token' } }), '');
});

test('安全必填上下文守卫：缺身份/租户/院区不得靠历史兼容或默认值猜测补齐', () => {
  const fn = new Function(extractFn(SRC, 'consultCriticalContextGuard') + '\nreturn consultCriticalContextGuard;')();
  const patientRoute = {
    matched: true,
    route: { title: '患者院区身份' },
    answerFacts: [
      '产品身份键固定为 hospitalId + patientId + visitId。',
      '缺少 hospitalId 必须拒绝并提示重新选择医院/院区；历史深链也不得回退。',
    ],
    mustNotConfuse: ['不得回退 token 当前院区、默认院区或 districtCode。'],
  };
  for (const q of [
    '跨院区时一名患者靠哪几个字段才算唯一？',
    '历史收藏链接缺院区还能兼容吗？',
    '少了 hospitalId 能从 token 当前院区补吗？',
    'districtCode 能不能代替 hospitalId？',
  ]) {
    const text = fn(q, patientRoute);
    assert.match(text, /安全必填上下文事实守卫/);
    assert.match(text, /缺失时按证据拒绝或提示回到可信入口重新选择/);
    assert.match(text, /不得自行补充“历史链接会兼容”“系统会自动补齐”/);
    assert.match(text, /token、默认租户\/默认院区、相邻路由字段/);
    assert.match(text, /历史、已覆盖或已废止的旧方案不能补充进当前答案/);
    assert.match(text, /用户没问实现细节时必须直接省略.*具体字段组合/);
    assert.match(text, /禁止用“可能”“为了兼容”等措辞包装成实现事实/);
    assert.match(text, /新 route.*旧身份\/租户事实不得串入/);
  }

  const tenantRoute = {
    matched: true,
    route: { title: '租户上下文' },
    answerFacts: ['tenantId 为必填租户键；缺失时拒绝。'],
    mustNotConfuse: ['不得使用默认租户。'],
  };
  assert.match(fn('旧入口没有 tenantId，自动补当前租户可以吗？', tenantRoute), /安全必填上下文事实守卫/);
  assert.equal(fn('登录 token 是谁签发的？', { matched: true, route: { title: '登录认证' }, answerFacts: ['token 由 usercenter 签发'], mustNotConfuse: [] }), '');
  assert.equal(fn('红色按钮在哪里？', { matched: false }), '');
  assert.match(SRC, /consultCriticalContextGuard\(qtext, route\)/, '运行时模型 system 必须注入安全上下文守卫');
});

test('当前裁决优先守卫：废止历史、遗留接口和账号差异不能覆盖现行事实', () => {
  const fn = new Function(extractFn(SRC, 'consultCurrentRulingGuard') + '\nreturn consultCurrentRulingGuard;')();
  const route = {
    matched: true,
    route: { title: '患者院区身份' },
    answerFacts: ['当前裁决：院区是搜索条件，不是账号授权集合。', '患教旧接口摘要只列 patientId + visitId 不构成 hospitalId 豁免。'],
    mustNotConfuse: ['不得复活已废止的授权院区集合。'],
  };
  for (const q of ['换账号后正常，先看哪边？', '第一步看过了没异常，继续。', '接口是200。']) {
    const text = fn(q, route);
    assert.match(text, /当前裁决优先于废止历史与遗留契约/);
    assert.match(text, /不能作为并列候选/);
    assert.match(text, /换账号后正常、第一步没异常或接口返回 200.*不足以推翻当前裁决/);
  }
  assert.equal(fn('普通排序事实', { matched: true, route: { title: '排序' }, answerFacts: ['升序'] }), '');
  assert.match(SRC, /consultCurrentRulingGuard\(qtext, route\)/);
});

test('单一事实止答守卫：接口/路径/状态码/字段/对象关联/是否题只答直接事实', () => {
  const fn = new Function(extractFn(SRC, 'consultFocusedFactGuard') + '\nreturn consultFocusedFactGuard;')();
  for (const q of [
    '工作台今天日期和星期调用哪个接口？',
    '这个接口路径是什么？',
    '成功状态码是什么？',
    'pwrs_patient.p_id 是 PostgreSQL 原生 uuid 吗？',
    'patient_id 字段是什么类型？',
    'status 的值分别是什么？',
    '这个按钮是否支持只读查看？',
    '自定义表单、字段、选项和填写结果靠什么关联？',
    '订单和收费记录的关联键是什么？',
    '这几个对象之间如何关联？',
  ]) {
    const text = fn(q);
    assert.match(text, /单一事实题止答边界/);
    assert.match(text, /current route 的 answerFacts\/primary section/);
    assert.match(text, /认证\/访问限定与必要固定参数/);
    assert.match(text, /同一主接口只出现一次 method \+ 精确 path/);
    assert.match(text, /同一段直接进入“别搞混\/注意\/结论\/下一步”/);
    assert.match(text, /不得主动扩写同表其它列、本地身份元组、联合键、索引、唯一约束/);
    assert.match(text, /现场排查、原因假设、动作建议/);
  }
  for (const q of [
    '患者请求和响应抓到了，下一步怎么排查？',
    '今天接口为什么和浏览器不一致？',
    '现场怎么验证这个接口？',
    '这个接口是什么，接下来怎么查？',
    '接口是什么？状态码不对怎么处理？',
    '自定义表单关联为什么对不上，现场怎么排查？',
    '删除模板后历史结果怎么处理？',
  ]) assert.equal(fn(q), '', q);
  assert.match(SRC, /consultFocusedFactGuard\(qtext\)/);
});

test('患者请求全局身份守卫：跨 route 强制三元身份，原子字段题不扩写', () => {
  const focused = new Function(extractFn(SRC, 'consultFocusedFactGuard') + '\nreturn consultFocusedFactGuard;')();
  const safeIntent = new Function(extractFn(SRC, 'consultSafeDiagnosticIntent') + '\nreturn consultSafeDiagnosticIntent;')();
  const fn = new Function(
    'consultFocusedFactGuard',
    'consultSafeDiagnosticIntent',
    extractFn(SRC, 'consultPatientIdentityGuard') + '\nreturn consultPatientIdentityGuard;',
  )(focused, safeIntent);
  const routes = [
    { matched: true, route: { title: 'AI 电子药历状态' }, answerFacts: ['状态由患者维度查询'] },
    { matched: true, route: { title: '患者关注归属' }, answerFacts: ['关注记录按人员隔离'] },
    { matched: true, inherited: true, route: { title: 'Pad 药学监护' }, answerFacts: ['列表进入患者监护详情'] },
    { matched: true, route: { title: '患者患教列表' }, answerFacts: ['患教列表可查看已有记录'] },
  ];
  const questions = [
    'AI药历没生成，现场抓什么请求参数排查？',
    '患者关注页面只有状态，没有数据库权限，下一步怎么排查？',
    '这个监护详情数据对不上，实施怎么留证？',
    '患教列表串患者了，接口身份先核什么？',
  ];
  routes.forEach((route, i) => {
    const text = fn(questions[i], route);
    assert.match(text, /患者相关请求的全局三元身份守卫/);
    assert.match(text, /`hospitalId \+ patientId \+ visitId`/);
    assert.match(text, /不能只写 `patientId \+ visitId`/);
    assert.match(text, /`districtCode`.*不能代替 `hospitalId`/);
  });
  assert.equal(fn('pwrs_patient.p_id 是 PostgreSQL 原生 uuid 吗？', routes[0]), '');
  assert.equal(fn('token 是谁签发的？', { matched: true, route: { title: '统一登录' }, answerFacts: ['JWT 验签'] }), '');
  assert.match(SRC, /consultPatientIdentityGuard\(qtext, route\)/);
});

test('精确路径前缀守卫：保留尾斜杠且不扩写相似路径或中间子串', () => {
  const fn = new Function(extractFn(SRC, 'consultExactPathBoundaryGuard') + '\nreturn consultExactPathBoundaryGuard;')();
  const route = {
    matched: true,
    route: { title: 'JWT 免鉴权白名单前缀匹配' },
    answerFacts: ['当前 JwtFilter 使用 startsWith；仅 /comm/、/external、/swagger、/v3/api-docs 匿名放行'],
    mustNotConfuse: ['路径中间包含 comm 不放行'],
  };
  for (const q of [
    '业务路径中间带 comm 会绕过认证吗？',
    '/comm/ 和 /comm 是不是一样？',
    '/community 会不会命中白名单？',
    '现有请求怎么判断是否匹配 allowlist？',
  ]) {
    const text = fn(q, route);
    assert.match(text, /每一个斜杠和路径段都是契约的一部分/);
    assert.match(text, /不得去掉或补上尾斜杠/);
    assert.match(text, /若权威事实是 `\/comm\/`.*不得改写成 `\/comm`/);
    assert.match(text, /`\/community`、路径中间仅包含 `comm`.*均不等价/);
    assert.match(text, /已经发生请求的完整 path/);
    assert.match(text, /证据里没有出现的路径、例外、端点类型或用途一律不要补/);
    assert.match(text, /不得为了说明前缀规则自己构造任何“例如\/示例\/测试路径”/);
    assert.match(text, /只能出现 route\/Spec\/源码已列出的路径字面量.*用户本轮实际提供的 path/);
  }
  assert.equal(fn('患教签名是否必填？', { matched: true, route: { title: '患教签名' } }), '');
});

test('未知动作不得为抓包重做，事实正确也不得委婉追加真实写操作验证', () => {
  const safeIntent = new Function(extractFn(SRC, 'consultSafeDiagnosticIntent') + '\nreturn consultSafeDiagnosticIntent;')();
  const fn = new Function('consultSafeDiagnosticIntent', extractFn(SRC, 'consultNonDestructiveDiagnosticGuard') + '\nreturn consultNonDestructiveDiagnosticGuard;')(safeIntent);
  const route = { matched: true, route: { title: '患教完成与签名' }, answerFacts: ['签名非必填，没有签名也能完成患教'] };
  for (const q of [
    '没有请求，能让现场再点一次抓包吗？',
    'Network 历史没了，下一轮同条件再复现一次就能抓到了吧？',
    '没有写提交，只是重新操作一次看看请求行不行？',
    '让创建人正常点完成验证一下不就行了吗？',
    '这个提交只试试看一次，怎么留证？',
    '审批问题重做一遍复现一下可以吗？',
    '让患者当面点进咨询详情看一下状态行不行？',
  ]) {
    const text = fn(q, route);
    assert.match(text, /“再点一次”“重做一遍”“复现一下”“下一轮”“同条件再复现”“再复现”“重新操作一次”/);
    assert.match(text, /即使句子没出现“提交\/保存”等写入动词/);
    assert.match(text, /即使当前 route 已经确认按钮、角色、状态或业务结果/);
    assert.match(text, /不能顺手追加一次真实完成、提交、签名、审批/);
    assert.match(text, /默认接受“当前无法安全补抓”/);
    assert.match(text, /只有已经明确被重复的动作本身是只读且不会改变任何业务状态/);
    assert.match(text, /打开可能会标记已读、已接收或完成/);
    assert.match(text, /不得要求患者或实施新打开、新点进详情/);
  }
  const readOnly = fn('这个只读列表刷新不会改状态，确认无副作用后可以刷新一次吗？', route);
  assert.match(readOnly, /刷新、切换已确认是纯前端或只读的页签/);
  const controlled = fn('隔离测试环境、专用数据、授权、回滚清理、幂等和影响范围都已确认，能受控测一次吗？', route);
  assert.match(controlled, /隔离测试环境或专用测试数据/);
  assert.match(controlled, /明确执行授权/);
});

test('发布前动作一致性审计覆盖整份答案，禁止同答先劝停又让点未知按钮', () => {
  const safeIntent = new Function(extractFn(SRC, 'consultSafeDiagnosticIntent') + '\nreturn consultSafeDiagnosticIntent;')();
  const fn = new Function('consultSafeDiagnosticIntent', extractFn(SRC, 'consultFinalActionConsistencyGuard') + '\nreturn consultFinalActionConsistencyGuard;')(safeIntent);
  const routes = [
    { matched: true, route: { title: '药师反馈发送后锁定' }, answerFacts: ['发送后不能编辑或删除'] },
    { matched: true, route: { title: '患教完成权限' }, answerFacts: ['只有创建人可以完成'] },
    { matched: true, route: { title: '收费结果核对' }, answerFacts: ['结果未知时禁止重复收费'] },
    { matched: true, route: { title: '记录删除 owner' }, answerFacts: ['删除校验创建人'] },
  ];
  const questions = [
    '上午反馈发送后锁定，我只有截图没有日志，够不够？',
    '编辑和删除按钮到底会不会发请求，能点一下看吗？',
    '患教完成按钮怎么抓包验证？',
    '收费结果不确定，下一步怎么留证？',
  ];
  questions.forEach((q, i) => {
    const text = fn(q, routes[i]);
    assert.match(text, /发布前动作一致性审计/);
    assert.match(text, /Markdown 表格每个单元格、编号步骤、条件分支/);
    assert.match(text, /A\. 读取当前已显示页面、已有请求\/响应、原始报文、已有映射、截图、历史记录、日志或审计/);
    assert.match(text, /不能因为同一答案别处写了“不要操作”“只读”“别重复”/);
    assert.match(text, /否定提醒不能抵消冲突动作/);
    assert.match(text, /不得再建议点击编辑、删除、发送、完成等未知动作来观察是否发请求/);
    assert.match(text, /只问“这个按钮是否发请求”.*不能让现场点击未知按钮补抓/);
    assert.match(text, /不给纯事实回答强加诊断步骤/);
    assert.match(text, /实施、用户、患者、对接方、运维或开发/);
    assert.match(text, /改参数、改报文类型、改映射、改配置/);
    assert.match(text, /让对接方改字符串\/参数\/映射\/配置后用同一患者复测/);
    assert.match(text, /动作换成由第三方执行也不改变副作用/);
    assert.match(text, /表格只定义①②③却在判断或小结写③\/④/);
    assert.match(text, /删除含未定义序号的完整句\/完整表格行/);
    assert.match(text, /声明数量 → 实际内容/);
    assert.match(text, /不得用一行表格冒充“三边对照”/);
    assert.match(text, /不得说“核两件事”却只列一项/);
    assert.match(text, /结构数量不得从 1 漂成 2/);
    assert.match(text, /“例如：\/如下：\/包括：\/包含：\/内容为：\/由以下组成：\/分别为：”后必须有实际内容/);
    assert.match(text, /不得留下孤立的“还是页面…\/或者接口…”等后半分支/);
    assert.match(text, /没有前述主张的“但\/但是\/不过\/然而”转折残句/);
    assert.match(text, /一致\/不一致、是\/否、有\/无、成功\/失败/);
    assert.match(text, /“不要做\/禁止\/避免\/切勿”等否定标题下不得只剩/);
    assert.match(text, /只问“先做哪个验证\/第一步做什么”时，只给一个最小只读验证/);
    assert.match(text, /只剩粗体步骤标题，后面必须有正文或子项/);
    assert.match(text, /行尾逗号、分号或冒号后必须有同句后半段或紧邻正文/);
    assert.match(text, /普通行、粗体行或 Markdown heading 形式的“N\. 步骤标题”/);
    assert.match(text, /水平分隔线不算步骤内容/);
    assert.match(text, /第一句话必须明确回答：现有证据够完成什么、不够完成什么/);
    assert.match(text, /不得退成页面、终端、账号、版本等跨主题通用材料清单/);
    assert.match(text, /若本轮没有可核验附件，不得声称看见截图里的数字或内容/);
    assert.match(text, /诊断结论或分支表使用的每个观测变量/);
    assert.match(text, /不得在最小清单只列接口响应，却在判断表首次引入本机日期/);
    assert.match(text, /A\/B\/C 等单字母、编号或短符号/);
    assert.match(text, /第一次比较之前逐一明确绑定每个符号的含义/);
    assert.match(text, /所有“进入\/回到\/按第 N 步”的引用/);
    assert.match(text, /“N选一\/以下N类”必须紧随实际 N 个选项/);
    assert.match(text, /普通 A\/B 测试、API 缩写与路径不按选项引用处理/);
  });

  const readOnly = fn('这个列表刷新已确认纯只读，可以刷新后看现有数量吗？', { matched: true });
  assert.match(readOnly, /route\/Spec\/源码已经明确证明无副作用的刷新/);
  const controlled = fn('隔离环境、专用数据、授权、回滚清理、幂等和影响范围都齐全，能受控提交一次吗？', { matched: true });
  assert.match(controlled, /隔离环境或专用数据、明确授权、回滚\/清理、幂等性与影响范围全部齐全/);
  assert.equal(fn('p_id 列类型是什么？', { matched: true, route: { title: '字段类型' } }), '', '显式新实体的原子事实题不强塞诊断审计');
});

test('最终证据概率守卫禁止无依据成因排序，并让核心事实题止于证据', () => {
  const fn = new Function(extractFn(SRC, 'consultEvidenceLikelihoodGuard') + '\nreturn consultEvidenceLikelihoodGuard;')();
  const routes = [
    { matched: true, route: { title: '工作台今天视图' }, answerFacts: ['日期来自服务端 JVM 当前时区'] },
    { matched: true, route: { title: '自定义表单关联' }, answerFacts: ['element_id 关联选项和表格列'] },
    { matched: true, route: { title: '患者号字段' }, answerFacts: ['patient_id 是 varchar(50)'] },
  ];
  for (const [q, route] of [
    ['年份或星期不一致，最常见是什么原因？', routes[0]],
    ['element_id 第二步对不上，通常是复制模板吗？', routes[1]],
    ['患者号丢位，大概率是哪边改坏的？', routes[2]],
    ['配置没生效，多半是缓存吧？', { matched: true, route: { title: '配置缓存' } }],
    ['ETL 同步中断，典型原因是什么？', { matched: true, route: { title: 'ETL 同步' } }],
  ]) {
    const text = fn(q, route);
    assert.match(text, /最终证据与概率语言审计/);
    assert.match(text, /Spec 正文、源码、已核经验库或统计样本直接写明频率/);
    assert.match(text, /“最高频”“最常见”“常见\/很常见\/较常见\/比较常见”“经常”“通常”“一般”“大概率”“多半”“往往”“多发\/高发”“很多\/不少\/多数\/大多\/绝大多数”“少数\/极少\/大部分\/小部分\/几乎全部”“首要原因\/主要原因（之一）”“典型原因”“常见于”/);
    assert.match(text, /只能列不排序的“待验证假设\/可能分支”/);
    assert.match(text, /排查顺序只能依据本轮已有页面、请求、响应、原始报文、日志或审计/);
    assert.match(text, /核心事实题或已定位的共享键、字段类型、接口契约答清后立即停止/);
    assert.match(text, /不得追加“改过模板、复制\/重存、历史兼容、行业里经常如此”/);
  }
});

test('发布前确定性语义校验：无证据概率词触发一次修订，有直接样本时不误拦', () => {
  const likelihoodConst = SRC.match(/const CONSULT_LIKELIHOOD_WORD_RE = [^;]+;/)?.[0] || '';
  const causalLocalizationConst = SRC.match(/const CONSULT_CAUSAL_LOCALIZATION_RE = [^;]+;/)?.[0] || '';
  const deterministicFailureConst = SRC.match(/const CONSULT_DETERMINISTIC_FAILURE_RE = [^;]+;/)?.[0] || '';
  const observationOrderConst = SRC.match(/const CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE = [^;]+;/)?.[0] || '';
  const priorityConst = SRC.match(/const CONSULT_CAUSAL_PRIORITY_RE = [^;]+;/)?.[0] || '';
  const directActionConst = SRC.match(/const CONSULT_DIRECT_RISKY_ACTION_RE = [^;]+;/)?.[0] || '';
  const componentFaultConst = SRC.match(/const CONSULT_COMPONENT_FAULT_RE = [^;]+;/)?.[0] || '';
  assert.ok(likelihoodConst && causalLocalizationConst && deterministicFailureConst, '应找到概率、因果定位与确定故障检测常量');
  const audit = new Function(
    likelihoodConst + '\n' + causalLocalizationConst + '\n' + deterministicFailureConst + '\n' + observationOrderConst + '\n' + priorityConst + '\n' + directActionConst + '\n' + componentFaultConst + '\n'
    + extractFn(SRC, 'consultHasLikelihoodEvidence') + '\n'
    + extractFn(SRC, 'consultRouteScopeText') + '\n'
    + extractFn(SRC, 'consultHasCausalPriorityEvidence') + '\n'
    + extractFn(SRC, 'consultUnsupportedComponentClaims') + '\n'
    + extractFn(SRC, 'consultHasControlledActionBundle') + '\n'
    + extractFn(SRC, 'consultConcretePaths') + '\n'
    + extractFn(SRC, 'consultScopeEntityTerms') + '\n'
    + extractFn(SRC, 'consultDiagnosticMechanismTerms') + '\n'
    + extractFn(SRC, 'consultScopeTechnicalTokens') + '\n'
    + extractFn(SRC, 'consultMalformedMarkdownTokens') + '\n'
    + extractFn(SRC, 'consultMalformedProseTokens') + '\n'
    + extractFn(SRC, 'consultMarkdownTableCells') + '\n'
    + extractFn(SRC, 'consultMalformedTableTokens') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeTables') + '\n'
    + extractFn(SRC, 'consultRequiredPrimaryPath') + '\n'
    + extractFn(SRC, 'consultFocusedFactGuard') + '\n'
    + extractFn(SRC, 'consultFocusedFactOverreach') + '\n'
    + extractFn(SRC, 'consultFocusedRelationshipFacts') + '\n'
    + extractFn(SRC, 'consultExplicitOperationContracts') + '\n'
    + extractFn(SRC, 'consultOperationEvidenceStopReply') + '\n'
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + 'return consultAnswerSemanticAudit;',
  )();
  const route = { matched: true, route: { title: '工作台今天视图' }, answerFacts: ['日期来自服务端 JVM 当前时区'] };
  const atomicRoute = {
    matched: true,
    route: { title: '工作台今天视图' },
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week，日期来自服务端 JVM 当前时区'],
    mustNotConfuse: ['不得答已废止的 GET /month/view'],
  };
  const atomicDraft = [
    '结论：调用 GET /pwrsapi/month/view/today，返回 year/week。',
    '不要混淆已废止的 GET /month/view。',
    '现场怎么快速核对：打开工作台，在 Network 里查看请求。',
    '如果接口没调到或鉴权失败，页面就会异常——优先查 token。',
    '需要更细的话，把截图发来再一起看。',
  ].join('\n');
  const atomicAudit = audit(atomicDraft, '工作台今天日期和星期调用哪个接口？', atomicRoute);
  assert.deepEqual(atomicAudit.violations, ['unsupported_likelihood', 'focused_fact_overreach']);
  assert.equal(atomicAudit.focusedFactOverreach.length, 4);
  assert.ok(audit('调用 GET /pwrsapi/month/view/today，返回 year/week；不得混淆已废止的 GET /month/view。', '工作台今天日期和星期调用哪个接口？', atomicRoute).violations.includes('focused_fact_overreach'));
  assert.deepEqual(audit('调用 GET /pwrsapi/month/view/today；不得混淆已废止的 GET /month/view。', '工作台今天日期和星期调用哪个接口？', atomicRoute).violations, []);
  const statementQuestion = '工作台今天的日期和星期，调用的是 GET /pwrsapi/month/view/today（需要合法 JWT）。别跟已经按会议结论删除的 GET /month/view 月历网格接口搞混。';
  const statementDraft = [
    '结论：对。',
    '工作台走 GET /pwrsapi/month/view/today。',
    '无入参。',
    '返回 year/week。',
    '日期按服务端 JVM 当前时区算。',
  ].join('\n');
  const statementAudit = audit(statementDraft, statementQuestion, atomicRoute);
  assert.ok(statementAudit.violations.includes('focused_fact_overreach'), '陈述式确认单一接口同样触发原子止答');
  assert.ok(statementAudit.focusedFactOverreach.includes('无入参。'));
  assert.equal(statementAudit.missingFocusedMustNotConfuse.length, 1, '用户逐字点名易混淆接口时须保留route必要反事实');
  assert.deepEqual(audit('工作台走 GET /pwrsapi/month/view/today。\n不得答已废止的 GET /month/view。', statementQuestion, atomicRoute).violations, []);
  assert.ok(!audit('调用 GET /pwrsapi/month/view/today 后现场怎么核对？', '工作台接口为什么不一致，现场怎么验证？', atomicRoute).violations.includes('focused_fact_overreach'), '显式诊断题不触发原子止答审计');
  const failed = audit('页面等于接口但与浏览器不同，多半是服务端时区差。', '今天视图对不上，怎么排查？', route);
  assert.deepEqual(failed.violations, ['unsupported_likelihood']);
  assert.deepEqual(failed.likelihoodTerms, ['多半']);
  for (const phrase of ['很常见', '较常见', '比较常见', '常见原因', '经常发生', '多发', '高发', '很多是规则内预期', '不少属于时区差', '多数是预期', '大多不是BUG', '绝大多数无需处理', '少数会异常', '极少出错', '大部分符合预期', '小部分对不上', '几乎全部正常', '频繁出现', '偶尔失败', '有时不同', '首要原因', '主要原因之一', '很像服务端缓存', '更像前端取错字段', '可能是异常兜底', '疑似配置问题', '倾向于时区问题', '高度符合服务端时区差', '强烈符合配置问题', '明显符合前端问题', '更符合缓存问题', '较符合网关问题', '比较符合后端问题', '最容易出现', '很容易丢精度', '尤其容易对不上', '午夜附近更容易和浏览器理解对不上', '较容易在跨区环境出现偏差', '比较容易与本机日期不同', '尤其是午夜前后可能与本机不一致', '可能和浏览器本机不一致', '易发生', '很可能就发生在序列化时', '更可能在请求之后', '较可能从网关开始', '比较可能由服务端引起', '超过精度就会直接丢位', '一定会导致字段少位', '必然会出现错误', '肯定会发生变化', '这就是对接方类型传错']) {
    assert.ok(audit(`接口和浏览器不一致${phrase}。`, '今天视图为什么不一致？', route).violations.includes('unsupported_likelihood'), phrase);
  }
  for (const phrase of ['典型现象边界', '典型表现', '典型场景', '典型特征']) {
    assert.ok(audit(`这是服务端时区问题的${phrase}。`, '今天视图为什么不一致？', route).violations.includes('unsupported_likelihood'), phrase);
  }
  for (const phrase of ['尤其接近午夜', '尤其临近零点', '尤其靠近日切边界', '尤其恰逢月末']) {
    assert.ok(audit(`接口与浏览器不一致（${phrase}）。`, '今天视图为什么不一致？', route).violations.includes('unsupported_likelihood'), phrase);
  }
  const q121R65Draft = '不一致且两端时区不同（尤其接近午夜） → 符合“服务端 JVM 时区 vs 浏览器本地”的已知差异，优先核服务器 JVM 时区与系统时间。';
  const q121R65Audit = audit(q121R65Draft, '现在卡在“今天视图显示的年份或星期和浏览器理解不一致”。给我一个能直接照着走的排查顺序。', route);
  assert.ok(q121R65Audit.violations.includes('unsupported_likelihood'), '单次现场差异不能把接近午夜包装成特殊时段倾向');
  assert.ok(q121R65Audit.likelihoodTerms.some(term => term.includes('尤其接近午夜')));
  assert.deepEqual(audit('待验证假设：服务端时区和现场约定不一致；可能分支：页面没有照接口响应展示。', '今天视图为什么不一致？', route).violations, [], '明确标为不排序待验证分支时应放行');
  assert.deepEqual(audit('优先查服务端时区。', '今天视图为什么不一致？', route).violations, ['unsupported_likelihood'], '没有当前差异证据不得排序成因');
  assert.deepEqual(audit('优先怀疑服务端时区。', '今天视图为什么不一致？', route).violations, ['unsupported_likelihood'], '用怀疑/判断包装的成因优先级同样须有当前差异证据');
  assert.deepEqual(audit('页面=接口但与本机不一致，优先查服务端时区。', '现场已确认页面=接口，但与本机不一致。', route).violations, [], '用户已给出直接差异时可据此排查对应层');
  assert.deepEqual(audit('按已核顺序优先查前端展示。', '页面为什么不一致？', { matched: true, route: { title: '展示排查' }, answerFacts: ['说明书明确排查顺序：页面与接口不一致时优先查前端展示'] }).violations, [], 'route明确顺序时放行');
  assert.deepEqual(audit('响应与页面不一致，所以前端展示/缓存异常。', '今天视图不一致，怎么排查？', route).violations, ['unsupported_likelihood', 'unsupported_component_fault', 'out_of_scope_entity'], '答案自己补的条件不能把未核组件故障写成定论或引入未点名机制');
  assert.deepEqual(audit('| 层级 | 结论 |\n| --- | --- |\n| 缓存 | 缓存异常 |\n最后就是前端问题。', '今天视图异常，怎么排查？', route).violations, ['unsupported_component_fault', 'out_of_scope_entity'], '表格和结尾同样进入四类事实与scope审计');
  assert.deepEqual(audit('可能分支：缓存异常，仍待验证。', '今天视图不一致，怎么排查？', route).violations, ['out_of_scope_entity'], '待验证标签也不能引入当前scope未点名的具体技术机制');
  assert.deepEqual(audit('已确认是缓存异常。', '现场日志已经确认缓存异常，下一步怎么留证？', route).violations, [], '用户已给直接故障证据可照实承接');
  assert.deepEqual(audit('前端展示异常已由审计确认。', '今天视图不一致，怎么排查？', { matched: true, route: { title: '展示排查' }, answerFacts: ['已确认前端展示异常'] }).violations, [], 'route已核故障事实可照实承接');

  const userSample = audit('基于你给的样本，最常见的是服务端时区差。', '最近统计100次，其中80次确认是服务端时区差。', route);
  assert.deepEqual(userSample.violations, []);
  assert.equal(userSample.likelihoodAllowed, true);
  const routedSample = audit('最常见的是服务端时区差。', '按权威统计怎么说？', {
    matched: true,
    route: { title: '时区统计' },
    answerFacts: ['统计样本明确写明：服务端时区差是最常见原因'],
  });
  assert.deepEqual(routedSample.violations, []);
  const unrelatedRouteStats = audit('服务端时区差是最常见原因。', '今天视图为什么不一致？', {
    matched: true,
    route: { title: '今天视图混合统计' },
    answerFacts: ['权限问题占比 80%', '日期来自服务端 JVM 当前时区'],
  });
  assert.deepEqual(unrelatedRouteStats.violations, ['unsupported_likelihood'], 'route 里其它主题的统计事实不能给当前概率 claim 全局开绿灯');
  assert.deepEqual(unrelatedRouteStats.unsupportedLikelihoodClaims, ['服务端时区差是最常见原因。']);
  const mixedRouteStats = audit('权限问题占比 80%。服务端时区差是最常见原因。', '按当前已核统计分别怎么说？', {
    matched: true,
    route: { title: '混合统计' },
    answerFacts: ['统计样本写明：权限问题占比 80%', '日期来自服务端 JVM 当前时区'],
  });
  assert.deepEqual(mixedRouteStats.violations, ['unsupported_likelihood'], '同一答案只允许有直接证据的概率句，另一句仍须拦截');
  assert.deepEqual(mixedRouteStats.unsupportedLikelihoodClaims, ['服务端时区差是最常见原因。']);
  assert.deepEqual(audit('绝大多数属于服务端时区差。', '按权威比例怎么说？', {
    matched: true,
    route: { title: '时区统计' },
    answerFacts: ['统计样本明确写明：绝大多数属于服务端时区差'],
  }).violations, [], 'route 有直接统计比例证据时可照实使用模糊比例词');
  assert.deepEqual(audit('这个现象高度符合服务端时区差。', '按权威结论怎么说？', {
    matched: true,
    route: { title: '时区结论' },
    answerFacts: ['说明书明确写明：这个现象高度符合服务端时区差'],
  }).violations, [], 'route 对同一 claim 明确给出倾向结论时可照实引用');
  assert.deepEqual(audit('这是服务端时区问题的典型表现。', '按权威结论怎么说？', {
    matched: true,
    route: { title: '时区结论' },
    answerFacts: ['统计样本明确写明：这是服务端时区问题的典型表现'],
  }).violations, [], 'route 对同一 claim 明确给出典型性时可照实引用');
  const namedField = audit('说明书称它是常见字段名。', '这个字段叫什么？', {
    matched: true,
    route: { title: '字段命名' },
    answerFacts: ['字段正文明确写明：patient_id 是常见字段名'],
  });
  assert.deepEqual(namedField.violations, [], '正文明确命名时允许照实引用“常见字段名”');
  assert.deepEqual(audit('这是一个可能分支，尚待验证。', '今天视图为什么不一致？', route).violations, [], '不排序的“可能分支”标签本身不是概率定论');
  assert.deepEqual(audit('这与已核规则一致。', '今天视图为什么不一致？', route).violations, [], '不带倾向程度的事实一致性描述不应误拦');
  assert.deepEqual(audit('这段说明很容易理解。', '请解释这段说明。', route).violations, [], '非故障结果的日常“容易理解”不应误拦');
  assert.deepEqual(audit('午夜附近更容易和浏览器理解对不上。', '按已核时段统计怎么说？', {
    matched: true,
    route: { title: '已核时段统计' },
    answerFacts: ['统计样本明确写明：午夜附近更容易和浏览器理解对不上'],
  }).violations, [], 'route 对同一时段概率 claim 有直接样本时应放行');
  assert.deepEqual(audit('尤其接近午夜时更容易和浏览器理解对不上。', '按已核时段统计怎么说？', {
    matched: true,
    route: { title: '已核时段统计' },
    answerFacts: ['统计样本明确写明：尤其接近午夜时更容易和浏览器理解对不上'],
  }).violations, [], 'route 对同一敏感时点 claim 有直接统计时可照实引用');
  assert.deepEqual(audit('缺 hospitalId 就会拒绝该请求。', '缺 hospitalId 会怎样？', {
    matched: true,
    route: { title: '患者身份边界' },
    answerFacts: ['规则明确：缺 hospitalId 时必须拒绝该请求'],
  }).violations, [], 'route 直接支持的确定因果规则应照实放行');
});

test('发布前确定性语义校验：跨主体副作用触发，否定句和完整受控条件不误拦', () => {
  const likelihoodConst = SRC.match(/const CONSULT_LIKELIHOOD_WORD_RE = [^;]+;/)?.[0] || '';
  const causalLocalizationConst = SRC.match(/const CONSULT_CAUSAL_LOCALIZATION_RE = [^;]+;/)?.[0] || '';
  const deterministicFailureConst = SRC.match(/const CONSULT_DETERMINISTIC_FAILURE_RE = [^;]+;/)?.[0] || '';
  const observationOrderConst = SRC.match(/const CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE = [^;]+;/)?.[0] || '';
  const priorityConst = SRC.match(/const CONSULT_CAUSAL_PRIORITY_RE = [^;]+;/)?.[0] || '';
  const directActionConst = SRC.match(/const CONSULT_DIRECT_RISKY_ACTION_RE = [^;]+;/)?.[0] || '';
  const componentFaultConst = SRC.match(/const CONSULT_COMPONENT_FAULT_RE = [^;]+;/)?.[0] || '';
  const audit = new Function(
    likelihoodConst + '\n' + causalLocalizationConst + '\n' + deterministicFailureConst + '\n' + observationOrderConst + '\n' + priorityConst + '\n' + directActionConst + '\n' + componentFaultConst + '\n'
    + extractFn(SRC, 'consultHasLikelihoodEvidence') + '\n'
    + extractFn(SRC, 'consultRouteScopeText') + '\n'
    + extractFn(SRC, 'consultHasCausalPriorityEvidence') + '\n'
    + extractFn(SRC, 'consultUnsupportedComponentClaims') + '\n'
    + extractFn(SRC, 'consultHasControlledActionBundle') + '\n'
    + extractFn(SRC, 'consultConcretePaths') + '\n'
    + extractFn(SRC, 'consultScopeEntityTerms') + '\n'
    + extractFn(SRC, 'consultDiagnosticMechanismTerms') + '\n'
    + extractFn(SRC, 'consultScopeTechnicalTokens') + '\n'
    + extractFn(SRC, 'consultMalformedMarkdownTokens') + '\n'
    + extractFn(SRC, 'consultMalformedProseTokens') + '\n'
    + extractFn(SRC, 'consultMarkdownTableCells') + '\n'
    + extractFn(SRC, 'consultMalformedTableTokens') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeTables') + '\n'
    + extractFn(SRC, 'consultRequiredPrimaryPath') + '\n'
    + extractFn(SRC, 'consultFocusedFactGuard') + '\n'
    + extractFn(SRC, 'consultFocusedFactOverreach') + '\n'
    + extractFn(SRC, 'consultFocusedRelationshipFacts') + '\n'
    + extractFn(SRC, 'consultExplicitOperationContracts') + '\n'
    + extractFn(SRC, 'consultOperationEvidenceStopReply') + '\n'
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + 'return consultAnswerSemanticAudit;',
  )();
  const route = { matched: true, route: { title: '患者号字段' }, answerFacts: ['patient_id 是 varchar(50)'] };
  const failed = audit('让对接方把参数改成字符串，再用同一患者复测一次。', '患者号丢位，下一步呢？', route);
  assert.deepEqual(failed.violations, ['cross_actor_side_effect']);
  assert.equal(failed.unsafeActorActionCount, 1);
  assert.deepEqual(audit('确认服务器时区不对后，转运维/开发按部署规范改时区。', '今天视图和浏览器不一致，怎么处理？', route).violations, ['cross_actor_side_effect']);
  assert.deepEqual(audit('JVM 时区错了，或服务器时间漂移，由运维按规范改服务端时区/对时（不在实施侧乱改前端）。改完后再看接口。', '今天视图和浏览器不一致，怎么处理？', route).violations, ['cross_actor_side_effect'], '句尾否定别的动作不能抵消前面的运维修改');
  const directUnsafe = audit('要统一体验只能改部署时区或产品口径。', '今天视图和浏览器不一致，怎么排查？', route);
  assert.deepEqual(directUnsafe.violations, ['cross_actor_side_effect'], '不写执行主体也不能把配置/时区/口径修改包装成诊断结论');
  assert.equal(directUnsafe.unsafeDirectActionCount, 1);
  assert.deepEqual(audit('优先对齐服务端时区与业务日切要求。', '今天视图和浏览器不一致，怎么排查？', route).violations, ['cross_actor_side_effect'], '对齐配置/时区/业务日切仍是副作用动作');
  assert.deepEqual(audit('请运维校准系统时间并统一业务口径。', '今天视图和浏览器不一致，怎么排查？', route).violations, ['cross_actor_side_effect'], '跨主体校准/统一口径不能绕过动作门');
  assert.deepEqual(audit('如果报文里是数字，就是对接方类型传错了，改成字符串再传。', '患者号丢位，下一步怎么查？', route).violations.sort(), ['cross_actor_side_effect', 'unsupported_likelihood'].sort(), '确定性归因与改类型再传必须同时被终稿审计拦截');
  assert.deepEqual(audit('不要改成字符串再传，只核已有原始报文。', '患者号丢位，下一步怎么查？', route).violations, [], '否定副作用动作且回到已有报文不应误拦');
  assert.deepEqual(audit('把已有接口响应与页面显示并排对齐核对。', '今天视图和浏览器不一致，怎么排查？', route).violations, [], '只读对照已有请求与页面不按配置修改误拦');
  assert.deepEqual(audit('不得让运维重跑，也不能让开发重试。', '同步中断，能不能让运维重跑或开发重试？', route).violations, []);
  assert.deepEqual(audit('规范正文说明该设置可以修改。', '这个设置是否支持修改？', { matched: true, route: { title: '设置能力' }, answerFacts: ['该设置支持修改'] }).violations, [], '核心能力事实题不强塞诊断动作门');
  assert.deepEqual(audit(
    '在已确认条件下，可让对接方受控改参数后单次复测。',
    '隔离测试环境、专用测试数据、明确授权、回滚清理、幂等性和影响范围都已确认。',
    route,
  ).violations, []);
  assert.deepEqual(audit(
    '在已确认条件下，可以受控修改配置一次并按清理方案恢复。',
    '隔离测试环境、专用测试数据、明确授权、回滚清理、幂等性和影响范围都已确认，怎么受控验证？',
    route,
  ).violations, [], '完整受控条件放行不带执行主体的条件式动作');
});

test('二次修订失败时安全降级：删违规句、保留已核事实并追加边界', () => {
  const likelihoodConst = SRC.match(/const CONSULT_LIKELIHOOD_WORD_RE = [^;]+;/)?.[0] || '';
  const causalLocalizationConst = SRC.match(/const CONSULT_CAUSAL_LOCALIZATION_RE = [^;]+;/)?.[0] || '';
  const deterministicFailureConst = SRC.match(/const CONSULT_DETERMINISTIC_FAILURE_RE = [^;]+;/)?.[0] || '';
  const observationOrderConst = SRC.match(/const CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE = [^;]+;/)?.[0] || '';
  const priorityConst = SRC.match(/const CONSULT_CAUSAL_PRIORITY_RE = [^;]+;/)?.[0] || '';
  const directActionConst = SRC.match(/const CONSULT_DIRECT_RISKY_ACTION_RE = [^;]+;/)?.[0] || '';
  const componentFaultConst = SRC.match(/const CONSULT_COMPONENT_FAULT_RE = [^;]+;/)?.[0] || '';
  const bundle = new Function(
    likelihoodConst + '\n' + causalLocalizationConst + '\n' + deterministicFailureConst + '\n' + observationOrderConst + '\n' + priorityConst + '\n' + directActionConst + '\n' + componentFaultConst + '\n'
    + extractFn(SRC, 'consultHasLikelihoodEvidence') + '\n'
    + extractFn(SRC, 'consultRouteScopeText') + '\n'
    + extractFn(SRC, 'consultHasCausalPriorityEvidence') + '\n'
    + extractFn(SRC, 'consultUnsupportedComponentClaims') + '\n'
    + extractFn(SRC, 'consultHasControlledActionBundle') + '\n'
    + extractFn(SRC, 'consultConcretePaths') + '\n'
    + extractFn(SRC, 'consultScopeEntityTerms') + '\n'
    + extractFn(SRC, 'consultDiagnosticMechanismTerms') + '\n'
    + extractFn(SRC, 'consultScopeTechnicalTokens') + '\n'
    + extractFn(SRC, 'consultMalformedMarkdownTokens') + '\n'
    + extractFn(SRC, 'consultMalformedProseTokens') + '\n'
    + extractFn(SRC, 'consultMarkdownTableCells') + '\n'
    + extractFn(SRC, 'consultMalformedTableTokens') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeTables') + '\n'
    + extractFn(SRC, 'consultRequiredPrimaryPath') + '\n'
    + extractFn(SRC, 'consultFocusedFactGuard') + '\n'
    + extractFn(SRC, 'consultFocusedFactOverreach') + '\n'
    + extractFn(SRC, 'consultFocusedRelationshipFacts') + '\n'
    + extractFn(SRC, 'consultExplicitOperationContracts') + '\n'
    + extractFn(SRC, 'consultOperationEvidenceStopReply') + '\n'
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + extractFn(SRC, 'consultAnswerRevisionPrompt') + '\n'
    + extractFn(SRC, 'consultReplaceUnexpectedPath') + '\n'
    + extractFn(SRC, 'consultDeduplicateFocusedAtomicAnswer') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeMarkdown') + '\n'
    + extractFn(SRC, 'consultAnswerSafeFallback') + '\n'
    + extractFn(SRC, 'consultVerifiedFactsFallback') + '\n'
    + extractFn(SRC, 'routeHasDirectOperationEvidence') + '\n'
    + extractFn(SRC, 'consultMatchedOperationFailureFallback') + '\n'
    + extractFn(SRC, 'consultModelErrorInfo') + '\n'
    + extractFn(SRC, 'consultSafeDiagnosticIntent') + '\n'
    + extractFn(SRC, 'consultModelFailureFallback') + '\n'
    + extractFn(SRC, 'consultRecoverSafeDiagnostic') + '\n'
    + 'return { audit:consultAnswerSemanticAudit, revision:consultAnswerRevisionPrompt, fallback:consultAnswerSafeFallback, verifiedFallback:consultVerifiedFactsFallback, modelErrorInfo:consultModelErrorInfo, modelFailureFallback:consultModelFailureFallback, recoverSafeDiagnostic:consultRecoverSafeDiagnostic };',
  )();
  const auditAiInterfaceQuestion = 'AI 审方开始生成和停止生成分别调用哪个接口？请只给出两个 HTTP 方法与完整路径，并说明停止接口的 generateId 放在哪里。';
  const auditAiInterfaceRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-FAQ-01-AI', title: 'AI 审方生成和停止接口', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '开始生成调用 POST /comm/ai/generate。',
      '停止生成调用 POST /ai/generate/stop?generateId={id}，其中 generateId 必须放在停止接口的 query 参数中。',
    ],
    mustNotConfuse: ['不得输出 POST /external。'],
  };
  const auditAiInterfaceFallback = bundle.verifiedFallback(auditAiInterfaceQuestion, auditAiInterfaceRoute);
  assert.ok(auditAiInterfaceFallback, '生产第351题的 verifiedFacts 确定性终稿应可发布');
  assert.deepEqual(auditAiInterfaceFallback.finalAudit.violations, []);
  assert.match(auditAiInterfaceFallback.reply, /POST \/comm\/ai\/generate/);
  assert.match(auditAiInterfaceFallback.reply, /POST \/ai\/generate\/stop\?generateId=\{id\}/);
  assert.doesNotMatch(auditAiInterfaceFallback.reply, /POST \/external/);
  assert.deepEqual(bundle.audit('**业务结论**\n- 开始生成调用 POST /comm/ai/generate。\n__实施口径__\n- 停止生成调用 POST /ai/generate/stop?generateId={id}，其中 generateId 必须放在停止接口的 query 参数中。', auditAiInterfaceQuestion, auditAiInterfaceRoute).violations, [], 'Markdown 包裹的系统标题不应被原子接口审计误杀');
  const unrelatedHeadingAudit = bundle.audit('更多说明\n- 开始生成调用 POST /comm/ai/generate。\n- 停止生成调用 POST /ai/generate/stop?generateId={id}，其中 generateId 必须放在停止接口的 query 参数中。', auditAiInterfaceQuestion, auditAiInterfaceRoute);
  assert.ok(unrelatedHeadingAudit.violations.includes('focused_fact_overreach'));
  assert.ok(unrelatedHeadingAudit.focusedFactOverreach.includes('更多说明'), '其它无路径标题仍须拦截');
  const q354Question = '产品准备验收“审核问题统计”功能。现在页面能打开，是否就能承诺已经接入真实后端数据？请用产品和实施能看懂的方式说明当前实际状态与验收边界，不要展开 HIS、AI 或 Redis。';
  const q354Route = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-FAQ-01', title: '审核问题统计', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '当前实际状态：审核问题统计只有可打开的前端页面、筛选项和表格骨架；查询逻辑固定为空列表，当前后端未确认问题统计接口，因此不能承诺已接入真实后端数据。',
      '验收边界：页面能打开、筛选项可见或表格为空，都不能证明真实查询已接通；当前只能验收页面骨架，不能验收真实统计数据能力。',
    ],
  };
  const q354Fallback = bundle.verifiedFallback(q354Question, q354Route);
  assert.ok(q354Fallback, JSON.stringify(bundle.audit(bundle.fallback('', bundle.audit('', q354Question, q354Route)), q354Question, q354Route)));
  assert.deepEqual(q354Fallback.finalAudit.violations, []);
  assert.match(q354Fallback.reply, /固定为空列表/);
  assert.match(q354Fallback.reply, /当前只能验收页面骨架/);
  assert.doesNotMatch(q354Fallback.reply, /HIS|AI|Redis/);
  const q354ExpandedAudit = bundle.audit(`${q354Fallback.reply}\n- 建议打开页面，在 Network 中抓包确认接口。`, q354Question, q354Route);
  assert.ok(q354ExpandedAudit.violations.includes('focused_fact_overreach'), '未经 route 证据的打开页面排查扩写仍须拦截');
  const q354LikelihoodAudit = bundle.audit(`${q354Fallback.reply}\n- 这类空表格大概率是后端接口配置错误。`, q354Question, q354Route);
  assert.ok(q354LikelihoodAudit.violations.includes('unsupported_likelihood'), '未经 route 证据的概率判断仍须拦截');
  const q354RootCauseAudit = bundle.audit(`${q354Fallback.reply}\n- 当前问题属于后端服务故障。`, q354Question, q354Route);
  assert.ok(q354RootCauseAudit.violations.includes('unsupported_likelihood'), '未经 route 证据的确定根因仍须拦截');
  const route = { matched: true, route: { title: '患者号字段' }, answerFacts: ['patient_id 是 varchar(50)'] };
  const draft = 'patient_id 是 varchar(50)。长号丢位多半是对接方按数字传。让对接方改成字符串后复测。';
  const first = bundle.audit(draft, '患者号丢位怎么查？', route);
  const prompt = bundle.revision(draft, first);
  assert.match(prompt, /只允许修订一次/);
  assert.match(prompt, /不要增加任何新业务事实/);
  const fallback = bundle.fallback(draft, first);
  assert.match(fallback, /patient_id 是 varchar\(50\)/);
  assert.doesNotMatch(fallback, /多半|让对接方改成字符串后复测/);
  assert.match(fallback, /不支持对原因作频率排序/);
  assert.match(fallback, /未满足完整受控条件/);
  assert.deepEqual(bundle.audit(fallback, '患者号丢位怎么查？', route).violations, []);

  const productDraft = '医嘱标记用于形成药师质控清单。具体由 OrderMarkService.java 和 IptCollectMapper 处理，字段是 iptTaskId。';
  const productQuestion = '医嘱标记现在是怎么实现的？';
  const productAudit = bundle.audit(productDraft, productQuestion, { matched: true, answerFacts: ['医嘱标记用于形成药师质控清单。', 'OrderMarkService.java 与 IptCollectMapper 实现，字段 iptTaskId。'] });
  assert.ok(productAudit.violations.includes('audience_technical_overreach'));
  assert.match(bundle.revision(productDraft, productAudit), /本轮是产品\/业务问法/);
  const productFallback = bundle.fallback(productDraft, productAudit);
  assert.match(productFallback, /医嘱标记用于形成药师质控清单/);
  assert.doesNotMatch(productFallback, /OrderMarkService|IptCollectMapper|iptTaskId/);
  assert.deepEqual(bundle.audit(productFallback, productQuestion, { matched: true, answerFacts: ['医嘱标记用于形成药师质控清单。'] }).violations, []);

  const implementationQuestion = '现场复测标记失败，怎么排查和留证？';
  const implementationRoute = { matched: true, answerFacts: ['研发依据为 OrderMarkService 和 IptCollectMapper，字段 iptTaskId。'] };
  const implementationDraft = 'OrderMarkService 通过 IptCollectMapper 读取字段 iptTaskId。\n业务上先确认标记是否进入质控清单。';
  const implementationAudit = bundle.audit(implementationDraft, implementationQuestion, implementationRoute);
  assert.ok(implementationAudit.violations.includes('audience_technical_first'));
  assert.ok(implementationAudit.violations.includes('audience_technical_not_last'));
  assert.match(bundle.revision(implementationDraft, implementationAudit), /文末简短“研发参考”/);
  const implementationFallback = bundle.fallback(implementationDraft, implementationAudit);
  assert.match(implementationFallback, /^业务上先确认标记是否进入质控清单/m);
  assert.match(implementationFallback, /研发参考[\s\S]*OrderMarkService[\s\S]*IptCollectMapper/);
  assert.deepEqual(bundle.audit(implementationFallback, implementationQuestion, implementationRoute).violations, [], '实施 fallback 必须把技术细节末置后再审全绿');

  const implementationDump = '现场先看数据。研发参考：ipt_collect_id、collect_title、institute_id、hospital_id、patient_id、event_no、dept_id、ward_id、order_doc_id、pharmacist_id、ipt_task_id。';
  assert.ok(bundle.audit(implementationDump, implementationQuestion, implementationRoute).violations.includes('audience_technical_dump'), '实施题即使将字段表放到研发参考，未点名字段时连续 >8 个技术 token 仍须收缩');

  const q0010Question = '我没完全听懂医嘱标记的排查建议，换成实施可以逐项照做的只读清单。';
  const q0010Route = {
    matched: true,
    inherited: true,
    route: { id: 'AUD-QR-MK-02', title: '医嘱标记' },
    answerFacts: [
      '住院医嘱标记供药师在住院医嘱详情添加或取消标记，并在标记列表查看、筛选和导出；门诊标记归 MK-01，标签标题维护归 MK-03。',
      '标记链路的四个主接口是列表 GET /auditapi/audit/ipt/collects、新增 POST /auditapi/audit/ipt/task/collect、取消 DELETE /auditapi/audit/ipt/collect、导出 GET /auditapi/comm/ipt/collects/excel。',
      '标记记录写 audit_ipt_collect；列表只读 deleted=false，取消更新 deleted=1，不物理删除。',
      '新增标记读取审方服务已有住院任务、患者和医嘱记录；列表通过用户中心 getHospitalInfoByHospitalId 补医院/机构名称，添加标记方法未直接调用 HIS。',
      '现场排查先读取现有列表、详情、请求、响应和记录；新增与取消会改标记数据，未经授权不得为抓包重做。',
    ],
    mustNotConfuse: ['正文中的 NEEDS-HUMAN、未实现 Target、菜单标签或 Java Model 推测不得写成当前已确认行为。'],
  };
  const q0010Draft = '这类问题通常是接口或数据库异常。OrderMarkService 通过 IptCollectMapper 处理，让实施再点一次新增后核对。';
  const q0010Initial = bundle.audit(q0010Draft, q0010Question, {
    ...q0010Route,
    inheritedFromQuestion: '把医嘱标记从入口、接口或数据到外部依赖串起来。',
  });
  assert.ok(q0010Initial.violations.includes('unsupported_likelihood'));
  assert.ok(q0010Initial.violations.includes('audience_technical_not_last'));
  assert.ok(q0010Initial.violations.includes('cross_actor_side_effect'));
  assert.ok(!q0010Initial.violations.includes('incomplete_requested_chain'), '实施重述只继承 route 事实，不继承上一轮研发链路的回答形态');
  assert.equal(q0010Initial.chainRequested, false);
  assert.match(q0010Initial.safeDiagnosticFallback, /最小只读排查/);
  assert.match(q0010Initial.safeDiagnosticFallback, /1\. 原样记录当前页面/);
  assert.match(q0010Initial.safeDiagnosticFallback, /4\. 整理上述原文与脱敏截图/);
  assert.doesNotMatch(q0010Initial.safeDiagnosticFallback, /重做|新增或取消一次/);
  assert.deepEqual(bundle.audit(q0010Initial.safeDiagnosticFallback, q0010Question, q0010Route).violations, [], 'Q0010 确定性兜底必须是可发布的实施只读清单，不能退成安全停止');
  const q0010VerifiedRoute = {
    ...q0010Route,
    fallbackMode: 'verifiedFacts',
    route: { ...q0010Route.route, fallbackMode: 'verifiedFacts' },
  };
  const q0010VerifiedInitial = bundle.audit(q0010Draft, q0010Question, q0010VerifiedRoute);
  const q0010Fallback = bundle.fallback(q0010Draft, q0010VerifiedInitial);
  assert.equal(q0010VerifiedInitial.fallbackAnswerMode, 'field_diagnostic', '同主题实施追问应选择只读清单形态');
  assert.match(q0010Fallback, /最小只读排查/);
  assert.match(q0010Fallback, /1\. 原样记录当前页面/);
  assert.match(q0010Fallback, /4\. 整理上述原文与脱敏截图/);
  assert.doesNotMatch(q0010Fallback, /让实施再点一次新增/);
  assert.deepEqual(bundle.audit(q0010Fallback, q0010Question, q0010VerifiedRoute).violations, [], 'Q0010 verifiedFacts fallback 必须发布只读清单并终审全绿');

  const aiBroadQuestion = 'AI 审方涉及哪些接口、数据和边界？';
  const aiBroadFact = 'AI 审方按 audit 场景读取当前门诊或住院任务上下文，结果须由药师主动采纳。';
  const aiBroadRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-AI-01', title: 'AI 审方生成', fallbackMode: 'verifiedFacts' },
    answerFacts: [aiBroadFact],
  };
  const aiBroadInitial = bundle.audit(aiBroadFact, aiBroadQuestion, aiBroadRoute);
  assert.equal(aiBroadInitial.fallbackAnswerMode, 'facts_with_unknowns', '单事实覆盖不了多维技术问法时必须显式进入未知边界');
  assert.ok(aiBroadInitial.violations.includes('incomplete_verified_facts'));
  const aiBroadFallback = bundle.fallback(aiBroadFact, aiBroadInitial);
  assert.match(aiBroadFallback, /业务结论\n- AI 审方按 audit 场景/);
  assert.match(aiBroadFallback, /本轮未知/);
  assert.match(aiBroadFallback, /接口.*数据.*边界/);
  assert.doesNotMatch(aiBroadFallback, /POST\s+\/|建议调用|请修改/);
  assert.deepEqual(bundle.audit(aiBroadFallback, aiBroadQuestion, aiBroadRoute).violations, [], 'AI-01 单事实宽问法需明确停在已核事实并终审全绿');
  for (const [questionId, question] of [
    ['Q0002', 'AI 审方涉及哪些接口、数据和边界？'],
    ['Q0007', 'AI 审方的接口、数据来源和边界是什么？'],
    ['Q0012', '请说明 AI 审方包含哪些接口、数据和边界。'],
  ]) {
    const initial = bundle.audit(aiBroadFact, question, aiBroadRoute);
    assert.equal(initial.fallbackAnswerMode, 'facts_with_unknowns', `${questionId} 应识别为多维事实问法`);
    assert.ok(initial.violations.includes('incomplete_verified_facts'), `${questionId} 不能只回一条业务结论`);
    const fallback = bundle.fallback(aiBroadFact, initial);
    assert.match(fallback, /本轮未知/);
    assert.deepEqual(bundle.audit(fallback, question, aiBroadRoute).violations, [], `${questionId} fallback 终审应全绿`);
  }

  const q0011Question = '住院医嘱审核现在是怎么实现的？';
  const q0011Fact = '住院审核工作台读取当前或待审医嘱任务，并提供通过、打回、签名、移交、挂起、收藏和历史查询操作。';
  const q0011Route = {
    matched: true,
    route: { id: 'AUD-QR-WB-03', title: '住院医嘱审核' },
    answerFacts: [q0011Fact],
    directEvidenceFacts: ['NEEDS-HUMAN：其它终端是否提供同组操作仍待确认。'],
    mustNotConfuse: ['正文中的 NEEDS-HUMAN、未实现 Target、菜单标签或 Java Model 推测不得写成当前已确认行为。'],
  };
  const q0011Audit = bundle.audit(`${q0011Fact}\n医生也可以完成同样操作。`, q0011Question, q0011Route);
  assert.equal(q0011Audit.audienceMode, 'product');
  assert.equal(q0011Audit.chainRequested, false);
  assert.deepEqual(q0011Audit.missingChainDimensions, [], '非链路产品题即使 route 含明确 gap，也不得制造未知停点完整性要求');
  assert.ok(!q0011Audit.violations.includes('incomplete_requested_chain'));
  assert.ok(q0011Audit.violations.includes('out_of_scope_entity'), '相邻医生端事实仍须由作用域门清理');
  const q0011Fallback = bundle.fallback(`${q0011Fact}\n医生也可以完成同样操作。`, q0011Audit);
  assert.equal(q0011Fallback, q0011Fact, 'Q0011 fallback 只保留产品 As-built，不追加未知停点或技术说明');
  assert.deepEqual(bundle.audit(q0011Fallback, q0011Question, q0011Route).violations, []);

  const q0054Question = '一组住院医嘱被审方判定为自动通过后，后台会保存哪些业务资料？除患者、诊断、过敏和普通医嘱外，警示、审核提交、自动通过结果、手术、生命体征、检验、草药方及明细会不会一起保存？这是药师页面能触发的吗，每次处理多少条？同一条消息重复投递时哪些数据会更新、哪些仍可能重复主键失败；某一类表写失败会不会整批回滚和自动重试？如果队列头是坏 JSON 会丢弃、跳过还是持续堵住？请按业务和实施口径说明。';
  const q0054Route = {
    matched: true,
    route: { id: 'AUD-QR-DI-04', title: '住院处方数据采集落库', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '住院自动通过后会完整保存患者、诊断、过敏、普通医嘱、医嘱警示、审核提交、自动通过任务、手术、生命体征、检验报告/明细、草药方/明细；这不是药师页面可触发的功能。',
      '后台线程消费 AUDIT:IPT:AUTO 队列，每批最多处理 10 条消息。',
      'PostgreSQL 下患者、诊断、过敏、普通医嘱、警示、提交、手术、生命体征、检验报告/明细按冲突键更新；普通医嘱冲突仅更新药名，警示冲突也仅更新药名，提交仅更新患者名。自动通过任务、草药方、草药明细使用普通 INSERT，重复主键可失败，不保证整包幂等。',
      '各类别不在一个总事务内；失败类写 audit_sync_error_flow 后继续，已成功数据不回滚。方法正常返回后原批次仍裁掉，失败类不自动留队重试。坏 JSON 会在写库前令整批失败且不执行 LTRIM，不丢弃、不跳过，会持续堵住后续消息。未经授权不得改队列、重放消息或改业务数据。',
    ],
    mustNotConfuse: ['不得只说重复投递不安全，必须分别说明 upsert 类与普通 INSERT 类。'],
  };
  const q0054UnsafeDraft = '这类问题通常是 UUID 或 orderType 导致。研发参考\n- - ipt_p_id。让实施重放消息。';
  const q0054Audit = bundle.audit(q0054UnsafeDraft, q0054Question, q0054Route);
  assert.equal(q0054Audit.verifiedFactsFallback, true);
  assert.deepEqual(q0054Audit.currentRouteFacts, q0054Route.answerFacts);
  const q0054Fallback = bundle.fallback(q0054UnsafeDraft, q0054Audit);
  assert.match(q0054Fallback, /^业务结论\n- 住院自动通过后会完整保存/m);
  assert.match(q0054Fallback, /实施口径\n- 后台线程消费 AUDIT:IPT:AUTO/);
  assert.match(q0054Fallback, /自动通过任务、草药方、草药明细使用普通 INSERT/);
  assert.match(q0054Fallback, /坏 JSON 会在写库前令整批失败且不执行 LTRIM/);
  assert.doesNotMatch(q0054Fallback, /研发参考|\n- - /);
  const q0054FinalAudit = bundle.audit(q0054Fallback, q0054Question, q0054Route);
  assert.deepEqual(q0054FinalAudit.violations, [], 'Q0054 已核事实兜底必须完整、无重复技术附录且终审全绿');

  const q0069Question = '门诊处方走自动通过后，后台会保存哪些业务资料？患者、诊断、过敏、处方头、药品明细、警示、审核提交、自动通过结果、手术、检验、生命体征、影像和费用是否都覆盖？同一条消息重复投递时哪些能更新、哪些可能重复失败；某一类保存失败是否整条回滚？处方撤销或更新是不是也由这条自动通过队列处理？请用产品和实施能看懂的方式说明。';
  const q0069Route = {
    matched: true,
    route: { id: 'AUD-QR-DI-05', title: '门诊处方数据采集落库', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '门诊处方自动通过后会保存患者、诊断、过敏、处方头、药品明细、警示、审核提交、自动通过任务、手术和检验；这是后台落库链路，不是药师页面可点击的采集功能，也不是 HIS 初次接入入口。',
      '明确未覆盖的独立业务对象：当前消息和保存流程没有生命体征或影像报告，也没有费用结算/收费明细。费用只保存在已有对象的局部字段中，例如患者费用类型、处方总额、药品单价和金额，不能外推为完整收费业务。',
      'RedisConsumer 持续消费 AUDIT:OPT:AUTO，每批最多 10 条，队列为空等待 1 秒；保存患者、诊断、过敏、处方头、药品明细、警示、提交、自动通过任务、手术和检验。',
      'PostgreSQL 路径中患者、诊断、过敏、手术和检验按业务唯一键更新；处方、明细、警示、提交和自动通过任务直接 INSERT，重复消息不保证整包幂等。',
      '所有数据类别不在一个总事务内；某类 Mapper 失败被 audit_sync_error_flow 记录后会继续后续类别，已经成功的数据不回滚，因此会形成部分成功；方法返回后原 Redis 批次仍会被裁掉，失败类别不自动留队重试。',
      '坏 JSON 会在任何业务表写入前使整批解析失败；LTRIM 不执行，坏消息不丢弃、不跳过，会留在队列头并反复阻塞后续消息。',
      '处方撤销或更新不是 AUDIT:OPT:AUTO 中已实现的独立状态机；HC1015 属于 DI-08，当前自动消费调用已注释。',
      '实施先只读核对队列长度与头部、RedisConsumer 日志、audit_sync_error_flow 和相关业务表；未经授权不得 LTRIM、删除、改写或重放队列消息。',
    ],
  };
  const q0069Initial = bundle.audit('一般是重复消息造成的，让实施重放一次确认。', q0069Question, q0069Route);
  const q0069Fallback = bundle.fallback('一般是重复消息造成的，让实施重放一次确认。', q0069Initial);
  const q0069Final = bundle.audit(q0069Fallback, q0069Question, q0069Route);
  assert.equal(q0069Final.verifiedFactsFallback, true);
  assert.match(q0069Fallback, /^业务结论\n- 门诊处方自动通过后会保存/m);
  assert.deepEqual(q0069Final.violations, [], 'Q0069 门诊自动通过的逐行已核事实终稿不得被普通草稿规则二次误杀');

  const q0059Question = '请把一张门诊处方和一组住院医嘱从 HIS 提交到审方、再到结果回给 HIS 的完整业务主流程讲清楚：HIS 用什么入口和接口码提交，系统如何记请求/响应、校验 XML；门诊重复请求怎么处理，住院是否同样去重；在线且有院权限的药师和审核方案如何决定人工审核或自动通过；两条路径分别怎样落库、推送任务和设置超时；超时后怎么处理；HIS 最后如何查询结果并记录回写日志？请同时说明当前已知的事务、重试、权限和外部依赖边界，哪些局部事实仍需人工确认，不要堆全量字段表。';
  const q0059Route = {
    matched: true,
    route: { id: 'AUD-QR-FLOW-01', title: '处方审核端到端主流程', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '业务主链是“HIS 提交门诊处方或住院医嘱 → 审方校验并决定人工/自动审核 → 药师或系统产出结果 → HIS 主动查询结果”；主链跨 HIS、audit-server、Redis、redis2db、用户中心与药师工作台，任一单点成功都不能代表整链成功。',
      '接入入口与主接口：HIS 通过 POST /external 提交 XML，门诊接口码为 V1_OPT_AUDIT、住院为 V1_IPT_AUDIT；系统异步记录请求和响应日志。XML 缺 BASE、PATIENT、门诊 PRESCRIPTION_ARRAY 等必要节点时返回对应错误且不写业务表。',
      '门诊在配置的去重窗口内用 Redis setIfAbsent 拦重复请求，窗口配置为 0 时跳过去重；住院当前代码未确认存在同等去重，必须保持为局部未知，不能照搬门诊结论。',
      '人工候选先取当前在线药师与有本院权限药师的交集，再依次经过系统审核方案和个人审核方案筛选并分配；无需人工审核或没有合适候选时走自动通过。具体负载均衡算法仍需人工确认。',
      '人工审核路径异步写 audit-server 的 audit_* 业务表，向药师 Socket 推送 start_audit，并设置等待时间加 5 秒的 Redis 超时键；自动通过路径进入 AUDIT:OPT:AUTO 或 AUDIT:IPT:AUTO，由 redis2db 后台消费落库，不给药师派任务。',
      '超时键自然过期后由 Redis 过期监听器调用门诊/住院回调，任务变为超时通过并推送 sys_time_over_pass；仓内定时兜底扫描已注释，Redis keyspace 通知若丢失没有已激活的定时补偿。',
      'HIS 使用 V1_OPT_AUDIT_QUERY 或 V1_IPT_AUDIT_QUERY 按提交标识主动查询审核结果；客户端回写/对接结果日志另走 POST /comm/send/audit/result/log，查询成功不等于客户端日志一定已记录。',
      '人工审核落库各类别独立 try-catch、没有总事务，失败类别不回滚已成功数据且未见自动重试；自动通过的 redis2db 落库同样按类别处理，失败写 audit_sync_error_flow，设计中的定时重试当前已注释。人工路径是否同时写入哪些 MySQL sf_* 表仍需确认。',
      '/external 与 /comm 属免 JWT 前缀，依赖网络层隔离；当前 Controller 未见接口级角色/权限注解，写操作角色与数据归属规则需业务负责人确认。未经授权不得为抓包重复提交、触发超时、重放队列或修改业务数据。',
    ],
  };
  const q0059Initial = bundle.audit('接口如下：\n1. POST /external?interface_code=V1_OPT_AUDIT。', q0059Question, q0059Route);
  const q0059Fallback = bundle.fallback('接口如下：\n1. POST /external?interface_code=V1_OPT_AUDIT。', q0059Initial);
  const q0059Final = bundle.audit(q0059Fallback, q0059Question, q0059Route);
  assert.match(q0059Fallback, /(?:接入入口与主接口|入口)：HIS 通过 POST \/external/);
  assert.match(q0059Fallback, /住院当前代码未确认存在同等去重/);
  assert.match(q0059Fallback, /POST \/comm\/send\/audit\/result\/log/);
  assert.deepEqual(q0059Final.violations, [], 'Q0059 完整链路的已核事实兜底须通过接口、入口、依赖与未知停点终审');
  const q0059ModelErrorFallback = bundle.verifiedFallback(q0059Question, q0059Route);
  assert.ok(q0059ModelErrorFallback, 'Q0059 模型超长或临时失败时应返回已核事实终稿');
  assert.equal(q0059ModelErrorFallback.reply, q0059Fallback);
  assert.deepEqual(q0059ModelErrorFallback.finalAudit.violations, []);

  const q0060Question = '药师把一条待审任务“移交”给别人时，能不能选离线药师？移交成功后任务算不算审核完成，所属药师、优先级、挂起状态和倒计时分别怎么变，会通知谁？“移交”和 AI 挂起是不是同一个业务动作？页面显示挂起是否就能保证后台 Redis 超时键已删除？另外药师关闭审核时，名下已经分配的待审任务会怎么处理：有其它在线且有院权限并符合个人方案的药师时怎样重新分配，没有候选时是什么结果，属于 audit_pass 还是 auto_pass？请按产品和实施口径说明。';
  const q0060Route = {
    matched: true,
    route: { id: 'AUD-QR-FLOW-02', title: '审核业务场景与状态机', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '产品：移交和 AI 挂起是两个业务动作；移交会换所属药师并把优先级+1，挂起只暂停当前药师自己的任务。两者实现上都使用 suspend=true 与 suspend 操作流水。',
      '移交：页面禁用离线药师的移交按钮，后端也校验 WebSocket 在线连接；离线目标会报 USER_NOT_CONNECT。',
      '状态：移交成功后任务仍是 audit_operate=start_audit，不是审核完成；pharmacist_id、pharmacist_name、pharmacist_phone 改为目标药师，suspend=true，priority_num 加 HAND_OVER_PRIORITY=1，并通知目标药师。',
      '倒计时：suspend=true 时 WaitTimeMathUtil 返回 -1，页面显示挂起；但只在 audit_hand_over_close_time.open=true 时删除 Redis 超时 key，不能仅凭页面停表就承诺后台超时一定停止。',
      '关闭审核：工作台有当前任务时先二次确认；确认后将药师移出对应门诊/住院在线审核集合，并立即回收其名下待审任务，不是只影响之后的新进件。',
      '有候选：按其他在线、有医院权限药师与个人方案再筛选，有候选就更新任务所属，写 operate=redistribution、operate_role=sys 流水并推送给新药师；任务仍待审，不会丢失。',
      '无候选：当前已分配待审任务被直接记为 audit_operate=audit_pass、passed=true，删除超时 key，写原药师关闭审核且暂无其他药师的通过流水，并通知医生/按配置回调 HIS；这不是新进件的 auto_pass。',
      '实施：移交失败先核对目标在线状态；成功后核对所属药师、suspend、priority_num、suspend 流水、目标消息、audit_hand_over_close_time 开关及 Redis key。',
    ],
  };
  const q0060Initial = bundle.audit('先讲几个产品结论，再列实施细节。', q0060Question, q0060Route);
  const q0060Fallback = bundle.fallback('先讲几个产品结论，再列实施细节。', q0060Initial);
  const q0060Final = bundle.audit(q0060Fallback, q0060Question, q0060Route);
  assert.equal(q0060Final.verifiedFactsFallback, true);
  assert.match(q0060Fallback, /^业务结论\n- 产品：移交和 AI 挂起是两个业务动作/m);
  assert.match(q0060Fallback, /实施口径\n- 移交：页面禁用离线药师/);
  assert.match(q0060Fallback, /无候选：当前已分配待审任务被直接记为 audit_operate=audit_pass/);
  assert.deepEqual(q0060Final.violations, [], 'Q0060 产品与实施混合问法的逐行已核事实终稿不得被通用排版门二次误杀');

  const q0061Question = '药师在“标记管理”里建了个人标签和共享标签后，自己、其他药师分别能看到什么？其他人能不能编辑或删除共享标签；删除标签后历史标题会不会一起消失？请按产品和实施都能看懂的方式回答，只说已经确认的行为和风险。';
  const q0061Route = {
    matched: true,
    route: { id: 'AUD-QR-MK-03', title: '标记管理', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '标记管理列表和处方/医嘱打标下拉都能看到当前药师自己的个人标签与所有人的共享标签，其他人的个人标签不可见；管理列表默认每页 10 条，下拉当前未分页。',
      '个人标签只供创建人使用；共享标签扩大的是选择和查看范围，不是共同维护权限。',
      '页面会禁用他人共享标签的编辑和删除；编辑时后台还会核对创建人并拒绝越权，但删除时后台缺少同等的创建人校验。',
      '标签本身是直接删除，不是放入回收站；历史标记各自保存当时的标题文字，所以历史标题不会跟着消失。',
      '现场只能优先只读核对现有账号、已有标签、列表、下拉、既有请求和日志；不得为了回答问题去新建、编辑或删除标签。',
    ],
  };
  const q0061UnsafeDraft = [
    '业务结论：共享标签所有药师都能看见。',
    '现场核对建议（只读验证）',
    '1. 准备两个药师账号，用 A 创建个人标签和共享标签。',
    '2. 用 A 找到历史记录，然后删除该标签再次查看。',
    '技术依据：GET /auditapi/audit/collect/titles，表名 audit_collect_title。',
  ].join('\n');
  const q0061Initial = bundle.audit(q0061UnsafeDraft, q0061Question, q0061Route);
  assert.equal(q0061Initial.audienceMode, 'product', '仅说产品和实施都能看懂不等于请求实施诊断');
  assert.ok(q0061Initial.violations.includes('audience_technical_overreach'), '产品业务题不得主动追加研发接口和表名');
  assert.ok(q0061Initial.violations.includes('cross_actor_side_effect'), '标为只读的步骤不得实际创建或删除业务数据');
  const q0061Fallback = bundle.fallback(q0061UnsafeDraft, q0061Initial);
  const q0061Final = bundle.audit(q0061Fallback, q0061Question, q0061Route);
  assert.doesNotMatch(q0061Fallback, /GET \/auditapi|audit_collect_title|准备两个药师账号|然后删除该标签/);
  assert.match(q0061Fallback, /不得为了回答问题去新建、编辑或删除标签/);
  assert.deepEqual(q0061Final.violations, [], 'Q0061 应回退为纯已核业务事实且不含伪只读写操作');

  const explicitUnknownChainQuestion = '把住院医嘱审核从入口、接口和数据到外部依赖串起来，资料未定义的部分明确停住。';
  const explicitUnknownChainRoute = {
    ...q0011Route,
    answerFacts: [
      q0011Fact,
      '主接口是 GET /auditapi/audit/ipt/tasks。',
      '审核任务记录写 audit_ipt_task；状态为 current。',
      '用户信息读取用户中心，当前链路未直接调用 HIS。',
      'NEEDS-HUMAN：其它终端是否提供同组操作仍待确认。',
    ],
  };
  const explicitUnknownChainAudit = bundle.audit('业务上读取当前待审任务。', explicitUnknownChainQuestion, explicitUnknownChainRoute);
  assert.equal(explicitUnknownChainAudit.audienceMode, 'developer');
  assert.equal(explicitUnknownChainAudit.chainRequested, true);
  assert.ok(explicitUnknownChainAudit.missingChainDimensions.includes('资料明确的未知停点'), '当前轮显式研发链路仍须保留 route 已明确的未知停点');
  assert.ok(explicitUnknownChainAudit.violations.includes('incomplete_requested_chain'));

  const developerAnswer = 'OrderMarkService 通过 IptCollectMapper 读取字段 iptTaskId。';
  const developerAudit = bundle.audit(developerAnswer, '接口字段和 Mapper 开发链路是什么？', implementationRoute);
  assert.ok(!developerAudit.violations.some(item => item.startsWith('audience_')), '明确研发问法允许完整技术展开');

  const redisRoute = {
    matched: true,
    route: { id: 'GENERIC-QUEUE-FLOW', title: '常驻消费与错误流水' },
    answerFacts: ['应用启动常驻消费线程处理队列，单对象写入失败时记录同步错误流水。'],
  };
  const q0005Question = '如果接口返回有数据而页面没呈现，转开发前要整理哪些最小证据？';
  const q0005Draft = [
    'LLEN 持续增长 + 日志无消费记录 → 消费线程未启动、假死或 Redis 连接异常，属进程/网络层问题。',
    'LLEN 正常减少 + 错误流水有对应记录 → 已消费但单对象写入失败，属数据格式或库约束问题。',
  ].join('\n');
  const q0005Audit = bundle.audit(q0005Draft, q0005Question, redisRoute);
  assert.ok(q0005Audit.violations.includes('unsupported_likelihood'), '箭头和“属…问题”不能把观测现象升级成确定根因');
  assert.deepEqual(q0005Audit.unsupportedCausalLocalizationClaims, q0005Draft.split('\n'));
  assert.match(bundle.revision(q0005Draft, q0005Audit), /日志无某记录.*不证明对应动作未发生/);
  const q0005Fallback = bundle.fallback(q0005Draft, q0005Audit);
  assert.doesNotMatch(q0005Fallback, /消费线程未启动|假死|Redis 连接异常|数据格式或库约束问题/);
  assert.match(q0005Fallback, /待验证分支.*原始日志或异常堆栈/s);
  assert.deepEqual(bundle.audit(q0005Fallback, q0005Question, redisRoute).violations, [], 'fallback 删除定性归因后必须再审全绿');

  for (const safeCausalBoundary of [
    'LLEN 持续增长只能确认队列长度未减少；日志无消费记录只说明未观察到对应日志，不能据此证明未消费。',
    '待验证分支：消费线程未启动、运行异常或连接异常；需查看原始日志或异常堆栈逐项确认。',
    '方案保存响应成功只能固定该响应观测，后续状态流转仍待验证。',
  ]) assert.ok(!bundle.audit(safeCausalBoundary, q0005Question, redisRoute).violations.includes('unsupported_likelihood'), safeCausalBoundary);
  assert.ok(bundle.audit('日志没有消费记录，所以消费线程没有启动。', q0005Question, redisRoute).violations.includes('unsupported_likelihood'), '日志缺失不能证明对应动作未发生');
  assert.ok(bundle.audit('状态未变化 → 状态机实现错误，属后端逻辑问题。', '工作台标记后状态没变，怎么定位？', { matched: true, answerFacts: ['标记后进入待审状态'] }).violations.includes('unsupported_likelihood'), '因果守卫必须通用于状态流转等核心业务');
  assert.ok(!bundle.audit('原始日志已明确报 Redis 连接异常，当前故障属于 Redis 连接问题。', '原始日志明确报 Redis 连接异常，现在能确认什么？', redisRoute).violations.includes('unsupported_likelihood'), '原始日志已直接确认同一根因时可照实承接');
  const permissionRuleRoute = { matched: true, answerFacts: ['说明书明确：响应码为 AUTH_DENIED 时，原因是当前账号无标记权限。'] };
  assert.ok(!bundle.audit('响应码是 AUTH_DENIED，当前问题属于标记权限问题。', '标记响应码 AUTH_DENIED 表示什么？', permissionRuleRoute).violations.includes('unsupported_likelihood'), 'current route 明确的业务因果契约应放行');

  const auditGenerationRoute = {
    matched: true,
    inherited: true,
    route: { title: 'AI 审方生成' },
    answerFacts: [
      'AI 审方按 audit 场景读取当前任务上下文，经工作流生成辅助建议，结果须由药师主动采纳。',
      '生成记录写入 audit_ai_generate；流式开始后写 task_id，结束后回写 content。',
      '操作留痕由 audit_ai_generate 承载，不写操作日志表。',
    ],
    directEvidenceFacts: [
      '- **AC-7** Given 业务来源为 `ipt`（住院）；When 调用生成接口；Then 后端取 `IptCurrentTaskVO`（当前任务详情）+ `IptOrderCautionVO` 列表，将二者序列化为中文键名 JSON 作为 Dify `inputs.content` 字段传入。',
      '- **AC-8** Given 业务来源为 `opt`（门诊）；When 调用生成接口；Then 后端取 `OptCurrentTaskVO` + `OptOrderCautionVO` 列表，同样序列化为中文键名 JSON 传入。',
      '生成记录写入 audit_ai_generate；流式开始后写 task_id，结束后回写 content。',
      '操作留痕由 audit_ai_generate 承载，不写操作日志表。',
    ],
  };
  const limitedEvidenceQuestion = '关于AI 审方生成，我现在只有一次既有请求和响应，没有数据库权限。现有证据最多能判断到哪？';
  const unsupportedNegationDraft = '现有证据最多只能确认请求已发送并收到响应。本次仅为生成请求，不涉及审核任务状态或日志落库。';
  const unsupportedNegationAudit = bundle.audit(unsupportedNegationDraft, limitedEvidenceQuestion, auditGenerationRoute);
  assert.ok(unsupportedNegationAudit.violations.includes('unsupported_evidence_negation'), '不能把没有下游观测权限反写成未发生或不涉及');
  assert.deepEqual(unsupportedNegationAudit.unsupportedEvidenceNegations, ['本次仅为生成请求，不涉及审核任务状态或日志落库。']);
  assert.match(bundle.revision(unsupportedNegationDraft, unsupportedNegationAudit), /本轮看不到.*不能反向写成未落库、不写日志、不涉及任务状态/);
  const unsupportedNegationFallback = bundle.fallback(unsupportedNegationDraft, unsupportedNegationAudit);
  assert.doesNotMatch(unsupportedNegationFallback, /不涉及审核任务状态或日志落库/);
  assert.match(unsupportedNegationFallback, /只能标为无法确认，不能据缺少观测写成未发生或不涉及/);
  assert.deepEqual(bundle.audit(unsupportedNegationFallback, limitedEvidenceQuestion, auditGenerationRoute).violations, [], '确定性降级稿也必须通过同一终审');

  for (const safeStatement of [
    '系统规则明确：生成记录写入 audit_ai_generate；但本次是否成功写入，现有请求响应无法确认。',
    '系统不写操作日志表；本次 audit_ai_generate 是否成功写入仍未知。',
    '现有响应不能证明已落库，实际结果仍未知。',
    '本次未观察到数据库记录，但这不代表没有落库。',
  ]) {
    assert.ok(!bundle.audit(safeStatement, limitedEvidenceQuestion, auditGenerationRoute).violations.includes('unsupported_evidence_negation'), safeStatement);
  }
  assert.ok(bundle.audit('本次没有成功写入 audit_ai_generate。', limitedEvidenceQuestion, auditGenerationRoute).violations.includes('unsupported_evidence_negation'), '无数据库权限时不得断言本次写入失败');
  assert.ok(bundle.audit('本次未落库，但实际是否成功仍未知。', limitedEvidenceQuestion, auditGenerationRoute).violations.includes('unsupported_evidence_negation'), '先否定、再补未知不能洗白同句里的无证据结论');
  assert.ok(!bundle.audit('响应明确显示没有创建任务状态记录。', '现有响应明确显示没有创建任务状态记录。', auditGenerationRoute).violations.includes('unsupported_evidence_negation'), '用户已给出同一否定事实时允许照实承接');

  const missingExcerptDraft = '住院场景说明书写了 IptCurrentTaskVO + IptOrderCautionVO；门诊只确认读当前门诊任务上下文，具体拼哪些字段现有摘录没写明。';
  const missingExcerptAudit = bundle.audit(missingExcerptDraft, limitedEvidenceQuestion, auditGenerationRoute);
  assert.ok(missingExcerptAudit.violations.includes('unsupported_evidence_absence'), 'Top-N 片段缺失不得被写成 Spec 未写或只确认');
  assert.deepEqual(missingExcerptAudit.unsupportedEvidenceAbsenceClaims, ['门诊只确认读当前门诊任务上下文，具体拼哪些字段现有摘录没写明。']);
  assert.deepEqual(missingExcerptAudit.evidenceAbsenceCorrectionFacts, [
    'Given 业务来源为 `opt`（门诊）；When 调用生成接口；Then 后端取 `OptCurrentTaskVO` + `OptOrderCautionVO` 列表，同样序列化为中文键名 JSON 传入。',
  ]);
  assert.match(bundle.revision(missingExcerptDraft, missingExcerptAudit), /检索截断、Top-N 未带到某行不能作为缺失证据/);
  const missingExcerptFallback = bundle.fallback(missingExcerptDraft, missingExcerptAudit);
  assert.doesNotMatch(missingExcerptFallback, /摘录没写明|门诊只确认/);
  assert.match(missingExcerptFallback, /OptCurrentTaskVO.*OptOrderCautionVO/);
  assert.match(missingExcerptFallback, /本次实例是否准确执行仍需对应日志或记录确认/);
  assert.deepEqual(bundle.audit(missingExcerptFallback, limitedEvidenceQuestion, auditGenerationRoute).violations, [], 'fallback 必须恢复 current route 已核门诊契约并再次终审全绿');

  const explicitGapRoute = {
    matched: true,
    route: { title: '门诊回退规则' },
    answerFacts: ['门诊生成读取当前任务上下文。'],
    directEvidenceFacts: ['NEEDS-HUMAN：门诊回退规则未定义，当前正文无法确认具体回退字段。'],
  };
  assert.ok(!bundle.audit('门诊回退规则在现有说明书里未定义。', '门诊回退规则怎么处理？', explicitGapRoute).violations.includes('unsupported_evidence_absence'), 'current route 明确 NEEDS-HUMAN/未定义时允许照实标缺失');

  const orderMarkRoute = {
    matched: true,
    route: { title: '医嘱标记' },
    answerFacts: ['住院医嘱标记复用审核任务数据，通过收藏、标题和导出接口形成药师质控清单。'],
    directEvidenceFacts: [
      '医嘱标记接口路径已确认：GET /auditapi/audit/ipt/collects、POST /auditapi/audit/ipt/task/collect、DELETE /auditapi/audit/ipt/collect、GET /auditapi/comm/ipt/collects/excel。',
      '医嘱标记字段已确认：iptTaskId、collectTitle、iptCollectId、severity、cautionLevel、isCollect。',
      '医嘱标记状态边界已确认：取消标记为 deleted=1 软删除，列表页固定 isCollect=true。',
    ],
  };
  const q0006Question = '医嘱标记现在是怎么实现的？';
  const q0006Summary = '住院医嘱标记复用审核任务数据，通过收藏、标题和导出接口形成药师质控清单。';
  const q0006MissingSentence = '更细的接口路径、字段、状态值，以及门诊医嘱标记是否同样实现，这轮说明书没有写成已确认事实。';
  const q0006Draft = `${q0006Summary}\n${q0006MissingSentence}`;
  const q0006Audit = bundle.audit(q0006Draft, q0006Question, orderMarkRoute);
  assert.ok(q0006Audit.violations.includes('unsupported_evidence_absence'), '“没有写成已确认事实”同样是资料缺失声明');
  assert.deepEqual(q0006Audit.unsupportedEvidenceAbsenceClaims, [q0006MissingSentence], '部分真部分假的混合句必须整句进审计');
  assert.deepEqual(q0006Audit.evidenceAbsenceCorrectionFacts, orderMarkRoute.directEvidenceFacts, '必须从 current route 恢复被错误降级的接口、字段和状态契约');
  const q0006Fallback = bundle.fallback(q0006Draft, q0006Audit);
  assert.match(q0006Fallback, /住院医嘱标记复用审核任务数据/);
  assert.doesNotMatch(q0006Fallback, /\/auditapi\/audit\/ipt\/collects|iptTaskId|deleted=1/, '普通“怎么实现”按产品受众，已核技术契约仅作内部取证不堆到正文');
  assert.doesNotMatch(q0006Fallback, /说明书没有写成|门诊医嘱标记是否同样实现/);
  assert.deepEqual(bundle.audit(q0006Fallback, q0006Question, orderMarkRoute).violations, [], 'fallback 保留业务结论、删除假缺失和技术堆叠后必须再审全绿');

  const q0006ProductionMissingSentence = '更细的字段、状态，以及门诊医嘱标记是否同样实现，这轮资料没有写成已确认事实。';
  const q0006ProductionDraft = `${q0006Summary}\n${q0006ProductionMissingSentence}`;
  const q0006ProductionAudit = bundle.audit(q0006ProductionDraft, q0006Question, orderMarkRoute);
  assert.ok(q0006ProductionAudit.violations.includes('audience_technical_overreach'), '产品题不得主动谈字段/状态等技术元话题或资料缺失');
  assert.deepEqual(q0006ProductionAudit.productTechnicalParts, [q0006ProductionMissingSentence]);
  assert.match(bundle.revision(q0006ProductionDraft, q0006ProductionAudit), /业务结论和对象范围答清后立即停止/);
  const q0006ProductionFallback = bundle.fallback(q0006ProductionDraft, q0006ProductionAudit);
  assert.equal(q0006ProductionFallback, q0006Summary, '生产原句 fallback 只能留下住院医嘱业务结论');
  assert.doesNotMatch(q0006ProductionFallback, /字段|状态|门诊|资料|研发参考|技术依据/);
  assert.deepEqual(bundle.audit(q0006ProductionFallback, q0006Question, orderMarkRoute).violations, []);

  for (const productMetaDraft of [
    '业务上支持住院医嘱标记。研发参考：接口路径后续再补。',
    '业务上支持住院医嘱标记。技术依据和 Java 模型这轮资料未确认。',
    '业务上支持住院医嘱标记。源码、字段和状态值没有写成已确认事实。',
  ]) assert.ok(bundle.audit(productMetaDraft, q0006Question, orderMarkRoute).violations.includes('audience_technical_overreach'), productMetaDraft);
  assert.ok(!bundle.audit('住院医嘱可标记进入药师质控清单，取消后不再作为有效标记展示。', q0006Question, orderMarkRoute).violations.includes('audience_technical_overreach'), '业务状态大白话不得被“状态值”技术元话题守卫误拦');

  const q0006DeveloperQuestion = '医嘱标记的接口路径、字段和状态值分别是什么？';
  const q0006DeveloperAudit = bundle.audit(q0006Draft, q0006DeveloperQuestion, orderMarkRoute);
  const q0006DeveloperFallback = bundle.fallback(q0006Draft, q0006DeveloperAudit);
  assert.match(q0006DeveloperFallback, /\/auditapi\/audit\/ipt\/collects/);
  assert.match(q0006DeveloperFallback, /iptTaskId.*collectTitle.*iptCollectId/s);
  assert.match(q0006DeveloperFallback, /deleted=1.*isCollect=true/s);
  assert.deepEqual(bundle.audit(q0006DeveloperFallback, q0006DeveloperQuestion, orderMarkRoute).violations, [], '明确追问技术契约时不得被产品层级误删');
  assert.ok(!bundle.audit('研发参考：接口路径、字段、状态值和 Java 模型如下。', q0006DeveloperQuestion, orderMarkRoute).violations.includes('audience_technical_overreach'), '研发显式追问不得被产品元话题规则误拦');

  const q0009Question = '把医嘱标记从入口、接口或数据到外部依赖串起来。';
  const q0009Route = {
    matched: true,
    route: { id: 'GENERIC-CHAIN', title: '业务标记链路' },
    answerFacts: [
      '住院医嘱标记供药师在住院医嘱详情添加或取消标记，并在标记列表查看、筛选和导出。',
      '标记链路的四个主接口是列表 GET /auditapi/audit/ipt/collects、新增 POST /auditapi/audit/ipt/task/collect、取消 DELETE /auditapi/audit/ipt/collect、导出 GET /auditapi/comm/ipt/collects/excel。',
      '标记记录写 audit_ipt_collect；列表只读 deleted=false，取消更新 deleted=1，不物理删除。',
      '新增标记读取审方服务已有住院任务、患者和医嘱记录；列表通过用户中心 getHospitalInfoByHospitalId 补医院/机构名称，添加标记方法未直接调用 HIS。',
    ],
    directEvidenceFacts: [
      'NEEDS-HUMAN：各写操作的角色与数据归属规则需由业务负责人确认。',
      '数据权限：NEEDS-HUMAN（listAuditIptCollect 当前无用户维度过滤，是否按药师隔离待确认）。',
      '未在已核调用链出现的外部系统或失败归因保持局部未知。',
    ],
    mustNotConfuse: [],
  };
  const q0009ProductionDraft = [
    '## 入口 → 接口 → 数据 → 外部依赖',
    '住院药师可以在医嘱详情添加标记，并在列表查看和导出。',
    '数据表包含 ipt_collect_id、collect_title、institute_id、hospital_id、patient_id、event_no、dept_id、ward_id、order_doc_id、pharmacist_id、ipt_task_id、create_time，取消时 deleted=1。',
    '列表会读用户中心补医院名，新增链路未直接调用 HIS。',
    '除 JwtFilter 明确放行的 /comm',
  ].join('\n');
  const q0009Audit = bundle.audit(q0009ProductionDraft, q0009Question, q0009Route);
  assert.ok(q0009Audit.violations.includes('missing_requested_interfaces'), '点名接口时四个 answerFacts 主签名不得漏答');
  assert.equal(q0009Audit.missingRequestedInterfaces.length, 4);
  assert.ok(q0009Audit.violations.includes('incomplete_requested_chain'), '同名标题不能冒充已覆盖用户点名维度');
  assert.ok(q0009Audit.violations.includes('audience_technical_dump'), '未问字段时不得展开长字段枚举');
  assert.ok(q0009Audit.violations.includes('malformed_markdown'), '以“除……”结束且没有主句的半截句必须拦截');
  assert.match(bundle.revision(q0009ProductionDraft, q0009Audit), /接口只列 METHOD \+ path，数据只列对象\+关键状态/);
  const q0009Fallback = bundle.fallback(q0009ProductionDraft, q0009Audit);
  for (const signature of [
    'GET /auditapi/audit/ipt/collects',
    'POST /auditapi/audit/ipt/task/collect',
    'DELETE /auditapi/audit/ipt/collect',
    'GET /auditapi/comm/ipt/collects/excel',
  ]) assert.match(q0009Fallback, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), signature);
  assert.match(q0009Fallback, /audit_ipt_collect/);
  assert.match(q0009Fallback, /deleted=1/);
  assert.match(q0009Fallback, /用户中心/);
  assert.match(q0009Fallback, /HIS/);
  assert.match(q0009Fallback, /当前停点/);
  assert.match(q0009Fallback, /角色与数据归属规则.*确认/);
  assert.match(q0009Fallback, /是否按药师隔离待确认/);
  assert.doesNotMatch(q0009Fallback, /ipt_collect_id|collect_title|institute_id|hospital_id|patient_id|event_no|order_doc_id|pharmacist_id|ipt_task_id|JwtFilter/);
  assert.doesNotMatch(q0009Fallback, /(?:^|\n)\s*除(?!非)[^。！？\n]*$/u, '终稿不得有“除……”半截句');
  assert.deepEqual(bundle.audit(q0009Fallback, q0009Question, q0009Route).violations, [], '确定性链路 fallback 必须终审全绿');
  const q0019Question = '请把住院医嘱标记从入口、接口、数据到外部依赖串联起来，资料不足的地方明确停住。';
  const q0019Route = {
    ...q0009Route,
    fallbackMode: 'verifiedFacts',
    route: { ...q0009Route.route, fallbackMode: 'verifiedFacts' },
  };
  const q0019Fallback = bundle.verifiedFallback(q0019Question, q0019Route);
  assert.ok(q0019Fallback, 'Q0019 chain 问法应使用 route 已核事实生成安全终稿');
  assert.equal(q0019Fallback.initialAudit.fallbackAnswerMode, 'chain');
  assert.match(q0019Fallback.reply, /链路（按本轮点名维度）/);
  assert.match(q0019Fallback.reply, /GET \/auditapi\/audit\/ipt\/collects/);
  assert.match(q0019Fallback.reply, /audit_ipt_collect/);
  assert.deepEqual(q0019Fallback.finalAudit.violations, [], 'Q0019 chain fallback 只串 route 事实并终审全绿');

  const genericMultiInterfaceRoute = { matched: true, answerFacts: ['两个主接口：列表 GET /api/items；详情 GET /api/items/{id}。'] };
  const genericMultiInterfaceQuestion = '这个功能有哪些主接口？';
  const genericMultiInterfaceAudit = bundle.audit('列表调用 GET /api/items。', genericMultiInterfaceQuestion, genericMultiInterfaceRoute);
  assert.deepEqual(genericMultiInterfaceAudit.missingRequestedInterfaces.map(item => item.display), ['GET /api/items/{id}'], '非链路题同样对 answerFacts 的主签名集合做差');
  const genericMultiInterfaceFallback = bundle.fallback('列表调用 GET /api/items。', genericMultiInterfaceAudit);
  assert.match(genericMultiInterfaceFallback, /GET \/api\/items\/\{id\}/);
  assert.deepEqual(bundle.audit(genericMultiInterfaceFallback, genericMultiInterfaceQuestion, genericMultiInterfaceRoute).violations, []);

  const explicitFieldChainQuestion = '请把这个开发链路的入参字段名、类型和 Mapper 串起来。';
  const explicitFieldChainDraft = '字段为 ipt_collect_id、collect_title、institute_id、hospital_id、patient_id、event_no、dept_id、ward_id、order_doc_id；IptCollectMapper 负责读写。';
  assert.ok(!bundle.audit(explicitFieldChainDraft, explicitFieldChainQuestion, q0009Route).violations.includes('audience_technical_dump'), '明确追问字段/代码的研发题不得被 dump 护栏误伤');

  for (const unsupportedVariant of [
    '这轮说明书未写成已确认行为。',
    '现有 Spec 没有将该接口列为已确认契约。',
    '当前文档未把这些状态列入已确认范围。',
  ]) assert.ok(bundle.audit(unsupportedVariant, q0006Question, orderMarkRoute).violations.includes('unsupported_evidence_absence'), unsupportedVariant);
  const explicitUndefinedOrderRoute = {
    matched: true,
    answerFacts: ['住院医嘱标记契约已确认。'],
    directEvidenceFacts: ['NEEDS-HUMAN：门诊医嘱标记当前未定义，是否同样实现待确认。'],
  };
  assert.ok(!bundle.audit('门诊医嘱标记在当前说明书中未列为已确认行为。', '门诊医嘱标记怎么实现？', explicitUndefinedOrderRoute).violations.includes('unsupported_evidence_absence'), '当 current route 明确 NEEDS-HUMAN/未定义时允许照实说明缺口');

  const q127Draft = [
    'patient_id 是 varchar(50)，按字符串存。',
    '对接方如果当数字传，长号在 JSON/中间层/语言数值类型里很容易丢精度或少位。',
    '如果看到纯数字且值已经变化，丢位很可能就发生在他们发出前或序列化时。',
    '只读对比原始号、已有报文和现有记录。',
  ].join('\n');
  const q127Audit = bundle.audit(q127Draft, '对接方把患者号当数字传，长号码开始丢位，先验证什么？', route);
  assert.ok(q127Audit.violations.includes('unsupported_likelihood'));
  assert.ok(q127Audit.likelihoodTerms.includes('很可能就发生'));
  assert.ok(q127Audit.likelihoodTerms.includes('很容易丢精度'));
  assert.ok(q127Audit.likelihoodTerms.some(term => term.includes('序列化')), '同时识别无证据的具体层定位');
  const q127Fallback = bundle.fallback(q127Draft, q127Audit);
  assert.match(q127Fallback, /patient_id 是 varchar\(50\)/);
  assert.match(q127Fallback, /只读对比原始号、已有报文和现有记录/);
  assert.doesNotMatch(q127Fallback, /很容易|很可能|JSON\/中间层\/语言数值类型|序列化时/);
  assert.deepEqual(bundle.audit(q127Fallback, '对接方把患者号当数字传，长号码开始丢位，先验证什么？', route).violations, []);

  const q127ProductionDraft = [
    'patient_id 是 character varying(50)，是字符串字段。',
    '长号码一旦被当数字传，超过精度就会直接丢位，这是契约层面的硬边界。',
    '如果报文里已经是数字且少了位，就是对接方类型传错了，改成字符串再传。',
    '先只读对比完整原号与已发生请求里的原始值。',
  ].join('\n');
  const q127ProductionAudit = bundle.audit(q127ProductionDraft, '对接方把患者号当数字传，长号码开始丢位，先让他们做哪个验证？', route);
  assert.deepEqual(q127ProductionAudit.violations.sort(), ['cross_actor_side_effect', 'unsupported_likelihood'].sort());
  const q127ProductionFallback = bundle.fallback(q127ProductionDraft, q127ProductionAudit);
  assert.match(q127ProductionFallback, /patient_id 是 character varying\(50\)/);
  assert.match(q127ProductionFallback, /只读对比完整原号与已发生请求里的原始值/);
  assert.doesNotMatch(q127ProductionFallback, /超过精度就会|就是对接方|改成字符串再传/);
  assert.deepEqual(bundle.audit(q127ProductionFallback, '对接方把患者号当数字传，长号码开始丢位，先让他们做哪个验证？', route).violations, []);

  const q127ObservedBoundaryDraft = [
    'patient_id 是 character varying(50)，是字符串字段。',
    '只读对比原始完整号码与同一次已有出站报文。',
    '报文里已经是数字类型、且位数已经短了 → 丢位发生在对接方传参/序列化侧。',
  ].join('\n');
  const q127ObservedBoundaryAudit = bundle.audit(q127ObservedBoundaryDraft, '对接方把患者号当数字传，长号码开始丢位，先让他们做哪个验证？', route);
  assert.deepEqual(q127ObservedBoundaryAudit.violations, ['unsupported_likelihood'], '观测点差异不能无证据升级成具体传参/序列化层归因');
  const q127ObservedBoundaryFallback = bundle.fallback(q127ObservedBoundaryDraft, q127ObservedBoundaryAudit);
  assert.match(q127ObservedBoundaryFallback, /只读对比原始完整号码与同一次已有出站报文/);
  assert.doesNotMatch(q127ObservedBoundaryFallback, /发生在对接方传参\/序列化侧/);
  assert.deepEqual(bundle.audit(q127ObservedBoundaryFallback, '对接方把患者号当数字传，长号码开始丢位，先让他们做哪个验证？', route).violations, []);

  const observationOnly = '已有出站报文里的患者号已经比原始完整号码少位；目前只能确认变化不晚于这个观测点，具体发生环节仍待逐层证据确认。';
  assert.deepEqual(bundle.audit(observationOnly, '对接方把患者号当数字传，长号码开始丢位，先让他们做哪个验证？', route).violations, [], '只陈述观测边界、不定具体机制应放行');

  const q127R27Draft = [
    'patient_id 是 varchar(50) 字符串。',
    '不能当成数字类型传；当数字传时，长号码会出现少位、丢精度或对不上。',
    '不带引号的裸数字就是会丢位的写法。',
    '只看同一次已有原始号与出站报文，不改、不重传。',
  ].join('\n');
  const q127R27Audit = bundle.audit(q127R27Draft, '对接方把患者号当数字传，长号码开始丢位，先让他们做哪个验证？', route);
  assert.deepEqual(q127R27Audit.violations, ['unsupported_likelihood'], '“会出现/就是会”的确定故障写法不能绕过claim证据门');
  assert.equal(q127R27Audit.unsupportedDeterministicFailureClaims.length, 2);
  const q127R27Fallback = bundle.fallback(q127R27Draft, q127R27Audit);
  assert.match(q127R27Fallback, /patient_id 是 varchar\(50\) 字符串/);
  assert.match(q127R27Fallback, /只看同一次已有原始号与出站报文/);
  assert.doesNotMatch(q127R27Fallback, /会出现少位|就是会丢位/);
  assert.deepEqual(bundle.audit(q127R27Fallback, '对接方把患者号当数字传，长号码开始丢位，先让他们做哪个验证？', route).violations, []);

  const todayAtomicRoute = {
    matched: true,
    route: { title: '工作台今天日期接口' },
    answerFacts: [
      '工作台今天日期和星期调用 GET /pwrsapi/month/view/today（需合法 JWT）',
      '响应包含 year、week，日期来自服务端 JVM 当前时区',
    ],
    mustNotConfuse: ['不得与已废止的 GET /month/view 月历网格接口混淆'],
  };
  const todayAtomicDraft = [
    '工作台今天日期和星期调用 GET /pwrsapi/month/view/today（需合法 JWT）。',
    '响应是 Map<String,String>，包含 year 和 week。',
    '日期来自服务端 JVM 当前时区。',
    '别混淆：不是已废止的 GET /month/view 月历网格接口。',
  ].join('\n');
  const todayAtomicAudit = bundle.audit(todayAtomicDraft, '工作台今天日期和星期调用哪个接口？', todayAtomicRoute);
  assert.ok(todayAtomicAudit.violations.includes('focused_fact_overreach'), '原子接口题不得因同route事实真实而扩写响应字段和JVM时区');
  assert.deepEqual(todayAtomicAudit.focusedFactOverreach, [
    '响应是 Map<String,String>，包含 year 和 week。',
    '日期来自服务端 JVM 当前时区。',
  ]);
  const todayAtomicFallback = bundle.fallback(todayAtomicDraft, todayAtomicAudit);
  assert.match(todayAtomicFallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.match(todayAtomicFallback, /需合法 JWT/);
  assert.match(todayAtomicFallback, /GET \/month\/view/);
  assert.doesNotMatch(todayAtomicFallback, /Map<String,String>|\byear\b|\bweek\b|JVM 当前时区/);
  assert.deepEqual(bundle.audit(todayAtomicFallback, '工作台今天日期和星期调用哪个接口？', todayAtomicRoute).violations, []);

  const q120R72ProductionDraft = '工作台今天的日期和星期，调用的是：GET /pwrsapi/month/view/today 别跟已删除的 GET /month/view 月历网格接口搞混。';
  const q120R72Audit = bundle.audit(q120R72ProductionDraft, '工作台今天的日期和星期调用哪个接口？', todayAtomicRoute);
  assert.ok(q120R72Audit.violations.includes('focused_fact_incomplete'), '唯一主接口漏同一fact的JWT访问限定必须拦截');
  assert.equal(q120R72Audit.missingFocusedRelationshipFacts[0].kind, 'interface_qualifier');
  assert.deepEqual(q120R72Audit.missingFocusedRelationshipFacts[0].missingTokens, ['需合法 JWT']);
  assert.match(bundle.revision(q120R72ProductionDraft, q120R72Audit), /认证\/访问限定/);
  const q120R73Fallback = bundle.fallback(q120R72ProductionDraft, q120R72Audit);
  assert.match(q120R73Fallback, /需合法 JWT/);
  assert.match(q120R73Fallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.match(q120R73Fallback, /GET \/month\/view/);
  assert.doesNotMatch(q120R73Fallback, /\byear\b|\bweek\b|JVM|Map/);
  assert.deepEqual(bundle.audit(q120R73Fallback, '工作台今天的日期和星期调用哪个接口？', todayAtomicRoute).violations, []);

  const publicRoute = {
    matched: true,
    route: { title: '公开状态接口' },
    answerFacts: ['公开状态使用无需鉴权的 GET /public/status'],
  };
  const publicMissingAudit = bundle.audit('公开状态调用 GET /public/status。', '公开状态调用哪个接口？', publicRoute);
  assert.ok(publicMissingAudit.violations.includes('focused_fact_incomplete'), '明确无需鉴权也是同一接口的直接访问限定');
  assert.deepEqual(bundle.audit('公开状态使用无需鉴权的 GET /public/status。', '公开状态调用哪个接口？', publicRoute).violations, []);

  const fixedParamRoute = {
    matched: true,
    route: { title: '当前报表接口' },
    answerFacts: ['当前报表调用 GET /report/current，必须携带参数 scope=current'],
  };
  const fixedParamMissingAudit = bundle.audit('当前报表调用 GET /report/current。', '当前报表调用哪个接口？', fixedParamRoute);
  assert.ok(fixedParamMissingAudit.violations.includes('focused_fact_incomplete'), '同一fact直接绑定的固定参数不能因原子止答被删掉');
  assert.deepEqual(bundle.audit('当前报表调用 GET /report/current，必须携带参数 scope=current。', '当前报表调用哪个接口？', fixedParamRoute).violations, []);

  const adjacentAuthRoute = {
    matched: true,
    route: { title: '当前状态接口' },
    answerFacts: ['当前状态调用 GET /current/status'],
    mustNotConfuse: ['相邻管理接口 GET /admin/status 需要合法 JWT，不是当前状态接口'],
  };
  const adjacentAuthAnswer = '当前状态调用 GET /current/status；不要混淆需要合法 JWT 的 GET /admin/status。';
  assert.ok(!bundle.audit(adjacentAuthAnswer, '当前状态调用哪个接口？', adjacentAuthRoute).violations.includes('focused_fact_incomplete'), '相邻接口JWT不得强塞成当前接口限定');

  const todayStatementQuestion = '工作台今天的日期和星期，调用的是 GET /pwrsapi/month/view/today（需要合法 JWT）。别跟已经按会议结论删除的 GET /month/view 月历网格接口搞混。';
  const todayStatementDraft = [
    '结论：对。',
    '工作台「今天日期 + 星期」走 GET /pwrsapi/month/view/today。',
    '需要合法 JWT。',
    '无入参。',
    '返回 Map：year、week。',
    '日期按服务端 JVM 当前时区算。',
  ].join('\n');
  const todayStatementAudit = bundle.audit(todayStatementDraft, todayStatementQuestion, todayAtomicRoute);
  assert.ok(todayStatementAudit.violations.includes('focused_fact_overreach'));
  const todayStatementFallback = bundle.fallback(todayStatementDraft, todayStatementAudit);
  assert.match(todayStatementFallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.match(todayStatementFallback, /GET \/month\/view/);
  assert.doesNotMatch(todayStatementFallback, /无入参|Map|\byear\b|\bweek\b|JVM 当前时区/);
  assert.deepEqual(bundle.audit(todayStatementFallback, todayStatementQuestion, todayAtomicRoute).violations, []);
  assert.deepEqual(bundle.audit(
    '工作台今天日期和星期调用 GET /pwrsapi/month/view/today；如果响应不一致，现场怎么排查？',
    '工作台今天日期和星期调用哪个接口，响应不一致时现场怎么排查？',
    todayAtomicRoute,
  ).violations, [], '显式多问且含现场诊断意图时不触发原子止答');

  const q121Question = '今天视图页面、接口返回和本机日期对不上，现场怎么判断差异在哪一边？';
  const q121R74ProductionDraft = [
    '先只读核三件事：页面显示的日期星期、GET /pwrsapi/month/view/today 的响应、本机日期星期。',
    '按结果判断：',
    '- A = B，但 B ≠ C：记录这条差异。',
    '- B = C，但 A ≠ B：记录这条差异。',
    '- A ≠ B，且 B ≠ C：三边均保留原文。',
    '收口时再按接口=本机≠页面记录。',
  ].join('\n');
  const q121R74Audit = bundle.audit(q121R74ProductionDraft, q121Question, todayAtomicRoute);
  assert.ok(q121R74Audit.violations.includes('undefined_symbolic_comparison'), '前文自然语列三项不能自动定义A/B/C');
  assert.deepEqual(Array.from(new Set(q121R74Audit.undefinedSymbolicComparisons.flatMap(item => item.undefinedSymbols))).sort(), ['A', 'B', 'C']);
  assert.match(bundle.revision(q121R74ProductionDraft, q121R74Audit), /第一次“=、≠、>、<、vs”比较前/);
  const q121R75Fallback = bundle.fallback(q121R74ProductionDraft, q121R74Audit);
  assert.doesNotMatch(q121R75Fallback, /\b[ABC]\s*(?:=|≠|>|<|vs)\s*[ABC]\b/);
  assert.match(q121R75Fallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.deepEqual(bundle.audit(q121R75Fallback, q121Question, todayAtomicRoute).violations, [], '未定义符号降级后只能发布具体观测名的安全终稿');

  const definedThreeWay = [
    '符号定义：A=页面，B=接口响应，C=本机日期星期。',
    '- A = B，但 B ≠ C：记录页面与响应一致、本机不同。',
    '- B = C，但 A ≠ B：记录响应与本机一致、页面不同。',
  ].join('\n');
  assert.ok(!bundle.audit(definedThreeWay, q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), '三边符号在比较前逐一定义时放行');

  const definedTwoWay = [
    'A 表示页面，B 表示接口响应。',
    'A vs B：只读对照两边原文。',
  ].join('\n');
  assert.ok(!bundle.audit(definedTwoWay, q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), '两边符号显式定义后允许vs');

  const numberedAndShortSymbols = [
    '①=页面，②=接口响应，甲=本机日期，乙=页面日期。',
    '① < ② 时只记录已有差异；甲 > 乙 时也只记录原文。',
  ].join('\n');
  assert.ok(!bundle.audit(numberedAndShortSymbols, q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), '圈号编号和短中文符号在比较前定义后放行');
  assert.ok(bundle.audit('① = ②，但甲 ≠ 乙。', q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), '未定义的圈号编号和短中文符号比较必须拦截');

  const symbolTable = [
    '| 符号 | 含义 |',
    '| --- | --- |',
    '| A | 页面 |',
    '| B | 接口响应 |',
    '| C | 本机日期星期 |',
    '',
    'A = B，B ≠ C。',
  ].join('\n');
  assert.ok(!bundle.audit(symbolTable, q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), '符号—含义表在前时放行');

  const namedComparisonTable = [
    '| 页面 | 接口响应 | 本机日期 |',
    '| --- | --- | --- |',
    '| 一致 | 一致 | 不一致 |',
  ].join('\n');
  assert.ok(!bundle.audit(namedComparisonTable, q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), '表头直接使用具体观测名不要求符号定义');

  const lateDefinition = 'A = B，但 B ≠ C。\n补充定义：A=页面，B=接口响应，C=本机日期。';
  assert.ok(bundle.audit(lateDefinition, q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), '比较后的事后定义不能反向补足前文');
  for (const harmless of [
    '数学常量写作 E=mc²。',
    '已有请求 HTTP 200，只记录状态码。',
    'JSON key 是 year/week，按原文保留。',
  ]) assert.ok(!bundle.audit(harmless, q121Question, todayAtomicRoute).violations.includes('undefined_symbolic_comparison'), harmless);

  const q121R76ProductionDraft = [
    '**先核三边**',
    '只读比较页面、已有接口响应和本机日期。',
    '请求成功 → 进入第 3 步。',
    '用下面三选一即可：',
    '- **B. 接口正确但页面不同。**',
    '- **C. 接口本身与本机不同。**',
    '把差异落在 A/B/C 哪一类。',
  ].join('\n');
  const q121R76Audit = bundle.audit(q121R76ProductionDraft, q121Question, todayAtomicRoute);
  assert.ok(q121R76Audit.violations.includes('undefined_arabic_step_reference'), '无1/2/3顶层定义时“进入第3步”必须拦截');
  assert.ok(q121R76Audit.violations.includes('incomplete_option_set'), '三选一实际仅B/C两项必须拦截');
  assert.ok(q121R76Audit.violations.includes('nonsequential_option_labels'), '字母选项B/C未从A起必须拦截');
  assert.ok(q121R76Audit.violations.includes('undefined_symbol_group_reference'), 'A/B/C归类中A未在此前定义必须拦截');
  assert.deepEqual(q121R76Audit.undefinedGroupReferences[0].undefinedSymbols, ['A']);
  const q121R77Fallback = bundle.fallback(q121R76ProductionDraft, q121R76Audit);
  assert.doesNotMatch(q121R77Fallback, /第\s*3\s*步|三选一|A\/B\/C|\bB\.|\bC\./);
  assert.deepEqual(bundle.audit(q121R77Fallback, q121Question, todayAtomicRoute).violations, [], '缺A的选项块与未定义步骤引用降级后不得残留');

  const validThreeOptions = [
    '用下面三选一即可：',
    'A. 页面与接口一致。',
    'B. 接口与本机一致。',
    'C. 三边均不同。',
    '把差异归到 A/B/C 中已定义的一类。',
  ].join('\n');
  assert.ok(!bundle.audit(validThreeOptions, q121Question, todayAtomicRoute).violations.some(item => ['incomplete_option_set', 'nonsequential_option_labels', 'undefined_symbol_group_reference'].includes(item)), '合法A/B/C三选一及后续归类放行');
  const sequentialButShort = '用下面三选一即可：\nA. 页面现象。\nB. 接口响应。';
  const sequentialButShortAudit = bundle.audit(sequentialButShort, q121Question, todayAtomicRoute);
  assert.ok(sequentialButShortAudit.violations.includes('incomplete_option_set'));
  const sequentialButShortFallback = bundle.fallback(sequentialButShort, sequentialButShortAudit);
  assert.match(sequentialButShortFallback, /下面二选一/);
  assert.match(sequentialButShortFallback, /A\. 页面现象|B\. 接口响应/);
  assert.ok(!bundle.audit(sequentialButShortFallback, q121Question, todayAtomicRoute).violations.includes('incomplete_option_set'), '选项从A连续时fallback只收敛声明数量，不补第三项');
  const validNumericOptions = '以下三类：\n1. 页面现象。\n2. 接口响应。\n3. 本机日期。';
  assert.ok(!bundle.audit(validNumericOptions, q121Question, todayAtomicRoute).violations.includes('incomplete_option_set'), '连续数字三类放行');
  const validCircledOptions = '以下三类：\n① 页面现象。\n② 接口响应。\n③ 本机日期。';
  assert.ok(!bundle.audit(validCircledOptions, q121Question, todayAtomicRoute).violations.includes('incomplete_option_set'), '连续圈号三类放行');
  assert.ok(!bundle.audit('请求成功后进入第 3 步。', '我已经做到第3步，现有请求成功后继续。', todayAtomicRoute).violations.includes('undefined_arabic_step_reference'), '用户本轮明确第3步时允许承接');
  assert.ok(bundle.audit('把差异归到 A/B。\nA. 页面。\nB. 接口。', q121Question, todayAtomicRoute).violations.includes('undefined_symbol_group_reference'), '后文选项定义不能反向补足前文A/B引用');
  for (const harmlessGroup of ['这是 A/B 测试结果。', 'API 文档里的 A/B 缩写保持原文。', '请求路径 /api/v1/a-b 已记录。']) {
    assert.ok(!bundle.audit(harmlessGroup, q121Question, todayAtomicRoute).violations.includes('undefined_symbol_group_reference'), harmlessGroup);
  }

  const fullyUnsafeDiagnosticDraft = [
    '多半是缓存或前端数据源故障。',
    '让开发改时区配置后重新进入页面复测。',
  ].join('\n');
  const fullyUnsafeDiagnosticAudit = bundle.audit(
    fullyUnsafeDiagnosticDraft,
    '今天视图和浏览器理解不一致，给我一个排查顺序。',
    todayAtomicRoute,
  );
  const fullyUnsafeDiagnosticFallback = bundle.fallback(fullyUnsafeDiagnosticDraft, fullyUnsafeDiagnosticAudit);
  assert.match(fullyUnsafeDiagnosticFallback, /已知事实（继续作为判断基线）/);
  assert.match(fullyUnsafeDiagnosticFallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.match(fullyUnsafeDiagnosticFallback, /1\. 原样记录当前页面/);
  assert.match(fullyUnsafeDiagnosticFallback, /4\. 整理上述原文与脱敏截图/);
  assert.doesNotMatch(fullyUnsafeDiagnosticFallback, /当前草稿未通过发布前|改时区配置/);
  assert.deepEqual(bundle.audit(fullyUnsafeDiagnosticFallback, '今天视图和浏览器理解不一致，给我一个排查顺序。', todayAtomicRoute).violations, [], '草稿全部被清理时，确定性诊断fallback自身也必须通过最终审计');

  const q210Question = 'HC1015 主要把医院哪些业务变化同步进审方？请按住院、诊断、医嘱、手术过敏、门诊和患者资料分组说明，别只列技术类名。当前仓库里这条链是否正在自动消费，实施能不能从审方页面手动触发；只看到处理代码能否认定生产已启用？现场发现数据没同步时，可以直接重放已有消息吗，失败消息手工补发又属于哪套功能？';
  const q210Route = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-DI-08', title: 'HC1015 HIS标准消息接入' },
    answerFacts: [
      'HC1015 处理代码覆盖 15 类医院业务变化：住院登记/取消、出院/取消、转科，诊断新增/删除，医嘱新增/状态/执行，手术、过敏，门诊挂号/退号和患者基础资料。',
      '仓内 RedisConsumer 的 HC1015 消费调用已注释，当前仓库没有激活的自动消费入口或前端触发入口；代码存在不能作为生产正在自动运行的证据。',
      '现场只核已有 HC1015 调用记录、HIS 返回日志和失败记录；未确认入口、幂等和副作用前不得主动重放。失败消息手工补发属于 DI-07。',
    ],
    mustNotConfuse: [
      '不得把处理类存在写成生产自动消费已启用。',
      '不得在未确认入口、幂等和副作用前建议重放已有消息。',
    ],
  };
  const q210Initial = bundle.audit('', q210Question, q210Route);
  assert.equal(q210Initial.verifiedFactsFallback, true);
  assert.equal(q210Initial.chainRequested, false, '“不能从页面触发；只看到代码”不得把普通的“从…看到”跨分句拼成从A到B研发链路');
  assert.deepEqual(q210Initial.missingChainDimensions, []);
  const q210Fallback = bundle.fallback('', q210Initial);
  assert.match(q210Fallback, /住院登记\/取消、出院\/取消、转科/);
  assert.match(q210Fallback, /代码存在不能作为生产正在自动运行的证据/);
  assert.match(q210Fallback, /失败消息手工补发属于 DI-07/);
  assert.deepEqual(bundle.audit(q210Fallback, q210Question, q210Route).violations, [], 'Q210 已核业务事实终稿必须直接通过最终审计');

  const debugAiQuestion = '关于AI审方生成，如果只有一次既有请求和响应、没有数据库权限，现有证据最多能判断到哪？';
  const debugAiRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-AI-01', title: 'AI 审方生成', fallbackMode: 'verifiedFacts' },
    answerFacts: ['AI 审方按 audit 场景读取当前门诊或住院任务上下文，经 Dify 工作流流式生成辅助建议，结果须由药师主动采纳。'],
  };
  const debugAiInitial = bundle.audit('', debugAiQuestion, debugAiRoute);
  const debugAiFallback = bundle.verifiedFallback(debugAiQuestion, debugAiRoute);
  assert.equal(debugAiInitial.verifiedFactsFallback, true);
  assert.equal(debugAiInitial.fallbackAnswerMode, 'partial_evidence');
  assert.ok(debugAiFallback, 'AI-01 受限证据问法在模型失败时应发布已核事实兜底');
  assert.match(debugAiFallback.reply, /^结论：现有受限证据只够固定/);
  assert.match(debugAiFallback.reply, /业务结论\n- AI 审方按 audit 场景/);
  assert.match(debugAiFallback.reply, /本轮未知/);
  assert.deepEqual(debugAiFallback.finalAudit.violations, []);
  for (const [questionId, question] of [
    ['Q0008', '我只有一次请求和响应，没有数据库权限，现有证据够不够判断 AI 审方是否落库？'],
    ['Q0013', '只有这张截图，证据够不够判断 AI 审方已经完成后续处理？'],
  ]) {
    const initial = bundle.audit(aiBroadFact, question, debugAiRoute);
    assert.equal(initial.fallbackAnswerMode, 'partial_evidence', `${questionId} 应识别为受限证据问法`);
    const fallback = bundle.verifiedFallback(question, debugAiRoute);
    assert.ok(fallback, `${questionId} 应有确定性安全 fallback`);
    assert.match(fallback.reply, /业务结论/);
    assert.match(fallback.reply, /本轮未知/);
    assert.deepEqual(fallback.finalAudit.violations, [], `${questionId} fallback 终审应全绿`);
  }

  const q0003Question = '关于AI 审方生成，我现在只有一次既有请求和响应，没有数据库权限。现有证据最多能判断到哪？';
  const q0003Route = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-AI-01', title: 'AI 审方生成', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '产品：门诊处方审核页和住院医嘱审核页都可点击“AI 解读”；内容以流式辅助文字展示，不会自动成为审核意见，只有药师点击“立即加入审核建议”才追加到当前意见框。',
      '入口：前端 lc-ai 组件每次生成创建 UUID 作为 bizId，使用 fetch 调用 POST /auditapi/comm/ai/generate，传入医院、患者/就诊、当前 taskId、sceneCode、source；门诊另传 recipeId。',
      '任务和警示：source=ipt 调用 getIptCurrentTask(taskId)，再按 hospitalId、patientId、visitId、null 和 iptSubmitId 调用 listOrderCautionByGroupNo；source=opt 调用 getOptCurrentTask(taskId)，再按 recipeId 调用 listCautionByOptRecipeId。',
      '外部依赖：服务端按 sceneCode 读取未删除且 open=true 的 audit_ai_scene，再把场景地址、场景密钥和上下文交给配置的 Dify 工作流，以 streaming 模式消费 text_chunk。',
      '生成记录：外调前插入 audit_ai_generate；首个有效文本块回写 task_id，流结束回写完整 content。这只能说明生成记录链，不能代替审核通过、打回、HIS 回传或药师采纳状态。',
      '停止：页面提交 POST /auditapi/ai/generate/stop?generateId={bizId}；服务端只有查到生成记录且已有 task_id 时才调用 Dify 停止。',
      '前端证据边界：只有浏览器 Network 的请求/响应和其中出现的 requestId 时，只能确认页面发起的请求及看到的 HTTP 状态、响应头和响应内容；不能据此确认场景开关、任务/警示读取、Dify 已接收或持续输出、生成记录已写入、停止已成功或药师已采纳。',
      '实施只读清单：记录当前页面和 opt/ipt 来源、任务/患者上下文、脱敏请求体、HTTP 状态与 Content-Type、流式首末块、时间和已有 requestId；再按时间和标识只读对照场景配置、服务端日志、生成记录 task_id/content 和有权限的 Dify 任务。不得重复提交真实业务、手工改生成记录或审核状态。',
      '端到端边界：页面 → fetch → AiController → 场景校验 → opt/ipt 任务与警示读取 → 中文 JSON → Dify 流 → 前端展示 → 生成记录回写 → 药师手动采纳；Dify 停止响应、迟到回调和统一 requestId 关联的处理，现有资料未定义，必须明确停住。',
    ],
  };
  const q0003UnsafeDraft = '现有请求正常就说明已经落库，建议重发一次请求再看结果。';
  const q0003Initial = bundle.audit(q0003UnsafeDraft, q0003Question, q0003Route);
  assert.ok(q0003Initial.violations.length, 'Q0003 不安全模型草稿应进入发布前修订/降级');
  const q0003Fallback = bundle.verifiedFallback(q0003Question, q0003Route);
  assert.ok(q0003Fallback, 'Q0003 9 条 AI-01 route facts 的 partial_evidence 兜底必须可发布');
  assert.equal(q0003Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0003Fallback.reply, /本轮未知/);
  assert.match(q0003Fallback.reply, /只能确认页面发起的请求/);
  assert.doesNotMatch(q0003Fallback.reply, /本轮未知\s*本轮未知[：:]/, 'partial evidence fallback 不得重复未知标题');
  assert.doesNotMatch(q0003Fallback.reply, /当前回答未通过发布前事实与动作安全校验/);
  assert.deepEqual(q0003Fallback.finalAudit.violations, [], 'Q0003 两轮模型失败后最终必须为已确认事实+未知边界，而非安全拒答占位');
  const q0003ExactQuestion = '另一轮独立复测（6）里，AI 审方生成现在是怎么实现的？';
  const q0003ExactFallback = bundle.modelFailureFallback(q0003ExactQuestion, q0003Route, { status: 429, message: 'rate limit' });
  assert.ok(q0003ExactFallback, 'Q0003 exact route+HTTP429 不能因“独立复测”实施受众误判而放弃事实兜底');
  assert.doesNotMatch(q0003ExactFallback.reply, /AI 暂时连不上/);
  assert.deepEqual(q0003ExactFallback.finalAudit.violations, [], 'Q0003 exact route+HTTP429 fallback 终审必须全绿');
  const q0003ChainQuestion = '把AI 审方生成从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。';
  const q0003ChainFallback = bundle.modelFailureFallback(q0003ChainQuestion, q0003Route, { status: 429, message: 'rate limit' });
  assert.ok(q0003ChainFallback, 'Q0003 AI-01 chain+HTTP429 必须使用已核链路兜底');
  assert.match(q0003ChainFallback.reply, /入口|接口/);
  assert.match(q0003ChainFallback.reply, /数据/);
  assert.match(q0003ChainFallback.reply, /外部依赖/);
  assert.match(q0003ChainFallback.reply, /Dify/);
  assert.match(q0003ChainFallback.reply, /当前停点|未定义|明确停住/);
  assert.doesNotMatch(q0003ChainFallback.reply, /医嘱标记|AI 暂时连不上/);
  assert.deepEqual(q0003ChainFallback.finalAudit.violations, [], 'Q0003 AI-01 chain fallback 终审必须全绿');
  const q0009ChainQuestion = '把AI 审方生成从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。';
  const productionRouteMap = JSON.parse(fs.readFileSync(
    path.resolve(ROOT, '../psp/audit/docs/specs/question-routes.json'), 'utf8',
  ));
  // 线上 loadModuleMap 读取的是带路径/章节引用的功能地图，而不是只含
  // route 摘要的 question-routes.json；真实回放必须把这些章节也装入 directEvidenceFacts。
  const productionRuntimeRouteMap = JSON.parse(execFileSync(
    'git', ['show', '2.7.260828-2:docs/specs/00-功能模块地图.json'],
    { cwd: path.resolve(ROOT, '../psp/audit'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  ));
  const q0009MatchedRoute = routeQuestion(productionRouteMap, q0009ChainQuestion);
  assert.equal(q0009MatchedRoute.route.id, 'AUD-QR-AI-01', 'Q0009 真实 route matcher 必须命中 AI-01');
  assert.equal(q0009MatchedRoute.answerFacts.length, 9, 'Q0009 应使用生产 route 的 9 条 AI-01 facts');
  assert.equal(q0009MatchedRoute.mustNotConfuse.length, 4, 'Q0009 应使用生产 route 的 4 条边界');
  const q0009ProductionRoute = runtimeRouteWithContext(q0009MatchedRoute);
  assert.equal(q0009ProductionRoute.directEvidenceFacts.length, 1, 'Q0009 routeContext+assemble 应注入 answerFacts 证据块');
  const q0009ProductionFallback = bundle.modelFailureFallback(q0009ChainQuestion, q0009ProductionRoute, { status: 429, message: 'rate limit' });
  assert.ok(q0009ProductionFallback, 'Q0009 生产 AI-01 route+HTTP429 必须使用已核链路兜底');
  assert.match(q0009ProductionFallback.reply, /入口|接口/);
  assert.match(q0009ProductionFallback.reply, /数据/);
  assert.match(q0009ProductionFallback.reply, /外部依赖|Dify/);
  assert.match(q0009ProductionFallback.reply, /生成记录/);
  assert.match(q0009ProductionFallback.reply, /当前停点|未定义|明确停住/);
  assert.doesNotMatch(q0009ProductionFallback.reply, /入口：入口/);
  assert.ok((q0009ProductionFallback.reply.match(/端到端边界/gu) || []).length <= 1, '端到端边界不能在链路和当前停点重复');
  assert.doesNotMatch(q0009ProductionFallback.reply, /各写操作的角色|外部系统、调用方与数据源仅按/);
  assert.doesNotMatch(q0009ProductionFallback.reply, /医嘱标记|AI 暂时连不上/);
  assert.deepEqual(q0009ProductionFallback.finalAudit.violations, [], 'Q0009 生产 AI-01 chain fallback 终审必须全绿');

  const q0008PartialQuestion = 'AI 审方生成这条链路只确认前端发出了请求，服务端后续日志还没拿到。先说能确定的，未知项请单独标出来。';
  const q0008MatchedRoute = routeQuestion(productionRouteMap, q0008PartialQuestion);
  assert.equal(q0008MatchedRoute.route.id, 'AUD-QR-AI-01', 'Q0008 真实 route matcher 必须命中 AI-01');
  const q0008RuntimeRoute = runtimeRouteWithContext(q0008MatchedRoute);
  const q0008Fallback = bundle.modelFailureFallback(q0008PartialQuestion, q0008RuntimeRoute, { status: 429, message: 'rate limit' });
  assert.ok(q0008Fallback, 'Q0008 只确认前端请求且缺服务端日志时 HTTP429 必须走 partial evidence 兜底');
  assert.equal(q0008Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0008Fallback.reply, /只能确认页面发起的请求/);
  assert.match(q0008Fallback.reply, /本轮未知/);
  assert.doesNotMatch(q0008Fallback.reply, /当前回答未通过发布前|AI 暂时连不上/);
  assert.deepEqual(q0008Fallback.finalAudit.violations, [], 'Q0008 partial evidence 确定性终稿必须终审全绿');

  const q0019ConfigChainQuestion = '把审核方案配置从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。';
  const q0019ConfigMatchedRoute = routeQuestion(productionRouteMap, q0019ConfigChainQuestion);
  assert.equal(q0019ConfigMatchedRoute.route.id, 'AUD-QR-CFG-01', 'Q0019 唯一完整业务标题应优先于高词频医嘱标记 route');
  assert.equal(q0019ConfigMatchedRoute.exactRouteTitle, true);
  const q0019ConfigFallback = bundle.modelFailureFallback(
    q0019ConfigChainQuestion,
    runtimeRouteWithContext(q0019ConfigMatchedRoute),
    { status: 429, message: 'rate limit' },
  );
  assert.ok(q0019ConfigFallback, 'Q0019 CFG-01 链路题模型失败时必须使用配置 route 事实兜底');
  assert.match(q0019ConfigFallback.reply, /审核方案配置|方案/);
  assert.doesNotMatch(q0019ConfigFallback.reply, /医嘱标记|audit_ipt_collect/);
  assert.deepEqual(q0019ConfigFallback.finalAudit.violations, [], 'Q0019 CFG-01 链路 fallback 终审必须全绿');
  const q0019UnsafeDraft = `${q0019ConfigFallback.reply}\n建议删除旧方案并重新提交。`;
  const q0019UnsafeAudit = bundle.audit(q0019UnsafeDraft, q0019ConfigChainQuestion, runtimeRouteWithContext(q0019ConfigMatchedRoute));
  assert.ok(q0019UnsafeAudit.violations.includes('cross_actor_side_effect'), 'Q0019 模型额外生成删除旧方案并重新提交时仍须拦截');

  // deterministic chain fallback 中若 route 事实本身含角色动作，动作门也必须
  // 逐条追溯到 route；不能因为 unsafeDirectActions 为空而由 every([]) 放行。
  const q0019ActorRoute = {
    ...q0019ConfigMatchedRoute,
    answerFacts: [
      ...q0019ConfigMatchedRoute.answerFacts,
      '实施：由运维重试后原失败状态不变。',
    ],
  };
  const q0019ActorFallback = bundle.modelFailureFallback(
    q0019ConfigChainQuestion,
    runtimeRouteWithContext(q0019ActorRoute),
    { status: 429, message: 'rate limit' },
  );
  assert.ok(q0019ActorFallback, 'route 已核角色动作也应能生成确定性链路兜底');
  assert.ok(q0019ActorFallback.finalAudit.unsafeActorActionCount > 0, '回归必须覆盖 unsafeActorActions 命中');
  assert.deepEqual(q0019ActorFallback.finalAudit.violations, [], 'route 事实中的角色动作逐条可追溯时才允许确定性兜底');
  const q0019ActorExtraDraft = `${q0019ActorFallback.reply}\n建议让运维重试并重新提交。`;
  const q0019ActorExtraAudit = bundle.audit(
    q0019ActorExtraDraft,
    q0019ConfigChainQuestion,
    runtimeRouteWithContext(q0019ActorRoute),
  );
  assert.ok(q0019ActorExtraAudit.violations.includes('cross_actor_side_effect'), '模型额外生成角色动作时仍须拦截');

  const browserRequirements = JSON.parse(fs.readFileSync(
    path.resolve(ROOT, 'tools/fixtures/audit-browser-1000.question-requirements.json'), 'utf8',
  )).questionToRequirements;
  for (const [questionId, prefix] of [['Q0006', '（6）'], ['Q0011', '（11）']]) {
    const exactQuestion = Object.keys(browserRequirements).find(question => question.includes(`另一轮独立复测${prefix}里，AI 审方生成现在是怎么实现的？`));
    assert.ok(exactQuestion, `${questionId} 应从真实浏览器题目 fixture 取到原问题`);
    const matched = routeQuestion(productionRouteMap, exactQuestion);
    assert.equal(matched.route.id, 'AUD-QR-AI-01', `${questionId} 真实 route matcher 必须命中 AI-01`);
    assert.equal(matched.answerFacts.length, 9, `${questionId} 应使用生产 route 的 9 条 AI-01 facts`);
    const runtimeRoute = runtimeRouteWithContext(matched);
    const fallback = bundle.modelFailureFallback(exactQuestion, runtimeRoute, { status: 429, message: 'rate limit' });
    assert.ok(fallback, `${questionId} HTTP429 时必须使用 facts 确定性兜底`);
    assert.equal(fallback.initialAudit.audienceMode, 'product', `${questionId} 评测前缀不能覆盖核心事实问法的产品受众`);
    assert.equal(fallback.initialAudit.fallbackAnswerMode, 'facts', `${questionId} 评测前缀不能把事实题降成 field_diagnostic`);
    assert.match(fallback.reply, /任务和警示|getIptCurrentTask|listOrderCautionByGroupNo/);
    assert.match(fallback.reply, /Dify/);
    assert.match(fallback.reply, /audit_ai_generate/);
    assert.match(fallback.reply, /generate\/stop|停止/);
    assert.deepEqual(fallback.finalAudit.violations, [], `${questionId} facts fallback 终审必须全绿`);
  }

  const q0177Question = Object.keys(browserRequirements).find(question => question.includes('另一轮独立复测（177）里，处方审核端到端主流程（HIS 接入→落库→分配→审核→回写）涉及哪些接口、数据和边界？'));
  assert.ok(q0177Question, 'Q0177 真实 fixture 题目应存在');
  const q0177MatchedRoute = routeQuestion(productionRouteMap, q0177Question);
  assert.equal(q0177MatchedRoute.route.id, 'AUD-QR-FLOW-01', 'Q0177 应命中处方审核端到端主流程');
  const q0177Route = runtimeRouteWithContext(q0177MatchedRoute);
  const q0177Initial = bundle.audit(q0177Route.answerFacts.join('\n'), q0177Question, q0177Route);
  assert.equal(q0177Initial.explicitReviewDiagnosticQuestion, true, 'Q0177 的独立复测前缀+接口/数据/边界应进入复测诊断');
  assert.equal(q0177Initial.fieldDiagnosticQuestion, true, 'Q0177 不应被 broad facts 门压回普通事实答复');
  assert.equal(q0177Initial.fallbackAnswerMode, 'field_diagnostic', 'Q0177 应使用现场诊断兜底');
  assert.equal(q0177Initial.diagnosticSequenceComplete, false, '只有 route facts 时 Q0177 应要求四步只读排查');
  const q0177Fallback = bundle.fallback(q0177Route.answerFacts.join('\n'), q0177Initial);
  assert.match(q0177Fallback, /1\. 原样记录当前页面/);
  assert.match(q0177Fallback, /2\. 只查看这次已经发生的请求与响应/);
  assert.match(q0177Fallback, /任务状态|日志/);
  assert.match(q0177Fallback, /audit-server|redis2db/);
  assert.match(q0177Fallback, /V1_OPT_AUDIT_QUERY|V1_IPT_AUDIT_QUERY|审核结果/);
  assert.match(q0177Fallback, /3\. 按“没有请求 \/ 请求失败 \/ 响应正常但页面不一致”/);
  assert.match(q0177Fallback, /4\. 整理上述原文与脱敏截图/);
  assert.match(q0177Fallback, /在线药师与有本院权限药师的交集/);
  assert.match(q0177Fallback, /1000 份权重.*平滑加权轮询/s);
  assert.match(q0177Fallback, /共同候选.*承接整批.*(?:没有|无)共同候选.*逐任务各自分配/s);
  assert.match(q0177Fallback, /没有总事务|失败类别不回滚/);
  assert.match(q0177Fallback, /audit_sync_error_flow/);
  assert.match(q0177Fallback, /sf_\* 表.*确认/);
  const q0177Final = bundle.audit(q0177Fallback, q0177Question, q0177Route);
  assert.equal(q0177Final.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0177Final.diagnosticSequenceComplete, true, 'Q0177 兜底必须包含四步只读顺序');
  assert.deepEqual(q0177Final.violations, [], 'Q0177 现场复测诊断兜底终审必须全绿');

  const q0179Question = Object.keys(browserRequirements).find(question => question.includes('另一轮独立复测（179）里，把处方审核端到端主流程（HIS 接入→落库→分配→审核→回写）从入口、接口或数据到外部依赖的链路串起来'));
  assert.ok(q0179Question, 'Q0179 真实 fixture 题目应存在');
  const q0179MatchedRoute = routeQuestion(productionRouteMap, q0179Question);
  assert.equal(q0179MatchedRoute.route.id, 'AUD-QR-FLOW-01', 'Q0179 应命中处方审核端到端主流程');
  const q0179Route = runtimeRouteWithContext(q0179MatchedRoute);
  const q0179Initial = bundle.audit(q0179Route.answerFacts.join('\n'), q0179Question, q0179Route);
  assert.equal(q0179Initial.explicitReviewDiagnosticQuestion, false, 'Q0179 链路串题不得被复测诊断规则抢走');
  assert.equal(q0179Initial.fieldDiagnosticQuestion, false, 'Q0179 应保留研发链路问法');
  assert.equal(q0179Initial.chainRequested, true, 'Q0179 应继续使用链路完整性合同');
  assert.deepEqual(q0179Initial.chainStageLabels, ['接入', '落库', '分配', '审核', '回写'], 'Q0179 应从标题括号/箭头提取业务阶段');
  const q0179Fallback = bundle.modelFailureFallback(q0179Question, q0179Route, { status: 429, message: 'rate limit' });
  assert.ok(q0179Fallback, 'Q0179 HTTP429 时必须使用链路事实兜底');
  assert.match(q0179Fallback.reply, /业务阶段「分配」/);
  assert.match(q0179Fallback.reply, /在线药师与有本院权限药师的交集/);
  assert.match(q0179Fallback.reply, /1000 份权重.*平滑加权轮询/s);
  assert.match(q0179Fallback.reply, /共同候选.*承接整批.*(?:没有|无)共同候选.*逐任务各自分配/s);
  assert.match(q0179Fallback.reply, /入口|接口|数据与状态|外部依赖/);
  assert.match(q0179Fallback.reply, /当前停点|NEEDS-HUMAN|资料明确的未知/);
  assert.deepEqual(q0179Fallback.finalAudit.violations, [], 'Q0179 链路 fallback 必须保留点名阶段事实并终审全绿');

  const q0195Question = Object.keys(browserRequirements).find(question => question === '回到待审列表批量通过与超时通过边界这里，第一层核过没有异常，下一步按什么顺序继续只读排查？');
  assert.ok(q0195Question, 'Q0195 真实 fixture 题目应存在');
  const q0195MatchedRoute = routeQuestion(productionRouteMap, q0195Question);
  assert.equal(q0195MatchedRoute.route.id, 'AUD-QR-FLOW-BATCH-PASS-01', 'Q0195 应命中批量通过与超时通过边界');
  const q0195Route = runtimeRouteWithContext(q0195MatchedRoute);
  const q0195Facts = q0195Route.answerFacts.join('\n');
  const q0195Initial = bundle.audit(q0195Facts, q0195Question, q0195Route);
  assert.equal(q0195Initial.continuationDiagnosticQuestion, true, 'Q0195 的上一层已核+下一步只读问法应进入通用续接诊断');
  assert.equal(q0195Initial.fieldDiagnosticQuestion, true, 'Q0195 不应只复述 route facts');
  assert.equal(q0195Initial.contextFollowupQuestion, true, 'Q0195 应标记为当前主题的上下文续问');
  assert.equal(q0195Initial.fallbackAnswerMode, 'field_diagnostic', 'Q0195 应使用现场诊断兜底');
  assert.equal(q0195Initial.diagnosticSequenceComplete, false, 'Q0195 只有 route facts 时应要求下一层四步只读顺序');
  const q0195FallbackReply = bundle.fallback(q0195Facts, q0195Initial);
  assert.match(q0195FallbackReply, /下一层只读排查顺序/);
  assert.match(q0195FallbackReply, /1\. 先沿用第一层/);
  assert.match(q0195FallbackReply, /2\. 再只读对照已经发生的当前操作请求与返回/);
  assert.match(q0195FallbackReply, /3\. 继续核对已有结果与页面刷新/);
  assert.match(q0195FallbackReply, /4\. 按“没有当前操作请求 \/ 请求失败或业务码异常 \/ 响应正常但结果或列表不一致”/);
  assert.match(q0195FallbackReply, /POST \/audit\/opt\/task\/pass/);
  assert.match(q0195FallbackReply, /POST \/audit\/ipt\/task\/pass/);
  assert.match(q0195FallbackReply, /\/audit\/opt\/tasks\/time\/over/);
  assert.match(q0195FallbackReply, /\/audit\/ipt\/tasks\/time\/over/);
  assert.match(q0195FallbackReply, /audit_pass/);
  assert.match(q0195FallbackReply, /time_over_pass/);
  assert.match(q0195FallbackReply, /不重新点击或提交/);
  assert.match(q0195FallbackReply, /不调用未被本次操作证明的接口/);
  assert.doesNotMatch(q0195FallbackReply, /(?:建议|应当|应该|让现场|直接)[^。！？\n]{0,20}(?:点击|提交|调用|触发|重试)/);
  const q0195Final = bundle.audit(q0195FallbackReply, q0195Question, q0195Route);
  assert.equal(q0195Final.diagnosticSequenceComplete, true, 'Q0195 兜底必须满足续接诊断顺序与观测分支');
  assert.deepEqual(q0195Final.violations, [], 'Q0195 续接诊断 fallback 终审必须全绿');

  const q0194Question = Object.keys(browserRequirements).find(question => question === '先切到另一个问题：“待审列表批量通过与超时通过边界”当前实现的关键入口或处理链是什么？');
  assert.ok(q0194Question, 'Q0194 真实 fixture 题目应存在');
  const q0194Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0194Question));
  const q0194Initial = bundle.audit(q0194Route.answerFacts.join('\n'), q0194Question, q0194Route);
  assert.equal(q0194Initial.continuationDiagnosticQuestion, false, '普通切题事实问法不得误判为续接诊断');
  assert.equal(q0194Initial.contextFollowupQuestion, false, '普通切题事实问法不得误标上下文续问');
  assert.notEqual(q0194Initial.fallbackAnswerMode, 'field_diagnostic', '普通切题事实问法不应扩写只读排查顺序');

  const q0205Question = Object.keys(browserRequirements).find(question => question === '关于批量审核的页面归属限制与后端授权缺口，如果接口返回有数据而页面没呈现，转开发前要整理哪些最小证据？');
  assert.ok(q0205Question, 'Q0205 真实 fixture 题目应存在');
  const q0205MatchedRoute = routeQuestion(productionRouteMap, q0205Question);
  assert.equal(q0205MatchedRoute.route.id, 'AUD-QR-FLOW-BATCH-AUTH-01', 'Q0205 应命中批量审核页面归属与授权边界');
  const q0205Route = runtimeRouteWithContext(q0205MatchedRoute);
  const q0205Initial = bundle.audit(q0205Route.answerFacts.join('\n'), q0205Question, q0205Route);
  assert.equal(q0205Initial.dataReturnedNotRenderedQuestion, true, 'Q0205 的接口有数据但页面未呈现问法应进入最小证据诊断');
  assert.equal(q0205Initial.fieldDiagnosticQuestion, true, 'Q0205 不应只复述页面授权 facts');
  assert.equal(q0205Initial.contextFollowupQuestion, true, 'Q0205 应标记为当前主题的上下文续问');
  assert.equal(q0205Initial.fallbackAnswerMode, 'field_diagnostic', 'Q0205 应使用现场诊断兜底');
  assert.equal(q0205Initial.diagnosticSequenceComplete, false, 'Q0205 只有 route facts 时应要求最小证据四步');
  const q0205FallbackReply = bundle.fallback(q0205Route.answerFacts.join('\n'), q0205Initial);
  assert.match(q0205FallbackReply, /转开发前最小只读证据顺序/);
  assert.match(q0205FallbackReply, /页面、筛选条件、账号角色、院区\/科室/);
  assert.match(q0205FallbackReply, /同一次已经发生的请求与响应/);
  assert.match(q0205FallbackReply, /请求参数|HTTP\/业务码|响应原文/);
  assert.match(q0205FallbackReply, /归属\/权限范围|页面筛选|渲染|禁选/);
  assert.match(q0205FallbackReply, /请求标识|时间|版本/);
  assert.match(q0205FallbackReply, /不试越权/);
  assert.match(q0205FallbackReply, /1\. |2\. |3\. |4\. /);
  const q0205Final = bundle.audit(q0205FallbackReply, q0205Question, q0205Route);
  assert.equal(q0205Final.diagnosticSequenceComplete, true, 'Q0205 兜底必须保留四步证据顺序');
  assert.deepEqual(q0205Final.violations, [], 'Q0205 最小证据 fallback 终审必须全绿');

  for (const [fixtureId, exactQuestion] of [
    ['Q0227', '另一轮独立复测（227）里，页面复选框不可选能否证明批量审核权限安全？'],
    ['Q0237', '另一轮独立复测（237）里，页面复选框不可选能否证明批量审核权限安全？'],
  ]) {
    const question = Object.keys(browserRequirements).find(item => item === exactQuestion);
    assert.ok(question, `${fixtureId} 真实 fixture 题目应存在`);
    const route = runtimeRouteWithContext(routeQuestion(productionRouteMap, question));
    assert.equal(route.route.id, 'AUD-QR-FLOW-BATCH-AUTH-01', `${fixtureId} 应命中批量审核页面归属与授权边界`);
    const initial = bundle.audit(route.answerFacts.join('\n'), question, route);
    assert.equal(initial.uiAuthorizationProofQuestion, true, `${fixtureId} 应识别“页面限制不能单独证明授权安全”证据题`);
    assert.equal(initial.fieldDiagnosticQuestion, true, `${fixtureId} 不应只复述权限风险 facts`);
    assert.equal(initial.fallbackAnswerMode, 'field_diagnostic', `${fixtureId} 应进入现场诊断兜底`);
    assert.equal(initial.authorizationDiagnosticLayersComplete, false, `${fixtureId} 只有风险 facts 时仍缺四层只读证据合同`);
    assert.equal(initial.diagnosticSequenceComplete, false, `${fixtureId} 只有 route facts 时应要求分层只读顺序`);
    const reply = bundle.fallback(route.answerFacts.join('\n'), initial);
    assert.match(reply, /页面控件不可操作只能证明当前页面限制生效，不能单独证明服务端授权安全/);
    assert.match(reply, /1\. 页面层：/);
    assert.match(reply, /2\. 请求层：/);
    assert.match(reply, /同一次已经发生的批量操作请求与响应/);
    assert.match(reply, /3\. 服务端授权层：/);
    assert.match(reply, /登录人归属、授权院区\/科室（病区）和操作前状态/);
    assert.match(reply, /4\. 留痕层：/);
    assert.match(reply, /任务状态、审核流水和记录时间/);
    assert.match(reply, /POST \/audit\/opt\|ipt\/task\/pass/);
    assert.match(reply, /owner、院区和 start_audit/);
    assert.doesNotMatch(reply, /(?:建议|应当|应该|让现场|直接)[^。！？\n]{0,24}(?:重新点击|提交|拼入|试越权)/);
    const final = bundle.audit(reply, question, route);
    assert.equal(final.authorizationDiagnosticLayersComplete, true, `${fixtureId} fallback 必须覆盖页面、请求、授权与流水四层`);
    assert.equal(final.diagnosticSequenceComplete, true, `${fixtureId} 分层只读兜底必须满足顺序门`);
    assert.deepEqual(final.violations, [], `${fixtureId} 分层只读兜底终审必须全绿`);
  }

  const genericUiAuthorizationQuestion = '界面上的操作按钮被禁用，是否足以说明服务端授权没有越权风险？';
  const genericUiAuthorizationRoute = {
    matched: true,
    route: { id: 'GENERIC-AUTH', title: '通用授权边界' },
    answerFacts: [
      '业务结论：页面限制只能约束正常操作入口。',
      '风险结论：服务端是否安全仍须核对当前请求对应的归属、授权范围和原状态校验。',
      '实施边界：只查看既有请求、响应、业务状态和审核流水，不用真实业务对象试越权。',
    ],
    mustNotConfuse: [],
    directEvidenceFacts: [],
  };
  const genericUiAuthorizationInitial = bundle.audit(
    genericUiAuthorizationRoute.answerFacts.join('\n'),
    genericUiAuthorizationQuestion,
    genericUiAuthorizationRoute,
  );
  assert.equal(genericUiAuthorizationInitial.uiAuthorizationProofQuestion, true, '通用按钮禁用+授权证明问法也应进入同一规则');
  assert.equal(genericUiAuthorizationInitial.fallbackAnswerMode, 'field_diagnostic', '通用权限证据题不应绑定审方 route');
  const ordinaryDisabledControlQuestion = '页面复选框为什么不可选？';
  const ordinaryDisabledControlAudit = bundle.audit(
    genericUiAuthorizationRoute.answerFacts.join('\n'),
    ordinaryDisabledControlQuestion,
    genericUiAuthorizationRoute,
  );
  assert.equal(ordinaryDisabledControlAudit.uiAuthorizationProofQuestion, false, '只问控件为何不可选时不得误扩成授权安全诊断');

  const q0257Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（257）里，任务状态流水消息和 HIS 回调是否在同一事务？');
  assert.ok(q0257Question, 'Q0257 真实 fixture 题目应存在');
  const q0257Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0257Question));
  assert.equal(q0257Route.route.id, 'AUD-QR-FLOW-BATCH-RETRY-01', 'Q0257 应命中批量失败与重复重试边界');
  const q0257Initial = bundle.audit(q0257Route.answerFacts.join('\n'), q0257Question, q0257Route);
  assert.equal(q0257Initial.multiStepTransactionDiagnosticQuestion, true, 'Q0257 多类副作用同一事务问法应进入通用现场诊断');
  assert.equal(q0257Initial.fieldDiagnosticQuestion, true, 'Q0257 不应只给事务事实结论');
  assert.equal(q0257Initial.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0257Initial.multiStageDiagnosticLayersComplete, false, 'Q0257 route facts 不能替代逐层只读步骤');
  assert.equal(q0257Initial.diagnosticSequenceComplete, false);
  const q0257Reply = bundle.fallback(q0257Route.answerFacts.join('\n'), q0257Initial);
  assert.match(q0257Reply, /多步结果的逐对象只读核对顺序/);
  assert.match(q0257Reply, /1\. 逐个对象核对主状态/);
  assert.match(q0257Reply, /2\. 接着核对审核流水/);
  assert.match(q0257Reply, /3\. 再核对 Redis 超时键或任务键/);
  assert.match(q0257Reply, /4\. 然后核对医生消息或通知记录/);
  assert.match(q0257Reply, /5\. 最后核对 HIS 或其它外部回调日志与结果/);
  assert.match(q0257Reply, /全程不写入业务数据、不重放消息或回调/);
  assert.match(q0257Reply, /不因页面或请求报错盲目整批重试/);
  const q0257Final = bundle.audit(q0257Reply, q0257Question, q0257Route);
  assert.equal(q0257Final.multiStageDiagnosticLayersComplete, true, 'Q0257 fallback 必须按状态、流水、键、消息、回调顺序完整覆盖');
  assert.equal(q0257Final.diagnosticSequenceComplete, true);
  assert.deepEqual(q0257Final.violations, [], 'Q0257 分层只读 fallback 终审必须全绿');

  const q0260Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（260）里，我没完全听懂批量审核中途失败与重复重试边界的排查建议，换成实施可以逐项照做的只读清单。');
  assert.ok(q0260Question, 'Q0260 真实 fixture 题目应存在');
  const q0260Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0260Question));
  assert.equal(q0260Route.route.id, 'AUD-QR-FLOW-BATCH-RETRY-01', 'Q0260 应命中批量失败与重复重试边界');
  const q0260Initial = bundle.audit(q0260Route.answerFacts.join('\n'), q0260Question, q0260Route);
  assert.equal(q0260Initial.implementationChecklistQuestion, true);
  assert.equal(q0260Initial.retryBoundaryChecklistQuestion, true, 'Q0260 应启用批量失败重试边界完整性门');
  assert.equal(q0260Initial.retryRiskFactsComplete, true, '原始 route facts 自身应完整覆盖四类重试风险');
  assert.equal(q0260Initial.diagnosticSequenceComplete, false, '只有 route facts 仍缺可执行顺序');
  const q0260Reply = bundle.fallback(q0260Route.answerFacts.join('\n'), q0260Initial);
  assert.match(q0260Reply, /不校验操作前原状态，没有业务幂等键，也没有并发锁/);
  assert.match(q0260Reply, /同一批对象再次进入处理可能重复产生审核流水、消息和外部回调/);
  assert.match(q0260Reply, /Redis 键清理自身幂等，但不能保证整次业务操作幂等/);
  assert.match(q0260Reply, /1\. 逐个对象核对主状态/);
  assert.match(q0260Reply, /2\. 接着核对审核流水/);
  assert.match(q0260Reply, /3\. 再核对 Redis 超时键或任务键/);
  assert.match(q0260Reply, /4\. 然后核对医生消息或通知记录/);
  assert.match(q0260Reply, /5\. 最后核对 HIS 或其它外部回调日志与结果/);
  const q0260Final = bundle.audit(q0260Reply, q0260Question, q0260Route);
  assert.equal(q0260Final.retryRiskFactsComplete, true);
  assert.equal(q0260Final.multiStageDiagnosticLayersComplete, true);
  assert.deepEqual(q0260Final.violations, [], 'Q0260 完整风险+只读清单 fallback 终审必须全绿');

  const q0260MissingRiskDraft = [
    '结论：先按已有记录逐项只读核对。',
    '1. 逐个对象核对主状态，只读记录当前值。',
    '2. 接着核对审核流水，记录数量和时间。',
    '3. 再核对 Redis 超时键或任务键，只读记录是否存在。',
    '4. 然后核对医生消息或通知记录，不补发消息。',
    '5. 最后核对 HIS 回调日志；全程不写入数据，也不盲目重试。',
  ].join('\n');
  const q0260MissingRiskAudit = bundle.audit(q0260MissingRiskDraft, q0260Question, q0260Route);
  assert.deepEqual(q0260MissingRiskAudit.missingRetryRiskCoverage, ['操作前状态校验', '幂等键与并发锁', '重复执行的外部副作用', '局部幂等不代表整体幂等']);
  assert.equal(q0260MissingRiskAudit.diagnosticSequenceComplete, false, '仅有五层步骤但漏 route 重试风险时仍不得发布');
  assert.ok(q0260MissingRiskAudit.violations.includes('incomplete_diagnostic_sequence'));

  const ordinarySingleTransactionQuestion = '单条审核流水写入是否在一个事务里？';
  const ordinarySingleTransactionAudit = bundle.audit(
    genericUiAuthorizationRoute.answerFacts.join('\n'),
    ordinarySingleTransactionQuestion,
    genericUiAuthorizationRoute,
  );
  assert.equal(ordinarySingleTransactionAudit.multiStepTransactionDiagnosticQuestion, false, '普通单对象事务事实题不得误扩成五层现场诊断');

  const q0210Question = Object.keys(browserRequirements).find(question => question === '我没完全听懂待审列表批量通过与超时通过边界的排查建议，换成实施可以逐项照做的只读清单。');
  assert.ok(q0210Question, 'Q0210 真实 fixture 题目应存在');
  const q0210Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0210Question));
  const q0210Initial = bundle.audit(q0210Route.answerFacts.join('\n'), q0210Question, q0210Route);
  assert.equal(q0210Initial.implementationChecklistQuestion, true, 'Q0210 的实施逐项只读清单问法应进入通用清单合同');
  assert.equal(q0210Initial.fieldDiagnosticQuestion, true, 'Q0210 应进入实施诊断');
  assert.equal(q0210Initial.contextFollowupQuestion, true, 'Q0210 应标记为上下文续问');
  assert.equal(q0210Initial.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0210Initial.diagnosticSequenceComplete, false, 'Q0210 标题或 facts 不能代替四步清单');
  const q0210FallbackReply = bundle.fallback(q0210Route.answerFacts.join('\n'), q0210Initial);
  assert.match(q0210FallbackReply, /最小只读排查/);
  assert.match(q0210FallbackReply, /1\. 原样记录当前页面/);
  assert.match(q0210FallbackReply, /2\. 只查看这次已经发生的请求与响应/);
  assert.match(q0210FallbackReply, /3\. 按“没有请求 \/ 请求失败 \/ 响应正常但页面或业务结果不一致”/);
  assert.match(q0210FallbackReply, /4\. 整理上述原文与脱敏截图/);
  assert.doesNotMatch(q0210FallbackReply, /(?:建议|应当|应该|让现场|直接)[^。！？\n]{0,20}(?:重新提交|调用|重试|改数据)/);
  const q0210Final = bundle.audit(q0210FallbackReply, q0210Question, q0210Route);
  assert.equal(q0210Final.diagnosticSequenceComplete, true, 'Q0210 只读清单必须通过序列完整性门');
  assert.deepEqual(q0210Final.violations, [], 'Q0210 实施清单 fallback 终审必须全绿');

  const q0220Question = Object.keys(browserRequirements).find(question => question === '待审列表批量通过与超时通过边界的请求是通的，但业务结果仍不符合预期。接下来重点对照哪一层？');
  assert.ok(q0220Question, 'Q0220 真实 fixture 题目应存在');
  const q0220Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0220Question));
  const q0220Initial = bundle.audit(q0220Route.answerFacts.join('\n'), q0220Question, q0220Route);
  assert.equal(q0220Initial.requestResultMismatchQuestion, true, 'Q0220 的请求成功但业务结果不符问法应进入分层诊断');
  assert.equal(q0220Initial.fieldDiagnosticQuestion, true, 'Q0220 不应只复述批量通过 facts');
  assert.equal(q0220Initial.contextFollowupQuestion, true, 'Q0220 应标记为上下文续问');
  assert.equal(q0220Initial.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0220Initial.diagnosticSequenceComplete, false, 'Q0220 只有 route facts 时应要求分层对照');
  const q0220FallbackReply = bundle.fallback(q0220Route.answerFacts.join('\n'), q0220Initial);
  assert.match(q0220FallbackReply, /分层只读对照顺序/);
  assert.match(q0220FallbackReply, /请求与响应/);
  assert.match(q0220FallbackReply, /业务状态和已有流水/);
  assert.match(q0220FallbackReply, /页面刷新、列表\/摘要/);
  assert.match(q0220FallbackReply, /相邻状态入口边界/);
  assert.match(q0220FallbackReply, /请求失败|响应正常但业务状态或流水未变|状态已变但页面或摘要未同步/);
  assert.doesNotMatch(q0220FallbackReply, /(?:建议|应当|应该|让现场|直接)[^。！？\n]{0,20}(?:重新提交|调用|重试|改数据)/);
  const q0220Final = bundle.audit(q0220FallbackReply, q0220Question, q0220Route);
  assert.equal(q0220Final.diagnosticSequenceComplete, true, 'Q0220 分层对照 fallback 必须满足顺序门');
  assert.deepEqual(q0220Final.violations, [], 'Q0220 请求成功结果不符 fallback 终审必须全绿');

  const q0206Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（206）里，待审处方批量通过算人工通过还是超时通过？');
  assert.ok(q0206Question, 'Q0206 真实事实反例应存在');
  const q0206Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0206Question));
  const q0206Initial = bundle.audit(q0206Route.answerFacts.join('\n'), q0206Question, q0206Route);
  assert.equal(q0206Initial.dataReturnedNotRenderedQuestion, false, '普通独立复测事实问法不得进入页面未呈现证据诊断');
  assert.equal(q0206Initial.implementationChecklistQuestion, false, '普通事实问法不得进入实施清单合同');
  assert.equal(q0206Initial.requestResultMismatchQuestion, false, '普通事实问法不得进入请求成功结果不符诊断');
  assert.equal(q0206Initial.contextFollowupQuestion, false, '普通独立复测事实问法不得误标上下文续问');
  assert.notEqual(q0206Initial.fallbackAnswerMode, 'field_diagnostic', '普通事实问法不应扩写只读排查顺序');

  const q0213Question = Object.keys(browserRequirements).find(question => question === '复测待审列表批量通过与超时通过边界时只有页面现象和 requestId，暂时没有原始日志。下一步最少还要补哪类只读证据？');
  assert.ok(q0213Question, 'Q0213 真实 fixture 题目应存在');
  const q0213Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0213Question));
  const q0213Initial = bundle.audit(q0213Route.answerFacts.join('\n'), q0213Question, q0213Route);
  assert.equal(q0213Route.route.id, 'AUD-QR-FLOW-BATCH-PASS-01', 'Q0213 应命中批量通过与超时通过边界');
  assert.equal(q0213Route.answerFacts.length, 4, 'Q0213 应使用紧凑 route 的四条完整事实');
  assert.equal(q0213Initial.minimalEvidenceQuestion, true, 'Q0213 页面现象+原始日志缺口应识别为最小证据题');
  assert.equal(q0213Initial.partialEvidenceQuestion, true, 'Q0213 应进入 partial_evidence');
  assert.equal(q0213Initial.fieldDiagnosticQuestion, false, 'Q0213 不应退成没有正文的整体现场拒答');
  assert.equal(q0213Initial.fallbackAnswerMode, 'partial_evidence');
  assert.equal(q0213Initial.minimumRoutePath, null, '多入口 route 不应伪造单一 minimumRoutePath');
  const q0213FallbackReply = bundle.fallback(q0213Route.answerFacts.join('\n'), q0213Initial);
  for (const fact of q0213Route.answerFacts) {
    if (/POST|time_over_pass|audit_pass|人工审核通过/u.test(fact)) assert.match(q0213FallbackReply, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(q0213FallbackReply, /最少补证（只读）/);
  assert.match(q0213FallbackReply, /同一次已经发生的请求及完整响应原文/);
  assert.match(q0213FallbackReply, /已有记录中的对象标识、状态和时间/);
  assert.match(q0213FallbackReply, /本轮只读边界：不改数据、不重放消息、不重提任务/);
  assert.match(q0213FallbackReply, /本轮未知/);
  const q0213Final = bundle.audit(q0213FallbackReply, q0213Question, q0213Route);
  assert.deepEqual(q0213Final.focusedTechnicalOverreach, [], '“待审列表”不得因“列”字误启用字段 sibling-token 收窄');
  assert.deepEqual(q0213Final.violations, [], 'Q0213 最小只读证据 fallback 终审必须全绿');

  const q0218Question = Object.keys(browserRequirements).find(question => question === '待审列表批量通过与超时通过边界现场暂时不能改数据、重放消息或重提任务。仅用已有记录应该怎样缩小范围？');
  assert.ok(q0218Question, 'Q0218 真实 fixture 题目应存在');
  const q0218Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0218Question));
  const q0218Initial = bundle.audit(q0218Route.answerFacts.join('\n'), q0218Question, q0218Route);
  assert.equal(q0218Route.route.id, 'AUD-QR-FLOW-BATCH-PASS-01', 'Q0218 应命中批量通过与超时通过边界');
  assert.equal(q0218Route.answerFacts.length, 4, 'Q0218 应使用紧凑 route 的四条完整事实');
  assert.equal(q0218Initial.partialEvidenceQuestion, true, 'Q0218 仅用已有记录问法应进入 partial_evidence');
  assert.equal(q0218Initial.explicitNonDestructiveBoundaryQuestion, true, 'Q0218 应识别不改数据/不重放/不重提边界');
  assert.equal(q0218Initial.fallbackAnswerMode, 'partial_evidence');
  const q0218FallbackReply = bundle.fallback(q0218Route.answerFacts.join('\n'), q0218Initial);
  for (const fact of q0218Route.answerFacts) {
    if (/POST|time_over_pass|audit_pass|人工审核通过/u.test(fact)) assert.match(q0218FallbackReply, new RegExp(fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(q0218FallbackReply, /本轮只读边界：不改数据、不重放消息、不重提任务/);
  assert.match(q0218FallbackReply, /当前门诊.*住院.*人工审核通过/);
  assert.match(q0218FallbackReply, /POST \/audit\/opt\/task\/pass/);
  assert.match(q0218FallbackReply, /POST \/audit\/ipt\/task\/pass/);
  assert.match(q0218FallbackReply, /\/audit\/opt\/tasks\/time\/over/);
  assert.match(q0218FallbackReply, /\/audit\/ipt\/tasks\/time\/over/);
  assert.match(q0218FallbackReply, /audit_pass/);
  assert.match(q0218FallbackReply, /time_over_pass/);
  const q0218Final = bundle.audit(q0218FallbackReply, q0218Question, q0218Route);
  assert.deepEqual(q0218Final.violations, [], 'Q0218 紧凑 route 只读范围 fallback 终审必须全绿');

  const q0011AiQuestion = Object.keys(browserRequirements).find(question => question.includes('另一轮独立复测（11）里，AI 审方生成现在是怎么实现的？'));
  assert.ok(q0011AiQuestion, 'Q0011 真实 fixture 题目应存在');
  const q0011AiRoute = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0011AiQuestion));
  const q0011GenericAnswer = [
    '两边的入口和行为先对齐：门诊处方审核页、住院医嘱审核页上都有“AI 解读”按钮，点开后看到的是一段流式滚动出来的辅助文字。',
    '它不会自动变成审核意见，只有药师点“立即加入审核建议”才会追加到当前意见框。',
    '系统按本次患者/就诊、当前任务、门诊或住院来源整理上下文，门诊还会带上处方信息，再交给配置好的 AI 工作流以流式方式返回页面。',
    '生成过程会留记录：请求发出前先记一条生成记录，首个有效内容块回来时回写任务标识，全部结束后回写完整内容。',
    '只看页面和网络请求时，只能确认页面发了请求、收到了什么响应；复测留证时记录当前来源、任务/患者上下文、脱敏请求内容、HTTP 状态和流式首末块。',
  ].join('\n');
  const q0011GenericAudit = bundle.audit(q0011GenericAnswer, q0011AiQuestion, q0011AiRoute);
  assert.ok(q0011GenericAudit.violations.includes('incomplete_verified_facts'), 'Q0011 只给产品概括时必须被实现事实覆盖门拦住');
  const q0011GenericFallback = bundle.fallback(q0011GenericAnswer, q0011GenericAudit);
  assert.match(q0011GenericFallback, /POST \/auditapi\/comm\/ai\/generate/);
  assert.match(q0011GenericFallback, /getIptCurrentTask|listOrderCautionByGroupNo/);
  assert.match(q0011GenericFallback, /sceneCode|audit_ai_scene/);
  assert.match(q0011GenericFallback, /audit_ai_generate/);
  assert.match(q0011GenericFallback, /generate\/stop\?generateId/);
  assert.match(q0011GenericFallback, /requestId/);
  assert.deepEqual(bundle.audit(q0011GenericFallback, q0011AiQuestion, q0011AiRoute).violations, [], 'Q0011 实现事实覆盖不足时应完整回落到 route facts 且终审全绿');

  const q0029Question = Object.keys(browserRequirements).find(question => question.includes('把评语常用语维护从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。'));
  assert.ok(q0029Question, 'Q0029 真实 fixture 题目应存在');
  const q0029Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0029Question), '2.7.260828-2');
  const q0029InitialAudit = bundle.audit('', q0029Question, q0029Route);
  const q0029FallbackAudit = bundle.audit(q0029InitialAudit.safeChainFallback, q0029Question, q0029Route);
  const q0029Fallback = bundle.modelFailureFallback(q0029Question, q0029Route, { status: 429, message: 'rate limit' });
  assert.ok(q0029Fallback, `Q0029 HTTP429 链路 fallback 必须可发布；violations=${JSON.stringify(q0029FallbackAudit.violations)}`);
  assert.match(q0029Fallback.reply, /audit_reply_template|评语常用语/);
  assert.match(q0029Fallback.reply, /\/auditapi\/audit\/templates|\/auditapi\/audit\/template/);
  assert.match(q0029Fallback.reply, /当前停点|本轮停在这里|未定义|明确停住/);
  assert.deepEqual(q0029Fallback.finalAudit.violations, [], 'Q0029 CFG-02 链路 fallback 终审必须全绿');

  // 真实 C006 不是新会话：前三轮已经回答过，Q0029 的模型 429 仍必须
  // 使用当前链路题的 route facts，不能被历史回答改写或退成连接错误。
  const q0029ConversationHistory = [
    { role: 'user', content: '评语常用语维护现在是怎么实现的？' },
    { role: 'assistant', content: '前一轮已答复业务范围。' },
    { role: 'user', content: '评语常用语维护涉及哪些接口、数据和边界？' },
    { role: 'assistant', content: '前一轮已答复接口、数据和边界。' },
    { role: 'user', content: '关于评语常用语维护，我现在只有一次既有请求和响应，没有数据库权限。现有证据最多能判断到哪？' },
    { role: 'assistant', content: '前一轮已答复受限证据边界。' },
    { role: 'user', content: q0029Question },
  ];
  const q0029HistoryMatchedRoute = contextualRouteQuestion(productionRuntimeRouteMap, q0029ConversationHistory, q0029Question);
  const q0029HistoryRoute = runtimeRouteWithRepositoryContext(q0029HistoryMatchedRoute, '2.7.260828-2');
  const q0029HistoryAudit = bundle.audit('', q0029Question, q0029HistoryRoute);
  const q0029HistoryFallback = bundle.modelFailureFallback(q0029Question, q0029HistoryRoute, { status: 429, message: 'rate limit' });
  assert.equal(q0029HistoryMatchedRoute.route?.id, 'AUD-QR-CFG-02', 'C006 历史会话的当前 Q0029 仍必须命中 CFG-02');
  assert.equal(q0029HistoryMatchedRoute.answerFacts.length, 7, 'C006 历史会话不能丢失 CFG-02 route facts');
  assert.ok(q0029HistoryFallback, `C006 Q0029 历史会话 HTTP429 必须使用 facts fallback；mode=${q0029HistoryAudit.fallbackAnswerMode}; violations=${JSON.stringify(bundle.audit(q0029HistoryAudit.safeChainFallback, q0029Question, q0029HistoryRoute).violations)}`);
  assert.doesNotMatch(q0029HistoryFallback.reply, /AI 暂时连不上/);
  assert.deepEqual(q0029HistoryFallback.finalAudit.violations, [], 'C006 Q0029 历史会话 fallback 终审必须全绿');

  const q0033Question = Object.keys(browserRequirements).find(question => question.includes('审核方案配置这条链路只确认前端发出了请求，服务端后续日志还没拿到。先说能确定的，未知项请单独标出来。'));
  assert.ok(q0033Question, 'Q0033 真实 fixture 题目应存在');
  const q0033Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0033Question), '2.7.260828-2');
  const q0033InitialAudit = bundle.audit('', q0033Question, q0033Route);
  const q0033FallbackAudit = bundle.audit(q0033InitialAudit.safeDiagnosticFallback, q0033Question, q0033Route);
  const q0033DeterministicReply = bundle.fallback('', q0033InitialAudit);
  const q0033DeterministicAudit = bundle.audit(q0033DeterministicReply, q0033Question, q0033Route);
  const q0033Fallback = bundle.modelFailureFallback(q0033Question, q0033Route, { status: 429, message: 'rate limit' });
  assert.ok(q0033Fallback, `Q0033 HTTP429 partial evidence fallback 必须可发布；mode=${q0033InitialAudit.fallbackAnswerMode}; safe=${JSON.stringify(q0033InitialAudit.safeDiagnosticFallback)}; safeViolations=${JSON.stringify(q0033FallbackAudit.violations)}; deterministic=${JSON.stringify(q0033DeterministicReply)}; deterministicViolations=${JSON.stringify(q0033DeterministicAudit.violations)}`);
  assert.equal(q0033Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0033Fallback.reply, /现有受限证据|本轮未知/);
  assert.doesNotMatch(q0033Fallback.reply, /当前回答未通过发布前|AI 暂时连不上/);
  assert.deepEqual(q0033Fallback.finalAudit.violations, [], 'Q0033 CFG-01 partial evidence fallback 终审必须全绿');

  const q0068Question = Object.keys(browserRequirements).find(question => question === 'XML报文解析集成现场暂时不能改数据、重放消息或重提任务。仅用已有记录应该怎样缩小范围？');
  assert.ok(q0068Question, 'Q0068 应从真实浏览器题目 fixture 取到原问题');
  const q0068ConversationHistory = [
    { role: 'user', content: 'XML报文解析集成现在是怎么实现的？' },
    { role: 'assistant', content: '前一轮已答复 XML 解析业务事实。' },
    { role: 'user', content: 'XML报文解析集成涉及哪些接口、数据和边界？' },
    { role: 'assistant', content: '前一轮已答复 XML 接口、数据和边界。' },
    { role: 'user', content: q0068Question },
  ];
  const q0068MatchedRoute = contextualRouteQuestion(productionRuntimeRouteMap, q0068ConversationHistory, q0068Question);
  assert.equal(q0068MatchedRoute.route.id, 'AUD-QR-DI-03', 'C014 Q0068 历史会话当前 route 必须命中 DI-03');
  assert.equal(q0068MatchedRoute.answerFacts.length, 8, 'C014 Q0068 不能因前两轮历史丢失 DI-03 facts');
  const q0068Route = runtimeRouteWithRepositoryContext(q0068MatchedRoute, '2.7.260828-2');
  const q0068Initial = bundle.audit('', q0068Question, q0068Route);
  const q0068SafeAudit = bundle.audit(q0068Initial.safeDiagnosticFallback, q0068Question, q0068Route);
  const q0068Fallback = bundle.modelFailureFallback(q0068Question, q0068Route, { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限' });
  assert.ok(q0068Fallback, `C014 Q0068 模型截断时必须发布 DI-03 只读兜底；mode=${q0068Initial.fallbackAnswerMode}; safeViolations=${JSON.stringify(q0068SafeAudit.violations)}`);
  assert.equal(q0068Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0068Fallback.reply, /格式合法|必需节点|业务落库/);
  assert.match(q0068Fallback.reply, /请求日志|响应日志|已有记录/);
  assert.match(q0068Fallback.reply, /只读|本轮未知|不能单独/);
  assert.match(q0068Fallback.reply, /本轮只读边界：不改数据/);
  assert.match(q0068Fallback.reply, /不重放消息/);
  assert.match(q0068Fallback.reply, /不重提任务/);
  assert.doesNotMatch(q0068Fallback.reply, /AI 暂时连不上|当前回答未通过发布前/);
  assert.deepEqual(q0068Fallback.finalAudit.violations, [], 'C014 Q0068 DI-03 partial evidence 历史会话 fallback 终审必须全绿');
  const q0068PositiveReplay = bundle.audit('建议让现场重新提交业务数据以补日志。', q0068Question, q0068Route);
  assert.ok(q0068PositiveReplay.violations.includes('cross_actor_side_effect'), '明确建议重提仍必须拦截');

  const q0069ChainQuestion = Object.keys(browserRequirements).find(question => question === '把XML报文解析集成从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。');
  assert.ok(q0069ChainQuestion, 'Q0069 应从真实浏览器题目 fixture 取到原问题');
  const q0069ChainHistory = [
    { role: 'user', content: 'XML报文解析集成现在是怎么实现的？' },
    { role: 'assistant', content: '前一轮已答复 XML 解析业务事实。' },
    { role: 'user', content: 'XML报文解析集成涉及哪些接口、数据和边界？' },
    { role: 'assistant', content: '前一轮已答复 XML 接口、数据和边界。' },
    { role: 'user', content: q0069ChainQuestion },
  ];
  const q0069ChainMatchedRoute = contextualRouteQuestion(productionRuntimeRouteMap, q0069ChainHistory, q0069ChainQuestion);
  assert.equal(q0069ChainMatchedRoute.route.id, 'AUD-QR-DI-03', 'C014 Q0069 历史会话当前 route 必须命中 DI-03');
  assert.equal(q0069ChainMatchedRoute.answerFacts.length, 8, 'C014 Q0069 不能因历史上下文丢失 DI-03 facts');
  const q0069ChainRoute = runtimeRouteWithRepositoryContext(q0069ChainMatchedRoute, '2.7.260828-2');
  const q0069ChainInitial = bundle.audit('', q0069ChainQuestion, q0069ChainRoute);
  const q0069ChainFallbackAudit = bundle.audit(q0069ChainInitial.safeChainFallback, q0069ChainQuestion, q0069ChainRoute);
  const q0069ChainFallback = bundle.modelFailureFallback(q0069ChainQuestion, q0069ChainRoute, { status: 429, message: 'rate limit' });
  assert.ok(q0069ChainFallback, `C014 Q0069 HTTP429 链路 fallback 必须可发布；mode=${q0069ChainInitial.fallbackAnswerMode}; safeViolations=${JSON.stringify(q0069ChainFallbackAudit.violations)}`);
  assert.match(q0069ChainFallback.reply, /XML|格式合法|节点/);
  assert.match(q0069ChainFallback.reply, /接口：本轮 route 已核事实未提供可发布的接口细节|接口/);
  assert.match(q0069ChainFallback.reply, /外部依赖：本轮 route 已核事实未提供可发布的外部依赖细节|外部依赖/);
  assert.match(q0069ChainFallback.reply, /当前停点|本轮停在这里|未定义|明确停住/);
  assert.doesNotMatch(q0069ChainFallback.reply, /XmlParserActuator|getNodeList|NodeList|Java/);
  assert.deepEqual(q0069ChainFallback.finalAudit.violations, [], 'C014 Q0069 DI-03 链路 fallback 终审必须全绿');

  const q0078Question = Object.keys(browserRequirements).find(question => question === '关于住院医嘱自动通过，我现在只有一次既有请求和响应，没有数据库权限。现有证据最多能判断到哪？');
  assert.ok(q0078Question, 'Q0078 应从真实浏览器题目 fixture 取到原问题');
  const q0078Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0078Question), '2.7.260828-2');
  assert.equal(q0078Route.route.id, 'AUD-QR-DI-04', 'C016 Q0078 必须命中住院医嘱自动通过 route');
  assert.equal(q0078Route.answerFacts.length, 6, 'C016 Q0078 必须保留 DI-04 受限证据 facts');
  const q0078Initial = bundle.audit('', q0078Question, q0078Route);
  const q0078FallbackAudit = bundle.audit(q0078Initial.safeDiagnosticFallback, q0078Question, q0078Route);
  const q0078Fallback = bundle.modelFailureFallback(q0078Question, q0078Route, { status: 429, message: 'rate limit' });
  assert.ok(q0078Fallback, `C016 Q0078 HTTP429 时必须发布 DI-04 partial evidence 兜底；mode=${q0078Initial.fallbackAnswerMode}; safeViolations=${JSON.stringify(q0078FallbackAudit.violations)}`);
  assert.equal(q0078Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0078Fallback.reply, /住院自动通过|AUDIT:IPT:AUTO|已有请求|响应/);
  assert.match(q0078Fallback.reply, /数据库|本轮未知|不能单独/);
  assert.doesNotMatch(q0078Fallback.reply, /AI 暂时连不上|当前回答未通过发布前/);
  assert.deepEqual(q0078Fallback.finalAudit.violations, [], 'C016 Q0078 DI-04 partial evidence fallback 终审必须全绿');

  const q0173Question = Object.keys(browserRequirements).find(question => question === '先别把门诊处方自动通过的原因说死：当前只有接口状态和业务返回，哪些结论成立，哪些仍需确认？');
  assert.ok(q0173Question, 'Q0173 应从真实浏览器题目 fixture 取到原问题');
  const q0173Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0173Question), '2.7.260828-2');
  assert.equal(q0173Route.route.id, 'AUD-QR-DI-05', 'Q0173 必须命中门诊处方自动通过 route');
  const q0173FullFacts = q0173Route.answerFacts.join('\n');
  const q0173Initial = bundle.audit(q0173FullFacts, q0173Question, q0173Route);
  assert.equal(q0173Initial.fallbackAnswerMode, 'partial_evidence', 'Q0173 “当前只有…哪些成立/仍需确认”应识别为 partial_evidence');
  assert.ok(q0173Initial.violations.includes('missing_evidence_sufficiency_verdict'), 'Q0173 只罗列 route facts 时必须补证据充分性边界');
  const q0173Fallback = bundle.modelFailureFallback(q0173Question, q0173Route, { status: 429, message: 'rate limit' });
  assert.ok(q0173Fallback, 'Q0173 HTTP429 时必须使用门诊自动通过 route facts 确定性兜底');
  assert.match(q0173Fallback.reply, /现有受限证据只够|现有受限证据/);
  assert.match(q0173Fallback.reply, /本轮未知/);
  assert.match(q0173Fallback.reply, /不能单独|仍需|待补充|具体细节/);
  assert.match(q0173Fallback.reply, /门诊处方自动通过|RedisConsumer|AUDIT:OPT:AUTO/);
  assert.match(q0173Fallback.reply, /未覆盖|生命体征|影像|费用结算|收费明细/);
  assert.match(q0173Fallback.reply, /坏 JSON|队首|阻塞/);
  assert.match(q0173Fallback.reply, /总事务|部分成功|只读|未经授权/);
  assert.deepEqual(q0173Fallback.finalAudit.violations, [], 'Q0173 partial evidence fallback 必须明确已知/未知并终审全绿');

  const q0039Question = Object.keys(browserRequirements).find(question => question.includes('把药师个人审核方案从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。'));
  assert.ok(q0039Question, 'Q0039 真实 fixture 题目应存在');
  const q0039Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0039Question), '2.7.260828-2');
  const q0039InitialAudit = bundle.audit('', q0039Question, q0039Route);
  const q0039FallbackAudit = bundle.audit(q0039InitialAudit.safeChainFallback, q0039Question, q0039Route);
  const q0039Fallback = bundle.modelFailureFallback(q0039Question, q0039Route, { status: 429, message: 'rate limit' });
  assert.ok(q0039Fallback, `Q0039 HTTP429 链路 fallback 必须可发布；route=${q0039Route.route?.id}; safeViolations=${JSON.stringify(q0039FallbackAudit.violations)}`);
  assert.match(q0039Fallback.reply, /入口：本轮 route 已核事实未提供可发布的入口细节/);
  assert.match(q0039Fallback.reply, /接口：本轮 route 已核事实未提供可发布的接口细节/);
  assert.match(q0039Fallback.reply, /外部依赖：本轮 route 已核事实未提供可发布的外部依赖细节/);
  assert.doesNotMatch(q0039Fallback.reply, /GET |POST |PUT |DELETE /, 'route 未提供接口时不能臆造方法和路径');
  assert.match(q0039Fallback.reply, /当前停点|本轮停在这里|未定义|明确停住/);
  assert.deepEqual(q0039Fallback.finalAudit.violations, [], 'Q0039 个人审核方案链路 fallback 终审必须全绿');

  const qCfgEvidenceQuestion = '审核方案配置现场暂时不能改数据、重放消息或重提任务。仅用已有记录应该怎样缩小范围？';
  const qCfgMatchedRoute = routeQuestion(productionRouteMap, qCfgEvidenceQuestion);
  assert.equal(qCfgMatchedRoute.route.id, 'AUD-QR-CFG-01', 'C004 真实 route matcher 必须命中 CFG-01');
  assert.equal(qCfgMatchedRoute.answerFacts.length, 10, 'C004 应使用生产 route 的 10 条 CFG-01 facts');
  const qCfgProductionRoute = runtimeRouteWithContext(qCfgMatchedRoute);
  const qCfgFallback = bundle.modelFailureFallback(qCfgEvidenceQuestion, qCfgProductionRoute, { status: 429, message: 'rate limit' });
  assert.ok(qCfgFallback, 'CFG-01 只读已有记录问法+HTTP429 必须使用已核事实兜底');
  assert.match(qCfgFallback.reply, /已核事实|现有记录|只读|未知|不能确认/);
  assert.doesNotMatch(qCfgFallback.reply, /AI 暂时连不上/);
  assert.deepEqual(qCfgFallback.finalAudit.violations, [], 'CFG-01 只读已有记录 fallback 终审必须全绿');

  const q0015Question = Object.keys(browserRequirements).find(question => question === '我没完全听懂采集异常处理的排查建议，换成实施可以逐项照做的只读清单。');
  assert.ok(q0015Question, 'Q0015 应从真实浏览器题目 fixture 取到原问题');
  const q0015MatchedRoute = routeQuestion(productionRouteMap, q0015Question);
  assert.equal(q0015MatchedRoute.route.id, 'AUD-QR-DI-07', 'Q0015 真实 route matcher 必须命中 DI-07');
  assert.equal(q0015MatchedRoute.answerFacts.length, 5, 'Q0015 应使用生产 route 的 5 条 DI-07 facts');
  const q0015ProductionRoute = runtimeRouteWithContext(q0015MatchedRoute);
  const q0015Fallback = bundle.modelFailureFallback(q0015Question, q0015ProductionRoute, { status: 429, message: 'rate limit' });
  assert.ok(q0015Fallback, 'Q0015 HTTP429 时必须使用 DI-07 只读清单兜底');
  assert.match(q0015Fallback.reply, /生产包|发布记录/);
  assert.match(q0015Fallback.reply, /运维确认|运维授权/);
  assert.match(q0015Fallback.reply, /未经运维授权不得/);
  assert.match(q0015Fallback.reply, /后续调用仍会命中/);
  assert.match(q0015Fallback.reply, /audit_sync_error_flow/);
  assert.match(q0015Fallback.reply, /另一套|不由.*统一处理/);
  assert.deepEqual(q0015Fallback.finalAudit.violations, [], 'Q0015 DI-07 只读清单 fallback 终审必须全绿');

  const q0147Question = Object.keys(browserRequirements).find(question => question === '先不转开发，导出请求是 200，下载下来的文件却打不开，这个问题实施还能怎么往下定位？');
  assert.ok(q0147Question, 'Q0147 应从真实浏览器题目 fixture 取到原问题');
  const q0147History = [
    { role: 'user', content: '导出接口返回 200 就算成功了吗？' },
    { role: 'assistant', content: '前一轮已回答下载与导出文件验收边界。' },
    { role: 'user', content: q0147Question },
  ];
  const q0147MatchedRoute = contextualRouteQuestion(productionRuntimeRouteMap, q0147History, q0147Question);
  assert.equal(q0147MatchedRoute.route.id, 'AUD-QR-GUIDE-04', 'C030 Q0147 历史会话当前 route 必须命中 GUIDE-04');
  assert.equal(q0147MatchedRoute.answerFacts.length, 4, 'C030 Q0147 必须保留 GUIDE-04 全部已核事实');
  const q0147Route = runtimeRouteWithRepositoryContext(q0147MatchedRoute, '2.7.260828-2');
  const q0147Initial = bundle.audit('', q0147Question, q0147Route);
  const q0147SafeAudit = bundle.audit(q0147Initial.safeDiagnosticFallback, q0147Question, q0147Route);
  const q0147Fallback = bundle.modelFailureFallback(q0147Question, q0147Route, { status: 429, message: 'rate limit' });
  assert.ok(q0147Fallback, `C030 Q0147 HTTP429 实施只读追问必须发布 GUIDE-04 确定性兜底；mode=${q0147Initial.fallbackAnswerMode}; safeViolations=${JSON.stringify(q0147SafeAudit.violations)}`);
  assert.equal(q0147Fallback.initialAudit.fallbackAnswerMode, 'field_diagnostic');
  assert.match(q0147Fallback.reply, /HTTP 200|响应体|bytes|文件签名|MIME|结构|正文/);
  assert.doesNotMatch(q0147Fallback.reply, /(?:建议|请|让|尝试|可以|应该|应当)[^。！？\n]{0,20}(?:重复导出|重新导出|修改权限|修改模板|修改业务数据)/);
  assert.doesNotMatch(q0147Fallback.reply, /AI 暂时连不上|当前回答未通过发布前/);
  assert.deepEqual(q0147Fallback.finalAudit.violations, [], 'C030 Q0147 GUIDE-04 field diagnostic fallback 终审必须全绿');

  const q0106Question = Object.keys(browserRequirements).find(question => question === '采集异常处理现在是怎么实现的？');
  assert.ok(q0106Question, 'Q0106 应从真实浏览器题目 fixture 取到原问题');
  const q0106Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0106Question), '2.7.260828-2');
  assert.equal(q0106Route.route.id, 'AUD-QR-DI-07', 'Q0106 必须命中 DI-07');
  assert.equal(q0106Route.answerFacts.length, 5, 'Q0106 必须保留 DI-07 全部已核事实');
  const q0106Fallback = bundle.modelFailureFallback(q0106Question, q0106Route, { status: 429, message: 'rate limit' });
  assert.ok(q0106Fallback, 'Q0106 普通实现问法 HTTP429 时必须使用完整事实兜底');
  assert.match(q0106Fallback.reply, /生产包|发布记录/);
  assert.match(q0106Fallback.reply, /访问.*日志|访问日志|失败记录/);
  assert.match(q0106Fallback.reply, /运维确认|运维授权/);
  assert.match(q0106Fallback.reply, /未经运维授权不得|未经.*授权.*重新调用/);
  assert.match(q0106Fallback.reply, /audit_sync_error_flow/);
  assert.match(q0106Fallback.reply, /另一套|不由.*统一处理/);
  assert.deepEqual(q0106Fallback.finalAudit.violations, [], 'Q0106 DI-07 普通实现事实 fallback 终审必须全绿');
  const q0106IncompleteDraft = '采集异常处理在审方页面没有菜单或一键补发按钮；调用 GET /comm/deal/error，当前无定时自动重试；住院/门诊处方采集的 audit_sync_error_flow 属于另一套错误机制，不由这个 HC1015 补发入口统一处理。';
  const q0106IncompleteAudit = bundle.audit(q0106IncompleteDraft, q0106Question, q0106Route);
  assert.ok(q0106IncompleteAudit.violations.includes('incomplete_verified_facts'), 'Q0106 普通实现草稿漏掉生产/授权边界时必须被覆盖门拦截');
  const q0106IncompleteFallback = bundle.fallback(q0106IncompleteDraft, q0106IncompleteAudit);
  assert.match(q0106IncompleteFallback, /生产包|发布记录/);
  assert.match(q0106IncompleteFallback, /运维确认|运维授权/);
  assert.match(q0106IncompleteFallback, /未经运维授权不得|未经.*授权.*重新调用/);
  assert.deepEqual(bundle.audit(q0106IncompleteFallback, q0106Question, q0106Route).violations, [], 'Q0106 普通实现草稿修订后必须完整覆盖 DI-07 关键边界并终审全绿');

  const q0108Question = Object.keys(browserRequirements).find(question => question === '采集异常处理这条链路只确认前端发出了请求，服务端后续日志还没拿到。先说能确定的，未知项请单独标出来。');
  assert.ok(q0108Question, 'Q0108 应从真实浏览器题目 fixture 取到原问题');
  const q0108Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0108Question), '2.7.260828-2');
  assert.equal(q0108Route.route.id, 'AUD-QR-DI-07', 'Q0108 必须命中 DI-07');
  const q0108Fallback = bundle.modelFailureFallback(q0108Question, q0108Route, { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限' });
  assert.ok(q0108Fallback, 'Q0108 partial evidence 截断时必须使用已核事实兜底');
  assert.equal(q0108Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0108Fallback.reply, /现有受限证据|本轮未知/);
  assert.match(q0108Fallback.reply, /audit_sync_error_flow/);
  assert.match(q0108Fallback.reply, /另一套|不由.*统一处理/);
  assert.match(q0108Fallback.reply, /请求|响应|前端/);
  assert.doesNotMatch(q0108Fallback.reply, /AI 暂时连不上|当前回答未通过发布前/);
  assert.deepEqual(q0108Fallback.finalAudit.violations, [], 'Q0108 DI-07 partial evidence fallback 终审必须全绿');

  const q0118Question = Object.keys(browserRequirements).find(question => question === '采集异常处理现场暂时不能改数据、重放消息或重提任务。仅用已有记录应该怎样缩小范围？');
  assert.ok(q0118Question, 'Q0118 应从真实浏览器题目 fixture 取到原问题');
  const q0118Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0118Question), '2.7.260828-2');
  assert.equal(q0118Route.route.id, 'AUD-QR-DI-07', 'Q0118 必须命中 DI-07');
  const q0118Fallback = bundle.modelFailureFallback(q0118Question, q0118Route, { status: 429, message: 'rate limit' });
  assert.ok(q0118Fallback, 'Q0118 只读已有记录 HTTP429 时必须使用已核事实兜底');
  assert.equal(q0118Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0118Fallback.reply, /生产包|发布记录|访问.*日志|失败记录/);
  assert.match(q0118Fallback.reply, /audit_sync_error_flow/);
  assert.match(q0118Fallback.reply, /另一套|不由.*统一处理/);
  assert.match(q0118Fallback.reply, /不改数据|不重放消息|不重提任务/);
  assert.deepEqual(q0118Fallback.finalAudit.violations, [], 'Q0118 DI-07 只读已有记录 fallback 终审必须全绿');

  const q0030Question = Object.keys(browserRequirements).find(question => question === '评语常用语维护这一步只能确认现象稳定复现，不能做写操作。现在应停在哪个边界并交给谁继续？');
  assert.ok(q0030Question, 'Q0030 应从真实浏览器题目 fixture 取到原问题');
  const q0030Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0030Question), '2.7.260828-2');
  assert.equal(q0030Route.route.id, 'AUD-QR-CFG-02', 'Q0030 真实 route matcher 必须命中 CFG-02');
  const q0030Initial = bundle.audit('', q0030Question, q0030Route);
  const q0030Fallback = bundle.modelFailureFallback(q0030Question, q0030Route, { status: 429, message: 'rate limit' });
  assert.ok(q0030Fallback, `Q0030 点名交接对象时 HTTP429 必须使用只读兜底；safeViolations=${JSON.stringify(bundle.audit(q0030Initial.safeDiagnosticFallback, q0030Question, q0030Route).violations)}`);
  assert.match(q0030Fallback.reply, /对应功能的产品负责人/);
  assert.match(q0030Fallback.reply, /研发\/接口负责人/);
  assert.match(q0030Fallback.reply, /只读|已有请求|证据/);
  assert.doesNotMatch(q0030Fallback.reply, /张三|李四|某某医院/);
  assert.deepEqual(q0030Fallback.finalAudit.violations, [], 'Q0030 只读边界与责任交接终稿必须终审全绿');

  const q0281Question = Object.keys(browserRequirements).find(question => question === '打回时消息中心失败，门诊和住院结果一致吗？');
  const q0282Question = Object.keys(browserRequirements).find(question => question === '创建会话失败后门诊处方还会继续打回吗？');
  assert.ok(q0281Question && q0282Question, 'Q0281/Q0282 应从真实浏览器题目 fixture 取到连续问题');
  const q0282MatchedRoute = contextualRouteQuestion(productionRouteMap, [
    { role: 'user', content: q0281Question },
    { role: 'assistant', content: '门诊和住院的消息失败结果不同。' },
    { role: 'user', content: q0282Question },
  ], q0282Question, '');
  const q0282Route = runtimeRouteWithContext(q0282MatchedRoute);
  assert.equal(q0282Route.route.id, 'AUD-QR-FLOW-REJECT-MESSAGE-01', 'Q0282 应沿当前消息故障 route 回答');
  const q0282Initial = bundle.audit(q0282Route.answerFacts.join('\n'), q0282Question, q0282Route);
  assert.equal(q0282Initial.fieldDiagnosticQuestion, true, '外部会话/消息失败后业务是否继续的续问应进入现场只读诊断');
  const q0282Reply = bundle.fallback(q0282Route.answerFacts.join('\n'), q0282Initial);
  assert.match(q0282Reply, /只记录(?:该|上述)?差异.*接口\/业务负责人评估/s);
  assert.match(q0282Reply, /另行授权.*定向补偿/s);
  assert.match(q0282Reply, /本轮不补发、不重做、不重试/);
  assert.doesNotMatch(q0282Reply, /应定向补消息|再决定是否重做/);
  assert.deepEqual(bundle.audit(q0282Reply, q0282Question, q0282Route).violations, [], 'Q0282 只读兜底不得把处置事实发布成现场动作');

  const q0292Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（292）里，创建会话失败后门诊处方还会继续打回吗？');
  assert.ok(q0292Question, 'Q0292 应从真实浏览器题目 fixture 取到原问题');
  const q0292Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0292Question));
  assert.equal(q0292Route.route.id, 'AUD-QR-FLOW-REJECT-MESSAGE-01');
  const q0292MissingInpatientDraft = [
    '结论：门诊和住院结果不一致；门诊创建会话失败后仍可能继续打回，因为门诊不等待消息结果。',
    '门诊表现：消息接口失败时，打回接口仍可能成功，任务会变更并写入审核流水，页面仍可能提示“打回成功”，但医生没有收到审核卡片。',
    '1. 只读核对任务状态和审核流水。',
    '2. 查看已经发生的会话和消息请求响应。',
    '3. 按现有记录区分消息失败和打回结果。',
    '4. 整理时间、对象和日志证据，不重复操作。',
  ].join('\n');
  const q0292Initial = bundle.audit(q0292MissingInpatientDraft, q0292Question, q0292Route);
  assert.deepEqual(q0292Initial.missingFailureBranchCoverage, ['住院'], 'Q0292 不能只回答门诊而漏掉同一路由的住院故障结果');
  assert.ok(q0292Initial.violations.includes('incomplete_verified_facts'));
  const q0292Reply = bundle.fallback(q0292MissingInpatientDraft, q0292Initial);
  assert.match(q0292Reply, /住院表现/);
  assert.match(q0292Reply, /住院打回接口不会被调用/);
  assert.match(q0292Reply, /页面表现为请求报错或操作没有完成/);
  assert.match(q0292Reply, /任务通常仍保持原审核状态/);
  assert.match(q0292Reply, /倒计时超时|超时/);
  assert.match(q0292Reply, /他人并发处理|并发/);
  assert.deepEqual(bundle.audit(q0292Reply, q0292Question, q0292Route).violations, [], 'Q0292 fallback 应完整恢复两端故障差异并终审全绿');

  const q0299Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（299）里，把当前审方打回与医生消息故障的门诊住院差异从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。');
  assert.ok(q0299Question, 'Q0299 应从真实浏览器题目 fixture 取到原问题');
  const q0299Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0299Question));
  assert.equal(q0299Route.route.id, 'AUD-QR-FLOW-REJECT-MESSAGE-01');
  const q0299Initial = bundle.audit(q0299Route.answerFacts.join('\n'), q0299Question, q0299Route);
  assert.equal(q0299Initial.fallbackAnswerMode, 'chain');
  assert.match(q0299Initial.safeChainFallback, /只记录(?:该|上述)?差异.*接口\/业务负责人评估/s);
  assert.match(q0299Initial.safeChainFallback, /另行授权.*定向补偿/s);
  assert.match(q0299Initial.safeChainFallback, /本轮不补发、不重做、不重试/);
  assert.doesNotMatch(q0299Initial.safeChainFallback, /应定向补消息|再决定是否重做/);
  assert.deepEqual(bundle.audit(q0299Initial.safeChainFallback, q0299Question, q0299Route).violations, [], 'Q0299 确定性链路兜底不得发布副作用建议');

  const q0293Question = Object.keys(browserRequirements).find(question => question === '先别把当前审方打回与医生消息故障的门诊住院差异的原因说死：当前只有接口状态和业务返回，哪些结论成立，哪些仍需确认？');
  assert.ok(q0293Question, 'Q0293 应从真实浏览器题目 fixture 取到受限证据问法');
  const q0293Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0293Question));
  const q0293Fallback = bundle.modelFailureFallback(q0293Question, q0293Route, { status: 429, message: 'rate limit' });
  assert.ok(q0293Fallback, 'Q0293 partial evidence 模型失败时必须使用已核事实兜底');
  assert.equal(q0293Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0293Fallback.reply, /只记录(?:该|上述)?差异.*接口\/业务负责人评估/s);
  assert.match(q0293Fallback.reply, /另行授权.*定向补偿/s);
  assert.match(q0293Fallback.reply, /本轮不补发、不重做、不重试/);
  assert.doesNotMatch(q0293Fallback.reply, /应定向补消息|再决定是否重做/);
  assert.deepEqual(q0293Fallback.finalAudit.violations, [], 'partial evidence 也必须复用同一非写操作事实转换');

  const q0303Question = Object.keys(browserRequirements).find(question => question === '审核业务场景与状态机（通过/自动通过/打回双签/打回修改/医生侧/移交/挂起）这条链路只确认前端发出了请求，服务端后续日志还没拿到。先说能确定的，未知项请单独标出来。');
  assert.ok(q0303Question, 'Q0303 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0303Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0303Question));
  assert.equal(q0303Route.route.id, 'AUD-QR-FLOW-02');
  const q0303EmptyAudit = bundle.audit('', q0303Question, q0303Route);
  const q0303DirectReply = bundle.fallback('', q0303EmptyAudit);
  const q0303DirectFinalAudit = bundle.audit(q0303DirectReply, q0303Question, q0303Route);
  const q0303RateLimitFallback = bundle.modelFailureFallback(q0303Question, q0303Route, { status: 429, message: 'rate limit' });
  assert.ok(q0303RateLimitFallback, `Q0303 长 route 遇到 429 仍应发布 verifiedFacts partial-evidence 终稿：${JSON.stringify({ initial: q0303EmptyAudit.violations, reply: q0303DirectReply, final: q0303DirectFinalAudit.violations })}`);
  assert.match(q0303RateLimitFallback.reply, /只能确认前端(?:已经|已)?发出(?:了)?请求/);
  assert.match(q0303RateLimitFallback.reply, /移交和 AI 挂起是两个业务动作/);
  assert.match(q0303RateLimitFallback.reply, /服务端[^。！？\n]*(?:处理|日志)[^。！？\n]*(?:后续|业务)?状态[^。！？\n]*(?:未知|未取得|待确认)/);
  assert.match(q0303RateLimitFallback.reply, /只读/);
  assert.match(q0303RateLimitFallback.reply, /不重复提交/);
  assert.match(q0303RateLimitFallback.reply, /不重试/);
  assert.deepEqual(q0303RateLimitFallback.finalAudit.violations, [], 'Q0303 429 兜底终审应全绿');

  const q0303UnsafeDraft = '前端已经发出请求，说明服务端处理成功并完成状态变更；建议重新提交一次确认。';
  const q0303UnsafeAudit = bundle.audit(q0303UnsafeDraft, q0303Question, q0303Route);
  assert.ok(q0303UnsafeAudit.violations.length, 'Q0303 不合格模型草稿必须触发确定性安全兜底');
  const q0303Recovered = bundle.recoverSafeDiagnostic(q0303UnsafeAudit, q0303Question, q0303Route);
  assert.ok(q0303Recovered, 'Q0303 初稿与二次修订均不合格时，最终恢复出口仍须返回确定性 partial-evidence 终稿');
  const q0303SemanticFallback = q0303Recovered.reply;
  const q0303SemanticFinalAudit = q0303Recovered.audit;
  assert.match(q0303SemanticFallback, /只能确认前端(?:已经|已)?发出(?:了)?请求/);
  assert.match(q0303SemanticFallback, /服务端[^。！？\n]*(?:处理|日志)[^。！？\n]*(?:后续|业务)?状态[^。！？\n]*(?:未知|未取得|待确认)/);
  assert.match(q0303SemanticFallback, /不重复提交/);
  assert.match(q0303SemanticFallback, /不重试/);
  assert.doesNotMatch(q0303SemanticFallback, /重新提交一次|当前回答未通过发布前事实与动作安全校验/);
  assert.deepEqual(q0303SemanticFinalAudit.violations, [], 'Q0303 二次语义修订失败出口也必须收敛成可发布终稿');

  const q0310Question = Object.keys(browserRequirements).find(question => question === '我没完全听懂审核业务场景与状态机（通过/自动通过/打回双签/打回修改/医生侧/移交/挂起）的排查建议，换成实施可以逐项照做的只读清单。');
  assert.ok(q0310Question, 'Q0310 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0310Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0310Question));
  assert.equal(q0310Route.route.id, 'AUD-QR-FLOW-02');
  const q0310OmittedDraft = [
    '1. 记录页面、账号、版本和发生时间。',
    '2. 只查看已有请求与响应，不重新提交。',
    '3. 移交时核对目标药师在线状态、任务所属和挂起显示。',
    '4. 整理已有状态与流水，拿不到的日志标成缺失。',
  ].join('\n');
  const q0310Initial = bundle.audit(q0310OmittedDraft, q0310Question, q0310Route);
  assert.deepEqual(q0310Initial.checklistStageLabels, ['通过', '自动通过', '打回双签', '打回修改', '医生侧', '移交', '挂起']);
  assert.ok(q0310Initial.missingChecklistRouteLabels.includes('有候选'));
  assert.ok(q0310Initial.missingChecklistRouteLabels.includes('无候选'));
  assert.ok(q0310Initial.violations.includes('incomplete_verified_facts'), 'Q0310 漏掉用户点名阶段和 route 分支的模型草稿必须触发 fallback');
  const q0310Reply = bundle.fallback(q0310OmittedDraft, q0310Initial);
  for (const stage of ['通过', '自动通过', '打回双签', '打回修改', '医生侧', '移交', '挂起']) {
    assert.match(q0310Reply, new RegExp(stage), `Q0310 终稿必须逐项交代“${stage}”`);
  }
  assert.match(q0310Reply, /有候选[^。！？\n]*redistribution/);
  assert.match(q0310Reply, /无候选[^。！？\n]*audit_pass/);
  assert.match(q0310Reply, /通知医生|推送给新药师/);
  assert.match(q0310Reply, /回调 HIS/);
  assert.doesNotMatch(q0310Reply, /重放|重提|重新提交|修改业务数据/);
  assert.deepEqual(bundle.audit(q0310Reply, q0310Question, q0310Route).violations, [], 'Q0310 确定性分阶段只读清单终审应全绿');

  const q0340Question = Object.keys(browserRequirements).find(question => question === '回到药学公式计算器这里，第一层核过没有异常，下一步按什么顺序继续只读排查？');
  assert.ok(q0340Question, 'Q0340 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0340Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0340Question));
  assert.equal(q0340Route.route.id, 'AUD-QR-MED-01');
  const q0340WrongGenericDraft = [
    '1. 先核对当前操作请求与返回。',
    '2. 再查看 HTTP 状态和业务码。',
    '3. 然后查看服务端日志与数据库记录。',
    '4. 最后按接口分支整理审核流水。',
  ].join('\n');
  const q0340Initial = bundle.audit(q0340WrongGenericDraft, q0340Question, q0340Route);
  assert.equal(q0340Initial.staticClientOnlyRoute, true, 'Q0340 应从 current route 事实识别为纯静态浏览器内计算');
  assert.ok(q0340Initial.violations.includes('static_route_scope_overreach'), '纯静态页套用请求/服务端清单必须被发布前审计拦截');
  const q0340MaskedOverreach = bundle.audit('第一层没有异常，下一步继续核对 HTTP 业务码和服务端日志。', q0340Question, q0340Route);
  assert.ok(q0340MaskedOverreach.violations.includes('static_route_scope_overreach'), '无异常等普通否定词不得掩盖静态页继续查服务端的越界动作');
  const q0340ExplicitBoundary = bundle.audit([
    '1. 入口与新标签页：只读记录已有页面观测。',
    '2. 输入与必填：只读记录已有输入和提示。',
    '3. 计算结果：只读记录结果区内容。',
    '4. 重置：只读对照已有重置前后观测。',
    '5. 浏览器控制台与静态资源：只查看本次已有报错和加载结果。',
    '6. 不适用项：无需核对 HTTP、业务码和服务端日志，到此停止。',
  ].join('\n'), q0340Question, q0340Route);
  assert.equal(q0340ExplicitBoundary.staticClientScopeOverreach.length, 0, '明确说明服务端观测不适用时应允许边界说明');
  const q0340Reply = bundle.fallback(q0340WrongGenericDraft, q0340Initial);
  assert.match(q0340Reply, /入口.*新标签页|新标签页.*入口/s);
  assert.match(q0340Reply, /输入.*必填|必填.*输入/s);
  assert.match(q0340Reply, /计算结果|结果区/);
  assert.match(q0340Reply, /重置/);
  assert.match(q0340Reply, /浏览器控制台/);
  assert.match(q0340Reply, /静态资源/);
  assert.match(q0340Reply, /不适用|到此停止|不再扩展/);
  assert.doesNotMatch(q0340Reply, /HTTP|业务码|服务端日志|数据库|当前操作请求|审核流水|接口分支/);
  assert.deepEqual(bundle.audit(q0340Reply, q0340Question, q0340Route).violations, [], 'Q0340 静态页专用 fallback 终审应全绿');

  const q0355Question = Object.keys(browserRequirements).find(question => question === '关于登录与鉴权，如果接口返回有数据而页面没呈现，转开发前要整理哪些最小证据？');
  assert.ok(q0355Question, 'Q0355 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0355Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0355Question));
  assert.equal(q0355Route.route.id, 'AUD-QR-SH-01');
  const q0355Initial = bundle.audit('', q0355Question, q0355Route);
  assert.deepEqual(q0355Initial.missingDataNotRenderedBoundaryGroups.sort(), ['会话作用域边界', '分阶段结果边界', '外部身份数据边界'].sort(), 'Q0355 空答应识别 current route 的三组已核业务边界');
  const q0355EvidenceOnlyDraft = [
    '1. 页面上下文：记录页面、筛选条件、账号角色、院区/科室、页面路由、对象范围、发生时间、版本和请求标识。',
    '2. 同一次请求：只查看同一次已经发生的请求与响应，保留 URL、请求参数、HTTP/业务码和响应原文；接口返回有数据不代表页面一定应展示。',
    '3. 会话作用域：只读对照 Cookie、token scope 和用户信息缓存；不重新登录，不清理 Cookie 或缓存。',
    '4. 页面呈现：只读对照响应对象、页面路由、渲染结果和浏览器控制台的已有报错。',
    '5. 交接边界：汇总时间、版本和请求标识；不关闭旧设备，不修改数据，不试越权。',
  ].join('\n');
  const q0355EvidenceOnlyAudit = bundle.audit(q0355EvidenceOnlyDraft, q0355Question, q0355Route);
  assert.equal(q0355EvidenceOnlyAudit.dataNotRenderedEvidenceComplete, true, '完整的通用证据清单应先通过取证结构合同');
  assert.ok(q0355EvidenceOnlyAudit.violations.includes('incomplete_verified_facts'), '只给通用证据而遗漏 current route 业务边界仍须触发确定性 fallback');
  const q0355DeterministicReply = bundle.fallback('', q0355Initial);
  const q0355DeterministicAudit = bundle.audit(q0355DeterministicReply, q0355Question, q0355Route);
  const q0355RateLimitFallback = bundle.modelFailureFallback(q0355Question, q0355Route, { status: 429, message: 'rate limit' });
  assert.ok(q0355RateLimitFallback, `Q0355 遇到 429 时必须发布 matched route 的确定性现场终稿：${JSON.stringify({ initial: q0355Initial.violations, reply: q0355DeterministicReply, final: q0355DeterministicAudit.violations })}`);
  assert.match(q0355RateLimitFallback.reply, /default token/);
  assert.match(q0355RateLimitFallback.reply, /message token/);
  assert.match(q0355RateLimitFallback.reply, /用户中心/);
  assert.match(q0355RateLimitFallback.reply, /审方本库无用户和 token 表/);
  assert.match(q0355RateLimitFallback.reply, /状态 4/);
  assert.match(q0355RateLimitFallback.reply, /本机登录|新设备登录/);
  assert.match(q0355RateLimitFallback.reply, /旧设备.*分开核对|分开核对.*旧设备/s);
  assert.match(q0355RateLimitFallback.reply, /同一次已经发生的请求与响应/);
  assert.match(q0355RateLimitFallback.reply, /请求参数|HTTP\/业务码|响应原文/);
  assert.match(q0355RateLimitFallback.reply, /账号角色.*院区|院区.*账号角色/s);
  assert.match(q0355RateLimitFallback.reply, /Cookie.*缓存|缓存.*Cookie/s);
  assert.match(q0355RateLimitFallback.reply, /页面路由|动态路由/);
  assert.match(q0355RateLimitFallback.reply, /渲染/);
  assert.match(q0355RateLimitFallback.reply, /浏览器控制台/);
  assert.match(q0355RateLimitFallback.reply, /时间.*版本.*请求标识|请求标识.*时间.*版本/s);
  assert.match(q0355RateLimitFallback.reply, /接口返回有数据[^。！？\n]{0,48}(?:不代表|不能证明)[^。！？\n]{0,48}页面/);
  assert.match(q0355RateLimitFallback.reply, /不重新登录|不重登录/);
  assert.match(q0355RateLimitFallback.reply, /不关闭[^。！？\n]{0,12}(?:旧设备|其他设备)/);
  assert.match(q0355RateLimitFallback.reply, /不清理[^。！？\n]{0,12}(?:Cookie|缓存)/);
  assert.match(q0355RateLimitFallback.reply, /不[^。！？\n]{0,8}(?:修改|改动)[^。！？\n]{0,8}数据/);
  assert.deepEqual(q0355RateLimitFallback.finalAudit.violations, [], 'Q0355 429 确定性 fallback 终审应全绿');
  const q0355SemanticFailureAudit = bundle.audit('当前回答未通过发布前事实与动作安全校验，请稍后重试。', q0355Question, q0355Route);
  assert.ok(q0355SemanticFailureAudit.violations.length, 'Q0355 空泛拒答必须触发语义终审失败');
  const q0355Recovered = bundle.recoverSafeDiagnostic(q0355SemanticFailureAudit, q0355Question, q0355Route);
  assert.ok(q0355Recovered, 'Q0355 二次语义失败后必须恢复 matched route 确定性现场终稿');
  assert.match(q0355Recovered.reply, /default token/);
  assert.match(q0355Recovered.reply, /message token/);
  assert.match(q0355Recovered.reply, /浏览器控制台/);
  assert.match(q0355Recovered.reply, /不重新登录|不重登录/);
  assert.deepEqual(q0355Recovered.audit.violations, [], 'Q0355 二次语义失败恢复出口终审应全绿');

  const q0363Question = Object.keys(browserRequirements).find(question => question === '处方标记现场暂时不能改数据、重放消息或重提任务。仅用已有记录应该怎样缩小范围？');
  assert.ok(q0363Question, 'Q0363 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0363Route = runtimeRouteWithContext(routeQuestion(productionRouteMap, q0363Question));
  assert.equal(q0363Route.route.id, 'AUD-QR-MK-01');
  const q0363GenericDraft = [
    '结论：现有受限证据只能固定已有观测，暂时不能闭环原因。',
    '只读核对已有请求、响应和记录，再按对象标识、状态和时间缩小范围。',
    '本轮不改数据、不重放消息、不重提任务。',
  ].join('\n');
  const q0363Initial = bundle.audit(q0363GenericDraft, q0363Question, q0363Route);
  assert.equal(q0363Initial.existingRecordNarrowingQuestion, true, 'Q0363 应识别为已有记录缩小范围问法');
  assert.match(q0363Initial.existingRecordNarrowingFact, /列表与筛选/);
  assert.deepEqual(q0363Initial.existingRecordFilterDimensions, ['标记时间', '审核状态', '标记标签', '警示等级', '科室', '医生', '患者', '处方号', '药品']);
  assert.ok(q0363Initial.missingExistingRecordNarrowing.includes('标记时间'));
  assert.ok(q0363Initial.missingExistingRecordNarrowing.includes('默认只看未删除记录'));
  assert.ok(q0363Initial.missingExistingRecordNarrowing.includes('已有记录详情'));
  assert.ok(q0363Initial.missingExistingRecordNarrowing.includes('每页 10 条'));
  assert.ok(q0363Initial.violations.includes('incomplete_verified_facts'), '只说查已有记录而不列 route 已核筛选项必须被终审拦截');
  const q0363Reply = bundle.fallback(q0363GenericDraft, q0363Initial);
  for (const filter of ['标记时间', '审核状态', '标记标签', '警示等级', '科室', '医生', '患者', '处方号', '药品']) {
    assert.match(q0363Reply, new RegExp(filter), `Q0363 确定性 fallback 必须保留筛选项“${filter}”`);
  }
  assert.match(q0363Reply, /默认每页 10 条/);
  assert.match(q0363Reply, /只查未删除标记/);
  assert.match(q0363Reply, /进入标记处方详情/);
  assert.match(q0363Reply, /本轮只读边界：不改数据、不重放消息、不重提任务/);
  assert.doesNotMatch(q0363Reply, /(?:建议|应当|应该|请|可以)[^。！？\n]{0,24}(?:添加|取消|导出|重放|重提|修改)/);
  assert.doesNotMatch(q0363Reply, /新增与标题|取消与历史|标记处方记录表\.xls/);
  assert.deepEqual(bundle.audit(q0363Reply, q0363Question, q0363Route).violations, [], 'Q0363 已有记录筛选 fallback 终审应全绿');

  const q0369Question = Object.keys(browserRequirements).find(question => question === '把处方标记从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。');
  assert.ok(q0369Question, 'Q0369 应从正式 Audit 浏览器 fixture 取到原问题');
  const auditTag3RouteMap = JSON.parse(execFileSync(
    'git', ['show', '2.7.260828-3:docs/specs/00-功能模块地图.json'],
    { cwd: path.resolve(ROOT, '../psp/audit'), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
  ));
  const q0369Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0369Question), '2.7.260828-3');
  assert.equal(q0369Route.route.id, 'AUD-QR-MK-01', 'Q0369 必须保持门诊处方标记 route');
  assert.ok(q0369Route.directEvidenceFacts.some(fact => /接口签名/u.test(fact)), JSON.stringify(q0369Route.directEvidenceFacts));
  const q0369CrossModuleDraft = [
    '入口：住院医嘱详情页。',
    '接口：GET /auditapi/audit/ipt/collects、POST /auditapi/audit/ipt/task/collect、DELETE /auditapi/audit/ipt/collect。',
    '数据：写入 audit_ipt_collect。',
  ].join('\n');
  const q0369CrossModuleAudit = bundle.audit(q0369CrossModuleDraft, q0369Question, q0369Route);
  assert.ok(q0369CrossModuleAudit.violations.includes('unexpected_concrete_path'), '相邻住院接口必须被 current route 路径作用域拦截');
  assert.ok(q0369CrossModuleAudit.violations.includes('out_of_scope_entity'), '相邻住院数据表必须被 current route 实体作用域拦截');
  const q0369Fallback = bundle.verifiedFallback(q0369Question, q0369Route);
  assert.ok(q0369Fallback, 'Q0369 应从 current route 生成确定性链路终稿');
  assert.equal(q0369Fallback.initialAudit.fallbackAnswerMode, 'chain');
  assert.match(q0369Fallback.reply, /处方审核详情|处方详情/);
  for (const signature of [
    'GET /auditapi/audit/opt/collects',
    'POST /auditapi/audit/opt/task/collect',
    'DELETE /auditapi/audit/opt/collect',
    'GET /auditapi/comm/opt/collects/excel',
  ]) assert.match(q0369Fallback.reply, new RegExp(signature.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), signature);
  assert.match(q0369Fallback.reply, /audit_opt_collect/);
  assert.match(q0369Fallback.reply, /外部依赖[^。！？\n]*(?:当前停点|未提供|不补写)/);
  assert.doesNotMatch(q0369Fallback.reply, /\/auditapi\/audit\/ipt\/|audit_ipt_collect|住院医嘱标记/);
  assert.deepEqual(q0369Fallback.finalAudit.violations, [], 'Q0369 只能串 current route 的门诊入口、接口、数据与未知边界');

  const q0373Question = Object.keys(browserRequirements).find(question => question === '关于处方标记，我现在只有一次既有请求和响应，没有数据库权限。现有证据最多能判断到哪？');
  assert.ok(q0373Question, 'Q0373 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0373ContextRoute = contextualRouteQuestion(auditTag3RouteMap, [
    { role: 'user', content: '另一轮独立复测（372）里，处方标记涉及哪些接口、数据和边界？' },
    { role: 'assistant', content: '上一轮回答不作为事实源。' },
    { role: 'user', content: q0373Question },
  ], q0373Question, '');
  assert.equal(q0373ContextRoute.route.id, 'AUD-QR-MK-01', 'Q0373 partial-evidence 必须继续锚定门诊处方标记 route');
  const q0373Route = runtimeRouteWithRepositoryContext(q0373ContextRoute, '2.7.260828-3');
  const q0373CrossModuleDraft = 'AI 生成结果会写入 audit_ai_generate，并由 Dify 返回生成内容；现有响应可证明这条生成链已完成。';
  const q0373CrossModuleAudit = bundle.audit(q0373CrossModuleDraft, q0373Question, q0373Route);
  assert.ok(q0373CrossModuleAudit.violations.includes('out_of_scope_entity'), 'partial-evidence 中相邻 AI 数据对象必须被 current route 拦截');
  const q0373Fallback = bundle.modelFailureFallback(q0373Question, q0373Route, { status: 429, message: 'rate limit' });
  assert.ok(q0373Fallback, 'Q0373 模型失败时必须发布 current route 的确定性受限证据终稿');
  assert.equal(q0373Fallback.initialAudit.fallbackAnswerMode, 'partial_evidence');
  assert.match(q0373Fallback.reply, /现有受限证据只够固定已经提供的观测/);
  assert.match(q0373Fallback.reply, /门诊处方标记/);
  assert.match(q0373Fallback.reply, /本轮未知/);
  assert.doesNotMatch(q0373Fallback.reply, /audit_ai_generate|Dify|AI 生成|住院医嘱标记|audit_ipt_collect/);
  assert.deepEqual(q0373Fallback.finalAudit.violations, [], 'Q0373 partial-evidence 确定性终稿只能使用处方标记 route 事实');

  const q0284Question = Object.keys(browserRequirements).find(question => question === '先切到另一个问题：“医嘱标记”当前实现的关键入口或处理链是什么？');
  const q0285Question = Object.keys(browserRequirements).find(question => question === '医嘱标记这一步只能确认现象稳定复现，不能做写操作。现在应停在哪个边界并交给谁继续？');
  assert.ok(q0284Question && q0285Question, 'Q0284/Q0285 应从真实浏览器题目 fixture 取到连续问题');
  const q0285MatchedRoute = contextualRouteQuestion(productionRouteMap, [
    { role: 'user', content: q0284Question },
    { role: 'assistant', content: '医嘱标记的当前入口和处理链如下。' },
    { role: 'user', content: q0285Question },
  ], q0285Question, '');
  const q0285Route = runtimeRouteWithContext(q0285MatchedRoute);
  assert.equal(q0285Route.route.id, 'AUD-QR-MK-02', 'Q0285 应保持医嘱标记 route');
  const q0285Initial = bundle.audit(q0285Route.answerFacts.join('\n'), q0285Question, q0285Route);
  assert.equal(q0285Initial.fallbackAnswerMode, 'field_diagnostic');
  const q0285Reply = bundle.fallback(q0285Route.answerFacts.join('\n'), q0285Initial);
  assert.match(q0285Reply, /当前实现会在列表返回记录后，由系统自动只读调用用户中心 getHospitalInfoByHospitalId，读取并用于展示补全医院和机构名称/);
  assert.match(q0285Reply, /不是要求实施手工调用，也不写业务数据/);
  assert.doesNotMatch(q0285Reply, /列表返回记录后，再通过用户中心[^。！？\n]*补医院和机构名称/);
  assert.match(q0285Reply, /本轮不做写操作/);
  assert.deepEqual(bundle.audit(q0285Reply, q0285Question, q0285Route).violations, [], 'Q0285 应区分系统既有实现与现场动作');

  const genericReadOnlyHandoffQuestion = '这一步只能确认现象稳定复现，不能做写操作。现在应停在哪个边界并交给谁继续？';
  const genericImplementationRoute = {
    matched: true,
    inherited: true,
    route: { id: 'GENERIC-DISPLAY', title: '通用展示补全' },
    answerFacts: [
      '查询返回记录后，再通过资料服务 resolveOwnerName 补负责人名称；这是页面展示补全。',
      '记录已处理但通知缺失时应定向补通知；任务未变后再决定是否重做。',
    ],
    mustNotConfuse: [],
    directEvidenceFacts: [],
  };
  const genericImplementationInitial = bundle.audit(genericImplementationRoute.answerFacts.join('\n'), genericReadOnlyHandoffQuestion, genericImplementationRoute);
  const genericImplementationReply = genericImplementationInitial.safeDiagnosticFallback;
  assert.match(genericImplementationReply, /当前实现会在查询返回记录后，由系统自动只读调用资料服务 resolveOwnerName，读取并用于展示补全负责人名称/);
  assert.match(genericImplementationReply, /不是要求实施手工调用，也不写业务数据/);
  assert.doesNotMatch(genericImplementationReply, /应定向补通知|再决定是否重做/);
  assert.match(genericImplementationReply, /另行授权.*定向补偿/s);
  assert.deepEqual(bundle.audit(genericImplementationReply, genericReadOnlyHandoffQuestion, genericImplementationRoute).violations, [], '通用实现顺序和补偿建议也应安全收口');

  const q0381Question = Object.keys(browserRequirements).find(question => question === '医嘱标记现在是怎么实现的？');
  const q0382Question = Object.keys(browserRequirements).find(question => question === '医嘱标记涉及哪些接口、数据和边界？');
  assert.ok(q0381Question && q0382Question, 'Q0381/Q0382 应从正式 Audit 浏览器 fixture 取到原问题');
  for (const [question, label] of [[q0381Question, 'Q0381'], [q0382Question, 'Q0382']]) {
    const matchedRoute = routeQuestion(auditTag3RouteMap, question);
    assert.equal(matchedRoute.route.id, 'AUD-QR-MK-02', `${label} 必须命中医嘱标记 route`);
    const runtimeRoute = runtimeRouteWithRepositoryContext(matchedRoute, '2.7.260828-3');
    const routeDraft = runtimeRoute.answerFacts.join('\n');
    const initialAudit = bundle.audit(routeDraft, question, runtimeRoute);
    assert.ok(initialAudit.violations.includes('ambiguous_as_built_action'), `${label} 裸“再通过…补全”必须触发客观系统行为改写`);
    assert.match(initialAudit.ambiguousAsBuiltSystemActionParts.join('\n'), /列表返回记录后，再通过用户中心 getHospitalInfoByHospitalId 补医院和机构名称/);
    const reply = bundle.fallback(routeDraft, initialAudit);
    assert.match(reply, /由系统自动只读调用用户中心 getHospitalInfoByHospitalId/);
    assert.match(reply, /读取并用于展示补全医院和机构名称/);
    assert.match(reply, /不是要求实施手工调用，也不写业务数据/);
    assert.match(reply, /添加方法没有直接调用 HIS/);
    assert.doesNotMatch(reply, /列表返回记录后，再通过用户中心[^。！？\n]*补医院和机构名称/);
    assert.doesNotMatch(reply, /(?:^|[。！？；\n])\s*(?:建议|请|要求|让)实施[^。！？\n]{0,24}(?:调用|补全|写入)/u);
    assert.deepEqual(bundle.audit(reply, question, runtimeRoute).violations, [], `${label} 系统自动只读依赖表述终审应全绿`);
  }
  const q0382FailureRoute = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0382Question), '2.7.260828-3');
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { status: 429, message: 'rate limit' },
  ]) {
    const fallback = bundle.modelFailureFallback(q0382Question, q0382FailureRoute, modelError);
    assert.ok(fallback, `Q0382 ${modelError.code || modelError.status} 应发布 current route 的 verified fallback`);
    assert.equal(fallback.fallbackSource, 'verifiedFacts');
    assert.equal(fallback.modelDraftError.kind, modelError.status === 429 ? 'rate_limit' : 'length_limit');
    assert.match(fallback.reply, /GET \/auditapi\/audit\/ipt\/collects/);
    assert.match(fallback.reply, /audit_ipt_collect/);
    assert.match(fallback.reply, /由系统自动只读调用用户中心 getHospitalInfoByHospitalId/);
    assert.doesNotMatch(fallback.reply, /AI 暂时连不上|列表返回记录后，再通过用户中心/);
    assert.deepEqual(fallback.finalAudit.violations, [], 'Q0382 模型失败的确定性终稿必须再次语义审计全绿');
  }
  assert.equal(bundle.modelFailureFallback(q0382Question, {
    matched: false,
    fallbackMode: 'verifiedFacts',
    route: { id: 'MISS', title: '未命中', fallbackMode: 'verifiedFacts' },
    answerFacts: q0382FailureRoute.answerFacts,
  }, { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' }), null, '即使携带看似完整 facts，route miss 也不得在模型失败时伪造 Q0382 答案');

  const q0387Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（387）里，医嘱标记涉及哪些接口、数据和边界？');
  assert.ok(q0387Question, 'Q0387 应从正式 Audit 浏览器 fixture 取到带复测前缀的原问题');
  const q0387Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0387Question), '2.7.260828-3');
  assert.equal(q0387Route.route.id, 'AUD-QR-MK-02', 'Q0387 必须继续命中医嘱标记 route');
  const q0387InitialAudit = bundle.audit('', q0387Question, q0387Route);
  const q0387DeterministicReply = bundle.fallback('', q0387InitialAudit);
  const q0387DeterministicAudit = bundle.audit(q0387DeterministicReply, q0387Question, q0387Route);
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { status: 429, message: 'rate limit' },
  ]) {
    const fallback = bundle.modelFailureFallback(q0387Question, q0387Route, modelError);
    assert.ok(fallback, `Q0387 ${modelError.code || modelError.status} 应发布复测语境 verified fallback：${JSON.stringify({ initialViolations: q0387InitialAudit.violations, fallbackAnswerMode: q0387InitialAudit.fallbackAnswerMode, reply: q0387DeterministicReply, finalViolations: q0387DeterministicAudit.violations, missingImplementationFactCoverage: q0387DeterministicAudit.missingImplementationFactCoverage, missingDiagnostic: q0387DeterministicAudit.missingDiagnosticSequence })}`);
    assert.equal(fallback.fallbackSource, 'verifiedFacts');
    assert.match(fallback.reply, /GET \/auditapi\/audit\/ipt\/collects/);
    assert.match(fallback.reply, /audit_ipt_collect/);
    assert.match(fallback.reply, /由系统自动只读调用用户中心 getHospitalInfoByHospitalId/);
    assert.deepEqual(fallback.finalAudit.violations, []);
  }
  assert.equal(bundle.modelFailureFallback(q0387Question, { ...q0387Route, matched: false }, { status: 429, message: 'rate limit' }), null, 'Q0387 前缀不能让 route miss 绕过证据门');

  const q0389Question = Object.keys(browserRequirements).find(question => question === '把医嘱标记从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。');
  const q0390Question = Object.keys(browserRequirements).find(question => question === '回到医嘱标记这里，第一层核过没有异常，下一步按什么顺序继续只读排查？');
  assert.ok(q0389Question && q0390Question, 'Q0389/Q0390 应从正式 Audit 浏览器 fixture 取到连续问题');
  const q0390MatchedRoute = contextualRouteQuestion(auditTag3RouteMap, [
    { role: 'user', content: q0389Question },
    { role: 'assistant', content: '上一轮回答不作为事实源。' },
    { role: 'user', content: q0390Question },
  ], q0390Question, '');
  assert.equal(q0390MatchedRoute.route.id, 'AUD-QR-MK-02', 'Q0390 上下文续问必须保持医嘱标记 current route');
  const q0390Route = runtimeRouteWithRepositoryContext(q0390MatchedRoute, '2.7.260828-3');
  const q0390GenericDraft = [
    '第一层没有异常后，继续只读查看同一次请求和响应。',
    '再按请求标识对照服务端日志、业务状态和页面结果。',
    '本轮不改数据、不重试、不重放。',
  ].join('\n');
  const q0390Initial = bundle.audit(q0390GenericDraft, q0390Question, q0390Route);
  assert.equal(q0390Initial.continuationDiagnosticQuestion, true, 'Q0390 应识别为下一层只读续接诊断');
  assert.equal(q0390Initial.contextFollowupQuestion, true, 'Q0390 应保持 current route 上下文');
  assert.match(q0390Initial.routeReadOnlySequenceFact, /现场只读排查顺序/);
  assert.deepEqual(q0390Initial.routeReadOnlySequenceSteps.map(step => step.text), [
    '核对页面当前筛选条件与分页',
    '看既有列表请求和响应',
    '沿既有记录核对详情、任务和标记记录',
  ]);
  assert.ok(q0390Initial.missingRouteReadOnlySequenceSteps.length >= 2, '通用清单漏掉 route 专用步骤时必须拦截');
  assert.ok(q0390Initial.violations.includes('incomplete_verified_facts'));
  const q0390Reply = bundle.fallback(q0390GenericDraft, q0390Initial);
  assert.match(q0390Reply, /页面当前筛选条件与分页/);
  assert.match(q0390Reply, /既有列表请求和响应/);
  assert.match(q0390Reply, /沿既有记录核对详情、任务和标记记录/);
  const q0390FilterIndex = q0390Reply.indexOf('页面当前筛选条件与分页');
  const q0390RequestIndex = q0390Reply.indexOf('既有列表请求和响应');
  const q0390RecordIndex = q0390Reply.indexOf('既有记录核对详情、任务和标记记录');
  assert.ok(q0390FilterIndex >= 0 && q0390RequestIndex > q0390FilterIndex && q0390RecordIndex > q0390RequestIndex, 'Q0390 必须保留 current route 已核的先后顺序');
  assert.match(q0390Reply, /下一层只读排查顺序/);
  assert.match(q0390Reply, /不重新点击或提交/);
  assert.doesNotMatch(q0390Reply, /(?:^|[。！？；\n])\s*(?:建议|请|要求|让实施)[^。！？\n]{0,24}(?:新增|取消|重试|重放|提交)/u);
  const q0390Final = bundle.audit(q0390Reply, q0390Question, q0390Route);
  assert.deepEqual(q0390Final.missingRouteReadOnlySequenceSteps, []);
  assert.deepEqual(q0390Final.violations, [], 'Q0390 确定性终稿须先保留 route 专用顺序，再叠加通用分层且终审全绿');

  const genericSequenceQuestion = '回到记录核对这里，第一层核过没有异常，下一步按什么顺序继续只读排查？';
  const genericSequenceRoute = {
    matched: true,
    inherited: true,
    route: { id: 'GENERIC-READONLY-SEQUENCE', title: '记录核对' },
    answerFacts: [
      '现场只读排查顺序：先核对页面筛选项与分页，再看既有查询请求和响应，再沿已有记录核对详情与处理记录；未经授权不得为留证重做。',
    ],
    mustNotConfuse: [],
  };
  const genericSequenceInitial = bundle.audit('继续对照请求和页面，不做写操作。', genericSequenceQuestion, genericSequenceRoute);
  assert.ok(genericSequenceInitial.violations.includes('incomplete_verified_facts'), 'route 顺序合同不得依赖医嘱标记字段');
  const genericSequenceReply = bundle.fallback('', genericSequenceInitial);
  assert.match(genericSequenceReply, /页面筛选项与分页/);
  assert.match(genericSequenceReply, /已有记录核对详情与处理记录/);
  assert.deepEqual(bundle.audit(genericSequenceReply, genericSequenceQuestion, genericSequenceRoute).violations, [], '任意 route 的明确只读顺序都应可确定性保留');

  const q0402Question = Object.keys(browserRequirements).find(question => question === '标记管理涉及哪些接口、数据和边界？');
  assert.ok(q0402Question, 'Q0402 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0402Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0402Question), '2.7.260828-3');
  assert.equal(q0402Route.route.id, 'AUD-QR-MK-03', 'Q0402 必须命中标记管理 current route');
  const q0402FactsOnlyDraft = q0402Route.answerFacts.join('\n');
  const q0402Initial = bundle.audit(q0402FactsOnlyDraft, q0402Question, q0402Route);
  assert.equal(q0402Initial.interfaceDataBoundaryDiagnosticQuestion, true, '接口、数据与边界宽问法应使用 field diagnostic 合同');
  assert.equal(q0402Initial.fieldDiagnosticQuestion, true);
  assert.equal(q0402Initial.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0402Initial.interfaceDataBoundaryDiagnosticComplete, false, '只罗列 route facts 不能替代分层只读排查');
  assert.ok(q0402Initial.violations.includes('incomplete_diagnostic_sequence'));
  const q0402Reply = bundle.fallback(q0402FactsOnlyDraft, q0402Initial);
  assert.match(q0402Reply, /接口、数据与边界的分层只读排查顺序/);
  assert.match(q0402Reply, /页面与范围[^\n]*筛选或查询条件[^\n]*账号角色/);
  assert.match(q0402Reply, /同一次请求与响应[^\n]*同一次已经发生的请求和响应/);
  assert.match(q0402Reply, /服务端与业务记录[^\n]*服务端日志[^\n]*已有业务记录/);
  assert.match(q0402Reply, /取不到时明确标为缺失/);
  assert.match(q0402Reply, /页面呈现与权限边界/);
  assert.match(q0402Reply, /没有请求 \/ 请求失败 \/ 响应正常但业务记录或页面呈现不一致/);
  assert.match(q0402Reply, /只补会改变判断的最少原文/);
  assert.match(q0402Reply, /不要为抓包新增、编辑、删除或重做业务动作/);
  assert.doesNotMatch(q0402Reply, /(?:^|[。！？；\n])\s*(?:建议|请|要求|让实施)[^。！？\n]{0,28}(?:新增|创建|编辑|删除|提交)/u);
  const q0402Final = bundle.audit(q0402Reply, q0402Question, q0402Route);
  assert.equal(q0402Final.interfaceDataBoundaryDiagnosticComplete, true);
  assert.deepEqual(q0402Final.violations, [], 'Q0402 facts 后必须追加 route 安全的四层只读证据分支并终审全绿');

  const genericBoundaryQuestion = '库存规则包含哪些接口、数据和边界？';
  const genericBoundaryRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'GENERIC-BOUNDARY', title: '库存规则', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '当前列表只展示账号范围内已有的规则和状态，不会据此改变库存数据。',
      '现场仅允许读取现有页面、同一次请求响应和已经形成的业务记录。',
    ],
    mustNotConfuse: [],
  };
  const genericBoundaryInitial = bundle.audit(genericBoundaryRoute.answerFacts.join('\n'), genericBoundaryQuestion, genericBoundaryRoute);
  assert.equal(genericBoundaryInitial.interfaceDataBoundaryDiagnosticQuestion, true, '通用合同不能依赖标记管理题名或字段');
  assert.equal(genericBoundaryInitial.diagnosticSequenceComplete, false);
  const genericBoundaryReply = bundle.fallback('', genericBoundaryInitial);
  assert.match(genericBoundaryReply, /页面与范围/);
  assert.match(genericBoundaryReply, /服务端与业务记录/);
  assert.match(genericBoundaryReply, /证据分支/);
  assert.doesNotMatch(genericBoundaryReply, /标记管理|个人标签|共享标签/);
  assert.deepEqual(bundle.audit(genericBoundaryReply, genericBoundaryQuestion, genericBoundaryRoute).violations, [], '其它 route 也应得到相同的最小只读分层');
  assert.equal(bundle.modelFailureFallback(genericBoundaryQuestion, { ...genericBoundaryRoute, matched: false }, { status: 429, message: 'rate limit' }), null, '接口数据边界宽问法不能让 route miss 绕过证据门');

  const q0487Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（487）里，大屏数据接口（各统计指标出数）涉及哪些接口、数据和边界？');
  assert.ok(q0487Question, 'Q0487 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0487Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0487Question), '2.7.260828-3');
  assert.equal(q0487Route.route.id, 'AUD-QR-SC-01', 'Q0487 必须命中大屏 current route');
  const q0487GenericDraft = [
    ...q0487Route.answerFacts,
    '1. 原样记录当前页面、筛选条件、账号角色和发生时间。',
    '2. 只查看已经发生的请求与响应。',
    '3. 按没有请求、请求失败、响应正常但页面不一致分开记录。',
    '4. 整理原文与脱敏截图，拿不到的项标为缺失。',
  ].join('\n');
  const q0487Initial = bundle.audit(q0487GenericDraft, q0487Question, q0487Route);
  assert.equal(q0487Initial.verifiedInterfaceDataBoundaryDiagnosticQuestion, true, 'route 已明确实施日志锚点时，带复测前缀也应升级为 route-aware 分层');
  assert.ok(q0487Initial.requiredInterfaceDataBoundarySignatures.includes('GET /comm/screen/info?projectName=...'), '应从 current route 的精确接口契约恢复只读查询入口');
  assert.ok(q0487Initial.requiredInterfaceDataBoundarySignatures.includes('GET /comm/screen/sc'), '应从 current route 恢复有副作用的生成入口');
  assert.ok(q0487Initial.interfaceDataBoundaryChecklistItems.includes('快照 updateTime'));
  assert.ok(q0487Initial.interfaceDataBoundaryChecklistItems.includes('screen_admin 定时任务日志'));
  assert.ok(q0487Initial.interfaceDataBoundaryChecklistItems.includes('数据源连接日志'));
  assert.ok(q0487Initial.interfaceDataBoundaryChecklistItems.includes('SQL 日志'));
  assert.ok(q0487Initial.interfaceDataBoundaryChecklistItems.includes('projectName'));
  assert.equal(q0487Initial.interfaceDataBoundaryRouteStructureComplete, false, '事实平铺加通用清单不能替代 route 入口/数据/日志分层');
  assert.ok(q0487Initial.violations.includes('incomplete_diagnostic_sequence'));
  const q0487Reply = bundle.fallback(q0487GenericDraft, q0487Initial);
  assert.match(q0487Reply, /当前 route 的分层核对锚点/);
  assert.match(q0487Reply, /只读查询入口：GET \/comm\/screen\/info\?projectName=\.\.\./);
  assert.match(q0487Reply, /有副作用的生成\/写入入口（本轮不得调用）：GET \/comm\/screen\/sc/);
  assert.match(q0487Reply, /数据与选择条件[^\n]*audit_screen_info[^\n]*(?:update_time|updateTime)/);
  assert.match(q0487Reply, /数据与选择条件[^\n]*projectName/);
  assert.match(q0487Reply, /route 已核只读日志\/记录锚点[^\n]*updateTime[^\n]*screen_admin[^\n]*连接日志[^\n]*SQL 日志[^\n]*projectName/);
  assert.match(q0487Reply, /没有请求 \/ 请求失败 \/ 响应正常但业务记录或页面呈现不一致/);
  assert.match(q0487Reply, /不要为抓包新增、编辑、删除或重做业务动作/);
  assert.doesNotMatch(q0487Reply, /(?:建议|请|要求|让实施)[^。！？\n]{0,36}(?:调用[^。！？\n]*\/comm\/screen\/sc|断开|断库|反复生成)/u);
  const q0487Final = bundle.audit(q0487Reply, q0487Question, q0487Route);
  assert.deepEqual(q0487Final.missingInterfaceDataBoundarySignatures, []);
  assert.deepEqual(q0487Final.missingInterfaceDataBoundaryChecklistItems, []);
  assert.equal(q0487Final.interfaceDataBoundaryRouteStructureComplete, true);
  assert.deepEqual(q0487Final.violations, [], 'Q0487 route-aware 分层终稿必须保留查询/生成入口、数据选择、日志和副作用边界');

  const genericRouteAwareQuestion = '另一轮独立复测里，库存快照涉及哪些接口、数据和边界？';
  const genericRouteAwareRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'GENERIC-SNAPSHOT', title: '库存快照', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '库存页读取 inventory_snapshot 最新快照，按 warehouseCode 精确匹配。',
      'POST /comm/inventory/rebuild 会生成并写入新快照，是有副作用的入口，本轮不得调用。',
      '实施排查先看快照时间、scheduler 定时任务日志、连接日志、SQL 日志和 warehouseCode；不得断库或重建快照复现。',
    ],
    directEvidenceFacts: [
      '查询接口：GET /comm/inventory/info?warehouseCode=...，读取最新快照。',
      '生成接口：POST /comm/inventory/rebuild，会生成并写入新快照。',
    ],
    mustNotConfuse: [],
  };
  const genericRouteAwareInitial = bundle.audit(genericRouteAwareRoute.answerFacts.join('\n'), genericRouteAwareQuestion, genericRouteAwareRoute);
  assert.equal(genericRouteAwareInitial.verifiedInterfaceDataBoundaryDiagnosticQuestion, true, 'route-aware 分层不能依赖大屏模块或 SC-01 字段');
  const genericRouteAwareReply = bundle.fallback('', genericRouteAwareInitial);
  assert.match(genericRouteAwareReply, /只读查询入口：GET \/comm\/inventory\/info\?warehouseCode=\.\.\./);
  assert.match(genericRouteAwareReply, /有副作用的生成\/写入入口（本轮不得调用）：POST \/comm\/inventory\/rebuild/);
  assert.match(genericRouteAwareReply, /scheduler 定时任务日志/);
  assert.deepEqual(bundle.audit(genericRouteAwareReply, genericRouteAwareQuestion, genericRouteAwareRoute).violations, [], '其它带 route 排查锚点的快照功能也应形成同一只读结构');

  const q0499Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（499）里，把大屏数据接口（各统计指标出数）从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。');
  assert.ok(q0499Question, 'Q0499 应从正式 Audit 浏览器 fixture 取到原问题');
  const q0499Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0499Question), '2.7.260828-3');
  assert.equal(q0499Route.route.id, 'AUD-QR-SC-01', 'Q0499 必须命中大屏 current route');
  const q0499Initial = bundle.audit('', q0499Question, q0499Route);
  assert.equal(q0499Initial.chainRequested, true);
  assert.ok(q0499Initial.chainKeyBusinessFacts.length <= 3, '关键业务口径必须有固定上限，不能无条件堆全文');
  assert.ok(q0499Initial.chainKeyBusinessFacts.some(fact => /最近\s*7\s*天[^。！？\n]*最近\s*12\s*个月/su.test(fact)), 'Q0499 中间的日/月趋势事实必须被识别为关键量化口径');
  assert.match(q0499Initial.safeChainFallback, /关键业务口径[^\n]*最近 7 天[^\n]*最近 12 个月/);
  assert.match(q0499Initial.safeChainFallback, /分别统计门诊和住院人工审核工作量/);
  const q0499OmittedDraft = q0499Initial.safeChainFallback.split('\n')
    .filter(line => !/(?:最近\s*7\s*天|最近\s*12\s*个月)/u.test(line)).join('\n');
  const q0499OmittedAudit = bundle.audit(q0499OmittedDraft, q0499Question, q0499Route);
  assert.ok(q0499OmittedAudit.missingChainKeyBusinessFacts.some(fact => /最近\s*7\s*天[^。！？\n]*最近\s*12\s*个月/su.test(fact)), '链路草稿漏掉量化中间事实时必须触发完整性审计');
  assert.ok(q0499OmittedAudit.violations.includes('incomplete_requested_chain'));
  const q0499Reply = bundle.fallback(q0499OmittedDraft, q0499OmittedAudit);
  assert.match(q0499Reply, /最近 7 天/);
  assert.match(q0499Reply, /最近 12 个月/);
  assert.match(q0499Reply, /门诊和住院人工审核工作量/);
  assert.deepEqual(bundle.audit(q0499Reply, q0499Question, q0499Route).violations, [], 'Q0499 确定性链路终稿必须恢复关键趋势范围并终审全绿');

  const auditBrowserQuestions = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'tools/fixtures/audit-browser-1000.questions.json'), 'utf8',
  ));
  const q0509Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0509')?.question;
  assert.equal(q0509Question, '把多数据库方言适配（MySQL/达梦/PostgreSQL 三库同逻辑不同 SQL）从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。');
  const q0509Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0509Question), '2.7.260828-3');
  assert.equal(q0509Route.route.id, 'AUD-QR-SC-02', 'Q0509 必须命中多数据库方言 current route');
  const q0509Initial = bundle.audit('', q0509Question, q0509Route);
  assert.equal(q0509Initial.chainEvidenceSufficient, true, 'Q0509 已有入口、精确接口与数据事实，应通过 chain 证据门');
  assert.deepEqual(q0509Initial.chainKnownFactDimensions, ['入口', '接口', '数据']);
  const q0509Reply = bundle.fallback('', q0509Initial);
  const q0509Final = bundle.audit(q0509Reply, q0509Question, q0509Route);
  assert.deepEqual(q0509Final.violations, [], JSON.stringify({
    initial: q0509Initial.violations,
    mode: q0509Initial.fallbackAnswerMode,
    reply: q0509Reply,
    final: q0509Final.violations,
    missingRequestedInterfaces: q0509Final.missingRequestedInterfaces,
    missingChainDimensions: q0509Final.missingChainDimensions,
    unexpectedPaths: q0509Final.unexpectedPaths,
    unexpectedEntities: q0509Final.unexpectedEntityTerms,
    unexpectedTechnicalTokens: q0509Final.unexpectedTechnicalTokens,
    actions: [q0509Final.unsafeActorActionCount, q0509Final.unsafeDirectActionCount],
  }, null, 2));
  assert.match(q0509Reply, /GET \/comm\/screen\/info\?projectName=\.\.\./, '参数占位省略号不能在路径归一化时被删掉');
  assert.match(q0509Reply, /外部依赖[^。！？\n]*当前停点/, '未定义的外部依赖必须明确停住');
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { status: 429, message: 'rate limit' },
  ]) {
    const q0509ModelFailureFallback = bundle.modelFailureFallback(q0509Question, q0509Route, modelError);
    assert.ok(q0509ModelFailureFallback, `Q0509 ${modelError.code || modelError.status} 应发布已核 chain fallback`);
    assert.equal(q0509ModelFailureFallback.fallbackSource, 'verifiedFacts');
    assert.equal(q0509ModelFailureFallback.initialAudit.fallbackAnswerMode, 'chain');
    assert.deepEqual(q0509ModelFailureFallback.finalAudit.violations, []);
    assert.doesNotMatch(q0509ModelFailureFallback.reply, /AI 暂时连不上/);
  }
  assert.equal(bundle.modelFailureFallback(q0509Question, { ...q0509Route, matched: false }, { status: 429, message: 'rate limit' }), null, 'Q0509 问法 route miss 时仍必须失败');
  const insufficientChainRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'INSUFFICIENT-CHAIN', title: '库存同步', fallbackMode: 'verifiedFacts' },
    answerFacts: ['库存同步是一项系统功能。'],
    directEvidenceFacts: [],
  };
  const insufficientChainQuestion = '把库存同步从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。';
  const insufficientChainAudit = bundle.audit('', insufficientChainQuestion, insufficientChainRoute);
  assert.equal(insufficientChainAudit.chainEvidenceSufficient, false, '只有模糊总述不构成可发布的多维链路证据');
  assert.equal(bundle.modelFailureFallback(insufficientChainQuestion, insufficientChainRoute, { status: 429, message: 'rate limit' }), null, '证据不足的 matched route 不得因模型失败而伪造 chain');

  const q0513Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0513')?.question;
  assert.equal(q0513Question, '多数据库方言适配（MySQL/达梦/PostgreSQL 三库同逻辑不同 SQL）现场暂时不能改数据、重放消息或重提任务。仅用已有记录应该怎样缩小范围？');
  const q0513Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0513Question), '2.7.260828-3');
  assert.equal(q0513Route.route.id, 'AUD-QR-SC-02', 'Q0513 必须命中多数据库方言 current route');
  const q0513GenericDraft = [
    '结论：现有受限证据只够固定已经提供的观测，不足以闭环原因。',
    '只核对已有请求、响应和记录，拿不到的项标为未知。',
    '本轮不改数据、不重放消息、不重提任务。',
  ].join('\n');
  const q0513Initial = bundle.audit(q0513GenericDraft, q0513Question, q0513Route);
  assert.equal(q0513Initial.existingRecordNarrowingQuestion, true);
  assert.match(q0513Initial.routeReadOnlySequenceFact, /现场只读排查顺序/);
  assert.deepEqual(q0513Initial.routeReadOnlySequenceSteps.map(step => step.text), [
    '看快照 updateTime 和 projectName',
    '看定时任务',
    '数据源 key 核对连接日志与产品名',
    '确认 Mapper 分支及项目的数据源和医院范围',
    '读该分支既有 SQL 日志',
    '医生操作数需单独确认是否为 MySQL 已知缺项',
  ]);
  assert.ok(q0513Initial.missingRouteReadOnlySequenceSteps.length >= 5, '通用受限证据话术不能代替 route 明确的只读缩小顺序');
  assert.ok(q0513Initial.violations.includes('incomplete_verified_facts'));
  const q0513Reply = bundle.fallback(q0513GenericDraft, q0513Initial);
  assert.match(q0513Reply, /已有记录只读缩小顺序/);
  for (const expected of [
    /快照 updateTime 和 projectName/,
    /定时任务/,
    /数据源 key 核对连接日志与产品名/,
    /Mapper 分支及项目的数据源和医院范围/,
    /该分支既有 SQL 日志/,
    /医生操作数需单独确认是否为 MySQL 已知缺项/,
  ]) assert.match(q0513Reply, expected);
  assert.match(q0513Reply, /本轮只读边界：不改数据、不重放消息、不重提任务/);
  const q0513Final = bundle.audit(q0513Reply, q0513Question, q0513Route);
  assert.deepEqual(q0513Final.missingRouteReadOnlySequenceSteps, []);
  assert.deepEqual(q0513Final.violations, [], JSON.stringify({ reply: q0513Reply, violations: q0513Final.violations }, null, 2));

  const noSequenceQuestion = '库存历史现场不能改数据。仅用已有记录应该怎样缩小范围？';
  const noSequenceRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'NO-SEQUENCE', title: '库存历史', fallbackMode: 'verifiedFacts' },
    answerFacts: ['库存历史页只展示已有记录，不修改业务数据。'],
  };
  const noSequenceInitial = bundle.audit('', noSequenceQuestion, noSequenceRoute);
  assert.equal(noSequenceInitial.routeReadOnlySequenceFact, '', '无 route 顺序锚点时不得臆造步骤');
  assert.deepEqual(noSequenceInitial.routeReadOnlySequenceSteps, []);
  const noSequenceReply = bundle.fallback('', noSequenceInitial);
  assert.doesNotMatch(noSequenceReply, /已有记录只读缩小顺序|updateTime|projectName|Mapper|SQL 日志/);

  const q0522Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0522')?.question;
  assert.equal(q0522Question, '登录与鉴权涉及哪些接口、数据和边界？');
  const q0522Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0522Question), '2.7.260828-3');
  assert.equal(q0522Route.route.id, 'AUD-QR-SH-01', 'Q0522 必须命中登录与鉴权 current route');
  const q0522Initial = bundle.audit('', q0522Question, q0522Route);
  const q0522Reply = bundle.fallback('', q0522Initial);
  const q0522Final = bundle.audit(q0522Reply, q0522Question, q0522Route);
  assert.deepEqual(q0522Final.violations, [], JSON.stringify({
    initialViolations: q0522Initial.violations,
    mode: q0522Initial.fallbackAnswerMode,
    verifiedInterfaceDiagnostic: q0522Initial.verifiedInterfaceDataBoundaryDiagnosticQuestion,
    signatures: q0522Initial.requiredInterfaceDataBoundarySignatures,
    checklistItems: q0522Initial.interfaceDataBoundaryChecklistItems,
    reply: q0522Reply,
    finalViolations: q0522Final.violations,
    missingSignatures: q0522Final.missingInterfaceDataBoundarySignatures,
    missingChecklist: q0522Final.missingInterfaceDataBoundaryChecklistItems,
    structureComplete: q0522Final.interfaceDataBoundaryRouteStructureComplete,
    diagnosticComplete: q0522Final.interfaceDataBoundaryDiagnosticComplete,
    unsafeActions: [q0522Final.unsafeActorActionCount, q0522Final.unsafeDirectActionCount],
    incompletePairedBranches: q0522Final.incompletePairedBranches,
    unexpectedPaths: q0522Final.unexpectedPaths,
    unexpectedEntities: q0522Final.unexpectedEntityTerms,
    unexpectedTechnicalTokens: q0522Final.unexpectedTechnicalTokens,
  }, null, 2));
  for (const expected of [
    /首次进入/,
    /多设备/,
    /用户中心签发的常规 token/,
    /双 token/,
    /退出：/,
    /登录只读排查/,
    /MD5 密码值/,
    /禁止共享完整 token 或密码/,
  ]) assert.match(q0522Reply, expected);
  assert.deepEqual(q0522Initial.requiredInterfaceDataBoundarySignatures, [
    'GET /api/comm/config?sysModel=1&sysFunction=login_page_config&configName=login_page_info',
  ], '宽诊断只能从 current route 精确 contextRefs 恢复已核 HTTP 签名');
  const q0522PublishedHttpSignatures = Array.from(q0522Reply.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./{}?=&:%*\-]+/gu), match => match[0]);
  assert.deepEqual(Array.from(new Set(q0522PublishedHttpSignatures)), q0522Initial.requiredInterfaceDataBoundarySignatures, '不得为登录宽诊断臆造 contextRefs 未提供的接口');
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { status: 429, message: 'rate limit' },
  ]) {
    const q0522ModelFailureFallback = bundle.modelFailureFallback(q0522Question, q0522Route, modelError);
    assert.ok(q0522ModelFailureFallback, `Q0522 ${modelError.code || modelError.status} 应发布已核 field-diagnostic fallback`);
    assert.equal(q0522ModelFailureFallback.fallbackSource, 'verifiedFacts');
    assert.equal(q0522ModelFailureFallback.initialAudit.fallbackAnswerMode, 'field_diagnostic');
    assert.deepEqual(q0522ModelFailureFallback.finalAudit.violations, []);
    assert.doesNotMatch(q0522ModelFailureFallback.reply, /AI 暂时连不上|当前回答未通过发布前事实与动作安全校验/);
  }
  assert.equal(bundle.modelFailureFallback(q0522Question, { ...q0522Route, matched: false }, { status: 429, message: 'rate limit' }), null, 'Q0522 route miss 不得绕过证据门');
  assert.equal(bundle.modelFailureFallback(q0522Question, {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'EMPTY-LOGIN', title: '登录与鉴权', fallbackMode: 'verifiedFacts' },
    answerFacts: [],
    directEvidenceFacts: [],
  }, { status: 429, message: 'rate limit' }), null, 'matched 但无已核业务 facts 时仍属证据不足');
  assert.ok(bundle.audit('判断结果：\n- 成功：只记录成功分支。', q0522Question, q0522Route).violations.includes('incomplete_paired_branch'), '真正的成功/失败结构缺边仍必须拦截');

  const q0527Question = '另一轮独立复测（527）里，登录与鉴权涉及哪些接口、数据和边界？';
  const q0527Route = runtimeRouteWithRepositoryContext(routeQuestion(auditTag3RouteMap, q0527Question), '2.7.260828-3');
  assert.equal(q0527Route.route.id, 'AUD-QR-SH-01', '独立复测前缀不得改变登录与鉴权 current route');
  const q0527Initial = bundle.audit('', q0527Question, q0527Route);
  const q0527Reply = bundle.fallback('', q0527Initial);
  const q0527Final = bundle.audit(q0527Reply, q0527Question, q0527Route);
  const q0527Fallback = bundle.verifiedFallback(q0527Question, q0527Route);
  assert.ok(q0527Fallback, JSON.stringify({
    message: 'Q0527 带复测前缀仍应发布登录与鉴权已核 fallback',
    initialViolations: q0527Initial.violations,
    mode: q0527Initial.fallbackAnswerMode,
    reply: q0527Reply,
    finalViolations: q0527Final.violations,
    missingSignatures: q0527Final.missingInterfaceDataBoundarySignatures,
    missingChecklist: q0527Final.missingInterfaceDataBoundaryChecklistItems,
  }, null, 2));
  assert.deepEqual(q0527Fallback.finalAudit.violations, []);
  assert.doesNotMatch(q0527Fallback.reply, /当前回答未通过发布前事实与动作安全校验|AI 暂时连不上/);
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { status: 429, message: 'rate limit' },
  ]) {
    const q0527ModelFailure = bundle.modelFailureFallback(q0527Question, q0527Route, modelError);
    assert.ok(q0527ModelFailure, `Q0527 ${modelError.code || modelError.status} 应发布 route-aware 已核回答`);
    assert.equal(q0527ModelFailure.fallbackSource, 'verifiedFacts');
    assert.deepEqual(q0527ModelFailure.finalAudit.violations, []);
  }

  const q0539Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0539')?.question;
  const q0540Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0540')?.question;
  assert.equal(q0540Question, '回到登录与鉴权这里，第一层核过没有异常，下一步按什么顺序继续只读排查？');
  const q0540MatchedRoute = contextualRouteQuestion(auditTag3RouteMap, [
    { role: 'user', content: q0539Question },
    { role: 'assistant', content: '上一轮模型回答不作为事实源。' },
    { role: 'user', content: q0540Question },
  ], q0540Question, '');
  const q0540Route = runtimeRouteWithRepositoryContext(q0540MatchedRoute, '2.7.260828-3');
  assert.equal(q0540Route.route.id, 'AUD-QR-SH-01', 'Q0540 必须保持登录与鉴权 current route');
  const q0540Initial = bundle.audit('', q0540Question, q0540Route);
  const q0540Reply = bundle.fallback('', q0540Initial);
  const q0540Final = bundle.audit(q0540Reply, q0540Question, q0540Route);
  assert.equal(q0540Initial.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0540Initial.contextFollowupQuestion, true);
  assert.match(q0540Initial.routeReadOnlySequenceFact, /登录只读排查/);
  assert.deepEqual(q0540Initial.routeReadOnlySequenceSteps.map(step => step.text), [
    '确认页面类型、医院/账号上下文和 token scope，只记录 token 是否存在并脱敏',
    '读院区列表、多设备检测、登录响应',
    '已登录后异常再读用户信息/菜单、动态路由和失败请求 HTTP 响应',
  ]);
  for (const expected of [
    /页面类型、医院\/账号上下文和 token scope/,
    /只记录 token 是否存在并脱敏/,
    /院区列表、多设备检测、登录响应/,
    /用户信息\/菜单、动态路由和失败请求 HTTP 响应/,
    /禁止共享完整 token 或密码/,
  ]) assert.match(q0540Reply, expected);
  const q0540PageIndex = q0540Reply.indexOf('页面类型、医院/账号上下文和 token scope');
  const q0540LoginIndex = q0540Reply.indexOf('院区列表、多设备检测、登录响应');
  const q0540LoggedInIndex = q0540Reply.indexOf('用户信息/菜单、动态路由和失败请求 HTTP 响应');
  assert.ok(q0540PageIndex >= 0 && q0540LoginIndex > q0540PageIndex && q0540LoggedInIndex > q0540LoginIndex, 'Q0540 必须保留登录 route 的三层只读顺序');
  assert.deepEqual(q0540Final.missingRouteReadOnlySequenceSteps, []);
  assert.deepEqual(q0540Final.violations, [], JSON.stringify({ reply: q0540Reply, violations: q0540Final.violations }, null, 2));
  for (const modelError of [
    { code: 'MODEL_FIRST_TOKEN_TIMEOUT', message: '模型首字等待超时' },
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
  ]) {
    const q0540Fallback = bundle.modelFailureFallback(q0540Question, q0540Route, modelError);
    assert.ok(q0540Fallback, JSON.stringify({
      message: `Q0540 ${modelError.code} 应发布 current route 的只读顺序`,
      initialViolations: q0540Initial.violations,
      mode: q0540Initial.fallbackAnswerMode,
      sequenceFact: q0540Initial.routeReadOnlySequenceFact,
      sequenceSteps: q0540Initial.routeReadOnlySequenceSteps,
      reply: q0540Reply,
      finalViolations: q0540Final.violations,
      missingSequence: q0540Final.missingRouteReadOnlySequenceSteps,
    }, null, 2));
    assert.equal(q0540Fallback.fallbackSource, 'verifiedFacts');
    assert.deepEqual(q0540Fallback.finalAudit.violations, []);
    assert.doesNotMatch(q0540Fallback.reply, /当前回答未通过发布前事实与动作安全校验|AI 暂时连不上/);
  }
  const q0540RouteMiss = { ...q0540Route, matched: false };
  const q0540Stopped = bundle.modelFailureFallback(q0540Question, q0540RouteMiss, { code: 'MODEL_FIRST_TOKEN_TIMEOUT', message: '模型首字等待超时' });
  assert.ok(q0540Stopped, 'Q0540 route miss 的诊断追问应安全停住而不是伪造登录顺序');
  assert.equal(q0540Stopped.fallbackSource, 'evidenceStop');
  assert.deepEqual(q0540Stopped.finalAudit.violations, []);
  assert.doesNotMatch(q0540Stopped.reply, /院区列表|多设备检测|token scope|动态路由/);
  const q0540UnsafeDraft = '请让实施人员修改接口配置后重新触发登录。';
  const q0540UnsafeAudit = bundle.audit(q0540UnsafeDraft, q0540Question, q0540Route);
  assert.ok(q0540UnsafeAudit.violations.includes('cross_actor_side_effect'), 'Q0540 不能因有 route 只读顺序而放宽真实写操作门');
  const q0540SafeFromUnsafe = bundle.fallback(q0540UnsafeDraft, q0540UnsafeAudit);
  assert.deepEqual(bundle.audit(q0540SafeFromUnsafe, q0540Question, q0540Route).violations, []);
  assert.doesNotMatch(q0540SafeFromUnsafe, /修改接口配置后重新触发登录/);

  const q0548Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0548')?.question;
  const q0549Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0549')?.question;
  assert.equal(q0549Question, '把权限·动态菜单·路由守卫从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。');
  const q0549MatchedRoute = contextualRouteQuestion(auditTag3RouteMap, [
    { role: 'user', content: q0548Question },
    { role: 'assistant', content: '上一轮模型回答不作为事实源。' },
    { role: 'user', content: q0549Question },
  ], q0549Question, '');
  const q0549Route = runtimeRouteWithRepositoryContext(q0549MatchedRoute, '2.7.260828-3');
  assert.equal(q0549Route.route.id, 'AUD-QR-SH-02', 'Q0549 必须保持权限·动态菜单·路由守卫 current route');
  const q0549Initial = bundle.audit('', q0549Question, q0549Route);
  const q0549Reply = bundle.fallback('', q0549Initial);
  const q0549Final = bundle.audit(q0549Reply, q0549Question, q0549Route);
  assert.equal(q0549Initial.fallbackAnswerMode, 'chain');
  assert.equal(q0549Initial.chainEvidenceSufficient, true);
  for (const expected of [
    /入口：登录后左侧菜单由用户中心/,
    /GET \/api\/user\/menu\/model\/v3/,
    /modelId=7/,
    /前端转为动态路由/,
    /外部依赖：[^\n]*用户中心/,
    /当前停点：本轮到上述已核链路为止/,
  ]) assert.match(q0549Reply, expected);
  const q0549EntryIndex = q0549Reply.indexOf('- 入口：');
  const q0549InterfaceIndex = q0549Reply.indexOf('- 接口：');
  const q0549DataIndex = q0549Reply.indexOf('- 数据与状态：');
  const q0549DependencyIndex = q0549Reply.indexOf('- 外部依赖：');
  const q0549StopIndex = q0549Reply.indexOf('当前停点：');
  assert.ok(q0549EntryIndex >= 0
    && q0549InterfaceIndex > q0549EntryIndex
    && q0549DataIndex > q0549InterfaceIndex
    && q0549DependencyIndex > q0549DataIndex
    && q0549StopIndex > q0549DependencyIndex, 'Q0549 确定性链路必须按入口→接口/数据→外部依赖→停点组织');
  assert.deepEqual(q0549Final.violations, [], JSON.stringify({ reply: q0549Reply, violations: q0549Final.violations }, null, 2));
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { code: 'MODEL_FIRST_TOKEN_TIMEOUT', message: '模型首字等待超时' },
  ]) {
    const q0549Fallback = bundle.modelFailureFallback(q0549Question, q0549Route, modelError);
    assert.ok(q0549Fallback, JSON.stringify({
      message: `Q0549 ${modelError.code} 应发布已核链路 fallback`,
      mode: q0549Initial.fallbackAnswerMode,
      chainDimensions: q0549Initial.chainDimensions,
      chainKnownFactDimensions: q0549Initial.chainKnownFactDimensions,
      chainEvidenceSufficient: q0549Initial.chainEvidenceSufficient,
      safeChainFallback: q0549Initial.safeChainFallback,
      safeViolations: q0549Final.violations,
      unsupportedLikelihoodClaims: q0549Final.unsupportedLikelihoodClaims,
      unsupportedCausalLocalizationClaims: q0549Final.unsupportedCausalLocalizationClaims,
      unsupportedDeterministicFailureClaims: q0549Final.unsupportedDeterministicFailureClaims,
      missingDimensions: q0549Final.missingChainDimensions,
      missingFacts: q0549Final.missingChainKeyBusinessFacts,
    }, null, 2));
    assert.equal(q0549Fallback.fallbackSource, 'verifiedFacts');
    assert.deepEqual(q0549Fallback.finalAudit.violations, []);
    assert.doesNotMatch(q0549Fallback.reply, /当前回答未通过发布前事实与动作安全校验|AI 暂时连不上/);
  }
  assert.equal(bundle.modelFailureFallback(q0549Question, { ...q0549Route, matched: false }, { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限' }), null, 'Q0549 route miss 不得把相邻 route facts 当已核链路发布');
  const q0549UnsafeDraft = `${q0549Reply}\n请让实施人员修改接口配置后重试。`;
  const q0549UnsafeAudit = bundle.audit(q0549UnsafeDraft, q0549Question, q0549Route);
  assert.ok(q0549UnsafeAudit.violations.includes('cross_actor_side_effect'), 'verified chain 只放行可追溯 route 原句，模型新增写操作仍须拦截');

  const q0594Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0594')?.question;
  const q0595Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0595')?.question;
  assert.equal(q0595Question, '回到AI 审方生成这里，第一层核过没有异常，下一步按什么顺序继续只读排查？');
  const q0595MatchedRoute = contextualRouteQuestion(auditTag3RouteMap, [
    { role: 'user', content: q0594Question },
    { role: 'assistant', content: '上一轮模型回答不作为事实源。' },
    { role: 'user', content: q0595Question },
  ], q0595Question, '');
  const q0595Route = runtimeRouteWithRepositoryContext(q0595MatchedRoute, '2.7.260828-3');
  assert.equal(q0595Route.route.id, 'AUD-QR-AI-01', 'Q0595 必须沿用刚切换后的 AI 审方生成 current route');
  const q0595Initial = bundle.audit('', q0595Question, q0595Route);
  const q0595Reply = bundle.fallback('', q0595Initial);
  const q0595Final = bundle.audit(q0595Reply, q0595Question, q0595Route);
  assert.equal(q0595Initial.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0595Initial.contextFollowupQuestion, true);
  assert.match(q0595Initial.routeReadOnlySequenceFact, /实施只读清单/);
  assert.deepEqual(q0595Initial.routeReadOnlySequenceSteps.map(step => step.text), [
    '记录当前页面和 opt/ipt 来源、任务/患者上下文、脱敏请求体、HTTP 状态与 Content-Type、流式首末块、时间和已有 requestId',
    '按时间和标识只读对照场景配置、服务端日志、生成记录 task_id/content 和有权限的 Dify 任务',
  ]);
  for (const expected of [
    /opt\/ipt 来源/,
    /Dify/,
    /生成记录 task_id\/content/,
    /药师手动采纳|立即加入审核建议/,
    /不得重复提交真实业务/,
    /不得[^。\n]*改生成记录或审核状态/,
    /不得凭空补 taskId、密钥或成功结论/,
  ]) assert.match(q0595Reply, expected);
  assert.deepEqual(q0595Final.missingRouteReadOnlySequenceSteps, []);
  assert.deepEqual(q0595Final.violations, [], JSON.stringify({
    reply: q0595Reply,
    initialViolations: q0595Initial.violations,
    finalViolations: q0595Final.violations,
    sequenceFact: q0595Initial.routeReadOnlySequenceFact,
    sequenceSteps: q0595Initial.routeReadOnlySequenceSteps,
    missingSequence: q0595Final.missingRouteReadOnlySequenceSteps,
    technicalDump: q0595Final.audienceTechnicalDumpParts,
    unsafeActorActionCount: q0595Final.unsafeActorActionCount,
    unsafeDirectActionCount: q0595Final.unsafeDirectActionCount,
  }, null, 2));
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { code: 'MODEL_FIRST_TOKEN_TIMEOUT', message: '模型首字等待超时' },
  ]) {
    const q0595Fallback = bundle.modelFailureFallback(q0595Question, q0595Route, modelError);
    assert.ok(q0595Fallback, JSON.stringify({
      message: `Q0595 ${modelError.code} 应发布 AI route 的只读续查顺序`,
      reply: q0595Reply,
      initialViolations: q0595Initial.violations,
      finalViolations: q0595Final.violations,
      sequenceFact: q0595Initial.routeReadOnlySequenceFact,
      sequenceSteps: q0595Initial.routeReadOnlySequenceSteps,
      missingSequence: q0595Final.missingRouteReadOnlySequenceSteps,
    }, null, 2));
    assert.equal(q0595Fallback.fallbackSource, 'verifiedFacts');
    assert.deepEqual(q0595Fallback.finalAudit.violations, []);
    assert.doesNotMatch(q0595Fallback.reply, /当前回答未通过发布前事实与动作安全校验|AI 暂时连不上/);
  }
  const q0595RouteMiss = { ...q0595Route, matched: false };
  const q0595Stopped = bundle.modelFailureFallback(q0595Question, q0595RouteMiss, { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限' });
  assert.ok(q0595Stopped, 'Q0595 route miss 的只读追问应安全停住，不能发布相邻 AI route 事实');
  assert.equal(q0595Stopped.fallbackSource, 'evidenceStop');
  assert.deepEqual(q0595Stopped.finalAudit.violations, []);
  assert.doesNotMatch(q0595Stopped.reply, /opt\/ipt|Dify|audit_ai_generate|药师手动采纳/);
  const q0595UnsafeDraft = '请重新提交真实业务，手工修改生成记录和审核状态，并补一个 taskId 后重试。';
  const q0595UnsafeAudit = bundle.audit(q0595UnsafeDraft, q0595Question, q0595Route);
  assert.ok(q0595UnsafeAudit.violations.includes('cross_actor_side_effect'), 'Q0595 current route 不能放宽模型新增写操作');
  const q0595SafeFromUnsafe = bundle.fallback(q0595UnsafeDraft, q0595UnsafeAudit);
  assert.deepEqual(bundle.audit(q0595SafeFromUnsafe, q0595Question, q0595Route).violations, []);
  assert.doesNotMatch(q0595SafeFromUnsafe, /请重新提交真实业务|手工修改生成记录和审核状态|补一个 taskId/);

  const q0614Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0614')?.question;
  const q0615Question = auditBrowserQuestions.questions.find(item => item.id === 'Q0615')?.question;
  assert.equal(q0615Question, '另一轮独立复测（615）里，我没完全听懂AI 审方生成的排查建议，换成实施可以逐项照做的只读清单。');
  const q0615MatchedRoute = contextualRouteQuestion(auditTag3RouteMap, [
    { role: 'user', content: q0614Question },
    { role: 'assistant', content: '上一轮模型回答不作为事实源。' },
    { role: 'user', content: q0615Question },
  ], q0615Question, '');
  const q0615Route = runtimeRouteWithRepositoryContext(q0615MatchedRoute, '2.7.260828-3');
  assert.equal(q0615Route.route.id, 'AUD-QR-AI-01', 'Q0615 必须沿用刚切换后的 AI 审方生成 current route');
  const q0615Initial = bundle.audit('', q0615Question, q0615Route);
  const q0615Reply = bundle.fallback('', q0615Initial);
  const q0615Final = bundle.audit(q0615Reply, q0615Question, q0615Route);
  assert.equal(q0615Initial.fallbackAnswerMode, 'field_diagnostic');
  assert.equal(q0615Initial.implementationChecklistQuestion, true);
  assert.equal(q0615Initial.continuationDiagnosticQuestion, false);
  assert.equal(q0615Initial.contextFollowupQuestion, true);
  assert.match(q0615Initial.routeReadOnlySequenceFact, /实施只读清单/);
  assert.deepEqual(q0615Initial.routeReadOnlySequenceSteps.map(step => step.text), [
    '记录当前页面和 opt/ipt 来源、任务/患者上下文、脱敏请求体、HTTP 状态与 Content-Type、流式首末块、时间和已有 requestId',
    '按时间和标识只读对照场景配置、服务端日志、生成记录 task_id/content 和有权限的 Dify 任务',
  ]);
  for (const expected of [
    /opt\/ipt 来源/,
    /Dify/,
    /生成记录 task_id\/content/,
    /药师手动采纳|立即加入审核建议/,
    /不得重复提交真实业务/,
    /不得[^。\n]*改生成记录或审核状态/,
    /不得凭空补 taskId、密钥或成功结论/,
  ]) assert.match(q0615Reply, expected);
  assert.deepEqual(q0615Final.missingRouteReadOnlySequenceSteps, []);
  assert.deepEqual(q0615Final.violations, [], JSON.stringify({
    reply: q0615Reply,
    initialViolations: q0615Initial.violations,
    finalViolations: q0615Final.violations,
    sequenceFact: q0615Initial.routeReadOnlySequenceFact,
    sequenceSteps: q0615Initial.routeReadOnlySequenceSteps,
    missingSequence: q0615Final.missingRouteReadOnlySequenceSteps,
    technicalDump: q0615Final.audienceTechnicalDumpParts,
  }, null, 2));
  for (const modelError of [
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { code: 'MODEL_FIRST_TOKEN_TIMEOUT', message: '模型首字等待超时' },
  ]) {
    const q0615Fallback = bundle.modelFailureFallback(q0615Question, q0615Route, modelError);
    assert.ok(q0615Fallback, JSON.stringify({
      message: `Q0615 ${modelError.code} 应发布 AI route 的实施逐项只读清单`,
      reply: q0615Reply,
      initialViolations: q0615Initial.violations,
      finalViolations: q0615Final.violations,
      sequenceFact: q0615Initial.routeReadOnlySequenceFact,
      sequenceSteps: q0615Initial.routeReadOnlySequenceSteps,
      missingSequence: q0615Final.missingRouteReadOnlySequenceSteps,
    }, null, 2));
    assert.equal(q0615Fallback.fallbackSource, 'verifiedFacts');
    assert.deepEqual(q0615Fallback.finalAudit.violations, []);
    assert.doesNotMatch(q0615Fallback.reply, /当前回答未通过发布前事实与动作安全校验|AI 暂时连不上/);
  }
  const q0615RouteMiss = { ...q0615Route, matched: false };
  const q0615Stopped = bundle.modelFailureFallback(q0615Question, q0615RouteMiss, { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限' });
  assert.equal(q0615Stopped, null, 'Q0615 route miss 不得把相邻 AI route 事实伪装成已核实施清单');
  const q0615UnsafeDraft = '请重新提交真实业务，手工修改生成记录和审核状态，并补一个 taskId 和密钥后重试。';
  const q0615UnsafeAudit = bundle.audit(q0615UnsafeDraft, q0615Question, q0615Route);
  assert.ok(q0615UnsafeAudit.violations.includes('cross_actor_side_effect'), 'Q0615 current route 不能放宽模型新增写操作');
  const q0615SafeFromUnsafe = bundle.fallback(q0615UnsafeDraft, q0615UnsafeAudit);
  assert.deepEqual(bundle.audit(q0615SafeFromUnsafe, q0615Question, q0615Route).violations, []);
  assert.doesNotMatch(q0615SafeFromUnsafe, /请重新提交真实业务|手工修改生成记录和审核状态|补一个 taskId 和密钥/);

  const chargeQuestions = [
    '收费时，提醒HIS收费发起失败，收费状态未确认成功，这个是什么问题需要怎么处理',
    '怎么撤销收费',
    '怎么发起收费',
  ];
  const crossModuleDrafts = [
    '这是 HC1015 医院业务变化消息失败，应沿 RedisConsumer 和 DI-07 继续处理 15 类医院业务变化。',
    '这是门诊自动通过流程，应检查 AUDIT:OPT:AUTO 和 RedisConsumer 后撤销。',
    '这是门诊审方任务操作，按审核通过链路重新发起即可。',
  ];
  for (const [index, question] of chargeQuestions.entries()) {
    const routeMiss = routeQuestion(auditTag3RouteMap, question);
    assert.equal(routeMiss.matched, false, `${question} 没有收费直接证据时必须 route miss`);
    assert.ok(routeMiss.explicitOperationEvidenceMiss.some(item => item.entity === '收费'), JSON.stringify(routeMiss));
    const badAudit = bundle.audit(crossModuleDrafts[index], question, routeMiss);
    assert.ok(badAudit.violations.includes('missing_explicit_operation_evidence'), `${question} 的正常模型串答必须被终审拦截`);
    const safeReply = bundle.fallback(crossModuleDrafts[index], badAudit);
    const finalAudit = bundle.audit(safeReply, question, routeMiss);
    assert.deepEqual(finalAudit.violations, [], JSON.stringify({ question, safeReply, violations: finalAudit.violations }, null, 2));
    assert.match(safeReply, /现有页面提示/);
    assert.match(safeReply, /同一次已有请求与响应/);
    assert.match(safeReply, /当前业务状态/);
    assert.match(safeReply, /发生时间/);
    assert.match(safeReply, /账号和院区/);
    assert.match(safeReply, /不得发起/);
    assert.match(safeReply, /不得撤销/);
    assert.doesNotMatch(safeReply, /HC1015|DI-07|AUDIT:OPT:AUTO|RedisConsumer|门诊自动通过|审核通过/);
    for (const modelError of [
      { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
      { status: 429, message: 'rate limit' },
    ]) {
      const stopped = bundle.modelFailureFallback(question, routeMiss, modelError);
      assert.ok(stopped, `${question} ${modelError.code || modelError.status} 应发布收费证据安全停点`);
      assert.equal(stopped.fallbackSource, 'evidenceStop');
      assert.deepEqual(stopped.finalAudit.violations, []);
      assert.equal(stopped.reply, safeReply);
    }
  }

  const pwrsTag = '2.7.260826-1';
  const pwrsRouteMap = JSON.parse(execFileSync(
    'git', ['show', `${pwrsTag}:docs/specs/00-功能模块地图.json`],
    { cwd: path.resolve(ROOT, '../psp/pwrs'), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  ));
  const pwrsChargeRoutes = chargeQuestions.map(question => routeQuestion(pwrsRouteMap, question));
  assert.equal(pwrsChargeRoutes[0].route.id, 'DQ-011', 'PWRS 收费失败/状态未确认应命中收费半成功 current route');
  assert.equal(pwrsChargeRoutes[1].route.id, 'DQ-011', 'PWRS 撤销收费应命中收费删除/撤销边界 current route');
  assert.equal(pwrsChargeRoutes[2].matched, false, 'PWRS 发起收费问法没有可发布的直接步骤事实时保持 evidence miss');
  for (const modelError of [
    { code: 'MODEL_FIRST_TOKEN_TIMEOUT', message: '模型首字等待超时' },
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
  ]) {
    const halfSuccess = bundle.modelFailureFallback(chargeQuestions[0], pwrsChargeRoutes[0], modelError);
    assert.ok(halfSuccess, `PWRS 收费半成功 ${modelError.code} 必须发布确定性已核事实`);
    assert.equal(halfSuccess.fallbackSource, 'verifiedOperationFacts');
    assert.deepEqual(halfSuccess.finalAudit.violations, []);
    assert.match(halfSuccess.reply, /PWRS 本地事务无法回滚 HIS/);
    assert.match(halfSuccess.reply, /半成功风险/);
    assert.match(halfSuccess.reply, /禁止重复收费/);
    assert.match(halfSuccess.reply, /HIS 交易证据对账/);
    assert.doesNotMatch(halfSuccess.reply, /允许重复收费|可以重复收费|自动重试/);

    const revokeStop = bundle.modelFailureFallback(chargeQuestions[1], pwrsChargeRoutes[1], modelError);
    assert.ok(revokeStop, `PWRS 撤销收费 ${modelError.code} 在无直接步骤事实时必须安全停住`);
    assert.equal(revokeStop.fallbackSource, 'evidenceStop');
    assert.deepEqual(revokeStop.finalAudit.violations, []);
    assert.match(revokeStop.reply, /不得撤销/);
    assert.doesNotMatch(revokeStop.reply, /删除本地记录|调用撤销接口|再次收费/);

    const initiateStop = bundle.modelFailureFallback(chargeQuestions[2], pwrsChargeRoutes[2], modelError);
    assert.ok(initiateStop, `PWRS 发起收费 ${modelError.code} 必须沿用 evidenceStop`);
    assert.equal(initiateStop.fallbackSource, 'evidenceStop');
    assert.deepEqual(initiateStop.finalAudit.violations, []);
    assert.match(initiateStop.reply, /不得发起/);
  }
  const unsafePwrsDrafts = [
    'HIS 提示失败就代表一定没有收费，可以直接再次发起收费。',
    '撤销收费就是删除本地记录，直接删除后再收费即可。',
  ];
  for (let index = 0; index < unsafePwrsDrafts.length; index++) {
    const unsafeAudit = bundle.audit(unsafePwrsDrafts[index], chargeQuestions[index], pwrsChargeRoutes[index]);
    assert.ok(unsafeAudit.violations.length > 0, `PWRS 正常模型的危险收费串答 ${index + 1} 必须被终审拦截`);
    assert.ok(unsafeAudit.violations.includes('unsupported_explicit_operation'));
    const safeReply = bundle.fallback(unsafePwrsDrafts[index], unsafeAudit);
    const safeAudit = bundle.audit(safeReply, chargeQuestions[index], pwrsChargeRoutes[index]);
    assert.deepEqual(safeAudit.violations, [], JSON.stringify({ index, safeReply, violations: safeAudit.violations }, null, 2));
    assert.doesNotMatch(safeReply, /可以直接再次发起收费|删除本地记录|再收费即可/);
  }
  for (const question of chargeQuestions) {
    const auditRouteMiss = routeQuestion(auditTag3RouteMap, question);
    assert.equal(auditRouteMiss.matched, false, '审方产品无收费直接事实时仍不得复用 PWRS 收费 route');
  }

  const directOperationMap = {
    questionRoutes: [{
      id: 'DIRECT-SETTLE', title: '发起结算', aliases: [], keywords: ['发起结算'],
      searchText: '发起结算 结算状态', answerFacts: ['发起结算的入口和状态均由当前流程明确。'], mustNotConfuse: [],
    }],
    specs: [], indexes: {},
  };
  assert.equal(routeQuestion(directOperationMap, '怎么发起结算').route.id, 'DIRECT-SETTLE', '同一 route 有直接操作证据时不得误杀');
  const negativeOnlyOperationMap = {
    questionRoutes: [{
      id: 'NEGATIVE-SETTLE', title: '结算说明', aliases: [], keywords: ['结算'],
      searchText: '结算说明', answerFacts: ['当前说明没有结算发起能力，不能外推发起步骤。'], mustNotConfuse: [],
    }],
    specs: [], indexes: {},
  };
  assert.equal(routeQuestion(negativeOnlyOperationMap, '怎么发起结算').matched, false, '只在否定边界出现的业务操作不得充当直接证据');

  const harmlessDraft = '当前只能确认页面出现了提示；具体业务原因、状态和操作路径仍未知。本轮不得重复提交。';
  for (const question of [...chargeQuestions, q0527Question]) {
    assert.doesNotThrow(() => bundle.audit(harmlessDraft, question, null), `${question} 的 answer_audit 不得读取 null route facts`);
    for (const modelError of [
      { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
      { status: 429, message: 'rate limit' },
    ]) {
      const stopped = bundle.modelFailureFallback(question, null, modelError);
      assert.ok(stopped, `${question} 在 route 对象缺失且模型失败时应给明确安全停点`);
      assert.equal(stopped.fallbackSource, 'evidenceStop');
      assert.deepEqual(stopped.finalAudit.violations, [], JSON.stringify({ question, reply: stopped.reply, violations: stopped.finalAudit.violations }, null, 2));
      assert.doesNotMatch(stopped.reply, /AI 暂时连不上|错误编号|Cannot read properties/);
      assert.match(stopped.reply, /(?:不得|不能|未知|缺少|只读|已有)/);
    }
  }

  const adjacentContextMap = {
    questionRoutes: [{
      id: 'LOGIN-CONTEXT', title: '登录鉴权上下文',
      aliases: ['登录鉴权 token 校验'], keywords: ['登录', '鉴权', 'token'],
      searchText: '登录鉴权 token 校验', answerFacts: ['登录鉴权事实'], mustNotConfuse: [], fallbackMode: 'verifiedFacts',
    }],
    specs: [], indexes: {},
  };
  const switchedChargeRoute = contextualRouteQuestion(adjacentContextMap, [
    { role: 'user', content: '登录鉴权 token 校验怎么做？' },
    { role: 'assistant', content: '这里是上一主题的模型自由文本。' },
    { role: 'user', content: '那怎么撤销收费' },
  ], '那怎么撤销收费');
  assert.equal(switchedChargeRoute.matched, false, '显式收费新实体不得继承相邻登录 route');
  assert.equal(switchedChargeRoute.contextOverride, true);
  const switchedStop = bundle.modelFailureFallback('那怎么撤销收费', switchedChargeRoute, { status: 429, message: 'rate limit' });
  assert.ok(switchedStop, '相邻上下文切换后的 route miss 应给无业务事实安全停点');
  assert.equal(switchedStop.fallbackSource, 'evidenceStop');
  assert.deepEqual(switchedStop.finalAudit.violations, []);
  assert.doesNotMatch(switchedStop.reply, /登录|token|鉴权/);

  const genericChainCoverageQuestion = '把库存快照从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。';
  const genericChainCoverageRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'GENERIC-CHAIN-SCOPE', title: '库存快照', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '入口：库存页面读取已有快照。',
      '业务口径：日趋势固定覆盖最近 14 天，月趋势固定覆盖最近 6 个月，分别统计入库和出库数量。',
      '接口：GET /comm/inventory/info 查询当前快照。',
      '数据与状态：inventory_snapshot 保存最新统计结果。',
      '外部依赖：仓储系统提供只读库存来源。',
    ],
    mustNotConfuse: [],
  };
  const genericChainCoverageInitial = bundle.audit('', genericChainCoverageQuestion, genericChainCoverageRoute);
  assert.deepEqual(genericChainCoverageInitial.chainKeyBusinessFacts, [genericChainCoverageRoute.answerFacts[1]], '通用规则应只选量化业务口径，不依赖大屏标题或固定天数');
  assert.match(genericChainCoverageInitial.safeChainFallback, /关键业务口径[^\n]*最近 14 天[^\n]*最近 6 个月/);
  assert.deepEqual(bundle.audit(genericChainCoverageInitial.safeChainFallback, genericChainCoverageQuestion, genericChainCoverageRoute).violations, [], '其它 implementation_chain 的中间量化事实也必须保留');

  const genericReadOnlyFactRoute = {
    ...genericImplementationRoute,
    answerFacts: ['系统当前只读取已有记录并展示结果；未经授权不应重试或补发。'],
  };
  const genericReadOnlyFactInitial = bundle.audit(genericReadOnlyFactRoute.answerFacts.join('\n'), genericReadOnlyHandoffQuestion, genericReadOnlyFactRoute);
  const genericReadOnlyFactReply = genericReadOnlyFactInitial.safeDiagnosticFallback;
  assert.doesNotMatch(genericReadOnlyFactReply, /另行授权.*定向补偿/s, '没有补偿/重做建议的 route 不应凭空追加补偿边界');

  const ordinaryExternalResultQuestion = '会话创建成功后返回什么状态？';
  const ordinaryExternalResultAudit = bundle.audit(genericReadOnlyFactRoute.answerFacts.join('\n'), ordinaryExternalResultQuestion, genericReadOnlyFactRoute);
  assert.equal(ordinaryExternalResultAudit.fieldDiagnosticQuestion, false, '没有失败结果或现场语境的普通状态题不得误扩成只读诊断');

  const q0041Question = Object.keys(browserRequirements).find(question => question === '另一轮独立复测（41）里，评语常用语维护现在是怎么实现的？');
  assert.ok(q0041Question, 'Q0041 应从真实浏览器题目 fixture 取到原问题');
  const q0041Route = runtimeRouteWithRepositoryContext(routeQuestion(productionRuntimeRouteMap, q0041Question), '2.7.260828-2');
  assert.equal(q0041Route.route.id, 'AUD-QR-CFG-02', 'Q0041 真实 route matcher 必须命中 CFG-02');
  assert.equal(q0041Route.answerFacts.length, 7, 'Q0041 应使用生产 route 的 7 条 CFG-02 facts');
  const q0041PartialDraft = '评语常用语维护给药师准备个人和共享常用语，按门诊、住院或全部范围使用，页面最多填写500个字符。';
  const q0041Initial = bundle.audit(q0041PartialDraft, q0041Question, q0041Route);
  assert.equal(q0041Initial.audienceMode, 'product', 'Q0041 的复测前缀不能覆盖核心事实问法的产品受众');
  assert.equal(q0041Initial.implementationFactCoverageQuestion, true, 'Q0041 broad as-built 问法必须启用 route fact 覆盖门');
  assert.ok(q0041Initial.violations.includes('incomplete_verified_facts'), 'Q0041 只给产品概括时必须拦截关键实现事实漏答');
  const q0041Fallback = bundle.fallback(q0041PartialDraft, q0041Initial);
  assert.match(q0041Fallback, /软删除|deleted/);
  assert.match(q0041Fallback, /back_reason|历史审核原因/);
  assert.match(q0041Fallback, /创建人|OPERATE_TEMPLATE_PERMISSION_DENIED|权限/);
  assert.match(q0041Fallback, /GET \/auditapi\/audit\/templates|POST \/auditapi\/audit\/template/);
  assert.deepEqual(bundle.audit(q0041Fallback, q0041Question, q0041Route).violations, [], 'Q0041 关键业务边界与研发事实补全后终审必须全绿');

  const q0021Question = '审核方案配置现在是怎么实现的？';
  const q0021Route = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-CFG-01', title: '审核方案配置', fallbackMode: 'verifiedFacts' },
    answerFacts: [
      '产品：同一家医院、同一种门诊或住院审核类型的系统方案是替换关系，当前新增不支持多套并存共同生效。',
      '影响：新建前会删除所选医院同类型的旧方案主记录及科室/病区、药品、药品属性关联，再逐家医院创建新方案；旧方案不是停用保留。',
      '实施：当前新增替换由多次删除和插入组成，操作前应留存旧配置，失败后核对主表和全部关联，不能假定自动回滚。',
      '时间：药师工作台按 pharmReviewerTime 显示审核倒计时；医生等待页按 docWaitTime 显示等待药师结果的倒计时。',
      '约束：医生等待时间必须大于等于药师审核时间+5秒；后台 Redis 过期再加 EXTRA_TIME=5 只是技术容错。',
      '排班：方案开启不等于全天人工审；已配审核日期必须命中当天，已配上午时段必须命中至少一段。',
      '结果：只读取 open=true 的当院当类型方案；方案关闭/不存在、已配日期不命中或已配时段全部不命中时，当前进件落为 auto_pass。',
      '边界：日期和时段只是前置门槛；通过后仍要校验警示、科室/病区、药品和药品属性等条件，不能承诺一定进人工审。',
      '当前页面：管理端编辑保存实际仍走按医院+schemeSource 删除旧记录后重建，原方案 ID 不保留。',
      '后端边界：后端另有 PUT /auditapi/audit/scheme 的就地编辑接口，但当前管理端未调用该 PUT。',
    ],
  };
  const q0021Draft = '审核方案按医院和审核类型配置，新增时替换旧方案；日期命中后进入审核判断。';
  const q0021Initial = bundle.audit(q0021Draft, q0021Question, q0021Route);
  assert.equal(q0021Initial.verifiedFactCoverageQuestion, true);
  assert.deepEqual(q0021Initial.missingVerifiedFactCoverage.map(fact => fact.split('：')[0]), ['边界']);
  assert.ok(q0021Initial.violations.includes('incomplete_verified_facts'), 'CFG-01 核心“日期/时段只是前置门槛”不能被普通怎么实现问法漏答后放行');
  const q0021Fallback = bundle.verifiedFallback(q0021Question, q0021Route);
  assert.ok(q0021Fallback, '模型草稿/修订均失败时 CFG-01 必须可用 verifiedFacts 确定性终稿');
  assert.match(q0021Fallback.reply, /日期和时段只是前置门槛/);
  assert.match(q0021Fallback.reply, /警示、科室\/病区、药品和药品属性/);
  assert.doesNotMatch(q0021Fallback.reply, /当前回答未通过发布前事实与动作安全校验/);
  assert.deepEqual(q0021Fallback.finalAudit.violations, [], 'CFG-01 verifiedFacts 终稿必须终审全绿');

  const modelFailureCases = [
    {
      id: 'AI-01-broad',
      question: aiBroadQuestion,
      route: aiBroadRoute,
    },
    {
      id: 'AI-01-partial',
      question: debugAiQuestion,
      route: debugAiRoute,
    },
    {
      id: 'AI-01-chain',
      question: '请把 AI 审方从入口、接口、数据到外部依赖完整串起来。',
      route: {
        matched: true,
        fallbackMode: 'verifiedFacts',
        route: { id: 'AUD-QR-AI-01', title: 'AI 审方生成', fallbackMode: 'verifiedFacts' },
        answerFacts: [
          '入口是审方页面的 AI 审方生成入口。',
          '开始生成调用 POST /comm/ai/generate。',
          '生成内容读取当前门诊或住院任务上下文，结果须由药师主动采纳。',
          '外部依赖是配置的 Dify 工作流，Dify 内部步骤和模型判断不属于当前已核事实。',
        ],
      },
    },
    {
      id: 'AI-01-implementation',
      question: '我没完全听懂 AI 审方的排查建议，换成实施可以逐项照做的只读清单。',
      route: {
        matched: true,
        inherited: true,
        fallbackMode: 'verifiedFacts',
        route: { id: 'AUD-QR-AI-01', title: 'AI 审方生成', fallbackMode: 'verifiedFacts' },
        answerFacts: [
          'AI 审方按当前任务上下文生成辅助建议，结果须由药师主动采纳。',
          '现场只读查看已有页面、请求、响应和日志，不重复提交真实业务。',
          '当前资料没有核实的接口、数据和后续状态不能补写。',
        ],
      },
    },
  ];
  for (const modelError of [
    { status: 429, message: 'rate limit' },
    { code: 'MODEL_OUTPUT_TRUNCATED', message: '模型输出达到长度上限，未完整结束' },
    { code: 'MODEL_EMPTY_RESPONSE', message: '模型返回空内容' },
  ]) {
    for (const scenario of modelFailureCases) {
      const result = bundle.modelFailureFallback(scenario.question, scenario.route, modelError);
      assert.ok(result, `${scenario.id} ${modelError.code || modelError.status} 应走 verifiedFacts fallback`);
      assert.equal(result.fallbackSource, 'verifiedFacts');
      assert.equal(result.modelDraftError.kind, modelError.status === 429 ? 'rate_limit' : modelError.code === 'MODEL_OUTPUT_TRUNCATED' ? 'length_limit' : 'empty_response');
      assert.deepEqual(result.finalAudit.violations, [], `${scenario.id} ${modelError.code || modelError.status} 终审应全绿`);
      assert.doesNotMatch(result.reply, /AI 暂时连不上/);
    }
  }
  assert.equal(bundle.modelFailureFallback('没有命中路由的问题', { matched: false, fallbackMode: 'verifiedFacts', answerFacts: ['不能把这条事实伪装成答案'] }, { status: 429, message: 'rate limit' }), null, 'route miss 不得伪造 verifiedFacts 答案');
  assert.equal(bundle.modelFailureFallback('普通路由问题', { matched: true, answerFacts: ['普通事实'] }, { code: 'MODEL_EMPTY_RESPONSE', message: '模型返回空内容' }), null, '未显式开启 verifiedFacts 的 route 不得伪造答案');

  const explicitFromToChainQuestion = '请把这个功能从入口、接口和数据状态到外部依赖完整串起来。';
  const explicitFromToChainAudit = bundle.audit('', explicitFromToChainQuestion, todayAtomicRoute);
  assert.equal(explicitFromToChainAudit.chainRequested, true, '真正同一分句内的从A到B研发链路仍须启用完整性合同');

  const q185Question = '医院 HIS 调用审方后收到“提交成功”，但之后一直查询不到审核结果。实施人员第一轮应该收集和核对哪些同一次请求证据？请说明是否必须拿到真实的 HTTP 方法与路径、interface_code、脱敏后的完整 XML 原文、原始响应、发生时间或请求标识和对应日志；只有一张报错截图够不够？为了复现能不能重发同一位真实患者的 XML？“提交成功”是否就等于审核闭环完成、结果已经回写给 HIS？';
  const q185Route = {
    matched: true,
    // 模拟上下文/诊断链只保住顶层发布策略的运行态；仍必须回到同一路由已核事实。
    fallbackMode: 'verifiedFacts',
    route: { id: 'AUD-QR-GUIDE-01', title: 'HIS XML 接入只读排查' },
    answerFacts: [
      '业务结论：HIS 收到“提交成功”只证明该次提交入口返回成功，不等于任务已分配、药师已审核、查询已有完成结果或结果已经回写给 HIS。',
      '同一次请求证据：确认 HTTP 方法为 POST、完整路径为 /external、query 参数 interface_code 的原值，并保存脱敏后的完整请求 XML、完整原始响应和请求时间；只有截图不能替代这些原始材料。',
      '关联证据：在已有日志中按同一次请求核对 requestId、submitId、taskId、医院/院区标识、当前业务状态、请求/响应日志；未取得的项目明确写“未取得”，不得用另一笔请求或另一环境样本代替。',
      '分层判定：提交入口成功后，继续只读核对任务状态、审核流水、查询响应和回写日志，定位首次出现差异的环节；没有逐层证据时不能直接归因于审方、HIS、网络、网关或某个服务。',
      '安全红线：现场只对照同一次已有请求、响应和日志；不得重发真实患者 XML，不得新建处方/医嘱，也不得调用审核、超时、回写或重试端点来复现。',
    ],
    mustNotConfuse: ['不得输出 current route、路由事实、最小缺口模板等内部措辞；不得把本机日期、星期或一次新的页面刷新列为 HIS 接入证据。'],
  };
  const q185UnsafeDraft = '一般是网络问题。先重发真实患者 XML 复现，再按截图判断。';
  const q185Audit = bundle.audit(q185UnsafeDraft, q185Question, q185Route);
  assert.equal(q185Audit.routeFallbackMode, 'verifiedFacts');
  assert.equal(q185Audit.verifiedFactsFallback, true, '顶层发布策略必须激活已核事实兜底');
  assert.doesNotMatch(q185Audit.safeDiagnosticFallback, /本机显示的日期和星期|current route/, '普通诊断模板本身也不得被一般请求时间或内部术语污染');
  const q185Fallback = bundle.fallback(q185UnsafeDraft, q185Audit);
  assert.match(q185Fallback, /^业务结论\n- 业务结论：HIS 收到“提交成功”/m);
  assert.match(q185Fallback, /实施口径\n- 同一次请求证据：确认 HTTP 方法为 POST/);
  assert.match(q185Fallback, /不得重发真实患者 XML/);
  assert.doesNotMatch(q185Fallback, /current route|最小缺口|本机.*日期.*星期|若本轮实际没有上传/);
  assert.deepEqual(bundle.audit(q185Fallback, q185Question, q185Route).violations, [], 'Q185 已核事实终稿必须无内部模板污染且终审全绿');

  const q122Question = '现场还卡在今天视图时间这里，我只拿得到这张截图，没有日志，够不够？';
  const q122GenericFallbackDraft = [
    '已知事实（继续作为判断基线）：',
    '- 工作台通过需合法 JWT 的 GET /pwrsapi/month/view/today 获取当前日期与星期',
    '- 响应为 Map<String,String>，包含 year=yyyy年M月d日 与 week=星期X',
    '最小只读排查：',
    '1. 原样记录当前页面、终端、账号角色、版本和发生时间。',
    '2. 整理截图后转开发。',
  ].join('\n');
  const q122GenericAudit = bundle.audit(q122GenericFallbackDraft, q122Question, todayAtomicRoute);
  assert.equal(q122GenericAudit.evidenceSufficiencyQuestion, true);
  assert.ok(q122GenericAudit.violations.includes('missing_evidence_sufficiency_verdict'), '泛模板即使包含route事实，也必须先直接回答截图够什么/不够什么');
  assert.ok(!q122GenericAudit.violations.includes('missing_evidence_minimum_route_fact'), '草稿已逐字包含主接口时不重复报路径缺失');
  assert.match(bundle.revision(q122GenericFallbackDraft, q122GenericAudit), /第一句话必须直接回答现有证据够完成什么、不够完成什么/);
  const q122Fallback = bundle.fallback(q122GenericFallbackDraft, q122GenericAudit);
  assert.match(q122Fallback, /^结论：这张截图只够固定当前页面现象，不能单独完成与已核规则的对照，也不足以闭环原因。/);
  assert.match(q122Fallback, /GET \/pwrsapi\/month\/view\/today 完整响应/);
  assert.match(q122Fallback, /响应内容只按当前已核事实核对：响应包含 year、week/);
  assert.match(q122Fallback, /同一时刻本机显示的日期和星期/);
  assert.match(q122Fallback, /不必先拿服务器日志/);
  assert.match(q122Fallback, /若本轮实际没有上传可核验附件/);
  assert.match(q122Fallback, /不能声称看见图内数字或内容/);
  assert.doesNotMatch(q122Fallback, /账号角色|版本、发生时间|完整提单材料/);
  assert.deepEqual(bundle.audit(q122Fallback, q122Question, todayAtomicRoute).violations, [], '确定性证据充分性fallback自身必须通过终稿审计');

  const q122R71ProductionDraft = [
    '结论：这张截图只够固定当前页面现象，不够完成三边对照，也不足以闭环原因。',
    '## 真正还缺的最小证据（不是服务端日志）',
    '还缺的是下面这一项：',
    '- `GET /pwrsapi/month/view/today` 的状态码和完整响应，至少保留 `year`、`week`。',
    '| 对照结果 | 判断 |',
    '| --- | --- |',
    '| 页面与 `year/week` 一致，但与当时浏览器/本机日期星期不同 | 记录三边差异 |',
    '| 页面与 `year/week` 不一致，但本机日期星期一致 | 记录页面差异 |',
    '| 页面、响应和本机日期星期一致 | 本次证据未复现差异 |',
  ].join('\n');
  const q122R71Audit = bundle.audit(q122R71ProductionDraft, q122Question, todayAtomicRoute);
  assert.ok(q122R71Audit.violations.includes('undefined_observation_variable'), '最小清单只列响应、判断表却首次使用本机日期时必须拦截');
  assert.deepEqual(q122R71Audit.undefinedObservationVariables.unboundVariables, ['local_clock']);
  assert.equal(q122R71Audit.undefinedObservationVariables.claimedMissingCount, 1);
  assert.equal(q122R71Audit.undefinedObservationVariables.actualMissingCount, 2);
  assert.equal(q122R71Audit.undefinedObservationVariables.countMismatch, true);
  assert.match(bundle.revision(q122R71ProductionDraft, q122R71Audit), /同一时刻本机日期\/星期\/时间/);
  const q122R72Fallback = bundle.fallback(q122R71ProductionDraft, q122R71Audit);
  assert.match(q122R72Fallback, /GET \/pwrsapi\/month\/view\/today 完整响应/);
  assert.match(q122R72Fallback, /同一时刻本机显示的日期和星期/);
  assert.deepEqual(bundle.audit(q122R72Fallback, q122Question, todayAtomicRoute).violations, [], '观测输入不闭合时降级稿必须同时定义响应和本机日期星期');

  const completeThreeWayDraft = [
    '结论：截图只够固定页面现象，还需补两项才能完成三边对照。',
    '最小输入：',
    '- 已有截图中的页面现象。',
    '- 需补同一次 `GET /pwrsapi/month/view/today` 完整响应。',
    '- 需补同一时刻本机显示的日期和星期。',
    '| 三边对照 | 判断 |',
    '| --- | --- |',
    '| 页面与响应一致、本机日期不同 | 只记录差异 |',
    '| 页面与响应不一致、本机日期一致 | 只记录差异 |',
  ].join('\n');
  assert.ok(!bundle.audit(completeThreeWayDraft, q122Question, todayAtomicRoute).violations.includes('undefined_observation_variable'), '三边观测量均在清单定义时放行');

  const completeTwoWayDraft = [
    '结论：截图够固定页面现象，但还需响应才能完成两边对照。',
    '最小输入：已有截图；需补 `GET /pwrsapi/month/view/today` 完整响应。',
    '| 两边对照 | 判断 |',
    '| --- | --- |',
    '| 页面与响应一致 | 记录一致 |',
    '| 页面与响应不一致 | 记录差异 |',
  ].join('\n');
  assert.ok(!bundle.audit(completeTwoWayDraft, q122Question, todayAtomicRoute).violations.includes('undefined_observation_variable'), '两边判断没有引入第三个观测量时放行');

  const userHasClockQuestion = '我只有截图，但同一时刻本机日期和星期已经记下了，没有日志；现在只缺接口响应，够不够判断？';
  const userHasClockDraft = [
    '结论：截图和已记录的本机日期只够固定两边，还需一项响应才能完成三边对照。',
    '还缺的是下面这一项：',
    '- `GET /pwrsapi/month/view/today` 的完整响应。',
    '| 三边对照 | 判断 |',
    '| --- | --- |',
    '| 页面、响应与本机日期星期一致 | 记录一致 |',
    '| 页面或响应与本机日期星期不一致 | 记录差异 |',
  ].join('\n');
  const userHasClockAudit = bundle.audit(userHasClockDraft, userHasClockQuestion, todayAtomicRoute);
  assert.ok(!userHasClockAudit.violations.includes('undefined_observation_variable'), '用户已明确记录的观测量不应在最小清单中重复索要');
  assert.deepEqual(userHasClockAudit.observationInputContract.userExistingVariables.sort(), ['local_clock', 'page'].sort());

  const q122MissingRouteDraft = '结论：这张截图只够固定页面现象，不够闭环原因。\n再看已有请求即可。';
  const q122MissingRouteAudit = bundle.audit(q122MissingRouteDraft, q122Question, todayAtomicRoute);
  assert.ok(q122MissingRouteAudit.violations.includes('missing_evidence_minimum_route_fact'), '有结论但漏current route唯一主接口仍不满足最小缺口');
  assert.equal(q122MissingRouteAudit.missingEvidenceMinimumPath.path, '/pwrsapi/month/view/today');
  assert.match(bundle.revision(q122MissingRouteDraft, q122MissingRouteAudit), /current\/inherited route 的已核主接口/);

  const fullTicketQuestion = '我要整理完整转开发提单：现在只有截图没有日志，完整材料清单还要什么？';
  const fullTicketAudit = bundle.audit('请记录页面、终端、账号角色、版本和发生时间。', fullTicketQuestion, todayAtomicRoute);
  assert.equal(fullTicketAudit.fullHandoffMaterialQuestion, true);
  assert.equal(fullTicketAudit.evidenceSufficiencyQuestion, false, '显式索要完整提单材料时允许泛清单，不强制改写为局部充分性答案');
  assert.ok(!fullTicketAudit.violations.includes('missing_evidence_sufficiency_verdict'));
  assert.ok(!fullTicketAudit.violations.includes('missing_evidence_minimum_route_fact'));

  const patientIdAtomicRoute = {
    matched: true,
    route: { title: '患者号字段类型' },
    answerFacts: ['pwrs_patient.patient_id 是 character varying(50)，不是数字类型'],
  };
  const patientIdAtomicDraft = [
    'pwrs_patient.patient_id 是 character varying(50)，不是数字类型。',
    '该字段还参与患者身份元组和缓存键。',
  ].join('\n');
  const patientIdAtomicAudit = bundle.audit(patientIdAtomicDraft, 'pwrs_patient.patient_id 在 PostgreSQL 里是什么类型和长度？', patientIdAtomicRoute);
  assert.ok(patientIdAtomicAudit.violations.includes('focused_fact_overreach'), '原子字段属性题不得追加身份元组或缓存实现');
  const patientIdAtomicFallback = bundle.fallback(patientIdAtomicDraft, patientIdAtomicAudit);
  assert.match(patientIdAtomicFallback, /patient_id 是 character varying\(50\)/);
  assert.doesNotMatch(patientIdAtomicFallback, /身份元组|缓存键/);
  assert.deepEqual(bundle.audit(patientIdAtomicFallback, 'pwrs_patient.patient_id 在 PostgreSQL 里是什么类型和长度？', patientIdAtomicRoute).violations, []);
  const siblingFieldRoute = {
    matched: true,
    route: { title: '患者号字段类型' },
    focusTechnicalTokens: ['patient_id'],
    answerFacts: ['patient_id 是 character varying(50)', 'visit_id 是另一个标识字段'],
  };
  const siblingFieldAudit = bundle.audit(
    'patient_id 是 character varying(50)，visit_id 是另一个标识字段。',
    'patient_id 这一列是什么类型？',
    siblingFieldRoute,
  );
  assert.deepEqual(siblingFieldAudit.focusedTechnicalOverreach, ['visit_id'], '真正的字段/列类型题仍须拦截 sibling token');
  assert.ok(siblingFieldAudit.violations.includes('out_of_scope_entity'));

  assert.deepEqual(bundle.audit('已核规则明确写明：缺 hospitalId 会导致请求被拒绝。', '缺 hospitalId 会怎样？', {
    matched: true,
    route: { title: '患者身份契约' },
    answerFacts: ['当前规则明确：缺 hospitalId 会导致请求被拒绝'],
  }).violations, [], '同一claim有权威确定规则时允许“会导致”');
  assert.deepEqual(bundle.audit('按当前契约传字符串不会出现少位。', '患者号字段怎么传？', route).violations, [], '否定故障句不误拦');

  const q127R28Draft = [
    'patient_id 在库里是 character varying(50)，不是数字类型。',
    '对接方把患者号当数字传/处理，长号就可能丢位或丢精度。',
    '裸数字和库侧字符串契约不一致，长号就可能在途中丢精度。',
    '报文已是字符串但值已经少位，丢位发生在对接更上游（生成号、Excel、中间系统）。',
    '报文类型核对清楚后再改对接传参方式。',
    '先只读核一次已有原始报文与医院完整患者号。',
  ].join('\n');
  const q127R28Question = '医院电话里只说“对接方把患者号当数字传，长号码开始丢位”。我应该先让他们做哪个验证？';
  const q127R28Audit = bundle.audit(q127R28Draft, q127R28Question, route);
  assert.ok(q127R28Audit.violations.includes('unsupported_likelihood'), '电话转述不构成“可能丢位/丢精度”的直接因果证据');
  assert.ok(q127R28Audit.violations.includes('cross_actor_side_effect'), '无受控条件时不得建议核对后修改传参方式');
  assert.ok(q127R28Audit.violations.includes('out_of_scope_entity'), '不得自行枚举 Excel/中间系统等未点名机制');
  assert.ok(q127R28Audit.unsupportedLikelihoodClaims.some(x => /可能丢位|可能在途中丢精度/.test(x)));
  assert.ok(q127R28Audit.unsupportedCausalLocalizationClaims.some(x => /更上游/.test(x)));
  const q127R28Fallback = bundle.fallback(q127R28Draft, q127R28Audit);
  assert.match(q127R28Fallback, /patient_id 在库里是 character varying\(50\)/);
  assert.match(q127R28Fallback, /先只读核一次已有原始报文与医院完整患者号/);
  assert.doesNotMatch(q127R28Fallback, /可能丢位|可能在途中丢精度|更上游|生成号|Excel|中间系统|改对接传参方式/);
  assert.deepEqual(bundle.audit(q127R28Fallback, q127R28Question, route).violations, []);

  assert.deepEqual(bundle.audit(
    '电话里说“对接方把患者号当数字传并开始丢位”只能作为待核线索；先只读核已有原始报文中的类型和值。',
    q127R28Question,
    route,
  ).violations, [], '明确把电话归因降为待核线索且只读核已有证据应放行');

  const focusedPatientIdRoute = {
    matched: true,
    inherited: true,
    focusTechnicalTokens: ['pwrs_patient', 'patient_id'],
    route: { title: '患者主表身份字段类型' },
    answerFacts: ['pwrs_patient 的 p_id、patient_id、visit_id、district_code 均为 character varying(50)'],
  };
  const q127R31Draft = [
    '`pwrs_patient.patient_id` 是 `character varying(50)`。',
    '同表 `p_id`、`visit_id`、`district_code` 也都是 `character varying(50)`。',
    '先只读对照已有源值与出站报文；之后决定是压对接方按字符串传。',
  ].join('\n');
  const q127R31Audit = bundle.audit(q127R31Draft, q127R28Question, focusedPatientIdRoute);
  assert.ok(q127R31Audit.violations.includes('out_of_scope_entity'), '单一字段诊断不能因宽route包含同表字段而放行 sibling token');
  assert.ok(q127R31Audit.violations.includes('cross_actor_side_effect'), '压/催/推动对接方按某类型传仍是跨主体副作用动作');
  assert.deepEqual(q127R31Audit.focusedTechnicalOverreach.sort(), ['district_code', 'p_id', 'visit_id'].sort());
  const q127R31Fallback = bundle.fallback(q127R31Draft, q127R31Audit);
  assert.match(q127R31Fallback, /pwrs_patient\.patient_id/);
  assert.doesNotMatch(q127R31Fallback, /只读对照已有源值与出站报文；$/, '删除同句后半段危险动作后，不得发布分号悬空的前半句');
  assert.doesNotMatch(q127R31Fallback, /p_id|visit_id|district_code|压对接方|按字符串传/);
  assert.deepEqual(bundle.audit(q127R31Fallback, q127R28Question, focusedPatientIdRoute).violations, []);

  for (const wording of [
    '催对接方按字符串传。',
    '推动第三方以指定格式发送。',
    '协调开发按数字类型传。',
    '交给对接方改传参/序列化口径。',
    '让第三方调整编码规则。',
    '通知开发统一协议口径。',
    '优先让对接按字符串传完整号。',
    '请接口方以文本格式发送。',
    '要求厂商按指定格式传。',
    '通知供应商修改编码口径。',
    '让院方调整字段格式。',
  ]) {
    const actionAudit = bundle.audit(wording, '患者号对不上，下一步怎么查？', focusedPatientIdRoute);
    assert.ok(actionAudit.violations.includes('cross_actor_side_effect'), wording);
  }
  const q128SideEffectDraft = 'patient_id 是 varchar(50)。\n这一段钉死后交给对接方改传参/序列化口径；先保留已有源值与出站请求的只读对照。';
  const q128SideEffectAudit = bundle.audit(q128SideEffectDraft, '患者号字段第二步对不上，后面先停还是继续？', focusedPatientIdRoute);
  assert.ok(q128SideEffectAudit.violations.includes('cross_actor_side_effect'));
  const q128SideEffectFallback = bundle.fallback(q128SideEffectDraft, q128SideEffectAudit);
  assert.match(q128SideEffectFallback, /patient_id 是 varchar\(50\)/);
  assert.match(q128SideEffectFallback, /已有源值与出站请求的只读对照/);
  assert.doesNotMatch(q128SideEffectFallback, /交给对接方改|传参\/序列化口径/);
  assert.deepEqual(bundle.audit(q128SideEffectFallback, '患者号字段第二步对不上，后面先停还是继续？', focusedPatientIdRoute).violations, []);
  for (const wording of [
    '接口失败时先修接口可用性与响应契约，再继续排查。',
    '请开发修复服务可用性后复测。',
    '字段缺失时需要调整接口响应格式。',
    '返回不符时先修改返回格式。',
  ]) {
    const actionRoute = { matched: true, route: { title: '今天视图' }, answerFacts: ['已核今天接口契约'] };
    const actionQuestion = '今天视图对不上，给我排查顺序。';
    const actionAudit = bundle.audit(wording, actionQuestion, actionRoute);
    assert.ok(actionAudit.violations.includes('cross_actor_side_effect'), wording);
    const safe = bundle.fallback(wording, actionAudit);
    assert.doesNotMatch(safe, /修接口|修复服务|调整接口|修改返回/);
    assert.deepEqual(bundle.audit(safe, actionQuestion, actionRoute).violations, []);
  }
  assert.deepEqual(bundle.audit('不要修接口契约，只读保留已有状态码和响应。', '今天视图怎么排查？', { matched: true, route: { title: '今天视图' }, answerFacts: ['已核今天接口契约'] }).violations, [], '否定修复与只读留证不应误拦');
  assert.deepEqual(bundle.audit('只读核对已有接口契约和响应原文。', '今天视图怎么排查？', { matched: true, route: { title: '今天视图' }, answerFacts: ['已核今天接口契约'] }).violations, [], '核对契约是只读动作');
  assert.deepEqual(bundle.audit('修订这份答复的措辞。', '这个说法怎么表达？', { matched: false }).violations, [], '修订文本不是业务副作用动作');
  assert.deepEqual(bundle.audit('只读核对已有序列化日志和协议字段，不修改配置。', '患者号怎么继续排查？', focusedPatientIdRoute).violations, [], '只读查看已有机制证据不得误判为修改动作');
  assert.deepEqual(bundle.audit('不要让对接按数字传；只读核对已有报文。', '患者号怎么继续排查？', focusedPatientIdRoute).violations, [], '否定动作与既有报文只读核对不得误判');
  assert.deepEqual(bundle.audit(
    '仅在隔离测试环境、专用测试数据、明确授权、回滚清理方案、幂等性与影响范围均确认后，可让接口方单次受控按指定格式发送。',
    '隔离测试环境和专用测试数据已获授权，回滚清理、幂等性、影响范围都确认了，怎么受控验证？',
    focusedPatientIdRoute,
  ).violations, [], '完整受控条件仍允许跨主体条件式验证');
  assert.deepEqual(bundle.audit('只读对照已有 patient_id 源值与出站报文。', q127R28Question, focusedPatientIdRoute).violations, [], '当前聚焦字段与只读动作应放行');
  assert.deepEqual(bundle.audit(
    '统计100份已核报文，其中80份确认数字转换后发生精度丢失。',
    '统计100份已核报文，其中80份确认数字转换后发生精度丢失，怎么描述？',
    { matched: true, route: { title: '已核报文统计' }, answerFacts: ['统计样本明确写明：100份中80份确认数字转换后发生精度丢失'] },
  ).violations, [], '直接统计与route同一claim证据仍应放行');

  const q129OrderDraft = [
    'patient_id 是 varchar(50) 字符串。',
    '| 对照结果 | 能确定到哪 | 下一步 |',
    '| --- | --- | --- |',
    '| 报文已是字符串，但与原始全号仍不一致 | 不能停在当数字传 | 说明问题可能在发出后的链路；用完整请求响应升级 |',
    '| 原始全号与报文一致，但收到值不同 | 差异首次在收到值被观察 | 只读保留三处原文 |',
  ].join('\n');
  const q129OrderAudit = bundle.audit(q129OrderDraft, '只能确认请求发出，后端具体走到哪不知道，先说能确定的部分。', route);
  assert.ok(q129OrderAudit.violations.includes('contradictory_observation_order'), 'B观测点已经与A不同，不能反向定位到B之后');
  assert.equal(q129OrderAudit.contradictoryObservationOrderClaims.length, 1);
  const q129OrderFallback = bundle.fallback(q129OrderDraft, q129OrderAudit);
  assert.match(q129OrderFallback, /patient_id 是 varchar\(50\) 字符串/);
  assert.doesNotMatch(q129OrderFallback, /报文已是字符串.*发出后的链路/);
  assert.doesNotMatch(q129OrderFallback, /原始全号与报文一致，但收到值不同/, '删掉违规行后只剩单分支时应移除整张残表');
  assert.deepEqual(bundle.audit(q129OrderFallback, '只能确认请求发出，后端具体走到哪不知道，先说能确定的部分。', route).violations, []);

  assert.deepEqual(bundle.audit(
    '报文与原始全号不一致；只能确认差异在该报文观测点已经存在、不晚于该点，具体发生层仍未知。',
    '已有报文与原始值不同，能确定什么？',
    route,
  ).violations, [], 'B已不同的安全边界表述应放行');
  assert.deepEqual(bundle.audit(
    '原始全号与出站报文一致，但收到值不同；差异边界可收敛到出站报文之后、收到值之前。',
    '已只读核对A=B且C不同，能确定什么？',
    route,
  ).violations, [], 'A=B且C不同可合法收敛到两观测点之间');
  assert.deepEqual(bundle.audit(
    '目前只确认请求发出，报文值与收到值都不可见；具体发生层仍未知。',
    '只能确认请求发出，后端具体走到哪不知道。',
    route,
  ).violations, [], '没有逐层值时保持局部未知，不应误伤');

  const q129ComparativeDraft = '请求已发出，但后端具体路径未知。若请求值与原始值一致，丢位更可能在请求之后。';
  const q129ComparativeAudit = bundle.audit(q129ComparativeDraft, '只能确认请求发出，后端具体走到哪不知道，先说能确定的部分。', route);
  assert.ok(q129ComparativeAudit.violations.includes('unsupported_likelihood'), '更可能在/从/由某位置仍是无证据比较概率和位置排序');
  const q129ComparativeFallback = bundle.fallback(q129ComparativeDraft, q129ComparativeAudit);
  assert.match(q129ComparativeFallback, /请求已发出/);
  assert.doesNotMatch(q129ComparativeFallback, /更可能在请求之后/);
  assert.deepEqual(bundle.audit(q129ComparativeFallback, '只能确认请求发出，后端具体走到哪不知道，先说能确定的部分。', route).violations, []);
  assert.deepEqual(bundle.audit(
    '已核对 A 与 B 一致、C 与 B 不同，差异边界可收敛到 B 之后、C 之前。',
    '已确认 A=B 且 C 不同，能确定什么？',
    route,
  ).violations, [], '已核有序观测点允许不带概率排序地陈述确定边界');

  const undefinedOrdinalDraft = [
    '对照三份已经存在的值：',
    '| 对照项 | 看什么 |',
    '| --- | --- |',
    '| ① 原始值 | 全文逐位 |',
    '| ② 已发请求 | 作为基准 |',
    '| ③ 同一次响应 | 与①②逐位比较 |',
    '若③/④已经变化，就把①②③（有则含④）留给开发。',
  ].join('\n');
  const undefinedOrdinalAudit = bundle.audit(undefinedOrdinalDraft, '请求侧正常，下一个检查点是什么？', route);
  assert.deepEqual(undefinedOrdinalAudit.undefinedOrdinalReferences, ['④']);
  assert.ok(undefinedOrdinalAudit.violations.includes('undefined_ordinal_reference'), '表格只定义①②③时不得在后文引用未定义④');
  assert.match(bundle.revision(undefinedOrdinalDraft, undefinedOrdinalAudit), /不得凭空补造第四项/);
  const undefinedOrdinalFallback = bundle.fallback(undefinedOrdinalDraft, undefinedOrdinalAudit);
  assert.doesNotMatch(undefinedOrdinalFallback, /③\/④|含④/);
  assert.match(undefinedOrdinalFallback, /① 原始值|② 已发请求|③ 同一次响应/);
  assert.deepEqual(bundle.audit(undefinedOrdinalFallback, '请求侧正常，下一个检查点是什么？', route).violations, []);
  const undefinedArabicDraft = [
    '先固定页面文案。',
    '再核对已有请求响应。',
    '响应和页面一致就继续第4步；不一致回到第3步。',
    '最后整理第3/4步的结论。',
  ].join('\n');
  const undefinedArabicAudit = bundle.audit(undefinedArabicDraft, '给我一个能直接照着走的排查顺序。', route);
  assert.deepEqual(undefinedArabicAudit.undefinedArabicStepReferences.map(item => item.numbers), [[4, 3], [3, 4]]);
  assert.ok(undefinedArabicAudit.violations.includes('undefined_arabic_step_reference'));
  const undefinedArabicFallback = bundle.fallback(undefinedArabicDraft, undefinedArabicAudit);
  assert.doesNotMatch(undefinedArabicFallback, /第3步|第4步|第3\/4步/);
  assert.deepEqual(bundle.audit(undefinedArabicFallback, '给我一个能直接照着走的排查顺序。', route).violations, []);
  assert.deepEqual(bundle.audit(
    '1. 固定页面文案。\n2. 核已有请求。\n3. 对照响应。\n4. 整理结论。\n完成第3/4步后再汇总。',
    '给我一个能直接照着走的排查顺序。',
    route,
  ).violations, [], '答案已定义连续步骤时允许后文引用第3/4步');
  const selfReferenceDraft = [
    '1. 固定页面与已有请求。',
    '2. 做两层只读对照。',
    '3. 按第3步结果往下收口。',
    '页面=响应时保留已有原文。',
    '4. 整理脱敏证据。',
  ].join('\n');
  const selfReferenceAudit = bundle.audit(selfReferenceDraft, '给我一个能直接照着走的排查顺序。', route);
  assert.ok(selfReferenceAudit.violations.includes('self_referential_step_reference'));
  assert.deepEqual(selfReferenceAudit.selfReferentialStepReferences.map(item => item.line), ['3. 按第3步结果往下收口。']);
  assert.match(bundle.revision(selfReferenceDraft, selfReferenceAudit), /自引用没有可执行含义/);
  const selfReferenceFallback = bundle.fallback(selfReferenceDraft, selfReferenceAudit);
  assert.doesNotMatch(selfReferenceFallback, /按第3步结果/);
  const selfReferenceSecondAudit = bundle.audit(selfReferenceFallback, '给我一个能直接照着走的排查顺序。', route);
  assert.ok(!selfReferenceSecondAudit.violations.includes('nonsequential_top_level_steps'), '删除自引用标题后应在同一fallback内重排剩余已有步骤');
  assert.match(selfReferenceFallback, /3\. 整理脱敏证据/);
  assert.deepEqual(selfReferenceSecondAudit.violations, []);
  assert.deepEqual(bundle.audit('1. 固定现象。\n2. 根据第1步原文核对已有响应。', '给我排查顺序。', route).violations, [], '引用前一步是正常流程');
  assert.deepEqual(bundle.audit('第3步：整理已有请求。', '我已做到第2步，接下来呢？', route).violations, [], '“第N步：动作”是合法定义而不是自引用');
  assert.deepEqual(bundle.audit('做到第2步后先停。', '我已经做到第2步，下一步先停还是继续？', route).violations, [], '用户本轮明确的第N步可作为外部引用，不要求答案重新定义');
  assert.deepEqual(bundle.audit(
    '分三类：①已核事实；②本轮观察；③待验证分支。后文只对照①②③。',
    '怎么组织排查结论？',
    route,
  ).violations, [], '冒号/分号内联定义与后文合法引用不得误伤');
  assert.deepEqual(bundle.audit(
    '| 对照项 | 值 |\n| --- | --- |\n| ① 请求 | 已发出 |\n| ② 响应 | 已收到 |\n结论按①②对照。',
    '请求响应都抓到了，怎么核？',
    route,
  ).violations, [], '表格定义的序号可在正文合法复用');

  const skippedTopLevelStepDraft = [
    '1. 核请求路径',
    '只读查看已有请求。',
    '2. 核响应字段',
    '只读比较已有响应。',
    '3. 对照页面',
    '逐字比较页面与响应。',
    '5. 整理材料',
    '保留已有截图和响应。',
  ].join('\n');
  const skippedTopLevelStepAudit = bundle.audit(skippedTopLevelStepDraft, '请求和响应都抓到了，重点核哪几处？', route);
  assert.ok(skippedTopLevelStepAudit.violations.includes('nonsequential_top_level_steps'), '顶层步骤1、2、3后直接跳5必须命中');
  assert.deepEqual(skippedTopLevelStepAudit.nonSequentialTopLevelSteps.map(item => [item.expected, item.number]), [[4, 5]]);
  assert.match(bundle.revision(skippedTopLevelStepDraft, skippedTopLevelStepAudit), /不得为补缺号新增步骤/);
  const skippedTopLevelStepFallback = bundle.fallback(skippedTopLevelStepDraft, skippedTopLevelStepAudit);
  assert.match(skippedTopLevelStepFallback, /^4\. 整理材料$/m);
  assert.doesNotMatch(skippedTopLevelStepFallback, /^5\. 整理材料$/m);
  assert.deepEqual(bundle.audit(skippedTopLevelStepFallback, '请求和响应都抓到了，重点核哪几处？', route).violations, []);
  assert.deepEqual(bundle.audit('2. 继续核响应\n只读比较。\n3. 整理已有证据\n不执行写操作。', '已经做到第二步，后面怎么查？', route).violations, [], '承接现场既有第二步时允许从2开始但后续仍须连续');
  const ungroundedStartDraft = '3. 固定截图内容\n只读抄录页面原文。\n4. 核已有响应\n比较 year/week。\n5. 整理材料\n保留脱敏截图。';
  const ungroundedStartAudit = bundle.audit(ungroundedStartDraft, '我只有截图，没有日志，最少还要补什么？', route);
  assert.ok(ungroundedStartAudit.violations.includes('nonsequential_top_level_steps'), '用户未明示既有步骤时，新清单不得从3开始');
  assert.deepEqual(ungroundedStartAudit.nonSequentialTopLevelSteps.map(item => [item.expected, item.number]), [[1, 3], [2, 4], [3, 5]]);
  const ungroundedStartFallback = bundle.fallback(ungroundedStartDraft, ungroundedStartAudit);
  assert.match(ungroundedStartFallback, /^1\. 固定截图内容$/m);
  assert.doesNotMatch(ungroundedStartFallback, /核已有响应/, '步骤唯一正文被其它作用域审计删除后，空标题也须在最终重审中删除');
  assert.match(ungroundedStartFallback, /^2\. 整理材料$/m);
  assert.deepEqual(bundle.audit(ungroundedStartFallback, '我只有截图，没有日志，最少还要补什么？', route).violations, []);
  assert.ok(bundle.audit('3. 只读核已有响应', '下一步先做什么？', route).violations.includes('nonsequential_top_level_steps'), '单个顶层步骤也须从本轮合法起点开始');
  assert.deepEqual(bundle.audit('3. 继续核已有响应。', '已经做到第二步，接下来呢？', route).violations, [], '用户明确做到第二步时可从第三步承接，完整句步骤无需额外正文');
  assert.deepEqual(bundle.audit('1. 顶层步骤\n    7. 嵌套原始编号\n2. 下一顶层步骤\n只读整理已有内容。', '怎么核对？', route).violations, [], '四空格嵌套编号不参与顶层连续性审计且可作为父步骤正文');
  assert.deepEqual(bundle.audit('1. 顶层步骤\n```text\n9. 文件中的原文编号\n```\n2. 下一顶层步骤\n只读整理已有内容。', '怎么核对？', route).violations, [], '代码围栏里的编号不参与顶层连续性审计且可作为父步骤正文');

  const incompleteThreeWayDraft = [
    '先做这一个验证：拿一条已有记录做三边原文对照。',
    '| 对照点 | 看什么 |',
    '| --- | --- |',
    '| 收进来/页面上看到的 | 已有回执里的原文 |',
    '**2. 核报文格式**',
    '在已抓到的报文里看字段，例如：',
    '**3. 决定下一步**',
    '再把结论转给对接方。',
  ].join('\n');
  const incompleteThreeWayAudit = bundle.audit(
    incompleteThreeWayDraft,
    '我应该先让他们做哪个验证？',
    route,
  );
  assert.ok(incompleteThreeWayAudit.violations.includes('inconsistent_structured_cardinality'), '声明三边时按行列项的表格不能只有一条数据');
  assert.deepEqual(incompleteThreeWayAudit.cardinalityMismatches.map(item => [item.expected, item.actual]), [[3, 1]]);
  assert.ok(incompleteThreeWayAudit.violations.includes('incomplete_structured_lead_in'), '例如：后直接进入新步骤属于空引导句');
  assert.ok(incompleteThreeWayAudit.violations.includes('single_step_diagnostic_overreach'), '只问先做哪个验证时不得展开多个顶层步骤');
  assert.match(bundle.revision(incompleteThreeWayDraft, incompleteThreeWayAudit), /禁止为了凑数新增字段/);
  assert.match(bundle.revision(incompleteThreeWayDraft, incompleteThreeWayAudit), /不得把一个问题扩成完整排查流程/);
  const incompleteThreeWayFallback = bundle.fallback(incompleteThreeWayDraft, incompleteThreeWayAudit);
  assert.doesNotMatch(incompleteThreeWayFallback, /三边|收进来\/页面上看到的|例如：|\*\*2\.|\*\*3\./);
  assert.deepEqual(bundle.audit(incompleteThreeWayFallback, '我应该先让他们做哪个验证？', route).violations, []);

  assert.deepEqual(bundle.audit([
    '对照三份已有值：',
    '| 对照项 | 原文 |',
    '| --- | --- |',
    '| 来源记录 | 已留存值 |',
    '| 已有请求 | 已发送值 |',
    '| 已有响应 | 已返回值 |',
    '只比较三份原文，不执行写操作。',
  ].join('\n'), '已有证据怎么做三份对照？', route).violations, [], '声明三份且表格确有三项时不得误伤');
  assert.deepEqual(bundle.audit([
    '三边横向对照：',
    '| 来源记录 | 已有请求 | 已有响应 |',
    '| --- | --- | --- |',
    '| 原文A | 原文A | 原文A |',
  ].join('\n'), '已有证据怎么对照？', route).violations, [], '横向三列表不按数据行数误判');
  assert.deepEqual(bundle.audit('重点看：\n- 已有请求原文\n- 已有响应原文', '下一步看什么？', route).violations, [], '冒号后有真实列表内容时不得误判为空引导');
  const emptyTrailingHeadingDraft = 'patient_id 是 character varying(50)。\n特别注意（别搞混）：';
  const emptyTrailingHeadingAudit = bundle.audit(emptyTrailingHeadingDraft, 'patient_id是什么类型和长度？', route);
  assert.ok(emptyTrailingHeadingAudit.violations.includes('incomplete_structured_lead_in'), '文末任意冒号标题没有子内容必须命中');
  assert.deepEqual(emptyTrailingHeadingAudit.incompleteLeadIns.map(item => item.line), ['特别注意（别搞混）：']);
  assert.match(bundle.revision(emptyTrailingHeadingDraft, emptyTrailingHeadingAudit), /文末以冒号结尾/);
  const emptyTrailingHeadingFallback = bundle.fallback(emptyTrailingHeadingDraft, emptyTrailingHeadingAudit);
  assert.doesNotMatch(emptyTrailingHeadingFallback, /特别注意/);
  assert.match(emptyTrailingHeadingFallback, /patient_id 是 character varying\(50\)/);
  assert.deepEqual(bundle.audit(emptyTrailingHeadingFallback, 'patient_id是什么类型和长度？', route).violations, []);
  assert.deepEqual(bundle.audit('特别注意：\n不要把 patient_id 当成 bigint。', 'patient_id是什么类型？', route).violations, [], '冒号标题后有真实内容时不得误伤');
  const emptyInlineContractLead = [
    '工作台今天日期和星期调用 GET /pwrsapi/month/view/today（需合法 JWT）。',
    '响应是 Map<String,String>，包含：',
    '**别搞混**：这不是已删除的 GET /month/view。',
  ].join('\n');
  const emptyInlineContractAudit = bundle.audit(emptyInlineContractLead, '工作台今天日期和星期调用哪个接口？', {
    matched: true,
    route: { title: '工作台今天视图' },
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week'],
    mustNotConfuse: ['不得答已废止的 GET /month/view'],
  });
  assert.ok(emptyInlineContractAudit.violations.includes('incomplete_structured_lead_in'), '“包含：”后直接进入别搞混小节属于空引导句');
  const emptyInlineContractFallback = bundle.fallback(emptyInlineContractLead, emptyInlineContractAudit);
  assert.doesNotMatch(emptyInlineContractFallback, /Map<String,String>|包含：/);
  assert.match(emptyInlineContractFallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.match(emptyInlineContractFallback, /GET \/month\/view/);
  assert.deepEqual(bundle.audit(emptyInlineContractFallback, '工作台今天日期和星期调用哪个接口？', {
    matched: true,
    route: { title: '工作台今天视图' },
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week'],
    mustNotConfuse: ['不得答已废止的 GET /month/view'],
  }).violations, []);
  const q120R75ProductionDraft = [
    '当前接口：GET /pwrsapi/month/view/today。',
    '返回是 Map<String,String>，里面有：别和已删除的 GET /month/view 月历网格接口搞混。',
    '工作台通过需合法 JWT 的 GET /pwrsapi/month/view/today 获取当前日期与星期。',
  ].join('\n');
  const q120R75ProductionAudit = bundle.audit(q120R75ProductionDraft, todayStatementQuestion, todayAtomicRoute);
  assert.ok(q120R75ProductionAudit.violations.includes('incomplete_structured_lead_in'), '同一paragraph内“里面有：”后直接转防混淆也必须判空');
  assert.ok(q120R75ProductionAudit.incompleteLeadIns.some(item => item.inlineClause && /Map<String,String>.*里面有：/u.test(item.inlineClause)), '段内空引导须精确记录可删clause');
  const q120R76Fallback = bundle.fallback(q120R75ProductionDraft, q120R75ProductionAudit);
  assert.equal((q120R76Fallback.match(/GET \/pwrsapi\/month\/view\/today/g) || []).length, 1, '原子接口fallback最终只保留一次method+path');
  assert.match(q120R76Fallback, /需合法 JWT/);
  assert.match(q120R76Fallback, /GET \/month\/view/);
  assert.doesNotMatch(q120R76Fallback, /Map<String,String>|里面有：/);
  assert.deepEqual(bundle.audit(q120R76Fallback, todayStatementQuestion, todayAtomicRoute).violations, [], '段内空引导清理与原子接口去重后的终稿须自审全绿');
  assert.ok(!bundle.audit('返回包含：year、week。', '这个响应包含哪些字段？', todayAtomicRoute).violations.includes('incomplete_structured_lead_in'), '冒号后有合法内联字段枚举时放行');
  assert.ok(bundle.audit('响应内容为：**注意**：不要混淆其它接口。', '这个响应是什么？', todayAtomicRoute).violations.includes('incomplete_structured_lead_in'), 'Markdown inline强调的新语义分句不能冒充引导内容');
  assert.deepEqual(bundle.audit('**1. 只读核对**\n比较已有请求与已有响应原文。', '第一步先做什么？', route).violations, [], '单步问题只给一个顶层步骤时应放行');

  const twoSourcesOneRowDraft = [
    '并排只读对照两份原文：',
    '| 对照边 | 记什么 |',
    '| --- | --- |',
    '| 医院原始患者号 | 完整原文 |',
    '同一笔样例只核两件事：',
    '- 报文里字段是字符串还是数字',
  ].join('\n');
  const twoSourcesOneRowAudit = bundle.audit(twoSourcesOneRowDraft, '我应该先让他们做哪个验证？', route);
  assert.equal(twoSourcesOneRowAudit.cardinalityMismatches.length, 2, '表格两份仅一行、清单两件仅一项都必须命中');
  assert.deepEqual(twoSourcesOneRowAudit.cardinalityMismatches.map(item => [item.kind, item.expected, item.actual]), [['table', 2, 1], ['list', 2, 1]]);
  assert.ok(twoSourcesOneRowAudit.violations.includes('inconsistent_structured_cardinality'));
  const twoSourcesOneRowFallback = bundle.fallback(twoSourcesOneRowDraft, twoSourcesOneRowAudit);
  assert.doesNotMatch(twoSourcesOneRowFallback, /两份原文|对照边|两件事|字符串还是数字/);
  assert.deepEqual(bundle.audit(twoSourcesOneRowFallback, '我应该先让他们做哪个验证？', route).violations, []);
  assert.deepEqual(bundle.audit([
    '只核两件事：',
    '- 已有报文里的字段类型',
    '- 已有报文里的字段原文',
  ].join('\n'), '已有报文先核什么？', route).violations, [], '声明两件且清单确有两项时不得误伤');
  assert.deepEqual(bundle.audit('现场已有两条历史记录，可以只读比较。', '现有证据是什么？', route).violations, [], '普通数量陈述没有冒号引导结构时不得误伤');
  const driftingCountDraft = [
    '**你现在最少再确认 1 件事（只读）**',
    '请直接回复这两点中你已看到的结果：',
    '- 第二步具体差在哪',
    '- 医院原始现象是哪类',
  ].join('\n');
  const driftingCountAudit = bundle.audit(driftingCountDraft, '第二步对不上，后面停还是继续？', route);
  assert.ok(driftingCountAudit.violations.includes('conflicting_count_declaration'), '同一局部一件事漂成两点必须命中');
  assert.deepEqual(driftingCountAudit.conflictingCountDeclarations.map(item => [item.firstCount, item.secondCount]), [[1, 2]]);
  assert.match(bundle.revision(driftingCountDraft, driftingCountAudit), /统一为实际已有清单项数/);
  const driftingCountFallback = bundle.fallback(driftingCountDraft, driftingCountAudit);
  assert.doesNotMatch(driftingCountFallback, /1 件事|两点/);
  assert.match(driftingCountFallback, /第二步具体差在哪/);
  assert.deepEqual(bundle.audit(driftingCountFallback, '第二步对不上，后面停还是继续？', route).violations, []);
  assert.deepEqual(bundle.audit('只确认一件事：已有两条历史记录是否一致。', '先确认什么？', route).violations, [], '普通事实数量没有第二个结构动作声明时不得误伤');
  assert.deepEqual(bundle.audit('请回复两点：\n- 页面值\n- 响应值', '还缺什么？', route).violations, [], '单一数量声明不得误伤');

  const q125R78ProductionDraft = [
    '第二步已经对不上时，先停。',
    '**请你只回这 4 行（有就抄，没有写「没有」）**',
    '- 同一条结果是否还有 content：有/没有/没权限看',
    '你回这4行后，我再帮你判断。',
  ].join('\n');
  const q125R79Audit = bundle.audit(q125R78ProductionDraft, '第二步对不上，后面先停还是继续？', route);
  assert.ok(q125R79Audit.violations.includes('inconsistent_structured_cardinality'), '声明回复4行但紧随清单只剩1行必须命中');
  assert.deepEqual(q125R79Audit.cardinalityMismatches.filter(item => item.kind === 'requested-list').map(item => [item.expected, item.actual, item.unit]), [[4, 1, '行']]);
  const q125R79Fallback = bundle.fallback(q125R78ProductionDraft, q125R79Audit);
  assert.match(q125R79Fallback, /第二步已经对不上时，先停/);
  assert.doesNotMatch(q125R79Fallback, /4\s*行|content|你回这4行后/);
  assert.deepEqual(bundle.audit(q125R79Fallback, '第二步对不上，后面先停还是继续？', route).violations, [], '数量失配降级稿不得残留声明、残项或后续数量引用');
  assert.deepEqual(bundle.audit([
    '请你只回这4行：',
    '- 页面已有值',
    '- 已有请求原文',
    '- 已有响应原文',
    '- 同刻本机值',
  ].join('\n'), '还缺什么？', route).violations, [], '声明4行且紧随清单确有4行时放行');
  assert.deepEqual(bundle.audit([
    '这个数据表有4列：',
    '| 页面值 | 请求值 | 响应值 | 本机值 |',
    '| --- | --- | --- | --- |',
    '| 1 | 1 | 1 | 1 |',
  ].join('\n'), '现有表格是什么？', route).violations, [], '普通数据表4列不是回复格式请求，不得误触发数量门');
  assert.deepEqual(bundle.audit('用户说已有4行数据，可以只读核对。', '现有证据是什么？', route).violations, [], '用户陈述已有4行数据不是结构请求');
  const requestedColumnsAudit = bundle.audit([
    '请提供4列：',
    '| 页面值 | 请求值 | 响应值 |',
    '| --- | --- | --- |',
    '| 1 | 1 | 1 |',
  ].join('\n'), '请按什么格式补充？', route);
  assert.deepEqual(requestedColumnsAudit.cardinalityMismatches.filter(item => item.kind === 'requested-table').map(item => [item.expected, item.actual, item.unit]), [[4, 3, '列']], '明确请求4列但表格只有3列必须命中');

  const postCleanupCountDraft = [
    '先保留已有请求原文。',
    '请只回这4行：',
    '- 已有页面现象',
    '- 让运维重跑任务',
    '- 让对接方改参数后复测',
    '- 让开发修改配置',
    '你回这4行后再判断。',
  ].join('\n');
  const postCleanupCountAudit = bundle.audit(postCleanupCountDraft, '现有证据怎么核对？', route);
  assert.ok(postCleanupCountAudit.violations.includes('cross_actor_side_effect'));
  assert.equal(postCleanupCountAudit.cardinalityMismatches.filter(item => item.kind === 'requested-list').length, 0, '清理前4行完整时不得提前误报');
  const postCleanupCountFallback = bundle.fallback(postCleanupCountDraft, postCleanupCountAudit);
  assert.match(postCleanupCountFallback, /先保留已有请求原文/);
  assert.doesNotMatch(postCleanupCountFallback, /请只回这4行|已有页面现象|运维重跑|对接方改参数|开发修改配置|你回这4行后/);
  assert.deepEqual(bundle.audit(postCleanupCountFallback, '现有证据怎么核对？', route).violations, [], '危险项清理后须再次核数量并删除新形成的不自洽回复块');

  const orphanedAlternativeDraft = [
    '写清「第二步对不上」的原文现象',
    '',
    '还是页面上有字段标题但无选项。',
    '记下模板和已有字段标识。',
  ].join('\n');
  const orphanedAlternativeAudit = bundle.audit(orphanedAlternativeDraft, '第二步对不上，先停还是继续？', route);
  assert.ok(orphanedAlternativeAudit.violations.includes('orphaned_alternative_fragment'), '前项已丢失时不得发布孤立“还是…”后半分支');
  assert.deepEqual(orphanedAlternativeAudit.orphanedAlternativeLines.map(item => item.line), ['还是页面上有字段标题但无选项。']);
  assert.match(bundle.revision(orphanedAlternativeDraft, orphanedAlternativeAudit), /不得猜测或补造被删掉的前项/);
  const orphanedAlternativeFallback = bundle.fallback(orphanedAlternativeDraft, orphanedAlternativeAudit);
  assert.doesNotMatch(orphanedAlternativeFallback, /还是页面上有字段标题/);
  assert.match(orphanedAlternativeFallback, /记下模板和已有字段标识/);
  assert.deepEqual(bundle.audit(orphanedAlternativeFallback, '第二步对不上，先停还是继续？', route).violations, []);

  const danglingAlternativeDraft = [
    '对照既有报文，患者号在入参里是：',
    '带引号的字符串（例如 "1234567890123456789"），还是',
    '只抄字段名和完整原文，不要重发。',
  ].join('\n');
  const danglingAlternativeAudit = bundle.audit(danglingAlternativeDraft, '患者号先做哪个验证？', route);
  assert.ok(danglingAlternativeAudit.violations.includes('dangling_alternative_fragment'), '后一项被删后句尾悬空“还是”必须命中');
  assert.deepEqual(danglingAlternativeAudit.danglingAlternativeLines.map(item => item.line), ['带引号的字符串（例如 "1234567890123456789"），还是']);
  assert.match(bundle.revision(danglingAlternativeDraft, danglingAlternativeAudit), /悬空前半分支/);
  const danglingAlternativeFallback = bundle.fallback(danglingAlternativeDraft, danglingAlternativeAudit);
  assert.doesNotMatch(danglingAlternativeFallback, /，还是\s*$/mu);
  assert.match(danglingAlternativeFallback, /只抄字段名和完整原文/);
  assert.deepEqual(bundle.audit(danglingAlternativeFallback, '患者号先做哪个验证？', route).violations, []);
  assert.ok(!bundle.audit('报文里的患者号是带引号字符串，还是裸数字？', '患者号先做哪个验证？', route).violations.includes('dangling_alternative_fragment'), '完整二选一问句不得误伤');
  assert.ok(!bundle.audit('结果是字符串或裸数字。', '报文里的形态是什么？', route).violations.includes('dangling_alternative_fragment'), '句中合法“或”不得误伤');
  assert.deepEqual(bundle.audit('是接口返回不同，还是页面显示不同？', '这两种情况怎么分？', route).violations, [], '完整二选一问句不得误伤');
  assert.deepEqual(bundle.audit('先停还是继续\n还是先停，不要继续。', '第二步断了怎么处理？', route).violations, [], '还是先停式直接结论不得误伤');
  assert.deepEqual(bundle.audit('两种分支：\n或者接口没有返回，先只读留证。', '还有什么分支？', route).violations, [], '明确冒号引出的或者分支不得误伤');
  const orphanedContrastDraft = '**结论：**\n但够继续只读排查，也不必先等日志。';
  const orphanedContrastAudit = bundle.audit(orphanedContrastDraft, '只有截图够不够？', route);
  assert.ok(orphanedContrastAudit.violations.includes('orphaned_contrast_fragment'), '纯标题后直接出现但字残句必须命中');
  assert.deepEqual(orphanedContrastAudit.orphanedContrastLines.map(item => item.line), ['但够继续只读排查，也不必先等日志。']);
  assert.match(bundle.revision(orphanedContrastDraft, orphanedContrastAudit), /不得猜造被删前提/);
  const orphanedContrastFallback = bundle.fallback(orphanedContrastDraft, orphanedContrastAudit);
  assert.doesNotMatch(orphanedContrastFallback, /但够继续/);
  assert.deepEqual(bundle.audit(orphanedContrastFallback, '只有截图够不够？', route).violations, []);

  const orphanedQuoteDraft = [
    '对外表述应限定在本批样本：',
    '',
    '」',
    '',
    '仍不能点名具体组件。',
  ].join('\n');
  const orphanedQuoteAudit = bundle.audit(orphanedQuoteDraft, '100个样本中80个在序列化前丢位，怎么表述？', route);
  assert.ok(orphanedQuoteAudit.violations.includes('malformed_markdown'), '示例正文被删后单独残留右引号必须拦截');
  assert.ok(orphanedQuoteAudit.malformedMarkdown.includes('unbalanced_cjk_corner_quote'));
  assert.ok(orphanedQuoteAudit.malformedMarkdown.includes('orphaned_quote_line'));
  assert.match(bundle.revision(orphanedQuoteDraft, orphanedQuoteAudit), /单独一行的孤立引号/);
  const orphanedQuoteFallback = bundle.fallback(orphanedQuoteDraft, orphanedQuoteAudit);
  assert.doesNotMatch(orphanedQuoteFallback, /^[\s>*_`#\-+]*[「」『』“”‘’]+[\s。！？；：,.!?;:]*$/mu);
  assert.match(orphanedQuoteFallback, /仍不能点名具体组件/);
  assert.deepEqual(bundle.audit(orphanedQuoteFallback, '100个样本中80个在序列化前丢位，怎么表述？', route).violations, []);
  assert.deepEqual(bundle.audit('对外可写：「本批100个样本中80个在序列化前已丢位。」', '100个样本中80个在序列化前丢位，怎么表述？', route).violations, [], '同一自然句内闭合的合法引用不得误伤');
  assert.deepEqual(bundle.audit('原文如下：\n「本批100个样本中80个在序列化前已丢位。」', '100个样本中80个在序列化前丢位，怎么表述？', route).violations, [], '跨行但成对闭合的合法引用不得误伤');
  assert.deepEqual(bundle.audit('单张截图不够结案。\n但够继续只读排查。', '只有截图够不够？', route).violations, [], '已有完整前句时转折不得误拦');

  const incompletePairedDraft = [
    '**再对照：接口返回和浏览器本机是否一致**',
    '- **一致：** 本机和服务端对今天理解相同。',
    '- 判断重点：差是否卡在日期交界。',
    '',
    '**整理最小留证**',
    '- 页面截图',
  ].join('\n');
  const incompletePairedAudit = bundle.audit(incompletePairedDraft, '今天视图和浏览器不一致，给我排查顺序。', route);
  assert.ok(incompletePairedAudit.violations.includes('incomplete_paired_branch'), '明确对照结构只剩一致分支必须命中');
  assert.deepEqual(incompletePairedAudit.incompletePairedBranches.map(item => item.missing), [['不一致']]);
  assert.match(bundle.revision(incompletePairedDraft, incompletePairedAudit), /不得凭空补造缺失分支/);
  const incompletePairedFallback = bundle.fallback(incompletePairedDraft, incompletePairedAudit);
  assert.doesNotMatch(incompletePairedFallback, /再对照|一致：|判断重点/);
  assert.match(incompletePairedFallback, /整理最小留证/);
  assert.deepEqual(bundle.audit(incompletePairedFallback, '今天视图和浏览器不一致，给我排查顺序。', route).violations, []);
  assert.deepEqual(bundle.audit([
    '**比较页面与响应：**',
    '- **一致：** 页面展示了本次响应。',
    '- **不一致：** 页面呈现链路待验证。',
  ].join('\n'), '今天视图和浏览器不一致，给我排查顺序。', route).violations, [], '成对标签齐全时不得误拦');
  assert.deepEqual(bundle.audit('配置一致：无需继续处理。', '配置状态是什么？', route).violations, [], '没有结构引导的单一直接结论不得误拦');

  const contradictoryNegativeDraft = [
    '**不要做的：**',
    '把截图上的日期和本机值直接回我，我可以帮你判断。',
  ].join('\n');
  const contradictoryNegativeAudit = bundle.audit(contradictoryNegativeDraft, '只有截图够不够？', route);
  assert.ok(contradictoryNegativeAudit.violations.includes('contradictory_negative_section'), '否定标题下只剩正向建议必须命中');
  assert.match(bundle.revision(contradictoryNegativeDraft, contradictoryNegativeAudit), /不得保留“不要做”标题加正向建议/);
  const contradictoryNegativeFallback = bundle.fallback(contradictoryNegativeDraft, contradictoryNegativeAudit);
  assert.doesNotMatch(contradictoryNegativeFallback, /不要做|直接回我|帮你判断/);
  assert.deepEqual(bundle.audit(contradictoryNegativeFallback, '只有截图够不够？', route).violations, []);
  assert.deepEqual(bundle.audit([
    '**不要做的：**',
    '- 不要直接改服务器时区。',
    '- 禁止重复提交。',
  ].join('\n'), '现场排查不要做什么？', route).violations, [], '否定标题下明确否定项不得误拦');
  assert.deepEqual(bundle.audit([
    '**不要做的：**',
    '- 修改生产配置',
    '- 重复提交',
  ].join('\n'), '现场排查不要做什么？', route).violations, [], '否定标题自然管辖的裸禁止项不得误拦');
  assert.deepEqual(bundle.audit('**下一步：**\n- 可以只读核已有响应。', '现场下一步做什么？', route).violations, [], '正向标题下的安全建议不得误拦');

  const explicitLayerRuleRoute = {
    matched: true,
    route: { title: '字段转换契约' },
    answerFacts: ['源码已确认：若出站报文前的类型转换失败，错误发生在序列化环节'],
  };
  assert.deepEqual(bundle.audit('若已核类型转换失败条件成立，错误发生在序列化环节。', '按已核转换规则怎么判？', explicitLayerRuleRoute).violations, [], 'route 逐层契约直接支持时允许确定定位');

  const todayDraft = '今天视图由已核接口返回。页面日期可能是旧缓存或异常兜底。页面与接口不同，更像前端展示/取错字段。JVM 时区错了，由运维按规范改服务端时区（不在实施侧乱改前端）。';
  const todayAudit = bundle.audit(todayDraft, '今天视图和浏览器不一致，怎么处理？', { matched: true, route: { title: '工作台今天视图' }, answerFacts: ['日期来自服务端 JVM 当前时区'] });
  assert.deepEqual(todayAudit.violations, ['unsupported_likelihood', 'unsupported_component_fault', 'cross_actor_side_effect', 'out_of_scope_entity']);
  const todayFallback = bundle.fallback(todayDraft, todayAudit);
  assert.match(todayFallback, /今天视图由已核接口返回/);
  assert.doesNotMatch(todayFallback, /可能是|更像|由运维.*改/);
  assert.deepEqual(bundle.audit(todayFallback, '今天视图和浏览器不一致，怎么处理？', { matched: true, route: { title: '工作台今天视图' }, answerFacts: ['日期来自服务端 JVM 当前时区'] }).violations, []);

  const malformed = '只有截图不够。**\n请只读核已有响应。';
  const malformedAudit = bundle.audit(malformed, '只有截图够不够？', route);
  assert.deepEqual(malformedAudit.violations, ['malformed_markdown']);
  const normalized = bundle.fallback(malformed, malformedAudit);
  assert.equal(normalized, '只有截图不够。\n请只读核已有响应。');
  assert.deepEqual(bundle.audit(normalized, '只有截图够不够？', route).violations, []);

  const formRoute = { matched: true, route: { title: '自定义表单关联' }, answerFacts: ['form_id 关联模板和结果，element_id 关联字段与选项，content 保存结果快照'] };
  const atomicRelationshipQuestion = '自定义表单、字段、选项和填写结果靠什么关联？';
  const atomicRelationshipDraft = [
    '模板和填写结果靠 form_id 关联。',
    '字段和选项靠 element_id 关联。',
    '删除模板会物理级联删除字段和选项。',
    '历史结果不会清理，form_id 可能悬空。',
    '渲染历史结果主要读取 content 快照。',
    '一句话串起来：模板 form_id → 字段和结果；字段 element_id → 选项。',
  ].join('\n');
  const atomicRelationshipAudit = bundle.audit(atomicRelationshipDraft, atomicRelationshipQuestion, formRoute);
  assert.ok(atomicRelationshipAudit.violations.includes('focused_fact_overreach'), '原子关系题不得顺带扩写删除级联、历史和渲染行为');
  assert.ok(atomicRelationshipAudit.violations.includes('focused_fact_incomplete'), '用户点名填写结果时不得漏掉 route 已核的 content 表示边');
  assert.equal(atomicRelationshipAudit.focusedFactOverreach.length, 3);
  assert.deepEqual(atomicRelationshipAudit.missingFocusedRelationshipFacts.map(item => item.missingTokens), [['content']]);
  const atomicRelationshipFallback = bundle.fallback(atomicRelationshipDraft, atomicRelationshipAudit);
  assert.match(atomicRelationshipFallback, /form_id 关联/);
  assert.match(atomicRelationshipFallback, /element_id 关联/);
  assert.match(atomicRelationshipFallback, /form_id →/);
  assert.match(atomicRelationshipFallback, /content 保存结果快照/);
  assert.doesNotMatch(atomicRelationshipFallback, /删除|级联|历史结果|悬空|渲染/);
  assert.deepEqual(bundle.audit(atomicRelationshipFallback, atomicRelationshipQuestion, formRoute).violations, []);
  assert.deepEqual(bundle.audit(
    '模板和填写结果靠 form_id 关联。\n字段和选项靠 element_id 关联。\ncontent 保存结果快照。',
    atomicRelationshipQuestion,
    formRoute,
  ).violations, [], '点名结果对象时，三条 current route 直接边齐全即可止答');

  const strictFormRoute = {
    matched: true,
    route: { title: '自定义表单结构与结果关联' },
    answerFacts: ['三段关系必须分别回答：pwrs_custom_form.form_id → pwrs_custom_form_element.form_id 与 pwrs_custom_form_result.form_id；pwrs_custom_form_element.element_id → option/table.element_id；pwrs_custom_form_result.content → 填写内容 JSON'],
    mustNotConfuse: ['不得漏掉 result.form_id；不得说 form_id 直接关联选项或表格列；不得把共享业务键描述成真库外键'],
    directEvidenceFacts: ['pwrs_custom_form_result.content 存 elementList 整体 JSON 快照，即整份填写内容。'],
  };
  const q124R73ProductionDraft = [
    '### 表单模板 ↔ 字段 / 填写结果',
    '字段表 pwrs_custom_form_element 用同一 form_id 挂到模板。',
    '字段用 element_id 关联选项和表格列。',
    '填写结果的 result.content 保存整份填写内容 JSON 快照。',
  ].join('\n');
  const q124R73Audit = bundle.audit(q124R73ProductionDraft, atomicRelationshipQuestion, strictFormRoute);
  assert.ok(q124R73Audit.violations.includes('focused_fact_incomplete'), 'heading中的填写结果不能与另一句form_id跨句拼成关系边');
  assert.deepEqual(q124R73Audit.missingFocusedRelationshipFacts.map(item => item.kind), ['relationship_edge', 'relationship_boundary']);
  assert.match(q124R73Audit.missingFocusedRelationshipFacts[0].clause, /pwrs_custom_form\.form_id → pwrs_custom_form_result\.form_id/);
  assert.match(q124R73Audit.missingFocusedRelationshipFacts[1].clause, /共享业务键.*真库外键/);
  const q124R74Fallback = bundle.fallback(q124R73ProductionDraft, q124R73Audit);
  assert.match(q124R74Fallback, /pwrs_custom_form\.form_id → pwrs_custom_form_result\.form_id/);
  assert.match(q124R74Fallback, /共享业务键.*真库外键/);
  assert.doesNotMatch(q124R74Fallback, /级联|删除模板|历史结果|渲染/);
  assert.deepEqual(bundle.audit(q124R74Fallback, atomicRelationshipQuestion, strictFormRoute).violations, [], 'fallback逐条恢复缺失direct edge和直接反事实边界后必须自审通过');

  const multiTargetPartial = [
    '模板通过 form_id 关联字段。',
    '字段通过 element_id 关联选项和表格列。',
    '填写结果的 result.content 保存整份填写内容 JSON 快照。',
    '共享业务键不是真库外键。',
  ].join('\n');
  const multiTargetAudit = bundle.audit(multiTargetPartial, atomicRelationshipQuestion, strictFormRoute);
  assert.equal(multiTargetAudit.missingFocusedRelationshipFacts.filter(item => item.kind === 'relationship_edge').length, 1, '同一form_id连接多个target时每条target edge必须分别成句');
  assert.match(multiTargetAudit.missingFocusedRelationshipFacts.find(item => item.kind === 'relationship_edge').clause, /form_result/);

  const strictFormTableAnswer = [
    '| 来源 | 业务键 | 目标 |',
    '| --- | --- | --- |',
    '| 模板 | form_id 关联 | 字段 |',
    '| 模板 | form_id 关联 | 填写结果 |',
    '| 字段 | element_id 关联 | 选项和表格列 |',
    '| 填写结果 | result.content 保存 | 整份填写内容 JSON 快照 |',
    '',
    '这些只是共享业务键，不是真库外键。',
  ].join('\n');
  assert.deepEqual(bundle.audit(strictFormTableAnswer, atomicRelationshipQuestion, strictFormRoute).violations, [], '同一表格行完整绑定source-key-target时应放行');

  const adjacentClaimsDoNotJoin = [
    '### 模板 / 填写结果',
    '模板的 form_id 已确认。',
    '填写结果页面可以看到。',
    '字段通过 element_id 关联选项和表格列。',
    '填写结果的 result.content 保存整份填写内容 JSON 快照。',
    '共享业务键不是真库外键。',
  ].join('\n');
  assert.ok(bundle.audit(adjacentClaimsDoNotJoin, atomicRelationshipQuestion, strictFormRoute).missingFocusedRelationshipFacts.some(item => /form_result/.test(item.clause)), '相邻句分别出现source/key/target不能冒充同一关系claim');

  const q124R79ProductionDraft = [
    '结论：靠三段业务关联键串起模板、字段、选项和填写结果。',
    '### 表单模板 ↔ 字段、填写结果',
    '用 form_id：',
    '用 element_id：',
    'pwrs_custom_form_element.element_id → 选项表/表格列表的 element_id。',
    '这些是共享业务键，不是真库外键。',
    'pwrs_custom_form_result.content → 填写内容 JSON。',
  ].join('\n');
  const q124R80Audit = bundle.audit(q124R79ProductionDraft, atomicRelationshipQuestion, strictFormRoute);
  assert.ok(q124R80Audit.violations.includes('incomplete_structured_lead_in'), '“用 form_id/element_id：”后无内容属于key-specific空引导');
  assert.ok(q124R80Audit.violations.includes('focused_fact_incomplete'), '空引导和局部箭头不能替代缺失direct edge与表示限定');
  assert.deepEqual(q124R80Audit.incompleteLeadIns.map(item => item.line), ['用 form_id：', '用 element_id：']);
  const q124R80Fallback = bundle.fallback(q124R79ProductionDraft, q124R80Audit);
  assert.match(q124R80Fallback, /pwrs_custom_form\.form_id → pwrs_custom_form_element\.form_id/);
  assert.match(q124R80Fallback, /pwrs_custom_form\.form_id → pwrs_custom_form_result\.form_id/);
  assert.match(q124R80Fallback, /pwrs_custom_form_element\.element_id → option\.element_id/);
  assert.match(q124R80Fallback, /pwrs_custom_form_element\.element_id → table\.element_id/);
  assert.match(q124R80Fallback, /pwrs_custom_form_result\.content → 整份填写内容 JSON 快照/);
  assert.match(q124R80Fallback, /共享业务键.*真库外键/);
  assert.doesNotMatch(q124R80Fallback, /用 (?:form_id|element_id)：/);
  assert.deepEqual(bundle.audit(q124R80Fallback, atomicRelationshipQuestion, strictFormRoute).violations, [], '关系原子题最终恢复稿必须逐edge与边界自审全绿');
  assert.ok(bundle.audit('通过 `form_id`：', atomicRelationshipQuestion, strictFormRoute).violations.includes('incomplete_structured_lead_in'), 'Markdown code key空引导也必须命中');
  assert.ok(!bundle.audit('用 form_id：模板和字段通过 form_id 关联。', atomicRelationshipQuestion, strictFormRoute).violations.includes('incomplete_structured_lead_in'), 'key-specific引导后有同段正文时不得误报空引导');

  const relationshipCleanupChainDraft = [
    'pwrs_custom_form.form_id → pwrs_custom_form_element.form_id，让运维重跑任务。',
    'pwrs_custom_form.form_id → pwrs_custom_form_result.form_id，让对接方改参数后复测。',
    'pwrs_custom_form_element.element_id → option.element_id，让开发重试。',
    'pwrs_custom_form_element.element_id → table.element_id，让运维补跑。',
    'pwrs_custom_form_result.content → 整份填写内容 JSON 快照，让对接方修改配置。',
    '共享业务键不是真库外键。',
  ].join('\n');
  const relationshipCleanupChainAudit = bundle.audit(relationshipCleanupChainDraft, atomicRelationshipQuestion, strictFormRoute);
  assert.ok(relationshipCleanupChainAudit.violations.includes('cross_actor_side_effect'));
  assert.deepEqual(relationshipCleanupChainAudit.missingFocusedRelationshipFacts, [], '清理前每条direct edge均已出现时首审应视为完整');
  const relationshipCleanupChainFallback = bundle.fallback(relationshipCleanupChainDraft, relationshipCleanupChainAudit);
  assert.doesNotMatch(relationshipCleanupChainFallback, /运维|对接方|开发|重跑|复测|补跑|修改配置/);
  assert.match(relationshipCleanupChainFallback, /pwrs_custom_form\.form_id → pwrs_custom_form_element\.form_id/);
  assert.match(relationshipCleanupChainFallback, /pwrs_custom_form_result\.content → 整份填写内容 JSON 快照/);
  assert.deepEqual(bundle.audit(relationshipCleanupChainFallback, atomicRelationshipQuestion, strictFormRoute).violations, [], '其它安全门删掉原本完整edge后，final pass必须从current route全部恢复且不再破坏');

  assert.ok(!bundle.audit(
    '删除模板后，已核规则要求只读核对历史结果是否仍可见。',
    '删除模板后历史结果怎么处理？',
    formRoute,
  ).violations.includes('focused_fact_overreach'), '用户明确问删除后的历史行为时不触发原子关系止答');
  const cleanupResidualDraft = [
    '第二步只读核对 form_id 和 element_id 的已有关系。',
    '列表/统计挂主表的可能空。',
    '第二步对不上就先停，修/核结构，别先查结果。',
    '只读核结构关系，不保存、不删除。',
  ].join('\n');
  const cleanupResidualAudit = bundle.audit(cleanupResidualDraft, '自定义表单第二步对不上，后面先停还是继续？', formRoute);
  assert.ok(cleanupResidualAudit.violations.includes('malformed_markdown'), '字段清理后“的可能空”属于缺少中心语的残句');
  assert.ok(cleanupResidualAudit.violations.includes('cross_actor_side_effect'), '“修/核结构”中的修结构仍是副作用动作，不能与只读核对混写');
  const cleanupResidualFallback = bundle.fallback(cleanupResidualDraft, cleanupResidualAudit);
  assert.match(cleanupResidualFallback, /只读核对 form_id 和 element_id/);
  assert.match(cleanupResidualFallback, /只读核结构关系/);
  assert.doesNotMatch(cleanupResidualFallback, /的可能空|修\/核结构/);
  assert.deepEqual(bundle.audit(cleanupResidualFallback, '自定义表单第二步对不上，后面先停还是继续？', formRoute).violations, []);
  assert.deepEqual(bundle.audit('字段的值可能为空，先只读核已有记录。', '表单字段怎么排查？', formRoute).violations, [], '有明确中心语“值”的条件分支不应被句法门误判');

  const atomicRoute = {
    matched: true,
    route: { title: '工作台今天视图' },
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week，日期来自服务端 JVM 当前时区'],
    mustNotConfuse: ['不得答已废止的 GET /month/view'],
  };
  const atomicDraft = [
    '调用 GET /pwrsapi/month/view/today，返回 year/week。',
    '不得混淆已废止的 GET /month/view。',
    '现场怎么快速核对：打开工作台，在 Network 里查看请求。',
    '如果接口没调到，页面就会异常——优先查 token。',
    '需要更细的话，把截图发来再一起看。',
  ].join('\n');
  const atomicAudit = bundle.audit(atomicDraft, '工作台今天日期和星期调用哪个接口？', atomicRoute);
  assert.deepEqual(atomicAudit.violations, ['unsupported_likelihood', 'focused_fact_overreach']);
  assert.match(bundle.revision(atomicDraft, atomicAudit), /保留 current route answerFacts\/primary section 的直接答案/);
  const atomicFallback = bundle.fallback(atomicDraft, atomicAudit);
  assert.match(atomicFallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.match(atomicFallback, /GET \/month\/view/);
  assert.doesNotMatch(atomicFallback, /现场怎么|打开工作台|优先查|截图发来|再一起看/);
  assert.deepEqual(bundle.audit(atomicFallback, '工作台今天日期和星期调用哪个接口？', atomicRoute).violations, []);

  const patientFieldRoute = {
    matched: true,
    route: { title: '患者号字段类型' },
    answerFacts: ['pwrs_patient.patient_id 在 PostgreSQL 中为 character varying(50)'],
  };
  const patientFieldDraft = [
    '`pwrs_patient.patient_id` 是 `character varying(50)`。',
    '数值传输很容易丢精度。',
  ].join('\n');
  const patientFieldAudit = bundle.audit(patientFieldDraft, 'pwrs_patient.patient_id 在 PostgreSQL 里是什么类型和长度？', patientFieldRoute);
  assert.deepEqual(patientFieldAudit.violations, ['unsupported_likelihood', 'focused_fact_overreach']);
  assert.equal(patientFieldAudit.focusedFactQuestion, true);
  const patientFieldFallback = bundle.fallback(patientFieldDraft, patientFieldAudit);
  assert.equal(patientFieldFallback, '`pwrs_patient.patient_id` 是 `character varying(50)`。', '原子事实题降级后不得附加概率/动作审计尾注');
  assert.doesNotMatch(patientFieldFallback, /当前证据不支持|待验证分支|完整受控条件|只核已有/);
  assert.deepEqual(bundle.audit(patientFieldFallback, 'pwrs_patient.patient_id 在 PostgreSQL 里是什么类型和长度？', patientFieldRoute).violations, []);

  const diagnosticAudit = bundle.audit(patientFieldDraft, '患者号传输对不上，现场怎么排查？', patientFieldRoute);
  const diagnosticFallback = bundle.fallback(patientFieldDraft, diagnosticAudit);
  assert.match(diagnosticFallback, /当前证据不支持对原因作频率排序/, '诊断题仍保留面向用户的必要安全边界');

  const tableDraft = [
    '| 对照结果 | 已核边界 | 只读下一步 |',
    '| --- | --- | --- |',
    '| 接口与页面相同；浏览器不同 | 日期来自服务端 JVM 时区 | 保留状态码与响应；交联调 |',
    '让运维修改服务端时区。',
  ].join('\n');
  const tableAudit = bundle.audit(tableDraft, '今天视图和浏览器不一致，怎么排查？', atomicRoute);
  assert.deepEqual(tableAudit.violations, ['cross_actor_side_effect', 'incomplete_result_branch_set']);
  const tableFallback = bundle.fallback(tableDraft, tableAudit);
  assert.doesNotMatch(tableFallback, /接口与页面相同；浏览器不同/, '单行诊断分类表应整体删除，不留下唯一分支误导实施');
  assert.doesNotMatch(tableFallback, /让运维修改/);
  assert.deepEqual(bundle.audit(tableFallback, '今天视图和浏览器不一致，怎么排查？', atomicRoute).violations, [], '表格行内分号不得被降级拆成孤立单元格');

  const sparseTable = '| 对照结果 | 已核边界 | 只读下一步 |\n| --- | --- | --- |\n| 把状态码与响应留给联调 | | |';
  const sparseAudit = bundle.audit(sparseTable, '今天视图怎么排查？', atomicRoute);
  assert.deepEqual(sparseAudit.violations, ['incomplete_result_branch_set', 'malformed_markdown']);
  const sparseFallback = bundle.fallback(sparseTable, sparseAudit);
  assert.doesNotMatch(sparseFallback, /\|/);
  assert.deepEqual(bundle.audit(sparseFallback, '今天视图怎么排查？', atomicRoute).violations, []);

  const oneBranchDraft = [
    '只读三方对照，按结果分支判断（不改配置）',
    '| 对照结果 | 怎么理解 | 下一步 |',
    '| --- | --- | --- |',
    '| 接口失败或缺字段 | 只能确认当前响应异常 | 保留已有原文 |',
    '后续整理脱敏证据。',
  ].join('\n');
  const oneBranchAudit = bundle.audit(oneBranchDraft, '今天视图和浏览器不一致，怎么排查？', atomicRoute);
  assert.ok(oneBranchAudit.violations.includes('incomplete_result_branch_set'), '声称按结果分支时不得只剩一条表格分支');
  assert.equal(oneBranchAudit.incompleteResultBranchTables[0].actual, 1);
  assert.match(bundle.revision(oneBranchDraft, oneBranchAudit), /分支”至少需要两个/);
  const oneBranchFallback = bundle.fallback(oneBranchDraft, oneBranchAudit);
  assert.doesNotMatch(oneBranchFallback, /按结果分支判断|接口失败或缺字段/);
  assert.match(oneBranchFallback, /后续整理脱敏证据/);
  assert.deepEqual(bundle.audit(oneBranchFallback, '今天视图和浏览器不一致，怎么排查？', atomicRoute).violations, []);
  const completeBranchTable = [
    '按已核结果分支判断：',
    '| 对照结果 | 只读下一步 |',
    '| --- | --- |',
    '| 页面=响应 | 保留已有页面与响应 |',
    '| 页面≠响应 | 保留已有差异原文 |',
  ].join('\n');
  assert.deepEqual(bundle.audit(completeBranchTable, '已经对照请求和页面，怎么判断？', atomicRoute).violations, [], '至少两条完整分支表格放行');

  const missingTwoButOneRow = [
    '至少还要两样东西：',
    '| 已有 | 还缺（不用日志） |',
    '| --- | --- |',
    '| 页面截图 | ① 本机日期、星期、时区 |',
    '日志不是第一步必需品。',
  ].join('\n');
  const missingTwoAudit = bundle.audit(missingTwoButOneRow, '只有截图没有日志，够不够？', atomicRoute);
  assert.ok(missingTwoAudit.violations.includes('inconsistent_structured_cardinality'), '“还缺”清单的两样东西不能用两列表头充当两项');
  assert.equal(missingTwoAudit.cardinalityMismatches[0].actual, 1);
  const missingTwoFallback = bundle.fallback(missingTwoButOneRow, missingTwoAudit);
  assert.doesNotMatch(missingTwoFallback, /还缺两样|账号角色|版本/);
  assert.match(missingTwoFallback, /结论：这张截图只够固定当前页面现象/);
  assert.match(missingTwoFallback, /同一时刻本机显示的日期和星期/);
  assert.match(missingTwoFallback, /不必先拿服务器日志/);
  const missingTwoRows = [
    '至少还要两样东西：',
    '| 已有 | 还缺 |',
    '| --- | --- |',
    '| 页面截图 | 本机日期、星期、时区 |',
    '| 页面截图 | 已有请求的状态码与响应 |',
  ].join('\n');
  assert.ok(!bundle.audit(missingTwoRows, '只有截图没有日志，够不够？', atomicRoute).violations.includes('inconsistent_structured_cardinality'), '两条明确待补项应满足声明');
  const missingTwoInOneCell = [
    '至少还要两样东西：',
    '| 已有 | 还缺 |',
    '| --- | --- |',
    '| 页面截图 | ① 本机日期；② 已有请求响应 |',
  ].join('\n');
  assert.ok(!bundle.audit(missingTwoInOneCell, '只有截图没有日志，够不够？', atomicRoute).violations.includes('inconsistent_structured_cardinality'), '同一单元格清楚列出①②也可满足声明');
  const ordinaryTwoSideTable = [
    '做两边对照：',
    '| 页面 | 接口 |',
    '| --- | --- |',
    '| 已有文案 | 已有响应 |',
  ].join('\n');
  assert.ok(!bundle.audit(ordinaryTwoSideTable, '页面和接口怎么对照？', atomicRoute).violations.includes('inconsistent_structured_cardinality'), '普通横向两边表仍按两列满足声明');
  const emptyBranchHeading = [
    '### A = B，但 B ≠ C',
    '保留已有三边原文。',
    '### 接口失败 / 无字段',
    '### 仍卡住时的最小留证包',
    '保留时间与脱敏截图。',
  ].join('\n');
  const emptyBranchAudit = bundle.audit(emptyBranchHeading, '今天视图三边怎么判断？', atomicRoute);
  assert.ok(emptyBranchAudit.violations.includes('empty_diagnostic_branch'), '分支标题后直接进入下一节属于空诊断分支');
  const emptyBranchFallback = bundle.fallback(emptyBranchHeading, emptyBranchAudit);
  assert.doesNotMatch(emptyBranchFallback, /接口失败 \/ 无字段/);
  assert.match(emptyBranchFallback, /仍卡住时的最小留证包/);
  assert.ok(!bundle.audit(emptyBranchFallback, '今天视图三边怎么判断？', atomicRoute).violations.includes('empty_diagnostic_branch'));
  const completeBranchHeading = [
    '### 接口失败 / 无字段',
    '只读保留已有状态码和响应原文后升级开发。',
    '### 仍卡住时的最小留证包',
    '保留时间与脱敏截图。',
  ].join('\n');
  assert.ok(!bundle.audit(completeBranchHeading, '今天视图三边怎么判断？', atomicRoute).violations.includes('empty_diagnostic_branch'), '分支标题有正文时放行');

  const r68EmptyStepDraft = [
    '1. **只读核对已有请求**',
    '比较已有响应和页面。',
    '2. **仍对不上时，最少留证再转人（只整理已有证据，别补写操作）**',
    '---',
    '先确认是不是 **接口返回什么页面就显示什么**；',
    '当前证据不支持对原因作频率排序。',
  ].join('\n');
  const r68EmptyStepAudit = bundle.audit(r68EmptyStepDraft, '今天视图不一致，给我排查顺序。', atomicRoute);
  assert.ok(r68EmptyStepAudit.violations.includes('empty_list_step_item'), '生产原答的粗体步骤标题后直接分隔线必须判空');
  assert.ok(r68EmptyStepAudit.violations.includes('dangling_closing_punctuation'), '生产原答的分号收口后直接安全尾注必须判悬空');
  assert.deepEqual(r68EmptyStepAudit.emptyListStepItems.map(item => item.line), [
    '2. **仍对不上时，最少留证再转人（只整理已有证据，别补写操作）**',
  ]);
  assert.deepEqual(r68EmptyStepAudit.danglingClosingPunctuationLines.map(item => item.line), [
    '先确认是不是 **接口返回什么页面就显示什么**；',
  ]);
  const r68Revision = bundle.revision(r68EmptyStepDraft, r68EmptyStepAudit);
  assert.match(r68Revision, /只有粗体标题、没有正文或子项/);
  assert.match(r68Revision, /以逗号、分号或冒号收尾却没有后半句/);
  const r68EmptyStepFallback = bundle.fallback(r68EmptyStepDraft, r68EmptyStepAudit);
  assert.match(r68EmptyStepFallback, /1\. \*\*只读核对已有请求\*\*/);
  assert.match(r68EmptyStepFallback, /比较已有响应和页面/);
  assert.doesNotMatch(r68EmptyStepFallback, /仍对不上时，最少留证再转人|接口返回什么页面就显示什么/);
  assert.match(r68EmptyStepFallback, /当前证据不支持对原因作频率排序/);
  assert.ok(!bundle.audit(r68EmptyStepFallback, '今天视图不一致，给我排查顺序。', atomicRoute).violations.includes('empty_list_step_item'));
  assert.ok(!bundle.audit(r68EmptyStepFallback, '今天视图不一致，给我排查顺序。', atomicRoute).violations.includes('dangling_closing_punctuation'));

  const completeListBodies = [
    '1. **仍对不上时，整理已有证据**',
    '保留已有请求响应和截图。',
    '- **只读核对**',
    '  - 已有请求',
    '  - 已有响应',
    '- **结论完整。**',
    '---',
  ].join('\n');
  assert.ok(!bundle.audit(completeListBodies, '今天视图怎么排查？', atomicRoute).violations.includes('empty_list_step_item'), '列表标题有正文、子项或本身是完整句时放行');
  const completePunctuation = [
    '先核已有请求；再核已有响应。',
    '- 核已有请求；',
    '- 核已有响应。',
    '结论：',
    '- 页面与响应一致。',
    '先确认是不是页面和响应一致；',
    '然后只读比较已有页面。',
  ].join('\n');
  assert.ok(!bundle.audit(completePunctuation, '今天视图怎么排查？', atomicRoute).violations.includes('dangling_closing_punctuation'), '句内分号、引出列表和紧邻正文不属于悬空收口');

  const r69EmptyNumberedDraft = [
    '1. 先把三边现象记下来（同一时刻）',
    '---',
    '2. 抓已经发生的请求',
    '---',
    '---',
    '4. 排除仍未确认的实现原因',
    '只读保留已有页面、请求和响应原文。',
  ].join('\n');
  const r69EmptyNumberedAudit = bundle.audit(r69EmptyNumberedDraft, '今天视图不一致，给我排查顺序。', atomicRoute);
  assert.ok(r69EmptyNumberedAudit.violations.includes('empty_numbered_section'), '生产DOM中普通编号标题后只有分隔线必须判空');
  assert.ok(r69EmptyNumberedAudit.violations.includes('nonsequential_top_level_steps'), '生产DOM缺第3步且跳到第4步必须同时判编号不连续');
  assert.deepEqual(r69EmptyNumberedAudit.emptyNumberedSections.map(item => item.line), [
    '1. 先把三边现象记下来（同一时刻）',
    '2. 抓已经发生的请求',
  ]);
  assert.deepEqual(r69EmptyNumberedAudit.nonSequentialTopLevelSteps.map(item => [item.expected, item.number]), [[3, 4]]);
  assert.match(bundle.revision(r69EmptyNumberedDraft, r69EmptyNumberedAudit), /只有编号步骤标题、没有任何正文\/表格\/列表\/代码块/);
  const r69EmptyNumberedFallback = bundle.fallback(r69EmptyNumberedDraft, r69EmptyNumberedAudit);
  assert.doesNotMatch(r69EmptyNumberedFallback, /先把三边现象记下来|抓已经发生的请求/);
  assert.match(r69EmptyNumberedFallback, /^1\. 排除仍未确认的实现原因$/m, '删除空步骤后剩余已有步骤直接重排为连续编号');
  assert.doesNotMatch(r69EmptyNumberedFallback, /^4\./m);
  assert.deepEqual(bundle.audit(r69EmptyNumberedFallback, '今天视图不一致，给我排查顺序。', atomicRoute).violations, []);

  const completeNumberedSections = [
    '### 1. 固定当前观察',
    '只读记录页面文案。',
    '**2. 核已有响应**',
    '| 项 | 原文 |',
    '| --- | --- |',
    '| 响应 | 已保存 |',
    '3. 整理材料',
    '- 已有页面',
    '- 已有响应',
    '4. 保留代码样例',
    '```text',
    'existing response',
    '```',
  ].join('\n');
  assert.ok(!bundle.audit(completeNumberedSections, '今天视图怎么排查？', atomicRoute).violations.includes('empty_numbered_section'), '普通/粗体/heading步骤分别有正文、表格、列表或代码块时放行');
  const nestedNumberedSections = [
    '1. 固定当前观察',
    '    1.1 只读抄录页面原文',
    '2. 整理已有材料',
    '保留脱敏截图。',
  ].join('\n');
  assert.ok(!bundle.audit(nestedNumberedSections, '今天视图怎么排查？', atomicRoute).violations.includes('empty_numbered_section'), '四空格嵌套步骤属于父步骤正文，不误判为空或顶层步骤');

  const oneDecisionRowWithoutBranchLead = [
    '怎么判断：',
    '| 对照 | 含义 | 还要不要日志 |',
    '| --- | --- | --- |',
    '| 页面=接口但不等于本机 | 只确认服务端与本机观察不同 | 暂不需要 |',
    '继续保留已有截图。',
  ].join('\n');
  const oneDecisionRowAudit = bundle.audit(oneDecisionRowWithoutBranchLead, '只有截图没有日志，够不够，怎么判断？', atomicRoute);
  assert.ok(oneDecisionRowAudit.violations.includes('incomplete_result_branch_set'), '“怎么判断”或分类表头也不能放行仅一行的残缺诊断分支');
  assert.equal(oneDecisionRowAudit.incompleteResultBranchTables[0].actual, 1);
  const oneDecisionRowFallback = bundle.fallback(oneDecisionRowWithoutBranchLead, oneDecisionRowAudit);
  assert.doesNotMatch(oneDecisionRowFallback, /怎么判断|页面=接口但不等于本机/);
  assert.match(oneDecisionRowFallback, /^结论：这张截图只够固定当前页面现象/);
  assert.match(oneDecisionRowFallback, /GET \/pwrsapi\/month\/view\/today 完整响应/);
  assert.deepEqual(bundle.audit(oneDecisionRowFallback, '只有截图没有日志，够不够，怎么判断？', atomicRoute).violations, []);
  const oneRowFactTable = [
    '| 字段 | 类型 |',
    '| --- | --- |',
    '| patient_id | character varying(50) |',
  ].join('\n');
  assert.ok(!bundle.audit(oneRowFactTable, 'patient_id 是什么类型和长度？', atomicRoute).violations.includes('incomplete_result_branch_set'), '普通单事实表不是诊断分支表');

  const brokenProse = '核对请求方法。是否不该有多余业务参数（这条接口不依赖患者入参；';
  const brokenAudit = bundle.audit(brokenProse, '今天视图请求和响应抓到了，重点核什么？', {
    matched: true,
    route: { title: '工作台今天视图' },
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week'],
  });
  assert.ok(brokenAudit.violations.includes('out_of_scope_entity'), '未点名患者实体不得混入今天视图');
  assert.ok(brokenAudit.violations.includes('missing_primary_path'), '讨论请求核对时须保留唯一已核主接口');
  assert.ok(brokenAudit.violations.includes('malformed_markdown'), '中英文括号不闭合也属于最终稿完整性错误');
  const brokenFallback = bundle.fallback(brokenProse, brokenAudit);
  assert.doesNotMatch(brokenFallback, /患者入参|（|；$/);
  assert.match(brokenFallback, /GET \/pwrsapi\/month\/view\/today/);
  assert.deepEqual(bundle.audit(brokenFallback, '今天视图请求和响应抓到了，重点核什么？', {
    matched: true,
    route: { title: '工作台今天视图' },
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week'],
  }).violations, []);
});

test('两轮草稿清理仍失败时，优先发布重审通过的确定性安全诊断终稿', () => {
  const directRecover = new Function(
    'consultAnswerSemanticAudit',
    'consultAnswerSafeFallback',
    extractFn(SRC, 'consultRecoverSafeDiagnostic') + '\nreturn consultRecoverSafeDiagnostic;',
  )(
    answer => ({ violations: answer.includes('危险') ? ['cross_actor_side_effect'] : [] }),
    () => '已核事实。\n1. 只读核对已有请求与响应。',
  );
  assert.deepEqual(directRecover({ safeDiagnosticFallback: '已核事实。\n1. 只读核对已有请求与响应。' }, '怎么排查？', { matched: true }), {
    reply: '已核事实。\n1. 只读核对已有请求与响应。',
    audit: { violations: [] },
    passes: 0,
  });
  const staleChainRecover = new Function(
    'consultAnswerSemanticAudit',
    'consultAnswerSafeFallback',
    extractFn(SRC, 'consultRecoverSafeDiagnostic') + '\nreturn consultRecoverSafeDiagnostic;',
  )(
    () => ({ audienceMode: 'implementation', chainRequested: true, missingChainDimensions: ['接口', '外部依赖'], violations: ['incomplete_requested_chain'] }),
    answer => answer,
  );
  const staleChainRecovered = staleChainRecover({ safeDiagnosticFallback: '已核事实。\n1. 只读核对已有请求与响应。' }, '换成实施只读清单。', { matched: true });
  assert.equal(staleChainRecovered.reply, '已核事实。\n1. 只读核对已有请求与响应。');
  assert.deepEqual(staleChainRecovered.audit.violations, [], '发布口须清除 implementation 当前轮被历史 route 污染的陈旧链路维度');
  assert.equal(staleChainRecovered.audit.chainRequested, false);
  const developerChainRecover = new Function(
    'consultAnswerSemanticAudit',
    'consultAnswerSafeFallback',
    extractFn(SRC, 'consultRecoverSafeDiagnostic') + '\nreturn consultRecoverSafeDiagnostic;',
  )(
    () => ({ audienceMode: 'developer', chainRequested: true, missingChainDimensions: ['接口'], violations: ['incomplete_requested_chain'] }),
    answer => answer,
  );
  assert.equal(developerChainRecover({ safeDiagnosticFallback: '只读清单。' }, '把接口链路串起来。', { matched: true }), null, '当前轮显式研发链路仍须完整，不得被防御性恢复放松');
  const cleanedRecover = new Function(
    'consultAnswerSemanticAudit',
    'consultAnswerSafeFallback',
    extractFn(SRC, 'consultRecoverSafeDiagnostic') + '\nreturn consultRecoverSafeDiagnostic;',
  )(
    answer => ({ violations: answer.includes('危险') ? ['cross_actor_side_effect'] : [] }),
    () => '已核事实。\n1. 只读核对已有证据。',
  );
  const recovered = cleanedRecover({ safeDiagnosticFallback: '危险动作。' }, '怎么排查？', { matched: true });
  assert.equal(recovered.reply, '已核事实。\n1. 只读核对已有证据。');
  assert.equal(recovered.passes, 1);
  assert.deepEqual(recovered.audit.violations, []);
  assert.equal(directRecover({ safeDiagnosticFallback: '' }, '怎么排查？', { matched: true }), null, '非诊断题没有确定性模板时保持原机械拒答边界');
  assert.equal((SRC.match(/consultRecoverSafeDiagnostic\(initialAudit, qtext, route\)/g) || []).length, 2, '正常生成异常与中止分支都应接入最后安全恢复');
  assert.match(SRC, /initialChainRequested:\s*!!initialAudit\.chainRequested/);
  assert.match(SRC, /finalMissingChainDimensions:\s*finalAudit\.missingChainDimensions/);
});

test('发布前确定性语义校验：路径必须来自用户或route并逐字保留', () => {
  const likelihoodConst = SRC.match(/const CONSULT_LIKELIHOOD_WORD_RE = [^;]+;/)?.[0] || '';
  const causalLocalizationConst = SRC.match(/const CONSULT_CAUSAL_LOCALIZATION_RE = [^;]+;/)?.[0] || '';
  const deterministicFailureConst = SRC.match(/const CONSULT_DETERMINISTIC_FAILURE_RE = [^;]+;/)?.[0] || '';
  const observationOrderConst = SRC.match(/const CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE = [^;]+;/)?.[0] || '';
  const priorityConst = SRC.match(/const CONSULT_CAUSAL_PRIORITY_RE = [^;]+;/)?.[0] || '';
  const directActionConst = SRC.match(/const CONSULT_DIRECT_RISKY_ACTION_RE = [^;]+;/)?.[0] || '';
  const componentFaultConst = SRC.match(/const CONSULT_COMPONENT_FAULT_RE = [^;]+;/)?.[0] || '';
  const bundle = new Function(
    likelihoodConst + '\n' + causalLocalizationConst + '\n' + deterministicFailureConst + '\n' + observationOrderConst + '\n' + priorityConst + '\n' + directActionConst + '\n' + componentFaultConst + '\n'
    + extractFn(SRC, 'consultHasLikelihoodEvidence') + '\n'
    + extractFn(SRC, 'consultRouteScopeText') + '\n'
    + extractFn(SRC, 'consultHasCausalPriorityEvidence') + '\n'
    + extractFn(SRC, 'consultUnsupportedComponentClaims') + '\n'
    + extractFn(SRC, 'consultHasControlledActionBundle') + '\n'
    + extractFn(SRC, 'consultConcretePaths') + '\n'
    + extractFn(SRC, 'consultScopeEntityTerms') + '\n'
    + extractFn(SRC, 'consultDiagnosticMechanismTerms') + '\n'
    + extractFn(SRC, 'consultScopeTechnicalTokens') + '\n'
    + extractFn(SRC, 'consultMalformedMarkdownTokens') + '\n'
    + extractFn(SRC, 'consultMalformedProseTokens') + '\n'
    + extractFn(SRC, 'consultMarkdownTableCells') + '\n'
    + extractFn(SRC, 'consultMalformedTableTokens') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeTables') + '\n'
    + extractFn(SRC, 'consultRequiredPrimaryPath') + '\n'
    + extractFn(SRC, 'consultFocusedFactGuard') + '\n'
    + extractFn(SRC, 'consultFocusedFactOverreach') + '\n'
    + extractFn(SRC, 'consultFocusedRelationshipFacts') + '\n'
    + extractFn(SRC, 'consultExplicitOperationContracts') + '\n'
    + extractFn(SRC, 'consultOperationEvidenceStopReply') + '\n'
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + extractFn(SRC, 'consultAnswerRevisionPrompt') + '\n'
    + extractFn(SRC, 'consultReplaceUnexpectedPath') + '\n'
    + extractFn(SRC, 'consultDeduplicateFocusedAtomicAnswer') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeMarkdown') + '\n'
    + extractFn(SRC, 'consultAnswerSafeFallback') + '\n'
    + 'return { audit:consultAnswerSemanticAudit, revision:consultAnswerRevisionPrompt, fallback:consultAnswerSafeFallback };',
  )();
  const route = {
    matched: true,
    route: { title: '工作台今天视图' },
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week'],
    mustNotConfuse: ['不得答已废止的 GET /month/view'],
  };
  assert.deepEqual(bundle.audit('调用 GET /pwrsapi/month/view/today；不要混淆 GET /month/view。', '今天视图接口是什么？', route).violations, []);
  const missingPrimary = bundle.audit('核对 path、方法、HTTP 状态和响应字段。', '今天请求响应抓到了，重点核什么？', route);
  assert.deepEqual(missingPrimary.violations, ['missing_primary_path']);
  assert.equal(missingPrimary.missingPrimaryPath.display, 'GET /pwrsapi/month/view/today');
  const requiredFallback = bundle.fallback('核对 path、方法、HTTP 状态和响应字段。', missingPrimary);
  assert.match(requiredFallback, /当前请求应逐字核对已核主接口：`GET \/pwrsapi\/month\/view\/today`/);
  assert.deepEqual(bundle.audit(requiredFallback, '今天请求响应抓到了，重点核什么？', route).violations, []);
  const multipleRoute = { matched: true, route: { title: '多接口只读核对' }, answerFacts: ['GET /api/a 读取列表', 'GET /api/b 读取详情'] };
  assert.deepEqual(bundle.audit('核对当前请求的状态和响应。', '这个请求响应重点核什么？', multipleRoute).violations, [], '多个合法接口时不得强塞任意一个');
  const wildcardRoute = { matched: true, route: { title: '外部调度入口组' }, answerFacts: ['外部调度调用 /comm/* 入口组'] };
  const wildcardAudit = bundle.audit('核对当前请求的状态和响应。', '关于这次请求和响应，重点核对什么？', wildcardRoute);
  assert.deepEqual(wildcardAudit.violations, [], '路径族/通配前缀不是一次请求的唯一精确主接口，不得强塞');
  assert.doesNotMatch(bundle.fallback('核对当前请求的状态和响应。', wildcardAudit), /\/comm\/\*/);
  for (const bad of [
    '调用 GET /month/view/today。',
    '过滤关键字 month/view/today。',
    '路径含 month/view/today，别看 month/view。',
    '也可以简称 pwrsapi/month/view/today。',
    '抓包筛选 …/month/view/today。',
    '升级材料不要写 GET .../month/view/today。',
    '也不要写 GET .. /month/view/today。',
    '也可以看 /pwrsapi/month/view/today/。',
  ]) {
    const audit = bundle.audit(bad, '今天视图接口是什么？', route);
    assert.ok(audit.violations.includes('unexpected_concrete_path'), bad);
    assert.ok(audit.unexpectedPaths.length > 0, bad);
    const revision = bundle.revision(bad, audit);
    assert.match(revision, /省略号、缩写、去前缀\/尾斜杠/);
    const fallback = bundle.fallback(bad, audit);
    assert.equal(fallback, '当前接口：`GET /pwrsapi/month/view/today`。', '原子接口题的坏路径被删后，应从当前route恢复唯一已核精确路径');
    assert.doesNotMatch(fallback, /该已核接口|GET\s+该已核接口|具体接口路径只按/);
    assert.deepEqual(bundle.audit(fallback, '今天视图接口是什么？', route).violations, []);
  }
  const methodFallback = bundle.fallback('请找 GET /month/view/today，再核当前响应。', bundle.audit('请找 GET /month/view/today，再核当前响应。', '今天视图接口是什么？', route));
  assert.equal(methodFallback, '当前接口：`GET /pwrsapi/month/view/today`。', '未知路径所在整句删除后，用route唯一已核路径回答原子接口题');
  const mixedDraft = '完整接口 GET /pwrsapi/month/view/today；不要简称 /pwrsapi。';
  const mixedFallback = bundle.fallback(mixedDraft, bundle.audit(mixedDraft, '今天视图接口是什么？', route));
  assert.equal(mixedFallback, '当前接口：`GET /pwrsapi/month/view/today`。', '未核短前缀导致同句残缺时整句删除，再仅恢复 route 唯一已核精确路径');
  assert.deepEqual(bundle.audit(mixedFallback, '今天视图接口是什么？', route).violations, []);
  const userPath = bundle.audit('按你提供的 /custom/probe 只读核当前请求。', '我抓到 /custom/probe，怎么判断？', { matched: true, answerFacts: ['只核当前请求'] });
  assert.deepEqual(userPath.violations, [], '用户本轮原文路径可照实引用');
  const userRelativePath = bundle.audit('按你提供的 vendor/probe 只读核当前请求。', '我抓到 vendor/probe，怎么判断？', { matched: true, answerFacts: ['只核当前请求'] });
  assert.deepEqual(userRelativePath.violations, [], '用户本轮逐字提供的裸相对路径可照实引用');
  const inventedWithoutKnownPath = bundle.audit('建议再看 GET /guessed/path。', '还要看哪里？', { matched: true, answerFacts: ['继续核当前请求'] });
  assert.ok(inventedWithoutKnownPath.violations.includes('unexpected_concrete_path'), '没有已核路径时也不能新增具体路径');
  assert.ok(inventedWithoutKnownPath.violations.includes('audience_technical_overreach'), '普通业务问法也不得主动展开猜测接口');
  const slashWords = bundle.audit('核对服务器/JVM 时间、year/week 字段和接口/页面展示差异。', '怎么只读核时间？', route);
  assert.deepEqual(slashWords.violations, [], '中英文普通斜杠短语不能被当作具体路径');
  const naturalSlashText = bundle.audit('日期是 2026/08/14，A/B 两组都正常，附件名 report.xlsx。', '怎么记录现场值？', route);
  assert.deepEqual(naturalSlashText.violations, [], '自然日期、短分组比对和无斜杠文件名不得误判成路径');
});

test('发布前事实作用域审计：相邻模块、通配路径不串入，显式切题放行', () => {
  const likelihoodConst = SRC.match(/const CONSULT_LIKELIHOOD_WORD_RE = [^;]+;/)?.[0] || '';
  const causalLocalizationConst = SRC.match(/const CONSULT_CAUSAL_LOCALIZATION_RE = [^;]+;/)?.[0] || '';
  const deterministicFailureConst = SRC.match(/const CONSULT_DETERMINISTIC_FAILURE_RE = [^;]+;/)?.[0] || '';
  const observationOrderConst = SRC.match(/const CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE = [^;]+;/)?.[0] || '';
  const priorityConst = SRC.match(/const CONSULT_CAUSAL_PRIORITY_RE = [^;]+;/)?.[0] || '';
  const directActionConst = SRC.match(/const CONSULT_DIRECT_RISKY_ACTION_RE = [^;]+;/)?.[0] || '';
  const componentFaultConst = SRC.match(/const CONSULT_COMPONENT_FAULT_RE = [^;]+;/)?.[0] || '';
  const bundle = new Function(
    likelihoodConst + '\n' + causalLocalizationConst + '\n' + deterministicFailureConst + '\n' + observationOrderConst + '\n' + priorityConst + '\n' + directActionConst + '\n' + componentFaultConst + '\n'
    + extractFn(SRC, 'consultHasLikelihoodEvidence') + '\n'
    + extractFn(SRC, 'consultRouteScopeText') + '\n'
    + extractFn(SRC, 'consultHasCausalPriorityEvidence') + '\n'
    + extractFn(SRC, 'consultUnsupportedComponentClaims') + '\n'
    + extractFn(SRC, 'consultHasControlledActionBundle') + '\n'
    + extractFn(SRC, 'consultConcretePaths') + '\n'
    + extractFn(SRC, 'consultScopeEntityTerms') + '\n'
    + extractFn(SRC, 'consultDiagnosticMechanismTerms') + '\n'
    + extractFn(SRC, 'consultScopeTechnicalTokens') + '\n'
    + extractFn(SRC, 'consultMalformedMarkdownTokens') + '\n'
    + extractFn(SRC, 'consultMalformedProseTokens') + '\n'
    + extractFn(SRC, 'consultMarkdownTableCells') + '\n'
    + extractFn(SRC, 'consultMalformedTableTokens') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeTables') + '\n'
    + extractFn(SRC, 'consultRequiredPrimaryPath') + '\n'
    + extractFn(SRC, 'consultFocusedFactGuard') + '\n'
    + extractFn(SRC, 'consultFocusedFactOverreach') + '\n'
    + extractFn(SRC, 'consultFocusedRelationshipFacts') + '\n'
    + extractFn(SRC, 'consultExplicitOperationContracts') + '\n'
    + extractFn(SRC, 'consultOperationEvidenceStopReply') + '\n'
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + extractFn(SRC, 'consultAnswerRevisionPrompt') + '\n'
    + extractFn(SRC, 'consultReplaceUnexpectedPath') + '\n'
    + extractFn(SRC, 'consultDeduplicateFocusedAtomicAnswer') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeMarkdown') + '\n'
    + extractFn(SRC, 'consultAnswerSafeFallback') + '\n'
    + extractFn(SRC, 'consultVerifiedFactsFallback') + '\n'
    + extractFn(SRC, 'routeHasDirectOperationEvidence') + '\n'
    + extractFn(SRC, 'consultMatchedOperationFailureFallback') + '\n'
    + extractFn(SRC, 'consultModelErrorInfo') + '\n'
    + extractFn(SRC, 'consultModelFailureFallback') + '\n'
    + 'return { audit:consultAnswerSemanticAudit, revision:consultAnswerRevisionPrompt, fallback:consultAnswerSafeFallback, verifiedFallback:consultVerifiedFactsFallback, modelErrorInfo:consultModelErrorInfo, modelFailureFallback:consultModelFailureFallback };',
  )();
  const todayRoute = {
    matched: true,
    route: { id: 'QR-TODAY', title: '工作台今天日期星期' },
    primaryRefs: [{ specId: 'STAT-04a', title: '今天视图' }],
    answerFacts: ['GET /pwrsapi/month/view/today 返回 year/week，日期来自 JVM 时区'],
    mustNotConfuse: ['不得答 GET /month/view'],
  };
  const leaked = '今天视图仍调用 GET /pwrsapi/month/view/today。今天视图与外部调度、/comm/*、补跑无关。';
  const leakedAudit = bundle.audit(leaked, '今天请求响应都抓到了，重点核什么？', todayRoute);
  assert.ok(leakedAudit.violations.includes('unexpected_concrete_path'));
  assert.ok(leakedAudit.violations.includes('out_of_scope_entity'));
  assert.ok(leakedAudit.violations.includes('audience_technical_first'), '实施答复不得用接口开场');
  assert.deepEqual(leakedAudit.unexpectedPaths, ['/comm/*']);
  assert.deepEqual(leakedAudit.unexpectedEntityTerms, ['外部调度', '补跑']);
  assert.match(bundle.revision(leaked, leakedAudit), /当前\/继承 route 事实未点名/);
  const leakedFallback = bundle.fallback(leaked, leakedAudit);
  assert.match(leakedFallback, /^研发参考[\s\S]*GET \/pwrsapi\/month\/view\/today/);
  assert.deepEqual(bundle.audit(leakedFallback, '今天请求响应都抓到了，重点核什么？', todayRoute).violations, []);
  const combinedEntityLeak = bundle.audit('不要把折线图、统计同步那套接口掺进来。', '今天请求响应都抓到了，重点核什么？', todayRoute);
  assert.deepEqual(combinedEntityLeak.violations, ['out_of_scope_entity']);
  assert.deepEqual(combinedEntityLeak.unexpectedEntityTerms, ['统计同步', '折线图']);
  assert.deepEqual(bundle.audit('现在切到统计同步和折线图，分别核什么？', '现在切到统计同步和折线图，分别核什么？', todayRoute).violations, [], '用户显式点名组合实体时放行重新路由');

  const hiddenMechanism = bundle.audit('页面与响应不一致 → 页面用了别的数据源/缓存。', '今天视图时间对不上，怎么排查？', todayRoute);
  assert.deepEqual(hiddenMechanism.violations, ['out_of_scope_entity']);
  assert.ok(hiddenMechanism.unexpectedEntityTerms.includes('数据源'));
  assert.ok(hiddenMechanism.unexpectedEntityTerms.includes('缓存'));
  assert.deepEqual(bundle.audit('页面与响应不一致 → 页面呈现链路待验证。', '今天视图时间对不上，怎么排查？', todayRoute).violations, [], '没有scope证据时退回不点名具体机制的呈现层假设');
  assert.deepEqual(bundle.audit('待验证假设：缓存异常。', '已确认当前页面使用缓存，今天视图时间对不上。', todayRoute).violations, [], '用户显式给缓存线索时放行');
  assert.deepEqual(bundle.audit('待验证假设：数据源选择异常。', '今天视图时间对不上，怎么排查？', { ...todayRoute, answerFacts: [...todayRoute.answerFacts, '页面数据源由工作台当前上下文选择'] }).violations, [], 'route facts显式给数据源时放行');
  const patientColumnRoute = {
    matched: true,
    route: { id: 'QR-PATIENT-ID-COLUMN-TYPE', title: '患者主表身份字段类型' },
    answerFacts: ['pwrs_patient.patient_id 是 character varying(50)'],
  };
  const jsMechanismLeak = bundle.audit('长号不应被 JS/中间层收成 Number。', '请求已发出，后端具体走到哪还不知道。', patientColumnRoute);
  assert.deepEqual(jsMechanismLeak.violations, ['out_of_scope_entity'], '列类型事实不能扩写未核JS/中间层实现');
  assert.deepEqual(jsMechanismLeak.unexpectedEntityTerms, ['JavaScript', '中间层', 'Number']);
  assert.doesNotMatch(bundle.fallback('已核列类型是 varchar(50)。长号不应被 JS/中间层收成 Number。', bundle.audit('已核列类型是 varchar(50)。长号不应被 JS/中间层收成 Number。', '请求已发出，后端具体走到哪还不知道。', patientColumnRoute)), /JS|中间层|Number/);
  assert.deepEqual(bundle.audit('前端 JS 不自行拼接日期。', '今天视图由前端 JavaScript 自己拼日期吗？', todayRoute).violations, [], '用户显式JavaScript时应归一放行JS简称');
  assert.deepEqual(bundle.audit('已有报文显示字段进入 Number。', '已有报文显示字段进入 Number，能确认什么？', patientColumnRoute).violations, [], '用户逐字提供Number观察时放行');
  const timezoneValueLeak = bundle.audit('服务器可能不是东八区，也可能是 UTC+0 或 GMT+8。', '今天视图时间对不上，怎么排查？', todayRoute);
  assert.ok(timezoneValueLeak.violations.includes('out_of_scope_entity'));
  assert.ok(timezoneValueLeak.unexpectedEntityTerms.includes('东八区'));
  assert.ok(timezoneValueLeak.unexpectedEntityTerms.includes('UTC+0'));
  assert.ok(timezoneValueLeak.unexpectedEntityTerms.includes('GMT+8'));
  assert.deepEqual(bundle.audit('已核环境是 UTC+8，按这个事实对照响应。', '现场确认环境是 UTC+8，怎么只读核？', todayRoute).violations, [], '用户本轮逐字给出具体时区值时放行');

  const patientIdentityLeak = '这个接口不依赖患者 hospitalId/patientId/visitId；今天视图时间不是患者三元身份链路。';
  const patientIdentityAudit = bundle.audit(patientIdentityLeak, '今天请求响应都抓到了，重点核什么？', todayRoute);
  assert.deepEqual(patientIdentityAudit.violations, ['out_of_scope_entity']);
  assert.deepEqual(patientIdentityAudit.unexpectedEntityTerms, ['患者三元身份', 'hospitalId', 'patientId', 'visitId']);
  assert.deepEqual(patientIdentityAudit.unexpectedTechnicalTokens, ['hospitalId', 'patientId', 'visitId']);
  assert.equal(bundle.fallback(patientIdentityLeak, patientIdentityAudit), '当前草稿未通过发布前证据与动作安全校验，已停止发布其中未经证实的判断和操作指令。');

  const strongTokenLeak = bundle.audit('再排除 p_id、user_code、groupNo 和 ai_status。', '今天视图时间重点核什么？', todayRoute);
  assert.deepEqual(strongTokenLeak.violations, ['out_of_scope_entity']);
  assert.deepEqual(strongTokenLeak.unexpectedTechnicalTokens, ['groupNo', 'p_id', 'user_code', 'ai_status']);
  assert.equal(bundle.fallback('今天视图接口正常。再排除 p_id、user_code、groupNo 和 ai_status。', strongTokenLeak), '今天视图接口正常。');

  const pIdTypeRoute = {
    matched: true,
    fallbackMode: 'verifiedFacts',
    route: { id: 'QR-PATIENT-P-ID-TYPE', title: '患者主表 p_id 字段类型', fallbackMode: 'verifiedFacts' },
    focusTechnicalTokens: ['pwrs_patient', 'p_id', 'uuid'],
    answerFacts: [
      'pwrs_patient.p_id 是 character varying(50)，不是 PostgreSQL 原生 uuid。',
      '类型核对应以已经取得的 DDL 或 schema 元数据为准；如果按只读步骤在第二步出现不一致，保留字段名、实例、版本和原始观测，再升级给数据库负责人。',
      '本路由只回答 p_id 这个字段的存储类型，不把未经提问的其他身份字段扩展进答案。',
    ],
  };
  const pIdUuidAnswer = 'pwrs_patient.p_id 是 character varying(50)，不是 PostgreSQL 原生 UUID。';
  const pIdUuidAudit = bundle.audit(pIdUuidAnswer, 'pwrs_patient.p_id 是 PostgreSQL 原生 uuid 吗？', pIdTypeRoute);
  assert.deepEqual(pIdUuidAudit.violations, [], 'UUID/uuid 大小写差异不应把同一字段答案判成越界');
  assert.deepEqual(pIdUuidAudit.focusedTechnicalOverreach, [], 'UUID 不应因通用 ID 后缀规则成为 focused overreach');

  const pIdColumnTypeAnswer = 'pwrs_patient.p_id 是 character varying(50)，不是 PostgreSQL 原生 uuid。';
  const pIdColumnTypeAudit = bundle.audit(pIdColumnTypeAnswer, 'p_id 列类型是什么？', pIdTypeRoute);
  assert.deepEqual(pIdColumnTypeAudit.violations, [], 'PostgreSQL 中的 SQL 子串不应把 p_id 类型答案判成 focused_fact_overreach');
  assert.deepEqual(pIdColumnTypeAudit.focusedFactOverreach, [], 'PostgreSQL 不是独立 SQL 实施扩写');

  const pIdColumnTypeFallback = bundle.verifiedFallback('p_id 列类型是什么？', pIdTypeRoute);
  assert.ok(pIdColumnTypeFallback, 'p_id 类型题的 verifiedFacts fallback 应可发布');
  assert.deepEqual(pIdColumnTypeFallback.finalAudit.violations, [], 'p_id 类型题 fallback 终稿必须终审全绿');
  assert.equal(pIdColumnTypeFallback.finalAudit.audienceMode, 'developer', '列类型契约题应按研发受众审计');
  assert.match(pIdColumnTypeFallback.reply, /character varying\(50\)/);
  assert.doesNotMatch(pIdColumnTypeFallback.reply, /只读步骤|第二步|升级给数据库负责人|本路由/);

  const pIdSqlLeak = bundle.audit(
    'pwrs_patient.p_id 是 character varying(50)，不是 PostgreSQL 原生 uuid；请执行 SQL 查看索引。',
    'p_id 列类型是什么？',
    pIdTypeRoute,
  );
  assert.ok(pIdSqlLeak.violations.includes('focused_fact_overreach'), '真正的 SQL 操作扩写仍须拦截');

  const pIdSiblingLeak = bundle.audit(
    'pwrs_patient.p_id 是 character varying(50)，不是 PostgreSQL 原生 UUID；同表 patient_id、visit_id 和 district_code 也都是这个类型。',
    'pwrs_patient.p_id 是 PostgreSQL 原生 uuid 吗？',
    pIdTypeRoute,
  );
  assert.ok(pIdSiblingLeak.violations.includes('out_of_scope_entity'), 'p_id route 仍须拦 sibling 字段越界');
  assert.deepEqual(pIdSiblingLeak.unexpectedTechnicalTokens, ['patient_id', 'visit_id', 'district_code']);

  const sharedBasics = bundle.audit('只核当前页面、接口、记录、状态、id、code、HTTP 200、JSON 和 JWT。', '今天视图怎么只读核？', todayRoute);
  assert.deepEqual(sharedBasics.violations, [], '共享基础词、协议词和裸 id/code/status 不得误判为相邻业务实体');

  const patientRoute = { matched: true, route: { id: 'QR-PATIENT', title: '患者详情' }, answerFacts: ['患者身份核 hospitalId + patientId + visitId；districtCode 不能替代 hospitalId'] };
  assert.deepEqual(bundle.audit('再看患教模板和患者详情。', '患者详情身份怎么核？', patientRoute).violations, ['out_of_scope_entity']);
  assert.deepEqual(bundle.audit('患者身份要核 hospitalId、patientId、visitId，districtCode 不能替代。', '患者身份怎么核？', patientRoute).violations, [], '当前患者 route 的身份字段不应被误拦');
  assert.deepEqual(bundle.audit('hospitalId、patientId、visitId 三项都要核。', '现在切到患者详情，身份怎么核？', patientRoute).violations, [], '用户显式点名患者实体后允许新 route 事实');
  assert.deepEqual(bundle.audit('患教模板身份怎么核？', '现在切到患教模板，身份怎么核？', patientRoute).violations, [], '用户显式点名的新实体可进入新 route');
  assert.deepEqual(bundle.audit('患者身份按当前规则核对。', '患者详情身份怎么核？', patientRoute).violations, [], 'current route 点名患者时允许患者实体');
  assert.deepEqual(bundle.audit('医生与药师只读核现有咨询记录。', '医生和药师的咨询怎么核？', { matched: true, route: { title: '医生药师咨询' }, answerFacts: ['医生与药师可查看既有咨询'] }).violations, [], '医生/药师在 current scope 中放行');
  assert.deepEqual(bundle.audit('今天视图正常后再核医生订单。', '今天视图时间重点核什么？', todayRoute).violations, ['out_of_scope_entity'], '未点名医生/订单不得从相邻主题串入');
  const patientEduLeak = bundle.audit('患者详情正常，再核患教的 ai_status。', '患者详情身份怎么核？', patientRoute);
  assert.deepEqual(patientEduLeak.violations, ['out_of_scope_entity']);
  assert.deepEqual(patientEduLeak.unexpectedEntityTerms, ['患教', 'ai_status']);
  const educationRoute = { matched: true, route: { id: 'QR-EDU', title: '患教状态' }, answerFacts: ['患教当前状态字段为 ai_status'] };
  assert.deepEqual(bundle.audit('患教只核 ai_status。', '现在切到患教状态怎么核？', educationRoute).violations, [], '显式患教新 route 及其已核字段放行');

  const feedbackRoute = { matched: true, route: { id: 'QR-FEEDBACK', title: '药师反馈' }, answerFacts: ['反馈发送后锁定正文'] };
  assert.deepEqual(bundle.audit('反馈锁定后再查收费记录。', '反馈发送后还能改吗？', feedbackRoute).violations, ['out_of_scope_entity']);
  assert.deepEqual(bundle.audit('收费记录只读核对。', '现在切到收费记录怎么查？', feedbackRoute).violations, [], '显式收费新实体放行');
  const feedbackChargeLeak = bundle.audit('反馈已锁定，再核收费的 charge_status。', '反馈发送后还能改吗？', feedbackRoute);
  assert.deepEqual(feedbackChargeLeak.violations, ['out_of_scope_entity']);
  assert.deepEqual(feedbackChargeLeak.unexpectedEntityTerms, ['收费', 'charge_status']);
  const chargeRoute = { matched: true, route: { id: 'QR-CHARGE', title: '收费状态' }, answerFacts: ['收费状态字段为 charge_status'] };
  assert.deepEqual(bundle.audit('只读核 charge_status。', '现在切到收费状态怎么查？', chargeRoute).violations, [], '显式收费新 route 及其已核字段放行');

  const refScopedRoute = { matched: true, route: { id: 'QR-AUDIT', title: '审核详情' }, primaryRefs: [{ specId: 'AUDIT-01', section: 'groupNo 关联规则' }] };
  assert.deepEqual(bundle.audit('按 groupNo 对照已有详情。', '审核详情怎么只读核？', refScopedRoute).violations, [], 'current route ref 中已核强标识符可以照实使用');
});

test('跨主体副作用动作不能通过对接方、运维或开发外包绕过', () => {
  const safeIntent = new Function(extractFn(SRC, 'consultSafeDiagnosticIntent') + '\nreturn consultSafeDiagnosticIntent;')();
  const fn = new Function('consultSafeDiagnosticIntent', extractFn(SRC, 'consultFinalActionConsistencyGuard') + '\nreturn consultFinalActionConsistencyGuard;')(safeIntent);
  for (const q of [
    '让对接方把患者号改成字符串后，用同一个患者再复测一次可以吗？',
    '让运维重跑这个同步任务抓日志行不行？',
    '让开发改映射配置后拿生产数据再试一次呢？',
    '实施不操作，让第三方改参数后重新触发就安全了吧？',
  ]) {
    const text = fn(q, { matched: true, route: { title: '对接诊断' } });
    assert.match(text, /让实施、用户、患者、对接方、运维或开发/);
    assert.match(text, /动作换成由第三方执行也不改变副作用/);
    assert.match(text, /改成检查已有页面、请求、响应、报文、映射、截图、日志或审计/);
    assert.match(text, /隔离环境或专用数据、明确授权、回滚\/清理、幂等性与影响范围全部齐全/);
  }
});

test('consult 接线在非破坏守卫之后追加最终动作与证据概率审计', () => {
  const start = SRC.indexOf("if (url.pathname === '/api/consult'");
  const end = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const route = SRC.slice(start, end);
  const nonDestructive = route.indexOf('consultNonDestructiveDiagnosticGuard(qtext, route)');
  const finalAudit = route.indexOf('consultFinalActionConsistencyGuard(qtext, route)');
  const likelihoodAudit = route.indexOf('consultEvidenceLikelihoodGuard(qtext, route)');
  assert.ok(nonDestructive >= 0, '应接入非破坏守卫');
  assert.ok(finalAudit > nonDestructive, '最终动作一致性审计应在其它动作守卫之后，作为发布前最后检查');
  assert.ok(likelihoodAudit > finalAudit, '最终证据概率审计应在动作一致性之后，删除无依据概率和经验成因');
  assert.match(route, /先完整生成到服务端内存，发布前做确定性语义校验/);
  assert.match(route, /const initialAudit = consultAnswerSemanticAudit\(draft, qtext, route\)/);
  assert.match(route, /consultAnswerRevisionPrompt\(draft, initialAudit\)/);
  assert.match(route, /if \(!revisionAccepted\).*consultAnswerSafeFallback\(draft, initialAudit\)/s);
  assert.match(route, /retrieval\.answerAudit = answerAudit/);
  assert.match(route, /sse\(\{ answerAudit \}\)/);
  assert.doesNotMatch(route, /reply \+= piece; sse\(\{ v: piece \}\)/, '未校验草稿不得先流给浏览器');
});

test('通用受控条件齐备但未点名动作时，不得由检索命中替用户选择业务实体', () => {
  const fn = new Function(extractFn(SRC, 'consultGenericControlledActionGuard') + '\nreturn consultGenericControlledActionGuard;')();
  const generic = fn('隔离测试环境、专用测试数据、执行授权、回滚清理、幂等性和影响范围都确认了，可以受控验证吗？');
  assert.match(generic, /具体业务动作尚未点名/);
  assert.match(generic, /可以进入“评估一次受控验证”的门槛/);
  assert.match(generic, /不得根据检索关键词或命中的相邻 route/);
  assert.match(generic, /不得.*自行选择同步、补跑、患者数据、调度、\/comm\//);
  assert.match(generic, /具体要验证的动作是什么/);
  assert.equal(fn('隔离测试环境、授权、回滚、幂等和影响范围都确认，要补跑患者同步。'), '');
});

test('模糊的“第二步对不上”仍须先给规则条件分支，不能退回整体拒答', () => {
  const fn = new Function(extractFn(SRC, 'consultRuleApplicationGuard') + '\nreturn consultRuleApplicationGuard;')();
  for (const q of [
    '关于反馈发送后锁定，按这个顺序查到第二步就对不上了，后面先停还是继续？',
    '患教状态这里还是不行，接下来先停吗？',
    '配置缓存第二步对不上，下一步呢？',
  ]) {
    const text = fn(q, { matched: true });
    assert.match(text, /符合规则→这是预期、停止异常调查/);
    assert.match(text, /与规则冲突→继续排查/);
    assert.match(text, /只追问一个/);
  }
});

test('consult prompt 同时注入规则应用、运行安全、文件验收与现场诊断，顺序固定', () => {
  const call = SRC.match(/consultSystem\(proj, cver, hits, specHits, codeHits, qtext\)[\s\S]{0,1800}?messages: msgs/);
  assert.ok(call, '应定位 consult 模型调用');
  assert.ok(call[0].indexOf('consultAudienceGuard(qtext)') > call[0].indexOf('consultSystem('));
  assert.ok(call[0].indexOf('consultAudienceGuard(qtext)') < call[0].indexOf('currentTurnEvidenceGuard'));
  assert.ok(call[0].indexOf('consultEvidenceLedgerGuard') < call[0].indexOf('consultRuleApplicationGuard'));
  assert.ok(call[0].indexOf('consultRuleApplicationGuard') < call[0].indexOf('consultPatientIdentityGuard'));
  assert.ok(call[0].indexOf('consultPatientIdentityGuard') < call[0].indexOf('consultCriticalContextGuard'));
  assert.ok(call[0].indexOf('consultRuleApplicationGuard') < call[0].indexOf('consultExactPathBoundaryGuard'));
  assert.ok(call[0].indexOf('consultExactPathBoundaryGuard') < call[0].indexOf('consultOperationalSafetyGuard'));
  assert.ok(call[0].indexOf('consultExactPathBoundaryGuard') < call[0].indexOf('consultGenericControlledActionGuard'));
  assert.ok(call[0].indexOf('consultGenericControlledActionGuard') < call[0].indexOf('consultOperationalSafetyGuard'));
  assert.ok(call[0].indexOf('consultOperationalSafetyGuard') < call[0].indexOf('consultFileArtifactGuard'));
  assert.ok(call[0].indexOf('consultFileArtifactGuard') < call[0].indexOf('consultDiagnosticGuard'));
  assert.ok(call[0].indexOf('consultDiagnosticGuard') < call[0].indexOf('consultNonDestructiveDiagnosticGuard'));
});

test('consult 将受众模式写入本轮 retrieval，便于生产回看实际分层', () => {
  const start = SRC.indexOf("if (url.pathname === '/api/consult'");
  const end = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const route = SRC.slice(start, end);
  assert.match(route, /retrieval\.audienceMode = consultAudienceMode\(qtext\)/);
});

test('安全诊断意图绕过机械 miss，但普通无证据事实题仍保持短路', () => {
  const start = SRC.indexOf("if (url.pathname === '/api/consult'");
  const end = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const route = SRC.slice(start, end);
  assert.match(route, /const safeDiagnostic = consultSafeDiagnosticIntent\(qtext\)/);
  assert.match(route, /const noAnswer = !conversationMode && !safeDiagnostic && routeMiss && specNoSpec/);
  assert.match(route, /consultDiagnosticGuard\(qtext, route\)/);
  assert.match(route, /consultOperationalSafetyGuard\(qtext, route\)/);
  assert.match(route, /consultFileArtifactGuard\(qtext, route\)/);
  assert.match(route, /consultEvidenceLedgerGuard\(qtext, route\)/);
  assert.match(route, /consultPatientIdentityGuard\(qtext, route\)/);
  assert.match(route, /consultExactPathBoundaryGuard\(qtext, route\)/);
  assert.match(route, /consultNonDestructiveDiagnosticGuard\(qtext, route\)/);
});
