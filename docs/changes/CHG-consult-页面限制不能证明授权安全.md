# CHG · 页面限制不能证明服务端授权安全时给四层只读核对

- **日期**：2026-08-28
- **来源**：正式浏览器回归 Q0227/Q0237
- **类型**：Intake 答回答复安全收口缺陷修复；不改业务 Spec，不改审方 route 事实。

## 问题

“页面复选框不可选能否证明批量审核权限安全”已能答出正确风险结论，但仍按普通事实题发布，缺少实施能照做的分层、只读核对顺序。

## 修复

- 通用识别“页面控件受限 + 询问能否证明权限/授权/越权安全”，不绑定题号、控件名、接口或业务模块。
- 该类问法进入 `field_diagnostic` 和四步序列完整性门。
- 确定性 fallback 先给业务结论，再依次核对页面限制、同一次既有请求/响应、服务端归属/授权范围/操作前状态校验、已有任务状态与审核流水。
- 技术路径、字段和状态仍只取当前 route 已核事实并集中到末尾“研发参考”；不建议重新点击、提交、拼对象或生产试越权。

## 验证

- `node --test --test-concurrency=1 tools/fs-04-consult-conversation.logic.test.mjs`：37/37 通过。
- `node --test --test-concurrency=1 tools/pd-04-route.logic.test.mjs tools/fs-04-consult-conversation.logic.test.mjs`：68 通过、31 跳过、0 失败。
- `node --check server.mjs`：通过。
- `git diff --check`：通过。
- 未提交、未推送、未部署；未改 9 个受保护的 PWRS fixture/evidence 未跟踪文件。

## Spec diff

无。审方 `AUD-QR-FLOW-BATCH-AUTH-01` 已明确页面禁选、后端 owner/院区/`start_audit` 校验缺口及只读审核流水边界，本次只修 Intake 对该类问法的回答生成与安全终审。
