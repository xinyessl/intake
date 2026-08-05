// FS-04 consult-to-intake 冒烟用 db 层替身（loader hook 替换 ./db.mjs）。
//   本机无 MySQL：init/ping 返 true，loadAll 从 CTI_FIXTURE 目录读 accounts/projects（真实结构）供鉴权/登录，
//   其余写方法 no-op（session/intake/kb 全在 server 的内存 CACHE 里活着，冒烟只需内存态 + intake-store 文件落盘）。
import fs from 'node:fs';
import path from 'node:path';

const FIX = process.env.CTI_FIXTURE || '';
function readJson(f, def) { try { return JSON.parse(fs.readFileSync(path.join(FIX, f), 'utf8')); } catch { return def; } }

export function configure() {}
export async function init() { return true; }
export async function ping() { return true; }
export async function loadAll() {
  const accounts = readJson('accounts.json', []);
  const projects = readJson('projects.json', []);
  return { projects, accounts, sessions: {}, intakes: {}, kb: {} };
}
export async function replaceProjects() {}
export async function replaceAccounts() {}
export async function putSession() {}
export async function delSession() {}
export async function upsertIntake() {}
export async function replaceKB() {}
