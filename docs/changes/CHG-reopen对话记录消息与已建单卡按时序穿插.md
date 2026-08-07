# CHG · 对话记录 reopen「消息 + 已建单卡按真实时序穿插」（修顺序乱 bug）

- 日期：2026-08-07
- 关联 spec：FS-04 AC-36（会话记录 reopen）、AC-33（reopen 随时间穿插的既有原则）
- 类型：bug 修复（暴露 spec 漏边界 → 同步补一条回归 AC，见下「spec diff」）
- 改动文件：`server.mjs`、`public/field.html`、`tools/fs-04-conversations.logic.test.mjs`（更 1 断言）、`tools/fs-04-reopen-order.logic.test.mjs`（新增逻辑测试）

## 现象
重开一条「提需求/报BUG」对话记录（`reopenIntakeConv`），消息与「已建单」卡顺序乱：
1. **已建单卡一股脑贴末尾**：卡是对话中途（用户在确认卡点建单时）建的，却全堆在所有文本消息之后，与文本时序错位。
2. **消息 ts 全相同**：一条 CONV 记录 4 条消息 ts 全 `1786070534640`（实测 prod `CONV-smsic2mk497ecfe`），根本无法按 ts 排/穿插。

## 根因
1. **server `/api/intake-chat`（约 L2363）**：每轮把**整段** chat `allMsgs.map(x => ({..., ts: Date.now()}))` 盖同一个 `Date.now()` → 同一会话所有消息 ts 相同（每轮 upsert 覆盖成最后一轮时刻）。
2. **前端 `reopenIntakeConv`（`public/field.html`）**：先 `msgs.forEach(appendBubble)` 渲染**所有**文本消息，**再** `built.forEach(appendArchiveCard)` 把**所有**卡贴末尾。

## 解法
1. **server 保留每条消息各自 ts**：新增纯函数 `reconcileChatTs(chatArr, prevChat)`——本轮整段 chat 按下标与 `prev.chat` 对齐，**老消息（下标+role 一致）沿用已有 ts、新消息按单调递增补**（锚在上一条已知 ts 之后；容错 text 因 media 回贴略变、容错 prev 里 ts 意外乱序仍单调不减）。`saveConvRecord` 落库前跑它（`chat: timed`）——两个调用点（intake-chat / intake-reply）都受益，无需前端改传 ts。intake-chat 侧不再逐条 `ts:Date.now()`（交给 saveConvRecord 对齐）。
2. **前端合并时序渲染**：新增 `tsToMs`（`yyyy-MM-dd HH:mm`/ISO/毫秒 → 毫秒）+ `mergeConvTimeline(msgs, built)`（锚点法：消息保持原序，每张卡锚到「最后一条时间 ≤ 该单建单时间的消息」之后，**同分钟按分钟粒度比**避免卡因秒被丢而排到消息前；不可解析/无更早消息 → 贴末尾）+ `renderConvTimeline`（依合并序列 append）。`reopenIntakeConv` 改调 `renderConvTimeline(msgs, built, it, item)`，不再先渲染全部消息再堆全部卡。
   - 老数据兜底：消息 ts 全相同/缺失 → 消息保持原序、卡贴其后（实在比不了不崩、不错插）。

## 连真库冒烟（prod · intake.lcpharmacy.cn）
- 造多轮+中途建单会话（link 身份调 `/api/intake-chat` 三轮 + 中途 `/api/intake-commit-plan` 建 `BUG-20260807-01`）。
- **修后新会话 CONV chat 6 条消息 ts 各不相同**（跨三轮：`...964251/252`、`...014183/184`、`...076905/906`），对比老记录 4 条全 `1786070534640`。
- 工单 `submittedAt=2026-08-07 11:23` 落在 round2(11:23) 与 round3(11:24) 之间 → `mergeConvTimeline` 把该卡插到 round2 之后（不再贴末尾）。
- 冒烟造数已连库 + 清 intake-store 文件删净，`docker restart intake-app` 刷 CACHE，prod 回原 4 条记录。

## 未改动/已知边界
- `reopenConversation` 的**旧数据兜底分支**（`fromConv=false`：无 CONV 记录、从代表工单恢复 + extra 卡末尾）未改——极冷门历史路径，代表工单 chat 未必有可靠逐条 ts，改它需重取全部工单 detail，超出本 bug 范围。
- `restoreDraft`（页面刷新草稿恢复）仅重建单张代表卡（本就是 in-progress 轻量视图恢复），非多卡场景，不涉时序 bug。
