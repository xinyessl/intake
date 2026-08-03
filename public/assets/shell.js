/* ============================================================
   收件 intake · 运营后台 —— App Shell 注入器（部署适配版）
   注入 深色分组侧边栏 + 顶栏(面包屑/机构胶囊/帮助/通知/用户下拉) + 多Tab历史栏。
   页面只写业务内容（+可选 .page-header），其余由本文件收集进 .page-content 后注入外壳。
   接入：<body data-shell="admin" data-nav="inbox" data-breadcrumb="工单 > 工单管理">
   ------------------------------------------------------------
   与原型差异（部署真相）：
   · 用户来自真库 /api/me（{authEnabled, me{role,name,username,mustChange,enabled}}）；
     判管理员 = role ∈ {admin, dev(遗留)}。非管理员只留「提交入口」、隐藏后台菜单。
   · 通知来自 /api/notifications（{count,items,role}），count>0 才亮红角标。
   · 退出走 GET /logout（302 → /login.html）；本系统单应用无门户。
   · 机构名 /api/me 无字段 → 固定占位「收件运营部」（NEEDS-HUMAN：机构来源）。
   · 改密走用户下拉「修改密码」→ POST /api/change-password（复用 ui.js 的 uiPrompt/uiAlert）。
   ============================================================ */
