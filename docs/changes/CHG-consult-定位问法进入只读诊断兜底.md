# CHG · “定位”问法进入只读诊断兜底

- 日期：2026-08-28
- 类型：纯 bug 修复（咨询意图分层与模型失败降级）
- 关联 Spec：无（GUIDE-04 业务事实和安全规则未变化）
- 改动范围：`server.mjs`、`tools/fs-04-consult-conversation.logic.test.mjs`

## 现象

C030/Q0147 继承 GUIDE-04，问题是“先不转开发，导出请求是 200，下载下来的文件却打不开，这个问题实施还能怎么往下定位？”。模型多次 HTTP429，页面有时停在“正在生成回答”，有时返回“AI 暂时连不上”；同 route 的 Q0146 正常。

## 根因

受众识别因“实施”命中 implementation，但诊断意图词表漏掉“定位”。因此没有进入 field diagnostic fallback，`fallbackAnswerMode` 为 `facts`、`safeDiagnosticFallback` 为空，模型失败后无法发布确定性只读答案。

## 修复

- 受众模式与诊断意图独立判断，不因 implementation 受众自动等同诊断。
- 将“定位”纳入通用诊断意图信号，使“往下定位/继续定位”等实施追问进入 `field_diagnostic`。
- 模型 HTTP429、截断或空内容时，从 current route facts 构造安全只读 fallback，并通过原语义审计；保留“不重复导出、不改权限/模板/业务数据”的安全边界。

## 回归与验证

- 使用 production tag `2.7.260828-2` 的 route map、上下文 route matcher 和 repository context 重放 C030/Q0147。
- Q0147 命中 `AUD-QR-GUIDE-04`，`fallbackAnswerMode=field_diagnostic`，HTTP429 fallback 非空且 `finalAudit.violations=[]`。
- conversation：37/37 通过。
- safe-final-stream：16/16 通过。
- `node --check server.mjs`、测试文件检查、`git diff --check`：通过。

## 不改 Spec 原因

本次是诊断意图词表漏项的纯 bug 修复。GUIDE-04 的 route facts、只读安全边界和业务规则均未改变，因此不修改 Spec。
