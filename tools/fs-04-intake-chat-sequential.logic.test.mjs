// FS-04 · 顺序流建单不重复不合并 + N条=N单（2026-08-06）· 脱库逻辑测试
//   Bug1（顺序流上下文污染）：同一次聊天前一条需求已建单后再提新需求，AI 把新需求跟已建单旧需求合并/重复。
//     根因：intake-record 块建单后被 reply.replace(blockRe,'') 剥掉再回前端，历史里看不到"已归档" → 下一轮 AI 以为旧需求还在讨论。
//     主修（确定性）：前后端「已建单水位线 filedUpTo」——前端每次建单后把 filedUpTo 上移到 messages.length、发 intake-chat 带上；
//       后端按 filedUpTo 把 messages 切「已归档只读背景 archived vs 当前待处理 active」，只对 active 判建单、archived 折叠成只读背景说明。
//   Bug2（识别 N 条只建 1 张）：AI 拆出多条却只出一个 record 块。配合修：提示词强约束「N 条=N 个块，打包转开发只是话术」。
//   本组：① 抽 intakeChatSystem 真身（stub 纯展示依赖）验提示词强约束（N条N块 + 顺序流 + 有背景时的只读约束）；
//         ② 静态断言 intake-chat 端点按 filedUpTo 切 archived/active + 折叠背景 + 只喂 active 判建单 + 落库用 allMsgs（非折叠 msgs）；
//         ③ 复刻水位线切段逻辑喂造数据断言（边界：0/越界/不传）；④ 前端 field.html：chat.filedUpTo 状态 + 建单上移 + 发送带上 + save/restore/reset/reopen。
//   连真库 / 真模型多轮冒烟走 prod（见交付说明），本组只保证逻辑/接线不回归。
//   用法：node --test tools/fs-04-intake-chat-sequential.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

// —— 抽出具名函数体（测真实源码，非重写副本，能抓漂移） —— //
function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}
function makeIntakeChatSystem() {
  const body = extractFn(SRC, 'intakeChatSystem');
  const factory = new Function('specIndex', 'subsystemNames', `${body}; return intakeChatSystem;`);
  return factory(() => '', () => []);   // stub 掉纯展示依赖
}
const intakeChatSystem = makeIntakeChatSystem();
const proj = { id: 'p1', name: '测试产品', subsystems: [] };

/* ===== A. 提示词强约束（N条N块 + 顺序流 + 有背景时只读约束） ===== */
test('A1 N 条=N 个块硬约束（识别多条却只出一个块=漏建单 → 明令禁止）', () => {
  const sys = intakeChatSystem(proj, 'intake', 'v1', '', false);
  assert.match(sys, /N 条就.{0,4}N 个块|N 条 = N 个块/, '含「N 条=N 个块」硬约束');
  assert.match(sys, /少出一个块.*漏建单|漏建单.*错/, '明确「少出一个块=漏建单=错」');
  assert.match(sys, /打包转开发.*只是.*话术|话术.*不改变/, '「打包转开发」仅话术、不改变一条一块一单');
  assert.match(sys, /已齐的那条现在就出块|已齐.*出块/, '部分齐→已齐的先出块建单');
});
test('A2 顺序流「建单逐条独立·别重复别合并」通用纪律始终在', () => {
  const sys = intakeChatSystem(proj, 'intake', 'v1', '', false);
  assert.match(sys, /建单逐条独立/, '含逐条独立纪律');
  assert.match(sys, /已归档建单、已闭环/, '出过块即闭环');
});
test('A3 有已归档背景时 → 追加「只读·禁止再建/合并」约束；无背景不追加', () => {
  const withBg = intakeChatSystem(proj, 'intake', 'v1', '', true);
  const noBg = intakeChatSystem(proj, 'intake', 'v1', '', false);
  const noArg = intakeChatSystem(proj, 'intake', 'v1', '');   // 老调用（不传）也安全 = 无背景
  assert.match(withBg, /已建单归档.*只读.*禁止再建\/合并|只对「当前待处理」/, '有背景 → 只读禁再建约束');
  assert.match(withBg, /只对「当前待处理」这段.*判断/, '只对当前待处理段判建单');
  assert.doesNotMatch(noBg, /已建单归档背景 · 只读 · 禁止再建\/合并/, '无背景不追加只读段');
  assert.doesNotMatch(noArg, /已建单归档背景 · 只读 · 禁止再建\/合并/, '不传参=无背景，不追加');
});

