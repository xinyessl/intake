// Markdown 管道表格回归：直接抽取并执行 field/ui/submit 三个真实渲染器，不用“字符串存在”代替行为验证。
// 用法：node --test tools/markdown-table.logic.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIELD = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');
const UI = fs.readFileSync(path.join(ROOT, 'public/assets/ui.js'), 'utf8');
const SUBMIT = fs.readFileSync(path.join(ROOT, 'public/submit.html'), 'utf8');

function extractBalancedFunction(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start >= 0, `应能找到 ${marker}`);
  const braceOpen = src.indexOf('{', start);
  let depth = 0;
  for (let i = braceOpen; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  assert.fail(`${marker} 大括号未配平`);
}

const fieldMd = new Function(extractBalancedFunction(FIELD, 'function md(src)') + '\nreturn md;')();
const submitMd = new Function(extractBalancedFunction(SUBMIT, 'function mdToHtml(src)') + '\nreturn mdToHtml;')();
const uiAssignment = extractBalancedFunction(UI, 'window.mdToHtml = function (src)');
const uiMd = new Function('var window = {};\n' + uiAssignment + ';\nreturn window.mdToHtml;')();

const renderers = [
  ['field.md', fieldMd],
  ['ui.mdToHtml', uiMd],
  ['submit.mdToHtml', submitMd],
];

for (const [name, render] of renderers) {
  test(`${name}：标准 GFM 表格生成滚动包装 + table/thead/tbody，并渲染行内 Markdown`, () => {
    const md = [
      '| 项目 | 结果 |',
      '| :--- | ---: |',
      '| **状态** | `正常` |',
      '| 页面 | 可使用 |',
    ].join('\n');
    const html = render(md);
    assert.match(html, /<div class="md-table-wrap"[^>]*role="region"[^>]*aria-label="Markdown 表格"[^>]*>/, '表格有横向滚动包装和可访问名称');
    assert.match(html, /<table class="md-table"><thead><tr>/, '有 table + thead');
    assert.match(html, /<\/thead><tbody><tr>/, '有 tbody 数据行');
    assert.match(html, /class="md-align-left"/, '左对齐冒号被解析');
    assert.match(html, /class="md-align-right"/, '右对齐冒号被解析');
    assert.match(html, /<strong>状态<\/strong>/, '单元格内粗体生效');
    assert.match(html, /<code>正常<\/code>/, '单元格内代码生效');
    assert.doesNotMatch(html, /\|\s*:---\s*\|/, '分隔行不再作为原始管道文本显示');
  });

  test(`${name}：无首尾管道也识别为表格，普通段落保持段落`, () => {
    const html = render('姓名 | 状态\n--- | :---:\n小王 | 已处理\n\n后续保持观察。');
    assert.match(html, /<table class="md-table">/, '无首尾管道的表格被识别');
    assert.match(html, /<th[^>]*>姓名<\/th>/, '表头内容正确');
    assert.match(html, /<td[^>]*>已处理<\/td>/, '单元格内容正确');
    assert.match(html, /<p(?: class="md-p")?>后续保持观察。<\/p>/, '表格后的普通段落正常渲染');
  });

  test(`${name}：表格单元格与普通段落都先转义，不能注入 HTML/XSS`, () => {
    const html = render('| 内容 | 说明 |\n| --- | --- |\n| <img src=x onerror="boom()"> | **安全** |\n\n<script>alert(1)</script>');
    assert.doesNotMatch(html, /<img\b|<script\b|onerror="boom\(\)"/, '不生成攻击者提供的 HTML 标签/属性');
    assert.match(html, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/, '表格 XSS 内容被转义');
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, '普通段落 XSS 内容被转义');
    assert.match(html, /<strong>安全<\/strong>/, '转义后仍可生成受控行内 Markdown');
  });

  test(`${name}：独占 --- / *** 渲染语义分隔线，不误伤列表或表格分隔行`, () => {
    const html = render('上文\n\n---\n\n下文\n\n***\n\n- 列表项\n\n列A | 列B\n--- | :---:\n值A | 值B');
    assert.equal((html.match(/<hr class="md-divider">/g) || []).length, 2, '两种独占分隔线均生成带类名的 hr');
    assert.match(html, /<li(?: class="md-li")?>列表项<\/li>/, '列表仍按列表渲染');
    assert.match(html, /<table class="md-table">/, '表格仍按表格渲染');
    assert.doesNotMatch(html, />\s*---\s*</, '独占分隔线与表格分隔行均不原样显示');
  });
}

