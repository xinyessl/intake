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
const shown = spawnSync('git', ['show', `${fixture.version}:docs/specs/00-功能模块地图.json`], { cwd: AUDIT_REPO, encoding: 'utf8', timeout: 10_000, maxBuffer: 32 * 1024 * 1024 });
if (shown.status !== 0) throw new Error(`无法读取审方 Tag 路由地图: ${String(shown.stderr || shown.error || '').trim()}`);
const map = JSON.parse(shown.stdout);
const routes = new Map((map.questionRoutes || []).map(r => [r.id, r]));
const questions = fixture.questions || [];
const mapping = gold.questionToRequirements || {};
const errors = [], ids = new Set(), texts = new Set(), convs = new Map(), routeTurns = {}, turnTypes = {};

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
  if (rows.length !== 5) errors.push(`${id} turns=${rows.length}`);
  const turns = rows.map(x => x.turn).sort((a, b) => a - b);
  if (turns.some((turn, index) => turn !== index + 1)) errors.push(`${id} turn order=${turns.join(',')}`);
}
for (const question of Object.keys(mapping)) if (!texts.has(question)) errors.push(`extra gold: ${question}`);
for (const id of routes.keys()) if ((routeTurns[id] || 0) < 20) errors.push(`route coverage ${id}=${routeTurns[id] || 0}`);

const report = {
  schema: 1,
  fixture: path.relative(ROOT, fixturePath),
  product: fixture.product,
  version: fixture.version,
  sourceCommit: gold.sourceCommit,
  questions: questions.length,
  uniqueQuestions: texts.size,
  goldMappings: Object.keys(mapping).length,
  conversations: convs.size,
  routeCount: routes.size,
  minRouteTurns: Math.min(...Object.values(routeTurns)),
  maxRouteTurns: Math.max(...Object.values(routeTurns)),
  turnTypes,
  errors,
  sample100: questions.slice(0, 100),
};
const out = path.join(ROOT, 'docs', 'reviews', 'evidence', 'AUDIT-SPEC-GROK-4.5-BROWSER-1000-FIXTURE-AUDIT-20260825.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report, sample100: `${report.sample100.length} rows persisted`, output: out }, null, 2));
if (fixture.product !== 'audit' || fixture.version !== '2.7.260825-1' || questions.length !== 1000 || texts.size !== 1000 || Object.keys(mapping).length !== 1000 || convs.size !== 200 || routes.size !== 41 || errors.length) process.exit(1);
