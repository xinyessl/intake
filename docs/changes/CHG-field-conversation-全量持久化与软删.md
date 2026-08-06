# CHG · 现场端「对话记录」全量持久化 + 软删（沟通过就存·可删）

- 日期：2026-08-06
- 关联 spec：FS-04（AI 对话提交）——起草新增 **AC-36** diff（见本文末，**未合并**，待人审）
- 类型：逻辑/行为增强（新增会话记录实体 + 端点改造 + 软删入口 → 涉及 spec，起草 AC diff）
- 改动文件：
  - `server.mjs`：新增 `saveConvRecord()` 会话记录持久化（type=`intake-conv`）；`intake-chat`/`intake-reply` 每轮 upsert 会话记录；`listIntake` 排除 `intake-conv`；`/api/field/conversations` 改「会话记录为主 + 按 sessionId 关联工单 + 旧数据兜底 + 软删会话记录不复现」。
  - `public/field.html`：`reopenConversation` 改从会话记录恢复整段 chat（`reopenIntakeConv`，含未建单/已建单两路）；对话记录抽屉每条加删除入口（`bindConvDelete`/`doDeleteConversation`，软删、不连带删工单）；未建单会话续聊上下文锁定（`chat.reopenConv*` + `currentArchive` 分支 + 草稿/快照 save/restore/newConversation）；「未建单」计数标 + 删除按钮 CSS。
  - `tools/fs-04-conversations.logic.test.mjs`：随端点改造重写分组复刻 + 新增会话记录/未建单/软删不复现/兜底/前端接线断言（24 用例）。
  - `tools/fs-02-delete.logic.test.mjs`：`listIntake` 过滤断言正则放宽（新增 `&& e.type!=='intake-conv'` 不破坏「先滤 deleted」保证）。

## 背景 / 痛点
「对话记录」（`GET /api/field/conversations`）原口径 = 咨询（consult，每条）+ 提需求/报BUG **已建单**工单（按 `sessionId` 归组）。
**痛点**：提需求/报BUG 在 **AI 还在澄清、尚未建单** 时**没有任何服务端记录** → 不进对话记录、刷新/新对话即丢（只有浏览器草稿能恢复当前这一条）。用户要：**只要沟通过的对话都存**，没建单也能在对话记录里找到、可续聊；且对话记录**支持删除（软删）**。
咨询本就是**每轮落库**（consult 端点每轮 upsert 一条 `type='consult'`）——提需求要对齐这个范式。

## 解法
### 1）会话记录实体 `type='intake-conv'`（沟通过就存·每轮 upsert）
- `saveConvRecord(proj, {sessionId, site, subsystem, version, reporter, role, chat})`：id 确定性派生 `CONV-<sessionId>`（`slice(0,34)`，`'CONV-'(5)+34≤40` 对齐 `intakes.id VARCHAR(40)`）→ 同一次聊天每轮命中同一条（幂等 upsert）。**「沟通过」判据**：chat 里至少一条有内容 user + 一条有内容 assistant，否则不存（回落现状，交前端草稿兜底）。`sessionId` 空不存。软删过的会话记录不复活（`prev.deleted` → 不重建）。
- 随 `intakes` 表 + `data` JSON 落库，**无新库列**（`intakes.type` = `VARCHAR(20)`，无 CHECK/枚举约束，`'intake-conv'`=10 字符容得下——已核 `db.mjs init()`）。
- 挂载点：`/api/intake-chat` 剔除结构块后（无论是否建单）用「本轮 messages + 可见 AI 回复」upsert 会话记录；`/api/intake-reply`（reopen 已建单续聊）用工单最新 `e.chat` 同步刷新会话记录 `chat/updatedAt`（工单沿 `sessionId` 关联，**不建重单**）。
- **会话记录 ≠ 工单**：`listIntake` 排除 `intake-conv`（不进左侧提交清单/批次/客户计数/总览统计/导出/待办等所有消费点）；建单逻辑（`matchAll` 多块 → 多张 requirement/bug）**一字未改**。

### 2）`/api/field/conversations` 改造（会话记录为主）
- consult：每条一项（不变）。
- intake 会话：以 `intake-conv` 会话记录为主（一条=一次聊天，**含未建单**；`ticketCount=0` → 前端显「未建单」），按 `sessionId` 关联本会话建的 requirement/bug 工单统计 `reqCount/bugCount/tickets`。项 `id`=会话记录 id、带 `sessionId` + `fromConv:true`，reopen 从它取整段 chat。
- **兼容旧数据**：有工单但无会话记录的旧 session → 仍按工单 `sessionId` 归组兜底（代表工单=最早提交，chat 从它取），标 `fromConv:false`，别让历史工单会话消失。
- **软删会话记录后彻底消失**：软删掉的 `intake-conv` 其 session 键收进 `deletedConvKeys`，兜底跳过 → 删了对话记录，即便它建过工单也不再被旧数据兜底拉回（工单仍在左侧提交清单）。
- 过滤 `deleted`；收敛口径不变（`user.projects` + `scopedForField` 按 sites）；均按 `updatedAt` 倒序（会话记录 `updatedAt` 取会话/关联工单里最新，建单/续聊后仍排前）。

