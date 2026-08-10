// FS-04 · 实施端同标签刷新恢复·脱库逻辑测试
// 直接从 field.html 抽取并执行真实的校验/恢复/清理函数，不用「字符串存在」代替行为验证。
// 用法：node --test tools/fs-04-refresh-restore.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELD = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `应能找到 function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${name} 大括号未配平`);
}

function refState() {
  return {
    sites: ['甲医院', '乙医院'], projects: ['p1'],
    customers: [
      { name: '甲医院', products: [{ project: 'p1', subsystems: [{ name: 'audit', version: '1.0' }, { name: 'ward' }] }] },
      { name: '乙医院', products: [{ project: 'p1', subsystems: [{ name: 'ward' }] }] },
    ],
    projMap: { p1: { id: 'p1', subsystems: [{ name: 'audit' }, { name: 'ward' }] } },
    systems: [
      { name: 'audit', project: 'p1' },
      { name: 'secret', project: 'p2' },
    ],
  };
}

function makeNormalize(state) {
  return new Function('state', extractFn(FIELD, 'normalizeNavigationDraft') + '\nreturn normalizeNavigationDraft;')(state);
}

test('系统视图：curSys + ctxVer + 左侧选中态从真实恢复逻辑通过', () => {
  const normalize = makeNormalize(refState());
  const got = normalize({
    nav: { mode: 'sys', curSite: '乙医院', curSys: 'audit', curSub: 'ward', groupBy: 'type', ctxVer: '2026-07-28' },
    leftActive: { kind: 'consult', id: 'ZX-17' },
  });
  assert.equal(got.mode, 'sys');
  assert.equal(got.curSys, 'audit');
  assert.equal(got.ctxVer, '2026-07-28');
  assert.equal(got.curSite, '乙医院');
  assert.equal(got.leftActiveKind, 'consult');
  assert.equal(got.leftActiveId, 'ZX-17');
});

test('医院视图：医院 + 子项目 + 按批次组合恢复', () => {
  const normalize = makeNormalize(refState());
  const got = normalize({ nav: { mode: 'hosp', curSite: '甲医院', curSub: 'audit', groupBy: 'batch' } });
  assert.deepEqual(
    { mode: got.mode, curSite: got.curSite, curSub: got.curSub, groupBy: got.groupBy },
    { mode: 'hosp', curSite: '甲医院', curSub: 'audit', groupBy: 'batch' },
  );
});

test('系统视图：实时系统列表是恢复事实源，project 字段与 me.projects 形状不同也不误清', () => {
  const normalize = makeNormalize(refState());
  const got = normalize({ nav: { mode: 'sys', curSys: 'secret', ctxVer: '2026-08-10' } });
  assert.equal(got.curSys, 'secret', '端点已返回的合法系统必须按稳定 name 恢复');
  assert.equal(got.ctxVer, '2026-08-10');
});

test('过期/越权导航值安全回退，不会用已不在实时列表的旧值进入空白界面', () => {
  const normalize = makeNormalize(refState());
  const got = normalize({
    nav: { mode: 'other', curSite: '越权医院', curSub: 'deleted', curSys: 'deleted-system', groupBy: 'weird', ctxVer: 'stale' },
    leftActive: { kind: 'admin', id: 99 },
  });
  assert.equal(got.mode, 'hosp');
  assert.equal(got.curSite, '甲医院', '无效医院回退到当前分配列表第一家');
  assert.equal(got.curSub, '', '已删除子项目回退全部子项目');
  assert.equal(got.curSys, null, '已不在 /api/field/systems 实时列表的系统不恢复');
  assert.equal(got.ctxVer, null, '系统无效时不带出旧版本');
  assert.equal(got.groupBy, 'type');
  assert.equal(got.leftActiveKind, '');
  assert.equal(got.leftActiveId, '');
});

test('版本在真实版本列表就绪后二次校验：有效保留，失效回退最新', () => {
  const pick = new Function(extractFn(FIELD, 'pickRestoredVersion') + '\nreturn pickRestoredVersion;')();
  assert.equal(pick('2026-07-28', ['2026-08-01', '2026-07-28']), '2026-07-28');
  assert.equal(pick('deleted', ['2026-08-01', '2026-07-28']), '2026-08-01');
  assert.equal(pick('deleted', []), null);
});

