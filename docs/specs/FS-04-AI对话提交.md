---
id: FS-04
title: AI 对话提交（判类/补要素/归档 → 建工单/咨询）
module: 实施端
type: feature
source: docs/实施端PRD.md §4.3 + redesign.html（① 实施端 · f-right/f-ctx/f-toggle/f-chat-f）
prd: docs/实施端PRD.md §4.3（AI 对话提交）,§4.6（版本模型 · 归档上下文版本感知）,§8（AI 兜底/幂等/离线草稿）
contract: 复用 POST /api/intake-submit · POST /api/consult(SSE) · POST /api/intake-analyze · POST /api/intake-chat + 本 spec §4（逐个对齐入参/返回，需微调项标 🔧）
prototype: Desktop/Prototype/intake/redesign.html（① 实施端右侧对话：f-right/f-rtool、归档上下文 f-ctx + updateCtx 版本感知、提交类型切换 f-toggle、新对话 newc、对话流 f-msg、输入回车发送 f-chat-f）
priority: Must
status: accepted
owner_human: <验收人 · NEEDS-HUMAN>
depends_on: [FS-01]
---

> **【本条 = 实施端「AI 对话提交」功能规约（对齐 `docs/specs/00-实施端-spec清单.md` 之 FS-04）】**
> 现场账号在工作空间**右侧对话区**用自然语言描述诉求，AI 判类型（需求 / BUG / 咨询）+ 追问补齐要素（现象 / 复现 / 影响）+ 给出归档建议（产品 · 子系统 · 版本 · 客户医院）请现场确认，确认后**建工单**（需求 / BUG → 进运营端工单流）或**直接答复**（咨询 → AI 答疑，有价值沉淀经验库、不进批次）。落地 = `public/field.html` 右侧对话区（`f-right`）+ 复用 `server.mjs` 现有 AI/提交端点，**不新增库表、不改库列**（工单沿 `intakes` 表 + `data` JSON）。
>
> **三条跨条决策（贯穿本 spec）：**
> - **A｜Node 栈**：落地 = `public/field.html` 右侧对话区（原型 `f-right`）+ 复用 `server.mjs` 的 `/api/intake-submit`·`/api/intake-chat`·`/api/consult`·`/api/intake-analyze`，**不是** PRD §2/§9 写的 Vue3+TS+ElementPlus / Java（那是被跟踪产品的栈，非本平台）。样式复用 `public/assets/theme.css`；提交端点均已在 `FIELD_OK` 白名单（现场账号可调），无需改鉴权闸。
> - **B｜角色 impl**：提交人 `reporter` = 当前登录 impl 账号（`user.name||user.username`，服务端取，不信前端传 reporter）；归档目标医院 `site` 限当前账号 `sites`（医院视图取所选医院；越权医院不得提交，服务端收敛）。
> - **C｜批次 P2**：本条只**建单**（工单 `status/lifecycle='待处理'`）；工单进运营端工单流后由 TK-01 处理、BP-01 归批——**本条不涉批次** → 全 P1。

## 1. 用户故事 / 目标
作为**现场实施工程师 / 产品（role=impl）**，我要在右侧对话区**用一句大白话**把现场遇到的需求 / BUG / 咨询说清楚，让 AI **自动判类型、追问补齐要素、给归档建议并请我确认**，确认后一键**建工单**（进运营端工单流）或**得到咨询答复**（不进批次、可沉淀经验库），**不必手填一堆表单字段、不必自己判是需求还是 BUG**，以便现场"只管说清问题"，AI 负责"判类 + 补要素 + 归档"。同时归档上下文（产品 · 子系统 · 版本 · 医院）**版本感知**、随视图与所选医院/系统自动带出，避免归错版本。

## 2. 范围
**包含（本条 = 工作空间右侧对话提交区 `f-right`）：**
- **归档上下文 chip（`f-ctx` · 版本感知）**：工具条（`f-rtool`）最前一枚 chip，随视图与实体自动更新（`updateCtx`）：
  - **医院视图**：`🏥 <医院> · 现场版本：<产品> <ver> · …`（跟随所选医院，**只读**；数据源 = 该医院现场版本，见 §5.3）。
  - **系统视图**：`📦 <产品> · <子系统> · <版本▾>`（版本 = **运营维护 tag 版本下拉**，最新在前，选定后"提问/归档基于该版本"；数据源见 FS-03，本条只消费 chip 上下文去归档）。
- **提交类型切换（`f-toggle`）**：`咨询答疑`（默认 `.on`，居左）｜`提需求 / 报BUG`（居右）二选一；切换影响走的端点（咨询 → consult；提需求/报BUG → intake-chat/intake-submit + intake-analyze）。2026-07-23 用户裁决：默认选中「咨询答疑」，且「咨询答疑」与「提需求/报BUG」左右对调（咨询在左默认激活）。
- **对话流（`f-chat-b` / `f-msg`）**：AI/我 两方气泡消息流；输入框 `f-chat-f` **回车发送**（+ 发送按钮）。
- **对话四步（核心）**：① 现场自然语言输入 → ② AI 判类型（需求 / BUG / 咨询）+ 必要时**追问补齐** 现象 / 复现 / 影响 → ③ AI 给**归档建议**（产品 · 子系统 · 版本 · 客户医院）请现场确认 → ④ **确认建单**：需求 / BUG → `intake-submit`/`intake-chat`（`status='待处理'`，进运营端工单流）；咨询 → `consult`（AI 直接答复，不进批次，有价值可 `kb-from-consult` 沉淀经验库）。
- **新对话（`newc`）**：清空当前会话、开新单（不影响已提交的工单）。
- **AI 兜底（PRD §8）**：分类/归档建议 AI 不可用或超时 → 降级为"人工选择 产品 · 子系统 · 类型"，**不阻断提交**（走 `intake-submit` 人工带参路径）。
- **幂等/草稿（PRD §8）**：同一会话防重复建单（已建单的会话不重复建）；提交失败可重试；未发送/未建单内容本地草稿暂存（刷新不丢当前会话输入）。

**不包含：**
- 左侧提交清单（按批次/按类型、平铺医院 tab、子项目下拉）→ **FS-02**。
- 系统视图 tab / 跨医院聚合 / 运营 tag 版本模型来源（`/api/versions`）→ **FS-03**（本条只**消费** chip 上下文，不定义版本来源）。
- 登录门 / 工作空间隔离外壳 / 维度下拉（医院/系统视图）/ `scopedForField` 缺口修复 → **FS-01**。
- 更新包下载 / 一键改版本 / 待办 popover → **FS-05**（P2）。
- 免登录访客提交页（`submit.html` 干净页）→ **FS-06**（复用同一对话提交能力）。
- 经验库检索入口 → **FS-07**（本条只在咨询"解决了"时**沉淀**经验库，不做检索页）。
- **工单流转/决策/发包** → 运营端 TK-01/BP-01（本条建单后即交运营端，不做后续流转）。
- 新增/修改数据库表列 → **不涉及**（工单沿 `intakes` 表 + `data` JSON，见 §5）。

