// MC-01 · 模型配置 —— 接口 + 连真机文件冒烟测试（零依赖，node --test）
//   模型配置走文件存储 data/model-api.json（不入库、不碰 MySQL 表）。本测试：
//     · 启动真实 server.mjs（连本地 MySQL data/db.json，仅用于账号/会话；模型配置本身走文件）到隔离端口；
//     · 用 fetch 打真实端点 /api/model-config、/api/model-config-save、/api/model-test；
//     · 断言：掩码不泄漏明文、切主/唯一主、删除、空 Key + mask 保留旧值、provider 中文↔存储值映射。
//     · 前端静态断言：public/model-config.html 落原型（整宽 data-table + 编辑抽屉 + 自写抽屉开关）。
//   为避免污染真实配置：before 备份 data/model-api.json（含"不存在"态），after 完整还原。
//   model-test 只断言"无 Key / 无效 baseUrl → {ok:false}"错误分支，绝不真烧外部 API Key。
//   2026-07-21 re-target 原型：前端由「两栏卡片」→「整宽 data-table + 抽屉」，后端契约不变，
//   故接口用例（AC-2..11）全部沿用；仅新增前端静态断言（AC-1/E2E）。
//   用法：node --test tools/mc-01.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5300 + Math.floor(Math.random() * 600);
const BASE = `http://127.0.0.1:${PORT}`;
const CFG_FILE = path.join(ROOT, 'data', 'model-api.json');
let srv = null, cookie = '', backup = { existed: false, raw: '' };

