import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseSupplierConsoleRoute as parse,supplierConsoleHref as href,sameConsoleScope,consoleNavigation,SUPPLIER_CONSOLE_PAGES} from '../../modules/agent-commerce/supplier-console/ui/route';
import {createAttempt,classifyCommandOutcome,ATTEMPT_KINDS,type Attempt} from '../../modules/agent-commerce/supplier-console/state/attempt';
import {holdAttempt,retainedAttempt,restoreAttempt,releaseAttempt,markAttemptUnknown,consolePhotoTargets,rememberConsolePhoto} from '../../modules/agent-commerce/supplier-console/state/registry';
import {changedFields,editDraft,staleDrafts,conflictRows,reapplyAttempt,discardDraft} from '../../modules/agent-commerce/supplier-console/state/drafts';
import {leaveDecision} from '../../modules/agent-commerce/supplier-console/state/leave';
import {filterProducts,metricText,permissionReason,todoText,partnerLabel,selectionShopLabel,priceGap,PRICE_GAP_NOTE,REVIEW_NOTE,RESERVATION_NOTE,commandFields,fieldLabels,attemptFieldText} from '../../modules/agent-commerce/supplier-console/ui/view';
import {ApiError} from '../../apps/portal-web/src/api';
import type {SupplierProduct} from '../../contracts/guild-launchpad/v1/supplier-console';
import type {Distribution} from '../../contracts/guild-launchpad/v1/hosted-distribution';
const t='11111111-1111-4111-8111-111111111111',i='22222222-2222-4222-8222-222222222222',id='33333333-3333-4333-8333-333333333333',other='44444444-4444-4444-8444-444444444444';
const scope={tenantId:t,instanceId:i},root=`#stores/${t}/${i}/supply`;
const attempt=(overrides:Partial<Omit<Attempt,'key'>>={},key='test-key')=>createAttempt({kind:'product.update',label:'儲存內容',scope,method:'patch',path:'/supply-products/'+id,body:{title:'杯子'},ifMatch:'1',target:id,...overrides},key);

