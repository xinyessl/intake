// MM-01 · 模型多模态 content 构造（FS-04/FS-06 AI 看图）——纯逻辑单元测试（零依赖 node --test）
//   用 vm 提取 server.mjs 里真身的 mmParseImage / withImages 两函数，断言：
//     ① 有图 → 末条 user 的 content 变多模态数组（anthropic image / openai image_url 两格式各一次）；
//     ② 无图 / 无有效图 → content 保持原字符串（向后兼容，纯文本调用一字不变）；
//     ③ 图片只并进「最后一条 user」、历史消息不改；≤6 张封顶；非法 data URL 过滤。
//   不真调模型（本地无 key），只验 content 构造正确——这是"AI 看图"的 load-bearing 部分。
//   用法：node --test tools/mm-01.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8');

// —— 从 server.mjs 抽取真身函数源码（同 fs-04 vm 提取法）——
function pick(name, argPat) {
  const re = new RegExp('function ' + name + '\\(' + argPat + '\\)\\s*\\{[\\s\\S]*?\\n\\}', 'm');
  const m = SRC.match(re);
  assert.ok(m, '应能从 server.mjs 抽取函数 ' + name);
  return m[0];
}
// 沙箱运行两函数，返回 { withImages, mmParseImage }
function loadFns() {
  const src = pick('mmParseImage', 'du') + '\n' + pick('withImages', 'messages, images, isAnthropic') + '\nglobalThis.__withImages = withImages; globalThis.__mmParseImage = mmParseImage;';
  const sandbox = { console };
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return { withImages: sandbox.__withImages, mmParseImage: sandbox.__mmParseImage };
}

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
const JPG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA==';

test('A1 mmParseImage：合法 data URL 解析出 mediaType + base64 + url；非法返 null', () => {
  const { mmParseImage } = loadFns();
  const p = mmParseImage(PNG);
  assert.ok(p, 'PNG 应解析出对象');
  assert.equal(p.mediaType, 'image/png', 'mediaType=image/png');
  assert.equal(p.data, 'iVBORw0KGgoAAAANSUhEUg==', 'base64 去掉 data: 前缀');
  assert.equal(p.url, PNG, '保留完整 data URL（openai 用）');
  assert.equal(mmParseImage('not-a-data-url'), null, '非法字符串 → null');
  assert.equal(mmParseImage(''), null, '空串 → null');
  assert.equal(mmParseImage('data:text/plain;base64,YWJj'), null, '非图片 mime → null（正则要求 image/）');
});

test('A2 无图 → content 原样字符串（向后兼容·纯文本调用一字不变）', () => {
  const { withImages } = loadFns();
  const msgs = [{ role: 'user', content: '端口连不上' }];
  const outA = withImages(msgs, [], true);   // anthropic 无图
  const outO = withImages(msgs, undefined, false);   // openai 无图（images 缺省）
  assert.equal(typeof outA[0].content, 'string', 'anthropic 无图 content 仍字符串');
  assert.equal(outA[0].content, '端口连不上', 'content 内容不变');
  assert.equal(typeof outO[0].content, 'string', 'openai 无图 content 仍字符串');
  assert.deepEqual(outO, msgs, 'openai 无图 → 原样返回');
});

test('A3 无有效图（全非法 data URL）→ content 仍字符串（不构造空多模态块）', () => {
  const { withImages } = loadFns();
  const msgs = [{ role: 'user', content: 'x' }];
  const out = withImages(msgs, ['garbage', 'data:text/plain;base64,YQ=='], true);
  assert.equal(typeof out[0].content, 'string', '过滤掉全部非法图 → content 仍字符串（向后兼容）');
});

test('A4 anthropic 有图 → 末条 user content = [{type:text},{type:image,source:base64}...]', () => {
  const { withImages } = loadFns();
  const msgs = [{ role: 'assistant', content: '你好' }, { role: 'user', content: '看这个报错' }];
  const out = withImages(msgs, [PNG, JPG], true);
  const c = out[1].content;
  assert.ok(Array.isArray(c), '★ anthropic 末条 user content 变数组');
  assert.equal(c[0].type, 'text', '首块是 text');
  assert.equal(c[0].text, '看这个报错', 'text 是原文');
  assert.equal(c[1].type, 'image', '★ 图块 type=image');
  assert.equal(c[1].source.type, 'base64', 'source.type=base64');
  assert.equal(c[1].source.media_type, 'image/png', 'media_type 从 data URL 解析（png）');
  assert.equal(c[1].source.data, 'iVBORw0KGgoAAAANSUhEUg==', 'data 是去前缀 base64');
  assert.equal(c[2].source.media_type, 'image/jpeg', '第二张 media_type=jpeg');
  // 历史 assistant 消息不动
  assert.equal(out[0].content, '你好', '历史 assistant 消息 content 不变');
});

test('A5 openai 有图 → 末条 user content = [{type:text},{type:image_url,image_url:{url}}...]', () => {
  const { withImages } = loadFns();
  const msgs = [{ role: 'user', content: '这是什么错' }];
  const out = withImages(msgs, [PNG], false);
  const c = out[0].content;
  assert.ok(Array.isArray(c), '★ openai 末条 user content 变数组');
  assert.equal(c[0].type, 'text', '首块 text');
  assert.equal(c[0].text, '这是什么错', 'text 原文');
  assert.equal(c[1].type, 'image_url', '★ 图块 type=image_url');
  assert.equal(c[1].image_url.url, PNG, 'image_url.url = 完整 data URL');
});

test('A6 只并进「最后一条 user」——多轮对话里前面的 user 不动', () => {
  const { withImages } = loadFns();
  const msgs = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '答' },
    { role: 'user', content: '第二问带图' },
  ];
  const out = withImages(msgs, [PNG], true);
  assert.equal(out[0].content, '第一问', '第一条 user（非末条）content 不变（仍字符串）');
  assert.ok(Array.isArray(out[2].content), '★ 只有最后一条 user 变多模态');
});

test('A7 ≤6 张封顶（多于 6 张只取前 6 张图块）', () => {
  const { withImages } = loadFns();
  const many = Array.from({ length: 9 }, () => PNG);
  const out = withImages([{ role: 'user', content: 'x' }], many, true);
  const imgBlocks = out[0].content.filter(b => b.type === 'image');
  assert.equal(imgBlocks.length, 6, '★ 最多并 6 张图块（对齐后端 slice(0,6)）');
});

test('A8 无 user 消息（异常）→ 原样返回、不抛', () => {
  const { withImages } = loadFns();
  const msgs = [{ role: 'assistant', content: '只有 AI 说话' }];
  const out = withImages(msgs, [PNG], true);
  assert.equal(out[0].content, '只有 AI 说话', '无 user → 不动、content 仍字符串');
});
