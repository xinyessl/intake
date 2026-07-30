# 实施端（现场提交端）· Spec 清单（功能粒度 · 待评审）

> 由 `docs/实施端PRD.md`（收件平台·实施端 PRD v1.0）+ 原型 `Desktop/Prototype/intake/redesign.html`（① 实施端）拆出。
> **一功能一 spec**（页面对齐原型、逻辑复用真实 `server.mjs`、数据契约对齐真实库 `db.mjs`/`data/*.json`）。全部 `status: draft`，待评审 `draft→ready` 后按 `depends_on` + 分期开 `/build`。
> 复用度：♻️大半现有(接真接口+对齐样式) / 🔧小扩展 / 🆕从 0 新增
> 前缀 `FS`（Field-Side / 现场实施端），区别于运营后台的 UI/WB/TK/BP/PD/CU/KB/MC/AM。

## 0. 拆分依据 + 与运营端的关系
实施端是 PRD 里独立的**另一端**（现场实施工程师用），运营后台 9 个 spec（`00-运营后台-spec清单.md`）是 P3 注记的"另立 spec 树"。实施端**只提交与查看**，不做决策/开发：
```
实施端(FS-*)                            运营端(既有 spec)
AI 对话提交 需求/BUG/咨询  ──intake-submit/consult──▶  工单管理 TK-01 → 批次 BP-01
看批次进度 / 下载更新包    ◀──batches/download────────  批次「可下载」BP-01(P2)
回写现场版本号            ──customer-version────────▶  客户台账 CU-01
```

## 1. ⚠️ 拆分前必须先拍板的 3 条跨条决策（影响所有 FS spec）

> 这 3 条是**评审第一关**，定了才好把各 spec 从 draft 推 ready。前 2 条我已按「①本项目信息」给出**强默认**（非臆造，有据），第 3 条是真·NEEDS-HUMAN。

**决策 A｜技术栈：Node 原生栈，不是 PRD 写的 Vue3+Java（强默认，建议直接采纳）**
- PRD §2/§9 写「Vue3+TS+ElementPlus / Java17+SpringBoot」——但**那是被本平台跟踪的产品的栈，不是本平台的栈**（见 CLAUDE.md ①本项目信息）。本平台 = **Node 零依赖原生 http（`server.mjs` 单文件）+ 原生 HTML/JS 前端（`public/*.html` + `assets/`）+ MySQL**。运营后台 9 个 spec 已全部落在 Node 栈上。
- **落地建议**：实施端新增 `public/field.html`（工作空间外壳 SPA，登录门+医院/系统视图+对话）复用 `assets/theme.css` 等；后端在 `server.mjs` 加 `field` 相关端点。**不引入 Vue/Element/Java**。除非评审推翻，各 FS spec 均按此落地。

**决策 B｜`field` 角色 = 真实库 `impl`（强默认）+ 一个要害安全缺口**
- PRD 通篇用 `role='field'`。真实库 `accounts.role ∈ {admin,pm,impl}`（`dev`→admin、`field`→impl 为兼容旧值，`normRole` 已归一）。故实施端使用者 = **`impl`（+ `pm`）**。
- 🔴 **要害缺口**：`server.mjs` 的 `scopedForField(user, items)` **只在 `user.role==='field'` 时按 sites 过滤**；账号 role 已归一为 `impl` 后，此判断永不命中 → **现场账号的 sites 数据隔离形同虚设**（PRD §3.3/§7 的硬约束落空）。→ 归入 **FS-01** 作为必修回归 AC。

**决策 C｜批次/发包/版本回写依赖运营端 BP-01（P2，尚未建）——真 NEEDS-HUMAN 分期**
- 实施端的「按批次分组」「更新包下载」「一键改版本」「待下载/待改版本待办」全部依赖 `batches` 表 + steward 发包接口 + 版本回写端点——**这些运营端 BP-01 也还没建（P2，卡 steward 契约）**。
- **分期建议**：实施端拆 **P1（不等批次，可先做）** 与 **P2（等 BP-01）** 两批（见 §3）。请评审确认此分期，以及"实施端与运营端 BP-01 谁先谁后 / 并行"。

