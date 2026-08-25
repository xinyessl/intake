import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const SRC = fs.readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const FIELD = fs.readFileSync(new URL('../public/field.html', import.meta.url), 'utf8');
const SUBMIT = fs.readFileSync(new URL('../public/submit.html', import.meta.url), 'utf8');

const chunksStart = SRC.indexOf('function consultFinalAnswerChunks');
const streamStart = SRC.indexOf('async function consultStreamFinalAnswer', chunksStart);
const auditStart = SRC.indexOf('function consultAnswerSemanticAudit', streamStart);
assert.ok(chunksStart >= 0 && streamStart > chunksStart && auditStart > streamStart);
const factory = new Function([
  SRC.slice(chunksStart, streamStart),
  SRC.slice(streamStart, auditStart),
  'return { consultFinalAnswerChunks, consultStreamFinalAnswer };',
].join('\n'));
const { consultFinalAnswerChunks, consultStreamFinalAnswer } = factory();

const heartbeatStart = SRC.indexOf('function startConsultSseHeartbeat');
const heartbeatEnd = SRC.indexOf('// 模型草稿必须先完整生成', heartbeatStart);
assert.ok(heartbeatStart >= 0 && heartbeatEnd > heartbeatStart);
const { startConsultSseHeartbeat } = new Function(
  SRC.slice(heartbeatStart, heartbeatEnd) + '\nreturn { startConsultSseHeartbeat };',
)();

const completionStart = FIELD.indexOf('function consultCompletionText');
const completionEnd = FIELD.indexOf('// aborted=true', completionStart);
assert.ok(completionStart >= 0 && completionEnd > completionStart);
const { consultCompletionText } = new Function(
  FIELD.slice(completionStart, completionEnd) + '\nreturn { consultCompletionText };',
)();

test('安全终稿按多个自然块输出，拼接逐字等于终稿', () => {
  const final = [
    '已确认：今天视图使用当前已核接口返回的日期与星期。',
    '第一步只读对照已有请求和响应，记录请求时间、响应中的日期值以及页面显示值。',
    '第二步核对浏览器当时展示的日期和星期，不修改系统时间或业务配置。',
    '如果三处值仍不一致，把同一时间点的脱敏截图、已有请求和响应一起交给开发定位。',
  ].join('\n\n');
  const chunks = consultFinalAnswerChunks(final, { firstTarget: 72, target: 110 });
  assert.ok(chunks.length >= 2, `expected multi chunk, got ${chunks.length}`);
  assert.equal(chunks.join(''), final);
  assert.ok(chunks[0].length >= 20 && chunks[0].length <= 160, `unexpected first chunk size ${chunks[0].length}`);
});

test('围栏代码、Markdown 表格和链接不会被拆成半截', () => {
  const code = '```text\nGET /verified/path\nstatus: ok\n```\n';
  const table = '| 项目 | 结果 |\n| --- | --- |\n| 日期 | 2026-08-14 |\n| 星期 | 五 |\n';
  const link = '[查看已核说明](https://example.test/docs?q=today&mode=read)';
  const emphasis = '**已核规则。本轮仍按同一规则核对。**';
  const final = `先确认已有证据。\n\n${code}\n${table}\n只读参考：${link}。\n${emphasis}\n最后整理时间点。`;
  const chunks = consultFinalAnswerChunks(final, { firstTarget: 48, target: 64 });
  assert.equal(chunks.join(''), final);
  assert.ok(chunks.some(chunk => chunk.includes(code)), 'code fence must stay in one chunk');
  assert.ok(chunks.some(chunk => chunk.includes(table)), 'table must stay in one chunk');
  assert.ok(chunks.some(chunk => chunk.includes(link)), 'link must stay in one chunk');
  assert.ok(chunks.some(chunk => chunk.includes(emphasis)), 'emphasis must stay in one chunk');
});

test('SSE 多块发送的累计正文逐字等于安全终稿', async () => {
  const final = '已确认当前规则。'.repeat(18) + '\n\n只读取已有页面、请求、响应和日志。'.repeat(10);
  const events = [];
  const result = await consultStreamFinalAnswer(final, (chunk, index, total) => { events.push({ v: chunk, index, total }); return true; }, { delayMs: 0, firstTarget: 64, target: 96 });
  assert.ok(events.length > 1);
  assert.equal(events.map(event => event.v).join(''), final);
  assert.equal(result.sentText, final);
  assert.equal(result.sentChunks, result.totalChunks);
  assert.equal(result.stopped, false);
});

