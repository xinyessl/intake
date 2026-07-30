# CHG · field.html 咨询答复 Markdown 块级渲染修复

- **日期**：2026-07-23
- **类型**：纯 bug 修复（渲染 bug；行为本应如此，spec 无需改）
- **关联 spec**：FS-04（AI 对话提交 · 咨询答复气泡）、FS-06（免登录提交）、FS-07（经验库答复）——均只描述"AI 直接答复 / 对话气泡"，未限定 `md()` 仅行内；故属实现漏支持，不涉 spec AC。
- **改动文件**：`public/field.html`（仅 `md()` 函数 + 配套 `<style>` 内 `.md-*` CSS；未碰 server.mjs / 其他页 / 其他测试逻辑）

## 现象
现场端咨询答复里的 `### 🔍 原因分析`、`1. **放通端口**：…`、`- 检查 xxx` 等 Markdown 标题/列表**当字面量原样显示**，没有渲染成标题/列表。

## 根因
`md(src)`（field.html）原实现是**全局正则**：仅 `` `code` ``→`<code>`、`**x**`→`<strong>`、`\n`→`<br>`。全局正则**无法识别块级结构**（`#`/`-`/`1.` 前缀不在处理集合里），故这些前缀被 `\n→<br>` 一并当普通文本输出。

## 解法
把 `md()` 重写成**块级 + 行内**小型渲染器（零依赖 · XSS 安全）：
1. **先整体 HTML 转义**（`& < >`）——转义在前、再套 markdown，杜绝脚本注入（`<script>`→`&lt;script&gt;`）。
2. **按 `\n` 分行逐行判块**：`/^#{1,6}\s+/`→`<div class="md-h md-hN">`；`/^\s*[-*+]\s+/` 连续归并 `<ul class="md-ul"><li class="md-li">`；`/^\s*\d+\.\s+/` 连续归并 `<ol class="md-ol">`（自动序号）；空行→段落/列表分隔（闭合块，不堆叠空 `<br>`）；其余→`<p class="md-p">`（段内单换行用 `<br>`）。
3. **块内跑行内规则**（`` `code` `` / `**bold**`，在已转义文本上、不跨行）——标题/列表项内的 bold/code 同样生效。
4. **配套 CSS**：`.md-h/.md-h1..h6/.md-ul/.md-ol/.md-li/.md-p` 紧凑样式，作用域限 `.f-msg .bub`（聊天气泡）与 `.f-kb-answer`（经验库答复）；`code`/`strong` 复用页面已有样式，未重定义；复用 theme.css token。

## 验证
- 自测（node 抽 md 函数体跑）：`###`→`.md-h3`、`1.`→`<ol><li>`、`-`→`<ul><li>`、bold/code 在列表项内生效、空行分段无堆叠 `<br>`、`<script>` 被转义。
- `localStorage` 出现 0 次；隐形/零宽字符 0；内联 `<script>` `new Function` 语法过。
- 回归 `node --test tools/fs-04.test.mjs tools/fs-06.test.mjs tools/fs-01.test.mjs` 全绿（72 pass）；fs-04 A 组仍断言 `function md(src)` 存在（保留）。

## 风险
低。纯前端渲染，仅影响 field.html 咨询气泡 / 经验库答复观感；无接口/库/服务端改动。
