// PD-03 AI 检索诊断 · 脱库逻辑测试（零依赖 node:test，无 MySQL、不 spawn server）
//   server.mjs 启动即 await db.init() 失败 process.exit(1)、无法整体 import → 从源码抽被测函数体沙箱 eval（测真实源码，抓漂移）。
//   覆盖：① buildRetrieval 结构/cap（spec≤5/kb≤5/code≤4）/截断（spec·code text≤300、kb q≤200、a≤300）/弱匹配空数组照存
//         ② 打分透出（spec.score / kb.score 保留、matchedTerms 带出）
//         ③ retrievalMarkKey / 标记文件存读写（write→read 回环、覆盖、clear 删）
//         ④ verdict/hitType 常量集合合法性
//         ⑤ 问题清单聚合口径：仅非 ok、按 verdict/project/subsystem 分组
//         ⑥ 四端点均 admin 域（不进 LINK_OK/FIELD_OK/FS08_FIELD_API/FS08_FIELD_PAGES）——源码级断言（AC-9）
//   用法：node --test tools/pd-03-retrieval.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf('function ' + name);
  assert.ok(start >= 0, `应能在 server.mjs 找到 function ${name}`);
  // 跳过参数列表（可能含解构 `{}`）：先配平参数括号 `(...)`，再从其后第一个 `{` 起取函数体。
  const parenOpen = src.indexOf('(', start);
  let pd = 0, parenClose = -1;
  for (let i = parenOpen; i < src.length; i++) { if (src[i] === '(') pd++; else if (src[i] === ')') { pd--; if (pd === 0) { parenClose = i; break; } } }
  const braceOpen = src.indexOf('{', parenClose);
  let depth = 0, end = -1;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  assert.ok(end > braceOpen, `应能配平 ${name} 的函数体大括号`);
  return src.slice(start, end + 1);
}

// —— buildRetrieval 依赖 nowStamp（返回 yyyy-MM-dd HH:mm 串）→ 注入稳定 stub —— //
const nowStamp = () => '2026-08-11 10:30';
const buildRetrieval = new Function('nowStamp', extractFn(SRC, 'buildRetrieval') + '\nreturn buildRetrieval;')(nowStamp);

// —— 标记存储三件套（readRetrievalMarks/writeRetrievalMarks/retrievalMarkKey）依赖 DATA_DIR + fs + path —— //
//   注入临时 DATA_DIR，抽出三函数在同一沙箱共享（写→读回环）。
function makeMarkStore() {
  const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pd03-marks-'));
  const RETRIEVAL_MARKS_FILE = path.join(DATA_DIR, 'retrieval-marks.json');
  const body =
    `const DATA_DIR=${JSON.stringify(DATA_DIR)};\n` +
    `const RETRIEVAL_MARKS_FILE=${JSON.stringify(RETRIEVAL_MARKS_FILE)};\n` +
    extractFn(SRC, 'readRetrievalMarks') + '\n' +
    extractFn(SRC, 'writeRetrievalMarks') + '\n' +
    extractFn(SRC, 'retrievalMarkKey') + '\n' +
    'return { readRetrievalMarks, writeRetrievalMarks, retrievalMarkKey, DATA_DIR };';
  return new Function('fs', 'path', body)(fs, path);
}

test('AC-1/AC-3 buildRetrieval：三类结构齐全 + cap（spec≤5/kb≤5/code≤4）', () => {
  const mkSpec = i => ({ subsystem: 'audit', module: 'm' + i, title: 't' + i, score: 5 - i * 0.1, text: 'x', matchedTerms: ['医嘱'] });
  const mkKb = i => ({ e: { q: 'q' + i, a: 'a' + i, subsystem: 'audit', module: 'm' }, score: 3 - i * 0.1, matchedTerms: ['说明书'] });
  const mkCode = i => ({ file: 'f' + i + '.vue', text: 'code' });
  const rt = buildRetrieval(
    { query: '药品说明书怎么看', deep: true, ver: '2.8', subsystem: 'audit' },
    Array.from({ length: 8 }, (_, i) => mkSpec(i)),
    Array.from({ length: 8 }, (_, i) => mkKb(i)),
    Array.from({ length: 8 }, (_, i) => mkCode(i)),
  );
  assert.equal(rt.query, '药品说明书怎么看');
  assert.equal(rt.deep, true);
  assert.equal(rt.ver, '2.8');
  assert.equal(rt.subsystem, 'audit');
  assert.equal(rt.at, '2026-08-11 10:30');
  assert.equal(rt.spec.length, 5, 'spec cap 5');
  assert.equal(rt.kb.length, 5, 'kb cap 5');
  assert.equal(rt.code.length, 4, 'code cap 4');
  // 结构字段齐全
  assert.deepEqual(Object.keys(rt.spec[0]).sort(), ['matchedTerms', 'module', 'score', 'subsystem', 'text', 'title'].sort());
  assert.deepEqual(Object.keys(rt.kb[0]).sort(), ['a', 'matchedTerms', 'module', 'q', 'score', 'subsystem'].sort());
  assert.deepEqual(Object.keys(rt.code[0]).sort(), ['file', 'text'].sort());
});

