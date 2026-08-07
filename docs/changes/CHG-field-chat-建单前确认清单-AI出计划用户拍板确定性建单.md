# CHG · 现场端「提需求/报BUG」建单前「确认清单」：AI 出结构化计划 → 用户确认/编辑 → 系统确定性建单/补充

- 日期：2026-08-07
- 关联 spec：FS-04（AI 对话提交）——起草 **AC-11/AC-12 补强 + 新增 AC-37 diff**（见本文末，**未合并**，待人审）
- 类型：逻辑/行为增强（把"AI 直接建单/续聊无脑追加"改成"AI 出计划 → 用户拍板 → 代码确定性建单"，涉及 spec，起草 AC diff）

## 背景 / 痛点（提示词压不死的两个失效点）
现场端「提需求/报BUG」对话流，把"对话 → 几张工单"完全交给 AI 自觉 + 服务端 `matchAll` 兜底，有两个提示词压不死的坑：
- **① 同一段多条需求被揉成一张单**：AI 觉得相关就合并（实测：忽略比对 + 厂家自动匹配 → 只建 1 张）。虽经 v1（2026-08-06「已建单水位线」+「N 条=N 块」强约束）缓解，但仍依赖 AI 每次乖乖出对的块。
- **② 续聊一张已建单，新需求被闷头追加进旧单**：reopen 工单/已建单会话 → 走 `intake-reply` **无脑 append**（实测：昨晚建的 XQ-…-01，今早续聊提"厂家"→ 被追加进旧单、没另起单）。
**根因**：建单/补充靠"AI 每次输出对的结构 + 续聊无脑追加"，无用户拍板环节。

## 解法（治本 · 用户拍板，代码执行）
把「对话 → 建单」从"AI 自觉"改成 **AI 先出结构化计划（`intake-plan`）→ 前端「确认清单」卡让用户确认/编辑 → `POST /api/intake-commit-plan` 按清单确定性建单/补充**。

### 1) AI 出「计划」而非直接建单（server.mjs）
- `intakeChatSystem(proj,type,ver,subKey,hasArchivedBg,builtTickets)`：新增末参 `builtTickets`。提示词改成——信息齐时**不再输出 `intake-record` 建单块**，改在回复末尾输出**一个** ```` ```intake-plan``` ````（严格 JSON，`items:[{action,ticketId?,type,subsystem,title,priority,summary,…}]`）：
  - **一条独立需求/BUG = 一个 item，绝不合并**（N 条=N items；少一个=漏建单=错）；每 item 必填 `summary`（确认卡展示）。
  - **续聊场景**（传入 `builtTickets` 已建单清单）：明显是对某已建单的补充/追问 → `action:'append'` + `ticketId`；新的、和已建单不同 → `action:'new'`。**默认倾向 new**（宁可用户改成 append，别默认合并）。
  - 提示词强调「建单要等用户在确认卡上点确认、此刻还没建」，AI 别自称已建。
- 新增 `parseIntakePlan(reply, forceType)`（模块级）：解析第一个含 items 的 `intake-plan` 块 → 归一化 items（`action∈{new,append}`、`type` 合并模式取 AI 判/否则 forceType、`priority` 规范四档、无标题丢弃）+ 剔块后可见正文。坏块/无块 → items 空（不建脏单）。
- `/api/intake-chat` **不再自动建单**：调 `parseIntakePlan` → 回 `plan:{items(补 project/site/version/subsystem 兜底), project,site,version,subsystem,sessionId}`；`savedId/savedIds` 恒空（老前端字段保留但为空，避免误建卡）。**落库真实完整对话 + 会话记录 upsert（AC-36）不变**；水位线 `filedUpTo` 切段保留（已建单只读背景不污染当前待处理段）。

### 2) 前端「确认清单」UI（public/field.html）
- `sendIntake` 收 `b.plan.items` → `renderPlanCard(plan,archive,imgs)` 在对话流渲染一张**可编辑确认卡**（`.f-plan`）：标题「我识别到这 N 条，请确认后建单」，逐条：
  - `action` 切换 `[新建工单]`/`[补充到工单…]`（append 时下拉 `.aptk` 选本会话已建单，默认选首张）；类型 需求/BUG；可改**标题** `.ptitle`、**摘要** `.psum`；**删除**该条 `.pit-del`、**「拆成两条」** `.split`（复制一条让用户改）、底部**「+ 再加一条」** `.addone`；子系统名显示。
  - 底部**「确认建单」** → `commitPlan(card,model,archive)` 调 `intake-commit-plan`。**用户没确认前不建任何单**（可继续对话，AI 重新出计划；新计划把旧未提交卡标灰 `.done`=已被取代，防对着过期计划点确认）。
- 建单成功 → 卡片置 `.done` 态（隐编辑区+显「已建单：新建 N 张/补充 N 张」）+ 逐条补「已建单」卡（per-ticket 紧急程度 AC-32）+ 每张即时 `intake-analyze` 初判（NH-3）+ 刷新左侧 + 记 `chat.builtTickets` + 水位线上移。

