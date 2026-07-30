# CHG-WB-01 · 运营工作台 spec 回校到部署真相 + 新增连真库冒烟测试

- **日期**：2026-07-20
- **spec**：WB-01（运营工作台）
- **裁决**：前端事实源 = 部署实现（intake_bak/public/console.html + /api/overview），非原型 admin/dashboard.html。
- **类型**：spec 回校（行为无变化——回校为部署现状；属"涉及 spec"，spec diff 随验收拍板）+ 新增测试（**0 代码 / 0 库改动**）。

## 部署工作台真相（本单最重要产出）
> 原型 `admin/dashboard.html` 是一套「富工作台」（SLA 提醒条 + 5 张 lifecycle 统计卡下钻 + 本周批次 weekBatches + 各产品待评审 Top topProduct + 模型状态 models 摘要 + meta）。**实际部署 `console.html` + `/api/overview` 采用了另一套更简洁的「读时派生」看板，原型那套富区块一个都没实现。** 按裁决取部署为准。

- **`/api/overview` 现状返回**（server.mjs L722）：`{ projects, totals, recent, model }`——**无** `stats/weekBatches/topProduct/models/meta`（原型愿景）。
- **统计口径 = 旧粗粒度 `status`**（不是原型的 lifecycle 别名）：`totals={total,requirement,bug,待处理,沟通中,已归档,已处理}`。`total=requirement+bug`；`consult` 类被 `listIntake` 默认过滤、不计入。
- **`lifecycleToStatus` 映射**：`待处理→待处理`、`已关闭/暂缓/已驳回→已处理`、其余细粒度态→`沟通中`。故 **`已归档` 恒为 0**（值域不含它，遗留保留键）。
- **TK-01 新态对齐（重点核对项）**：TK-01 新增的「暂缓/已驳回」经 `lifecycleToStatus` 均并入 `已处理`——工作台 `totals.已处理` **正确含这两态、不漏算不单列**（连真库冒烟已断言 +2）。
- **`console.html` 渲染**：6 张统计卡（进件总数/待处理/沟通中/已处理/需求/BUG，**只读不可下钻**）+ 4 张功能磁贴（提交/收件箱/产品管理/模型配置）+ 产品概览 panel（行跳 `inbox.html?project=`）+ 最近进件 panel（≤12、按 submittedAt 倒序、行跳 `detail.html?project=&id=`、时间走共享 fmtTime）+ modelchip（model.configured 状态）。**无** SLA 条 / lifecycle 卡下钻 / weekBatches / topProduct / models。
- **数据源**：`db.mjs loadAll` 把每条进件**整份从 `data JSON` 反序列化**（列仅索引用）；聚合读内存缓存 `CACHE.intakes`（非 DB 实时）。真库 `intakes` 20 列已核对，**未臆造列**。

## 改动
- `docs/specs/WB-01-运营工作台.md`：整体回校——
  - frontmatter：`source`/`contract` 改为部署实现；`prototype` 标注「仅参考·未采纳」。
  - 顶部新增 §0「事实源裁决」横幅，明确原型富工作台愿景（SLA/5-lifecycle 卡/weekBatches/topProduct/models/meta）**未采纳、不作验收标准**。
  - §2~§5 重写为部署现状（AC 由原 16 条原型富版 → 14 条部署版；接口契约改为 `/api/overview` 现状四字段；数据契约按真实 20 列 + `lifecycleToStatus` 口径）。
  - 原型 NEEDS-HUMAN（BP-01 批次源 / DM-02 lifecycle 细粒度口径 / 客户名列 / 本月交付口径）整体降级为「随原型愿景搁置」，逐项标 NH，明确"要落另开新 spec、不据原型判本条不达标"。
  - §7 测试要点指向已落地 `tools/wb-01.test.mjs`；§8 DoD 勾选部署已满足项。
- 新增 `intake_bak/tools/wb-01.test.mjs`：10 用例（连真库冒烟 + `/api/overview` 接口），全绿；隔离产品 `wb01smoke-*` + after 精确删 intakes/projects/kb_entries，**不污染真库**（已核对 0 残留、总数仍 18）。

## 覆盖的 AC（回校后）
- 现状符合（0 代码增量，纯核对 + 测试）：AC-1~AC-14 全部——`/api/overview` 结构、totals 口径三桶、TK-01 新态并入已处理、已归档恒 0、recent 倒序≤12、产品 count/hasRepo、未登录 401、空态降级、fmtTime、modelchip。
- 本单补：**测试**（此前 WB-01 无测试）+ **spec 回校**（此前按原型，与部署不符）。**代码/库：0 增量。**

## 未动（护栏）
- 未改 `server.mjs`（含 `/api/overview`）、`db.mjs`、`public/console.html` 及共享外壳 `nav.js/app.css/ui.js`；未加库列/未建表；未碰其它 spec / 测试 / package.json。纯 spec 回校 + 新增独立测试文件。

## 仍需人拍板（NEEDS-HUMAN，留待）
1. **统计口径是否升级到 lifecycle 细粒度**：部署用旧三桶（待处理/沟通中/已处理），非原型的五卡（待评审/已落实/开发中/本月交付/待发包）。若产品要细分展示，属新需求（改 overview + console.html），**另开新 spec 评审**，本条按现状验收。
2. **是否要原型富区块**（SLA 提醒条 / weekBatches / topProduct / models 摘要）：均依赖 BP-01（批次表未建）/ DM-02（lifecycle 别名），且属未采纳愿景——要落逐一另开 spec。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
