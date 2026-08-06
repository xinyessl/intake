# CHG · 工单↔批次双向编辑（BP-01 §L · AC-37/38/39）

**日期**：2026-08-06
**类型**：功能新增（行为调整）· 涉及 spec（BP-01 §L 新增 AC-37/38/39）

## 背景
用户反馈：一张已立项工单在定档建批**之后**才进来（如 XQ-20260806-02），`batch-arrange` 一刀切全归、给它只能单独建一批，既进不了已有开发中批次、又很别扭。需要**批次侧勾选工单 + 工单侧指派批次**双向可编。

## 改动
### server.mjs
- **`assignTicketToBatch(proj, e, targetBatch, list, liveBatchIds, by, at)`** 纯逻辑助手：护栏（consult/已删/仅已立项/目标批次存在+开发中+同product/旧批锁定拒移出）+ 双向引用同步（旧批 `ticketIds` 删、新批加、`e.batch` 设）+ 工单/批次双向 `history` 留痕；move/remove/noop 全覆盖。
- **`POST /api/ticket-set-batch` `{project,id,batch}`**：单工单指派/换/移（`batch=''` 移出）→ `saveIntake`+`saveBatches`，返回 `{ok,batch}`。
- **`POST /api/batch-add-tickets` `{batchId,ticketIds[]}`**：批次侧批量加（开发中批次）→ 逐个复用助手，返回 `{ok,added,skipped}`。
- **`batch-arrange`** 加可选 `ticketIds[]`：传了只归勾选子集（校验同前），不传维持原「全部已立项未归批」（向后兼容）。
- 均 admin（未进 FIELD_OK/FS08 → 非 admin 401/现场域 403）。复用 batch-arrange 的「批次真实存在」孤儿判定。

### public/inbox.html
- 工单查看抽屉（仅 `lifecycle=已立项`）加「批次」区：当前批次徽标 + 指派下拉（`initTicketBatchSel` 拉该产品开发中批次填充，默认列它们 + 「移出批次」+「新建一批…」跳批次页）；change → `onTicketBatchChange` → `ticket-set-batch` → 刷新抽屉/列表（漏斗随 effLifecycle 归位）。

### public/batches.html
- 定档建批 modal 加工单勾选清单（该产品已立项+未归批，默认全选 + 全选/全不选）→ 传勾选 `ticketIds` 给 `batch-arrange`。
- 批次详情（仅开发中）加「添加工单」modal（`openAddTickets`/`doAddTickets`→`batch-add-tickets`）+ 每条工单「移出」（`removeTicketFromBatch`→`ticket-set-batch {batch:''}`）；可下载/已交付批次成员锁定、不显增减入口。

## 验证
- 代码逐行审查（护栏 + 双向同步 + 留痕正确）；prod 部署 + `assignTicketToBatch` 标记落地；接线探活：admin 域未登录 `ticket-set-batch`/`batch-add-tickets` → 401 need-login、现场域 → 403 forbidden（admin-only 正确）。
- prod 数据核对干净（批次 B-01/hlyy/开发中/含 BUG-20260806-01；XQ-20260806-02 未归批）。UI 端到端由用户在后台验（把 XQ-20260806-02 指派进 B-01 等）。

## 备注
- 本功能由 dev agent 实现，agent 交付报告因 API 连接中断丢失；编排器已逐行复核代码正确性 + 补部署/接线校验/CHG/spec。
