# PWRS Spec · Qwen-Max 严格 200 题最终评测

- 日期：2026-08-12
- 生产系统：intake · 系统视图 · 药师工作站
- 模型：生产实际 Qwen-Max 配置
- 严格全量版本：`2.7.260812-12`
- 最终修复版本：`2.7.260812-14`（PWRS commit `af653cd2`；intake commit `11cf68d`）
- 结论：**198/200，99.0%，达到 ≥99% 目标**
- 状态：实现与生产验证完成，保持 `doing / accept=wait`，待人验收

> 本报告取代旧 `2.7.260812-1` 的 156/200（78.0%）阶段报告。旧报告的 A05/A13 金标与当前代码事实相反，不能继续作为现行评分依据。

## 评测口径

题集为 50 个事实锚点 × 4 种自然问法。题文以完整字符串显式映射到 anchor，禁止按 Q 编号或数组位置推断。40 个会话各 5 轮，块内复用生产返回的同一 `convId` 并累积 messages；最多 2 个会话并发。每题技术失败有限重试，按块原子 checkpoint。

裁判使用 question-scope-v2：anchor requirement 是完整事实库，只要求覆盖当前题实际询问的关键事实；实质错误、漏关键值、错模块、无证据越界仍严格失败。模型判定后逐条以权威 Spec 人工复核；所有 override 均在合并 JSON 中记录理由与引用。

## 严格结果

| 项目 | 结果 |
|---|---:|
| 完整生成 | 200/200 |
| 严格通过 | 198 |
| 严格失败 | 2 |
| 通过率 | **99.0%** |
| A47–A50 安全边界人工复核 | **16/16** |

两条真实失败均属 A45 召回拒答：

| 题号 | 题文 | tag12 结论 | tag14 修复验证 |
|---|---|---|---|
| Q165 | Pad API 封装找得到、服务端 Controller 找不到，说明书应该怎么写？ | 已有事实却拒答 | 原五轮块命中 DQ-007，PASS；`ZX-20260812-514` |
| Q195 | 共享数据库与跨端功能一致性为什么不是一回事？ | 已有事实却拒答 | 原五轮块命中 DQ-007，PASS；`ZX-20260812-517` |

tag14 同时复测 A45 其余问法 Q160/Q170，四题全部 PASS。路由均为 `enabled=true / matched=true / tier=1 / usedSpecSearch=true`，分数依次 24.172、31.028、19.422、62.996；邻近诊断路由与 A24 私有/共享模板自然问法回归未被抢路由。

## 已纠正的权威事实与金标

- A05：当前 `JwtFilter` 使用 `startsWith` 匿名路径前缀；旧 `contains` 风险不是当前 tag 事实。
- A13：入院评估已有 `resultId` 的更新与删除均执行 owner 校验；非 owner 返回 `CREATOR` 且数据不变。
- A32：撤销收费置 `charge_status=-1` 并保留原记录，**不生成负金额冲正记录**；旧金标方向相反。
- A06/A10/A11/A19/A20/A31/A44 等具体值、路径和边界均补入 50-anchor requirement，避免抽象金标虚高或裁判误扣。

## 通用机制

本轮没有把题目答案硬编码进提示词，而是实现：完整目录/元数据先路由候选文件，再仅检索候选正文片段；自然概念归一仅补检索实体，不补答案；当前轮显式实体优先，短省略追问才从上一条 user 消息补实体；`answerFacts` 置前、全文检索作底座；无正文证据继续安全拒答。生产大地图读取修复了 `spawnSync` 默认缓冲不足导致 `routing.enabled=false` 的隐蔽故障。

## 生产浏览器验证

生产页面显示版本 `2.7.260812-14`，真实登录态下 6/6 PASS：

1. 新会话：共享数据库不等于 Web/Pad 功能一致。
2. 同会话追问：Web 有监护记录、Pad 没有时按页面→前端 API→服务端 Controller/精确路由分层排查。
3. 新对话：缺少页面/按钮原文/报错时拒绝猜固定重试入口并索要证据。
4. 新对话：菜单不可见不等于接口一定 403。
5. 同会话追问：明确方法级授权未落地，owner/机构/患者归属/状态仍需独立校验。
6. 再新对话问“它存在哪张表”没有泄漏上个会话实体，安全要求补充对象。

另在生产 UI 实测 A45 单轮及同会话“共享库是否代表功能一致”追问，答案均正确。

## 可审计证据

- 原始 200 题输出：`docs/reviews/evidence/PWRS-SPEC-QWEN-MAX-200-TAG12-RAW-20260812.json`
- 合并逐题判定、override 与 tag14 路由/原答：`docs/reviews/evidence/PWRS-SPEC-QWEN-MAX-200-TAG12-MERGED-20260812.json`
- 中性题集：`tools/fixtures/pwrs-qwen-max-200.questions.json`
- 题文→anchor 显式映射：`tools/fixtures/pwrs-qwen-max-200.question-anchor.json`
- 50-anchor 权威要求：`tools/fixtures/pwrs-qwen-max-50.requirements.json`
- 可恢复 runner：`tools/run-pwrs-qwen-max-eval.mjs`
- question-scope 裁判：`tools/judge-pwrs-qwen-max-eval.mjs`

代码回归有两个互补口径：合并专项（PD-02 prompts、FS-06 evidence、两阶段召回、PD-04 route）共 66 项，59 PASS / 0 FAIL / 7 条依赖真实地图环境而 SKIP；另以 tag14 真实 PWRS 地图单独回归 30/30 PASS，覆盖 A45 自然问法、DQ-007 邻近诊断及 A24 私有/共享模板不抢路由。runner/judge 均通过 `node --check`，题集不变量校验为 200 题、50 anchor 各 4 题、题文映射 missing/extra=0。

所有持久化证据均不含密钥。生产咨询记录与 `convId` 为真实库冒烟证据；本次未改数据库结构或 PWRS 业务代码。
