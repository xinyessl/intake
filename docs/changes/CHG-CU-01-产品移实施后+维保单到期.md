# CHG · CU-01 · 编辑抽屉：关联产品移到负责实施人后 + 维保改单个到期时间

> 日期：2026-07-30　类型：交互调整　来源：用户反馈
> 页面：public/customers.html + server.mjs normCustomer

## 改动
1. **关联产品上移**：编辑医院抽屉里「关联产品 + 各自版本」由末尾移到「负责实施人」正下方（顺序：名称/等级→状态→负责实施人→关联产品→医院联系人→设备码/维保到期→服务器信息→备注）。仅移动 DOM 位置，edProdRows/addProdRow 逻辑不变。
2. **维保改单个到期时间**：由 `维保起~止` 日期范围改为**单个「维保到期」日期控件**（`edMaintainEnd`，`<input type=date>`）；去掉 `maintainStart`（server.mjs normCustomer / openEdit / saveCustomer 一并去除）。数据字段仅保留 `maintainEnd`。

## 部署 / 验证
rsync server.mjs + customers.html → 线上 + `docker restart intake-app`；无 maintainStart 残留、id=edProdRows 唯一、health 200。
