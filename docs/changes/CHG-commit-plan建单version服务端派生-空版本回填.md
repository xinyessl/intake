# CHG · commit-plan 建单 version 改服务端派生（修「版本列空 —」）+ 回填 3 张历史空版本单

- 日期：2026-08-07
- 类型：纯 bug 修复（+ 一次性数据回填）——代码本就应带上「提交医院的现场版本」，spec（FS-04 AC-13/§5.3）意图一贯如此，只是实现漏了服务端兜底。**不改 spec 逻辑**（另附一条可选回归 AC 草稿，见文末，供评审决定是否并入）。
- 关联：FS-04（AI 对话提交 / 确认清单建单 AC-12/AC-13）；端点 `/api/intake-commit-plan`
- 改动文件：
  - `server.mjs`（`/api/intake-commit-plan` 建单处）
  - `tools/commit-plan-version.logic.test.mjs`（新增脱库逻辑测试）

## 现象
后台工单「版本」列对部分现场建单显 `—`（空）。实测 3 张：`XQ-20260807-01/02/03`（安吉县人民医院·hlyy·pkb），`version=''`。

## 根因
`/api/intake-commit-plan` 建新单时 `version` 直接取前端传的 `b.version`（= `archive.version`，chip 上下文版本）。现场停在「医院视图/全部子系统·未选具体版本」时 `archive.version` 为空 → 工单 `version='' `→ 后台列表显 `—`。
但**提交医院确实登记了现场版本**：`data/customers.json`「安吉县人民医院」`hlyy` 各子系统（含 pkb）均 `version:"2.7.260723-1"`。应服务端按医院的子系统版本派生，不靠前端传空。

## 修法
建新单时 `version` 改「服务端派生」（`deriveVersion(itSub)`），兜底链：
1. `custSubVersion(cust, proj.id, itSub)`——该提交医院(site)该产品该工单子系统的现场版本（优先）；
2. `custProductVersion(cust, proj.id)`——该医院该产品「一致版本」（子系统未命中时回退：各子系统版本一致才取，不一致→空）；
3. `b.version`（前端传的 chip 版本，兜底）；
4. `''`（都取不到→空，不臆造）。
- `custForVer` = `loadCustomers().find(c => c.name.trim() === site.trim())`（沿用 L1821/L1928 现成范式）。
- `append` 分支不涉及 version（只补内容到已有单），未改。

### 子系统名/键匹配（关键 · 已核真实结构）
- prod `projects.hlyy.subsystems[].name` = **英文 key**（`audit/report/intervene/review/pkb`；`desc`=中文），`subsystemNames(proj)` 返回 name（英文 key）→ AI 提示词列英文 key → AI 填的 `item.subsystem`（=`e.subsystem`/itSub）= **英文 key**（实测 3 张单 `subsystem="pkb"`）。
- customer `products[].subsystems[].name` 同样存**英文 key**（安吉：`{"name":"pkb","version":"2.7.260723-1"}` 等）。
- `custSubVersion` 按 `s.name===subsystem` 匹配 → itSub(英文 key) 与 customer 子系统 name(英文 key) **直接命中**，无需转换。
- 命中不了（中文名/待定/未登记子系统）→ 自动回退产品级一致版本（安吉 5 子系统同版本→回退仍得 `2.7.260723-1`）。
- ⚠️ 本地 `data/projects.json` 的 subsystems 是旧的中文 name（`{"key":"audit","name":"审方"}`），与 prod 不一致；**prod 从 MySQL projects 表读**（英文 key name），一切以 prod 为准。

## 回填（一次性）
`XQ-20260807-01/02/03`（安吉·pkb·空版本）→ 派生并回填 `version="2.7.260723-1"`（子系统命中）。
- 三处一致：MySQL `version` 列 + `data` JSON（`upsertIntake`）+ intake-store `.json`/`.md`（frontmatter `version:` 定点替换）。
- 只补空版本、只改 version 字段，其余不动；已有版本的单跳过；派生不出→跳过不臆造。
- 回填后 `docker restart intake-app` 刷 CACHE。

## 冒烟（连 prod 真库）
1. commit-plan 建单（version 空、现场 pkb 有版本，登录 impl `wanglong`/安吉）→ `XQ-20260807-04` 建成，`created` 返回 ok；查库 `version=2.7.260723-1`（不再空）。
2. 后台工单列表该单版本列 = `2.7.260723-1`。
3. 3 张历史单回填后 MySQL `version` 列均 `2.7.260723-1`。
4. 脱库逻辑测试 `tools/commit-plan-version.logic.test.mjs` 9/9 绿（命中/回退产品级/回退 b.version/空/旧形状/bug 复现）。
- **造数已清**：删除测试单 `XQ-20260807-04`（DB 行 + intake-store 文件 + media）、临时会话记录、临时 smoke session、prod 临时脚本；重启刷 CACHE；3 张回填单验证仍在。

## 风险
- 派生依赖 `data/customers.json` 台账已登记该医院该产品版本；未登记→回退 b.version→空（回退到修前行为，不恶化）。
- site↔customer.name 字符串精确匹配，重名会串号（既有限制，全项目一致，非本次引入）。
- 未改 `append` 与 `/api/intake-submit`（表单直提路径）——本次只修当前主建单路径 commit-plan。若后续发现 submit 路径也落空版本，可同法补 `deriveVersion`。

---

## 可选回归 AC 草稿（供评审 · 未并入）
> 本 bug 暴露 FS-04 建单版本缺一条「前端版本空时的兜底」边界，建议往 FS-04 §「D. 对话建单 / 确认清单」补一条回归 AC：

- **AC-13b（version 服务端派生兜底 · 回归）** Given 现场在「医院视图 / 全部子系统」未选具体版本、`archive.version` 为空 When 确认建单（`/api/intake-commit-plan`，`b.version=''`）Then 每张新建工单 `version` 由服务端按**提交医院(site)该产品该工单子系统**的现场版本派生（`custSubVersion` 命中 → 子系统版本；未命中 → 该产品各子系统一致版本 `custProductVersion` → 前端传的 `b.version` → 空），**不再落空版本**（后台工单列表版本列不再显 `—`）。子系统名/键：`e.subsystem`(itSub) 与 `customer.products[].subsystems[].name` 均为英文 key（如 `pkb`），`custSubVersion` 按 `name===` 直接命中。`append` 分支不改 version。
