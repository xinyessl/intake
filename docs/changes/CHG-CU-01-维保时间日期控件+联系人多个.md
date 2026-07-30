# CHG · CU-01 · 维保时间改日期范围控件 + 医院联系人支持多个

> 日期：2026-07-30　类型：交互优化（承接 CHG-CU-01-医院管理扩5字段）　来源：用户反馈
> 页面：public/customers.html + server.mjs normCustomer

## 改动
1. **维保时间 → 日期范围控件**：由文本改为 `维保起(edMaintainStart) ~ 维保止(edMaintainEnd)` 两个 `<input type=date>`（range-box，符合 UI 规范「起止用单个范围框」；只填其一也可）。数据 `maintainStart`/`maintainEnd`（替代 `maintainDate`）。
2. **医院联系人 → 支持多个**：由单条 contactName/contactPhone 改为**动态增删多行**，数据 `contacts:[{name,phone}]`（≤20 条，去空）。「添加联系人」按钮加行、每行可删。
   - **兼容**：normCustomer 与 openEdit 都兼容旧扁平 `contactName/contactPhone` → 自动迁为 `contacts[0]`，不丢已存数据。

## 部署 / 验证
rsync server.mjs + customers.html → 线上 + `docker restart intake-app`；服务器确认新字段/表单已在，health 200。
