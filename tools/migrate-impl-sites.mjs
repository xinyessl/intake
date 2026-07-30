#!/usr/bin/env node
// 一次性回填「实施人↔医院」到 account.sites（唯一真源）——【加法-only · 幂等 · 非破坏】
//
//   背景（见 docs/lessons.md「实施人↔医院两份存储无同步链路」条）：
//     · 客户档案 data/customers.json 的 customer.impl.name 是「医院管理」设的（纯名字串）。
//     · 账号 MySQL accounts.sites 是「账号管理」设的（负责医院名数组）——实施端可见性 + 全后端数据隔离唯一认它。
//     两者历史上不通 → 医院管理设了某实施人、但其账号 sites 空 → 实施端"尚未分配医院"。
//
//   本脚本做什么（仅加，绝不删）：
//     遍历 data/customers.json，对每个 impl.name 能匹配到「启用 impl/pm 账号」的客户，
//     把 customer.name 加进该账号 sites（去重）。**不因迁移删任何 sites**（避免误伤账号里既有合法分配；
//     一院一实施的排他移动留给日后 customer-save / account-save 写穿）。
//
//   用法：
//     node tools/migrate-impl-sites.mjs            # 实跑（落库）
//     node tools/migrate-impl-sites.mjs --dry-run  # 只打印将做的改动，不落库
//
//   连库配置与 server.mjs 完全一致（env 优先，否则读 data/db.json）；客户读 data/customers.json。
//   对空数据 / 无匹配 → 安全 no-op（打印「0 处改动」）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as db from '../db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.INTAKE_DATA || path.join(ROOT, 'data');
const DB_CFG_FILE = path.join(DATA_DIR, 'db.json');
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const DRY = process.argv.includes('--dry-run');

function readDbCfg() {   // 与 server.mjs readDbCfg 同口径
  let c = {}; try { c = JSON.parse(fs.readFileSync(DB_CFG_FILE, 'utf8')) || {}; } catch {}
  return {
    host: process.env.INTAKE_DB_HOST || c.host || '127.0.0.1',
    port: +(process.env.INTAKE_DB_PORT || c.port || 3306),
    user: process.env.INTAKE_DB_USER || c.user || 'intake',
    password: process.env.INTAKE_DB_PASS || c.password || 'intake@123',
    database: process.env.INTAKE_DB_NAME || c.database || 'intake',
  };
}
function loadCustomers() {
  try { return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')).customers || []; } catch { return []; }
}
const isImplAccount = a => !!a && (a.role === 'impl' || a.role === 'pm') && a.enabled !== 0;

// 纯函数（可被测试直接引用）：给定 accounts + customers，算出加法-only 的回填计划并就地改 accs.sites。
//   返回 [{ site, account }]（本次新增的 (医院→账号) 对）。幂等：已在 sites 内则跳过（无改动）。
export function planAndApply(accs, customers) {
  const changes = [];
  for (const c of customers) {
    const site = String((c && c.name) || '').trim();
    const implName = String((c && c.impl && c.impl.name) || '').trim();
    if (!site || !implName) continue;
    const a = accs.find(x => isImplAccount(x) && (x.name || x.username) === implName);
    if (!a) continue;                                   // 名匹配不到启用实施账号 → 跳过（不臆造）
    if (!Array.isArray(a.sites)) a.sites = [];
    if (a.sites.map(String).includes(site)) continue;   // 已有 → 幂等跳过
    a.sites.push(site);                                 // 仅加，不删
    changes.push({ site, account: a.username });
  }
  return changes;
}

async function main() {
  const cfg = readDbCfg();
  db.configure(cfg);
  await db.init();
  const store = await db.loadAll();
  const accs = store.accounts.map(a => ({ ...a, sites: Array.isArray(a.sites) ? a.sites.slice() : [] }));
  const customers = loadCustomers();

  console.log(`[migrate-impl-sites]${DRY ? ' (dry-run)' : ''} 账号 ${accs.length} 个 · 客户 ${customers.length} 家`);
  const changes = planAndApply(accs, customers);

  if (!changes.length) {
    console.log('无需回填：0 处改动（数据已一致 / 无可匹配的实施人）。');
    process.exit(0);
  }
  for (const ch of changes) console.log(`  + 医院「${ch.site}」→ 账号 ${ch.account}.sites`);
  console.log(`共 ${changes.length} 处将新增（加法-only，不删除任何既有 sites）。`);

  if (DRY) { console.log('dry-run：未落库。去掉 --dry-run 实跑。'); process.exit(0); }
  await db.replaceAccounts(accs);
  console.log('已落库（accounts.sites 更新）。再次运行本脚本应为 0 处改动（幂等）。');
  process.exit(0);
}

// 仅在作为脚本直接运行时执行（被 import 作测试时不自动跑）。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error('迁移失败：', e); process.exit(1); });
}