## 3. 验收标准（AC · Given-When-Then · 每条可自动化判定）
> 回归套件：`tools/fs-04.test.mjs`（A 组前端静态 DOM/交互断言锁原型元素 `f-right`/`f-ctx`/`f-toggle`/`f-chat-f`/`f-msg` + B 组连真库冒烟 `/api/intake-submit`·`/api/intake-chat`·`/api/consult`·`/api/intake-analyze`）。全部 P1。

### A. 对话区结构与工具条（对齐原型 f-right / f-rtool）
- **AC-1** Given 现场账号（role=impl）已登录并进入工作空间 When 渲染右侧 Then 存在对话区 `.f-right`，其内含工具条 `.f-rtool`（首枚归档上下文 chip `#fCtx.f-ctx` + 类型切换 `.f-toggle` + 新对话 `.newc`）+ 消息流容器 `.f-chat-b` + 输入区 `.f-chat-f`（一个文本输入框 + `.send` 发送按钮）。
- **AC-2** Given 工具条已渲染 Then `.f-toggle` 恰含两个按钮：「咨询答疑」（默认 `.on` 选中，居左）与「提需求 / 报BUG」（居右）；点击「提需求 / 报BUG」→ 它变 `.on`、「咨询答疑」取消 `.on`（提交模式切换为 intake），点回则恢复。默认提交模式为 consult。（2026-07-23 用户裁决：默认咨询答疑，两按钮左右对调）
- **AC-3** Given 输入框 `.f-chat-f input` Then 其 `placeholder` 为引导文案（如「说说想要的功能改进，或遇到的问题…回车发送」），聚焦可输入。

### B. 归档上下文 chip 版本感知（对齐原型 updateCtx）
- **AC-4** Given 处于**医院视图**、已选某医院（如「山东省立医院」）When 渲染/切换医院 Then chip `#fCtx` 文案为 `🏥 <医院> · 现场版本：<产品> <ver> · …`（该医院各已上产品与现场版本，来自 §5.3 现场版本源）；chip **只读**（不含版本下拉），切换医院时 chip 随之更新。
- **AC-5** Given 处于**系统视图**、已选某子系统（如「审方」）When 渲染 Then chip `#fCtx` 文案为 `📦 <产品> · <子系统> · <版本▾>`，版本部分是**可点下拉**（`.f-ver` / `.f-ver-menu`），选项 = 该产品运营维护 tag 版本（最新在前，首项标「最新」），当前选中项 `.on`。
- **AC-6** Given 系统视图版本下拉展开 When 选中某 tag 版本 Then chip 版本文案更新为该版本、下拉收起，后续"提问/归档"基于该版本（提交 `version` = 所选 tag 版本）。
- **AC-7** Given 系统视图选「全部系统」（无具体子系统）When 渲染 chip Then 显示聚合态占位（如 `全部系统 · 各系统按运营版本`），不强制单一版本（选定具体子系统后再定版本）。
- **AC-8** Given 归档上下文为「医院视图·所选医院」When 提交建单 Then 归档目标 `site` = **当前所选医院**（不是前端任意传入的医院；该医院必须 ∈ 当前账号 `sites`，见 AC-19）。

### C. 对话四步 —— 输入 / 判类 / 追问补要素（提需求·报BUG 模式，复用 intake-chat）
- **AC-9** Given「提需求 / 报BUG」模式、对话流 When 在输入框输入自然语言并**回车**（或点发送）Then 追加一条我方气泡（`.f-msg.me`），并以当前会话历史 `messages[]` 调 `POST /api/intake-chat`（`type='intake'` 合并模式让 AI 判需求/BUG；带 `project`/`version`/`site`/`subsystem` 归档上下文），AI 回复追加为 `.f-msg.ai` 气泡。
- **AC-10** Given AI 判为需求或 BUG 但要素不全 When AI 回复 Then 回复为**追问**（补齐 现象 / 复现 / 影响 等要素），会话继续、**尚未建单**（`savedId` 为空），现场可继续补充。
- **AC-11** Given 要素补齐、AI 在回复里给出 ```` ```intake-record``` ```` 结构块（含 `title` 等）When `/api/intake-chat` 返回 Then 服务端**自动建单**（`intakes` 表新增一条，`type` = AI 判定的 `requirement|bug`、`status/lifecycle='待处理'`），返回 `savedId`（首张，非空）；**一次回复可含多个** ```` ```intake-record``` ```` **块**（AI 判定为多条独立需求/BUG 时，一条问题一块）→ 服务端 `matchAll` **每块各建一张单**、返回 `savedIds:[{id,type,priority}]`（逐张），坏块（无法解析/无 `title`）跳过不建脏单。**AI 提示词强化**：`intakeChatSystem` 明确「你就是进件系统本身，够了直接输出归档块建单」，**绝不**退化成"已整理为 N 条可复制提交/复制到你们的需求管理系统"这类让用户手工搬运的 prose。**已建单水位线 + N 条=N 单强约束（2026-08-06 主修）**：前端每次建单后把 `filedUpTo` 上移到 `chat.messages.length` 并随 `intake-chat` 上送；服务端用代码把 `messages` 切「已归档只读背景（`slice(0,filedUpTo)`，折叠成一条禁再建/合并说明）+ 当前待处理（`slice(filedUpTo)`）」，**只对当前待处理段判断是否建新单**——已建单的旧需求落入只读背景，AI 无从翻出/合并（顺序流上下文污染被**代码确定性切断**，不靠提示词自觉）；`filedUpTo` 越界/不传/=0 → 全量待处理，行为同现状不回归；落库存真实完整对话（不受折叠影响）。提示词另强约束：当前段确认了 **N 条**独立需求就**各出一个块、N 条 N 块**，禁止用"打包/一起转开发"揉成一张。
- **AC-12** Given 服务端返回 `savedIds` When 前端处理 Then 据 `savedIds` 建**多张已建单卡**（各自 `id`/`type`/`priority`，配合 per-ticket 紧急程度 AC-32），`showAnalyze` 按 `chat.analyzedIds` per-id 去重（每张单各初判一次）；`chat.savedId`=首张作幂等锚点，同会话继续对话且 AI 未再产出**新** record 则**不重复建单**（幂等见 AC-22）。**单条需求仍恰建一张**（不回归）。**顺序流 + 多条回归（2026-08-06）**：同一 `sessionId` 内先后提两条**互不相干**需求 → 各建**独立一张**单（不合并、不重复），第二条的 AI 回复不复述/不揉入第一条（由 `filedUpTo` 水位线确定性保证）；一轮内确认的 **N 条** → 恰建 **N 张**单。前端 `filedUpTo` 随草稿/快照 save/restore、`newConversation` 归 0、reopen 已建单会话设满、未建单设 0。

