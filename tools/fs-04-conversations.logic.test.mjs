// FS-04（2026-08-06）· 工单与对话记录分离 + sessionId 会话分组 · 脱库逻辑测试
//   背景：左侧「提交清单」只列需求/BUG 工单（去掉咨询组）；右上「对话记录」列对话会话——
//     · 咨询（consult）每条一项；
//     · 提需求/报BUG 聊天：一次聊天建的多张单按 sessionId 归成「一条对话记录」；
//     · 旧单（无 sessionId）兜底每张自成一组；均按 updatedAt 倒序。
//   本地 MySQL 常 ECONNREFUSED、server 启动即 db.init() 退出——故本组走静态断言 + 忠实复刻分组逻辑（可抓漂移）。
//   连真库冒烟走 prod（见交付说明），本组只保证逻辑/接线不回归。
//   用法：node --test tools/fs-04-conversations.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

/* ================= A. 后端接线（端点存在 + 双白名单 + sessionId 落库） ================= */
test('A1 /api/field/conversations 端点存在', () => {
  assert.ok(/url\.pathname === '\/api\/field\/conversations'/.test(SRC), '应有 /api/field/conversations 端点');
});
test('A2 /api/field/conversations 进 FIELD_OK + FS08_FIELD_API 双白名单', () => {
  const fieldOk = /const FIELD_OK = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  const fs08 = /const FS08_FIELD_API = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  assert.ok(fieldOk && fieldOk[1].includes("'/api/field/conversations'"), '应在 FIELD_OK');
  assert.ok(fs08 && fs08[1].includes("'/api/field/conversations'"), '应在 FS08_FIELD_API（否则实施域 originGate deny）');
});
test('A3 intake-chat 建单把 sessionId 落进 data JSON（不加库列）', () => {
  assert.ok(/const sessionId = String\(b\.sessionId \|\| ''\)\.trim\(\)/.test(SRC), 'intake-chat 应取 b.sessionId');
  // 建单对象 e 里带 sessionId 字段（随 data JSON 落库，不加库列）
  assert.ok(/media, sessionId, status: '待处理'/.test(SRC), '建单对象 e 应带 sessionId 字段');
});
test('A3b intake-chat 每轮 upsert 会话记录（saveConvRecord，沟通过就存）', () => {
  assert.ok(/async function saveConvRecord\(proj, \{ sessionId/.test(SRC), '有 saveConvRecord 会话记录持久化函数');
  assert.ok(/type: 'intake-conv'/.test(SRC), '会话记录 type=intake-conv');
  assert.ok(/id = 'CONV-' \+ sid/.test(SRC), '会话记录 id 由 sessionId 派生（幂等 upsert）');
  // intake-chat 建单后调 saveConvRecord（不重复建工单）
  const chatSeg = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-chat'"), SRC.indexOf("url.pathname === '/api/consult'"));
  assert.ok(/await saveConvRecord\(proj, \{ sessionId/.test(chatSeg), 'intake-chat 建单流程调 saveConvRecord 存会话记录');
  // 「沟通过才存」：需有 user + assistant 内容
  assert.ok(/if \(!hasUser \|\| !hasAi\) return ''/.test(SRC), '沟通过判据：有 user + assistant 才存');
});
test('A3c intake-reply 续聊同步会话记录 + listIntake 排除 intake-conv', () => {
  const replySeg = SRC.slice(SRC.indexOf("url.pathname === '/api/intake-reply'"), SRC.indexOf("url.pathname === '/api/intake-chat'"));
  assert.ok(/await saveConvRecord\(proj, \{ sessionId: e\.sessionId/.test(replySeg), 'intake-reply 续聊同步刷新会话记录');
  assert.ok(/e\.type !== 'intake-conv'/.test(SRC), 'listIntake 排除 intake-conv（会话记录不进提交清单/批次/统计）');
});
test('A4 conversations 端点：intake-conv 会话记录为主 + 按 sessionId 关联工单 + 旧数据兜底', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/conversations'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  assert.ok(/e\.type !== 'intake-conv'\) continue/.test(seg), '端点纳入 intake-conv 会话记录');
  assert.ok(/if \(e\.type !== 'intake-conv'\) continue;/.test(seg), '以 intake-conv 为主列 intake 会话项');
  assert.ok(/usedTicketKeys\.add\(k\)/.test(seg), '会话记录关联掉的工单组不重复兜底');
  assert.ok(/if \(usedTicketKeys\.has\(k\)\) continue;/.test(seg), '旧数据兜底：无会话记录的工单组才按 sessionId 归组');
  assert.ok(/fromConv: true/.test(seg) && /fromConv: false/.test(seg), '标记 fromConv 区分会话记录 vs 旧工单兜底');
});
test('A4b 删掉的会话记录其 session 不被旧数据兜底拉回（删对话记录后彻底消失）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/conversations'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  assert.ok(/const deletedConvKeys = new Set\(\)/.test(seg), '收集软删会话记录的 session 键');
  assert.ok(/e\.type === 'intake-conv' && e\.deleted/.test(seg), '扫软删的 intake-conv 记录');
  assert.ok(/if \(deletedConvKeys\.has\(k\)\) continue;/.test(seg), '兜底跳过已删会话记录的 session（工单仍在左侧，此处不拉回）');
});
test('A5 conversations 端点按 user.sites 收敛（scopedForField）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/conversations'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  assert.ok(/raw = scopedForField\(user, raw\)/.test(seg), '应 scopedForField 收敛越权');
  assert.ok(/if \(!user\) return send\(res, 401/.test(seg), '未登录 401');
});

/* ================= B. 忠实复刻分组逻辑（会话记录为主 / 关联工单 / 旧数据兜底 / 排序） ================= */
// 复刻 /api/field/conversations 端点算法（AC-36 改造后·与源码同规则），喂造数据断言。
function buildConversations(raw) {
  const firstUserText = (e) => { const c = Array.isArray(e.chat) ? e.chat : []; const u = c.find(m => m && m.role === 'user' && (m.text || '').trim()); return u ? String(u.text).trim() : ''; };
  const items = [];
  for (const e of raw) {
    if (e.type !== 'consult') continue;
    items.push({ kind: 'consult', id: e.id, project: e.project, title: (e.title || firstUserText(e) || '系统咨询').slice(0, 60), site: e.site || '', subsystem: e.subsystem || '', updatedAt: e.updatedAt || e.submittedAt || '' });
  }
  const ticketsBySession = new Map();
  for (const e of raw) {
    if (e.type !== 'requirement' && e.type !== 'bug') continue;
    const sid = String(e.sessionId || '').trim();
    const k = sid ? (e.project + '|' + sid) : ('solo|' + e.project + '|' + e.id);
    (ticketsBySession.get(k) || (ticketsBySession.set(k, []).get(k))).push(e);
  }
  const usedTicketKeys = new Set();
  for (const e of raw) {
    if (e.type !== 'intake-conv') continue;
    const sid = String(e.sessionId || '').trim();
    const k = e.project + '|' + sid;
    const rel = (sid && ticketsBySession.get(k)) || [];
    if (sid) usedTicketKeys.add(k);
    const tickets = rel.map(t => ({ id: t.id, type: t.type, priority: t.priority || '中', subsystem: t.subsystem || '', version: t.version || '', submittedAt: t.submittedAt || '' })).sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
    const reqN = tickets.filter(t => t.type === 'requirement').length;
    const bugN = tickets.filter(t => t.type === 'bug').length;
    let ua = e.updatedAt || e.submittedAt || '';
    for (const t of rel) { const tu = t.updatedAt || t.submittedAt || ''; if (tu > ua) ua = tu; }
    items.push({ kind: 'intake', id: e.id, project: e.project, sessionId: sid, title: (firstUserText(e) || e.title || '对话提交').slice(0, 60), site: e.site || '', subsystem: e.subsystem || '', ticketCount: tickets.length, reqCount: reqN, bugCount: bugN, tickets, updatedAt: ua, fromConv: true });
  }
  for (const [k, arr] of ticketsBySession.entries()) {
    if (usedTicketKeys.has(k)) continue;
    let rep = arr[0]; let site = arr[0].site || ''; let subsystem = arr[0].subsystem || ''; let updatedAt = '';
    for (const e of arr) { if ((e.submittedAt || '') < (rep.submittedAt || '')) rep = e; const eu = e.updatedAt || e.submittedAt || ''; if (eu > updatedAt) updatedAt = eu; }
    const tickets = arr.map(t => ({ id: t.id, type: t.type, priority: t.priority || '中', subsystem: t.subsystem || '', version: t.version || '', submittedAt: t.submittedAt || '' })).sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
    const reqN = tickets.filter(t => t.type === 'requirement').length;
    const bugN = tickets.filter(t => t.type === 'bug').length;
    items.push({ kind: 'intake', id: rep.id, project: rep.project, sessionId: String(rep.sessionId || '').trim(), title: (firstUserText(rep) || rep.title || '对话提交').slice(0, 60), site, subsystem: subsystem || rep.subsystem || '', ticketCount: tickets.length, reqCount: reqN, bugCount: bugN, tickets, updatedAt, fromConv: false });
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return items;
}

test('B1 会话记录 + 同会话两张单 → 一条对话记录（fromConv，含单数统计）', () => {
  const raw = [
    { project: 'p1', id: 'CONV-sABC', type: 'intake-conv', sessionId: 'sABC', title: '加导出', site: '甲医院', subsystem: 'sys', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:05', chat: [{ role: 'user', text: '想加个导出，还有个报错' }, { role: 'assistant', text: '好的' }] },
    { project: 'p1', id: 'XQ-1', type: 'requirement', sessionId: 'sABC', title: '加导出', priority: '高', submittedAt: '2026-08-06 10:02', updatedAt: '2026-08-06 10:02', chat: [] },
    { project: 'p1', id: 'BUG-1', type: 'bug', sessionId: 'sABC', title: '登录报错', priority: '紧急', submittedAt: '2026-08-06 10:03', updatedAt: '2026-08-06 10:03', chat: [] },
  ];
  const items = buildConversations(raw);
  const intakeItems = items.filter(i => i.kind === 'intake');
  assert.equal(intakeItems.length, 1, '一条会话记录 + 两张关联单 → 恰 1 条对话记录');
  const g = intakeItems[0];
  assert.equal(g.id, 'CONV-sABC', '对话记录 id=会话记录 id（reopen 从它取整段 chat）');
  assert.equal(g.fromConv, true, 'fromConv=true');
  assert.equal(g.ticketCount, 2); assert.equal(g.reqCount, 1); assert.equal(g.bugCount, 1);
  assert.equal(g.title, '想加个导出，还有个报错', '概要=会话记录首条 user 文本');
  assert.equal(g.tickets.length, 2, '带该会话下全部单明细供补卡');
});

test('B1b 未建单会话记录（沟通过没建单）也出现在对话记录（ticketCount=0）', () => {
  const raw = [
    { project: 'p1', id: 'CONV-sNEW', type: 'intake-conv', sessionId: 'sNEW', title: '想要个功能', site: '甲医院', subsystem: 'sys', submittedAt: '2026-08-06 11:00', updatedAt: '2026-08-06 11:01', chat: [{ role: 'user', text: '想要个功能' }, { role: 'assistant', text: '能细说下吗' }] },
  ];
  const items = buildConversations(raw).filter(i => i.kind === 'intake');
  assert.equal(items.length, 1, '未建单会话也在对话记录');
  assert.equal(items[0].ticketCount, 0, '未建单 → ticketCount=0（前端显「未建单」）');
  assert.equal(items[0].fromConv, true);
  assert.equal(items[0].id, 'CONV-sNEW', '未建单会话 reopen 从会话记录恢复');
});

test('B2 咨询每条自成一项、不进 intake 分组', () => {
  const raw = [
    { project: 'p1', id: 'ZX-1', type: 'consult', title: '怎么配置', site: '甲医院', subsystem: 'sys', submittedAt: '2026-08-06 09:00', updatedAt: '2026-08-06 09:05', chat: [{ role: 'user', text: '怎么配置' }] },
    { project: 'p1', id: 'ZX-2', type: 'consult', title: '端口问题', site: '甲医院', submittedAt: '2026-08-06 09:10', updatedAt: '2026-08-06 09:12', chat: [] },
  ];
  const items = buildConversations(raw);
  assert.equal(items.filter(i => i.kind === 'consult').length, 2, '两条咨询=两项');
  assert.equal(items.filter(i => i.kind === 'intake').length, 0, '无 intake 项');
});

test('B3 旧数据兜底：有工单但无会话记录 → 按 sessionId 归组（fromConv=false）', () => {
  const raw = [
    // 老 session：两张单同 sessionId，但没有 intake-conv 会话记录
    { project: 'p1', id: 'XQ-old1', type: 'requirement', sessionId: 'sOLD', title: '旧需求A', submittedAt: '2026-08-01 10:00', updatedAt: '2026-08-01 10:00', chat: [{ role: 'user', text: '旧对话' }] },
    { project: 'p1', id: 'BUG-old2', type: 'bug', sessionId: 'sOLD', title: '旧BUG', submittedAt: '2026-08-01 10:05', updatedAt: '2026-08-01 10:05', chat: [] },
    // 更老：连 sessionId 都没有 → 每张自成一组
    { project: 'p1', id: 'XQ-solo', type: 'requirement', title: '无sid旧单', submittedAt: '2026-08-01 09:00', updatedAt: '2026-08-01 09:00', chat: [] },
  ];
  const items = buildConversations(raw).filter(i => i.kind === 'intake');
  assert.equal(items.length, 2, '旧 session 归一条 + 无 sid 单条 = 2 条（兜底不丢历史工单会话）');
  const grp = items.find(i => i.id === 'XQ-old1');
  assert.ok(grp, '旧 session 代表工单=首张');
  assert.equal(grp.fromConv, false, '旧数据兜底 fromConv=false');
  assert.equal(grp.ticketCount, 2);
  const solo = items.find(i => i.id === 'XQ-solo');
  assert.equal(solo.ticketCount, 1, '无 sessionId 单条自成一组');
});

test('B3b 会话记录关联掉的工单不被兜底重复列', () => {
  const raw = [
    { project: 'p1', id: 'CONV-sABC', type: 'intake-conv', sessionId: 'sABC', title: 't', site: '甲', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:00', chat: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }] },
    { project: 'p1', id: 'XQ-1', type: 'requirement', sessionId: 'sABC', title: 't', submittedAt: '2026-08-06 10:02', updatedAt: '2026-08-06 10:02', chat: [] },
  ];
  const items = buildConversations(raw).filter(i => i.kind === 'intake');
  assert.equal(items.length, 1, '会话记录 + 其关联工单 → 恰 1 条（不重复）');
  assert.equal(items[0].fromConv, true);
});

test('B4 不同 sessionId 不串组 + 均按 updatedAt 倒序', () => {
  const raw = [
    { project: 'p1', id: 'CONV-sA', type: 'intake-conv', sessionId: 'sA', title: 'A', submittedAt: '2026-08-06 08:00', updatedAt: '2026-08-06 08:00', chat: [{ role: 'user', text: 'A' }, { role: 'assistant', text: 'a' }] },
    { project: 'p1', id: 'CONV-sB', type: 'intake-conv', sessionId: 'sB', title: 'B', submittedAt: '2026-08-06 12:00', updatedAt: '2026-08-06 12:30', chat: [{ role: 'user', text: 'B' }, { role: 'assistant', text: 'b' }] },
    { project: 'p1', id: 'ZX-c', type: 'consult', title: 'C', submittedAt: '2026-08-06 09:00', updatedAt: '2026-08-06 15:00', chat: [] },
  ];
  const items = buildConversations(raw);
  assert.equal(items.length, 3, '两个不同 sessionId 会话记录 + 一条咨询 = 3 项');
  // 倒序：C(15:00) > B(12:30) > A(08:00)
  assert.deepEqual(items.map(i => i.id), ['ZX-c', 'CONV-sB', 'CONV-sA'], '按 updatedAt 倒序');
});

test('B5 同 sessionId 但跨产品不串组（key 含 project）', () => {
  const raw = [
    { project: 'p1', id: 'CONV-sX-1', type: 'intake-conv', sessionId: 'sX', title: 'A', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:00', chat: [{ role: 'user', text: 'A' }, { role: 'assistant', text: 'a' }] },
    { project: 'p2', id: 'CONV-sX-2', type: 'intake-conv', sessionId: 'sX', title: 'B', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:00', chat: [{ role: 'user', text: 'B' }, { role: 'assistant', text: 'b' }] },
  ];
  const items = buildConversations(raw).filter(i => i.kind === 'intake');
  assert.equal(items.length, 2, '同 sessionId 跨产品 → 不串组（key 带 project）');
});

test('B6 会话记录 updatedAt 取会话/工单里最新（建单后仍排前）', () => {
  const raw = [
    { project: 'p1', id: 'CONV-s1', type: 'intake-conv', sessionId: 's1', title: 't', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:00', chat: [{ role: 'user', text: 'x' }, { role: 'assistant', text: 'y' }] },
    { project: 'p1', id: 'XQ-1', type: 'requirement', sessionId: 's1', title: 't', submittedAt: '2026-08-06 10:30', updatedAt: '2026-08-06 12:00', chat: [] },
  ];
  const items = buildConversations(raw).filter(i => i.kind === 'intake');
  assert.equal(items[0].updatedAt, '2026-08-06 12:00', 'updatedAt 取会话记录与关联工单里最新');
});

/* ================= C. 前端接线（左侧去咨询组 + sessionId 生成/带发/存 + 抽屉入口） ================= */
test('C1 左侧 renderTypeView 去掉 consult 组（只需求/BUG）', () => {
  assert.ok(/var order = \['requirement', 'bug'\];/.test(FIELD_HTML), 'renderTypeView order 只含 requirement/bug');
  assert.ok(!/var order = \['requirement', 'bug', 'consult'\];/.test(FIELD_HTML), '不应再含 consult 组');
});
test('C2 chat.sessionId 状态 + newSessionId 生成 + newConversation 重置', () => {
  assert.ok(/sessionId: '',/.test(FIELD_HTML), 'chat 初始有 sessionId');
  assert.ok(/function newSessionId\(\)/.test(FIELD_HTML), '有 newSessionId 生成函数');
  assert.ok(/chat\.sessionId = newSessionId\(\);/.test(FIELD_HTML), 'newConversation 重置生成新 sessionId');
});
test('C3 sendIntake 发 intake-chat 带 sessionId', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function sendIntake'), FIELD_HTML.indexOf('function sendIntakeReply'));
  assert.ok(/sessionId: \(chat\.sessionId/.test(seg), 'sendIntake body 带 sessionId');
});
test('C4 sessionId 随草稿/快照 save & restore', () => {
  assert.ok(/sessionId: chat\.sessionId \|\| ''/.test(FIELD_HTML), 'snapshot/draft 存 sessionId');
  assert.ok(/chat\.sessionId = snap\.sessionId \|\| newSessionId\(\)/.test(FIELD_HTML), 'restoreConversation 恢复 sessionId');
  assert.ok(/chat\.sessionId = d\.sessionId \|\| newSessionId\(\)/.test(FIELD_HTML), 'restoreDraft 恢复 sessionId');
});
test('C5 对话记录抽屉入口 + 面板 + 函数接线', () => {
  assert.ok(/id="fConvRecBtn"/.test(FIELD_HTML), '工具条有「对话记录」入口按钮');
  assert.ok(/id="fConvDrawer"/.test(FIELD_HTML) && /id="fConvResults"/.test(FIELD_HTML), '有对话记录抽屉容器');
  assert.ok(/function openConvRec\(\)/.test(FIELD_HTML) && /function loadConversations\(\)/.test(FIELD_HTML) && /function reopenConversation\(/.test(FIELD_HTML), '有 open/load/reopen 函数');
  assert.ok(/api\('\/api\/field\/conversations'/.test(FIELD_HTML), 'loadConversations 调 /api/field/conversations');
});
test('C6 reopen 分派：consult→reopenConsult，intake 会话→reopenConversation', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkConvItem'), FIELD_HTML.indexOf('function bindConvDelete'));
  assert.ok(/if \(isConsult\) reopenConsult\(/.test(seg), 'consult 项 → reopenConsult');
  assert.ok(/else reopenConversation\(it\)/.test(seg), 'intake 项 → reopenConversation');
  // AC-36：reopenConversation 优先走会话记录（fromConv → reopenIntakeConv）；旧数据兜底走代表工单
  const seg2 = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenConversation'), FIELD_HTML.indexOf('function reopenIntakeConv'));
  assert.ok(/if \(it\.fromConv\) \{ reopenIntakeConv/.test(seg2), 'fromConv → 从会话记录 reopenIntakeConv');
  // reopenIntakeConv：拉会话记录 detail 恢复 chat + 已建单补卡 / 未建单锁 sessionId
  const seg3 = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenIntakeConv'), FIELD_HTML.indexOf('function reopenIntakeConv') + 2800);   // 窗口放宽：filedUpTo 注释行推后了 reopenConvProject 位置
  assert.ok(/api\('\/api\/intake-detail\?project=/.test(seg3), 'reopenIntakeConv 拉会话记录 detail 取整段 chat');
  assert.ok(/appendArchiveCard\(/.test(seg3), '已建单会话补「已建单」卡');
  assert.ok(/chat\.reopenConvProject = it\.project/.test(seg3), '未建单会话锁归档上下文（续聊走 intake-chat 同 sessionId）');
});
test('C7 对话记录删除入口（软删）：仅会话记录/咨询、调 intake-delete、不连带删工单', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkConvItem'), FIELD_HTML.indexOf('function reopenConversation'));
  assert.ok(/if \(isConsult \|\| it\.fromConv\) bindConvDelete\(el, it\)/.test(seg), '仅咨询/会话记录挂删除入口（旧工单兜底项不给删）');
  assert.ok(/function bindConvDelete\(/.test(FIELD_HTML) && /function doDeleteConversation\(/.test(FIELD_HTML), '有删除绑定/执行函数');
  const seg2 = FIELD_HTML.slice(FIELD_HTML.indexOf('function doDeleteConversation'), FIELD_HTML.indexOf('function doDeleteConversation') + 1100);
  assert.ok(/api\('\/api\/intake-delete', \{ method: 'POST', body: JSON\.stringify\(\{ project: it\.project, id: it\.id \}\)/.test(seg2), '软删调 intake-delete（id=会话记录自身，非工单）');
  assert.ok(/它建的工单不受影响/.test(seg2), '确认文案说明不连带删工单');
});
test('C8 会话续聊：currentArchive 锁 reopenConvProject（intake · FS-04 v2 已建单会话也走 plan 流，不再要求 !savedId）', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function currentArchive'), FIELD_HTML.indexOf('function currentArchive') + 2600);
  // FS-04 v2（2026-08-07）：已建单会话 reopen 同样走 plan 流（chat.savedId 已置），故 guard 去掉 !chat.savedId——只要 reopenConvProject 有值就锁上下文。
  assert.ok(/if \(chat\.reopenConvProject && chat\.submitKind === 'intake'\) \{/.test(seg), 'reopen 会话续聊锁归档上下文（不再要求未建单）');
  // 新对话/草稿重置/恢复 reopenConv*
  assert.ok(/chat\.reopenConvProject = ''; chat\.reopenConvSite = ''/.test(FIELD_HTML), 'newConversation 重置 reopenConv*');
  assert.ok(/chat\.reopenConvProject = d\.reopenConvProject/.test(FIELD_HTML), 'restoreDraft 恢复 reopenConv*');
});

/* ================= D. 左侧工单点击 → 只读「工单详情抽屉」（2026-08-07 · 不再 reopenIntake 恢复对话续聊） ================= */
test('D1 存在 openTicketDrawer / closeTicketDrawer / renderTicketDrawer 三函数 + 抽屉容器', () => {
  assert.ok(/function openTicketDrawer\(it\)/.test(FIELD_HTML), '有 openTicketDrawer(it)');
  assert.ok(/function closeTicketDrawer\(\)/.test(FIELD_HTML), '有 closeTicketDrawer()');
  assert.ok(/function renderTicketDrawer\(item, listItem\)/.test(FIELD_HTML), '有 renderTicketDrawer(item, listItem)');
  assert.ok(/id="fTkDrawer"/.test(FIELD_HTML) && /id="fTkContent"/.test(FIELD_HTML) && /id="fTkMask"/.test(FIELD_HTML), '有工单详情抽屉 DOM 容器（遮罩/抽屉/内容）');
});
test('D2 点击分派：bindReopen 里 requirement/bug → openTicketDrawer（不再 reopenIntake）；consult → reopenConsult', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function bindReopen'), FIELD_HTML.indexOf('function bindReopen') + 900);
  assert.ok(/if \(it\.type === 'consult'\) reopenConsult\(it\); else openTicketDrawer\(it\)/.test(seg), 'bindReopen：consult→reopenConsult、req/bug→openTicketDrawer');
  assert.ok(!/else reopenIntake\(it\)/.test(seg), 'bindReopen 里不再把 req/bug 分派到 reopenIntake');
  // mkItem/mkSysItem 两处共用 bindReopen（不各自绑），故只需断言 bindReopen 分派
  const mkItemSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkItem'), FIELD_HTML.indexOf('function goToBatchDownload'));
  const mkSysSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkSysItem'), FIELD_HTML.indexOf('// ---------- 归档版本模型'));
  assert.ok(/bindReopen\(el, it\);/.test(mkItemSeg), 'mkItem 走 bindReopen');
  assert.ok(/bindReopen\(el, it\);/.test(mkSysSeg), 'mkSysItem 走 bindReopen');
});
test('D3 openTicketDrawer：仅 req/bug、拉 intake-detail、只读展示、不动右侧对话区（不 setSubmitKind/不写 chat.messages）', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function openTicketDrawer'), FIELD_HTML.indexOf('function closeTicketDrawer'));
  assert.ok(/it\.type !== 'requirement' && it\.type !== 'bug'/.test(seg), '守卫仅 requirement/bug');
  assert.ok(/api\('\/api\/intake-detail\?project=/.test(seg), '拉 /api/intake-detail 取完整 item');
  assert.ok(/renderTicketDrawer\(item, it\)/.test(seg), '拉到详情后渲染抽屉');
  // 只读：不改右侧对话状态
  assert.ok(!/setSubmitKind\(/.test(seg), 'openTicketDrawer 不切提交模式（不动右侧对话区）');
  assert.ok(!/chat\.messages =/.test(seg) && !/chat\.savedId =/.test(seg), 'openTicketDrawer 不写 chat.messages/savedId（不恢复对话）');
  // 竞态守卫：快速点两条时旧请求不覆盖
  assert.ok(/data-tkid/.test(seg), '带 data-tkid 竞态守卫');
});
test('D4 renderTicketDrawer：BUG / 需求 各自字段 + AI 意见 + 截图 + 元信息，长文本走 md()', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function renderTicketDrawer'), FIELD_HTML.indexOf('function renderTicketDrawer') + 4200);
  // BUG 字段
  assert.ok(/item\.desc/.test(seg) && /item\.errorInfo/.test(seg) && /item\.steps/.test(seg) && /item\.expectResult/.test(seg), 'BUG：现象/报错/复现/期望');
  assert.ok(/item\.severity/.test(seg) && /item\.scope/.test(seg) && /item\.env/.test(seg) && /item\.freq/.test(seg), 'BUG：严重/影响/环境/频率');
  // 需求字段
  assert.ok(/item\.bg/.test(seg) && /item\.reqDesc/.test(seg) && /item\.scene/.test(seg) && /item\.accept/.test(seg) && /item\.relate/.test(seg), '需求：背景/期望效果/场景/验收/关联');
  // AI 意见 / 初判
  assert.ok(/item\.opinion/.test(seg) && /item\.analysis/.test(seg), 'AI 处理意见（opinion）+ 分析初判（analysis）');
  // 截图复用 mediaUrls
  assert.ok(/mediaUrls\(item\.project/.test(seg), '截图走 mediaUrls（缩略图点开原图）');
  // 元信息：现场/子系统/版本/紧急/提交人/提交时间，时间过 fmtTime
  assert.ok(/pushMeta\('现场'/.test(seg) && /pushMeta\('子系统'/.test(seg) && /pushMeta\('版本'/.test(seg) && /pushMeta\('紧急程度'/.test(seg) && /pushMeta\('提交人'/.test(seg) && /pushMeta\('提交时间'/.test(seg), '元信息六项齐全');
  assert.ok(/fmtTime\(item\.submittedAt\)/.test(seg), '提交时间过 fmtTime（yyyy-MM-dd HH:mm）');
  // 长文本走 md()（rich），短字段纯文本 esc
  assert.ok(/opts\.rich \? md\(val\)/.test(seg), '长文本字段走 md() 渲染');
});
test('D5 关闭入口：× / 遮罩 / Esc 三路 + markLeftActive 高亮选中态', () => {
  assert.ok(/tkMask.*addEventListener\('click', closeTicketDrawer\)/.test(FIELD_HTML), '遮罩点击关闭');
  assert.ok(/tkClose.*addEventListener\('click', closeTicketDrawer\)/.test(FIELD_HTML), '× 按钮关闭');
  assert.ok(/tkd && tkd\.classList\.contains\('open'\)\) \{ closeTicketDrawer\(\)/.test(FIELD_HTML), 'Esc 关闭工单抽屉');
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function openTicketDrawer'), FIELD_HTML.indexOf('function closeTicketDrawer'));
  assert.ok(/markLeftActive\('intake', it\.id\)/.test(seg), '打开抽屉时高亮左侧该条（选中态保留）');
});
test('D6 抽屉是只读查看：不提供续聊入口，底部弱提示引导到「对话记录」续聊', () => {
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function renderTicketDrawer'), FIELD_HTML.indexOf('// ========== FS-03', FIELD_HTML.indexOf('function renderTicketDrawer')));
  assert.ok(/f-tk-hint/.test(seg) && /对话记录/.test(seg) && /续聊/.test(seg), '底部弱提示引导去「对话记录」续聊');
});
test('D7 左侧删除入口不受影响（bindDelete 仍在 mkItem/mkSysItem）', () => {
  const mkItemSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkItem'), FIELD_HTML.indexOf('function goToBatchDownload'));
  const mkSysSeg = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkSysItem'), FIELD_HTML.indexOf('// ---------- 归档版本模型'));
  assert.ok(/bindDelete\(el, it\);/.test(mkItemSeg), 'mkItem 仍挂 bindDelete（软删入口保留）');
  assert.ok(/bindDelete\(el, it\);/.test(mkSysSeg), 'mkSysItem 仍挂 bindDelete');
});