test('SC-UI-01 every page and detail route round-trips canonical links',()=>{
 for(const p of SUPPLIER_CONSOLE_PAGES){const path=href(scope,p.page,{id});const route=parse(path)!;assert.equal(route.page,p.page);assert.equal(route.titleKey,p.titleKey);assert.equal(route.tenantId,t);assert.equal(route.instanceId,i);}
 assert.equal(parse(`#stores/${t}/${i}/supply-orders`)?.page,'reservations');assert.equal(href(scope,'reservations'),root+'/reservations');
});
test('SC-UI-02 invalid scopes fall through and invalid inner paths stay inside the shell',()=>{
 for(const path of ['#stores/supply',`#stores/no/${i}/supply`,`#stores/${t}/no/supply`,`#stores/${t}/${i}/store`,`#stores/${t}/${i}/supply-extra`])assert.equal(parse(path),null,path);
 for(const path of ['/reports','/products/bad','/products/'+id+'/x','/partners/new','/terms/bad','/settings/x','/'])assert.equal(parse(root+path)?.page,'not-found',path);
});
test('SC-UI-03 query whitelist is products-only and unknown input does not change scope',()=>{
 assert.deepEqual(parse(root+'/products?state=offered&sort=available&search=private'),{...scope,page:'products',titleKey:'supplierConsole.products',state:'offered',sort:'available'});
 assert.equal(parse(root+'/products?state=bad&sort=bad')?.state,undefined);assert.equal(parse(root+'?state=offered')?.state,undefined);
 const injection=parse(root+`?x=#stores/${other}/${other}/supply/products`)!;assert.equal(injection.tenantId,t);assert.equal(injection.instanceId,i);assert.equal(injection.page,'overview');
 assert.equal(parse(root+'/products?state=outdated&sort=title')?.sort,'title');
});
test('SC-UI-04 canonical query order and leave scope include the reservations alias',()=>{
 assert.equal(href(scope,'products',{state:'out_of_stock',sort:'sku'}),root+'/products?state=out_of_stock&sort=sku');
 assert.equal(sameConsoleScope(root+'/missing?ignored=1',scope),true);assert.equal(sameConsoleScope(`#stores/${t}/${i}/supply-orders`,scope),true);assert.equal(sameConsoleScope(`#stores/${other}/${i}/supply`,scope),false);
});
test('SC-UI-05 navigation derives one list from capability and confirmed ownership',()=>{
 assert.deepEqual(consoleNavigation(['store:read'],true).map(p=>p.page),['overview','settings']);
 assert.deepEqual(consoleNavigation(['store:read','store:write'],false).map(p=>p.page),['overview','products','partners','terms','settings']);
 assert.deepEqual(consoleNavigation(['store:read','store:write'],true).map(p=>p.page),['overview','products','reservations','partners','terms','settings']);
 assert.equal(SUPPLIER_CONSOLE_PAGES.find(p=>p.page==='product')?.parent,'products');
});
test('SC-UI-06 attempt is an independent deeply frozen snapshot with a stable retry tuple',()=>{
 const body={title:'杯子',nested:{tags:['one']}},a=attempt({body});body.title='changed';body.nested.tags.push('two');
 assert.equal(a.body.title,'杯子');assert.deepEqual(a.body.nested,{tags:['one']});assert.ok(Object.isFrozen(a));assert.ok(Object.isFrozen(a.body));assert.ok(Object.isFrozen(a.body.nested));assert.ok(Object.isFrozen((a.body.nested as {tags:string[]}).tags));
 const tuple=(a:Attempt)=>JSON.stringify([a.method,a.path,a.body,a.ifMatch,a.key]);assert.equal(tuple(a),tuple(a));assert.equal(a.key,'test-key');
});
test('SC-UI-07 matching receipt succeeds; incomplete schema and wrong target remain unknown',()=>{
 const a=attempt();assert.equal(classifyCommandOutcome(a,{response:{product_id:id,version:'2'}}).state,'success');
 for(const response of [{product_id:id},{product_id:other,version:'2'},{product_id:id,version:'2',unexpected:1}])assert.equal(classifyCommandOutcome(a,{response}).state,'unknown');
 const setup=attempt({kind:'profile.setup',target:i});assert.equal(classifyCommandOutcome(setup,{response:{instance_id:i,version:'1',created:true}}).state,'success');
 assert.deepEqual(Object.keys(ATTEMPT_KINDS).sort(),['offer.publish','offer.withdraw','product.create','product.update','profile.setup','profile.update','request.decide','reservation.toggle','terms.update'].sort());
});
for(const [name,error] of [
 ['non-API',new Error('lost')],['network',new ApiError({message:'lost',network:true})],['timeout',new ApiError({message:'late',status:408,timedOut:true})],['500',new ApiError({message:'server',status:500})],['401',new ApiError({message:'expired',status:401})],['accessExpired',new ApiError({message:'access',status:403,accessExpired:true})],['missing status',new ApiError({message:'unknown'})],
] as const)test(`SC-UI-08 unknown outcome ${name}`,()=>assert.equal(classifyCommandOutcome(attempt(),{error}).state,'unknown'));
for(const [status,code] of [[403,'capability_denied'],[404,'not_found'],[409,'stock_below_reserved'],[409,'supply_terms_in_use'],[409,'idempotency_conflict'],[412,'version_conflict'],[422,'validation_failed']] as const)test(`SC-UI-09 known outcome ${status} ${code}`,()=>{
 assert.deepEqual(classifyCommandOutcome(attempt(),{error:new ApiError({message:'原說明',status,code,detail:'原細節'})}),{state:'known',status,code,detail:'原細節'});
});
test('SC-UI-10 registry isolates client, member and business and releases only the same key',()=>{
 const client={},otherClient={},a=attempt(),b=attempt({scope:{tenantId:other,instanceId:i}},'other-scope');holdAttempt(client,'member',a);holdAttempt(client,'member',b);
 assert.equal(retainedAttempt(otherClient,'member',scope),null);assert.equal(retainedAttempt(client,'someone',scope),null);assert.equal(retainedAttempt(client,'member',{tenantId:t,instanceId:other}),null);
 assert.equal(releaseAttempt(client,'member',attempt({},'wrong')),false);assert.equal(restoreAttempt(client,'member',scope),a);assert.equal(retainedAttempt(client,'member',scope)?.hadUnknown,true);
 holdAttempt(client,'member',a);assert.equal(retainedAttempt(client,'member',scope)?.hadUnknown,true);assert.throws(()=>holdAttempt(client,'member',attempt({},'new')));
 assert.equal(releaseAttempt(client,'member',a),true);assert.equal(retainedAttempt(client,'member',scope),null);assert.equal(releaseAttempt(client,'member',b),true);
});
test('SC-UI-11 registry records a late unknown even after the originating controller is gone',()=>{
 const client={},a=attempt();holdAttempt(client,'member',a);markAttemptUnknown(client,'member',a);assert.equal(restoreAttempt(client,'member',scope)?.key,a.key);assert.equal(retainedAttempt(client,'member',scope)?.hadUnknown,true);releaseAttempt(client,'member',a);
});
test('SC-UI-12 drafts retain changed fields, original versions, stale siblings and conflict rows',()=>{
 const base={title:'old',description:'same'};assert.deepEqual(changedFields(base,{title:'new',description:'same'}),{title:'new'});
 let d=editDraft(undefined,'1',base,'title','new');d=editDraft(d,'2',base,'description','same');assert.equal(d.baseVersion,'1');assert.deepEqual(d.fields,{title:'new'});
 const drafts=staleDrafts({[`product:${id}:content`]:d,[`product:${other}:content`]:d},id,'2');assert.equal(drafts[`product:${id}:content`].stale,true);assert.equal(drafts[`product:${other}:content`].stale,undefined);
 assert.deepEqual(conflictRows(d,{title:'someone'}),[{field:'title',mine:'new',current:'someone'}]);assert.deepEqual(discardDraft({x:d},'x'),{});
});
test('SC-UI-13 explicit reapply uses a new key, latest version and still-differing fields',()=>{
 const a=attempt({body:{title:'mine',description:'same'}}),d={baseVersion:'1',fields:{title:'mine',description:'same'}};
 const next=reapplyAttempt(a,d,{title:'theirs',description:'same'},'9','new-key')!;assert.equal(next.key,'new-key');assert.notEqual(next.key,a.key);assert.equal(next.ifMatch,'9');assert.deepEqual(next.body,{title:'mine'});assert.equal(a.ifMatch,'1');
 assert.equal(reapplyAttempt(a,d,{title:'mine',description:'same'},'9'),null);
 const terms=attempt({kind:'terms.update'}),tDraft={baseVersion:'1',fields:{cost_minor:100}};
 assert.deepEqual(reapplyAttempt(terms,tDraft,{cost_minor:99,shipping_minor:0,shipping_terms:'原條件',return_terms:'原條件'},'2')?.body,{cost_minor:100,shipping_minor:0,shipping_terms:'原條件',return_terms:'原條件'});
});
test('SC-UI-14 leave guard permits in-scope routes but guards other scopes and logout',()=>{
 const state={sending:false,held:false,photoBlocking:false,dirty:false};assert.equal(leaveDecision(root+'/products',scope,{...state,sending:true,held:true,dirty:true}).allow,true);
 for(const next of ['#home',href({tenantId:other,instanceId:i},'overview'),null]){
  assert.equal(leaveDecision(next,scope,state).allow,true);assert.equal(leaveDecision(next,scope,{...state,dirty:true}).confirm,true);
  for(const key of ['sending','held','photoBlocking'] as const)assert.equal(leaveDecision(next,scope,{...state,[key]:true}).allow,false);
 }
});
const product=(n:number,offer:SupplierProduct['offer'],available:number):SupplierProduct=>({product_id:`p${n}`,sku:`P000${n}`,title:`商品 ${n}`,description:'茶杯',currency:'TWD',supply_price_minor:100,shipping_minor:0,stock:10,reserved:10-available,available,version:'1',offer,cooperation:{awaiting:0,sellable:0,changes_requested:0,inactive:0}});
const offered={offer_id:id,version:'1',terms_sha256:'a'.repeat(64),matches_current_terms:true};
const products=[product(1,offered,10),product(2,{...offered,matches_current_terms:false},3),product(3,null,0),product(4,offered,0)];
test('SC-UI-15 complete-set product filters have exactly the overview definitions',()=>{
 assert.deepEqual(filterProducts(products,'offered').map(p=>p.sku),['P0001','P0002','P0004']);assert.equal(filterProducts(products,'outdated').length,1);assert.equal(filterProducts(products,'not_offered').length,1);assert.equal(filterProducts(products,'out_of_stock').length,2);
 assert.equal(filterProducts(products,undefined,'sku','茶杯 p0002').length,1);assert.deepEqual(filterProducts(products,undefined,'available').map(p=>p.available),[0,0,3,10]);assert.equal(products[0].available,10);
});
test('SC-UI-16 unavailable metric and todo copy never invent a zero',()=>{
 for(const reason of ['store_write_required','owner_required'] as const){assert.match(metricText({state:'unavailable',reason}),/無法取得/);assert.ok(!metricText({state:'unavailable',reason}).includes('0'));assert.ok(permissionReason(reason));}
 assert.equal(metricText({state:'ready',count:0}),'0');assert.match(todoText({kind:'not_offered',product_id:id,title:'杯子'}),/尚未公開/);
});
test('SC-UI-17 partner IDs disambiguate names; proposal labels never invent a shop ID',()=>{
 const a={partner_id:id,name:'同名店'},b={partner_id:other,name:'同名店'};assert.equal(partnerLabel(a,[a,b]),`同名店（店家 ID …${id.slice(-6)}）`);assert.equal(partnerLabel(a,[a]),'同名店');
});
test('SC-UI-18 review shows a signed price gap and the fixed v1.1 consent boundary',()=>{
 const s={seller_name:'同名店',selection_id:id,retail_price_minor:100,offer:{terms:{cost_minor:200,shipping_minor:50,currency:'TWD'}}} as Distribution;
 assert.match(priceGap(s),/-/);assert.equal(PRICE_GAP_NOTE,'價格差屬於賣家的定價，不是你的佣金、收入或利潤。');assert.equal(REVIEW_NOTE,'同意的是這個售價與供貨版本；不代表同意代出貨，也不會取得買家收件資料。');
 assert.match(selectionShopLabel(s,[s,{...s,selection_id:other}]),/申請 ID/);
});
test('SC-UI-19 presentation vocabulary keeps financial terms only in explicit negations',()=>{
 const strings=[...Object.values(fieldLabels),REVIEW_NOTE,RESERVATION_NOTE,PRICE_GAP_NOTE,...products.map(p=>metricText({state:'ready',count:p.available}))];
 for(const text of strings)if(/成本|營收|佣金|利潤|收入/.test(text))assert.ok(text===PRICE_GAP_NOTE||text===RESERVATION_NOTE,text);
 assert.deepEqual(commandFields('terms.update',{cost_minor:'12.30',shipping_minor:'0',stock:'12'}),{cost_minor:1230,shipping_minor:0,stock:12});
});

