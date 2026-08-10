// FS-09 · 全览宽屏重设计：直接执行 field.html 真实 HTML 生成函数的脱库测试。
// 用法：node --test tools/fs-09-overview-render.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELD = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');
const STAGES = [{ k: 'review', l: '待评审' }, { k: 'dev', l: '开发中' }, { k: 'verify', l: '待验证' }, { k: 'closed', l: '已关闭' }];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `应能找到 function ${name}`);
  const open = src.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${name} 大括号未配平`);
}

const kpiBarHtml = new Function(extractFn(FIELD, 'kpiBarHtml') + '\nreturn kpiBarHtml;')();
const hospCardHtml = new Function(
  'STAGE_ORDER', 'escapeHtml', 'fmtTime',
  [extractFn(FIELD, 'stagesHtml'), extractFn(FIELD, 'mntBadgeHtml'), extractFn(FIELD, 'hospAccent'), extractFn(FIELD, 'hospActionHtml'), extractFn(FIELD, 'hospCardHtml')].join('\n') + '\nreturn hospCardHtml;',
)(STAGES, esc, (s) => s || '—');
const prodCardHtml = new Function(
  'STAGE_ORDER', 'escapeHtml',
  [extractFn(FIELD, 'stagesHtml'), extractFn(FIELD, 'prodAccent'), extractFn(FIELD, 'prodActionHtml'), extractFn(FIELD, 'prodCardHtml')].join('\n') + '\nreturn prodCardHtml;',
)(STAGES, esc);

test('KPI 真实渲染：有问题显式标「需要处理」，0 值降噪为「暂无待办」', () => {
  const html = kpiBarHtml([
    { ticketTotal: 8, urgent: 2, pendingDownload: 0, stages: { review: 1, dev: 2, verify: 3, closed: 2 } },
  ], []);
  assert.match(html, /has-issue accent[\s\S]*?3[\s\S]*?待验证工单[\s\S]*?需要处理/);
  assert.match(html, /has-issue danger[\s\S]*?2[\s\S]*?紧急工单[\s\S]*?需要处理/);
  assert.match(html, /待下载更新包[\s\S]*?暂无待办/);
});

test('医院卡真实渲染：原生键盘按钮、明文待办、阶段和产品·系统·版本关联齐全', () => {
  const html = hospCardHtml({
    site: '甲院', hospitalName: '甲院', urgent: 1, pendingDownload: 2,
    maintainStatus: 'soon', maintainDaysLeft: 7, maintainEnd: '2026-08-17',
    stages: { review: 1, dev: 2, verify: 3, closed: 4 }, lastUpdated: '2026-08-10 09:30',
    versions: [{ product: 'p1', productName: '药师工作站', subsystems: [{ subsystem: 'audit', subsystemLabel: '审方', version: '2026-07-28' }] }],
    nextUpdate: { productName: '药师工作站', pkgVersion: '2026-08-12', scheduleDate: '2026-08-15' },
  });
  assert.match(html, /^<button type="button"/);
  assert.match(html, /aria-label="进入甲院医院视图"/);
  assert.match(html, /需要处理：1 个紧急工单、3 个工单待验证、维保即将到期、2 个更新包待下载/);
  assert.match(html, /药师工作站 · 审方[\s\S]*?2026-07-28/);
  for (const label of ['待评审', '开发中', '待验证', '已关闭']) assert.ok(html.includes(label));
});

test('产品卡真实渲染：跨院影响、版本—医院对应和发布待办清楚', () => {
  const html = prodCardHtml({
    product: 'p1', productName: '药师工作站', hospitalCount: 3, urgent: 0,
    stages: { review: 0, dev: 1, verify: 2, closed: 5 },
    versionDist: [{ subsystem: 'audit', subsystemLabel: '审方', versions: [
      { version: '2026-08-01', hospitals: ['甲院', '乙院'] },
      { version: '2026-07-28', hospitals: ['丙院'] },
    ] }],
    reminders: [{ kind: 'pending-release', batchId: 'B-9', coverSites: 3, scheduleDate: '2026-08-20' }],
  });
  assert.match(html, /3 家院/);
  assert.match(html, /需要关注：1 项发布\/更新待办、1 个系统存在跨院版本差异/);
  assert.match(html, /2026-08-01[\s\S]*?甲院、乙院/);
  assert.match(html, /f-ov-vg lag[\s\S]*?2026-07-28[\s\S]*?丙院/);
  assert.match(html, /待发布 · B-9[\s\S]*?影响 3 家院/);
});

test('宽屏/1280/小屏结构：auto-fit 铺满空轨道，1280 三列，小屏一列，无横向溢出', () => {
  assert.match(FIELD, /\.f-ov-grid \{ grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 360px\), 1fr\)\)/);
  assert.match(FIELD, /@media \(max-width: 1280px\)[\s\S]*?\.f-ov-kpis \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(FIELD, /@media \(max-width: 560px\)[\s\S]*?\.f-ov-kpis, \.f-ov-grid \{ grid-template-columns: 1fr/);
  assert.match(FIELD, /\.f-ov-card \{ min-width: 0/);
  assert.match(FIELD, /\.f-ov-body \{ width: 100%; max-width: 1720px; box-sizing: border-box/);
});

test('可访问与可读性：卡片有 focus-visible，全览关键字号不低于 14px，版本长列表限高滚动', () => {
  assert.match(FIELD, /\.f-ov-card\.click:focus-visible \{ outline: 3px/);
  assert.match(FIELD, /\.f-ov-ch \.id > span:last-child \{ display: flex; flex-direction: column; min-width: 0; \}/, '医院/产品卡标题容器纵向排列');
  assert.match(FIELD, /\.f-ov-ch \.sub \{ display: block;/, '说明文字独占一行');
  assert.match(FIELD, /\.f-ov-row \{[^}]*font-size: 14px/);
  assert.match(FIELD, /\.f-ov-st \.l \{[^}]*font-size: 14px/);
  assert.match(FIELD, /\.f-ov-version-list, \.f-ov-vd \{[^}]*max-height: 184px; overflow: auto/);
});
