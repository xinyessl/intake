/* BP-06: shared admin release and hospital upgrade UI, no framework. */
window.ReleaseUI = (() => {
  const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const api = async (url,body) => {const r=await fetch(url,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const j=await r.json();if(!r.ok || j.ok===false)throw Error(j.error||'操作失败');return j;};
  const btn=(label,fn)=>{const b=document.createElement('button');b.className='btn btn-sm';b.textContent=label;b.onclick=async()=>{b.disabled=true;try{await fn();}catch(e){alert(e.message);}finally{b.disabled=false;}};return b;};
  const fileInput=(label,fn,accept='')=>{const l=document.createElement('label');l.className='btn btn-sm';l.textContent=label+' ';const f=document.createElement('input');f.type='file';f.accept=accept;f.hidden=true;l.tabIndex=0;l.setAttribute('role','button');l.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();if(!f.disabled)f.click();}};f.onchange=async()=>{if(!f.files[0])return;f.disabled=true;try{await fn(f.files[0]);}catch(e){alert(e.message);}finally{f.disabled=false;}};l.append(f);return l;};
  const field=(label,value,onchange,type='text')=>{const l=document.createElement('label');l.style.cssText='display:inline-flex;gap:8px;align-items:center;margin:6px;';l.append(document.createTextNode(label));const i=document.createElement('input');i.type=type;i.value=value||'';i.oninput=()=>onchange(i.value);i.className='input';l.append(i);return l;};
  const select=(label,value,values,onchange)=>{const l=document.createElement('label');l.style.margin='6px';l.append(document.createTextNode(label+' '));const s=document.createElement('select');s.innerHTML='<option value="">请选择</option>'+values.map(v=>'<option value="'+esc(v)+'">'+esc(v)+'</option>').join('');s.value=value||'';s.onchange=()=>onchange(s.value);l.append(s);return l;};
  function message(box,text) {const p=document.createElement('p');p.textContent=text;box.append(p);return p;}
  const downloadText=(name,content)=>{const url=URL.createObjectURL(new Blob([content],{type:'application/sql;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download=(name||'migration.sql').split(/[\\/]/).pop();a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  const readable=b=>{b.dataset.readonlyAllowed='true';return b;};
  function sqlWorkspace(items,locked){
    const section=document.createElement('section');section.className='sql-workspace';
    const head=document.createElement('div');head.className='release-heading';head.innerHTML='<strong>SQL 文件 <span class="sql-count"></span></strong><span>按发布顺序保存，每次编辑一个文件</span>';section.append(head);
    const layout=document.createElement('div');layout.className='sql-layout';section.append(layout);
    const list=document.createElement('nav');list.className='sql-file-list';list.setAttribute('aria-label','SQL 文件列表');const editor=document.createElement('div');editor.className='sql-editor';layout.append(list,editor);
    let active=0;
    const filename=(s,i)=>s.file||s.title||('未命名迁移 '+(i+1));
    const drawList=()=>{list.replaceChildren();head.querySelector('.sql-count').textContent='('+items.length+')';items.forEach((s,i)=>{const b=readable(btn('',()=>{active=i;draw();}));b.className='sql-file'+(i===active?' selected':'');b.setAttribute('aria-current',i===active?'true':'false');b.title=filename(s,i);const name=document.createElement('strong');name.textContent=(i+1)+'. '+filename(s,i).split('/').pop();const meta=document.createElement('span');meta.textContent=(s.vendor||'未选方言')+' / '+(s.db||'未选目标库');b.append(name,meta);list.append(b);});};
    const draw=()=>{active=Math.min(active,items.length-1);drawList();editor.replaceChildren();if(!items.length){message(editor,'尚无 SQL 文件。新增后请选择方言和目标库。');return;}const s=items[active];
      const meta=document.createElement('div');meta.className='sql-meta';meta.append(field('文件路径',s.file,v=>{s.file=v;drawList();}),field('迁移 ID',s.id,v=>s.id=v),select('方言',s.vendor,['mysql','postgresql'],v=>{s.vendor=v;drawList();}),select('目标库',s.db,['bms','etl'],v=>{s.db=v;drawList();}),field('标题',s.title,v=>s.title=v));editor.append(meta);
      const toolbar=document.createElement('div');toolbar.className='sql-editor-toolbar';
      toolbar.append(readable(btn('下载 .sql',()=>downloadText(s.file||s.id+'.sql',s.content||''))),fileInput('导入正文',async file=>{if(!/\.sql$/i.test(file.name))throw Error('请选择 .sql 文件');if(file.size>5*1024*1024)throw Error('SQL 文件不能超过 5 MiB');let content;try{content=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());}catch{throw Error('请使用 UTF-8 编码的 SQL 文件');}if(!content.trim())throw Error('SQL 文件不能为空');if(s.content && !confirm('替换当前文件正文？迁移 ID、路径、方言和目标库保持不变。'))return;s.content=content;delete s.checksum;draw();},'.sql'),btn('删除文件',()=>{if(!confirm('删除当前 SQL 文件？'))return;items.splice(active,1);draw();}));editor.append(toolbar);
      const text=document.createElement('textarea');text.className='sql-code';text.setAttribute('aria-label','SQL 正文');text.spellcheck=false;text.readOnly=locked;text.value=s.content||'';text.oninput=()=>{s.content=text.value;delete s.checksum;hash.textContent='正文已修改，保存时重新计算校验值';};editor.append(text);
      const hash=document.createElement('div');hash.className='sql-checksum';hash.textContent=s.checksum?'SHA256 '+s.checksum:'保存时自动计算 SHA256';editor.append(hash);
      if(locked)editor.querySelectorAll('input,select,button').forEach(x=>{if(!x.dataset.readonlyAllowed)x.disabled=true;});
    };
    const add=btn('新增 SQL 文件',()=>{items.push({id:'migration-'+Date.now(),file:'',title:'',vendor:'',db:'',content:''});active=items.length-1;draw();});add.disabled=locked;head.append(add);draw();return section;
  }
  async function renderBatch(box,batch,onSaved) {
    box.innerHTML='加载版本增量…';
    const r=await api('/api/batch-deploy-draft?batchId='+encodeURIComponent(batch.id));
    let d=structuredClone(r.saved || r.draft || {version:batch.pkgVersion,tag:batch.pkgVersion,parentVersion:'',dependencySetId:'',tasks:[],sql:[],artifacts:[]});
    d.version ||= batch.pkgVersion;d.tag ||= d.version;d.artifacts ||= [];
    const original=structuredClone(d);
    let legacy=!!r.saved&&r.saved.schemaVersion!==2;
    let taskResize;
    const draw=()=>{
      taskResize?.disconnect();
      box.innerHTML='';box.className='dpbox';
      message(box,'本版本清单 · '+(r.saved?.reviewedAt?'已审核':'待审核')+' · 上传包不等同于发布');
      if(r.locked)message(box,'已发布，清单与应用包已锁定。');
      if(legacy)message(box,'历史跨版快照：不能作为本版增量使用。请在代码中整理本版清单并发布新的 tag。');
      if(r.error && !r.draft)message(box,r.error);
      const form=document.createElement('fieldset');form.className='release-form';form.style.border='0';box.append(form);
      const metadata=document.createElement('div');metadata.className='release-meta';form.append(metadata);
      metadata.append(field('版本',d.version,v=>{d.version=v;}),field('tag',d.tag,v=>d.tag=v),field('前驱版本',d.parentVersion,v=>d.parentVersion=v));
      form.append(btn('从 tag 重新拉取本版',async()=>{const x=await api('/api/batch-deploy-draft?batchId='+encodeURIComponent(batch.id));if(!x.draft)throw Error(x.error);d={...x.draft,artifacts:d.artifacts||[]};legacy=false;draw();}));
      form.append(fileInput('导入构建清单',async file=>{const raw=JSON.parse(await file.text());if(raw.schemaVersion!==2 || raw.kind!=='delta')throw Error('请选择构建生成的 docs/deploy/<版本>.json');d=raw;legacy=false;draw();},'.json'));
      const taskGroup=document.createElement('details');taskGroup.className='release-tasks';const taskSummary=document.createElement('summary');taskSummary.textContent='配置任务（'+(d.tasks||[]).length+'）';taskGroup.append(taskSummary);form.append(taskGroup);
      const resizeDescriptions=()=>{if(!taskGroup.open)return;taskGroup.querySelectorAll('.task-description').forEach(text=>{text.style.height='auto';text.style.height=(text.scrollHeight+2)+'px';});};
      (d.tasks ||= []).forEach((t,index)=>{const row=document.createElement('div');row.className='dp-item release-task';const description=document.createElement('label');description.className='task-description-field';description.append(document.createTextNode('说明'));const text=document.createElement('textarea');text.className='task-description';text.rows=2;text.value=t.desc||'';text.readOnly=!!r.locked;text.setAttribute('aria-label','任务说明 '+(index+1));text.oninput=()=>{t.desc=text.value;resizeDescriptions();};description.append(text);row.append(field('稳定 ID',t.id,v=>t.id=v),field('标题',t.title,v=>t.title=v),btn('删除',()=>{d.tasks.splice(index,1);draw();}),description);taskGroup.append(row);});
      taskGroup.addEventListener('toggle',resizeDescriptions);taskResize=new ResizeObserver(resizeDescriptions);taskResize.observe(taskGroup);requestAnimationFrame(resizeDescriptions);
      taskGroup.append(btn('添加任务',()=>{d.tasks.push({id:'task-'+Date.now(),title:'',desc:''});draw();}));
      form.append(sqlWorkspace(d.sql ||= [],!!r.locked));
      const packages=document.createElement('section');packages.className='release-packages';message(packages,'应用与依赖包 · '+d.artifacts.filter(a=>a.url).length+'/'+d.artifacts.length+' 已上传');form.append(packages);
      const groups=new Map();d.artifacts.forEach(a=>{const key=a.platform+' / '+a.dbVendor;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(a);});
      groups.forEach((artifacts,key)=>{const group=document.createElement('div');group.className='artifact-group';const title=document.createElement('h4');title.textContent=key;group.append(title);packages.append(group);
        artifacts.forEach(a=>{const row=document.createElement('div');row.className='artifact-row';const info=document.createElement('div');info.className='artifact-info';const name=document.createElement('strong');name.textContent=a.kind==='application'?'全量应用包':'完整依赖包';const detail=document.createElement('span');detail.textContent=(Number.isFinite(a.size)?(a.size/1024/1024).toFixed(1)+' MiB':'大小待确认')+' · '+(a.url?'已上传':'待上传');info.append(name,detail);row.append(info);
          if(a.url){const link=document.createElement('a');link.className='btn btn-sm';link.textContent='下载';link.href=a.url;link.download=a.file;row.append(link);}
          if(!r.locked)row.append(fileInput(a.url?'替换文件':'选择文件',async file=>{const response=await fetch('/api/release-artifact-upload?name='+encodeURIComponent(file.name),{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:file});const x=await response.json();if(!x.ok)throw Error(x.error);if(a.sha256 && a.sha256!==x.artifact.sha256)throw Error('上传文件 SHA256 与构建清单不一致');Object.assign(a,x.artifact);draw();},'.zip'));
          const details=document.createElement('details');details.className='artifact-details';const summary=document.createElement('summary');summary.textContent='文件详情';details.append(summary);message(details,a.file);message(details,'SHA256 '+a.sha256);row.append(details);group.append(row);
        });});
      const actions=document.createElement('div');actions.className='release-actions';form.append(actions);
      actions.append(btn('取消未保存修改',()=>{if(confirm('放弃当前未保存修改？')){d=structuredClone(original);draw();}}));
      actions.append(btn('保存草稿',async()=>{await api('/api/batch-deploy-save',{...d,batchId:batch.id,legacyConverted:!legacy,asDraft:true});await onSaved?.();}));
      actions.append(btn('审核并保存清单',async()=>{await api('/api/batch-deploy-save',{...d,batchId:batch.id,legacyConverted:!legacy});await onSaved?.();}));
      actions.append(btn('发布此版本',async()=>{if(legacy)throw Error('请先转换历史清单');await api('/api/batch-deploy-save',{...d,batchId:batch.id,legacyConverted:true});const a=d.artifacts.find(a=>a.kind==='application');if(!a?.url)throw Error('请先上传应用包');await api('/api/batch-release',{id:batch.id,pkgVersion:d.version,artifactUrl:a.url,releaseNote:batch.releaseNote||''});await onSaved?.();}));
      if(r.locked)form.querySelectorAll('input,select,button').forEach(x=>{if(!x.dataset.readonlyAllowed)x.disabled=true;});
    };draw();
  }
  function siteVersion(product){
    if(product.releaseVersion)return String(product.releaseVersion);
    if(Array.isArray(product.subsystems)){const versions=product.subsystems.map(s=>String(s.version||'').trim());return versions.length&&versions.every(Boolean)&&new Set(versions).size===1?versions[0]:'';}
    return String(product.version||'');
  }
  async function openAdminDeploymentSettings(site,productId,onSaved,productNames={}){
    const existing=document.getElementById('release-site-settings');if(existing){existing.focus();return;}
    const data=await api('/api/field/release-options?site='+encodeURIComponent(site));
    if(document.getElementById('release-site-settings'))return;
    const dialog=document.createElement('dialog');dialog.id='release-site-settings';dialog.className='release-admin-settings';dialog.style.cssText='width:min(560px,calc(100vw - 32px));box-sizing:border-box;padding:24px;border:1px solid #ccd7e3;border-radius:12px';document.body.append(dialog);
    const heading=message(dialog,'部署信息 · '+site);heading.style.cssText='font-size:18px;font-weight:600;margin:0 0 12px';message(dialog,'维护医院出厂及已核实的部署信息；有未完成升级计划时禁止修改。');
    const content=document.createElement('div'),footer=document.createElement('div');footer.style.cssText='display:flex;justify-content:flex-end;align-items:center;gap:10px;margin-top:20px;padding-top:16px;border-top:1px solid var(--color-border,#e3e8ef)';const redraw=pid=>{content.replaceChildren();const product=data.products.find(p=>p.project===pid);if(!product)return;const value={site,product:pid,dbVendor:product.deployment?.dbVendor||'',platform:product.deployment?.platform||''};
      message(content,'现场版本：'+(siteVersion(product)||'未确认')+'（在客户产品版本中维护）');if(!siteVersion(product))message(content,'子系统版本缺失或不一致，请先核实产品现场版本，不会自动使用目标版本。');
      content.append(select('数据库',value.dbVendor,['mysql','postgresql'],v=>value.dbVendor=v),select('部署方式',value.platform,['docker','windows'],v=>value.platform=v));footer.replaceChildren(btn('取消',()=>dialog.close()),btn('保存现场信息',async()=>{await api('/api/customer-deployment-save',value);dialog.close();await onSaved?.();}));
      content.querySelectorAll('input,select').forEach(x=>{x.className=x.tagName==='SELECT'?'select':'input';});content.querySelectorAll('label').forEach(l=>{l.style.cssText='display:flex;flex-direction:column;gap:6px;margin:12px 0';});
    };
    dialog.append(select('产品',productId||data.products[0]?.project,data.products.map(p=>p.project),redraw),content,footer);dialog.querySelectorAll('select').forEach(s=>s.classList.add('select'));dialog.querySelectorAll('select:first-of-type option').forEach(o=>{if(productNames[o.value])o.textContent=productNames[o.value];});dialog.addEventListener('close',()=>dialog.remove());redraw(productId||data.products[0]?.project);dialog.showModal();
  }
  // Presentation only, scoped to the immutable release; task IDs and saved progress stay unchanged.
  const fieldTaskCopy={
    'baseline-review':['核对医院当前版本','核对现场各模块版本和数据库情况，确认以前的升级内容是否已执行。请联系运营确认后再升级，不要提前修改现场版本或补写执行记录。'],
    'runner-install':['准备更新环境和备份','核对各程序及页面的安装位置、停止启动和健康检查方式、两库连接及备份空间，保留医院现有配置。使用宿主更新器时须先完成安装；Java、Redis及容器镜像需另行核对。'],
    'dc42-mode':['确认采集任务启用方式','新采集任务保持禁用，先与医院确认 HIS 事件处理及出院延迟规则。确认后在定时扫描和事件触发两种方式中选一种，不能同时启用。'],
    'dc43-source':['按需配置输血数据采集','需要采集输血文书时，在数据源映射页面配置对应来源、RPA编号、完整性检查和文书分类。未经医院确认不要启用。'],
    'dc44-config':['按需配置患者签名核验','需要签名核验时，核对医院数据视图和验签服务地址，在现场填写账号凭据。未完成确认前保持禁用，不要把密码写入发布清单。'],
    'dc45-source-map':['配置非医嘱离院标记','先请 HIS 确认来源字段，再补齐源视图和映射设置。核对“是、否、未提供”三种情况；使用自定义落地表的医院还需按生成流程补充对应字段。'],
    'verify':['检查升级后的业务功能','核对全部页面及后台服务是否正常，检查病案列表标记和数据同步；按需测试采集及签名核验。保留实际安装和验证记录，再确认升级完成。'],
    'dc47-verify':['核验新增字段和原有数据','保留现有字段定义和数据，确认输血患者标识名称、申请单号字段、来源数据及实际数量正确。不要将处理状态或同步状态当成账号、死亡标记。'],
    'bms42-panels':['检查病案侧栏调整','检查左右侧栏默认宽度、鼠标拖拽、键盘调整及双击操作；刷新后宽度应保留，调整侧栏时病案预览不应重新加载。'],
    'death-flag-verify':['检查死亡标记同步','检查来源使用“是/否”、数字或真假值时能正确同步，未提供标记时不应清零。历史错误数据需另行审核范围，不要自动修改全部历史患者。'],
    'bms43-death-map':['配置死亡病案导出分类','保留医院原有分类，按医院确认结果逐项对应国家25类死亡病案分类。与非医嘱离院分类分别维护，不按名称批量猜测，也不覆盖未确认的分类。'],
    'bms43-nonmedical-map':['配置非医嘱离院导出分类','保留医院原有分类，按医院确认结果逐项对应国家25类非医嘱离院病案分类。与死亡病案分类分别维护，不按名称批量猜测，也不覆盖未确认的分类。'],
    'bms43-single-patient-verify':['检查两种专项病案导出','在单个患者的导出页面分别测试死亡、非医嘱离院导出：每类一个 PDF，多类打包，编号、名称和文书对应正确。检查分类未配置或文书无法合并时的处理，原有导出方式也应正常。'],
    'bms44-pdfjs-runtime-check':['检查病案预览文件完整','使用已核验完整的正式页面包，部署后检查预览页面及所需文件能够正常加载，并实际打开病案查看。不要复用此前缺少预览文件的测试包；技术检查方法见详细说明。'],
    'beitun-baseline':['保留医院配置，核对适用范围','已有现场核验结果仅供参考，其它医院仍需逐项核对。保留自定义接口、数据映射和任务配置，补齐本次通用字段；不要自动补改历史患者或导入演示数据、其它医院的分类映射。']
  };
  async function renderHospital(box,site,batchId,product,hooks={}) {
    const scrolls=[];for(let el=box;el;el=el.parentElement)scrolls.push([el,el.scrollLeft,el.scrollTop]);
    const active=document.activeElement,focusKey=box.contains(active)?active?.dataset.releaseFocus:null;
    const expanded=new Map([...box.querySelectorAll('details[data-release-detail]')].map(el=>[el.dataset.releaseDetail,el.open]));
    const minHeight=box.style.minHeight;box.style.minHeight=box.getBoundingClientRect().height+'px';
    try { await renderHospitalContent(box,site,batchId,product,hooks); }
    finally {
      box.querySelectorAll('details[data-release-detail]').forEach(el=>{if(expanded.has(el.dataset.releaseDetail))el.open=expanded.get(el.dataset.releaseDetail);});
      box.style.minHeight=minHeight;
      if(focusKey){const target=[...box.querySelectorAll('[data-release-focus]')].find(el=>el.dataset.releaseFocus===focusKey);target?.focus({preventScroll:true});}
      for(const [el,x,y]of scrolls){el.scrollLeft=x;el.scrollTop=y;}
    }
  }
  async function renderHospitalContent(box,site,batchId,product,hooks={}) {
    box.style.cssText+=';padding:16px;box-sizing:border-box;min-width:0;line-height:1.7;overflow-wrap:anywhere';const selected=box.dataset.releaseTab||'checklist';box.innerHTML='加载医院升级清单…';
    const query='?site='+encodeURIComponent(site)+'&batchId='+encodeURIComponent(batchId);
    const redraw=()=>renderHospital(box,site,batchId,product,hooks);
    let downloads=null,p=null,error='';
    try{downloads=await api('/api/field/release-downloads'+query);}catch(e){error=e.message;}
    if(downloads?.needsUpdate!==false)try{p=await api('/api/field/update-plan'+query);}catch(e){error=e.message;}
    box.replaceChildren();
    const tabs=document.createElement('div');tabs.setAttribute('role','tablist');tabs.className='f-tabs2';tabs.style.cssText='margin-bottom:16px;max-width:100%;box-sizing:border-box';
    const checklist=document.createElement('div'),files=document.createElement('div');checklist.setAttribute('role','tabpanel');files.setAttribute('role','tabpanel');
    const choose=id=>{box.dataset.releaseTab=id;checklist.hidden=id!=='checklist';files.hidden=id!=='files';tabs.querySelectorAll('button').forEach(b=>{const active=b.dataset.tab===id;b.setAttribute('aria-selected',String(active));b.classList.toggle('on',active);});};
    for(const [id,title]of [['checklist','更新清单'],['files','下载文件']]){const b=document.createElement('button');b.type='button';b.className='f-tab2';b.textContent=title;b.onclick=()=>choose(id);b.dataset.tab=id;b.setAttribute('role','tab');tabs.append(b);}box.append(tabs);
    const x=hooks.siteInfo;if(x)message(box,'当前现场：'+(siteVersion(x)||'版本待运营确认')+' · '+(x.deployment?.dbVendor||'数据库待确认')+' / '+(x.deployment?.platform||'部署待确认'));
    box.append(checklist,files);choose(selected);
    const link=(label,url)=>{const a=document.createElement('a');a.className='btn btn-sm';a.style.cssText='margin:4px 8px 4px 0';a.textContent=label;a.href=url;a.target='_blank';files.append(a);};
    if(downloads?.needsUpdate){message(files,'目标版本 '+downloads.version);link('下载更新包','/api/field/release-bundle'+query);files.querySelector('a').onclick=()=>{if(!files.querySelector('[data-bundle-status]')){const note=message(files,'正在准备更新包，首次准备可能需要稍等，请勿重复点击。文件开始下载后可在浏览器下载列表查看进度。');note.dataset.bundleStatus='true';note.setAttribute('role','status');}};message(files,'已按医院当前版本及部署环境配好程序和所需依赖。解压后只有“程序文件”和“升级SQL”两个目录，所需依赖已合并到程序文件中。');}
    const groups=p?.sqlGroups||downloads?.sqlGroups||[],tasks=p?.tasks||downloads?.tasks||[];
    if(downloads?.needsUpdate){
      message(files,'先备份数据库、程序及医院配置。程序文件/apps、程序文件/web 按现场安装目录更新；业务主程序已按启动脚本命名为固定名称（例如 datacenter.jar），停止对应服务后替换主程序和依赖，完成后重启；保留医院自己的配置。');
      message(files,'各模块依赖统一放在 lib。更新 pams-common 等内部组件前，请移除该组件的旧版本，避免同一组件多个版本同时加载；未随包提供的其他依赖请保留。');
      message(files,'升级SQL 中的 etl 文件在数据中心库执行，bms 文件在病案业务库执行。请在 Navicat 连接对应数据库，执行一次并查看结果，勿重复执行。');
      message(files,'下载不会标记执行成功。完成后回到更新清单确认各库 SQL、程序安装及业务验证。');
    }
    if(!p){message(checklist,downloads?(downloads.needsUpdate?'已合并现场版本之后需要处理的更新，无需逐个旧版本查看。':'医院已是目标版本，没有待升级事项。'):(error||'暂时无法读取更新清单，请联系运营核对医院版本及部署信息。'));if(downloads?.needsUpdate){message(checklist,downloads.fromVersion+' → '+downloads.version+' · 累计 '+downloads.versionsInRange.join('、'));if(downloads.baselineReviewRequired)message(checklist,'旧现场的历史执行情况需要核对。下面已包含首个规范版本起的全部已知更新，请核实已做事项和已执行 SQL，避免重复执行。');message(checklist,'做完一项勾选一项，系统会保存进度；勾选不会修改医院版本。');}}
    else {message(checklist,p.fromVersion+' → '+p.toVersion+' · 累计 '+p.versionsInRange.join('、'));if(p.baselineReviewRequired)message(checklist,'旧现场需核对历史版本及数据库；已保留本现场此前勾选进度，各库SQL仍须单独确认。');}
    let updateReady=()=>{};
    const summary=message(checklist,'配置任务 '+tasks.filter(t=>t.done).length+' / '+tasks.length+' 已完成');summary.style.fontWeight='600';
    const toggle=(label,done,kind,itemId,desc='',original='')=>{const row=document.createElement('label');row.style.cssText='display:flex;gap:10px;align-items:flex-start;margin:0;padding:16px 0;border-bottom:1px solid var(--color-border,#e5eaf0);line-height:1.8;overflow-wrap:anywhere';const cb=document.createElement('input');cb.type='checkbox';cb.checked=!!done;cb.disabled=p?.status==='completed';cb.style.marginTop='5px';cb.dataset.releaseFocus=kind+':'+itemId;cb.onchange=async()=>{const hadFocus=document.activeElement===cb;const restoreFocus=()=>{if(hadFocus&&document.activeElement===document.body)cb.focus({preventScroll:true});};const freezing=!!p&&!p.frozen;const frozenInputs=freezing?[...checklist.querySelectorAll('input')]:[];frozenInputs.forEach(el=>el.disabled=true);cb.disabled=true;try{if(freezing)await api('/api/field/update-start',{site,batchId});await api(p?'/api/field/update-toggle':'/api/field/release-task-toggle',{site,batchId,kind,itemId,done:cb.checked});
          const item=(kind==='task'?tasks:p?.sqlGroups||[]).find(t=>t.id===itemId);if(item)item.done=cb.checked;
          summary.textContent='配置任务 '+tasks.filter(t=>t.done).length+' / '+tasks.length+' 已完成';cb.disabled=false;restoreFocus();updateReady();
          if(freezing){cb.focus({preventScroll:true});await redraw();}}catch(e){alert(e.message);cb.checked=!cb.checked;cb.disabled=false;frozenInputs.forEach(el=>el.disabled=false);restoreFocus();}};const text=document.createElement('div');text.style.cssText='min-width:0;flex:1';const title=document.createElement('strong');title.textContent=label;text.append(title);if(desc){const d=document.createElement('div');d.textContent=desc;d.style.color='#667085';text.append(d);}row.append(cb,text);checklist.append(row);if(original){const details=document.createElement('details');details.dataset.releaseDetail=kind+':'+itemId;details.style.cssText='margin:4px 0 12px 24px;font-size:12px;color:var(--color-text-secondary,#667085)';const summary=document.createElement('summary');summary.textContent='查看详细说明';details.append(summary);message(details,original);checklist.append(details);}};
    tasks.forEach(t=>{const id=t.id.startsWith('1.5.26092901:')?t.id.slice('1.5.26092901:'.length):t.id;const copy=(t.version||downloads?.version)==='1.5.26092901'?fieldTaskCopy[id]:null;toggle((t.version?t.version+' · ':'')+(copy?.[0]||t.title),t.done,'task',t.id,copy?.[1]||t.desc,copy?t.desc:'');});
    if(!p){if(downloads?.needsUpdate){const guide=document.createElement('details'),s=document.createElement('summary');guide.dataset.releaseDetail='baseline-guide';s.textContent='首次升级前需要核对什么';guide.append(s);message(guide,'先备份数据库、程序和配置，逐项核对本页已累计的历史更新及已执行 SQL；只补做缺少的内容。安装并检查业务后，由运营核实医院版本。不要在升级前把现场版本改成新版本。');checklist.append(guide);}return;}
    if(p.status==='completed'){message(checklist,'升级已完成并回写现场版本 · '+p.completedAt);return;}
    if(!p.frozen){message(checklist,'首次勾选会保存本医院的升级清单，后续按此清单完成更新。');checklist.append(btn('确认并开始本次升级',async()=>{await api('/api/field/update-start',{site,batchId});await redraw();}));}
    p.sqlGroups.forEach(g=>toggle('已在 '+g.vendor+' / '+g.db+' 执行并核对 SQL',g.done,'sql',g.id));
    const confirmationKey=JSON.stringify([site,batchId,p.fromVersion,p.toVersion,p.environment]);
    const checks=box._releaseConfirmations?.key===confirmationKey?box._releaseConfirmations.checks:{applicationInstalled:!!p.receipt?.applicationInstalled,dependenciesInstalled:!p.dependencyRequired||!!p.receipt?.dependenciesInstalled,verified:false,baselineReviewed:false};box._releaseConfirmations={key:confirmationKey,checks};
    const confirmations=[...(p.baselineReviewRequired?[['baselineReviewed','已核对历史版本及数据库，确认累计清单中已做和待补做事项']]:[]),['applicationInstalled','确认全量程序已安装'],['dependenciesInstalled','确认目标依赖已安装/匹配'],['verified','确认现场业务验证通过']];
    for(const [key,label]of confirmations){const l=document.createElement('label');l.style.cssText='display:block;margin:10px 0';const c=document.createElement('input');c.type='checkbox';c.checked=checks[key];c.onchange=()=>{checks[key]=c.checked;updateReady();};l.append(c,document.createTextNode(' '+label));checklist.append(l);}
    const completeButton=btn('完成升级并回写医院版本',async()=>{await api('/api/field/update-complete',{site,batchId,...checks});if(hooks.onCompleted)await hooks.onCompleted();else await redraw();});checklist.append(completeButton);
    const readyHint=message(checklist,'');readyHint.setAttribute('role','status');
    updateReady=()=>{const missing=[];if(!p.frozen)missing.push('开始本次升级');if(tasks.some(t=>!t.done))missing.push('完成全部任务');if(p.sqlGroups.some(g=>!g.done))missing.push('确认各库SQL');if(p.baselineReviewRequired&&!checks.baselineReviewed)missing.push('核对历史版本及数据库');if(!checks.applicationInstalled)missing.push('确认程序安装');if(p.dependencyRequired&&!checks.dependenciesInstalled)missing.push('确认依赖安装');if(!checks.verified)missing.push('确认现场验证');completeButton.disabled=missing.length>0;readyHint.textContent=missing.length?'还需：'+missing.join('、'):'核验已齐全，可完成升级并回写医院版本。';};updateReady();
  }
  async function createRelease(onSaved) {
    try {
      const data=await api('/api/projects');const projects=Array.isArray(data)?data:(data.projects||[]);
      const dialog=document.createElement('dialog');dialog.style.cssText='padding:24px;border:1px solid #ccd;border-radius:12px;max-width:600px';document.body.append(dialog);
      message(dialog,'新建版本发布（可不关联工单）');const value={product:'',version:''};
      dialog.append(select('产品',value.product,projects.map(p=>p.id),v=>value.product=v),field('版本',value.version,v=>value.version=v),btn('创建',async()=>{await api('/api/batch-create-release',value);dialog.close();dialog.remove();await onSaved?.();}),btn('取消',()=>{dialog.close();dialog.remove();}));dialog.showModal();
    }catch(e){alert(e.message);}
  }
  return {renderBatch,renderHospital,createRelease,openAdminDeploymentSettings,siteVersion};
})();
