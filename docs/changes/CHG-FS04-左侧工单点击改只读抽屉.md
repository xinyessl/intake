# CHG · 现场端左侧「提交清单」工单点击：从「恢复整段对话续聊」改为「弹只读工单详情抽屉」

- 日期：2026-08-07
- 关联 spec：FS-04（AI 对话提交）——起草 **新增 AC-37 diff**（见本文末，**未合并**，待人审）
- 类型：逻辑/交互行为变更（左侧工单点击行为从"进对话框续聊"→"只读查看内容"，涉及 spec，起草 AC diff）
- 改动文件：`public/field.html`（纯前端）、`tools/fs-04-conversations.logic.test.mjs`（补 D 段断言）

## 背景 / 痛点
现场端左侧「提交清单」只列需求/BUG 工单（咨询已移右上「对话记录」）。工单卡片点击原走 `reopenIntake`：拉 `/api/intake-detail` → 把整段 chat **恢复进右侧对话区续聊**。用户反馈：**工单点击不该进对话框**——续聊已经由**右上「对话记录」**（`reopenConversation`）承担，左侧工单点击应该只**看这条工单的内容**，不该覆盖右侧当前对话。

## 解法（纯前端）
把左侧需求/BUG 工单的点击行为从 `reopenIntake`（恢复对话续聊）改成 `openTicketDrawer`（弹只读「工单详情抽屉」），**不动右侧对话区、不提供续聊入口**（续聊去右上「对话记录」）。

### 1) 点击分派（`bindReopen`）
- `bindReopen`（`mkItem`/`mkSysItem` 两处共用，避免漏系统视图）里：
  - **consult**（咨询，仅系统视图可能有）→ 仍 `reopenConsult`（咨询仍是对话、进对话区续聊）；
  - **requirement/bug**（左侧工单）→ 改 `openTicketDrawer(it)`（不再 `reopenIntake`）。
- `isReopenable`/卡片 `.clickable` 态、`markLeftActive` 选中态、`bindDelete` 软删入口**均不动**（打开抽屉时 `markLeftActive('intake', it.id)` 高亮该条）。
- `reopenIntake` 函数**保留**（右上「对话记录」旧数据兜底 `reopenConversation` 仍用它，见 AC-36）。

### 2) 工单详情抽屉（新增 `openTicketDrawer`/`closeTicketDrawer`/`renderTicketDrawer`）
- **抽屉容器**：复用 `theme.css` 的 `.drawer`/`.drawer-mask`（右滑，同「对话记录」`fConvDrawer`/「经验库」`fKbDrawer` 一套），新增 `#fTkDrawer`/`#fTkMask`/`#fTkContent`。样式 `.f-tk-*` 内联对齐现有抽屉风格（不新造突兀样式）。
- **数据源**：`openTicketDrawer(it)` 拉 `GET /api/intake-detail?project=&id=`（已在 FIELD_OK，返回完整原始工单对象）→ `renderTicketDrawer(item, it)` 只读渲染。带 `data-tkid` 竞态守卫（快速点两条时旧请求不覆盖新内容）。软删/不存在 → 抽屉内提示，不报错。
- **展示字段**（有才显、空的略过）：
  - 顶部：类型标签（复用 `.f-tk` 语义色）+ 状态标签（从左侧卡片 `it.statusTag/statusLabel` 带过来，detail 无此派生字段）+ 编号 + 标题；
  - 元信息网格：现场 / 子系统（`subLabel`）/ 版本 / 紧急程度（`priority`）/ 提交人 / 提交时间（`fmtTime` → `yyyy-MM-dd HH:mm`）；
  - **需求**：需求背景 `bg`、期望效果/具体描述 `reqDesc`、使用场景 `scene`、验收标准 `accept`、关联页面 `relate`；
  - **BUG**：问题现象 `desc`、报错信息 `errorInfo`、复现步骤 `steps`、期望结果 `expectResult`、严重程度 `severity`、影响范围 `scope`、环境 `env`、频率 `freq`；
  - **AI 处理意见/初判**：`opinion`（有则显）+ `analysis`（verdict/category/suggestion/detail 摘要，有则显），主色左边框强调；
  - **截图**：`item.media` → 复用 `mediaUrls()` 生成 `/api/intake-media` 缩略图，点开原图。
  - 长文本字段走现有 `md()` 渲染（与对话气泡同款 markdown）；短字段纯文本 `escapeHtml`（`.plain` 保留换行）。
- **只读**：`openTicketDrawer` 不 `setSubmitKind`、不写 `chat.messages/savedId`——完全不动右侧对话区。底部弱提示引导"到右上「对话记录」续聊"（不提供续聊入口）。
- **关闭**：× 按钮 / 遮罩点击 / Esc 三路（Esc 监听里工单抽屉 > 对话记录抽屉 > 经验库，逐层关最上层）。

