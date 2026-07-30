#!/usr/bin/env node
/* ============================================================
   UI-01 · 运营后台外壳与设计系统 —— 验证/回归测试（零依赖 node:test）
   ------------------------------------------------------------
   基线（2026-07-21 用户裁决 re-target 原型）：本套件锁定【臻遴结构化原型】那套外壳
   —— 深色分组侧边栏 + 顶栏(机构胶囊/面包屑/帮助/通知/用户下拉) + 多标签工作区
   + theme.css 设计系统(藏青 #0F2744 · 2026-07-22 裁决对齐实施端；早前靛蓝 #3A4CA8 已推翻) + 注入式 shell.js。
   落地 = public/assets/{theme.css,shell.js} + 8 个管理页套壳。
   （推翻 07-20「锁定部署老 .topnav 外壳 / 医疗蓝 #1A6DBE」的旧断言。）

   两组用例：
     A) 原型外壳 DOM/CSS 静态断言（零依赖 · 直接读 public/ 源文件）——恒可跑。
     B) §4 接口契约「连真库冒烟」（/api/me、/api/notifications、/api/logout
        对本地 intake MySQL）——需先起服务并设 BASE，否则自动跳过（不算失败）。

   用法：
     A 组：node --test tools/ui-shell.test.mjs
     B 组（连真库）：先 `PORT=5199 node server.mjs`，再
        BASE=http://127.0.0.1:5199 ADMIN_PW=admin123 node --test tools/ui-shell.test.mjs
   ============================================================ */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUB = path.join(ROOT, 'public');
const read = f => fs.readFileSync(path.join(PUB, f), 'utf8');

const themeCss = read('assets/theme.css');
const shellJs = read('assets/shell.js');
const uiJs = read('assets/ui.js');

const ADMIN_PAGES = ['console.html', 'inbox.html', 'detail.html', 'projects.html', 'customers.html', 'kb.html', 'model-config.html', 'accounts.html'];

/* ============================================================
   A 组 · 原型外壳 DOM/CSS 静态断言（锁 re-target 原型基线）
   ============================================================ */

