// 「深入思考」源码检索排序 —— 纯逻辑 + 真 git 仓单测（不依赖 MySQL / 不 spawn server）
//   跑法：node --test tools/code-search-rank.logic.test.mjs
//
// 背景（CHG）：codeSearch 旧实现两个叠加 bug 让判别性最强的稀有词源码文件排不进 top-n：
//   ① 词预算 slice(0,18) 前不排序 → 大众 bigram 先占满名额，判别性 4-gram/英文标识被截掉；
//   ② 文件排序按「命中的不同词种类数」(terms.size) → 蹭一堆大众词的泛词大页压过只含稀有词的真答案文件。
//   修复：词按特异性降序再截断(24)；文件排序改稀有词 IDF 式加权（df 小权重高 + 长词/英文标识加成）。
//
// 本测在临时目录 git init 造「频率倾斜」样本：
//   - target.vue：含稀有词「说明书」(df=1) + 少量大众词；judgeword.vue：含英文标识稀有词；
//   - noise00..09.vue：塞满大众词（医嘱/列表/配置/药品）但不含稀有词。
//   断言：修复后加权排序把 target/judgeword 顶到 top；旧「terms.size」排序会被噪音页淹没（证明 bug 真实存在、修复有效）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function gitOut(repoPath, args) {   // 同 server.mjs gitOut
  try { const r = spawnSync('git', ['-c', 'core.quotepath=false', ...args], { cwd: repoPath, encoding: 'utf8', timeout: 8000 }); return r.status === 0 ? (r.stdout || '') : ''; }
  catch { return ''; }
}

// ===== 从 server.mjs codeSearch 抽出的「词预算 + grep + 打分排序」核心逻辑（1:1 复刻，供单测断言排序正确）=====
//   注：codeSearch 未 export 且 import server.mjs 会启服务/连 MySQL，故此处复刻同一算法；两处如改需同步（CHG 已记）。
function buildTermList(query) {
  const terms = new Set();
  const zh = String(query).replace(/[^一-龥]/g, '');
  for (let i = 0; i + 2 <= zh.length; i++) terms.add(zh.slice(i, i + 2));
  for (let i = 0; i + 4 <= zh.length; i++) terms.add(zh.slice(i, i + 4));
  (String(query).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).forEach(w => terms.add(w));
  const isIdent = t => /[A-Za-z_]/.test(t);
  const spec = t => isIdent(t) ? 100 + t.length : t.length;
  const termList = [...terms].filter(t => t && t.length >= 2).sort((a, b) => spec(b) - spec(a)).slice(0, 24);
  return { termList, isIdent };
}

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
      const key = m[1], f = files[key] || (files[key] = { path: m[1], terms: new Set(), lines: new Set() });
      f.terms.add(t); if (f.lines.size < 40) f.lines.add(+m[2]);
      seen.add(key);
    }
    if (seen.size) df[t] = (df[t] || 0) + seen.size;
  }
  return { files, df };
}

