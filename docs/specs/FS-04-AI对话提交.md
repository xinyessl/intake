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
status: in-dev
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
- **答复可读性**：AI 默认面向实施/产品，正文按「先说结论 → 现场可执行步骤 → 仍未解决时需补充的信息」组织；技术依据默认后置。AI 回复中的标准 Markdown 管道表格渲染为可横向滚动的真实表格，不显示原始 `|` 分隔文本。
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
- **AC-11【AI 出「建单计划」而非自动建单 · 2026-08-07 v2 治本】** Given 要素补齐 When AI 回复 Then AI 在回复末尾输出**一个** ```` ```intake-plan``` ````（严格 JSON，用户不可见），`items` 数组、**每条独立需求/BUG 一个 item**（`{action:'new'|'append', ticketId?, type, subsystem, title, priority, summary}`，绝不合并多条）；`/api/intake-chat` 用 `parseIntakePlan` 解析、**不再建任何单**（老 `intake-record` 自动建单/`matchAll` 路径**废弃**，`savedId/savedIds` 恒空），只回 `plan.items`（服务端补 project/site/version/subsystem 兜底）+ 剔块后的可见正文。**续聊**：`intake-chat` 收前端上送的 `builtTickets`（本会话已建单 id+title）→ 注入提示词让 AI 判每条是 `append`（对某已建单的补充/追问）还是 `new`（新需求，默认倾向 new），**杜绝把新需求闷头追加进旧单**（治好原痛点：reopen/续聊走 `intake-reply` 无脑追加）。信息不齐 → 不出计划块、继续追问。
- **AC-12【确认卡 + 用户拍板 + 确定性建单】** Given 服务端返回 `plan.items` When 前端处理 Then 在对话流渲染**可编辑确认卡** `.f-plan`（`renderPlanCard`）：逐条显 action(`新建`/`补充到工单…`下拉选本会话已建单)、类型、标题(可改)、可**删除**、可**拆成两条**、底部「+ 再加一条」；**未点确认前不建任何单**（可继续对话，AI 重出计划）。When 点「确认建单」→ `POST /api/intake-commit-plan {project, sessionId, site, version, subsystem, items}` Then 按清单**确定性执行**：`action:'new'` 每条建一张工单（复用建单落库范式：type/title/subsystem/priority/sessionId/site/version/reporter/history/analysis，per-ticket 紧急 AC-32）、`action:'append'` 把 summary 追加到 `ticketId`（校验属本会话/本人 sites、更 updatedAt+history 留痕、不建重单），返回 `{ok, created:[{id,type,title,priority}], appended:[{id}]}`；前端逐条补「已建单」卡 + 刷左侧清单 + 水位线上移。**几条 new = 几张单，由用户拍板，不靠 AI 出几个块/续聊不再闷头合并**。端点在 `LINK_OK`/`FIELD_OK`/`FS08_FIELD_API` 白名单、现场按 sites 收敛、空清单 400、append 不存在的单跳过不报错。会话记录 `intake-conv`（AC-36）照常 upsert。

### D. 归档建议确认 + 直接表单提交（intake-submit 兜底路径）
- **AC-13** Given AI 给出归档建议（产品 · 子系统 · 版本 · 客户医院）When 现场确认 Then 建单以该归档上下文落库（`project`=产品、`subsystem`=子系统、`version`=版本、`site`=医院），字段来自 chip 上下文 + 会话，不需现场手填全表单。
- **AC-14** Given AI 不可用/超时（`intake-chat` 返回降级文案或前端探测超时）When 现场选择「人工提交」Then 走 `POST /api/intake-submit`（现场手选 产品·子系统·类型 + 标题/描述），`type ∈ {requirement,bug}`，`status='待处理'` 建单成功，**不因 AI 失败阻断提交**（PRD §8 AI 兜底）。
- **AC-15** Given 类型为 BUG 且**未提供版本** When 调 `intake-submit`（BUG 版本必填）Then 返回 400「请填/选产品版本（BUG 必填）」，前端内联提示补版本；需求（requirement）无此强制。
- **AC-16** Given 建单成功（intake-submit）When 返回 Then 响应含 `{ok:true, id, reply}`（AI 首轮沟通话术），前端把 `reply` 作为 AI 首条气泡展示，工单进入 `待处理`（或 AI 配置就绪时 `沟通中`）。

### E. 咨询答疑（consult · SSE · 不进批次 · 可沉淀经验库）
- **AC-17** Given 切到「咨询答疑」模式 When 现场发问并回车 Then 以仅含 `role/content` 的 `messages[]` 调 `POST /api/consult`（SSE 流式，带 `project`/`version`/`site`/`subsystem`/`deep`），AI 答复**逐字流式**追加到 AI 气泡（`data: {v:片段}`），结束事件 `{done:true, convId, kbHits}`；经验引用的真实性与恢复契约见 FS-06 AC-C5/C6/C7。
- **AC-18** Given 咨询会话产生答复 When `consult` 落库 Then 生成 `type='consult'` 记录（`lifecycle='已答复'`），**不进运营端工单收件箱**（`listIntake` 默认 `withConsult=false` 过滤掉）、**不进批次**；`convId` 返回供同会话续问（同 `convId` 续存，不新建）。
- **AC-19-KB** Given 咨询"解决了"（现场点「已解决/沉淀经验库」）When 触发 Then 调 `POST /api/kb-from-consult`（带 `project`/`convId`；兼容旧入参 `q`/`a`）沉淀为经验库条目（`from='consult'`），成功反馈；不解决则不沉淀。
  - **整段对话 AI 整理（非只抓最后一轮）**：带 `convId` 时后端取该 consult 记录**整段 `chat`**，用 AI 整理成一条条目——`q`=用户**核心问题**（抓真正要解决的那个，**不是最后一个追问**）、`a`=**最终解决方案**且**涵盖整段排查脉络**（核心问题→关键排查→最终定位与解法）；`subsystem` 取 `src.subsystem`。
  - **兜底**：未配模型 / AI 失败 / 解析失败 → `q`=chat 首条 user 文本（核心问题）、`a`=末条 assistant 文本（不再只取最后一轮）。
  - **数据权限**：现场账号只能沉淀自己 `sites` 内医院的咨询（`src.site ∈ user.sites`），管理员不限，越权→403。
  - **兼容**：`convId` 缺失时回落旧的 `q`/`a` 直存路径（向后兼容不破坏）。

