import React from 'react';
import { Button, Card, ConfigProvider, Empty, Statistic, Typography } from 'antd';
import {
  AlertOutlined,
  ApartmentOutlined,
  BankOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  CloudDownloadOutlined,
  DeploymentUnitOutlined,
  ExclamationCircleOutlined,
  FileDoneOutlined,
  MedicineBoxOutlined,
  ProductOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
} from '@ant-design/icons';
import {
  STAGES,
  formatOverviewTime,
  hospitalAttention,
  maintenanceText,
  normalizeOverviewData,
  overviewKpis,
  productAttention,
} from './overview-model.js';

const { Text, Title } = Typography;

const theme = {
  token: {
    colorPrimary: '#1A6DBE',
    colorInfo: '#1A6DBE',
    colorSuccess: '#2F855A',
    colorWarning: '#A56708',
    colorError: '#C0392B',
    colorText: '#172B3A',
    colorTextSecondary: '#526878',
    colorBorder: '#D8E1E8',
    colorBgContainer: '#FFFFFF',
    colorBgLayout: '#F4F7F9',
    borderRadius: 10,
    controlHeight: 44,
    fontSize: 14,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif',
  },
  components: {
    Card: { bodyPadding: 18, headerFontSize: 16 },
    Statistic: { contentFontSize: 28, titleFontSize: 14 },
  },
};

const KPI_ITEMS = [
  { key: 'hospitals', label: '负责医院', hint: '当前分配范围', Icon: BankOutlined, tone: 'primary' },
  { key: 'tickets', label: '工单总数', hint: '当前范围全部工单', Icon: FileDoneOutlined, tone: 'neutral' },
  { key: 'verify', label: '待验证工单', hint: '需要现场验证', Icon: CheckCircleOutlined, tone: 'accent', actionable: true },
  { key: 'urgent', label: '紧急工单', hint: '需要优先处理', Icon: AlertOutlined, tone: 'danger', actionable: true },
  { key: 'pendingDownload', label: '待下载更新包', hint: '等待实施下载', Icon: CloudDownloadOutlined, tone: 'warning', actionable: true },
];

function KpiGrid({ hospitals }) {
  const values = overviewKpis(hospitals);
  return (
    <section className="ifo-kpi-grid" aria-label="实施概览指标">
      {KPI_ITEMS.map(({ key, label, hint, Icon, tone, actionable }) => {
        const value = values[key];
        const issue = actionable && value > 0;
        return (
          <Card key={key} className={`ifo-kpi ifo-tone-${tone}${issue ? ' is-issue' : ' is-quiet'}`} variant="outlined">
            <span className="ifo-kpi-icon" aria-hidden="true"><Icon /></span>
            <Statistic title={label} value={value} />
            <Text className="ifo-kpi-hint">{issue ? '需要处理' : (actionable ? '暂无待办' : hint)}</Text>
          </Card>
        );
      })}
    </section>
  );
}

function Attention({ result }) {
  const Icon = result.severity === 'danger' ? ExclamationCircleOutlined : result.severity === 'warning' ? ClockCircleOutlined : CheckCircleOutlined;
  return (
    <div className={`ifo-attention is-${result.severity}`} role="status">
      <Icon aria-hidden="true" />
      <span>{result.text}</span>
    </div>
  );
}

function StageStrip({ stages = {} }) {
  return (
    <dl className="ifo-stages" aria-label="工单阶段统计">
      {STAGES.map(({ key, label }) => {
        const value = Number(stages[key]) || 0;
        return (
          <div key={key} className={`ifo-stage is-${key}${value === 0 ? ' is-zero' : ''}`}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        );
      })}
    </dl>
  );
}

function Maintenance({ hospital }) {
  const status = hospital?.maintainStatus || 'none';
  return (
    <span className={`ifo-maintenance is-${status}`}>
      <SafetyCertificateOutlined aria-hidden="true" />
      {maintenanceText(hospital)}
    </span>
  );
}

function HospitalVersions({ hospital }) {
  const rows = [];
  (hospital?.versions || []).forEach((product) => {
    (product?.subsystems || []).forEach((system) => rows.push({
      key: `${product.product || product.productName}-${system.subsystem || system.subsystemLabel}`,
      where: `${product.productName || product.product || '产品'} · ${system.subsystemLabel || system.subsystem || '系统'}`,
      version: system.version || '—',
    }));
  });
  if (!rows.length) return <Text type="secondary">暂无现场版本</Text>;
  return (
    <div className="ifo-scroll-list" role="region" aria-label={`${hospital.hospitalName || hospital.site}现场版本`} tabIndex="0">
      {rows.map((row) => (
        <div className="ifo-version-row" key={row.key}>
          <span>{row.where}</span><strong>{row.version}</strong>
        </div>
      ))}
    </div>
  );
}

