// BP-06: immutable release deltas and hospital-specific upgrade snapshots.
import fs from 'node:fs';
import { deliveryBundle } from './release-bundle.mjs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
export const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const vendors = ['mysql', 'postgresql'];
const platforms = ['docker', 'windows'];
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const str = v => String(v ?? '').trim();
export const published = b => !!b.releaseTime || ['可下载', '已交付'].includes(b.status);
export const isDelta = p => p?.schemaVersion === 2 && p.kind === 'delta';
function required(v, label, max = 200) { const s = str(v); if (!s || s.length > max) fail(label + '必填且不能超过 ' + max + ' 字符'); return s; }
export function normalizeDelta(raw) {
  const version = required(raw.version || raw.to, '版本', 60);
  const tag = required(raw.tag || version, 'tag', 100);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag) || tag.includes('..')) fail('tag 格式不合法');
  const tasks = [], sql = [], ids = new Set();
  if ((raw.tasks?.length || 0) > 300 || (raw.sql?.length || 0) > 300) fail('任务/SQL 超过 300 项');
  for (const t of raw.tasks || []) {
    const id = required(t.id, '任务 id', 160);
    if (ids.has(id)) fail('任务 id 重复: ' + id); ids.add(id);
    tasks.push({ id, title: required(t.title, '任务标题'), desc: str(t.desc), ...(t.module ? {module:str(t.module)} : {}) });
  }
  ids.clear();
  for (const s of raw.sql || []) {
    const id = required(s.id, 'migration id', 160);
    if (!vendors.includes(s.vendor) || !['bms', 'etl'].includes(s.db)) fail('SQL 必须指定 vendor(mysql/postgresql) 和 db(bms/etl)');
    const key = [s.vendor, id].join(':'); if (ids.has(key)) fail('SQL id 重复: ' + key); ids.add(key);
    const content = String(s.content ?? '');
    if (!content.trim() || Buffer.byteLength(content) > 5 * 1024 * 1024) fail('SQL 正文必填且不得超过 5 MiB');
    const checksum = sha256(content);
    if (s.checksum && s.checksum !== checksum) fail('SQL checksum 不匹配: ' + id);
    sql.push({ id, title: str(s.title || s.file || id), desc: str(s.desc), file: str(s.file), vendor: s.vendor, db: s.db, content, checksum });
  }
  const artifacts = (raw.artifacts || []).map(a => {
    if (!['application', 'dependencies'].includes(a.kind) || !platforms.includes(a.platform) || ![...vendors, 'any'].includes(a.dbVendor)) fail('产物 kind/platform/dbVendor 不合法');
    if (!/^[a-f0-9]{64}$/.test(a.sha256 || '') || !Number.isSafeInteger(a.size) || a.size <= 0) fail('产物必须提供 SHA256 和完整字节大小');
    if (!/^\/api\/release-artifact\?id=[a-f0-9]{64}$/.test(a.url || '')) fail('请先把应用/依赖包上传到 intake，再保存服务端返回的 url');
    const file=required(a.file,'产物文件名',240);if(/[\\/]/.test(file) || ['.','..'].includes(file))fail('产物文件名不能包含目录');
    return { kind:a.kind, platform:a.platform, dbVendor:a.dbVendor, file:str(a.file), url:a.url, sha256:a.sha256, size:a.size, modules: Array.isArray(a.modules) ? a.modules.map(String) : [] };
  });
  return { schemaVersion:2, kind:'delta', version, to:version, tag, commit:str(raw.commit), parentVersion:str(raw.parentVersion), dependencySetId:required(raw.dependencySetId, '依赖集合标识'), tasks, sql, artifacts };
}
export function currentVersion(product) {
  if (product.releaseVersion) return str(product.releaseVersion);
  if (Array.isArray(product.subsystems)) {
    const versions = product.subsystems.map(s => str(s.version));
    if (!versions.length || versions.some(v => !v) || new Set(versions).size !== 1) fail('医院子系统版本不一致或缺失，请先确认产品现场版本');
    return versions[0];
  }
  return required(product.version, '医院现场版本', 60);
}
function sqlToolsAttachment(dataDir,version,releaseCommit) {
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)||version.includes('..'))return null;
  const dir=path.join(dataDir,'release-attachments',version),metaPath=path.join(dir,'metadata.json');
  if(!fs.existsSync(metaPath))return null;
  const meta=JSON.parse(fs.readFileSync(metaPath,'utf8'));
  if(meta.version!==version || meta.releaseCommit!==releaseCommit || !/^[a-f0-9]{40}$/.test(meta.releaseCommit||'') || !/^[a-f0-9]{64}$/.test(meta.sha256||'') || meta.file!=='sql-tools.zip' || !Number.isSafeInteger(meta.size) || meta.size<=0)fail('SQL工具附件元信息不合法');
  const file=path.join(dir,meta.file);if(!fs.existsSync(file)||fs.statSync(file).size!==meta.size)fail('SQL工具附件未完整上传');
  return {...meta,filePath:file};
}
function groupedSql(sql) { return [...new Set(sql.map(s=>s.vendor+':'+s.db))].map(id=>({id,vendor:id.split(':')[0],db:id.split(':')[1],scriptCount:sql.filter(s=>s.vendor+':'+s.db===id).length})); }
function mergedSql(items, scope) {
  for(const s of items)if(sha256(s.content)!==s.checksum)fail('发布 SQL 校验失败: '+s.id);
  return '-- '+scope+'\n-- Execute only in the indicated vendor/database. Download is not execution confirmation.\n'+items.map(s=>'-- globalOrder='+s.globalOrder+' / '+s.version+' / '+s.id+' / '+s.vendor+'/'+s.db+' / SHA256 '+s.checksum+'\n'+s.content).join('\n\n');
}
export function releaseArtifactsForHospital(batch, customer) {
  if(!batch || !published(batch) || !isDelta(batch.deployPlan))fail('没有适用的已发布规范制品',403);
  const product=customer.products?.find(p=>p.project===batch.product);if(!product)fail('医院未安装该产品',403);
  const env=product.deployment||{};if(!vendors.includes(env.dbVendor)||!platforms.includes(env.platform))fail('请联系运营补录医院数据库类型和部署方式');
  const artifacts=batch.deployPlan.artifacts.filter(a=>a.platform===env.platform&&[env.dbVendor,'any'].includes(a.dbVendor));
  if(artifacts.filter(a=>a.kind==='application').length!==1||artifacts.filter(a=>a.kind==='dependencies').length!==1)fail('目标版本缺少唯一适用的应用或完整依赖包');
  return artifacts;
}
export function releaseNeedsDependencies(batches,customer,batch){
 const product=customer.products.find(p=>p.project===batch.product),env=product.deployment;
 const candidates=batches.filter(b=>b.product===batch.product&&b.pkgVersion===currentVersion(product)&&published(b)&&isDelta(b.deployPlan));
 if(candidates.length!==1)return true;
 const d=candidates[0].deployPlan,matching=d.artifacts.filter(a=>a.platform===env.platform&&[env.dbVendor,'any'].includes(a.dbVendor));
 return matching.filter(a=>a.kind==='application').length!==1||matching.filter(a=>a.kind==='dependencies').length!==1||!d.dependencySetId||d.dependencySetId!==batch.deployPlan.dependencySetId;
}
// A delivery scope is read-only. Legacy baselines never become synthetic installed releases.
export function deliveryScope(batches, customer, batchId) {
  const target=batches.find(b=>b.id===batchId);
  if(!target||!published(target)||!isDelta(target.deployPlan))fail('目标版本没有已发布的规范清单');
  const product=customer.products?.find(p=>p.project===target.product);if(!product)fail('该医院未安装此产品',403);
  const from=currentVersion(product),vendor=product.deployment?.dbVendor;
  if(!vendors.includes(vendor))fail('请联系运营补录医院数据库类型');
  const map=new Map();
  for(const b of batches.filter(b=>b.product===target.product&&published(b))){if(map.has(b.pkgVersion))fail('产品存在重复发布版本: '+b.pkgVersion);map.set(b.pkgVersion,b);}
  const chain=[],seen=new Set();let version=target.pkgVersion;
  while(version&&version!==from){
    if(seen.has(version))fail('发布链有循环');seen.add(version);
    const b=map.get(version);if(!b)fail('发布链缺少版本: '+version);
    if(!isDelta(b.deployPlan))fail('版本 '+version+' 不是规范增量，无法确认累计范围');
    chain.unshift(b);version=b.deployPlan.parentVersion;
  }
  const baselineReviewRequired=version!==from;
  if(baselineReviewRequired){
    if(isDelta(map.get(from)?.deployPlan))fail('现场版本不在目标发布链中');
    const first=chain[0]?.pkgVersion;
    if(!first||from.localeCompare(first,undefined,{numeric:true})>=0)fail('现场版本无法对应目标发布链，请先核对，禁止降级或遗漏中间更新');
  }
  const tasks=[],sql=[],migrations=new Map();
  for(const b of chain){
    for(const t of b.deployPlan.tasks)tasks.push({...t,id:b.pkgVersion+':'+t.id,sourceId:t.id,sourceBatchId:b.id,version:b.pkgVersion});
    for(const m of b.deployPlan.sql.filter(x=>x.vendor===vendor)){
      if(sha256(m.content)!==m.checksum)fail('发布 SQL 校验失败: '+m.id);
      const key=m.vendor+':'+m.id,identity=m.db+':'+m.checksum;
      if(migrations.has(key)){if(migrations.get(key)!==identity)fail('迁移 id 内容冲突: '+key);continue;}
      migrations.set(key,identity);sql.push({...m,version:b.pkgVersion,globalOrder:sql.length+1});
    }
  }
  const sources=chain.map(b=>({batchId:b.id,version:b.pkgVersion,checksum:sha256(JSON.stringify(b.deployPlan))}));
  const pending=customer.upgradePlans?.[batchId];
  if(pending?.status==='pending'&&(pending.fromVersion!==from||JSON.stringify(pending.environment)!==JSON.stringify(product.deployment)||JSON.stringify(pending.versionsInRange)!==JSON.stringify(chain.map(b=>b.pkgVersion))||JSON.stringify(pending.tasks.map(t=>t.id))!==JSON.stringify(tasks.map(t=>t.id))||JSON.stringify(pending.sql.map(m=>[m.vendor,m.id,m.db,m.checksum]))!==JSON.stringify(sql.map(m=>[m.vendor,m.id,m.db,m.checksum]))))fail('已冻结的升级计划与当前现场或发布范围不一致，请联系运营核对，不能自动替换',409);
  const progressContext={fromVersion:from,platform:product.deployment?.platform,dbVendor:vendor};
  return {progressContext,progressContextKey:sha256(JSON.stringify(progressContext)),fromVersion:from,toVersion:target.pkgVersion,versionsInRange:chain.map(b=>b.pkgVersion),baselineReviewRequired,chainAvailable:!baselineReviewRequired,needsUpdate:from!==target.pkgVersion,tasks,sql,sources,scopeHash:sha256(JSON.stringify({from,to:target.pkgVersion,vendor,sources}))};
}
export function deliveryTaskProgress(scope, batches, customer) {
  return scope.tasks.map(t=>{const source=batches.find(b=>b.id===t.sourceBatchId),r=customer.releaseChecklists?.[t.sourceBatchId];const valid=r&&r.version===source.pkgVersion&&r.commit===source.deployPlan.commit&&r.product===source.product;const progress=valid?r.contexts?.[scope.progressContextKey]?.tasks?.[t.sourceId]:null;return {...t,...progress,done:!!progress?.done};});
}
export function deliverySqlFiles(scope) {
  return groupedSql(scope.sql).map(g=>({file:'升级SQL/'+g.vendor+'-'+g.db+'.sql',content:mergedSql(scope.sql.filter(s=>s.vendor===g.vendor&&s.db===g.db),'CUMULATIVE DELIVERY '+scope.fromVersion+' -> '+scope.toVersion+(scope.baselineReviewRequired?'; LEGACY BASELINE REVIEW REQUIRED':''))}));
}
export function buildPlan(batches, customer, batchId) {
  const target = batches.find(b => b.id === batchId);
  if (!target || !published(target)) fail('目标批次未发布');
  const product = customer.products?.find(p => p.project === target.product);
  if (!product) fail('该医院未安装此产品', 403);
  const env = product.deployment || {};
  if (!vendors.includes(env.dbVendor) || !platforms.includes(env.platform)) fail('请补录医院数据库类型和部署方式');
  const from = currentVersion(product);
  if (from === target.pkgVersion) fail('医院已是目标版本');
  const scope=deliveryScope(batches,customer,batchId);
  const chain=scope.sources.map(s=>batches.find(b=>b.id===s.batchId));
  const d = target.deployPlan;
  const matching = d.artifacts.filter(a => a.platform === env.platform && [env.dbVendor, 'any'].includes(a.dbVendor));
  const apps = matching.filter(a => a.kind === 'application');
  if (apps.length !== 1) fail('目标版本缺少唯一适用的全量应用包');
  const libs = matching.filter(a => a.kind === 'dependencies');
  // Dependencies belong to published releases, never an operator-supplied hospital value.
  const dependencyRequired = releaseNeedsDependencies(batches,customer,target);

  if (dependencyRequired && libs.length !== 1) fail('跨版升级需要目标版本完整依赖包');
  const tasks = [], sql = [], migrations = new Map();
  for (const b of chain) {
    for (const t of b.deployPlan.tasks) tasks.push({...t, id:b.pkgVersion + ':' + t.id, version:b.pkgVersion});
    for (const s of b.deployPlan.sql.filter(s => s.vendor === env.dbVendor)) {
      if (sha256(s.content) !== s.checksum) fail('发布 SQL 校验失败: ' + s.id);
      const key = [s.vendor,s.id].join(':');
      if (migrations.has(key)) { if (migrations.get(key) !== s.db+':'+s.checksum) fail('迁移 id 内容冲突: ' + key); continue; }
      migrations.set(key,s.db+':'+s.checksum); sql.push({...s, version:b.pkgVersion, progressId:key});
    }
  }
  return { schemaVersion:2, site:customer.name, id:crypto.randomUUID(), batchId, product:target.product, fromVersion:from, toVersion:target.pkgVersion, environment:structuredClone(env), dependencySetId:d.dependencySetId, dependencyRequired, artifacts:[...apps,...(dependencyRequired ? libs : [])], versionsInRange:chain.map(b => b.pkgVersion), sources:chain.map(b=>({batchId:b.id,version:b.pkgVersion,checksum:sha256(JSON.stringify(b.deployPlan))})), tasks, sql, baselineReviewRequired:scope.baselineReviewRequired, progress:{tasks:Object.fromEntries(deliveryTaskProgress(scope,batches,customer).filter(t=>t.done).map(t=>[t.id,{done:true,by:t.by,at:t.at,source:'release-checklist'}])),sql:{}}, status:'pending' };
}
export function publicPlan(p) {
  const tasks = p.tasks.map(t => ({...t,...p.progress.tasks[t.id]}));
  const groups = [...new Set(p.sql.map(s => s.vendor + ':' + s.db))].map(id => {
    const items = p.sql.filter(s => s.vendor + ':' + s.db === id);
    return {id, vendor:items[0].vendor,db:items[0].db,scriptCount:items.length,...p.progress.sql[id]};
  });
  return {...p, tasks, sqlItems:p.sql, sqlGroups:groups, sql:{hasSql:!!p.sql.length,scriptCount:p.sql.length,done:groups.every(g=>g.done)}, taskTotal:tasks.length,taskDone:tasks.filter(t=>t.done).length};
}
export function completePlan(p, product, confirmations, by, at, projectDefinition) {
  if (p.status === 'completed') return false;
  if (currentVersion(product) !== p.fromVersion || JSON.stringify(product.deployment || {}) !== JSON.stringify(p.environment)) fail('现场版本或部署环境已变化，请重新核对升级计划',409);
  if(p.baselineReviewRequired&&confirmations.baselineReviewed!==true)fail('请先确认已核对历史版本及数据库');
  const view = publicPlan(p);
  if (view.taskDone !== view.taskTotal || !view.sql.done) fail('配置任务及各库 SQL 尚未全部确认');
  if (confirmations.applicationInstalled !== true || confirmations.verified !== true || (p.dependencyRequired && confirmations.dependenciesInstalled !== true)) fail('必须确认程序安装、所需依赖安装和现场验证完成');
  product.releaseVersion = p.toVersion;
  if (Array.isArray(product.subsystems)) {
    const modules = new Set(p.artifacts.filter(a=>a.kind==='application').flatMap(a=>a.modules).map(m=>typeof m==='string'?m:m.name));
    // Whole product version is confirmed separately; never invent subsystem mappings.
    const defined=projectDefinition?.subsystems || [];
    const sole=defined.length===1 && product.subsystems.length===1 && defined[0].name===product.subsystems[0].name;
    for (const s of product.subsystems) if (sole || modules.has(s.name)) s.version = p.toVersion;
  } else product.version = p.toVersion;
  product.deployment = {...product.deployment,dependencySetId:p.dependencySetId};
  p.status='completed'; p.completedAt=at; p.completedBy=by; p.confirmations=confirmations;
  return true;
}
export function readTaggedDelta(project, version, requestedTag) {
  const repos = [...new Set([project?.repoPath,...(project?.subsystems || []).map(s=>s.repoPath)].filter(Boolean))];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(version)) fail('版本格式不合法');
  for (const repo of repos) {
    const run = args => { const r=spawnSync('git',['-C',repo,...args],{encoding:'utf8',maxBuffer:20*1024*1024}); return r.status===0 ? r.stdout : null; };
    const tag = requestedTag || version;
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(tag) || tag.includes('..')) fail('tag 格式不合法');
    let actualTag=tag;
    let commit = run(['rev-parse','--verify','refs/tags/'+actualTag+'^{commit}']);
    if (!commit && !requestedTag) { actualTag='v'+version;commit=run(['rev-parse','--verify','refs/tags/'+actualTag+'^{commit}']); }
    if (!commit) continue;
    const text = run(['show',str(commit)+':deploy/releases/'+version+'.json']) || run(['show',str(commit)+':docs/deploy/'+version+'.json']); if (!text) continue;
    const raw=JSON.parse(text); if (raw.version!==version || (raw.tag && raw.tag!==actualTag)) fail('清单版本/tag 与批次不一致');
    raw.tag=actualTag; raw.commit=str(commit);
    for (const s of raw.sql || []) if (s.file) {
      if (path.isAbsolute(s.file) || s.file.split('/').includes('..')) fail('SQL 路径必须位于仓内');
      const content=run(['show',raw.commit+':'+s.file]); if (content===null) fail('tag 中 SQL 文件缺失: '+s.file); s.content=content;
    }
    return raw;
  }
  fail('未找到对应 tag 中的 docs/deploy/'+version+'.json');
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try { fs.writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});fs.renameSync(temp,file); }
  finally { if(fs.existsSync(temp)) fs.unlinkSync(temp); }
}

