# CHG：已核上一层后的续问进入只读分层排查

日期：2026-08-28

## 背景

审方 Q0195 从上一层“已核过且没有异常”继续追问下一步顺序。原有语义审计只把它当作普通事实题，模型失败或只复述 route facts 时没有提供可执行的下一层排查顺序，也没有明确按观测结果分支；批量通过与相邻超时通过边界容易因此被混在一起。

## 改动

- `server.mjs`
  - 新增通用 `continuationDiagnosticQuestion` 识别：要求同时出现上一层已核正常、下一步继续以及只读排查/核对语义，不绑定题号或业务模块。
  - 续问进入 `field_diagnostic` 与 `contextFollowup`，并复用诊断序列完整性门；只有 route facts 时会触发确定性安全兜底。
  - 兜底保留当前 route 的已核事实，并给出四步只读顺序：核对已发生请求/响应、结果与页面刷新、按请求缺失/失败/结果不一致分支留证；不新增写操作。
  - 续问的直接接口与状态边界集中放入研发参考，使用通用的路径/状态信号选取，避免把特定业务 token 写死在分类规则里。
- `tools/fs-04-consult-conversation.logic.test.mjs`
  - 使用真实 Q0195 题面回归 route、续问诊断标记、四步顺序、批量入口、超时接口、`audit_pass`/`time_over_pass` 边界及终审全绿。
  - 使用真实 Q0194 普通切题事实问法回归不误扩写为续接诊断。

## 验证

```text
node --check server.mjs
node --test tools/fs-04-consult-conversation.logic.test.mjs tools/fs-04-consult-safe-final-stream.logic.test.mjs
```

结果：53/53 通过；Q0195 fallback 的 `finalAudit.violations` 为空，Q0194 保持普通事实模式。本次未提交、推送或部署，也未修改 PWRS 未跟踪文件。
