# CHG · UI/inbox · 工单管理漏斗「已落实·排期」不再误计已归批工单（effLifecycle 展示修正）

> 日期：2026-08-06　类型：纯 bug 修复（展示层，不改后端/不改工单数据）　来源：用户反馈
> 关联：`public/inbox.html`（仅前端展示层；**不动** server.mjs 的 batch-arrange / batch-release）
> 不涉 spec：后端流转设计如此（见根因），问题纯在 inbox 展示口径与 batch-arrange「可归批集」不一致，规约无需改。

## 现象
工单管理顶部漏斗「已落实·排期」计数=1（`BUG-20260806-01`，lifecycle=`已立项`），但该工单 `batch=HLYY-0815` **已归批**；到批次管理点「定档建批」却提示「该产品当前没有已落实待分批的工单」。两边矛盾、用户报 BUG。

## 根因（设计如此，不改后端）
- `batch-arrange`（定档建批）归批时**只写 `e.batch`、不改 lifecycle**（server.mjs L1298）；其「可归批集」= `lifecycle=已立项 且 e.batch 为空`（L1285）。
- `batch-release`（出包）才把工单从「已立项」**直跳「已出包」**（故意跳过「开发中」减中间态）。
- 所以**已归批工单在数据上仍是「已立项」**。inbox 展示层把「已归批的已立项」仍算作「已落实·排期(待分批)」，与 batch-arrange 的「可归批集」口径不一致 → 漏斗多计、与建批提示矛盾。

## 改动（仅 `public/inbox.html`）
- 新增 `effLifecycle(item)`：**`item.lifecycle==='已立项' && item.batch` → 返回 `'开发中'`（它已在开发中批次里），否则返回 `item.lifecycle`**。（`listIntake` 已在列表项返回 `lifecycle`+`batch`，前端 `allItems` 直接可取。）
- 用到三处：
  1. **漏斗分桶计数** `renderPipeline`：`pipeOfLifecycle(effLifecycle(i))` 归桶。
  2. **行状态标签** `renderList`：`const lc=effLifecycle(i)||'待处理'`（`stTag`/`isReview` 都按它——已立项/开发中均非 review 态，行操作不变）。
  3. **状态/流水线筛选** `getFiltered`：`f.status`/`f.pipe` 均按 `eff=effLifecycle(i)` 判定，保证筛「已落实·排期」不再命中已归批工单，点漏斗「开发中」能命中它。
- **不改任何工单数据**，不动 batch-arrange/batch-release，不动详情页 `detail.html`（详情/抽屉仍显真实 lifecycle=已立项 + 「交付进度」卡片引批次，语义自洽）。归并视图（server 聚合、无 per-item batch）不在范围。

## 影响面
- 仅 inbox 列表视图的漏斗计数 / 行标签 / 筛选三处口径统一为 effLifecycle。状态下拉选项（`待处理/已立项/已出包/待验证/已关闭`）未加「开发中」项——已归批工单经漏斗「开发中」环点击（`f.pipe='开发中'`）可达；选「已立项」下拉则正确排除已归批工单（符合目标）。
- 未归批的「已立项」、其它态一律原样，无回归。

## 冒烟（真库·prod admin 会话）
- `GET /api/intake-list?project=hlyy` 返回 `BUG-20260806-01 = {type:bug, lifecycle:"已立项", batch:"HLYY-0815"}`，列表项含 `lifecycle`+`batch`。
- 按 PIPE + effLifecycle 归桶：**旧 已落实·排期=1 / 开发中=0 → 新 已落实·排期=0 / 开发中=1**；`BUG-20260806-01` 行标签 已立项→开发中。全部 PASS，与「定档建批仍提示无可归批」一致、不再矛盾。
- prod 拉 `inbox.html`（admin 会话）含 `effLifecycle`×4，HTTP 200。

## 部署
scp `public/inbox.html` → prod `/opt/intake/public/inbox.html`（显式完整文件路径）。静态每请求读盘、不重启。
