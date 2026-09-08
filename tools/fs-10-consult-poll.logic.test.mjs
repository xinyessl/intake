// FS-10（实时性增强）· 咨询轻量轮询 · 脱库逻辑测试
//   背景：实施端「转人工」后运营在「咨询回复」页答复，但两端都无轮询 → 要手动刷新才见。走轻量轮询（非 socket）。
//   本组：① 从 field.html 抽真身函数 detectNewHumanReplies 沙箱跑「新人工回复」检测逻辑（比对 last-seen humanReplyAt）；
//        ② 静态接线断言两页都有 setInterval(15~20s) + visibilitychange 可见门控 + inFlight 防并发 + clearInterval 清理；
//        ③ field 命中新回复时提醒/append/徽标翻新，运营端轮询不盖开着的回复抽屉；
//        ④ server /api/field/conversations consult 项透出 humanReplyAt。
//   用法：node --test tools/fs-10-consult-poll.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');
const CR_HTML = fs.readFileSync(path.join(ROOT, 'public/consult-reply.html'), 'utf8');

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
const detectNewHumanReplies = new Function(extractFn(FIELD_HTML, 'detectNewHumanReplies') + '\nreturn detectNewHumanReplies;')();

/* ================= A. 「新人工回复」检测逻辑（field 端核心，脱库沙箱跑真身函数） ================= */
test('A1 首帧 baseline 只建基线、不误报历史回复', () => {
  const items = [
    { kind: 'consult', id: 'c1', humanReplied: true, humanReplyAt: '2026-09-01 10:00' },
    { kind: 'consult', id: 'c2', humanReplied: false, humanReplyAt: '' },
  ];
  const res = detectNewHumanReplies(items, null, true);
  assert.deepEqual(res.fresh, [], 'baseline 帧不提醒任何历史回复');
  assert.equal(res.next.c1, '2026-09-01 10:00', 'baseline 记下 c1 时间戳');
  assert.equal(res.next.c2, '', 'c2 未回复记空');
});

test('A2 待回复→出现人工回复（humanReplyAt 首次出现）判为新', () => {
  const last = { c1: '', c2: '' };
  const items = [
    { kind: 'consult', id: 'c1', humanReplied: true, humanReplyAt: '2026-09-03 09:00' },
    { kind: 'consult', id: 'c2', humanReplied: false, humanReplyAt: '' },
  ];
  const res = detectNewHumanReplies(items, last, false);
  assert.equal(res.fresh.length, 1, '只 c1 是新回复');
  assert.equal(res.fresh[0].id, 'c1');
});

test('A3 运营再补一条（humanReplyAt 时间戳变化）也判为新', () => {
  const last = { c1: '2026-09-03 09:00' };
  const items = [{ kind: 'consult', id: 'c1', humanReplied: true, humanReplyAt: '2026-09-03 11:30' }];
  const res = detectNewHumanReplies(items, last, false);
  assert.equal(res.fresh.length, 1, '时间戳变化 = 新回复');
  assert.equal(res.next.c1, '2026-09-03 11:30');
});

test('A4 同一时间戳（无变化）不重复提醒', () => {
  const last = { c1: '2026-09-03 09:00' };
  const items = [{ kind: 'consult', id: 'c1', humanReplied: true, humanReplyAt: '2026-09-03 09:00' }];
  const res = detectNewHumanReplies(items, last, false);
  assert.equal(res.fresh.length, 0, '未变化不提醒');
});

test('A5 老数据无 humanReplyAt 但 humanReplied → 用占位标记，仍能判首次变已回复', () => {
  const last = { c1: '' };
  const items = [{ kind: 'consult', id: 'c1', humanReplied: true, humanReplyAt: '' }];
  const res = detectNewHumanReplies(items, last, false);
  assert.equal(res.fresh.length, 1, '老数据首次变已回复也提醒');
  assert.equal(res.next.c1, '__replied__', '占位标记入 next（下轮不再重复）');
  // 下一轮同态不再报
  const res2 = detectNewHumanReplies(items, res.next, false);
  assert.equal(res2.fresh.length, 0);
});

