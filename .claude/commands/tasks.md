---
description: 查看/整理任务清单——按批次列出 task、改状态、回链 spec(docs/tasks.json)
---

任务清单（进件批次）是本项目的**主线**：用户日常核心看的就是「我的任务做到哪了」。`$ARGUMENTS` 可空（=全列）或指定批次/关键字/`done|todo|doing` 过滤。

> 数据在 `docs/tasks.json`（本地不入库）：`batches[]`，每个 batch 有 `importedAt`/`source`/`title`/`tasks[]`；task 有 `title`/`status(todo|doing|done)`/`specRef`/`note`。旧 `items[]` 字段已废弃——读取时若 `items` 非空，**迁进一个「历史速记·手动」批次**再展示（命令里不要再写 items）。

## 1. 读 + 展示
读 `docs/tasks.json`，按批次倒序（新进件在上）列出：
- 批次头：`title` · 来源（feishu/cli/manual + ref）· 导入时间（`yyyy-MM-dd HH:mm`）· 进度（done/总数）。
- 批次下每条 task：状态、`title`、`specRef`（可点回 `docs/specs/<id>.md`）、`note`。
按 `$ARGUMENTS` 过滤（批次 id / 关键字 / 状态）。

## 2. 整理（按用户要求）
- **改状态**：把某条 task 的 `status` 改成 `todo|doing|done`（开发流程里 `/build`·`/fix` 做完也应回写对应 task 为 `done`）。
- **补 specRef**：某条 task 落地到了哪条 spec，回填 `specRef` 便于回溯。
- **迁移旧速记**：`items[]` 非空 → 整体搬进一个 `{source:{type:"manual",ref:"历史速记"},title:"历史速记·手动"}` 批次，清空 `items`。

用 node 安全改 JSON（别手抠文件），改完跑出来确认：

```bash
node -e '
const fs=require("fs"),f="docs/tasks.json";
let j=JSON.parse(fs.readFileSync(f));
j.batches=Array.isArray(j.batches)?j.batches:[];
// 迁移旧 items → 历史速记批次
if(Array.isArray(j.items)&&j.items.length){
  const now=Date.now();
  j.batches.push({id:"b"+now.toString(36),importedAt:now,source:{type:"manual",ref:"历史速记"},title:"历史速记·手动",
    tasks:j.items.map((it,i)=>({id:it.id||("t"+(now+i).toString(36)),title:String(it.text||it.title||"").slice(0,300),status:it.done?"done":"todo",specRef:"",note:it.pri?"重要":""}))});
  j.items=[];
}
// === 在此按需改某条 task 状态 / specRef ===
// 例：for(const b of j.batches) for(const t of b.tasks) if(t.id==="<taskId>") t.status="done";
fs.writeFileSync(f, JSON.stringify(j,null,2));
console.log(JSON.stringify(j.batches.map(b=>({title:b.title,done:b.tasks.filter(t=>t.status==="done").length,total:b.tasks.length})),null,2));
'
```

## 3. 回报
列出当前批次 + 各自进度，标出本次改了哪些 task 状态/specRef。提醒用户：进件走 `/intake`、手动单条走 `/todo`、开做走 `/build`(关联 spec)或 `/fix`。
