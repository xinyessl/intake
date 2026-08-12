// FS-04 答疑 Spec 两阶段召回：纯逻辑回归 + PWRS 真实规格锚点。
// 用法：node --test tools/spec-retrieval-two-stage.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildSpecDocument,
  routeSpecCandidates,
  searchSpecDocuments,
  currentTurnEvidenceGuard,
  expandRetrievalQuery,
} from '../spec-retrieval.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PWRS = '/Users/lsy/lc-work/psp/pwrs';
const PWRS_SPECS = path.join(PWRS, 'docs/specs');

function doc(file, text, subsystem = '') {
  return buildSpecDocument({ file, subsystem, text });
}

function names(xs) { return xs.map(x => path.basename(x.file || '')); }
function hitText(xs) { return xs.map(x => x.text || '').join('\n'); }
function extractBalancedFunction(src, marker) {
  const start = src.indexOf(marker); assert.ok(start >= 0, `应找到 ${marker}`);
  const open = src.indexOf('{', start); let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${marker} 未配平`);
}

test('阶段一目录路由真实生效：只在候选文件内做正文检索，目录本身不成为证据片段', () => {
  const specs = [
    doc('docs/specs/监护记录.md', `---\ntitle: 药学监护记录\nmodule: 患者监护\n---\n## 删除记录\n删除监护记录调用 POST /care/record/delete。`),
    doc('docs/specs/无关大正文.md', `---\ntitle: 导出工具\nmodule: 系统工具\n---\n## 附录\n${'监护 记录 删除 '.repeat(400)}`),
  ];
  const routed = routeSpecCandidates(specs, '药学监护记录怎么删除？', { maxCandidates: 1 });
  assert.deepEqual(names(routed), ['监护记录.md']);
  const result = searchSpecDocuments(specs, '药学监护记录怎么删除？', { n: 5, maxCandidates: 1 });
  assert.deepEqual(names(result.candidates), ['监护记录.md']);
  assert.ok(result.hits.length > 0);
  assert.ok(result.hits.every(x => x.file.endsWith('监护记录.md')), '正文阶段不得越过候选集检索无关大正文');
  assert.ok(result.hits.every(x => x.evidence === 'body'), '目录/标题只能路由，不能伪装成事实证据');
});

test('完整目录无前 30/60 截断：第 61 份及其后 Spec 仍可路由和召回', () => {
  const specs = Array.from({ length: 65 }, (_, i) => doc(
    `docs/specs/S-${String(i + 1).padStart(2, '0')}.md`,
    `---\nid: S-${i + 1}\ntitle: 普通模块 ${i + 1}\nmodule: 普通模块\n---\n## 说明\n第 ${i + 1} 份资料。`,
  ));
  specs[60] = doc('docs/specs/S-61.md', `---\nid: S-61\ntitle: 后段专用接口\nmodule: 系统支撑\n---\n## 接口契约\nPOST /api/late/spec 接收 late_field。`);
  const result = searchSpecDocuments(specs, 'POST /api/late/spec 的 late_field 是什么？', { n: 5 });
  assert.ok(names(result.candidates).includes('S-61.md'));
  assert.match(hitText(result.hits), /POST \/api\/late\/spec/);
  assert.match(hitText(result.hits), /late_field/);
});

test('正确文件后部的接口/字段进入 Top5，长表格不因固定前 800 字被截掉', () => {
  const longRows = Array.from({ length: 90 }, (_, i) => `| filler_${i} | 普通说明 ${i} |`).join('\n');
  const specs = [doc('docs/specs/患者检验.md', `---\ntitle: 患者检验接口\nmodule: 临床数据\n---\n## 概览\n检验接口说明。\n\n## 数据契约\n| 字段 | 说明 |\n|---|---|\n${longRows}\n| report_time | 报告时间 |\n| last_modify_time | ETL 最近写入时间 |\n\n## 接口契约\nGET /proxyapi/proxy/patient/exam/search` )];
  const result = searchSpecDocuments(specs, 'GET /proxyapi/proxy/patient/exam/search 返回的 last_modify_time 字段是什么意思？', { n: 5 });
  assert.ok(result.hits.length <= 5);
  assert.match(hitText(result.hits), /\/proxyapi\/proxy\/patient\/exam\/search/);
  assert.match(hitText(result.hits), /last_modify_time/);
});

