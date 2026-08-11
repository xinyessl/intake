# CHG · consult 答疑 —— 检索到的规格/经验未真正覆盖用户问的那个点时，一句话说没覆盖（禁硬编排查步骤）+ consult 经验库注入二次收紧门槛

- 日期：2026-08-11
- 关联 spec：无（提示词规则强化 + KB 注入门槛收紧）。答疑「据证据作答、未覆盖不臆造」的 spec 意图本就如此（FS-06/PD-02/PD-04 均要求禁臆造），是模型没落实到「沾边但不覆盖」这个边界 + 全局召回门槛把 0.42 边缘条目也注入了。判定为 **逻辑/行为强化**，非结构变更；若人认为需补一条回归 AC 到答疑 spec（「检索命中但未真正覆盖用户问的点 → 只回一句没覆盖」），可另起 draft，本 CHG 先留痕。
- 类型：逻辑/行为调整（提示词规则 + KB 门槛），**不改库、不改接口契约、不改 SSE 事件结构**。
- 改动文件：`prompts.mjs`（consultNormal/consultDeep 默认值）、`server.mjs`（consult KB 二次门槛）、`tools/pd-02-prompts.logic.test.mjs`（逐字断言同步）、`tools/consult-kb-gate.logic.test.mjs`（新增）。

## 现象（用户真实反馈 + 已回放确认）
问「检验报告中，没有异常值的箭头标志是什么问题」：
- 路由 tier-1 命中**沾边但不覆盖**的路由 QR-DQ-005「检验搜索不到」(9.996)——它讲检验数据搜不到、**不讲异常值箭头显示规则**。
- 经验库命中「医嘱干预配置药品说明书跳转」(sim=0.42，正好卡全局 SEM_GATE)——**和问题毫无关系**却被注入 + 引用。
- 结果 AI 没老实说「没覆盖」，反而**凭常识编了一大段 4 步排查**。
用户要求：**检索到的规格/事实并未真正覆盖用户问的那个具体点 → 只回一句明确「当前说明书摘录没有覆盖【该具体问题】」（可加一句建议转工单/联系开发）即可，禁止凭常识编排查步骤/可能原因**；且**不相关的经验库不要引用**。

## 修复 1 —— 提示词：没直接覆盖就简洁说没覆盖，别硬编（核心）
`prompts.mjs` 的 `DEFAULT_PROMPTS.consultNormal` / `consultDeep`（PD-02 可编辑提示词的默认值）在「规则：」区**首条**新增一条最高优先强规则：

- 回答前先判断上面给的「相关规格摘录」（deep 另含「源码片段」）+ 经验库条目**是否直接回答了用户问的那个具体问题**（不是同子系统/同模块沾边、不是相关话题，而是真的讲到了用户问的那个点/机制/规则/显示逻辑）。
- **若没有直接覆盖**（只沾到同域没讲到具体点、或摘录/源码主题与问题不符）→ **只回一句**：明确说「当前系统说明书摘录（deep：/源码）里没有覆盖【用户问的那个点】」，可再加一句「建议转成工单或联系开发确认」。**禁止**凭常识/经验编排查步骤、可能原因、配置项、开关名、接口或表/字段。
- **只有确实覆盖了这个具体问题**，才按原有方式据摘录/源码/经验作答。

放在规则最前、加粗「【最高优先…】」提高优先级与醒目度。deep 版同理（把「源码片段」并入判断对象；未覆盖也照此简洁说没覆盖）。**其余规则一字未动**；`{{specExcerpts}}`/`{{codeExcerpts}}`/`{{kbBlock}}` 等必需占位保留。

- **逐字回归同步**：`tools/pd-02-prompts.logic.test.mjs` 的参照实现 `refConsultSystem`（deep/normal 两分支 `styleRules`）同步加同一条首条，保持「renderPrompt(默认) === 参照原文」逐字断言（17 用例全绿，含 100+ 组合的 consultSystem 逐字断言）。

## 修复 2 —— consult 经验库注入二次门槛（别引不相关经验）
不动全局 `SEM_GATE=0.42`（护住 kb-search drawer / intake-chat / 跨产品 kb-search 的默认召回口径），只在 **consult 侧加二次过滤**：

- 新增常量（`server.mjs`）：
  - `CONSULT_KB_MIN_SIM = 0.5`（语义命中最低余弦；> 全局 SEM_GATE 0.42，剔除 0.42 边缘无关条目）；
  - `CONSULT_KB_MIN_LEX = 3`（纯词命中——语义不可用时——最少不同 query token 数；> consult 现召回门槛 2，弱词匹配也不引）。
