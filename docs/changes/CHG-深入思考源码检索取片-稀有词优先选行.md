# CHG · 深入思考源码检索「取片窗口」按稀有词优先选命中行（第三层修复）

- **日期**：2026-08-06
- **来源**：用户指派——修「深入思考」源码检索**第三层 bug：取片窗口选错行**（排序层 54e13f8 / 提示词层 19611aa 已修，端到端真跑时喂给模型的片段仍不含答案行）。
- **spec**：FS-06（深入思考·源码检索）。**行为意图不变**（本就该把判别性答案行喂给模型），属实现缺陷 → **纯 bug 修复，不改 spec**。
- **范围**：只改 `server.mjs` 的 `codeSearch` **取片阶段**（收集 `lineTerms` + 选行策略）。**未碰**排序（`scoreOf` 稀有词加权 54e13f8）、白名单（`OK`/`SKIPDIR`）、`ref`/跨仓回退、文件数 `slice(0,n)`、调用处、提示词、返回结构（仍 `{file,text}`）。新增逻辑测试 `tools/code-search-snippet.logic.test.mjs`。

## 类型
纯 bug 修复（取片窗口选错行），不涉 spec（FS-06 行为意图不变）。CHG 记一条。

## 根因（第三层，独立于排序/提示词）
`codeSearch` grep 命中后，旧收集把命中行按 **grep 顺序**（一个词一个词）塞进 `f.lines`（Set，`size<40` 封顶）；取片时窗口按**行号升序**拼、`snip.length>1500` break、`slice(0,1600)` 从**文件顶部**截。
→ 大众词（如「医嘱」命中该文件几十行）先把 40 行/字符预算占满，**判别性稀有词命中行（连同 ±6 窗口）被挤出片段**。
实例：query「医嘱列表中的药品说明书在哪里配置」，pwrs `pwrs-admin/src/views/patient/intervention.vue` 排序已到 top-1，但答案行 `content="查看药品说明书"`(L301)、`onDrugPath`/`$openUrl`(L1608~1612) 相距 ~1300 行、落在文件靠后 → 旧取片截不到，模型自然引用不到。

## 改法（`server.mjs` codeSearch，L561~618）
1. **收集阶段**：`f.lines`(Set) → `f.lineTerms`(Map(行号→命中它的词集合))，记「每个命中行被哪些词命中」（防信息不足以区分行判别性）；每文件行号封顶 400（防超大文件爆内存）。
2. **选行阶段**：每行判别性 = `lineWeight(ls)` = 命中它的词里的**最高** `weight(t)`（同排序阶段的 IDF 式加权，同函数作用域复用 `weight`/`df`）。候选命中行**按行判别性降序**排，优先把高权重（稀有词/英文标识，如 `药品说明`/`onDrugPath`）命中行连同 **±6 窗口强制选进预算**；预算（40 行 / 字符 2200）用满后大众词行才补。字符预算 1600→**2200**（容纳相距较远的两处判别性窗口，如 L301 与 L1608），未无节制放大（deep maxTokens=1100，4 文件仍受控）。
3. **呈现**：仍按**文件行号升序**、相邻窗口合并、不相邻处插 `…`（可读性与旧版一致）。返回结构 `{file,text}`（含 `f.ref`）不变。

## 验证
- **本地逻辑测试**（`tools/code-search-snippet.logic.test.mjs`，`node --test`，不依赖 MySQL，1:1 复刻取片算法——同 `code-search-rank.logic.test.mjs` 做法，两处如改需同步）：真 git 仓造「同一文件内频率倾斜」——顶部 60 行大众词「医嘱/列表」、中部一行 `content="查看药品说明书"`、尾部一行 `onDrugPath`/`$openUrl`。**3 用例全绿**：① 修复后取片 `text` **同时含**那两处稀有词行；② 反证旧取片（顶部封顶40+slice1600）尾部 `onDrugPath` 被挤出；③ 片段行号升序 + `…` 间隔。
- **prod 直调 `codeSearch`（vm 提取·真 pwrs 仓·`2.7.260729-4`）**：**不给 specHits** 时 intervention.vue 排 top-1，取片 `text`(len=1325) **同时含** `content="查看药品说明书"` + `async onDrugPath(row)` + `this.$openUrl(...this.config.value)` ✅（证明取片修复本身有效，达成硬指标）。

## ⚠️ 端到端仍不引用 —— 暴露第四层（文件排序层·specHits 注入·**非本次范围**·待人裁决）
prod 真跑 `/api/consult`（deep）答复**仍未引用** onDrugPath。诊断（vm 完整复刻 consult 检索链 specSearch→codeSearch）实锤：
- **不带 specHits**：intervention.vue 排 **#1**（score 4.493，命中 `药品说明,品说明书,医嘱,列表,药品…` 10 词）→ 取片修复能把答案行喂进去。
- **带真 specHits**（`/api/consult` 实际走这条）：intervention.vue **跌到 #12**（score 2.524，只剩 `药品说明,品说明书` **2** 词），被一堆 mapper XML（`DMPwrsMonitoringDrugMapper.xml` 等）挤出 top-4 → **取片层根本轮不到执行**。
- **机理**：本 query 的 specSearch 召回的是**跑题**的 spec 段（重点监控/患教/收费），注入表名 term（`pwrs_monitoring_drug_screen`/`pwrs_edu_chart`/`drug_code`/`drug_name`…全是 `isIdent` → 特异性 100+）；`termList` 上限 24 + 按特异性排序 → 注入的表名 term **把 query 自身的中文 bigram（医嘱/列表/药品）挤出 24 预算**，intervention.vue 丢掉那些命中、得分崩塌，mapper 文件（匹配注入表名）反超。
- **结论**：这是**文件排序层**（term 预算被 spec 注入词挤占 + specSearch 召回跑题）的问题，**明确在本次「只改取片、别动排序」范围之外**，需人裁决修法（如：query 原生 term 保底进预算、限制注入 spec term 数量、或 specSearch 召回质量）。本次**未改动排序层**（54e13f8 保持原样）。

## 未动
排序 `scoreOf`/`weight`/`termList` 构造与预算、白名单 `OK`/`SKIPDIR`、`ref`/跨仓回退、文件数、调用处、`consultSystem` 提示词、返回结构。
