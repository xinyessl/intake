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
const VERSION = process.env.AUDIT_VERSION || '2.7.260825-1';
const MAP_PATH = 'docs/specs/00-功能模块地图.json';
const QUESTIONS_OUT = path.join(FIX, 'audit-browser-1000.questions.json');
const GOLD_OUT = path.join(FIX, 'audit-browser-1000.question-requirements.json');

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
if (map.projectId !== 'audit' || routes.length !== 41) {
  throw new Error(`审方路由地图不符合预期: project=${map.projectId}, routes=${routes.length}`);
}

const scenePrefixes = [
  '今天门诊现场反馈', '住院药师复测时发现', '实施在测试环境核对时碰到', '医院电话里只描述',
  '值班药师刚反馈', '另一院区复现了', '上线后首次巡检看到', '业务老师现场演示时发现',
];
const factOpeners = [
  r => r.aliases?.[0] || `${r.title}现在是怎么实现的？`,
  r => r.aliases?.[1] || `${r.title}涉及哪些接口、数据和边界？`,
  r => `请按当前实现说明“${r.title}”的主链路，不要把待确认项当成已上线事实。`,
  r => `“${r.title}”现在能从 Spec 确认到什么，最关键的边界是什么？`,
  r => `从实施视角解释一下“${r.title}”：入口、处理链路和系统边界分别是什么？`,
];
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
const diagnosticOpeners = [
  (p, t) => `${p}“${t}结果与预期不一致”。第一步先核对前端、接口、任务状态还是数据？`,
  (p, t) => `${p}“${t}没有得到预期结果”。不改业务数据的前提下，先抓什么最有用？`,
  (p, t) => `${p}“${t}偶发异常”。给我一个从入口到依赖边界的只读排查顺序。`,
  (p, t) => `${p}“${t}看起来卡住了”。哪些观测只能说明现象，不能直接推出根因？`,
  (p, t) => `${p}“${t}和另一账号表现不同”。先怎样区分页面可见、接口认证和业务归属？`,
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

// 200 个独立会话 × 5 轮 = 1000 题。17 与 41 互质，路由在会话入口均匀轮转。
for (let ci = 0; ci < 200; ci++) {
  const conversationId = `C${String(ci + 1).padStart(3, '0')}`;
  const source = routes[(ci * 17) % routes.length];
  const switched = routes[(routes.indexOf(source) + 9 + ci * 7) % routes.length];
  const variant = Math.floor(ci / routes.length) % factOpeners.length;
  const prefix = scenePrefixes[ci % scenePrefixes.length];

  addQuestion(conversationId, 1, factOpeners[variant](source), source, 'fact',
    '直接回答当前功能的已确认 As-built 事实和边界；不把 Target、NEEDS-HUMAN 或推测写成现状。');
  addQuestion(conversationId, 2, diagnosticOpeners[variant](prefix, source.title), source, 'field_diagnostic',
    '沿当前 route 给分层、只读、可执行的排查顺序，只索取会改变判断分支的最少证据。');
  addQuestion(conversationId, 3, partialEvidence[(ci + variant) % partialEvidence.length](source.title), source, 'partial_evidence',
    '保留已核 route 事实，只把本轮缺少的现场证据局部标未知；不得整体拒答或反向写死。');

  if (ci % 2 === 0) {
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

if (questions.length !== 1000 || Object.keys(questionToRequirements).length !== 1000) throw new Error('1000 题数量错误');
if (Math.min(...Object.values(routeTurns)) < 20) throw new Error(`路由覆盖不足: ${JSON.stringify(routeTurns)}`);

const fixture = {
  schema: 2,
  product: 'audit',
  version: VERSION,
  model: 'grok-4.5',
  description: '审方系统 1000 题真实 Chrome UI 评测；题库不含答案。200 个独立现场会话，每个 5 轮，覆盖事实、链路、只读诊断、证据不足承接和显式换题。',
  questions,
};
const gold = {
  schema: 2,
  product: 'audit',
  version: VERSION,
  sourceMap: MAP_PATH,
  sourceCommit: spawnSync('git', ['rev-list', '-n', '1', VERSION], { cwd: AUDIT_REPO, encoding: 'utf8' }).stdout.trim(),
  note: '完整 question→requirements 显式语义映射；禁止按 Q 编号、数组位置、conversationId 或 turn 推断 gold。',
  routeTurns,
  questionToRequirements,
};

fs.mkdirSync(FIX, { recursive: true });
fs.writeFileSync(QUESTIONS_OUT, JSON.stringify(fixture, null, 2) + '\n');
fs.writeFileSync(GOLD_OUT, JSON.stringify(gold, null, 2) + '\n');
console.log(JSON.stringify({ questions: questions.length, conversations: 200, routes: routes.length, minRouteTurns: Math.min(...Object.values(routeTurns)), output: [QUESTIONS_OUT, GOLD_OUT] }));
