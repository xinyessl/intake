# FAQ（系统说明书 · 层3 · 常见问答）

> **服务"现场答疑"**：先命中这层常见问题，命不中再翻层2功能 spec / 导读、再看 `server.mjs` 代码。
> **只管系统自身**：症状 → 原因 → 去哪看（页面/端点/表或 JSON 文件/字段）→ 怎么解。

## 组织
- 按功能模块分文件：`docs/faq/<模块>.md`（对齐 `docs/specs/00-功能模块地图.md`）。当前模块：
  - **实施端 FS**（AI对话提交 / 免登录链接 / 医院·系统视图 / 下载版本回写）
  - **运营后台**：UI（外壳）/ WB（工作台）/ TK（工单）/ BP（批次发包）/ PD（产品）/ CU（客户医院）/ KB（经验库）/ MC（模型配置）/ AM（账号）
  - 格式见 `_TEMPLATE-faq.md`。
- 当前为空——**随现场答疑增量沉淀**。intake 高频区可能在：**AI 对话提交/咨询答疑**（判类、两阶段召回、发布前语义审计、附图多模态）、**批次与发包**（更新包跟随产品代码 tag/deploy.json、快照机制）、**免登录链接**（token 校验/LINK_OK 白名单）、**版本回写**（现场版本 vs tag 版本）。

## 沉淀纪律
- 踩到**非显然**的坑 → 对应模块 FAQ 加一条。
- 与 `docs/lessons.md` 互补：lessons 偏"开发实现坑"，FAQ 偏"现场使用/配置/排障问答"。
- intake 特殊：数据分**真库 5 表**（`db.mjs`：projects/accounts/sessions/intakes/kb_entries）与**文件存**（`data/customers.json`、`data/model-api.json`、`data/batches.json`）——排障时先分清落在哪。
