# CHG · 深入思考源码检索「词预算被 spec 注入词中毒」修复（第四层）

- **日期**：2026-08-06
- **来源**：用户指派——修「深入思考」源码检索**第四层 bug：词预算被 spec 注入词中毒**（排序 54e13f8 / 提示词 19611aa / 取片 5cc8079 前三层已修上线；端到端真跑 deep consult 仍不引用答案文件的 `onDrugPath`/`$openUrl`/`config`）。这是端到端卡住的真正原因（另一 dev 端到端排查实锤 + 上一条 CHG-取片 已诊断出、标「待人裁决·非取片范围」）。
- **spec**：FS-06（深入思考·源码检索）。**行为意图不变**（本就该让 query 自身判别性词主导检索、答案文件排 top），属实现缺陷 → **纯 bug 修复，不改 spec**。
- **范围**：只改 `server.mjs` 的 `codeSearch` **词表构建 + 打分权重**（分源建词 / 预算保底 / spec 注入词降权）。**未碰**取片/grep（5cc8079 稀有词优先选行）、文件排序框架、跨子系统回退、`OK`/`SKIPDIR`、`ref`、返回结构（仍 `{file,text}`）、调用处、`consultSystem` 提示词。新增逻辑测试 `tools/code-search-specterm.logic.test.mjs`。

## 类型
纯 bug 修复（词预算被 spec 注入词中毒），不涉 spec（FS-06 行为意图不变）。CHG 记一条。

## 根因（第四层，独立于排序/取片/提示词）
`codeSearch(...,specHits,...)` 会把 `specSearch` 召回段里的表名/接口路径当 term 注入。旧实现把**两类词塞进同一个 `terms` Set**：① query 自己的词（中文 bigram/4-gram + query 英文标识）；② spec 注入词（从 `specHits` 正文正则抽的表名 `x_y` / 接口路径段）；再统一 `sort((a,b)=>spec(b)-spec(a)).slice(0,24)`，`spec()` 给**所有英文标识 100+ 分**。
→ 当 `specSearch` 召回**跑题**的 spec 段（本 query 召回「重点监控/患教/收费」而非「说明书」），其注入的稀有英文表名（`pwrs_monitoring_drug_screen`/`drug_code`… 全 `isIdent` → 特异性 100+）**排到 24 词预算最前，把 query 自身判别性中文词（说明书/药品说明/医嘱/列表）挤出预算**。
→ 答案文件 `pwrs-admin/src/views/patient/intervention.vue` 命中词从 10 掉到 2、加权得分从 #1 崩到 #12，被匹配注入表名的 mapper XML 挤出 top-4，**取片层根本轮不到执行** → 端到端模型收到无关 XML、引用不到 `onDrugPath`。

## 改法（`server.mjs` codeSearch，L543~602）
**核心原则**：query 自己的词是主信号，永远优先、满权重；spec 注入词只是「中文问题→英文表名」的桥，次要——限量 + 降权，绝不许挤掉/盖过问题本身的词。
1. **分源建词**：query 派生词 `qSet` 与 spec 注入词 `sSet` 分成两组；`sSet` 去掉与 `qSet` 重复的（重复归 query 享满权重）。各源内部仍按特异性降序（英文标识/4-gram > bigram，这段逻辑对，保留）。
2. **预算保底**：`termList = [...qTerms(按spec排序).slice(0,20), ...sTerms(按spec排序).slice(0,4)]`（总仍 ~24；query 词拿大头，判别性 query 词——说明书/药品说明——必在预算内；spec 词只填剩余且限量 ≤4）。
3. **spec 词降权**：记 `specSourced = new Set(sTerms)`，打分时 `weight(t) = (specSourced.has(t)?0.5:1) * lenBonus(t) / Math.log2(2+df[t])`。即便某 spec 表名很稀有（高 IDF），也不盖过同样稀有的 query 词（说明书），off-topic mapper XML 就压不过真答案文件。**on-topic 的 spec 表名仍能进（≤4、降权后）继续发挥桥的作用**，未整个删掉。

