---
description: 手动加任务——把零碎小事作为 task 追加进「手动来源·当天」批次(docs/tasks.json)
---

把用户这次给的一批**零碎小事**（bug 小修、查数据、本地脚本、临时提醒…）作为 **task** 追加进**手动来源批次**。

> 模型：任务清单（批次）是统一的「做什么」。手动加一条 = 「手动来源·当天」批次里的一条 task——**不再有独立速记概念**，所有任务都在批次里。

## 铁律
- **手动小事默认不动 spec、不碰 `docs/specs`**：只记「不改变系统规约」的零碎事，作为 task。
- 若某条其实是需求 / 会改逻辑 / 影响其它模块 → **别用 `/todo`**，回一句「这条像正经需求，建议走 `/intake` 或 `/spec`」（那条流程会先析 spec、再出批次），由用户定。

## 怎么写（用 node 安全改 JSON，别手抠文件）
同一天的多条**并入当天的「手动来源」批次**（按 `source.type==="manual"` + 当天日期找；没有就新建一个）。把每条事项填进 `TASKS` 数组再运行（用户强调重要/紧急的写进 `note`）：

```bash
node -e '
const fs=require("fs"),f="docs/tasks.json";
let j; try{j=JSON.parse(fs.readFileSync(f))}catch{j={title:"任务清单",batches:[],items:[]}}
j.batches=Array.isArray(j.batches)?j.batches:[];
const now=Date.now();
const day=new Date(now).toISOString().slice(0,10);
const TASKS=[
  {title:"<一句话事项，≤300字>", note:""},
  // …每条一行
];
// 找当天的手动批次，没有就建
let b=j.batches.find(x=>x.source&&x.source.type==="manual" && new Date(x.importedAt).toISOString().slice(0,10)===day);
if(!b){ b={id:"b"+now.toString(36), importedAt:now, source:{type:"manual",ref:"手动"}, title:"手动来源·"+day, tasks:[]}; j.batches.push(b); }
TASKS.forEach((t,i)=>b.tasks.push({id:"t"+(now+i).toString(36), title:String(t.title).slice(0,300), status:"todo", specRef:"", note:t.note||""}));
fs.writeFileSync(f, JSON.stringify(j,null,2));
console.log("已记入", TASKS.length, "条 →", b.title);
'
```

## 收尾
一句话回报：往「手动来源·当天」批次加了哪几条 task；并提示用户「在控制台的任务清单里查看/勾选/整理」。
