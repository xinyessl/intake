---
id: <模块/功能编号，本项目统一前缀，如 MOD-01 / UC-01>
title: <功能名>
module: <子系统 / 应用名>
type: feature              # feature=功能 spec；端到端跨模块流程用「流程 spec」(_TEMPLATE-流程.md，type: process)
source: <来源：/scan 逆向 | 需求文档 §X | 人工>
prd: <需求出处，如 docs/PRD.md §X；无则「无」>
contract: <接口契约出处，如 docs/接口契约.md §X / OpenAPI；无则「无」>
prototype: <界面基线，如 docs/prototype/xx.html；无则「无」>
priority: P0 | Must / Should / Could
status: draft | ready | in-dev | testing | accepted
owner_human: <验收人>
depends_on: [<spec id>...]
---

## 1. 用户故事 / 目标
作为 <角色>，我要 <能力>，以便 <价值>。

## 2. 范围
- 包含：…
- 不包含：…

## 3. 验收标准（AC · Given-When-Then · 每条必须可自动化判定）
- **AC-1** Given <前置> When <操作> Then <可观测结果>
- **AC-2** …
- **AC-N** …

## 4. 接口契约
引用「接口契约」出处，或内联 OpenAPI 片段（路径 / 入参 / 出参 / 错误码）。

## 5. 数据契约
涉及表与字段（**对照本项目真实库结构核对，禁止臆造列名**）：约束、唯一键、状态枚举、留痕表。无库则写「无」。

## 6. 业务规则 / 非功能
权限（按钮级）、数据权限（依本项目规则）、校验、幂等、并发、操作留痕、性能。仅写代码/需求能确证的；说不清的标 `NEEDS-HUMAN`。

## 7. 测试要点（交付给开发 agent）
- 单元：…
- 接口：…（覆盖每条 AC + 异常分支）
- E2E（前端，若有）：…（对照界面基线）

## 8. DoD（完成定义）
- [ ] AC-1..N 自动化测试全通过
- [ ] 接口契约校验通过（若有）
- [ ] lint 通过、覆盖率 ≥ 阈值
- [ ] 连真库冒烟通过（若本项目有真实库）
- [ ] 界面/字段对齐基线（若有）
- [ ] 人类验收通过
