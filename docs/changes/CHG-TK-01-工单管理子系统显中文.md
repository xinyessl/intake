# CHG-TK-01-工单管理子系统显中文

- 日期：2026-07-24
- 分类：**显示补全（bug 修复）**——运营端工单管理页子系统显英文 name，应显产品定义的中文 `desc`；spec 意图本就是给运营看有意义的子系统名，此前实现漏了这层映射。伴随 TK-01 §5.4 措辞澄清（把「过滤按值匹配」补成「显中文 desc / 值·筛选·存值用英文 name」的双键约定），保持 spec 准确，非行为变更 → 该措辞澄清算「涉及 spec」，附可审 diff 走验收门。
- 触发：用户 2026-07-24 反馈——运营端「工单管理」`public/inbox.html` 子系统下拉/列表显 `kwsb/adr/ysmz/pwrs` 等英文，要显中文（如 `kwsb→抗网上报`、`adr→adr预警上报`、`ysmz→药学门诊`、`pwrs→药师工作站`）。

## 现象
`public/inbox.html` 子系统数据源 = `curProjectObj.subsystems`（产品定义 `[{key,name,desc,...}]`，`desc` 是中文），但渲染统一用了英文 `name`：筛选下拉（value/显示都英文）、列表「子系统」列、代提抽屉子系统下拉、处理/查看抽屉「产品·子系统」明细——全显英文。与实施端 `field.html`（FS-07 已改为 `subLabel` 显中文 desc）不一致。

## 根因
渲染层直接输出英文 `subsystem`（`s.name||s.key` / `i.subsystem` / `t.subsystem` / `e.subsystem`），未经中文 desc 映射。数据其实已带中文 `desc`（`/api/projects` 回带产品 `subsystems` 完整对象），只是前端没查。

## 改动（纯前端，仅 public/inbox.html）
新增 helper `subLabel(name)`：从 `curProjectObj.subsystems` 按 `name`（回退 `key`）查 → 返回 `desc||name||name`；**查不到回退原 name**（工单里出现但产品未定义的子系统）。curProjectObj 随当前产品实时变，helper 每次实时查。改 6 处显示（值/筛选/存值一律不动，仍英文 name）：
1. 子系统筛选下拉：`<option value="${esc(s)}">${esc(subLabel(s))}</option>`——value 仍英文 name（匹配 `intakes.subsystem`），显示中文。「全部子系统」不变。
2. 列表「子系统」列：`esc(subLabel(i.subsystem))`（空仍「—」）。
3. 代提抽屉子系统下拉：`o.value=s.name||s.key`（不变）、`o.textContent=s.desc||s.name||s.key`（中文）。
4. 处理决策抽屉「产品·子系统」明细：`subLabel(t.subsystem)`。
5. 查看抽屉「产品·子系统」明细：`subLabel(e.subsystem)`。
6.（helper 本体）

**未改任何取值**：`f.sub=$('#fSub').value`（英文 name）、`i.subsystem!==f.sub` 列表过滤、归并过滤、`subsystem:$('#ctSub').value` 代提提交——全按英文 name 不动（改成 desc 会筛不出数据/存错值）。ui.js 增强的 `select.select#fSub` 动态填 options 后自动重同步（只改 textContent，重同步照常）。

## 测试
- `tools/tk-01.test.mjs` 新增静态断言组「子系统显中文」：`subLabel` helper 存在（查 `curProjectObj.subsystems`、`desc||`、回退 name）；筛选下拉 value=name/显示 subLabel；列表列 `subLabel(i.subsystem)`；代提下拉 value=name/显 desc；处理·查看明细 `subLabel(t/e.subsystem)`；筛选/提交仍取 `.value`（英文 name）+ `i.subsystem!==f.sub` 匹配 `intakes.subsystem`。不破坏既有流转/筛选断言（筛选值仍英文 name）。
- 回归 + 连真库冒烟：`node --test --test-concurrency=1 tools/tk-01.test.mjs tools/ui-select.test.mjs tools/wb-01.test.mjs` = 59/59 绿（含 tk-01 连真库冒烟：intakes.subsystem 列映射 + overview 交叉核对）。本次 `tk01smoke-*` 隔离产品 after 已清、真库无本次残留（既存 `kbsmoke-*/smoke-*` 孤儿为历史遗留、非本次、未触碰）。

## 验证
- inbox.html：隐形字符 0；不自写 `page-content`（`grep -c 'class="page-content'`=0）；`data-content-layout="list"` 不动；内联 `<script>` `new Function` 语法过。

## 未碰
`server.mjs`（数据已带中文 desc，无需动）、`assets/ui.js`、其他所有页面、已改好的工单流转/状态机/consult/reopen/子项目下拉等逻辑，均未触碰。纯 inbox.html 显示层 + 测试 + CHG/spec/lessons。

## 风险
低。仅改显示层文本，所有筛选/提交/查询值仍为英文 name（与 `intakes.subsystem` 一致）；查不到 desc 回退原 name，不会因缺目录报错或丢数据。与实施端 FS-07「value=name / display=desc」双键约定一致。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
