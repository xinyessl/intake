# CHG · 原子接口已核终稿固定标题不再误杀

## 现象

AI 审方“开始生成 / 停止生成”原子接口题已命中 `fallbackMode=verifiedFacts`，两条已核接口事实也完整，但确定性终稿的固定段落标题“业务结论”“实施口径”没有 HTTP 路径，被通用 `focused_fact_overreach` 当成越界扩写，导致安全终稿无法发布。

## 修复

- 在 `consultFocusedFactOverreach` 内只精确豁免系统固定的“业务结论”“实施口径”，兼容纯文本、Markdown 标题和成对 `**` / `__` 包裹。
- 不放宽通用短标题规则；其它无路径标题（回归样例“更多说明”）仍触发 `focused_fact_overreach`。
- 补 `FS-04 AC-141`，明确固定标题白名单与其它终审安全门的边界。

## 验证

- 使用真实 `server.mjs` 函数抽取组合调用 `consultVerifiedFactsFallback`，以生产原问、原 route facts 与 `mustNotConfuse` 回归。
- 断言 fallback 非空、终审 `violations=[]`、`POST /comm/ai/generate` 与 `POST /ai/generate/stop?generateId={id}` 均保留、`POST /external` 不出现。
- 另以任意无路径标题“更多说明”断言仍产生 `focused_fact_overreach`。

本变更不涉及数据库结构、数据写入、接口契约或部署。
