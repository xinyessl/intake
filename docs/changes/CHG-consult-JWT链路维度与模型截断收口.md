# CHG：JWT 链路维度与模型长度截断安全收口

日期：2026-08-30

## 背景

审方 `2.7.260829-3` 的 Q0789 要求把免鉴权路径与 JWT 从入口、接口/数据串到外部依赖。原链路组装按关键词跨 fact 归类，可能同时把普通 JWT 分支写成数据状态、把 Shiro/JwtFilter 写成外部依赖，形成入口与依赖自相矛盾。Q0790 的模型稿若因 `finish_reason=length` 或 `stop_reason=max_tokens` 截断，旧失败口还可能统一显示为“AI 暂时连不上”，没有优先利用本轮 current route 的已核只读顺序安全收口。

## 改动

- `server.mjs`
  - 链路事实先识别 route 的显式维度标签；入口、接口、数据与状态、外部依赖、处理分支和停点分别归组，标签事实不再被其它关键词跨组复用。
  - 外部依赖只截取明确外部调用 clause；JWT 链路保留用户中心 `IDubboUserCenterService.verifyToken`，排除 Shiro/JwtFilter 和否定依赖句。
  - route 以“第 1 至 3 步 / 第 4 步 / 禁止扩展”发布只读顺序时，确定性 fallback 按原子步骤重建并用同一终审复核，不追加通用状态接口、数据库或页面清单。
  - OpenAI `finish_reason=length` 与 Anthropic `stop_reason=max_tokens` 统一抛 `MODEL_OUTPUT_TRUNCATED`；模型草稿失败先尝试 current route 的 verifiedFacts/evidenceStop，无法发布时按长度、限流、超时和普通连接错误分别给可见文案，并记录精简的 `modelDraftError` 与真实 `fallbackSource`。
- `tools/fs-04-consult-conversation.logic.test.mjs`
  - 使用审方 tag 的 Q0789/Q0790 精确原问及自然变体，验证 route、维度、顺序、未知停点、外部依赖和终审全绿。
  - 覆盖长度截断、429、超时的分类与可见文案，防止长度限制误报网络错误。
- `tools/fs-04-consult-safe-final-stream.logic.test.mjs`
  - 锁定模型失败先走 verified fallback、运行态记录真实来源、无 fallback 时按错误分类发布的接线。

## 规约同步

- `FS-04` 新增 AC-143/144。此次缺陷暴露了“显式 route 标签优先归组”与“截断时 verifiedFacts 可安全收口”的合同缺口，因此不只记纯代码修复。

## 验证

```text
node --check server.mjs
node --check tools/fs-04-consult-conversation.logic.test.mjs
node --check tools/fs-04-consult-safe-final-stream.logic.test.mjs
node --test tools/fs-04-consult-conversation.logic.test.mjs
node --test tools/fs-04-consult-safe-final-stream.logic.test.mjs
git diff --check
```

结果：FS-04 答疑逻辑 37/37、终稿流式 16/16 通过。另起隔离 MySQL 8.4、当前 `server.mjs` 与 OpenAI 兼容截断 SSE（先发送半句，再以 `finish_reason=length` 结束），经真实 `POST /api/consult` 验证审方 `2.7.260829-3` 的 Q0789/Q0790 精确原问及各自自然变体共 4 条：全部得到 `modelDraftError.kind=length_limit`、`fallbackSource=verifiedFacts`、`finalViolations=[]`；Q0789 仅保留 usercenter `IDubboUserCenterService.verifyToken` 外部依赖，Q0790 保留四步只读顺序且没有通用状态接口/DB/页面对象清单。真 MySQL 最终核到 9 条咨询记录均留有 `MODEL_OUTPUT_TRUNCATED`，截断半句落库数为 0。本次未修改或纳入任何 PWRS QA fixture/evidence，未提交、未 tag、未部署。