### F. 新对话 / 数据权限 / 幂等 / 兜底（贯穿）
- **AC-20** Given 当前会话已有多轮对话（含已建单）When 点「新对话」`.newc` Then 清空对话流与输入、开新会话（新 `convId`/无 `savedId`），**不影响已提交的工单，也不重置当前 mode/医院/子项目/系统/版本/分组方式**；退出登录才清除对话与全部导航草稿。
- **AC-21【数据权限】** Given 现场账号 A（`sites=["山东省立医院"]`）When 提交时前端传 `site="郑州人民医院"`（不在其 sites）Then 服务端以**当前账号可归档医院**收敛（提交医院必须 ∈ `sites`；越权医院→改用当前所选合法医院 / 或 400），**不得**把工单落到非负责医院（对齐 PRD §3.3/§7、决策 B）。🔧 见 §4 微调项。
- **AC-22【幂等】** Given 同一会话已建单（有 `savedId`/`convId`）When 因网络重试重复发送同一确认 Then 不产生第二张工单（intake-chat 仅在 AI 产出新 record 时建单；consult 同 `convId` 续存不新建）——防重复建单。
- **AC-23【草稿 + 当前工作界面恢复】** Given 现场停留在某工作界面（含 `mode`=hosp/sys/overview、医院、子项目、系统、`groupBy`、系统版本）并有当前对话 When 同标签刷新 Then 用 `sessionStorage` 恢复导航上下文、`submitKind/deep`、完整对话/未发输入与左侧选中态。恢复顺序必须为「引用数据就绪 → 校验导航 → 加载对应清单/版本 → 恢复对话」；已删除或不在当前实时引用数据内的医院/子项目/系统不得恢复，其中系统以登录后 `/api/field/systems` 已返回的实时列表为唯一校验依据（按稳定 `name` 匹配），不得再用 `me.projects` 对返回项二次过滤；版本在实时版本列表中二次校验并失效时回退最新。草稿不存密码/token，换登录用户即丢弃。
- **AC-24【未登录】** Given 未登录 When 调 `/api/intake-submit`·`/api/intake-chat`·`/api/consult` Then 依 FS-01 登录门 / `authGate`（这三端点在 `FIELD_OK`，登录后现场可调；未登录访问工作空间被登录门遮罩），不越权。
- **AC-25【每系统各记一段会话 · 切系统跟随切换/恢复】**（2026-07-23 新增 · 用户裁决「切系统 → 恢复该系统的对话」）Given 实施端已登录、右侧 AI 对话区 When 用户在同一会话内**切换系统上下文**（医院视图切医院 `onHospSelect`/切子项目 `selectSub`、系统视图切系统 `onSystemTab`、或医院↔系统视图切换 `setMode`）Then 前端以**集中式** `syncConversationToSystem()`（幂等）在每个切换点末尾同步右侧对话——① 把**切走前**的当前会话打成快照存进旧「系统上下文」桶 `chat.bySystem[oldKey]`；② 若切入的系统桶**已有快照**→ `restoreConversation()` 恢复该段（清空对话流后逐条重渲染：user 转义、assistant 走 `md()`；恢复 `messages/convId/submitKind/savedId/analyzed/reopenProject/reopenSubsystem/输入框值`）；③ 若该系统**从未聊过**→ `newConversation()` 全新空会话。系统上下文键 `systemKey()`：系统视图 = `'sys||'+curSys`、医院视图 = `curSite+'||'+curSub`（尾部空串=「全部系统/全部子项目」桶，合法会话槽）。故：系统 A 聊几句→切系统 B（右侧显 B 之前聊到哪、B 未聊过则空）→切回 A（右侧恢复 A 的对话，含未发输入与续聊锁定）。
- **AC-26【会话桶内存态 · 当前界面可刷新恢复】** Given AC-25 的各系统会话 When 页面刷新 Then `chat.bySystem` 仍是纯内存态（不整桶进端存储），仅当前已校验导航上下文那段会话由 AC-23 草稿恢复，其他系统段可通过已持久化的「对话记录」reopen。`newConversation` 清当前桶但保留导航；`doLogout` 清空所有桶并移除整份草稿；恢复完后 `chat.lastSystemKey=systemKey()` 作为当前桶基线键。

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
- **AC-36【对话全量持久化 + 会话记录 + 软删】** Given 现场「提需求/报BUG」在对话区聊天 When 本轮**沟通过**（用户发了内容 + AI 回了内容）Then 服务端**不论是否建单**都 upsert 一条**会话记录**（`type='intake-conv'`，id=`CONV-<sessionId>` 确定性派生·同会话每轮命中同一条；随 `intakes` 表 + `data` JSON、**无新库列**；`sessionId` 空不存）——`intake-chat` 每轮存、`intake-reply` 同步刷新；**会话记录 ≠ 工单**：`listIntake` 排除 `intake-conv`（不进左侧提交清单/批次/统计/导出/待办），建单逻辑不变、不建重单，工单与会话记录靠 `sessionId` 关联。And `GET /api/field/conversations` 改列**会话记录**：咨询每条一项；提需求/报BUG 每个 `intake-conv` 一项（`fromConv:true`，**含未建单** `ticketCount:0`，按 sessionId 关联工单统计 `reqCount/bugCount/tickets`）；**旧数据兜底**（有工单无会话记录的历史 session → `fromConv:false` 按 sessionId 归组，不丢）；软删会话记录不复现（`deletedConvKeys` 让兜底跳过）；过滤 `deleted`、收敛不变、updatedAt 倒序。And **未建单会话记录可续聊**（`reopenIntakeConv` 从会话记录恢复整段 chat + 锁 `reopenConv*` 上下文，续聊走 intake-chat 同 sessionId，AI 够了再建单落该 session）；已建单会话续聊走 intake-reply、显多张已建单卡。And **对话记录每条支持软删**（复用 `POST /api/intake-delete`，置 `deleted=true`）：仅对真会话记录（consult / `fromConv` intake-conv）开放删除入口，**旧数据兜底项（代表工单）不给删**（工单到左侧提交清单删）；**删对话记录 ≠ 删其建的工单**。And **reopen 渲染按真实时序（2026-08-07）**：`reopenIntakeConv` 把「文本消息（各带 `ts`）」与「已建单卡（各带 `submittedAt`）」合并成**按时间正序**的序列渲染（`mergeConvTimeline`+`renderConvTimeline`），**已建单卡插到"它被建出来的时间位置"**（该单在哪条消息之后建就渲染在其后），不再一股脑贴末尾；会话记录 chat **保留每条消息各自 `ts`**（`saveConvRecord`→`reconcileChatTs`：老消息沿用、新消息补递增），不整段盖同一时刻。老数据（ts 全同/缺失）兜底：消息保持原序、卡贴其后（按分钟粒度比对 `ts`↔`submittedAt`）。And **附图按轮落位到会话记录（2026-08-07）**：`intake-chat` 本轮附图 → 存会话级目录 `media/<sessionId>/t<turnIndex>/img-N.png` 并挂到会话记录**本轮 user 消息** `msg.media`（`saveConvRecord`/`reconcileChatTs` 保留、`intake-reply` 同步、无图 `delete media` 保持干净）；`reopenIntakeConv` 把 `msg.media` 经 `mediaUrls` 传 `appendBubble`（不再 `[]`）→ **图随该轮气泡就位**（点开原图）。老记录（消息无 media）→ 记录级 `item.media` 末尾兜底、无图不崩（历史数据限制：修复前的图只在工单、不在会话消息，无法还原到某条）。

