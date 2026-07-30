# CHG · FS-04/FS-06 · 对话提交附截图 + AI 多模态看图（2026-07-24）

> 用户裁决（2026-07-24）：实施端「AI 对话提交」加图片功能——报 BUG/提需求/咨询时可附截图，开发在工单详情看图，且 **AI 判类/答疑时也把图发给模型**更准。
> 属**涉及 spec** 改动（新增行为）：FS-04 AC-27~31、FS-06 AC-C11 已同步（见 spec diff）。本 CHG 记录实现要点与前端交互细节。

## 改了什么
### 后端 `server.mjs`
- 新增多模态构造 `withImages(messages, images, isAnthropic)` + `mmParseImage(du)`：有图 → 把 ≤6 张截图并进**最后一条 user 消息**的 content（anthropic `{type:'image',source:{type:'base64',media_type,data}}` / openai `{type:'image_url',image_url:{url}}`）；**无图 → 原样返回（content 仍字符串，纯文本调用一字不变·向后兼容）**；只并末条 user、历史不改、≤6 封顶、非法 data URL 过滤。
- `callModelOnce` / `callModelStreamOnce` 加 `images` 入参，调用前套 `withImages`。
- 接入点：`intake-chat`（`callModel` 带 `images:imgs`）+ `consult`（`callModelStream` 带 `images:imgs`）；有图时系统提示追加一句「结合图片理解」。
- `consult` **补齐存图**（原只 intake-submit/chat 有）：落 `intake-store/<proj>/media/<convId>/img-N.png` + 记 `e.media`；**续聊同 convId 累加不覆盖**（从 `prev.media.length` 起序号、累计封顶 6）。

### 前端 `public/field.html`
- 输入区 `.f-chat-f` 加：图片入口按钮 `#fImgBtn` + 隐藏 `<input type=file accept=image/* multiple #fImgInput>` + 缩略图预览条 `#fImgPreview`（每张带删除 ×）。
- **选图**（点按钮→file input change）+ **粘贴**（输入框 `paste` 事件取 `clipboardData` 图片）两条入口 → `addImageFiles`。
- **压缩** `compressImage`：`canvas` 缩到 ≤1600px 宽再 `toDataURL('image/jpeg',0.85)`（防炸 `MAX_BODY`=30MB），压完更大则回退原图。
- 待发送队列 `pendingImages`（≤6，`IMG_MAX`）；`sendChat` 捕获本轮图 → `sendIntake(imgs)`/`sendConsult(imgs)` 请求体带 `images`（**有图才带·向后兼容**）→ **发送后清空**。
- **我方气泡显所附截图**（`appendBubble(...,imgs)` → `bubbleImgs` → `.f-bub-imgs` 缩略图，点开原图）。
- **图片是输入态**：不进 `chat.bySystem` 快照 / 不进 `saveDraft` 草稿（避免大 base64 进 sessionStorage）；`newConversation`/`restoreConversation`/`reopenConsult` 均 `clearPendingImages()`。

### 运营端展示
- `detail.html` 早已按 `e.media` 展示「截图（N）」→ intake + consult **均生效、无需改 detail**。

## 为什么记 CHG（而非只 spec）
- 行为新增已进 spec（FS-04 AC-27~31 / FS-06 AC-C11）；本 CHG 额外留一份**前端选图/粘贴/压缩交互 + 多模态两家格式**的实现痕迹，便于回溯与防漂移。

## 测试
- 新增 `tools/mm-01.test.mjs`（8 例）：`withImages`/`mmParseImage` 两家格式 + 无图向后兼容 + 只并末条 user + ≤6 封顶 + 非法过滤。
- `tools/fs-06.test.mjs` 增 B-IMG1~5：连真库 consult 带图 → media 文件 + `e.media` 落库 + `/api/intake-media` 取回 + 防穿越 + 续聊累加不覆盖；server/field 静态断言。
- `tools/fs-04.test.mjs` 增 A-IMG1~6 + B-静态多模态：field.html 选图/粘贴/预览/压缩/发送/气泡显图 + 图片不进草稿 + intake-chat 传 images。
- 回归全绿：mm-01 / fs-01 / fs-04 / fs-06 / fs-02 / fs-03 / fs-07。真库 hlyy 基线不变、fs04/fs06 无残留。

## 风险
- 单张压缩后仍可能较大，6 张累计 base64 逼近 `MAX_BODY`（30MB）——已 canvas 压缩 + 张数封顶缓解；超限由后端 `MAX_BODY` 兜底返错。
- 多模态图占 token → 成本上升；`maxTokens` 未因图加大、张数封顶控制。
- 续聊同 convId 图**累加**（不覆盖），累计封顶 6 张——超过部分本轮丢弃（可接受）。

## 未碰（护栏）
- 未碰 `ui.js` / `customers.html` / `inbox.html` / 其它页 / 已改逻辑（per-system 会话/必选守卫/reopen/子项目下拉/subsystemLabel/按批次降级/深入思考/思考动效/归档条/currentArchive/minScore/renderSysChip/renderVerDetailRows）。
- 未改 `intake-submit`/`intake-chat` 既有存图逻辑（本就对），只给 consult 补齐 + 全链路加多模态入参。
