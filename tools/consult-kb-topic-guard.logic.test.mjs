// consult 经验库「主题/实体维度」二次校验（consultKbTopicGuard）· 脱库逻辑测试
//   线上真实 bug：用户问「药师工作站用户权限如何配置」，AI 挂了「已参考经验(2条)」，但那 2 条 KB 是
//   「医嘱干预功能中配置药品说明书跳转地址」——阿里云 qwen embedding 把「如何…配置…」的共同句式算出 sim≥0.5
//   过了强度门槛（CONSULT_KB_MIN_SIM），但业务实体完全无关（权限 vs 说明书跳转；药师工作站 vs 医嘱干预）。
//   纯语义阈值拦不住这种「同是配置类但实体无关」。修法：强度门槛之上再加 consultKbTopicGuard 主题维度校验——
//     实体零交集 + （子系统不符 或 语义分<0.6）→ 拦；实体有交集一律放行（不误伤真相关）。
//   本测：从 server.mjs **抠真身** consultKbTopicGuard + consultTopicEntityTokens + kbTokenize（连真实停用词表），
//         断言本 case 被拦、真相关放行、子系统信号、停用词不误删关键实体。
//   纯逻辑无 DB、无 server boot；抠真身=行为真实（比 mock 强）。用法：node --test tools/consult-kb-topic-guard.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

