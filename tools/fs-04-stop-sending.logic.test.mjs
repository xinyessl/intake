// FS-04（2026-08-06）· 现场端 AI 对话「停止」功能 · 脱库逻辑测试
//   背景：AI「正在思考中…」/流式生成时用户无法中断。现加 AbortController，发送中把「发送」按钮切「停止」态，
//     点停止 → abort 本轮请求；三条发送路径（consult SSE / intake-chat / intake-reply）都带 signal。
//     中断按「用户主动停止」处理：清动效、保留已生成部分（consult）或显「（已停止）」、不弹网络错误 toast/不走人工兜底。
//   停止是纯前端交互，无库参与 → 本组走「静态断言 field.html 接线」+「复刻状态机逻辑」（可抓漂移/回归）。
//   连真库/真 UI 冒烟走 prod（见交付说明）。
//   用法：node --test tools/fs-04-stop-sending.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

/* ================= A. 前端接线（AbortController / 停止态按钮 / 三路径 signal） ================= */

test('A1 chat 有 abortCtrl 状态 + sendChat 发送前创建 AbortController', () => {
  assert.ok(/abortCtrl: null,/.test(FIELD_HTML), 'chat 初始有 abortCtrl');
  assert.ok(/chat\.abortCtrl = new AbortController\(\);/.test(FIELD_HTML), 'sendChat 发送前 new AbortController()');
});

test('A2 三条发送路径都带 signal', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendIntake'), FIELD_HTML.indexOf('function guardConsultSubsystem'));
  // sendIntake（intake-chat）+ sendIntakeReply（intake-reply）走 api()，各带 signal
  const chatSeg = seg.slice(0, seg.indexOf('function sendIntakeReply'));
  const replySeg = seg.slice(seg.indexOf('function sendIntakeReply'));
  assert.ok(/signal: chat\.abortCtrl && chat\.abortCtrl\.signal,/.test(chatSeg), 'sendIntake api() 带 signal');
  assert.ok(/signal: chat\.abortCtrl && chat\.abortCtrl\.signal,/.test(replySeg), 'sendIntakeReply api() 带 signal');
  // sendConsult 原生 fetch 带 signal
  const consultSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendConsult'), FIELD_HTML.indexOf('function parseSSEChunk'));
  assert.ok(/body: JSON\.stringify\(payload\), signal: chat\.abortCtrl && chat\.abortCtrl\.signal/.test(consultSeg), 'sendConsult fetch 带 signal');
});

