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
