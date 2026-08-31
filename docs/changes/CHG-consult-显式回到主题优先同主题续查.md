# CHG · 显式回到主题优先同主题续查

- **日期**：2026-08-31
- **来源**：浏览器正式测试 Q0845。用户明确说“回到 XML 报文解析集成”，系统却被通用“第一层已核、下一步”模板带到 JWT 续查路由，回答了 Shiro/JwtFilter/JwtRealm。
- **类型**：纯缺陷修复；XML 与 JWT 的既有业务事实不变，因此不修改 spec。

## 改动

- 上下文路由在继承与通用续问裁决前，先识别唯一的“回到〈完整 route title〉这里”显式主题锚点。
- 若同时询问第一层通过后的只读继续顺序，只允许选择与锚定标题存在判别主题词交集的 continuation 路由。
- 没有同主题 continuation 时保持点名 route，禁止被其他主题的通用“下一步”路由抢占。
- 真正的 JWT 续问、显式切换到其他主题和无专用 continuation 的普通主题保持原行为。

## 验证

- Q0841–Q0845 完整会话和 Q0845 单轮均从 XML 报文解析锚点选择 `AUD-QR-GUIDE-01`，不再出现 `AUD-QR-SYS-01-JWT-CONTINUE`。
- 合法 JWT-CONTINUE、显式新主题切换、医嘱标记无 continuation 反例通过。
- 路由、conversation、safe-final-stream 聚合：116 项，85 通过、31 条可选跳过、0 失败。
- `node --check`、`git diff --check` 通过。
