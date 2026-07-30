<!-- steward:agents --> <!-- 本文件由 Steward「同步方法论」托管刷新;删掉这行标记它就不再被覆盖(视为你自定义) -->
# AGENTS.md — Codex 编排入口（Steward 受管项目）

> Codex 默认读本文件作为项目指令。**你 = 本项目的「编排器 Orchestrator」。**
> 本项目完整编排方法论在 **`CLAUDE.md`**——请**先完整读它**并据此工作（Codex 不自动读 CLAUDE.md，靠本文件把你引过去）。

## 斜杠命令（与 Claude 版同源，别另起一套）
本项目的命令定义在 **`.claude/commands/*.md`**（每个文件就是该命令的完整说明书）。
**当用户输入 `/<name>`（如 `/scan`、`/build`、`/spec`、`/intake`、`/fix`、`/accept`、`/todo`、`/tasks`、`/init`、`/lesson`）时：**
1. 打开并读取 `.claude/commands/<name>.md`；
2. 严格按其中的流程 / 规则执行（把 `$ARGUMENTS` 当成用户跟在命令后面的内容）；
3. 全程遵守 `CLAUDE.md` 的护栏。

> Codex 里 `/<name>` 不是 CLI 内置命令，而是**你要识别的约定**：见到就去读对应命令文件再干，别当普通文字忽略。可用命令以 `.claude/commands/` 里实际存在的 `*.md` 为准。

## 硬护栏（详见 CLAUDE.md）
- **唯一事实源 = `docs/specs/*`**；无 spec 不臆造。存量项目先 `/scan` 抽 spec 基线，人评审 draft→ready 后作数。
- 写实体 / Mapper / SQL 前**先对照真实库结构逐字段核对**；找不到对应表/列 → 标 `NEEDS-HUMAN` 停下问人，**绝不假设列名/表名**。
- 复用现有表、不擅改库；命名/分层/接口按 `CLAUDE.md` 的「①本项目信息」。
- spec 同步纪律（§4.5）、多需求拆解+影响面（§4.6）、开工前读 `docs/lessons.md`（§4.7）——都在 `CLAUDE.md` 里，按它做。
