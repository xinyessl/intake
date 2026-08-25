# CHG · 实施端单子系统产品「系统」显示产品名

- 日期：2026-08-25
- 分类（§4.5）：**逻辑/行为调整（显示层）** —— 轻量，暂记 CHG；如需固化进 spec，可往 FS-03 补一条 AC（见文末）。
- 关联 spec：FS-03（实施端系统视图 / 子项目下拉）；触发场景：贴 Gitee/GitLab 单仓建产品。

## 背景
贴 Gitee 单仓建的产品只有 1 个子系统，子系统英文 `name` = 仓 `full_name`（如 `xinye666/wzh2.0`）、`desc` 常空。实施端「系统」到处（子项目下拉触发器/下拉项、系统视图触发器/下拉/标题、「系统：」归档条、工单元信息）显示这个丑名，即便运营端已把**产品**名设为「病案归档系统」。

## 决策（2026-08-25 用户拍板）
**单子系统的产品，实施端「系统」显示一律用产品名**（尊重运营端设的产品名；GitLab/Gitee 单仓都适用）。多子系统产品不变，仍按各子系统 `desc || name` 显示。

## 改动（仅 `public/field.html`，纯显示层）
- `subLabel(nm)`（医院视图）：命中的产品组 `subs.length === 1` → 返 `g.product`（产品名）；否则 `desc || name`。
- `sysLabel(nm)`（系统视图）：`state.systems` 中同 `project` 条数 `=== 1` → 返 `s.productName`；否则 `desc || name`。
- `renderProdDD` / `renderSysList`（两个下拉列表）：选项 label 改走 `subLabel`/`sysLabel`；单子系统产品**省掉冗余 `.grp` 组头**（组头=产品名、唯一 opt 又=产品名，重复）。

## 铁律：只改显示，不动匹配键
`curSub`/`curSys`/`data-sub`/`data-sys`/`selectSub(nm)`/`&system=` 传的全是**英文 name**（过滤 intakes、查版本的键），一字未动。测试用 DOM 桩采集 `data-sub` 证键不变。

## 验证
- 逻辑测试 `tools/field-single-sub-label.logic.test.mjs`（抽真身 subLabel/sysLabel/renderProdDD 沙箱跑）15/15 绿：单子系统→产品名（即便有 desc 也优先产品名）、多子系统仍 desc||name、desc 空回退英文 name、data-sub 键不变。
- fs-02 A2b / fs-03 A2 静态 pin 断言同步更新为新内联形态（`label=subLabel(nm)` / `label=sysLabel(nm)`）。
- 真机部署 113（静态文件，scp 免重启），用户浏览器验「系统：病案归档系统」。

> 备注：本分支 fs-02/fs-03 另有若干**既有**静态断言/连真库失败（基线 880643c 即红，非本次引入；已对比失败集完全一致）——属分支分叉遗留，另行处理，不阻塞本次。

## 如需固化进 spec（可选）
FS-03 补一条 AC：「产品仅含 1 个子系统时，实施端系统标签（子项目下拉/系统视图/归档条/工单元信息）显示**产品名**，而非子系统的 Git 派生名；多子系统按各子系统中文名。匹配键仍用子系统英文 name。」
