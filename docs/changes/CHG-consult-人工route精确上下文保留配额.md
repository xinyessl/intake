# CHG · consult 人工 route 精确上下文保留配额

- 日期：2026-08-25
- 关联 spec：PD-04 AC-3 / AC-9
- 类型：行为修复（检索上下文组装与发布前直接证据边界）

## 现象与根因

生产 Q0009 已命中医嘱标记人工 route，route 的 `contextRefs` 明确导出接口、持久表、软删除、权限和入口；但实际模型上下文按“answerFacts + 5 条 specSearch + 剩余 route”填充 cap=7，导致精确 contextRefs 几乎全部被宽泛搜索挤出。`directEvidenceFacts` 又从最终全部 `specHits` 反推，既遗漏被挤出的人工证据，也把宽泛搜索混成 route 直接证据。模型因此把已核契约错误声明为“未定义”。

## 修复

- `loadRouteContext` 为 primary/context/spec 引用保留来源类型。
- `assembleConsultSpecHits` 固定 answerFacts 最高优、最强 search 仅占一个纠偏位，其余配额优先放人工精确引用；有 answerFacts 时跳过重复“当前事实/As-built”摘要，cap 仍不超过 7。
- `directEvidenceFacts` 只取本轮实际注入的 answerFacts/route refs，不再由混合后的全部 `specHits` 生成。
- 不改产品功能地图、audit Spec、fixture 或 gold，不放宽研发显式追问。

## 回归证据

- `tools/pd-04-route.logic.test.mjs`：Q0009/MK-02 生产形态覆盖导出 `GET /comm/ipt/collects/excel`、`audit_ipt_collect`、`deleted=1`、权限和入口同时进入 cap=7；宽泛 search 仅一个纠偏位且不进入 directEvidence。
- 咨询、SSE、prompt、KB 与两阶段 Spec 检索相邻套件保持全绿。

## 风险边界

- cap 仍为 7；人工 route 超过可用精确引用数量时按 context 优先、契约标题加权、原顺序稳定取舍，不无限扩大上下文。
- 生产真模型复测证据另行记录；建议沿用同一 Q0009，确认模型不再声称已核导出/表/软删除未知。