### 3) 按清单确定性建单（新端点 `POST /api/intake-commit-plan`）
- 入参 `{project,sessionId,site,version,subsystem,items:[{action,ticketId?,type,title,subsystem,summary,…}],images?}`：
  - `action:'new'` 逐条 → 建一张工单（复用 `intake-chat` 建单落库范式：id/type/title/subsystem/`normPriority`/sessionId/site/version/reporter/media/history `note:'对话提交（确认清单）'`/analysis）。
  - `action:'append'` → 校验 `ticketId` 存在 + 非软删/非会话记录/非咨询 + 现场按 `user.sites` 收敛（`e.site∈sites`，管理员不限，越权→跳过该条不报错）；把 `summary` 追加为一条 user 沟通消息 + `history.push(note:'对话补充：…')` 留痕 + `updatedAt`。
  - `site` 服务端 `convergeSite` 收敛；无标题 item 跳过（不建脏单）；空清单 → 400。返回 `{ok, created:[{id,type,title,priority}], appended:[{id}]}`。
  - 白名单：进 **LINK_OK**（访客链接原经 intake-chat 自动建单，现走 commit-plan 须放行）+ **FIELD_OK** + **FS08_FIELD_API**（否则实施域 originGate deny）。

### 4) 续聊也接确认清单（不再无脑追加）
- 前端 `sendChat` 分派：**续聊已建单会话也走 `sendIntake`（plan 流）**，不再 `sendIntakeReply`→`intake-reply` 无脑 append。`reopenIntakeConv` 已建单会话 reopen 时填 `chat.builtTickets`（供 AI 判 append/new）+ 清 `reopenIntakeProject`（改走 plan 流）+ 锁 `reopenConv*` 上下文（新建单落对 project/site/subsystem）。`currentArchive` guard 放宽（去掉 `!chat.savedId`，已建单会话也锁 reopenConv 上下文）。
- `chat.builtTickets`/`chat.lastPlanCard` 新增 state，随草稿/快照 save/restore、`newConversation` 清空。

## 兼容 / 老 `intake-record` 路径如何处理
- **不保留** `intake-record` 老路：`/api/intake-chat` 不再解析 `intake-record`、不再 `matchAll` 建单、不再剥 `intake-record` 块——统一走 `intake-plan`（避免两套）。`intakeChatSystem` 提示词由出 record 块改为出 plan 块。
- `savedId/savedIds` 响应字段保留但恒空（老前端读到空→不建卡，不报错）；前端已同步改为读 `b.plan`。
- 水位线 `filedUpTo`（v1 主修）、per-ticket 紧急（AC-32）、`sessionId` 归组、会话记录 upsert（AC-36）、幂等锚点 `savedId` **全部保留复用**。
- `intake-reply` 端点保留（未被主链路调用，但不删，供极端兜底/向后兼容）。

## 验证（连 prod · 真模型 qwen3.6-plus · 真 MySQL · link token 驱动 · 已清造数）
prod `intake.lcpharmacy.cn`（容器内打 `127.0.0.1:5180`，project=hlyy，site=冒烟测试医院）：
- **场景1（一段两条 new）**：一轮提"忽略比对 + 厂家自动匹配"两条 → AI 出计划含 **2 条 new** → commit 建 **2 张独立单** `XQ-20260807-01`（手动忽略差异项）+ `XQ-20260807-02`（厂家自动检索赋值），不揉成一张。
- **场景2（续聊新需求 = new，不 append）**：已建单会话续聊提**全新无关**需求"短信验证码登录" → 计划里是 `action:'new'`（**不是 append 到旧单**）——正是原痛点②，现修好。
- **场景3（续聊补充 = append 到 A）**：续聊对 A 的补充"忽略后记录操作人+时间" → AI 判 `append:XQ-20260807-01` → commit `created=0, appended=[XQ-20260807-01]`（**不建重单**），A 的 `history` 多两条「对话补充：…」留痕、chat 末条含补充。
- **场景4（拆条）**：确认卡把 1 条拆成 2 条（需求甲 + BUG 乙）→ commit 建 2 张 `XQ-…`(requirement) + `BUG-…`(bug)，类型各自正确。
- **校验**：append 不存在的单 → `created=0, appended=0`（跳过、不报错、不建脏单）；空清单 → 400「清单为空」。
造数已硬删清理（FS + MySQL 双删）、重启容器刷 CACHE，prod 回基线（health intakes:4，0 冒烟残留）。`git diff` 已扫，无密钥/prod 口令入提交物。

## 逻辑测试（脱库 · 本地 `node --test` 全绿）
- `tools/fs-04-intake-chat-sequential.logic.test.mjs`（重写，25 用例）：intakeChatSystem 出 plan 块 + 一条一 item 硬约束 + builtTickets 判 append/new；parseIntakePlan 真身（多 item/append 保 ticketId/forceType/坏块/只认首块）；intake-chat 调 parseIntakePlan·不自动建单·回 plan·上送 builtTickets；commit-plan 端点 new/append/site 收敛/无标题跳过 + 三白名单；前端确认卡渲染/编辑/commit/续聊走 plan 流/builtTickets 记账；水位线切段复刻。
- `tools/fs-04-conversations.logic.test.mjs`（C8 更新）：currentArchive guard 放宽（已建单会话也锁 reopenConv）。
- `tools/fs-04-set-priority.logic.test.mjs`（B1/B2/B9 更新）：建单 priority 断言从 intake-chat 挪到 commit-plan / commitPlan。
- 全量 `*.logic.test.mjs` 134 断言 0 失败。（`fs-04.test.mjs`/`fs-06.test.mjs` 为 spawn-server 集成测，本地缺 MySQL ECONNREFUSED，与本改动无关，真库冒烟走 prod。）

