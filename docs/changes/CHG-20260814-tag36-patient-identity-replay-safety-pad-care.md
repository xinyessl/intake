# CHG · tag36 全局患者身份、未知重复动作与 Pad 监护实施链

- 日期：2026-08-14
- 关联 Spec：FS-04 AC-57
- 类型：行为边界补充（待人验收）

## 根因

患者请求三元身份此前主要靠各业务 route 自带 `answerFacts`，部分 route 只描述自身状态或内部归属维度，现场诊断因此可能只核 `patientId + visitId`。非破坏守卫也未把“下一轮同条件再复现”等省略写入动词的说法显式归为潜在副作用。Pad 监护 route 只区分了页面与 `/care/order`，遗漏点击前患者上下文同步和详情读取 GET。

## 改动

1. `/api/consult` 新增跨 route 的患者请求身份运行时守卫；患者类请求核对统一注入 `hospitalId + patientId + visitId`，`districtCode` 不得替代，原子字段题继续止答。
2. normal/deep 默认提示词与运行时非破坏守卫同步扩充“下一轮/同条件再复现/重新操作一次/重新走一遍”；原动作只读性未知即按潜在副作用处理。
3. PWRS 地图补全 Pad 监护列表、点击前患者上下文、详情路由、详情 GET 与 `/care/order` 反例，并给 AI 药历、患者关注的请求诊断叠加全局三元身份。

## 验证

- prompt/runtime 定向：45/45。
- PWRS 真实地图：54/54，含所有同时出现 `patientId + visitId` 的 route 不得漏 `hospitalId` 审计。
- 无接口、持久层或数据库变更，不需要真库写入冒烟；`$STEWARD_LESSONS` 本会话为空，未臆造全局经验库内容。

## 状态

实现与脱库回归完成，task 保持 `doing`、FS-04 `accept=wait`，待用户验收。