(function () {
  "use strict";

  var body = document.body;
  if (!body || body.getAttribute("data-shell") !== "admin") return;

  /* ---------- 导航配置（稳定 sort · 按业务域分组分级 · 映射真实页） ---------- */
  var NAVS = [
    { section: "概览", items: [
      { id: "console", label: "工作台", icon: "ti-layout-dashboard", href: "/console.html" }
    ]},
    { section: "工单", items: [
      { id: "inbox",  label: "工单管理", icon: "ti-inbox", href: "/inbox.html" }
    ]},
    { section: "交付", items: [
      { id: "batches", label: "批次管理", icon: "ti-package", href: "/batches.html" }
    ]},
    { section: "主体管理", items: [
      { id: "projects",  label: "产品管理", icon: "ti-box",               href: "/projects.html" },
      { id: "customers", label: "医院管理", icon: "ti-building-hospital", href: "/customers.html" }
    ]},
    { section: "知识库", items: [
      { id: "kb", label: "经验库", icon: "ti-book", href: "/kb.html" }
    ]},
    { section: "AI 引擎", items: [
      { id: "model-config", label: "模型配置", icon: "ti-cpu", href: "/model-config.html" }
    ]},
    { section: "系统", items: [
      { id: "accounts", label: "账号管理", icon: "ti-users", href: "/accounts.html" }
    ]}
  ];
  // 非管理员（现场：pm/impl）只可见的入口 id 白名单
  var FIELD_NAV = { submit: 1 };

  var NAV_INDEX = {};
  NAVS.forEach(function (g) { g.items.forEach(function (it) { NAV_INDEX[it.id] = it; }); });

  var activeNav = body.getAttribute("data-nav") || "console";
  var breadcrumb = body.getAttribute("data-breadcrumb") || "";
  var ORG_PLACEHOLDER = "收件运营部"; // NEEDS-HUMAN：/api/me 无机构字段，暂固定占位

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function roleLabel(r) { return (r === "admin" || r === "dev") ? "管理员" : r === "pm" ? "产品经理" : r === "impl" ? "实施工程师" : (r || "用户"); }
  function avatarText(name) { var s = String(name || "用户").trim(); return s ? s.slice(0, 1) : "用"; }

  /* ---------- 侧边栏 ---------- */
  function buildSidebar(me, isAdmin, notifCount) {
    var nav = "";
    NAVS.forEach(function (g) {
      var items = g.items.filter(function (it) { return isAdmin || FIELD_NAV[it.id]; });
      if (!items.length) return;
      nav += '<div class="nav-section">' + esc(g.section) + "</div>";
      items.forEach(function (it) {
        // 收件箱挂通知未读角标（管理员 & count>0）
        var badge = (isAdmin && it.id === "inbox" && notifCount > 0) ? '<span class="nav-badge">' + notifCount + "</span>" : "";
        nav += '<div class="nav-item ' + (it.id === activeNav ? "active" : "") + '" data-href="' + it.href + '">' +
          '<i class="ti ' + it.icon + '"></i><span class="nav-label">' + esc(it.label) + "</span>" + badge + "</div>";
      });
    });
    return '<aside class="sidebar">' +
      '<div class="sidebar-brand">' +
        '<div class="logo"><i class="ti ti-clipboard-check"></i></div>' +
        "<div>" +
          '<div class="brand-title">收件 intake</div>' +
          '<div class="brand-sub">运营后台 · 维护端</div>' +
        "</div>" +
      "</div>" +
      '<nav class="sidebar-nav">' + nav + "</nav>" +
      '<div class="sidebar-footer">v1.0 · 收件运营后台</div>' +
    "</aside>";
  }

  /* ---------- 顶栏 ---------- */
  function buildTopbar(me, isAdmin, authEnabled) {
    var crumbs = breadcrumb.split(">").map(function (s) { return s.trim(); }).filter(Boolean);
    var crumbHtml = crumbs.map(function (c, i) {
      return (i ? '<span class="sep"><i class="ti ti-chevron-right"></i></span>' : "") + '<span class="crumb">' + esc(c) + "</span>";
    }).join("");

    var userHtml;
    if (me) {
      var nm = me.name || me.username || "用户";
      userHtml =
        '<div class="user-area" id="userArea">' +
          '<div class="user-trigger" id="userTrigger">' +
            '<div class="avatar">' + esc(avatarText(nm)) + "</div>" +
            "<div>" +
              '<div class="u-name">' + esc(nm) + "</div>" +
              '<div class="u-role">' + esc(roleLabel(me.role)) + "</div>" +
            "</div>" +
            '<i class="ti ti-chevron-down" style="font-size:15px;color:var(--color-text-tertiary)"></i>' +
          "</div>" +
          '<div class="dropdown" id="userDropdown">' +
            '<div class="dropdown-head">' +
              '<div class="avatar" style="width:38px;height:38px;font-size:15px">' + esc(avatarText(nm)) + "</div>" +
              "<div>" +
                '<div style="font-weight:600">' + esc(nm) + "</div>" +
                '<div style="font-size:12px;color:var(--color-text-tertiary)">' + esc(me.username || "") + " · " + esc(roleLabel(me.role)) + "</div>" +
              "</div>" +
            "</div>" +
            '<div class="dropdown-item" id="ddChpw"><i class="ti ti-lock"></i>修改密码</div>' +
            '<div class="dropdown-divider"></div>' +
            '<div class="dropdown-item danger" id="ddLogout"><i class="ti ti-logout"></i>退出登录</div>' +
          "</div>" +
        "</div>";
    } else if (authEnabled) {
      userHtml = '<a class="btn" href="/login.html"><i class="ti ti-login"></i>登录</a>';
    } else {
      userHtml = '<a class="btn" href="/accounts.html"><i class="ti ti-shield-plus"></i>去创建管理员</a>';
    }

    return '<header class="topbar">' +
      '<div class="breadcrumb"><i class="ti ti-home" style="font-size:16px"></i>' + (crumbHtml || '<span class="crumb">运营后台</span>') + "</div>" +
      '<div class="topbar-right">' +
        '<span class="org-pill"><i class="ti ti-building"></i>' + esc(ORG_PLACEHOLDER) + "</span>" +
        '<button class="topbar-icon-btn" title="帮助"><i class="ti ti-help-circle"></i></button>' +
        '<button class="topbar-icon-btn" id="topbarBell" title="通知"><i class="ti ti-bell"></i></button>' +
        userHtml +
      "</div>" +
    "</header>";
  }

  /* ---------- 多 Tab 历史栏（localStorage 持久化） ---------- */
  var TAB_KEY = "intake_admin_tabs";
  var HOME_TAB = { id: "console", label: "工作台", href: "/console.html", fixed: true };

  function loadTabs() {
    try {
      var raw = JSON.parse(localStorage.getItem(TAB_KEY) || "null");
      if (Array.isArray(raw) && raw.length) {
        if (!raw.some(function (t) { return t.id === "console"; })) raw.unshift(HOME_TAB);
        return raw;
      }
    } catch (e) {}
    return [HOME_TAB];
  }
  function saveTabs(tabs) { try { localStorage.setItem(TAB_KEY, JSON.stringify(tabs)); } catch (e) {} }

  function registerCurrentTab(tabs) {
    var cur = NAV_INDEX[activeNav];
    if (!cur) return tabs;
    if (!tabs.some(function (t) { return t.id === cur.id; })) {
      tabs.push({ id: cur.id, label: cur.label, href: cur.href });
      if (tabs.length > 12) {
        var idx = tabs.findIndex(function (t) { return !t.fixed && t.id !== activeNav; });
        if (idx > -1) tabs.splice(idx, 1);
      }
    }
    return tabs;
  }

  function renderTabs(tabs) {
    return tabs.map(function (t) {
      var active = t.id === activeNav ? "active" : "";
      var fixed = t.fixed ? "fixed" : "";
      var icon = (NAV_INDEX[t.id] && NAV_INDEX[t.id].icon) || "ti-file";
      return '<div class="tab-item ' + active + " " + fixed + '" data-tab="' + t.id + '" data-href="' + t.href + '">' +
        '<i class="ti ' + icon + '"></i><span>' + esc(t.label) + "</span>" +
        '<span class="tab-close" data-close="' + t.id + '"><i class="ti ti-x"></i></span>' +
      "</div>";
    }).join("");
  }

  /* ---------- 组装 Shell ---------- */
  function mount(me, isAdmin, authEnabled, notifCount) {
    // 收集页面内容（非 script 节点）
    var contentNodes = [];
    Array.prototype.forEach.call(body.childNodes, function (n) {
      if (n.nodeType === 1 && n.tagName !== "SCRIPT") contentNodes.push(n);
      else if (n.nodeType === 3 && n.textContent.trim()) contentNodes.push(n);
    });

    var pcCls = "page-content" + (body.getAttribute("data-content-layout") === "list" ? " list-layout" : "");
    var layout = document.createElement("div");
    layout.className = "app-layout";
    layout.innerHTML = buildSidebar(me, isAdmin, notifCount) +
      '<div class="app-main">' + buildTopbar(me, isAdmin, authEnabled) + '<div class="tab-bar" id="tabBar"></div><div class="' + pcCls + '" id="pageContent"></div></div>';

    var pageContent = layout.querySelector("#pageContent");
    contentNodes.forEach(function (n) { pageContent.appendChild(n); });

    body.insertBefore(layout, body.firstChild);

    // 渲染 Tab
    var tabs = registerCurrentTab(loadTabs());
    saveTabs(tabs);
    var tabBar = document.getElementById("tabBar");
    if (tabBar) tabBar.innerHTML = renderTabs(tabs);

    bindEvents(me);
    body.classList.add("shell-ready");   // 兜底显出（配合 theme.css body[data-shell] 防闪；:has 不支持时靠这条）
  }

  function bindEvents(me) {
    // 侧边栏导航
    document.querySelectorAll(".nav-item").forEach(function (el) {
      el.addEventListener("click", function () { var h = el.getAttribute("data-href"); if (h) location.href = h; });
    });
    // 通知铃 → 收件箱
    var bell = document.getElementById("topbarBell");
    if (bell) bell.addEventListener("click", function () { location.href = "/inbox.html"; });
    // 用户下拉
    var trigger = document.getElementById("userTrigger");
    var dropdown = document.getElementById("userDropdown");
    if (trigger && dropdown) {
      trigger.addEventListener("click", function (e) { e.stopPropagation(); dropdown.classList.toggle("open"); });
      document.addEventListener("click", function () { dropdown.classList.remove("open"); });
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") dropdown.classList.remove("open"); });
    }
    // 修改密码
    var chpw = document.getElementById("ddChpw");
    if (chpw) chpw.addEventListener("click", async function () {
      if (dropdown) dropdown.classList.remove("open");
      if (typeof window.uiPrompt !== "function") { alert("弹窗组件未加载"); return; }
      var oldp = await window.uiPrompt("请输入原密码：", { title: "修改密码", inputType: "password", placeholder: "原密码" }); if (oldp == null) return;
      var np = await window.uiPrompt("请输入新密码（至少 6 位）：", { title: "修改密码", inputType: "password", placeholder: "新密码" }); if (np == null) return;
      try {
        var r = await (await fetch("/api/change-password", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ old: oldp, new: np }) })).json();
        r.ok ? window.uiAlert("密码已修改", { type: "ok" }) : window.uiAlert("修改失败：" + (r.error || ""), { type: "err" });
      } catch (err) { window.uiAlert("修改失败：" + err.message, { type: "err" }); }
    });
    // 退出登录
    var logout = document.getElementById("ddLogout");
    if (logout) logout.addEventListener("click", function () { location.href = "/logout"; });

    // Tab 点击 / 关闭
    var tabBar = document.getElementById("tabBar");
    if (tabBar) tabBar.addEventListener("click", function (e) {
      var closeEl = e.target.closest("[data-close]");
      if (closeEl) {
        e.stopPropagation();
        var id = closeEl.getAttribute("data-close");
        var list = loadTabs().filter(function (t) { return t.id !== id; });
        saveTabs(list);
        if (id === activeNav) {
          var next = list[list.length - 1];
          location.href = (next && next.href) || "/console.html";
        } else {
          tabBar.innerHTML = renderTabs(list);
        }
        return;
      }
      var tabEl = e.target.closest(".tab-item");
      if (tabEl) { var h = tabEl.getAttribute("data-href"); if (h) location.href = h; }
    });
  }

  /* ---------- 用户区/角标 就地补丁（拿到真实 /api/me 后更新，不重建外壳、不重绑事件） ---------- */
  function patchUser(me) {
    if (!me) return;
    var nm = me.name || me.username || "用户", av = avatarText(nm), rl = roleLabel(me.role);
    document.querySelectorAll("#userArea .avatar").forEach(function (el) { el.textContent = av; });
    var un = document.querySelector("#userArea .u-name"); if (un) un.textContent = nm;
    var ur = document.querySelector("#userArea .u-role"); if (ur) ur.textContent = rl;
    var dh = document.querySelector("#userDropdown .dropdown-head > div:last-child");
    if (dh) dh.innerHTML = '<div style="font-weight:600">' + esc(nm) + '</div><div style="font-size:12px;color:var(--color-text-tertiary)">' + esc(me.username || "") + " · " + esc(rl) + "</div>";
  }
  function patchBadge(count) {
    var item = document.querySelector('.nav-item[data-href="/inbox.html"]');
    if (item && count > 0 && !item.querySelector(".nav-badge")) {
      var b = document.createElement("span"); b.className = "nav-badge"; b.textContent = count; item.appendChild(b);
    }
  }
  function filterNavForField() {   // 兜底：非管理员误入后台页时只留提交入口
    document.querySelectorAll(".nav-item").forEach(function (el) {
      if ((el.getAttribute("data-href") || "") !== "/submit.html") el.style.display = "none";
    });
  }

  /* ---------- 立即挂载外壳（不等接口，消除"裸内容→跳进外壳"的闪烁）；用户/通知随后异步补 ---------- */
  function boot() {
    // 管理端页均需登录（authGate 拦未登录/非管理员）→ 乐观按"已登录管理员"先建壳
    mount({ name: "", username: "", role: "" }, true, true, 0);
    // 异步补真实用户 + 通知 + 角色兜底（就地更新，不重挂）
    fetch("/api/me").then(function (r) { return r.json(); }).then(function (r) {
      var me = r && r.me, isAdmin = !!(me && (me.role === "admin" || me.role === "dev"));
      if (me && me.link) { location.href = "/submit.html"; return; }   // token 链接访客不进后台外壳，重定向提交页
      if (me) patchUser(me);
      if (me && !isAdmin) filterNavForField();
      if (me) fetch("/api/notifications").then(function (r) { return r.json(); }).then(function (n) { var c = (n && typeof n.ticketCount === "number") ? n.ticketCount : (n && n.count) || 0; if (c > 0) patchBadge(c); }).catch(function () {});   // 工单管理角标只计工单，维保提醒走 customers.html 维保列 + 实施端待办
    }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
