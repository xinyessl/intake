#!/usr/bin/env node
// 收件 · intake —— 独立进件服务（零依赖 Node http）
//   给产品经理 / 现场实施：选需求/BUG → 填结构化表单 → AI 沟通补全/给处理意见 → 本地归档。
//   与 steward 物理隔离：只写自己的 intake-store，对产品代码仓【只读】（git tag / spec@tag）。
//
//   API：
//     GET  /api/projects            项目登记（data/projects.json，id/name/repoPath/specsPath）
//     POST /api/project-save        新增/编辑项目（按 id 覆写）
//     POST /api/project-delete      删除项目登记（进件数据保留在盘上）
//     GET  /api/versions            某项目产品版本清单（读 repoPath 的 git tag -l）
//     GET  /api/spec-modules        某项目 spec 模块清单（repoPath@ver / specsPath；无则空）
//     GET  /api/model-config        读模型 API 配置（key 掩码回传）
//     POST /api/model-config-save   存模型 API 配置（provider/apiKey/model/baseUrl）
//     POST /api/model-test          测试模型连通
//     POST /api/intake-submit       表单提交需求/BUG（含 version/site）→ 写 intake-store → AI 首轮沟通
//     POST /api/intake-reply        提交人回复 AI 的澄清 → AI 继续
//     GET  /api/intake-list         某项目进件列表（含 site/version）
//     GET  /api/intake-detail       单条进件详情
//     GET  /api/intake-aggregate    多现场归并（按标题/模块聚合，看通病 vs 某版本回归）
//   用法：node server.mjs  → 打开 http://127.0.0.1:5180
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as db from './db.mjs';
// 现场实施代办清单纯逻辑（部署清单模板/进度/合并/勾选/越权判断，可独立单测：tools/fs-06-checklist.logic.test.mjs）
// 2026-08-05 架构重构：checklist-logic（部署清单模板/批次实施清单纯逻辑）随「跟随产品代码」重构一并废弃，不再 import。
// 更新包「按版本独立维护 + 跨版本累积」纯逻辑（区间/累积/左连/勾选/合并SQL，可独立单测：tools/version-plan.logic.test.mjs）
import { rangeVersions, accumulateManifests, joinProgress as vpJoinProgress, applyToggle as vpApplyToggle, applySqlBundleToggle as vpApplySqlBundleToggle, sqlBundleSummary as vpSqlBundleSummary, mergeSql as vpMergeSql, joinBatchProgress as vpJoinBatchProgress, batchSqlSummary as vpBatchSqlSummary, applyBatchTaskToggle as vpApplyBatchTaskToggle, applyBatchSqlToggle as vpApplyBatchSqlToggle, mergeBatchSql as vpMergeBatchSql } from './tools/version-plan-logic.mjs';
import { readSqlAtTag, readDeployManifestFromSubs, readDeployDirFromSubs, readSqlFileAtHead } from './tools/deploy-manifest-reader.mjs';
import { sortVersions as vpSortVersions } from './tools/version-plan-logic.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));           // 收件项目根目录
const PORT = process.env.PORT || 5180;
const HOST = process.env.BIND || '127.0.0.1';                       // 部署到网络：BIND=0.0.0.0（建议前面挂 HTTPS 反代）
const PUBLIC = HOST !== '127.0.0.1' && HOST !== 'localhost';        // 公网模式：放开同机 Host/Origin 硬校验，靠登录/链接鉴权
// FS-08 双域名部署：field 域（实施端入口）/ admin 域（运营后台入口）绝对地址，环境变量读取（与 PORT/BIND 同范式）。
//   两者任一未配 → 整体回退单域名现状（Host 闸不启用、按 role 分发、submit-link 相对路径），故可先部署代码（env 未配）验证零变化，再配 env 灰度。
const _deployCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(process.env.INTAKE_DATA || path.join(ROOT, 'data'), 'deploy.json'), 'utf8')); } catch { return {}; } })();  // FS-08 域名配置：env 优先，否则读 data/deploy.json（容器 bind-mount data/ 改配置即可、无需重建容器；与 db.json/model-api.json 同范式）
const FIELD_ORIGIN = process.env.FIELD_ORIGIN || _deployCfg.fieldOrigin || '';               // 如 http://intake.lcpharmacy.cn
const ADMIN_ORIGIN = process.env.ADMIN_ORIGIN || _deployCfg.adminOrigin || '';               // 如 http://intake-ops.lcpharmacy.cn
// 从配置的 origin 取 host 部分（容错带/不带协议、末尾斜杠、端口一并保留）。空配置 → 空串。
function hostOf(origin) { const s = String(origin || '').trim(); if (!s) return ''; try { return new URL(/^[a-z]+:\/\//i.test(s) ? s : ('http://' + s)).host.toLowerCase(); } catch { return s.replace(/^[a-z]+:\/\//i, '').replace(/\/.*$/, '').toLowerCase(); } }
const FIELD_HOST = hostOf(FIELD_ORIGIN), ADMIN_HOST = hostOf(ADMIN_ORIGIN);
const DUAL_DOMAIN = !!(FIELD_HOST && ADMIN_HOST);                   // 双域名闸启用当且仅当两 host 都配了；否则整体回退单域名
// 判当前请求来自哪个域：field / admin / other。任一 env 未配（!DUAL_DOMAIN）→ 恒 'other'（回退现状，NH-2）。
function originOf(req) {
  if (!DUAL_DOMAIN) return 'other';
  const h = String((req && req.headers && req.headers.host) || '').toLowerCase();
  if (h && h === FIELD_HOST) return 'field';
  if (h && h === ADMIN_HOST) return 'admin';
  return 'other';   // 未匹配（本机 127.0.0.1/localhost/直连 IP/未配域名）→ 保持现状分发
}
const PUBLIC_DIR = path.join(ROOT, 'public');                       // 前端静态资源
// 数据根目录（密钥/配置/落盘全在这，被 .gitignore 挡住，永不入库）。可用 INTAKE_DATA 覆盖。
const DATA_DIR = process.env.INTAKE_DATA || path.join(ROOT, 'data');
const INTAKE_STORE = path.join(DATA_DIR, 'intake-store');            // 收件自己的库：按 project 分子目录（.md/.json 双写，给开发 git pull）
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');         // 旧文件（迁移入库后仅作历史/迁移源）

// ===== MySQL 为唯一事实源；启动 loadAll 到内存缓存，读走缓存、写穿透库 + 导出 .md =====
const DB_CFG_FILE = path.join(DATA_DIR, 'db.json');
function readDbCfg() {
  let c = {}; try { c = JSON.parse(fs.readFileSync(DB_CFG_FILE, 'utf8')) || {}; } catch {}
  const cfg = { host: process.env.INTAKE_DB_HOST || c.host || '127.0.0.1', port: +(process.env.INTAKE_DB_PORT || c.port || 3306), user: process.env.INTAKE_DB_USER || c.user || 'intake', password: process.env.INTAKE_DB_PASS || c.password || 'intake@123', database: process.env.INTAKE_DB_NAME || c.database || 'intake' };
  try { if (!fs.existsSync(DB_CFG_FILE)) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(DB_CFG_FILE, JSON.stringify(cfg, null, 2)); } } catch {}
  return cfg;
}
const CACHE = { projects: [], accounts: [], sessions: {}, intakes: {}, kb: {} };   // intakes[projId][id]=e；kb[projId]=[]

// 同源/同机防护（M1/M2 仅本机回环；公网认证载体已定=管理端口令+提交页token链接，留到 M3 部署时建）。
const SELF_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const SELF_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);
const MAX_BODY = 30 * 1024 * 1024;   // 请求体上限（含 base64 截图，最多 6 张）

// ===== 模型 API 配置（收件本机，不入库、GET 掩码回传） =====
const MODEL_CFG_FILE = path.join(DATA_DIR, 'model-api.json');
function readModelCfg() { try { return JSON.parse(fs.readFileSync(MODEL_CFG_FILE, 'utf8')) || {}; } catch { return {}; } }
function writeModelCfg(c) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(MODEL_CFG_FILE, JSON.stringify(c)); } catch {} }
function maskKey(k) { k = String(k || ''); return k.length > 8 ? (k.slice(0, 4) + '……' + k.slice(-4)) : (k ? '已配置' : ''); }
// 候选模型 = 主 + 备用（只保留配了 key 的），按序试：主挂了自动切备用。
function modelCandidates(cfg) {
  const one = c => ({ provider: c && c.provider, model: c && c.model, baseUrl: c && c.baseUrl, apiKey: c && c.apiKey });
  const list = [one(cfg), ...((Array.isArray(cfg && cfg.backups) ? cfg.backups : []).map(one))];
  return list.filter(c => c && c.apiKey);
}
// 多模态：把用户附的截图（data URL 数组）并进「最后一条 user 消息」的 content。
//   无图 → 原样返回（content 仍是字符串，纯文本调用一字不变、向后兼容）；
//   有图 → 该 user 消息 content 变多模态块数组（anthropic / openai 两家格式各一套）。
//   图片输入态：仅附到最后一轮 user 提问（本轮截图），历史消息不改。
function mmParseImage(du) {                                            // data:image/png;base64,xxxx → {mediaType,data,url}；非法返回 null
  const m = /^data:(image\/\w+);base64,(.+)$/.exec(String(du || ''));
  return m ? { mediaType: m[1], data: m[2], url: String(du) } : null;
}
function withImages(messages, images, isAnthropic) {
  const imgs = (Array.isArray(images) ? images : []).slice(0, 6).map(mmParseImage).filter(Boolean);   // ≤6 张、过滤非法 data URL
  if (!imgs.length) return messages;                                  // 无有效图 → 原样（纯文本，向后兼容）
  const out = messages.slice();
  let li = -1;                                                        // 最后一条 user 消息下标
  for (let i = out.length - 1; i >= 0; i--) { if (out[i] && out[i].role === 'user') { li = i; break; } }
  if (li < 0) return out;                                             // 没有 user 消息（异常）→ 不动
  const orig = out[li], text = typeof orig.content === 'string' ? orig.content : '';
  const blocks = isAnthropic
    ? [{ type: 'text', text }, ...imgs.map(g => ({ type: 'image', source: { type: 'base64', media_type: g.mediaType, data: g.data } }))]
    : [{ type: 'text', text }, ...imgs.map(g => ({ type: 'image_url', image_url: { url: g.url } }))];
  out[li] = { ...orig, content: blocks };                            // 把最后一条 user 换成多模态块数组
  return out;
}

// 直连模型：主/备按序 failover，返回纯文本
async function callModel(cfg, opts) {
  const cands = modelCandidates(cfg); if (!cands.length) throw new Error('未配置 API Key');
  let lastErr;
  for (let i = 0; i < cands.length; i++) {
    try { return await callModelOnce(cands[i], opts); }
    catch (e) { lastErr = e; if (i < cands.length - 1) console.warn('[model] 第' + (i + 1) + '个模型失败，切下一个：', String((e && e.message) || e)); }
  }
  throw lastErr;
}
// 单次调用某一个模型 API(anthropic 原生 / openai 兼容)，返回纯文本。messages:[{role,content}]，system 可选，images 可选（多模态·并进末条 user）。
async function callModelOnce(cfg, { system, messages, maxTokens = 1024, images }) {
  const provider = cfg.provider || 'anthropic';
  const key = cfg.apiKey; if (!key) throw new Error('未配置 API Key');
  const model = cfg.model || (provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6');
  if (provider === 'anthropic') {
    const base = (cfg.baseUrl || 'https://api.anthropic.com').replace(/\/$/, '');
    const mm = withImages(messages, images, true);   // 有图→末条 user 变多模态块；无图→原样（向后兼容）
    const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: mm }) });
    const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
    return (j.content || []).map(b => b.text || '').join('');
  }
  const base = (cfg.baseUrl || 'https://api.openai.com').replace(/\/$/, '');   // openai 兼容(含国内代理端点)
  const mmMsgs = withImages(messages, images, false);   // 有图→末条 user 变 {type:'image_url'} 块；无图→原样
  const msgs = system ? [{ role: 'system', content: system }, ...mmMsgs] : mmMsgs;
  const r = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens }) });
  const j = await r.json(); if (!r.ok) throw new Error((j.error && j.error.message) || ('HTTP ' + r.status));
  return (((j.choices || [])[0] || {}).message || {}).content || '';
}
// 流式：主/备按序 failover——只在"还没吐出任何内容、且非用户主动停止"时才切备用（避免重复输出）
async function callModelStream(cfg, opts, onDelta, signal) {
  const cands = modelCandidates(cfg); if (!cands.length) throw new Error('未配置 API Key');
  let lastErr;
  for (let i = 0; i < cands.length; i++) {
    let got = false;
    try { return await callModelStreamOnce(cands[i], opts, p => { got = true; if (onDelta) onDelta(p); }, signal); }
    catch (e) { lastErr = e; if ((signal && signal.aborted) || got) throw e; if (i < cands.length - 1) console.warn('[model-stream] 第' + (i + 1) + '个模型失败，切下一个：', String((e && e.message) || e)); }
  }
  throw lastErr;
}
// 单次流式调用某一个模型，逐段回调 onDelta，返回完整文本。signal 支持中止；内置 90s 超时防挂死。
async function callModelStreamOnce(cfg, { system, messages, maxTokens = 1024, images }, onDelta, signal) {
  const provider = cfg.provider || 'anthropic';
  const key = cfg.apiKey; if (!key) throw new Error('未配置 API Key');
  const model = cfg.model || (provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6');
  const isA = provider === 'anthropic';
  const base = (cfg.baseUrl || (isA ? 'https://api.anthropic.com' : 'https://api.openai.com')).replace(/\/$/, '');
  const headers = isA ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'content-type': 'application/json', authorization: 'Bearer ' + key };
  const mm = withImages(messages, images, isA);   // 有图→末条 user 变多模态块（两家格式）；无图→原样字符串（向后兼容）
  const body = isA ? { model, max_tokens: maxTokens, stream: true, ...(system ? { system } : {}), messages: mm } : { model, stream: true, max_tokens: maxTokens, messages: system ? [{ role: 'system', content: system }, ...mm] : mm };
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000);
  const r = await fetch(base + (isA ? '/v1/messages' : '/v1/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal: sig });
  if (!r.ok || !r.body) { let e = ''; try { e = ((await r.json()).error || {}).message || ''; } catch {} throw new Error(e || ('HTTP ' + r.status)); }
  let full = '', buf = ''; const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      let piece = '';
      if (isA) { if (j.type === 'content_block_delta' && j.delta && typeof j.delta.text === 'string') piece = j.delta.text; }
      else piece = (((j.choices || [])[0] || {}).delta || {}).content || '';
      if (piece) { full += piece; if (onDelta) onDelta(piece); }
    }
  }
  return full;
}

// ===== 项目登记（收件自己的，不读 steward 的 ~/.steward/projects.json） =====
// data/projects.json: { "projects": [ { "id":"pams", "name":"病案平台", "repoPath":"（可选·本地产品 git 仓·只读，支持版本）", "specsPath":"（可选·纯 specs 目录·无版本）" } ] }
function loadProjects() { return CACHE.projects.slice(); }
async function saveProjects(list) { CACHE.projects = structuredClone(list); await db.replaceProjects(list); }
function projById(id) { const ps = loadProjects(); return ps.find(p => p.id === id) || null; }   // 未知 id 返回 null，不兜底到第一个

// ===== 客户管理（现场/医院台账）：data/customers.json，文件存储（与 model-config/git-config 同范式）=====
// { customers:[ { id, name:"山东省立医院", level, region, impl:{name,phone}, status, products:[...], updatedAt } ] }
// CU-01 re-target 原型：在最简结构上扩 level/region/impl/status 字段（仍走文件、不迁 MySQL、不建表——迁库=NEEDS-HUMAN）；
//   ticketCount 读时派生（见 custWithTicketCount）。
// products 两种形状并存（2026-07-23 裁决「维护到子系统 + 各自版本」，向后兼容·不破坏性迁移）：
//   · 新形状 { project, subsystems:[{name,version}] }：勾选的子系统各维护一个版本（name 须 ∈ 该产品 subsystems[].name，version ≤30）；
//   · 旧形状 { project, version }（无 subsystems 字段）：产品级版本，照存照读；消费方遇无 subsystems 兜底按「该产品全部子系统@该产品级 version」处理（行为不变）。
//   提交端 /api/customers 现场下拉两形状都回传，绝不破坏；老医院编辑保存时前端带 subsystems → 无损升级成新形状。
const CUSTOMERS_FILE = path.join(DATA_DIR, 'customers.json');
const CUST_LEVELS = ['三甲', '三乙', '二甲'];               // 等级枚举（对齐原型；非法值归一到「三甲」）
const CUST_STATUSES = ['已开通', '未开通'];                 // 开通状态枚举（对齐原型；非法值归一到「已开通」）
function loadCustomers() { try { return JSON.parse(fs.readFileSync(CUSTOMERS_FILE, 'utf8')).customers || []; } catch { return []; } }
function saveCustomers(list) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(CUSTOMERS_FILE, JSON.stringify({ customers: list }, null, 2)); } catch {} }
function custGenId() { return 'c' + crypto.randomBytes(4).toString('hex'); }
// 读某客户对某产品/子系统的现场当前版本（两形状兼容）：
//   新形状 products[project].subsystems[name==sub].version；旧形状 products[project].version（无 subsystems，产品级）。无则空串。
function custSubVersion(cust, productId, subsystem) {
    if (!cust || !Array.isArray(cust.products)) return '';
    const pr = cust.products.find(p => p && p.project === productId); if (!pr) return '';
    if (Array.isArray(pr.subsystems)) { const ms = subsystem ? pr.subsystems.find(s => s && s.name === subsystem) : null; return (ms && ms.version) || ''; }
    return pr.version || '';   // 旧形状：产品级 version（子系统兜底同产品级）
}
// 读某客户对某产品的「产品级现场版本」（累积更新计划的起点 fromVersion）。两形状：
//   · 旧形状 { project, version }：直接取 pr.version。
//   · 新形状 { project, subsystems:[{name,version}] }：无产品级 version——若所有已填子系统版本一致则取该值；
//     否则（版本不一致 / 全空 / 无子系统）返回 ''（视为「最早」→ update-plan 区间取全部 ≤ 目标的已登记版本，交付说明注明）。
//   绝不臆造某个子系统版本当产品版本（含糊即空 include-all，宁多勿错）。
function custProductVersion(cust, productId) {
    if (!cust || !Array.isArray(cust.products)) return '';
    const pr = cust.products.find(p => p && p.project === productId); if (!pr) return '';
    if (Array.isArray(pr.subsystems)) {
        const vers = pr.subsystems.map(s => String((s && s.version) || '').trim()).filter(Boolean);
        if (!vers.length) return '';                                  // 全空 → 视为最早（include-all）
        const uniq = [...new Set(vers)];
        return uniq.length === 1 ? uniq[0] : '';                      // 一致才当产品版本；不一致 → 空（含糊，include-all）
    }
    return String(pr.version || '').trim();                           // 旧形状：产品级 version
}

// ===== 批次（BP-01 第 1 期）：文件存 data/batches.json，与 customers 同范式（NH-4 已裁决 A=文件存不改库） =====
//   批次 = 一条产品线的一批（跨全部医院合并该产品「已立项(已落实)且未归批」工单，内部按 subsystem 分组）。
//   批次 → 工单：batches[].ticketIds（数组）；工单 → 批次：intake.data.batch（=工单对象顶层 e.batch，随 data JSON 落库，不加库列，复用 L1305 范式）。
//   本期只做：定档建批(batch-arrange) + 列表(batches) + 详情(batch-detail)；导清单/上传包/闭环留后续期。
const BATCHES_FILE = path.join(DATA_DIR, 'batches.json');
function loadBatches() { try { return JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8')).batches || []; } catch { return []; } }
function saveBatches(list) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BATCHES_FILE, JSON.stringify({ batches: list }, null, 2)); } catch {} }
// 批次编号 B-<seq>：读现存最大 seq +1（文件存无并发写压力）。解析 B- 后的数字段，取 max，无则从 1 起，两位补零。
function batchGenId(list) {
  let max = 0;
  for (const b of (list || [])) { const m = /^B-(\d+)$/.exec(String((b && b.id) || '')); if (m) { const n = parseInt(m[1], 10); if (n > max) max = n; } }
  return 'B-' + String(max + 1).padStart(2, '0');
}
// 排期时间（计划交付日期）规范化：只认纯日期 yyyy-MM-dd，非法/空 → ''（允许后补，不报错）。
function normScheduleDate(v) { const s = String(v || '').trim(); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : ''; }

// ===== 2026-08-05 架构重构：废弃「标准部署清单模板」（data/deploy-template.json + deploy-template/customer-deploy-task 端点）。
//   部署/更新清单改为「跟随产品代码」——各子系统仓 docs/deploy.json 按 git tag 读（见 readDeployManifest / update-plan）。
//   customer.deployTasks 字段保留兼容（normCustomer 仍读旧完成态不清空），但不再有模板/勾选端点。updateProgress 保留（累积更新计划完成度）。
// 单个产品规范化（新形状「按子系统 + 各自版本」 + 向后兼容旧形状「产品级 version」）：
//   · 新形状：p.subsystems=[{name,version}]（name 须命中该产品 projById(project).subsystems[].name，不命中丢弃防臆造；version ≤30 字符串；按 name 去重）
//     → 产出 { project, subsystems:[{name,version}] }（勾选的子系统；无勾选=空数组仍保留产品，实施端兜底显全部，避免误删）。
//   · 旧形状：p 无 subsystems 字段但带 version（老提交/旧台账）→ 原样保留 { project, version }（消费方遇无 subsystems 兜底按「该产品全部子系统@该产品级 version」处理，行为不变）。
//   绝不删老字段、不强迁——安吉等老医院编辑保存时（前端会带 subsystems）才无损升级成新形状。
function normProduct(p) {
    const project = String((p && p.project) || '').trim();
    if (!project) return null;
    const proj = projById(project); if (!proj) return null;                 // 无效产品 → 由上层过滤
    if (p && Array.isArray(p.subsystems)) {                                  // 新形状：按子系统维护各自版本
        const valid = new Set(subsystemNames(proj));                        // 该产品定义的合法子系统 name 全集
        const seenSub = new Set();
        const subsystems = p.subsystems
            .map(s => ({ name: String((s && s.name) || '').trim(), version: String((s && s.version) || '').trim().slice(0, 30) }))
            .filter(s => s.name && valid.has(s.name) && !seenSub.has(s.name) && seenSub.add(s.name));   // 命中该产品子系统 + 去重（不命中丢弃，防臆造）
        return { project, subsystems };                                     // 可能为空数组（无勾选）：仍保留产品，实施端兜底显全部
    }
    // 旧形状：无 subsystems 字段 → 保留产品级 version（兼容）
    return { project, version: String((p && p.version) || '').trim() };
}
function normCustomer(b, existing) {   // 规范化：名称必填、products 只保留有效产品（新形状带子系统各自版本 / 兼容旧产品级版本）；扩 level/region/impl/status
    const name = String((b && b.name) || '').trim().slice(0, 60);
    const seen = new Set();
    const products = (Array.isArray(b && b.products) ? b.products : []).map(normProduct)
        .filter(p => p && p.project && !seen.has(p.project) && seen.add(p.project)).slice(0, 40);   // 去重（按 project）+ ≤40 产品
    const level = CUST_LEVELS.includes(String((b && b.level) || '').trim()) ? String(b.level).trim() : '三甲';
    const region = String((b && b.region) || '').trim().slice(0, 40);
    const status = CUST_STATUSES.includes(String((b && b.status) || '').trim()) ? String(b.status).trim() : '已开通';
    const impl = { name: String((b && b.impl && b.impl.name) || '').trim().slice(0, 20), phone: String((b && b.impl && b.impl.phone) || '').trim().slice(0, 20) };
    // 扩展字段（2026-07-30 用户需求：服务器信息/设备码/维保时间/医院联系人/备注）——用 `'x' in b` 判存在，偏更新（如实施人写穿）保留原值不清空。
    const pick = (k, n) => String(((b && (k in b)) ? b[k] : (existing && existing[k])) || '').trim().slice(0, n);
    const serverInfo = pick('serverInfo', 1000), deviceCode = pick('deviceCode', 120), remark = pick('remark', 1000);
    const maintainEnd = pick('maintainEnd', 20);   // 维保到期时间（单个日期 yyyy-MM-dd）
    // 医院联系人（可多个）contacts:[{name,phone}]；兼容旧扁平 contactName/contactPhone → 迁为一条
    let ctIn = (b && Array.isArray(b.contacts)) ? b.contacts : ((existing && Array.isArray(existing.contacts)) ? existing.contacts : null);
    if (!ctIn) { const on = pick('contactName', 20), op = pick('contactPhone', 20); ctIn = (on || op) ? [{ name: on, phone: op }] : []; }
    const contacts = ctIn.map(x => ({ name: String((x && x.name) || '').trim().slice(0, 20), phone: String((x && x.phone) || '').trim().slice(0, 20) })).filter(x => x.name || x.phone).slice(0, 20);
    // 部署清单每院完成态（overlay，2026-08-03 起**按产品嵌套** {[productId]:{[taskId]:{done,by,at}}}，只存已完成项）——
    //   偏更新（如实施端勾选、customer-save）保留原值不清空，用 `'deployTasks' in b` 判存在。旧 flat 形状读进来也不崩（消费方按嵌套解析、flat 安全丢弃）。
    const deployTasks = (b && ('deployTasks' in b)) ? (b.deployTasks && typeof b.deployTasks === 'object' ? b.deployTasks : {}) : ((existing && existing.deployTasks && typeof existing.deployTasks === 'object') ? existing.deployTasks : {});
    // 累积更新计划完成态（overlay，2026-08-03）：按 (产品×版本×条目) 分记 {[productId]:{[version]:{tasks:{[id]:{done,by,at}},sqls:{...}}}}，只存已完成项。
    //   偏更新（实施端勾选、customer-save）保留原值不清空，用 `'updateProgress' in b` 判存在。
    const updateProgress = (b && ('updateProgress' in b)) ? (b.updateProgress && typeof b.updateProgress === 'object' ? b.updateProgress : {}) : ((existing && existing.updateProgress && typeof existing.updateProgress === 'object') ? existing.updateProgress : {});
    return { id: (existing && existing.id) || custGenId(), name, level, region, impl, status, products, serverInfo, deviceCode, maintainEnd, contacts, remark, deployTasks, updateProgress, updatedAt: nowStamp() };
}
// 工单数派生：按 site↔客户名 关联统计（真库 intakes 无 customerId 列，关联键 site↔name——重名会串号，NEEDS-HUMAN）。
//   全项目扫一遍 listIntake（不含 consult），按 site 计数，供客户台账只读展示；不落文件、不改库。
function custTicketCountBySite() {
    const cnt = Object.create(null);
    try { for (const p of loadProjects()) { for (const it of listIntake(p)) { const s = (it.site || '').trim(); if (s) cnt[s] = (cnt[s] || 0) + 1; } } } catch {}
    return cnt;
}
// ===== 实施人↔医院 唯一真源 = account.sites（2026-07-23 裁决：一院一实施·双向写穿）=====
//   关联键 = 医院名字符串（account.sites 元素 === customer.name === intakes.site，重名会串号，同 ticketCount 限制 NEEDS-HUMAN）。
//   实施账号判定：role∈{impl,pm} 且 enabled!==0；显示名匹配用 (a.name||a.username)===impl.name。
function isImplAccount(a) { return !!a && (a.role === 'impl' || a.role === 'pm') && a.enabled !== 0; }
// 反查「负责某医院」的实施账号：sites 含该医院名的启用 impl/pm。
//   共管场景（impl 落地 + pm 统筹同持一院，2026-07-23 裁决允许）→「负责实施」优先取 role==='impl'（真正实施人），其次 pm；
//   同角色再按 username 字典序取确定性第一个。无则 null。
function implAccountForSite(accs, siteName) {
    const nm = String(siteName || '').trim(); if (!nm) return null;
    return accs.filter(a => isImplAccount(a) && Array.isArray(a.sites) && a.sites.map(String).includes(nm))
        .sort((x, y) => {
            const rx = x.role === 'impl' ? 0 : 1, ry = y.role === 'impl' ? 0 : 1;   // impl 优先于 pm
            if (rx !== ry) return rx - ry;
            return String(x.username || '').localeCompare(String(y.username || ''));
        })[0] || null;
}
// 医院管理 impl 读时派生（不信客户档案那份死值，零漂移）：从 account.sites 反查当前负责该医院的账号。
function deriveImpl(accs, custName) {
    const a = implAccountForSite(accs, custName);
    return a ? { name: (a.name || a.username || ''), phone: (a.phone || '') } : { name: '', phone: '' };
}
// 从「所有账号」的 sites 里移除某医院名（就地改 accs；一院一实施排他 / 改名清旧名 / 清空实施人时用）。返回是否有改动。
function removeSiteFromAllAccounts(accs, siteName) {
    const nm = String(siteName || '').trim(); if (!nm) return false;
    let changed = false;
    for (const a of accs) {
        if (!Array.isArray(a.sites)) continue;
        const next = a.sites.map(String).filter(s => s !== nm);
        if (next.length !== a.sites.length) { a.sites = next; changed = true; }
    }
    return changed;
}
// 双向写穿核心：把某医院名「唯一」归给某实施账号（先从所有账号移除，再加进目标账号 sites 去重）。
//   targetName 为空 → 只移除（未指定实施人 = 该医院从所有账号解绑）。目标名匹配不到实施账号 → 只移除（防御性；UI 只给存在账号）。
//   就地改 accs，返回是否有改动。
function reconcileSiteToImpl(accs, siteName, targetImplName) {
    const nm = String(siteName || '').trim(); if (!nm) return false;
    let changed = removeSiteFromAllAccounts(accs, nm);   // 先排他移除（含目标账号，随后再加回，保证幂等去重）
    const tgt = String(targetImplName || '').trim();
    if (tgt) {
        const a = accs.find(x => isImplAccount(x) && (x.name || x.username) === tgt);
        if (a) { if (!Array.isArray(a.sites)) a.sites = []; a.sites.push(nm); changed = true; }
        // else：目标名匹配不到启用 impl/pm 账号 → 仅移除、不加（边界，交付说明注明）。
    }
    return changed;
}
function custWithTicketCount(list) {   // 给每条客户挂读时派生的 ticketCount + impl（均不写文件）
    const cnt = custTicketCountBySite();
    const accs = loadAccounts();
    // 2026-08-05 架构重构：废弃「标准部署清单模板」进度派生（deployDone/deployTotal）——部署清单改为跟随产品代码（update-plan）。
    return list.map(c => ({ ...c, impl: deriveImpl(accs, c.name), ticketCount: cnt[(c.name || '').trim()] || 0 }));
}
// git 引用安全校验：只允许 tag/branch/sha 常见字符，挡掉选项注入（如 --upload-pack）。空=不安全/未提供。
function safeRef(v) { v = String(v || '').trim(); return (/^[A-Za-z0-9._\-\/]+$/.test(v) && !v.startsWith('-')) ? v : ''; }
// core.quotepath=false：让 git 直接输出 UTF-8 中文路径，不做八进制转义（否则 ls-tree 的中文文件名喂给 git show 会失配）
function gitOut(repoPath, args) { try { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoPath, encoding: 'utf8', timeout: 8000 }); return r.status === 0 ? (r.stdout || '') : ''; } catch { return ''; } }

