# CHG：UUID 字段作用域审计误拦

日期：2026-08-27

## 现象

`pwrs_patient.p_id 是 PostgreSQL 原生 uuid 吗？` 的路由与事实均正确，但答案使用正常的大写 `UUID` 时，被 `consultScopeTechnicalTokens` 的通用 `...ID` 后缀规则误判为未点名技术词，最终退回安全拒答。

## 修复

- 在技术词抽取中显式识别 `uuid/UUID`，统一为 canonical token `uuid`。
- 保持其它字段 token 以及 sibling 字段越界拦截规则不变。

## 验证

- `node --test tools/fs-04-consult-conversation.logic.test.mjs`：37/37 通过。
- 回归覆盖 `UUID/uuid` 大小写一致性，以及 `visit_id/district_code` 越界仍拦截。

本次为纯审计误报修复，不改变 PWRS 业务规则或数据库结构。
