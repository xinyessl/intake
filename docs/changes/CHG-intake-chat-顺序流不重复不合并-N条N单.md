# CHG · 对话进件建单：已建单水位线（filedUpTo）确定性防上下文污染 + N 条需求 = N 张单

- 日期：2026-08-06
- 关联 spec：FS-04（AI 对话提交）——起草 **AC-11/AC-12 补强 diff**（见本文末，**未合并**，待人审）
- 类型：逻辑/行为增强（改 AI 建单上下文边界 + 纪律 → 涉及 spec，起草 AC diff）
- 改动文件：
  - `public/field.html`（**主修·前端水位线**）：`chat` 加 `filedUpTo`（已建单覆盖到第几条 messages，初始 0）；`/api/intake-chat` 每次返回 `savedIds` 非空（本轮建了单）→ `chat.filedUpTo = chat.messages.length`（含本轮 user + 归档回复）；`sendIntake` body 带 `filedUpTo`；随草稿(`saveDraft`/`restoreDraft`)、系统会话快照(`snapshotConversation`/`restoreConversation`) save/restore（均夹 `[0, messages.length]`）；`newConversation` 归 0；`reopenIntakeConv` 已建单会话设 `messages.length`、未建单设 0。**新增**：同会话「先建 A 再隔轮建 B」（已 `savedId` 但本轮又出新单）→ `else if (tickets.length && chat.savedId)` 分支为 B 补「已建单」卡 + 初判 + 刷新左侧（原逻辑只在 `!savedId` 时补卡，会漏 B 的卡）。
  - `server.mjs`（**主修·后端切段** + 配合提示词）：
    - `/api/intake-chat`：收 `filedUpTo`（`parseInt`，夹 `[0, allMsgs.length]`，越界/不传/老前端=0）；把归一化后的 `allMsgs` 切 `archivedMsgs=slice(0,filedUpTo)`（已归档只读背景）+ `activeMsgs=slice(filedUpTo).slice(-24)`（当前待处理）；喂模型的 `msgs` = 有背景则把 `archivedMsgs` 折叠成**一条**「已建单归档·只读背景·禁止再建/合并」user 说明 + `activeMsgs`，否则 `activeMsgs`（=全量，同现状）。**只有 active 被当"待判断建单"的正文**。**落库仍用真实完整对话 `allMsgs`**（工单 `chat` + 会话记录 `convChat`），非折叠的 `msgs`（否则会丢历史 + 落入合成背景说明）。
    - `intakeChatSystem(...,hasArchivedBg)`：新增末参；提示词补两段——① **「N 条=N 个块·硬性」**（识别/确认/拆分出 N 条 → 必须各出一个块，少出=漏建单=错；"打包转开发"只是话术不改变一条一块一单；部分齐→已齐先出块）；② **「建单逐条独立·顺序流别重复别合并」**（出过块即闭环，后续默认独立新条）；`hasArchivedBg` 为真时再追加 **「已建单归档背景·只读·禁止再建/合并」**（只对「当前待处理」段判建单）。
  - `tools/fs-04-intake-chat-sequential.logic.test.mjs`（新增，18 用例）：提示词强约束 + 端点切段接线 + 复刻水位线切段（边界 0/越界/不传）+ 前端 filedUpTo 全链路接线断言。
  - `tools/fs-04-conversations.logic.test.mjs`：C6 断言 `reopenIntakeConv` 的 seg3 窗口 2200→2800（filedUpTo 注释行推后了 reopenConvProject 位置，非行为变更）。

## 背景 / 痛点（两个同处 bug）
现场端「提需求/报BUG」对话流，同一 `intake-chat` / `intakeChatSystem` 两个混淆 bug：

**Bug 1（顺序流：上下文污染，已建单被重复/合并）**：同一次聊天前一条需求已建单后，再提新需求，AI 把新需求跟已建单旧需求揉一起。
实测：「忽略比对」需求已建单，接着提「厂家字段自动赋值搜索」新需求 → AI 回复变成"加忽略按钮 + 同时做厂家字段"两条揉一起。
**根因**：AI 回复的 `intake-record` 块建单后被 `reply.replace(blockRe,'')` **剥掉**再回前端，前端 `chat.messages` 存的是剥块后的回复 → 下一轮把整段历史发回 AI 时，AI **看不到"某需求已归档建单"**，把已建单旧需求当"还在讨论"。

**Bug 2（识别 N 条却只建 1 张）**：AI 明确拆分出多条需求并确认，最后只出一个 `intake-record` 块 → 只建 1 张，漏建其余。
实测：AI 说「已拆分为两个独立需求登记：需求1…需求2…」，拍板后说「打包转开发排期」——只建了需求1一张单。
**根因**：AI 不可靠遵守「多条多个块」，用"打包/一起转开发/已登记"把多条揉成只出一个块。

