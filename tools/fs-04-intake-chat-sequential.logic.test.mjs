// FS-04 v2 · 建单前「确认清单」（2026-08-07）· 脱库逻辑测试
//   治本：把「对话 → 几张工单」从"靠 AI 自觉出对的块 + 续聊无脑追加"改成 **AI 先出结构化计划（intake-plan）→ 用户确认/编辑 → 系统按清单确定性建单/补充**。
//   ① intake-chat：AI 出 intake-plan（不再直接建单），服务端 parseIntakePlan → 回 plan.items 给前端确认卡；
//   ② intake-commit-plan（新端点）：按用户拍板的清单确定性建单（action=new 逐条建、append 追加到已建单，按 sites 收敛）；
//   ③ 续聊已建单会话也走 intake-chat（plan 流），builtTickets 上送让 AI 判 append/new（默认 new，不再无脑追加）；
//   ④ 保留水位线 filedUpTo 切段（已建单只读背景，不污染当前待处理段）+ 会话记录 upsert（AC-36）不变。
//   本组：抽 intakeChatSystem/parseIntakePlan 真身验证 + intake-chat/commit-plan 端点静态断言 + 前端 field.html 确认卡接线。
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
// parseIntakePlan 依赖 normPriority + PLAN_BLOCK_RE + PRIORITY_SET（同 server.mjs）——一并注入真身。
function makeParseIntakePlan() {
  const PLAN = extractFn(SRC, 'parseIntakePlan');
  const NORM = extractFn(SRC, 'normPriority');
  const reLine = /const PLAN_BLOCK_RE = \/```intake-plan\\s\*\(\[\\s\\S\]\*\?\)```\/g;/;
  assert.ok(reLine.test(SRC), '应能在 server.mjs 找到 PLAN_BLOCK_RE 定义');
  const factory = new Function(`
    const PRIORITY_SET = new Set(['紧急','高','中','低']);
    ${NORM}
    const PLAN_BLOCK_RE = /\`\`\`intake-plan\\s*([\\s\\S]*?)\`\`\`/g;
    ${PLAN}
    return parseIntakePlan;
  `);
  return factory();
}
const intakeChatSystem = makeIntakeChatSystem();
const parseIntakePlan = makeParseIntakePlan();
const proj = { id: 'p1', name: '测试产品', subsystems: [] };
const fence = '```';   // 避免在源码里嵌套三反引号导致解析歧义

/* ===== A. 提示词：AI 出 intake-plan 计划块（不再直接建单），一条独立需求=一个 item·绝不合并 ===== */
test('A1 提示词让 AI 出 intake-plan 计划块 + 一条独立需求=一个 item·绝不合并（硬约束）', () => {
  const sys = intakeChatSystem(proj, 'intake', 'v1', '', false, []);
  assert.match(sys, /intake-plan/, '含 intake-plan 计划块指令');
  assert.match(sys, /"items"/, 'plan 块结构含 items 数组');
  assert.match(sys, /一条独立需求 = 一个 item|一条独立.*一个 item/, '一条独立需求=一个 item');
  assert.match(sys, /绝不.*揉进一个 item|绝不合并|绝不.*把多条揉/, '绝不把多条揉进一个 item');
  assert.match(sys, /少一个 item.*漏建单|漏建单.*错/, '少一个 item=漏建单=错');
  assert.match(sys, /summary/, '每 item 必填 summary（确认卡展示）');
});
test('A2 提示词强调「建单要等用户确认、此刻还没建」（AI 别自称已建）', () => {
  const sys = intakeChatSystem(proj, 'intake', 'v1', '', false, []);
  assert.match(sys, /建单要等用户.*确认|等用户在确认卡上点确认/, '建单要等用户确认');
  assert.match(sys, /此刻还没建|别在正文里说.*已经建好|已提交/, 'AI 别自称已建单');
});
test('A3 有已建单清单 builtTickets → 提示词让 AI 对「补充某已建单」用 action=append、默认 new', () => {
  const withBuilt = intakeChatSystem(proj, 'intake', 'v1', '', false, [{ ticketId: 'XQ-1', title: '导出功能' }]);
  const noBuilt = intakeChatSystem(proj, 'intake', 'v1', '', false, []);
  assert.match(withBuilt, /XQ-1/, '把已建单清单列进提示词');
  assert.match(withBuilt, /action.*append|"action":"append"/, '有已建单→引导 append');
  assert.match(withBuilt, /默认倾向 new|默认.*new/, '默认倾向 new（宁可改成 append，别默认合并）');
  assert.match(noBuilt, /都用.*action.*new|还没建过任何单/, '无已建单→全 new');
});
test('A4 有已归档背景（水位线）时 → 追加「已建单归档背景·只读」段；无背景不追加', () => {
  const withBg = intakeChatSystem(proj, 'intake', 'v1', '', true, []);
  const noBg = intakeChatSystem(proj, 'intake', 'v1', '', false, []);
  const noArg = intakeChatSystem(proj, 'intake', 'v1', '');   // 老调用（不传 hasArchivedBg/builtTickets）也安全 = 无背景
  assert.match(withBg, /已建单归档背景 · 只读|只对「当前待处理」/, '有背景 → 只读背景段');
  assert.doesNotMatch(noBg, /已建单归档背景 · 只读/, '无背景不追加只读段');
  assert.doesNotMatch(noArg, /已建单归档背景 · 只读/, '不传参=无背景，不追加');
});

