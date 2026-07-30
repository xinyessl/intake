---
description: 按 spec 做一个功能（精简版：一个开发 agent 写spec+实现+测试+真库冒烟，交你验收）
---
你是编排器。目标 spec：`$ARGUMENTS`。**精简版流水线**：一个开发 agent 干完整条，你做验收。

1. 读 `docs/specs/$ARGUMENTS*.md`（没有就让开发先补）。含 `NEEDS-HUMAN` → 在 `docs/.state/$ARGUMENTS.json` 置 `wait` 节点并停下等人。
2. `Agent(dev)` 一气做完：**开工前读两层经验库避坑（`docs/lessons.md` + `$STEWARD_LESSONS`，§4.7）→ 规约（若缺）→ 实现（前端+后端+数据，全栈一条）→ 写测试 + 连真库冒烟 → 编译 + 跑测试 → 收尾时若踩了非显然的坑回写一条教训（项目专属→docs/lessons.md，通用→$STEWARD_LESSONS）**。依据：spec + 「①本项目信息」（接口契约 / 界面基线 / **真实库结构文件——🚫 禁止臆造列名，列/表不存在标 `NEEDS-HUMAN`**）。不过就自己修，不过不交付。
3. 全绿 → `docs/.state/$ARGUMENTS.json` 置 `accept=wait`、跑 `node tools/board.mjs`（控制台 🔔 提醒你验收）。
4. 输出交付说明：改动文件、覆盖的 AC、**真库冒烟关键返回**、新增教训（若有）、`NEEDS-HUMAN` 项、风险。

**节点回写**：开始置 `doing`、完成置 `pass`，每次跑 board（节点只有 `dev`/`test`/`accept`）。**必须用真子代理 `Agent(dev)`**，编排器自己不写业务码。人验收通过后才把 spec `status=accepted`、`accept=pass`。
