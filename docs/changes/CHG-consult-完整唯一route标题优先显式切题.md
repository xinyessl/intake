# CHG · consult 完整唯一 route 标题优先显式切题

- 日期：2026-08-25
- 关联 spec：PD-04 AC-11
- 类型：生产回归修复（Q0014 路由错配）

## 现象与根因

Q0014 明确说“先切到另一个问题：处方标记”，specSearch 也正确命中 MK-01，但 tier-1 route 被宽泛“审方关键接口与边界 FAQ”和相邻“医嘱标记”盖过，selected 变成 FAQ。模型因而只拿到 FAQ answerFacts，把 MK-01 已核入口和处理链降级为局部未知；发布前语义审计只能检查给定 route 内的一致性，无法从 specSearch 反向替换错误 route。

根因是 tier-1 只比较 searchText/alias/keywords 的 IDF 分与 alias bonus，没有把人工 route title 的完整唯一命中当成显式业务实体。通用“当前实现、关键入口、处理链”在宽泛卡片里更多，反而压过用户逐字点名的短标题。

## 修复

- tier-1 打分后检查当前问句是否完整包含唯一 route title；若唯一命中，将该 route 强制置为 selected 和 `topN[0]`，并允许它直接越过普通分数阈值。
- 强制规则要求完整标题且至少 4 字符；部分词不算，完整出现多个标题的比较题不武断选边。
- `retrieval.routing` 增加 `exactRouteTitle`，生产回放可直接区分标题强制与普通 IDF/alias 命中。
- 普通 FAQ 完整标题仍可强制命中 FAQ；既有上下文继承和显式新实体切题规则保持。

## 回归证据

- `tools/pd-04-route.logic.test.mjs`：真实 Q0014 形态在 FAQ/MK-02/MK-01 竞争中命中 MK-01，带出 As-built answerFacts；覆盖部分“处方”、双标题比较、FAQ 完整标题、Q0010 承接及既有 topic switch。
- 生产浏览器复测证据另行记录。

## 风险边界

- 地图若存在重复 title，或用户同轮明确比较多个完整 title，不启用强制规则，继续走原打分/上下文裁决。
- 本修复不改变 specSearch、answer audit 或无地图产品行为。
