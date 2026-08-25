# CHG · consult 非链路题不制造未知停点

- 日期：2026-08-25
- 关联 spec：FS-04 AC-135
- 类型：生产回归修复（Q0011 产品事实题）

## 现象与根因

Q0011“住院医嘱审核现在是怎么实现的？”正确命中 WB-03 且受众为 product，模型也已覆盖核心 As-built；发布前元数据却同时出现 `chainRequested=false` 与 `missingChainDimensions=[资料明确的未知停点]`，最终因 `incomplete_requested_chain` 退成安全停止。

根因是链路缺失账本的入口、接口、数据和依赖分支都受 `chainDimensions` 约束，唯独“资料明确的未知停点”无条件追加。只要 route 的直接证据含 NEEDS-HUMAN/待确认，任何普通事实题都会被误当成漏答链路。Q0011 不是诊断题，没有 `safeDiagnosticFallback`，因此最终恢复口无法兜底。

## 修复

- “资料明确的未知停点”与其它链路维度统一，仅在当前 `chainRequested=true` 时进入 `missingChainDimensions`。
- 产品事实题仍由作用域门删除相邻医生端扩写，fallback 只保留 current route 已核 As-built，不追加未知/Target 或技术说明。
- 当前 developer 明确要求完整链路且要求未定义处停住时，route 已明确 gap 仍必须覆盖，遗漏继续触发 `incomplete_requested_chain`。

## 回归证据

- `tools/fs-04-consult-conversation.logic.test.mjs`：Q0011 产品问句 + WB-03 已核事实 + 明确 gap + 越界医生句，验证产品 fallback 精确止答；Q0010 implementation 承接及显式 developer 链路正反例同步覆盖。
- 生产浏览器复测证据另行记录。

## 风险边界

- 本修复不把 NEEDS-HUMAN 转成当前事实，也不删除显式链路题要求的未知停点；仅修正非链路题不应创建链路缺失账本。
