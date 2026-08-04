// ===== 更新包「按版本独立维护 + 跨版本累积」· 纯逻辑（可独立测试，不依赖 MySQL / 不 spawn server / 不碰 git）=====
// 供 server.mjs import 复用 + tools/version-plan.logic.test.mjs 单测。
//
// 模型（用户拍板，别改规则）：
//   1) 运营按「产品 × 版本(git tag)」登记该版本的 delta 实施任务 + delta SQL 脚本（存 data/version-releases.json）。
//   2) 实施在某院把某产品升到「目标版本 Y」→ 按该院该产品的现场版本 X → Y，取 (X, Y] 区间内所有【已登记】版本的
//      任务 + SQL 累积并集，按版本升序展示。
//   3) SQL 系统不碰库，只列出；实施手动跑、逐个勾「已执行」。
//   4) SQL 到现场可合并成一个 .sql 文件下载（按版本序 + 分隔注释）。
//   5) 版本号来源 = git tag（listVersions）。累积起点 = 现场版本。
//   6) 完成度按 (医院 × 产品 × 版本 × 条目) 记（customer.updateProgress）。
//
// 版本序说明：listVersions(proj) 返回**倒序**（新→旧）。本模块所有入参 orderedTags 统一约定为
//   「**升序**（旧→新）」——调用方（server.mjs）传入前先 reverse。区间/合并都按升序处理，展示天然旧→新。

// 文本截断（对齐 server.mjs / checklist-logic 范式：String→trim→slice）。
export function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

// 生成 id：prefix + 4字节 hex（测试里可注入 gen 保证确定性）。
export function genId(prefix, rand) { return String(prefix || 'v') + (rand ? rand() : Math.random().toString(16).slice(2, 10).padEnd(8, '0')); }

// ---------- 版本发版登记规范化 ----------
// 规范化一个版本的 delta 任务列表：title 必填（空丢弃），title≤120 / desc≤2000，缺 id 补 'vt'+，按 id 去重，上限 200。
export function normVersionTasks(tasks, gen) {
  const g = gen || (() => genId('vt'));
  const seen = new Set();
  const out = [];
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    const title = clip(t && t.title, 120);
    if (!title) continue;
    let id = clip(t && t.id, 40) || g();
    if (seen.has(id)) id = g();
    seen.add(id);
    out.push({ id, title, desc: clip(t && t.desc, 2000) });
    if (out.length >= 200) break;
  }
  return out;
}

// 规范化一个版本的 delta SQL 列表：name 必填（空丢弃），name≤120 / content≤20000，缺 id 补 'vs'+，按 id 去重，上限 200。
export function normVersionSqls(sqls, gen) {
  const g = gen || (() => genId('vs'));
  const seen = new Set();
  const out = [];
  for (const s of (Array.isArray(sqls) ? sqls : [])) {
    const name = clip(s && s.name, 120);
    if (!name) continue;
    let id = clip(s && s.id, 40) || g();
    if (seen.has(id)) id = g();
    seen.add(id);
    // SQL 正文只做长度截断 + 去掉首尾空白；不改内容语义（保留换行/缩进）。
    out.push({ id, name, content: String(s && s.content != null ? s.content : '').slice(0, 20000) });
    if (out.length >= 200) break;
  }
  return out;
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

// ---------- 累积汇总（任务 + SQL）----------
// versionsInRange：rangeVersions 结果（升序 tag）。releases：{[version]:{tasks:[],sqls:[]}}（该产品的登记）。
// 只汇总**已登记**的版本（releases 里有该 version 且有 tasks/sqls）；未登记的 tag 跳过。
// 返回 { versionsInRange（实际有登记的·升序）, tasks:[{version,id,title,desc}], sqls:[{version,id,name,content}] }。
export function accumulate(versionsInRange, releases) {
  const rel = releases && typeof releases === 'object' ? releases : {};
  const tasks = [];
  const sqls = [];
  const registered = [];
  for (const v of (Array.isArray(versionsInRange) ? versionsInRange : [])) {
    const r = rel[v];
    if (!r || typeof r !== 'object') continue;
    const vt = Array.isArray(r.tasks) ? r.tasks : [];
    const vs = Array.isArray(r.sqls) ? r.sqls : [];
    if (!vt.length && !vs.length) continue;              // 该版本无任何登记内容 → 跳过（不进 versionsInRange）
    registered.push(v);
    for (const t of vt) tasks.push({ version: v, id: t.id, title: t.title || '', desc: t.desc || '' });
    for (const s of vs) sqls.push({ version: v, id: s.id, name: s.name || '', content: String(s.content == null ? '' : s.content) });
  }
  return { versionsInRange: registered, tasks, sqls };
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
// sqls：accumulate 产出（升序·各带 version/name/content）。meta：{productName, from, to, site}（文件头注释用）。
// 按版本升序（sqls 已升序）拼成一个 .sql 文本：文件头注释 + 每段前分隔注释（产品·版本·脚本名）。
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
  lines.push('-- 更新 SQL 合并脚本（按版本升序累积）');
  lines.push('-- 产品：' + productName);
  lines.push('-- 医院：' + (site || '（未指定）'));
  lines.push('-- 版本区间：(' + (from || '最早') + ', ' + (to || '?') + ']');
  lines.push('-- 脚本段数：' + list.length);
  lines.push('-- 说明：请按顺序在目标库手动执行；逐段执行后到系统勾选「已执行」。');
  lines.push('-- =========================================================');
  lines.push('');
  if (!list.length) {
    lines.push('-- （该版本区间暂无已登记的 SQL 脚本）');
    lines.push('');
    return lines.join('\n');
  }
  let lastVer = null;
  for (const s of list) {
    if (s.version !== lastVer) {
      lines.push('');
      lines.push('-- ================ ' + productName + ' ' + (s.version || '') + ' ================');
      lastVer = s.version;
    }
    lines.push('-- 脚本：' + (s.name || '（未命名）') + '（版本 ' + (s.version || '') + '）');
    const content = String(s.content == null ? '' : s.content).replace(/\s+$/, '');
    lines.push(content);
    // 段间保证以分号+换行收尾感（不强改用户 SQL，只补空行分隔）
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