/* ===== B. 端点：按 filedUpTo 切 archived/active + 折叠背景 + 落库用 allMsgs ===== */
const CHAT_SEG = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-chat'"), SRC.indexOf("url.pathname === '/api/consult'"));
test('B1 端点收 filedUpTo 并夹到 [0, allMsgs.length]（越界/不传→0，不回归）', () => {
  assert.match(CHAT_SEG, /const filedUpTo = Math\.min\(Math\.max\(0, parseInt\(b\.filedUpTo, 10\) \|\| 0\), allMsgs\.length\)/, '收 filedUpTo 并夹边界');
});
test('B2 按 filedUpTo 切 archived / active，active 仍限最近 24 轮', () => {
  assert.match(CHAT_SEG, /const archivedMsgs = allMsgs\.slice\(0, filedUpTo\)/, 'archived=前 filedUpTo 条');
  assert.match(CHAT_SEG, /const activeMsgs = allMsgs\.slice\(filedUpTo\)\.slice\(-24\)/, 'active=水位线之后·限 24 轮');
});
test('B3 archived 折叠成一条只读背景 + 只把 active 当待判断正文喂模型', () => {
  assert.match(CHAT_SEG, /const msgs = archivedMsgs\.length/, '有背景才折叠');
  assert.match(CHAT_SEG, /已建单归档·只读背景·禁止再为这些内容建单或合并进新需求/, '背景说明措辞');
  assert.match(CHAT_SEG, /\.\.\.activeMsgs/, '背景后接 active 原样多轮');
});
test('B4 intakeChatSystem 传 archivedMsgs.length>0（有背景才加只读约束段）', () => {
  assert.match(CHAT_SEG, /intakeChatSystem\(proj, type, version, sub, archivedMsgs\.length > 0\)/, '据是否有背景切换提示词');
});
test('B5 建单/会话记录落库用真实完整对话 allMsgs（非水位线折叠的 msgs）', () => {
  assert.match(CHAT_SEG, /const chatMsgs = allMsgs\.map\(x => \(\{ role: x\.role, text: x\.content/, '工单 chat 存 allMsgs');
  assert.match(CHAT_SEG, /const convChat = allMsgs\.map\(x => \(\{ role: x\.role, text: x\.content/, '会话记录 chat 存 allMsgs');
});
test('B6 不破坏：多块建单 + 剥块 + sessionId + 会话记录 upsert 仍在', () => {
  assert.match(CHAT_SEG, /const blockRe = \/```intake-record/, '多块解析仍在（AC-11/12）');
  assert.match(CHAT_SEG, /reply = \(reply \|\| ''\)\.replace\(blockRe, ''\)/, '剥块逻辑仍在');
  assert.match(CHAT_SEG, /media, sessionId, status: '待处理'/, '建单对象带 sessionId');
  assert.match(CHAT_SEG, /await saveConvRecord\(proj, \{ sessionId/, '会话记录 upsert 仍在（AC-36）');
});

/* ===== C. 复刻水位线切段逻辑，喂造数据断言（确定性防污染 + 边界） ===== */
// 忠实复刻端点切段规则（与源码同）：给 allMsgs + filedUpTo → {archived, active, foldedFirstIsBg}
function splitByWatermark(allMsgs, filedUpToRaw) {
  const filedUpTo = Math.min(Math.max(0, parseInt(filedUpToRaw, 10) || 0), allMsgs.length);
  const archivedMsgs = allMsgs.slice(0, filedUpTo);
  const activeMsgs = allMsgs.slice(filedUpTo).slice(-24);
  const msgs = archivedMsgs.length
    ? [{ role: 'user', content: '【已建单归档·只读背景…】' + archivedMsgs.map(m => m.content).join('\n') }, ...activeMsgs]
    : activeMsgs;
  return { filedUpTo, archivedMsgs, activeMsgs, msgs };
}
const mk = (r, c) => ({ role: r, content: c });

test('C1 filedUpTo=2：前两条=背景折叠成 1 条只读、后续=active 原样（新需求只在 active 里被判）', () => {
  const all = [mk('user', '忽略比对需求'), mk('assistant', '好的，已建单'), mk('user', '厂家字段自动匹配')];
  const { archivedMsgs, activeMsgs, msgs } = splitByWatermark(all, 2);
  assert.equal(archivedMsgs.length, 2, '前两条进背景');
  assert.equal(activeMsgs.length, 1, '第三条（新需求）在 active');
  assert.equal(msgs.length, 2, '喂模型=1 条背景折叠 + 1 条 active');
  assert.match(msgs[0].content, /只读背景/, '首条是折叠背景');
  assert.equal(msgs[1].content, '厂家字段自动匹配', 'active 原样带新需求');
  assert.doesNotMatch(msgs[1].content, /忽略比对/, '新需求这条不含旧需求内容（不串）');
});
test('C2 filedUpTo=0（会话开头/老前端不传）→ 无背景、active=全量，行为同现状', () => {
  const all = [mk('user', 'A'), mk('assistant', 'a'), mk('user', 'B')];
  const s0 = splitByWatermark(all, 0);
  assert.equal(s0.archivedMsgs.length, 0, '无背景');
  assert.deepEqual(s0.msgs.map(m => m.content), ['A', 'a', 'B'], 'msgs=全量 active（不折叠）');
  const sUndef = splitByWatermark(all, undefined);
  assert.equal(sUndef.filedUpTo, 0, '不传 filedUpTo → 0');
  assert.deepEqual(sUndef.msgs.map(m => m.content), ['A', 'a', 'B'], '不传=全量，退化为现状不回归');
});
test('C3 filedUpTo 越界（超长/负数/非数字）→ 夹到 [0, len]，不崩', () => {
  const all = [mk('user', 'A'), mk('assistant', 'a')];
  assert.equal(splitByWatermark(all, 999).filedUpTo, 2, '超长 → 夹到 len（全背景、active 空）');
  assert.equal(splitByWatermark(all, 999).activeMsgs.length, 0, '全背景时 active 空');
  assert.equal(splitByWatermark(all, -5).filedUpTo, 0, '负数 → 0');
  assert.equal(splitByWatermark(all, 'x').filedUpTo, 0, '非数字 → 0');
});
test('C4 顺序流关键：A 建单后水位线上移，B 那轮 active 里没有 A → AI 不会翻出 A', () => {
  // 模拟：轮1(A)建单 → filedUpTo=2；轮2 用户提 B
  const all = [mk('user', '需求A：忽略比对'), mk('assistant', '已为你建单A'), mk('user', '需求B：厂家自动匹配，和A无关')];
  const { activeMsgs } = splitByWatermark(all, 2);
  const activeText = activeMsgs.map(m => m.content).join('\n');
  assert.match(activeText, /需求B/, 'active 含 B');
  assert.doesNotMatch(activeText, /需求A|忽略比对/, 'active 完全不含 A（确定性隔离，AI 无从翻出）');
});

/* ===== D. 前端 field.html 接线：filedUpTo 状态 + 建单上移 + 发送带上 + save/restore/reset/reopen ===== */
test('D1 chat.filedUpTo 初始态存在', () => {
  assert.match(FIELD_HTML, /filedUpTo: 0,/, 'chat 初始 filedUpTo=0');
});
test('D2 sendIntake body 带 filedUpTo', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendIntake'), FIELD_HTML.indexOf('function sendIntakeReply'));
  assert.match(seg, /filedUpTo: chat\.filedUpTo \|\| 0/, 'sendIntake 发 filedUpTo');
  // 本轮建了单 → 水位线上移到当前 messages.length（即便已 savedId 也上移）
  assert.match(seg, /if \(tickets\.length\) chat\.filedUpTo = chat\.messages\.length/, '建单后水位线上移到 messages 末尾');
  // 顺序流：先建 A、隔轮再建 B（已 savedId）也补卡
  assert.match(seg, /else if \(tickets\.length && chat\.savedId\)/, '已 savedId 但本轮又建单（B）→ 补卡分支');
});
test('D3 filedUpTo 随草稿/快照 save & restore（夹边界）', () => {
  assert.match(FIELD_HTML, /filedUpTo: chat\.filedUpTo \|\| 0,\s+\/\/ FS-04 已建单水位线随会话快照/, 'snapshot 存 filedUpTo');
  assert.match(FIELD_HTML, /chat\.filedUpTo = Math\.min\(Math\.max\(0, snap\.filedUpTo \| 0\), chat\.messages\.length\)/, 'restoreConversation 恢复+夹边界');
  assert.match(FIELD_HTML, /filedUpTo: chat\.filedUpTo \|\| 0, convId:/, 'saveDraft 存 filedUpTo');
  assert.match(FIELD_HTML, /chat\.filedUpTo = Math\.min\(Math\.max\(0, d\.filedUpTo \| 0\), chat\.messages\.length\)/, 'restoreDraft 恢复+夹边界');
});
test('D4 newConversation 归零 filedUpTo', () => {
  assert.match(FIELD_HTML, /chat\.savedId = ''; chat\.filedUpTo = 0;/, 'newConversation 重置 filedUpTo=0');
});
test('D5 reopenIntakeConv：已建单会话设 filedUpTo=messages.length、未建单设 0', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenIntakeConv'), FIELD_HTML.indexOf('function reopenIntakeConv') + 2400);
  assert.match(seg, /chat\.filedUpTo = chat\.messages\.length;\s+\/\/ FS-04：已建单会话 reopen/, '已建单会话 reopen → 满水位线');
  assert.match(seg, /chat\.filedUpTo = 0;\s+\/\/ FS-04：未建单会话 reopen/, '未建单会话 reopen → 水位线 0');
});
