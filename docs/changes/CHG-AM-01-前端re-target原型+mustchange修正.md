# CHG · AM-01 账号管理：前端 re-target 原型 + 新建 must_change 修正

- 日期：2026-07-21
- 关联 spec：AM-01（涉及 spec，diff 已随交付附上，见验收门）
- 关联 task：T-AM01-enabled（批次 B-manual-20260720）

## 1) 前端重做（涉及 spec：界面基线 re-target · 已改 spec §范围/AC-1）
- `public/accounts.html` 页面**内容**从旧「card + rowlist 两栏」布局重做为原型 `admin/accounts.html` 样：
  整宽 `.data-table`（用户名/姓名/角色/负责医院/状态/创建时间/操作）+ 新增/编辑 `.drawer` 抽屉（用户名/姓名/角色/负责医院多选/负责产品多选/初始密码/状态）+ 筛选（角色/状态/关键词）+ 分页（8/20）。
- 外壳仍由 UI-01 注入式 shell 提供：`<body data-shell="admin" data-nav="accounts" data-content-layout="list">`；用 `theme.css` 组件类。
- **抽屉/toast 自写**（部署 `shell.js` 无 `UI.openDrawer/toast`，见 lessons L-004）：`openDrawer/closeDrawer` 用 `.drawer.open`/`.drawer-mask.open`，toast 用 `.toast-container/.toast.show`；改密/删除危险确认走 ui.js `uiConfirm/uiPrompt`。
- 数据接真实端点：`/api/accounts`（含 enabled/sites）、`/api/account-save`、`/api/account-delete`、`/api/account-reset-password`、`/api/projects`（负责产品候选）、`/api/customers`（负责医院候选，部署客户无 region 字段，缺则不显示地区）。
- 角色下拉 = 部署真实 3 类 `admin/pm/impl`（非原型 4 类含"运营/开发"）；列表 `roleClass` 把遗留 `dev` 归 `admin` 显示。

## 2) 后端 must_change 修正（涉及 spec：AC-8 本就要求 must_change=1，代码原缺失 → 对齐）
- `server.mjs` `account-save` **新建分支**补 `mustChange: true`（原仅 bootstrap admin 与 reset-password 置 1，普通新建漏置 → 新账号首登不强制改密，违反 AC-8）。
- 仅此一处小改，账号相关，不碰状态机/其它模块。改前后 `LC_ALL=C grep -caP '\x00|\xee\x80\x80' server.mjs` = 0（无隐形字符）。
- spec 契约表同步注明「新建置 must_change=1」。

## 3) spec 事实修订（NH-4 收紧未落地 → 标待裁决，非"已定版"）
- 07-20 spec 定版「NH-4 收紧 isAdmin 到 admin-only + 4 角色 + 存量 dev→admin 迁移」**部署未落地**：真库 `admin` 账号 role 实为遗留 `dev`，收紧会瞬间零管理员。
- 修订 §2/§5/§6/AC-18/DoD/裁决留痕：部署维持 3 角色 + `isAdmin=admin||dev`；NH-4 收紧+迁移列为**待裁决**（NEEDS-HUMAN），不本次实施。

## enabled（NH-1）说明：本次未改
- `enabled` 列 / `ensureColumn` ALTER 迁移 / `loadAll` NULL 兜底 / `replaceAccounts` upsert / `pubUser` 出参 / `account-save` 入参 / 登录停用拦截 / `isLastEnabledAdmin` 停用保护 —— **前批已全部落地**（真库已有 `enabled` 列，db.mjs CREATE TABLE + ensureColumn 已含）。本次仅前端消费 + 补测试覆盖，未再改后端 enabled 逻辑。
