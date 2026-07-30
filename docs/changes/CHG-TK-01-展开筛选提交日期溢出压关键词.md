# CHG · TK-01 · 工单管理展开筛选第二行布局（提交日期溢出压到关键词）

> 日期：2026-07-30　类型：纯 bug 修复（布局）　来源：用户截图「样式乱了」
> 页面：public/inbox.html 工单管理筛选区（展开态第二行）

## 现象
点「展开更多」后第二行 `版本 / 提交日期 / 关键词`：**「提交日期」的日期范围框（两个 `<input type=date>` + 日历图标 + ~）在只占 1/5 栅格时容不下 → 向右溢出，压到相邻「关键词」label 上**，看着像「关键词」重叠错乱。

## 根因
第二行复用 `.filter-grid`（`repeat(5,1fr)`），`提交日期` 只占 1 格，date 输入有固有最小宽度、不收缩 → 溢出到下一格（关键词）。与颜色/标签改动无关（那次只动 `.tag`）。

## 修复（inbox.html 页内 CSS）
- 第二行改 `版本(1) + 提交日期(span 2) + 关键词(span 2) = 5`：`.filter-row-extra .filter-field:nth-child(2){grid-column:span 2}` + `.kw-field{grid-column:span 2}`（原 span 3）。
- date 输入可压缩不溢出：`.filter-row-extra .range-box input[type=date]{min-width:0;flex:1 1 0}` + `.range-box{min-width:0;overflow:hidden}`（兜底裁掉任何溢出，杜绝压邻格）。

## 部署 / 验证
rsync `inbox.html` → 线上（静态即时生效）；服务器确认新规则在。硬刷新后展开筛选，第二行三格对齐、日期范围完整、不再压「关键词」。
