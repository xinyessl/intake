// 「深入思考」源码检索**第四层**：词预算被 spec 注入词中毒 —— 纯逻辑 + 真 git 仓单测（不依赖 MySQL / 不 spawn server）
//   跑法：node --test tools/code-search-specterm.logic.test.mjs
//
// 背景（CHG-深入思考源码检索-词预算 query 词保底+spec 注入词限量降权）：
//   codeSearch(...,specHits,...) 会把 specSearch 召回段里的表名/接口路径当 term 注入，与 query 自己的词混塞同一
//   `terms` Set，再统一按特异性排序取 24。当 specSearch 召回**跑题**的 spec（本例召回"重点监控/患教/收费"而非"说明书"），
//   注入的英文表名（如 pwrs_monitoring_drug_screen / drug_code，全 isIdent → 特异性 100+）排到词预算最前，
//   把 query 自身判别性中文词（说明书/药品说明/医嘱/列表）挤出 24 词预算 → 答案文件命中词骤降、加权得分崩塌，
//   被匹配注入表名的 mapper XML 挤出 top-4，取片层根本轮不到执行（第四层，端到端卡住的真正原因）。
//
// 修复（分源建词 + 预算保底 + spec 词降权）：
//   ① 分源：qTerms（query 派生·主信号·满权重）/ sTerms（spec 注入·次要·仅作"中文问题→英文表名"的桥），sTerms 去掉与 qTerms 重复的；
//   ② 预算保底：termList = [...qTerms.slice(0,20), ...sTerms.slice(0,4)]（总 ~24；query 词拿大头，判别性 query 词必进预算）；
//   ③ 降权：spec 注入词打分乘 0.5（specSourced.has(t)?0.5:1），即便某 spec 表名很稀有也不盖过同样稀有的 query 词。
//
// 本测在临时目录 git init 造「中毒场景」样本：
//   - 一个文件含判别性 query 词（说明书 / onDrugPath）—— 真答案文件；
//   - 几个文件含**跑题**的稀有英文表名 term（模拟 off-topic specHits 注入的表名）—— off-topic mapper。
//   断言：修复后 query 词未被挤出预算、含"说明书"的真答案文件排 top（修复前旧混塞逻辑被跑题表名文件盖过——反证旧 bug）。
//
// ⚠️ codeSearch 未 export 且 import server.mjs 会启服务/连 MySQL → 此处 1:1 复刻词预算/打分算法；
//   与 tools/code-search-rank.logic.test.mjs / code-search-snippet.logic.test.mjs 同款，三处如改需同步（CHG 已记）。
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

const isIdent = t => /[A-Za-z_]/.test(t);
const spec = t => isIdent(t) ? 100 + t.length : t.length;
const lenBonus = t => isIdent(t) ? 3 : (t.length >= 4 ? 2 : 1);
const bySpec = (a, b) => spec(b) - spec(a);

// ===== 修复后：分源建词（同 server.mjs codeSearch 头部）=====
function buildTermsFixed(query, specHits) {
  const qSet = new Set();
  const zh = String(query).replace(/[^一-龥]/g, '');
  for (let i = 0; i + 2 <= zh.length; i++) qSet.add(zh.slice(i, i + 2));
  for (let i = 0; i + 4 <= zh.length; i++) qSet.add(zh.slice(i, i + 4));
  (String(query).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).forEach(w => qSet.add(w));
  const sSet = new Set();
  const specText = (specHits || []).map(h => h.text || '').join('\n');
  (specText.match(/\b[a-z][a-z0-9]*_[a-z0-9_]{2,}\b/g) || []).forEach(w => sSet.add(w));
  (specText.match(/\/(api|comm)\/[A-Za-z0-9_]+/g) || []).forEach(w => sSet.add(w));
  for (const t of qSet) sSet.delete(t);
  const qTerms = [...qSet].filter(t => t && t.length >= 2).sort(bySpec).slice(0, 20);
  const sTerms = [...sSet].filter(t => t && t.length >= 2).sort(bySpec).slice(0, 4);
  const specSourced = new Set(sTerms);
  return { termList: [...qTerms, ...sTerms], specSourced, qTerms, sTerms };
}

