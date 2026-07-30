# CHG-BP-01-第1期·批次数据模型 + 定档建批 + 批次管理页

- 日期：2026-07-24
- 分类：**新特性落地（第 1 期 · spec BP-01 已 ready）**——按 BP-01 §附录·分期第 1 步实现「数据模型 + 运营定档建批 + 列表/详情」。spec 本体（AC / 契约）未变，仅在 §0 后新增「🚧 实现进度」标注（哪些 AC 本期覆盖、哪些留后续期 + 实现口径字段名微调留痕）→ 该标注算「涉及 spec」，附本 CHG 可审留痕走验收门。
- 触发：用户 2026-07-24「开干」，spec `docs/specs/BP-01-批次与发包.md` 已 ready；本次只做第 1 期，后续期（导清单 / 上传包 / 逐单验证 / 闭环 / FS-05 现场端）另做。

## 覆盖 AC（第 1 期）
AC-1 / AC-2 / AC-3 / AC-4 / AC-5 / AC-7 / AC-8——定档建批（跨院合并·按子系统分组·只收已立项非 consult）/ 无可归批不建空批 / 同产品先后多批 / 详情按子系统分组 + 覆盖医院去重 / 列表筛选倒序 + ticketCount / 回链 `data.batch` 双向 / 已归批不重复归入。

## 改动

### 1) 后端 `server.mjs`
- **批次存储**（文件存 `data/batches.json`，NH-4 裁决 A=文件存不改库；与 `loadCustomers/saveCustomers` 同范式）：新增 `loadBatches()`/`saveBatches(list)`/`batchGenId(list)`（编号 `B-<seq>`，读现存最大 seq +1、两位补零）。
- **3 端点**（均 admin：**未进 `authGate` 的 `FIELD_OK`/`LINK_OK` 白名单 → 非 admin 自动 401/403**，无需页内再判权；也未进 `originGate` field 域集，后台域可达）：
  - `POST /api/batch-arrange {product}`：扫该产品 `CACHE.intakes[product]` 全部工单，收 `deriveLifecycle==='已立项'（已落实）且 e.batch 空（未归批）且 type!=='consult'` 的（跨全部医院不按 site 过滤）→ 建批 `{id:B-xx, product, status:'开发中', ticketIds, createdAt:nowStamp(), pkgVersion:'', releaseNote:'', releaseTime:'', artifactUrl:'', downloads:0, history:[{action:'arrange'...}]}` 落 `batches.json` → 给这些工单 `e.batch=批次id`+`saveIntake`（穿透 MySQL `data JSON`、**不加库列**，复用 L1305 `to='已立项'时写 e.batch` 范式）→ 返回 `{ok,item}`；无可归批 → `{ok:false,error:'该产品当前没有已落实待分批的工单'}`（不建空批）。
  - `GET /api/batches?product=&status=`：`{items:[...]}`，每条挂派生 `ticketCount=ticketIds.length` + 冗余 `productName`（读时派生不落存），按 `createdAt` 倒序。
  - `GET /api/batch-detail?id=`：`{item, groups:[{subsystem, subsystemLabel(中文desc via kbSubLabel), tickets:[{id,type,title,site,version,module}]}], hospitals:[覆盖医院去重]}`——工单按 `subsystem` 分组、中文 desc 用 `kbSubLabel(product, sub)`（=`projById(product).subsystems[].desc`，同实施端/inbox 口径），覆盖医院=各单 `site` 去重。

### 2) 前端
- 新增 `public/batches.html`（运营端批次页）：`data-shell="admin" data-nav="batches" data-content-layout="list"` + 引 theme.css/ui.js/shell.js，**不自写 `.page-content`**（shell 自动包）；顶部工具条产品/状态筛选（选择即查）+「定档建批」按钮（选产品 modal → `batch-arrange`）；批次卡列表（批次号/产品/状态徽标/工单数/定档时间 `yyyy-MM-dd HH:mm` via 共享 `fmtTime`）+ 空态；批次详情抽屉（自写 `.drawer.open`/`.modal.open` 开关，theme.css 有；产品/状态/覆盖医院/按子系统分组列覆盖工单）。复用 ui.js `.select` 增强（读值按 id 命中原生 select）+ 自建 toast。
- `public/assets/shell.js` NAVS 新增分组「交付 › 批次管理」→ `/batches.html`（`ti-package` 图标，放工单组后），**只加这一项、其它导航未动**。

## 实现口径微调（与 spec §5.1 字段名差异 · 留痕防漂移）
本期批次对象字段取实现值，语义与 §5.1 一致，仅命名/占位不同：
- `createdAt`（= §5.1 `arrangedAt` 语义，定档时间）；
- `pkgVersion` 初值 `""`（§5.1 写占位 `"-"`，本期空串占位，上传包期再填）；
- 落存 `downloads:0`（§5.1 标可选，本期落存供 FS-05 现场下载维护）。
未来若做上传包/迁 SQL，按此实现字段名对齐即可。已在 spec §0 后「🚧 实现进度」标注。

## 测试（`tools/bp-01.test.mjs` · 连真库）
随机高位端口 + `--test-concurrency=1` + after 精确清理（删造的工单/产品/账号 by id + DB 兜底 + **`data/batches.json` 备份还原/整删**：原本不存在则测后整删、存在则还原备份，仿 fs-02 customers.json 范式，绝不污染真 batches）。10 用例全绿：
- AC-1/AC-4：造隔离产品（子系统 kwsb=库房设备 / adr=药品不良反应）+ 3 张已立项（跨医院甲/乙、子系统 kwsb/adr）+ 1 张待处理（不收）→ arrange → 断言含 3 单、待处理不含、各单直连库 `SELECT data` 解析 `data.batch=批次id`；detail 按 kwsb/adr 分组显中文 desc、覆盖医院去重 2 家、工单字段齐全。
- AC-2：无可归批 → `{ok:false}` 不建空批。
- AC-3/AC-8：追加 1 张已立项再 arrange → 新开第二批只含新单、已归批不重复；列表两批。
- AC-5：列表筛选（product/status）+ createdAt 倒序 + ticketCount/productName。
- 鉴权：非 admin(impl 登录态) 调三端点均 **403**。
- 边界：产品不存在 → 400。
- 真库结构护栏：**未新增 MySQL `batches` 表**（`SHOW TABLES LIKE 'batches'` = 0，批次文件存）、intakes 列数仍 20、`data` 为 JSON。
- 前端静态：batches.html 套壳规范 + 不自写 page-content（=0）+ 接真实端点 + fmtTime；shell.js NAVS 加了 batches 且既有导航保留。

回归：`node --test --test-concurrency=1 tools/bp-01.test.mjs tools/ui-shell.test.mjs tools/tk-01.test.mjs tools/cu-01.test.mjs tools/ui-select.test.mjs` = 94 tests / 91 pass / 3 skip（ui-shell 未设 BASE 的连真库项主动跳过）/ 0 fail——确认 shell.js 加导航未破坏既有后台页、intakes/customers 未受影响。真库无 `bp01smoke-*` 残留、`data/batches.json` 测后整删（原本不存在）。

## 验证
- `server.mjs` `node --check` 过、改动区隐形字符 0；`batches.html` 隐形字符 0 / 不自写 page-content / 内联 `new Function` 过 / 时间格式 `yyyy-MM-dd HH:mm`；`shell.js` `new Function` 过 / 隐形字符 0。
- **未碰** `field.html` / `customers.html` / `inbox.html` / 其他已改逻辑。
