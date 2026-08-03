// 更新包「按版本独立维护 + 跨版本累积」· 纯逻辑单测（不依赖 MySQL / 不 spawn server / 不碰 git，本地直接跑：node --test tools/version-plan.logic.test.mjs）
//   覆盖：区间 (0.9,1.1] 取 1.0+1.1、from 不在列表=include 全部 ≤to、空区间、
//         累积汇总（跳过未登记版本）、完成态左连、合并 SQL 含分隔注释与顺序、勾选幂等、越权判据、规范化校验。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clip, genId, normVersionTasks, normVersionSqls,
  rangeVersions, accumulate, joinProgress, applyToggle, mergeSql, siteAllowed
} from './version-plan-logic.mjs';

function seqGen(prefix) { let n = 0; return () => prefix + String(++n).padStart(4, '0'); }

test('clip / genId', () => {
  assert.equal(clip('  x  ', 10), 'x');
  assert.equal(clip('a'.repeat(50), 10).length, 10);
  assert.equal(clip(null, 5), '');
  assert.ok(genId('vt').startsWith('vt'));
});

test('normVersionTasks：title 非空丢弃 + title≤120/desc≤2000 + 缺 id 补 vt + 去重', () => {
  const gen = seqGen('vt');
  const out = normVersionTasks([
    { title: '升级审方引擎', desc: '停服后替换 jar' },
    { title: '  ', desc: '空标题应丢弃' },
    { id: 'vtX', title: 'a'.repeat(200), desc: 'b'.repeat(3000) },
    { id: 'vtX', title: '冲突 id' },
  ], gen);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 'vt0001');
  assert.equal(out[1].title.length, 120);
  assert.equal(out[1].desc.length, 2000);
  assert.notEqual(out[2].id, 'vtX');                 // 冲突 id 重分
  assert.equal(new Set(out.map(t => t.id)).size, 3);
});

test('normVersionSqls：name 非空丢弃 + name≤120/content≤20000 + 缺 id 补 vs + 保留 SQL 换行', () => {
  const gen = seqGen('vs');
  const sql = 'ALTER TABLE t ADD COLUMN c INT;\n  UPDATE t SET c=0;';
  const out = normVersionSqls([
    { name: '加字段', content: sql },
    { name: '', content: 'DROP;' },                  // 空 name 丢弃
    { id: 'vsY', name: 'x'.repeat(200), content: 'z'.repeat(25000) },
  ], gen);
  assert.equal(out.length, 2);
  assert.equal(out[0].id, 'vs0001');
  assert.equal(out[0].content, sql);                 // 换行/缩进保留
  assert.equal(out[1].name.length, 120);
  assert.equal(out[1].content.length, 20000);
});

// ---------- 区间计算 ----------
test('rangeVersions：(0.9, 1.1] 取 1.0 + 1.1（升序）', () => {
  const tags = ['0.8', '0.9', '1.0', '1.1', '1.2'];   // 升序
  assert.deepEqual(rangeVersions(tags, '0.9', '1.1'), ['1.0', '1.1']);
});

test('rangeVersions：from 不在列表（空/未跟踪）→ include 全部 ≤ to', () => {
  const tags = ['0.8', '0.9', '1.0', '1.1'];
  assert.deepEqual(rangeVersions(tags, '', '1.0'), ['0.8', '0.9', '1.0']);      // 空 from
  assert.deepEqual(rangeVersions(tags, '0.5', '1.0'), ['0.8', '0.9', '1.0']);   // from 不在列表
});

test('rangeVersions：to 不在列表 → 兜底 include 到最新（> from 的全部）', () => {
  const tags = ['0.8', '0.9', '1.0', '1.1'];
  assert.deepEqual(rangeVersions(tags, '0.9', '9.9'), ['1.0', '1.1']);          // 9.9 未命中 → 取到末尾
});

test('rangeVersions：空区间（from===to / from 已最新 / to<from）', () => {
  const tags = ['0.8', '0.9', '1.0'];
  assert.deepEqual(rangeVersions(tags, '1.0', '1.0'), []);                      // from===to → 空
  assert.deepEqual(rangeVersions(tags, '1.0', '1.0'), []);
  assert.deepEqual(rangeVersions([], '0.9', '1.0'), []);                        // 无 tag
  // from 在 to 之后（现场已比目标新）→ 空
  assert.deepEqual(rangeVersions(tags, '1.0', '0.9'), []);
});

