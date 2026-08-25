# CHG · consult 承接 route 不继承上一轮回答形态

- 日期：2026-08-25
- 关联 spec：FS-04 AC-134
- 类型：生产回归修复（Q0010 发布前语义兜底）

## 现象与根因

Q0010 当前问句只要求把医嘱标记排查建议换成实施可照做的只读清单，受众也已正确识别为 implementation；模型初稿和修订稿被事实、动作与受众审计拦截后，最终仍残留 `incomplete_requested_chain`，于是发布口退成机械安全停止。该会话上一轮曾询问入口、接口、数据到外部依赖的完整链路，说明链路回答形态随继承 route 污染了当前实施重述。route 可以继承已核事实，但“本轮必须覆盖哪些维度”只能来自当前 user 问句。

## 修复

- 完整链路维度审计增加受众不变量：只有当前轮明确询问接口、路径或开发链路并被识别为 developer 时才启用；product/implementation 的承接重述不从 `inheritedFromQuestion` 或历史问句继承回答形态。
- 最终确定性诊断恢复增加防御门：若 product/implementation 安全清单重审后只残留陈旧的 `incomplete_requested_chain`，仅清除该结构 violation 后发布；其它事实、动作、作用域或完整性违规仍须继续清理，developer 链路题绝不放行。
- Q0010 的不安全模型稿仍照常触发概率、技术末置和副作用动作门；确定性 `safeDiagnosticFallback` 保留 MK-02 已核事实并输出四步只读留证，二次语义审计通过后发布。
- `retrieval.answerAudit` 增加首审/终审 `chainRequested` 与缺失维度，便于以后区分模型漏答和历史形态污染。
- 当前轮显式索要接口/开发链路的 Q0009 仍执行 AC-132 的完整接口集合与逐维终审。

## 回归证据

- `tools/fs-04-consult-conversation.logic.test.mjs`：真实 Q0010 问句 + MK-02 route + 上一轮链路型 `inheritedFromQuestion`，断言 audience=implementation、`chainRequested=false`、无 `incomplete_requested_chain`，四步只读兜底自身终审 0 violation；既有 Q0009 链路回归继续全绿。
- 生产浏览器复测证据另行记录。

## 风险边界

- 本修复不放松事实、作用域、只读动作、未知停点或显式接口完整性；只隔离上一轮回答结构对当前轮的影响。
- 模型首选服务超时仍可能触发备用模型和确定性兜底，但不应再因历史链路维度退成机械拒答。
