# CHG-FS-02 · 实施端子项目下拉显中文 desc（问题①）

- 日期：2026-07-23
- 类型：显示 bug 修复（+ spec AC 澄清，非行为语义变更）
- 关联 spec：FS-02（AC-6/AC-7 已补「子系统双键」一句：显中文 desc、过滤用英文 name）
- 关联测试：tools/fs-02.test.mjs（新增 A2b 双键静态断言 + B6 desc 回读）

## 现象
`public/field.html` 医院视图「全部子项目 ▾」下拉把子系统映射成**英文 name**（`(s&&s.name)||''`），下拉显示 `audit/report/intervene/review/pkb` 等英文，用户看不懂——而这些子系统**都有中文 `desc`**（audit→审方、report→报表系统、intervene→干预、review→点评、pkb→合理用药引擎&工具库）。

## 根因
`buildSubOptions` 只取 `name`（英文），`renderProdDD` 用 `escapeHtml(sub)` 直接显英文 name。与 FS-03 系统视图已落地的「value=英文 name / display=中文 desc」双键语义不一致（系统视图有 `sysLabel`，子项目下拉没有对应映射）。

## 解法（照系统视图同款双键 · 仅改显示、不改过滤）
`public/field.html`：
- `buildSubOptions`：`subs` 从 `[名]` 改成 `[{name, desc:desc||name}]`（保留按产品分组）。
- 新增 `subLabel(name)`：查 `state.subOptions` 得该子系统 `desc`（无则回退 name）。
- `renderProdDD`：`data-sub` 仍= **英文 name**（过滤值不变）、`selectSub(name)` 仍传英文 name、显示文案改 `desc||name`（中文）。
- `selectSub`：选中标签 `setProdLabel(subLabel(curSub))`（显中文 desc）。
- 空态提示 `'「'+subLabel(state.curSub)+'」子项目下暂无记录'`（显中文）。
- **过滤仍按英文 name**：`loadSubmissions` 的 `&subsystem=state.curSub`（=name）匹配 `intakes.subsystem` 不变；只有显示变中文。

## 为何不改 spec 语义（仅澄清 AC）
FS-02 spec 原 AC-6/7 未写死「显英文 name」，本次只是把「显示 desc / 过滤用 name」的双键口径**显式写进 AC**（与已落地的 FS-03 系统视图一致），不改变筛选行为，故记 CHG + AC 澄清，不新增行为。

## 影响面
仅 `public/field.html` 子项目下拉显示。未碰 ui.js / 其他页 / impl-sites / consult-kb / 系统视图逻辑。过滤/取数路径（customers.products→projMap.subsystems、&subsystem=name）不变。
