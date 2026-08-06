# CHG · FS-04 · 现场提需求/报BUG 提交可手选紧急程度（覆盖 AI 猜测 · 非法回落）

> 日期：2026-08-06　类型：逻辑/行为调整（新需求，**涉及 spec** → 附 spec diff，见下「关联 spec diff」，待人审核后合并）
> 来源：用户敲定需求（现场自选紧急程度，仅「提需求/报BUG」，咨询模式不加）
> 关联：`public/field.html`（前端选择器 + chat.priority + 快照/草稿 + 提交带参）、`server.mjs`（`normPriority` 校验 + 两建单分支覆盖）
> 未改库：`intakes.priority VARCHAR(10)` 为现有列（`db.mjs` L37 CREATE TABLE + L99-102 `upsertIntake` INSERT/UPDATE 均含 `priority`，`c(e.priority,10)` 截断），四档最长「紧急」2 字符，无新列、无库改。
> 不动：后台 `inbox.html`/`detail.html`（已按 priority 显四档配色，自动生效；由另一 agent 并行改，本次避冲突不碰）。

## 需求
需求/BUG 工单已有 `priority`（四档 紧急/高/中/低，后台已配色），但现场端提交时**无手选入口**——priority 靠 AI 猜（`intake-chat` 建 record 时 `rec.priority`）或默认「中」。要在**现场提需求/报BUG 提交时让现场自己选紧急程度**（咨询模式不加）。

## 改动

### 前端 `public/field.html`（照现有 `chat.deep`/`syncDeep` 每一处对称加 `chat.priority`）
- **选择器**：工具条 `#fActx` 深入思考按钮之后加 `<span class="f-pri" id="fPri"> 紧急程度 <select id="fPriSel">中/高/紧急/低</select></span>`（顺序/默认与后台 `inbox.html` L219 一致，默认「中」=首项）。CSS `.f-pri`（含 `.hide`）风格对齐 `.f-deep`。
- **显隐**：新增 `syncPriority()`——**仅 `submitKind==='intake'`（提需求/报BUG）显示**，咨询隐藏；`setSubmitKind`/`newConversation`/`restoreConversation`/`restoreDraft` 各处 syncDeep 旁并调 syncPriority（与 deep 显隐互斥：deep 仅 consult、priority 仅 intake）。
- **状态**：`chat.priority='中'` 初始；随会话草稿/快照 save/restore（`snapshotConversation`/`restoreConversation`/`saveDraft`/`restoreDraft` 均加 `priority` 字段，非法兜底「中」）；`newConversation` 重置「中」；`reopenIntake` 回显该工单已有 `item.priority`（仅显示，续聊走 intake-reply 不带 priority、不改工单档位）。
- **提交带参**：`sendIntake` → `POST /api/intake-chat` body 加 `priority: chat.priority`（非法兜底中）。
- **绑定/导出**：`#fPriSel` `change` → `setPriority(this.value)`；`syncPriority`/`setPriority` 挂 `window.__field`。
- 前端白名单 `PRI_SET={紧急,高,中,低}` 仅用于回填/提交前兜底（后端再校验为准）。

### 后端 `server.mjs`（校验回落，防脏值入库）
- 模块顶层加 `const PRIORITY_SET = new Set(['紧急','高','中','低'])` + `function normPriority(v, fallback='中')`（trim 后合法四档→原值，非法/空→fallback）。
- `/api/intake-chat` 建 record（L2098）：`priority: normPriority(b.priority, rec.priority || '中')` —— **现场手选优先，非法/空回落 AI 猜的 `rec.priority`，再回落「中」**（现场覆盖 AI）。
- `/api/intake-submit` 表单直提（L2056）：`priority: normPriority(b.priority, '中')`（原 `b.priority || '中'` 不校验，补四档校验，非法回落「中」，与 chat 分支一致防脏值）。

## 影响面
- 端点：`/api/intake-chat`（新加权现场 priority 覆盖 AI）、`/api/intake-submit`（原已读 `b.priority`，补校验）。二者共用 `normPriority`。
- 数据：仅现有 `intakes.priority` 列，无新列。
- 前端：仅 field.html 提需求/报BUG 模式新增选择器；咨询模式、附图、每系统会话快照、reopen 等既有行为不回归（priority 与 deep 对称落每一处）。
- 显示：后台 inbox/detail 已按 priority 配色，现场选「紧急」→ detail 显红「紧急」，自动生效（未改这俩）。

## 冒烟（连真库 · prod `intake-app` + MySQL）
逻辑测试（本地 MySQL down）：抽 `normPriority` 沙箱测两建单分支表达式，14 断言全绿（现场选紧急覆盖 AI / 非法回落 AI 猜 / 空回落中 / trim「 紧急 」合法 / 注入串回落 / AI 也空→默认中）。
prod 真库端到端（`psp` 项目，自签 submit-link token 打容器内 `/api/intake-submit`，MySQL 直读核对，用后即删+重启清缓存）：
- ① 现场选「紧急」提 BUG → 落库 `priority="紧急"`
- ② 非法「超级紧急XYZ」→ 落库 `priority="中"`
- ③ 空 priority → 落库 `priority="中"`
造数已 `DELETE FROM intakes` + 删 `.md` + `docker restart intake-app`，`REMAINING_SMOKE_ROWS=[]`，探针脚本全删。

## 部署
scp `server.mjs` → prod `/opt/intake/server.mjs` + `docker restart intake-app`；scp `public/field.html` → prod `/opt/intake/public/field.html`（静态，不重启）。已部署并冒烟通过。

## 关联 spec diff（待人审核合并，未改 status）
见交付说明「spec diff」段：FS-04-AI对话提交.md 新增 AC-32（现场提交可手选紧急程度四档、覆盖 AI/默认、非法回落、后台配色显示）+ §4.1 `/api/intake-chat` 入参补 `priority?` + §6.3 校验补一条 + AC 计数 31→32。