### D. 归档建议确认 + 直接表单提交（intake-submit 兜底路径）
- **AC-13** Given AI 给出归档建议（产品 · 子系统 · 版本 · 客户医院）When 现场确认 Then 建单以该归档上下文落库（`project`=产品、`subsystem`=子系统、`version`=版本、`site`=医院），字段来自 chip 上下文 + 会话，不需现场手填全表单。
- **AC-14** Given AI 不可用/超时（`intake-chat` 返回降级文案或前端探测超时）When 现场选择「人工提交」Then 走 `POST /api/intake-submit`（现场手选 产品·子系统·类型 + 标题/描述），`type ∈ {requirement,bug}`，`status='待处理'` 建单成功，**不因 AI 失败阻断提交**（PRD §8 AI 兜底）。
- **AC-15** Given 类型为 BUG 且**未提供版本** When 调 `intake-submit`（BUG 版本必填）Then 返回 400「请填/选产品版本（BUG 必填）」，前端内联提示补版本；需求（requirement）无此强制。
- **AC-16** Given 建单成功（intake-submit）When 返回 Then 响应含 `{ok:true, id, reply}`（AI 首轮沟通话术），前端把 `reply` 作为 AI 首条气泡展示，工单进入 `待处理`（或 AI 配置就绪时 `沟通中`）。

### E. 咨询答疑（consult · SSE · 不进批次 · 可沉淀经验库）
- **AC-17** Given 切到「咨询答疑」模式 When 现场发问并回车 Then 以 `messages[]` 调 `POST /api/consult`（SSE 流式，带 `project`/`version`/`site`/`subsystem`），AI 答复**逐字流式**追加到 AI 气泡（`data: {v:片段}`），结束事件 `{done:true, convId, kbHits}`。
- **AC-18** Given 咨询会话产生答复 When `consult` 落库 Then 生成 `type='consult'` 记录（`lifecycle='已答复'`），**不进运营端工单收件箱**（`listIntake` 默认 `withConsult=false` 过滤掉）、**不进批次**；`convId` 返回供同会话续问（同 `convId` 续存，不新建）。
- **AC-19-KB** Given 咨询"解决了"（现场点「已解决/沉淀经验库」）When 触发 Then 调 `POST /api/kb-from-consult`（带 `project`/`convId`；兼容旧入参 `q`/`a`）沉淀为经验库条目（`from='consult'`），成功反馈；不解决则不沉淀。
  - **整段对话 AI 整理（非只抓最后一轮）**：带 `convId` 时后端取该 consult 记录**整段 `chat`**，用 AI 整理成一条条目——`q`=用户**核心问题**（抓真正要解决的那个，**不是最后一个追问**）、`a`=**最终解决方案**且**涵盖整段排查脉络**（核心问题→关键排查→最终定位与解法）；`subsystem` 取 `src.subsystem`。
  - **兜底**：未配模型 / AI 失败 / 解析失败 → `q`=chat 首条 user 文本（核心问题）、`a`=末条 assistant 文本（不再只取最后一轮）。
  - **数据权限**：现场账号只能沉淀自己 `sites` 内医院的咨询（`src.site ∈ user.sites`），管理员不限，越权→403。
  - **兼容**：`convId` 缺失时回落旧的 `q`/`a` 直存路径（向后兼容不破坏）。

### F. 新对话 / 数据权限 / 幂等 / 兜底（贯穿）
- **AC-20** Given 当前会话已有多轮对话（含已建单）When 点「新对话」`.newc` Then 清空对话流与输入、开新会话（新 `convId`/无 `savedId`），**不影响已提交的工单**，可重新走四步。
- **AC-21【数据权限】** Given 现场账号 A（`sites=["山东省立医院"]`）When 提交时前端传 `site="郑州人民医院"`（不在其 sites）Then 服务端以**当前账号可归档医院**收敛（提交医院必须 ∈ `sites`；越权医院→改用当前所选合法医院 / 或 400），**不得**把工单落到非负责医院（对齐 PRD §3.3/§7、决策 B）。🔧 见 §4 微调项。
- **AC-22【幂等】** Given 同一会话已建单（有 `savedId`/`convId`）When 因网络重试重复发送同一确认 Then 不产生第二张工单（intake-chat 仅在 AI 产出新 record 时建单；consult 同 `convId` 续存不新建）——防重复建单。
- **AC-23【草稿】** Given 现场输入了内容但未发送/未建单 When 刷新页面 Then 当前会话输入/未提交草稿从本地暂存恢复（不丢），已建工单不受影响（PRD §8 离线/弱网草稿本地暂存）。
- **AC-24【未登录】** Given 未登录 When 调 `/api/intake-submit`·`/api/intake-chat`·`/api/consult` Then 依 FS-01 登录门 / `authGate`（这三端点在 `FIELD_OK`，登录后现场可调；未登录访问工作空间被登录门遮罩），不越权。
- **AC-25【每系统各记一段会话 · 切系统跟随切换/恢复】**（2026-07-23 新增 · 用户裁决「切系统 → 恢复该系统的对话」）Given 实施端已登录、右侧 AI 对话区 When 用户在同一会话内**切换系统上下文**（医院视图切医院 `onHospSelect`/切子项目 `selectSub`、系统视图切系统 `onSystemTab`、或医院↔系统视图切换 `setMode`）Then 前端以**集中式** `syncConversationToSystem()`（幂等）在每个切换点末尾同步右侧对话——① 把**切走前**的当前会话打成快照存进旧「系统上下文」桶 `chat.bySystem[oldKey]`；② 若切入的系统桶**已有快照**→ `restoreConversation()` 恢复该段（清空对话流后逐条重渲染：user 转义、assistant 走 `md()`；恢复 `messages/convId/submitKind/savedId/analyzed/reopenProject/reopenSubsystem/输入框值`）；③ 若该系统**从未聊过**→ `newConversation()` 全新空会话。系统上下文键 `systemKey()`：系统视图 = `'sys||'+curSys`、医院视图 = `curSite+'||'+curSub`（尾部空串=「全部系统/全部子项目」桶，合法会话槽）。故：系统 A 聊几句→切系统 B（右侧显 B 之前聊到哪、B 未聊过则空）→切回 A（右侧恢复 A 的对话，含未发输入与续聊锁定）。
- **AC-26【会话内存态 · 刷新可丢 · 与草稿/reopen/必选守卫共存】**（2026-07-23 新增）Given AC-25 的各系统会话 When 页面**刷新** Then `chat.bySystem` 是**纯内存态**（**不**进 `sessionStorage`/`localStorage`，避免端存储膨胀与 FS-01 A5 长效存储禁令），刷新后仅**当前**系统那段由草稿（`saveDraft/restoreDraft`，sessionStorage）恢复，**其它系统的段丢失可接受**（已发咨询本就持久化，可点记录 reopen 恢复，见 FS-06 AC-C7）。共存约束：① 必选子系统守卫（`guardConsultSubsystem`，FS-06 AC-C8）不变——具体子系统桶发 consult 不被拦、「全部」桶发 consult 仍被拦；② reopen（FS-06 AC-C7）载入的 consult 属**当前**系统桶，下次切系统随快照一并保存、切回续聊仍指原 consult（快照带 `reopenProject/reopenSubsystem`）；③ `newConversation` 清当前桶那份会话、`doLogout` 清空 `bySystem`+`lastSystemKey`、登录后 `restoreDraft` 完置 `chat.lastSystemKey = systemKey()` 为基线键。

