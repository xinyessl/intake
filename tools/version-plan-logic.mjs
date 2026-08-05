// ===== 更新包「跟随产品代码 · 按 tag 读 docs/deploy.json + 跨版本累积」· 纯逻辑（可独立测试，不依赖 MySQL / 不 spawn server / 不碰 git）=====
// 供 server.mjs import 复用 + tools/version-plan-deploy.logic.test.mjs 单测。
//
// 模型（2026-08-05 架构重构·用户拍板，别改规则）：
//   1) 清单/SQL 是**产品代码的一部分**：每个子系统仓 `docs/deploy.json`（按 git tag 读，见 server.readDeployManifest）声明该版本 delta 实施任务 + SQL。
//      **废弃** intake 内手工「版本发版登记」（version-releases.json）。
//   2) 实施在某院把某产品升到「目标版本 Y」→ 按该院该产品的现场版本 X → Y，取 (X, Y] 区间内每个 tag 的清单
//      （跨子系统聚合 + 跨版本累积并集），按版本升序展示。
//   3) SQL 系统不碰库，只列出；实施手动跑、勾「已执行」（整区间合并为**一个点**）。
//   4) SQL 到现场可合并成一个 .sql 文件下载（按版本序 + 分隔注释；file 引用由 server 读正文，content 内联兜底）。
//   5) 版本号来源 = git tag（listVersions）。累积起点 = 现场版本。
//   6) 完成度按 (医院 × 产品 × 版本 × 条目) 记（customer.updateProgress）。任务全局 id = `<子系统>:<原id>`，跨子系统不撞号。
//
// 版本序说明：listVersions(proj) 返回**倒序**（新→旧）。本模块所有入参 orderedTags 统一约定为
//   「**升序**（旧→新）」——调用方（server.mjs）传入前先 reverse。区间/合并都按升序处理，展示天然旧→新。

// 文本截断（对齐 server.mjs / checklist-logic 范式：String→trim→slice）。
export function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

// 生成 id：prefix + 4字节 hex（测试里可注入 gen 保证确定性）。
export function genId(prefix, rand) { return String(prefix || 'v') + (rand ? rand() : Math.random().toString(16).slice(2, 10).padEnd(8, '0')); }

// ---------- 单个子系统 docs/deploy.json 规范化（server.readDeployManifest 里对每个子系统调用）----------
// 入参：raw = JSON.parse(docs/deploy.json) 的结果（{tasks:[],sql:[]}）；subsystem = 子系统名（用于全局 id 前缀 + 来源标记）。
// 输出：{ tasks:[{subsystem,id,gid,title,desc}], sql:[{subsystem,id,gid,file,desc,content}] }。
//   · title/name(此处无 name，用 desc/file 标识) 约束：title 非空丢弃、title≤120/desc≤2000；sql desc≤200/content≤20000。
//   · 缺 id → 补 'dt'/'ds' + hex；同一子系统内 id 去重。tasks/sql 各上限 200。
//   · 全局 id gid = `<subsystem>:<id>`（跨子系统不撞号；子系统空则用 'default'）。
export function normDeployManifest(raw, subsystem, gen) {
  const sub = clip(subsystem, 60);
  const gt = (gen && gen.task) || (() => genId('dt'));
  const gs = (gen && gen.sql) || (() => genId('ds'));
  const pfx = (sub || 'default') + ':';
  const r = raw && typeof raw === 'object' ? raw : {};
  const tasks = [];
  const seenT = new Set();
  for (const t of (Array.isArray(r.tasks) ? r.tasks : [])) {
    const title = clip(t && t.title, 120);
    if (!title) continue;
    let id = clip(t && t.id, 60) || gt();
    if (seenT.has(id)) id = gt();
    seenT.add(id);
    tasks.push({ subsystem: sub, id, gid: pfx + id, title, desc: clip(t && t.desc, 2000) });
    if (tasks.length >= 200) break;
  }
  const sql = [];
  const seenS = new Set();
  for (const s of (Array.isArray(r.sql) ? r.sql : [])) {
    const file = clip(s && s.file, 300);
    const content = String(s && s.content != null ? s.content : '').slice(0, 20000);
    if (!file && !content) continue;                                   // 既无 file 又无 content → 无意义，丢弃
    let id = clip(s && s.id, 60) || gs();
    if (seenS.has(id)) id = gs();
    seenS.add(id);
    sql.push({ subsystem: sub, id, gid: pfx + id, file, desc: clip(s && s.desc, 200), content });
    if (sql.length >= 200) break;
  }
  return { tasks, sql };
}