// [AC-14] 主色 token = 藏青 #0F2744（2026-07-22 用户裁决：对齐实施端登录按钮；推翻早前靛蓝 #3A4CA8）
test('A1 [AC-14] theme.css 主色 token --color-primary = 藏青 #0F2744', () => {
  assert.match(themeCss, /--color-primary:\s*#0F2744/i, '主色 token --color-primary = #0F2744');
  assert.match(themeCss, /var\(--color-primary\)/, '主色通过 var(--color-primary) 引用（改 token 即换肤）');
  // 衍生色 + 深色侧栏 token（侧栏底同步藏青）
  assert.match(themeCss, /--color-primary-light:\s*#E8EDF3/i, '含 --color-primary-light 衍生');
  assert.match(themeCss, /--sidebar-bg:\s*#0F2744/i, '含深色侧栏底色 token --sidebar-bg');
});

// [AC-15] theme.css App Shell 布局类齐全（深色分组侧栏 + 顶栏 + 多标签 + page-content）
test('A2 [AC-15] theme.css App Shell 布局类齐全', () => {
  for (const cls of ['.app-layout', '.sidebar', '.sidebar-brand', '.sidebar-nav', '.nav-section', '.nav-item', '.nav-badge', '.sidebar-footer',
    '.topbar', '.breadcrumb', '.org-pill', '.user-area', '.user-trigger', '.dropdown', '.tab-bar', '.tab-item', '.page-content']) {
    assert.match(themeCss, new RegExp(cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{'), `theme.css 应含布局类 ${cls}`);
  }
  // 激活态：浅底 + 左 3px 竖条
  assert.match(themeCss, /\.nav-item\.active\s*\{/, '.nav-item.active 激活态样式');
  assert.match(themeCss, /\.nav-item\.active::before\s*\{[^}]*width:\s*3px/, '激活态左 3px 竖条 ::before');
});

// [AC-15] theme.css 组件基类齐全
test('A3 [AC-15] theme.css 组件基类齐全（.btn/.card/.stat-card/.data-table/.tag/.progress）', () => {
  for (const cls of ['.btn ', '.btn-primary', '.btn-danger', '.btn-ghost', '.card ', '.card-header', '.card-body', '.stat-card',
    '.data-table', '.tag ', '.tag-success', '.tag-danger', '.tag-primary', '.tag-gray', '.progress']) {
    assert.match(themeCss, new RegExp(cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{'), `theme.css 应含组件类 ${cls.trim()}`);
  }
});

// [AC-16] 数据表格表头 sticky
test('A4 [AC-16] .data-table thead th 表头 sticky 固定', () => {
  assert.match(themeCss, /\.data-table thead th\s*\{[^}]*position:\s*sticky/, 'thead th 应 position:sticky');
  assert.match(themeCss, /\.data-table thead th\s*\{[^}]*top:\s*0/, 'thead th 应 top:0');
});

// [AC-1/AC-2] shell.js 分组导航（业务域分组 + 映射真实页 + 稳定顺序）
test('A5 [AC-1/AC-2] shell.js 定义业务域分组导航（NAVS），映射真实管理页', () => {
  assert.match(shellJs, /var NAVS\s*=\s*\[/, 'shell.js 应有 NAVS 分组导航配置');
  // 分组标题按业务域
  for (const sec of ['概览', '工单', '主体管理', '知识库', 'AI 引擎', '系统']) {
    assert.ok(shellJs.includes(`section: "${sec}"`), `NAVS 含分组 ${sec}`);
  }
  // 映射真实页（部署真相；「新建进件/submit」已按用户裁决从后台菜单移除）
  for (const href of ['/console.html', '/inbox.html', '/projects.html', '/customers.html', '/kb.html', '/model-config.html', '/accounts.html']) {
    assert.ok(shellJs.includes(`href: "${href}"`), `NAVS 映射真实页 ${href}`);
  }
  assert.ok(!/label:\s*"新建进件"/.test(shellJs), '后台菜单不含「新建进件」（已按用户裁决移除）');
  // 品牌主标题「收件 intake」
  assert.match(shellJs, /收件 intake/, 'shell 品牌主标题「收件 intake」');
});

// [AC-3] 激活态由 data-nav 唯一命中（.active）
test('A6 [AC-3] shell.js 按 data-nav 给当前 .nav-item 加 .active', () => {
  assert.match(shellJs, /activeNav\s*=\s*body\.getAttribute\("data-nav"\)/, '从 data-nav 读当前导航 id');
  assert.match(shellJs, /it\.id === activeNav \? "active"/, '当前 nav-item 加 .active');
});

// [AC-4] 未读角标 由 /api/notifications.count 驱动收件箱 .nav-badge
test('A7 [AC-4] 未读数由 /api/notifications.count 驱动收件箱 .nav-badge（>0 才渲染）', () => {
  assert.match(shellJs, /\/api\/notifications/, 'shell.js 请求 /api/notifications');
  assert.match(shellJs, /it\.id === "inbox" && notifCount > 0/, '收件箱 & count>0 才渲染角标');
  assert.match(shellJs, /nav-badge/, '渲染 .nav-badge 角标');
});

// [AC-6/AC-7] 顶栏：面包屑 + 机构胶囊 + 帮助 + 通知 + 用户区
test('A8 [AC-6/AC-7] 顶栏含 面包屑 + 机构胶囊(占位) + 帮助 + 通知 + 用户区', () => {
  assert.match(shellJs, /data-breadcrumb/, '读 data-breadcrumb 渲染面包屑');
  assert.match(shellJs, /class="breadcrumb"/, '渲染 .breadcrumb');
  assert.match(shellJs, /class="org-pill"/, '渲染机构胶囊 .org-pill');
  assert.match(shellJs, /收件运营部/, '机构名固定占位「收件运营部」（NH-1：/api/me 无机构字段）');
  assert.match(shellJs, /id="topbarBell"/, '渲染通知按钮 #topbarBell');
  assert.match(shellJs, /class="user-area"/, '渲染用户区 .user-area');
});

// [AC-8] 用户区由 /api/me 驱动 + 下拉（改密 / 退出 danger）
test('A9 [AC-8] 用户区由 /api/me 驱动，下拉含 修改密码 + 退出(danger)', () => {
  assert.match(shellJs, /fetch\("\/api\/me"\)/, 'shell.js 请求 /api/me');
  assert.match(shellJs, /me\.name \|\| me\.username/, '用户名取 me.name||me.username');
  assert.match(shellJs, /roleLabel\(me\.role\)/, '角色文案由 me.role 映射');
  assert.match(shellJs, /class="dropdown"/, '用户下拉 .dropdown');
  assert.match(shellJs, /id="ddChpw"/, '下拉含「修改密码」#ddChpw');
  assert.match(shellJs, /id="ddLogout"[^>]*|dropdown-item danger/, '下拉含 danger 色「退出登录」');
});

// [AC-9] 改密走 uiPrompt → POST /api/change-password
test('A10 [AC-9] 改密走 uiPrompt(原/新密码) → POST /api/change-password', () => {
  assert.match(shellJs, /uiPrompt\(/, '改密用 uiPrompt 收密码');
  assert.match(shellJs, /inputType:\s*"password"/, 'uiPrompt 密码输入类型');
  assert.match(shellJs, /\/api\/change-password/, '调 POST /api/change-password');
  assert.match(shellJs, /if \(oldp == null\) return/, '取消(null)则中止');
});

// [AC-10] 退出登录 → /logout（单应用无门户，非原型 ../index.html）
test('A11 [AC-10] 退出登录跳 /logout（单应用无门户，不用原型 ../index.html）', () => {
  assert.match(shellJs, /location\.href = "\/logout"/, '退出跳 /logout（server 302 → /login.html）');
  assert.doesNotMatch(shellJs, /\.\.\/index\.html/, '不用原型的 ../index.html（本系统单应用无门户，会 404）');
});

// [AC-11] 未登录态：登录 / 建管理员按钮
test('A12 [AC-11] 未登录态渲染 登录 / 去创建管理员 按钮', () => {
  assert.match(shellJs, /href="\/login\.html"/, 'authEnabled 时渲染登录按钮');
  assert.match(shellJs, /href="\/accounts\.html"/, '未启用认证时渲染建管理员按钮');
});

// [AC-12/AC-13] 多标签工作区：localStorage 持久化 + 工作台固定 + 上限 12
test('A13 [AC-12/AC-13] 多标签工作区（localStorage 持久化 + 工作台固定 + 上限12 + 关当前跳相邻）', () => {
  assert.match(shellJs, /intake_admin_tabs/, 'localStorage key intake_admin_tabs 持久化');
  assert.match(shellJs, /class="tab-bar"/, '渲染 .tab-bar');
  assert.match(shellJs, /HOME_TAB\s*=\s*\{[^}]*fixed:\s*true/, '工作台 HOME_TAB fixed:true 不可关');
  assert.match(shellJs, /tabs\.length > 12/, 'Tab 上限 12');
  assert.match(shellJs, /if \(id === activeNav\)/, '关当前 Tab 跳相邻/回工作台');
});

// [AC-8/角色] 判管理员 = admin||dev；非管理员只留提交入口；link 不注入
test('A14 [角色自适应] 判管理员 admin||dev、非管理员只留提交入口、link 不注入外壳', () => {
  assert.match(shellJs, /me\.role === "admin" \|\| me\.role === "dev"/, '判管理员含遗留 dev');
  assert.match(shellJs, /FIELD_NAV\s*=\s*\{\s*submit:/, '非管理员白名单只含 submit');
  assert.match(shellJs, /isAdmin \|\| FIELD_NAV\[it\.id\]/, '非管理员按白名单过滤菜单');
  assert.match(shellJs, /me && me\.link/, 'token 链接访客不注入后台外壳（重定向提交页）');
});

// [AC-17] 全局弹窗助手（ui.js 复用）
test('A15 [AC-17] 全局弹窗助手齐全（uiConfirm/uiAlert/uiPrompt + Esc/遮罩关闭）', () => {
  assert.match(uiJs, /window\.uiConfirm\s*=/, '暴露 window.uiConfirm');
  assert.match(uiJs, /window\.uiAlert\s*=/, '暴露 window.uiAlert');
  assert.match(uiJs, /window\.uiPrompt\s*=/, '暴露 window.uiPrompt');
  assert.match(uiJs, /e\.key\s*===\s*'Escape'/, 'Esc 关闭弹窗');
  assert.match(uiJs, /e\.target\s*===\s*mask/, '点遮罩关闭');
});

// [AC-18] 8 页套新壳：data-shell + 引 theme.css/ui.js/shell.js + 无旧 .topnav/body.sidebar
test('A16 [AC-18] 全部 8 管理页套原型壳（data-shell + theme.css + shell.js，无旧 .topnav/body.sidebar）', () => {
  for (const p of ADMIN_PAGES) {
    const html = read(p);
    assert.match(html, /<body[^>]*data-shell="admin"/, `${p} <body> 带 data-shell="admin"`);
    assert.match(html, /<body[^>]*data-nav="/, `${p} <body> 带 data-nav`);
    assert.match(html, /<body[^>]*data-breadcrumb="/, `${p} <body> 带 data-breadcrumb`);
    assert.match(html, /\/assets\/theme\.css/, `${p} 应引 theme.css`);
    assert.match(html, /\/assets\/shell\.js/, `${p} 应引 shell.js`);
    assert.match(html, /\/assets\/ui\.js/, `${p} 应引 ui.js（在 shell.js 之前）`);
    // ui.js 先于 shell.js
    assert.ok(html.indexOf('/assets/ui.js') < html.indexOf('/assets/shell.js'), `${p} ui.js 应在 shell.js 之前`);
    // 去掉旧外壳
    assert.doesNotMatch(html, /class="topnav"/, `${p} 不应残留旧 <nav class="topnav">`);
    assert.doesNotMatch(html, /<body class="sidebar">/, `${p} 不应残留旧 <body class="sidebar">`);
    assert.doesNotMatch(html, /\/assets\/nav\.js/, `${p} 不应再引旧 nav.js`);
  }
});

// [AC-19] 全高内滚页（inbox/projects）用 data-content-layout=list 保内部滚动
test('A17 [AC-19] inbox/projects 用 data-content-layout="list"（全高内滚，业务 DOM 保留）', () => {
  for (const p of ['inbox.html', 'projects.html']) {
    assert.match(read(p), /data-content-layout="list"/, `${p} 应标 data-content-layout="list"`);
  }
  assert.match(shellJs, /data-content-layout"\) === "list"/, 'shell.js 据该属性给 page-content 加 list-layout');
  assert.match(themeCss, /\.page-content\.list-layout\s*\{/, 'theme.css 定义 .page-content.list-layout 内滚骨架');
});

/* ============================================================
   B 组 · §4 接口契约「连真库冒烟」（需 BASE 指向已起服务；否则跳过）
   ============================================================ */
const BASE = process.env.BASE || '';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PW = process.env.ADMIN_PW || 'admin123';
const runLive = !!BASE;
let cookie = '';
async function api(p, { method = 'GET', body } = {}) {
  const r = await fetch(BASE + p, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

test('B1 [契约·连真库] /api/me 形状 {authEnabled, me{...}, defaultAdmin}', { skip: runLive ? false : '未设 BASE，跳过连真库冒烟' }, async () => {
  await api('/api/login', { method: 'POST', body: { username: ADMIN_USER, password: ADMIN_PW } });
  const me = await api('/api/me');
  assert.equal(me.status, 200);
  assert.equal(typeof me.json.authEnabled, 'boolean', 'authEnabled:boolean');
  assert.ok('defaultAdmin' in me.json, '含 defaultAdmin');
  assert.ok(me.json.me, 'me 非空(已登录)');
  for (const k of ['id', 'username', 'role', 'name', 'projects', 'sites', 'mustChange']) {
    assert.ok(k in me.json.me, `me.${k} 存在`);
  }
  assert.ok(['admin', 'pm', 'impl', 'field', 'dev'].includes(me.json.me.role), 'role 在真库枚举内(含遗留 dev)');
});

test('B2 [契约·连真库] /api/notifications 形状 {count:number, items:[{project,id,title,lifecycle,type}], role}', { skip: runLive ? false : '未设 BASE，跳过连真库冒烟' }, async () => {
  const n = await api('/api/notifications');
  assert.equal(n.status, 200);
  assert.equal(typeof n.json.count, 'number', 'count:number');
  assert.ok(Array.isArray(n.json.items), 'items:array');
  if (n.json.items.length) {
    for (const k of ['project', 'id', 'title', 'lifecycle', 'type']) assert.ok(k in n.json.items[0], `item.${k} 存在`);
  }
});

test('B3 [契约·连真库] /api/logout → {ok:true}', { skip: runLive ? false : '未设 BASE，跳过连真库冒烟' }, async () => {
  const out = await api('/api/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  assert.equal(out.json.ok, true);
});
