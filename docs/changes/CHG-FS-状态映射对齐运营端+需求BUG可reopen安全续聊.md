# CHG-FS · 实施端状态映射对齐运营端 + 需求/BUG 记录可 reopen 续聊（杜绝重单）

- **日期**：2026-07-24
- **spec**：FS-02（医院视图提交清单 §6.2 状态映射）、FS-06（记录点击 reopen · AC-C7/AC-C7c）
- **来源**：用户 2026-07-24 反馈两个问题：A 实施端状态显示错、B 需求/BUG 记录点击不回显对话。
- **类型**：
  - **A = bug 修复（暴露 spec 错）**：状态映射代码 + spec §6.2 均错 → 属"涉及 spec"，改代码 + 更 FS-02 §6.2 表（spec diff 随验收拍板）。
  - **B = 行为变更**：需求/BUG 记录新增可点 reopen + 安全续聊 → 属"涉及 spec"，改代码 + 新增 FS-06 AC-C7c、修订 AC-C7（spec diff 随验收拍板）。

## A. 状态映射错（`server.mjs` `FIELD_STATUS_MAP`）
现状 bug：`分析中→开发中（已受理）`、`已立项→开发中（已受理）`。但「分析中」= AI 刚初判、运营还没受理；「已立项」= 受理立项、还没真开发。实施端却都显「开发中」，与运营端不一致。

**改（三条映射，用户已认可措辞）**：
- `'分析中'` → `{ label:'待评审', tag:'tag-warning' }`（还没受理、待运营决策；与运营端「分析中计入待评审」一致）。
- `'已立项'` → `{ label:'已受理·排期', tag:'tag-primary' }`（受理立项、待开发；与运营端「已落实·排期」一致）。
- `'开发中'` → 保持 `{ label:'开发中', tag:'tag-primary' }` 不变。
- 其余键不动；`fieldStatusLabel` 兜底（`FIELD_STATUS_MAP[lc] || {label: lc||'待评审', tag:'tag-gray'}`）不变。旧标签「开发中（已受理）」彻底废弃。

## B. 需求/BUG 记录点击 reopen 回显 + 安全续聊（不建重单）
现状：仅 `consult` 记录绑点击 `reopenConsult`，`requirement`/`bug` 点了没反应。

**改（`public/field.html`）**：
1. **统一可点判定 + 分派**：新增 `isReopenable(it)`（`consult`/`requirement`/`bug` 且带 `project`+`id`）+ `bindReopen(el,it)`（`cursor:pointer` + 按类型分派：`consult`→`reopenConsult`；`req/bug`→`reopenIntake`）。`mkItem`（医院视图）与 `mkSysItem`（系统视图）两处均改用 `isReopenable`+`bindReopen`——两处共用一函数，杜绝再漏一处（延续 2026-07-23 问题②教训）。
2. **`reopenIntake(it)`**：`GET /api/intake-detail?project=&id=` → 恢复 `chat.messages`（工单 `chat[]`→气泡，dev 角色并入 assistant 侧）、`setSubmitKind('intake')`、`chat.savedId=item.id`（标记已建单）、`chat.reopenIntakeProject=item.project`（锁定工单 project）、清 consult 续聊锁、逐条渲染气泡 + `appendArchiveCard` 显「已建单 <id>（<类型>）」。
3. **安全续聊（★ 杜绝重单）**：`sendChat` 检测 `submitKind==='intake' && chat.savedId && chat.reopenIntakeProject` → 走新增 `sendIntakeReply(text)`（`POST /api/intake-reply {project,id,message}`，**append 到同一张工单** + AI 继续答），**绝不走 `sendIntake`/`intake-chat`**。
   - **`intake-reply` 核查结论**：端点入参 `{project,id,message}`；行为 = 给指定工单 `e.chat.push({role:'user',text:msg})` + AI 回复 `e.chat.push({role:'assistant',...})`，**从不 `intakeGenId` 新建工单**。故选「走 intake-reply」方案（非退化只读），既能续聊又天然不建重单。对比 `intake-chat`：服务端无幂等，AI 再输出 record 块即 `saveIntake(新 id)` → **会建重单**，正是要避免的路径。
4. **五处随锁字段同步**（延续 L-045/L-046 铁律）：`chat.reopenIntakeProject` 加进 `chat` 声明 / `reopenIntake` 设 / `newConversation` 清 / `snapshotConversation`+`restoreConversation`（per-system 会话跟随）/ `saveDraft`+`restoreDraft`（刷新不丢）。切系统/刷新后 reopen 的工单仍锁 project、续聊仍走 intake-reply。
5. **与既有共存**：不破坏 consult reopen（`reopenConsult` 不设 `reopenIntakeProject`）；图片输入态 `clearPendingImages()`；per-system 会话/必选守卫/深入思考均不受影响。

## 改动文件
- `server.mjs`：`FIELD_STATUS_MAP` 三条映射（A）。
- `public/field.html`：`isReopenable`/`bindReopen`/`reopenIntake`/`sendIntakeReply` + `sendChat` 分派 + `chat.reopenIntakeProject` 五处同步 + `mkItem`/`mkSysItem` 改用统一绑定 + `window.__field` 导出 `reopenIntake`（B）。
- `tools/fs-02.test.mjs`：新增 A-STATUS 静态断言 + B1 连真库补断言（已立项→已受理·排期、开发中→开发中）。
- `tools/fs-06.test.mjs`：B-RO3 改为分派断言、新增 B-RO3i（reopenIntake）/B-RO3s（安全续聊静态）/B-RO3b 扩展 + B-RI1 连真库（建 BUG→reopen→intake-reply→工单数不变、同单 chat 追加）。
- `tools/fs-03.test.mjs`：A9 更新为 `isReopenable`+`bindReopen` 分派断言（含 req/bug）。
- `docs/specs/FS-02-…md` §6.2 表 + `docs/specs/FS-06-…md` AC-C7 修订 + 新增 AC-C7c（spec diff，随验收拍板）。

## 未碰（按要求）
`ui.js` / `customers.html` / `inbox.html` / 其他页；per-system 会话/必选守卫/子项目下拉/subsystemLabel/按批次降级/深入思考/思考动效/归档条/currentArchive/minScore/图片多模态/renderSysChip/renderVerDetailRows 等已改逻辑一律未动。

## 验证
- `node --check server.mjs` 过；field.html：`localStorage` 0、隐形字符 0、无 `new Function` 新增、FS-01 A6 禁词 0。
- 回归全绿：`node --test --test-concurrency=1 tools/fs-02.test.mjs tools/fs-03.test.mjs tools/fs-06.test.mjs tools/fs-04.test.mjs tools/fs-01.test.mjs tools/tk-01.test.mjs` → 191 pass / 0 fail。
- 连真库无残留：fs06* 产品/工单/kb 清零，hlyy 基线未污染。
