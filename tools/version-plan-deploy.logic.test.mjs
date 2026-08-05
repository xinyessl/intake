// 更新包「跟随产品代码 · 按 tag 读 docs/deploy.json + 跨版本累积」——纯逻辑 + git 读取器单测
//   本地直接跑（不依赖 MySQL / 不 spawn server）：node --test tools/version-plan-deploy.logic.test.mjs
//   两部分：
//     A) 纯逻辑（version-plan-logic.mjs）：normDeployManifest 规范化、rangeVersions 区间、accumulateManifests 累积、
//        joinProgress 完成态左连、sqlBundleSummary 汇总一个点、applyToggle/applySqlBundleToggle 幂等、mergeSql 分隔注释+顺序。
//     B) git 读取器（deploy-manifest-reader.mjs）：在临时目录 git init 造「子系统仓」，提交 docs/deploy.json + sql/*.sql，
//        打两个 tag（v1.0/v1.1，各自 deploy.json 不同）→ readDeployManifestFromSubs 在各 tag 读对、聚合对、readSqlAtTag 读引用文件对、
//        缺失/JSON非法/tag无文件优雅降级为空、跨子系统聚合 gid 不撞号、合并 SQL 拼接顺序+分隔对。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  clip, genId, normDeployManifest,
  rangeVersions, accumulateManifests, joinProgress, applyToggle, mergeSql, siteAllowed,
  sqlBundleSummary, applySqlBundleToggle
} from './version-plan-logic.mjs';
import { readSqlAtTag, readDeployManifestFromSubs, gitOut } from './deploy-manifest-reader.mjs';

// ============ A) 纯逻辑 ============

test('normDeployManifest：title 非空丢弃 + gid=<sub>:<id> + sql file/content 二选一 + 去重', () => {
  const gen = { task: (() => { let n = 0; return () => 'dt' + (++n); })(), sql: (() => { let n = 0; return () => 'ds' + (++n); })() };
  const out = normDeployManifest({
    tasks: [
      { id: 'env', title: '环境准备', desc: '就绪' },
      { title: '   ' },                       // 空标题 → 丢弃
      { id: 'env', title: '重复id' },          // id 撞号 → 改名
      { title: '缺id' }                        // 缺 id → 补
    ],
    sql: [
      { id: 's1', file: 'sql/1.0.sql', desc: '升级脚本' },
      { id: 's2', content: 'ALTER TABLE t ADD c INT;' },
      { id: 's3' },                            // 既无 file 又无 content → 丢弃
      { file: 'sql/x.sql' }                    // 缺 id → 补
    ]
  }, 'kwsb', gen);
  assert.equal(out.tasks.length, 3, '空标题丢弃、其余保留');
  assert.equal(out.tasks[0].gid, 'kwsb:env', 'gid=<子系统>:<id>');
  assert.notEqual(out.tasks[1].id, 'env', '撞号 id 已改名');       // 撞号 env → gen 一次（dt1）
  assert.ok(/^dt\d+$/.test(out.tasks[2].id), '缺 id 补生成（gen）');   // 缺 id → gen 一次（dt2）
  assert.notEqual(out.tasks[1].id, out.tasks[2].id, '补的 id 互不相同');
  assert.equal(out.sql.length, 3, '无 file 无 content 的丢弃');
  assert.equal(out.sql[0].gid, 'kwsb:s1');
  assert.equal(out.sql[0].file, 'sql/1.0.sql');
  assert.equal(out.sql[1].content, 'ALTER TABLE t ADD c INT;');
  assert.ok(/^ds\d+$/.test(out.sql[2].id), 'sql 缺 id 补生成（gen）');
});