## 未涉及 / 未破坏（回归点）
- 右上「对话记录」`reopenConversation`/`reopenIntakeConv` 续聊；确认清单建单（`renderPlanCard`/`intake-commit-plan`）；附图按轮落位；per-ticket 紧急程度；左侧软删（`bindDelete`/`intake-delete`）——**均未改**。
- `/api/intake-detail` 后端接口、字段名、返回结构**未改**（本次纯前端读取展示）。

## 测试
- **逻辑测试**：`tools/fs-04-conversations.logic.test.mjs` 补 **D1..D7**（31 用例全绿）：抽屉三函数 + 容器存在；`bindReopen` req/bug→`openTicketDrawer`（不再 `reopenIntake`）、consult→`reopenConsult`；`openTicketDrawer` 仅 req/bug + 拉 detail + 不动右侧对话（不 `setSubmitKind`/不写 `chat.messages`）+ 竞态守卫；`renderTicketDrawer` BUG/需求各自字段 + AI 意见 + 截图 + 六项元信息 + 长文本走 `md()`；关闭三路 + `markLeftActive`；底部续聊弱提示；`bindDelete` 仍在。
- **连真库冒烟（prod）**：容器内直连 MySQL 造 1 需求 + 1 BUG（各字段齐全）→ `db.loadAll()` 读回（= `/api/intake-detail` 同一 data JSON 数据源）断言抽屉用到的**全部字段名读回一致零错配**（需求 bg/reqDesc/scene/accept/relate/opinion + 元信息；BUG desc/errorInfo/steps/expectResult/severity/scope/env/freq/opinion；analysis.verdict）→ `SMOKE_OK` → 物理删除两条冒烟工单（intakes 剩余 4 条既有数据，无残留）。field.html 已 scp 到 `/opt/intake/public/field.html`（HTTP 200/304901 字节，含 19 处抽屉标记，静态不重启）。

## 风险
- 低。纯前端交互变更 + 复用现有抽屉骨架/组件（`md`/`mediaUrls`/`fmtTime`/`subLabel`/`.drawer`），未动任何后端接口/库结构。
- 唯一行为语义变化：左侧工单点击不再恢复对话续聊——已由右上「对话记录」承担，且抽屉底部弱提示引导，符合用户预期。

---

## 附：spec diff（起草，**未合并**，待人审 → 通过则并入 FS-04 并置 accepted）

> 归属：FS-04 §「提交清单交互」新增一条 AC-37；AC-34 涉及左侧工单点击语义的隐含约束一并点明。

在 FS-04 `### K. 对话全量持久化 …` 之后新增一节：

```diff
+### L. 左侧「提交清单」工单点击 → 只读工单详情抽屉（2026-08-07）
+- **AC-37【左侧工单点击 = 只读查看，不进对话续聊】** Given 现场端左侧「提交清单」只列需求/BUG 工单（AC-34）When 点击某条工单卡片 Then 弹一个**右侧滑出的只读「工单详情抽屉」**（`openTicketDrawer`，复用 `theme.css .drawer/.drawer-mask`）——**不再** `reopenIntake` 把整段对话恢复进右侧对话区、**不动右侧对话区**（续聊改由右上「对话记录」`reopenConversation` 承担，AC-36）。抽屉拉 `GET /api/intake-detail?project=&id=` 取完整工单，**只读**展示（有才显、空略过）：顶部 类型标签 + 状态 + 编号 + 标题；元信息 现场/子系统/版本/紧急程度(`priority`)/提交人/提交时间(`fmtTime`→`yyyy-MM-dd HH:mm`)；**需求**显 `bg/reqDesc/scene/accept/relate`、**BUG** 显 `desc/errorInfo/steps/expectResult/severity/scope/env/freq`；**AI 处理意见/初判** `opinion`+`analysis` 摘要（有才显）；**截图** `item.media`→`/api/intake-media` 缩略图点开原图（复用 `mediaUrls`）。长文本字段走 `md()`（markdown）、短字段纯文本。抽屉可关闭（×/遮罩/Esc，逐层关最上层）；打开时 `markLeftActive` 高亮该条（选中态保留）。抽屉**只读、不提供续聊入口**（底部弱提示引导去「对话记录」）。And 左侧工单卡的**软删入口**（`bindDelete`，AC-34/FS-02 AC-22/23）不变；`consult`（若系统视图仍有）点击仍走 `reopenConsult`（咨询仍是对话）。And `/api/intake-detail` 接口/字段/返回结构不变（本条纯前端读取展示）。
```

并把 AC 计数注脚从「共 **36** 条」更新为「共 **37** 条」，追加：`AC-37（左侧工单点击→只读抽屉，2026-08-07）P1`。
