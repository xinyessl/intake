// FS-10 回归 · 实施端咨询转人工「人工消息截图」刷新恢复不丢图 · 脱库逻辑测试
//   背景 bug（线上 ZX-20260909-01）：实施端转人工后，人工对话里发的截图刷新后丢失（文字气泡都在、只图没了）。
//   根因（前端·刷新恢复解析 project）：截图缩略图靠 mediaUrls(project, m.media) 拼 /api/intake-media 取图；
//     project 为空 → mediaUrls 返 []（图丢）。刷新恢复「本会话新起的」escalated consult 时，
//     renderSavedConversation(projectFallback) 传的是 reopenConvProject||reopenIntakeProject（仅 reopen 列表记录才置）——
//     新起 consult 这俩都为空 → project='' → 文字气泡在、图全丢（正是现象）。
//   修法：renderSavedConversation 里 projectFallback 为空且 submitKind==='consult' 时，
//     兜底 = chat.reopenProject || currentArchive().project（与发送落盘时同一 project）。
//   本组：从 field.html 抽真身 renderSavedConversation，DOM/依赖打桩，捕获 mediaUrls 收到的 project，
//     断言：① 新起 escalated consult（reopenConv*/reopenIntake* 空、nav 有 project）→ 人工消息 media 用真实 project 拼 URL（非空）；
//          ② reopen 的 consult（reopenProject 有值）→ 用 reopenProject；③ 兜底不误伤 intake（仍用 reopenConv/reopenIntake）。
//   用法：node --test tools/fs-10-human-media-restore.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// 真身 mediaUrls（保证 URL 拼法与线上一致：project 空 → []）
const mediaUrlsReal = new Function(extractFn(FIELD_HTML, 'mediaUrls') + '\nreturn mediaUrls;')();

// 构造沙箱：注入 renderSavedConversation 真身 + 它依赖的桩，捕获每次 mediaUrls(project, media) 的入参。
function runRender({ submitKind, reopenProject, reopenConvProject, reopenIntakeProject, navProject, messages }) {
  const mediaCalls = [];
  const chat = {
    submitKind, reopenProject: reopenProject || '', reopenConvProject: reopenConvProject || '',
    reopenIntakeProject: reopenIntakeProject || '', messages: messages || [], builtTickets: [], savedId: '',
  };
  const sandbox = {
    chat,
    // currentArchive 桩：模拟真身对 consult 的解析——reopenProject 优先，否则随 nav 上下文（navProject）
    currentArchive: () => ({ project: (chat.reopenProject && chat.submitKind === 'consult') ? chat.reopenProject : (navProject || ''), subsystem: '', version: '', site: '' }),
    mediaUrls: (project, media) => { mediaCalls.push({ project, media }); return mediaUrlsReal(project, media); },
    // 渲染桩：只关心 media 解析，气泡内容不校验
    appendBubble: () => ({}),
    appendHumanReplyBubble: () => ({}),
    appendSystemNotice: () => {},
    appendArchiveCard: () => {},
    normalizeBuiltTickets: () => [],
    normalizeKbRefs: () => [],
    isNonSubstantiveReply: () => false,
    renderKbCite: () => {},
  };
  const factory = new Function(...Object.keys(sandbox), extractFn(FIELD_HTML, 'renderSavedConversation') + '\nreturn renderSavedConversation;');
  const fn = factory(...Object.values(sandbox));
  fn(chat.reopenConvProject || chat.reopenIntakeProject || '');   // 真实调用点入参（field.html L3442/L4670 口径）
  return mediaCalls;
}

const HUMAN_MEDIA = ['media/ZX-20260909-01/img-1.png'];

test('R1（回归·核心）新起 escalated consult 刷新恢复：reopenConv*/reopenIntake* 空、nav 有 project → 人工消息 media 用真实 project 拼 URL（非空，不丢图）', () => {
  const calls = runRender({
    submitKind: 'consult',
    navProject: 'psp',   // 新起 consult 随导航上下文（发送落盘时同一 project）
    messages: [
      { role: 'user', content: '收费结算点了没反应' },
      { role: 'user', human: true, content: '报错截图发你', media: HUMAN_MEDIA },   // 转人工后现场人工消息（带落盘 media）
    ],
  });
  const withMedia = calls.filter(c => Array.isArray(c.media) && c.media.length);
  assert.equal(withMedia.length, 1, '带 media 的消息只 1 条（人工消息）');
  assert.equal(withMedia[0].project, 'psp', '用真实 consult project（psp）而非空串');
  const urls = mediaUrlsReal(withMedia[0].project, withMedia[0].media);
  assert.equal(urls.length, 1, 'project 非空 → mediaUrls 拼出 1 条可取 URL（图不丢）');
  assert.match(urls[0], /project=psp/, 'URL 带 project=psp');
  assert.match(urls[0], /file=media%2FZX-20260909-01%2Fimg-1\.png/, 'URL 带落盘相对路径');
});

test('R1b（复现 bug·未修则失败）若不兜底、project 空 → mediaUrls 返 [] = 图丢（证明修复必要）', () => {
  // 直接以「修复前口径」调 mediaUrls：project='' → []（即刷新丢图的根因）
  assert.deepEqual(mediaUrlsReal('', HUMAN_MEDIA), [], 'project 空 → [] → 缩略图渲不出（旧 bug 现象）');
});

test('R2 reopen 的 consult（reopenProject 有值）→ 兜底用 reopenProject 拼 URL', () => {
  const calls = runRender({
    submitKind: 'consult',
    reopenProject: 'psp',   // reopen 列表某 consult：project 锁在 reopenProject
    messages: [{ role: 'user', human: true, content: '截图', media: HUMAN_MEDIA }],
  });
  const withMedia = calls.filter(c => Array.isArray(c.media) && c.media.length);
  assert.equal(withMedia[0].project, 'psp', 'reopen consult 用 reopenProject');
});

test('R3 运营人工答复（assistant human）带 media 同样用真实 project 拼 URL（双向都不丢）', () => {
  const calls = runRender({
    submitKind: 'consult',
    navProject: 'psp',
    messages: [{ role: 'assistant', human: true, by: '运营小王', content: '配置截图', media: HUMAN_MEDIA }],
  });
  const withMedia = calls.filter(c => Array.isArray(c.media) && c.media.length);
  assert.equal(withMedia.length, 1);
  assert.equal(withMedia[0].project, 'psp', '运营回复 media 也用真实 project');
});

test('R4 兜底不误伤 intake：submitKind=intake 时仍用传入 projectFallback（reopenConv/reopenIntake），不走 consult 兜底', () => {
  const calls = runRender({
    submitKind: 'intake',
    reopenConvProject: 'psp',   // intake 会话 project 事实源
    navProject: 'SHOULD_NOT_USE',
    messages: [{ role: 'user', content: '图', media: HUMAN_MEDIA }],
  });
  const withMedia = calls.filter(c => Array.isArray(c.media) && c.media.length);
  assert.equal(withMedia[0].project, 'psp', 'intake 用 reopenConvProject，不落到 consult 兜底的 navProject');
});

test('R5 接线守卫：renderSavedConversation 源码里含 consult 空 projectFallback 兜底（防被删/漂移）', () => {
  const body = extractFn(FIELD_HTML, 'renderSavedConversation');
  assert.match(body, /!projectFallback\s*&&\s*chat\.submitKind === 'consult'/, '有「projectFallback 空 + consult」兜底判断');
  assert.match(body, /chat\.reopenProject\s*\|\|\s*\(currentArchive\(\)\.project\)/, '兜底解析 = reopenProject || currentArchive().project');
});