// ===== 修复前（buggy）：query 词与 spec 注入词混塞同一 Set，统一按特异性排序取 24（英文表名 100+ 先占满）=====
function buildTermsOld(query, specHits) {
  const terms = new Set();
  const zh = String(query).replace(/[^一-龥]/g, '');
  for (let i = 0; i + 2 <= zh.length; i++) terms.add(zh.slice(i, i + 2));
  for (let i = 0; i + 4 <= zh.length; i++) terms.add(zh.slice(i, i + 4));
  (String(query).match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []).forEach(w => terms.add(w));
  const specText = (specHits || []).map(h => h.text || '').join('\n');
  (specText.match(/\b[a-z][a-z0-9]*_[a-z0-9_]{2,}\b/g) || []).forEach(w => terms.add(w));
  (specText.match(/\/(api|comm)\/[A-Za-z0-9_]+/g) || []).forEach(w => terms.add(w));
  const termList = [...terms].filter(t => t && t.length >= 2).sort((a, b) => spec(b) - spec(a)).slice(0, 24);
  return { termList, specSourced: new Set() };   // 旧逻辑无降权
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
      const key = m[1], f = files[key] || (files[key] = { path: m[1], terms: new Set() });
      f.terms.add(t);
      seen.add(key);
    }
    if (seen.size) df[t] = (df[t] || 0) + seen.size;
  }
  return { files, df };
}

// 排序：IDF 加权 + spec 注入词降权（同 server.mjs weight/scoreOf）
function rank(files, df, specSourced, n = 4) {
  const weight = t => (specSourced.has(t) ? 0.5 : 1) * lenBonus(t) / Math.log2(2 + (df[t] || 0));
  const scoreOf = f => { let s = 0; for (const t of f.terms) s += weight(t); return s; };
  return Object.values(files).sort((a, b) => scoreOf(b) - scoreOf(a)).slice(0, n).map(f => f.path);
}

// 造仓：复刻 prod 中毒场景
//   - intervention.vue：真答案文件，含判别性 query 词「查看药品说明书」(CJK) + 英文标识 onDrugPath / $openUrl / config.value；
//   - mapperN.xml × 3：off-topic mapper，各含一个跑题稀有英文表名（模拟 specSearch 召回"重点监控/患教/收费"注入的表名），
//     且各蹭少量大众 query 词（医嘱/列表），模拟"匹配注入表名 + 蹭大众词" → 旧逻辑得分盖过真答案文件。
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codespec-'));
  const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' });
  g('init', '-q');
  g('config', 'user.email', 't@t.t'); g('config', 'user.name', 't');
  g('config', 'commit.gpgsign', 'false');
  const w = (rel, txt) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, txt); };

  // 真答案文件：判别性 query 词（CJK「药品说明书」+ 英文标识 onDrugPath / $openUrl / config）
  w('pwrs-admin/src/views/patient/intervention.vue',
    '<template>\n' +
    '  <el-table-column label="医嘱列表" prop="orderList" />\n' +
    '  <el-button content="查看药品说明书" @click="onDrugPath(row)">药品说明书</el-button>\n' +
    '</template>\n' +
    '<script>\n' +
    'export default { methods: {\n' +
    '  // 医嘱列表中的药品说明书配置：跳转到 config 配置的说明书地址\n' +
    '  onDrugPath(row) { this.$openUrl(row.config.value); }\n' +
    '} }\n' +
    '</script>\n');

  // off-topic mapper × 3：各含一个跑题稀有英文表名（specSearch 召回跑题 spec 注入的），并蹭大众 query 词「医嘱/列表」。
  //   旧逻辑：这些跑题表名（特异性 100+）挤进 24 预算最前 + 无降权 → mapper 得分（跑题表名高 IDF）盖过真答案文件。
  const offTables = ['pwrs_monitoring_drug_screen', 'patient_education_record', 'charge_fee_settle_item'];
  offTables.forEach((tbl, i) => {
    w('pwrs-admin/src/mapper/OffTopic' + i + 'Mapper.xml',
      '<mapper>\n' +
      '  <select id="list" resultType="map">\n' +
      '    SELECT * FROM ' + tbl + ' WHERE 医嘱 = #{orderId} AND 列表 = #{list}\n' +
      '  </select>\n' +
      '</mapper>\n');
  });

  g('add', '-A'); g('commit', '-q', '-m', 'seed');
  g('tag', 'v1.0');
  return dir;
}

