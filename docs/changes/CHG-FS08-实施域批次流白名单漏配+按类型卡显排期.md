# CHG · FS-08 实施域批次流被域名闸拒（白名单漏配）+ 按类型工单卡显排期

- 日期：2026-07-26
- 来源：用户反馈（2026-07-26）「实施端看不到批次/排期」
- 关联 spec：FS-08（AC-9b 新增·回归约束）、FS-05（AC-1c 新增·§4 同步约束补注）；改动 3 处代码 + 3 个测试。

## ① 关键 bug：FS-05 现场 4 端点漏配 FS08_FIELD_API → 实施域整段批次流被域名闸拒
- **现象**：运营域（admin, `intake-ops.lcpharmacy.cn`）调 `/api/field/batches` 正常返数据；实施域（field, `intake.lcpharmacy.cn`）调同端点返 `{"error":"forbidden"}`。实施端登录、页面都正常，唯批次流（按批次视图/下载/改版本/逐单验证）全挂，隐蔽。
- **根因**：FS-05 新增的 4 个现场端点 `/api/field/batches`、`/api/batch-download`、`/api/customer-version`、`/api/intake-verify` 当时只进了 `authGate` 内的 `FIELD_OK`，**漏加进 `server.mjs` 顶层 `FS08_FIELD_API`**（FS-08 域名层外层闸 `originGate` 的 field 域接口允许集）。`originGate('field', path)` 对不在 `FS08_FIELD_API ∪ LINK_OK ∪ FS08_AUTH_API` 的 `/api/*` 判 `deny` → 直接 403 forbidden，根本到不了 authGate。`FIELD_OK` 与 `FS08_FIELD_API` 是镜像常量、必须两处同步，此前漂移无测试守。
- **解法**：
  - `server.mjs` L741：把 4 端点加进 `FS08_FIELD_API`（与 `FIELD_OK` 对齐）。
  - **防漂移测试**（防再犯）：`tools/fs-08.test.mjs` 新增 `A-drift` 两条静态断言——从 `server.mjs` 源码抽取 `FIELD_OK` 与 `FS08_FIELD_API` 两 Set 比对，`FIELD_OK` 里每个 `/api/` 端点必须 ∈ `FS08_FIELD_API`（缺一即红）；并单独断言这 4 端点在 `FS08_FIELD_API`。另加 `B-AC7/9` 连真库冒烟：field 域 Host 调这 4 端点不被域名层 `forbidden`（交 authGate 得 401 未登录，而非越域 403）。
- **归类（§4.5）**：属 spec 含糊/漏边界暴露的坑 → **涉及 spec**，往 FS-08 补回归 AC-9b（`FIELD_OK` 的 /api/ 端点须 ∈ `FS08_FIELD_API`），FS-05 §4 补同步约束注 + 关联。

## ② 按类型工单卡显排期时间（用户想在按类型卡上也看到计划交付日期）
- **现象**：`/api/field/submissions`（按类型三桶）返回的工单不带批次排期；`mkItem`（工单卡）只显状态标签，无计划交付日期。
- **解法**：
  - `server.mjs`：`listIntake` 的 item 映射补 `batch: e.batch || ''`（原映射丢弃了 `data.batch`，导致 `field/submissions` 的 `it.batch` 恒 undefined——这是让排期挂上去的前置修复）；`/api/field/submissions` 建 `schedByBatch`（`loadBatches()` 的 `id→scheduleDate` 派生映射），`mapItem` 输出 `batchId` + `batchSchedule`（归批取批次排期，无批次/无排期空串，读时派生不落库）。
  - `public/field.html`：`mkItem` 读 `it.batchSchedule`，非空时上下文行追加「计划交付 <date>」（`.isched` 次要色，纯 `yyyy-MM-dd`），无排期不显。加 `.f-item-ctx .isched` CSS。未破坏卡片现有类型/标题/状态/上下文渲染。未用「发包」等 A6 禁词。
- **归类（§4.5）**：新展示字段/新行为 → **涉及 spec**，FS-05 补 AC-1c（按类型卡显排期 + 后端回传 batchId/batchSchedule）。

## 测试与验证
- 新/改断言：fs-08（A-drift x2 + field 域 4 端点非 forbidden 冒烟）；fs-05（连真库：batch-update 设排期 → field/submissions 归批单 batchSchedule=批次排期、未归批单空；静态 mkItem 消费 it.batchSchedule/计划交付/isched/条件渲染）；fs-02（B1 断言 field/submissions item 带 batchSchedule 字段、未归批为空串）。
- 回归全绿：`fs-08(30) + fs-05(21) + fs-02(26) + bp-01 + fs-01 = 119` pass 0 fail；另跑 tk-01/fs-03/fs-04 = 81 pass。随机端口 + `--test-concurrency=1`，`data/batches.json`/`data/customers.json` 无残留。
- 护栏：`server.mjs` `node --check` 过、改动区无隐形字符；`public/field.html` A6 禁词 0 / `localStorage` 0 / 零宽·BOM·nbsp 0。

## 未碰
- `public/batches.html`、`public/customers.html`、`public/inbox.html`、`assets/ui.js`、`assets/shell.js` 及其它已改逻辑均未触碰。