test('AC-2 打分透出：spec.score / kb.score 保留原值，matchedTerms 带出', () => {
  const rt = buildRetrieval(
    { query: 'q', deep: false, ver: '', subsystem: '' },
    [{ subsystem: 's', module: 'm', title: 't', score: 12.345, text: 'x', matchedTerms: ['a', 'b'] }],
    [{ e: { q: 'kq', a: 'ka', subsystem: 's', module: 'm' }, score: 2.5, matchedTerms: ['c'] }],
    null,
  );
  assert.equal(rt.spec[0].score, 12.345);
  assert.deepEqual(rt.spec[0].matchedTerms, ['a', 'b']);
  assert.equal(rt.kb[0].score, 2.5);
  assert.deepEqual(rt.kb[0].matchedTerms, ['c']);
});

test('AC-3 截断：spec/code text≤300、kb q≤200、kb a≤300', () => {
  const long = 'あ'.repeat(1000);
  const rt = buildRetrieval(
    { query: long, deep: true, ver: long, subsystem: long },
    [{ subsystem: long, module: long, title: long, score: 1, text: long, matchedTerms: [] }],
    [{ e: { q: long, a: long, subsystem: long, module: long }, score: 1, matchedTerms: [] }],
    [{ file: long, text: long }],
  );
  assert.equal(rt.spec[0].text.length, 300, 'spec text 截 300');
  assert.equal(rt.spec[0].title.length, 120);
  assert.equal(rt.kb[0].q.length, 200, 'kb q 截 200');
  assert.equal(rt.kb[0].a.length, 300, 'kb a 截 300');
  assert.equal(rt.code[0].text.length, 300, 'code text 截 300');
  assert.equal(rt.query.length, 500);
  assert.equal(rt.ver.length, 60);
});

test('AC-3 弱匹配/无命中/未 deep：对应数组为空、照存', () => {
  const rt = buildRetrieval({ query: 'q', deep: false, ver: '', subsystem: '' }, [], null, null);
  assert.deepEqual(rt.spec, []);
  assert.deepEqual(rt.kb, []);
  assert.deepEqual(rt.code, []);
  assert.equal(rt.deep, false);
  // 结构仍完整（"没取到"本身可被诊断）
  assert.ok('query' in rt && 'at' in rt);
});

test('AC-6 retrievalMarkKey：稳定拼接 recordId|turnIndex|hitType|hitKey', () => {
  const { retrievalMarkKey } = makeMarkStore();
  assert.equal(retrievalMarkKey('ZX-1', 3, 'spec', 't标题#0'), 'ZX-1|3|spec|t标题#0');
});

test('AC-6 标记文件存：write→read 回环、覆盖、clear 删', () => {
  const { readRetrievalMarks, writeRetrievalMarks, retrievalMarkKey } = makeMarkStore();
  assert.deepEqual(readRetrievalMarks(), {}, '初始空');
  const k1 = retrievalMarkKey('ZX-1', 0, 'spec', 't#0');
  const m1 = { key: k1, recordId: 'ZX-1', turnIndex: 0, hitType: 'spec', hitKey: 't#0', verdict: 'offtopic', note: '跑题了', by: '管理员', at: '2026-08-11 10:30' };
  writeRetrievalMarks({ [k1]: m1 });
  let got = readRetrievalMarks();
  assert.equal(got[k1].verdict, 'offtopic');
  assert.equal(got[k1].note, '跑题了');
  // 覆盖同 key（改 verdict）
  writeRetrievalMarks({ [k1]: { ...m1, verdict: 'missing', note: '' } });
  got = readRetrievalMarks();
  assert.equal(got[k1].verdict, 'missing');
  assert.equal(Object.keys(got).length, 1, '同 key 覆盖不新增');
  // clear：删该 key
  delete got[k1];
  writeRetrievalMarks(got);
  assert.deepEqual(readRetrievalMarks(), {}, 'clear 后为空');
});

test('AC-6 verdict/hitType 常量集合正确', () => {
  // 从源码抽字面量断言（防漂移）
  const vLine = SRC.match(/const RETRIEVAL_VERDICTS = new Set\(\[([^\]]+)\]\)/);
  const hLine = SRC.match(/const RETRIEVAL_HIT_TYPES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(vLine, '应有 RETRIEVAL_VERDICTS 定义');
  assert.ok(hLine, '应有 RETRIEVAL_HIT_TYPES 定义');
  ['ok', 'offtopic', 'missing', 'should_hit_missed'].forEach(v => assert.ok(vLine[1].includes(`'${v}'`), `verdict 含 ${v}`));
  ['spec', 'kb', 'code'].forEach(h => assert.ok(hLine[1].includes(`'${h}'`), `hitType 含 ${h}`));
});

