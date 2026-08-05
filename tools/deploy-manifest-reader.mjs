// ===== 部署/更新清单「跟随产品代码」· git 读取器（可独立测试，不依赖 MySQL / 不 spawn server）=====
// 约定见 docs/约定-产品部署清单.md。intake 只读 clone 产品仓，按 git tag 读各子系统仓 docs/deploy.json。
// server.mjs import 复用 + tools/version-plan-deploy.logic.test.mjs 用真实临时 git 仓单测（连真数据结构冒烟）。

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { normDeployManifest } from './version-plan-logic.mjs';

// 与 server.mjs gitOut 同范式：spawn git，status===0 才返回 stdout，否则空串（不 throw）。core.quotepath=false 输出 UTF-8 中文路径。
export function gitOut(repoPath, args) {
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoPath, encoding: 'utf8', timeout: 8000 });
    return r.status === 0 ? (r.stdout || '') : '';
  } catch { return ''; }
}

// 读某仓某 tag 下某文件正文（git show <tag>:<file>）。仓不存在 / tag 无此文件 → 空串（优雅降级，别 throw）。
export function readFileAtTag(repoPath, tag, rel) {
  if (!repoPath || !fs.existsSync(repoPath) || !tag || !rel) return '';
  return gitOut(repoPath, ['show', `${tag}:${rel}`]) || '';
}

// 读某 tag 下引用的 SQL 文件正文（供合并下载）。失败 → 空串（调用方兜底用 content / 注明读取失败）。
export function readSqlAtTag(repoPath, tag, file) { return readFileAtTag(repoPath, tag, String(file || '').trim()); }

// ===== 2026-08-05 架构重构（核心更新流）：目录形态 @HEAD 读取（草稿源）=====
//   模型转变：清单/SQL 不再按 tag 读单个 docs/deploy.json，而是「代码 = 草稿源」——
//     产品仓 docs/deploy/ 目录下**一版一文件**（文件名去 .json = 版本号）+ sql/*.sql，读 @HEAD（最新代码）。
//   发包（运营后台）时 intake 从代码拉出 (起始版本, 目标版本] 区间累积草稿 → 运营人审可改 → 快照冻结进批次。
//   实施侧读批次快照，不再实时读代码。故这里只需 @HEAD 读目录草稿（供发包审核），实施侧不调本组函数。

// 列某仓 @HEAD 下 docs/deploy/*.json 的版本号（文件名去 .json）。仓不存在 / 无目录 → []（不 throw）。
//   git ls-tree --name-only HEAD docs/deploy → 过滤 *.json → basename 去扩展名 = 版本号。
export function listDeployVersionsAtHead(repoPath) {
  if (!repoPath || !fs.existsSync(repoPath)) return [];
  const out = gitOut(repoPath, ['ls-tree', '--name-only', 'HEAD', 'docs/deploy/']);
  const vers = [];
  for (let line of out.split('\n')) {
    line = line.trim();
    if (!line || !/\.json$/i.test(line)) continue;                    // 只要 docs/deploy/*.json
    const base = line.replace(/^.*\//, '').replace(/\.json$/i, '');    // basename 去 .json
    if (base) vers.push(base);
  }
  return vers;
}

// 读某仓 @HEAD 下 docs/deploy/<version>.json 正文（原始字符串）。缺文件 → 空串。
export function readDeployFileAtHead(repoPath, version) {
  const v = String(version || '').trim();
  if (!v) return '';
  return readFileAtTag(repoPath, 'HEAD', 'docs/deploy/' + v + '.json');
}

// 读某仓 @HEAD 下引用的 SQL 文件正文（发包审核时读出正文一并冻结）。失败 → 空串。
export function readSqlFileAtHead(repoPath, file) { return readFileAtTag(repoPath, 'HEAD', String(file || '').trim()); }

// 聚合读某产品**全部版本**的部署清单草稿（@HEAD·目录形态，供发包审核拉草稿）。
//   subs：[{ name, repoPath }]（产品的子系统仓；可含顶层单仓 name=''）。
//   返回 { [version]: { tasks:[{subsystem,id,gid,title,desc}], sql:[{subsystem,id,gid,file,desc,content,repoPath}] } }。
//     · 每个子系统 docs/deploy/ 下每个版本文件 → JSON.parse → normDeployManifest（复用旧规范化：gid=<sub>:<id>、截断、去重）。
//     · 同一 version 跨子系统聚合（tasks/sql 拼接，gid 跨子系统不撞号）。
//     · 缺目录 / 缺文件 / JSON 非法 → 静默跳过该文件（不报错、不 500）。
//     · sql 项带 repoPath 供发包时 readSqlFileAtHead 读文件正文冻结。
export function readDeployDirFromSubs(subs) {
  const byVersion = {};
  for (const sub of (Array.isArray(subs) ? subs : [])) {
    const repoPath = sub && sub.repoPath;
    if (!repoPath) continue;
    const subName = String((sub && sub.name) || '').trim();
    for (const version of listDeployVersionsAtHead(repoPath)) {
      const raw = readDeployFileAtHead(repoPath, version);
      if (!raw) continue;
      let parsed = null;
      try { parsed = JSON.parse(raw); } catch { parsed = null; }       // JSON 非法 → 跳过该版本文件
      if (!parsed || typeof parsed !== 'object') continue;
      const norm = normDeployManifest(parsed, subName);
      if (!byVersion[version]) byVersion[version] = { tasks: [], sql: [] };
      for (const tk of norm.tasks) byVersion[version].tasks.push(tk);
      for (const sq of norm.sql) byVersion[version].sql.push(Object.assign({}, sq, { repoPath }));
    }
  }
  return byVersion;
}

// 聚合读某产品某 tag 的部署清单：对该产品每个子系统仓 git show <tag>:docs/deploy.json → JSON.parse → 规范化 → 聚合。
//   subs：[{ name, repoPath }]（产品的子系统仓；可含顶层单仓 name=''）。
//   子系统仓无该文件 / tag 无此文件 / JSON 非法 → 跳过该子系统（不报错、不 500）。
//   返回 { tasks:[{subsystem,id,gid,title,desc}], sql:[{subsystem,id,gid,file,desc,content,repoPath}] }。
//     全局 id gid=`<subsystem>:<id>` 避免跨子系统撞 id；sql 项带 repoPath 供 readSqlAtTag 定位文件。
export function readDeployManifestFromSubs(subs, tag) {
  const t = String(tag || '').trim();
  const tasks = [], sql = [];
  if (!t) return { tasks, sql };
  for (const sub of (Array.isArray(subs) ? subs : [])) {
    const repoPath = sub && sub.repoPath;
    if (!repoPath) continue;
    const raw = readFileAtTag(repoPath, t, 'docs/deploy.json');
    if (!raw) continue;                                              // 该子系统该 tag 无 deploy.json → 跳过
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }       // JSON 非法 → 跳过（不报错）
    if (!parsed || typeof parsed !== 'object') continue;
    const norm = normDeployManifest(parsed, String((sub && sub.name) || '').trim());
    for (const tk of norm.tasks) tasks.push(tk);
    for (const sq of norm.sql) sql.push(Object.assign({}, sq, { repoPath }));   // 带上 repoPath 供后续读文件正文
  }
  return { tasks, sql };
}
