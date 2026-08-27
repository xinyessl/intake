# CHG · 受限证据问法明确已知与未知边界

- 日期：2026-08-28
- 类型：纯 bug 修复（咨询意图分类与 verifiedFacts 兜底）
- 关联 Spec：无（门诊处方自动通过的业务事实和安全规则未变化）
- 改动范围：`server.mjs`、`tools/fs-04-consult-conversation.logic.test.mjs`

## 现象

Q0173“先别把门诊处方自动通过的原因说死：当前只有接口状态和业务返回，哪些结论成立，哪些仍需确认？”原先被当作普通事实题，回答只罗列 route 的完整 facts，没有明确说明现有证据能确认什么、哪些仍需确认。

## 根因

受限证据识别只覆盖“只能确认”“没有数据库权限”“证据最多能判断到哪”等表达，未覆盖“当前只有……哪些结论成立/哪些仍需确认”的等价问法，导致 `fallbackAnswerMode` 保持为 `facts`。

## 修复

- 增加通用的“当前/现在/本轮/现有只有（或仅有）……哪些成立/确认、仍需确认”模式识别，归入 `partial_evidence`。
- partial evidence 终稿先给“现有受限证据只够……”的证据充分性结论，再发布 current route 的已核事实，并单列“本轮未知”，不把接口状态或业务返回扩写成落库、后续状态或原因结论。
- HTTP429、截断或空模型结果仍走同一确定性 verifiedFacts fallback；不改变普通事实题、字段题和诊断题的既有分流。

## 回归与验证

- 使用 tag `2.7.260828-2` 的真实 route map 与 repository context 重放 Q0173，确认命中 `AUD-QR-DI-05`。
- 原样罗列完整 facts 的草稿被识别为 `partial_evidence`，并触发证据充分性边界校验。
- HTTP429 fallback 包含“现有受限证据只够”与“本轮未知”，`finalAudit.violations=[]`。
- conversation：37/37 通过；safe-final-stream：16/16 通过。
- `node --check server.mjs`、测试文件检查、`git diff --check`：通过。

## 不改 Spec 原因

这是受限证据问法的同义表达漏识别，属于纯 bug 修复；DI-05 的业务事实、证据边界和安全规则没有变更，因此不修改 Spec。