test('normDeployManifest：子系统空 → gid 前缀 default:；title/desc/content 截断', () => {
  const out = normDeployManifest({ tasks: [{ id: 'a', title: 'x'.repeat(200), desc: 'y'.repeat(3000) }], sql: [{ id: 'b', content: 'z'.repeat(30000), desc: 'd'.repeat(500) }] }, '');
  assert.equal(out.tasks[0].gid, 'default:a');
  assert.equal(out.tasks[0].title.length, 120);
  assert.equal(out.tasks[0].desc.length, 2000);
  assert.equal(out.sql[0].content.length, 20000);
  assert.equal(out.sql[0].desc.length, 200);
});

test('rangeVersions：(1.0,1.2] 取 1.1+1.2；from 不在列表 include 全部 ≤to；空区间', () => {
  const tags = ['1.0', '1.1', '1.2', '1.3'];   // 升序
  assert.deepEqual(rangeVersions(tags, '1.0', '1.2'), ['1.1', '1.2']);
  assert.deepEqual(rangeVersions(tags, '', '1.1'), ['1.0', '1.1']);       // 空 from → include 全部 ≤to
  assert.deepEqual(rangeVersions(tags, '0.5', '1.1'), ['1.0', '1.1']);    // from 不在列表 → include
  assert.deepEqual(rangeVersions(tags, '1.2', '1.2'), []);                // from===to → 空
  assert.deepEqual(rangeVersions([], '1.0', '1.1'), []);                  // 无 tag → 空
});

test('accumulateManifests：只汇总有清单的版本；tasks 用 gid、sqls name=file 优先', () => {
  const byV = {
    '1.0': { tasks: [{ gid: 'kwsb:env', title: '环境', desc: '', subsystem: 'kwsb' }], sql: [{ gid: 'kwsb:s1', file: 'sql/1.0.sql', content: 'A;', desc: '', subsystem: 'kwsb' }] },
    '1.1': { tasks: [], sql: [] },                                        // 无清单 → 跳过
    '1.2': { tasks: [{ gid: 'ph:mig', title: '迁移', desc: '', subsystem: 'ph' }], sql: [] }
  };
  const acc = accumulateManifests(['1.0', '1.1', '1.2'], byV);
  assert.deepEqual(acc.versionsInRange, ['1.0', '1.2'], '跳过无清单的 1.1');
  assert.equal(acc.tasks.length, 2);
  assert.equal(acc.tasks[0].id, 'kwsb:env', 'task id = gid');
  assert.equal(acc.tasks[0].version, '1.0');
  assert.equal(acc.tasks[1].id, 'ph:mig');
  assert.equal(acc.sqls.length, 1);
  assert.equal(acc.sqls[0].name, 'sql/1.0.sql', 'sql 展示名 = file 优先');
});

test('joinProgress：按 (version,gid) 左连 done/by/at + 汇总 done/total', () => {
  const items = [{ version: '1.0', id: 'kwsb:env', title: '环境' }, { version: '1.2', id: 'ph:mig', title: '迁移' }];
  const prog = { '1.0': { tasks: { 'kwsb:env': { done: true, by: 'zhang', at: '2026-08-05 10:00' } } } };
  const r = joinProgress(items, prog, 'tasks');
  assert.equal(r.done, 1); assert.equal(r.total, 2);
  assert.equal(r.rows[0].done, true); assert.equal(r.rows[0].by, 'zhang');
  assert.equal(r.rows[1].done, false, '未完成项 done=false');
});

test('sqlBundleSummary + applySqlBundleToggle：合并 SQL 一个点 · 完成态挂 targetVersion.sqlBundle · 幂等', () => {
  const accSqls = [{ version: '1.0', id: 'kwsb:s1' }, { version: '1.2', id: 'ph:s2' }];
  let prog = {};
  let sum = sqlBundleSummary(accSqls, prog, '1.2');
  assert.equal(sum.hasSql, true); assert.equal(sum.scriptCount, 2);
  assert.deepEqual(sum.versions, ['1.0', '1.2']); assert.equal(sum.done, false);
  const r1 = applySqlBundleToggle(prog, '1.2', true, 'li', '2026-08-05 11:00'); prog = r1.progress;
  assert.equal(r1.changed, true);
  sum = sqlBundleSummary(accSqls, prog, '1.2');
  assert.equal(sum.done, true); assert.equal(sum.by, 'li');
  const r2 = applySqlBundleToggle(prog, '1.2', true, 'li', '2026-08-05 11:00');  // 幂等
  assert.equal(r2.changed, false);
});

