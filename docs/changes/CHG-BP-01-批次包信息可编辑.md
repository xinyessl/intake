# CHG · BP-01 · 批次「包信息」支持重新编辑（改错的包地址/版本/更新说明可回改）

> 日期：2026-07-30　类型：小特性（扩 batch-update）　来源：用户反馈（包地址填成"111"改不了）
> 页面：public/batches.html 批次详情「包信息」

## 现象
上传包(`batch-release`)后，批次详情「包信息」（包版本/包地址/更新说明）变**只读**，无编辑入口——包地址填错(如"111")无法修正。

## 方案（扩 batch-update，不重新发包）
- `batch-release` 仅「开发中」批次可用、且会推工单转"已出包"（有副作用），不适合改字段。
- 扩展 **`POST /api/batch-update`**（原只改排期 scheduleDate）：新增 `pkgVersion/artifactUrl/releaseNote` 偏字段更新——传了才改、纯改字段、**不重新发包、不推工单状态**，记 history（"改包信息（包版本/包地址/…）"）。校验：包版本/包地址不能清空（400）；长度 60/500/2000 截断。
- `public/batches.html` 包信息块加「编辑」按钮 → 内联表单（预填当前值）→ 保存走 batch-update（仿"改排期"内联模式）。

## 改动
- `server.mjs` `/api/batch-update`：+pkgVersion/artifactUrl/releaseNote 分支。
- `public/batches.html`：包信息只读区加 `#btnPkgEdit` + `#pkgEdit` 表单 + `savePkgInfo()`。

## 部署 / 验证
rsync server.mjs + batches.html → 线上 + `docker restart intake-app`。冒烟：`batch-update {artifactUrl:""}` → 400「包版本/包地址不能清空」（新字段已解析+校验）；当前 B-01 包地址="111"（待用户经 UI 改正）。

## spec 同步
BP-01 §4 接口：`batch-update` 入参扩 pkgVersion/artifactUrl/releaseNote（改包信息，区别于 batch-release 的发包+推单）。draft/评审并入。
