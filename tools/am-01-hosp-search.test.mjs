// AM-01 · 账号编辑抽屉「负责医院」名称即输即过滤 —— 静态源码断言（零依赖，node --test）
//
//   验的是纯前端交互增强（public/accounts.html），不碰后端/数据/保存逻辑：
//     · 抽屉里「负责医院」勾选列表上方有名称搜索框 #edHospSearch（放进 #hospitalsGroup，随角色联动显隐）；
//     · 即输即过滤走「显隐切换」(label.style.display)，绝不重渲染 innerHTML（重渲染会丢未保存的勾选态）；
//     · input 事件只绑一次（不在 renderHospitals 里重复绑）；
//     · renderHospitals 每次重置 #edHospSearch.value；无医院时隐藏搜索框；
//     · 保存仍走 checkedValues('#edHospitals') 读 input:checked（与 display 无关 → 被过滤隐藏但仍勾选的照读）。
//   用法：node --test tools/am-01-hosp-search.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'public/accounts.html'), 'utf8');

// 抠出 hospitalsGroup 的 HTML 片段与 filterHospitals 函数体，做「结构 + 手段」断言
function slice(str, from, to) {
  const i = str.indexOf(from); assert.ok(i >= 0, `源码应含锚点：${from}`);
  const j = str.indexOf(to, i); assert.ok(j >= 0, `源码应含结束锚点：${to}`);
  return str.slice(i, j);
}

test('[AC] #hospitalsGroup 内含名称搜索框 #edHospSearch（复用 input-with-icon + ti-search，placeholder 与 autocomplete）', () => {
  const grp = slice(src, 'id="hospitalsGroup"', 'id="projGroup"');
  // 搜索框在勾选列表上方（先出现 edHospSearch，再出现 edHospitals）
  const iSearch = grp.indexOf('id="edHospSearch"');
  const iList = grp.indexOf('id="edHospitals"');
  assert.ok(iSearch >= 0, '负责医院区应含搜索框 #edHospSearch');
  assert.ok(iList >= 0, '负责医院区应含勾选列表 #edHospitals');
  assert.ok(iSearch < iList, '搜索框应在勾选列表上方（先于 #edHospitals）');
  // 复用本页 filter-bar 已用的 input-with-icon + ti-search，风格一致
  assert.match(grp, /input-with-icon[^>]*id="edHospSearchWrap"|id="edHospSearchWrap"[^>]*input-with-icon/, '搜索框外层应复用 .input-with-icon（wrap=edHospSearchWrap）');
  assert.match(grp, /<i class="ti ti-search">/, '搜索框应带 ti-search 图标');
  assert.match(grp, /id="edHospSearch"[^>]*placeholder="按医院名称筛选…"/, 'placeholder 应为「按医院名称筛选…」');
  assert.match(grp, /id="edHospSearch"[^>]*autocomplete="off"/, '搜索框应 autocomplete="off"');
});

test('[AC] 过滤走「显隐切换」而非重渲染——filterHospitals 切 label.style.display、不调 renderHospitals / innerHTML=', () => {
  const fn = slice(src, 'function filterHospitals(', '\n$(\'#edHospSearch\').addEventListener');
  assert.match(fn, /\.style\.display\s*=/, 'filterHospitals 应用 style.display 切显隐');
  assert.match(fn, /label\.checkbox/, 'filterHospitals 应遍历 #edHospitals 下的 label.checkbox');
  // 铁律：过滤函数体内绝不重渲染（不调 renderHospitals、不写 #edHospitals 的 innerHTML）
  assert.ok(!/renderHospitals\s*\(/.test(fn), 'filterHospitals 内不得调用 renderHospitals（重渲染会丢勾选态）');
  assert.ok(!/#edHospitals[^)]*\.innerHTML\s*=|edHospitals'\)\.innerHTML\s*=/.test(fn), 'filterHospitals 内不得重写 #edHospitals.innerHTML');
  // 匹配医院名取 input.value；区域可一并匹配
  assert.match(fn, /input\[type=checkbox\]/, '应从 label 内 input[type=checkbox] 取医院名 value');
  assert.match(fn, /includes\(kw\)/, '应做子串匹配（includes）');
  assert.match(fn, /toLowerCase\(\)/, '应不区分大小写（toLowerCase）');
});

test('[AC] input 事件只绑一次（页面初始化时对 #edHospSearch 绑，不在 renderHospitals 内绑）', () => {
  const binds = src.match(/#edHospSearch'\)\.addEventListener\('input'/g) || [];
  assert.equal(binds.length, 1, '#edHospSearch 的 input 事件应恰好绑定一次');
  // 绑定行不应位于 renderHospitals 函数体内
  const render = slice(src, 'function renderHospitals(', '\nfunction filterHospitals(');
  assert.ok(!/addEventListener\('input'/.test(render), 'renderHospitals 内不得绑定 input 事件（否则每次 render 重复绑）');
});

test('[AC] renderHospitals 每次重置搜索框 value + 隐藏无匹配提示；无医院时隐藏搜索框、有医院时显示', () => {
  const render = slice(src, 'function renderHospitals(', '\nfunction filterHospitals(');
  assert.match(render, /#edHospSearch'\)[^;]*\.value\s*=\s*''|sb\.value\s*=\s*''/, 'renderHospitals 应清空 #edHospSearch.value（避免残留搜索词过滤新列表）');
  // 无可选医院分支隐藏搜索框
  assert.match(render, /CUSTOMERS\.length/, 'renderHospitals 应按 CUSTOMERS.length 分流');
  assert.match(render, /edHospSearchWrap'\)/, 'renderHospitals 应取搜索框 wrap #edHospSearchWrap 控制显隐');
  assert.match(render, /w\.style\.display\s*=\s*'none'/, '无医院时应隐藏搜索框 wrap（display=none）');
  assert.match(render, /w\.style\.display\s*=\s*''/, '有医院时应显示搜索框 wrap（display=空）');
});

test('[AC] 无匹配提示复用 .empty-line，独立于 #edHospitals（不进 innerHTML，避免被重渲染污染）', () => {
  const fn = slice(src, 'function filterHospitals(', '\n$(\'#edHospSearch\').addEventListener');
  assert.match(fn, /edHospNoMatch/, '应有独立无匹配提示节点 #edHospNoMatch');
  assert.match(fn, /className\s*=\s*'empty-line'|class="empty-line"/, '无匹配提示应复用 .empty-line 类');
  assert.match(fn, /insertAdjacentElement\('afterend'|after\(/, '提示节点应插在 #edHospitals 之后（同级、非其子节点）');
  assert.match(fn, /无匹配医院/, '无匹配时提示文案「无匹配医院」');
});

test('[未回归] 保存仍走 checkedValues(\'#edHospitals\') 读所有 input:checked（与显隐无关）', () => {
  assert.match(src, /function checkedValues\(box\)\{[^}]*box\+' input:checked'/, 'checkedValues 应读 box 下所有 input:checked');
  // impl 保存取值仍走 checkedValues('#edHospitals')，未被搜索改动
  assert.match(src, /role==='impl'\)\s*sites=checkedValues\('#edHospitals'\)/, 'impl 保存负责医院仍走 checkedValues(#edHospitals)（读所有勾选，与过滤显隐无关）');
});