test('field 对话正文可读字号：桌面至少 15px，移动端 16px', () => {
  assert.match(FIELD, /\.f-msg \.bub \{[^}]*font-size:\s*15px/, '桌面对话正文为 15px');
  assert.match(FIELD, /@media \(max-width:\s*720px\)\s*\{\s*\.f-msg \.bub \{\s*font-size:\s*16px/, '移动端对话正文为 16px');
});

test('field.md：无序子列表切开的显式有序步骤保留 2/3/4 的 HTML start 语义', () => {
  const html = fieldMd([
    '1. 记录页面现象',
    '   - 保存已有截图',
    '2. 核对已有请求',
    '   - 对照响应内容',
    '3. 比较三边结果',
    '4. 整理只读证据',
  ].join('\n'));

  assert.match(html, /^<ol class="md-ol"><li class="md-li">记录页面现象<ul class="md-ul">/, '第 1 步与缩进无序子项保持嵌套');
  assert.match(html, /<li class="md-li">核对已有请求<ul class="md-ul">/, '第 2 步与自己的无序子项保持嵌套');
  assert.equal((html.match(/<ol class="md-ol"/g) || []).length, 1, '缩进子列表不拆断顶层有序列表');
  assert.doesNotMatch(html, /<ol class="md-ol" start="[234]">/, '保持同一有序列表时无需额外拆块');
  assert.match(html, /<li class="md-li">比较三边结果<\/li><li class="md-li">整理只读证据<\/li><\/ol>$/, '第 3/4 步连续且处于同一 ol');
});

test('field.md：被同级列表或空行切成新块时，显式非 1 marker 输出 start 属性', () => {
  const switched = fieldMd('1. 第一步\n- 同级说明\n2. 第二步\n- 另一说明\n3. 第三步\n\n4. 第四步');
  assert.match(switched, /<ol class="md-ol"><li class="md-li">第一步<\/li><\/ol>/, '首个 ol 使用默认起点 1');
  assert.match(switched, /<ol class="md-ol" start="2"><li class="md-li">第二步<\/li><\/ol>/, '同级 ul 后的新 ol 从 2 开始');
  assert.match(switched, /<ol class="md-ol" start="3"><li class="md-li">第三步<\/li><\/ol>/, '第二个同级 ul 后的新 ol 从 3 开始');
  assert.match(switched, /<ol class="md-ol" start="4"><li class="md-li">第四步<\/li><\/ol>$/, '空行后的新 ol 从 4 开始');

  const explicit = fieldMd('3. 第三项\n4. 第四项');
  assert.equal(explicit, '<ol class="md-ol" start="3"><li class="md-li">第三项</li><li class="md-li">第四项</li></ol>', '显式 3 起始的连续列表只生成一个语义正确的 ol');
});

test('field.md：普通连续 ol 与嵌套 ol 都保持显式序号', () => {
  assert.equal(
    fieldMd('1. 第一项\n2. 第二项'),
    '<ol class="md-ol"><li class="md-li">第一项</li><li class="md-li">第二项</li></ol>',
    '普通 1/2 连续列表不产生多余 start 或拆块',
  );

  const nested = fieldMd('1. 外层一\n   3. 内层三\n   4. 内层四\n2. 外层二');
  assert.equal(
    nested,
    '<ol class="md-ol"><li class="md-li">外层一<ol class="md-ol" start="3"><li class="md-li">内层三</li><li class="md-li">内层四</li></ol></li><li class="md-li">外层二</li></ol>',
    '嵌套 ol 挂在所属 li 下，并独立保留起始 marker',
  );
});

test('field.md：非列表数字不误判，列表内容仍先转义避免 XSS', () => {
  const html = fieldMd('版本 3.2 不属于列表\n2026.08.15 也不是列表\n\n2. <img src=x onerror="boom()">');
  assert.match(html, /^<p class="md-p">版本 3\.2 不属于列表<br>2026\.08\.15 也不是列表<\/p>/, '句中数字与无 marker 后空格的日期保持普通段落');
  assert.match(html, /<ol class="md-ol" start="2">/, '真实显式 marker 仍被识别');
  assert.doesNotMatch(html, /<img\b|onerror="boom\(\)"/, '列表内容不能注入 HTML/事件属性');
  assert.match(html, /&lt;img src=x onerror=&quot;boom\(\)&quot;&gt;/, '攻击内容按文本转义');
});