### G. 对话提交附截图 + AI 多模态看图（2026-07-24 用户裁决：MVP 附图 + AI 多模态看图）
- **AC-27【选图 / 粘贴 / 预览 / 上限】** Given 现场账号在右侧对话输入区 When 点图片入口 `#fImgBtn`（隐藏 `<input type="file" accept="image/*" multiple id="fImgInput">`）或在输入框 `#fChatInput` 直接**粘贴**截图（`paste` 事件从 `clipboardData` 取 `image/*` File）Then 选中/粘贴的图读成 data URL 加入待发送队列 `pendingImages`（**最多 6 张**，超出提示并只保留前几张），并在输入框上方 `#fImgPreview` 显**缩略图预览**（每张带删除 `×`）；单张过大先 `canvas` 缩到 ≤1600px 宽再 `toDataURL('image/jpeg',0.85)` 压缩（防炸 `MAX_BODY`=30MB 上限）。
- **AC-28【发送带图 + 用户气泡显图】** Given 待发送队列有截图 When 发送（`sendChat`）Then 本轮截图随请求体 `images:[dataURL...]`（≤6）发出——提需求/报BUG 走 `POST /api/intake-chat`、咨询走 `POST /api/consult`（**无图时不带 `images` 字段，纯文本调用向后兼容**）；**我方气泡内也显所附截图缩略图**（`appendBubble(...,imgs)` → `.f-bub-imgs`，点开看原图）；**发送后 `pendingImages` 即清空**。
- **AC-29【图片输入态 · 不进草稿/快照】** Given 待发送截图 When 页面刷新 / 切系统上下文 / 新对话 / reopen Then 截图是**纯输入态**：**不**进 `chat.bySystem` 会话快照、**不**进草稿端存储（`saveDraft`/`snapshotConversation` 均**不含** images），刷新即弃、切系统/新对话/reopen 时 `clearPendingImages()` 重置（避免大 base64 对象进 sessionStorage 膨胀 + FS-01 A5 长效存储禁令）。
- **AC-30【AI 多模态看图】** Given 本轮提交附了截图 When 服务端调模型（`intake-chat` 走 `callModel`、`consult` 走 `callModelStream`）Then 图片经 `withImages(messages, images, isAnthropic)` **并进最后一条 user 消息的 content**（多模态块）——anthropic 格式 `{type:'image',source:{type:'base64',media_type,data}}`、openai 兼容格式 `{type:'image_url',image_url:{url:<data URL>}}`（从 data URL 正则解析 `media_type`+base64）；**无图时 content 保持字符串**（`if(!imgs.length) return messages`，纯文本调用一字不变、向后兼容）；只并进末条 user、历史消息不改、≤6 张封顶、非法 data URL 过滤；系统提示在有图时追加一句「用户本轮可能附了截图，请结合图片理解问题」，`maxTokens` 不因图无脑加大（≤6 张、单张已压缩）。
- **AC-31【建单存图】** Given `intake-chat` 附图并 AI 产出 `intake-record` 建单 When 落库 Then 截图 data URL（≤6）落 `intake-store/<proj>/media/<id>/img-N.png`、记 `e.media=['media/<id>/img-N.png']`（存 `data` JSON 内、无新列），运营端 `detail.html` 按 `e.media` 展示「截图（N）」、`/api/intake-media`（防穿越）只读取回——此为**现有能力**（`intake-submit`/`intake-chat` 已实现），本条补齐前端 UI 让其可用。
- **AC-33【附图按轮落位 · per-message media】** Given 某轮带图提交 When 落库 Then 除记录级 `e.media` 外，把本轮图挂到该轮 `chat` 的**末条 user 消息**（`msg.media`）；`intake-chat`/`intake-reply` 挂当前单、`consult` 每轮重建 chat 时**从 `prev.chat` 按第 K 条 user 回贴历史轮 media** 再挂本轮末条（防历史轮图丢失）。And reopen（`reopenConsult`/`reopenIntake`）遍历消息**按轮在该气泡内显图**（随文字时间穿插）；**旧记录**（消息无 `media`、仅记录级 `e.media`）兜底贴末尾不丢图。`detail.html` 仍按 `e.media` 显图不变。

### H. 紧急程度（每张已建单卡片各设各的 · per-ticket · AC-32 重做 2026-08-06）
- **AC-32【每张已建单卡片各设紧急程度 · per-ticket】** Given 现场「提需求/报BUG」对话一次可建**多张单**（AI 每产出一个 `intake-record` 建一张）When 某张单建成 Then 该「已建单」卡片上带自己的「紧急程度」选择器（`.f-arch-pri` 四档 紧急/高/中/低，顺序/配色与 `inbox.html` 一致），**默认选中该单当前 `priority`**（=AI 按严重度/影响面判、`intakeChatSystem` 提示 record.priority∈四档、缺省中）；**顶部工具条无全局选择器**（删 `#fPriSel`/`chat.priority`——全局一个无法表达"一对话多单各不同"）。And 现场在某卡片选某档 → `POST /api/intake-set-priority {project,id,priority}`：仅 `requirement|bug` 可设（consult 恒空、拒），现场按 `user.sites` 收敛（`e.site∈sites`，管理员不限，越权 403），`normPriority(b.priority, e.priority||'中')`（合法即用、非法回落**原值**），`e.history.push(note:'调整紧急程度→X')` 留痕，`saveIntake` 落 `intakes.priority`（VARCHAR(10)，无新列）——**只改这一张、别张不动**。And `/api/intake-chat` 响应体带 `priority`（=建单最终档，供卡片默认选中）；`reopenIntake`/草稿·系统恢复重建卡片同样回显该单档（后者用 `/api/intake-detail` 懒加载）。And 后台 `inbox.html`/`detail.html` 按该 priority 四档配色，改「紧急」→ detail 显红「紧急」。（`intake-submit` 表单直提是单工单路径，`priority` 天然 per-ticket，保留 `normPriority(b.priority,'中')`。）

### I. 对话记录与工单拆开（左=工单 / 右上=对话记录 · sessionId 会话分组 · 2026-08-06）
- **AC-34【对话记录与工单分离 · 会话按 sessionId 归组】** Given 现场「提需求/报BUG」一次聊天可建**多张单** When 渲染现场端 Then **左侧「提交清单」只列需求/BUG 工单**（`renderTypeView` order=`['requirement','bug']`，去掉 consult 组）；**右上角（新对话旁）「对话记录」入口** → `GET /api/field/conversations`（现场按 `user.projects`+`sites` 收敛、与 submissions 同源）列**对话会话**：① 咨询每条一项（reopen 走 `reopenConsult`）；② 提需求/报BUG 按 `sessionId` 归组——`intake-chat` 建单存 `e.sessionId`（读 `b.sessionId`，同一次聊天多张单同值，随 data JSON、无库列；`newConversation` 生成新 id、随草稿/快照带、新对话重置），**一次聊天建的多张单 = 一条对话记录**（代表工单=组内最早提交·含整段 chat，显 `ticketCount/reqCount/bugCount` + 首条 user 概要），点开 `reopenConversation` 恢复整段对话 + 逐张补「已建单」卡续聊。And **旧单无 `sessionId`** → 每张自成一条对话记录（兜底不丢）。`/api/field/conversations` 在 `FIELD_OK`+`FS08_FIELD_API` 双白名单；`/api/field/submissions` API 桶集不变（左侧只列工单由前端过滤，不动 FS-02 契约）。