// query：判别性中文词（说明书）+ query 里的英文标识（onDrugPath）
const QUERY = '医嘱列表中的药品说明书在哪里配置 onDrugPath';
// 模拟 specSearch 召回**跑题**的 spec 段（重点监控/患教/收费——不是"说明书"）。
//   真实跑题 spec 段信息密集（多表 + 多字段 + 多接口路径），注入的稀有英文标识全 isIdent（特异性 100+）
//   在旧混塞逻辑里排到词预算最前，把 query 自身判别性词（说明书/药品说明/onDrugPath）**全数**挤出 24 预算。
const OFFTOPIC_SPECHITS = [
  { title: '重点监控药品', text: '重点监控药品筛查：表 pwrs_monitoring_drug_screen / pwrs_monitor_result / pwrs_screen_config，字段 drug_code / screen_result / monitor_level / result_status，接口 /api/monitoring_query /api/monitor_result /api/screen_config' },
  { title: '患者教育', text: '患者教育：表 patient_education_record / patient_edu_plan，字段 edu_type / plan_status，接口 /api/education_list /api/edu_plan' },
  { title: '收费结算', text: '收费结算：表 charge_fee_settle_item / charge_settle_order，字段 fee_amount / settle_status，接口 /api/charge_settle /api/settle_order' }
];

test('分源建词：判别性 query 词（说明书/药品说明/onDrugPath）必进预算，不被跑题 spec 表名挤掉', () => {
  const { termList, specSourced, qTerms, sTerms } = buildTermsFixed(QUERY, OFFTOPIC_SPECHITS);
  assert.ok(termList.length <= 24, '预算上限 ~24');
  // query 自己的英文标识
  assert.ok(termList.includes('onDrugPath'), 'query 英文标识 onDrugPath 在预算内');
  // 判别性 query 中文词（4-gram，判别性最强）必进预算（这是修复前被跑题表名全数挤出的那批）
  for (const t of ['药品说明', '品说明书', '说明书在']) assert.ok(termList.includes(t), `判别性 query 4-gram「${t}」应在预算内`);
  // spec 注入词限量 ≤4、且被标记为 specSourced（供降权）
  assert.ok(sTerms.length <= 4, 'spec 注入词限量 ≤4');
  for (const t of sTerms) assert.ok(specSourced.has(t), `spec 注入词「${t}」应被标记 specSourced（降权用）`);
  // query 词绝不被标记为 specSourced（享满权重）
  for (const t of qTerms) assert.ok(!specSourced.has(t), `query 词「${t}」不该被标记 specSourced`);
  // on-topic 的桥仍能进（≤4 个 spec 表名进了预算，只是降权），别整个删掉
  assert.ok(termList.some(t => specSourced.has(t)), 'spec 注入词仍进预算（≤4、降权），继续发挥桥的作用');
});

