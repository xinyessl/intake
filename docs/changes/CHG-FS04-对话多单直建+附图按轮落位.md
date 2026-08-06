# CHG · 现场端「提需求/报BUG」对话流两处修复：多条需求应直接建多张单 + 附图按轮就位

- **日期**：2026-08-06
- **来源**：用户实测反馈——（A）现场用对话一次提两条需求，AI 最后把两条整理成 markdown 文字「已整理为两条标准进件单…可直接复制提交」而**没真正建单**（用户期望：对话直接把单子提交进系统）。（B）重开某条记录时，附的图片没按时间插到它所属那轮消息，全**堆在文字末尾**、和文字时间乱序。
- **spec**：**涉及 spec**（A 属行为——AC-11/12 由"单块单单"→"多块多单"；B 属实现细节 + 一条回归 AC），已随本次交付**起草 spec diff**（见下），走 `/accept` 验收门人工拍板，**本 CHG 不代替 spec 合并**。

## 类型
- Part A：逻辑/行为调整（一次对话多条需求 → 多个 `intake-record` 块 → 多张单 → 多张已建单卡）。**要改 spec**（AC-11/12）。
- Part B：per-message media（附图挂到其所属那轮消息、reopen 随轮渲染）。行为对用户可见 → 顺带补一条回归 AC。

## 现象 / 根因
### Part A
1. 提示词（`intakeChatSystem`）让 AI「够了就输出 ```intake-record``` 块、服务端据此自动建单」，但**多条需求**时 AI 退化成 prose「可复制提交」，不输出结构块 → 不建单。
2. `/api/intake-chat` 服务端**只解析第一个** block：`const m = /```intake-record\s*([\s\S]*?)```/.exec(reply)`——即便 AI 输出多个块也只建一张。
3. 前端 `field.html` `sendIntake` 成功回调只认单个 `savedId` 建一张卡。

### Part B
文字消息在 `chat[]` 里按 ts 排好了，但**图片是记录级** `e.media=[...]`、每条消息 `m.media` 为空；reopen 时 `appendMediaBubble(project, item.media)` 把**所有图一股脑贴在全部文字之后** → 图片跑到末尾、和文字乱序。

## 改法
### 后端 `server.mjs`
- **提示词 `intakeChatSystem` 强化**：明确「你就是进件系统本身，够了就**直接输出归档块建单**，绝不写成"已整理为N条可复制提交""复制到你们的需求管理系统"这类给用户手工搬运的文字」；新增「一条问题一个块 · 多条就输出多个块」（有几条齐了就在末尾接连附几个 `intake-record` 块，各建一张单；没问清的那几条继续追问、已齐的照常出块）。
- **`/api/intake-chat` 多块解析**：`exec`（只取第一个）→ `matchAll`（全局正则 `blockRe`）循环。**每块各建一张单**：无法 JSON 解析/无 title 的块跳过（不建脏单），其余照建；返回体新增 `savedIds:[{id,type,priority}]`（逐张），并保留 `savedId`/`priority`（=首张单，老前端兼容）。建单逻辑（`normPriority(rec.priority,'中')`、media、history、幂等）每张单各走一遍，未破坏单块原行为。剔除正文归档块用 `replace(blockRe,'')`（全部块）。
- **Part B · per-message media（intake-chat）**：本轮附图存到「该单」media 目录（多张单各存一份，保持每张单自包含便于单独清理），路径记 `e.media`（detail.html 兼容）+ **挂到该单 `chat` 末条 user 消息**（`msg.media`）。
- **Part B · per-message media（consult）**：consult 每轮用整段 `msgs` 重建 `chat`（会丢历史轮消息级 media）——先把上一版 `prev.chat` 里 user 消息带的 media 按「第 K 条 user」顺序回贴，再把本轮新增图挂「最后一条 user」；前端 `msgs` 只有 `{role,content}` 无 media，故必须从 `prev.chat` 补齐历史轮，避免 reopen 旧轮图丢失。
- **Part B · per-message media（intake-reply）**：续聊某轮带图 → 存到该单 media 目录（从已有 media 数累加、封顶 6）、记录级 `e.media` 累加，并把本轮图挂本条 user 消息（`userMsg.media`）。入参新增 `images?`（无图不带，向后兼容）。

