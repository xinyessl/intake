# CHG-FS-06 · consult 访客产品归属强制（安全缺口修复）

- 日期：2026-07-22
- 关联 spec：FS-06（AC-C3/C4）· 依赖 FS-04（consult 咨询链路）
- 性质：**bug 修复（暴露 spec 硬约束的真实缺口，涉及 spec）** —— 已在 FS-06 §AC-C3 补校正注记（spec diff 随 /accept 一并确认）。

## 现象 / 根因
FS-06「数据归属不可越权（硬约束）」要求访客经 `intake-submit`/`intake-chat`/`consult` 提交时，**产品强制取 token 预置的 `link.project`**，前端传参不可覆盖。
- `intake-submit`(server.mjs L909)、`intake-chat`(L942) 本就 `projById(link ? link.project : b.project)` —— 正确强制。
- `consult`(L971) 历史上写成 `projById(b.project)` —— **未对访客强制 link.project**：访客带有效 token 但 body 传 `project=另一产品 id`，咨询会落到那个产品下，突破归属边界（version/site 已回退 link，唯独 project 被前端左右）。

## 解法（最小改）
```
- const proj = projById(b.project); ...
+ const proj = projById(link ? link.project : b.project); ...   // 与 intake-submit/chat 一致
```
登录用户 `link` 恒为 null（`link = user ? null : linkUserFrom(...)`）→ 退回 `b.project`，登录用户行为不变。仅访客被强制到 `link.project`。

## 验证
`tools/fs-06.test.mjs` B-C3/C4：访客带 token 但传 `project=OTHER_PID` 调 consult → `SELECT project_id FROM intakes WHERE id=convId` = link.project（PID），`OTHER_PID` 下 0 条。全套 27 用例绿；串行跑 fs-0{1,2,3,4,6,7} 共 126 用例无回归；真库跑后只剩 hlyy、link-secret 还原。

## 防复发
已提炼进 `docs/lessons.md`：凡 `LINK_OK` 白名单内的落库端点，`projById` 实参一律 `link ? link.project : b.project`。
