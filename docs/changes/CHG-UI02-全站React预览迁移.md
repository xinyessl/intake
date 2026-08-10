# CHG-UI02 · [已撤回] 全站 React 预览迁移

- 日期：2026-08-10
- 类型：已撤回的前端架构迁移（历史记录，不是当前实现）
- 关联：`UI-02`、`UI02-FOUNDATION-1` ～ `UI02-CUTOVER-9`

## 撤回结论（当前事实）

2026-08-10 用户明确要求撤回全站 React/AntD，样式不要改动。生产已从备份 `/opt/intake-backups/intake-before-react-cutover-20260810-160515.tar.gz` 恢复 legacy，并验证 `/field.html`、`/login.html` 为旧页面。本地同步撤回全站工作区、构建产物、服务端接管和任务批次。

以下内容只记录曾经实现和验证过的方案，**已失效，不得作为当前系统实现依据**。

## 历史实施结果（已撤回）

在 `frontend/intake-app/` 建成 React 18 + Vite 5 + Ant Design 5 单一工作区，产出 13 个正式页面和独立 preview：实施工作台、公开提交、登录、运营首页、工单列表、工单详情、批次、医院、产品、经验库、账号、模型、提示词。

所有页面共享外壳、主题、鉴权、请求、Markdown、错误边界以及加载/空/错误状态。正式构建位于 `public/react/intake/`，preview 仍保留在 `/preview/intake-react/`；旧 `public/*.html` 仅作一键回滚源。

## 本轮补齐

- 实施端：医院/系统维度、刷新恢复、咨询/需求/BUG、对话记录、停止发送与真实经验引用。
- 公开入口：token 提交页、Session 登录、角色分流、首次登录强制改密。
- 工单：运营总览、筛选/导出/建单、详情、AI 分析和处理流转。
- 交付：批次编排、部署清单审核、开发清单、产品/Git/提交链接、医院产品版本和联系人。
- 配置：经验库筛选分页与增删、账号重置入口、主备模型、提示词保存。
- 兼容：preview 内部链接与 401/登录成功跳转保持在 preview；未登录可加载 React 登录页及其静态资源，后台页和 API 仍受原鉴权闸保护。

## 验证

- Vitest：14/14 通过。
- 关联逻辑与正式入口回归：83/83 通过（刷新恢复、经验引用、全览、Markdown、提示词配置、13 路由映射和显式回滚）。
- Vite production build：13 个 HTML 入口通过。
- bundle smoke：10 个 JS、2 个 CSS；JS 1,452,311 bytes、CSS 18,456 bytes；无 sourcemap、无 `process.env` 残留。
- 临时真实 MySQL：医院产品/联系人写入回读、工单建批、部署清单审核、模型保存、经验新增删除、Session 登录与改密接口通过。
- 浏览器：13 页可打开；批次审核保存、医院编辑、Git/提交链接、经验增删、模型主备切换、账号重置弹窗、提示词保存均完成实际点击回归。首次改密按真实契约 `{old,new}` 完成 HTTP/Session/真库/跳转验证；切换前仍安排一次人工按钮点击确认。
- 详细证据：`docs/reviews/UI-02-切换前验收-20260810.md`；部署与回滚步骤：`docs/reviews/UI-02-线上部署与回滚清单-20260810.md`。

## 正式入口代码切换

- 新增 `cutover` 构建，产物独立落在 `public/react/intake/`，资源固定使用 `/react/intake/assets/`；preview 仍可独立构建。
- `field/submit/login/console/inbox/detail/batches/customers/projects/kb/accounts/model-config/prompts` 13 个原 URL 默认由 `server.mjs` 映射到 React 正式构建，URL、查询串、接口和鉴权规则不变。
- 旧 `public/*.html` 不再是默认响应源，保留为回滚源；设置 `INTAKE_UI_LEGACY=1` 并重启即可恢复旧页面。
- 原地址浏览器回归 13/13 通过；未登录 login/field=200、console=302、React 散列资源=200；独立回滚实例实测返回旧版 HTML。

## 尚未执行

- 未物理删除 legacy 原生业务 HTML/JS/CSS（稳定期回滚需要）。
- 未经人工验收，不将 UI02 任务标记为 `done`。

## 线上部署证据

- 部署前备份：`/opt/intake-backups/intake-before-react-cutover-20260810-160515.tar.gz`。
- 应用容器已成功重启。
- 实施域 `/field.html`、`/login.html` 返回 HTTP 200。
- 运营域后台页面在未登录状态均返回 HTTP 302 并跳转 `/login.html`，权限边界未被放开。
- 真实浏览器检查实施端和运营端页面均无错误；实施端 4 个菜单、运营端 8 个菜单逐项点击跳转成功。

上述线上切换随后已按用户要求撤回；当前正式入口恢复 legacy。UI02 任务未验收、未标 `done`，并已从任务清单移除。
