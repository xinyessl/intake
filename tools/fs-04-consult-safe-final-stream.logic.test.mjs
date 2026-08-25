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

const progressStart = SRC.indexOf('function consultProgressEvent');
const progressEnd = SRC.indexOf('// 模型草稿必须先完整生成', progressStart);
assert.ok(progressStart >= 0 && progressEnd > progressStart);
const { consultProgressEvent, consultModelDeadlineSignal } = new Function(
  SRC.slice(progressStart, progressEnd) + '\nreturn { consultProgressEvent, consultModelDeadlineSignal };',
)();

const modelStreamStart = SRC.indexOf('const MODEL_STREAM_FIRST_TOKEN_TIMEOUT_MS');
const modelStreamEnd = SRC.indexOf('// ===== 项目登记', modelStreamStart);
assert.ok(modelStreamStart >= 0 && modelStreamEnd > modelStreamStart);
function modelStreamFactory(fetchImpl, candidates) {
  return new Function(
    'fetch',
    'modelCandidates',
    'withImages',
    'console',
    SRC.slice(modelStreamStart, modelStreamEnd) + '\nreturn { callModelStream, callModelStreamOnce };',
  )(
    fetchImpl,
    () => candidates,
    messages => messages,
    { warn() {} },
  );
}

const compactStart = SRC.indexOf('function consultHistoryMessages');
const compactEnd = SRC.indexOf('// 咨询会在服务端收齐草稿', compactStart);
assert.ok(compactStart >= 0 && compactEnd > compactStart);
const errorLogs = [];
const { consultHistoryMessages, compactConsultModelMessages, finishConsultSseError } = new Function(
  'crypto',
  'console',
  SRC.slice(compactStart, compactEnd) + '\nreturn { consultHistoryMessages, compactConsultModelMessages, finishConsultSseError };',
)(
  { randomBytes: () => ({ toString: () => 'generated-id' }) },
  { error: value => errorLogs.push(String(value)) },
);

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

