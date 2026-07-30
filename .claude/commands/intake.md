---
description: 进件（飞书文档/直接录入）→ 拉正文看图 → 先析 spec → 再出任务批次 → 人确认后落地
---

用户给一次**进件**（一个**飞书文档链接**，里面是一堆 bug / 需求；也可能直接在窗口里贴文字）。统一流程：**先分析要不要动 spec → 再把内容拆成一个任务批次 → 一起给人拍板**。别跳步。

> 模型：**任务清单（进件批次）= 主线**（用户日常看「我的任务做到哪了」）；**spec = 系统参考资料**（供 AI/人理解系统全貌，进件时被动维护，不再是日常操作对象）。**无论大小都出 task**；大的额外动 spec，小的只动某条 AC 或不动 spec。

## 1. 拉正文 + 看图（飞书链接时；重要：需求常画在截图里）
运行：`node tools/feishu-fetch.mjs "<飞书链接>"`（支持新版文档 `/docx/`、知识库 `/wiki/`、**多维表格 `/base/`**）
- **多维表格(Bitable)** → 输出是「每条记录 = 一条 task」的结构(主字段=标题、其余字段=备注)。直接据此拆任务,通常一条记录就是一条需求/bug。需飞书应用开 `bitable:app:readonly` 权限、且表已共享给应用;报权限错就转告用户去补。
- 成功 → 拿到文档纯文本。**末尾若列出「📷 本文档含 N 张图片」+ 本地路径，务必逐张用 `Read` 工具打开看**（你有视觉）——飞书 raw_content 丢图片，界面改动/标注全在图里，只看文字会漏需求（验收会挂）。把图里的信息和对应文字段落对齐后再分析。
- 末尾若是「⚠️ 图片未能下载（缺 drive:drive:readonly）」→ **转告用户去飞书开放平台补 `drive:drive:readonly` 权限并重新发布**，然后**停下**（不要在缺图的情况下硬分析）。
- 其它报错（没配机器人 / 无法确定项目 / wiki 权限 / 旧版文档…）→ **把原话转告用户**让其在控制台「飞书配置」补齐或换新版链接，然后**停下**。
- 若是 CLI 窗口直接录入的文字（无链接）→ 跳过本步，直接用用户给的原文。

## 2. 拆条 + 先分析是否调整 spec（按 CLAUDE.md §4.6 / §4.5，对照历史 spec）
把正文拆成 **N 条独立项**；**逐条**判定它落在哪里、要不要动 spec（大小分流）：
- **大特性 / 架构级** → **新建或修改 spec**（status=draft 待评审）；
- **零散小改（改某条规则/边界）** → 改**已有 spec 的某条 AC**；
- **不涉及结构（纯本地小事/查数/临时）** → **不动 spec**。
顺 `depends_on` / 共享表字段 / 共享接口 / 同模块 扫**影响面**；多条之间标冲突点。
**起草 spec 的 diff**（可审的具体改动：改哪条 AC / 新增哪节，不是 yes/no）。

## 3. 生成任务批次（这次进件 = 一个 batch）
把这次内容拆成的 N 条，整理成**一个进件批次**，每条 task 关联它落地的 spec（`specRef`，没有就空），便于回溯。先把 batch 写进脑里/草稿，**等第 4 步人确认后再落盘**（见第 5 步的写法）。

## 4. 出「spec diff + 任务拆分」给人确认（硬门）
一起摆给用户：
- **spec 侧**：建/改了哪些 spec、每条的 diff（新建 draft / 改某 AC）。
- **任务侧**：这个批次拆成哪几条 task、各自 `specRef`、建议状态。
用户可逐条改去向 / 调 spec diff。**不确认不落地。**

## 5. 确认后落地
- **spec**：合并确认后的 diff（新建 draft / 更新现有 AC）。
- **任务批次**：直接**编辑 `docs/tasks.json` 追加一个 batch**（file-as-interface，不走 HTTP）。把 task 填进下面的 `TASKS` 数组再运行：

```bash
node -e '
const fs=require("fs"),f="docs/tasks.json";
let j; try{j=JSON.parse(fs.readFileSync(f))}catch{j={title:"任务清单",batches:[],items:[]}}
j.batches=Array.isArray(j.batches)?j.batches:[];
const now=Date.now();
const TASKS=[
  {title:"<一条任务>", specRef:"AG-01", note:""},
  // …每条一行；specRef 没有就 ""
];
const batch={
  id:"b"+now.toString(36),
  importedAt:now,
  source:{type:"feishu", ref:"<飞书链接 或 录入说明>"},  // 直接录入则 type:"cli"
  title:"<这次进件一句话概括>",
  tasks:TASKS.map((t,i)=>({id:"t"+(now+i).toString(36), title:String(t.title).slice(0,300), status:"todo", specRef:t.specRef||"", note:t.note||""}))
};
j.batches.push(batch);
fs.writeFileSync(f, JSON.stringify(j,null,2));
console.log("已落批次", batch.id, "含", batch.tasks.length, "条 task");
'
```

> `source.type`：飞书链接→`feishu`、CLI 窗口直接录入→`cli`、手动单条→`manual`（手动单条优先用 `/todo`）。`docs/tasks.json` 随项目入库、团队共享。

## 6. 回报
一句话：建/改了哪些 spec（draft/AC）、落了一个含几条 task 的批次、有没有需要你进一步定的（`NEEDS-HUMAN`）。开做时各 task 走 `/build`（关联 spec）或 `/fix`，做完回写该 task `status=done`。
