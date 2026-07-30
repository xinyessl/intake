# CHG · field.html 医院视图归档条显所选子系统 + 系统视图咨询记录可 reopen

- **日期**：2026-07-23
- **来源**：用户 2026-07-23 反馈（实施端 `public/field.html` 两个问题）
- **分类**：
  - 问题①（医院视图切子系统归档条无反映）= **显示补全**（归档条随 selectSub 刷新 + 显所选子系统中文名）。因暴露了原 `renderHospChip` 不显子系统的边界不足 + `selectSub` 漏调 `updateCtx` → 补入 spec 回归 AC（FS-06 AC-C9③、FS-03 AC-18 修订）。
  - 问题②（系统视图咨询记录点不进对话）= **补齐 reopen 覆盖**（`mkSysItem` 镜像 `mkItem` 绑 reopen）。原 AC-C7 只写医院视图 → 扩到"两视图均可 reopen"，算涉及 spec（FS-06 AC-C7 修订）。
- **改动文件**：
  - `public/field.html`：
    - `selectSub` 末尾加 `updateCtx();`（在 `loadSubmissions()` 后、`syncConversationToSystem()` 前）——切子系统刷新归档条。
    - `renderHospChip(ctx, site)`：`state.curSub` 非空时在医院名之后、现场版本之前插「· 系统：<`subLabel(state.curSub)`>」（中文 desc）；`curSub` 为空不显该段。
    - `mkSysItem(it)`：镜像 `mkItem` —— consult 类型 `.f-item` 加 `clickable` 类 + `cursor:pointer` + `click → reopenConsult(it)`（req/bug 不绑）。
  - `tools/fs-02.test.mjs`：新增 A2c（`selectSub` 调 `updateCtx` + `renderHospChip` curSub 分支显 `subLabel`）。
  - `tools/fs-03.test.mjs`：新增 A9（`mkSysItem` 镜像 `mkItem` 绑 consult reopen + `it.project` 复用 `reopenConsult`）。
  - `tools/fs-06.test.mjs`：新增 B-RO3b（系统视图 `mkSysItem` consult reopen 静态断言）；修订 A-CTX（`renderHospChip` 现显所选子系统 `subLabel(curSub)`，早前 `doesNotMatch(subLabel|curSub)` 改为 `match`）。
  - `docs/specs/FS-06-免登录提交链接.md`：AC-C7 扩到"医院/系统两视图均绑 `reopenConsult`（`mkItem`+`mkSysItem`）"；AC-C9 补③（医院视图 chip 显所选子系统 + `selectSub` 调 `updateCtx`）。
  - `docs/specs/FS-03-系统视图与版本模型.md`：AC-18 补"选中子项目时 chip 增显 · 系统：<子系统>，切子系统实时刷新"。
- **未碰**（明确）：`server.mjs`（`mapItem` 已输出 `project`，hosp/sys 两维度复用 → 系统视图 item 已带 `project`+`id`，`reopenConsult` 直接复用，零改）、`public/customers.html`、其他任何页、`assets/*`；以及已改好的逻辑：per-system 会话（`systemKey`/`bySystem`/`syncConversationToSystem`）、咨询必选守卫、consult 打分续存、子项目下拉双键、`subsystemLabel`、按批次降级。

## 两个问题

### 问题①：医院视图切子系统，右侧「归档到」条无反映（显示补全）
- 根因：`selectSub` 未调 `updateCtx()` → 归档条不刷新；且 `renderHospChip` 只渲染「🏥 医院 · 现场版本」不显子系统 → 切「报表系统」后右侧仍「合理用药 —」，用户觉得没变化。
- 修：① `selectSub` 末尾 `updateCtx();`；② `renderHospChip` 加 `state.curSub ? ' · 系统：'+escapeHtml(subLabel(state.curSub)) : ''` 段（放医院名之后、现场版本之前），观感对齐系统视图 `renderSysChip`「产品·子系统·版本」。
- 过滤逻辑不变：`loadSubmissions` 仍 `&subsystem=state.curSub`（英文 name 匹配 `intakes.subsystem`），只是归档条显中文 desc。

### 问题②：系统视图点咨询记录带不进对话（补齐 reopen 覆盖）
- 根因：reopen 点击原仅绑在 `mkItem`（医院视图卡片），`mkSysItem`（系统视图卡片）没绑任何点击。
- 修：给 `mkSysItem` 的 `.f-item` 镜像 `mkItem` 的 reopen 绑定（consult 加 `clickable` + `cursor:pointer` + `click→reopenConsult(it)`）。`reopenConsult` 通用、已有，靠 `it.project`+`it.id` 调 `/api/intake-detail`。
- **`it.project` 核查结论**：`server.mjs` L1306 `mapItem` 输出 `{ id, project, type, ... }`，L1307 起 `dimension==='sys'` 与 hosp 分支**复用同一 `mapItem`** → 系统视图 item 同样带 `project`+`id`+`type`，`reopenConsult(it)` 直接复用，**无需改 server**。
- 与 per-system 会话共存：reopen 载入当前桶（当前 `systemKey`），不改 `lastSystemKey`（同 `mkItem` 现状），不破坏 `syncConversationToSystem`。

## 验证
- 静态（field.html 全文）：隐形字符 0、`localStorage` 0 次、FS-01 A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）各 0 次、内联 `<script>` `new Function` 语法过。
- 回归：`node --test --test-concurrency=1 tools/fs-02.test.mjs tools/fs-03.test.mjs tools/fs-06.test.mjs tools/fs-04.test.mjs tools/fs-01.test.mjs` → **133 pass / 0 fail**（含 fs-06 连真库冒烟 B-RO1/B-RO5/B-KB*）。
- 真库无残留：直连 `data/db.json` 核对 `projects/intakes/kb_entries` 中 `fs06smoke-%`/`fs06other-%` 残留均 0；`hlyy` 基线 intakes=8 未变。

## 风险
低。纯前端两处小改：
- 归档条子系统段仅 `curSub` 非空时显、`subLabel` 已有中文兜底（desc||name），空态回退无子系统段；过滤值/键不变，不影响数据加载。
- `mkSysItem` reopen 绑定仅 consult 类型加（req/bug 不绑，避免续聊建重单），复用通用 `reopenConsult`，无新逻辑分支；`it.project` 已核确带。
- 无 server.mjs / 库 / 其他页 / 已改逻辑改动。
