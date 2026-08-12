import fs from 'node:fs';

const [inputPath, mappingPath, requirementsPath, outputPath] = process.argv.slice(2);
const configPath = process.env.MODEL_CONFIG || '/app/data/model-api.json';
if (!inputPath || !mappingPath || !requirementsPath || !outputPath) {
  throw new Error('用法: node tools/judge-pwrs-qwen-max-eval.mjs <raw.json> <question-anchor.json> <requirements.json> <output.json>');
}

const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const mapping = JSON.parse(fs.readFileSync(mappingPath, 'utf8')).questionToAnchor;
const requirements = JSON.parse(fs.readFileSync(requirementsPath, 'utf8')).anchors;
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const batchSize = Number(process.env.JUDGE_BATCH_SIZE || 4);

async function callJudge(batch) {
  const base = String(config.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
  const system = '你是严格的软件规格答案裁判。requirement 是该 anchor 的完整事实库，不代表每种问法都必须展开全部事实。逐题先看 question 实际询问的范围：只要求回答覆盖题目所问的相关关键事实/值/边界；不得因未展开同 anchor 中本题未问的其它事实扣分。额外事实只有与权威事实冲突或无证据时才扣分。仍须严格判定实质错误、拒答本题已有事实、漏掉本题明确要求的路径/字段/状态/边界、串模块或越界臆造。表达等价可通过。仅输出 JSON 数组，每项 {id,anchor,pass,reason}，不得 markdown。';
  const messages = [{ role: 'system', content: system }, { role: 'user', content: JSON.stringify(batch) }];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      let response;
      if ((config.provider || 'openai') === 'anthropic') {
        response = await fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: config.model, max_tokens: 3500, system, messages: messages.slice(1) }),
          signal: AbortSignal.timeout(60_000),
        });
        const body = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(body.error || body));
        return (body.content || []).map(item => item.text || '').join('');
      }
      response = await fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${config.apiKey}` },
        body: JSON.stringify({ model: config.model, messages, max_tokens: 3500, temperature: 0 }),
        signal: AbortSignal.timeout(60_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(JSON.stringify(body.error || body));
      return body.choices?.[0]?.message?.content || '';
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
    }
  }
}

let verdicts = [];
try {
  const prior = JSON.parse(fs.readFileSync(`${outputPath}.partial`, 'utf8'));
  if (Array.isArray(prior)) verdicts = prior;
} catch {}

const pending = input.results.filter(item => !verdicts.some(verdict => verdict.id === item.id));
for (let index = 0; index < pending.length; index += batchSize) {
  const batch = pending.slice(index, index + batchSize).map(item => {
    const anchor = mapping[item.question];
    if (!anchor || !requirements[anchor]) throw new Error(`缺少题文金标: ${item.question}`);
    return { id: item.id, question: item.question, anchor, requirement: requirements[anchor], answer: item.answer };
  });
  const raw = await callJudge(batch);
  verdicts.push(...JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '')));
  fs.writeFileSync(`${outputPath}.partial`, `${JSON.stringify(verdicts, null, 2)}\n`);
  process.stderr.write(`judge ${verdicts.length}/${input.results.length}\n`);
}

const results = input.results.map(item => ({ ...item, anchor: mapping[item.question], verdict: verdicts.find(verdict => verdict.id === item.id) }));
const output = {
  version: input.version,
  total: results.length,
  pass: results.filter(item => item.verdict?.pass).length,
  fail: results.filter(item => !item.verdict?.pass).map(item => ({ id: item.id, anchor: item.anchor, question: item.question, answer: item.answer, reason: item.verdict?.reason })),
  results,
};
fs.writeFileSync(outputPath, `${JSON.stringify(output, null, 2)}\n`);
console.log(JSON.stringify({ total: output.total, pass: output.pass, fail: output.fail.map(item => ({ id: item.id, anchor: item.anchor, reason: item.reason })) }, null, 2));
