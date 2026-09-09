# CHG · 咨询答复结束引导：三条独立气泡 → 合并成一条卡片

- 归属：FS-10 / CT-3（实施端咨询 `public/field.html`）
- 类型：**呈现优化（重构 UI 结构），行为不变** → 记 CHG，不改 spec AC。
- 分类依据（§4.5）：三个入口的**接口调用、payload、成功/失败文案、幂等、进人工模式逻辑、是否落草稿**全部逐字保留，仅把「三条独立 `f-msg` 气泡」合并为「一条 `f-msg` 卡片 + 一句精炼引导 + 一排按条件出现的按钮」。未改变任一 AC 描述的功能行为。

## 现状（改前）
`finishConsult` 结束后按条件分别调三个函数，各造一条 `f-msg ai` 气泡：
- `appendKbSink()` — 卡片「这条答疑对你有帮助吗…」+ 主色按钮「已解决·沉淀经验库」→ POST /api/kb-from-consult。
- `appendConsultToIntake()` — 卡片「升级为需求/BUG…」+ 主色按钮「🎫 转工单」→ openConsultToIntake 弹窗。幂等 `.f-toticket[data-conv]`。
- `appendConsultEscalate()` — 卡片「AI 答复没解决…」+ 主色按钮「转人工」→ POST /api/consult-escalate + 进人工模式。幂等 `.f-escalate[data-conv]`。

三句引导 + 三张卡，垂直堆叠啰嗦。

## 改后
新增合并函数 `appendConsultActions(nonSub)`（替代三个分散调用），一条 `f-msg ai` 卡片（class `f-arch f-consult-actions`）：
- 一句精炼引导：「这条答疑解决了吗？可沉淀经验库帮下一个人，或升级工单 / 转人工。」
- 一排按钮（`display:flex;flex-wrap:wrap;gap:8px`，换行自适应），按条件出现：
  - 「已解决·沉淀经验库」— `canKb = !nonSub && !!chat.lastQ`（实质答复），主色 `btn btn-sm btn-primary`。
  - 「🎫 转工单」— `canTicket = !!chat.convId`，次级描边 `btn btn-sm`。
  - 「转人工」— `canEscalate = !!chat.convId`，次级描边 `btn btn-sm`。
- 一个按钮都不该出（非实质 + 无 convId）→ 整卡不渲染。

`finishConsult` 里三处调用（`appendKbSink` / `appendConsultToIntake` / `appendConsultEscalate`）合并为一处 `if (replyText) appendConsultActions(nonSub);`（内部按条件决定出哪些按钮）。

## 行为保留证据
- **沉淀经验库**：payload `chat.convId ? {project,convId} : {project,q,a}`、成功「已沉淀到经验库」、失败「沉淀失败，重试」— 逐字搬自原 `appendKbSink`。
- **转工单**：点击 `openConsultToIntake(convId, archive, btn)` — 弹窗逻辑未动。
- **转人工**：POST /api/consult-escalate `{project: chat.reopenProject||archive.project, convId}`、成功「已转人工 · 可继续和运营对话」+ showToast + `chat.humanActive=true` + `syncHumanModeBar()` + `appendSystemNotice(...)` + `saveDraft()`、失败「转人工失败，重试」— 逐字搬自原 `appendConsultEscalate`。
- **幂等**：三张卡各自的去重守卫合并为卡片级 `.f-consult-actions[data-conv]`（convId 为空用占位键 `nc`），同会话只挂一枚。
- **humanActive 防御**：`appendConsultActions` 开头 `if (chat.humanActive) return`（人工服务中不再出引导；人工续问本就走 `sendHumanMessage` 不经 `finishConsult`，双保险）。
- **不进 chat.messages / 不落草稿**：引导按钮仍是纯 DOM 交互入口、`finishConsult` 末尾追加，不 push 到 `chat.messages`，刷新/reopen 后按状态重新判断是否再挂 — 与改前时机一致。
- `window.__field` 导出把废弃的 `appendConsultToIntake` 换成 `appendConsultActions`（`openConsultToIntake`/`doConsultToIntake` 仍在）。

## 测试
- `tools/fs-10-frontend.test.mjs`：更新原「转人工按钮」用例为「合并卡 appendConsultActions」用例（断言合并函数存在、`f-consult-actions` 去重键、三入口接口/成功文案保留、条件 `canKb/canTicket/canEscalate`、`humanActive` return、`finishConsult` 合并为一处且不再调三旧函数）。全 24 项通过，含内联脚本 `new Function()` 全量解析（无语法错/无悬挂引用）。
- `tools/fs-04-stop-sending.logic.test.mjs`：aborted 分支断言不受影响，全通过。
- 广域 consult 套件（poll/conversation/kb-evidence/kb-gate/human-media-restore）：85/88 通过；3 项失败（route 裁决 / 二次修订降级 / 引用声明恢复）经 `git stash` 验证为**改前既有失败**，与本次改动无关。

## 别动 / 护栏（已遵守）
- 未改三入口的接口调用、payload、成功/失败文案、`openConsultToIntake` 弹窗、escalate 进人工模式逻辑。
- 未碰 lsy 的 /api/consult 答复流。
- 未引入新样式框架（仅用 theme.css 现有 `.btn`/`.btn-sm`/`.btn-primary` 变体 + 内联 flex）。