### 3）软删对话记录（复用 `/api/intake-delete`）
- 复用现有 `/api/intake-delete` + `intakeDeleteGuard`（会话记录/consult 均无 `batch/convertedTo` → 守卫天然放行；现场按 `user.sites` 收敛、越权拒；`history` 留痕）——**未加新端点**。
- **删对话记录 ≠ 删它建的工单**：端点按单条 id 软删，会话记录 id（`CONV-<sessionId>`）与工单 id 各自独立，无级联。工单在左侧提交清单按 FS-02 各自删。
- 前端：抽屉每条加右上角 ✕（`bindConvDelete`，`stopPropagation` 不触发 reopen）→ 确认「删除这条对话记录？…它建的工单不受影响」→ 调 intake-delete → 从抽屉移除。**仅对真正的会话记录/咨询开放**（`isConsult || it.fromConv`）；旧数据兜底项（`fromConv:false`，id 是代表工单）**不给删除入口**，避免误删真实工单。

### 4）前端 reopen
- `reopenConversation`：`it.fromConv` → `reopenIntakeConv`（拉会话记录 `intake-detail` 恢复整段 chat）：已建单 → 逐张补「已建单」卡、续聊走 `intake-reply`（append 代表单）；未建单 → 锁 `sessionId` + `reopenConv*` 上下文，续聊走 `intake-chat`（同 `sessionId` → 同一条会话记录、够了再建单落该上下文）。`it.fromConv=false`（旧数据）→ 沿用从代表工单恢复。consult 不变。
- 未建单续聊上下文锁：`chat.reopenConvProject/Site/Subsystem/Version` + `currentArchive` 新分支（`submitKind==='intake' && !savedId` 时取锁定值），随草稿/快照 save/restore、`newConversation` 重置。

## 验证（连 prod · 数据刚清空·已清造数）
prod `intake.lcpharmacy.cn`（容器 `intake-app` 挂 `/opt/intake→/app`；`server.mjs`→scp+`docker restart`，`field.html`→scp 不重启；改前均备份、密码/密钥不入任何提交物）。真实模型 API 已配。以 impl 账号 `wanglong`（sites=安吉县人民医院/济南市妇幼保健院）临时 session 冒烟，**全部造数已硬删**（intakes 表回 0 行、session 删除、导出文件/media 清理、重启后缓存干净）：

- **① 未建单也存**：`intake-chat` 发含糊「我想优化一下」→ AI 澄清（`savedId:""`，未建单）→ `/api/field/conversations` 出现 `{kind:intake, id:CONV-…, ticketCount:0, fromConv:true, title:"我想优化一下"}`；DB 有 `type='intake-conv'` 一行。
- **② 同会话建单**：同 `sessionId` 续聊到明确需求 → AI 建单 `XQ-…（requirement）`；对话记录该条变 `ticketCount:1, reqCount:1, tickets:[XQ-…]`（仍是**同一条**会话记录，未新增）；左侧 `field/submissions` 出现该 requirement（**无** intake-conv）；会话记录 chat = 整段 4 轮（reopen 恢复全对话，非只最后一轮）。
- **③ 软删对话记录**：删 `CONV-…` → 对话记录**空**（会话彻底消失、含它建的工单会话不再兜底拉回）；`XQ-…` 工单**仍在**左侧提交清单（requirement 计数 1，未连带删）。
- **④ 咨询仍每条一项、可删**：consult 一轮 → `ZX-…` 一项；删之 → 从对话记录消失。
- **⑤ 旧数据兜底**：直插一张带 `sessionId`、无会话记录的旧工单 `XQ-LEGACY-01` → 对话记录以 `fromConv:false, ticketCount:1` 兜底显示（历史工单会话不丢）。
- **逻辑测试**：`tools/fs-04-conversations.logic.test.mjs` 24/24 绿；`fs-02-delete.logic` 17/17；`fs-04-set-priority`/`fs-04-stop-sending`/`version-plan-deploy` 等纯逻辑套件均无回归。（DB 集成套件 `fs-04/fs-02/fs-08.test.mjs` 本机 `ECONNREFUSED 3306` 属既有环境限制、非本次回归，故走连 prod 冒烟。）

