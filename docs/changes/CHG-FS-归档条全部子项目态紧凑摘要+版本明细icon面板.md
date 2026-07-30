# CHG · 归档条「全部子项目」态：紧凑产品名摘要 + 版本明细 icon 面板（不再平铺）

- 日期：2026-07-24
- 分类：**归档条显示优化（涉及 spec）** —— 逻辑/显示调整，改 FS-03 AC-18「全部子项目态」子形状。已附 spec diff 入验收门。
- 关联 spec：FS-03 §E AC-18（全部子项目 `state.curSub` 为空分支）；FS-02 AC-6（子系统版本数据源不变，仅引用）。
- 相关测试：`tools/fs-02.test.mjs` A2c/A2d、`tools/fs-03.test.mjs` A2b/A6/A7/A7b、`tools/fs-06.test.mjs` A-CTX。

## 背景（用户反馈 2026-07-24）
实施端 `public/field.html` 医院视图归档条（`#fCtx` → `renderHospChip`）**「全部子项目」态**（未选具体子系统，`state.curSub` 为空）把该医院**所有产品的每个子系统 + 版本平铺并列**（如「现场版本：合理用药·审方 2.7.260723-1 · 合理用药·报表系统 2.7.260723-1 · 干预 … · 点评 … · 引擎&工具库 …」）→ 一长串、换行、观感乱。要求：不全展开，给个 icon 入口看全部版本信息。

## 改动（只改 field.html 的 renderHospChip「全部子项目」分支 + 新增面板函数 + 配套 state/CSS/关闭逻辑）
1. **归档条只显紧凑摘要**：`🏥 <医院> · 现场版本：<产品名（多产品用『、』连接）>` + 紧跟一枚 icon 按钮 `.f-verdd-btn`（`ti-list-details`，`title=「查看各子系统版本」`）。**不再平铺所有子系统 + 版本**。
2. **点 icon 弹「版本明细」面板** `#fVerDetail`（复用 `.f-sysdd-panel` `position:fixed`、`getBoundingClientRect` 按 icon 下方定位逃 `.f-rtool` overflow 裁剪；白底卡片 `max-height:320px`+内部滚动、`z-index:200`；点面板外/滚动/Esc 关闭，接入 `closeAllMenus`）。内容由新函数 `renderVerDetailRows(cust)` 生成 = 逐产品分组（`.f-verdd-grp`）→ 其各子系统 + 版本（`.f-verdd-row`：`.nm` 中文名 + `.ver` 等宽版本）。
   - 数据源同 `buildSubOptions`/`currentArchive` 那套：**新形状**（`pr.subsystems:[{name,version}]`）→ 列该医院维护的各子系统各自版本，desc 从产品目录 catalog 查 name→desc；**旧形状**（无 `subsystems`）→ 兜底列该产品全部子系统 @ 产品级 `version`。
3. **兜底**：无产品 → 「未上线产品」占位、不显 icon；产品无子系统数据 → 面板显「暂无子系统版本信息」。
4. **配套**：`state.verDetailOpen`（含 reset 分支）；`closeAllMenus` 关 `#fVerDetail`；Esc 关闭分支（版本明细优先于系统/医院下拉）；CSS `.f-verdd-btn`/`.f-verdd-panel`/`.f-verdd-grp`/`.f-verdd-row`/`.f-verdd-empty`（复用 theme token、`--font-num` 等宽版本）。

## 未碰（明确）
- `server.mjs` / `public/assets/ui.js` / 其它页面 / 已改逻辑：per-system 会话（`syncConversationToSystem`）、咨询必选守卫、reopen、子项目下拉、`subsystemLabel`、按批次降级、深入思考、`currentArchive` 取值、`renderSysChip`、**`renderHospChip` 选中具体子系统分支**（上次改的「系统：<sub> · 版本：<subVersion>」保持不变）。
- 归档取值/过滤：`currentArchive.out.version`（仍 `subVersion(curSub)`/回退产品级）、`loadSubmissions` 的 `&subsystem=state.curSub` 英文 name 过滤键不变。

## 验证
- field.html：隐形/零宽字符 0（codePoint 集）、`localStorage` 0、内联 `<script>` `new Function` 语法过、FS-01 A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）0。
- 回归全绿：`node --test --test-concurrency=1 tools/fs-02.test.mjs tools/fs-03.test.mjs tools/fs-06.test.mjs tools/fs-04.test.mjs tools/fs-01.test.mjs` → tests 143 / pass 143 / fail 0。
- 本地真库无残留（DB residue 检查仅命中既有真实数据 `BUG-20260707-02`/`admin`/`zhangx`，非本次测试产物）。

## 测试连带改（距离窗口/函数体断言，非行为变更）
- fs-03 A2b：`closeAllMenus[\s\S]{0,400}fSysDD` → `{0,700}`（closeAllMenus 内新增 `fVerDetail` 关闭分支把 `fSysDD` 后移；仍限函数体内）。
- fs-03 A7b：新形状「按子系统各自版本」逻辑从 `renderHospChip` 迁至 `renderVerDetailRows`，断言相应指向新函数体（保留 `renderHospChip` 选中子系统 `subVersion(curSub)` 断言 + 两函数均不调 `/api/versions`）。
- fs-02 A2c：全部子项目态断言由「含平铺子系统版本」改为「紧凑产品名 + `.f-verdd-btn`/`ti-list-details`/`查看各子系统版本` + `renderVerDetailRows` 面板存在 + position:fixed 定位 + `closeAllMenus` 接入」，并 `doesNotMatch` 平铺并列（`subsystems.map(...ms.version...).join(' · ')`）。选中子系统分支断言保持。
