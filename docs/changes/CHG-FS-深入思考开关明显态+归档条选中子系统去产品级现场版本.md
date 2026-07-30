# CHG-FS · 实施端 field.html 两处修（深入思考开关明显态 + 归档条选中子系统去产品级现场版本）

- **日期**：2026-07-24
- **来源**：用户 2026-07-24 反馈（实施端 `public/field.html` 两处观感/逻辑问题）
- **spec**：问题①=FS-06（AC-C10 深入思考开关）；问题②=FS-03 AC-18（医院视图归档条现场版本模型）
- **范围**：只改 `public/field.html`（样式 + `renderHospChip` 显示）+ fs-02/03/06 相关测试断言。**未碰** `server.mjs` / `assets/ui.js` / 其它页 / 任何已改逻辑（per-system 会话 / 咨询必选守卫 / reopen / 子项目下拉 / subsystemLabel / 按批次降级 / 深入思考发送逻辑本身）。

## 问题①：「深入思考」开关选中态不明显 —— 样式微调（不涉 spec）
- **类型**：纯样式调整（`.f-deep.on` 高亮增强），行为不变 → **不改 spec**，CHG 记一条。
- **现状**：`.f-deep.on` 用浅主色底（`--color-primary-light` + 主色描边 + 主色字），与 off 态（中性描边）对比太弱，用户看不出开关是否开启。
- **改法**（`field.html` L241）：`.f-deep.on` 改为**实心主色底 + 白字 + 主色描边 + 轻阴影**——`background:var(--color-primary); color:#fff; border-color:var(--color-primary); box-shadow:0 1px 3px rgba(15,39,68,.22)`；`.f-deep.on .ti` 图标转白；新增 `.f-deep.on:hover` 锁住 hover 不回退成主色字。off 态保持轻量中性（未动）。复用 theme token `--color-primary`（藏青 #0F2744），未打乱工具条布局。一眼可辨开关开/关。
- **未动**：`syncDeep` 显隐/高亮逻辑、`toggleDeep`、`chat.deep` 状态、per-system 快照/草稿/新对话重置、`sendConsult` 带 `deep` 的发送逻辑本身、`server.mjs` 的 `b.deep` 检索分支——全部不改。

## 问题②：医院视图归档条选中子系统后不该再显产品级「现场版本」 —— 显示逻辑修正（涉及 FS-03 AC-18）
- **类型**：归档条显示逻辑修正（`renderHospChip` 显示分支），修正一个逻辑不对的展示 → **涉及 spec**（改 FS-03 AC-18），已起草可审 spec diff（见下）。
- **现状（bug）**：`renderHospChip` 无论是否选中子系统，都在末尾拼 `· 现场版本：<各产品版本并列>`。选中「报表系统」时归档条显示成「🏥 安吉县人民医院 · 系统：报表系统 · 现场版本：合理用药 —」——系统已选定具体子系统，后面还挂个产品级「现场版本：合理用药 —」，冗余且逻辑不对。
- **改法**（`field.html` `renderHospChip` 两分支）：
  - **分支①（`state.curSub` 非空，选中具体子系统）**：chip = `🏥 <医院> · 系统：<subLabel(curSub)> · 版本：<subVersion(curSub) 或 —>`，函数内 **early-return**，**不再拼产品级「现场版本」列**。版本取 `subVersion(curSub)`（该医院该子系统维护的版本；新形状按子系统查、旧形状兜底产品级 `version`；空显「—」）——`subVersion` 复用已有（子系统+版本 特性加的 name→version 映射）。
  - **分支②（`state.curSub` 为空，全部子项目）**：**保持现状**——`🏥 <医院> · 现场版本：<各产品版本并列>`（新形状列各子系统各自版本，旧形状列产品级；无医院/无产品占位不变）。
- **过滤/归档取值不动**：`currentArchive` 的 `out.version`（选了子系统仍取 `subVersion(curSub)`）、`loadSubmissions` 的 `&subsystem=state.curSub`（英文 name 匹配 `intakes.subsystem`）均未改——本次**只改 `renderHospChip` 归档条显示**。
- **系统视图 `renderSysChip` 不动**——它本就是「产品·子系统·版本▾」运营 tag 模型，无此冗余。
- **目标达成**：选「报表系统」→ 归档条 = 「安吉县人民医院 · 系统：报表系统 · 版本：<报表系统版本或—>」，不再有「现场版本：合理用药 —」。

## spec diff 摘要（FS-03 AC-18 · 待验收拍板）
- AC-18 headline：从「chip=`🏥 医院〔·系统…〕·现场版本：<…>`」→ **按是否选中具体子系统分两种形状**（`renderHospChip` 两分支）。
- 新增「问题② · 选中具体子系统」子条：显「系统：<subLabel> · 版本：<subVersion>」、early-return、**不挂产品级现场版本**（原「选中子系统仍挂现场版本」标注为 bug，本次修正）。
- 保留「未选子系统」子条：显「现场版本：<各产品版本并列>」（新/旧形状兜底不变）。
- 保留「`currentArchive` 归档取值不变」子条：仅改 `renderHospChip` 显示，过滤/归档 version 逻辑不动。
- 原 2026-07-23 问题①口径（选中子系统仍保留产品级现场版本列 + 插一段系统段）**标记作废**（被问题②覆盖调整）。

## 测试
- `tools/fs-02.test.mjs A2c`：更新为新两分支格式——截取 `if (state.curSub){…return;}` 块，断言含「版本：」+ `subVersion(state.curSub)` 且 **不含「现场版本」**（`doesNotMatch`）；未选子系统态整体仍含「现场版本：」。既有「selectSub 调 updateCtx」「subLabel 中文名」断言保留。
- `tools/fs-06.test.mjs A-CTX`：renderHospChip 选中子系统分支断言含 `subVersion`+「版本：」、不含「现场版本」。
- `tools/fs-06.test.mjs A-DEEP1`：新增静态断言锁 `.f-deep.on` 明显态（`background:var(--color-primary)` + `color:#fff`）。
- `tools/fs-03.test.mjs A6`：既有断言 `renderHospChip[\s\S]{0,600}\.products` 放宽窗口至 1200（因选中子系统 early-return 分支前置、产品级现场版本列后移）——仍限 `renderHospChip` 内，语义「现场版本来自 customers.products」不变。
- A7/A7b（fs-03）未破坏（renderHospChip 仍含 subVersion + 新形状分支、仍不调 /api/versions）。

## 验证
- field.html：隐形字符 **0**、`localStorage` 字面量 **0**、内联 JS `new Function` 语法 **通过**、FS-01 A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）**各 0**。
- 回归：`node --test --test-concurrency=1 tools/fs-02.test.mjs tools/fs-03.test.mjs tools/fs-06.test.mjs tools/fs-04.test.mjs tools/fs-01.test.mjs` → **143 pass / 0 fail**。
- 真库无残留：测试用隔离产品 id（`fs06smoke-*` 等）+ after 精确删；核对 `intakes/projects/kb_entries` 测试前缀残留 **各 0**。

## 风险
- 极低。样式仅动 `.f-deep.on`（3 行 CSS）；逻辑仅动 `renderHospChip` 的显示分支（不改数据取值/过滤/归档）。系统视图、`currentArchive`、`server.mjs` 全未触及。