test('SC-UI-20 photo recovery locators are scoped and contain no file or command authority',()=>{
 const client={};rememberConsolePhoto(client,'member',scope,id,true);assert.deepEqual(consolePhotoTargets(client,'member',scope),[id]);assert.deepEqual(consolePhotoTargets({},'member',scope),[]);assert.deepEqual(consolePhotoTargets(client,'other',scope),[]);assert.deepEqual(consolePhotoTargets(client,'member',{tenantId:other,instanceId:i}),[]);rememberConsolePhoto(client,'member',scope,id,false);assert.deepEqual(consolePhotoTargets(client,'member',scope),[]);
});
test('SC-UI-21 original command content uses member labels and unit-price formatting',()=>{
 assert.equal(fieldLabels.cost_minor,'供貨單價');assert.equal(attemptFieldText('cost_minor',15000,'TWD'),'$150.00');assert.equal(attemptFieldText('shipping_minor',0,'TWD'),'$0.00');
 assert.equal(attemptFieldText('decision','revoked','TWD'),'撤回同意');assert.equal(attemptFieldText('reservation_enabled',false,'TWD'),'否');assert.equal(attemptFieldText('stock',12,'TWD'),'12');
});
test('SC-UI-22 profile and reservation commands both refresh profile and owner projections',()=>{
 const profileReads=ATTEMPT_KINDS['profile.update'].reads as readonly string[];
 const reservationReads=ATTEMPT_KINDS['reservation.toggle'].reads as readonly string[];
 assert.ok(profileReads.includes('profile'));
 assert.ok(profileReads.includes('owner'));
 assert.ok(reservationReads.includes('profile'));
 assert.ok(reservationReads.includes('owner'));
 assert.ok(!ATTEMPT_KINDS['profile.setup'].reads.includes('owner'));
});
test('SC-UI-23 dirty draft keeps original baseVersion across version moves while new draft takes latest version',()=>{
 const base={name:'原商品庫名稱',description:'原說明'};
 let draft=editDraft(undefined,'1',base,'name','修改後的名稱');
 assert.equal(draft.baseVersion,'1');
 assert.deepEqual(draft.fields,{name:'修改後的名稱'});
 draft=editDraft(draft,'2',base,'description','新說明');
 assert.equal(draft.baseVersion,'1');
 assert.deepEqual(draft.fields,{name:'修改後的名稱',description:'新說明'});
 const freshDraft=editDraft(undefined,'2',base,'name','全新草稿');
 assert.equal(freshDraft.baseVersion,'2');
 assert.deepEqual(freshDraft.fields,{name:'全新草稿'});
});
