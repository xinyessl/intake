# CHG · FS-01/FS-02 · 实施端医院下拉支持拖拽调整顺序（常用/在实施医院置顶）

> 日期：2026-07-30　类型：小特性（前端个人偏好，不改库、不动 sites 权威集）　来源：用户反馈
> 关联 spec：FS-01（外壳·医院下拉）/ FS-02（医院视图）

## 需求
实施端「医院视图」下拉里的医院列表，实施工程师希望能**拖拽调整顺序**，把自己常用或正在实施中的医院置顶；顺序要记住。

## 方案（纯前端 localStorage，不碰后端/库）
医院集合仍是**运营端分配**的 `me.sites`（硬规则「医院由运营端分配」不破）——拖拽只重排**显示顺序**，是个人偏好：
- 按账号存 `localStorage['intake_field_hosp_order_'+username]` = 医院名有序数组。
- 登录进入工作空间时 `applyHospOrder(me.sites)`：保存序里仍被分配的医院按保存序在前，新分配、没排过序的追加到末尾（**不丢医院、不擅增删**）。默认所选医院随之变为置顶那家（符合「常用置顶」预期）。
- 下拉列表每行（未搜索、且多于一家时）`draggable`，带 `ti-grip-vertical` 把手；`dragstart/dragover/drop` 重排 `state.sites` → `saveHospOrder()` → 重渲染。搜索态不可拖（过滤子集排序无意义）。

## 改动文件
- `public/field.html`：新增 `hospOrderKey/applyHospOrder/saveHospOrder/reorderHosp` + `_hospDrag`；`enterWorkspace` 套用保存顺序；`renderHospList` 行加拖拽 + 把手；CSS 加 `.f-hosp-grip/.dragging/.drag-over`。

## 约束守住
- 不改 `me.sites`（后端分配集）；不新增/删除医院；纯展示重排。跨浏览器/设备不同步（localStorage 本地）——要跨设备需后端存偏好，本期不做（可后续加账号级 preference）。

## 部署 / 验证
rsync `field.html` → 线上（静态即时生效，无需重启）；`http://intake.lcpharmacy.cn` 命中拖拽片段。

## spec 影响
FS-02 医院视图补一条：医院下拉支持个人拖拽排序（localStorage 持久化，集合仍运营端分配）。draft，评审并入。