// 修复后排序：IDF 式加权（df 小权重高 + 长词/英文标识加成）
function rankFixed(files, df, isIdent, n = 4) {
  const lenBonus = t => isIdent(t) ? 3 : (t.length >= 4 ? 2 : 1);
  const weight = t => lenBonus(t) / Math.log2(2 + (df[t] || 0));
  const scoreOf = f => { let s = 0; for (const t of f.terms) s += weight(t); return s; };
  return Object.values(files).sort((a, b) => scoreOf(b) - scoreOf(a) || b.lines.size - a.lines.size).slice(0, n).map(f => f.path);
}
// 旧排序（buggy）：按命中的不同词种类数
function rankOld(files, n = 4) {
  return Object.values(files).sort((a, b) => b.terms.size - a.terms.size || b.lines.size - a.lines.size).slice(0, n).map(f => f.path);
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codesearch-'));
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  const w = (rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

  // 真答案文件：只含判别性稀有词「药品说明书」相关片段（少量、不蹭泛词大页那种大众词堆）——判别信号强但词种类少
  //   命中稀有 term：4-gram「药品说明」「品说明书」、bigram「说明」「明书」等（全仓仅答案文件含），df 极小
  w('src/target.vue',
    '<template>\n' +
    '  <el-drawer title="药品说明书" v-model="showBook">\n' +
    '    <upload text="上传药品说明书" />\n' +
    '  </el-drawer>\n' +
    '</template>\n');
  // 第二答案文件：判别性英文标识稀有词（驼峰方法名，全仓仅此含）+ 稀有 CJK「说明书」上下文（真实答案页往往同时含标签与处理器）
  w('src/judgeword.vue',
    '<script>\n' +
    '// 打开药品说明书配置弹窗\n' +
    'export default { methods: { openDrugInstructionConfig() { this.showBook = true; } } }\n' +
    '</script>\n');
  // 「泛词大页」× 2：整句「医嘱列表 + 中的药品」→ 命中 8 个【不同】大众 term（含 bigram 医嘱/嘱列/列表/中的/的药/药品
  //   + 4-gram 医嘱列表/中的药品）→ terms.size(=8) 远高于真答案 target(=4)，但全是高频大众词（无一稀有）。
  //   旧排序据 terms.size 把它们顶上来、压过真答案 target.vue —— 复现 prod「蹭一堆大众词的泛词大页压过稀有词页」bug。
  for (let b = 0; b < 2; b++) {
    w('src/bigpage' + b + '.vue',
      '<template>\n' +
      '  <div>医嘱列表面板' + b + '</div>\n' +
      '  <div>中的药品面板' + b + '</div>\n' +
      '</template>\n');
  }
  // 12 个小噪音文件：各含同样的「医嘱列表」「中的药品」大众整句 → 把这些大众 term 的 df 顶到很高（IDF 明显压低其权重）；
  //   全无稀有词。它们 terms.size 与泛词大页相当，但因 df 大、加权后得分低。
  for (let i = 0; i < 12; i++) {
    w('src/noise' + String(i).padStart(2, '0') + '.vue',
      '<template>\n  <div>医嘱列表项' + i + '</div>\n  <div>中的药品项' + i + '</div>\n</template>\n');
  }
  g('add', '-A'); g('commit', '-q', '-m', 'seed');
  g('tag', 'v1.0');
  return dir;
}

test('词预算按特异性排序：判别性 4-gram + 英文标识一定进预算，不被大众 bigram 挤掉', () => {
  const query = '医嘱列表中的药品说明书在哪里配置 openDrugInstructionConfig';
  const { termList } = buildTermList(query);
  assert.ok(termList.length <= 24, '预算上限 24');
  // 英文标识排最前
  assert.equal(termList[0], 'openDrugInstructionConfig', '英文标识特异性最高，排预算首位');
  // 判别性 4-gram 必须在预算内
  for (const t of ['药品说明', '品说明书', '说明书在']) assert.ok(termList.includes(t), `判别性 4-gram「${t}」应进预算`);
});

test('文件排序：稀有词 IDF 加权把「说明书」真答案文件顶到 top（修复后）；旧 terms.size 排序被泛词大页淹没（bug 复现）', () => {
  const dir = makeRepo();
  try {
    const query = '医嘱列表中的药品说明书在哪里配置 openDrugInstructionConfig';
    const { termList, isIdent } = buildTermList(query);
    const { files, df } = grepRepo(dir, 'v1.0', termList);

    // 频率倾斜确已构造：判别性稀有词（4-gram「药品说明」「品说明书」/bigram「说明」「明书」）df 极小(=2，仅两答案文件)，大众词 df 大
    assert.equal(df['品说明书'] || 0, 2, '判别性 4-gram「品说明书」仅两答案文件命中（稀有）');
    assert.equal(df['药品说明'] || 0, 2, '判别性 4-gram「药品说明」仅两答案文件命中（稀有）');
    assert.ok((df['列表'] || 0) >= 10, '大众词「列表」应命中众多文件（高 df）');
    // 泛词大页 terms.size 高于真答案（旧排序据此把大页顶上来）
    assert.ok(files['src/bigpage0.vue'].terms.size > files['src/target.vue'].terms.size, '泛词大页 terms.size > 真答案（旧排序的坑）');

    // ===== 修复后：IDF 加权 → 两个含稀有词的真答案文件浮到 top-2，排在所有泛词大页/噪音之前 =====
    const fixed = rankFixed(files, df, isIdent, 4);
    const top2 = new Set(fixed.slice(0, 2));
    assert.ok(top2.has('src/target.vue'), '修复后：含稀有词「药品说明书」的 target.vue 应进 top-2');
    assert.ok(top2.has('src/judgeword.vue'), '修复后：含英文标识+稀有 CJK 的 judgeword.vue 应进 top-2');
    const firstNoisy = fixed.findIndex(p => /bigpage|noise/.test(p));
    const targetIdx = fixed.indexOf('src/target.vue');
    assert.ok(targetIdx >= 0 && (firstNoisy === -1 || targetIdx < firstNoisy), '修复后：target.vue 应排在所有泛词大页/噪音之前');

    // ===== 反证：旧排序（terms.size）下泛词大页/噪音填满 top，两个真答案文件被挤出 —— 证明 bug 真实、修复有效 =====
    const old = rankOld(files, 6);
    assert.ok(/bigpage|noise/.test(old[0]), '旧排序：泛词大页/噪音排 top-1（被大众词种类数带偏）');
    assert.ok(!old.includes('src/target.vue'), '旧排序：真答案 target.vue 被挤出 top-6（bug 复现）');
    assert.ok(!old.includes('src/judgeword.vue'), '旧排序：真答案 judgeword.vue 被挤出 top-6（bug 复现）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('回退用 ref=空（工作树/HEAD）也能 grep（跨仓回退时非当前仓 tag 可能不存在）', () => {
  const dir = makeRepo();
  try {
    const { termList, isIdent } = buildTermList('说明书 openDrugInstructionConfig');
    const { files, df } = grepRepo(dir, '', termList);   // 无 ref
    const fixed = rankFixed(files, df, isIdent, 4);
    assert.ok(fixed.includes('src/target.vue'), '无 ref（工作树）grep 同样命中 target.vue');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
