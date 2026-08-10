// FS-09 · 实施端「个人全览图 / 全览」脱库逻辑测试
//   两部分：A. 纯聚合逻辑（tools/fs-09-overview-logic.mjs：阶段归并/维保/紧急/版本分布/下次更新/待下载/越权收敛）——用真实 fixture 直测；
//           B. 接线断言（server.mjs：端点存在 + 双白名单 + 按 sites+projects 收敛 + 复用现成 helper；field.html：全览入口/面板/内部滚动）。
//   本地无 customers.json + MySQL 常连不上（server boot 即 db.init 退出）——故纯逻辑抽到独立模块直测（连"真实字段结构"冒烟，见全局 lessons L040），
//   端到端连真库冒烟走 prod（见交付说明·已逐字段核对映射）。
//   用法：node --test tools/fs-09-overview.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  stageOf, emptyStages, isUrgentOpen, maintainStatus, siteSubVersions, subVersionOf,
  buildHospitalCards, buildProductCards, appliedToSite, STAGE_LABELS
} from './fs-09-overview-logic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD_HTML = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');

// 忠实复刻 server.mjs 的 FIELD_STATUS_MAP（lifecycle → 现场标签），保证归并口径与用户已见到的状态标签一致。
// （若 server 改了这份 map 而这里没同步，测试用的 fieldStatusLabel 会漂移——故下方 B 段加断言核对源里的 map 未变关键映射。）
const FIELD_STATUS_MAP = {
  '待处理': { label: '待评审' }, '已重开': { label: '待评审' }, '分析中': { label: '待评审' },
  '已立项': { label: '已受理·排期' }, '开发中': { label: '开发中' },
  '已回复': { label: '已答复' }, '已答复': { label: '已答复' },
  '已交付': { label: '本包已含' }, '待验证': { label: '待验证' },
  '已关闭': { label: '已关闭' }, '暂缓': { label: '已关闭' }, '已驳回': { label: '已关闭' },
};
const fieldStatusLabel = (lc) => FIELD_STATUS_MAP[lc] || { label: lc || '待评审' };
const kbSubLabel = (pid, sub) => ({ audit: '审方', report: '报表', pkb: '合理用药引擎' }[sub] || sub || '');
const projName = (id) => ({ hlyy: '合理用药系统', cx: '处方系统' }[id] || id);
const deps = (today) => ({ fieldStatusLabelFn: fieldStatusLabel, subLabelFn: kbSubLabel, projNameFn: projName, today });
const TODAY = { y: 2026, mo: 8, d: 10 };   // 固定"今天"=2026-08-10，避免测试随日期漂

/* ===================== A. 纯聚合逻辑 ===================== */

// A1 阶段归并：各 lifecycle 落对桶（与 fieldStatusLabel → 4 桶一字对齐）
test('A1 stageOf：lifecycle 各落对桶', () => {
  // 待评审桶：待处理/已重开/分析中
  for (const lc of ['待处理', '已重开', '分析中']) assert.equal(stageOf(lc, fieldStatusLabel), 'review', lc + '→待评审');
  // 开发中桶：已立项(已受理·排期)/开发中
  for (const lc of ['已立项', '开发中']) assert.equal(stageOf(lc, fieldStatusLabel), 'dev', lc + '→开发中');
  // 待验证桶
  assert.equal(stageOf('待验证', fieldStatusLabel), 'verify', '待验证→待验证');
  // 已关闭桶：已关闭/已交付(本包已含)/已答复/暂缓/已驳回
  for (const lc of ['已关闭', '已交付', '已答复', '已回复', '暂缓', '已驳回']) assert.equal(stageOf(lc, fieldStatusLabel), 'closed', lc + '→已关闭');
  // 未识别 → 兜底待评审（不静默丢）
  assert.equal(stageOf('莫名其妙', fieldStatusLabel), 'review');
  assert.equal(stageOf('', fieldStatusLabel), 'review');
});

test('A1b STAGE_LABELS 中文与需求口径一致', () => {
  assert.deepEqual(STAGE_LABELS, { review: '待评审', dev: '开发中', verify: '待验证', closed: '已关闭' });
});

