# CHG · FS-01/AM-01 · 登录去演示账号 + 密码框加"看原文"眼睛

> 日期：2026-07-30　类型：UI 调整（涉及 spec：FS-01 去演示账号=行为变更；密码眼睛=小增强）　来源：用户现场标注截图
> 关联 spec：FS-01（实施端登录门）、AM-01（账号管理·重置密码弹窗）

## 变更 1：实施端登录页去掉「演示账号（点击填入）」块
- **现象/动机**：`public/field.html` 登录卡底部有「演示账号（点击填入）张工 zhanggong / 李工 ligong / 赵工 zhaogong」chip（沿用原型 `redesign.html`）。真实产品不该暴露演示账号入口 → 用户要求去掉。
- **改动**：`public/field.html`
  - 删除 `.f-demo` 整块 HTML（演示账号 label + 3 个 chip）。
  - 删除对应 CSS（`.f-demo/.f-demo-lbl/.f-demo-chips/.f-demo-chip/...`），位置改放密码眼睛样式（见变更 2）。
  - 删除 `bind()` 里 `.f-demo-chip` 的点击填入事件循环。
- **spec 影响（涉及 FS-01，draft，待评审并入）**：
  - FS-01 §2 范围 / AC-1 / AC-2 / §7 静态测试里「演示账号 chip」的 UI 断言**删除**（登录卡不再含演示账号区）。
  - `zhanggong/ligong/zhaogong` 作为**连真库冒烟的测试夹具账号**（自造 impl、测后清理）保留不变——它们是测试数据，不是 UI 元素。
  - PRD §3.2「原型演示账号：张工/李工/赵工」一行同步删除（需求已变）。

## 变更 2：密码输入框加"看真实录入值"的眼睛图标（显示/隐藏切换）
- **动机**：重置密码弹窗、实施端登录密码框都是 `•••••`，用户希望能点一下看到明文原文，确认没输错。
- **改动**：
  - `public/assets/ui.js`（共享弹窗组件 `uiPrompt`）：当 `inputType==='password'` 时，输入框包一层 `.ui-pw` + 右侧 `.ui-pw-eye` 按钮（内联 SVG 眼睛，不依赖图标字体）；点击在 `password↔text` 间切换并换 眼睛/闭眼 图标。**一改惠及所有密码类 `uiPrompt`**——含 AM-01 账号管理的**重置密码弹窗**（`/api/account-reset-password` 前的 `uiPrompt({inputType:'password'})`）。
  - `public/field.html` 登录密码框：`#loginPwd` 外包 `.pw-field` + `#loginPwdEye`（Tabler `ti-eye`/`ti-eye-off`），点击切换显隐。
- **spec 影响（小增强）**：FS-01 登录 AC 补「密码框支持显示/隐藏切换」；AM-01 AC-14（重置密码弹窗）补「密码框可点眼睛查看明文」。均 draft，评审时并入。
- **安全说明**：仅前端本地在用户主动点击时临时显示自己正在输入的明文；不改任何存储（仍 scrypt 散列）、不新增接口、不落库。

## 未涉及
- 不改数据库、不改后端鉴权/端点、不改 `DEFAULT_PWD` 逻辑。
- 纯静态前端（`field.html` + `ui.js`），无需 DB 迁移。
