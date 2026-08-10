# Field Overview

实施端「全览」的 React 18 + Ant Design 5 渐进式前端。旧 `public/field.html` 仍负责登录、权限、导航、数据获取和会话恢复，本工程只渲染 `#fOverview`。

```bash
npm install
npm run dev
npm test
npm run build
```

生产构建直接输出到 `public/assets/field-overview/`，由现有 Node 服务静态提供。稳定接口：

```js
window.IntakeFieldOverview.mount(container, { data, onHospitalSelect, onError });
window.IntakeFieldOverview.unmount(container);
```

不要删除 `field.html` 的 `renderOverviewNative`：它是 bundle 缺失、挂载失败和渲染异常时的无白屏回退。
