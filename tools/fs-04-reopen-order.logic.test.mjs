// FS-04 · 对话记录 reopen「消息 + 已建单卡按真实时序穿插」· 脱库逻辑测试（2026-08-07 修 bug）
//   背景 bug：重开一条对话记录，① 消息 ts 被整段盖同一 Date.now() → 无法按时序排；② reopen 时已建单卡一股脑贴末尾，不在「它被建出来的位置」。
//   修法：① server saveConvRecord→reconcileChatTs 保留每条消息各自 ts（老消息沿用 prev、新消息补递增）；
//        ② field.html mergeConvTimeline 把「消息(ts)」和「卡(submittedAt)」合并成按时间正序的渲染序列。
//   本组：从真实源码抽出两个纯函数（非重写副本，能抓漂移），喂造数据断言 + 老数据兜底。
//   用法：node --test tools/fs-04-reopen-order.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

// —— 抽具名函数体（配平大括号），沙箱 eval 真实源码 —— //
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

// 后端：reconcileChatTs（保留每条消息 ts）
const reconcileChatTs = new Function(extractFn(SRC, 'reconcileChatTs') + '\nreturn reconcileChatTs;')();
// 前端：tsToMs + mergeConvTimeline（合并时序序列）——mergeConvTimeline 依赖 tsToMs，一起注入
const tsToMsBody = extractFn(FIELD_HTML, 'tsToMs');
const mergeBody = extractFn(FIELD_HTML, 'mergeConvTimeline');
const mergeConvTimeline = new Function(tsToMsBody + '\n' + mergeBody + '\nreturn mergeConvTimeline;')();
const tsToMs = new Function(tsToMsBody + '\nreturn tsToMs;')();

/* ================= A. 静态接线断言（改法落到源码，防回归/漂移） ================= */
test('A1 saveConvRecord 用 reconcileChatTs 逐条对齐 ts（不再整段盖同一 Date.now）', () => {
  assert.ok(/const timed = reconcileChatTs\(chatArr,/.test(SRC), 'saveConvRecord 调 reconcileChatTs');
  assert.ok(/chat: timed,/.test(SRC), '落库 chat 用 reconcile 后的 timed（每条各自 ts）');
});
test('A2 intake-chat 不再整段盖同一 Date.now()（ts 交给 saveConvRecord）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-chat'"), SRC.indexOf("url.pathname === '/api/intake-commit-plan'"));
  assert.ok(/const convChat = allMsgs\.map\(x => \(\{ role: x\.role, text: x\.content \}\)\)/.test(seg), 'intake-chat convChat 不再逐条 ts:Date.now()');
  assert.ok(!/allMsgs\.map\(x => \(\{ role: x\.role, text: x\.content, ts: Date\.now\(\) \}\)\)/.test(seg), '旧的整段 Date.now() 写法已移除');
});
test('A3 reopenIntakeConv 走 renderConvTimeline 合并渲染（卡不再一股脑贴末尾）', () => {
  assert.ok(/renderConvTimeline\(msgs, built, it, item\)/.test(FIELD_HTML), 'reopenIntakeConv 调 renderConvTimeline');
  // 不再在 built.forEach 里直接 appendArchiveCard 贴末尾
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenIntakeConv'), FIELD_HTML.indexOf('function tsToMs'));
  assert.ok(!/built\.forEach\(function \(t\) \{ appendArchiveCard/.test(seg), 'reopenIntakeConv 内不再 built.forEach 贴末尾');
});

/* ================= B. reconcileChatTs：保留每条消息各自 ts ================= */
test('B1 首轮无 prev：三条消息 ts 各不相同且单调递增', () => {
  const out = reconcileChatTs([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }], []);
  assert.equal(out.length, 3);
  assert.ok(out[0].ts < out[1].ts && out[1].ts < out[2].ts, 'ts 单调递增（各不相同）');
});
test('B2 续轮：老消息 ts 被保留、只有新消息拿新 ts', () => {
  const prevChat = [{ role: 'user', text: 'a', ts: 1000 }, { role: 'assistant', text: 'b', ts: 2000 }];
  // 续聊：整段 chat = 老两条 + 新两条（前端不带 ts）
  const out = reconcileChatTs([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }, { role: 'user', text: 'c' }, { role: 'assistant', text: 'd' }], prevChat);
  assert.equal(out[0].ts, 1000, '老 user ts 保留');
  assert.equal(out[1].ts, 2000, '老 assistant ts 保留');
  assert.ok(out[2].ts > 2000, '新 user ts > 上一条');
  assert.ok(out[3].ts > out[2].ts, '新 assistant ts > 上一条');
});
test('B3 老消息文本被后端重建略变（media 回贴）仍按下标+role 沿用 ts', () => {
  const prevChat = [{ role: 'user', text: '原文', ts: 500 }, { role: 'assistant', text: '回复', ts: 600 }];
  const out = reconcileChatTs([{ role: 'user', text: '原文(改)' }, { role: 'assistant', text: '回复' }], prevChat);
  assert.equal(out[0].ts, 500, '下标+role 对齐 → 沿用老 ts（不因 text 变而丢）');
  assert.equal(out[1].ts, 600);
});
test('B4 prev 里 ts 意外乱序 → 输出仍单调不减（不产生倒序）', () => {
  const prevChat = [{ role: 'user', text: 'a', ts: 9000 }, { role: 'assistant', text: 'b', ts: 100 }];
  const out = reconcileChatTs([{ role: 'user', text: 'a' }, { role: 'assistant', text: 'b' }], prevChat);
  assert.ok(out[1].ts > out[0].ts, '第二条 ts 被抬到大于第一条（防倒序）');
});

