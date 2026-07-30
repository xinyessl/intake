# CHG-FS-06 · 咨询「正在思考中…」等待期动效（①）+ 记：经验库相关度门槛（②见 spec）

- **日期**：2026-07-24
- **spec**：FS-06（免登录提交链接 / 实施端咨询答疑）
- **触发**：用户 2026-07-24 反馈——实施端「咨询答疑」两处体验：① 发咨询后 AI 逐字答之前只有一个光标在闪、像卡住；② 经验库弱匹配也被注入 + 展示「参考经验库」，与提问无关，嫌乱。
- **类型**：① 思考动效 = 样式/交互（**不改 spec**，本 CHG 记）；② 相关度门槛 = 行为变更（**改 spec** FS-06 新增 AC-C5b + 修订 AC-C5，spec diff 随验收拍板，不在本 CHG 展开）。

## ① 咨询「正在思考中…」等待期动效（field.html · 纯前端 · 本 CHG 范畴）
> 现象：`sendConsult` 建 `bub = appendBubble('ai','',true)`（空气泡 + SSE 流式光标），收到首个流式字符前只有 `.streaming::after` 一个 `▋` 光标在闪，显得像卡住 / 没反应。

- **改法（纯 CSS 动效 + 一个幂等开关函数，复用 theme token，无 ui.js、无端存储）**：
  - **CSS**（`public/field.html` `<style>`，紧邻既有 `@keyframes fBlink` 流式光标之后）：新增 `.f-thinking`（三点跳动 `<i>×3` + 文字「正在思考中…」，flex 行内）、`@keyframes fThink`（三点 bounce·各带 `.18s/.36s` 延迟错峰）、`.f-msg .bub.thinking.streaming::after { content:none }`（思考态隐藏流式光标，避免光标+三点并存显乱）。三点色/文字色走 `--color-primary`/`--color-text-secondary` token。
  - **开关**（新函数 `setThinking(bub, on)`，紧邻 `appendBubble`）：`on=true` → 气泡加 `.thinking`、`innerHTML` 置三点动效占位、标 `bub._thinking=true`（幂等，重复调 no-op）；`on=false` → 去 `.thinking`、清占位（交回逐字/整体渲染）、`bub._thinking=false`。
  - **触发/清除接线**：
    - **consult**：`sendConsult` 建气泡后 `setThinking(bub,true)`；**流式路径** `if (o.v != null) { setThinking(bub,false); acc+=o.v; ... }`（首个 token 到达即清，转正常逐字渲染）；**退化整体读取路径** `onConsultEvent` 同样在首个 `o.v` 清；`finishConsult`（done / 用户停止 / 网络错误）兜底 `setThinking(bub,false)`（首 token 未到就结束时也清）。**覆盖深入思考**（deep 时思考更久，动效更该有——同一 `sendConsult` 路径，无需额外分支）。
    - **intake（提需求/报BUG）**：`intake-chat` 也是「等待期空气泡」（非流式，等整体回复），一并覆盖同款动效——`sendIntake` 把原 `appendBubble('ai','正在理解并整理…',true)` 改为空气泡 + `setThinking(thinking,true)`；`.then`（回复到达）与 `.catch`（网络异常）分支各加 `setThinking(thinking,false)` 再渲染真实文本。择清爽、两处一致。
- **未碰**：ui.js / customers.html / 其它页 / 已改逻辑（per-system 会话 · 必选守卫 · reopen · 子项目下拉 · subsystemLabel · 按批次降级 · 深入思考开关本身 · 归档条 · currentArchive · renderSysChip · renderVerDetailRows）。
- **护栏核对**：field.html `localStorage` 字面量 0（含注释）、A6 禁词 0、隐形字符 0、`new Function` 解析过、`node --check server.mjs` 过。

## ② 经验库相关度门槛（server.mjs · 行为变更 → 见 FS-06 AC-C5b，本 CHG 仅登记）
- server.mjs `kbSearch(projId, query, n=5, minScore=1)` 加 `minScore` 入参（`.filter(x=>x.sc>=lo)`，`lo=max(1,minScore|0)`）；**默认 1 保持历史行为**（drawer `/api/kb-search`、`intake-chat`、`kbAddFromIntake` 不受影响）；**仅 consult** 调用改传 `kbSearch(proj.id, qtext, 5, 2)`（`minScore=2`，过滤只命中 1 个常见 token 的弱匹配）。注入（`consultSystem`）与展示（kb 事件）两处用同一过滤后的 `hits`，一致。
- 详见 **FS-06 AC-C5b（新增）+ AC-C5 修订 + §4.4 契约**（spec diff）；连真库两例实测：强相关 sc=14/弱匹配 sc=1（`minScore=2` 分开）、两条都强相关 sc=11/10（都保留，不误伤）。

## 测试（`tools/fs-06.test.mjs`，全绿）
- ① 静态：`B-THINK1`（`.f-thinking` + `@keyframes fThink` + `setThinking` 开关幂等）、`B-THINK2`（sendConsult 建气泡挂动效 / 首个 o.v 清 / finishConsult 兜底清 / 退化路径清）、`B-THINK3`（intake 等待期同款动效 + 回复/异常清）。
- ② 连真库：`B-KB-REL0/1/2`（隔离产品 `fs06rel-*` 塞强相关+弱匹配两条 → 问强相关只回强相关那条·`kbHits=1`；问与两条都强相关 → 两条都回·`kbHits=2`）；`B-KB-REL3`（逻辑层 `minScore=2` 过滤 sc=1、`minScore=1` 不过滤）；`B-KB-REL4`（全仓仅 consult 一处传 `minScore=2`，drawer/其它默认 1）。
- 回归：`node --test --test-concurrency=1 tools/fs-06.test.mjs tools/fs-07.test.mjs tools/fs-04.test.mjs tools/fs-01.test.mjs` 全绿（145 用例）；真库核对 0 残留（只剩 `hlyy`）、link-secret 备份还原。

## 覆盖的 AC
- ① 无对应 AC（样式/交互，CHG 记）。
- ② AC-C5b（新增）+ AC-C5（修订：`kbSearch(...,5,2)` 已过滤弱匹配）+ §4.4 SSE 事件序契约（`kbSearch` 签名/minScore 说明）。
