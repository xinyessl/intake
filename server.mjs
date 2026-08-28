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
// PD-02：AI 系统提示词外部化（整段模板 + {{占位}}），默认值=现原文·行为不变；纯逻辑无 DB，可独立单测 tools/pd-02-prompts.logic.test.mjs
import { renderPrompt as renderPromptTpl, readPromptsCfg, writePromptsCfg, effectiveTemplate, isCustomized, checkRequiredPlaceholders, DEFAULT_PROMPTS, PROMPT_META, PROMPT_KEYS, INTAKE_PLAN_SCHEMA, PROMPT_MAX_LEN } from './prompts.mjs';
// FS-09 实施端「个人全览图」纯聚合逻辑（医院卡 + 产品卡；可脱 DB/server 单测：tools/fs-09-overview.logic.test.mjs）
import { buildHospitalCards as ovBuildHospitalCards, buildProductCards as ovBuildProductCards, todayParts as ovTodayParts } from './tools/fs-09-overview-logic.mjs';
import { sortVersions as vpSortVersions } from './tools/version-plan-logic.mjs';
// FS-04 答疑 Spec 两阶段召回：完整目录/元数据路由候选文件，再只搜候选正文；纯逻辑见专项测试。
import { buildSpecDocument, searchSpecDocuments, currentTurnEvidenceGuard, expandRetrievalQuery } from './spec-retrieval.mjs';

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
// PD-03 检索诊断标记：文件存（gitignore 覆盖 /data/），同 model-api.json 范式，非 MySQL。
//   形状 {marks:{[key]:{key,recordId,project,turnIndex,hitType,hitKey,verdict,note,by,at}}}，key=recordId|turnIndex|hitType|hitKey。
const RETRIEVAL_MARKS_FILE = path.join(DATA_DIR, 'retrieval-marks.json');
function readRetrievalMarks() { try { const j = JSON.parse(fs.readFileSync(RETRIEVAL_MARKS_FILE, 'utf8')); return (j && j.marks && typeof j.marks === 'object') ? j.marks : {}; } catch { return {}; } }
function writeRetrievalMarks(marks) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(RETRIEVAL_MARKS_FILE, JSON.stringify({ marks })); } catch {} }
const RETRIEVAL_VERDICTS = new Set(['ok', 'offtopic', 'missing', 'should_hit_missed']);   // 对 / 跑题 / 缺失 / 该命中没命中
const RETRIEVAL_HIT_TYPES = new Set(['spec', 'kb', 'code']);
function retrievalMarkKey(recordId, turnIndex, hitType, hitKey) { return `${recordId}|${turnIndex}|${hitType}|${hitKey}`; }
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
    const body = { model, max_tokens: maxTokens, ...anthropicThinkingOverride(cfg, model, base), ...(system ? { system } : {}), messages: mm };
    const r = await fetch(base + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body) });
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
const MODEL_STREAM_FIRST_TOKEN_TIMEOUT_MS = 25000;
const MODEL_STREAM_CANDIDATE_TIMEOUT_MS = 60000;
const CONSULT_MODEL_ROUND_TIMEOUT_MS = 90000;
const CONSULT_DRAFT_MAX_TOKENS = 1500;
const CONSULT_DEEP_DRAFT_MAX_TOKENS = 1800;

// 阿里云 Qwen 3.8 的 Anthropic 兼容端点默认会把有限 max_tokens 全部用于
// thinking 块，导致没有可显示 text。仅对这组三项共同命中的候选禁用 thinking；
// Claude、其它 Anthropic 端点和 OpenAI 兼容请求保持原样。
function anthropicThinkingOverride(cfg, model, baseUrl) {
  if (String((cfg && cfg.provider) || 'anthropic').trim().toLowerCase() !== 'anthropic') return {};
  if (!/^qwen3\.8(?:[-_.]|$)/i.test(String(model || '').trim())) return {};
  let host = '';
  try { host = new URL(String(baseUrl || '')).hostname.toLowerCase(); } catch { return {}; }
  if (host !== 'aliyuncs.com' && !host.endsWith('.aliyuncs.com')) return {};
  return { thinking: { type: 'disabled' } };
}

// 流式：主/备按序 failover——只在"还没吐出任何内容、且非用户主动停止"时才切备用（避免重复输出）。
// 候选数量有硬上限；consult 会另外给草稿+修订共用一个整轮 deadline，避免两个阶段分别叠加完整 failover 预算。
async function callModelStream(cfg, opts, onDelta, signal) {
  const cands = modelCandidates(cfg).slice(0, 2); if (!cands.length) throw new Error('未配置 API Key');
  const onAttempt = opts && typeof opts.onAttempt === 'function' ? opts.onAttempt : null;
  let lastErr;
  for (let i = 0; i < cands.length; i++) {
    let got = false;
    try {
      if (onAttempt) onAttempt({ attempt: i + 1, total: cands.length });
      const result = await callModelStreamOnce(cands[i], opts, p => {
        if (String(p == null ? '' : p).trim()) got = true;
        if (onDelta) onDelta(p);
      }, signal);
      // 某些 OpenAI 兼容端点会以 HTTP/SSE 正常结束，但 choices.delta.content
      // 始终为空。它不是一次成功回答；在尚无可见正文时应像首 token 前失败一样
      // 切备用模型，所有候选都空时抛错交上层输出明确降级文案，绝不能发布空气泡。
      if (!got && !String(result == null ? '' : result).trim()) {
        const error = new Error('模型返回空内容');
        error.code = 'MODEL_EMPTY_RESPONSE';
        throw error;
      }
      return result;
    }
    catch (e) { lastErr = e; if ((signal && signal.aborted) || got) throw e; if (i < cands.length - 1) console.warn('[model-stream] 第' + (i + 1) + '个模型失败，切下一个：', String((e && e.message) || e)); }
  }
  throw lastErr;
}
// 单次流式调用某一个模型，逐段回调 onDelta，返回完整文本。signal 支持中止；
// “首个有效文本”和“候选完整生成”分别计时，避免上游连接已建立但长期零 token 占满整个候选预算。
async function callModelStreamOnce(cfg, { system, messages, maxTokens = 1024, images, firstTokenTimeoutMs = MODEL_STREAM_FIRST_TOKEN_TIMEOUT_MS, candidateTimeoutMs = MODEL_STREAM_CANDIDATE_TIMEOUT_MS }, onDelta, signal) {
  const provider = cfg.provider || 'anthropic';
  const key = cfg.apiKey; if (!key) throw new Error('未配置 API Key');
  const model = cfg.model || (provider === 'openai' ? 'gpt-4o' : 'claude-sonnet-4-6');
  const isA = provider === 'anthropic';
  const base = (cfg.baseUrl || (isA ? 'https://api.anthropic.com' : 'https://api.openai.com')).replace(/\/$/, '');
  const headers = isA ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'content-type': 'application/json', authorization: 'Bearer ' + key };
  const mm = withImages(messages, images, isA);   // 有图→末条 user 变多模态块（两家格式）；无图→原样字符串（向后兼容）
  const body = isA ? { model, max_tokens: maxTokens, stream: true, ...anthropicThinkingOverride(cfg, model, base), ...(system ? { system } : {}), messages: mm } : { model, stream: true, max_tokens: maxTokens, messages: system ? [{ role: 'system', content: system }, ...mm] : mm };
  const firstMs = Math.max(1, Number(firstTokenTimeoutMs) || MODEL_STREAM_FIRST_TOKEN_TIMEOUT_MS);
  const candidateMs = Math.max(firstMs, Number(candidateTimeoutMs) || MODEL_STREAM_CANDIDATE_TIMEOUT_MS);
  const firstAc = new AbortController(), candidateAc = new AbortController();
  let firstTimedOut = false, candidateTimedOut = false, gotFirstToken = false;
  const firstTimer = setTimeout(() => { firstTimedOut = true; firstAc.abort(); }, firstMs);
  const candidateTimer = setTimeout(() => { candidateTimedOut = true; candidateAc.abort(); }, candidateMs);
  if (firstTimer && typeof firstTimer.unref === 'function') firstTimer.unref();
  if (candidateTimer && typeof candidateTimer.unref === 'function') candidateTimer.unref();
  const sig = signal ? AbortSignal.any([signal, firstAc.signal, candidateAc.signal]) : AbortSignal.any([firstAc.signal, candidateAc.signal]);
  try {
    const r = await fetch(base + (isA ? '/v1/messages' : '/v1/chat/completions'), { method: 'POST', headers, body: JSON.stringify(body), signal: sig });
    if (!r.ok || !r.body) {
      let e = ''; try { e = ((await r.json()).error || {}).message || ''; } catch {}
      const error = new Error(e || ('HTTP ' + r.status));
      if (Number.isInteger(r.status)) { error.status = r.status; error.code = `MODEL_HTTP_${r.status}`; }
      throw error;
    }
    let full = '', buf = '', stopReason = ''; const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (!data || data === '[DONE]') continue;
        let j; try { j = JSON.parse(data); } catch { continue; }
        let piece = '';
        if (isA) {
          if (j.type === 'content_block_delta' && j.delta && typeof j.delta.text === 'string') piece = j.delta.text;
          if (j.type === 'message_delta' && j.delta && j.delta.stop_reason) stopReason = String(j.delta.stop_reason);
        } else {
          const choice = ((j.choices || [])[0] || {});
          piece = (choice.delta || {}).content || '';
          if (choice.finish_reason) stopReason = String(choice.finish_reason);
        }
        if (piece) {
          if (!gotFirstToken) { gotFirstToken = true; clearTimeout(firstTimer); }
          full += piece; if (onDelta) onDelta(piece);
        }
      }
    }
    if (/^(?:max_tokens|length)$/i.test(stopReason)) {
      const error = new Error('模型输出达到长度上限，未完整结束');
      error.code = 'MODEL_OUTPUT_TRUNCATED';
      throw error;
    }
    return full;
  } catch (error) {
    if (signal && signal.aborted) throw error;   // 用户停止/连接关闭优先，不改写成模型超时。
    if (firstTimedOut && !gotFirstToken) {
      const timeout = new Error('模型首字等待超时');
      timeout.code = 'MODEL_FIRST_TOKEN_TIMEOUT';
      throw timeout;
    }
    if (candidateTimedOut) {
      const timeout = new Error('模型候选生成超时');
      timeout.code = 'MODEL_CANDIDATE_TIMEOUT';
      throw timeout;
    }
    throw error;
  } finally {
    clearTimeout(firstTimer); clearTimeout(candidateTimer);
  }
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
// 把某客户(cust)某产品(productId)某子系统(subsystem)现场版本原地写成 newVer（发布闭环·验证通过后系统回写）。
//   两形状（与 custSubVersion/customer-version 一致）：
//     · 新形状 products[].subsystems[name==subsystem].version：写对应子系统；subsystem 不存在则**不新增、跳过**（避免臆造台账没登记的子系统）。
//     · 旧形状 products[].version（无 subsystems）：写产品级 version（subsystem 忽略）。
//   subsystem 为空 = **整包升级**：新形状把该产品**所有已登记子系统**都更到 newVer；旧形状写 pr.version。
//   幂等：目标值已等于 newVer 的项不重复写。找不到产品/子系统 → 跳过该项，不报错。
//   返回 { changed:boolean, bumped:[{subsystem, fromVer, toVer}] }（bumped=本次真的改了的项，供留痕；未改则空）。
//   ⚠️ 纯函数：只改传入的 cust 对象，不落盘（调用方负责 saveCustomers），无副作用于其它客户。
function bumpCustomerVersion(cust, productId, subsystem, newVer) {
    const out = { changed: false, bumped: [] };
    const ver = String(newVer == null ? '' : newVer).trim();
    if (!cust || !Array.isArray(cust.products) || !ver) return out;
    const pr = cust.products.find(p => p && p.project === productId);
    if (!pr) return out;                                              // 产品不属该客户 → 跳过
    const vNew = ver.slice(0, 30);                                    // 对齐 customer-version 的 30 位截断
    const sub = String(subsystem == null ? '' : subsystem).trim();
    if (Array.isArray(pr.subsystems)) {
        // 新形状：subsystem 指定 → 只更该子系统（不存在则跳过）；空 → 整包（所有已登记子系统）
        const targets = sub ? pr.subsystems.filter(s => s && s.name === sub) : pr.subsystems.filter(Boolean);
        for (const ms of targets) {
            const fromVer = String(ms.version || '');
            if (fromVer !== vNew) { ms.version = vNew; out.changed = true; out.bumped.push({ subsystem: ms.name || '', fromVer, toVer: vNew }); }
        }
    } else {
        // 旧形状：产品级 version（subsystem 忽略，整产品一个版本）
        const fromVer = String(pr.version || '');
        if (fromVer !== vNew) { pr.version = vNew; out.changed = true; out.bumped.push({ subsystem: '', fromVer, toVer: vNew }); }
    }
    return out;
}

// ===== 批次（BP-01 第 1 期）：文件存 data/batches.json，与 customers 同范式（NH-4 已裁决 A=文件存不改库） =====
//   批次 = 一条产品线的一批（跨全部医院合并该产品「已立项(已落实)且未归批」工单，内部按 subsystem 分组）。
//   批次 → 工单：batches[].ticketIds（数组）；工单 → 批次：intake.data.batch（=工单对象顶层 e.batch，随 data JSON 落库，不加库列，复用 L1305 范式）。
//   本期只做：定档建批(batch-arrange) + 列表(batches) + 详情(batch-detail)；导清单/上传包/闭环留后续期。
const BATCHES_FILE = path.join(DATA_DIR, 'batches.json');
function loadBatches() { try { return JSON.parse(fs.readFileSync(BATCHES_FILE, 'utf8')).batches || []; } catch { return []; } }
function saveBatches(list) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(BATCHES_FILE, JSON.stringify({ batches: list }, null, 2)); } catch {} }
// 发布闭环·版本回写：某批次(bt)在某医院(site)的全部覆盖工单都「已关闭」时，把该医院该产品(bt.product)版本更到 bt.pkgVersion。
//   触发口径（现场逐单验证 pass 后 / 批次转已交付兜底）——只更**这批次实际覆盖到该 site 的子系统集合**（bt.ticketIds 里属该 site 的工单 subsystem），覆盖不到的子系统不动（宁少勿错）。
//   护栏：无 pkgVersion（没出包）→ 跳过；该 site 在该批次里非「全单已关闭」→ 跳过（还没验完不更）；医院/产品/子系统台账里找不到 → bumpCustomerVersion 内部跳过不报错；幂等（已是目标版本不重复写）。
//   数据：读 loadCustomers()，原地 bumpCustomerVersion，changed 才 saveCustomers；返回 { changed, bumped:[{subsystem,fromVer,toVer}] } 供批次 history 留痕。⚠️ 只回写该 site 对应医院，不碰别家。
function bumpSiteVersionForBatch(bt, proj, site) {
    const empty = { changed: false, bumped: [] };
    const pkg = String((bt && bt.pkgVersion) || '').trim();
    if (!pkg || pkg === '-') return empty;                                     // 未出包 → 不更
    if (!bt || !proj || !site) return empty;
    // 该 site 在该批次里的覆盖工单 + 是否全部已关闭
    const siteTickets = [];
    for (const tid of (bt.ticketIds || [])) {
        const e = loadIntake(proj, tid); if (!e) continue;
        if (String(e.site || '') !== String(site)) continue;
        siteTickets.push(e);
    }
    if (!siteTickets.length) return empty;                                     // 该医院不在本批覆盖内
    const allClosed = siteTickets.every(e => (e.lifecycle || deriveLifecycle(e)) === '已关闭');
    if (!allClosed) return empty;                                              // 该院这批单还没全过 → 不更
    // 本批次该 site 实际覆盖到的子系统集合（去重、去空）
    const subs = [...new Set(siteTickets.map(e => String(e.subsystem || '').trim()).filter(Boolean))];
    const list = loadCustomers();
    const c = list.find(x => (x.name || '').trim() === String(site).trim());
    if (!c) return empty;                                                      // 台账无该医院 → 跳过
    const bumped = [];
    if (subs.length) { for (const s of subs) { const r = bumpCustomerVersion(c, bt.product, s, pkg); if (r.changed) bumped.push(...r.bumped); } }
    else { const r = bumpCustomerVersion(c, bt.product, '', pkg); if (r.changed) bumped.push(...r.bumped); }   // 覆盖工单无子系统标注 → 整产品
    if (bumped.length) {
        c.versionLog = Array.isArray(c.versionLog) ? c.versionLog : [];
        const at = nowStamp();
        for (const b of bumped) { c.versionLog.push({ productId: bt.product, subsystem: b.subsystem || '', fromVer: b.fromVer, toVer: b.toVer, by: '系统·发布闭环', at, batch: bt.id }); }
        if (c.versionLog.length > 200) c.versionLog = c.versionLog.slice(-200);
        c.updatedAt = at;
        saveCustomers(list);
    }
    return { changed: bumped.length > 0, bumped };
}
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
// 功能模块地图包含完整目录/索引，真实 PWRS JSON 已超过 spawnSync 默认约 1 MiB 输出上限。
// 未显式放大 maxBuffer 时 git show 会 ENOBUFS，旧实现又静默退成空串，最终表现为
// retrieval.routing.enabled=false、所有 questionRoutes/answerFacts 在生产失效。
function gitOut(repoPath, args) { try { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoPath, encoding: 'utf8', timeout: 8000, maxBuffer: 32 * 1024 * 1024 }); return r.status === 0 ? (r.stdout || '') : ''; } catch { return ''; } }

// ===== 产品仓只读上下文：git tag 列表 + spec@tag =====
// 版本号倒序比较（复用，保证各处「按版本排序」口径一致：数字感知、倒序）
function verCmpDesc(a, b) { return String(b).localeCompare(String(a), undefined, { numeric: true }); }
// 默认分支优先级（越小越靠前）：main→master→develop/dev→release/*→其余字母序。用于 branches 排序把「主干」置顶。
function branchRank(b) { const s = String(b || ''); if (s === 'main') return 0; if (s === 'master') return 1; if (s === 'develop' || s === 'dev') return 2; if (/^release(\/|$)/.test(s)) return 3; return 9; }
function sortBranches(list) { return [...new Set((list || []).map(x => String(x || '').trim()).filter(Boolean))].sort((a, b) => { const ra = branchRank(a), rb = branchRank(b); return ra !== rb ? ra - rb : a.localeCompare(b, undefined, { numeric: true }); }); }
// PD-01：解析 `git ls-remote --heads --tags` 输出 → {branches:[…], tags:[…]}。
//   每行形如 `<sha>\trefs/heads/<X>` / `<sha>\trefs/tags/<Y>` / `<sha>\trefs/tags/<Y>^{}`（tag 解引用行）。
//   规则：剥离 refs/heads|refs/tags 前缀；**丢弃 `^{}` 解引用行**（否则版本号里混进 `v1.0^{}`）；tags 版本倒序、branches 默认分支置顶。
//   纯函数（不碰 git/网络/fs）→ 可脱库单测。
function parseGitRefs(lsRemoteOut) {
  const branches = new Set(), tags = new Set();
  for (const raw of String(lsRemoteOut || '').split('\n')) {
    const line = raw.trim(); if (!line) continue;
    const m = line.match(/^[0-9a-fA-F]+\s+(refs\/(?:heads|tags)\/.+)$/);
    const ref = m ? m[1] : line;   // 兼容只有 ref 无 sha 的行
    if (ref.startsWith('refs/heads/')) { const b = ref.slice('refs/heads/'.length).trim(); if (b) branches.add(b); }
    else if (ref.startsWith('refs/tags/')) { if (ref.endsWith('^{}')) continue; const t = ref.slice('refs/tags/'.length).trim(); if (t) tags.add(t); }
  }
  return { branches: sortBranches([...branches]), tags: [...tags].sort(verCmpDesc).slice(0, 500) };
}
// PD-01：归一化子系统所选 refs（branches/tags）——校验为字符串数组、trim、去空、去重、单元素 ≤200 字符、数组 ≤100。非数组→[]。
//   纯函数（可脱库单测）；project-save 落库前对 branches/tags 各调一次，防脏数据/超长写库。
function normRefList(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set(), out = [];
  for (const x of arr) {
    if (typeof x !== 'string' && typeof x !== 'number') continue;
    const v = String(x).trim().slice(0, 200);
    if (!v || seen.has(v)) continue;
    seen.add(v); out.push(v);
    if (out.length >= 100) break;
  }
  return out;
}
// PD-01：某子系统的「最终版本清单」——若该子系统有选（tags/branches 任一非空）用所选（tag 版本倒序在前 + branch 作滚动版本在后）；
//   否则回落旧行为（该仓全部 git tag，倒序）。**没选的子系统行为与改造前一模一样**（老产品不受影响）。
//   selTags/selBranches = 子系统对象上持久化的 s.tags / s.branches；allTags = 回落时读到的该仓全 tag（已倒序）。纯函数，可单测两分支。
function subsystemVersionList(selTags, selBranches, allTags) {
  const st = Array.isArray(selTags) ? selTags.map(x => String(x || '').trim()).filter(Boolean) : [];
  const sb = Array.isArray(selBranches) ? selBranches.map(x => String(x || '').trim()).filter(Boolean) : [];
  if (st.length || sb.length) {
    const tags = [...new Set(st)].sort(verCmpDesc);         // 选中的 tag，版本倒序在前
    const branches = sortBranches(sb);                      // 选中的分支，作「滚动版本」在后（版本字符串=分支名）
    return [...tags, ...branches.filter(b => !tags.includes(b))].slice(0, 200);
  }
  return [...(allTags || [])].slice(0, 200);                // 未选 → 回落：该仓全 tag（倒序，调用方保证）
}
function listVersions(proj) {   // 产品版本候选 = 各子系统「最终版本清单」的并集（选中优先、未选回落全 tag，按版本倒序）
  const set = new Set();
  ((proj && proj.subsystems) || []).forEach(s => {
    if (typeof s === 'string') return;   // 顶层裸字符串子系统无仓/无选，跳（并集靠下方顶层单仓兜底）
    let allTags = [];
    if (s && s.repoPath && fs.existsSync(s.repoPath)) { try { allTags = gitOut(s.repoPath, ['tag', '-l', '--sort=-v:refname']).split('\n').map(t => t.trim()).filter(Boolean); } catch {} }
    subsystemVersionList(s && s.tags, s && s.branches, allTags).forEach(v => set.add(v));
  });
  if (proj && proj.repoPath && fs.existsSync(proj.repoPath)) { try { gitOut(proj.repoPath, ['tag', '-l', '--sort=-v:refname']).split('\n').forEach(t => { t = t.trim(); if (t) set.add(t); }); } catch {} }   // 兼容顶层单仓（无选字段，回落全 tag）
  return [...set].sort(verCmpDesc).slice(0, 200);
}
// 每个子系统仓各自的版本清单（各子系统 git 地址/tag 不同 → 各显各的，别用产品级并集）。返回 { 子系统name: [版本倒序] }。
//   PD-01：有选（s.tags/s.branches）→ 用所选（tag 在前、branch 滚动版本在后）；未选 → 回落该仓全 git tag。老产品不受影响。
function versionsBySubsystem(proj) {
  const out = {};
  ((proj && proj.subsystems) || []).forEach(s => {
    const name = (typeof s === 'string') ? s : (s && s.name);
    const rp = (typeof s === 'string') ? '' : (s && s.repoPath);
    if (!name) return;
    let allTags = [];
    if (rp && fs.existsSync(rp)) { try { allTags = gitOut(rp, ['tag', '-l', '--sort=-v:refname']).split('\n').map(t => t.trim()).filter(Boolean); } catch {} }
    out[name] = subsystemVersionList((typeof s === 'string') ? null : s.tags, (typeof s === 'string') ? null : s.branches, allTags);
  });
  return out;
}
// PD-01：用 `git ls-remote --heads --tags <authUrl>` 列某仓远端 refs（只读，不 clone；快）。token 注入同 cloneRepo。
//   失败/超时/未配 token → 返回 {branches:[],tags:[],error} 而非抛异常，让端点逐仓兜底、整体不 500。
function lsRemoteRefs(repoUrl) {
  const c = readGitCfg();
  if (!repoUrl) return { branches: [], tags: [], error: '缺少仓库地址' };
  if (!c.token) return { branches: [], tags: [], error: '未配置 Git token' };
  const authUrl = authGitUrl(repoUrl, c);   // provider 化 token 注入（同 cloneRepo，别各写各的）
  try {
    const r = spawnSync('git', ['ls-remote', '--heads', '--tags', authUrl], { encoding: 'utf8', timeout: 20000 });
    if (r.status !== 0) { const msg = String((r.stderr || '') || (r.error && r.error.message) || '').replace(/oauth2:[^@]*@/g, 'oauth2:***@').trim().slice(0, 200); return { branches: [], tags: [], error: msg || ('ls-remote 失败（状态 ' + r.status + '）') }; }
    return parseGitRefs(r.stdout || '');
  } catch (e) { return { branches: [], tags: [], error: String((e && e.message) || e).replace(/oauth2:[^@]*@/g, 'oauth2:***@').slice(0, 200) }; }
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
function specEntries(proj, ver) {   // 完整目录：不再按每仓前 30 份/全局 90 份截断；目录只用于路由与导航，不作事实证据
  return loadSpecTexts(proj, ver).map(s => ({ file: s.file, id: s.id, subsystem: s.subsystem, module: s.module, title: s.title, headings: s.headings, identifiers: s.identifiers }));
}
function specIndex(proj, ver) { return specEntries(proj, ver).map(e => `[${e.subsystem ? e.subsystem + '·' : ''}${e.module}] ${e.title}`).join('\n'); }
function specModules(proj, ver) { const set = new Set(); for (const e of specEntries(proj, ver)) if (e.module) set.add((e.subsystem ? e.subsystem + '/' : '') + e.module); return [...set]; }
// 答疑召回：把 spec 正文读进来（缓存 10 分钟，避免每条消息都重读几十份仓文件），再按问题检索最相关的几份
const SPEC_TEXT_CACHE = new Map();   // projId@ref -> { at, specs:[buildSpecDocument 结果] }
function loadSpecTexts(proj, ver) {
  const ref = safeRef(ver), key = proj.id + '@' + ref, now = Date.now();
  const c = SPEC_TEXT_CACHE.get(key); if (c && now - c.at < 600000) return c.specs;
  const specs = [];
  for (const src of specSources(proj)) {
    if (src.repoPath && fs.existsSync(src.repoPath)) {
      for (const f of specFilesAt(src.repoPath, ref)) {
        const full = specFileText(src.repoPath, ref, f); if (!full) continue;
        specs.push(buildSpecDocument({ file: f, subsystem: src.sub, text: full }));
      }
    } else if (src.specsPath) {
      try { for (const f of fs.readdirSync(src.specsPath)) { if (!f.endsWith('.md') || f.startsWith('_') || f.toLowerCase() === 'readme.md') continue; const full = fs.readFileSync(path.join(src.specsPath, f), 'utf8'); specs.push(buildSpecDocument({ file: path.join(src.specsPath, f), subsystem: src.sub, text: full })); } } catch {}
    }
  }
  SPEC_TEXT_CACHE.set(key, { at: now, specs });
  return specs;
}
function specSearch(proj, ver, query, n = 5, subKey = '') {   // 真两阶段：完整目录路由候选文件 → 仅候选正文检索 TopN
  return specSearchScored(proj, ver, query, n, subKey).map(({ score, matchedTerms, ...hit }) => hit);
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

// PD-03（检索诊断）+ FS-04：带分结果与普通召回共用同一套真两阶段实现，防两个入口的排序口径漂移。
function specSearchScored(proj, ver, query, n = 5, subKey = '') {
  const result = searchSpecDocuments(loadSpecTexts(proj, ver), query, { n, subKey, maxCandidates: 12 });
  return result.hits.map(h => ({
    file: h.file, id: h.id, subsystem: h.subsystem, module: h.module, title: h.title,
    heading: h.heading, text: h.text, evidence: 'body',
    score: Math.round((h.relevanceScore ?? h.score) * 1000) / 1000,
    matchedTerms: (h.matchedTerms || []).slice(0, 12),
  }));
}

// ===== PD-04：答疑「先路由到功能模块、命中才检索」（纯代码打分 + 阈值·确定性；仅对有「功能模块地图」的产品生效，无地图产品保持原 specSearch 行为不变） =====
// 阈值常量（部署后在 pwrs 上用回放调准）：路由最高分 ≥ 阈值 → 命中；否则 miss。
const ROUTE_MATCH_MIN = 3.0;        // tier-1 questionRoutes / tier-2 specs 命中阈值（IDF 加权重叠得分）
const ROUTE_ALIAS_BONUS = 6.0;      // query 整串命中某 alias 子串 → 强 bonus（别名是人工整理的高判别短语）
const ROUTE_EXACT_TITLE_MIN_RATIO = 0.5; // 完整标题候选至少达到最高相关分的一半，才允许强制切题；防通用短标题压过高分专用业务路由
const ROUTE_EXACT_TIER3 = 8.0;      // tier-3 精确名（config/table/api）命中 → 直接强命中（远超阈值）
// PD-04 修复：specSearch 始终作底座，路由作「精选事实」加成——路由未命中时，只要 specSearch 首条 IDF 得分 ≥ 本阈值，
//   仍把 specSearch 强匹配喂给模型（由提示词的功能级覆盖判定决定答/说没覆盖），只有 specSearch 也弱/空才走 miss 固定话术。
//   保守初值 8（specSearchScored 的 score = IDF 加权重叠得分，强相关章节通常十几到几十）；部署后在 pwrs 回放调准。
const SPEC_MIN_RELEVANT = 8.0;
const MAP_TEXT_CACHE = new Map();   // projId@ref -> { at, map|null, repoPath }（同 loadSpecTexts 10min 缓存）
const MAP_REL = 'docs/specs/00-功能模块地图.json';
// 读产品仓的功能模块地图；解析失败/不存在 → null（该产品即走原 specSearch，向后兼容）。
function loadModuleMap(proj, ver) {
  const ref = safeRef(ver), key = (proj && proj.id) + '@' + ref, now = Date.now();
  const c = MAP_TEXT_CACHE.get(key); if (c && now - c.at < 600000) return c.map;
  let map = null, repoPath = '';
  for (const src of specSources(proj)) {
    if (!src.repoPath) continue;
    const txt = specFileText(src.repoPath, ref, MAP_REL);   // 走现有 git/工作树读法（带 ref 走 git show，否则读工作树）
    if (!txt || !txt.trim()) continue;
    try { const j = JSON.parse(txt); if (j && (Array.isArray(j.questionRoutes) || Array.isArray(j.specs))) { map = j; repoPath = src.repoPath; break; } } catch {}
  }
  MAP_TEXT_CACHE.set(key, { at: now, map, repoPath });
  return map;
}
// 找出装地图的那个仓（读被引 spec 文件用它的 repoPath；缓存里已记）
function moduleMapRepo(proj, ver) { const ref = safeRef(ver), c = MAP_TEXT_CACHE.get((proj && proj.id) + '@' + ref); return (c && c.repoPath) || ''; }
// IDF 加权重叠打分：query 分词 vs 目标文本分词，稀有词权重高、压通用词（复用 kbTokenize + specSearch 的 IDF 思路）。
//   df 由「本次候选集合」内每词的文档频率算（候选=所有 route 的 searchText / 所有 spec 的索引文本）。
function routeScorer(candTexts) {
  const tsets = candTexts.map(t => new Set(kbTokenize(t)));
  const df = {}; for (const s of tsets) for (const t of s) df[t] = (df[t] || 0) + 1;
  const N = tsets.length || 1;
  const idf = t => Math.log((N + 1) / ((df[t] || 0) + 0.5));   // 稀有词高权重
  return (qset, i) => { let sc = 0; for (const t of qset) if (tsets[i].has(t)) sc += idf(t); return sc; };
}
// 路由匹配（纯代码打分 + 阈值·确定性，不调 AI）：tier-3 精确反查 > tier-1 questionRoutes > tier-2 specs 兜底。
function consultExplicitOperationContracts(question) {
  const source = String(question || '').trim();
  if (!source) return [];
  const action = '发起|撤销|取消|退回|提交|删除|新增|创建|审批|签名|补发|重放|重提|重试|失败|状态';
  const genericEntity = /^(?:怎么|如何|失败|成功|状态|问题|处理|操作|业务|流程|功能|请求|响应|接口|页面|消息|任务|发起|撤销|取消|提交|重试)$/u;
  const normalizeEntity = value => String(value || '')
    .replace(/^(?:(?:现场|当前|这个|该|本次|这次|页面|系统|提示|提醒|出现|发生))+/u, '')
    .replace(/^(?:只有|仅|只|和|与|或|及)+/u, '')
    .trim();
  const contracts = [];
  const add = (entityValue, actionValue, actionIndex) => {
    if (actionValue === '状态' && source.slice(actionIndex + actionValue.length, actionIndex + actionValue.length + 1) === '机') return;
    const beforeAction = source.slice(Math.max(0, actionIndex - 36), actionIndex);
    if (/(?:不能|不得|不要|禁止|不应)[^。！？；;\n]{0,32}$/u.test(beforeAction)) return;
    const entity = normalizeEntity(entityValue);
    if (entity.length < 2 || entity.length > 10 || genericEntity.test(entity)) return;
    const key = `${entity}|${actionValue}`;
    if (!contracts.some(item => item.key === key)) contracts.push({ key, entity, action: actionValue });
  };
  // “某业务发起失败”同时表达“发起”与“失败”。普通全局 match 会先消费
  // “业务发起”，从而漏掉同一实体的失败结果；显式补抓连续动作，避免
  // 半成功/失败类问法只能靠“状态、HIS”等泛词路由。
  for (const match of source.matchAll(new RegExp(`([\\p{Script=Han}]{2,10}?)(${action})(${action})`, 'gu'))) {
    add(match[1], match[2], match.index + match[1].length);
    add(match[1], match[3], match.index + match[1].length + match[2].length);
  }
  for (const match of source.matchAll(new RegExp(`([\\p{Script=Han}]{2,10}?)(${action})`, 'gu'))) add(match[1], match[2], match.index + match[1].length);
  for (const match of source.matchAll(new RegExp(`(${action})([\\p{Script=Han}]{2,10}?)`, 'gu'))) add(match[2], match[1], match.index);
  return contracts;
}

function routeHasDirectOperationEvidence(routeCard, contracts) {
  if (!contracts.length) return true;
  const lines = [routeCard && routeCard.title, ...((routeCard && routeCard.aliases) || []), ...((routeCard && routeCard.keywords) || []), ...((routeCard && routeCard.answerFacts) || [])]
    .flatMap(value => String(value || '').split(/[。！？；;\n]/u)).map(value => value.trim()).filter(Boolean);
  const positiveLine = (line, contract) => {
    if (!line.includes(contract.entity) || !line.includes(contract.action)) return false;
    const entityIndex = line.indexOf(contract.entity);
    const actionIndex = line.indexOf(contract.action);
    const start = Math.max(0, Math.min(entityIndex, actionIndex) - 18);
    const end = Math.min(line.length, Math.max(entityIndex + contract.entity.length, actionIndex + contract.action.length) + 18);
    const windowText = line.slice(start, end);
    return !/(?:没有|无|未覆盖|未定义|不包含|不保存|不支持|不能|不得|不是|不属于|不等于|不能外推|不得外推)/u.test(windowText);
  };
  return contracts.some(contract => lines.some(line => positiveLine(line, contract)));
}

function consultOperationEvidenceStopReply() {
  return [
    '当前没有命中该业务操作的直接证据，不能安全确认具体原因、操作入口、顺序或状态条件。',
    '本轮只读保留现有页面提示、同一次已有请求与响应、当前业务状态、发生时间、账号和院区；没有取得的项目明确标为未知。',
    '为避免误操作，本轮不得发起；不得撤销；不得提交；不得重试；不得修改业务状态。',
    '请将上述已有材料交对应业务或接口负责人核对正式说明与授权边界，再决定后续处理。',
  ].join('\n\n');
}

function routeQuestion(map, query, subKey = '') {
  const q = String(query || '');
  const qLower = q.toLowerCase();
  const qset = new Set(kbTokenize(q));
  const routes = Array.isArray(map && map.questionRoutes) ? map.questionRoutes : [];
  const specs = Array.isArray(map && map.specs) ? map.specs : [];
  const operationContracts = consultExplicitOperationContracts(q);
  const miss = (extra = {}) => ({ matched: false, tier: 0, score: 0, topN: [], ...extra });
  if (!qset.size) return miss();

  // —— Tier-1（优先）：questionRoutes 打分（searchText IDF 重叠 + 别名整串命中强 bonus）——
  //    ⚠️ tier-1 先跑：questionRoute 命中即带出人工整理的 answerFacts/mustNotConfuse（高价值），
  //       tier-3 精确反查只作 tier-1 未过阈值时的兜底增强（否则「order_instruction 怎么配」会被 tier-3 抢走、丢掉 answerFacts）。
  if (routes.length) {
    const scoreAt = routeScorer(routes.map(r => String((r && r.searchText) || [(r && r.title), ...((r && r.aliases) || []), ...((r && r.keywords) || [])].filter(Boolean).join(' '))));
    let best = null;
    const scored = routes.map((r, i) => {
      const directOperationEvidence = routeHasDirectOperationEvidence(r, operationContracts);
      let sc = scoreAt(qset, i);
      // 别名整串命中：query 含某 alias 作为子串（或 alias 含 query）→ 强 bonus（别名是人工短语，判别性高）
      let aliasHit = false;
      for (const a of ((r && r.aliases) || [])) { const al = String(a || '').toLowerCase().trim(); if (al.length >= 3 && (qLower.includes(al) || (al.length >= 4 && al.includes(qLower) && qLower.length >= 4))) { aliasHit = true; break; } }
      if (aliasHit) sc += ROUTE_ALIAS_BONUS;
      if (!directOperationEvidence) sc = 0;
      return { r, sc: Math.round(sc * 1000) / 1000, aliasHit, directOperationEvidence };
    }).sort((a, b) => {
      // QR 是面向确定事实的人工路由，DQ 是宽泛排查卡。同一问法下 DQ 的通用词较多，
      // 可能以很小分差压过已强命中实体的 QR（如“我的监护列表/详情路径”）。
      // 当两者分差在 15% 内时优先 QR；差距明显时仍尊重原始相关性，避免硬抢无关问题。
      const aQr = String(a.r && a.r.id || '').startsWith('QR-'), bQr = String(b.r && b.r.id || '').startsWith('QR-');
      if (aQr !== bQr) {
        const high = Math.max(a.sc, b.sc), low = Math.min(a.sc, b.sc);
        if (high > 0 && low >= high * 0.85) return aQr ? -1 : 1;
      }
      return b.sc - a.sc;
    });
    // 当前问句完整出现唯一人工 route title 时，它比宽泛 searchText 的词频分
    // 更能表达用户显式切题（如“处方标记”vs FAQ/“医嘱标记”）。必须完整
    // title 命中且只能命中一个；部分词、多 title 比较题均不强制。
    const exactTitleHits = scored.filter(item => item.directOperationEvidence && (() => {
      const title = String(item.r && item.r.title || '').toLowerCase().trim();
      return title.length >= 4 && qLower.includes(title);
    })());
    const exactTitle = exactTitleHits.length === 1 ? exactTitleHits[0] : null;
    // 完整标题仍是强显式实体，但像“待审工作台”这类通用短标题可能只是专用问题的场景前缀。
    // 当另一路由的真实相关分超过标题候选两倍时，尊重专用高分路由，避免低分标题无条件抢占。
    const scoreLeader = scored[0] || null;
    const exactTitleText = String(exactTitle && exactTitle.r && exactTitle.r.title || '').trim();
    const genericExactTitleRe = /^(?:待审工作台|工作台|业务工作台|列表|详情|首页|主页|设置|个人设置|系统设置)$/u;
    const specificExactTitle = exactTitle
      // 四字业务标题同样可以是稳定的模块实体（如“处方标记”与相邻
      // “医嘱标记”）。若完整标题已逐字出现在问句中，不能因相邻 route
      // 恰好有一条更长的链路别名就把 current route 切过去；真正宽泛的
      // 四字标题仍由下方 genericExactTitleRe 排除。
      && Array.from(exactTitleText).length >= 4
      && !genericExactTitleRe.test(exactTitleText);
    // 通用短标题若直接充当“从入口/接口/数据到外部依赖”的链路主语，
    // 仍是明确切题，而不是专用问题的场景前缀。只检查标题后的紧邻语法，
    // 中间插入“批量通过/重试”等其它业务实体时不会命中，仍交给高分专用 route。
    const exactTitleChainSubject = exactTitle && (() => {
      const title = exactTitleText.toLowerCase();
      const titleIndex = qLower.indexOf(title);
      if (titleIndex < 0) return false;
      const afterTitle = qLower.slice(titleIndex + title.length)
        .replace(/^[“”"'‘’：:，,；;\s]+/u, '');
      return /^从[^。！？\n]{0,64}(?:入口|接口|数据)[^。！？\n]{0,64}外部依赖[^。！？\n]{0,40}(?:链路|串起来)/u.test(afterTitle);
    })();
    // “关于<完整模块标题>，当前只有既有页面/请求/响应，现有证据最多能
    // 判断到哪”同样把标题作为直接主语。这里使用封闭的证据材料词表并锚定
    // 整个后缀；一旦夹入 Dify、生成记录、批量重试等专用业务实体就不会
    // 命中，仍由对应高分专用 route 接管。
    const exactTitlePartialEvidenceSubject = exactTitle && (() => {
      const title = exactTitleText.toLowerCase();
      const titleIndex = qLower.indexOf(title);
      if (titleIndex < 0) return false;
      const afterTitle = qLower.slice(titleIndex + title.length)
        .replace(/^[“”"'‘’：:，,；;\s]+/u, '');
      return /^(?:(?:我|我们|当前|现在|目前|现场|这边|本轮|这次)\s*){0,3}(?:只有|仅有|只拿到|仅拿到|只能看到|只能确认)\s*(?:一(?:次|份|条|张)\s*)?(?:(?:既有|已有|当前|现有)\s*)?(?:(?:页面|截图|请求|响应|记录|日志|requestid)\s*(?:和|与|、|及)?\s*){1,4}[，,；;。\s]*(?:(?:(?:暂时|当前)?\s*(?:没有|无|拿不到|无法(?:查看|查询|读取|访问)?))\s*(?:数据库|日志|源码|后台)(?:的)?(?:权限|查看权限|查询权限|读取权限|访问权限)[，,；;。\s]*)?(?:这些|现有|当前|已有)?\s*证据\s*(?:最多)?\s*(?:能|可以)?\s*(?:判断|确认|排除)\s*(?:到哪(?:一层|一步)?|哪些|什么|到什么范围)[？?。\s]*$/u.test(afterTitle);
    })();
    const acceptedExactTitle = exactTitle && (specificExactTitle
      || exactTitleChainSubject
      || exactTitlePartialEvidenceSubject
      || !scoreLeader
      || exactTitle === scoreLeader
      || exactTitle.sc >= scoreLeader.sc * ROUTE_EXACT_TITLE_MIN_RATIO)
      ? exactTitle : null;
    if (acceptedExactTitle) {
      const at = scored.indexOf(acceptedExactTitle);
      if (at > 0) scored.splice(at, 1);
      if (at !== 0) scored.unshift(acceptedExactTitle);
    }
    best = scored[0];
    if (best && best.directOperationEvidence && (acceptedExactTitle || best.sc >= ROUTE_MATCH_MIN)) {
      const r = best.r;
      const fallbackMode = r.fallbackMode === 'verifiedFacts' ? 'verifiedFacts' : '';
      // 技术焦点只能由人工 route 卡显式声明；不要从 query、answerFacts
      // 或 mustNotConfuse 推断，否则单字段题会把 sibling 字段带进放行范围。
      const focusTechnicalTokens = Array.from(new Set(
        (Array.isArray(r.focusTechnicalTokens) ? r.focusTechnicalTokens : [])
          .filter(token => typeof token === 'string')
          .map(token => token.trim())
          .filter(Boolean),
      ));
      return {
        matched: true, tier: 1, fallbackMode, route: {
          id: r.id,
          title: r.title,
          // 仅透传服务端认识的路由发布策略，不能把整张可变地图卡片直接带入运行态。
          fallbackMode,
        }, score: best.sc,
        exactRouteTitle: !!acceptedExactTitle,
        primaryRefs: Array.isArray(r.primaryRefs) ? r.primaryRefs : [],
        contextRefs: Array.isArray(r.contextRefs) ? r.contextRefs : [],
        answerFacts: Array.isArray(r.answerFacts) ? r.answerFacts : [],
        mustNotConfuse: Array.isArray(r.mustNotConfuse) ? r.mustNotConfuse : [],
        focusTechnicalTokens,
        topN: scored.slice(0, 5).map(x => ({ id: x.r.id, title: x.r.title, score: x.sc })),
      };
    }
    // tier-1 未过阈值 → 记 topN 供诊断，继续 tier-3/tier-2 兜底
    var tier1TopN = scored.slice(0, 5).map(x => ({ id: x.r.id, title: x.r.title, score: x.sc }));
    if (operationContracts.length) {
      return miss({
        explicitOperationEvidenceMiss: operationContracts.map(({ entity, action }) => ({ entity, action })),
        topN: tier1TopN,
      });
    }
  }

  // —— Tier-3（兜底增强）：tier-1 没过阈值时，query 里若出现 indexes 精确名（config key / table 名 / api 路径）→ 强命中所属 spec ——
  const idx = (map && map.indexes) || {};
  const tier3Hits = [];   // {name,specIds[],kind,needle}
  const scanExact = (arr, nameField, kind) => {
    for (const it of (Array.isArray(arr) ? arr : [])) {
      const name = String((it && it[nameField]) || '').trim(); if (name.length < 3) continue;   // 太短的名（如单字段）不做精确路由，避免误命中
      const nLower = name.toLowerCase();
      const needle = kind === 'api' ? (nLower.split(/\s+/).pop() || nLower) : nLower;   // api 形如 "GET /api/xxx"：取路径段做子串判定
      if (needle.length >= 4 && qLower.includes(needle)) {
        const specIds = kind === 'api' ? [it.specId].filter(Boolean) : (Array.isArray(it.specs) ? it.specs : []);
        tier3Hits.push({ name, specIds, kind, needle });
      }
    }
  };
  scanExact(idx.configs, 'key', 'config');
  scanExact(idx.tables, 'table', 'table');
  scanExact(idx.apis, 'api', 'api');
  if (tier3Hits.length) {
    tier3Hits.sort((a, b) => b.needle.length - a.needle.length);   // 取「最长精确名」命中（最具体）
    const hit = tier3Hits[0];
    const specRefs = hit.specIds.map(id => specs.find(s => s && s.id === id)).filter(Boolean)
      .map(s => ({ specId: s.id, section: '', title: s.title, path: s.path, anchor: '' }));
    if (specRefs.length) return { matched: true, tier: 3, score: ROUTE_EXACT_TIER3, exactName: hit.name, specRefs, topN: specRefs.slice(0, 5).map(r => ({ id: r.specId, title: r.title, score: ROUTE_EXACT_TIER3 })) };
  }

  // —— Tier-2：specs 兜底（title + module + summary + headings 打分）——
  if (specs.length) {
    let pool = specs;
    if (subKey) { const sc = specs.filter(s => (s.module || s.domain || '') === subKey || (s.subsystem || '') === subKey); if (sc.length) pool = sc; }
    const specText = s => [s.title, s.module, s.domain, s.summary, ...((s.headings || []).map(h => h.title))].filter(Boolean).join(' ');
    const scoreAt = routeScorer(pool.map(specText));
    const scored = pool.map((s, i) => ({ s, sc: Math.round(scoreAt(qset, i) * 1000) / 1000 })).sort((a, b) => b.sc - a.sc);
    const best = scored[0];
    if (best && best.sc >= ROUTE_MATCH_MIN) {
      const s = best.s;
      return {
        matched: true, tier: 2, score: best.sc,
        specRefs: [{ specId: s.id, section: '', title: s.title, path: s.path, anchor: '' }],
        topN: scored.slice(0, 5).map(x => ({ id: x.s.id, title: x.s.title, score: x.sc })),
      };
    }
    return { matched: false, tier: 0, score: (best && best.sc) || 0, topN: (typeof tier1TopN !== 'undefined' && tier1TopN.length) ? tier1TopN : scored.slice(0, 5).map(x => ({ id: x.s.id, title: x.s.title, score: x.sc })) };
  }
  return { matched: false, tier: 0, score: (typeof tier1TopN !== 'undefined' ? (tier1TopN[0] && tier1TopN[0].score) : 0) || 0, topN: (typeof tier1TopN !== 'undefined') ? tier1TopN : [] };
}

// 承接型短追问允许复用上一轮已经命中的功能 route，但只复用地图里的 route/facts：
// 不读取、也不把上一条模型自由文本当证据。当前轮若明确切到另一个业务实体，当前 route 始终优先。
function consultContextFollowupIntent(question) {
  const q = String(question || '').trim();
  if (!q || q.length > 260) return false;
  // 除代词式承接外，现场还会用“第一步正常了/接口通了/数据库没权限/只能靠页面/还缺什么”等
  // 汇报排查进度或说明证据限制。这些都仍属于原主题，不能因为当前句只讲“我现在拿到什么”就丢掉已核事实。
  // 这里只判断是否值得尝试继承；contextualRouteQuestion 后续仍会用当前直达 route、显式新实体和高风险 UI 门阻止串话。
  const anaphoric = /^(?:那|那么|这个|那个|它|刚才|上面|前面|所以|然后|还有|其中|该功能|该接口|该页面|回到|上午反馈(?:的)?|之前反馈(?:的)?|前次反馈(?:的)?|关于(?:刚才|上面|前面|这个|该)|针对(?:刚才|上面|前面|这个|该)|这(?:里|块|一段|一步)|刚才这(?:里|块|一段)|填完(?:以后|后)?|提交(?:完|后)|保存(?:完|后)|发送(?:完|后)|完成(?:后)?|药师想复核这次|医生想复核这次|现场想复核这次|复核这次|这次复测|复测(?:时|到|这里|这个))/i.test(q);
  const progress = /^(?:(?:第[一二三四五六七八九十\d]+步|前(?:一|两|几)步)(?:已经|也|都|先)?[^，。；]{0,36}(?:正常|完成|看过|查过|没发现异常|对上|没对上)|(?:接口|请求|响应)(?:已经|也|都|是)?[^，。；]{0,36}(?:正常|成功|通了|返回(?:也是|为)?\s*(?:HTTP\s*)?200)|(?:接下来|下一步|后面)(?:呢|怎么|查|看|做|先))/i.test(q);
  const partialEvidence = /(?:目前|现在|这次|现场|我|这边)?(?:只能|只)(?:确认|看到|拿(?:得)?到|靠|看)|只有(?:这|一)?张?(?:截图|图片|图|页面)|(?:数据库|日志|源码|后台)(?:这边)?(?:暂时)?(?:没|没有|拿不到|无)(?:权限|法)?(?:查|看|拿)?|仅靠(?:页面|截图|接口|响应)|只靠(?:页面|截图|接口|响应)|还缺(?:什么|哪些)|缺(?:什么|哪些)(?:信息|证据)|先说(?:说)?能确定的部分|能先排除什么/i.test(q);
  // 实施常用“关于/针对 + 上轮主题 + 已拿到的证据 + 重点核什么”继续追问。
  // 这不是新主题；这里只允许进入上下文裁决，后面的显式新实体判断仍会让真正的切题 route 覆盖旧 route。
  const topicAnchoredFollowup = /^(?:关于|针对)[^。！？；\n]{1,100}(?:重点核对|重点检查|怎么排查|如何排查|下一步|接下来|还缺什么|能排除什么|请求和响应|已有请求|已有响应)/i.test(q);
  // 实施也常把同主题追问重新包装成“医院/现场反馈……先查什么、做哪个验证”，不会使用“这个/刚才”。
  // 这里只让它进入上下文裁决；后续显式新实体和直达 route 仍优先，单独开启的新会话也没有历史可继承。
  const reportedIssueFollowup = /^(?:医院|现场|实施|产品|开发|运维|对接方)[\s\S]{1,220}(?:先|下一步|怎么|如何|哪个验证|排查|检查|核对)/i.test(q);
  const subjectAnchoredProgress = /^(?=[^。！？；\n]{1,100}(?:这(?:一段|一步|个问题)|按这个顺序))[^。！？；\n]{1,180}(?:后面|下一步|先停|继续|怎么|如何)/i.test(q);
  // 题库/真实现场会把承接写成“我没完全听懂 X 的排查建议，换成实施清单”。
  // 这不是新主题；既要保留上一答复供重述，也要继续继承 X 的 current route 事实。
  const rephraseFollowup = /^(?:我)?(?:还|没|没有|不)?(?:完全)?(?:听懂|看懂|理解)[^。！？；\n]{0,120}(?:换成|改成|整理成|说成|再说|重新说|逐项|清单|步骤)/i.test(q)
    || /^(?:把|请把)[^。！？；\n]{0,120}(?:排查建议|上次建议|刚才建议)[^。！？；\n]{0,80}(?:换成|改成|整理成)(?:实施|产品|研发)?/i.test(q);
  return anaphoric || progress || partialEvidence || topicAnchoredFollowup || reportedIssueFollowup || subjectAnchoredProgress || rephraseFollowup;
}

function contextualRouteQuestion(map, messages, currentQuestion, subKey = '', contextDepth = 0) {
  const current = String(currentQuestion || '').trim();
  const direct = routeQuestion(map, current, subKey);
  if (!consultContextFollowupIntent(current)) return direct;
  const history = Array.isArray(messages) ? messages : [];
  const users = history.map((m, messageIndex) => ({ m, messageIndex }))
    .filter(({ m }) => m && m.role === 'user' && String(m.content || '').trim());
  let previous = '';
  let previousIndex = -1;
  let previousMessageIndex = -1;
  for (let i = users.length - 1; i >= 0; i--) {
    const value = String(users[i].m.content || '').trim();
    if (value && value !== current) {
      previous = value;
      previousIndex = i;
      previousMessageIndex = users[i].messageIndex;
      break;
    }
  }
  if (!previous) return direct;
  // 上一轮本身也可能是“只剩截图/请求已抓到/还缺什么”之类承接问法。
  // 用它之前的历史递归还原当时已经裁决的 route，避免连续第二个弱追问被宽泛 DQ 抢走事实账本。
  let prior = consultContextFollowupIntent(previous) && contextDepth < 24
    ? contextualRouteQuestion(map, history.slice(0, previousMessageIndex), previous, subKey, contextDepth + 1)
    : routeQuestion(map, previous, subKey);
  // 连续多轮都只汇报排查进度/证据限制时，中间句本身可能没有足够词命中 route。
  // 向前找“最近一个仍属于同主题的已核 route”：中间轮即使重复“配置/权限/反馈”等原主题实体也可跨越；
  // 但只要中间轮已明确命中另一 route，或出现候选 route 完全不含的新实体，就形成主题屏障。
  if (!prior.matched && consultContextFollowupIntent(previous)) {
    for (let i = previousIndex - 1; i >= 0; i--) {
      const candidateQuestion = String(users[i].m.content || '').trim();
      if (!candidateQuestion) continue;
      const candidate = routeQuestion(map, candidateQuestion, subKey);
      if (!candidate.matched) {
        if (!consultContextFollowupIntent(candidateQuestion)) break;
        continue;
      }
      const candidateId = String(candidate.route && candidate.route.id || '');
      const candidateCard = (Array.isArray(map && map.questionRoutes) ? map.questionRoutes : []).find(r => String(r && r.id || '') === candidateId);
      const candidateText = String(candidateCard && candidateCard.searchText || [candidateCard && candidateCard.title, ...((candidateCard && candidateCard.aliases) || []), ...((candidateCard && candidateCard.keywords) || [])].filter(Boolean).join(' ')).toLowerCase();
      let blocked = false;
      for (let j = i + 1; j <= previousIndex; j++) {
        const bridgeQuestion = String(users[j].m.content || '').trim(); if (!bridgeQuestion) continue;
        const bridgeRoute = routeQuestion(map, bridgeQuestion, subKey);
        const bridgeId = String(bridgeRoute.route && bridgeRoute.route.id || '');
        if (bridgeRoute.matched && bridgeId && bridgeId !== candidateId) { blocked = true; break; }
        const bridgeEntities = bridgeQuestion.match(/按钮|菜单|医嘱|收费|监护|患教|反馈|药品|检验|体温单|权限|角色|token|登录|退出|登出|缓存|配置|模板|处方|病历|评估|数据库|表名|字段|列类型|varchar|uuid|p_id|pwrs_patient/ig) || [];
        if (bridgeEntities.some(term => !candidateText.includes(term.toLowerCase()))) { blocked = true; break; }
      }
      if (!blocked) prior = candidate;
      break;
    }
  }
  if (!prior.matched) return direct;
  const directId = String(direct.route && direct.route.id || '');
  const priorId = String(prior.route && prior.route.id || '');
  const currentTechnicalFocus = consultScopeTechnicalTokens(current);
  const inheritedTechnicalFocus = currentTechnicalFocus.length
    ? currentTechnicalFocus
    : ((Array.isArray(prior.focusTechnicalTokens) && prior.focusTechnicalTokens.length)
      ? prior.focusTechnicalTokens
      : consultScopeTechnicalTokens(previous));
  if (direct.matched && directId === priorId) return {
    ...direct,
    inherited: true,
    inheritedFromQuestion: previous.slice(0, 240),
    focusTechnicalTokens: inheritedTechnicalFocus,
    factLedger: true,
  };

  // “显式新实体”按当前 route 的地图关键词判断：当前问法命中了上一 route 未包含的判别词，视为切模块。
  // 排除列表/页面/数据/接口/排查等跨模块通用词，避免“那页面没数据”错误覆盖上一轮具体 route。
  const generic = new Set(['页面', '列表', '数据', '接口', '功能', '问题', '异常', '查询', '显示', '排查', '步骤', '入口', '患者']);
  const routes = Array.isArray(map && map.questionRoutes) ? map.questionRoutes : [];
  const directCard = routes.find(r => String(r && r.id || '') === directId);
  const priorCard = routes.find(r => String(r && r.id || '') === priorId);
  const priorText = String(priorCard && priorCard.searchText || [priorCard && priorCard.title, ...((priorCard && priorCard.keywords) || [])].filter(Boolean).join(' ')).toLowerCase();
  // 当前轮即使没路由成功，只要显式出现上一轮没有的新业务实体，也不能继承旧 route。
  // 例如患者列表后问“这个红色按钮点哪个”：按钮实体没有证据，应保持 miss，不能被“这个”污染成患者事实。
  const entityTerms = current.match(/按钮|菜单|医嘱|收费|监护|患教|反馈|药品|检验|体温单|权限|角色|token|登录|缓存|配置|模板|处方|病历|评估|数据库|表名|字段|列类型|varchar|uuid|p_id|pwrs_patient/ig) || [];
  const highRiskUiUnknown = entityTerms.some(term => /^(?:按钮|菜单)$/.test(term) && !previous.toLowerCase().includes(term.toLowerCase()));
  if (highRiskUiUnknown) return { ...direct, contextOverride: true, contextPreviousRouteId: priorId };
  const explicitUnknownEntity = entityTerms.some(term => !previous.toLowerCase().includes(term.toLowerCase()) && !priorText.includes(term.toLowerCase()));
  if (explicitUnknownEntity && !direct.matched) return { ...direct, contextOverride: true, contextPreviousRouteId: priorId };
  const discriminator = ((directCard && directCard.keywords) || []).map(x => String(x || '').trim()).filter(x => x.length >= 2 && !generic.has(x));
  const explicitSwitch = direct.matched && directId && directId !== priorId && discriminator.some(term => current.toLowerCase().includes(term.toLowerCase()) && !priorText.includes(term.toLowerCase()));
  if (explicitSwitch) return { ...direct, contextOverride: true, contextPreviousRouteId: priorId };

  // 进入本分支说明当前问法已属于承接型短追问；显式新实体/切模块已在上方先行返回。
  // 因此即便短句被泛化 QR/DQ 抢到，也应复用上一轮已核 route，而不是让弱当前词覆盖上下文事实。
  return {
    ...prior,
    score: Math.round((Number(prior.score) || 0) * 0.82 * 1000) / 1000,
    inherited: true,
    inheritedFromQuestion: previous.slice(0, 240),
    // 记录最近一轮用户明确点名的强技术标识，供后续同主题诊断做“当前对象”范围审计。
    // 只继承用户问题里的 token，不从宽泛 answerFacts 反推，避免同表 sibling 字段借 route 事实进入答案。
    focusTechnicalTokens: inheritedTechnicalFocus,
    factLedger: true,
    directCandidate: direct.matched ? { id: directId, title: direct.route && direct.route.title, score: direct.score } : null,
  };
}
// 从 spec 正文按标题/锚点定位截取「指定章节」；定位不到 → 退回该 spec 前段。
// 精确命中的章节先完整保留，再由 routeEvidenceExcerpt 做可验证紧凑节选；不能在固定前缀静默截掉后续接口。
function extractSection(fullText, ref) {
  const body = String(fullText || '');
  if (!body) return '';
  const lines = body.split('\n');
  const wantTitle = String((ref && ref.section) || (ref && ref.title) || '').trim();
  const wantAnchor = String((ref && ref.anchor) || '').trim().toLowerCase();
  // 归一：markdown 标题行 → slug（近似 map 的 anchor 生成：去 markdown 记号、空白/标点转连字符、小写）
  const slugify = s => String(s || '').toLowerCase().replace(/[`*_~]/g, '').replace(/[^\w一-龥]+/g, '-').replace(/^-+|-+$/g, '');
  const normTitle = s => String(s || '').replace(/^#+\s*/, '').replace(/[`*_~]/g, '').replace(/\s+/g, '').toLowerCase();
  let startIdx = -1, startLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const hm = lines[i].match(/^(#{1,6})\s+(.+?)\s*$/); if (!hm) continue;
    const htext = hm[2], hslug = slugify(htext);
    const bySlug = wantAnchor && (hslug === wantAnchor || hslug.startsWith(wantAnchor) || wantAnchor.startsWith(hslug) && hslug.length >= 6);
    const byTitle = wantTitle && (normTitle('#' + htext).includes(normTitle(wantTitle).slice(0, 12)) || normTitle(wantTitle).includes(normTitle('#' + htext)) && normTitle(htext).length >= 4);
    if (bySlug || byTitle) { startIdx = i; startLevel = hm[1].length; break; }
  }
  if (startIdx < 0) {   // 定位不到 → 退回该 spec 去掉 front-matter 后的前段
    return body.replace(/^---[\s\S]*?---\s*/, '').trim().slice(0, 900);
  }
  const out = [lines[startIdx]];
  for (let i = startIdx + 1; i < lines.length; i++) {
    const hm = lines[i].match(/^(#{1,6})\s+/);
    if (hm && hm[1].length <= startLevel) break;   // 遇到同级/更高级标题 → 章节结束
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}
// 人工 route 的长章节紧凑节选：逐字保留所有 HTTP 方法/路径，再按标题、状态/权限/数据/依赖等契约行补齐。
// 只做抽取与重排，不改写业务事实；输出仍≤max，避免单一长章节挤占整个模型上下文。
function routeEvidenceExcerpt(sectionText, max = 800) {
  const raw = String(sectionText || '').trim();
  if (!raw || raw.length <= max) return raw;
  const lines = raw.split('\n').map((text, index) => ({ text: text.trim(), index })).filter(x => x.text);
  const signatures = [...new Set(Array.from(raw.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_?&=./:{}*\-]+/g), m => m[0]))];
  const prefix = '【长章节精确证据节选】';
  const signatureLine = signatures.length ? `接口签名：${signatures.join('；')}` : '';
  const chosen = new Set();
  const charLen = () => prefix.length + (signatureLine ? signatureLine.length + 1 : 0) + [...chosen].reduce((n, i) => n + lines[i].text.length + 1, 0);
  const tryAdd = i => {
    if (chosen.has(i)) return;
    const next = charLen() + lines[i].text.length + 1;
    if (next <= max) chosen.add(i);
  };
  const ranked = lines.map((line, i) => {
    const s = line.text;
    let score = 0;
    if (/^#{1,6}\s+/.test(s)) score += 80;
    if (/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//.test(s)) score += 100;
    if (/(?:NEEDS-HUMAN|软删除|deleted\s*=\s*[01]|不物理删除|权限|认证|安全|入口|外部|依赖|数据源|持久|表\b|写入|只读)/iu.test(s)) score += 70;
    if (/`[^`]+`|\b[a-z][a-z0-9]*_[a-z0-9_]+\b/.test(s)) score += 35;
    return { i, score, index: line.index };
  });
  // 先锁定章节标题与高价值契约行；同分保持原文顺序。
  for (const item of ranked.sort((a, b) => b.score - a.score || a.index - b.index)) if (item.score > 0) tryAdd(item.i);
  // 有余量再按原文顺序补普通说明，使节选仍可读。
  for (let i = 0; i < lines.length; i++) tryAdd(i);
  const body = [...chosen].sort((a, b) => lines[a].index - lines[b].index).map(i => lines[i].text);
  return [prefix, signatureLine, ...body].filter(Boolean).join('\n').slice(0, max);
}
// 命中后取内容：读 primaryRefs(+contextRefs) 指定章节组装 specHits；answerFacts 作最高优段注入、mustNotConfuse 作负向提示。
//   返回 { specHits:[{subsystem,module,title,section,text}], mustNotConfuse:[...] }。specHits 结构与 specSearch 输出兼容（喂 consultSystem）。
function loadRouteContext(proj, ver, routeResult) {
  const ref = safeRef(ver), repoPath = moduleMapRepo(proj, ver);
  const specHits = [];
  // answerFacts 置顶：作为「模块地图·经确认事实」段（consultSystem 里点明"优先据此作答"由注入文本自带，不改模板）
  const facts = (routeResult && routeResult.answerFacts) || [];
  if (facts.length) {
    specHits.push({ subsystem: '', module: '模块地图', title: '经确认事实（最高优先，据此作答）', section: 'answerFacts',
      text: '以下为该产品模块地图人工整理的经确认事实，回答请优先据此，不要臆造：\n' + facts.map((f, i) => `${i + 1}. ${f}`).join('\n') });
  }
  // 读被引 spec 章节
  const primaryRefs = ((routeResult && routeResult.primaryRefs) || []).map(refItem => ({ refItem, routeRefKind: 'primary' }));
  const contextRefs = ((routeResult && routeResult.contextRefs) || []).map(refItem => ({ refItem, routeRefKind: 'context' }));
  const specRefs = ((routeResult && routeResult.specRefs) || []).map(refItem => ({ refItem, routeRefKind: 'spec' }));   // tier-2/3 用 specRefs
  // 已有 answerFacts 时，优先把精确 contextRefs 读进 load cap；primary 常是与 facts 重复的验证问题/当前事实摘要。
  // 无 answerFacts 时仍以 primary 为主事实源，保持原语义。
  const refs = facts.length ? [].concat(contextRefs, primaryRefs, specRefs) : [].concat(primaryRefs, contextRefs, specRefs);
  const seen = new Set();
  for (const tagged of refs) {
    if (specHits.filter(h => h.section !== 'answerFacts').length >= 6) break;
    const r = tagged.refItem;
    const rel = String((r && r.path) || '').trim(); if (!rel) continue;
    const dk = rel + '#' + String((r && r.anchor) || (r && r.section) || '');
    if (seen.has(dk)) continue; seen.add(dk);
    let full = repoPath ? specFileText(repoPath, ref, rel) : '';
    if (!full || !full.trim()) continue;   // 读不到该 spec 文件 → 跳过（不臆造）
    const sec = routeEvidenceExcerpt(extractSection(full, r), 800);
    if (!sec) continue;
    specHits.push({ subsystem: '', module: String((r && r.specId) || ''), title: String((r && (r.section || r.title)) || ''), section: String((r && r.section) || ''), text: sec, routeRefKind: tagged.routeRefKind });
  }
  return { specHits, mustNotConfuse: (routeResult && routeResult.mustNotConfuse) || [] };
}
// PD-04 修复：把路由内容与 specSearch 底座合成「实际喂模型的 specHits」——纯函数、可单测。
//   routeHits = loadRouteContext 的 specHits（含 answerFacts 顶段，路由命中时）；searchHits = specSearchScored 结果（specSearch 底座）。
//   ① 路由命中（matched=true）：answerFacts 最高优；随后为人工 route 的精确 contextRefs/primaryRefs 预留配额；
//      最强 specSearch 作为纠偏底座补入。不能让 5 条宽泛 search 独占 cap，把接口/状态/权限等人工引用挤出真实模型上下文。
//   ② 路由未命中（matched=false）：specSearch 首条 ≥ minRelevant → 用 specSearch（据 spec 底座作答）；否则空（走 miss 固定话术）。
//   返回 { specHits, usedSpecSearch, searchTop, noSpec }（noSpec=true 表示既无路由也无够强 specSearch → 上层可判 miss 话术）。
function assembleConsultSpecHits(matched, routeHits, searchHits, minRelevant, cap = 7) {
  const base = Array.isArray(searchHits) ? searchHits : [];
  const searchTop = (base[0] && typeof base[0].score === 'number') ? base[0].score : 0;
  const searchOK = searchTop >= minRelevant;
  const keyOf = h => (String((h && h.module) || '') + '|' + String((h && h.title) || '') + '|' + String((h && h.text) || '').slice(0, 120));
  if (matched) {
    const out = [], seen = new Set(), directEvidenceHits = [];
    const route = Array.isArray(routeHits) ? routeHits : [];
    const facts = route.filter(h => h && h.section === 'answerFacts');
    const rest = route
      .filter(h => h && h.section !== 'answerFacts')
      // answerFacts 已覆盖 route 的事实摘要时，不再让重复的“当前事实/As-built”章节占用有限上下文位；
      // 把配额留给接口、状态、权限、安全、数据等可回答细节。
      .filter(h => !facts.length || !/(?:当前事实|已核事实|as[- ]?built)/iu.test(`${h.title || ''} ${h.section || ''}`))
      .map((hit, index) => ({ hit, index }));
    const routePriority = item => {
      const hit = item.hit || {}, label = `${hit.title || ''} ${hit.section || ''}`;
      const kind = hit.routeRefKind === 'context' ? 100 : hit.routeRefKind === 'primary' ? 50 : 10;
      const contract = /(?:接口|状态|权限|安全|数据|表|字段|持久|删除|导出|入口)/u.test(label) ? 20 : 0;
      return kind + contract;
    };
    rest.sort((a, b) => routePriority(b) - routePriority(a) || a.index - b.index);
    let includedSearch = false;
    const push = (h, direct = false) => {
      if (!h || out.length >= cap) return false;
      const k = keyOf(h); if (seen.has(k)) return false;
      seen.add(k); out.push(h); if (direct) directEvidenceHits.push(h); return true;
    };
    facts.forEach(hit => push(hit, true));
    // 最强 search 紧随 answerFacts（或在无 facts 时置首）作错路由纠偏；只先占 1 位，不能挤掉人工精确引用。
    for (const hit of base) { if (push(hit, false)) { includedSearch = true; break; } }
    const reservedRouteCount = Math.max(0, cap - out.length);
    rest.slice(0, reservedRouteCount).forEach(item => push(item.hit, true));
    // route 引用未占满 cap 时，再用其余 search 补齐。
    for (const hit of base) { if (push(hit, false)) includedSearch = true; if (out.length >= cap) break; }
    for (const item of rest.slice(reservedRouteCount)) { push(item.hit, true); if (out.length >= cap) break; }
    return { specHits: out, directEvidenceHits, usedSpecSearch: includedSearch, searchTop, noSpec: false };
  }
  // 路由未命中
  if (searchOK) return { specHits: base.slice(0, 6), usedSpecSearch: true, searchTop, noSpec: false };
  return { specHits: [], usedSpecSearch: false, searchTop, noSpec: true };
}
// PD-04：路由决策 → 进 PD-03 的 retrieval.routing（诊断页可看「路由到哪个模块 / 或未命中」）。无地图产品 → enabled:false。
function routingDiag(hasMap, route) {
  if (!hasMap || !route) return { enabled: false };
  return {
    enabled: true,
    matched: !!route.matched,
    tier: route.tier || 0,
    score: typeof route.score === 'number' ? route.score : 0,
    routeId: (route.route && route.route.id) || '',
    routeTitle: (route.route && route.route.title) || (route.exactName ? ('精确名:' + route.exactName) : ''),
    fallbackMode: route.fallbackMode || (route.route && route.route.fallbackMode) || '',
    exactRouteTitle: !!route.exactRouteTitle,
    inherited: !!route.inherited,
    inheritedFromQuestion: route.inherited ? String(route.inheritedFromQuestion || '').slice(0, 240) : '',
    contextOverride: !!route.contextOverride,
    contextPreviousRouteId: String(route.contextPreviousRouteId || ''),
    directCandidate: route.directCandidate || null,
    threshold: ROUTE_MATCH_MIN,
    topN: (Array.isArray(route.topN) ? route.topN : []).slice(0, 5).map(t => ({ id: String((t && t.id) || '').slice(0, 80), title: String((t && t.title) || '').slice(0, 120), score: typeof (t && t.score) === 'number' ? t.score : 0 })),
  };
}
// PD-03：kbRetrieve 的「带分」变体——返回 [{e,rank}] 里的条目 + 其检索得分 score。复用 _kbScored（同 kbRetrieve 打分口径）。
async function kbRetrieveScored(projId, query, n = 5, minScore = 1) {
  const qtok = new Set(kbTokenize(query)); if (!qtok.size) return [];
  let qv = null;
  if (loadEmbedCfg()) { try { await ensureKbEmbed(projId); const vs = await embedTexts([query]); qv = (vs && vs[0]) || null; } catch { qv = null; } }
  return _kbScored(projId, query, qtok, qv, minScore).sort((a, b) => b.rank - a.rank).slice(0, n)
    .map(x => ({ e: x.e, score: Math.round((x.rank || 0) * 1000) / 1000, matchedTerms: [...new Set(kbTokenize([x.e.q, x.e.a, x.e.subsystem, x.e.module].join(' ')))].filter(t => qtok.has(t)).slice(0, 12) }));
}
// PD-03：把「实际喂给 AI 的三类检索内容」组装成紧凑、体积可控的 retrieval 对象（consult 落库 / 回放共用）。
//   传入 specScored（specSearchScored 结果）/ kbScored（kbRetrieveScored 结果）/ codeHits（codeSearch 结果，无分）。
//   cap：spec≤5、kb≤5、code≤4；截断：spec/code text≤300、kb q≤200、kb a≤300。弱匹配/无命中/未 deep → 对应数组为空（照存，「没取到」本身是排查信息）。
function buildRetrieval({ query, deep, ver, subsystem }, specScored, kbScored, codeHits) {
  const clip = (s, n) => String(s == null ? '' : s).slice(0, n);
  return {
    query: clip(query, 500), deep: !!deep, ver: clip(ver, 60), subsystem: clip(subsystem, 60), at: nowStamp(),
    spec: (Array.isArray(specScored) ? specScored : []).slice(0, 5).map(s => ({ subsystem: clip(s.subsystem, 60), module: clip(s.module, 80), title: clip(s.title, 120), score: typeof s.score === 'number' ? s.score : 0, text: clip(s.text, 300), matchedTerms: Array.isArray(s.matchedTerms) ? s.matchedTerms.slice(0, 12) : [] })),
    kb: (Array.isArray(kbScored) ? kbScored : []).slice(0, 5).map(x => { const e = x.e || x; return { q: clip(e.q, 200), a: clip(e.a, 300), score: typeof x.score === 'number' ? x.score : 0, subsystem: clip(e.subsystem, 60), module: clip(e.module, 80), matchedTerms: Array.isArray(x.matchedTerms) ? x.matchedTerms.slice(0, 12) : [] }; }),
    code: (Array.isArray(codeHits) ? codeHits : []).slice(0, 4).map(c => ({ file: clip(c.file, 200), text: clip(c.text, 300) })),
  };
}

// ===== Git 集成（GitLab / Gitee）：贴 组/仓 地址 → 自动 id/名称/子系统；服务器 clone 到缓存供读 spec/版本 =====
//   provider 分流：GitLab REST v4（PRIVATE-TOKEN 头，baseUrl+/api/v4）｜Gitee REST v5（access_token 查询参数，恒 https://gitee.com/api/v5）。
//   provider 由 gitProvider(cfg) 判定：cfg.provider 显式优先，否则按 baseUrl host 推断（含 gitee.com → gitee，否则 gitlab）。用户无感（贴 gitee 地址即走 gitee）。
const GIT_CFG_FILE = path.join(DATA_DIR, 'git-config.json');
const REPOS_CACHE = path.join(DATA_DIR, 'repos');
const GITEE_API_BASE = 'https://gitee.com/api/v5';   // Gitee REST base 恒定，不随 baseUrl 配的路径变
function readGitCfg() { try { return JSON.parse(fs.readFileSync(GIT_CFG_FILE, 'utf8')) || {}; } catch { return {}; } }
function writeGitCfg(c) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(GIT_CFG_FILE, JSON.stringify(c)); } catch {} }
function maskTok(t) { t = String(t || ''); return t.length > 10 ? (t.slice(0, 6) + '……' + t.slice(-4)) : (t ? '已配置' : ''); }
function gitBase() { return (readGitCfg().baseUrl || '').replace(/\/$/, ''); }
function sanId(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'proj'; }
// provider 判定：cfg.provider 显式优先（'gitlab'|'gitee'）；否则按 baseUrl host 推断（含 gitee.com → gitee，其余 gitlab）。缺省 gitlab（向后兼容）。
function gitProvider(cfg) { const c = cfg || readGitCfg(); const p = String(c.provider || '').trim().toLowerCase(); if (p === 'gitee' || p === 'gitlab') return p; const base = String(c.baseUrl || ''); let host = ''; try { host = new URL(base).host.toLowerCase(); } catch { host = base.toLowerCase(); } return host.includes('gitee.com') ? 'gitee' : 'gitlab'; }
// Gitee REST v5：GET https://gitee.com/api/v5<pathq>，access_token 查询参数认证；!ok 抛 message||HTTP status。
async function giteeApi(pathq) { const c = readGitCfg(); if (!c.token) throw new Error('未配置 Git 集成（host + token）'); const p = String(pathq || ''); const sep = p.includes('?') ? '&' : '?'; const r = await fetch(GITEE_API_BASE + p + sep + 'access_token=' + encodeURIComponent(c.token)); const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.message) || ('HTTP ' + r.status)); return j; }
async function glApi(pathq) { const c = readGitCfg(); if (!c.baseUrl || !c.token) throw new Error('未配置 Git 集成（host + token）'); const r = await fetch(gitBase() + '/api/v4' + pathq, { headers: { 'PRIVATE-TOKEN': c.token } }); const j = await r.json().catch(() => null); if (!r.ok) throw new Error((j && j.message) || ('HTTP ' + r.status)); return j; }
function gitUrlPath(u) { try { u = String(u || '').trim().replace(/\.git$/, '').replace(/\/-\/.*$/, ''); const m = u.match(/^https?:\/\/[^/]+\/(.+)$/); return m ? m[1].replace(/\/$/, '') : String(u).replace(/^\/+|\/+$/g, ''); } catch { return ''; } }
// 顶层 gitUrl 缺失时，从子系统仓地址反推「组/命名空间」地址（去掉末段 <repo>.git），保证卡片/编辑能显示 Git 已接
function deriveGitUrl(proj) { if (proj && proj.gitUrl) return proj.gitUrl; const sub = ((proj && proj.subsystems) || []).find(s => s && s.repoUrl); return sub ? String(sub.repoUrl).replace(/\.git$/, '').replace(/\/[^/]+$/, '') : ''; }
// token 注入到 https 克隆地址（供 cloneRepo / lsRemoteRefs 复用，别各写各的）。
//   gitlab: https://oauth2:{token}@host/...（原逻辑，逐字不变）｜gitee: gitee.com 也用 oauth2:{token}@（Gitee 支持 oauth2 用户名 + token 密码；真仓 clone/ls-remote 已验）。
function authGitUrl(repoUrl, cfg) {
  const c = cfg || readGitCfg(); const tok = c.token; if (!repoUrl || !tok) return String(repoUrl || '');
  // 两 provider 目前注入形式一致（oauth2:{token}@）；保留分支点便于 Gitee 若不支持时退回 https://{token}@。
  return String(repoUrl).replace(/^(https?:\/\/)([^@/]*@)?/, (m, proto) => proto + 'oauth2:' + tok + '@');
}
// Gitee 单仓/owner 两分支解析。path 含 '/' → 单仓 /repos/{owner}/{repo}；无 '/' → owner，三级兜底列全部仓当子系统。
async function gitInspectGitee(u) {
  const p = gitUrlPath(u); if (!p) throw new Error('Git 地址无法解析');
  // Gitee 反直觉：无 clone_url 字段，且 html_url 已自带 .git（如 …wzh2.0.git）。归一——先剥尾部 .git 和 / 再补一个 .git，避免 .git.git。
  const cloneOf = (r) => { const base = String(r.clone_url || r.html_url || '').replace(/\.git$/, '').replace(/\/+$/, ''); return base ? base + '.git' : ''; };
  const subOf = (r) => ({ key: r.path || r.name, name: r.full_name || r.name || r.path, desc: (r.description || '').trim(), repoUrl: cloneOf(r) });
  if (p.includes('/')) {   // owner/repo → 单仓
    const parts = p.split('/'); const owner = parts[0], repo = parts.slice(1).join('/');
    const r = await giteeApi('/repos/' + encodeURIComponent(owner) + '/' + encodeURIComponent(repo));
    // 顶层 gitUrl 是「命名空间/仓」展示地址，不带 .git（Gitee html_url 自带 .git，需去掉）。
    return { id: sanId(r.path || r.name || repo), name: r.full_name || r.name || repo, gitUrl: String(r.html_url || u).replace(/\.git$/, ''), subsystems: [subOf(r)] };
  }
  // 只 owner → 列该 owner 全部仓当子系统。三级兜底，任一非空即用：
  //   ① /orgs（组织）→ ② /users（该用户公开仓）→ ③ /user/repos 再按 owner 过滤（当前 token 名下全部仓，含私有；覆盖个人号私有仓）。
  const owner = p;
  let repos = null;
  try { repos = await giteeApi('/orgs/' + encodeURIComponent(owner) + '/repos?type=all&per_page=100'); } catch { repos = null; }
  if (!Array.isArray(repos) || repos.length === 0) {
    try { repos = await giteeApi('/users/' + encodeURIComponent(owner) + '/repos?type=all&per_page=100'); } catch { repos = null; }
  }
  if (!Array.isArray(repos) || repos.length === 0) {
    // 当前 token 名下全部仓（含私有，跨多 owner），按 owner 过滤。per_page=100 为上限，>100 仓暂不翻页。
    let all = null;
    try { all = await giteeApi('/user/repos?type=all&per_page=100'); } catch { all = null; }
    repos = (Array.isArray(all) ? all : []).filter(r => (r && r.namespace && r.namespace.path === owner) || String((r && r.full_name) || '').startsWith(owner + '/'));
  }
  const subs = (Array.isArray(repos) ? repos : []).map(subOf);
  return { id: sanId(owner), name: owner, gitUrl: 'https://gitee.com/' + owner, subsystems: subs };
}
async function gitInspect(u) {   // 解析 URL → {id,name,gitUrl,subsystems:[{key,name,desc,repoUrl}]}；按 provider 分流
  if (gitProvider() === 'gitee') return gitInspectGitee(u);
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
  const authUrl = authGitUrl(repoUrl, c);   // provider 化 token 注入（gitlab/gitee 统一走 authGitUrl）
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
      if (c.token) { const cur = gitOut(dir, ['remote', 'get-url', 'origin']).trim(); const clean = cur.replace(/^(https?:\/\/)([^@/]*@)?/, '$1'); const auth = authGitUrl(clean, c); spawnSync('git', ['-C', dir, 'remote', 'set-url', 'origin', auth], { timeout: 15000 }); }   // 重嵌当前 token（provider 化，同 cloneRepo），防轮换后拉不动
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
// 【reopen 时序 bug 修·2026-08-07】会话记录 chat 保留「每条消息各自的 ts」：本轮整段 chat 按下标与 prev.chat 对齐，
//   老消息沿用已有 ts、新消息按单调递增补（锚在上一条已知 ts 之后）——避免整段盖同一 Date.now() 导致 reopen 无法按时序排。
//   纯函数（无副作用），供 saveConvRecord 用；对齐容错：老消息 text 可能被后端重建（media 回贴等）略变，故只按「下标 + role 一致」认作同一条沿用 ts；role 变了或超出 prev 长度即视为新消息补 ts。
function reconcileChatTs(chatArr, prevChat) {
  const out = [];
  let lastTs = 0;   // 已确定的上一条 ts（单调递增基准）
  for (let i = 0; i < chatArr.length; i++) {
    const m = chatArr[i] || {};
    const p = prevChat[i];
    let ts;
    const pTs = (p && typeof p.ts === 'number' && isFinite(p.ts)) ? p.ts : null;
    const aligned = pTs != null && p && p.role === m.role;   // 下标+role 对齐 = 认作 prev 里的同一条
    if (aligned) {
      // 沿用老 ts（老消息时序不被覆盖）
      ts = pTs > lastTs ? pTs : lastTs + 1;   // 防 prev 里已有乱序：仍保证单调不减
    } else {
      // 新消息（或 prev 无此条/role 变）→ 补一个「比上一条大」的 ts；有自带 ts 且更大就用自带，否则 max(now, lastTs+1)
      const own = (typeof m.ts === 'number' && isFinite(m.ts) && m.ts > lastTs) ? m.ts : 0;
      ts = own || Math.max(Date.now(), lastTs + 1);
    }
    lastTs = ts;
    // 【per-message media·2026-08-07】保留每条消息的 media：本轮传入 m 带 media（intake-chat 把本轮图挂到末条 user）就用它；
    //   否则若对齐到 prev 同一条且 prev 有 media（本轮传入的整段 chat 不重传老 media）→ 沿用 prev.media，别把历史某轮附的图弄丢。
    const rec = { ...m, ts };
    if (!(Array.isArray(rec.media) && rec.media.length) && aligned && Array.isArray(p.media) && p.media.length) rec.media = p.media.slice();
    if (!(Array.isArray(rec.media) && rec.media.length)) delete rec.media;   // 无图不落空 media 键，保持记录干净
    out.push(rec);
  }
  return out;
}
// FS-04 AC-36：会话记录（type='intake-conv'）持久化——「提需求/报BUG」聊天**沟通过就存**（不必建单）。
//   id 由 sessionId 派生（CONV-<sessionId>）→ 同一次聊天每轮 upsert 同一条（幂等）；随 intakes 表 + data JSON（无新库列，type=VARCHAR(20) 容得下 'intake-conv'）。
//   会话记录 ≠ 工单：不进左侧提交清单（listIntake 已排除 intake-conv）、不进批次、不建重单；工单与它靠 sessionId 关联。
//   sessionId 为空（异常）→ 不存（回落现状，交由前端草稿兜底）。返回落库的会话记录 id，或 '' 未存。
async function saveConvRecord(proj, { sessionId, site, subsystem, version, reporter, role, chat }) {
  const sid = String(sessionId || '').trim(); if (!sid) return '';
  const chatArr = Array.isArray(chat) ? chat : [];
  // 「沟通过」判据：至少有一条有内容的 user + 一条有内容的 assistant（用户发了、AI 回了）
  const hasUser = chatArr.some(m => m && m.role === 'user' && String(m.text || '').trim());
  const hasAi = chatArr.some(m => m && m.role === 'assistant' && String(m.text || '').trim());
  if (!hasUser || !hasAi) return '';
  const id = 'CONV-' + sid.slice(0, 34);   // 'CONV-'(5) + 34 ≤ 40（intakes.id VARCHAR(40)）；确定性派生→同会话每轮命中同一条
  const prev = CACHE.intakes[proj.id] && CACHE.intakes[proj.id][id];
  if (prev && prev.deleted) return '';   // 该会话记录已被软删 → 不复活（与 consult 软删不复活续聊一致）
  const firstUser = chatArr.find(m => m && m.role === 'user' && String(m.text || '').trim());
  const title = ((prev && String(prev.title || '').trim()) || (firstUser ? String(firstUser.text).replace(/\s+/g, ' ').trim() : '') || '对话提交').slice(0, 60);
  // 【reopen 时序 bug 修·2026-08-07】每条消息保留「各自的 ts」，别整段盖同一个 Date.now()——否则同一会话所有消息 ts 相同、reopen 无法按时序穿插已建单卡。
  //   做法：本轮传入的 chat 是「整段对话」，前 N 条一般与 prev.chat 前 N 条一一对应（append-only）——按下标对齐，老消息沿用 prev 里已有的 ts，只给「新增/无 ts」的消息按单调递增补 ts（锚在上一条已知 ts 之后 1ms）。
  const timed = reconcileChatTs(chatArr, (prev && Array.isArray(prev.chat)) ? prev.chat : []);
  const rec = {
    id, type: 'intake-conv', project: proj.id, version: String(version || '').trim(),
    site: String(site || '').trim(), subsystem: String(subsystem || '').trim(), module: '',
    title, priority: '', reporter: reporter || '', role: role || 'field', contact: '',
    sessionId: sid, media: [], status: '沟通中', lifecycle: '沟通中', assignee: '',
    analysis: null, resolution: {}, chat: timed,
    submittedAt: (prev && prev.submittedAt) || nowStamp(), updatedAt: nowStamp(),
  };
  await saveIntake(proj, rec);
  return id;
}
function listIntake(proj, opts = {}) { const m = CACHE.intakes[proj.id] || {}; let arr = Object.values(m).filter(e => !e.deleted && e.type !== 'intake-conv'); if (!opts.withConsult) arr = arr.filter(e => e.type !== 'consult'); const out = arr.map(e => ({ id: e.id, type: e.type, title: e.title, subsystem: e.subsystem || '', module: e.module, version: e.version || '', site: e.site || '', priority: e.priority, reporter: e.reporter, status: e.status, lifecycle: deriveLifecycle(e), assignee: e.assignee || '', batch: e.batch || '', convertedTo: e.convertedTo || '', submittedAt: e.submittedAt, updatedAt: e.updatedAt || e.submittedAt, unread: !!e.needReply })); return out.sort((a, b) => (b.updatedAt || b.submittedAt || '').localeCompare(a.updatedAt || a.submittedAt || '')); }
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
// CU-01 激活文件生成（复刻产品 IRegistrationServiceImpl.generateLicense/calculateHash · 逐字校对 + 校验器 SystemActivationValidator 确认）：
//   license = Base64_标准( SHA-256( UTF8(设备码 + VERIFY_KEY) ) )。VERIFY_KEY=固定 verify key（产品 CommonConstant.VERIFY_KEY），服务端常量，不暴露前端。
//   Base64 用标准编码（含 + / = 填充、带 padding），即 crypto sha256 digest('base64')——与 Java 一致（黄金向量：4aea73e50cc4f679124cb68ac02942e → Kz3W2wXfWO9/NvRWxl7UCxLyyYcKh2WxMT+aeBSnxi8=）。
//   校验器 SystemActivationValidator 用同样 SHA-256+Base64 + 同 key 比对本机 machineId，故设备码对则文件必过校验。纯计算、不落库、不写盘。
const ACTIVATION_VERIFY_KEY = 'lingchuang@123';
function activationLicense(deviceCode) { return crypto.createHash('sha256').update(String(deviceCode) + ACTIVATION_VERIFY_KEY, 'utf8').digest('base64'); }
// 激活文件内容（Java Properties · VerifyConstant.LICENSE_FILE=.lc-activation.lic / ACTIVATION_KEY=activation_key）：
//   首行注释 #System Activation License；base64 值里的 =/+// 直接写、不转义（Properties.load 取第一个 = 后全部为 value 字面量，读回正确）。
function activationFileContent(deviceCode) { return '#System Activation License\nactivation_key=' + activationLicense(deviceCode) + '\n'; }
const PRIORITY_SET = new Set(['紧急', '高', '中', '低']);   // 紧急程度四档（与后台 inbox.html/detail.html 配色一致）
// 现场手选优先级规范化：合法四档→原值；非法/空→回落 fallback（AI 猜的 rec.priority 或默认「中」）。防脏值入 intakes.priority(VARCHAR(10))。
function normPriority(v, fallback = '中') { const s = String(v == null ? '' : v).trim(); return PRIORITY_SET.has(s) ? s : (fallback || '中'); }
// FS-04 v2（2026-08-07）「建单前确认清单」：AI 出 intake-plan 块（不再直接建单）。解析回复里的 plan 块 → 归一化的 items 数组 + 剔块后的可见正文。
//   一次回复最多解析第一个 intake-plan 块（提示词只让出一个）。每个 item 归一：action∈{new,append}、type∈{bug,requirement}（合并模式取 AI 判、否则用 forceType）、priority 规范四档、字段全带。
//   坏块/无 items/空 → items=[]（不建脏单），visible=剔块后正文。前端据 items 渲染确认卡；用户拍板后走 /api/intake-commit-plan 确定性建单。
const PLAN_BLOCK_RE = /```intake-plan\s*([\s\S]*?)```/g;
function parseIntakePlan(reply, forceType) {
  const raw = String(reply || '');
  const m = [...raw.matchAll(PLAN_BLOCK_RE)];
  const visible = raw.replace(PLAN_BLOCK_RE, '').trim();
  let items = [];
  for (const b of m) {
    let obj = null; try { obj = JSON.parse((b[1] || '').trim()); } catch {}
    const arr = obj && Array.isArray(obj.items) ? obj.items : [];
    for (const it of arr) {
      if (!it || typeof it !== 'object') continue;
      const title = String(it.title || '').trim();
      if (!title) continue;   // 无标题的 item 丢弃（不建脏单）
      const action = String(it.action || '').trim().toLowerCase() === 'append' ? 'append' : 'new';
      const ticketId = action === 'append' ? String(it.ticketId || '').trim() : '';
      const itType = (forceType === 'bug' || forceType === 'requirement') ? forceType : (String(it.type || '').toLowerCase() === 'bug' ? 'bug' : 'requirement');
      items.push({
        action, ticketId, type: itType, subsystem: String(it.subsystem || '').trim(), module: String(it.module || '').trim(),
        title, priority: normPriority(it.priority, '中'), summary: String(it.summary || '').trim(),
        desc: String(it.desc || ''), errorInfo: String(it.errorInfo || ''), steps: String(it.steps || ''), expectResult: String(it.expectResult || ''),
        severity: String(it.severity || ''), scope: String(it.scope || ''), env: String(it.env || ''), freq: String(it.freq || ''),
        bg: String(it.bg || ''), reqDesc: String(it.reqDesc || ''), accept: String(it.accept || ''), relate: String(it.relate || ''), opinion: String(it.opinion || ''),
      });
    }
    if (arr.length) break;   // 只认第一个含 items 的 plan 块
  }
  return { items, visible };
}
function intakeHead(e) {   // 把一条工单压成给模型看的正文（AI 沟通 + 分析共用）
  return `【${e.type === 'bug' ? 'BUG' : '需求'}】${e.title}\n版本：${e.version || '未指定'}｜现场：${e.site || '未指定'}｜模块：${e.module}｜优先级：${e.priority}` + (e.type === 'bug' ? `｜严重：${e.severity}｜环境：${e.env}｜频率：${e.freq}\n现象：${e.desc}\n报错：${e.errorInfo || '无'}\n复现：${e.steps}\n期望：${e.expectResult || '无'}` : `\n背景：${e.bg}\n期望效果：${e.reqDesc}\n场景：${e.scene || '无'}\n验收：${e.accept || '无'}\n关联：${e.relate || '无'}`);
}
function analyzeSystem(proj, ver) {   // 平台内 AI 版本感知初判：只输出严格 JSON（PD-02：模板外部化，默认逐字不变）
  const idx = specIndex(proj, ver);
  return renderPromptTpl(DATA_DIR, 'analyzeSystem', {
    projectName: proj.name,
    versionSuffix: ver ? `版本 ${ver}` : '',
    specIndex: idx || '（暂无 spec 索引）',
  });
}
function parseAnalysis(txt) { try { const m = /\{[\s\S]*\}/.exec(String(txt || '')); if (!m) return null; const j = JSON.parse(m[0]); const cat = ['非bug', 'bug', '该版本已修', '需求'].includes(j.category) ? j.category : 'bug'; const sug = j.suggestion === 'reply' ? 'reply' : 'file'; return { category: cat, verdict: String(j.verdict || '').trim(), suggestion: sug, detail: String(j.detail || '').trim() }; } catch { return null; } }

function intakeSystem(type, proj, ver) {   // PD-02：模板外部化，默认逐字不变
  const idx = specIndex(proj, ver);
  return renderPromptTpl(DATA_DIR, 'intakeSystem', {
    projectName: proj.name,
    versionParen: ver ? `（版本 ${ver}）` : '',
    specIndex: idx || '（暂无 spec 索引）',
  });
}
function subsystemNames(proj) { return ((proj && proj.subsystems) || []).map(s => (typeof s === 'string' ? s : (s && s.name) || '')).filter(Boolean); }
// 对话式进件：AI 主导按「提交标准」逐条问齐 + 推断子系统/模块，够了就输出 intake-plan「建单计划」块（不再直接建单）。
// hasArchivedBg：本轮 messages 前面切了「已归档建单·只读背景」段（filedUpTo>0）——提示词里点明只对「当前待处理」段判建单。
// builtTickets：本会话已建单清单 [{ticketId,title}]（续聊场景 · reopen 已建单会话时传入）——让 AI 在计划里对「明显是对某已建单的补充」用 action='append'、否则 action='new'（默认倾向 new）。
//   顺序流坑（2026-08-06 v1）：AI 回复里的 record 块建单后被服务端剥掉再回前端，历史里看不到"已归档"，
//   导致隔几轮再提新需求时 AI 把已建单的旧需求当"还在讨论"、跟新需求合并/重复。v1 主修=「已建单水位线」代码切上下文（见 /api/intake-chat）。
//   治本（2026-08-07 v2）：AI 不再直接建单，改出「建单计划」intake-plan（一条独立需求=一个 item，绝不合并）→ 前端确认卡让用户拍板/编辑 → /api/intake-commit-plan 按清单确定性建单。本参数让提示词与之呼应。
function intakeChatSystem(proj, type, ver, subKey, hasArchivedBg, builtTickets) {   // PD-02：模板外部化（正文可整段编辑；条件块/schema 为注入占位），默认逐字不变
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
  const specIndexBlock = idx ? `各子系统/模块功能清单（帮你对到正确位置）：\n${idx}\n` : '';
  const actionBlock = (Array.isArray(builtTickets) && builtTickets.length)
    ? `本会话此前已经建过这些单：\n${builtTickets.map(t => `· ${t.ticketId}：${t.title}`).join('\n')}\n对当前这段对话里用户新说的内容：\n- 若某条明显是对上面**某张已建单的补充/追问**（如"刚才那个导出再加个筛选""上面那个也要支持…"）→ 这个 item 用 \`{"action":"append","ticketId":"对应单号","title":"…","summary":"补充点…"}\`；\n- 若是**新的、和已建单不同**的需求/BUG → \`{"action":"new",…}\`。\n**默认倾向 new**：拿不准就填 new（宁可让用户在确认卡上改成 append，也别默认合并进旧单）。`
    : `所有 item 都用 \`"action":"new"\`（本会话还没建过任何单）。`;
  const archivedBlock = hasArchivedBg ? `
【已建单归档背景 · 只读】本轮对话开头有一段【已建单归档·只读背景】——那是本次会话里**此前已确认建单、已闭环**的需求/BUG，**只供你理解上下文**。你**只对「当前待处理」这段（背景之后的对话）判断有没有新的需求/BUG 要放进 plan**：绝不为「已归档背景」里的内容再列 item。若用户在「当前待处理」里明确针对某条已建单做补充/追问，按上面的 action 规则处理。` : '';
  const typeRule = merged ? '每个 item 的 type 必填："bug"(问题/缺陷) 或 "requirement"(需求/改进)，按你判断的类别填；' : `每个 item 的 type 填 "${type}"；`;
  return renderPromptTpl(DATA_DIR, 'intakeChatSystem', {
    typ, mergedLabel: merged ? '【需求或 BUG】' : `【${typ}】`,
    projectName: proj.name, versionParen: ver ? `（版本 ${ver}）` : '',
    subBlock, specIndexBlock, std,
    intakePlanSchema: INTAKE_PLAN_SCHEMA,   // ⚠️ 安全护栏：系统注入·不可编辑（与确定性建单/解析死耦合）
    actionBlock, archivedBlock, typeRule,
  });
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
const SEM_GATE = 0.42;                                               // 语义相关门槛（余弦 · 不相关文本实测约 0.23）·全局默认（kb-search drawer / _kbScored 入选门槛）
// consult 专用二次注入门槛（不改全局 SEM_GATE，避免影响 kb-search drawer / intake-chat）：
//   kbRetrieveScored 已按全局 SEM_GATE 召回，但 sim=0.42 的边缘条目（与提问相关度很弱）也会被召回。
//   consult 拿到 kbScored 后再过一遍 consultKbGate：语义命中要 sim≥CONSULT_KB_MIN_SIM，纯词命中要够强（matchedTerms≥CONSULT_KB_MIN_LEX），
//   弱于此的不注入 consultSystem、不发 kb 事件、不落 kbRefs（=「本次无相关经验库」），避免答疑引用与提问无关的经验（如 sim=0.42 卡边缘的条目）。
const CONSULT_KB_MIN_SIM = 0.5;                                      // 语义命中最低余弦（>SEM_GATE 0.42：宁可少引也别引 0.42 边缘的无关条目）
const CONSULT_KB_MIN_LEX = 3;                                        // 纯词命中（语义不可用时）最少不同 query token 数（>consult 现召回门槛 2：弱词匹配也不引）
// 判定单条 kbScored 是否够强、可注入 consult。kbScored 元素 {e,score,matchedTerms}：
//   score(rank) 语义可用时 = sim + 微量 lex 加权(≤~0.012)，取值 [0.42, ~1.01]；语义不可用时 = lex(整数 ≥2，consult minScore=2)。
//   故 score<1.1 ⇒ 语义分（判 sim≥CONSULT_KB_MIN_SIM）；score≥1.1 ⇒ 纯词计数（判 matchedTerms≥CONSULT_KB_MIN_LEX）。
function consultKbStrong(x) {
  const score = typeof x.score === 'number' ? x.score : 0;
  const lex = Array.isArray(x.matchedTerms) ? x.matchedTerms.length : 0;
  if (score >= 1.1) return lex >= CONSULT_KB_MIN_LEX;                 // 语义不可用：纯词计数，要够多不同 token 命中
  return score >= CONSULT_KB_MIN_SIM;                                // 语义可用：余弦要过 consult 收紧门槛
}
function consultKbFilter(kbScored) { return (Array.isArray(kbScored) ? kbScored : []).filter(consultKbStrong); }
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
function consultSystem(proj, ver, hits, specs, code, currentQuestion = '') {   // 答疑助手系统提示（code 有值=用户点了「深入思考」，附源码片段）
  // 两阶段路由已由服务端完成：普通事实问答只把本轮命中的精简目录给模型，避免完整 80+ 份目录造成实体污染。
  // 只有用户明确询问“有哪些模块/功能/规格目录”时才给完整目录；目录始终只作导航、不能当事实证据。
  const asksCatalog = /(?:系统|产品)?(?:有|包含|支持)?哪些(?:模块|功能)|模块清单|功能清单|规格目录|spec\s*(?:目录|列表)|系统模块/i.test(String(currentQuestion || ''));
  const idx = asksCatalog
    ? specIndex(proj, ver)
    : [...new Map((Array.isArray(specs) ? specs : []).map(s => [`${s.file || ''}|${s.title || ''}`, s])).values()].map(e => `[${e.subsystem ? e.subsystem + '·' : ''}${e.module || ''}] ${e.title || ''}`).join('\n');
  const subs = subsystemNames(proj);
  const kb = hits.length
    ? '下面是从经验库检索到的相关条目（历史「问题→解法」），引用时请基于它们的真实内容、别改写走样：\n' + hits.map((h, i) => `【${i + 1}】问：${h.q}\n答：${h.a}`).join('\n\n')
    : '本次未检索到相关经验库条目。请依据上面的规格摘录 / 常识作答，不要声称「根据历史经验库 / 根据经验库」（可如实说明经验库暂无相关条目）。';
  const specTxt = (specs && specs.length) ? '相关规格摘录（从系统 spec 正文按问题检索出来的真实规则 / 验收标准，回答请优先依据这里，别只凭常识猜）：\n' + specs.map(s => `《${s.subsystem ? s.subsystem + '·' : ''}${s.module || ''}｜${s.title}》\n${s.text}`).join('\n\n———\n\n') : '';
  const deep = code && code.length;
  const codeTxt = deep ? '【深入思考 · 相关源码片段】用户点了「深入思考」，下面是从系统源码里检索出的相关实现片段（每条含文件路径 + 具体代码），这是本次回答的**主要依据**，请据此说清该功能实际是怎么实现的：\n' + code.map(c => `《${c.file}》\n${c.text}`).join('\n\n———\n\n') : '';
  // PD-02：拆 consultDeep（深入思考版）/ consultNormal（普通版）两个干净整段模板；条件片段作注入占位（默认逐字不变）
  const vars = {
    projectName: proj.name,
    subsSentence: subs.length ? `产品含子系统：${subs.join('、')}。` : '',
    specIndexBlock: idx ? `${asksCatalog ? '系统完整规格目录' : '本轮候选/命中规格目录'}（仅用于导航，目录标题不能作为事实证据）：\n${idx}\n` : '',
    specExcerpts: specTxt ? '\n' + specTxt + '\n' : '',
    kbBlock: kb ? '\n' + kb + '\n' : '',
  };
  if (deep) { vars.codeExcerpts = codeTxt ? '\n' + codeTxt + '\n' : ''; return renderPromptTpl(DATA_DIR, 'consultDeep', vars); }
  return renderPromptTpl(DATA_DIR, 'consultNormal', vars);
}

// 纯对话意图不需要 Spec 事实证据：寒暄、情绪反馈、评价上一条答复、请求换种说法/澄清对话。
// 只认「整句就是对话意图」的窄模式；一旦同句还在问按钮、接口、配置、权限等系统事实，就不命中，继续走证据门。
function consultConversationTurn(question) {
  return consultConversationMode(question) === 'pure';
}

function consultConversationMode(question) {
  const q = String(question || '').trim().replace(/[\s。！？!?，,～~…]+$/g, '').trim();
  if (!q || q.length > 120) return '';
  const social = /^(?:你好|您好|嗨|哈喽|hello|hi|早上好|上午好|下午好|晚上好|在吗|辛苦了|谢谢|多谢|感谢|再见|拜拜)$/i.test(q);
  if (social) return 'pure';
  const identity = /^(?:(?:你好|您好|嗨|哈喽|hello|hi)[，,\s]*)?(?:请问)?(?:你是谁|你是(?:做什么|干嘛|干什么)的?|你能(?:帮我)?(?:做什么|干嘛|什么)|你可以帮我什么|你能帮什么|怎么称呼你|你叫什么(?:名字)?)(?:呀|啊|呢|吗)?$/i.test(q);
  if (identity) return 'identity';
  // 对话提示词可以带“行/好/那/你”等口头前后缀，不再逐句 exact 匹配；但同句出现事实实体/操作追问时必须退出对话模式。
  const conversationalCue = /(?:冷漠|冷冰冰|生硬|机械|像机器人|没感情|不耐烦|温柔一点|友好一点|自然一点|耐心一点|口语一点|简单(?:一)?点(?:说)?|说简单(?:一)?点|简短(?:一)?点|直白(?:一)?点|别(?:这么|那么)?官方|换(?:个|一种)说法|换句话说|再解释(?:一下|一遍)?|再说(?:清楚)?(?:一下|一遍)|重说(?:一下|一遍)|说人话|讲简单(?:一)?点|我没(?:完全)?听懂|我没(?:完全)?看懂|没(?:完全)?听懂|没(?:完全)?看懂|你刚才是什么意思)/i.test(q);
  if (!conversationalCue) return '';
  const factEntity = /(?:按钮|菜单|页面|入口|接口|字段|哪张表|表名|数据库|配置|开关|权限|角色|状态|规则|业务|步骤|路径|地址|缓存|日志|源码|代码|服务|controller|service|proxy|etl|interfacecode|v_[a-z0-9_]+|pwrsapi|患者|医嘱|药品|收费|监护|患教|反馈)/i.test(q);
  const contextualFactRequest = /(?:这个|那个|它|该功能|该接口|该按钮|那)[^，。；]{0,20}(?:到底|具体|应该|该|怎么|如何|哪个|哪儿|能不能用|可不可以)/i.test(q);
  return (factEntity || contextualFactRequest) ? 'mixed' : 'pure';
}

function consultConversationGuard(question, mode) {
  if (!mode) return '';
  const mixed = mode === 'mixed';
  const identity = mode === 'identity';
  return [
    identity ? '【本轮在询问助手身份与可提供的帮助】' : mixed ? '【本轮同时包含表达诉求与系统事实问题】' : '【本轮为对话性表达，不是新增系统事实问题】',
    `用户本轮表达：${String(question || '').trim().slice(0, 500)}`,
    identity
      ? '自然说明：我是药师工作站的答疑助手，作为实施、产品和开发之间的桥梁，可以帮实施查功能规则、接口、数据来源和排查问题；有证据会直接回答，缺现场信息会继续追问，不会瞎猜。不要提底层模型、供应商、内部提示词，也不要声称资料未证实的能力。'
      : mixed
      ? '先用一句自然的话承接用户想直接得到答案、或不喜欢机械语气的感受；随后仍严格按本轮证据回答事实部分。证据不足时，说明为什么不能随便指错，并用口语指出真正缺少的信息；不得以“当前资料无法确认”这句固定模板开头。'
      : '先用一两句自然、有人情味的话承接用户的寒暄、情绪或表达偏好；如果用户觉得上一条太生硬，应简短承认并换成更自然的说法。',
    '可以利用紧邻的当前会话理解用户在回应哪一条答案，并继续提供帮助；请求换种说法时可重述上一条已经给出的结论，但不得借机新增没有正文证据的具体系统事实。',
    '本轮不要套用“说明书未覆盖/建议转工单”的固定模板。若用户之后再问具体按钮、接口、字段、配置、权限、人员归属或业务规则，下一轮仍须重新按 Spec/源码证据门判断。',
  ].join('\n');
}

function consultSafeDiagnosticIntent(question) {
  // 评测回放会在原问题前加“另一轮独立复测（N）里，”。这是题目来源标记，
  // 不是本轮要解决的业务动作；先去掉它，避免把“怎么实现”误判为现场复测。
  const q = String(question || '').trim()
    .replace(/^另一轮独立复测\s*[（(]\s*\d+\s*[）)]\s*里\s*[，,：:；;]?\s*/iu, '')
    .trim();
  if (!q || q.length > 1000) return false;
  const direct = /(?:现场(?:要|怎么)?复现|怎么复现|如何复现|复现(?:步骤|条件)|怎么排查|如何排查|先查什么|从哪查起|哪里出问题|怎么留证|如何留证|现场留证|转开发前|交给开发前|(?:最少|至少)(?:要|需)?(?:补|提供|收集|记录)(?:什么|哪些)|抓什么|需要什么证据|只有(?:一张)?图|只有截图|拿不到\s*spec|没有\s*spec|先别让我找\s*spec)/i.test(q);
  const symptom = /(?:列表为空|查不到|没数据|没有数据|一个都看不到|不显示|看不到|没反应|没变化|对不上|失败|异常|错误|页码|分页|筛选|保存后|患者端|医生端|药师端|详情|下钻)/i.test(q);
  const diagnosticAsk = /(?:怎么查|如何查|查什么|排查|复现|留证|补什么|提供什么|抓什么|确认什么|怎么判断|如何判断|怎么办|怎么处理|接下来|下一步)/i.test(q);
  const partialEvidence = /(?:目前|现在|这次|现场)?(?:只能|只)(?:确认|看到|拿到|靠|看)|(?:当前|现在|本轮|现有)?\s*(?:只有|仅有|只拿到|仅拿到)[^。！？\n]{0,120}(?:哪些[^。！？\n]{0,20}(?:成立|确认)|(?:仍|还)?需(?:要)?确认)|(?:数据库|日志|源码|后台)(?:这边)?(?:暂时)?(?:没|没有|拿不到|无)(?:权限|法)?(?:查|看|拿)|仅靠(?:页面|截图|接口|响应)|只靠(?:页面|截图|接口|响应)|还缺(?:什么|哪些)|缺(?:什么|哪些)(?:信息|证据)|先说(?:说)?能确定的部分|能先排除什么/i.test(q);
  return direct || partialEvidence || (symptom && diagnosticAsk);
}

// 答疑受众按“这句话要解决什么”判断，不依赖账号角色：同一个实施账号也可能
// 在问产品规则或替研发查调用链。只有明确点名技术契约才展开研发细节；普通
// “是什么/怎么实现/业务规则”默认按产品问题回答，避免把 Java/表字段堆到首屏。
function consultAudienceMode(question) {
  const q = String(question || '').trim()
    .replace(/^另一轮独立复测\s*[（(]\s*\d+\s*[）)]\s*里\s*[，,：:；;]?\s*/iu, '')
    .trim();
  const developer = /(?:接口(?:路径|地址|契约|入参|出参|返回)?|字段(?:名|类型|长度|取值)?|列(?:名|类型|长度|取值)?|column(?:s)?(?:\s*(?:name|type|length|value))?|哪张表|表名|数据库表|SQL|源码|代码|开发链路|调用链|调用关系|Java\s*类|类名|方法名|Controller|Service|Mapper|Repository|DAO|DTO|VO)(?:[^。！？\n]{0,28}(?:什么|哪些|哪个|哪里|在哪|怎么|如何|实现|定义|调用|读写|保存|返回|排查|看|查))?|(?:什么|哪些|哪个|哪里|在哪|怎么|如何|看|查)[^。！？\n]{0,28}(?:接口|字段|列|column|哪张表|表名|SQL|源码|代码|开发链路|调用链|Java\s*类|Controller|Service|Mapper|DTO|VO)/i.test(q);
  if (developer) return 'developer';
  const implementation = consultSafeDiagnosticIntent(q)
    || /(?:现场|实施(?:口径|步骤|清单|排查|复测|核对|留证)|复测|回归|怎么查|如何查|排查|留证|转开发|只读(?:步骤|清单|检查|核)|抓包|抓到|抓取|重点核|核什么|核对|请求(?:和|与|\/)?响应|日志|截图|怎么判断|如何判断|下一步怎么做)/i.test(q);
  return implementation ? 'implementation' : 'product';
}

function consultAudienceGuard(question) {
  const mode = consultAudienceMode(question);
  const common = [
    '【本轮答复受众与信息层级】',
    `本轮按 ${mode === 'developer' ? '研发' : mode === 'implementation' ? '实施' : '产品/业务'} 受众组织答案。先回答用户真正要做的业务判断，不要把检索过程、文件列表或技术名词当结论。`,
  ];
  if (mode === 'developer') return common.concat([
    '用户明确询问接口、字段、SQL、源码、Java 类或开发调用链；在业务结论之后，可以完整展开有当前证据支持的接口方法与路径、字段、表、类/方法和调用链。不得为了简洁删掉本轮明确追问的技术契约，也不得补造未取证实现。',
    '技术内容按“入口/契约 → 实现链路 → 数据读写 → 边界”组织；原子技术事实题仍直接回答后停止。',
  ]).join('\n');
  if (mode === 'implementation') return common.concat([
    '第一屏先用大白话给业务结论、影响范围和当前能判断到哪；不要用接口、字段、Java 类、表名或源码路径开场。',
    '若用户在现场排查/复测/留证，给 2~4 个可照做的只读编号步骤。每步都要同时写清“看什么/记录什么”和“看到不同结果分别能判断到哪”，只描述观测边界，不把现象直接写成根因。',
    '正文只保留完成这次判断必需的实际请求路径；Java 类、方法、表名、字段及其它研发细节统一压到答案末尾的“研发参考”小节，简短列出。没有必要技术细节时不硬加该小节。',
  ]).join('\n');
  return common.concat([
    '这是普通功能、范围、业务规则或“怎么实现”的业务问法。第一屏直接说业务结论、适用对象/场景、状态边界和用户影响；用产品与实施都能看懂的大白话。',
    '不要输出源码文件名、Java 类/方法名、Controller/Service/Mapper/DTO/VO、数据库表名或代码目录；也不要主动谈“接口路径、字段、状态值、Java 模型、源码、研发参考、技术依据”，更不要用“这轮资料/说明书未写、未确认”收尾。用户下一轮明确追问这些技术契约时再按研发受众展开。',
    '业务结论与对象范围已经答清后立即停止。例如只确认住院范围，就说清住院业务如何工作后停止，不主动追问或评价门诊技术实现是否有资料。',
    '必要的业务状态、页面名称和操作范围可以保留；技术事实只作为内部核验依据，不在正文展示。',
  ]).join('\n');
}

function consultDiagnosticGuard(question, route) {
  const q = String(question || '').trim();
  if (!consultSafeDiagnosticIntent(q)) return '';
  const hasFacts = !!(route && route.matched);
  return [
    '【本轮是实施现场诊断问题】',
    hasFacts
      ? `先说明本轮${route && route.inherited ? '从同会话主题事实账本继承的' : '命中的'} route 能确认的业务事实，并把它作为本轮判断基线；用户说“数据库没权限/只靠页面/目前只能确认请求已发出/还缺什么/复测到这里”只是在说明本轮现场证据边界，不能抹掉 route/正文此前已确认的系统事实，也不能因此整体降级成“说明书未覆盖”。随后分开写“本轮现场已确认”“仍局部未知”；只把 route/当前召回证据未确认的细节局部标为未知，不得用已知部分推测未知部分。`
      : '当前没有足够正文证据确认具体业务规则、按钮、接口、字段、表或状态值；先把这个边界说清，但不能因此只机械索要 spec 或立即转开发。',
    '随后给 2~4 步观察型、非破坏的最小动作：确认实际终端/页面、账号角色、版本和复现前后条件；只观察本次操作是否发出请求，并记录浏览器实际显示的 URL、请求参数、HTTP/业务码与响应；按“没有请求 / 请求失败 / 响应正常但页面错误”分支判断；整理发生时间与脱敏截图。',
    '如果已知首次加载会一次返回多个分组，页签允许只在前端切换这些已有分组：不能要求每切一个页签都必须发新请求，也不能把没有新请求当成失效，除非正文/源码/接口契约明确要求逐页请求。优先只读对比首次响应的各组数量、成员集合以及各组互斥/包含关系；不得通过点开未读、切换已读、星标、审批或提交等改变业务状态的动作来验证。',
    '不得编造按钮名、接口路径、字段名、数据库表、状态值；不得建议反复提交、重复保存、重试或其他可能产生副作用的动作。只追问会改变下一步判断的最少信息，并说明在哪里取得、拿到后如何判断。',
    '用户说只有图、拿不到 spec 或先别让他找 spec 时，先基于当前页面和本次请求完成上述留证，不能继续把找 spec 当第一要求；真正未知的业务事实最后再局部交给对应 Owner 确认。',
  ].join('\n');
}

// 路径前缀/allowlist 的分隔符属于契约本身：不得把 `/x/` 擅自归一化成 `/x`，
// 也不得把路径中间包含同名片段当成前缀命中。该守卫只约束如何复述已核路径事实，
// 不在没有 route/Spec 证据时创造新的白名单路径。
function consultExactPathBoundaryGuard(question, route) {
  const q = String(question || '').trim();
  const routeText = route && route.matched
    ? [route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || [])].filter(Boolean).join(' ')
    : '';
  const topic = `${q} ${routeText}`;
  if (!/(?:路径|前缀|白名单|allowlist|免鉴权|放行|startsWith|中间包含|URL)/i.test(topic)) return '';
  return [
    '【路径前缀与 allowlist 的精确边界】',
    '只能逐字复述 route/Spec/源码已经确认的路径字面量；每一个斜杠和路径段都是契约的一部分。不得去掉或补上尾斜杠，不得把一个已核前缀“归一化”为更宽的形式，也不得新增“部分端点还使用另一个写法”之类没有证据的例外。',
    '若权威事实是 `/comm/`，就只能写 `/comm/`：不得改写成 `/comm`。`/community`、路径中间仅包含 `comm`、或其它相似片段均不等价，也不能据此放行。其它路径前缀同样按完整字面量和分隔符边界判断。',
    '现场判断优先使用已经发生请求的完整 path（从开头到 query 之前）与已有响应；只有路径从第一个字符开始逐字命中已核前缀时，才能按该前缀规则解释。证据里没有出现的路径、例外、端点类型或用途一律不要补。',
    '不得为了说明前缀规则自己构造任何“例如/示例/测试路径”，包括在已核前缀后拼接虚构后缀；回答中只能出现 route/Spec/源码已列出的路径字面量，以及用户本轮实际提供的 path。需要解释正反边界时只用这些已出现的字面量，不造新路径。',
  ].join('\n');
}

// 实施诊断默认只读：模型不能把新建/修改/删除等业务写操作包装成“只做一次的验证”。
// 只有隔离环境/专用数据、授权、回滚清理、幂等与影响范围同时明确时，才允许给受控写操作步骤。
function consultNonDestructiveDiagnosticGuard(question, route) {
  const q = String(question || '').trim();
  const routeText = route && route.matched
    ? [route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || [])].filter(Boolean).join(' ')
    : '';
  const diagnostic = consultSafeDiagnosticIntent(q)
    || /(?:验证|复测|排查|留证|对照|试一下|测试|检查点|下一步|问题还在|怎么判断|如何判断|抓请求|新建|新增|修改|改删|删除|保存|提交|审批|签名|星标|已读|补跑|重跑|重新触发|刷新|只读页签|查看详情)/i.test(`${q} ${routeText}`);
  if (!diagnostic) return '';
  return [
    '【最高优先：实施现场诊断默认只读、非破坏】',
    '禁止为了验证而要求实施新建、修改、删除、保存、提交、完成、审批、签名、切换星标、打开会导致已读的记录、补跑、重跑或重新触发任何业务动作。这些都会改变数据、状态或留痕；“只做一次”“测试数据”“之后能回滚”都不能自动把它们变成只读动作。不得把“观察一次请求”误写成“主动执行一次写操作再抓请求”。',
    '“再点一次”“重做一遍”“复现一下”“下一轮”“同条件再复现”“再复现”“重新操作一次”“重新走一遍”“验证一下”“试试看”“用创建人点”“正常点完成/提交”都不是安全措辞：即使句子没出现“提交/保存”等写入动词，只要被重复的原业务动作是否只读、是否会改状态尚未确认，就一律按潜在副作用处理，不得建议执行。即使当前 route 已经确认按钮、角色、状态或业务结果，也只允许把它作为事实结论，不能顺手追加一次真实完成、提交、签名、审批等现场验证。',
    '优先复用已经存在的证据：对比已有正常记录与异常记录、历史日志/审计、用户刚才已经发生的请求与响应、页面当前只读信息，或测试环境里已存在且明确授权的对照数据。刷新、切换已确认是纯前端或只读的页签、查看已确认不会触发已读或业务状态变化的详情，属于可用观察动作；若详情打开会标已读，则仍禁止用它验证。',
    '消息、通知、患教、咨询等场景中，“当面确认/看看患者端/点进去看状态”也不默认是只读：打开可能会标记已读、已接收或完成。未确认无副作用时，只读使用当前已显示的页面、已有截图、历史状态、已有请求/响应与审计；不得要求患者或实施新打开、新点进详情来验证。',
    '如果缺少本次请求，默认接受“当前无法安全补抓”，先用已有请求、日志、审计或历史记录；只有已经明确被重复的动作本身是只读且不会改变任何业务状态，才可让现场单次执行以观察请求。若只读性未知或动作会改状态，则必须同时明确：1. 隔离测试环境或专用测试数据；2. 明确执行授权；3. 回滚/清理方案；4. 幂等性与影响范围。任一项没有确认，就停止给现场写操作步骤，整理“已知事实、已有正常/异常证据、仍缺哪一层”后升级开发或产品确认。',
    '当前 route/Spec 已确认的方法授权、owner、机构范围或状态规则仍须作为判断基线；本守卫只限制诊断动作，不得把已知事实重新降级为未知，也不得借安全名义改用猜测。',
  ].join('\n');
}

// 发布前动作一致性审计：模型常会在同一答案前半段说“不要操作”，后半段又把点击写操作加回来。
// 该守卫要求对最终答案的所有段落/表格/分支做一次整体动作分类，删除与只读边界冲突的指令；
// 不向纯事实题强塞排查步骤，也不改变已有 route/Spec 事实。
function consultFinalActionConsistencyGuard(question, route) {
  const q = String(question || '').trim();
  const routeText = route && route.matched
    ? [route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || [])].filter(Boolean).join(' ')
    : '';
  const topic = `${q} ${routeText}`;
  const actionOrDiagnostic = consultSafeDiagnosticIntent(q)
    || /(?:按钮.*(?:请求|抓包|发出)|是否发请求|有没有请求|验证|复测|排查|留证|下一步|怎么判断|如何判断|怎么确认|检查|观察|点击|点开|打开|编辑|删除|新建|保存|提交|发送|完成|签名|审批|星标|已读|改(?:参数|报文|类型|映射|配置)|对接方|运维|开发.*(?:重试|复测)|重试|复现|补跑|重跑|重新触发|刷新|页签|详情)/i.test(topic);
  if (!actionOrDiagnostic) return '';
  return [
    '【发布前动作一致性审计：必须在输出最终答案前完成】',
    '先在内部逐条扫描准备输出的整份答案，包括开头结论、正文、Markdown 表格每个单元格、编号步骤、条件分支、补充说明、示例和结尾追问；找出每一条让实施、用户、患者、对接方、运维或开发去执行、点击、打开、修改、重做或观察的动作。不要向用户展示审计过程，只输出审计后的答案。',
    '每个动作只能归入三类后保留：A. 读取当前已显示页面、已有请求/响应、原始报文、已有映射、截图、历史记录、日志或审计；B. route/Spec/源码已经明确证明无副作用的刷新、列表/只读页签切换或查看；C. 隔离环境或专用数据、明确授权、回滚/清理、幂等性与影响范围全部齐全后的条件式单次受控动作。',
    '编辑、删除、新建、保存、提交、发送、完成、签名、审批、星标、可能标记已读的打开、改参数、改报文类型、改映射、改配置、重试、复现、补跑或重跑，只要不能归入 B 或 C，就必须从最终答案所有位置删除，改成检查已有页面、请求、响应、报文、映射、截图、日志或审计。动作换成由第三方执行也不改变副作用：不得写成“让对接方改字符串/参数/映射/配置后用同一患者复测”“让运维重跑”或“让开发重试”来绕过守卫。不能因为同一答案别处写了“不要操作”“只读”“别重复”，就保留这里的正向点击或重做指令；否定提醒不能抵消冲突动作。',
    '若最终答案任何一处说“不要操作/不要重复/只读”，则其它任何一处都不得再建议点击编辑、删除、发送、完成等未知动作来观察是否发请求，也不得用“点了是否被拦住”“试一下看看”之类问句变相放行。用户只问“这个按钮是否发请求”时，只能查已有请求、日志、审计、代码或契约；没有既有证据就局部说明当前无法安全确认，不能让现场点击未知按钮补抓。',
    '发布前还要核对步骤和对照项的编号引用：后文引用①②③④等序号时，每个序号都必须在本答案前文有明确对应项；不得出现“共三项”却引用④、表格只定义①②③却在判断或小结写③/④等未定义引用。顶层阿拉伯数字步骤默认必须从1开始并按正文出现顺序连续递增，不得从3起步、从1、2、3直接跳到5或重复编号；只有用户本轮明确说到“第N步/做到第N步”时，才允许从N或N+1承接。已有完整步骤只能重编号，不能为补缺号新增步骤或事实。发现后必须删除含未定义序号的完整句/完整表格行，或在不新增事实的前提下改回已经定义的序号。',
    '结构化答案还必须逐项核对“声明数量 → 实际内容”：声称二/三/四边、项、份、件、条、处或个对照时，紧随其后的对照表或 Markdown 清单必须确实给出相同数量的完整项；不得用一行表格冒充“三边对照”，也不得说“核两件事”却只列一项。明确要求“请回/回复/提供/补充/核对 N 行、列、组、种、类”时，紧随列表或表格也必须有相同数量，后文不得继续引用已经被清理掉的“N行”；普通事实“数据表有4列/已有4行数据”不是回复格式契约。同一小节里“确认/回复/补充/核对 N 件/项/点/条/行/列/组/种/类”等结构数量不得漂移；终稿删句后必须重新计数，统一为实际内容或删除数量承诺及其后续引用，绝不为凑数补造。“例如：/如下：/包括：/包含：/内容为：/由以下组成：/分别为：”后必须有实际内容，“里面有：”同样受此约束；无论跨块还是同一 paragraph，都不能在没有枚举、字段、代码或列表时直接跳到“别搞混/注意/结论/下一步”等新语义分句；任何以冒号结尾的标题/提示语都不得出现在正文末尾而没有子内容。清理并列项后不得留下孤立的“还是页面…/或者接口…”等后半分支，也不得留下以“还是/或者/或是/或”结尾却没有后一项的前半分支；不得在答案开头或“结论/判断”等纯标题后直接留下没有前述主张的“但/但是/不过/然而”转折残句。删除示例或引用正文时必须连同整句引号一起删除，不得留下单独一行的「/」/“/”/『/』等孤立引号。明确要求对照/比较/分支判断时，若使用“一致/不一致、是/否、有/无、成功/失败、存在/不存在、命中/未命中”等成对标签，必须给齐两边，或改写成不承诺另一边的单一直接结论；不得只列“一致”后直接跳到未标注的另一种判断。“不要做/禁止/避免/切勿”等否定标题下不得只剩“可以/建议/请/应该/优先/最好/即可/帮你”等正向建议；正向替代动作必须移到独立的“可以做/下一步”标题下。用户明确只问“先做哪个验证/第一步做什么”时，只给一个最小只读验证，不追加第二、第三步或可转发的修改指令。',
    '同一局部的结构数量不得从 1 漂成 2；这里也包括行、列、组、种、类等带明确回复动作的数量声明。',
    '最终稿中的每个有序/无序列表项若只剩粗体步骤标题，后面必须有正文或子项；若直接遇到分隔线、新节、下一同级列表项或答案结束，删除该空列表项，不得补造内容。每个自然句也必须完整收口：行尾逗号、分号或冒号后必须有同句后半段或紧邻正文；若直接进入分隔线、新节、统一安全尾注或答案结束，删除该悬空完整句。列表项内部的正常分号、下一行有真实正文/子项及以句号/问号/叹号完整结束的粗体单句不得误删。',
    '普通行、粗体行或 Markdown heading 形式的“N. 步骤标题”都必须有自己的正文、表格、列表或代码块；水平分隔线不算步骤内容。若到下一同级编号步骤、分隔线、新节或文末仍无内容，删除该空编号步骤；删除后只把剩余已有步骤连续重编号，不得补造缺失步骤。四空格缩进的嵌套步骤属于父步骤内容，不参与顶层编号。',
    '用户问“只有这份证据/没有另一份证据，够不够、是否足够、能不能判断”时，第一句话必须明确回答：现有证据够完成什么、不够完成什么；随后只从 current/inherited route 的直接事实和已核主接口给最小缺口，不得退成页面、终端、账号、版本等跨主题通用材料清单。用户明确索要完整提单/转开发材料清单时才可给通用清单。若本轮没有可核验附件，不得声称看见截图里的数字或内容。',
    '若答案声明“最小证据/最小输入/只缺 N 项”，后续诊断结论或分支表使用的每个观测变量，都必须已在用户本轮明确具备的证据或此前“已有/需补/采集”清单中定义。不得在最小清单只列接口响应，却在判断表首次引入本机日期、浏览器时间、日志等第二个输入；发现时补回草稿/current route 已有的安全观测项，或删除依赖未定义变量的判断结构，不得补造业务事实。',
    '若答案用 A/B/C 等单字母、编号或短符号做“=、≠、>、<、vs”组合判断，必须在第一次比较之前逐一明确绑定每个符号的含义（如 A=页面、B=接口、C=本机，或用符号—含义表）。只在前文自然语列出三项、事后再写自然语结论，都不能反向补定义；表头直接使用页面/接口/本机等具体名称时无需引入符号。未定义时改写成已知具体观测名；映射没有证据时删除该分支块，不得猜。合法数学常量、HTTP 状态码和 JSON key 不按诊断符号处理。',
    '所有“进入/回到/按第 N 步”的引用都必须在此前已有顶层 N. 步骤或“第N步：”定义；后文定义不能反向补足，只有用户本轮明确说已到第N步时可承接。“N选一/以下N类”必须紧随实际 N 个选项；字母选项从 A 连续，数字/圈号同样连续。后文用 A/B/C、A、B、C、A-C 归类时，每个字母必须已在此前选项、符号正文或符号表定义。缺项时删除不完整声明/引用；仅已有选项从起点连续时可把数量改为实际值，不得补造缺失分支。普通 A/B 测试、API 缩写与路径不按选项引用处理。',
    '该审计只删除不安全或互相矛盾的动作，不新增业务事实，也不给纯事实回答强加诊断步骤。若用户只问事实且现有证据已经足够，直接回答后停止；若已明确动作只读，可保留相应只读观察；若受控条件全部齐全，可条件式说明单次受控验证。',
  ].join('\n');
}

// 最终证据/概率语言审计：不允许把没有正文、源码、已核经验或统计样本支撑的成因写成
// “最高频/常见/大概率”，也不允许核心事实答完后顺手补经验性实现故事。
function consultEvidenceLikelihoodGuard(question, route) {
  const q = String(question || '').trim();
  if (!q) return '';
  const routeText = route && route.matched
    ? [route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || [])].filter(Boolean).join(' ')
    : '';
  return [
    '【最终证据与概率语言审计：必须在输出最终答案前完成】',
    '逐句扫描最终答案里的原因、归因、优先级、概率、比例与因果确定措辞。只有当前有效的 Spec 正文、源码、已核经验库或统计样本直接写明频率、默认值、排序、典型性、比例或确定因果时，才能照实使用“最高频”“最常见”“常见/很常见/较常见/比较常见”“经常”“通常”“一般”“大概率”“多半”“往往”“多发/高发”“很多/不少/多数/大多/绝大多数”“少数/极少/大部分/小部分/几乎全部”“首要原因/主要原因（之一）”“典型原因”“常见于”“很可能”“很容易丢位/丢精度”“高度/强烈/明显/更/较/比较符合某个原因”，以及“一定会/必然/肯定会/就会直接导致”“就是某方传错或配置错”等因果定论，并保留证据限定。route 标题相似、行业经验、模型常识或本轮单一现象都不构成频率、比例或确定因果证据。',
    '没有直接频率证据时，删除上述概率定性和任何隐含排序；只能列不排序的“待验证假设/可能分支”。排查顺序只能依据本轮已有页面、请求、响应、原始报文、日志或审计里已经观察到的差异来决定，并明确写出该证据差异，不能把待验证假设包装成“先看这一边”。用户转述“医院说/电话里说/对接方称/怀疑/感觉/好像”的现象与归因，只能作为待核线索，不能当成确定因果或概率证据；答案必须把“原话”与“已核报文/响应差异”分开。',
    '诊断内容逐句只归为四类：①route/Spec 已核事实；②用户本轮已经提供的观察；③明确标成“待验证假设/可能分支”的未核原因；④通过动作一致性门的只读或受控动作。前端、后端、服务端、缓存、网关、鉴权、权限、数据库、配置、调度、部署或环境等组件故障，若用户或 route 没有直接确认，只能写成待验证假设，不能在条件分支、表格或小结中写成定论。有序观测点必须保持时间方向：若原始值 A 到报文/请求 B 时已经不同，只能确认差异不晚于 B，不能又说发生在 B 之后；只有 A=B 且后续收到/落库/页面 C 不同时，才可把差异边界收敛到 B 之后、C 之前。',
    '具体技术机制只允许来自用户本轮原文或 current/inherited route facts/refs。未点名缓存、数据源、错误兜底、本地存储、消息队列、中间件、代理层或网关时，不得为了解释现象自行引入；只能退回不点名具体机制的“页面呈现链路待验证”等局部边界。',
    '核心事实题或已定位的共享键、字段类型、接口契约答清后立即停止；不得追加“改过模板、复制/重存、历史兼容、行业里经常如此”等经验成因。若用户明确问原因但证据只支持链路边界，就只说能定位到哪一层以及仍待验证的分支。',
    '本轮问题与已核 route 主题仅供证据边界判断，不自动生成事实：' + (routeText || '当前无 route 直接事实') + '。审计过程不要展示给用户，只输出删除无证据概率判断后的最终答案。',
  ].join('\n');
}

const CONSULT_LIKELIHOOD_WORD_RE = /(?:最高频|最常见|(?:很|较|比较)?常见(?:原因|问题|场景)?|经常|通常|一般|大概率|多半|往往|(?:高度|强烈|明显|更|较|比较)符合|(?:很|较|更|比较)?可能(?:(?:就|会|在|从|由)?(?:发生|出现|导致|造成|意味着|表明|说明|丢失|丢位|丢精度|截断|变更|变化|失败|异常|不一致|对不上|不符|偏差))|(?:较|更|比较)可能(?:在|从|由)[^。！？；\n]{1,24}|可能(?!分支)[^。！？；\n]{0,18}(?:丢(?:失|位|精度)?|少位|截断|失败|异常|错误|出错|不一致|对不上|不符|偏差)|多发|高发|很多|不少|多数|大多(?:数)?|绝大多数|少数|极少|大部分|小部分|几乎全部|频繁|偶尔|有时|首要原因|主要原因(?:之一)?|典型原因|常见于|可能是|(?:很|更|比较)?像(?=[“"'A-Za-z\u4e00-\u9fff])|看起来(?:很|更)?像|疑似|倾向于|(?:最|很|更|较|比较|尤其)?容易[^。！？；，,\n]{0,18}(?:出现|发生|对不上|不一致|不符|偏差|不同|出错|导致|造成|暴露|碰到|遇到|复现|触发|丢(?:失|位|精度)?|截断|变(?:成|为|更)|漏(?:位|传|掉)?|失败|异常|混淆)|尤其(?:是|在)?[^。！？；\n]{0,18}(?:时|情况下|场景|前后)|尤其(?:接近|临近|靠近|恰逢)[^。！？；\n]{0,12}(?:午夜|零点|日切|跨日|月末|年末|边界)|易(?:发|出现|发生|错)|(?:(?:就会|会直接|必然(?:会)?|必定(?:会)?|一定(?:会)?|肯定(?:会)?|绝对(?:会)?|直接(?:导致|造成|引发))[^。！？；\n]{0,18}(?:丢(?:失|位|精度)?|少位|截断|失败|异常|错误|出错|变化|变(?:成|为)|损坏|拒绝))|(?:(?:就是|说明|证明|表明|意味着)[^。！？；\n]{0,28}(?:传错|类型错|配错|改坏|故障|错误|出错)))/g;
// “在某个观测点已经看到变化”只证明变化不晚于该观测点，不能自动定位到具体实现机制或责任层。
// 例如出站报文已经少位，可以保留“出站报文中已变化”，但不能无证据写成“发生在传参/序列化侧”。
const CONSULT_CAUSAL_LOCALIZATION_RE = /(?:(?:(?:→|=>|所以|因此|说明|表明|证明|意味着|可判定|可以判定|能够判定|由此可见)[^。！？；\n]{0,24})?(?:丢(?:失|位|精度)?|截断|变化|异常|错误|问题|故障|根因|责任)[^。！？；\n]{0,12}(?:发生|出|在|位于|定位|归因|归属)(?:在|于|到|为)?[^。！？；\n]{0,24}(?:传参|序列化|反序列化|类型转换|格式转换|映射|缓存|网关|前端|后端|服务端|数据库|中间件|对接方|第三方|上游|生成号|Excel|中间系统)(?:侧|层|环节|阶段|过程)?|(?:→|=>|所以|因此|说明|表明|证明|意味着|可判定|可以判定|能够判定|由此可见)[^。！？；\n]{0,96}(?:线程|进程|网络|连接|Redis|缓存|网关|前端|后端|服务端|数据库|数据格式|字段格式|库约束|数据库约束|序列化|反序列化|类型转换|配置|权限|鉴权|调度|部署|环境|中间件|对接方|第三方|上游|下游)[^。！？；\n]{0,24}(?:未启动|未运行|未消费|假死|异常|故障|错误|失败|问题)|(?:当前|该|本次)?(?:故障|异常|错误|问题|失败|根因|原因)[^。！？；\n]{0,18}(?:属|属于|归为|定位为|归因于|是|为)[^。！？；\n]{0,48}(?:问题|异常|故障|原因|层|侧|环节)|(?:日志|记录)[^。！？；\n]{0,30}(?:没有|无|未见|未记录)[^。！？；\n]{0,24}(?:→|=>|所以|因此|说明|表明|证明|意味着)[^。！？；\n]{0,30}(?:没有|未)(?:消费|启动|运行|写入|执行))/gi;
// 无证据确定故障还会绕成“会出现少位”“就是会丢位的写法”，既不带概率副词也不写“发生在某层”。
// 否定句（不会出现/不会丢位）不属于正向故障断言；权威 route 对同一 claim 有明确规则时仍可放行。
const CONSULT_DETERMINISTIC_FAILURE_RE = /(?:(?<!不)(?<!未)(?:会|就会)(?:直接)?(?:出现|发生|导致|造成|引发)?[^。！？；\n]{0,18}(?:丢(?:失|位|精度)?|少位|截断|失败|异常|错误|出错|对不上|末尾变\s*0)|就是[^。！？；\n]{0,12}(?<!不)(?:会|必然会)[^。！？；\n]{0,12}(?:丢(?:失|位|精度)?|少位|截断|失败|异常|错误|出错|对不上)[^。！？；\n]{0,10}(?:写法|类型|格式|传法|结果)?)/g;
// 有序观测点已经出现差异时，不能把发生边界反向推到该观测点之后。
// 表格行也按整行审计，避免“B 已不同 → 问题可能在 B 后”躲在分支单元格中。
const CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE = /(?:请求|报文|响应|收到值|接收值|落库值|页面|展示)[^。！？；\n]{0,36}(?:与|和|≠)[^。！？；\n]{0,18}(?:原始|源端|上一步|前一层)[^。！？；\n]{0,18}(?:不一致|不同|已变化|少位|变样)[^。！？；\n]{0,64}(?:问题|差异|变化|异常)[^。！？；\n]{0,16}(?:可能|说明|表明|意味着)?[^。！？；\n]{0,16}(?:在|于)?(?:发出|该?(?:请求|报文|响应|收到|接收|落库|页面|展示))(?:后|之后|下游)/gi;
const CONSULT_CAUSAL_PRIORITY_RE = /(?:优先|首先|先)(?:去)?(?:查|看|排查|核对|怀疑|判断|考虑)(?:服务端|服务器|JVM|前端|缓存|错误兜底|网关|登录态|权限|调度|数据库|配置)[^。！？；\n]{0,18}/g;
const CONSULT_DIRECT_RISKY_ACTION_RE = /(?:(?:只能|需要|应当|应该|建议|可以|可|先|再|然后|去|请|让|由|交给|通知|要求)[^。！？；\n]{0,20}(?:改|修改|调整|切换|对齐|校准|统一|转换|修(?:复)?)[^。！？；\n]{0,16}(?:参数|传参(?:方式)?|传输方式|接口入参|报文(?:类型)?|序列化(?:口径|方式|规则)?|编码(?:口径|方式|规则)?|协议(?:口径|规则)?|映射|结构|关联|链路|配置|部署时区|时区|系统时间|环境|产品口径|业务口径|日切要求|服务配置|字符串|数字(?:类型)?|字段格式|数据格式|值类型)|(?:参数|传参(?:方式)?|传输方式|接口入参|报文(?:类型)?|序列化(?:口径|方式|规则)?|编码(?:口径|方式|规则)?|协议(?:口径|规则)?|映射|结构|关联|链路|配置|部署时区|时区|系统时间|产品口径|业务口径|日切要求|服务配置|字符串|数字(?:类型)?|字段格式|数据格式|值类型)[^。！？；\n]{0,24}(?:交给|让|由)[^。！？；\n]{0,16}(?:改|修改|调整|切换|对齐|校准|统一|转换|修(?:复)?)|(?:改|修改|调整|转换|修(?:复)?)(?:成|为)?(?:字符串|数字(?:类型)?|字段格式|数据格式|值类型|传参(?:方式)?|传输方式|序列化(?:口径|方式|规则)?|编码(?:口径|方式|规则)?|协议(?:口径|规则)?|结构|关联|链路)[^。！？；\n]{0,12}(?:再传|重传|重新发送|复测)|(?:压|催|催促|推动|协调)[^。！？；\n]{0,8}(?:对接(?:方)?|接口方|第三方|厂商|供应商|院方|运维|开发)[^。！？；\n]{0,20}(?:按|以)(?:字符串|数字(?:类型)?|指定格式|文本格式|字段格式|数据格式|值类型)[^。！？；\n]{0,8}(?:传|发送)|(?:(?:只能|需要|应当|应该|建议|可以|可|先|再|然后|去|请|让|由|交给|通知|要求)[^。！？；\n]{0,12})?(?<!不)(?<!未)(?:修|修复|修改|调整)(?:接口(?:可用性|契约|响应(?:格式|字段)|返回格式|实现)?|服务(?:可用性|契约|配置)?|响应(?:格式|字段|契约)|返回格式))/ig;
const CONSULT_COMPONENT_FAULT_RE = /(?:服务端|服务器|JVM|前端|后端|缓存|网关|鉴权|权限|数据库|配置|调度|部署|环境)[^。！？；\n]{0,16}(?:异常|故障|问题|错误|不对|有误)/ig;

function consultHasLikelihoodEvidence(question, route, claim = '') {
  const q = String(question || '').trim();
  const userSample = /(?:统计|样本|抽样|最近|近)\s*(?:了|的)?\s*\d+\s*(?:次|条|例|份)[^。；\n]{0,30}(?:其中|有|占)\s*\d+|(?:占比|比例|频率)\s*(?:为|是|达到)?\s*\d+(?:\.\d+)?\s*%|百分之\s*[零一二三四五六七八九十百\d]+/i.test(q);
  const frequencyEvidenceRe = /(?:统计样本|抽样结果|发生频率|占比|比例|百分之|\d+(?:\.\d+)?\s*%|明确(?:规定|定义|写明)[^。；\n]{0,24}(?:最高频|最常见|(?:很|较|比较)?常见|经常|通常|一般|大概率|多半|往往|多发|高发|很多|不少|多数|大多(?:数)?|绝大多数|少数|极少|大部分|小部分|几乎全部|频繁|偶尔|有时|首要原因|主要原因|典型原因|常见于|(?:高度|强烈|明显|更|较|比较)符合)|(?:最高频|最常见|(?:很|较|比较)?常见|经常|通常|一般|大概率|多半|往往|多发|高发|很多|不少|多数|大多(?:数)?|绝大多数|少数|极少|大部分|小部分|几乎全部|频繁|偶尔|有时|首要原因|主要原因|典型原因|常见于|(?:高度|强烈|明显|更|较|比较)符合)[^。；\n]{0,24}(?:规则|结论|定义|统计|样本|比例))/i;
  const deterministicEvidenceRe = /(?:明确|已核|已确认|说明书|契约|源码|规则)[^。；\n]{0,32}(?:一旦|只要|如果|若|必然|必定|一定|肯定|必须|拒绝|导致|造成|传错|类型错|根因|原因|故障|异常|错误|归因|属于|定位)|(?:一旦|只要|如果|若)[^。；\n]{0,32}(?:就会|必然|必定|一定|肯定|必须|拒绝|导致|造成)|(?:原始|完整)?(?:日志|堆栈|error_info|错误流水|错误码|响应原文)[^。；\n]{0,40}(?:明确|显示|记录|包含|报(?:错)?|定位)[^。；\n]{0,40}(?:异常|故障|错误|失败|根因|原因|未启动|假死)/i;
  const routeFactTexts = route && route.matched
    ? [...(route.answerFacts || []), ...(route.mustNotConfuse || []), ...(route.directEvidenceFacts || [])].map(String).filter(Boolean)
    : [];
  const routeFactClauses = routeFactTexts.flatMap(source => source.split(/[。！？；;\n]/u).map(clause => clause.trim()).filter(Boolean));
  const routeEvidence = routeFactTexts.filter(item => frequencyEvidenceRe.test(String(item || '')) || deterministicEvidenceRe.test(String(item || '')));
  const evidenceTexts = [...((userSample || deterministicEvidenceRe.test(q)) ? [q] : []), ...routeEvidence.map(String)];
  if (!String(claim || '').trim()) return evidenceTexts.length > 0;
  const normalizeClaimText = value => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const normalizedClaim = normalizeClaimText(claim);
  const normalizeRoutedClause = value => normalizeClaimText(value)
    .replace(/^(?:业务结论|产品|入口|当前页面|统一入口|接入入口与主接口|接口|数据与状态|状态|任务和警示|生成记录|停止|前端证据边界|实施只读清单|实施只读核对|端到端边界|外部依赖|留痕|当前停点|影响|实施|时间|约束|排班|结果|边界|后端边界)*/u, '');
  // A route fact is already reviewed evidence. Preserve a probability/status
  // boundary when the answer quotes that fact verbatim, without authorizing
  // a model-invented variant merely because it shares a few tokens.
  if (normalizedClaim.length >= 6 && routeFactClauses.some(source => normalizeRoutedClause(source) === normalizeRoutedClause(claim))) return true;
  if (!evidenceTexts.length) return false;
  if (normalizedClaim.length >= 6 && evidenceTexts.some(source => normalizeClaimText(source).includes(normalizedClaim))) return true;
  const claimTokens = (value) => {
    const cleaned = String(value || '').toLowerCase()
      .replace(CONSULT_LIKELIHOOD_WORD_RE, ' ')
      .replace(/(?:统计样本|抽样结果|最近|近|其中|确认|明确|写明|规定|定义|基于|给的|原因|问题|情况|属于|规则内|预期|的是|是|有|占比|比例|频率|百分之|\d+(?:\.\d+)?\s*%?)/g, ' ')
      .replace(/[^\p{L}\p{N}_]+/gu, ' ');
    CONSULT_LIKELIHOOD_WORD_RE.lastIndex = 0;
    const tokens = new Set(cleaned.match(/[a-z_][a-z0-9_]{2,}/g) || []);
    for (const chunk of cleaned.match(/[\u4e00-\u9fff]{2,}/g) || []) {
      tokens.add(chunk);
      for (let i = 0; i < chunk.length - 1; i += 1) tokens.add(chunk.slice(i, i + 2));
    }
    return tokens;
  };
  const target = claimTokens(claim);
  if (!target.size) return false;
  return evidenceTexts.some(source => {
    const sourceTokens = claimTokens(source);
    let overlaps = 0;
    for (const token of target) {
      if (sourceTokens.has(token)) overlaps += token.length > 2 ? 2 : 1;
    }
    return overlaps >= 2;
  });
}

function consultHasCausalPriorityEvidence(question, route) {
  const q = String(question || '').trim();
  const routeText = consultRouteScopeText(route);
  const observedDifference = /(?:页面|接口|响应|请求|本机|服务器|JVM)[^。；\n]{0,24}(?:=|≠|一致|不一致|不同|只差|缺失|没有|未发出|失败|4\d\d|5\d\d|业务码)[^。；\n]{0,24}/i.test(q);
  const routedOrder = /(?:明确|规定|已核|说明书)[^。；\n]{0,32}(?:排查顺序|优先(?:查|看|排查|核对)|先[^。；\n]{0,16}再)/i.test(routeText);
  return observedDifference || routedOrder;
}

function consultUnsupportedComponentClaims(answer, question, route) {
  const q = String(question || '').trim();
  if (!/(?:排查|不一致|对不上|异常|故障|现场|验证|复测|下一步|怎么判断|如何判断|怎么确认|检查|留证|只能确认|能确定|不知道|未知|走到哪|还缺什么)/i.test(q)) return [];
  const evidence = `${q}\n${consultRouteScopeText(route)}`;
  const hypothesisLabel = /(?:待验证|可能分支|待核|需(?:要)?确认|尚未确认|不能确认|无法确认|核对是否|确认是否|(?:若|如果)?(?:已经|已)?确认[^。！？；\n]{0,24}(?:后|时))/i;
  return String(answer || '').split(/(?<=[。！？；\n])/u).map(x => x.trim()).filter(statement => {
    if (!statement || hypothesisLabel.test(statement)) return false;
    const matches = Array.from(statement.matchAll(CONSULT_COMPONENT_FAULT_RE));
    if (!matches.length) return false;
    return matches.some(match => {
      const component = String(match[0] || '').match(/服务端|服务器|JVM|前端|后端|缓存|网关|鉴权|权限|数据库|配置|调度|部署|环境/i)?.[0];
      if (!component) return false;
      const escaped = component.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return !new RegExp(`(?:${escaped}[^。！？；\\n]{0,16}(?:异常|故障|问题|错误|不对|有误)|(?:已核|已确认|确认|明确|发现|显示|证明|复现)[^。！？；\\n]{0,20}${escaped})`, 'i').test(evidence);
    });
  });
}

function consultHasControlledActionBundle(question) {
  const q = String(question || '').trim();
  return /(?:隔离测试环境|专用测试数据)/i.test(q)
    && /(?:授权|批准)/i.test(q)
    && /(?:回滚|清理)/i.test(q)
    && /(?:幂等|补偿)/i.test(q)
    && /(?:影响范围|数据范围|执行范围)/i.test(q);
}

function consultConcretePaths(text) {
  const source = String(text || '');
  const absolute = source.match(/(?<![\p{L}\p{N}_.{}<>:-])(?:(?:…|\.{2,})\s*)?\/(?:[A-Za-z0-9_.{}<>:-]+\/)*(?:[A-Za-z0-9_.{}<>:-]+|\*)\/?(?:\?[A-Za-z0-9_./?={}&<>:%+-]*)?/gu) || [];
  const relative = (source.match(/(?<![\p{L}\p{N}_.{}<>:\/-])(?:[A-Za-z0-9_.{}<>:-]+\/)+(?:[A-Za-z0-9_.{}<>:-]+|\*)(?:\?[A-Za-z0-9_./?={}&<>:%+-]*)?/gu) || [])
    .filter(token => /[A-Za-z]/.test(token))
    .filter(token => !/^\d{2,4}\/\d{1,2}\/\d{1,2}$/.test(token))
    .filter(token => !token.split(/[/?]/).filter(Boolean).every(segment => /^[A-Za-z][A-Za-z0-9]*(?:Id|ID|Code|Status|No|Type)$/.test(segment)))
    .filter(token => token.split(/[/?]/).some(segment => segment.length > 2));
  return Array.from(new Set([...absolute, ...relative]
    // 查询签名会用 `param=...` 表示参数占位；这里只清理句末的
    // 单个英文句点，不能把占位省略号删成 `param=`，否则确定性
    // chain 终稿会被同一审计器误判为缺少已发布的接口签名。
    .map(x => x.replace(/[),;，。；：]+$/g, '').replace(/(?<!\.)\.$/u, ''))
    .filter(Boolean)));
}

function consultRouteScopeText(route) {
  if (!route || !route.matched) return '';
  const refs = [...(route.primaryRefs || []), ...(route.contextRefs || []), ...(route.specRefs || [])];
  return [route.route && route.route.id, route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || []),
    ...(route.directEvidenceFacts || []),
    ...refs.flatMap(ref => ref && typeof ref === 'object' ? [ref.specId, ref.title, ref.path, ref.section, ref.anchor] : [ref])]
    .filter(Boolean).join(' ');
}

function consultScopeEntityTerms() {
  return ['外部调度', '调度', '补跑', '重跑', '统计同步', '同步任务', 'ETL', '批处理', '折线图', '患教', '患者教育', '收费', '退费', '药师反馈', '反馈', '监护', '药物重整', '医嘱干预', '患者列表', '患者三元身份', '患者身份', '患者入参', '患者参数', '用药咨询', '医生', '药师', '订单', '患者', 'AI 状态', 'AI状态'];
}

function consultDiagnosticMechanismTerms(text) {
  const matches = String(text || '').match(/(?:缓存|数据源|错误兜底|本地存储|消息队列|中间件|中间层|中间系统|Excel|代理层|网关|东八区|\b(?:JavaScript|JS|Number)\b|(?:UTC|GMT)\s*[+-]?\d{1,2}(?::\d{2})?|Asia\/Shanghai)/gi) || [];
  return Array.from(new Set(matches.map(term => /^(?:javascript|js)$/i.test(term) ? 'JavaScript' : term)));
}

function consultScopeTechnicalTokens(text) {
  const source = String(text || '');
  // UUID 是一个完整的技术词，不应被下面的通用 `...ID` 后缀规则拆成
  // 一个看似字段名的 token。统一成小写 canonical token，保证问题里的
  // `uuid` 与答案里的 `UUID` 命中同一作用域；其它字段 token 的规则保持不变。
  const uuidTokens = (source.match(/\buuid\b/ig) || []).map(() => 'uuid');
  const tokens = [
    ...uuidTokens,
    ...(source.match(/\b[A-Za-z][A-Za-z0-9]*(?:Id|ID|Code|Status|No|Type)\b/g) || []),
    ...(source.match(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g) || []),
  ];
  const shared = new Set(['id', 'code', 'status', 'type', 'user', 'patient', 'http', 'https', 'url', 'uri', 'api', 'json', 'jwt', 'get', 'post', 'put', 'delete', 'year', 'week']);
  return Array.from(new Set(tokens
    .map(token => /^uuid$/i.test(token) ? 'uuid' : token)
    .filter(token => token.length > 2 && !shared.has(token.toLowerCase()))));
}

function consultMalformedMarkdownTokens(text) {
  const source = String(text || '');
  const issues = [];
  if (((source.match(/\*\*/g) || []).length % 2) !== 0) issues.push('unbalanced_bold');
  if (((source.match(/```/g) || []).length % 2) !== 0) issues.push('unbalanced_fence');
  const withoutFences = source.replace(/```/g, '');
  if (((withoutFences.match(/`/g) || []).length % 2) !== 0) issues.push('unbalanced_code');
  return issues;
}

function consultMalformedProseTokens(text) {
  const source = String(text || '').replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  const pairs = [
    ['(', ')', 'unbalanced_ascii_paren'], ['（', '）', 'unbalanced_cjk_paren'], ['【', '】', 'unbalanced_cjk_bracket'],
    ['「', '」', 'unbalanced_cjk_corner_quote'], ['『', '』', 'unbalanced_cjk_double_corner_quote'],
    ['“', '”', 'unbalanced_cjk_double_quote'], ['‘', '’', 'unbalanced_cjk_single_quote'],
  ];
  const issues = [];
  for (const [open, close, label] of pairs) {
    let depth = 0, invalid = false;
    for (const ch of source) {
      if (ch === open) depth += 1;
      else if (ch === close) {
        depth -= 1;
        if (depth < 0) { invalid = true; break; }
      }
    }
    if (invalid || depth !== 0) issues.push(label);
  }
  // 终稿删去越界字段后可能留下“主表的可能空”这类缺少中心语的残句；
  // “字段的值可能为空”不命中，因为“的”后仍有明确中心语“值”。
  if (/(?:的|为)(?:可能|大概率|通常|一般)(?:为)?(?:空|为空|缺失|没有)/u.test(source)) issues.push('dangling_modal_subject');
  // 安全清理删除示例正文后，可能只剩单独的右引号（甚至一整行只有引号/标点）。
  // 这种文本 Markdown 语法上合法，但对用户是明显的残稿，必须在最终发布前拦住。
  if (source.split('\n').some(line => /^[\s>*_`#\-+]*(?:[「」『』“”‘’])+[\s。！？；：,.!?;:]*$/u.test(line) && /[「」『』“”‘’]/u.test(line))) {
    issues.push('orphaned_quote_line');
  }
  // 删句后可能只剩“除 JwtFilter 明确放行的 /comm”：它没有“之外/其余……”
  // 的主句，即使 Markdown 和括号都闭合也是不可发布的半截句。
  if (source.split('\n').some(line => {
    const plain = String(line || '').replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '').trim();
    return /^除(?!非)[^，,。！？；;\n]{1,120}$/u.test(plain)
      && !/(?:之外|以外|外，|外,|其余|其他|都|均|仍|还|请求|需|应|不得|不能|允许|禁止)/u.test(plain.slice(1));
  })) issues.push('dangling_except_clause');
  return issues;
}

function consultMarkdownTableCells(line) {
  const source = String(line || '').trim();
  if ((source.match(/(?<!\\)\|/g) || []).length < 2) return null;
  return source.replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(cell => cell.trim());
}

function consultMalformedTableTokens(text) {
  const lines = String(text || '').split('\n');
  const issues = [];
  for (let i = 0; i < lines.length;) {
    if (!consultMarkdownTableCells(lines[i])) { i += 1; continue; }
    const block = [];
    while (i < lines.length && consultMarkdownTableCells(lines[i])) block.push(lines[i++]);
    const rows = block.map(consultMarkdownTableCells);
    const columns = rows[0]?.length || 0;
    const separator = rows[1] && rows[1].length === columns && rows[1].every(cell => /^:?-{3,}:?$/.test(cell));
    if (block.length < 3 || columns < 2 || !separator || rows.some(row => row.length !== columns)) {
      issues.push('malformed_table_structure');
      continue;
    }
    if (rows.slice(2).some(row => row.filter(Boolean).length < 2)) issues.push('sparse_table_row');
  }
  return Array.from(new Set(issues));
}

function consultNormalizeSafeTables(text) {
  const lines = String(text || '').split('\n');
  const output = [];
  for (let i = 0; i < lines.length;) {
    if (!consultMarkdownTableCells(lines[i])) { output.push(lines[i++]); continue; }
    const block = [];
    while (i < lines.length && consultMarkdownTableCells(lines[i])) block.push(lines[i++]);
    const rows = block.map(consultMarkdownTableCells);
    const columns = rows[0]?.length || 0;
    const separator = rows[1] && rows[1].length === columns && rows[1].every(cell => /^:?-{3,}:?$/.test(cell));
    const dataRows = rows.slice(2).filter(row => row.length === columns && row.filter(Boolean).length >= 2);
    if (columns >= 2 && separator && dataRows.length) output.push(block[0], block[1], ...dataRows.map(row => `| ${row.join(' | ')} |`));
  }
  return output.join('\n');
}

function consultRequiredPrimaryPath(question, route, answer = '') {
  if (!route || !route.matched) return null;
  const answerText = String(answer || '');
  const questionRequestsInterface = /(?:请求|响应|接口|抓包|Network|路径)/i.test(String(question || ''));
  const discussesRequestCheck = questionRequestsInterface && /(?:请求|接口|抓包|Network|\bpath\b|路径)[^。！？；\n]{0,28}(?:核对|检查|对照|确认|状态|返回|方法)|(?:核对|检查|对照|确认)[^。！？；\n]{0,20}(?:请求|接口|\bpath\b|路径)/i.test(answerText);
  if (!discussesRequestCheck) return null;
  const forbidden = new Set(consultConcretePaths((route.mustNotConfuse || []).join('\n')));
  const candidates = [];
  for (const fact of route.answerFacts || []) {
    const factText = String(fact || '');
    for (const pathValue of consultConcretePaths(factText)) {
      // “唯一主接口”必须是可逐字核对的具体端点；`/x/*` 只是路径族/前缀，
      // 不能因为它恰好是 route 内唯一的 path 就强塞成某一次请求的精确接口。
      if (!pathValue.startsWith('/') || pathValue.includes('*') || forbidden.has(pathValue)) continue;
      const escaped = pathValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const method = factText.match(new RegExp(`\\b(GET|POST|PUT|PATCH|DELETE)\\s+${escaped}`, 'i'))?.[1]?.toUpperCase() || '';
      candidates.push({ path: pathValue, method, display: `${method ? `${method} ` : ''}${pathValue}` });
    }
  }
  const unique = Array.from(new Map(candidates.map(item => [item.path, item])).values());
  return unique.length === 1 ? unique[0] : null;
}

function consultNormalizeSafeMarkdown(text) {
  const lines = String(text || '').split('\n').map(line => {
    let out = line;
    // fallback 迁移技术段时，原正文可能已经是列表项；再次加前缀不能把
    // `- 事实` 变成浏览器可见的 `- - 事实`。
    out = out.replace(/^(\s*)[-*+]\s+[-*+]\s+/u, '$1- ');
    if (((out.match(/\*\*/g) || []).length % 2) !== 0) out = out.replace(/\*\*/g, '');
    if (((out.match(/```/g) || []).length % 2) !== 0) out = out.replace(/```/g, '');
    const withoutFences = out.replace(/```/g, '');
    if (((withoutFences.match(/`/g) || []).length % 2) !== 0) out = out.replace(/`/g, '');
    return out;
  }).filter(line => !/^\s*(?:\*\*|__|`{1,3})\s*$/.test(line));
  while (lines.length && !lines.at(-1).trim()) lines.pop();
  while (lines.length && /[：:]\s*(?:\*\*|__)?\s*$/u.test(lines.at(-1))) lines.pop();
  return lines.join('\n').trim();
}

// 浏览器会把整段咨询历史回传；路由继承仍需要最近若干轮用户问题，但模型不需要
// 每轮都携带 4k 全文。先保留一个有界的“事实/路由历史”，再为模型做更紧凑的
// 二次裁剪：最近消息优先，当前问题必保留，上一轮回答仍足够支持“换成实施清单”
// 这类 context_followup。裁剪只影响模型 payload，不改变 current route 的独立事实注入。
function consultHistoryMessages(messages, options = {}) {
  const maxMessages = Math.max(2, Number(options.maxMessages) || 24);
  const perMessageChars = Math.max(200, Number(options.perMessageChars) || 4000);
  return (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.content)
    .slice(-maxMessages)
    .map(message => ({
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: String(message.content).slice(0, perMessageChars),
    }));
}

function compactConsultModelMessages(messages, options = {}) {
  const rows = consultHistoryMessages(messages, {
    maxMessages: Number(options.maxMessages) || 12,
    perMessageChars: Math.max(Number(options.userChars) || 1800, Number(options.assistantChars) || 2400),
  });
  const maxChars = Math.max(1000, Number(options.maxChars) || 16000);
  const userChars = Math.max(200, Number(options.userChars) || 1800);
  const assistantChars = Math.max(200, Number(options.assistantChars) || 2400);
  const currentUserChars = Math.max(userChars, Number(options.currentUserChars) || 4000);
  const kept = [];
  let used = 0;
  for (let index = rows.length - 1; index >= 0; index--) {
    const row = rows[index];
    const limit = row.role === 'assistant' ? assistantChars : (index === rows.length - 1 ? currentUserChars : userChars);
    let content = String(row.content || '').slice(0, limit);
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (content.length > remaining) content = content.slice(0, remaining);
    if (!content.trim()) continue;
    kept.push({ role: row.role, content });
    used += content.length;
  }
  return kept.reverse();
}

// /api/consult 一旦已经建立 SSE，任何未预期异常都必须在同一连接上留下可见错误
// 和 terminal done；不能依赖全局 unhandledRejection 日志，更不能让浏览器只收到 EOF。
// 只回传请求编号和安全阶段名，不把 prompt、历史正文或密钥写进日志/响应。
function finishConsultSseError(res, error, options = {}) {
  const requestId = String(options.requestId || '').trim() || crypto.randomBytes(5).toString('hex');
  const stage = String(options.stage || 'unknown').trim().slice(0, 48) || 'unknown';
  const message = String((error && error.message) || error || 'unknown error').replace(/[\r\n]+/g, ' ').slice(0, 500);
  console.error(`[consult-error] request=${requestId} stage=${stage} message=${message}`);
  if (!res || res.destroyed || res.writableEnded) return false;
  try {
    if (!res.headersSent) res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    const visible = `（本次答疑处理异常，未能返回可发布内容，请稍后重试。错误编号：${requestId}。）`;
    res.write('data: ' + JSON.stringify({ err: true, code: 'consult_internal_error', requestId, stage, v: visible }) + '\n\n');
    res.write('data: ' + JSON.stringify({ done: true, error: true, requestId, stage }) + '\n\n');
    res.end();
    return true;
  } catch {
    try { res.end(); } catch {}
    return false;
  }
}

// 咨询会在服务端收齐草稿并完成发布前审计，首个正文块可能晚于反向代理的
// 空闲超时。期间只发 SSE 注释心跳（浏览器不会当正文渲染），避免连接被代理
// 当成无数据请求提前结束。stop 可重复调用，close/finish 时也会自动清理定时器。
function startConsultSseHeartbeat(res, options = {}) {
  const intervalMs = Math.max(1, Number(options.intervalMs) || 15000);
  let stopped = false;
  const write = () => {
    if (stopped || !res || res.destroyed || res.writableEnded) return false;
    try { res.write(': keepalive\n\n'); return true; } catch { return false; }
  };
  const timer = setInterval(() => { if (!write()) stop(); }, intervalMs);
  if (timer && typeof timer.unref === 'function') timer.unref();
  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
  }
  if (res && typeof res.once === 'function') { res.once('close', stop); res.once('finish', stop); }
  write();   // 立即冲出响应头和首个注释帧；后续正文仍只由安全终稿发布器发送。
  return stop;
}

// 等待安全终稿期间的可见进度。它与正文 `v` 是互斥字段：客户端只更新等待占位，
// 服务端也不会把这类事件拼进 reply/chat/经验库。文案由服务端白名单生成，避免把模型名、prompt 或异常正文带到页面。
function consultProgressEvent(stage, options = {}) {
  const labels = {
    preparing: '正在读取说明书与会话上下文…',
    generating: '已找到相关资料，正在生成回答…',
    auditing: '回答已生成，正在做发布前安全校验…',
    revising: '初稿未通过校验，正在安全修订…',
    fallback: '模型暂未返回完整内容，正在依据已核事实整理回答…',
    publishing: '安全校验完成，正在输出回答…',
  };
  const key = String(stage || '').trim();
  if (!Object.prototype.hasOwnProperty.call(labels, key)) return null;
  const attempt = Math.max(0, parseInt(options.attempt, 10) || 0);
  const total = Math.max(0, parseInt(options.total, 10) || 0);
  let label = labels[key];
  if (key === 'generating' && attempt > 1) label = '首个模型未及时返回，正在尝试备用模型…';
  return {
    type: 'progress',
    stage: key,
    label,
    ...(attempt ? { attempt } : {}),
    ...(total ? { total } : {}),
  };
}

function consultModelDeadlineSignal(signal, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs) || CONSULT_MODEL_ROUND_TIMEOUT_MS);
  const deadline = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, deadline]) : deadline;
}

// 模型草稿必须先完整生成并通过发布前审计；这里只接收已经安全的最终稿，
// 再按自然文本/Markdown 结构边界拆成 SSE 小块。拆分不得改变任何字符，
// 也不能把围栏代码、Markdown 表格、行内代码或链接拆成浏览器会误解析的半截。
function consultFinalAnswerChunks(answer, options = {}) {
  const text = String(answer == null ? '' : answer);
  if (!text) return [];
  const firstTarget = Math.max(48, Number(options.firstTarget) || 120);
  const target = Math.max(firstTarget, Number(options.target) || 220);
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [text];
  const atoms = [];
  const isFence = line => /^\s*```/.test(String(line || ''));
  const isTableSeparator = line => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(String(line || '').replace(/\n$/, ''));
  const isTableLine = line => {
    const value = String(line || '').replace(/\n$/, '');
    return (value.match(/\|/g) || []).length >= 2;
  };
  const protectedRanges = value => {
    const ranges = [];
    for (const re of [/`[^`\n]*`/g, /\*\*[^*\n]+\*\*/g, /__[^_\n]+__/g, /!?\[[^\]\n]*\]\([^\n)]*(?:\([^\n)]*\)[^\n)]*)*\)/g]) {
      for (const match of String(value || '').matchAll(re)) ranges.push([match.index, match.index + match[0].length]);
    }
    return ranges;
  };
  const splitProse = value => {
    const ranges = protectedRanges(value);
    const insideProtected = index => ranges.some(([start, end]) => index >= start && index < end);
    let start = 0;
    for (let index = 0; index < value.length; index++) {
      if (insideProtected(index)) continue;
      const char = value[index];
      const length = index - start + 1;
      const sentenceEnd = /[。！？；\n]/u.test(char);
      const softEnd = /[，,:：]/u.test(char) && length >= 72;
      if (sentenceEnd || softEnd) { atoms.push(value.slice(start, index + 1)); start = index + 1; }
    }
    if (start < value.length) atoms.push(value.slice(start));
  };

  for (let index = 0; index < lines.length;) {
    if (isFence(lines[index])) {
      let end = index + 1;
      while (end < lines.length) { const closing = isFence(lines[end]); end++; if (closing) break; }
      atoms.push(lines.slice(index, end).join('')); index = end; continue;
    }
    if (index + 1 < lines.length && isTableLine(lines[index]) && isTableSeparator(lines[index + 1])) {
      let end = index + 2;
      while (end < lines.length && isTableLine(lines[end]) && !isFence(lines[end])) end++;
      atoms.push(lines.slice(index, end).join('')); index = end; continue;
    }
    splitProse(lines[index]); index++;
  }

  const chunks = [];
  let current = '';
  for (const atom of atoms) {
    const limit = chunks.length ? target : firstTarget;
    if (current && current.length + atom.length > limit) { chunks.push(current); current = ''; }
    current += atom;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [text];
}

async function consultStreamFinalAnswer(answer, writeChunk, options = {}) {
  const chunks = consultFinalAnswerChunks(answer, options);
  const signal = options.signal;
  const isClosed = typeof options.isClosed === 'function' ? options.isClosed : () => false;
  const delayMs = Math.max(0, Number(options.delayMs == null ? 45 : options.delayMs));
  let sentText = '', sentChunks = 0, stopped = false;
  for (let index = 0; index < chunks.length; index++) {
    if ((signal && signal.aborted) || isClosed()) { stopped = true; break; }
    try {
      const accepted = writeChunk(chunks[index], index, chunks.length);
      if (accepted === false) { stopped = true; break; }
    } catch { stopped = true; break; }
    sentText += chunks[index]; sentChunks++;
    if (index + 1 < chunks.length && delayMs) await new Promise(resolve => setTimeout(resolve, delayMs));
  }
  if ((signal && signal.aborted) || isClosed()) stopped = true;
  return { mode: 'safe-final', totalChunks: chunks.length, sentChunks, sentText, stopped };
}

function consultAnswerSemanticAudit(answer, question, route) {
  const text = String(answer || '').trim();
  const questionText = String(question || '');
  const intentQuestionText = questionText.trim()
    .replace(/^另一轮独立复测\s*[（(]\s*\d+\s*[）)]\s*里\s*[，,：:；;]?\s*/iu, '')
    .trim();
  const explicitOperationContracts = consultExplicitOperationContracts(intentQuestionText);
  const explicitOperationEvidenceMissing = explicitOperationContracts.length > 0
    && (!route || (!route.matched && Array.isArray(route.explicitOperationEvidenceMiss) && route.explicitOperationEvidenceMiss.length > 0));
  const operationEvidenceStopReply = explicitOperationEvidenceMissing ? consultOperationEvidenceStopReply() : '';
  const verifiedOperationEvidenceStop = explicitOperationEvidenceMissing
    && consultNormalizeSafeMarkdown(text) === consultNormalizeSafeMarkdown(operationEvidenceStopReply);
  const documentLines = text.split('\n');
  // 圈号经常用来跨表格/段落引用观测点。模型删句或修订后若只剩“③/④”这类
  // 未定义引用，实施无法照做；定义必须出现在结构起点（行首/表格单元格）或
  // 冒号、分号后的枚举项，普通正文里的“第③步/含④”只算引用。
  const ordinalDefinitions = new Set();
  const ordinalUses = [];
  for (const line of text.split('\n')) {
    for (const match of line.matchAll(/[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳]/gu)) {
      const ordinal = match[0];
      const before = line.slice(0, match.index).replace(/(?:\*\*|__|`)+$/g, '');
      const structuralDefinition = /(?:^|[|:：;；])\s*(?:[-*+]\s*)?(?:[（(]\s*)?$/.test(before);
      if (structuralDefinition) ordinalDefinitions.add(ordinal);
      ordinalUses.push({ ordinal, line: line.trim() });
    }
  }
  const undefinedOrdinalReferences = Array.from(new Set(ordinalUses
    .filter(item => !ordinalDefinitions.has(item.ordinal))
    .map(item => item.ordinal)));
  // 诊断分支里的 A/B/C 是文档级变量，不是装饰。比较表达出现前必须已经
  // 逐一绑定含义；只在前文自然语列了三项，或在结尾改用自然名，不能反向
  // 证明 A/B/C 的映射。定义与使用按文档顺序扫描，避免“事后定义”漏过。
  const symbolicDefinitions = new Map();
  const symbolicComparisons = [];
  const symbolicContext = /(?:对照|比较|判断|分支|页面|界面|接口|响应|本机|浏览器|终端|观测|现场)/iu.test(`${question || ''}\n${text}`);
  let insideSymbolFence = false;
  if (symbolicContext) {
    for (let lineIndex = 0; lineIndex < documentLines.length; lineIndex++) {
      const rawLine = String(documentLines[lineIndex] || '');
      if (/^\s*```/u.test(rawLine)) { insideSymbolFence = !insideSymbolFence; continue; }
      if (insideSymbolFence) continue;
      const events = [];
      const cells = consultMarkdownTableCells(rawLine);
      if (cells && /^[A-Z①-⑳甲乙丙丁]$/u.test(String(cells[0] || '').trim())) {
        const meaning = String(cells[1] || '').replace(/[*_`]/g, '').trim();
        if (meaning && !/^[A-Z①-⑳甲乙丙丁]$/u.test(meaning)) events.push({ type: 'definition', index: 0, symbol: String(cells[0]).trim(), meaning });
      }
      const definitionRe = /(?:^|[|,，；;:：\s（(])([A-Z①-⑳甲乙丙丁])\s*(?:=|：|:|表示|代表|指代|为)\s*([^|,，；;。\n]{1,32})/gu;
      for (const match of rawLine.matchAll(definitionRe)) {
        const meaning = String(match[2] || '').replace(/[*_`]/g, '').trim();
        if (!meaning || /^[A-Z①-⑳甲乙丙丁](?:\s|$)/u.test(meaning) || /^(?:=|≠|>|<|vs\b)/iu.test(meaning)) continue;
        events.push({ type: 'definition', index: match.index || 0, symbol: match[1], meaning });
      }
      const comparisonRe = /(?<![A-Za-z0-9_])([A-Z①-⑳甲乙丙丁])\s*(==|=|≠|>|<|vs\.?)\s*([A-Z①-⑳甲乙丙丁])(?![A-Za-z0-9_])/giu;
      for (const match of rawLine.matchAll(comparisonRe)) {
        events.push({ type: 'comparison', index: match.index || 0, symbols: [match[1].toUpperCase(), match[3].toUpperCase()], expression: match[0] });
      }
      events.sort((a, b) => a.index - b.index || (a.type === 'definition' ? -1 : 1));
      for (const event of events) {
        if (event.type === 'definition') {
          symbolicDefinitions.set(event.symbol, { meaning: event.meaning, lineIndex, line: rawLine.trim() });
          continue;
        }
        const undefinedSymbols = Array.from(new Set(event.symbols.filter(symbol => !symbolicDefinitions.has(symbol))));
        if (undefinedSymbols.length) symbolicComparisons.push({ line: rawLine.trim(), lineIndex, expression: event.expression, symbols: event.symbols, undefinedSymbols });
      }
    }
  }
  const undefinedSymbolicComparisons = symbolicComparisons;
  // “三边/三项对照”与实际表格行数是文档级契约，Markdown 列数正确并不代表
  // 内容完整。只在表头明确以“对照项/观测点/来源”等按行列项时比较数据行，
  // 避免把横向三列表误判为缺少三行。
  const chineseCount = { '一': 1, '二': 2, '两': 2, '三': 3, '四': 4, '五': 5, '六': 6, '七': 7, '八': 8, '九': 9, '十': 10 };
  const structuredCountRe = /(?:共|做|核对|对照|比较|检查|保留|拿|至少还要|还要|需要|缺)?\s*([一二两三四五六七八九十]|\d{1,2})\s*(边|项|份|样(?:东西|材料|信息)?|件(?:事|内容)?|条(?:记录|数据|内容)?|处(?:位置|断点)?|个(?:值|字段|位置|观测点|检查点|对照点)?)\s*(?:原文|值|字段|位置|观测点|检查点|数据)?\s*(?:对照|核对|比较|检查|分别)?/gu;
  // “请回/提供/补充/核对 N 行（列/组/种/类）”是对紧随结构的显式
  // 数量契约。行/列等又常出现在普通数据事实里，因此动作词必须存在：
  // “表格有4列”“用户已有4行数据”不能触发，避免把业务数据误当回复格式。
  const requestedStructureCountRe = /(?:请(?:你)?(?:只|直接)?\s*)?(?:回|回复|提供|补充|核对)\s*(?:下面|以下|下列|这|上述|以上)?\s*([一二两三四五六七八九十]|\d{1,2})\s*(行|列|组|种|类)/u;
  const cardinalityMismatches = [];
  for (let index = 0; index + 1 < documentLines.length; index++) {
    const headerCells = consultMarkdownTableCells(documentLines[index]);
    if (!headerCells || !/^\s*\|?\s*:?-{3,}/.test(documentLines[index + 1])) continue;
    let end = index + 2;
    const dataRows = [];
    while (end < documentLines.length && consultMarkdownTableCells(documentLines[end])) {
      dataRows.push(documentLines[end]); end++;
    }
    const firstHeader = String(headerCells[0] || '').replace(/[*_`]/g, '').trim();
    const missingItemColumnIndexes = headerCells.map((header, headerIndex) => ({
      header: String(header || '').replace(/[*_`]/g, '').trim(),
      headerIndex,
    })).filter(item => /(?:还缺|待补|需补|缺少|需要(?:补充|提供)?|最少材料)/u.test(item.header)).map(item => item.headerIndex);
    const explicitlyMissingItems = missingItemColumnIndexes.length > 0;
    if (!explicitlyMissingItems && !/(?:对照|观测|检查)?(?:项|点|边)|来源|位置|环节|侧|阶段/u.test(firstHeader)) { index = end - 1; continue; }
    // “对照边/对照项/观测点”明确表示每一数据行是一项，列数不能拿来
    // 充当声明数量；“来源记录 | 已有请求 | 已有响应”这类横向表才允许
    // 用列数满足声明。
    const explicitlyRowOriented = /^(?:对照|观测|检查)?(?:项|点|边)$/u.test(firstHeader) || explicitlyMissingItems;
    const lookbackStart = Math.max(0, index - 3);
    const lookback = documentLines.slice(lookbackStart, index);
    let declaration = null;
    for (let offset = lookback.length - 1; offset >= 0; offset--) {
      const matches = Array.from(lookback[offset].matchAll(structuredCountRe));
      const supported = matches.map(match => ({
        match,
        expected: /^\d+$/.test(match[1]) ? Number(match[1]) : chineseCount[match[1]],
      })).filter(item => item.expected >= 2).at(-1);
      if (supported) {
        declaration = { line: lookback[offset].trim(), lineIndex: lookbackStart + offset, expected: supported.expected };
        break;
      }
    }
    const missingItemCount = explicitlyMissingItems ? dataRows.reduce((sum, row) => {
      const cells = consultMarkdownTableCells(row) || [];
      const targetText = missingItemColumnIndexes.map(cellIndex => String(cells[cellIndex] || '')).join(' ');
      const explicitMarkers = targetText.match(/[①②③④⑤⑥⑦⑧⑨⑩]|(?:^|[；;])\s*\d{1,2}[.、．]/gu) || [];
      return sum + Math.max(1, explicitMarkers.length);
    }, 0) : dataRows.length;
    const actualStructuredItems = explicitlyMissingItems ? missingItemCount : dataRows.length;
    const horizontallyComplete = !explicitlyRowOriented && headerCells.length === declaration?.expected;
    if (declaration && actualStructuredItems !== declaration.expected && !horizontallyComplete) {
      cardinalityMismatches.push({
        ...declaration,
        actual: actualStructuredItems,
        tableStart: index,
        tableEnd: end,
        tableBlock: documentLines.slice(index, end).join('\n'),
        structureBlock: documentLines.slice(index, end).join('\n'),
        kind: 'table',
      });
    }
    index = end - 1;
  }
  // “按结果分支判断”是至少两个分支的结构承诺。模型修订/删句后若表格只剩
  // 一条数据行，即使表格列数正确也不能称为“分支”；实施会不知道其余结果怎么走。
  const incompleteResultBranchTables = [];
  const branchDiagnosticQuestion = /(?:排查|不一致|对不上|异常|故障|现场|验证|复测|下一步|怎么判断|如何判断|怎么确认|检查|留证|只能确认|能确定|不知道|未知|走到哪|还缺什么|够不够)/i.test(intentQuestionText);
  const resultBranchLeadRe = /(?:(?:按|根据|依照)[^。！？\n]{0,18}(?:结果|情况|观测)[^。！？\n]{0,18}(?:分支|分类|分别|判断|走)|(?:怎么|如何)判断|判断如下)/u;
  for (let index = 0; index < documentLines.length; index++) {
    const leadMatched = resultBranchLeadRe.test(documentLines[index]);
    const currentHeaderCells = consultMarkdownTableCells(documentLines[index]);
    const normalizedHeaders = (currentHeaderCells || []).map(cell => String(cell || '').replace(/[*_`]/g, '').trim());
    // 诊断表头本身也可能承诺“按观测结果分类”，即使模型清理掉了前置
    // “按结果分支”句。要求首列描述结果/对照，且另有含义/判断/下一步列，
    // 避免把普通的一行字段说明表误判成残缺分支表。
    const semanticBranchHeader = branchDiagnosticQuestion
      && normalizedHeaders.some(header => /(?:对照|观测|检查)?结果|情况|现象/u.test(header))
      && normalizedHeaders.some(header => /含义|说明|判断|下一步|怎么处理|是否需要|还要不要/u.test(header));
    if (!leadMatched && !semanticBranchHeader) continue;
    let header = semanticBranchHeader ? index : index + 1;
    while (header < documentLines.length && header <= index + 3 && !documentLines[header].trim()) header++;
    if (header + 1 >= documentLines.length || !consultMarkdownTableCells(documentLines[header]) || !/^\s*\|?\s*:?-{3,}/.test(documentLines[header + 1])) continue;
    let end = header + 2;
    const rows = [];
    while (end < documentLines.length && consultMarkdownTableCells(documentLines[end])) { rows.push(documentLines[end]); end++; }
    if (rows.length >= 2) continue;
    incompleteResultBranchTables.push({
      line: leadMatched ? documentLines[index].trim() : '',
      lineIndex: index,
      actual: rows.length,
      tableStart: header,
      tableEnd: end,
      block: documentLines.slice(leadMatched ? index : header, end).join('\n'),
    });
  }
  // 同一局部结构里的显式数量声明也不能漂移，例如标题说“确认1件事”，
  // 紧接着又要求“回复两点”。只识别带结构动作的声明，不把“两条历史记录”
  // 这类普通事实数量当成清单承诺。
  const explicitCountRe = /(?:确认|回|回复|提供|补充|核对|对照|比较|检查|保留|拿)\s*(?:下面|以下|下列|这|上述|以上)?\s*([一二两三四五六七八九十]|\d{1,2})\s*(?:件(?:事|内容)?|项|点|条(?:信息|内容)?|处(?:位置)?|个(?:值|字段|位置|观测点|检查点|对照点)?|行|列|组|种|类)/u;
  const conflictingCountDeclarations = [];
  for (let index = 0; index < documentLines.length; index++) {
    const firstMatch = documentLines[index].match(explicitCountRe);
    if (!firstMatch) continue;
    const firstCount = /^\d+$/.test(firstMatch[1]) ? Number(firstMatch[1]) : chineseCount[firstMatch[1]];
    for (let next = index + 1; next < documentLines.length && next <= index + 5; next++) {
      const secondMatch = documentLines[next].match(explicitCountRe);
      if (!secondMatch) continue;
      const secondCount = /^\d+$/.test(secondMatch[1]) ? Number(secondMatch[1]) : chineseCount[secondMatch[1]];
      if (firstCount === secondCount) continue;
      conflictingCountDeclarations.push({
        first: documentLines[index].trim(),
        firstCount,
        second: documentLines[next].trim(),
        secondCount,
      });
      break;
    }
  }
  // 同样核对“只看两件事：”后紧随的 Markdown 清单。这里只统计顶层列表
  // 标记，不把缩进说明行当新项；普通叙述中的“两条记录”若没有冒号引导结构，
  // 不进入基数审计。
  const topLevelListItemRe = /^\s{0,3}(?:[-*+]\s+|[1-9]\d*[.、．]\s+)/u;
  for (let index = 0; index < documentLines.length; index++) {
    const line = documentLines[index];
    if (!/[：:]\s*(?:\*\*|__)?\s*$/u.test(line)) continue;
    const matches = Array.from(line.matchAll(structuredCountRe));
    const supported = matches.map(match => ({
      match,
      expected: /^\d+$/.test(match[1]) ? Number(match[1]) : chineseCount[match[1]],
    })).filter(item => item.expected >= 2).at(-1);
    if (!supported) continue;
    let cursor = index + 1;
    while (cursor < documentLines.length && !documentLines[cursor].trim()) cursor++;
    if (cursor >= documentLines.length || consultMarkdownTableCells(documentLines[cursor])) continue;
    const start = cursor;
    const listItems = [];
    let sawItem = false;
    while (cursor < documentLines.length) {
      const current = documentLines[cursor];
      if (!current.trim()) { if (sawItem) { cursor++; continue; } break; }
      if (topLevelListItemRe.test(current)) { listItems.push(current); sawItem = true; cursor++; continue; }
      if (sawItem && /^\s{2,}\S/u.test(current)) { cursor++; continue; }
      break;
    }
    if (listItems.length && listItems.length !== supported.expected) {
      cardinalityMismatches.push({
        line: line.trim(),
        lineIndex: index,
        expected: supported.expected,
        actual: listItems.length,
        structureStart: start,
        structureEnd: cursor,
        structureBlock: documentLines.slice(start, cursor).join('\n'),
        kind: 'list',
      });
    }
  }
  // 对明确请求回复格式的“行/列/组/种/类”做独立计数。声明可写在粗体
  // 标题里且不以冒号结尾；实际结构只取紧随其后的列表或表格。后面的
  // “你回这4行后……”属于同一契约引用，失配时也要一起删除。
  for (let index = 0; index < documentLines.length; index++) {
    const normalizedLine = String(documentLines[index] || '').replace(/(?:\*\*|__|`)/g, '').trim();
    const declarationMatch = normalizedLine.match(requestedStructureCountRe);
    if (!declarationMatch) continue;
    const expected = /^\d+$/u.test(declarationMatch[1]) ? Number(declarationMatch[1]) : chineseCount[declarationMatch[1]];
    if (!Number.isInteger(expected) || expected < 1) continue;
    const unit = declarationMatch[2];
    let cursor = index + 1;
    while (cursor < documentLines.length && !documentLines[cursor].trim()) cursor++;
    const structureStart = cursor;
    let structureEnd = cursor;
    let actual = null;
    let kind = '';
    const headerCells = consultMarkdownTableCells(documentLines[cursor] || '');
    if (headerCells && cursor + 1 < documentLines.length && /^\s*\|?\s*:?-{3,}/u.test(documentLines[cursor + 1])) {
      structureEnd = cursor + 2;
      let dataRows = 0;
      while (structureEnd < documentLines.length && consultMarkdownTableCells(documentLines[structureEnd])) {
        dataRows++; structureEnd++;
      }
      actual = unit === '列' ? headerCells.length : dataRows;
      kind = 'requested-table';
    } else if (topLevelListItemRe.test(documentLines[cursor] || '')) {
      let listItems = 0;
      let sawItem = false;
      while (structureEnd < documentLines.length) {
        const current = documentLines[structureEnd];
        if (!current.trim()) { if (sawItem) { structureEnd++; continue; } break; }
        if (topLevelListItemRe.test(current)) { listItems++; sawItem = true; structureEnd++; continue; }
        if (sawItem && /^\s{2,}\S/u.test(current)) { structureEnd++; continue; }
        break;
      }
      actual = listItems;
      kind = 'requested-list';
    }
    if (actual === null || actual === expected) continue;
    const dependentLines = [];
    const dependentCountRe = new RegExp(`(?:回|回复|提供|补充|核对)\\s*(?:这|上述|以上)?\\s*${declarationMatch[1]}\\s*${unit}`, 'u');
    for (let next = structureEnd; next < documentLines.length && next <= structureEnd + 5; next++) {
      const normalizedNext = String(documentLines[next] || '').replace(/(?:\*\*|__|`)/g, '').trim();
      if (dependentCountRe.test(normalizedNext)) dependentLines.push(documentLines[next].trim());
    }
    cardinalityMismatches.push({
      line: documentLines[index].trim(),
      lineIndex: index,
      expected,
      actual,
      unit,
      structureStart,
      structureEnd,
      structureBlock: documentLines.slice(structureStart, structureEnd).join('\n'),
      dependentLines,
      kind,
    });
  }
  // 冒号式引导语必须真正引出内容；若同一段内直接转入“别搞混/注意/结论”
  // 等新语义分句，或下一非空行已经进入新步骤/标题或已结束，说明模型删掉
  // 枚举后留下了空壳。段内空引导只删除该 clause，不能连带删掉后面的必要反例。
  const incompleteLeadIns = [];
  const topLevelStepRe = /^(?![ \t]{4})[ \t]{0,3}(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*([1-9]\d*)[.、．][ \t]+/u;
  const strongLeadSource = '(?:例如|如下|包括|包含|里面有|内容为|由以下(?:内容|项目|字段|部分)?组成|组成如下|分别为|具体为|可见|重点看|(?:用|通过)\\s*`?[A-Za-z_][A-Za-z0-9_.]*`?\\s*(?:关联|挂接|连接)?|关联键是)';
  const inlineSemanticBoundary = '(?:别(?:和|跟|把|搞混)|不要混淆|注意|结论|下一步|判断|说明|技术依据|处理建议)';
  const inlineLeadRe = new RegExp(`(?:^|[。！？；]\\s*)([^。！？；\\n]{0,180}?${strongLeadSource}\\s*[：:])\\s*(?=(?:\\*\\*|__)?\\s*${inlineSemanticBoundary})`, 'gu');
  for (let index = 0; index < documentLines.length; index++) {
    for (const match of String(documentLines[index] || '').matchAll(inlineLeadRe)) {
      incompleteLeadIns.push({
        line: documentLines[index].trim(),
        lineIndex: index,
        inlineClause: String(match[1] || '').trim(),
        affectedLines: [],
      });
    }
  }
  for (let index = 0; index < documentLines.length; index++) {
    const keySpecificLead = /(?:(?:用|通过)\s*`?[A-Za-z_][A-Za-z0-9_.]*`?\s*(?:关联|挂接|连接)?|关联键是)\s*[：:]\s*(?:\*\*|__)?\s*$/u.test(documentLines[index]);
    const explicitLead = /(?:例如|如下|包括|包含|里面有|内容为|由以下(?:内容|项目|字段|部分)?组成|组成如下|分别为|具体为|可见|重点看|(?:用|通过)\s*`?[A-Za-z_][A-Za-z0-9_.]*`?\s*(?:关联|挂接|连接)?|关联键是)\s*[：:]\s*(?:\*\*|__)?\s*$/u.test(documentLines[index]);
    const genericColonLead = /[：:]\s*(?:\*\*|__)?\s*$/u.test(documentLines[index]);
    if (!explicitLead && !genericColonLead) continue;
    let next = index + 1;
    while (next < documentLines.length && !documentLines[next].trim()) next++;
    const nextLine = documentLines[next] || '';
    // 一般冒号标题只在正文已经结束时判空；“例如/如下”等强引导语还要拦截
    // 直接跳到下一步骤/标题的情况。
    if (!explicitLead && next < documentLines.length) continue;
    // “用 form_id：”是键名专属结构引导，不允许靠下一段普通 prose
    // 反向补内容；必须同段直接写完整关系，或紧随列表/表格/代码块。
    // 这可区分合法“用 form_id：模板和字段关联。”与删句后的空壳标题。
    const nextStructuredContent = topLevelListItemRe.test(nextLine)
      || !!consultMarkdownTableCells(nextLine)
      || /^\s*```/u.test(nextLine)
      || /^\s{2,}\S/u.test(nextLine);
    if (keySpecificLead && next < documentLines.length && !nextStructuredContent) {
      incompleteLeadIns.push({ line: documentLines[index].trim(), lineIndex: index, affectedLines: [documentLines[index]] });
      continue;
    }
    const nextSectionHeading = /^\s*(?:#{1,6}\s+|(?:\*\*|__)?\s*(?:别(?:和|跟|把|搞混)|不要混淆|注意|结论|下一步|判断|说明|技术依据|处理建议)(?:\*\*|__)?\s*[：:]?)/u.test(nextLine);
    if (explicitLead && next < documentLines.length && !topLevelStepRe.test(nextLine) && !nextSectionHeading) continue;
    const affectedLines = [documentLines[index]];
    let previous = index - 1;
    while (previous >= 0 && !documentLines[previous].trim()) previous--;
    if (previous >= 0 && topLevelStepRe.test(documentLines[previous])) affectedLines.push(documentLines[previous]);
    incompleteLeadIns.push({ line: documentLines[index].trim(), lineIndex: index, affectedLines });
  }
  // 修订/删句后不能留下只有标题、没有判断或动作的诊断分支，例如
  // “请求失败 / 无字段”后直接跳到下一节。只审短分支标题和 Markdown 标题。
  const emptyDiagnosticBranchHeadings = [];
  if (branchDiagnosticQuestion) {
    for (let index = 0; index < documentLines.length; index++) {
      const raw = documentLines[index];
      const clean = String(raw || '').replace(/^\s*#{1,6}\s+/u, '').replace(/^\s*(?:[-*+]\s+)?(?:\*\*|__)?/u, '').replace(/(?:\*\*|__)?\s*$/u, '').trim();
      const markdownHeading = /^\s*#{1,6}\s+/u.test(raw) || /^\s*(?:\*\*|__)[^\n]+(?:\*\*|__)\s*$/u.test(raw);
      const branchLike = clean.length <= 42
        && /(?:\/|／|或|、)/u.test(clean)
        && /(?:失败|无(?:请求|响应|字段|数据|权限)|缺(?:字段|数据|响应)|不一致|异常|未命中|不存在)/u.test(clean);
      if (!markdownHeading || !branchLike) continue;
      let next = index + 1;
      while (next < documentLines.length && !documentLines[next].trim()) next++;
      const nextRaw = documentLines[next] || '';
      const nextIsHeading = /^\s*#{1,6}\s+/u.test(nextRaw) || /^\s*(?:\*\*|__)[^\n]+(?:\*\*|__)\s*$/u.test(nextRaw);
      if (next >= documentLines.length || nextIsHeading) emptyDiagnosticBranchHeadings.push({ line: raw.trim(), lineIndex: index });
    }
  }
  // 只含粗体标题的有序/无序列表项必须有正文或子项。若下一有效行已经是
  // 分隔线、新节、同级列表项或答案结束，说明清理后只剩空步骤标题。
  const emptyListStepItems = [];
  const listTitleOnlyRe = /^\s*(?:[-+*]\s+|[1-9]\d*[.、．]\s+)(?:\*\*|__)([^\n]+?)(?:\*\*|__)\s*$/u;
  const horizontalSeparatorRe = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/u;
  const markdownSectionRe = /^\s*#{1,6}\s+/u;
  for (let index = 0; index < documentLines.length; index++) {
    const match = String(documentLines[index] || '').match(listTitleOnlyRe);
    if (!match || /[。！？?!]$/u.test(match[1].trim())) continue;
    let next = index + 1;
    while (next < documentLines.length && !documentLines[next].trim()) next++;
    const nextLine = documentLines[next] || '';
    const hasIndentedBody = /^\s{2,}\S/u.test(nextLine);
    const noBody = !hasIndentedBody && (next >= documentLines.length
      || horizontalSeparatorRe.test(nextLine)
      || markdownSectionRe.test(nextLine)
      || topLevelStepRe.test(nextLine)
      || /^\s*[-+*]\s+/u.test(nextLine));
    if (noBody) emptyListStepItems.push({ line: documentLines[index].trim(), lineIndex: index });
  }
  // 逗号、分号或冒号只能连接同一句后半段/后续正文。若其后直接进入分隔线、
  // 新节、答案结束或统一安全尾注，终稿语义已经悬空，应删除完整句而非补写。
  const danglingClosingPunctuationLines = [];
  const safetyFooterRe = /^(?:当前证据|未由当前事实|未满足完整受控条件|这条答疑|这个咨询)/u;
  for (let index = 0; index < documentLines.length; index++) {
    const raw = String(documentLines[index] || '');
    const clean = raw.replace(/(?:\*\*|__|`)+\s*$/u, '').trim();
    if (!/[，,；;：:]$/u.test(clean) || consultMarkdownTableCells(raw) || horizontalSeparatorRe.test(raw)) continue;
    let next = index + 1;
    while (next < documentLines.length && !documentLines[next].trim()) next++;
    const nextLine = String(documentLines[next] || '').replace(/^\s*(?:[-+*]\s+|[1-9]\d*[.、．]\s+)?/u, '').replace(/[*_`]/g, '').trim();
    const semanticBoundary = next >= documentLines.length
      || horizontalSeparatorRe.test(documentLines[next] || '')
      || markdownSectionRe.test(documentLines[next] || '')
      || safetyFooterRe.test(nextLine);
    if (semanticBoundary) danglingClosingPunctuationLines.push({ line: raw.trim(), lineIndex: index, punctuation: clean.slice(-1) });
  }
  // 全文修订/删句后可能只剩并列结构的后半句，例如上一项已被删除，却留下
  // “还是页面上有字段标题但无选项”。这类句子标记、括号都完整，但缺少可选择
  // 的前项。直接回答“还是先停”或完整的“是 A 还是 B？”不属于孤立残句。
  const orphanedAlternativeLines = [];
  for (let index = 0; index < documentLines.length; index++) {
    const current = documentLines[index].trim();
    if (!/^(?:还是|或者)(?!先|要|应|应该|不要|继续|停止|取决于|，|,)/u.test(current) || /[？?]/u.test(current)) continue;
    let previous = index - 1;
    while (previous >= 0 && !documentLines[previous].trim()) previous--;
    const previousLine = previous >= 0 ? documentLines[previous].trim() : '';
    if (!previousLine || /(?:还是|或者|或是|二选一|[:：])\s*$/u.test(previousLine)) continue;
    if (/[。！？；?！]$/u.test(previousLine)) continue;
    orphanedAlternativeLines.push({ line: current, lineIndex: index, previousLine });
  }
  // 反方向也要审：后一项被删后，前一项可能停在“还是/或者/或是/或”。
  // 这种行即使括号、引号和 Markdown 都闭合，二选一语义仍然悬空。
  const danglingAlternativeLines = [];
  for (let index = 0; index < documentLines.length; index++) {
    const current = String(documentLines[index] || '')
      .replace(/(?:\*\*|__|`)+\s*$/u, '')
      .trim();
    if (!/(?:还是|或者|或是|或)\s*[，,：:]?\s*$/u.test(current)) continue;
    danglingAlternativeLines.push({ line: documentLines[index].trim(), lineIndex: index });
  }
  // “但/但是/不过/然而”必须承接上一条完整主张。答案开头或纯标题之后直接
  // 出现转折，通常是前半句被修订/降级删掉后的残句。
  const orphanedContrastLines = [];
  for (let index = 0; index < documentLines.length; index++) {
    const current = String(documentLines[index] || '')
      .replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '')
      .replace(/[*_`]/g, '')
      .trim();
    if (!/^(?:但(?:是)?|不过|然而)(?!愿|凡)/u.test(current)) continue;
    let previous = index - 1;
    while (previous >= 0 && !documentLines[previous].trim()) previous--;
    const previousLine = previous >= 0 ? documentLines[previous].trim() : '';
    const previousIsHeading = !previousLine
      || /^\s*#{1,6}\s+/u.test(previousLine)
      || /^\s*(?:\*\*|__)?[^。！？；\n]{1,32}[：:]\s*(?:\*\*|__)?\s*$/u.test(previousLine);
    if (!previousIsHeading) continue;
    orphanedContrastLines.push({ line: documentLines[index].trim(), lineIndex: index, previousLine });
  }
  // 在明确“对照/比较/分支判断”的局部结构里，成对标签不能只剩一边。
  // 例如写了“一致：...”后直接进入未标注的另一种判断，会让实施不知道
  // 后一句究竟属于哪个条件。普通单句“配置一致：无需处理”没有结构引导，放行。
  const incompletePairedBranches = [];
  const pairedBranchLabels = [
    ['一致', '不一致'], ['是', '否'], ['有', '无'], ['成功', '失败'],
    ['存在', '不存在'], ['命中', '未命中'],
  ];
  const normalizedBranchLabel = line => String(line || '')
    .replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '')
    .replace(/[*_`]/g, '')
    .trim();
  const structuralLeadRe = /(?:对照|比较|分支|分别|两种|判断|情况|结果)[^。！？\n]{0,28}[：:]?\s*$/u;
  for (let index = 0; index < documentLines.length; index++) {
    const normalized = normalizedBranchLabel(documentLines[index]);
    const pair = pairedBranchLabels.find(labels => labels.some(label => new RegExp(`^${label}\\s*[：:]`, 'u').test(normalized)));
    if (!pair) continue;
    let leadIndex = index - 1;
    while (leadIndex >= 0 && !documentLines[leadIndex].trim()) leadIndex--;
    let explicitLeadIndex = -1;
    for (let probe = leadIndex; probe >= Math.max(0, index - 5); probe--) {
      if (structuralLeadRe.test(normalizedBranchLabel(documentLines[probe]))) { explicitLeadIndex = probe; break; }
    }
    if (explicitLeadIndex < 0) continue;
    let end = index + 1;
    while (end < documentLines.length && end <= index + 8) {
      const raw = documentLines[end];
      const clean = normalizedBranchLabel(raw);
      if (/^#{1,6}\s+/u.test(raw) || (/^\*\*[^*]+\*\*\s*$/u.test(raw.trim()) && end > index + 1)) break;
      end++;
    }
    const branchBlock = documentLines.slice(explicitLeadIndex + 1, end).map(normalizedBranchLabel);
    const present = pair.filter(label => branchBlock.some(line => new RegExp(`^${label}\\s*[：:]`, 'u').test(line)));
    if (present.length === pair.length) continue;
    incompletePairedBranches.push({
      pair,
      present,
      missing: pair.filter(label => !present.includes(label)),
      leadIndex: explicitLeadIndex,
      start: index,
      end,
      block: documentLines.slice(explicitLeadIndex, end).join('\n'),
    });
  }
  // 修订删句后还可能留下“不要做的：”标题，下面却只有“可以/建议/请…”
  // 的正向动作。列表里的裸动作可由否定标题自然管辖，不误判；只有正文显式
  // 给出正向许可、建议或收益时才认定标题与内容极性冲突。
  const contradictoryNegativeSections = [];
  const negativeHeadingRe = /(?:不要做|禁止|避免|切勿|不得|不应)[^。！？\n]{0,16}[：:]\s*(?:\*\*|__)?\s*$/u;
  const positiveGuidanceRe = /(?:可以|可直接|建议|请|需要|应该|应当|务必|优先|最好|即可|就能|便于|方便|帮你)/u;
  const explicitNegativeRe = /(?:不要|不得|不能|不应|不必|不可|不建议|无需|无须|禁止|避免|切勿|先别)/u;
  for (let index = 0; index < documentLines.length; index++) {
    if (!negativeHeadingRe.test(normalizedBranchLabel(documentLines[index]))) continue;
    let end = index + 1;
    while (end < documentLines.length && end <= index + 8) {
      const raw = documentLines[end];
      if (/^\s*#{1,6}\s+/u.test(raw) || (/^\s*(?:\*\*|__)[^*_]+(?:\*\*|__)\s*$/u.test(raw) && end > index + 1)) break;
      end++;
    }
    const childLines = documentLines.slice(index + 1, end).map(normalizedBranchLabel).filter(Boolean);
    const contradictory = childLines.filter(line => positiveGuidanceRe.test(line) && !explicitNegativeRe.test(line));
    if (!contradictory.length) continue;
    contradictoryNegativeSections.push({
      heading: documentLines[index].trim(),
      contradictory,
      start: index,
      end,
      block: documentLines.slice(index, end).join('\n'),
    });
  }
  // 明确只问“先做哪个验证/第一步做什么”时，回答只能给一个最小只读验证。
  // 这里按文档顶层编号审计，不限制一个验证内部的表格或无编号对照项。
  const singleStepQuestion = /(?:先(?:让[^。！？\n]{0,20})?(?:做|查|核|看)?(?:哪个|哪一(?:个|项|步)?|什么)(?:验证|检查|核对|动作|步骤)|第一步(?:先)?(?:做|查|核|看)(?:什么|哪一(?:个|项|步)?))/u.test(String(question || ''));
  const topLevelSteps = [];
  let insideCodeFence = false;
  for (let lineIndex = 0; lineIndex < documentLines.length; lineIndex++) {
    const line = documentLines[lineIndex];
    if (/^\s*```/u.test(line)) { insideCodeFence = !insideCodeFence; continue; }
    if (insideCodeFence) continue;
    const match = line.match(topLevelStepRe);
    if (match) topLevelSteps.push({ number: Number(match[1]), lineIndex, line: line.trim() });
  }
  // 编号步骤可能写成普通行、粗体行或 Markdown heading。编号行只作为步骤标题，
  // 到下一个同级步骤/分隔线/新节/文末前必须出现真实正文、表格、列表或代码块；
  // 水平分隔线本身不能冒充内容。四空格缩进的嵌套步骤属于父步骤正文。
  const emptyNumberedSections = [];
  const topLevelSectionBoundaryRe = /^(?![ \t]{4})[ \t]{0,3}(?:#{1,6}[ \t]+|(?:\*\*|__)[^\n]+(?:\*\*|__)\s*$)/u;
  for (const step of topLevelSteps) {
    const inlineTitle = step.line.replace(topLevelStepRe, '').replace(/(?:\*\*|__)\s*$/u, '').trim();
    // “1. 只读记录当前值。”本身已经是完整可执行句，不要求额外正文；没有
    // 句末标点的标题仍须检查其下内容。
    let hasBody = /[。！？?!]$/u.test(inlineTitle);
    for (let cursor = step.lineIndex + 1; cursor < documentLines.length; cursor++) {
      if (hasBody) break;
      const candidate = documentLines[cursor];
      if (!candidate.trim()) continue;
      if (horizontalSeparatorRe.test(candidate) || topLevelStepRe.test(candidate) || topLevelSectionBoundaryRe.test(candidate)) break;
      hasBody = true;
      break;
    }
    if (!hasBody) emptyNumberedSections.push(step);
  }
  const nonSequentialTopLevelSteps = [];
  let topLevelExpectedStart = topLevelSteps.length ? 1 : null;
  if (topLevelSteps.length) {
    const continuationMatch = String(question || '').match(/第\s*([一二两三四五六七八九十]|[1-9]\d*)\s*步/u);
    if (continuationMatch) {
      const continuedAt = /^\d+$/.test(continuationMatch[1]) ? Number(continuationMatch[1]) : chineseCount[continuationMatch[1]];
      if ([continuedAt, continuedAt + 1].includes(topLevelSteps[0].number)) topLevelExpectedStart = topLevelSteps[0].number;
    }
  }
  if (topLevelSteps.length > 1 || (topLevelSteps.length === 1 && topLevelSteps[0].number !== topLevelExpectedStart)) {
    let expected = topLevelExpectedStart;
    for (const step of topLevelSteps) {
      if (step.number !== expected) nonSequentialTopLevelSteps.push({ ...step, expected });
      expected += 1;
    }
  }
  const selfReferentialStepReferences = topLevelSteps.filter(step => {
    const body = step.line.replace(topLevelStepRe, '');
    const sameStep = new RegExp(`(?:按|根据|依照|参考|完成|继续|回到|返回|执行|做完|做好|做)\\s*第\\s*${step.number}\\s*步(?:\\s*(?:的)?(?:结果|结论|内容|操作|要求|后|再|往下|往后))?`, 'u');
    return sameStep.test(body);
  });
  const userArabicSteps = new Set(Array.from(String(question || '').matchAll(/第\s*([1-9]\d*)\s*步/gu), match => Number(match[1])));
  const definedArabicSteps = new Set(userArabicSteps);
  const undefinedArabicStepReferences = [];
  for (let lineIndex = 0; lineIndex < documentLines.length; lineIndex++) {
    const line = documentLines[lineIndex];
    // 定义按文档顺序生效；后文才出现的“第N步：”不能反向补足前面的
    // “进入第N步”。顶层 `N.` 与明确“第N步：标题”在本行先登记。
    const topLevelDefinition = topLevelSteps.find(step => step.lineIndex === lineIndex);
    if (topLevelDefinition) definedArabicSteps.add(topLevelDefinition.number);
    const heading = line.match(/^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*第\s*([1-9]\d*)\s*步(?:\s*[：:、.]|\s+)/u);
    if (heading) definedArabicSteps.add(Number(heading[1]));
    const referenced = new Set();
    for (const match of line.matchAll(/第\s*([1-9]\d*)(?:\s*[\/、和及]\s*([1-9]\d*))?\s*步/gu)) {
      referenced.add(Number(match[1]));
      if (match[2]) referenced.add(Number(match[2]));
    }
    const undefinedNumbers = Array.from(referenced).filter(number => !definedArabicSteps.has(number) && !userArabicSteps.has(number));
    if (undefinedNumbers.length) undefinedArabicStepReferences.push({ line: line.trim(), lineIndex, numbers: undefinedNumbers });
  }
  // “三选一/以下三类”是选项结构契约。紧随选项可用 A./1./① 等标签，
  // 但实际数量必须匹配声明；字母选项必须从 A 连续，不能只剩 B/C。
  const optionCountDeclarationRe = /(?:(?:用|从|按)?\s*(?:下面|以下|下列|这)\s*([一二两三四五六七八九十]|\d{1,2})\s*(?:选一|类|种(?:情况|结果|分支|选项)?)|([一二两三四五六七八九十]|\d{1,2})\s*选一)/u;
  const optionLineRe = /^\s*(?:[-*+]\s+)?(?:\*\*|__)?\s*(?:([A-Z]|[1-9]\d*)\s*[.、:：）)]\s*|([①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳])\s*)/u;
  const optionCardinalityMismatches = [];
  const nonSequentialOptionSets = [];
  for (let lineIndex = 0; lineIndex < documentLines.length; lineIndex++) {
    const declaration = documentLines[lineIndex].match(optionCountDeclarationRe);
    if (!declaration) continue;
    const countToken = declaration[1] || declaration[2];
    const expected = /^\d+$/u.test(countToken) ? Number(countToken) : chineseCount[countToken];
    let cursor = lineIndex + 1;
    const options = [];
    while (cursor < documentLines.length) {
      if (!documentLines[cursor].trim()) { cursor++; continue; }
      const optionMatch = documentLines[cursor].match(optionLineRe);
      if (!optionMatch) break;
      options.push({ label: optionMatch[1] || optionMatch[2], line: documentLines[cursor].trim(), lineIndex: cursor });
      cursor++;
    }
    if (!options.length) continue;
    if (options.length !== expected) optionCardinalityMismatches.push({
      line: documentLines[lineIndex].trim(), lineIndex, expected, actual: options.length, options,
      block: documentLines.slice(lineIndex, cursor).join('\n'),
    });
    const letterOptions = options.filter(item => /^[A-Z]$/u.test(item.label));
    if (letterOptions.length === options.length) {
      const expectedLabels = letterOptions.map((_, index) => String.fromCharCode(65 + index));
      const actualLabels = letterOptions.map(item => item.label);
      if (actualLabels.some((label, index) => label !== expectedLabels[index])) nonSequentialOptionSets.push({
        line: documentLines[lineIndex].trim(), lineIndex, expectedLabels, actualLabels, options,
        block: documentLines.slice(lineIndex, cursor).join('\n'),
      });
    }
  }
  // A/B/C、A、B、C、A-C 等分组引用只在“分类/分支/选项”语境下解释为
  // 文档变量，避免误伤 API、A/B 测试等普通缩写。每个字母必须在引用前由
  // A. 选项、A=含义正文或符号表定义；后文定义不回填。
  const definedGroupSymbols = new Set();
  const undefinedGroupReferences = [];
  for (let lineIndex = 0; lineIndex < documentLines.length; lineIndex++) {
    const line = String(documentLines[lineIndex] || '');
    const optionMatch = line.match(optionLineRe);
    const optionLabel = optionMatch && (optionMatch[1] || optionMatch[2]);
    if (optionLabel && /^[A-Z]$/u.test(optionLabel)) definedGroupSymbols.add(optionLabel);
    const cells = consultMarkdownTableCells(line);
    if (cells && /^[A-Z]$/u.test(String(cells[0] || '').trim()) && String(cells[1] || '').trim()) definedGroupSymbols.add(String(cells[0]).trim());
    for (const match of line.matchAll(/(?:^|[|,，；;:：\s（(])([A-Z])\s*(?:=|：|:|表示|代表|指代|为)\s*([^|,，；;。\n]{1,32})/gu)) {
      const meaning = String(match[2] || '').trim();
      if (meaning && !/^[A-Z](?:\s|$)/u.test(meaning)) definedGroupSymbols.add(match[1]);
    }
    const groupContext = /(?:哪一类|归类|归到|分类|分组|选项|分支|类别|落在|属于|选择|三选一|二选一)/u.test(line)
      || optionCardinalityMismatches.some(item => item.lineIndex < lineIndex)
      || nonSequentialOptionSets.some(item => item.lineIndex < lineIndex);
    if (!groupContext) continue;
    const references = [];
    for (const match of line.matchAll(/(?<![A-Za-z0-9_])([A-Z])\s*(?:\/|、|,|，)\s*([A-Z])(?:\s*(?:\/|、|,|，)\s*([A-Z]))*(?![A-Za-z0-9_])/gu)) {
      references.push(...match[0].match(/[A-Z]/gu) || []);
    }
    for (const match of line.matchAll(/(?<![A-Za-z0-9_])([A-Z])\s*[-–—]\s*([A-Z])(?![A-Za-z0-9_])/gu)) {
      const start = match[1].charCodeAt(0), end = match[2].charCodeAt(0);
      if (end >= start && end - start <= 12) for (let code = start; code <= end; code++) references.push(String.fromCharCode(code));
    }
    const undefinedSymbols = Array.from(new Set(references.filter(symbol => !definedGroupSymbols.has(symbol))));
    if (undefinedSymbols.length) undefinedGroupReferences.push({ line: line.trim(), lineIndex, symbols: Array.from(new Set(references)), undefinedSymbols });
  }
  const singleStepOverreach = singleStepQuestion && topLevelSteps.length > 1
    ? { steps: topLevelSteps, truncateFromLine: topLevelSteps[1].lineIndex }
    : null;
  const focusedFactQuestion = !!consultFocusedFactGuard(question);
  const focusedTypeOrLengthQuestion = focusedFactQuestion
    && /(?:字段|列|column|varchar|uuid|integer|bigint|patient_id|visit_id|hospitalId|districtCode)/i.test(String(question || ''))
    && /(?:类型|type|长度(?:多少|是什么))/i.test(String(question || ''));
  const likelihoodClaims = text.split(/(?<=[。！？；\n])/u).map(x => x.trim()).filter(statement => {
    const matched = CONSULT_LIKELIHOOD_WORD_RE.test(statement) || /典型(?:现象|表现|场景|特征|模式|症状)(?:边界)?/u.test(statement);
    CONSULT_LIKELIHOOD_WORD_RE.lastIndex = 0;
    return matched;
  });
  const unsupportedLikelihoodClaims = likelihoodClaims.filter(statement => !consultHasLikelihoodEvidence(question, route, statement));
  const causalBoundaryLabelRe = /(?:待验证(?:假设|分支)?|可能分支|待核|需(?:要)?(?:查看|结合|核对|确认)[^。！？；\n]{0,24}(?:原始日志|异常堆栈|日志|堆栈)|(?:不能|不足以|无法)据此(?:确认|判断|证明)|只(?:能)?(?:说明|确认|固定)[^。！？；\n]{0,32}(?:观测|现象|边界|未观察到))/iu;
  const causalLocalizationClaims = text.split(/(?<=[。！？；\n])/u).map(x => x.trim()).filter(statement => {
    const matched = CONSULT_CAUSAL_LOCALIZATION_RE.test(statement);
    CONSULT_CAUSAL_LOCALIZATION_RE.lastIndex = 0;
    return matched && !causalBoundaryLabelRe.test(statement);
  });
  const unsupportedCausalLocalizationClaims = causalLocalizationClaims.filter(statement => !consultHasLikelihoodEvidence(question, route, statement));
  const deterministicFailureClaims = text.split(/(?<=[。！？；\n])/u).map(x => x.trim()).filter(statement => {
    const matched = CONSULT_DETERMINISTIC_FAILURE_RE.test(statement);
    CONSULT_DETERMINISTIC_FAILURE_RE.lastIndex = 0;
    return matched;
  });
  const unsupportedDeterministicFailureClaims = deterministicFailureClaims.filter(statement => !consultHasLikelihoodEvidence(question, route, statement));
  const contradictoryObservationOrderClaims = text.split(/(?<=[。！？；\n])/u).map(x => x.trim()).filter(statement => {
    const matched = CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE.test(statement);
    CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE.lastIndex = 0;
    return matched;
  });
  const likelihoodAllowed = (likelihoodClaims.length || causalLocalizationClaims.length || deterministicFailureClaims.length)
    ? unsupportedLikelihoodClaims.length === 0 && unsupportedCausalLocalizationClaims.length === 0 && unsupportedDeterministicFailureClaims.length === 0
    : consultHasLikelihoodEvidence(question, route);
  const likelihoodTerms = Array.from(new Set([
    ...unsupportedLikelihoodClaims.flatMap(statement => statement.match(CONSULT_LIKELIHOOD_WORD_RE) || []),
    ...unsupportedLikelihoodClaims.flatMap(statement => statement.match(/典型(?:现象|表现|场景|特征|模式|症状)(?:边界)?/gu) || []),
    ...unsupportedCausalLocalizationClaims.flatMap(statement => statement.match(CONSULT_CAUSAL_LOCALIZATION_RE) || []),
    ...unsupportedDeterministicFailureClaims.flatMap(statement => statement.match(CONSULT_DETERMINISTIC_FAILURE_RE) || []),
  ]));
  CONSULT_LIKELIHOOD_WORD_RE.lastIndex = 0;
  CONSULT_CAUSAL_LOCALIZATION_RE.lastIndex = 0;
  CONSULT_DETERMINISTIC_FAILURE_RE.lastIndex = 0;
  CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE.lastIndex = 0;
  const causalPriorityAllowed = consultHasCausalPriorityEvidence(question, route);
  const causalPriorityTerms = causalPriorityAllowed ? [] : Array.from(new Set(text.match(CONSULT_CAUSAL_PRIORITY_RE) || []));
  const controlled = consultHasControlledActionBundle(question);
  const actorAction = /(?:让|请|交给|通知|要求|转|压|催|催促|推动|协调)?\s*(?:实施|用户|患者|对接(?:方)?|接口方|第三方|厂商|供应商|院方|运维|开发)[^。！？；\n]{0,64}(?:(?:改|修改|调整|切换|对齐|校准|统一|转换|修(?:复)?)[^。！？；\n]{0,16}(?:参数|传参(?:方式)?|传输方式|接口入参|报文(?:类型)?|类型|序列化(?:口径|方式|规则)?|编码(?:口径|方式|规则)?|协议(?:口径|规则)?|映射|结构|关联|链路|配置|时区|系统时间|环境|产品口径|业务口径|日切要求|服务配置|字符串|数字(?:类型)?|字段格式|数据格式|值类型)|(?:按|以)[^。！？；\n]{0,12}(?:字符串|数字(?:类型)?|指定格式|文本格式|字段格式|数据格式|值类型)[^。！？；\n]{0,8}(?:传|发送)|对时|重试|复测|重跑|补跑|重新触发|再次触发|再点|点一次|提交|保存|发送|完成|签名|审批|星标|再传|重传|重新发送)/ig;
  const negatedActorPrefix = /(?:不得|不能|不要|禁止|不可|不应|先别|停止|未确认)\s*$/i;
  const negatedRiskyAction = (statement, matchIndex) => {
    const source = String(statement || '');
    const prefix = source.slice(0, Math.max(0, Number.isInteger(matchIndex) ? matchIndex : source.length));
    const delimiterIndex = Math.max(
      prefix.lastIndexOf('，'), prefix.lastIndexOf(','), prefix.lastIndexOf('：'),
      prefix.lastIndexOf(':'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'),
      prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'), prefix.lastIndexOf('\n'),
    );
    const clausePrefix = prefix.slice(delimiterIndex + 1).trim();
    // A route fact may put context between the prohibition and the risky verb
    // ("不能单独证明患者…" / "也不要为补日志重复提交…"). Keep the check
    // within the same clause so a later positive instruction remains unsafe.
    return /(?:不得|不能|不要|禁止|不可|不应|先别|停止|未确认)[^。！？；\n]{0,24}$/u.test(clausePrefix);
  };
  const routeActionFacts = route && route.matched
    ? [...(route.answerFacts || []), ...(route.mustNotConfuse || []), ...(route.directEvidenceFacts || [])].map(String).filter(Boolean)
    : [];
  const normalizeRouteActionText = value => String(value || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  const statementIsRouteFact = statement => {
    const normalized = normalizeRouteActionText(statement);
    return normalized.length >= 8 && routeActionFacts.some(fact => normalizeRouteActionText(fact).includes(normalized));
  };
  const unsafeActorActions = controlled ? [] : text.split(/(?<=[。！？；\n])/u)
    .map(x => x.trim()).filter(statement => statement && !statementIsRouteFact(statement) && Array.from(statement.matchAll(actorAction))
      .some(match => !negatedActorPrefix.test(statement.slice(0, match.index)) && !negatedRiskyAction(statement, match.index)));
  const fullHandoffMaterialQuestion = /(?:(?:完整|全部|全套|正式)[^。！？\n]{0,16}(?:提单|工单|转开发|交接|材料包|留证包)|(?:提单|工单|转开发|交接)[^。！？\n]{0,16}(?:完整|全部|全套|材料清单|最少补哪些信息))/u.test(intentQuestionText);
  const explicitPartialEvidenceQuestion = /(?:(?:只(?:能)?确认|仅(?:能)?确认|只确认|仅确认)[\s\S]{0,160}(?:没(?:有)?拿到|未(?:拿到|取得)|没有|无|拿不到|未知|待确认|尚未)[\s\S]{0,160}(?:先说|能确定|未知(?:项|部分)?(?:单独|另行)|哪些(?:成立|确认)|待确认)|(?:当前|现在|本轮|现有)?\s*(?:只有|仅有|只拿到|仅拿到)[^。！？\n]{0,120}(?:哪些[^。！？\n]{0,20}(?:成立|确认)|(?:仍|还)?需(?:要)?确认))/iu.test(intentQuestionText);
  const partialEvidenceInventoryQuestion = explicitPartialEvidenceQuestion
    && /(?:哪些[^。！？\n]{0,24}(?:成立|能确认|可确认)|(?:哪些|何者)[^。！？\n]{0,24}(?:仍|还)?需(?:要)?确认)/iu.test(intentQuestionText);
  const existingRecordNarrowingQuestion = /(?:仅用|只用|只靠)(?:已有|现有)(?:的)?(?:记录|请求|响应|证据)[^。！？\n]{0,64}(?:缩小范围|缩小定位范围|判断|定位)/iu.test(intentQuestionText);
  const explicitNonDestructiveBoundaryQuestion = existingRecordNarrowingQuestion
    && /(?:不能|不得|不要|禁止)[^。！？\n]{0,32}(?:改数据|重放|重提|重复提交)/u.test(intentQuestionText);
  // “只有页面现象/requestId、还没有原始日志，下一步最少补哪类证据”是
  // 受限证据题。它没有使用“哪些已确认”的旧句式，不能落回普通事实或
  // 整体安全停止；识别条件只描述证据缺口，不绑定具体业务 route。
  const minimalEvidenceQuestion = /(?:复测|现场|转开发|开发前|复核)/iu.test(intentQuestionText)
    && /(?:最少|最小)[^。！？\n]{0,48}(?:补|补充|证据|请求|响应|日志)/iu.test(intentQuestionText)
    && (/(?:只有|仅有|只拿到|仅拿到)[^。！？\n]{0,96}(?:页面|界面|截图|现象|requestId)/iu.test(intentQuestionText)
      || /(?:没有|无|未(?:拿到|取得))[^。！？\n]{0,24}(?:原始)?日志/iu.test(intentQuestionText)
      || /页面现象/iu.test(intentQuestionText));
  const evidenceSufficiencyQuestion = !fullHandoffMaterialQuestion
    && (/(?:只有|仅有|只(?:有|拿得到|拿到|能拿到)|没有|拿不到)[^。！？\n]{0,48}(?:够不够|够吗|是否足够|足不足够|能不能判断|能否判断|可以判断吗)/u.test(intentQuestionText)
      || /(?:现有|当前|已有|这些?)?证据[^。！？\n]{0,24}(?:最多|至多)(?:能|可(?:以)?)?(?:判断|确认|证明)到哪/u.test(intentQuestionText)
      || explicitPartialEvidenceQuestion
      || minimalEvidenceQuestion
      || existingRecordNarrowingQuestion);
  // 评测/现场会话常在问句前加“另一轮独立复测（N）里”。归一化后这个
  // 前缀不会改变普通“现在怎么实现”的事实题意，但当本轮明确盘点接口、
  // 数据和边界时，它本身就是现场复测语境，不能再按普通 broad facts 只复述。
  const explicitReviewDiagnosticQuestion = /(?:另一轮独立复测|现场复测|独立复测|现场复核)/iu.test(questionText)
    && /(?:接口|数据|边界)/iu.test(intentQuestionText)
    // “从入口到外部依赖串起来”是显式研发链路题，沿用 chain fallback
    // 的入口/接口/数据/依赖合同，不应被复测诊断四步门改写为 field_diagnostic。
    && !/(?:串起来|串联|全链路|调用链|实现链路|从[^.。！？\n，,；;]{1,80}到[^.。！？\n，,；;]{1,40})/iu.test(questionText);
  // 题面虽像“接口、数据和边界”的宽事实盘点，但浏览器咨询合同要求它
  // 同时给出可执行的只读排查顺序。这个识别只看三个通用维度及“涉及/
  // 包含/梳理”语义，不绑定 route 标题、字段或评测编号；显式链路串题
  // 仍由 chain fallback 处理。
  const interfaceDataBoundaryDiagnosticQuestion = /(?:涉及|包含|覆盖|盘点|梳理)[^。！？\n]{0,80}(?:接口|数据|边界)/iu.test(intentQuestionText)
    && /接口/iu.test(intentQuestionText)
    && /数据/iu.test(intentQuestionText)
    && /边界/iu.test(intentQuestionText)
    && !/(?:串起来|串联|全链路|调用链|实现链路|从[^.。！？\n，,；;]{1,80}到[^.。！？\n，,；;]{1,40})/iu.test(questionText);
  // “上一层已经核过且正常，下一步继续怎么查”是上下文续问：它仍需
  // 只读、分层、可执行的排查顺序，不能因为没有再次点名“接口/字段”
  // 就退回只复述 route facts。匹配按问句语义而非题号/具体业务模块，
  // 并要求前一层的已核结果与下一步只读动作同时出现，避免普通事实题误扩写。
  const continuationDiagnosticQuestion = /(?:第一层|上一步|前一步|前一层|上一层)[^。！？\n]{0,80}(?:核过|核对过|确认过|看过|检查过|验证过)[^。！？\n]{0,32}(?:没(?:有)?异常|无异常|正常|没问题|未见异常)/iu.test(intentQuestionText)
    && /(?:下一步|接下来|继续|往下)[^。！？\n]{0,64}(?:按什么顺序|顺序|只读|排查|核对|检查|留证|怎么查|如何查)/iu.test(intentQuestionText);
  // 接口已经返回内容但页面未呈现、且用户要转开发前的最小证据时，
  // 问题本质是现场取证而不是再次复述功能事实。这个识别不依赖具体
  // route 或实体名，要求同时出现“接口有数据”和“页面未呈现”两侧。
  const dataReturnedNotRenderedQuestion = /(?:接口|请求)[^。！？\n]{0,32}(?:返回|有|拿到)[^。！？\n]{0,24}(?:数据|内容)[^。！？\n]{0,24}(?:页面|界面)[^。！？\n]{0,20}(?:没(?:有)?呈现|未(?:有)?呈现|不显示|未显示|看不到|没展示)/iu.test(intentQuestionText)
    && /(?:转开发|开发前|最小证据|整理|提单|交接)/iu.test(intentQuestionText);
  // 用户明确要求把已有排查建议改成实施可逐项照做的只读清单时，
  // 必须有可执行的编号步骤，而不是只返回一个清单标题。
  const implementationChecklistQuestion = /(?:换成|改成|改为|整理成)[^。！？\n]{0,32}实施[^。！？\n]{0,32}(?:逐项|逐条|照做|执行)[^。！？\n]{0,32}只读(?:清单|步骤|排查|核对)/iu.test(intentQuestionText);
  // “请求通但结果不对，接下来对照哪一层”是分层诊断问法；它需要
  // 保留请求/响应、业务状态、页面刷新和相邻边界的只读对照顺序。
  const requestResultMismatchQuestion = /(?:接口|请求)[^。！？\n]{0,28}(?:是通的|正常|成功|有响应)[^。！？\n]{0,24}(?:但|可是|然而)[^。！？\n]{0,28}(?:业务)?结果[^。！？\n]{0,24}(?:不符合预期|不对|不一致|异常)/iu.test(intentQuestionText)
    && /(?:接下来|下一步|重点对照|哪一层|怎么查|如何查|排查|核对)/iu.test(intentQuestionText);
  // 多步状态、流水、缓存/任务键、消息和外部回调是否在同一事务，不能
  // 只答“是/否”：现场还需要沿副作用发生顺序只读核对，才能判断停在哪层。
  // 维度数门避免普通单表事务问法被扩成跨系统排查。
  const transactionSideEffectDimensions = [
    /(?:任务|业务|对象|主)[^。！？\n]{0,12}状态|主状态/iu,
    /(?:审核|操作|业务)?流水|审核记录|操作记录/iu,
    /Redis|缓存|超时[^。！？\n]{0,12}(?:key|键)|任务键/iu,
    /消息|通知/iu,
    /HIS[^。！？\n]{0,12}回调|外部[^。！？\n]{0,12}回调|回调日志/iu,
  ].filter(re => re.test(intentQuestionText)).length;
  const multiStepTransactionDiagnosticQuestion = transactionSideEffectDimensions >= 3
    && /(?:(?:是否|能否|是不是|有没有|有无)[^。！？\n]{0,24}(?:同一|一个|统一|整体|总)(?:个)?事务|(?:同一|一个|统一|整体|总)(?:个)?事务[^。！？\n]{0,24}(?:吗|是否|能否|是不是)?)/iu.test(intentQuestionText);
  // “批量/多对象中途失败 + 重试边界”改写成实施只读清单时，既要有
  // 可执行顺序，也必须保住 route 已核的原状态、幂等/锁与重复副作用事实。
  const retryBoundaryChecklistQuestion = implementationChecklistQuestion
    && /(?:批量|一批|同一批|多任务|多对象)/iu.test(intentQuestionText)
    && /(?:中途|部分成功|失败|报错|重试|重复|幂等|补偿|重放)/iu.test(intentQuestionText);
  // 页面按钮、复选框、菜单等“不可操作”只证明前端限制生效，不能单独
  // 证明服务端授权安全。用户拿 UI 限制询问权限/越权安全时，本质是在问
  // 证据是否充分，必须转成页面→既有请求→服务端校验→既有流水的只读
  // 分层核对；规则按通用语义识别，不绑定具体控件、接口或业务 route。
  const uiRestrictionEvidenceQuestion = /(?:(?:页面|界面|前端)[^。！？\n]{0,40}(?:复选框|按钮|菜单|入口|控件|操作)[^。！？\n]{0,32}(?:不可选|不能选|无法选择|禁选|禁用|不可用|隐藏|看不到|不能点击|无法点击)|(?:复选框|按钮|菜单|入口|控件)[^。！？\n]{0,32}(?:不可选|不能选|无法选择|禁选|禁用|不可用|隐藏|看不到|不能点击|无法点击)[^。！？\n]{0,32}(?:页面|界面|前端)?)/iu.test(intentQuestionText);
  const authorizationProofIntent = /(?:能否|是否|能不能|可否|是否足以|足以|可以|能够)[^。！？\n]{0,24}(?:证明|代表|说明|等于|意味着)|(?:证明|代表|说明|等于|意味着)[^。！？\n]{0,32}(?:权限|授权|归属|越权|安全)/iu.test(intentQuestionText)
    && /(?:权限|授权|归属|越权|安全)/iu.test(intentQuestionText);
  const uiAuthorizationProofQuestion = uiRestrictionEvidenceQuestion && authorizationProofIntent;
  // 外部会话、消息、通知或回调失败后，业务步骤是否仍会继续，是典型的
  // 跨步骤故障结果题。即使问句没有再写“排查/现场”，连续会话中仍应按
  // 只读诊断回答，避免把 route 里的补发、重做等处置建议直接发布成动作。
  const externalStepFailureOutcomeQuestion = /(?:创建|发送|调用|推送)?(?:会话|消息|通知|回调|外部服务)[^。！？\n]{0,24}(?:失败|异常|报错|中断)[^。！？\n]{0,48}(?:还会|是否还|能否继续|会不会继续|是否继续|结果|状态)/iu.test(intentQuestionText)
    || /(?:失败|异常|报错|中断)[^。！？\n]{0,40}(?:会话|消息|通知|回调|外部服务)[^。！？\n]{0,40}(?:还会|是否还|能否继续|会不会继续|是否继续|结果|状态)/iu.test(intentQuestionText);
  const diagnosticQuestion = explicitPartialEvidenceQuestion || minimalEvidenceQuestion || explicitReviewDiagnosticQuestion || interfaceDataBoundaryDiagnosticQuestion || continuationDiagnosticQuestion || dataReturnedNotRenderedQuestion || implementationChecklistQuestion || requestResultMismatchQuestion || multiStepTransactionDiagnosticQuestion || retryBoundaryChecklistQuestion || uiAuthorizationProofQuestion || externalStepFailureOutcomeQuestion || /(?:排查|定位|不一致|对不上|异常|故障|现场|验证|复测|下一步|怎么判断|如何判断|怎么确认|检查|留证|只能确认|能确定|能判断到哪|最多(?:能|可)?判断|不知道|未知|走到哪|还缺什么|够不够|够吗|是否足够|能不能判断|能否判断)/i.test(intentQuestionText);
  // 受众层级也必须过发布前确定性终审，不能只相信模型遵守 prompt。
  // 普通“怎么实现”仍是产品问法；只有显式技术契约才进入 developer。
  const audienceDeveloperQuestion = /(?:接口(?:路径|地址|契约|入参|出参|返回)?|字段(?:名|类型|长度|取值)?|列(?:名|类型|长度|取值)?|column(?:s)?(?:\s*(?:name|type|length|value))?|哪张表|表名|数据库表|SQL|源码|代码|开发链路|调用链|调用关系|Java\s*类|类名|方法名|Controller|Service|Mapper|Repository|DAO|DTO|VO)(?:[^。！？\n]{0,28}(?:什么|哪些|哪个|哪里|在哪|怎么|如何|实现|定义|调用|读写|保存|返回|排查|看|查))?|(?:什么|哪些|哪个|哪里|在哪|怎么|如何|看|查)[^。！？\n]{0,28}(?:接口|字段|列|column|哪张表|表名|SQL|源码|代码|开发链路|调用链|Java\s*类|Controller|Service|Mapper|DTO|VO)/i.test(questionText);
  const audienceImplementationQuestion = !audienceDeveloperQuestion && (diagnosticQuestion
    || /(?:实施(?:口径|步骤|清单|排查|复测|核对|留证)|回归|转开发|只读(?:步骤|清单|检查|核)|抓包|抓到|抓取|重点核|核什么|核对|请求(?:和|与|\/)?响应|日志|截图|怎么查|如何查|排查|留证)/i.test(intentQuestionText));
  const audienceMode = audienceDeveloperQuestion ? 'developer' : audienceImplementationQuestion ? 'implementation' : 'product';
  const sourceTechnicalRe = /(?:[A-Za-z0-9_./-]+\.java\b|(?:^|[\s`/])src\/(?:main|test)\/|\b[A-Z][A-Za-z0-9_$]*(?:Controller|Service|Mapper|Repository|DAO|DTO|VO)\b|(?:Controller|Service|Mapper|Repository|DAO|DTO|VO)\s*[.#：:]|(?:表名|数据库表|写入表|读取表|落到表|查询表)\s*(?:是|为|[:：])?\s*[`'“”]?\s*[a-z][a-z0-9_]{2,}|(?:字段名?|参数名?)\s*(?:是|为|[:：])\s*[`'“”]?\s*[a-z][A-Za-z0-9_]{2,}|\b[a-z][A-Za-z0-9_]{2,}\s*=|`[a-z][A-Za-z0-9_]{2,}`)/i;
  const concreteInterfaceRe = /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./{}?=&:%-]+|`\/[A-Za-z0-9_./{}?=&:%-]+`)/i;
  const productTechnicalMetaRe = /(?:接口(?:路径|地址|契约|入参|出参)|(?:请求|响应)?字段(?:名|类型|长度|取值)?|状态值|Java\s*(?:模型|类)|源码|研发参考|技术依据|代码路径|类名|方法名|表名|开发链路|调用链|Controller|Service|Mapper|Repository|DAO|DTO|VO|(?:说明书|spec|规格|资料|摘录|正文|契约|文档)[^。！？；\n]{0,40}(?:没(?:有)?|未|无|不明确|无法确认|只(?:能)?确认))/i;
  const audienceParts = text.split(/\n|(?<=[。！？；])/u).map(part => part.trim()).filter(Boolean);
  const referenceIndex = text.search(/(?:^|\n)\s*(?:#{1,6}\s*)?(?:\*\*)?研发参考(?:\*\*)?\s*[：:]?/mu);
  const textBeforeReference = referenceIndex >= 0 ? text.slice(0, referenceIndex) : text;
  // status=0/state=pending 等 token 也可能是业务动作成立的必要条件，不能
  // 仅因含技术形态就把“只有在…时才可…”从实施正文拆走。仅豁免 current
  // route 已逐字提供的完整条件句；模型自造条件或普通接口技术句仍归研发参考。
  const verifiedBusinessCondition = value => {
    const plain = String(value || '').replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '').trim();
    if (!/(?:只有在|仅在|当|如果|若|除非)[^。！？；\n]{0,120}(?:时|才|才能|方可|允许|不得|不能|不再|只保留)/u.test(plain)
      || !/(?:才可|才能|方可|允许|不得|不能|不再|只保留)/u.test(plain)) return false;
    return !!(route && route.matched && (route.answerFacts || []).some(fact => {
      const source = String(fact || '').trim();
      return source === plain || source.includes(plain) || plain.includes(source);
    }));
  };
  const productTechnicalParts = audienceMode === 'product'
    ? audienceParts.filter(part => sourceTechnicalRe.test(part) || concreteInterfaceRe.test(part) || productTechnicalMetaRe.test(part)) : [];
  const implementationMisplacedTechnicalParts = audienceMode === 'implementation'
    ? textBeforeReference.split(/\n|(?<=[。！？；])/u).map(part => part.trim())
      .filter(part => part && sourceTechnicalRe.test(part) && !verifiedBusinessCondition(part)) : [];
  const firstAudiencePart = audienceParts.find(part => !/^(?:#{1,6}\s*)?(?:\*\*)?(?:结论|业务结论|当前结论|判断)(?:\*\*)?\s*[：:]?$/u.test(part)) || '';
  const implementationTechnicalFirstParts = audienceMode === 'implementation' && !verifiedBusinessCondition(firstAudiencePart)
    && (sourceTechnicalRe.test(firstAudiencePart) || concreteInterfaceRe.test(firstAudiencePart))
    ? [firstAudiencePart] : [];
  const audienceTechnicalParts = Array.from(new Set([
    ...productTechnicalParts,
    ...implementationMisplacedTechnicalParts,
    ...implementationTechnicalFirstParts,
  ]));
  const readOnlyWriteInstructionRe = /(?:^|[，：:；;]\s*)(?:[-*]\s+|[1-9]\d*[.、．]\s*)?(?:准备|先|再|然后|请|让|用|尝试|建议|可以|需要|应当|应该|去)[^。！？；\n]{0,40}(?:新建|新增|创建|编辑|删除|保存|提交|发送|完成|签名|审批|星标|补跑|重跑|重试|重新触发|再次触发)/iu;
  const unsafeDirectActions = controlled || !(diagnosticQuestion || /只读/u.test(text)) ? [] : text.split(/(?<=[。！？；\n])/u)
    .map(x => x.trim()).filter(statement => statement && !statementIsRouteFact(statement) && (
      Array.from(statement.matchAll(CONSULT_DIRECT_RISKY_ACTION_RE))
        .some(match => !negatedActorPrefix.test(statement.slice(0, match.index)) && !negatedRiskyAction(statement, match.index))
      || readOnlyWriteInstructionRe.test(statement)
    ));
  // “只有既有请求/响应、无数据库或日志权限”只定义了本轮观测边界，不能被
  // 模型改写成“未落库/不写日志/不涉及任务状态”等否定事实。此类错误不是
  // 概率归因，也未必是组件故障，必须单独做确定性终审。若用户原文或 current
  // route 正文确实逐字支持同一否定规则（例如明确“不写操作日志表”），仍照实放行。
  const evidenceBoundaryQuestion = evidenceSufficiencyQuestion
    || /(?:只有|仅有|只(?:有|拿到|能拿到))[^。！？\n]{0,48}(?:请求|响应)|(?:无|没有|拿不到|不能查|无法查看)[^。！？\n]{0,18}(?:数据库|日志)(?:权限|记录|内容)?/u.test(questionText);
  const requestResponseOnly = /(?:只有|仅有|只(?:有|拿到|能拿到))[^。！？\n]{0,56}(?:请求[^。！？\n]{0,24}响应|响应[^。！？\n]{0,24}请求)/u.test(questionText);
  const unavailableEvidenceKinds = new Set();
  if (requestResponseOnly || /(?:无|没有|拿不到|不能查|无法查看)[^。！？\n]{0,18}(?:数据库|库内|表内)(?:权限|记录|内容)?/u.test(questionText)) unavailableEvidenceKinds.add('database');
  if (requestResponseOnly || /(?:无|没有|拿不到|不能查|无法查看)[^。！？\n]{0,18}(?:服务端|应用|任务|审计|操作)?日志(?:权限|记录|内容)?/u.test(questionText)) unavailableEvidenceKinds.add('logs');
  if (requestResponseOnly || /(?:无|没有|拿不到|不能查|无法查看)[^。！？\n]{0,18}(?:任务|业务|处理)?状态(?:权限|记录|内容)?/u.test(questionText)) unavailableEvidenceKinds.add('state');
  const evidenceKindRules = [
    { id: 'database', re: /(?:数据库|库内|落库|入库|持久化|写入(?:数据|记录|表)|写入\s*[A-Za-z_][\w.]*|表(?:中|内))/iu },
    { id: 'logs', re: /(?:日志|审计记录|操作记录|留痕记录)/iu },
    { id: 'state', re: /(?:(?:审核|任务|业务|处理)?状态|生命周期|处理进度|后续处理)/iu },
  ];
  const unsupportedNegativeAssertionRe = /(?:不涉及|并未涉及|没有(?:发生|产生|写入|记录|落库|入库|持久化|变化)?|尚未|未(?:发生|产生|写入|记录|落库|入库|持久化|变化)?|不会|不存在|不产生|不写入|不记录|不落库|不入库|无需)/u;
  const stripEpistemicBoundary = value => String(value || '')
    .replace(/(?:无法|不能|尚不能|不足以|不(?:能|足以))(?:据此)?(?:确认|判断|证明|断言|认定|排除|说明|说)[^。！？；\n]*/gu, '')
    .replace(/(?:仍|尚)?(?:未知|待确认|待核实|未核实|未验证)/gu, '')
    .replace(/(?:没有|缺少|无|未取得)[^。！？；\n]{0,12}(?:权限|证据|材料|观察|观测)/gu, '')
    .replace(/(?:未观察到|未看到|看不到|拿不到|不代表)[^。！？；\n]*/gu, '');
  const hasUnsupportedNegativeAssertion = value => unsupportedNegativeAssertionRe.test(stripEpistemicBoundary(value));
  const normalizeNegativeClaim = value => {
    const plain = String(value || '').replace(/[*_`\s，,。！？；;：:（）()]/gu, '')
      .replace(/并未涉及|不涉及|尚未|不会|不存在|不产生|不写入|不记录|不落库|不入库|没有|未|无需/gu, '不');
    const at = plain.search(/不/u);
    return at >= 0 ? plain.slice(at) : plain;
  };
  const negativeClaimSupported = (statement, kind) => {
    const candidates = [questionText, ...(route && route.matched ? [...(route.answerFacts || []), ...(route.mustNotConfuse || []), ...(route.directEvidenceFacts || [])] : [])]
      .flatMap(value => String(value || '').split(/[。！？；;\n]/u)).map(value => value.trim()).filter(Boolean);
    const claim = normalizeNegativeClaim(statement);
    return candidates.some(candidate => {
      if (!kind.re.test(candidate) || !hasUnsupportedNegativeAssertion(candidate)) return false;
      const known = normalizeNegativeClaim(candidate);
      return claim && known && (claim.includes(known) || known.includes(claim));
    });
  };
  const unsupportedEvidenceNegations = !evidenceBoundaryQuestion ? [] : text.split(/(?<=[。！？；\n])/u)
    .map(statement => statement.trim()).filter(statement => {
      if (!statement || !hasUnsupportedNegativeAssertion(statement)) return false;
      const affectedKinds = evidenceKindRules.filter(kind => unavailableEvidenceKinds.has(kind.id) && kind.re.test(statement));
      return affectedKinds.some(kind => !negativeClaimSupported(statement, kind));
    });
  // “本轮摘录里没看到”不能反推“Spec 没写/只确认到这里”。只有 current route
  // 的 answerFacts、mustNotConfuse 或本轮真正注入的正文明确标成 NEEDS-HUMAN、
  // 未覆盖/未定义时，才允许发布同主题的资料缺失结论。否则确定性终审删除该句，
  // 并从同一 direct evidence 恢复它错误降级的已核契约事实。
  const evidenceAbsenceClaimRe = /(?:(?:说明书|spec|规格|资料|摘录|正文|契约|文档)[^。！？；\n]{0,48}(?:(?:没(?:有)?|未|无)(?:(?:将|把|被)[^。！？；\n]{0,20})?(?:写明|说明|明确|覆盖|提及|提到|定义|给出|包含|确认|写成|列为|列入|纳入)(?:[^。！？；\n]{0,16}(?:已|经)?确认(?:事实|行为|规则|范围|契约)?)?|(?:不|无法)(?:明确|确认|核实|判断))|(?:说明书|spec|规格|资料|摘录|正文|契约|文档)[^。！？；\n]{0,24}(?:只(?:能)?确认)[^。！？；\n]{0,48}(?:具体|其余|其它|其他)[^。！？；\n]{0,24}(?:不明确|未知|无法确认))/iu;
  const explicitEvidenceGapRe = /(?:NEEDS-HUMAN|未实现|未定义|未覆盖|未写明|没有(?:写明|说明|定义|覆盖|找到)|无法核验|找不到|未找到|不明确|待确认|局部未知)/iu;
  const contractDetailRe = /(?:\bAC-\d+\b|Given|When|Then|调用|读取|取得|取\s*`?[A-Za-z]|返回|写入|序列化|字段|状态|规则|接口|列表|JSON|content)/iu;
  const evidenceTerms = value => {
    const source = String(value || '').toLowerCase(), out = [];
    const chars = source.match(/[一-鿿]/g) || [];
    for (let i = 0; i < chars.length - 1; i++) out.push(chars[i] + chars[i + 1]);
    for (const word of source.match(/[a-z0-9_]{2,}/g) || []) out.push(word);
    return [...new Set(out)].filter(term => !new Set(['当前', '现有', '具体', '确认', '说明', '资料', '摘录', '正文', '字段', '规则', '系统', '接口', '任务', '上下', '下文']).has(term));
  };
  const routeEvidenceLines = route && route.matched
    ? [...(route.answerFacts || []), ...(route.mustNotConfuse || []), ...(route.directEvidenceFacts || [])]
      .flatMap(value => String(value || '').split(/\r?\n/u)).map(line => line.trim())
      .filter(line => line && !/^#{1,6}\s|^```|^---+$/u.test(line))
    : [];
  const absenceSubject = statement => {
    const direct = String(statement || '').match(/^(?:关于|针对)?\s*([A-Za-z][\w.-]{1,60}|[一-鿿]{2,12})(?=只(?:能)?确认)/iu);
    return direct ? direct[1] : '';
  };
  const evidenceLineMatchesClaim = (line, statement) => {
    const subject = absenceSubject(statement);
    if (subject) return String(line).toLowerCase().includes(subject.toLowerCase());
    const claimTerms = new Set(evidenceTerms(statement));
    let overlap = 0;
    for (const term of evidenceTerms(line)) if (claimTerms.has(term)) overlap++;
    return overlap >= 2;
  };
  const absenceClaimSupported = statement => routeEvidenceLines.some(line => explicitEvidenceGapRe.test(line) && evidenceLineMatchesClaim(line, statement));
  const unsupportedEvidenceAbsenceClaims = text.split(/(?<=[。！？；\n])/u).map(statement => statement.trim())
    .filter(statement => statement && evidenceAbsenceClaimRe.test(statement) && !absenceClaimSupported(statement));
  const evidenceAbsenceCorrectionFacts = [];
  for (const statement of unsupportedEvidenceAbsenceClaims) {
    for (const line of routeEvidenceLines) {
      if (explicitEvidenceGapRe.test(line) || !contractDetailRe.test(line) || !evidenceLineMatchesClaim(line, statement)) continue;
      const fact = line.replace(/^[-*+]\s+/u, '').replace(/^\*\*AC-[^*]+\*\*\s*/iu, '').trim();
      // 只恢复被错误降级、但草稿尚未正确表达的契约。已在草稿中逐字出现的
      // summary 不占用 3 条恢复预算，否则混合缺失句会把后面真正被遗漏的状态/字段挤掉。
      if (fact && !text.includes(fact) && !evidenceAbsenceCorrectionFacts.includes(fact)) evidenceAbsenceCorrectionFacts.push(fact);
      if (evidenceAbsenceCorrectionFacts.length >= 3) break;
    }
    if (evidenceAbsenceCorrectionFacts.length >= 3) break;
  }
  const unsupportedComponentClaims = consultUnsupportedComponentClaims(text, question, route);
  const routeText = consultRouteScopeText(route);
  const scopeText = `${question || ''}\n${routeText}`;
  const allowedPaths = new Set(consultConcretePaths(`${question || ''}\n${routeText}`));
  const unexpectedPaths = consultConcretePaths(text).filter(p => !allowedPaths.has(p));
  const unexpectedEntityTerms = consultScopeEntityTerms()
    .filter(term => text.toLowerCase().includes(term.toLowerCase()) && !scopeText.toLowerCase().includes(term.toLowerCase()))
    .filter((term, index, terms) => !terms.slice(0, index).some(parent => parent.includes(term)));
  const unexpectedMechanismTerms = diagnosticQuestion
    ? consultDiagnosticMechanismTerms(text).filter(term => !consultDiagnosticMechanismTerms(scopeText).includes(term))
    : [];
  const scopeTechnicalTokens = new Set(consultScopeTechnicalTokens(scopeText).map(token => token.toLowerCase()));
  const inheritedFocusTokens = Array.isArray(route && route.focusTechnicalTokens) ? route.focusTechnicalTokens : [];
  const focusedTechnicalTokens = Array.from(new Set([...inheritedFocusTokens, ...consultScopeTechnicalTokens(question)]));
  const focusedFieldScope = focusedTechnicalTokens.length > 0
    // “待审列表/患者列表”里的“列”不是数据库列或字段语义。只有独立列语义
    // （不紧邻“表”）才启用 sibling-token 收窄，避免把同一 route 已核状态值
    // 错判为字段越界；真正的字段/列类型题仍保持严格作用域。
    && /(?:字段|列(?!表)|column|类型|长度|编号|患者号|标识符)/i.test(`${question || ''} ${(route && route.route && route.route.title) || ''}`)
    && /(?:字段|列(?!表)|column|类型|长度)/i.test(String((route && route.route && route.route.title) || ''));
  const focusedTechnicalSet = new Set(focusedTechnicalTokens.map(token => token.toLowerCase()));
  const focusedTechnicalOverreach = focusedFieldScope
    ? consultScopeTechnicalTokens(text).filter(token => !focusedTechnicalSet.has(token.toLowerCase()))
    : [];
  const unexpectedTechnicalTokens = Array.from(new Set([
    ...consultScopeTechnicalTokens(text).filter(token => !scopeTechnicalTokens.has(token.toLowerCase())),
    ...focusedTechnicalOverreach,
  ]));
  const unexpectedScopeTerms = Array.from(new Set([...unexpectedEntityTerms, ...unexpectedMechanismTerms, ...unexpectedTechnicalTokens]));
  const malformedMarkdown = [...consultMalformedMarkdownTokens(text), ...consultMalformedProseTokens(text), ...consultMalformedTableTokens(text)];
  const requiredPrimaryPath = consultRequiredPrimaryPath(question, route, text);
  const missingPrimaryPath = requiredPrimaryPath && !consultConcretePaths(text).includes(requiredPrimaryPath.path) ? requiredPrimaryPath : null;
  let focusedFactPrimaryPath = null;
  if (focusedFactQuestion && /(?:(?:调用|使用|走|用)(?:的|哪|哪个|什么)?接口|哪个接口|接口(?:是|为|叫|地址|路径)?什么|路径(?:是|为)?什么|(?:调用|使用|走|接口|路径)[^。！？；\n]{0,28}\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/)/i.test(String(question || '')) && route && route.matched) {
    const forbiddenFocusedPaths = new Set(consultConcretePaths((route.mustNotConfuse || []).join('\n')));
    const focusedCandidates = [];
    for (const fact of route.answerFacts || []) {
      const factText = String(fact || '');
      const method = factText.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase() || '';
      for (const pathValue of consultConcretePaths(factText)) {
        if (!pathValue.startsWith('/') || pathValue.includes('*') || forbiddenFocusedPaths.has(pathValue)) continue;
        focusedCandidates.push({ path: pathValue, method, display: `${method ? `${method} ` : ''}${pathValue}` });
      }
    }
    const uniqueFocusedCandidates = Array.from(new Map(focusedCandidates.map(item => [item.path, item])).values());
    if (uniqueFocusedCandidates.length === 1) focusedFactPrimaryPath = uniqueFocusedCandidates[0];
  }
  const focusedFactOverreach = consultFocusedFactOverreach(text, question, route);
  const focusedRelationshipFacts = focusedFactQuestion ? consultFocusedRelationshipFacts(question, route) : [];
  // 越界句即使碰巧带到某个 token，也不能充当“已覆盖”证据；它会在同一轮被删除。
  const focusedCoverageText = text.split(/(?<=[。！？；\n])/u)
    .map(part => part.trim()).filter(part => part && !focusedFactOverreach.includes(part)).join('\n');
  const lowerAnswer = focusedCoverageText.toLowerCase();
  const compactLowerAnswer = lowerAnswer.replace(/\s+/g, '');
  const normalizeQualifierText = value => String(value || '').toLowerCase().replace(/\s+/g, '')
    .replace(/不需要|不校验|免(?:于)?/gu, '无需')
    .replace(/需要|必须|要求|应当|须/gu, '需')
    .replace(/认证|登录校验/gu, '鉴权');
  const normalizedQualifierAnswer = normalizeQualifierText(compactLowerAnswer);
  const focusedClaimSegments = documentLines.flatMap(line => {
    const raw = String(line || '');
    if (/^\s*#{1,6}\s+/u.test(raw) || /^\s*(?:\*\*|__)[^\n]+(?:\*\*|__)\s*$/u.test(raw)) return [];
    if (/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(raw)) return [];
    const cells = consultMarkdownTableCells(raw);
    const claimLine = cells ? cells.join(' ') : raw;
    return claimLine.split(/[。！？；;\n]/u).map(part => part.replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '').replace(/[*`]/g, '').trim())
      .filter(part => part && !focusedFactOverreach.includes(part));
  });
  const relationClaimRe = /(?:关联|关系|通过|用(?:同一)?|靠|挂(?:到|接)?|归属|对应|连接|指向|映射|保存|存储|承载|序列化|快照|↔|→|<-|->)/iu;
  const negativeBoundaryRe = /(?:不(?:是|等于|代表|属于|能当作|应描述成)?|非|≠|不得|不能|禁止|并非)/u;
  const missingFocusedRelationshipFacts = focusedRelationshipFacts.map(item => {
    if (item.kind === 'relationship_edge' || item.kind === 'relationship_boundary') {
      const covered = focusedClaimSegments.some(segment => {
        const normalized = normalizeQualifierText(segment);
        const groupsCovered = (item.requiredGroups || []).every(group => group.some(token => normalized.includes(normalizeQualifierText(token))));
        if (!groupsCovered) return false;
        return item.kind === 'relationship_boundary'
          ? negativeBoundaryRe.test(segment)
          : relationClaimRe.test(segment);
      });
      return { ...item, missingTokens: covered ? [] : (item.requiredGroups || []).map(group => group[0]) };
    }
    return {
      ...item,
      missingTokens: item.tokens.filter(token => !normalizedQualifierAnswer.includes(normalizeQualifierText(token))),
    };
  }).filter(item => item.missingTokens.length > 0);
  const focusedAnswerPaths = new Set(consultConcretePaths(text));
  const focusedMustNotConfuse = focusedFactQuestion && route && route.matched
    ? (route.mustNotConfuse || []).map(String).filter(fact => {
        const factPaths = consultConcretePaths(fact);
        // 用户原文点名，或草稿已经主动给出该反例时，都把它视为本轮需要
        // 保住的边界；后续原子去重不能因删除重复主接口句而顺带吞掉反例。
        return factPaths.length && factPaths.some(pathValue => String(question || '').includes(pathValue) || focusedAnswerPaths.has(pathValue));
      })
    : [];
  const missingFocusedMustNotConfuse = focusedMustNotConfuse.filter(fact =>
    !consultConcretePaths(fact).some(pathValue => focusedAnswerPaths.has(pathValue))
  );
  const firstMeaningfulLine = documentLines.find(line => line.trim())?.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '').replace(/[*_`]/g, '').trim() || '';
  const hasEvidenceSufficiencyVerdict = !evidenceSufficiencyQuestion
    || /(?:只够|足够|够(?:用|判断|固定|完成)|不够|不足|不能单独|尚不能|只能固定|只能证明|只能确认|最多(?:只能|能|可))/u.test(firstMeaningfulLine);
  const currentRouteFacts = route && route.matched ? (route.answerFacts || []).map(String).map(item => item.trim()).filter(Boolean) : [];
  // 模型即使命中了正确业务 route，也不能把“问到了某个操作”偷换成
  // “可以执行该操作”。只有 current route 的 answerFacts 在同一条事实中
  // 正向支持相同实体+动作时，才允许给肯定操作/等价关系；否则终审删掉。
  const unsupportedExplicitOperationParts = explicitOperationContracts.length ? text.split(/[。！？；;\n，,]/u)
    .map(part => part.trim()).filter(Boolean)
    .filter(part => /(?:可以|可直接|建议|应当|应该|需要|需|直接|继续|再次|重新|然后|再|就是|等于)/u.test(part))
    .filter(part => !currentRouteFacts.some(fact => fact === part || fact.includes(part)))
    .filter(part => !/(?:不得|不能|不要|禁止|不可|不应|先别|停止)[^。！？；;\n]{0,32}(?:发起|撤销|取消|退回|提交|删除|新增|创建|审批|签名|补发|重放|重提|重试)/u.test(part))
    .filter(part => {
      const claims = consultExplicitOperationContracts(part);
      return claims.length && claims.some(contract => !currentRouteFacts.some(fact =>
        routeHasDirectOperationEvidence({ answerFacts: [fact] }, [contract])
      ));
    }) : [];
  // 单条事实不足以支撑“接口、数据、边界”三维现场盘点，仍走既有
  // facts_with_unknowns，不能用通用清单掩盖证据缺口。至少两条 current
  // route 已核事实时才启用分层 field diagnostic；route miss 自然为 false。
  const verifiedInterfaceDataBoundaryDiagnosticQuestion = interfaceDataBoundaryDiagnosticQuestion
    && currentRouteFacts.length >= 2
    // 带复测前缀的宽问法已由旧 field-diagnostic 合同覆盖；只有 current
    // route 自己进一步给出“实施/现场排查”锚点时，才升级为 route-aware
    // 分层，避免所有历史复测题被无差别扩成同一套技术清单。
    && (!explicitReviewDiagnosticQuestion
      || currentRouteFacts.some(fact => /(?:(?:实施|现场)[^。！？\n]{0,24}(?:排查|核对)|只读(?:排查|核对))[^。！？\n]{0,120}(?:日志|记录|请求|响应)/iu.test(fact)));
  // 非写操作咨询只允许发布两类内容：系统当前客观行为，以及本轮可做的
  // 只读留证。route 中面向负责人的补发/重做建议不能原样变成现场动作；
  // 同一转换供 field diagnostic、chain、partial evidence 和上下文续问复用。
  const asBuiltSystemSequence = value => String(value || '').match(/^(.+?(?:返回|取得|读取|查得)(?:记录|结果|数据)?后)[，,]?\s*(?:再|然后|随后)\s*(?:通过|调用)\s*(.+?)\s+(?:补|补充|补全)(.+)$/u);
  const normalizeNonWritingRouteFact = fact => {
    let recoveryGuidanceFound = false;
    const normalized = String(fact || '').split(/(?<=[。！？；;])/u).map(rawClause => {
      const punctuation = rawClause.match(/[。！？；;]$/u)?.[0] || '';
      const clause = punctuation ? rawClause.slice(0, -punctuation.length).trim() : rawClause.trim();
      if (!clause) return rawClause;
      const systemSequence = asBuiltSystemSequence(clause);
      if (systemSequence) {
        return `当前实现会在${systemSequence[1]}，由系统自动只读调用${systemSequence[2]}，读取并用于展示补全${systemSequence[3]}；这是系统已有的展示流程，不是要求实施手工调用，也不写业务数据${punctuation}`;
      }
      const recoveryGuidance = clause.match(/(?:应|应该|可|可以|需|需要|建议|再决定是否|决定是否)[^。！？；\n]{0,36}(?:定向)?(?:补(?:发|消息|通知|偿|写)?|重做|重试|重放|重新(?:执行|提交|发送|触发))/u);
      if (!recoveryGuidance) return rawClause;
      const guidancePrefix = clause.slice(Math.max(0, recoveryGuidance.index - 4), recoveryGuidance.index);
      if (/(?:不|未|无|禁止|不得|不能|不要|不可)\s*$/u.test(guidancePrefix)) return rawClause;
      recoveryGuidanceFound = true;
      const observedCondition = clause.slice(0, recoveryGuidance.index).replace(/[，,：:]\s*$/u, '').trim();
      const safeObservation = observedCondition
        ? `${observedCondition}，本轮只记录该差异和既有证据，并交对应接口/业务负责人评估`
        : '本轮只记录已出现的差异和既有证据，并交对应接口/业务负责人评估';
      return `${safeObservation}${punctuation}`;
    }).join('');
    return recoveryGuidanceFound
      ? `${normalized} 经另行授权后才可制定定向补偿方案；本轮不补发、不重做、不重试。`.trim()
      : normalized;
  };
  const nonWritingRouteFacts = currentRouteFacts.map(normalizeNonWritingRouteFact);
  // “接口、数据和边界”现场题不能只把 route facts 平铺后套通用清单。
  // 从 current route 的 answerFacts + 精确 contextRefs 自动提取可核对入口，
  // 再把 route 自己列出的实施排查项拆成完整性合同；不认识具体表、字段、
  // 服务名或题号。directEvidence 只用于恢复当前 route 明示的 HTTP 签名，
  // 不从邻近检索结果扩写事实。
  const interfaceDataBoundaryEvidenceLines = verifiedInterfaceDataBoundaryDiagnosticQuestion
    ? [
        ...nonWritingRouteFacts,
        ...(route && route.matched ? (route.directEvidenceFacts || []) : []),
      ].flatMap(value => String(value || '').split(/\r?\n/u))
        .map(line => line.replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '').trim())
        .filter(Boolean)
    : [];
  const interfaceDataBoundaryInterfaceEvidence = new Map();
  for (const line of interfaceDataBoundaryEvidenceLines) {
    for (const match of line.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_./{}?=&:%*\-]+)/giu)) {
      const signature = `${match[1].toUpperCase()} ${match[2]}`;
      const evidence = interfaceDataBoundaryInterfaceEvidence.get(signature) || [];
      evidence.push(line);
      interfaceDataBoundaryInterfaceEvidence.set(signature, evidence);
    }
  }
  const interfaceDataBoundaryInterfaces = Array.from(interfaceDataBoundaryInterfaceEvidence, ([signature, evidenceLines]) => {
    const evidenceText = evidenceLines.join('\n');
    // “把查询结果插入页面输入框/文本框”只改变当前页面展示，不是接口
    // 写业务数据。先剥离这类明确的客户端呈现短语，再判断 route 是否
    // 直接声明写入、生成、扫描或其它副作用；遗留 GET 若确有这些事实
    // 仍会被标为副作用，不能简单按 HTTP 方法放行。
    const sideEffectEvidenceText = evidenceText.replace(/(?:插入|填入|追加到)(?:(?!(?:数据库|业务表|数据表|持久化|保存|落库))[^。！？；;\n]){0,40}(?:输入框|文本框|意见框|展示区|页面(?:控件|字段|表单|内容|光标位置))/giu, '');
    const sideEffect = /(?:副作用|写入|插入|生成|持久化|落库|保存[^。！？\n]{0,24}(?:数据库|业务表|数据表|记录|状态|快照)|扫描[^。！？\n]{0,24}数据源|新增[^。！？\n]{0,16}快照|不是普通只读)/iu.test(sideEffectEvidenceText);
    const readOnly = !sideEffect && /(?:查询|读取|获取|只读|最新|返回|展示)/iu.test(evidenceText);
    return { signature, sideEffect, readOnly };
  });
  const requiredInterfaceDataBoundarySignatures = interfaceDataBoundaryInterfaces.map(item => item.signature);
  const missingInterfaceDataBoundarySignatures = requiredInterfaceDataBoundarySignatures.filter(signature => !text.includes(signature));
  const interfaceDataBoundaryDataFacts = verifiedInterfaceDataBoundaryDiagnosticQuestion
    ? nonWritingRouteFacts.map((fact, index) => ({ fact, index, score: [
      /(?:快照|数据表|数据库表|落库|写入|插入|持久化|字段|update[_A-Z]?time)/iu,
      /(?:projectName|project_name|项目)[^。！？\n]{0,64}(?:匹配|隔离|快照|数据源|为空|null)/iu,
      /(?:默认|最新|当前)[^。！？\n]{0,48}(?:记录|数据|快照|状态)/iu,
    ].reduce((score, re) => score + (re.test(fact) ? 1 : 0), 0) }))
      .filter(item => item.score > 0).sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 2).map(item => item.fact)
    : [];
  const interfaceDataBoundaryChecklistFact = verifiedInterfaceDataBoundaryDiagnosticQuestion
    ? nonWritingRouteFacts.find(fact => /(?:实施|现场)[^。！？\n]{0,24}排查[^。！？\n]{0,120}(?:日志|记录|请求|响应)/iu.test(fact)) || ''
    : '';
  const interfaceDataBoundaryChecklistItems = (() => {
    if (!interfaceDataBoundaryChecklistFact) return [];
    const body = interfaceDataBoundaryChecklistFact.match(/(?:先|优先)(?:看|核对|查看|读取)([^。；;]+)/u)?.[1] || '';
    return Array.from(new Set(body.split(/[、，,]|和/u)
      .map(item => item.replace(/^(?:现有|已有|各|对应|当前)\s*/u, '').trim())
      .filter(item => item.length >= 2 && item.length <= 40)));
  })();
  const missingInterfaceDataBoundaryChecklistItems = interfaceDataBoundaryChecklistItems.filter(item => !text.includes(item));
  // “返回后，再通过某服务补名称”是正确的 As-built 顺序，但裸“再通过…补”
  // 很容易被外部动作审计或人工读者理解成现场操作建议。只要答案仍采用
  // 这种省略系统执行主体的写法，就要求重写成系统自动只读调用；不删除
  // 外部依赖本身，也不把该调用改成实施动作。
  const ambiguousAsBuiltSystemActionParts = route && route.matched
    ? audienceParts.filter(part => {
        const plain = String(part || '').replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '').trim();
        return !!asBuiltSystemSequence(plain.replace(/[。！？；;]$/u, '').trim());
      })
    : [];
  // 有些功能的 current route 已明确是浏览器内静态计算，且没有网络请求
  // 或后端接口。此时现场排查的观测面只能留在标签页、输入/结果和静态
  // 资源，不能机械套用服务端请求/日志/数据库清单。
  const currentRouteFactText = currentRouteFacts.join('\n');
  const staticClientOnlyRoute = /(?:静态|纯前端|浏览器内|本地)[^。！？\n]{0,48}(?:计算|处理|运行)/iu.test(currentRouteFactText)
    && /(?:未发现|没有|无)[^。！？\n]{0,100}(?:网络请求|后端接口)|(?:网络请求|后端接口)[^。！？\n]{0,40}(?:未发现|没有|无)/iu.test(currentRouteFactText);
  // “接口已有数据、页面未呈现”的交接题必须保留 route 已核的会话/身份
  // 与分阶段结果边界。命名 token scope 从 route facts 自动提取，不绑定
  // 某个系统或题号；其它两组也只在当前 route 明确提供相应事实时启用。
  const namedRouteTokenScopes = Array.from(new Set(Array.from(currentRouteFactText.matchAll(/\b[A-Za-z][A-Za-z0-9_-]{1,30}\s+token\b/giu), match => match[0].toLowerCase())));
  const dataNotRenderedRouteBoundaryGroups = dataReturnedNotRenderedQuestion ? [
    {
      label: '会话作用域边界',
      enabled: namedRouteTokenScopes.length >= 2
        && /(?:作用域|scope|分开|独立|不互相替代)/iu.test(currentRouteFactText),
      covered: namedRouteTokenScopes.every(scope => text.toLowerCase().includes(scope))
        && /(?:作用域|scope|分开|独立|不互相替代)/iu.test(text),
    },
    {
      label: '外部身份数据边界',
      enabled: /(?:外部|归[^。！？；\n]{0,24}(?:用户中心|身份中心|认证中心))[^。！？；\n]{0,48}(?:本库|当前系统)[^。！？；\n]{0,32}(?:无|没有|不保存)/iu.test(currentRouteFactText),
      covered: /(?:外部|归[^。！？；\n]{0,24}(?:用户中心|身份中心|认证中心))/iu.test(text)
        && /(?:本库|当前系统)[^。！？；\n]{0,32}(?:无|没有|不保存)/iu.test(text),
    },
    {
      label: '分阶段结果边界',
      enabled: /(?:状态|阶段)[^。！？\n]{0,80}(?:先|随后|再)[^。！？\n]{0,80}(?:不会自动回滚|不能宣称|分开核对)/iu.test(currentRouteFactText),
      covered: /(?:状态|阶段)/iu.test(text)
        && /(?:先|随后|再)/iu.test(text)
        && /(?:不会自动回滚|不能宣称|分开核对)/iu.test(text),
    },
  ].filter(group => group.enabled) : [];
  const missingDataNotRenderedBoundaryGroups = dataNotRenderedRouteBoundaryGroups
    .filter(group => !group.covered).map(group => group.label);
  // 只有 current route 明确描述客户端会话载体及其作用域/缓存关系时，
  // 页面未呈现清单才追加 Cookie/缓存核对。普通“后端校验 token 用户”
  // 只是服务端身份校验，不能据此臆造客户端缓存层，否则确定性兜底会
  // 因新增 route 外实体被终审拒绝。
  const routeHasClientSessionScope = dataReturnedNotRenderedQuestion
    && (/(?:token|Cookie|localStorage|sessionStorage|IndexedDB|用户信息缓存|会话缓存)[^。！？\n]{0,48}(?:作用域|scope|缓存|会话|本地存储|分开|独立|不互相替代)/iu.test(currentRouteFactText)
      || /(?:作用域|scope|缓存|会话|本地存储|分开|独立|不互相替代)[^。！？\n]{0,48}(?:token|Cookie|localStorage|sessionStorage|IndexedDB|用户信息缓存|会话缓存)/iu.test(currentRouteFactText));
  const routeHasMultiDeviceSession = dataReturnedNotRenderedQuestion
    && /(?:关闭|踢下线)[^。！？\n]{0,24}(?:旧设备|其他设备)|(?:旧设备|其他设备)[^。！？\n]{0,24}(?:关闭|踢下线)/iu.test(currentRouteFactText);
  // 仅用已有记录缩小范围时，优先发布 current route 中真正描述“列表如何
  // 筛选/默认排除什么/能否进详情”的一条事实，而不是按通用相关度选到
  // 新增、取消或导出事实。筛选维度从事实中的“按…条件筛选”自动拆出，
  // 不硬编码具体业务字段；终审据此拦截只说“查记录”却漏掉可用条件的答复。
  const existingRecordNarrowingFact = existingRecordNarrowingQuestion
    ? currentRouteFacts.map((fact, index) => ({ fact, index, score: [
      /(?:列表|记录)[^。！？\n]{0,48}(?:筛选|查询)|(?:筛选|查询)[^。！？\n]{0,48}(?:列表|记录)/iu,
      /(?:默认|只查|只显示)[^。！？\n]{0,40}(?:未删除|有效|当前)/iu,
      /(?:进入|查看)[^。！？\n]{0,24}详情|详情[^。！？\n]{0,24}(?:进入|查看)/iu,
      /(?:默认)?每页\s*\d+\s*条|分页/iu,
    ].reduce((score, re) => score + (re.test(fact) ? 1 : 0), 0) }))
      .filter(item => item.score >= 2)
      .sort((left, right) => right.score - left.score || left.index - right.index)[0]?.fact || ''
    : '';
  const existingRecordFilterDimensions = (() => {
    if (!existingRecordNarrowingFact) return [];
    const match = existingRecordNarrowingFact.match(/按([^。；\n]{2,180}?)(?:等)?条件筛选/iu);
    if (!match) return [];
    return Array.from(new Set(match[1].split(/[、，,]|和/u)
      .map(item => item.replace(/^(?:当前支持|支持|可|可以)\s*/u, '').trim())
      .filter(item => item.length >= 1 && item.length <= 24)));
  })();
  const existingRecordPageSize = existingRecordNarrowingFact.match(/(?:默认)?每页\s*(\d+)\s*条/u)?.[1] || '';
  const missingExistingRecordNarrowing = existingRecordNarrowingFact ? [
    ...existingRecordFilterDimensions.filter(label => !text.includes(label)),
    ...(/(?:默认|只查|只显示)[^。！？\n]{0,40}未删除/iu.test(existingRecordNarrowingFact)
      && !/(?:默认|只查|只显示)[^。！？\n]{0,40}未删除/iu.test(text) ? ['默认只看未删除记录'] : []),
    ...(/(?:进入|查看)[^。！？\n]{0,24}详情|详情[^。！？\n]{0,24}(?:进入|查看)/iu.test(existingRecordNarrowingFact)
      && !/(?:进入|查看)[^。！？\n]{0,24}详情|详情[^。！？\n]{0,24}(?:进入|查看)/iu.test(text) ? ['已有记录详情'] : []),
    ...(existingRecordPageSize && !new RegExp(`每页\\s*${existingRecordPageSize}\\s*条`, 'u').test(text)
      ? [`每页 ${existingRecordPageSize} 条`] : []),
  ] : [];
  // 实施逐项清单若在括号或正文中显式枚举多个业务阶段，回答就必须逐项
  // 交代，不能把“有四个步骤”误当成内容完整。阶段名只从本轮问句提取；
  // route 标签则只从 current answerFacts 提取，二者都不硬编码业务名称。
  const splitChecklistStageEnumeration = value => String(value || '').split(/\s*(?:\/|／|、|,|，|；|;|\||｜|→|->|=>)\s*/u)
    .map(item => item.replace(/^[“”'‘’\s]+|[“”'‘’\s]+$/gu, '').trim())
    .filter(item => item.length >= 1 && item.length <= 18);
  const bracketedChecklistStageGroups = implementationChecklistQuestion
    ? Array.from(questionText.matchAll(/[（(]([^（）()]*)[）)]/gu), match => splitChecklistStageEnumeration(match[1]))
      .filter(group => group.length >= 3)
    : [];
  const inlineChecklistStageGroups = implementationChecklistQuestion
    ? (questionText.match(/[A-Za-z0-9_\u4e00-\u9fff-]{1,18}(?:\s*(?:\/|／|、|→|->|=>)\s*[A-Za-z0-9_\u4e00-\u9fff-]{1,18}){2,}/gu) || [])
      .map(splitChecklistStageEnumeration).filter(group => group.length >= 3)
    : [];
  const checklistStageLabels = Array.from(new Set([...bracketedChecklistStageGroups, ...inlineChecklistStageGroups].flat()));
  const stageAwareImplementationChecklist = implementationChecklistQuestion && checklistStageLabels.length >= 3;
  const checklistRouteLabelFacts = stageAwareImplementationChecklist ? nonWritingRouteFacts.map(fact => {
    const label = String(fact).match(/^([^：:\n]{1,16})\s*[：:]/u)?.[1]?.trim() || '';
    return label ? { label, fact } : null;
  }).filter(Boolean) : [];
  const checklistCoverageText = String(text || '').replace(/[*_`#]/g, '');
  const checklistLabelCovered = label => checklistCoverageText.includes(`阶段「${label}」`)
    || checklistCoverageText.includes(`阶段“${label}”`)
    || checklistCoverageText.includes(`${label}阶段`)
    || checklistCoverageText.includes(`${label}：`)
    || checklistCoverageText.includes(`${label}:`);
  const missingChecklistStageLabels = stageAwareImplementationChecklist
    ? checklistStageLabels.filter(label => !checklistLabelCovered(label)) : [];
  const missingChecklistRouteLabels = stageAwareImplementationChecklist
    ? Array.from(new Set(checklistRouteLabelFacts.map(item => item.label))).filter(label => !checklistLabelCovered(label)) : [];
  // 同一路由若明确给出多条“X表现”故障分支，询问其中一步失败后的结果时
  // 必须把各分支差异一起保住。覆盖合同从 route 标签和事实语义派生，不绑定
  // 门诊/住院等具体名称；页面结果、业务状态及并发/超时排除项按事实启用。
  const failureBranchFacts = externalStepFailureOutcomeQuestion ? currentRouteFacts.map(fact => {
    const label = String(fact).match(/^([^：:\n]{1,16})表现\s*[：:]/u)?.[1]?.trim() || '';
    return label && /(?:失败|异常|报错|中断)/u.test(fact) ? { label, fact: String(fact) } : null;
  }).filter(Boolean) : [];
  const failureBranchCoverageText = String(text || '').replace(/[*_`#]/g, '');
  const missingFailureBranchCoverage = failureBranchFacts.filter(({ label, fact }) => {
    if (!failureBranchCoverageText.includes(label)) return true;
    if (/不会[^。！？；\n]{0,20}调用/u.test(fact) && !/不会[^。！？；\n]{0,20}调用/u.test(failureBranchCoverageText)) return true;
    if (/页面[^。！？；\n]{0,48}(?:报错|未完成|没有完成|操作没有完成)/u.test(fact)
      && !(/页面/u.test(failureBranchCoverageText) && /(?:报错|未完成|没有完成|操作没有完成)/u.test(failureBranchCoverageText))) return true;
    if (/任务[^。！？；\n]{0,48}(?:保持|未变|原审核状态)/u.test(fact)
      && !(/任务/u.test(failureBranchCoverageText) && /(?:保持|未变|原审核状态)/u.test(failureBranchCoverageText))) return true;
    if (/并发/u.test(fact) && !/并发/u.test(failureBranchCoverageText)) return true;
    if (/超时/u.test(fact) && !/超时/u.test(failureBranchCoverageText)) return true;
    return false;
  }).map(item => item.label);
  // 路由发布策略同时保留在结果顶层与 route 卡片内。上下文继承、诊断序列化或
  // 旧运行态若只保住其中一层，仍必须优先发布同一路由的已核事实，不能退回通用模板。
  const routeFallbackMode = route && (route.fallbackMode || (route.route && route.route.fallbackMode));
  const verifiedFactsFallback = !!(route && route.matched
    && routeFallbackMode === 'verifiedFacts' && currentRouteFacts.length);
  // 普通“怎么实现”问法也不能把人工 route 已明确的核心业务边界漏掉后
  // 直接放行。这里只检查带有明确“日期/时段→前置门槛→人工审”结构的
  // 边界事实，并要求保留其关键条件词；不要求逐字复述其它 answerFacts，
  // 以免把每个普通问法都强制扩写成整张 route 卡。
  // “异常/故障”这类主题词会让诊断信号命中，但只要问句本身是简单的
  // as-built 实现问法，就仍应按完整事实覆盖门处理；明确的现场/证据/只读
  // 追问不在此范围内，避免把诊断题扩写成整张 route 卡。
  const plainImplementationQuestion = /(?:怎么实现|如何实现|实现方式)/u.test(intentQuestionText)
    && !/(?:只(?:能|确认)|仅(?:能|确认)|只读|现场|排查|留证|证据|未知|能确定|能判断到哪|下一步|怎么查|如何查|怎么判断|如何判断|只用|仅用|已有记录|现有记录)/iu.test(intentQuestionText);
  const verifiedFactCoverageQuestion = verifiedFactsFallback
    && !focusedFactQuestion
    && (!diagnosticQuestion || plainImplementationQuestion)
    && /(?:怎么实现|如何实现|涉及哪些|包含哪些|覆盖哪些|分别说明|介绍)/u.test(questionText);
  const verifiedFactCoverageText = String(text || '').replace(/[*_`#]/g, '');
  const missingVerifiedFactCoverage = verifiedFactCoverageQuestion
    ? currentRouteFacts.filter(fact => /边界[：:]/u.test(fact)
      && /(?:日期|时段)/u.test(fact)
      && /人工审/u.test(fact)
      && !(
        /日期/u.test(verifiedFactCoverageText)
        && /时段/u.test(verifiedFactCoverageText)
        && /(?:前置|门槛)/u.test(verifiedFactCoverageText)
        && /(?:警示|科室|病区|药品|药品属性)/u.test(verifiedFactCoverageText)
        && /人工审/u.test(verifiedFactCoverageText)
      ))
    : [];
  // 明确问“怎么实现”时，产品首屏仍可先讲人话，但若人工 route 本身已经
  // 提供了成套实现事实，不能只回答“有按钮/交给工作流”就放行。按 route
  // 原有标签提取每组的技术锚点；只有至少两组锚点的丰富 route 才启用此门，
  // 普通单事实功能不会因此被强制技术化或堆满无关事实。
  const implementationFactCoverageQuestion = verifiedFactsFallback
    && (!diagnosticQuestion || plainImplementationQuestion)
    && !evidenceSufficiencyQuestion
    && !focusedFactQuestion
    && /(?:怎么|如何)实现/u.test(intentQuestionText)
    && currentRouteFacts.length >= 3;
  // 技术锚点中的下划线（例如 create_user、back_reason）是事实本身的一部分，
  // 不能沿用 Markdown 清洗时删除下划线的文本，否则完整 route 事实也会被误判漏答。
  const implementationFactCoverageText = String(text || '').replace(/[*`#]/g, '');
  const implementationFactAnchorRe = /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_./{}?=&:%-]+|\b[a-z][A-Za-z0-9_]*(?:[A-Z][A-Za-z0-9_]+)+\b|\b[a-z][a-z0-9_]*_[a-z0-9_]+\b|\b[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\b|\b(?:Dify|UUID|HTTP|JSON|SQL|Redis|HIS|Dubbo|Network)\b)/giu;
  const implementationFactCoverageGroups = [
    ['入口与接口', /^(?:入口|接口|统一入口|接入入口与主接口)\s*[：:]/u],
    ['任务与警示', /^任务和警示\s*[：:]/u],
    ['外部依赖', /^外部依赖\s*[：:]/u],
    ['生成记录', /^生成记录\s*[：:]/u],
    ['停止链路', /^停止\s*[：:]/u],
    ['证据边界', /^前端证据边界\s*[：:]/u],
    ['只读对照', /^实施只读清单\s*[：:]/u],
    ['端到端边界', /^端到端边界\s*[：:]/u],
    // as-built 事实题也要保住 route 明确的安全边界：删除后的可见性、
    // 历史 back_reason 与后端权限不能因首屏产品概括而整体漏掉。只对
    // route 明确提供这些标签的功能启用，不把普通产品问法扩成全量技术清单。
    ['删除边界', /^删除\s*[：:]/u, /(?:软删除|deleted)/giu],
    ['历史影响', /^历史影响\s*[：:]/u, /(?:back_reason|历史审核原因|不会清空)/giu],
    ['权限边界', /^权限\s*[：:]/u, /(?:create_user|OPERATE_TEMPLATE_PERMISSION_DENIED|后端保存|token用户)/giu],
    ['研发接口', /^研发\s*[：:]/u],
  ].map(([label, factRe, anchorRe = implementationFactAnchorRe]) => {
    const anchors = Array.from(new Set(currentRouteFacts
      .filter(factRe.test.bind(factRe))
      .flatMap(fact => Array.from(String(fact).matchAll(anchorRe), match => match[0]))));
    anchorRe.lastIndex = 0;
    return { label, anchors };
  }).filter(group => group.anchors.length >= 2);
  // 没有统一标签的 route 也可能把生产启用、支持范围和重复调用授权写在
  // 普通事实句中。用事实语义识别这些高风险边界，并只在该 route 明确提供
  // 对应事实时要求覆盖；不绑定具体模块、接口或题号。
  const implementationFactCoverageSemanticGroups = [
    {
      label: '生产启用与支持边界',
      factRe: /(?:代码存在不等于|生产[^。！？；\n]{0,24}(?:部署|启用)|发布记录|支持能力|运维确认)/iu,
      answerRe: /(?:生产(?:包|环境|部署|启用)|发布记录|已部署|支持能力|运维确认)/iu,
    },
    {
      label: '授权与重复调用边界',
      factRe: /(?:未经[^。！？；\n]{0,16}授权|不得[^。！？；\n]{0,32}(?:重新)?调用|安全重复(?:调用|补发)|重复(?:调用|补发))/iu,
      answerRe: /(?:运维(?:确认|授权)|未经[^。！？；\n]{0,16}授权|不得[^。！？；\n]{0,32}(?:重新)?调用|重复(?:调用|补发))/iu,
    },
  ].filter(group => currentRouteFacts.some(fact => group.factRe.test(fact)));
  const missingImplementationFactCoverage = implementationFactCoverageQuestion
    ? [
        ...implementationFactCoverageGroups.filter(group => {
        const matched = group.anchors.filter(anchor => implementationFactCoverageText.toLowerCase().includes(anchor.toLowerCase()));
        return matched.length < Math.min(2, group.anchors.length);
        }).map(group => group.label),
        ...implementationFactCoverageSemanticGroups
          .filter(group => !group.answerRe.test(implementationFactCoverageText))
          .map(group => group.label),
      ]
    : [];
  const currentRoutePathFacts = currentRouteFacts.flatMap(fact => {
    const method = fact.match(/\b(GET|POST|PUT|PATCH|DELETE)\b/i)?.[1]?.toUpperCase() || '';
    return consultConcretePaths(fact).filter(pathValue => pathValue.startsWith('/') && !pathValue.includes('*'))
      .map(pathValue => ({ path: pathValue, method, display: `${method ? `${method} ` : ''}${pathValue}`, fact }));
  });
  const uniqueRoutePathFacts = Array.from(new Map(currentRoutePathFacts.map(item => [item.path, item])).values());
  const minimumRoutePath = uniqueRoutePathFacts.length === 1 ? uniqueRoutePathFacts[0] : null;
  const missingEvidenceMinimumPath = evidenceSufficiencyQuestion && minimumRoutePath
    && !consultConcretePaths(text).includes(minimumRoutePath.path) ? minimumRoutePath : null;
  // “从入口、接口/数据到外部依赖串起来”是一份显式维度契约：
  // 模型不得用一个同名标题冒充完整答案，也不得用全字段表填充篇幅。
  // 这里只从 current route 已注入的事实提取紧凑合同，不硬编业务答案。
  // 链路完整性是当前轮显式研发契约，不随 inherited route 或上一轮问法继承。
  // 产品/实施重述（如“换成实施只读清单”）只继承业务事实；即便 route 的
  // inheritedFromQuestion 曾点名入口/接口/数据，也不得再次要求终稿复述整条
  // 技术链，否则安全清单会被错误判成 incomplete_requested_chain 并机械拒答。
  const chainRequested = audienceMode === 'developer' && !!(route && route.matched)
    && /(?:串起来|串联|全链路|完整链路|调用链|实现链路|从[^.。！？\n，,；;]{1,80}到[^.。！？\n，,；;]{1,40})/u.test(questionText)
    && /(?:入口|接口|数据|状态|权限|外部依赖|依赖|留痕)/u.test(questionText);
  // verifiedFacts 不是所有问法都应套同一份“业务结论 + 全部事实”模板。
  // 先按本轮问句确定发布形态：明确链路题走链路收敛，证据受限题交代
  // 已知/未知，现场追问给只读清单；只有普通事实题才发布完整事实集合。
  // 这里仅使用问句、route 的继承标记和人工 route facts，不从模型正文推断
  // 新业务事实，也不把一个字段题的邻近 facts 当成当前问题答案。
  const factQuestionDimensions = [
    ['接口', /(?:接口|\bAPI\b|路径)/iu],
    ['数据', /(?:数据|字段|表(?:名)?|落库|持久化)/iu],
    ['边界', /(?:边界|范围|权限|角色|外部依赖|依赖|状态)/iu],
  ].filter(([, re]) => re.test(questionText)).map(([label]) => label);
  const broadFactQuestion = !!(route && route.matched && routeFallbackMode === 'verifiedFacts')
    && factQuestionDimensions.length >= 2
    && /(?:哪些|什么|涉及|包含|覆盖|分别|说明|介绍|全链路)/u.test(questionText);
  // “请收集/核对哪些证据”是完整实施材料题，仍需保留 route 的完整事实；
  // 简短的“现有证据够不够/能判断到哪”才进入 partial_evidence。
  const broadEvidenceQuestion = evidenceSufficiencyQuestion && (
    fullHandoffMaterialQuestion
      || /(?:收集|核对|整理|补充|提供)[^。！？\n]{0,64}(?:哪些|证据|材料|请求|响应|日志|方法|路径)/u.test(questionText)
  );
  const partialEvidenceQuestion = evidenceSufficiencyQuestion && !broadEvidenceQuestion;
  // “前端已发请求、服务端日志未取得”只证明客户端观测，不能让长 route
  // 的已核系统规则被整体抹掉，也不能把规则误写成本次实例已执行成功。
  // 该信号完全由本轮问句派生，供模型失败后的 partial-evidence 终稿明确
  // 分开“已核规则 / 本轮观测 / 服务端未知”，不绑定具体业务或题号。
  const frontendRequestOnlyEvidenceQuestion = partialEvidenceQuestion
    && /(?:前端|页面|浏览器)[^。！？\n]{0,32}(?:发出|发起|发送)[^。！？\n]{0,20}请求/iu.test(questionText)
    && /(?:服务端|后端)[^。！？\n]{0,40}(?:日志|处理|记录|状态)[^。！？\n]{0,32}(?:没(?:有)?|未|尚未|拿不到|未取得|未知|待确认)/iu.test(questionText);
  // 实施清单不能只满足“有四步”的排版合同，还要覆盖 current route 已明确
  // 的重复执行安全边界。每组要求只在当前 route 真的提供相应事实时启用，
  // 不向其它业务 route 注入幂等、锁或消息/回调假设。
  const retryRiskCoverageGroups = retryBoundaryChecklistQuestion ? [
    {
      label: '操作前状态校验',
      factRe: /(?:不(?:检查|校验)|未(?:检查|校验)|缺少[^。！？；\n]{0,12}校验)[^。！？；\n]{0,20}(?:原状态|前置状态|操作前状态)/iu,
      covered: /(?:不(?:检查|校验)|未(?:检查|校验)|缺少[^。！？；\n]{0,12}校验)[^。！？；\n]{0,20}(?:原状态|前置状态|操作前状态)/iu.test(text),
    },
    {
      label: '幂等键与并发锁',
      factRe: /幂等[^。！？；\n]{0,24}(?:并发)?锁|(?:并发)?锁[^。！？；\n]{0,24}幂等/iu,
      covered: /(?:没有|无|缺少|未见)[^。！？；\n]{0,20}幂等/iu.test(text)
        && /(?:没有|无|缺少|未见)[^。！？；\n]{0,20}(?:并发)?锁/iu.test(text),
    },
    {
      label: '重复执行的外部副作用',
      factRe: /(?:再次|重复|重提|再提交)[^。！？\n]{0,80}(?:流水|消息|通知)[^。！？\n]{0,48}回调/iu,
      covered: /(?:再次|重复|重提|再提交|同一批)[^。！？\n]{0,96}(?:流水|审核记录)/iu.test(text)
        && /(?:再次|重复|重提|再提交|同一批)[^。！？\n]{0,128}(?:消息|通知)/iu.test(text)
        && /(?:再次|重复|重提|再提交|同一批)[^。！？\n]{0,160}回调/iu.test(text),
    },
    {
      label: '局部幂等不代表整体幂等',
      factRe: /Redis[^。！？\n]{0,48}幂等[^。！？\n]{0,64}(?:不能|不代表|不等于|无法|不保证)[^。！？\n]{0,36}(?:整次|整体|整条)/iu,
      covered: /Redis[^。！？\n]{0,64}幂等/iu.test(text)
        && /(?:不能|不代表|不等于|无法|不保证)[^。！？\n]{0,48}(?:整次|整体|整条)[^。！？\n]{0,24}幂等|(?:整次|整体|整条)[^。！？\n]{0,24}(?:不能|不代表|不等于|无法|不保证)[^。！？\n]{0,24}幂等/iu.test(text),
    },
  ].filter(group => currentRouteFacts.some(fact => group.factRe.test(fact))) : [];
  const missingRetryRiskCoverage = retryRiskCoverageGroups.filter(group => !group.covered).map(group => group.label);
  const retryRiskFactsComplete = !retryBoundaryChecklistQuestion || missingRetryRiskCoverage.length === 0;
  const fieldDiagnosticQuestion = diagnosticQuestion
    && (!broadFactQuestion || explicitReviewDiagnosticQuestion || verifiedInterfaceDataBoundaryDiagnosticQuestion || continuationDiagnosticQuestion || dataReturnedNotRenderedQuestion || implementationChecklistQuestion || requestResultMismatchQuestion || multiStepTransactionDiagnosticQuestion || retryBoundaryChecklistQuestion || uiAuthorizationProofQuestion || externalStepFailureOutcomeQuestion)
    && !partialEvidenceQuestion
    && !broadEvidenceQuestion
    && !!(route && route.matched)
    && (!!route.inherited || verifiedInterfaceDataBoundaryDiagnosticQuestion || continuationDiagnosticQuestion || dataReturnedNotRenderedQuestion || implementationChecklistQuestion || requestResultMismatchQuestion || multiStepTransactionDiagnosticQuestion || retryBoundaryChecklistQuestion || uiAuthorizationProofQuestion || externalStepFailureOutcomeQuestion || /(?:只读|排查|现场|复测|留证|怎么判断|如何判断|还缺什么|下一步|怎么查|如何查|核对|不能(?:做|进行)?写操作|交给谁|谁继续|转给谁|交由谁|由谁继续|谁负责)/iu.test(questionText));
  const contextFollowupQuestion = fieldDiagnosticQuestion && (!!route.inherited || continuationDiagnosticQuestion || dataReturnedNotRenderedQuestion || implementationChecklistQuestion || requestResultMismatchQuestion || externalStepFailureOutcomeQuestion);
  // current route 若已明确给出“现场只读排查顺序/实施只读清单”，用户
  // 继续追问下一层、要求改成逐项清单，或请求成功但结果不一致时，通用
  // 清单不能替代 route 专用顺序。这里只从 route 原句自动拆出顺序步骤，不认识
  // 具体模块、字段或题号；终审同时检查步骤覆盖与先后次序。
  const routeReadOnlySequenceQuestion = continuationDiagnosticQuestion
    || implementationChecklistQuestion || requestResultMismatchQuestion
    || existingRecordNarrowingQuestion;
  // route 的人工事实既可能写成“现场只读排查顺序：”，也可能用业务主题
  // 作前缀写成“登录只读排查：”，也可能直接标为“实施只读清单：”。
  // 前缀本身不参与判断；只有同一句明确出现只读排查/核对/清单 + 冒号时
  // 才作为顺序锚点，避免从普通事实臆造步骤。
  const routeReadOnlySequenceAnchorRe = continuationDiagnosticQuestion
    || implementationChecklistQuestion || requestResultMismatchQuestion
    ? /(?:^|[。！？；;])(?:[^，,。！？；;：:\n]{0,20}只读(?:排查|核对)(?:顺序)?|实施只读(?:清单|步骤))\s*[：:]/u
    : /(?:^|[。！？；;])(?:现场|实施)?只读(?:排查|核对)顺序\s*[：:]/u;
  const isRouteReadOnlySequenceFact = fact => routeReadOnlySequenceAnchorRe.test(String(fact || ''));
  const routeReadOnlySequenceFact = routeReadOnlySequenceQuestion
    ? currentRouteFacts.find(isRouteReadOnlySequenceFact) || ''
    : '';
  const routeReadOnlySequenceBoundary = (() => {
    if (!routeReadOnlySequenceFact) return '';
    const body = routeReadOnlySequenceFact.split(/[：:]/u).slice(1).join('：');
    const boundaryIndex = body.search(/(?:禁止|不得|不能|不要|未经授权)/u);
    return boundaryIndex >= 0
      ? body.slice(boundaryIndex).replace(/^[，,；;。！？\s]+|[\s]+$/gu, '').trim()
      : '';
  })();
  const routeReadOnlySequenceSteps = (() => {
    if (!routeReadOnlySequenceFact) return [];
    const body = routeReadOnlySequenceFact.split(/[：:]/u).slice(1).join('：');
    // 只在明确顺序标记前切分，保留同一步内部的并列对象与“只记录…”边界。
    // 同时支持“已登录后异常再读…”这类带条件的后续只读步骤；禁止/不得
    // 后的句子是安全边界，不作为可执行步骤。
    const sequenceMarkerSource = '(?:先|再|然后|随后|最后|按|记录|确认|核对|查看|读|沿|(?:需|应)?单独确认|另行确认|分别确认|[^，,；;。！？\\n]{1,24}(?:需|应)单独确认|[^，,；;。！？\\n]{1,16}后(?:异常)?再)';
    const sequenceSplitRe = new RegExp(`(?<=[，,；;。])(?=${sequenceMarkerSource})`, 'u');
    const stepMarkerRe = new RegExp(`^${sequenceMarkerSource}`, 'u');
    const nonSequenceTailRe = new RegExp(`[；;](?!${sequenceMarkerSource})[\\s\\S]*$`, 'u');
    const stripStepMarker = value => String(value || '')
      .replace(/^(?:先|再|然后|随后|最后|按)\s*/u, '')
      .replace(/[，,；;。！？\s]+$/gu, '')
      .trim();
    const stepClauses = body.split(sequenceSplitRe)
      .map(clause => clause
        .replace(nonSequenceTailRe, '')
        .replace(/[；;。！？](?:禁止|不得|不能|不要|未经授权)[\s\S]*$/u, '')
        .replace(/^[，,；;。！？\s]+|[，,；;。！？\s]+$/gu, '')
        .trim())
      .filter(clause => clause && stepMarkerRe.test(clause)
        && !/^(?:禁止|不得|不能|不要|未经授权)/u.test(clause));
    const stepTokens = value => stripStepMarker(value)
      .split(/[、，,与和]/u)
      .map(token => token
        .replace(/(?:核对|查看|查验|检查|看|沿)/gu, '')
        .replace(/[\s。；;：:]/gu, ''))
      .filter(Boolean);
    return stepClauses
      .map(step => ({
        // text 保持旧审计合同（不含“先/再/按”），displayText 用于
        // 确定性回答保留人能直接照做的顺序语义。
        text: stripStepMarker(step),
        displayText: step,
        tokens: stepTokens(step),
      }))
      .filter(step => step.tokens.length);
  })();
  const normalizedSequenceAnswer = text
    .replace(/(?:核对|查看|查验|检查|看|沿)/gu, '')
    .replace(/[\s，,。；;：:、与和]/gu, '');
  let previousSequencePosition = -1;
  const missingRouteReadOnlySequenceSteps = [];
  for (const step of routeReadOnlySequenceSteps) {
    const searchFrom = Math.max(0, previousSequencePosition + 1);
    const tokenPositions = step.tokens.map(token => normalizedSequenceAnswer.indexOf(token, searchFrom));
    const complete = tokenPositions.every(position => position >= 0);
    const firstPosition = complete ? Math.min(...tokenPositions) : -1;
    if (!complete || firstPosition < previousSequencePosition) missingRouteReadOnlySequenceSteps.push(step.text);
    else previousSequencePosition = Math.max(...tokenPositions);
  }
  const staticClientDiagnosticQuestion = staticClientOnlyRoute && fieldDiagnosticQuestion
    && (contextFollowupQuestion || continuationDiagnosticQuestion || implementationChecklistQuestion || explicitReviewDiagnosticQuestion);
  const staticClientScopeOverreachRe = /(?:当前操作请求|请求与返回|请求和返回|HTTP|业务码|服务端日志|后端日志|数据库|审核流水|操作流水|接口分支|请求是否到达)/iu;
  const staticClientScopeBoundaryRe = /(?:不适用|无需|不需要|不应|不得|不能|不要|到此停止|不再扩展)/iu;
  const staticClientScopeIsExplicitBoundary = statement => {
    const scopeIndex = String(statement || '').search(staticClientScopeOverreachRe);
    if (scopeIndex < 0) return false;
    const nearScope = String(statement).slice(Math.max(0, scopeIndex - 48), scopeIndex + 96);
    return staticClientScopeBoundaryRe.test(nearScope);
  };
  const staticClientScopeOverreach = staticClientDiagnosticQuestion ? text.split(/(?<=[。！？；\n])/u)
    .map(statement => statement.trim()).filter(statement => statement
      && staticClientScopeOverreachRe.test(statement)
      && !statementIsRouteFact(statement)
      && !staticClientScopeIsExplicitBoundary(statement)) : [];
  // 现场复测下的 broad facts 仍须给出可执行的只读核对顺序；仅把 route
  // facts 原样列出不能替代诊断步骤。这个门只作用于显式复测宽问法，普通
  // 产品事实题和一般实施问法不因此强制扩写。
  const diagnosticSequenceQuestion = fieldDiagnosticQuestion
    && (explicitReviewDiagnosticQuestion || verifiedInterfaceDataBoundaryDiagnosticQuestion || continuationDiagnosticQuestion || dataReturnedNotRenderedQuestion || implementationChecklistQuestion || requestResultMismatchQuestion || multiStepTransactionDiagnosticQuestion || retryBoundaryChecklistQuestion || uiAuthorizationProofQuestion || externalStepFailureOutcomeQuestion);
  const authorizationDiagnosticLayersComplete = !uiAuthorizationProofQuestion
    || (/(?:页面|界面|前端)[^。！？\n]{0,80}(?:不可选|不能选|禁选|禁用|不可用|隐藏|限制|不能点击|无法点击)/iu.test(text)
      && /(?:同一次|既有|已经发生)[^。！？\n]{0,48}(?:请求[^。！？\n]{0,32}响应|响应[^。！？\n]{0,32}请求)/iu.test(text)
      && /(?:服务端|后端|后台)[^。！？\n]{0,96}(?:归属|所属人|责任人|授权范围|租户|院区|科室|病区|操作前状态|原状态|前置状态)/iu.test(text)
      && /(?:任务状态|业务状态|审核流水|操作流水|审计记录|留痕记录)/iu.test(text));
  const multiStageSideEffectDiagnosticQuestion = multiStepTransactionDiagnosticQuestion || retryBoundaryChecklistQuestion;
  const multiStageDiagnosticStepText = topLevelSteps.map(step => step.line).join('\n');
  const multiStageDiagnosticLayerIndexes = [
    /(?:任务|业务|对象|主)[^。！？\n]{0,16}状态|主状态/iu,
    /(?:审核|操作|业务)?流水|审核记录|操作记录/iu,
    /Redis|缓存|超时[^。！？\n]{0,12}(?:key|键)|任务键/iu,
    /消息|通知/iu,
    /HIS[^。！？\n]{0,16}回调|外部[^。！？\n]{0,16}回调|回调日志/iu,
  ].map(re => multiStageDiagnosticStepText.search(re));
  const multiStageDiagnosticLayersComplete = !multiStageSideEffectDiagnosticQuestion
    || (multiStageDiagnosticLayerIndexes.every(index => index >= 0)
      && multiStageDiagnosticLayerIndexes.every((index, position) => position === 0 || index > multiStageDiagnosticLayerIndexes[position - 1])
      && /(?:只读|不(?:做|进行)?写入|不改数据|不得写入)/iu.test(multiStageDiagnosticStepText)
      && /(?:不|不得|不要|不能)[^。！？\n]{0,24}(?:盲目|整批|直接|重复)?重试|不能盲目整批重试/iu.test(multiStageDiagnosticStepText));
  const staticClientDiagnosticComplete = !staticClientDiagnosticQuestion
    || (/(?:入口|打开)[^。！？\n]{0,48}新标签页|新标签页[^。！？\n]{0,48}(?:入口|打开)/iu.test(text)
      && /(?:输入[^。！？\n]{0,32}必填|必填[^。！？\n]{0,32}输入)/iu.test(text)
      && /(?:计算结果|结果区)/u.test(text)
      && /重置/u.test(text)
      && /浏览器控制台/u.test(text)
      && /静态资源/u.test(text)
      && /(?:不适用|到此停止|不再扩展)/u.test(text)
      && staticClientScopeOverreach.length === 0);
  const dataNotRenderedEvidenceComplete = !dataReturnedNotRenderedQuestion
    || (/(?:同一次|本次已经发生|已有)[^。！？\n]{0,48}(?:请求[^。！？\n]{0,24}响应|响应[^。！？\n]{0,24}请求)/iu.test(text)
      && /请求参数/iu.test(text)
      && /HTTP\/?业务码/iu.test(text)
      && /响应原文/iu.test(text)
      && /账号角色/iu.test(text)
      && /(?:院区|医院|机构|租户)/iu.test(text)
      && /(?:页面路由|动态路由)/iu.test(text)
      && /渲染/iu.test(text)
      && /浏览器控制台/iu.test(text)
      && /请求标识/iu.test(text)
      && /时间/iu.test(text)
      && /版本/iu.test(text)
      && /(?:接口|请求)[^。！？\n]{0,24}(?:返回|有)[^。！？\n]{0,20}数据[^。！？\n]{0,48}(?:不代表|不能证明)[^。！？\n]{0,32}页面/iu.test(text)
      && /(?:不|不得|不要)[^。！？\n]{0,24}(?:修改|改动|写入)[^。！？\n]{0,16}数据/iu.test(text)
      && (!routeHasClientSessionScope
        || (/(?:Cookie|token)[^。！？\n]{0,48}(?:缓存|作用域|scope)|(?:缓存|作用域|scope)[^。！？\n]{0,48}(?:Cookie|token)/iu.test(text)
          && /(?:不|不得|不要)[^。！？\n]{0,16}(?:重新登录|重登录)/iu.test(text)
          && /(?:不|不得|不要)[^。！？\n]{0,16}清理[^。！？\n]{0,16}(?:Cookie|缓存)/iu.test(text)))
      && (!routeHasMultiDeviceSession
        || /(?:不|不得|不要)[^。！？\n]{0,16}关闭[^。！？\n]{0,16}(?:旧设备|其他设备)/iu.test(text)));
  const interfaceDataBoundaryStepText = topLevelSteps.map(step => step.line).join('\n');
  const interfaceDataBoundaryLayerIndexes = verifiedInterfaceDataBoundaryDiagnosticQuestion ? [
    /(?:页面|界面)[^。！？\n]{0,48}(?:筛选|查询条件)[^。！？\n]{0,48}(?:账号|角色|院区|机构|权限范围|数据范围)/iu,
    /(?:同一次|本次已经发生|既有|已有)[^。！？\n]{0,48}(?:请求[^。！？\n]{0,32}响应|响应[^。！？\n]{0,32}请求)/iu,
    /(?:服务端|后端|后台)[^。！？\n]{0,24}日志|(?:业务|处理|审核|操作)[^。！？\n]{0,20}(?:记录|流水|状态)/iu,
    /(?:页面|界面)[^。！？\n]{0,32}(?:呈现|展示|列表|结果)[^。！？\n]{0,48}(?:权限|范围|边界)|(?:权限|范围|边界)[^。！？\n]{0,48}(?:页面|界面)[^。！？\n]{0,32}(?:呈现|展示|列表|结果)/iu,
  ].map(re => interfaceDataBoundaryStepText.search(re)) : [];
  const interfaceDataBoundaryRouteStructureComplete = !verifiedInterfaceDataBoundaryDiagnosticQuestion
    || (missingInterfaceDataBoundarySignatures.length === 0
      && missingInterfaceDataBoundaryChecklistItems.length === 0
      && (!interfaceDataBoundaryInterfaces.some(item => item.readOnly) || /只读查询入口/u.test(text))
      && (!interfaceDataBoundaryInterfaces.some(item => item.sideEffect) || /有副作用的生成\/写入入口/u.test(text))
      && (!interfaceDataBoundaryInterfaces.some(item => !item.readOnly && !item.sideEffect) || /其它已核接口入口/u.test(text))
      && (!interfaceDataBoundaryDataFacts.length || /数据与选择条件/u.test(text))
      && (!interfaceDataBoundaryChecklistFact || /route 已核只读日志\/记录锚点/u.test(text)));
  const interfaceDataBoundaryDiagnosticComplete = !verifiedInterfaceDataBoundaryDiagnosticQuestion
    || (interfaceDataBoundaryLayerIndexes.every(index => index >= 0)
      && interfaceDataBoundaryLayerIndexes.every((index, position) => position === 0 || index > interfaceDataBoundaryLayerIndexes[position - 1])
      && /(?:能|可)(?:取得|拿到|查看)[^。！？\n]{0,32}(?:日志|记录)|(?:日志|记录)[^。！？\n]{0,32}(?:能|可)(?:取得|拿到|查看)/iu.test(interfaceDataBoundaryStepText)
      && /(?:取不到|拿不到|未取得|缺少|缺失)[^。！？\n]{0,32}(?:标明|标记|记录|列为)[^。！？\n]{0,16}(?:缺失|待确认)|(?:标明|标记|记录|列为)[^。！？\n]{0,16}(?:缺失|待确认)/iu.test(interfaceDataBoundaryStepText)
      && /(?:没有|无)[^。！？\n]{0,12}请求/iu.test(interfaceDataBoundaryStepText)
      && /请求失败/iu.test(interfaceDataBoundaryStepText)
      && /响应正常[^。！？\n]{0,36}(?:业务|页面)[^。！？\n]{0,20}(?:不一致|异常|不符合)/iu.test(interfaceDataBoundaryStepText)
      && /只读/iu.test(interfaceDataBoundaryStepText)
      && interfaceDataBoundaryRouteStructureComplete);
  const diagnosticSequenceComplete = !diagnosticSequenceQuestion
    || (topLevelSteps.length >= 4
      && /(?:只读|核对|记录|请求|响应|任务|日志)/iu.test(text)
      && authorizationDiagnosticLayersComplete
      && multiStageDiagnosticLayersComplete
      && retryRiskFactsComplete
      && staticClientDiagnosticComplete
      && dataNotRenderedEvidenceComplete
      && interfaceDataBoundaryDiagnosticComplete
      && (!continuationDiagnosticQuestion
        || (staticClientDiagnosticQuestion
          ? /(?:下一步|下一层|第二层|接下来|观测|待确认|缺失)/iu.test(text)
          : (/(?:下一步|下一层|第二层|接下来|观测|分支)/iu.test(text)
            && /(?:没有请求|请求失败|响应正常|未取得|缺失)/iu.test(text)))));
  const routeFactText = currentRouteFacts.join(' ');
  const routeFactDimensionRules = [
    ['接口', /(?:接口|\bAPI\b|HTTP|\b(?:GET|POST|PUT|PATCH|DELETE)\b\s+\/)/iu],
    ['数据', /(?:数据|字段|表(?:名)?|落库|持久化|数据库|请求|响应)/iu],
    ['边界', /(?:边界|范围|权限|角色|外部依赖|依赖|状态)/iu],
  ];
  const missingRouteFactDimensions = broadFactQuestion && currentRouteFacts.length === 1
    ? routeFactDimensionRules.filter(([label, re]) => factQuestionDimensions.includes(label) && !re.test(routeFactText)).map(([label]) => label)
    : [];
  const fallbackAnswerMode = chainRequested
    ? 'chain'
    : partialEvidenceQuestion
      ? 'partial_evidence'
      : fieldDiagnosticQuestion
        ? 'field_diagnostic'
        : missingRouteFactDimensions.length
          ? 'facts_with_unknowns'
          : 'facts';
  const chainDimensions = chainRequested ? [
    ['entry', '入口', /入口/u],
    ['interfaces', '接口', /接口/u],
    ['data', '数据', /数据/u],
    ['state', '状态', /状态/u],
    ['permissions', '权限', /权限/u],
    ['dependencies', '外部依赖', /(?:外部依赖|依赖)/u],
    ['audit', '留痕', /留痕/u],
  ].filter(([, , re]) => re.test(questionText)).map(([id, label]) => ({ id, label })) : [];
  const chainAnswerFacts = route && route.matched
    ? nonWritingRouteFacts.map(value => String(value || '').trim()).filter(Boolean) : [];
  const chainDirectEvidenceFacts = route && route.matched
    ? (route.directEvidenceFacts || []).flatMap(value => String(value || '').split(/\r?\n/u))
      .map(value => value.replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)/u, '').trim()).filter(Boolean) : [];
  // 端到端链路题除了“入口/接口/数据/依赖”这些研发维度，还可能在标题
  // 的括号/箭头中点名业务阶段（例如“接入→落库→分配→审核→回写”）。
  // 阶段词和事实匹配规则保持通用，不绑定某个 route 或题号；只从当前
  // route facts 取原句，避免用模型/其它模块知识补写阶段行为。
  const chainStageRules = [
    { label: '接入', questionRe: /接入|提交/u, factRe: /(?:接入|提交|入口|XML|接口码)/iu, factTerms: ['接入', '提交', '入口', 'XML', '接口码'] },
    { label: '落库', questionRe: /落库|持久化|写入/u, factRe: /(?:落库|写入|业务表|数据库|持久化|消费)/iu, factTerms: ['落库', '写入', '业务表', '数据库', '持久化', '消费'] },
    { label: '分配', questionRe: /分配|候选|承接/u, factRe: /(?:分配|候选|在线药师|有本院权限|共同候选|加权|轮询|承接|派任务)/iu, factTerms: ['分配', '候选', '在线药师', '有本院权限', '共同候选', '加权', '轮询', '承接', '派任务'] },
    { label: '审核', questionRe: /审核|审方/u, factRe: /(?:审核|审方|人工审核|自动通过|审核结果)/iu, factTerms: ['审核', '审方', '人工审核', '自动通过', '审核结果'] },
    { label: '回写', questionRe: /回写|回调|结果日志/u, factRe: /(?:回写|回调|结果日志|查询结果)/iu, factTerms: ['回写', '回调', '结果日志', '查询结果'] },
    { label: '查询', questionRe: /查询|主动查询/u, factRe: /(?:查询|主动查询|查询结果)/iu, factTerms: ['查询', '主动查询', '查询结果'] },
    { label: '推送', questionRe: /推送|通知/u, factRe: /(?:推送|通知|Socket)/iu, factTerms: ['推送', '通知', 'Socket'] },
    { label: '超时', questionRe: /超时|过期/u, factRe: /(?:超时|过期|自然过期)/iu, factTerms: ['超时', '过期', '自然过期'] },
    { label: '消费', questionRe: /消费|异步处理/u, factRe: /(?:消费|异步|redis2db|队列)/iu, factTerms: ['消费', '异步', 'redis2db', '队列'] },
    { label: '校验', questionRe: /校验|验证/u, factRe: /(?:校验|验证|必要节点|错误)/iu, factTerms: ['校验', '验证', '必要节点', '错误'] },
  ];
  const chainStageQuestionParts = [questionText]
    .concat(Array.from(questionText.matchAll(/[（(]([^（）()]*)[）)]/gu), match => match[1]))
    .flatMap(part => String(part || '').split(/\s*(?:→|->|=>|＞)\s*/u).map(item => item.trim()).filter(Boolean));
  const chainStageLabels = chainRequested
    ? chainStageRules.filter(rule => chainStageQuestionParts.some(part => rule.questionRe.test(part))).map(rule => rule.label)
    : [];
  const normalizeChainFact = value => {
    let normalized = String(value || '').replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)/u, '').trim();
    for (let index = 0; index < 3; index++) {
      const next = normalized.replace(/^\s*(?:业务结论|产品|入口|接口|任务和警示|外部依赖|生成记录|停止|前端证据边界|实施只读清单|实施只读核对|端到端边界|数据与状态|留痕|当前停点|影响|实施|时间|约束|排班|结果|边界|当前页面|后端边界|统一入口|接入入口与主接口|类型|长度|删除|历史影响|权限|研发|多任务|权重)\s*[：:]\s*/u, '').trim();
      if (next === normalized) break;
      normalized = next;
    }
    return normalized;
  };
  const chainFactLabels = new Map();
  const normalizeAndRememberChainFact = value => {
    const raw = String(value || '').replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)/u, '').trim();
    const label = raw.match(/^(业务结论|产品|入口|接口|任务和警示|外部依赖|生成记录|停止|前端证据边界|实施只读清单|实施只读核对|端到端边界|数据与状态|留痕|当前停点|影响|实施|时间|约束|排班|结果|边界|当前页面|后端边界|统一入口|接入入口与主接口|类型|长度|删除|历史影响|权限|研发|多任务|权重)\s*[：:]/u)?.[1] || '';
    const normalized = normalizeChainFact(value);
    if (normalized && label && !chainFactLabels.has(normalized)) chainFactLabels.set(normalized, label);
    return normalized;
  };
  // 链路正文以 route answerFacts 为主；directEvidenceFacts 只在 answerFacts
  // 没覆盖用户点名的维度时补足。mustNotConfuse 是审计边界，不得混入链路。
  const chainDimensionSourceRules = [
    ['entry', /(?:入口|接入|XML|页面|详情|列表)/iu],
    // “接口级授权/页面可见不等于接口授权”只是在讲权限边界，不代表
    // route 已提供了可串联的接口契约。接口维度必须有具体签名/路径，
    // 或明确的接口契约陈述；否则继续从精确 contextRef 恢复或停在未知。
    ['interfaces', /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\b\s+\/|接口(?:签名|路径|地址|契约|包括|包含|调用|为|是))/iu],
    ['data', /(?:数据|字段|表|落库|写入|保存|更新|删除|Redis|队列|消费|超时|状态|去重|事务|重试|查询|回写|日志|请求|响应|XML|校验)/iu],
    ['state', /(?:状态|结果|处理|记录|回写|保存|更新|删除|事务|重试|查询)/iu],
    ['permissions', /(?:权限|角色|鉴权|授权)/iu],
    ['dependencies', /(?:外部依赖|HIS|用户中心|audit-server|Redis|redis2db|Socket|Dubbo|Dify)/iu],
    ['audit', /(?:留痕|审计|记录|日志)/iu],
  ];
  const chainMissingSourceDimensions = chainDimensionSourceRules
    .filter(([id, rule]) => chainDimensions.some(item => item.id === id)
      && !chainAnswerFacts.some(fact => rule.test(fact)))
    .map(([id]) => id);
  // directEvidenceFacts 可能是完整 Spec 章节（含标题、Markdown 表格和通用
  // 权限/安全说明），不能把“某维度缺事实”变成把整章重新塞进链路。只承接
  // 已有明确维度标签的原子句；没有明确标签时由下方缺失维度停点收敛，避免
  // 把相邻章节或表格碎片误当成当前功能的入口/外部依赖。
  const chainDirectFactLabel = value => String(value || '').match(/^(入口|当前页面|统一入口|接入入口与主接口|接口|外部依赖|数据|数据与状态|状态|任务和警示|生成记录|停止|前端证据边界|实施只读清单|实施只读核对|影响|实施|时间|约束|排班|结果|边界|后端边界|类型|长度|删除|历史影响|权限|研发|多任务|权重)\s*[：:]/u)?.[1] || '';
  const chainDirectFallbackFacts = chainMissingSourceDimensions.length
    ? chainDirectEvidenceFacts.filter(fact => {
        if (/^\s*(?:#|\||>|\*|`)/u.test(fact)) return false;
        const label = chainDirectFactLabel(fact);
        if (!label) return false;
        return chainMissingSourceDimensions.some(id => (
          id === 'entry' ? ['入口', '当前页面', '统一入口', '接入入口与主接口'].includes(label)
            : id === 'interfaces' ? label === '接口'
              : id === 'dependencies' ? label === '外部依赖'
                : ['数据', '数据与状态', '状态', '任务和警示', '生成记录', '停止', '前端证据边界', '实施只读清单', '实施只读核对', '影响', '实施', '时间', '约束', '排班', '结果', '边界', '后端边界', '类型', '长度', '删除', '历史影响', '权限', '研发', '多任务', '权重'].includes(label)
        ));
      })
    : [];
  // 长接口章节会被 routeEvidenceExcerpt 压成“接口签名：METHOD path；…”。
  // 这是 current route 的精确 contextRef，不是模型自由文本；当 answerFacts
  // 只给业务摘要、用户又明确追问接口时，从该签名行恢复原子主接口。
  // 只读带“接口签名”标签的行，避免把同一章节里的辅助接口或源码碎片
  // 无条件扩成链路事实。
  const chainRouteTechnicalDiscriminators = Array.from(new Set(
    [...((route && route.answerFacts) || []), ...((route && route.mustNotConfuse) || [])]
      .flatMap(value => String(value || '').match(/\b[a-z][a-z0-9_]+_[a-z0-9_]+\b/giu) || [])
      .flatMap(token => token.toLowerCase().split('_'))
      .filter(segment => segment.length >= 3
        && !/^(?:audit|collect|task|record|data|table|status|result|deleted|create|update|user|hospital)$/u.test(segment)),
  ));
  const chainDirectInterfaceFacts = chainMissingSourceDimensions.includes('interfaces')
    ? chainDirectEvidenceFacts.flatMap(fact => String(fact || '').split(/\r?\n/u))
      .filter(line => /^接口签名\s*[：:]/u.test(line.trim()))
      .map(line => Array.from(line.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_./{}?=&:%-]+)/giu))
        .filter(match => !match[2].includes('*'))
        // directEvidence 章节里可能混有当前功能使用的公共辅助接口。
        // 只有路径包含 route 已核数据对象的判别片段时，才恢复为主链路
        // 接口；没有这类锚点就停在未知，不能为了“完整”把整章都串进来。
        .filter(match => chainRouteTechnicalDiscriminators.some(segment =>
          new RegExp(`(?:^|[/_.-])${segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:$|[/_.?&=-])`, 'iu').test(match[2])))
        .map(match => `${match[1].toUpperCase()} ${match[2]}`)
        .join('；'))
      .filter(Boolean)
    : [];
  // mustNotConfuse 有时同时携带“禁止误读”和一条用于消歧的当前数据事实
  //（例如当前模块实际另建哪类记录）。链路题可承接其中以肯定式开头、
  // 且包含数据对象 token 的前半句；禁止段本身不进入答案。这样既能保留
  // current route 的数据锚点，又不会把相邻模块的反例当成已核事实。
  const chainBoundaryDataFacts = chainRequested && chainDimensions.some(item => item.id === 'data' || item.id === 'state')
    ? (route.mustNotConfuse || []).flatMap(value => String(value || '').split(/[；;。]/u))
      .map(clause => clause.trim().split(/[，,](?=(?:不能|不得|不要|禁止|不可|不应))/u)[0].trim())
      .filter(clause => clause
        && !/^(?:不能|不得|不要|禁止|不可|不应)/u.test(clause)
        && /\b[a-z][a-z0-9_]+_[a-z0-9_]+\b/iu.test(clause)
        && /(?:当前|系统|新增|添加|取消|列表|记录|数据)[^。！？；\n]{0,40}(?:会|为|是|写入|写到|另建|新建|保存|读取|查询|更新|软删除)/u.test(clause))
    : [];
  const chainAvailableFacts = Array.from(new Set([
    ...chainAnswerFacts,
    ...chainDirectFallbackFacts,
    ...chainDirectInterfaceFacts,
    ...chainBoundaryDataFacts,
  ].map(normalizeAndRememberChainFact).filter(Boolean)));
  const chainSources = chainAvailableFacts;
  const chainDimensionRule = id => chainDimensionSourceRules.find(item => item[0] === id)?.[1];
  const chainDimensionLabelAllowed = (id, fact) => {
    const label = chainFactLabels.get(fact);
    if (!label || id !== 'entry') return true;
    return ['入口', '当前页面', '统一入口', '接入入口与主接口'].includes(label);
  };
  const missingChainFactDimensions = chainDimensions
    .filter(item => {
      const rule = chainDimensionRule(item.id);
      return rule && !chainAvailableFacts.some(fact => chainDimensionLabelAllowed(item.id, fact) && rule.test(fact));
    })
    .map(item => item.id);
  // 模型失败时可以用 route 事实生成稳定链路，但不能把一条
  // 模糊总述包装成“入口→接口→数据→依赖”。多维链路至少要有
  // 两个用户点名维度能从 answerFacts/精确 context 取得证据；
  // 若 route 本来就以多条已核事实说明业务链路，可发布已知事实并将
  // 未定义维度明确停住。单条模糊总述仍不构成链路证据。
  const chainKnownFactDimensions = chainRequested
    ? chainDimensions.filter(item => !missingChainFactDimensions.includes(item.id)).map(item => item.label)
    : [];
  const chainEvidenceSufficient = !chainRequested
    || (chainDimensions.length > 0
      && (chainKnownFactDimensions.length >= Math.min(2, chainDimensions.length)
        || currentRouteFacts.length >= 2));
  const chainInterfaceFacts = [];
  // “已确认主签名”只来自 answerFacts；contextRefs 里可能还有标题下拉、
  // 鉴权前缀等辅助接口，不能因“完整”反向塞进主链路。
  for (const fact of chainAvailableFacts) {
    for (const match of fact.matchAll(/\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9_./{}?=&:%-]+)/giu)) {
      if (match[2].includes('*')) continue;
      chainInterfaceFacts.push({ method: match[1].toUpperCase(), path: match[2], display: `${match[1].toUpperCase()} ${match[2]}` });
    }
  }
  const uniqueChainInterfaces = Array.from(new Map(chainInterfaceFacts.map(item => [`${item.method} ${item.path}`, item])).values());
  const businessChainFact = chainAvailableFacts.find(fact => !/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//iu.test(fact)
    && !/(?:Controller|Service|Mapper|Repository|DAO|DTO|VO|\b[a-z][a-z0-9_]+_[a-z0-9_]+\b|\bdeleted\s*=)/i.test(fact)) || '';
  const entryChainFact = chainAvailableFacts.find(fact => /(?:入口|详情|列表|页面)/u.test(fact)
    && !/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//iu.test(fact)) || businessChainFact;
  // 数据链路优先选择带具体数据对象/状态标记的 current-route 事实；
  // “另存一条记录”这类业务摘要可作为解释，但不能抢在已核表/对象前，
  // 否则确定性 fallback 会漏掉真正用于相邻模块消歧的数据锚点。
  const dataChainFact = chainAvailableFacts.find(fact => /(?:\b[a-z][a-z0-9_]+_[a-z0-9_]+\b|\bdeleted\s*=)/iu.test(fact))
    || chainAvailableFacts.find(fact => /(?:软删除|不物理删除|标记记录)/iu.test(fact))
    || chainSources.find(fact => /(?:\b[a-z][a-z0-9_]+_[a-z0-9_]+\b|\bdeleted\s*=|软删除|不物理删除)/iu.test(fact)) || '';
  const dependencyChainFactRaw = chainAvailableFacts.find(fact => /(?:外部依赖|用户中心|\bHIS\b|\bDubbo\b|Dify)/iu.test(fact))
    || chainSources.find(fact => /(?:外部依赖|用户中心|\bHIS\b|\bDubbo\b)/iu.test(fact)) || '';
  const compactDependencyChainFact = dependencyChainFactRaw
    .replace(/`?[A-Za-z_$][A-Za-z0-9_$]*(?:Service|Controller|Mapper|Repository|DAO|DTO|VO)(?:#[A-Za-z_$][A-Za-z0-9_$]*)?`?/g, '')
    .replace(/`?get[A-Z][A-Za-z0-9_$]*(?:Id|Info|List|Page|Detail)?`?/g, '')
    .replace(/\s{2,}/g, ' ').replace(/中心\s+补/gu, '中心补').trim();
  // 明确未知优先取 route.answerFacts 已发布的原子事实；只有该路由没有
  // 任何显式 gap 时，才承接 directEvidenceFacts 的显式未知。mustNotConfuse
  // 只参与审计，不应成为链路停点正文。
  const answerChainGapFacts = chainAnswerFacts.map(normalizeChainFact).filter(fact =>
    /(?:NEEDS-HUMAN|未定义|未覆盖|待确认|局部未知|需由业务负责人确认)/iu.test(fact)
    && !/(?:正文中的?\s*`?NEEDS-HUMAN|NEEDS-HUMAN[^.。！？]{0,30}(?:不得|不能|保持))/iu.test(fact));
  // Spec 章节的 directEvidenceFacts 可能把通用权限/幂等段和表格碎片一并
  // 带进来；只有原本就是独立 NEEDS-HUMAN 行、且标点/Markdown 完整时，
  // 才承接为链路停点。这样仍保留 route 明确的未知边界，不把相邻章节的
  // 泛化待确认项或残缺括号发布给用户。
  const directChainGapFacts = chainDirectEvidenceFacts.filter(fact =>
    /^(?:NEEDS-HUMAN|数据权限)\s*[：:]/iu.test(fact)
    && /(?:NEEDS-HUMAN|未定义|未覆盖|待确认|局部未知|需由业务负责人确认)/iu.test(fact)
    && !consultMalformedMarkdownTokens(fact).length
    && !consultMalformedProseTokens(fact).length
  );
  const explicitChainGapFacts = (answerChainGapFacts.length ? answerChainGapFacts : directChainGapFacts)
    .map(normalizeChainFact)
    .filter(fact =>
      /(?:NEEDS-HUMAN|未定义|未覆盖|待确认|局部未知|需由业务负责人确认)/iu.test(fact)
      && !/(?:正文中的?\s*`?NEEDS-HUMAN|NEEDS-HUMAN[^.。！？]{0,30}(?:不得|不能|保持))/iu.test(fact));
  const businessGapText = value => {
    let plain = String(value || '').replace(/[*_`#]/g, '').replace(/^.*?NEEDS-HUMAN[：:]?\s*/iu, '').trim();
    const owner = plain.match(/((?:是否[^，。；;]{1,30}待确认)|(?:[^，。；;]{2,50}需由[^，。；;]{1,24}确认))/u);
    if (owner) plain = owner[1];
    plain = plain.replace(/（[^（）]*(?:Controller|Service|Mapper|\b[a-z][A-Za-z0-9_]*\b)[^（）]*）/giu, '')
      .replace(/\([^()]*(?:Controller|Service|Mapper|\b[a-z][A-Za-z0-9_]*\b)[^()]*\)/giu, '')
      .replace(/\s{2,}/g, ' ').replace(/^[：:，,；;\s]+|[：:，,；;\s]+$/g, '').trim();
    return plain && /[一-鿿]/u.test(plain) ? (/[。！？]$/u.test(plain) ? plain : `${plain}。`) : '';
  };
  const compactChainGapFacts = Array.from(new Set(explicitChainGapFacts.map(businessGapText).filter(Boolean))).slice(0, 4);
  const chainGapFactSet = new Set(explicitChainGapFacts.map(normalizeChainFact));
  const chainDimensionFacts = chainAvailableFacts.filter(fact => !chainGapFactSet.has(normalizeChainFact(fact)));
  // implementation_chain 的入口/接口/数据/依赖分类可能漏掉“最近 7 天、
  // 最多 10 条、默认 20 分钟”等中间业务口径，因为这些句子不一定含
  // 表/状态/依赖关键词。只从 current route answerFacts 里挑带明确量化
  // 范围且同时含业务口径词的高分事实，最多 3 条；既保住关键规则，也
  // 不把整份 answerFacts 无限制复制进链路。
  const chainQuantifiedTokens = fact => Array.from(new Set(
    String(fact || '').match(/(?:TOP\s*\d+|\d+\s*(?:天|日|周|个月|月|年|分钟|小时|秒|条|次|字|字符|份|%))/giu) || [],
  ));
  const chainKeyBusinessFacts = chainRequested ? chainDimensionFacts
    .map((fact, index) => {
      const tokens = chainQuantifiedTokens(fact);
      const scopeScore = [/(?:趋势|范围|周期|口径|核心指标|统计)/u, /(?:最近|含今天|含当月|默认|固定|最多|至少|上限|下限|分别)/u]
        .reduce((score, re) => score + (re.test(fact) ? 1 : 0), 0);
      return { fact, index, tokens, score: tokens.length * 2 + scopeScore };
    })
    .filter(item => item.tokens.length && item.score >= 3)
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, 3)
    .map(item => item.fact) : [];
  const normalizedChainCoverageText = text.replace(/\s+/gu, '').toLowerCase();
  const missingChainKeyBusinessFacts = chainKeyBusinessFacts.filter(fact =>
    chainQuantifiedTokens(fact).some(token => !normalizedChainCoverageText.includes(token.replace(/\s+/gu, '').toLowerCase()))
  );
  const chainStageFactsByLabel = new Map();
  for (const label of chainStageLabels) {
    const rule = chainStageRules.find(item => item.label === label);
    if (!rule) continue;
    // 用多个业务阶段信号排序，优先保留同时覆盖“候选/权限/权重/承接”等
    // 关键事实的原句；每阶段最多带两条，避免把整张 route 卡重复展开。
    const candidates = chainDimensionFacts
      .map((fact, index) => ({
        fact,
        index,
        score: rule.factTerms.reduce((score, term) => score + (fact.includes(term) ? 1 : 0), 0),
      }))
      .filter(item => item.score > 0 && rule.factRe.test(item.fact))
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .slice(0, 2)
      .map(item => item.fact);
    if (candidates.length) chainStageFactsByLabel.set(label, candidates);
  }
  const chainFactsByLabelOrRule = (facts, labels, rule) => facts.filter(fact => {
    const label = chainFactLabels.get(fact);
    return label ? labels.includes(label) : rule.test(fact);
  });
  const chainBusinessFact = chainDimensionFacts.find(fact => !/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//iu.test(fact)
    && !/(?:Controller|Service|Mapper|Repository|DAO|DTO|VO|\b[a-z][a-z0-9_]+_[a-z0-9_]+\b|\bdeleted\s*=)/i.test(fact)) || businessChainFact;
  const chainEntryFact = chainDimensionFacts.find(fact => /(?:入口|详情|列表|页面)/u.test(fact)
    && !/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\//iu.test(fact)) || chainBusinessFact;
  const answerChainPaths = new Set(consultConcretePaths(text));
  const explicitlyRequestsInterfaces = /(?:接口|\bAPI\b|路径)/iu.test(questionText);
  const missingRequestedInterfaces = explicitlyRequestsInterfaces
    ? uniqueChainInterfaces.filter(item => {
        if (!answerChainPaths.has(item.path)) return true;
        const escaped = item.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return !new RegExp(`\\b${item.method}\\s+${escaped}`, 'iu').test(text);
      }) : [];
  const missingChainInterfaces = chainDimensions.some(item => item.id === 'interfaces') ? missingRequestedInterfaces : [];
  const dataMarkers = [];
  if (dataChainFact) {
    for (const token of dataChainFact.match(/\b[a-z][a-z0-9_]+_[a-z0-9_]+\b/giu) || []) dataMarkers.push(token);
    for (const token of dataChainFact.match(/\bdeleted\s*=\s*(?:true|false|[01])/giu) || []) dataMarkers.push(token.replace(/\s+/g, ''));
  }
  const missingChainDataMarkers = chainDimensions.some(item => item.id === 'data' || item.id === 'state')
    ? Array.from(new Set(dataMarkers)).filter(marker => !text.replace(/\s+/g, '').toLowerCase().includes(marker.replace(/\s+/g, '').toLowerCase())) : [];
  const dependencyMarkers = ['用户中心', 'HIS', 'Dubbo'].filter(marker => dependencyChainFactRaw.toLowerCase().includes(marker.toLowerCase()));
  const missingChainDependencyMarkers = chainDimensions.some(item => item.id === 'dependencies')
    ? dependencyMarkers.filter(marker => !text.toLowerCase().includes(marker.toLowerCase())) : [];
  const missingChainDimensions = [];
  if (chainDimensions.some(item => item.id === 'entry') && entryChainFact && !/(?:入口|详情|列表|页面)/u.test(text)) missingChainDimensions.push('入口');
  if (missingChainInterfaces.length) missingChainDimensions.push('接口');
  if (missingChainDataMarkers.length) missingChainDimensions.push('数据/状态');
  if (missingChainDependencyMarkers.length) missingChainDimensions.push('外部依赖');
  if (missingChainKeyBusinessFacts.length) missingChainDimensions.push('关键业务口径');
  if (chainRequested && compactChainGapFacts.length && !/(?:待确认|未定义|局部未知|当前停点|尚未确认)/u.test(text)) missingChainDimensions.push('资料明确的未知停点');
  const chainFieldQuestion = /(?:字段(?:名|类型|长度|取值|清单|全部|完整)?|入参|出参|返回字段)/iu.test(questionText);
  const chainCodeQuestion = /(?:源码|代码|Java\s*类|类名|方法名|Controller|Service|Mapper|Repository|DAO|DTO|VO)/iu.test(questionText);
  const chainTechnicalDetailParts = [];
  if (chainRequested && !chainFieldQuestion) {
    for (let index = 0; index + 1 < documentLines.length; index++) {
      const cells = consultMarkdownTableCells(documentLines[index]);
      if (!cells || !/^\s*\|?\s*:?-{3,}/u.test(documentLines[index + 1] || '')) continue;
      if (!/(?:字段|列名|参数|类型|长度|入参|出参)/iu.test(cells.join(' '))) continue;
      let end = index + 2;
      while (end < documentLines.length && consultMarkdownTableCells(documentLines[end])) end += 1;
      chainTechnicalDetailParts.push(documentLines.slice(index, end).join('\n'));
      index = end - 1;
    }
    for (const part of audienceParts) if (consultScopeTechnicalTokens(part).length >= 4) chainTechnicalDetailParts.push(part);
  }
  if (chainRequested && !chainCodeQuestion) {
    const sourceCodePartRe = /(?:[A-Za-z0-9_./-]+\.java\b|\b[A-Z][A-Za-z0-9_$]*(?:Controller|Service|Mapper|Repository|DAO|DTO|VO)\b|(?:Controller|Service|Mapper|Repository|DAO|DTO|VO)\s*[.#：:])/i;
    for (const part of audienceParts) if (sourceCodePartRe.test(part)) chainTechnicalDetailParts.push(part);
  }
  // 非字段问法下，产品/实施正文一段连续堆出大量 snake_case/camelCase
  // 同样是受众越界。阈值取 >8，允许必要的单表/状态/主键名短参考。
  const audienceTechnicalDumpParts = [];
  if (audienceMode !== 'developer' && !chainFieldQuestion) {
    for (const block of text.split(/\n\s*\n/u)) if (consultScopeTechnicalTokens(block).length > 8) audienceTechnicalDumpParts.push(block.trim());
  }
  const uniqueChainTechnicalDetailParts = Array.from(new Set([
    ...chainTechnicalDetailParts,
    ...audienceTechnicalDumpParts,
  ].map(part => part.trim()).filter(Boolean)));
  let safeChainFallback = '';
  if (chainRequested) {
    const chainLines = [];
    // 按 route 原句的语义维度组织链路。入口不能回退到第一条业务总述，
    // 否则“入口与主接口”事实会被总述遮住；数据/状态也保留 route 中
    // 已核的事务、重试、队列和落库边界，但不展开字段清单。
    const entryChainFacts = chainFactsByLabelOrRule(
      chainDimensionFacts,
      ['入口', '当前页面', '统一入口', '接入入口与主接口'],
      /(?:入口|接入|XML|页面|详情|列表)/iu,
    );
    const dataStateChainFacts = chainFactsByLabelOrRule(
      chainDimensionFacts,
      ['任务和警示', '生成记录', '停止', '数据与状态', '留痕', '影响', '实施', '时间', '约束', '排班', '结果', '边界', '后端边界', '类型', '长度', '删除', '历史影响', '权限', '研发', '多任务', '权重', '实施只读核对'],
      /(?:数据|字段|表|落库|写入|保存|更新|删除|Redis|队列|消费|超时|状态|去重|事务|重试|查询|回写|日志|请求|响应|XML|校验)/iu,
    );
    const dependencyChainFacts = chainFactsByLabelOrRule(
      chainDimensionFacts,
      ['外部依赖'],
      /(?:外部依赖|HIS|用户中心|audit-server|Redis|redis2db|Socket|Dubbo|Dify)/iu,
    );
    const addMissingChainDimension = (id, label) => {
      if (!missingChainFactDimensions.includes(id)) return;
      chainLines.push(`- ${label}：本轮 route 已核事实未提供可发布的${label}细节，当前停点，不补写。`);
    };
    const usedChainFacts = new Set(chainBusinessFact ? [chainBusinessFact] : []);
    const addChainFacts = (label, candidates, fallback = '') => {
      const facts = Array.from(new Set((candidates.length ? candidates : (fallback ? [fallback] : []))
        .map(normalizeChainFact).filter(fact => fact && !usedChainFacts.has(fact))));
      if (!facts.length) return;
      for (const fact of facts) {
        usedChainFacts.add(fact);
        chainLines.push(`- ${label}：${fact}`);
      }
    };
    if (chainDimensions.some(item => item.id === 'entry')) {
      // 有些 route 用“登录后/进入后/打开后……”描述真实起点，而没有另写
      // “入口：”标签。这条业务总述既是结论也是链路入口，需在入口段明确
      // 复用；其它 route 继续沿用显式入口/页面事实，不把任意首条当入口。
      const businessEntryFact = /(?:登录后|进入后|打开后|访问后|从[^。！？\n]{1,32}(?:进入|打开|访问))/u.test(chainBusinessFact)
        ? chainBusinessFact : '';
      if (businessEntryFact) chainLines.push(`- 入口：${normalizeChainFact(businessEntryFact)}`);
      else addChainFacts('入口', entryChainFacts, missingChainFactDimensions.includes('entry') ? '' : chainEntryFact);
      addMissingChainDimension('entry', '入口');
    }
    if (chainDimensions.some(item => item.id === 'interfaces') && uniqueChainInterfaces.length) {
      for (const item of uniqueChainInterfaces) chainLines.push(`- 接口：\`${item.display}\`。`);
    }
    if (chainDimensions.some(item => item.id === 'interfaces') && !uniqueChainInterfaces.length) addMissingChainDimension('interfaces', '接口');
    if (chainDimensions.some(item => item.id === 'data' || item.id === 'state')) {
      const dataStateLineBefore = chainLines.length;
      // Keep the first route fact that defines concrete data markers even when
      // other data/state facts were selected before it; otherwise the audit
      // sees a missing marker and rejects the otherwise deterministic chain.
      const dataMarkerFallbackFact = dataChainFact
        && chainFactLabels.get(normalizeChainFact(dataChainFact)) !== '外部依赖'
        ? dataChainFact : '';
      addChainFacts('数据与状态', [...dataStateChainFacts, ...(dataMarkerFallbackFact ? [dataMarkerFallbackFact] : [])]);
      if (chainLines.length === dataStateLineBefore) {
        addMissingChainDimension('data', '数据');
        addMissingChainDimension('state', '状态');
      }
    }
    addChainFacts('关键业务口径', chainKeyBusinessFacts);
    if (chainDimensions.some(item => item.id === 'dependencies')) {
      const dependencyLineBefore = chainLines.length;
      addChainFacts('外部依赖', dependencyChainFacts, compactDependencyChainFact);
      // 一条 route fact 可能同时充当开头业务结论和外部依赖说明。全局
      // 去重不能让用户点名的“外部依赖”维度消失；只在该维度没有输出时
      // 复用已核依赖事实，并保留其客观 As-built 描述。
      if (chainLines.length === dependencyLineBefore && compactDependencyChainFact) {
        chainLines.push(`- 外部依赖：${normalizeChainFact(compactDependencyChainFact)}`);
      }
      if (chainLines.length === dependencyLineBefore) {
        addMissingChainDimension('dependencies', '外部依赖');
      }
    }
    // 阶段事实独立于入口/接口/数据/依赖四个维度保留；即使同一原句
    // 已作为维度事实出现，也要在点名阶段下再呈现，避免阶段（尤其分配）
    // 被维度去重吞掉。每阶段最多两条，仍不扩入 route 之外的知识。
    for (const label of chainStageLabels) {
      const facts = Array.from(new Set((chainStageFactsByLabel.get(label) || [])
        .map(normalizeChainFact).filter(Boolean)));
      for (const fact of facts) chainLines.push(`- 业务阶段「${label}」：${fact}`);
    }
    const explicitChainStopQuestion = /(?:资料|说明|文档|规格|Spec)[^。！？\n]{0,32}(?:没定义|未定义|没有定义|未说明|没说明|未覆盖)[^。！？\n]{0,24}(?:停住|停止|不补|明确)/iu.test(questionText)
      || /(?:没定义|未定义|未覆盖)[^。！？\n]{0,32}(?:停住|停止|不补|明确)/iu.test(questionText);
    const gapBlock = compactChainGapFacts.length
      ? ['当前停点（只列资料明确的未知）：', ...compactChainGapFacts.map(fact => `- ${fact}`)]
      : explicitChainStopQuestion
        ? ['当前停点：本轮到上述已核链路为止，不补写其它入口、数据、依赖或结果。']
        : [];
    safeChainFallback = [chainBusinessFact ? `业务结论：${normalizeChainFact(chainBusinessFact)}` : '', '链路（按本轮点名维度）：', ...chainLines, ...gapBlock].filter(Boolean).join('\n');
  }
  // “最小证据/只缺一项”本身也是一份输入契约：后面的判断表不能首次
  // 引入没有在用户已有证据或前序采集清单中定义的观测量。这里按观测
  // 对象审计，而不是按某一道题或某个接口硬编码；route 只提供事实，不能
  // 自动证明现场已经取得了对应观测值。
  const observationRules = [
    { id: 'page', label: '页面/截图现象', re: /(?:页面|界面|截图|图片|附图|图内|屏幕)/iu },
    { id: 'response', label: '请求/接口响应', re: /(?:请求(?:原文|响应)?|接口响应|完整响应|响应(?:原文|内容)?|返回值|状态码|业务码|\byear\b|\bweek\b)/iu },
    { id: 'local_clock', label: '同一时刻本机日期/星期/时间', re: /(?:(?:浏览器|本机|电脑|终端|客户端)[^。！？；|\n]{0,18}(?:日期|星期|时间|时区)|(?:日期|星期|时间|时区)[^。！？；|\n]{0,18}(?:浏览器|本机|电脑|终端|客户端))/iu },
    { id: 'logs', label: '日志', re: /(?:服务端|服务器|应用|任务|调度)?日志/iu },
    { id: 'database', label: '数据库观测', re: /(?:数据库|库内|落库|表内|表中|SQL查询)/iu },
  ];
  const observationIds = value => observationRules
    .filter(rule => rule.re.test(String(value || ''))).map(rule => rule.id);
  const userObservationClauses = questionText.split(/[，,。！？；;\n]/u).map(item => item.trim()).filter(Boolean);
  const userExistingObservationVariables = new Set();
  for (const clause of userObservationClauses) {
    if (!/(?:只有|仅有|只(?:有|拿得到|拿到|能拿到)|已有|已经|拿到|取得|记录|记下|显示|具备|提供|有这|有一)/u.test(clause)) continue;
    for (const id of observationIds(clause)) userExistingObservationVariables.add(id);
  }
  let observationInputContract = null;
  const minimumInputContractRe = /(?:最小(?:证据|输入|缺口)|真正还缺|还缺的是|只(?:还)?缺|仅(?:还)?缺|需补(?:的)?(?:证据|输入)|采集清单|已有\/需补\/采集)/u;
  for (let index = 0; index < documentLines.length - 1; index += 1) {
    const headers = consultMarkdownTableCells(documentLines[index]);
    if (!headers || !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/u.test(documentLines[index + 1] || '')) continue;
    const headerText = headers.join(' ');
    if (!/(?:判断|含义|结论|下一步|说明)/u.test(headerText)
      || !/(?:对照|情况|结果|现象|条件|页面|响应|输入)/u.test(headerText)) continue;
    let end = index + 2;
    while (end < documentLines.length && consultMarkdownTableCells(documentLines[end])) end += 1;
    const tableLines = documentLines.slice(index, end);
    const tableText = tableLines.join('\n');
    const prefixLines = documentLines.slice(0, index);
    const prefixText = prefixLines.join('\n');
    if (!evidenceSufficiencyQuestion && !minimumInputContractRe.test(prefixText)) continue;
    const used = new Set(observationIds(tableText));
    if (!used.size) continue;
    const defined = new Set(userExistingObservationVariables);
    let insideInputSection = false;
    for (const line of prefixLines) {
      const plain = line.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|[1-9]\d*[.、．]\s+)?/u, '').replace(/[*_`]/g, '').trim();
      if (!plain) continue;
      if (minimumInputContractRe.test(plain) || /(?:已有|需补|采集|输入|证据|缺口)(?:清单|项|如下|：|:)/u.test(plain)) insideInputSection = true;
      const declaresInput = insideInputSection
        || /(?:还缺|需补|补充|采集|记录|记下|保留|拿到|取得|获取|提供|输入|证据|原文|完整响应|同一时刻)/u.test(plain);
      if (declaresInput) {
        const explicitlyExcludedLogs = /(?:不是|无需|不需|不必|没有|拿不到|不依赖)[^。！？；\n]{0,12}(?:服务端|服务器|应用|任务|调度)?日志/u.test(plain);
        for (const id of observationIds(plain)) {
          if (id === 'logs' && explicitlyExcludedLogs) continue;
          defined.add(id);
        }
      }
    }
    const unbound = [...used].filter(id => !defined.has(id));
    const claimedOne = /(?:还缺的是(?:下面|以下)?这一项|(?:只|仅)(?:还)?缺[^。！？\n]{0,16}(?:一|1)\s*项)/u.test(prefixText);
    const declaredMissing = new Set([...defined].filter(id => !userExistingObservationVariables.has(id)));
    const actualMissing = new Set([...declaredMissing, ...unbound]);
    observationInputContract = {
      headerLine: documentLines[index].trim(),
      usedVariables: [...used],
      definedVariables: [...defined],
      userExistingVariables: [...userExistingObservationVariables],
      unboundVariables: unbound,
      unboundLabels: unbound.map(id => observationRules.find(rule => rule.id === id)?.label || id),
      claimedMissingCount: claimedOne ? 1 : null,
      actualMissingCount: actualMissing.size,
      countMismatch: claimedOne && actualMissing.size !== 1,
    };
    break;
  }
  const undefinedObservationVariables = observationInputContract && (
    observationInputContract.unboundVariables.length || observationInputContract.countMismatch
  ) ? observationInputContract : null;
  let safeDiagnosticFallback = '';
  if (diagnosticQuestion) {
    const publicMustNotConfuse = route && route.matched
      ? (route.mustNotConfuse || []).map(String).map(x => x.trim()).filter(Boolean)
        .filter(fact => !/(?:current route|路由事实|最小缺口模板|内部措辞)/iu.test(fact)).slice(0, 1)
      : [];
    // 只读清单不能固定截前 3 条：同一 route 的后段经常才是生产核对、授权
    // 和重复调用边界。按本轮实施/排查意图优先保留与观测、安全、生产状态
    // 直接相关的 facts，同时保留首条业务基线；技术细节稍后仍按受众收敛。
    const diagnosticFactRelevanceRe = /(?:实施|只读|排查|留证|核对|记录|日志|生产包|发布记录|访问|失败记录|支持能力|授权|未经|不得|不能|后续调用|重复|重发|重提|异常|现状|状态|证据|响应|返回|日期|星期|时间|页面|业务|功能|范围|对象|结果|条件|另一套(?:错误)?机制|不由[^。！？；\n]{0,32}统一处理|相邻(?:机制|功能)|机制隔离)/iu;
    const diagnosticFactQuestion = explicitReviewDiagnosticQuestion
      || /(?:实施|只读|排查|留证|复测|现场|清单|证据|缩小范围|转开发|怎么查|如何查|核对|怎么判断|如何判断)/iu.test(intentQuestionText);
    // “上一层已核正常，下一层继续只读排查”“改成实施逐项只读清单”或
    // “请求成功但结果不一致”都不是再次复述完整 route。若 route 已给专用
    // 只读顺序，只保留首条业务基线；顺序事实由下方
    // routeReadOnlySequenceSteps 展开，避免长 route 全量搬运后形成技术倾倒。
    // 这仍完全由 current route 派生，不会放入相邻 route 或模型新增事实。
    const compactRouteChecklistFacts = (continuationDiagnosticQuestion
      || requestResultMismatchQuestion
      || (implementationChecklistQuestion && !stageAwareImplementationChecklist && !retryBoundaryChecklistQuestion))
      && /(?:^|[。！？；;])实施只读(?:清单|步骤)\s*[：:]/u.test(routeReadOnlySequenceFact);
    const diagnosticSourceFacts = compactRouteChecklistFacts
      ? Array.from(new Set([currentRouteFacts[0], routeReadOnlySequenceFact].filter(Boolean)))
      : currentRouteFacts;
    const allConfirmedFacts = route && route.matched
      ? Array.from(new Set([
          // “独立复测 + 接口/数据/边界”是宽盘点，不得用实施相关性过滤
          // 掉后段业务阶段（如分配）或事务/失败流水边界；仍只取 current
          // route facts，不能扩入相邻 route。其它 field diagnostic 继续按
          // 相关性精简，避免普通现场清单技术倾倒。
          ...diagnosticSourceFacts.filter((fact, index) => (explicitReviewDiagnosticQuestion || verifiedInterfaceDataBoundaryDiagnosticQuestion || (!compactRouteChecklistFacts && continuationDiagnosticQuestion) || dataReturnedNotRenderedQuestion || implementationChecklistQuestion || requestResultMismatchQuestion || multiStepTransactionDiagnosticQuestion || retryBoundaryChecklistQuestion || uiAuthorizationProofQuestion || minimalEvidenceQuestion)
            || index === 0 || !diagnosticFactQuestion || diagnosticFactRelevanceRe.test(fact)),
          ...(compactRouteChecklistFacts && routeReadOnlySequenceBoundary ? [] : publicMustNotConfuse),
        ].map(String).map(x => x.trim()).filter(Boolean)))
      : [];
    // field diagnostic 是非写操作回答形态，不因问句同时点名接口而改变。
    // “独立复测 + 接口/数据/边界”会落到 developer 受众，但其中的系统
    // As-built 顺序仍必须客观化，不能重新出现“再通过…补全”的动作歧义；
    // 技术接口事实只按下方受众规则排版，不会因此被删除。
    const publishableConfirmedFacts = fieldDiagnosticQuestion
      ? allConfirmedFacts.map(normalizeNonWritingRouteFact)
      : allConfirmedFacts;
    const confirmedTechnicalFacts = audienceMode === 'implementation'
      ? publishableConfirmedFacts.filter(fact => !verifiedBusinessCondition(fact)
        && (sourceTechnicalRe.test(fact) || concreteInterfaceRe.test(fact))) : [];
    // 实施只读兜底只发布可作为判断基线的事实。route fact 里的“新建前会删除/提交/重放”等
    // 是对现状流程的描述，不是本轮允许执行的动作；原样搬进只读清单会被动作审计误判成现场指令，
    // 进而让已核事实 fallback 自己拒答。此类带动作起句的事实留在 route/retrieval 供模型和审计追溯，
    // 不作为本轮实施终稿正文发布；负向边界（“不得…”）不命中该规则，仍可保留。
    const diagnosticActionFactRe = /(?:^|[，：:；;]\s*)(?:[-*]\s+|[1-9]\d*[.、．]\s*)?(?:新建|新增|创建|编辑|删除|修改|调整|保存|提交|发送|重放|重提|重试|重复|补发|复测|再点|点一次|重新(?:提交|发送|触发|执行))/iu;
    const confirmedFacts = publishableConfirmedFacts
      .flatMap(fact => {
        if (audienceMode !== 'implementation'
          || verifiedBusinessCondition(fact)
          || (!sourceTechnicalRe.test(fact) && !concreteInterfaceRe.test(fact))) return [fact];
        // 混合事实里的业务边界（例如“日期来自服务端当前时区”“失败状态不回写”）
        // 仍是实施判断基线；只把接口/实现片段移到研发参考，不能整条 fact 丢掉。
        const businessClauses = String(fact).split(/[，,；;]/u).map(clause => clause.trim())
          .filter(clause => clause && !sourceTechnicalRe.test(clause) && !concreteInterfaceRe.test(clause));
        return businessClauses.length ? [businessClauses.join('，')] : [];
      })
      // route 有时把只读顺序和“新增/取消会写数据”的禁止边界写在同一
      // 条 fact。动作过滤不能因此连前半段已核顺序一起删掉；紧凑 route 清单只
      // 发布冒号后的顺序子句，通用清单再负责统一写操作边界。
      .flatMap(fact => compactRouteChecklistFacts
        && routeReadOnlySequenceSteps.length && isRouteReadOnlySequenceFact(fact)
        ? []
        : routeReadOnlySequenceQuestion && isRouteReadOnlySequenceFact(fact)
          ? [String(fact).split(/[；;]/u)[0].trim()].filter(Boolean)
        : [fact])
      .filter(fact => audienceMode !== 'implementation'
        || !diagnosticActionFactRe.test(fact)
        || /^(?:[^：:\n]{1,20}(?:表现|现状|结果|流程))\s*[：:]/u.test(fact));
    // 多步副作用诊断把 route 原句收敛成业务可读的三条判断基线，避免原句
    // 中“再提交/发消息/触发回调”等 as-built 描述被读成现场执行指令。
    // 每条只在 current route 已明确相应事实时生成，不补造 route 外结论。
    const multiStageKnownFacts = multiStageSideEffectDiagnosticQuestion ? [
      currentRouteFacts.some(fact => /(?:没有|无|不在)[^。！？\n]{0,20}(?:统一|同一|总)?事务|不会统一回滚/iu.test(fact))
        ? '业务结论：这些步骤没有统一事务，后一步失败不会统一回滚前一步，不能承诺全部成功或全部失败。' : '',
      currentRouteFacts.some(fact => /(?:部分完成|部分成功|状态[^。！？\n]{0,24}流水|流水[^。！？\n]{0,40}(?:消息|回调)|不能反推[^。！？\n]{0,24}全部失败)/iu.test(fact))
        ? '结果边界：中途失败可能形成主状态、流水、Redis 超时键或任务键、消息、外部回调之间不一致；页面或请求报错不能证明所有步骤都失败。' : '',
      retryRiskCoverageGroups.length
        ? '重试边界：当前处理不校验操作前原状态，没有业务幂等键，也没有并发锁；同一批对象再次进入处理可能重复产生审核流水、消息和外部回调。Redis 键清理自身幂等，但不能保证整次业务操作幂等。' : '',
      ...publicMustNotConfuse,
    ].filter(Boolean) : confirmedFacts;
    const stageChecklistKnownFacts = stageAwareImplementationChecklist
      ? nonWritingRouteFacts
      : staticClientDiagnosticQuestion
        ? confirmedFacts.filter(fact => !/^(?:研发|开发|技术)\s*[：:]/u.test(String(fact || '')))
        : multiStageKnownFacts;
    const checklistStageBlock = stageAwareImplementationChecklist ? [
      '逐阶段只读核对范围：',
      ...checklistStageLabels.map(label => {
        const hasMappedFact = nonWritingRouteFacts.some(fact => String(fact).includes(label));
        return hasMappedFact
          ? `- 阶段「${label}」：按下方已核判断基线，只读核对已有页面、请求、任务状态和流水。`
          : `- 阶段「${label}」：当前已核材料不足以补写该阶段的独立结果；只记录已有页面、请求、状态和流水，并将结果列为待确认。`;
      }),
    ].join('\n') : '';
    // “继续作为判断基线”会被结构审计当成成对分支引导；当后续 route
    // 恰有“成功：”事实时会误报缺少“失败：”。页面未呈现或接口/数据/
    // 边界的宽诊断都是业务事实盘点，使用不含分支引导词的标题；
    // facts 内容与顺序不变，真正的成对分支审计仍保持严格。
    const knownBlockHeading = dataReturnedNotRenderedQuestion || verifiedInterfaceDataBoundaryDiagnosticQuestion || continuationDiagnosticQuestion
      ? '已核业务边界：'
      : '已知事实（继续作为判断基线）：';
    const knownBlock = stageChecklistKnownFacts.length
      ? [knownBlockHeading, ...stageChecklistKnownFacts.map(fact => `- ${fact}`)].join('\n')
      : '当前没有已核证据确认具体按钮、接口、字段或状态值；下面只给不依赖这些未知事实的只读留证。';
    const interfaceDataBoundaryReadInterfaces = interfaceDataBoundaryInterfaces.filter(item => item.readOnly).map(item => item.signature);
    const interfaceDataBoundarySideEffectInterfaces = interfaceDataBoundaryInterfaces.filter(item => item.sideEffect).map(item => item.signature);
    const interfaceDataBoundaryOtherInterfaces = interfaceDataBoundaryInterfaces
      .filter(item => !item.readOnly && !item.sideEffect).map(item => item.signature);
    const interfaceDataBoundaryRouteBlock = verifiedInterfaceDataBoundaryDiagnosticQuestion ? [
      '当前 route 的分层核对锚点：',
      ...(interfaceDataBoundaryReadInterfaces.length
        ? [`- 只读查询入口：${interfaceDataBoundaryReadInterfaces.join('；')}。只核对同一次已经发生的查询，不主动重放。`]
        : []),
      ...(interfaceDataBoundarySideEffectInterfaces.length
        ? [`- 有副作用的生成/写入入口（本轮不得调用）：${interfaceDataBoundarySideEffectInterfaces.join('；')}。`]
        : []),
      ...(interfaceDataBoundaryOtherInterfaces.length
        ? [`- 其它已核接口入口：${interfaceDataBoundaryOtherInterfaces.join('；')}；只按本轮既有请求留证。`]
        : []),
      ...interfaceDataBoundaryDataFacts.map(fact => `- 数据与选择条件：${fact}`),
      ...(interfaceDataBoundaryChecklistFact
        ? [`- route 已核只读日志/记录锚点：${interfaceDataBoundaryChecklistFact}`]
        : []),
    ].join('\n') : '';
    // 实施兜底最多保留一条已核研发事实：优先能帮助定位入口的接口事实，
    // 再选技术 token 最少的一条。这样既不丢掉单接口诊断题的必要路径，
    // 也不会把整张 route 的字段/调用链搬进“研发参考”造成技术倾倒。
    const confirmedTechnicalReference = confirmedTechnicalFacts
      .slice()
      .sort((left, right) => {
        const leftHasPath = concreteInterfaceRe.test(left) ? 1 : 0;
        const rightHasPath = concreteInterfaceRe.test(right) ? 1 : 0;
        return rightHasPath - leftHasPath
          || consultScopeTechnicalTokens(left).length - consultScopeTechnicalTokens(right).length;
      })
      .find(fact => consultScopeTechnicalTokens(fact).length <= 8) || '';
    // 上一层已核、下一步继续排查时，普通实施正文仍只保留业务基线；
    // 但当前 route 的直接入口/相邻状态边界不能因技术句被清洗而消失。
    // 将同一 route 的少量直接技术事实集中放在“研发参考”末尾，既可供
    // 实施按已核入口核对，也不会把源码细节散落在只读步骤首屏。
    const layeredDiagnosticQuestion = continuationDiagnosticQuestion
      || dataReturnedNotRenderedQuestion
      || requestResultMismatchQuestion
      || multiStepTransactionDiagnosticQuestion
      || retryBoundaryChecklistQuestion
      || uiAuthorizationProofQuestion;
    const layeredDiagnosticTechnicalReferences = layeredDiagnosticQuestion
      ? confirmedTechnicalFacts.filter(fact => concreteInterfaceRe.test(fact)
        || (/(?:状态|边界|另一组|另一套|不同|分别|不能|不得)/iu.test(fact)
          && /(?:状态|通过|失败|超时|正常|异常|=)/iu.test(fact))).slice(0, 3)
      : [];
    const audienceReferenceFacts = (multiStageSideEffectDiagnosticQuestion || stageAwareImplementationChecklist || staticClientDiagnosticQuestion)
      ? []
      : (layeredDiagnosticTechnicalReferences.length
        ? layeredDiagnosticTechnicalReferences
        : (confirmedTechnicalReference ? [confirmedTechnicalReference] : []));
    const audienceReferenceBlock = audienceReferenceFacts.length
      ? ['研发参考', ...audienceReferenceFacts.map(fact => `- ${fact}`)].join('\n') : '';
    const handoffRequested = /(?:交给谁|谁继续|转给谁|交由谁|由谁继续|谁负责)/u.test(intentQuestionText);
    const verifiedHandoffRole = handoffRequested
      ? currentRouteFacts
        .filter(fact => !/(?:不得|不能|无法|待确认|NEEDS-HUMAN|需由[^。！？；\n]{0,24}确认)/iu.test(String(fact || '')))
        .map(fact => String(fact || '').match(/(?:产品负责人|研发负责人|接口负责人|运维|业务负责人)/u)?.[0] || '')
        .find(Boolean) || ''
      : '';
    const handoffBlock = handoffRequested
      ? (verifiedHandoffRole
        ? `后续交接：将本轮只读证据交给已核实的${verifiedHandoffRole}继续确认；本轮不做写操作。`
        : '后续交接：将本轮只读证据交给对应功能的产品负责人和研发/接口负责人继续确认；本轮不做写操作，也不指定具体人名或组织。')
      : '';
    const safeSteps = singleStepQuestion
      ? ['1. 先只读对照一份已有页面原文与同一次已有请求/响应原文；没有既有请求时只记录“未取得请求证据”，不要为抓包重复未知业务操作。']
      : [
          '1. 原样记录当前页面、终端、账号角色、版本、发生时间和复现前后条件。',
          '2. 只查看这次已经发生的请求与响应，保留完整 URL、请求参数、HTTP/业务码和响应原文；不要为抓包重复未知业务操作。',
          '3. 按“没有请求 / 请求失败 / 响应正常但页面不一致”三种观测结果分开记录，不把未核原因写成结论。',
          '4. 整理上述原文与脱敏截图；拿不到的项明确标成缺失，不用找 spec 代替现场证据。',
        ];
    const interfaceDataBoundarySteps = verifiedInterfaceDataBoundaryDiagnosticQuestion
      ? [
          '1. 页面与范围：先只读记录当前页面、筛选或查询条件、账号角色及院区/机构或权限范围；只固定本次已经出现的页面现象。',
          '2. 同一次请求与响应：只查看同一次已经发生的请求和响应，保留请求参数、HTTP/业务码、响应原文、请求标识和发生时间；不要为抓包新增、编辑、删除或重做业务动作。',
          '3. 服务端与业务记录：能取得时，只读对照同一请求标识对应的服务端日志和已有业务记录、流水或状态；取不到时明确标为缺失，不用推测补齐。',
          '4. 页面呈现与权限边界：把响应和已有业务记录与页面列表、结果或展示逐项对照，同时区分页面可见/禁用与服务端权限校验；只记录差异，不把页面表现直接当成接口授权结论。',
          '5. 证据分支：按“没有请求 / 请求失败 / 响应正常但业务记录或页面呈现不一致”分开留证；每个分支只补会改变判断的最少原文、时间、账号范围和脱敏截图。',
        ]
      : safeSteps;
    const continuationStepBodies = [
      '先沿用第一层“无异常”的范围，只读核对同一组已选对象的页面选择、对象标识、当前状态与本次已经发生的请求/响应；不重新点击或提交。',
      '再只读对照已经发生的当前操作请求与返回：核对请求是否到达、是否仍是同一组对象、HTTP/业务码和响应原文；按当前 route 已核入口与相邻但不同的状态接口分别核对，不调用未被本次操作证明的接口。',
      '继续核对已有结果与页面刷新：逐条对照业务状态/流水、列表和摘要是否与响应一致；只记录观测，不把差异直接归因。',
      '按“没有当前操作请求 / 请求失败或业务码异常 / 响应正常但结果或列表不一致”分支留证，保留请求标识、对象标识、发生时间及原始响应；拿不到的日志或状态明确标成缺失。',
    ];
    const routeContinuationStepBodies = routeReadOnlySequenceSteps.map(step =>
      `${String(step.displayText || step.text || '').replace(/[。！？]+$/u, '')}。`);
    const continuationSteps = continuationDiagnosticQuestion
      ? [...routeContinuationStepBodies, ...continuationStepBodies]
        .map((step, index) => `${index + 1}. ${step}`)
      : safeSteps;
    const compactImplementationChecklistSteps = compactRouteChecklistFacts && implementationChecklistQuestion
      ? [...routeContinuationStepBodies, ...safeSteps.slice(2).map(step => step.replace(/^\d+\.\s*/u, ''))]
        .map((step, index) => `${index + 1}. ${step}`)
      : safeSteps;
    const staticClientContinuationSteps = staticClientDiagnosticQuestion
      ? [
          '1. 入口与标签页：只读对照本次已有观测，确认内置页从现有入口在浏览器新标签页打开，原审核页面保持不变，并记录页面版本与发生时间。',
          '2. 输入与必填：只读对照本次已有输入和必填状态；缺项时应在结果区出现已核的必填提示，只记录实际文字，不补造原因。',
          '3. 计算结果：只读记录当前公式、已有输入范围、结果区内容和单位，并按同一页面前后观测判断结果是否稳定；不录入真实患者敏感数据补测。',
          '4. 重置：只读对照本次已有重置前后页面，确认输入控件与结果区是否恢复到已核初始说明；没有既有观测时只标缺失。',
          '5. 浏览器控制台与静态资源：只查看本次已经出现的控制台报错和静态资源加载结果，保留资源名称、状态、时间和脱敏截图，不刷新或重做业务动作补证据。',
          '6. 不适用项：这条浏览器内静态计算链到上述观测为止，不再扩展到其它系统排查；未取得的页面或资源证据单独标为待确认。',
        ]
      : safeSteps;
    const dataNotRenderedEvidenceItems = dataReturnedNotRenderedQuestion
      ? [
          '页面上下文：记录页面、筛选条件、账号角色、院区/科室、页面路由、对象范围、发生时间、版本和请求标识；只固定本次已经出现的页面现象。',
          '同一次请求：只查看同一次已经发生的请求与响应，保留 URL、请求参数、HTTP/业务码和响应原文。接口返回有数据只证明该次响应携带内容，不代表页面在当前身份、作用域和路由下一定应展示。',
          routeHasClientSessionScope
            ? '会话作用域：只读对照本次已有的 token scope、Cookie 和用户信息缓存观测，记录是否存在、所属账号与院区并脱敏；不重新登录，不清理 Cookie 或缓存补证据。'
            : '',
          '页面呈现：只读对照响应对象与页面筛选、页面路由、渲染结果和浏览器控制台的已有报错；只记录差异，不把“响应有数据但页面未呈现”直接归因。',
          `交接边界：按同一请求标识汇总请求原文、页面现象、脱敏截图、时间和版本；拿不到的项标为缺失。本轮不重复提交，不修改数据，不试越权${routeHasMultiDeviceSession ? '，不关闭旧设备或其他设备' : ''}${routeHasClientSessionScope ? '，不清理 Cookie 或缓存补证据' : ''}。`,
        ].filter(Boolean)
      : [];
    const dataNotRenderedSteps = dataReturnedNotRenderedQuestion
      ? dataNotRenderedEvidenceItems.map((item, index) => `${index + 1}. ${item}`)
      : safeSteps;
    const resultMismatchSteps = requestResultMismatchQuestion
      ? [
          '1. 先对照这次已经发生的请求与响应：请求参数、对象范围、HTTP/业务码和响应原文；不重新提交或改变业务数据。',
          '2. 再对照响应对应的业务状态和已有流水，确认状态、结果字段及记录时间是否与本次响应一致；未取得的下游记录明确标成缺失。',
          '3. 然后只读核对页面刷新、列表/摘要与已有状态记录是否一致；不要把“请求成功”直接等同于业务结果正确。',
          '4. 按“请求失败 / 响应正常但业务状态或流水未变 / 状态已变但页面或摘要未同步 / 命中相邻状态入口边界”分支留证，记录观测和原始响应，不据此写死具体故障原因。',
        ]
      : safeSteps;
    const compactResultMismatchSteps = compactRouteChecklistFacts && requestResultMismatchQuestion
      ? [...routeContinuationStepBodies, ...resultMismatchSteps.slice(1).map(step => step.replace(/^\d+\.\s*/u, ''))]
        .map((step, index) => `${index + 1}. ${step}`)
      : resultMismatchSteps;
    const authorizationProofSteps = uiAuthorizationProofQuestion
      ? [
          '1. 页面层：只读记录当前账号、院区/科室、筛选条件、哪些对象不可选及对应提示；这只能说明当前页面限制生效，不能单独证明服务端授权安全。',
          '2. 请求层：只查看同一次已经发生的批量操作请求与响应，核对对象标识、请求参数、HTTP/业务码和响应原文；没有既有请求时只记录缺失，不为验证权限重新点击、提交或拼入其他对象。',
          '3. 服务端授权层：按当前已核规则，只读核对后台处理是否逐项校验登录人归属、授权院区/科室（病区）和操作前状态；把代码规则与本次既有请求涉及的对象范围逐项对照。',
          '4. 留痕层：只读核对同一对象已有的操作前后任务状态、审核流水和记录时间；按“请求被拒绝 / 请求成功但归属或状态校验缺失 / 已有状态或流水与响应不一致”分支记录，不在生产用真实业务对象试越权。',
        ]
      : safeSteps;
    const multiStageSideEffectSteps = multiStageSideEffectDiagnosticQuestion
      ? [
          '1. 逐个对象核对主状态：只读记录每个任务或业务对象的当前状态、对象标识和更新时间，不用页面报错或 HTTP 结果代替真实状态。',
          '2. 接着核对审核流水：按同一对象查看流水数量、操作时间、操作人和结果，标出“主状态已变但流水缺失”或“流水重复”等实际差异。',
          '3. 再核对 Redis 超时键或任务键：只读记录对应键仍存在、已清理或未取得证据；不做清理或补写，也不把单个键清理的幂等性等同于整次业务操作幂等。',
          '4. 然后核对医生消息或通知记录：查看同一对象已有的消息请求、响应和记录，只记录缺失、失败或重复，不补发消息。',
          '5. 最后核对 HIS 或其它外部回调日志与结果，并把五层结果按同一对象和时间线汇总；全程不写入业务数据、不重放消息或回调，也不因页面或请求报错盲目整批重试。',
        ]
      : safeSteps;
    const diagnosticSteps = staticClientDiagnosticQuestion
      ? staticClientContinuationSteps
      : verifiedInterfaceDataBoundaryDiagnosticQuestion
        ? interfaceDataBoundarySteps
      : continuationDiagnosticQuestion
        ? continuationSteps
      : dataReturnedNotRenderedQuestion
        ? dataNotRenderedSteps
        : requestResultMismatchQuestion
          ? compactResultMismatchSteps
          : multiStageSideEffectDiagnosticQuestion
            ? multiStageSideEffectSteps
            : uiAuthorizationProofQuestion
              ? authorizationProofSteps
              : implementationChecklistQuestion
                ? compactRouteChecklistFacts
                  ? compactImplementationChecklistSteps
                  : [
                    '1. 原样记录当前页面、筛选条件、账号角色、版本、发生时间和复现前后条件。',
                    '2. 只查看这次已经发生的请求与响应，保留完整 URL、请求参数、HTTP/业务码和响应原文；不为抓包重复未知业务操作。',
                    '3. 按“没有请求 / 请求失败 / 响应正常但页面或业务结果不一致”三种观测结果分开记录，不把未核原因写成结论。',
                    '4. 整理上述原文与脱敏截图；拿不到的项明确标成缺失，不用找 spec 代替现场证据。',
                  ]
                : safeSteps;
    const diagnosticStepsHeading = staticClientDiagnosticQuestion
      ? '静态页下一层只读排查顺序：'
      : verifiedInterfaceDataBoundaryDiagnosticQuestion
        ? '接口、数据与边界的分层只读排查顺序：'
      : continuationDiagnosticQuestion
        ? '下一层只读排查顺序：'
      : dataReturnedNotRenderedQuestion
        ? '转开发前最小只读证据顺序：'
        : requestResultMismatchQuestion
          ? '分层只读对照顺序：'
          : multiStageSideEffectDiagnosticQuestion
            ? '多步结果的逐对象只读核对顺序：'
            : uiAuthorizationProofQuestion
              ? '权限安全的分层只读核对顺序：'
              : implementationChecklistQuestion
                ? compactRouteChecklistFacts ? '实施逐项只读清单：' : '最小只读排查：'
                : '最小只读排查：';
    if (evidenceSufficiencyQuestion) {
      const mentionsScreenshot = /(?:截图|图片|附图|这张图|图里)/u.test(questionText);
      // “请求时间/发生时间”是通用留证字段，不等于用户在核对日期、星期或时区。
      // 只有明确的日历/时区主题才追加本机日期星期，避免把 HIS 接入排查带偏。
      const timeEvidenceTopic = /(?:今天|日期|星期|时区|today)/iu.test(`${questionText}\n${currentRouteFacts.join('\n')}`);
      const responseFacts = currentRouteFacts.filter(fact => /(?:响应|返回|包含|字段|状态码|业务码)/u.test(fact)).slice(0, 2);
      const verdict = mentionsScreenshot
        ? '结论：这张截图只够固定当前页面现象，不能单独完成与已核规则的对照，也不足以闭环原因。'
        : '结论：现有受限证据只够固定已经提供的观测点，不能单独完成与已核规则的对照，也不足以闭环原因。';
      const attachmentBoundary = mentionsScreenshot
        ? '若本轮实际没有上传可核验附件，只能按你文字描述的“有一张截图”处理，不能声称看见图内数字或内容。'
        : '';
      const minimumEvidenceSteps = [];
      if (minimumRoutePath) {
        minimumEvidenceSteps.push(`1. 最少再补同一次或已有的 ${minimumRoutePath.display} 完整响应；若该页面刷新已确认只读，也可以使用一次只读刷新产生的响应。`);
      } else {
        minimumEvidenceSteps.push('1. 最少再补一份能直接核对当前已知事实的同一次已有请求/响应原文；没有既有证据时只记录缺失，不为抓包重复未知业务操作。');
      }
      if (responseFacts.length) minimumEvidenceSteps.push(`2. 响应内容只按当前已核事实核对：${responseFacts.join('；')}。`);
      if (timeEvidenceTopic) {
        minimumEvidenceSteps.push(`${minimumEvidenceSteps.length + 1}. 同时记录同一时刻本机显示的日期和星期，再与页面现象、接口响应做三边只读对照；这一步不必先拿服务器日志。`);
      } else {
        minimumEvidenceSteps.push(`${minimumEvidenceSteps.length + 1}. 把这份响应与同一时刻的页面现象逐字对照；这一步不必先拿服务器日志。`);
      }
      // 确定性实施兜底只保留业务事实、最小只读取证步骤和至多一条
      // 必要研发参考，避免把路由事实整段搬运后触发 audience_technical_dump。
      safeDiagnosticFallback = [verdict, attachmentBoundary, knownBlock, interfaceDataBoundaryRouteBlock, '最小缺口：', ...minimumEvidenceSteps, handoffBlock, audienceReferenceBlock].filter(Boolean).join('\n\n');
    } else {
      // 同上：安全兜底不扩写未经本轮问句要求的接口/字段/调用链。
      const diagnosticVerdict = uiAuthorizationProofQuestion
        ? '结论：页面控件不可操作只能证明当前页面限制生效，不能单独证明服务端授权安全。'
        : '';
      const routeReadOnlyBoundaryBlock = routeReadOnlySequenceBoundary
        ? `只读边界：${routeReadOnlySequenceBoundary}` : '';
      safeDiagnosticFallback = [diagnosticVerdict, checklistStageBlock, knownBlock, interfaceDataBoundaryRouteBlock, diagnosticStepsHeading, ...diagnosticSteps, routeReadOnlyBoundaryBlock, handoffBlock, audienceReferenceBlock].filter(Boolean).join('\n\n');
    }
  }
  if (explicitOperationEvidenceMissing) safeDiagnosticFallback = operationEvidenceStopReply;
  const violations = [];
  if (explicitOperationEvidenceMissing && text && !verifiedOperationEvidenceStop) violations.push('missing_explicit_operation_evidence');
  if (unsupportedExplicitOperationParts.length) violations.push('unsupported_explicit_operation');
  if (likelihoodTerms.length || causalPriorityTerms.length) violations.push('unsupported_likelihood');
  if (contradictoryObservationOrderClaims.length) violations.push('contradictory_observation_order');
  if (unsupportedComponentClaims.length) violations.push('unsupported_component_fault');
  if (unsupportedEvidenceNegations.length) violations.push('unsupported_evidence_negation');
  if (unsupportedEvidenceAbsenceClaims.length) violations.push('unsupported_evidence_absence');
  if (productTechnicalParts.length) violations.push('audience_technical_overreach');
  if (implementationMisplacedTechnicalParts.length) violations.push('audience_technical_not_last');
  if (implementationTechnicalFirstParts.length) violations.push('audience_technical_first');
  if (missingRequestedInterfaces.length) violations.push('missing_requested_interfaces');
  if (missingChainDimensions.length) violations.push('incomplete_requested_chain');
  if (uniqueChainTechnicalDetailParts.length) violations.push('audience_technical_dump');
  if (unsafeActorActions.length || unsafeDirectActions.length) violations.push('cross_actor_side_effect');
  if (ambiguousAsBuiltSystemActionParts.length) violations.push('ambiguous_as_built_action');
  if (staticClientScopeOverreach.length) violations.push('static_route_scope_overreach');
  if (unexpectedPaths.length) violations.push('unexpected_concrete_path');
  if (unexpectedScopeTerms.length) violations.push('out_of_scope_entity');
  if (missingPrimaryPath) violations.push('missing_primary_path');
  if (focusedFactOverreach.length || missingFocusedMustNotConfuse.length) violations.push('focused_fact_overreach');
  if (missingFocusedRelationshipFacts.length) violations.push('focused_fact_incomplete');
  if (undefinedOrdinalReferences.length) violations.push('undefined_ordinal_reference');
  if (undefinedSymbolicComparisons.length) violations.push('undefined_symbolic_comparison');
  if (undefinedArabicStepReferences.length) violations.push('undefined_arabic_step_reference');
  if (optionCardinalityMismatches.length) violations.push('incomplete_option_set');
  if (nonSequentialOptionSets.length) violations.push('nonsequential_option_labels');
  if (undefinedGroupReferences.length) violations.push('undefined_symbol_group_reference');
  if (selfReferentialStepReferences.length) violations.push('self_referential_step_reference');
  if (nonSequentialTopLevelSteps.length) violations.push('nonsequential_top_level_steps');
  if (emptyNumberedSections.length) violations.push('empty_numbered_section');
  if (!hasEvidenceSufficiencyVerdict) violations.push('missing_evidence_sufficiency_verdict');
  if (missingEvidenceMinimumPath) violations.push('missing_evidence_minimum_route_fact');
  if (undefinedObservationVariables) violations.push('undefined_observation_variable');
  if (!diagnosticSequenceComplete) violations.push('incomplete_diagnostic_sequence');
  // 一个 route 只有单条业务事实、而问句同时点名接口/数据/边界时，
  // 只复述该事实仍是不完整回答。让确定性 fallback 补上“本轮未知”边界；
  // 不要求模型臆造缺失的技术细节。
  if (fallbackAnswerMode === 'facts_with_unknowns' && missingRouteFactDimensions.length) {
    const hasUnknownBoundary = /(?:本轮|当前)(?:仍)?(?:未确认|未知|无法确认|不能确认)|(?:资料|证据)不足[^。！？\n]{0,24}(?:补写|确认)/u.test(text);
    if (!hasUnknownBoundary) violations.push('incomplete_verified_facts');
  }
  if (missingVerifiedFactCoverage.length && !violations.includes('incomplete_verified_facts')) violations.push('incomplete_verified_facts');
  if (missingDataNotRenderedBoundaryGroups.length && !violations.includes('incomplete_verified_facts')) violations.push('incomplete_verified_facts');
  if (missingExistingRecordNarrowing.length && !violations.includes('incomplete_verified_facts')) violations.push('incomplete_verified_facts');
  if (missingRouteReadOnlySequenceSteps.length && !violations.includes('incomplete_verified_facts')) violations.push('incomplete_verified_facts');
  if (missingImplementationFactCoverage.length && !violations.includes('incomplete_verified_facts')) violations.push('incomplete_verified_facts');
  if (missingFailureBranchCoverage.length && !violations.includes('incomplete_verified_facts')) violations.push('incomplete_verified_facts');
  if ((missingChecklistStageLabels.length || missingChecklistRouteLabels.length)
    && !violations.includes('incomplete_verified_facts')) violations.push('incomplete_verified_facts');
  if (cardinalityMismatches.length) violations.push('inconsistent_structured_cardinality');
  if (incompleteResultBranchTables.length) violations.push('incomplete_result_branch_set');
  if (conflictingCountDeclarations.length) violations.push('conflicting_count_declaration');
  if (incompleteLeadIns.length) violations.push('incomplete_structured_lead_in');
  if (emptyDiagnosticBranchHeadings.length) violations.push('empty_diagnostic_branch');
  if (emptyListStepItems.length) violations.push('empty_list_step_item');
  if (danglingClosingPunctuationLines.length) violations.push('dangling_closing_punctuation');
  if (orphanedAlternativeLines.length) violations.push('orphaned_alternative_fragment');
  if (danglingAlternativeLines.length) violations.push('dangling_alternative_fragment');
  if (orphanedContrastLines.length) violations.push('orphaned_contrast_fragment');
  if (incompletePairedBranches.length) violations.push('incomplete_paired_branch');
  if (contradictoryNegativeSections.length) violations.push('contradictory_negative_section');
  if (singleStepOverreach) violations.push('single_step_diagnostic_overreach');
  if (malformedMarkdown.length) violations.push('malformed_markdown');
  // verifiedFacts fallback 的终稿只允许由固定标题和 current route 原句组成。
  // 这些原句本身已经过 Spec 审核，其中“重复主键可失败”“未经授权不得重放”
  // 是已核边界，不应再次被概率词/副作用启发式误杀。只在整份正文逐行精确
  // 等于全部 route facts 时放行；任何模型新增句仍走原来的严格审计。
  const verifiedFactLines = documentLines.map(line => line
    .replace(/^\s*[-*+]\s+/u, '').trim())
    .filter(line => line && line !== '业务结论' && line !== '实施口径');
  let routeFactLineIndexes = new Set();
  let verifiedMatchedRouteFacts = [];
  // 除 route 原句外，只额外接受由 normalizeNonWritingRouteFact 从同一原句
  // 确定性生成的非写操作表述。这样“系统自动只读调用”的安全改写仍可
  // 逐行追溯；模型自行改写或新增一句不会命中该候选集合。
  const verifiedRouteFactCandidates = [currentRouteFacts];
  if (nonWritingRouteFacts.some((fact, index) => fact !== currentRouteFacts[index])) verifiedRouteFactCandidates.push(nonWritingRouteFacts);
  let routeFactsAppearExactly = false;
  if (verifiedFactsFallback) {
    for (const candidateFacts of verifiedRouteFactCandidates) {
      if (!candidateFacts.length) continue;
      const candidateIndexes = new Set();
      let routeFactCursor = 0;
      let candidateMatches = true;
      for (const fact of candidateFacts) {
        const index = verifiedFactLines.findIndex((line, lineIndex) => lineIndex >= routeFactCursor && line === fact);
        if (index < 0) { candidateMatches = false; break; }
        candidateIndexes.add(index); routeFactCursor = index + 1;
      }
      if (!candidateMatches) continue;
      routeFactsAppearExactly = true;
      verifiedMatchedRouteFacts = candidateFacts;
      routeFactLineIndexes = candidateIndexes;
      break;
    }
  }
  const verifiedFallbackExtraLines = routeFactsAppearExactly
    ? verifiedFactLines.filter((line, index) => !routeFactLineIndexes.has(index))
    : [];
  const verifiedFallbackExtraLinesSafe = verifiedFallbackExtraLines.every(line =>
    /^(?:结论：现有受限证据|结论：这张截图|业务结论|实施口径|本轮未知(?:：|$)|当前只有上述已核事实)/u.test(line)
  );
  const verifiedFactsOnlyAnswer = verifiedFactsFallback
    && routeFactsAppearExactly
    && verifiedFallbackExtraLinesSafe
    && (
      verifiedFactLines.length === verifiedMatchedRouteFacts.length
      || fallbackAnswerMode === 'partial_evidence'
      || fallbackAnswerMode === 'facts_with_unknowns'
    )
    && (fallbackAnswerMode !== 'partial_evidence' || /本轮未知/u.test(text))
    && (fallbackAnswerMode !== 'partial_evidence' || /(?:现有受限证据|只能确认|不能单独)/u.test(text));
  if (verifiedFactsOnlyAnswer) {
    const verifiedRouteHasEvidenceVerdict = currentRouteFacts.some(fact =>
      /(?:只够|足够|够(?:用|判断|固定|完成)|不够|不足|不能单独|不能替代|尚不能|只能固定|只能证明|只能确认|最多(?:只能|能|可))/u.test(fact)
    );
    const permittedViolations = [
      'unsupported_likelihood',
      'cross_actor_side_effect',
      'unsupported_explicit_operation',
      // “产品 + 实施口径”混合问法可能同时包含已核状态值和只读核对项。
      // verifiedFacts 终稿已严格等于路由全部原句，不能再因通用实施排版门
      // 要求技术内容只出现在末段或强制 2~4 个编号步骤而退成机械拒答。
      'audience_technical_not_last',
      // 产品与实施混合题的 route 原句可包含 Redis、Mapper、INSERT 等
      // 已核实施边界；逐行精确匹配时不得再按普通产品草稿判为技术越界。
      'audience_technical_overreach',
      'audience_technical_dump',
      'nonsequential_top_level_steps',
    ];
    // verifiedFacts 终稿逐行等于人工审核过的路由事实时，允许先给总业务结论、
    // 再在后续事实中回答截图/现有证据够什么和不够什么；不能因此退成通用模板。
    if (evidenceSufficiencyQuestion && verifiedRouteHasEvidenceVerdict) permittedViolations.push('missing_evidence_sufficiency_verdict');
    for (const permitted of permittedViolations) {
      const index = violations.indexOf(permitted);
      if (index >= 0) violations.splice(index, 1);
    }
  }
  // partial-evidence 的确定性终稿会从长 route 中选取少量已核事实，再加
  // 固定的观测/未知/只读边界。普通 audience dump 审计不认识这种来源，
  // 会把可追溯的“研发参考”再次拦掉。这里只对每一行都能追溯到当前
  // route 或固定安全模板的终稿放行技术倾倒；模型新增的任意一句仍失败。
  const partialEvidenceFallbackLines = documentLines.map(line => line
    .replace(/^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s*)/u, '').trim()).filter(Boolean);
  const partialEvidenceFixedLines = new Set([
    '业务结论',
    '研发参考',
    '已有记录只读缩小顺序',
    '本轮未知',
    '结论：现有受限证据只够固定已经提供的观测，不能单独完成与已核规则的对照，也不足以闭环原因。',
    '结论：当前只能确认前端已经发出请求；这不等于服务端已经接收或完成后续处理。',
    '最少补证（只读）：保留同一次已经发生的请求及完整响应原文；若请求原文拿不到，提供对应已有记录中的对象标识、状态和时间用于对照，不重复提交。',
    '只读证据边界：保留这次已经发生的请求方法、完整路径、参数、响应、请求标识和时间，再按同一标识只读对照服务端日志、业务记录与后续状态。',
    '本轮只读边界：不改数据、不重放消息、不重提任务；只核对已有请求、响应和记录。',
    '本轮只读边界：不改数据、不重复提交、不重试；只核对已有请求、响应、日志和记录。',
    '服务端处理结果、对应日志和后续业务状态均未取得，当前未知；不能由前端请求外推。',
  ]);
  const normalizePartialEvidenceSequenceLine = value => String(value || '')
    .replace(/[。！？\s]+$/gu, '').replace(/[\s，,。；;：:]/gu, '');
  const partialEvidenceSequenceLine = line => Array.isArray(routeReadOnlySequenceSteps)
    && routeReadOnlySequenceSteps.some(step => normalizePartialEvidenceSequenceLine(step.displayText || step.text)
      === normalizePartialEvidenceSequenceLine(line));
  const partialEvidenceGenericUnknownRe = /^(?:接口|数据|后续状态)(?:、(?:接口|数据|后续状态))*的具体细节待补充；本轮回答仅依据上述已核事实。$/u;
  const verifiedPartialEvidenceFallback = verifiedFactsFallback
    && fallbackAnswerMode === 'partial_evidence'
    && partialEvidenceFallbackLines.some(line => nonWritingRouteFacts.includes(line) || partialEvidenceSequenceLine(line))
    && partialEvidenceFallbackLines.every(line => nonWritingRouteFacts.includes(line)
      || partialEvidenceFixedLines.has(line) || partialEvidenceSequenceLine(line) || partialEvidenceGenericUnknownRe.test(line))
    && /本轮未知/u.test(text)
    && /(?:现有受限证据|只能确认前端已经发出请求|这张截图只够固定)/u.test(text);
  if (verifiedPartialEvidenceFallback) {
    const technicalDumpIndex = violations.indexOf('audience_technical_dump');
    if (technicalDumpIndex >= 0) violations.splice(technicalDumpIndex, 1);
  }
  // 分阶段实施清单会把 current route 的完整已核事实放在通用只读步骤前，
  // 因而会被普通实施受众规则误报为“技术内容不在末尾/技术倾倒”。只有
  // 正文逐字等于本轮审计生成的确定性清单时才放行这两项；模型自行扩写
  // 或遗漏任何阶段、route 标签时都不满足等值条件。
  const verifiedStageChecklistFallback = verifiedFactsFallback
    && stageAwareImplementationChecklist
    && String(safeDiagnosticFallback || '').trim()
    && String(text || '').trim() === consultNormalizeSafeMarkdown(String(safeDiagnosticFallback).trim()).trim();
  if (verifiedStageChecklistFallback) {
    for (const permitted of ['audience_technical_not_last', 'audience_technical_dump']) {
      const index = violations.indexOf(permitted);
      if (index >= 0) violations.splice(index, 1);
    }
  }
  // 链路型 verifiedFacts 兜底由 safeChainFallback 依据 route 原句确定性生成。
  // 链路题本来就要求保留入口、接口、数据和外部依赖，审计器在解析这些
  // 已核技术事实时会产生 audience_technical_dump；仅当正文逐字等于该
  // 确定性模板时放行这一项，模型自行拼接的技术堆叠仍按原规则拦截。
  const verifiedChainFallback = verifiedFactsFallback
    && fallbackAnswerMode === 'chain'
    && String(safeChainFallback || '').trim()
    && String(text || '').trim() === consultNormalizeSafeMarkdown(String(safeChainFallback).trim()).trim();
  if (verifiedChainFallback) {
    const technicalDumpIndex = violations.indexOf('audience_technical_dump');
    if (technicalDumpIndex >= 0) violations.splice(technicalDumpIndex, 1);
    // safeChainFallback 是由 route.answerFacts 确定性生成的，但其中的“删除/插入”
    // 等现状描述仍会被通用动作门识别。只有当每个命中动作门的完整片段都能
    // 在本轮 safe fallback 与 current route answerFacts 中逐字找到时才放行；
    // 模型额外写出的“建议删除/重新提交”等动作不满足该条件，继续拦截。
    const chainFallbackText = String(safeChainFallback || '').trim();
    const routeFactTraceText = value => String(value || '')
      .replace(/^\s*(?:业务结论|产品|入口|接口|任务和警示|外部依赖|生成记录|停止|前端证据边界|实施只读清单|实施只读核对|端到端边界|数据与状态|留痕|当前停点|影响|实施|时间|约束|排班|结果|边界|当前页面|后端边界|统一入口|接入入口与主接口|多任务|权重)\s*[：:]\s*/u, '')
      .trim();
    const chainFallbackStatementIsRouteFact = statement => {
      const body = String(statement || '')
        .replace(/^\s*(?:[-*+]\s+)?(?:[^：:\n]{1,24})\s*[：:]\s*/u, '')
        .replace(/[。！？；;\s]+$/gu, '')
        .trim();
      if (!body) return false;
      const normalizedBody = normalizeRouteActionText(body);
      return normalizedBody.length >= 8 && currentRouteFacts.some(fact =>
        normalizeRouteActionText(routeFactTraceText(fact)).includes(normalizedBody));
    };
    // 确定性 safeChain 可能逐字发布 route 的否定边界（如“不可见不等于
    // 后端一定拒绝”）。通用概率门只看到“一定”会误判；仅当全部命中句
    // 都能逐句回溯到 current route 时放行，模型自行新增的概率/因果仍拦。
    const chainFallbackLikelihoodStatements = [
      ...unsupportedLikelihoodClaims,
      ...unsupportedCausalLocalizationClaims,
      ...unsupportedDeterministicFailureClaims,
    ];
    if (chainFallbackLikelihoodStatements.length
      && chainFallbackLikelihoodStatements.every(chainFallbackStatementIsRouteFact)) {
      const likelihoodIndex = violations.indexOf('unsupported_likelihood');
      if (likelihoodIndex >= 0) violations.splice(likelihoodIndex, 1);
    }
    // 不能让 every([]) 绕过动作门：任一检测器命中动作时，所有直接动作和
    // 角色动作片段都必须同时能追溯到确定性 route 兜底和本轮 route 事实。
    const chainFallbackActionStatements = [...unsafeDirectActions, ...unsafeActorActions];
    const chainFallbackActionsAreRouteFacts = chainFallbackActionStatements.length > 0
      && chainFallbackActionStatements.every(statement => {
        const line = String(statement || '').trim();
        const body = line.replace(/^\s*(?:[-*+]\s+)?(?:[^：:\n]{1,24})\s*[：:]\s*/u, '').trim();
        const appearsInFallback = chainFallbackText.includes(line) || (body && chainFallbackText.includes(body));
        const appearsInRoute = currentRouteFacts.some(fact => {
          const routeText = routeFactTraceText(fact);
          return routeText && (routeText.includes(body) || body.includes(routeText));
        });
        return appearsInFallback && appearsInRoute;
      });
    if (chainFallbackActionsAreRouteFacts) {
      const actionIndex = violations.indexOf('cross_actor_side_effect');
      if (actionIndex >= 0) violations.splice(actionIndex, 1);
    }
  }
  return { checked: true, diagnosticQuestion, audienceMode, explicitOperationContracts, explicitOperationEvidenceMissing, verifiedOperationEvidenceStop, operationEvidenceStopReply, audienceTechnicalParts, productTechnicalParts, implementationMisplacedTechnicalParts, implementationTechnicalFirstParts, currentRouteFacts, nonWritingRouteFacts, ambiguousAsBuiltSystemActionParts, staticClientOnlyRoute, staticClientDiagnosticQuestion, staticClientScopeOverreach, staticClientDiagnosticComplete, dataNotRenderedRouteBoundaryGroups, missingDataNotRenderedBoundaryGroups, routeHasClientSessionScope, routeHasMultiDeviceSession, dataNotRenderedEvidenceComplete, existingRecordNarrowingQuestion, existingRecordNarrowingFact, existingRecordFilterDimensions, missingExistingRecordNarrowing, routeReadOnlySequenceQuestion, routeReadOnlySequenceFact, routeReadOnlySequenceBoundary, routeReadOnlySequenceSteps, missingRouteReadOnlySequenceSteps, routeFallbackMode: routeFallbackMode || '', verifiedFactsFallback, chainRequested, chainDimensions, chainKnownFactDimensions, chainEvidenceSufficient, chainStageLabels, chainKeyBusinessFacts, missingChainKeyBusinessFacts, missingRequestedInterfaces, missingChainDimensions, audienceTechnicalDumpParts: uniqueChainTechnicalDetailParts, safeChainFallback, evidenceSufficiencyQuestion, fullHandoffMaterialQuestion, broadEvidenceQuestion, partialEvidenceQuestion, frontendRequestOnlyEvidenceQuestion, partialEvidenceInventoryQuestion, broadFactQuestion, fieldDiagnosticQuestion, contextFollowupQuestion, explicitReviewDiagnosticQuestion, interfaceDataBoundaryDiagnosticQuestion, verifiedInterfaceDataBoundaryDiagnosticQuestion, interfaceDataBoundaryInterfaces, requiredInterfaceDataBoundarySignatures, missingInterfaceDataBoundarySignatures, interfaceDataBoundaryDataFacts, interfaceDataBoundaryChecklistFact, interfaceDataBoundaryChecklistItems, missingInterfaceDataBoundaryChecklistItems, interfaceDataBoundaryLayerIndexes, interfaceDataBoundaryRouteStructureComplete, interfaceDataBoundaryDiagnosticComplete, continuationDiagnosticQuestion, dataReturnedNotRenderedQuestion, implementationChecklistQuestion, stageAwareImplementationChecklist, checklistStageLabels, missingChecklistStageLabels, missingChecklistRouteLabels, requestResultMismatchQuestion, multiStepTransactionDiagnosticQuestion, retryBoundaryChecklistQuestion, retryRiskCoverageGroups, missingRetryRiskCoverage, retryRiskFactsComplete, multiStageSideEffectDiagnosticQuestion, multiStageDiagnosticLayersComplete, uiAuthorizationProofQuestion, minimalEvidenceQuestion, diagnosticSequenceQuestion, authorizationDiagnosticLayersComplete, diagnosticSequenceComplete, fallbackAnswerMode, factQuestionDimensions, missingRouteFactDimensions, verifiedFactCoverageQuestion, missingVerifiedFactCoverage, implementationFactCoverageQuestion, missingImplementationFactCoverage, implementationFactCoverageGroups, missingFailureBranchCoverage, hasEvidenceSufficiencyVerdict, minimumRoutePath, missingEvidenceMinimumPath, observationInputContract, undefinedObservationVariables, symbolicDefinitions: Object.fromEntries(symbolicDefinitions), undefinedSymbolicComparisons, focusedFactQuestion, focusedTypeOrLengthQuestion, focusedFactPrimaryPath, focusedMustNotConfuse, missingFocusedMustNotConfuse, focusedRelationshipFacts, missingFocusedRelationshipFacts, safeDiagnosticFallback, explicitNonDestructiveBoundaryQuestion, focusedTechnicalTokens, focusedTechnicalOverreach, likelihoodAllowed, likelihoodTerms, unsupportedLikelihoodClaims, unsupportedCausalLocalizationClaims, unsupportedDeterministicFailureClaims, contradictoryObservationOrderClaims, causalPriorityAllowed, causalPriorityTerms, unsupportedComponentClaims, unsupportedEvidenceNegations, unsupportedEvidenceAbsenceClaims, evidenceAbsenceCorrectionFacts, unsafeActorActionCount: unsafeActorActions.length, unsafeDirectActionCount: unsafeDirectActions.length, unexpectedPaths, unexpectedEntityTerms: unexpectedScopeTerms, unexpectedTechnicalTokens, requiredPrimaryPath, missingPrimaryPath, focusedFactOverreach, undefinedOrdinalReferences, undefinedArabicStepReferences, optionCardinalityMismatches, nonSequentialOptionSets, undefinedGroupReferences, selfReferentialStepReferences, topLevelExpectedStart, nonSequentialTopLevelSteps, emptyNumberedSections, cardinalityMismatches, incompleteResultBranchTables, conflictingCountDeclarations, incompleteLeadIns, emptyDiagnosticBranchHeadings, emptyListStepItems, danglingClosingPunctuationLines, orphanedAlternativeLines, danglingAlternativeLines, orphanedContrastLines, incompletePairedBranches, contradictoryNegativeSections, singleStepQuestion, singleStepOverreach, malformedMarkdown, violations };
}

function consultAnswerRevisionPrompt(draft, audit) {
  return [
    '【发布前确定性语义校验未通过：只允许修订一次】',
    '下面是尚未发送给用户的草稿。请只输出修订后的完整答案，不要解释修订过程，不要增加任何新业务事实、接口、字段、按钮、原因或示例。',
    audit.violations.includes('unsupported_likelihood')
      ? '草稿含无直接证据的概率、频率、比例或成因定性。删除整句中的“最高频/最常见/常见/经常/通常/一般/大概率/多半/往往/很可能/可能丢位/可能丢精度/多发/高发/很多/不少/多数/大多/绝大多数/少数/极少/大部分/小部分/几乎全部/频繁/偶尔/有时/首要原因/主要原因/典型原因/常见于/可能是/很像/更像/疑似/倾向于/最容易出现/很容易丢位或丢精度/更容易在某时段对不上”等定性，也删除无已核契约支持的“一定会/必然/肯定会/就会直接导致”“会出现少位/丢精度/对不上”“就是会丢位的写法”“就是某方传错或配置错”等确定因果整句。箭头、“所以/因此”、“属…问题”、“定位为…”同样是因果定论；不得把一个观测现象直接映射为多个打包候选根因或进程/网络/数据格式/数据库约束等确定归类；“日志无某记录”只说明未观察到该日志，不证明对应动作未发生。用户在电话或现场转述的“对接方说/医院说/怀疑/感觉/好像”不是已核因果证据，只能保留为待核线索。某个观测点已经出现差异，只能说明变化不晚于该观测点；没有逐层证据时，不得进一步写成“发生在上游/生成号/Excel/中间系统/传参/序列化/转换/网关/前后端/数据库等具体侧或环节”。若当前只在诊断一个字段或对象，只保留直接回答它所需的事实，不得借技术依据枚举同表其它未问字段。若本轮没有已观察到的页面、请求或响应差异，也删除“优先查服务端/前端/缓存/配置”等成因排序。原因只能改成不排序的“待验证假设/可能分支”，并明确需要查看对应的原始日志或异常堆栈才能定位。证据收集步骤仍可按只读顺序说明。'
      : '',
    audit.violations.includes('unsupported_component_fault')
      ? '草稿把用户或 route 尚未确认的组件故障写成了定论。逐句按“已核事实 / 本轮观察 / 待验证假设 / 安全动作”四类重写；前端、后端、服务端、缓存、网关、鉴权、权限、数据库、配置、调度、部署或环境等未核原因只能明确标成“待验证假设/可能分支”，条件分支、表格和小结也不能绕过。'
      : '',
    audit.violations.includes('unsupported_evidence_negation')
      ? `用户明确只有请求/响应等中间层证据，或没有数据库、日志、状态观测权限；草稿却把未观察到的下游事实写成否定：${(audit.unsupportedEvidenceNegations || []).join('；')}。删除这些完整自然句。系统按 current route/Spec 已确认的一般规则仍须保留，但“规则会写入/记录”不能推出本次已经成功，“本轮看不到”也不能反向写成未落库、不写日志、不涉及任务状态或没有后续处理；本次结果只能局部标为“现有证据无法确认/仍未知”。若 current route 正文明示某类记录确实不写，可逐字保留该已核否定规则。`
      : '',
    audit.violations.includes('unsupported_evidence_absence')
      ? `草稿把“本轮检索片段没有展示”错误升级成了“说明书/Spec 未写或只确认到这里”：${(audit.unsupportedEvidenceAbsenceClaims || []).join('；')}。删除这些完整自然句。资料缺失结论只有在 current route 的 answerFacts、mustNotConfuse 或本轮正文明确标为 NEEDS-HUMAN、未定义、未覆盖、未写明时才成立；检索截断、Top-N 未带到某行不能作为缺失证据。请恢复下列本轮正文已核事实，并只把本次实例是否按契约执行标为未知：${(audit.evidenceAbsenceCorrectionFacts || []).join('；') || '按本轮 current route 正文逐项恢复，不得自行补造'}。`
      : '',
    audit.violations.includes('audience_technical_overreach')
      ? `本轮是产品/业务问法，草稿主动展开了源码名、Java 类/方法、Controller/Service/Mapper/DTO/VO、表名、接口路径、字段、状态值或“研发参考/技术依据”，或用“资料/说明书未写、未确认”评价技术资料：${(audit.productTechnicalParts || []).join('；')}。删除这些完整句，用业务对象、适用场景、状态边界和用户影响重述；业务结论和对象范围答清后立即停止，不加“研发参考”，不评价其它范围的技术资料是否缺失。用户明确追问技术契约时下一轮再展开。`
      : '',
    audit.violations.includes('audience_technical_first') || audit.violations.includes('audience_technical_not_last')
      ? `本轮是实施问法，草稿用技术信息开场，或把类/方法/表/字段散落在正文：${(audit.audienceTechnicalParts || []).join('；')}。第一屏先改成大白话业务结论；现场排查用 2~4 个只读步骤，每步写清看什么和不同结果最多判断到哪。完成判断必需的实际请求路径可留在对应步骤，其它研发细节统一移到文末简短“研发参考”，不要删除已核事实。`
      : '',
    audit.violations.includes('missing_requested_interfaces')
      ? `用户显式点名了接口/API/路径，current route answerFacts 已确认的主签名不得遗漏。补齐下列 METHOD + path，逐字保留且每个只列一次：${(audit.missingRequestedInterfaces || []).map(item => item.display).join('；')}。只列方法+路径和必要业务用途，不借此展开全量入参/出参、Controller 或字段表。`
      : '',
    audit.violations.includes('incomplete_requested_chain')
      ? `用户要求把链路按点名维度串起来，草稿的同名标题不能代替正文。未完整覆盖：${(audit.missingChainDimensions || []).join('、')}。固定按“业务结论 → 入口 → 主接口 → 数据对象与状态 → 外部系统与边界 → 资料明确的未知停点”组织，但只输出本轮已有 route 事实。`
      : '',
    audit.violations.includes('audience_technical_dump')
      ? `草稿在用户未询问字段清单时连续枚举了大量 snake_case/camelCase 字段、入出参、Java 类或完整表结构：${(audit.audienceTechnicalDumpParts || []).join('；')}。删除该完整段落/表格。业务链优先；接口只列 METHOD + path，数据只列对象+关键状态，外部依赖只列系统+已核边界，技术信息最多收敛成文末简短“研发参考”。显式字段题可保留其所问字段，不受这条收缩。`
      : '',
    audit.violations.includes('contradictory_observation_order')
      ? '草稿违反有序观测点：某个请求/报文/响应/收到值/落库值/页面在该点已经与原始或前一层不同，却又把差异写成发生在该点之后。删除这个完整自然句或完整表格数据行；安全改写只能说“差异在该观测点已经存在/不晚于该点，具体发生层仍待前序证据”。只有前一观测点仍相等、后一观测点才不同，才允许把边界写在两点之间。'
      : '',
    audit.violations.includes('cross_actor_side_effect')
      ? '草稿把副作用动作交给实施、患者、对接方、运维或开发执行。删除改参、改字段类型/格式、改成字符串或数字、改映射/配置、再传/重传、复测、重试、重跑、补跑、重新触发等指令；改成只读检查已有报文、映射、请求响应、日志或审计。'
      : '',
    audit.violations.includes('ambiguous_as_built_action')
      ? `草稿用“返回后，再通过某服务补全”描述系统当前实现，容易被误读为要求现场人员执行：${(audit.ambiguousAsBuiltSystemActionParts || []).join('；')}。保留同一外部依赖事实，但改成“由系统自动只读调用并用于展示补全”；明确这不是要求实施手工调用，也不写业务数据。不得删除服务/方法事实，也不得新增现场操作步骤。`
      : '',
    audit.violations.includes('unexpected_concrete_path')
      ? '草稿出现了用户原文和当前 route/Spec 事实都没有的具体路径，或把已核路径用省略号、缩写、去前缀/尾斜杠的方式改写。删除这些新路径；已核路径必须逐字保留每个路径段和斜杠。不能安全恢复原字面量时改写为“该已核接口”或“当前请求”，不要猜路径。'
      : '',
    audit.violations.includes('out_of_scope_entity')
      ? `草稿引入了当前问题与当前/继承 route 事实未点名的相邻模块或任务：${(audit.unexpectedEntityTerms || []).join('、')}。删除这些模块、接口和动作所在的整句，只围绕当前已核主题作答；用户显式切到新实体时才允许进入新 route。`
      : '',
    audit.violations.includes('missing_primary_path')
      ? `当前答案正在核对请求/响应，而当前 route 只有一个已核主接口。必须逐字写出 ${audit.missingPrimaryPath.display}，不得用 path、today 接口、该接口、省略号或裸相对路径代替。若 route 有多个合法接口则不得强塞其中一个。`
      : '',
    audit.violations.includes('focused_fact_overreach')
      ? '用户本轮只是问单个接口、路径、状态码、字段属性或一个是非事实。保留 current route answerFacts/primary section 的直接答案和回答它所必需的 mustNotConfuse 限定；删除现场排查、无当前观察的失败原因、诊断优先级、操作建议、截图/日志邀约及其它未问扩写。用户明确问“为什么/排查/现场/怎么验证/接下来”或提出多个子问题时才可给对应步骤。'
      : '',
    audit.violations.includes('focused_fact_incomplete')
      ? `用户本轮的原子事实没有覆盖完整。唯一主接口必须同时保留同一 answerFact 直接绑定的请求方法、认证/访问限定和必要固定参数；对象关系题的每条 direct edge 必须在同一句或同一表格行绑定来源对象、关系键和目标对象，标题罗列和跨句 token 拼接都不算覆盖，并保留 direct mustNotConfuse 的关系边界。只从 current route answerFacts/mustNotConfuse 补回：${(audit.missingFocusedRelationshipFacts || []).map(item => item.clause).join('；')}。不得因此扩写响应字段、数据来源、JVM/时区、删除、级联、历史、渲染、兼容、保存操作或现场排查，也不得把相邻接口的认证背景强塞进当前接口。`
      : '',
    audit.violations.includes('undefined_ordinal_reference')
      ? `草稿存在未定义的圈号步骤/对照项引用：${(audit.undefinedOrdinalReferences || []).join('、')}。逐项核对前文表格、列表和正文，只能引用已经明确给出含义的序号；“共三项”不得再写④，表格只定义①②③时不得在判断或小结引用③/④或“含④”。删除含未定义序号的完整句/完整表格行，或在不新增事实的前提下改回已定义序号；不得凭空补造第四项。`
      : '',
    audit.violations.includes('undefined_symbolic_comparison')
      ? `草稿使用了未在此前逐一绑定含义的符号比较：${(audit.undefinedSymbolicComparisons || []).map(item => `${item.expression}（未定义 ${item.undefinedSymbols.join('/')}）`).join('；')}。A/B/C 等单字母或短符号必须在第一次“=、≠、>、<、vs”比较前通过“A=页面”正文或符号—含义表逐一定义；前文只自然语列三项、结尾再写自然语结论都不能反向补定义。若草稿/route 已明确映射，就把全部分支改成页面、接口响应、本机日期等具体观测名；没有明确映射时删除含符号的完整分支行/块，不得猜。表头直接用具体名称时无需符号。`
      : '',
    audit.violations.includes('undefined_arabic_step_reference')
      ? `草稿引用了此前尚未定义、用户本轮也未明确给出的阿拉伯数字步骤：${(audit.undefinedArabicStepReferences || []).map(item => `${item.numbers.map(number => `第${number}步`).join('/')}（${item.line}）`).join('；')}。定义必须在引用之前；后文才出现的步骤不能反向补足。若确有现成步骤正文，只按现有顺序补上连续标题；否则删除含引用的完整句，不得凭空补造缺失步骤。`
      : '',
    audit.violations.includes('incomplete_option_set')
      ? `草稿的“N选一/以下N类”声明与实际选项数量不一致：${(audit.optionCardinalityMismatches || []).map(item => `声明${item.expected}项、实际${item.actual}项`).join('；')}。若已有选项标签从起点连续，只把数量收敛为实际已有项数；否则删除不完整声明。不得为了凑数补造缺失业务分支。`
      : '',
    audit.violations.includes('nonsequential_option_labels')
      ? `草稿的字母选项没有从A连续：${(audit.nonSequentialOptionSets || []).map(item => `${item.actualLabels.join('/')}（应从${item.expectedLabels.join('/')}起）`).join('；')}。只能用已有选项重新连续标号，或删除整组残缺选项；不得猜测缺失A项的内容。`
      : '',
    audit.violations.includes('undefined_symbol_group_reference')
      ? `草稿用 A/B/C、A、B、C 或 A-C 引用分类，但其中符号此前未定义：${(audit.undefinedGroupReferences || []).map(item => `${item.undefinedSymbols.join('/')}（${item.line}）`).join('；')}。删除含未定义符号的完整引用句，或仅使用此前已经定义的具体选项名；不得从列举顺序猜映射、不得补造缺失分类。`
      : '',
    audit.violations.includes('self_referential_step_reference')
      ? `草稿的顶层步骤定义行引用了自己：${(audit.selfReferentialStepReferences || []).map(item => item.line).join('；')}。“3. 按第3步结果”之类自引用没有可执行含义；删除该完整标题行，让其下已有分支归属前一步，再将后续现有顶层步骤连续重编号。不得新增步骤或事实。`
      : '',
    audit.violations.includes('nonsequential_top_level_steps')
      ? `草稿的顶层步骤没有从本轮合法起点开始或编号不连续：${(audit.nonSequentialTopLevelSteps || []).map(item => `“${item.line}”应为${item.expected}、实际为${item.number}`).join('；')}。默认从1开始；只有用户本轮明确提到“第N步/做到第N步”时才允许从N或N+1承接。只按现有完整步骤的正文顺序连续重编号；不得为补缺号新增步骤、动作、字段或事实。嵌套清单和代码块不参与顶层编号。`
      : '',
    audit.violations.includes('empty_numbered_section')
      ? `草稿存在只有编号步骤标题、没有任何正文/表格/列表/代码块的空步骤：${(audit.emptyNumberedSections || []).map(item => item.line).join('；')}。编号标题可能是普通行、粗体或 Markdown heading；水平分隔线不算内容。只能接回草稿里已经存在的内容，没有时删除该完整标题，再按剩余已有步骤顺序连续重编号；不得补造缺失步骤。`
      : '',
    audit.violations.includes('missing_evidence_sufficiency_verdict')
      ? '用户问现有受限证据“够不够/是否足够/能不能判断”。第一句话必须直接回答现有证据够完成什么、不够完成什么；不得先铺已知事实、排查步骤或泛化材料清单。截图只能固定页面现象，不能单独闭环原因；未实际收到可核验附件时不得声称看见图内数字。'
      : '',
    audit.violations.includes('missing_evidence_minimum_route_fact')
      ? `用户问的是当前主题证据是否足够，最小缺口必须优先引用 current/inherited route 的已核主接口 ${audit.missingEvidenceMinimumPath.display} 及直接响应事实；不得退成页面、终端、账号角色、版本等通用提单材料。只有用户明确索要完整提单/转开发材料清单时才给泛清单。`
      : '',
    audit.violations.includes('undefined_observation_variable')
      ? `草稿的“最小证据/最小输入”与后续判断结构不自洽。判断表使用了此前未在用户已有证据或“需补/采集”清单中定义的观测量：${(audit.undefinedObservationVariables && audit.undefinedObservationVariables.unboundLabels || []).join('、') || '未定义观测量'}${audit.undefinedObservationVariables && audit.undefinedObservationVariables.countMismatch ? `；草稿声明只缺 ${audit.undefinedObservationVariables.claimedMissingCount} 项，但实际判断至少需要 ${audit.undefinedObservationVariables.actualMissingCount} 项输入` : ''}。只允许从用户本轮已明确具备的证据、草稿已有安全观测项或 current/inherited route 直接事实补全前序清单；否则删除依赖未定义变量的完整判断行/表格。不得补造业务事实，也不得重复要求用户已经明确具备的观测值。`
      : '',
    audit.violations.includes('inconsistent_structured_cardinality')
      ? `草稿声明的对照/回复数量与实际结构不一致：${(audit.cardinalityMismatches || []).map(item => `${String(item.kind || '').includes('list') ? '清单' : '表格'}声明${item.expected}${item.unit || '项'}、实际${item.actual}${item.unit || '项'}`).join('；')}。只有草稿中已经存在的内容才能保留；把声明改成实际数量，或删除数量声明及其后续引用/不完整表格或清单，禁止为了凑数新增字段、来源或观测点。普通“数据表有 N 列”不是回复数量契约。`
      : '',
    audit.violations.includes('incomplete_result_branch_set')
      ? `草稿承诺“按结果/情况分支判断”，但紧随表格只剩${(audit.incompleteResultBranchTables || []).map(item => item.actual).join('/')}条分支数据行。“分支”至少需要两个互斥或可区分结果；只能用草稿中已有的分支恢复，否则删除该引导语与不完整表格整块，不得凭空补造其余结果。`
      : '',
    audit.violations.includes('conflicting_count_declaration')
      ? `草稿同一局部结构的数量声明互相冲突：${(audit.conflictingCountDeclarations || []).map(item => `“${item.first}”=${item.firstCount}，但“${item.second}”=${item.secondCount}`).join('；')}。统一为实际已有清单项数，或删除不必要的数量承诺；不得为了凑数新增问题、字段或动作。`
      : '',
    audit.violations.includes('incomplete_structured_lead_in')
      ? '草稿含“例如：/如下：/包括：/包含：/里面有：/内容为：/由以下组成：/分别为：”后未给任何枚举、字段、代码或列表，就在同一段内直接进入“别搞混/注意/结论/下一步”等新语义分句，跨块跳到下一步骤、新小节或结束，或文末以冒号结尾而没有子内容。删除该完整空引导 clause 及其孤立步骤标题，保留后面的必要反例；也可只用草稿中已经存在的内容补成完整自然句。禁止补造示例、字段或注意事项。'
      : '',
    audit.violations.includes('empty_diagnostic_branch')
      ? '草稿存在只有分支标题、没有任何判断或安全动作的空诊断分支。只能用草稿已有正文补回；若没有现成内容，删除该完整分支标题，不得凭常识补造步骤。'
      : '',
    audit.violations.includes('empty_list_step_item')
      ? `草稿存在只有粗体标题、没有正文或子项的空列表步骤：${(audit.emptyListStepItems || []).map(item => item.line).join('；')}。只能接回草稿里已有的正文/子项；没有现成内容时删除该完整列表项，不得补造动作或证据。`
      : '',
    audit.violations.includes('dangling_closing_punctuation')
      ? `草稿存在以逗号、分号或冒号收尾却没有后半句的悬空句：${(audit.danglingClosingPunctuationLines || []).map(item => item.line).join('；')}。删除该完整自然句，或仅用草稿中紧邻的既有正文恢复完整句；不得凭空续写结论、步骤或分支。`
      : '',
    audit.violations.includes('orphaned_alternative_fragment')
      ? `草稿在前一并列项被删除后留下孤立后半分支：${(audit.orphanedAlternativeLines || []).map(item => item.line).join('；')}。删除这些以“还是/或者”开头、却没有可对应前项的完整行；不得猜测或补造被删掉的前项。完整“是 A 还是 B？”问句和“还是先停”式直接结论应保持。`
      : '',
    audit.violations.includes('dangling_alternative_fragment')
      ? `草稿在后一并列项被删除后留下悬空前半分支：${(audit.danglingAlternativeLines || []).map(item => item.line).join('；')}。删除这些以“还是/或者/或是/或”结尾却没有后一项的完整行，或仅用草稿中已经存在的后一项恢复完整二选一；不得猜测或补造被删内容。`
      : '',
    audit.violations.includes('orphaned_contrast_fragment')
      ? `草稿留下了没有前述完整主张的转折残句：${(audit.orphanedContrastLines || []).map(item => item.line).join('；')}。答案开头或“结论/判断”等纯标题后不得直接以“但/但是/不过/然而”起句；仅用草稿已有内容补回完整前句，或去掉转折词改成独立结论，无法保证时删除整句，不得猜造被删前提。`
      : '',
    audit.violations.includes('incomplete_paired_branch')
      ? `草稿在明确对照/比较/分支判断中只给了成对标签的一边：${(audit.incompletePairedBranches || []).map(item => `${item.pair.join('/')} 缺 ${item.missing.join('、')}`).join('；')}。只能用草稿已有内容补齐明确标签，或把整组改成不承诺另一边的单一直接结论；若无法保证语义完整，删除这组判断。不得凭空补造缺失分支的事实或处置。`
      : '',
    audit.violations.includes('contradictory_negative_section')
      ? `草稿的否定/禁止标题与下属正文极性相反：${(audit.contradictoryNegativeSections || []).map(item => `${item.heading} 下出现 ${item.contradictory.join('；')}`).join('；')}。否定标题下只保留明确禁止项；若正文是安全的正向替代动作，把它移到独立“可以做/下一步”标题。无法自然重组时删除整组，不得保留“不要做”标题加正向建议。`
      : '',
    audit.violations.includes('single_step_diagnostic_overreach')
      ? '用户只问先做哪个验证或第一步做什么。只保留一个最小只读验证及完成它所必需的对照项，删除第二、第三步、后续处置和可转发的修改指令；不得把一个问题扩成完整排查流程。'
      : '',
    audit.violations.includes('malformed_markdown')
      ? '草稿含未闭合的 Markdown 粗体、行内代码、代码围栏、中文/英文括号或引号，单独一行的孤立引号，或列数不齐/只有单个残留单元格的 Markdown 表格。修订时必须输出语法完整的自然句并闭合成对标记；删除示例/引用正文时连同整句引号一起删除，不得留下单独的「/」/“/”/『/』；表格必须保留完整表头、分隔行与列数一致的数据行，删掉一个违规单元格时删除其完整数据行，无法保住有效数据行就删除整张表。禁止保留半截列表项、孤立标点、残缺括号或空列表格。'
      : '',
    '保留草稿中已经由 Spec/route/源码确认的事实和局部未知边界；不得把当前主题整体降级为“说明书未覆盖”。',
    '<draft>', String(draft || ''), '</draft>',
  ].filter(Boolean).join('\n');
}

function consultReplaceUnexpectedPath(text, pathValue) {
  const p = String(pathValue || '');
  if (!p) return String(text || '');
  const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const suffix = '(?![A-Za-z0-9_.{}<>:/?={}&%+\\-])';
  let out = String(text || '').replace(new RegExp(`\\b(?:GET|POST|PUT|PATCH|DELETE)\\s+${escaped}${suffix}`, 'gu'), '该已核接口');
  return out.replace(new RegExp(`(?<![A-Za-z0-9_.{}<>:\\-])${escaped}${suffix}`, 'gu'), '该已核接口');
}

// 原子接口 fallback 可能同时保留草稿里的裸主接口句，又从 route 恢复一条
// 带认证限定的完整主接口句。按 claim 去重：同一主路径只留限定最完整的一句，
// 再核必要 mustNotConfuse 是否仍在；不拼接、不改写接口事实。
function consultDeduplicateFocusedAtomicAnswer(text, audit) {
  if (!audit || !audit.focusedFactQuestion || !audit.focusedFactPrimaryPath) return String(text || '');
  const primary = audit.focusedFactPrimaryPath;
  const parts = String(text || '').split(/(?<=[。！？；\n])/u);
  const candidates = parts.map((part, index) => ({ part, index }))
    .filter(item => consultConcretePaths(item.part).includes(primary.path));
  if (candidates.length > 1) {
    const qualifierTokens = (audit.focusedRelationshipFacts || [])
      .filter(item => item.kind === 'interface_qualifier' && item.path === primary.path)
      .flatMap(item => item.tokens || []);
    const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, '')
      .replace(/不需要|不校验|免(?:于)?/gu, '无需')
      .replace(/需要|必须|要求|应当|须/gu, '需')
      .replace(/认证|登录校验/gu, '鉴权');
    const mustNotConfusePaths = new Set(consultConcretePaths((audit.focusedMustNotConfuse || []).join('\n')));
    const scored = candidates.map(item => {
      const normalized = normalize(item.part);
      const qualifiers = qualifierTokens.filter(token => normalized.includes(normalize(token))).length;
      const boundaryPaths = consultConcretePaths(item.part).filter(pathValue => mustNotConfusePaths.has(pathValue)).length;
      const method = primary.method && new RegExp(`\\b${primary.method}\\s+`, 'i').test(item.part) ? 1 : 0;
      return { ...item, score: qualifiers * 10 + boundaryPaths * 3 + method };
    });
    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    const keepIndex = scored[0].index;
    const duplicateIndexes = new Set(candidates.map(item => item.index).filter(index => index !== keepIndex));
    for (let index = 0; index < parts.length; index++) if (duplicateIndexes.has(index)) parts[index] = '';
  }
  let output = parts.join('').trim();
  const outputPaths = new Set(consultConcretePaths(output));
  for (const fact of audit.focusedMustNotConfuse || []) {
    const factPaths = consultConcretePaths(fact);
    if (factPaths.length && !factPaths.some(pathValue => outputPaths.has(pathValue))) {
      output = [output, /[。！？]$/u.test(fact.trim()) ? fact.trim() : `${fact.trim()}。`].filter(Boolean).join('\n');
      factPaths.forEach(pathValue => outputPaths.add(pathValue));
    }
  }
  return output;
}

function consultAnswerSafeFallback(draft, audit) {
  if (audit && audit.explicitOperationEvidenceMissing && String(audit.operationEvidenceStopReply || '').trim()) {
    return consultNormalizeSafeMarkdown(String(audit.operationEvidenceStopReply).trim());
  }
  // 复杂的多边界事实题若显式声明 verifiedFacts fallback，模型修订失败后直接
  // 从 current route 的已核事实生成确定性终稿。首条必须是业务结论，其余才是
  // 实施口径；不再搬运草稿技术段或追加通用尾注，避免删漏和重复“研发参考”。
  if (audit && audit.verifiedFactsFallback && Array.isArray(audit.currentRouteFacts) && audit.currentRouteFacts.length) {
    // 同一张 route 卡也可能服务于链路题、现场追问和受限证据题；这些问法
    // 不应机械复述整张 answerFacts。它们的安全终稿已在语义审计阶段按本轮
    // 问句生成，只发布 route 已提供的事实和只读边界。
    if (audit.fallbackAnswerMode === 'chain' && String(audit.safeChainFallback || '').trim()) {
      return consultNormalizeSafeMarkdown(String(audit.safeChainFallback).trim());
    }
    if ((audit.fallbackAnswerMode === 'field_diagnostic' || audit.contextFollowupQuestion)
      && String(audit.safeDiagnosticFallback || '').trim()) {
      return consultNormalizeSafeMarkdown(String(audit.safeDiagnosticFallback).trim());
    }
    if (audit.fallbackAnswerMode === 'partial_evidence') {
      const routeFacts = (Array.isArray(audit.nonWritingRouteFacts) && audit.nonWritingRouteFacts.length
        ? audit.nonWritingRouteFacts : audit.currentRouteFacts)
        .map(fact => String(fact || '').trim()).filter(Boolean);
      // 紧凑 route 的四条事实本身就是本题的完整业务边界：若仍按相关性
      // 截 Top-3，会漏掉当前按钮入口或相邻超时入口。长 route 继续沿用
      // 原有 Top-N 收敛，避免把整张说明书倾倒到受限证据回答中。
      const compactRoute = routeFacts.length > 0 && routeFacts.length <= 4;
      // 受限证据题要说明“已确认到哪里”，不是把整张 route 卡原样搬进
      // 一个实施段落。按证据边界/现状/只读核对相关性保留少量事实，避免
      // 技术 facts 形成 audience dump，同时让生产/权限/状态边界不被漏掉。
      const partialEvidenceFacts = audit.existingRecordNarrowingQuestion && audit.existingRecordNarrowingFact
        ? [String(audit.existingRecordNarrowingFact)]
        : audit.partialEvidenceInventoryQuestion || compactRoute
          ? routeFacts
          : routeFacts
        .map((fact, index) => ({ fact, index, score: [
          /(?:只能确认|证据边界|前端证据)/iu,
          /(?:现有记录|已有记录|只读|核对|日志|失败记录|生产包|发布记录)/iu,
          /(?:不得|未经|授权|不能代替|不等于|不支持|不能据此|另一套(?:错误)?机制|不由[^。！？；\n]{0,32}统一处理|相邻(?:机制|功能)|机制隔离)/iu,
          /(?:页面|响应|状态|结果|记录)/iu,
        ].reduce((score, re) => score + (re.test(fact) ? 1 : 0), 0)}))
        .filter(item => item.score > 0)
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .slice(0, 3)
        .sort((left, right) => left.index - right.index)
        .map(item => item.fact);
      // 受限证据回答还必须保住 route 明确的机制隔离边界（例如某条
      // 处方采集链路不由当前补发入口统一处理）。这类事实可能不含日志/记录
      // 等观测词，不能因为相关性排序的前三条而被吞掉；仅补入显式隔离句，
      // 不把 mustNotConfuse 或其它未点名上下文整段搬入正文。
      const partialEvidenceBoundaryFacts = routeFacts.filter(fact =>
        /(?:另一套(?:错误)?机制|不由[^。！？；\n]{0,32}统一处理|相邻(?:机制|功能)|机制隔离)/iu.test(fact)
      );
      // 只有一个主路径时，受限证据终稿仍须带上该路径，否则发布审计会把
      // “没有数据库权限”的局部未知误判成“连请求边界也没回答”。将它作为
      // 最少的一条补入，不扩张到其它接口。
      const minimumPathFact = audit.minimumRoutePath
        ? routeFacts.find(fact => consultConcretePaths(fact).includes(audit.minimumRoutePath.path))
        : '';
      const publishedRouteFacts = Array.from(new Set([
        // 只确认前端发出请求时，首条 route 业务基线仍须保留；否则长
        // route 的相关性 Top-N 容易只剩状态值和实施句，回答会失去业务语境。
        ...(audit.frontendRequestOnlyEvidenceQuestion && routeFacts[0] ? [routeFacts[0]] : []),
        ...(partialEvidenceFacts.length ? partialEvidenceFacts : routeFacts.slice(0, 1)),
        ...partialEvidenceBoundaryFacts,
        ...(minimumPathFact ? [minimumPathFact] : []),
      ]));
      // “仅用已有记录缩小范围”若命中 route 明确的只读顺序，
      // 将原句拆成可逐项照做的步骤；不再同时整句复述，避免业务人员
      // 在长句与清单之间反复对照。步骤只来自本轮 route 事实。
      const routeSequenceBlock = audit.existingRecordNarrowingQuestion
        && Array.isArray(audit.routeReadOnlySequenceSteps) && audit.routeReadOnlySequenceSteps.length
        ? ['已有记录只读缩小顺序', ...audit.routeReadOnlySequenceSteps.map((step, index) => `${index + 1}. ${String(step.displayText || step.text || '').replace(/[。！？]+$/u, '')}。`)]
        : [];
      const displayRouteFacts = routeSequenceBlock.length
        ? publishedRouteFacts.filter(fact => fact !== audit.routeReadOnlySequenceFact)
        : publishedRouteFacts;
      const technicalEvidenceFacts = displayRouteFacts.filter(fact => /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\b[A-Z][A-Za-z0-9_$]*(?:Controller|Service|Mapper|Repository|DAO|DTO|VO)\b|\b[a-z][A-Za-z0-9_]{2,}\s*=|`\/[A-Za-z0-9_./{}?=&:%-]+`)/i.test(fact));
      const businessEvidenceFacts = displayRouteFacts.filter(fact => !technicalEvidenceFacts.includes(fact));
      const routeHasEvidenceVerdict = routeFacts.some(fact =>
        /(?:只够|足够|够(?:用|判断|固定|完成)|不够|不足|不能单独|不能替代|尚不能|只能固定|只能证明|只能确认|最多(?:只能|能|可))/u.test(fact)
      );
      // 即使某条 route fact 自身已经写了“不能据此确认”，首句仍要直答
      // 本轮受限证据能确认到哪里；否则答案会从“业务结论”开头，终审仍会
      // 报 missing_evidence_sufficiency_verdict，进而错误退成安全拒答。
      const evidenceVerdict = audit.frontendRequestOnlyEvidenceQuestion
        ? '结论：当前只能确认前端已经发出请求；这不等于服务端已经接收或完成后续处理。'
        : '结论：现有受限证据只够固定已经提供的观测，不能单独完成与已核规则的对照，也不足以闭环原因。';
      const unavailable = new Set();
      if (Array.isArray(audit.missingRouteFactDimensions)) {
        for (const label of audit.missingRouteFactDimensions) unavailable.add(String(label));
      }
      // 证据受限问法未必同时点名“接口/数据/边界”，但用户仍需要知道
      // 本轮没有确认什么；这里只列通用的证据边界，不生成任何业务事实。
      if (!unavailable.size) for (const label of ['接口', '数据', '后续状态']) unavailable.add(label);
      const unknown = audit.frontendRequestOnlyEvidenceQuestion
        ? '服务端处理结果、对应日志和后续业务状态均未取得，当前未知；不能由前端请求外推。'
        : `${Array.from(unavailable).join('、')}的具体细节待补充；本轮回答仅依据上述已核事实。`;
      const minimumReadOnlyEvidence = audit.minimalEvidenceQuestion
        ? '最少补证（只读）：保留同一次已经发生的请求及完整响应原文；若请求原文拿不到，提供对应已有记录中的对象标识、状态和时间用于对照，不重复提交。'
        : audit.frontendRequestOnlyEvidenceQuestion
          ? '只读证据边界：保留这次已经发生的请求方法、完整路径、参数、响应、请求标识和时间，再按同一标识只读对照服务端日志、业务记录与后续状态。'
          : '';
      const safetyBoundary = audit.frontendRequestOnlyEvidenceQuestion
        ? '本轮只读边界：不改数据、不重复提交、不重试；只核对已有请求、响应、日志和记录。'
        : (audit.explicitNonDestructiveBoundaryQuestion || audit.minimalEvidenceQuestion)
          ? '本轮只读边界：不改数据、不重放消息、不重提任务；只核对已有请求、响应和记录。'
          : '';
      return consultNormalizeSafeMarkdown([
        evidenceVerdict,
        '业务结论',
        ...businessEvidenceFacts.map(fact => `- ${fact}`),
        technicalEvidenceFacts.length ? '研发参考' : '',
        ...technicalEvidenceFacts.map(fact => `- ${fact}`),
        ...routeSequenceBlock,
        minimumReadOnlyEvidence,
        safetyBoundary,
        '本轮未知',
        `- ${unknown}`,
      ].filter(Boolean).join('\n'));
    }
    if (audit.fallbackAnswerMode === 'facts_with_unknowns') {
      const [businessFact] = audit.currentRouteFacts;
      const missing = Array.isArray(audit.missingRouteFactDimensions) && audit.missingRouteFactDimensions.length
        ? audit.missingRouteFactDimensions.join('、')
        : '其它实现边界';
      return consultNormalizeSafeMarkdown([
        '业务结论',
        `- ${String(businessFact || '').trim()}`,
        '本轮未知',
        `- ${missing}的具体细节没有已核事实；资料不足，不能补写未核实实现。`,
      ].join('\n'));
    }
    // 确定性 verified fallback 本身就是非写操作咨询答案；即使模型在首字
    // 前已因长度/429 失败、初审没有草稿可标记措辞歧义，也必须从一开始
    // 使用同源的系统自动只读表述。否则先按 route 原句组装、再被终审识别
    // 为“再通过…补全”动作歧义，会错误退回模型错误气泡。
    const fallbackRouteFacts = Array.isArray(audit.nonWritingRouteFacts) && audit.nonWritingRouteFacts.length
      ? audit.nonWritingRouteFacts
      : audit.currentRouteFacts;
    const [businessFact, ...implementationFacts] = fallbackRouteFacts;
    // 字段/类型/长度原子题只发布首条已核直接事实。路由后续事实常是
    // 只读步骤、升级路径或路由自述，属于实施诊断口径，不能因模型兜底
    // 而混入一个只问列类型的终稿。
    const fallbackImplementationFacts = audit.focusedTypeOrLengthQuestion ? [] : implementationFacts;
    const routeHasEvidenceVerdict = fallbackRouteFacts.some(fact =>
      /(?:只够|足够|够(?:用|判断|固定|完成)|不够|不足|不能单独|不能替代|尚不能|只能固定|只能证明|只能确认|最多(?:只能|能|可))/u.test(String(fact || ''))
    );
    const evidenceVerdict = audit.violations.includes('missing_evidence_sufficiency_verdict') && !routeHasEvidenceVerdict
      ? '结论：现有受限证据只够固定已经提供的请求、响应和页面观测，不能单独完成与已核规则的对照，也不足以闭环原因。'
      : '';
    return consultNormalizeSafeMarkdown([
      evidenceVerdict,
      '业务结论',
      `- ${businessFact}`,
      fallbackImplementationFacts.length ? '实施口径' : '',
      ...fallbackImplementationFacts.map(fact => `- ${fact}`),
    ].filter(Boolean).join('\n'));
  }
  if (audit && Array.isArray(audit.violations) && audit.violations.includes('unsupported_explicit_operation')) {
    const supportedFacts = (audit.currentRouteFacts || []).filter(fact =>
      (audit.explicitOperationContracts || []).some(contract =>
        routeHasDirectOperationEvidence({ answerFacts: [fact] }, [contract])
      )
    );
    return consultNormalizeSafeMarkdown(supportedFacts.length
      ? ['业务结论', ...supportedFacts.map(fact => `- ${fact}`)].join('\n')
      : consultOperationEvidenceStopReply());
  }
  const actorAction = /(?:让|请|交给|通知|要求|转|压|催|催促|推动|协调)?\s*(?:实施|用户|患者|对接(?:方)?|接口方|第三方|厂商|供应商|院方|运维|开发)[^。！？；\n]{0,64}(?:(?:改|修改|调整|切换|对齐|校准|统一|转换|修(?:复)?)[^。！？；\n]{0,16}(?:参数|传参(?:方式)?|传输方式|接口入参|报文(?:类型)?|类型|序列化(?:口径|方式|规则)?|编码(?:口径|方式|规则)?|协议(?:口径|规则)?|映射|结构|关联|链路|配置|时区|系统时间|环境|产品口径|业务口径|日切要求|服务配置|字符串|数字(?:类型)?|字段格式|数据格式|值类型)|(?:按|以)[^。！？；\n]{0,12}(?:字符串|数字(?:类型)?|指定格式|文本格式|字段格式|数据格式|值类型)[^。！？；\n]{0,8}(?:传|发送)|对时|重试|复测|重跑|补跑|重新触发|再次触发|再点|点一次|提交|保存|发送|完成|签名|审批|星标|再传|重传|重新发送)/ig;
  const negatedActorPrefix = /(?:不得|不能|不要|禁止|不可|不应|先别|停止|未确认)\s*$/i;
  const negatedRiskyAction = (statement, matchIndex) => {
    const source = String(statement || '');
    const prefix = source.slice(0, Math.max(0, Number.isInteger(matchIndex) ? matchIndex : source.length));
    const delimiterIndex = Math.max(
      prefix.lastIndexOf('，'), prefix.lastIndexOf(','), prefix.lastIndexOf('：'),
      prefix.lastIndexOf(':'), prefix.lastIndexOf('；'), prefix.lastIndexOf(';'),
      prefix.lastIndexOf('。'), prefix.lastIndexOf('！'), prefix.lastIndexOf('？'), prefix.lastIndexOf('\n'),
    );
    const clausePrefix = prefix.slice(delimiterIndex + 1).trim();
    // Keep the negation local to this clause; an affirmative action in a later
    // clause must still be rejected by the side-effect guard.
    return /(?:不得|不能|不要|禁止|不可|不应|先别|停止|未确认)[^。！？；\n]{0,24}$/u.test(clausePrefix);
  };
  const keepPart = part => {
    if (audit.violations.includes('contradictory_observation_order') && CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE.test(part)) {
      CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE.lastIndex = 0; return false;
    }
    CONSULT_OBSERVATION_ORDER_CONTRADICTION_RE.lastIndex = 0;
    if (audit.violations.includes('unsupported_likelihood') && (CONSULT_LIKELIHOOD_WORD_RE.test(part) || /典型(?:现象|表现|场景|特征|模式|症状)(?:边界)?/u.test(part) || CONSULT_CAUSAL_PRIORITY_RE.test(part) || CONSULT_CAUSAL_LOCALIZATION_RE.test(part) || CONSULT_DETERMINISTIC_FAILURE_RE.test(part))) {
      CONSULT_LIKELIHOOD_WORD_RE.lastIndex = 0; CONSULT_CAUSAL_PRIORITY_RE.lastIndex = 0; CONSULT_CAUSAL_LOCALIZATION_RE.lastIndex = 0; CONSULT_DETERMINISTIC_FAILURE_RE.lastIndex = 0; return false;
    }
    CONSULT_LIKELIHOOD_WORD_RE.lastIndex = 0;
    CONSULT_CAUSAL_PRIORITY_RE.lastIndex = 0;
    CONSULT_CAUSAL_LOCALIZATION_RE.lastIndex = 0;
    CONSULT_DETERMINISTIC_FAILURE_RE.lastIndex = 0;
    if (audit.violations.includes('cross_actor_side_effect') && Array.from(part.matchAll(actorAction))
      .some(match => !negatedActorPrefix.test(part.slice(0, match.index)) && !negatedRiskyAction(part, match.index))) return false;
    if (audit.violations.includes('cross_actor_side_effect') && Array.from(part.matchAll(CONSULT_DIRECT_RISKY_ACTION_RE))
      .some(match => !negatedActorPrefix.test(part.slice(0, match.index)) && !negatedRiskyAction(part, match.index))) return false;
    if (audit.violations.includes('unsupported_component_fault') && (audit.unsupportedComponentClaims || []).includes(part.trim())) return false;
    if (audit.violations.includes('unsupported_evidence_negation') && (audit.unsupportedEvidenceNegations || []).includes(part.trim())) return false;
    if (audit.violations.includes('unsupported_evidence_absence') && (audit.unsupportedEvidenceAbsenceClaims || []).includes(part.trim())) return false;
    if ((audit.violations.includes('audience_technical_overreach')
      || audit.violations.includes('audience_technical_first')
      || audit.violations.includes('audience_technical_not_last'))
      && (audit.audienceTechnicalParts || []).includes(part.trim())) return false;
    if (audit.violations.includes('audience_technical_dump')
      && (audit.audienceTechnicalDumpParts || []).includes(part.trim())) return false;
    if (audit.violations.includes('focused_fact_overreach') && (audit.focusedFactOverreach || []).includes(part.trim())) return false;
    if (audit.violations.includes('out_of_scope_entity') && (audit.unexpectedEntityTerms || []).some(term => part.toLowerCase().includes(String(term).toLowerCase()))) return false;
    if (audit.violations.includes('undefined_ordinal_reference') && (audit.undefinedOrdinalReferences || []).some(term => part.includes(String(term)))) return false;
    if (audit.violations.includes('undefined_symbolic_comparison') && (audit.undefinedSymbolicComparisons || []).some(item => item.line === part.trim() || item.line.includes(part.trim()))) return false;
    if (audit.violations.includes('undefined_arabic_step_reference') && (audit.undefinedArabicStepReferences || []).some(item => item.line === part.trim() || item.line.includes(part.trim()))) return false;
    if (audit.violations.includes('undefined_symbol_group_reference') && (audit.undefinedGroupReferences || []).some(item => item.line === part.trim() || item.line.includes(part.trim()))) return false;
    if (audit.violations.includes('self_referential_step_reference') && (audit.selfReferentialStepReferences || []).some(item => item.line === part.trim() || item.line.includes(part.trim()))) return false;
    if (audit.violations.includes('unexpected_concrete_path')) {
      const partPaths = new Set(consultConcretePaths(part));
      if ((audit.unexpectedPaths || []).some(pathValue => partPaths.has(String(pathValue)))) return false;
    }
    return true;
  };
  let fallbackDraft = String(draft || '');
  if (audit.violations.includes('nonsequential_top_level_steps')) {
    const stepLineRe = /^((?![ \t]{4})[ \t]{0,3}(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*)([1-9]\d*)([.、．][ \t]+)/u;
    let insideFence = false;
    let nextNumber = null;
    fallbackDraft = fallbackDraft.split('\n').map(line => {
      if (/^\s*```/u.test(line)) { insideFence = !insideFence; return line; }
      if (insideFence) return line;
      const match = line.match(stepLineRe);
      if (!match) return line;
      if (nextNumber === null) nextNumber = Number.isInteger(audit.topLevelExpectedStart) ? audit.topLevelExpectedStart : Number(match[2]);
      const normalized = `${match[1]}${nextNumber}${match[3]}${line.slice(match[0].length)}`;
      nextNumber += 1;
      return normalized;
    }).join('\n');
  }
  if (audit.singleStepOverreach && Number.isInteger(audit.singleStepOverreach.truncateFromLine)) {
    fallbackDraft = fallbackDraft.split('\n').slice(0, audit.singleStepOverreach.truncateFromLine).join('\n');
  }
  for (const mismatch of audit.cardinalityMismatches || []) {
    if (mismatch.structureBlock) fallbackDraft = fallbackDraft.replace(mismatch.structureBlock, '');
    else if (mismatch.tableBlock) fallbackDraft = fallbackDraft.replace(mismatch.tableBlock, '');
    const mismatchLines = new Set([mismatch.line, ...(mismatch.dependentLines || [])].filter(Boolean));
    if (mismatchLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !mismatchLines.has(line.trim())).join('\n');
  }
  for (const branches of audit.incompleteResultBranchTables || []) {
    if (branches.block) fallbackDraft = fallbackDraft.replace(branches.block, '');
  }
  const conflictingCountLines = new Set((audit.conflictingCountDeclarations || []).flatMap(item => [item.first, item.second]));
  if (conflictingCountLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !conflictingCountLines.has(line.trim())).join('\n');
  const nonSequentialOptionBlocks = new Set((audit.nonSequentialOptionSets || []).map(item => item.block).filter(Boolean));
  for (const block of nonSequentialOptionBlocks) fallbackDraft = fallbackDraft.replace(block, '');
  const optionCountChinese = ['', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];
  for (const mismatch of audit.optionCardinalityMismatches || []) {
    if (nonSequentialOptionBlocks.has(mismatch.block)) continue;
    if (!mismatch.actual) {
      fallbackDraft = fallbackDraft.split('\n').filter(line => line.trim() !== mismatch.line).join('\n');
      continue;
    }
    fallbackDraft = fallbackDraft.split('\n').map(line => {
      if (line.trim() !== mismatch.line) return line;
      return line.replace(/((?:(?:用|从|按)?\s*(?:下面|以下|下列|这)\s*)?)([一二两三四五六七八九十]|\d{1,2})(\s*选一|\s*(?:类|种(?:情况|结果|分支|选项)?))/u,
        (_, prefix, original, suffix) => `${prefix}${/^\d+$/u.test(original) ? mismatch.actual : (optionCountChinese[mismatch.actual] || mismatch.actual)}${suffix}`);
    }).join('\n');
  }
  for (const lead of audit.incompleteLeadIns || []) {
    if (lead.inlineClause) fallbackDraft = fallbackDraft.replace(lead.inlineClause, '');
  }
  const incompleteLines = new Set((audit.incompleteLeadIns || []).flatMap(item => item.affectedLines || []));
  if (incompleteLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !incompleteLines.has(line)).join('\n');
  const emptyBranchLines = new Set((audit.emptyDiagnosticBranchHeadings || []).map(item => item.line));
  if (emptyBranchLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !emptyBranchLines.has(line.trim())).join('\n');
  const emptyStepLines = new Set((audit.emptyListStepItems || []).map(item => item.line));
  if (emptyStepLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !emptyStepLines.has(line.trim())).join('\n');
  const emptyNumberedLines = new Set((audit.emptyNumberedSections || []).map(item => item.line));
  if (emptyNumberedLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !emptyNumberedLines.has(line.trim())).join('\n');
  const danglingClosingLines = new Set((audit.danglingClosingPunctuationLines || []).map(item => item.line));
  if (danglingClosingLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !danglingClosingLines.has(line.trim())).join('\n');
  const orphanedLines = new Set((audit.orphanedAlternativeLines || []).map(item => item.line));
  if (orphanedLines.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !orphanedLines.has(line.trim())).join('\n');
  const danglingAlternative = new Set((audit.danglingAlternativeLines || []).map(item => item.line));
  if (danglingAlternative.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !danglingAlternative.has(line.trim())).join('\n');
  const orphanedContrast = new Set((audit.orphanedContrastLines || []).map(item => item.line));
  if (orphanedContrast.size) fallbackDraft = fallbackDraft.split('\n').filter(line => !orphanedContrast.has(line.trim())).join('\n');
  for (const group of audit.incompletePairedBranches || []) {
    if (group.block) fallbackDraft = fallbackDraft.replace(group.block, '');
  }
  for (const section of audit.contradictoryNegativeSections || []) {
    if (section.block) fallbackDraft = fallbackDraft.replace(section.block, '');
  }
  for (const block of audit.audienceTechnicalDumpParts || []) {
    if (String(block || '').includes('\n')) fallbackDraft = fallbackDraft.replace(String(block), '');
  }
  const keptLines = fallbackDraft.split('\n').map(line => {
    if (consultMarkdownTableCells(line)) return keepPart(line) ? line : '';
    return line.split(/(?<=[。！？；])/u).filter(keepPart).join('');
  }).filter(line => line.trim());
  const proseSafeKept = keptLines.filter(line => !consultMalformedProseTokens(line).length).join('\n');
  let safeKept = consultNormalizeSafeMarkdown(consultNormalizeSafeTables(proseSafeKept));
  // 其它违规句/表格行被删除后，原本完整的判断表也可能只剩一行。
  // 对最终降级稿再做一次结构审计；只移除已经残缺的整块，不尝试补造分支。
  const postCleanupAudit = safeKept ? consultAnswerSemanticAudit(safeKept, audit.diagnosticQuestion ? '怎么判断？' : '', { matched: false }) : null;
  for (const mismatch of postCleanupAudit && postCleanupAudit.cardinalityMismatches || []) {
    if (mismatch.structureBlock) safeKept = safeKept.replace(mismatch.structureBlock, '');
    else if (mismatch.tableBlock) safeKept = safeKept.replace(mismatch.tableBlock, '');
    const mismatchLines = new Set([mismatch.line, ...(mismatch.dependentLines || [])].filter(Boolean));
    if (mismatchLines.size) safeKept = safeKept.split('\n').filter(line => !mismatchLines.has(line.trim())).join('\n');
  }
  for (const branches of postCleanupAudit && postCleanupAudit.incompleteResultBranchTables || []) {
    if (branches.block) safeKept = safeKept.replace(branches.block, '');
  }
  // 前序删句可能制造新的空步骤或悬空收口，例如删除分号后的危险动作后只剩
  // “只读核对已有报文；”。最终降级稿必须基于清理后的文本重审并删除完整项/行，
  // 不能把残缺句直接发布，也不能为了补全语义临时添加事实。
  const postCleanupStructuralLines = new Set([
    ...(postCleanupAudit && postCleanupAudit.emptyNumberedSections || []).map(item => item.line),
    ...(postCleanupAudit && postCleanupAudit.emptyListStepItems || []).map(item => item.line),
    ...(postCleanupAudit && postCleanupAudit.danglingClosingPunctuationLines || []).map(item => item.line),
  ]);
  if (postCleanupStructuralLines.size) {
    safeKept = safeKept.split('\n').filter(line => !postCleanupStructuralLines.has(line.trim())).join('\n');
  }
  safeKept = consultNormalizeSafeMarkdown(consultNormalizeSafeTables(safeKept));
  // 删除空步骤后可能只剩 2/4 等跳号。按原问题确定的合法起点重排剩余已有
  // 顶层步骤；只改编号，不创建标题或正文。
  if (safeKept) {
    const remainingStepRe = /^((?![ \t]{4})[ \t]{0,3}(?:#{1,6}[ \t]+)?(?:\*\*|__)?[ \t]*)([1-9]\d*)([.、．][ \t]+)/u;
    let expectedStep = Number.isInteger(audit.topLevelExpectedStart) ? audit.topLevelExpectedStart : 1;
    let insideFence = false;
    safeKept = safeKept.split('\n').map(line => {
      if (/^\s*```/u.test(line)) { insideFence = !insideFence; return line; }
      if (insideFence) return line;
      const match = line.match(remainingStepRe);
      if (!match) return line;
      const normalized = `${match[1]}${expectedStep}${match[3]}${line.slice(match[0].length)}`;
      expectedStep += 1;
      return normalized;
    }).join('\n');
  }
  if (audit.focusedFactPrimaryPath && !consultConcretePaths(safeKept).includes(audit.focusedFactPrimaryPath.path)) {
    safeKept = [`当前接口：\`${audit.focusedFactPrimaryPath.display}\`。`, safeKept].filter(Boolean).join('\n\n');
  }
  for (const fact of audit.missingFocusedMustNotConfuse || []) {
    safeKept = [safeKept, fact].filter(Boolean).join('\n\n');
  }
  for (const item of audit.missingFocusedRelationshipFacts || []) {
    safeKept = [safeKept, item.clause].filter(Boolean).join('\n\n');
  }
  if (audit.violations.includes('missing_primary_path') && audit.missingPrimaryPath) {
    const exact = audit.missingPrimaryPath.display;
    const primaryLine = `当前请求应逐字核对已核主接口：\`${exact}\`。`;
    if (audit.audienceMode === 'implementation') {
      safeKept = [safeKept, /(?:^|\n)\s*研发参考\s*(?:\n|$)/u.test(safeKept) ? '' : '研发参考', `- ${primaryLine}`].filter(Boolean).join('\n\n');
    } else safeKept = [safeKept, primaryLine].filter(Boolean).join('\n\n');
  }
  if (audit.violations.includes('missing_evidence_sufficiency_verdict')
    || audit.violations.includes('missing_evidence_minimum_route_fact')
    || audit.violations.includes('undefined_observation_variable')) {
    safeKept = String(audit.safeDiagnosticFallback || '').trim();
  }
  if (audit.chainRequested && (audit.violations.includes('missing_requested_interfaces')
    || audit.violations.includes('incomplete_requested_chain')
    || audit.violations.includes('audience_technical_dump')
    || audit.violations.includes('malformed_markdown'))) {
    safeKept = String(audit.safeChainFallback || safeKept).trim();
  } else if (audit.violations.includes('missing_requested_interfaces') && (audit.missingRequestedInterfaces || []).length) {
    const signatures = audit.missingRequestedInterfaces.map(item => `\`${item.display}\``).join('；');
    safeKept = [safeKept, `主接口：${signatures}。`].filter(Boolean).join('\n\n');
  }
  if (audit.violations.includes('unsupported_evidence_absence')) {
    for (const fact of audit.evidenceAbsenceCorrectionFacts || []) {
      const normalizedFact = String(fact || '').trim();
      const productTechnicalFact = /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\b[A-Z][A-Za-z0-9_$]*(?:Controller|Service|Mapper|Repository|DAO|DTO|VO)\b|\b[a-z][A-Za-z0-9_]{2,}\s*=|(?:接口路径|字段已确认|表名|数据库表)|`\/[A-Za-z0-9_./{}?=&:%-]+`)/i.test(normalizedFact);
      if (productTechnicalFact && (audit.audienceMode === 'product' || audit.audienceMode === 'implementation')) continue;
      if (normalizedFact && !safeKept.includes(normalizedFact)) safeKept = [safeKept, normalizedFact].filter(Boolean).join('\n\n');
    }
  }
  // 原子关系题在各种删句/结构清理之后做最后一次事实恢复。不能只恢复“初稿
  // 当时缺的边”：初稿中原本完整的边也可能被其它安全门连句删掉。此处直接
  // 用 current route 已抽取的全部 direct edge、表示限定与 direct 边界重建
  // 紧凑终稿；之后不再进入破坏性逐句清理，只由调用方做只读终审。
  if (audit.focusedFactQuestion && (audit.focusedRelationshipFacts || []).some(item => item.kind === 'relationship_edge')) {
    safeKept = (audit.focusedRelationshipFacts || [])
      .filter(item => item.kind === 'relationship_edge' || item.kind === 'relationship_boundary')
      .map(item => `- ${String(item.clause || '').replace(/[。；;]+$/u, '')}。`)
      .join('\n');
  }
  safeKept = consultDeduplicateFocusedAtomicAnswer(safeKept, audit);
  if (audit.audienceMode === 'implementation') {
    const recoveredTechnicalFacts = audit.violations.includes('unsupported_evidence_absence')
      ? (audit.evidenceAbsenceCorrectionFacts || []).filter(fact => /(?:\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|\b[A-Z][A-Za-z0-9_$]*(?:Controller|Service|Mapper|Repository|DAO|DTO|VO)\b|\b[a-z][A-Za-z0-9_]{2,}\s*=|(?:接口路径|字段已确认|表名|数据库表)|`\/[A-Za-z0-9_./{}?=&:%-]+`)/i.test(String(fact || '')))
      : [];
    const blockedTechnicalParts = new Set([
      ...(audit.focusedFactOverreach || []),
      ...(audit.unsupportedComponentClaims || []),
      ...(audit.unsupportedEvidenceNegations || []),
      ...(audit.unsupportedEvidenceAbsenceClaims || []),
    ].map(part => String(part || '').trim()).filter(Boolean));
    const audienceRelocationParts = audit.focusedFactQuestion ? [] : (audit.audienceTechnicalParts || []);
    const technical = Array.from(new Set([...audienceRelocationParts, ...recoveredTechnicalFacts]
      .map(part => String(part || '').trim()).filter(part => part
        && !blockedTechnicalParts.has(part)
        && !(audit.unexpectedEntityTerms || []).some(term => part.toLowerCase().includes(String(term).toLowerCase()))
        && !(audit.unexpectedPaths || []).some(pathValue => consultConcretePaths(part).includes(String(pathValue))))));
    if (technical.length) safeKept = [safeKept, '研发参考', ...technical.map(part => `- ${part}`)].filter(Boolean).join('\n\n');
  }
  const notes = [];
  // 原子事实题的审计只负责删掉越界内容；内部违规原因留在 retrieval.answerAudit，
  // 不能再以“安全尾注”形式污染用户正文，否则字段类型/接口题仍然没有真正止答。
  if (!audit.focusedFactQuestion && audit.audienceMode !== 'product') {
    if (audit.violations.includes('unsupported_likelihood')) notes.push('当前证据不支持对原因作频率排序或确定归类；未确认的原因只能作为不排序的待验证分支，具体定位需查看对应的原始日志或异常堆栈。');
    if (audit.violations.includes('unsupported_component_fault')) notes.push('未由当前事实确认的组件原因仅作为待验证分支，不作故障定论。');
    if (audit.violations.includes('unsupported_evidence_negation')) notes.push('本轮未取得的数据库、日志或后续状态证据只能标为无法确认，不能据缺少观测写成未发生或不涉及。');
    if (audit.violations.includes('unsupported_evidence_absence')) notes.push('检索片段未展示某条规则不等于 Spec 未写；系统契约按 current route 已核正文保留，本次实例是否准确执行仍需对应日志或记录确认。');
    if (audit.violations.includes('cross_actor_side_effect')) notes.push('未满足完整受控条件时，不执行这些改动或重复操作；只核已有报文、映射、请求响应、日志和审计。');
  }
  return [safeKept || audit.safeDiagnosticFallback || '当前草稿未通过发布前证据与动作安全校验，已停止发布其中未经证实的判断和操作指令。', ...notes].filter(Boolean).join('\n\n');
}

function consultVerifiedFactsFallback(question, route) {
  // verified fallback 的事实只能来自已命中的 current route。null / miss
  // 在进入完整语义审计前直接停住，既避免后续审计新增字段访问时再次出现
  // null.answerFacts，也防止把 Top-N 或相邻上下文误当成已核业务事实。
  if (!route || !route.matched) return null;
  const initialAudit = consultAnswerSemanticAudit('', question, route);
  if (!initialAudit.verifiedFactsFallback) return null;
  if (initialAudit.chainRequested && !initialAudit.chainEvidenceSufficient) return null;
  const reply = consultAnswerSafeFallback('', initialAudit);
  const finalAudit = consultAnswerSemanticAudit(reply, question, route);
  if (finalAudit.violations.length) return null;
  return { reply, initialAudit, finalAudit };
}

// 显式业务操作已命中 current route、但该 route 早期未声明 verifiedFacts 时，
// 模型超时/截断仍不能直接退成错误气泡。只允许发布 answerFacts 中与本轮
// “业务实体+动作/结果”同条直接对应的事实；没有这种事实（例如 route 仅靠
// 别名命中“撤销”）就发布无操作步骤的 evidenceStop，不能把路由命中本身
// 当成允许执行该操作的证据。
function consultMatchedOperationFailureFallback(question, route) {
  if (!route || !route.matched) return null;
  const q = String(question || '').trim();
  const contracts = consultExplicitOperationContracts(q);
  if (!contracts.length) return null;
  const directFacts = (Array.isArray(route.answerFacts) ? route.answerFacts : [])
    .map(fact => String(fact || '').trim()).filter(Boolean)
    .filter(fact => routeHasDirectOperationEvidence({ answerFacts: [fact] }, contracts));
  if (directFacts.length) {
    const verifiedRoute = {
      ...route,
      fallbackMode: 'verifiedFacts',
      route: { ...(route.route || {}), fallbackMode: 'verifiedFacts' },
      answerFacts: directFacts,
    };
    const verified = consultVerifiedFactsFallback(q, verifiedRoute);
    if (verified) return { ...verified, fallbackSource: 'verifiedOperationFacts' };
  }

  const stopRoute = {
    matched: false,
    tier: 0,
    score: 0,
    topN: Array.isArray(route.topN) ? route.topN : [],
    explicitOperationEvidenceMiss: contracts.map(({ entity, action }) => ({ entity, action })),
  };
  const initialAudit = consultAnswerSemanticAudit('', q, stopRoute);
  let reply = consultOperationEvidenceStopReply();
  let finalAudit = consultAnswerSemanticAudit(reply, q, stopRoute);
  let passes = 0;
  while (finalAudit.violations.length && passes < 2) {
    reply = consultAnswerSafeFallback(reply, finalAudit);
    finalAudit = consultAnswerSemanticAudit(reply, q, stopRoute);
    passes += 1;
  }
  if (finalAudit.violations.length) return null;
  return { reply, initialAudit, finalAudit, fallbackSource: 'evidenceStop' };
}

// 模型草稿失败仍要可观测：只把有限的错误分类/状态写入 retrieval，避免把
// 上游返回体、密钥或完整异常栈回显给现场用户。真正的模型/协议错误在没有
// 已核 route 事实可安全发布时仍由上层以 err 事件收口，不能被兜底静默吞掉。
function consultModelErrorInfo(error) {
  const status = Number(error && (error.status || error.statusCode));
  const rawCode = String((error && error.code) || '').trim();
  const message = String((error && error.message) || error || '模型请求失败')
    .replace(/[\r\n]+/g, ' ').trim().slice(0, 300);
  const code = (rawCode || (Number.isInteger(status) && status >= 100 && status <= 599 ? `MODEL_HTTP_${status}` : 'MODEL_DRAFT_ERROR')).slice(0, 80);
  let kind = 'model_error';
  if (status === 429 || code === 'MODEL_HTTP_429') kind = 'rate_limit';
  else if (code === 'MODEL_OUTPUT_TRUNCATED') kind = 'length_limit';
  else if (code === 'MODEL_EMPTY_RESPONSE') kind = 'empty_response';
  else if (code === 'MODEL_FIRST_TOKEN_TIMEOUT' || code === 'MODEL_CANDIDATE_TIMEOUT') kind = 'timeout';
  return {
    code,
    kind,
    ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    message,
  };
}

// 初稿 429、长度截断、空响应和其它暂时性模型失败都走同一个发布口：只有
// 人工 route 显式开启 verifiedFacts 且最终语义审计全绿时才返回确定性答案。
// 普通 route 或审计失败仍返回 null；route 对象缺失、或 route miss 后的现场
// 诊断/副作用操作题只能发布无业务事实的安全停点，不能伪造确定性答案。
function consultModelFailureFallback(question, route, error) {
  const fallback = consultVerifiedFactsFallback(question, route);
  if (fallback) return {
    ...fallback,
    modelDraftError: consultModelErrorInfo(error),
    fallbackSource: 'verifiedFacts',
  };

  const operationFallback = consultMatchedOperationFailureFallback(question, route);
  if (operationFallback) return {
    ...operationFallback,
    modelDraftError: consultModelErrorInfo(error),
  };

  // route miss 时不能把相邻上下文或 Top-N 检索片段伪装成业务答案；但现场
  // 诊断和带副作用的“怎么操作”问法也不能因模型截断/限流只剩错误气泡。
  // 这里仅发布无业务事实的安全停点：明确未知、停止写操作、索取最小上下文。
  // 普通 route miss 仍返回 null，保持“没有证据就不回答具体事实”的证据门。
  if (route && route.matched) return null;
  const missingRouteObject = route == null;
  const q = String(question || '').trim();
  const riskyOperationQuestion = /(?:怎么|如何)(?:发起|撤销|提交|保存|删除|新增|创建|审批|签名|收费|退费|重试|重做|重放|重提|修改|编辑|补发|补偿)/iu.test(q);
  if (!missingRouteObject && !consultSafeDiagnosticIntent(q) && !riskyOperationQuestion) return null;
  const initialAudit = consultAnswerSemanticAudit('', q, route);
  let reply = String(initialAudit.safeDiagnosticFallback || '').trim();
  if (!reply) reply = [
    '当前缺少可核验的功能事实，不能安全确认具体操作入口、顺序或状态条件。',
    '为避免误操作，本轮先停在这里：不得发起；不得撤销；不得提交；不得重试；不得修改业务状态。',
    '请先补充当前系统与页面、功能名称、当前业务状态以及已有报错或请求响应；由对应业务负责人核对正式说明和授权边界后，再确定后续处理。',
  ].join('\n\n');
  let finalAudit = consultAnswerSemanticAudit(reply, q, route);
  let passes = 0;
  while (finalAudit.violations.length && passes < 2) {
    reply = consultAnswerSafeFallback(reply, finalAudit);
    finalAudit = consultAnswerSemanticAudit(reply, q, route);
    passes += 1;
  }
  if (finalAudit.violations.length) return null;
  return {
    reply,
    initialAudit,
    finalAudit,
    modelDraftError: consultModelErrorInfo(error),
    fallbackSource: 'evidenceStop',
  };
}

// 模型草稿和一次修订都可能同时含多类违规；两轮整句清理后若仍有残留，
// 不能直接退化为机械拒答。诊断题已在 audit 内基于 current route 构造了
// 确定性“已核事实 + 只读留证”终稿；这里单独重审它，安全时优先发布。
function consultRecoverSafeDiagnostic(initialAudit, question, route) {
  let reply = initialAudit && initialAudit.verifiedFactsFallback
    ? consultAnswerSafeFallback('', initialAudit)
    : String(initialAudit && initialAudit.safeDiagnosticFallback || '').trim();
  if (!reply) return null;
  // 防御性发布口：完整链路是 developer 当前轮契约。若较早版本/运行态把
  // inherited route 的链路维度带进 implementation/product 审计，不能让
  // 已经通过其它事实与动作门的确定性只读清单因这一个陈旧维度机械拒答。
  // 只过滤该结构 violation；显式研发问法、其它事实/动作/作用域违规不放松。
  const currentTurnAudit = value => {
    if (!value || value.audienceMode === 'developer' || !value.violations.includes('incomplete_requested_chain')) return value;
    return {
      ...value,
      chainRequested: false,
      missingChainDimensions: [],
      violations: value.violations.filter(item => item !== 'incomplete_requested_chain'),
    };
  };
  let audit = currentTurnAudit(consultAnswerSemanticAudit(reply, question, route));
  let passes = 0;
  while (audit.violations.length && passes < 2) {
    reply = consultAnswerSafeFallback(reply, audit);
    audit = currentTurnAudit(consultAnswerSemanticAudit(reply, question, route));
    passes += 1;
  }
  return audit.violations.length ? null : { reply, audit, passes };
}

// 只给出“隔离/授权/回滚/幂等/范围”而未点名实际业务动作时，不能由检索命中反向替用户选一个任务。
// 这些条件只够回答通用准入原则，不够生成任何实体专属执行步骤。
function consultGenericControlledActionGuard(question) {
  const q = String(question || '').trim();
  const hasBundle = /(?:隔离测试环境|专用测试数据)/i.test(q)
    && /(?:授权|批准)/i.test(q)
    && /(?:回滚|清理)/i.test(q)
    && /(?:幂等|补偿)/i.test(q)
    && /(?:影响范围|数据范围|执行范围)/i.test(q);
  if (!hasBundle) return '';
  const hasNamedAction = /(?:同步|补跑|重跑|重新触发|导出|下载|保存|提交|完成|审批|签名|删除|新建|修改|收费|下发|发送|打开|刷新|切换|接口|任务|患教|咨询|反馈|医嘱|配置|登录|退出|JWT|token)/i.test(q);
  if (hasNamedAction) return '';
  return [
    '【安全前置条件齐全，但具体业务动作尚未点名】',
    '本轮只能回答条件性原则：隔离环境或专用数据、明确授权、回滚/清理、幂等/补偿与影响范围齐全，表示可以进入“评估一次受控验证”的门槛；还不能直接给执行步骤或断言某个具体动作可执行。',
    '用户没有说明要验证哪个业务动作/任务/接口。不得根据检索关键词或命中的相邻 route，自行选择同步、补跑、患者数据、调度、/comm/ 或其它具体实体，也不得罗列它们的接口、状态和执行流程。只追问一个问题：具体要验证的动作是什么；拿到实体后再按该动作的当前运行态、契约和风险给单次方案。',
  ].join('\n');
}

// 批处理/同步/调度类现场诊断有额外的副作用边界：截图和“最后成功时间”只能证明观测到的现象，
// 不能单独证明调度已停止；恢复、重跑、补跑也不能在幂等/范围/运行态未知时直接建议。
function consultOperationalSafetyGuard(question, route) {
  const q = String(question || '').trim();
  const routeText = route && route.matched
    ? [route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || [])].filter(Boolean).join(' ')
    : '';
  const topic = `${q} ${routeText}`;
  const operational = /(?:调度|定时(?:任务|作业)?|任务|作业|批处理|批量(?:任务|同步|导入)?|同步|ETL|导入任务|数据抽取|数据交换|队列|job|cron|最后成功|运行中断|执行中断|恢复|重跑|补跑|重新触发|重新执行|手动执行|启动任务)/i.test(topic);
  if (!operational) return '';
  return [
    '【批处理/同步/调度的观测与副作用安全边界】',
    '监控截图、页面显示的最后成功时间、长时间无新增或一次运行中断，只是当前观测证据。除非已有经确认的预期执行频率、调度平台与具体任务、明确错误/失败状态及责任 Owner，否则不得据此断言“调度停了”“某平台故障”或把责任归给某一方；只能说实际观测与待核预期之间可能存在差异。',
    '恢复、重跑、补跑、重新触发、手动执行或重新启动同步都可能重复写入、扩大时间范围或与正在运行的实例并发，属于可能有副作用的动作。未确认该任务的幂等或补偿契约、目标时间窗和数据范围、当前运行态、执行 Owner/授权之前，不得建议直接执行，也不得把“先恢复/先补跑一次”写成排查步骤。即使用户明确说任务幂等，也只能在时间窗、范围、当前运行态和授权一起确认后给出受控执行条件。',
    '现场安全顺序固定为：1. 对照经确认的预期计划与当前只读观测，先描述差异而不下故障结论；2. 只读取得具体任务实例状态、对应时间窗日志和影响范围，区分未触发、运行中、明确失败、执行成功但下游未更新；3. 确认任务 Owner、幂等/补偿契约、目标时间窗和范围；4. 再决定升级给对应 Owner，或在已授权且条件完整时受控执行。',
    '当前 route/Spec 已确认的系统边界必须持续有效。例如已确认“系统内部不定时、由外部调度触发”时，要先把它作为判断基线；但不得由此外推真实调度平台、频率、任务名、部署位置、错误状态或责任人。明确换到新业务实体时，以新实体证据为准，旧任务事实不得串入。',
  ].join('\n');
}

// 文件下载/导出/附件/模板下载的“成功”必须验文件制品本体：HTTP 200、非空、扩展名或阅读器能打开均不充分。
// 该守卫只给已有响应/文件的只读验证清单，不推测当前业务一定使用某一种格式，也不要求重复触发可能有副作用的导出动作。
function consultFileArtifactGuard(question, route) {
  const q = String(question || '').trim();
  const routeText = route && route.matched
    ? [route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || [])].filter(Boolean).join(' ')
    : '';
  const topic = `${q} ${routeText}`;
  const fileArtifact = /(?:下载|导出|附件|模板(?:文件)?(?:下载|导出)|文件(?:为空|空白|损坏|打不开|无法打开|格式|扩展名|后缀|内容|正文|字节|大小)|HTTP\s*200|Content-Type|Content-Disposition|MIME|magic|签名|文件头|PDF|DOCX|XLSX|ZIP|压缩包|central directory|EOF|xref)/i.test(topic);
  if (!fileArtifact) return '';
  return [
    '【文件下载/导出制品的只读验收门】',
    'HTTP 200、业务 code=0、Content-Disposition、扩展名、长度非零或“某个软件能打开”都不能单独证明文件有效。优先使用用户已经拿到的文件和已经发生的请求响应，不得为了验证而修改权限、模板、业务数据，或重复触发可能改变状态的导出动作。',
    '实施按固定顺序核对并留证：1. 响应体是真实文件字节，而不是 HTTP 200 包裹的 JSON/HTML 错误页；2. 文件长度大于 0；3. magic/文件签名与声明扩展名、Content-Type/MIME 一致；4. 按实际声明格式验证结构完整；5. 抽检正文或业务内容，确认不是空壳、错误页、错数据或缺关键内容。任一层失败都不能判成功。',
    '结构校验按实际格式选择：PDF 至少核可识别 header、EOF/xref 并能被 PDF 结构解析器解析；DOCX/XLSX/ZIP 至少核 central directory 可解析，并检查该格式必要 entries（DOCX 如 [Content_Types].xml、word/document.xml；XLSX 如 [Content_Types].xml、xl/workbook.xml）。具体格式未知时，先取得实际文件名、扩展名与 MIME，再按其声明格式选对应解析器；不得硬猜文件一定是 PDF、DOCX、XLSX，也不得编造系统使用的具体工具。',
    '若换账号后正常，先固定同一环境、同一入口、同一筛选条件和同一已有记录，只读对比两边账号权限/数据范围/模板上下文，以及响应类型、字节数、magic、结构和正文。范围或数据不同只能说明账号上下文可能影响结果；同条件下坏文件签名/结构失败才指向文件生成或下载链，不能只凭“另一个账号正常”归因。',
  ].join('\n');
}

// 同主题事实账本：route/facts 每轮都从模块地图与正文重新装配，不持久化模型自由文本。
// 部分证据、现场限制和复测问法只能收窄“本轮能观测到哪”，不能反向抹掉已核系统事实。
function consultEvidenceLedgerGuard(question, route) {
  if (!route || !route.matched || !consultContextFollowupIntent(question)) return '';
  return [
    '【同主题已核事实账本（持续基线）】',
    '本轮 route 的 answerFacts、mustNotConfuse 与重新召回的正文/源码，是这个主题当前仍有效的事实账本。除非用户明确切到新实体，或提供了有证据的新事实与旧规则冲突，否则这些已核事实持续有效。',
    '历史 assistant 的解释、示例、猜测和假设不进入账本；只能继承 route/spec/source 证据。本轮没有再次重复业务名，也不代表旧事实失效。',
    '用户只说“第一步看过了/没异常/继续”时，只能继承“排查已推进”这一现场进度；不得把上一条 assistant 自己定义的第一步、示例字段或归因复述成已经核实的事实。只有用户本轮明确给出的观察结果，才能加入现场证据。',
    '若本轮只是“这个动作/这个列表/下一步”等承接型泛化诊断，只允许沿当前继承 route 的实体与已核事实回答；即使本轮关键词又召回了其它相邻 Spec，也不得主动引入用户未点名的新业务实体，更不得列出该相邻实体的接口、字段、表名、按钮或状态作为补充示例。只有用户明确点名新实体时才切换 route 并使用新实体证据。',
    '答复顺序固定为：①先陈述持续有效的已知规则；②再说明本轮现场已经确认到哪；③只把仍缺日志、数据库权限、具体处理路径等未覆盖细节局部标为未知；④给最少、非破坏的下一步。禁止把第③项扩大成“说明书未覆盖整个主题”。',
    '“上午反馈/数据库无权限/只靠页面或响应/目前只能确认请求发出/还缺什么/复测到某一步”等表达，都是同主题的证据限制或进度，不是推翻事实账本的新证据。明确新实体或新主题仍以当前新 route 为准，旧账本不得串入。',
  ].join('\n');
}

// 当前/最终裁决优先于同仓遗留实现和历史方案。具体裁决内容仍只来自 route facts；
// 本守卫负责优先级，不在 intake 里硬编码某个产品字段或业务答案。
function consultCurrentRulingGuard(question, route) {
  if (!route || !route.matched) return '';
  const facts = [...(route.answerFacts || []), ...(route.mustNotConfuse || [])].join('\n');
  if (!/(?:当前裁决|最终决议|当前规则|已废止|已覆盖|不再作为|不得复活|不构成.*豁免)/i.test(facts)) return '';
  return [
    '【当前裁决优先于废止历史与遗留契约】',
    'route/Spec 已明确标成“当前、最终、覆盖、废止或不再适用”的内容必须按时间与证据等级裁决：当前有效事实优先；被覆盖的历史方案、遗留接口摘要和 assistant 旧解释不能作为并列候选，更不能因为某个现场线索看似吻合就复活。',
    '答复先直接应用当前裁决，再把遗留实现只局部标成实现缺口。若当前事实逐条否定了某个旧方案，答案也必须逐条守住这些反事实边界，不得换一种说法重新引入旧方案。',
    '用户说换账号后正常、第一步没异常或接口返回 200，只是现场相关性/进度证据，不足以推翻当前裁决；先围绕当前裁决允许的只读观测做对比，不能沿用历史 assistant 对该线索的归因。',
  ].join('\n');
}

// 短、单一的字段类型/枚举值/是否/对象关联类事实题只回答所问属性；避免模型把相邻表结构、
// 本地唯一元组、删除级联、历史行为或索引约束当成“顺便补充”带入答案。
function consultFocusedFactGuard(question) {
  const q = String(question || '').trim();
  if (!q || q.length > 180) return '';
  const focused = /(?:字段|列(?!表)|column|类型|type|是不是|是否|能否|能不能|会不会|是.*吗|分别是什么|值是什么|长度(?:多少|是什么)|状态码(?:是|为|什么|多少)|(?:靠|通过|使用|用)(?:什么|哪个|哪些)?(?:字段|键|key|ID|id)?(?:来)?关联|关联(?:关系|键|字段|key|ID|id)(?:是|为|什么|哪个|哪些)|(?:怎么|如何)关联|(?:调用|使用|走|用|是)(?:的|哪|哪个|什么)?接口|哪个接口|接口(?:是|为|叫|地址|路径)?什么|路径(?:是|为)?什么|(?:调用|使用|走|接口|路径)[^。！？；\n]{0,28}\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/|varchar|uuid|integer|bigint)/i.test(q);
  const operational = /(?:为什么|怎么(?:排查|判断|验证|处理|解决|核对|看)|如何(?!关联|串联|挂接)|排查|复现|留证|下一步|接下来|现场|转开发|抓包|请求和响应|请求.*抓到|响应.*抓到|业务流程|哪些接口|接口(?:列表|清单|有哪些)|(?:所有|全部|全套|主)接口|串起来|串联|全链路|完整链路|从[^.。！？\n]{1,80}到|保存|提交|查询.*不到)/i.test(q);
  const multiQuestion = (q.match(/[？?；;]/g) || []).length > 1 || /(?:另外|同时|还要|以及).*(?:什么|哪个|是否|怎么|如何)/i.test(q);
  if (!focused || operational || multiQuestion) return '';
  return [
    '【单一事实题止答边界】',
    '用户只询问或用陈述句确认一个接口、路径、状态码、字段/列的类型/长度/取值、对象之间的关联键/关系或一个是非事实。先从 current route 的 answerFacts/primary section 给直接答案，只补回答该事实所必需的限定与 mustNotConfuse 边界；唯一主接口题还必须保留同一 answerFact 直接绑定的请求方法、认证/访问限定与必要固定参数，不得把“止答”误解为只剩路径；关系题必须逐一覆盖用户点名对象在 current route 中已确认的直接挂接边与内容表示/存储边，每条边都要在同一句或同一表格行明确绑定来源对象、关系键和目标对象，标题里罗列对象不能替代关系正文，同一业务键连接多个目标时也不能合并漏答；direct mustNotConfuse 中“共享业务键不是真外键”等关系边界也必须发布；答到这里就停止。',
    '发布前按语义去重：同一主接口只出现一次 method + 精确 path + 同一事实直接限定；必要 mustNotConfuse 只保留一次。不得先写“当前接口”，后面又重复整句 route fact。若“包含/里面有/内容为：”后没有枚举、字段、代码或列表，而在同一段直接进入“别搞混/注意/结论/下一步”，删除该空引导 clause，保留后面的必要边界。',
    '所有修订、删句、结构清理完成后，再逐条核一次关系 direct edge、内容表示限定与 direct mustNotConfuse；若清理导致缺边，只能从 current route 的直接事实/本轮已注入的 primary evidence 重建紧凑逐句答案，重建后不得再做破坏性删句。“用 form_id：/通过 element_id：/关联键是：”后必须同段给完整关系，或紧随真实列表/表格/代码块，不能留下空键名标题。',
    '不得主动扩写同表其它列、本地身份元组、联合键、索引、唯一约束、数据库迁移、SQL 用法、相邻模块事实、实施步骤、现场排查、原因假设、动作建议或“把截图发来”等继续邀约。只有用户在本轮明确问到这些内容，且当前有效证据直接覆盖时，才逐项回答。',
    '即使相邻事实本身真实，只要不改变本问答案，也不要作为“顺便提醒”加入；显式切题后不得带入上一主题事实。',
  ].join('\n');
}

function consultFocusedFactOverreach(answer, question, route) {
  if (!consultFocusedFactGuard(question)) return [];
  const q = String(question || '').trim();
  const interfaceOnly = /(?:(?:调用|使用|走|用)(?:的|哪|哪个|什么)?接口|哪个接口|接口(?:是|为|叫|地址|路径)?什么|路径(?:是|为)?什么|(?:调用|使用|走|接口|路径)[^。！？；\n]{0,28}\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/)/i.test(q);
  const statusOnly = /状态码(?:是|为|什么|多少)/i.test(q);
  const typeOrLengthOnly = /(?:字段|列|column|varchar|uuid|integer|bigint|patient_id|visit_id|hospitalId|districtCode)/i.test(q)
    && /(?:类型|type|长度(?:多少|是什么))/i.test(q);
  const relationshipOnly = /(?:(?:靠|通过|使用|用)(?:什么|哪个|哪些)?(?:字段|键|key|ID|id)?(?:来)?关联|关联(?:关系|键|字段|key|ID|id)(?:是|为|什么|哪个|哪些)|(?:怎么|如何)关联)/i.test(q);
  const allowedPaths = new Set(consultConcretePaths(`${q}\n${(route && route.answerFacts || []).join('\n')}\n${(route && route.mustNotConfuse || []).join('\n')}`));
  const focusedTokens = new Set(consultScopeTechnicalTokens(q).map(token => token.toLowerCase()));
  return String(answer || '').split(/(?<=[。！？；\n])/u).map(x => x.trim()).filter(statement => {
    if (!statement) return false;
    if (/^[^。！？\n]{1,40}[：:]$/u.test(statement)) return false;
    // verifiedFacts 确定性终稿固定生成这两个标题；只精确豁免
    // 这两个系统标题（含合法 Markdown 包裹），其它无路径标题仍拦截。
    if (/^\s*(?:#{1,6}\s+)?(?:(\*\*|__)(?:业务结论|实施口径)\1|(?:业务结论|实施口径))\s*$/u.test(statement)) return false;
    if (/(?:现场(?:怎么|如何|快速|排查|核对)|排查步骤|下一步|接下来|开发者工具|\bNetwork\b|抓包|复现|留证|优先查|建议(?:先|再|去|让)|(?:^\s*(?:[-*+]\s+|[1-9]\d*[.、．]\s+)?|(?:请|建议|先|再|然后|去|尝试|需要|应当|应该)[^。！？；\n]{0,8})(?:打开|点击|刷新)[^。！？；\n]{0,24}(?:页面|工作台|网络|请求|接口)|如果[^。！？；\n]{0,36}(?:失败|异常|报错|没调到|没有请求)|把[^。！？；\n]{0,30}(?:截图|日志|请求|响应)[^。！？；\n]{0,16}(?:发来|贴出|提供)|需要更细|再一起看)/i.test(statement)) return true;
    if (interfaceOnly) {
      const paths = consultConcretePaths(statement);
      const hasAllowedPath = paths.some(pathValue => allowedPaths.has(pathValue));
      // 原子接口题只保留“方法 + 精确路径”及带精确路径的必要防混淆。
      // 即使响应字段、普通参数、来源时区等事实本身存在于同一 route，也不是
      // 本问目标。例外只限同一 answerFact 与当前路径直接绑定的固定/必传参数。
      const compactStatement = statement.toLowerCase().replace(/\s+/g, '');
      const fixedParamFacts = (route && route.answerFacts || []).filter(fact => {
        const factText = String(fact || '');
        return consultConcretePaths(factText).some(pathValue => paths.includes(pathValue))
          && /(?:固定|必须|需(?:要)?|要求)[^，,。；;\n]{0,24}(?:参数|入参|query|header)|(?:参数|入参|query|header)[^，,。；;\n]{0,24}(?:固定为|必须为|需传|必传|不能为空)/i.test(factText);
      });
      const hasBoundFixedParam = fixedParamFacts.some(fact => compactStatement.includes(String(fact).toLowerCase().replace(/\s+/g, '')));
      const adjacentContract = /(?:响应|返回(?:值|体)?|字段|请求体|数据来源|来自|时区|\bJVM\b|\byear\b|\bweek\b|Map\s*<)/i.test(statement)
        || (/(?:参数|入参|query|header)/i.test(statement) && !hasBoundFixedParam);
      const shortConfirmation = /^(?:结论[：:]\s*)?(?:对|是|没错|正确)[。！!]?$/u.test(statement.replace(/[*_`]/g, '').trim());
      return !shortConfirmation && (adjacentContract || !hasAllowedPath);
    }
    if (statusOnly) {
      return !/(?:HTTP\s*)?\d{3}|状态码/i.test(statement);
    }
    if (typeOrLengthOnly) {
      const statementTokens = consultScopeTechnicalTokens(statement).map(token => token.toLowerCase());
      const hasFocusedToken = statementTokens.some(token => focusedTokens.has(token));
      const hasAskedAttribute = /(?:类型|长度|varchar|character\s+varying|char|text|uuid|integer|bigint|smallint|\bint\b|\d+\s*(?:位|字符))/i.test(statement);
      // `PostgreSQL` contains the letters `SQL`; only a standalone SQL
      // mention is an implementation expansion for a focused type question.
      const adjacentImplementation = /(?:索引|唯一约束|联合键|主键|缓存|接口|请求|落库|迁移|\bSQL\b|身份元组|院区上下文)/i.test(statement);
      return !(hasAskedAttribute && (hasFocusedToken || statementTokens.length === 0) && !adjacentImplementation);
    }
    if (relationshipOnly) {
      // 关系表的表头/分隔行本身不承载业务 claim；逐 edge 完整性由后续
      // 同一表格行审计负责，不能先把结构行当“无关系扩写”删掉。
      if (consultMarkdownTableCells(statement)) return false;
      const routeSupportsRepresentation = (route && route.answerFacts || []).some(fact => /(?:保存|存储|承载|序列化|快照|JSON|json)/i.test(String(fact || '')));
      const askedRepresentation = /(?:结果|填写|填报|内容|值|载荷|payload|快照)/i.test(q);
      const directRepresentation = askedRepresentation && routeSupportsRepresentation
        && /(?:保存|存储|承载|序列化|快照|JSON|json)/i.test(statement);
      const adjacentBehavior = /(?:删除|级联|清理|悬空|历史(?:结果|记录|数据)?|渲染|回显|兼容|复制|重存|迁移|提交|修改|新增|创建|审批|签名|索引|唯一约束|查询性能)/i.test(statement);
      if (adjacentBehavior || (/(?:保存|存储|序列化)/i.test(statement) && !directRepresentation)) return true;
      const necessaryRelationship = /(?:关联|关系|关联键|共享键|外键|串(?:起|联|起来)?|挂(?:到|接)?|指向|引用|映射|对应|所属|连接|↔|→|<-|->|(?:靠|通过|用)\s*[^。！？；\n]{0,24}(?:字段|键|key|ID|id))/i.test(statement) || directRepresentation;
      return !necessaryRelationship;
    }
    return false;
  });
}

// 关系型原子题不能只“止答”，还必须覆盖用户点名对象在 current route 中已确认的每条直接边。
// 例如结果对象除了挂接键，还可能有“内容保存到某字段”这一条直接表示关系；这不是删除、渲染、
// 历史兼容等相邻行为。这里只从 answerFacts 抽取已有 clause 和字段 token，不生成产品事实。
function consultFocusedRelationshipFacts(question, route) {
  const q = String(question || '').trim();
  const relationshipOnly = /(?:(?:靠|通过|使用|用)(?:什么|哪个|哪些)?(?:字段|键|key|ID|id)?(?:来)?关联|关联(?:关系|键|字段|key|ID|id)(?:是|为|什么|哪个|哪些)|(?:怎么|如何)关联)/i.test(q);
  const interfaceOnly = /(?:(?:调用|使用|走|用)(?:的|哪|哪个|什么)?接口|哪个接口|接口(?:是|为|叫|地址|路径)?什么|路径(?:是|为)?什么|(?:调用|使用|走|接口|路径)[^。！？；\n]{0,28}\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/)/i.test(q);
  if ((!relationshipOnly && !interfaceOnly) || !route || !route.matched) return [];
  if (interfaceOnly) {
    const forbiddenPaths = new Set(consultConcretePaths((route.mustNotConfuse || []).join('\n')));
    const candidates = [];
    for (const factValue of route.answerFacts || []) {
      const fact = String(factValue || '').trim();
      const paths = consultConcretePaths(fact).filter(pathValue => pathValue.startsWith('/') && !pathValue.includes('*') && !forbiddenPaths.has(pathValue));
      for (const pathValue of paths) candidates.push({ path: pathValue, fact });
    }
    const uniquePaths = Array.from(new Map(candidates.map(item => [item.path, item])).values());
    if (uniquePaths.length !== 1) return [];
    const primary = uniquePaths[0];
    const fact = primary.fact;
    const tokens = [];
    const authPhrases = fact.match(/(?:需(?:要)?|必须|要求|应当|须|携带|带上|使用)\s*(?:合法|有效)?\s*(?:JWT|token)|(?:无需|免|不需要|不校验)\s*(?:鉴权|认证|登录)|(?:需(?:要)?|必须|要求|应当|须)\s*(?:鉴权|认证|登录)/ig) || [];
    for (const phrase of authPhrases) {
      const normalized = phrase.trim().replace(/\s+/g, ' ');
      if (normalized) tokens.push(normalized);
    }
    const fixedParamPhrases = fact.match(/(?:固定|必须|需(?:要)?|要求)[^，,。；;\n]{0,24}(?:参数|入参|query|header)[^，,。；;\n]{0,32}|(?:参数|入参|query|header)[^，,。；;\n]{0,24}(?:固定为|必须为|需传|必传|不能为空)[^，,。；;\n]{0,20}/ig) || [];
    for (const phrase of fixedParamPhrases) {
      const normalized = phrase.trim().replace(/\s+/g, ' ');
      if (normalized) tokens.push(normalized);
    }
    const uniqueTokens = Array.from(new Set(tokens));
    return uniqueTokens.length ? [{ clause: fact, tokens: uniqueTokens, kind: 'interface_qualifier', path: primary.path }] : [];
  }
  const directRelation = /(?:关联|关系|关联键|共享键|外键|串(?:起|联|起来)?|挂(?:到|接)?|指向|引用|映射|对应|所属|连接|↔|→|<-|->)/i;
  const directRepresentation = /(?:保存|存储|承载|序列化|快照|JSON|json)/i;
  const asksRepresentation = /(?:结果|填写|填报|内容|值|载荷|payload|快照)/i.test(q);
  const directEvidenceText = Array.isArray(route.directEvidenceFacts) ? route.directEvidenceFacts.map(String).join('\n') : '';
  const entityAliases = rawValue => {
    const raw = String(rawValue || '').trim();
    if (/填写内容/u.test(raw)) return ['填写内容', '内容', '快照'];
    const identifier = raw.match(/[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?/u)?.[0] || '';
    const base = identifier.includes('.') ? identifier.slice(0, identifier.lastIndexOf('.')) : identifier;
    const aliases = new Set([base || identifier].filter(Boolean));
    if (/(?:^|_)form$/i.test(base)) ['表单模板', '模板', '表单'].forEach(value => aliases.add(value));
    if (/(?:^|_)(?:element|field)$/i.test(base)) ['字段', '元素'].forEach(value => aliases.add(value));
    if (/(?:^|_)result$/i.test(base)) ['result', '填写结果', '结果'].forEach(value => aliases.add(value));
    if (/(?:^|_)option$/i.test(base) || /^option$/i.test(base)) aliases.add('选项');
    if (/(?:^|_)(?:table|column)$/i.test(base) || /^(?:table|column)$/i.test(base)) ['表格列', '表格', '列'].forEach(value => aliases.add(value));
    return Array.from(aliases).map(value => value.toLowerCase());
  };
  const edgeItems = [];
  for (const factValue of route.answerFacts || []) {
    const fact = String(factValue || '').trim();
    for (const rawClause of fact.split(/[；;。]/u)) {
      const clause = rawClause.trim();
      const arrow = clause.match(/(.+?)\s*(?:→|->|↔)\s*(.+)$/u);
      if (!arrow) continue;
      const sourceMatch = arrow[1].match(/([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*$/u);
      if (!sourceMatch) continue;
      const source = sourceMatch[1];
      const sourceParts = source.split('.');
      const key = sourceParts.length > 1 ? sourceParts[sourceParts.length - 1] : '';
      const rawTargets = arrow[2].split(/\s*(?:与|和)\s*/u).map(value => value.trim()).filter(Boolean);
      const targets = rawTargets.flatMap(target => {
        const slash = target.match(/^([A-Za-z_][A-Za-z0-9_]*)\/([A-Za-z_][A-Za-z0-9_]*)(\.[A-Za-z_][A-Za-z0-9_]*)$/u);
        return slash ? [`${slash[1]}${slash[3]}`, `${slash[2]}${slash[3]}`] : [target];
      });
      for (const target of targets) {
        // 地图的紧凑 answerFact 可能只写“填写内容 JSON”，而 current route 的
        // primary section 已进一步确认 content 是整份/整体 JSON 快照。该限定
        // 只从本轮实际注入的 direct evidence 提升，不凭字段名或行业常识猜。
        const evidenceSupportsWholeSnapshot = key.toLowerCase() === 'content'
          && /\bJSON\b/i.test(target)
          && /content[^。；\n]{0,180}(?:整份|整体)[^。；\n]{0,80}JSON[^。；\n]{0,80}快照|content[^。；\n]{0,180}JSON[^。；\n]{0,80}(?:整份|整体)[^。；\n]{0,80}快照/iu.test(directEvidenceText);
        const displayTarget = evidenceSupportsWholeSnapshot ? '整份填写内容 JSON 快照' : target;
        const requiredGroups = [entityAliases(source), key ? [key.toLowerCase()] : [], entityAliases(target)].filter(group => group.length);
        if (/\bJSON\b/i.test(target)) requiredGroups.push(['json']);
        if (evidenceSupportsWholeSnapshot) requiredGroups.push(['整份', '整体'], ['快照', 'snapshot']);
        edgeItems.push({
          clause: `${source} → ${displayTarget}`,
          tokens: requiredGroups.map(group => group[0]),
          requiredGroups,
          kind: 'relationship_edge',
          source,
          key,
          target: displayTarget,
        });
      }
    }
  }
  const boundaryItems = (route.mustNotConfuse || []).flatMap(fact => String(fact || '').split(/[；;。]/u))
    .map(clause => clause.trim()).filter(clause => /(?:外键|foreign\s+key)/iu.test(clause))
    .map(clause => ({
      clause,
      tokens: ['外键'],
      requiredGroups: [/(?:共享业务键|共享字段)/u.test(clause) ? ['共享业务键', '共享字段'] : [], ['外键']].filter(group => group.length),
      kind: 'relationship_boundary',
    }));
  if (edgeItems.length) return [...edgeItems, ...boundaryItems];
  return (route.answerFacts || []).flatMap(fact => String(fact || '').split(/[；;。]/u))
    .map(clause => clause.trim()).filter(Boolean)
    .filter(clause => directRelation.test(clause) || (asksRepresentation && directRepresentation.test(clause)))
    .map(clause => {
      const tokens = Array.from(new Set(Array.from(clause.matchAll(/\b(?:[A-Za-z][A-Za-z0-9_]*(?:_id|Id|ID|_key|Key)|content|payload|value)\b/g), match => match[0])));
      return { clause, tokens, kind: 'relationship' };
    })
    .filter(item => item.tokens.length > 0);
}

// 患者相关功能的请求身份边界是全局安全裁决，不能依赖某条业务 route 是否刚好重复列全。
// 只在现场诊断/请求核对场景注入；单字段类型等原子事实题继续止答，避免无关扩写。
function consultPatientIdentityGuard(question, route) {
  const q = String(question || '').trim();
  if (!q || consultFocusedFactGuard(q)) return '';
  const routeText = route && route.matched
    ? [route.route && route.route.title, ...(route.answerFacts || []), ...(route.mustNotConfuse || [])].filter(Boolean).join(' ')
    : '';
  const topic = `${q} ${routeText}`;
  const patientTopic = /(?:患者|patient|患教|监护|关注|药历|随访|住院号|就诊号)/i.test(topic);
  const requestIdentityCheck = /(?:请求|接口|参数|抓包|Network|响应|URL|身份|串院|串患者|错患者|详情|列表|数据对不上|怎么排查|如何排查|下一步|留证|复现)/i.test(q)
    || (consultSafeDiagnosticIntent(q) && /(?:页面|详情|列表|接口|请求|响应|数据)/i.test(topic));
  if (!patientTopic || !requestIdentityCheck) return '';
  return [
    '【患者相关请求的全局三元身份守卫】',
    '本轮涉及患者相关页面、详情、列表或现场诊断。只要答案要求核对请求身份/参数，就必须逐项核对 `hospitalId + patientId + visitId`，三项共同构成当前患者身份边界；不能只写 `patientId + visitId`，也不能因为当前业务 route 没有重复列全就省略 `hospitalId`。',
    '缺少 `hospitalId` 不能判定患者请求身份完整，应按当前契约回到可信入口重新选择医院/院区或患者上下文；不得从 token、默认院区或历史链接补齐。`districtCode` 只可作为可信上游内部路由条件，不能代替 `hospitalId`，也不是产品患者身份键的第四项。',
    '该守卫只约束患者相关请求身份核对，不扩写无关实现。若用户只问单个字段/列的类型、长度、值或一个原子是非事实，仍只回答所问属性，不主动追加三元身份、索引、表或其它模块事实。',
  ].join('\n');
}

// 安全必填上下文（身份/租户/医院院区等）不能被模型用“历史兼容”或默认值猜测放宽。
// 只有当前 route/facts 已出现这类安全上下文才注入；具体必填字段与拒绝方式仍完全来自证据。
function consultCriticalContextGuard(question, route) {
  if (!route || !route.matched) return '';
  const facts = [...(route.answerFacts || []), ...(route.mustNotConfuse || [])].join('\n');
  const topic = [question, route.route && route.route.title, facts].filter(Boolean).join('\n');
  if (!/(?:身份键|身份上下文|租户键|租户上下文|医院|院区|hospitalId|tenant(?:Id)?|scope)/i.test(topic)) return '';
  if (!/(?:必填|必须|缺少|缺失|不得|拒绝|重新选择|重新进入|不回退|默认|兼容|补齐|身份键)/i.test(facts)) return '';
  return [
    '【安全必填上下文事实守卫】',
    '当前 route/Spec/源码若已确认身份键、租户键、医院或院区等安全上下文为必填，就必须逐字沿用该契约：缺失时按证据拒绝或提示回到可信入口重新选择，不得为了显得兼容而放宽。',
    '不得自行补充“历史链接会兼容”“系统会自动补齐”，也不得猜测可从 token、默认租户/默认院区、相邻路由字段或看似等价字段回退。只有当前证据明确写出的兼容策略才可以回答。',
    '标成历史、已覆盖或已废止的旧方案不能补充进当前答案。证据没有说明的旧链接处理、本地唯一约束、缓存规则、数据库约束或自动映射都只做局部未知；用户没问实现细节时必须直接省略这些内容及其具体字段组合，用户明确追问时也只能按当前有效证据回答，禁止用“可能”“为了兼容”等措辞包装成实现事实，更不能推翻 answerFacts 或 mustNotConfuse 已确认的拒绝边界。',
    '用户明确换到新的实体或主题时只使用新 route；旧身份/租户事实不得串入。',
  ].join('\n');
}

// 命中经确认业务规则后，先判断现场现象是不是规则本身的正常结果，再决定要不要调查。
// 这不是放松证据门：只允许使用当前 route/specHits 的已核事实，不能把历史模型自由文本当证据。
function consultRuleApplicationGuard(question, route) {
  if (!route || !route.matched) return '';
  const q = String(question || '').trim();
  const applying = /(?:现场|复测|上午反馈|之前反馈|实际|现在|目前|结果|提示|报错|不能|不让|失败|不行|对不上|没变化|没生效|看不到|暂存|待完成|刷新|想(?:改|删|完成|保存|操作)|还能|是否|先查|怎么查|怎么处理|接下来|下一步|权限|创建人|本人|别人|无权限|没权限|拿不到|只能确认|只靠|仅靠|还缺什么|缺哪些|能确定的部分|能先排除什么)/i.test(q);
  if (!applying) return '';
  return [
    '【先应用已核规则，再决定是否诊断】',
    `本轮已经${route.inherited ? '从同会话主题事实账本继承' : '命中'}有经确认事实的功能 route。route/当前召回证据中的已确认事实必须继续作为判断基线，不能因为用户改问排查步骤、说明数据库/日志无权限、只拿到页面或请求证据，就说“说明书未覆盖”或把整个主题改成未知。先把用户描述的现象/想做的操作与这些事实比较：若规则已经能直接解释（例如终态本就不可编辑、非 owner 本就会被拒绝、缓存本就不会因普通刷新必然更新），先明确告诉实施“这是规则内的预期行为”及正确可行做法，不要用“当前资料无法确认”开头，也不要启动无意义的日志/ID/数据库调查。`,
    '只有用户观察到的结果与已核规则冲突时，才按异常处理，并只索取能区分冲突分支的最少证据，说明在哪里取、拿到后怎么判断。',
    '如果用户只说“这一步对不上/还是不行”而没有讲清具体落在哪个分支，不得整体回复“当前资料无法确认”：先依据已核规则给出条件式结论（符合规则→这是预期、停止异常调查；与规则冲突→继续排查），再只追问一个能区分这两个分支的现象或字段。',
    '若当前轮出现新的明确业务实体，仍以当前 route 为准；不得沿用旧功能事实。历史 assistant 自由文本始终不是证据。',
  ].join('\n');
}

// 咨询引用只从本次服务端真实召回结果派生；前端请求里的历史消息/元数据不能伪造引用。
// 同一份精简结果同时用于 SSE 与 chat 持久化，保证流式提示、刷新草稿和历史会话恢复口径一致。
function consultKbRefs(projId, hits) {
  return (Array.isArray(hits) ? hits : []).slice(0, 5).map(h => ({
    q: String((h && h.q) || '').slice(0, 400),
    a: String((h && h.a) || '').slice(0, 2000),
    subsystem: String((h && h.subsystem) || ''),
    module: String((h && h.module) || ''),
    subsystemLabel: kbSubLabel(projId, h && h.subsystem),
  })).filter(h => h.q || h.a);
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
// FS-08：会话 cookie 按域取名——cookie 不区分端口（RFC 6265），同 IP 两端口(5180 admin/5181 field)会共用同一 intake_sess → 一端登录另一端也登录。
//   按域给 cookie 起不同名字：field 域→intake_sess_field、admin 域→intake_sess_admin、other(单域名/直连 IP/本机)→intake_sess（向后兼容零变化）。
//   session 存储（sessions 表 token→userId）不变，只改承载 token 的 cookie 名。同 host 两 cookie 都存，但各域只读/写自己那个名 → 两端会话独立。
function sessCookieName(origin) { return origin === 'field' ? 'intake_sess_field' : origin === 'admin' ? 'intake_sess_admin' : 'intake_sess'; }
function authEnabled() { return loadAccounts().length > 0; }   // 未建任何账号 = 认证未启用（全开，供首次建管理员）
function currentUser(req) { const t = parseCookies(req)[sessCookieName(originOf(req))]; if (!t) return null; const s = loadSessions()[t]; if (!s || (s.exp && s.exp < Date.now())) return null; return loadAccounts().find(a => a.id === s.userId) || null; }
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
const LINK_OK = new Set(['/', '/submit.html', '/api/intake-submit', '/api/intake-chat', '/api/intake-commit-plan', '/api/consult', '/api/projects', '/api/customers', '/api/versions', '/api/spec-modules', '/api/model-config']);   // FS-04 v2：/api/intake-commit-plan 进 LINK_OK——访客链接原可经 intake-chat 自动建单，现建单挪到确认清单 commit-plan，须放行否则访客建不了单
function authGate(pathname, user, link) {
  if (pathname.startsWith('/assets/') || pathname.startsWith('/vendor/')) return 'allow';
  // /field.html = 实施端外壳页（FS-01）：页面本身不含数据、自带登录门遮罩，凭 /api/me 决定进不进工作空间；数据一律走下方受 gate 的 API。故页面外壳同 /login.html 一样对未登录/现场账号放行加载。
  if (['/login.html', '/field.html', '/api/login', '/api/logout', '/api/me', '/api/health', '/api/version'].includes(pathname)) return 'allow';
  if (!authEnabled()) return 'allow';                                   // 未启用：全开（含建首个管理员）
  if (link && !user) return LINK_OK.has(pathname) ? 'allow' : (pathname.startsWith('/api/') ? 'forbidden' : 'login');   // 提交链接：只放提交面
  if (!user) return 'login';
  if (isAdmin(user)) return 'allow';                                    // 管理员：全放行
  // 现场侧（产品经理 / 实施工程师）：只允许 提交面 + 工单查看 + 验证
  const FIELD_OK = new Set(['/', '/submit.html', '/detail.html', '/api/intake-submit', '/api/intake-reply', '/api/intake-chat', '/api/intake-commit-plan', '/api/consult', '/api/consult-to-intake', '/api/intake-delete', '/api/intake-analyze', '/api/kb-from-consult', '/api/kb-search', '/api/change-password', '/api/notifications', '/api/projects', '/api/customers', '/api/versions', '/api/spec-modules', '/api/intake-list', '/api/intake-detail', '/api/intake-media', '/api/intake-transition', '/api/field/submissions', '/api/field/conversations', '/api/field/overview', '/api/field/systems', '/api/field/batches', '/api/batch-download', '/api/customer-version', '/api/customer-maintain', '/api/intake-verify', '/api/intake-set-priority', '/api/field/update-plan', '/api/field/update-toggle', '/api/field/update-sql-merged']);   // FS-09：/api/field/overview = 「全览」个人全局图（医院卡 + 产品卡）数据源，端点内按 user.sites+projects 收敛。   // FS-04：/api/field/conversations = 右上「对话记录」数据源；/api/intake-commit-plan = 建单前确认清单确定性建单（v2 2026-08-07）（consult 每条 + intake 按 sessionId 分组），端点内按 user.sites 收敛   // FS-05：现场端新端点（按批次视图/下载/改版本/维保回写/逐单验证）+ 累积更新计划（读代码 docs/deploy.json/累积计划/勾选/合并SQL），均端点内按 user.sites 二次收敛。2026-08-05 架构重构删 deploy-template/customer-deploy-task/batch-task/version-releases（跟随产品代码，废弃手工登记与部署模板）
  return FIELD_OK.has(pathname) ? 'allow' : 'forbidden';
}
// FS-08 §4①：field 域接口允许集 = LINK_OK ∪ FIELD_OK（供访客链接 + 现场账号），与 authGate 内 FIELD_OK 同源，避免漂移。
//   注意：这里是 authGate 里那份 FIELD_OK 的镜像常量——两者若改一处务必同步（authGate 用于登录态白名单，本集用于 field 域名层外层闸）。
const FS08_FIELD_API = new Set(['/api/intake-submit', '/api/intake-reply', '/api/intake-chat', '/api/intake-commit-plan', '/api/consult', '/api/consult-to-intake', '/api/intake-delete', '/api/intake-analyze', '/api/kb-from-consult', '/api/kb-search', '/api/change-password', '/api/notifications', '/api/projects', '/api/customers', '/api/versions', '/api/spec-modules', '/api/intake-list', '/api/intake-detail', '/api/intake-media', '/api/intake-transition', '/api/field/submissions', '/api/field/conversations', '/api/field/overview', '/api/field/systems', '/api/field/batches', '/api/batch-download', '/api/customer-version', '/api/customer-maintain', '/api/intake-verify', '/api/intake-set-priority', '/api/field/update-plan', '/api/field/update-toggle', '/api/field/update-sql-merged', '/api/model-config']);   // FS-09：/api/field/overview 须与 FIELD_OK 同步（否则实施域 originGate deny→forbidden，见 fs-08 防漂移断言）。   // FS-04：/api/field/conversations + /api/intake-commit-plan 须与 FIELD_OK 同步（否则实施域 originGate deny→forbidden）（否则实施域 originGate deny→forbidden，见 fs-08 防漂移断言）   // FS-05 端点须与 FIELD_OK 同步，否则实施域(field)整个流被 originGate deny→forbidden（实测坑，见 fs-08 防漂移断言）；update-plan/update-toggle/update-sql-merged 为累积更新计划现场端。2026-08-05 架构重构删 deploy-template/customer-deploy-task/batch-task/version-releases（跟随产品代码）
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
      // FS-08：按当前请求的域给 session cookie 命名（field/admin 各自独立名 → 两域/两端口独立登录；other 回退 intake_sess，单域名零变化）。
      res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${sessCookieName(origin)}=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL / 1000}` });
      return res.end(JSON.stringify({ ok: true, me: pubUser(u) }));
    });
  }
  // FS-08：登出只清「当前域」那个 session cookie（Max-Age=0），别误清别的域的 cookie（否则登出一端会牵连另一端）。
  if (url.pathname === '/api/logout') { const cn = sessCookieName(origin); const t = parseCookies(req)[cn]; if (t) dropSession(t); res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `${cn}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` }); return res.end(JSON.stringify({ ok: true })); }
  if (url.pathname === '/logout') { const cn = sessCookieName(origin); const t = parseCookies(req)[cn]; if (t) dropSession(t); res.writeHead(302, { 'Set-Cookie': `${cn}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`, Location: '/login.html' }); return res.end(); }
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
  // CU-01 激活文件生成（运营端「医院管理」：设备码 → .lc-activation.lic 激活文件内容，前端 Blob 下载）。
  //   仅管理员：未进 FIELD_OK/LINK_OK/FS08_FIELD_API 白名单 → authGate deny-by-default 已对非 admin 返 403/401；field 域经 originGate deny→403。绝不进 field 白名单（运营端功能）。
  //   纯计算：不落库、不写盘、无字段映射（算法见 activationLicense/activationFileContent）。设备码只做长度上限防滥用，不做格式强校验（machineId 各平台格式不同）。
  if (url.pathname === '/api/activation/generate' && req.method === 'POST') {
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const deviceCode = String(b.deviceCode || '').trim();
      if (!deviceCode) return send(res, 400, JSON.stringify({ ok: false, error: '设备码不能为空' }));
      if (deviceCode.length > 200) return send(res, 400, JSON.stringify({ ok: false, error: '设备码过长（≤200）' }));
      const license = activationLicense(deviceCode);
      return send(res, 200, JSON.stringify({ ok: true, filename: '.lc-activation.lic', license, content: activationFileContent(deviceCode) }));
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
      // 【勾选子集·2026-08-06】入参可选 ticketIds:[] —— 传了就只归这些（每个仍须 已立项+未归批+同 product，非法跳过）；没传则维持原「全部已立项未归批」（向后兼容）。
      const store = CACHE.intakes[proj.id] || {};
      const list = loadBatches();
      const liveBatchIds = new Set(list.map(bt => String((bt && bt.id) || '')));   // 真实存在的批次 id（孤儿引用不算已归批）
      const pickRaw = Array.isArray(b && b.ticketIds) ? b.ticketIds.map(x => String(x || '').trim()).filter(Boolean) : null;
      const pickSet = pickRaw ? new Set(pickRaw) : null;
      const ticketIds = [];
      for (const e of Object.values(store)) {
        if (!e || e.type === 'consult') continue;                       // consult 不进批次
        if (e.deleted) continue;                                        // 软删记录不归批（即便还挂着已立项态）
        if (deriveLifecycle(e) !== '已立项') continue;                   // 仅已落实
        // 已归批不重复归入——但必须是【真实存在】的批次；孤儿批次号（残留脏数据/批次已删）当未归批，纳入新批次自愈（归批时 e.batch 会被覆盖成新的真实 B-xx）
        if (String(e.batch || '').trim() && liveBatchIds.has(String(e.batch).trim())) continue;
        if (pickSet && !pickSet.has(String(e.id))) continue;            // 传了勾选子集 → 只归勾中的（非勾中的跳过）
        ticketIds.push(e.id);
      }
      if (!ticketIds.length) return send(res, 200, JSON.stringify({ ok: false, error: pickSet ? '所勾选工单均不可归批（须已立项且未归批）' : '该产品当前没有已落实待分批的工单' }));
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

  // ---------- 工单↔批次编辑（2026-08-06 · 双向 · admin：未进 FIELD_OK/LINK_OK → 非 admin 自动 403）----------
  // 核心：单工单指派/换/移 —— 两边引用同步维护（旧批 ticketIds 删、新批 ticketIds 加）+ 工单/批次双向 history 留痕。
  //   护栏：仅 lifecycle=已立项 工单可归批/换批；仅 status=开发中 批次可增减成员（可下载/已交付批次锁定）；工单 project == 批次 product。
  //   返回 {ok:boolean, error?, batch?} 或（供批量复用）内部对象。isBulk=true 时不发送响应、返回结果对象供 batch-add-tickets 聚合。
  //   liveBatchIds 由调用方传入（避免每单重复 loadBatches 构 Set），list 为 loadBatches() 引用（原地改 ticketIds，调用方统一 saveBatches）。
  async function assignTicketToBatch(proj, e, targetBatch, list, liveBatchIds, by, at) {
    // e: 已 loadIntake 出来的工单副本；targetBatch: '' 表示移出，否则批次 id。返回 {ok, error, from, to}
    if (!e) return { ok: false, error: '工单不存在' };
    if (e.type === 'consult') return { ok: false, error: '咨询单不可归批' };
    if (e.deleted) return { ok: false, error: '工单已删除' };
    if (deriveLifecycle(e) !== '已立项') return { ok: false, error: '仅「已立项」工单可归批/换批（当前：' + deriveLifecycle(e) + '）' };
    const oldBatchId = String(e.batch || '').trim();
    const target = String(targetBatch || '').trim();
    if (target) {
      const nb = list.find(x => x.id === target);
      if (!nb) return { ok: false, error: '目标批次不存在' };
      if (nb.status !== '开发中') return { ok: false, error: '仅开发中批次可增减工单（该批已' + nb.status + '·锁定）' };
      if (String(nb.product) !== String(proj.id)) return { ok: false, error: '工单产品与批次产品不一致，不可归入' };
      if (oldBatchId === target) return { ok: true, error: '', from: oldBatchId, to: target, noop: true };   // 已在该批·幂等
    }
    // 旧批（若真实存在）移除该工单 + 留痕（护栏：旧批若非开发中，仍允许「移出/换出」——已出包批次成员被换走属边界，
    //   但主场景是把未归批单指派进开发中批。为稳妥：换批时旧批若已锁定则拒绝，避免破坏已发包批次成员集。）
    if (oldBatchId && liveBatchIds.has(oldBatchId)) {
      const ob = list.find(x => x.id === oldBatchId);
      if (ob) {
        if (ob.status !== '开发中') return { ok: false, error: '原批次已' + ob.status + '·锁定，不可移出/换出其成员' };
        ob.ticketIds = (ob.ticketIds || []).filter(t => String(t) !== String(e.id));
        ob.history = ob.history || [];
        ob.history.push({ action: 'update', by, at, note: (target ? 'remove ticket ' + e.id + '（换入 ' + target + '）' : 'remove ticket ' + e.id) });
      }
    }
    if (target) {
      const nb = list.find(x => x.id === target);
      nb.ticketIds = nb.ticketIds || [];
      if (!nb.ticketIds.map(String).includes(String(e.id))) nb.ticketIds.push(e.id);   // 去重
      nb.history = nb.history || [];
      nb.history.push({ action: 'update', by, at, note: 'add ticket ' + e.id + (oldBatchId ? '（自 ' + oldBatchId + ' 换入）' : '') });
      e.batch = target;
      e.history = e.history || [];
      e.history.push({ from: e.lifecycle || deriveLifecycle(e), to: e.lifecycle || deriveLifecycle(e), by, byRole: 'admin', at, note: '调整批次 → ' + target + (oldBatchId ? '（原 ' + oldBatchId + '）' : '') });
    } else {
      e.batch = '';
      e.history = e.history || [];
      e.history.push({ from: e.lifecycle || deriveLifecycle(e), to: e.lifecycle || deriveLifecycle(e), by, byRole: 'admin', at, note: '移出批次' + (oldBatchId ? '（原 ' + oldBatchId + '）' : '') });
    }
    return { ok: true, error: '', from: oldBatchId, to: target };
  }

  if (url.pathname === '/api/ticket-set-batch' && req.method === 'POST') {   // 单工单指派/换/移批次
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(String((b && b.project) || '').trim()); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '产品不存在' }));
      const id = String((b && b.id) || '').trim(); if (!id) return send(res, 400, JSON.stringify({ ok: false, error: '缺少工单 id' }));
      const e = loadIntake(proj, id); if (!e) return send(res, 404, JSON.stringify({ ok: false, error: '工单不存在' }));
      const list = loadBatches();
      const liveBatchIds = new Set(list.map(bt => String((bt && bt.id) || '')));
      const by = user ? (user.name || user.username) : 'admin';
      const at = nowStamp();
      const r = await assignTicketToBatch(proj, e, String((b && b.batch) || ''), list, liveBatchIds, by, at);
      if (!r.ok) return send(res, 400, JSON.stringify({ ok: false, error: r.error }));
      if (!r.noop) { await saveIntake(proj, e); saveBatches(list); }
      return send(res, 200, JSON.stringify({ ok: true, batch: e.batch || '' }));
    });
  }

  if (url.pathname === '/api/batch-add-tickets' && req.method === 'POST') {   // 批次侧批量加工单（从未归批的已立项里挑）
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const batchId = String((b && b.batchId) || '').trim(); if (!batchId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少 batchId' }));
      const ids = Array.isArray(b && b.ticketIds) ? b.ticketIds.map(x => String(x || '').trim()).filter(Boolean) : [];
      if (!ids.length) return send(res, 400, JSON.stringify({ ok: false, error: '未选择工单' }));
      const list = loadBatches();
      const bt = list.find(x => x.id === batchId); if (!bt) return send(res, 404, JSON.stringify({ ok: false, error: 'not found' }));
      if (bt.status !== '开发中') return send(res, 200, JSON.stringify({ ok: false, error: '仅开发中批次可增减工单（该批已' + bt.status + '·锁定）' }));
      const proj = projById(bt.product); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '产品不存在' }));
      const liveBatchIds = new Set(list.map(x => String((x && x.id) || '')));
      const by = user ? (user.name || user.username) : 'admin';
      const at = nowStamp();
      const added = []; const skipped = []; const touched = [];   // touched: 需 saveIntake 的工单对象（去重）
      for (const id of ids) {
        const e = loadIntake(proj, id);
        const r = await assignTicketToBatch(proj, e, batchId, list, liveBatchIds, by, at);
        if (r.ok && !r.noop) { added.push(id); touched.push(e); }
        else if (r.ok && r.noop) { skipped.push({ id, reason: '已在该批' }); }
        else skipped.push({ id, reason: r.error });
      }
      if (touched.length) { for (const e of touched) await saveIntake(proj, e); saveBatches(list); }
      return send(res, 200, JSON.stringify({ ok: true, added, skipped }));
    });
  }

  if (url.pathname === '/api/batch-candidates') {   // 某产品「已立项 + 未归批」候选工单（供定档勾选 / 批次侧加工单勾选清单）· admin
    const pid = String(url.searchParams.get('product') || '').trim();
    const proj = pid ? projById(pid) : null; if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '产品不存在' }));
    const store = CACHE.intakes[proj.id] || {};
    const liveBatchIds = new Set(loadBatches().map(bt => String((bt && bt.id) || '')));
    const items = [];
    for (const e of Object.values(store)) {
      if (!e || e.type === 'consult' || e.deleted) continue;
      if (deriveLifecycle(e) !== '已立项') continue;
      if (String(e.batch || '').trim() && liveBatchIds.has(String(e.batch).trim())) continue;   // 已归入真实存在批次 → 不算候选
      items.push({ id: e.id, type: e.type, title: e.title || '', subsystem: e.subsystem || '', subsystemLabel: e.subsystem ? kbSubLabel(proj.id, e.subsystem) : '', site: e.site || '', version: e.version || '', submittedAt: e.submittedAt || '' });
    }
    items.sort((a, b) => String(b.submittedAt || '').localeCompare(String(a.submittedAt || '')));
    return send(res, 200, JSON.stringify({ ok: true, items }));
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
      const versionBumped = [];
      // 发布闭环·版本回写（兜底）：批次转已交付时（全医院全单验过），对该批次覆盖的每个医院按 pkgVersion 更版本
      //   幂等：per-hospital 已在 intake-verify 触发过的，bumpCustomerVersion 内部同值不重复写（这里只补没触发到的）
      try {
        const sites = [...new Set((bt.ticketIds || []).map(tid => { const e = proj ? loadIntake(proj, tid) : null; return e ? String(e.site || '') : ''; }).filter(Boolean))];
        for (const site of sites) { const vr = bumpSiteVersionForBatch(bt, proj, site); if (vr.changed) versionBumped.push({ site, bumped: vr.bumped }); }
      } catch {}
      if (bt.status !== '已交付') {
        const at = nowStamp(); const by = user ? (user.name || user.username) : 'admin';
        bt.status = '已交付'; bt.deliveredAt = at;
        bt.history = bt.history || []; bt.history.push({ action: 'deliver', by, at, note: '全 ' + (bt.ticketIds || []).length + ' 单验证过·闭环已交付' });
        for (const v of versionBumped) { const summary = v.bumped.map(b => (b.subsystem ? b.subsystem + ' ' : '') + (b.fromVer || '无') + '→' + b.toVer).join('，'); bt.history.push({ action: 'site-version', by: '系统·发布闭环', at, note: '医院' + v.site + '版本→' + (bt.pkgVersion || '') + '（' + summary + '）' }); }
        saveBatches(list);
      } else if (versionBumped.length) {
        // 批次已是已交付但版本此前漏更（补更）：仍记 history
        const at = nowStamp();
        bt.history = bt.history || []; for (const v of versionBumped) { const summary = v.bumped.map(b => (b.subsystem ? b.subsystem + ' ' : '') + (b.fromVer || '无') + '→' + b.toVer).join('，'); bt.history.push({ action: 'site-version', by: '系统·发布闭环', at, note: '医院' + v.site + '版本→' + (bt.pkgVersion || '') + '（' + summary + '）（补更）' }); }
        saveBatches(list);
      }
      return send(res, 200, JSON.stringify({ ok: true, item: batchOut(bt), delivered: true, versionBumped }));
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
      let batchDelivered = false, versionBumped = null;
      if (result === 'pass' && e.batch) {
        const list = loadBatches();
        const bt = list.find(x => x.id === e.batch);
        if (bt) {
          // 发布闭环·版本回写（per-hospital·主触发）：该单医院在该批次里的覆盖工单全部已关闭 → 该医院该产品版本更到 bt.pkgVersion（幂等·只这批覆盖的子系统）
          try { const vr = bumpSiteVersionForBatch(bt, proj, e.site || ''); if (vr.changed) versionBumped = vr.bumped; } catch {}
          let allClosed = true;
          for (const tid of (bt.ticketIds || [])) { const t = loadIntake(proj, tid); if (!t || (t.lifecycle || deriveLifecycle(t)) !== '已关闭') { allClosed = false; break; } }
          if (allClosed && bt.status !== '已交付') {
            bt.status = '已交付'; bt.deliveredAt = at;
            bt.history = bt.history || []; bt.history.push({ action: 'deliver', by: '系统·现场验证闭环', at, note: '全 ' + (bt.ticketIds || []).length + ' 单现场验证过·闭环已交付' });
            saveBatches(list);
          }
          // 版本回写留痕记进批次 history（在 saveBatches 之后确保写盘；单独 save 一次，changed 才写）
          if (versionBumped && versionBumped.length) {
            const summary = versionBumped.map(b => (b.subsystem ? b.subsystem + ' ' : '') + (b.fromVer || '无') + '→' + b.toVer).join('，');
            bt.history = bt.history || []; bt.history.push({ action: 'site-version', by: '系统·发布闭环', at, note: '医院' + (e.site || '') + '版本→' + (bt.pkgVersion || '') + '（' + summary + '）' });
            saveBatches(list);
          }
          batchDelivered = (bt.status === '已交付');
        }
      }
      return send(res, 200, JSON.stringify({ ok: true, lifecycle: e.lifecycle, batchDelivered, versionBumped }));
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
      const subsIn = (Array.isArray(b.subsystems) ? b.subsystems : []).map(s => (typeof s === 'string' ? { name: s.trim() } : { key: String(s.key || '').trim(), name: String(s.name || '').trim(), desc: String(s.desc || '').trim(), repoPath: String(s.repoPath || '').trim(), repoUrl: String(s.repoUrl || '').trim(), branches: normRefList(s.branches), tags: normRefList(s.tags) })).filter(s => s.name).slice(0, 60);
      const subsystems = subsIn.map(s => { const o = { name: s.name }; if (s.key) o.key = s.key; if (s.desc) o.desc = s.desc; if (s.repoUrl) { o.repoUrl = s.repoUrl; const dir = cloneRepo(id, s.key || s.name, s.repoUrl); if (dir) o.repoPath = dir; } else if (s.repoPath) o.repoPath = s.repoPath; if (s.branches.length) o.branches = s.branches; if (s.tags.length) o.tags = s.tags; return o; });   // git 子系统仓 → clone 到缓存；PD-01：持久化各子系统所选分支/tag（版本清单来源）
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

  // ---------- PD-03 AI 检索诊断（admin：未进 LINK_OK/FIELD_OK/FS08 → authGate 已对非 admin 返 403/401，无需页内再判） ----------
  //   数据来源：consult 答题时落库的 retrieval（挂 chat 末条 assistant）+ 回放（重跑检索）；标记文件存 data/retrieval-marks.json。
  if (url.pathname === '/api/retrieval-replay' && req.method === 'POST') {   // 回放：对任意问题重跑三类检索（带分）做对比
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      const query = String(b.query || '').trim(); if (!query) return send(res, 400, JSON.stringify({ ok: false, error: '缺少问题' }));
      const ver = String(b.version || '').trim(), sub = String(b.subsystem || '').trim(), deep = !!b.deep;
      try { refreshRepos(proj, false); } catch {}   // 同 /api/spec-search：回放前拉最新代码/tag
      let specScored = [], kbScored = [], codeHits = null;
      // PD-04：回放也跑路由——有地图产品先路由，命中/miss 一并透出（方便调阈值）。deep 源码单独走同 consult 口径。
      let route = null; try { const map = loadModuleMap(proj, ver); if (map) route = routeQuestion(map, query, sub); } catch { route = null; }
      const hasMap = !!route;
      try { specScored = specSearchScored(proj, ver, query, 5, sub); } catch {}
      try { kbScored = await kbRetrieveScored(proj.id, query, 5, 2); } catch {}
      if (deep) { try { codeHits = codeSearch(proj, ver, query, specSearch(proj, ver, query, 5, sub), 4, sub); } catch {} }
      const retrieval = buildRetrieval({ query, deep, ver, subsystem: sub }, specScored, kbScored, codeHits);
      retrieval.conversationIntentMode = consultConversationMode(query);
      retrieval.conversationIntent = !!retrieval.conversationIntentMode;
      retrieval.routing = routingDiag(hasMap, route);
      // PD-04 修复：回放也带上 specSearch 底座首条分 + 阈值，方便调 SPEC_MIN_RELEVANT（路由未命中但 specSearch 强 → consult 现会据 spec 底座作答，不再固定话术）。
      if (retrieval.routing && retrieval.routing.enabled) {
        const specTop = (specScored[0] && typeof specScored[0].score === 'number') ? specScored[0].score : 0;
        retrieval.routing.specTop = Math.round(specTop * 1000) / 1000;
        retrieval.routing.specMinRelevant = SPEC_MIN_RELEVANT;
        retrieval.routing.usedSpecSearch = !route.matched ? (specTop >= SPEC_MIN_RELEVANT) : (specScored.length > 0);
      }
      // 命中时附上路由取到的 specHits（章节内容），方便对照阈值/命中质量
      let routeContext = null; if (hasMap && route.matched) { try { routeContext = loadRouteContext(proj, ver, route); } catch {} }
      return send(res, 200, JSON.stringify({ ok: true, retrieval, routeContext }));
    });
  }
  if (url.pathname === '/api/retrieval-log') {   // 诊断列表：列有 retrieval 的 consult 对话（支持 filter + 分页）
    const wantProj = String(url.searchParams.get('project') || '').trim();
    const fSite = String(url.searchParams.get('site') || '').trim();
    const fSub = String(url.searchParams.get('subsystem') || '').trim();
    const onlyMarked = url.searchParams.get('marked') === '1';
    const from = String(url.searchParams.get('from') || '').trim(), to = String(url.searchParams.get('to') || '').trim();
    let page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
    let size = Math.min(50, Math.max(1, parseInt(url.searchParams.get('size') || '20', 10) || 20));
    const marks = readRetrievalMarks();
    const marksByRecord = {};   // recordId → [mark...]（供 markedCount + 逐轮 marks 注入）
    for (const m of Object.values(marks)) { (marksByRecord[m.recordId] || (marksByRecord[m.recordId] = [])).push(m); }
    const pids = wantProj ? [wantProj] : Object.keys(CACHE.intakes);
    const rows = [];
    for (const pid of pids) {
      const store = CACHE.intakes[pid] || {};
      for (const e of Object.values(store)) {
        if (!e || e.deleted || e.type !== 'consult') continue;
        if (fSite && String(e.site || '') !== fSite) continue;
        if (fSub && String(e.subsystem || '') !== fSub) continue;
        const day = String(e.submittedAt || '').slice(0, 10);
        if (from && day && day < from) continue;
        if (to && day && day > to) continue;
        // 逐轮：只保留带 retrieval 的 assistant 轮（turnIndex=该 assistant 在 chat 里的下标；question=其前最近的 user 文本）
        const chat = Array.isArray(e.chat) ? e.chat : [];
        const turns = [];
        for (let i = 0; i < chat.length; i++) {
          const m = chat[i]; if (!m || m.role !== 'assistant' || !m.retrieval) continue;
          let q = ''; for (let j = i - 1; j >= 0; j--) { if (chat[j] && chat[j].role === 'user') { q = String(chat[j].text || ''); break; } }
          const tmarks = (marksByRecord[e.id] || []).filter(x => x.turnIndex === i);
          turns.push({ turnIndex: i, question: q, answer: String(m.text || ''), retrieval: m.retrieval, marks: tmarks });
        }
        if (!turns.length) continue;   // 无 retrieval 的老 consult 不列（本功能只诊断有捕获的对话）
        const markedCount = (marksByRecord[e.id] || []).length;
        if (onlyMarked && !markedCount) continue;
        rows.push({ recordId: e.id, project: pid, site: e.site || '', subsystem: e.subsystem || '', title: e.title || '', submittedAt: e.submittedAt || '', turnCount: turns.length, markedCount, turns });
      }
    }
    rows.sort((a, b) => String(b.submittedAt).localeCompare(String(a.submittedAt)));   // 新在前
    const total = rows.length, start = (page - 1) * size;
    return send(res, 200, JSON.stringify({ ok: true, total, page, size, items: rows.slice(start, start + size) }));
  }
  if (url.pathname === '/api/retrieval-mark' && req.method === 'POST') {   // 标记单条检索（对/跑题/缺失/该命中没命中 + 备注）；verdict=clear/空 → 撤销
    return readBody(req, (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const recordId = String(b.recordId || '').trim(); if (!recordId) return send(res, 400, JSON.stringify({ ok: false, error: '缺少 recordId' }));
      const project = String(b.project || '').trim();
      const turnIndex = Number.isFinite(+b.turnIndex) ? (+b.turnIndex | 0) : -1; if (turnIndex < 0) return send(res, 400, JSON.stringify({ ok: false, error: 'turnIndex 非法' }));
      const hitType = String(b.hitType || '').trim(); if (!RETRIEVAL_HIT_TYPES.has(hitType)) return send(res, 400, JSON.stringify({ ok: false, error: 'hitType 非法' }));
      const hitKey = String(b.hitKey || '').trim(); if (!hitKey) return send(res, 400, JSON.stringify({ ok: false, error: '缺少 hitKey' }));
      const key = retrievalMarkKey(recordId, turnIndex, hitType, hitKey);
      const verdict = String(b.verdict || '').trim();
      const marks = readRetrievalMarks();
      if (!verdict || verdict === 'clear') { if (marks[key]) { delete marks[key]; writeRetrievalMarks(marks); } return send(res, 200, JSON.stringify({ ok: true, cleared: true, key })); }
      if (!RETRIEVAL_VERDICTS.has(verdict)) return send(res, 400, JSON.stringify({ ok: false, error: 'verdict 非法' }));
      const by = user ? (user.name || user.username) : '';
      const mark = { key, recordId, project, turnIndex, hitType, hitKey, verdict, subsystem: String(b.subsystem || '').slice(0, 60), note: String(b.note || '').slice(0, 500), by, at: nowStamp() };
      marks[key] = mark; writeRetrievalMarks(marks);
      return send(res, 200, JSON.stringify({ ok: true, mark }));
    });
  }
  if (url.pathname === '/api/retrieval-issues') {   // 检索问题清单：聚合所有非 ok 标记（按 verdict/产品/子系统分组）
    const wantProj = String(url.searchParams.get('project') || '').trim();
    const marks = readRetrievalMarks();
    const issues = Object.values(marks).filter(m => m && m.verdict && m.verdict !== 'ok' && (!wantProj || m.project === wantProj));
    issues.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    const byVerdict = {}, byProject = {}, bySubsystem = {};
    for (const m of issues) {
      (byVerdict[m.verdict] || (byVerdict[m.verdict] = [])).push(m);
      (byProject[m.project || '(未标产品)'] || (byProject[m.project || '(未标产品)'] = [])).push(m);
      // 子系统未随 mark 存 → 归到 hitKey 无法反推，这里用「(未分组)」占位；前端主要按 verdict/产品看
      const sub = String(m.subsystem || '(未标子系统)');
      (bySubsystem[sub] || (bySubsystem[sub] = [])).push(m);
    }
    return send(res, 200, JSON.stringify({ ok: true, total: issues.length, groups: { byVerdict, byProject, bySubsystem }, issues }));
  }

  if (url.pathname === '/api/git-refresh' && req.method === 'POST') {   // 手动「同步代码」：立即拉最新 tag + 工作树，返回各仓 HEAD/标签数
    return readBody(req, async (b, err) => {
      const proj = projById(b && b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '项目不存在' }));
      let r; try { r = refreshRepos(proj, true); } catch (e) { return send(res, 200, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
      send(res, 200, JSON.stringify({ ok: true, syncedAt: fmtSyncAt(r.at), repos: r.repos || [], versions: listVersions(proj) }));
    });
  }
  if (url.pathname === '/api/git-config') { const c = readGitCfg(); return send(res, 200, JSON.stringify({ baseUrl: c.baseUrl || '', tokenMask: maskTok(c.token), configured: !!(c.baseUrl && c.token), provider: gitProvider(c) })); }
  if (url.pathname === '/api/git-config-save' && req.method === 'POST') {
    return readBody(req, (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const cur = readGitCfg();
      const c = { baseUrl: String(b.baseUrl || cur.baseUrl || '').trim().replace(/\/$/, ''), token: (b.token && String(b.token).trim()) ? String(b.token).trim() : cur.token };
      // provider 可选显式覆盖（'gitlab'|'gitee'）；不传/非法则按 host 自动判（用户无感），不落无效值。
      const pv = String(b.provider || '').trim().toLowerCase(); if (pv === 'gitlab' || pv === 'gitee') c.provider = pv; else if (cur.provider) c.provider = cur.provider;
      writeGitCfg(c);
      send(res, 200, JSON.stringify({ ok: true, tokenMask: maskTok(c.token), configured: !!(c.baseUrl && c.token), provider: gitProvider(c) }));
    });
  }
  if (url.pathname === '/api/git-inspect' && req.method === 'POST') {   // 解析 git 地址 → 自动 id/名称/子系统
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      try { const r = await gitInspect(b.url || ''); send(res, 200, JSON.stringify({ ok: true, ...r })); }
      catch (e) { send(res, 200, JSON.stringify({ ok: false, error: String((e && e.message) || e) })); }
    });
  }
  if (url.pathname === '/api/git-refs' && req.method === 'POST') {   // PD-01：列各子系统仓可选 refs（branches/tags）供编辑抽屉多选（ls-remote 只读，不 clone）
    // 入参二选一：{subsystems:[{key,repoUrl}]}（解析后未保存，直接用 repoUrl）｜{project:<id>}（已保存产品，用其 subsystems 的 repoUrl/deriveGitUrl 还原）。
    return readBody(req, (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      let subs = [];
      if (Array.isArray(b.subsystems) && b.subsystems.length) {
        subs = b.subsystems.filter(s => s && typeof s === 'object').map(s => ({ key: String(s.key || s.name || '').trim(), repoUrl: String(s.repoUrl || '').trim() }));
      } else if (b.project) {
        const proj = projById(String(b.project)); if (!proj) return send(res, 200, JSON.stringify({ ok: false, error: '项目不存在', refs: {} }));
        subs = ((proj.subsystems) || []).filter(s => s && typeof s === 'object').map(s => ({ key: String(s.key || s.name || '').trim(), repoUrl: String(s.repoUrl || '').trim() }));
      }
      if (!subs.length) return send(res, 200, JSON.stringify({ ok: true, refs: {} }));   // 无子系统 = 空（前端按空态处理）
      const refs = {};
      for (const s of subs) { const key = s.key || 'main'; refs[key] = lsRemoteRefs(s.repoUrl); }   // 逐仓 ls-remote；单仓失败只落该 key.error，整体不 500
      send(res, 200, JSON.stringify({ ok: true, refs }));
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

  // ---------- 提示词配置（PD-02 · admin：未进 FIELD_OK/LINK_OK/FS08 → authGate 已对非 admin 返 403/401，无需页内再判） ----------
  if (url.pathname === '/api/prompts-config') {   // 返回每个提示词的当前生效模板 + 元信息（是否自定义 / 占位说明 / 必需占位）
    const items = PROMPT_KEYS.map(key => {
      const meta = PROMPT_META[key] || {};
      const template = effectiveTemplate(DATA_DIR, key);
      return {
        key, label: meta.label || key, desc: meta.desc || '', group: meta.group || '其它',
        template, isDefault: !isCustomized(DATA_DIR, key),
        placeholders: meta.placeholders || [],
        requiredPlaceholders: meta.required || [],
        missingRequired: checkRequiredPlaceholders(key, template),   // 当前生效模板缺哪些必需占位（默认必为空）
        maxLen: PROMPT_MAX_LEN,
      };
    });
    return send(res, 200, JSON.stringify({ ok: true, items }));
  }
  if (url.pathname === '/api/prompts-config-save' && req.method === 'POST') {   // 保存单个/批量提示词模板；支持恢复默认（reset 或空模板 → 删该 key 回落默认）
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      // 兼容单条 {key, template, reset?} 与批量 {items:[{key,template,reset?}]}
      const list = Array.isArray(b.items) ? b.items : [{ key: b.key, template: b.template, reset: b.reset }];
      const cfg = { ...readPromptsCfg(DATA_DIR) };
      const results = [];
      for (const it of list) {
        const key = String((it && it.key) || '').trim();
        if (!key || !Object.prototype.hasOwnProperty.call(DEFAULT_PROMPTS, key)) { results.push({ key, ok: false, error: '未知提示词 key' }); continue; }
        const reset = !!(it && it.reset);
        const tpl = (it && typeof it.template === 'string') ? it.template : '';
        if (reset || !tpl.trim()) { delete cfg[key]; results.push({ key, ok: true, reset: true }); continue; }   // 恢复默认：删该 key
        if (tpl.length > PROMPT_MAX_LEN) { results.push({ key, ok: false, error: `模板过长（>${PROMPT_MAX_LEN} 字）` }); continue; }
        // 占位校验：缺必需占位 → 非阻塞警告（用户选了灵活性，允许保存但明确回警告）
        const missing = checkRequiredPlaceholders(key, tpl);
        if (tpl === DEFAULT_PROMPTS[key]) { delete cfg[key]; results.push({ key, ok: true, reset: true, warnings: missing }); continue; }   // 与默认逐字相同 → 视为未改，删 key
        cfg[key] = tpl;
        results.push({ key, ok: true, warnings: missing });
      }
      writePromptsCfg(DATA_DIR, cfg);   // 失效缓存，下次读最新
      // 回读该批 key 的最新状态供前端刷新
      const updated = list.map(it => { const key = String((it && it.key) || '').trim(); if (!Object.prototype.hasOwnProperty.call(DEFAULT_PROMPTS, key)) return null; const template = effectiveTemplate(DATA_DIR, key); return { key, template, isDefault: !isCustomized(DATA_DIR, key), missingRequired: checkRequiredPlaceholders(key, template) }; }).filter(Boolean);
      const anyFail = results.some(r => !r.ok);
      send(res, 200, JSON.stringify({ ok: !anyFail, results, updated }));
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
      const ai = await intakeAI(proj, e); e.chat.push({ role: 'assistant', text: ai.reply, ts: Date.now() }); await saveIntake(proj, e);
      // FS-04 AC-36：续聊已建单的会话 → 同步刷新它的会话记录（intake-conv）chat/updatedAt，让「对话记录」显最新对话（工单沿 sessionId 关联，不建重单）。
      //   chat 用工单最新 e.chat（含本轮问答）；media 简化不带（会话记录只回显对话，媒体在工单 detail 里）。
      try { if (String(e.sessionId || '').trim()) { const convChat = (Array.isArray(e.chat) ? e.chat : []).map(m => { const c = { role: m.role, text: m.text || '', ts: m.ts }; if (Array.isArray(m.media) && m.media.length) c.media = m.media.slice(); return c; }); await saveConvRecord(proj, { sessionId: e.sessionId, site: e.site, subsystem: e.subsystem, version: e.version, reporter: e.reporter, role: e.role || 'field', chat: convChat }); } } catch {}
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
      const sessionId = String(b.sessionId || '').trim().slice(0, 40);   // FS-04 会话分组：一次聊天的多张单同一 sessionId → 右上「对话记录」归成一条。前端「新对话」重置生成新 id；随草稿/快照带。落 data JSON（不加库列）；旧单无此字段→前端兜底每单自成一条。
      const cfg = readModelCfg(); if (!cfg.apiKey) return send(res, 200, JSON.stringify({ ok: true, reply: '（管理员还没配置模型 API，暂时不能对话；配好后即可用。）' }));
      // 全量归一化（filter 内容），filedUpTo 是前端 chat.messages 的下标——与此对齐（本流程消息恒有 content，filter 一般不丢）。
      const allMsgs = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && m.content).map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content).slice(0, 4000) }));
      if (!allMsgs.length) return send(res, 400, JSON.stringify({ ok: false, error: 'empty' }));
      // FS-04「已建单水位线」（2026-08-06 主修·确定性防上下文污染）：前端每次建单后把 filedUpTo 上移到 messages.length；
      //   这里用代码把历史切两段——archived=已归档建单只读背景（禁止再建/合并），active=当前待处理（只对它判是否建新单）。
      //   filedUpTo 夹到 [0, allMsgs.length]（越界/不传/老前端=0 → active 为全量，行为完全同现状、不回归）。
      const filedUpTo = Math.min(Math.max(0, parseInt(b.filedUpTo, 10) || 0), allMsgs.length);
      const archivedMsgs = allMsgs.slice(0, filedUpTo);
      const activeMsgs = allMsgs.slice(filedUpTo).slice(-24);   // 待处理段仍限最近 24 轮预算
      // 组给模型：archived 折叠成一条「只读背景」user 说明（原文拼接，标注已建单、禁止再建/合并）+ active 原样多轮。只有 active 被当"待判断建单"的正文。
      const msgs = archivedMsgs.length
        ? [{ role: 'user', content: '【已建单归档·只读背景·禁止再为这些内容建单或合并进新需求】以下是本次会话此前已归档建单、已闭环的对话，仅供你理解上下文：\n' + archivedMsgs.map(m => (m.role === 'user' ? '用户：' : '助手：') + m.content).join('\n') + '\n【以上为已建单背景，结束】' }, ...activeMsgs]
        : activeMsgs;
      const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6);   // 本轮附的截图（data URL，≤6）→ 多模态并进末条 user，让 AI 结合图判类/建单
      // FS-04 v2（2026-08-07）「建单前确认清单」：续聊已建单会话时前端传 builtTickets:[{ticketId,title}]，让 AI 在 plan 里对「补充某已建单」用 action=append、否则 new（默认倾向 new）。
      const builtTickets = (Array.isArray(b.builtTickets) ? b.builtTickets : []).map(t => ({ ticketId: String((t && t.ticketId) || (t && t.id) || '').trim(), title: String((t && t.title) || '').trim() })).filter(t => t.ticketId).slice(0, 20);
      let reply; try { reply = await callModel(cfg, { system: intakeChatSystem(proj, type, version, sub, archivedMsgs.length > 0, builtTickets) + (imgs.length ? '\n用户本轮可能附了截图，请结合图片理解问题/复现场景。' : ''), messages: msgs, images: imgs, maxTokens: 900 }); }
      catch (e) { return send(res, 200, JSON.stringify({ ok: true, reply: '（AI 暂时连不上：' + String((e && e.message) || e) + '，稍后再试。）' })); }
      // FS-04 v2 治本：AI 不再直接建单——解析 intake-plan 块得 items（一条独立需求一个 item，绝不合并）+ 剔块后可见正文。
      //   服务端不建单，把 items（补 project/site/version/subsystem 兜底）回给前端「确认卡」，用户拍板后走 /api/intake-commit-plan 确定性建单。
      const parsed = parseIntakePlan(reply, type === 'intake' ? '' : type);   // 合并模式让 AI 判类型（forceType 空）；否则强制该类型
      reply = parsed.visible;
      const planItems = parsed.items.map(it => ({ ...it, subsystem: it.subsystem || sub || '' }));   // subsystem 兜底：AI 未填→用户指定的 sub
      // FS-04 AC-36：会话记录持久化——**沟通过就存**（不必建单）。整段 chat = 本轮 messages（去空）+ 剔除计划块后的 AI 可见回复。
      //   按 sessionId upsert 一条 type='intake-conv'（幂等，同会话每轮命中同一条）；建单逻辑挪到 commit-plan、这里不建单。
      try {
        const reporter = user ? (user.name || user.username) : (link ? link.name : '现场');
        // 【时序 bug 修】不再整段盖同一 Date.now()——ts 交给 saveConvRecord→reconcileChatTs 按 prev 对齐补（老消息保留各自 ts、只新消息补递增 ts）。
        const convChat = allMsgs.map(x => ({ role: x.role, text: x.content }));   // 真实完整对话（非水位线折叠的 msgs）；ts 由 saveConvRecord 逐条对齐
        // 【per-message media·2026-08-07】本轮若附了图 → 存到会话级目录（media/<sessionId>/t<turnIndex>/img-N.png，turnIndex=本轮 user 消息下标，避免多轮/工单 media 目录撞）
        //   并把相对路径挂到会话记录「本轮 user 消息」的 msg.media——reopen 对话流时该图随该轮气泡就位（不再只在建单后的工单里）。
        //   会话级 media 走现有 /api/intake-media（project+file）可取；建单时图仍复制到各工单（见 commit-plan，工单详情要显图）。
        if (imgs.length && sessionId) {
          let lastUserIdx = -1; for (let i = convChat.length - 1; i >= 0; i--) { if (convChat[i].role === 'user') { lastUserIdx = i; break; } }
          if (lastUserIdx >= 0) {
            const roundMedia = [];
            try {
              const mdir = path.join(intakeDir(proj), 'media', sessionId, 't' + lastUserIdx);
              fs.mkdirSync(mdir, { recursive: true });
              imgs.forEach((du, i) => { const mm = /^data:image\/\w+;base64,(.+)$/.exec(du || ''); if (mm) { fs.writeFileSync(path.join(mdir, `img-${i + 1}.png`), Buffer.from(mm[1], 'base64')); roundMedia.push(`media/${sessionId}/t${lastUserIdx}/img-${i + 1}.png`); } });
            } catch {}
            if (roundMedia.length) convChat[lastUserIdx].media = roundMedia;
          }
        }
        if (reply) convChat.push({ role: 'assistant', text: reply });   // 只在有可见回复时并入（纯计划块无可见文本则不并、避免空 AI 气泡）
        await saveConvRecord(proj, { sessionId, site, subsystem: sub, version, reporter, role: user ? user.role : 'field', chat: convChat });
      } catch {}
      // 回带 plan（含 project/site/version/subsystem 兜底，供前端建单端点直接用）。savedId/savedIds 恒空（不再自动建单）——老前端字段保留但为空，避免它据此误建卡。
      send(res, 200, JSON.stringify({ ok: true, reply, savedId: '', priority: '', savedIds: [], plan: { items: planItems, project: proj.id, site, version, subsystem: sub, sessionId } }));
    });
  }
  if (url.pathname === '/api/intake-commit-plan' && req.method === 'POST') {   // FS-04 v2（2026-08-07）「建单前确认清单」：按用户在确认卡上拍板的清单确定性建单/补充（AI 不再自动建单）。现场+管理员可调（已进 FIELD_OK/FS08_FIELD_API）。
    return readBody(req, async (b, err) => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(link ? link.project : b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '请先选择所属系统' }));
      const items = Array.isArray(b.items) ? b.items : []; if (!items.length) return send(res, 400, JSON.stringify({ ok: false, error: '清单为空' }));
      const version = String(b.version || '').trim() || (link ? link.ver : '');
      const site = user ? convergeSite(user, b.site) : (String(b.site || '').trim() || (link ? link.site : ''));   // AC-21：登录现场账号 site 服务端收敛到 user.sites（越权→取合法首家）
      const sub = String(b.subsystem || '').trim();
      // 版本服务端派生（修 bug：现场停在「未选具体版本」时 b.version 为空 → 工单版本列显 —）：按提交医院(site)在客户台账里登记的「该产品·该工单子系统」现场版本取。
      //   e.subsystem(itSub) 存英文 key（如 pkb，见 subsystemNames→customer.products[].subsystems[].name 均为英文 name），custSubVersion 按 s.name===sub 命中；
      //   命中不了（子系统待定/中文名/未登记）→ 回退产品级一致版本(custProductVersion) → 回退前端传的 b.version(version) → ''。
      const custForVer = loadCustomers().find(c => (c.name || '').trim() === String(site || '').trim()) || null;
      const prodVer = custForVer ? custProductVersion(custForVer, proj.id) : '';   // 该医院该产品「一致版本」（子系统未命中时的回退）
      const deriveVersion = (itSub) => {
        const bySub = custForVer ? custSubVersion(custForVer, proj.id, itSub) : '';   // 优先：该医院·该产品·该子系统现场版本
        return String(bySub || prodVer || version || '').trim();                      // 兜底链：子系统命中 → 产品级一致 → 前端传值 → 空
      };
      const sessionId = String(b.sessionId || '').trim().slice(0, 40);   // 同会话建的多张单同 sessionId → 右上「对话记录」归一条
      const reporter = user ? (user.name || user.username) : (link ? link.name : '');
      const byRole = user ? user.role : 'field';
      const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6);   // 确认时本轮可带图（多张单各存一份）
      const created = [], appended = [];
      for (const rawIt of items) {
        if (!rawIt || typeof rawIt !== 'object') continue;
        const title = String(rawIt.title || '').trim(); if (!title) continue;   // 无标题跳过（不建脏单）
        const itType = String(rawIt.type || '').toLowerCase() === 'bug' ? 'bug' : 'requirement';
        const itSub = String(rawIt.subsystem || '').trim() || sub || '';
        const summary = String(rawIt.summary || '').trim();
        if (String(rawIt.action || '').toLowerCase() === 'append') {
          // 补充到已建单：校验单号存在 + 属本会话/本人 sites（现场 e.site∈sites，管理员不限）；把 summary 追加到工单 + 留痕。
          const tid = String(rawIt.ticketId || '').trim();
          const e = tid ? loadIntake(proj, tid) : null;
          if (!e || e.deleted || e.type === 'intake-conv' || e.type === 'consult') continue;   // 找不到/软删/非工单 → 跳过该 item（不报错，其余照建）
          if (user && !isAdmin(user)) { const ss = Array.isArray(user.sites) ? user.sites : []; if (e.site && !ss.includes(e.site)) continue; }   // 越权（补充非自己 sites 的单）→ 跳过
          const stamp = nowStamp();
          const addTxt = summary || title;
          e.chat = Array.isArray(e.chat) ? e.chat : []; e.chat.push({ role: 'user', text: '【补充】' + addTxt, ts: Date.now() });   // 补充内容作为一条 user 消息进沟通记录
          e.history = Array.isArray(e.history) ? e.history : []; e.history.push({ from: e.lifecycle || '', to: e.lifecycle || '待处理', by: reporter, byRole, at: stamp, note: '对话补充：' + addTxt.slice(0, 60) });
          e.updatedAt = stamp;
          await saveIntake(proj, e);
          appended.push({ id: e.id });
        } else {
          // 新建工单（复用 intake-chat 建单落库范式：type/title/subsystem/priority/sessionId/site/version/reporter/media/history/analysis）。
          const id = intakeGenId(proj, itType), stamp = nowStamp(), media = [];
          try { const mdir = path.join(intakeDir(proj), 'media', id); if (imgs.length) fs.mkdirSync(mdir, { recursive: true }); imgs.forEach((du, i) => { const mm = /^data:image\/\w+;base64,(.+)$/.exec(du || ''); if (mm) { fs.writeFileSync(path.join(mdir, `img-${i + 1}.png`), Buffer.from(mm[1], 'base64')); media.push(`media/${id}/img-${i + 1}.png`); } }); } catch {}
          const e = { id, type: itType, project: proj.id, version: deriveVersion(itSub), site, subsystem: itSub, module: String(rawIt.module || '').trim(), title, priority: normPriority(rawIt.priority, '中'), severity: String(rawIt.severity || ''), scope: String(rawIt.scope || ''), env: String(rawIt.env || ''), freq: String(rawIt.freq || ''), reporter, role: '', contact: '', bg: String(rawIt.bg || ''), reqDesc: String(rawIt.reqDesc || summary || ''), scene: '', accept: String(rawIt.accept || ''), relate: String(rawIt.relate || ''), desc: String(rawIt.desc || ''), errorInfo: String(rawIt.errorInfo || ''), steps: String(rawIt.steps || ''), expectResult: String(rawIt.expectResult || ''), opinion: String(rawIt.opinion || ''), media, sessionId, status: '待处理', lifecycle: '待处理', assignee: '', history: [{ from: '', to: '待处理', by: reporter, byRole, at: stamp, note: '对话提交（确认清单）' }], analysis: null, resolution: {}, submittedAt: stamp, chat: [] };
          await saveIntake(proj, e);
          created.push({ id, type: itType, title, priority: e.priority });
        }
      }
      send(res, 200, JSON.stringify({ ok: true, created, appended }));
    });
  }
  if (url.pathname === '/api/consult' && req.method === 'POST') {   // 答疑：直连 spec + 经验库直接回答 + 给解决思路
    return readBody(req, (b, err) => {
      const consultRequestId = crypto.randomBytes(5).toString('hex');
      let consultStage = 'preflight';
      let stopSseHeartbeat = () => {};
      void (async () => {
      if (!b) return send(res, 400, JSON.stringify({ ok: false, error: err }));
      const proj = projById(link ? link.project : b.project); if (!proj) return send(res, 400, JSON.stringify({ ok: false, error: '请先选择所属系统' }));   // FS-06 AC-C3/C4：访客咨询归属强制取 link.project（前端 project 被忽略，与 intake-submit/chat 一致）；登录用户 link 为空、取 b.project 不变
      const historyMsgs = consultHistoryMessages(b.messages);
      const msgs = compactConsultModelMessages(historyMsgs);
      if (!historyMsgs.length || !msgs.length) return send(res, 400, JSON.stringify({ ok: false, error: 'empty' }));
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });   // SSE 流式
      stopSseHeartbeat = startConsultSseHeartbeat(res);   // 审计前无正文期间保活，避免代理空闲超时截断成前端空气泡
      const sse = o => {
        if (res.destroyed || res.writableEnded) return false;
        try { res.write('data: ' + JSON.stringify(o) + '\n\n'); return true; } catch { return false; }
      };
      const progress = (stage, options = {}) => {
        const event = consultProgressEvent(stage, options);
        return event ? sse(event) : false;
      };
      progress('preparing');
      const ac = new AbortController(); res.on('close', () => { if (!res.writableEnded) ac.abort(); });   // 客户端断连/点"停止"（响应未正常结束）→ 中止上游模型调用
      const cfg = readModelCfg();
      consultStage = 'refresh';
      try { refreshRepos(proj, false); } catch {}
      const lastUser = [...historyMsgs].reverse().find(m => m.role === 'user'); const qtext = lastUser ? lastUser.content : '';
      const conversationMode = consultConversationMode(qtext);   // pure=纯对话；mixed=表达诉求+事实题；二者都不走机械miss，mixed仍由证据守卫约束事实
      const conversationalTurn = conversationMode === 'pure';
      const retrievalQuery = expandRetrievalQuery(historyMsgs, qtext);   // “它/这个/那…”短追问用上一条 user 问题补实体；只影响检索，不把旧答案当事实
      const sub = String(b.subsystem || '').trim();   // 用户指定的子系统（空=全部）
      const imgs = (Array.isArray(b.images) ? b.images : []).slice(0, 6);   // 本轮附的截图（data URL，≤6）→ 多模态并进末条 user，让 AI 结合图答疑；落库见下方 convId 已知处
      // PD-03：改用带分变体 kbRetrieveScored 一次性拿「带分结果」——hits（喂模型 + kbRefs）由它 .map(x=>x.e) 派生（同 kbRetrieve 召回口径：同 _kbScored/同排序/同 slice/同 minScore=2），
      //   避免为「检索捕获」再对 query 多做一次 embedding 调用（复用同一次计算）。检索异常不阻断咨询：失败即按无命中。
      consultStage = 'retrieval';
      let hits = [], kbScored = [];
      try { kbScored = await kbRetrieveScored(proj.id, retrievalQuery, 5, 2); hits = kbScored.map(x => x.e); } catch { hits = []; kbScored = []; }
      // consult 专用二次门槛：全局 SEM_GATE(0.42) 召回口径下 sim=0.42 的边缘条目也会进 kbScored（与提问相关度很弱、易误引）。
      //   这里过一遍 consultKbFilter（语义 sim≥CONSULT_KB_MIN_SIM=0.5 / 纯词 matchedTerms≥CONSULT_KB_MIN_LEX=3），只让「够强相关」的条目进注入(consultSystem)+kb 事件+kbRefs。
      //   kbScored（全召回）保留原样给 buildRetrieval 检索诊断（「召回了但太弱没注入」本身是有用的排查信息）；仅 hits（喂模型+kbRefs 的口径）收敛为强相关子集。
      hits = consultKbFilter(kbScored).map(x => x.e);
      const cver = String(b.version || '').trim();
      // PD-04：先按提问路由到功能模块（仅对有「功能模块地图」的产品生效）。无地图 → map=null → 完全走原 specSearch（向后兼容）。
      consultStage = 'routing';
      let route = null; try { const map = loadModuleMap(proj, cver); if (map) route = contextualRouteQuestion(map, historyMsgs, qtext, sub); } catch { route = null; }
      const hasMap = !!route;   // 有地图且已跑路由
      const routeMiss = hasMap && !route.matched;   // 路由未命中任何功能模块
      // PD-04 修复：specSearch 始终作底座（有地图也跑）——用带分变体 specSearchScored（同 specSearch 召回口径 + 额外带 score），
      //   一次计算两用：既做喂模型的 spec 底座，又直接喂 buildRetrieval 检索诊断（避免重复检索）。检索异常不阻断答疑。
      let searchScored = []; try { searchScored = specSearchScored(proj, cver, retrievalQuery, 5, sub); } catch { searchScored = []; }
      const searchTop = (searchScored[0] && typeof searchScored[0].score === 'number') ? searchScored[0].score : 0;
      let specHits, routeMnc = [], usedSpecSearch = false, specNoSpec = false;
      if (hasMap) {
        // PD-04 修复：specSearch 作底座、路由作「精选事实」加成（不再排他替换）。命中→读章节 + answerFacts 顶段作 routeHits；
        //   assembleConsultSpecHits 负责「命中=route置前+specSearch去重合并 / 未命中=specSearch 够强则用、否则空」。
        let routeHits = [];
        if (route.matched) { try { const ctx = loadRouteContext(proj, cver, route); routeHits = ctx.specHits || []; routeMnc = ctx.mustNotConfuse || []; } catch { routeHits = []; } }
        const asm = assembleConsultSpecHits(!!route.matched, routeHits, searchScored, SPEC_MIN_RELEVANT);
        specHits = asm.specHits; usedSpecSearch = asm.usedSpecSearch; specNoSpec = asm.noSpec;
        // 发布前关系事实终审只可使用本轮真正注入模型的 current route/spec
        // 证据。保存文本供 content JSON 的“整份/整体快照”等直接限定复核；
        // 不从全局地图或未召回相邻模块扩展。
        if (route.matched) route.directEvidenceFacts = (asm.directEvidenceHits || []).map(hit => String((hit && hit.text) || '')).filter(Boolean);
      } else {
        specHits = specSearch(proj, cver, retrievalQuery, 5, sub);   // 无地图产品：同样用已补实体的检索问题；正文证据边界仍由 qtext 控制
      }
      // 深入思考(源码)单独走：codeSearch 用当前 specHits 当桥（命中=路由+specSearch 合集，miss+specSearch 强=specSearch，无地图=specSearch）。
      const codeHits = b.deep ? codeSearch(proj, cver, retrievalQuery, hasMap ? (specHits || []) : specHits, 4, sub) : null;
      // PD-04 miss 判定（修复）：路由未命中 且 specSearch 底座也弱/空（specNoSpec），且（非 deep，或 deep 但源码也无命中）→ 不调模型、返回固定话术。
      //   即：specSearch 强匹配时，即便路由未命中也不再走固定话术——由提示词功能级覆盖判定据 spec 底座答/说没覆盖。
      const safeDiagnostic = consultSafeDiagnosticIntent(qtext);   // 无直接业务证据时仍允许模型给观察型、非破坏的最小留证步骤；不放松具体事实证据门
      const noAnswer = !conversationMode && !safeDiagnostic && routeMiss && specNoSpec && !(b.deep && codeHits && codeHits.length);
      // PD-03 检索诊断：把「实际喂给 AI 的三类检索内容」组装成紧凑 retrieval 对象，挂到本轮 assistant 消息（与 kbRefs 同位置、同持久化路径）。
      //   spec 复用上面已算的 searchScored（同 specSearch 召回口径、带 score）；kb 复用 kbScored；code 无分。捕获不阻断答疑（try 静默）。
      //   PD-04：把「路由决策」并进 retrieval.routing，并带上「是否用了 specSearch 底座 + specSearch 首条分」方便回放判断。
      let retrieval = null;
      try {
        retrieval = buildRetrieval({ query: qtext, deep: !!b.deep, ver: cver, subsystem: sub }, searchScored, kbScored, codeHits);
        retrieval.conversationIntent = !!conversationMode;
        retrieval.conversationIntentMode = conversationMode;
        retrieval.audienceMode = consultAudienceMode(qtext);
        retrieval.routing = routingDiag(hasMap, route);
        if (retrieval.routing && retrieval.routing.enabled) { retrieval.routing.usedSpecSearch = usedSpecSearch; retrieval.routing.specTop = Math.round(searchTop * 1000) / 1000; retrieval.routing.specMinRelevant = SPEC_MIN_RELEVANT; }
      } catch {}
      const kbRefs = consultKbRefs(proj.id, hits);
      // 只有模型已收到含 kbBlock 的 system prompt 且真正返回首个有效片段，才对前端声明“已参考经验”。
      // 未配模型、上游在首 token 前失败、检索失败/无命中都不发 kb 事件，避免把“检索到”误报为“模型已参考”。
      let reply = '', stopped = false, kbInjected = false, answerStream = null;
      // 只允许“完成审计后的安全终稿”进入这个发布口。草稿与一次修订稿始终留在服务端内存；
      // 用户在终稿流式阶段停止时，只持久化已经送达的安全终稿前缀，不把未显示全文写进会话。
      const publishSafeFinal = async (text, extra = {}) => {
        const finalText = String(text == null ? '' : text).trim();
        if (!finalText) return '';
        progress('publishing');
        const streamed = await consultStreamFinalAnswer(finalText, chunk => sse({ ...extra, v: chunk }), {
          signal: ac.signal,
          isClosed: () => res.destroyed || res.writableEnded,
          delayMs: 45,
        });
        answerStream = { mode: streamed.mode, totalChunks: streamed.totalChunks, sentChunks: streamed.sentChunks, completed: !streamed.stopped && streamed.sentChunks === streamed.totalChunks };
        if (retrieval) retrieval.answerStream = answerStream;
        if (streamed.stopped) stopped = true;
        return streamed.sentText;
      };
      if (noAnswer) {   // PD-04 miss：不调模型答实质内容，直接返回固定话术（正常收尾、可落库该轮）。
        const operationEvidenceStop = route && Array.isArray(route.explicitOperationEvidenceMiss) && route.explicitOperationEvidenceMiss.length
          ? consultOperationEvidenceStopReply()
          : '';
        reply = await publishSafeFinal(operationEvidenceStop || ('该问题在《' + proj.name + '》说明书里没有找到相关描述，建议转成工单或联系开发确认。'));
      } else if (!cfg.apiKey) { reply = await publishSafeFinal('（管理员还没配置模型 API，暂时不能答疑。）'); }
      else {
        // PD-04：命中 mustNotConfuse → 作负向提示注入 system（易混淆项，勿臆造）。answerFacts 已在 specHits 顶段（consultSystem 走 specExcerpts）。
        const mncNote = routeMnc.length ? '\n【以下为该问题的易混淆项，请勿臆造、勿张冠李戴】' + routeMnc.map(x => '\n· ' + x).join('') : '';
        consultStage = 'prompt';
        const consultPrompt = consultSystem(proj, cver, hits, specHits, codeHits, qtext) + '\n' + consultAudienceGuard(qtext) + '\n' + currentTurnEvidenceGuard(qtext, specHits) + '\n' + consultConversationGuard(qtext, conversationMode) + '\n' + consultEvidenceLedgerGuard(qtext, route) + '\n' + consultCurrentRulingGuard(qtext, route) + '\n' + consultRuleApplicationGuard(qtext, route) + '\n' + consultPatientIdentityGuard(qtext, route) + '\n' + consultCriticalContextGuard(qtext, route) + '\n' + consultFocusedFactGuard(qtext) + '\n' + consultExactPathBoundaryGuard(qtext, route) + '\n' + consultGenericControlledActionGuard(qtext) + '\n' + consultOperationalSafetyGuard(qtext, route) + '\n' + consultFileArtifactGuard(qtext, route) + '\n' + consultDiagnosticGuard(qtext, route) + '\n' + consultNonDestructiveDiagnosticGuard(qtext, route) + '\n' + consultFinalActionConsistencyGuard(qtext, route) + '\n' + consultEvidenceLikelihoodGuard(qtext, route) + mncNote + (imgs.length ? '\n用户本轮可能附了截图，请结合图片理解问题。' : '');
        let draft = '', firstError = null;
        // 草稿和必要修订共用同一个 deadline；用户停止信号排在同一组合信号中，且错误映射时仍以用户停止优先。
        const consultModelSignal = consultModelDeadlineSignal(ac.signal);
        try {
          // 先完整生成到服务端内存，发布前做确定性语义校验；未通过的草稿绝不先流给浏览器。
          consultStage = 'model_draft';
          await callModelStream(cfg, { system: consultPrompt, messages: msgs, images: imgs, maxTokens: b.deep ? CONSULT_DEEP_DRAFT_MAX_TOKENS : CONSULT_DRAFT_MAX_TOKENS, onAttempt: attempt => progress('generating', attempt) }, piece => {
            piece = String(piece == null ? '' : piece); if (piece) draft += piece;
          }, consultModelSignal);
        } catch (e) {
          if (ac.signal.aborted) stopped = true;
          else firstError = e;
        }

        if (draft.trim() && !firstError) {
          consultStage = 'answer_audit';
          progress('auditing');
          const initialAudit = consultAnswerSemanticAudit(draft, qtext, route);
          let finalAudit = initialAudit;
          let revisionAudit = null;
          let revisionAttempted = false, revisionAccepted = false, fallbackUsed = false, fallbackPasses = 0;
          reply = draft;
          if (initialAudit.violations.length && !stopped) {
            revisionAttempted = true;
            let revised = '', revisionError = null;
            try {
              progress('revising');
              await callModelStream(cfg, {
                system: consultPrompt + '\n' + consultAnswerRevisionPrompt(draft, initialAudit),
                messages: msgs,
                images: imgs,
                maxTokens: b.deep ? CONSULT_DEEP_DRAFT_MAX_TOKENS : CONSULT_DRAFT_MAX_TOKENS,
                onAttempt: attempt => progress('revising', attempt),
              }, piece => { piece = String(piece == null ? '' : piece); if (piece) revised += piece; }, consultModelSignal);
            } catch (error) { revisionError = error; }
            if (revised.trim() && !revisionError) {
              const revisedAudit = consultAnswerSemanticAudit(revised, qtext, route);
              revisionAudit = revisedAudit;
              finalAudit = revisedAudit;
              if (!revisedAudit.violations.length) { reply = revised; revisionAccepted = true; }
            }
            if (!revisionAccepted) {
              reply = consultAnswerSafeFallback(draft, initialAudit); fallbackPasses = 1;
              finalAudit = consultAnswerSemanticAudit(reply, qtext, route); fallbackUsed = true;
              if (finalAudit.violations.length) {
                reply = consultAnswerSafeFallback(reply, finalAudit); fallbackPasses = 2;
                finalAudit = consultAnswerSemanticAudit(reply, qtext, route);
              }
              if (finalAudit.violations.length) {
                const recovered = consultRecoverSafeDiagnostic(initialAudit, qtext, route);
                if (recovered) {
                  reply = recovered.reply; finalAudit = recovered.audit;
                  fallbackPasses = 3 + recovered.passes;
                }
              }
              // 草稿和修订都失败时，仍优先尝试人工 route 的完整 verifiedFacts
              // 终稿。尤其 partial_evidence/chain 问法不能因为模型两轮失败而
              // 退成通用“未通过安全校验”占位；没有 route 或终审不通过则继续
              // 使用下面的严格停止文案。
              if (finalAudit.violations.length) {
                const verifiedFacts = consultVerifiedFactsFallback(qtext, route);
                if (verifiedFacts) {
                  reply = verifiedFacts.reply;
                  finalAudit = verifiedFacts.finalAudit;
                  fallbackPasses += 1;
                }
              }
              if (finalAudit.violations.length) {
                reply = '当前回答未通过发布前事实与动作安全校验，已停止发布未经证实的判断；请先按当前已核事实和已有只读证据继续核对。';
                finalAudit = consultAnswerSemanticAudit(reply, qtext, route);
              }
            }
          } else if (initialAudit.violations.length) {
            reply = consultAnswerSafeFallback(draft, initialAudit); fallbackPasses = 1;
            finalAudit = consultAnswerSemanticAudit(reply, qtext, route); fallbackUsed = true;
            if (finalAudit.violations.length) {
              reply = consultAnswerSafeFallback(reply, finalAudit); fallbackPasses = 2;
              finalAudit = consultAnswerSemanticAudit(reply, qtext, route);
            }
            if (finalAudit.violations.length) {
              const recovered = consultRecoverSafeDiagnostic(initialAudit, qtext, route);
              if (recovered) {
                reply = recovered.reply; finalAudit = recovered.audit;
                fallbackPasses = 3 + recovered.passes;
              }
            }
            if (finalAudit.violations.length) {
              const verifiedFacts = consultVerifiedFactsFallback(qtext, route);
              if (verifiedFacts) {
                reply = verifiedFacts.reply;
                finalAudit = verifiedFacts.finalAudit;
                fallbackPasses += 1;
              }
            }
            if (finalAudit.violations.length) {
              reply = '当前回答未通过发布前事实与动作安全校验，已停止发布未经证实的判断；请先按当前已核事实和已有只读证据继续核对。';
              finalAudit = consultAnswerSemanticAudit(reply, qtext, route);
            }
          }
          const answerAudit = {
            version: 2,
            checked: true,
            initialViolations: initialAudit.violations,
            initialChainRequested: !!initialAudit.chainRequested,
            initialMissingChainDimensions: initialAudit.missingChainDimensions || [],
            initialUnexpectedPaths: initialAudit.unexpectedPaths || [],
            initialUnexpectedEntities: initialAudit.unexpectedEntityTerms || [],
            routeFallbackMode: initialAudit.routeFallbackMode || '',
            verifiedFactsFallback: !!initialAudit.verifiedFactsFallback,
            revisionAttempted,
            revisionAccepted,
            revisionViolations: revisionAudit ? revisionAudit.violations : [],
            fallbackUsed,
            fallbackPasses,
            fallbackSource: fallbackUsed
              ? ((initialAudit.verifiedFactsFallback || finalAudit.verifiedFactsFallback) ? 'verifiedFacts' : 'safeSanitizer')
              : '',
            finalViolations: finalAudit.violations,
            finalChainRequested: !!finalAudit.chainRequested,
            finalMissingChainDimensions: finalAudit.missingChainDimensions || [],
            finalUnexpectedPaths: finalAudit.unexpectedPaths || [],
            finalUnexpectedEntities: finalAudit.unexpectedEntityTerms || [],
            likelihoodEvidence: initialAudit.likelihoodAllowed,
          };
          if (retrieval) {
            retrieval.answerAudit = answerAudit;
            if (answerAudit.fallbackSource) retrieval.fallbackSource = answerAudit.fallbackSource;
          }
          sse({ answerAudit });
          if (!kbInjected && kbRefs.length) { kbInjected = true; sse({ kb: kbRefs, kbInjected: true }); }
          reply = await publishSafeFinal(reply);
        } else if (firstError && !stopped) {
          console.error(`[consult-error] request=${consultRequestId} stage=model_draft message=${String((firstError && firstError.message) || firstError).replace(/[\r\n]+/g, ' ').slice(0, 500)}`);
          // 完整业务链等 verifiedFacts 路由已有逐句审核过的确定性事实。
          // 模型因长度上限或临时故障未能产出时，优先发布这些事实；普通路由
          // 仍保持明确报错，不能把任意检索片段伪装成完整答案。
          progress('fallback');
          const modelDraftError = consultModelErrorInfo(firstError);
          const verifiedFallback = consultModelFailureFallback(qtext, route, firstError);
          if (retrieval) {
            retrieval.modelDraftError = modelDraftError;
            retrieval.fallbackSource = verifiedFallback ? verifiedFallback.fallbackSource : 'model_error';
          }
          if (verifiedFallback) {
            reply = verifiedFallback.reply;
            const answerAudit = {
              version: 2,
              checked: true,
              modelDraftError: true,
              modelDraftErrorInfo: verifiedFallback.modelDraftError,
              fallbackSource: verifiedFallback.fallbackSource,
              initialViolations: [],
              initialChainRequested: !!verifiedFallback.initialAudit.chainRequested,
              initialMissingChainDimensions: verifiedFallback.initialAudit.missingChainDimensions || [],
              initialUnexpectedPaths: [],
              initialUnexpectedEntities: [],
              routeFallbackMode: verifiedFallback.initialAudit.routeFallbackMode || '',
              verifiedFactsFallback: !!verifiedFallback.initialAudit.verifiedFactsFallback,
              revisionAttempted: false,
              revisionAccepted: false,
              revisionViolations: [],
              fallbackUsed: true,
              fallbackPasses: 1,
              fallbackAnswerMode: verifiedFallback.initialAudit.fallbackAnswerMode || 'facts',
              finalViolations: verifiedFallback.finalAudit.violations,
              finalChainRequested: !!verifiedFallback.finalAudit.chainRequested,
              finalMissingChainDimensions: verifiedFallback.finalAudit.missingChainDimensions || [],
              finalUnexpectedPaths: [],
              finalUnexpectedEntities: [],
              likelihoodEvidence: verifiedFallback.initialAudit.likelihoodAllowed,
            };
            if (retrieval) retrieval.answerAudit = answerAudit;
            sse({ answerAudit });
            if (!kbInjected && kbRefs.length) { kbInjected = true; sse({ kb: kbRefs, kbInjected: true }); }
            reply = await publishSafeFinal(reply);
          } else {
            // 无 route/无 verifiedFacts 或兜底终审仍失败时，先发诊断元数据，再
            // 发可见 err 正文；这样不会把真正的协议/服务错误伪装成成功答案。
            const answerAudit = {
              version: 2,
              checked: true,
              modelDraftError: true,
              modelDraftErrorInfo: modelDraftError,
              fallbackSource: 'model_error',
              routeFallbackMode: (route && (route.fallbackMode || (route.route && route.route.fallbackMode))) || '',
              verifiedFactsFallback: false,
              fallbackUsed: false,
              fallbackPasses: 0,
              finalViolations: [],
            };
            if (retrieval) retrieval.answerAudit = answerAudit;
            sse({ answerAudit });
            const m = `（AI 暂时连不上，请稍后重试。错误编号：${consultRequestId}。）`; reply = await publishSafeFinal(m, { err: true, code: 'consult_model_error', requestId: consultRequestId, stage: 'model_draft' });
          }
        }
      }
      reply = reply.trim();
      // 持久化答疑会话（含部分/停止的内容），随聊随存、可在「我的提交」找回（type=consult，默认不进开发工单收件箱）
      consultStage = 'persist';
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
        const firstUser = historyMsgs.find(m => m.role === 'user');
        const title = (prev && String(prev.title || '').trim()) ? prev.title : (((firstUser && firstUser.content) || (historyMsgs[0] && historyMsgs[0].content) || '系统咨询').replace(/\s+/g, ' ').trim().slice(0, 60));
        const chat = [...historyMsgs.map(x => ({ role: x.role, text: x.content })), { role: 'assistant', text: reply, ts: Date.now() }];
        // Part B（per-message media · consult）：consult 每轮用整段 msgs 重建 chat（会丢前几轮消息级 media）——
        //   ① 先把上一版 prev.chat 里 user 消息带的 media 按「第 K 条 user」顺序回贴到重建后的 chat；② 再把本轮新增图挂到「最后一条 user」（=本轮发言）。
        //   前端 msgs 只有 {role,content} 无 media，故必须从 prev.chat 补齐历史轮，避免 reopen 时旧轮图丢失。
        try {
          const prevUserMedia = (prev && Array.isArray(prev.chat) ? prev.chat : []).filter(m => m && m.role === 'user').map(m => (Array.isArray(m.media) ? m.media.slice() : null));
          let ui = 0; for (const m of chat) { if (m.role === 'user') { const pm = prevUserMedia[ui]; if (pm && pm.length) m.media = pm; ui++; } }
          if (roundMedia.length) { for (let i = chat.length - 1; i >= 0; i--) { if (chat[i].role === 'user') { chat[i].media = ((chat[i].media || []).concat(roundMedia)); break; } } }
        } catch {}
        // 续聊会用请求 messages 重建整段 chat：按第 K 条 assistant 回贴旧引用，再把本轮真实使用的引用挂到最后一条 assistant。
        // 客户端 payload 只传 role/content，引用事实始终以服务端上一版 chat + 本轮首 token 门控为准。
        try {
          const prevAiRefs = (prev && Array.isArray(prev.chat) ? prev.chat : []).filter(m => m && m.role === 'assistant').map(m => consultKbRefs(proj.id, m.kbRefs));
          let ai = 0;
          for (let i = 0; i < chat.length - 1; i++) if (chat[i].role === 'assistant') { const refs = prevAiRefs[ai++]; if (refs && refs.length) chat[i].kbRefs = refs; }
          if (kbInjected && kbRefs.length) chat[chat.length - 1].kbRefs = kbRefs;
        } catch {}
        // PD-03：retrieval 与 kbRefs 同位置回贴——续聊时按第 K 条 assistant 回贴历史轮 retrieval（前端 payload 不带它），再把本轮 retrieval 挂到最后一条 assistant。
        try {
          const prevRetr = (prev && Array.isArray(prev.chat) ? prev.chat : []).filter(m => m && m.role === 'assistant').map(m => (m && m.retrieval) || null);
          let ri = 0;
          for (let i = 0; i < chat.length - 1; i++) if (chat[i].role === 'assistant') { const r = prevRetr[ri++]; if (r) chat[i].retrieval = r; }
          if (retrieval) chat[chat.length - 1].retrieval = retrieval;
        } catch {}
        const rec = { id: convId, type: 'consult', project: proj.id, version: String(b.version || '').trim() || (link ? link.ver : ''), site: String(b.site || '').trim() || (link ? link.site : ''), subsystem: sub, module: '', title, priority: '', reporter, role: user ? user.role : 'field', contact: '', media, status: '沟通中', lifecycle: '已答复', assignee: '', analysis: null, resolution: {}, chat, submittedAt: (prev && prev.submittedAt) || nowStamp(), updatedAt: nowStamp() };
        await saveIntake(proj, rec);
      } catch (e) { convId = ''; throw e; }
      consultStage = 'done';
      sse({ done: true, convId, kbHits: kbInjected ? kbRefs.length : 0, stopped, answerStream });
      stopSseHeartbeat();
      try { res.end(); } catch {}
      })().catch(error => {
        stopSseHeartbeat();
        finishConsultSseError(res, error, { requestId: consultRequestId, stage: consultStage });
      });
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
          const sys = renderPromptTpl(DATA_DIR, 'kbFromConsult', {});   // PD-02：模板外部化（无占位），默认逐字不变
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
    // 注（FS-04 2026-08-06）：API 仍返回 consult 桶（保持 FS-02 契约不变），但实施端左侧 renderTypeView 只渲 requirement/bug、咨询移到右上「对话记录」（/api/field/conversations）。不改此处 API 桶集以免波及 FS-02 spec/测试；由前端过滤实现「左侧只列工单」。
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
  if (url.pathname === '/api/field/conversations') {
    // FS-04（AC-36，2026-08-06 全量持久化改造）：右上「对话记录」数据源——列**会话记录**（不再靠工单归组），沟通过就在这。
    //   ① 咨询（consult）：每条记录=一次会话，各自一项（reopen 走 reopenConsult）。
    //   ② 提需求/报BUG 会话：以 type='intake-conv' 会话记录为主（一条=一次聊天，**含未建单的**，reopen 从它恢复整段 chat）；
    //      每条按 sessionId 关联本会话建的 requirement/bug 工单，统计 reqCount/bugCount/tickets 供前端补「已建单」卡。
    //   ③ 兼容旧数据：老 session（有工单但无 intake-conv 会话记录）→ 仍按工单 sessionId 归组兜底（代表工单=最早提交，chat 从它取），别让历史工单会话消失。
    //   过滤 deleted（软删的会话记录/咨询不出现）。收敛口径与 /api/field/submissions 一致（user.projects + scopedForField 按 sites）。均按 updatedAt 倒序。
    if (!user) return send(res, 401, JSON.stringify({ error: '未登录' }));
    const myProjects = Array.isArray(user.projects) ? user.projects : [];
    // 取「原始记录」（含 sessionId/chat/type；listIntake 出参不带 sessionId 且已排除 intake-conv，故直读缓存），仍按同一收敛链过滤越权。
    let raw = [];
    for (const p of loadProjects()) {
      if (!isAdmin(user) && myProjects.length && !myProjects.includes(p.id)) continue;   // 产品范围收敛
      const m = CACHE.intakes[p.id] || {};
      for (const e of Object.values(m)) {
        if (e.deleted) continue;                                                          // 软删（会话记录/咨询/工单）不出现
        if (e.type !== 'consult' && e.type !== 'requirement' && e.type !== 'bug' && e.type !== 'intake-conv') continue;
        raw.push(Object.assign({ project: p.id }, e));
      }
    }
    raw = scopedForField(user, raw);   // 按 me.sites（+project）过滤越权（与 submissions 同源，收敛数据）
    // 软删掉的会话记录（intake-conv）其 session 键——用于让「删对话记录」后该会话**从对话记录彻底消失**：
    //   即便它建过工单，也不要在下面用旧数据兜底把它按工单 sessionId 重新拉回来（工单仍在左侧提交清单，只是不在对话记录）。
    const deletedConvKeys = new Set();
    for (const p of loadProjects()) {
      if (!isAdmin(user) && myProjects.length && !myProjects.includes(p.id)) continue;
      const m = CACHE.intakes[p.id] || {};
      for (const e of Object.values(m)) { if (e.type === 'intake-conv' && e.deleted) { const sid = String(e.sessionId || '').trim(); if (sid) deletedConvKeys.add(p.id + '|' + sid); } }
    }
    const firstUserText = (e) => { const c = Array.isArray(e.chat) ? e.chat : []; const u = c.find(m => m && m.role === 'user' && (m.text || '').trim()); return u ? String(u.text).trim() : ''; };
    const items = [];
    // consult：每条一项
    for (const e of raw) {
      if (e.type !== 'consult') continue;
      items.push({ kind: 'consult', id: e.id, project: e.project, title: (e.title || firstUserText(e) || '系统咨询').slice(0, 60), site: e.site || '', subsystem: e.subsystem || '', updatedAt: e.updatedAt || e.submittedAt || '' });
    }
    // 先把 requirement/bug 工单按 (project, sessionId) 索引，供会话记录关联 + 兜底归组共用
    const ticketsBySession = new Map();   // 'proj|sid' → [{id,type,priority,subsystem,version,submittedAt,updatedAt,site,chat}]
    for (const e of raw) {
      if (e.type !== 'requirement' && e.type !== 'bug') continue;
      const sid = String(e.sessionId || '').trim();
      const k = sid ? (e.project + '|' + sid) : ('solo|' + e.project + '|' + e.id);   // 有 sessionId 归一组；无则单条自成一组
      (ticketsBySession.get(k) || (ticketsBySession.set(k, []).get(k))).push(e);
    }
    const usedTicketKeys = new Set();   // 已被 intake-conv 会话记录关联掉的工单组（避免兜底重复列）
    // ② intake-conv 会话记录：一条=一次聊天（含未建单）；关联本会话工单统计单数
    for (const e of raw) {
      if (e.type !== 'intake-conv') continue;
      const sid = String(e.sessionId || '').trim();
      const k = e.project + '|' + sid;
      const rel = (sid && ticketsBySession.get(k)) || [];   // 本会话建的工单（可能 0 张=未建单）
      if (sid) usedTicketKeys.add(k);
      const tickets = rel.map(t => ({ id: t.id, type: t.type, priority: t.priority || '中', subsystem: t.subsystem || '', version: t.version || '', submittedAt: t.submittedAt || '' }))
        .sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
      const reqN = tickets.filter(t => t.type === 'requirement').length;
      const bugN = tickets.filter(t => t.type === 'bug').length;
      // updatedAt 取会话记录与关联工单里最新，避免建单/续聊后会话记录排序落后
      let ua = e.updatedAt || e.submittedAt || '';
      for (const t of rel) { const tu = t.updatedAt || t.submittedAt || ''; if (tu > ua) ua = tu; }
      items.push({ kind: 'intake', id: e.id, project: e.project, sessionId: sid, title: (firstUserText(e) || e.title || '对话提交').slice(0, 60), site: e.site || '', subsystem: e.subsystem || '', ticketCount: tickets.length, reqCount: reqN, bugCount: bugN, tickets, updatedAt: ua, fromConv: true });
    }
    // ③ 兜底：有工单但无 intake-conv 会话记录的旧 session → 按工单 sessionId 归组（代表工单=最早提交，reopen 从它取整段 chat）
    for (const [k, arr] of ticketsBySession.entries()) {
      if (usedTicketKeys.has(k)) continue;   // 已被（未删）会话记录关联 → 不重复
      if (deletedConvKeys.has(k)) continue;  // 该会话记录已被软删 → 从对话记录彻底消失（工单仍在左侧提交清单，此处不兜底拉回）
      let rep = arr[0]; let site = arr[0].site || ''; let subsystem = arr[0].subsystem || ''; let updatedAt = '';
      for (const e of arr) { if ((e.submittedAt || '') < (rep.submittedAt || '')) rep = e; const eu = e.updatedAt || e.submittedAt || ''; if (eu > updatedAt) updatedAt = eu; }
      const tickets = arr.map(t => ({ id: t.id, type: t.type, priority: t.priority || '中', subsystem: t.subsystem || '', version: t.version || '', submittedAt: t.submittedAt || '' }))
        .sort((a, b) => String(a.submittedAt || '').localeCompare(String(b.submittedAt || '')));
      const reqN = tickets.filter(t => t.type === 'requirement').length;
      const bugN = tickets.filter(t => t.type === 'bug').length;
      items.push({ kind: 'intake', id: rep.id, project: rep.project, sessionId: String(rep.sessionId || '').trim(), title: (firstUserText(rep) || rep.title || '对话提交').slice(0, 60), site, subsystem: subsystem || rep.subsystem || '', ticketCount: tickets.length, reqCount: reqN, bugCount: bugN, tickets, updatedAt, fromConv: false });
    }
    items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));   // 均按 updatedAt 倒序
    return send(res, 200, JSON.stringify({ items }));
  }

  // ---------- GET /api/field/overview：实施端「个人全览图」（FS-09）----------
  //   两维度卡：A 医院维度（每家我负责医院一张卡）+ B 产品维度（每个我负责产品一张卡·跨院聚合总览）。
  //   服务端按 user.sites + user.projects 收敛，忽略前端越权传参（口径与 /api/field/submissions、/api/field/batches 完全一致）。
  //   数据来源全部复用现成 helper（禁止臆造库表/列）：loadProjects/listIntake/scopedForField（工单）、loadCustomers（客户/维保/现场版本）、
  //     loadBatches + batchTicketsForUser（批次覆盖工单）、fieldStatusLabel（4 阶段归并同源）、kbSubLabel（子系统中文名）、projById（产品名）。
  //   纯聚合在 tools/fs-09-overview-logic.mjs（脱 DB 可单测）。
  if (url.pathname === '/api/field/overview') {
    if (!user) return send(res, 401, JSON.stringify({ error: '未登录' }));   // authGate 已挡，双保险
    const mySites = fieldSites(user);   // null=管理员不限
    const myProjects = (!isAdmin(user) && Array.isArray(user.projects) && user.projects.length) ? user.projects.map(String) : null;   // null=不限
    // 工单：与 /api/field/submissions 同源——loadProjects → listIntake（无 consult）→ scopedForField（按 sites+project 越权裁掉）
    let allTickets = [];
    for (const p of loadProjects()) {
      if (myProjects && !myProjects.includes(p.id)) continue;   // 产品范围收敛
      for (const it of listIntake(p, { withConsult: false })) { allTickets.push(Object.assign({ project: p.id }, it)); }
    }
    allTickets = scopedForField(user, allTickets);   // 忽略前端越权，按 me.sites（+project）裁掉
    // 批次：每个批次挂 _mineTickets = 该账号 sites 范围内覆盖工单（管理员=全部覆盖工单），供纯逻辑判「覆盖我几家院/待下载/待更新」
    const batches = [];
    for (const bt of loadBatches()) {
      if (myProjects && !myProjects.includes(bt.product)) continue;   // 产品范围收敛
      const proj = projById(bt.product);
      // 附派生 lifecycle（e.lifecycle 可能为空，同 /api/field/batches 口径 e.lifecycle||deriveLifecycle(e)）——
      //   纯逻辑用工单生命周期判「本院已应用某批」（全部覆盖单已关闭/已交付），比版本字符串相等稳（见 appliedToSite）。
      const mine = batchTicketsForUser(bt, proj, mySites).map(e => Object.assign({}, e, { lifecycle: e.lifecycle || deriveLifecycle(e) }));
      batches.push(Object.assign({}, bt, { _mineTickets: mine }));
    }
    // 客户台账（按医院名匹配，与 custWithTicketCount/customer-version 一致）
    const custByName = new Map();
    for (const c of loadCustomers()) { const nm = String((c && c.name) || '').trim(); if (nm) custByName.set(nm, c); }
    // 我负责医院集合：非管理员 = user.sites；管理员 = 工单/批次里出现过的 site（无固定 sites，取其相关院）
    let sitesForCards;
    if (mySites) sitesForCards = mySites.slice();
    else {
      const s = new Set();
      for (const it of allTickets) { const nm = String((it && it.site) || '').trim(); if (nm) s.add(nm); }
      for (const c of custByName.keys()) s.add(c);   // 管理员也把台账里的院纳入（便于看全景）
      sitesForCards = [...s];
    }
    // 我负责产品集合：非管理员 = user.projects；管理员 = 工单/批次里出现过的产品
    let productIds;
    if (myProjects) productIds = myProjects.slice();
    else {
      const s = new Set();
      for (const it of allTickets) { const pid = String((it && it.project) || '').trim(); if (pid) s.add(pid); }
      for (const bt of batches) { if (bt.product) s.add(String(bt.product)); }
      productIds = [...s];
    }
    const deps = { fieldStatusLabelFn: fieldStatusLabel, subLabelFn: kbSubLabel, projNameFn: (id) => (projById(id) || {}).name || id, today: ovTodayParts() };
    const hospitals = ovBuildHospitalCards(sitesForCards, allTickets, batches, custByName, myProjects, user.username || '', deps);
    const products = ovBuildProductCards(productIds, allTickets, batches, custByName, sitesForCards, user.username || '', deps);
    // 医院卡按「待验证多的、临期/过期、紧急多的」优先靠前，便于现场一眼盯重点；同权按名稳定排序
    const mntRank = { expired: 0, soon: 1, normal: 2, none: 3 };
    hospitals.sort((a, b) => (b.stages.verify - a.stages.verify) || (b.urgent - a.urgent) || (mntRank[a.maintainStatus] - mntRank[b.maintainStatus]) || String(a.site).localeCompare(String(b.site)));
    products.sort((a, b) => String(a.productName).localeCompare(String(b.productName)));
    return send(res, 200, JSON.stringify({
      me: { username: user.username || '', name: user.name || user.username || '', siteCount: sitesForCards.length, projectCount: productIds.length },
      hospitals, products,
    }));
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
