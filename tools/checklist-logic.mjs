// ===== 现场实施代办清单 · 纯文件存逻辑（可独立测试，不依赖 MySQL / 不 spawn server） =====
// 供 server.mjs import 复用 + tools/fs-06-checklist.logic.test.mjs 单测。
// 两个场景：
//   · 场景1 部署清单：标准模板（data/deploy-template.json）自动套用每院，每院完成态 overlay 存 customer.deployTasks（只存已完成项）。
//   · 场景2 更新包清单：每个批次一份 implTasks（全局完成态直接挂项上），谁勾了就算完成。

// 文本截断（对齐 server.mjs 范式：String→trim→slice）。
export function clip(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }

// 生成清单项 id：'t' + 4字节 hex（与 server.mjs custGenId 同范式，测试里可注入 gen 保证确定性）。
export function genTaskId(rand) { return 't' + (rand ? rand() : Math.random().toString(16).slice(2, 10).padEnd(8, '0')); }

// ---------- 场景1：标准部署清单模板 ----------
// 规范化一份模板任务列表：title 必填（空则丢弃），title≤120 / desc≤1000，缺 id 补新 id，按 id 去重。
export function normTemplateTasks(tasks, genId) {
  const gen = genId || (() => genTaskId());
  const seen = new Set();
  const out = [];
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    const title = clip(t && t.title, 120);
    if (!title) continue;                                  // title 非空校验（空项丢弃）
    let id = clip(t && t.id, 40) || gen();
    if (seen.has(id)) id = gen();                          // id 冲突 → 重新分配，保证唯一
    seen.add(id);
    out.push({ id, title, desc: clip(t && t.desc, 1000) });
    if (out.length >= 200) break;                          // 上限护栏
  }
  return out;
}

// 部署进度：以「模板项（live）」为分母，customer.deployTasks 里 done:true 的项为分子。
//   模板项增删即时对所有医院生效（分母变），deployTasks 里指向已删模板项的完成态不计入分子（overlay 语义）。
export function deployProgress(templateTasks, deployTasks) {
  const tpl = Array.isArray(templateTasks) ? templateTasks : [];
  const dt = deployTasks && typeof deployTasks === 'object' ? deployTasks : {};
  const total = tpl.length;
  let done = 0;
  for (const t of tpl) { const st = dt[t && t.id]; if (st && st.done) done++; }
  return { done, total };
}

// 模板项 + 某院完成态 → 渲染行（left join：模板为主，overlay 完成态）。空模板 → []。
export function deployRows(templateTasks, deployTasks) {
  const dt = deployTasks && typeof deployTasks === 'object' ? deployTasks : {};
  return (Array.isArray(templateTasks) ? templateTasks : []).map(t => {
    const st = dt[t && t.id];
    return {
      id: t.id, title: t.title || '', desc: t.desc || '',
      done: !!(st && st.done), by: (st && st.by) || '', at: (st && st.at) || ''
    };
  });
}

// 应用一次部署清单勾选/取消（幂等）：done 真 → 写完成态；done 假 → 删该键。
//   返回 { deployTasks, changed }（deployTasks 为新对象，不改入参）。taskId 须 ∈ 模板（由调用方先校验）。
export function applyDeployToggle(deployTasks, taskId, done, by, at) {
  const src = deployTasks && typeof deployTasks === 'object' ? deployTasks : {};
  const next = Object.assign({}, src);
  if (done) {
    const cur = next[taskId];
    if (cur && cur.done) return { deployTasks: next, changed: false };   // 幂等：已完成不重复写
    next[taskId] = { done: true, by: clip(by, 40), at: clip(at, 40) };
    return { deployTasks: next, changed: true };
  } else {
    if (!(taskId in next)) return { deployTasks: next, changed: false }; // 幂等：本就未完成
    delete next[taskId];
    return { deployTasks: next, changed: true };
  }
}

// ---------- 场景2：更新包实施任务清单（batch.implTasks） ----------
// 合并一份运营定义的 implTasks（模板：[{id?,title,desc}]）到批次现有 implTasks，
//   保留各项已存在的 done/doneBy/doneAt（按 id 合并），新项 done=false；title 空丢弃、截断。
//   顺序以传入 tasks 为准（运营可增删改排序）；未在新列表里的旧项被移除（运营删项即删）。
export function mergeImplTasks(existing, tasks, genId) {
  const gen = genId || (() => genTaskId());
  const oldById = new Map();
  for (const t of (Array.isArray(existing) ? existing : [])) { if (t && t.id) oldById.set(t.id, t); }
  const seen = new Set();
  const out = [];
  for (const t of (Array.isArray(tasks) ? tasks : [])) {
    const title = clip(t && t.title, 120);
    if (!title) continue;
    let id = clip(t && t.id, 40) || gen();
    if (seen.has(id)) id = gen();
    seen.add(id);
    const prev = oldById.get(id);
    out.push({
      id, title, desc: clip(t && t.desc, 1000),
      done: !!(prev && prev.done),
      doneBy: (prev && prev.doneBy) || '',
      doneAt: (prev && prev.doneAt) || ''
    });
    if (out.length >= 200) break;
  }
  return out;
}

// 应用一次批次清单项全局勾选/取消（幂等）：done 真 → done+doneBy+doneAt；done 假 → 清 done/doneBy/doneAt。
//   就地找 implTasks 里 id===taskId 的项改之；返回 { changed, item }。不存在该项 → { changed:false, item:null }。
export function applyBatchTaskToggle(implTasks, taskId, done, by, at) {
  const list = Array.isArray(implTasks) ? implTasks : [];
  const it = list.find(x => x && x.id === taskId);
  if (!it) return { changed: false, item: null };
  const want = !!done;
  if (!!it.done === want) return { changed: false, item: it };            // 幂等：同态不重复写
  it.done = want;
  if (want) { it.doneBy = clip(by, 40); it.doneAt = clip(at, 40); }
  else { it.doneBy = ''; it.doneAt = ''; }
  return { changed: true, item: it };
}

// 批次清单进度：done:true 的项数 / 总项数。
export function implProgress(implTasks) {
  const list = Array.isArray(implTasks) ? implTasks : [];
  let done = 0;
  for (const t of list) { if (t && t.done) done++; }
  return { done, total: list.length };
}

// 越权判断（复用现场端 sites 收敛口径）：管理员(isAdmin)不限；否则 site 必须 ∈ user.sites。
//   返回 true=允许，false=越权。与 customer-version/customer-maintain 完全一致的判据，抽出可测。
export function siteAllowed(isAdminFlag, userSites, site) {
  if (isAdminFlag) return true;
  const nm = String(site || '').trim();
  const sites = Array.isArray(userSites) ? userSites.map(String) : [];
  return sites.includes(nm);
}
