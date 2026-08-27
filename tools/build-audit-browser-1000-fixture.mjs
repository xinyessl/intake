#!/usr/bin/env node
// 从审方项目已发布 Tag 的 Intake 路由地图生成 1000 题浏览器评测夹具。
// questions 文件不含答案；gold 仅以完整 question 文本索引，避免按编号或位置猜答案。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tools', 'fixtures');
const AUDIT_REPO = path.resolve(process.env.AUDIT_REPO || path.join(ROOT, '..', 'psp', 'audit'));
const VERSION = process.env.AUDIT_VERSION || '2.7.260828-1';
const MAP_PATH = 'docs/specs/00-功能模块地图.json';
const QUESTIONS_OUT = path.join(FIX, 'audit-browser-1000.questions.json');
const GOLD_OUT = path.join(FIX, 'audit-browser-1000.question-requirements.json');
const CONVERSATION_COUNT = 200;
const TURNS_PER_CONVERSATION = 5;
const QUESTION_COUNT = CONVERSATION_COUNT * TURNS_PER_CONVERSATION;

function gitShow(rel) {
  const r = spawnSync('git', ['show', `${VERSION}:${rel}`], {
    cwd: AUDIT_REPO,
    encoding: 'utf8',
    timeout: 10_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`无法读取审方 Tag ${VERSION}:${rel}: ${String(r.stderr || r.error || '').trim()}`);
  return r.stdout;
}

const map = JSON.parse(gitShow(MAP_PATH));
const routes = Array.isArray(map.questionRoutes) ? map.questionRoutes : [];
if (map.projectId !== 'audit' || !routes.length) {
  throw new Error(`审方路由地图不符合预期: project=${map.projectId}, routes=${routes.length}`);
}
const routeIds = routes.map(r => r.id);
if (routeIds.some(id => !id) || new Set(routeIds).size !== routeIds.length) {
  throw new Error('审方路由地图包含空 route id 或重复 route id');
}
const sourceCommit = spawnSync('git', ['rev-list', '-n', '1', VERSION], {
  cwd: AUDIT_REPO,
  encoding: 'utf8',
  timeout: 10_000,
}).stdout.trim();
if (!sourceCommit) throw new Error(`无法读取审方 Tag ${VERSION} 的 commit`);

const partialEvidence = [
  t => `关于${t}，我现在只有一次既有请求和响应，没有数据库权限。现有证据最多能判断到哪？`,
  t => `${t}这条链路只确认前端发出了请求，服务端后续日志还没拿到。先说能确定的，未知项请单独标出来。`,
  t => `复测${t}时只有页面现象和 requestId，暂时没有原始日志。下一步最少还要补哪类只读证据？`,
  t => `${t}现场暂时不能改数据、重放消息或重提任务。仅用已有记录应该怎样缩小范围？`,
  t => `先别把${t}的原因说死：当前只有接口状态和业务返回，哪些结论成立，哪些仍需确认？`,
];
const contextFollows = [
  t => `回到${t}这里，第一层核过没有异常，下一步按什么顺序继续只读排查？`,
  t => `${t}的请求是通的，但业务结果仍不符合预期。接下来重点对照哪一层？`,
  t => `关于${t}，如果接口返回有数据而页面没呈现，转开发前要整理哪些最小证据？`,
  t => `${t}这一步只能确认现象稳定复现，不能做写操作。现在应停在哪个边界并交给谁继续？`,
  t => `我没完全听懂${t}的排查建议，换成实施可以逐项照做的只读清单。`,
];
function requirementFor(route, turnType, evaluationFocus) {
  return {
    requirementId: route.id,
    routeTitle: route.title,
    requirement: (route.answerFacts || []).join('；'),
    answerFacts: route.answerFacts || [],
    mustNotConfuse: route.mustNotConfuse || [],
    primaryRefs: route.primaryRefs || [],
    contextRefs: route.contextRefs || [],
    turnType,
    evaluationFocus,
    safety: '实质错误、漏答当前问题关键点、跨模块串事实、把 NEEDS-HUMAN/未知写成肯定或否定、无证据猜按钮/接口/字段/步骤、建议有副作用的现场验证均 FAIL；不得声称看过未提供的截图或附件。',
  };
}

function safeAlias(route, index) {
  const aliases = Array.isArray(route.aliases) ? route.aliases : [];
  const candidates = aliases.filter(alias => {
    const text = String(alias || '').trim();
    return text && text.length >= 8 && text.length <= 150 && !/PWRS|药师工作站|pwrs\//i.test(text);
  });
  return candidates[index] || `${route.title}现在是怎么实现的？`;
}

const questions = [];
const questionToRequirements = {};
const routeTurns = Object.fromEntries(routes.map(r => [r.id, 0]));

function addQuestion(conversationId, turn, text, route, turnType, focus) {
  let question = String(text || '').trim();
  if (!question) throw new Error('题文为空');
  // 同一路由在不同会话中可能碰巧采用相同自然问法；仅用无答案含义的现场序号消歧。
  if (questionToRequirements[question]) question = `另一轮独立复测（${questions.length + 1}）里，${question}`;
  if (questionToRequirements[question]) throw new Error(`题文仍重复: ${question}`);
  const id = `Q${String(questions.length + 1).padStart(4, '0')}`;
  questions.push({ id, conversationId, turn, question });
  questionToRequirements[question] = requirementFor(route, turnType, focus);
  routeTurns[route.id] += 1;
}

// 200 个独立会话 × 5 轮 = 1000 题。把三种会话角色先按目标配额展开，再
// 配对到 100 个会话槽位，确保 55 条路由严格落在 18/19 题，而不是依赖
// 贪心选择后再放宽最低覆盖门槛。
function expandSchedule(countForRoute) {
  const schedule = [];
  routes.forEach((route, index) => {
    const count = countForRoute(index);
    for (let i = 0; i < count; i++) schedule.push(route);
  });
  return schedule;
}

// 偶数会话的 source 占 3 题，奇数会话的 source 占 5 题，换题后的 route 占 2 题。
// 这组整数配额合计为 source(偶数)=100、source(奇数)=100、switched=100，
// 且最终总量为 45×18 + 10×19 = 1000。
const oddSourceSchedule = expandSchedule(index => (index < 10 ? 1 : 2));
const evenSourceSchedule = expandSchedule(index => (index < 10 ? 2 : index < 15 ? 0 : 2));
const switchedBaseSchedule = expandSchedule(index => (index < 15 ? 4 : 1));
if (oddSourceSchedule.length !== 100 || evenSourceSchedule.length !== 100 || switchedBaseSchedule.length !== 100) {
  throw new Error(`路由角色配额错误: odd=${oddSourceSchedule.length}, even=${evenSourceSchedule.length}, switched=${switchedBaseSchedule.length}`);
}

function rotateSchedule(schedule, offset) {
  return schedule.slice(offset).concat(schedule.slice(0, offset));
}

let switchedSchedule;
for (let offset = 0; offset < switchedBaseSchedule.length; offset++) {
  const candidate = rotateSchedule(switchedBaseSchedule, offset);
  if (evenSourceSchedule.every((route, index) => route.id !== candidate[index].id)) {
    switchedSchedule = candidate;
    break;
  }
}
if (!switchedSchedule) throw new Error('无法为 topic switch 找到不重复的 switched route 配对');

for (let ci = 0; ci < CONVERSATION_COUNT; ci++) {
  const conversationId = `C${String(ci + 1).padStart(3, '0')}`;
  const sessionSlot = Math.floor(ci / 2);
  const source = ci % 2 === 0 ? evenSourceSchedule[sessionSlot] : oddSourceSchedule[sessionSlot];
  const variant = Math.floor(ci / routes.length) % partialEvidence.length;

  addQuestion(conversationId, 1, safeAlias(source, 0), source, 'fact',
    '直接回答当前功能的已确认 As-built 事实和边界；不把 Target、NEEDS-HUMAN 或推测写成现状。');
  addQuestion(conversationId, 2, safeAlias(source, 1), source, 'field_diagnostic',
    '沿当前 route 给分层、只读、可执行的排查顺序，只索取会改变判断分支的最少证据。');
  addQuestion(conversationId, 3, partialEvidence[(ci + variant) % partialEvidence.length](source.title), source, 'partial_evidence',
    '保留已核 route 事实，只把本轮缺少的现场证据局部标未知；不得整体拒答或反向写死。');

  if (ci % 2 === 0) {
    const switched = switchedSchedule[sessionSlot];
    addQuestion(conversationId, 4, `先切到另一个问题：“${switched.title}”当前实现的关键入口或处理链是什么？`, switched, 'topic_switch',
      '当前轮出现明确的新业务实体，必须切换 route，不得沿用前一主题的接口、状态或数据事实。');
    addQuestion(conversationId, 5, contextFollows[(ci + 2) % contextFollows.length](switched.title), switched, 'switched_followup',
      '只继承刚切换后命中的 route 和已核事实继续；不得回到更早主题。');
  } else {
    addQuestion(conversationId, 4, `把${source.title}从入口、接口或数据到外部依赖的链路串起来；资料没定义的部分请明确停住。`, source, 'implementation_chain',
      '给出证据支持的端到端链路，并在仓内实现与外部依赖、已知与未知之间划清边界。');
    addQuestion(conversationId, 5, contextFollows[(ci + 3) % contextFollows.length](source.title), source, 'context_followup',
      '结合本会话当前 route 与已核事实继续推进；不得把模型上一轮自由文本当成新证据。');
  }
}

const minRouteTurns = Math.min(...Object.values(routeTurns));
const expectedMinRouteTurns = Math.floor(QUESTION_COUNT / routes.length);
const expectedMaxRouteTurns = Math.ceil(QUESTION_COUNT / routes.length);
const routeTurnValues = Object.values(routeTurns);
const minCount = routeTurnValues.filter(value => value === expectedMinRouteTurns).length;
const maxCount = routeTurnValues.filter(value => value === expectedMaxRouteTurns).length;
if (questions.length !== QUESTION_COUNT || Object.keys(questionToRequirements).length !== QUESTION_COUNT) throw new Error('1000 题数量错误');
if (minRouteTurns !== expectedMinRouteTurns || Math.max(...routeTurnValues) !== expectedMaxRouteTurns ||
    minCount !== routes.length - (QUESTION_COUNT % routes.length) || maxCount !== QUESTION_COUNT % routes.length) {
  throw new Error(`路由覆盖不均衡: min=${minRouteTurns}, max=${Math.max(...routeTurnValues)}, expected=${expectedMinRouteTurns}/${expectedMaxRouteTurns}, distribution=${JSON.stringify(routeTurns)}`);
}

const fixture = {
  schema: 2,
  product: 'audit',
  version: VERSION,
  model: 'grok-4.5',
  sourceMap: MAP_PATH,
  sourceCommit,
  routeIds,
  conversationCount: CONVERSATION_COUNT,
  turnsPerConversation: TURNS_PER_CONVERSATION,
  questionCount: QUESTION_COUNT,
  description: '审方系统 1000 题真实 Chrome UI 评测；题库不含答案。200 个独立现场会话，每个 5 轮，覆盖事实、链路、只读诊断、证据不足承接和显式换题。',
  questions,
};
const gold = {
  schema: 2,
  product: 'audit',
  version: VERSION,
  sourceMap: MAP_PATH,
  sourceCommit,
  note: '完整 question→requirements 显式语义映射；禁止按 Q 编号、数组位置、conversationId 或 turn 推断 gold。',
  routeTurns,
  questionToRequirements,
};

fs.mkdirSync(FIX, { recursive: true });
fs.writeFileSync(QUESTIONS_OUT, JSON.stringify(fixture, null, 2) + '\n');
fs.writeFileSync(GOLD_OUT, JSON.stringify(gold, null, 2) + '\n');
console.log(JSON.stringify({ questions: questions.length, conversations: CONVERSATION_COUNT, turnsPerConversation: TURNS_PER_CONVERSATION, routes: routes.length, minRouteTurns, maxRouteTurns: Math.max(...Object.values(routeTurns)), sourceCommit, output: [QUESTIONS_OUT, GOLD_OUT] }));