function api(p, { method = 'GET', body } = {}) {
  return fetch(BASE + p, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }).then(async r => {
    const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
function readCfgFile() { try { return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')); } catch { return null; } }
// 复刻服务端 maskKey（server.mjs L58）用于独立断言掩码格式，不 import（server.mjs 未导出内部函数）
function maskKey(k) { k = String(k || ''); return k.length > 8 ? (k.slice(0, 4) + '……' + k.slice(-4)) : (k ? '已配置' : ''); }

before(async () => {
  // 备份现有模型配置文件（可能不存在），测试跑完 after 里完整还原
  try { backup = { existed: true, raw: fs.readFileSync(CFG_FILE, 'utf8') }; } catch { backup = { existed: false, raw: '' }; }
  srv = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT), BIND: '127.0.0.1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) break; } catch {}
    await sleep(250);
  }
  const lg = await api('/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(lg.json?.ok, true, '前置：管理员登录应成功（admin/admin123）');
});

after(async () => {
  // 完整还原模型配置文件到测试前状态（避免搞乱真实 Key / 配置）
  try {
    if (backup.existed) fs.writeFileSync(CFG_FILE, backup.raw);
    else { try { fs.unlinkSync(CFG_FILE); } catch {} }
  } catch {}
  if (srv) srv.kill('SIGTERM');
});

/* ============ 鉴权（写/测限管理员：deny-by-default 白名单） ============ */
test('MC 写/测端点非登录态 → 401 need-login（authGate 未把 save/test 列入白名单）', async () => {
  const saved = cookie; cookie = '';
  const s = await api('/api/model-config-save', { method: 'POST', body: { models: [] } });
  const t = await api('/api/model-test', { method: 'POST', body: { provider: 'anthropic', model: 'x', baseUrl: '', apiKey: '' } });
  const g = await api('/api/model-config');
  cookie = saved;
  assert.equal(s.status, 401, 'model-config-save 未登录应 401');
  assert.equal(t.status, 401, 'model-test 未登录应 401');
  assert.equal(g.status, 401, 'model-config 未登录/无 link → 401（LINK_OK 仅对提交链接身份放行）');
});

/* ============ AC-1（列表视图）+ AC-11（安全）：空配置 modelsOf → [] ============ */
test('AC-1/AC-11 GET /api/model-config：空配置返回 models:[]，含兼容单模型平铺字段，无明文', async () => {
  // 先清空到已知空态
  const clr = await api('/api/model-config-save', { method: 'POST', body: { models: [] } });
  assert.equal(clr.json.ok, true);
  assert.deepEqual(clr.json.models, [], '空保存回 models:[]');
  const r = await api('/api/model-config');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.models, [], 'modelsOf(空) → []');
  // 兼容旧单模型字段存在（provider/model/baseUrl/keyMask/configured）
  assert.ok('provider' in r.json && 'keyMask' in r.json && 'configured' in r.json);
  assert.equal(r.json.configured, false);
  assert.equal(r.text.includes('apiKey'), false, '响应体不应出现 apiKey 字段名（只回 keyMask）');
});

/* ============ AC-3 新增 + AC-2 掩码 + AC-11 安全落文件 ============ */
test('AC-3/AC-2/AC-11 新增 1 主 1 备 → 落 data/model-api.json（主平铺+backups[]），keyMask 掩码、真实 Key 只在文件、响应无明文', async () => {
  const KEY_A = 'sk-ant-api03-abcdEFGH1234wxyz7f2a';   // 长度 > 8
  const KEY_B = 'sk-openai-deepseek-0000-3d9c';
  const body = {
    models: [
      { provider: 'anthropic', model: 'claude-opus-4-8', baseUrl: 'https://api.anthropic.com', apiKey: KEY_A, mask: '', primary: true },
      { provider: 'openai', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com', apiKey: KEY_B, mask: '', primary: false },
    ],
  };
  const r = await api('/api/model-config-save', { method: 'POST', body });
  assert.equal(r.json.ok, true);
  // 响应视图：2 条、掩码格式、无明文
  assert.equal(r.json.models.length, 2);
  assert.equal(r.json.models[0].keyMask, maskKey(KEY_A), '主 keyMask 应为 前4+……+后4');
  assert.equal(r.json.models[0].keyMask, 'sk-a……7f2a');
  assert.equal(r.json.models[1].configured, true);
  assert.equal(r.text.includes(KEY_A), false, '响应体不应含主 Key 明文');
  assert.equal(r.text.includes(KEY_B), false, '响应体不应含备用 Key 明文');
  // 连真机文件：主平铺 + backups[]，apiKey 真实明文只在文件里
  const disk = readCfgFile();
  assert.equal(disk.provider, 'anthropic');
  assert.equal(disk.model, 'claude-opus-4-8');
  assert.equal(disk.apiKey, KEY_A, '真实 Key 落文件（主平铺）');
  assert.ok(Array.isArray(disk.backups) && disk.backups.length === 1, 'backups 应有 1 条');
  assert.equal(disk.backups[0].model, 'deepseek-chat');
  assert.equal(disk.backups[0].apiKey, KEY_B, '备用真实 Key 落 backups');
  // 再 GET 回读：configured=true、掩码、无明文
  const g = await api('/api/model-config');
  assert.equal(g.json.models.length, 2);
  assert.equal(g.json.models[0].configured, true);
  assert.equal(g.json.models[0].keyMask, maskKey(KEY_A));
  assert.equal(g.text.includes(KEY_A), false, 'GET 响应体不应含明文');
});

/* ============ AC-2 掩码边界：≤8 非空 → 已配置；空 → 空串 ============ */
test('AC-2 掩码边界：Key 长度 ≤8 且非空 → keyMask="已配置"，无明文', async () => {
  const SHORT = 'sk-12';   // 长度 5 ≤ 8
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [{ provider: 'openai', model: 'm-short', baseUrl: '', apiKey: SHORT, primary: true }] } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.models[0].keyMask, '已配置', '≤8 非空 Key 掩码应为「已配置」');
  assert.equal(r.text.includes(SHORT), false, '响应体不应含短 Key 明文');
  assert.equal(maskKey(SHORT), '已配置');
  assert.equal(maskKey(''), '', '空 Key 掩码为空串');
});

/* ============ AC-5 设为主 + 唯一主 + 原主降备 ============ */
test('AC-5 设为主：M-B 切主后 models[0]=M-B primary=true，有且仅一个 primary，原主入 backups', async () => {
  const KA = 'sk-aaaa1111bbbb2222cccc', KB = 'sk-dddd3333eeee4444ffff';
  // 建 M-A 主 / M-B 备
  await api('/api/model-config-save', { method: 'POST', body: { models: [
    { provider: 'anthropic', model: 'M-A', baseUrl: '', apiKey: KA, primary: true },
    { provider: 'openai', model: 'M-B', baseUrl: '', apiKey: KB, primary: false },
  ] } });
  // 切主：M-B primary=true、M-A primary=false（前端保存时携掩码保留 Key）
  const gPrev = (await api('/api/model-config')).json;
  const maskA = gPrev.models.find(m => m.model === 'M-A').keyMask;
  const maskB = gPrev.models.find(m => m.model === 'M-B').keyMask;
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [
    { provider: 'openai', model: 'M-B', baseUrl: '', apiKey: '', mask: maskB, primary: true },
    { provider: 'anthropic', model: 'M-A', baseUrl: '', apiKey: '', mask: maskA, primary: false },
  ] } });
  assert.equal(r.json.ok, true);
  const primaries = r.json.models.filter(m => m.primary);
  assert.equal(primaries.length, 1, '有且仅有一个 primary');
  assert.equal(r.json.models[0].model, 'M-B', 'models[0] 应为新主 M-B');
  assert.equal(r.json.models[0].primary, true);
  // 文件：顶层平铺=M-B，backups 含 M-A，Key 未因切主丢失
  const disk = readCfgFile();
  assert.equal(disk.model, 'M-B');
  assert.equal(disk.apiKey, KB, '切主后主 Key 应为 M-B 的（掩码解析回原 Key，不丢）');
  assert.ok(disk.backups.some(b => b.model === 'M-A' && b.apiKey === KA), 'M-A 降为备用且 Key 保留');
});

