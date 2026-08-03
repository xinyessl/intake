// FS-06 现场实施代办清单 · 纯文件存逻辑单测（不依赖 MySQL / 不 spawn server，本地可直接跑：node --test tools/fs-06-checklist.logic.test.mjs）
//   覆盖：模板规范化(title 非空/截断/去重)、模板增删项后各院进度、部署清单勾选/取消幂等、
//         implTasks 按 id 合并保留旧完成态、批次清单勾选幂等、越权判断逻辑。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clip, normTemplateTasks, deployProgress, deployProgressForProduct, deployAggProgress,
  isNestedDeployTasks, productDeployTasksOf, deployRows, applyDeployToggle,
  mergeImplTasks, applyBatchTaskToggle, implProgress, siteAllowed
} from './checklist-logic.mjs';

// 确定性 id 生成器（测试用，避免随机）
function seqGen() { let n = 0; return () => 't' + String(++n).padStart(4, '0'); }

test('clip：trim + 截断到 N', () => {
  assert.equal(clip('  abc  ', 10), 'abc');
  assert.equal(clip('a'.repeat(200), 120).length, 120);
  assert.equal(clip(null, 10), '');
  assert.equal(clip(undefined, 10), '');
});

test('normTemplateTasks：title 非空校验（空项丢弃）+ 截断 title≤120/desc≤1000 + 缺 id 补 + 去重', () => {
  const gen = seqGen();
  const out = normTemplateTasks([
    { title: '装数据库', desc: '执行建库脚本' },        // 无 id → 补
    { title: '   ', desc: '空标题应丢弃' },              // 空标题 → 丢
    { id: 'tX', title: 'a'.repeat(150), desc: 'b'.repeat(1200) },  // 截断
    { id: 'tX', title: '同 id 项' },                    // id 冲突 → 重新分配
  ], gen);
  assert.equal(out.length, 3);
  assert.equal(out[0].id, 't0001');                     // 缺 id 补
  assert.equal(out[0].title, '装数据库');
  assert.equal(out[1].id, 'tX');
  assert.equal(out[1].title.length, 120);               // title 截断
  assert.equal(out[1].desc.length, 1000);               // desc 截断
  assert.notEqual(out[2].id, 'tX');                     // 冲突 id 被重分
  const ids = out.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length);          // 全唯一
});

test('deployProgressForProduct（单产品作用域）：live 模板为分母，某产品完成态 done:true 为分子；overlay 语义（指向已删项不计）', () => {
  const tpl = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  // 某产品完成了 t1、t3，另外还残留一条指向已删模板项 tOld 的完成态
  const pdt = { t1: { done: true }, t3: { done: true }, tOld: { done: true } };
  assert.deepEqual(deployProgressForProduct(tpl, pdt), { done: 2, total: 3 });   // tOld 不在模板 → 不计入分子

  // 模板新增一项 t4（分母变 4），该产品进度自动变 2/4
  assert.deepEqual(deployProgressForProduct([...tpl, { id: 't4' }], pdt), { done: 2, total: 4 });
  // 模板删除 t3（分母变 2），分子随之只剩 t1（t3 完成态指向已删项不计）
  assert.deepEqual(deployProgressForProduct([{ id: 't1' }, { id: 't2' }], pdt), { done: 1, total: 2 });
  // 空模板 → 0/0
  assert.deepEqual(deployProgressForProduct([], pdt), { done: 0, total: 0 });
  // 无完成态（新产品）→ 0/total
  assert.deepEqual(deployProgressForProduct(tpl, undefined), { done: 0, total: 3 });
});

test('deployProgress 旧签名兼容 deployProgress(templateTasks, deployTasks) 仍工作（单产品口径）', () => {
  const tpl = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  const dt = { t1: { done: true }, t3: { done: true } };
  assert.deepEqual(deployProgress(tpl, dt), { done: 2, total: 3 });
  assert.deepEqual(deployProgress([], dt), { done: 0, total: 0 });
});

test('isNestedDeployTasks：区分嵌套 {pid:{taskId:{...}}} 与旧 flat {taskId:{done,...}}；空对象视作嵌套', () => {
  assert.equal(isNestedDeployTasks({}), true);                                          // 空 → 嵌套（安全）
  assert.equal(isNestedDeployTasks(undefined), true);
  assert.equal(isNestedDeployTasks({ pms: { t1: { done: true } } }), true);            // 嵌套形状
  assert.equal(isNestedDeployTasks({ t1: { done: true, by: 'x', at: 'y' } }), false);  // 旧 flat（叶子含 done/by/at）
  assert.equal(isNestedDeployTasks({ t1: { done: true } }), false);                    // 旧 flat（叶子含 done）
});

