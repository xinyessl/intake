# CHG · FS-05 · 实施端「待办」弹层填真实数据（不再是占位）

> 日期：2026-07-30　类型：功能补齐　来源：用户反馈（待办有数字点进去没内容）
> 页面：public/field.html 实施端顶栏待办 popover

## 现象
待办铃铛徽标有数字（来自 /api/notifications 的 count），但点开弹层只有占位文案「待办数据由后续版本填充」——FS-05 当时只留了空壳挂载点、没填 body。

## 修复
`loadTodo` 除取 count 外，把 `/api/notifications` 返回的 items（现场侧=lifecycle `已回复`/`待验证` 的工单，`{project,id,title,lifecycle,type}`）渲染进 `#fTodoBody`：
- 每条：状态徽标（待验证蓝 / 已答复绿）+ 类型([BUG]/[需求]/[咨询]) + 标题 + 提示语（待验证→"待你现场验证" / 已回复→"运营已答复，点开查看"）。
- 空态：「暂无待办」。
- 点某条：待验证→切「按批次」视图（逐单验证入口）；其它→回「按类型」清单。
- 新增 `.f-todo-list/.f-todo-item` CSS（复用 theme.css 变量）。

## 部署 / 验证
rsync field.html → 线上；服务器确认 renderTodoBody/onTodoClick/f-todo-list 已在。当前 count=1（待验证 CHA2DS2 单）→ 弹层显示该条。
