# CHG · consult 审计等待期 SSE 保活与空 EOF 兜底

- 类型：生产回归修复（不改变咨询业务规则，不改 Spec）
- 关联 Spec：FS-04 AC-73、AC-97
- 现象：咨询模型生成与发布前审计期间，服务端不向浏览器发送未审计正文；耗时较长时，中间代理可能因长时间无响应字节提前关闭 SSE。浏览器 `ReadableStream` 将这种关闭表现为正常 `done=true`，实施端又把空累计正文按成功收尾，最终只剩空 AI 气泡且没有错误提示。
- 修复：`/api/consult` 在等待安全终稿期间每 15 秒发送 SSE 注释心跳，立即写首帧并在响应 `close/finish` 或正常完成时清理；注释不进入 `data:{v}`，不泄露草稿，也不改变最终答案。实施端正常 EOF 若仍无正文，显示“连接提前结束”提示，并按非实质答复处理，不出现沉淀经验入口。
- 回归：`tools/fs-04-consult-safe-final-stream.logic.test.mjs` 真执行心跳启停与空 EOF 文案归一逻辑，并锁定 consult 端点接线顺序。
