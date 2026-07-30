# CHG · FS-05 · 更新包可多次下载 + 按类型视图引导去下载

> 日期：2026-07-30　类型：交互改进　来源：用户反馈（实施端）
> 页面：public/field.html（实施端按批次/按类型视图）

## 1. 更新包可多次下载
- 现象：下载后按钮锁成绿色「已下载」不可再点，无法重复下载。
- 改：`mkPkgCard` 下载按钮**总是可点**（去掉 `!downloadedByMe` 守卫），已下载态标签改「重新下载」+ 旁边加绿色「✓ 已下载」标识；`doBatchDownload` 成功后 `btn.disabled=false` 保持可点。多次点即多次开包地址（`batch-download` 幂等，不重复计数）。

## 2. 按类型视图引导「去下载」
- 现象：按类型看时，已发包(已出包/待验证)的单不知道去哪下载。
- 改：`mkItem` 对 `batchId && lifecycle∈{已出包,待验证}` 的条目加「📦 去下载更新包」链接；点击 `goToBatchDownload(batchId)` → `setGroupBy('batch')` 切到按批次视图 + 滚动/高亮到该批次更新包卡（找不到卡则 toast 提示已切换）。

## 部署 / 验证
rsync field.html → 线上（静态即时生效）；服务器确认「重新下载/goToBatchDownload/去下载更新包」已在。