/* ================= C. tsToMs：格式统一到毫秒 ================= */
test('C1 yyyy-MM-dd HH:mm 转毫秒', () => {
  const a = tsToMs('2026-08-07 14:30');
  const b = tsToMs('2026-08-07 14:31');
  assert.ok(a != null && b != null && b > a, '分钟差正确反映为毫秒差');
});
test('C2 毫秒数原样、不可解析返回 null', () => {
  assert.equal(tsToMs(1786070534640), 1786070534640);
  assert.equal(tsToMs(''), null);
  assert.equal(tsToMs('xxx'), null);
});

/* ================= D. mergeConvTimeline：消息 + 卡按时序穿插 ================= */
// 造：聊两轮(4 msg) → 建单A(在第2条后) → 再聊两轮(4 msg) → 建单B(在第6条后)
function ms(base, i) { return base + i * 60000; }   // 每条差 1 分钟
test('D1 卡插到「它被建出来的位置」，不再全堆末尾', () => {
  const T = 1786070000000;
  const msgs = [
    { role: 'user', content: 'q1', ts: ms(T, 0) },
    { role: 'assistant', content: 'a1', ts: ms(T, 1) },   // 单A 在此之后建
    { role: 'user', content: 'q2', ts: ms(T, 4) },
    { role: 'assistant', content: 'a2', ts: ms(T, 5) },   // 单B 在此之后建
  ];
  const cardA = { id: 'A', submittedAt: fmt(ms(T, 2)) };   // A 建在 a1 之后、q2 之前
  const cardB = { id: 'B', submittedAt: fmt(ms(T, 6)) };   // B 建在 a2 之后
  const seq = mergeConvTimeline(msgs, [cardA, cardB]);
  const shape = seq.map(x => x.kind === 'msg' ? x.data.content : ('#' + x.data.id));
  assert.deepEqual(shape, ['q1', 'a1', '#A', 'q2', 'a2', '#B'], '卡 A 在 a1 后、卡 B 在 a2 后（时序穿插）');
});
test('D2 同刻：卡排在同刻消息之后（卡是消息之后建的）', () => {
  const T = 1786070000000;
  const msgs = [{ role: 'user', content: 'q1', ts: T }, { role: 'assistant', content: 'a1', ts: T + 1000 }];
  const card = { id: 'A', submittedAt: fmt(T + 1000) };   // 与 a1 同刻（同一分钟）
  const seq = mergeConvTimeline(msgs, [card]);
  const shape = seq.map(x => x.kind === 'msg' ? x.data.content : ('#' + x.data.id));
  assert.deepEqual(shape, ['q1', 'a1', '#A'], '同刻卡排在消息之后');
});
test('D3 老数据兜底：消息 ts 全相同 → 卡按「≤该单 submittedAt 的最后一条消息」之后插', () => {
  const T = 1786070534640;   // 老数据：4 条消息 ts 全同
  const msgs = [
    { role: 'user', content: 'q1', ts: T },
    { role: 'assistant', content: 'a1', ts: T },
    { role: 'user', content: 'q2', ts: T },
    { role: 'assistant', content: 'a2', ts: T },
  ];
  // 卡 submittedAt 略晚于消息（同分钟或之后）→ 锚到最后一条 ≤ 它的消息之后（即末尾），不崩、不错插
  const card = { id: 'A', submittedAt: fmt(T + 60000) };
  const seq = mergeConvTimeline(msgs, [card]);
  const shape = seq.map(x => x.kind === 'msg' ? x.data.content : ('#' + x.data.id));
  // 消息保持原序，卡落在其后（时序无法精确穿插时的合理兜底）
  assert.deepEqual(shape, ['q1', 'a1', 'q2', 'a2', '#A'], '老数据兜底：消息原序 + 卡贴其后');
});
test('D4 卡 submittedAt 不可解析 → 贴末尾（不崩）', () => {
  const T = 1786070000000;
  const msgs = [{ role: 'user', content: 'q1', ts: T }, { role: 'assistant', content: 'a1', ts: T + 1000 }];
  const card = { id: 'A', submittedAt: '' };   // 无 submittedAt
  const seq = mergeConvTimeline(msgs, [card]);
  const last = seq[seq.length - 1];
  assert.equal(last.kind, 'card', '不可解析的卡贴末尾');
  assert.equal(seq.length, 3, '不丢元素');
});
test('D5 消息缺 ts（继承上一条）+ 卡穿插仍不倒序', () => {
  const T = 1786070000000;
  const msgs = [
    { role: 'user', content: 'q1', ts: T },
    { role: 'assistant', content: 'a1', ts: null },   // 缺 ts → 继承 T
    { role: 'user', content: 'q2', ts: T + 120000 },
  ];
  const card = { id: 'A', submittedAt: fmt(T + 60000) };   // 在 a1(=T) 之后、q2 之前
  const seq = mergeConvTimeline(msgs, [card]);
  const shape = seq.map(x => x.kind === 'msg' ? x.data.content : ('#' + x.data.id));
  assert.deepEqual(shape, ['q1', 'a1', '#A', 'q2'], '缺 ts 消息继承前文 ts，卡按时序插在 q2 前');
});
test('D6 无已建单卡（未建单会话）→ 纯消息原序', () => {
  const T = 1786070000000;
  const msgs = [{ role: 'user', content: 'q1', ts: T }, { role: 'assistant', content: 'a1', ts: T + 1000 }];
  const seq = mergeConvTimeline(msgs, []);
  assert.deepEqual(seq.map(x => x.data.content), ['q1', 'a1'], '无卡时纯消息原序');
});

// yyyy-MM-dd HH:mm（submittedAt 用 nowStamp 格式，只到分钟）
function fmt(msVal) {
  const d = new Date(msVal);
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