test('等待安全终稿时阶段事件可见但与 v 正文严格分离', () => {
  assert.deepEqual(consultProgressEvent('preparing'), {
    type: 'progress', stage: 'preparing', label: '正在读取说明书与会话上下文…',
  });
  assert.deepEqual(consultProgressEvent('generating', { attempt: 2, total: 2 }), {
    type: 'progress', stage: 'generating', label: '首个模型未及时返回，正在尝试备用模型…', attempt: 2, total: 2,
  });
  assert.equal(consultProgressEvent('prompt-body'), null, '未知阶段不得把任意内部文案透给客户端');
  assert.equal(Object.prototype.hasOwnProperty.call(consultProgressEvent('auditing'), 'v'), false, 'progress 绝不能伪装正文');

  const consultStart = SRC.indexOf("if (url.pathname === '/api/consult'");
  const consultEnd = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", consultStart);
  const consult = SRC.slice(consultStart, consultEnd);
  assert.match(consult, /progress\('preparing'\)/);
  assert.match(consult, /progress\('auditing'\)/);
  assert.match(consult, /progress\('revising'/);
  assert.match(consult, /progress\('publishing'\)/);
  assert.doesNotMatch(consult, /reply\s*\+=?\s*consultProgressEvent|chat[^\n]*consultProgressEvent/,
    '阶段事件不得进入正式回答或会话持久化');

  assert.match(FIELD, /var phase = consultProgressLabel\(o\); if \(phase && !acc\) setThinking\(bub, true, phase\)/);
  assert.match(FIELD, /阶段事件只更新等待占位，不进入 acc\/chat/);
  assert.match(SUBMIT, /const phase=consultProgressLabel\(o\); if\(phase&&!full\)/);
  assert.doesNotMatch(SUBMIT, /full\+=phase|messages\.push\([^\n]*phase/);
});

test('模型无首字时按独立短预算终止并给出可观测错误', async () => {
  const cfg = { provider: 'openai', apiKey: 'test', baseUrl: 'https://model.test', model: 'test-model' };
  const fetchImpl = (_url, options) => new Promise((_resolve, reject) => {
    const hold = setInterval(() => {}, 1000);
    options.signal.addEventListener('abort', () => {
      clearInterval(hold);
      const error = new Error('aborted'); error.name = 'AbortError'; reject(error);
    }, { once: true });
  });
  const { callModelStreamOnce } = modelStreamFactory(fetchImpl, [cfg]);
  const started = Date.now();
  await assert.rejects(
    callModelStreamOnce(cfg, { system: '', messages: [{ role: 'user', content: 'Q0017' }], firstTokenTimeoutMs: 15, candidateTimeoutMs: 80 }, () => {}, null),
    /模型首字等待超时/,
  );
  assert.ok(Date.now() - started < 200, '专项首字预算不得退回旧 90 秒总超时');
});

test('模型候选最多尝试两个，正常首字后仍能完成流式正文', async () => {
  const candidates = Array.from({ length: 4 }, (_, index) => ({ provider: 'openai', apiKey: 'test', baseUrl: 'https://model.test', model: `m${index + 1}` }));
  let calls = 0;
  const emptyFetch = async () => {
    calls++;
    return { ok: true, body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode('data: [DONE]\n\n'); } } };
  };
  const empty = modelStreamFactory(emptyFetch, candidates);
  const attempts = [];
  await assert.rejects(
    empty.callModelStream({ apiKey: 'test' }, { system: '', messages: [], onAttempt: value => attempts.push(value) }, () => {}, null),
    /模型返回空内容/,
  );
  assert.equal(calls, 2);
  assert.deepEqual(attempts, [{ attempt: 1, total: 2 }, { attempt: 2, total: 2 }]);

  const normalFetch = async () => ({
    ok: true,
    body: { async *[Symbol.asyncIterator]() { yield new TextEncoder().encode('data: {"choices":[{"delta":{"content":"安全终稿"}}]}\n\ndata: [DONE]\n\n'); } },
  });
  const normal = modelStreamFactory(normalFetch, [candidates[0]]);
  const pieces = [];
  const answer = await normal.callModelStreamOnce(candidates[0], { system: '', messages: [], firstTokenTimeoutMs: 30, candidateTimeoutMs: 100 }, piece => pieces.push(piece), null);
  assert.equal(answer, '安全终稿');
  assert.deepEqual(pieces, ['安全终稿']);
});