test('客户端停止或断连后停止写块，只保留已发送的安全终稿前缀', async () => {
  const final = '第一段只读确认。'.repeat(15) + '\n\n第二段继续核对。'.repeat(15);
  let closed = false;
  const sent = [];
  const result = await consultStreamFinalAnswer(final, chunk => {
    sent.push(chunk);
    if (sent.length === 2) closed = true;
    return true;
  }, { delayMs: 0, firstTarget: 48, target: 64, isClosed: () => closed });
  assert.equal(result.stopped, true);
  assert.equal(result.sentChunks, 2);
  assert.equal(result.sentText, sent.join(''));
  assert.ok(final.startsWith(result.sentText));
  assert.ok(result.sentText.length < final.length);

  const ac = new AbortController();
  const abortedChunks = [];
  const aborted = await consultStreamFinalAnswer(final, chunk => {
    abortedChunks.push(chunk);
    ac.abort();
    return true;
  }, { delayMs: 0, firstTarget: 48, target: 64, signal: ac.signal });
  assert.equal(aborted.stopped, true);
  assert.equal(aborted.sentChunks, 1);
  assert.equal(aborted.sentText, abortedChunks[0]);
});

test('审计失败场景也只允许安全终稿进入发布器，草稿/修订稿不在 SSE 正文', async () => {
  const unsafeDraft = '让运维改配置后重跑。';
  const unsafeRevision = '请对接方修改参数再复测。';
  const safeFinal = '当前只核对已有请求、响应、日志和审计记录。';
  const visible = [];
  await consultStreamFinalAnswer(safeFinal, chunk => { visible.push(chunk); return true; }, { delayMs: 0 });
  const body = visible.join('');
  assert.equal(body, safeFinal);
  assert.ok(!body.includes(unsafeDraft));
  assert.ok(!body.includes(unsafeRevision));

  const start = SRC.indexOf("if (url.pathname === '/api/consult'");
  const end = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const consult = SRC.slice(start, end);
  assert.match(consult, /piece = String\(piece == null \? '' : piece\); if \(piece\) draft \+= piece/);
  assert.match(consult, /reply = await publishSafeFinal\(reply\)/);
  assert.doesNotMatch(consult, /sse\(\{\s*v:\s*(?:draft|revised|reply)\s*\}\)/);
  assert.match(consult, /answerStream = \{ mode: streamed\.mode/);
});

test('两套咨询客户端均累计多个 v 事件重渲染，非 consult 路径不接入终稿分块器', () => {
  assert.match(FIELD, /if \(o\.v != null\) \{[^}]*acc \+= o\.v/);
  assert.match(SUBMIT, /if\(o\.v\)\{ full\+=o\.v/);
  const consultStart = SRC.indexOf("if (url.pathname === '/api/consult'");
  const consultEnd = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", consultStart);
  assert.ok(consultStart >= 0 && consultEnd > consultStart);
  assert.match(SRC.slice(consultStart, consultEnd), /consultStreamFinalAnswer/);
  assert.doesNotMatch(SRC.slice(consultEnd), /consultStreamFinalAnswer|publishSafeFinal/);
});

test('安全终稿生成期间发送 SSE 注释心跳并在结束后停止', async () => {
  const writes = [];
  const handlers = {};
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    write(chunk) { writes.push(chunk); return true; },
    once(name, fn) { handlers[name] = fn; },
  };
  const stop = startConsultSseHeartbeat(fakeRes, { intervalMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 16));
  assert.ok(writes.length >= 2, `expected periodic heartbeats, got ${writes.length}`);
  assert.ok(writes.every(chunk => chunk === ': keepalive\n\n'));
  const beforeStop = writes.length;
  stop(); stop();
  await new Promise(resolve => setTimeout(resolve, 12));
  assert.equal(writes.length, beforeStop, 'stop 后不得继续写心跳');
  assert.equal(typeof handlers.close, 'function');
  assert.equal(typeof handlers.finish, 'function');

  const consultStart = SRC.indexOf("if (url.pathname === '/api/consult'");
  const consultEnd = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", consultStart);
  const consult = SRC.slice(consultStart, consultEnd);
  assert.match(consult, /res\.writeHead\([\s\S]*?startConsultSseHeartbeat\(res\)/);
  assert.match(consult, /sse\(\{ done: true[\s\S]*?stopSseHeartbeat\(\)[\s\S]*?res\.end\(\)/);
});

test('实施端正常 EOF 无正文时显示明确错误而不是空气泡', () => {
  assert.equal(consultCompletionText('', false), '（连接提前结束，AI 未返回可显示内容，请稍后重试。）');
  assert.equal(consultCompletionText('   ', false), '（连接提前结束，AI 未返回可显示内容，请稍后重试。）');
  assert.equal(consultCompletionText('', true), '（已停止）');
  assert.equal(consultCompletionText('已确认正文。', false), '已确认正文。');

  const finishStart = FIELD.indexOf('function finishConsult');
  const finishEnd = FIELD.indexOf('// AC-19-KB', finishStart);
  const finish = FIELD.slice(finishStart, finishEnd);
  assert.match(finish, /acc = consultCompletionText\(acc, aborted\)/);
  assert.match(FIELD, /未返回可显示内容\|没有覆盖/,
    '空流错误提示必须按非实质答复处理，不显示沉淀经验入口');
});