- 新增 `consultKbStrong(x)` / `consultKbFilter(kbScored)`：kbScored 元素 `{e,score,matchedTerms}`，`score`(rank) 语义可用时 = `sim + 微量 lex 加权(≤~0.012)` ∈ [0.42, ~1.01]、语义不可用时 = `lex`(整数 ≥2)。故 **`score<1.1` ⇒ 语义分**（判 `sim≥0.5`）、**`score≥1.1` ⇒ 纯词计数**（判 `matchedTerms.length≥3`）。
- consult 端点接线：**保留** fs-06 断言的原行 `try { kbScored = await kbRetrieveScored(proj.id, qtext, 5, 2); hits = kbScored.map(x => x.e); } catch {...}`（结构不动 → fs-06 B-KB-REL4 断言不破），**紧接一行** `hits = consultKbFilter(kbScored).map(x => x.e);` 把「喂模型 + kbRefs」的 `hits` 收敛为强相关子集。
  - `hits` 弱→空 ⇒ `consultSystem` 走「本次未检索到相关经验库条目」话术、`kbRefs` 空、不发 kb 事件、`kbInjected=false`、`done.kbHits=0`（=「本次无相关经验库」，与 lsy 的 kbRefs 首 token 门控完全一致，未破坏）。
  - **`kbScored`（全召回）保留原样给 `buildRetrieval` 检索诊断**——「召回了但太弱没注入」本身是排查信息，PD-03 检索诊断页仍看得到。

### 阈值取值理由（保守·宁可少引也别引错）
- `CONSULT_KB_MIN_SIM=0.5`：bug 案例 sim=0.42（正好卡全局门槛）→ 剔除；实测「不相关文本 cosine≈0.23、边缘沾边≈0.42、真覆盖≥0.55」，取 0.5 把 0.42 边缘挡住、又不误伤 0.55+ 的真相关。
- `CONSULT_KB_MIN_LEX=3`：consult 召回本就 minScore=2（≥2 个不同 token），收到 3 进一步排掉「只蹭 2 个常见 bigram」的弱词匹配；对 fs-06 REL 种子（强相关条 lex=11~14）无影响。

## 修复 3（未做，靠修复 1 兜底）
路由 tier-1「沾边不覆盖」（QR-DQ-005 之于箭头显示）**不改路由算法**（term 重叠是真实的、动阈值会误伤真命中）。答疑 specExcerpts 已带命中模块的 `《subsystem·module｜title》`，AI 有足够上下文判「是不是我问的」；再叠修复 1 提示词兜底（未真正覆盖→简洁说没覆盖）。未额外注入 route.title/businessPath（避免动 PD-04 route/context 构建路径，收益边际、风险不对等）。

## 测试
- `node --check server.mjs` + `node --check prompts.mjs`：通过。
- 全量 `tools/*.logic.test.mjs`：**326 pass / 0 fail / 6 skipped**（新增 8 例；pd-02 17 绿·逐字不漂移、fs-06-consult-kb-evidence 6 绿·kbRefs 门控不破、pd-03/pd-04 绿）。
- 新增 `tools/consult-kb-gate.logic.test.mjs`（**抠 server.mjs 真身** consultKbStrong/consultKbFilter + 真实 kbTokenize）：
  - bug 复现：sim=0.42「说明书跳转」vs「异常箭头」→ 被过滤（0 条注入）；sim=0.6 真覆盖 → 保留；
  - 语义边界 0.5 留 / 0.49 剔；纯词 <3 剔 / ≥3 留；
  - **与 fs-06 连真库冒烟同口径**：复刻 REL1（弱匹配单词命中掉、kbHits=1）、REL2（两条都多 token 命中 → 都留、kbHits=2，门槛不误伤真相关）。
- 连真库冒烟：本机无本地 MySQL（真库在云端 Docker，`data/db.json` 指 127.0.0.1:3306 未起），fs-06.test.mjs 的 B-KB-REL 活库断言未在本机跑；已用「抠真身 + 真实 REL 种子 lexical 复刻」证明 REL1/REL2 结论不变（fs-06 两条强相关 lex=11~14 远大于新门槛 3，kbHits=1/2 不受影响）。部署后可在容器内跑 fs-06.test.mjs 或对真库塞两条 KB 复验。

## 风险 / 说明
- 提示词纯措辞新增（首条强规则），未删任何原规则/占位；deep/normal 逐字回归 100+ 组合断言通过，行为不漂移。
- KB 门槛只在 consult 二次过滤，**全局 SEM_GATE 与 kbRetrieveScored 召回口径不变**（drawer/intake-chat/跨产品 kb-search 默认门槛不受影响；fs-06 B-KB-REL4「仅 consult 口径两处传 minScore=2」断言仍绿）。
- 语义不可用（未配 embed）时纯词门槛从 2 收到 3：极端场景下「只蹭 2 个常见 bigram」的条目不再注入——这正是「不引不相关经验」的目的；真相关条目 token 命中通常远多于 2（REL 种子 11~14），不误伤。
- 未 commit、未部署（按任务要求）。
