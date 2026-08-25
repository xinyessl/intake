# CHG · PD-01 编辑抽屉「子系统 分支/tag 多选下拉」面板 position:fixed 逃 overflow 裁剪

- **日期**：2026-08-25
- **来源**：用户反馈——贴 Gitee 仓解析出 1 个子系统 `wzh2.0`，点「tag」下拉，面板里 2 个 tag（`v1.5.0`、`1.0.26082501`）**只显示 checkbox、名字被裁掉/看不全**（分支同理）。数据完全正确（`/api/git-refs` 真实返回 `{"wzh2.0":{"branches":["main"],"tags":["v1.5.0","1.0.26082501"]}}`，已冒烟确认）——纯显示 bug。
- **spec**：PD-01（子系统分支/tag 多选）。AC 行为不变（面板照旧：搜索过滤 / 勾选切换 / 触发器摘要 / 已失效标记 / 保存带 branches,tags），**只修显示层裁剪**→ 归 §4.5「纯 bug 修复（代码本就该这样、spec 是对的）」类，**不改 spec**，CHG 记一条。
- **范围**：**只改** `public/projects.html`（`.ref-panel` CSS + 新增 3 个面板开合/定位 helper + 3 处开合站点改走 helper）；同步 `tools/pd-01-git-refs.logic.test.mjs` D6 加断言。**未碰** git-refs 数据流 / `gitInspectGitee` / `server.mjs` / 子系统卡片 `.subitem` 结构。

## 类型
纯前端显示 bug 修复（PD-01 AC 行为不变），不涉 spec。CHG 记一条。

## 根因
`.ref-panel`（下拉面板）原是 `position:absolute`，但它嵌在 `.subslist{overflow-y:auto;max-height:220px}` 里、外面还套可滚动的 `.drawer-body` → **绝对定位面板被 `.subslist` 的 overflow 裁进那个 220px 小滚动框**，选项行被截、名字看不全。这是本项目已知模式（L-011：ui.js `.ui-sel-pop` 靠 `position:fixed` 逃 overflow；L-010：field.html `.f-proddd` 同招），本控件当初没照抄。

## 改动要点
- **CSS `.ref-panel`**：`z-index:60` → `z-index:9999`（盖过 theme.css `.drawer`/`.drawer-mask`=310；否则 fixed 面板会渲染在抽屉之下）；静态 `position:absolute` + `top/left/right` 值留作兜底，open 时由 JS 内联 fixed 覆盖。
- **新增 3 个 helper**（照 `assets/ui.js` 的 `place()`/`open()`/`close()` 老招）：
  - `placeRefPanel(panel)`：按触发器 `.ref-trigger` 的 `getBoundingClientRect()` 定位——`position:fixed`、`left=rect.left`、`width=max(rect.width,180)`；`below=innerHeight-rect.bottom` 下方空间不足（<160）且上方更宽 → **上翻**（`bottom=innerHeight-rect.top+gap`、`top:auto`）；`max-height=min(可用空间,240)`。
  - `openRefPanel(panel)`：加 `.open` + `placeRefPanel` + 挂 `scroll`（capture=true，捕获 `.subslist`/`.drawer-body` 内滚）+ `resize` 监听（`_refWinBound` 防重复绑）；照 ui.js「一滚动就关」策略（scroll→close，resize→重定位）。
  - `closeRefPanel(panel)`：去 `.open` + 清临时 fixed 内联样式（`position/left/right/width/top/bottom/maxHeight` 全清，恢复 CSS 兜底态）+ 摘 scroll/resize 监听。
  - `closeAllRefPanels()`：`#subsList .ref-panel.open` 全走 `closeRefPanel`。
- **3 处开合站点改走 helper**（行为逻辑不破坏）：
  - 触发器点击（`bindRefEvents`）：先 `closeRefPanel` 其它已开面板，再 `renderFieldOpts` 填选项 → `openRefPanel`。
  - 勾选后保持打开：`openRefPanel(p)`（顺带重定位，摘要变化可能改触发器高度）。
  - `renderFieldOpts`（搜索）：面板已 open 时 `placeRefPanel` 重定位（选项数变 → 高度变）。
  - 点面板外关闭：`closeAllRefPanels()`。
- **保留不变**：面板仍是 `.ref-field` 的 DOM 子节点（只视觉 fixed）→ `closest('.ref-field')` 判断依然成立、事件委托（`#subsList` 上的勾选/搜索）照旧冒泡命中；搜索过滤 / 勾选切换 / 触发器摘要（`renderRefField`）/ 已失效标记全不动。

## 验证
- `node --test tools/pd-01-git-refs.logic.test.mjs`：D 系列 21/21 绿（含 D6 新增断言：`placeRefPanel` 用 `getBoundingClientRect`+`position:fixed`+`innerHeight`+上翻 `bottom=`；有 `openRefPanel`/`closeRefPanel`；scroll capture 监听；`.ref-panel` z-index:9999）；E 系列本地无 MySQL 4 条 SKIP（正常）。
- inline `<script>` 解析：`vm.compileFunction` 全量通过（无语法错）。
- **行为 smoke**（抽 3 个 helper 对 fake DOM 实跑）：① 下方空间足 → `position:fixed`、`left=rect.left`、`top=rect.bottom+3`、`bottom:auto`、`width` 夹到 180；② 触发器贴视口底 → 上翻 `top:auto`、`bottom=innerHeight-rect.top+3`；③ 关闭清空所有 fixed 内联样式、去 `.open`。全绿。
- 真机由编排器 scp 到 113 后由用户浏览器验（静态文件，无需重启容器）。未 commit、未部署（按要求）。