test('A3 api() 助手透传 opts（含 signal 到 fetch）', () => {
  // api = fetch(path, Object.assign({headers}, opts))：Object.assign 把 opts.signal 合并进 fetch init
  assert.ok(/var api = function \(path, opts\) \{\s*return fetch\(path, Object\.assign\(\{ headers/.test(FIELD_HTML), 'api() 用 Object.assign 合并 opts → signal 自动透传');
});

test('A4 停止态按钮：setSending(true) 切「停止」+ ti-player-stop + .stop，可点', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function setSending'), FIELD_HTML.indexOf('function stopSending'));
  assert.ok(/btn\.disabled = false;/.test(seg), '停止态按钮不置灰死（可点）');
  assert.ok(/btn\.classList\.add\('stop'\);/.test(seg), '停止态加 .stop 类');
  assert.ok(/ti-player-stop/.test(seg) && /停止/.test(seg), '停止态换图标 ti-player-stop + 文案「停止」');
  assert.ok(/btn\.classList\.remove\('stop'\)/.test(seg) && /ti-send/.test(seg), 'setSending(false) 切回「发送」态');
});

test('A5 停止态 CSS（.send.stop 红色）', () => {
  assert.ok(/\.f-chat-f \.send\.stop \{ background: #e5484d; \}/.test(FIELD_HTML), '.send.stop 红色底');
});

test('A6 stopSending / isAbort 存在 + 挂 window.__field', () => {
  assert.ok(/function stopSending\(\) \{/.test(FIELD_HTML), '有 stopSending');
  assert.ok(/function isAbort\(e\)/.test(FIELD_HTML), '有 isAbort（区分主动停止 vs 真错误）');
  assert.ok(/stopSending: stopSending,/.test(FIELD_HTML), 'stopSending 挂 window.__field');
});

test('A7 发送按钮点击分派：发送中点=停止，空闲点=发送', () => {
  assert.ok(/if \(chat\.sending\) stopSending\(\); else sendChat\(\);/.test(FIELD_HTML), '按钮点击：sending→停止，否则发送');
});

test('A8 三路径 catch 区分 AbortError（主动停止不弹网络错误 / 不走兜底）', () => {
  // intake-chat：aborted 显「（已停止）」+ return（不走 offerFallback）
  const chatSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendIntake'), FIELD_HTML.indexOf('function sendIntakeReply'));
  assert.ok(/var aborted = isAbort\(e\);/.test(chatSeg), 'sendIntake catch 判 isAbort');
  assert.ok(/if \(aborted\) \{[\s\S]*?（已停止）[\s\S]*?return;/.test(chatSeg), 'sendIntake aborted 显（已停止）+ return（不 offerFallback）');
  // intake-reply
  const replySeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendIntakeReply'), FIELD_HTML.indexOf('function guardConsultSubsystem'));
  assert.ok(/var aborted = isAbort\(e\);/.test(replySeg) && /（已停止）/.test(replySeg), 'sendIntakeReply aborted 显（已停止）');
  // consult：abort 保留 acc + 尾部（已停止），非 abort 才显连不上
  const consultSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendConsult'), FIELD_HTML.indexOf('function parseSSEChunk'));
  assert.ok(/if \(isAbort\(e\)\) finishConsult\(bub, acc \? \(acc \+ '\\n\\n（已停止）'\) : '（已停止）', true, usedKb\)/.test(consultSeg), 'consult abort 保留已生成 acc + 尾部（已停止），传 aborted=true 并保留已使用引用');
  assert.ok(/else finishConsult\(bub, acc \|\| '（AI 暂时连不上/.test(consultSeg), 'consult 真错误才显「连不上」');
});

test('A9 收尾统一复位 abortCtrl（三路径 + finishConsult）', () => {
  const chatSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendIntake'), FIELD_HTML.indexOf('function guardConsultSubsystem'));
  const chatResets = (chatSeg.match(/chat\.abortCtrl = null;/g) || []).length;
  assert.ok(chatResets >= 4, 'sendIntake/sendIntakeReply 的 then+catch 各复位 abortCtrl（≥4 处）');
  const finishSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function finishConsult'), FIELD_HTML.indexOf('function finishConsult') + 900);
  assert.ok(/chat\.abortCtrl = null;/.test(finishSeg), 'finishConsult 收尾复位 abortCtrl');
});

test('A10 finishConsult(aborted) 主动停止不追加 KB/转工单入口', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function finishConsult'), FIELD_HTML.indexOf('function finishConsult') + 1200);
  assert.ok(/function finishConsult\(bub, acc, aborted, kbRefs\)/.test(seg), 'finishConsult 保留 aborted 参数并接收本轮引用');
  assert.ok(/if \(aborted\) \{ scrollChatBottom\(\); saveDraft\(\); return; \}/.test(seg), 'aborted → 保留内容 + 存草稿 + return（不追加 appendKbSink/appendConsultToIntake）');
});

test('A11 切新对话/切系统在发送中 → abort 旧请求', () => {
  const newConvSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function newConversation'), FIELD_HTML.indexOf('function newConversation') + 700);
  assert.ok(/if \(chat\.sending && chat\.abortCtrl\) \{ try \{ chat\.abortCtrl\.abort\(\); \} catch/.test(newConvSeg), 'newConversation 发送中 abort 旧请求');
  const restoreSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function restoreConversation'), FIELD_HTML.indexOf('function syncConversationToSystem'));
  assert.ok(/if \(chat\.sending && chat\.abortCtrl\) \{ try \{ chat\.abortCtrl\.abort\(\); \} catch/.test(restoreSeg), 'restoreConversation（切系统）发送中 abort 旧请求');
});

/* ================= B. 复刻状态机逻辑（isAbort 判定 / setSending 按钮态 / 收尾复位） ================= */

// 复刻 field.html 的 isAbort（区分「用户主动停止」vs「真错误」）
function makeIsAbort(chat) {
  return function isAbort(e) {
    return !!(e && (e.name === 'AbortError' || (chat.abortCtrl && chat.abortCtrl.signal && chat.abortCtrl.signal.aborted)));
  };
}
// 复刻 setSending 的按钮态（用一个假 btn 对象记录 class/text/disabled）
function makeSetSending(chat, btn) {
  return function setSending(on) {
    chat.sending = on;
    if (on) { btn.disabled = false; btn.classes.add('stop'); btn.text = '停止'; }
    else { btn.disabled = false; btn.classes.delete('stop'); btn.text = '发送'; }
  };
}

test('B1 isAbort：AbortError → true；普通错误 → false', () => {
  const chat = { abortCtrl: null };
  const isAbort = makeIsAbort(chat);
  const abortErr = new DOMException('The operation was aborted', 'AbortError');
  assert.equal(isAbort(abortErr), true, 'AbortError → 主动停止');
  assert.equal(isAbort(new TypeError('Failed to fetch')), false, '网络错误 → 非主动停止（应弹错误/走兜底）');
  assert.equal(isAbort(null), false, '空错误 → false');
});

test('B2 isAbort：signal.aborted 兜底也判为停止（即便 err.name 非 AbortError）', () => {
  const ac = new AbortController();
  ac.abort();
  const chat = { abortCtrl: ac };
  const isAbort = makeIsAbort(chat);
  // 某些环境 err.name 可能不同，但 signal.aborted=true → 仍判停止
  assert.equal(isAbort(new Error('boom')), true, 'signal.aborted → 兜底判为停止');
});

test('B3 setSending：发送态可点+停止态，结束切回发送态', () => {
  const chat = { sending: false };
  const btn = { disabled: false, text: '发送', classes: new Set() };
  const setSending = makeSetSending(chat, btn);
  setSending(true);
  assert.equal(chat.sending, true);
  assert.equal(btn.disabled, false, '停止态可点（非置灰死）');
  assert.ok(btn.classes.has('stop'), '停止态加 .stop');
  assert.equal(btn.text, '停止');
  setSending(false);
  assert.equal(chat.sending, false);
  assert.ok(!btn.classes.has('stop'), '结束去 .stop');
  assert.equal(btn.text, '发送', '切回发送态');
});

test('B4 停止流程：点停止 → abort → signal.aborted → isAbort=true → 收尾复位', () => {
  const chat = { sending: false, abortCtrl: null };
  const btn = { disabled: false, text: '发送', classes: new Set() };
  const setSending = makeSetSending(chat, btn);
  const isAbort = makeIsAbort(chat);
  // 发送开始
  chat.abortCtrl = new AbortController();
  setSending(true);
  const signal = chat.abortCtrl.signal;
  // 用户点停止（stopSending）
  chat.abortCtrl.abort();
  assert.equal(signal.aborted, true, 'abort() 后 signal.aborted=true');
  // fetch 抛 AbortError → catch 判定
  const err = new DOMException('aborted', 'AbortError');
  assert.equal(isAbort(err), true, 'catch 判为主动停止');
  // 收尾统一复位
  chat.abortCtrl = null;
  setSending(false);
  assert.equal(chat.sending, false, '发送态复位（可重新发）');
  assert.equal(chat.abortCtrl, null, 'abortCtrl 复位为 null');
  assert.equal(btn.text, '发送', '按钮切回发送');
});

test('B5 空闲态点按钮 = 发送（不误停）；stopSending 仅发送中生效', () => {
  const chat = { sending: false, abortCtrl: null };
  let aborted = false;
  const stopSending = () => { if (!chat.sending) return; if (chat.abortCtrl) { aborted = true; } };
  // 空闲态调 stopSending → no-op（防止空闲误触发 abort）
  stopSending();
  assert.equal(aborted, false, '空闲态 stopSending no-op');
  // 发送中调 stopSending → abort
  chat.sending = true; chat.abortCtrl = new AbortController();
  stopSending();
  assert.equal(aborted, true, '发送中 stopSending 触发 abort');
});
