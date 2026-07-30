# CHG-CU-01 · 客户/医院管理 re-target 原型 + 扩客户字段

- 日期：2026-07-21
- 关联 spec：CU-01（本次同步更新 spec，属「涉及 spec」的逻辑/行为调整，spec diff 随验收材料一并拍板）
- 类型：逻辑/行为调整（re-target 界面 + 扩字段 + 派生统计）

## 背景
上一版 CU-01 曾「回校部署最简」（锁老页：两栏 `.grid` 简化实现、客户结构最简、无扩字段）。用户裁决：客户/医院管理页**按臻遴原型 `admin/customers.html` 重做页面内容/功能**（外壳已由 UI-01 完成），并**扩客户字段**。故按「改 spec → 改测试 → 改码」正序 re-target。

## 改动
- **`public/customers.html`（整页重写）**：由两栏 `.grid`（左表单 + 右 `.clist` 卡片列表）→ 整宽 `.data-table` 7 列（医院名+等级/地区/负责实施[头像+姓名+电话]/上线产品·版本/状态/工单数/操作）+ 新增/编辑**抽屉 `#editDrawer`**（自实现 open/close + toast，shell.js 无 UI.openDrawer，参考 accounts.html/inbox.html）+ 富筛选（地区/等级/状态/关键词，选择即选即查·关键词回车）+ 分页（8/20）。`<body>` 标 `data-content-layout="list"`（全高内滚 shell，见 lessons L-003）。删除走共享 `uiConfirm`。
- **`server.mjs`（仅客户相关小改）**：
  - `normCustomer` 扩字段：新增 `level`(枚举归一 三甲/三乙/二甲，默认三甲)/`region`(≤40)/`impl`{name,phone}(各 ≤20)/`status`(枚举归一 已开通/未开通，默认已开通)；**保留** `name`(≤60)/`products:[{project,version}]`（去重 + `projById` 有效性 + ≤40）不动。
  - 新增 `custTicketCountBySite()`（全项目扫 `listIntake` 不含 consult，按 `intakes.site` 计数）+ `custWithTicketCount()`（给每条客户挂读时派生 `ticketCount = cnt[name]||0`，不落文件）。
  - `/api/customers`、`customer-save`、`customer-delete` 三处出参统一经 `custWithTicketCount` 挂 `ticketCount`。路由/白名单/权限**未改**（`customer-save`/`delete` 仍 deny-by-default 仅管理员；`/api/customers` 仍在 LINK_OK/FIELD_OK 供现场下拉）。
- **`tools/cu-01.test.mjs`**：新增扩字段落库+回读、非法 level/status 归一、编辑整条覆盖含扩字段、ticketCount 派生=0 用例；AC 标签去「现状」；真库冒烟断言「扩字段后仍无 customers 表」。11 用例全绿。

## 未改（护栏）
- **不迁 MySQL、不建 `customers` 表、不改 `db.mjs`**：客户仍走 `data/customers.json` 文件存储。迁库 = NEEDS-HUMAN（见 spec 附录）。
- 不臆造库列名/表名：真库仅核对 intakes.site（工单数派生关联源），未新增任何列。
- 提交端 `/api/customers` products 结构 `[{project,version}]` 保留不破坏（已冒烟核实）。

## NEEDS-HUMAN（随 spec 附录待裁决）
是否迁 MySQL / name 长度统一 60 vs 40 / name 是否唯一 / 工单数关联键 site↔name vs customerId / 负责实施人来源 / 停用切换端点+留痕。
