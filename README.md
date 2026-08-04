# 收件 · intake

**受理现场需求与 BUG 的独立进件平台** —— 面向产品经理 / 现场实施工程师，把现场反馈变成结构化、可被 AI 直接分析的进件，并把「评审 → 发包 → 现场落地」全链路管起来。

> 从 **steward**（多项目研发编排中枢）会话里孵化、拆分出来的独立项目。与 steward 物理隔离，唯一耦合是各产品 git 仓里的 `docs/`（版本=git tag，spec 随 tag 快照）。

## 核心原则（务必先读）
1. **版本 = git tag**：产品版本候选来自各子系统仓的 git tag；spec 留在产品代码仓，随 tag 快照。
2. **intake 独立成库**：收件写自己的 `data/intake-store`，对产品代码仓**只读**（git tag / spec@tag）。
3. **MySQL 为唯一事实源**：启动 `loadAll` 载入内存缓存，读走缓存、写穿透库；工单/经验库同时**双写 `.md/.json` 文件副本**（给开发 git pull / 兜底迁移）。
4. **绝不把密钥入库**：API Key 仅存服务本机 `data/model-api.json`（gitignore），页面仅回显掩码。
5. **公网面必须认证**：`authGate` deny-by-default；双域名按 Host 隔离访问面。

## 技术栈
| 层 | 选型 |
|---|---|
| 后端 | **Node.js 原生 `http`（零框架、单文件 `server.mjs`，~2400 行、~70 个 HTTP 端点）** + `mysql2` |
| 前端 | **原生 HTML/JS**（`public/*.html` + `assets/theme.css`·`ui.js`·`shell.js`·`nav.js`），无构建、无框架 |
| 持久化 | **MySQL**（`projects/accounts/sessions/intakes/kb_entries` 五表，见 `db.mjs` `init()`）+ **文件存**（`data/*.json`） |
| 部署 | Docker `node:20-slim` → `node server.mjs`，前置 nginx 反代；**双域名**（运营 / 实施） |
| AI | OpenAI/Anthropic 兼容对话模型（主/备）+ Embedding 模型（经验库语义检索） |

## 两个访问面（双域名 · 按 Host 隔离，见 `FS-08`）
- **运营后台**（`intake-ops.*`）：管理员 / 产品经理。工作台、工单管理、批次与发包、版本发版登记、医院管理、产品管理、经验库、模型配置、账号管理。
- **实施端**（`intake.*`）：现场实施工程师。认领自己负责的医院（按 `sites`），医院/系统/批次视图看清单、提单、AI 对话、下载更新包、累积更新计划、逐单验证。
- **免登录提交链接**（token）：从被交付产品点「反馈」直达提交页 `submit.html`。

## 主要模块
- **工单进件**（`TK-01`/`FS-04`）：选需求/BUG → 结构化表单（产品版本 git tag + 现场医院）→ AI 沟通补全、给处理意见 → 归档。
- **工单管理**（`TK-01` + 状态机 `SPEC-工单状态机-001`）：评审（立项/暂缓/驳回）、状态流转、`history[]` 留痕。
- **批次与发包**（`BP-01`）：运营定档 → 归入该产品全部「已立项」单（跨院合并、按子系统分组）→ 导开发清单 → 上传更新包（版本/说明/地址）→ 实施下载、一键改版本、逐单确认现场验证 → 闭环。
- **版本发版登记 + 累积更新**（`releases.html` + `BP-01`/`FS-05`）：按 git tag 版本登记 delta（实施任务 + SQL 脚本）；实施更新时按「现场版本 → 目标版本」**跨版本累积**，展示为**一份统一任务清单**，SQL 收成一个点 —— 多版本 SQL **合并成一个 `.sql` 文件下载**。
- **部署清单**（`FS-06`）：标准部署清单模板（运营维护一份），实施端按 **医院 × 系统** 逐条勾选完成。
- **医院管理**（`CU-01`）：台账（等级/区域/负责实施/关联产品·各自版本/维保到期/联系人/服务器信息/设备码/备注）；**维保到期提醒**（≤15 天 / 已过期，实施 + 运营）。
- **产品管理**（`PD-01`）：产品 + 子系统 + 只读 git 仓（版本 tag / spec@tag）。
- **经验库**（`KB-01`）：问答沉淀 + **语义检索**（Embedding 向量 + 关键词混合召回，未配置/失败自动退回关键词）。
- **模型配置**（`MC-01`）：对话模型（主/备、连通测试）+ Embedding 模型（语义检索固定单模型）。
- **账号管理**（`AM-01`）：`admin` / `pm` / `impl` 角色，服务端鉴权。

## 数据模型
- **MySQL**（事实源）：`projects`、`accounts`、`sessions`、`intakes`、`kb_entries`（真实 CREATE TABLE 见 `db.mjs` `init()`）。
- **文件存**（`data/`，gitignore）：
  - `customers.json` 医院台账 · `model-api.json` 模型配置 · `db.json`/`deploy.json`/`git-config.json` 基础配置
  - `batches.json` 批次 · `version-releases.json` 版本发版登记 · `deploy-template.json` 部署清单模板
  - `kb/<product>.json` 经验库双写副本 · `intake-store/<product>/*.{md,json}` 工单双写副本
- ⚠️ 启动 `migrateFromFiles()`：MySQL 某表为空时会从上述文件副本回灌（工单/经验库/账号/项目）。**清库时需连同文件副本一起清**，否则重启回灌。

## 运行
```bash
# 依赖：一个可连的 MySQL；配置 data/db.json（{host,port,user,password,database}）
node server.mjs                 # 默认 :5180；BIND=0.0.0.0 对外
# 双域名：设 data/deploy.json {fieldOrigin, adminOrigin} 或环境变量 FIELD_ORIGIN/ADMIN_ORIGIN
```
生产：代码在 `/opt/intake`（bind-mount 到容器 `/app`）；改后 `docker restart intake-app`；nginx 反代两域名到 `:5180`。运维见 `docs/运维部署.md`。

## 目录
| 路径 | 说明 |
|---|---|
| `server.mjs` | 单文件后端（路由 + 业务 + 鉴权 + AI + 文件/库读写） |
| `db.mjs` | MySQL 连接 + 建表 + `loadAll`/`replace*`（真实表结构事实源） |
| `public/*.html` + `assets/` | 前端页面 + 设计系统（`theme.css`）/外壳（`shell.js`）/组件（`ui.js`） |
| `data/` | 文件存 + 双写副本 + 配置（gitignore） |
| `prototype/` | 结构化高保真原型（`theme.css`+`shell.js`+`admin/*.html`）—— 界面基线参考 |
| `docs/specs/` | 规约 spec（系统事实源，21 份；`README.md`/`_TEMPLATE*`） |
| `docs/架构设计.md`·`docs/运维部署.md` | 架构 / 运维部署 |
| `docs/tasks.json`·`docs/board.md` | 任务清单（批次/task）/ 进度看板 |
| `docs/lessons.md`·`docs/changes/` | 踩坑经验库 / 变更记录 |
| `CLAUDE.md` | AI 研发编排手册（本项目怎么开发） |

## 开发方式（spec-first）
需求/缺陷先改 spec（`docs/specs/*`）→ 改测试 → 改码；一条 task ≈ 一个 PR ≈ 一次验收。日常入口是 `/intake`（进件析 spec + 出任务批次），细分为 `/spec`·`/build`·`/fix`·`/accept`。详见 `CLAUDE.md`。

> 历史背景见 `docs/沟通记录.md`（立项来龙去脉）；早期开工工单见 `开工指引.md`（已完成，仅存档）。