// A2 维保状态：过期/临期/正常/无（date-only 归一，无 off-by-one）
test('A2 maintainStatus：过期/临期/正常/无 + 边界精确', () => {
  // 无维保日期
  assert.deepEqual(maintainStatus('', TODAY), { has: false, end: '', daysLeft: null, status: 'none' });
  assert.equal(maintainStatus(null, TODAY).status, 'none');
  assert.equal(maintainStatus('乱写', TODAY).status, 'none');
  // 已过期（昨天）
  let r = maintainStatus('2026-08-09', TODAY); assert.equal(r.status, 'expired'); assert.equal(r.daysLeft, -1);
  // 临期边界：+30 命中 soon，+31 正常（阈值 30）
  assert.equal(maintainStatus('2026-09-09', TODAY).daysLeft, 30);
  assert.equal(maintainStatus('2026-09-09', TODAY).status, 'soon', '+30 天=临期');
  assert.equal(maintainStatus('2026-09-10', TODAY).daysLeft, 31);
  assert.equal(maintainStatus('2026-09-10', TODAY).status, 'normal', '+31 天=正常');
  // 今天到期 = 剩 0 天 = 临期（未过期）
  assert.equal(maintainStatus('2026-08-10', TODAY).daysLeft, 0);
  assert.equal(maintainStatus('2026-08-10', TODAY).status, 'soon');
});

// A3 紧急判据：priority∈{紧急,高} 且未关闭
test('A3 isUrgentOpen：紧急/高 且未关闭才算', () => {
  assert.equal(isUrgentOpen({ priority: '紧急' }, 'review'), true);
  assert.equal(isUrgentOpen({ priority: '高' }, 'dev'), true);
  assert.equal(isUrgentOpen({ priority: '高' }, 'closed'), false, '已关闭不算紧急');
  assert.equal(isUrgentOpen({ priority: '中' }, 'review'), false);
  assert.equal(isUrgentOpen({ priority: '低' }, 'verify'), false);
  assert.equal(isUrgentOpen({}, 'review'), false);
});

// A4 版本读法：新形状按 s.name===sub；旧形状产品级
test('A4 siteSubVersions / subVersionOf：两形状兼容', () => {
  const custNew = { name: 'A院', products: [{ project: 'hlyy', subsystems: [{ name: 'audit', version: 'v2.8' }, { name: 'report', version: 'v2.7' }, { name: 'pkb', version: '' }] }] };
  const svs = siteSubVersions(custNew, 'hlyy', kbSubLabel);
  assert.equal(svs.length, 2, '只列有版本的子系统（pkb 空跳过）');
  assert.deepEqual(svs.map(x => x.subsystem).sort(), ['audit', 'report']);
  assert.equal(svs.find(x => x.subsystem === 'audit').subsystemLabel, '审方', '中文名 kbSubLabel');
  assert.equal(subVersionOf(custNew, 'hlyy', 'audit'), 'v2.8');
  assert.equal(subVersionOf(custNew, 'hlyy', 'pkb'), '');
  // 旧形状：产品级 version
  const custOld = { name: 'B院', products: [{ project: 'hlyy', version: 'v2.5' }] };
  const svo = siteSubVersions(custOld, 'hlyy', kbSubLabel);
  assert.equal(svo.length, 1); assert.equal(svo[0].version, 'v2.5');
  assert.equal(subVersionOf(custOld, 'hlyy', 'audit'), 'v2.5', '旧形状子系统兜底产品级');
});

// A4b appliedToSite：用工单生命周期判「本院已应用某批」（覆盖单全已关闭/已交付），别用版本相等
test('A4b appliedToSite：覆盖单全已关闭/已交付=已应用；有一条未关闭=未应用；无覆盖单=未应用', () => {
  const mine = [
    { site: 'A院', subsystem: 'audit', lifecycle: '已关闭' },
    { site: 'A院', subsystem: 'report', lifecycle: '已交付' },
    { site: 'B院', subsystem: 'audit', lifecycle: '待验证' },
  ];
  assert.equal(appliedToSite(mine, 'A院'), true, 'A院两单全已关闭/已交付=已应用');
  assert.equal(appliedToSite(mine, 'B院'), false, 'B院有待验证单=未应用');
  assert.equal(appliedToSite(mine, '幽灵院'), false, '无覆盖单=未应用（不当"更新已完成"）');
  // 混一条未关闭即未应用
  assert.equal(appliedToSite([{ site: 'A院', lifecycle: '已关闭' }, { site: 'A院', lifecycle: '开发中' }], 'A院'), false, '有一条未关闭=未应用');
});