test('productDeployTasksOf：嵌套取 dt[pid]；旧 flat / 缺失 → {}（安全丢弃，不臆造塞旧数据给某产品）', () => {
  const nested = { pms: { t1: { done: true } }, audit: { t2: { done: true } } };
  assert.deepEqual(productDeployTasksOf(nested, 'pms'), { t1: { done: true } });
  assert.deepEqual(productDeployTasksOf(nested, 'audit'), { t2: { done: true } });
  assert.deepEqual(productDeployTasksOf(nested, 'unknown'), {});                        // 该产品无完成态 → {}
  // 旧 flat 形状 → 一律 {}（迁移安全，几乎无历史完成数据）
  assert.deepEqual(productDeployTasksOf({ t1: { done: true, by: 'x', at: 'y' } }, 'pms'), {});
});

test('按产品各自记进度：产品A勾不影响产品B（同一标准模板，每系统各自完成态）', () => {
  const tpl = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  const dt = { pms: { t1: { done: true }, t2: { done: true } }, audit: { t3: { done: true } } };
  // 产品 pms 完成 2/3；产品 audit 完成 1/3——互不影响
  assert.deepEqual(deployProgressForProduct(tpl, productDeployTasksOf(dt, 'pms')), { done: 2, total: 3 });
  assert.deepEqual(deployProgressForProduct(tpl, productDeployTasksOf(dt, 'audit')), { done: 1, total: 3 });
});

test('deployAggProgress（跨产品聚合·运营列表 N/M）：分母=M×P、分子=各产品之和；模板增删/无产品/旧 flat 边界', () => {
  const tpl = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];   // M=3
  const dt = { pms: { t1: { done: true }, t2: { done: true } }, audit: { t3: { done: true } } };
  // P=2 → 分母 6；分子 = pms(2) + audit(1) = 3
  assert.deepEqual(deployAggProgress(tpl, dt, ['pms', 'audit']), { done: 3, total: 6 });
  // 只算某一个产品（P=1）→ 分母 3、分子 2
  assert.deepEqual(deployAggProgress(tpl, dt, ['pms']), { done: 2, total: 3 });
  // 无产品 → 0/0
  assert.deepEqual(deployAggProgress(tpl, dt, []), { done: 0, total: 0 });
  // 空模板 → 0/0（无论几个产品）
  assert.deepEqual(deployAggProgress([], dt, ['pms', 'audit']), { done: 0, total: 0 });
  // 模板增一项 t4（M=4）→ 分母 8、分子仍 3（未联动改完成态）
  assert.deepEqual(deployAggProgress([...tpl, { id: 't4' }], dt, ['pms', 'audit']), { done: 3, total: 8 });
  // productIds 去重：重复 'pms' 只算一次
  assert.deepEqual(deployAggProgress(tpl, dt, ['pms', 'pms']), { done: 2, total: 3 });
  // 该院上了产品但没勾任何项 → 分子 0、分母仍 M×P
  assert.deepEqual(deployAggProgress(tpl, {}, ['pms', 'audit']), { done: 0, total: 6 });
  // 旧 flat deployTasks → 分子按 0 计（安全丢弃）、分母仍 M×P
  assert.deepEqual(deployAggProgress(tpl, { t1: { done: true, by: 'x', at: 'y' } }, ['pms']), { done: 0, total: 3 });
});

test('模板增删项后不同产品各自进度独立正确（每系统各自记进度）', () => {
  const tpl = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];
  const dt = {
    pms: { t1: { done: true, by: 'implA', at: '2026-08-03 10:00' } },      // pms 完成 1 项
    audit: { t1: { done: true }, t2: { done: true }, t3: { done: true } }, // audit 全完成
    report: {}                                                             // report 未开始
  };
  assert.deepEqual(deployProgressForProduct(tpl, productDeployTasksOf(dt, 'pms')), { done: 1, total: 3 });
  assert.deepEqual(deployProgressForProduct(tpl, productDeployTasksOf(dt, 'audit')), { done: 3, total: 3 });
  assert.deepEqual(deployProgressForProduct(tpl, productDeployTasksOf(dt, 'report')), { done: 0, total: 3 });
});

test('deployRows：模板 left join 完成态（带完成人/时间）；空模板 → []', () => {
  const tpl = [{ id: 't1', title: '装库', desc: '建库脚本' }, { id: 't2', title: '配网络', desc: '' }];
  const dt = { t1: { done: true, by: 'zhangsan', at: '2026-08-03 10:00' } };
  const rows = deployRows(tpl, dt);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 't1', title: '装库', desc: '建库脚本', done: true, by: 'zhangsan', at: '2026-08-03 10:00' });
  assert.deepEqual(rows[1], { id: 't2', title: '配网络', desc: '', done: false, by: '', at: '' });
  assert.deepEqual(deployRows([], dt), []);
});

