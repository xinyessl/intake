# CHG · 深入思考(deep-think)源码检索排序 —— 稀有词 IDF 加权 + 词预算按判别性排序

- 日期：2026-08-05
- 关联 spec：无（纯 bug 修复 · 检索质量，行为契约不变、spec 是对的，无需同步）
- 类型：纯 bug 修复（检索排序）
- 改动范围：仅 `server.mjs` 的 `codeSearch(proj, ver, query, specHits, n, subKey)`（约 L543~605）+ 新增测试 `tools/code-search-rank.logic.test.mjs`

## 一句话
「深入思考」咨询答疑从克隆的产品源码里 git grep 出几段代码喂 AI；旧实现两个叠加 bug 让判别性最强的稀有词源码文件排不进 top-n，真答案被「蹭一堆大众词的泛词大页」压掉。改为**词按特异性排序再截断 + 文件排序按稀有词 IDF 式加权**。

## 已诊断根因（两个叠加 bug）
1. **词预算顺序错**：旧 `[...terms].filter(t => t.length >= 2).slice(0, 18)` —— 未排序即截断，中文 2-gram 先占满 18 名额，判别性最强的 4-gram（`药品说明`/`品说明书`）和英文标识被 slice 截掉。
2. **排序维度错**：旧 `sort((a,b) => b.terms.size - a.terms.size || …)` —— 按「命中的不同词种类数」排，蹭到一堆大众词（医嘱/列表/配置/药品）的泛词大页压过只含稀有词「说明书」的 `orders.vue`/`intervention.vue`。

## 改了什么
1. **词按判别性排序再截断（预算 18→24）**：截断前按特异性降序排。特异性打分 `spec(t)`：英文标识 `/[A-Za-z_]/`（表名 `x_y`、接口路径段、驼峰方法名）给 `100+len` 高分；中文 n-gram 按长度 `len`（4-gram > 2-gram）。→ 判别性 4-gram / 英文标识一定进预算，不被大众 bigram 挤掉。
2. **文件排序改稀有词 IDF 式加权**：
   - 复用同一次 grep 的结果，统计每个词的**文档频率 df**（命中它的不同文件数，跨本次 grep 的所有仓）。
   - 词权重 `weight(t) = lenBonus(t) / Math.log2(2 + df[t])`——稀有（df 小）权重高、常见（df 大）趋 0；`lenBonus`：英文标识×3、4-gram×2、bigram×1。
   - 文件得分 = 命中各词 weight 之和；`sort` 按得分降序，次级按命中行数 `lines.size` 降序。
3. **（次要）子系统收敛后本子系统加权 top 得分文件 < 2 → 回退全部子系统再 grep 一遍**：跨仓时各仓 tag 不同（pwrs 有 `2.7.260729-4`，kwsb/adr/ysmz 只有 `2.7.260723-1`），**对非当前子系统用无 ref（工作树/HEAD）grep**，避免 `git grep <不存在的tag>` 失败返回空。文件对象记 `f.ref`，取片时按各自 ref 读正文。
4. 其余全部不变：`OK`/`SKIPDIR` 过滤、`subKey` 子系统收敛、±6 行窗口取片、`slice(0, n)` 返回条数、返回结构 `{file, text}` 不变。

## 本例前后 top 对比（prod 真仓 pwrs @ `2.7.260729-4`，query「医嘱列表中的药品说明书在哪里配置」）
词频倾斜（df）：`说明=28 明书=4 药品说明=1 品说明书=1` vs 大众词 `医嘱=120 药品=168 列表=265`。

- **FIXED top6**：① `pwrs-admin/src/views/patient/intervention.vue`(4.49) ② `tablet/pages/patient/info/orders.vue`(2.21) ③ `PatientService.java`(1.68) ④ `education-addMedicines.vue`(1.62) ⑤ `riskearly.vue`(1.62) ⑥ `ScheduledTask.java`(1.60)
- **OLD top6**：① intervention.vue ② orders.vue ③ `AsyncService.java`(泛词大页,score 仅 1.04) ④ `order.vue` ⑤ PatientService.java ⑥ riskearly.vue —— 泛词大页 AsyncService/order 靠 terms.size 挤进前列、压掉真正判别性更强的文件。
- 真答案代码确认落在 top-2 文件的 ±6 行窗口内：`intervention.vue:301 content="查看药品说明书"`、`orders.vue:305 orderOpen: {} // 说明书`。

## 逻辑测试（`tools/code-search-rank.logic.test.mjs`，`node --test`，无需 MySQL/server）
临时 git 仓造「频率倾斜」样本：`target.vue`/`judgeword.vue` 含稀有词「药品说明书」+ 英文标识 `openDrugInstructionConfig`（df 极小）；2 个泛词大页 + 12 个噪音文件塞满大众词（医嘱/列表/药品，df 大、terms.size 高）。断言：
- 词预算按特异性排序：英文标识排预算首位、判别性 4-gram（`药品说明`/`品说明书`/`说明书在`）一定进预算。
- **FIXED**：两个稀有词答案文件浮到 top-2，排在所有泛词大页/噪音之前。
- **反证 OLD**（terms.size 排序）：泛词大页/噪音填满 top-6，两个真答案文件被挤出 —— bug 真实复现。
- 回退用无 ref（工作树/HEAD）grep 同样命中答案文件。
- 结果：3/3 绿。

## 部署
- `server.mjs` 已 scp 覆盖到 prod 宿主 `/opt/intake/server.mjs`（bind-mount），`docker restart intake-app` 生效，日志无报错；旧文件备份为 `/opt/intake/server.mjs.bak-codesearch-<ts>`。

## 风险 / 说明
- 纯排序调整，不改接口/返回结构/取片逻辑；对不含明显稀有词的 query 行为与旧版趋同（此时无稀有信号可依，退化为长度加成）。
- df 统计基于本次 grep 命中的文件集合（非全库统计），对本场景（几十个 term × 几个仓）足够区分稀有/大众；量级小，性能无感。
- `codeSearch` 未 export 且 import `server.mjs` 会启服务/连 MySQL，故逻辑测试 1:1 复刻同一算法；两处如改需同步。
