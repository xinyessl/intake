# CHG · 已核事实终稿不再被混合受众排版门误杀

## 现象

Audit 第 60 题正确命中 `AUD-QR-FLOW-02`，但模型初稿与修订失败后生成的 `verifiedFacts` 终稿仍被通用实施排版审计拦截，页面只能显示机械安全提示。

## 修复

- 仅当人工 route 显式开启 `fallbackMode=verifiedFacts`，且终稿去除固定标题和列表标记后逐行、逐序精确等于全部 `answerFacts` 时，放行三个排版类 violation：`audience_technical_not_last`、`audience_technical_dump`、`nonsequential_top_level_steps`。
- 其它事实、范围、动作、结构和安全审计不变；普通模型文本或事实集合有任何增删改均不得借此放行。
- 新增生产 Q0060 全量回归，覆盖离线移交、任务状态、所属/优先级/挂起/倒计时、关闭审核重分配，以及无候选为 `audit_pass` 而非 `auto_pass`。

## 验证

- `node --test --test-name-pattern='二次修订失败时安全降级' tools/fs-04-consult-conversation.logic.test.mjs`
- `node --test tools/pd-04-route.logic.test.mjs tools/fs-04-consult-conversation.logic.test.mjs`

本变更不涉及数据库结构或接口契约。
