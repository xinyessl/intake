# CHG：咨询多轮中强直接意图覆盖同主题宽历史

- 日期：2026-08-31
- 关联：`FS-04 AC-146`
- 类型：行为修复 + 回归契约补齐

## 现象

上一轮询问“HIS 对外 XML 接口当前实现”后，下一轮明确改问“第一层正常后如何继续只读排查”。当前轮人工路由原始分已是 `AUD-QR-GUIDE-01=67.742`、旧宽路由 `AUD-QR-DI-02=12.872`，但完整宽标题的强制候选和会话继承仍把最终 route 留在 DI-02，答复因此复述整段当前实现并带出不属于该路由的通用页面/状态模板。

## 根因

`routeQuestion` 的完整标题规则面向独立切题，`contextualRouteQuestion` 的继承规则面向弱追问；两层之间没有处理“同一业务主题内，从宽说明切到专用意图”的裁决。诊断里还会同时出现低分旧 selected route 与高分新 topN 候选，难以解释实际选择。

## 修改

- `contextualRouteQuestion` 只在当前强制候选仍等于上一轮 route 时检查本轮人工 `topN`。
- 若另一候选当前轮原始分至少为旧候选两倍，且绝对分差达到命中阈值，则恢复该高分候选的完整 route/facts/refs，作为本轮 direct route。
- 规则不识别具体系统、模块或题号；短句和无强 direct 的部分证据轮继续继承。
- 裁决后 `topN` 按本轮分数重排，确保 `routeId/score/topN[0]` 一致。

## 回归

1. DI-02 当前实现 → Q795：必须选 GUIDE-01。
2. 宽 JWT → Q792/Q793：必须选 JWT-CONTINUE。
3. “那下一步呢”“只有截图没有日志”：没有强 direct 时继续继承。
4. 显式医嘱标记新实体：继续覆盖历史。
5. routing 诊断中 selected route 与 topN 首项、分数一致。

自动回归已通过：

- `node --test tools/fs-04-consult-conversation.logic.test.mjs`：38/38。
- `node --test tools/fs-04-consult-safe-final-stream.logic.test.mjs`：16/16。
- `node --test tools/pd-04-route.logic.test.mjs`：31/31，另 31 条可选 PWRS 环境用例按既有条件 skip，0 fail。

## 隔离真库 HTTP/SSE 证据

在临时 MySQL 8.4（仅绑定 `127.0.0.1:33317`）和临时 Intake 数据目录上启动真实 `server.mjs`（`127.0.0.1:33318`），以管理员真实登录态依次调用 `POST /api/project-save`、两轮 `POST /api/consult` SSE、`GET /api/intake-detail`：

- HTTP 均为 200；同一会话 `ZX-20260831-01` 持久化 4 条 chat（2 user + 2 assistant）。
- 第一轮 route 为 `AUD-QR-DI-02`；第二轮为 `AUD-QR-GUIDE-01`，`score=67.742`、`contextPreviousRouteId=AUD-QR-DI-02`、`inherited=false`、`contextOverride=true`。
- 第二轮 `topN[0]=AUD-QR-GUIDE-01/67.742`，与 selected route/score 一致；两轮均 `fallbackSource=verifiedFacts`、`answerAudit.finalViolations=[]`。
- 直接查询隔离真库 `intakes.data` 得到 `DI-02 → GUIDE-01`，且第二轮 `routing.routeId/topN[0].id`、`score/topN[0].score` 分别相等。

模型地址在本次冒烟中刻意指向隔离的不可达端口，用于验证真实 HTTP/SSE 失败链会落到 current route 的 `verifiedFacts`，而非把模型输出当作路由正确性的替代证据；未访问生产库、未部署、未修改 Audit tag。

任务保持 `doing`，`accept=wait`；本次不打 Audit tag、不部署生产。
