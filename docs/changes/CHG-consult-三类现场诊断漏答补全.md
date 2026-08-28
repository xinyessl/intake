# CHG：补全三类现场诊断问法的只读兜底

日期：2026-08-28

## 背景

审方浏览器题中有三类问法未稳定进入现场诊断：接口返回有数据但页面未呈现、明确要求改成实施逐项照做的只读清单、请求正常但业务结果不符合预期。旧逻辑可能只复述当前 route facts，或在安全清理后只剩“最小只读排查”标题。

## 改动

- `server.mjs`
  - 新增通用“接口/请求有数据 + 页面未呈现 + 转开发前最小证据”识别，生成页面/筛选/身份范围、同次请求响应、渲染观测和证据分支。
  - 新增“换成实施逐项照做的只读清单”合同，强制四步编号清单并通过诊断序列审计。
  - 新增“请求通但业务结果不符”分层诊断，按请求响应、业务状态/流水、页面刷新/摘要、相邻状态边界给只读对照顺序和观测分支。
  - 三类问法均保留当前 route 已核事实；直接接口/状态仅从当前 route 的路径和状态信号集中放入研发参考，不绑定具体题号或业务 token；现场不建议试越权、重提或改数据。
- `tools/fs-04-consult-conversation.logic.test.mjs`
  - 使用真实 Q0205、Q0210、Q0220 题面和 route 回归分类、fallback 四步内容与终审全绿。
  - 使用真实 Q0194/Q0206 普通事实问法验证不误扩写为现场诊断。
- `docs/lessons.md`
  - 新增 L-130，记录三类自然问法的诊断合同和反例要求。

## 验证

```text
node --check server.mjs
node --test tools/fs-04-consult-conversation.logic.test.mjs tools/fs-04-consult-safe-final-stream.logic.test.mjs
git diff --check
```

结果：53/53 通过；Q0205、Q0210、Q0220 的 `finalAudit.violations` 均为空。本次未提交、推送或部署，也未修改 PWRS 未跟踪文件。
