# CHG · 运营端「编辑医院」保存失败（产品被清空）修复

- **日期**：2026-07-23
- **类型**：纯 bug 修复（「子系统+各自版本」特性上线后的前端读值回归）→ 例外：暴露了 AC-8b/AC-8c 一处过期表述，往 CU-01 补一条读值约束回归 AC（见文末 spec diff，待确认）
- **触发**：用户 2026-07-23 反馈——编辑医院抽屉里产品行显空「选择产品」+「先选择产品，再勾选上线子系统」，点保存无反应/失败。
- **改动文件**：`public/customers.html`（`collectProducts` + `saveCustomer`）、`tools/cu-01.test.mjs`（+3 断言/用例）。**后端 `server.mjs` 未改**（已本地起 server 复现，新形状/新形状空子系统/空产品/旧形状/空project 五种 payload 全部 `status=200 ok=true` 存成功、回读一致 → 失败在前端）。

## 复现方式
1. 起真实 server（`node server.mjs`）+ admin 登录，造一个客户（旧或新形状均可）。
2. headless Chrome（`--headless=new` + CDP）打开 `/customers.html`、注入 `intake_sess` cookie、`openEdit(客户)`。
3. 抽屉里对 `.prow` 执行 `row.querySelector('.cprod')` → 命中 `DIV.ui-sel-wrap cprod`（`'value' in el === false`，`el.value === undefined`）；`collectProducts()` 返回 `[]`；点保存后 toast 显「已更新」但提交 `products:[]`、后端把产品清空。

## 确切根因
`public/assets/ui.js` 的自定义下拉增强器 `enhanceUiSelect`（L205-215）把原 `<select>` 的**附带 class**（`.cprod`/`.cver`，见 L210-212 `extra`）复制到它生成的包裹 `<div class="ui-sel-wrap cprod/cver">` 上（本意：让页面 CSS `.cprod{flex:1.4}` 作用到外层），并把该 wrapper **插在原生 select 之前**（`insertBefore(wrap, sel)` 后 `wrap.appendChild(sel)`）。

于是 `.prow` 内 `r.querySelector('.cprod')` 按文档预序**先命中 wrapper `<div>`**（不是原生 `<select>`）。`<div>` 无 `.value`（`undefined`）→ `collectProducts` 里 `const pid = <div>.value = undefined` → `if(!pid) return` → **每个产品卡都被跳过 → 返回 `[]`**。子系统 `.cver` 同理命中 wrapper `<div>`。结果保存把客户产品全清空，用户看到「保存失败/没反应」（其实是产品被清了）。

- 为何是本次特性引入才爆：`.cver` 由自由文本 `<input>` 改为 `<select class="select cver">`（2026-07-23），且新增子系统行结构；`collectProducts` 从裸 `.cprod`/`.cver` 读值 —— 在 ui.js 增强下同名 class 被复制到 wrapper，裸类选择器于是先命中 DIV。
- 注：本次场景 `collectProducts` 未抛异常（`if(!pid)` 提前 return，没走到 `.cver.value`）；但为防其它 DOM 缺失路径抛出后静默失败，一并加固（见下）。

## 数据丢失事故（已恢复）
线上「安吉县人民医院」（旧形状 `{project:'hlyy', version:''}`）的产品**被本 bug 清空成 `products:[]`**（已从备份紧急恢复）。发生链路：编辑安吉 → `collectProducts` 因命中 wrapper DIV 读到 `pid=undefined` → 逐行跳过 → 返回 `[]` → 保存把已关联产品清空。

**根因归属澄清（headless 实测双向对照）**：协调者曾疑「`openEdit` 旧形状回填 bug（产品行显空）」。实测**回填本身无 bug**——修复前/后对安吉确切形状 `{project:'hlyy', version:''}` 的 `openEdit` 回填**都正确**：`select.cprod.value=hlyy`（选中「合理用药」）、wrapper 触发器显「合理用药」、子系统清单渲染 `audit:true`。差异**只在** `collectProducts`：修复前返回 `[]`、修复后返回 `[{project:hlyy,subsystems:[{name:audit,version:''}]}]`。用户看到的「空选择产品」是**事故后果**（客户已被清空成 `products:[]`，再打开自然无产品可回填），不是回填逻辑 bug。故根因单一 = `collectProducts` 读值命中 wrapper DIV。

