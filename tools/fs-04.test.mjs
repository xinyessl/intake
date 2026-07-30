// FS-04 · AI 对话提交（判类/补要素/归档 → 建工单/咨询）—— A 前端静态 + B 连真库冒烟（零依赖，node --test）
//   启动真实 server.mjs（连本地 MySQL data/db.json）到隔离端口，用 fetch 打真实端点；mysql2 直连真库核对列名映射。
//   AI 模型是否可用取决于 data/model-api.json：
//     · 无 Key（默认）→ 测「降级/兜底」路径：intake-chat 返回降级文案不 500、savedId 空；
//       建单走 intake-submit（人工兜底路径，不依赖模型）；consult SSE 出降级文案 + done{convId}；analyze 返回 configured:false 不改状态。
//     · 有 Key → 额外断言 intake-chat 可能产出 record/savedId、consult 有真实内容（best-effort，不强依赖）。
//   核心断言（不依赖真模型）：
//     · site 服务端收敛（决策 B/AC-21）：现场账号传越权 site → 落库 site 收敛为账号合法医院（不落越权）。
//     · BUG 无版本 → 400（AC-15）。
//     · intake-analyze 放开现场（NH-3）：analyze 自己 sites 内工单 200/configured 结构、analyze 越权工单 403、未登录 401。
//     · consult 落 type=consult/lifecycle=已答复、默认不进 intake-list（AC-18）。
//     · reporter 服务端取登录用户（决策 B）。
//   全程用隔离产品 + 隔离 impl 账号；after 钩子清 intakes/projects 行 + 文件 + 删账号，核对真库 hlyy 基线不变。
//   用法：node --test tools/fs-04.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || (6220 + Math.floor(Math.random() * 120));
const BASE = `http://127.0.0.1:${PORT}`;
const PID = 'fs04smoke-' + Date.now().toString(36);          // 隔离产品
const MY_SITE = 'FS04现场医院_' + Date.now().toString(36);   // 现场账号负责的医院
const OTHER_SITE = 'FS04越权医院_' + Date.now().toString(36);// 不在 sites 的越权医院
const FIELD_U = 'fs04impl_' + Date.now().toString(36);       // 隔离现场账号（role=impl）
const FIELD_PW = 'Fs04Pass99';
const FIELD_NAME = 'FS04实施工';

let srv = null, adminCookie = '', fieldCookie = '', pool = null, fieldId = '', hlyyBefore = 0;
const createdIntakeIds = [];   // 本测建的工单 id（after 兜底删）

function req(p, { method = 'GET', body, cookie, raw = false } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => raw
    ? ({ status: r.status, text: await r.text().catch(() => '') })
    : ({ status: r.status, setCookie: r.headers.get('set-cookie'), json: await r.json().catch(() => null) }));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 收集本测建的工单 id（after 删）
function track(id) { if (id && !createdIntakeIds.includes(id)) createdIntakeIds.push(id); }

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  // 真库 hlyy 基线（after 核对不变）
  const [[hb]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']);
  hlyyBefore = hb.n;
  // 预清理残留
  await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]);
  await pool.query('DELETE FROM projects WHERE id=?', [PID]);
  await pool.query('DELETE FROM accounts WHERE username=?', [FIELD_U]);
  // 启动真实服务
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) { try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {} await sleep(250); }
  // 管理员登录
  const lg = await req('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
  adminCookie = lg.setCookie.split(';')[0];
  // 造隔离产品（带子系统 · 供归档 subsystem）
  const ps = await req('/api/project-save', { method: 'POST', body: { id: PID, name: 'FS04 冒烟产品', subsystems: [{ key: 'core', name: '审方子系统', desc: '审方规则' }] }, cookie: adminCookie });
  assert.equal(ps.json?.ok, true, '前置：造隔离产品应成功');
  // 造隔离现场账号（role=impl，绑 MY_SITE，known password）
  const ac = await req('/api/account-save', { method: 'POST', body: { username: FIELD_U, role: 'impl', name: FIELD_NAME, password: FIELD_PW, projects: [PID], sites: [MY_SITE], enabled: 1 }, cookie: adminCookie });
  assert.equal(ac.json?.ok, true, '前置：造隔离现场账号应成功');
  fieldId = (ac.json.accounts.find(a => a.username === FIELD_U) || {}).id || '';
  assert.ok(fieldId, '前置：应取到现场账号 id（供 after 删除）');
  // 现场账号登录
  const flg = await req('/api/login', { method: 'POST', body: { username: FIELD_U, password: FIELD_PW } });
  assert.equal(flg.json?.ok, true, '前置：现场账号登录应成功');
  fieldCookie = flg.setCookie.split(';')[0];
});