test('applyToggle：tasks 桶写/删 + 幂等 + 不改入参', () => {
  const src = {};
  const r1 = applyToggle(src, '1.0', 'tasks', 'kwsb:env', true, 'w', 't'); assert.equal(r1.changed, true);
  assert.deepEqual(src, {}, '不改入参');
  const r2 = applyToggle(r1.progress, '1.0', 'tasks', 'kwsb:env', true, 'w', 't'); assert.equal(r2.changed, false);
  const r3 = applyToggle(r1.progress, '1.0', 'tasks', 'kwsb:env', false); assert.equal(r3.changed, true);
  assert.ok(!('kwsb:env' in (r3.progress['1.0'].tasks || {})), '取消=删键');
});

test('mergeSql：分隔注释含 产品/版本/子系统/文件 + 顺序按版本升序 + 空区间不抛错', () => {
  const sqls = [
    { version: '1.0', subsystem: 'kwsb', file: 'sql/1.0.sql', name: 'sql/1.0.sql', content: 'ALTER TABLE a;', desc: '升级a' },
    { version: '1.2', subsystem: 'ph', file: 'sql/1.2.sql', name: 'sql/1.2.sql', content: 'ALTER TABLE b;', desc: '' }
  ];
  const out = mergeSql(sqls, { productName: '合理用药系统', from: '0.9', to: '1.2', site: 'X院' });
  assert.ok(out.includes('-- ==== 合理用药系统 1.0 kwsb sql/1.0.sql ===='), '分隔注释含产品/版本/子系统/文件');
  assert.ok(out.includes('-- ==== 合理用药系统 1.2 ph sql/1.2.sql ===='));
  assert.ok(out.indexOf('ALTER TABLE a;') < out.indexOf('ALTER TABLE b;'), '按版本升序');
  assert.ok(out.includes('-- 说明：升级a'), 'desc 带出');
  const empty = mergeSql([], { productName: '合理用药系统', to: '1.0' });
  assert.ok(empty.includes('暂无 SQL 脚本') || empty.includes('未在 docs/deploy.json'), '空区间回说明注释不抛错');
});

test('siteAllowed：管理员不限；非管理员按 sites', () => {
  assert.equal(siteAllowed(true, [], 'A院'), true);
  assert.equal(siteAllowed(false, ['A院'], 'A院'), true);
  assert.equal(siteAllowed(false, ['A院'], 'B院'), false);
});

// ============ B) git 读取器（真实临时 git 仓）============

