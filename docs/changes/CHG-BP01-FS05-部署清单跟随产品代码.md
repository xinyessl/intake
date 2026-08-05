# CHG · 部署/更新清单改「跟随产品代码」（架构重构）

- 日期：2026-08-05
- 关联 spec：BP-01 §I / AC-24~29、FS-05 §K / AC-34~35、CU-01 §L（AC-23~25 废）
- 类型：架构重构（行为变更 → 已同步 spec diff，走 accept 门）+ 删除死代码

## 一句话
部署/更新清单不再在 intake 内手工维护，改为**从产品代码仓按 git tag 读 `docs/deploy.json`**，跨子系统聚合、跨版本累积。废弃手工「版本发版登记」+ 全局部署清单模板；保留完成度追踪 + 实施端「更新计划」UI（仅换数据来源）。

## 新增
- `docs/约定-产品部署清单.md`：`docs/deploy.json` 数据格式约定（给产品 dev 团队照着落地）。
- `tools/deploy-manifest-reader.mjs`：git 读取器（`readDeployManifestFromSubs`/`readSqlAtTag`/`gitOut`），可脱 MySQL/server 用真实临时 git 仓单测。
- `tools/version-plan-deploy.logic.test.mjs`：纯逻辑 + 真实临时 git 仓读取器单测（17/17 本地绿，无需 MySQL）。
- server.mjs：`readDeployManifest(proj,tag)`（聚合 + (projId,tag) 轻缓存）；`update-plan` 返回加 `noManifest`/`noManifestHint`；`update-sql-merged` 逐条 `file` 引用 `git show <tag>:<file>` 读正文。
- version-plan-logic.mjs：`normDeployManifest`、`accumulateManifests`（取代 `normVersionTasks/Sqls`/`accumulate`）；`mergeSql` 分隔注释含子系统/文件。

## 删除（server.mjs）
- `loadVersionReleases/saveVersionReleases/versionTaskGenId/versionSqlGenId` + `GET /api/version-releases` + `POST /api/version-release-save` + `data/version-releases.json` 依赖。
- `loadDeployTemplate/saveDeployTemplate/deployTaskGenId` + `GET/POST /api/deploy-template(-save)` + `POST /api/customer-deploy-task` + `data/deploy-template.json` 依赖 + 客户列表 `deployDone/deployTotal` 派生。
- `POST /api/batch-task` + `batch-update` 的 `implTasks` 合并分支 + `batchOut`/`/api/field/batches` 的 `implTasks` 透传。
- `checklist-logic.mjs` 的 import（模块文件留存但无引用·全 dead）。
- 白名单：`FIELD_OK` + `FS08_FIELD_API` 两 Set 同步移除上述 4 端点（`version-releases`/`deploy-template`/`customer-deploy-task`/`batch-task`），保留 `field/update-plan|toggle|sql-merged`。

## 删除（前端）
- `public/releases.html`（版本发版登记页）删除；`shell.js` 去「版本发版」导航项。
- `public/customers.html`：删部署清单模板抽屉 `tplDrawer` + `DEPLOY_TPL`/`openDeployTpl`/`saveDeployTpl` 等全部 JS + `deployCell`。
- `public/field.html`：删部署清单区块 `mkDeployChecklist`/`deployAggProgress`/`mkDeployItem`/`doDeployToggle` 那批 + `deployTpl` 加载/state/`window.__field` 导出。
- `public/batches.html`：清 `implTasks` 残留注释指向。

## 保留不动
- `customer.updateProgress`（完成度）+ 实施端「更新计划」块（`mkUpdatePlanBlock`/`loadUpdatePlan`/`renderUpdatePlan`），只换后端数据源。
- `customer.deployTasks` 字段（仅兼容保留旧完成态，无勾选端点）。

## 测试
- `node --test tools/version-plan-deploy.logic.test.mjs` → 17/17 绿（纯逻辑 + 真实临时 git 仓读取器）。
- `node --check server.mjs / version-plan-logic.mjs / deploy-manifest-reader.mjs` 全过；改动前端页内联 JS `new Function` 解析全过。
- 白名单双 Set 抽取断言：`FIELD_OK 的 /api/ 端点全 ∈ FS08_FIELD_API`，删除端点已从两 Set 移除，无漂移。

## 风险
- **产品仓尚无 `docs/deploy.json` → 线上读空是预期**：实施端更新计划显示「该版本区间未在产品代码中声明部署清单」（`noManifest:true`），需 dev 团队按约定文档在各子系统仓补 `docs/deploy.json` 后才有内容。这是设计如此，非 bug。