// A5 医院卡：阶段计数 + 紧急 + 版本 + 下次更新 + 待下载 + 最近更新
test('A5 buildHospitalCards：字段派生正确', () => {
  const mySites = ['安吉医院', 'B院'];
  const tickets = [
    { project: 'hlyy', site: '安吉医院', subsystem: 'audit', priority: '紧急', lifecycle: '待处理', updatedAt: '2026-08-01 10:00' },
    { project: 'hlyy', site: '安吉医院', subsystem: 'audit', priority: '中', lifecycle: '待验证', updatedAt: '2026-08-09 15:30' },
    { project: 'hlyy', site: '安吉医院', subsystem: 'report', priority: '高', lifecycle: '已关闭', updatedAt: '2026-08-05 09:00' },
    { project: 'hlyy', site: 'B院', subsystem: 'audit', priority: '中', lifecycle: '开发中', updatedAt: '2026-08-07 12:00' },
  ];
  const custByName = new Map([
    ['安吉医院', { name: '安吉医院', maintainEnd: '2026-08-20', products: [{ project: 'hlyy', subsystems: [{ name: 'audit', version: 'v2.8' }, { name: 'report', version: 'v2.7' }] }] }],
    ['B院', { name: 'B院', maintainEnd: '2026-06-01', products: [{ project: 'hlyy', subsystems: [{ name: 'audit', version: 'v2.6' }] }] }],
  ]);
  const batches = [
    // 覆盖安吉·可下载·我(wanglong)未下载 + 覆盖单未全关闭（有待验证）→ 未应用 → 待下载 + 下次更新
    { id: 'B-01', product: 'hlyy', status: '可下载', pkgVersion: 'v2.9', scheduleDate: '2026-08-15', downloadedBy: [], _mineTickets: [{ site: '安吉医院', subsystem: 'audit', lifecycle: '待验证' }] },
  ];
  const cards = buildHospitalCards(mySites, tickets, batches, custByName, ['hlyy'], 'wanglong', deps(TODAY));
  const anji = cards.find(c => c.site === '安吉医院');
  assert.ok(anji, '安吉卡存在');
  // 阶段：待处理→review, 待验证→verify, 已关闭→closed
  assert.deepEqual(anji.stages, { review: 1, dev: 0, verify: 1, closed: 1 });
  assert.equal(anji.ticketTotal, 3);
  assert.equal(anji.urgent, 1, '紧急(未关闭)1 个；高优但已关闭不算');
  assert.equal(anji.maintainStatus, 'soon', '2026-08-20 距 08-10 =10 天=临期');
  assert.equal(anji.maintainDaysLeft, 10);
  assert.equal(anji.versions.length, 1);
  assert.deepEqual(anji.versions[0].subsystems.map(s => s.subsystem).sort(), ['audit', 'report']);
  assert.ok(anji.nextUpdate && anji.nextUpdate.pkgVersion === 'v2.9', '下次更新=可下载批次 v2.9（覆盖单未全关闭=未应用）');
  assert.equal(anji.nextUpdate.scheduleDate, '2026-08-15');
  assert.equal(anji.pendingDownload, 1, '可下载·我未下载·未应用 → 待下载 1');
  assert.equal(anji.lastUpdated, '2026-08-09 15:30', '最近更新=最大 updatedAt');
  // B 院：无覆盖批次 → 无下次更新/待下载；维保过期
  const b = cards.find(c => c.site === 'B院');
  assert.equal(b.maintainStatus, 'expired');
  assert.equal(b.nextUpdate, null, 'B 院无待更新批次');
  assert.equal(b.pendingDownload, 0);
  assert.deepEqual(b.stages, { review: 0, dev: 1, verify: 0, closed: 0 });
});