### 前端 `public/field.html`
- **Part A · 多卡渲染**：`sendIntake` 成功回调改为遍历 `savedIds` 建**多张已建单卡**（每张带自己的 id/type/priority，配合 per-ticket 紧急程度 AC-32）；老结构只回 `savedId` → 归一成单元素数组兼容。幂等锚点 `chat.savedId`=首张单（同会话续聊不再建新单/新卡）。
- **`showAnalyze` per-id 去重**：原 `chat.analyzed` 单布尔会挡住第 2 张起的初判 → 改 `chat.analyzedIds{}` per-id 去重（每张单各初判一次、不重复），保留 `chat.analyzed` 整体标记供快照/恢复。
- **`sendIntakeReply(text, imgs)`**：续聊带图透传给 `/api/intake-reply` 的 `images`（无图不带）。
- **Part B · reopen 按轮渲染**：`reopenConsult`/`reopenIntake` 遍历消息时，若该条 `m.media` 有值就用 `appendBubble(who, content, false, mediaUrls(proj,m.media))` 在该气泡内显图（随该轮就位、和文字按时间穿插）；**旧记录兜底**：整段消息都无 media（老记录只有记录级 `e.media`）→ 仍走 `appendMediaBubble` 把图贴末尾，别让老记录图丢失（`anyMsgMedia` 标记择一）。`chat.messages` 发后端时只带 `{role,content}`（媒体不回传，per-message media 由后端 chat 存储持有）。

## 验证
- **连真库冒烟（prod · intake-mysql，30/30 过）**：容器内 spawn 第二实例连同一 prod 库，隔离产品 + impl 账号真登录打真端点，mysql2 直读断言：
  - Part A：喂"两条需求已问清"会话 → AI **建了 2 张单**（`XQ-*` requirement + `BUG-*` bug），各独立入库（type/lifecycle=待处理/site 收敛/reporter=登录用户/priority∈四档）；AI reply **不含**"复制提交/整理为N条"prose、归档块已剔除；**单条需求会话 → 恰 1 张单**（不回归）。
  - Part B：consult 带图 → 记录级 media 有图 **且本轮 user 消息带 per-message media**、type=consult/已答复、不进收件箱列表；intake-reply 带图 → 记录级 media + 本轮 user 消息 per-message media。
  - 清理：隔离产品 intakes/projects/accounts/sessions/kb + media 目录全删净，0 残留，真库 hlyy 未污染（前后同数）。
- **本地脱库逻辑测试（17/17 过）**：多块解析（多块→多单 / 单块兼容 / 坏块跳过 / 无块 0 单 / 空标题跳过 / 正文剔除）、intake-chat per-message media 挂末条 user、consult 历史轮 media 回贴 + 本轮挂末条。
- **语法/解析**：`node --check server.mjs` 过；`field.html` 内联 JS `new Function` 解析过。
- **部署**：`server.mjs` scp `/opt/intake/server.mjs` + `docker restart intake-app`（logs 正常、`/api/health`=200）；`field.html` scp `/opt/intake/public/field.html`（不重启）。prod 临时备份已在验证后删除；smoke 脚本仅在本地 scratchpad，未入库。

## 风险
- 低。Part A 后端为「exec→matchAll 循环」，单块路径与原逻辑等价（首块首建、返回 savedId/priority 不变），多块是新增能力；坏块跳过防脏单。前端多卡为遍历渲染、幂等锚点不变。
- Part B 为加法字段 `msg.media`：新记录挂消息级、旧记录消息无该字段 → reopen 兜底走原记录级末尾显图，**不破坏旧记录**；detail.html 仍读记录级 `e.media` 不变（本次未动 detail.html）。
- consult 历史轮 media 回贴按「第 K 条 user」顺序对齐——依赖 msgs 与 prev.chat 的 user 顺序一致（同一会话续聊必然一致）；本轮新 user 无 prev 项 → 由本轮 roundMedia 挂上，正确。
- media 目录多张单各存一份（≤6 张小图）——轻微冗余，换来每张单自包含、便于单独删除，权衡取自包含。
- 未碰：工单流转/删除/批次、detail.html、inbox.html、kb-from-consult、鉴权白名单（intake-reply 已在 FIELD_OK/FS08_FIELD_API）。