test('精确标识符优先：word 参数不被 Word 导出抢走，SQL 数据库连接不被 WebSocket 连接抢走', () => {
  const specs = [
    doc('docs/specs/Word导出.md', `---\ntitle: 文档导出（Word/Excel）\nmodule: 系统工具\n---\n## 导出\n把业务记录导出为 Word 文件。`),
    doc('docs/specs/ETL映射.md', `---\ntitle: ETL 临床数据接口映射与排查\nmodule: Proxy/HIS\n---\n## 病程记录\n页面参数 \`word\` 不传 ETL，由 Proxy 按 bcName 本地过滤。`),
    doc('docs/specs/WebSocket.md', `---\ntitle: WebSocket 消息连接\nmodule: 消息沟通\n---\n## 连接\n客户端建立 WebSocket 长连接。`),
    doc('docs/specs/SQL监视.md', `---\ntitle: SQL 监视诊断客户端\nmodule: 系统运维工具\n---\n## 连接类型\n支持 PostgreSQL、MySQL、Oracle 数据库连接。`),
  ];
  const word = searchSpecDocuments(specs, '病程记录的 word 参数会传给 ETL 吗？', { n: 5 });
  assert.equal(path.basename(word.candidates[0].file), 'ETL映射.md');
  assert.equal(path.basename(word.hits[0].file), 'ETL映射.md');
  assert.match(hitText(word.hits), /word.*不传 ETL/);

  const sql = searchSpecDocuments(specs, 'SQL 监视客户端怎么连接 PostgreSQL 数据库？', { n: 5 });
  assert.equal(path.basename(sql.candidates[0].file), 'SQL监视.md');
  assert.match(hitText(sql.hits), /PostgreSQL、MySQL、Oracle/);
  assert.doesNotMatch(hitText(sql.hits), /WebSocket 长连接/);
  assert.equal(sql.hits.find(x => x.file.endsWith('Word导出.md'))?.exactMatches || 0, 0, 'SQL/PWRS/Web/PostgreSQL 等普通技术词不能被当成精确业务标识符');
  assert.ok(word.hits[0].exactMatches >= 1, '小写参数名 word 仍应保持大小写精确命中');
});

test('相邻模块不串：当前问题实体“药师反馈”压过历史/通用词“监护、记录、完成、删除”', () => {
  const specs = [
    doc('docs/specs/监护.md', `---\ntitle: 药学监护记录\nmodule: 患者监护\n---\n## 完成与删除\n监护记录完成后可以删除。`),
    doc('docs/specs/反馈.md', `---\ntitle: 药师反馈\nmodule: 消息与反馈\n---\n## 完成与删除\n药师反馈完成后调用 /feedback/delete 删除。`),
  ];
  const result = searchSpecDocuments(specs, '药师反馈完成后怎么删除记录？', { n: 3 });
  assert.equal(path.basename(result.candidates[0].file), '反馈.md');
  assert.equal(path.basename(result.hits[0].file), '反馈.md');
});

test('显式 subsystem 优先收窄，并支持 API 路径、snake_case、camelCase、状态值强匹配', () => {
  const specs = [
    doc('docs/specs/a.md', `---\ntitle: 审方接口\nmodule: 审方\n---\n## 接口\nPOST /pwrsapi/task/finish，字段 task_id、reviewStatus，状态 FINISHED。`, 'audit'),
    doc('docs/specs/b.md', `---\ntitle: 监护接口\nmodule: 监护\n---\n## 接口\nPOST /pwrsapi/task/finish，字段 task_id、reviewStatus，状态 FINISHED。`, 'care'),
  ];
  const result = searchSpecDocuments(specs, '/pwrsapi/task/finish 的 task_id、reviewStatus 变成 FINISHED 后如何处理？', { n: 5, subKey: 'care' });
  assert.deepEqual([...new Set(result.candidates.map(x => x.subsystem))], ['care']);
  assert.deepEqual([...new Set(result.hits.map(x => x.subsystem))], ['care']);
  assert.match(hitText(result.hits), /task_id.*reviewStatus.*FINISHED/);
});

