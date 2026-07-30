# CHG-FS-07-子系统引用显中文（含 FS-06 咨询答复引用区）

- 日期：2026-07-23
- 分类：**显示 bug 修复**（实现未达 spec，spec 意图本就对）→ 走 CHG。伴随 FS-07 AC-3 措辞澄清 + §4 响应字段补记（保持 spec 准确，非行为变更）。
- 触发：用户 2026-07-23 反馈——实施端经验库/引用里「子系统：audit」显英文，应显中文（`audit` → `审方`）。

## 现象
现场端（`public/field.html`）经验库抽屉结果项「子系统：」、以及咨询答复「参考经验库」引用区的子系统，直接显示英文 `subsystem` name（如 `audit`），而非产品子系统目录里的中文 `desc`（如 `审方`）。

## 根因
KB 条目存的 `subsystem` 是英文 name。三处把条目回给前端时只带英文 `subsystem`、无中文 `desc`，前端无单产品子系统目录可查（全库跨产品聚合），只能显原名：
- `server.mjs` `/api/kb-search` **all=1 浏览分支**（每条 `{...e, project, productName}`）
- `/api/kb-search` **q 检索分支**（`scored.push({sc, e:{...e, project, productName}})`）
- `/api/consult` **kb 事件**（`sse({kb: hits.map(h => ({q,a,subsystem,module}))})`）

（此前 `docs/lessons.md` L-70 曾记「kb-search 结果无 desc，现场端子系统只能显原名」——本次改由服务端补 `subsystemLabel` 解决，L-70 已过时并作废。）

## 改动
### server.mjs（服务端解析中文 desc，加法字段向后兼容）
- 新增 helper `kbSubLabel(projId, subName)`（`kbTokenize` 附近）：查该产品 `subsystems[].name===subName` → 取 `desc||name`，查不到回退原 `subName`（含空）。
- 三处补 `subsystemLabel`（**新增加法字段**，原 `subsystem` 英文 name 保留供搜索/过滤，不删）：
  - all=1 分支：`{ ...e, project, productName, subsystemLabel: kbSubLabel(pid, e.subsystem) }`
  - q 检索分支：`e: { ...e, project, productName, subsystemLabel: kbSubLabel(pid, e.subsystem) }`
  - consult kb 事件：`hits.map(h => ({ q, a, subsystem, module, subsystemLabel: kbSubLabel(proj.id, h.subsystem) }))`

### public/field.html（两处渲染改用 subsystemLabel，中文优先）
- `mkKbItem`：`var subDisp = e.subsystemLabel || e.subsystem || ''`，「子系统：」显 `subDisp`（无则「—」）。
- `renderKbCite`（咨询答复引用区）：meta 用 `(h.subsystemLabel || h.subsystem || '')`。
- 未引入 `localStorage`；隐形字符 0；`new Function` 语法校验过；FS-01 A6 禁词 0。

## 测试（连真库冒烟）
- `tools/fs-07.test.mjs`：隔离产品加子系统 `{key:'s1', name:'audit', desc:'审方'}` + 塞一条 `subsystem='audit'` 的 KB → 断言 `/api/kb-search?all=1` 与 `?q=` 返回 `subsystemLabel==='审方'` 且 `subsystem==='audit'` 仍在；补回退分支断言（hlyy 每条带 `subsystemLabel`）；更新 all=1 分支静态断言 + 加 helper 静态断言 + field.html 两处渲染静态断言。
- `tools/fs-06.test.mjs`：FS06 产品加同样 `audit/审方` 子系统，B-KB1 KB 条目 `subsystem='audit'`，B-KB2 断言 consult kb 事件 `subsystemLabel==='审方'`、`subsystem==='audit'`；B-KB5 补 server 静态断言、B-KB4 补 field.html 引用区静态断言。
- 结果：`node --test --test-concurrency=1 tools/fs-06.test.mjs tools/fs-07.test.mjs tools/fs-01.test.mjs` = 94/94 绿；本地库无残留（fs06*/fs07* 产品/kb/工单/账号 = 0，真库 hlyy 完好）。

## 未碰
ui.js、其他页面、impl-sites 相关、已改好的 consult 打分续存/子项目下拉/reopen 逻辑，均未触碰。

## 风险
低。`subsystemLabel` 为加法字段，老前端/旧断言忽略未知字段；`subsystem`（英文 name）保留不变，搜索/过滤链路不受影响。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
