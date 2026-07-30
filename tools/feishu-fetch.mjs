#!/usr/bin/env node
// 飞书文档拉取：node tools/feishu-fetch.mjs "<飞书文档链接>"
// 读 ~/.steward/feishu.json 里【当前项目】的机器人凭据(按 STEWARD_PROJECT_ID，兜底用 cwd 反查 projects.json)，
// 拿 tenant_access_token → 解析链接(docx / wiki / docs) → 取正文纯文本，打到 stdout。供 /intake 分诊用。零依赖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let API = process.env.FEISHU_API_BASE || 'https://open.feishu.cn';   // 按项目 domain 自动切：国际版 Lark → open.larksuite.com（main 里据 creds.domain 调整）
const DATA_DIR = process.env.STEWARD_DATA || path.join(os.homedir(), '.steward');

function die(msg) { console.error('feishu-fetch: ' + msg); process.exit(1); }

function resolveProjectId() {
  // cwd 优先：终端实际所在目录 = 真实项目，最可靠。STEWARD_PROJECT_ID 仅当 cwd 不在任何项目内时兜底——
  // env 可能因窗口复用 / 孤儿 ttyd 与实际目录串掉，故绝不让它压过 cwd。
  try {
    const ps = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'projects.json'), 'utf8')).projects || [];
    const cwd = process.cwd(); let best = null;
    for (const p of ps) if (p.path && (cwd === p.path || cwd.startsWith(p.path + '/'))) { if (!best || p.path.length > best.path.length) best = p; }   // 最长匹配，避免嵌套/前缀误命中
    if (best) return best.id;
  } catch {}
  return process.env.STEWARD_PROJECT_ID || '';
}

function loadCreds() {
  const pid = resolveProjectId();
  if (!pid) die('无法确定当前项目(STEWARD_PROJECT_ID 缺失)；请在控制台的项目终端里运行 /intake。');
  let map = {};
  try { map = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'feishu.json'), 'utf8')); } catch {}
  const c = map[pid];
  if (!c || !c.appId || !c.appSecret) die(`项目「${pid}」还没配飞书机器人 → 控制台顶栏「飞书配置」填 App ID / App Secret 后重试。`);
  return c;
}

