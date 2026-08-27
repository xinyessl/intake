import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const ROOT = new URL('..', import.meta.url);
const SRC = fs.readFileSync(new URL('tools/judge-audit-browser-eval.mjs', ROOT), 'utf8');

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist in judge-audit-browser-eval.mjs`);
  const parenOpen = src.indexOf('(', start);
  let parenDepth = 0;
  let parenClose = -1;
  for (let index = parenOpen; index < src.length; index += 1) {
    if (src[index] === '(') parenDepth += 1;
    else if (src[index] === ')' && --parenDepth === 0) {
      parenClose = index;
      break;
    }
  }
  assert.ok(parenClose > parenOpen, `${name} parameter list must close`);
  const braceOpen = src.indexOf('{', parenClose);
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = braceOpen; index < src.length; index += 1) {
    const ch = src[index];
    const next = src[index + 1];
    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}' && --depth === 0) return src.slice(start, index + 1);
  }
  throw new Error(`${name} body must close`);
}

const parseFns = new Function([
  extractFn(SRC, 'normalizeText'),
  extractFn(SRC, 'independentAnswerFacts'),
  extractFn(SRC, 'compactJudgeRequirement'),
  extractFn(SRC, 'normalizePass'),
  extractFn(SRC, 'stripCodeFence'),
  extractFn(SRC, 'isSingleJudgeVerdict'),
  extractFn(SRC, 'hasUnclosedJsonObject'),
  extractFn(SRC, 'isTruthyFlag'),
  extractFn(SRC, 'judgeRawDiagnosticsEnabled'),
  extractFn(SRC, 'buildJudgeParserDiagnostic'),
  extractFn(SRC, 'nonEmptyJudgeRows'),
  extractFn(SRC, 'parseJudgeJson'),
  'return { parseJudgeJson, buildJudgeParserDiagnostic, judgeRawDiagnosticsEnabled, independentAnswerFacts, compactJudgeRequirement };',
].join('\n'))();

const { parseJudgeJson, buildJudgeParserDiagnostic, judgeRawDiagnosticsEnabled, independentAnswerFacts, compactJudgeRequirement } = parseFns;

const reportParserFailure = new Function('fs', 'path', [
  extractFn(SRC, 'normalizeText'),
  extractFn(SRC, 'isTruthyFlag'),
  extractFn(SRC, 'judgeRawDiagnosticsEnabled'),
  extractFn(SRC, 'buildJudgeParserDiagnostic'),
  extractFn(SRC, 'writeJsonAtomic'),
  extractFn(SRC, 'reportJudgeParserFailure'),
  'return reportJudgeParserFailure;',
].join('\n'))(fs, path);

const validPass = {
  id: 'Q0088',
  pass: true,
  categories: [],
  reason: '覆盖本题要求。',
};

test('裁判 payload 压缩：requirement 已覆盖全部 answerFacts 时省略重复 facts', () => {
  const requirement = '页面先给出业务结论。；调用 GET /comm/deal/error。；当前无定时自动重试。';
  const answerFacts = [
    '页面先给出业务结论。',
    '调用 GET /comm/deal/error。',
    '当前无定时自动重试。',
  ];
  assert.deepEqual(independentAnswerFacts(requirement, answerFacts), []);
  const compact = compactJudgeRequirement({
    requirement,
    answerFacts,
    mustNotConfuse: ['另一个模块不得串答'],
    safety: '不得臆造。',
  });
  assert.equal(Object.hasOwn(compact, 'answerFacts'), false);
  assert.equal(compact.requirement, requirement);
  assert.deepEqual(compact.mustNotConfuse, ['另一个模块不得串答']);
  assert.equal(compact.safety, '不得臆造。');
});

test('裁判 payload 压缩：只补 requirement 未覆盖的独立 answerFacts', () => {
  const covered = '已确认页面现象。';
  const requirement = `${covered}；已确认主接口为 GET /comm/deal/error。`;
  const missing = '生产是否已部署须结合发布记录确认。';
  assert.deepEqual(independentAnswerFacts(requirement, [covered, missing]), [missing]);
  assert.deepEqual(independentAnswerFacts('', [missing]), [missing]);
  const compact = compactJudgeRequirement({ requirement, answerFacts: [covered, missing] });
  assert.deepEqual(compact.answerFacts, [missing]);
  assert.equal(compact.requirement, requirement);
});

test('严格裁判解析：批量数组、代码围栏和单题 verdict 对象均可解析', () => {
  assert.deepEqual(parseJudgeJson(JSON.stringify([validPass])), [validPass]);
  assert.deepEqual(parseJudgeJson('```json\n' + JSON.stringify([validPass]) + '\n```'), [validPass]);
  assert.deepEqual(parseJudgeJson(JSON.stringify(validPass), true), [validPass]);
  assert.deepEqual(parseJudgeJson(`模型说明：${JSON.stringify(validPass)}`, true), [validPass]);
  assert.deepEqual(parseJudgeJson(JSON.stringify({ verdicts: [validPass] })), [validPass]);
});

test('严格裁判解析：单题对象必须有 id 和可识别的 pass，不能把 categories 空数组当成通过', () => {
  assert.throws(() => parseJudgeJson(JSON.stringify({ categories: [] }), true), /合法 JSON 数组|批量裁判必须返回/);
  assert.throws(() => parseJudgeJson(JSON.stringify({ id: 'Q0088', categories: [] }), true), /合法 JSON 数组|批量裁判必须返回/);
  assert.throws(() => parseJudgeJson(JSON.stringify({ id: 'Q0088', pass: 'maybe', categories: [] }), true), /合法 JSON 数组|批量裁判必须返回/);
  assert.throws(() => parseJudgeJson('[]', true), /合法 JSON 数组/);
  assert.throws(() => parseJudgeJson(JSON.stringify({ verdicts: [] }), true), /合法 JSON 数组/);
  assert.throws(() => parseJudgeJson('categories: []', true), /合法 JSON 数组/);
  assert.throws(() => parseJudgeJson(JSON.stringify(validPass), false), /批量裁判必须返回 JSON 数组/);
});

test('严格裁判解析：自然语言、截断 JSON 和多对象拼接都保持协议失败', () => {
  assert.throws(() => parseJudgeJson('裁判结果：通过，未发现问题。', true), /合法 JSON 数组/);
  assert.throws(() => parseJudgeJson('{"id":"Q0088","pass":true,"categories":[]', true), /合法 JSON 数组/);
  assert.throws(() => parseJudgeJson(`${JSON.stringify(validPass)}\n${JSON.stringify(validPass)}`, true), /合法 JSON 数组/);
  assert.throws(() => parseJudgeJson('[{"id":"Q0088","pass":true,', false), /合法 JSON 数组/);
});

test('裁判 raw 诊断默认不返回原文，显式 debug 才包含原文', () => {
  const raw = '模型私有返回：这段内容默认不能泄漏';
  const error = new Error('裁判模型未返回合法 JSON 数组');
  const disabled = buildJudgeParserDiagnostic(raw, error, { itemIds: ['Q0088'] }, { debugRaw: false });
  assert.equal(disabled, null);
  assert.equal(judgeRawDiagnosticsEnabled({ debugRaw: false }), false);

  const enabled = buildJudgeParserDiagnostic(raw, error, { itemIds: ['Q0088'] }, { debugRaw: true });
  assert.equal(enabled.raw, raw);
  assert.equal(enabled.error, error.message);
  assert.deepEqual(enabled.itemIds, ['Q0088']);
});

test('裁判 raw 诊断：显式文件路径才保存原文，默认路径不产生文件', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-raw-'));
  try {
    const outputPath = path.join(directory, 'q0088.json');
    const raw = '{"id":"Q0088","pass":true,"categories":[]';
    const error = new Error('裁判模型未返回合法 JSON 数组');
    assert.equal(reportParserFailure(raw, error, { itemIds: ['Q0088'] }, { debugRawFile: outputPath }), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), {
      event: 'judge_parser_failure',
      error: error.message,
      itemIds: ['Q0088'],
      raw,
    });
    assert.equal(reportParserFailure(raw, error, { itemIds: ['Q0088'] }, { debugRaw: false }), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
