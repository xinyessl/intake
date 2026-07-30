#!/usr/bin/env node
// 收件 intake · 端到端冒烟测试（零依赖，用 fetch）。对着"正在运行"的服务跑。
//   用法：node tools/smoke.mjs                （默认 http://127.0.0.1:5180，账号 admin/admin123）
//        BASE=http://127.0.0.1:58371 ADMIN_PW=admin123 node tools/smoke.mjs
// 会自建一个临时项目 smoke-xxxx 跑全流程，结束清理，不污染真实数据。
const BASE = process.env.BASE || 'http://127.0.0.1:5180';
const ADMIN = process.env.ADMIN_USER || 'admin';
const PW = process.env.ADMIN_PW || 'admin123';
let cookie = '';
let pass = 0, fail = 0;

function ok(name, cond, extra = '') { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ ' + name + (extra ? '  ' + extra : '')); } }
async function api(path, { method = 'GET', body, raw = false } = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookie = sc.split(';')[0];
  return raw ? { status: r.status, text: await r.text() } : { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
  console.log('冒烟目标：' + BASE + '\n');
  const pid = 'smoke-' + Math.random().toString(36).slice(2, 7);
  try {
    // 1 健康 / 版本（免登录）
    ok('health', (await api('/api/health')).json?.ok === true);
    ok('version', typeof (await api('/api/version')).json?.version === 'string');
    // 2 未登录被挡
    ok('未登录 /api/projects → 401', (await api('/api/projects')).status === 401);
    // 3 登录
    const lg = await api('/api/login', { method: 'POST', body: { username: ADMIN, password: PW } });
    ok('管理员登录', lg.json?.ok === true, JSON.stringify(lg.json));
    if (!lg.json?.ok) throw new Error('登录失败，后续跳过');
    // 4 建项目 + 子系统
    ok('建项目', (await api('/api/project-save', { method: 'POST', body: { id: pid, name: '冒烟测试产品', subsystems: [{ key: 'a', name: '子系统甲' }] } })).json?.ok === true);
    // 5 提交需求（表单/直接）
    const sub = await api('/api/intake-submit', { method: 'POST', body: { project: pid, type: 'requirement', title: '冒烟需求：导出功能', role: '产品经理', bg: '需要', reqDesc: '导出Excel' } });
    ok('提交需求', sub.json?.ok === true, JSON.stringify(sub.json));
    const iid = sub.json?.id;
    // 6 工单流转闭环
    ok('待处理→已立项', (await api('/api/intake-transition', { method: 'POST', body: { project: pid, id: iid, to: '已立项', assignee: '开发甲' } })).json?.ok === true);
    ok('已立项→开发中', (await api('/api/intake-transition', { method: 'POST', body: { project: pid, id: iid, to: '开发中' } })).json?.ok === true);
    ok('非法流转被拒(开发中→已关闭仍可强制关闭? 用非法：开发中→待验证)', (await api('/api/intake-transition', { method: 'POST', body: { project: pid, id: iid, to: '待验证' } })).json?.ok === false);
    ok('开发中→已出包', (await api('/api/intake-transition', { method: 'POST', body: { project: pid, id: iid, to: '已出包', resolution: { fixedVersion: 'v9.9', note: '实时查询' } } })).json?.ok === true);
    ok('已出包→待验证', (await api('/api/intake-transition', { method: 'POST', body: { project: pid, id: iid, to: '待验证' } })).json?.ok === true);
    const close = await api('/api/intake-transition', { method: 'POST', body: { project: pid, id: iid, to: '已关闭', note: '通过' } });
    ok('待验证→已关闭', close.json?.ok === true);
    ok('关闭自动沉淀经验库(kbSunk)', close.json?.kbSunk === true);
    // 7 列表带 lifecycle
    ok('列表工单为已关闭', (await api('/api/intake-list?project=' + pid)).json?.items?.some(x => x.id === iid && x.lifecycle === '已关闭'));
    // 8 经验库
    ok('经验库有条目', (await api('/api/kb-list?project=' + pid)).json?.entries?.length >= 1);
    ok('人工加经验', (await api('/api/kb-save', { method: 'POST', body: { project: pid, q: '冒烟问题', a: '冒烟解法' } })).json?.ok === true);
    // 9 提交链接
    const link = await api('/api/submit-link', { method: 'POST', body: { project: pid, site: '冒烟现场', type: 'bug' } });
    ok('生成提交链接', link.json?.ok === true && typeof link.json?.token === 'string');
    // 10 通知 / 导出
    ok('通知端点', typeof (await api('/api/notifications')).json?.count === 'number');
    ok('导出 CSV', (await api('/api/intake-export?project=' + pid, { raw: true })).text.includes('编号,类型'));
  } catch (e) { console.log('  ! 异常：' + e.message); fail++; }
  finally {
    // 清理
    try { await api('/api/project-delete', { method: 'POST', body: { id: pid } }); } catch {}
    console.log(`\n结果：${pass} 通过，${fail} 失败`);
    process.exit(fail ? 1 : 0);
  }
})();