function git(cwd, ...args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' -> ' + (r.stderr || '')); return r.stdout; }
function write(root, rel, content) { const p = path.join(root, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }

let REPO = null, REPO2 = null, TMP = null;

test('setup：造两个临时子系统仓 + 各打 v1.0/v1.1（deploy.json 各版本不同）', () => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-manifest-test-'));
  REPO = path.join(TMP, 'kwsb');
  REPO2 = path.join(TMP, 'ph');
  fs.mkdirSync(REPO, { recursive: true });
  git(REPO, 'init', '-q');
  git(REPO, 'config', 'user.email', 't@t.com'); git(REPO, 'config', 'user.name', 't');
  // v1.0：一条任务 + 一条 file SQL
  write(REPO, 'docs/deploy.json', JSON.stringify({ tasks: [{ id: 'env', title: '环境准备', desc: '就绪' }], sql: [{ id: 's1', file: 'sql/1.0_upgrade.sql', desc: '1.0升级' }] }));
  write(REPO, 'sql/1.0_upgrade.sql', 'ALTER TABLE kwsb_t ADD col1 INT;\n');
  git(REPO, 'add', '-A'); git(REPO, 'commit', '-q', '-m', 'v1.0');
  git(REPO, 'tag', 'v1.0');
  // v1.1：两条任务 + 一条 file SQL + 一条内联 SQL
  write(REPO, 'docs/deploy.json', JSON.stringify({ tasks: [{ id: 'env', title: '环境准备', desc: '就绪' }, { id: 'backup', title: '备份数据库', desc: '' }], sql: [{ id: 's2', file: 'sql/1.1_upgrade.sql', desc: '1.1升级' }, { id: 's3', content: 'UPDATE kwsb_t SET col1=0;', desc: '内联' }] }));
  write(REPO, 'sql/1.1_upgrade.sql', 'ALTER TABLE kwsb_t ADD col2 VARCHAR(20);\n');
  git(REPO, 'add', '-A'); git(REPO, 'commit', '-q', '-m', 'v1.1');
  git(REPO, 'tag', 'v1.1');
  // 第二个子系统仓 ph：v1.1 才有 deploy.json（v1.0 无 → 测缺失降级）
  fs.mkdirSync(REPO2, { recursive: true });
  git(REPO2, 'init', '-q');
  git(REPO2, 'config', 'user.email', 't@t.com'); git(REPO2, 'config', 'user.name', 't');
  write(REPO2, 'README.md', '# ph v1.0 无 deploy.json\n');
  git(REPO2, 'add', '-A'); git(REPO2, 'commit', '-q', '-m', 'ph v1.0'); git(REPO2, 'tag', 'v1.0');
  write(REPO2, 'docs/deploy.json', JSON.stringify({ tasks: [{ id: 'mig', title: '数据迁移' }], sql: [{ id: 'ps1', file: 'sql/ph_1.1.sql' }] }));
  write(REPO2, 'sql/ph_1.1.sql', 'CREATE INDEX idx ON ph_t(id);\n');
  git(REPO2, 'add', '-A'); git(REPO2, 'commit', '-q', '-m', 'ph v1.1'); git(REPO2, 'tag', 'v1.1');
  // 顺带造一个含非法 JSON 的仓 tag（测 JSON 非法降级）
  write(REPO, 'docs/deploy.json', '{ this is not json ');
  git(REPO, 'add', '-A'); git(REPO, 'commit', '-q', '-m', 'v1.2 bad json'); git(REPO, 'tag', 'v1.2');
  assert.ok(fs.existsSync(REPO) && fs.existsSync(REPO2));
});

test('readDeployManifestFromSubs：v1.0 只 kwsb 有清单（ph 无 deploy.json → 跳过）', () => {
  const subs = [{ name: 'kwsb', repoPath: REPO }, { name: 'ph', repoPath: REPO2 }];
  const m = readDeployManifestFromSubs(subs, 'v1.0');
  assert.equal(m.tasks.length, 1, '仅 kwsb v1.0 一条任务');
  assert.equal(m.tasks[0].gid, 'kwsb:env');
  assert.equal(m.sql.length, 1);
  assert.equal(m.sql[0].file, 'sql/1.0_upgrade.sql');
  assert.equal(m.sql[0].repoPath, REPO, 'sql 项带 repoPath 供读文件');
});

test('readDeployManifestFromSubs：v1.1 跨子系统聚合（kwsb 2任务2SQL + ph 1任务1SQL）gid 不撞号', () => {
  const subs = [{ name: 'kwsb', repoPath: REPO }, { name: 'ph', repoPath: REPO2 }];
  const m = readDeployManifestFromSubs(subs, 'v1.1');
  assert.equal(m.tasks.length, 3, 'kwsb 2 + ph 1');
  const gids = m.tasks.map(t => t.gid);
  assert.ok(gids.includes('kwsb:env') && gids.includes('kwsb:backup') && gids.includes('ph:mig'), '跨子系统 gid 唯一');
  assert.equal(m.sql.length, 3, 'kwsb 2 (file+内联) + ph 1');
  const inline = m.sql.find(s => s.gid === 'kwsb:s3');
  assert.equal(inline.content, 'UPDATE kwsb_t SET col1=0;', '内联 content 保留');
});