/* ===== B. parseIntakePlan：解析 intake-plan 块 → 归一化 items + 剔块可见正文 ===== */
test('B1 解析多条 item（一条一 item，绝不合并）+ 归一化 action/type/priority', () => {
  const reply = '好的，我识别到两条：\n' + fence + 'intake-plan\n' +
    JSON.stringify({ items: [
      { action: 'new', type: 'requirement', title: '增加手动忽略', summary: '比对加忽略按钮', priority: '高' },
      { action: 'new', type: 'bug', title: '厂家字段自动赋值', summary: '自动检索厂家' }
    ] }) + '\n' + fence;
  const { items, visible } = parseIntakePlan(reply, '');   // 合并模式（forceType 空，取 AI 判的 type）
  assert.equal(items.length, 2, '两条 item（不合并）');
  assert.equal(items[0].type, 'requirement'); assert.equal(items[0].priority, '高');
  assert.equal(items[1].type, 'bug', '第二条按 AI 判为 bug');
  assert.equal(items[0].action, 'new');
  assert.equal(visible.indexOf('intake-plan'), -1, '可见正文剔除计划块');
  assert.match(visible, /识别到两条/, '保留 AI 的可见文字');
});
test('B2 append item 保留 ticketId；new item ticketId 清空', () => {
  const reply = fence + 'intake-plan\n' + JSON.stringify({ items: [
    { action: 'append', ticketId: 'XQ-20260807-01', title: '补充筛选', summary: '再加个日期筛选' },
    { action: 'new', ticketId: '应被清空', title: '新需求', summary: '不相关的新东西' }
  ] }) + '\n' + fence;
  const { items } = parseIntakePlan(reply, '');
  assert.equal(items[0].action, 'append'); assert.equal(items[0].ticketId, 'XQ-20260807-01', 'append 保留 ticketId');
  assert.equal(items[1].action, 'new'); assert.equal(items[1].ticketId, '', 'new item ticketId 清空');
});
test('B3 forceType 强制类型（非合并模式）+ 无标题 item 丢弃（不建脏单）', () => {
  const reply = fence + 'intake-plan\n' + JSON.stringify({ items: [
    { action: 'new', type: 'requirement', title: '有标题', summary: 'ok' },
    { action: 'new', type: 'requirement', title: '   ', summary: '空标题应丢' }
  ] }) + '\n' + fence;
  const { items } = parseIntakePlan(reply, 'bug');
  assert.equal(items.length, 1, '无标题 item 丢弃');
  assert.equal(items[0].type, 'bug', 'forceType 强制为 bug');
});
test('B4 非法/坏块 → items 空、visible=原文（不崩、不建脏单）', () => {
  assert.deepEqual(parseIntakePlan('普通对话没有计划块', '').items, [], '无块→空');
  const bad = fence + 'intake-plan\n{坏 JSON}\n' + fence;
  assert.deepEqual(parseIntakePlan(bad, '').items, [], '坏 JSON→空（不崩）');
  assert.equal(parseIntakePlan(bad, '').visible.indexOf('intake-plan'), -1, '坏块也剔除');
});
test('B5 只认第一个含 items 的 plan 块（提示词只让出一个）', () => {
  const reply = fence + 'intake-plan\n' + JSON.stringify({ items: [{ action: 'new', title: 'A', summary: 'a' }] }) + '\n' + fence +
    '\n' + fence + 'intake-plan\n' + JSON.stringify({ items: [{ action: 'new', title: 'B', summary: 'b' }] }) + '\n' + fence;
  const { items } = parseIntakePlan(reply, '');
  assert.equal(items.length, 1, '只取第一个 plan 块');
  assert.equal(items[0].title, 'A');
});