function HospitalCard({ hospital, onSelect }) {
  const site = hospital?.site || '';
  const name = hospital?.hospitalName || site || '未命名医院';
  const open = () => { if (site && typeof onSelect === 'function') onSelect(site); };
  const next = hospital?.nextUpdate;
  return (
    <Card
      className={`ifo-card ifo-hospital-card is-${hospitalAttention(hospital).severity}`}
      variant="outlined"
    >
      <header className="ifo-card-head">
        <span className="ifo-title-icon" aria-hidden="true"><MedicineBoxOutlined /></span>
        <span className="ifo-title-copy"><strong>{name}</strong><small>查看该院实施状态与现场版本</small></span>
        <Maintenance hospital={hospital} />
      </header>
      <Attention result={hospitalAttention(hospital)} />
      <StageStrip stages={hospital?.stages} />
      <div className="ifo-facts">
        <div className="ifo-fact ifo-fact-wide"><span className="ifo-fact-label">现场版本</span><HospitalVersions hospital={hospital} /></div>
        <div className="ifo-fact">
          <span className="ifo-fact-label">下次更新</span>
          {next ? <span><strong>{next.productName || next.product || '产品'} · {next.pkgVersion || '版本待定'}</strong><small>{next.scheduleDate ? `计划日期 ${next.scheduleDate}` : '计划日期待定'}</small></span> : <Text type="secondary">暂无</Text>}
        </div>
        <div className="ifo-fact"><span className="ifo-fact-label">最后更新</span><span>{formatOverviewTime(hospital?.lastUpdated)}</span></div>
      </div>
      <div className="ifo-card-action">
        <Button className="ifo-enter-button" onClick={open} disabled={!site} aria-label={`进入${name}医院视图`}>
          进入医院视图 <RightOutlined aria-hidden="true" />
        </Button>
      </div>
    </Card>
  );
}

function ProductVersions({ product }) {
  const rows = product?.versionDist || [];
  if (!rows.length) return <Text type="secondary">暂无版本分布</Text>;
  return (
    <div className="ifo-scroll-list" role="region" aria-label={`${product.productName || product.product}版本分布`} tabIndex="0">
      {rows.map((system) => (
        <div className="ifo-product-version" key={system.subsystem || system.subsystemLabel}>
          <strong className="ifo-system-name">{system.subsystemLabel || system.subsystem || '系统'}</strong>
          <div className="ifo-version-groups">
            {(system.versions || []).map((version, index) => (
              <div className={`ifo-version-group${index > 0 ? ' is-lag' : ''}`} key={`${version.version}-${index}`}>
                <strong>{version.version || '—'}</strong>
                <span>{(version.hospitals || []).join('、') || '无关联医院'}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function ProductReminders({ reminders = [] }) {
  if (!reminders.length) return <Text type="secondary">暂无发布提醒</Text>;
  return (
    <div className="ifo-reminders">
      {reminders.map((item, index) => {
        const pendingRelease = item.kind === 'pending-release';
        return (
          <div className={`ifo-reminder${pendingRelease ? ' is-release' : ''}`} key={`${item.batchId}-${index}`}>
            {pendingRelease ? <DeploymentUnitOutlined aria-hidden="true" /> : <CloudDownloadOutlined aria-hidden="true" />}
            <span>
              <strong>{pendingRelease ? `待发布 · ${item.batchId || '批次待定'}` : `待更新 · ${item.pkgVersion || '版本待定'}`}</strong>
              <small>影响 {Number(item.coverSites) || 0} 家院{item.scheduleDate ? ` · 计划 ${item.scheduleDate}` : ''}</small>
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProductCard({ product }) {
  const name = product?.productName || product?.product || '未命名产品';
  const attention = productAttention(product);
  return (
    <Card className={`ifo-card ifo-product-card is-${attention.severity}`} variant="outlined">
      <header className="ifo-card-head">
        <span className="ifo-title-icon is-product" aria-hidden="true"><ProductOutlined /></span>
        <span className="ifo-title-copy"><strong>{name}</strong><small>跨院影响与版本分布</small></span>
        <span className="ifo-impact"><BankOutlined aria-hidden="true" />影响 {Number(product?.hospitalCount) || 0} 家院</span>
      </header>
      <Attention result={attention} />
      <StageStrip stages={product?.stages} />
      <div className="ifo-facts">
        <div className="ifo-fact ifo-fact-wide"><span className="ifo-fact-label">版本分布</span><ProductVersions product={product} /></div>
        <div className="ifo-fact ifo-fact-wide"><span className="ifo-fact-label">发布提醒</span><ProductReminders reminders={product?.reminders} /></div>
      </div>
    </Card>
  );
}

function Section({ title, count, description, icon, children, empty }) {
  return (
    <section className="ifo-section" aria-labelledby={`ifo-section-${title}`}>
      <header className="ifo-section-head">
        <span className="ifo-section-icon" aria-hidden="true">{icon}</span>
        <div><Title level={2} id={`ifo-section-${title}`}>{title}</Title><Text>{description}</Text></div>
        <strong className="ifo-section-count">{count}</strong>
      </header>
      {count ? children : <Empty className="ifo-empty" image={Empty.PRESENTED_IMAGE_SIMPLE} description={empty} />}
    </section>
  );
}

export function FieldOverviewApp({ data, onHospitalSelect }) {
  const { hospitals, products } = normalizeOverviewData(data);
  return (
    <ConfigProvider theme={theme} componentSize="middle">
      <main className="ifo-root">
        <header className="ifo-page-head">
          <div><Text className="ifo-eyebrow"><ApartmentOutlined /> 实施工作台</Text><Title level={1}>我的实施全览</Title><Text>先处理有风险的医院，再核对跨院版本和发布影响。</Text></div>
        </header>
        <KpiGrid hospitals={hospitals} />
        <Section title="医院执行状态" count={hospitals.length} description="按待验证、紧急与维保风险优先展示" icon={<MedicineBoxOutlined />} empty="尚未分配医院">
          <div className="ifo-grid ifo-hospital-grid">{hospitals.map((hospital) => <HospitalCard key={hospital.site || hospital.hospitalName} hospital={hospital} onSelect={onHospitalSelect} />)}</div>
        </Section>
        <Section title="产品与版本分布" count={products.length} description="跨负责医院查看版本差异与发布待办" icon={<ProductOutlined />} empty="尚未分配产品">
          <div className="ifo-grid ifo-product-grid">{products.map((product) => <ProductCard key={product.product || product.productName} product={product} />)}</div>
        </Section>
      </main>
    </ConfigProvider>
  );
}
