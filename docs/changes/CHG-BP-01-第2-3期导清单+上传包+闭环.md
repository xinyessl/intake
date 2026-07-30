# CHG-BP-01-第2-3期·导出开发清单 + 上传包转可下载 + 批次闭环

- 日期：2026-07-24
- 分类：**新特性落地（第 2-3 期 · spec BP-01 已 ready）**——按 BP-01 §附录·分期第 2/3 步实现「导出开发清单」「上传包（管理身份）转可下载」「批次闭环」。spec 本体（AC-9~18 / §4 契约）未变；仅在 §0 后「🚧 实现进度」新增本期完成标注 + NH-5 上传包跳态实现裁决（选型 A），并在 NEEDS-HUMAN 列回填 NH-5 已裁 → 该标注算「涉及 spec」，附本 CHG 可审留痕走验收门。
- 触发：接续第 1 期，用户 2026-07-24「实现第 2-3 期（运营侧剩余）」；第 4-6 期（实施端下载/改版本/逐单验证/按批次视图）归 FS-05，本期不做。

## 覆盖 AC（第 2-3 期）
AC-9 / AC-10 / AC-11（导清单 json 按子系统分组含 描述/验收/AI初判/涉及医院/现场版本/截图URL；md 可下载 `Content-Disposition attachment`；无截图单不报错）
AC-12 / AC-13 / AC-14 / AC-15（上传包转可下载 + 覆盖工单转「已出包」+ `resolution.fixedVersion`；非 admin 403；非「开发中」批次 `ok:false`；`pkgVersion/artifactUrl` 必填 400）
AC-16 / AC-17 / AC-18（闭环：未全闭 `ok:false+pending`；全 `已关闭`→`已交付`；批次态不因单个反馈回退）

## 改动

### 1) 后端 `server.mjs`（3 新端点，均 admin：未进 `authGate` 的 `FIELD_OK`/`LINK_OK` → 非 admin 自动 401/403）
- `GET /api/batch-checklist?id=&format=json|md`（默认 md）：取批次覆盖工单 → 按 `subsystem` 分组（中文 desc via `kbSubLabel`）→ 每条 `{ticketId,type,title,desc,accept,ai,hospitals,siteVersion,media}`。
  - **描述择有值** `checklistDesc(e)=e.desc||e.reqDesc||e.bg`（bug 用 desc 现象、需求用 reqDesc/bg）；**验收** `e.accept`；**AI 初判** `checklistAi(e)`（`analysis.{category/suggestion/verdict/detail}` 摘要，无则空）；**涉及医院** `e.site`；**现场版本** `e.version`；**截图** `mediaUrls(proj,e,host)`=`e.media`（相对路径 `media/<id>/img-N.png`）→ 完整可访问 URL `http://<host>/api/intake-media?project=&file=`（有 `req.headers.host` 拼绝对、无则相对，复用现有截图端点）。
  - `format=json` → `{batch,product,productName,groups:[{subsystem,subsystemLabel,items:[...]}]}`；`format=md`（默认）→ 可下载 Markdown（`Content-Type: text/markdown; charset=utf-8` + `Content-Disposition: attachment; filename*=UTF-8''开发清单-<id>.md`），按子系统 `## 分节` + 每工单 `### 类型·标题 \`id\``，描述/验收/AI/截图（`![](url)`）分块；无截图段不出、不报错。
- `POST /api/batch-release {id,pkgVersion,releaseNote,artifactUrl}`：校验 批次存在 + 状态=`开发中`（否则 `{ok:false,error:'仅开发中批次可上传包'}`）+ `pkgVersion/artifactUrl` 必填（否则 400 `{ok:false,error:'包版本/包地址必填'}`）→ 落 `{pkgVersion,releaseNote,artifactUrl,releaseTime:nowStamp(),status:'可下载'}` + `history` release 留痕 → 覆盖工单**直接置 `已出包`**（见 NH-5 裁决）+ `resolution.fixedVersion=pkgVersion` + 工单 `history` 系统留痕 → 返回 `{ok,item,pushed,skipped}`。
- `POST /api/batch-deliver-check {id}`：检查覆盖工单是否全部 `lifecycle=已关闭` → 全过则 `status:'已交付'`+`deliveredAt`+`history` deliver 留痕、返回 `{ok:true,item,delivered:true}`；否则 `{ok:false,error:'尚有工单未现场验证',pending:[未闭单id],delivered:false,item}`（批次态不回退）。

### NH-5 上传包跳态·实现裁决（选型 A）
覆盖工单多停在 `已立项`，到 `已出包` 按 `TRANSITIONS` 需 `已立项→开发中→已出包` 两跳。本期 batch-release 作为**批次驱动的系统动作直接置态 `已出包`**：在工单对象上 `e.history.push({from,to:'已出包',by:'系统·发包',byRole:'system',at,note:'批次B-xx发包(pkgVersion)'})` + `e.lifecycle='已出包'` + `e.status=lifecycleToStatus('已出包')` + `e.resolution.fixedVersion` + `saveIntake`（穿透 data JSON、不加库列）。**不走中间 `开发中` 态**——避免中间态噪音；未重造流转（复用工单对象 + saveIntake，留痕格式与 `intake-transition` 一致）。已在 `已出包/待验证/已关闭` 态的工单幂等 skip 计 `skipped[]`，不阻断整批。

