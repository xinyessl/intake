import React from 'react';
import { createRoot } from 'react-dom/client';
import { FieldOverviewApp } from './FieldOverviewApp.jsx';
import './styles.css';

const demo = {
  hospitals: [
    {
      site: '山东省立医院', hospitalName: '山东省立医院', maintainStatus: 'soon', maintainDaysLeft: 18,
      stages: { review: 2, dev: 3, verify: 2, closed: 12 }, ticketTotal: 19, urgent: 1, pendingDownload: 1,
      versions: [{ product: 'pwrs', productName: '药师工作站', subsystems: [{ subsystem: 'audit', subsystemLabel: '审方', version: '2026-07-28' }] }],
      nextUpdate: { productName: '药师工作站', pkgVersion: '2026-08-15', scheduleDate: '2026-08-20' }, lastUpdated: '2026-08-10 09:30',
    },
  ],
  products: [
    {
      product: 'pwrs', productName: '药师工作站', hospitalCount: 3, stages: { review: 2, dev: 3, verify: 2, closed: 12 }, urgent: 1,
      versionDist: [{ subsystem: 'audit', subsystemLabel: '审方', versions: [{ version: '2026-07-28', hospitals: ['山东省立医院', '青岛市立医院'] }, { version: '2026-06-30', hospitals: ['烟台市医院'] }] }],
      reminders: [{ kind: 'pending-release', batchId: 'B-12', coverSites: 3, scheduleDate: '2026-08-20' }],
    },
  ],
};

createRoot(document.getElementById('root')).render(<FieldOverviewApp data={demo} onHospitalSelect={() => {}} />);