/* ============ AC-4 编辑保留旧 Key：空 Key + mask 解析回旧值 ============ */
test('AC-4 编辑留空 Key + 带 mask → resolveKey 用 mask 匹配回旧明文，改名生效，Key 不丢', async () => {
  const OLD = 'sk-real-old-key-1234567890';
  await api('/api/model-config-save', { method: 'POST', body: { models: [{ provider: 'anthropic', model: 'edit-me', baseUrl: '', apiKey: OLD, primary: true }] } });
  const g1 = (await api('/api/model-config')).json;
  const mask = g1.models[0].keyMask;
  assert.equal(mask, maskKey(OLD));
  // 编辑：apiKey 留空、带正确 mask、改模型名
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [{ provider: 'anthropic', model: 'edit-me-renamed', baseUrl: '', apiKey: '', mask, primary: true }] } });
  assert.equal(r.json.ok, true);
  const disk = readCfgFile();
  assert.equal(disk.model, 'edit-me-renamed', '模型名应更新');
  assert.equal(disk.apiKey, OLD, '留空 Key + mask → 旧 Key 应被保留（不丢失）');
});

test('AC-4 反例：留空 Key + 错误 mask（匹配不到）→ 该模型无 Key 被过滤掉', async () => {
  const OLD = 'sk-only-one-key-abcdef12345';
  await api('/api/model-config-save', { method: 'POST', body: { models: [{ provider: 'anthropic', model: 'lonely', baseUrl: '', apiKey: OLD, primary: true }] } });
  // 编辑时给一个匹配不到任何旧模型的 mask、且 Key 留空 → resolveKey 得空 → filter 掉 → 空配置
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [{ provider: 'anthropic', model: 'lonely', baseUrl: '', apiKey: '', mask: 'zz-z……zzzz', primary: true }] } });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.models, [], '无法解析 Key 的模型被过滤 → 空');
});

/* ============ AC-6 删除：提交不含即删；删主则剩余第一个成新主 ============ */
test('AC-6 删除备用：提交的 models 不含该模型 → 文件不再含它，唯一主不变', async () => {
  const KA = 'sk-main-1111222233334444', KB = 'sk-back-5555666677778888', KC = 'sk-back-9999aaaabbbbcccc';
  await api('/api/model-config-save', { method: 'POST', body: { models: [
    { provider: 'anthropic', model: 'D-A', baseUrl: '', apiKey: KA, primary: true },
    { provider: 'openai', model: 'D-B', baseUrl: '', apiKey: KB, primary: false },
    { provider: 'openai', model: 'D-C', baseUrl: '', apiKey: KC, primary: false },
  ] } });
  const g = (await api('/api/model-config')).json;
  const mA = g.models.find(m => m.model === 'D-A').keyMask, mC = g.models.find(m => m.model === 'D-C').keyMask;
  // 删 D-B：提交只含 D-A + D-C
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [
    { provider: 'anthropic', model: 'D-A', baseUrl: '', apiKey: '', mask: mA, primary: true },
    { provider: 'openai', model: 'D-C', baseUrl: '', apiKey: '', mask: mC, primary: false },
  ] } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.models.length, 2);
  assert.equal(r.json.models.some(m => m.model === 'D-B'), false, 'D-B 已删');
  assert.equal(r.json.models.filter(m => m.primary).length, 1, '仍唯一主');
  const disk = readCfgFile();
  assert.equal(disk.backups.some(b => b.model === 'D-B'), false, '文件 backups 不再含 D-B');
});