### J. AI 生成中可「停止」中断（2026-08-06）
- **AC-35【AI 生成中可点「停止」中断 · 区分主动停止与真错误】** Given 现场发送了一条（提需求/报BUG 或咨询），AI 处于「正在思考中…」或流式生成中 When 用户点发送位置的「停止」（`chat.sending` 时「发送」按钮切「停止」态：`ti-player-stop` + 文案「停止」+ `.stop` 红、**不置灰**、可点；分派 `stopSending()`）Then 前端 `chat.abortCtrl.abort()` 中断本轮——三条路径（`sendConsult` 原生 fetch SSE / `sendIntake` intake-chat / `sendIntakeReply` intake-reply）均带 `signal`（`api()` 经 `Object.assign` 透传 `opts.signal`）；consult 断连触发服务端 `res.on('close')` 中止上游模型。And 按「主动停止」收尾（`isAbort(e)`：`e.name==='AbortError'` 或 `signal.aborted`）：**consult 保留已生成部分**（尾部「（已停止）」、不追加沉淀经验库/转工单入口）；**intake-chat/reply 显「（已停止）」、清动效、不弹网络错误 toast、不走 `offerFallback`**（与真错误区分）。And 三路径统一复位 `chat.sending=false`、按钮切回「发送」、`chat.abortCtrl=null`，可重发。And 切「新对话」/切系统上下文若仍在发送中 → 先 `abort()` 旧请求。**不破坏** `sending` 防重、`setThinking`、附图、多单建单、消息不丢等既有逻辑。

### K. 对话全量持久化 + 会话记录 + 对话记录软删（2026-08-06）
- **AC-36【对话全量持久化 + 会话记录 + 软删】** Given 现场「提需求/报BUG」在对话区聊天 When 本轮**沟通过**（用户发了内容 + AI 回了内容）Then 服务端**不论是否建单**都 upsert 一条**会话记录**（`type='intake-conv'`，id=`CONV-<sessionId>` 确定性派生·同会话每轮命中同一条；随 `intakes` 表 + `data` JSON、**无新库列**；`sessionId` 空不存）——`intake-chat` 每轮存、`intake-reply` 同步刷新；**会话记录 ≠ 工单**：`listIntake` 排除 `intake-conv`（不进左侧提交清单/批次/统计/导出/待办），建单逻辑不变、不建重单，工单与会话记录靠 `sessionId` 关联。And `GET /api/field/conversations` 改列**会话记录**：咨询每条一项；提需求/报BUG 每个 `intake-conv` 一项（`fromConv:true`，**含未建单** `ticketCount:0`，按 sessionId 关联工单统计 `reqCount/bugCount/tickets`）；**旧数据兜底**（有工单无会话记录的历史 session → `fromConv:false` 按 sessionId 归组，不丢）；软删会话记录不复现（`deletedConvKeys` 让兜底跳过）；过滤 `deleted`、收敛不变、updatedAt 倒序。And **未建单会话记录可续聊**（`reopenIntakeConv` 从会话记录恢复整段 chat + 锁 `reopenConv*` 上下文，续聊走 intake-chat 同 sessionId，AI 够了再建单落该 session）；已建单会话续聊走 intake-reply、显多张已建单卡。And **对话记录每条支持软删**（复用 `POST /api/intake-delete`，置 `deleted=true`）：仅对真会话记录（consult / `fromConv` intake-conv）开放删除入口，**旧数据兜底项（代表工单）不给删**（工单到左侧提交清单删）；**删对话记录 ≠ 删其建的工单**。

> **AC 计数**：共 **36** 条（AC-1..36，其中 AC-19-KB 计为第 19 条）。AC-1..26 全 P1；AC-27..31（附图+多模态，2026-07-24）P1；AC-32（现场手选紧急程度，2026-08-06）P1；AC-33（附图按轮落位，2026-08-06）P1；AC-34（对话记录与工单分离，2026-08-06）P1；AC-35（发送中可中断「停止」，2026-08-06）P1；AC-36（对话全量持久化+软删，2026-08-06）P1。

## 4. 接口契约
> 统一前缀 `/api`；除 `consult`（SSE）外返回 `{...}` JSON。**本条 100% 复用现有端点，不新增端点**；提交人 `reporter`、归档医院 `site` 服务端按当前登录用户收敛（忽略越权传参）。契约锚点见 `docs/specs/00-实施端-spec清单.md §4` 对照表。

### 4.1 ♻️ 复用（已存在）—— 逐个对齐入参/返回
| 方法 | 路径 | 用途 | 关键入参 | 返回 | 收敛/白名单 |
|---|---|---|---|---|---|
| POST | `/api/intake-chat` | **对话式建单（核心）**：AI 边聊边补，够了输出 `intake-record` → 自动建单 | `project`（产品 id）、`type`（`intake`=合并让 AI 判 / `requirement` / `bug`）、`version`、`site`、`subsystem`、`messages:[{role,content}]`、`images?` | `{ok:true, reply, savedId}`（`savedId` 非空=已建单）；AI 未配 → `{ok:true, reply:'（未配模型…）'}` | 在 `FIELD_OK`；`site`/`version`/`subsystem` 取自入参（🔧 见 4.3） |
| POST | `/api/intake-submit` | **表单直提（兜底/人工路径）**：建需求/BUG 工单 + AI 首轮沟通 | `project`、`type`（→ `bug` 或 `requirement`）、`version`（BUG 必填）、`site`、`subsystem`、`title`、`desc`、`errorInfo`、`steps`、`expectResult`、`bg`、`reqDesc`、`accept`、`priority`、`images?` | `{ok:true, id, no, reply, configured, status}`；BUG 缺版本 → 400 | 在 `FIELD_OK`；`reporter` 服务端取登录用户（L884）；`site` 缺省取 link（🔧 见 4.3） |
| POST | `/api/consult` | **咨询答疑（SSE 流式）**：spec + 经验库检索直接答、不进批次 | `project`、`version`、`site`、`subsystem`、`messages:[{role,content}]`、`convId?`、`deep?` | SSE：`data:{v:片段}` … `data:{done:true, convId, kbHits, stopped}`；落 `type='consult'`（`lifecycle='已答复'`） | 在 `FIELD_OK`；`reporter` 服务端取登录用户（L963） |
| POST | `/api/intake-analyze` | **版本感知初判**（对**已建工单**做 AI 分类/结论/建议） | `project`、`id`（**已存在的工单 id**） | `{ok:true, analysis:{category:'非bug\|bug\|该版本已修\|需求', verdict, suggestion:'reply\|file', detail}, lifecycle}`；工单转「分析中」 | ⚠️ **需已建单**（先 `intake-submit`/`intake-chat` 拿到 id 再 analyze）；未在 `FIELD_OK`（当前仅管理员/后台调用，见 §4.4 NEEDS-HUMAN） |
| POST | `/api/kb-from-consult` | 咨询"解决了"→沉淀经验库（带 `convId` 时取整段 chat 经 AI 整理成核心问题 Q + 全脉络 A；`subsystem` 取 src） | `project`、`convId`（兼容旧 `q`/`a`） | `{ok:true}`；条目 `from='consult'`。convId 无效/非 consult→400；越权 site→403 | 在 `FIELD_OK`；按 `user.sites` 收敛 |
| GET | `/api/me` | 当前用户 + role + `sites`（归档医院边界数据源） | — | `{me:{role, name, sites, projects, …}}` | 公开自身 |
| GET | `/api/versions?project=` | 运营维护 tag 版本（系统视图 chip 版本下拉源） | `project` | `{versions:[…], syncedAt}`（最新在前） | 在 `FIELD_OK` |
| GET | `/api/customers` | 客户/医院台账（含现场版本 `products:[{project,version}]`，医院视图 chip 源） | — | `{customers:[{name, products:[{project,version}], …}]}` | 在 `FIELD_OK` |

