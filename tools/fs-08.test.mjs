// FS-08 · 双域名部署 · 访问隔离 —— A 运维文档 nginx 静态断言 + B/C/D/E 连真库冒烟（零依赖 node --test）
//   连真库：spawn 真实 server.mjs（连本地 MySQL data/db.json）到隔离随机高位端口，用 http.request 构造带不同 Host 头的请求打真端点。
//   两个实例：DUAL（配 FIELD_ORIGIN=http://field.test / ADMIN_ORIGIN=http://admin.test，验域名闸/根路由/绝对链接）+ PLAIN（不配，验回退零影响）。
//   ⚠️ 两实例都用 BIND=0.0.0.0（公网模式）——否则本机模式 SELF_HOSTS 硬校验会先 403 掉自定义 Host 头（field.test 等），测不到 Host 闸。
//   ⚠️ 端口随机高位（6600+rand(120)，两实例不同频段）；一起跑必须 node --test --test-concurrency=1；无造脏数据（只读真库 hlyy 生成签名 token，不落库）。
//   用法：node --test tools/fs-08.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT_DUAL = 6600 + Math.floor(Math.random() * 60);          // 双域名实例
const PORT_PLAIN = 6680 + Math.floor(Math.random() * 60);         // 回退（未配双域名）实例
const FIELD_HOST = 'field.test';
const ADMIN_HOST = 'admin.test';
const FIELD_ORIGIN = 'http://' + FIELD_HOST;
const ADMIN_ORIGIN = 'http://' + ADMIN_HOST;

let srvDual = null, srvPlain = null, pool = null, adminCookieDual = '';
let hlyyBefore = 0;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// 底层 http.request：可自定义 Host 头（fetch 的 host 头会被覆盖，故用 http.request）。
function raw(port, p, { method = 'GET', host, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = {};
    if (host) headers['Host'] = host;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    if (cookie) headers['Cookie'] = cookie;
    const reqObj = http.request({ host: '127.0.0.1', port, path: p, method, headers }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, text: buf, location: res.headers['location'], setCookie: res.headers['set-cookie'] }));
    });
    reqObj.on('error', reject);
    if (data) reqObj.write(data);
    reqObj.end();
  });
}
function json(r) { try { return JSON.parse(r.text); } catch { return null; } }

async function waitHealth(port) {
  for (let i = 0; i < 60; i++) { try { const r = await raw(port, '/api/health'); if (r.status === 200) return true; } catch {} await sleep(250); }
  return false;
}

before(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/db.json'), 'utf8'));
  pool = mysql.createPool({ host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database, charset: 'utf8mb4_unicode_ci' });
  const [[hb]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']);
  hlyyBefore = hb.n;
  // 双域名实例（配 FIELD_ORIGIN/ADMIN_ORIGIN），BIND=0.0.0.0 放开本机 Host 硬校验以测自定义 Host
  srvDual = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT_DUAL), BIND: '0.0.0.0', FIELD_ORIGIN, ADMIN_ORIGIN }, stdio: ['ignore', 'pipe', 'pipe'] });
  // 回退实例（不配双域名），同 BIND=0.0.0.0
  srvPlain = spawn('node', ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT_PLAIN), BIND: '0.0.0.0', FIELD_ORIGIN: '', ADMIN_ORIGIN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  assert.ok(await waitHealth(PORT_DUAL), '双域名实例应就绪');
  assert.ok(await waitHealth(PORT_PLAIN), '回退实例应就绪');
  // 管理员登录双域名实例（Host=admin.test，走 admin 域）拿 cookie 供 submit-link 用例
  const lg = await raw(PORT_DUAL, '/api/login', { method: 'POST', host: ADMIN_HOST, body: { username: 'admin', password: 'admin123' } });
  assert.equal(json(lg)?.ok, true, '前置：管理员登录应成功（admin/admin123，Host=admin.test）');
  adminCookieDual = String(lg.setCookie[0]).split(';')[0];
});

