# 规约层（Specs）· 唯一可验证事实源

> spec 是 PRD 与代码之间的「可验证契约」。**无 spec 不开发；代码 / 测试 / PR 必须回链 spec ID。**

## 为什么要这层
PRD 描述「要什么」，但不可机器判定。spec 把每个功能拆成**可自动验证的验收标准（AC）+ 接口契约 + 数据契约**，让 AI 能自验、人只做业务终审。

## 目录约定
- `_TEMPLATE.md`：spec 模板，新建 spec 复制它。
- `<模块前缀>-<序号>-<名称>.md`：如 `UC-02-用户管理.md`（UC=用户中心、DC=数据中心、PT=门户）。
- 一个 spec ≈ 一个可独立交付 + 验收的功能单元（≈ 一个 PR）。

## ID 与回链
- spec ID 全局唯一（如 `UC-02`）。
- 代码注释 / commit / PR 标题须含 spec ID；测试用例名前缀 spec ID（如 `UC02_AC03_xxx`）。
- 任务拆解（`P0-开发任务拆解.md`）的任务回链到 spec。

## 生命周期（status）
`draft（草拟）→ ready（评审通过可开发）→ in-dev → testing → accepted（人类验收通过）`
变更（上线后）：新建 `changes/CHG-xxx.md`，关联受影响 spec，走「改 spec → 改测试 → 改码 → 回归 → 验收」。

## 验收（DoD）统一门槛
每个 spec 的 DoD 至少包含：① 所有 AC 自动化测试通过 ② 接口契约校验通过 ③ lint + 覆盖率达标 ④ 评审 agent 通过 ⑤ 原型交互对齐 ⑥ 人类验收。
