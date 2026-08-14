import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
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
    assert.match(text, /“例如：\/如下：\/包括：\/分别为：”后必须有实际内容/);
    assert.match(text, /不得留下孤立的“还是页面…\/或者接口…”等后半分支/);
    assert.match(text, /没有前述主张的“但\/但是\/不过\/然而”转折残句/);
    assert.match(text, /一致\/不一致、是\/否、有\/无、成功\/失败/);
    assert.match(text, /“不要做\/禁止\/避免\/切勿”等否定标题下不得只剩/);
    assert.match(text, /只问“先做哪个验证\/第一步做什么”时，只给一个最小只读验证/);
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
  for (const phrase of ['很常见', '较常见', '比较常见', '常见原因', '经常发生', '多发', '高发', '很多是规则内预期', '不少属于时区差', '多数是预期', '大多不是BUG', '绝大多数无需处理', '少数会异常', '极少出错', '大部分符合预期', '小部分对不上', '几乎全部正常', '频繁出现', '偶尔失败', '有时不同', '首要原因', '主要原因之一', '很像服务端缓存', '更像前端取错字段', '可能是异常兜底', '疑似配置问题', '倾向于时区问题', '高度符合服务端时区差', '强烈符合配置问题', '明显符合前端问题', '更符合缓存问题', '较符合网关问题', '比较符合后端问题', '最容易出现', '很容易丢精度', '尤其容易对不上', '尤其是午夜前后可能与本机不一致', '可能和浏览器本机不一致', '易发生', '很可能就发生在序列化时', '更可能在请求之后', '较可能从网关开始', '比较可能由服务端引起', '超过精度就会直接丢位', '一定会导致字段少位', '必然会出现错误', '肯定会发生变化', '这就是对接方类型传错']) {
    assert.ok(audit(`接口和浏览器不一致${phrase}。`, '今天视图为什么不一致？', route).violations.includes('unsupported_likelihood'), phrase);
  }
  assert.deepEqual(audit('待验证假设：服务端时区和现场约定不一致；可能分支：页面没有照接口响应展示。', '今天视图为什么不一致？', route).violations, [], '明确标为不排序待验证分支时应放行');
  assert.deepEqual(audit('优先查服务端时区。', '今天视图为什么不一致？', route).violations, ['unsupported_likelihood'], '没有当前差异证据不得排序成因');
  assert.deepEqual(audit('优先怀疑服务端时区。', '今天视图为什么不一致？', route).violations, ['unsupported_likelihood'], '用怀疑/判断包装的成因优先级同样须有当前差异证据');
  assert.deepEqual(audit('页面=接口但与本机不一致，优先查服务端时区。', '现场已确认页面=接口，但与本机不一致。', route).violations, [], '用户已给出直接差异时可据此排查对应层');
  assert.deepEqual(audit('按已核顺序优先查前端展示。', '页面为什么不一致？', { matched: true, route: { title: '展示排查' }, answerFacts: ['说明书明确排查顺序：页面与接口不一致时优先查前端展示'] }).violations, [], 'route明确顺序时放行');
  assert.deepEqual(audit('响应与页面不一致，所以前端展示/缓存异常。', '今天视图不一致，怎么排查？', route).violations, ['unsupported_component_fault', 'out_of_scope_entity'], '答案自己补的条件不能把未核组件故障写成定论或引入未点名机制');
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
  const namedField = audit('说明书称它是常见字段名。', '这个字段叫什么？', {
    matched: true,
    route: { title: '字段命名' },
    answerFacts: ['字段正文明确写明：patient_id 是常见字段名'],
  });
  assert.deepEqual(namedField.violations, [], '正文明确命名时允许照实引用“常见字段名”');
  assert.deepEqual(audit('这是一个可能分支，尚待验证。', '今天视图为什么不一致？', route).violations, [], '不排序的“可能分支”标签本身不是概率定论');
  assert.deepEqual(audit('这与已核规则一致。', '今天视图为什么不一致？', route).violations, [], '不带倾向程度的事实一致性描述不应误拦');
  assert.deepEqual(audit('这段说明很容易理解。', '请解释这段说明。', route).violations, [], '非故障结果的日常“容易理解”不应误拦');
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
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + extractFn(SRC, 'consultAnswerRevisionPrompt') + '\n'
    + extractFn(SRC, 'consultReplaceUnexpectedPath') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeMarkdown') + '\n'
    + extractFn(SRC, 'consultAnswerSafeFallback') + '\n'
    + 'return { audit:consultAnswerSemanticAudit, revision:consultAnswerRevisionPrompt, fallback:consultAnswerSafeFallback };',
  )();
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
  assert.match(todayAtomicFallback, /GET \/month\/view/);
  assert.doesNotMatch(todayAtomicFallback, /Map<String,String>|\byear\b|\bweek\b|JVM 当前时区/);
  assert.deepEqual(bundle.audit(todayAtomicFallback, '工作台今天日期和星期调用哪个接口？', todayAtomicRoute).violations, []);
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
  assert.match(q127R31Fallback, /只读对照已有源值与出站报文/);
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
  assert.match(q129OrderFallback, /原始全号与报文一致，但收到值不同/);
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
  assert.match(ungroundedStartFallback, /^2\. 核已有响应$/m);
  assert.match(ungroundedStartFallback, /^3\. 整理材料$/m);
  assert.deepEqual(bundle.audit(ungroundedStartFallback, '我只有截图，没有日志，最少还要补什么？', route).violations, []);
  assert.ok(bundle.audit('3. 只读核已有响应', '下一步先做什么？', route).violations.includes('nonsequential_top_level_steps'), '单个顶层步骤也须从本轮合法起点开始');
  assert.deepEqual(bundle.audit('3. 继续核已有响应', '已经做到第二步，接下来呢？', route).violations, [], '用户明确做到第二步时可从第三步承接');
  assert.deepEqual(bundle.audit('1. 顶层步骤\n    7. 嵌套原始编号\n2. 下一顶层步骤', '怎么核对？', route).violations, [], '四空格嵌套编号不参与顶层连续性审计');
  assert.deepEqual(bundle.audit('1. 顶层步骤\n```text\n9. 文件中的原文编号\n```\n2. 下一顶层步骤', '怎么核对？', route).violations, [], '代码围栏里的编号不参与顶层连续性审计');

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
  assert.equal(atomicRelationshipAudit.focusedFactOverreach.length, 3);
  const atomicRelationshipFallback = bundle.fallback(atomicRelationshipDraft, atomicRelationshipAudit);
  assert.match(atomicRelationshipFallback, /form_id 关联/);
  assert.match(atomicRelationshipFallback, /element_id 关联/);
  assert.match(atomicRelationshipFallback, /form_id →/);
  assert.doesNotMatch(atomicRelationshipFallback, /删除|级联|历史结果|悬空|渲染|content 快照/);
  assert.deepEqual(bundle.audit(atomicRelationshipFallback, atomicRelationshipQuestion, formRoute).violations, []);
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
  assert.deepEqual(tableAudit.violations, ['cross_actor_side_effect']);
  const tableFallback = bundle.fallback(tableDraft, tableAudit);
  assert.match(tableFallback, /\| 接口与页面相同；浏览器不同 \| 日期来自服务端 JVM 时区 \| 保留状态码与响应；交联调 \|/);
  assert.doesNotMatch(tableFallback, /让运维修改/);
  assert.deepEqual(bundle.audit(tableFallback, '今天视图和浏览器不一致，怎么排查？', atomicRoute).violations, [], '表格行内分号不得被降级拆成孤立单元格');

  const sparseTable = '| 对照结果 | 已核边界 | 只读下一步 |\n| --- | --- | --- |\n| 把状态码与响应留给联调 | | |';
  const sparseAudit = bundle.audit(sparseTable, '今天视图怎么排查？', atomicRoute);
  assert.deepEqual(sparseAudit.violations, ['malformed_markdown']);
  const sparseFallback = bundle.fallback(sparseTable, sparseAudit);
  assert.doesNotMatch(sparseFallback, /\|/);
  assert.deepEqual(bundle.audit(sparseFallback, '今天视图怎么排查？', atomicRoute).violations, []);

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
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + extractFn(SRC, 'consultAnswerRevisionPrompt') + '\n'
    + extractFn(SRC, 'consultReplaceUnexpectedPath') + '\n'
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
  assert.equal(mixedFallback, '完整接口 GET /pwrsapi/month/view/today；', '未核短前缀所在分句整体删除，合法完整路径不受污染');
  assert.deepEqual(bundle.audit(mixedFallback, '今天视图接口是什么？', route).violations, []);
  const userPath = bundle.audit('按你提供的 /custom/probe 只读核当前请求。', '我抓到 /custom/probe，怎么判断？', { matched: true, answerFacts: ['只核当前请求'] });
  assert.deepEqual(userPath.violations, [], '用户本轮原文路径可照实引用');
  const userRelativePath = bundle.audit('按你提供的 vendor/probe 只读核当前请求。', '我抓到 vendor/probe，怎么判断？', { matched: true, answerFacts: ['只核当前请求'] });
  assert.deepEqual(userRelativePath.violations, [], '用户本轮逐字提供的裸相对路径可照实引用');
  const inventedWithoutKnownPath = bundle.audit('建议再看 GET /guessed/path。', '还要看哪里？', { matched: true, answerFacts: ['继续核当前请求'] });
  assert.deepEqual(inventedWithoutKnownPath.violations, ['unexpected_concrete_path'], '没有已核路径时也不能新增具体路径');
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
    + extractFn(SRC, 'consultAnswerSemanticAudit') + '\n'
    + extractFn(SRC, 'consultAnswerRevisionPrompt') + '\n'
    + extractFn(SRC, 'consultReplaceUnexpectedPath') + '\n'
    + extractFn(SRC, 'consultNormalizeSafeMarkdown') + '\n'
    + extractFn(SRC, 'consultAnswerSafeFallback') + '\n'
    + 'return { audit:consultAnswerSemanticAudit, revision:consultAnswerRevisionPrompt, fallback:consultAnswerSafeFallback };',
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
  assert.deepEqual(leakedAudit.violations, ['unexpected_concrete_path', 'out_of_scope_entity']);
  assert.deepEqual(leakedAudit.unexpectedPaths, ['/comm/*']);
  assert.deepEqual(leakedAudit.unexpectedEntityTerms, ['外部调度', '补跑']);
  assert.match(bundle.revision(leaked, leakedAudit), /当前\/继承 route 事实未点名/);
  const leakedFallback = bundle.fallback(leaked, leakedAudit);
  assert.equal(leakedFallback, '今天视图仍调用 GET /pwrsapi/month/view/today。');
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
  const call = SRC.match(/consultSystem\(proj, cver, hits, specHits, codeHits, qtext\)[\s\S]{0,1100}?messages: msgs/);
  assert.ok(call, '应定位 consult 模型调用');
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
