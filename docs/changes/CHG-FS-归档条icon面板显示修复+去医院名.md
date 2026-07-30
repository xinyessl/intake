# CHG · field.html 归档条两处修复（2026-07-24）

- 日期：2026-07-24
- 落地文件：`public/field.html`（唯一改动源）、`tools/fs-02.test.mjs`（连带测试）
- 关联 spec：FS-02（医院视图·归档 chip 显示，非 AC 层，UI 实现细节）、FS-03（版本模型引用）
- 未碰：`server.mjs` / `public/assets/ui.js` / `public/inbox.html` / 其它页 / 任何已改逻辑（per-system 会话、必选守卫、reopen、子项目下拉、subsystemLabel、按批次降级、深入思考、思考动效、currentArchive、renderSysChip、选中子系统分支、renderVerDetailRows 内容）。归档取值/过滤（`currentArchive.out.*`、`&subsystem=state.curSub`）一律不动。

## 分类
- **问题①（版本明细 icon 点击无效）= 纯 bug 修复** → 本 CHG，**不改 spec**（spec 未定义面板 CSS 细节，代码本就应显示）。
- **问题②（归档条去医院名）= 纯显示调整** → 本 CHG（归档条医院名/图标显示未形式化为任何 AC；FS-02 AC-18/19/20 是 API 收敛、非 chip 文案）。行为不变（数据取值/过滤不动），仅去显示冗余。

---

## 问题①：版本明细 icon 点击无效（上一版引入的 bug）

**现象**：医院视图「全部子项目」态，点归档条上的「版本明细」icon（`.f-verdd-btn`，`ti-list-details`）无任何反应，面板不弹出。

**根因（实锤）**：版本明细面板 `#fVerDetail` 的 class 是 `f-verdd-panel f-sysdd-panel`，复用了 `.f-sysdd-panel`。`.f-sysdd-panel` 的 CSS 是：
- `.f-sysdd-panel { display: none; ... }`（L205）
- `.f-sysdd.open .f-sysdd-panel { display: block; }`（L206）——靠**父级 `.f-sysdd.open`** 才显示。

但版本明细面板的点击处理器把 `.open` 加在**面板自己身上**（`vpanel.classList.add('open')`），面板又**不在 `.f-sysdd` 容器内**，且**没有 `.f-verdd-panel.open{display:block}` 规则** → 面板恒 `display:none`，点 icon 无反应。

**修法**：新增一条 CSS 规则（L354 附近，紧跟 `.f-verdd-panel` 声明后）：

```css
/* 版本明细面板复用 .f-sysdd-panel（display:none），但 .open 加在面板自身而非父级 .f-sysdd → 须自带此规则才显示（问题①：早前漏了，点 icon 无反应） */
.f-verdd-panel.open { display: block; }
```

**点击链路核对**（修后）：点 icon → `vbtn` handler → `state.verDetailOpen=true` + `vpanel.classList.add('open')` → CSS `.f-verdd-panel.open{display:block}` 真正显示 → `getBoundingClientRect` 设 `top/left`（position:fixed，逃 `.f-rtool` overflow 裁剪）→ 面板弹出、定位在 icon 下方。
**关闭链路已配套**（未改）：`closeAllMenus` 里 `vd.classList.remove('open')` + `state.verDetailOpen=false`（L956-957）、Esc 分支（L2331-2332），与新增的 `.open{display:block}` 配套正确。

---

## 问题②：归档条去掉医院名（太占位置）

**现状**：`renderHospChip` 各分支都以 `🏥 <医院名> · …` 起头（如「🏥 济南市妇幼保健院 · 现场版本：药师工作站 [icon]」）。顶栏已有医院选择器（`#fHospCur`），归档条重复医院名冗余、占地方。

**改法**（`renderHospChip`，只改显示、去前导医院图标 + 医院名，各分支直接起头）：
- 无医院态 `if(!site)` → `现场版本：未上线产品`（本就无实名）
- 选中子系统态（`state.curSub` 非空）→ `系统：<subLabel(curSub)> · 版本：<subVersion(curSub)||'—'>`（early-return，不挂产品级现场版本，问题②/③行为不变）
- 全部子项目态 + 无产品占位 → `现场版本：<产品名(多产品『、』连接)> [icon]` / `现场版本：未上线产品`

**数据取值一律不动**：`site` 仍用于下方 `state.customers[i].name === site` 匹配取产品、`currentArchive.out.site`、`loadSubmissions` 的 `&subsystem=state.curSub` 过滤——只把归档条**显示**的医院名去掉。
**标点核对**：各分支 `ctx.innerHTML` 直接从「现场版本：」/「系统：」起头，无孤立「 · 」前缀、无双空格、无孤立医院图标。

---

## 测试（`tools/fs-02.test.mjs`）
- **A2c**（既有）：末尾新增断言「存在 `.f-verdd-panel.open{display:block}` 规则」（问题①）。既有「选中子系统显版本」「全部子项目紧凑+icon」「renderVerDetailRows」断言全部保留、未破坏（去医院名后 subBranch/hospBody 各正则仍命中）。
- **A2e**（新增）：断言 `renderHospChip` 各分支不再含 `escapeHtml(site)`（去医院名）；`site` 仍用于 customers 匹配（数据取值不动）；各分支 `innerHTML` 直接从「系统：」/「现场版本：」起头。

## 验证
- field.html：隐形字符 0、`localStorage` 字面量 0、内联 `<script>` 经 `new Function` 语法过、FS-01 A6 禁词（账号管理/发包/决策/accounts.html/inbox.html）0。
- 回归：`node --test --test-concurrency=1 tools/fs-02.test.mjs tools/fs-03.test.mjs tools/fs-01.test.mjs` → 65 pass / 0 fail；`tools/fs-06.test.mjs`（A-CTX 含 renderHospChip 断言）→ 55 pass。
- 连真库冒烟（fs-02 B 组）：造隔离产品 + impl 账号 + customers.json 甲医院 → `/api/field/submissions` 三桶/过滤/越权收敛/新形状子系统版本回读全绿。
- 无残留：测后 accounts=2 / projects=1 / intakes=30 / kb=12（= baseline），无 fs02/fs03 tag 行，customers.json 保持缺省（测前缺省、测后仍缺省）。

## 风险
- 极低：仅 field.html 一处新增 CSS + 四处 innerHTML 去医院名前缀；无端点/无库/无逻辑改动。归档取值/过滤未动，数据落地不受影响。
