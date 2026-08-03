# CHG · BP-01 / FS-05 · 更新包清单/SQL 改「按版本独立维护 + 跨版本累积」

> 日期：2026-08-04　类型：大特性（涉及 spec，spec diff 已附 BP-01 §I·AC-24~30 / FS-05 §K·AC-34~35）　来源：用户拍板
> 本条记录**随该特性一并做的重构/dead-code 处理**（行为不变的部分，不单独进 spec）。

## 用户拍板模型（照做）
1) 按版本(git tag)登记 delta 任务+SQL（不绑包）；2) 部署时按 (现场版本X, 目标版本Y] 累积区间内已登记版本；3) SQL 系统不执行只列出；4) 累积 SQL 可合并单文件下载；5) 版本来源=git tag（listVersions）；6) 累积起点=现场版本；7) 完成度按 (医院×产品×版本×条目)。

## 新增（行为变更 → 已进 spec）
- 后端 5 端点（server.mjs）：`version-release-save`（仅管理员）+ `version-releases` / `field/update-plan` / `field/update-toggle` / `field/update-sql-merged`（4 个 field·入 FIELD_OK+FS08_FIELD_API 双 Set）。
- 纯逻辑模块 `tools/version-plan-logic.mjs` + 单测 `tools/version-plan.logic.test.mjs`（17/17 本地绿·无需 MySQL）+ 集成 smoke `tools/version-plan.test.mjs`（需 MySQL·本地未跑）。
- 数据：`data/version-releases.json`（新，文件存）+ `customer.updateProgress`（normCustomer 用 `'updateProgress' in b` 保留）。
- 运营新页 `public/releases.html`「版本发版」+ shell.js「交付」组加 `releases` 导航（`ti-git-branch`）。
- 实施端 field.html：批次卡新增「累积更新计划块」（`mkUpdatePlanBlock`/`loadUpdatePlan`/`renderUpdatePlan`/`mkPlanItem`/`doPlanToggle`）。

## 重构 / dead-code（行为不变 → 仅此 CHG 记，不进 spec 作为新能力）
- `public/field.html`：**移除**旧「实施任务清单」卡（删 `mkImplChecklist`/`mkImplItem`/`doImplToggle` + `mkBatchGroup` 里 `if(g.implTasks…)` 渲染 + `window.__field` 三导出）。顺手把预存注释里的「已发包」改「已出包」（避 FS-01 A6 禁词 `发包`——原本 field.html 已有 1 处禁词命中，本次清零）。
- `public/batches.html`：**移除**批次详情里 implTasks 编辑区（删 `implTasksHtml`/`implEditRow`/`bindImplTasks`/`saveImplTasks` + `${implTasksHtml(b)}` 调用 + `bindImplTasks(b)`）。
- `server.mjs`：`/api/batch-task`、`batch-update` 的 `implTasks` 分支、`/api/field/batches` group 的 `implTasks` 透传 **保留为 dead code**（UI 不再触发；`tools/fs-06-checklist.test.mjs` 场景2 仍依赖，不删以免破测；后续可清）。

## 现场版本取值兜底（NEEDS-HUMAN 边界·已注明·未臆造）
`custProductVersion`：旧形状 `{project,version}`→version；新形状 `{project,subsystems:[{name,version}]}` 无产品级 version → **子系统版本一致取该值，否则空**（含糊即空 → update-plan include 全部 ≤target 已登记版本）。若后续要求「新形状取某子系统/最低版本当产品版本」需人明确规则再改（现按用户拍板「含糊则 fromVersion 置空 include-all」）。

## 部署
未部署（编排器统一做）。静态页 + server.mjs 需 rsync；data/version-releases.json 由首次登记生成。
