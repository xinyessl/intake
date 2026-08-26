# CHG · 阿里云 Qwen 3.8 Anthropic 禁用 thinking

- 日期：2026-08-26
- 关联 spec：MC-01 AC-12
- 范围：`server.mjs` 的 Anthropic 流式与非流式模型请求；不改模型配置文件结构、数据库和前端。

## 现象与根因

生产主模型配置为 Anthropic provider、`qwen3.8-max`、阿里云 `/apps/anthropic` 兼容端点。默认请求会返回 `content:[{type:'thinking'}]` 并以 `max_tokens` 停止，没有 `text`；非流式正文提取结果为空，流式调用则一直等不到可显示首字。

同一端点在请求体加入 `thinking:{type:'disabled'}` 后可快速返回 `text`。该参数是 Qwen 兼容边界，不能对全部 Anthropic 请求启用或禁用，以免改变 Claude 备用模型行为。

诊断阶段的真实上游验证：禁用 thinking 后，`qwen3.8-max` 流式请求 HTTP 200，约 10.8 秒出现首字、11.9 秒完成并返回 86 字正文；这证明请求体兼容有效，但不属于本次未部署代码的生产验收。

## 修复

- 增加单一请求体判定：仅 `provider=anthropic`、模型名为 `qwen3.8*` 且 `baseUrl` 主机属于 `aliyuncs.com` 时返回 `thinking:{type:'disabled'}`。
- `callModelOnce` 与 `callModelStreamOnce` 共用该判定；其它 Anthropic/OpenAI 候选请求体保持原样。
- 不改变主备顺序、超时、SSE 解析、多模态消息和 Key 配置格式。

## 自动化证据

`tools/mc-01-model-request.logic.test.mjs` 真实执行服务端两条调用函数并检查发送请求体，覆盖阿里云 `qwen3.8-max` 的流式/非流式正例，以及普通 Claude/Anthropic、非阿里云 Qwen 的反例。

## 风险边界

- 判定依赖显式 provider、模型名和 URL 主机；未命中三项的兼容端点不会自动改写。
- 本修复只保证请求体兼容与正文可返回，不改变上游限流、网络超时或模型回答质量。