// ---------- 版本号语义升序排序（目录形态草稿用）----------
// 2026-08-05 核心更新流重构：草稿源改为 docs/deploy/ 目录（一版一文件），版本序不再来自 git tag，
//   而是由文件名（=版本号）按语义（numeric）升序排。与 listVersions 的 localeCompare(numeric) 口径一致。
//   入参 versions：版本号数组（乱序/含重复）；返回：去重 + 语义升序（旧→新）。
export function sortVersions(versions) {
  const set = [];
  for (const v of (Array.isArray(versions) ? versions : [])) { const s = String(v == null ? '' : v).trim(); if (s && set.indexOf(s) < 0) set.push(s); }
  return set.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

// ---------- 区间计算 ：(from, to] ----------
// orderedTags：**升序**（旧→新）git tag 列表（调用方把 listVersions 倒序结果 reverse 后传入）。
// from：现场版本；to：目标版本。返回落在 (from, to] 区间的 tag（升序）。
// 规则：
//   · to 在列表里 → 取 index(to)；to 不在列表 → 兜底取「≤ 语义位置的最大已知 tag」——本模块无版本号解析器，
//     故 to 不在列表时按「to 之前全部 tag（含末尾）」尽力兜底：视 to 落在列表末尾（取全部 > from 的 tag）。
//   · from 在列表里 → 取 index(from)，结果为 (index(from), index(to)]（严格大于 from、≤ to）。
//   · from 不在列表（含空/未跟踪）→ 视 from 为「最早」，取所有 ≤ to 的 tag（include 全部 ≤to）。
// 返回的是**已登记与否无关**的候选 tag 区间；调用方再与 version-releases.json 交集取「已登记」版本。
export function rangeVersions(orderedTags, from, to) {
  const tags = Array.isArray(orderedTags) ? orderedTags.map(String) : [];
  if (!tags.length) return [];
  const f = String(from == null ? '' : from).trim();
  const t = String(to == null ? '' : to).trim();

  // 目标版本 to 的截止位置（含）：命中列表 → 该 index；未命中 → 视为列表末尾（尽力兜底 include 到最新）。
  let toIdx = tags.indexOf(t);
  if (toIdx < 0) toIdx = tags.length - 1;

  // 起点 from 的位置（不含）：命中 → 从 index(from)+1 起（严格大于）；未命中/空 → 从 0 起（include 全部 ≤to）。
  let fromIdx = f ? tags.indexOf(f) : -1;      // -1 表示 from 不在列表 → 从头 include
  const startIdx = fromIdx + 1;                 // fromIdx=-1 → start=0（含最早）；命中 → 跳过 from 本身

  if (startIdx > toIdx) return [];              // 空区间（from≥to，或 from 已是最新等）
  return tags.slice(startIdx, toIdx + 1);       // (from, to] 升序
}

// ---------- 累积汇总（跨版本 · 从代码读来的各版本 manifest）----------
// versionsInRange：rangeVersions 结果（升序 tag）。manifestByVersion：{[version]:{tasks:[{gid,title,desc,subsystem}], sql:[{gid,file,desc,content,subsystem}]}}
//   （每个 version 的 manifest 已是「该版本区间所有子系统聚合后」的规范化结果，见 server.readDeployManifest）。
// 只汇总**有清单**的版本（该 version 有 tasks 或 sql）；无清单的 tag 跳过（不进 versionsInRange）。
// 返回：
//   versionsInRange：实际有清单的版本（升序）；
//   tasks：[{version, id(=gid 全局唯一), title, desc, subsystem}]（逐条完成态用 (version,id)）；
//   sqls： [{version, id(=gid), name(=file 或 desc·展示/合并用), file, content, subsystem}]（合并为一个点）。
export function accumulateManifests(versionsInRange, manifestByVersion) {
  const byV = manifestByVersion && typeof manifestByVersion === 'object' ? manifestByVersion : {};
  const tasks = [];
  const sqls = [];
  const withManifest = [];
  for (const v of (Array.isArray(versionsInRange) ? versionsInRange : [])) {
    const m = byV[v];
    if (!m || typeof m !== 'object') continue;
    const vt = Array.isArray(m.tasks) ? m.tasks : [];
    const vs = Array.isArray(m.sql) ? m.sql : [];
    if (!vt.length && !vs.length) continue;              // 该版本无清单 → 跳过
    withManifest.push(v);
    for (const t of vt) tasks.push({ version: v, id: t.gid || t.id, title: t.title || '', desc: t.desc || '', subsystem: t.subsystem || '' });
    for (const s of vs) {
      const name = String((s.file || s.desc || s.id || '') || '');   // 展示名 = file（相对路径）优先，其次 desc
      // repoPath 透传（若 manifest 项带了 · server 侧用于合并下载时 readSqlAtTag 定位文件正文；纯逻辑测试里可无）
      sqls.push({ version: v, id: s.gid || s.id, name, file: s.file || '', desc: s.desc || '', content: String(s.content == null ? '' : s.content), subsystem: s.subsystem || '', repoPath: s.repoPath || '' });
    }
  }
  return { versionsInRange: withManifest, tasks, sqls };
}

// ---------- 完成态左连 ----------
// items：accumulate 产出的 tasks 或 sqls（各带 version + id）。progress：customer.updateProgress[productId]，
//   形状 {[version]:{tasks:{[taskId]:{done,by,at}}, sqls:{[sqlId]:{done,by,at}}}}。kind:'tasks'|'sqls'。
// 返回每项挂上 done/by/at（未完成 → done:false/空）+ 汇总 {done,total}。
export function joinProgress(items, progress, kind) {
  const prog = progress && typeof progress === 'object' ? progress : {};
  const list = Array.isArray(items) ? items : [];
  let done = 0;
  const rows = list.map(it => {
    const vp = prog[it.version] && typeof prog[it.version] === 'object' ? prog[it.version] : {};
    const bucket = vp[kind] && typeof vp[kind] === 'object' ? vp[kind] : {};
    const st = bucket[it.id];
    const isDone = !!(st && st.done);
    if (isDone) done++;
    return Object.assign({}, it, { done: isDone, by: (st && st.by) || '', at: (st && st.at) || '' });
  });
  return { rows, done, total: list.length };
}

// ---------- 合并 SQL「单点完成态」（一份合并文件 = 一个完成标记，非逐脚本）----------
// 2026-08-04 用户反馈 re-target：整个版本区间的 SQL 合并成一个文件，在任务清单里体现为**一个条目**、**一个完成态**。
//   存储：customer.updateProgress[productId][targetVersion].sqlBundle = { done, by, at }（targetVersion = 本次更新目标版本）。
//   —— 与逐条 tasks/sqls 桶并存不冲突（sqlBundle 是 version 对象下的独立键，非 tasks/sqls 桶）。
//
// 汇总合并 SQL 为「一个点」：给 accumulate 出来的 sqls（升序·带 version），产出前端展示所需摘要（不含明细正文）。
//   progress = customer.updateProgress[productId]；targetVersion = 本次目标版本（完成态挂它下）。
//   返回 { hasSql, scriptCount, versions:[去重升序], done, by, at }。
export function sqlBundleSummary(accSqls, progress, targetVersion) {
  const list = Array.isArray(accSqls) ? accSqls : [];
  const scriptCount = list.length;
  const versions = [];
  for (const s of list) { if (s && s.version && versions.indexOf(s.version) < 0) versions.push(s.version); }
  const prog = progress && typeof progress === 'object' ? progress : {};
  const v = String(targetVersion || '');
  const vp = prog[v] && typeof prog[v] === 'object' ? prog[v] : {};
  const st = vp.sqlBundle && typeof vp.sqlBundle === 'object' ? vp.sqlBundle : null;
  return {
    hasSql: scriptCount > 0,
    scriptCount,
    versions,
    done: !!(st && st.done),
    by: (st && st.by) || '',
    at: (st && st.at) || ''
  };
}

// 应用一次「合并 SQL 单点」勾选/取消（幂等）：写 progress[targetVersion].sqlBundle = {done,by,at}（假删）。
//   与 applyToggle 同风格逐层浅拷贝、不改入参。kind 由调用方判定（这是 SQL 单点专用，非逐脚本）。
export function applySqlBundleToggle(progress, targetVersion, done, by, at) {
  const src = progress && typeof progress === 'object' ? progress : {};
  const v = String(targetVersion || '');
  const next = Object.assign({}, src);
  const curV = (next[v] && typeof next[v] === 'object') ? next[v] : {};
  const nextV = Object.assign({}, curV);
  if (done) {
    if (nextV.sqlBundle && nextV.sqlBundle.done) return { progress: next, changed: false };   // 幂等：已完成
    nextV.sqlBundle = { done: true, by: clip(by, 40), at: clip(at, 40) };
  } else {
    if (!('sqlBundle' in nextV)) return { progress: next, changed: false };                    // 幂等：本就未完成
    delete nextV.sqlBundle;
  }
  next[v] = nextV;
  return { progress: next, changed: true };
}

// ---------- 应用一次勾选/取消（幂等·(医院×产品×版本×条目) 作用域）----------
// progress：customer.updateProgress[productId]（可空）；version/kind('tasks'|'sqls')/itemId/done/by/at。
// done 真 → 写 progress[version][kind][itemId]={done,by,at}；done 假 → 删该键（假删）。
// 返回 { progress: 新对象（不改入参·深拷贝相关层）, changed }。
export function applyToggle(progress, version, kind, itemId, done, by, at) {
  const src = progress && typeof progress === 'object' ? progress : {};
  const v = String(version || '');
  const k = kind === 'sqls' ? 'sqls' : 'tasks';
  const id = String(itemId || '');
  // 逐层浅拷贝需要改的分支，其它层复用引用（不改入参）。
  const next = Object.assign({}, src);
  const curV = (next[v] && typeof next[v] === 'object') ? next[v] : {};
  const nextV = Object.assign({}, curV);
  const curB = (nextV[k] && typeof nextV[k] === 'object') ? nextV[k] : {};
  const nextB = Object.assign({}, curB);
  if (done) {
    const cur = nextB[id];
    if (cur && cur.done) return { progress: next, changed: false };          // 幂等：已完成
    nextB[id] = { done: true, by: clip(by, 40), at: clip(at, 40) };
  } else {
    if (!(id in nextB)) return { progress: next, changed: false };           // 幂等：本就未完成
    delete nextB[id];
  }
  nextV[k] = nextB;
  next[v] = nextV;
  return { progress: next, changed: true };
}

// ---------- 合并 SQL 为单文件 ----------
// sqls：accumulateManifests 产出（升序·各带 version/name/file/content/subsystem；content 已由 server 用 git show 读入正文）。
//   meta：{productName, from, to, site}（文件头注释用）。
// 按版本升序（sqls 已升序）拼成一个 .sql 文本：文件头注释 + 每段前分隔注释 `-- ==== <产品> <版本> <子系统> <文件/脚本> ====`。
// 无 SQL → 也回一个含说明注释的文本（别 500）。
export function mergeSql(sqls, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const productName = clip(m.productName, 120) || '（未知产品）';
  const from = clip(m.from, 60);
  const to = clip(m.to, 60);
  const site = clip(m.site, 120);
  const list = Array.isArray(sqls) ? sqls : [];
  const lines = [];
  lines.push('-- =========================================================');
  lines.push('-- 更新 SQL 合并脚本（按版本升序累积 · 从产品代码 docs/deploy.json 读取）');
  lines.push('-- 产品：' + productName);
  lines.push('-- 医院：' + (site || '（未指定）'));
  lines.push('-- 版本区间：(' + (from || '最早') + ', ' + (to || '?') + ']');
  lines.push('-- 脚本段数：' + list.length);
  lines.push('-- 说明：请按顺序在目标库手动执行；执行完毕后到系统勾选「已执行」。');
  lines.push('-- =========================================================');
  lines.push('');
  if (!list.length) {
    lines.push('-- （该版本区间暂无 SQL 脚本；产品代码中未在 docs/deploy.json 声明本区间 SQL）');
    lines.push('');
    return lines.join('\n');
  }
  for (const s of list) {
    const label = (s.file || s.name || '（未命名）');
    lines.push('');
    lines.push('-- ==== ' + productName + ' ' + (s.version || '') + ' ' + (s.subsystem || '（默认）') + ' ' + label + ' ====');
    if (s.desc) lines.push('-- 说明：' + s.desc);
    const content = String(s.content == null ? '' : s.content).replace(/\s+$/, '');
    lines.push(content || '-- （脚本正文为空或读取失败）');
    // 段间补空行分隔（不强改用户 SQL）
    lines.push('');
  }
  return lines.join('\n');
}

// ===== 2026-08-05 核心更新流重构：批次快照完成度（per 批次 × 医院）=====
//   实施侧读的是 batch.deployPlan 快照（发包时审核冻结的一整份 tasks/sql，**无 version 概念**），
//   完成度存 customer.updateProgress[batchId] = { tasks:{[id]:{done,by,at}}, sqlBundle:{done,by,at} }。
//   与旧的 [productId][version] 结构键空间不撞（batchId 有前缀），normCustomer 用 'updateProgress' in b 保留。

// 快照任务左连完成度：tasks=快照 deployPlan.tasks（各带 id）；prog = customer.updateProgress[batchId]（形状 {tasks:{},sqlBundle:{}}）。
//   返回每项挂 done/by/at + 汇总 {rows,done,total}。
export function joinBatchProgress(tasks, prog) {
  const p = prog && typeof prog === 'object' ? prog : {};
  const bucket = p.tasks && typeof p.tasks === 'object' ? p.tasks : {};
  const list = Array.isArray(tasks) ? tasks : [];
  let done = 0;
  const rows = list.map(t => {
    const st = bucket[t.id];
    const isDone = !!(st && st.done);
    if (isDone) done++;
    return { id: t.id, title: t.title || '', desc: t.desc || '', done: isDone, by: (st && st.by) || '', at: (st && st.at) || '' };
  });
  return { rows, done, total: list.length };
}

// 快照 SQL 单点汇总：sql=快照 deployPlan.sql（各带 id/title/desc/content）；prog = customer.updateProgress[batchId]。
//   返回 { hasSql, scriptCount, done, by, at }（一整份合并 = 一个完成点，挂 prog.sqlBundle）。
export function batchSqlSummary(sqlItems, prog) {
  const list = Array.isArray(sqlItems) ? sqlItems : [];
  const p = prog && typeof prog === 'object' ? prog : {};
  const st = p.sqlBundle && typeof p.sqlBundle === 'object' ? p.sqlBundle : null;
  return { hasSql: list.length > 0, scriptCount: list.length, done: !!(st && st.done), by: (st && st.by) || '', at: (st && st.at) || '' };
}

// 应用一次快照任务勾选/取消（幂等·不改入参）：prog=customer.updateProgress[batchId]（可空）→ 写/删 prog.tasks[id]。
export function applyBatchTaskToggle(prog, itemId, done, by, at) {
  const src = prog && typeof prog === 'object' ? prog : {};
  const id = String(itemId || '');
  const next = Object.assign({}, src);
  const curB = next.tasks && typeof next.tasks === 'object' ? next.tasks : {};
  const nextB = Object.assign({}, curB);
  if (done) {
    if (nextB[id] && nextB[id].done) return { progress: next, changed: false };   // 幂等
    nextB[id] = { done: true, by: clip(by, 40), at: clip(at, 40) };
  } else {
    if (!(id in nextB)) return { progress: next, changed: false };
    delete nextB[id];
  }
  next.tasks = nextB;
  return { progress: next, changed: true };
}

// 应用一次快照 SQL 单点勾选/取消（幂等·不改入参）：prog=customer.updateProgress[batchId] → 写/删 prog.sqlBundle。
export function applyBatchSqlToggle(prog, done, by, at) {
  const src = prog && typeof prog === 'object' ? prog : {};
  const next = Object.assign({}, src);
  if (done) {
    if (next.sqlBundle && next.sqlBundle.done) return { progress: next, changed: false };
    next.sqlBundle = { done: true, by: clip(by, 40), at: clip(at, 40) };
  } else {
    if (!('sqlBundle' in next)) return { progress: next, changed: false };
    delete next.sqlBundle;
  }
  return { progress: next, changed: true };
}

// 合并快照 SQL 为单文件（正文已冻结在快照里，无需读 git）。items=deployPlan.sql（各带 title/desc/content）。
//   meta：{productName, from, to, site}。按快照顺序拼接 + 分隔注释。空 → 含说明注释不抛错。
export function mergeBatchSql(items, meta) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const productName = clip(m.productName, 120) || '（未知产品）';
  const from = clip(m.from, 60);
  const to = clip(m.to, 60);
  const site = clip(m.site, 120);
  const list = Array.isArray(items) ? items : [];
  const lines = [];
  lines.push('-- =========================================================');
  lines.push('-- 更新 SQL 合并脚本（发包时审核冻结的批次快照 · 正文已固化）');
  lines.push('-- 产品：' + productName);
  lines.push('-- 医院：' + (site || '（未指定）'));
  lines.push('-- 版本区间：(' + (from || '最早') + ', ' + (to || '?') + ']');
  lines.push('-- 脚本段数：' + list.length);
  lines.push('-- 说明：请按顺序在目标库手动执行；执行完毕后到系统勾选「已执行」。');
  lines.push('-- =========================================================');
  lines.push('');
  if (!list.length) {
    lines.push('-- （该批次快照暂无 SQL 脚本）');
    lines.push('');
    return lines.join('\n');
  }
  for (const s of list) {
    const label = clip(s && s.title, 200) || '（未命名）';
    lines.push('');
    lines.push('-- ==== ' + productName + ' ' + label + ' ====');
    if (s && s.desc) lines.push('-- 说明：' + clip(s.desc, 200));
    const content = String((s && s.content) == null ? '' : s.content).replace(/\s+$/, '');
    lines.push(content || '-- （脚本正文为空）');
    lines.push('');
  }
  return lines.join('\n');
}

// 越权判断（复用现场端 sites 收敛口径）：管理员不限；否则 site 必须 ∈ user.sites。与 checklist-logic.siteAllowed 一致。
export function siteAllowed(isAdminFlag, userSites, site) {
  if (isAdminFlag) return true;
  const nm = String(site || '').trim();
  const sites = Array.isArray(userSites) ? userSites.map(String) : [];
  return sites.includes(nm);
}