// ===== 产品仓只读上下文：git tag 列表 + spec@tag =====
function listVersions(proj) {   // 产品版本候选 = 各子系统仓 git tag 的并集（按版本号倒序）
  const set = new Set(); const repos = [];
  ((proj && proj.subsystems) || []).forEach(s => { if (s && s.repoPath) repos.push(s.repoPath); });
  if (proj && proj.repoPath) repos.push(proj.repoPath);
  for (const rp of repos) { if (!fs.existsSync(rp)) continue; gitOut(rp, ['tag', '-l', '--sort=-v:refname']).split('\n').forEach(t => { t = t.trim(); if (t) set.add(t); }); }
  return [...set].sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 200);
}
// 每个子系统仓各自的 git tag（各子系统 git 地址/tag 不同 → 各显各的，别用产品级并集）。返回 { 子系统name: [tag倒序] }。
function versionsBySubsystem(proj) {
  const out = {};
  ((proj && proj.subsystems) || []).forEach(s => {
    const name = (typeof s === 'string') ? s : (s && s.name);
    const rp = (typeof s === 'string') ? '' : (s && s.repoPath);
    if (!name) return;
    let tags = [];
    if (rp && fs.existsSync(rp)) { try { tags = gitOut(rp, ['tag', '-l', '--sort=-v:refname']).split('\n').map(t => t.trim()).filter(Boolean); } catch {} }
    out[name] = tags.sort((a, b) => b.localeCompare(a, undefined, { numeric: true })).slice(0, 200);
  });
  return out;
}
function specFilesAt(repoPath, ref) {   // 列出某版本(或工作树) docs/specs 下的 .md
  if (ref) { const out = gitOut(repoPath, ['ls-tree', '-r', '--name-only', ref, '--', 'docs/specs']); return out.split('\n').map(s => s.trim()).filter(f => f.endsWith('.md') && !path.basename(f).startsWith('_') && path.basename(f).toLowerCase() !== 'readme.md'); }
  try { const d = path.join(repoPath, 'docs', 'specs'); return fs.readdirSync(d).filter(f => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase() !== 'readme.md').map(f => 'docs/specs/' + f); } catch { return []; }
}
function specFileText(repoPath, ref, rel) { if (ref) return gitOut(repoPath, ['show', `${ref}:${rel}`]); try { return fs.readFileSync(path.join(repoPath, rel), 'utf8'); } catch { return ''; } }

// ===== 部署/更新清单「跟随产品代码」：按 git tag 读各子系统仓 docs/deploy.json（2026-08-05 架构重构）=====
//   约定见 docs/约定-产品部署清单.md。intake 只读 clone 产品仓，不写、不改库。
//   git 读取器抽到 tools/deploy-manifest-reader.mjs（可脱离 MySQL/server 用真实临时 git 仓单测）。
//   聚合读某产品某 tag 的部署清单（跨子系统），带 (projId,tag) 轻缓存（refreshRepos 后 tag 内容视为不变·本进程内缓存·重启失效）。
const DEPLOY_MANIFEST_CACHE = new Map();   // key = projId+'@'+tag → 聚合结果
function readDeployManifest(proj, tag) {
  const projId = (proj && proj.id) || '';
  const t = String(tag || '').trim();
  if (!projId || !t) return { tasks: [], sql: [] };
  const ck = projId + '@' + t;
  if (DEPLOY_MANIFEST_CACHE.has(ck)) return DEPLOY_MANIFEST_CACHE.get(ck);
  const subs = [];
  ((proj && proj.subsystems) || []).forEach(s => { if (s && s.repoPath) subs.push({ name: String(s.name || s.key || '').trim(), repoPath: s.repoPath }); });
  if (proj && proj.repoPath) subs.push({ name: '', repoPath: proj.repoPath });   // 兼容顶层单仓
  const out = readDeployManifestFromSubs(subs, t);
  DEPLOY_MANIFEST_CACHE.set(ck, out);
  return out;
}

// ===== 2026-08-05 架构重构（核心更新流 · 草稿源 = 代码目录 @HEAD）=====
//   模型：代码 docs/deploy/<版本>.json + sql/*.sql = 清单/SQL 的**草稿源**（读 @HEAD，一版一文件）。
//     发包时 intake 从代码拉出 (起始版本, 目标版本] 累积草稿 → 运营人审可改 → 快照冻结进 batch.deployPlan。
//     实施侧读批次快照（见 update-plan/update-sql-merged 改造），不再实时读代码、不再跨版累积。
//   本函数只做「拉草稿」：读 @HEAD 目录 → 取区间 → 累积 → SQL 正文一并读出（供审核 + 冻结）。缓存不做（发包低频，且要读最新代码）。
function subsOfProj(proj) {
  const subs = [];
  ((proj && proj.subsystems) || []).forEach(s => { if (s && s.repoPath) subs.push({ name: String(s.name || s.key || '').trim(), repoPath: s.repoPath }); });
  if (proj && proj.repoPath) subs.push({ name: '', repoPath: proj.repoPath });   // 兼容顶层单仓
  return subs;
}
// 拉某产品 (from, to] 区间的累积部署清单草稿（@HEAD 目录形态）。
//   from 空 = 从头（首装场景由 RS-6 另做，这里更新流一般 from 有值；空则 include 全部 ≤to）。
//   返回 { from, to, versions:[实际有清单的版本·升序], tasks:[{id(=gid),title,desc,version,subsystem}], sql:[{id(=gid),title,desc,version,subsystem,file,content}] }。
//     · id 用 gid（跨子系统唯一，作为快照条目稳定 id）；title：task 用 title、sql 用 file/desc 兜底。
//     · sql.content：优先读 file 正文（readSqlFileAtHead @HEAD），file 缺用内联 content，读不到留说明占位（供审核可见）。
function computeDeployDraft(proj, from, to) {
  const subs = subsOfProj(proj);
  const byVersion = readDeployDirFromSubs(subs);                        // { [version]: {tasks,sql} }（@HEAD 全版本）
  const allVersions = vpSortVersions(Object.keys(byVersion));           // 语义升序（文件名=版本号）
  const range = rangeVersions(allVersions, from, to);                   // (from, to] 升序
  const manifestByVersion = {};
  for (const v of range) manifestByVersion[v] = byVersion[v] || { tasks: [], sql: [] };
  const acc = accumulateManifests(range, manifestByVersion);           // 复用累积（tasks/sqls 各带 version）
  // 组织成审核用草稿：tasks 直用；sql 逐条读正文（@HEAD file 引用 → readSqlFileAtHead，供审核可见 + 冻结）。
  const tasks = acc.tasks.map(t => ({ id: t.id, title: t.title || '', desc: t.desc || '', version: t.version, subsystem: t.subsystem || '' }));
  const sql = acc.sqls.map(s => {
    let content = String(s.content || '');
    if (s.file) {
      const fileText = readSqlFileAtHead(s.repoPath, s.file);           // @HEAD 读文件正文
      content = fileText || content || ('-- （无法读取文件 ' + s.file + ' @ HEAD，请核对产品仓该路径是否存在）');
    }
    return { id: s.id, title: s.file || s.desc || s.id, desc: s.desc || '', version: s.version, subsystem: s.subsystem || '', file: s.file || '', content };
  });
  return { from: String(from || '').trim(), to: String(to || '').trim(), versions: acc.versionsInRange, tasks, sql };
}
// 快照存/取工具：batch.deployPlan = { from, to, tasks:[{id,title,desc}], sql:[{id,title,desc,content}], reviewedBy, reviewedAt }。
//   规范化审核提交的 tasks/sql（长度约束对齐 normDeployManifest：title≤120、desc≤2000、sql desc≤200、content≤20000；title 非空丢弃）。
function normDeployPlanItems(rawTasks, rawSql) {
  const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const tasks = [];
  const seenT = new Set();
  for (const t of (Array.isArray(rawTasks) ? rawTasks : [])) {
    const title = clip(t && t.title, 120);
    if (!title) continue;                                              // title 非空才收
    let id = clip(t && t.id, 80) || ('dt' + crypto.randomBytes(3).toString('hex'));
    if (seenT.has(id)) id = 'dt' + crypto.randomBytes(3).toString('hex');
    seenT.add(id);
    tasks.push({ id, title, desc: clip(t && t.desc, 2000) });
    if (tasks.length >= 300) break;
  }
  const sql = [];
  const seenS = new Set();
  for (const s of (Array.isArray(rawSql) ? rawSql : [])) {
    const content = String((s && s.content) != null ? s.content : '').slice(0, 20000);
    const title = clip(s && s.title, 200);
    if (!content.trim() && !title) continue;                          // 空 SQL（无正文无标题）丢弃
    let id = clip(s && s.id, 80) || ('ds' + crypto.randomBytes(3).toString('hex'));
    if (seenS.has(id)) id = 'ds' + crypto.randomBytes(3).toString('hex');
    seenS.add(id);
    sql.push({ id, title: title || '升级 SQL', desc: clip(s && s.desc, 200), content });
    if (sql.length >= 300) break;
  }
  return { tasks, sql };
}

