// FS-09 · 实施端「个人全览图」纯逻辑（可脱 DB/server 单测：tools/fs-09-overview.logic.test.mjs）
//   编排器 server.mjs 的 GET /api/field/overview 只做「取数（按 user.sites+projects 收敛）+ 调这里的纯函数聚合」，
//   本模块不碰 I/O、不读文件、不认 http——只吃已收敛好的工单/批次/客户/产品数组，吐医院卡 + 产品卡。
//
//   ⚠️ 字段映射一律沿用 server.mjs 现成口径（禁止臆造库表/列，见 CLAUDE.md §4 / lessons）：
//     · 工单 it.site = 医院名（== customer.name，见 custWithTicketCount/customer-version 均按 name 匹配）；
//       it.subsystem = 英文 key；it.priority ∈ {紧急,高,中,低}；it.lifecycle = 中文态；it.updatedAt = 'yyyy-MM-dd HH:mm'。
//     · customer {name, maintainEnd:'yyyy-MM-dd', products:[{project, subsystems:[{name,version}] | version}]}；
//       版本读法与 custSubVersion(cust, productId, subsystem) 一致（按 s.name===subsystem）。
//     · batch {id, product, status:'开发中'|'可下载'|'已交付', pkgVersion, scheduleDate:'yyyy-MM-dd', ticketIds:[], downloadedBy:[username]}。
//     · 4 阶段归并统一走注入的 fieldStatusLabel(lc).label 再套一层小 map（保证与用户已见到的现场状态标签一致）。

// 现场 4 阶段桶。fieldStatusLabel(lc).label ∈
//   {待评审, 已受理·排期, 开发中, 待验证, 已答复, 本包已含, 已关闭} → 归并到 4 桶：
export const STAGE_KEYS = ['review', 'dev', 'verify', 'closed'];
export const STAGE_LABELS = { review: '待评审', dev: '开发中', verify: '待验证', closed: '已关闭' };
// 现场状态标签 → 4 桶（与需求口径一字对齐）
const LABEL_TO_STAGE = {
  '待评审': 'review',
  '已受理·排期': 'dev', '开发中': 'dev',
  '待验证': 'verify',
  '已关闭': 'closed', '本包已含': 'closed', '已答复': 'closed',
};

// 把一条工单的 lifecycle 归并到 4 桶之一。fieldStatusLabelFn 由调用方注入（= server.mjs 的 fieldStatusLabel），
//   保证归并结果与用户在提交清单/批次里看到的状态标签同源。未识别标签兜底进「待评审」（不静默丢）。
export function stageOf(lc, fieldStatusLabelFn) {
  const label = (fieldStatusLabelFn ? (fieldStatusLabelFn(lc) || {}).label : '') || lc || '';
  return LABEL_TO_STAGE[label] || 'review';
}

// 空的 4 阶段计数桶
export function emptyStages() { return { review: 0, dev: 0, verify: 0, closed: 0 }; }

// 紧急工单判据：priority ∈ {紧急,高} 且未关闭（stage !== closed）。
export function isUrgentOpen(it, stage) {
  const p = String((it && it.priority) || '');
  return (p === '紧急' || p === '高') && stage !== 'closed';
}

