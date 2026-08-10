import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FieldOverviewApp } from '../src/FieldOverviewApp.jsx';
import { hospitalAttention, normalizeOverviewData, overviewKpis, productAttention } from '../src/overview-model.js';

const CSS = await import('node:fs').then(({ readFileSync }) => readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8'));

const hospital = {
  site: '甲医院', hospitalName: '甲医院', maintainStatus: 'soon', maintainDaysLeft: 7,
  stages: { review: 1, dev: 2, verify: 3, closed: 4 }, ticketTotal: 10, urgent: 1, pendingDownload: 2,
  versions: [{ product: 'p1', productName: '药师工作站', subsystems: [{ subsystem: 'audit', subsystemLabel: '审方', version: '2026-07-28' }] }],
  nextUpdate: { productName: '药师工作站', pkgVersion: '2026-08-12', scheduleDate: '2026-08-15' }, lastUpdated: '2026-08-10 09:30',
};
const product = {
  product: 'p1', productName: '药师工作站', hospitalCount: 3, urgent: 0,
  stages: { review: 0, dev: 1, verify: 2, closed: 5 },
  versionDist: [{ subsystem: 'audit', subsystemLabel: '审方', versions: [{ version: '2026-08-01', hospitals: ['甲医院', '乙医院'] }, { version: '2026-07-28', hospitals: ['丙医院'] }] }],
  reminders: [{ kind: 'pending-release', batchId: 'B-9', coverSites: 3, scheduleDate: '2026-08-20' }],
};

describe('overview model', () => {
  it('normalizes malformed payload without inventing records', () => {
    expect(normalizeOverviewData(null)).toEqual({ hospitals: [], products: [] });
    expect(normalizeOverviewData({ hospitals: [null, hospital], products: 'bad' })).toEqual({ hospitals: [hospital], products: [] });
  });

  it('aggregates only existing overview fields', () => {
    expect(overviewKpis([hospital])).toEqual({ hospitals: 1, tickets: 10, verify: 3, urgent: 1, pendingDownload: 2 });
  });

  it('turns risks into explicit Chinese actions instead of color-only status', () => {
    expect(hospitalAttention(hospital).text).toBe('需要处理：1 个紧急工单、3 个工单待验证、维保即将到期、2 个更新包待下载');
    expect(productAttention(product).text).toBe('需要关注：1 项发布或更新待办、1 个系统存在跨院版本差异');
  });
});

describe('FieldOverviewApp static render', () => {
  it('renders KPI, hospital/product associations, an explicit hospital button and no emoji icons', () => {
    const html = renderToStaticMarkup(<FieldOverviewApp data={{ hospitals: [hospital], products: [product] }} onHospitalSelect={vi.fn()} />);
    expect(html).toContain('我的实施全览');
    expect(html).toContain('医院执行状态');
    expect(html).toContain('查看该院实施状态与现场版本');
    expect(html).not.toContain('需处理医院');
    expect(html).not.toContain('点击进入该院工作界面');
    expect(html).toContain('需要处理');
    expect(html).toContain('<button');
    expect(html).toContain('进入医院视图');
    expect(html).toContain('ifo-card-action');
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="进入甲医院医院视图"');
    expect(html).not.toMatch(/ifo-hospital-card[^>]*role="button"/);
    expect(html).toMatch(/药师工作站[\s\S]*审方[\s\S]*2026-07-28/);
    expect(html).toMatch(/2026-08-01[\s\S]*甲医院、乙医院/);
    expect(html).not.toMatch(/[🏥📦🔥✅⚠️]/u);
  });

  it('renders safe empty states', () => {
    const html = renderToStaticMarkup(<FieldOverviewApp data={{ hospitals: [], products: [] }} />);
    expect(html).toContain('尚未分配医院');
    expect(html).toContain('尚未分配产品');
  });

  it('keeps responsive, reduced-motion and overflow accessibility guards', () => {
    expect(CSS).toMatch(/\.ifo-root\s*\{[\s\S]*?width:\s*100%;[\s\S]*?min-width:\s*0;[\s\S]*?max-width:\s*1760px;/);
    expect(CSS).toMatch(/\.ifo-grid\s*\{[^}]*minmax\(min\(100%,\s*360px\),\s*1fr\)/);
    expect(CSS).toMatch(/\.ifo-card\.ant-card\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden;/);
    expect(CSS).toMatch(/\.ifo-hospital-grid\s*\{[^}]*align-items:\s*stretch;/);
    expect(CSS).toMatch(/\.ifo-hospital-card\.ant-card\s*\{[^}]*display:\s*flex;[^}]*height:\s*100%;[^}]*flex-direction:\s*column;/);
    expect(CSS).toMatch(/\.ifo-hospital-card\s+\.ant-card-body\s*\{[^}]*display:\s*flex;[^}]*flex:\s*1\s+1\s+auto;[^}]*flex-direction:\s*column;/);
    expect(CSS).toMatch(/\.ifo-card-action\s*\{[^}]*margin-top:\s*auto;[^}]*padding-top:\s*14px;/);
    expect(CSS).toMatch(/\.ifo-scroll-list\s*\{[^}]*max-height:\s*184px;[^}]*overflow:\s*auto;/);
    expect(CSS).toMatch(/@media\s*\(max-width:\s*1280px\)/);
    expect(CSS).toMatch(/@media\s*\(max-width:\s*768px\)/);
    expect(CSS).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.ifo-kpi-grid,\s*\.ifo-grid\s*\{\s*grid-template-columns:\s*1fr;/);
    expect(CSS).toMatch(/@media\s*\(max-width:\s*480px\)[\s\S]*?\.ifo-hospital-card\.ant-card\s*\{\s*height:\s*auto;/);
    expect(CSS).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)[\s\S]*?animation-duration:\s*\.01ms/);
    expect(CSS).toMatch(/\.ifo-enter-button\.ant-btn\s*\{[^}]*min-height:\s*44px;/);
    expect(CSS).toMatch(/\.ifo-enter-button\.ant-btn:focus-visible\s*\{[^}]*outline:/);
  });
});
