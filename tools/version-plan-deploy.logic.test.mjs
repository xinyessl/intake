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
  sqlBundleSummary, applySqlBundleToggle,
  sortVersions, joinBatchProgress, batchSqlSummary, applyBatchTaskToggle, applyBatchSqlToggle, mergeBatchSql
} from './version-plan-logic.mjs';
import { readSqlAtTag, readDeployManifestFromSubs, gitOut, readDeployDirFromSubs, listDeployVersionsAtHead, readSqlFileAtHead, readDeployFileAtHead } from './deploy-manifest-reader.mjs';

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

// ============ C) 2026-08-05 核心更新流重构：目录@HEAD 草稿源 + 批次快照 ============

test('sortVersions：文件名版本号语义升序 + 去重', () => {
  assert.deepEqual(sortVersions(['2.10.0', '2.9.0', '2.9.0', '2.8.0']), ['2.8.0', '2.9.0', '2.10.0']);
  assert.deepEqual(sortVersions([]), []);
  assert.deepEqual(sortVersions(['1.0', '  ', '', '1.0']), ['1.0']);
});

let DTMP = null, DREPO = null, DREPO2 = null;

test('setup(目录形态)：造两个子系统仓 docs/deploy/*.json（一版一文件·@HEAD）+ sql/', () => {
  DTMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-dir-test-'));
  DREPO = path.join(DTMP, 'kwsb'); DREPO2 = path.join(DTMP, 'ph');
  // kwsb：docs/deploy/{2.8.0,2.9.0,2.10.0}.json + sql
  fs.mkdirSync(DREPO, { recursive: true });
  git(DREPO, 'init', '-q'); git(DREPO, 'config', 'user.email', 't@t.com'); git(DREPO, 'config', 'user.name', 't');
  write(DREPO, 'docs/deploy/2.8.0.json', JSON.stringify({ tasks: [{ id: 'stop', title: '停服务' }], sql: [{ id: 's280', file: 'sql/2.8.0.sql', desc: '2.8.0升级' }] }));
  write(DREPO, 'docs/deploy/2.9.0.json', JSON.stringify({ tasks: [{ id: 'deploy', title: '部署2.9.0包' }], sql: [{ id: 's290', file: 'sql/2.9.0.sql' }] }));
  write(DREPO, 'docs/deploy/2.10.0.json', JSON.stringify({ tasks: [{ id: 'verify', title: '回归验证' }], sql: [] }));
  write(DREPO, 'docs/deploy/bad.json', '{ not valid json ');          // 非法 JSON（文件名 bad → 也当版本，但 parse 失败跳过）
  write(DREPO, 'sql/2.8.0.sql', 'ALTER TABLE kwsb ADD c1 INT;\n');
  write(DREPO, 'sql/2.9.0.sql', 'ALTER TABLE kwsb ADD c2 INT;\n');
  git(DREPO, 'add', '-A'); git(DREPO, 'commit', '-q', '-m', 'kwsb deploy dir');
  // ph：只有 2.9.0 有清单（内联 SQL）
  fs.mkdirSync(DREPO2, { recursive: true });
  git(DREPO2, 'init', '-q'); git(DREPO2, 'config', 'user.email', 't@t.com'); git(DREPO2, 'config', 'user.name', 't');
  write(DREPO2, 'docs/deploy/2.9.0.json', JSON.stringify({ tasks: [{ id: 'mig', title: 'ph数据迁移' }], sql: [{ id: 'psx', content: 'UPDATE ph SET x=1;', desc: 'ph内联' }] }));
  git(DREPO2, 'add', '-A'); git(DREPO2, 'commit', '-q', '-m', 'ph deploy dir');
  assert.ok(fs.existsSync(DREPO) && fs.existsSync(DREPO2));
});