test('A5b 已应用（覆盖单全已关闭/已交付）→ 不算下次更新/待下载（用 lifecycle 判，非版本相等）', () => {
  const custByName = new Map([['安吉医院', { name: '安吉医院', maintainEnd: '2027-01-01', products: [{ project: 'hlyy', subsystems: [{ name: 'audit', version: 'v2.9' }] }] }]]);
  // 批次覆盖安吉的单全已关闭 → 已应用 → 无下次更新、无待下载（即便状态可下载/我未下载）
  const batches = [{ id: 'B-02', product: 'hlyy', status: '可下载', pkgVersion: 'v2.9', scheduleDate: '2026-08-01', downloadedBy: [], _mineTickets: [{ site: '安吉医院', subsystem: 'audit', lifecycle: '已关闭' }] }];
  const cards = buildHospitalCards(['安吉医院'], [], batches, custByName, ['hlyy'], 'wanglong', deps(TODAY));
  assert.equal(cards[0].pendingDownload, 0, '覆盖单全关闭=已应用 → 不计待下载');
  assert.equal(cards[0].nextUpdate, null, '已应用 → 无下次更新');
});

// A5b-2 prod 真实回归（安吉）：现场版本比包版本还高（2.8.260801-2 vs 2.8.260801-1）+ 覆盖 3 单全已关闭
//   → 早已更完，不应显「下次更新/待更新」。用 lifecycle 判 applied 才对；旧的版本字符串相等判定会误判"未应用"。
test('A5b-2 安吉回归：现场版本高于包版本 + 覆盖单全关闭 → 不冒下次更新/待更新', () => {
  const cust = { name: '安吉县人民医院', maintainEnd: '2027-01-01', products: [{ project: 'hlyy', subsystems: [{ name: 'pkb', version: '2.8.260801-2' }] }] };
  const custByName = new Map([['安吉县人民医院', cust]]);
  const batches = [{
    id: 'B-01', product: 'hlyy', status: '已交付', pkgVersion: '2.8.260801-1', scheduleDate: '2026-08-01', downloadedBy: ['wanglong'],
    _mineTickets: [
      { site: '安吉县人民医院', subsystem: 'pkb', lifecycle: '已关闭' },
      { site: '安吉县人民医院', subsystem: 'pkb', lifecycle: '已关闭' },
      { site: '安吉县人民医院', subsystem: 'pkb', lifecycle: '已交付' },
    ]
  }];
  // 直接验证 appliedToSite 判据
  assert.equal(appliedToSite(batches[0]._mineTickets, '安吉县人民医院'), true, '覆盖单全已关闭/已交付 → 已应用（不看版本字符串）');
  // 医院卡：不冒下次更新/待下载
  const cards = buildHospitalCards(['安吉县人民医院'], [], batches, custByName, ['hlyy'], 'wanglong', deps(TODAY));
  assert.equal(cards[0].nextUpdate, null, '安吉早已更完 → 无下次更新（旧版本相等判定会误显 2.8.260801-1）');
  assert.equal(cards[0].pendingDownload, 0, '无待下载');
  // 产品卡：不冒 pending-update 提醒
  const prod = buildProductCards(['hlyy'], [], batches, custByName, ['安吉县人民医院'], 'wanglong', deps(TODAY));
  const upd = prod[0].reminders.find(r => r.kind === 'pending-update');
  assert.equal(upd, undefined, '全部覆盖院已应用 → 无待更新提醒');
});

test('A5c 找不到 customer 也出卡（维保/版本空），不崩', () => {
  const cards = buildHospitalCards(['幽灵院'], [], [], new Map(), ['hlyy'], 'wanglong', deps(TODAY));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].hasCustomer, false);
  assert.equal(cards[0].maintainStatus, 'none');
  assert.deepEqual(cards[0].versions, []);
  assert.deepEqual(cards[0].stages, { review: 0, dev: 0, verify: 0, closed: 0 });
});