test('applyDeployToggle：勾选写完成态、取消删键、幂等（同态不重复写，不改入参）', () => {
  const base = {};
  // 勾选 t1
  const r1 = applyDeployToggle(base, 't1', true, 'implA', '2026-08-03 10:00');
  assert.equal(r1.changed, true);
  assert.deepEqual(r1.deployTasks, { t1: { done: true, by: 'implA', at: '2026-08-03 10:00' } });
  assert.deepEqual(base, {});   // 不改入参

  // 再次勾选 t1（幂等，不 changed）
  const r2 = applyDeployToggle(r1.deployTasks, 't1', true, 'implB', '2026-08-03 11:00');
  assert.equal(r2.changed, false);
  assert.equal(r2.deployTasks.t1.by, 'implA');   // 保留原完成人（幂等不覆盖）

  // 取消 t1 → 删键
  const r3 = applyDeployToggle(r1.deployTasks, 't1', false);
  assert.equal(r3.changed, true);
  assert.deepEqual(r3.deployTasks, {});

  // 再次取消（本就未完成，幂等不 changed）
  const r4 = applyDeployToggle(r3.deployTasks, 't1', false);
  assert.equal(r4.changed, false);
});

test('mergeImplTasks：按 id 合并保留旧 done/doneBy/doneAt，新项 done=false，title 空丢弃/截断，删项即删', () => {
  const gen = seqGen();
  const existing = [
    { id: 'a1', title: '停服', desc: '', done: true, doneBy: 'implX', doneAt: '2026-08-01 09:00' },
    { id: 'a2', title: '备份', desc: '', done: false, doneBy: '', doneAt: '' },
    { id: 'a3', title: '旧项将被删', desc: '', done: true, doneBy: 'implY', doneAt: '2026-08-01 10:00' },
  ];
  // 运营重定义：改 a1 标题、保留 a2、删 a3、加一条新项
  const merged = mergeImplTasks(existing, [
    { id: 'a1', title: '停应用服务', desc: '优雅停机' },   // 改标题 → 保留完成态
    { id: 'a2', title: '备份数据' },
    { title: '灰度放量' },                                 // 新项 → done=false
    { title: '  ' },                                       // 空标题 → 丢
  ], gen);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].id, 'a1');
  assert.equal(merged[0].title, '停应用服务');
  assert.equal(merged[0].done, true);                     // 保留旧完成态
  assert.equal(merged[0].doneBy, 'implX');
  assert.equal(merged[0].doneAt, '2026-08-01 09:00');
  assert.equal(merged[1].done, false);                    // a2 原本未完成
  assert.equal(merged[2].title, '灰度放量');
  assert.equal(merged[2].done, false);                    // 新项未完成
  assert.ok(!merged.some(t => t.id === 'a3'));            // a3 已删
});

test('mergeImplTasks：title 截断 ≤120 / desc ≤1000', () => {
  const merged = mergeImplTasks([], [{ title: 'a'.repeat(200), desc: 'b'.repeat(2000) }], seqGen());
  assert.equal(merged[0].title.length, 120);
  assert.equal(merged[0].desc.length, 1000);
});

test('applyBatchTaskToggle：全局勾选/取消，幂等（同态不重复写），不存在项返回 null', () => {
  const tasks = [
    { id: 'a1', title: '停服', done: false, doneBy: '', doneAt: '' },
    { id: 'a2', title: '备份', done: false, doneBy: '', doneAt: '' },
  ];
  // 勾 a1（全局完成，谁勾算完成）
  const r1 = applyBatchTaskToggle(tasks, 'a1', true, '张三', '2026-08-03 12:00');
  assert.equal(r1.changed, true);
  assert.equal(tasks[0].done, true);
  assert.equal(tasks[0].doneBy, '张三');
  assert.equal(tasks[0].doneAt, '2026-08-03 12:00');

  // 再勾 a1（幂等，同态不改）
  const r2 = applyBatchTaskToggle(tasks, 'a1', true, '李四', '2026-08-03 13:00');
  assert.equal(r2.changed, false);
  assert.equal(tasks[0].doneBy, '张三');   // 保留原完成人

  // 取消 a1 → 清完成人/时间
  const r3 = applyBatchTaskToggle(tasks, 'a1', false);
  assert.equal(r3.changed, true);
  assert.equal(tasks[0].done, false);
  assert.equal(tasks[0].doneBy, '');
  assert.equal(tasks[0].doneAt, '');

  // 不存在的项
  const r4 = applyBatchTaskToggle(tasks, 'nope', true, 'x', 'y');
  assert.equal(r4.changed, false);
  assert.equal(r4.item, null);
});

test('implProgress：done 计数 / 总数', () => {
  assert.deepEqual(implProgress([{ done: true }, { done: false }, { done: true }]), { done: 2, total: 3 });
  assert.deepEqual(implProgress([]), { done: 0, total: 0 });
  assert.deepEqual(implProgress(undefined), { done: 0, total: 0 });
});

test('siteAllowed：管理员不限；否则 site 须 ∈ user.sites（越权收敛判据）', () => {
  assert.equal(siteAllowed(true, [], '任意医院'), true);           // 管理员不限
  assert.equal(siteAllowed(false, ['甲医院', '乙医院'], '甲医院'), true);
  assert.equal(siteAllowed(false, ['甲医院'], '乙医院'), false);    // 越权
  assert.equal(siteAllowed(false, null, '甲医院'), false);         // 无 sites → 拒
  assert.equal(siteAllowed(false, ['甲医院'], ' 甲医院 '), true);  // trim 后匹配
});
