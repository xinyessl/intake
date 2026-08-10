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
