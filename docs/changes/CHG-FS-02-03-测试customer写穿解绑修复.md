# CHG-FS-02/03 · 测试修复：customer-save 写穿会解绑 impl 账号 sites

- 日期：2026-07-23
- 类型：测试修复（生产代码不改；测试 setup 缺陷）
- 关联测试：tools/fs-02.test.mjs（B3）、tools/fs-03.test.mjs（B2/B3）

## 现象
`tools/fs-02.test.mjs` 的 B3、`tools/fs-03.test.mjs` 的 B2/B3（越权医院收敛）在隔离运行时失败：越权医院记录未被裁掉、泄露到结果（`me.sites` 空 → `scopedForField` 不过滤）。

## 根因
`server.mjs` `/api/customer-save` 有「双向写穿 account.sites（一院一实施 · 2026-07-23 裁决）」：`reconcileSiteToImpl(accs, rec.name, rec.impl.name||'')` **先从所有账号移除该医院名，再按 `impl.name` 加回目标 impl 账号**。测试先 `account-save`（给 impl 账号 `sites:[SITE_A...]`），再 `customer-save` **不带 `impl`** → `impl.name` 为空 → **只移除不加回**，把医院从 impl 账号 sites 清空。随后 impl 登录，`me.sites` 空 → 越权收敛失效。

## 解法（测试 setup 对齐生产设计）
两个测试的 `customer-save` 补 `impl: { name: '<impl 账号 name>' }`（fs-02='甲实施'、fs-03='FS03实施'），让写穿把医院**绑回** impl 账号（`reconcileSiteToImpl` 移除后再 push 回目标账号），保持 `me.sites` 非空。这是生产的**正确用法**（医院↔实施绑定的唯一真源 = customer.impl 写穿 account.sites），测试原先漏传 impl 才踩坑。

## 生产代码
不改。写穿逻辑本身正确（一院一实施排他 + 空名解绑是设计意图）。

## 关联
sits `reconcileSiteToImpl`/`removeSiteFromAllAccounts`（server.mjs L206-229）；已把该坑写进 `$STEWARD_LESSONS`（通用：写穿型关联字段，测试 setup 要按写穿口径传全字段）。
