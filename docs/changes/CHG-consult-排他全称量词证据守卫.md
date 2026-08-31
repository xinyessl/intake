# CHG：排他与全称量词证据守卫

- 日期：2026-08-31
- 类型：发布事实边界修复
- 关联：`FS-04 AC-149`
- 状态：已实现，待人验收

## 现象

Audit `2.7.260831-1` C162 Q0807 命中 `AUD-QR-SYS-01-BOUNDARY`。route 只确认“HIS 是审方请求来源”与“用户/JWT/菜单/角色属于用户中心”，模型修订稿却强化为“唯一来源”和“每次验证都去用户中心确认”，且原终审误判为全绿。

## 调整

- 发布前按语义家族识别唯一/只有、全部/所有、每次、始终/从不、必然等排他或全称 claim。
- 只有 route `answerFacts` 或用户本轮已提供证据在同 claim 上带等价量词才放行；`mustNotConfuse`、否定边界和引用问句不作正向授权。
- 无证据强化记为 `unsupported_absolute_quantifier` 并进入一次修订；修订稿仍有强化时，`verifiedFacts` route 只发布完整 route facts，不发布草稿/修订稿。
- 普通 route 的安全清理同步删除命中量词的整句；模型 prompt 同样加入发布前量词证据自检。

## 验证

- `node --check server.mjs`：通过。
- `node --test tools/fs-04-consult-conversation.logic.test.mjs`：38/38 通过。
- `node --test tools/fs-04-consult-conversation.logic.test.mjs tools/fs-04-consult-safe-final-stream.logic.test.mjs tools/pd-04-route.logic.test.mjs`：116 项，85 通过、31 个可选 PWRS 环境用例跳过、0 失败。
- 隔离 MySQL 8.4.11 真 HTTP/SSE：真实 `admin` 登录、Audit 项目登记、tag `2.7.260831-1` 的 Q0807 咨询与真实会话落库。伪 OpenAI 兼容流第 1 次返回虚构 path + “唯一/每次”，第 2 次修订仍保留强化；SSE 首审含 `unsupported_absolute_quantifier/audience_technical_overreach/unexpected_concrete_path`，修订审计含 `unsupported_absolute_quantifier`，`revisionAccepted=false`、`fallbackSource=verifiedFacts`、`finalViolations=[]`。会话 `ZX-20260831-01` 真库回查 1 条，`routeId=AUD-QR-SYS-01-BOUNDARY`，落库 `finalViolations=[]`，正文完整保留 5 条 route facts 且无“唯一来源/每次验证/虚构 path”。

## 边界

- 不修改 Audit 产品 spec/question route，不部署生产。
- 量词放行要求同一 claim 的等价证据，不仅是主题词重合；未枚举的隐性语义仍可能需要继续扩充。
