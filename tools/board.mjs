#!/usr/bin/env node
// 从「事实」自动派生进度看板：spec 头部 status + 每条 spec 的节点状态文件 docs/.state/<id>.json
// 产出：docs/board.json（机器可读，控制台读它）+ docs/board.md（人可读，自动生成，勿手改）
// 用法：node tools/board.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = path.join(ROOT, 'docs/specs');
const STATE = path.join(ROOT, 'docs/.state');
const NODES = ['dev', 'test', 'accept'];
const NODE_CN = { dev: '开发', test: '测试', accept: '验收' };
const ICON = { todo: '⬜', doing: '🔄', pass: '✅', fail: '❌', wait: '⏸️' };

function readFm(file) {
  const txt = fs.readFileSync(file, 'utf8');
  const m = txt.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/);
  const fm = {};
  if (m) for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

function specNodes(id, status) {
  // 默认全 todo
  const nodes = Object.fromEntries(NODES.map(n => [n, 'todo']));
  // 产品节点：由 spec status 推导
  if (['ready', 'in-dev', 'testing', 'accepted'].includes(status)) nodes.product = 'pass';
  else if (status === 'draft') nodes.product = 'doing';
  // 其余节点：由流水线写的状态文件覆盖（事实来源）
  const sf = path.join(STATE, id + '.json');
  if (fs.existsSync(sf)) {
    try { Object.assign(nodes, JSON.parse(fs.readFileSync(sf, 'utf8')).nodes || {}); } catch {}
  }
  // 验收节点：spec=accepted 即通过
  if (status === 'accepted') nodes.accept = 'pass';
  return nodes;
}

function build() {
  const specs = [], seen = new Map(), dups = [];   // #20：同 id 去重（首个为准），重复登记到 blockers 提示人
  if (fs.existsSync(SPECS)) for (const f of fs.readdirSync(SPECS)) {
    if (!f.endsWith('.md') || f.startsWith('_') || f.toLowerCase() === 'readme.md') continue;
    const fm = readFm(path.join(SPECS, f));
    if (!fm.id) continue;
    if (seen.has(fm.id)) { dups.push(`${fm.id}（docs/specs/${f} 与 ${seen.get(fm.id)} 重复，已忽略后者）`); continue; }
    seen.set(fm.id, f);
    specs.push({ id: fm.id, title: fm.title || '', module: (fm.module || '').trim(), priority: (fm.priority || '').split('/')[0].trim(), status: fm.status || 'draft', file: 'docs/specs/' + f, nodes: specNodes(fm.id, fm.status || 'draft') });
  }
  specs.sort((a, b) => a.id.localeCompare(b.id));

  const summary = { total: specs.length, accepted: specs.filter(s => s.status === 'accepted').length, inDev: specs.filter(s => ['in-dev', 'testing'].includes(s.status)).length, ready: specs.filter(s => s.status === 'ready').length, draft: specs.filter(s => s.status === 'draft').length };
  const blockers = specs.filter(s => Object.values(s.nodes).includes('fail')).map(s => `${s.id} 有节点失败/驳回`).concat(dups.map(d => '重复 spec id：' + d));
  const board = { generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19), nodes: NODES, nodeCn: NODE_CN, specs, summary, blockers };

  fs.writeFileSync(path.join(ROOT, 'docs/board.json'), JSON.stringify(board, null, 2));

  // 生成 board.md
  let md = `# 研发进度看板（Board）\n\n> ⚠️ 本文件由 \`node tools/board.mjs\` **自动生成**，请勿手改。状态源：spec 头部 status + docs/.state/<id>.json。\n> 生成时间：${board.generatedAt}　图例：⬜未开始 🔄进行中 ✅通过 ❌失败/驳回 ⏸️待人\n\n`;
  md += `| spec | 标题 | 优先级 | ${NODES.map(n => NODE_CN[n]).join(' | ')} | 状态 |\n`;
  md += `|---|---|---|${NODES.map(() => '---').join('|')}|---|\n`;
  for (const s of specs) md += `| ${s.id} | ${s.title} | ${s.priority} | ${NODES.map(n => ICON[s.nodes[n]] || '⬜').join(' | ')} | ${s.status} |\n`;
  md += `\n## 汇总\n- 总计 ${summary.total} · 已验收 ${summary.accepted} · 开发中 ${summary.inDev} · 待开发(ready) ${summary.ready} · 草拟 ${summary.draft}\n`;
  if (blockers.length) md += `\n## 阻塞\n` + blockers.map(b => `- ${b}`).join('\n') + '\n';
  fs.writeFileSync(path.join(ROOT, 'docs/board.md'), md);

  console.log(`board 生成完成：${specs.length} 条 spec @ ${board.generatedAt}`);
}

build();
