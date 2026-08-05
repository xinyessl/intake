# CHG-FS-02 · 现场提交记录「软删除」

- **日期**：2026-08-05
- **触发**：用户需求——给现场端（field）提交清单的记录加「删除」功能（软删除、部分记录禁删、权限收敛、留痕、app 风格确认）。
- **分类**：逻辑/行为调整（新增删除行为 + 新端点 + 新字段）→ **涉及 spec**，需同步 FS-02（新增删除 AC + 端点契约 + 出参 `deletable`/`convertedTo`）。此 CHG 仅作交付留痕，**spec diff 才是审阅对象**（见交付说明附的 FS-02 diff，人过验收门后再合并 + 置 accepted）。

## 需求（已和人敲定）
1. **软删除**：不真删库/磁盘，只打 `e.deleted=true`（+`deletedAt`/`deletedBy`）随 `data` JSON 落库；列表不再显示，media/history 全保留。
2. **可删范围**：咨询/需求/BUG 都可删；**但**已转工单的咨询（`convertedTo` 有值）、已归批的需求/BUG（`batch` 有值）禁删（防破坏在办流程）。
3. **权限收敛**：现场账号只能删自己名下 sites 的记录（越权拒），管理员不限。
4. **留痕**：删除写进该记录 `history[]`（谁/何时/删除）。
5. **确认弹窗**：app 风格确认框（非浏览器原生 confirm）；删成功从清单移除；若删的正是右侧当前会话则清空右侧对话区。

## 改动
### 后端 `server.mjs`
- `listIntake` 首行 `Object.values(m).filter(e => !e.deleted)`——软删记录不再出现在任何 listIntake 消费点（intake-list / field-submissions / aggregate / export / todo / 项目计数 / admin 收件箱计数）。
- `listIntake` 输出对象补 `convertedTo`（供 mapItem 判 deletable，否则读到 undefined）。
- `batch-arrange` 归批扫描（`Object.values(store)` 直扫，不走 listIntake）加 `if (e.deleted) continue;`——软删记录永不被扫进新批次。
- 新纯函数 `intakeDeleteGuard(e, user)`（无 I/O，供端点 + 逻辑测试共用）：守卫顺序 不存在→`not_found`、已删→`gone`(幂等)、已转工单→`converted`、已归批→`batched`、现场账号越权 site→`forbidden`；管理员放行。
- 新端点 `POST /api/intake-delete {project, id}`：`loadIntake` → `intakeDeleteGuard` → 通过则置 `e.deleted/deletedAt/deletedBy` + `history.push({to:'已删除',note:'删除',by,byRole,at})` + `saveIntake`（复用双写，不加库列、不真删）。`gone` 返 `{ok:true,alreadyDeleted:true}` 幂等；`not_found`→404、`forbidden`→403、其余禁删→400 带原因文案。
- `field/submissions` 的 `mapItem` 返回体加 `deletable`(=`!conv && !bid`) + `convertedTo`（hosp/sys 两维度复用同一 mapItem，一处即覆盖两视图）。
- reopen/续聊连带堵死：`intake-detail` 命中 `e.deleted`→404（不可 reopen）；`consult-to-intake` 守卫加 `src.deleted`；`consult` 续聊 `prev` 判定加 `!store[convId].deleted`（软删 consult 不复活续聊）。
- 白名单：`/api/intake-delete` 加进 `FIELD_OK` + `FS08_FIELD_API` 两个 Set（漏一个→实施域 originGate deny，见 lessons/L-090）。

### 前端 `public/field.html`
- 新增 `fConfirm(opts)`：app 风格「是/否」确认框，复用共享遮罩 `#fModalMask` 但清空 `#fmBody`（无输入框，别调 `fPrompt`），支持 `okText`/`danger`（红色确认按钮）；cleanup 复位按钮文案/`btn-danger` 类，避免与 fPrompt 争同遮罩。
- 新增 `doDeleteItem(it, cardEl)`：`fConfirm` → `POST /api/intake-delete` → 成功 toast + 从 DOM 移卡 + `refreshLeftList()`，若删的是当前会话（`chat.convId===it.id||chat.savedId===it.id`）则 `newConversation()` 清右侧；失败 toast 显后端 error 文案（禁删原因）。
- 新增 `bindDelete(el, it)`：仅 `it.deletable` 时挂右上角 `.f-item-del` ✕ 按钮（`ti-trash`），点击 `stopPropagation` 不触发 reopen。`mkItem`（医院视图）+ `mkSysItem`（系统视图）**两处都调**（同 L-026 一函数杜绝漏系统视图）。
- CSS：`.f-item-hasdel`（relative + 顶行留位）、`.f-item-del`（右上角 hover 转 danger 色，用 theme 的 `--color-danger*` token）。
- `window.__field` 注册 `fConfirm`/`doDeleteItem`/`bindDelete`。

### 测试 `tools/fs-02-delete.logic.test.mjs`（新增·脱库逻辑测试，17/17 绿）
- 本地 MySQL down（ECONNREFUSED 3306）+ server.mjs 启动即 `db.init()` 失败 exit → 从源码抽 `intakeDeleteGuard` 沙箱 eval 测真实函数；源码级断言 listIntake 过滤 / batch-arrange 跳过 / mapItem deletable / intake-detail 404 / consult-to-intake 守卫 / 白名单双 Set / 端点软删+留痕。
- **prod 连真库冒烟**（`intake.lcpharmacy.cn` / 容器 `intake-app`）：seed 隔离产品+账号(scrypt 密码)+5 条记录 → restart 载缓存 → HTTP 登录 → 删咨询成功/列表消失/detail 404、已归批/已转工单/越权分别 400/400/403、幂等再删 ok、DB 行仍在且 `deleted=true`+history 留痕 → clean + restart + 清 intake-store 导出目录。关键返回见交付说明。

## spec 同步
- FS-02 新增删除 AC（详见交付说明的 spec diff）：软删除 + 已转工单/已归批禁删 + 仅本人 sites + 留痕 + app 风格确认；§4 端点表加 `POST /api/intake-delete`；`field/submissions` 出参补 `deletable`/`convertedTo`。**本次未合并 spec、未改 status**，待人验收后合并。
