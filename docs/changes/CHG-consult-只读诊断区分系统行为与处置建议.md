# CHG：只读诊断区分系统既有行为与后续处置建议

- 日期：2026-08-28
- 类型：答疑安全兜底修复
- Spec：无需修改。Audit 路由记录的 as-built 行为和处置边界本身正确，本次只调整 Intake 在现场只读语境下的答案编排。

## 变更

- 将外部会话、消息、通知或回调失败后业务是否继续的连续问法识别为 `field_diagnostic`。
- current route 中“应补发/补偿、决定是否重做/重试”等后续处置建议，发布时只保留条件与差异，并明确交接口/业务负责人评估；未经另行授权，本轮不补发、不重做、不重试。
- current route 中“返回后再通过服务补全”等系统既有流程，发布时改写成“当前实现会、由系统读取并补全”，避免被读成现场操作指令。

## 回归

- 真实 Q0282/Q0285 连续会话、通用展示补全/补偿事实、负向禁止动作和普通成功状态反例。
- `node --test --test-concurrency=1 tools/pd-04-route.logic.test.mjs tools/fs-04-consult-conversation.logic.test.mjs`：68 pass / 31 skip / 0 fail。
- `node --check server.mjs`、`node --check tools/fs-04-consult-conversation.logic.test.mjs`、`git diff --check`：通过。