### 2) 前端 `public/batches.html`（详情抽屉新 UI，未碰列表/建批既有逻辑）
- 详情抽屉顶部动作条：「导出开发清单」（`<a href="/api/batch-checklist?id=&format=md" download target=_blank>` 直接触发 md 下载）+「预览清单」（拉 `format=json` 渲染 modal `#previewModal`）。
- **开发中**态：显「上传包·转可下载」表单（`relPkgVersion`/`relArtifactUrl` 必填 + `relNote` 说明），`doRelease(id)` 调 `batch-release` → 成功后刷新列表 + 重开详情为「可下载」态。
- **可下载/已交付**态（`b.pkgVersion` 有值）：显「包信息」（版本/地址/说明/上传时间/下载数）。
- 状态徽标 `STATUS_TAG` 三态（开发中 tag-primary / 可下载 tag-info / 已交付 tag-success）；列表状态筛选已支持三态（第 1 期已含）。新增 CSS `.dactions/.relbox/.pkgbox`（theme token），新增 `#previewModal`。

## 测试（`tools/bp-01.test.mjs` 补 · 连真库）
在第 1 期 10 用例基础上补 7 用例（共 17，全绿）：
- AC-9/10/11：取 AC-1 建的 3 单开发中批次 → `format=json` 断言按 kwsb/adr 分组 + 每条含 ticketId/type/title/desc/accept/ai/hospitals/siteVersion/media；`format=md` 断言 `Content-Type text/markdown` + `Content-Disposition attachment` + 一级标题 + 子系统中文分节 + 描述/验收段；不带 format 默认 md 下载。
- AC-12：`batch-release {pkgVersion:'2.7.x',...}` → 批次 `status='可下载'` + `pushed=3`；**直连 `data/batches.json`** 断言 pkgVersion/artifactUrl/releaseNote/releaseTime/release 留痕落文件；**直连库 `SELECT data`** 断言 3 单 `lifecycle=已出包` + `resolution.fixedVersion='2.7.x'` + 系统发包 history 留痕。
- AC-14：已「可下载」再 release → `ok:false` + pkgVersion 不被覆盖。
- AC-15：缺 pkgVersion 或 artifactUrl → 400、批次态不变。
- AC-16/17/18：3 单在已出包 → deliver-check `ok:false`+pending=全部、批次仍可下载（AC-18 不回退）；关 2 单仍 `ok:false`+pending 剩 1；关第 3 单 → `ok:true`+`delivered:true`+批次`已交付`（直连文件断言 status/deliveredAt/deliver 留痕）+ `status=已交付` 可筛。
- 鉴权：非 admin(impl 登录态) 调六端点（arrange/batches/detail/checklist/release/deliver-check）均 **403**。
- 前端静态：详情抽屉含 导清单(md/json)/上传包表单(relPkgVersion/relArtifactUrl/relNote)/doRelease/包信息/状态分支。

回归：`node --test --test-concurrency=1 tools/bp-01.test.mjs tools/tk-01.test.mjs tools/ui-shell.test.mjs` = 60 tests / 57 pass / 3 skip（ui-shell 未设 BASE 的连真库项主动跳过）/ 0 fail——确认工单流转 tk-01 未坏、shell 未坏。真库无 `bp01smoke-*` 残留、无 `batches` 表、intakes 列数仍 20、`data/batches.json` 测后整删。
另做**手动连真库 E2E 冒烟**（隔离产品 `bpdemo-x4`，测后清理）：导清单 md 头 `text/markdown`+`attachment; filename*=...开发清单-B-01.md`、正文按「## 库房设备（1 单）」分节含描述/验收/涉及医院/现场版本；上传包 → 批次可下载 + 工单 `lifecycle=已出包`+`fixedVersion=v2.7.0`；deliver-check 未闭→`pending`、关闭后→`已交付`。全清理无残留。

## 验证
- `server.mjs` `node --check` 过、改动区（L1018-1150）隐形字符 0；`batches.html` 隐形字符 0 / 不自写 page-content（=0）/ 内联 `new Function` 过 / 时间 `yyyy-MM-dd HH:mm`。
- **未碰** `field.html` / `customers.html` / `inbox.html` / `shell.js` / 其他已改逻辑；第 1 期实现（loadBatches/saveBatches/batch-arrange/batches/batch-detail、batches.json 结构、e.batch 回链、kbSubLabel）复用未推翻。

## 风险
- **NH-5 跳态选型 A**（直接置已出包，不走开发中）为实现裁决，若人验收更倾向「两跳留完整轨迹」则改走 `intake-transition` 连跳（本期已择一并留痕，可回退）。
- 截图 URL 拼 host 依赖 `req.headers.host`；反代场景若 host 被改写，导出 md 里的图链需按实际外网域名调整（相对路径始终同源可访问，兜底安全）。
