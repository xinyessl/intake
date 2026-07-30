---
description: 绿地启动——产品刚出 PRD+原型、还没代码时：定技术栈 + 填①本项目信息 + 搭最小工程骨架 + .gitignore（首次 /build 前先跑这个）
---
你是本项目编排器。项目处于**绿地阶段**（只有 PRD + 原型图，还没代码）。本命令把项目从"一堆文档"带到"能开发的工程骨架"，之后再 `/spec` 拆 spec、`/build` 实现。范围/补充说明：「$ARGUMENTS」。

> **绿地铁律：此时 PRD（`docs/PRD.md` 等）+ 原型图（`docs/prototype/`）= 唯一事实源**（还没代码可对照）。一切以它们为准；PRD 没覆盖 / 说不清的标 `NEEDS-HUMAN`，禁止臆造。

## 流程
1. **盘点输入**：读 `docs/PRD.md`（或 docs/ 下的需求文档）+ `docs/prototype/`（HTML/图片原型）。归纳产品要做什么、有哪几个**顶层功能模块**（产品面，几个就好），列给人确认。
2. **定技术栈**（关键关卡 = `NEEDS-HUMAN`）：依 PRD 规模 / 团队 / 部署，给出**推荐技术栈**（前端 + 后端 + 数据库 + 关键中间件）+ 一句话理由，**列给人拍板**。定不下来不往下走。
3. **填 `CLAUDE.md` ①本项目信息**：技术栈（第 2 步定的）；**界面基线 = `docs/prototype/*`**；数据权限/规则来源 = `docs/PRD.md §X`；真实库结构文件 / 接口契约 = 随 spec 产出，暂填「无（待 spec 产出）」。
4. **搭最小工程骨架**：按定好的栈派 `Agent(dev)` 初始化一个**能编译、能跑起来**的空骨架（目录结构 + 依赖 + 启动脚本 + 一条 health/hello 通路 + 最简 lint/CI 配置），**不写业务**。跑起来确认绿。
5. **.gitignore 到位**（同 `/scan` 的提交边界）：`docs/.gitignore` 含 `board.json board.md tasks.json .state/`；`.claude/.gitignore` 含 `settings.local.json plan.md`（没有就建）。原则：**提交源头（`docs/specs/*`、CLAUDE.md、.claude/agents+commands、tools/board.mjs），不提交派生（board/state/tasks/plan/本地设置）**。
6. 跑 `node tools/board.mjs` 入库。

## 产出 + 下一步
- 一句话清单：定下的技术栈、顶层功能模块、骨架是否跑通、所有 `NEEDS-HUMAN`。
- 提示人：骨架就绪 → 跑 **`/spec 按 docs/PRD.md 全量拆模块、对照 docs/prototype 建 spec`** 生成 spec 树（草稿）→ 评审 draft→ready → `/build <id>` 逐条实现。

> `/init` 是 `/scan` 的反方向：`/scan` 从**已有代码**逆向抽 spec；`/init` 从**PRD+原型**正向搭骨架、再正向建 spec。