## 风险 / 注意
- 存量老会话（无 `intake-conv` 记录）走兜底路径，reopen 时其代表工单没有「整段会话记录」概念——行为同改造前（从代表工单 chat 恢复），可接受。
- 会话记录 `chat` 与工单 `chat` 有冗余（会话记录存整段、工单也各存自己那份）；仅回显用途，不影响建单/流转真值（工单为准）。
- 未建单会话续聊靠 `sessionId` 幂等 upsert 同一条会话记录；若前端 `sessionId` 丢失（异常）会起新记录（回落现状），不产生脏工单。

## spec 同步（FS-04 · 起草 AC-36，未合并）
见下方 diff，`/accept` 时连同拍板；通过则并入 FS-04 §3.I + §5 + AC 计数、`status` 维持 accepted。

```diff
### I. 对话记录与工单拆开（左=工单 / 右上=对话记录 · sessionId 会话分组 · 2026-08-06）
  - **AC-34**（不变）…
+ - **AC-36【对话全量持久化 + 会话记录 + 对话记录软删】**（2026-08-06）Given 现场「提需求/报BUG」在右侧对话区聊天
+   When 本轮**沟通过**（用户发了内容 + AI 回了内容）Then 服务端**不论是否建单**都 upsert 一条**会话记录**
+   （`type='intake-conv'`，id=`CONV-<sessionId>` 确定性派生·同会话每轮命中同一条；随 `intakes` 表 + `data` JSON、
+   **无新库列**；`sessionId` 空不存）——`/api/intake-chat` 每轮存、`/api/intake-reply`（reopen 已建单续聊）同步刷新；
+   **会话记录 ≠ 工单**：`listIntake` 排除 `intake-conv`（不进左侧提交清单/批次/统计/导出/待办），建单逻辑不变、不建重单，
+   工单与会话记录靠 `sessionId` 关联。And `GET /api/field/conversations` 改列**会话记录**：咨询每条一项（不变）；
+   提需求/报BUG 以 `intake-conv` 会话记录为主（一条=一次聊天，**含未建单**·`ticketCount=0` 前端显「未建单」），
+   按 `sessionId` 关联本会话工单统计 `reqCount/bugCount/tickets`、标 `fromConv:true`；**兼容旧数据**：有工单但无会话记录的
+   旧 session 仍按工单 `sessionId` 归组兜底（`fromConv:false`，别让历史工单会话消失）；过滤 `deleted`、收敛口径不变、
+   均按 `updatedAt` 倒序。And reopen 一条会话记录（`reopenIntakeConv`）→ 从会话记录恢复**整段** chat（非只最后一轮）：
+   已建单会话逐张补「已建单」卡、续聊走 `intake-reply`（append 代表单）；未建单会话锁 `sessionId`+归档上下文、
+   续聊走 `intake-chat`（同 `sessionId` → 同一条会话记录、够了再建单）。
+   And **对话记录软删**：抽屉每条加删除入口 → 复用 `POST /api/intake-delete {project,id=会话记录/咨询自身 id}`
+   （`intakeDeleteGuard` 现场按 `user.sites` 收敛、越权拒、`history` 留痕）软删该会话记录/咨询；
+   **删对话记录 ≠ 删它建的工单**（工单在左侧提交清单按 FS-02 各自删）；软删后该会话从对话记录彻底消失
+   （即便建过工单也不被旧数据兜底拉回）。仅对真正的会话记录/咨询开放删除入口（旧数据兜底项 id 是工单 → 不给，防误删）。

> **AC 计数**：共 **36** 条（新增 AC-36，P1）。
```

## 5. 数据契约（追加 · 起草）

```diff
### 5.5 会话记录（`type='intake-conv'`，`saveConvRecord` 落库 · AC-36）
+ - **表/列**：随 `intakes` 表（`db.mjs`），**无新库列**（`type=VARCHAR(20)` 容 `'intake-conv'`；已核 init()）。
+ - **id**：`CONV-<sessionId>`（`sessionId` slice(0,34)），确定性派生 → 同会话每轮幂等 upsert 一条。
+ - **关键字段**（挂 `data` JSON）：`sessionId`（关联本会话工单）、`chat`（整段对话，reopen 恢复源）、
+   `site/subsystem/version/reporter/role`、`title`（首条 user 文本 ≤60）、`submittedAt`（首轮）/`updatedAt`（每轮）、
+   `status='沟通中'`/`lifecycle='沟通中'`、`deleted`（软删标记，同 FS-02 范式）。
+ - **不入**：左侧提交清单/批次/客户计数/总览/导出/待办（`listIntake` 已排除 `intake-conv`）。
```