### 4.2 分类/建单流程与端点映射（对齐 PRD §4.3 四步 → 真实端点）
| PRD §4.3 步骤 | 真实落地 |
|---|---|
| ① 自然语言输入（回车发送） | 前端把输入追加进 `messages[]`，调 `intake-chat`（提需求/BUG 模式）或 `consult`（咨询模式） |
| ② AI 判类型 + 追问补要素 | `intake-chat` 的 `type='intake'` 合并模式：`intakeChatSystem` 提示 AI 判需求/BUG、缺要素则追问（回复无 `intake-record` 块）；`savedId` 空即"还在补要素" |
| ③ AI 给归档建议（产品·子系统·版本·医院）请确认 | 归档上下文来自 chip（`project/subsystem/version/site`）随 `messages` 一并传；AI 在 `intake-record` 块给 `subsystem/module/title/desc/…`；现场"确认"= 让 AI 输出 record 或点人工提交 |
| ④ 确认 → 建单 / 咨询 | 需求/BUG：`intake-chat` 输出 record 自动建单（`savedId`）或 `intake-submit` 手动建单；咨询：`consult`（不进批次），可 `kb-from-consult` 沉淀 |

> **说明**：PRD §4.3 写的 `POST /api/ai/classify`（AI 判类型/补要素/归档建议）**真实不存在**——真实落地由 `intake-chat`（`type='intake'` 合并模式，AI 内部判类 + 补要素 + 输出 record 归档）承担；`/api/intake-analyze` 是对**已建工单**的版本感知初判（返回 `{category/verdict/suggestion/detail}`），**入参需要 `id`（已建单）**，非从原始文本预分类。前端"边聊边判类"靠 `intake-chat` 一条链完成，`intake-analyze` 属**建单后**的增强分析（可选）。

### 4.3 🔧 需微调/确认项（对齐 决策 B 数据权限）
- 🔧 **`site` 归档医院服务端收敛**：现 `intake-submit`（L879/884）/`intake-chat`（L910）的 `site` 取自**前端入参**（登录用户无 `site` 缺省来源，仅 link 有）。为落 AC-21/决策 B，需在**登录现场账号**路径校验：`site` 必须 ∈ `user.sites`（越权→取当前所选合法医院或 400），**不信前端任意 site**。→ FS-01 或本条实现时补该收敛（小改，`server.mjs`）。
- 🔧 **`reporter` 已服务端取登录用户**（L884/L963/L922），无需改；确认前端不覆盖。
- 🔧 **`intake-analyze` 放开给现场（已裁决 2026-07-22：放开）**：把 `intake-analyze` 加进 `FIELD_OK` + 按 `sites` 收敛（现场只能 analyze 自己 sites 内医院的工单，越权工单→403），使现场建单后即时展示 AI 初判。**本条实现**（`server.mjs` 小改）。

### 4.4 已裁决（2026-07-22 · 人工拍板，无需再确认 diff）
- **NH-1｜AI 分类 → 后端统一调模型**：`intake-chat`/`consult`/`intake-analyze` 均由后端持有 `modelCfg.apiKey`（复用已建 MC-01 模型配置），**前端绝不接触 Key**（PRD §11.2 Key 安全）。不做前端直连。
- **NH-2｜咨询 → 只续问、不做转需求**：`consult` 支持同 `convId` 多轮续问；**本条不做**「咨询转需求（consult→建 requirement）」（无端点，暂缓）。现场要提需求走正常 AI 对话建单路径。
- **NH-3｜`intake-analyze` → 放开给现场**：把 `intake-analyze` **加进 `FIELD_OK`** 并**按 `sites` 收敛**（现场只能 analyze 自己 sites 内医院的工单，越权工单→403）；现场经 AI 对话建单后**即时展示** AI 版本感知初判（category/verdict/suggestion/detail）。管理员天然放行。

## 5. 数据契约
> **对照真实库结构逐字段核对（禁止臆造列名）**。真实库 = `db.mjs init()` 5 表；客户/现场版本为**文件存**（`data/customers.json`）；运营 tag 版本来自 git tag（`/api/versions`）。**本条不新增表/列**。

### 5.1 工单 → `intakes` 表（`db.mjs` L33-41，核过列）
需求/BUG/咨询提交均落 `intakes`（复合主键 `project_id+id`）：
| 用途 | 真实列 | 类型 | 本条写入 |
|---|---|---|---|
| 记录归属产品 | `project_id` | VARCHAR(40) | = 归档产品（chip 的产品；`intake-submit` 的 `project`） |
| 记录 id | `id` | VARCHAR(40) | `intakeGenId(proj,type)` 生成（如 `XQ-*`/`BUG-*`/`consult` 前缀） |
| 类型 | `type` | VARCHAR(20) | **真实值小写** `requirement`/`bug`/`consult`（提需求/报BUG → 前二；咨询 → `consult`） |
| 版本 | `version` | VARCHAR(60) | 归档版本（医院视图=现场版本 / 系统视图=所选 tag 版本；BUG 必填） |
| **医院** | `site` | VARCHAR(80) | 归档医院（= chip 所选医院，须 ∈ `sites`，见 §6.1）；**无独立 customerId 列** |
| **子系统** | `subsystem` | VARCHAR(80) | 归档子系统（chip 的子系统 / AI record 的 subsystem） |
| 模块 | `module` | VARCHAR(120) | AI record 的 module（可空） |
| 标题 | `title` | VARCHAR(300) | AI record 的 title / 表单 title |
| 状态 | `lifecycle` | VARCHAR(20) | 建单固定 `待处理`（咨询 = `已答复`）；旧 `status` 列由 `lifecycleToStatus` 派生 |
| 提交人 | `reporter` | VARCHAR(80) | **服务端取登录用户** `user.name||user.username`（决策 B，不信前端） |
| 提交时间 | `submitted_at` | VARCHAR(20) | 建单时间戳 |
| 更新时间 | `updated_at` | DATETIME | 派生 |
| 嵌套业务数据 | `data` | JSON | **整份内存对象**（见 §5.2），新增业务字段一律进此列、**不加库列**（lessons L-001） |