**决策 D｜两域名部署：共用后端+库，只在 web 层拆（✅ 2026-07-21 已裁决）**
- 上线后 **admin（运营后台）与 field（实施端）各用一个完全独立的域名**；但**共用同一 `server.mjs` + 同一 MySQL**——现场工单同库直连进运营工单箱，**不做跨库/跨服务同步**。
- 拆分只在 **web/域名层**：两个 nginx vhost，各自 `/api/*` **反代到同一后端**（浏览器同源、免 CORS）；两域名独立、cookie（`intake_sess`）按域名天然隔离 → 各域名各自登录会话。
- **域名层 deny-by-default**：field 域只暴露 `field.html`/`submit.html`/`assets` + `FIELD_OK`/`LINK_OK` 接口；admin 域只暴露后台页 + admin 接口。`server.mjs` 增**按 `Host` 的访问闸 + 根路由**（field 域 `/`→`field.html`、admin 域 `/`→`console.html`，取代现 `server.mjs:1099` 的按 role 分发）。
- **免登录链接**：`submit-link` 需返回 **field 域绝对地址**（两域名独立，相对路径 `/submit.html?token=` 打不通）——运营端生成链接时须知 field 域名（配置项 `FIELD_ORIGIN`）。
- → 新增 **FS-08 双域名部署与访问隔离** 承接；牵动 FS-01（Host 路由/域名闸/同源会话）、FS-06（链接绝对地址）、`docs/运维部署.md`（两 vhost + 证书 + 反代 + 路径白名单）。

## 2. 已生成 spec（8 条 · 功能粒度 · 159 AC（141 + FS-08 18）· 全部 status:draft 待评审）

| ID | 标题 | 原型/PRD | AC | 优先级 | depends_on | 复用 | 分期 | 备注 |
|---|---|---|---|---|---|---|---|---|
| **FS-01** | 实施端外壳 · 登录门 · 工作空间隔离 · 维度切换 | §3 + §7 | 20 | Must | []（复用 theme.css） | 🔧 | P1 | 登录门遮罩 / 按账号隔离(sites) / 医院·系统维度下拉 / **清理 scopedForField 死码** |
| **FS-08** | 双域名部署 · 访问隔离（决策 D） | §2 + §7 | 18 | Must | FS-01 | 🆕 | P1 | 两独立域名共用后端+库；nginx 双 vhost 同源反代 / server.mjs 按 Host 访问闸 + 根路由 / submit-link 绝对地址 / 运维文档两 vhost |
| **FS-02** | 医院视图 · 提交清单（按批次/按类型 + 子项目筛选） | §4.1 | 20 | Must | FS-01, BP-01 | 🆕前端+🔧 | P1类型16 / P2批次4 | 平铺医院 tab / 按类型跨批次重组 / 「按批次」分组待 BP-01 |
| **FS-03** | 系统视图 · 跨医院聚合 · 归档版本模型 | §4.2 + §4.6 | 21 | Should | FS-01, FS-02 | 🆕 | P1 | 平铺系统 tab / 跨我全部医院 / 运营 tag 版本(git tag) vs 现场版本 两类 |
| **FS-04** | AI 对话提交（判类/补要素/归档 → 建工单/咨询） | §4.3 | 24 | Must | FS-01 | 🔧 | P1 | 复用 intake-chat(合并模式建单) / consult(SSE) / intake-analyze；归档上下文 chip 版本感知 |
| **FS-05** | 更新包下载 · 版本回写 · 待办闭环 | §4.4 + §4.5 | 23 | Must | FS-02, BP-01, CU-01 | 🆕 | **P2 全条** | 更新包卡 / 一键改版本(新端点) / 待下载·待改版本·待验证待办 |
| **FS-06** | 免登录提交链接（访客模式） | §4.7 | 25 | Should | FS-04 | ♻️ | P1 | 复用 submit-link(HMAC) + submit.html；干净提交页对齐 AI 对话提交 |
| **FS-07** | 经验库入口（现场检索） | §4.8 | 8 | Could | FS-01, KB-01 | 🔧 | P1 | 顶栏经验库入口；需补 field 可用的 kb-search + 把 kb-list 加进 FIELD_OK |

> 说明：实施端原型 `redesign.html` 实为**单页 SPA**（登录门 + 医院/系统双视图 + 右侧对话 + 待办 popover），不像运营后台是多页——故按**功能粒度**拆（对齐 PRD §4 各节），而非页面粒度。原子级细分（如版本下拉、待办计算）作为各 spec 内小节保留。

