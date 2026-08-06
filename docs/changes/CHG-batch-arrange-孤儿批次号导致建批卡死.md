# CHG · 孤儿批次引用导致「定档建批」卡死 + 漏斗误显开发中 —— 清数据 + batch-arrange 加批次存在性校验

- **日期**：2026-08-06
- **来源**：用户指派——修 intake 平台「脏数据 + 缺防御」bug：工单挂了个不存在的批次号，导致「定档建批」永远说"没有已落实待分批的工单"、且工单管理漏斗把它误显为"开发中"。用户已在 prod 查实，直接按此修。
- **spec**：批次流（BP-01 定档建批 / batch-arrange）。**行为意图不变**（本就该「只有真实归批才算已归批、孤儿引用不该卡死建批」），属实现缺陷（判定只看 `e.batch` 非空、没校验批次真实存在）→ **纯 bug 修复，不改 spec**。

## 类型
纯 bug 修复（孤儿批次引用卡死建批 + 误显开发中）。不涉 spec。CHG 记一条。

## 现象 / 根因
- prod：`data/batches.json` = `{"batches":[]}`（批次总数 0，一个都没有）。工单 `BUG-20260806-01`（产品 hlyy=合理用药）的 `e.batch` = **`"HLYY-0815"`**，但这个批次不存在，且连本系统 `batchGenId` 的格式（`B-<seq>` 如 `B-01`）都不是——是早前冒烟/手工测试**残留脏数据**。
- 后果链：
  1. `batch-arrange`（server.mjs · 定档建批）候选筛选**只要 `e.batch` 非空就判「已归批」跳过** → 该工单被跳过 → 「定档建批」提示"该产品当前没有已落实待分批的工单"（其实它是该产品唯一已立项工单、本该能归批）。
  2. 工单管理漏斗（inbox.html 的 `effLifecycle`：`已立项 && item.batch → 开发中`）也因它"有 batch"把它显成"开发中"，而非本该的"已落实·排期"。
- **根因**：判「已归批」只看 `e.batch` 非空，**没校验那个批次是否真实存在**。挂了不存在的批次号 = 既进不了新批次、又不在任何真实批次里 = 卡死。

## 改法
### 1) 数据清理（prod · 只动这一条记录）
清掉 `BUG-20260806-01` 的孤儿 `e.batch`（`HLYY-0815`）。按 `saveIntake` 双写范式改两处：
- **MySQL**：用项目自身 `db.mjs` 的 `loadAll()`/`upsertIntake(projectId, e)`（`batch` 随 `data` JSON 落库、非独立库列，见 db.mjs `upsertIntake` 的 `J(e)` + intakes 表 DDL）载入记录 → `delete e.batch` → 回写（整行覆盖，只 `data.batch` 被删，其余原样）。
- **文件**：改写 `data/intake-store/hlyy/BUG-20260806-01.json`（与库一致）。`.md` frontmatter（`renderIntakeMd`）本就不含 `batch` 字段 → 无需改。
- 做完 `docker restart intake-app` 让内存 CACHE（MySQL 为准）重载。`lifecycle=已立项` 保持不变。

### 2) 代码防御（`server.mjs` · batch-arrange 候选筛选）
把「已归批」判定从「`e.batch` 非空」改成「`e.batch` 非空 **且** 该批次在 `loadBatches()` 里真实存在」：
```
const list = loadBatches();
const liveBatchIds = new Set(list.map(bt => String((bt && bt.id) || '')));   // 真实存在的批次 id
...
if (String(e.batch || '').trim() && liveBatchIds.has(String(e.batch).trim())) continue;   // 孤儿批次号不算已归批
```
（把原本在循环后的 `const list = loadBatches()` 上提到循环前复用。）孤儿批次号 → 当未归批、纳入新批次；归批时 `e.batch` 会被覆盖成新的真实 `B-xx`，**自愈**。将来再有残留孤儿号也不会卡住建批。

**未碰**：`batch-release`（出包）等其它批次逻辑；`inbox.html` 的 `effLifecycle`（数据清理后它对该工单自然显对，孤儿场景已被数据层 + batch-arrange 兜住）；`intakeDeleteGuard` 的「已归批禁删」（数据清理后该工单 `deletable` 自然为 true；主修只这两条，孤儿禁删非本次范围，避免扩面）。

## 验证（prod · 连真库冒烟，未真建批次——留给用户在 UI 点）
- **数据清理后**：`BUG-20260806-01` 的 `e.batch` 已空 —— MySQL `JSON_EXTRACT(data,'$.batch')` = **NULL**（key 已删）、intake-store `.json` 无 `batch` key；`lifecycle=已立项` 保持。
- **连真库冒烟**（在容器内用项目自身 `db.mjs`·真实 `data/db.json` 凭据跑只读脚本，复刻 batch-arrange 候选筛选 + intake-list `mapItem` 判定，**不发 POST、不建批次**）：
  - `batches=0`、`liveBatchIds=[]`；
  - **batch-arrange 候选集 = `['BUG-20260806-01']`（含它 → 点定档建批会把它归入）**；
  - intake-list `mapItem`：`BUG-20260806-01` `batchId=''`、`lifecycle=已立项`、`deletable=true` → 前端 `effLifecycle` 归「已落实·排期(待分批)」，不再误显「开发中」。
  - 断言全绿（候选含它 && batchId 空 && lifecycle=已立项）。
- 部署：`server.mjs` scp 覆盖 `/opt/intake/server.mjs` + `docker restart intake-app`；`node --check` 通过、`docker logs` 无报错、`grep -c liveBatchIds`=2（改动落地）。
- 备份留 `/root/BUG-20260806-01.json.bak` + `/root/intake-BUG-20260806-01.sql.bak`（回滚用）；临时维护/冒烟脚本已从 host + 容器删除。

## 风险
- 低。数据清理只动一条记录（双写一致、有备份）；代码改动只收紧 batch-arrange 候选筛选（增一层「批次真实存在」校验，方向是"更少误判已归批"，不会漏归真实已归批工单——真实归批的 `e.batch` 一定在 `loadBatches()` 里）。
- 未改 batch-release / effLifecycle / intakeDeleteGuard，行为面最小。
