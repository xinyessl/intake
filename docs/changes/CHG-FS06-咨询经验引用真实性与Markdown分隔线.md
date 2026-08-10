# CHG-FS06：咨询经验引用真实性与 Markdown 分隔线

- 日期：2026-08-10
- 类型：行为修正 + 展示缺陷修复
- 关联：FS-06 AC-C5/C6/C7，FS-04 AC-17/39/40

## 问题

`/api/consult` 虽会把经验命中注入普通/深入两类模型提示，但旧实现早在模型调用前就发送 `kb` SSE；未配模型或首片段前失败时，界面仍显示“参考经验库”，造成“检索到”等同“模型已参考”的误导。引用也未随助手消息保存，刷新或重新打开历史会话后丢失。另三处 Markdown 渲染器中，field 未识别独占 `---`，会显示原始短横杠。

## 修复

- 服务端仅在模型首个有效片段回调内发送 `{kb,kbInjected:true}`；`done.kbHits` 按真实注入计数。检索失败降级为空命中且不阻断咨询。
- 引用由服务端 `consultKbRefs` 统一精简，随对应 assistant 的 `kbRefs` 持久化；续聊重建 chat 时保留旧引用。
- field 只接受 `kbInjected===true` 的引用事件，文案改为“已参考经验（N条）”；引用进入草稿/系统快照，刷新、切系统及 reopen 均按消息恢复。请求 payload 只发送 `role/content`。
- `field.html`、共享 `ui.js`、`submit.html` 同步把独占 `---`/`***` 渲染为 `<hr class="md-divider">`，低干扰样式；表格识别优先，列表和 XSS 护栏不变。

## 验证

- `node --test tools/fs-06-consult-kb-evidence.logic.test.mjs tools/markdown-table.logic.test.mjs`
- `node --check server.mjs`
- 既有 FS-04/FS-06/FS-07 逻辑回归；真库套件需可用 MySQL 配置。

## 数据/接口影响

无新端点、无数据库结构变更。SSE `kb` 事件新增真实性标记 `kbInjected:true`；`done.kbHits` 从“检索命中数”收紧为“实际注入且模型开始生成的引用数”。历史 chat JSON 可选增加 `assistant.kbRefs`，旧记录无该字段时安全兼容。
