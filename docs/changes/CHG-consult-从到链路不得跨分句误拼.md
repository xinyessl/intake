# CHG · “从 A 到 B”链路意图不得跨分句误拼

## 现象

生产 Q210 正确命中 `AUD-QR-DI-08`，但问句“实施能不能从审方页面手动触发；只看到处理代码能否认定生产已启用”被错误识别为完整研发链路，安全终稿被要求补齐数据/状态和未知停点，最终只显示机械停止提示。

## 根因

`consultAnswerSemanticAudit` 的链路意图正则允许 `从` 与 `到` 跨逗号、分号配对；前半句的“从审方页面”与后半句“只看到”意外组成了 `从…到`。

## 修复

- “从 A 到 B”只允许在同一分句内匹配，逗号和分号与句末标点共同作为边界。
- 显式“串起来、全链路、调用链、实现链路”等研发问法继续启用完整性合同。
- 不修改 Audit Spec、HC1015 route 事实、动作安全门或生产启用边界。

## 验证

- 生产 Q210 原句：`chainRequested=false`，verifiedFacts 终稿覆盖业务分组、仓库未激活入口、生产启用证据边界、禁止直接重放以及 DI-07 归属，最终语义审计 0 violation。
- 显式正例“从入口、接口和数据状态到外部依赖完整串起来”：`chainRequested=true`。
- `node --check server.mjs`
- `node --test tools/fs-04-consult-conversation.logic.test.mjs`

## Spec 分类

纯 bug 修复：现有“当前轮显式研发链路才启用完整性合同”的行为约束不变，无需修改 Spec。