const routes = new Set(['/api/batch-create-release','/api/batch-deploy-draft','/api/batch-deploy-save','/api/release-artifact-upload','/api/release-artifact','/api/field/release-options','/api/field/release-downloads','/api/field/release-bundle','/api/field/release-task-toggle','/api/field/release-sql-merged','/api/field/release-sql-tools','/api/field/deployment-save','/api/customer-deployment-save','/api/field/update-plan','/api/field/update-start','/api/field/update-toggle','/api/field/update-complete','/api/field/update-sql-merged','/api/field/update-plan-export','/api/field/update-receipt']);
export const handlesReleaseRoute = pathname => routes.has(pathname);
async function jsonBody(req) {
  const chunks=[];let size=0;
  for await (const chunk of req) { size+=chunk.length;if(size>20*1024*1024) fail('请求体超过 20 MiB',413);chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { fail('JSON 格式不合法'); }
}
export async function handleReleaseRoute(req,res,url,user,ctx) {
  const reply=(value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
  try {
    if(!user) fail('请登录',401);
    const admin=ctx.isAdmin(user), endpoint=url.pathname;
    if(endpoint==='/api/field/deployment-save')fail('现场信息仅允许运营后台维护',403);
    if(endpoint==='/api/customer-deployment-save'&&!admin)fail('现场信息仅允许运营后台维护',403);
    const readRoutes=new Set(['/api/batch-deploy-draft','/api/release-artifact','/api/field/release-options','/api/field/release-downloads','/api/field/release-bundle','/api/field/release-sql-merged','/api/field/release-sql-tools','/api/field/update-plan','/api/field/update-plan-export','/api/field/update-sql-merged']);
    if(req.method!==(readRoutes.has(endpoint)?'GET':'POST'))fail('method not allowed',405);
    const body=req.method==='POST' ? (endpoint==='/api/release-artifact-upload' ? null : await jsonBody(req)) : {};
    const site=str(body?.site || url.searchParams.get('site'));
    const batchId=str(body?.batchId || url.searchParams.get('batchId'));
    const by=user.username || user.name, at=new Date().toISOString();
    const customers=ctx.loadCustomers(), batches=ctx.loadBatches();
    const customer=customers.find(c=>c.name===site);
    const batch=batches.find(b=>b.id===batchId);
    const assertSite=()=>{if(!customer) fail('医院不存在');if(!admin && !user.sites?.includes(site)) fail('无权操作此医院',403);};
    const assertProduct=product=>{if(!admin && user.projects?.length && !user.projects.includes(product)) fail('无权操作此产品',403);};
    const assertBatch=()=>{if(!batch) fail('批次不存在',404);assertProduct(batch.product);};
    const saveCustomers=()=>atomicJson(path.join(ctx.dataDir,'customers.json'),{customers});
    const artifactDir=path.join(ctx.dataDir,'release-artifacts');
    if(endpoint==='/api/batch-create-release') {
      if(!admin)fail('仅管理员可以建批',403);
      const project=ctx.projById(str(body.product));if(!project)fail('请选择有效产品');
      const version=required(body.version,'版本',60);
      if(batches.some(b=>b.product===project.id&&b.pkgVersion===version))fail('此产品版本已有批次',409);
      const seq=Math.max(0,...batches.map(b=>Number(/^B-(\d+)$/.exec(b.id)?.[1]||0)))+1;
      const item={id:'B-'+String(seq).padStart(2,'0'),product:project.id,pkgVersion:version,status:'开发中',ticketIds:[],createdAt:at,downloads:0,history:[{action:'create-release',by,at,note:'创建独立版本发布'}]};
      batches.push(item);ctx.saveBatches(batches);return reply({ok:true,item});
    }
    if(endpoint==='/api/release-artifact-upload') {
      if(!admin) fail('仅管理员可以上传',403);
      if(req.method!=='POST') fail('method not allowed',405);
      const max=Number(process.env.INTAKE_ARTIFACT_MAX_BYTES || 4*1024*1024*1024);
      if(Number(req.headers['content-length'] || 0)>max) fail('文件超过上传上限',413);
      fs.mkdirSync(artifactDir,{recursive:true});
      const temp=path.join(artifactDir,'.upload-'+crypto.randomUUID());let size=0;const hash=crypto.createHash('sha256');
      try {
        await pipeline(req,new Transform({transform(chunk,enc,cb){size+=chunk.length;if(size>max)return cb(new Error('文件超过上传上限'));hash.update(chunk);cb(null,chunk);}}),fs.createWriteStream(temp,{flags:'wx',mode:0o600}));
        if(!size) fail('空文件');
        const id=hash.digest('hex');const dest=path.join(artifactDir,id);
        if(fs.existsSync(dest)) fs.unlinkSync(temp);else fs.renameSync(temp,dest);
        return reply({ok:true,artifact:{url:'/api/release-artifact?id='+id,sha256:id,size,file:path.basename(str(url.searchParams.get('name') || 'package.zip'))}});
      } finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
    }
    if(endpoint==='/api/release-artifact') {
      const id=str(url.searchParams.get('id'));if(!/^[a-f0-9]{64}$/.test(id))fail('文件 id 不合法');
      if(!admin) {
        assertSite();assertBatch();
        const allowed=releaseArtifactsForHospital(batch,customer);
        if(!allowed.some(a=>a.sha256===id)) fail('该文件不属于此医院适用的已发布制品',403);
      }
      const file=path.join(artifactDir,id);if(!fs.existsSync(file))fail('文件不存在',404);
      const name=customer?.upgradePlans?.[batchId]?.artifacts.find(a=>a.sha256===id)?.file || batch?.deployPlan?.artifacts.find(a=>a.sha256===id)?.file || id+'.zip';
      res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Length':fs.statSync(file).size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(path.basename(name)),'ETag':'"'+id+'"'});
      await pipeline(fs.createReadStream(file),res);return;
    }
    if(endpoint==='/api/field/release-sql-tools') {
      assertSite();assertBatch();releaseArtifactsForHospital(batch,customer);const meta=sqlToolsAttachment(ctx.dataDir,batch.pkgVersion,batch.deployPlan.commit);if(!meta)fail('SQL执行工具尚未就绪',404);
      if(hashFile(meta.filePath)!==meta.sha256)fail('SQL工具附件校验失败');
      res.writeHead(200,{'Content-Type':'application/zip','Content-Length':meta.size,'Content-Disposition':'attachment; filename="pams-'+batch.pkgVersion+'-sql-tools.zip"','ETag':'"'+meta.sha256+'"'});await pipeline(fs.createReadStream(meta.filePath),res);return;
    }
    if(endpoint==='/api/field/release-bundle'){
      assertSite();assertBatch();const artifacts=releaseArtifactsForHospital(batch,customer),env=customer.products.find(p=>p.project===batch.product).deployment;
      const scope=deliveryScope(batches,customer,batchId);if(!scope.needsUpdate)fail('医院已是目标版本');
      const needed=releaseNeedsDependencies(batches,customer,batch);const bundle=await deliveryBundle(ctx.dataDir,{version:batch.pkgVersion,commit:batch.deployPlan.commit,platform:env.platform,dbVendor:env.dbVendor,scope:{fromVersion:scope.fromVersion,versionsInRange:scope.versionsInRange,baselineReviewRequired:scope.baselineReviewRequired,scopeHash:scope.scopeHash}},artifacts.filter(a=>a.kind==='application'||needed),deliverySqlFiles(scope));
      res.writeHead(200,{'Content-Type':'application/zip','Content-Length':bundle.size,'Content-Disposition':"attachment; filename*=UTF-8''"+encodeURIComponent('pams-'+batch.pkgVersion+'-'+env.platform+'-'+env.dbVendor+'-update.zip')});await pipeline(fs.createReadStream(bundle.file),res);return;
    }
    if(endpoint==='/api/field/release-task-toggle') {
      assertSite();assertBatch();releaseArtifactsForHospital(batch,customer);
      if(typeof body.done!=='boolean')fail('任务状态必须为布尔值');
      const scope=deliveryScope(batches,customer,batchId),task=scope.tasks.find(t=>t.id===body.itemId);if(!task)fail('任务不属于当前累计范围，请刷新页面',409);
      const source=batches.find(b=>b.id===task.sourceBatchId),prior=customer.releaseChecklists?.[source.id];
      if(prior&&(prior.version!==source.pkgVersion||prior.commit!==source.deployPlan.commit||prior.product!==source.product))fail('发布清单已变更，请联系运营核实原记录',409);
      const record=prior||{product:source.product,version:source.pkgVersion,commit:source.deployPlan.commit,tasks:{},history:[]};
      const progress=(record.contexts ||= {})[scope.progressContextKey] ||= {...scope.progressContext,tasks:{},history:[]};
      if(progress.tasks[task.sourceId]?.done!==body.done){progress.tasks[task.sourceId]={done:body.done,by,at};progress.history.push({itemId:task.sourceId,done:body.done,by,at});}
      (customer.releaseChecklists ||= {})[source.id]=record;saveCustomers();return reply({ok:true});
    }
    if(endpoint==='/api/field/release-downloads'||endpoint==='/api/field/release-sql-merged') {
      assertSite();assertBatch();const artifacts=releaseArtifactsForHospital(batch,customer),scope=deliveryScope(batches,customer,batchId);
      if(endpoint==='/api/field/release-sql-merged'){
        const group=str(url.searchParams.get('group')),items=scope.sql.filter(s=>s.vendor+':'+s.db===group);if(!items.length)fail('请选择有效的数据库分组');
        const text=mergedSql(items,'CUMULATIVE DELIVERY '+scope.fromVersion+' -> '+scope.toVersion+(scope.baselineReviewRequired?'; LEGACY BASELINE REVIEW REQUIRED':''));
        res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="cumulative-'+group.replace(':','-')+'.sql"'});return res.end(text);
      }
      return reply({ok:true,version:batch.pkgVersion,fromVersion:scope.fromVersion,versionsInRange:scope.versionsInRange,scopeHash:scope.scopeHash,baselineReviewRequired:scope.baselineReviewRequired,needsUpdate:scope.needsUpdate,dependencyRequired:releaseNeedsDependencies(batches,customer,batch),chainAvailable:scope.chainAvailable,tasks:deliveryTaskProgress(scope,batches,customer),sqlGroups:groupedSql(scope.sql),artifacts:artifacts.filter(a=>a.kind==='application'||releaseNeedsDependencies(batches,customer,batch))});
    }
    if(endpoint==='/api/batch-deploy-draft' || endpoint==='/api/batch-deploy-save') {
      if(!admin)fail('仅管理员可以编辑发布',403);assertBatch();
      if(endpoint.endsWith('draft')) {
        let draft=null,error='';try{draft=readTaggedDelta(ctx.projById(batch.product),str(batch.pkgVersion),batch.deployPlan?.tag);}catch(e){error=e.message;}
        return reply({ok:true,draft,saved:batch.deployPlan||null,locked:published(batch),error});
      }
      if(published(batch))fail('已发布批次不可修改；请新建版本',409);
      if(ctx.isPublishing?.(batch.product))fail('此产品正在发布',409);
      const delta=normalizeDelta({...body,version:batch.pkgVersion || body.version});
      if(body.legacyConverted!==true && batch.deployPlan && !isDelta(batch.deployPlan))fail('旧跨版快照不能直接当增量保存；请确认逐项转换为本版增量');
      const prior=batch.deployPlan;
      const unchanged=isDelta(prior) && JSON.stringify(normalizeDelta(prior))===JSON.stringify(delta);
      const review=body.asDraft===true
        ? (unchanged && prior.reviewedAt ? {reviewedBy:prior.reviewedBy,reviewedAt:prior.reviewedAt} : {reviewedBy:'',reviewedAt:''})
        : {reviewedBy:by,reviewedAt:at};
      batch.pkgVersion=delta.version;batch.deployPlan={...delta,...review,stagedBy:by,stagedAt:at};
      (batch.history ||= []).push({action:body.asDraft===true?'deploy-draft':'deploy-review',by,at,note:(body.asDraft===true?'登记本版待审核清单 ':'审核本版增量 ')+delta.version});
      ctx.saveBatches(batches);return reply({ok:true,deployPlan:batch.deployPlan});
    }
    assertSite();
    if(endpoint==='/api/field/release-options') {
      const products=customer.products || [];
      const releases=batches.filter(b=>published(b)&&products.some(p=>p.project===b.product)&& (admin || !user.projects?.length || user.projects.includes(b.product))).map(b=>({batchId:b.id,product:b.product,version:b.pkgVersion,legacy:!isDelta(b.deployPlan)}));
      return reply({ok:true,products,releases});
    }
    if(endpoint==='/api/customer-deployment-save') {
      if(req.method!=='POST')fail('method not allowed',405);
      const product=customer.products?.find(p=>p.project===body.product);if(!product)fail('医院未安装该产品');assertProduct(body.product);
      if(Object.values(customer.upgradePlans || {}).some(p=>p.product===body.product&&p.status==='pending'))fail('此产品有未完成升级计划，不能改环境',409);
      if(!vendors.includes(body.dbVendor) || !platforms.includes(body.platform))fail('请选择数据库类型和部署方式');
      const version=currentVersion(product);
      product.deployment={...product.deployment,dbVendor:body.dbVendor,platform:body.platform};
      (customer.versionLog ||= []).push({productId:body.product,toVer:version,by,at,note:'运营维护部署环境（现场版本未修改）'});saveCustomers();return reply({ok:true});
    }
    assertBatch();
    if(!customer.products?.some(p=>p.project===batch.product))fail('医院未安装此产品',403);
    let plan=customer.upgradePlans?.[batchId];
    if(endpoint==='/api/field/update-plan') {
      if(!plan) plan=buildPlan(batches,customer,batchId);
      return reply({ok:true,...publicPlan(plan),frozen:!!customer.upgradePlans?.[batchId]});
    }
    if(endpoint==='/api/field/update-start') {
      if(req.method!=='POST')fail('method not allowed',405);
      if(!plan) {
        if(Object.values(customer.upgradePlans || {}).some(p=>p.product===batch.product&&p.status==='pending'))fail('此产品已有未完成升级计划',409);
        plan=buildPlan(batches,customer,batchId);plan.createdBy=by;plan.createdAt=at;
        (customer.upgradePlans ||= {})[batchId]=plan;saveCustomers();
      }
      return reply({ok:true,...publicPlan(plan),frozen:true});
    }
    if(endpoint==='/api/field/update-sql-merged') {
      if(!plan)plan=buildPlan(batches,customer,batchId);
      plan={...plan,sql:plan.sql.map((s,i)=>({...s,globalOrder:i+1}))};
      const group=str(url.searchParams.get('group'));
      const items=plan.sql.filter(s=>s.vendor+':'+s.db===group);if(!items.length)fail('请选择有效的数据库分组');
      const text=mergedSql(items,'CUMULATIVE DELIVERY '+plan.fromVersion+' -> '+plan.toVersion+(plan.baselineReviewRequired?'; LEGACY BASELINE REVIEW REQUIRED':''));
      res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8','Content-Disposition':'attachment; filename="'+group.replace(':','-')+'.sql"'});return res.end(text);
    }
    if(!plan)fail('请先创建并冻结医院升级计划',409);
    if(endpoint==='/api/field/update-plan-export') {
      res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Content-Disposition':'attachment; filename="plan.json"'});return res.end(JSON.stringify(plan,null,2));
    }
    if(endpoint==='/api/field/update-toggle') {
      if(req.method!=='POST')fail('method not allowed',405);
      if(plan.status==='completed')fail('已完成计划不可修改',409);
      const itemId=str(body.itemId);
      const kind=body.kind;
      if(kind==='task') {if(!plan.tasks.some(t=>t.id===itemId))fail('任务不存在');}
      else if(kind==='sql') {if(!plan.sql.some(s=>s.vendor+':'+s.db===itemId))fail('SQL 分组不存在');}
      else fail('kind 不合法');
      plan.progress[kind==='task'?'tasks':'sql'][itemId]={done:body.done===true,by,at};saveCustomers();return reply({ok:true});
    }
    if(endpoint==='/api/field/update-receipt') {
      if(req.method!=='POST')fail('method not allowed',405);
      if(plan.status==='completed')fail('已完成计划不可修改',409);
      const r=body.receipt;
      if(!r || r.schemaVersion!==2 || r.planId!==plan.id || r.site!==site || r.product!==plan.product || r.fromVersion!==plan.fromVersion || r.toVersion!==plan.toVersion || r.dependencySetId!==plan.dependencySetId)fail('执行回执与本医院计划不匹配');
      if(r.result!=='success' || r.applicationInstalled!==true || (plan.dependencyRequired && r.dependenciesInstalled!==true))fail('执行回执未成功安装，不能确认升级');
      for(const a of plan.artifacts)if(!r.artifacts?.some(x=>x.kind===a.kind&&x.sha256===a.sha256))fail('回执缺少正确的制品校验值');
      for(const s of plan.sql)if(!r.migrations?.some(m=>m.id===s.id&&m.vendor===s.vendor&&m.db===s.db&&m.checksum===s.checksum&&m.status==='success'))fail('回执缺少成功的迁移: '+s.id);
      plan.receipt={...r,importedBy:by,importedAt:at};
      for(const group of publicPlan(plan).sqlGroups)plan.progress.sql[group.id]={done:true,by,at,source:'receipt'};
      saveCustomers();return reply({ok:true});
    }
    if(endpoint==='/api/field/update-complete') {
      if(req.method!=='POST')fail('method not allowed',405);
      const product=customer.products.find(p=>p.project===batch.product);
      if(plan.status!=='completed')deliveryScope(batches,customer,batchId);
      const changed=completePlan(plan,product,body,by,at,ctx.projById(batch.product));
      if(changed){(customer.versionLog ||= []).push({productId:batch.product,fromVer:plan.fromVersion,toVer:plan.toVersion,by,at,batch:batchId,planId:plan.id});saveCustomers();}
      await ctx.onPlanCompleted?.(batch,site,by,at);
      return reply({ok:true,changed,status:plan.status,toVersion:plan.toVersion});
    }
    fail('method not allowed',405);
  } catch(e) {if(!res.headersSent)reply({ok:false,error:e.message},e.status||400);else res.destroy();}
}


export function validateReleaseChain(delta,batches,product) {
  const ordered=batches.filter(b=>b.product===product&&published(b)).sort((a,b)=>a.pkgVersion.localeCompare(b.pkgVersion,undefined,{numeric:true}));
  const latest=ordered.at(-1);
  if(latest && delta.version.localeCompare(latest.pkgVersion,undefined,{numeric:true})<=0)fail('新版本必须大于当前已发布版本');
  const previousV2=ordered.filter(b=>isDelta(b.deployPlan)).at(-1);
  if(previousV2 && previousV2.pkgVersion!==delta.parentVersion)fail('前驱版本必须为当前最新规范版本 '+previousV2.pkgVersion);
  if(!previousV2 && latest && delta.parentVersion)fail('首个规范版本应以空前驱建立基线，不能把历史快照当作规范增量');
}

export function validatePublication(batch,batches,project,dataDir) {
  if(published(batch))fail('已发布批次不可修改',409);
  const d=batch.deployPlan;if(!isDelta(d))fail('请先保存本版 v2 增量清单');
  if(!d.reviewedAt)fail('请先人工审核本版增量清单');
  if(d.version!==batch.pkgVersion)fail('清单版本/tag 与发布版本不一致');
  if(batches.some(b=>b.id!==batch.id&&b.product===batch.product&&published(b)&&b.pkgVersion===batch.pkgVersion))fail('产品版本已发布',409);
  const tagged=readTaggedDelta(project,d.version,d.tag);
  if(d.commit && d.commit!==tagged.commit)fail('tag 已移动或清单 commit 不匹配');
  const source=normalizeDelta({...tagged,dependencySetId:tagged.dependencySetId || d.dependencySetId,artifacts:[]});
  const comparable=x=>JSON.stringify({parentVersion:x.parentVersion,tasks:x.tasks,sql:x.sql});
  if(comparable(source)!==comparable(d))fail('已审核增量与 tag 中源清单不一致，请先修订代码并重新打版本');
  if(tagged.dependencySetId && tagged.dependencySetId!==d.dependencySetId)fail('依赖集合与源清单不一致');
  validateReleaseChain(d,batches,batch.product);
  if(d.parentVersion===d.version)fail('前驱版本不能是自己');
  if(!d.artifacts.length)fail('请上传完整应用和依赖包');
  for(const a of d.artifacts) {
    const file=path.join(dataDir,'release-artifacts',a.sha256);
    if(!fs.existsSync(file) || fs.statSync(file).size!==a.size)fail('已上传产物缺失或大小不匹配');
    if(hashFile(file)!==a.sha256)fail('产物 SHA256 校验失败');
    const manifest=readZipManifest(file);
    const release=manifest.release || {};const artifact=manifest.artifact || {};
    if((tagged.product && manifest.product!==tagged.product) || manifest.kind!==a.kind || release.version!==d.version || release.tag!==d.tag || release.commit!==tagged.commit || artifact.platform!==a.platform || artifact.dbVendor!==a.dbVendor || artifact.dependencySetId!==d.dependencySetId)fail('ZIP 内 manifest 与发布版本/平台/依赖信息不一致');
    if(JSON.stringify((artifact.modules || []).map(m=>typeof m==='string'?m:m.name).sort())!==JSON.stringify([...a.modules].sort()))fail('ZIP 内模块清单与构建清单不一致');
  }
  for(const platform of new Set(d.artifacts.map(a=>a.platform))) {
    if(!d.artifacts.some(a=>a.platform===platform&&a.kind==='application') || !d.artifacts.some(a=>a.platform===platform&&a.kind==='dependencies'))fail('每个平台须提供完整 application 和 dependencies');
  }
  d.commit=tagged.commit;
  return d;
}

// Read only bounded central directory + manifest, never inflate application payloads.
export function readZipManifest(file) {
  const fd=fs.openSync(file,'r');
  const read=(size,offset)=>{const b=Buffer.alloc(size);if(fs.readSync(fd,b,0,size,offset)!==size)fail('ZIP 文件不完整');return b;};
  try {
    const size=fs.fstatSync(fd).size;if(size<22)fail('应用包必须是包含 manifest.json 的 ZIP');
    const tail=read(Math.min(size,65557),Math.max(0,size-65557));let eocd=-1;
    for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50 && i+22+tail.readUInt16LE(i+20)===tail.length){eocd=i;break;}
    if(eocd<0)fail('ZIP 中央目录缺失');
    if(tail.readUInt16LE(eocd+4)!==0 || tail.readUInt16LE(eocd+6)!==0)fail('不支持分卷 ZIP');
    const centralSize=tail.readUInt32LE(eocd+12),centralOffset=tail.readUInt32LE(eocd+16);
    if(centralSize>16*1024*1024 || centralOffset+centralSize>size || centralOffset===0xffffffff)fail('ZIP 中央目录不合法或过大');
    const central=read(centralSize,centralOffset);let pos=0,found=null;
    while(pos<central.length){
      if(pos+46>central.length || central.readUInt32LE(pos)!==0x02014b50)fail('ZIP 中央目录格式错误');
      const nl=central.readUInt16LE(pos+28),el=central.readUInt16LE(pos+30),cl=central.readUInt16LE(pos+32);const next=pos+46+nl+el+cl;if(next>central.length)fail('ZIP 条目越界');
      const name=central.subarray(pos+46,pos+46+nl).toString('utf8');
      if(name==='manifest.json'){
        if(found)fail('ZIP 中 manifest.json 重复');
        if(central.readUInt16LE(pos+8)&1)fail('manifest.json 不得加密');
        found={method:central.readUInt16LE(pos+10),compressed:central.readUInt32LE(pos+20),uncompressed:central.readUInt32LE(pos+24),offset:central.readUInt32LE(pos+42)};
      }pos=next;
    }
    if(!found || found.compressed>1024*1024 || found.uncompressed>1024*1024)fail('ZIP 缺少有效 manifest.json 或超过 1 MiB');
    const local=read(30,found.offset);if(local.readUInt32LE(0)!==0x04034b50)fail('ZIP manifest 位置错误');
    const start=found.offset+30+local.readUInt16LE(26)+local.readUInt16LE(28);if(start+found.compressed>centralOffset)fail('ZIP manifest 越界');
    const content=read(found.compressed,start);
    const result=found.method===0?content:found.method===8?inflateRawSync(content,{maxOutputLength:1024*1024}):null;
    if(!result || result.length!==found.uncompressed)fail('ZIP manifest 压缩格式错误');
    return JSON.parse(result.toString('utf8'));
  } finally {fs.closeSync(fd);}
}
function hashFile(file) {const fd=fs.openSync(file,'r'),buffer=Buffer.alloc(1024*1024),hash=crypto.createHash('sha256');try{let n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))>0)hash.update(buffer.subarray(0,n));return hash.digest('hex');}finally{fs.closeSync(fd);}}
