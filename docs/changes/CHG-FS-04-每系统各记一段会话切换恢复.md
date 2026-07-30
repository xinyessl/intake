# CHG-FS-04 · 实施端每个系统各记一段会话，切系统跟随切换/恢复

- 日期：2026-07-23
- 归属 spec：FS-04（AI 对话提交）新增 AC-25/AC-26（涉及 spec，随交付附 diff 请人验收）
- 类型：逻辑/行为调整（新特性）——用户 2026-07-23 裁决「切系统 → 恢复该系统的对话」

## 背景 / 现状
实施端 `field.html` 右侧只有**一段**会话：切医院 / 切子项目 / 切系统 / 切视图（`onHospSelect`/`selectSub`/`onSystemTab`/`setMode`/`onHospitalChange`）都**不动**右侧对话，切来切去右侧一直是同一段。用户想：在系统 A 聊几句 → 切到系统 B → 右侧显示 B 之前聊到哪 → 切回 A 又见 A 的对话。

## 改动（仅 field.html + fs-04 测试 + FS-04 spec + lessons）
- **新增集中式函数**（chat 对象声明后）：
  - `systemKey()`：系统上下文稳定键——系统视图 `'sys||'+curSys`、医院视图 `curSite+'||'+curSub`（尾部空串=「全部系统/全部子项目」桶）。
  - `chat.bySystem={}`（键→会话快照）+ `chat.lastSystemKey=null`（基线键）。
  - `snapshotConversation()`：打快照，覆盖 `messages/submitKind/convId/savedId/analyzed/lastQ/lastA/reopenProject/reopenSubsystem/input`。
  - `restoreConversation(snap)`：清对话流后逐条重渲染（user 转义、assistant `md()`），恢复全量字段 + 输入框；空段复用新对话占位。
  - `syncConversationToSystem()`（幂等核心）：键没变即 return；有旧键→存旧桶；更新基线键；新桶有快照→恢复，否则→`newConversation()`。
- **接入切换点末尾**（幂等广撒·键没变即 no-op）：`selectSub`、`onSystemTab`、`onHospitalChange`（`onHospSelect` 复用它）、`setMode`。
- **初始化/清理**：`enterWorkspace` 里 `restoreDraft()` 后置 `chat.lastSystemKey=systemKey()` 为基线键；`newConversation` 追加清当前桶（`delete chat.bySystem[chat.lastSystemKey]`）；`doLogout` 清 `bySystem`+`lastSystemKey`。

## 与既有逻辑共存（未破坏）
- 必选子系统守卫 `guardConsultSubsystem`（FS-06 AC-C8）：不变——具体子系统桶发 consult 不被拦、「全部」桶发 consult 仍被拦。
- reopen（FS-06 AC-C7）：reopen 的 consult 属当前系统桶，快照带 `reopenProject/reopenSubsystem`，切走再切回续聊仍指原 consult。
- 草稿 `saveDraft/restoreDraft`（sessionStorage）：仍只存**当前**会话；`bySystem` 是纯内存态、不进任何端存储（刷新其它系统段丢失可接受）。

## 未碰
`server.mjs`、其它页、`customers.html`、以及已改好的逻辑（consult 打分续存 / 子项目下拉 / subsystemLabel / 按批次降级 / 必选子系统守卫 / reopen project 锁）——全未改动。

## 测试
`tools/fs-04.test.mjs` 新增 8 条：7 条静态（函数存在 / systemKey 组键 / syncConversationToSystem 幂等 · 存旧桶 · 恢复/空会话 / 快照全量字段 / 4 切换点接入 / newConversation 清桶+doLogout 清空+基线键 / bySystem 不进端存储）+ 1 条 vm 逻辑（提取 field.html 真身四函数在沙箱跑 A→B→A：断言 A 段保存、切回恢复、未聊过空会话、幂等无副作用）。

回归：`node --test --test-concurrency=1 tools/fs-04.test.mjs tools/fs-06.test.mjs tools/fs-02.test.mjs tools/fs-03.test.mjs tools/fs-01.test.mjs` 全绿（130 pass）。真库 hlyy 基线不变、零残留。field.html 隐形字符 0 / `localStorage` 0 / 内联 `new Function` 语法过 / FS-01 A6 禁词 0。
