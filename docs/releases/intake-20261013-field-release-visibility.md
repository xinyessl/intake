# Intake 线上运行快照 · 2026-10-13

Tag：intake-20261013-field-release-visibility。独立发布分支，基于8fe7702，不合并main。

本次功能：实施端按医院产品实际版本隐藏同版和旧版，完成升级后刷新与清理状态，空态及切院异步保护。之前累计SQL/任务、扁平包、lib合并和固定启动JAR的已上线能力保留。

## 快照范围
41个运行文件与线上只读快照逐字节一致，SHA256清单见同名runtime.json。没有data、凭据、客户或批次内容、备份、临时文件。仅源码/静态资源、所需测试、spec和本报告。

线上咨询功能比远端main有既存差异（server/field/consult-reply），此tag如实记录已运行状态；这些不是本轮回退，也未将tag重新部署或合入main。原工作树所有未提交修改保持。

## 可复现验证
Node 20+，npm ci --ignore-scripts；node --test tools/field-release-visibility.test.mjs tools/release-bundle.test.mjs test/cumulative.test.mjs。原累计打包测试fixture曾使用非ZIP占位字节与旧安装说明布局，现改为真实ZIP并按已上线双目录布局验证，不修改运行代码。运行文件语法与本地相对模块闭包完整；数据/凭据扫描通过。

线上15:10已完成只读验收：新疆北屯1.5.26101002列表由B04/B03/B02变为空，后台B01至B04保留，双端口健康通过。三份业务JSON hash未变。备份与回退见CHG-20261013-field-release-visibility。