/* ===== C. intake-chat 端点：AI 不再直接建单，解析 plan 回给前端；保留水位线 + 会话记录 ===== */
const CHAT_SEG = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-chat'"), SRC.indexOf("url.pathname === '/api/intake-commit-plan'"));
test('C1 intake-chat 调 parseIntakePlan、回 plan.items、savedId/savedIds 恒空（不自动建单）', () => {
  assert.match(CHAT_SEG, /const parsed = parseIntakePlan\(reply,/, '调 parseIntakePlan');
  assert.match(CHAT_SEG, /plan: \{ items: planItems/, '回 plan.items 给前端确认卡');
  assert.match(CHAT_SEG, /savedId: '', priority: '', savedIds: \[\]/, 'savedId/savedIds 恒空（不再自动建单）');
  assert.doesNotMatch(CHAT_SEG, /await saveIntake\(proj, e\);\s*\n\s*savedIds\.push/, '不再在 intake-chat 里直接建单');
});
test('C2 intake-chat 上送 builtTickets（续聊已建单会话让 AI 判 append/new）', () => {
  assert.match(CHAT_SEG, /const builtTickets = \(Array\.isArray\(b\.builtTickets\)/, '收 builtTickets');
  assert.match(CHAT_SEG, /intakeChatSystem\(proj, type, version, sub, archivedMsgs\.length > 0, builtTickets\)/, '传 builtTickets 进提示词');
});
test('C3 保留水位线 filedUpTo 切段 + 会话记录 upsert 用 allMsgs（不回归）', () => {
  assert.match(CHAT_SEG, /const filedUpTo = Math\.min\(Math\.max\(0, parseInt\(b\.filedUpTo, 10\) \|\| 0\), allMsgs\.length\)/, '收 filedUpTo 并夹边界');
  assert.match(CHAT_SEG, /const archivedMsgs = allMsgs\.slice\(0, filedUpTo\)/, 'archived 切段仍在');
  assert.match(CHAT_SEG, /const convChat = allMsgs\.map\(x => \(\{ role: x\.role, text: x\.content/, '会话记录 chat 存真实完整对话 allMsgs');
  assert.match(CHAT_SEG, /await saveConvRecord\(proj, \{ sessionId/, '会话记录 upsert 仍在（AC-36）');
});

/* ===== D. intake-commit-plan 新端点：按清单确定性建单/补充 + 白名单 + sites 收敛 ===== */
const COMMIT_SEG = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-commit-plan'"), SRC.indexOf("url.pathname === '/api/consult'"));
test('D1 端点存在 + 进 LINK_OK + FIELD_OK + FS08_FIELD_API 白名单（访客链接也能确认建单）', () => {
  assert.ok(/url\.pathname === '\/api\/intake-commit-plan'/.test(SRC), '端点存在');
  const linkOk = /const LINK_OK = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  const fieldOk = /const FIELD_OK = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  const fs08 = /const FS08_FIELD_API = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  assert.ok(linkOk && linkOk[1].includes("'/api/intake-commit-plan'"), '在 LINK_OK（访客链接原经 intake-chat 自动建单，现走 commit-plan 须放行）');
  assert.ok(fieldOk && fieldOk[1].includes("'/api/intake-commit-plan'"), '在 FIELD_OK');
  assert.ok(fs08 && fs08[1].includes("'/api/intake-commit-plan'"), '在 FS08_FIELD_API（否则实施域 originGate deny）');
});
test('D2 action=new 逐条建单（复用建单落库范式：id/type/title/priority/sessionId/site/history）', () => {
  assert.match(COMMIT_SEG, /const id = intakeGenId\(proj, itType\)/, 'new 生成工单 id');
  assert.match(COMMIT_SEG, /priority: normPriority\(rawIt\.priority, '中'\)/, 'priority 经 normPriority 规范四档');
  assert.match(COMMIT_SEG, /media, sessionId, status: '待处理'/, '带 sessionId + 待处理');
  assert.match(COMMIT_SEG, /note: '对话提交（确认清单）'/, 'history 留痕');
  assert.match(COMMIT_SEG, /created\.push\(\{ id, type: itType, title, priority: e\.priority \}\)/, '回带 created');
});
test('D3 action=append 校验单存在 + 属本会话/本人 sites + 追加 summary + history 留痕', () => {
  assert.match(COMMIT_SEG, /const e = tid \? loadIntake\(proj, tid\) : null/, 'append 按 ticketId 加载工单');
  assert.match(COMMIT_SEG, /if \(!e \|\| e\.deleted \|\| e\.type === 'intake-conv' \|\| e\.type === 'consult'\) continue/, '找不到/软删/非工单 → 跳过（不报错）');
  assert.match(COMMIT_SEG, /if \(user && !isAdmin\(user\)\) \{ const ss = Array\.isArray\(user\.sites\)/, '现场按 sites 收敛（越权跳过）');
  assert.match(COMMIT_SEG, /note: '对话补充：'/, 'append 追加内容 + history 留痕');
  assert.match(COMMIT_SEG, /appended\.push\(\{ id: e\.id \}\)/, '回带 appended');
});
test('D4 site 服务端收敛（convergeSite）+ 无标题跳过（不建脏单）', () => {
  assert.match(COMMIT_SEG, /const site = user \? convergeSite\(user, b\.site\)/, 'site 收敛到 user.sites');
  assert.match(COMMIT_SEG, /const title = String\(rawIt\.title \|\| ''\)\.trim\(\); if \(!title\) continue/, '无标题 item 跳过');
});

/* ===== E. 前端 field.html：确认卡渲染 + commit + 续聊走 plan 流 + builtTickets 记账 ===== */
test('E1 sendIntake 收 b.plan → renderPlanCard（不再直接建卡）；上送 builtTickets', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendIntake'), FIELD_HTML.indexOf('function sendIntakeReply'));
  assert.match(seg, /var plan = \(b\.plan && Array\.isArray\(b\.plan\.items\)\)/, 'sendIntake 读 b.plan');
  assert.match(seg, /renderPlanCard\(plan, archive, imgs\)/, '渲染确认卡');
  assert.match(seg, /builtTickets: \(chat\.builtTickets \|\| \[\]\)\.map/, '上送 builtTickets');
  assert.doesNotMatch(seg, /var tickets = Array\.isArray\(b\.savedIds\)/, '不再据 savedIds 直接建卡');
});
test('E2 renderPlanCard/commitPlan/buildPlanItemRow 存在 + commit 调 intake-commit-plan', () => {
  assert.match(FIELD_HTML, /function renderPlanCard\(plan, archive, imgs\)/, '有 renderPlanCard');
  assert.match(FIELD_HTML, /function buildPlanItemRow\(it, idx, model, rerender\)/, '有逐条编辑行 buildPlanItemRow');
  assert.match(FIELD_HTML, /function commitPlan\(card, model, archive\)/, '有 commitPlan');
  assert.match(FIELD_HTML, /api\('\/api\/intake-commit-plan'/, 'commit 调 /api/intake-commit-plan');
});
test('E3 确认卡可编辑：action 切换新建/补充 + 删条 + 拆条 + 加条', () => {
  assert.match(FIELD_HTML, /\['new', '新建工单'\], \['append', '补充到工单…'\]/, 'action 切换新建/补充');
  assert.match(FIELD_HTML, /pit-del|删除这条/, '删条');
  assert.match(FIELD_HTML, /拆成两条/, '拆条');
  assert.match(FIELD_HTML, /再加一条/, '加条');
  assert.match(FIELD_HTML, /tkSel\.className = 'aptk'/, 'append 时下拉选本会话已建单（.aptk）');
});
test('E4 续聊走 plan 流（不再 sendIntakeReply 无脑追加）', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendChat'), FIELD_HTML.indexOf('function setSending'));
  assert.doesNotMatch(seg, /chat\.savedId && chat\.reopenIntakeProject\) sendIntakeReply/, '不再据 savedId+reopenIntakeProject 走 intake-reply');
  assert.match(seg, /else sendIntake\(imgs\);/, '统一走 sendIntake（plan 流）');
});
test('E5 commitPlan 建单后：记 builtTickets + 水位线上移 + 补已建单卡 + 刷新左侧', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function commitPlan'), FIELD_HTML.indexOf('function appendArchiveCard'));
  assert.match(seg, /chat\.builtTickets\.push\(\{ id: t\.id, title: t\.title/, '记入 builtTickets（供后续续聊 append 下拉）');
  assert.match(seg, /chat\.filedUpTo = chat\.messages\.length/, '建单后水位线上移');
  assert.match(seg, /appendArchiveCard\(\{ id: t\.id/, '逐条补已建单卡');
  assert.match(seg, /showAnalyze\(\{ project: model\.project \}, t\.id\)/, '每张单即时 AI 初判（NH-3）');
  assert.match(seg, /refreshLeftList\(\)/, '刷新左侧提交清单');
});
test('E6 chat.builtTickets 状态存在 + 随草稿/快照 save/restore + newConversation 清空', () => {
  assert.match(FIELD_HTML, /builtTickets: \[\],/, 'chat 初始 builtTickets=[]');
  assert.match(FIELD_HTML, /builtTickets: \(chat\.builtTickets \|\| \[\]\)\.slice\(\)/, 'snapshot 存 builtTickets');
  assert.match(FIELD_HTML, /chat\.builtTickets = Array\.isArray\(snap\.builtTickets\)/, 'restoreConversation 恢复');
  assert.match(FIELD_HTML, /chat\.savedId = ''; chat\.builtTickets = \[\];/, 'newConversation 清空 builtTickets');
});
test('E7 reopenIntakeConv 已建单会话：填 builtTickets + 走 plan 流（清 reopenIntakeProject）', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenIntakeConv'), FIELD_HTML.indexOf('function reopenIntakeConv') + 3200);
  assert.match(seg, /chat\.builtTickets = built\.map\(function \(t\) \{ return \{ id: t\.id, title: t\.title/, '已建单会话 reopen → 填 builtTickets');
  assert.match(seg, /chat\.reopenIntakeProject = '';   \/\/ 不再走 intake-reply/, '清 reopenIntakeProject（改走 plan 流）');
  assert.match(seg, /chat\.filedUpTo = chat\.messages\.length;/, '已建单会话历史置满水位线（当只读背景）');
});

/* ===== F. 水位线切段逻辑复刻（确定性防污染 + 边界，仍生效） ===== */
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
test('F1 filedUpTo=2：前两条=背景折叠、新需求只在 active（不串旧需求）', () => {
  const all = [mk('user', '忽略比对需求'), mk('assistant', '好的，先记下'), mk('user', '厂家字段自动匹配')];
  const { archivedMsgs, activeMsgs, msgs } = splitByWatermark(all, 2);
  assert.equal(archivedMsgs.length, 2); assert.equal(activeMsgs.length, 1);
  assert.equal(msgs[1].content, '厂家字段自动匹配');
  assert.doesNotMatch(msgs[1].content, /忽略比对/, '新需求不含旧需求（不串）');
});
test('F2 filedUpTo=0/不传/越界 → 夹到 [0,len]，全量 active 不回归', () => {
  const all = [mk('user', 'A'), mk('assistant', 'a'), mk('user', 'B')];
  assert.deepEqual(splitByWatermark(all, 0).msgs.map(m => m.content), ['A', 'a', 'B']);
  assert.equal(splitByWatermark(all, undefined).filedUpTo, 0);
  assert.equal(splitByWatermark(all, 999).filedUpTo, 3);
  assert.equal(splitByWatermark(all, -5).filedUpTo, 0);
  assert.equal(splitByWatermark(all, 'x').filedUpTo, 0);
});
