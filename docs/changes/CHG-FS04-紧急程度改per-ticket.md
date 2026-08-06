# CHG · 现场端紧急程度：顶部全局一个 → 每张「已建单」卡片各设各的（per-ticket）

- **日期**：2026-08-06
- **来源**：用户实测反馈——「一个对话可能同时提交多个问题和需求，每个问题/需求的紧急程度不一样」。上一版（commit e71a091）在顶部工具条放一个全局「紧急程度」选择器、提交时用这**一个值**覆盖 AI 对**所有**工单的判断，是错的（一次 `intake-chat` 对话会建多张单）。
- **spec**：**涉及 spec**（改 FS-04 AC-32，行为调整）→ 已随本次交付**起草 spec diff**（见下「spec diff（待评审·未合并）」），走 `/accept` 验收门人工拍板，**本 CHG 不代替 spec 合并**。

## 类型
逻辑/行为调整（紧急程度 全局 → per-ticket）。**要改 spec**（AC-32），diff 附交付，未 commit、未合并。

## 现象 / 根因
- 上一版全局选择器 `.f-pri`/`#fPriSel` + `chat.priority`，提交 `/api/intake-chat` 带全局 `b.priority`，后端建单 `priority: normPriority(b.priority, rec.priority||'中')` → 全局值盖掉 AI 对每条 record 的判定。
- 但 `intake-chat` 一次对话 AI 每产出一个 ```intake-record``` 就建一张单（不同问题→不同单），各条紧急程度本应不同——全局一个值无法表达。

## 改法
### 前端 `public/field.html`
- **删净全局选择器**：`.f-pri`/`#fPri`/`#fPriSel` DOM + CSS；`chat.priority` 状态；`syncPriority`/`setPriority`；`snapshotConversation`/`restoreConversation`/`saveDraft`/`restoreDraft`/`newConversation`/`reopenIntake`/`sendIntake` 里所有 priority 相关；`window.__field` 的 `syncPriority`/`setPriority` 导出。（`grep -n priority public/field.html` 仅剩注释）
- **每张「已建单」卡片各带选择器**：`appendArchiveCard` 建卡时挂 `buildTicketPriPicker(project,id,defPri)`——`.f-arch-pri` 四档选择器（紧急/高/中/低，配色对齐后台 `inbox.html` priHtml：紧急=danger/高=warning/中=primary/低=gray），默认选中该单当前档：
  - 新建单：`sendIntake` 收到 `/api/intake-chat` 响应，把 `b.priority`（AI 判的）传进卡片；
  - reopen：`reopenIntake` 传 `item.priority`（详情已含）；
  - 草稿/系统恢复重建卡片（只带 id）：传 `project` → 卡片用 `/api/intake-detail` 懒加载补该单当前档回填。
  - change → `POST /api/intake-set-priority {project,id,priority}`（`setTicketPriority`），成功 toast「已设为X」+ 卡片 `data-pri` 上色更新；失败 toast + 回滚。每张卡独立、绑各自工单 id。

### 后端 `server.mjs`
- **`/api/intake-chat` 建单去掉全局覆盖**：`priority: normPriority(rec.priority, '中')`（按 AI 每条判定规范到四档，非法→中）。**响应体加 `priority`**：`{ok:true, reply, savedId, priority}`。
- **AI 提示词补 priority 评估**（`intakeChatSystem` record 说明）：`priority 必填，按严重度/影响面判定，取值仅限【紧急/高/中/低】：紧急=线上阻断/资损/大面积无法用；高=核心流程受阻；中=一般(默认)；低=轻微/优化`。record JSON 结构未改（本就有 `priority` 字段）。
- **新端点 `POST /api/intake-set-priority`** `{project,id,priority}`：`loadIntake` 取单；不存在/已删→404；**仅 requirement/bug 可设**（consult 恒空→400）；现场账号按 `user.sites` 收敛（`e.site ∈ user.sites`，管理员不限，越权→403，同 `intake-verify` 范式）；`normPriority(b.priority, e.priority||'中')`（显式选择合法即用、非法回落原值）；有变更才 `history.push({...,note:'调整紧急程度→X'})` 留痕（同值幂等不刷）；`saveIntake`；返回 `{ok:true, priority}`。
- **白名单**：`/api/intake-set-priority` 同步进 `FIELD_OK` + `FS08_FIELD_API`（两处，否则 field 域被 originGate deny，见 fs-08 教训）。
- **保留正确的**：模块级 `normPriority`；`/api/intake-submit` 的 `normPriority(b.priority,'中')`（表单直提天生单工单、一个 priority 即 per-ticket）。

## 验证
- **连真库冒烟（prod · intake-mysql，14/14 过）**：经 `db.mjs` 真身造两张单（各 priority）→ 复刻 set-priority handler 改一张 → 从真库读回：单A 中→紧急、**单B 仍高（per-ticket 只动一张）**；`intakes.priority` 列 + `data.priority` + history 全同步；非法档回落原值、库列不污染；越权 site→403 不落库；consult→400 拒；冷 `loadAll` 复证。造数（隔离产品 id）已删净、0 残留。对过真实 DDL `intakes.priority VARCHAR(10)`（`db.mjs` L37/L102 `c(e.priority,10)`），四档 ≤2 字符安全。
- **端点接线 HTTP 探活（live server）**：未登录调 `/api/intake-set-priority` → 401 `need-login`（证明已接线 + 在白名单被放行到 authGate、非 404/越域 deny）。
- **逻辑测试（本地脱库，16/16 过）**：`tools/fs-04-set-priority.logic.test.mjs`——normPriority 真身、静态断言（全局删净/白名单两处/响应带 priority/AI 提示词/卡片选择器）、复刻 handler 验 per-ticket（只动一张单/越权/非法回落/consult 拒/管理员放行）。D 组连真库随 MySQL 起停 skip。
- **部署**：`server.mjs` scp `/opt/intake/server.mjs` + `docker restart intake-app`（`node --check` 过、logs 正常）；`field.html` scp `/opt/intake/public/field.html`（不重启）。prod 备份 `/root/{server.mjs,field.html}.bak.ac32`。

## 风险
- 低。前端为纯 UI/交互重排（全局 → per-ticket），后端新增端点隔离、复用 `intake-verify` 的 site 收敛 + `normPriority` + `saveIntake` 既有范式，未动库结构（复用 `intakes.priority`）。
- 未碰：`intake-submit`（单工单路径保留原 normPriority）、工单流转/删除/批次等其它逻辑；后台 `inbox.html`/`detail.html` 配色读同一 priority，天然生效。
- 草稿/系统恢复重建卡片走 `/api/intake-detail` 懒加载补档——多一次读请求、失败静默兜默认档，不影响主流程。
