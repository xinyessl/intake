# CHG · UI/inbox·detail · 工单「完整内容」长文本字段 markdown 渲染（不再裸显 ###/**/`code`）

> 日期：2026-08-06　类型：纯 bug 修复（展示层，行为不变）　来源：用户反馈
> 关联：`public/detail.html` + `public/inbox.html`（复用 `public/assets/ui.js` 现成 `window.mdToHtml`，未改 ui.js）
> 不涉 spec：工单内容字段本就是 markdown，之前用 `esc()` 当纯文本贴出属展示缺陷，规约无需改。

## 现象
工单详情/抽屉里的长文本字段（问题现象/报错信息/复现步骤/期望结果/AI 处理意见、需求背景/期望效果/场景/验收/关联，以及抽屉描述行）含 markdown（标题 `###`、加粗 `**`、行内代码 `` `x` ``、列表），旧代码统一用 `esc()` 转义成纯文本 → markdown 符号原样裸显（尤其咨询转来的工单，描述是 AI 生成的 markdown，如 `BUG-20260806-01`）。

## 改动
- **复用共享安全渲染器** `window.mdToHtml`（`public/assets/ui.js` L79，先转义 `&<>` 再解析，XSS 安全）。两页 `<head>` 本就 `<script src="/assets/ui.js" defer>` 引入，无需补引。
- `public/detail.html`：
  - 新增 `fldMd(k,v)`（内部走 `mdToHtml`，渲染进 `.md-body` 块级容器；无值回退 `—`）。**短字段/标签仍走 `fld`（纯 esc）**——标题/模块/版本/现场/提交人/状态/badges 等不动，避免普通文本符号被误渲染 + 版面乱。
  - 长内容字段改用 `fldMd`：BUG 内容 `问题现象/报错信息/复现步骤/期望结果/AI 处理意见`；需求内容 `需求背景/期望效果/使用场景/验收标准/关联现有页面`。
  - 新增 `.md-body` 排版 CSS（标题/列表/加粗/行内代码/`pre` 横向滚动/blockquote/hr/`img{max-width:100%}`），套 `--pri/--alt/--line` 主题变量，`>*:first/last-child` 去首尾外边距防撑破卡片。
- `public/inbox.html`：
  - `renderProcessBody`（处理抽屉描述行）+ `renderViewBody`（查看抽屉描述行）：描述行 `descText` 由 `esc(descText||'—')` 改为 有值时 `<div class="md-body">${mdToHtml(descText)}</div>`、空则 `—`。
  - `renderViewBody` 的「决策回复」（chat 里 role=dev）：`devMsgs.map(m=>esc(m.text)).join('<br>')` 改为每条套 `<div class="md-body">${mdToHtml(m.text)}</div>`（dev 回复也可能含 md）。
  - 新增同款 `.md-body` CSS（用 `--color-*` 主题变量、抽屉窄故字号收紧）。

## 追加（2026-08-06 · 沟通记录气泡 md 渲染）
> 用户实测：详情页「沟通记录」对话气泡里 AI 回复的 `###`/`**`/`` `code` `` 仍裸显（上一版只修了内容字段，漏了对话线程）。
- `public/detail.html` L214 沟通记录 `chat.map`：**assistant / dev** 角色消息 `m.text` 改用 `mdToHtml`、气泡加 `md-body` class（`<div class="bubble md-body">…`）；**user(me)** 消息保持 `esc`（现场提问是纯文本，`.bubble` 的 `pre-wrap` 就好）。
- `.md-body` CSS 加 `white-space:normal` —— 覆盖 `.bubble` 的 `white-space:pre-wrap`（md 已成块级元素、自带段落间距，pre-wrap 会在块间多出空行）。对之前描述字段的 `.md-body` 无副作用（描述字段本就不是 pre-wrap 容器）。
- `inbox.html` 无完整对话线程（user+ai），只在查看抽屉展示 dev 决策回复——已一并 mdToHtml（见上）。
- 冒烟（vm 复刻 detail 沟通记录 map 逻辑）：AI 气泡 `###`→`<h3>`、`**`→`<strong>`、`` `code` ``→`<code>`、`* `列表→`<ul><li>`、带 `bubble md-body` class（PASS）；dev 气泡 md 渲染（PASS）；**user 气泡无 `md-body`、`` `instituteId` `` 保留裸反引号纯文本**（PASS）。真数据 `BUG-20260806-01` chat=`[user(纯文本), assistant(AI markdown 含 ###/**/`code`)]`，正命中此场景。prod scp 后 admin 会话拉 `detail.html` 200、含 `bubble md-body`×1。

## 影响面
- 仅 detail/inbox 两页的**长内容字段**渲染方式变化；短字段、其它页无改动。`mdToHtml` 是既有共享函数（提交页/经验库/详情页已用），零新依赖。
- 安全：`mdToHtml` 先 `esc` 再解析，`<img src=x onerror=…>` 之类被转义（冒烟验过尖括号转义 PASS），无 XSS 回归。

## 冒烟
- vm 加载 `ui.js` 的 `window.mdToHtml`，喂 `BUG-20260806-01` 真实描述片段：`### 标题`→`<h3>`、`**当前逻辑**`→`<strong>`、`` `instituteId` ``→`<code>`、`*  ` 列表→`<ul><li>`，无裸 `###`/`**` 残留；`<img …>` 转义 PASS。
- prod（admin 会话）拉 `detail.html` 含 `fldMd`×3 / `md-body`×17；`inbox.html` 含 `md-body`×18，HTTP 200。

## 部署
scp `public/detail.html`、`public/inbox.html` → prod `/opt/intake/public/<文件>`（显式完整文件路径）。静态文件每请求 `fs.readFileSync` 读盘、无内存缓存，不重启。