## 验证
- **本地逻辑测试**（`tools/code-search-specterm.logic.test.mjs`，`node --test`，不依赖 MySQL，1:1 复刻词预算/打分算法——同 `code-search-rank/snippet.logic.test.mjs` 做法，三处如改需同步）：真 git 仓造「中毒场景」——真答案文件含判别性 query 词（说明书/onDrugPath/config），3 个 off-topic mapper.xml 各含跑题稀有英文表名（模拟 specSearch 召回跑题 spec 注入的表名）+ 蹭大众 query 词。**3 用例全绿**：① 分源后判别性 query 4-gram（药品说明/品说明书/说明书在）+ query 英文标识 onDrugPath 必进预算、spec 词限量 ≤4 且标 specSourced；② 修复后真答案 intervention.vue 排 **top-1**，反证旧混塞逻辑跑题表名占满预算（连 query 自己的 onDrugPath 都被挤出）→ off-topic mapper 排 top-1、真答案掉出 #1；③ 单点验证同稀有度下 spec 表名权重严格 < query 词（0.5× 系数生效）。既有 `code-search-rank`/`code-search-snippet` 两测**仍全绿**（共 9 用例 pass）。
- **prod 端到端真跑**（`/api/consult` deep · psp · `2.7.260729-4` · pwrs · query「医嘱列表中的药品说明书在哪里配置」· 自签 submit-link token 免登录打容器内 `127.0.0.1:5180`）：
  - **codeSearch 带真 specHits（含跑题的 重点监控/收费/患教 spec）→ intervention.vue 重回 top-1**（codeHits[0]），达成硬指标①（修复前是 #12、出 top-4）。
  - **端到端答复现在点名 `pwrs-admin/src/views/patient/intervention.vue`、引用 `config.open`/`config.value`、提到 `$openUrl()` 跳转拼接**，不再说「未收录说明书配置」/通用话术。
- 临时造数（consult `ZX-20260806-01/02`）已从 MySQL DELETE + 删 .md/.json + `docker restart intake-app` 清 CACHE；debug 注入已用干净 fixed 版覆盖回（md5 校验 `87a3f66…`、`grep -c deep-dump=0`）；host/容器探针已删。

## ⚠️ 端到端仍未字面出现 `onDrugPath` —— 暴露的是**取片层**残留（非本次范围），已交人裁决
prod dump `codeSearch` 返回片段实锤：intervention.vue **排 top-1**（本次修复达标），但其被喂给模型的 `text`(len=1346) **只含 L300~311 模板窗口**（`config.open`/`content="查看药品说明书"`/`@click="onDrugPath"` 图标块）、**不含 L1607~1610 的 `async onDrugPath(row){ this.$openUrl(...this.config.value) }` 方法窗口**——该方法行相距模板行 ~1300 行，取片选行时被同文件大量「医嘱/列表」大众词命中窗口（changeMedicalOrders/isToday 等）挤占预算。
- 这是**取片候选行选择层**（5cc8079 第三层）在**真实超大密集文件**上的残留（合成测试文件小、未暴露），**不在本次「只改词预算/权重」范围**。因此模型能点名 intervention.vue + config + $openUrl（从模板块推断），但拿不到 `onDrugPath` 方法体的字面 `this.$openUrl(...config.value)` → 未字面复述 `onDrugPath`。
- **判断**：第四层（词预算中毒）本次已**根治**（硬指标①达成、答复不再跑题/不再说未收录、真点名答案文件与 config/$openUrl）。残余「字面 onDrugPath」缺口属**第五层=取片在真实大文件上的窗口预算不足**（同一文件相距 ~1300 行的两处判别窗口挤不进 2200 字符 / 40 行预算），需人裁决单独治（如：同文件按判别性挑「若干处窗口」时对 top-1 文件放大字符/行预算、或对超大文件按判别命中行聚类多段）。**本次未动取片层。**

## 未动
取片 grep/选行（`lineTerms`/`lineWeight`/±6 窗口/字符 2200，5cc8079）、文件排序框架（`scoreOf` 结构）、`subKey` 跨子系统回退、白名单 `OK`/`SKIPDIR`、`ref`、文件数 `slice(0,n)`、调用处（consult L2105）、`consultSystem` 提示词、返回结构 `{file,text}`。
