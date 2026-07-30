# CHG-FS-05 · 实施侧批次消费（下载 / 一键改版本 / 逐单验证 / 按批次视图）

- 日期：2026-07-24
- 类型：新特性实现（FS-05 第 4-6 期一次做完，BP-01 全期 1-6 至此打通「上传包 → 下载 → 改版本 → 逐单验证 → 批次交付」全链路）→ 涉及 spec（FS-05 `ready`，已在 spec 头补「🚧 实现进度」+ NH 裁决落地）
- 关联 spec：FS-05（AC-1~23 主线；NH-1/2/3/5 已裁决落地，NH-4 待办 popover / NH-6 size 未做）；BP-01（全期完成）
- 关联测试：新增 `tools/fs-05.test.mjs`（17 用例·连真库）；改 `tools/fs-02.test.mjs`（A8 重写、B4 加说明——见下「spec 同步纪律」）

## 改动文件
- `server.mjs`：新增 4 端点 + `custSubVersion` helper + 4 端点路径加进 `FIELD_OK`（现场 impl/pm 可调 + 端点内按 `user.sites` 二次收敛）。
  - `GET /api/field/batches`：当前账号相关批次（覆盖工单含其 sites 医院单 + `user.projects` 可读）→ 每批带元信息 + 该账号 sites 范围内覆盖工单（按子系统中文分组，逐单 `lifecycle/statusLabel/canVerify`）+ 覆盖我负责医院。别账号/别医院单不泄露。
  - `POST /api/batch-download`：校验「可下载/已交付」批次 + 该账号 sites 在覆盖医院内 → `downloads+1`（按账号 `downloadedBy[]` 幂等）+ 该账号 sites 范围内覆盖工单 `已出包→待验证`（系统动作直接置态 + 留痕，同 batch-release 范式，不硬走 intake-transition）+ 返回 `bumps`（我负责医院 × 子系统 `fromVer→toVer`）。越权/非可下载拒。
  - `POST /api/customer-version`：校验 site∈user.sites → 回写 `data/customers.json` 新形状 `products[].subsystems[].version` / 旧形状 `products[].version`（同值幂等·不重复留痕，`versionLog[]` 逐条留痕）。客户不存在/产品不属/空版本 400；越权 403。
  - `POST /api/intake-verify`（薄封装真库流转）：校验 site∈user.sites + lifecycle=待验证 → pass `待验证→已关闭`（关闭即自动沉淀经验库）；fail `待验证→已重开`+note 反馈进 history；非待验证态 400；越权 403。pass 后若该单所属批次全部覆盖工单已关闭 → 联动置批次「已交付」（闭环）。
- `public/field.html`：按批次视图（`groupBy=batch`）从旧降级占位 `renderBatchDegraded` 改为 `loadBatchView` 调 `/api/field/batches` 真实渲染——批次卡（状态徽标三态）+ 更新包卡（下载）+ 改版本条（一键改版本）+ 逐单验证（确认验证过 / 反馈问题）；仍无相关批次 → 友好空态。新增 `.f-batch-*`/`.f-pkg-card`/`.f-bump-*`/`.f-verify-btn`/`.f-reject-btn` 样式（复用 theme.css token）+ `showToast`（自实现，复用 theme.css `.toast`）。删旧 `renderBatchDegraded`。
- `tools/fs-05.test.mjs`：新建（连真库·17 用例）。

## 数据边界 / 幂等 / 闭环（护栏）
- 隔离：4 端点均端点内按 `user.sites` 二次收敛，忽略前端越权传参；越权 403 / 收敛不泄露（对齐 FS-01）。
- 幂等：下载按账号 `downloadedBy[]` 去重不重复计数；改版本同值不重复写不重复留痕。
- 闭环：intake-verify pass 后全单关闭 → 批次「已交付」；fail → 工单「已重开」，批次态不回退（对齐 BP-01 AC-18）。
- 未改库：批次/客户/versionLog 均文件存（`data/batches.json`/`data/customers.json`），不加 MySQL 表；工单 batch/lifecycle 落 `intakes.data` JSON。

## spec 同步纪律（§4.5）
- FS-05 是 `ready` 大特性的实现 → 已在 spec 头补「🚧 实现进度」+ NH-1/2/3/5 裁决落地说明（可审）。
- **FS-02 test 连带改**（FS-05 推翻 FS-02 AC-15「按批次恒降级占位」）：
  - `A8` 重写：从断言「degraded/renderBatchDegraded/批次分组暂未开放」→ 断言「loadBatchView 调 /api/field/batches 真实渲染 + 下载/改版本/逐单验证 UI + 旧降级函数/文案已移除」。
  - `B4` 保留（`/api/field/submissions?groupBy=batch` 遗留后端契约仍返 degraded:true，前端不再消费）：加说明注释，确保未误删/未改成 500（向后兼容）。真实按批次数据/隔离/闭环在 fs-05.test.mjs 覆盖。

## 回归
`node --test --test-concurrency=1 tools/fs-05.test.mjs tools/bp-01.test.mjs tools/fs-02.test.mjs tools/fs-06.test.mjs tools/fs-01.test.mjs tools/cu-01.test.mjs tools/tk-01.test.mjs` → 188 全绿；另跑 fs-03/fs-04/fs-07 → 95 全绿。真库无 FS-05 残留（无 fs05smoke-* 产品/工单/账号；batches.json/customers.json 还原）。
