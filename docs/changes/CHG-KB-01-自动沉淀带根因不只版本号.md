# CHG · KB-01/TK-01 · 工单自动沉淀经验库：解法带根因，不再只留版本号

> 日期：2026-07-30　类型：bug 修复（自动沉淀内容过薄）　来源：用户反馈
> 代码：server.mjs intakeSolution()

## 现象
BUG 工单经批次发包（batch-release）关单后自动沉淀经验库，「解法」只有「修复版本：X」一个版本号——因为发包只写 `resolution.fixedVersion`、无 `note`，而 `intakeSolution` 一命中 fixedVersion 就短路返回，**吞掉了工单已有的 AI 初判根因**（analysis.detail），对后来搜经验库的人价值低。

## 修复（intakeSolution）
不再"见 fixedVersion 即短路"，改为**根因/处理说明 + 修复版本一起拼**：
- 根因取值优先级：`resolution.note` → 最后一条 dev 回复 → `opinion` → `analysis.detail`（AI 初判根因）；
- 再附「修复版本：X」（若有）；
- 只有版本无根因时退回仅版本（不劣化）。

## 影响
仅影响**此后**新沉淀的经验；已存条目不变（可在「编辑经验」抽屉手动补，或删后重沉）。后端改动，需重启。

## 部署 / 验证
rsync server.mjs + `docker restart intake-app`；服务器确认新逻辑在，health 200。