### 5.2 `data` JSON 内挂载（无新增列 · lessons L-001）
`upsertIntake` 用 `J(e)` 序列化整个内存对象入 `data`，`P(r.data)` 整份读回。本条相关字段全在 `data`（**不建库列**）：
| 字段 | 说明 |
|---|---|
| `desc` | 现场描述/需求正文 |
| `errorInfo` | BUG 错误信息 |
| `steps` | 复现步骤 |
| `expectResult` | 期望结果 |
| `reqDesc` | 需求描述 |
| `accept` | 验收标准 |
| `bg` | 背景 |
| `chat:[{role,text,ts}]` | 对话消息流（intake-chat/submit/consult 会话历史，落 `data.chat`） |
| `history:[{from,to,by,byRole,at,note}]` | 流转留痕（建单首条 = `{to:'待处理', note:'提交'/'对话提交'}`；咨询 = `已答复`） |
| `analysis` | `intake-analyze` 写入 `{category,verdict,suggestion,detail,at,model}`（建单后增强，可空） |
| `media:[路径]` | 图片附件（base64 → `intake-store/<proj>/media/<id>/*.png`，≤6 张） |

### 5.3 归档上下文数据源（版本感知 · 只读消费，见 FS-03）
| chip 部分 | 真实来源 | 说明 |
|---|---|---|
| 医院视图 · 医院 | 当前账号 `accounts.sites`（`db.mjs` L23-27，JSON）→ 所选医院 | 医院 tab 由 FS-01/FS-02 提供，本条取"当前所选医院"作 `site` |
| 医院视图 · 现场版本 | `data/customers.json` 的 `customers[].products:[{project,version}]`（文件存，只读，`GET /api/customers`） | 该医院各已上产品的现场版本；chip 只读展示，不在本条回写（回写在 FS-05） |
| 系统视图 · 产品·子系统 | `projects` 表 + `subsystems` JSON（无独立子系统表）；`SUB_PRODUCT` 子系统→产品映射 | 见 FS-03；本条消费 |
| 系统视图 · tag 版本▾ | `GET /api/versions?project=`（git tag，最新在前） | 运营维护 tag 版本；选定→提交 `version` |

### 5.4 咨询记录（`type='consult'`，`consult` 端点落库）
`consult` 落 `intakes` 一条：`type='consult'`、`lifecycle='已答复'`、`chat` = 会话（含 AI 答复）、`title` = 首个用户问题前 60 字。**默认被 `listIntake`（`withConsult=false`）过滤**，不进运营端工单收件箱、不进批次（PRD §4.3：咨询不进批次）。经验库沉淀 → `kb-from-consult` 写 `kb_entries`（`from='consult'`，见 lessons 经验库条：`source='consult', from_ref='consult'`）。（2026-08-06：带 convId 时取该 consult 整段 `chat` 经 AI 整理为「核心问题 Q + 全脉络 A」，避免只抓最后一轮丢核心问题；无模型/失败按首条 user + 末条 assistant 兜底；按 user.sites 收敛。）

## 6. 业务规则 / 非功能

### 6.1 数据权限（硬约束 · 决策 B）
- **提交人**：`reporter` = 当前登录 impl 账号，**服务端取**（`user.name||user.username`，L884/L922/L963），前端不得覆盖。
- **归档医院**：`site` 必须 ∈ 当前账号 `accounts.sites`；医院视图取当前所选医院；系统视图跨医院场景下若需指定医院，同样须 ∈ sites。🔧 现端点未对登录用户校验 `site ∈ sites`（仅 link 有预置 site）→ 本条/FS-01 需补收敛（AC-21）。
- **判管理员/现场**用 `isAdmin(u)` 取反（含遗留 `dev`，见 lessons isAdmin 条）——现场 impl/pm 走收敛。
- 三提交端点已在 `FIELD_OK` 白名单（现场登录可调）；`intake-analyze` **本条加入 FIELD_OK** + 按 `sites` 收敛（已裁决 NH-3 放开，现场只能 analyze 自己 sites 内工单，越权→403）。

### 6.2 类型/状态映射（对齐真实值）
- **提交类型 → `type`**：提需求 → `requirement`；报BUG → `bug`；咨询答疑 → `consult`（真实值**小写**，见 lessons「列表标签颜色不生效」条；映射错会静默变灰）。合并模式 `intake-chat` 用 `type='intake'` 让 AI 判，最终落 `requirement|bug`。
- **建单 `lifecycle`**：需求/BUG 建单固定 `待处理`（`intake-submit` AI 配置就绪时旧 `status` 可转 `沟通中`，但 `lifecycle` 仍 `待处理`）；咨询 = `已答复`。状态机白名单/邻接表在 `server.mjs`（`LIFECYCLE`/`TRANSITIONS`/`lifecycleToStatus`，见 lessons L-002），本条只**建单入口**、不做流转。

### 6.3 校验（前后端双层，对齐真实库列长度 · 全局规范⑬）
- **BUG 必填版本**：`intake-submit` 服务端已强制（缺版本 400），前端 chip 无版本时（如系统视图未选 tag 版本）报 BUG 前须内联提示补版本（AC-15）。
- **字段长度对齐真实列**：`title ≤300`、`site ≤80`、`subsystem ≤80`、`version ≤60`、`module ≤120`、`reporter ≤80`（`db.mjs` 列定义）；前端 `maxlength` + 提交前校验，后端服务端兜底截断/校验，避免超长入库。`data` JSON 内文本（desc/steps 等）按合理上限（如 ≤4000）截断（`intake-chat` 已 `slice(0,4000)`）。
- **必填**：需求/BUG 需 `title`（AI record 无 `title` 不建单，L920）；咨询需非空 `messages`。
- **紧急程度四档校验（前后端 · AC-32 · per-ticket）**：档位 `priority ∈ {紧急,高,中,低}`（默认「中」），后端统一经 `normPriority(v,fallback)`（`server.mjs` 模块级）：trim 后合法→原值，非法/空→fallback。**建单**（`intake-chat`）= `normPriority(rec.priority,'中')`（AI 按条判、**不再全局覆盖**）；**现场逐条改档**走 `POST /api/intake-set-priority` = `normPriority(b.priority, 原值)`（合法即用、非法回落**原值**），仅 `requirement|bug`、按 sites 收敛、history 留痕。`intake-submit`（表单直提·单工单）= `normPriority(b.priority,'中')`。防绕过前端直调的脏值入库（`intakes.priority` VARCHAR(10)，四档最长 2 字符）。咨询记录 `priority=''`。

### 6.4 幂等 / 并发 / 兜底（PRD §8）
- **防重复建单**：`intake-chat` **仅在 AI 产出 `intake-record` 块且有 title 时建单**（L919-920），同会话 AI 不再产出 record 则不重复建（AC-12/22）；前端记录 `savedId`，已建单会话再确认不重复调建单。
- **咨询续存**：`consult` 同 `convId` 且 `type==='consult'` → 续存同一条（L960-962），不新建（AC-18/22）。
- **AI 兜底**：`intake-chat`/`consult` AI 连不上返回降级文案（不抛 500），前端据此降级为「人工选择 产品·子系统·类型 + 走 `intake-submit`」，不阻断提交（AC-14）。
- **草稿**：未发送/未建单内容本地 `sessionStorage` 暂存，刷新恢复（AC-23）；已建工单落库不受影响。
  > 🔧 **实现修正（2026-07-22）**：原写 `localStorage`，但 FS-01 A5 静态守卫 `doesNotMatch(field.html, /localStorage/)`（禁现场端持久化登录态/密码）会误伤——故改用 `sessionStorage`（当前标签会话内存活、刷新即恢复，满足 AC-23「刷新不丢当前会话」；不跨标签/不长效，安全边界更收敛）。切登录用户时按 `me.username` 校验丢弃旧草稿防串号。