test('rangeVersions：from===某 tag 严格大于（不含 from 本身）', () => {
  const tags = ['0.8', '0.9', '1.0', '1.1'];
  assert.deepEqual(rangeVersions(tags, '0.8', '1.1'), ['0.9', '1.0', '1.1']);   // 不含 0.8
});

// ---------- 累积汇总 ----------
test('accumulate：只汇总已登记版本，跳过未登记 / 空登记；带 version 标签', () => {
  const releases = {
    '1.0': { tasks: [{ id: 'vt1', title: '任务A', desc: '' }], sqls: [{ id: 'vs1', name: 'sqlA', content: 'A;' }] },
    '1.1': { tasks: [{ id: 'vt2', title: '任务B' }], sqls: [] },
    '1.2': { tasks: [], sqls: [] },                        // 空登记 → 跳过
    // 1.3 未登记（releases 无键）
  };
  const acc = accumulate(['1.0', '1.1', '1.2', '1.3'], releases);
  assert.deepEqual(acc.versionsInRange, ['1.0', '1.1']);   // 1.2 空、1.3 未登记 都被排除
  assert.equal(acc.tasks.length, 2);
  assert.equal(acc.tasks[0].version, '1.0');
  assert.equal(acc.tasks[1].version, '1.1');
  assert.equal(acc.sqls.length, 1);
  assert.equal(acc.sqls[0].version, '1.0');
  assert.equal(acc.sqls[0].name, 'sqlA');
});

// ---------- 完成态左连 ----------
test('joinProgress：按 (version,id) 左连 done/by/at + 汇总 done/total', () => {
  const tasks = [
    { version: '1.0', id: 'vt1', title: 'A' },
    { version: '1.1', id: 'vt2', title: 'B' },
  ];
  const progress = {   // updateProgress[productId]
    '1.0': { tasks: { vt1: { done: true, by: '张三', at: '2026-08-03 10:00' } } },
    '1.1': { tasks: {} },
  };
  const j = joinProgress(tasks, progress, 'tasks');
  assert.equal(j.done, 1);
  assert.equal(j.total, 2);
  assert.equal(j.rows[0].done, true);
  assert.equal(j.rows[0].by, '张三');
  assert.equal(j.rows[0].at, '2026-08-03 10:00');
  assert.equal(j.rows[1].done, false);
  assert.equal(j.rows[1].by, '');
});

test('joinProgress：sqls 分桶独立于 tasks（同 id 不串）', () => {
  const sqls = [{ version: '1.0', id: 'vs1', name: 'S' }];
  const progress = { '1.0': { tasks: { vs1: { done: true } }, sqls: {} } };  // tasks 桶有 vs1 但 sqls 桶没有
  const j = joinProgress(sqls, progress, 'sqls');
  assert.equal(j.done, 0);   // 不误取 tasks 桶
});

// ---------- 勾选幂等 ----------
test('applyToggle：done 真写入、幂等；done 假删键、幂等；不改入参', () => {
  const p0 = {};
  const r1 = applyToggle(p0, '1.0', 'tasks', 'vt1', true, '李四', '2026-08-03 11:00');
  assert.equal(r1.changed, true);
  assert.equal(r1.progress['1.0'].tasks.vt1.done, true);
  assert.equal(r1.progress['1.0'].tasks.vt1.by, '李四');
  assert.deepEqual(p0, {});                                  // 入参未变

  const r2 = applyToggle(r1.progress, '1.0', 'tasks', 'vt1', true, '王五', 'x');
  assert.equal(r2.changed, false);                           // 幂等：已完成不重复写
  assert.equal(r2.progress['1.0'].tasks.vt1.by, '李四');     // by 未被覆盖

  const r3 = applyToggle(r1.progress, '1.0', 'tasks', 'vt1', false, '', '');
  assert.equal(r3.changed, true);
  assert.equal('vt1' in r3.progress['1.0'].tasks, false);    // 假删

  const r4 = applyToggle(r3.progress, '1.0', 'tasks', 'vt1', false, '', '');
  assert.equal(r4.changed, false);                           // 幂等：本就未完成
});

test('applyToggle：sqls 桶与 tasks 桶隔离', () => {
  let p = {};
  p = applyToggle(p, '1.0', 'tasks', 'x', true, 'a', 't').progress;
  p = applyToggle(p, '1.0', 'sqls', 'x', true, 'a', 't').progress;
  assert.equal(p['1.0'].tasks.x.done, true);
  assert.equal(p['1.0'].sqls.x.done, true);
  // 取消 tasks.x 不影响 sqls.x
  p = applyToggle(p, '1.0', 'tasks', 'x', false, '', '').progress;
  assert.equal('x' in p['1.0'].tasks, false);
  assert.equal(p['1.0'].sqls.x.done, true);
});

