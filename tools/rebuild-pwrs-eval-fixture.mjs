#!/usr/bin/env node
// 从生产导出的 PWRS consult JSONL 重建严格 200 题的非敏感题集。
// 输入每行形如 {id,data:{chat:[{role,text}]}}；只保留问题与稳定顺序号，不保留答案、账号、医院或会话元数据。
// 用法：node tools/rebuild-pwrs-eval-fixture.mjs /tmp/pwrs-eval-intakes.jsonl [输出文件]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const input = process.argv[2];
const output = process.argv[3] || path.join(ROOT, 'tools/fixtures/pwrs-qwen-max-200.questions.json');
if (!input || !fs.existsSync(input)) {
  process.stderr.write('用法：node tools/rebuild-pwrs-eval-fixture.mjs <生产 consult JSONL> [输出文件]\n');
  process.exit(2);
}

const rows = fs.readFileSync(input, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
const byQuestion = new Map();
let sequence = 0;
for (const row of rows) {
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
  for (const message of (Array.isArray(data.chat) ? data.chat : [])) {
    if (!message || message.role !== 'user') continue;
    const question = String(message.text || message.content || '').replace(/\s+/g, ' ').trim();
    if (!question) continue;
    sequence += 1;
    // 同一问题可能因技术失败重试。Map 覆盖只影响来源序号；最终题序按第一次出现的位置恢复。
    const previous = byQuestion.get(question);
    byQuestion.set(question, { question, firstSequence: previous ? previous.firstSequence : sequence });
  }
}

const unique = [...byQuestion.values()].sort((a, b) => a.firstSequence - b.firstSequence);
if (unique.length !== 200) throw new Error(`严格题集应为 200 道去重问题，实际 ${unique.length}`);
// 生产重试使 A26 之后不再按固定 5×4 阵列落库，不能用数组下标伪造 anchor/style。
// 评测以稳定题文 + requirements 为准；Q 序号只表示第一次出现顺序。
const questions = unique.map((item, index) => ({
  id: `Q${String(index + 1).padStart(3, '0')}`,
  question: item.question,
}));

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify({
  schema: 2,
  product: 'psp',
  sourceVersion: '2.7.260812-1',
  description: 'PWRS Spec 严格评测 200 道去重问题。仅含非敏感问题文本；按题文 requirements 评分，不从顺序推断 anchor/style。',
  questions,
}, null, 2)}\n`);
process.stdout.write(`PASS: ${questions.length} questions -> ${output}\n`);