### L. 左侧「提交清单」工单点击 = 只读详情抽屉（2026-08-07）
- **AC-37【工单点击开只读抽屉，不进对话续聊】** Given 现场左侧「提交清单」的需求/BUG 工单卡 When 点击 Then 打开**右侧只读详情抽屉**（`openTicketDrawer` → `/api/intake-detail` 取完整 item → 渲染）——**不再** `reopenIntake` 恢复整段对话到右侧对话区（续聊改由右上「对话记录」承担）。抽屉展示（有才显）：类型标签+状态+编号+标题；元信息 现场/子系统/版本/紧急程度/提交人/提交时间；需求 bg/reqDesc/scene/accept/relate、BUG desc/errorInfo/steps/expectResult/severity/scope/env/freq、AI opinion+analysis、截图 media（`/api/intake-media` 缩略图点开原图）；长文本 `md()` 渲染。可 ×/遮罩/Esc 关闭（Esc 逐层关最上层）。consult（系统视图若有）点击仍 `reopenConsult`（咨询是对话、进对话区续聊）。左侧工单卡软删入口/选中态不变。

### M. AI 答复可读性 + Markdown 表格（2026-08-10）
- **AC-38【默认面向实施/产品的回答结构】** Given 现场在「咨询答疑」发起普通问答或「深入思考」 When AI 组织可见正文 Then 默认顺序为：①**先说结论**；②给**现场可执行步骤**（页面/按钮/可观察现象）；③仍未解决时说明**还需提供什么信息**（已解决可省略）。默认不得以 spec 编号、源码路径、类/方法、表名/字段、HTTP/JSON 等技术信息开场，也不为证明检索过程而强制罗列出处；仅当用户明确要求技术细节，或在正文末尾独立的「技术依据（研发参考）」中提供。深入思考仍可内部检索代码。所有结论必须基于真实 spec/源码/经验库证据；证据不足则说明未确认与下一步，禁止臆造。
- **AC-39【标准 GFM 管道表格安全渲染】** Given AI 回复含标准管道表格（首尾 `|` 可省略、分隔行支持 `:---`/`---:`/`:---:`） When 在 `field.html`、共享 `ui.js` 消费页或 `submit.html` 渲染 Then 生成带 `<thead>`/`<tbody>` 的真实 `<table>`，单元格支持受控行内 Markdown（粗体/行内代码），分隔行不再原样显示；输入先转义再生成受控 HTML，`<script>`/事件属性等不得注入。表格外有最大宽度 100% 的横向滚动容器，窄屏不撑破页面；现场对话正文桌面字号 ≥15px、移动端为 16px。
- **AC-40【Markdown 语义分隔线】** Given AI 回复含独占一行的 `---` 或 `***` When 经 `field.html`、共享 `ui.js` 或 `submit.html` 渲染 Then 输出低干扰的 `<hr class="md-divider">`，不得原样显示短横杠；列表项与 GFM 表格分隔行仍按各自语义渲染，且继续满足 AC-39 的先转义/XSS 护栏。
- **AC-41【窄视口长答复不裁切】** Given 实施端因右侧打开浏览器调试工具等原因使工作区可用宽度收窄，且 AI 答复含超长 URL、无断点行内代码、代码块或宽 Markdown 表格 When 渲染对话与底部输入区 Then 页面及右侧对话区不得产生整体横向溢出，普通文本/URL/行内代码须在气泡内安全换行；代码块和宽表格仅在各自容器内横向滚动；AI 气泡、输入框、图片按钮和发送/停止按钮均保持在右侧面板内且可用。共享 `ui.js` 消费页与免登录 `submit.html` 遵守同一长内容约束。
- **AC-42【历史多单会话刷新完整恢复】** Given 现场从「对话记录」打开一条已建多张工单的会话 When 异步详情加载并渲染完成后同标签刷新 Then 完整消息仍在，且 `builtTickets` 中全部已建单卡按保存顺序、原消息时间线锚点逐张恢复，同一工单 id 不重复；不能只凭 `savedId` 恢复首张卡，也不能把原本穿插在消息之间的卡片统一堆到末尾。每张卡继续保留工单号、类型、医院、子系统、版本、紧急程度和产品上下文；老草稿缺少 `builtTickets` 时才以 `savedId` 兜底一张。咨询会话刷新恢复不得串入上一段提单会话的卡片。
- **AC-43【系统视图当前系统刷新保持】** Given 现场切到「系统视图」并在顶部选中某个实时可见系统（例如显示「药师工作站」、稳定值为该项 `name`），右侧已有当前会话 When 同标签 F5 Then 顶部仍显示原系统、清单仍按该系统加载，右侧会话不变。只有保存的 `name` 已不在当次 `/api/field/systems` 返回列表时才安全回退「全部系统」。