## 修复（前端 4 处，均在 customers.html）
1. **根因**：`collectProducts` 读值改用 `r.querySelector('select.cprod')` / `sr.querySelector('select.cver')`（明确选原生 `<select>`），绕开 ui.js 复制了同名 class 的 wrapper `<div>`。
2. **健壮性**：`querySelector` 结果判空——缺 `select.cprod` → pid 视为空跳过；缺 `select.cver` → version 兜底空串。缺元素跳过而非抛，`collectProducts` 恒不抛。
3. **防静默失败**：`saveCustomer` 里 `products:collectProducts()` 挪进 `try{}` 块内。任何前端收集异常都被 `catch(e)` → `toast('保存失败：'+e.message,'error')` 可见 + `finally` 恢复按钮。此条无论根因是什么都做（防再次静默失败）。
4. **防清空护栏（数据保护 · 最后防线）**：`saveCustomer` 里，**编辑已有客户**（`editId`）且 `collectProducts()` 结果为 **0 产品**（`products.length===0`）、而该客户**原本有产品**（`origCount>0`）→ `uiConfirm('该医院原有 N 个关联产品，本次保存将清空为「无关联产品」，确定继续？',{danger,okText:'仍要清空'})` 二次确认，取消则 `return` 中止（不提交）。**新增客户 / 原本无产品的编辑不拦**。护栏判断在 `fetch` 之前。即便未来再有收集/误删 bug，编辑客户清空前也必弹确认 → 不再静默清空。
   - 注意语义：「保留产品行但取消所有子系统勾选」→ `collectProducts` 是 `[{project, subsystems:[]}]`（`length===1`，非 0），按 AC-19「无勾选子系统的产品保留、实施端兜底显全部」是**合法**的，护栏**不拦**（用户明确保留了该产品）。护栏只拦「产品数从 N 掉到 0」的整体清空。

- **未改回填**：`openEdit` 回填是命令式写原生 select/checkbox 的值，不受 wrapper 影响；headless 实测旧形状（含空 version）回填正确。
- **未改后端/存储**：`normCustomer`/`normProduct` 未动，产品新旧形状原样存读。

## 端到端验证（headless Chrome 真点保存 + 后端回读）
| 场景 | collectProducts | toast | 后端回读 products |
|---|---|---|---|
| 新建带子系统+版本 | `[{project:hlyy,subsystems:[{name:audit,version:v9.9}]}]` | 医院已新增 | 一致 |
| 编辑旧形状客户升级 | `[{project:hlyy,subsystems:[{name:audit,version:v2.0}]}]`（回填 cprod=hlyy、audit 勾选） | 医院信息已更新 | 无损升级成功 |
| 空产品行 | `[]` | 医院已新增 | `[]` |

修复前对照（同 headless）：`r.querySelector('.cprod')` → `DIV.ui-sel-wrap cprod val=undefined`；`collectProducts()` → `[]`。

**防清空护栏端到端（headless · stub uiConfirm）**：
| 场景 | 结果 |
|---|---|
| 编辑有产品客户 → 删产品行（`collectProducts=[]`）→ 保存 | 弹护栏「原有 1 个关联产品…确定继续？」；取消 → **未发 save 请求**；后端产品 `[{project:hlyy,version:v2.0}]` **未清空** |
| 同上 → 确认「仍要清空」 | 提交 `products:[]`、toast「已更新」（用户明确要清空才生效） |
| 正常编辑（保留勾选，`collectProducts` 非空） | 护栏**未弹**、直接存、后端一致 |

## 测试点（tools/cu-01.test.mjs）
- `[静态·防回归]`：`collectProducts` 必须用 `select.cprod`/`select.cver`（`doesNotMatch` 裸 `.cprod`/`.cver`）。
- `[静态·防清空护栏]`：编辑态 `editId && products.length===0 && origCount>0` → `uiConfirm` 二次确认 + `if(!ok) return`，护栏在 `fetch` 之前。
- `[静态·防静默失败]`：`saveCustomer` 中 `collectProducts()` 在 `try{` 之后（try 块内）+ catch 显式 `toast('保存失败：'+e.message)`。
- `[逻辑桩·防回归]`：vm 提取真身 `collectProducts` + 最小 DOM 桩**还原 ui.js 增强后结构**（wrapper DIV 带同名 class、排在 select 前）→ 断言正确收集不清空、缺元素不抛。回退成裸 `.cprod`/`.cver` 该用例即变红（已验证是真测试）。
- 连真库 customer-save 冒烟保持绿（后端未改）。cu-01 21/21；回归 cu-01/fs-02/fs-03/ui-select 84/84。customers.json 本地不存在态精确还原、无残留。

## spec diff（待确认 · 涉及 AC-8b/AC-8c 读值表述）
AC-8b 第「存储/回读不变」句现写「`collectProducts` 仍读 `.cver.value`」——在 ui.js 自定义下拉增强下**该表述会误导**（裸 `.cver` 命中 wrapper DIV）。建议改为：

> **读值须用 `select.cprod`/`select.cver`（原生 select）**：ui.js 自定义下拉增强器会把原 select 的附带 class（`.cprod`/`.cver`）复制到它生成的 `<div class="ui-sel-wrap …">` 上且排在 select 前；`collectProducts` 必须用 `select.cprod`/`select.cver` 读原生 `<select>` 的 `.value`，绕开 wrapper `<div>`（裸类选择器会先命中无 `.value` 的 DIV → pid/version 落空 → 产品被清空，2026-07-23 回归）。收集结果判空、缺元素跳过不抛；`saveCustomer` 中 `collectProducts()` 须在 `try` 块内调用，异常经 catch 显 toast、不静默。

## 风险
- 仅改前端读值选择器 + 加固，不改存储/后端/回填逻辑，兼容新旧形状不变。
- 其它页面若也把 ui.js 增强的 select 用**裸类选择器**读值，存在同类风险（本次只审 customers.html；lessons 已加通用自检项）。
