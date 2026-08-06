# CHG · 现场端 AI 对话「停止」按钮（中断正在思考/流式生成）

- 日期：2026-08-06
- 关联 spec：FS-04（AI 对话提交）——起草新增 AC-35 diff（见本文末，**未合并**，待人审）
- 类型：逻辑/行为增强（涉及 spec → 起草 AC diff）
- 改动文件：`public/field.html`（纯前端 + `.send.stop` 样式）、`tools/fs-04-stop-sending.logic.test.mjs`（新增测试）

## 背景 / 现象
用户反馈：现场端 AI 对话在「正在思考中…」或流式逐字生成时**无法中断**——发送后按钮置灰死锁，只能干等。三条发送路径均无 `AbortController`，发出去的请求无法取消。

## 根因
- 前端 `chat.sending` 只做「防重复发」，`setSending(true)` 把发送按钮 `disabled`；无中断入口。
- 三条路径的 `fetch`/`api()` 都没带 `signal`。
- 服务端 consult 其实**早已支持断连即中止上游模型**（`server.mjs` L2278：`res.on('close', () => { if (!res.writableEnded) ac.abort(); })`；SSE done 事件契约也含 `stopped` 字段）——缺的只是前端 abort fetch 来触发这个 close。

## 解法（纯前端为主）
1. **AbortController**：`chat` 新增 `abortCtrl`；`sendChat` 发送前 `new AbortController()`；三条路径带 `signal`：
   - `sendConsult` 原生 `fetch` → `signal: chat.abortCtrl && chat.abortCtrl.signal`；
   - `sendIntake`/`sendIntakeReply` 走 `api()` → 传 `signal`。**`api()` 无需改**：其实现 `fetch(path, Object.assign({headers}, opts))`，`Object.assign` 已把 `opts.signal` 合并进 fetch init，signal 自动透传（已加测试 A3 锁定）。
2. **停止态按钮**：`setSending(true)` 把「发送」按钮切「停止」态——不再置灰死（`disabled=false`）、换图标 `ti-player-stop` + 文案「停止」+ 加 `.stop`（红色 `#e5484d`）；`setSending(false)` 切回「发送」。按钮点击分派：`chat.sending ? stopSending() : sendChat()`。回车只发送（`sendChat` 内 `if(chat.sending)return` 自动挡住，不误停）。
3. **中断收尾（区分主动停止 vs 真错误）**：新增 `isAbort(e)`（`e.name==='AbortError'` 或 `signal.aborted`）。
   - consult：abort → reader/fetch 抛 → `.catch` 复用 `finishConsult`，**保留已流式生成的部分** + 尾部「（已停止）」；`finishConsult` 增 `aborted` 参数，停止时**不追加**「沉淀经验库 / 转工单」入口（答复不完整无价值沉淀）。
   - intake-chat / reply：`api()` 抛 AbortError → catch 判 `isAbort` → 气泡显「（已停止）」、清思考动效、**不弹网络错误 toast、不走人工兜底 `offerFallback`**（区别真错误）。
   - 三路径统一：`chat.abortCtrl=null` + `setSending(false)`（按钮回「发送」，可重新发）。
4. **切走时收尾旧请求**：`newConversation` / `restoreConversation`（切系统恢复）里若 `chat.sending` 则先 `abort()` 旧请求，避免旧响应/流式串进新会话。
5. `stopSending` 挂 `window.__field`（照现有风格）。

## 验证
- **逻辑测试**：`tools/fs-04-stop-sending.logic.test.mjs` 16/16 绿（A 段静态断言三路径 signal/停止态按钮/收尾复位/切走 abort；B 段复刻 `isAbort`/`setSending`/停止流程状态机）。相邻 FS-04 测试无回归。
- **连 prod（静态部署不重启）**：`field.html` scp 到 `/opt/intake/public/field.html`（备份后覆盖，md5 校验前后一致、部署后 = 本地新版；备份已清）。`http://intake.lcpharmacy.cn/field.html` HTTP 200、含 17 处 `abortCtrl` + `ti-player-stop` + `stopSending` + `.send.stop` CSS。**未造工单**（纯静态前端改动，未触发建单）。服务端 consult 断连即中止逻辑已在线（L2278）。
- UI 点击验证（提需求发一条→思考中点停止→中断/清动效/按钮回发送/可再发；咨询流式生成中点停止→保留已生成部分停下；停止不弹错误 toast；不点停止照常建单）需人在浏览器过一遍。

## 为何涉及 spec（起草 AC-35，未合并）
原 spec 只描述「发送/流式/建单」，未覆盖「发送中可中断」这条交互行为。新增可交互的停止能力改变了发送中的可操作性 → 补一条回归 AC，把行为写清楚。

### spec diff（FS-04，待人审后合并）
在 `### I.` 段（AC-34）后新增：

```
### J. 发送中可中断（「停止」按钮 · 2026-08-06）
- **AC-35【AI 生成中可点「停止」中断 · 区分主动停止与真错误】** Given 现场在右侧对话区发送了一条（提需求/报BUG 或咨询），AI 处于「正在思考中…」或流式逐字生成中 When 用户点发送按钮位置的「停止」（`chat.sending` 时「发送」按钮切「停止」态：`ti-player-stop` + 文案「停止」+ `.stop` 红、**不置灰**、可点；点击分派 `stopSending()`）Then 前端 `chat.abortCtrl.abort()` 中断本轮请求——三条路径（`sendConsult` 原生 fetch SSE / `sendIntake` `intake-chat` / `sendIntakeReply` `intake-reply`）均带 `signal`（`api()` 经 `Object.assign` 透传 `opts.signal`）；consult 断连触发服务端 `res.on('close')` 中止上游模型（`server.mjs`，SSE done 契约含 `stopped`）。And 中断按「用户主动停止」收尾（`isAbort(e)`：`e.name==='AbortError'` 或 `signal.aborted`）：**consult 保留已流式生成的部分**（尾部「（已停止）」，且**不追加**「沉淀经验库/转工单」入口）；**intake-chat/reply 显「（已停止）」、清思考动效、不弹网络错误 toast、不走人工兜底** `offerFallback`（与真网络错误区分）。And 三路径统一复位 `chat.sending=false`、按钮切回「发送」、`chat.abortCtrl=null`，用户可**重新发送**。And 切「新对话」/切系统上下文时若仍在发送中 → 先 `abort()` 旧请求（`newConversation`/`restoreConversation`），旧响应不串进新会话。**不破坏** `sending` 防重复发、`setThinking`、附图、多单建单（AC-11/12）、消息不丢等既有逻辑。
```

同步更新 AC 计数行（L108）：`共 34 条` → `共 35 条`，追加 `AC-35（发送中可中断「停止」，2026-08-06）P1`。

## 风险 / 备注
- consult 停止后保留的部分答复会 push 进 `chat.messages`（作为 assistant 半句），续聊时带上；符合「保留已生成内容」的预期，不影响后续发送。
- intake-chat/reply 停止后 AI 气泡显「（已停止）」但**该轮 user 消息已在 messages 里**（发送时 push），续聊上下文完整；未建单（服务端未返回 record）→ 无脏单。
- prod 走 http（HTTPS 证书仍待办，见记忆 deploy-cloud）；本次仅静态文件，无需重启容器。