test('完整对话恢复：kind/deep/消息/已建单/水位/会话 id/输入不丢', () => {
  const state = { leftActiveKind: 'consult', leftActiveId: 'ZX-1' };
  const chat = {};
  const input = { value: '' };
  const bubbles = [];
  const cards = [];
  let selectedKind = '';
  const restore = new Function(
    'state', 'chat', '$', 'readDraft', 'newSessionId', 'clearPlaceholder', 'appendBubble', 'appendArchiveCard', 'renderSavedConversation', 'setSubmitKind', 'normalizeKbRefs', 'renderKbCite',
    extractFn(FIELD, 'restoreDraft') + '\nreturn restoreDraft;',
  )(state, chat, () => input, () => null, () => 'new-session', () => {}, (role, text) => { bubbles.push([role, text]); return {}; }, (info) => cards.push(info), () => { chat.messages.forEach((m) => bubbles.push([m.role === 'user' ? 'me' : 'ai', m.content])); cards.push(...chat.builtTickets); }, (kind) => { selectedKind = kind; }, () => [], () => {});
  const ok = restore({
    kind: 'consult', deep: true,
    messages: [{ role: 'user', content: '问题' }, { role: 'assistant', content: '答案' }],
    savedId: 'XQ-1', builtTickets: [{ id: 'XQ-1' }], filedUpTo: 1,
    convId: 'ZX-1', sessionId: 'session-1', reopenProject: 'p1', input: '还没发送',
  });
  assert.equal(ok, true);
  assert.equal(selectedKind, 'consult'); assert.equal(chat.deep, true);
  assert.equal(chat.messages.length, 2); assert.equal(chat.builtTickets.length, 1);
  assert.equal(chat.filedUpTo, 1); assert.equal(chat.convId, 'ZX-1'); assert.equal(chat.sessionId, 'session-1');
  assert.equal(input.value, '还没发送');
  assert.deepEqual(bubbles, [['me', '问题'], ['ai', '答案']]);
  assert.equal(cards.length, 1, '恢复时重建已建单卡');
});

test('多单会话刷新恢复：builtTickets 按消息锚点与保存顺序完整重建、同 id 去重，savedId 只兜底', () => {
  const chat = {
    savedId: 'XQ-1',
    messages: [
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '答复1' },
      { role: 'user', content: '问题2' },
      { role: 'assistant', content: '答复2' },
    ],
    builtTickets: [
      { id: 'XQ-1', type: 'requirement', site: '甲医院', project: 'p1', afterMessageIndex: 2 },
      { id: 'BG-2', type: 'bug', site: '甲医院', project: 'p1', afterMessageIndex: 2 },
      { id: 'XQ-1', type: 'requirement', site: '重复项' },
      { id: 'XQ-3', type: 'requirement', site: '甲医院', project: 'p1', afterMessageIndex: 4 },
    ],
  };
  const cards = [], timeline = [];
  const render = new Function(
    'chat', 'appendArchiveCard', 'appendBubble', 'normalizeKbRefs', 'renderKbCite',
    extractFn(FIELD, 'normalizeBuiltTickets') + '\n' + extractFn(FIELD, 'renderSavedConversation') + '\nreturn renderSavedConversation;',
  )(
    chat,
    (info) => { cards.push(info); timeline.push('card:' + info.id); },
    (role, content) => { timeline.push('msg:' + content); return {}; },
    () => [],
    () => {},
  );
  render('fallback-project');
  assert.deepEqual(cards.map((x) => x.id), ['XQ-1', 'BG-2', 'XQ-3']);
  assert.deepEqual(timeline, ['msg:问题1', 'msg:答复1', 'card:XQ-1', 'card:BG-2', 'msg:问题2', 'msg:答复2', 'card:XQ-3']);
  assert.equal(cards[0].site, '甲医院');
  assert.equal(cards[1].type, 'bug');

  chat.builtTickets = [];
  cards.length = 0; timeline.length = 0;
  render('fallback-project');
  assert.deepEqual(cards.map((x) => x.id), ['XQ-1'], '老草稿无 builtTickets 时才回退 savedId');
  assert.equal(timeline.at(-1), 'card:XQ-1', '老草稿兜底卡贴在消息末尾');
});