- **时间格式**：对话/气泡展示时间统一 `yyyy-MM-dd HH:mm`（全局规范⑫），空值占位 `—`。

### 6.5 留痕（依「数据权限/留痕规则来源」）
- 建单首条 `history` = `{from:'', to:'待处理', by:reporter, byRole:user.role, at, note:'提交'/'对话提交'}`（L885/L924）；咨询记录 `chat` 全量留存。**留痕落 `data` JSON**，无独立留痕表（决策 B）。

## 7. 测试要点（交付给开发 agent）
> 套件：`tools/fs-04.test.mjs`。本项目有真实库（护栏要求）→ B 组至少一条连真库冒烟，不得只 mock。

- **单元 / 前端静态（A 组）**：
  - `public/field.html` 存在 `.f-right`（`.f-rtool` 内 `#fCtx.f-ctx` + `.f-toggle` 两按钮 + `.newc`）+ `.f-chat-b` + `.f-chat-f`（input + `.send`）（AC-1/2/3）。
  - 归档上下文 `updateCtx` 版本感知：医院视图 chip 为 `🏥 …现场版本…`（只读、无下拉），系统视图 chip 有 `.f-ver`/`.f-ver-menu` 版本下拉、首项标「最新」（AC-4/5/6/7）。
  - 类型切换 `.f-toggle` 默认「咨询答疑」`.on`（居左，走 consult）；切「提需求/报BUG」改走 intake（AC-2）。
  - 回车发送：`input` keydown Enter → 追加 `.f-msg.me` + 调对应端点（AC-9/17）。
  - 新对话 `.newc` 清空会话（AC-20）；草稿本地暂存恢复（AC-23）。
  - 时间 `yyyy-MM-dd HH:mm`、字段 `maxlength` 对齐列长（AC-15/6.3）。
  - **静态断言避坑（lessons L-005）**：写「不依赖某 token」断言时源文件注释别留该 token 字面量；抽屉/弹窗若自写别依赖部署 `shell.js` 没有的 `UI.openDrawer`（lessons L-004）。
- **接口（B 组 · 连真库冒烟）**：
  - `POST /api/intake-chat`（真实现场账号会话，`type='intake'` + `project=hlyy` + `messages`）→ 断言 `{ok:true}` 且（AI 配置时）产出 record 建单后 `savedId` 非空、`SELECT type,lifecycle,site,reporter FROM intakes WHERE id=savedId` 为 `requirement|bug` / `待处理` / `reporter`=登录用户；AI 未配时 `savedId` 空、返回降级文案不 500（AC-9/11/14）。
  - `POST /api/intake-submit`（`type=bug` 缺 version）→ 400「请填/选产品版本」（AC-15）；带 version → `{ok:true,id}`，`SELECT` 断言 `type=bug`/`lifecycle=待处理`/`reporter`=登录用户/`site` ∈ 账号 sites（AC-16/21）。
  - `POST /api/consult`（SSE）→ 收到 `data:{v:…}` 流 + `data:{done:true,convId}`；`SELECT type,lifecycle FROM intakes WHERE id=convId` = `consult`/`已答复`；`GET /api/intake-list?project=hlyy`（默认 withConsult=false）**不含**该 consult（AC-17/18）。
  - `POST /api/kb-from-consult`（`project`/`q`/`a`）→ `{ok:true}`，`kb_entries` 新增 `from_ref='consult'` 一条（AC-19-KB）。
  - **越权收敛**（AC-21）：现场账号 A 提交 `site=<不在 sites 的医院>` → 落库 `site` 不为该越权医院（收敛为合法医院 / 或 400）。🔧 依 §4.3 收敛实现。
  - **未登录**（AC-24）：无会话调 `intake-chat` → 依 authGate（工作空间被登录门遮罩；端点在 FIELD_OK 需登录态），断言非匿名放行。
  - **冒烟兜底**（lessons `project-delete`/兜底删条）：真源 `hlyy` 工单基线 19 条，冒烟造的 intakes/consult **after 钩子必删**（`DELETE FROM intakes WHERE id=? / project_id=?`）+ 清 `kb_entries` 造数 + `rm -rf data/intake-store/<proj>/media/<id>`，核对 `SELECT COUNT(*) FROM intakes` 回到基线，不污染真库。
- **E2E（前端，对照 redesign.html 基线）**：登录 → 右侧对话区 → 医院视图 chip 只读现场版本 / 系统视图 chip 选 tag 版本 → 提需求/报BUG 发一句 → AI 追问补要素 → 归档确认建单（左侧清单可见）→ 切咨询答疑发问 → 流式答复 → 沉淀经验库 → 新对话清空。对照 `f-right`/`f-ctx`/`f-toggle`/`f-chat-f`/`f-msg` 结构。

## 8. DoD（完成定义）
- [x] AC-1..24（共 24 条）自动化测试全通过。（`tools/fs-04.test.mjs` A 前端静态 14 条 + B 连真库 10 条 = 24 用例全绿；AI 模型未配走降级/兜底路径）
- [x] 复用端点契约校验通过：`intake-chat`（对话建单 + savedId 幂等）、`intake-submit`（BUG 版本必填 + reporter 服务端取）、`consult`（SSE + 不进批次 + 续存）、`kb-from-consult`（沉淀）、归档上下文数据源（`/api/versions`·`/api/customers`·`/api/me`）。
- [x] 连真库冒烟通过：真实现场账号会话建单，`SELECT` 断言 `type/lifecycle/site/reporter` 来自真实 `intakes`（非 mock）；consult 落 `type=consult`/`已答复` 且不进收件箱；越权 `site` 被收敛。
- [x] 界面对齐基线 `redesign.html`（`f-right`/`f-ctx`/`f-toggle`/`f-chat-f`/`f-msg` + `updateCtx` 版本感知）+ 时间 `yyyy-MM-dd HH:mm` + 回车发送 + 字段长度校验（§6.3）。
- [x] 数据权限验收：`reporter` 服务端取登录用户、`site` ∈ 账号 sites（越权不落非负责医院）、三端点 FIELD_OK 登录可调、`intake-analyze` **现场可调但按 sites 收敛**（自己工单 200 / 越权 403，NH-3 已放开）、留痕 `history` 落 `data`。
- [x] NH-1~3 已于 2026-07-22 裁决（§4.4：后端统一调模型 / 不做转需求 / intake-analyze 放开现场按 sites 收敛）；§4.3 🔧 `site` 服务端收敛本条实现。
- [ ] 人类验收通过。
