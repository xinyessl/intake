// 「深入思考」源码检索**取片窗口**（第三层）—— 纯逻辑 + 真 git 仓单测（不依赖 MySQL / 不 spawn server）
//   跑法：node --test tools/code-search-snippet.logic.test.mjs
//
// 背景（CHG-深入思考取片-稀有词优先选行）：排序（54e13f8 稀有词加权）已把答案文件排到 top，
//   但**喂给模型的片段可能不含答案行**——旧取片：命中行按 grep 顺序塞进 f.lines（Set，size<40 封顶）+
//   窗口按行号升序拼、slice(1500/1600) 从文件顶部截。大众词（如「医嘱」命中该文件大量行）先把行/字符预算占满，
//   判别性稀有词命中行（如靠后的 `content="查看药品说明书"` L301 / `onDrugPath` L1610）被挤出窗口。
//
// 修复：取片时命中行按「该行最高词权重（稀有词/英文标识→高）」降序选，判别性命中行连同 ±6 窗口强制进片段；
//   大众词命中行用剩余预算补；字符预算放宽到 2200 容纳相距较远的两处判别性窗口。片段仍按行号升序、相邻合并、不相邻插「…」。
//
// 本测在临时目录 git init 造「同一文件内频率倾斜」样本（复刻 prod intervention.vue 形态）：
//   - 顶部数十行含大众词「医嘱/列表」；中部一行含稀有 CJK「说明书」；尾部一行含英文标识稀有词 onDrugPath。
//   断言：修复后取片 text **同时包含**那两处稀有词行；旧逻辑（顶部封顶 40 + slice(1600)）不含尾部稀有词行（反证 bug）。
//
// ⚠️ codeSearch 未 export 且 import server.mjs 会启服务/连 MySQL → 此处 1:1 复刻取片算法；
//   与 tools/code-search-rank.logic.test.mjs 共用 buildTermList/grepRepo 同款（两处如改需同步，CHG 已记）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function gitOut(repoPath, args) {
  try { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoPath, encoding: 'utf8', timeout: 8000 }); return r.status === 0 ? (r.stdout || '') : ''; }
  catch { return ''; }
}

// ===== 词预算（同 server.mjs codeSearch 开头）=====
function buildTermList(query) {
  const terms = new Set();
  const zh = String(query).replace(/[^一-龥]/g, '');
  for (let i = 0; i + 2 <= zh.length; i++) terms.add(zh.slice(i, i + 2));
  for (let i = 0; i + 4 <= zh.length; i++) terms.add(zh.slice(i, i + 4));
  (String(query).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).forEach(w => terms.add(w));
  const isIdent = t => /[A-Za-z_]/.test(t);
  const spec = t => isIdent(t) ? 100 + t.length : t.length;
  const lenBonus = t => isIdent(t) ? 3 : (t.length >= 4 ? 2 : 1);
  const termList = [...terms].filter(t => t && t.length >= 2).sort((a, b) => spec(b) - spec(a)).slice(0, 24);
  return { termList, isIdent, lenBonus };
}

