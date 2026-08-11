# CHG · PD-04 答疑路由架构修复：specSearch 作底座、路由作加成（弱/错路由不再盖掉更强 specSearch）

- 日期：2026-08-11
- 关联 spec：PD-04（**涉及 spec**，diff 已随交付附上：新增 AC-8 回归 + 修订 §2/§3/§6/§8；见验收门）
- 类型：逻辑/行为调整（架构缺陷修复，回归 bug）

## 背景 / 根因
consult 答疑：有「功能模块地图」的产品，路由一旦命中就**只用** `loadRouteContext` 的路由内容、**完全丢掉** specSearch；路由未命中就直接 miss 固定话术（也不看 specSearch）。即：有地图时 routing **完全取代** specSearch。
- 实测 bug：问「系统激活失败，怎么排查」→ 路由弱/错命中 `QR-DQ-011「HIS 收费失败」`（靠「失败/系统」弱重叠），但 specSearch 给正确的「系统激活注册」spec 打了 **16.5** 高分——却被路由内容盖掉，AI 拿到「收费失败」内容 → 误判「没覆盖激活」→ 误说没覆盖（回归）。

## 改动（仅 `server.mjs` 的 consult 检索组装 + 阈值常量 + PD-04 测试 + 本 CHG）
1. **新增可配置常量** `SPEC_MIN_RELEVANT = 8.0`（specSearchScored 首条 IDF 得分阈值，保守初值，部署后 pwrs 回放调）。
2. **新增纯函数** `assembleConsultSpecHits(matched, routeHits, searchHits, minRelevant, cap=7)`（可单测）：
   - 路由**命中**：route 精选事实（含 answerFacts 顶段）置前 + specSearch 底座补后，按 `module|title|text[0:120]` 去重、cap≤7 → answerFacts 仍最高优，但 specSearch 强匹配一起喂模型。
   - 路由**未命中**：specSearch 首条 ≥ minRelevant → 用 specSearch（`noSpec=false`）；否则空（`noSpec=true`，上层走 miss 固定话术）。
3. **consult 端点接线改**：
   - **始终跑** `specSearchScored(proj,cver,qtext,5,sub)`（有地图也跑），一处两用（喂模型底座 + 喂 buildRetrieval 诊断，避免重复检索）。原「miss 时把 specScored 单独重算喂诊断」的 `specScored` 变量并入 `searchScored`。
   - 有地图分支统一用 `assembleConsultSpecHits` 合成 `specHits`；无地图分支**不变**（仍 `specSearch(...)`，向后兼容硬要求）。
   - `noAnswer`（miss 固定话术）判据由 `routeMiss && !(deep&&code)` 改为 `routeMiss && specNoSpec && !(deep&&code)`——specSearch 强匹配时即便路由 miss 也不再走固定话术。
4. **诊断透出**：`retrieval.routing` 加 `usedSpecSearch`（是否用了 specSearch 底座）、`specTop`（specSearch 首条分）、`specMinRelevant`（阈值），consult + retrieval-replay 两处均带，方便回放判断/调阈值。
5. **未动**：提示词（consultNormal/Deep 功能级覆盖判定已对）、KB 门槛（consultKbFilter/kbRefs/首 token 门控不变）、codeSearch（deep 源码单独走，用当前 specHits 当桥）、前端、lsy 的 kbRefs、PD-03 retrieval 捕获（仍并列挂末条 assistant + 续聊回贴历史）。

## 覆盖 AC
- **AC-8（新增·回归）**：路由错配/未命中不该盖掉强 specSearch——`assembleConsultSpecHits` 三态单测 + 真实场景脱库冒烟三条全绿。
- AC-1/2/3/6/7 不回归（specSearch 底座是叠加、无地图完全不变）。AC-4 固定话术仅在 specSearch 也弱/空时触发（条件加严 `specNoSpec`）。

## 测试
- `tools/pd-04-route.logic.test.mjs`：新增 6 条（路由命中合并去重+cap≤7、未命中 specSearch 强不 miss、未命中 specSearch 弱/空 miss、端点接线源码级）；更新 2 条陈旧源码级断言（`noAnswer` 条件、`buildRetrieval` 的 spec 参数改名 searchScored）。20/20 通过。
- `tools/consult-kb-gate.logic.test.mjs`：更新 1 条源码级断言（`buildRetrieval(..., searchScored, kbScored, ...)` 变量改名，KB 全召回 kbScored 意图不变）。
- 全量 `*.logic.test.mjs`：**332/332 通过**（fs-06/pd-02/pd-03/pd-04/consult-kb-gate 均不破坏）。
- `node --check server.mjs` 通过。
- 真实场景脱库冒烟（抽 server.mjs 真身 routeQuestion/assembleConsultSpecHits/routingDiag，用重现报告结构的 map + 报告给定的 specSearch 打分形态）：
  - 「系统激活失败怎么排查」→ route 未过阈值(2.942)/或误命中，specTop=16.5 → `usedSpecSearch=true noSpec=false`，specHits 含「系统激活注册」→ **不 miss，据激活注册作答** ✔
  - 「检验异常值箭头怎么不显示」→ route miss、specSearch 空 → `noSpec=true` → **仍 miss 固定话术** ✔
  - 「床位号怎么查患者」→ specTop=11.2 → specHits 含「床位号查询」→ **作答** ✔
  - 补验：路由 `matched=true` 误命中收费情形，specHits=[经确认事实, HIS收费失败, 系统激活注册, 收费]，answerFacts 置前 + 激活注册一并进 ✔

## 风险 / 待办
- `SPEC_MIN_RELEVANT=8.0` 是保守初值——过低会让弱 specSearch 也顶掉 miss 话术（多答但可能跑题），过高会漏掉本该答的。**部署后连真模型 + 真 pwrs 回放调准**（`retrieval.routing.specTop` 可看每问 specSearch 首条分）。
- 本机无真 pwrs 模块地图（在 prod 产品仓维护，未 checkout），冒烟用重现报告结构 map + 报告给定打分形态跑真身函数；**最终阈值/三条场景由编排器部署后连真模型验**。
- **未 commit、未部署**（按护栏）。
