# CHG · FS-03 · 系统视图提交清单分组头显中文（不再显英文子系统 key）

> 日期：2026-07-30　类型：纯 bug 修复（不涉 spec，行为本应如此）　来源：用户现场标注截图
> 关联 spec：FS-03（系统视图 · 跨医院聚合）

## 现象
实施端「系统视图」提交清单按子系统分组，组头显示的是**英文子系统名**（`pwrs`/`ysmz`/`audit`/`其他`），而非中文（药师工作站/药学门诊/审方/…）。与运营端收件箱、批次视图、经验库、以及本页下拉/提示条的「显中文」口径不一致。

## 根因
`server.mjs` `/api/field/submissions` 的 `dimension=sys` 分组处（约 L1829）把组 `label` 写死成原始子系统名 `s`：
```js
const groups = order.map(s => ({ key: s, label: s, count: ..., items: ... }));
```
`intakes.subsystem` 存的是子系统**英文 name**（git 导入时 = GitLab 项目 name，如 `audit`），中文在 `subsystems[].desc`。前端 `field.html` `mkSysGroup` 本就渲染 `g.label`，但后端给的 `label===key` → 显英文。

## 修复
`server.mjs` L1829：组 `label` 改走既有 `kbSubLabel(projId, subName)`（= `projById(product).subsystems[].desc`，与 inbox/批次/KB 完全同口径，见 lessons「子系统显中文一律复用 kbSubLabel、不要另写映射」）。product 取该组首条工单的 `project`；空子系统组保留「其他」。
```js
const groups = order.map(s => { const items = map.get(s); const proj = (items[0]&&items[0].project)||'';
  const label = (s === '其他') ? '其他' : (proj ? kbSubLabel(proj, s) : s);
  return { key: s, label, count: items.length, items }; });
```

## 验证（线上 http://intake.lcpharmacy.cn）
admin 登录打 `/api/field/submissions?dimension=sys` → `pwrs→药师工作站`、`ysmz→药学门诊`、`audit→审方`、`其他→其他`。前端组头随之显中文。

## 部署
rsync `server.mjs` → `/opt/intake` + `docker restart intake-app`（后端改动需重启）；已验证生效。

## 未涉及
不改库/不改前端（前端本就读 `g.label`）；不涉 spec（FS-03 意图即显中文，本为实现遗漏）。仅 `server.mjs` 一处 + 本 CHG。