// A6 产品卡：跨院聚合 + 版本分布分组 + 待发布/待更新
test('A6 buildProductCards：跨院聚合工单 + 版本分布 + 提醒', () => {
  const mySites = ['安吉医院', 'B院'];
  const tickets = [
    { project: 'hlyy', site: '安吉医院', subsystem: 'audit', priority: '紧急', lifecycle: '待验证' },
    { project: 'hlyy', site: 'B院', subsystem: 'audit', priority: '中', lifecycle: '待处理' },
    { project: 'hlyy', site: 'B院', subsystem: 'report', priority: '高', lifecycle: '开发中' },
  ];
  const custByName = new Map([
    ['安吉医院', { name: '安吉医院', products: [{ project: 'hlyy', subsystems: [{ name: 'audit', version: 'v2.8' }, { name: 'report', version: 'v2.8' }] }] }],
    ['B院', { name: 'B院', products: [{ project: 'hlyy', subsystems: [{ name: 'audit', version: 'v2.7' }, { name: 'report', version: 'v2.8' }] }] }],
  ]);
  const batches = [
    { id: 'B-10', product: 'hlyy', status: '开发中', pkgVersion: '', scheduleDate: '2026-08-20', _mineTickets: [{ site: '安吉医院', subsystem: 'audit', lifecycle: '开发中' }] },   // 待发布（开发中批次·lifecycle 不影响 pending-release）
    { id: 'B-11', product: 'hlyy', status: '可下载', pkgVersion: 'v2.9', scheduleDate: '2026-08-18', _mineTickets: [{ site: 'B院', subsystem: 'audit', lifecycle: '待验证' }] },     // B院覆盖单未关闭=未应用 → 待更新
  ];
  const cards = buildProductCards(['hlyy'], tickets, batches, custByName, mySites, 'wanglong', deps(TODAY));
  assert.equal(cards.length, 1);
  const p = cards[0];
  assert.equal(p.product, 'hlyy'); assert.equal(p.productName, '合理用药系统');
  assert.equal(p.hospitalCount, 2, '两家院装了 hlyy');
  assert.deepEqual(p.stages, { review: 1, dev: 1, verify: 1, closed: 0 });
  assert.equal(p.urgent, 2, '安吉紧急待验证 + B院高优开发中(均未关闭) = 2');
  // 版本分布：audit → v2.8(安吉) / v2.7(B院)；report → v2.8(安吉、B院)
  const auditDist = p.versionDist.find(v => v.subsystem === 'audit');
  assert.ok(auditDist, 'audit 分布存在');
  const v28 = auditDist.versions.find(x => x.version === 'v2.8');
  const v27 = auditDist.versions.find(x => x.version === 'v2.7');
  assert.deepEqual(v28.hospitals, ['安吉医院']);
  assert.deepEqual(v27.hospitals, ['B院']);
  const reportDist = p.versionDist.find(v => v.subsystem === 'report');
  assert.equal(reportDist.versions.length, 1, 'report 两院同 v2.8');
  assert.deepEqual(reportDist.versions[0].hospitals.sort(), ['B院', '安吉医院']);
  // 提醒：B-10 待发布，B-11 待更新
  const rel = p.reminders.find(r => r.kind === 'pending-release');
  const upd = p.reminders.find(r => r.kind === 'pending-update');
  assert.ok(rel && rel.batchId === 'B-10', '待发布 B-10');
  assert.equal(rel.coverSites, 1);
  assert.ok(upd && upd.batchId === 'B-11' && upd.pkgVersion === 'v2.9', '待更新 B-11 v2.9');
});

