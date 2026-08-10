# CHG · FS-04 · 窄视口长答复不再溢出或被裁切

- 日期：2026-08-10
- 类型：纯前端缺陷修复；补 FS-04 AC-41 防回归边界
- 状态：已实现、自测通过，待人验收；未部署

## 现象与根因

实施端咨询答疑页在浏览器右侧打开调试工具后，可用宽度明显收窄。旧版工作区虽然使用 flex 布局，但右侧面板、消息行、气泡与输入行缺少完整的 `min-width:0` / 最大宽度约束；超长 URL、无断点行内代码或宽表会参与最小内容宽度计算，把右侧面板撑宽，造成答复被右侧裁切或页面出现整体横向滚动。

## 修复范围

1. `public/field.html`：工作区与右侧 AI 面板可安全收缩；消息区只纵向滚动，气泡、经验引用与输入行均限制在面板内。
2. 普通文字、URL、行内代码允许安全换行；代码块和 Markdown 宽表保留内容，只在自身容器横向滚动。
3. `public/assets/ui.js` 与 `public/submit.html` 同步相同的 Markdown 长内容规则，避免后台详情/公开提交页再次出现同类问题。
4. 保留当前 legacy 视觉、URL、接口和权限边界；不启用 React，不改服务端和数据库。

## 验证证据

- `node --test tools/fs-04-narrow-layout.test.mjs tools/markdown-table.logic.test.mjs`：17/17 通过（分隔线用例已包含在 Markdown 套件中）。
- `node --test --test-concurrency=1 tools/*.logic.test.mjs tools/ui-shell.test.mjs tools/ui-select.test.mjs`：323/323 通过，另 9 条既有真库用例因本机 MySQL 不可用按测试设计跳过。
- 浏览器夹具直接加载 `public/field.html` 的真实样式：
  - 980px：`documentElement.scrollWidth = clientWidth = 980`；AI 气泡、长 inline code、输入框、发送按钮均在右侧面板内；宽表 `clientWidth=357`、`scrollWidth=780`，仅表格容器横滚。
  - 760px：`documentElement.scrollWidth = clientWidth = 760`；右侧面板宽 333px，气泡与输入区仍在面板内；宽表 `clientWidth=172`、`scrollWidth=780`，仅表格容器横滚。

## 影响与风险

- 不改任何接口、数据或权限逻辑，无真库写入。
- 仅增加收缩与溢出约束，不改颜色、字号层级、组件位置或交互行为。
- FS-01/FS-04/FS-06 三套真库整套已尝试运行；本机 `127.0.0.1:3306` 未启动，服务在 before hook 阶段被 `ECONNREFUSED` 阻断，未进入业务断言。该环境阻断与本次纯 CSS 修复无关，未臆造连接配置。
- 任务保持 `doing`，未经用户验收不置 `done`。
