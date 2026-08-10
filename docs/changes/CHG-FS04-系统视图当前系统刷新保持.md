# CHG · FS-04 系统视图当前系统刷新保持

## 现象

实施端切到「系统视图」，顶部选中「药师工作站」后刷新，顶部错误回到「全部系统」。

## 原因

`buildDraftPayload` 已正确保存系统项稳定 `name`；但 `normalizeNavigationDraft` 从 `/api/field/systems` 实时列表命中后，又用 `me.projects` 对返回项的 `project` 二次过滤。该端点按 FS-03 本就返回平台全部产品的系统全集，二次过滤会将合法保存值误判为失效并清为 `null`。

## 修复

- 恢复当前系统时，仅以已登录且实时返回的 `state.systems` 为事实源，按稳定 `name` 命中并保存规范化 `name`。
- 只有保存值已不在当次实时列表时，才回退「全部系统」。
- 医院、子项目、版本原有实时校验保持不变；无接口、权限、数据库、样式和 React 改动。

## 验证

- 精确逻辑回归：`node --test tools/fs-04-refresh-restore.logic.test.mjs`，11/11 通过。
- 新增反例：合法系统已在 `/api/field/systems` 列表内，即使其 `project` 字段与 `me.projects` 形状/范围不同也必须恢复；不存在系统仍安全回退。
- 全量 legacy 逻辑回归：334 项中 325 通过、0 失败、9 项因本机未配置真库按设计跳过。
- 生产真实浏览器 fresh 验证：系统视图选中「药师工作站」（`data-sys=pwrs`），打开一条 4 条消息的咨询后 F5，顶部标签「药师工作站」→「药师工作站」，消息 4→4 且全文一致。
- 仅部署 `public/field.html`；线上 SHA-256=`7baa3166590e58336c2806c41612c8cc09d3ea60ce50040b98ac323bd0bb9cc2`，React 接管标记 0，`/api/health`=200，容器运行。部署前备份 `/opt/intake-backups/intake-before-system-refresh-20260810-181021.tar.gz`。

任务保持 `doing`，待用户验收。
