// FS-10 前端静态守卫：field.html 转人工按钮 + 运营人工答复渲染；consult-reply.html 队列/回复/AI 草稿沉淀 DOM。
//   纯静态断言（读文件 + 关键片段存在）+ 内联 JS 可解析——不起浏览器。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const field = fs.readFileSync(path.join(ROOT, 'public/field.html'), 'utf8');
const reply = fs.readFileSync(path.join(ROOT, 'public/consult-reply.html'), 'utf8');
const shell = fs.readFileSync(path.join(ROOT, 'public/assets/shell.js'), 'utf8');

function parseInline(html, label) {
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g; let m, n = 0;
  while ((m = re.exec(html))) { n++; new Function(m[1]); }   // 抛错即测试失败
  assert.ok(n >= 1, label + ' 有内联脚本');
}

test('field.html：合并引导卡 appendConsultActions（沉淀经验库 + 转工单 + 转人工三入口合一条）', () => {
  assert.ok(field.includes('function appendConsultActions'), '有 appendConsultActions 合并函数');
  assert.ok(field.includes('f-consult-actions'), '合并卡片 class f-consult-actions（卡片级幂等去重键）');
  // 三个入口的接口调用 + 成功文案逐一保留
  assert.ok(field.includes("'/api/kb-from-consult'"), '沉淀经验库调 kb-from-consult');
  assert.ok(field.includes('已沉淀到经验库'), '沉淀成功文案');
  assert.ok(field.includes("'/api/consult-escalate'"), '转人工调 consult-escalate 端点');
  assert.ok(field.includes('已转人工 · 可继续和运营对话'), '转人工成功文案');
  assert.ok(field.includes('openConsultToIntake('), '转工单走 openConsultToIntake 弹窗');
  // 条件出按钮：沉淀=实质答复(canKb)、转工单/转人工=有会话(convId)
  const fn = field.slice(field.indexOf('function appendConsultActions'), field.indexOf('function appendConsultActions') + 4000);
  assert.ok(/canKb\s*=\s*!nonSub\s*&&\s*!!chat\.lastQ/.test(fn), '沉淀经验库仅实质答复');
  assert.ok(/canTicket\s*=\s*!!convId/.test(fn) && /canEscalate\s*=\s*!!convId/.test(fn), '转工单/转人工仅有会话时出');
  assert.ok(/if\s*\(chat\.humanActive\)\s*return/.test(fn), 'humanActive（人工服务中）时整卡不出');
  assert.ok(fn.includes('chat.humanActive = true'), '转人工成功后进人工模式');
  // 挂载点：finishConsult 里改为一处 appendConsultActions（不再三处分散调用）
  const fc = field.slice(field.indexOf('function finishConsult'), field.indexOf('function finishConsult') + 1600);
  assert.ok(fc.includes('appendConsultActions('), 'finishConsult 里合并为一处 appendConsultActions');
  assert.ok(!fc.includes('appendKbSink()') && !fc.includes('appendConsultToIntake()') && !fc.includes('appendConsultEscalate()'), 'finishConsult 不再分散调三个旧函数');
});

test('field.html：运营人工答复 human:true 渲染成专属样式（区别 AI 气泡）', () => {
  assert.ok(field.includes('appendHumanReplyBubble'), '有 appendHumanReplyBubble 函数');
  assert.ok(field.includes('f-human-reply'), '专属 class f-human-reply');
  assert.ok(field.includes('运营人工答复'), '标签文案「运营人工答复」');
  // reopenConsult 里对 human 消息走专属渲染分支
  assert.ok(/m\.role === 'assistant' && m\.human/.test(field), 'reopen 时按 human 走专属渲染分支');
  // 保留 human/by 标记（否则渲染不出署名/样式）
  assert.ok(/human: !!\(m && m\.human\)/.test(field), '映射保留 human 标记');
});

test('field.html：对话记录列表转人工态徽标（待回复/已回复）', () => {
  assert.ok(field.includes('运营已回复'), '已回复徽标');
  assert.ok(field.includes('待运营回复'), '待回复徽标');
  assert.ok(field.includes('f-conv-human'), '徽标 class');
});

test('field.html 内联脚本可解析', () => { parseInline(field, 'field.html'); });

test('consult-reply.html：队列表 + 4 个新端点调用', () => {
  assert.ok(reply.includes('data-shell="admin"'), 'admin 外壳');
  assert.ok(reply.includes('data-nav="consult-reply"'), 'nav=consult-reply');
  assert.ok(reply.includes('data-content-layout="list"'), 'list 布局');
  assert.equal((reply.match(/class="page-content/g) || []).length, 0, '不自写 page-content（shell 注入）');
  assert.ok(reply.includes("'/api/consult-escalations'"), '队列端点');
  assert.ok(reply.includes("'/api/consult-human-reply'"), '回复端点');
  assert.ok(reply.includes("'/api/consult-kb-draft'"), '草稿端点');
  assert.ok(reply.includes("source:'escalated'") || reply.includes("source: 'escalated'"), '沉淀 source=escalated');
  assert.ok(reply.includes('/api/kb-save'), '沉淀走 kb-save');
});

test('consult-reply.html：回复框 + AI 草稿可编辑 q/a + 确认沉淀', () => {
  assert.ok(reply.includes('crReply') && reply.includes('发送回复'), '回复框 + 发送');
  assert.ok(reply.includes('AI 整理草稿'), 'AI 整理草稿入口');
  assert.ok(reply.includes('crKbQ') && reply.includes('crKbA'), '可编辑 q/a 文本框');
  assert.ok(reply.includes('确认沉淀'), '确认沉淀按钮');
  // 抽屉自实现（部署 shell.js 无 UI.openDrawer，见 lessons）
  assert.ok(reply.includes('function openDrawer') && reply.includes('function closeDrawer'), '自实现抽屉 open/close');
  assert.ok(reply.includes('function toast'), '自实现 toast');
  // 选择型即选即查
  assert.ok(/addEventListener\('change',loadQueue\)/.test(reply), '筛选选择即查');
});

test('consult-reply.html 内联脚本可解析', () => { parseInline(reply, 'consult-reply.html'); });

test('shell.js：新增「咨询回复」导航项，其余项不动', () => {
  assert.ok(/id: "consult-reply"[\s\S]{0,80}href: "\/consult-reply\.html"/.test(shell), '导航项已加');
  // 既有项仍在
  for (const id of ['inbox', 'kb', 'customers', 'batches', 'accounts']) assert.ok(shell.includes(`id: "${id}"`), '既有导航 ' + id + ' 未被破坏');
});
