# CHG：模型失败按本轮观测组合已核事实

- 日期：2026-08-31
- 类型：行为边界补全
- 关联：`FS-04 AC-148`
- 状态：已实现，待人验收

## 现象

Audit `2.7.260831-1` 的 C160 中，Q0798 已明确“只确认前端发出请求、服务端日志未拿到”，Q0800 已明确“接口返回有数据、页面未呈现”。两题均命中 `JWT-CONTINUE`，但模型长度截断后的 verifiedFacts fallback 只复述 route facts，没有回答本轮实例的已知/未知或开发交接材料。

## 调整

- 新增通用的“前端请求已发起、服务端日志缺失”证据分类；模型失败终稿在完整 route facts 外，明确列出用户观测、未提供的 path/脱敏 Authorization/HTTP 状态/业务码/响应原文，以及只由 route facts 点名的服务端未知层。
- 页面有数据但未呈现时，只组合同一次已发生请求与同一时刻页面现象、时间、脱敏截图、已有控制台错误；这些只作为开发交接证据，不反推产品事实或服务端结果。
- 两类终稿均禁止请求重放、重复提交、重试、修改数据与其它写操作；不恢复通用页面选择、页面刷新、列表摘要或未核状态接口模板。
- 发布审计只对白名单结构完全一致、route facts 完整逐序出现且实质安全门通过的组合终稿放行；其它 verifiedFacts 问法继续 facts-only，普通 route miss 继续原安全最小诊断。

## 验证

- `node --test tools/fs-04-consult-conversation.logic.test.mjs`：38/38 通过。
- `node --check server.mjs && node --test tools/fs-04-consult-conversation.logic.test.mjs tools/fs-04-consult-safe-final-stream.logic.test.mjs tools/pd-04-route.logic.test.mjs`：116 项，85 通过、31 个可选 PWRS 跳过、0 失败。
- 隔离 MySQL 8.4.11 真 HTTP/SSE：默认管理员真实登录、临时 Audit 项目登记、tag `2.7.260831-1` 连续三轮咨询、OpenAI 兼容流 `finish_reason=length`、会话真实落库。Q0798 为 `JWT-CONTINUE/inherited=true/partial_evidence`，Q0800 为 `JWT-CONTINUE/inherited=false/field_diagnostic`；两题均 `fallbackSource=verifiedFacts`、`modelDraftError.kind=length_limit`、`finalViolations=[]`，会话 `ZX-20260831-01` 在 `intakes` 中持久化 1 条。

## 边界

- 不修改 Audit 产品 spec/question route，不部署生产。
- 页面截图或控制台错误仅是交接证据，不代表已确认产品行为或故障根因。