// spec 来源：产品可挂 N 个子系统仓（各 subsystem.repoPath），也兼容顶层单 repoPath / specsPath
function specSources(proj) {
  const out = [];
  ((proj && proj.subsystems) || []).forEach(s => { if (s && typeof s === 'object' && s.repoPath) out.push({ sub: s.name || '', repoPath: s.repoPath }); });
  if (proj && proj.repoPath) out.push({ sub: '', repoPath: proj.repoPath });
  if (proj && proj.specsPath) out.push({ sub: '', specsPath: proj.specsPath });
  return out;
}
function parseSpecText(t, f) { const mod = ((t.match(/^module:\s*(.+)$/m) || [])[1] || '').trim(); const ti = ((t.match(/^title:\s*(.+)$/m) || [])[1] || String(f).replace(/\.md$/, '')).trim(); return { module: mod, title: ti }; }
function specEntries(proj, ver) {   // → [{subsystem,module,title}]，跨子系统仓聚合
  const out = [], ref = safeRef(ver);
  for (const src of specSources(proj)) {
    if (src.repoPath && fs.existsSync(src.repoPath)) {
      for (const f of specFilesAt(src.repoPath, ref).slice(0, 30)) { const t = specFileText(src.repoPath, ref, f).slice(0, 800); if (!t) continue; const m = parseSpecText(t, path.basename(f)); out.push({ subsystem: src.sub, module: m.module, title: m.title }); }
    } else if (src.specsPath) { try { for (const f of fs.readdirSync(src.specsPath)) { if (!f.endsWith('.md') || f.startsWith('_') || f.toLowerCase() === 'readme.md') continue; const m = parseSpecText(fs.readFileSync(path.join(src.specsPath, f), 'utf8').slice(0, 800), f); out.push({ subsystem: src.sub, module: m.module, title: m.title }); } } catch {} }
    if (out.length >= 90) break;
  }
  return out.slice(0, 90);
}
function specIndex(proj, ver) { return specEntries(proj, ver).map(e => `[${e.subsystem ? e.subsystem + '·' : ''}${e.module}] ${e.title}`).join('\n'); }
function specModules(proj, ver) { const set = new Set(); for (const e of specEntries(proj, ver)) if (e.module) set.add((e.subsystem ? e.subsystem + '/' : '') + e.module); return [...set]; }
// 答疑召回：把 spec 正文读进来（缓存 10 分钟，避免每条消息都重读几十份仓文件），再按问题检索最相关的几份
const SPEC_TEXT_CACHE = new Map();   // projId@ref -> { at, specs:[{subsystem,module,title,text}] }
function loadSpecTexts(proj, ver) {
  const ref = safeRef(ver), key = proj.id + '@' + ref, now = Date.now();
  const c = SPEC_TEXT_CACHE.get(key); if (c && now - c.at < 600000) return c.specs;
  const specs = [];
  for (const src of specSources(proj)) {
    if (src.repoPath && fs.existsSync(src.repoPath)) {
      for (const f of specFilesAt(src.repoPath, ref).slice(0, 60)) { const full = specFileText(src.repoPath, ref, f); if (!full) continue; const m = parseSpecText(full.slice(0, 800), path.basename(f)); specs.push({ subsystem: src.sub, module: m.module, title: m.title, text: full }); }
    } else if (src.specsPath) {
      try { for (const f of fs.readdirSync(src.specsPath)) { if (!f.endsWith('.md') || f.startsWith('_') || f.toLowerCase() === 'readme.md') continue; const full = fs.readFileSync(path.join(src.specsPath, f), 'utf8'); const m = parseSpecText(full.slice(0, 800), f); specs.push({ subsystem: src.sub, module: m.module, title: m.title, text: full }); } } catch {}
    }
    if (specs.length >= 150) break;
  }
  SPEC_TEXT_CACHE.set(key, { at: now, specs });
  return specs;
}
function chunkSpec(text) {   // spec 正文切段：先把"表格段"并入其上一段（表名/说明常在表格上一行，别让表名和表体分家），再按 ~560 字聚合
  const body = String(text || '').replace(/^---[\s\S]*?---\s*/, '');
  const paras = body.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const merged = [];
  for (const p of paras) { const isTable = /^\|.*\|/.test(p) || /\n\s*\|/.test(p); if (isTable && merged.length) merged[merged.length - 1] += '\n\n' + p; else merged.push(p); }
  const chunks = []; let cur = '';
  for (const p of merged) { if ((cur + '\n\n' + p).length > 560 && cur) { chunks.push(cur); cur = p; } else cur = cur ? cur + '\n\n' + p : p; }
  if (cur) chunks.push(cur); return chunks;
}
const TABLE_Q = /表|字段|库|数据库|入库|存哪|哪张|落库|column|schema|table|field/i;   // "看哪张表/什么字段"这类问库表
const API_Q = /接口|api|调用|请求|端点|endpoint|url/i;                                  // "调哪个接口"这类问接口
const DATA_MARK = /数据契约|主表|列名|varchar|char\(|bigint|\bPK\b|表结构/;              // spec 里「数据契约」段特征
const API_MARK = /接口契约|GET \/|POST \/|PUT \/|DELETE \//;                            // 「接口契约」段特征
function specSearch(proj, ver, query, n = 5, subKey = '') {   // chunk 级检索：返回最相关的 spec 片段 [{subsystem,module,title,text}]；subKey 收窄到该子系统
  const qset = new Set(kbTokenize(query)); if (!qset.size) return [];
  let specs = loadSpecTexts(proj, ver); if (!specs.length) return [];
  if (subKey) { const sc = specs.filter(s => (s.subsystem || '') === subKey); if (sc.length) specs = sc; }   // 用户指定了子系统 → 只在该子系统的 spec 里检索（该子系统无 spec 才回退全部）
  const tableQ = TABLE_Q.test(query), apiQ = API_Q.test(query), schemaQ = tableQ || apiQ;
  const chunks = [];
  for (const s of specs) {
    const titleHit = new Set();   // 该 spec 标题/模块命中的问题词（问表/接口时用它把"对的那份 spec"的契约段顶上来）
    for (const t of kbTokenize((s.title || '') + ' ' + (s.module || ''))) if (qset.has(t)) titleHit.add(t);
    for (const ck of chunkSpec(s.text)) chunks.push({ subsystem: s.subsystem, module: s.module, title: s.title, titleHit, text: ck, tset: new Set(kbTokenize(ck)) });
  }
  if (!chunks.length) return [];
  const df = {}; for (const c of chunks) for (const t of c.tset) df[t] = (df[t] || 0) + 1;
  const N = chunks.length, idf = t => Math.log((N + 1) / ((df[t] || 0) + 0.5));   // 稀有词权重更高，压掉"处方/审核/通过"这类通用词噪声
  const ranked = chunks.map(c => {
    let sc = 0; for (const t of qset) if (c.tset.has(t)) sc += idf(t);
    const boost = (tableQ && DATA_MARK.test(c.text)) || (apiQ && API_MARK.test(c.text));   // 问表→顶数据契约段；问接口→顶接口契约段（且所属 spec 标题命中问题）
    if (boost) { let tm = 0; for (const t of c.titleHit) tm += idf(t); sc += tm * 2.4; }
    return { c, sc };
  }).filter(x => x.sc > 0).sort((a, b) => b.sc - a.sc);
  const cap = schemaQ ? 3 : 2, out = [], perFile = {};   // 问表/接口时多带该 spec 一段契约
  for (const { c } of ranked) { if ((perFile[c.title] || 0) >= cap) continue; perFile[c.title] = (perFile[c.title] || 0) + 1; out.push({ subsystem: c.subsystem, module: c.module, title: c.title, text: c.text.slice(0, 800) }); if (out.length >= n) break; }
  return out;
}
// 「深入思考」：spec 不够时直接 git grep 克隆的源码，把最相关的几段代码喂给 AI。用问题里的中文长词 + 英文标识 + spec 里的表名/接口路径当搜索词。
function codeSearch(proj, ver, query, specHits, n = 4, subKey = '') {
  const ref = safeRef(ver);
  // 词特异性打分：英文标识（表名 x_y / 接口路径段 / 驼峰）判别性最强给最高分；中文 n-gram 越长越具体分越高（4-gram > 2-gram）。
  const isIdent = t => /[A-Za-z_]/.test(t);
  const spec = t => isIdent(t) ? 100 + t.length : t.length;   // 英文标识 >> 4-gram > bigram
  // ① query 自己的词（主信号，永远优先、满权重）：中文 bigram/4-gram + query 里的英文标识
  const qSet = new Set();
  const zh = String(query).replace(/[^一-龥]/g, '');
  for (let i = 0; i + 2 <= zh.length; i++) qSet.add(zh.slice(i, i + 2));   // 中文 bigram（匹配代码里的中文标签/注释）
  for (let i = 0; i + 4 <= zh.length; i++) qSet.add(zh.slice(i, i + 4));   // 4-gram（更具体、判别性强）
  (String(query).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).forEach(w => qSet.add(w));
  // ② spec 注入词（次要·仅作「中文问题→英文表名」的桥）：从召回的 spec 正文抽表名/接口路径段
  //    ⚠️ specSearch 可能召回跑题 spec，其注入的稀有英文表名（特异性 100+）若与 query 词混塞同一预算/权重，
  //    会把 query 自身判别性中文词（如「说明书」）挤出预算/盖过得分，把答案文件挤出 top（第四层 bug，CHG 记）。
  //    ⇒ 分源建词：spec 词去掉与 query 重复的、限量填预算剩余、打分乘 <1 降权系数，绝不许挤掉/盖过 query 词。
  const sSet = new Set();
  const specText = (specHits || []).map(h => h.text || '').join('\n');
  (specText.match(/\b[a-z][a-z0-9]*_[a-z0-9_]{2,}\b/g) || []).forEach(w => sSet.add(w));   // 表名/字段
  (specText.match(/\/(api|comm)\/[A-Za-z0-9_]+/g) || []).forEach(w => sSet.add(w));         // 接口路径段
  for (const t of qSet) sSet.delete(t);   // spec 词去重（与 query 重复的归 query，享满权重）
  const OK = /\.(vue|[cm]?[jt]sx?|java|kt|xml|sql|py|go|cs|php|rb|c|cc|cpp|h|hpp|scala|sh|yaml|yml)$/i;   // 只看真源码
  const SKIPDIR = /node_modules\/|\/dist\/|iconfont|\.min\.|\/mock\//i;
  const lenBonus = t => isIdent(t) ? 3 : (t.length >= 4 ? 2 : 1);   // IDF 加权时长词/英文标识的系数
  const bySpec = (a, b) => spec(b) - spec(a);   // 各源内部仍按特异性降序（英文标识/4-gram > bigram）
  // 预算保底：query 词优先占大头（≤20），spec 词只填剩余且限量（≤4）——判别性 query 词（说明书/药品说明…）必须在预算内。
  const qTerms = [...qSet].filter(t => t && t.length >= 2).sort(bySpec).slice(0, 20);
  const sTerms = [...sSet].filter(t => t && t.length >= 2).sort(bySpec).slice(0, 4);
  const specSourced = new Set(sTerms);   // 标记 spec 注入词：打分时降权，防跑题 spec 表名盖过 query 词
  const termList = [...qTerms, ...sTerms];
  if (!termList.length) return [];
  const files = {};   // key -> {dir,path,terms:Set,lineTerms:Map(行号→命中它的词集合)}
  const df = {};      // 文档频率：命中每个词的不同文件数（跨本次 grep 的所有仓）
  let dirs = repoDirsOf(proj);
  if (subKey) { const sc = dirs.filter(d => (d.name || '') === subKey); if (sc.length) dirs = sc; }   // 指定子系统 → 只 grep 该子系统仓（匹配不到才回退全部）
  const grepDirs = (dlist, useRef) => {   // 对给定仓集合跑一遍 grep，累计到 files/df；useRef=false → 用工作树/HEAD（跨仓回退时各仓 tag 不同，非当前仓 tag 可能不存在）
    for (const { dir } of dlist) {
      if (!fs.existsSync(dir)) continue;
      const r = useRef ? ref : '';
      for (const t of termList) {
        const out = gitOut(dir, ['grep', '-n', '-i', '-F', t, ...(r ? [r] : [])]);
        const seen = new Set();   // 本词在本仓命中的不同文件（算 df 用，每文件每词只记一次）
        for (const line of out.split('\n')) {
          if (!line.trim()) continue;
          const rest = r ? line.replace(new RegExp('^' + r.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'), '') : line;
          const m = rest.match(/^(.+?):(\d+):/); if (!m || !OK.test(m[1]) || SKIPDIR.test(m[1])) continue;
          const key = dir + '|' + m[1], f = files[key] || (files[key] = { dir, path: m[1], ref: r, terms: new Set(), lineTerms: new Map() });
          f.terms.add(t);
          // 记「每个命中行是被哪些词命中的」（取片阶段按行的最高词权重优先选，别只按 grep 顺序封顶 40）
          const lnNo = +m[2]; let ls = f.lineTerms.get(lnNo); if (!ls) { if (f.lineTerms.size < 400) { ls = new Set(); f.lineTerms.set(lnNo, ls); } } if (ls) ls.add(t);
          seen.add(key);
        }
        if (seen.size) df[t] = (df[t] || 0) + seen.size;
      }
    }
  };
  grepDirs(dirs, true);
  // 稀有词加权（IDF 式）：稀有词 df 小 → 权重高；大众词 df 大 → 权重趋 0；长词/英文标识再加成。
  //   spec 注入词乘 0.5 降权：即便某个 spec 表名很稀有（高 IDF），也不会盖过同样稀有的 query 词（说明书），
  //   off-topic 的 mapper XML 就压不过真答案文件（第四层 bug 修法，CHG 记）。
  const weight = t => (specSourced.has(t) ? 0.5 : 1) * lenBonus(t) / Math.log2(2 + (df[t] || 0));
  const scoreOf = f => { let s = 0; for (const t of f.terms) s += weight(t); return s; };
  // subKey 收敛后本子系统加权 top 得分文件过少（<2）→ 回退到全部子系统再 grep 一遍补齐
  //   跨仓时各仓 tag 不同：非当前仓统一用无 ref（工作树/HEAD），避免 git grep <不存在的tag> 返回空
  if (subKey) {
    const scored = Object.values(files).filter(f => scoreOf(f) > 0);
    if (scored.length < 2) {
      const all = repoDirsOf(proj), rest = all.filter(d => (d.name || '') !== subKey);
      if (rest.length) grepDirs(rest, false);
    }
  }
  const top = Object.values(files).sort((a, b) => scoreOf(b) - scoreOf(a) || b.lineTerms.size - a.lineTerms.size).slice(0, n);
  // 每行的判别性 = 命中它的词里的最高权重（稀有词/英文标识 → 高）。取片时按此降序选命中行，
  // 让判别性命中行（连同 ±6 窗口）一定进片段；大众词命中行用剩余预算补。否则大众词命中行（如「医嘱」占满文件顶部）会把答案行挤出窗口。
  const lineWeight = ls => { let w = 0; for (const t of ls) { const tw = weight(t); if (tw > w) w = tw; } return w; };
  return top.map(f => {   // 取匹配行 ±6 行窗口、稀有词优先选、合并相邻、截断（f.ref：当前仓用 tag，回退仓用空=工作树/HEAD）
    const full = String(specFileText(f.dir, f.ref, f.path) || '').split('\n');
    // 候选命中行按「该行最高词权重」降序（判别性强的先选）；同权按行号，稳定
    const cand = [...f.lineTerms.entries()].map(([ln, ls]) => ({ ln, w: lineWeight(ls) })).sort((a, b) => b.w - a.w || a.ln - b.ln);
    const keep = new Set();
    let lineBudget = 40, charEst = 0;   // 行预算 40；字符预算按窗口估（2200，容纳相距较远的两处判别性窗口，如 L301 与 L1610）
    for (const { ln } of cand) {
      if (lineBudget <= 0 || charEst > 2200) break;
      let added = 0;
      for (let i = Math.max(1, ln - 6); i <= Math.min(full.length, ln + 6); i++) { if (!keep.has(i)) { keep.add(i); added++; charEst += (full[i - 1] || '').length + 1; } }
      lineBudget -= (added || 1);   // 已被前一窗口覆盖的命中行几乎不耗预算，仍算 1 防死循环
    }
    const nums = [...keep].sort((a, b) => a - b); let snip = '', last = 0;
    for (const i of nums) { if (snip.length > 2000) { snip += '\n…'; break; } if (last && i > last + 1) snip += '\n…'; snip += '\n' + (full[i - 1] || ''); last = i; }
    return { file: f.path, text: snip.trim().slice(0, 2200) };
  });
}

// ===== Git 集成（GitLab）：贴 组/仓 地址 → 自动 id/名称/子系统；服务器 clone 到缓存供读 spec/版本 =====
const GIT_CFG_FILE = path.join(DATA_DIR, 'git-config.json');
const REPOS_CACHE = path.join(DATA_DIR, 'repos');
function readGitCfg() { try { return JSON.parse(fs.readFileSync(GIT_CFG_FILE, 'utf8')) || {}; } catch { return {}; } }
function writeGitCfg(c) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(GIT_CFG_FILE, JSON.stringify(c)); } catch {} }
function maskTok(t) { t = String(t || ''); return t.length > 10 ? (t.slice(0, 6) + '……' + t.slice(-4)) : (t ? '已配置' : ''); }
function gitBase() { return (readGitCfg().baseUrl || '').replace(/\/$/, ''); }
function sanId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'proj'; }
async function glApi(pathq) { const c = readGitCfg(); if (!c.baseUrl || !c.token) throw new Error('未配置 Git 集成（host + token）'); const r = await fetch(gitBase() + '/api/v4' + pathq, { headers: { 'PRIVATE-TOKEN': c.token } }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.message) || ('HTTP ' + r.status)); return j; }
function gitUrlPath(u) { try { u = String(u || '').trim().replace(/\.git$/, '').replace(/\/-\/.*$/, ''); const m = u.match(/^https?:\/\/[^/]+\/(.+)$/); return m ? m[1].replace(/\/$/, '') : String(u).replace(/^\/+|\/+$/g, ''); } catch { return ''; } }
// 顶层 gitUrl 缺失时，从子系统仓地址反推「组/命名空间」地址（去掉末段 <repo>.git），保证卡片/编辑能显示 Git 已接
function deriveGitUrl(proj) { if (proj && proj.gitUrl) return proj.gitUrl; const sub = ((proj && proj.subsystems) || []).find(s => s && s.repoUrl); return sub ? String(sub.repoUrl).replace(/\.git$/, '').replace(/\/[^/]+$/, '') : ''; }
async function gitInspect(u) {   // 解析 URL → {id,name,gitUrl,subsystems:[{key,name,repoUrl}]}
  const p = gitUrlPath(u); if (!p) throw new Error('Git 地址无法解析');
  let group = null;
  try { group = await glApi('/groups/' + encodeURIComponent(p)); } catch {}
  if (!group) {   // 不是组 → 当作单个仓：id 取仓名，子系统就它一个（贴啥得啥，不再自动上钻到父组）
    const proj = await glApi('/projects/' + encodeURIComponent(p));
    return { id: sanId(proj.path), name: proj.name || proj.path, gitUrl: proj.web_url || u, subsystems: [{ key: proj.path, name: proj.name || proj.path, desc: (proj.description || '').trim(), repoUrl: proj.http_url_to_repo }] };
  }
  const projs = await glApi('/groups/' + group.id + '/projects?include_subgroups=true&per_page=100&archived=false');
  const subs = (Array.isArray(projs) ? projs : []).map(x => ({ key: x.path, name: x.name || x.path, desc: (x.description || '').trim(), repoUrl: x.http_url_to_repo }));
  const name = (group.description && group.description.trim()) || group.name || group.path;
  return { id: sanId(group.path.split('/').pop()), name, gitUrl: group.web_url || (gitBase() + '/' + group.full_path), groupPath: group.full_path, subsystems: subs };
}
function cloneRepo(projectId, key, repoUrl) {   // clone/pull 到缓存，返回本地路径（失败返回空）
  const c = readGitCfg(); if (!c.token || !repoUrl) return '';
  const dir = path.join(REPOS_CACHE, sanId(projectId), sanId(key) || 'main');
  const authUrl = String(repoUrl).replace(/^(https?:\/\/)/, (m) => m + 'oauth2:' + c.token + '@');
  try {
    if (fs.existsSync(path.join(dir, '.git'))) { spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', authUrl], { timeout: 20000 }); const r = spawnSync('git', ['-C', dir, 'fetch', '--all', '--tags', '--prune'], { timeout: 90000 }); return r.status === 0 ? dir : dir; }
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const r = spawnSync('git', ['clone', '--no-single-branch', authUrl, dir], { timeout: 180000 });
    return r.status === 0 ? dir : '';
  } catch { return ''; }
}
// 代码新鲜度：clone 是快照，只在登记时拉一次。这里把各子系统仓 fetch 最新 tag + reset 工作树到上游，
// 让"版本清单(tag)"和"无版本时读的 spec 正文(工作树)"都是最新。带 15 分钟冷却；force=true 立即同步。
const REPO_SYNC_AT = new Map();   // projId -> 上次同步时间戳
function repoDirsOf(proj) { const d = []; ((proj && proj.subsystems) || []).forEach(s => { if (s && s.repoPath) d.push({ dir: s.repoPath, name: s.name || s.key || '' }); }); if (proj && proj.repoPath) d.push({ dir: proj.repoPath, name: '' }); return d; }
function refreshRepos(proj, force) {
  const now = Date.now(), last = REPO_SYNC_AT.get(proj.id) || 0;
  if (!force && now - last < 900000) return { skipped: true, at: last };
  const repos = [], c = readGitCfg();
  for (const { dir, name } of repoDirsOf(proj)) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    try {
      if (c.token) { const cur = gitOut(dir, ['remote', 'get-url', 'origin']).trim(); const clean = cur.replace(/^(https?:\/\/)([^@/]*@)?/, '$1'); const auth = clean.replace(/^(https?:\/\/)/, (m) => m + 'oauth2:' + c.token + '@'); spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', auth], { timeout: 15000 }); }   // 重嵌当前 token，防轮换后拉不动
      const f = spawnSync('git', ['-C', dir, 'fetch', '--all', '--tags', '--prune', '--force'], { timeout: 90000 });
      spawnSync('git', ['-C', dir, 'reset', '--hard', '@{u}'], { timeout: 30000 });   // 工作树对齐远端默认分支（spec 无版本时读这里）
      const head = gitOut(dir, ['log', '-1', '--format=%h｜%ci｜%s']).trim();
      const tags = gitOut(dir, ['tag', '-l']).split('\n').filter(Boolean).length;
      repos.push({ name, ok: f.status === 0, head: head.slice(0, 90), tags });
    } catch { repos.push({ name, ok: false, head: '', tags: 0 }); }
  }
  REPO_SYNC_AT.set(proj.id, now);
  for (const k of [...SPEC_TEXT_CACHE.keys()]) if (k.startsWith(proj.id + '@')) SPEC_TEXT_CACHE.delete(k);   // 代码变了，spec 缓存作废
  return { at: now, repos };
}
function fmtSyncAt(ts) { if (!ts) return ''; const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }

// ===== 进件（需求/BUG）：写收件自己的 intake-store，AI 沟通澄清/给处理意见 =====
function intakeDir(proj) { return path.join(INTAKE_STORE, proj.id); }   // 落本地 intake-store/<projectId>/，不碰产品代码仓
function intakeGenId(proj, type) { const d = new Date(); const dp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; const pre = type === 'bug' ? 'BUG' : type === 'consult' ? 'ZX' : 'XQ'; let n = 1; try { n = fs.readdirSync(intakeDir(proj)).filter(f => f.startsWith(`${pre}-${dp}`) && f.endsWith('.md')).length + 1; } catch {} return `${pre}-${dp}-${String(n).padStart(2, '0')}`; }
function yamlEsc(s) { s = String(s == null ? '' : s).replace(/\n/g, ' ').trim(); return /[:#"']/.test(s) ? JSON.stringify(s) : s; }
function renderIntakeMd(e) {   // 结构化 frontmatter + 可读正文 + 沟通记录
  const fm = ['---', `id: ${e.id}`, `type: ${e.type}`, `project: ${e.project}`, `version: ${yamlEsc(e.version)}`, `site: ${yamlEsc(e.site)}`, `subsystem: ${yamlEsc(e.subsystem)}`, `module: ${yamlEsc(e.module)}`, `title: ${yamlEsc(e.title)}`, `priority: ${yamlEsc(e.priority)}`];
  if (e.type === 'bug') { fm.push(`severity: ${yamlEsc(e.severity)}`, `scope: ${yamlEsc(e.scope)}`, `env: ${yamlEsc(e.env)}`, `freq: ${yamlEsc(e.freq)}`); }
  fm.push(`reporter: ${yamlEsc(e.reporter)}`, `role: ${yamlEsc(e.role)}`, `contact: ${yamlEsc(e.contact)}`, `status: ${e.status}`, `lifecycle: ${e.lifecycle || deriveLifecycle(e)}`, `assignee: ${yamlEsc(e.assignee)}`, `submittedAt: ${e.submittedAt}`, '---', '');
  let body = [`# ${e.title}\n`];
  if (e.type === 'bug') { body.push(`## 问题现象\n${e.desc || ''}\n`, `## 报错信息\n${e.errorInfo || '（无）'}\n`, `## 复现步骤\n${e.steps || ''}\n`, `## 期望结果\n${e.expectResult || '（无）'}\n`); if (e.opinion) body.push(`## AI 处理意见\n${e.opinion}\n`); }
  else if (e.type === 'consult') { body.push(`> 系统答疑对话（问答见下方沟通记录）\n`); }
  else { body.push(`## 需求背景 / 为什么\n${e.bg || ''}\n`, `## 期望效果 / 具体描述\n${e.reqDesc || ''}\n`, `## 使用场景 / 涉及角色\n${e.scene || '（无）'}\n`, `## 验收标准\n${e.accept || '（无）'}\n`, `## 关联页面 / 功能\n${e.relate || '（无）'}\n`); }
  if (e.media && e.media.length) body.push(`## 截图 / 视频\n${e.media.map(m => '- ' + m).join('\n')}\n`);
  if (e.analysis && (e.analysis.verdict || e.analysis.detail)) body.push(`## AI 分析初判\n- 类别：${e.analysis.category || ''}｜建议：${e.analysis.suggestion === 'reply' ? '直接回复' : '立项开发'}\n- 结论：${e.analysis.verdict || ''}\n\n${e.analysis.detail || ''}\n`);
  if (e.resolution && (e.resolution.commit || e.resolution.pr || e.resolution.fixedVersion || e.resolution.note)) body.push(`## 处理结果\n- 修复版本：${e.resolution.fixedVersion || '—'}｜commit：${e.resolution.commit || '—'}｜PR：${e.resolution.pr || '—'}\n${e.resolution.note ? '- ' + e.resolution.note + '\n' : ''}`);
  if (e.chat && e.chat.length) body.push('## 沟通记录\n' + e.chat.map(m => `**${m.role === 'assistant' ? 'AI' : (m.role === 'dev' ? '开发' : (e.reporter || '提交人'))}**：${m.text}`).join('\n\n') + '\n');
  if (e.history && e.history.length) body.push('## 流转记录\n' + e.history.map(h => `- ${h.at || ''} ${h.from ? h.from + ' → ' : ''}**${h.to}**（${h.by || ''}${h.byRole ? '/' + h.byRole : ''}）${h.note ? '：' + h.note : ''}`).join('\n') + '\n');
  return fm.join('\n') + body.join('\n');
}
async function saveIntake(proj, e) {   // 缓存 + MySQL(为准) + 导出 .md/.json（git 契约）
  (CACHE.intakes[proj.id] || (CACHE.intakes[proj.id] = {}))[e.id] = structuredClone(e);
  await db.upsertIntake(proj.id, e);
  try { const dir = intakeDir(proj); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, e.id + '.json'), JSON.stringify(e, null, 2)); fs.writeFileSync(path.join(dir, e.id + '.md'), renderIntakeMd(e)); } catch {}
}
function loadIntake(proj, id) { const e = CACHE.intakes[proj.id] && CACHE.intakes[proj.id][id]; return e ? ensureLifecycle(structuredClone(e)) : null; }
function listIntake(proj, opts = {}) { const m = CACHE.intakes[proj.id] || {}; let arr = Object.values(m).filter(e => !e.deleted); if (!opts.withConsult) arr = arr.filter(e => e.type !== 'consult'); const out = arr.map(e => ({ id: e.id, type: e.type, title: e.title, subsystem: e.subsystem || '', module: e.module, version: e.version || '', site: e.site || '', priority: e.priority, reporter: e.reporter, status: e.status, lifecycle: deriveLifecycle(e), assignee: e.assignee || '', batch: e.batch || '', convertedTo: e.convertedTo || '', submittedAt: e.submittedAt, updatedAt: e.updatedAt || e.submittedAt, unread: !!e.needReply })); return out.sort((a, b) => (b.updatedAt || b.submittedAt || '').localeCompare(a.updatedAt || a.submittedAt || '')); }
// 多现场归并：按 标题(归一化)+模块 聚合，展开 现场/版本/条数，看"通病 vs 某版本回归"
function aggregateIntake(proj) {
  const norm = t => String(t || '').toLowerCase().replace(/\s+/g, '').replace(/[，,。.、!！?？:：]/g, '');
  const map = new Map();
  for (const it of listIntake(proj)) {
    const key = norm(it.title) + '|' + (it.module || '');
    let g = map.get(key); if (!g) { g = { title: it.title, module: it.module || '', count: 0, types: new Set(), sites: new Set(), versions: new Set(), statuses: new Set(), ids: [] }; map.set(key, g); }
    g.count++; if (it.type) g.types.add(it.type); if (it.site) g.sites.add(it.site); if (it.version) g.versions.add(it.version); if (it.lifecycle) g.statuses.add(it.lifecycle); g.ids.push(it.id);
  }
  return [...map.values()].map(g => ({ title: g.title, module: g.module, count: g.count, types: [...g.types], sites: [...g.sites], versions: [...g.versions], statuses: [...g.statuses], ids: g.ids })).sort((a, b) => b.count - a.count);
}
// ===== 工单生命周期状态机（SPEC-工单状态机-001）=====
// TK-01【扩展】新增 暂缓 / 已驳回 两态（承载 §5.3，从「待评审」处理决策抽屉分支③进入）。底层原有 9 态不改，只追加。
const LIFECYCLE = ['待处理', '分析中', '已回复', '已立项', '开发中', '已出包', '待验证', '已关闭', '已重开', '暂缓', '已驳回'];
const TRANSITIONS = {   // 合法下一步（"任意非关闭态 → 已关闭"单独放行）
  '待处理': ['分析中', '已回复', '已立项', '暂缓', '已驳回'], '分析中': ['已回复', '已立项', '暂缓', '已驳回'],
  '已回复': ['已重开'], '已立项': ['开发中'], '开发中': ['已出包'],
  '已出包': ['待验证'], '待验证': ['已重开'], '已重开': ['开发中', '分析中'], '已关闭': ['已重开'],
  // TK-01【扩展】暂缓可复议（回分析中 / 直接立项）；已驳回不复议，仅可走「已重开」（P0 §F 决策4）
  '暂缓': ['分析中', '已立项', '已重开'], '已驳回': ['已重开'],
};
function deriveLifecycle(e) { if (e.type === 'consult') return e.lifecycle || '已答复'; if (e.lifecycle) return e.lifecycle; return ({ '待处理': '待处理', '沟通中': '分析中', '已归档': '已关闭', '已处理': '已关闭' })[e.status] || '待处理'; }
function ensureLifecycle(e) { if (e && !e.lifecycle) { e.lifecycle = deriveLifecycle(e); if (!Array.isArray(e.history)) e.history = [{ from: '', to: e.lifecycle, by: e.reporter || '', byRole: 'field', at: e.submittedAt || '', note: '提交' }]; } return e; }
// 兼容旧 status（看板粗粒度统计用）：待处理→待处理、已关闭/暂缓/已驳回→已处理（进「已关闭」聚合环）、其余→沟通中
function lifecycleToStatus(lc) { if (lc === '待处理') return '待处理'; if (lc === '已关闭' || lc === '暂缓' || lc === '已驳回') return '已处理'; return '沟通中'; }
function nowStamp() { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
const PRIORITY_SET = new Set(['紧急', '高', '中', '低']);   // 紧急程度四档（与后台 inbox.html/detail.html 配色一致）
// 现场手选优先级规范化：合法四档→原值；非法/空→回落 fallback（AI 猜的 rec.priority 或默认「中」）。防脏值入 intakes.priority(VARCHAR(10))。
function normPriority(v, fallback = '中') { const s = String(v == null ? '' : v).trim(); return PRIORITY_SET.has(s) ? s : (fallback || '中'); }
function intakeHead(e) {   // 把一条工单压成给模型看的正文（AI 沟通 + 分析共用）
  return `【${e.type === 'bug' ? 'BUG' : '需求'}】${e.title}\n版本：${e.version || '未指定'}｜现场：${e.site || '未指定'}｜模块：${e.module}｜优先级：${e.priority}` + (e.type === 'bug' ? `｜严重：${e.severity}｜环境：${e.env}｜频率：${e.freq}\n现象：${e.desc}\n报错：${e.errorInfo || '无'}\n复现：${e.steps}\n期望：${e.expectResult || '无'}` : `\n背景：${e.bg}\n期望效果：${e.reqDesc}\n场景：${e.scene || '无'}\n验收：${e.accept || '无'}\n关联：${e.relate || '无'}`);
}
function analyzeSystem(proj, ver) {   // 平台内 AI 版本感知初判：只输出严格 JSON
  const idx = specIndex(proj, ver);
  return `你是「版本感知的进件分析助手」，面向开发。项目「${proj.name}」${ver ? `版本 ${ver}` : ''} 的系统模块清单：\n${idx || '（暂无 spec 索引）'}\n\n判断下面这条进件，只输出一个严格 JSON（不要任何多余文字/解释/JSON 之外的内容），字段：\n{"category":"非bug|bug|该版本已修|需求","verdict":"一句话结论","suggestion":"reply|file","detail":"给开发的要点：可能原因/建议先查什么/大概落哪个模块；若能当场答复，附一段可直接发给现场的话"}\n判定口径：该版本 spec 本就这样→非bug（可能是新需求）；违反该版本 spec→bug；该现象在更高版本已修→该版本已修（建议现场升级）；全新诉求→需求。suggestion：能当场解决=reply，需要开发改动=file。`;
}
function parseAnalysis(txt) { try { const m = /\{[\s\S]*\}/.exec(String(txt || '')); if (!m) return null; const j = JSON.parse(m[0]); const cat = ['非bug', 'bug', '该版本已修', '需求'].includes(j.category) ? j.category : 'bug'; const sug = j.suggestion === 'reply' ? 'reply' : 'file'; return { category: cat, verdict: String(j.verdict || '').trim(), suggestion: sug, detail: String(j.detail || '').trim() }; } catch { return null; } }

function intakeSystem(type, proj, ver) {
  const idx = specIndex(proj, ver);
  return `你是「需求/BUG 进件助手」。对面是产品经理/实施工程师(不懂技术、不看代码)。项目「${proj.name}」${ver ? `（版本 ${ver}）` : ''}的系统模块清单（供你把进件对到正确模块）：\n${idx || '（暂无 spec 索引）'}\n\n你的任务：\n- 若是【需求】：判断是否讲清楚了。没讲清就用大白话问 1~2 个最关键的澄清问题（每次别超过2个）；讲清了就一句话确认你的理解 + 指出它大概落在哪个模块。\n- 若是【BUG】：根据现象/报错，给一个初步「处理意见 / 可能原因 / 建议先排查什么」，供开发参考；信息不足就问关键的1个点（如具体报错、哪条数据）。\n- 【绝不写代码、不臆造功能】。回复要简短、口语化、条理清楚，中文。`;
}
function subsystemNames(proj) { return ((proj && proj.subsystems) || []).map(s => (typeof s === 'string' ? s : (s && s.name) || '')).filter(Boolean); }
// 对话式进件：AI 主导按「提交标准」逐条问齐 + 推断子系统/模块，够了就输出 intake-record 归档块
function intakeChatSystem(proj, type, ver, subKey) {
  const idx = specIndex(proj, ver), subs = subsystemNames(proj);
  const merged = type !== 'bug' && type !== 'requirement';   // 合并模式：AI 自己判是需求还是 BUG
  const typ = merged ? '需求 / BUG' : (type === 'bug' ? 'BUG' : '需求');
  const stdReq = '一句话标题、需求背景(为什么/解决什么)、期望效果/具体描述、验收标准(可选)、关联的现有页面/功能(可选)。';
  const stdBug = '一句话标题、问题现象、复现步骤、报错信息(若有)、期望结果、严重程度(阻塞/影响使用/轻微)、影响范围、环境(生产/预发/测试/开发)、频率(必现/偶现)，并给一个初步「处理意见/可能原因/建议先查什么」。';
  const std = merged
    ? `先判断 TA 说的是【需求】(想要新功能 / 改进现有功能) 还是【BUG】(现有功能出问题 / 报错 / 不符预期)——你自己判，别问"这算需求还是BUG"这种术语问题。判出来后按对应标准收集：\n· 若是需求：${stdReq}\n· 若是 BUG：${stdBug}`
    : (type === 'bug' ? '· ' + stdBug : '· ' + stdReq);
  const pinned = subKey && subs.includes(subKey);
  const subBlock = subs.length ? `\n产品「${proj.name}」下分这些【子系统】：\n${subs.map(s => '· ' + s + (s === subKey ? '（用户已指定，就归到这里）' : '')).join('\n')}\n${pinned ? `※ 用户已明确选定子系统【${subKey}】——subsystem 字段直接填「${subKey}」，别再判别/追问是哪个子系统（模块 module 仍按描述判断）。\n` : ''}` : '';
  return `你是「${typ}进件助手」，正在和产品经理/实施工程师(不懂技术、不看代码)对话，帮 TA 把一条${merged ? '【需求或 BUG】' : `【${typ}】`}按标准说清楚并归档。产品「${proj.name}」${ver ? `（版本 ${ver}）` : ''}。${subBlock}${idx ? `各子系统/模块功能清单（帮你对到正确位置）：\n${idx}\n` : ''}
【路由纪律 · 很重要】用户往往分不清自己的问题属于哪个子系统/模块——
- 绝不让 TA 从列表里选、也别问"属于哪个子系统"这种术语问题。你根据 TA 的大白话描述，自己判断落在哪个【子系统】+【模块】。
- 判出来后用大白话确认，例：「这个听起来是在【审方】开处方时遇到的，对吗？」——让 TA 点头即可。
- 若一句话分不清，只问一个"用户能答的场景问题"来区分（例：「你是在开处方时遇到的，还是事后看点评报告时？」），据答案归位。
- 实在判不了，就先把 subsystem、module 都填「待定」，不要卡着不归档——开发侧会再归位。

对话风格：一次最多问 1~2 个最关键的问题，别一股脑问；简短、口语、中文；绝不写代码、不臆造。开场先热情地请 TA 一句话说说想要什么/遇到什么。
按提交标准核对信息是否齐（缺什么问什么，已说清的别重复问）：
${std}

【你就是进件系统本身 · 直接建单，绝不让用户去别处复制粘贴】——你不是"帮用户整理文字再让 TA 拿去别的需求/工单系统提交"的助手；你输出的归档块**就是这套系统直接据以建单**的指令。信息齐了就**直接输出归档块建单**，绝不把单子写成"已整理为N条，可复制提交""请复制到你们的需求管理系统"这类给用户手工搬运的文字（那是错的、之前就踩过这个坑）。

当信息按标准基本齐、且子系统/模块已确认（或标待定）后：先用一两句确认你的理解(若是 BUG 顺带给处理意见)，然后在回复的最末尾附归档块（用户看不到里面内容，别在正文里提"归档块"三个字），严格 JSON、字段名照抄：
\`\`\`intake-record
{"type":"","subsystem":"","module":"","title":"","priority":"中","desc":"","errorInfo":"","steps":"","expectResult":"","severity":"","scope":"","env":"","freq":"","bg":"","reqDesc":"","accept":"","relate":"","opinion":""}
\`\`\`
【一条问题一个块 · 多条就输出多个块】TA 一次可能说了**多条**需求/BUG——每条独立问题各自输出**一个 intake-record 块**（系统会据此各建一张单）；有几条齐了就在回复末尾接连附几个 intake-record 块（块与块之间可空行），**绝不**把多条塞进一个块、也绝不因"有多条"就退化成纯文字让用户自己复制。哪几条还没问清就先别为那几条出块，继续追问补齐即可（已齐的照常出块）。
${merged ? 'type 必填："bug"(问题/缺陷) 或 "requirement"(需求/改进)，按你判断的类别填；' : `type 填 "${type}"；`}priority 必填，按问题严重度/影响面判定，取值仅限【紧急/高/中/低】：紧急=线上阻断/资损/大面积无法使用；高=核心流程受阻但有临时办法或影响部分人；中=一般问题/改进(默认)；低=轻微/优化建议。拿不准填「中」。只有信息按标准基本齐才输出 record；还在澄清阶段就别输出。`;
}
async function intakeAI(proj, e) {   // 组装对话喂模型，返回 AI 文本
  const cfg = readModelCfg(); if (!cfg.apiKey) return { ok: false, reply: '（未配置模型 API，管理员配置后 AI 才会自动沟通。内容已收到并存档。）', configured: false };
  const messages = [{ role: 'user', content: intakeHead(e) }];
  for (const m of (e.chat || [])) messages.push({ role: m.role, content: m.text });
  try { const txt = await callModel(cfg, { system: intakeSystem(e.type, proj, e.version), messages, maxTokens: 700 }); return { ok: true, reply: (txt || '').trim(), configured: true }; }
  catch (err) { return { ok: false, reply: '（AI 暂时连不上：' + String((err && err.message) || err) + '。内容已存档，稍后可再沟通。）', configured: true }; }
}

// ===== 经验库 KB（答疑的依据）：data/kb/<projectId>.json，问题→解法条目，越攒越准 =====
const KB_DIR = path.join(DATA_DIR, 'kb');
function kbFile(projId) { return path.join(KB_DIR, String(projId).replace(/[^a-z0-9_-]/gi, '') + '.json'); }
function loadKB(projId) { return (CACHE.kb[projId] || []).slice(); }
async function saveKB(projId, arr) { CACHE.kb[projId] = structuredClone(arr); await db.replaceKB(projId, arr); try { fs.mkdirSync(KB_DIR, { recursive: true }); fs.writeFileSync(kbFile(projId), JSON.stringify({ entries: arr }, null, 2)); } catch {} }
function kbTokenize(s) { s = String(s || '').toLowerCase(); const out = []; const cjk = s.match(/[一-鿿]/g) || []; for (let i = 0; i < cjk.length - 1; i++) out.push(cjk[i] + cjk[i + 1]); (s.match(/[a-z0-9]+/g) || []).forEach(w => { if (w.length > 1) out.push(w); }); return out; }
// KB 条目 subsystem 存的是英文 name（如 audit）；解析该产品子系统目录取中文 desc 用于展示。查不到回退原 name（含空）。仅供展示：subsystemLabel 是加法字段，原 subsystem(英文 name) 保留不变，供搜索/过滤用。
function kbSubLabel(projId, subName) { const p = projById(projId); const s = ((p && p.subsystems) || []).find(x => x && (x.name === subName)); return (s && (s.desc || s.name)) || subName || ''; }
// minScore：相关度门槛（命中的不同 query token 数下限）。默认 1（保持历史行为：drawer /api/kb-search、intake-chat 等所有调用方不变）。
//   consult 显式收紧到 2（见 /api/consult），过滤只蹭到一个常见词的弱匹配（如仅命中「药师」1 token 的无关条目），避免注入 + 展示与提问无关的引用。
function kbSearch(projId, query, n = 5, minScore = 1) {   // 零依赖关键词召回（中文 bigram + 英文词重叠）
  const entries = loadKB(projId); if (!entries.length) return [];
  const q = new Set(kbTokenize(query)); if (!q.size) return [];
  const lo = Math.max(1, minScore | 0);
  return entries.map(e => { const toks = kbTokenize([e.q, e.a, e.subsystem, e.module, (e.tags || []).join(' ')].join(' ')); let sc = 0; const seen = new Set(); for (const t of toks) if (q.has(t) && !seen.has(t)) { sc++; seen.add(t); } return { e, sc }; })
    .filter(x => x.sc >= lo).sort((a, b) => b.sc - a.sc).slice(0, n).map(x => x.e);
}

/* ===== 经验库语义检索（embedding · OpenAI 兼容 {baseUrl}/embeddings） =====
   embedding 配置存 data/model-api.json 的 `embed` 字段 {provider,model,baseUrl,apiKey}（与 models 并存、互不覆盖）。
   核心 kbRetrieve = 关键词 + 语义混合召回：语义可用时 sim>=SEM_GATE || lex>=minScore 入选（rank=sim+微量 lex 加权）；
   语义不可用（未配置/调用/embed 任一步失败）时**完全退回旧关键词行为**（kbSearch 同口径）。绝不报错、绝不空结果——见 §安全兜底。 */
const SEM_GATE = 0.42;                                               // 语义相关门槛（余弦 · 不相关文本实测约 0.23）
function loadEmbedCfg() { const e = (readModelCfg() || {}).embed; return (e && e.apiKey && e.baseUrl && e.model) ? e : null; }   // 三要素齐全才算配置好，否则 null（=语义不可用，退回关键词）
async function embedTexts(texts) {                                   // 批量取向量：POST {baseUrl}/embeddings，返回 [[...],[...]] 与 input 顺序对齐
  const cfg = loadEmbedCfg(); if (!cfg) throw new Error('未配置 embedding 模型');
  const base = String(cfg.baseUrl).replace(/\/$/, '') + '/embeddings';
  const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + cfg.apiKey }, body: JSON.stringify({ model: cfg.model, input: texts }), signal: AbortSignal.timeout(30000) });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
  const data = (j && j.data) || []; return data.map(d => d.embedding);
}
function cosine(a, b) {                                              // 标准余弦；长度不等或空 → 0
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return (na && nb) ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
// KB 向量缓存 data/kb-embed.json = {[entryId]:{h:内容hash,v:向量}}；内存 + 文件双缓存。
const KB_EMBED_FILE = path.join(DATA_DIR, 'kb-embed.json');
let _kbEmbedCache = null;
function loadKbEmbed() { if (_kbEmbedCache) return _kbEmbedCache; try { _kbEmbedCache = JSON.parse(fs.readFileSync(KB_EMBED_FILE, 'utf8')) || {}; } catch { _kbEmbedCache = {}; } return _kbEmbedCache; }
function saveKbEmbed(m) { _kbEmbedCache = m; try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(KB_EMBED_FILE, JSON.stringify(m)); } catch {} }
function kbEntryText(e) { return [e.q, e.a, e.subsystem, e.module, (e.tags || []).join(' ')].filter(Boolean).join('\n'); }
function _kbHash(s) { return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16); }
// 补算该产品所有 KB 条目缺失/过期的向量并写缓存；try/catch 失败静默（不阻断检索、退回关键词）。
async function ensureKbEmbed(projId) {
  try {
    if (!loadEmbedCfg()) return;
    const entries = loadKB(projId); if (!entries.length) return;
    const cache = loadKbEmbed(); const need = [];
    for (const e of entries) { const h = _kbHash(kbEntryText(e)); const c = cache[e.id]; if (!c || c.h !== h) need.push({ id: e.id, h, t: kbEntryText(e) }); }
    if (!need.length) return;
    const vs = await embedTexts(need.map(x => x.t));                 // 批量补算
    if (vs.length === need.length) { need.forEach((x, i) => { cache[x.id] = { h: x.h, v: vs[i] }; }); saveKbEmbed(cache); }
  } catch { /* 静默：embedding 失败不影响关键词检索 */ }
}
// 给定 query（qtok 关键词集合 + 可选预算 qv 语义向量）对某产品 KB 打混合分，返回 [{e,rank}]。
//   qv 传入=复用外部 embed 一次（跨产品聚合用）；qv 为 null 且已配 embed 但想内部 embed 由调用方先备。
//   语义可用（qv 有值 + 有缓存向量）：入选 sim>=SEM_GATE || lex>=minScore，rank=sim+(lex>=minScore?0.001*lex:0)；
//   语义不可用：入选 lex>=minScore，rank=lex（完全退回旧 kbSearch 行为）。
function _kbScored(projId, query, qtok, qv, minScore = 1) {
  const entries = loadKB(projId); if (!entries.length) return [];
  const lo = Math.max(1, minScore | 0);
  const cache = (qv && qv.length) ? loadKbEmbed() : null;
  const semUsable = !!(qv && qv.length);
  const out = [];
  for (const e of entries) {
    const toks = kbTokenize([e.q, e.a, e.subsystem, e.module, (e.tags || []).join(' ')].join(' '));
    let lex = 0; const seen = new Set(); for (const t of toks) if (qtok.has(t) && !seen.has(t)) { lex++; seen.add(t); }
    if (semUsable) {
      const c = cache && cache[e.id]; const sim = (c && c.v) ? cosine(qv, c.v) : 0;
      if (sim >= SEM_GATE || lex >= lo) out.push({ e, rank: sim + (lex >= lo ? 0.001 * lex : 0) });
    } else {
      if (lex >= lo) out.push({ e, rank: lex });                      // 退回旧行为
    }
  }
  return out;
}
// 单产品混合召回：内部 embed 一次 query（若已配 embed），失败自动退回关键词。返回条目数组（Top-N）。
async function kbRetrieve(projId, query, n = 5, minScore = 1) {
  const qtok = new Set(kbTokenize(query)); if (!qtok.size) return [];
  let qv = null;
  if (loadEmbedCfg()) {
    try { await ensureKbEmbed(projId); const vs = await embedTexts([query]); qv = (vs && vs[0]) || null; }
    catch { qv = null; }                                             // 任一步失败 → 语义不可用，退回关键词
  }
  return _kbScored(projId, query, qtok, qv, minScore).sort((a, b) => b.rank - a.rank).slice(0, n).map(x => x.e);
}

