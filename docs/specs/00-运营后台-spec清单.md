# 运营后台 · Spec 清单（页面粒度 · 已生成）

> 由 `docs/P0-数据模型对账与接口清单.md` + 新版原型（`Desktop/Prototype/intake/prototype/admin/*.html`）拆出。
> **一页一 spec**（页面对齐原型、逻辑参照 `intake_bak` 真实代码、数据契约对齐真实库）。全部 `status: draft`，待评审 `draft→ready` 后按 `depends_on` 开 `/build`。
> 复用度：♻️大半现有(接真接口+对齐样式) / 🔧小扩展 / 🆕从0新增

## 已生成 spec（9 条 · ~173 AC）

| ID | 标题 | 原型页 | AC | 优先级 | depends_on | 复用 | 备注 |
|---|---|---|---|---|---|---|---|
| **UI-01** | 后台外壳与设计系统 | shell.js/theme.css | 26 | Must | — | ♻️ | 只消费 /api/me·notifications·logout，不建表 |
| **WB-01** | 运营工作台 | dashboard.html | 16 | Should | UI-01,TK-01 | ♻️ | 扩展 /api/overview（+批次统计） |
| **TK-01** | 工单管理 | tickets.html | 30 | Must | UI-01 | 🔧 | **含状态机扩展**（原 DM-02 并入）：新增 暂缓/已驳回 态 + `batch/stewardUC` 落 data JSON |
| **BP-01** | 批次与发包 | batches.html | 15 | Must(P2) | TK-01 | 🆕 | **含发包回收+steward三接口**（原 BP-02/ST-01/02/03 并入）：新增 `batches` 表 + 9 端点 |
| **PD-01** | 产品管理 | products.html | 20 | Should | UI-01 | ♻️ | 0 新增接口；提交/版本/同步为读时派生 |
| **CU-01** | 客户 / 医院管理 | customers.html | 19 | Must | UI-01 | 🔧 | **含客户迁库**（原 DM-01 并入）：新增 `customers` 表 + level/region/impl/status 列 |
| **KB-01** | 经验库 | knowledge.html | 17 | Should | UI-01 | ♻️ | 全复用；kb-save 需微扩 source/from_ref |
| **MC-01** | 模型配置 | models.html | 11 | Could | UI-01 | ♻️ | 全复用；文件存不入库；Key 掩码/切备 |
| **AM-01** | 账号管理 | accounts.html | 19 | Should | UI-01 | 🔧 | 负责医院复用 `sites`；补 `enabled` 列（NH-1 已裁决，停用接入登录拦截） |

> 说明：初版清单曾把 TK 拆 3 条、DM 单列、BP/ST 拆 5 条；因「页面跟原型一样」，改为**页面粒度**。原子级拆分作为各 spec 内的小节保留：
> - **DM-01 客户迁库** → 在 `CU-01` §5 建表；**DM-02 状态机扩展** → 在 `TK-01` §5.3。
> - **BP-02 发包回收 / ST-01·02·03 steward** → 在 `BP-01`（作为 P2 基线，steward 契约拍板后细化）。

## 分期
- **P1（先干，不等 steward）**：UI-01 · WB-01 · TK-01 · PD-01 · CU-01 · KB-01 · MC-01 · AM-01（8 条）。
- **P2（等 P0 §E steward 契约）**：BP-01（批次+发包+对接）。CU 的「版本回写」小节亦属 P2。
- **P3**：实施端（另端，另立 spec 树）。

## ⚠️ 评审时须先拍板的跨条决策（各 spec NEEDS-HUMAN 汇总）
1. **全站主色**：原型 `theme.css` 实为 **#3A4CA8（靛蓝）**，非口头的 #1A6DBE（医疗蓝）。定一个。〔UI-01〕
2. ✅ **[已裁决 2026-07-20] 角色枚举**：定 4 类 `admin`(管理员)/`pm`(产品经理)/`dev`(开发)/`impl`(实施)；**收紧 `isAdmin`——`dev` 区别于 `admin`、不再放行后台**（存量 dev 管理员账号须迁 admin 同批上线）。〔AM-01 NH-4〕
3. **客户是否迁 MySQL**：现 `data/customers.json` 最简 → 新 `customers` 表（+等级/地区/负责实施/状态/工单数）。〔CU-01 / P0 决策3〕
4. **steward 对接契约**：拉 vs 推、鉴权（服务账号）、发包产物 URL vs 上传、重复 release 幂等。〔BP-01 / P0 §E〕—— 整个 P2 卡这个。
5. **工单状态口径**：确认「待评审=待处理/分析中、已落实=已立项」为展示别名；新增「暂缓/已驳回」两态。〔TK-01 / WB-01〕
6. ✅ **[已裁决 2026-07-20] account 状态列**：加 `enabled TINYINT DEFAULT 1`，停用直接接入登录拦截。〔AM-01〕
7. **kb-save 微扩**：是否接受 `source`/`from_ref` 入参（原型"来源/来源工单"）。〔KB-01〕
8. 次要口径：工作台"本月已交付"按 lifecycle 变更 vs 发包时间；客户-工单关联键 `site↔name` vs `customerId`；产品/客户名长度 40 vs 库列宽。

## 评审 / 开工顺序建议
1. **先拍上面 8 条决策**（尤其 1/2/3/4）——它们影响多条 spec 的数据契约。
2. **UI-01 先 ready 先建**（其它都依赖）。
3. P1 其余 7 条**并行 `/build`**（各改各的文件，不冲突）。
4. **BP-01 等 steward 契约**拍板后再进 ready。
