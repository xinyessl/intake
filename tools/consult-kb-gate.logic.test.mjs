// consult 经验库注入二次门槛（CHG-consult-未覆盖简洁作答与KB门槛）· 脱库逻辑测试
//   问题：全局 SEM_GATE(0.42) 召回口径下，sim=0.42 卡边缘的**无关**经验条目也被 consult 注入 + 引用（用户实测：问「检验异常值箭头」，
//   命中「医嘱干预药品说明书跳转」sim=0.42，毫不相关却被引用）。修法：consult 拿到 kbScored 后再过一遍 consultKbFilter
//   （语义 sim≥CONSULT_KB_MIN_SIM=0.5 / 纯词 matchedTerms≥CONSULT_KB_MIN_LEX=3），弱于此的不注入、不发 kb 事件、不落 kbRefs。
//   本测：① 从 server.mjs **抠真身** consultKbStrong/consultKbFilter（连真实常量），对边缘/强相关条目断言门控；
//         ② 用 server.mjs 真实 kbTokenize + kbRetrieveScored 的 score 公式，复刻 fs-06 REL 种子数据，
//            确认 REL1 弱匹配掉、REL2 两条强相关都留（不误伤真相关，与连真库冒烟同口径）。
//   纯逻辑无 DB、无 server boot；抠真身=行为真实（比 mock 强）。用法：node --test tools/consult-kb-gate.logic.test.mjs
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
// 抠常量 const NAME = <expr>;（值是数字字面量）
function extractConstNum(src, name) {
  const m = new RegExp(`const ${name}\\s*=\\s*([0-9.]+)`).exec(src);
  assert.ok(m, `应找到常量 ${name}`); return Number(m[1]);
}

// ---- 抠真身：consultKbStrong / consultKbFilter（连真实 CONSULT_KB_MIN_SIM/LEX 常量注入）----
const CONSULT_KB_MIN_SIM = extractConstNum(SRC, 'CONSULT_KB_MIN_SIM');
const CONSULT_KB_MIN_LEX = extractConstNum(SRC, 'CONSULT_KB_MIN_LEX');
const consultKbStrong = new Function(
  'CONSULT_KB_MIN_SIM', 'CONSULT_KB_MIN_LEX',
  extractFn(SRC, 'function consultKbStrong(') + '\nreturn consultKbStrong;'
)(CONSULT_KB_MIN_SIM, CONSULT_KB_MIN_LEX);
const consultKbFilter = new Function(
  'consultKbStrong', extractFn(SRC, 'function consultKbFilter(') + '\nreturn consultKbFilter;'
)(consultKbStrong);

// ---- 抠真身：kbTokenize（算真实 lex 命中数，与召回口径一字不差）----
const kbTokenize = new Function(extractFn(SRC, 'function kbTokenize(') + '\nreturn kbTokenize;')();
// 复刻 kbRetrieveScored 里 matchedTerms 的算法：命中的不同 query token（cap 12）
function matchedTermsOf(entryText, query) {
  const qtok = new Set(kbTokenize(query));
  return [...new Set(kbTokenize(entryText))].filter(t => qtok.has(t)).slice(0, 12);
}
// 复刻 _kbScored 语义可用时的 rank：sim + (lex>=lo?0.001*lex:0)（lo=2 consult）
function semScore(sim, lex) { return sim + (lex >= 2 ? 0.001 * lex : 0); }

test('常量取值合理：语义门槛 > 全局 SEM_GATE(0.42)、纯词门槛 > consult 召回门槛(2)', () => {
  assert.ok(CONSULT_KB_MIN_SIM > 0.42, 'CONSULT_KB_MIN_SIM 应严于全局 SEM_GATE 0.42（否则 0.42 边缘条目照进）');
  assert.ok(CONSULT_KB_MIN_LEX >= 3, 'CONSULT_KB_MIN_LEX 应≥3（严于 consult 召回 minScore=2）');
});

test('复现 bug：sim=0.42 卡边缘的无关经验（医嘱干预说明书跳转 vs 检验异常箭头）被过滤，不注入不引用', () => {
  // 用户实测：问「检验异常值箭头」，召回「药品说明书跳转」sim=0.42（正好卡 SEM_GATE），毫不相关。
  const kbScored = [
    { e: { q: '医嘱干预怎么配置药品说明书跳转' }, score: semScore(0.42, 1), matchedTerms: ['配置'] },
  ];
  assert.equal(consultKbFilter(kbScored).length, 0, '★ 0.42 边缘无关条目被 consultKbFilter 剔除（→ 本次无相关经验库）');
  assert.equal(consultKbStrong(kbScored[0]), false, 'consultKbStrong 判其为弱');
});

test('真正覆盖问题的强语义条目（sim≥0.5）保留注入', () => {
  const strong = { e: { q: '检验报告异常值箭头显示规则' }, score: semScore(0.6, 5), matchedTerms: ['异常', '箭头', '检验', '报告', '显示'] };
  assert.equal(consultKbStrong(strong), true, 'sim=0.6 覆盖问题 → 保留');
  assert.equal(consultKbFilter([strong]).length, 1);
});

