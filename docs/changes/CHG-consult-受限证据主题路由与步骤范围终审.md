# CHG：受限证据主题路由与步骤范围终审

日期：2026-08-31

## 背景

审方 `2.7.260829-3` C159 Q0793 精确问句已点名“免鉴权路径与 JWT”，但“只有一次既有请求和响应、没有数据库权限、现有证据最多能判断到哪”这段通用后缀在多个 route alias 重复，整句 IDF 排序因而被无关 AI route 抢题。改回 JWT current route 后，其已核事实中的“第 1 至 3 步”范围标题和“第 4 步仅适用于普通 JWT”描述标题又被步骤完整性终审误判为未定义，导致 OpenAI length 已准确分类，但仍不能从 current route 生成安全终稿。

## 改动

- `server.mjs`
  - 通用识别受限证据问句，从限制说明前的实体、具体证据材料和判断对象组合主题查询；去通用材料前先 trim 尾部标点，避免“既有请求和响应，”因中文逗号残留而清空前文主题。
  - 先用主题分锁定候选簇，仅在主题分达到最高候选 80% 的同簇 route 之间，再用完整问句区分事实链、证据续查等意图。规则不依赖 Q0793 或具体 route id。
  - 步骤终审支持“第 N 至 M 步”数字范围，以及“第 N 步仅适用于…：”等带短限定语的定义标题，保持其它未定义步骤的拦截。
- `tools/fs-04-consult-conversation.logic.test.mjs`
  - 用 Q0793 精确原问和不同表达的自然变体锁定 `AUD-QR-SYS-01-JWT-CONTINUE`。
  - 分别注入 OpenAI length 与 HTTP 429，断言安全收口来源为 `verifiedFacts`、错误分类正确、终审零违规，答复保留同一次既有请求、能确定与本轮未知的边界，不建议新查数据库。

## 规约同步

`FS-04` 新增 AC-145。此次不只是某道题的纠偏，而是补齐“通用证据模板不得压过业务主题”和“route 原子步骤标题的完整性语义”两条发布合同。

## 验证

- `node --check server.mjs` 与本轮测试文件通过，`git diff --check` 通过。
- focused `二次修订失败时安全降级` 1/1；FS-04 答疑逻辑 full 37/37；安全终稿 SSE full 16/16。
- 另起隔离 MySQL 8.4、当前 `server.mjs` 与本地 OpenAI 兼容假上游，以真实 `POST /api/consult` SSE 请求审方 `2.7.260829-3` Q0793 精确原问（先发截断半句再 `finish_reason=length`）与自然变体（HTTP 429）。两条均返回 `fallbackSource=verifiedFacts`、`finalViolations=[]`，并分别记录 `modelDraftError.kind=length_limit/rate_limit`；真 MySQL 落 2 条 consult，两类错误各1条，上游截断半句落库 0 条。
- 已删除临时容器、数据目录与冒烟脚本。本次不提交、不打 tag、不部署。
