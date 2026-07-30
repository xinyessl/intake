# CHG-FS-05 · 实施端「按批次视图」批次头显示排期时间（遗漏补齐）

- 日期：2026-07-26
- 类型：**遗漏补齐**（涉及 spec：往 FS-05 补一条回归 AC-1b，属「例外·bug 暴露 spec 漏边界」→ 算涉及 spec）
- 背景：批次排期字段 `scheduleDate` 是排期功能后加的（FS-05 第 4-6 期建按批次视图时已完成、尚无排期字段）。运营端已能设排期（`batch-arrange`/`batch-update`），但**实施端「按批次视图」看不到排期**（用户 2026-07-26 反馈：批次已排期但实施端看不到）。
- 根因：
  1. `GET /api/field/batches` 输出的批次 group 对象**没带 `scheduleDate`**（该端点建于排期字段之前，后加字段时漏同步这一处输出；`batchOut`/`batch-detail` 等其它出口都已带）。
  2. 前端 `public/field.html` `mkBatchGroup` 批次头也没渲染排期。

## 改动（仅 4 处，未碰其它已改逻辑）
1. **`server.mjs`** `/api/field/batches` 的 `groups.push({...})`：补 `scheduleDate: bt.scheduleDate || ''`（`bt` 是 `loadBatches()` 的批次，已有 `scheduleDate`；旧批次回读空串）。
2. **`public/field.html`**
   - `.f-batch-hd .bsched`/`.bsched.none` 样式（同 `.bpkg` 次要色，`.none` 用三级色显「未排期」）。
   - `mkBatchGroup` 批次头 `innerHTML` 追加：`g.scheduleDate` 非空 → `<span class="bsched">计划交付 <date></span>`（纯 `yyyy-MM-dd` 原样，无时间部分不套 `fmtTime`）；空 → `<span class="bsched none">未排期</span>`。**用「计划交付/排期」不用「发包」**（现场端 A6 禁词）。
3. **`tools/fs-05.test.mjs`**：新增两断言
   - `[排期]`（连真库）：`batch-update` 设 `scheduleDate='2026-08-15'` → `field/batches` 该批 group `scheduleDate` 回传该值；未排期批次 group `scheduleDate=''`。
   - `[前端·排期]`（静态）：`mkBatchGroup` 消费 `g.scheduleDate` + 有 `bsched` 类 + 「计划交付」+「未排期」文案 + 无「发包时间」类禁词。

## 未碰（明确）
- batches.html / customers.html / inbox.html / shell.js / ui.js 未动。
- 后端下载/改版本/逐单验证/闭环逻辑、`batch-arrange`/`batch-update`/`normScheduleDate`/`batchOut` 均未改（`batchOut` 早已带 `scheduleDate`，只是 `field/batches` 这个独立出口漏带）。

## 验证
- `node --check server.mjs`、`node --check tools/fs-05.test.mjs` 通过；field.html 内联脚本 `new Function` 语法过。
- field.html：`localStorage` 0 / A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）0 / 零宽·BOM·非断空格 0；改动区 server.mjs 隐形字符 0。
- 回归：`node --test --test-concurrency=1 tools/fs-05.test.mjs tools/bp-01.test.mjs tools/fs-01.test.mjs` → 61/61 全绿（含新增 2 断言）。
- 无残留：测试 after 还原/删 `data/batches.json`、`data/customers.json`；DB 内 `fs05smoke-*` 产品/工单/账号计数为 0。

## spec 同步
- FS-05 §A 补 **AC-1b**（排期可见 + `field/batches` 必回传 `scheduleDate` 的回归约束）。