## 改动文件
- `server.mjs`：`intakeChatSystem`（出 plan 块 + builtTickets 参）、新增 `parseIntakePlan`/`PLAN_BLOCK_RE`、`/api/intake-chat`（解析 plan 不建单·回 plan·收 builtTickets）、新增 `/api/intake-commit-plan` 端点、LINK_OK/FIELD_OK/FS08_FIELD_API 三处白名单加 `/api/intake-commit-plan`。
- `public/field.html`：`.f-plan` 确认卡 CSS、`renderPlanCard`/`buildPlanItemRow`/`commitPlan`、`sendIntake`（收 plan 渲卡 + 上送 builtTickets，不再直接建卡）、`sendChat`（续聊走 plan 流）、`reopenIntakeConv`（填 builtTickets + 走 plan 流）、`currentArchive`（guard 放宽）、`chat.builtTickets`/`chat.lastPlanCard` state + snapshot/restore/draft/newConversation。
- 三个 `tools/fs-04-*.logic.test.mjs`（见上）。

---

## spec diff（起草·未合并·待人审）—— FS-04 §AC-11 / §AC-12 补强 + 新增 §AC-37

> ⚠️ 以下为**建议改动**，未写入 `docs/specs/FS-04-AI对话提交.md`。人审通过后再合并 + 置 accepted。

**AC-11 末尾补**（原「…**已建单水位线 + N 条=N 单强约束（2026-08-06 主修）**：…揉成一张。」之后追加）：
> **建单前确认清单（2026-08-07 v2 · 治本）**：AI **不再直接建单**。信息齐时 `/api/intake-chat` 让 AI 在回复末尾输出**一个** ```` ```intake-plan``` ````（严格 JSON `items:[{action,ticketId?,type,subsystem,title,priority,summary,…}]`，**一条独立需求/BUG=一个 item·绝不合并**，每 item 必填 `summary`）；服务端 `parseIntakePlan` 解析后**只把 `plan.items`（补 project/site/version/subsystem 兜底）回给前端**、**不建任何单**（`savedId/savedIds` 恒空）。前端渲染**可编辑「确认清单」卡**（改标题/摘要、切「新建/补充到某已建单」、删条、拆条、加条），用户拍板前不建单。老 `intake-record` 路径不再保留（统一走 plan，避免两套）；水位线 `filedUpTo` 切段、会话记录 upsert、落库真实完整对话不变。

**AC-12 末尾补**（原「…**顺序流 + 多条回归（2026-08-06）**：…reopen 已建单会话设满、未建单设 0。」之后追加）：
> **确认后确定性建单（2026-08-07 v2）**：用户在确认卡上点「确认建单」→ `POST /api/intake-commit-plan {project,sessionId,site,version,subsystem,items[],images?}`：`action:'new'` 逐条建独立工单（复用建单落库范式）、`action:'append'` 追加 `summary` 到指定单（校验存在 + 非会话记录/咨询 + 现场按 `user.sites` 收敛越权跳过 + history 留痕、**不建重单**），`site` 服务端 `convergeSite` 收敛、无标题 item 跳过、空清单 400，返回 `{ok,created:[{id,type,title,priority}],appended:[{id}]}`；前端逐条补「已建单」卡（per-ticket 紧急 AC-32）+ 即时初判（NH-3）+ 刷新左侧 + 水位线上移。端点进 LINK_OK+FIELD_OK+FS08_FIELD_API 三白名单。

**新增 AC-37**（放在 §H 之后或就近 AC-36 之后）：
> - **AC-37【建单前确认清单 + 续聊接入·治本】** Given 现场对话信息齐 When `/api/intake-chat` 返回 Then AI 出 `intake-plan`（一条独立需求=一个 item，绝不合并），服务端不建单、回 `plan.items` → 前端渲染可编辑「确认清单」卡（新建/补充/删/拆/加）；用户点确认才 `POST /api/intake-commit-plan` **确定性**建单/补充。And **续聊已建单会话也走 plan 流**（前端 reopen 填 `chat.builtTickets` 上送，AI 判「补充旧单(append) or 新建(new)」、**默认 new**）——**杜绝**"续聊新需求被闷头追加进旧单"（原痛点）；`append` 按 sites 收敛、history 留痕、不建重单。And 未确认前不建任何单；新一轮出新计划把旧未提交卡标灰（防对着过期计划点确认）。（验证：一段两条→2 张独立单；续聊无关需求→new 新单；续聊补充→append 旧单不重单；确认卡拆条→2 张。）