// 抠函数体（配平大括号）——同项目其它 *.logic.test.mjs extractFn 口径。
function extractFn(src, marker) {
  const start = src.indexOf(marker); assert.ok(start >= 0, `应找到 ${marker}`);
  const open = src.indexOf('{', start); let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${marker} 未配平`);
}
// 抠 const NAME = new Set([...]);（停用词表）——匹配到分号结束
function extractSetConst(src, name) {
  const start = src.indexOf(`const ${name} = new Set(`); assert.ok(start >= 0, `应找到常量 ${name}`);
  const semi = src.indexOf(');', start); assert.ok(semi >= 0, `${name} 未闭合`);
  return src.slice(start, semi + 2);
}

// ---- 抠真身：kbTokenize + 停用词表 + consultTopicEntityTokens + consultKbTopicGuard（连真实实现）----
const kbTokenize = new Function(extractFn(SRC, 'function kbTokenize(') + '\nreturn kbTokenize;')();
const CONSULT_KB_TOPIC_STOPWORDS = new Function(extractSetConst(SRC, 'CONSULT_KB_TOPIC_STOPWORDS') + '\nreturn CONSULT_KB_TOPIC_STOPWORDS;')();
const consultTopicEntityTokens = new Function(
  'kbTokenize', 'CONSULT_KB_TOPIC_STOPWORDS',
  extractFn(SRC, 'function consultTopicEntityTokens(') + '\nreturn consultTopicEntityTokens;'
)(kbTokenize, CONSULT_KB_TOPIC_STOPWORDS);
const consultKbTopicGuard = new Function(
  'consultTopicEntityTokens',
  extractFn(SRC, 'function consultKbTopicGuard(') + '\nreturn consultKbTopicGuard;'
)(consultTopicEntityTokens);

// score→sim 复刻：语义可用时 rank = sim + 微量 lex 加权（≤~0.012）；本测直接用 sim 近似（lex 加权忽略）。
const semScore = (sim) => sim + 0.005;

test('★ 本 case 必须拦：问「药师工作站用户权限如何配置」误引「医嘱干预…药品说明书跳转地址」（子系统不同 audit + 实体零交集）', () => {
  const query = '药师工作站用户权限如何配置';
  const entry = { q: '医嘱干预功能中配置药品说明书跳转地址', subsystem: 'audit' };
  // 当前咨询子系统 = 药师工作站（英文 name，非 audit）；embedding 靠共同句式给了 sim=0.52（过强度门槛却实体无关）
  const ok = consultKbTopicGuard(query, entry, { subsystem: 'pharmacy-workstation', _score: semScore(0.52) });
  assert.equal(ok, false, '★ 实体零交集 + 子系统确不同 → 拦（不再误挂「已参考经验」）');
});

test('本 case 变体：即便语义分较高（0.7），实体零交集 + 子系统不同仍拦（子系统是强信号）', () => {
  const ok = consultKbTopicGuard('药师工作站用户权限如何配置',
    { q: '医嘱干预功能中配置药品说明书跳转地址', subsystem: 'audit' },
    { subsystem: 'pharmacy-workstation', _score: semScore(0.7) });
  assert.equal(ok, false, '子系统确不同即拦，不看语义分（子系统 = 强信号）');
});

test('★ 真相关必须放行：问「用户权限怎么分配」命中「药师工作站用户权限如何配置」（同子系统 + 实体交集 用户/权限）', () => {
  const ok = consultKbTopicGuard('用户权限怎么分配',
    { q: '药师工作站用户权限如何配置', subsystem: 'pharmacy-workstation' },
    { subsystem: 'pharmacy-workstation', _score: semScore(0.62) });
  assert.equal(ok, true, '★ 实体有交集（用户/权限）→ 放行（本该有的经验要能引用）');
});

test('实体有交集 → 放行，哪怕子系统不同（防误伤 B-KB-REL2「排班表导出」虽属 report 但确实被问到）', () => {
  const query = '审方规则zx88931task药师没拿到任务，另外药师排班表怎么导出到excel';
  const weakEntry = { q: 'FS06相关度：药师排班表怎么导出到excel', subsystem: 'report' };
  const ok = consultKbTopicGuard(query, weakEntry, { subsystem: 'audit', _score: 10 });   // 纯词模式 score=10
  assert.equal(ok, true, '★ query 确实问了排班表导出（实体大量交集）→ 放行，不因 report≠audit 误伤（B-KB-REL2 kbHits=2 前提）');
});

test('子系统为空（entry 或当前）→ 缺信息放行（不误伤）', () => {
  // 实体零交集 + entry.subsystem 空 + 语义分够高（0.65）→ 放行
  assert.equal(consultKbTopicGuard('药师工作站用户权限如何配置',
    { q: '医嘱干预功能中配置药品说明书跳转地址', subsystem: '' },
    { subsystem: 'pharmacy-workstation', _score: semScore(0.65) }), true, 'entry 子系统空 + 语义分够高 → 放行');
  // 当前子系统空（用户没选系统，全部）+ 语义分够高 → 放行
  assert.equal(consultKbTopicGuard('药师工作站用户权限如何配置',
    { q: '医嘱干预功能中配置药品说明书跳转地址', subsystem: 'audit' },
    { subsystem: '', _score: semScore(0.65) }), true, '当前子系统空 + 语义分够高 → 放行');
});

test('子系统一致 → 放行（哪怕实体零交集，同系统内不轻易拦）', () => {
  const ok = consultKbTopicGuard('药师工作站用户权限如何配置',
    { q: '医嘱干预功能中配置药品说明书跳转地址', subsystem: 'audit' },
    { subsystem: 'audit', _score: semScore(0.65) });
  assert.equal(ok, true, '同子系统 + 语义分够高 → 放行（子系统信号一致，不靠它拦）');
});

test('子系统包含关系（同族 audit vs audit-pro）→ 不拦', () => {
  const ok = consultKbTopicGuard('药师工作站用户权限如何配置',
    { q: '医嘱干预功能中配置药品说明书跳转地址', subsystem: 'audit' },
    { subsystem: 'audit-pro', _score: semScore(0.65) });
  assert.equal(ok, true, 'audit ⊂ audit-pro 视为同族 → 不拦');
});

test('辅助信号：实体零交集 + 子系统缺信息 + 语义分不足(0.55) → 拦', () => {
  const ok = consultKbTopicGuard('药师工作站用户权限如何配置',
    { q: '医嘱干预功能中配置药品说明书跳转地址', subsystem: '' },
    { subsystem: '', _score: semScore(0.55) });   // sim≈0.555 < 0.6
  assert.equal(ok, false, '实体零交集 + 无子系统信号 + sim<0.6 → 拦（靠语义不足兜底）');
});

test('停用词不误删关键实体：权限/跳转/地址/说明书 等区分性实体保留', () => {
  const ent = consultTopicEntityTokens('药师工作站用户权限如何配置');
  assert.ok(ent.has('权限'), '★「权限」是关键实体，不能被当停用词删（本 case 核心区分词）');
  assert.ok(ent.has('用户'), '「用户」保留');
  const ent2 = consultTopicEntityTokens('药品说明书跳转地址');
  assert.ok(ent2.has('跳转'), '「跳转」保留');
  assert.ok(ent2.has('地址'), '「地址」保留');
  assert.ok(ent2.has('说明') || ent2.has('明书'), '「说明书」相关 bigram 保留');
  // 泛化停用词确实被去掉（如何/配置 拆出的泛化 bigram 不进实体集）
  assert.ok(!ent.has('如何'), '「如何」是停用词');
  assert.ok(!ent.has('配置'), '「配置」是无区分度动作词（正是误引根源）→ 停用');
});

test('抽不出实体（空 query / 无 entry）→ 放行（无从判主题，不误伤）', () => {
  // 单字/空 query 产不出任何 bigram token → 实体集空 → 放行
  assert.equal(consultTopicEntityTokens('的').size, 0, '单字（停用）无 bigram → 实体空');
  assert.equal(consultKbTopicGuard('的', { q: '医嘱干预配置说明书', subsystem: 'audit' }, { subsystem: 'x' }), true, 'query 抽不出实体 → 放行');
  assert.equal(consultKbTopicGuard('', { q: '任意', subsystem: 'audit' }, { subsystem: 'x' }), true, '空 query → 放行');
  assert.equal(consultKbTopicGuard('用户权限', null, { subsystem: 'x' }), true, '无 entry → 放行');
});

test('纯词模式（无 sim，score≥1.1）：实体零交集但无子系统不符 → 放行（无 sim 可判，不靠语义拦）', () => {
  const ok = consultKbTopicGuard('审方规则药师任务', { q: '完全无关的排班导出报表', subsystem: '' }, { subsystem: '', _score: 5 });
  assert.equal(ok, true, '纯词模式无 sim + 子系统缺信息 → 保守放行（避免纯词噪声误拦）');
});

/* ---- 端点接线：topicOk 先过主题维度、再走强度过滤；kbScored 全召回仍进 buildRetrieval ---- */
test('consult 端点接线：hits = consultKbFilter(topicOk)，topicOk 由 consultKbTopicGuard 过滤 kbScored', () => {
  assert.match(SRC, /const topicOk = kbScored\.filter\(x => consultKbTopicGuard\(retrievalQuery, x\.e, \{ subsystem: sub,/, '★ topicOk 由 consultKbTopicGuard 过滤（主题维度先过）');
  assert.match(SRC, /hits = consultKbFilter\(topicOk\)\.map\(x => x\.e\);/, '★ hits 由 consultKbFilter(topicOk) 派生（主题过完再过强度）');
  // kbScored 全召回仍进 buildRetrieval（诊断不受主题过滤影响）
  assert.match(SRC, /buildRetrieval\(\{ query: qtext[^}]*\}, searchScored, kbScored, codeHits\)/, 'buildRetrieval 仍吃全召回 kbScored（诊断完整，不收敛）');
});
