// FS-06 咨询经验引用真实性：执行真实 prompt 组装/引用归一/前端事件门控，并锁住 API 接线与历史恢复。
// 用法：node --test tools/fs-06-consult-kb-evidence.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
const FIELD = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');
const PROMPTS = fs.readFileSync(path.join(ROOT, 'prompts.mjs'), 'utf8');

function extractBalancedFunction(src, marker) {
  const start = src.indexOf(marker); assert.ok(start >= 0, `应找到 ${marker}`);
  const open = src.indexOf('{', start); let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${marker} 未配平`);
}

const consultSystem = new Function(
  'specIndex', 'subsystemNames', 'renderPromptTpl', 'DATA_DIR',
  extractBalancedFunction(SERVER, 'function consultSystem(') + '\nreturn consultSystem;'
)(() => '模块索引', () => ['审方'], (_dir, key, vars) => ({ key, vars }), '/tmp');

const consultKbRefs = new Function(
  'kbSubLabel', extractBalancedFunction(SERVER, 'function consultKbRefs(') + '\nreturn consultKbRefs;'
)((_pid, sub) => sub === 'audit' ? '审方' : '');

const normalizeKbRefs = new Function(extractBalancedFunction(FIELD, 'function normalizeKbRefs(') + '\nreturn normalizeKbRefs;')();
const consultKbFromEvent = new Function(
  'normalizeKbRefs', extractBalancedFunction(FIELD, 'function consultKbFromEvent(') + '\nreturn consultKbFromEvent;'
)(normalizeKbRefs);

test('普通与深入思考都把同一真实经验 kbBlock 注入对应模型提示', () => {
  const hit = [{ q: '任务为什么没收到', a: '先检查接单状态。', subsystem: 'audit' }];
  const normal = consultSystem({ name: '合理用药' }, 'v1', hit, [], null);
  const deep = consultSystem({ name: '合理用药' }, 'v1', hit, [], [{ file: 'a.js', text: 'code' }]);
  assert.equal(normal.key, 'consultNormal');
  assert.equal(deep.key, 'consultDeep');
  for (const result of [normal, deep]) {
    assert.match(result.vars.kbBlock, /任务为什么没收到/);
    assert.match(result.vars.kbBlock, /先检查接单状态/);
  }
  assert.match(PROMPTS, /consultNormal[\s\S]*?\{\{kbBlock\}\}/, '普通模板保留 kbBlock');
  assert.match(PROMPTS, /consultDeep[\s\S]*?\{\{kbBlock\}\}/, '深入模板保留 kbBlock');
});

test('无命中提示明确禁止伪称参考经验，普通/深入一致', () => {
  for (const code of [null, [{ file: 'a.js', text: 'code' }]]) {
    const result = consultSystem({ name: '合理用药' }, '', [], [], code);
    assert.match(result.vars.kbBlock, /本次未检索到相关经验库条目/);
    assert.match(result.vars.kbBlock, /不要声称/);
  }
});

test('服务端引用归一真实执行：限 5 条、字段收敛、子系统中文标签', () => {
  const refs = consultKbRefs('p1', Array.from({ length: 7 }, (_, i) => ({ q: `问${i}`, a: `答${i}`, subsystem: 'audit', module: '<模块>' })));
  assert.equal(refs.length, 5);
  assert.deepEqual(refs[0], { q: '问0', a: '答0', subsystem: 'audit', module: '<模块>', subsystemLabel: '审方' });
});

test('前端只接受服务端明确 kbInjected=true 的非空引用事件', () => {
  const kb = [{ q: '<img onerror=x>', a: '**步骤**', subsystem: 'audit' }];
  assert.equal(consultKbFromEvent({ kb }).length, 0, '旧式/未确认事件不展示');
  assert.equal(consultKbFromEvent({ kb, kbInjected: false }).length, 0, '明确未注入不展示');
  assert.equal(consultKbFromEvent({ kb: [], kbInjected: true }).length, 0, '空命中不展示');
  assert.deepEqual(consultKbFromEvent({ kb, kbInjected: true }), [{ q: '<img onerror=x>', a: '**步骤**', subsystem: 'audit', module: '', subsystemLabel: '' }]);
});

test('/api/consult 在首个有效模型片段内才发引用，失败/无模型计数为 0，并持久化实际引用', () => {
  const start = SERVER.indexOf("if (url.pathname === '/api/consult'");
  const end = SERVER.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const route = SERVER.slice(start, end);
  const call = route.indexOf('await callModelStream');
  const emit = route.indexOf('sse({ kb: kbRefs, kbInjected: true })');
  assert.ok(call >= 0 && emit > call, '引用事件位于模型流回调内，而非模型调用前');
  assert.doesNotMatch(route.slice(0, call), /sse\(\{\s*kb:/, '模型调用前没有引用提示');
  assert.match(route, /if \(!kbInjected && kbRefs\.length\)/, '仅首次且非空时发送');
  assert.match(route, /kbHits: kbInjected \? kbRefs\.length : 0/, '完成计数按实际注入门控');
  assert.match(route, /chat\[chat\.length - 1\]\.kbRefs = kbRefs/, '实际引用随本轮助手消息持久化');
  // PD-03：consult 改用带分变体 kbRetrieveScored 一次拿带分结果，hits 由 .map(x=>x.e) 派生（同 kbRetrieve 召回口径）；
  //   检索失败仍 catch 降级为空 hits（不误显示、不阻断咨询）——结构变、行为不变。
  assert.match(route, /try \{ kbScored = await kbRetrieveScored\(proj\.id, retrievalQuery, 5, 2\); hits = kbScored\.map\(x => x\.e\); \} catch \{ hits = \[\]; kbScored = \[\]; \}/, '检索失败降级为空命中，不误显示也不阻断咨询（PD-03：kbRetrieveScored 派生 hits）');
});

test('field 请求不回传引用声明，实时/草稿/系统快照/历史 reopen 都按助手消息恢复', () => {
  const send = extractBalancedFunction(FIELD, 'function sendConsult(');
  assert.match(send, /messages: chat\.messages\.map\(function \(m\) \{ return \{ role: m\.role, content: m\.content \}; \}\)/, '请求只传 role/content');
  assert.match(send, /consultKbFromEvent\(o\)/, '流式事件经过真实注入门控');
  assert.match(FIELD, /m\.role === 'assistant' && normalizeKbRefs\(m\.kbRefs\)\.length && !isNonSubstantiveReply\(m\.content\)\) renderKbCite/, '草稿/系统快照重放助手引用（没覆盖/无相关的非实质答复不显引用）');
  assert.match(FIELD, /kbRefs: normalizeKbRefs\(m\.kbRefs\)/, '历史 reopen 读取服务端持久化引用');
  assert.match(FIELD, /已参考经验（' \+ kb\.length \+ '条）/, '用户文案准确且不再写“参考经验库”');
});