// ---------- 合并 SQL ----------
test('mergeSql：按版本升序拼接 + 每版本分隔注释 + 文件头注释 + 顺序正确', () => {
  const sqls = [
    { version: '1.0', id: 'vs1', name: '加列', content: 'ALTER TABLE a ADD c INT;' },
    { version: '1.0', id: 'vs2', name: '初值', content: 'UPDATE a SET c=0;' },
    { version: '1.1', id: 'vs3', name: '建表', content: 'CREATE TABLE b(id INT);' },
  ];
  const out = mergeSql(sqls, { productName: '合理用药系统', from: '0.9', to: '1.1', site: '山东省立医院' });
  // 文件头
  assert.ok(out.includes('产品：合理用药系统'));
  assert.ok(out.includes('医院：山东省立医院'));
  assert.ok(out.includes('版本区间：(0.9, 1.1]'));
  // 分隔注释：每个版本一段
  assert.ok(out.includes('================ 合理用药系统 1.0 ================'));
  assert.ok(out.includes('================ 合理用药系统 1.1 ================'));
  // 正文都在
  assert.ok(out.includes('ALTER TABLE a ADD c INT;'));
  assert.ok(out.includes('UPDATE a SET c=0;'));
  assert.ok(out.includes('CREATE TABLE b(id INT);'));
  // 顺序：1.0 段在 1.1 段之前；同版本内 vs1 在 vs2 之前
  assert.ok(out.indexOf('1.0 ====') < out.indexOf('1.1 ===='));
  assert.ok(out.indexOf('ALTER TABLE a ADD c INT;') < out.indexOf('UPDATE a SET c=0;'));
  assert.ok(out.indexOf('UPDATE a SET c=0;') < out.indexOf('CREATE TABLE b(id INT);'));
});

test('mergeSql：空 SQL → 回含说明注释的文本，不抛错', () => {
  const out = mergeSql([], { productName: '合理用药系统', from: '', to: '1.0', site: '' });
  assert.ok(typeof out === 'string' && out.length > 0);
  assert.ok(out.includes('暂无已登记的 SQL 脚本'));
  assert.ok(out.includes('版本区间：(最早, 1.0]'));   // 空 from 显「最早」
});

// ---------- 越权判据 ----------
test('siteAllowed：管理员不限；非管理员按 sites', () => {
  assert.equal(siteAllowed(true, [], '任意院'), true);
  assert.equal(siteAllowed(false, ['A院', 'B院'], 'A院'), true);
  assert.equal(siteAllowed(false, ['A院'], 'B院'), false);
  assert.equal(siteAllowed(false, null, 'A院'), false);
});

// ---------- 端到端：区间→累积→左连→合并 一条龙 ----------
test('端到端：现场 0.9 升 1.1，取 1.0+1.1 累积，左连完成态，合并 SQL', () => {
  const tags = ['0.8', '0.9', '1.0', '1.1', '1.2'];          // 升序
  const releases = {
    '1.0': { tasks: [{ id: 'vt1', title: '停服' }], sqls: [{ id: 'vs1', name: '加列', content: 'ALTER TABLE a ADD c INT;' }] },
    '1.1': { tasks: [{ id: 'vt2', title: '替换 jar' }], sqls: [{ id: 'vs2', name: '建索引', content: 'CREATE INDEX i ON a(c);' }] },
  };
  const range = rangeVersions(tags, '0.9', '1.1');
  assert.deepEqual(range, ['1.0', '1.1']);
  const acc = accumulate(range, releases);
  assert.equal(acc.tasks.length, 2);
  assert.equal(acc.sqls.length, 2);
  const progress = { '1.0': { sqls: { vs1: { done: true, by: '实施', at: '2026-08-03 09:00' } } } };
  const jt = joinProgress(acc.tasks, progress, 'tasks');
  const js = joinProgress(acc.sqls, progress, 'sqls');
  assert.equal(jt.done, 0);
  assert.equal(js.done, 1);                                   // vs1 已执行
  assert.equal(js.total, 2);
  const merged = mergeSql(acc.sqls, { productName: '合理用药系统', from: '0.9', to: '1.1', site: 'X院' });
  assert.ok(merged.indexOf('ALTER TABLE a ADD c INT;') < merged.indexOf('CREATE INDEX i ON a(c);'));
});