### 2.1 ⚠️ 撰写时开发 agent 逐字核真库发现的「PRD/原型 ↔ 真实端点」偏差（落地前须知，避免臆造）
| PRD/原型写法 | 真实实现 | 处置 |
|---|---|---|
| `POST /api/ai/classify`（AI 预分类原始文本）〔FS-04〕 | **不存在**。`/api/intake-chat`(合并模式)做 AI 判类+补要素+自动建单；`/api/intake-analyze` 是对**已建工单**(需 id)的版本感知初判 | FS-04 §4 按真实链路写 |
| `GET /api/product-versions?product=`〔FS-03/PRD §6〕 | 真实是 `GET /api/versions?project=<id>`（git tag 并集，最新在前，上限 200） | FS-03 §4 用真实参数名 |
| `GET /api/s/{token}` 免登录页上下文〔FS-06/PRD §6〕 | **不存在**。真实=`POST /api/submit-link` 生成 + `linkUserFrom` 逐请求验签(query/cookie) + `/api/me` 取访客态 + `LINK_OK` 闸 | FS-06 §4 按真实链路写 |
| `/api/kb-list` 现场可检索〔FS-07〕 | **不在 `FIELD_OK` 白名单**，现场账号调会 403；且**无对外 kb-search 端点**(kbSearch 仅嵌 consult) | FS-07 落地须 🔧 加白名单 + 新增/扩检索端点 |
| `intake-submit`/`intake-chat` 强制 `site∈sites`〔FS-04〕 | 登录现场账号提交**未强制** site 属于其 sites（仅 link 有预置 site） | FS-04/FS-01 落地补一处服务端收敛(AC-21) |
| 更新包大小「12.4 MB」〔FS-05 原型 f-dlbar〕 | BP-01 `batches` 无 size 列（且表未建） | FS-05 标 NEEDS-HUMAN，随 BP-01 定 |
| `scopedForField` 按 sites 过滤〔FS-01/决策 B〕 | 是**死码**（判 `role==='field'`，归一后永不命中）；真实隔离靠 `intake-list/detail/notifications` 内联 `!isAdmin&&sites` 兜住 impl | FS-01 清死码 + 坐实"新 field 端点走内联收敛、忽略越权传参" |

## 3. 分期（据决策 C）

- **P1（先干，不依赖 BP-01 批次/steward）**：FS-01 · FS-03 · FS-04 · FS-06 · FS-07，以及 FS-02 的「平铺医院 tab + 按类型视图 + 子项目筛选 + 清单基础（基于 `intakes`）」。这些只靠现有 `intakes`/`accounts`/`projects`/`submit-link`/`consult`/`versions`。
- **P2（等运营端 BP-01 批次表 + steward 发包 + 版本回写端点）**：FS-02 的「按批次分组视图」、FS-05 全部（下载/改版本/待办闭环）。
- 建议：P1 与运营端 P1 并行；实施端 P2 待 BP-01 ready 后接续。

## 4. 逐条数据契约锚点（对齐真实库 · 禁止臆造，见各 spec §5）

> PRD §5/§6 用 `intake_*` 概念表名（Java 视角）。**真实落地映射如下**（源自 `db.mjs` + `server.mjs` + `data/*.json` 实测）：

| PRD 概念 | 真实实现 | 备注 |
|---|---|---|
| `intake_ticket` | `intakes` 表 + `data` JSON | 提交走 `intake-submit`；site/subsystem/version/type/lifecycle 是库列 |
| `intake_account`(role=field) | `accounts` 表，role=`impl` | sites JSON=负责医院；`field`→`impl` 兼容归一 |
| `intake_account_hospital` | `accounts.sites` JSON | 即工作空间边界；**过滤逻辑有缺口(决策B)** |
| `intake_customer`/`_product` + 现场版本 | `data/customers.json`（文件存，未迁库） | `products:[{project,version}]`；含 level/region/impl/status |
| `intake_batch` + pkg_version | **未实现**（BP-01 P2 建 `batches` 表） | 现仅工单 `data.batch` 弱字段 |
| `intake_product`/`intake_subsystem` | `projects` 表 + `subsystems` JSON | 无独立 subsystem 表、无 SUB_PRODUCT 映射表 |
| 运营维护 tag 版本 | `/api/versions`（git tag，跨子系统仓合并） | 最新在前 |
| `intake_submit_link` | HMAC token 自验签 + `data/link-secret` | 无库存储；token={project,site,ver,type,exp} |
| `intake_download_log` | **未实现**（建议随 BP-01 落 `batches.downloads` 或新表） | — |
| AI 分类/初判 | `/api/intake-analyze`（非 PRD 写的 `/api/ai/classify`） | 返回 {category/verdict/suggestion/detail} |
| 咨询 | `/api/consult`（SSE 流式，type='consult' 工单） | 含经验库+spec 检索 |
| 经验库检索 | `/api/kb-list` + 嵌在 consult 的 `kbSearch` | 无 field 专用 kb-search 端点(FS-07 补) |
| 待办 | `/api/notifications`（现场=已回复/待验证） | 无「待下载/待改版本」细分(FS-05 补) |