test('文件排序：中毒场景下真答案 intervention.vue 修复后重回 top（旧混塞逻辑被跑题 mapper 盖过——反证 bug）', () => {
  const dir = makeRepo();
  try {
    // ===== 修复后：query 词保底进预算 + spec 词降权 → 真答案文件排 top，off-topic mapper 压不过 =====
    const fx = buildTermsFixed(QUERY, OFFTOPIC_SPECHITS);
    const { files: ff, df: fdf } = grepRepo(dir, 'v1.0', fx.termList);
    const fixedTop = rank(ff, fdf, fx.specSourced, 4);
    const answer = 'pwrs-admin/src/views/patient/intervention.vue';
    assert.equal(fixedTop[0], answer, '修复后：真答案 intervention.vue 排 top-1');
    const firstMapper = fixedTop.findIndex(p => /Mapper\.xml$/.test(p));
    assert.ok(firstMapper === -1 || fixedTop.indexOf(answer) < firstMapper, '修复后：intervention.vue 排在所有 off-topic mapper 之前');

    // ===== 反证：旧混塞逻辑（跑题表名占满预算最前 + 无降权）→ 真答案被 off-topic mapper 挤出 top =====
    const od = buildTermsOld(QUERY, OFFTOPIC_SPECHITS);
    // 旧词预算里跑题英文表名（特异性 100+）排最前，把判别性 query 中文词挤出
    assert.ok(od.termList.includes('pwrs_monitoring_drug_screen'), '旧逻辑：跑题表名进预算（特异性 100+ 排最前）');
    // 旧混塞逻辑：跑题英文表名占满 24 预算，判别性 query 词（4-gram + query 自己的英文标识 onDrugPath）被全数挤出
    assert.ok(!od.termList.includes('药品说明'), '旧逻辑：判别性 query 4-gram「药品说明」被跑题表名挤出 24 预算（bug 复现）');
    assert.ok(!od.termList.includes('品说明书'), '旧逻辑：判别性 query 4-gram「品说明书」被跑题表名挤出 24 预算（bug 复现）');
    assert.ok(!od.termList.includes('onDrugPath'), '旧逻辑：连 query 自己的英文标识 onDrugPath 都被跑题表名挤出预算（bug 复现）');
    const { files: of_, df: odf } = grepRepo(dir, 'v1.0', od.termList);
    const oldTop = rank(of_, odf, od.specSourced, 4);   // 旧逻辑无降权（specSourced 空）
    // 真答案文件命中的判别性 query 词被挤出 → 得分崩塌，off-topic mapper 排到前面
    assert.ok(/Mapper\.xml$/.test(oldTop[0]), '旧逻辑：off-topic mapper 排 top-1（匹配注入的跑题表名 + 蹭大众词）');
    const oldAnswerIdx = oldTop.indexOf(answer);
    assert.ok(oldAnswerIdx === -1 || oldAnswerIdx > 0, '旧逻辑：真答案 intervention.vue 掉出 top-1（被跑题 mapper 盖过，bug 复现）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('spec 词降权：同样稀有时 spec 表名（0.5×）不盖过同稀有度的 query 词，on-topic 桥仍保留', () => {
  // 单点验证 weight 系数：spec 注入词权重是同 df/同 lenBonus 的 query 词的一半
  const df = { pwrs_monitoring_drug_screen: 1, onDrugPath: 1 };   // 两者都 isIdent、lenBonus=3、df=1（同稀有度）
  const specSourced = new Set(['pwrs_monitoring_drug_screen']);
  const weight = t => (specSourced.has(t) ? 0.5 : 1) * lenBonus(t) / Math.log2(2 + (df[t] || 0));
  const specW = 0.5 * 3 / Math.log2(3);      // spec 表名：0.5 × 3 / log2(3)
  const qW = 1 * 3 / Math.log2(3);           // query 英文标识：满权重 1 × 3 / log2(3)
  assert.ok(Math.abs(weight('pwrs_monitoring_drug_screen') - specW) < 1e-9, 'spec 表名权重乘了 0.5 降权系数');
  assert.ok(Math.abs(weight('onDrugPath') - qW) < 1e-9, 'query 英文标识享满权重（无降权）');
  // 关键：同样稀有（同 df/同 lenBonus）时 spec 表名权重严格 < query 词 → off-topic mapper XML 压不过真答案文件
  assert.ok(weight('pwrs_monitoring_drug_screen') < weight('onDrugPath'), 'spec 表名降权后严格 < 同稀有度的 query 英文标识满权重');
});
