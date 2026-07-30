# CHG · CU-01 · 医院管理加「系统」(产品)筛选

> 日期：2026-07-30　类型：小特性　来源：用户反馈
> 页面：public/customers.html 医院管理筛选条

## 需求
医院管理列表筛选条只有 负责实施/等级/状态/关键词，需加一个**「系统」(产品级)筛选**——按医院上线的产品筛（药师工作站/合理用药…），**产品级、不到子系统**。

## 改动（public/customers.html，5 处）
- 筛选条加 `#fProduct`「系统」下拉（栅格改 5 列）。
- `initRegionOptions` 填充选项：各医院 `products[].project` 去重 → `pname()` 取产品名，按中文名排序（value=产品 id）。
- `collectFilters` 加 `product`；`getFiltered` 加 `(!f.product || c.products.some(p=>p.project===f.product))`。
- `fProduct` 加入即选即查绑定（change→重筛+回第 1 页）。

## 部署
本次仅本地 + GitHub；生产 SSH 已失效（root 密码轮换），未 rsync 上线，待恢复访问后部署。