// A7 越权收敛：本模块只吃收敛后的数据——验证「传进来的越权 site/project 不会被拉进卡」
//   （端点层用 scopedForField + myProjects 过滤，本测试模拟"端点已裁掉"后纯逻辑不会自造越权数据）
test('A7 越权收敛：mySites/myProjects 之外的数据不进卡', () => {
  const mySites = ['我的院'];   // 只负责一家
  // 端点收敛后 tickets 只含我的院；若上游误传别家单，buildHospitalCards 只按 mySites 出卡 → 别家院不出卡
  const tickets = [
    { project: 'hlyy', site: '我的院', subsystem: 'audit', priority: '中', lifecycle: '待处理' },
    { project: 'hlyy', site: '别人的院', subsystem: 'audit', priority: '紧急', lifecycle: '待验证' },   // 模拟漏进的越权单
  ];
  const custByName = new Map([['我的院', { name: '我的院', products: [{ project: 'hlyy', subsystems: [{ name: 'audit', version: 'v1' }] }] }]]);
  const cards = buildHospitalCards(mySites, tickets, [], custByName, ['hlyy'], 'u', deps(TODAY));
  assert.equal(cards.length, 1, '只出我负责医院的卡');
  assert.equal(cards[0].site, '我的院');
  // 别人的院的单不会混进我的院卡（我的院只有 1 单 review）——按 site 分桶天然隔离
  assert.deepEqual(cards[0].stages, { review: 1, dev: 0, verify: 0, closed: 0 });
  assert.equal(cards[0].urgent, 0, '别家紧急单不计入我的院');
  // 产品卡：myProjects=['hlyy']，别的产品 id 不出卡（productIds 由端点按 myProjects 传入）
  const prod = buildProductCards(['hlyy'], tickets, [], custByName, mySites, 'u', deps(TODAY));
  assert.equal(prod.length, 1);
  // hospitalCount 只算我负责且装了该产品的院（别人的院不在 mySites → 不计）
  assert.equal(prod[0].hospitalCount, 1);
  // 纵深防御：越权院的单不计入产品聚合（urgent/stages 只算我负责医院）
  assert.equal(prod[0].urgent, 0, '别家紧急单不计入产品聚合');
  assert.deepEqual(prod[0].stages, { review: 1, dev: 0, verify: 0, closed: 0 }, '仅我的院 1 单 review');
});

/* ===================== B. server.mjs / field.html 接线断言 ===================== */

test('B1 /api/field/overview 端点存在 + 必须登录', () => {
  assert.ok(/url\.pathname === '\/api\/field\/overview'/.test(SRC), '应有 /api/field/overview 端点');
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/overview'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  assert.ok(/if \(!user\) return send\(res, 401/.test(seg), '未登录返 401');
});

test('B2 /api/field/overview 进 FIELD_OK + FS08_FIELD_API 双白名单（否则 originGate deny，见 fs-08）', () => {
  const fieldOk = /const FIELD_OK = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  const fs08 = /const FS08_FIELD_API = new Set\(\[([\s\S]*?)\]\);/.exec(SRC);
  assert.ok(fieldOk && fieldOk[1].includes("'/api/field/overview'"), '应在 FIELD_OK');
  assert.ok(fs08 && fs08[1].includes("'/api/field/overview'"), '应在 FS08_FIELD_API（否则实施域 originGate deny→forbidden）');
});

test('B3 端点按 user.sites + user.projects 收敛（复用 fieldSites/scopedForField/myProjects）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/overview'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  assert.ok(/const mySites = fieldSites\(user\)/.test(seg), '按 fieldSites(user) 收敛医院（口径同 /api/field/batches）');
  assert.ok(/user\.projects/.test(seg) && /myProjects/.test(seg), '按 user.projects 收敛产品');
  assert.ok(/scopedForField\(user, allTickets\)/.test(seg), '工单走 scopedForField 越权裁掉');
  assert.ok(/listIntake\(p, \{ withConsult: false \}\)/.test(seg), '工单走 listIntake(withConsult:false)（不含 consult，同 submissions 口径）');
});

test('B4 端点复用现成 helper（禁止臆造）：batchTicketsForUser/loadCustomers/loadBatches/kbSubLabel/fieldStatusLabel', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/overview'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  assert.ok(/batchTicketsForUser\(bt, proj, mySites\)/.test(seg), '批次覆盖工单走 batchTicketsForUser');
  assert.ok(/loadCustomers\(\)/.test(seg), '客户台账走 loadCustomers');
  assert.ok(/loadBatches\(\)/.test(seg), '批次走 loadBatches');
  assert.ok(/fieldStatusLabelFn: fieldStatusLabel/.test(seg), '4 阶段归并注入 fieldStatusLabel（与提交清单/批次同源）');
  assert.ok(/subLabelFn: kbSubLabel/.test(seg), '子系统中文名走 kbSubLabel');
});