test('语义边界：sim 恰好 0.5 保留、0.49 剔除（阈值精确）', () => {
  assert.equal(consultKbStrong({ score: semScore(0.5, 0), matchedTerms: [] }), true, 'sim=0.5 恰好保留');
  assert.equal(consultKbStrong({ score: semScore(0.49, 0), matchedTerms: [] }), false, 'sim=0.49 剔除');
});

test('纯词模式（语义不可用·score=lex 整数）：matchedTerms<3 剔除、≥3 保留', () => {
  // 语义不可用时 kbRetrieveScored 的 score = lex（整数，consult minScore=2 起）；matchedTerms 长度=lex。
  assert.equal(consultKbStrong({ score: 2, matchedTerms: ['药师', '任务'] }), false, '纯词 2 命中 → 弱、剔除（严于旧 minScore=2）');
  assert.equal(consultKbStrong({ score: 3, matchedTerms: ['药师', '任务', '审方'] }), true, '纯词 3 命中 → 保留');
});

/* ---- 与 fs-06 连真库冒烟同口径：复刻 REL0/REL2 种子数据（真实 kbTokenize），确认 REL1 弱匹配掉/REL2 两条强相关都留 ---- */
const REL_TOK = 'zx88931task';
const REL_STRONG_Q = 'FS06相关度：审方规则大于5级' + REL_TOK + '药师没拿到任务怎么办';
const REL_STRONG_A = '因为' + REL_TOK + '审方规则配置了大于5级药师才分派，需调整规则后重试。';
const REL_WEAK_Q = 'FS06相关度：药师排班表怎么导出到excel';
const REL_WEAK_A = '在报表页选药师排班，点导出按钮即可生成 excel。';
function relScored(query) {
  // 语义不可用（fs-06 测试环境无 embed）：score=lex，matchedTerms=命中的不同 query token。
  const strongTxt = [REL_STRONG_Q, REL_STRONG_A, 'audit', '任务分派'].join(' ');
  const weakTxt = [REL_WEAK_Q, REL_WEAK_A, 'report', '报表'].join(' ');
  const mkStrong = matchedTermsOf(strongTxt, query), mkWeak = matchedTermsOf(weakTxt, query);
  // 纯词模式 score=lex（不同 token 命中数，consult 门槛 2 起才入召回）
  const out = [];
  if (mkStrong.length >= 2) out.push({ e: { q: REL_STRONG_Q }, score: mkStrong.length, matchedTerms: mkStrong });
  if (mkWeak.length >= 2) out.push({ e: { q: REL_WEAK_Q }, score: mkWeak.length, matchedTerms: mkWeak });
  return out;
}

test('fs-06 REL1 口径：问强相关问题 → 只强相关那条过门槛（弱匹配单词命中掉，kbHits=1）', () => {
  const kbScored = relScored('审方规则大于5级药师没拿到任务' + REL_TOK);
  const kept = consultKbFilter(kbScored).map(x => x.e.q);
  assert.ok(kept.some(q => q.includes(REL_TOK)), '★ 强相关那条在');
  assert.ok(!kept.some(q => q.includes('排班表')), '★ 弱匹配那条不在');
  assert.equal(kept.length, 1, '★ kbHits=1（与连真库 B-KB-REL1 同）');
});

test('fs-06 REL2 口径：问对两条都多 token 命中的问题 → 两条都过门槛（不误伤真相关，kbHits=2）', () => {
  const kbScored = relScored('审方规则' + REL_TOK + '药师没拿到任务，另外药师排班表怎么导出到excel');
  const kept = consultKbFilter(kbScored).map(x => x.e.q);
  assert.ok(kept.some(q => q.includes(REL_TOK)), '★ 强相关那条在');
  assert.ok(kept.some(q => q.includes('排班表')), '★ 弱匹配那条这次也在（对它也多 token 命中）');
  assert.equal(kept.length, 2, '★ kbHits=2（与连真库 B-KB-REL2 同，门槛不误伤真相关）');
});

test('consult 端点接线：过滤后 hits 派生自 consultKbFilter；kbScored 全召回仍给 buildRetrieval 诊断', () => {
  // 端点里：保留 fs-06 断言的原行（kbScored 全召回 + hits），紧接着 hits 收敛为 consultKbFilter(kbScored).map(x=>x.e)。
  assert.match(SRC, /hits = consultKbFilter\(kbScored\)\.map\(x => x\.e\);/, '★ hits 由 consultKbFilter 收敛（注入/kbRefs 口径收紧）');
  // buildRetrieval 仍吃全召回 kbScored（诊断保留「召回了但太弱」信息）。
  // 注：spec 侧参数 PD-04 修复后由 specScored 更名为 searchScored（specSearch 底座，一处两用喂模型+诊断），本断言只锁 kbScored 全召回不收敛。
  assert.match(SRC, /buildRetrieval\(\{ query: qtext[^}]*\}, searchScored, kbScored, codeHits\)/, 'buildRetrieval 用全召回 kbScored（诊断不收敛）');
  // kbRefs 由收敛后的 hits 派生（弱相关不落引用）
  assert.match(SRC, /const kbRefs = consultKbRefs\(proj\.id, hits\);/, 'kbRefs 由收敛后 hits 派生');
});
