# CHG-FS-05 计划交付（排期时间）提升为醒目 chip + 系统视图卡也显

- 日期：2026-07-26
- 关联 spec：FS-05 AC-1c（微调：底部灰字 → 顶行醒目 chip + 系统视图同显）
- 触发：用户反馈（2026-07-26）——实施端工单卡「计划交付（排期时间）」放在底部上下文行灰字里**太不起眼、没看到**；且系统视图卡当时**没加**。
- 分类：**逻辑/展示行为调整（涉及 spec）** —— 已同步微调 FS-05 AC-1c。

## 改动
1. `public/field.html · mkItem`（按类型卡）：把「计划交付 <date>」从底部上下文行灰字（`.f-item-ctx .isched`）**移到卡片顶行**（`.f-item-top`，类型标签 + 状态标签之后），渲染为醒目 chip `<span class="f-sched-chip"><i class="ti ti-calendar-event"></i> 计划交付 <yyyy-MM-dd></span>`；仅 `it.batchSchedule` 非空才显；**底部去掉原 `.isched`**（不重复）。
2. `public/field.html · mkSysItem`（系统视图卡）：镜像 mkItem，在其顶行加**同款** `.f-sched-chip`「计划交付 <date>」；仅非空显。
3. `public/field.html · CSS`：新增 `.f-sched-chip`（浅青底 `--color-accent-light` + 强调色字 `--color-accent` + 强调边框，小圆角 pill，日历图标）——与状态标签（warning/primary/gray）配色分明、一眼可见；删除已不再使用的 `.f-item-ctx .isched` 规则。
4. `tools/fs-05.test.mjs`：更新 mkItem 排期断言（`isched` → `f-sched-chip` 且在顶行、`doesNotMatch(/isched/)`），新增 mkSysItem chip 断言、`.f-sched-chip` 样式断言、以及**连真库** `dimension=sys` 归批工单带 `batchSchedule` 冒烟。

## 后端核查结论（无需改 server.mjs）
- `/api/field/submissions` 的 `mapItem`（server.mjs L1817）已挂 `batchSchedule`（`bid ? schedByBatch.get(bid) : ''`，读时按 `loadBatches()` 派生、不落库）。
- `dimension=sys` 分支（L1818-1830）与 `hosp` 分支（L1839）**复用同一个 `mapItem`**，故系统视图 item 本就带 `batchSchedule` → 前端直接用，**server.mjs 一字未改**。连真库冒烟已断言 `dimension=sys` 归入 BATCH_1 的单 `batchSchedule='2026-08-15'`。

## 验证
- field.html：A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）0、`localStorage` 0、隐形字符 0、内联脚本 `new Function` 语法通过。
- server.mjs：未改（`git diff --stat` 空、`node --check` 通过）。
- 回归：`node --test --test-concurrency=1 tools/fs-05.test.mjs tools/fs-02.test.mjs tools/fs-03.test.mjs tools/fs-01.test.mjs` → fs-05 24/24、fs-02 26/26、fs-03 19/19、fs-01 21/21 全绿（随机端口 + 串行）。
- 无残留：`data/batches.json` 由 fs-05 after 钩子还原（`git status --short data/` 空）。

## 未碰
- `batches.html`、`customers.html`、`inbox.html`、`assets/ui.js`、`assets/shell.js`、以及其它已改逻辑均未触碰。

## 风险
- 低。纯前端展示提升（chip 位置/样式）+ 测试补充，后端零改；chip 复用 theme.css `--color-accent*` token（无硬编码色值）；`ti-calendar-event` 图标与 batches.html 排期图标一致。
