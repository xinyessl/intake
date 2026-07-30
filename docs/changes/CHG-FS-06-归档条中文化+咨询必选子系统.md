# CHG · field.html 归档条去 label + 子系统中文化 + 咨询必选子系统 + reopen 保留原子系统

- **日期**：2026-07-23
- **来源**：用户 2026-07-23（改实施端 `public/field.html` 咨询提交区，一次做三件）
- **分类**：
  - ①去「归档到」label + ②系统视图归档 chip 子系统显中文 = **显示调整**（本 CHG 留痕；同时 FS-06 spec 补 AC-C9 记录该显示口径，便于回归）。
  - ③咨询提交必选子系统 + reopen 续聊保留原子系统 = **行为变更 → 改 FS-06 spec**（新增 AC-C8、AC-C7b，AC-C7 补 `reopenSubsystem`）。
- **改动文件**：
  - `public/field.html`（归档条 DOM + `.f-actx-lbl` CSS 移除；`renderSysChip` 子系统 `sysLabel`；`chat.reopenSubsystem` 新状态；`currentArchive`/`reopenConsult`/`newConversation`/`saveDraft`/`restoreDraft` 带 `reopenSubsystem`；新增 `guardConsultSubsystem` + `sendChat` 挂载守卫）
  - `tools/fs-06.test.mjs`（B-RO3/B-RO4 补 `reopenSubsystem` 静态断言；新增 B-RO5 连真库续聊保留子系统冒烟；新增 A-RO 咨询必选守卫静态、A-CTX 归档条显示静态；`makeConsult` 带 `subsystem: 'audit'`）
  - `docs/specs/FS-06-免登录提交链接.md`（AC-C7 补 `reopenSubsystem`；新增 AC-C7b/C8/C9）
- **未碰**：`server.mjs`（consult 端已按 `subsystem: b.subsystem` 续存、`prev` 按 convId+type 续存，均无需改）、`public/assets/ui.js`、其他页面、`tools/impl-sites-sync.test.mjs`、以及已改好的 consult 打分续存 / 子项目下拉 / reopen project 锁定 / subsystemLabel 逻辑。

## 三件事

### ① 去掉「归档到」label（显示调整）
删归档条 `<span class="f-actx-lbl">归档到</span>` 元素 + 两处 `.f-actx-lbl` CSS（死码）。归档条现直接从 `#fCtx`（产品图标）开始。

### ② 归档条系统视图子系统显中文（显示调整）
`renderSysChip` 把 `escapeHtml(sysName)` 改为 `escapeHtml(sysLabel(sysName))`（`sysLabel`=desc||name，`audit`→`审方`，已有函数）。版本号不变。
核查 `renderHospChip`：它**只渲染 `site` + 产品版本、不渲染子系统**，故本轮不动（无英文子系统名需中文化）。

### ③ 咨询必选子系统 + reopen 保留原子系统（行为变更）
- **必选**：`sendChat` 里在清空输入前 `if (chat.submitKind==='consult' && guardConsultSubsystem()) return;`。`guardConsultSubsystem`：续聊（`chat.reopenProject` 非空）永不拦；`currentArchive().subsystem` 非空放行；空则弹就地 AI 气泡「请先选择这条咨询所属的子系统」+ 引导（医院视图展开 `fProdWrap` 子项目下拉；系统视图点 `fSysCur` 展开系统下拉）。**仅 consult 生效**，提需求/报 BUG（intake）不受影响。不用 `localStorage`、不用 `uiAlert`（field.html 未引 ui.js）。
- **reopen 保留原子系统**：新增 `chat.reopenSubsystem`；`reopenConsult` 从 `item.subsystem` 设；`currentArchive` reopen 分支 `out.subsystem = chat.reopenSubsystem || ''`；`newConversation` 清空；`saveDraft`/`restoreDraft` 带上（刷新不丢）。修复原先 reopen 续聊 `currentArchive` 未带 subsystem → server 端 `subsystem: sub`（空）**覆写清空**原 consult 子系统的隐患。

## 验证
- 静态：field.html 隐形字符 0、`localStorage` 0 次、`f-actx-lbl`/「归档到」0 次、FS-01 A6 禁词 0、内联 `<script>` `new Function` 语法过。
- 连真库冒烟（B-RO5）：带 `subsystem=audit` 的 consult 建单落库 `subsystem=audit` → reopen 续问（同 convId + 同 subsystem）→ 续存后 `subsystem` **仍为 audit（不被清空）**、不建重单。
- 回归 `node --test --test-concurrency=1 tools/fs-06.test.mjs tools/fs-03.test.mjs tools/fs-02.test.mjs tools/fs-01.test.mjs` 全绿（98 pass）；另 `tools/fs-04.test.mjs` 全绿（24 pass）。真库无残留（仅 hlyy）、`data/link-secret` 未变。

## 风险
低。
- 必选拦截**仅 `submitKind==='consult'` 且非续聊且无子系统**时触发，intake（提需求/报 BUG）与 reopen 续聊均不受影响；输入内容保留、引导展开对应下拉，交互闭环。
- reopen 保留子系统只在 consult 续聊分支生效，不影响新咨询/新建单。
- 无 server.mjs / 库 / 其他页改动。
