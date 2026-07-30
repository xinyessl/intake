# CHG-BP-01 · 批次「排期时间（计划交付日期）」

- **日期**：2026-07-26
- **触发**：用户 2026-07-26 反馈——定档建批时没处填排期时间、批次建好后也没处改。
- **分类**：逻辑/行为调整（加字段 + 新端点）→ **涉及 spec**，已同步 BP-01 spec（新增 §3.G 排期时间 AC-19/20/21、§4.1 端点表加 `batch-arrange.scheduleDate` + 新增 `batch-update`、§5.1 存储结构加 `scheduleDate`、实现进度补一条）。此 CHG 仅作交付留痕，spec diff 才是审阅对象。

## 改动
### 后端 `server.mjs`
- 新增 `normScheduleDate(v)`：只认纯日期 `yyyy-MM-dd`，非法/空 → `''`（不报错）。
- `batch-arrange` 入参加可选 `scheduleDate`，建批时落 `scheduleDate=normScheduleDate(...)`，`arrange` history note 附「·排期 X」。
- `batchOut` 默认补 `scheduleDate:''`（旧批次无该键时列表/详情也回读到空串）。
- 新增 `POST /api/batch-update`（admin·未进 FIELD_OK/LINK_OK → 非 admin 自动 403）：入参 `{id, scheduleDate}`，本期只开放改 `scheduleDate`（`'scheduleDate' in b` 才改，规范化后不同才写 + `history` 记 `action:'update'` 留痕）；任意状态批次可改，不改批次状态；批次不存在 → 404。**预留结构可扩别的元字段**。

### 前端 `public/batches.html`
- 定档建批对话新增「排期时间（计划交付）」`<input type=date id=arSchedule>`（可空），`batch-arrange` body 带 `scheduleDate`；开对话时清空该输入。
- 详情抽屉新增「排期时间（计划交付）」行：显示 `scheduleDate` 或「未排期」+「改排期」内联编辑（`<input type=date id=schInput>` + 保存 → `batch-update {id,scheduleDate}` → toast + `loadBatches()` + `openDetail()` 刷新；取消收起）。**已建的 B-01 也能在此补设**。
- 列表卡片 `.bsub` 加排期展示（`排期 <yyyy-MM-dd>`，未设显「未排期」灰字）。
- 日期统一纯 `yyyy-MM-dd`（原生 `<input type=date>` 值即此格式，**不走 ui.js `.select` 增强**，读值 `input.value` 无 wrapper 干扰）。

### 测试 `tools/bp-01.test.mjs`（连真库）
- AC-19：`batch-arrange` 带合法排期→落库 / 不带→空 / 非法→空（不报错），直连 `batches.json` 断言。
- AC-20：`batches` 列表 + `batch-detail` 返回体含 `scheduleDate`，回读一致。
- AC-21：`batch-update` 改成功 + 回读一致 + `history` 记 update + 任意状态（含已交付 CHECKLIST_BATCH）可改且不改状态 + 非法日期清空 + 非 admin 403 + 非法 id 404。
- 非 admin 403 用例补 `batch-update`。前端静态断言补一条（排期 date 输入 / batch-update 调用 / saveSchedule / 未排期 / 列表显示）。

## 验证
- `node --check server.mjs` 通过；server.mjs 改动区 + `batches.html` 隐形字符 0；`batches.html` 不自写 `.page-content`（=0）；内联 JS `new Function` 解析通过。
- `node --test --test-concurrency=1 tools/bp-01.test.mjs` → 21 绿（含 3 新 AC + 1 前端排期用例）；`batches.json` 备份还原/整删，测后无残留。
- 回归 `bp-01 + fs-05 + ui-shell` → 55 pass / 3 skip（既有条件冒烟）/ 0 fail，批次/实施端消费/后台壳均未破坏。

## 未碰
`field.html`、`customers.html`、`inbox.html`、`shell.js`、`ui.js` 及其它已改逻辑；第 1-3 期的 `batches.json` / 6 端点复用未推翻。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
