# CHG：链路 fallback 保留问句点名的业务阶段事实

日期：2026-08-28

## 背景

审方端到端链路题 Q0179 的问句在标题括号中明确点名“接入→落库→分配→审核→回写”。原有确定性链路兜底按入口、接口、数据、外部依赖分组，未把“分配”阶段的已核事实独立带出，导致在线药师与本院权限交集、1000 份平滑加权轮询和多任务共同候选承接规则可能漏答。Q0177 的复测宽盘点还会因相关性过滤漏掉后段分配及事务失败边界。

## 改动

- `server.mjs`
  - 从链路问句括号/箭头和阶段词提取通用阶段标签（不绑定题号或 route）。
  - 按阶段信号从当前 route facts 选择最多两条原句，以独立“业务阶段”行补入链路 fallback；入口、接口、数据/状态、外部依赖和资料明确未知停点仍按原合同输出。
  - 对“独立复测 + 接口/数据/边界”的宽盘点保留全部 current route facts，再追加四步只读核对，避免过滤分配、事务失败和 `sf_*` 未确认边界。
- `tools/fs-04-consult-conversation.logic.test.mjs`
  - Q0177 回归候选交集、1000 份权重、平滑轮询、多任务整批/逐任务、无总事务、`audit_sync_error_flow` 和 `sf_*` 未知。
  - Q0179 回归阶段标签顺序、分配三层事实、主链维度和未知停点，终审必须全绿。
- `docs/lessons.md`
  - 新增 L-128，记录链路阶段事实不能被维度去重吞掉的防回归规则。

## 验证

```text
node --check server.mjs
node --test --test-concurrency=1 tools/fs-04-consult-conversation.logic.test.mjs
```

结果：37/37 通过；Q0177/Q0179 真实题面回归的 `finalAudit.violations` 均为空。联合回归另见交付回报。

本次仅修改 Intake 逻辑、测试和经验文档；未修改 PWRS 未跟踪 fixture/evidence，未提交、推送或部署。