// 维保状态（date-only 归一，避免 off-by-one，见全局 lessons L048）。
//   maintainEnd 'yyyy-MM-dd'；today 传本地「今天」的 {y,mo,d}（调用方用 new Date() 取，便于测试注入固定日期）。
//   返回 { has, end, daysLeft, status:'normal'|'soon'|'expired'|'none' }。soon = 0<=daysLeft<=thresholdDays。
export function maintainStatus(maintainEnd, today, thresholdDays = 30) {
  const s = String(maintainEnd || '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return { has: false, end: '', daysLeft: null, status: 'none' };
  const end = Date.UTC(+m[1], +m[2] - 1, +m[3]);
  const t = Date.UTC(today.y, today.mo - 1, today.d);   // today 传 1-based 月
  const daysLeft = Math.round((end - t) / 86400000);
  let status;
  if (daysLeft < 0) status = 'expired';
  else if (daysLeft <= thresholdDays) status = 'soon';
  else status = 'normal';
  return { has: true, end: s, daysLeft, status };
}

// 从 new Date() 取本地「今天」的 {y,mo(1-based),d}
export function todayParts(d = new Date()) {
  return { y: d.getFullYear(), mo: d.getMonth() + 1, d: d.getDate() };
}

// 该医院该产品各子系统的现场版本（[{ subsystem, subsystemLabel, version }]，仅列有版本的），
//   版本读法与 custSubVersion 完全一致（新形状按 s.name===subsystem；旧形状产品级 version 落到「（整包）」）。
//   subLabelFn(productId, subName) 注入 = server.mjs 的 kbSubLabel（中文 desc）。
export function siteSubVersions(cust, productId, subLabelFn) {
  const out = [];
  if (!cust || !Array.isArray(cust.products)) return out;
  const pr = cust.products.find(p => p && p.project === productId);
  if (!pr) return out;
  if (Array.isArray(pr.subsystems)) {
    for (const s of pr.subsystems) {
      if (!s || !s.name) continue;
      const v = String(s.version || '').trim();
      if (!v) continue;
      out.push({ subsystem: s.name, subsystemLabel: subLabelFn ? subLabelFn(productId, s.name) : s.name, version: v });
    }
  } else if (String(pr.version || '').trim()) {
    out.push({ subsystem: '', subsystemLabel: '（整包）', version: String(pr.version).trim() });
  }
  return out;
}

// custSubVersion 的纯版本（同 server.mjs custSubVersion，供批次「本院是否已应用」比对）。
export function subVersionOf(cust, productId, subsystem) {
  if (!cust || !Array.isArray(cust.products)) return '';
  const pr = cust.products.find(p => p && p.project === productId);
  if (!pr) return '';
  if (Array.isArray(pr.subsystems)) { const ms = subsystem ? pr.subsystems.find(s => s && s.name === subsystem) : null; return (ms && ms.version) || ''; }
  return pr.version || '';
}

// 某批次覆盖了哪些「我负责医院」（site 名集合），且属该产品。ticketsForBatch = 该批次工单数组（已按 sites 收敛）。
//   返回覆盖到的 site 名去重数组。
export function batchSitesCovered(ticketsForBatch) {
  const set = new Set();
  for (const t of (ticketsForBatch || [])) { const s = String((t && t.site) || '').trim(); if (s) set.add(s); }
  return [...set];
}

// ============ 医院维度卡 ============
// mySites: 我负责医院名数组（收敛后，管理员传全部相关 site）。
// tickets: 已按 sites+projects 收敛的工单数组（requirement/bug，含 site/subsystem/priority/lifecycle/updatedAt/project）。
// batches: 全部批次（未按 site 过滤，函数内自己按覆盖判定；每个 batch 需带 _mineTickets = 该批我范围内覆盖工单数组）。
// custByName: Map(name → customer)。
// myProjects: 我负责产品 id 数组（null=不限，管理员）。projById(id)->{id,name}。username=当前账号。
// deps: { fieldStatusLabelFn, subLabelFn, projNameFn }
export function buildHospitalCards(mySites, tickets, batches, custByName, myProjects, username, deps) {
  const { fieldStatusLabelFn, subLabelFn, projNameFn } = deps || {};
  const tp = deps && deps.today ? deps.today : todayParts();
  // 工单按 site 分桶
  const bySite = new Map();
  for (const it of tickets) {
    const site = String((it && it.site) || '').trim(); if (!site) continue;
    (bySite.get(site) || (bySite.set(site, []).get(site))).push(it);
  }
  const cards = [];
  for (const site of mySites) {
    const cust = custByName.get(site) || null;
    const its = bySite.get(site) || [];
    const stages = emptyStages();
    let urgent = 0; let lastUpdated = '';
    for (const it of its) {
      const lc = it.lifecycle || '';
      const st = stageOf(lc, fieldStatusLabelFn);
      stages[st]++;
      if (isUrgentOpen(it, st)) urgent++;
      const ua = it.updatedAt || it.submittedAt || '';
      if (ua > lastUpdated) lastUpdated = ua;
    }
    // 现场版本：仅我负责产品（myProjects null=不限）
    const versions = [];
    if (cust && Array.isArray(cust.products)) {
      for (const pr of cust.products) {
        const pid = pr && pr.project; if (!pid) continue;
        if (myProjects && !myProjects.includes(pid)) continue;
        const subs = siteSubVersions(cust, pid, subLabelFn);
        if (subs.length) versions.push({ product: pid, productName: projNameFn ? projNameFn(pid) : pid, subsystems: subs });
      }
    }
    // 下次更新 + 待下载：覆盖本院、状态可下载/已交付、我尚未下载（或本院尚未应用）
    let pendingDownload = 0; let nextUpdate = null;
    for (const bt of batches) {
      const mine = bt._mineTickets || [];
      const coversSite = mine.some(t => String((t && t.site) || '').trim() === site);
      if (!coversSite) continue;
      if (myProjects && !myProjects.includes(bt.product)) continue;
      const st = String(bt.status || '');
      if (st !== '可下载' && st !== '已交付') continue;
      const downloadedByMe = Array.isArray(bt.downloadedBy) && bt.downloadedBy.includes(username || '');
      // 本院是否已应用该包：本批覆盖本院的子系统里，只要有一个现场版本 != pkgVersion → 视为未应用
      const siteSubs = [...new Set(mine.filter(t => String((t && t.site) || '').trim() === site).map(t => String((t && t.subsystem) || '').trim()))];
      let applied = !!siteSubs.length && !!String(bt.pkgVersion || '').trim();
      for (const sub of siteSubs) { if (subVersionOf(cust, bt.product, sub) !== String(bt.pkgVersion || '').trim()) { applied = false; break; } }
      if (!downloadedByMe) pendingDownload++;
      if (!downloadedByMe || !applied) {
        // 取最近一条待更新（scheduleDate 最早的优先当「下次更新」）
        const cand = { batchId: bt.id, product: bt.product, productName: projNameFn ? projNameFn(bt.product) : bt.product, pkgVersion: bt.pkgVersion || '', scheduleDate: bt.scheduleDate || '', status: st };
        if (!nextUpdate) nextUpdate = cand;
        else {
          const a = nextUpdate.scheduleDate || '9999-99-99', b = cand.scheduleDate || '9999-99-99';
          if (b < a) nextUpdate = cand;
        }
      }
    }
    const mnt = maintainStatus(cust && cust.maintainEnd, tp);
    cards.push({
      site, hospitalName: site,
      hasCustomer: !!cust,
      maintainEnd: mnt.end, maintainDaysLeft: mnt.daysLeft, maintainStatus: mnt.status,
      stages, ticketTotal: its.length, urgent,
      versions,
      nextUpdate, pendingDownload,
      lastUpdated: lastUpdated || '',
    });
  }
  return cards;
}

// ============ 产品维度卡（跨我负责医院聚合总览）============
// myProjects: 我负责产品 id 数组（null=不限时由调用方传 batches/tickets 里出现的产品集合）。
// tickets/batches: 已收敛（同上）。custByName: Map(name→customer)。mySites: 我负责医院名集合（Set 或数组）。
export function buildProductCards(productIds, tickets, batches, custByName, mySites, username, deps) {
  const { fieldStatusLabelFn, subLabelFn, projNameFn } = deps || {};
  const mySiteSet = new Set((Array.isArray(mySites) ? mySites : [...(mySites || [])]).map(String));
  const cards = [];
  for (const pid of productIds) {
    // 该产品下我负责且装了该产品的医院集合
    const hospSet = new Set();
    for (const site of mySiteSet) {
      const cust = custByName.get(site);
      if (cust && Array.isArray(cust.products) && cust.products.some(p => p && p.project === pid)) hospSet.add(site);
    }
    // 工单总况（跨院聚合 · 仅该产品 · 仅我负责医院）。
    //   端点已用 scopedForField 按 sites 收敛；此处再按 mySiteSet 兜底（mySiteSet 空=管理员不限，全算），纵深防御越权数据混入。
    const stages = emptyStages();
    let urgent = 0;
    const restrictSites = mySiteSet.size > 0;
    for (const it of tickets) {
      if (String((it && it.project) || '') !== pid) continue;
      const s = String((it && it.site) || '').trim();
      if (restrictSites && !mySiteSet.has(s)) continue;   // 越权医院的单不计入聚合（纵深防御）
      const st = stageOf(it.lifecycle || '', fieldStatusLabelFn);
      stages[st]++;
      if (isUrgentOpen(it, st)) urgent++;
      if (s) hospSet.add(s);   // 有单的院也算装了该产品
    }
    // 各医院版本分布：按子系统分组 → { subsystem, subsystemLabel, versions:[{version, hospitals:[site]}] }
    const subMap = new Map();   // subName → Map(version → Set(site))
    for (const site of hospSet) {
      const cust = custByName.get(site); if (!cust) continue;
      for (const sv of siteSubVersions(cust, pid, subLabelFn)) {
        if (!subMap.has(sv.subsystem)) subMap.set(sv.subsystem, new Map());
        const vm = subMap.get(sv.subsystem);
        (vm.get(sv.version) || (vm.set(sv.version, new Set()).get(sv.version))).add(site);
      }
    }
    const versionDist = [];
    for (const [sub, vm] of subMap.entries()) {
      const versions = [...vm.entries()].map(([version, sites]) => ({ version, hospitals: [...sites] }))
        .sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }));
      versionDist.push({ subsystem: sub, subsystemLabel: subLabelFn ? subLabelFn(pid, sub) : sub, versions });
    }
    versionDist.sort((a, b) => String(a.subsystemLabel).localeCompare(String(b.subsystemLabel)));
    // 待发布/待更新提醒
    const reminders = [];
    for (const bt of batches) {
      if (bt.product !== pid) continue;
      const mine = bt._mineTickets || [];
      const coveredSites = batchSitesCovered(mine).filter(s => hospSet.has(s));
      if (!coveredSites.length) continue;
      const st = String(bt.status || '');
      if (st === '开发中') {
        reminders.push({ kind: 'pending-release', batchId: bt.id, pkgVersion: bt.pkgVersion || '', status: st, scheduleDate: bt.scheduleDate || '', coverSites: coveredSites.length });
      } else if (st === '可下载' || st === '已交付') {
        // 有院未应用 pkgVersion → 待更新
        let anyPending = false;
        for (const site of coveredSites) {
          const cust = custByName.get(site);
          const siteSubs = [...new Set(mine.filter(t => String((t && t.site) || '').trim() === site).map(t => String((t && t.subsystem) || '').trim()))];
          for (const sub of siteSubs) { if (subVersionOf(cust, pid, sub) !== String(bt.pkgVersion || '').trim()) { anyPending = true; break; } }
          if (anyPending) break;
        }
        if (anyPending) reminders.push({ kind: 'pending-update', batchId: bt.id, pkgVersion: bt.pkgVersion || '', status: st, scheduleDate: bt.scheduleDate || '', coverSites: coveredSites.length });
      }
    }
    cards.push({
      product: pid, productName: projNameFn ? projNameFn(pid) : pid,
      hospitalCount: hospSet.size,
      stages, ticketTotal: stages.review + stages.dev + stages.verify + stages.closed, urgent,
      versionDist, reminders,
    });
  }
  return cards;
}
