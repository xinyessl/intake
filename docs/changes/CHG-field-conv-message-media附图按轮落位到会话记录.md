# CHG · 对话记录 reopen 时附图按轮落位（per-message media 落到会话记录消息）

- 日期：2026-08-07
- 关联 spec：FS-04（AI 对话提交 / 对话记录）——**涉及 spec**（会话记录数据模型新增 per-message media + reopen 显图行为），已起草 diff 附交付，**待人评审后合并**。
- 分类：逻辑/行为调整（bug 暴露了 v2 确认清单改造漏了「附图落到会话记录消息」）→ 要改 spec；本 CHG 记实现落点。

## 现象（bug）
v2「建单前确认清单」改造后，用户在 `intake-chat` 某轮附的图，只在**点确认建单（commit-plan）时被复制到各工单**（`XQ-*/img-1.png`）；**会话记录（`type='intake-conv'`）的消息 `msg.media` 全是 null、记录级 `media` 也空**。所以重开该「对话记录」渲染对话流时，那张图**不在它所在的那条用户消息位置**（甚至根本不显）。
- 实测 `CONV-smsic2mk497ecfe`：chat 4 条 `media=null`、记录级 `media=[]`；而同会话 `XQ-20260807-01/02/03` 各有 `media`。

## 根因（两处）
1. **图没存到会话记录消息**：`/api/intake-chat`（v2）构 `convChat` 时 `allMsgs.map(x=>({role,text}))` 丢了本轮图；本轮 `imgs`（data URL）根本没存到会话级目录、没挂到会话记录消息 `msg.media`。图只在 commit-plan 建单时进了工单。
2. **`renderConvTimeline` 把消息图片直接丢了**：`public/field.html` 里 `appendBubble(..., false, [])`——第 4 参（imgs）硬传空数组，即便消息有 media 也不渲染。且 `reopenIntakeConv` 的 `msgs.map` 只保留 role/content/ts，未带 media。

> 卡时序逻辑（`mergeConvTimeline` 锚点法）本身是对的，**未改**。

## 改动
### server.mjs
- `reconcileChatTs(chatArr, prevChat)`（saveConvRecord 用）：新增每条消息 media 保留——本轮传入带 media 用之；对齐到 prev 同一条（下标+role）而本轮整段 chat 不重传老 media → 沿用 `prev.media`（历史轮图不丢）；无图 `delete rec.media`（记录干净、老数据兼容）。
- `/api/intake-chat`：本轮 `imgs`（≤6 data URL）存到**会话级目录** `media/<sessionId>/t<turnIndex>/img-N.png`（turnIndex=本轮 user 消息在 convChat 里下标，避免与工单 `media/<id>/` 目录撞），挂到会话记录**本轮（最后一条）user 消息**的 `msg.media`；仅 `imgs.length && sessionId` 时才存。
- `/api/intake-reply`：同步会话记录时保留每条 `m.media`（不再只 role/text/ts）。

### public/field.html
- `reopenIntakeConv`：`msgs.map` 保留 `media`（`media: Array.isArray(m.media)?m.media:null`）；filter 放行「有内容 或 有 media」的消息。
- `renderConvTimeline`：消息 `media` → `mediaUrls(proj0, x.data.media)` → 传给 `appendBubble` 第 4 参（不再 `[]`），让该轮用户气泡内显缩略图（点开原图）；`anyMsgMedia` 兜底：整段无消息级 media（老记录）→ 记录级 `item.media` 末尾 `appendMediaBubble`。

### tools/
- 新增 `tools/fs-04-conv-message-media.logic.test.mjs`（13 用例，全绿）：抽真实 `reconcileChatTs` 喂造数据（media 保留/沿用/清理）+ 对存图到会话级目录、saveConvRecord/intake-reply/renderConvTimeline 接线做静态断言 + consult/intake reopen per-message media 未回归（AC-33）。

## 保留 / 未破坏
- 卡时序 `mergeConvTimeline`、确认清单建单 `commit-plan`、已建单水位线 `filedUpTo`、软删、附图多模态看图（AC-30）、reopen 续聊、consult/intake reopen 的 per-message media（AC-33）——全未动。
- 建单时图仍复制进工单（commit-plan 现状保留，工单 detail 要显图）；图的"事实位置"是会话记录消息。

## 验证（连 prod · 真库）
- 逻辑测试：`node --test tools/fs-04-conv-message-media.logic.test.mjs`（13/13）+ `fs-04-reopen-order`（15/15）+ `fs-04-conversations`（含 intake-chat-sequential 共 56）+ `commit-plan-version` 全绿；`node --check server.mjs` OK。
- 连 prod 真库（`intake.lcpharmacy.cn`）：用 deployed server.mjs 的真实 `reconcileChatTs` + 存图范式写真实 `intake-store/hlyy`，插 MySQL、`docker restart` 刷 CACHE，用 admin session（cookie `intake_sess`）打真实端点：
  - `GET /api/intake-detail` → 200，`chat[0]`(user) `media=["media/<sid>/t0/img-1.png"]`、有独立 ts；`chat[1]`(assistant) `media=null`（正确）。
  - `GET /api/intake-media?project=hlyy&file=media/<sid>/t0/img-1.png` → 200 `image/png` 69 bytes（会话级图可取）。
  - 冒烟造数已硬删（DELETE intakes+sessions、rm 文件/media 目录、restart 刷缓存）。
- 说明：端到端真模型 `intake-chat` 冒烟本次受 prod 模型网关偶发「所有凭据均无法获取有效 Token」限流（直连上游同端点却 200），故用上述"真函数+真库+真端点"验存储/传输/取图全链路（模型返回文案不影响 media 落库/显图逻辑）。

## 已知限制
老会话记录（修复前建的、消息无 media）重开仍无图——数据里没有 per-message media、无法可靠还原到某条消息，历史数据限制；新会话起正常（消息级无 media 时记录级兜底、无图不崩）。