test('listDeployVersionsAtHead：列 docs/deploy/*.json 版本名（含 bad，跳过在 parse 层）', () => {
  const vs = listDeployVersionsAtHead(DREPO);
  assert.ok(vs.includes('2.8.0') && vs.includes('2.9.0') && vs.includes('2.10.0'), '列出各版本文件名');
  assert.ok(vs.includes('bad'), 'bad.json 也被列（版本名=bad），parse 层再跳过');
  assert.deepEqual(listDeployVersionsAtHead(path.join(DTMP, 'nope')), [], '仓不存在 → []');
});

test('readDeployFileAtHead / readSqlFileAtHead：@HEAD 读文件正文', () => {
  const raw = readDeployFileAtHead(DREPO, '2.8.0');
  assert.ok(raw.includes('停服务'), '读到 2.8.0.json 正文');
  assert.equal(readSqlFileAtHead(DREPO, 'sql/2.8.0.sql').trim(), 'ALTER TABLE kwsb ADD c1 INT;');
  assert.equal(readSqlFileAtHead(DREPO, 'sql/none.sql'), '', '缺文件 → 空');
});

test('readDeployDirFromSubs：跨子系统按版本聚合 @HEAD + JSON非法跳过 + gid 不撞号', () => {
  const subs = [{ name: 'kwsb', repoPath: DREPO }, { name: 'ph', repoPath: DREPO2 }];
  const byV = readDeployDirFromSubs(subs);
  assert.ok(byV['2.8.0'] && byV['2.9.0'] && byV['2.10.0'], '各版本聚合');
  assert.ok(!byV['bad'], 'bad.json（非法 JSON）→ 未产生版本条目');
  // 2.9.0 跨子系统聚合：kwsb 1任务1SQL + ph 1任务1SQL
  assert.equal(byV['2.9.0'].tasks.length, 2, '2.9.0 kwsb+ph 各 1 任务');
  const gids = byV['2.9.0'].tasks.map(t => t.gid);
  assert.ok(gids.includes('kwsb:deploy') && gids.includes('ph:mig'), '跨子系统 gid 唯一');
  assert.equal(byV['2.9.0'].sql.length, 2);
  const kwsbSql = byV['2.9.0'].sql.find(s => s.gid === 'kwsb:s290');
  assert.equal(kwsbSql.repoPath, DREPO, 'sql 项带 repoPath 供读正文');
});

test('端到端(草稿)：现场 2.8.0 → 目标 2.10.0 → 区间累积草稿 + SQL 正文读入（模拟 computeDeployDraft）', () => {
  const subs = [{ name: 'kwsb', repoPath: DREPO }, { name: 'ph', repoPath: DREPO2 }];
  const byVersion = readDeployDirFromSubs(subs);
  const allVersions = sortVersions(Object.keys(byVersion));            // 语义升序（bad 已不在，非法未产生条目）
  const range = rangeVersions(allVersions, '2.8.0', '2.10.0');
  assert.deepEqual(range, ['2.9.0', '2.10.0'], '(2.8.0, 2.10.0] = 2.9.0+2.10.0');
  const manifestByVersion = {}; for (const v of range) manifestByVersion[v] = byVersion[v];
  const acc = accumulateManifests(range, manifestByVersion);
  assert.deepEqual(acc.versionsInRange, ['2.9.0', '2.10.0']);
  assert.equal(acc.tasks.length, 3, '2.9.0(kwsb+ph)=2 + 2.10.0(kwsb)=1');
  assert.equal(acc.sqls.length, 2, '2.9.0 kwsb file + ph 内联（2.10.0 无 SQL）');
  // 模拟 server 读 SQL 正文（@HEAD）
  const resolved = acc.sqls.map(s => { let c = s.content || ''; if (s.file) { const t = readSqlFileAtHead(s.repoPath, s.file); c = t || c; } return Object.assign({}, s, { content: c }); });
  const kwsbSql = resolved.find(s => s.file === 'sql/2.9.0.sql');
  assert.equal(kwsbSql.content.trim(), 'ALTER TABLE kwsb ADD c2 INT;', 'kwsb file 正文 @HEAD 读入');
  const phSql = resolved.find(s => s.subsystem === 'ph');
  assert.equal(phSql.content, 'UPDATE ph SET x=1;', 'ph 内联 content 保留');
});

