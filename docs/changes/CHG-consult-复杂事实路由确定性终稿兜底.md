# CHG · 复杂事实路由确定性终稿兜底

## 现象

生产第 54 题的模型初稿与一次修订均未通过发布审计。通用安全 fallback 虽然删除了越界实体和危险动作，却同时删漏了完整保存对象、普通 INSERT 类等已核事实，并重复追加“研发参考”和 `- -` 列表标记。

## 根因

通用 fallback 只有“删违规句、移动技术段”的能力，没有“当前 route 的全部 answerFacts 必须作为一个完整集合发布”的契约。第二轮 fallback 再处理第一轮结果时，还会重复搬移技术段。

## 修复

- question route 可显式声明 `fallbackMode='verifiedFacts'`；未声明的所有既有 route 保持原行为。
- 语义审计把 current route 的完整 facts 和 opt-in 标记交给 fallback。
- 模型修订失败时，opt-in route 忽略不安全草稿，按“首条业务结论、其余实施口径”重建终稿，不追加通用尾注或重复技术附录。
- 终审仅在正文逐行精确等于全部 route facts 时，放行原句中已核的“可失败/未经授权不得重放”等边界；任何新增句仍按原规则拦截。
- Markdown 安全归一化补充 `- -` 双列表标记清理。

## 验证

- `node --check server.mjs`
- `node --test tools/fs-04-consult-conversation.logic.test.mjs`
- 生产形态回归覆盖保存范围、后台触发/批量、Upsert 与普通 INSERT、部分成功/回滚/重试、坏 JSON 阻塞，并断言无重复“研发参考”和双列表标记，终审全绿。

## Spec

补充 `FS-04 AC-138`。
