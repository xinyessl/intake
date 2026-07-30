# CHG-FS-02 · 实施端「按批次」降级不回弹、改批次容器空态提示

- 日期：2026-07-23
- 类型：降级呈现的行为调整（AC-15 降级 UX：从「回弹按类型 + 顶部提示条」→「保持按批次 + 空态提示」）→ 涉及 spec（改 FS-02 AC-15/AC-9）
- 关联 spec：FS-02（AC-15 降级措辞改写 + AC-9 补「tab 始终随点击切换不回弹」+ §4.1 出参注「前端不再消费 fallback」）
- 关联测试：tools/fs-02.test.mjs（A8 重写；B4 后端契约断言保持不变）

## 现象（用户反馈）
`public/field.html`「提交清单」点「按批次」后：**按钮没切过去（仍高亮按类型）、但内容变了**（显了降级提示条 + 按类型列表），很割裂。

## 根因
批次分组是 P2、后端恒返回 `degraded:true`。`loadSubmissions` 旧降级分支：
```
if (b.degraded) { state.groupBy='type'; 把 .on 切回按类型; loadSubmissionsType(...); return; }
```
而 `setGroupBy('batch')` 先把按钮/`state.groupBy` 切到「按批次」，紧接着降级分支又把它俩**弹回按类型** + 显降级提示 + 加载按类型列表 → 用户看到「按钮没切过去、内容却变了」。

## 解法（用户裁决：点了按批次就该切过去、不回弹）
`public/field.html`：
- `loadSubmissions` 降级分支不再改 `state.groupBy='type'`、不再把 `.on` 切回按类型；改调新增的 `renderBatchDegraded(b.msg||fallback)`。
- 新增 `renderBatchDegraded(msg)`：隐藏 `fListType`、显 `fListBatch`（保持按批次视图），在批次容器 `emptyHtml('ti-calendar-stats','批次分组暂未开放', msg)`（复用 `.f-list-empty` 空态，未新增样式类）。
- 删死码 `loadSubmissionsType`（原**仅**被降级分支调用，改后无引用）。
- 简化 `renderTypeView`：删 `degradeMsg` 形参与 `.f-degraded` 提示条分支（该参数原仅由 `loadSubmissionsType` 传非空，现已删）；正常路径 `renderTypeView(b.groups||[])` 不变。
- 删已成死码的 `.f-degraded` CSS（两行，改用空态呈现后无引用）。
- 前端 fallback 文案沿用「批次分组功能待运营端上线后开放」（避 FS-01 A6 禁词「发包」；后端真实 msg 含「发包」由 `/api/field/submissions` 透传、不落 field.html 源，见 lessons L-008/L-009）。

## 未改（明确边界）
- **未碰 `server.mjs`**：后端降级契约 `{degraded:true, fallback:'byType', groups:[], msg:'…发包…'}` 完全不变；`fs-02.test.mjs` B4 后端断言原样保持。
- 未碰其他页 / ui.js / 系统视图逻辑 / 已改好的子项目下拉双键（问题①）等。

## 涉及 spec（附可审 diff · 见 /accept 门）
- AC-15：由「默认切到『按类型』+ 顶部提示」改为「保持『按批次』选中不回弹 + 批次容器空态提示（复用 `.f-list-empty`）」；补「按批次恒 degraded 属预期，BP-01 上线后自然显真实批次」。
- AC-9：补「点回『按批次』→ `.f-tab2` 始终随点击切换、不回弹」。
- §4.1 出参：加注「2026-07-23 起前端不再消费 `fallback` 字段做切按类型；`fallback` 保留作向后兼容信息字段」。

## 影响面
仅 `public/field.html` 医院视图降级呈现 + `tools/fs-02.test.mjs` A8 + FS-02 spec。后端行为零变化，其余 spec/模块无波及。
