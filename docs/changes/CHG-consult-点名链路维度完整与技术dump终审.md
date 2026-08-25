# CHG · consult 点名链路维度完整与技术 dump 终审

- 日期：2026-08-25
- 关联 spec：FS-04 AC-132
- 类型：生产回归修复（发布前语义审计与确定性 fallback）

## 现象与根因

Q0009 的 route 与证据已完整，但模型修订稿被旧 semantic audit 误放行：标题承诺“入口→接口→数据→外部依赖”却漏掉四个主接口，用完整表字段枚举占据篇幅，并留下“除 JwtFilter 明确放行的 /comm”半截句。旧审计只对“唯一主接口”做路径补全，未将多接口点名问法建立为集合契约；受众审计也未识别未点名的大量技术 token dump，句法完整性只覆盖 Markdown/括号。

## 修复

- 用户显式问接口/API/路径时，从 current route `answerFacts` 抽取全部 METHOD + path 主签名，逐个校验终稿；不从 contextRefs 辅助接口反向扩张主链。
- 建立点名链路维度契约：业务结论优先，再按入口、主接口、数据/状态、外部系统/边界、明确未知停点输出。修订仍失败时只用 route 事实重建紧凑终稿。
- product/implementation 且未问字段时，单段超过 8 个 snake_case/camelCase token 记为 `audience_technical_dump`；链路题中的字段表/Java 展开同样收缩。明确字段/代码题放行。
- `consultMalformedProseTokens` 增加缺主句的“除……”残句识别，阻止半截鉴权句进入 SSE 发布器。

## 回归证据

- `tools/fs-04-consult-conversation.logic.test.mjs` 使用生产 Q0009 形态，断言四个主接口、`audit_ipt_collect`、`deleted=1`、用户中心/HIS 边界和明确未知停点完整；长字段枚举、`JwtFilter` 残句消失，fallback 再审全绿。
- 正例覆盖实施模式 >8 token dump 拦截，反例覆盖显式字段/代码链问法放行。
- 2026-08-25：目标逻辑测试 37/37 通过；consult 相关套件 160 项中 129 通过、31 项为既有真实 PWRS 环境门控跳过、0 失败；`node --check server.mjs` 与 `git diff --check` 通过。

## 风险边界

- 主接口集合以 route `answerFacts` 为准；地图若把辅助接口误写进 answerFacts，终审会按契约要求覆盖，需从地图生成/评审阶段修正。
- 生产真模型与浏览器复测证据另行记录。
