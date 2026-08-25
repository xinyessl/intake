// FS-08 · 按域隔离登录会话（session cookie 按域取名）· 脱库逻辑测试
//   背景：登录 cookie 固定叫 intake_sess（无 Domain、按 host 绑定）；但 cookie 不区分端口（RFC 6265），
//     同 IP 两端口（新机 5180=运营/admin、5181=实施/field）会共用同一 session → 一端登录另一端也登录。
//   解法：按域给 session cookie 起不同名字——field→intake_sess_field、admin→intake_sess_admin、
//     other（单域名/直连 IP/本机）→intake_sess（向后兼容零变化）。session 存储不变，只改承载 token 的 cookie 名。
//   本测：① 抽真 sessCookieName 三分支断言 ② 源码级断言 login/logout×2/currentUser 都走 sessCookieName(origin)
//     （不再裸用 intake_sess，除 other 分支默认值）③ 单域名回退 intake_sess 证据。
//   本地 MySQL 常连不上 + server.mjs 启动即 await db.init()——故本测纯源码抽取/静态断言，不 spawn、不连库；
//     连真会话冒烟由 fs-08.test.mjs（DUAL/PLAIN 实例）+ 编排器部署后做。
//   用法：node --test tools/fs-08-session-cookie.logic.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

// —— 从源码抽具名函数体沙箱 eval（测真实源码，非重写副本，能抓漂移）——
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

const sessCookieName = new Function(extractFn(SRC, 'sessCookieName') + '\nreturn sessCookieName;')();

/* ================= A. sessCookieName 三分支 ================= */
test('A1 field 域 → intake_sess_field', () => {
  assert.equal(sessCookieName('field'), 'intake_sess_field');
});
test('A2 admin 域 → intake_sess_admin', () => {
  assert.equal(sessCookieName('admin'), 'intake_sess_admin');
});
test('A3 other 域（单域名/直连 IP/本机）→ intake_sess（向后兼容）', () => {
  assert.equal(sessCookieName('other'), 'intake_sess');
});
test('A4 未知/空 origin 也回退 intake_sess（防御：任何非 field/admin 都走单域名默认名）', () => {
  assert.equal(sessCookieName(''), 'intake_sess');
  assert.equal(sessCookieName(undefined), 'intake_sess');
  assert.equal(sessCookieName('weird'), 'intake_sess');
});
test('A5 三个 cookie 名两两不同（同 host 存三个都不冲突，各域只读/写自己那个）', () => {
  const names = new Set(['field', 'admin', 'other'].map(sessCookieName));
  assert.equal(names.size, 3, 'field/admin/other 三分支产出三个互不相同的 cookie 名');
});

/* ================= B. 源码级：login/logout×2/currentUser 都走 sessCookieName(origin) ================= */
test('B1 currentUser 读 token 走 sessCookieName(originOf(req))（不再裸用 parseCookies(req).intake_sess）', () => {
  const fn = extractFn(SRC, 'currentUser');
  assert.match(fn, /parseCookies\(req\)\[sessCookieName\(originOf\(req\)\)\]/,
    'currentUser 应按 sessCookieName(originOf(req)) 取 cookie');
  assert.doesNotMatch(fn, /parseCookies\(req\)\.intake_sess\b/,
    'currentUser 不应再裸读 parseCookies(req).intake_sess');
});

test('B2 /api/login Set-Cookie 用 sessCookieName(origin)（按域命名 → 两域/两端口独立登录）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/login'"), SRC.indexOf("url.pathname === '/api/logout'"));
  assert.ok(seg.length > 0, '应能定位 /api/login handler 段');
  assert.match(seg, /Set-Cookie[^`]*`\$\{sessCookieName\(origin\)\}=\$\{t\}/,
    'login 的 Set-Cookie 应以 sessCookieName(origin) 为 cookie 名');
  assert.doesNotMatch(seg, /Set-Cookie'[^}]*`intake_sess=/,
    'login 不应再硬编码裸 intake_sess= 作为 cookie 名');
});

test('B3 /api/logout + /logout 只清「当前域」那个 cookie（sessCookieName(origin)，Max-Age=0）', () => {
  // 两处 logout handler 都在 origin 作用域内；各自读+清 sessCookieName(origin)，不误清别的域。
  const apiLogout = SRC.slice(SRC.indexOf("url.pathname === '/api/logout'"), SRC.indexOf("url.pathname === '/logout'"));
  const pageLogout = SRC.slice(SRC.indexOf("url.pathname === '/logout'"), SRC.indexOf("url.pathname === '/api/me'"));
  for (const [label, seg] of [['/api/logout', apiLogout], ['/logout', pageLogout]]) {
    assert.ok(seg.length > 0, `应能定位 ${label} handler 段`);
    assert.match(seg, /sessCookieName\(origin\)/, `${label} 应用 sessCookieName(origin) 定位 cookie 名`);
    assert.match(seg, /parseCookies\(req\)\[cn\]/, `${label} 应读 parseCookies(req)[cn] 拿 token（cn=sessCookieName(origin)）`);
    assert.match(seg, /Max-Age=0/, `${label} 应下发 Max-Age=0 清除 cookie`);
    assert.doesNotMatch(seg, /parseCookies\(req\)\.intake_sess\b/, `${label} 不应再裸读 parseCookies(req).intake_sess`);
    assert.doesNotMatch(seg, /`intake_sess=;/, `${label} 不应硬编码清裸 intake_sess=`);
  }
});

/* ================= C. 全局：除 sessCookieName 默认值/注释外，无残留裸 intake_sess 用法 ================= */
test('C1 源码里裸 intake_sess（非 _field/_admin、非 sessCookieName 内、非注释）已清零', () => {
  const lines = SRC.split('\n');
  const offenders = [];
  lines.forEach((ln, i) => {
    const code = ln.split('//')[0];                          // 去掉行尾注释
    if (/^\s*\/\//.test(ln)) return;                          // 整行注释跳过
    if (/sessCookieName/.test(code)) return;                  // sessCookieName 定义/调用行（含 other 分支默认名）豁免
    // 匹配裸 cookie 名 intake_sess（后面不是 _，即不是 intake_sess_field/_admin）；排除 intake_link
    if (/\bintake_sess(?!_)/.test(code)) offenders.push(`L${i + 1}: ${ln.trim()}`);
  });
  assert.deepEqual(offenders, [], '不应残留裸 intake_sess 用法（应全部走 sessCookieName）:\n' + offenders.join('\n'));
});

test('C2 intake_link（免登录提交链接身份）未被误动——仍独立存在（另一套，不归本次改动）', () => {
  assert.match(SRC, /parseCookies\(req\)\.intake_link/, 'linkUserFrom 仍读 intake_link');
  assert.match(SRC, /`intake_link=\$\{/, '仍下发 intake_link cookie（提交链接身份）');
});
