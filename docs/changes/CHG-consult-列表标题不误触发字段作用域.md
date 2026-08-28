# CHG · 列表标题不误触发字段作用域

- 日期：2026-08-28
- 类型：纯 bug 修复（行为与已核 route 事实不变，无需调整 Spec）

## 现象

受限证据回答已发布当前 route 的四条已核事实，最终审计却把同一路由中的状态 token 判为越界。

## 根因与修复

字段作用域规则用单字“列”识别列语义，误命中“待审列表”中的“列”；问题又带 `requestId`，于是错误启用了字段 sibling-token 收窄。现将“列”收紧为不命中“列表”，同时保留字段、列类型、长度等真实字段语义的严格作用域。

## 回归

- Q0213/Q0218 的 partial-evidence 确定性 fallback 可发布完整紧凑 route，最终审计无越界。
- “待审列表 + requestId”不再触发字段 sibling-token 收窄。
- 真正的 `patient_id` 列类型问题仍拒绝额外 `visit_id` sibling token。
