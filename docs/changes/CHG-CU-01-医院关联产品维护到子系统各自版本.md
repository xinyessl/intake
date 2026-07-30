# CHG · 医院关联产品维护到「子系统 + 各自版本」（向后兼容旧产品级版本）

- **日期**：2026-07-23
- **类型**：逻辑/行为调整（新特性，涉及 spec）→ CU-01 / FS-02 / FS-03 均有 spec diff（见各 spec）
- **裁决**：用户 2026-07-23 裁决「选子系统 + 各自版本」（相对「产品级单一版本」）。
- **关联 spec**：CU-01 AC-8c/AC-9 + 数据模型表 + customer-save 契约；FS-02 AC-6 + §5.2；FS-03 AC-18 + 数据模型表。

## 背景 / 问题
旧模型 `customer.products[i] = {project, version}`（产品级版本）导致：一家医院被迫显示产品定义的**全部**子系统、版本只有产品级；实施端归档条「系统：报表系统 · 现场版本：合理用药 —」对不上（子系统与版本错位）。

## 改动（新形状 + 向后兼容，不做破坏性迁移）
- **新形状**：`customer.products[i] = { project, subsystems:[{name,version}] }`——勾选的子系统各维护一个版本（`name`∈该产品 `subsystems[].name`，`version`≤30）。
- **兼容旧形状**：老数据 `{project, version}`（无 `subsystems` 字段）**照存照读**；消费方遇无 `subsystems` 的产品 → 兜底按「该产品全部子系统 @ 该产品级 version」处理（= 保持现状行为）。**绝不删老字段、不强迁**——老医院编辑保存时（前端带 subsystems）才无损升级成新形状。

## 三处改动
1. **server.mjs 数据模型**：新增 `normProduct(p)`（单产品规范化，新形状 subsystems name 命中校验 + version≤30 + 去重、旧形状原样保留）；`normCustomer` 的 products 规范化改走 `normProduct`。`/api/customers`/`customer-save`/`customer-delete` 结构不变，products 原样透传新旧形状。**未改** impl 写穿/派生逻辑、ticketCount 派生、账号隔离。
2. **运营端 public/customers.html**：编辑抽屉「关联产品」每个产品卡展开该产品子系统清单（`[☑勾选] 子系统中文名 [版本下拉]`）；`collectProducts` 产出 `{project, subsystems:[{name,version}]}`（只收勾选）；换产品重建清单；编辑回填新形状勾选+回填版本 / 旧形状默认勾全部+预填产品级版本（保存即无损升级）；列表页新形状显「产品 · N 个子系统」、旧形状显「产品 版本」。复用 `fetchVersions`/`fillVerOptions`（ui.js 增强下拉、动态 options 自动重同步、历史值保留）。
3. **实施端 public/field.html（消费）**：`buildSubOptions` 新形状只列维护的子系统 + 记各自 version、旧形状兜底列全部子系统@产品级 version；新增 `subVersion(name→version)`；`currentArchive` 医院视图 `out.version` 取所选子系统版本（`subVersion(curSub)`）、未选回退产品级；`renderHospChip` 现场版本列支持新形状（各子系统各自版本）、选中子系统段并显该子系统版本。**未动** per-system 会话/必选守卫/reopen/子项目下拉双键/归档条显子系统/subsystemLabel/按批次降级/系统视图那套。

## 未碰
ui.js（自定义下拉组件，复用即可）、其他页、impl-sites 已改逻辑、已改好的实施端逻辑（per-system 会话/必选守卫/reopen/双键/归档条子系统/subsystemLabel/按批次降级）。

## 测试
- cu-01：新形状静态（产品卡子系统清单 + 逐子系统版本下拉）+ 连真库（存带 subsystems 回读一致、防臆造丢弃不属该产品的 name、version 截 30、去重、无勾选保留空数组、**旧形状 {project,version} 仍可存读**兼容回归）。
- fs-02：A2d 静态（buildSubOptions 新形状只列维护子系统 + 记 version / 旧形状兜底全显）+ B6b 连真库（新形状客户回读子系统各自版本）。
- fs-03：A7b 静态（currentArchive/renderHospChip 版本取子系统版本、仍不调 /api/versions）。
- 回归全绿：cu-01/fs-02/fs-03/fs-06/fs-04/fs-01/ui-select（173/173），真库无本次残留，customers.json 复原不存在态。

## 风险
- 现有客户数据（旧形状）不被破坏：兼容分支保证照存照读、消费方兜底全子系统@产品级 version，实施端旧医院仍正常（已回归验证）。
- 关联键仍是医院名/子系统英文 name（重名/子系统改名会串号，同既有 NEEDS-HUMAN 限制）。
