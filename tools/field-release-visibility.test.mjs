import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { showReleaseForHospital } from './field-release-visibility.mjs';
import { currentVersion } from './release-workflow.mjs';
const customer = version => ({name:'A',products:[{project:'p',version}]});
const batch = pkgVersion => ({id:pkgVersion,product:'p',pkgVersion});

test('numeric versions, equal versions, custom versions and first installation', () => {
  assert.equal(showReleaseForHospital(batch('1.5.26101002'), customer('1.5.26101002')),false);
  assert.equal(showReleaseForHospital(batch('1.5.26100901'), customer('1.5.26101002')),false);
  assert.equal(showReleaseForHospital(batch('1.10'), customer('1.9')),true);
  assert.equal(showReleaseForHospital(batch('1.9'), customer('1.10')),false);
  assert.equal(showReleaseForHospital(batch('v1.10'), customer('1.10')),false);
  for (const version of ['', 'legacy', '1.10-hotfix.1']) assert.equal(showReleaseForHospital(batch('1.9'),customer(version)),true);
  assert.equal(showReleaseForHospital(batch('1.9'),undefined),true);
  assert.equal(showReleaseForHospital(batch('1.9'),{products:[]}),true);
  assert.equal(showReleaseForHospital(batch('1.10-hotfix.1'),customer('1.10-hotfix.1')),false);
});

test('releaseVersion and subsystem versions follow upgrade baseline, independently per product', () => {
  const c={products:[{project:'p',version:'1',releaseVersion:'3'},{project:'q',version:'1'}]};
  assert.equal(showReleaseForHospital(batch('2'),c),false);
  assert.equal(showReleaseForHospital({...batch('2'),product:'q'},c),true);
  c.products[0]={project:'p',subsystems:[{version:'3'},{version:'3'}]};
  assert.equal(currentVersion(c.products[0]),'3');
  assert.equal(showReleaseForHospital(batch('2'),c),false);
  c.products[0].subsystems[1].version='1';
  assert.equal(showReleaseForHospital(batch('2'),c),true);
});

const server = fs.readFileSync(new URL('../server.mjs',import.meta.url),'utf8');
const route = server.slice(server.indexOf("  if (url.pathname === '/api/field/batches')"),server.indexOf('  // ---------- POST /api/batch-download'));
const runRoute = new Function('url','user','res','fieldSites','isAdmin','projById','batchTicketsForUser','releaseIsDelta','releasePublished','loadCustomers','loadBatches','deriveLifecycle','fieldStatusLabel','kbSubLabel','send','showReleaseForHospital',route);
test('real field route filters each hospital, does not change stored history, preserves authorization and missing baseline', () => {
  const customers=[customer('3'),{...customer('1'),name:'B'},{...customer(''),name:'New'}];
  const batches=['1','2','3','4'].map(v=>({...batch(v),deployPlan:{schemaVersion:2},status:'可下载'}));
  const before=JSON.stringify({customers,batches});
  const query=(site,sites=['A','B','New'])=>runRoute(new URL('http://local/api/field/batches'+(site?'?hospitalId='+site:'')),{sites,projects:['p']},{},u=>u.sites,()=>false,id=>({name:id}),(_b,_p,allowed)=>[{site:'A',id:'old-ticket',lifecycle:'待验证'}].filter(e=>allowed.includes(e.site)),()=>true,()=>true,()=>customers,()=>batches,e=>e.lifecycle,()=>({label:'待验证',tag:''}),()=>'',(_r,_s,s)=>JSON.parse(s),showReleaseForHospital);
  assert.deepEqual(query('A').groups.map(g=>g.pkgVersion),['4']);
  assert.deepEqual(query('B').groups.map(g=>g.pkgVersion),['4','3','2']);
  assert.equal(query('New').groups.length,4);
  const grouped=query().groups.find(g=>g.pkgVersion==='2');
  assert.deepEqual(grouped.hospitals,['B','New']);
  assert.equal(grouped.subGroups.length,0);
  assert.equal(query('B',['A']).groups.length,1); // Existing route ignores unauthorized hospital for tickets, exposes no B.
  assert.deepEqual(query('B',['A']).groups[0].hospitals,['A']);
  assert.equal(JSON.stringify({customers,batches}),before);
});

const html=fs.readFileSync(new URL('../public/field.html',import.meta.url),'utf8');
function section(from,to){return html.slice(html.indexOf(from),html.indexOf(to,html.indexOf(from)));}
test('completion refresh hides old cards and clears expanded state without page reload', async () => {
  const box={innerHTML:'old detail',appendChild(){throw Error('no rows expected');}};
  const state={customers:[],batchExpanded:{B04:true},planExpanded:{B04:true}};
  let loaded=0,updated=0;
  const context=vm.createContext({state,Set,$:()=>box,emptyHtml:(_i,title)=>title,mkBatchGroup:()=>({}),api:async()=>({body:{customers:[customer('3')]}}),buildSubOptions(){},updateCtx(){updated++;},loadBatchView(){loaded++;vm.runInContext('renderBatchView([])',context);}});
  vm.runInContext(section('  function renderBatchView(groups)', '  var BATCH_TAG'),context);
  vm.runInContext(section('  async function refreshSiteVersionLedger()', '  // 批次视图逐单'),context);
  await vm.runInContext('refreshSiteVersionLedger()',context);
  assert.equal(state.customers[0].products[0].version,'3');
  assert.equal(loaded,1); assert.equal(updated,1);
  assert.equal(box.innerHTML,'暂无可升级版本');
  assert.equal(Object.keys(state.batchExpanded).length,0);
  assert.equal(Object.keys(state.planExpanded).length,0);
});
test('late list request cannot overwrite another hospital or newer refresh', async () => {
  const pending=[],rendered=[];
  const state={curSite:'A',groupBy:'batch'};
  const context=vm.createContext({state,encodeURIComponent,$:()=>({style:{}}),api:()=>new Promise(resolve=>pending.push(resolve)),renderBatchView:g=>rendered.push(g),emptyHtml:()=>''});
  vm.runInContext(section('  var batchViewRequest = 0;', '  // 渲染按批次视图'),context);
  vm.runInContext('loadBatchView()',context);
  state.curSite='B';vm.runInContext('loadBatchView()',context);
  pending[1]({body:{groups:['B']}});await new Promise(setImmediate);
  pending[0]({body:{groups:['A']}});await new Promise(setImmediate);
  assert.deepEqual(rendered,[['B']]);
});
