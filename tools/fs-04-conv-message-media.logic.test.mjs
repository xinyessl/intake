// FS-04 · 对话记录「消息级图片(per-message media)」· 脱库逻辑测试（2026-08-07 修 bug）
//   背景 bug：v2 确认清单流程里，用户在 intake-chat 某轮附的图，只在「确认建单(commit-plan)」时复制到了各工单，
//     会话记录(intake-conv)的消息 msg.media 全是 null → reopen 对话流时那张图不在它所在的用户消息位置（甚至不显/贴末尾）。
//   修法：
//     ① server intake-chat：本轮附图 → 存到「会话级」目录 media/<sessionId>/t<turnIndex>/img-N.png，挂到会话记录本轮 user 消息 msg.media；
//     ② server saveConvRecord→reconcileChatTs：每条消息保留 media（本轮传入带 media 用之；对齐到 prev 同条则沿用 prev.media，不弄丢历史轮图）；
//     ③ server intake-reply：续聊同步会话记录时保留每条消息 media（不再只 role/text/ts）；
//     ④ field renderConvTimeline：消息 media → mediaUrls 传给 appendBubble 第4参（不再传 []），老记录无 media 时记录级兜底。
//   本组：抽真实源码纯函数(reconcileChatTs)喂造数据断言 + 对关键接线做静态断言（能抓漂移/回归）。
//   连真库冒烟走 prod（见交付说明）；本组保证逻辑/接线不回归。
//   用法：node --test tools/fs-04-conv-message-media.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `应能找到 function ${name}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 大括号`);
  return src.slice(start, end + 1);
}
const reconcileChatTs = new Function(extractFn(SRC, 'reconcileChatTs') + '\nreturn reconcileChatTs;')();

/* ================= A. 后端接线：intake-chat 存图到会话记录消息 + saveConvRecord/intake-reply 保留 media ================= */
test('A1 intake-chat 本轮附图 → 存会话级目录 media/<sessionId>/t<turnIndex>/ 并挂到本轮 user 消息', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-chat'"), SRC.indexOf("url.pathname === '/api/intake-commit-plan'"));
  // 会话级目录（含 sessionId + t<下标>），避免与工单 media/<id>/ 目录撞
  assert.ok(/path\.join\(intakeDir\(proj\), 'media', sessionId, 't' \+ lastUserIdx\)/.test(seg), '存会话级目录 media/<sessionId>/t<turnIndex>/');
  assert.ok(/media\/\$\{sessionId\}\/t\$\{lastUserIdx\}\/img-\$\{i \+ 1\}\.png/.test(seg), '相对路径带 sessionId + t<下标>');
  // 挂到本轮（最后一条）user 消息
  assert.ok(/convChat\[i\]\.role === 'user'/.test(seg), '定位本轮 user 消息（最后一条 user）');
  assert.ok(/convChat\[lastUserIdx\]\.media = roundMedia/.test(seg), '本轮图挂到该 user 消息 msg.media');
  // 仅在有图 + 有 sessionId 时才存（无图/无会话不落空目录）
  assert.ok(/if \(imgs\.length && sessionId\) \{/.test(seg), '仅本轮有图 + 有 sessionId 才存图');
});
test('A2 saveConvRecord 经 reconcileChatTs 落库 chat，逐条保留 media', () => {
  assert.ok(/const timed = reconcileChatTs\(chatArr,/.test(SRC), 'saveConvRecord 调 reconcileChatTs');
  assert.ok(/chat: timed,/.test(SRC), '落库 chat 用 reconcile 后的 timed');
  // reconcileChatTs 里对 media 的处理落到源码（保留本轮 media / 对齐沿用 prev.media / 无图删键）
  const rc = extractFn(SRC, 'reconcileChatTs');
  assert.ok(/aligned && Array\.isArray\(p\.media\) && p\.media\.length\) rec\.media = p\.media\.slice\(\)/.test(rc), '对齐老消息沿用 prev.media（不弄丢历史轮图）');
  assert.ok(/delete rec\.media/.test(rc), '无图不落空 media 键');
});
test('A3 intake-reply 续聊同步会话记录时保留每条消息 media（不再只 role/text/ts）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-reply'"), SRC.indexOf("url.pathname === '/api/intake-chat'"));
  assert.ok(/if \(Array\.isArray\(m\.media\) && m\.media\.length\) c\.media = m\.media\.slice\(\)/.test(seg), 'intake-reply 同步会话记录保留消息 media');
  // 且 intake-reply 本身把本轮图挂到该 user 消息（Part B 已有）
  assert.ok(/if \(rRoundMedia\.length\) userMsg\.media = rRoundMedia\.slice\(\)/.test(seg), 'intake-reply 本轮图挂到 user 消息（Part B）');
});
test('A4 会话级 media 走现有 /api/intake-media（project+file）可取，且在 FIELD_OK', () => {
  const fieldOk = /const FIELD_OK = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  assert.ok(fieldOk && fieldOk[1].includes("'/api/intake-media'"), '/api/intake-media 在 FIELD_OK');
  // intake-media 防穿越用 startsWith(intakeDir + sep)——会话级路径在 intakeDir 下可取
  assert.ok(/file\.startsWith\(intakeDir\(proj\) \+ path\.sep\)/.test(SRC), 'intake-media 防穿越（会话级路径在 intakeDir 下仍可取）');
});

