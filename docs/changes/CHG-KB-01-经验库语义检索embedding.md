# CHG · KB-01/MC-01 · 经验库语义检索（embedding 混合召回）+ 模型配置纳入 embedding 模型

> 日期：2026-07-30　类型：特性（检索从纯关键词升级为语义混合）　来源：用户「使用语义检索」
> 代码：server.mjs + public/model-config.html + tools/mc-01.test.mjs / fs-06.test.mjs

## 背景
原经验库检索是纯关键词重叠（中文 bigram，`kbSearch`）——换个说法（同义/近义不共享 bigram）搜不到。用户要求上语义检索。现有聊天模型走 Anthropic 协议、无 embeddings；实测阿里 MaaS 的 `/compatible-mode/v1/embeddings`（OpenAI 兼容、qwen3.7-text-embedding、1024 维）可用。

## 改动
- **模型配置纳入 embedding 模型**：`data/model-api.json` 加 `embed:{provider,model,baseUrl,apiKey}`；`/api/model-config`(GET)回 `embed`(掩码)；`/api/model-config-save` 存/保留 embed（留空+掩码保留旧 key、不带则 no-clobber、不覆盖聊天模型）；`/api/model-test {kind:'embed'}` 测连通（返回维度）。`public/model-config.html` 加「Embedding 模型（语义检索）」卡片（服务商/接口地址/模型/API Key + 测试连通 + 保存）。
- **语义混合召回**：新增 `embedTexts`（OpenAI 兼容 /embeddings）、`cosine`、KB 向量缓存 `data/kb-embed.json`（内容 hash 变了才重算）、`ensureKbEmbed`、`_kbScored`、`kbRetrieve`（`SEM_GATE=0.42`）。判定：语义可用→`sim≥0.42 || 关键词≥minScore`、按 sim 排；**语义未配/失败→纯关键词（旧行为），绝不报错/空结果**。
- **接入**：consult（`kbSearch(...,5,2)`→`kbRetrieve(...,5,2)`）、`/api/kb-search`（单产品 + all=1 跨产品，只 embed 一次 query）。

## 线上实测（真实模型 + 真库）
- 直接余弦：换说法「评分为0保存失败」vs 那条「得分不能为0」BUG 经验 = **0.754**（>0.42）；vs 无关句 = 0.153。
- kb-search 用「评分模板零分误报无法保存」（字面几乎不重叠）→ 那条 CHA2DS2 经验召回 **#1**（纯关键词搜不到）。
- model-test embed（掩码 key）→ `{ok:true,dim:1024}`。
- 测试：mc-01 22/22、kb-01 19/19、fs-07 37/37 绿。

## spec 同步（待 /accept 拍板）
KB-01 §2/AC-17 需补：consult/kb-search 走 `kbRetrieve` 语义混合召回、未配退回关键词；embedding 配置纳入 model-config（model-api.json `embed`）。fs-06 B-KB-REL4 断言已同步为 kbRetrieve。lessons 已加自检项。

## 部署
rsync server.mjs + model-config.html + docker restart；prod `data/model-api.json` 加 embed（key 只落该文件、gitignore、不入仓）。**用户 key 曾明文出现在对话，建议轮换。**
