# CHG · consult 长会话异常可见与上下文收敛

- 日期：2026-08-25
- 关联 spec：FS-04 AC-133
- 类型：生产回归修复（Q0010 context_followup / SSE 可观测性）

## 现象与根因

生产长会话 Q0010 连续两次约 30 秒后，浏览器只显示“连接提前结束，AI 未返回可显示内容”，容器未留下可关联到该请求阶段的日志。检查确认 `/api/consult` 把 `async` 回调直接传给同步 `readBody`，后者既不等待也不接住 Promise；模型调用之外的检索后处理、prompt、发布前 audit、fallback 或持久化异常会脱离端点控制，SSE 没有机会保证 `err/done`，浏览器只能把裸 EOF 解释成空流。另有历史 payload 最坏可达 24×4000 字符，会放大长会话上游耗时和上下文压力。

Q0010 的“我没完全听懂……换成实施只读清单”也未命中原对话 cue，且未被明确视为 route 承接型重述，导致生成目标和事实继承不够稳定。

## 修复

- `/api/consult` 自己接住完整 async Promise，按 refresh/retrieval/routing/prompt/model_draft/answer_audit/persist/done 标记阶段；未预期异常记录安全的 requestId、stage、error 摘要。
- SSE 可写时固定发送一条带可见正文的 `err:true/code=consult_internal_error`，随后发送 terminal `done:true/error:true` 并结束；已捕获的模型失败也带请求编号，持久化失败不再静默吞掉。
- 路由/持久化继续使用最近 24 条、单条最多 4000 字的有界历史；模型 payload 单独收敛为最近最多 12 条、合计不超过 16000 字，当前问题与上一答复优先保留。route answerFacts/contextRefs 仍独立注入。
- 扩充“没完全听懂/换成实施清单”对话 cue 与 context_followup，按 mixed + implementation 处理并继承同主题 route，不把 assistant 历史当事实。

## 回归证据

- `tools/fs-04-consult-safe-final-stream.logic.test.mjs`：构造 18 轮近上限长消息，验证 24 条 route 历史、12 条/16k 模型预算、Q0010 当前问题和上一回答保留；注入 answer_audit 异常验证可见 err、terminal done 与阶段日志。
- `tools/fs-04-consult-conversation.logic.test.mjs`：生产原句命中 mixed 对话意图与 implementation 受众。
- `tools/pd-04-route.logic.test.mjs`：C002/Q0010 形态继续继承医嘱标记 route 和事实账本。
- 2026-08-25：`node --check server.mjs` 通过；consult 相关套件 163 项中 132 通过、31 项为既有真实 PWRS 环境门控跳过、0 失败；`git diff --check` 通过。

## 风险边界

- 客户端已经主动关闭或网络已物理断开时，服务端无法向失效连接补发 SSE；此时仍会记录 requestId/stage 日志。
- 历史裁剪只收敛模型输入；超过最近 24 条的更早会话内容沿用既有限制，不作为事实来源。生产浏览器与反向代理复测证据另行记录。