## 解法
### 主方案（确定性）：已建单水位线 `filedUpTo` —— 代码切上下文，不靠 AI 自觉
- **前端**每次建单后把 `filedUpTo` 上移到当前 `messages.length`（已建单覆盖线）；发 `intake-chat` 带上。
- **后端**用代码把历史切两段：`archived`（水位线之前 = 已闭环只读背景，折叠成一条说明）+ `active`（水位线之后 = 当前待处理），**只对 active 判是否建新单**。archived 里的旧需求 AI 根本"看不到当前对话身份"、无从翻出或合并 → 顺序流污染被**确定性**切断（不再依赖提示词自觉）。
- 边界安全：`filedUpTo=0`（会话开头 / 老前端不传 / 越界夹回）→ active 为全量，行为**完全同现状、不回归**。

### 配合：提示词强约束「N 条=N 个块」+ 顺序流纪律 + 有背景时只读约束
即便水位线切了段，一轮内仍可能有多条 → 保留「N 条=N 个块·少出=漏建单=错·打包转开发只是话术」的硬约束（Bug 2）；再加「建单逐条独立」通用纪律 + 有 archived 背景时的「只对当前待处理判建单、禁止为背景再建/合并」约束（与水位线呼应）。

**未改**：`matchAll` 多块→多张单（AC-11/12）、剥块、per-ticket 紧急（AC-32）、`sessionId` 归组、会话记录 upsert（AC-36）、幂等锚点 `savedId`。落库用真实完整对话（不受水位线折叠影响）。

## 验证（连 prod · 真模型 · 真 MySQL · 前端模拟水位线 · 已清造数）
prod `intake.lcpharmacy.cn`（容器内打 `127.0.0.1:5180` 真端点，link token 驱动，模拟前端维护 messages+filedUpTo）：

**场景1（顺序流·水位线隔离）**：同一 sessionId：
- 轮1 提需求 A「忽略比对」→ 建 `XQ-20260806-05`（`药品比对页面增加"忽略比对"按钮`），前端 `filedUpTo→2`。
- 轮2 提需求 B「厂家字段自动匹配」（声明与前无关）→ 建独立 `XQ-20260806-06`（`药品比对厂家字段支持自动匹配与搜索选择`），`filedUpTo→4`；**B 轮 AI 完整回复只谈厂家字段、完全不提"忽略比对"**（mentionsA=false，确定性隔离生效）。
- 真库核对：本会话恰 **2 张单**（A=1、总=2），不混不漏。

**场景2（N 条=N 单）**：一轮同时说两条需求 → AI 一轮建 **2 张单** `XQ-20260806-07` + `XQ-20260806-08`（各一条），不揉成一张；真库确认=2。

两组造数均已硬删清理，重启容器刷 CACHE，prod 回基线（intakes 仅原有 requirement:1 + intake-conv:1，0 smoke 残留）。`git diff` 已扫，无密钥/prod 口令入提交物。

## spec diff（起草·未合并·待人审）—— FS-04 §AC-11 / §AC-12 各补一句

**AC-11 末尾补**（原「…**AI 提示词强化**：…绝不退化成…让用户手工搬运的 prose。」之后追加）：
> **已建单水位线 + N 条=N 单强约束（2026-08-06）**：
> ① **已建单水位线（`filedUpTo`，主修·确定性防上下文污染）**：前端每次建单后把 `filedUpTo` 上移到 `chat.messages.length` 并随 `intake-chat` 上送；服务端用代码把 `messages` 切「已归档只读背景（`slice(0,filedUpTo)`，折叠成一条禁再建/合并说明）+ 当前待处理（`slice(filedUpTo)`）」，**只对当前待处理段判断是否建新单**——已建单的旧需求落入只读背景，AI 无从翻出/合并（顺序流污染被确定性切断，不靠提示词自觉）。`filedUpTo` 越界/不传/=0 → 全量待处理，行为同现状不回归；落库存真实完整对话（不受折叠影响）。
> ② **N 条=N 个块（硬性）**：AI 一旦识别/确认/拆分出 N 条独立需求/BUG（哪怕说"拆成两条""打包转开发"），**必须**为每条各出一个 `intake-record` 块，N 条即 N 个块——**少出一个块=漏建单=错**；"打包转开发排期"只是话术、不改变"一条=一块=一张单"；部分齐则已齐的先出块建单、未齐的继续追问。

**AC-12 末尾补**（回归约束，原「…**单条需求仍恰建一张**（不回归）。」之后追加）：
> **顺序流 + 多条回归（2026-08-06）**：同一 `sessionId` 内先后提两条**互不相干**需求 → 各建**独立一张**单（不合并、不重复），第二条的 AI 回复不复述/不揉入第一条（由 `filedUpTo` 水位线确定性保证）；一轮内确认的 **N 条** → 恰建 **N 张**单（不因"打包/一起转开发"退化成一张）。前端 `filedUpTo` 随草稿/快照 save/restore、`newConversation` 归 0、reopen 已建单会话设满、未建单设 0。

（说明：主修是前后端「已建单水位线」代码边界（`server.mjs` `/api/intake-chat` 切段 + `field.html` chat 状态），配合提示词强约束；`matchAll`/剥块/落库路径未变。改的是建单上下文与纪律 → 补进 AC-11/12 而非新增 AC。）