test('快照完成度：joinBatchProgress + batchSqlSummary（per 批次×医院·无 version）', () => {
  const dpTasks = [{ id: 'kwsb:deploy', title: '部署' }, { id: 'ph:mig', title: '迁移' }];
  const dpSql = [{ id: 'kwsb:s290', title: 'sql', content: 'A;' }];
  const prog = { tasks: { 'kwsb:deploy': { done: true, by: 'li', at: '2026-08-05 10:00' } }, sqlBundle: { done: false } };
  const jt = joinBatchProgress(dpTasks, prog);
  assert.equal(jt.done, 1); assert.equal(jt.total, 2);
  assert.equal(jt.rows[0].done, true); assert.equal(jt.rows[0].by, 'li');
  assert.equal(jt.rows[1].done, false);
  const sm = batchSqlSummary(dpSql, prog);
  assert.equal(sm.hasSql, true); assert.equal(sm.scriptCount, 1); assert.equal(sm.done, false);
  const sm2 = batchSqlSummary([], {});
  assert.equal(sm2.hasSql, false);
});

test('快照勾选幂等：applyBatchTaskToggle / applyBatchSqlToggle（不改入参·假删）', () => {
  const src = {};
  const r1 = applyBatchTaskToggle(src, 'kwsb:deploy', true, 'w', 't'); assert.equal(r1.changed, true);
  assert.deepEqual(src, {}, '不改入参');
  assert.equal(r1.progress.tasks['kwsb:deploy'].done, true);
  const r2 = applyBatchTaskToggle(r1.progress, 'kwsb:deploy', true, 'w', 't'); assert.equal(r2.changed, false, '幂等');
  const r3 = applyBatchTaskToggle(r1.progress, 'kwsb:deploy', false); assert.equal(r3.changed, true);
  assert.ok(!('kwsb:deploy' in (r3.progress.tasks || {})), '取消=删键');
  const s1 = applyBatchSqlToggle({}, true, 'w', 't'); assert.equal(s1.changed, true); assert.equal(s1.progress.sqlBundle.done, true);
  const s2 = applyBatchSqlToggle(s1.progress, true, 'w', 't'); assert.equal(s2.changed, false, '幂等');
  const s3 = applyBatchSqlToggle(s1.progress, false); assert.equal(s3.changed, true);
  assert.ok(!('sqlBundle' in s3.progress), 'SQL 取消=删键');
});

test('mergeBatchSql：快照正文直拼（无需读 git）+ 分隔注释 + 空不抛错', () => {
  const items = [{ id: 'a', title: 'sql/2.9.0.sql', desc: '升级a', content: 'ALTER TABLE a;' }, { id: 'b', title: 'ph内联', desc: '', content: 'UPDATE b;' }];
  const out = mergeBatchSql(items, { productName: '合理用药', from: '2.8.0', to: '2.10.0', site: 'X院' });
  assert.ok(out.includes('-- ==== 合理用药 sql/2.9.0.sql ===='), '分隔注释含标题');
  assert.ok(out.indexOf('ALTER TABLE a;') < out.indexOf('UPDATE b;'), '按快照顺序');
  assert.ok(out.includes('-- 说明：升级a'));
  assert.ok(out.includes('冻结的批次快照'), '文件头标明快照');
  const empty = mergeBatchSql([], { productName: '合理用药', to: '2.10.0' });
  assert.ok(empty.includes('暂无 SQL'), '空不抛错');
});

test('teardown(目录形态)：清理临时仓', () => {
  try { if (DTMP) fs.rmSync(DTMP, { recursive: true, force: true }); } catch {}
  assert.ok(true);
});

test('teardown：清理临时仓', () => {
  try { if (TMP) fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  assert.ok(true);
});
