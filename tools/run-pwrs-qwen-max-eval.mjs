import fs from 'node:fs';

const fixturePath = process.argv[2];
const outputPath = process.argv[3];
if (!fixturePath || !outputPath) {
  throw new Error('用法: node tools/run-pwrs-qwen-max-eval.mjs <questions.json> <checkpoint.json>');
}

const questions = JSON.parse(fs.readFileSync(fixturePath, 'utf8')).questions;
const token = process.env.INTAKE_LINK_TOKEN;
const base = process.env.INTAKE_BASE || 'http://intake.lcpharmacy.cn';
const version = process.env.PWRS_VERSION;
if (!token || !version || questions.length !== 200) {
  throw new Error('需要 INTAKE_LINK_TOKEN、PWRS_VERSION，且题集必须恰好为 200 题');
}

const blocks = Array.from({ length: 40 }, (_, index) => ({
  sourceBlock: index + 1,
  questions: questions.slice(index * 5, index * 5 + 5),
}));
const completed = new Map();
try {
  const checkpoint = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  if (checkpoint.runnerSchema === 2 && checkpoint.version === version) {
    for (const block of checkpoint.blocks || []) {
      if (block.results?.length === 5 && block.convId) completed.set(block.sourceBlock, block);
    }
  }
} catch {}

function saveCheckpoint() {
  const payload = {
    runnerSchema: 2,
    version,
    createdAt: new Date().toISOString(),
    conversationBlocks: 40,
    concurrentConversations: 2,
    blocks: [...completed.values()].sort((a, b) => a.sourceBlock - b.sourceBlock),
  };
  payload.results = payload.blocks.flatMap(block => block.results);
  const temporary = `${outputPath}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(temporary, outputPath);
}

async function ask(messages, convId = '') {
  const response = await fetch(`${base}/api/consult?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'psp', version, messages, deep: false, ...(convId ? { convId } : {}) }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);

  const raw = await response.text();
  let answer = '';
  let returnedConvId = convId;
  for (const block of raw.split(/\n\n+/)) {
    const line = block.split('\n').find(value => value.startsWith('data: '));
    if (!line) continue;
    try {
      const event = JSON.parse(line.slice(6));
      if (typeof event.v === 'string') answer += event.v;
      if (event.done === true && event.convId) returnedConvId = String(event.convId);
    } catch {}
  }
  if (!answer.trim() || !returnedConvId) throw new Error('SSE 不完整：缺少回答或 convId');
  return { answer: answer.trim(), convId: returnedConvId };
}

async function askWithRetry(messages, convId) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await ask(messages, convId);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, attempt * 1500));
    }
  }
  throw lastError;
}

async function runBlock(block) {
  const messages = [];
  const results = [];
  let convId = '';
  for (let turn = 1; turn <= block.questions.length; turn += 1) {
    const item = block.questions[turn - 1];
    messages.push({ role: 'user', content: item.question });
    const response = await askWithRetry(messages, convId);
    if (convId && response.convId !== convId) throw new Error(`第 ${block.sourceBlock} 块会话 ID 发生变化`);
    convId = response.convId;
    messages.push({ role: 'assistant', content: response.answer });
    results.push({ ...item, sourceBlock: block.sourceBlock, turn, convId, answer: response.answer });
  }
  return { sourceBlock: block.sourceBlock, convId, results };
}

const selected = new Set(String(process.env.ONLY_BLOCKS || '')
  .split(',').map(value => value.trim()).filter(Boolean).map(Number).filter(Number.isFinite));
const pending = blocks.filter(block => (!selected.size || selected.has(block.sourceBlock)) && !completed.has(block.sourceBlock));
let next = 0;
async function worker() {
  while (true) {
    const index = next;
    next += 1;
    if (index >= pending.length) return;
    const block = await runBlock(pending[index]);
    completed.set(block.sourceBlock, block);
    saveCheckpoint();
    process.stderr.write(`blocks ${completed.size}/40 questions ${completed.size * 5}/200\n`);
  }
}

await Promise.all([worker(), worker()]);
saveCheckpoint();
console.log(`完成 ${completed.size * 5} 题，checkpoint: ${outputPath}`);
