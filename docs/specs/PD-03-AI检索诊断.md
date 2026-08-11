---
id: PD-03
title: AI 检索诊断（运营后台）
module: 运营后台 · AI 引擎
type: feature
source: 人工（实施现场答疑 AI 偏差排查需求）
prd: 无
contract: 本 spec §4 + docs/P0-数据模型对账与接口清单.md（现有 43 端点范式）
prototype: public/model-config.html / public/prompts.html（admin 页范式，事实源以 public/*.html 为准）
priority: Should
status: draft
owner_human: 待定
depends_on: [FS-04, KB-01, MC-01]
---

## 1. 用户故事 / 目标
作为**运营**，我要能看到「实施现场答疑（`/api/consult`）时 AI 到底取到了哪块内容」——检索到的 spec 片段 / 经验库命中 / 深入思考源码片段（含打分），逐条**标记排查**（对 / 跑题 / 缺失 / 该命中没命中 + 备注），并沉淀成「检索问题清单」，以便后续改检索 / 提示词。

## 2. 范围
- 包含：
  - consult 答题时把**实际喂给 AI 的检索内容**（紧凑 `retrieval` 对象）随对话记录落库（新对话立即生效）。
  - 对任意问题**重跑检索**做对比（回放）。
  - 内容三类：spec 片段（specSearch）+ 经验库命中（kbRetrieve）+ 深入思考源码片段（codeSearch），spec/kb 带打分透出。
  - 逐条**标记**（文件存 `data/retrieval-marks.json`）+ 聚合「检索问题清单」。
  - 运营端新页 `public/retrieval.html`（三块：对话诊断 / 回放 / 问题清单）+ 导航入口。
- 不包含：
  - 不改检索算法（specSearch/kbRetrieve/codeSearch 打分逻辑不动，只透出已算好的分）。
  - 不改 consult 的 kbRefs / 首片段门控 / 刷新恢复逻辑（在其上叠加）。
  - 不做历史 consult 回溯落 retrieval（仅新对话起生效；历史对话可用「回放」重跑对比）。

## 3. 验收标准（AC · Given-When-Then · 每条可自动化判定）
- **AC-1**（consult 答题落库 retrieval）Given 一次 `/api/consult` 答题算完 specHits/hits/codeHits，When 持久化该 consult 记录，Then 末条 assistant 消息带 `retrieval` 对象：`{query,deep,ver,subsystem,at, spec:[{subsystem,module,title,score,text}], kb:[{q,score,subsystem,module}], code:[{file,text}]}`；且**不破坏** kbRefs（kbRefs 仍按原逻辑挂同一条 assistant，两者并存）。
- **AC-2**（打分透出）Given specSearch/kbRetrieve 命中，When 构造 retrieval，Then `spec[].score`/`kb[].score` 为该片段/条目的真实检索得分（数值，越大越相关）；code 无分可省 score。
- **AC-3**（体积控制）Given 命中很多，When 构造 retrieval，Then 每类 cap（spec≤5、kb≤5、code≤4），text 截断（spec/code text≤300、kb q≤200），避免 chat JSON 膨胀；弱匹配/无命中/未 deep 时对应数组为空、照存。
- **AC-4**（回放）Given admin `POST /api/retrieval-replay {project,version,subsystem,query,deep}`，When 调用，Then 先 `refreshRepos(proj,false)` 再重跑 specSearch+kbRetrieve+(deep?codeSearch:null)，返回同 `retrieval` 结构（带分、附 `matchedTerms`）；project 不存在 → 400。
- **AC-5**（诊断列表 + filter）Given admin `GET /api/retrieval-log?project=&site=&subsystem=&marked=1&from=&to=&page=`，When 调用，Then 列出「有 retrieval 的 consult 对话」，每条含 meta（问题摘要 / 产品 / 医院 / 时间 / turn 数）+ 可展开的逐轮 `{question,answer,retrieval,marks}`；支持按 project/site/subsystem/仅看已标记/日期 filter；分页（默认每页 20，带 total）。
- **AC-6**（标记）Given admin `POST /api/retrieval-mark {recordId,project,turnIndex,hitType,hitKey,verdict,note}`（verdict∈{ok,offtopic,missing,should_hit_missed}，hitType∈{spec,kb,code}），When 调用，Then 存入 `data/retrieval-marks.json`（key=`recordId|turnIndex|hitType|hitKey`），带 `by`/`at` 留痕；非法 verdict/hitType → 400；空 note 允许。
- **AC-7**（问题清单）Given admin `GET /api/retrieval-issues?project=`，When 调用，Then 聚合所有**非 ok** 标记为「检索问题清单」（按 verdict / 产品 / 子系统分组），每条带对话回链（recordId/turnIndex/project）。
- **AC-8**（运营页三块 + 导航）Given admin 打开 `/retrieval.html`，When 页面加载，Then 有「对话诊断 / 回放 / 问题清单」三块（tab），对话诊断左列表右详情、三类检索块各带标记控件（即点即存）；shell.js「AI 引擎」组新增「AI 检索诊断」入口（挨着模型配置 / 提示词配置）。
- **AC-9**（admin 域鉴权）Given 非 admin（现场 impl/pm 或链接身份）访问 retrieval-* 端点或 `/retrieval.html`，When 请求，Then 被 authGate/originGate 拒（401/403/404）——不进 LINK_OK/FIELD_OK/FS08_FIELD_API/FS08_FIELD_PAGES。

## 4. 接口契约
> 全部 admin 域（不进任何 field/link 白名单，authGate 对非 admin 返 403/401）。返回结构沿用现有 `{ok,...}` / 直接 JSON 范式。

- `POST /api/retrieval-replay`（admin）
  - 入参：`{project, version?, subsystem?, query, deep?}`
  - 出参：`{ok:true, retrieval:{query,deep,ver,subsystem,at, spec:[{subsystem,module,title,score,text,matchedTerms}], kb:[{q,a?,score,subsystem,module,matchedTerms}], code:[{file,text}]}}`；`project` 不存在 → `400 {ok:false,error}`；`query` 空 → `400`。
- `GET /api/retrieval-log`（admin）
  - query：`project`（可空=全部产品）、`site`、`subsystem`、`marked`(=1 仅看已标记)、`from`/`to`（yyyy-MM-dd，按 submittedAt）、`page`（默认 1）、`size`（默认 20，上限 50）。
  - 出参：`{ok:true, total, page, size, items:[{recordId,project,site,subsystem,title,submittedAt,turnCount,markedCount, turns:[{turnIndex,question,answer,retrieval,marks:[...]}]}]}`。
- `POST /api/retrieval-mark`（admin）
  - 入参：`{recordId, project, turnIndex, hitType, hitKey, verdict, note?}`。
  - 出参：`{ok:true, mark:{key,recordId,project,turnIndex,hitType,hitKey,verdict,note,by,at}}`；`verdict`/`hitType` 非法 → `400`；`verdict==='clear'`（或空）→ 删该标记（撤销）返回 `{ok:true,cleared:true}`。
- `GET /api/retrieval-issues`（admin）
  - query：`project`（可空）。
  - 出参：`{ok:true, total, groups:{byVerdict:{[verdict]:[issue...]}, byProject:{...}, bySubsystem:{...}}, issues:[{key,recordId,project,turnIndex,hitType,hitKey,verdict,note,by,at}]}`（仅非 ok）。

## 5. 数据契约
> **对照真实库结构核对**（本项目 `db.mjs init()` 五表 + 文件存）。**不新增库表 / 库列**。

- **retrieval 捕获**：挂到 `intakes` 表 `type='consult'` 记录的 `chat` JSON（末条 assistant 消息的 `msg.retrieval` 字段）——`chat` 已是 JSON 列（同 kbRefs/media 范式，无需 ALTER），附加字段读出 `JSON.parse` 自带、老记录无该字段 = undefined 天然兼容。**紧凑 + cap + 截断**控体积（AC-3）。
- **标记存储**：**文件存** `data/retrieval-marks.json`（`/data/` 已 gitignore）——`{marks:{[key]:{...}}}`，key=`recordId|turnIndex|hitType|hitKey`（同 `model-api.json` 文件存范式，非 MySQL）。带 `by`（操作管理员 name）/`at`（nowStamp）留痕。
- 检索得分来源：specSearch 内部 `sc`（IDF 加权 chunk 得分）、kbRetrieve 内部 `rank`（`_kbScored` 打分）——**透出已算好的分，不改算法**。

## 6. 业务规则 / 非功能
- **权限**：全 admin 域（`isAdmin`：admin/dev）。四端点 + `/retrieval.html` 均不进 LINK_OK/FIELD_OK/FS08_FIELD_API/FS08_FIELD_PAGES → 现场 / 链接身份被 deny（AC-9）。这是运营排查工具，admin 全看（不按 sites 收敛）。
- **留痕**：标记带 `by`/`at`。
- **幂等**：同 `key` 再标记 = 覆盖（更新 verdict/note/by/at）；`clear` = 删除。
- **不破坏既有**：consult 的 kbRefs / 首片段门控（`kbInjected`）/ 水位线 / 刷新恢复 / per-message media 逻辑一字不改，retrieval 仅**叠加**到同一条 assistant 消息。
- **体积**：retrieval 每类 cap + text 截断（spec/code≤300、kb q≤200）——bound chat JSON，别撑爆 intakes.chat。
- **性能**：retrieval-log 分页 + 上限，避免全量拉爆。

## 7. 测试要点
- 逻辑测试 `tools/pd-03-retrieval.logic.test.mjs`（脱 MySQL）：
  - 抽真实 `buildRetrieval`/截断/cap 逻辑，断言结构、cap（spec≤5/kb≤5/code≤4）、text 截断（≤300/≤200）、弱匹配空数组照存。
  - 打分透出：specSearchScored/kbRetrieveScored 返回带 score。
  - 标记存取：写 mark → 读回 → 聚合 issues（仅非 ok）；clear 删除；非法 verdict/hitType 拒。
  - 回放结构：mock 检索函数验 retrieval 结构组装。
- 回归：`node --check server.mjs` + 全量测试全绿，**尤其 fs-06-consult-kb-evidence（kbRefs 首片段门控）、fs-04-* 不破坏**。
- 真库 / 真模型冒烟：由编排器部署后做（连真 consult 落 retrieval + admin session 打 retrieval-log/replay/mark/issues）。

## 8. DoD（完成定义）
- [ ] AC-1..9 自动化测试全通过
- [ ] `node --check server.mjs` 通过、全量测试全绿（含 kbRefs/consult 回归）
- [ ] retrieval 捕获体积 bound（cap + 截断）
- [ ] `data/retrieval-marks.json` 文件存、gitignored
- [ ] 运营页三块 + 导航对齐 admin 页范式、内部滚动无 body 滚动条
- [ ] 连真库 / 真模型冒烟通过（编排器部署后）
- [ ] 人类验收通过
