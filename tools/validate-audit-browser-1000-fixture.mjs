#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'tools', 'fixtures');
const AUDIT_REPO = path.resolve(process.env.AUDIT_REPO || path.join(ROOT, '..', 'psp', 'audit'));
const fixturePath = path.join(FIX, 'audit-browser-1000.questions.json');
const goldPath = path.join(FIX, 'audit-browser-1000.question-requirements.json');
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8'));
const version = String(fixture.version || '').trim();
const sourceMap = String(fixture.sourceMap || gold.sourceMap || 'docs/specs/00-功能模块地图.json').trim();
const shown = spawnSync('git', ['show', `${version}:${sourceMap}`], { cwd: AUDIT_REPO, encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
if (shown.status !== 0) throw new Error(`无法读取审方 Tag 路由地图: ${String(shown.stderr || shown.error || '').trim()}`);
const map = JSON.parse(shown.stdout);
const routeRows = Array.isArray(map.questionRoutes) ? map.questionRoutes : [];
const routes = new Map(routeRows.map(r => [r.id, r]));
const questions = fixture.questions || [];
const mapping = gold.questionToRequirements || {};
const errors = [], ids = new Set(), texts = new Set(), convs = new Map(), routeTurns = {}, turnTypes = {};
const sourceCommit = spawnSync('git', ['rev-list', '-n', '1', version], { cwd: AUDIT_REPO, encoding: 'utf8', timeout: 10_000 }).stdout.trim();
const expectedQuestionCount = Number(fixture.questionCount || 1000);
const expectedConversationCount = Number(fixture.conversationCount || 200);
const expectedTurnsPerConversation = Number(fixture.turnsPerConversation || 5);
const expectedMinRouteTurns = Math.floor(expectedQuestionCount / Math.max(1, routes.size));
const expectedMaxRouteTurns = Math.ceil(expectedQuestionCount / Math.max(1, routes.size));

if (fixture.product !== 'audit') errors.push(`fixture product=${fixture.product}`);
if (!version) errors.push('fixture version missing');
if (gold.product !== fixture.product) errors.push(`gold product drift: ${gold.product}`);
if (gold.version !== version) errors.push(`gold version drift: ${gold.version} != ${version}`);
if (sourceMap !== 'docs/specs/00-功能模块地图.json') errors.push(`unexpected source map: ${sourceMap}`);
if (gold.sourceMap !== sourceMap) errors.push(`gold sourceMap drift: ${gold.sourceMap} != ${sourceMap}`);
if (gold.sourceCommit !== sourceCommit) errors.push(`source commit drift: ${gold.sourceCommit} != ${sourceCommit}`);
if (fixture.sourceCommit !== sourceCommit) errors.push(`fixture source commit drift: ${fixture.sourceCommit} != ${sourceCommit}`);
if (new Set(routeRows.map(r => r.id)).size !== routeRows.length) errors.push('duplicate route id in map');
if (!Array.isArray(fixture.routeIds)) errors.push('fixture routeIds missing');
else {
  const fixtureRouteIds = new Set(fixture.routeIds);
  for (const id of routes.keys()) if (!fixtureRouteIds.has(id)) errors.push(`fixture route missing: ${id}`);
  for (const id of fixtureRouteIds) if (!routes.has(id)) errors.push(`fixture stale route: ${id}`);
  if (fixtureRouteIds.size !== routes.size) errors.push(`fixture route count=${fixtureRouteIds.size}, map=${routes.size}`);
}

for (const q of questions) {
  if (!/^Q\d{4}$/.test(q.id)) errors.push(`bad id ${q.id}`);
  if (ids.has(q.id)) errors.push(`duplicate id ${q.id}`); ids.add(q.id);
  if (texts.has(q.question)) errors.push(`duplicate question ${q.question}`); texts.add(q.question);
  if (q.question.length < 8 || q.question.length > 150) errors.push(`length ${q.id}=${q.question.length}`);
  if (/如图|见图|图中|图片里|截图里|附件中|我发的图片/.test(q.question)) errors.push(`unmapped media claim ${q.id}`);
  if (/PWRS|药师工作站|pwrs\//i.test(q.question)) errors.push(`cross-product term ${q.id}`);
  const req = mapping[q.question];
  if (!req) errors.push(`missing gold ${q.id}`);
  else {
    const route = routes.get(req.requirementId);
    if (!route) errors.push(`unknown route ${q.id}: ${req.requirementId}`);
    else {
      if (req.routeTitle !== route.title) errors.push(`route title drift ${q.id}`);
      if (JSON.stringify(req.answerFacts) !== JSON.stringify(route.answerFacts || [])) errors.push(`answerFacts drift ${q.id}`);
      if (JSON.stringify(req.mustNotConfuse) !== JSON.stringify(route.mustNotConfuse || [])) errors.push(`mustNotConfuse drift ${q.id}`);
      for (const ref of [...(req.primaryRefs || []), ...(req.contextRefs || [])]) {
        const exists = spawnSync('git', ['cat-file', '-e', `${fixture.version}:${ref.path}`], { cwd: AUDIT_REPO });
        if (exists.status !== 0) errors.push(`missing ref ${q.id}: ${ref.path}`);
      }
    }
    routeTurns[req.requirementId] = (routeTurns[req.requirementId] || 0) + 1;
    turnTypes[req.turnType] = (turnTypes[req.turnType] || 0) + 1;
  }
  if (!convs.has(q.conversationId)) convs.set(q.conversationId, []);
  convs.get(q.conversationId).push(q);
}
for (const [id, rows] of convs) {
  if (rows.length !== expectedTurnsPerConversation) errors.push(`${id} turns=${rows.length}`);
  const turns = rows.map(x => x.turn).sort((a, b) => a - b);
  if (turns.some((turn, index) => turn !== index + 1)) errors.push(`${id} turn order=${turns.join(',')}`);
}
for (const question of Object.keys(mapping)) if (!texts.has(question)) errors.push(`extra gold: ${question}`);
for (const id of routes.keys()) {
  const count = routeTurns[id] || 0;
  if (count < expectedMinRouteTurns || count > expectedMaxRouteTurns) {
    errors.push(`route coverage ${id}=${count}, expected=${expectedMinRouteTurns}-${expectedMaxRouteTurns}`);
  }
}
const observedRouteTurns = [...routes.keys()].map(id => routeTurns[id] || 0);
const observedMinCount = observedRouteTurns.filter(count => count === expectedMinRouteTurns).length;
const observedMaxCount = observedRouteTurns.filter(count => count === expectedMaxRouteTurns).length;
const expectedMinCount = routes.size - (expectedQuestionCount % routes.size);
const expectedMaxCount = expectedQuestionCount % routes.size;
if (observedMinCount !== expectedMinCount || observedMaxCount !== expectedMaxCount) {
  errors.push(`route distribution=${JSON.stringify(routeTurns)}, expected ${expectedMinCount}x${expectedMinRouteTurns}+${expectedMaxCount}x${expectedMaxRouteTurns}`);
}
for (const id of Object.keys(routeTurns)) if (!routes.has(id)) errors.push(`stale route coverage ${id}`);
for (const id of routes.keys()) {
  if (Number(gold.routeTurns?.[id] || 0) !== Number(routeTurns[id] || 0)) errors.push(`gold routeTurns drift ${id}`);
}

const report = {
  schema: 1,
  fixture: path.relative(ROOT, fixturePath),
  product: fixture.product,
  version,
  sourceMap,
  sourceCommit: gold.sourceCommit,
  questions: questions.length,
  uniqueQuestions: texts.size,
  goldMappings: Object.keys(mapping).length,
  conversations: convs.size,
  routeCount: routes.size,
  expectedMinRouteTurns,
  expectedMaxRouteTurns,
  minRouteTurns: Math.min(...Object.values(routeTurns)),
  maxRouteTurns: Math.max(...Object.values(routeTurns)),
  turnTypes,
  errors,
  sample100: questions.slice(0, 100),
};
const out = path.join(ROOT, 'docs', 'reviews', 'evidence', 'AUDIT-SPEC-GROK-4.5-BROWSER-1000-FIXTURE-AUDIT-20260828.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, sample100: `${report.sample100.length} rows persisted`, output: out }, null, 2));
if (fixture.product !== 'audit' || version !== fixture.version || questions.length !== expectedQuestionCount || texts.size !== expectedQuestionCount || Object.keys(mapping).length !== expectedQuestionCount || convs.size !== expectedConversationCount || routes.size < 1 || errors.length) process.exit(1);
