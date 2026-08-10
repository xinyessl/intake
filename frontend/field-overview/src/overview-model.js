export const STAGES = [
  { key: 'review', label: '待评审' },
  { key: 'dev', label: '开发中' },
  { key: 'verify', label: '待验证' },
  { key: 'closed', label: '已关闭' },
];

const count = (value) => Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : 0;

export function normalizeOverviewData(input) {
  const data = input && typeof input === 'object' ? input : {};
  return {
    hospitals: Array.isArray(data.hospitals) ? data.hospitals.filter(Boolean) : [],
    products: Array.isArray(data.products) ? data.products.filter(Boolean) : [],
  };
}

export function overviewKpis(hospitals) {
  return (Array.isArray(hospitals) ? hospitals : []).reduce((acc, hospital) => {
    const stages = hospital?.stages || {};
    acc.hospitals += 1;
    acc.tickets += count(hospital?.ticketTotal || (count(stages.review) + count(stages.dev) + count(stages.verify) + count(stages.closed)));
    acc.verify += count(stages.verify);
    acc.urgent += count(hospital?.urgent);
    acc.pendingDownload += count(hospital?.pendingDownload);
    return acc;
  }, { hospitals: 0, tickets: 0, verify: 0, urgent: 0, pendingDownload: 0 });
}

export function hospitalAttention(hospital) {
  const h = hospital || {};
  const items = [];
  let severity = 'ok';
  if (count(h.urgent)) { items.push(`${count(h.urgent)} 个紧急工单`); severity = 'danger'; }
  if (h.maintainStatus === 'expired') { items.push('维保已过期'); severity = 'danger'; }
  if (count(h.stages?.verify)) items.push(`${count(h.stages.verify)} 个工单待验证`);
  if (h.maintainStatus === 'soon') items.push('维保即将到期');
  if (count(h.pendingDownload)) items.push(`${count(h.pendingDownload)} 个更新包待下载`);
  if (items.length && severity !== 'danger') severity = 'warning';
  return { severity, items, text: items.length ? `需要处理：${items.join('、')}` : '当前无突出待办' };
}

export function productAttention(product) {
  const p = product || {};
  const items = [];
  let severity = 'ok';
  const inconsistent = (Array.isArray(p.versionDist) ? p.versionDist : []).filter((row) => (row?.versions || []).length > 1).length;
  if (count(p.urgent)) { items.push(`${count(p.urgent)} 个紧急工单`); severity = 'danger'; }
  if ((p.reminders || []).length) items.push(`${p.reminders.length} 项发布或更新待办`);
  if (inconsistent) items.push(`${inconsistent} 个系统存在跨院版本差异`);
  if (items.length && severity !== 'danger') severity = 'warning';
  return { severity, items, text: items.length ? `需要关注：${items.join('、')}` : '当前无突出待办' };
}

export function maintenanceText(hospital) {
  const h = hospital || {};
  if (h.maintainStatus === 'expired') return `维保已过期 ${Math.abs(Number(h.maintainDaysLeft) || 0)} 天`;
  if (h.maintainStatus === 'soon') return `维保剩 ${Number(h.maintainDaysLeft) || 0} 天`;
  if (h.maintainStatus === 'normal') return h.maintainEnd ? `维保至 ${h.maintainEnd}` : '维保正常';
  return '未维护维保日期';
}

export function formatOverviewTime(value) {
  if (value == null || value === '') return '—';
  const text = String(value);
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  return matched ? `${matched[1]}-${matched[2]}-${matched[3]} ${matched[4]}:${matched[5]}` : text;
}
