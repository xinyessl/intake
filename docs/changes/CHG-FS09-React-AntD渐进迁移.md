# CHG：实施端全览渐进迁移至 React + Ant Design

- 日期：2026-08-10
- 关联：FS-09 AC-10~12、FS-01 AC-16/17/21、UI-01 AC-26
- 性质：前端框架与全览界面迁移；不改后端接口、数据口径、权限、数据库或部署拓扑

## 变更

1. 新建 `frontend/field-overview`，使用 React 18、Vite 5、Ant Design 5 与 `@ant-design/icons`；根目录增加开发、构建、测试脚本。生产构建输出固定 IIFE 与 CSS 到 `public/assets/field-overview/`，关闭 sourcemap，现有 Node 服务可直接提供静态文件。
2. React 全览真实消费 `GET /api/field/overview` 已返回的数据，不在组件内另拉接口或重算后端口径。`ConfigProvider` 统一藏青/青绿 token；KPI、医院待办、产品版本分布使用明文层级和响应式网格，长列表限高滚动。
3. `field.html` 保持登录、权限、mode、医院/系统/对话和 sessionStorage 恢复的控制权，仅把同一份 overview 数据交给 `window.IntakeFieldOverview.mount()`。离开全览或退出时调用 `unmount()`。
4. 旧 `renderOverviewNative` 完整保留。bundle 缺失、mount 抛错或 React ErrorBoundary 捕获渲染异常时立即回退原生渲染，避免全览白屏。
5. 医院卡不再把整卡伪装成按钮；使用 44px Ant Design「进入医院视图」按钮，避免卡内可聚焦滚动区的点击/空格冒泡误导航。

## 验证

- `npm --prefix frontend/field-overview run build`：通过；JS 926.31kB（gzip 291.38kB），CSS 10.06kB，无 `.map`。
- `npm --prefix frontend/field-overview test`：5/5，通过模型聚合、明文风险、版本关联、空态和组件 SSR。
- `node --test tools/fs-09-react-overview.integration.test.mjs`：6/6，真实执行挂载分流并覆盖异常回退、医院导航、卸载、嵌套交互护栏、产物大小与 sourcemap。
- FS-09 原聚合/原生回退 28/28；FS-04 恢复及相邻逻辑 55/55。

## 风险与回退

- Ant Design 首阶段采用单 IIFE，未做按需分包；产物约 926kB（小于本次 1.5MB 护栏），后续迁移扩大时需评估拆包与缓存策略。
- 本机 MySQL `127.0.0.1:3306` 未启动，依赖真库的 FS-01/FS-04 整套测试在 before hook 被环境阻断；本次未改后端/数据库，脱库组件与接线回归已全绿。
- 回退不需改服务端：移除/加载失败 React 产物时，`field.html` 自动走原生全览。
