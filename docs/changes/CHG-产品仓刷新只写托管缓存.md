# CHG · 产品仓刷新只写托管缓存

## 问题

`refreshRepos` 原先对产品登记里的任意 `repoPath` 无条件执行 `fetch` 和 `git reset --hard @{u}`。当测试数据误把活跃开发仓登记为产品仓时，未提交改动会被覆盖。

## 修复

- 仅允许刷新 `data/repos` 下由 Intake clone 的专用缓存仓；路径按 `realpath` 判定，符号链接不能绕过。
- 外部开发仓一律只读跳过。
- 托管缓存仓在 fetch 前和 reset 前分别执行一次工作区检查；发现已跟踪或未跟踪改动立即 fail closed。
- fetch、工作区检查或上游对齐失败时不继续 reset，并在 `/api/git-refresh` 的 `repos/blockedRepos/error` 中返回明确原因。

## 回归

`node --test tools/repo-refresh-safety.logic.test.mjs` 使用真实临时 Git 裸仓、托管 clone 和外部 clone 验证：干净缓存仓正常同步；脏缓存仓 HEAD/文件不变；外部仓不执行写操作；符号链接逃逸被拒绝。

本修复调整了危险同步行为边界，已同步更新 `PD-01 AC-15`；不涉及数据库结构。
