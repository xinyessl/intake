# CHG · 答疑沉淀经验库「只抓最后一轮、丢核心问题」修复（整段对话 → AI 整理 Q/A）

- **日期**：2026-08-06
- **来源**：用户实测反馈——一条多轮咨询核心是「为什么5级审核处方没进来/药师没收到任务」，一路排查到最后才定位到 socket 端口不通；但沉淀出的 KB 条目 Q 只有最后那句「打开控制台发现socket连接失败了…」，**把真正的核心问题丢了**。期望：沉淀时整理整段对话。
- **spec**：FS-04 §E `AC-19-KB`。**属行为调整**（沉淀内容从「最后一轮问答」改为「整段对话经 AI 整理」）→ **涉及 spec**，已起草 diff（见下「spec diff」），**未合并**，随交付请人拍板。
- **范围**：`server.mjs`（`/api/kb-from-consult` 端点）+ `public/field.html`（沉淀按钮改发 `convId`）。**未新增库表/库列**（沿用 `kb_entries` + `data/kb/*.json` 双写、条目结构不变）。另**修复现网一条已沉淀错的 KB 数据**（hlyy·audit）。

## 类型
逻辑/行为调整（沉淀口径变化）→ 涉及 spec（FS-04 AC-19-KB），起草 diff 待人拍板；不合并。

## 根因
- 前端 `public/field.html` 沉淀按钮只发 `chat.lastQ`/`chat.lastA`——`lastQ/lastA` 在 reopen 时是「从后往前取第一条 user/assistant」= **最后一轮**问答。
- 后端 `/api/kb-from-consult` 直接把 `b.q`/`b.a` 原样 `slice` 存进 KB，**不整理整段对话**。
- 结果：多轮咨询里，真正的**核心问题**（首个 user 提问）被丢掉，只留最后一个技术追问。

## 改法
### 后端 `server.mjs` `/api/kb-from-consult`
- 入参优先收 `{project, convId}`，**兼容旧的 `{project, q, a}`**（无 convId 回落原逻辑）。
- 有 convId：`src = CACHE.intakes[proj.id][convId]`，校验 `src && src.type==='consult' && !src.deleted`（否则 400）；取整段 `src.chat`（结构 `[{role,text,ts}]`，role∈`user|assistant|dev`）。
- **数据权限收敛**（原实现没收敛，顺手补上）：现场账号（非 `isAdmin`）只能沉淀自己 `user.sites` 内医院的咨询，`src.site ∉ sites` → 403；管理员不限。范式对齐 `intake-verify`/`intake-set-priority`。
- **AI 整理**：`readModelCfg()` 有 key 时用 `callModel`（非流式）把整段对话拼成 user/assistant 文本传进去，system 提示「整理成一条经验库条目，输出严格 JSON `{q,a}`：q=**核心问题**（一句话，抓真正要解决的那个，非最后一个追问）；a=**最终解决方案/结论**，涵盖整段排查脉络（核心问题→关键排查→最终定位与解法）」。正则抓首个 `{...}` JSON、解析拿 `q/a`。
- **兜底**（无 key / AI 失败 / 解析失败）：`q=chat 第一条 user 文本`（核心问题，非最后一句）、`a=最后一条 assistant 文本`——比原「只取最后一轮」强，Q 至少是核心问题不再丢。
- 存 KB：复用 `loadKB`/`saveKB` + 现有条目结构（`from:'consult'`、`at`、`tags:[]`、`q.slice(0,400)`、`a.slice(0,2000)`）；**`subsystem` 取 `src.subsystem`**（原写空，顺手带上更准）。返回 `{ok:true}`。

### 前端 `public/field.html`
- 沉淀按钮改发 `{project: archive.project, convId: chat.convId}`；`chat.convId` 为空（异常兜底）时回落发 `{project,q,a}`（后端兼容）。成功后照旧置「已沉淀到经验库」禁用 + 反馈。

## 处理现网那条已沉淀错的 KB（hlyy · audit）
- 错条目 `k861b458a`：Q=「打开控制台发现socket连接失败了，最后定位到端口没有通」（只抓最后一轮）。
- 源 consult：`hlyy` / `ZX-20260806-02`（安吉县人民医院 · audit · 2026-08-06 11:59，title「合理用药5级处方进去审方系统，但是药师没有收到任务」，chat 6 条含 socket 那段）。
- 用修好后的逻辑对该 consult 整段 chat 重新生成 → 新条目 `k4fc9f998`：
  - **Q（核心问题）** = `药师未收到审方任务的根本原因排查与解决。`（不再是最后的 socket 追问）
  - **A（全脉络）** = 现象（处方已上送、方案匹配、开关开着但没任务、日志报无在线药师）→ 核心定位（前端 UI 与 Redis 在线状态不同步）→ 链路断裂点（WebSocket 端口不通 → WS 握手失败 → Redis 未写在线 Key → 报无在线药师）→ 5 步解决（核对 WS 地址 / Nginx 升级头 / 网络连通性 / 后端监听 / 关开审核开关重建 Key）。
  - **subsystem** = `audit`（原写空，现从 `src.subsystem` 带上）。
- 删旧 `k861b458a`、保留新 `k4fc9f998`；MySQL `kb_entries` + `data/kb/hlyy.json` 双写同步 + `docker restart intake-app` 重载 CACHE。旧 KB 已 `.bak` 备份留 prod（`hlyy.json.bak-20260806-122017`）。

## 验证（prod · 容器 intake-app · 127.0.0.1:5180）
- **① 真跑新逻辑**（`POST /api/kb-from-consult {project:'hlyy',convId:'ZX-20260806-02'}`，wanglong impl 会话 · 真 DB + 真模型）→ `{ok:true}`；生成 Q=**核心问题**（药师未收到审方任务）、A **涵盖**从核心问题到 socket 端口的完整排查脉络（见上）——不再只有最后一步。
- **② 旧错条目已删、新条目入库**：`kb-search?all=1&project=hlyy` 与 `?q=药师&project=hlyy` 均只返回 `k4fc9f998`；DB `q LIKE '%打开控制台发现socket%'` 计数=0。health `kb:1`。
- **③ 向后兼容**：不带 convId 的老调用 `{project,q,a}` 仍能存（`kbf5996e1`，测后已删）。
- **清理**：smoke 造数（`SMOKE_COMPAT_Q`）已从 MySQL DELETE + 从 JSON 重建 + restart 清 CACHE；最终 prod KB 只剩 `k4fc9f998` 一条，DB 与 JSON 一致。

## 未动
`consult` 落库逻辑（`/api/consult`）、`kbAddFromIntake`（工单自动沉淀）、`kb-search`/`kb-list`/`kb-save`/`kb-delete`、`loadKB`/`saveKB` 存储实现、条目结构与截断长度、其它 field 端点、AI 流式答疑链路。
