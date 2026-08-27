# CHG · consult 采集异常已核边界完整发布

- 日期：2026-08-28
- 关联 spec：无（纯 bug 修复；Spec 事实正确，无需同步）
- 类型：纯 bug 修复（verifiedFacts 终审与安全 fallback）
- 改动范围：`server.mjs`、`tools/fs-04-consult-conversation.logic.test.mjs`

## 现象

严格浏览器裁判发现 DI-07「采集异常处理」在模型正常返回但事实不完整时仍可能放行：普通“现在是怎么实现的？”漏掉生产包/发布记录、访问与失败记录、运维确认及未经授权不得重新调用；受限证据或已有记录问法的确定性 fallback 还可能因 Top-N 截取漏掉 `audit_sync_error_flow` 属于另一套机制、不由 HC1015 补发入口统一处理的边界。

## 根因

1. 问句包含“异常”时命中诊断信号，简单 as-built 实现问法未进入完整 route 事实覆盖门。
2. partial evidence fallback 固定只取相关性最高三条事实，机制隔离句没有“日志/记录”等观测关键词，可能被截掉。

## 修复

- 对不含现场、证据、只读等追问词的简单“怎么实现/如何实现”问法启用 route 事实覆盖；只有 route 明确提供时，才检查生产部署/发布记录/支持范围/运维确认和授权/重复调用边界。
- partial evidence fallback 在 Top-N 事实之外，补入 route 明确的“另一套机制/不由统一处理/相邻机制/机制隔离”事实；不引入 `mustNotConfuse` 或无关上下文。
- 字段/列原子题、显式现场诊断题继续使用原有窄范围，不被完整事实覆盖规则扩写。

## 回归与验证

- Q0106：用裁判实际漏答草稿调用 `audit`，确认命中 `incomplete_verified_facts`；经 fallback 补齐生产/授权边界后 `violations=[]`。
- Q0108：模型截断时 fallback 保留 `audit_sync_error_flow` 机制隔离事实，最终审计全绿。
- Q0118：模型 429 时 fallback 同时保留机制隔离和“不改数据、不重放消息、不重提任务”的只读边界，最终审计全绿。
- `node --test tools/fs-04-consult-conversation.logic.test.mjs`：37/37 通过。
- `node --test tools/fs-04-consult-safe-final-stream.logic.test.mjs`：16/16 通过。
- `node --check server.mjs`、`git diff --check`：通过。

## 不改 Spec 原因

本次没有改变业务规则：上述生产启用、运维授权、机制隔离和只读红线均已存在于 route/Spec 核实事实中，问题仅是终审覆盖门和确定性 fallback 的事实选择不完整。因此按纯 bug 修复留痕，不修改 Audit Spec。