test('AC-6 删主：剩余第一个（models.find(primary)||models[0]）成为新主', async () => {
  const KA = 'sk-primary-000011112222', KB = 'sk-backup-333344445555';
  await api('/api/model-config-save', { method: 'POST', body: { models: [
    { provider: 'anthropic', model: 'P-A', baseUrl: '', apiKey: KA, primary: true },
    { provider: 'openai', model: 'P-B', baseUrl: '', apiKey: KB, primary: false },
  ] } });
  const g = (await api('/api/model-config')).json;
  const mB = g.models.find(m => m.model === 'P-B').keyMask;
  // 删主 P-A：提交只含 P-B（未标 primary）→ 后端 models.find(primary)||models[0] 取 P-B 为主
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [
    { provider: 'openai', model: 'P-B', baseUrl: '', apiKey: '', mask: mB, primary: false },
  ] } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.models.length, 1);
  assert.equal(r.json.models[0].model, 'P-B');
  assert.equal(r.json.models[0].primary, true, '删主后剩余第一个成新主（唯一主）');
  const disk = readCfgFile();
  assert.equal(disk.model, 'P-B');
});

/* ============ AC-4.4 provider 中文↔存储值映射：存 anthropic/openai（非中文） ============ */
test('provider 映射：前端选 OpenAI 兼容 → 存储值 openai（非中文原样入文件）；默认 anthropic', async () => {
  // 前端 select value 已是存储值 anthropic/openai（中文只是 option 文案），断言落文件为英文码
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [
    { provider: 'openai', model: 'qwen-max', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-qwen-11112222333344', primary: true },
  ] } });
  assert.equal(r.json.ok, true);
  assert.equal(r.json.models[0].provider, 'openai', '存储值应为 openai');
  const disk = readCfgFile();
  assert.equal(disk.provider, 'openai', '文件里 provider 为英文码 openai，非中文「OpenAI 兼容」');
  // provider 缺省 → anthropic
  const r2 = await api('/api/model-config-save', { method: 'POST', body: { models: [{ model: 'no-prov', baseUrl: '', apiKey: 'sk-noprov-99998888777766', primary: true }] } });
  assert.equal(r2.json.models[0].provider, 'anthropic', 'provider 缺省应回落 anthropic');
});

/* ============ AC-7 测试连通（错误分支，不烧真实 Key）============ */
test('AC-7 model-test 无 Key → {ok:false, error} 未配置（HTTP 200 业务错误）', async () => {
  const r = await api('/api/model-test', { method: 'POST', body: { provider: 'anthropic', model: 'x', baseUrl: '', apiKey: '', mask: 'no-match……xxxx' } });
  assert.equal(r.status, 200, 'model-test 业务错误仍 HTTP 200');
  assert.equal(r.json.ok, false);
  assert.match(String(r.json.error || ''), /未配置 API Key/, '无 Key 应报「未配置 API Key」');
});

