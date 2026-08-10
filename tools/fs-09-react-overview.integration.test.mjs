// FS-09 · React 全览渐进式挂载集成测试（无库）
// 直接执行 field.html 真实挂载分流函数，覆盖成功、bundle 缺失、mount 抛错、ErrorBoundary 回调兜底。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELD = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');
const BUNDLE = path.join(ROOT, 'public/assets/field-overview/field-overview.js');
const CSS = path.join(ROOT, 'public/assets/field-overview/field-overview.css');
const BUNDLE_MAP = `${BUNDLE}.map`;
const COMPONENT = fs.readFileSync(path.join(ROOT, 'frontend/field-overview/src/FieldOverviewApp.jsx'), 'utf8');
const VITE_CONFIG = fs.readFileSync(path.join(ROOT, 'frontend/field-overview/vite.config.js'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start >= 0, `应能找到 function ${name}`);
  const argsOpen = src.indexOf('(', start);
  let parenDepth = 0;
  let argsClose = -1;
  for (let i = argsOpen; i < src.length; i++) {
    if (src[i] === '(') parenDepth++;
    else if (src[i] === ')' && --parenDepth === 0) { argsClose = i; break; }
  }
  assert.ok(argsClose > argsOpen, `${name} 参数应配平`);
  const open = src.indexOf('{', argsClose);
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${name} 大括号未配平`);
}

function harness(bundle) {
  const body = {};
  const nativeCalls = [];
  const hospitalCalls = [];
  let unmounts = 0;
  const renderOverview = new Function(
    '$', 'window', 'renderOverviewNative', 'gotoHospital', 'setTimeout', 'state', 'unmountReactOverview',
    extractFn(FIELD, 'renderOverview') + '\nreturn renderOverview;',
  )(
    () => body,
    { IntakeFieldOverview: bundle },
    (hospitals, products) => nativeCalls.push({ hospitals, products }),
    (site) => hospitalCalls.push(site),
    (fn) => fn(),
    { mode: 'overview' },
    () => { unmounts++; return true; },
  );
  return { renderOverview, body, nativeCalls, hospitalCalls, getUnmounts: () => unmounts };
}

test('构建产物与 field.html 固定静态接线存在', () => {
  const bundleSource = fs.readFileSync(BUNDLE, 'utf8');
  assert.ok(fs.statSync(BUNDLE).size > 100_000, 'React/AntD IIFE 产物已构建');
  assert.ok(fs.statSync(BUNDLE).size < 1_500_000, '单文件产物控制在 1.5MB 内');
  assert.ok(fs.statSync(CSS).size > 1_000, '全览 CSS 产物已构建');
  assert.equal(fs.existsSync(BUNDLE_MAP), false, '生产产物不泄露 sourcemap');
  assert.match(FIELD, /href="\/assets\/field-overview\/field-overview\.css"/);
  assert.match(FIELD, /src="\/assets\/field-overview\/field-overview\.js"/);
  assert.ok(FIELD.indexOf('field-overview.js') < FIELD.indexOf("<script>\n'use strict';"), 'bundle 先于旧页内联逻辑加载');
  assert.match(bundleSource, /IntakeFieldOverview/);
  assert.match(VITE_CONFIG, /['"]process\.env\.NODE_ENV['"]\s*:\s*JSON\.stringify\(['"]production['"]\)/);
  assert.doesNotMatch(bundleSource, /\bprocess\s*\.\s*env\b/, 'IIFE 不得读取浏览器不存在的 process.env');
  assert.doesNotMatch(bundleSource, /\bprocess\s*(?:\.|\[)/, 'IIFE 不得依赖浏览器全局 process');
});

test('生产 IIFE 可在没有 process 全局的浏览器式环境完成初始化', () => {
  const browserWindow = {};
  vm.runInNewContext(fs.readFileSync(BUNDLE, 'utf8'), {
    window: browserWindow,
    console,
    setTimeout,
    clearTimeout,
    performance: { now: () => 0 },
  }, { timeout: 5_000, filename: 'field-overview.js' });
  assert.equal(typeof browserWindow.IntakeFieldOverview?.mount, 'function');
  assert.equal(typeof browserWindow.IntakeFieldOverview?.unmount, 'function');
});

test('医院卡没有嵌套交互：卡片非 button，显式 AntD Button 负责进入医院', () => {
  const hospitalCard = extractFn(COMPONENT, 'HospitalCard');
  assert.doesNotMatch(hospitalCard, /role="button"|tabIndex="0"|onKeyDown=/);
  assert.match(hospitalCard, /<Button[^>]*className="ifo-enter-button"[^>]*onClick=\{open\}/);
  assert.match(hospitalCard, /aria-label=\{`进入\$\{name\}医院视图`\}/);
  assert.match(hospitalCard, /variant="outlined"/);
});

test('React mount 成功：传真实 overview 数据与医院导航回调，不跑原生渲染', () => {
  let options;
  const h = harness({ mount(container, opts) { assert.equal(container, h.body); options = opts; return true; } });
  const hospitals = [{ site: '甲院' }], products = [{ product: 'p1' }];
  h.renderOverview(hospitals, products);
  assert.deepEqual(options.data, { hospitals, products });
  options.onHospitalSelect('甲院');
  assert.deepEqual(h.hospitalCalls, ['甲院']);
  assert.equal(h.nativeCalls.length, 0);
});

test('bundle 缺失或 mount 抛错：立即回退旧 renderOverviewNative', () => {
  const missing = harness(undefined);
  missing.renderOverview([{ site: '甲院' }], []);
  assert.equal(missing.nativeCalls.length, 1);

  const broken = harness({ mount() { throw new Error('bundle broken'); } });
  broken.renderOverview([{ site: '乙院' }], []);
  assert.equal(broken.nativeCalls.length, 1);
  assert.equal(broken.nativeCalls[0].hospitals[0].site, '乙院');
});

test('React ErrorBoundary 回调：先卸载再用同份数据回退原生渲染', () => {
  let options;
  const h = harness({ mount(container, opts) { options = opts; return true; } });
  const hospitals = [{ site: '丙院' }], products = [{ product: 'p2' }];
  h.renderOverview(hospitals, products);
  options.onError(new Error('render failed'));
  assert.equal(h.getUnmounts(), 1);
  assert.deepEqual(h.nativeCalls, [{ hospitals, products }]);
});

test('稳定全局 API 与离开/退出卸载接线可追溯', () => {
  assert.match(FIELD, /window\.IntakeFieldOverview/);
  assert.match(FIELD, /typeof api0\.mount !== 'function'/);
  assert.match(FIELD, /typeof api0\.unmount !== 'function'/);
  assert.match(FIELD, /unmountReactOverview\(\);\s*clearFieldSessionForLogout/);
  const setMode = extractFn(FIELD, 'setMode');
  assert.match(setMode, /unmountReactOverview\(\);/);
});