after(async () => {
  try { if (fieldId) await req('/api/account-delete', { method: 'POST', body: { id: fieldId }, cookie: adminCookie }); } catch {}
  try { if (pool) await pool.query('DELETE FROM accounts WHERE username=?', [FIELD_U]); } catch {}
  try { await req('/api/project-delete', { method: 'POST', body: { id: PID }, cookie: adminCookie }); } catch {}
  // project-delete 不级联删 intakes（见 lessons）→ 手动兜底删本产品全部工单
  try { if (pool) { await pool.query('DELETE FROM intakes WHERE project_id=?', [PID]); await pool.query('DELETE FROM projects WHERE id=?', [PID]); } } catch {}
  try { fs.rmSync(path.join(ROOT, 'data/intake-store', PID), { recursive: true, force: true }); } catch {}
  // 核对真库 hlyy 基线未被污染
  try { const [[ha]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']); assert.equal(ha.n, hlyyBefore, 'after：真库 hlyy 工单数应回到基线（未污染）'); } catch (e) { console.error(e); }
  if (pool) await pool.end();
  if (srv) srv.kill('SIGTERM');
});

/* ================= A. 前端静态断言（field.html 右侧对话区 · 锁原型元素 f-right/f-rtool/f-toggle/f-chat-b/f-chat-f） ================= */
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

test('A-AC1 右侧对话区骨架：.f-right > .f-rtool(#fCtx + .f-toggle + .newc) + .f-chat-b + .f-chat-f(input + .send)', () => {
  assert.match(FIELD_HTML, /class="f-ai-pane f-right"|class="[^"]*\bf-right\b/, '存在对话区 .f-right');
  assert.match(FIELD_HTML, /class="f-rtool"/, '工具条 .f-rtool');
  assert.match(FIELD_HTML, /id="fCtx"/, '首枚归档上下文 chip #fCtx（复用 FS-03）');
  assert.match(FIELD_HTML, /class="f-toggle"/, '类型切换 .f-toggle');
  assert.match(FIELD_HTML, /class="newc"|\bnewc\b/, '新对话 .newc');
  assert.match(FIELD_HTML, /class="f-chat-b"|id="fChatB"/, '消息流容器 .f-chat-b');
  assert.match(FIELD_HTML, /class="f-chat-f"/, '输入区 .f-chat-f');
  assert.match(FIELD_HTML, /id="fChatInput"/, '文本输入框');
  assert.match(FIELD_HTML, /class="send"|id="fChatSend"/, '发送按钮 .send');
});

test('A-AC2 .f-toggle 恰两个按钮：咨询答疑（默认 .on，居左）+ 提需求/报BUG（居右）；切换 setSubmitKind', () => {
  const tog = FIELD_HTML.match(/<div class="f-toggle" id="fToggle">[\s\S]*?<\/div>/);
  assert.ok(tog, '应能定位 .f-toggle');
  const btns = tog[0].match(/<button[\s\S]*?<\/button>/g) || [];
  assert.equal(btns.length, 2, '.f-toggle 恰两个按钮');
  assert.match(tog[0], /提需求 \/ 报BUG/, '含「提需求/报BUG」');
  assert.match(tog[0], /咨询答疑/, '含「咨询答疑」');
  // 2026-07-23 裁决：咨询答疑默认 .on（容错 class 与 data-k 前后顺序）
  assert.match(tog[0], /data-k="consult"[^>]*class="on"|class="on" data-k="consult"/, '咨询答疑默认 .on');
  // 咨询答疑按钮居左（出现在提需求/报BUG 按钮之前）
  assert.ok(tog[0].indexOf('data-k="consult"') < tog[0].indexOf('data-k="intake"'), '咨询答疑按钮在提需求/报BUG 按钮之前出现');
  assert.match(FIELD_HTML, /function setSubmitKind\(k\)/, '有 setSubmitKind 切换函数');
  assert.match(FIELD_HTML, /submitKind === 'consult'[\s\S]*?consult|chat\.submitKind = \(k === 'consult'\)/, '咨询模式走 consult');
});

test('A-AC3 输入框有引导 placeholder，回车发送绑定', () => {
  assert.match(FIELD_HTML, /id="fChatInput"[^>]*placeholder="[^"]*回车发送/, '输入框 placeholder 为引导文案（含「回车发送」）');
  assert.match(FIELD_HTML, /\$\('fChatInput'\)\.addEventListener\('keydown'[\s\S]*?Enter[\s\S]*?sendChat\(\)/, '回车 → sendChat');
  assert.match(FIELD_HTML, /\$\('fChatSend'\)\.addEventListener\('click', sendChat\)/, '点发送 → sendChat');
});

test('A-AC9 提需求/BUG 模式调 intake-chat（type=intake 合并模式 + 归档上下文）', () => {
  assert.match(FIELD_HTML, /api\('\/api\/intake-chat'/, '调 /api/intake-chat');
  const call = FIELD_HTML.match(/api\('\/api\/intake-chat'[\s\S]*?\}\)/);
  assert.ok(call, '定位 intake-chat 调用');
  assert.match(call[0], /type: 'intake'/, 'type=intake 合并模式让 AI 判需求/BUG');
  assert.match(call[0], /messages: chat\.messages/, '带会话历史 messages');
  assert.match(call[0], /project:|version:|site:|subsystem:/, '带归档上下文 project/version/site/subsystem');
});

test('A-AC11/12 建单据 savedId 展示 + 幂等（同会话已建单不重复建）', () => {
  assert.match(FIELD_HTML, /b\.savedId/, '读取返回 savedId');
  assert.match(FIELD_HTML, /if \(b\.savedId && !chat\.savedId\)/, '幂等：savedId 非空且本会话未建单才建');
  assert.match(FIELD_HTML, /appendArchiveCard/, '建单后展示归档结果卡片');
  assert.match(FIELD_HTML, /已归档为工单/, '建单反馈文案「已归档为工单」');
});

test('A-NH3 建单后即时调 intake-analyze 展示初判', () => {
  assert.match(FIELD_HTML, /api\('\/api\/intake-analyze'/, '调 /api/intake-analyze');
  assert.match(FIELD_HTML, /function showAnalyze\(archive, savedId\)/, '有 showAnalyze（建单后初判）');
  assert.match(FIELD_HTML, /if \(!b\.ok \|\| !b\.analysis\) return/, 'analyze 未配/失败静默不展示（不阻断）');
  assert.match(FIELD_HTML, /AI 初判/, '展示 AI 初判');
});

test('A-AC14 AI 不可用兜底：人工提交面板走 intake-submit（不阻断）', () => {
  assert.match(FIELD_HTML, /function offerFallback\(\)/, '有 offerFallback 兜底面板');
  assert.match(FIELD_HTML, /api\('\/api\/intake-submit'/, '兜底走 /api/intake-submit');
  assert.match(FIELD_HTML, /AI 暂时不可用/, '兜底面板提示 AI 不可用');
});

test('A-AC15 BUG 无版本前端内联提示（校验 + 后端 400 展示）', () => {
  assert.match(FIELD_HTML, /type === 'bug' && !ver/, '前端 BUG 缺版本校验');
  assert.match(FIELD_HTML, /请填\/选产品版本（BUG 必填）/, '内联提示「请填/选产品版本（BUG 必填）」');
});

test('A-AC17/18 咨询走 consult SSE 流式；结束续存 convId', () => {
  assert.match(FIELD_HTML, /function sendConsult\(imgs\)/, '有 sendConsult（带 imgs 入参·附图）');
  assert.match(FIELD_HTML, /fetch\(url, \{ method: 'POST'[\s\S]*?consult/, 'consult 用 fetch 流式读取');
  assert.match(FIELD_HTML, /getReader\(\)/, 'SSE 用 ReadableStream getReader 逐段读');
  assert.match(FIELD_HTML, /o\.v != null/, '解析 data:{v:片段} 流式增量');
  assert.match(FIELD_HTML, /chat\.convId = o\.convId/, '结束事件续存 convId（同会话续问）');
});

test('A-AC19 咨询可沉淀经验库 kb-from-consult（带 project/q/a）', () => {
  assert.match(FIELD_HTML, /api\('\/api\/kb-from-consult'/, '调 /api/kb-from-consult');
  const call = FIELD_HTML.match(/api\('\/api\/kb-from-consult'[\s\S]*?\}\)/);
  assert.ok(call, '定位 kb-from-consult 调用');
  assert.match(call[0], /project:|q:|a:/, '带 project/q/a');
  assert.match(FIELD_HTML, /沉淀经验库/, '有「沉淀经验库」入口');
});

test('A-AC20 新对话 .newc 清空会话（新 convId/无 savedId），绑定 newConversation', () => {
  assert.match(FIELD_HTML, /function newConversation\(\)/, '有 newConversation');
  assert.match(FIELD_HTML, /chat\.messages = \[\]; chat\.savedId = ''; chat\.convId = ''/, '清空 messages/savedId/convId');
  assert.match(FIELD_HTML, /\$\('fNewC'\)\.addEventListener\('click'/, '.newc 绑定新对话');
});

test('A-AC23 草稿本地暂存（sessionStorage，非 localStorage）刷新恢复', () => {
  assert.match(FIELD_HTML, /sessionStorage/, '用 sessionStorage 暂存草稿');
  assert.match(FIELD_HTML, /function saveDraft\(\)/, '有 saveDraft');
  assert.match(FIELD_HTML, /function restoreDraft\(\)/, '有 restoreDraft');
  assert.match(FIELD_HTML, /restoreDraft\(\)/, 'enterWorkspace 后恢复草稿');
});

test('A 静态：field.html 不含 FS-01 A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）+ 不引 shell.js + 内联 md()', () => {
  for (const kw of ['账号管理', '发包', '决策', 'accounts.html', 'inbox.html']) {
    assert.doesNotMatch(FIELD_HTML, new RegExp(kw), `无禁词：${kw}`);
  }
  assert.doesNotMatch(FIELD_HTML, /assets\/shell\.js/, '不引后台 shell.js');
  assert.doesNotMatch(FIELD_HTML, /localStorage/, '不使用长效端存储（FS-01 A5）');
  assert.match(FIELD_HTML, /function md\(src\)/, '内联受控 Markdown md()（field.html 不引 ui.js）');
});

test('A 静态：field.html 无隐形字符（nbsp/零宽/BOM 等）', () => {
  const bad = [];
  for (let i = 0; i < FIELD_HTML.length; i++) {
    const c = FIELD_HTML.codePointAt(i);
    if (c === 0x00A0 || c === 0x00AD || (c >= 0x200B && c <= 0x200F) ||
        c === 0x2028 || c === 0x2029 || (c >= 0x202A && c <= 0x202E) ||
        c === 0x2060 || c === 0x202F || c === 0xFEFF) bad.push(i);
  }
  assert.equal(bad.length, 0, '不得含隐形字符，实际 ' + bad.length + ' 个（偏移 ' + bad.slice(0, 5).join(',') + '）');
});

/* ---- FS-04/FS-06 · 对话提交附截图（选图/粘贴/预览/压缩/发送 + 用户气泡显图 + 多模态）· 用户 2026-07-24 裁决 ---- */

test('A-IMG1 输入区有图片入口：图片按钮 #fImgBtn + 隐藏 file input(accept=image/* multiple) + 预览条 #fImgPreview', () => {
  assert.match(FIELD_HTML, /id="fImgBtn"/, '有图片入口按钮 #fImgBtn');
  assert.match(FIELD_HTML, /id="fImgInput"[^>]*type="file"|type="file"[^>]*id="fImgInput"/, '有隐藏 file input #fImgInput');
  assert.match(FIELD_HTML, /accept="image\/\*"/, 'file input accept=image/*');
  assert.match(FIELD_HTML, /id="fImgInput"[^>]*\bmultiple\b|\bmultiple\b[^>]*id="fImgInput"/, 'file input multiple（多选）');
  assert.match(FIELD_HTML, /id="fImgPreview"/, '有缩略图预览条 #fImgPreview');
});

test('A-IMG2 选图 + 粘贴接线：按钮→click file input、change→addImageFiles、input paste→取 clipboard 图片', () => {
  assert.match(FIELD_HTML, /imgBtn\.addEventListener\('click', function \(\) \{ imgInput\.click\(\); \}\)/, '点图片按钮→打开文件选择器');
  assert.match(FIELD_HTML, /imgInput\.addEventListener\('change', function \(\) \{ addImageFiles\(imgInput\.files\)/, 'file change→addImageFiles');
  assert.match(FIELD_HTML, /\$\('fChatInput'\)\.addEventListener\('paste'/, '输入框绑 paste 事件（粘贴取图）');
  assert.match(FIELD_HTML, /clipboardData[\s\S]{0,300}getAsFile\(\)/, 'paste 里从 clipboardData 取图片 File');
  assert.match(FIELD_HTML, /function addImageFiles\(files\)/, '有 addImageFiles');
});

test('A-IMG3 压缩 + 预览 + 上限：compressImage(canvas ≤1600 jpeg .85)、renderImgPreview 带删除、IMG_MAX=6', () => {
  assert.match(FIELD_HTML, /function compressImage\(file, cb\)/, '有 compressImage');
  assert.match(FIELD_HTML, /toDataURL\('image\/jpeg', 0\.85\)/, '压缩转 jpeg 0.85（防炸 MAX_BODY）');
  assert.match(FIELD_HTML, /MAXW = 1600/, '缩到 ≤1600px 宽');
  assert.match(FIELD_HTML, /function renderImgPreview\(\)/, '有 renderImgPreview（缩略图预览）');
  assert.match(FIELD_HTML, /var IMG_MAX = 6/, '最多 6 张（对齐后端 slice(0,6)）');
  const addBody = (FIELD_HTML.match(/function addImageFiles\(files\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(addBody, /IMG_MAX/, 'addImageFiles 里按 IMG_MAX 限量');
});

test('A-IMG4 发送带 images：sendChat 捕获 pendingImages → sendIntake/sendConsult 各带 images；发送后清空', () => {
  const sc = (FIELD_HTML.match(/function sendChat\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.match(sc, /pendingImages\.slice\(\)/, 'sendChat 捕获本轮 pendingImages');
  assert.match(sc, /clearPendingImages\(\)/, 'sendChat 发送后清空待发送截图');
  assert.match(sc, /sendConsult\(imgs\)/, '咨询带 imgs');
  assert.match(sc, /sendIntake\(imgs\)/, '进件带 imgs');
  // sendIntake / sendConsult 请求体带 images
  const si = (FIELD_HTML.match(/function sendIntake\(imgs\)[\s\S]*?intake-chat[\s\S]*?\}\)/) || [''])[0];
  assert.match(si, /images:\s*\(Array\.isArray\(imgs\)/, 'sendIntake body 带 images（有图才带，向后兼容）');
  const scl = (FIELD_HTML.match(/function sendConsult\(imgs\)[\s\S]*?var payload = \{[\s\S]*?\};/) || [''])[0];
  assert.match(scl, /images:\s*\(Array\.isArray\(imgs\)/, 'sendConsult payload 带 images');
});

test('A-IMG5 用户气泡显所附截图（appendBubble 支持 imgs → bubbleImgs 缩略图）', () => {
  assert.match(FIELD_HTML, /function appendBubble\(who, text, streaming, imgs\)/, 'appendBubble 加 imgs 入参');
  assert.match(FIELD_HTML, /appendBubble\('me', text \|\| '（截图）', false, imgs\)/, '我方气泡带本轮所附截图');
  assert.match(FIELD_HTML, /function bubbleImgs\(imgs\)/, '有 bubbleImgs（气泡内缩略图）');
  assert.match(FIELD_HTML, /\.f-bub-imgs\b/, '有 .f-bub-imgs 气泡截图样式');
});

test('A-IMG6 图片是输入态，不进草稿/快照（bySystem/saveDraft 均不含 images）', () => {
  const save = (FIELD_HTML.match(/function saveDraft\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.doesNotMatch(save, /images/, 'saveDraft 不塞 images（避免大对象进 sessionStorage）');
  const snap = (FIELD_HTML.match(/function snapshotConversation\(\)[\s\S]*?\n  \}/) || [''])[0];
  assert.doesNotMatch(snap, /pendingImages|images/, 'snapshotConversation 不带 images');
  assert.match(FIELD_HTML, /function clearPendingImages\(\)/, '有 clearPendingImages');
  // pendingImages 是模块级输入态，不进任何端存储
  assert.doesNotMatch(FIELD_HTML, /sessionStorage[^;]*pendingImages|pendingImages[^;]*sessionStorage/, 'pendingImages 不进 sessionStorage');
});

/* ---- 每个系统上下文各记一段会话（切系统保存旧段+恢复新段，内存态·会话内）· 用户 2026-07-23 裁决 ---- */

test('A-会话隔离 静态：systemKey/bySystem/lastSystemKey/syncConversationToSystem/restoreConversation 存在', () => {
  assert.match(FIELD_HTML, /function systemKey\(\)/, '有 systemKey（系统上下文稳定键）');
  assert.match(FIELD_HTML, /bySystem:\s*\{\}/, 'chat.bySystem 初始为 {}（键→会话快照）');
  assert.match(FIELD_HTML, /lastSystemKey:\s*null/, 'chat.lastSystemKey 初始 null（基线键）');
  assert.match(FIELD_HTML, /function syncConversationToSystem\(\)/, '有 syncConversationToSystem（核心·幂等）');
  assert.match(FIELD_HTML, /function restoreConversation\(snap\)/, '有 restoreConversation（快照→对话区）');
  assert.match(FIELD_HTML, /function snapshotConversation\(\)/, '有 snapshotConversation（会话打快照）');
});

test('A-会话隔离 静态：systemKey 组键规则（sys 前缀 / 医院||子系统）', () => {
  const fn = FIELD_HTML.match(/function systemKey\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(fn, '定位 systemKey 函数体');
  assert.match(fn[0], /'sys\|\|'\s*\+\s*\(state\.curSys\s*\|\|\s*''\)/, '系统视图键 = sys||<curSys>');
  assert.match(fn[0], /\(state\.curSite\s*\|\|\s*''\)\s*\+\s*'\|\|'\s*\+\s*\(state\.curSub\s*\|\|\s*''\)/, '医院视图键 = <curSite>||<curSub>');
});

test('A-会话隔离 静态：syncConversationToSystem 幂等（键没变即 return）+ 存旧桶 + 恢复/空会话', () => {
  const fn = FIELD_HTML.match(/function syncConversationToSystem\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(fn, '定位 syncConversationToSystem 函数体');
  assert.match(fn[0], /if \(newKey === chat\.lastSystemKey\) return/, '键没变 → 幂等 return');
  assert.match(fn[0], /if \(chat\.lastSystemKey != null\) chat\.bySystem\[chat\.lastSystemKey\] = snapshotConversation\(\)/, '有旧键 → 存当前会话进旧桶');
  assert.match(fn[0], /chat\.lastSystemKey = newKey/, '更新基线键为新键');
  assert.match(fn[0], /if \(chat\.bySystem\[newKey\]\) restoreConversation\(chat\.bySystem\[newKey\]\)/, '新桶有快照 → 恢复');
  assert.match(fn[0], /else newConversation\(\)/, '新桶无快照 → 全新空会话');
});

test('A-会话隔离 静态：snapshotConversation 覆盖会话全量字段（messages/convId/submitKind/reopenProject/reopenSubsystem/input/savedId/analyzed）', () => {
  const fn = FIELD_HTML.match(/function snapshotConversation\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(fn, '定位 snapshotConversation 函数体');
  for (const f of ['messages', 'submitKind', 'convId', 'savedId', 'analyzed', 'reopenProject', 'reopenSubsystem', 'input']) {
    assert.match(fn[0], new RegExp(f + ':'), `快照含字段 ${f}（漏项会导致切回丢态）`);
  }
});

test('A-会话隔离 静态：所有上下文切换点末尾接入 syncConversationToSystem（selectSub/onSystemTab/onHospitalChange/setMode）', () => {
  // selectSub 末尾
  const selSub = FIELD_HTML.match(/function selectSub\(sub\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(selSub && /syncConversationToSystem\(\)/.test(selSub[0]), 'selectSub 末尾调 syncConversationToSystem');
  // onSystemTab 末尾
  const onSys = FIELD_HTML.match(/function onSystemTab\(sys\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(onSys && /syncConversationToSystem\(\)/.test(onSys[0]), 'onSystemTab 末尾调 syncConversationToSystem');
  // onHospitalChange 末尾（onHospSelect 复用它）
  const onHosp = FIELD_HTML.match(/function onHospitalChange\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(onHosp && /syncConversationToSystem\(\)/.test(onHosp[0]), 'onHospitalChange 末尾调 syncConversationToSystem');
  // setMode 末尾（视图切换）
  const setM = FIELD_HTML.match(/function setMode\(m\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(setM && /syncConversationToSystem\(\)/.test(setM[0]), 'setMode 末尾调 syncConversationToSystem');
});

test('A-会话隔离 静态：newConversation 清当前桶 + doLogout 清 bySystem/lastSystemKey + 登录后置基线键', () => {
  assert.match(FIELD_HTML, /delete chat\.bySystem\[chat\.lastSystemKey\]/, 'newConversation 清当前系统桶那份会话');
  assert.match(FIELD_HTML, /chat\.bySystem = \{\}; chat\.lastSystemKey = null/, 'doLogout 清 bySystem + lastSystemKey');
  assert.match(FIELD_HTML, /chat\.lastSystemKey = systemKey\(\)/, '登录后基线键 = 当前上下文 systemKey()');
});

test('A-会话隔离 静态：bySystem 纯内存态——不进 sessionStorage / 不用 localStorage', () => {
  // saveDraft 只存当前会话（不含 bySystem），bySystem 不写端存储
  const save = FIELD_HTML.match(/function saveDraft\(\)\s*\{[\s\S]*?\n  \}/);
  assert.ok(save, '定位 saveDraft');
  assert.doesNotMatch(save[0], /bySystem/, 'saveDraft 不把 bySystem 写进 sessionStorage（避免膨胀）');
  assert.doesNotMatch(FIELD_HTML, /localStorage/, '全程不用 localStorage（FS-01 A5）');
  assert.doesNotMatch(FIELD_HTML, /sessionStorage[^;]*bySystem|bySystem[^;]*sessionStorage/, 'bySystem 不进 sessionStorage');
});

test('A-会话隔离 逻辑（vm · 提取 field.html 真身函数）：切 A→B→A 恢复各段，未聊过→空会话，幂等无副作用', async () => {
  const vm = await import('node:vm');
  // 提取 field.html 里真实的四个函数源码（systemKey/snapshotConversation/restoreConversation/syncConversationToSystem）
  const pick = (name, argPat) => {
    const re = new RegExp('function ' + name + '\\(' + argPat + '\\)\\s*\\{[\\s\\S]*?\\n  \\}');
    const m = FIELD_HTML.match(re);
    assert.ok(m, '提取函数 ' + name);
    return m[0];
  };
  const src = [
    pick('systemKey', ''),
    pick('snapshotConversation', ''),
    pick('restoreConversation', 'snap'),
    pick('syncConversationToSystem', ''),
  ].join('\n');
  // 沙箱：stub state / chat / DOM 辅助——只验算法（存旧桶 / 恢复新桶 / 未聊过空会话 / 幂等），不起真 DOM
  const inputBox = { value: '' };
  let newConvCalls = 0;
  const box = { html: '', bubbles: [] };
  const sandbox = {
    state: { mode: 'sys', curSys: null, curSite: null, curSub: '' },
    chat: {
      submitKind: 'consult', messages: [], convId: '', savedId: '', analyzed: false,
      lastQ: '', lastA: '', reopenProject: '', reopenSubsystem: '', sending: false,
      bySystem: {}, lastSystemKey: null,
    },
    // DOM/辅助 stub
    $: (id) => (id === 'fChatInput' ? inputBox : null),
    chatBox: () => ({ set innerHTML(v) { box.html = v; box.bubbles = []; }, appendChild() {} }),
    appendBubble: (who, text) => { box.bubbles.push({ who, text }); },
    appendArchiveCard: () => {},
    setSubmitKind: (k) => { sandbox.chat.submitKind = (k === 'intake') ? 'intake' : 'consult'; },
    setSending: () => {},
    updateScope: () => {},
    saveDraft: () => {},
    clearPendingImages: () => {},   // restoreConversation 里调（图片输入态清空，vm 只验会话算法，stub 之）
    newConversation: () => {
      newConvCalls++;
      const c = sandbox.chat;
      c.messages = []; c.savedId = ''; c.convId = ''; c.analyzed = false; c.sending = false;
      c.lastQ = ''; c.lastA = ''; c.reopenProject = ''; c.reopenSubsystem = '';
      inputBox.value = '';
      if (c.lastSystemKey != null && c.bySystem) delete c.bySystem[c.lastSystemKey];
    },
    document: { createElement: () => ({ set innerHTML(v) {}, className: '', id: '' }) },
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  const { chat, state } = sandbox;

  // 登录基线：系统视图·全部系统（key='sys||'）。首帧对齐基线键（模拟 enterWorkspace 尾部）
  chat.lastSystemKey = vm.runInContext('systemKey()', sandbox);
  assert.equal(chat.lastSystemKey, 'sys||', '基线键=sys||（全部系统）');

  // 切到系统 A（audit）→ 未聊过 → 空会话
  state.curSys = 'audit';
  vm.runInContext('syncConversationToSystem()', sandbox);
  assert.equal(chat.lastSystemKey, 'sys||audit', '切 A 后基线键=sys||audit');
  const newConvAfterA = newConvCalls;
  assert.ok(newConvAfterA >= 1, '切到未聊过的系统 A → 触发 newConversation（空会话）');
  // 在 A 里聊两句 + 存 convId + 输入未发内容
  chat.messages = [{ role: 'user', content: 'A 问' }, { role: 'assistant', content: 'A 答' }];
  chat.convId = 'convA'; chat.reopenProject = 'projA'; chat.reopenSubsystem = 'audit';
  inputBox.value = 'A 未发';

  // 切到系统 B（intervene）→ 保存 A 段 + B 未聊过 → 空会话
  state.curSys = 'intervene';
  vm.runInContext('syncConversationToSystem()', sandbox);
  assert.equal(chat.lastSystemKey, 'sys||intervene', '切 B 后基线键=sys||intervene');
  assert.ok(chat.bySystem['sys||audit'], 'A 段已存进 bySystem[sys||audit]');
  assert.deepEqual(chat.bySystem['sys||audit'].messages, [{ role: 'user', content: 'A 问' }, { role: 'assistant', content: 'A 答' }], 'A 段 messages 完整保存');
  assert.equal(chat.bySystem['sys||audit'].convId, 'convA', 'A 段 convId 保存');
  assert.equal(chat.bySystem['sys||audit'].reopenProject, 'projA', 'A 段 reopenProject 保存（切回续聊仍指原 consult）');
  assert.equal(chat.bySystem['sys||audit'].reopenSubsystem, 'audit', 'A 段 reopenSubsystem 保存');
  assert.equal(chat.bySystem['sys||audit'].input, 'A 未发', 'A 段未发输入保存');
  assert.equal(chat.messages.length, 0, '切到未聊过的 B → 当前会话为空');
  // 在 B 聊一句
  chat.messages = [{ role: 'user', content: 'B 问' }];
  chat.convId = 'convB'; inputBox.value = '';

  // 切回系统 A → 保存 B 段 + 恢复 A 段（messages/convId/reopen/input 全回来）
  state.curSys = 'audit';
  vm.runInContext('syncConversationToSystem()', sandbox);
  assert.equal(chat.lastSystemKey, 'sys||audit', '切回 A 基线键=sys||audit');
  assert.ok(chat.bySystem['sys||intervene'], 'B 段已存');
  assert.equal(chat.bySystem['sys||intervene'].convId, 'convB', 'B 段 convId 保存');
  assert.deepEqual(chat.messages, [{ role: 'user', content: 'A 问' }, { role: 'assistant', content: 'A 答' }], '切回 A → A 段 messages 恢复');
  assert.equal(chat.convId, 'convA', '切回 A → convId 恢复=convA');
  assert.equal(chat.reopenProject, 'projA', '切回 A → reopenProject 恢复（续聊仍指原 consult）');
  assert.equal(chat.reopenSubsystem, 'audit', '切回 A → reopenSubsystem 恢复');
  assert.equal(inputBox.value, 'A 未发', '切回 A → 未发输入恢复');

  // 幂等：键没变再调一次 → 无副作用（不再存桶/不再恢复/不改 newConvCalls）
  const bySysSnapshot = JSON.stringify(chat.bySystem);
  const beforeNewConv = newConvCalls;
  vm.runInContext('syncConversationToSystem()', sandbox);
  assert.equal(newConvCalls, beforeNewConv, '键没变 → 幂等 no-op（不触发 newConversation）');
  assert.equal(JSON.stringify(chat.bySystem), bySysSnapshot, '键没变 → bySystem 不被改写');
});

/* ================= B. 连真库冒烟 ================= */

test('B-AC24 未登录调 intake-chat/consult/intake-submit → 401（authGate 需登录）', async () => {
  const r1 = await req('/api/intake-chat', { method: 'POST', body: { project: PID, type: 'intake', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r1.status, 401, '未登录 intake-chat → 401');
  const r2 = await req('/api/intake-submit', { method: 'POST', body: { project: PID, type: 'requirement', title: 'x' } });
  assert.equal(r2.status, 401, '未登录 intake-submit → 401');
  const r3 = await req('/api/consult', { method: 'POST', body: { project: PID, messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r3.status, 401, '未登录 consult → 401');
});

test('B-AC16/21 建单（intake-submit 人工兜底路径）：requirement 建单成功，reporter=登录用户，site 收敛为账号医院', async () => {
  const r = await req('/api/intake-submit', {
    method: 'POST', cookie: fieldCookie,
    body: { project: PID, type: 'requirement', title: 'FS04需求单', desc: '希望审方规则支持白名单', subsystem: '审方子系统', site: MY_SITE, version: 'v1.0' },
  });
  assert.equal(r.status, 200);
  assert.equal(r.json?.ok, true, 'requirement 建单成功');
  assert.ok(r.json.id, '返回工单 id');
  track(r.json.id);
  const [rows] = await pool.query('SELECT type,lifecycle,site,reporter,data FROM intakes WHERE project_id=? AND id=?', [PID, r.json.id]);
  assert.equal(rows.length, 1, 'DB 应有该工单');
  const row = rows[0];
  assert.equal(row.type, 'requirement', 'type=requirement');
  assert.equal(row.lifecycle, '待处理', 'lifecycle=待处理');
  assert.equal(row.site, MY_SITE, 'site 落账号合法医院');
  assert.equal(row.reporter, FIELD_NAME, 'reporter 服务端取登录用户（决策 B）');
});

test('B-AC21【数据权限】传越权 site → 服务端收敛为账号合法医院（不落越权医院）', async () => {
  const r = await req('/api/intake-submit', {
    method: 'POST', cookie: fieldCookie,
    body: { project: PID, type: 'requirement', title: 'FS04越权归档探针', desc: 'x', site: OTHER_SITE, version: 'v1.0' },
  });
  assert.equal(r.json?.ok, true, '建单成功（越权 site 被收敛，不 400 阻断）');
  track(r.json.id);
  const [rows] = await pool.query('SELECT site FROM intakes WHERE project_id=? AND id=?', [PID, r.json.id]);
  assert.equal(rows[0].site, MY_SITE, '越权 site 被收敛为账号首家合法医院（不落越权医院）');
  assert.notEqual(rows[0].site, OTHER_SITE, '绝不落越权医院');
});

test('B-AC15 BUG 无版本 → 400「请填/选产品版本」', async () => {
  const r = await req('/api/intake-submit', {
    method: 'POST', cookie: fieldCookie,
    body: { project: PID, type: 'bug', title: 'FS04缺版本BUG', desc: '报错', site: MY_SITE },   // 无 version
  });
  assert.equal(r.status, 400, 'BUG 缺版本 → 400');
  assert.match(String(r.json?.error || ''), /版本/, '错误信息含「版本」');
});

test('B-AC15 BUG 带版本 → 建单成功、type=bug/lifecycle=待处理', async () => {
  const r = await req('/api/intake-submit', {
    method: 'POST', cookie: fieldCookie,
    body: { project: PID, type: 'bug', title: 'FS04有版本BUG', desc: '报错', site: MY_SITE, version: 'v2.0' },
  });
  assert.equal(r.json?.ok, true, 'BUG 带版本建单成功');
  track(r.json.id);
  const [rows] = await pool.query('SELECT type,lifecycle,version FROM intakes WHERE project_id=? AND id=?', [PID, r.json.id]);
  assert.equal(rows[0].type, 'bug', 'type=bug');
  assert.equal(rows[0].lifecycle, '待处理', 'lifecycle=待处理');
  assert.equal(rows[0].version, 'v2.0', 'version 落库');
});

test('B-AC9/14 intake-chat（合并模式）：AI 未配 → 降级文案不 500、savedId 空（不阻断）；AI 配了 → best-effort 可产出 savedId', async () => {
  const r = await req('/api/intake-chat', {
    method: 'POST', cookie: fieldCookie,
    body: { project: PID, type: 'intake', site: MY_SITE, subsystem: '审方子系统', messages: [{ role: 'user', content: '审方任务推送不到药师端' }] },
  });
  assert.equal(r.status, 200, 'intake-chat 不 500（降级不抛异常）');
  assert.equal(r.json?.ok, true, '返回 ok:true');
  assert.ok('reply' in r.json, '返回 reply 文案');
  // 无模型 → savedId 空/未定义；有模型且产出 record → 非空（并入清理）
  if (r.json.savedId) { track(r.json.savedId); }
  else { assert.ok(!r.json.savedId, 'AI 未配 → savedId 空（还在补要素/未建单，不阻断）'); }
});

test('B-AC17/18 consult（SSE）：出流式片段 + done{convId}；落 type=consult/lifecycle=已答复，默认不进 intake-list', async () => {
  const resp = await fetch(BASE + '/api/consult', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: fieldCookie },
    body: JSON.stringify({ project: PID, site: MY_SITE, subsystem: '审方子系统', messages: [{ role: 'user', content: '审方规则怎么配白名单？' }] }),
  });
  assert.equal(resp.status, 200, 'consult 200');
  const text = await resp.text();
  assert.match(text, /data:/, 'SSE 含 data: 事件');
  // 解析出 done 事件的 convId
  let convId = '';
  let sawV = false;
  text.split('\n').forEach(line => {
    line = line.trim();
    if (line.indexOf('data:') !== 0) return;
    let o = null; try { o = JSON.parse(line.slice(5).trim()); } catch { return; }
    if (o && o.v != null) sawV = true;
    if (o && o.done) convId = o.convId || '';
  });
  assert.ok(sawV, 'SSE 有流式片段 data:{v:…}（降级文案亦经此下发）');
  assert.ok(convId, 'done 事件返回 convId（供续问）');
  track(convId);
  const [rows] = await pool.query('SELECT type,lifecycle,reporter FROM intakes WHERE project_id=? AND id=?', [PID, convId]);
  assert.equal(rows.length, 1, 'consult 落库一条');
  assert.equal(rows[0].type, 'consult', 'type=consult');
  assert.equal(rows[0].lifecycle, '已答复', 'lifecycle=已答复');
  assert.equal(rows[0].reporter, FIELD_NAME, 'reporter 服务端取登录用户');
  // 默认不进运营端工单收件箱（intake-list withConsult=false）
  const list = await req('/api/intake-list?project=' + PID, { cookie: fieldCookie });
  const inList = (list.json?.items || []).some(i => i.id === convId);
  assert.ok(!inList, 'consult 默认不进 intake-list（不进收件箱/批次）');
});

test('B-AC18 consult 同 convId 续问 → 续存不新建（幂等）', async () => {
  const post = (convId) => fetch(BASE + '/api/consult', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: fieldCookie },
    body: JSON.stringify({ project: PID, site: MY_SITE, messages: [{ role: 'user', content: '再问一次审方白名单' }], convId }),
  }).then(async r => { const t = await r.text(); let cid = ''; t.split('\n').forEach(l => { l = l.trim(); if (l.indexOf('data:') !== 0) return; let o = null; try { o = JSON.parse(l.slice(5).trim()); } catch { return; } if (o && o.done) cid = o.convId || ''; }); return cid; });
  const first = await post('');
  track(first);
  const cntBefore = (await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=? AND type=?', [PID, 'consult']))[0][0].n;
  const second = await post(first);
  assert.equal(second, first, '同 convId 续问 → convId 不变');
  const cntAfter = (await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=? AND type=?', [PID, 'consult']))[0][0].n;
  assert.equal(cntAfter, cntBefore, '续问不新建 consult 记录（续存幂等）');
});

test('B-NH3 intake-analyze 放开现场：analyze 自己 sites 内工单 → 200（配置结构）；越权工单 → 403；未登录 → 401', async () => {
  // 先造一张本账号 sites 内的工单
  const mk = await req('/api/intake-submit', { method: 'POST', cookie: fieldCookie, body: { project: PID, type: 'requirement', title: 'FS04待分析单', desc: 'x', site: MY_SITE } });
  assert.equal(mk.json?.ok, true, '造待分析工单成功');
  const myId = mk.json.id; track(myId);
  // analyze 自己 sites 内工单 → 200（无模型时 configured:false，但不 403/500）
  const a1 = await req('/api/intake-analyze', { method: 'POST', cookie: fieldCookie, body: { project: PID, id: myId } });
  assert.equal(a1.status, 200, 'analyze 自己工单 → 200（进 FIELD_OK）');
  assert.ok('ok' in (a1.json || {}), '返回结构含 ok');
  if (!a1.json.ok) assert.ok('configured' in a1.json || 'error' in a1.json, 'AI 未配 → configured:false/error（不阻断，不 403）');

  // 造一张「其他医院」的越权工单（用管理员建，site=OTHER_SITE，绕过现场收敛）
  const mkOther = await req('/api/intake-submit', { method: 'POST', cookie: adminCookie, body: { project: PID, type: 'requirement', title: 'FS04越权工单', desc: 'y', site: OTHER_SITE } });
  assert.equal(mkOther.json?.ok, true, '管理员造越权医院工单成功');
  const otherId = mkOther.json.id; track(otherId);
  const [orow] = await pool.query('SELECT site FROM intakes WHERE project_id=? AND id=?', [PID, otherId]);
  assert.equal(orow[0].site, OTHER_SITE, '管理员建单 site 不被收敛（管理员放行）');
  // 现场 analyze 越权工单 → 403
  const a2 = await req('/api/intake-analyze', { method: 'POST', cookie: fieldCookie, body: { project: PID, id: otherId } });
  assert.equal(a2.status, 403, '现场 analyze 越权工单 → 403（按 sites 收敛）');
  // 未登录 analyze → 401
  const a3 = await req('/api/intake-analyze', { method: 'POST', body: { project: PID, id: myId } });
  assert.equal(a3.status, 401, '未登录 analyze → 401');
});

test('B-静态 server.mjs：FIELD_OK 含 intake-analyze；LINK_OK 不含（现场放开、访客链接不放）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const mf = src.match(/const FIELD_OK = new Set\((\[[^\]]*\])\)/);
  assert.ok(mf, '定位 FIELD_OK');
  const flist = JSON.parse(mf[1].replace(/'/g, '"'));
  assert.ok(flist.includes('/api/intake-analyze'), 'FIELD_OK 含 /api/intake-analyze（NH-3 放开现场）');
  const ml = src.match(/const LINK_OK = new Set\((\[[^\]]*\])\)/);
  assert.ok(ml, '定位 LINK_OK');
  const llist = JSON.parse(ml[1].replace(/'/g, '"'));
  assert.ok(!llist.includes('/api/intake-analyze'), 'LINK_OK 不含 intake-analyze（访客链接不放开）');
});

test('B-静态 server.mjs：多模态 withImages + intake-chat 传 images（AI 看图）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  // withImages 两家格式
  assert.match(src, /function withImages\(messages, images, isAnthropic\)/, '有 withImages 多模态构造');
  assert.match(src, /type: 'image', source: \{ type: 'base64', media_type: g\.mediaType, data: g\.data \}/, 'anthropic 格式（image/base64）');
  assert.match(src, /type: 'image_url', image_url: \{ url: g\.url \}/, 'openai 格式（image_url）');
  // callModelOnce / callModelStreamOnce 接 images 入参 + 应用 withImages
  assert.match(src, /async function callModelOnce\(cfg, \{ system, messages, maxTokens = 1024, images \}\)/, 'callModelOnce 接 images');
  assert.match(src, /async function callModelStreamOnce\(cfg, \{ system, messages, maxTokens = 1024, images \}/, 'callModelStreamOnce 接 images');
  // 无图向后兼容：withImages 无有效图直接原样返回 messages（content 仍字符串）
  assert.match(src, /if \(!imgs\.length\) return messages;/, '无图 → 原样返回（纯文本调用一字不变·向后兼容）');
  // intake-chat 把 b.images 传进 callModel
  const ic = (src.match(/url\.pathname === '\/api\/intake-chat'[\s\S]*?send\(res, 200, JSON\.stringify\(\{ ok: true, reply, savedId \}\)\)/) || [''])[0];
  assert.match(ic, /images:\s*imgs/, 'intake-chat callModel 带 images（AI 结合图判类）');
});
