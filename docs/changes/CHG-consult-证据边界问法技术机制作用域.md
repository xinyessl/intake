# CHG：咨询证据边界问法纳入技术机制作用域

- 日期：2026-08-14
- 关联 Spec：FS-04 AC-93
- 类型：缺陷修复 + 回归边界补全

## 变更

“只能确认、能确定、不知道、未知、走到哪、还缺什么”等证据边界问法纳入诊断 scope 审计；技术机制词族补充 JS/JavaScript 同义归一、Number 和中间层。未在本轮或 current/inherited route 明确提供的机制触发修订，失败整句降级。

## 原因

生产可见复测中，用户仅问“请求已发、后端路径未知时能确定什么”，答案从数据库 varchar 事实扩写到未核的 JS/中间层 Number 转换。原机制门因问题未包含“排查”而未启用。

## 回归

`tools/fs-04-consult-conversation.logic.test.mjs` 覆盖字段 route 越界 JS/中间层/Number、用户逐字 Number 和 route 明确 JavaScript 时 JS 简称放行。