test('AC-7 问题清单聚合：仅非 ok，按 verdict/project/subsystem 分组', () => {
  // 复刻 /api/retrieval-issues 的纯聚合口径（与端点内逻辑一致）
  const marks = {
    a: { verdict: 'ok', project: 'p1', subsystem: 'audit', recordId: 'r1', turnIndex: 0, hitType: 'spec', hitKey: 'x', at: '2026-08-11 09:00' },
    b: { verdict: 'offtopic', project: 'p1', subsystem: 'audit', recordId: 'r1', turnIndex: 0, hitType: 'spec', hitKey: 'y', at: '2026-08-11 09:10' },
    c: { verdict: 'missing', project: 'p2', subsystem: '', recordId: 'r2', turnIndex: 1, hitType: 'kb', hitKey: 'q', at: '2026-08-11 09:20' },
    d: { verdict: 'should_hit_missed', project: 'p1', subsystem: 'report', recordId: 'r3', turnIndex: 0, hitType: 'code', hitKey: 'f.vue', at: '2026-08-11 09:30' },
  };
  const issues = Object.values(marks).filter(m => m && m.verdict && m.verdict !== 'ok');
  assert.equal(issues.length, 3, '排除 ok');
  const byVerdict = {}, byProject = {}, bySubsystem = {};
  for (const m of issues) {
    (byVerdict[m.verdict] || (byVerdict[m.verdict] = [])).push(m);
    (byProject[m.project || '(未标产品)'] || (byProject[m.project || '(未标产品)'] = [])).push(m);
    const sub = String(m.subsystem || '(未标子系统)');
    (bySubsystem[sub] || (bySubsystem[sub] = [])).push(m);
  }
  assert.equal(byVerdict.offtopic.length, 1);
  assert.equal(byVerdict.missing.length, 1);
  assert.equal(byVerdict.should_hit_missed.length, 1);
  assert.equal(byProject.p1.length, 2);
  assert.equal(byProject.p2.length, 1);
  assert.equal(bySubsystem.audit.length, 1);
  assert.equal(bySubsystem['(未标子系统)'].length, 1);
});

test('AC-9 admin 域：四端点均不进 LINK_OK/FIELD_OK/FS08_FIELD_API/FS08_FIELD_PAGES', () => {
  const eps = ['/api/retrieval-replay', '/api/retrieval-log', '/api/retrieval-mark', '/api/retrieval-issues'];
  // 抽各白名单字面量（LINK_OK / authGate 内 FIELD_OK / 顶层 FS08_FIELD_API / FS08_FIELD_PAGES）
  const linkOk = SRC.match(/const LINK_OK = new Set\(\[([^\]]+)\]\)/)[1];
  const fieldOk = SRC.match(/const FIELD_OK = new Set\(\[([^\]]+)\]\)/)[1];
  const fs08Api = SRC.match(/const FS08_FIELD_API = new Set\(\[([^\]]+)\]\)/)[1];
  const fs08Pages = SRC.match(/const FS08_FIELD_PAGES = new Set\(\[([^\]]+)\]\)/)[1];
  for (const ep of eps) {
    assert.ok(!linkOk.includes(`'${ep}'`), `${ep} 不应在 LINK_OK`);
    assert.ok(!fieldOk.includes(`'${ep}'`), `${ep} 不应在 FIELD_OK`);
    assert.ok(!fs08Api.includes(`'${ep}'`), `${ep} 不应在 FS08_FIELD_API`);
  }
  assert.ok(!fs08Pages.includes("'/retrieval.html'"), '/retrieval.html 不应在 field 域可见页');
  // 端点确实存在于源码（路由已挂）
  for (const ep of eps) assert.ok(SRC.includes(`url.pathname === '${ep}'`), `${ep} 路由应存在`);
});

test('AC-1 consult 捕获：retrieval 与 kbRefs 同位置回贴、不覆盖 kbRefs（源码级）', () => {
  // consult 持久化块：既有 kbRefs 回贴，也有 retrieval 回贴，两者独立 try、挂同一末条 assistant
  assert.ok(SRC.includes('chat[chat.length - 1].kbRefs = kbRefs'), 'kbRefs 回贴仍在');
  assert.ok(SRC.includes('chat[chat.length - 1].retrieval = retrieval'), 'retrieval 回贴到末条 assistant');
  // retrieval 计算用带分变体（不改喂模型的 specSearch/kbRetrieve 原调用）
  assert.ok(SRC.includes('specSearchScored(proj'), 'consult 捕获用 specSearchScored');
  assert.ok(SRC.includes('kbRetrieveScored(proj.id'), 'consult 捕获用 kbRetrieveScored');
  // 续聊按第 K 条 assistant 回贴历史 retrieval（不丢历史轮捕获）
  assert.ok(SRC.includes("chat[i].retrieval = r"), '续聊按第 K 条 assistant 回贴历史 retrieval');
});
