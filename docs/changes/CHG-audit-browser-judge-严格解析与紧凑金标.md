# CHG · audit browser judge 严格解析与紧凑金标

- 日期：2026-08-28
- 关联 spec：无（离线裁判工具修复；不改变 Intake 业务行为）
- 类型：纯 bug 修复（裁判协议解析与评测 payload）
- 改动范围：`tools/judge-audit-browser-eval.mjs`、`tools/judge-audit-browser-eval.logic.test.mjs`

## 现象

Q0115 使用 Anthropic deepseek-v4-flash 时连续返回 `raw=""`，已有 requirement/answerFacts 还被重复发送，复杂题 payload 可能膨胀并增加空响应风险。此前单题解析还可能从返回对象中的 `categories: []` 截出空数组，误把协议错误当成合法结果。

## 根因

1. 单题/批量 parser 对错误 JSON 形态边界不够严格，`categories: []` 等不构成合法 verdict 的内容可能被当作可解析结果。
2. requirement 文本已由 route facts 拼成，但 payload 仍重复发送全部 answerFacts，复杂题上下文变大，可能诱发截断/空响应。

## 修复

- 保留严格 JSON verdict 约束：单题必须有合法 id/pass，批量必须为非空数组；自然语言、截断 JSON、空 categories 对象等继续判 `judge_protocol_error`。
- 新增 `independentAnswerFacts` / `compactJudgeRequirement`：只发送 requirement 未覆盖的独立 answerFacts；requirement 已覆盖时省略 answerFacts；缺少 requirement 时保守保留 facts。
- 保留现有显式 raw debug（默认不泄漏，只有 `--debug-raw`/debug 环境变量才输出或保存）。
- 不改 Intake `server.mjs`，不影响业务运行时。

## 回归与验证

- `node --test tools/judge-audit-browser-eval.logic.test.mjs`：7/7 通过。
- `node --check tools/judge-audit-browser-eval.mjs`：通过。
- `node --check tools/judge-audit-browser-eval.logic.test.mjs`：通过。
- `git diff --check`：通过。
- 负例覆盖：自然语言、截断 JSON、`categories: []`、多对象拼接；正例覆盖单题合法对象和批量数组。
- payload 覆盖：全部 facts 已含于 requirement 时不发送 answerFacts；有遗漏时只发送遗漏 facts。
- 说明：这次紧凑化降低重复金标导致的上下文压力，但不宣称必然解决 Q0115 的 raw 空响应；业务工具运行时未改变。

## 不改 Spec 原因

本次只修离线评测裁判工具的协议边界与 payload 体积控制，未改变 Intake 业务规则、route 金标内容或业务答案，因此无需修改 Spec。