test('多轮事实边界：当前问题/当前召回实体优先，旧轮其它模块只能帮助理解代词', () => {
  const guard = currentTurnEvidenceGuard('药师反馈怎么删除？', [{ title: '药师反馈', module: '消息与反馈' }]);
  assert.match(guard, /当前问题/);
  assert.match(guard, /药师反馈怎么删除/);
  assert.match(guard, /历史对话.*不能.*事实证据/);
  assert.match(guard, /当前召回/);

  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  const start = server.indexOf("if (url.pathname === '/api/consult'");
  const end = server.indexOf("if (url.pathname === '/api/consult-to-intake'", start);
  const route = server.slice(start, end);
  assert.match(route, /lastUser[\s\S]*?qtext[\s\S]*?specSearch\([^\n]*qtext/, '召回查询只取本轮最后一个 user 问题');
  assert.match(route, /currentTurnEvidenceGuard\(qtext, specHits\)/, '模型仍收历史消息，但接入本轮事实边界');
});

test('多轮代词追问只补上一条 user 实体做检索，不把 assistant 旧答案当事实', () => {
  const messages = [
    { role: 'user', content: 'SQL 监视诊断客户端能连哪些数据库？' },
    { role: 'assistant', content: '这里即便写了错误端口，也不能成为检索事实。' },
    { role: 'user', content: '那它会不会调用 PWRS 的 HTTP 接口？' },
  ];
  const expanded = expandRetrievalQuery(messages, messages[2].content);
  assert.match(expanded, /SQL 监视诊断客户端/);
  assert.match(expanded, /追问：那它会不会调用/);
  assert.doesNotMatch(expanded, /错误端口/);
  assert.equal(expandRetrievalQuery(messages, '患者主页异常检验默认看几天？'), '患者主页异常检验默认看几天？');
});

test('自然问法只补检索概念、不硬编码答案：跨医院同一次就诊可路由到跨院区复合身份正文', () => {
  const q = '跨医院判断同一次患者就诊，最少要用哪些身份字段？';
  const expanded = expandRetrievalQuery([{ role: 'user', content: q }], q);
  assert.match(expanded, /跨院区/);
  assert.match(expanded, /本次住院/);
  assert.match(expanded, /复合身份/);
  assert.doesNotMatch(expanded, /hospitalId|patientId|visitId/, '检索补词不能把答案字段硬编码进 query');
});

test('普通事实问答不把完整 Spec 目录塞给模型；明确询问模块清单时仍可见完整目录', () => {
  const server = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');
  let fullCatalogCalls = 0;
  const consultSystem = new Function(
    'specIndex', 'subsystemNames', 'renderPromptTpl', 'DATA_DIR',
    extractBalancedFunction(server, 'function consultSystem(') + '\nreturn consultSystem;',
  )(
    () => { fullCatalogCalls++; return '[全量] 模块甲\n[全量] 模块乙\n[全量] 模块丙'; },
    () => [],
    (_dir, _key, vars) => vars,
    '/tmp',
  );
  const hit = [{ file: 'docs/specs/target.md', title: '目标规则', module: '目标模块', text: '正文证据' }];
  const fact = consultSystem({ name: '产品' }, '', [], hit, null, '目标字段怎么保存？');
  assert.equal(fullCatalogCalls, 0, '普通事实问答不能构造/注入完整目录');
  assert.match(fact.specIndexBlock, /本轮候选\/命中规格目录/);
  assert.match(fact.specIndexBlock, /目标规则/);
  assert.doesNotMatch(fact.specIndexBlock, /模块甲|模块乙|模块丙/);

  const catalog = consultSystem({ name: '产品' }, '', [], hit, null, '这个系统有哪些模块？');
  assert.equal(fullCatalogCalls, 1);
  assert.match(catalog.specIndexBlock, /系统完整规格目录/);
  assert.match(catalog.specIndexBlock, /模块甲.*模块乙.*模块丙/s);
  assert.match(catalog.specIndexBlock, /目录标题不能作为事实证据/);
});

function loadPwrsSpecs() {
  return fs.readdirSync(PWRS_SPECS)
    .filter(f => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase() !== 'readme.md')
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
    .map(f => doc(`docs/specs/${f}`, fs.readFileSync(path.join(PWRS_SPECS, f), 'utf8')));
}

test('PWRS 真实 86 份 Spec 全量可达：git 目录第 79 份 SYS-07a 与第 82 份 SYS-10 均进候选/Top5', { skip: !fs.existsSync(PWRS_SPECS) }, () => {
  const ls = spawnSync('git', ['-c', 'core.quotepath=false', 'ls-tree', '-r', '--name-only', 'HEAD', '--', 'docs/specs'], { cwd: PWRS, encoding: 'utf8' });
  assert.equal(ls.status, 0);
  const files = ls.stdout.split('\n').filter(f => f.endsWith('.md') && !path.basename(f).startsWith('_') && path.basename(f).toLowerCase() !== 'readme.md');
  assert.equal(files.length, 86, '真实目录锚定为 86 份，防旧 slice 上限悄悄回来');
  assert.ok(files.findIndex(f => f.includes('PWRS-SYS-07a-')) >= 60);
  assert.ok(files.findIndex(f => f.includes('PWRS-SYS-10-')) >= 60);

  const specs = loadPwrsSpecs();
  const cases = [
    ['病程记录分类接口的 word 参数会传给 ETL 吗？', 'PWRS-SYS-07a-', /word.*不传 ETL/],
    ['ETL 真正统一入口和 interfaceCode 请求体是什么？', 'PWRS-SYS-07a-', /comm\/proxy\/request/],
    ['SQL 监视诊断客户端支持哪些数据库连接类型？', 'PWRS-SYS-10-', /MySQL\/MariaDB.*PostgreSQL/s],
    ['SQL 监视工具会调用 PWRS 的 HTTP 接口吗？', 'PWRS-SYS-10-', /(?:无 HTTP 业务接口|不依赖 PWRS\/usercenter 登录或 HTTP 接口)/],
    ['Pad 上药师反馈对象下拉调哪个接口？', 'PWRS-CARE-01a-', /\/pwrsapi\/applet\/patient\/feedback\/objects/],
    ['患者主页那个异常检验，默认看最近几天？', 'PWRS-CARE-01b-', /近 5 天异常指标/],
  ];
  for (const [q, fileNeedle, bodyNeedle] of cases) {
    const result = searchSpecDocuments(specs, q, { n: 5 });
    assert.ok(names(result.candidates).some(f => f.includes(fileNeedle)), `${q}：目标文件应进入候选`);
    const targetHits = result.hits.filter(h => path.basename(h.file).includes(fileNeedle));
    assert.ok(targetHits.length, `${q}：目标文件正文应进入 Top5`);
    assert.match(hitText(targetHits), bodyNeedle, `${q}：Top5 应含可直接作答的正文证据`);
  }

  const identityQuestion = '跨医院判断同一次患者就诊，最少要用哪些身份字段？';
  const identityResult = searchSpecDocuments(specs, expandRetrievalQuery([{ role: 'user', content: identityQuestion }], identityQuestion), { n: 5 });
  assert.ok(identityResult.hits.some(h => /PWRS-(?:CARE-01a|ACC-06)-/.test(h.file) && /hospitalId(?:\/districtCode)?\s*\+\s*patientId\s*\+\s*visitId/.test(h.text)), '自然问法经概念归一后，答案字段必须来自 CARE-01a/ACC-06 正文');
});