test('草稿 payload 保存导航、提交类型、deep 和左侧选中态', () => {
  const state = { me: { username: 'impl' }, mode: 'sys', curSite: '甲医院', curSub: '', curSys: 'audit', groupBy: 'batch', ctxVer: '2026-07-28', leftActiveKind: 'consult', leftActiveId: 'ZX-1' };
  const chat = { submitKind: 'consult', messages: [], builtTickets: [], deep: true };
  const build = new Function('state', 'chat', '$', extractFn(FIELD, 'buildDraftPayload') + '\nreturn buildDraftPayload;')(state, chat, () => ({ value: '草稿' }));
  const d = build();
  assert.deepEqual(d.nav, { mode: 'sys', curSite: '甲医院', curSub: '', curSys: 'audit', groupBy: 'batch', ctxVer: '2026-07-28' });
  assert.deepEqual(d.leftActive, { kind: 'consult', id: 'ZX-1' });
  assert.equal(d.kind, 'consult'); assert.equal(d.deep, true); assert.equal(d.input, '草稿'); assert.equal(d.user, 'impl');
  assert.equal('password' in d, false, '不存密码/token');
});

test('新对话只清对话并保留导航，且会立即覆盖保存空对话', () => {
  const state = { mode: 'sys', curSite: '甲医院', curSub: '', curSys: 'audit', groupBy: 'batch', ctxVer: '2026-07-28' };
  const before = { ...state };
  const chat = { sending: false, abortCtrl: null, bySystem: { 'sys:audit': { messages: ['old'] } }, lastSystemKey: 'sys:audit', messages: ['old'], builtTickets: ['old'], deep: true };
  let saves = 0;
  const box = { innerHTML: 'old', appendChild() {} };
  const newConversation = new Function(
    'state', 'chat', 'newSessionId', 'chatBox', 'document', '$', 'clearPendingImages', 'markLeftActive', 'setSending', 'syncDeep', 'updateScope', 'saveDraft',
    extractFn(FIELD, 'newConversation') + '\nreturn newConversation;',
  )(state, chat, () => 'new-session', () => box, { createElement: () => ({ className: '', id: '', innerHTML: '' }) }, () => ({ value: 'old' }), () => {}, () => {}, () => {}, () => {}, () => {}, () => { saves++; });
  newConversation();
  assert.deepEqual(state, before, '导航上下文不被重置');
  assert.deepEqual(chat.messages, []); assert.equal(chat.sessionId, 'new-session'); assert.equal(chat.deep, false);
  assert.equal(chat.bySystem['sys:audit'], undefined, '只删当前会话桶');
  assert.equal(saves, 1, '新的空对话与原导航被立即保存');
});

test('退出登录清除全部对话桶和 sessionStorage 草稿', () => {
  const chat = { bySystem: { a: {}, b: {} }, lastSystemKey: 'a' };
  const calls = [];
  const clear = new Function('chat', 'newConversation', 'clearDraft', extractFn(FIELD, 'clearFieldSessionForLogout') + '\nreturn clearFieldSessionForLogout;')(
    chat,
    () => calls.push('newConversation'),
    () => calls.push('clearDraft'),
  );
  clear();
  assert.deepEqual(chat.bySystem, {}); assert.equal(chat.lastSystemKey, null);
  assert.deepEqual(calls, ['newConversation', 'clearDraft'], '先重置 UI/对话，再移除整份草稿');
});

test('初始化接线顺序：引用数据后先校验导航、再渲染视图、最后恢复对话', () => {
  const body = extractFn(FIELD, 'enterWorkspace');
  const p1 = body.indexOf('applyNavigationDraft(draft)');
  const p2 = body.indexOf('renderRestoredNavigation()');
  const p3 = body.indexOf('restoreDraft(draft)');
  assert.ok(p1 >= 0 && p1 < p2 && p2 < p3, '恢复顺序必须固定');
  assert.equal(body.includes('onHospitalChange();'), false, '初始化不先切默认医院清空 curSub');
  assert.equal(body.includes('syncConversationToSystem();'), false, '恢复前不切会话桶');
});