test('AC-7 model-test 无效 baseUrl（有假 Key）→ {ok:false, error}（不连真实模型商，走错误分支）', async () => {
  // 指向一个不可达的本地端点，确保发不出去 → 抛错 → ok:false，绝不烧真实外部 Key
  const r = await api('/api/model-test', { method: 'POST', body: { provider: 'openai', model: 'x', baseUrl: 'http://127.0.0.1:1', apiKey: 'sk-fake-key-for-error-branch' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, false, '不可达端点应返回 ok:false');
  assert.ok(typeof r.json.error === 'string' && r.json.error.length > 0, '应带 error 文案');
});

/* ============ 清空回到空态（also 验证 AC-11 空保存路径）============ */
test('清空：models:[] → 文件写 {provider:anthropic}、GET models:[]（after 再还原真实备份）', async () => {
  const r = await api('/api/model-config-save', { method: 'POST', body: { models: [] } });
  assert.equal(r.json.ok, true);
  assert.deepEqual(r.json.models, []);
  const disk = readCfgFile();
  assert.deepEqual(disk, { provider: 'anthropic' }, '空保存写 {provider:anthropic}');
});

/* ============ AC-1 / E2E：前端落原型（整宽 data-table + 编辑抽屉 + 自写抽屉开关），无 UI.openDrawer ============ */
test('AC-1/E2E model-config.html 落原型：整宽 data-table + thead 7 列 + 编辑抽屉 + 自写 openDrawer/closeDrawer + uiConfirm，且不用 UI.openDrawer', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'model-config.html'), 'utf8');
  // UI-01 外壳
  assert.match(html, /data-shell="admin"/, '用 UI-01 后台外壳');
  assert.match(html, /data-nav="model-config"/, 'nav 高亮键=model-config（shell.js NAV_INDEX）');
  assert.match(html, /\/assets\/theme\.css/, '引臻遴 theme.css');
  assert.match(html, /\/assets\/shell\.js/, '引注入式 shell.js');
  // 整宽 data-table + thead（原型形态，非老两栏卡片）
  assert.match(html, /class="data-table"/, '整宽 data-table');
  assert.match(html, /<thead>/, '含表头 thead');
  assert.match(html, /id="modelBody"/, 'tbody 容器 #modelBody');
  assert.match(html, /当前主模型/, '表头右上「当前主模型」');
  assert.match(html, /id="primaryName"/, '主模型名占位 #primaryName');
  // 主/备标签用 theme.css tag 类
  assert.match(html, /tag-primary/, '主标签 tag-primary');
  assert.match(html, /tag-gray/, '备标签 tag-gray');
  // 连通状态列（正常/异常/未测试）
  assert.match(html, /连通状态/, '连通状态列');
  assert.match(html, /未测试/, '未测状态占位');
  // 行内操作
  assert.match(html, /data-act="primary"/, '行内「设为主」');
  assert.match(html, /data-act="test"/, '行内「测试连通」');
  assert.match(html, /data-act="edit"/, '行内「编辑」');
  assert.match(html, /data-act="del"/, '行内「删除」');
  // 新增/编辑抽屉
  assert.match(html, /id="editDrawer"/, '编辑抽屉 #editDrawer');
  assert.match(html, /id="drawerMask"/, '抽屉遮罩 #drawerMask');
  assert.match(html, /class="[^"]*\bdrawer\b/, 'theme.css .drawer 样式');
  assert.match(html, /id="edProvider"/, '抽屉服务商 segment #edProvider');
  assert.match(html, /class="seg-group/, '服务商用 seg-group segment（非老 select 表单）');
  assert.match(html, /data-v="anthropic"/, 'segment 存储码 anthropic');
  assert.match(html, /data-v="openai"/, 'segment 存储码 openai');
  assert.match(html, /id="edModel"/, '抽屉模型名输入');
  assert.match(html, /id="edEndpoint"/, '抽屉接口地址输入');
  assert.match(html, /id="edKey"/, '抽屉 API Key 输入');
  assert.match(html, /name="edRole"/, '抽屉主/备单选');
  // 自写抽屉开关 + toast（部署 shell.js 无 UI.openDrawer/toast）
  assert.match(html, /function openDrawer\(/, '自写 openDrawer');
  assert.match(html, /function closeDrawer\(/, '自写 closeDrawer');
  assert.match(html, /function toast\(/, '自写 toast');
  assert.doesNotMatch(html, /UI\.openDrawer|UI\.closeDrawer|UI\.toast|UI\.confirm/, '不得用原型的 UI.openDrawer/closeDrawer/toast/confirm（部署 shell.js 无）');
  // 删除走共享 uiConfirm（ui.js），非页面 mask 弹窗
  assert.match(html, /uiConfirm\(/, '删除走共享 uiConfirm');
  // 复用现有真实端点
  assert.match(html, /\/api\/model-config\b/, '复用 GET /api/model-config');
  assert.match(html, /\/api\/model-config-save/, '复用 model-config-save');
  assert.match(html, /\/api\/model-test/, '复用 model-test');
  // 安全：提交只带 _newKey/mask，不回传明文；文件安全说明
  assert.match(html, /apiKey:\s*m\._newKey\s*\|\|\s*''/, '提交只带本次新填明文或空');
  assert.match(html, /data\/model-api\.json/, '安全说明指向本机文件');
  // 不残留老两栏卡片专属结构（回归防漂移）
  assert.doesNotMatch(html, /id="records"/, '不再有老两栏 #records 记录列表');
  assert.doesNotMatch(html, /class="reclist"/, '不再有老 reclist 卡片列表');
});