test('consult 草稿与修订共享整轮完成上限，超时失败仍走安全正文和 done 收口', async () => {
  const deadline = consultModelDeadlineSignal(null, { timeoutMs: 15 });
  await new Promise(resolve => deadline.addEventListener('abort', resolve, { once: true }));
  assert.equal(deadline.aborted, true, '整轮 deadline 必须真实触发 abort');
  const userStop = new AbortController();
  const combined = consultModelDeadlineSignal(userStop.signal, { timeoutMs: 1000 });
  userStop.abort('user-stop');
  assert.equal(combined.aborted, true);
  assert.equal(combined.reason, 'user-stop', '用户停止原因必须优先透传');

  const consultStart = SRC.indexOf("if (url.pathname === '/api/consult'");
  const consultEnd = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", consultStart);
  const consult = SRC.slice(consultStart, consultEnd);
  assert.match(consult, /const consultModelSignal = consultModelDeadlineSignal\(ac\.signal\)/);
  assert.equal((consult.match(/\}, consultModelSignal\);/g) || []).length, 2, '草稿与最多一次修订必须共用同一 deadline');
  assert.match(consult, /else if \(firstError && !stopped\)[\s\S]*?publishSafeFinal\(m, \{ err: true, code: 'consult_model_error'/);
  assert.match(consult, /sse\(\{ done: true, convId, kbHits:[\s\S]*?stopSseHeartbeat\(\)[\s\S]*?res\.end\(\)/);
  assert.match(consult, /if \(ac\.signal\.aborted\) stopped = true;\s*else firstError = e;/,
    '用户停止必须优先于共享超时错误文案');
});

test('Q0010 长会话只压缩模型 payload，最近追问与 route 历史继续保留', () => {
  const raw = [];
  for (let round = 1; round <= 18; round++) {
    raw.push({ role: 'user', content: `第${round}轮医嘱标记问题：` + '问题'.repeat(900) });
    raw.push({ role: 'assistant', content: `第${round}轮已核回答：` + '回答'.repeat(1600) });
  }
  const currentQuestion = '我没完全听懂医嘱标记的排查建议，换成实施可以逐项照做的只读清单。' + '补充'.repeat(800);
  raw.push({ role: 'user', content: currentQuestion });

  const history = consultHistoryMessages(raw);
  const compact = compactConsultModelMessages(history);
  assert.equal(history.length, 24, '路由/持久化历史保持最近 24 条，连续 followup 有足够主题账本');
  assert.ok(compact.length <= 12, '模型上下文最多保留 12 条最近消息');
  assert.ok(compact.reduce((sum, message) => sum + message.content.length, 0) <= 16000, '模型历史正文受 16k 字符总预算约束');
  assert.equal(compact.at(-1).content, currentQuestion, '当前 Q0010 问句在既有 4000 字上限内必须逐字保留');
  assert.match(compact.at(-2).content, /第18轮已核回答/, '上一轮答复保留，支持“换成实施清单”的重述意图');

  const consultStart = SRC.indexOf("if (url.pathname === '/api/consult'");
  const consultEnd = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", consultStart);
  const consult = SRC.slice(consultStart, consultEnd);
  assert.match(consult, /const historyMsgs = consultHistoryMessages\(b\.messages\)/);
  assert.match(consult, /const msgs = compactConsultModelMessages\(historyMsgs\)/);
  assert.match(consult, /contextualRouteQuestion\(map, historyMsgs, qtext, sub\)/, 'route 继承使用较完整历史，不被模型 payload 裁剪削弱');
  assert.match(consult, /callModelStream\(cfg, \{ system: consultPrompt, messages: msgs/, '只有模型 payload 使用紧凑历史');
});

test('consult 未预期异常发送可见 err + terminal done，并记录请求阶段', () => {
  errorLogs.length = 0;
  const writes = [];
  const fakeRes = {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    writeHead(code, headers) { this.headersSent = true; this.code = code; this.headers = headers; },
    write(chunk) { writes.push(String(chunk)); return true; },
    end() { this.writableEnded = true; },
  };
  assert.equal(finishConsultSseError(fakeRes, new Error('audit exploded\nsecret body omitted'), { requestId: 'q0010-test', stage: 'answer_audit' }), true);
  assert.equal(fakeRes.code, 200);
  assert.match(fakeRes.headers['Content-Type'], /text\/event-stream/);
  const events = writes.map(chunk => JSON.parse(chunk.replace(/^data:\s*/, '').trim()));
  assert.equal(events.length, 2);
  assert.deepEqual(events[0], {
    err: true,
    code: 'consult_internal_error',
    requestId: 'q0010-test',
    stage: 'answer_audit',
    v: '（本次答疑处理异常，未能返回可发布内容，请稍后重试。错误编号：q0010-test。）',
  });
  assert.deepEqual(events[1], { done: true, error: true, requestId: 'q0010-test', stage: 'answer_audit' });
  assert.equal(fakeRes.writableEnded, true);
  assert.match(errorLogs[0], /\[consult-error\] request=q0010-test stage=answer_audit message=audit exploded secret body omitted/);

  const consultStart = SRC.indexOf("if (url.pathname === '/api/consult'");
  const consultEnd = SRC.indexOf("if (url.pathname === '/api/consult-to-intake'", consultStart);
  const consult = SRC.slice(consultStart, consultEnd);
  assert.match(consult, /void \(async \(\) => \{[\s\S]*?\}\)\(\)\.catch\(error => \{/,
    'readBody 的 async consult 处理必须由端点自身接住 Promise rejection');
  assert.match(consult, /stopSseHeartbeat\(\);[\s\S]*?finishConsultSseError\(res, error, \{ requestId: consultRequestId, stage: consultStage \}\)/);
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
