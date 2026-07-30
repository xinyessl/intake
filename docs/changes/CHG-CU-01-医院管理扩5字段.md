# CHG · CU-01 · 医院管理新增 5 类字段（服务器信息/设备码/维保时间/联系人/备注）

> 日期：2026-07-30　类型：小特性（扩客户数据模型）　来源：用户反馈
> 页面：public/customers.html 编辑抽屉 + server.mjs normCustomer

## 需求
医院管理新增：① 服务器信息 ② 设备码 ③ 维保时间 ④ 医院联系人 ⑤ 备注信息。

## 改动
- **server.mjs `normCustomer`**：加 `serverInfo`(≤1000)/`deviceCode`(≤120)/`maintainDate`(≤60)/`contactName`(≤20)/`contactPhone`(≤20)/`remark`(≤1000)；用 `'x' in b` 判存在，**偏更新（如实施人写穿 account.sites 时的部分保存）保留原值不清空**。落 `data/customers.json`（文件存，不入库）。`customer-save` 复用 normCustomer，无需改。
- **customers.html 编辑抽屉**：负责实施人下方加「医院联系人+联系电话 / 设备码+维保时间 / 服务器信息 / 备注」表单；`openEdit` 回填、`saveCustomer` payload 收集这 6 字段。
- 列表列不变（未加列，避免拥挤）；字段在编辑抽屉查看/维护。

## 部署 / 验证
rsync server.mjs + customers.html → 线上 + `docker restart intake-app`；服务器确认新字段/表单已在，health 200。
