// 收件 intake · MySQL 持久层
//   设计：MySQL 为唯一事实源。server 启动时 loadAll() 到内存缓存，读走缓存、写穿透到库（+导出 .md）。
//   关键字段建成列(可 SQL 查询/报表)，嵌套结构(chat/history/analysis/resolution/媒体/正文)放 JSON 列。
import mysql from 'mysql2/promise';

let pool = null;
export function configure(cfg) {
  pool = mysql.createPool({
    host: cfg.host || '127.0.0.1', port: cfg.port || 3306,
    user: cfg.user || 'intake', password: cfg.password || '', database: cfg.database || 'intake',
    charset: 'utf8mb4_unicode_ci', waitForConnections: true, connectionLimit: 8, namedPlaceholders: false,
  });
  return pool;
}
const q = (sql, args) => pool.query(sql, args);

export async function init() {
  await q(`CREATE TABLE IF NOT EXISTS projects (
    id VARCHAR(40) PRIMARY KEY, name VARCHAR(100) NOT NULL,
    repo_path VARCHAR(500) NULL, specs_path VARCHAR(500) NULL, subsystems JSON NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS accounts (
    id VARCHAR(40) PRIMARY KEY, username VARCHAR(40) UNIQUE NOT NULL, role VARCHAR(20) NOT NULL,
    name VARCHAR(80) NULL, phone VARCHAR(20) NULL, salt VARCHAR(64) NULL, hash VARCHAR(256) NULL, must_change TINYINT DEFAULT 0,
    projects JSON NULL, sites JSON NULL, enabled TINYINT DEFAULT 1, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  // 幂等补列：CREATE TABLE IF NOT EXISTS 不会给「已存在」的 accounts 表加列 → 查 information_schema 后再 ADD（存量库必走这里）。
  await ensureColumn('accounts', 'enabled', 'TINYINT DEFAULT 1');
  await ensureColumn('accounts', 'phone', 'VARCHAR(20)');   // 账号手机号（单一来源：医院管理实施人电话取自此列）；存量库幂等补列，不动数据
  await q(`CREATE TABLE IF NOT EXISTS sessions (
    token VARCHAR(64) PRIMARY KEY, user_id VARCHAR(40) NOT NULL, exp BIGINT NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS intakes (
    project_id VARCHAR(40) NOT NULL, id VARCHAR(40) NOT NULL,
    type VARCHAR(20), version VARCHAR(60), site VARCHAR(80), subsystem VARCHAR(80), module VARCHAR(120),
    title VARCHAR(300), priority VARCHAR(10), severity VARCHAR(20), env VARCHAR(20), freq VARCHAR(20),
    status VARCHAR(20), lifecycle VARCHAR(20), assignee VARCHAR(80), reporter VARCHAR(80),
    submitted_at VARCHAR(20), data JSON NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (project_id, id), INDEX idx_proj_life (project_id, lifecycle), INDEX idx_type (type), INDEX idx_sub (subsystem)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
  await q(`CREATE TABLE IF NOT EXISTS kb_entries (
    id VARCHAR(40) PRIMARY KEY, project_id VARCHAR(40) NOT NULL,
    q TEXT, a TEXT, subsystem VARCHAR(80), module VARCHAR(120), tags JSON, source VARCHAR(20), from_ref VARCHAR(60),
    created_at VARCHAR(20), INDEX idx_kb_proj (project_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

// 幂等加列：仅当该表无此列时才 ALTER（存量表用；新表 CREATE 已含则跳过）。查 information_schema 判存在，避免依赖吞异常。
async function ensureColumn(table, col, ddl) {
  const [r] = await q(
    `SELECT COUNT(*) AS n FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, col]);
  if (r[0].n > 0) return false;
  await q(`ALTER TABLE \`${table}\` ADD COLUMN \`${col}\` ${ddl}`);
  return true;
}

const J = v => (v == null ? null : JSON.stringify(v));
const c = (v, n) => String(v == null ? '' : v).slice(0, n);   // 按列宽截断，避免超长写库报错
const P = v => { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } };

// 启动时把全库读进内存缓存
export async function loadAll() {
  const out = { projects: [], accounts: [], sessions: {}, intakes: {}, kb: {} };
  const [pr] = await q(`SELECT * FROM projects ORDER BY created_at`);
  out.projects = pr.map(r => { const o = { id: r.id, name: r.name }; if (r.repo_path) o.repoPath = r.repo_path; if (r.specs_path) o.specsPath = r.specs_path; const subs = P(r.subsystems); if (subs && subs.length) o.subsystems = subs; return o; });
  const [ac] = await q(`SELECT * FROM accounts`);
  out.accounts = ac.map(r => ({ id: r.id, username: r.username, role: r.role, name: r.name || '', phone: r.phone || '', salt: r.salt || '', hash: r.hash || '', mustChange: !!r.must_change, projects: P(r.projects) || [], sites: P(r.sites) || [], enabled: r.enabled == null ? 1 : (r.enabled ? 1 : 0), createdAt: r.created_at || '' }));
  const [se] = await q(`SELECT * FROM sessions`);
  for (const r of se) out.sessions[r.token] = { userId: r.user_id, exp: Number(r.exp) };
  const [ins] = await q(`SELECT project_id, data FROM intakes`);
  for (const r of ins) { const e = P(r.data); if (!e) continue; (out.intakes[r.project_id] || (out.intakes[r.project_id] = {}))[e.id] = e; }
  const [kb] = await q(`SELECT * FROM kb_entries ORDER BY created_at`);
  for (const r of kb) { const e = { id: r.id, q: r.q || '', a: r.a || '', subsystem: r.subsystem || '', module: r.module || '', tags: P(r.tags) || [], from: r.from_ref || 'manual', at: r.created_at || '' }; (out.kb[r.project_id] || (out.kb[r.project_id] = [])).push(e); }
  return out;
}

// projects：按 id upsert + 删除已移除的
export async function replaceProjects(list) {
  for (const p of list) await q(`INSERT INTO projects (id,name,repo_path,specs_path,subsystems) VALUES (?,?,?,?,?)
    ON DUPLICATE KEY UPDATE name=VALUES(name),repo_path=VALUES(repo_path),specs_path=VALUES(specs_path),subsystems=VALUES(subsystems)`,
    [p.id, p.name || '', p.repoPath || null, p.specsPath || null, J(p.subsystems || null)]);
  const ids = list.map(p => p.id);
  if (ids.length) await q(`DELETE FROM projects WHERE id NOT IN (${ids.map(() => '?').join(',')})`, ids); else await q(`DELETE FROM projects`);
}
export async function replaceAccounts(list) {
  for (const a of list) await q(`INSERT INTO accounts (id,username,role,name,phone,salt,hash,must_change,projects,sites,enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE username=VALUES(username),role=VALUES(role),name=VALUES(name),phone=VALUES(phone),salt=VALUES(salt),hash=VALUES(hash),must_change=VALUES(must_change),projects=VALUES(projects),sites=VALUES(sites),enabled=VALUES(enabled)`,
    [a.id, a.username, a.role, a.name || '', c(a.phone, 20), a.salt || '', a.hash || '', a.mustChange ? 1 : 0, J(a.projects || []), J(a.sites || []), a.enabled == null ? 1 : (a.enabled ? 1 : 0)]);
  const ids = list.map(a => a.id);
  if (ids.length) await q(`DELETE FROM accounts WHERE id NOT IN (${ids.map(() => '?').join(',')})`, ids); else await q(`DELETE FROM accounts`);
}
export async function putSession(token, s) { await q(`INSERT INTO sessions (token,user_id,exp) VALUES (?,?,?) ON DUPLICATE KEY UPDATE user_id=VALUES(user_id),exp=VALUES(exp)`, [token, s.userId, s.exp]); }
export async function delSession(token) { await q(`DELETE FROM sessions WHERE token=?`, [token]); }

export async function upsertIntake(projectId, e) {
  await q(`INSERT INTO intakes (project_id,id,type,version,site,subsystem,module,title,priority,severity,env,freq,status,lifecycle,assignee,reporter,submitted_at,data)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE type=VALUES(type),version=VALUES(version),site=VALUES(site),subsystem=VALUES(subsystem),module=VALUES(module),title=VALUES(title),priority=VALUES(priority),severity=VALUES(severity),env=VALUES(env),freq=VALUES(freq),status=VALUES(status),lifecycle=VALUES(lifecycle),assignee=VALUES(assignee),reporter=VALUES(reporter),submitted_at=VALUES(submitted_at),data=VALUES(data)`,
    [c(projectId, 40), c(e.id, 40), c(e.type, 20), c(e.version, 60), c(e.site, 80), c(e.subsystem, 80), c(e.module, 120), c(e.title, 300), c(e.priority, 10), c(e.severity, 20), c(e.env, 20), c(e.freq, 20), c(e.status, 20), c(e.lifecycle, 20), c(e.assignee, 80), c(e.reporter, 80), c(e.submittedAt, 20), J(e)]);
}
export async function replaceKB(projectId, arr) {
  await q(`DELETE FROM kb_entries WHERE project_id=?`, [projectId]);
  for (const e of arr) await q(`INSERT INTO kb_entries (id,project_id,q,a,subsystem,module,tags,source,from_ref,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [e.id, projectId, e.q || '', e.a || '', e.subsystem || '', e.module || '', J(e.tags || []), (e.from === 'manual' || e.from === 'consult') ? e.from : 'auto', e.from || '', e.at || '']);
}
export async function ping() { const [r] = await q('SELECT 1 AS ok'); return r[0].ok === 1; }
