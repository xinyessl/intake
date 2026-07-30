# CHG-CU-01 · 医院管理编辑抽屉「产品版本」由自由文本改为选择型下拉

- **日期**：2026-07-23
- **类型**：行为变更（涉及 spec）→ 已并入 CU-01 spec（AC-8b 新增；§2/§4/§6 同步），非纯 bug/重构。
- **触发**：用户 2026-07-23「版本要支持子版本的选择」——从该产品可用版本里下拉选，不再自由手输。
- **范围**：仅前端 `public/customers.html`（编辑抽屉产品行）。**未碰** `server.mjs` / `public/field.html` / 其他页 / impl-sites 已改逻辑。

## 改了什么
- `public/customers.html`
  - `.cver` 由 `<input class="input mono cver" maxlength=30>`（自由手输）改为 `<select class="select cver">`（选择型，被 ui.js 自定义下拉 `.ui-sel-*` 增强，与产品下拉观感一致）。
  - 新增 `VER_CACHE` + `fetchVersions(pid, cb)`：按产品懒加载 `GET /api/versions?project=<pid>`（`{versions:[...],syncedAt}`，最新在前）+ 缓存命中直回；仿 field.html `ensureVersions`。
  - 新增 `fillVerOptions(sel, versions, cur)`：填版本 options（首项「未指定」value='' + 各 tag）；`cur` 不在 tag 列表里 → 作为「（历史值）」选项保留（避免下拉丢历史手输版本 / 保存被清空）；无版本且无历史值 → 加禁用提示项「该产品暂无版本」；填完 `sel.value=cur` + 派发 `change{bubbles:true}` 让 ui.js 自定义下拉重同步动态 options。
  - `addProdRow(project,version)`：建 `.cver` select；`.cprod` 绑 `change` → 换产品重拉版本、重填、重置「未指定」；建行时若已有 `project` → 拉该产品版本并选中传入 `version`（历史值保留）。
  - CSS：`.prow .select{flex:1.4}` / `.input{flex:1}` 改为按类 `.cprod{flex:1.4}` / `.cver{flex:1}`（因版本已非 `.input`）。
  - `collectProducts` **不变**（仍读 `.cver.value`）。列表展示 `.vv`（`p.version||'未指定'`）**不变**。
- `tools/cu-01.test.mjs`：新增静态断言（cver 是 select 非 input、含「未指定」、有 fetchVersions/VER_CACHE/`/api/versions` 填充、历史值保留、collectProducts 读 `.cver.value`）+ 连真库冒烟（`/api/versions?project=` 返回 `{versions:[...]}` + 选中版本经 `customer-save` 回读一致）。

## 存储/契约影响
- **无后端改动**：版本仍是自由字符串存 `data/customers.json`（前端只改「怎么填」，不改「存什么」）。`/api/versions` 是现有端点，直接复用。
- 回归：`node --test --test-concurrency=1 tools/cu-01.test.mjs tools/ui-select.test.mjs tools/ui-shell.test.mjs` 全绿（cu-01 13 + ui-select 20 + ui-shell 50 pass，ui-shell 3 SKIP 为 BASE-gated 冒烟）。本地 MySQL 无残留、`data/customers.json` 还原为「不存在」态。
