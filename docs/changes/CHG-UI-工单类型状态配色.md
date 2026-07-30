# CHG · UI/TK-01 · 工单类型/状态标签配色调整（BUG 红·需求橙·状态分明）

> 日期：2026-07-30　类型：样式调整（行为不变）　来源：用户反馈（工单管理页截图）
> 关联：theme.css 设计系统 + inbox.html（工单管理）

## 需求
工单管理列表：**BUG 红色、需求橙色**（原需求是蓝，与 BUG/咨询三色不够分明）；**状态标签配色也调整**（`已立项` 用的 `tag-primary`=深藏青 `#0F2744` 渲染发灰，看不清）。

## 改动
- `public/assets/theme.css`（全后台一致）：
  - `--ticket-req` 由蓝 `#2F6FB5` → **橙 `#D9730D`**（bg `#FBE6D0`，`.tag-req` 边框改暖色 `#F0C89A`）；`--ticket-bug` 保持红 `#C0392B`（BUG 本就红，线上旧版发暗，部署新 theme.css 后正）。三色：需求橙 / BUG 红 / 咨询紫，分明。
  - 新增状态色类 `.tag-blue`（`#2563C9`，鲜明蓝）、`.tag-indigo`（`#5A47D6`，靛）——替代 `tag-primary` 深藏青发灰的观感。
- `public/inbox.html` `LC_TAG` 重映射（更语义、更分明）：
  - 待处理/分析中→`tag-warning`（琥珀·待评审）；已回复/已答复→`tag-accent`（青）；**已立项→`tag-blue`**（蓝·已落实排期，原 tag-primary 发灰）；**开发中→`tag-indigo`**（靛，与已落实蓝区分）；已出包/已交付→`tag-success`（绿）；待验证→`tag-warning`；**已关闭→`tag-gray`**（灰，原 tag-success 绿→闭单不该绿）；已重开/已驳回→`tag-danger`（红）；暂缓→`tag-gray`。

## 影响面
- 类型 token 改动 = 全后台「需求」标签统一变橙（inbox/detail/batches 等，一致）。批次状态标签（batches/field 的 `STATUS_TAG` 开发中/可下载/已交付）是**另一套**，未动。
- 纯样式，无行为/数据变化 → 不涉 spec（TK-01 状态语义不变，只换展示色）。

## 部署 / 验证
rsync `theme.css` + `inbox.html` → 线上（静态即时生效）；线上确认 `--ticket-req:#D9730D`、`tag-blue/indigo` 已在、`inbox.html` `'已立项':'tag-blue'` 已落地。
