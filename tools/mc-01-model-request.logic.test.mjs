import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const SRC = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in server.mjs`);
  const parenOpen = src.indexOf('(', start);
  let parenDepth = 0, parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')' && --parenDepth === 0) { parenClose = i; break; }
  }
  assert.ok(parenClose > parenOpen, `${name} parameter list must close`);
  const braceOpen = src.indexOf('{', parenClose);
  let depth = 0, quote = '', escaped = false, lineComment = false, blockComment = false;
  for (let i = braceOpen; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    if (lineComment) { if (ch === '\n') lineComment = false; continue; }
    if (blockComment) { if (ch === '*' && next === '/') { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') { lineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { blockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} body must close`);
}

function modelFns(fetchImpl) {
  return new Function(
    'fetch',
    [
      'const MODEL_STREAM_FIRST_TOKEN_TIMEOUT_MS = 25000;',
      'const MODEL_STREAM_CANDIDATE_TIMEOUT_MS = 60000;',
      extractFn(SRC, 'mmParseImage'),
      extractFn(SRC, 'withImages'),
      extractFn(SRC, 'anthropicThinkingOverride'),
      'async ' + extractFn(SRC, 'callModelOnce'),
      'async ' + extractFn(SRC, 'callModelStreamOnce'),
      'return { callModelOnce, callModelStreamOnce };',
    ].join('\n'),
  )(fetchImpl);
}

function anthropicReply(body, text) {
  if (!body.stream) return { ok: true, async json() { return { content: [{ type: 'text', text }] }; } };
  const event = `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text } })}\n\ndata: [DONE]\n\n`;
  return { ok: true, body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(event); } } };
}

test('AC-12 阿里云 qwen3.8-max 的非流式与流式 Anthropic 请求都禁用 thinking', async () => {
  const requests = [];
  const { callModelOnce, callModelStreamOnce } = modelFns(async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    return anthropicReply(body, body.stream ? '流式正常' : '正常');
  });
  const cfg = {
    provider: 'anthropic',
    model: 'qwen3.8-max',
    baseUrl: 'https://llm-test.maas.aliyuncs.com/apps/anthropic',
    apiKey: 'test-key',
  };

  assert.equal(await callModelOnce(cfg, { messages: [{ role: 'user', content: 'ping' }], maxTokens: 16 }), '正常');
  const deltas = [];
  assert.equal(await callModelStreamOnce(
    cfg,
    { messages: [{ role: 'user', content: 'ping' }], maxTokens: 16, firstTokenTimeoutMs: 100, candidateTimeoutMs: 500 },
    value => deltas.push(value),
    null,
  ), '流式正常');
  assert.deepEqual(deltas, ['流式正常']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every(({ url }) => url.endsWith('/apps/anthropic/v1/messages')));
  assert.deepEqual(requests.map(({ body }) => body.thinking), [{ type: 'disabled' }, { type: 'disabled' }]);
  assert.deepEqual(requests.map(({ body }) => body.stream), [undefined, true]);
});

test('AC-12 普通 Claude/Anthropic 与非阿里云 qwen3.8 请求体保持原样', async () => {
  const bodies = [];
  const { callModelOnce, callModelStreamOnce } = modelFns(async (_url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    return anthropicReply(body, '正常');
  });
  const messages = [{ role: 'user', content: 'ping' }];

  await callModelOnce({ provider: 'anthropic', model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com', apiKey: 'test-key' }, { messages });
  await callModelStreamOnce(
    { provider: 'anthropic', model: 'claude-sonnet-4-6', baseUrl: 'https://api.anthropic.com', apiKey: 'test-key' },
    { messages, firstTokenTimeoutMs: 100, candidateTimeoutMs: 500 },
    () => {},
    null,
  );
  await callModelOnce({ provider: 'anthropic', model: 'qwen3.8-max', baseUrl: 'https://example.com/apps/anthropic', apiKey: 'test-key' }, { messages });

  assert.equal(bodies.length, 3);
  assert.equal(Object.hasOwn(bodies[0], 'thinking'), false, 'Claude 请求不得被全局禁用 thinking');
  assert.equal(Object.hasOwn(bodies[1], 'thinking'), false, 'Claude 流式请求也不得被全局禁用 thinking');
  assert.equal(Object.hasOwn(bodies[2], 'thinking'), false, '非阿里云 Qwen 请求不得套用阿里云兼容项');
});
