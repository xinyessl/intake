# 实施端隐藏已安装及旧版本

用户确认：版本更新列表不再展示现场已安装的同版及旧版。

## 实现
- 只在 `/api/field/batches` 读路径按每个医院、产品现场版本过滤。沿用 BP-06 `currentVersion`（releaseVersion 优先、子系统一致版本、旧产品 version）。
- 数字版本使用现有 numeric 排序；同版隐藏，v 前缀兼容。缺版本、不一致或未知格式保守保留，避免误隐藏安装入口。
- 逐医院过滤该列表的工单与适用医院集合；不删除记录、不改管理员批次列表或工单列表。升级计划仍使用完整发布链累计任务和 SQL。
- 完成回写已有回调重载台账和列表，补清理旧展开态、空态与异步迟到响应保护。

## 验证
`node --test tools/field-release-visibility.test.mjs tools/release-workflow.test.mjs tools/release-download.http.test.mjs tools/release-bundle.test.mjs`：12 passed，1 skipped。新增 5 项覆盖数字排序、多医院/产品、缺失/未知基线、真实路由授权、升级后立即刷新和切院竞态。原有发布链累计、计划回写和下载 HTTP 回归通过。

真库用例因未配置 INTAKE_TEST_DB_PORT 跳过。本次无数据库读写变更；已对照 db.mjs init：客户版本仍来自 customers.json，不新增表列。文件型数据字段与 currentVersion 实际读取逐项核对。server.mjs 和新增模块 node --check 通过。

无线上部署、无线上数据改动。隔离副本保留原工作区脏源码作为 baseline，只回写本需求差异。

## 线上发布（用户授权，2026-10-13 15:10 CST）
- 实际运行：intake-app，宿主 5180/5181 → 容器 5180；/opt/intake → /app。
- 以线上代码为基线，仅移植 server.mjs、public/field.html 和新增 tools/field-release-visibility.mjs。保留线上独有 release-workflow.js 缓存参数、隐藏未排期文案，以及新版 release-workflow.mjs。线上 currentVersion 导出与调用兼容。
- 备份：`/opt/intake/backups/version-filter-20261013-151000`（原 server、field、三份业务 JSON；helper 原不存在）。
- intake-app 重启成功；两端口 health 正常；容器实际 import helper 成功，同版过滤断言通过；页面内联脚本语法检查通过。
- 真实医院新疆生产建设兵团第十师北屯医院，wzh2-0 现场 1.5.26101002：发布前列表 B-04/B-03/B-02，发布后空列表。运营后台历史仍含 B-04/B-03/B-02/B-01。
- customers.json、batches.json、deploy.json 发布前后 SHA256 完全一致；未触发下载、升级、SQL或改现场版本。运行三文件 SHA256 与线上基线移植产物一致。
- 回退：仅恢复备份 server.mjs、public/field.html，移除本次新增 helper，重启 intake-app；不要覆盖备份 data，因为发布未改业务数据，运行期间可能已有新业务记录。
