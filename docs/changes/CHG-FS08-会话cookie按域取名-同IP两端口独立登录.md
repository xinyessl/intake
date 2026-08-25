# CHG · FS-08 会话 cookie 按域取名——同 IP 两端口（或双域名）各自独立登录

- **日期**：2026-08-25
- **来源**：用户需求——实施端/运营端（无论两域名、还是同 IP 两端口）要**各自独立登录**。现登录 cookie 固定叫 `intake_sess`，而 **cookie 不区分端口（RFC 6265）**，同 IP 两端口（新机 `:5180`=运营/admin、`:5181`=实施/field）会**共用一个 session**——一端登录另一端也登录了。
- **spec**：**FS-08**（双域名部署 · 访问隔离）。**改了会话行为（cookie 命名规则）→ 涉及 spec**（非纯 bug/重构）→ 已在 FS-08 起草 **draft diff 待评审**：
  - 新增 **AC-15b**（D 组）：会话 cookie 按域取名（`intake_sess_field`/`intake_sess_admin`），实现两域（或两端口）独立登录；单域名回退 `intake_sess`。
  - §4④ 由「复用 · cookie 现状不变」🔧 改为「会话 cookie 按域取名」，列 `sessCookieName` helper + login/currentUser/logout×2 四处改动口径。
  - **本 CHG 只作痕迹指针；spec diff 是审核对象**（合并前待人拍板）。

## 类型
会话行为调整（cookie 命名规则变更）→ **涉及 spec**（FS-08 AC-15b + §4④ diff，待评审并入验收门）。

## 改动要点（仅 `server.mjs` cookie 名逻辑 + 测试 + spec）
- **🆕 helper** `sessCookieName(origin)`（紧随 `parseCookies`）：`'field'→intake_sess_field`、`'admin'→intake_sess_admin`、其它（`'other'`/单域名/直连 IP/本机）→ `intake_sess`。
- **🔧 `/api/login`**：`Set-Cookie` 用 `${sessCookieName(origin)}=...`（`origin` = 当前请求 `originOf(req)`，已在 handler 作用域 ~L1643 算好）。
- **🔧 `currentUser(req)`**：`parseCookies(req)[sessCookieName(originOf(req))]` 读 token（同 req 域一致）。
- **🔧 `/api/logout` + `/logout`**：`cn=sessCookieName(origin)`，读 `parseCookies(req)[cn]` 拿 token 后 `dropSession`，`Set-Cookie: ${cn}=; ...; Max-Age=0`——**只清当前域那个 cookie**，不误清别的域。
- **session 存储不变**：`sessions` 表（token→userId）、`newSession`/`dropSession`/鉴权链路语义全不动，只改承载 token 的 cookie 名。
- **未碰**：`originGate`/`authGate` 放行逻辑、`intake_link`（免登录提交链接身份，另一套）、任何库表/字段。

## 向后兼容
- 单域名（`origin='other'`，未配双域名/直连 IP/本机）→ 仍是 `intake_sess`，**行为零变化**。
- 回归证据：`tools/fs-01.test.mjs`（21/21）、`tools/consult-to-intake.smoke.mjs`（5/5）单域名实例登录仍下发裸 `intake_sess`，全绿。

## 验证
- `node --check server.mjs` 通过。
- 新增 `tools/fs-08-session-cookie.logic.test.mjs`（10/10）：`sessCookieName` 三分支 + 源码级断言 login/logout×2/currentUser 都走 `sessCookieName(origin)`（无残留裸 `intake_sess`）+ `intake_link` 未误动。
- `tools/fs-08.test.mjs`（**连真库 · 真 server + 真 MySQL**，33/33）：admin 域登录→`intake_sess_admin`、field 域登录→`intake_sess_field`、admin 域 cookie 打 field 域 `/api/me`→`me:null`（两端独立）、PLAIN 单域名实例仍裸 `intake_sess`。
- 全量 `tools/*.logic.test.mjs` 342（336 pass / 6 MySQL-gated skip）与改前一致，无回归。

## ⚠️ 部署注意（交付说明已注明）
- 部署后**所有人会重登一次**——cookie 名变了，双域名下旧 `intake_sess` 读不到新名（`intake_sess_field`/`intake_sess_admin`），属预期。
- 编排器冒烟时：双域名下 admin 域会话 cookie 名 = `intake_sess_admin`、field 域 = `intake_sess_field`（不再是 `intake_sess`）；单域名/直连 IP 仍是 `intake_sess`。
- **未 commit / 未部署**（交付说明给编排器审后再动）。
