# CHG：模型失败只发布完整安全路由事实

- 日期：2026-08-31
- 关联：`FS-04 AC-147`
- 类型：行为修复 + 发布安全门补齐

## 现象

Audit `2.7.260831-1` 的 Q795 已正确选择 `AUD-QR-GUIDE-01`。模型因长度截断失败后，fallback 先完整发布了该 route 的 `answerFacts`，随后仍追加通用“下一层只读排查顺序”，带出 route 未定义的页面选择、对象标识、状态接口、页面刷新和列表摘要，并出现面向实现的 `current route` 字样。

## 根因

模型失败入口统一复用了普通现场问法的 `field_diagnostic` fallback。即使显式 `verifiedFacts` route 的完整 facts 已经构成安全终稿，组装器仍继续添加通用诊断模板；发布审计也没有独立阻断内部运行时术语和 route 未正向定义的通用页面/状态模板。

## 修改

- 对显式 `fallbackMode=verifiedFacts` 的 route，先用未应用完整事实排版豁免的审计结果判断 facts 是否实质安全。
- 仅当所有原始 facts 都被安全转换原样保留，且剩余问题只属于受允许的排版/结构类别时，模型 length、429、超时或空结果 fallback 才按“业务结论 / 实施口径”逐条、逐序发布完整 facts，并停止追加通用诊断。
- route facts 含补发、补偿、重做等需要安全转换的处置建议时，继续走既有安全改写，不能用“完整 facts”绕过安全门。
- 发布审计阻断 `current route`、`answerFacts`、`mustNotConfuse` 等内部术语，以及 route 未正向定义的页面选择、状态接口、页面刷新、列表摘要等正向模板；“未定义/不得加入”等否定边界不误拦。
- 无匹配 route 的普通现场诊断仍保留安全最小留证步骤。

## 回归

执行：

```text
node --check server.mjs
node --test tools/fs-04-consult-conversation.logic.test.mjs tools/fs-04-consult-safe-final-stream.logic.test.mjs tools/pd-04-route.logic.test.mjs
```

结果：116 项，85 pass、31 条既有可选环境用例 skip、0 fail。

覆盖：

1. DI-02 当前实现 → Q795：length/429 后只发布完整 GUIDE-01 facts。
2. 宽 JWT → Q792/Q793：length/429 后只发布完整 JWT-CONTINUE facts。
3. 追加内部术语或未核页面/状态模板时发布审计必须拒绝。
4. 普通 route miss 仍返回不含业务臆测的安全最小步骤。

## 隔离真库 HTTP/SSE 证据

使用隔离 MySQL 8.4、临时 Intake 数据目录和模拟 `finish_reason=length` 的隔离模型流，启动真实 `server.mjs`，以管理员真实登录态完成项目保存和同一会话 Q794→Q795 的 `POST /api/consult` SSE：

- 会话：`ZX-20260831-02`；Q795 `routeId=AUD-QR-GUIDE-01`、`score=topN[0].score=67.742`、`inherited=false`。
- `modelDraftError.code=MODEL_OUTPUT_TRUNCATED`、`kind=length_limit`、`fallbackSource=verifiedFacts`。
- 持久化 assistant 正文逐条等于 GUIDE-01 完整 facts，不含 `current route`、页面选择、对象标识、状态接口、页面刷新或列表摘要。
- `answerAudit.finalViolations=[]`；真实 HTTP/SSE 与 MySQL 持久化正文一致。

本次不改数据库结构，不打 Audit tag，不部署生产。任务保持 `doing`，`accept=wait`，等待人工验收。
