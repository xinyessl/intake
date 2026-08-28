# 变更：独立复测宽问法进入只读诊断

日期：2026-08-28
范围：`/api/consult` 的问句分层与安全 fallback；不涉及数据库结构。

## 背景

审方 Q0177 的真实题面是“另一轮独立复测（177）里，处方审核端到端主流程（HIS 接入→落库→分配→审核→回写）涉及哪些接口、数据和边界？”。它虽然列举接口、数据和边界，但明确处于独立复测语境。原规则被 broad facts 门拦住，模型失败或修订失败时只复述已核事实，没有给实施可执行的只读核对顺序。

## 改动

- “另一轮独立复测/现场复测/现场复核”与接口、数据、边界同时出现时，识别为 `field_diagnostic`，并使用 `fallbackAnswerMode=field_diagnostic`。
- 该 fallback 保留少量已核业务基线，并补齐四步只读核对：当前页面与上下文、已有请求/响应、日志与任务状态、下游结果及证据整理；不建议重复提交、重放、改数据或其它写操作。
- 明确“串起来/全链路/调用链/实现链路/从入口到外部依赖”的题面排除在复测诊断门之外，继续走研发 chain 完整性合同，避免 Q0179 被抢路由。
- 终审新增诊断序列完整性门：至少四个连续步骤，并出现只读核对、请求/响应、记录/日志或任务状态等证据词；fallback 生成后重新终审。

## 回归证据

```text
node --check server.mjs
node --test --test-concurrency=1 tools/fs-04-consult-conversation.logic.test.mjs
```

测试读取真实 `tools/fixtures/audit-browser-1000.question-requirements.json` 的 Q0177/Q0179 题面与 route：

- Q0177 命中 `AUD-QR-FLOW-01`，`fallbackAnswerMode=field_diagnostic`；模型失败 fallback 含四步、请求/响应、日志、任务状态、下游结果/证据整理，重审 `violations=[]`。
- Q0179 的链路题 `explicitReviewDiagnosticQuestion=false`、`fieldDiagnosticQuestion=false`、`chainRequested=true`，没有被诊断四步门改写。
