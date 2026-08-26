# CHG · 咨询模型长度截断不得发布半截回答

## 现象

生产 Intake 回答较长的多子问题时，正文在“Upsert 策略”标题后只剩孤立横杠，后面又重复出现“研发参考”。Audit Spec 与路由事实完整，但浏览器最终答案缺少中间业务结论。

## 根因

- 普通咨询草稿只给 800 tokens，复杂业务题容易触达上游长度上限。
- 流式客户端只累计正文，没有读取 OpenAI 兼容流的 `finish_reason=length` 或 Anthropic 兼容流的 `stop_reason=max_tokens`。
- 已收到部分正文时，调用被视为成功；半截草稿或半截修订稿随后进入安全清理，清理只能删违规片段，无法恢复被模型截断的事实，因此产生残段和重复技术附录。

## 修复

- 普通咨询与深入思考的草稿/修订预算分别提高到 1500/1800 tokens。
- 两类兼容流都记录结束原因；命中 `length/max_tokens` 时抛出 `MODEL_OUTPUT_TRUNCATED`，不得视为完整回答。
- 初稿截断时不审计、不发布已累计部分，走现有可见模型错误与 terminal `done` 收口。
- 修订稿截断时丢弃部分修订，继续使用完整初稿的确定性安全降级路径。

## 验证

- `node --check server.mjs`
- `node --test tools/mc-01-model-request.logic.test.mjs tools/fs-04-consult-safe-final-stream.logic.test.mjs`：18/18 通过。
- `node --test tools/fs-04-*.logic.test.mjs tools/mc-01-model-request.logic.test.mjs tools/pd-04-route.logic.test.mjs`：215 通过、0 失败、33 个真实 PWRS/真库条件项跳过。
- 本机旧集成套件依赖 `127.0.0.1:3306`，MySQL 未启动时无法作为本轮本地真库证据；部署后须在生产真实 MySQL + 模型配置下复测原问题，并核对无孤立结构、无丢失业务分支。

## Spec

补充 `FS-04 AC-137`，把长度截断的终稿完整性边界写入事实源。
