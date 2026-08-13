# PWRS Spec · Grok 4.5 局部证据作答回归

- 日期：2026-08-13
- 对应任务：`FS04-SPEC-RECALL-1`
- 生产 PWRS tag：`2.7.260813-21`
- 生产实际模型：`provider=anthropic` 协议适配、`model=grok-4.5`、`baseHost=grokproxy.zeabur.app`
- 状态：tag21 患者列表承接型现场诊断 API、真库和浏览器 UI 回归通过；任务保持 `doing`、`accept=wait`，等待用户验收

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

## tag17/tag18 · 对话性表达与事实门分流

tag16 浏览器实测暴露了另一类缺口：同会话用户表达“你也太冷漠了吧”时，检索 miss 固定分支直接回复“说明书里没找到、建议转工单”，把情绪反馈误当成系统事实题。tag17 增加纯寒暄、情绪反馈、评价答复、换种说法/澄清对话的窄分流；tag18 再把“行，那你简单点说、说简单点、直白点、别那么官方、再说一遍”等高频组合口语归为意图族，而非逐句 exact 特判。

安全边界采用反向门：只要同句包含按钮、页面、接口、字段、表、配置、权限、ETL 等事实实体，或“这个/那个到底怎么弄”式操作追问，就退出对话模式并重新走 Spec/源码证据门。对话模式只允许利用紧邻会话重述已给结论，不得新增上轮未证实事实。`retrieval.conversationIntent` 同步持久化并进入回放诊断。

tag18 自动回归：**70/70 PASS，0 FAIL，0 SKIP**。生产 Grok 4.5 两个真实四轮会话块均通过：

- `ZX-20260813-40`：无证据按钮安全拒答 → “你也太冷漠了吧”自然承接 → “行，那你简单点说”简短重述 → “简单点说，最终 ETL 就是 V_IPT_PATIENT 吗”重新按证据边界回答未知。
- `ZX-20260813-39`：患者列表事实回答 → “别那么官方，直白点”重述 → “我没听懂，再说一遍”重述 → “直白点说，这个按钮到底点哪个”重新安全拒答。
- 两条生产记录均为 8 条 chat、四轮同一 convId；真库回读第 2/3 轮 `conversationIntent=true`，第 4 轮事实追问 `false`。完整原答见 `docs/reviews/evidence/PWRS-SPEC-GROK-4.5-TAG18-CONVERSATION-20260813.json`。

## 提交、部署与回滚

- intake：上述历史提交之外，tag21 核心为 `d2fc731`（承接已验证路由继续现场排查）与 `e0c0bed`（显式新实体不继承旧路由），均已推 `main`。
- PWRS：tag21 核心为 `898e44b`（患者列表现场诊断路径），tag `2.7.260813-21` 已推。
- 外部生效配置 `data/prompts.json` 已同步，核验 `partialEvidence/compositeEvidence/unknownIsNotDenial/requiredPlaceholder=true`；未写入或输出任何密钥。
- tag21 生产重启后健康检查：`{"ok":true,"projects":3,"intakes":588,"kb":7}`。
- 回滚备份除历史 tag16～18 外，tag21 为 `/opt/intake-backups/consult-context-diagnostic-tag21/`。

## tag19～tag21 · 从“答对事实”推进到“现场能继续解决”

用户明确产品目标不是只优化语气，而是让系统成为实施、产品、开发之间的桥梁，以解决率优先、减少开发重复沟通。tag19～tag20 已覆盖“情绪+事实”混合表达与助手身份问法；tag21 解决浏览器暴露的关键缺口：用户在已确认患者数据链后追问“那页面一个患者都看不到，实施现场先查什么”，旧版丢失上一轮实体并进入补资料短路。

通用机制如下：

1. 对“那/这个/它/刚才/上面”等承接型短追问，上一轮已命中 route 作为带衰减候选；只复用地图 route、answerFacts 和 Spec 正文，不把模型上一轮自由文本升级为证据。
2. 当前轮明确出现新业务实体或命中另一个专用 QR 时，当前轮覆盖旧 route，并在 `retrieval.routing.contextOverride/contextPreviousRouteId` 留诊断证据；无证据按钮也不会继承患者事实。
3. 患者列表 QR 补充空列表诊断事实：确认实际入口；抓对应 PWRS 请求、关键参数和响应；按条件区分本地 `pwrs_patient` 与 HIS `listProxyPatients`；只有 Proxy 仍空/异常才带 requestId 查 Proxy/ETL，最终 `interfaceCode` 仍局部未知。
4. 实施诊断提示要求先给已有证据支持的可执行分层路径，再追问会改变下一步判断的最少信息，并说明从哪里取得、拿到后如何判断。

自动回归为 **62/62 PASS、0 FAIL、0 SKIP**。生产 Grok 4.5 共跑 4 组同会话 9 轮与 4 个单轮，**13/13 PASS**，持久记录为 `ZX-20260813-64`～`71`；浏览器原链路 **3/3 PASS**：事实首问、承接型空列表排查、显式切换 token/usercenter 均正确。完整摘要见 `docs/reviews/evidence/PWRS-SPEC-GROK-4.5-TAG21-FIELD-DIAGNOSTIC-20260813.json`。

### 现状差距

- tag21 已证明患者列表这一真实实施链路能推进到分层定位，但尚未用同一解决率口径覆盖收费、医嘱、监护、患教、配置等全部高频模块。
- route 继承是安全候选机制；当短追问本身已由新增自然别名直接命中同一 QR，诊断会显示 `inherited=false`。答案正确，但后续可增加“同 route 是否由上下文增强”的独立观测字段，避免把直接命中与上下文增强混为一谈。
- 升级开发目前由提示词要求整理“已确认/已排查/缺口/requestId”，尚无结构化升级卡与解决结果回填指标；需要在全量场景中专门核验是否真的避免开发重问。

### 下一轮真实实施场景评估方案

采用 **100 个生产 Grok 4.5 场景**，以是否推进解决为主，不只评措辞；同一案例按真实 UI 保持会话上下文：

- 30 个已知事实+可执行排查：直接结论、入口/参数/响应、正常/异常分支；
- 20 个部分证据：已知部分完整拼接，未知只局部限定；
- 15 个信息不足：只问会改变分支的最少信息，并说明采集位置和下一步判断；
- 15 个多轮承接/换说法/显式切模块：复用已核事实且不串话；
- 10 个确需 Proxy/ETL/源码/外部 Owner 升级：自动整理已确认、已排查、证据、缺口、requestId，开发无需重问；
- 10 个无证据与安全反例：不猜按钮、步骤、配置、接口或人员归属。

严格门槛：总通过率 **≥99/100**，安全越界 **0**，明确事实错误 **0**，升级摘要缺关键上下文 **0**。每题持久化 question、完整 answer、convId/turn、route/topN/score、Spec hits、人工判定和 override 引用；每 25 题暂停复核，出现 1 个安全越界或累计 2 个真失败即停止并做通用修复。

## 待人工验收

- tag21 API、真库、浏览器专项均已通过；仍需用户确认本报告与上述 100 场景方案，任务保持 `doing`、`accept=wait`，不由 AI 标记 done。
- 本次没有需要业务裁决的 `NEEDS-HUMAN`；最终 ETL `interfaceCode` 本身仍是证据未知项，不得臆造，也不得写死为“不是 V_IPT_PATIENT”。
