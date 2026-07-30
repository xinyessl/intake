// 共享导航增强：右侧注入 当前用户 + 退出；开发角色补「账号管理」入口。所有管理端页面 <script defer> 引入。
(async () => {
  const nav = document.querySelector('.topnav'); if (!nav) return;
  let me = null, authEnabled = false;
  try { const r = await (await fetch('/api/me')).json(); me = r.me; authEnabled = r.authEnabled; } catch {}
  const isAdmin = me && (me.role === 'admin' || me.role === 'dev');
  // 角色自适应导航：token 链接访客不显示导航（干净公开面）；现场账号只保留「提交」
  if (me && me.link) { nav.style.display = 'none'; return; }
  if (me && !isAdmin) { nav.querySelectorAll('a').forEach(a => { const h = a.getAttribute('href') || ''; if (h !== '/submit.html' && h !== '/') a.style.display = 'none'; }); }
  const roleLabel = r => (r === 'admin' || r === 'dev') ? '管理员' : r === 'pm' ? '产品经理' : '实施工程师';
  // 统一菜单顺序（全局规范：菜单稳定排序）——各页面硬编码顺序不一 + 动态注入，这里按固定 sort 归一，保证切页菜单不变序
  const cur = location.pathname;
  let sp = nav.querySelector('.navspacer'); if (!sp) { sp = document.createElement('span'); sp.className = 'navspacer'; sp.style.flex = '1'; nav.appendChild(sp); }
  if (isAdmin) {
    const NAV_META = { '/customers.html': { icon: 'ti-building-hospital', label: '客户管理' }, '/kb.html': { icon: 'ti-book', label: '经验库' }, '/accounts.html': { icon: 'ti-users', label: '账号管理' } };
    for (const href in NAV_META) {   // 补齐缺失的 客户管理 / 经验库 / 账号管理（有的页面硬编码了、有的没有）
      if (!nav.querySelector(`a[href="${href}"]`)) { const a = document.createElement('a'); a.href = href; a.innerHTML = `<i class="ti ${NAV_META[href].icon}"></i> <span class="txt">${NAV_META[href].label}</span>`; nav.insertBefore(a, sp); }
    }
    const pj = nav.querySelector('a[href="/projects.html"]');   // 项目管理 → 产品管理（统一文案，兜底：个别页静态文本没改到时这里纠正）
    if (pj && /项目管理/.test(pj.textContent)) pj.innerHTML = pj.innerHTML.replace('项目管理', '产品管理');
    const NAV_ORDER = ['/console.html', '/submit.html', '/inbox.html', '/projects.html', '/customers.html', '/kb.html', '/accounts.html', '/model-config.html'];
    for (const href of NAV_ORDER) { const a = nav.querySelector(`a[href="${href}"]`); if (a) nav.insertBefore(a, sp); }   // 依序移到 spacer 前 → 最终顺序恒等于 NAV_ORDER
  }
  nav.querySelectorAll(':scope > a').forEach(a => a.classList.toggle('on', (a.getAttribute('href') || '') === cur));   // 高亮当前页
  const box = document.createElement('span');
  box.className = 'navuser';
  if (me) {
    box.innerHTML = `<span class="navwho"><i class="ti ti-user-circle"></i>${escapeHtml(me.name || me.username)} · ${roleLabel(me.role)}</span><a href="#" id="_chpw" class="navpill"><i class="ti ti-key"></i> 改密</a><a href="/logout" class="navpill"><i class="ti ti-logout"></i> 退出</a>`;
  } else if (authEnabled) {
    box.innerHTML = `<a href="/login.html" class="navpill"><i class="ti ti-login"></i> 登录</a>`;
  } else {
    box.innerHTML = `<a href="/accounts.html" class="navpill"><i class="ti ti-shield-plus"></i> 未启用认证 · 去创建管理员</a>`;
  }
  nav.appendChild(box);
  if (me) { try { const n = await (await fetch('/api/notifications')).json(); if (n.count > 0) { const bell = document.createElement(n.role === 'dev' ? 'a' : 'span'); if (n.role === 'dev') bell.href = '/inbox.html'; bell.title = n.role === 'dev' ? '待处理 / 已重开工单' : '需你关注的工单（已回复 / 待验证）'; bell.className = 'navbell'; bell.innerHTML = `<i class="ti ti-bell"></i> 待办 ${n.count}`; box.insertBefore(bell, box.firstChild); } } catch {} }
  const chpw = document.getElementById('_chpw');
  if (chpw) chpw.addEventListener('click', async (e) => {
    e.preventDefault();
    const oldp = await uiPrompt('请输入原密码：', { title: '修改密码', inputType: 'password', placeholder: '原密码' }); if (oldp == null) return;
    const np = await uiPrompt('请输入新密码（至少 6 位）：', { title: '修改密码', inputType: 'password', placeholder: '新密码' }); if (np == null) return;
    try { const r = await (await fetch('/api/change-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ old: oldp, new: np }) })).json(); r.ok ? uiAlert('密码已修改', { type: 'ok' }) : uiAlert('修改失败：' + (r.error || ''), { type: 'err' }); } catch (err) { uiAlert('修改失败：' + err.message, { type: 'err' }); }
  });
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
})();