### N. 咨询 Spec 两阶段召回与本轮事实边界（2026-08-12）
- **AC-44【完整目录路由 → 候选正文检索】** Given 产品仓有超过 60 份 Spec，且正确规则可能位于第 61 份之后或某文件后部的接口/字段表格 When `/api/consult` 检索当前最后一条 user 问题 Then 服务端必须执行真实两阶段召回：① 基于**完整** Spec 目录的文件路径、frontmatter `id/title/module`、Markdown 标题层级、接口摘要/AC 标题/短表格行和机器抽取的精确标识符（API 路径、`snake_case`、`camelCase`、状态/接口码等）路由有限候选文件，移除每仓前 30/60 份等不可达截断；② **只在候选文件正文内**按标题层级切片、排序 Top5，长表格/长章节后部不得因固定前 800 字截断而丢失。目录、标题、接口摘要、表格行与机器标识符索引只用于路由，**不能作为事实证据**；普通事实问答只把本轮命中规格的精简目录给模型，只有明确询问“有哪些模块/功能/规格目录”时才给完整目录。精确路径/字段/状态值须强匹配，中文自然问法与相邻模块（如监护/反馈）须按当前问题实体消歧，`word` 参数不得被 Word 导出抢占、SQL 数据库连接不得被 WebSocket 连接抢占；显式 `subsystem` 有可用 Spec 时优先收窄。允许给自然问法补充不含答案值的检索概念同义词（例如“跨医院/同一次就诊”归一到“跨院区/本次住院/复合身份”），但答案字段与取值仍必须来自命中正文，禁止把事实硬编码进查询扩展。Top5 每文件最多 3 段并兼顾文件多样性；组装给模型时，模块地图中经确认的 `answerFacts` 最高优先，其后先放当前查询的正文 Top5，再补宽泛路由章节。多轮仍保留最近 24 条正常追问上下文；普通完整问题只按当前最后一条 user 问题检索，遇到“它/这个/那/该接口”等短代词追问时，可将**上一条 user 问题**作为实体补全后再检索，但不得把 assistant 旧答案混入检索事实。提示中固定“当前问题/当前召回实体优先；历史其它模块不能作为当前事实证据”；本轮无正文证据时继续安全说明当前资料无法确认，不得靠放松证据闸门或目录标题猜答案。
- **AC-45【解决率优先的答疑桥梁与对话意图分流】** Given 实施在咨询中提问或继续对话 When AI 组织答复 Then 目标是优先在当前会话真正解决问题、减少开发重复沟通：①已知事实给直接结论和可执行排查；②复合问题按子问拼接证据，未知只局部限定；③信息不足只追问继续判断所需的最少信息，并告诉实施去哪里看、怎么收集、拿到后如何判断；④寒暄、情绪反馈、评价答复、请求换说法、助手身份问法不要求新的 Spec 证据，应结合当前会话自然承接/重述；⑤同句含语气诉求与事实问题时先承接，事实部分仍过 AC-44 证据门，不得猜按钮/接口/配置；⑥只有确需未提供源码、日志或外部系统 Owner 才升级开发，升级时整理已确认事实、已做排查、剩余缺口及所需责任方，避免开发从头重问；⑦同一功能的后续现场症状、想操作或“无库权限”等追问，必须先把当前 route 的已核规则用于判断：规则已直接解释的现象先明确为预期行为并给正确做法，不得机械进入调查；仅当实际结果与规则冲突时才收集区分分支的最少证据；若现象本身没说清落在哪个分支，先给“符合规则则停止异常调查/与规则冲突才继续”的条件式结论，再只追问一个分支判别信息，不得整体回复无法确认。助手身份仅表述为药师工作站答疑助手、实施/产品/开发桥梁，不披露底层模型或承诺未证实能力；`token谁签发/记录谁创建/谁有权限/患者来自谁/哪个开发负责` 等人员或来源事实问法仍按证据门。
- **AC-46【图片缩略图当前页大图预览 · 回归】** Given 现场端存在待发送截图、实时或历史恢复消息中的截图（data URL 或 `/api/intake-media` URL），或工单详情截图 When 用户点击缩略图，或聚焦缩略图按钮后按 Enter/Space Then 所有入口统一打开当前页内大图 lightbox，不依赖 `target=_blank`；大图有随上下文生成的可访问名称，`max-width/max-height` 不超视口，打开时锁定 body 滚动。When 点击 44×44px 关闭按钮、点击遮罩或按 Esc Then 关闭 lightbox、恢复原 body 滚动状态，并把焦点还给原缩略图；缩略图和关闭按钮均有可见键盘焦点，动效遵守 `prefers-reduced-motion`。待发送缩略图的删除 `×` 只删除对应图片，不得冒泡误开预览。
- **AC-47【证据不足时仍给安全最小诊断帮助】** Given 实施询问“现场怎么复现/排查/留证/转开发前最少补什么”，但当前 Spec/路由只能确认部分业务事实或完全未命中 When `/api/consult` 组织答复 Then 必须先说明“能确认/暂不能确认”的边界，再给 **2–4 步**可观察、非破坏、现场可执行的最小动作：确认页面/实际终端、账号、版本与复现前后条件；仅从本次实际请求抓取 URL、参数、HTTP/业务返回与响应；区分“没有发请求 / 请求失败 / 响应正常但页面不对”；整理时间点与脱敏截图。不得因证据不足而只机械索要 Spec，也不得为了“可执行”臆造按钮名、接口路径、参数/字段、表名、状态值，或建议可能产生副作用的重试/重复提交。Given 用户明确说“只有图/拿不到 Spec/先别让我找 Spec” Then Spec 不得继续作为第一项要求，应直接按上述安全动作帮其形成可转交的最小证据包。已确认的具体业务规则仍须来自 Spec/源码/经验库证据，本条不放松 AC-44/45 的事实证据门。
- **AC-48【多分组/页签筛选只读验证】** Given 已确认页面或接口在首次加载时一次返回多个分组 When 实施询问“切页签没发新请求是不是筛选失效/怎么验证页签生效” Then AI 必须先说明页签可以只在前端切换首次响应已有分组，不得断言每次切页都必须发新请求，也不得仅因“没发新请求”判失效；只有 Spec/源码/接口契约已明确“切换应逐次请求”时才可以要求。验证必须优先只读：对比首次实际响应中各组的数量、成员集合与页签显示，核对同一记录在分组间已确认的互斥/包含关系；不得为验证而点开未读、切换已读/星标、审批或提交等会改变业务状态的动作。新问题显式换成其他业务实体时，仍按 AC-44/45 重新路由，不继承上一轮分组事实。
- **AC-49【同会话已核 route/facts 在后续诊断中持续生效】** Given 同一会话前一轮已由模块地图 route 与本轮召回正文确认某功能事实 When 实施后续仅用“回到这里/第一步看过了/接口通了但页面没变化/接下来或下一步”等排查进度口语追问，且没有显式切到新业务实体 Then `/api/consult` 必须继承最近的已核 route，仅从地图 `answerFacts` 与本轮重新装配的正文证据继续判断；连续多轮省略业务名时可越过纯进度句回溯最近已核 route，但不得读取历史 assistant 自由文本作为证据。答复必须先把已确认事实作为现场判断基线，围绕“规则应有结果 vs 当前观测”给最少非破坏动作，不得因为当前句改问排查就整体降级成“说明书未覆盖”；未被 route/正文/源码确认的接口、字段、状态或实现细节仍只做局部未知。Given 当前轮出现明确新业务实体或无证据高风险按钮/菜单问法 Then 当前直达 route 或事实 miss 必须覆盖旧 route，禁止串话。本条不放松 AC-44/47 的证据与安全诊断门。
- **AC-50【同主题已核事实账本在部分证据/现场限制下持续有效】** Given 同一会话的同一实体/主题在前一轮或更早已由模块地图 route 与重新召回的 Spec/源码确认事实 When 实施随后用“上午反馈/数据库或日志没权限/只靠页面或接口响应/目前只能确认请求发出/还缺什么/复测到某一步”等表达说明本轮证据限制或进度，且没有明确的新实体或有证据的新事实推翻旧规则 Then `/api/consult` 必须把该主题最近的已核 route `answerFacts`、`mustNotConfuse` 与本轮重新召回的 Spec/源码作为持续事实账本：答复先陈述仍有效的已知规则，再分开说明本轮现场已确认、仍局部未知与最少非破坏动作；不得因本轮拿不到数据库/日志或只确认链路中间层而把整个主题降级成“说明书未覆盖”。连续部分证据轮允许向前回溯最近同主题的已核 route，但中间若已命中不同 route 或出现候选 route 不包含的新实体，必须形成主题屏障。事实账本只继承 route/Spec/源码证据，不继承历史 assistant 自己生成的示例、推测或假设；当前明确切换新实体时以新 route 或事实 miss 覆盖旧账本。未被证据确认的具体接口路径、字段、表、状态值及本次实际处理路径仍保持局部未知，本条不放松 AC-44/47 的事实与安全门。
- **AC-51【批处理/同步/调度观测与补跑副作用安全门】** Given 实施根据监控截图、最后成功时间、长时间无新增或运行中断询问“是不是调度停了/谁负责/能否恢复、重跑、补跑或重新触发” When `/api/consult` 回答批处理、ETL、同步或调度现场问题 Then 这些页面现象只能作为观测证据；除非 Spec/route/现场已确认预期执行频率、调度平台与具体任务、明确错误状态和责任 Owner，否则不得断言调度停止、平台故障或责任归属。恢复、重跑、补跑、重新触发、手动执行属于可能重复写入、扩大范围或与运行中实例并发的副作用动作；未同时确认幂等/补偿契约、目标时间窗和范围、当前运行态及执行 Owner/授权前，不得建议执行，即使用户已确认任务幂等也不能跳过其余条件。答复按固定安全顺序给实施：①对照经确认的预期计划与当前观测，仅描述差异；②只读取得具体任务实例状态、对应日志时间窗和影响范围，区分未触发/运行中/明确失败/执行成功但下游未更新；③确认 Owner、幂等/补偿契约、目标时间窗与范围；④再决定升级或在授权和条件完整时受控执行。已核“PWRS 内部不定时、由外部调度触发”等事实须在同主题后续持续作为基线，但不得外推真实平台、频率、任务名、部署位置或责任人；显式新实体必须重新路由且不继承旧任务事实。本条不放松 AC-44/47/50 的事实、局部未知与非破坏门。
- **AC-52【实施诊断默认只读，副作用验证必须满足完整前置条件】** Given 实施在 owner/权限、CRUD、反馈、收费、患教、审批、同步等主题中询问“下一步怎么验证/复测/留证”，或要求换成能照做的说法 When `/api/consult` 生成现场诊断动作 Then 默认只允许无副作用观察：优先比较已有正常/异常记录、历史日志或审计、已经发生的请求响应、页面现有只读信息，以及测试环境里已存在且明确授权的对照数据；刷新页面、切换已确认是纯前端/只读的页签、查看已确认不会触发已读或业务状态改变的详情，可以作为观察动作。不得为了验证而指挥实施新建、修改、删除、保存、提交、审批、签名、切换星标、打开会导致已读的记录、补跑、重跑或重新触发；“只做一次”“测试数据”“之后可回滚”均不能自动放行。Given 只读证据仍不足且确需改变状态 Then 只有隔离测试环境或专用测试数据、明确执行授权、回滚/清理方案、幂等性与影响范围同时确认后，才可给单次受控步骤；任一条件缺失必须停止指挥现场执行，整理已知事实/已有证据/剩余缺口后升级开发或产品确认。已核方法授权、owner、机构范围、状态和同主题事实账本持续作为判断基线，安全门只限制动作，不得把已知事实降级为未知；明确新实体仍重新路由。本条不放松 AC-44/47/50/51 的事实门、局部未知和专项运行安全门。
- **AC-53【文件下载/导出/附件制品的分层只读验收】** Given 实施询问下载、导出、附件或模板文件“返回 200/非空/能打开是否算成功”、“为什么换账号才正常”或“现场如何留证” When `/api/consult` 给出判断与诊断步骤 Then HTTP 200、业务成功码、下载响应头、字节非空、扩展名或某阅读器能打开均不是充分条件；必须对已下载响应/已有文件按层次只读检查：①响应体是文件字节而非 JSON/HTML 错误体；②`bytes>0`；③magic/签名与实际扩展名、`Content-Type`/MIME 一致；④实际声明格式的结构可解析；⑤正文/表格/业务内容抽检正确。PDF 至少检查可识别 header、EOF/xref 并由结构解析器确认；DOCX/XLSX/ZIP 至少检查 central directory 及必要 entries 可解析。格式未知时先取实际文件名、扩展名与 MIME，再按实际声明格式验证，不得猜为 PDF/DOCX 或虚构工具结果。Given 换账号后正常 Then 先固定同环境、同入口、同筛选和同一已有记录，只读对比账号权限/数据范围/模板上下文与文件本体的响应类型、字节、签名、结构和内容，不得修改权限、模板或业务数据来验证。任一层失败都不能判成功，但不得越过 Spec/route 虚构具体导出路径、模板名、权限码、文件格式或账号规则。本条不放松 AC-44/50/52 的事实账本、局部未知与非破坏门。
- **AC-54【精确路径分隔符 + 未知动作不重做 + 已知事实不授权写操作验证】** Given route/Spec/源码已确认 URL 前缀或 allowlist 字面量 When `/api/consult` 回答事实或给现场排查 Then 每个斜杠与路径段都按证据逐字保留，不得去掉/补上尾斜杠、归一化成更宽前缀或新增无证据例外；例如已核 `/comm/` 不能改写成 `/comm`，`/community` 与路径中间仅包含 `comm` 均不等价。除用户本轮真实提供的 path 外，不得为解释规则自行构造例如/示例/测试路径，也不得在已核前缀后拼接虚构后缀。Given 实施缺少请求并问“再点一次/重做一遍/复现一下/验证一下/试试看” When 触发动作是否只读、是否改状态尚未确认 Then 默认复用已有请求、日志、审计与历史记录，允许明确说当前无法安全补抓；只有动作已确认无副作用，或隔离测试环境/专用数据、授权、回滚清理、幂等与影响范围四项齐全时，才可给单次受控动作。Given 业务规则、按钮、角色或结果已有充分证据 Then 这些证据只能用于直接回答事实，不自动授权追加“用创建人点完成/正常提交/签名/审批验证”等真实写操作；涵盖权限、患教、反馈、收费、CRUD 与其它业务主题。明确只读刷新/页签/不会改状态的详情仍可观察，显式切换新实体仍重新路由。本条不放松 AC-44/47/50/52 的证据门、事实账本与非破坏边界。