after(async () => {
  try { const [[ha]] = await pool.query('SELECT COUNT(*) n FROM intakes WHERE project_id=?', ['hlyy']); assert.equal(ha.n, hlyyBefore, 'after：真库 hlyy 工单数应回到基线（未污染）'); } catch (e) { console.error(e); }
  try { const [rp] = await pool.query("SELECT id FROM projects WHERE id LIKE 'fs08%'"); assert.equal(rp.length, 0, 'after：真库不应残留 fs08* 产品'); } catch (e) { console.error(e); }
  if (pool) await pool.end();
  if (srvDual) srvDual.kill('SIGTERM');
  if (srvPlain) srvPlain.kill('SIGTERM');
});

/* ================= A. nginx 双 vhost 静态断言（对 docs/运维部署.md 新增节） ================= */
const DEPLOY = fs.readFileSync(path.join(ROOT, 'docs/运维部署.md'), 'utf8');

/* ---- A-drift 防漂移：FIELD_OK 里每个 /api/ 端点必须 ∈ FS08_FIELD_API（否则 field 域越域拒真实端点，实测坑：FS-05 4 端点漏配→实施域 forbidden）---- */
const SERVER_SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
// 从 server.mjs 源码抽出两处 new Set([...]) 的字符串字面量（FIELD_OK 在 authGate 内、FS08_FIELD_API 为顶层镜像常量）。
function extractSet(src, name) {
  // 匹配 `const NAME = new Set([ ... ])` 里 [] 内的内容（单行定义）。
  const re = new RegExp(name + '\\s*=\\s*new Set\\(\\[([^\\]]*)\\]\\)');
  const m = src.match(re);
  assert.ok(m, `应能在 server.mjs 抽到 ${name} 的 new Set([...])`);
  return (m[1].match(/'[^']*'/g) || []).map(s => s.slice(1, -1));
}
const FIELD_OK_ARR = extractSet(SERVER_SRC, 'FIELD_OK');
const FS08_FIELD_API_ARR = extractSet(SERVER_SRC, 'FS08_FIELD_API');

test('A-drift FIELD_OK 里每个 /api/ 端点都必须 ∈ FS08_FIELD_API（防实施域越域拒·实测坑守卫）', () => {
  const fs08 = new Set(FS08_FIELD_API_ARR);
  const apiInFieldOk = FIELD_OK_ARR.filter(p => p.startsWith('/api/'));
  assert.ok(apiInFieldOk.length >= 20, `FIELD_OK 至少抽到 20+ 个 /api/ 端点（实际 ${apiInFieldOk.length}），确认抽取生效`);
  const missing = apiInFieldOk.filter(p => !fs08.has(p));
  assert.deepEqual(missing, [], `以下 FIELD_OK 端点漏进 FS08_FIELD_API（实施域会被 originGate deny→forbidden）：${JSON.stringify(missing)}`);
});

test('A-drift FS-05 现场 4 端点（field/batches·batch-download·customer-version·intake-verify）确在 FS08_FIELD_API（实施域放行）', () => {
  const fs08 = new Set(FS08_FIELD_API_ARR);
  for (const p of ['/api/field/batches', '/api/batch-download', '/api/customer-version', '/api/intake-verify']) {
    assert.ok(fs08.has(p), `${p} 必须在 FS08_FIELD_API（否则实施域 originGate deny）`);
  }
});

test('A-1 运维文档含两个 server{} 块 + 两个不同 server_name（field/admin 域）', () => {
  const serverBlocks = (DEPLOY.match(/^\s*server\s*\{/gm) || []).length;
  assert.ok(serverBlocks >= 2, `应含 ≥2 个 server{} 块（实际 ${serverBlocks}）`);
  assert.ok(/server_name\s+intake\.lcpharmacy\.cn/.test(DEPLOY), '含 field 域 server_name intake.lcpharmacy.cn');
  assert.ok(/server_name\s+intake-ops\.lcpharmacy\.cn/.test(DEPLOY), '含 admin 域 server_name intake-ops.lcpharmacy.cn');
});

test('A-1b 文档含证书位（ssl_certificate，NH-4 HTTPS 后续追加块）', () => {
  assert.ok(/ssl_certificate\s+/.test(DEPLOY), '含 ssl_certificate 位');
  assert.ok(/ssl_certificate_key\s+/.test(DEPLOY), '含 ssl_certificate_key 位');
});

test('A-2 两 vhost 各 location /api/ 反代同一后端 127.0.0.1:5180 + 透传 Host $host', () => {
  const apiLocs = (DEPLOY.match(/location\s+\/api\/\s*\{/g) || []).length;
  assert.ok(apiLocs >= 2, `应含 ≥2 个 location /api/（实际 ${apiLocs}）`);
  const proxies = (DEPLOY.match(/proxy_pass\s+http:\/\/127\.0\.0\.1:5180/g) || []).length;
  assert.ok(proxies >= 2, `≥2 处反代到同一后端 127.0.0.1:5180（实际 ${proxies}）`);
  assert.ok(/proxy_set_header\s+Host\s+\$host/.test(DEPLOY), '含 proxy_set_header Host $host（透传真实域名给后端判域）');
});

test('A-3/4 文档说明同源免 CORS + 两域名指向同一份 public/（不复制两份）', () => {
  assert.ok(/免\s*CORS|同源/.test(DEPLOY), '说明同源免 CORS');
  assert.ok(/同一份.{0,4}public|不复制两份/.test(DEPLOY), '说明两域名指向同一份 public/');
});

test('A-env 文档含 FIELD_ORIGIN/ADMIN_ORIGIN 环境变量 + 共用后端库不同步要点', () => {
  assert.ok(/FIELD_ORIGIN/.test(DEPLOY) && /ADMIN_ORIGIN/.test(DEPLOY), '含两环境变量说明');
  assert.ok(/intake\.lcpharmacy\.cn/.test(DEPLOY) && /intake-ops\.lcpharmacy\.cn/.test(DEPLOY), '含 NH-1 实际域名');
  assert.ok(/不做.{0,6}跨库|不.{0,4}同步|共用.{0,6}后端/.test(DEPLOY), '含「共用后端+库、工单不同步」要点');
});

/* ================= B. 按 Host 的访问闸（域名层 deny-by-default，连真库冒烟） ================= */
test('B-AC6 field 域请求后台页 /console.html → 越域 404（不依赖前端隐藏）', async () => {
  const r = await raw(PORT_DUAL, '/console.html', { host: FIELD_HOST });
  assert.equal(r.status, 404, 'field 域敲后台页应 404');
});

test('B-AC6 field 域请求 admin-only 接口 /api/account-save → 越域 403', async () => {
  const r = await raw(PORT_DUAL, '/api/account-save', { method: 'POST', host: FIELD_HOST, body: { username: 'x' } });
  assert.equal(r.status, 403, 'field 域敲 admin 接口应 403（域名层拒，不到 authGate）');
  assert.equal(json(r)?.error, 'forbidden');
});

test('B-AC6 field 域请求其它后台接口 /api/accounts、/api/overview → 越域 403', async () => {
  for (const p of ['/api/accounts', '/api/overview', '/api/kb-save', '/api/git-config']) {
    const r = await raw(PORT_DUAL, p, { host: FIELD_HOST });
    assert.equal(r.status, 403, `field 域敲 ${p} 应 403`);
  }
});

test('B-AC7 field 域请求 field.html/assets → 域名层放行且公开可加载（200）', async () => {
  // field.html（自带登录门遮罩，authGate 公开放行）、assets → 200
  for (const p of ['/field.html', '/assets/theme.css']) {
    const r = await raw(PORT_DUAL, p, { host: FIELD_HOST });
    assert.equal(r.status, 200, `field 域请求 ${p} 应放行 200`);
  }
});

test('B-AC7/9 field 域请求 submit.html → 域名层不拒（非 404）；未带 token 由 authGate 302 到登录（叠加语义）', async () => {
  // submit.html 在 field 域允许集内 → 域名层放行；无 token/未登录时原 authGate 302（现状不变，AC-9 叠加不削弱 authGate）
  const r = await raw(PORT_DUAL, '/submit.html', { host: FIELD_HOST });
  assert.notEqual(r.status, 404, 'submit.html 不应被域名层 404（在 field 域允许集）');
  assert.ok(r.status === 200 || r.status === 302, `submit.html 交由 authGate（200/302），实际 ${r.status}`);
});

test('B-AC7/9 field 域请求 FIELD_OK/LINK_OK 内接口 → 域名层不拒（走原 authGate，非 403 越域）', async () => {
  // /api/projects 在 LINK_OK/FIELD_OK：域名层放行；未登录时 authGate 因未启用或链接白名单返 200
  const r = await raw(PORT_DUAL, '/api/projects', { host: FIELD_HOST });
  assert.notEqual(r.status, 404, 'field 域 /api/projects 不应被域名层 404');
  assert.ok(r.status === 200 || r.status === 401, `field 域 /api/projects 交由 authGate（200 或 401），实际 ${r.status}`);
});

test('B-AC7/9 field 域请求 FS-05 现场 4 端点 → 域名层不拒（非 403 越域；实测坑：漏配 FS08_FIELD_API 时曾被 deny→forbidden）', async () => {
  // 这 4 端点在 FIELD_OK + FS08_FIELD_API → field 域 originGate 放行；未带会话 → 交由 authGate（401 need-login），关键是不能被域名层 403 forbidden。
  for (const p of ['/api/field/batches', '/api/batch-download', '/api/customer-version', '/api/intake-verify']) {
    const method = (p === '/api/field/batches') ? 'GET' : 'POST';
    const r = await raw(PORT_DUAL, p, { method, host: FIELD_HOST, body: method === 'POST' ? {} : undefined });
    // 域名层 deny 会返 403 且 body {"error":"forbidden"}；放行后交 authGate 得 401（未登录）。断言不是「越域 forbidden」。
    assert.notEqual(json(r)?.error, 'forbidden', `${p} 不应被域名层拒（forbidden）——实施域批次流会整段挂掉`);
    assert.ok(r.status === 401 || r.status === 200 || r.status === 400 || r.status === 404, `${p} 交由 authGate（未登录 401 等），实际 ${r.status}`);
  }
});

test('B-AC8 admin 域已登录管理员请求后台页 → 放行 200（域名层放行 + authGate 兜权限）', async () => {
  for (const p of ['/console.html', '/inbox.html', '/accounts.html', '/kb.html']) {
    const r = await raw(PORT_DUAL, p, { host: ADMIN_HOST, cookie: adminCookieDual });
    assert.equal(r.status, 200, `admin 域已登录请求后台页 ${p} 应 200`);
  }
});

test('B-AC8 admin 域后台页未登录 → 域名层不拒（非 404），由 authGate 302 到登录', async () => {
  const r = await raw(PORT_DUAL, '/console.html', { host: ADMIN_HOST });
  assert.notEqual(r.status, 404, 'admin 域 console.html 不应被域名层 404');
  assert.ok(r.status === 200 || r.status === 302, `admin 域未登录 console.html 交由 authGate（200/302），实际 ${r.status}`);
});

test('B-AC8 admin 域请求 admin 接口 → 域名层放行（authGate 兜权限，登录后 200）', async () => {
  const r = await raw(PORT_DUAL, '/api/accounts', { host: ADMIN_HOST, cookie: adminCookieDual });
  assert.equal(r.status, 200, 'admin 域已登录管理员请求 /api/accounts 应 200');
});

test('B-NH3 admin 域请求 field.html → 越域 404（admin 域不暴露实施端外壳）', async () => {
  const r = await raw(PORT_DUAL, '/field.html', { host: ADMIN_HOST });
  assert.equal(r.status, 404, 'admin 域 field.html 应 404');
});

/* ================= C. 按 Host 的根路由（连真库冒烟） ================= */
test('C-AC10 Host=field 域 GET / → field.html 内容（含「实施端」外壳标识，公开可加载无需登录）', async () => {
  // field.html 自带登录门遮罩、authGate 公开放行 → field 域 / 直接返回 field.html（不 302 到 login）
  const r = await raw(PORT_DUAL, '/', { host: FIELD_HOST });
  assert.equal(r.status, 200, 'field 域 / 应 200（field.html 公开外壳）');
  assert.ok(/实施端/.test(r.text), 'field 域 / 应返回 field.html（含「实施端」标识）');
});

test('C-AC11 Host=admin 域已登录 GET / → console.html 内容（含「运营工作台」标识）', async () => {
  const r = await raw(PORT_DUAL, '/', { host: ADMIN_HOST, cookie: adminCookieDual });
  assert.equal(r.status, 200, 'admin 域已登录 / 应 200');
  assert.ok(/运营工作台/.test(r.text), 'admin 域 / 应返回 console.html（含「运营工作台」标识）');
});

test('C-AC11 Host=admin 域未登录 GET / → 现状 302 到登录（authGate 兜权限，不被 Host 闸打死）', async () => {
  const r = await raw(PORT_DUAL, '/', { host: ADMIN_HOST });
  assert.equal(r.status, 302, 'admin 域未登录 / 应 302（console.html 需登录，authGate 现状语义）');
  assert.match(String(r.location || ''), /login\.html/, '302 到 /login.html');
});

test('C-AC12 Host=本机回环 127.0.0.1:port GET / → 现状分发（不 500、不打死本机开发）', async () => {
  const r = await raw(PORT_DUAL, '/', { host: `127.0.0.1:${PORT_DUAL}` });
  assert.ok(r.status === 200 || r.status === 302, `本机回环 / 应可用（200/302），实际 ${r.status}`);
  assert.notEqual(r.status, 404, '本机回环 / 不应 404');
  assert.notEqual(r.status, 500, '本机回环 / 不应 500');
});

test('C-AC12 Host=未匹配域名（direct IP 样）→ 现状分发（不越域拒本机页/接口）', async () => {
  // 未匹配 Host（如某未配域名）→ origin=other → 不介入，后台页仍按 authGate（未登录 302）
  const r = await raw(PORT_DUAL, '/console.html', { host: '10.0.0.9' });
  assert.notEqual(r.status, 404, 'other 域敲 console.html 不应被域名层 404（origin=other 不介入）');
});

/* ================= 回退（未配 FIELD_ORIGIN/ADMIN_ORIGIN 的 PLAIN 实例）证明零影响 ================= */
test('R-AC12 未配双域名：Host=field.test GET / → 走现状 role 分发（非 field.html 域名闸）', async () => {
  const r = await raw(PORT_PLAIN, '/', { host: FIELD_HOST });
  assert.ok(r.status === 200 || r.status === 302, `回退实例 field.test / 应现状可用，实际 ${r.status}`);
  // 未登录、非链接 → 现状分发到 console.html（管理员位）；断言不是 field.html（证明 Host 闸未启用）
  if (r.status === 200) assert.doesNotMatch(r.text, /实施端/, '回退实例不应因 Host=field.test 返回 field.html');
});

test('R-AC12 未配双域名：Host=field.test 请求后台页 /console.html → 不被域名层拒（走现状 authGate）', async () => {
  const r = await raw(PORT_PLAIN, '/console.html', { host: FIELD_HOST });
  assert.notEqual(r.status, 404, '回退实例不应对 field.test 敲 console.html 返 404（Host 闸未启用）');
});

test('R-AC12 未配双域名：Host=field.test 请求 admin 接口 → 不被域名层 403（走现状 authGate 语义）', async () => {
  // 回退实例未配双域名 → originGate 恒 allow → /api/accounts 走原 authGate（未登录 401，而非域名层 403）
  const r = await raw(PORT_PLAIN, '/api/accounts', { host: FIELD_HOST });
  assert.ok(r.status === 401 || r.status === 200, `回退实例 /api/accounts 应走 authGate（401/200），实际 ${r.status}`);
});

/* ================= D. 同源会话隔离（cookie SameSite=Strict） ================= */
test('D-AC13/14 登录响应 Set-Cookie 含 SameSite=Strict; Path=/（两域名浏览器天然隔离依据）', async () => {
  const r = await raw(PORT_DUAL, '/api/login', { method: 'POST', host: ADMIN_HOST, body: { username: 'admin', password: 'admin123' } });
  const sc = String((r.setCookie || []).join(';'));
  assert.match(sc, /intake_sess=/, '含 intake_sess cookie');
  assert.match(sc, /SameSite=Strict/i, 'cookie 含 SameSite=Strict（天然按域名隔离）');
  assert.match(sc, /Path=\//, 'cookie 含 Path=/');
});

test('D-AC15 服务端无跨域 cookie 逻辑：不带会话 cookie 的 field 域 /api/me → me:null（各域独立登录）', async () => {
  // 模拟浏览器 cookie 隔离：field 域请求不携带 admin 域会话 cookie → me:null
  const r = await raw(PORT_DUAL, '/api/me', { host: FIELD_HOST });
  assert.equal(r.status, 200, 'field 域 /api/me 应放行（鉴权端点两域都放）');
  assert.equal(json(r)?.me, null, 'field 域无会话 cookie → me:null（会话不跨域串）');
});

/* ================= E. submit-link 绝对地址 ================= */
test('E-AC16/17 配 FIELD_ORIGIN：submit-link 返回 url=field 域绝对地址、path 仍相对（向后兼容）', async () => {
  const r = await raw(PORT_DUAL, '/api/submit-link', { method: 'POST', host: ADMIN_HOST, cookie: adminCookieDual, body: { project: 'hlyy', days: 30 } });
  assert.equal(r.status, 200, 'submit-link 应 200');
  const j = json(r);
  assert.equal(j?.ok, true, 'ok:true');
  assert.ok(typeof j.token === 'string' && j.token.length > 0, '含 token');
  assert.equal(j.path, '/submit.html?token=' + j.token, 'path 仍是相对路径（向后兼容）');
  assert.equal(j.url, FIELD_ORIGIN + '/submit.html?token=' + j.token, 'url = FIELD_ORIGIN 绝对地址');
  assert.ok(/^http:\/\/field\.test\/submit\.html\?token=/.test(j.url), 'url 是 field 域完整 URL');
});

test('E-AC18 未配 FIELD_ORIGIN（回退实例）：submit-link 的 url == path（相对，缺配置不报错）', async () => {
  // 回退实例先登录拿 cookie
  const lg = await raw(PORT_PLAIN, '/api/login', { method: 'POST', body: { username: 'admin', password: 'admin123' } });
  assert.equal(json(lg)?.ok, true, '回退实例管理员登录应成功');
  const ck = String(lg.setCookie[0]).split(';')[0];
  const r = await raw(PORT_PLAIN, '/api/submit-link', { method: 'POST', cookie: ck, body: { project: 'hlyy', days: 30 } });
  assert.equal(r.status, 200, '回退实例 submit-link 应 200');
  const j = json(r);
  assert.equal(j?.ok, true, 'ok:true');
  assert.equal(j.path, '/submit.html?token=' + j.token, 'path 相对');
  assert.equal(j.url, j.path, '未配 FIELD_ORIGIN → url 回退为相对（== path）');
  assert.ok(!/^https?:\/\//.test(j.url), 'url 非绝对（相对）');
});
