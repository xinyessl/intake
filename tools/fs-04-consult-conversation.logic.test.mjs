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

test('consult prompt 同时注入规则应用、运行安全与现场诊断，顺序固定', () => {
  const call = SRC.match(/consultSystem\(proj, cver, hits, specHits, codeHits, qtext\)[\s\S]{0,900}?messages: msgs/);
  assert.ok(call, '应定位 consult 模型调用');
  assert.ok(call[0].indexOf('consultEvidenceLedgerGuard') < call[0].indexOf('consultRuleApplicationGuard'));
  assert.ok(call[0].indexOf('consultRuleApplicationGuard') < call[0].indexOf('consultOperationalSafetyGuard'));
  assert.ok(call[0].indexOf('consultOperationalSafetyGuard') < call[0].indexOf('consultDiagnosticGuard'));
});

test('安全诊断意图绕过机械 miss，但普通无证据事实题仍保持短路', () => {
  const start = SRC.indexOf("if (url.pathname === '/api/consult'");
  const end = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const route = SRC.slice(start, end);
  assert.match(route, /const safeDiagnostic = consultSafeDiagnosticIntent\(qtext\)/);
  assert.match(route, /const noAnswer = !conversationMode && !safeDiagnostic && routeMiss && specNoSpec/);
  assert.match(route, /consultDiagnosticGuard\(qtext, route\)/);
  assert.match(route, /consultOperationalSafetyGuard\(qtext, route\)/);
  assert.match(route, /consultEvidenceLedgerGuard\(qtext, route\)/);
});