// ===== grep：新版记录 f.lineTerms = Map(行号→命中它的词集合)（同 server.mjs 收集阶段改造）=====
function grepRepo(dir, ref, termList) {
  const OK = /\.(vue|[cm]?[jt]sx?|java|kt|xml|sql|py|go|cs|php|rb|c|cc|cpp|h|hpp|scala|sh|yaml|yml)$/i;
  const SKIPDIR = /node_modules\/|\/dist\/|iconfont|\.min\.|\/mock\//i;
  const files = {}, df = {};
  for (const t of termList) {
    const out = gitOut(dir, ['grep', '-n', '-i', '-F', t, ...(ref ? [ref] : [])]);
    const seen = new Set();
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const rest = ref ? line.replace(new RegExp('^' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'), '') : line;
      const m = rest.match(/^(.+?):(\d+):/); if (!m || !OK.test(m[1]) || SKIPDIR.test(m[1])) continue;
      const key = m[1], f = files[key] || (files[key] = { path: m[1], terms: new Set(), lineTerms: new Map() });
      f.terms.add(t);
      const lnNo = +m[2]; let ls = f.lineTerms.get(lnNo); if (!ls) { if (f.lineTerms.size < 400) { ls = new Set(); f.lineTerms.set(lnNo, ls); } } if (ls) ls.add(t);
      seen.add(key);
    }
    if (seen.size) df[t] = (df[t] || 0) + seen.size;
  }
  return { files, df };
}

// ===== 取片（修复后：稀有词优先选命中行，同 server.mjs 取片阶段）=====
function snippetFixed(dir, ref, f, df, lenBonus) {
  const weight = t => lenBonus(t) / Math.log2(2 + (df[t] || 0));
  const lineWeight = ls => { let w = 0; for (const t of ls) { const tw = weight(t); if (tw > w) w = tw; } return w; };
  const full = String(gitOut(dir, ['show', (ref ? ref + ':' : ':') + f.path]) || '').split('\n');
  const cand = [...f.lineTerms.entries()].map(([ln, ls]) => ({ ln, w: lineWeight(ls) })).sort((a, b) => b.w - a.w || a.ln - b.ln);
  const keep = new Set();
  let lineBudget = 40, charEst = 0;
  for (const { ln } of cand) {
    if (lineBudget <= 0 || charEst > 2200) break;
    let added = 0;
    for (let i = Math.max(1, ln - 6); i <= Math.min(full.length, ln + 6); i++) { if (!keep.has(i)) { keep.add(i); added++; charEst += (full[i - 1] || '').length + 1; } }
    lineBudget -= (added || 1);
  }
  const nums = [...keep].sort((a, b) => a - b); let snip = '', last = 0;
  for (const i of nums) { if (snip.length > 2000) { snip += '\n…'; break; } if (last && i > last + 1) snip += '\n…'; snip += '\n' + (full[i - 1] || ''); last = i; }
  return snip.trim().slice(0, 2200);
}

// ===== 取片（旧 buggy：命中行按 grep 顺序封顶 40，按行号升序拼、slice(1600) 从顶部截）=====
//   复刻旧收集：f.lines = Set，f.lines.size<40 才 add（按词遍历、每词按行号；大众词先塞满顶部）
function grepRepoOld(dir, ref, termList) {
  const OK = /\.(vue|[cm]?[jt]sx?|java|kt|xml|sql|py|go|cs|php|rb|c|cc|cpp|h|hpp|scala|sh|yaml|yml)$/i;
  const SKIPDIR = /node_modules\/|\/dist\/|iconfont|\.min\.|\/mock\//i;
  const files = {}, df = {};
  for (const t of termList) {
    const out = gitOut(dir, ['grep', '-n', '-i', '-F', t, ...(ref ? [ref] : [])]);
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const rest = ref ? line.replace(new RegExp('^' + ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':'), '') : line;
      const m = rest.match(/^(.+?):(\d+):/); if (!m || !OK.test(m[1]) || SKIPDIR.test(m[1])) continue;
      const key = m[1], f = files[key] || (files[key] = { path: m[1], terms: new Set(), lines: new Set() });
      f.terms.add(t); if (f.lines.size < 40) f.lines.add(+m[2]);
    }
  }
  return { files, df };
}
function snippetOld(dir, ref, f) {
  const full = String(gitOut(dir, ['show', (ref ? ref + ':' : ':') + f.path]) || '').split('\n');
  const keep = new Set();
  for (const ln of f.lines) for (let i = Math.max(1, ln - 6); i <= Math.min(full.length, ln + 6); i++) keep.add(i);
  const nums = [...keep].sort((a, b) => a - b); let snip = '', last = 0;
  for (const i of nums) { if (snip.length > 1500) { snip += '\n…'; break; } if (last && i > last + 1) snip += '\n…'; snip += '\n' + (full[i - 1] || ''); last = i; }
  return snip.trim().slice(0, 1600);
}