function intakeSolution(e) {   // 从已解决工单里抽"解法"用于沉淀：根因/处理说明 + 修复版本一起带（别只留版本号，2026-07-30 用户反馈）
  const res = e.resolution || {};
  const devs = (e.chat || []).filter(m => m.role === 'dev');
  // 根因/处理说明：人工 note 优先 → 开发回复 → AI 意见(opinion) → AI 初判根因(analysis.detail)
  const body = String((res.note || (devs.length ? devs[devs.length - 1].text : '') || e.opinion || (e.analysis && e.analysis.detail) || '')).trim();
  const ver = res.fixedVersion ? '修复版本：' + res.fixedVersion : '';
  return [body, ver].filter(Boolean).join('\n\n');   // 有根因 + 有版本 → 两段都带；只有版本（发包只写 fixedVersion）→ 退回仅版本，但不再吞掉已有的 analysis 根因
}
async function kbAddFromIntake(proj, e) {   // 工单解决时自动沉淀成经验；按来源去重
  try {
    const a = intakeSolution(e); if (!a) return false;
    const q = (e.title || '') + (e.desc ? '：' + e.desc : (e.reqDesc ? '：' + e.reqDesc : ''));
    const arr = loadKB(proj.id).slice(); if (arr.some(x => x.from === e.id)) return false;
    arr.push({ id: 'k' + crypto.randomBytes(4).toString('hex'), q: q.slice(0, 400), a: String(a).slice(0, 1500), subsystem: e.subsystem || '', module: e.module || '', tags: [], from: e.id, at: nowStamp() });
    await saveKB(proj.id, arr); return true;
  } catch { return false; }
}
// KB-01：把 kb-save 传入的 source/from_ref 归一成内存对象的 from（replaceKB 依 from 派生库列 source/from_ref）。
//   source∈{manual,consult}          → from=source（库 source=同名、from_ref=同名，对齐现有 manual/consult 行）
//   有来源工单 from_ref（且非 manual/consult）→ from=该工单 id（库 source=auto、from_ref=工单id，对齐工单自动沉淀 BUG沉淀）
//   source=auto 但无工单               → from='auto'（库 source=auto、from_ref='auto'）
//   都没传                              → 返回 ''（调用方回退 'manual'，与旧实现完全一致）
function kbFromOf(source, fromRef) {
  const s = String(source || '').trim().toLowerCase();
  const ref = String(fromRef || '').trim();
  if (s === 'manual' || s === 'consult') return s;
  if (ref && ref !== 'manual' && ref !== 'consult') return ref.slice(0, 60);   // 工单 id → 落 from_ref、派生 auto
  if (s === 'auto') return 'auto';
  return '';   // 无来源信息 → 调用方默认 manual
}
function consultSystem(proj, ver, hits, specs, code) {   // 答疑助手系统提示（code 有值=用户点了「深入思考」，附源码片段）
  const idx = specIndex(proj, ver), subs = subsystemNames(proj);
  const kb = hits.length
    ? '下面是从经验库检索到的相关条目（历史「问题→解法」），引用时请基于它们的真实内容、别改写走样：\n' + hits.map((h, i) => `【${i + 1}】问：${h.q}\n答：${h.a}`).join('\n\n')
    : '本次未检索到相关经验库条目。请依据上面的规格摘录 / 常识作答，不要声称「根据历史经验库 / 根据经验库」（可如实说明经验库暂无相关条目）。';
  const specTxt = (specs && specs.length) ? '相关规格摘录（从系统 spec 正文按问题检索出来的真实规则 / 验收标准，回答请优先依据这里，别只凭常识猜）：\n' + specs.map(s => `《${s.subsystem ? s.subsystem + '·' : ''}${s.module || ''}｜${s.title}》\n${s.text}`).join('\n\n———\n\n') : '';
  const deep = code && code.length;
  const codeTxt = deep ? '【深入思考 · 相关源码片段】用户点了「深入思考」，下面是从系统源码里检索出的相关实现片段（每条含文件路径 + 具体代码），这是本次回答的**主要依据**，请据此说清该功能实际是怎么实现的：\n' + code.map(c => `《${c.file}》\n${c.text}`).join('\n\n———\n\n') : '';
  return `你是「${proj.name}」的答疑助手，面向产品经理/实施工程师。任务：依据系统说明书(spec)${deep ? '和源码片段' : ''}，回答 TA 关于系统使用/操作/"为什么会这样"、以及"某功能对应哪张表 / 哪些字段 / 哪个接口"的问题，并给可执行的解决思路。${subs.length ? `产品含子系统：${subs.join('、')}。` : ''}\n${idx ? `系统模块清单：\n${idx}\n` : ''}${specTxt ? '\n' + specTxt + '\n' : ''}${codeTxt ? '\n' + codeTxt + '\n' : ''}${kb ? '\n' + kb + '\n' : ''}
规则：
${deep ? `- **本次是「深入思考」，已给你上面的「相关源码片段」——请优先结合源码片段作答（规格摘录为辅），并点名源码出处**：
  · **必须把答案落在源码片段上、点名具体出处**——引用到底是哪个文件 / 哪个组件 / 哪个函数/方法（如「在 \`intervention.vue\` 的 \`onDrugPath\` 里」），说清它**实际怎么做的**（如「点按钮走 \`$openUrl(...config.value)\` 打开外部链接、由 \`config.open/config.value\` 控制」），而不是泛泛给排查话术。
  · **既然已检索到相关源码，就据源码作答，禁止开口就说「规格摘录未包含 / 未收录 / 没有相关资料」当没料**——规格摘录只是补充，别把「深入思考」答成「我没有资料」。
  · **禁止把猜测当事实**：不要写「常见如 \`xxx_table\`／大概率在 xxx」这种臆造的表名/接口/字段当答案；只讲源码片段里**实际出现**的东西。源码没显示的（如后端落库表名、前端片段里看不到的服务端逻辑），如实说「源码片段里只看到这段前端/这段逻辑，具体 XX 需看后端代码或问开发」，别编。
  · **① 翻译成大白话，绝不贴大段代码给用户；② 明确标注"这是根据代码实现推断的，最终以开发确认为准"。**
- 规格摘录作为补充：其中的规则/AC、「数据契约」(库表/字段)、「接口契约」(接口路径)若与问题相关也可点名引用（哪条 / 哪个模块）；源码与摘录都没有、你又不确定的，才说不确定 + 建议下一步，别编。` : `- **优先依据上面「相关规格摘录」里的真实内容作答**——规则/AC、以及「数据契约」(库表/字段)、「接口契约」(接口路径)都算，可点名是哪条 / 哪个模块；摘录里确实没有、你又不确定的，才说不确定 + 建议下一步，别编。
- **问到某功能"看哪张表 / 什么字段 / 哪个接口"**：只要「相关规格摘录」的数据契约 / 接口契约里写了，就照实告诉 TA（表名、字段名、接口路径）——这是说明书明文写的，不算"看代码"，别推说"技术细节我不看"。摘录里确实没有，才说这块要问开发。`}
- 能答就直接答，条理清楚，给"怎么做 / 先查什么"的思路；能引用经验库就引用。
- 若这其实是个缺陷(BUG)或新需求、需要开发介入，就明说"这个可能得转成工单让开发处理"，简述理由。
- 不臆造 spec / 源码里没有的表/字段；${deep ? '' : '不写具体代码实现；'}简短、口语、中文。`;
}

// ===== 首次运行：建数据目录 + 播示例项目/默认管理员（库空时）=====
async function bootstrap() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(INTAKE_STORE, { recursive: true });
    if (loadProjects().length === 0) await saveProjects([{ id: 'demo', name: '示例项目（demo）' }]);
    if (loadAccounts().length === 0) {   // 默认管理员：确保"必须登录"
      const h = hashPw('admin123');
      await saveAccounts([{ id: 'u' + crypto.randomBytes(5).toString('hex'), username: 'admin', role: 'admin', name: '管理员', projects: [], sites: [], salt: h.salt, hash: h.hash, mustChange: true, enabled: 1 }]);
      console.log('\n  ★ 已创建默认管理员：用户名 admin ／密码 admin123 —— 请登录后立即修改密码');
    }
  } catch (e) { console.error('[bootstrap]', (e && e.message) || e); }
}
// 首启迁移：库某实体为空且旧文件存在 → 导入（一次性）
async function migrateFromFiles() {
  try {
    if (!CACHE.projects.length) { try { const list = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8')).projects || []; if (list.length) { await saveProjects(list); console.log(`  · 迁移 ${list.length} 个项目入库`); } } catch {} }
    if (!CACHE.accounts.length) { try { const list = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'accounts.json'), 'utf8')).accounts || []; if (list.length) { await saveAccounts(list); console.log(`  · 迁移 ${list.length} 个账号入库`); } } catch {} }
    if (!Object.keys(CACHE.sessions).length) { try { const s = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sessions.json'), 'utf8')) || {}; for (const [t, v] of Object.entries(s)) { CACHE.sessions[t] = v; await db.putSession(t, v); } } catch {} }
    if (!Object.keys(CACHE.intakes).length) { let n = 0; try { for (const pid of fs.readdirSync(INTAKE_STORE)) { const dir = path.join(INTAKE_STORE, pid); if (!fs.statSync(dir).isDirectory()) continue; for (const f of fs.readdirSync(dir)) { if (!f.endsWith('.json')) continue; try { const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); ensureLifecycle(e); (CACHE.intakes[pid] || (CACHE.intakes[pid] = {}))[e.id] = e; await db.upsertIntake(pid, e); n++; } catch {} } } } catch {} if (n) console.log(`  · 迁移 ${n} 条进件工单入库`); }
    if (!Object.keys(CACHE.kb).length) { let n = 0; try { for (const f of fs.readdirSync(KB_DIR)) { if (!f.endsWith('.json')) continue; const pid = f.replace(/\.json$/, ''); try { const arr = JSON.parse(fs.readFileSync(path.join(KB_DIR, f), 'utf8')).entries || []; if (arr.length) { CACHE.kb[pid] = arr; await db.replaceKB(pid, arr); n += arr.length; } } catch {} } } catch {} if (n) console.log(`  · 迁移 ${n} 条经验库入库`); }
  } catch (e) { console.error('[migrate]', (e && e.message) || e); }
}

// ===== 账号 / 角色 / 会话（M5：开发方 dev / 现场方 field 两类角色，服务端鉴权）=====
// data/accounts.json（本机、gitignore、密码 scrypt 散列不可逆）：{ accounts:[{id,username,role,name,projects[],sites[],salt,hash}] }
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const SESSION_TTL = 7 * 24 * 3600 * 1000;   // 7 天
function loadAccounts() { return CACHE.accounts.slice(); }
async function saveAccounts(a) { CACHE.accounts = structuredClone(a); await db.replaceAccounts(a); }
function loadSessions() { return CACHE.sessions; }
function hashPw(pw, salt) { salt = salt || crypto.randomBytes(16).toString('hex'); return { salt, hash: crypto.scryptSync(String(pw), salt, 64).toString('hex') }; }
function verifyPw(pw, salt, hash) { try { const h = crypto.scryptSync(String(pw), salt, 64).toString('hex'); return h.length === (hash || '').length && crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex')); } catch { return false; } }
function parseCookies(req) { const out = {}; (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }); return out; }
function authEnabled() { return loadAccounts().length > 0; }   // 未建任何账号 = 认证未启用（全开，供首次建管理员）
function currentUser(req) { const t = parseCookies(req).intake_sess; if (!t) return null; const s = loadSessions()[t]; if (!s || (s.exp && s.exp < Date.now())) return null; return loadAccounts().find(a => a.id === s.userId) || null; }
function pubUser(u) { return u ? { id: u.id, username: u.username, role: u.role, name: u.name || u.username, phone: u.phone || '', projects: u.projects || [], sites: u.sites || [], mustChange: !!u.mustChange, enabled: (u.enabled == null ? 1 : (u.enabled ? 1 : 0)), createdAt: u.createdAt || '' } : null; }
// enabled 归一：接受布尔/0-1/中文「启用/停用」/字符串，最终落 1(启用) 或 0(停用)。默认（未提供）返回 def。
function normEnabled(v, def) { if (v == null) return def; if (v === 0 || v === false || v === '0' || v === '停用' || v === 'disabled' || v === 'off') return 0; if (v === 1 || v === true || v === '1' || v === '启用' || v === 'enabled' || v === 'on') return 1; return v ? 1 : 0; }
// 停用保护：把某启用管理员改停用（或删除）前，确保系统仍留至少一个「启用的」管理员，否则拦截。account-delete / account-save 共用，避免两套漂移逻辑。
function isLastEnabledAdmin(accs, target) { return isAdmin(target) && (target.enabled == null ? 1 : (target.enabled ? 1 : 0)) === 1 && accs.filter(a => isAdmin(a) && (a.enabled == null ? 1 : (a.enabled ? 1 : 0)) === 1).length <= 1; }
function isAdmin(u) { return !!(u && (u.role === 'admin' || u.role === 'dev')); }   // 三类角色：admin(管理员) 全权；pm(产品经理)/impl(实施工程师) 为现场侧。dev 为旧值兼容
const ACCOUNT_ROLES = ['admin', 'pm', 'impl'];
function normRole(r, first) { if (first) return 'admin'; if (ACCOUNT_ROLES.includes(r)) return r; return r === 'dev' ? 'admin' : r === 'field' ? 'impl' : 'admin'; }
// ===== 提交链接 token（现场无需账号，凭链接提交到指定项目）：HMAC 签名，无需落库 =====
const LINK_SECRET_FILE = path.join(DATA_DIR, 'link-secret');
function linkSecret() { try { return fs.readFileSync(LINK_SECRET_FILE, 'utf8').trim(); } catch { const s = crypto.randomBytes(24).toString('hex'); try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(LINK_SECRET_FILE, s); } catch {} return s; } }
function b64u(x) { return Buffer.from(x).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signToken(payload) { const p = b64u(JSON.stringify(payload)); return p + '.' + b64u(crypto.createHmac('sha256', linkSecret()).update(p).digest()); }
function verifyToken(tok) { try { const [p, sig] = String(tok || '').split('.'); if (!p || !sig) return null; if (b64u(crypto.createHmac('sha256', linkSecret()).update(p).digest()) !== sig) return null; const j = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()); return (j.exp && j.exp < Date.now()) ? null : j; } catch { return null; } }
function linkUserFrom(req, url) { const tok = url.searchParams.get('token') || parseCookies(req).intake_link; if (!tok) return null; const p = verifyToken(tok); if (!p || !p.project || !projById(p.project)) return null; return { link: true, role: 'link', project: p.project, site: p.site || '', ver: p.ver || '', ptype: p.type || '', name: p.site || '现场' }; }
function newSession(userId) { const t = crypto.randomBytes(24).toString('hex'); const s = { userId, exp: Date.now() + SESSION_TTL }; CACHE.sessions[t] = s; db.putSession(t, s).catch(() => {}); return t; }   // 会话写库 fire-and-forget，缓存即时
function dropSession(t) { if (CACHE.sessions[t]) { delete CACHE.sessions[t]; db.delSession(t).catch(() => {}); } }
function pruneSessions() { const now = Date.now(); for (const [t, s] of Object.entries(CACHE.sessions)) if (s.exp && s.exp < now) dropSession(t); }
// 请求鉴权闸：返回 'allow' | 'login'（需登录）| 'forbidden'（越权）
const LINK_OK = new Set(['/', '/submit.html', '/api/intake-submit', '/api/intake-chat', '/api/consult', '/api/projects', '/api/customers', '/api/versions', '/api/spec-modules', '/api/model-config']);
function authGate(pathname, user, link) {
  if (pathname.startsWith('/assets/') || pathname.startsWith('/vendor/')) return 'allow';
  // /field.html = 实施端外壳页（FS-01）：页面本身不含数据、自带登录门遮罩，凭 /api/me 决定进不进工作空间；数据一律走下方受 gate 的 API。故页面外壳同 /login.html 一样对未登录/现场账号放行加载。
  if (['/login.html', '/field.html', '/api/login', '/api/logout', '/api/me', '/api/health', '/api/version'].includes(pathname)) return 'allow';
  if (!authEnabled()) return 'allow';                                   // 未启用：全开（含建首个管理员）
  if (link && !user) return LINK_OK.has(pathname) ? 'allow' : (pathname.startsWith('/api/') ? 'forbidden' : 'login');   // 提交链接：只放提交面
  if (!user) return 'login';
  if (isAdmin(user)) return 'allow';                                    // 管理员：全放行
  // 现场侧（产品经理 / 实施工程师）：只允许 提交面 + 工单查看 + 验证
  const FIELD_OK = new Set(['/', '/submit.html', '/detail.html', '/api/intake-submit', '/api/intake-reply', '/api/intake-chat', '/api/consult', '/api/consult-to-intake', '/api/intake-delete', '/api/intake-analyze', '/api/kb-from-consult', '/api/kb-search', '/api/change-password', '/api/notifications', '/api/projects', '/api/customers', '/api/versions', '/api/spec-modules', '/api/intake-list', '/api/intake-detail', '/api/intake-media', '/api/intake-transition', '/api/field/submissions', '/api/field/systems', '/api/field/batches', '/api/batch-download', '/api/customer-version', '/api/customer-maintain', '/api/intake-verify', '/api/intake-set-priority', '/api/field/update-plan', '/api/field/update-toggle', '/api/field/update-sql-merged']);   // FS-05：现场端新端点（按批次视图/下载/改版本/维保回写/逐单验证）+ 累积更新计划（读代码 docs/deploy.json/累积计划/勾选/合并SQL），均端点内按 user.sites 二次收敛。2026-08-05 架构重构删 deploy-template/customer-deploy-task/batch-task/version-releases（跟随产品代码，废弃手工登记与部署模板）
  return FIELD_OK.has(pathname) ? 'allow' : 'forbidden';
}
// FS-08 §4①：field 域接口允许集 = LINK_OK ∪ FIELD_OK（供访客链接 + 现场账号），与 authGate 内 FIELD_OK 同源，避免漂移。
//   注意：这里是 authGate 里那份 FIELD_OK 的镜像常量——两者若改一处务必同步（authGate 用于登录态白名单，本集用于 field 域名层外层闸）。
const FS08_FIELD_API = new Set(['/api/intake-submit', '/api/intake-reply', '/api/intake-chat', '/api/consult', '/api/consult-to-intake', '/api/intake-delete', '/api/intake-analyze', '/api/kb-from-consult', '/api/kb-search', '/api/change-password', '/api/notifications', '/api/projects', '/api/customers', '/api/versions', '/api/spec-modules', '/api/intake-list', '/api/intake-detail', '/api/intake-media', '/api/intake-transition', '/api/field/submissions', '/api/field/systems', '/api/field/batches', '/api/batch-download', '/api/customer-version', '/api/customer-maintain', '/api/intake-verify', '/api/intake-set-priority', '/api/field/update-plan', '/api/field/update-toggle', '/api/field/update-sql-merged', '/api/model-config']);   // FS-05 端点须与 FIELD_OK 同步，否则实施域(field)整个流被 originGate deny→forbidden（实测坑，见 fs-08 防漂移断言）；update-plan/update-toggle/update-sql-merged 为累积更新计划现场端。2026-08-05 架构重构删 deploy-template/customer-deploy-task/batch-task/version-releases（跟随产品代码）
// field 域可加载的静态页（现场提交面 + 实施端外壳 + 现场可看的详情 + 登录页）。console/inbox/customers/kb/model-config/accounts/projects 等后台页不在其中 → 越域拒。
const FS08_FIELD_PAGES = new Set(['/', '/field.html', '/submit.html', '/detail.html', '/login.html']);
// 鉴权/健康端点：两域都放（field 域现场登录/查身份/登出/健康探测需要）。
const FS08_AUTH_API = new Set(['/api/login', '/api/logout', '/api/me', '/api/health', '/api/version']);
// FS-08 §4① 🆕 按 Host 的外层闸（叠加在 authGate 之外，NH-5：独立函数不改 authGate 签名/语义）。
//   返回 'allow'（本域名层放行，交给 authGate 再判登录态/白名单）| 'deny'（越域，页面 404 / 接口 403）。
//   origin==='other' → 恒 'allow'（不介入，保持现状，AC-12）。
function originGate(origin, pathname) {
  if (origin !== 'field' && origin !== 'admin') return 'allow';        // other（含未配双域名）：不介入
  const isApi = pathname.startsWith('/api/');
  const isAsset = pathname.startsWith('/assets/') || pathname.startsWith('/vendor/');
  if (origin === 'field') {
    if (isAsset) return 'allow';
    if (isApi) return (FS08_AUTH_API.has(pathname) || LINK_OK.has(pathname) || FS08_FIELD_API.has(pathname)) ? 'allow' : 'deny';
    return FS08_FIELD_PAGES.has(pathname) ? 'allow' : 'deny';          // 后台页（console/inbox/…）越域拒
  }
  // origin === 'admin'：后台域放行后台页 + admin 接口（authGate 兜权限）；唯 field.html 拒（NH-3）。
  if (!isApi && pathname === '/field.html') return 'deny';             // admin 域不暴露实施端外壳
  return 'allow';
}
// FS-01 AC-20：现场账号只看自己 project+site 的工单。角色归一后现场 = impl（+受 sites 约束的 pm）；
// 管理员（isAdmin：admin/dev）不受限、原样返回全集。之前误判 `role==='field'`（归一后永不命中）→ 隔离失效，此为必修回归。
// 服务层以 user.sites/projects 为准过滤，忽略前端越权传参（调用方绝不采信查询串里的 site/hospitalId）。
function scopedForField(user, items) {
  if (!user || isAdmin(user)) return items;
  const ps = new Set(user.projects || []), ss = new Set(user.sites || []);
  return items.filter(it => {
    // 项目约束：仅当该条目自带 project/projectId 字段时才校验（listIntake 出参不带 project、其项目边界已在端点单独前置 gate）。
    const pid = it.project || it.projectId;
    const okProj = !ps.size || pid == null || ps.has(pid);
    // 医院约束：sites 为工作空间边界；用户设了 sites 则条目 site 必须落在其中。
    const okSite = !ss.size || ss.has(it.site || '');
    return okProj && okSite;
  });
}
// FS-04 决策 B / §4.3 🔧：建单归档医院 site 服务端收敛。登录现场账号（非管理员）只能归档到自己 user.sites；
//   传越权 site → 取当前所选合法医院（回退到 sites[0]）；无 sites 则清空（不信前端任意 site）。管理员/未登录链接身份不由此约束（链接自带 site）。
function convergeSite(user, wanted) {
  const w = String(wanted || '').trim();
  if (!user || isAdmin(user)) return w;                 // 管理员/无用户上下文：原样
  const ss = Array.isArray(user.sites) ? user.sites : [];
  if (!ss.length) return '';                            // 未分配医院 → 不落任何 site（避免越权落库）
  if (w && ss.includes(w)) return w;                    // 传的是合法医院 → 采信
  return ss[0];                                         // 越权/空 → 收敛到当前账号首家合法医院
}

// 现场提交记录「软删除」守卫（FS-02 删除）：返回 {ok} 或 {ok:false,error}。纯函数（无 I/O），供 /api/intake-delete + 逻辑测试共用。
//   e   = 目标记录（已从缓存 loadIntake 出来的副本，含 convertedTo/batch/site/deleted）
//   user= 当前登录用户（isAdmin 放行；现场账号按 user.sites 收敛）
// 守卫顺序：不存在 → not_found；已删 → 幂等(gone)；已转工单/已归批 → 禁删；越权 site → 无权。
function intakeDeleteGuard(e, user) {
  if (!e) return { ok: false, code: 'not_found', error: '记录不存在' };
  if (e.deleted) return { ok: false, code: 'gone', error: '记录已删除' };                        // 幂等：已删再删，前端可当成功从清单移除
  if (String(e.convertedTo || '').trim()) return { ok: false, code: 'converted', error: '已转工单的咨询不可删除' };
  if (String(e.batch || '').trim()) return { ok: false, code: 'batched', error: '已归批的需求/BUG 不可删除' };
  if (user && !isAdmin(user)) {                                                                  // 现场账号：只能删自己 sites 内记录（管理员不限）
    const ss = Array.isArray(user.sites) ? user.sites.map(String) : [];
    if (!ss.includes(String(e.site || ''))) return { ok: false, code: 'forbidden', error: '无权删除该记录' };
  }
  return { ok: true };
}

// FS-02 §6.2：真实 lifecycle（中文）→ 现场 UI 状态标签 + theme.css tag 类。未命中键 → 灰底兜底（不静默报错）。
const FIELD_STATUS_MAP = {
  '待处理': { label: '待评审', tag: 'tag-warning' }, '已重开': { label: '待评审', tag: 'tag-warning' },
  '分析中': { label: '待评审', tag: 'tag-warning' },          // AI 刚初判、运营尚未受理 → 与运营端「待评审」对齐（不再误显「开发中」）
  '已立项': { label: '已受理·排期', tag: 'tag-primary' },     // 已受理立项、待开发 → 与运营端「已落实·排期」对齐
  '开发中': { label: '开发中', tag: 'tag-primary' },
  '已回复': { label: '已答复', tag: 'tag-success' }, '已答复': { label: '已答复', tag: 'tag-success' },
  '已交付': { label: '本包已含', tag: 'tag-success' }, '待验证': { label: '待验证', tag: 'tag-accent' },
  '已关闭': { label: '已关闭', tag: 'tag-gray' }, '暂缓': { label: '已关闭', tag: 'tag-gray' }, '已驳回': { label: '已关闭', tag: 'tag-gray' },
};
function fieldStatusLabel(lc) { return FIELD_STATUS_MAP[lc] || { label: lc || '待评审', tag: 'tag-gray' }; }

// ===== HTTP =====
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
function send(res, code, body, type = 'application/json') { res.writeHead(code, { 'Content-Type': type }); res.end(body); }
function readBody(req, cb) {   // 读 JSON 请求体（带大小上限）
  let buf = ''; let over = false;
  req.on('data', c => { if (over) return; buf += c; if (buf.length > MAX_BODY) { over = true; } });
  req.on('end', () => { if (over) return cb(null, '请求体过大'); let b = {}; try { b = JSON.parse(buf || '{}'); } catch { return cb(null, 'bad json'); } cb(b); });
}

process.on('uncaughtException', e => console.error('[uncaught]', (e && e.stack) || e));   // 单个请求异常不拖垮整个服务
process.on('unhandledRejection', e => console.error('[unhandledRejection]', (e && e.stack) || e));
const server = http.createServer((req, res) => {
  let url; try { url = new URL(req.url, 'http://127.0.0.1'); } catch { return send(res, 400, JSON.stringify({ error: 'bad url' })); }
  // 跨源/DNS-rebinding 防护（仅本机模式）：拒绝非本机 Host、以及任何跨源页面发来的请求。
  if (!PUBLIC) {
    if (!SELF_HOSTS.has(req.headers.host || '')) return send(res, 403, JSON.stringify({ error: 'forbidden host' }));
    if (req.headers.origin && !SELF_ORIGINS.has(req.headers.origin)) return send(res, 403, JSON.stringify({ error: 'cross-origin forbidden' }));
  }

  // ---------- FS-08 域名层外层闸（先按 Host 收窄允许集，再走原 authGate；未配双域名/other 域不介入，保持现状）----------
  const origin = originOf(req);
  if (originGate(origin, url.pathname) === 'deny') {
    // 越域：接口 403、页面 404（deny-by-default，不依赖前端隐藏）。
    if (url.pathname.startsWith('/api/')) return send(res, 403, JSON.stringify({ error: 'forbidden' }));
    return send(res, 404, 'Not Found', 'text/plain');
  }

  // ---------- 认证闸（渐进启用：未建账号前全开）----------
  const user = currentUser(req);
  const link = user ? null : linkUserFrom(req, url);   // 提交链接身份（现场无账号）
  // FS-08 §4②：按 Host 先把「/」解析成实际目标页，再交 authGate 判——这样 field 域 /→field.html（公开外壳、authGate 放行加载），
  //   admin 域 /→console.html（保持现状：未登录→302 login、管理员→200 工作台）。other 域（含未配双域名/本机）保持现状按 role 分发。
  let rootRel = '';
  if (url.pathname === '/') {
    if (origin === 'field') rootRel = '/field.html';
    else if (origin === 'admin') rootRel = '/console.html';
    else rootRel = ((user && !isAdmin(user)) || link) ? '/submit.html' : '/console.html';
  }
  const gatePath = rootRel || url.pathname;             // 「/」用解析后的目标页判 authGate（AC-10/11），其余路径原样
  const gate = authGate(gatePath, user, link);
  if (gate !== 'allow') {
    if (url.pathname.startsWith('/api/')) return send(res, gate === 'login' ? 401 : 403, JSON.stringify({ error: gate === 'login' ? 'need-login' : 'forbidden' }));
    res.writeHead(302, { Location: gate === 'login' ? '/login.html' : '/submit.html' }); return res.end();
  }

  // ---------- 登录 / 会话 / 账号 ----------
  if (url.pathname === '/api/login' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const u = loadAccounts().find(a => a.username === String(b.username || '').trim());
      if (!u || !verifyPw(b.password || '', u.salt, u.hash)) return send(res, 200, JSON.stringify({ ok: false, error: '用户名或密码错误' }));
      // 停用拦截：放在密码校验「通过之后」判，避免向密码错误的尝试泄露账号停用状态。旧行 enabled 为 NULL/undefined → 兜底为启用。
      if ((u.enabled == null ? 1 : (u.enabled ? 1 : 0)) === 0) return send(res, 200, JSON.stringify({ ok: false, error: '账号已停用，请联系管理员' }));
      const t = newSession(u.id);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `intake_sess=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
      return res.end(JSON.stringify({ ok: true, me: pubUser(u) }));
    });
  }
  if (url.pathname === '/api/logout') { const t = parseCookies(req).intake_sess; if (t) dropSession(t); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'intake_sess=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); return res.end(JSON.stringify({ ok: true })); }
  if (url.pathname === '/logout') { const t = parseCookies(req).intake_sess; if (t) dropSession(t); res.writeHead(302, { 'Set-Cookie': 'intake_sess=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0', Location: '/login.html' }); return res.end(); }
  if (url.pathname === '/api/me') { const me = user ? pubUser(user) : (link ? { role: 'link', name: link.name, link: true, project: link.project, site: link.site, ver: link.ver, ptype: link.ptype } : null); return send(res, 200, JSON.stringify({ authEnabled: authEnabled(), me, defaultAdmin: loadAccounts().some(a => a.username === 'admin' && a.mustChange) })); }
  if (url.pathname === '/api/submit-link' && req.method === 'POST') {   // 管理员生成现场提交链接（凭链接免登录提交）
    return readBody(req, (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const days = Math.min(3650, Math.max(1, +b.days || 365));
      const t = (b.type === 'bug' || b.type === 'requirement' || b.type === 'consult') ? b.type : '';
      const token = signToken({ project: proj.id, site: String(b.site || '').trim(), ver: String(b.ver || '').trim(), type: t, exp: Date.now() + days * 86400000 });
      // FS-08 §4③：配了 FIELD_ORIGIN → 返 field 域绝对地址（两独立域名下相对路径打不通）；未配 → 回退相对（AC-18，本机/单域名不受影响）。
      const relp = '/submit.html?token=' + token;
      const absu = FIELD_ORIGIN ? (FIELD_ORIGIN.replace(/\/+$/, '') + relp) : relp;
      send(res, 200, JSON.stringify({ ok: true, token, path: relp, url: absu, days }));
    });
  }
  if (url.pathname === '/api/health') return send(res, 200, JSON.stringify({ ok: true, projects: CACHE.projects.length, intakes: Object.values(CACHE.intakes).reduce((a, m) => a + Object.keys(m).length, 0), kb: Object.values(CACHE.kb).reduce((a, x) => a + x.length, 0) }));
  if (url.pathname === '/api/version') { let v = ''; try { const r = spawnSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: ROOT, encoding: 'utf8' }); v = (r.stdout || '').trim(); } catch {} return send(res, 200, JSON.stringify({ version: v || 'dev' })); }
  if (url.pathname === '/api/change-password' && req.method === 'POST') {   // 任意登录用户改自己的密码
    if (!user) return send(res, 401, JSON.stringify({ ok: false, error: 'need-login' }));
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      if (!verifyPw(b.old || '', user.salt, user.hash)) return send(res, 200, JSON.stringify({ ok: false, error: '原密码不正确' }));
      const np = String(b.new || '').trim(); if (np.length < 6) return send(res, 400, JSON.stringify({ ok: false, error: '新密码至少 6 位' }));
      const accs = loadAccounts(); const a = accs.find(x => x.id === user.id); if (!a) return send(res, 404, JSON.stringify({ ok: false, error: '账号不存在' }));
      const h = hashPw(np); a.salt = h.salt; a.hash = h.hash; a.mustChange = false; await saveAccounts(accs);
      send(res, 200, JSON.stringify({ ok: true }));
    });
  }
  // NH-3：管理员重置「他人」密码专用端点。仅管理员可调（authGate 未把本路径放进 FIELD_OK/LINK_OK → 非管理员被 forbidden）。
  // 以 id 定位、重设 salt/hash、置 must_change=1（强制对方下次登录改密）；不改 role/sites/projects/enabled。/api/change-password 仍只改自己。
  if (url.pathname === '/api/account-reset-password' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const pw = String(b.password || '').trim();
      if (pw.length < 6) return send(res, 400, JSON.stringify({ ok: false, error: '新密码至少 6 位' }));
      const accs = loadAccounts(); const a = accs.find(x => x.id === String(b.id || ''));
      if (!a) return send(res, 404, JSON.stringify({ ok: false, error: '账号不存在' }));
      const h = hashPw(pw); a.salt = h.salt; a.hash = h.hash; a.mustChange = true;   // 重置即强制对方下次登录改密
      await saveAccounts(accs);
      send(res, 200, JSON.stringify({ ok: true }));
    });
  }
  if (url.pathname === '/api/accounts') return send(res, 200, JSON.stringify({ accounts: loadAccounts().map(pubUser) }));
  if (url.pathname === '/api/account-save' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const username = String(b.username || '').trim();
      if (!/^[A-Za-z0-9_.-]{2,32}$/.test(username)) return send(res, 400, JSON.stringify({ ok: false, error: '用户名 2~32 位，限字母/数字/ . _ -' }));
      const accs = loadAccounts(), first = accs.length === 0;
      const role = normRole(b.role, first);   // admin/pm/impl；第一个账号强制 admin，防只建现场账号锁死
      const name = String(b.name || '').trim() || username;
      const hasPhone = b.phone != null;   // payload 未带 phone → 编辑保留原值（同 enabled 保护语义，避免停用/启用等不带 phone 的提交清空手机号）
      const phone = String(b.phone || '').trim().slice(0, 20);   // 手机号选填（可空），按列宽截断；医院管理实施人电话取自此列（单一来源），格式宽松不强校验
      const projects = Array.isArray(b.projects) ? b.projects.map(String) : [];
      const sites = Array.isArray(b.sites) ? b.sites.map(String) : [];
      const idx = accs.findIndex(a => a.username === username);
      if (idx >= 0) {
        // 编辑：payload 未带 enabled → 保留原值；带了 → 归一后用之（防被清空/误停用，同 projects 保护语义）。
        const cur = accs[idx].enabled == null ? 1 : (accs[idx].enabled ? 1 : 0);
        const enabled = normEnabled(b.enabled, cur);
        // AC-19：由启用改停用且是最后一个启用管理员 → 拒绝（与 account-delete 共用同款保护）。
        if (enabled === 0 && cur === 1 && isLastEnabledAdmin(accs, accs[idx])) return send(res, 400, JSON.stringify({ ok: false, error: '不能停用最后一个管理员' }));
        const rec = { ...accs[idx], role, name, phone: hasPhone ? phone : (accs[idx].phone || ''), projects, sites, enabled }; if ((b.password || '').trim()) { const h = hashPw(b.password.trim()); rec.salt = h.salt; rec.hash = h.hash; rec.mustChange = false; } accs[idx] = rec;
      }
      else { if (!(b.password || '').trim()) return send(res, 400, JSON.stringify({ ok: false, error: '新账号必须设密码' })); const h = hashPw(b.password.trim()); accs.push({ id: 'u' + crypto.randomBytes(5).toString('hex'), username, role, name, phone, projects, sites, salt: h.salt, hash: h.hash, mustChange: true, enabled: normEnabled(b.enabled, 1) }); }   // AC-8：新建账号 must_change=1，强制首登改密（与 bootstrap admin 一致）
      // 账号侧不做跨账号排他（2026-07-23 用户裁决「能共管」）：账号照原样存 sites，允许 pm 统筹 + impl 落地共管一院。
      //   一院一实施主路径仅由医院管理侧 customer-save 写穿保证（见 CU-01 AC-20）。
      await saveAccounts(accs);
      send(res, 200, JSON.stringify({ ok: true, accounts: accs.map(pubUser), first }));
    });
  }
  if (url.pathname === '/api/account-delete' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const accs = loadAccounts(), target = accs.find(a => a.id === String(b.id || ''));
      if (!target) return send(res, 404, JSON.stringify({ ok: false, error: '账号不存在' }));
      if (isLastEnabledAdmin(accs, target)) return send(res, 400, JSON.stringify({ ok: false, error: '不能删除最后一个管理员' }));
      await saveAccounts(accs.filter(a => a.id !== target.id));
      send(res, 200, JSON.stringify({ ok: true, accounts: loadAccounts().map(pubUser) }));
    });
  }

  // ---------- 项目登记 ----------
  if (url.pathname === '/api/projects') return send(res, 200, JSON.stringify({ projects: loadProjects().map(p => (p && p.subsystems && !p.gitUrl) ? { ...p, gitUrl: deriveGitUrl(p) } : p) }));
  if (url.pathname === '/api/customers') return send(res, 200, JSON.stringify({ customers: custWithTicketCount(loadCustomers()) }));   // 客户台账（提交页现场下拉 + 客户管理页读；ticketCount 读时按 site↔name 派生，不入文件）
  if (url.pathname === '/api/customer-save' && req.method === 'POST') {   // 新增/编辑客户（管理员；authGate 已挡非管理员）
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      if (!String(b.name || '').trim()) return send(res, 400, JSON.stringify({ ok: false, error: '请填客户名称' }));
      const list = loadCustomers(); const id = String(b.id || '').trim();
      const i = id ? list.findIndex(c => c.id === id) : -1;
      const oldName = i >= 0 ? String((list[i].name || '')).trim() : '';   // 编辑改名时用于清旧名（sites 以名为键，防孤儿）
      const rec = normCustomer(b, i >= 0 ? list[i] : null);
      if (i >= 0) list[i] = rec; else list.push(rec);
      saveCustomers(list);
      // 双向写穿 account.sites（唯一真源 · 一院一实施）：改名先清旧名，再按本次 impl.name 把新名唯一归给目标实施账号（空则解绑）。
      const accs = loadAccounts();
      let accChanged = false;
      if (oldName && oldName !== rec.name) accChanged = removeSiteFromAllAccounts(accs, oldName) || accChanged;
      accChanged = reconcileSiteToImpl(accs, rec.name, (rec.impl && rec.impl.name) || '') || accChanged;
      if (accChanged) await saveAccounts(accs);   // 落库；custWithTicketCount 随后按新 sites 派生 impl
      const withCnt = custWithTicketCount(list);
      return send(res, 200, JSON.stringify({ ok: true, customer: withCnt.find(c => c.id === rec.id) || rec, customers: withCnt }));
    });
  }
  if (url.pathname === '/api/customer-delete' && req.method === 'POST') {   // 删除单个客户（按 id 精确删，绝不批量）
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const id = String(b.id || '').trim(); if (!id) return send(res, 400, JSON.stringify({ ok: false, error: '缺少 id' }));
      const list = loadCustomers(); const i = list.findIndex(c => c.id === id);
      if (i < 0) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      list.splice(i, 1); saveCustomers(list);
      return send(res, 200, JSON.stringify({ ok: true, customers: custWithTicketCount(list) }));
    });
  }

  // ---------- 批次管理（BP-01 第 1 期 · 均 admin：未进 FIELD_OK/LINK_OK 白名单 → authGate 已对非 admin 返 403/401，无需页内再判）----------
  // 派生：给批次挂 ticketCount + 冗余 productName（读时派生，不落存），倒序按 createdAt。
  // 2026-08-05 架构重构（核心更新流）：批次不再内嵌 implTasks。清单/SQL 改为「发包时人审快照」：
  //   batch.deployPlan = { from,to,tasks[],sql[],reviewedBy,reviewedAt }。batchOut 派生 deployReviewed（是否已审核）+ 计数供列表标记。
  function batchOut(bt) {
    const dp = bt && bt.deployPlan && typeof bt.deployPlan === 'object' ? bt.deployPlan : null;
    const deployReviewed = !!(dp && dp.reviewedAt);
    const deployTaskCount = dp && Array.isArray(dp.tasks) ? dp.tasks.length : 0;
    const deploySqlCount = dp && Array.isArray(dp.sql) ? dp.sql.length : 0;
    return { ...bt, scheduleDate: String(bt.scheduleDate || ''), ticketCount: Array.isArray(bt.ticketIds) ? bt.ticketIds.length : 0, productName: (projById(bt.product) || {}).name || bt.product,
      deployReviewed, deployTaskCount, deploySqlCount };
  }
  if (url.pathname === '/api/batch-arrange' && req.method === 'POST') {   // 定档建批：归入该产品全部「已立项且未归批」工单（跨院合并），初始态「开发中」
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(String((b && b.product) || '').trim()); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '产品不存在' }));
      // 扫该产品全部工单（含 requirement/bug，consult 明确排除；跨全部医院不按 site 过滤）：
      //   收 lifecycle=已立项(已落实) 且 data.batch(=e.batch) 为空(未归批) 的工单 id。
      const store = CACHE.intakes[proj.id] || {};
      const list = loadBatches();
      const liveBatchIds = new Set(list.map(bt => String((bt && bt.id) || '')));   // 真实存在的批次 id（孤儿引用不算已归批）
      const ticketIds = [];
      for (const e of Object.values(store)) {
        if (!e || e.type === 'consult') continue;                       // consult 不进批次
        if (e.deleted) continue;                                        // 软删记录不归批（即便还挂着已立项态）
        if (deriveLifecycle(e) !== '已立项') continue;                   // 仅已落实
        // 已归批不重复归入——但必须是【真实存在】的批次；孤儿批次号（残留脏数据/批次已删）当未归批，纳入新批次自愈（归批时 e.batch 会被覆盖成新的真实 B-xx）
        if (String(e.batch || '').trim() && liveBatchIds.has(String(e.batch).trim())) continue;
        ticketIds.push(e.id);
      }
      if (!ticketIds.length) return send(res, 200, JSON.stringify({ ok: false, error: '该产品当前没有已落实待分批的工单' }));
      const by = user ? (user.name || user.username) : 'admin';
      const at = nowStamp();
      const scheduleDate = normScheduleDate(b && b.scheduleDate);   // 计划交付日期（可空，非法则空、不报错）
      const bt = { id: batchGenId(list), product: proj.id, status: '开发中', ticketIds, createdAt: at, scheduleDate,
        pkgVersion: '', releaseNote: '', releaseTime: '', artifactUrl: '', downloads: 0,
        history: [{ action: 'arrange', by, at, note: '定档建批·归入 ' + ticketIds.length + ' 单' + (scheduleDate ? '·排期 ' + scheduleDate : '') }] };
      list.push(bt); saveBatches(list);
      // 回链：给这些工单写 data.batch(=e.batch)，复用 saveIntake（穿透 MySQL data JSON、不加库列）。
      for (const id of ticketIds) { const e = loadIntake(proj, id); if (e) { e.batch = bt.id; await saveIntake(proj, e); } }
      return send(res, 200, JSON.stringify({ ok: true, item: batchOut(bt) }));
    });
  }
  if (url.pathname === '/api/batches') {   // 批次列表（?product=&status= 可选筛选；按 createdAt 倒序；挂 ticketCount/productName）
    const fp = String(url.searchParams.get('product') || '').trim();
    const fs2 = String(url.searchParams.get('status') || '').trim();
    let items = loadBatches().filter(bt => (!fp || bt.product === fp) && (!fs2 || bt.status === fs2)).map(batchOut);
    items.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return send(res, 200, JSON.stringify({ items }));
  }
  if (url.pathname === '/api/batch-detail') {   // 批次详情：覆盖工单按 subsystem 分组（中文 desc）+ 覆盖医院去重
    const id = String(url.searchParams.get('id') || '').trim();
    const bt = loadBatches().find(x => x.id === id); if (!bt) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const proj = projById(bt.product);
    const bySub = new Map();                                             // subsystem(英文 name) → tickets[]
    const hospSet = new Set();                                           // 覆盖医院去重
    for (const tid of (bt.ticketIds || [])) {
      const e = proj ? loadIntake(proj, tid) : null; if (!e) continue;
      const sub = e.subsystem || '';
      if (!bySub.has(sub)) bySub.set(sub, []);
      bySub.get(sub).push({ id: e.id, type: e.type, title: e.title || '', site: e.site || '', version: e.version || '', module: e.module || '' });
      if (e.site) hospSet.add(e.site);
    }
    const groups = [...bySub.entries()].map(([sub, tickets]) => ({ subsystem: sub, subsystemLabel: sub ? kbSubLabel(bt.product, sub) : '（未指定子系统）', tickets }));
    return send(res, 200, JSON.stringify({ item: batchOut(bt), groups, hospitals: [...hospSet] }));
  }
  // 改批次元信息（admin·未进 FIELD_OK/LINK_OK → 非 admin 自动 403）。本期只开放改 scheduleDate（排期时间），任意状态批次都可改。
  //   预留结构：入参含 scheduleDate 才改该字段（缺省不动），后续可扩别的元字段而不破坏现有调用。
  if (url.pathname === '/api/batch-update' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const id = String((b && b.id) || '').trim(); if (!id) return send(res, 400, JSON.stringify({ ok: false, error: '缺少 id' }));
      const list = loadBatches();
      const bt = list.find(x => x.id === id); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      let changed = false;
      if ('scheduleDate' in b) {                                       // 传了才改（规范化：合法 yyyy-MM-dd 或清空）
        const next = normScheduleDate(b.scheduleDate);
        if (next !== String(bt.scheduleDate || '')) {
          const from = String(bt.scheduleDate || '');
          bt.scheduleDate = next;
          const at = nowStamp(); const by = user ? (user.name || user.username) : 'admin';
          bt.history = bt.history || []; bt.history.push({ action: 'update', by, at, note: '改排期 ' + (from || '未排期') + ' → ' + (next || '未排期') });
          changed = true;
        }
      }
      // 编辑包信息（2026-07-30 用户反馈：包地址/版本填错要能改）——纯字段更新，不重新发包、不推工单状态（区别于 batch-release）。
      const pkgIn = ('pkgVersion' in b) || ('artifactUrl' in b) || ('releaseNote' in b);
      if (pkgIn) {
        const pkgVersion = 'pkgVersion' in b ? String(b.pkgVersion == null ? '' : b.pkgVersion).trim() : null;
        const artifactUrl = 'artifactUrl' in b ? String(b.artifactUrl == null ? '' : b.artifactUrl).trim() : null;
        if ((pkgVersion !== null && !pkgVersion) || (artifactUrl !== null && !artifactUrl))
          return send(res, 400, JSON.stringify({ ok: false, error: '包版本/包地址不能清空' }));
        const chg = [];
        if (pkgVersion !== null && pkgVersion.slice(0, 60) !== String(bt.pkgVersion || '')) { bt.pkgVersion = pkgVersion.slice(0, 60); chg.push('包版本'); }
        if (artifactUrl !== null && artifactUrl.slice(0, 500) !== String(bt.artifactUrl || '')) { bt.artifactUrl = artifactUrl.slice(0, 500); chg.push('包地址'); }
        if ('releaseNote' in b) { const rn = String(b.releaseNote == null ? '' : b.releaseNote).trim().slice(0, 2000); if (rn !== String(bt.releaseNote || '')) { bt.releaseNote = rn; chg.push('更新说明'); } }
        if (chg.length) {
          const at = nowStamp(); const by = user ? (user.name || user.username) : 'admin';
          bt.history = bt.history || []; bt.history.push({ action: 'update', by, at, note: '改包信息（' + chg.join('/') + '）' });
          changed = true;
        }
      }
      // 2026-08-05 架构重构：删除 FS-06 场景2「批次实施任务清单（implTasks）」定义/合并分支——
      //   实施清单改为「跟随产品代码」（各子系统仓 docs/deploy.json 按 tag 读 → 累积更新计划）。batch-update 只保留改包信息。
      if (changed) saveBatches(list);
      return send(res, 200, JSON.stringify({ ok: true, item: batchOut(bt) }));
    });
  }

  // ---------- 发包·部署清单审核（2026-08-05 核心更新流 · admin：未进 FIELD_OK/LINK_OK → 非 admin 自动 403）----------
  //   GET /api/batch-deploy-draft?batchId=&from= ：从代码 @HEAD 拉该批次 (from, pkgVersion] 累积草稿（tasks + sql 含正文），供运营审核。
  //     · from 空 = 从头（include 全部 ≤to）；to = 批次 pkgVersion（发包时的目标版本，未填则用 from 上限兜底空）。
  //     · 若批次已审核过（有 deployPlan）→ 也回已存快照 saved，前端优先回显 saved、可再「重新拉取草稿」。
  if (url.pathname === '/api/batch-deploy-draft' && req.method === 'GET') {
    const batchId = String(url.searchParams.get('batchId') || '').trim();
    const from = String(url.searchParams.get('from') || '').trim();
    const bt = loadBatches().find(x => x.id === batchId); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
    const proj = projById(bt.product); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '产品不存在' }));
    const to = String(bt.pkgVersion || '').trim();                     // 目标版本 = 批次包版本
    try { refreshRepos(proj, false); } catch {}                        // 确保仓 @HEAD 已对齐远端最新（草稿源）
    let draft; try { draft = computeDeployDraft(proj, from, to); } catch (e) { draft = { from, to, versions: [], tasks: [], sql: [] }; }
    const saved = bt.deployPlan && typeof bt.deployPlan === 'object' && bt.deployPlan.reviewedAt ? bt.deployPlan : null;
    return send(res, 200, JSON.stringify({ ok: true, batchId, product: bt.product, productName: proj.name || bt.product, pkgVersion: to, draft, saved }));
  }
  //   POST /api/batch-deploy-save ：运营审核后保存快照进批次（SQL 正文一并冻结）。body { batchId, from, tasks:[{id,title,desc}], sql:[{id,title,desc,content}] }。
  //     · 规范化 + 长度约束（normDeployPlanItems）→ 写 batch.deployPlan = { from, to:pkgVersion, tasks, sql(含content冻结), reviewedBy, reviewedAt }。
  //     · history 加一条 deploy-review 留痕。允许重复保存（再审核覆盖）。
  if (url.pathname === '/api/batch-deploy-save' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const batchId = String((b && b.batchId) || '').trim(); if (!batchId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少 batchId' }));
      const list = loadBatches();
      const bt = list.find(x => x.id === batchId); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      const from = String((b && b.from) || '').trim();
      const to = String(bt.pkgVersion || '').trim();
      const norm = normDeployPlanItems(b && b.tasks, b && b.sql);      // 规范化 + 长度约束 + title 非空丢弃
      const at = nowStamp(); const by = user ? (user.name || user.username) : 'admin';
      bt.deployPlan = { from, to, tasks: norm.tasks, sql: norm.sql, reviewedBy: by, reviewedAt: at };
      bt.history = bt.history || []; bt.history.push({ action: 'deploy-review', by, at, note: '审核部署清单（任务 ' + norm.tasks.length + ' 项·SQL ' + norm.sql.length + ' 段·区间 ' + (from || '最早') + '→' + (to || '?') + '）' });
      saveBatches(list);
      return send(res, 200, JSON.stringify({ ok: true, item: batchOut(bt), deployPlan: bt.deployPlan }));
    });
  }

  // ---------- 导出开发清单（BP-01 第 2 期 · AC-9~11 · admin）----------
  // 取批次覆盖工单 → 按子系统分组（中文 desc）→ 每条含 工单号/类型/标题/描述/验收标准/AI 初判/涉及医院/现场版本/截图链接。
  //   描述择有值：desc(bug 现象) || reqDesc(需求描述) || bg(需求背景)；验收标准=accept；AI 初判=analysis 摘要；截图=media→完整可访问 URL。
  //   ?format=json → 结构化 {batch,product,groups}；?format=md（默认）→ 可下载 Markdown（Content-Disposition attachment）。
  function checklistDesc(e) {                                          // 描述择有值：bug 用 desc、需求用 reqDesc/bg
    return String(e.desc || e.reqDesc || e.bg || '').trim();
  }
  function checklistAi(e) {                                            // AI 初判摘要（analysis 有值时）
    const a = e.analysis; if (!a || typeof a !== 'object') return '';
    const parts = [];
    if (a.category) parts.push('类别：' + a.category);
    if (a.suggestion) parts.push('建议：' + (a.suggestion === 'reply' ? '直接回复' : '立项开发'));
    if (a.verdict) parts.push('结论：' + a.verdict);
    const head = parts.join('｜');
    const detail = String(a.detail || '').trim();
    return [head, detail].filter(Boolean).join('\n');
  }
  function mediaUrls(proj, e, host) {                                  // 截图相对路径 → 完整可访问 URL（复用 /api/intake-media）
    const base = host ? ('http://' + host) : '';                       // 有 host 拼绝对 URL，无则相对（同源可访问）
    return (Array.isArray(e.media) ? e.media : []).map(m => base + '/api/intake-media?project=' + encodeURIComponent(proj.id) + '&file=' + encodeURIComponent(String(m)));
  }
  if (url.pathname === '/api/batch-checklist') {
    const id = String(url.searchParams.get('id') || '').trim();
    const fmt = (String(url.searchParams.get('format') || 'md').trim().toLowerCase() === 'json') ? 'json' : 'md';
    const bt = loadBatches().find(x => x.id === id); if (!bt) return send(res, 404, JSON.stringify({ error: 'not found' }));
    const proj = projById(bt.product);
    const host = String((req.headers && req.headers.host) || '').trim();
    const productName = (proj || {}).name || bt.product;
    const bySub = new Map();                                            // subsystem(英文 name) → items[]
    for (const tid of (bt.ticketIds || [])) {
      const e = proj ? loadIntake(proj, tid) : null; if (!e) continue;
      const sub = e.subsystem || '';
      if (!bySub.has(sub)) bySub.set(sub, []);
      bySub.get(sub).push({
        ticketId: e.id, type: e.type, title: e.title || '',
        desc: checklistDesc(e), accept: String(e.accept || '').trim(), ai: checklistAi(e),
        hospitals: e.site ? [e.site] : [],                             // 单条工单的涉及医院（跨院合并体现在同分组多条不同 site）
        siteVersion: e.version || '', media: mediaUrls(proj, e, host)
      });
    }
    const groups = [...bySub.entries()].map(([sub, items]) => ({ subsystem: sub, subsystemLabel: sub ? kbSubLabel(bt.product, sub) : '（未指定子系统）', items }));
    if (fmt === 'json') return send(res, 200, JSON.stringify({ batch: batchOut(bt), product: bt.product, productName, groups }));
    // Markdown 产物：按子系统分节，每工单一小节
    const T = { bug: 'BUG', requirement: '需求' };
    const lines = [];
    lines.push('# 开发清单 · ' + bt.id + '（' + productName + '）', '');
    lines.push('- 批次状态：' + (bt.status || '—') + '　定档时间：' + (bt.createdAt || '—') + '　工单数：' + (bt.ticketIds || []).length, '');
    if (!groups.length) lines.push('（该批次暂无覆盖工单）', '');
    for (const g of groups) {
      lines.push('## ' + (g.subsystemLabel || g.subsystem || '（未指定子系统）') + '（' + g.items.length + ' 单）', '');
      for (const it of g.items) {
        lines.push('### ' + (T[it.type] || it.type || '') + ' · ' + (it.title || '（无标题）') + '　`' + it.ticketId + '`', '');
        lines.push('- 涉及医院：' + (it.hospitals.length ? it.hospitals.join('、') : '—') + '　现场版本：' + (it.siteVersion || '—'), '');
        lines.push('**描述**', '', it.desc || '（无描述）', '');
        lines.push('**验收标准**', '', it.accept || '（无验收标准）', '');
        if (it.ai) lines.push('**AI 初判**', '', it.ai, '');
        if (it.media.length) { lines.push('**截图**', ''); for (const u of it.media) lines.push('![](' + u + ')'); lines.push(''); }
      }
    }
    const md = lines.join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + encodeURIComponent('开发清单-' + bt.id + '.md') + '"; filename*=UTF-8\'\'' + encodeURIComponent('开发清单-' + bt.id + '.md'),
      'Cache-Control': 'no-store'
    });
    return res.end(md);
  }

  // ---------- 上传包·转可下载（BP-01 第 3 期 · AC-12~15 · admin）----------
  // 入参 {id, pkgVersion, releaseNote, artifactUrl}。校验：批次存在 + 状态=开发中 + pkgVersion/artifactUrl 必填。
  //   落包信息 + status=可下载 + releaseTime；覆盖工单跳态直接置「已出包」（NH-5 选型 A：批次驱动系统动作直接置态 + 补 history 留痕，
  //   避免「已立项→开发中→已出包」两跳产生的中间态噪音）+ resolution.fixedVersion=pkgVersion。非法态工单 skip 计 warning，不阻断整批。
  if (url.pathname === '/api/batch-release' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const id = String((b && b.id) || '').trim();
      const pkgVersion = String((b && b.pkgVersion) || '').trim();
      const artifactUrl = String((b && b.artifactUrl) || '').trim();
      const releaseNote = String((b && b.releaseNote) || '').trim();
      if (!pkgVersion || !artifactUrl) return send(res, 400, JSON.stringify({ ok: false, error: '包版本/包地址必填' }));
      const list = loadBatches();
      const bt = list.find(x => x.id === id); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      if (bt.status !== '开发中') return send(res, 200, JSON.stringify({ ok: false, error: '仅开发中批次可上传包' }));
      const proj = projById(bt.product);
      const at = nowStamp();
      const by = user ? (user.name || user.username) : 'admin';
      // 覆盖工单推进到「已出包」（跳态·系统动作直接置态 + 留痕 + fixedVersion）；非法态 skip 计 warning
      let pushed = 0; const skipped = [];
      for (const tid of (bt.ticketIds || [])) {
        const e = proj ? loadIntake(proj, tid) : null; if (!e) { skipped.push(tid); continue; }
        const from = e.lifecycle || deriveLifecycle(e);
        if (from === '已出包' || from === '待验证' || from === '已关闭') { skipped.push(tid); continue; }   // 已到/越过出包态：幂等 skip
        e.history = e.history || [];
        e.history.push({ from, to: '已出包', by: '系统·发包', byRole: 'system', at, note: '批次' + bt.id + '发包（' + pkgVersion + '）' });
        e.lifecycle = '已出包'; e.status = lifecycleToStatus('已出包');
        e.resolution = { ...(e.resolution || {}), fixedVersion: pkgVersion, at };
        await saveIntake(proj, e); pushed++;
      }
      bt.pkgVersion = pkgVersion.slice(0, 60); bt.releaseNote = releaseNote.slice(0, 2000); bt.artifactUrl = artifactUrl.slice(0, 500);
      bt.releaseTime = at; bt.status = '可下载';
      bt.history = bt.history || []; bt.history.push({ action: 'release', by, at, note: '上传包 ' + pkgVersion + '·推进 ' + pushed + ' 单到已出包' + (skipped.length ? '（skip ' + skipped.length + '）' : '') });
      saveBatches(list);
      return send(res, 200, JSON.stringify({ ok: true, item: batchOut(bt), pushed, skipped }));
    });
  }

  // ---------- 批次闭环·全验证过→已交付（BP-01 第 3 期 · AC-16~18 · admin）----------
  // 入参 {id}。检查覆盖工单是否全部 lifecycle=已关闭（现场逐单验证过）；全过 → status=已交付；否则 {ok:false,pending:[未闭单id]}。
  //   批次态不因单个反馈回退（异常在工单侧 待验证→已重开 循环，见 §6/AC-18）。第 5 期实施逐单验证后会调它触发闭环；本期端点先就位 + 可手动调。
  if (url.pathname === '/api/batch-deliver-check' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const id = String((b && b.id) || '').trim();
      const list = loadBatches();
      const bt = list.find(x => x.id === id); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      const proj = projById(bt.product);
      const pending = [];
      for (const tid of (bt.ticketIds || [])) {
        const e = proj ? loadIntake(proj, tid) : null;
        if (!e || (e.lifecycle || deriveLifecycle(e)) !== '已关闭') pending.push(tid);
      }
      if (pending.length) return send(res, 200, JSON.stringify({ ok: false, error: '尚有工单未现场验证', pending, delivered: false, item: batchOut(bt) }));
      if (bt.status !== '已交付') {
        const at = nowStamp(); const by = user ? (user.name || user.username) : 'admin';
        bt.status = '已交付'; bt.deliveredAt = at;
        bt.history = bt.history || []; bt.history.push({ action: 'deliver', by, at, note: '全 ' + (bt.ticketIds || []).length + ' 单验证过·闭环已交付' });
        saveBatches(list);
      }
      return send(res, 200, JSON.stringify({ ok: true, item: batchOut(bt), delivered: true }));
    });
  }

  // ================= FS-05 · 实施端批次消费（第 4-6 期）：按批次视图 / 下载 / 一键改版本 / 逐单验证 =================
  //   均已加入 FIELD_OK（现场 impl/pm 可调）；服务层再按 user.sites 二次收敛，忽略前端越权传参（对齐 FS-01 隔离）。
  //   管理员（isAdmin）不受 sites 限制、原样放行（便于运营侧联调，与其它现场端点一致）。
  //   批次读 data/batches.json（BP-01 已上线，NH-1 命名对齐）；工单流转复用真库 TRANSITIONS/history（不重造）。

  // 当前用户的 sites 集合（管理员 null=不限）。用于逐医院/逐单收敛。
  function fieldSites(u) { return (!u || isAdmin(u)) ? null : (Array.isArray(u.sites) ? u.sites.map(String) : []); }
  // 某批次里「当前账号 sites 范围内」的覆盖工单（管理员=全部覆盖工单）。返回工单对象数组（loadIntake 副本）。
  function batchTicketsForUser(bt, proj, sitesOrNull) {
    const out = [];
    for (const tid of (bt.ticketIds || [])) {
      const e = proj ? loadIntake(proj, tid) : null; if (!e) continue;
      if (sitesOrNull && !sitesOrNull.includes(String(e.site || ''))) continue;   // 越权医院的单不返回（AC-F）
      out.push(e);
    }
    return out;
  }

  // ---------- GET /api/field/batches：按批次视图（AC-1~4/AC-20/21）----------
  //   返回当前登录现场账号相关批次 = 覆盖工单里有「该账号 sites 医院所提单」的批次（且该账号 projects 可读该产品）。
  //   每批带：批次元信息 + 该账号 sites 范围内覆盖工单（按子系统分组）+ 覆盖我负责医院列表。越权医院/别账号的单不泄露。
  if (url.pathname === '/api/field/batches') {
    if (!user) return send(res, 401, JSON.stringify({ error: '未登录' }));   // authGate 已挡，双保险
    const mySites = fieldSites(user);                                          // null=管理员不限
    const myProjects = (!isAdmin(user) && Array.isArray(user.projects)) ? user.projects : null;
    const qSite = String(url.searchParams.get('hospitalId') || '').trim();     // 可选：只看某医院；越权忽略
    const groups = [];
    for (const bt of loadBatches()) {
      const proj = projById(bt.product);
      if (myProjects && myProjects.length && !myProjects.includes(bt.product)) continue;   // 产品范围收敛（AC-4）
      // 该账号 sites 范围内覆盖工单（管理员=全部）
      let mine = batchTicketsForUser(bt, proj, mySites);
      if (qSite && (!mySites || mySites.includes(qSite))) mine = mine.filter(e => String(e.site || '') === qSite);   // 医院过滤（越权 qSite 已被 mySites 拦）
      if (!mine.length) continue;   // 与该账号无关的批次不返回（AC-4/AC-F）
      // 覆盖我负责医院去重
      const hospSet = new Set(); mine.forEach(e => { if (e.site) hospSet.add(e.site); });
      // 按子系统分组（中文 desc），组内逐单 lifecycle/statusLabel/canVerify
      const bySub = new Map();
      for (const e of mine) {
        const sub = e.subsystem || '';
        if (!bySub.has(sub)) bySub.set(sub, []);
        const lc = e.lifecycle || deriveLifecycle(e); const sl = fieldStatusLabel(lc);
        bySub.get(sub).push({ project: bt.product, id: e.id, type: e.type, title: e.title || '', site: e.site || '', version: e.version || '', subsystem: sub, lifecycle: lc, statusLabel: sl.label, statusTag: sl.tag, canVerify: lc === '待验证', verified: lc === '已关闭' });
      }
      const subGroups = [...bySub.entries()].map(([sub, tickets]) => ({ subsystem: sub, subsystemLabel: sub ? kbSubLabel(bt.product, sub) : '（未指定子系统）', tickets }));
      // 2026-08-05 架构重构：批次视图不再带 implTasks（实施清单跟随产品代码 → 见批次卡内「更新计划」块 update-plan）。
      groups.push({
        batchId: bt.id, product: bt.product, productName: (proj || {}).name || bt.product, status: bt.status || '开发中',
        pkgVersion: bt.pkgVersion || '', releaseNote: bt.releaseNote || '', releaseTime: bt.releaseTime || '', artifactUrl: bt.artifactUrl || '',
        scheduleDate: bt.scheduleDate || '',   // 计划交付日期（yyyy-MM-dd，可空）：实施端按批次视图批次头展示排期
        downloads: bt.downloads || 0, downloadedByMe: Array.isArray(bt.downloadedBy) && bt.downloadedBy.includes(user.username || ''),
        hospitals: [...hospSet], subGroups
      });
    }
    // 倒序（新批在前）
    groups.sort((a, b) => String(b.batchId || '').localeCompare(String(a.batchId || '')));
    return send(res, 200, JSON.stringify({ groups }));
  }

  // ---------- POST /api/batch-download：下载更新包（AC-5~8/AC-22）----------
  //   {batchId} → 校验批次「可下载」+ 该账号 sites 在覆盖医院内 → downloads+1（按账号幂等，落 downloadedBy[]）
  //   + 该账号 sites 范围内该批覆盖工单「已出包→待验证」（系统动作直接置态 + 留痕，同 batch-release 范式，不硬走 intake-transition）。
  if (url.pathname === '/api/batch-download' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const batchId = String((b && b.batchId) || '').trim();
      const list = loadBatches();
      const bt = list.find(x => x.id === batchId); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: '批次不存在' }));
      if (bt.status !== '可下载' && bt.status !== '已交付') return send(res, 200, JSON.stringify({ ok: false, error: '该批次尚未发布更新包' }));   // 仅可下载/已交付批次可下载
      const proj = projById(bt.product);
      const mySites = fieldSites(user);   // null=管理员不限
      // 产品范围收敛（越权产品 → 拒）
      if (mySites && Array.isArray(user.projects) && user.projects.length && !user.projects.includes(bt.product)) return send(res, 403, JSON.stringify({ ok: false, error: '无权下载该批次' }));
      // 该账号 sites 范围内覆盖工单
      const mine = batchTicketsForUser(bt, proj, mySites);
      if (mySites && !mine.length) return send(res, 403, JSON.stringify({ ok: false, error: '该批次不覆盖你负责的医院' }));   // 越权：无我负责医院的覆盖单
      const uname = user.username || '';
      const at = nowStamp();
      // 幂等计数：按账号去重（downloadedBy[] 含该账号即不重复 +1）
      bt.downloadedBy = Array.isArray(bt.downloadedBy) ? bt.downloadedBy : [];
      let counted = false;
      if (uname && !bt.downloadedBy.includes(uname)) { bt.downloadedBy.push(uname); bt.downloads = (bt.downloads || 0) + 1; counted = true; }
      // 覆盖工单「已出包→待验证」（系统动作直接置态 + 留痕；已在待验证/已关闭等则 skip 幂等）
      const bumps = []; const verifyTickets = [];
      for (const e of mine) {
        const from = e.lifecycle || deriveLifecycle(e);
        if (from === '已出包') {   // 仅从已出包推进（避免把开发中/已立项拉过头；已待验证/已关闭 skip）
          e.history = e.history || [];
          e.history.push({ from, to: '待验证', by: '系统·下载', byRole: 'system', at, note: '批次' + bt.id + '现场下载更新包（' + (bt.pkgVersion || '') + '）' });
          e.lifecycle = '待验证'; e.status = lifecycleToStatus('待验证');
          await saveIntake(proj, e);
        }
        if (['已出包', '待验证'].includes(from) || (e.lifecycle === '待验证')) verifyTickets.push({ project: bt.product, id: e.id, title: e.title || '' });
      }
      // bumps：我负责医院 × 产品/子系统的版本提示（驱动改版本条）——按 (医院,子系统) 去重
      const seenBump = new Set();
      for (const e of mine) {
        const site = e.site || ''; const sub = e.subsystem || '';
        const key = site + '||' + sub; if (seenBump.has(key)) continue; seenBump.add(key);
        const cust = loadCustomers().find(c => (c.name || '').trim() === site.trim());
        const fromVer = custSubVersion(cust, bt.product, sub);   // 该医院该产品/子系统现场当前版本
        bumps.push({ site, hospital: site, product: bt.product, productName: (proj || {}).name || bt.product, subsystem: sub, subsystemLabel: sub ? kbSubLabel(bt.product, sub) : '', fromVer, toVer: bt.pkgVersion || '' });
      }
      if (counted) { bt.history = bt.history || []; bt.history.push({ action: 'download', by: uname || 'admin', at, note: '现场下载更新包（' + (bt.pkgVersion || '') + '）' }); }
      saveBatches(list);
      return send(res, 200, JSON.stringify({ ok: true, batchId: bt.id, pkgVersion: bt.pkgVersion || '', artifactUrl: bt.artifactUrl || '', downloads: bt.downloads || 0, counted, bumps, verifyTickets }));
    });
  }

  // ---------- POST /api/customer-version：一键改版本回写（AC-9~13）----------
  //   {site, project, version, subsystem?} → 校验 site ∈ user.sites（越权拒）→ 回写 data/customers.json：
  //     新形状 products[].subsystems[name==subsystem].version（有 subsystem 时）/ 旧形状 products[].version。
  //   幂等（version==现值 不重复写不重复留痕）；留痕 versionLog[]（谁/何时/哪院/哪产品·子系统/v_old→v_new）。
  if (url.pathname === '/api/customer-version' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const site = String((b && (b.site || b.customerName)) || '').trim();
      const productId = String((b && (b.project || b.productId)) || '').trim();
      const subsystem = String((b && b.subsystem) || '').trim();
      const version = String((b && b.version) || '').trim();
      if (!site) return send(res, 400, JSON.stringify({ ok: false, error: '缺少医院' }));
      if (!version) return send(res, 400, JSON.stringify({ ok: false, error: '版本号为空' }));
      // 越权：site 不在当前账号 sites（管理员不限）
      if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(site))) return send(res, 403, JSON.stringify({ ok: false, error: '无权改该医院版本' }));
      const list = loadCustomers();
      const c = list.find(x => (x.name || '').trim() === site.trim());
      if (!c) return send(res, 400, JSON.stringify({ ok: false, error: '客户不存在' }));
      if (!Array.isArray(c.products)) c.products = [];
      const pr = c.products.find(p => p && p.project === productId);
      if (!pr) return send(res, 400, JSON.stringify({ ok: false, error: '产品不属该客户' }));
      const proj = projById(productId);
      const vNew = version.slice(0, 30);
      let fromVer = '', changed = false;
      if (subsystem) {
        // 新形状：写对应子系统 version（不存在则若合法子系统则新增一条）
        if (proj && !subsystemNames(proj).includes(subsystem)) return send(res, 400, JSON.stringify({ ok: false, error: '子系统不属该产品' }));
        if (!Array.isArray(pr.subsystems)) {
          // 旧形状升级为新形状：以原产品级 version 兜底其它子系统？此处只落被改子系统，避免臆造其它——原产品级 version 保留在旧字段兼容读取。
          fromVer = pr.version || '';
          pr.subsystems = [{ name: subsystem, version: vNew }];
          delete pr.version;
          changed = fromVer !== vNew || true;   // 形状变更即视为改动（留痕）
        } else {
          const ms = pr.subsystems.find(s => s && s.name === subsystem);
          if (ms) { fromVer = ms.version || ''; if (fromVer !== vNew) { ms.version = vNew; changed = true; } }
          else { pr.subsystems.push({ name: subsystem, version: vNew }); changed = true; }
        }
      } else {
        // 旧形状（产品级 version）
        fromVer = pr.version || '';
        if (Array.isArray(pr.subsystems)) return send(res, 400, JSON.stringify({ ok: false, error: '该产品按子系统维护版本，请指定 subsystem' }));
        if (fromVer !== vNew) { pr.version = vNew; changed = true; }
      }
      const at = nowStamp();
      if (changed) {
        c.versionLog = Array.isArray(c.versionLog) ? c.versionLog : [];
        c.versionLog.push({ productId, subsystem: subsystem || '', fromVer, toVer: vNew, by: (user ? (user.name || user.username) : 'admin'), at });
        if (c.versionLog.length > 200) c.versionLog = c.versionLog.slice(-200);
        c.updatedAt = at;
        saveCustomers(list);
      }
      const withCnt = custWithTicketCount(list);
      return send(res, 200, JSON.stringify({ ok: true, changed, fromVer, toVer: vNew, item: withCnt.find(x => x.id === c.id) || c }));
    });
  }

  // ---------- POST /api/customer-maintain：实施端回写维保到期（镜像 customer-version）----------
  //   {site, maintainEnd} → maintainEnd 须 yyyy-MM-dd（本期不支持清空）；校验 site ∈ user.sites（管理员不限，越权 403）
  //     → 回写 data/customers.json c.maintainEnd（≤20）；幂等（新值===旧值 不写不留痕）；留痕 c.maintainLog[]（谁/何时/哪院/from→to）。
  if (url.pathname === '/api/customer-maintain' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const site = String((b && (b.site || b.customerName)) || '').trim();
      const maintainEnd = String((b && b.maintainEnd) || '').trim();
      if (!site) return send(res, 400, JSON.stringify({ ok: false, error: '缺少医院' }));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(maintainEnd)) return send(res, 400, JSON.stringify({ ok: false, error: '维保到期日期格式须为 yyyy-MM-dd' }));
      // 越权：site 不在当前账号 sites（管理员不限）——与 customer-version 完全一致
      if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(site))) return send(res, 403, JSON.stringify({ ok: false, error: '无权改该医院维保到期' }));
      const list = loadCustomers();
      const c = list.find(x => (x.name || '').trim() === site.trim());
      if (!c) return send(res, 400, JSON.stringify({ ok: false, error: '客户不存在' }));
      const from = String(c.maintainEnd || '').trim();
      if (from === maintainEnd) return send(res, 200, JSON.stringify({ ok: true }));   // 幂等：值没变不写不留痕
      c.maintainEnd = maintainEnd.slice(0, 20);
      c.maintainLog = Array.isArray(c.maintainLog) ? c.maintainLog : [];
      c.maintainLog.push({ by: (user && user.username) || '', at: nowStamp(), site, from, to: maintainEnd });
      if (c.maintainLog.length > 200) c.maintainLog = c.maintainLog.slice(-200);
      c.updatedAt = nowStamp();
      saveCustomers(list);
      const withCnt = custWithTicketCount(list);
      return send(res, 200, JSON.stringify({ ok: true, customer: withCnt.find(x => x.id === c.id) || c, customers: withCnt }));
    });
  }

  // ========== 2026-08-05 架构重构：废弃 FS-06 现场代办清单两场景端点 ==========
  //   删：GET/POST /api/deploy-template(-save)（标准部署清单模板）、POST /api/customer-deploy-task（每院勾选）、POST /api/batch-task（批次实施清单勾选）。
  //   部署/更新清单改为「跟随产品代码」——各子系统仓 docs/deploy.json 按 tag 读 → 累积更新计划（见下方 update-plan/update-toggle/update-sql-merged）。

  // ========== 更新计划「实施侧读批次快照」（2026-08-05 核心更新流重构）==========
  //   模型变更：不再实时读代码/跨版累积。发包时运营审核冻结 batch.deployPlan 快照（tasks + sql 含正文）——
  //     实施侧只**读并执行该批次那份审核过的快照**。完成度 per(批次, 医院)：updateProgress[batchId]={tasks:{},sqlBundle:{}}。
  //   公共算子：给定 (医院, 批次) → 取 batch.deployPlan 快照 + 左连该院该批完成度。返回 null=批次不存在。
  function computeBatchPlan(site, batchId) {
    const bt = loadBatches().find(x => x.id === String(batchId || '').trim());
    if (!bt) return null;
    const proj = projById(bt.product);
    const cust = loadCustomers().find(c => (c.name || '').trim() === String(site || '').trim()) || null;
    const dp = bt.deployPlan && typeof bt.deployPlan === 'object' && bt.deployPlan.reviewedAt ? bt.deployPlan : null;
    // 完成度按 (批次, 医院)：updateProgress[batchId]={tasks:{},sqlBundle:{}}（键空间与旧 [productId][version] 不撞）。
    const progForBatch = (cust && cust.updateProgress && typeof cust.updateProgress === 'object' && cust.updateProgress[bt.id]) || {};
    const jt = vpJoinBatchProgress(dp ? dp.tasks : [], progForBatch);
    const sql = vpBatchSqlSummary(dp ? dp.sql : [], progForBatch);
    return {
      bt, proj, cust, deployPlan: dp,
      fromVersion: dp ? String(dp.from || '') : '', toVersion: dp ? String(dp.to || bt.pkgVersion || '') : String(bt.pkgVersion || ''),
      tasks: jt.rows, sql, taskDone: jt.done, taskTotal: jt.total
    };
  }

  // ---------- GET /api/field/update-plan?site=&batchId=：该批次快照更新计划（管理员 + field·按 sites 越权收敛）----------
  //   数据源 = batch.deployPlan（发包时审核冻结的快照，2026-08-05 核心更新流重构，不再实时读代码）。
  //   兼容旧参数 product+target（前端仍带）：忽略，一律按 batchId 找快照；缺 batchId 则报错。
  if (url.pathname === '/api/field/update-plan' && req.method === 'GET') {
    if (!user) return send(res, 401, JSON.stringify({ ok: false, error: '未登录' }));
    const site = String(url.searchParams.get('site') || '').trim();
    const batchId = String(url.searchParams.get('batchId') || '').trim();
    if (!site) return send(res, 400, JSON.stringify({ ok: false, error: '缺少医院' }));
    if (!batchId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少批次' }));
    // 越权：site 不在当前账号 sites（管理员不限）——与 customer-version/customer-maintain 一致
    if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(site))) return send(res, 403, JSON.stringify({ ok: false, error: '无权查看该医院更新计划' }));
    const plan = computeBatchPlan(site, batchId);
    if (!plan) return send(res, 404, JSON.stringify({ ok: false, error: '批次不存在' }));
    // 批次未审核部署清单（无 deployPlan）→ noManifest：提示运营先审核。
    const noManifest = !plan.deployPlan;
    return send(res, 200, JSON.stringify({
      ok: true, site, batchId, product: plan.bt.product, productName: (plan.proj && plan.proj.name) || plan.bt.product,
      fromVersion: plan.fromVersion, toVersion: plan.toVersion,
      tasks: plan.tasks,          // 快照实施任务（逐条完成态·per 批次×医院）
      sql: plan.sql,              // SQL 汇总为「一个点」{hasSql,scriptCount,done,by,at}（正文在合并下载）
      taskDone: plan.taskDone, taskTotal: plan.taskTotal,
      noManifest,                 // 批次尚未审核部署清单 → true
      noManifestHint: noManifest ? '该批次尚未审核部署清单（运营在「上传包」时审核确认后，实施才可见此更新计划）。' : ''
    }));
  }

  // ---------- POST /api/field/update-toggle：勾选/取消一条快照「任务」或「合并 SQL 单点」（管理员 + field·按 sites 收敛）----------
  //   两种 kind：kind:'task' {site,batchId,itemId,done} → 写 updateProgress[batchId].tasks[itemId]；
  //             kind:'sql'  {site,batchId,done} → 写 updateProgress[batchId].sqlBundle（一个点，itemId 忽略）。
  //   完成度 per(批次, 医院)。幂等；返回 changed。前端刷 update-plan 拿全量进度。
  if (url.pathname === '/api/field/update-toggle' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const site = String((b && (b.site || b.customerName)) || '').trim();
      const batchId = String((b && b.batchId) || '').trim();
      const isSql = (b && b.kind === 'sql');
      const itemId = String((b && b.itemId) || '').trim();
      const done = !!(b && b.done);
      if (!site) return send(res, 400, JSON.stringify({ ok: false, error: '缺少医院' }));
      if (!batchId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少批次' }));
      if (!isSql && !itemId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少条目' }));   // task 必须带 itemId；sql 单点不需要
      const bt = loadBatches().find(x => x.id === batchId); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: '批次不存在' }));
      // 越权：site 不在当前账号 sites（管理员不限）
      if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(site))) return send(res, 403, JSON.stringify({ ok: false, error: '无权操作该医院更新计划' }));
      const list = loadCustomers();
      const c = list.find(x => (x.name || '').trim() === site.trim());
      if (!c) return send(res, 400, JSON.stringify({ ok: false, error: '客户不存在' }));
      const at = nowStamp(); const by = (user && user.username) || '';
      // updateProgress 顶层 {[batchId]:{tasks:{},sqlBundle:{}}}——只改该批次分支，其余不动。
      const up = (c.updateProgress && typeof c.updateProgress === 'object') ? c.updateProgress : {};
      const prevBatch = (up[batchId] && typeof up[batchId] === 'object') ? up[batchId] : {};
      const r = isSql
        ? vpApplyBatchSqlToggle(prevBatch, done, by, at)              // 合并 SQL 单点（挂 batchId.sqlBundle）
        : vpApplyBatchTaskToggle(prevBatch, itemId, done, by, at);    // 逐条任务
      if (r.changed) {
        const nextUp = Object.assign({}, up); nextUp[batchId] = r.progress;
        c.updateProgress = nextUp; c.updatedAt = at; saveCustomers(list);
      }
      return send(res, 200, JSON.stringify({ ok: true, changed: r.changed, site, batchId, kind: isSql ? 'sql' : 'task', itemId: isSql ? '' : itemId, done }));
    });
  }

  // ---------- GET /api/field/update-sql-merged?site=&batchId=：合并批次快照 SQL 为单文件下载（管理员 + field·按 sites 收敛）----------
  //   正文已冻结在 batch.deployPlan.sql[].content（发包时读出固化），无需再读 git。
  if (url.pathname === '/api/field/update-sql-merged' && req.method === 'GET') {
    if (!user) return send(res, 401, JSON.stringify({ ok: false, error: '未登录' }));
    const site = String(url.searchParams.get('site') || '').trim();
    const batchId = String(url.searchParams.get('batchId') || '').trim();
    if (!site) return send(res, 400, JSON.stringify({ ok: false, error: '缺少医院' }));
    if (!batchId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少批次' }));
    if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(site))) return send(res, 403, JSON.stringify({ ok: false, error: '无权下载该医院更新 SQL' }));
    const plan = computeBatchPlan(site, batchId);
    if (!plan) return send(res, 404, JSON.stringify({ ok: false, error: '批次不存在' }));
    const sqlItems = plan.deployPlan ? plan.deployPlan.sql : [];        // 快照冻结正文，直接拼
    const productName = (plan.proj && plan.proj.name) || plan.bt.product;
    const text = vpMergeBatchSql(sqlItems, { productName, from: plan.fromVersion, to: plan.toVersion, site });
    // 文件名：<product>_<from>_to_<to>.sql（无版本兜底，避免非法文件名）
    const safe = s => String(s || '').replace(/[^A-Za-z0-9._\-]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
    const fname = safe(plan.bt.product) + '_' + safe(plan.fromVersion || 'from') + '_to_' + safe(plan.toVersion || 'to') + '.sql';
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + fname + '"' });
    return res.end(text);
  }

  // ---------- POST /api/intake-verify：逐单现场验证（AC-15~20/AC-22/23）----------
  //   {project, id, result:'pass'|'fail', note?} → 校验 site ∈ user.sites + lifecycle=待验证（非待验证态拒）
  //     pass：待验证→已关闭 + 现场验证留痕；fail：待验证→已重开 + note 反馈进 history。
  //   pass 后若该单所属批次覆盖工单全部已关闭 → 联动 batch-deliver-check 触发批次「已交付」（闭环 AC-17/23）。
  if (url.pathname === '/api/intake-verify' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(String((b && b.project) || '').trim()); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const e = loadIntake(proj, String((b && b.id) || '').trim()); if (!e) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      const result = (b && b.result === 'fail') ? 'fail' : 'pass';
      const note = String((b && b.note) || '').trim();
      // 越权：该单 site 不在当前账号 sites（管理员不限）
      if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(String(e.site || '')))) return send(res, 403, JSON.stringify({ ok: false, error: '无权验证该工单' }));
      const from = e.lifecycle || deriveLifecycle(e);
      if (from !== '待验证') return send(res, 400, JSON.stringify({ ok: false, error: '该工单当前不可验证（需处于待验证态）' }));   // AC-16/D2
      const to = result === 'pass' ? '已关闭' : '已重开';
      const at = nowStamp();
      const by = user ? (user.name || user.username) : '现场';
      e.history = e.history || [];
      e.history.push({ from, to, by, byRole: user ? user.role : 'field', at, note: result === 'pass' ? ('现场验证通过' + (note ? '：' + note : '')) : ('现场验证不通过·反馈：' + (note || '（无说明）')) });
      e.lifecycle = to; e.status = lifecycleToStatus(to);
      await saveIntake(proj, e);
      if (to === '已关闭') { try { await kbAddFromIntake(proj, e); } catch {} }   // 关闭即自动沉淀经验库（与 intake-transition 一致）
      // 闭环联动：pass 后若该单所属批次全部覆盖工单已关闭 → 触发批次「已交付」
      let batchDelivered = false;
      if (result === 'pass' && e.batch) {
        const list = loadBatches();
        const bt = list.find(x => x.id === e.batch);
        if (bt) {
          let allClosed = true;
          for (const tid of (bt.ticketIds || [])) { const t = loadIntake(proj, tid); if (!t || (t.lifecycle || deriveLifecycle(t)) !== '已关闭') { allClosed = false; break; } }
          if (allClosed && bt.status !== '已交付') {
            bt.status = '已交付'; bt.deliveredAt = at;
            bt.history = bt.history || []; bt.history.push({ action: 'deliver', by: '系统·现场验证闭环', at, note: '全 ' + (bt.ticketIds || []).length + ' 单现场验证过·闭环已交付' });
            saveBatches(list);
          }
          batchDelivered = (bt.status === '已交付');
        }
      }
      return send(res, 200, JSON.stringify({ ok: true, lifecycle: e.lifecycle, batchDelivered }));
    });
  }

  // ---------- POST /api/intake-set-priority：现场逐条改工单紧急程度（AC-32 · per-ticket）----------
  //   {project, id, priority} → 校验 site ∈ user.sites（管理员不限）；仅 requirement/bug 可设（consult 恒空、拒）；
  //     normPriority 显式选择合法即用、非法回落原值；history 留痕「调整紧急程度→X」；saveIntake。
  //   白名单已进 FIELD_OK + FS08_FIELD_API（现场域可调，否则被 originGate deny，见 fs-08 教训）。
  if (url.pathname === '/api/intake-set-priority' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(String((b && b.project) || '').trim()); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const e = loadIntake(proj, String((b && b.id) || '').trim());
      if (!e || e.deleted) return send(res, 404, JSON.stringify({ ok: false, error: '工单不存在' }));
      if (e.type !== 'requirement' && e.type !== 'bug') return send(res, 400, JSON.stringify({ ok: false, error: '仅需求/BUG 可设紧急程度' }));   // consult priority 恒空
      // 越权：该单 site 不在当前账号 sites（管理员不限）——对齐 intake-verify 收敛
      if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(String(e.site || '')))) return send(res, 403, JSON.stringify({ ok: false, error: '无权设置该工单紧急程度' }));
      const from = e.priority || '中';
      const to = normPriority(b.priority, from || '中');   // 显式选择：合法四档→采用；非法/空→回落原值
      if (to !== from) {   // 有变更才写留痕（同值幂等，不刷 history）
        e.priority = to;
        e.history = e.history || [];
        e.history.push({ from, to, by: (user ? (user.name || user.username) : '现场'), byRole: user ? user.role : 'field', at: nowStamp(), note: '调整紧急程度→' + to });
        await saveIntake(proj, e);
      }
      return send(res, 200, JSON.stringify({ ok: true, priority: e.priority }));
    });
  }

  if (url.pathname === '/api/overview') {   // 工作台聚合：项目/进件统计 + 最近进件 + 模型状态（单一入口用）
    const projs = loadProjects(), perProj = [], recent = [];
    const totals = { total: 0, requirement: 0, bug: 0, '待处理': 0, '沟通中': 0, '已归档': 0, '已处理': 0 };
    for (const p of projs) {
      const items = listIntake(p); perProj.push({ id: p.id, name: p.name, count: items.length, hasRepo: !!(p.repoPath || p.specsPath || p.gitUrl || (p.subsystems || []).some(s => s && (s.repoPath || s.repoUrl))) });   // 仓可能挂在子系统上，别只看顶层 repoPath
      for (const it of items) { totals.total++; if (it.type === 'bug') totals.bug++; else totals.requirement++; if (totals[it.status] != null) totals[it.status]++; recent.push({ id: it.id, project: p.id, projectName: p.name, type: it.type, title: it.title, site: it.site, version: it.version, status: it.status, submittedAt: it.submittedAt }); }
    }
    recent.sort((a, b) => (b.submittedAt || '').localeCompare(a.submittedAt || ''));
    const cfg = readModelCfg();
    return send(res, 200, JSON.stringify({ projects: perProj, totals, recent: recent.slice(0, 12), model: { configured: !!cfg.apiKey, model: cfg.model || '', provider: cfg.provider || 'anthropic' } }));
  }
  if (url.pathname === '/api/project-save' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const id = String(b.id || '').trim().toLowerCase();
      if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) return send(res, 400, JSON.stringify({ ok: false, error: '项目 id 只能小写字母/数字/连字符，1~40 位' }));
      const name = String(b.name || '').trim(); if (!name) return send(res, 400, JSON.stringify({ ok: false, error: '项目名必填' })); if (name.length > 40) return send(res, 400, JSON.stringify({ ok: false, error: '项目名不超过 40 字' }));
      const repoPath = String(b.repoPath || '').trim(), specsPath = String(b.specsPath || '').trim();
      const gitUrl = String(b.gitUrl || '').trim();
      const subsIn = (Array.isArray(b.subsystems) ? b.subsystems : []).map(s => (typeof s === 'string' ? { name: s.trim() } : { key: String(s.key || '').trim(), name: String(s.name || '').trim(), desc: String(s.desc || '').trim(), repoPath: String(s.repoPath || '').trim(), repoUrl: String(s.repoUrl || '').trim() })).filter(s => s.name).slice(0, 60);
      const subsystems = subsIn.map(s => { const o = { name: s.name }; if (s.key) o.key = s.key; if (s.desc) o.desc = s.desc; if (s.repoUrl) { o.repoUrl = s.repoUrl; const dir = cloneRepo(id, s.key || s.name, s.repoUrl); if (dir) o.repoPath = dir; } else if (s.repoPath) o.repoPath = s.repoPath; return o; });   // git 子系统仓 → clone 到缓存
      const ps = loadProjects(); const i = ps.findIndex(p => p.id === id); const existing = i >= 0 ? ps[i] : null;
      // 编辑时本次未带子系统/Git 则保留已有——避免改名等操作把子系统与克隆路径误清（曾踩坑，见 lessons）
      const finalSubs = subsystems.length ? subsystems : ((existing && existing.subsystems) || []);
      const finalGitUrl = gitUrl || deriveGitUrl({ subsystems: finalSubs }) || (existing && existing.gitUrl) || '';
      const rec = { id, name };
      if (finalGitUrl) rec.gitUrl = finalGitUrl;
      if (repoPath) rec.repoPath = repoPath; else if (existing && existing.repoPath) rec.repoPath = existing.repoPath;
      if (specsPath) rec.specsPath = specsPath; else if (existing && existing.specsPath) rec.specsPath = existing.specsPath;
      if (finalSubs.length) rec.subsystems = finalSubs;
      if (i >= 0) ps[i] = rec; else ps.push(rec);
      try { await saveProjects(ps); } catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      // 路径存在性提示（不阻断保存，只回警告，便于管理员发现填错）
      const warn = []; if (repoPath && !fs.existsSync(repoPath)) warn.push('repoPath 当前不存在'); if (specsPath && !fs.existsSync(specsPath)) warn.push('specsPath 当前不存在');
      send(res, 200, JSON.stringify({ ok: true, projects: ps, warn: warn.join('；') }));
    });
  }
  if (url.pathname === '/api/project-delete' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const id = String(b.id || '').trim(); const ps = loadProjects().filter(p => p.id !== id);
      try { await saveProjects(ps); } catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      // 只解除登记；已归档进件仍在 data/intake-store/<id>/，需要时手动清理
      let kept = 0; try { kept = fs.readdirSync(path.join(INTAKE_STORE, id)).filter(f => f.endsWith('.json')).length; } catch {}
      send(res, 200, JSON.stringify({ ok: true, projects: ps, keptData: kept }));
    });
  }
  if (url.pathname === '/api/versions') { const proj = projById(url.searchParams.get('project')); if (proj) try { refreshRepos(proj, false); } catch {} return send(res, 200, JSON.stringify({ versions: proj ? listVersions(proj) : [], bySub: proj ? versionsBySubsystem(proj) : {}, syncedAt: proj ? fmtSyncAt(REPO_SYNC_AT.get(proj.id)) : '' })); }
  if (url.pathname === '/api/project-git') {   // 本地读取：各子系统仓 HEAD 提交 + 最后同步时间（不走网络，秒回，供项目卡常驻展示）
    const proj = projById(url.searchParams.get('project'));
    if (!proj) return send(res, 200, JSON.stringify({ subs: [] }));
    let syncTs = REPO_SYNC_AT.get(proj.id) || 0;
    const subs = repoDirsOf(proj).map(({ dir, name }) => {
      if (!fs.existsSync(path.join(dir, '.git'))) return { name, ok: false };
      let head = '', ts = 0;
      try { head = gitOut(dir, ['log', '-1', '--format=%h｜%ci｜%s']).trim().slice(0, 160); } catch {}
      for (const f of ['FETCH_HEAD', 'HEAD']) { try { ts = fs.statSync(path.join(dir, '.git', f)).mtimeMs; break; } catch {} }   // FETCH_HEAD=上次 fetch 时间（重启后仍在）
      if (ts > syncTs) syncTs = ts;
      return { name, ok: !!head, head, fetchedAt: fmtSyncAt(ts) };
    });
    return send(res, 200, JSON.stringify({ syncedAt: fmtSyncAt(syncTs), subs }));
  }
  if (url.pathname === '/api/spec-modules') { const proj = projById(url.searchParams.get('project')); if (proj) try { refreshRepos(proj, false); } catch {} return send(res, 200, JSON.stringify({ modules: proj ? specModules(proj, url.searchParams.get('ver')) : [] })); }
  if (url.pathname === '/api/spec-search') {   // 检索透明化：看某问题命中哪些 spec 片段（答疑就用这套）
    const proj = projById(url.searchParams.get('project')); const q = url.searchParams.get('q') || '';
    if (!proj) return send(res, 200, JSON.stringify({ hits: [] }));
    try { refreshRepos(proj, false); } catch {}
    const hits = specSearch(proj, String(url.searchParams.get('ver') || '').trim(), q, 5);
    return send(res, 200, JSON.stringify({ hits: hits.map(h => ({ module: h.module, title: h.title, text: h.text })) }));
  }
  if (url.pathname === '/api/git-refresh' && req.method === 'POST') {   // 手动「同步代码」：立即拉最新 tag + 工作树，返回各仓 HEAD/标签数
    return readBody(req, async (b, err) => {
      const proj = projById(b && b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      let r; try { r = refreshRepos(proj, true); } catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      send(res, 200, JSON.stringify({ ok: true, syncedAt: fmtSyncAt(r.at), repos: r.repos || [], versions: listVersions(proj) }));
    });
  }
  if (url.pathname === '/api/git-config') { const c = readGitCfg(); return send(res, 200, JSON.stringify({ baseUrl: c.baseUrl || '', tokenMask: maskTok(c.token), configured: !!(c.baseUrl && c.token) })); }
  if (url.pathname === '/api/git-config-save' && req.method === 'POST') {
    return readBody(req, (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const cur = readGitCfg();
      const c = { baseUrl: String(b.baseUrl || cur.baseUrl || '').trim().replace(/\/$/, ''), token: (b.token && String(b.token).trim()) ? String(b.token).trim() : cur.token };
      writeGitCfg(c);
      send(res, 200, JSON.stringify({ ok: true, tokenMask: maskTok(c.token), configured: !!(c.baseUrl && c.token) }));
    });
  }
  if (url.pathname === '/api/git-inspect' && req.method === 'POST') {   // 解析 git 地址 → 自动 id/名称/子系统
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      try { const r = await gitInspect(b.url || ''); send(res, 200, JSON.stringify({ ok: true, ...r })); }
      catch (e) { send(res, 200, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
    });
  }

  // ---------- 模型 API 配置 ----------
  // 统一模型列表：第一个(primary=true)是主，其余按序备用。maskKey 掩码用于"留空保留旧 key"（跨全部旧模型匹配，主/备互换也不丢 key）
  const toModelView = (x, primary) => ({ provider: x.provider || 'anthropic', model: x.model || '', baseUrl: x.baseUrl || '', keyMask: maskKey(x.apiKey), configured: !!x.apiKey, primary });
  const modelsOf = c => (c.apiKey || (Array.isArray(c.backups) && c.backups.length)) ? [toModelView(c, true), ...((Array.isArray(c.backups) ? c.backups : []).map(b => toModelView(b, false)))] : [];
  // embedding 配置视图（掩码，不回明文）：存 model-api.json 的 embed 字段 {provider,model,baseUrl,apiKey}
  const embedView = c => { const e = (c && c.embed) || {}; return { provider: e.provider || 'openai', model: e.model || '', baseUrl: e.baseUrl || '', keyMask: maskKey(e.apiKey), configured: !!(e.apiKey && e.baseUrl && e.model) }; };
  if (url.pathname === '/api/model-config') {
    const c = readModelCfg();
    return send(res, 200, JSON.stringify({ models: modelsOf(c), provider: c.provider || 'anthropic', model: c.model || '', baseUrl: c.baseUrl || '', keyMask: maskKey(c.apiKey), configured: !!c.apiKey, embed: embedView(c) }));
  }
  if (url.pathname === '/api/model-config-save' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const cur = readModelCfg();
      const oldModels = [{ provider: cur.provider, model: cur.model, baseUrl: cur.baseUrl, apiKey: cur.apiKey }, ...((Array.isArray(cur.backups) ? cur.backups : []))];
      const resolveKey = m => { let k = (m.apiKey && String(m.apiKey).trim()) ? String(m.apiKey).trim() : ''; if (!k && m.mask) { const o = oldModels.find(x => maskKey(x.apiKey) === m.mask); if (o) k = o.apiKey; } return k; };
      // embed：body 带 embed 对象则据它写 cfg.embed（key 留空+掩码=保留旧 key，同 models 的 resolveKey 口径）；不带则原样保留旧 embed（别覆盖没）。
      const oldEmbed = (cur && cur.embed) || null;
      const resolveEmbedKey = e => { let k = (e.apiKey && String(e.apiKey).trim()) ? String(e.apiKey).trim() : ''; if (!k && e.mask && oldEmbed && maskKey(oldEmbed.apiKey) === e.mask) k = oldEmbed.apiKey; return k; };
      let embedCfg = oldEmbed;   // 缺省保留旧 embed
      if (b.embed && typeof b.embed === 'object') {
        const eb = b.embed, key = resolveEmbedKey(eb), model = (eb.model || '').trim(), baseUrl = (eb.baseUrl || '').trim();
        embedCfg = (key && model && baseUrl) ? { provider: eb.provider || 'openai', model, baseUrl, apiKey: key } : null;   // 三要素齐全才存；否则视为清空 embed
      }
      const models = (Array.isArray(b.models) ? b.models : []).map(m => ({ provider: m.provider || 'anthropic', model: (m.model || '').trim(), baseUrl: (m.baseUrl || '').trim(), apiKey: resolveKey(m), primary: !!m.primary })).filter(m => m.apiKey);
      if (!models.length) { const c0 = { provider: 'anthropic' }; if (embedCfg) c0.embed = embedCfg; writeModelCfg(c0); return send(res, 200, JSON.stringify({ ok: true, models: [], embed: embedView(c0) })); }
      const primary = models.find(m => m.primary) || models[0], backups = models.filter(m => m !== primary);
      const c = { provider: primary.provider, model: primary.model, baseUrl: primary.baseUrl, apiKey: primary.apiKey };
      if (backups.length) c.backups = backups.map(m => ({ provider: m.provider, model: m.model, baseUrl: m.baseUrl, apiKey: m.apiKey }));
      if (embedCfg) c.embed = embedCfg;   // 与 models 一起持久化，别把 embed 覆盖没
      writeModelCfg(c);
      send(res, 200, JSON.stringify({ ok: true, models: modelsOf(c), embed: embedView(c) }));
    });
  }
  if (url.pathname === '/api/model-test' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const cur = readModelCfg();
      // kind:'embed'（或带 embed 字段）→ 测 embedding 连通：POST {baseUrl}/embeddings，成功返回维度；否则维持原聊天模型测试。
      if (b.kind === 'embed' || (b.embed && typeof b.embed === 'object')) {
        const src = (b.embed && typeof b.embed === 'object') ? b.embed : b;   // 兼容 {kind:'embed', baseUrl,model,apiKey,mask} 或 {embed:{...}}
        const oldEmbed = (cur && cur.embed) || null;
        let ekey = (src.apiKey && String(src.apiKey).trim()) ? String(src.apiKey).trim() : '';
        if (!ekey && src.mask && oldEmbed && maskKey(oldEmbed.apiKey) === src.mask) ekey = oldEmbed.apiKey;   // 留空+掩码 → 保留旧 key
        const model = (src.model || '').trim(), baseUrl = (src.baseUrl || '').trim();
        if (!ekey || !model || !baseUrl) return send(res, 200, JSON.stringify({ ok: false, error: '未配置 embedding（接口地址 / 模型 / API Key 需齐全）' }));
        try {
          const r = await fetch(baseUrl.replace(/\/$/, '') + '/embeddings', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + ekey }, body: JSON.stringify({ model, input: ['测试'] }), signal: AbortSignal.timeout(30000) });
          const j = await r.json().catch(() => null);
          if (!r.ok) throw new Error((j && j.error && j.error.message) || ('HTTP ' + r.status));
          const vec = (((j && j.data) || [])[0] || {}).embedding || [];
          if (!Array.isArray(vec) || !vec.length) throw new Error('响应无 embedding 向量');
          return send(res, 200, JSON.stringify({ ok: true, dim: vec.length, model }));
        } catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      }
      const oldModels = [{ provider: cur.provider, model: cur.model, baseUrl: cur.baseUrl, apiKey: cur.apiKey }, ...((Array.isArray(cur.backups) ? cur.backups : []))];
      let apiKey = (b.apiKey && String(b.apiKey).trim()) ? String(b.apiKey).trim() : '';
      if (!apiKey && b.mask) { const o = oldModels.find(x => maskKey(x.apiKey) === b.mask); if (o) apiKey = o.apiKey; }
      const cfg = { provider: b.provider || 'anthropic', model: (b.model || '').trim(), baseUrl: (b.baseUrl || '').trim(), apiKey };
      try { const txt = await callModelOnce(cfg, { messages: [{ role: 'user', content: '只回复两个字：正常' }], maxTokens: 16 }); send(res, 200, JSON.stringify({ ok: true, reply: (txt || '').trim().slice(0, 40), model: cfg.model || '(默认)' })); }
      catch (e) { send(res, 200, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
    });
  }

  // ---------- 进件 ----------
  if (url.pathname === '/api/intake-submit' && req.method === 'POST') {   // H5 提交需求/BUG → 写 intake-store → AI 首轮沟通
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(link ? link.project : b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '请选择项目' }));
      const type = b.type === 'bug' ? 'bug' : 'requirement';
      const version = String(b.version || '').trim() || (link ? link.ver : '');
      // FS-04 决策 B/AC-21：登录现场账号归档 site 服务端收敛到 user.sites（越权→取合法首家）；链接身份用 link.site。
      const site = user ? convergeSite(user, b.site) : (String(b.site || '').trim() || (link ? link.site : ''));
      if (type === 'bug' && !version) return send(res, 400, JSON.stringify({ ok: false, error: '请填/选产品版本（BUG 必填）' }));
      const id = intakeGenId(proj, type), media = [];
      try { const mdir = path.join(intakeDir(proj), 'media', id); const imgs = (b.images || []).slice(0, 6); if (imgs.length) fs.mkdirSync(mdir, { recursive: true }); imgs.forEach((du, i) => { const m = /^data:image\/\w+;base64,(.+)$/.exec(du || ''); if (m) { fs.writeFileSync(path.join(mdir, `img-${i + 1}.png`), Buffer.from(m[1], 'base64')); media.push(`media/${id}/img-${i + 1}.png`); } }); } catch {}
      const d = new Date(); const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
      const reporter = (b.reporter || '').trim() || (user ? (user.name || user.username) : (link ? link.name : ''));   // 登录人 / 链接现场
      const e = { id, type, project: proj.id, version, site, subsystem: String(b.subsystem || '').trim(), module: b.module || '', title: (b.title || '').trim(), priority: normPriority(b.priority, '中'), severity: b.severity || '', scope: b.scope || '', env: b.env || '', freq: b.freq || '', reporter, role: b.role || '', contact: (b.contact || '').trim(), bg: b.bg || '', reqDesc: b.reqDesc || '', scene: b.scene || '', accept: b.accept || '', relate: b.relate || '', desc: b.desc || '', errorInfo: b.errorInfo || '', steps: b.steps || '', expectResult: b.expectResult || '', media, status: '待处理', lifecycle: '待处理', assignee: '', history: [{ from: '', to: '待处理', by: reporter, byRole: (user ? user.role : 'field'), at: stamp, note: '提交' }], analysis: null, resolution: {}, submittedAt: stamp, chat: [] };
      await saveIntake(proj, e);
      const ai = await intakeAI(proj, e);
      e.chat.push({ role: 'assistant', text: ai.reply, ts: Date.now() });
      if (ai.configured) e.status = '沟通中';
      await saveIntake(proj, e);
      send(res, 200, JSON.stringify({ ok: true, id, no: id, reply: ai.reply, configured: ai.configured, status: e.status }));
    });
  }
  if (url.pathname === '/api/intake-reply' && req.method === 'POST') {   // 提交人回复 AI 的澄清 → AI 继续
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const e = loadIntake(proj, b.id); if (!e) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      const msg = (b.message || '').trim(); if (!msg) return send(res, 400, JSON.stringify({ ok: false, error: 'empty' }));
      // Part B（per-message media · intake-reply）：续聊某轮带图 → 存到该单 media 目录（从已有 media 数累加、封顶 6），并把本轮图挂到本条 user 消息（reopen 时随该轮就位）。
      const rImgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6);
      const rPrevMedia = Array.isArray(e.media) ? e.media.slice() : [];
      const rRoundMedia = [];
      try {
        const room = Math.max(0, 6 - rPrevMedia.length); const add = rImgs.slice(0, room);
        if (add.length) { const mdir = path.join(intakeDir(proj), 'media', e.id); fs.mkdirSync(mdir, { recursive: true }); add.forEach((du, i) => { const mm = /^data:image\/\w+;base64,(.+)$/.exec(du || ''); if (mm) { const n = rPrevMedia.length + i + 1; fs.writeFileSync(path.join(mdir, `img-${n}.png`), Buffer.from(mm[1], 'base64')); const p = `media/${e.id}/img-${n}.png`; rRoundMedia.push(p); } }); }
      } catch {}
      if (rRoundMedia.length) e.media = rPrevMedia.concat(rRoundMedia);   // 记录级 media 累加（detail.html 兼容）
      const userMsg = { role: 'user', text: msg, ts: Date.now() }; if (rRoundMedia.length) userMsg.media = rRoundMedia.slice();
      e.chat = e.chat || []; e.chat.push(userMsg); await saveIntake(proj, e);
      const ai = await intakeAI(proj, e); e.chat.push({ role: 'assistant', text: ai.reply, ts: Date.now() }); saveIntake(proj, e);
      send(res, 200, JSON.stringify({ ok: true, reply: ai.reply }));
    });
  }
  if (url.pathname === '/api/intake-chat' && req.method === 'POST') {   // 对话式进件：AI 按标准边聊边补全，够了输出 record → 归档
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(link ? link.project : b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '请先选择所属系统' }));
      const type = (b.type === 'bug' || b.type === 'requirement') ? b.type : 'intake';   // 'intake' = 合并模式，让 AI 判需求/BUG
      const version = String(b.version || '').trim() || (link ? link.ver : '');
      // FS-04 决策 B/AC-21：登录现场账号归档 site 服务端收敛到 user.sites（越权→取合法首家）；链接身份用 link.site。
      const site = user ? convergeSite(user, b.site) : (String(b.site || '').trim() || (link ? link.site : ''));
      const sub = String(b.subsystem || '').trim();   // 用户指定的子系统
      const cfg = readModelCfg(); if (!cfg.apiKey) return send(res, 200, JSON.stringify({ ok: true, reply: '（管理员还没配置模型 API，暂时不能对话；配好后即可用。）' }));
      const msgs = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && m.content).slice(-24).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
      if (!msgs.length) return send(res, 400, JSON.stringify({ ok: false, error: 'empty' }));
      const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6);   // 本轮附的截图（data URL，≤6）→ 多模态并进末条 user，让 AI 结合图判类/建单
      let reply; try { reply = await callModel(cfg, { system: intakeChatSystem(proj, type, version, sub) + (imgs.length ? '\n用户本轮可能附了截图，请结合图片理解问题/复现场景。' : ''), messages: msgs, images: imgs, maxTokens: 800 }); }
      catch (e) { return send(res, 200, JSON.stringify({ ok: true, reply: '（AI 暂时连不上：' + String((e && e.message) || e) + '，稍后再试。）' })); }
      let savedId = '', savedPriority = '';   // 单条兼容：老前端只读 savedId/priority（首张单），保持不变
      const savedIds = [];                     // Part A：多条需求 → 多个 intake-record 块 → 多张单，逐张回带 {id,type,priority} 供前端建多张卡
      // Part A：AI 一次可产出多个 intake-record 块（一条需求/BUG 一个块）→ 全量解析、每块各建一张单（不再只取第一个块）。
      const blockRe = /```intake-record\s*([\s\S]*?)```/g;
      const blocks = [...(reply || '').matchAll(blockRe)];
      for (const m of blocks) {
        let rec = null; try { rec = JSON.parse(m[1].trim()); } catch {}
        if (!rec || !(rec.title || '').trim()) continue;   // 无法解析/无标题的块跳过（不建脏单），其余块照常
        const recType = type === 'intake' ? (String(rec.type || '').toLowerCase() === 'bug' ? 'bug' : 'requirement') : type;   // 合并模式取 AI 判定的类型
        const id = intakeGenId(proj, recType), stamp = nowStamp(), reporter = user ? (user.name || user.username) : (link ? link.name : ''), media = [];
        // Part B：本轮附图存到「该单」media 目录（多张单各存一份，保持每张单自包含、便于单独清理），路径记 e.media（detail.html 用）+ 挂到该单 chat 末条 user 消息（reopen 按轮显图）。
        try { const mdir = path.join(intakeDir(proj), 'media', id); if (imgs.length) fs.mkdirSync(mdir, { recursive: true }); imgs.forEach((du, i) => { const mm = /^data:image\/\w+;base64,(.+)$/.exec(du || ''); if (mm) { fs.writeFileSync(path.join(mdir, `img-${i + 1}.png`), Buffer.from(mm[1], 'base64')); media.push(`media/${id}/img-${i + 1}.png`); } }); } catch {}
        // Part B（per-message media）：把本轮图挂到该单 chat 的「最后一条 user」消息上（=本轮发言）；旧记录无 msg.media 时前端兜底走记录级 e.media。
        const chatMsgs = msgs.map(x => ({ role: x.role, text: x.content, ts: Date.now() }));
        if (media.length) { for (let i = chatMsgs.length - 1; i >= 0; i--) { if (chatMsgs[i].role === 'user') { chatMsgs[i].media = media.slice(); break; } } }
        // AC-32（2026-08-06 改）：紧急程度改「per-ticket」——不再被全局 b.priority 覆盖；按 AI 每条 record 判定的 rec.priority 规范到四档（非法/空→中）。现场逐条改档走 /api/intake-set-priority（本次响应回带 priority 作现场卡片默认档）。
        const e = { id, type: recType, project: proj.id, version, site, subsystem: sub || rec.subsystem || '', module: rec.module || '', title: (rec.title || '').trim(), priority: normPriority(rec.priority, '中'), severity: rec.severity || '', scope: rec.scope || '', env: rec.env || '', freq: rec.freq || '', reporter, role: '', contact: '', bg: rec.bg || '', reqDesc: rec.reqDesc || '', scene: '', accept: rec.accept || '', relate: rec.relate || '', desc: rec.desc || '', errorInfo: rec.errorInfo || '', steps: rec.steps || '', expectResult: rec.expectResult || '', opinion: rec.opinion || '', media, status: '待处理', lifecycle: '待处理', assignee: '', history: [{ from: '', to: '待处理', by: reporter, byRole: (user ? user.role : 'field'), at: stamp, note: '对话提交' }], analysis: null, resolution: {}, submittedAt: stamp, chat: chatMsgs };
        await saveIntake(proj, e);
        savedIds.push({ id, type: recType, priority: e.priority });   // 逐张单：id + AI 判定类型 + 最终紧急档
        if (!savedId) { savedId = id; savedPriority = e.priority; }   // 首张单回填单条字段（老前端兼容）
      }
      // 把所有归档块从可见正文里剔除（用户不该看到结构块）
      reply = (reply || '').replace(blockRe, '').trim();
      send(res, 200, JSON.stringify({ ok: true, reply, savedId, priority: savedPriority, savedIds }));
    });
  }
  if (url.pathname === '/api/consult' && req.method === 'POST') {   // 答疑：直连 spec + 经验库直接回答 + 给解决思路
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(link ? link.project : b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '请先选择所属系统' }));   // FS-06 AC-C3/C4：访客咨询归属强制取 link.project（前端 project 被忽略，与 intake-submit/chat 一致）；登录用户 link 为空、取 b.project 不变
      const msgs = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && m.content).slice(-24).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
      if (!msgs.length) return send(res, 400, JSON.stringify({ ok: false, error: 'empty' }));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });   // SSE 流式
      const sse = o => { try { res.write('data: ' + JSON.stringify(o) + '\n\n'); } catch {} };
      const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });   // 客户端断连/点"停止"（响应未正常结束）→ 中止上游模型调用
      const cfg = readModelCfg();
      try { refreshRepos(proj, false); } catch {}
      const lastUser = [...msgs].reverse().find(m => m.role === 'user'); const qtext = lastUser ? lastUser.content : '';
      const sub = String(b.subsystem || '').trim();   // 用户指定的子系统（空=全部）
      const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6);   // 本轮附的截图（data URL，≤6）→ 多模态并进末条 user，让 AI 结合图答疑；落库见下方 convId 已知处
      const hits = await kbRetrieve(proj.id, qtext, 5, 2); const specHits = specSearch(proj, String(b.version || '').trim(), qtext, 5, sub);   // consult：语义混合召回（配了 embedding 时 sim>=SEM_GATE||lex>=2 入选；未配/失败自动退回关键词 minScore=2）。弱匹配（只命中 1 个常见 token 且语义不相关）既不注入 consultSystem 也不发 kb 事件

      const codeHits = b.deep ? codeSearch(proj, String(b.version || '').trim(), qtext, specHits, 4, sub) : null;   // 「深入思考」：搜源码
      // FS-06 引用可见：命中经验库时先发一个 kb 事件（流式答复之前），前端据此渲染「📚 参考经验库(N)」，让答复所引「历史经验库」有据可查、不再断层。
      //   字段精简（q/a 已在 kbSearch/loadKB 内截断），仅 hits.length 时发；老前端解析忽略未知字段、不受影响（向后兼容）。
      if (hits.length) sse({ kb: hits.map(h => ({ q: h.q, a: h.a, subsystem: h.subsystem || '', module: h.module || '', subsystemLabel: kbSubLabel(proj.id, h.subsystem) })) });
      let reply = '', stopped = false;
      if (!cfg.apiKey) { reply = '（管理员还没配置模型 API，暂时不能答疑。）'; sse({ v: reply }); }
      else {
        try { await callModelStream(cfg, { system: consultSystem(proj, String(b.version || '').trim(), hits, specHits, codeHits) + (imgs.length ? '\n用户本轮可能附了截图，请结合图片理解问题。' : ''), messages: msgs, images: imgs, maxTokens: b.deep ? 1100 : 800 }, piece => { reply += piece; sse({ v: piece }); }, ac.signal); }
        catch (e) {
          if (ac.signal.aborted) stopped = true;   // 用户主动停止：保留已生成的部分
          else { const m = (reply ? '\n\n' : '') + '（AI 暂时连不上：' + String((e && e.message) || e) + '，稍后再试。）'; reply += m; sse({ v: m, err: true }); }
        }
      }
      reply = reply.trim();
      // 持久化答疑会话（含部分/停止的内容），随聊随存、可在「我的提交」找回（type=consult，默认不进开发工单收件箱）
      let convId = String(b.convId || '').trim();
      if (reply) try {
        const store = CACHE.intakes[proj.id] || {};
        const prev = convId && store[convId] && store[convId].type === 'consult' && !store[convId].deleted ? store[convId] : null;   // 软删 consult 不复活续聊 → 起新会话
        if (!prev) convId = intakeGenId(proj, 'consult');
        // 咨询存图（镜像 intake-chat/submit）：≤6 张 data URL 落 intake-store/<proj>/media/<convId>/img-N.png，记 e.media（detail.html 已按 e.media 展示、对 consult 同样生效）。
        //   续聊同 convId：从已有 media 数量起序号累加（不覆盖前几轮截图），累计封顶 6 张；base 目录用 convId（此处 id===convId）。
        const prevMedia = (prev && Array.isArray(prev.media)) ? prev.media.slice() : [];
        const media = prevMedia.slice();
        const roundMedia = [];   // Part B：仅本轮新增图的路径 → 挂到本轮 user 消息上（per-message media）
        try {
          const room = Math.max(0, 6 - prevMedia.length); const add = imgs.slice(0, room);   // 累计不超过 6 张
          if (add.length) { const mdir = path.join(intakeDir(proj), 'media', convId); fs.mkdirSync(mdir, { recursive: true }); add.forEach((du, i) => { const mm = /^data:image\/\w+;base64,(.+)$/.exec(du || ''); if (mm) { const n = prevMedia.length + i + 1; fs.writeFileSync(path.join(mdir, `img-${n}.png`), Buffer.from(mm[1], 'base64')); const p = `media/${convId}/img-${n}.png`; media.push(p); roundMedia.push(p); } }); }
        } catch {}
        const reporter = user ? (user.name || user.username) : (link ? link.name : '现场');
        // 标题取「第一句问话」（会话原始问题），续聊保留原标题 —— 避免被后续消息（如手打「转工单」）覆盖成无意义标题。
        const firstUser = msgs.find(m => m.role === 'user');
        const title = (prev && String(prev.title || '').trim()) ? prev.title : (((firstUser && firstUser.content) || (msgs[0] && msgs[0].content) || '系统咨询').replace(/\s+/g, ' ').trim().slice(0, 60));
        const chat = [...msgs.map(x => ({ role: x.role, text: x.content })), { role: 'assistant', text: reply, ts: Date.now() }];
        // Part B（per-message media · consult）：consult 每轮用整段 msgs 重建 chat（会丢前几轮消息级 media）——
        //   ① 先把上一版 prev.chat 里 user 消息带的 media 按「第 K 条 user」顺序回贴到重建后的 chat；② 再把本轮新增图挂到「最后一条 user」（=本轮发言）。
        //   前端 msgs 只有 {role,content} 无 media，故必须从 prev.chat 补齐历史轮，避免 reopen 时旧轮图丢失。
        try {
          const prevUserMedia = (prev && Array.isArray(prev.chat) ? prev.chat : []).filter(m => m && m.role === 'user').map(m => (Array.isArray(m.media) ? m.media.slice() : null));
          let ui = 0; for (const m of chat) { if (m.role === 'user') { const pm = prevUserMedia[ui]; if (pm && pm.length) m.media = pm; ui++; } }
          if (roundMedia.length) { for (let i = chat.length - 1; i >= 0; i--) { if (chat[i].role === 'user') { chat[i].media = ((chat[i].media || []).concat(roundMedia)); break; } } }
        } catch {}
        const rec = { id: convId, type: 'consult', project: proj.id, version: String(b.version || '').trim() || (link ? link.ver : ''), site: String(b.site || '').trim() || (link ? link.site : ''), subsystem: sub, module: '', title, priority: '', reporter, role: user ? user.role : 'field', contact: '', media, status: '沟通中', lifecycle: '已答复', assignee: '', analysis: null, resolution: {}, chat, submittedAt: (prev && prev.submittedAt) || nowStamp(), updatedAt: nowStamp() };
        await saveIntake(proj, rec);
      } catch (e) { convId = ''; }
      sse({ done: true, convId, kbHits: hits.length, stopped });
      try { res.end(); } catch {}
    });
  }
  if (url.pathname === '/api/consult-to-intake' && req.method === 'POST') {   // FS-04：咨询答疑「转工单」——把一条 consult 记录建成真实工单（待处理），交运营端评审。不跑 AI（咨询里已讨论过）。现场+管理员可调（已进 FIELD_OK/FS08_FIELD_API）。
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(link ? link.project : b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '请选择项目' }));
      const convId = String(b.convId || '').trim(); if (!convId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少咨询会话 id' }));
      const src = CACHE.intakes[proj.id] && CACHE.intakes[proj.id][convId];
      if (!src || src.type !== 'consult' || src.deleted) return send(res, 400, JSON.stringify({ ok: false, error: '咨询记录不存在' }));   // 只允许对真实（未删）consult 记录转单
      const type = b.type === 'bug' ? 'bug' : 'requirement';                                   // 白名单：仅 bug/requirement，其余归为需求
      const version = String(src.version || '').trim();
      if (type === 'bug' && !version) return send(res, 400, JSON.stringify({ ok: false, error: '报BUG 需产品版本' }));   // BUG 必须有版本（沿用 intake-submit 规则）
      const site = convergeSite(user, src.site);                                               // 越权收敛到当前账号合法医院（决策 B）；无 user（链接）→ 原样
      const title = ((String(b.title || '').trim()) || String(src.title || '').trim() || '系统咨询转工单').slice(0, 300);   // 标题：body 优先、空则用咨询标题（第一句问话），≤300
      // 把咨询对话整理成可读背景 desc：逐条拼「Q:/A:」，供运营评审时看清来龙去脉。
      const chatArr = Array.isArray(src.chat) ? src.chat : [];
      const bgLines = ['【咨询背景】（本工单由咨询答疑转来）'];
      for (const m of chatArr) { const t = String((m && m.text) || '').trim(); if (!t) continue; bgLines.push((m.role === 'assistant' ? 'A: ' : 'Q: ') + t); }
      if (bgLines.length === 1) bgLines.push('Q: ' + (title));                                 // 极端兜底：无 chat 时至少放标题
      const bg = bgLines.join('\n');
      const id = intakeGenId(proj, type), stamp = nowStamp();
      const reporter = user ? (user.name || user.username) : (link ? link.name : '现场');
      const byRole = user ? user.role : 'field';
      const media = Array.isArray(src.media) ? src.media.slice() : [];                         // 咨询截图带过来（media 路径不变，同 project 下 /api/intake-media 仍可取）
      // 咨询对话带进工单 chat 做上下文（role/text；assistant 保持 assistant，其余归 user）
      const chat = chatArr.map(m => ({ role: (m && m.role === 'assistant') ? 'assistant' : 'user', text: String((m && m.text) || ''), ts: Date.now() })).filter(m => m.text);
      const e = {
        id, type, project: proj.id, version, site, subsystem: String(src.subsystem || '').trim(), module: '',
        title, priority: '中', severity: '', scope: '', env: '', freq: '',
        reporter, role: byRole, contact: '',
        // 需求侧背景/BUG 侧现象都放 desc（可读背景）；bg 也填，兼容需求正文渲染
        bg, reqDesc: '', scene: '', accept: '', relate: '', desc: bg, errorInfo: '', steps: '', expectResult: '',
        media, status: '待处理', lifecycle: '待处理', assignee: '',
        history: [{ from: '', to: '待处理', by: reporter, byRole, at: stamp, note: '由咨询转工单' }],
        analysis: null, resolution: {}, submittedAt: stamp, chat,
      };
      await saveIntake(proj, e);
      // 给咨询记录标 convertedTo=id（留痕 + 前端显「已转工单」防重复）
      try { const cur = CACHE.intakes[proj.id][convId]; if (cur && !cur.convertedTo) { cur.convertedTo = id; cur.updatedAt = nowStamp(); await saveIntake(proj, cur); } } catch {}
      send(res, 200, JSON.stringify({ ok: true, id }));
    });
  }
  if (url.pathname === '/api/intake-delete' && req.method === 'POST') {   // FS-02 删除：现场提交记录软删（隐藏标记，不真删库/磁盘，media/history 全保留）。现场+管理员可调（已进 FIELD_OK/FS08_FIELD_API）。
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(link ? link.project : b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '请选择项目' }));
      const id = String((b && b.id) || '').trim(); if (!id) return send(res, 400, JSON.stringify({ ok: false, error: '缺少记录 id' }));
      const e = loadIntake(proj, id);
      const g = intakeDeleteGuard(e, user);   // 守卫：不存在/已删/已转工单/已归批/越权（真值以此端点为准，不信前端 deletable）
      if (!g.ok) {
        if (g.code === 'gone') return send(res, 200, JSON.stringify({ ok: true, alreadyDeleted: true }));   // 幂等：已删当成功（前端从清单移除即可）
        const st = g.code === 'not_found' ? 404 : (g.code === 'forbidden' ? 403 : 400);
        return send(res, st, JSON.stringify({ ok: false, error: g.error }));
      }
      const at = nowStamp(); const by = user ? (user.name || user.username) : (link ? link.name : '现场'); const byRole = user ? user.role : 'field';
      e.deleted = true; e.deletedAt = at; e.deletedBy = by;                                       // 软删标记随 data JSON 落库（不加库列，同 e.batch/media 范式）
      if (!Array.isArray(e.history)) e.history = [];
      e.history.push({ from: e.status || e.lifecycle || '', to: '已删除', by, byRole, at, note: '删除' });   // 留痕：谁/何时/删除
      e.updatedAt = at;
      await saveIntake(proj, e);                                                                  // 缓存+MySQL(data JSON)+导出 .md/.json 一并更新
      return send(res, 200, JSON.stringify({ ok: true }));
    });
  }
  if (url.pathname === '/api/kb-search') {   // FS-07：现场只读检索经验库（全库跨产品聚合，方案 A）。已加入 FIELD_OK（现场可调）。
    const qtext = String(url.searchParams.get('q') || '').trim();
    const browseAll = url.searchParams.get('all') === '1';                                       // FS-07 浏览态：all=1 且无 q → 返回全库所有条目（供打开经验库即可浏览，非空态 hollow）
    const only = String(url.searchParams.get('project') || '').trim();                           // 可选：只搜该产品；缺省=全库所有产品
    // 浏览全部：all=1 且无 q → 跨所有产品返回全库条目（分数无关的稳定顺序：产品登记序 × 产品内条目序），封顶 50。不改 q 有值时的现有行为。
    if (browseAll && !qtext) {
      const bpids = only ? (projById(only) ? [only] : []) : loadProjects().map(p => p.id);
      const CAP = 50; const out = [];
      for (const pid of bpids) {
        const name = (projById(pid) || {}).name || '';
        for (const e of loadKB(pid)) { out.push({ ...e, project: pid, productName: name, subsystemLabel: kbSubLabel(pid, e.subsystem) }); if (out.length >= CAP) break; }
        if (out.length >= CAP) break;
      }
      return send(res, 200, JSON.stringify({ entries: out }));                                   // 全库为空 → 空数组（前端据此显「经验库暂无内容」）
    }
    if (!qtext) return send(res, 200, JSON.stringify({ entries: [] }));                          // 空关键词（无 all）→ 空数组（对齐现有端点温和风格，保 L-记录空态契约）
    // GET 端点在同步 createServer 回调里 → 语义召回要 await，用 async IIFE 包裹；embed 失败/未配全退回关键词，绝不报错、绝不空结果。
    (async () => {
      let n = parseInt(url.searchParams.get('n') || '5', 10); if (!Number.isFinite(n) || n < 1) n = 5; if (n > 20) n = 20;   // 默认 5、封顶 20
      const pids = only ? (projById(only) ? [only] : []) : loadProjects().map(p => p.id);          // 全库=遍历已登记产品；未知过滤 id → 空
      const qtok = new Set(kbTokenize(qtext));
      // 语义混合：跨产品只 embed 一次 query（qv），各产品补算缓存后调 _kbScored 复用；失败/未配 → qv=null 完全退回关键词。
      let qv = null;
      if (loadEmbedCfg()) {
        try { for (const pid of pids) await ensureKbEmbed(pid); const vs = await embedTexts([qtext]); qv = (vs && vs[0]) || null; }
        catch { qv = null; }
      }
      const scored = [];
      for (const pid of pids) {
        const name = (projById(pid) || {}).name || '';
        for (const { e, rank } of _kbScored(pid, qtext, qtok, qv, 1)) {                            // 单产品混合打分（语义可用则含 sim，否则纯关键词）；每产品全量参与全局排序
          scored.push({ rank, e: { ...e, project: pid, productName: name, subsystemLabel: kbSubLabel(pid, e.subsystem) } });   // 追加 project(产品 id)+productName(产品名)+subsystemLabel(子系统中文 desc，展示用) 以区分产品
        }
      }
      scored.sort((a, b) => b.rank - a.rank);                                                      // 全局按 rank 降序（语义 sim 或关键词分）
      send(res, 200, JSON.stringify({ entries: scored.slice(0, n).map(x => x.e) }));               // 取全局 Top-N
    })().catch(() => { try { send(res, 200, JSON.stringify({ entries: [] })); } catch {} });       // 兜底：意外错误也不 500（温和空态）
    return;
  }
  if (url.pathname === '/api/kb-list') { const proj = projById(url.searchParams.get('project')); return send(res, 200, JSON.stringify({ entries: proj ? loadKB(proj.id) : [] })); }
  if (url.pathname === '/api/kb-save' && req.method === 'POST') {   // 人工新增/编辑经验条目
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const q = String(b.q || '').trim(), a = String(b.a || '').trim();
      if (!q || !a) return send(res, 400, JSON.stringify({ ok: false, error: '问题和解法都要填' }));
      const arr = loadKB(proj.id), rec = { subsystem: String(b.subsystem || '').trim(), module: String(b.module || '').trim(), tags: Array.isArray(b.tags) ? b.tags.map(String) : [], q: q.slice(0, 400), a: a.slice(0, 2000) };
      // KB-01 微扩：人工新增/编辑可选带 source（manual/consult/auto）+ from_ref（来源工单 id），映射到内存 from（replaceKB 依此派生 source/from_ref）。
      // 缺省 = 与旧实现一致（manual）。from 语义：manual/consult 原样派生同名 source；其余值 → source=auto、from_ref=该值（沿用工单自动沉淀口径）。
      const from = kbFromOf(b.source, b.from_ref);
      const idx = b.id ? arr.findIndex(x => x.id === b.id) : -1;
      if (idx >= 0) arr[idx] = { ...arr[idx], ...rec, ...(from ? { from } : {}) }; else arr.push({ id: 'k' + crypto.randomBytes(4).toString('hex'), from: from || 'manual', at: nowStamp(), ...rec });
      try { await saveKB(proj.id, arr); } catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      send(res, 200, JSON.stringify({ ok: true, entries: arr }));
    });
  }
  if (url.pathname === '/api/kb-delete' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const arr = loadKB(proj.id).filter(x => x.id !== String(b.id || ''));
      try { await saveKB(proj.id, arr); } catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      send(res, 200, JSON.stringify({ ok: true, entries: arr }));
    });
  }
  if (url.pathname === '/api/kb-from-consult' && req.method === 'POST') {   // 答疑"解决了"→一键沉淀到经验库
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      // 优先按 convId 取整段咨询对话，用 AI 整理成一条经验库条目（core Q + 涵盖全脉络 A）；无 convId 回落旧的 q/a 兼容。
      const convId = String(b.convId || '').trim();
      let q = '', a = '', sub = '';
      if (convId) {
        const src = CACHE.intakes[proj.id] && CACHE.intakes[proj.id][convId];
        if (!src || src.type !== 'consult' || src.deleted) return send(res, 400, JSON.stringify({ ok: false, error: '咨询记录不存在' }));
        // 数据权限收敛：现场账号只能沉淀自己 sites 内医院的咨询（管理员不限）；越权拒（对齐 intake-verify/set-priority 范式）
        if (user && !isAdmin(user) && (!Array.isArray(user.sites) || !user.sites.map(String).includes(String(src.site || '')))) return send(res, 403, JSON.stringify({ ok: false, error: '无权沉淀该医院的咨询' }));
        const chat = Array.isArray(src.chat) ? src.chat : [];
        // 兜底（AI 未配/失败/解析失败均用它）：q=第一条 user 文本（核心问题，非最后一个追问）、a=最后一条 assistant 文本
        const firstUser = chat.find(m => m.role === 'user');
        let lastAssistant = ''; for (let i = chat.length - 1; i >= 0; i--) { if (chat[i].role === 'assistant') { lastAssistant = chat[i].text || ''; break; } }
        q = String((firstUser && firstUser.text) || '').trim();
        a = String(lastAssistant || '').trim();
        sub = String(src.subsystem || '').trim();
        // 用 AI 把整段对话整理成一条经验库条目（涵盖核心问题→关键排查→最终定位与解法）
        const cfg = readModelCfg();
        if (cfg.apiKey && chat.length) {
          const dialog = chat.map(m => `${m.role === 'assistant' ? 'AI' : (m.role === 'dev' ? '开发' : '现场')}：${String(m.text || '').trim()}`).join('\n');
          const sys = '把下面这段现场咨询对话整理成一条「经验库」条目，输出严格 JSON `{"q":"…","a":"…"}`（不要任何解释文字、不要代码块围栏）：\n' +
            'q = 用户遇到的**核心问题**（一句话，抓真正要解决的那个，**不是最后一个追问**，比如整段在排查"为什么功能没生效"，核心就是它，而非中途某个技术现象）；\n' +
            'a = **最终解决方案/结论**，要**涵盖整段排查的关键脉络**（从核心问题 → 关键排查步骤 → 最终定位与解法），条理清晰、可操作，给下一个人照做。\n' +
            '别把整段对话原样堆上来、别只写最后一步、别丢掉真正的核心问题。';
          try {
            const txt = await callModel(cfg, { system: sys, messages: [{ role: 'user', content: dialog }], maxTokens: 900 });
            const mm = /\{[\s\S]*\}/.exec(String(txt || ''));
            if (mm) { const o = JSON.parse(mm[0]); const oq = String(o.q || '').trim(), oa = String(o.a || '').trim(); if (oq && oa) { q = oq; a = oa; } }
          } catch (e) { /* AI 失败 → 用上面兜底的 firstUser/lastAssistant */ }
        }
      } else {
        // 向后兼容：老前端仍发 {project,q,a}（最后一轮问答）
        q = String(b.q || '').trim(); a = String(b.a || '').trim();
      }
      if (!q || !a) return send(res, 400, JSON.stringify({ ok: false, error: '缺少问答内容' }));
      const arr = loadKB(proj.id); arr.push({ id: 'k' + crypto.randomBytes(4).toString('hex'), from: 'consult', at: nowStamp(), subsystem: sub, module: '', tags: [], q: q.slice(0, 400), a: a.slice(0, 2000) });
      try { await saveKB(proj.id, arr); } catch (e) { return send(res, 500, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      send(res, 200, JSON.stringify({ ok: true }));
    });
  }
  if (url.pathname === '/api/intake-analyze' && req.method === 'POST') {   // 平台内 AI 版本感知初判（读 spec@version）→ 写 analysis，转「分析中」
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const e = loadIntake(proj, b.id); if (!e) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      // FS-04 NH-3：intake-analyze 已放开给现场（进 FIELD_OK），但按 sites 收敛——现场只能 analyze 自己 sites 内医院的工单，越权→403。
      //   同时按 projects 收敛（与 intake-detail 一致）。管理员（isAdmin）天然放行。
      if (user && !isAdmin(user) && (((user.projects || []).length && !user.projects.includes(proj.id)) || ((user.sites || []).length && !user.sites.includes(e.site || '')))) return send(res, 403, JSON.stringify({ ok: false, error: '无权分析该工单' }));
      const cfg = readModelCfg(); if (!cfg.apiKey) return send(res, 200, JSON.stringify({ ok: false, configured: false, error: '未配置模型 API，无法分析' }));
      let txt; try { txt = await callModel(cfg, { system: analyzeSystem(proj, e.version), messages: [{ role: 'user', content: intakeHead(e) + (e.chat && e.chat.length ? '\n\n已有沟通：\n' + e.chat.map(m => `${m.role === 'assistant' ? 'AI' : '现场'}：${m.text}`).join('\n') : '') }], maxTokens: 700 }); }
      catch (er) { return send(res, 200, JSON.stringify({ ok: false, error: 'AI 连不上：' + String((er && er.message) || er) })); }
      const parsed = parseAnalysis(txt); if (!parsed) return send(res, 200, JSON.stringify({ ok: false, error: 'AI 未返回可解析的初判', raw: String(txt || '').slice(0, 300) }));
      const at = nowStamp();
      e.analysis = { ...parsed, at, model: cfg.model || cfg.provider || '' };
      if (e.lifecycle === '待处理') { e.history = e.history || []; e.history.push({ from: '待处理', to: '分析中', by: 'AI', byRole: 'ai', at, note: 'AI 分析初判' }); e.lifecycle = '分析中'; e.status = lifecycleToStatus(e.lifecycle); }
      await saveIntake(proj, e);
      send(res, 200, JSON.stringify({ ok: true, analysis: e.analysis, lifecycle: e.lifecycle }));
    });
  }
  if (url.pathname === '/api/intake-transition' && req.method === 'POST') {   // 工单流转：校验合法性 + 留痕 history + 可带 resolution/回复
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const e = loadIntake(proj, b.id); if (!e) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      const from = e.lifecycle || deriveLifecycle(e), to = String(b.to || '').trim();
      if (!LIFECYCLE.includes(to)) return send(res, 400, JSON.stringify({ ok: false, error: '未知目标状态' }));
      if (user && !isAdmin(user) && !(from === '待验证' && (to === '已关闭' || to === '已重开'))) return send(res, 403, JSON.stringify({ ok: false, error: '现场仅可在「待验证」时确认验证结果' }));
      const allowed = (to === '已关闭' && from !== '已关闭') || (TRANSITIONS[from] || []).includes(to);   // 任意非关闭态可强制关闭
      if (!allowed) return send(res, 400, JSON.stringify({ ok: false, error: `不能从「${from}」直接流转到「${to}」` }));
      const at = nowStamp();
      const actorRole = user ? user.role : (b.byRole || 'dev');
      const actorBy = (b.by || '').trim() || (user ? (user.name || user.username) : (actorRole === 'field' ? '现场' : '开发'));
      e.history = e.history || []; e.history.push({ from, to, by: actorBy, byRole: actorRole, at, note: (b.note || '').trim() });
      e.lifecycle = to; e.status = lifecycleToStatus(to);
      if (b.assignee != null) e.assignee = String(b.assignee).trim();
      if (b.resolution && typeof b.resolution === 'object') e.resolution = { ...(e.resolution || {}), commit: String(b.resolution.commit || (e.resolution || {}).commit || '').trim(), pr: String(b.resolution.pr || (e.resolution || {}).pr || '').trim(), fixedVersion: String(b.resolution.fixedVersion || (e.resolution || {}).fixedVersion || '').trim(), note: String(b.resolution.note || (e.resolution || {}).note || '').trim(), at };
      if ((b.reply || '').trim()) { e.chat = e.chat || []; e.chat.push({ role: 'dev', text: String(b.reply).trim(), ts: Date.now() }); }   // 开发回复现场，落进沟通记录
      // TK-01【扩展·落实开发归批次】落实（to=已立项）时把归入的批次 id 写进 data.batch（放 JSON、不加库列）；
      //   NH-2 退化：BP-01 未上线时允许「落实不带批次」——batch 留空、不阻断（前端亦不强制选批次）。传空/未传则不覆盖既有值。
      if (to === '已立项' && b.batch != null) { const bt = String(b.batch).trim(); if (bt) e.batch = bt.slice(0, 40); }
      // TK-01【扩展·steward UC 回写】stewardUC（steward 侧 UC 号）由 ST-02 回写进度时携带，落 data（本 spec 只读展示，此处允许写入以供回链）
      if (b.stewardUC != null) { const uc = String(b.stewardUC).trim(); if (uc) e.stewardUC = uc.slice(0, 40); }
      await saveIntake(proj, e);
      let kbSunk = false; if (to === '已回复' || to === '已关闭') kbSunk = await kbAddFromIntake(proj, e);   // 解决即自动沉淀经验库
      send(res, 200, JSON.stringify({ ok: true, lifecycle: e.lifecycle, kbSunk, item: { id: e.id, lifecycle: e.lifecycle, status: e.status } }));
    });
  }
  if (url.pathname === '/api/intake-list') {
    const proj = projById(url.searchParams.get('project')); if (!proj) return send(res, 200, JSON.stringify({ items: [] }));
    if (user && !isAdmin(user) && (user.projects || []).length && !user.projects.includes(proj.id)) return send(res, 200, JSON.stringify({ items: [] }));
    let items = listIntake(proj, { withConsult: url.searchParams.get('withConsult') === '1' });
    items = scopedForField(user, items);   // FS-01 AC-11/12/20：服务层按 me.sites 过滤，忽略前端越权传参
    return send(res, 200, JSON.stringify({ items }));
  }
  if (url.pathname === '/api/field/systems') {
    // FS-03：实施端「系统视图」顶部平铺系统 tab 数据源。
    //   已裁决 2026-07-22（NH-2）：系统 tab 集 = 平台【全部产品】的子系统全集（projects[].subsystems，去重、稳定排序），
    //   【不】按 sites/已上产品收敛 tab 列表。注意：每个系统下的工单记录仍按 me.sites 收敛（见 /api/field/submissions 的 sys 分支）——收敛的是数据、不是 tab 集。
    //   反查产品（NH-1）：含某子系统 key/name 的 project 即其所属产品（不建独立映射表）；供归档 chip 的产品名 + 可选 tag 版本集。
    if (!user) return send(res, 401, JSON.stringify({ error: '未登录' }));   // 登录可用（已加入 FIELD_OK，现场 impl 可调）；双保险
    const systems = [];
    const seen = new Set();   // 去重键 = 子系统 name（顶部 tab 文案 + 与 intakes.subsystem 匹配的依据）
    for (const p of loadProjects()) {
      const subs = Array.isArray(p && p.subsystems) ? p.subsystems : [];
      for (const s of subs) {
        const key = typeof s === 'string' ? '' : String((s && s.key) || '');
        const name = String(typeof s === 'string' ? s : (s && s.name) || '').trim();
        const desc = String((s && s.desc) || '').trim();                      // 子系统中文描述（前端 tab 显中文优先用它，值仍用 name 匹配 intakes.subsystem）
        if (!name || seen.has(name)) continue;                                // 空名跳过；同名子系统（跨产品）取首见，稳定
        seen.add(name);
        systems.push({ key, name, desc, project: p.id, productName: p.name || p.id });
      }
    }
    return send(res, 200, JSON.stringify({ systems }));   // 稳定排序 = loadProjects 顺序 × 产品内 subsystems 顺序（前端 全部系统 恒置首位）
  }
  if (url.pathname === '/api/field/submissions') {
    // FS-02：实施端「医院视图 · 提交清单」数据源（按当前登录用户 sites+projects 服务端收敛，忽略越权传参）。
    //   groupBy=type（P1）：按 intakes.type∈{requirement,bug,consult} 三桶分组；groupBy=batch（P2）→ 降级契约。
    //   收敛口径与 intake-list 一致：先按 user.projects 圈定可读产品，再走 scopedForField 按 sites（+条目 project）过滤，越权 hospitalId 被裁掉。
    if (!user) return send(res, 401, JSON.stringify({ error: '未登录' }));   // AC-19：未登录不返数据（authGate 已挡，双保险）
    const dimension = url.searchParams.get('dimension') === 'sys' ? 'sys' : 'hosp';   // hosp（FS-02） / sys（FS-03 跨医院聚合）
    const groupBy = url.searchParams.get('groupBy') === 'batch' ? 'batch' : 'type';
    const subsystem = String(url.searchParams.get('subsystem') || '').trim();
    const system = String(url.searchParams.get('system') || '').trim();               // FS-03 系统视图：选中的系统（子系统名）；空/「全部系统」= 各系统分组
    const projFilter = String(url.searchParams.get('project') || '').trim();
    // 越权 hospitalId 收敛：非管理员传入不在其 sites 的 hospitalId → 视为无效（忽略，返回其 sites 内数据；AC-18）。
    let hospitalId = String(url.searchParams.get('hospitalId') || '').trim();
    const mySites = Array.isArray(user.sites) ? user.sites : [];
    const myProjects = Array.isArray(user.projects) ? user.projects : [];
    if (!isAdmin(user) && hospitalId && mySites.length && !mySites.includes(hospitalId)) hospitalId = '';   // AC-18：越权医院 → 忽略
    // groupBy=batch 仅医院视图有意义；系统视图固定按系统分组（不走批次降级）。
    if (dimension === 'hosp' && groupBy === 'batch') {
      // AC-15 · P2 降级：batches 表未建（NEEDS-HUMAN，见 spec §5.3）→ 不臆造批次，返回降级契约，前端切按类型。
      return send(res, 200, JSON.stringify({ dimension, hospitalId, groupBy: 'batch', degraded: true, fallback: 'byType', groups: [], msg: '批次分组待运营端发包功能上线' }));
    }
    // 汇总我可读产品的全部工单（含 consult），服务端按 projects+sites 双收敛（复用 intake-list 口径，忽略前端越权）。
    let all = [];
    for (const p of loadProjects()) {
      if (projFilter && p.id !== projFilter) continue;                                   // 前端指定 project 限定（仍受下方 projects 收敛）
      if (!isAdmin(user) && myProjects.length && !myProjects.includes(p.id)) continue;   // AC-20：产品范围收敛
      const list = listIntake(p, { withConsult: true }).map(it => Object.assign({ project: p.id }, it));
      for (const it of list) all.push(it);
    }
    all = scopedForField(user, all);   // AC-18/20 + FS-03 AC-6/7/10：按 me.sites（+project）过滤越权——系统视图数据边界同样是 sites（收敛数据，不收敛 tab 集）。
    // 批次排期查表：工单 e.batch（=批次 id）→ 批次 scheduleDate（计划交付日期）。读时派生、别落库；无批次/无排期→空。
    const schedByBatch = new Map();
    for (const bt of loadBatches()) schedByBatch.set(String(bt.id || ''), String(bt.scheduleDate || ''));
    // 条目 → 现场清单条目（§6.2 状态标签映射）。挂 batch/batchSchedule：按类型卡显「计划交付 <date>」（该工单归批则取批次排期，无则空）。
    // 可删标记（前端显隐删除入口用）：已转工单（convertedTo）或已归批（batch）→ 不可删（禁破坏在办流程）；守卫真值以 /api/intake-delete 端点为准，deletable 只供 UI。
    const mapItem = (it) => { const lc = it.lifecycle || '待处理'; const sl = fieldStatusLabel(lc); const bid = String(it.batch || '').trim(); const conv = String(it.convertedTo || '').trim(); return { id: it.id, project: it.project, type: it.type, title: it.title || '', subsystem: it.subsystem || '', site: it.site || '', version: it.version || '', module: it.module || '', reporter: it.reporter || '', lifecycle: lc, statusLabel: sl.label, statusTag: sl.tag, batchId: bid, batchSchedule: bid ? (schedByBatch.get(bid) || '') : '', convertedTo: conv, deletable: !conv && !bid, submittedAt: it.submittedAt || '', updatedAt: it.updatedAt || it.submittedAt || '' }; };
    if (dimension === 'sys') {
      // ===== FS-03 系统视图：跨全部负责医院聚合、按子系统分组（忽略医院维度；边界仍是 me.sites） =====
      const only = (system && system !== '全部系统') ? system : '';   // 选某系统 → 只该子系统；空/全部系统 → 各系统分组
      if (only) all = all.filter(it => (it.subsystem || '') === only);   // AC-6：只含 subsystem===X
      // 按子系统分组（每子系统一组），组顺序 = 首现顺序（稳定，AC-7）。空子系统记录归入「其他」组。
      const order = [], map = new Map();
      for (const it of all) {
        const s = (it.subsystem || '').trim() || '其他';
        if (!map.has(s)) { map.set(s, []); order.push(s); }
        map.get(s).push(mapItem(it));
      }
      // 组头显中文：label 复用 kbSubLabel（=projById(product).subsystems[].desc，同 inbox/批次/KB 口径，见 lessons「不要另写映射」）；product 取该组首条工单的 project。空子系统组保留「其他」。
      const groups = order.map(s => { const items = map.get(s); const proj = (items[0] && items[0].project) || ''; const label = (s === '其他') ? '其他' : (proj ? kbSubLabel(proj, s) : s); return { key: s, label, count: items.length, items }; });
      return send(res, 200, JSON.stringify({ dimension: 'sys', system: only, groupBy: 'system', degraded: false, groups }));
    }
    // ===== FS-02 医院视图：当前所选医院 + 三桶（需求/BUG/咨询）分组 =====
    if (hospitalId) all = all.filter(it => (it.site || '') === hospitalId);                // 当前所选医院（越权已在上方裁掉）
    if (subsystem) all = all.filter(it => (it.subsystem || '') === subsystem);             // AC-7/13：子系统即选即筛（两视图同源）
    // 三桶分组（跨批次），组内条目按 §6.2 映射状态标签；空组不返回（前端也不渲染，AC-12）。
    const BUCKETS = [{ key: 'requirement', label: '需求' }, { key: 'bug', label: 'BUG' }, { key: 'consult', label: '咨询' }];
    const groups = [];
    for (const b of BUCKETS) {
      const its = all.filter(it => it.type === b.key).map(mapItem);
      if (its.length) groups.push({ key: b.key, label: b.label, count: its.length, items: its });   // AC-12：空组不渲染
    }
    return send(res, 200, JSON.stringify({ dimension, hospitalId: hospitalId || '', groupBy: 'type', degraded: false, groups }));
  }
  if (url.pathname === '/api/intake-detail') {
    const proj = projById(url.searchParams.get('project')); const e = proj ? loadIntake(proj, url.searchParams.get('id')) : null;
    if (e && e.deleted) return send(res, 404, JSON.stringify({ item: null, error: '记录已删除' }));   // 软删记录详情不可读、不可 reopen
    if (e && user && !isAdmin(user) && (((user.projects || []).length && !user.projects.includes(proj.id)) || ((user.sites || []).length && !user.sites.includes(e.site || '')))) return send(res, 403, JSON.stringify({ item: null, error: '无权查看该工单' }));
    return send(res, 200, JSON.stringify({ item: e }));
  }
  if (url.pathname === '/api/intake-aggregate') { const proj = projById(url.searchParams.get('project')); return send(res, 200, JSON.stringify({ groups: proj ? aggregateIntake(proj) : [] })); }
  if (url.pathname === '/api/intake-export') {   // 导出该项目工单为 CSV（Excel 可开）
    const proj = projById(url.searchParams.get('project')); if (!proj) return send(res, 404, 'no project', 'text/plain');
    const cols = [['id', '编号'], ['type', '类型'], ['subsystem', '子系统'], ['module', '模块'], ['title', '标题'], ['version', '版本'], ['site', '现场'], ['priority', '优先级'], ['lifecycle', '状态'], ['assignee', '经办'], ['reporter', '提交人'], ['submittedAt', '提交时间']];
    const cel = v => { v = String(v == null ? '' : v).replace(/"/g, '""'); return /[",\n]/.test(v) ? `"${v}"` : v; };
    const rows = [cols.map(c => c[1]).join(',')];
    for (const it of listIntake(proj)) rows.push(cols.map(c => cel(c[0] === 'type' ? (it.type === 'bug' ? 'BUG' : '需求') : it[c[0]])).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="intake-${proj.id}.csv"` });
    return res.end('﻿' + rows.join('\r\n'));
  }
  if (url.pathname === '/api/notifications') {   // 站内待办提醒（按角色）：工单待办 + 维保到期提醒
    if (!user) return send(res, 200, JSON.stringify({ count: 0, items: [] }));
    const items = [];
    for (const p of loadProjects()) {
      let list = scopedForField(user, listIntake(p));   // FS-01 AC-20：待办同样按 me.sites 隔离（复用统一过滤，避免漂移）
      for (const it of list) {
        const need = isAdmin(user) ? (it.lifecycle === '待处理' || it.lifecycle === '已重开') : (it.lifecycle === '已回复' || it.lifecycle === '待验证');
        if (need) items.push({ kind: 'ticket', project: p.id, id: it.id, title: it.title, lifecycle: it.lifecycle, type: it.type });   // kind:'ticket' 供前端区分（维保项 kind:'maintain'）
      }
    }
    items.sort((a, b) => (a.lifecycle || '').localeCompare(b.lifecycle || ''));
    // 维保到期提醒：可见范围 = 管理员全部 / 实施(field) 仅 user.sites；剩余 ≤15 天（含已过期负数）即提醒。
    //   daysLeft = 到期日 − 今天，用 date-only UTC 归一避免时区 off-by-one（今天取本地年月日再喂 Date.UTC）。
    const maintainItems = [];
    const _now = new Date();
    const todayUTC = Date.UTC(_now.getFullYear(), _now.getMonth(), _now.getDate());
    const admin = isAdmin(user);
    const siteSet = new Set(Array.isArray(user.sites) ? user.sites.map(String) : []);
    for (const c of loadCustomers()) {
      const nm = (c.name || '').trim();
      if (!admin && !siteSet.has(nm)) continue;   // field 仅负责的院
      const me = String(c.maintainEnd || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(me)) continue;   // 无/非法日期跳过
      const [y, mo, d] = me.split('-').map(Number);
      const endUTC = Date.UTC(y, mo - 1, d);
      const daysLeft = Math.round((endUTC - todayUTC) / 86400000);
      if (daysLeft <= 15) maintainItems.push({ kind: 'maintain', site: nm, maintainEnd: me, daysLeft });   // 含已过期（负数）
    }
    maintainItems.sort((a, b) => a.daysLeft - b.daysLeft);   // 越紧急（已过期→负数最小）越靠前
    const all = maintainItems.concat(items);   // 维保项排在工单前更醒目
    // count=全部（实施端待办铃铛用，含维保）；ticketCount=仅工单（后台「工单管理」导航角标用，避免维保虚增工单数）。
    return send(res, 200, JSON.stringify({ count: all.length, ticketCount: items.length, maintainCount: maintainItems.length, items: all.slice(0, 50), role: admin ? 'dev' : 'field' }));
  }
  if (url.pathname === '/api/intake-media') {   // 供详情页取截图（media 落在 intake-store，不在 public/，单开只读端点 + 防穿越）
    const proj = projById(url.searchParams.get('project')); if (!proj) return send(res, 404, 'no project', 'text/plain');
    const safe = path.normalize(url.searchParams.get('file') || '').replace(/^(\.\.[/\\])+/, '');
    const file = path.join(intakeDir(proj), safe);
    if (!file.startsWith(intakeDir(proj) + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'not found', 'text/plain');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(file));
  }

  // ---------- 静态资源（public/）：开发→工作台，现场/链接→提交页 ----------
  // FS-08 §4②：根路由目标已在 authGate 前按 Host 解析进 rootRel（field→field.html / admin→console.html / other→现状 role 分发），此处复用。
  const rel = rootRel || url.pathname;
  const file = path.join(PUBLIC_DIR, rel);
  if (file.startsWith(PUBLIC_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    const ext = path.extname(file), st = fs.statSync(file);
    const hd = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (link && url.searchParams.get('token')) hd['Set-Cookie'] = `intake_link=${url.searchParams.get('token')}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${365 * 86400}`;   // 记住提交链接身份
    // 字体 + 第三方 vendor（tabler 图标）→ 长缓存 immutable：切菜单不再重下字体、图标不闪
    if (/\.(woff2?|ttf|eot|otf)$/i.test(ext) || rel.startsWith('/vendor/')) { hd['Cache-Control'] = 'public, max-age=31536000, immutable'; res.writeHead(200, hd); return res.end(fs.readFileSync(file)); }
    // CSS / JS：仅本地开发（!PUBLIC）不缓存，改完刷新即生效；生产（公网模式）落到下方 no-cache+Last-Modified 协商缓存——浏览器秒取本地缓存（不重下、不闪 FOUC），部署改动靠 mtime 变化返 200 更新
    if (!PUBLIC && /\.(css|m?js)$/i.test(ext)) { hd['Cache-Control'] = 'no-store'; res.writeHead(200, hd); return res.end(fs.readFileSync(file)); }
    // 其它静态（生产 CSS/JS + 所有 HTML/图片）→ Last-Modified 协商缓存：未变返回 304（不重下、不闪，也不会拿到旧的）
    hd['Cache-Control'] = 'no-cache'; hd['Last-Modified'] = st.mtime.toUTCString();
    const since = req.headers['if-modified-since'];
    if (since && Math.floor(st.mtimeMs / 1000) <= Math.floor(new Date(since).getTime() / 1000)) { res.writeHead(304, hd); return res.end(); }
    res.writeHead(200, hd);
    return res.end(fs.readFileSync(file));
  }
  send(res, 404, 'Not Found', 'text/plain');
});

(async () => {
  const dbcfg = readDbCfg();
  db.configure(dbcfg);
  try { await db.init(); await db.ping(); } catch (e) { console.error(`\n  ✗ MySQL 连接失败（${dbcfg.user}@${dbcfg.host}:${dbcfg.port}/${dbcfg.database}）：${(e && e.message) || e}\n    检查数据库是否在跑、data/db.json 凭据是否正确。\n`); process.exit(1); }
  const all = await db.loadAll();
  CACHE.projects = all.projects; CACHE.accounts = all.accounts; CACHE.sessions = all.sessions; CACHE.intakes = all.intakes; CACHE.kb = all.kb;
  await migrateFromFiles();
  await bootstrap();
  pruneSessions(); setInterval(pruneSessions, 3600 * 1000);   // 清理过期会话
  server.listen(PORT, HOST, () => {
    console.log(`\n  收件 · intake（MySQL: ${dbcfg.user}@${dbcfg.host}:${dbcfg.port}/${dbcfg.database}）： http://${HOST}:${PORT}${PUBLIC ? '  [公网模式]' : ''}`);
    console.log(`  · 数据源    MySQL 为准，启动已载入缓存；.md 双写到 ${INTAKE_STORE}`);
    console.log(`  · 提交页 /   收件箱 /inbox.html   项目 /projects.html   经验库 /kb.html   账号 /accounts.html   模型 /model-config.html`);
    console.log('  (Ctrl+C 退出)\n');
  });
})();
