# PWRS Spec · Grok 4.5 局部证据作答回归

- 日期：2026-08-13
- 对应任务：`FS04-SPEC-RECALL-1`
- 生产 PWRS tag：`2.7.260813-16`
- 生产实际模型：`provider=anthropic` 协议适配、`model=grok-4.5`、`baseHost=grokproxy.zeabur.app`
- 状态：API/持久化真库回归通过；浏览器 UI 验收由主流程继续执行，任务保持 `doing`、`accept=wait`

> 2026-08-12 的 Qwen-Max 严格 200 题 `198/200` 仅作为两阶段召回的历史证据，不代表本次模型验收。本报告的线上答案均由生产 Grok 4.5 生成。

## 问题与定位

tag14 对“患者视图的患者列表从哪个接口获取数据，查哪个etl”机械整体拒答。生产持久记录 `ZX-20260813-02` 显示：路由错误命中 `QR-WORKBENCH-TODAY`；虽全文检索到 CARE-01a，却没有召回患者列表正式接口、本地/HIS 数据源分支和 ETL 证据边界。

代码与 Spec 能直接确认：

- 页面先调用 PWRS，不是页面直接查 ETL；Web 正式入口为 `POST /pwrsapi/patients/search`，旧入口为 `GET /pwrsapi/patients`，关注列表有独立 POST/GET，Pad 另有入口。
- 调用链为 `PatientController → PatientService`；“查自己”读本地 `pwrs_patient`，“查医院/HIS”调用 `dubboProxyService.listProxyPatients`。
- 有 `V_IPT_PATIENT` 患者视图字段证据，但 PWRS 仓没有 Proxy 源码，不能确认 `listProxyPatients` 最终 ETL `interfaceCode`。未知也不等于否定。

## 通用修复

1. PWRS 功能地图新增 `QR-PATIENT-LIST-SOURCE`，覆盖患者列表页面接口、数据源、Controller/Service/Proxy 调用链和 ETL 局部未知边界；没有把单题答案写进 intake 提示词。
2. CARE-01a 新增“患者视图列表接口、数据源与 ETL 证据边界”，把已知与未知写成可审计事实。
3. 普通/深入咨询提示统一增加两条机制：复合问题逐项取证；未知/未核实事实不得顺着用户的肯定或否定预设下结论。
4. 无证据边界不变：只有部分子问有证据时回答已知部分；完全无证据时仍安全拒答。

## 自动回归

命令：

```bash
PWRS_REAL_MAP=/tmp/pwrs-spec99.1zY3d9/docs/specs/00-功能模块地图.json \
node --test tools/pd-04-route.logic.test.mjs \
  tools/pd-02-prompts.logic.test.mjs \
  tools/spec-retrieval-two-stage.logic.test.mjs \
  tools/fs-06-evidence-gate.logic.test.mjs
```

结果：**64/64 PASS，0 FAIL，0 SKIP**。其中真实地图覆盖原句与自然变体、肯定式/否定式/开放式未知问法；同时回归 DQ-003、检验 ETL、完全无证据按钮问法不被专用路由抢走。

## 生产 Grok 4.5 API 与真库证据

- 九个单轮自然问法：**9/9 PASS**，记录 `ZX-20260813-14`～`ZX-20260813-22`。
- 九题持久记录均为 `version=2.7.260813-16`，`routing.enabled=true`、`tier=1`、`routeId=QR-PATIENT-LIST-SOURCE`；原句路由分 `54.623`，Spec 正文首段包含 CARE-01a §10。
- 原句回答先给口语结论“患者列表先调 PWRS 自己的接口，不会直接去查 ETL”，再分页面入口、数据来源、ETL 边界；没有把所有技术事实倾倒成无层次清单。
- 原 tag15 矛盾问法会回答“不是，当前资料无法确认”；tag16 同问 `ZX-20260813-20` 改为“目前能确认到……；但最终是不是 V_IPT_PATIENT，现有资料无法确认”，人工通过。
- 同一会话三轮：**3/3 PASS**，`ZX-20260813-23` 的 `chat` 共 6 条消息，三轮均沿用同一 convId；“那关注患者呢”与“所以 ETL 到底查哪个”均保持已知/未知边界。
- 新对话无证据按钮题：**1/1 PASS**，`ZX-20260813-24` 仅要求补充页面、按钮原文和报错，没有猜固定重试入口，也没有泄漏上一会话实体。
- 真库核对：上述记录均从生产 MySQL `intakes.data.chat[].retrieval` 回读；没有新增或修改库结构。

完整原答、逐题路由与人工结论见 `docs/reviews/evidence/PWRS-SPEC-GROK-4.5-TAG16-PATIENT-LIST-20260813.json`。

## 提交、部署与回滚

- intake：`64bdd6f`（复合问题局部作答）、`ce5fc23`（未知不等于否定），已推 `main`。
- PWRS：`7c16df96`（患者列表数据源/ETL 路由）、`c7d790e0`（未知不得写成否定），tag `2.7.260813-16` 已推。
- 生产 `/opt/intake/prompts.mjs` SHA-256 与本地一致：`b09d76373d19790bf2a773f0f1d4a87a95e3b7801892efa62fb01bbb3768cbd6`。
- 外部生效配置 `data/prompts.json` 已同步，核验 `partialEvidence/compositeEvidence/unknownIsNotDenial/requiredPlaceholder=true`；未写入或输出任何密钥。
- 生产重启后健康检查：`{"ok":true,"projects":3,"intakes":538,"kb":7}`；容器启动时间 `2026-08-13T02:49:13.575664678Z`。
- 回滚备份：`/opt/intake-backups/patient-list-evidence-tag16/`。

## 待人工验收

- 主流程需继续在浏览器实际执行：新对话输入原句、同会话两次追问、新对话隔离和无证据题，并核对页面展示的版本为 tag16。
- 本次没有需要业务裁决的 `NEEDS-HUMAN`；最终 ETL `interfaceCode` 本身仍是证据未知项，不得臆造，也不得写死为“不是 V_IPT_PATIENT”。