test('B4b site↔customer 按医院名匹配（与 customer-version/custWithTicketCount 一致，非 id）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/overview'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  // custByName 用 c.name 作键；it.site == 医院名
  assert.ok(/custByName\.set\(nm, c\)/.test(seg) && /c\.name/.test(seg), 'customer 用 name 建索引（it.site=医院名，全库一致按 name 匹配）');
});

test('B4c _mineTickets 附派生 lifecycle（供纯逻辑用 lifecycle 判「本院已应用」，非版本相等）', () => {
  const seg = SRC.slice(SRC.indexOf("url.pathname === '/api/field/overview'"), SRC.indexOf("url.pathname === '/api/intake-detail'"));
  // 端点把 _mineTickets 每条附 lifecycle: e.lifecycle||deriveLifecycle(e)（同 /api/field/batches 口径）
  assert.ok(/batchTicketsForUser\(bt, proj, mySites\)\.map\(e => Object\.assign\(\{\}, e, \{ lifecycle: e\.lifecycle \|\| deriveLifecycle\(e\) \}\)\)/.test(seg), '_mineTickets 附派生 lifecycle');
});

test('B5 FIELD_STATUS_MAP 关键映射未漂移（保证测试用的归并口径与 server 一致）', () => {
  // 断言 server 里这几条关键映射还在（若被改，本 spec 的 4 桶归并要同步）
  assert.ok(/'待验证': \{ label: '待验证'/.test(SRC), '待验证→待验证');
  assert.ok(/'已立项': \{ label: '已受理·排期'/.test(SRC), '已立项→已受理·排期(开发中桶)');
  assert.ok(/'已交付': \{ label: '本包已含'/.test(SRC), '已交付→本包已含(已关闭桶)');
  assert.ok(/'待处理': \{ label: '待评审'/.test(SRC), '待处理→待评审');
});

test('B6 field.html：全览入口 data-m=overview（放最前）+ 默认 mode 仍 hosp', () => {
  assert.ok(/data-m="overview"/.test(FIELD_HTML), '模式菜单有 overview 项');
  assert.ok(/ti-layout-dashboard/.test(FIELD_HTML), '全览用 layout-dashboard 图标');
  // overview 在 hosp 之前（放最前作为落地页入口）
  const io = FIELD_HTML.indexOf('data-m="overview"');
  const ih = FIELD_HTML.indexOf('data-m="hosp"');
  assert.ok(io >= 0 && ih >= 0 && io < ih, 'overview 项在 hosp 之前（最前）');
  // 默认 mode 仍 hosp（state.mode: 'hosp'）+ hosp 项默认 active
  assert.ok(/mode: 'hosp'/.test(FIELD_HTML), '默认 mode=hosp 未改');
  assert.ok(/class="f-mode-item active" data-m="hosp"/.test(FIELD_HTML), 'hosp 默认 active');
});

test('B7 field.html：overview 隐藏 #fWorkspace 显示 #fOverview（内部滚动 overflow:auto）', () => {
  assert.ok(/id="fOverview"/.test(FIELD_HTML), '有 #fOverview 面板');
  assert.ok(/state\.mode === 'overview'/.test(FIELD_HTML), 'setMode 处理 overview 分支');
  // 切 overview：隐藏 workspace、显示 overview
  assert.ok(/ws\.style\.display = 'none'/.test(FIELD_HTML) && /ov\.style\.display = ''/.test(FIELD_HTML), 'overview 隐藏 workspace/显示 overview');
  // 面板内部滚动（全局 UI 规范 #3：不出现 body 全局滚动条）
  assert.ok(/\.f-overview \{[^}]*flex: 1[^}]*min-height: 0[^}]*overflow: auto/.test(FIELD_HTML), '.f-overview 内部滚动（flex:1;min-height:0;overflow:auto）');
});

test('B8 field.html：拉 /api/field/overview + 两维度渲染 + 医院卡点击进院 + 待验证高亮 + 响应式网格', () => {
  assert.ok(/api\('\/api\/field\/overview'/.test(FIELD_HTML), '进 overview 拉 /api/field/overview');
  assert.ok(/function renderOverview/.test(FIELD_HTML) && /医院维度/.test(FIELD_HTML) && /产品维度/.test(FIELD_HTML), '渲染两维度区块');
  assert.ok(/function gotoHospital/.test(FIELD_HTML) && /setMode\('hosp'\)/.test(FIELD_HTML) && /onHospSelect\(site\)/.test(FIELD_HTML), '医院卡点击→切医院视图+选中该院（复用现有数据流）');
  // 待验证段高亮（CSS .f-ov-st.verify 浅 teal 底 + 渲染时 so.k==='verify' 加 verify 类 + 小圆点）
  assert.ok(/\.f-ov-st\.verify\b/.test(FIELD_HTML) && /so\.k/.test(FIELD_HTML), '待验证阶段高亮');
  // 响应式卡片网格（minmax 任意 px，重设计后为 330px）
  assert.ok(/f-ov-grid \{[^}]*repeat\(auto-fill, minmax\(\d+px, 1fr\)\)/.test(FIELD_HTML), '响应式卡片网格');
  // 空态友好占位
  assert.ok(/尚未分配医院/.test(FIELD_HTML) && /尚未分配产品/.test(FIELD_HTML), '空态占位');
});

test('B9 field.html：dashboard 重设计元素齐（KPI 概览条 + 阶段分段条语义色 + 卡片状态条 + 版本落后琥珀）', () => {
  // KPI 概览条：函数 + 5 磁贴（负责医院/工单总数/待验证/紧急/待下载）
  assert.ok(/function kpiBarHtml/.test(FIELD_HTML) && /class="f-ov-kpis"/.test(FIELD_HTML), '有 KPI 概览条');
  assert.ok(/负责医院/.test(FIELD_HTML) && /工单总数/.test(FIELD_HTML) && /待验证/.test(FIELD_HTML) && /待下载/.test(FIELD_HTML), 'KPI 含关键指标');
  // 阶段分段条语义色（待评审 warning / 开发中 btn / 已关闭 灰）
  assert.ok(/\.f-ov-st\.review\b/.test(FIELD_HTML) && /\.f-ov-st\.dev\b/.test(FIELD_HTML) && /\.f-ov-st\.closed\b/.test(FIELD_HTML), '阶段段各语义色');
  // 卡片左侧状态色条（hospAccent/prodAccent → st-danger/st-warning/st-accent/st-calm）
  assert.ok(/function hospAccent/.test(FIELD_HTML) && /function prodAccent/.test(FIELD_HTML), '卡片状态色派生');
  assert.ok(/\.f-ov-card\.st-danger::before/.test(FIELD_HTML) && /\.f-ov-card\.st-warning::before/.test(FIELD_HTML), '卡片左侧状态条');
  // hover 微升
  assert.ok(/\.f-ov-card\.click:hover \{[^}]*translateY\(-2px\)/.test(FIELD_HTML), '卡片 hover 微升');
  // 版本分布落后旧版本琥珀
  assert.ok(/f-ov-vg' \+ lag/.test(FIELD_HTML) && /\.f-ov-vg\.lag/.test(FIELD_HTML), '版本分布落后版本琥珀标记');
  // 仅复用 theme.css token（不硬编码新色值）——抽 .f-ov-* CSS 段核对无裸 #hex 色值
  //   （白色 #fff/#ffffff 是"色上白字"通用字面量，全站顶栏等也这么写，放行；其余色一律走 var(--color-*)）。
  const cssStart = FIELD_HTML.indexOf('/* ========== FS-09 · 全览');
  const cssEnd = FIELD_HTML.indexOf('/* ========== FS-02');
  const ovCss = FIELD_HTML.slice(cssStart, cssEnd);
  const hexes = (ovCss.match(/#[0-9A-Fa-f]{3,6}\b/g) || []).filter(x => !/^#(fff|ffffff)$/i.test(x));
  assert.deepEqual(hexes, [], '全览 CSS 不硬编码非白色 #hex（一律走 theme token var()）：' + JSON.stringify(hexes));
});