> 各 FS spec §4 接口契约 / §5 数据契约必须引用本表，找不到对应真实表/列/端点的一律标 `NEEDS-HUMAN`，不假设。

## 4.6 NEEDS-HUMAN 汇总（评审时逐条拍板 · 除 §1 三决策外）

> 各 FS spec 内的 NEEDS-HUMAN 汇总于此。评审 draft→ready 时逐条裁决；未裁决项不阻塞评审，但影响对应 spec 能否 `/build`。

| # | 事项 | 涉及 spec | 建议默认 |
|---|---|---|---|
| NH-a | 演示账号 zhanggong/ligong/zhaogong 是否已在真库 `accounts` 建好并各绑不同 `sites`（否则冒烟要造号） | FS-01 | 造测试账号，冒烟后清理 |
| NH-b | 品牌区/机构文案来源（`/api/me` 无机构字段，禁臆造 `me.org`） | FS-01 | 固定占位文案 |
| NH-c | 现场鉴权 Session vs JWT（PRD §11.1） | FS-01 | 复用现有 Session Cookie |
| NH-d | 工作空间默认加载范围（全部负责医院 vs 当前医院）+ 分页策略（PRD §11.7） | FS-01/FS-02 | 当前医院懒加载 |
| NH-e | `pm` 角色是否与 `impl` 一样受 sites 约束 | FS-01 | 设了 sites 即受约束 |
| NH-f | 子项目「该医院已上产品」精确关系无独立表（现用"有 intakes 记录的产品"近似） | FS-02 | 近似即可，待 CU-01 精化 |
| NH-g | SUB_PRODUCT（子系统→产品）映射来源：无独立表 | FS-03 | 由 projects.subsystems 反查 |
| NH-h | 系统 tab 取"我负责医院已上产品"子系统 vs "全部产品"子系统（PRD §11.5） | FS-03 | 已上产品 |
| NH-i | AI 分类由后端统一调模型 vs 前端直连（PRD §11.2，Key 安全） | FS-04 | 后端统一 |
| NH-j | 咨询是否允许现场"转需求"（consult→建 requirement）（PRD §11.6） | FS-04 | 仅续问，不转需求 |
| NH-k | `intake-analyze` 是否放开给现场（现不在 FIELD_OK，调则 403） | FS-04 | 不放开，初判由运营端触发 |
| NH-l | 版本回写是否强制 + 校验规则（PRD §4.5/§11.3，待运营端 §17） | FS-05 | 非强制但强提醒 |
| NH-m | 下载端点命名/产物形式（本 spec `/api/batches/{id}/download` vs BP-01 `/api/batch-download`；URL vs 上传）+ 更新包 size 字段 | FS-05 | 对齐 BP-01 契约后定 |
| NH-n | 待办端点选型：新增 `/api/field/todos` vs 扩 `/api/notifications` | FS-05 | 扩 notifications |
| NH-o | 免登录链接权限边界：可提交类型 / 是否限单医院 / 有效期默认（PRD §11.4）；无 token 库→无法单条吊销（只能 exp 或换密钥整体失效） | FS-06 | 有效期默认 365、限 token 预置 site |
| NH-p | 经验库检索范围（我负责产品单产品 vs 全库）+ 检索端点方案（新 kb-search vs 扩 kb-list）+ 必须把检索端点加进 FIELD_OK | FS-07 | 当前工作空间单产品 + 新 kb-search |
| NH-q | 两域名实际值（`FIELD_ORIGIN`/`ADMIN_ORIGIN` 配置）+ 证书/HTTPS（线上现 HTTP，HTTPS 待办） | FS-08 | 配置项，上线前定 |
| NH-r | 未匹配 Host（直连 IP/未知域名）的兜底：拒 / 落 admin / 落 login | FS-08 | 拒（deny-by-default） |
| NH-* | 各 spec `owner_human` 验收人待指派 | 全部 | 人工填 |

## 5. 评审 / 开工顺序建议
1. **先拍 §1 三条决策**（A 技术栈 Node、B 角色 impl + 修隔离缺口、C 分期/BP-01 依赖）——它们决定所有 FS spec 的落地形态与排期。
2. **FS-01 先 ready 先建**（其它 FS 都 depends_on 它，含隔离缺口修复）。
3. P1 其余（FS-03/04/06/07 + FS-02 非批次部分）确认后并行 `/build`。
4. **FS-02 批次视图 + FS-05 等 BP-01** ready 后接续。