/* ================= B. 前端接线：renderConvTimeline 传 media（不再 []）+ reopenIntakeConv 带 media ================= */
test('B1 renderConvTimeline 把消息 media 转 URL 传 appendBubble 第4参（不再传 []）', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function renderConvTimeline'), FIELD_HTML.indexOf('function doKbSearch'));
  assert.ok(/mediaUrls\(proj0, x\.data\.media\)/.test(seg), 'renderConvTimeline 用 mediaUrls 转消息 media');
  assert.ok(/appendBubble\(x\.data\.role === 'user' \? 'me' : 'ai', x\.data\.content, false, urls\)/.test(seg), 'appendBubble 第4参传 urls（非 []）');
  // 明确不再传空数组
  assert.ok(!/appendBubble\(x\.data\.role === 'user' \? 'me' : 'ai', x\.data\.content, false, \[\]\)/.test(seg), '不再硬传 []');
});
test('B2 renderConvTimeline 老记录兜底：无任何消息级 media 时记录级 media 末尾兜底', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function renderConvTimeline'), FIELD_HTML.indexOf('function doKbSearch'));
  assert.ok(/if \(!anyMsgMedia && item && Array\.isArray\(item\.media\) && item\.media\.length\) appendMediaBubble/.test(seg), '老记录消息无 media → 记录级 media 末尾兜底');
});
test('B3 reopenIntakeConv 把每条消息 media 一路带到 msgs（不再丢）', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenIntakeConv'), FIELD_HTML.indexOf('function tsToMs'));
  assert.ok(/media: \(Array\.isArray\(m\.media\) \? m\.media : null\)/.test(seg), 'reopenIntakeConv map 保留消息 media');
  // filter 放行「有内容 或 有 media」的消息（纯图消息也不被过滤掉）
  assert.ok(/filter\(function \(m\) \{ return m\.content \|\| \(m\.media && m\.media\.length\); \}\)/.test(seg), 'filter 放行有 media 的消息');
});
test('B4 consult/intake reopen 的 per-message media 老逻辑未回归（AC-33）', () => {
  // reopenConsult / reopenIntake 仍保留 per-message media（mediaUrls + anyMsgMedia 兜底）
  const consultSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenConsult'), FIELD_HTML.indexOf('function reopenIntake'));
  assert.ok(/mediaUrls\(proj0, m\.media\)/.test(consultSeg) && /if \(!anyMsgMedia\) appendMediaBubble/.test(consultSeg), 'reopenConsult per-message media 未回归');
  const intakeSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenIntake('), FIELD_HTML.indexOf('function reopenConversation'));
  assert.ok(/mediaUrls\(proj0, m\.media\)/.test(intakeSeg) && /if \(!anyMsgMedia\) appendMediaBubble/.test(intakeSeg), 'reopenIntake per-message media 未回归');
});

/* ================= C. reconcileChatTs：media 保留/沿用/清理（喂真实源码函数） ================= */
test('C1 本轮传入带 media 的消息 → 保留其 media', () => {
  const out = reconcileChatTs([{ role: 'user', text: 'q', media: ['media/S/t0/img-1.png'] }, { role: 'assistant', text: 'a' }], []);
  assert.deepEqual(out[0].media, ['media/S/t0/img-1.png'], '本轮 user 消息 media 保留');
  assert.ok(!('media' in out[1]), 'assistant 无图不落 media 键');
});
test('C2 续轮整段 chat 不重传老 media → 对齐沿用 prev.media（历史轮图不丢）', () => {
  const prevChat = [
    { role: 'user', text: 'q1', ts: 1000, media: ['media/S/t0/img-1.png'] },
    { role: 'assistant', text: 'a1', ts: 2000 },
  ];
  // 续聊：整段传入不带老 media，只新增一轮
  const out = reconcileChatTs([
    { role: 'user', text: 'q1' },
    { role: 'assistant', text: 'a1' },
    { role: 'user', text: 'q2' },
  ], prevChat);
  assert.deepEqual(out[0].media, ['media/S/t0/img-1.png'], '对齐到 prev 同条 → 沿用历史轮 media（不弄丢）');
  assert.ok(!('media' in out[1]), '无图条不落 media 键');
  assert.ok(!('media' in out[2]), '新轮无图 → 无 media 键');
  assert.equal(out[0].ts, 1000, '沿用老 ts');
});
test('C3 本轮 media 覆盖优先于 prev（本轮就给这条挂了新图）', () => {
  const prevChat = [{ role: 'user', text: 'q1', ts: 1000, media: ['old.png'] }];
  const out = reconcileChatTs([{ role: 'user', text: 'q1', media: ['new1.png', 'new2.png'] }], prevChat);
  assert.deepEqual(out[0].media, ['new1.png', 'new2.png'], '本轮传入 media 优先（覆盖 prev）');
});
test('C4 全程无 media → 落库 chat 不含 media 键（记录干净、老数据兼容）', () => {
  const out = reconcileChatTs([{ role: 'user', text: 'q' }, { role: 'assistant', text: 'a' }], []);
  assert.ok(out.every(m => !('media' in m)), '无图时每条都不含 media 键');
});
test('C5 role 变/新增条不误沿用 prev.media（对齐仅按下标+role）', () => {
  const prevChat = [{ role: 'assistant', text: 'x', ts: 1000, media: ['a.png'] }];
  // 下标0 本轮是 user，与 prev[0] 的 assistant role 不同 → 不沿用其 media
  const out = reconcileChatTs([{ role: 'user', text: 'q' }], prevChat);
  assert.ok(!('media' in out[0]), 'role 不一致 → 不误沿用 prev.media');
});
