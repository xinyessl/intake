# CHG · 发布闭环最后一环 · 现场验证通过后医院现场版本更到新包版本（pkgVersion）

> 日期：2026-08-07　类型：**逻辑/行为新增（涉 spec）**——补齐发布闭环的版本回写自动化（原缺失）　来源：用户反馈
> 关联：仅改 `server.mjs`（不碰 `field.html`）；起草 BP-01 / FS-05 spec diff 附交付**未合并**（待人评审）。
> 涉 spec：BP-01（批次闭环 §F）、FS-05（现场验证 §D/§G）各补一条「验证通过→医院版本更到 pkgVersion」AC。

## 现象（用户反馈）
走完发布流程（定档建批 → 出包 `batch-release` 设 `bt.pkgVersion` → 现场下载 → 逐单验证通过 → 工单`已关闭`、批次`已交付`）后，**现场医院的版本号还是老的**——`data/customers.json` 里该医院该产品/子系统版本没有跟着新包版本更新。期望：验证通过（该医院这批单全过）就把对应医院版本按 `batch.pkgVersion` 更新。

## 根因
- 出包 `batch-release`（L1695+）只设 `bt.pkgVersion` + 把覆盖工单推到`已出包`，**不动 customers 版本**。
- 现场验证 `intake-verify` pass（L2135+）只把工单转`已关闭` + 联动批次`已交付`，**不动 customers 版本**。
- 现场版本回写的现成逻辑只在 `customer-version`（L1900+·用户手点「一键改版本」）里；**发布闭环从未自动调它** → 验证过但版本停在老值。

## 改动（仅 `server.mjs`）
1. **新增纯函数 `bumpCustomerVersion(cust, productId, subsystem, newVer)`**（L226 附近，`custProductVersion` 之后）：原地把该客户该产品该子系统版本写成 `newVer`。两形状（与 `custSubVersion`/`customer-version` 一致）：新形状写 `products[].subsystems[name==sub].version`（子系统未登记则**跳过不新增**，避免臆造）；旧形状写 `pr.version`（忽略 sub）。**subsystem 空 = 整包升级**（新形状所有已登记子系统都更 / 旧形状产品级）。幂等（同值不写）；找不到产品/子系统跳过不报错；30 位截断（对齐 `customer-version`）。返回 `{changed, bumped:[{subsystem,fromVer,toVer}]}`。**纯函数不落盘。**
2. **新增编排函数 `bumpSiteVersionForBatch(bt, proj, site)`**（`saveBatches` 之后）：某批次某医院的**全部覆盖工单都`已关闭`**时，把该医院该产品版本更到 `bt.pkgVersion`——**只更这批次实际覆盖到该 site 的子系统集合**（`bt.ticketIds` 里属该 site 的工单 `subsystem` 去重；无标注→整产品），覆盖不到的子系统不动。护栏：无 pkgVersion（`''`/`-`）不更；该 site 未全关闭不更；台账无该医院跳过；幂等（`bumpCustomerVersion` 内部同值不写）。changed 才 `saveCustomers` + 记 `c.versionLog[]`（`by:'系统·发布闭环'`、`batch:bt.id`、`fromVer→toVer`）。
3. **`intake-verify` pass 分支（per-hospital·主触发）**：pass 后若 `e.batch` 存在，对 `e.site` 调 `bumpSiteVersionForBatch`；bumped 则在批次 `history` 记 `site-version`。响应新增 `versionBumped`。
4. **`batch-deliver-check`（兜底）**：批次转`已交付`（全医院全单验过）时，对该批次覆盖的**每个医院**调 `bumpSiteVersionForBatch`；覆盖 per-hospital 没触发到的情况；批次 `history` 记 `site-version`；已是`已交付`但版本此前漏更也补更（`（补更）`）。响应新增 `versionBumped`。

## 护栏/幂等
- 无 pkgVersion → 不更；医院/产品/子系统台账找不到 → 跳过不报错；已是目标版本 → 不重复写、不重复留痕。
- 只回写「该单 site 对应医院」，不碰别家（这是验证 pass 的系统联动，非用户直接改版本）。
- 只更**本批次实际覆盖到的子系统**（宁少勿错），覆盖不到的子系统不动。

## 冒烟（连 prod · 用户已走完发布流程）
- 现网现成：批次 `B-01`（product=hlyy、pkgVersion=`2.8.260801-1`、status=已交付），覆盖工单 `XQ-20260807-03`（site=安吉县人民医院·subsystem=pkb·已关闭）。**BEFORE**：`安吉县人民医院/hlyy/pkb=2.7.260723-1`（老），versionLog 空。
- 部署新 `server.mjs` + `docker restart intake-app`，admin 会话 `POST /api/batch-deliver-check {id:"B-01"}` →
  - 返回 `versionBumped:[{site:"安吉县人民医院",bumped:[{subsystem:"pkb",fromVer:"2.7.260723-1",toVer:"2.8.260801-1"}]}]`。
  - **AFTER**：`pkb=2.8.260801-1`（新）；audit/report/intervene/review 仍 `2.7.260723-1`（本批未覆盖·不动）；`versionLog` 1 条（`by:系统·发布闭环`、`batch:B-01`）；批次 `history` +1 条 `site-version`。
- **幂等**：再调一次 → `versionBumped:[]`、versionLog 仍 1 条、无重复。
- 脱库逻辑测试 `tools/publish-version-bump.logic.test.mjs` 14 例全绿（抽 server.mjs 真身函数沙箱 eval，非重写副本）：新/旧形状写版本、subsystem 空=整产品、幂等、找不到跳过、per-hospital 全关闭判定、只更本批覆盖子系统、台账无医院跳过、留痕。

## 部署
scp `server.mjs` → prod `/opt/intake/server.mjs`（`/opt/intake`→`/app`）+ `docker restart intake-app`（server 读缓存/文件，改代码需重启）。已在 prod 完成并冒烟通过。