async function tenantToken(c) {
  const r = await fetch(`${API}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: c.appId, app_secret: c.appSecret }),
  });
  const j = await r.json();
  if (j.code !== 0) die(`拿 tenant_access_token 失败(${j.code}): ${j.msg}（核对 App ID / Secret）`);
  return j.tenant_access_token;
}

function parseUrl(u) {
  const m = String(u).match(/\/(docx|docs|wiki|base)\/([A-Za-z0-9]+)/);
  if (!m) die('链接无法识别(需含 /docx/、/wiki/、/base/(多维表格) 或 /docs/)');
  return { kind: m[1], token: m[2], raw: String(u) };
}

async function api(token, p) {
  const r = await fetch(`${API}${p}`, { headers: { Authorization: `Bearer ${token}` } });
  return r.json();
}

async function main() {
  const u = process.argv[2];
  if (!u) die('用法: node tools/feishu-fetch.mjs "<飞书文档链接>"');
  const creds = loadCreds();
  if (!process.env.FEISHU_API_BASE && /larksuite|larkoffice/i.test(creds.domain || '')) API = 'https://open.larksuite.com';
  const token = await tenantToken(creds);
  let { kind, token: t, raw } = parseUrl(u);
  let docId = t;
  if (kind === 'wiki') {
    const j = await api(token, `/open-apis/wiki/v2/spaces/get_node?token=${t}`);
    if (j.code !== 0) die(`解析 wiki 节点失败(${j.code}): ${j.msg}（确认知识库已共享给该应用 + 开了 wiki 读权限）`);
    const node = j.data && j.data.node;
    if (!node) die('wiki 节点为空');
    if (node.obj_type === 'bitable') { process.stdout.write(await bitable(token, node.obj_token, raw)); return; }
    if (node.obj_type !== 'docx') die(`该 wiki 节点是「${node.obj_type}」，目前支持新版文档 docx 与多维表格 bitable`);
    docId = node.obj_token;
  } else if (kind === 'base') {
    process.stdout.write(await bitable(token, t, raw)); return;   // 多维表格
  } else if (kind === 'docs') {
    die('这是旧版文档(/docs/)，请改用新版文档(/docx/)；旧版接口暂不支持。');
  }
  const j = await api(token, `/open-apis/docx/v1/documents/${docId}/raw_content`);
  if (j.code !== 0) die(`读文档失败(${j.code}): ${j.msg}（确认文档/所在文件夹已共享给该应用、且开了 docx:document:readonly 权限）`);
  let out = (j.data && j.data.content) || '';
  out += await imagesSection(token, docId);   // raw_content 丢图片 → 额外下载图片，供 /intake 时逐张 Read
  process.stdout.write(out);
}
// 文档里的图片(raw_content 拿不到)：用 blocks 接口按顺序收集 image token → 下载到 docs/.intake/<docId>/ → 末尾列出供 claude 逐张 Read
async function imagesSection(token, docId) {
  let tokens = [], pageToken = '';
  try {
    do {
      const j = await api(token, `/open-apis/docx/v1/documents/${docId}/blocks?page_size=500${pageToken ? '&page_token=' + pageToken : ''}`);
      if (j.code !== 0) return `\n\n---\n⚠️ 取文档块失败(${j.code}: ${j.msg})，图片未拉取。\n`;
      for (const b of (j.data.items || [])) if (b.block_type === 27 && b.image && b.image.token) tokens.push(b.image.token);
      pageToken = j.data.has_more ? j.data.page_token : '';
    } while (pageToken);
  } catch (e) { return `\n\n---\n⚠️ 取文档块异常：${e.message}\n`; }
  if (!tokens.length) return '';
  const outDir = path.join(process.cwd(), 'docs/.intake', docId);
  try { fs.mkdirSync(outDir, { recursive: true }); } catch {}
  const saved = []; let denied = false;
  for (let i = 0; i < tokens.length; i++) {
    try {
      const r = await fetch(`${API}/open-apis/drive/v1/medias/${tokens[i]}/download`, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) { if (r.status === 400 || r.status === 403) denied = true; continue; }
      const f = path.join(outDir, `img-${String(i + 1).padStart(2, '0')}.png`);
      fs.writeFileSync(f, Buffer.from(await r.arrayBuffer())); saved.push(path.relative(process.cwd(), f));
    } catch {}
  }
  if (!saved.length) return `\n\n---\n⚠️ 文档含 ${tokens.length} 张图片但未能下载${denied ? '（应用缺 drive:drive:readonly 权限 → 飞书开放平台补该权限并重新发布版本）' : ''}。图里的界面改动/标注会漏，**分诊前请补权限重拉**，否则需求不完整。\n`;
  return `\n\n---\n📷 本文档含 ${saved.length} 张图片（按出现顺序，已下载到本地）。**分诊前请逐张用 Read 工具查看**，把图里的界面改动/标注一并纳入，别只看文字：\n` + saved.map((f, i) => `${i + 1}. ${f}`).join('\n') + '\n';
}
// 多维表格字段值 → 可读字符串(兼容文本段/人员/选项/超链接/数组)
function fval(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(fval).filter(Boolean).join(', ');
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text;
    if (typeof v.name === 'string') return v.name;
    if (typeof v.link === 'string') return v.link;
    if (v.value != null) return fval(v.value);
    return '';
  }
  return String(v);
}
// 多维表格(Bitable)：列表/字段/记录 → 文本。约定:每条记录 = 一条候选 task，主字段=标题。
async function bitable(token, appToken, url) {
  let tableId = ((String(url).match(/[?&]table=([A-Za-z0-9]+)/)) || [])[1] || '';   // URL 指定表优先，否则取第一张表
  const tj = await api(token, `/open-apis/bitable/v1/apps/${appToken}/tables?page_size=100`);
  if (tj.code !== 0) die(`读多维表格(表清单)失败(${tj.code}): ${tj.msg}（确认多维表格已共享给该应用、且开了 bitable:app:readonly 权限）`);
  const tables = (tj.data && tj.data.items) || [];
  if (!tables.length) die('多维表格里没有数据表');
  const tb = tableId ? (tables.find(x => x.table_id === tableId) || { table_id: tableId, name: tableId }) : tables[0];
  tableId = tb.table_id; const tableName = tb.name || tableId;
  const fj = await api(token, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/fields?page_size=200`);
  if (fj.code !== 0) die(`读多维表格(字段)失败(${fj.code}): ${fj.msg}`);
  const fields = ((fj.data && fj.data.items) || []).map(f => f.field_name);   // 有序，第一个=主字段=标题列
  if (!fields.length) die('该数据表没有字段');
  const titleField = fields[0];
  let records = [], pageToken = '';
  do {
    const rj = await api(token, `/open-apis/bitable/v1/apps/${appToken}/tables/${tableId}/records?page_size=200${pageToken ? '&page_token=' + pageToken : ''}`);
    if (rj.code !== 0) die(`读多维表格(记录)失败(${rj.code}): ${rj.msg}（确认开了 bitable:app:readonly 权限）`);
    records.push(...((rj.data && rj.data.items) || []));
    pageToken = (rj.data && rj.data.has_more) ? rj.data.page_token : '';
  } while (pageToken);
  let out = `# 飞书多维表格：${tableName}（共 ${records.length} 条记录）\n`;
  out += `> 来源：${url}\n> 约定:**每条记录 = 一条 task**；标题取「${titleField}」列，其余字段作为该 task 的备注/上下文。\n\n`;
  records.forEach((rec, i) => {
    const f = rec.fields || {};
    out += `## 记录 ${i + 1}：${fval(f[titleField]) || '(空标题)'}\n`;
    for (const name of fields) { if (name === titleField) continue; const val = fval(f[name]); if (val) out += `- ${name}：${val}\n`; }
    out += '\n';
  });
  return out;
}
main().catch(e => die(String((e && e.message) || e)));