// 造仓：单个文件 intervention.vue —— 复刻 prod 频率倾斜形态
//   顶部 ~60 行含大众词「医嘱」「列表」（该文件被这些词命中数十行，旧逻辑先塞满 40 预算/1600 字符）；
//   中部一行含稀有 CJK 判别性词「查看药品说明书」；尾部一行含英文标识稀有词 onDrugPath / $openUrl。
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesnip-'));
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  const w = (rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

  const lines = [];
  lines.push('<template>');
  // 顶部 60 行大众词「医嘱」「列表」——旧逻辑这里就把 40 行/1600 字符预算占满
  for (let i = 0; i < 60; i++) lines.push('    <el-table-column label="医嘱列表项' + i + '" prop="order' + i + '" />');
  // 中部判别性稀有词行（约第 63 行）：CJK「查看药品说明书」（全仓仅此一行含）
  lines.push('    <el-button content="查看药品说明书" @click="onDrugPath(row)">说明书</el-button>');
  // 中间再塞一堆大众词行，把两处判别性窗口拉开距离（模拟 L301 与 L1610 相隔上千行）
  for (let i = 0; i < 60; i++) lines.push('    <div class="医嘱列表行' + i + '">列表内容医嘱' + i + '</div>');
  lines.push('  </template>');
  lines.push('<script>');
  lines.push('export default {');
  lines.push('  methods: {');
  // 尾部判别性稀有词行：英文标识 onDrugPath / $openUrl / config.value（全仓仅此含）
  lines.push('    onDrugPath(row) { this.$openUrl(row.config.value); },');
  lines.push('  }');
  lines.push('}');
  lines.push('</script>');

  w('src/views/patient/intervention.vue', lines.join('\n') + '\n');
  g('add', '-A'); g('commit', '-q', '-m', 'seed');
  g('tag', 'v1.0');
  return dir;
}

const QUERY = '医嘱列表中的药品说明书在哪里配置 onDrugPath';

test('取片：修复后同一文件的两处判别性稀有词行（说明书 / onDrugPath）都进片段', () => {
  const dir = makeRepo();
  try {
    const { termList, lenBonus } = buildTermList(QUERY);
    const { files, df } = grepRepo(dir, 'v1.0', termList);
    const f = files['src/views/patient/intervention.vue'];
    assert.ok(f, '文件应被命中');
    // 频率倾斜确已构造：大众词「医嘱」命中很多行、稀有词「onDrugPath」df=1
    assert.ok((df['医嘱'] || 0) >= 1);
    assert.equal(df['onDrugPath'] || 0, 1, '英文标识 onDrugPath 全仓仅一文件（稀有）');

    const text = snippetFixed(dir, 'v1.0', f, df, lenBonus);
    assert.ok(text.includes('content="查看药品说明书"'), '修复后：判别性 CJK 行「查看药品说明书」应在片段里');
    assert.ok(/onDrugPath\(row\)/.test(text) && text.includes('$openUrl'), '修复后：判别性英文标识行 onDrugPath/$openUrl 应在片段里');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('反证：旧取片（顶部封顶 40 + slice(1600)）把尾部稀有词行 onDrugPath 挤出片段', () => {
  const dir = makeRepo();
  try {
    const { termList } = buildTermList(QUERY);
    const { files } = grepRepoOld(dir, 'v1.0', termList);
    const f = files['src/views/patient/intervention.vue'];
    const text = snippetOld(dir, 'v1.0', f);
    // 旧逻辑：大众词「医嘱/列表」命中的顶部/中部行先把 40 行预算占满，尾部 onDrugPath 落窗口外
    assert.ok(!/onDrugPath\(row\)/.test(text), '旧取片：尾部稀有词行 onDrugPath 被顶部大众词行挤出（bug 复现）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('取片：片段按行号升序、不相邻窗口间插「…」（可读性不变）', () => {
  const dir = makeRepo();
  try {
    const { termList, lenBonus } = buildTermList(QUERY);
    const { files, df } = grepRepo(dir, 'v1.0', termList);
    const f = files['src/views/patient/intervention.vue'];
    const text = snippetFixed(dir, 'v1.0', f, df, lenBonus);
    assert.ok(text.includes('…'), '相距较远的两处判别性窗口之间应有「…」间隔');
    const iBook = text.indexOf('查看药品说明书'), iDrug = text.indexOf('onDrugPath');
    assert.ok(iBook >= 0 && iDrug >= 0 && iBook < iDrug, '片段按文件行号升序：说明书行（中部）在 onDrugPath 行（尾部）之前');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