> **AC 编号**：现编号至 **AC-54**（保留既有历史编号与 AC-19-KB）。AC-44/AC-45/AC-46/AC-47/AC-48/AC-49/AC-50/AC-51/AC-52/AC-53/AC-54 为 P1。

## 4. 接口契约
> 统一前缀 `/api`；除 `consult`（SSE）外返回 `{...}` JSON。**本条 100% 复用现有端点，不新增端点**；提交人 `reporter`、归档医院 `site` 服务端按当前登录用户收敛（忽略越权传参）。契约锚点见 `docs/specs/00-实施端-spec清单.md §4` 对照表。

### 4.1 ♻️ 复用（已存在）—— 逐个对齐入参/返回
| 方法 | 路径 | 用途 | 关键入参 | 返回 | 收敛/白名单 |
|---|---|---|---|---|---|
| POST | `/api/intake-chat` | **对话式建单（核心）**：AI 边聊边补，够了输出 `intake-record` → 自动建单 | `project`（产品 id）、`type`（`intake`=合并让 AI 判 / `requirement` / `bug`）、`version`、`site`、`subsystem`、`messages:[{role,content}]`、`images?` | `{ok:true, reply, savedId}`（`savedId` 非空=已建单）；AI 未配 → `{ok:true, reply:'（未配模型…）'}` | 在 `FIELD_OK`；`site`/`version`/`subsystem` 取自入参（🔧 见 4.3） |
| POST | `/api/intake-submit` | **表单直提（兜底/人工路径）**：建需求/BUG 工单 + AI 首轮沟通 | `project`、`type`（→ `bug` 或 `requirement`）、`version`（BUG 必填）、`site`、`subsystem`、`title`、`desc`、`errorInfo`、`steps`、`expectResult`、`bg`、`reqDesc`、`accept`、`priority`、`images?` | `{ok:true, id, no, reply, configured, status}`；BUG 缺版本 → 400 | 在 `FIELD_OK`；`reporter` 服务端取登录用户（L884）；`site` 缺省取 link（🔧 见 4.3） |
| POST | `/api/consult` | **咨询答疑（SSE 流式）**：Spec 两阶段召回 + 经验库检索直接答、不进批次 | `project`、`version`、`site`、`subsystem`、`messages:[{role,content}]`、`convId?`、`deep?`；Spec/KB/源码检索以最后一条 user `content` 为主，短代词追问仅补上一条 user 问题中的实体，历史消息仍随模型请求保留 | SSE：`data:{v:片段}` … `data:{done:true, convId, kbHits, stopped}`；落 `type='consult'`（`lifecycle='已答复'`）。Spec 证据仅来自候选文件正文 Top5，目录索引不作证据 | 在 `FIELD_OK`；`reporter` 服务端取登录用户（L963） |
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
  - `tools/pd-02-prompts.logic.test.mjs` 精确基线 + 回答风格契约：普通/深入模板均锁定「结论→现场步骤→补充信息」、技术依据后置、证据/不臆造（AC-38）。
  - `tools/markdown-table.logic.test.mjs` 直接抽取并执行三处真实渲染器，覆盖有/无首尾管道、对齐、粗体/代码、XSS、普通段落、滚动包装与字号（AC-39）；不得退化为仅查源码字符串。
  - `tools/fs-04-narrow-layout.test.mjs` 锁定 legacy 工作区/右栏/气泡/输入区的可收缩边界，以及三处 Markdown 对长文本、代码与宽表的统一防溢出约束；浏览器夹具 `tools/fixtures/fs-04-narrow-layout.html` 直接加载 `field.html` 的真实样式，在 980px 与 760px 视口断言页面无整体横向溢出、宽表只在自身容器滚动（AC-41）。
  - `tools/fs-04-image-preview.logic.test.mjs` 锁定待发送、实时/历史消息与工单详情三类缩略图统一走当前页 lightbox；直接执行打开/关闭真逻辑验证 data URL 与 `/api/intake-media` URL、body 滚动锁定/恢复、焦点返回，并检查按钮/遮罩/Esc、键盘语义、视口约束、44px 关闭按钮、可访问名称、可见焦点、reduced-motion 与删除 `×` 隔离（AC-46）。
  - `tools/fs-04-consult-conversation.logic.test.mjs` 与 `tools/pd-02-prompts.logic.test.mjs` 同时锁定 normal/deep 默认提示词和服务端安全诊断守卫：路由命中/缺失都能给 2–4 步最小留证，“只有图/拿不到 Spec”不再机械短路，普通无证据事实题仍保持不臆造（AC-47）。
  - 同一组测试锁定多分组/页签只读验证：一次返回多组时不要求切页必发新请求，仅明确契约可要求逐页请求，优先比较数量/成员集合/互斥包含关系，禁止通过已读/星标/提交等改状态动作验证（AC-48）。
  - `tools/pd-04-route.logic.test.mjs` 以通用夹具和 PWRS 真实地图锁定单轮及连续多轮现场进度追问的 route 继承、已核 `answerFacts` 保留、显式新实体/无证据按钮覆盖；`tools/fs-04-consult-conversation.logic.test.mjs` 与 normal/deep 精确提示词测试锁定“先用已核事实、未知局部限定、历史 assistant 不作证据”（AC-49）。
  - 同三组测试以 PWRS 配置隔离 Q30–Q33 完整链及配置、退出、反馈、权限自然变体锁定同主题事实账本：部分证据/现场权限限制不抹掉既有事实，答复按“持续规则→本轮观测→局部未知→最少动作”组织；显式新实体与历史 assistant 假设为反例（AC-50）。
  - 同三组测试以 PWRS DQ-013 真实地图锁定监控截图/最后成功时间/运行中断仅为观测，恢复/重跑/补跑/重新触发须先核幂等、时间窗、范围、运行态与 Owner/授权；覆盖调度、同步、ETL、批处理自然问法、同主题继承、明确幂等仍受控、显式新实体及 token/红按钮/患者列表反例（AC-51）。
  - 同三组测试锁定通用非破坏诊断：owner/权限、CRUD、反馈、收费、患教、审批、同步均默认使用已有记录/日志/审计/既有请求响应作只读对照；“只做一次/测试数据/可回滚”不能放行写操作，副作用验证须四项条件齐备；刷新、只读页签、不会改已读的详情和显式换题作为正反例（AC-52）。
  - 同三组测试锁定文件制品分层只读验收：200 JSON/HTML 错误体、非空能打开、扩展名与 magic/MIME 不符、PDF EOF/xref、DOCX/XLSX/ZIP central directory 和必要 entries、正确文件、换账号只读对照、未知格式不硬猜及显式换题正反例（AC-53）。
  - 同三组测试锁定精确路径分隔符与未知动作副作用门：`/comm/` 不得放宽为 `/comm`，`/community`/中间 `comm` 不命中；没有既有请求时不得要求重做未知动作抓包；事实已知也不得追加完成/提交/签名/审批等真实验证；覆盖明确只读动作、隔离授权四项齐全和显式换题反例（AC-54）。
  - `tools/spec-retrieval-two-stage.logic.test.mjs` 直接执行生产纯逻辑，覆盖目录路由真实生效、第 61 份以后可达、后部接口/字段进入 Top5、精确 API/`snake_case`/`camelCase`/状态强匹配、word≠Word、SQL 连接≠WebSocket、监护/反馈不串、显式 subsystem、本轮事实边界、短代词追问和自然问法概念归一，以及普通事实问答不向模型注入全量目录；并以 PWRS 真实 86 份 Spec 回归 git 目录第 79 份 `PWRS-SYS-07a`、第 82 份 `PWRS-SYS-10`、Pad 反馈对象接口、异常检验近 5 天和跨院区复合身份正文 Top5（AC-44）。
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
- [x] AC-38..41 的回答结构、Markdown 表格/分隔线与窄视口长内容回归通过；980px、760px 浏览器夹具均无页面级横向溢出，宽表只在自身容器横滚。
- [x] AC-44 两阶段召回专项通过：完整目录路由、候选正文 Top5、精确标识符/相邻模块消歧、短代词追问、自然问法概念归一和本轮事实边界均有自动化证据；生产正确 tag 上 Qwen-Max 代表性检查点 12/12，普通事实问答不再向模型注入全量目录。
- [x] AC-46 图片缩略图当前页预览专项 4/4 通过：三类入口统一 lightbox、data/API URL、键盘/关闭路径、焦点/滚动恢复、视口/动效与删除隔离均有自动化证据；待人工浏览器验收，未部署。
- [x] AC-47 安全最小诊断专项通过：normal/deep 提示词精确契约、route hit/miss、只有图/无 Spec、普通事实题反例和不得臆造具体技术名均有自动化证据；待人工浏览器验收，未部署。
- [x] AC-48 多分组/页签只读验证专项通过：normal/deep、服务端守卫、PWRS 真实地图与显式换实体反例均有自动化证据；待生产可见浏览器验收。
- [x] AC-49 同会话事实连续性专项通过：自然排查进度句、连续两轮省略实体、PWRS 退出跳转 Q21–Q23、显式新实体与无证据按钮反例均由真实地图回归覆盖；待生产可见浏览器验收。
- [x] AC-50 同主题事实账本专项通过：PWRS 配置隔离 Q30–Q33、配置/退出/反馈/权限部分证据自然问法、历史 assistant 非证据与显式新实体反例均由真实地图回归覆盖；待生产可见浏览器验收。
- [x] AC-51 批处理/同步/调度安全门专项通过：PWRS DQ-013 旧时间截图、运行中断、补跑/重跑/重触发、明确幂等受控条件、同主题继承与显式换题正反例均由真实地图回归覆盖；待生产可见浏览器验收。
- [x] AC-52 通用非破坏诊断专项通过：normal/deep 默认契约、运行时守卫、PWRS 权限/归属真实地图、多主题副作用正反例和显式换题均有自动化证据；待生产可见浏览器验收。
- [x] AC-53 文件制品分层验收专项通过：normal/deep 默认契约、运行时守卫、PWRS DQ-014 真实地图以及下载/导出/附件/模板自然问法、换账号与显式换题正反例均有自动化证据；待生产可见浏览器验收。
- [x] AC-54 精确路径与未知动作安全专项通过：normal/deep、运行时路径边界守卫、通用非破坏守卫及 PWRS 真实地图覆盖尾斜杠正反、未知动作重做、委婉写操作验证、明确只读和隔离授权条件；待生产可见浏览器验收。
- [ ] 人类验收通过。
