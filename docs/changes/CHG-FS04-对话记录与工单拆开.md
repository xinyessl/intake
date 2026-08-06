# CHG · 现场端：对话记录与工单拆开（左=工单 / 右上=对话记录）

**日期**：2026-08-06
**类型**：功能/行为调整 · 涉及 spec（FS-04 新增 AC-34）

## 背景
用户反馈：现场端左侧「提交清单」把**工单(需求/BUG)**和**对话记录**混在一起，而「一个聊天可以一直提交多张工单」，混在一处分不清。确认设计：**左侧=工单(需求/BUG)，右上角(新对话旁)=对话记录(含咨询)**，并用**会话 id 把一次聊天建的多张单归成一条对话记录**。

## 改动
### server.mjs
- **`/api/intake-chat` 建单存 `sessionId`**：读 `b.sessionId`（≤40），存到每张工单（随 data JSON，**不加库列**）；同一次聊天建的多张单同值。旧单无此字段。
- **新端点 `GET /api/field/conversations`**（现场按 `user.projects`+`sites` 收敛，与 submissions 同源）：右上「对话记录」数据源——① 咨询每条一项（`kind:'consult'`）；② 提需求/报BUG 按 `sessionId` 归组（无 sessionId 的旧单每张自成一组·兜底不丢），代表工单=组内最早提交（含整段 chat），返回 `ticketCount/reqCount/bugCount/tickets[]/title(首条user概要)`。按 updatedAt 倒序。进 `FIELD_OK`+`FS08_FIELD_API` 双白名单。
- `/api/field/submissions` API 桶集**不变**（仍返回 consult 桶，保持 FS-02 契约/测试不动）；「左侧只列工单」由前端过滤实现。

### public/field.html
- `renderTypeView` 左侧 `order=['requirement','bug']`（去掉 consult 组）。
- `newConversation` 生成 `chat.sessionId`（`newSessionId`），发 intake-chat 带上、随草稿/快照 save/restore、新对话重置。
- 右上（新对话旁）加「对话记录」入口 → `openConvRec` 抽屉 → `loadConversations`/`mkConvItem` 列会话；`reopenConversation`：consult→reopenConsult、intake 会话→用代表工单 reopenIntake 恢复整段对话（多单会话逐张补「已建单」卡）。
- 附带修 `fs-04-set-priority.logic.test.mjs` 一条 stale 断言（多单直建 36b6ac2 后 appendArchiveCard 由 `b.savedId` 单卡改遍历 `savedIds` 的 `t.id`，原断言失配）。

## 验证
- 逻辑测试：`fs-04-conversations.logic.test.mjs` + `fs-04-set-priority.logic.test.mjs` 共 32 pass / 0 fail（2 skip=DB门）。
- prod：已部署（server 重启 + field 静态）；`/api/health` 200；真现场会话拉 `/api/field/conversations` 200 返 6 项（intake 会话显单数/需/BUG + 咨询，正确分离）。未登录 401、现场域白名单正确。
- 旧单无 sessionId → 每张自成一条对话记录（兜底不丢）；新聊天多单归一条。

## 备注
本功能由 dev agent 实现，agent 因 Claude Code 进程退出中途中断（写 CHG/报告前）；编排器核对代码完整性（端点/存储/过滤/前端导出）+ 测试 + prod 冒烟 + 补 CHG/spec/提交。
