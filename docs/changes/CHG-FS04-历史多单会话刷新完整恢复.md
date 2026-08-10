# CHG · FS-04 历史多单会话刷新完整恢复

## 现象

实施端从「对话记录」打开咨询后刷新可恢复；但打开一条已建 3 张工单的提单会话，刷新前右侧有完整消息与 3 张「已建单」卡，刷新后只剩完整消息与 1 张卡。用户容易理解为历史内容丢失。

## 原因

异步 `reopenIntakeConv` 已在渲染完成后调用 `saveDraft()`，草稿也包含 `builtTickets`；真正缺口在 `restoreDraft` / `restoreConversation`：恢复时只判断 `savedId` 并调用一次 `appendArchiveCard`，没有消费已保存的全部 `builtTickets`。

## 修复

- `normalizeBuiltTickets`：以 `builtTickets` 为顺序源，按工单 id 保序去重；老草稿没有清单时才以 `savedId` 兜底。
- `renderSavedConversation`：刷新和切系统恢复统一逐张重建已建单卡；每张卡保存 `afterMessageIndex`，刷新后仍回到原消息时间线位置，不统一堆到末尾。
- `builtTickets` 保存卡片所需的医院、子系统、版本、紧急程度、产品等展示上下文，刷新前后卡片语义一致。
- 打开咨询时清空上一段提单会话卡片上下文，避免刷新后串卡；单工单旧会话也明确写入一项 `builtTickets`。

接口、权限、数据库、视觉均未改变；仍是 legacy `field.html`，未启用 React。

## 验证

- `node --test tools/fs-04-refresh-restore.logic.test.mjs tools/fs-04-conversations.logic.test.mjs tools/fs-04-intake-chat-sequential.logic.test.mjs tools/fs-04-reopen-order.logic.test.mjs`
- 专项 81/81；全量 legacy 逻辑 333 项中 324 通过、0 失败、9 项因本机未配置真库连接按设计跳过。
- 线上新版本浏览器：咨询 fresh reopen→F5 为 4→4 条消息、0→0 卡，消息正文完全一致；3 单会话为 7→7 个语义节点、3→3 张卡，全部节点正文、卡片正文和消息穿插顺序完全一致。
- 部署只覆盖 `public/field.html`，线上 SHA-256=`7f7edf7febeced7d1419b33915cc7d246723083f325bb96ba7a1a2866fcd97e3`；备份 `/opt/intake-backups/intake-before-timeline-refresh-20260810-175255.tar.gz`。容器运行，健康检查 200，实施域 `field.html`=200，运营域登录=200、未登录后台=302 到登录页；全站 React 接管标记为 0。
- 本机真库未启动；生产验证仅执行已有记录的只读打开与刷新，不新建、不修改工单。