test('A6 非 consult 项（intake 会话）忽略', () => {
  const res = detectNewHumanReplies([{ kind: 'intake', id: 'x', humanReplyAt: '2026-09-03 09:00' }], { x: '' }, false);
  assert.equal(res.fresh.length, 0, 'intake 项不参与人工回复检测');
});

/* ================= B. field.html 轮询机制静态接线（防回归/漂移） ================= */
test('B1 field 有 setInterval，间隔在 15~20s', () => {
  const m = FIELD_HTML.match(/HR_POLL_MS\s*=\s*(\d+)/);
  assert.ok(m, '应定义 HR_POLL_MS');
  const ms = Number(m[1]);
  assert.ok(ms >= 15000 && ms <= 20000, `轮询间隔应 15~20s，实为 ${ms}`);
  assert.ok(/_hrTimer\s*=\s*setInterval\(/.test(FIELD_HTML), '用 setInterval 起轮询');
});
test('B2 field 仅可见时轮 + 切回可见立即拉一次', () => {
  assert.ok(/setInterval\(function \(\) \{ if \(document\.visibilityState === 'visible'\) pollHumanReplies/.test(FIELD_HTML), 'interval 内 visibilityState 门控');
  assert.ok(/addEventListener\('visibilitychange'/.test(FIELD_HTML), '有 visibilitychange 监听');
  assert.ok(/document\.visibilityState === 'visible' && _hrTimer\) pollHumanReplies\(false\)/.test(FIELD_HTML), '切回可见立即拉一次');
});
test('B3 field inFlight 防并发', () => {
  assert.ok(/if \(_hrInFlight\) return;/.test(FIELD_HTML), 'pollHumanReplies 开头判 inFlight');
  assert.ok(/_hrInFlight = true;/.test(FIELD_HTML) && /_hrInFlight = false;/.test(FIELD_HTML), 'inFlight 置位/复位成对');
});
test('B4 field 登出/卸载 clearInterval 清理', () => {
  assert.ok(/function stopHumanReplyPoll\(\) \{ if \(_hrTimer\) \{ clearInterval\(_hrTimer\)/.test(FIELD_HTML), 'stopHumanReplyPoll 内 clearInterval');
  assert.ok(/stopHumanReplyPoll\(\);\s*\/\/ FS-10：登出清/.test(FIELD_HTML), '登出调 stopHumanReplyPoll');
  assert.ok(/beforeunload'.*stopHumanReplyPoll/.test(FIELD_HTML), 'beforeunload 清理');
});
test('B5 field 进工作空间起轮询、命中时提醒 + 开着才 append + 顺带刷待办', () => {
  assert.ok(/startHumanReplyPoll\(\);\s*\/\/ FS-10/.test(FIELD_HTML), 'enterWorkspace 起轮询');
  assert.ok(/showToast\('运营已回复你的咨询'/.test(FIELD_HTML), '命中新回复 toast 提醒');
  assert.ok(/if \(chat\.convId && chat\.convId === it\.id\) appendNewHumanReply/.test(FIELD_HTML), '仅当该咨询正开着才 append');
  assert.ok(/appendHumanReplyBubble\(m\.text \|\| '', m\.by \|\| '', urls\)/.test(FIELD_HTML), 'append 复用 FS-10 人工回复气泡');
  assert.ok(/try \{ loadTodo\(\); \} catch \(e\) \{\}/.test(FIELD_HTML), '顺带刷新待办计数');
});
test('B6 field append 只补新增 human 气泡（防重复），不重建对话流/不动输入框', () => {
  assert.ok(/box\.querySelectorAll\('\.f-human-reply'\)\.length/.test(FIELD_HTML), '按已渲染 human 气泡数定位增量');
  assert.ok(/for \(var i = already; i < humans\.length; i\+\+\)/.test(FIELD_HTML), '只 append 新增部分');
  assert.ok(!/box\.innerHTML = ''/.test(extractFn(FIELD_HTML, 'appendNewHumanReply')), 'appendNewHumanReply 不清空对话区');
});

/* ================= C. consult-reply.html 队列轮询静态接线 ================= */
test('C1 运营端有 setInterval，间隔 15~20s', () => {
  const m = CR_HTML.match(/QUEUE_POLL_MS\s*=\s*(\d+)/);
  assert.ok(m, '应定义 QUEUE_POLL_MS');
  const ms = Number(m[1]);
  assert.ok(ms >= 15000 && ms <= 20000, `队列轮询间隔应 15~20s，实为 ${ms}`);
  assert.ok(/_qTimer\s*=\s*setInterval\(/.test(CR_HTML), '用 setInterval');
});
test('C2 运营端仅可见时轮 + 切回可见立即拉', () => {
  assert.ok(/setInterval\(function\(\)\{ if\(document\.visibilityState==='visible'\) pollQueue\(\); \}/.test(CR_HTML), 'interval 内可见门控');
  assert.ok(/addEventListener\('visibilitychange',function\(\)\{ if\(document\.visibilityState==='visible'&&_qTimer\) pollQueue/.test(CR_HTML), '切回可见立即拉');
});
test('C3 运营端 inFlight 防并发 + clearInterval 清理', () => {
  assert.ok(/if\(_qInFlight\) return;/.test(CR_HTML), 'pollQueue 判 inFlight');
  assert.ok(/_qInFlight=true;/.test(CR_HTML) && /_qInFlight=false;/.test(CR_HTML), 'inFlight 成对');
  assert.ok(/function stopQueuePoll\(\)\{ if\(_qTimer\)\{ clearInterval\(_qTimer\)/.test(CR_HTML), 'stopQueuePoll clearInterval');
  assert.ok(/beforeunload',function\(\)\{ stopQueuePoll\(\); \}/.test(CR_HTML), 'beforeunload 清理');
});
test('C4 运营端轮询不盖开着的回复抽屉', () => {
  assert.ok(/if\(isReplyDrawerOpen\(\)\) return;\s*\/\/ 回复抽屉开着/.test(CR_HTML), '抽屉开着 → 跳过静默刷新');
  assert.ok(/if\(isReplyDrawerOpen\(\)\) return;\s*\/\/ 请求期间运营打开了抽屉/.test(CR_HTML), '请求期间打开抽屉也放弃渲染');
  assert.ok(/startQueuePoll\(\);/.test(CR_HTML), 'init 起队列轮询');
});
test('C5 运营端拆出 renderQueue（静默渲染不带「加载中…」占位）', () => {
  assert.ok(/function renderQueue\(items\)\{/.test(CR_HTML), '拆出 renderQueue');
  const poll = extractFn(CR_HTML, 'pollQueue');
  assert.ok(!/tbody\.innerHTML=.*加载中/.test(poll) && !/cr-empty">加载中/.test(poll), 'pollQueue 静默渲染不显「加载中…」占位行');
  assert.ok(/tbody\.innerHTML='<tr><td colspan="6" class="cr-empty">加载中…/.test(extractFn(CR_HTML, 'loadQueue')), '仅手动 loadQueue 显加载占位');
});

/* ================= D. server /api/field/conversations consult 项透出 humanReplyAt ================= */
test('D1 conversations consult 项返回 humanReplyAt（判新所需）', () => {
  assert.ok(/kind: 'consult',[^}]*humanReplyAt: e\.humanReplyAt \|\| ''/.test(SRC), 'consult 项透出 humanReplyAt');
});

/* ================= E. consult-reply 状态徽标样式修复（不折行、pill 不变形） ================= */
test('E1 .cr-status 加 white-space:nowrap + flex 不折行', () => {
  assert.ok(/\.cr-status \{[^}]*white-space:nowrap/.test(CR_HTML), '.cr-status white-space:nowrap');
  assert.ok(/\.cr-status \{[^}]*flex:0 0 auto/.test(CR_HTML), '.cr-status flex:0 0 auto');
  assert.ok(/\.cr-status i \{ flex:0 0 auto; \}/.test(CR_HTML), '图标 flex:0 0 auto 不被压缩');
});
test('E2 状态列放宽到 110px 容「已回复」+图标一行', () => {
  assert.ok(/width:110px;min-width:110px">状态/.test(CR_HTML), '状态列 110px + min-width');
});
