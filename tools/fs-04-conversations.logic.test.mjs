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
test('A4 conversations 端点按 sessionId 归组 + 无 sessionId 单条兜底', () => {
  // key 有 sessionId → sess:；无 → solo:（每张单自成一组）
  assert.ok(/const key = sid \? \('sess:'/.test(SRC), '有 sessionId 归 sess: 组');
  assert.ok(/'solo:' \+ e\.project \+ ':' \+ e\.id/.test(SRC), '无 sessionId 每张单 solo: 自成一组（兜底不丢）');
});
test('A5 conversations 端点按 user.sites 收敛（scopedForField）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/conversations'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  assert.ok(/raw = scopedForField\(user, raw\)/.test(seg), '应 scopedForField 收敛越权');
  assert.ok(/if \(!user\) return send\(res, 401/.test(seg), '未登录 401');
});

/* ================= B. 忠实复刻分组逻辑（多单归一条 / 兜底 / 排序） ================= */
// 复刻 conversations 端点的分组算法（与源码同规则），喂造数据断言。
function buildConversations(raw) {
  const firstUserText = (e) => { const c = Array.isArray(e.chat) ? e.chat : []; const u = c.find(m => m && m.role === 'user' && (m.text || '').trim()); return u ? String(u.text).trim() : ''; };
  const items = [];
  for (const e of raw) {
    if (e.type !== 'consult') continue;
    items.push({ kind: 'consult', id: e.id, project: e.project, title: (e.title || firstUserText(e) || '系统咨询').slice(0, 60), site: e.site || '', subsystem: e.subsystem || '', updatedAt: e.updatedAt || e.submittedAt || '' });
  }
  const groupsMap = new Map();
  for (const e of raw) {
    if (e.type !== 'requirement' && e.type !== 'bug') continue;
    const sid = String(e.sessionId || '').trim();
    const key = sid ? ('sess:' + e.project + ':' + sid) : ('solo:' + e.project + ':' + e.id);
    let g = groupsMap.get(key);
    if (!g) { g = { rep: e, tickets: [], site: e.site || '', subsystem: e.subsystem || '', updatedAt: e.updatedAt || e.submittedAt || '' }; groupsMap.set(key, g); }
    g.tickets.push({ id: e.id, type: e.type, priority: e.priority || '中', subsystem: e.subsystem || '', version: e.version || '', submittedAt: e.submittedAt || '' });
    if ((e.submittedAt || '') < (g.rep.submittedAt || '')) g.rep = e;
    const ua = e.updatedAt || e.submittedAt || '';
    if (ua > g.updatedAt) g.updatedAt = ua;
  }
  for (const g of groupsMap.values()) {
    const rep = g.rep;
    const summary = (firstUserText(rep) || rep.title || '对话提交').slice(0, 60);
    const reqN = g.tickets.filter(t => t.type === 'requirement').length;
    const bugN = g.tickets.filter(t => t.type === 'bug').length;
    const tickets = g.tickets.slice().sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
    items.push({ kind: 'intake', id: rep.id, project: rep.project, title: summary, site: g.site, subsystem: g.subsystem || rep.subsystem || '', ticketCount: g.tickets.length, reqCount: reqN, bugCount: bugN, tickets, updatedAt: g.updatedAt });
  }
  items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return items;
}

test('B1 一次聊天建两张单（同 sessionId）→ 归成一条对话记录', () => {
  const raw = [
    { project: 'p1', id: 'XQ-1', type: 'requirement', sessionId: 'sABC', title: '加导出', priority: '高', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:00', chat: [{ role: 'user', text: '想加个导出，还有个报错' }] },
    { project: 'p1', id: 'BUG-1', type: 'bug', sessionId: 'sABC', title: '登录报错', priority: '紧急', submittedAt: '2026-08-06 10:01', updatedAt: '2026-08-06 10:01', chat: [{ role: 'user', text: '想加个导出，还有个报错' }] },
  ];
  const items = buildConversations(raw);
  const intakeItems = items.filter(i => i.kind === 'intake');
  assert.equal(intakeItems.length, 1, '两张单同 sessionId → 恰 1 条对话记录');
  const g = intakeItems[0];
  assert.equal(g.ticketCount, 2, '这次聊天建了 2 张单');
  assert.equal(g.reqCount, 1); assert.equal(g.bugCount, 1);
  assert.equal(g.id, 'XQ-1', '代表工单=首张（submittedAt 最小）');
  assert.equal(g.title, '想加个导出，还有个报错', '概要=首条 user 文本');
  assert.equal(g.tickets.length, 2, '带该会话下全部单明细供补卡');
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

test('B3 旧单无 sessionId → 每张自成一组（兜底不丢）', () => {
  const raw = [
    { project: 'p1', id: 'XQ-old1', type: 'requirement', title: '旧需求A', submittedAt: '2026-08-01 10:00', updatedAt: '2026-08-01 10:00', chat: [] },
    { project: 'p1', id: 'XQ-old2', type: 'requirement', title: '旧需求B', submittedAt: '2026-08-01 11:00', updatedAt: '2026-08-01 11:00', chat: [] },
  ];
  const items = buildConversations(raw).filter(i => i.kind === 'intake');
  assert.equal(items.length, 2, '两张无 sessionId 旧单 → 两条对话记录（各自成组）');
  assert.ok(items.every(i => i.ticketCount === 1), '各组 1 张单');
});

test('B4 不同 sessionId 不串组 + 均按 updatedAt 倒序', () => {
  const raw = [
    { project: 'p1', id: 'XQ-a', type: 'requirement', sessionId: 'sA', title: 'A', submittedAt: '2026-08-06 08:00', updatedAt: '2026-08-06 08:00', chat: [] },
    { project: 'p1', id: 'XQ-b', type: 'requirement', sessionId: 'sB', title: 'B', submittedAt: '2026-08-06 12:00', updatedAt: '2026-08-06 12:30', chat: [] },
    { project: 'p1', id: 'ZX-c', type: 'consult', title: 'C', submittedAt: '2026-08-06 09:00', updatedAt: '2026-08-06 15:00', chat: [] },
  ];
  const items = buildConversations(raw);
  assert.equal(items.length, 3, '两个不同 sessionId + 一条咨询 = 3 项');
  // 倒序：C(15:00) > B(12:30) > A(08:00)
  assert.deepEqual(items.map(i => i.id), ['ZX-c', 'XQ-b', 'XQ-a'], '按 updatedAt 倒序');
});

test('B5 同 sessionId 但跨产品不串组（key 含 project）', () => {
  const raw = [
    { project: 'p1', id: 'XQ-1', type: 'requirement', sessionId: 'sX', title: 'A', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:00', chat: [] },
    { project: 'p2', id: 'XQ-2', type: 'requirement', sessionId: 'sX', title: 'B', submittedAt: '2026-08-06 10:00', updatedAt: '2026-08-06 10:00', chat: [] },
  ];
  const items = buildConversations(raw).filter(i => i.kind === 'intake');
  assert.equal(items.length, 2, '同 sessionId 跨产品 → 不串组（key 带 project）');
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
  const seg = FIELD_HTML.slice(FIELD_HTML.indexOf('function mkConvItem'), FIELD_HTML.indexOf('function reopenConversation'));
  assert.ok(/if \(isConsult\) reopenConsult\(/.test(seg), 'consult 项 → reopenConsult');
  assert.ok(/else reopenConversation\(it\)/.test(seg), 'intake 项 → reopenConversation');
  // 多单会话补卡：除代表单外逐张 appendArchiveCard
  const seg2 = FIELD_HTML.slice(FIELD_HTML.indexOf('function reopenConversation'), FIELD_HTML.indexOf('function reopenConversation') + 1400);
  assert.ok(/appendArchiveCard\(/.test(seg2), 'reopenConversation 多单会话补「已建单」卡');
});
