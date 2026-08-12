# CHG · FS-04 答疑 Spec 两阶段召回

- 日期：2026-08-12
- 类型：召回缺陷修复 + 行为边界补充（已同步 FS-04 AC-44）
- 状态：已实现、脱库自测通过，待人验收；未改库、未部署

## 诊断证据

PWRS 用真实 UI + Qwen-Max 跑 50 个事实锚点×4 问法，严格可用 63/200（31.5%）；135 题回答含“当前资料无法确认”，其中 120 题的事实已在 Spec。旧链路有两类根因：

1. `specEntries` 每仓只取前 30 份，`loadSpecTexts` 每仓只取前 60 份。PWRS `docs/specs` 有 86 份正文；按 `git ls-tree` 顺序，`PWRS-SYS-07a` 位于第 79 份、`PWRS-SYS-10` 位于第 82 份，旧链路对它们完全不可达。
2. `specIndex` 只作为模型提示清单，正文却全库切成约 560 字后单阶段混排 Top5，导致正确文件后部表格/API 丢失，也容易被“监护/记录/完成/删除/连接”等同词的错模块抢占。普通问答向 Qwen 注入全部 86 份标题，还会带来额外实体噪声。

## 变更

1. 新增可脱库测试的 `spec-retrieval.mjs`，建立真两阶段：
   - 第一阶段扫完整 Spec 集，用文件路径、frontmatter `id/title/module`、subsystem、Markdown 标题层级和精确 API/字段/状态标识符路由有限候选文件。正文抽取的 identifier 仅是机器路由索引，不直接输出成证据。
   - 第二阶段只切候选文件正文，按标题层级保留长章节/长表格后部，强匹配 API 路径、`snake_case`、`camelCase`和状态值；Top5 每文件最多 3 段并做文件多样性。最终命中均显式标记 `evidence='body'`。
2. 移除每仓前 30/60 份和全局 90/150 份的不可达截断，保留 10 分钟只读文本缓存。
3. 精确小写参数 `word` 保持大小写边界，避免被 Word 导出抢占；精确 SQL/数据库连接命中会压低只蹭 WebSocket “连接”的弱片段；显式 `subsystem` 在有可用 Spec 时先收窄。
4. `/api/consult` 仍保留最近 24 条消息支持追问，但检索只用最后一条 user 问题，并注入本轮事实边界：历史其它模块只能帮助理解代词，不能迁移为当前事实。无正文证据时仍安全拒答，没有放松既有证据闸门。
5. 普通事实问答只把本轮命中的精简规格目录给模型；只有明确询问“有哪些模块/功能/规格目录”才提供完整目录。无论哪种情况，目录标题均明示为导航、不是事实证据。

## 回归证据

- `node --check spec-retrieval.mjs` → 通过。
- `node --check server.mjs` → 通过。
- `node --test tools/spec-retrieval-two-stage.logic.test.mjs tools/fs-06-consult-kb-evidence.logic.test.mjs tools/pd-02-prompts.logic.test.mjs` → 32 通过 / 0 失败。
- 相关 FS-04/FS-06/PD-02/codeSearch 脱库组合回归 → 168 通过 / 0 失败 / 2 条 MySQL 环境跳过，共 170 条。
- `node --test tools/*.logic.test.mjs` → 297 通过 / 0 失败 / 6 条 MySQL 环境跳过，共 303 条。
- PWRS 真实锚点（不依赖 Qwen）覆盖：`word` 是否传 ETL、统一 ETL 入口/`interfaceCode`、SQL 客户端支持的数据库类型、SQL 客户端是否调 PWRS HTTP；均断言 SYS-07a/SYS-10 进入候选与正文 Top5。
- `node --test tools/fs-04.test.mjs tools/fs-06.test.mjs` 在共用 before hook 统一阻断于 `connect ECONNREFUSED 127.0.0.1:3306`，102 条未进入业务断言。这是本机 MySQL 不可用，不得记为业务回归通过。

## 边界与风险

- 本次只改 Spec 召回与 consult 提示接线；KB 检索、`codeSearch` 排序/取片、数据库契约均未改。
- 无数据库字段/持久层改动，故本变更不涉及真库写入冒烟；但完整 FS-04/FS-06 套件仍需在有 MySQL 的环境补跑。
- 未调用真实 Qwen，未做 200 题模型端到端复跑；当前证据验证确定性召回与提示边界，最终答复可用率需人工验收时复测。
- task 保持 `doing`，FS-04 `accept=wait`，未标 `done`。
