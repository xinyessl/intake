---
id: UI-02
title: "[已撤回] 全站 React 统一迁移"
module: 前端基建
type: feature
source: 人工（2026-08-10 提出；同日明确撤回）
priority: Must
status: draft
withdrawn: true
owner_human: <验收人>
depends_on: []
---

# ⚠️ 已撤回，不作为当前系统事实

2026-08-10 用户明确要求撤回全站 React 18 + Vite 5 + Ant Design 5 迁移，并要求现有样式不要改动。本 spec 仅保留为决策历史，**不得用于指导当前页面实现、构建、部署或回答现状问题**。

## 当前有效事实

- 13 个正式 URL 继续由原 `public/*.html` 提供，沿用既有原生页面与样式。
- `server.mjs` 不再映射 `public/react/intake/`，不再使用 `INTAKE_UI_LEGACY` 切换实现源。
- 全站 React 工作区、preview、正式构建和专用设计系统已从本地代码撤回。
- UI02 迁移批次已从 `docs/tasks.json` 移除，9 个任务均未验收、未标 `done`。

## 明确保留的既有能力

本次撤回只针对“全站 React/AntD 统一迁移”，以下此前功能不撤回：

- AI 回答可读性、真实经验引用、Markdown 表格与分隔线。
- 实施端刷新恢复、停止发送与已有业务修复。
- `frontend/field-overview` 与 `public/assets/field-overview/` 的渐进式全览组件及 legacy 回退。
- 既有 URL、接口、Session、双域名和权限规则。

## 生产撤回证据

- 使用备份 `/opt/intake-backups/intake-before-react-cutover-20260810-160515.tar.gz` 恢复 legacy。
- 生产已验证 `/field.html`、`/login.html` 返回 legacy 页面。
- 本次本地撤回不再操作生产环境。

## 历史材料

- `docs/changes/CHG-UI02-全站React预览迁移.md`
- `docs/reviews/UI-02-切换前验收-20260810.md`
- `docs/reviews/UI-02-线上部署与回滚清单-20260810.md`

以上材料均为已撤回方案的历史证据，不代表当前实现。