test('readDeployManifestFromSubs：JSON 非法（v1.2）→ 跳过该子系统，不抛错', () => {
  const subs = [{ name: 'kwsb', repoPath: REPO }];
  const m = readDeployManifestFromSubs(subs, 'v1.2');
  assert.deepEqual(m, { tasks: [], sql: [] }, 'JSON 非法 → 空清单不报错');
});

test('readDeployManifestFromSubs：tag 不存在 / 仓不存在 → 空清单降级', () => {
  assert.deepEqual(readDeployManifestFromSubs([{ name: 'kwsb', repoPath: REPO }], 'v9.9'), { tasks: [], sql: [] });
  assert.deepEqual(readDeployManifestFromSubs([{ name: 'x', repoPath: path.join(TMP, 'nope') }], 'v1.0'), { tasks: [], sql: [] });
  assert.deepEqual(readDeployManifestFromSubs([], 'v1.0'), { tasks: [], sql: [] });
});

test('readSqlAtTag：按 tag 读引用 SQL 文件正文；读不到→空', () => {
  assert.equal(readSqlAtTag(REPO, 'v1.0', 'sql/1.0_upgrade.sql').trim(), 'ALTER TABLE kwsb_t ADD col1 INT;');
  assert.equal(readSqlAtTag(REPO, 'v1.1', 'sql/1.1_upgrade.sql').trim(), 'ALTER TABLE kwsb_t ADD col2 VARCHAR(20);');
  assert.equal(readSqlAtTag(REPO, 'v1.0', 'sql/1.1_upgrade.sql'), '', 'v1.0 下 1.1 脚本不存在 → 空');
  assert.equal(readSqlAtTag(REPO, 'v9.9', 'sql/1.0_upgrade.sql'), '', 'tag 不存在 → 空');
});

test('端到端：现场 v1.0 升 v1.1 → 区间 (v1.0,v1.1] → 累积 + 合并 SQL 读文件拼接顺序/分隔对', () => {
  const subs = [{ name: 'kwsb', repoPath: REPO }, { name: 'ph', repoPath: REPO2 }];
  const tags = ['v1.0', 'v1.1'];   // 升序（listVersions 倒序 reverse 后）
  const range = rangeVersions(tags, 'v1.0', 'v1.1');
  assert.deepEqual(range, ['v1.1'], '(v1.0,v1.1] = [v1.1]');
  const byV = {}; for (const v of range) byV[v] = readDeployManifestFromSubs(subs, v);
  const acc = accumulateManifests(range, byV);
  assert.deepEqual(acc.versionsInRange, ['v1.1']);
  assert.equal(acc.tasks.length, 3, 'v1.1 累积 3 任务');
  assert.equal(acc.sqls.length, 3, 'v1.1 累积 3 SQL');
  // 合并前解析每条 file 引用为正文（模拟 server 端 update-sql-merged 的解析）
  const resolved = acc.sqls.map(s => {
    let content = s.content || '';
    if (s.file) { const t = readSqlAtTag(s.repoPath, s.version, s.file); content = t || content || '-- 读取失败'; }
    return Object.assign({}, s, { content });
  });
  const merged = mergeSql(resolved, { productName: '合理用药系统', from: 'v1.0', to: 'v1.1', site: 'X院' });
  assert.ok(merged.includes('ALTER TABLE kwsb_t ADD col2 VARCHAR(20);'), 'kwsb file SQL 正文被读入');
  assert.ok(merged.includes('UPDATE kwsb_t SET col1=0;'), 'kwsb 内联 SQL 保留');
  assert.ok(merged.includes('CREATE INDEX idx ON ph_t(id);'), 'ph file SQL 正文被读入');
  assert.ok(merged.includes('-- ==== 合理用药系统 v1.1 kwsb '), '分隔注释含子系统');
});

test('teardown：清理临时仓', () => {
  try { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  assert.ok(true);
});
