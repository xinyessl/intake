# CHG-CU-01 · 客户/医院管理 spec 回校到部署真相 + 新增连真库冒烟测试

- **日期**：2026-07-20
- **spec**：CU-01（客户 / 医院管理）
- **裁决**：前端事实源 = 部署实现（intake_bak），非原型 admin/customers.html。
- **类型**：spec 回校（行为无变化——回校为部署现状；属"涉及 spec"，spec diff 随验收拍板）+ 新增测试（无代码/库改动）。

## 部署客户数据真相（本单最重要产出）
- 客户/医院台账走**文件存储** `intake_bak/data/customers.json`（`{ customers:[...] }`），**与 model-config/git-config 同范式，不入 MySQL**。文件当前不存在 → `loadCustomers()` catch 返回 `[]`。
- 真库 `db.mjs` 仅 **5 表**（projects/accounts/sessions/intakes/kb_entries），**无 `customers` 表**（连本地真库 `SHOW TABLES` 已确认）。
- 客户结构**最简**：`{ id(='c'+4字节hex), name(≤60), products:[{project,version}], updatedAt('yyyy-MM-dd HH:mm') }`——**无** level/region/impl/status/ticketCount。
- 3 端点（server.mjs）：`GET /api/customers`（读文件，供管理页 + 提交端现场下拉）、`POST /api/customer-save`（仅管理员，`normCustomer` 规范化：名称 slice(0,60)、产品去重 + `projById` 有效性 + ≤40）、`POST /api/customer-delete`（仅管理员，按 id 精确删）。
- 前端页 `public/customers.html`：两栏 `.grid`（左编辑表单卡 + 右客户列表卡）+ 内联主题 `<style>` + `/assets/{app.css,ui.js,nav.js}` 外壳；删除走共享 `uiConfirm`；**非**原型的 7 列表格/抽屉/分页/筛选。

## 改动
- `docs/specs/CU-01-客户医院管理.md`：整体回校——
  - frontmatter：`source`/`contract`/`baseline` 改为部署实现；删 `prototype` 指向。
  - 顶部加「裁决·部署真相」横幅。
  - §1~§6 重写为部署现状（AC 由原 19 条富字段版缩为 11 条部署版）。
  - §7 测试要点指向已落地 `tools/cu-01.test.mjs`；§8 DoD 勾选已完成项。
  - **原型富字段 + 迁库方案整体移入「附录：待决策」**，逐项标 NEEDS-HUMAN，明确"批准前不建表/不加列/不改 db.mjs"。
- 新增 `intake_bak/tools/cu-01.test.mjs`：8 用例（连真库冒烟 + 3 端点接口），全绿；备份/还原 `data/customers.json` + 隔离产品/精确删清理，不污染真库。

## 未动（护栏）
- 未建 `customers` 表、未加任何列、未改 `db.mjs`/`server.mjs`/`public/customers.html` 及共享外壳。纯 spec 回校 + 新增独立测试文件。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
