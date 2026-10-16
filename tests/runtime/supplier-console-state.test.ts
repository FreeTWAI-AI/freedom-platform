import {test} from 'node:test';
import * as React from 'react';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Reservations,Reservation} from '../../modules/agent-commerce/supplier-console/ui/pages/Reservations';
import {Partner} from '../../modules/agent-commerce/supplier-console/ui/pages/Partners';
import {Changes} from '../../modules/agent-commerce/supplier-console/ui/pages/Shared';
import {Overview} from '../../modules/agent-commerce/supplier-console/ui/pages/Overview';
import type {ConsoleController,ReadSlot} from '../../modules/agent-commerce/supplier-console/state/useSupplierConsoleController';
import {reservationFilterParams,validLocalDate} from '../../modules/agent-commerce/supplier-console/ui/route';
import {CHANGE_LABELS,changeLabel,changeSubject} from '../../modules/agent-commerce/supplier-console/ui/view';
import {SupplierChangeOperationSchema} from '../../contracts/guild-launchpad/v1/supplier-console';
import {interfaceMessages} from '../../apps/portal-web/src/interface-messages';
import assert from 'node:assert/strict';
import {parseSupplierConsoleRoute as parse,supplierConsoleHref as href,sameConsoleScope,consoleNavigation,SUPPLIER_CONSOLE_PAGES} from '../../modules/agent-commerce/supplier-console/ui/route';
import {createAttempt,classifyCommandOutcome,ATTEMPT_KINDS,refusalReleased,type Attempt} from '../../modules/agent-commerce/supplier-console/state/attempt';
import {holdAttempt,retainedAttempt,restoreAttempt,releaseAttempt,markAttemptUnknown,consolePhotoTargets,rememberConsolePhoto} from '../../modules/agent-commerce/supplier-console/state/registry';
import {changedFields,editDraft,staleDrafts,conflictRows,reapplyAttempt,discardDraft} from '../../modules/agent-commerce/supplier-console/state/drafts';
import {leaveDecision} from '../../modules/agent-commerce/supplier-console/state/leave';
import {filterProducts,metricText,permissionReason,todoText,partnerLabel,selectionShopLabel,priceGap,PRICE_GAP_NOTE,REVIEW_NOTE,RESERVATION_NOTE,commandFields,fieldLabels,attemptFieldText} from '../../modules/agent-commerce/supplier-console/ui/view';
import {Reports,reportPeriodError} from '../../modules/agent-commerce/supplier-console/ui/pages/Reports';
import {fetchSupplierReportCsv} from '../../modules/agent-commerce/supplier-console/ui/report-download';
import {taipeiToday,defaultReportPeriod} from '../../modules/agent-commerce/supplier-console/ui/route';
import {reportMatchesReadKey} from '../../modules/agent-commerce/supplier-console/state/useSupplierConsoleController';
import {MEMBER_ACCESS_EXPIRED_MESSAGE} from '../../apps/portal-web/src/access-fetch';
import {SupplierReportSchema,type SupplierReport} from '../../contracts/guild-launchpad/v1/supplier-console';
import {PortalClient,ApiError} from '../../apps/portal-web/src/api';
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
 for(const path of ['/reports/x','/products/bad','/products/'+id+'/x','/partners/new','/terms/bad','/settings/x','/'])assert.equal(parse(root+path)?.page,'not-found',path);
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
 assert.deepEqual(consoleNavigation(['store:read','store:write'],false).map(p=>p.page),['overview','products','partners','terms','reports','settings']);
 assert.deepEqual(consoleNavigation(['store:read','store:write'],true).map(p=>p.page),['overview','products','reservations','partners','terms','reports','settings']);
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
 for(const kind of ['profile.update','reservation.toggle'] as const)assert.ok(['profile','owner'].every(key=>(ATTEMPT_KINDS[kind].reads as readonly string[]).includes(key)),kind);
 assert.ok(!(ATTEMPT_KINDS['profile.setup'].reads as readonly string[]).includes('owner'));
});
test('SC-UI-23 dirty draft keeps original baseVersion across version moves while new draft takes latest version',()=>{
 const base={name:'原商品庫名稱',description:'原說明'};
 let draft=editDraft(undefined,'1',base,'name','修改後的名稱');assert.equal(draft.baseVersion,'1');assert.deepEqual(draft.fields,{name:'修改後的名稱'});
 draft=editDraft(draft,'2',base,'description','新說明');assert.equal(draft.baseVersion,'1');assert.deepEqual(draft.fields,{name:'修改後的名稱',description:'新說明'});
 const fresh=editDraft(undefined,'2',base,'name','全新草稿');assert.equal(fresh.baseVersion,'2');assert.deepEqual(fresh.fields,{name:'全新草稿'});
});
test('SC-UI-24 refusal lock releases only after a newer valid current profile read',()=>{
 assert.equal(refusalReleased({mark:5,ticket:4,current:true,matched:true}),false);
 assert.equal(refusalReleased({mark:5,ticket:5,current:true,matched:true}),false);
 assert.equal(refusalReleased({mark:5,ticket:6,current:false,matched:true}),false);
 assert.equal(refusalReleased({mark:5,ticket:6,current:true,matched:false}),false);
 assert.equal(refusalReleased({key:'overview',mark:5,ticket:6,current:true,matched:true}),false);
 assert.equal(refusalReleased({mark:null,ticket:6,current:true,matched:true}),false);
 assert.equal(refusalReleased({mark:5,ticket:6,current:true,matched:true}),true);
});


test('SC-UI-S2-01 reservation details round-trip with owner-only metadata and no navigation group',()=>{
 const path=href(scope,'reservation',{id});assert.equal(path,root+'/reservations/'+id);
 assert.deepEqual(parse(path),{...scope,page:'reservation',titleKey:'supplierConsole.reservation',id});
 const page=SUPPLIER_CONSOLE_PAGES.find(p=>p.page==='reservation')!;
 assert.equal(page.title,'預留明細');assert.equal(page.requires,'owner');assert.equal(page.group,null);assert.equal(page.parent,'reservations');
 assert.equal(parse(root+'/reservations/bad')?.page,'not-found');
 assert.ok(!consoleNavigation(['store:write'],true).some(p=>p.page==='reservation'));
});
test('SC-UI-S2-02 every reservations filter round-trips in a stable canonical order',()=>{
 const reservation={state:'reserved' as const,partner:id,product:other,from:'2026-10-01',to:'2026-10-15'};
 const path=href(scope,'reservations',{reservation:{to:reservation.to,product:other,partner:id,state:'reserved',from:reservation.from}});
 assert.equal(path,root+`/reservations?state=reserved&partner=${id}&product=${other}&from=2026-10-01&to=2026-10-15`);
 assert.deepEqual(parse(path)?.reservation,reservation);
 for(const [key,value] of Object.entries(reservation))assert.deepEqual(parse(href(scope,'reservations',{reservation:{[key]:value}}))?.reservation,{[key]:value});
 for(const state of ['cancelled','expired'] as const)assert.equal(parse(href(scope,'reservations',{reservation:{state}}))?.reservation?.state,state);
 assert.deepEqual(parse(`#stores/${t}/${i}/supply-orders?state=reserved&partner=${id}`)?.reservation,{state:'reserved',partner:id});
 assert.equal(parse(`#stores/${t}/${i}/supply-orders`)?.page,'reservations');
});
test('SC-UI-S2-03 invalid reservations query values are dropped without affecting other filters or pages',()=>{
 assert.deepEqual(parse(root+'/reservations?state=offered&partner=bad&product=bad&from=2026-02-30&to=2026-13-01&sort=sku&unknown=1')?.reservation,{});
 for(const date of ['2026-2-01','2026-02-29','2026-04-31','2026-00-01','2026-01-00','0000-01-01','2026-01-01T00:00:00Z','2026-01-01\n']){
  assert.equal(validLocalDate(date),false,date);assert.deepEqual(parse(root+'/reservations?from='+encodeURIComponent(date)+'&state=expired')?.reservation,{state:'expired'});
 }
 for(const date of ['2024-02-29','2000-02-29','2026-12-31','0099-01-01'])assert.equal(validLocalDate(date),true,date);
 assert.equal(validLocalDate('1900-02-29'),false);
 for(const page of ['overview','products','reservation','partner'] as const)assert.equal(parse(href(scope,page,{id})+`?partner=${id}&product=${other}&from=2026-01-01&to=2026-01-02&state=reserved`)?.reservation,undefined);
 assert.equal(href(scope,'reservations',{reservation:{partner:'bad',from:'2026-02-30'}}),root+'/reservations');
});
test('SC-UI-S2-04 dates are Taipei calendar days with half-open ISO bounds in every browser zone',()=>{
 const before=process.env.TZ;
 try{
  for(const zone of ['Asia/Taipei','UTC','America/New_York','Pacific/Kiritimati','Pacific/Pago_Pago']){
   process.env.TZ=zone;
   const q=reservationFilterParams({state:'reserved',partner:id,product:other,from:'2026-10-01',to:'2026-10-15'})!;
   assert.deepEqual(Object.fromEntries(q),{state:'reserved',partner_id:id,product_id:other,from:'2026-09-30T16:00:00.000Z',to:'2026-10-15T16:00:00.000Z'},zone);
   assert.deepEqual(Object.fromEntries(reservationFilterParams({from:'2026-12-31',to:'2026-12-31'})!),{from:'2026-12-30T16:00:00.000Z',to:'2026-12-31T16:00:00.000Z'},zone);
   assert.equal(reservationFilterParams({to:'2024-02-29'})?.get('to'),'2024-02-29T16:00:00.000Z',zone);
   assert.deepEqual(Object.fromEntries(reservationFilterParams({from:'2026-03-08',to:'2026-03-08'})!),{from:'2026-03-07T16:00:00.000Z',to:'2026-03-08T16:00:00.000Z'},zone);
   assert.deepEqual(Object.fromEntries(reservationFilterParams({from:'2026-11-01',to:'2026-11-01'})!),{from:'2026-10-31T16:00:00.000Z',to:'2026-11-01T16:00:00.000Z'},zone);
   assert.equal(reservationFilterParams({from:'2026-02-30'}),null);assert.equal(reservationFilterParams({to:'bad'}),null);
   assert.equal(reservationFilterParams({from:'2026-10-16',to:'2026-10-15'}),null);
   assert.equal(reservationFilterParams({})?.size,0);
  }
 }finally{if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
});
test('SC-UI-S2-05 change labels exhaust the wire enum and preserve publish version semantics',()=>{
 const expected={
  'storefront.supply-catalog.setup':'建立供貨商品庫','storefront.supply-profile.update':'更新商品庫資料','storefront.reservations.configure':'變更預留設定',
  'storefront.supply-product.create':'新增商品','storefront.product.create':'在商店新增商品','storefront.supply-product.update':'更新商品內容或庫存',
  'storefront.product.update':'在商店更新商品','storefront.supply-terms.update':'更新供貨條件','storefront.product.photo.upload':'上傳商品照片',
  'storefront.product.photo.remove':'移除商品照片','storefront.supply-offer.publish':'公開新的供貨版本','storefront.supply-offer.withdraw':'撤回供貨版本','storefront.distribution.decide':'處理售價申請',
 };
 assert.deepEqual(Object.keys(CHANGE_LABELS).sort(),[...SupplierChangeOperationSchema.options].sort());assert.deepEqual(CHANGE_LABELS,expected);
 for(const operation of SupplierChangeOperationSchema.options)assert.equal(changeLabel({operation,version:'1'}),expected[operation]);
 for(const version of ['2','9223372036854775807'])assert.equal(changeLabel({operation:'storefront.supply-offer.publish',version}),'供貨版本由新版本取代');
 assert.equal(changeLabel({operation:'storefront.distribution.decide',version:'2'}),'處理售價申請');
 assert.equal(changeSubject({kind:'business'}),'商品庫設定');assert.equal(changeSubject({kind:'product',product_id:id,title:'杯子'}),'杯子');
 assert.equal(changeSubject({kind:'offer',product_id:id,offer_id:other,title:'杯子'}),'杯子');
 assert.equal(changeSubject({kind:'request',product_id:id,selection_id:other,partner_id:other,partner_name:'店家',title:'杯子'}),'店家・杯子');
});
test('SC-UI-S2-06 every supplier console page title is translated in every interface language',()=>{
 for(const page of SUPPLIER_CONSOLE_PAGES){assert.ok(page.titleKey in interfaceMessages,page.titleKey);const translations=interfaceMessages[page.titleKey];assert.equal(translations.length,5);assert.equal(translations[0],page.title);assert.ok(translations.every(text=>text.length>0));}
 assert.equal(interfaceMessages['supplierConsole.reservation'][1],'Reservation details');
});

// The Node test loader uses the classic JSX factory outside the portal's Vite transform.
function renderPresentation(element:Parameters<typeof renderToStaticMarkup>[0]){
 const previous=Object.getOwnPropertyDescriptor(globalThis,'React');Object.defineProperty(globalThis,'React',{configurable:true,value:React});
 try{return renderToStaticMarkup(element);}finally{if(previous)Object.defineProperty(globalThis,'React',previous);else Reflect.deleteProperty(globalThis,'React');}
}
const asOf='2026-10-15T12:00:00.000Z';
const readySlot=(data:unknown):ReadSlot<unknown>=>({state:'ready',data,asOf,lastOkAt:asOf,error:''});
const failedSlot:ReadSlot<unknown>={state:'failed',data:null,asOf:null,lastOkAt:null,error:'讀取服務暫停'};
function presentationController(slots:Record<string,ReadSlot<unknown>>,extra:Record<string,unknown>={}):ConsoleController {
 return {scope,route:parse(root+'/reservations'),reservationFilters:{state:'reserved',partner:id},profile:{capabilities:['store:write']},ownerAllowed:true,owner:readySlot(null),locked:false,cursors:[undefined],can:()=>true,read:()=>{throw new Error('A render must not initiate reads');},slot:(key:string)=>slots[key]??{state:'idle',data:null,asOf:null,lastOkAt:null,error:''},...extra} as unknown as ConsoleController;
}
const reservationRow={order_id:id,version:'1',partner_id:other,store:{name:'合作店家',slug:'partner'},currency:'TWD',
 items:[{product_id:other,offer_id:id,acceptance_id:other,sku:'P0001',title:'供貨茶杯',quantity:3,unit_supply_price_minor:15000,supply_total_minor:45000}],
 state:'reserved',created_at:asOf,reservation_expires_at:'2026-10-15T12:30:00.000Z',closed_at:null,payment_enabled:false,fulfilment_enabled:false,money_movement_enabled:false};
const reservationData={as_of:asOf,filter:{state:null,partner_id:null,product_id:null,from:null,to:null},totals:{reservations:1,lines:1},items:[reservationRow],next_cursor:null};
test('SC-UI-S2-07 failed reservation reads and option reads show reasons without invented empty totals',()=>{
 const c=presentationController({reservations:failedSlot,partners:failedSlot,products:failedSlot});
 const html=renderPresentation(createElement(Reservations,{c}));
 assert.ok(html.includes('讀取服務暫停'));assert.ok(html.includes('重試'));assert.ok(html.includes('店家／商品選項暫時無法讀取，仍可用連結篩選。'));
 assert.ok(!html.includes('符合條件：'));assert.ok(!html.includes('沒有符合條件的供貨預留。'));
 const forbidden=renderPresentation(createElement(Reservations,{c:presentationController({reservations:readySlot(reservationData)},{ownerAllowed:false})}));
 assert.ok(forbidden.includes('只有業務空間擁有者可以查看預留'));assert.ok(!forbidden.includes('篩選預留'));assert.ok(!forbidden.includes('供貨茶杯'));
});
test('SC-UI-S2-08 list preserves the full order text selector while visible IDs and detail action use a suffix',()=>{
 const html=renderPresentation(createElement(Reservations,{c:presentationController({reservations:readySlot(reservationData)})}));
 assert.ok(html.includes('符合條件：1 筆預留、1 個供貨行項'));assert.ok(html.includes('3 × 供貨單價 $150.00 ＝ 小計 $450.00'));
 assert.ok(html.includes(`<span class="sr-only">${id}</span>`));assert.ok(html.includes(`預留編號 …${id.slice(-8)}`));assert.ok(html.includes(href(scope,'reservation',{id})));
 assert.ok(html.includes('上一頁'));assert.ok(html.includes('下一頁'));assert.ok(!html.includes('取消預留'));
 const stale=renderPresentation(createElement(Reservations,{c:presentationController({reservations:{...readySlot(reservationData),state:'failed',error:'讀取服務暫停'}})}));
 assert.ok(stale.includes('未更新'));assert.ok(stale.includes('供貨茶杯'));assert.ok(!stale.includes('符合條件：'));
});
test('SC-UI-S2-09 reservation detail shows own line and supply version, retains filters and handles 404',()=>{
 const detail={as_of:asOf,reservation:reservationRow,offers:[{offer_id:id,product_id:other,terms_sha256:'a'.repeat(64),state:'withdrawn'}]};
 const c=presentationController({['reservation:'+id]:readySlot(detail)},{route:parse(href(scope,'reservation',{id}))});
 const html=renderPresentation(createElement(Reservation,{c}));
 assert.ok(html.includes(href(scope,'reservations',{reservation:c.reservationFilters}).replaceAll('&','&amp;')));
 for(const text of ['預留明細','供貨版本 …aaaaaaaa','已撤回','只顯示你供貨的行項；買家資料、其他供應商的商品與整張訂單金額不會顯示。',RESERVATION_NOTE,'查看合作店家','查看這間店的全部預留'])assert.ok(html.includes(text),text);
 assert.ok(html.includes(href(scope,'product',{id:other})));assert.ok(!html.includes('取消預留'));assert.ok(!html.includes('聯絡'));
 assert.ok(renderPresentation(createElement(Reservation,{c:presentationController({['reservation:'+id]:{...failedSlot,status:404}},{route:c.route})})).includes('找不到這份預留。'));
});
test('SC-UI-S2-10 history separates permissions, empty, failed and stale data and omits product titles in product records',()=>{
 const item={change_id:id,at:asOf,operation:'storefront.supply-product.update',version:'2',subject:{kind:'product',product_id:other,title:'供貨茶杯'}};
 const changes={as_of:asOf,product_id:null,items:[item],truncated:true};
 const html=renderPresentation(createElement(Changes,{c:presentationController({changes:readySlot(changes)})}));
 for(const text of ['近期變更','更新商品內容或庫存','供貨茶杯','版本 2','只顯示最近 20 筆。','只列出這個商品庫的操作與版本，不顯示操作者。'])assert.ok(html.includes(text),text);
 const product=renderPresentation(createElement(Changes,{c:presentationController({['changes:'+other]:readySlot({...changes,product_id:other})}),productId:other}));
 assert.ok(product.includes('紀錄'));assert.ok(!product.includes('供貨茶杯'));
 const failed=renderPresentation(createElement(Changes,{c:presentationController({changes:failedSlot})}));
 assert.ok(failed.includes('讀取服務暫停'));assert.ok(!failed.includes('目前沒有近期變更。'));
 const empty=renderPresentation(createElement(Changes,{c:presentationController({changes:readySlot({...changes,items:[]})})}));assert.ok(empty.includes('目前沒有近期變更。'));
 const denied=renderPresentation(createElement(Changes,{c:presentationController({changes:readySlot(changes)},{profile:{capabilities:['store:read']}})}));
 assert.ok(denied.includes('無法取得：需要商品編輯權限才能查看'));assert.ok(!denied.includes('供貨茶杯'));assert.ok(!denied.includes('更新資料'));
});
test('SC-UI-S2-11 new overview history leaves the original to-do list and exact refresh action selectors intact',()=>{
 const metric={state:'ready',count:1},todo={kind:'not_offered',product_id:other,title:'待辦商品'};
 const overview={as_of:asOf,metrics:{offered_products:metric,pending_requests:metric,active_reservation_lines:metric,out_of_stock_products:metric},product_count:1,todos:{state:'ready',items:[todo],truncated:false}};
 const changes={as_of:asOf,items:[{change_id:id,at:asOf,operation:'storefront.supply-product.update',version:'2',subject:{kind:'product',product_id:other,title:'待辦商品'}}],truncated:false};
 const html=renderPresentation(createElement(Overview,{c:presentationController({overview:readySlot(overview),changes:readySlot(changes)})}));
 assert.equal((html.match(/class="sc-list"/g)??[]).length,1);assert.equal((html.match(/>更新資料<\/button>/g)??[]).length,1);
 assert.ok(html.includes(href(scope,'reservations',{reservation:{state:'reserved'}})));
 const partner=renderPresentation(createElement(Partner,{c:presentationController({['partner:'+id]:readySlot({partner:{partner_id:id,name:'合作店家'},selections:[],truncated:false}),['partner-reservations:'+id]:readySlot(reservationData)},{route:parse(href(scope,'partner',{id}))})}));
 assert.equal((partner.match(/<h3>/g)??[]).length,1);assert.ok(partner.includes('相關預留'));assert.ok(partner.includes('供貨小計 $450.00'));
 const denied=renderPresentation(createElement(Partner,{c:presentationController({['partner-reservations:'+id]:readySlot(reservationData)},{route:parse(href(scope,'partner',{id})),ownerAllowed:false})}));
 assert.ok(denied.includes('只有業務空間擁有者可以查看預留'));assert.ok(!denied.includes('供貨小計'));
});

test('SC-UI-S3-01 report period links round-trip, ignore other keys and discard invalid or partial periods',()=>{
 const period={from:'2024-02-01',to:'2024-02-29'},path=href(scope,'reports',{period});
 assert.equal(path,root+'/reports?from=2024-02-01&to=2024-02-29');
 assert.deepEqual(parse(path),{...scope,page:'reports',titleKey:'supplierConsole.reports',period});
 assert.deepEqual(parse(path+'&state=offered&sort=sku&private=ignored'),parse(path));
 for(const query of ['from=2024-02-01','to=2024-02-29','from=2024-02-30&to=2024-03-01','from=2024-03-01&to=2024-02-29','from=1999-12-31&to=2000-01-01','from=2024-01-01&to=2025-01-01'])assert.equal(parse(root+'/reports?'+query)?.period,undefined,query);
 assert.equal(parse(root+'/products?from=2024-02-01&to=2024-02-29')?.period,undefined);
 assert.equal(href(scope,'reports',{period:{from:'bad',to:period.to}}),root+'/reports');
 assert.equal(href(scope,'products',{period}),root+'/products');
 assert.equal(parse(root+'/reports/x')?.page,'not-found');
 assert.deepEqual(parse(root+'/reports?from=2024-01-01&to=2024-12-31')?.period,{from:'2024-01-01',to:'2024-12-31'});
});
test('SC-UI-S3-02 management navigation and translations follow store write access',()=>{
 for(const owner of [false,true]){
  assert.deepEqual(consoleNavigation(['store:read'],owner).map(p=>p.page),['overview','settings']);
  const nav=consoleNavigation(['store:write'],owner);assert.deepEqual(nav.filter(p=>p.group==='管理').map(p=>p.page),['reports','settings']);assert.equal(nav.filter(p=>p.page==='reports').length,1);
 }
 assert.equal(SUPPLIER_CONSOLE_PAGES.find(p=>p.page==='reports')?.requires,'write');
 assert.deepEqual(interfaceMessages['supplierConsole.reports'],['營運報表','Operations report','運営レポート','운영 보고서','Informe de operaciones']);
});
test('SC-UI-S3-03 Taipei today and the inclusive thirty-day default ignore process time zone',()=>{
 const before=process.env.TZ;
 try{for(const zone of ['UTC','Asia/Taipei','America/Los_Angeles','Pacific/Honolulu','Europe/Berlin']){
  process.env.TZ=zone;
  for(const [instant,today,from] of [
   ['2026-10-15T15:59:59.999Z','2026-10-15','2026-09-16'],['2026-10-15T16:00:00.000Z','2026-10-16','2026-09-17'],
   ['2024-02-28T16:00:00.000Z','2024-02-29','2024-01-31'],['2024-02-29T16:00:00.000Z','2024-03-01','2024-02-01'],
   ['2024-12-31T15:59:59.999Z','2024-12-31','2024-12-02'],['2024-12-31T16:00:00.000Z','2025-01-01','2024-12-03'],
  ]){assert.equal(taipeiToday(Date.parse(instant)),today,zone);assert.deepEqual(defaultReportPeriod(Date.parse(instant)),{from,to:today},zone);}
 }}finally{if(before===undefined)delete process.env.TZ;else process.env.TZ=before;}
});
const reportPeriod={from:'2026-10-01',to:'2026-10-15'},reportKey='report:2026-10-01:2026-10-15';
const reportFixture=():SupplierReport=>SupplierReportSchema.parse({profile:'freedom.supplier-console.report/v1',tenant_id:t,instance_id:i,as_of:asOf,
 business:{name:'供貨事業',currency:'TWD'},period:{...reportPeriod,time_zone:'Asia/Taipei',start:'2026-09-30T16:00:00.000Z',end:'2026-10-15T16:00:00.000Z'},
 products:{total:5,offered:3,not_offered:2,outdated:1,out_of_stock:2},cooperation:{totals:{awaiting:1,sellable:2,changes_requested:3,inactive:4},partner_count:1,partners:[{partner_id:id,name:'合作商店',products:5,cooperation:{awaiting:1,sellable:2,changes_requested:3,inactive:4}}]},
 reservations:{state:'ready',reserved:{reservations:1,lines:2,quantity:3,supply_total_minor:45000},cancelled:{reservations:0,lines:0,quantity:0,supply_total_minor:0},expired:{reservations:0,lines:0,quantity:0,supply_total_minor:0}},csv_rows:8});
test('SC-UI-S3-04 report checker rejects scope or period that differs from the read key',()=>{
 const data=reportFixture();assert.equal(reportMatchesReadKey(data,scope,reportKey),true);
 for(const changed of [{...data,tenant_id:other},{...data,instance_id:other},{...data,period:{...data.period,from:'2026-10-02'}},{...data,period:{...data.period,to:'2026-10-16'}}])assert.equal(reportMatchesReadKey(changed,scope,reportKey),false);
 assert.equal(reportMatchesReadKey(data,scope,'report:2026-10-02:2026-10-15'),false);
});
test('SC-UI-S3-05 CSV download returns the original blob and period filename with the expected request',async ctx=>{
 const bytes='\uFEFF"報表","供應商營運報表"\r\n',client=new PortalClient();client.csrfToken='session-a';
 ctx.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init:RequestInit)=>{
  assert.equal(input,`/api/v1/tenants/${t}/storefronts/${i}/supplier-console/report.csv?from=2026-10-01&to=2026-10-15`);assert.equal(init.method,'GET');assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'manual');assert.equal(new Headers(init.headers).get('Accept'),'text/csv, application/json');assert.equal(new Headers(init.headers).get('X-Requested-With'),'XMLHttpRequest');assert.ok(init.signal);
  return new Response(bytes,{headers:{'Content-Type':'text/csv; charset=utf-8'}});
 });
 const result=await fetchSupplierReportCsv(client,scope,reportPeriod,new AbortController().signal);
 assert.ok(result.blob instanceof Blob);assert.equal(result.filename,'supplier-report-2026-10-01_2026-10-15.csv');assert.deepEqual(new Uint8Array(await result.blob.arrayBuffer()),new TextEncoder().encode(bytes));
});
test('SC-UI-S3-06 CSV 409 preserves the problem detail and code; server failures use generic network copy',async ctx=>{
 const message='這段期間的報表超過 10,000 列，請縮短期間。';
 const fetch=ctx.mock.method(globalThis,'fetch',async()=>Response.json({detail:message,code:'report_too_large'},{status:409}));
 await assert.rejects(fetchSupplierReportCsv(new PortalClient(),scope,reportPeriod,new AbortController().signal),(e:unknown)=>e instanceof ApiError&&e.status===409&&e.message===message&&e.detail===message&&e.code==='report_too_large'&&!e.network);
 fetch.mock.mockImplementation(async()=>Response.json({detail:'private server diagnostic',code:'server_failure'},{status:500}));
 await assert.rejects(fetchSupplierReportCsv(new PortalClient(),scope,reportPeriod,new AbortController().signal),(e:unknown)=>e instanceof ApiError&&e.status===500&&e.network&&e.message==='暫時無法產生 CSV，請稍後重試。');
});
test('SC-UI-S3-07 a successful non-CSV response is rejected',async ctx=>{
 ctx.mock.method(globalThis,'fetch',async()=>Response.json({ok:true}));
 await assert.rejects(fetchSupplierReportCsv(new PortalClient(),scope,reportPeriod,new AbortController().signal),(e:unknown)=>e instanceof ApiError&&e.message==='CSV 回應不完整，請重試。');
});
test('SC-UI-S3-08 non-JSON 403 marks Access expiry and clears only the dispatching session',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
 const fetch=ctx.mock.method(globalThis,'fetch',async()=>new Response('<html>Access</html>',{status:403}));
 await assert.rejects(fetchSupplierReportCsv(client,scope,reportPeriod,new AbortController().signal),(e:unknown)=>e instanceof ApiError&&e.accessExpired&&e.status===403&&e.message===MEMBER_ACCESS_EXPIRED_MESSAGE);
 assert.equal(client.accessExpired,true);assert.equal(client.csrfToken,null);assert.equal(unauthorized,1);
 client.csrfToken='session-a';client.accessExpired=false;
 fetch.mock.mockImplementation(async()=>{client.csrfToken='session-b';return new Response('Access',{status:403});});
 await assert.rejects(fetchSupplierReportCsv(client,scope,reportPeriod,new AbortController().signal),/登入狀態已改變，未下載 CSV。/);
 assert.equal(client.csrfToken,'session-b');assert.equal(client.accessExpired,false);assert.equal(unauthorized,1);
});
test('SC-UI-S3-09 JSON 401 notifies only the dispatching session and JSON 403 preserves its detail',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
 const fetch=ctx.mock.method(globalThis,'fetch',async()=>Response.json({detail:'登入已過期',code:'session_expired'},{status:401}));
 await assert.rejects(fetchSupplierReportCsv(client,scope,reportPeriod,new AbortController().signal),(e:unknown)=>e instanceof ApiError&&e.status===401&&e.code==='session_expired'&&e.message==='登入已過期');assert.equal(unauthorized,1);assert.equal(client.csrfToken,null);assert.equal(client.accessExpired,false);
 client.csrfToken='session-a';fetch.mock.mockImplementation(async()=>{client.csrfToken='session-b';return Response.json({detail:'登入已過期'},{status:401});});
 await assert.rejects(fetchSupplierReportCsv(client,scope,reportPeriod,new AbortController().signal));assert.equal(unauthorized,1);assert.equal(client.csrfToken,'session-b');
 fetch.mock.mockImplementation(async()=>Response.json({detail:'目前身分沒有權限',code:'capability_denied'},{status:403}));
 await assert.rejects(fetchSupplierReportCsv(client,scope,reportPeriod,new AbortController().signal),(e:unknown)=>e instanceof ApiError&&e.status===403&&e.code==='capability_denied'&&e.message==='目前身分沒有權限');assert.equal(unauthorized,1);
});
test('SC-UI-S3-10 a generation change while reading CSV bytes returns no blob',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';let finish!:()=>void;
 const response=new Response(new ReadableStream({start(controller){finish=()=>{controller.enqueue(new TextEncoder().encode('CSV'));controller.close();};}}),{headers:{'Content-Type':'text/csv'}});
 ctx.mock.method(globalThis,'fetch',async()=>response);
 const pending=fetchSupplierReportCsv(client,scope,reportPeriod,new AbortController().signal);
 await new Promise(resolve=>setImmediate(resolve));client.csrfToken='session-b';finish();
 await assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.network&&e.message==='登入狀態已改變，未下載 CSV。');
});
test('SC-UI-S3-11 abort rejects even if the transport does not settle and never dispatches a pre-aborted request',async ctx=>{
 let calls=0,requestSignal:AbortSignal|null|undefined;ctx.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init:RequestInit)=>{calls++;requestSignal=init.signal;return new Promise<Response>(()=>{});});
 const abort=new AbortController(),pending=fetchSupplierReportCsv(new PortalClient(),scope,reportPeriod,abort.signal);abort.abort();
 await assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.network&&e.code==='aborted');assert.equal(requestSignal?.aborted,true);
 await assert.rejects(fetchSupplierReportCsv(new PortalClient(),scope,reportPeriod,abort.signal));assert.equal(calls,1);
});
test('SC-UI-S3-12 sixty-second deadline aborts a stalled download',async ctx=>{
 ctx.mock.timers.enable({apis:['setTimeout']});let signal:AbortSignal|null|undefined;
 ctx.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init:RequestInit)=>{signal=init.signal;return new Promise<Response>(()=>{});});
 const pending=fetchSupplierReportCsv(new PortalClient(),scope,reportPeriod,new AbortController().signal);
 ctx.mock.timers.tick(60_000);
 await assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.network&&e.timedOut&&e.message==='下載等候過久，請稍後重試。');assert.equal(signal?.aborted,true);
});
test('SC-UI-S3-13 report period form distinguishes invalid days, reversed periods and more than 366 days',()=>{
 for(const from of ['', '1999-12-31','2026-02-29','2026-2-01','bad'])assert.equal(reportPeriodError({from,to:'2026-10-15'}),'請輸入有效日期（2000 年以後）。');
 assert.equal(reportPeriodError({from:'2026-10-16',to:'2026-10-15'}),'期間起不能晚於期間迄，請檢查日期。');
 assert.equal(reportPeriodError({from:'2024-01-01',to:'2025-01-01'}),'期間最長 366 天，請縮短期間。');
 assert.equal(reportPeriodError({from:'2024-01-01',to:'2024-12-31'}),null);assert.equal(reportPeriodError({from:'2000-02-29',to:'2000-02-29'}),null);
});
function reportController(slot:ReadSlot<unknown>,extra:Record<string,unknown>={}){return presentationController({[reportKey]:slot},{route:parse(root+'/reports'),reportPeriod,client:new PortalClient(),...extra});}
test('SC-UI-S3-14 report shows no counts or download for idle, loading, failed, refused or 409 reads including stale data',()=>{
 for(const slot of [{...failedSlot,state:'idle' as const},{...failedSlot,state:'loading' as const},failedSlot,{...failedSlot,status:403},{...failedSlot,status:409,error:'這段期間的報表超過 10,000 列，請縮短期間。'},{...failedSlot,data:reportFixture()}]){
  const html=renderPresentation(createElement(Reports,{c:reportController(slot)}));assert.ok(!html.includes('商品總數'));assert.ok(!html.includes('合作店家 1 間'));assert.ok(!html.includes('預留筆數'));assert.ok(!html.includes('下載 CSV'));if(slot.state==='failed'){assert.ok(html.includes(slot.error));assert.ok(html.includes('重試'));}
 }
 const mismatch={...reportFixture(),tenant_id:other};assert.ok(!renderPresentation(createElement(Reports,{c:reportController(readySlot(mismatch))})).includes('商品總數'));
 const oldKey=renderPresentation(createElement(Reports,{c:reportController(readySlot(reportFixture()),{reportPeriod:{from:'2026-10-02',to:'2026-10-15'}})}));assert.ok(!oldKey.includes('商品總數'));
});
test('SC-UI-S3-15 ready report links products, partners and reservations using the exact Taipei period',()=>{
 const html=renderPresentation(createElement(Reports,{c:reportController(readySlot(reportFixture()))}));
 assert.equal((html.match(/<h2/g)??[]).length,1);assert.ok(html.includes('aria-label="報表期間"'));assert.ok(html.includes('期間起（台灣時間）'));assert.ok(html.includes('回到最近 30 天'));assert.ok(html.includes('合作店家 1 間'));assert.ok(html.includes('$450.00'));
 for(const state of ['offered','not_offered','outdated','out_of_stock'] as const)assert.ok(html.includes(href(scope,'products',{state})));assert.ok(html.includes(href(scope,'partner',{id})));
 for(const state of ['reserved','cancelled','expired'] as const)assert.ok(html.includes(href(scope,'reservations',{reservation:{state,...reportPeriod}}).replaceAll('&','&amp;')));
 assert.ok(html.includes('預留供貨金額是數量乘以供貨單價，不是營收、請款、付款或佣金。'));assert.ok(html.includes('本檔不是完整資料匯出，也不是備份或搬家用的資料包。'));assert.ok(html.includes('下載 CSV'));
 assert.ok(html.indexOf('下載 CSV')>html.indexOf('預留（期間內建立）'));
});
test('SC-UI-S3-16 non-owner report omits all reservation rows and truncated partners explain CSV completeness',()=>{
 const data=reportFixture();data.reservations={state:'unavailable',reason:'owner_required'};data.cooperation.partner_count=201;data.cooperation.partners=Array.from({length:200},(_,n)=>({...data.cooperation.partners[0],partner_id:`partner-${n}`}));
 const html=renderPresentation(createElement(Reports,{c:reportController(readySlot(data))}));
 assert.ok(html.includes('只有業務空間擁有者可以查看預留。'));assert.ok(!html.includes('預留筆數'));assert.ok(!html.includes('>查看預留</a>'));assert.ok(!html.includes('預留供貨金額是數量'));assert.ok(html.includes('畫面只列前 200 間，CSV 列出全部店家。'));assert.ok(html.includes('下載 CSV'));
});

import {holdMaterialUpload,heldMaterialUpload,restoreMaterialUpload,releaseMaterialUpload,forgetRefusedMaterialUpload,materialAcknowledgement,materialUploadTargets,materialUploadBlocksLeaving,type MaterialUploadAttempt} from '../../modules/agent-commerce/supplier-console/state/material-upload';
import {materialCapacityText,materialCapacityProblem,materialVersionSummary,materialTime,materialSubject,materialContentPath,sellableMaterialPartners} from '../../modules/agent-commerce/supplier-console/ui/view';
import {materialFileProblem,sendMaterialUpload,MATERIAL_VIDEO_PROBLEM,MATERIAL_UPLOAD_UNKNOWN} from '../../modules/agent-commerce/supplier-console/ui/material-client';
import {SupplyMaterialReceiptSchema,SupplyMaterialSchema,SupplyMaterialsSchema,SupplyMaterialDetailSchema,SupplyMaterialCreateInputSchema,type SupplyMaterialVersion,type SupplyMaterialDetail} from '../../contracts/guild-launchpad/v1/supplier-console';
import {Materials} from '../../modules/agent-commerce/supplier-console/ui/pages/Materials';
import {MaterialNew} from '../../modules/agent-commerce/supplier-console/ui/pages/MaterialNew';
import {Material} from '../../modules/agent-commerce/supplier-console/ui/pages/Material';
const uploadAttempt=(changes:Partial<MaterialUploadAttempt>={}):MaterialUploadAttempt=>Object.freeze({...scope,materialId:id,key:'material-original-key',expected:'9',file:new File(['original'],'image.png',{type:'image/png'}),hadUnknown:false,...changes});
const materialReceipt={material_id:id,version:'10'};
const materialVersion:SupplyMaterialVersion={version_id:other,version_no:1,created_at:asOf,content:{kind:'copy',body:'第一行\n第二行 <script>不要執行</script>'}};
const materialFixture=()=>SupplyMaterialSchema.parse({material_id:id,kind:'copy',subject:{kind:'brand'},title:'品牌介紹',description:'合作素材',access:'partners',state:'active',version:'9',created_at:asOf,updated_at:asOf,withdrawn_at:null,current:materialVersion,version_count:1,active_grants:0});
const capacityReady={state:'ready' as const,limit_bytes:100*1048576,used_bytes:24*1048576,reserved_bytes:1048576,remaining_bytes:75*1048576};
const materialListFixture=()=>SupplyMaterialsSchema.parse({profile:'freedom.supplier-console.materials/v1',tenant_id:t,instance_id:i,as_of:asOf,capacity:capacityReady,active:1,total:1,items:[materialFixture()],truncated:false});
const materialDetailFixture=():SupplyMaterialDetail=>SupplyMaterialDetailSchema.parse({profile:'freedom.supplier-console.material/v1',tenant_id:t,instance_id:i,as_of:asOf,material:materialFixture(),versions:[materialVersion],versions_truncated:false,grants:[],grants_truncated:false,partners:[],partners_truncated:false});
function materialController(slots:Record<string,ReadSlot<unknown>>={},extra:Record<string,unknown>={}){return presentationController(slots,{client:new PortalClient(),userId:'member',root:`/tenants/${t}/storefronts/${i}`,route:parse(root+'/materials'),drafts:{},conflicts:{},materialStates:{},sectionStatus:{},phase:'idle',position:()=>({search:'',filter:'',sort:'sku',scroll:0,lastId:null}),...extra});}

test('SC-UI-M3-01 materials list, create and detail routes round-trip and invalid forms stay not-found',()=>{
 for(const [page,suffix] of [['materials','/materials'],['material-new','/materials/new'],['material','/materials/'+id]] as const){const path=href(scope,page,{id});assert.equal(path,root+suffix);assert.equal(parse(path)?.page,page);assert.equal(parse(path)?.titleKey,'supplierConsole.'+page);}
 for(const suffix of ['/materials/bad','/materials/%2e%2e','/materials/'+id+'/content','/materials/new/extra','/materials/','/materials/'+id+'/'])assert.equal(parse(root+suffix)?.page,'not-found',suffix);
 for(const page of ['material','material-new'] as const)assert.equal(SUPPLIER_CONSOLE_PAGES.find(p=>p.page===page)?.parent,'materials');
});
test('SC-UI-M3-02 materials navigation precedes reports and is hidden without store:write',()=>{
 for(const owner of [true,false]){const pages=consoleNavigation(['store:read','store:write'],owner).map(p=>p.page);assert.equal(pages.indexOf('materials')+1,pages.indexOf('reports'));assert.ok(!consoleNavigation(['store:read'],owner).some(p=>p.page==='materials'));}
 assert.equal(SUPPLIER_CONSOLE_PAGES.find(p=>p.page==='materials')?.requires,'write');assert.equal(SUPPLIER_CONSOLE_PAGES.find(p=>p.page==='materials')?.group,'管理');
});
test('SC-UI-M3-03 each material JSON attempt validates receipts, target acknowledgement and refresh reads',()=>{
 for(const kind of ['material.create','material.update','material.copy','material.access','material.grant','material.revoke','material.withdraw'] as const){
  const rule=ATTEMPT_KINDS[kind],a=attempt({kind,target:id});assert.equal(rule.schema,SupplyMaterialReceiptSchema);assert.equal(rule.ack,kind==='material.create'?null:'material_id');assert.deepEqual(rule.reads,['materials','material']);assert.equal(classifyCommandOutcome(a,{response:materialReceipt}).state,'success');
  for(const response of [{material_id:id},{material_id:id,version:10},{...materialReceipt,unexpected:true}])assert.equal(classifyCommandOutcome(a,{response}).state,'unknown');
  assert.equal(classifyCommandOutcome(a,{response:{material_id:other,version:'10'}}).state,kind==='material.create'?'success':'unknown');
  const c={};holdAttempt(c,'member',a);markAttemptUnknown(c,'member',a);assert.equal(restoreAttempt(c,'member',scope),a);assert.equal(a.key,'test-key');assert.equal(a.ifMatch,'1');releaseAttempt(c,'member',a);
 }
});
test('SC-UI-M3-04 binary registry isolates client, member, business and material and preserves the exact File',()=>{
 const client={},a=uploadAttempt();holdMaterialUpload(client,'member',a);assert.equal(heldMaterialUpload(client,'member',a)?.file,a.file);
 for(const [c,member,target] of [[{},'member',a],[client,'another',a],[client,'member',{...a,materialId:other}],[client,'member',{...a,tenantId:other}],[client,'member',{...a,instanceId:other}]] as const)assert.equal(heldMaterialUpload(c,member,target),null);
 const b=uploadAttempt({materialId:other});holdMaterialUpload(client,'member',b);assert.deepEqual(materialUploadTargets(client,'member',scope),[id,other]);
 assert.equal(releaseMaterialUpload(client,'member',{...a,key:'wrong'}),false);assert.equal(releaseMaterialUpload(client,'member',{...a,expected:'10'}),false);assert.equal(releaseMaterialUpload(client,'member',{...a,file:new File(['original'],'image.png',{type:'image/png'})}),false);
 const restored=restoreMaterialUpload(client,'member',a)!;assert.equal(restored.hadUnknown,true);assert.equal(restored.file,a.file);assert.equal(restored.key,a.key);assert.equal(restored.expected,a.expected);
 holdMaterialUpload(client,'member',a);assert.equal(heldMaterialUpload(client,'member',a)?.hadUnknown,true);assert.throws(()=>holdMaterialUpload(client,'member',{...a,key:'replacement'}));
 assert.equal(forgetRefusedMaterialUpload(client,'member',a),false);assert.ok(heldMaterialUpload(client,'member',a));assert.equal(releaseMaterialUpload(client,'member',a),true);assert.equal(heldMaterialUpload(client,'member',a),null);assert.equal(forgetRefusedMaterialUpload(client,'member',b),true);assert.equal(materialUploadTargets(client,'member',scope).length,0);
});
test('SC-UI-M3-05 a held or restored material upload blocks leaving but allows internal console navigation',()=>{
 const state={sending:false,held:false,photoBlocking:false,materialBlocking:true,dirty:true};
 assert.equal(leaveDecision(root+'/materials/'+id,scope,state).allow,true);
 for(const next of [null,'#home',href({tenantId:other,instanceId:i},'overview')]){const blocked=leaveDecision(next,scope,state);assert.equal(blocked.allow,false);assert.equal(blocked.confirm,false);assert.equal(blocked.message,'尚未確認原操作的結果，請按「重試」確認後再離開。');}
 assert.equal(materialUploadBlocksLeaving(uploadAttempt()),true);assert.equal(materialUploadBlocksLeaving(uploadAttempt({hadUnknown:true})),true);assert.equal(materialUploadBlocksLeaving(null),false);
});
test('SC-UI-M3-06 beforeunload protects held files and releases its listener after the last matching release',()=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'window'),target=new EventTarget(),client={},a=uploadAttempt();
 Object.defineProperty(globalThis,'window',{configurable:true,value:target});
 try{holdMaterialUpload(client,'member',a);let event=new Event('beforeunload',{cancelable:true});target.dispatchEvent(event);assert.equal(event.defaultPrevented,true);releaseMaterialUpload(client,'member',a);event=new Event('beforeunload',{cancelable:true});target.dispatchEvent(event);assert.equal(event.defaultPrevented,false);}
 finally{releaseMaterialUpload(client,'member',a);if(previous)Object.defineProperty(globalThis,'window',previous);else Reflect.deleteProperty(globalThis,'window');}
});
test('SC-UI-M3-07 upload receipt must name the exact material and expected+1 bigint version',()=>{
 const a=uploadAttempt();assert.deepEqual(materialAcknowledgement(materialReceipt,a),materialReceipt);
 for(const value of [{material_id:other,version:'10'},{material_id:id,version:'9'},{material_id:id,version:'11'},{material_id:id,version:10},{...materialReceipt,extra:true}])assert.equal(materialAcknowledgement(value,a),null);
 assert.ok(materialAcknowledgement({material_id:id,version:'9007199254740994'},uploadAttempt({expected:'9007199254740993'})));
});
test('SC-UI-M3-08 upload sends the same raw File, key, CAS and CSRF and accepts only exact acknowledgement',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';const a=uploadAttempt();let calls=0;
 const fetch=ctx.mock.method(globalThis,'fetch',async(input:RequestInfo|URL,init:RequestInit)=>{calls++;assert.equal(input,`/api/v1/tenants/${t}/storefronts/${i}/supply-materials/${id}/content`);assert.equal(init.body,a.file);assert.equal(init.method,'POST');assert.equal(init.credentials,'same-origin');assert.equal(init.redirect,'manual');const h=new Headers(init.headers);for(const [key,value] of [['Content-Type',a.file.type],['Idempotency-Key',a.key],['If-Match','"9"'],['X-CSRF-Token','session-a'],['X-Requested-With','XMLHttpRequest']])assert.equal(h.get(key),value);return Response.json(materialReceipt);});
 assert.deepEqual(await sendMaterialUpload(client,a),materialReceipt);assert.deepEqual(await sendMaterialUpload(client,a),materialReceipt);assert.equal(calls,2);
 for(const body of [{material_id:other,version:'10'},{material_id:id,version:'11'}]){fetch.mock.mockImplementation(async()=>Response.json(body));await assert.rejects(sendMaterialUpload(client,a),(e:unknown)=>e instanceof ApiError&&e.network&&e.message===MATERIAL_UPLOAD_UNKNOWN);}
});
test('SC-UI-M3-09 coded refusals keep server messages; malformed refusals and server errors are unknown',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';const a=uploadAttempt();const fetch=ctx.mock.method(globalThis,'fetch',async()=>Response.json({detail:'素材檔案上傳目前無法使用。',code:'material_upload_unavailable'},{status:503}));
 await assert.rejects(sendMaterialUpload(client,a),(e:unknown)=>e instanceof ApiError&&e.network);
 for(const [status,code,detail] of [[412,'version_conflict','素材已更新'],[415,'material_format','圖片請選擇 PNG、JPEG 或 WebP；影片請選擇 MP4 或 WebM。'],[429,'quota_exceeded','已達到這個業務空間的容量上限。']] as const){fetch.mock.mockImplementation(async()=>Response.json({detail,code},{status}));await assert.rejects(sendMaterialUpload(client,a),(e:unknown)=>e instanceof ApiError&&!e.network&&e.status===status&&e.code===code&&e.message===detail);}
 fetch.mock.mockImplementation(async()=>Response.json({detail:'不完整拒絕'},{status:409}));await assert.rejects(sendMaterialUpload(client,a),(e:unknown)=>e instanceof ApiError&&e.network);
});
test('SC-UI-M3-10 session changes at fetch or response-body completion cannot update credentials or accept an upload',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
 const fetch=ctx.mock.method(globalThis,'fetch',async()=>{client.csrfToken='session-b';return new Response('Access',{status:403});});
 await assert.rejects(sendMaterialUpload(client,uploadAttempt()),(e:unknown)=>e instanceof ApiError&&e.network);assert.equal(client.csrfToken,'session-b');assert.equal(unauthorized,0);
 let finish!:()=>void;const response=new Response(new ReadableStream({start(controller){finish=()=>{controller.enqueue(new TextEncoder().encode(JSON.stringify(materialReceipt)));controller.close();};}}),{headers:{'Content-Type':'application/json'}});
 fetch.mock.mockImplementation(async()=>response);const pending=sendMaterialUpload(client,uploadAttempt());await new Promise(resolve=>setImmediate(resolve));client.csrfToken='session-c';finish();await assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.network);assert.equal(unauthorized,0);
});
test('SC-UI-M3-11 Access expiry and JSON 401 preserve unknown outcomes and notify the current session',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';let unauthorized=0;client.onUnauthorized=()=>{unauthorized++;};
 const fetch=ctx.mock.method(globalThis,'fetch',async()=>new Response('Access',{status:403}));await assert.rejects(sendMaterialUpload(client,uploadAttempt()),(e:unknown)=>e instanceof ApiError&&e.accessExpired);assert.equal(client.csrfToken,null);assert.equal(unauthorized,1);
 client.csrfToken='session-b';fetch.mock.mockImplementation(async()=>Response.json({detail:'expired',code:'session_expired'},{status:401}));await assert.rejects(sendMaterialUpload(client,uploadAttempt()),(e:unknown)=>e instanceof ApiError&&e.status===401);assert.equal(client.csrfToken,null);assert.equal(unauthorized,2);
});
test('SC-UI-M3-12 stalled uploads time out as unknown and abort the transport',async ctx=>{
 ctx.mock.timers.enable({apis:['setTimeout']});const client=new PortalClient();client.csrfToken='session-a';let signal:AbortSignal|null|undefined;
 ctx.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init:RequestInit)=>{signal=init.signal;return new Promise<Response>(()=>{});});const pending=sendMaterialUpload(client,uploadAttempt());ctx.mock.timers.tick(60_000);await assert.rejects(pending,(e:unknown)=>e instanceof ApiError&&e.network&&e.timedOut);assert.equal(signal?.aborted,true);
});
test('SC-UI-M3-13 shared capacity formats binary MB with one decimal and unavailable never means zero',()=>{
 assert.equal(materialCapacityText(capacityReady),'業務空間已用 24.0 MB，處理中 1.0 MB，上限 100.0 MB，還可使用 75.0 MB。');
 for(const c of [undefined,{state:'unavailable' as const}]){assert.equal(materialCapacityText(c),'目前無法讀取業務空間容量。');assert.ok(!materialCapacityText(c).includes('0'));assert.equal(materialCapacityProblem(c,'video'),null);}
 assert.equal(materialCapacityProblem({...capacityReady,remaining_bytes:1048576},'image'),null);assert.match(materialCapacityProblem({...capacityReady,remaining_bytes:1048575},'image')!,/預留 1 MB/);assert.match(materialCapacityProblem({...capacityReady,remaining_bytes:20*1048576-1},'video')!,/預留 20 MB/);
});
test('SC-UI-M3-14 version summaries, subject labels, private paths and Taiwan times',()=>{
 assert.equal(materialVersionSummary({...materialVersion,content:{kind:'image',width:1920,height:960,byte_size:1048576,content_type:'image/webp'}}),'1920×960・1.0 MB');assert.equal(materialVersionSummary({...materialVersion,content:{kind:'video',byte_size:20*1048576,content_type:'video/mp4'}}),'video/mp4・20.0 MB');
 assert.equal(materialVersionSummary({...materialVersion,content:{kind:'copy',body:'字'.repeat(61)}}),'字'.repeat(60));assert.equal(materialVersionSummary(materialVersion),materialVersion.content.kind==='copy'?materialVersion.content.body:'');
 assert.equal(materialSubject({kind:'brand'}),'品牌素材');assert.equal(materialSubject({kind:'product',product_id:other,sku:null,title:null}),'商品已移除');assert.equal(materialSubject({kind:'product',product_id:other,sku:'P0001',title:'茶杯'}),'商品 P0001・茶杯');assert.equal(materialContentPath(scope,id,other),`/api/v1/tenants/${t}/storefronts/${i}/supply-materials/${id}/versions/${other}/content`);assert.match(materialTime('2026-10-15T16:00:00Z'),/2026\/10\/16\s00:00:00/);
});
test('SC-UI-M3-15 bulk grant selection includes only ungranted sellable shops',()=>{
 const partners=[{partner_id:id,name:'可售',cooperation:'sellable' as const,granted:false},{partner_id:other,name:'待確認',cooperation:'awaiting' as const,granted:false},{partner_id:t,name:'已授權',cooperation:'sellable' as const,granted:true}];assert.deepEqual(sellableMaterialPartners(partners),[id]);assert.deepEqual(sellableMaterialPartners([]),[]);assert.equal(partners[1].granted,false);
});
test('SC-UI-M3-16 image and video prechecks enforce exact source MIME, nonempty bytes and boundaries',()=>{
 for(const type of ['video/mp4','video/webm']){assert.equal(materialFileProblem('video',{type,size:20*1048576}),null);for(const size of [0,20*1048576+1])assert.equal(materialFileProblem('video',{type,size}),MATERIAL_VIDEO_PROBLEM);}
 for(const type of ['video/quicktime','image/png','application/octet-stream','VIDEO/MP4'])assert.equal(materialFileProblem('video',{type,size:10}),MATERIAL_VIDEO_PROBLEM);
 for(const type of ['image/png','image/jpeg','image/webp']){assert.equal(materialFileProblem('image',{type,size:2*1048576}),null);assert.ok(materialFileProblem('image',{type,size:2*1048576+1}));assert.ok(materialFileProblem('image',{type,size:0}));}
 for(const type of ['image/svg+xml','image/gif','video/mp4'])assert.ok(materialFileProblem('image',{type,size:10}));
});
test('SC-UI-M3-17 create validation trims and rejects controls, missing text, excessive lengths and foreign-shaped subjects',()=>{
 const base={kind:'copy',product_id:null,title:' 標題 ',description:' 說明\n第二行 ',body:' 文案 '};assert.deepEqual(SupplyMaterialCreateInputSchema.parse(base),{...base,title:'標題',description:'說明\n第二行',body:'文案'});
 for(const bad of [{title:''},{title:'字'.repeat(81)},{title:'標\n題'},{description:'\t'},{description:'字'.repeat(501)},{body:'字'.repeat(2001)},{body:' '},{body:'\u007f'},{product_id:'bad'}])assert.equal(SupplyMaterialCreateInputSchema.safeParse({...base,...bad}).success,false);
});
test('SC-UI-M3-18 list states preserve failures, capacity unavailability, active ordering and ready empty guidance',()=>{
 for(const slot of [{...failedSlot,state:'idle' as const},{...failedSlot,state:'loading' as const},failedSlot,{...failedSlot,status:403}]){const html=renderPresentation(createElement(Materials,{c:materialController({materials:slot})}));assert.ok(!html.includes('使用中 0'));assert.ok(html.includes('目前無法讀取業務空間容量。'));if(slot.state==='failed'){assert.ok(html.includes('讀取服務暫停'));assert.ok(html.includes('重試'));}}
 const data=materialListFixture();const html=renderPresentation(createElement(Materials,{c:materialController({materials:readySlot(data)})}));for(const text of ['使用中 1／200','品牌介紹','品牌素材','文案','僅授權的合作店家','第 1 版','已授權 0 間店','新增素材'])assert.ok(html.includes(text),text);
 const empty={...data,items:[],active:0,total:0};assert.ok(renderPresentation(createElement(Materials,{c:materialController({materials:readySlot(empty)})})).includes('還沒有行銷素材'));
 const stale=renderPresentation(createElement(Materials,{c:materialController({materials:{...failedSlot,data}})}));assert.ok(stale.includes('目前無法讀取業務空間容量。'));assert.ok(!stale.includes('還可使用 75.0'));
});
test('SC-UI-M3-19 detail escapes copy, shows 404 recovery, confirmations and withdrawn read-only data',()=>{
 const detail=materialDetailFixture(),c=materialController({['material:'+id]:readySlot(detail)}),html=renderPresentation(createElement(Material,{c,id,mediaEnabled:false,uploadsEnabled:false,active:true}));
 for(const text of ['素材詳情','複製文字','儲存為新版本','合作店家可以把這個版本用在他們的公開店面。','確認開放','已被下載的副本無法收回。撤回後不能復原。','之後新加入的合作店家不會自動取得授權。'])assert.ok(html.includes(text),text);assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));
 const missing=renderPresentation(createElement(Material,{c:materialController({['material:'+id]:{...failedSlot,status:404}}),id,mediaEnabled:false,uploadsEnabled:false,active:true}));assert.ok(missing.includes('找不到這個素材。'));assert.ok(missing.includes(href(scope,'materials')));
 const withdrawn={...detail,material:{...detail.material,state:'withdrawn' as const,withdrawn_at:asOf}};const readOnly=renderPresentation(createElement(Material,{c:materialController({['material:'+id]:readySlot(withdrawn)}),id,mediaEnabled:false,uploadsEnabled:false,active:true}));assert.ok(readOnly.includes('已撤回'));for(const text of ['儲存為新版本','確認撤回素材','確認開放','授權選取的店家','編輯標題與說明'])assert.ok(!readOnly.includes(text),text);
});
test('SC-UI-M3-20 image and video content respect flags and all version links use the private API path',()=>{
 for(const kind of ['image','video'] as const){const content=kind==='image'?{kind,content_type:'image/webp' as const,byte_size:1024,width:100,height:50}:{kind,content_type:'video/mp4' as const,byte_size:1024};const v={...materialVersion,content},d={...materialDetailFixture(),material:{...materialFixture(),kind,current:v},versions:[v]};
  const c=materialController({['material:'+id]:readySlot(d),materials:readySlot(materialListFixture())});const off=renderPresentation(createElement(Material,{c,id,mediaEnabled:false,uploadsEnabled:false,active:true}));assert.ok(off.includes('這個環境未開放素材檔案。'));assert.ok(off.includes('這個環境未開放素材檔案上傳。'));assert.ok(!off.includes('/versions/'));
  const on=renderPresentation(createElement(Material,{c,id,mediaEnabled:true,uploadsEnabled:true,active:true}));assert.ok(on.includes(materialContentPath(scope,id,v.version_id)));assert.ok(on.includes(kind==='image'?'width="100" height="50"':'preload="metadata"'));assert.ok(on.includes('選擇'+(kind==='image'?'圖片':'影片')));
 }
});
test('SC-UI-M3-21 new material form reuses retained drafts, own product options and live counters',()=>{
 const c=materialController({products:readySlot({items:[{...products[0],product_id:other}]})},{drafts:{'material:new':{baseVersion:'',fields:{kind:'copy',title:'文案標題',body:'待儲存文案'}}}});const html=renderPresentation(createElement(MaterialNew,{c}));for(const text of ['新增素材','品牌素材','P0001・商品 1','文案內容','文案標題','待儲存文案','4／80','5／2000','建立素材'])assert.ok(html.includes(text),text);assert.ok(!html.includes('即將推出'));
});
import {materialMatchesReadKey} from '../../modules/agent-commerce/supplier-console/state/useSupplierConsoleController';
test('SC-UI-M3-22 material reads reject a different business or detail target before publishing data',()=>{
 const data=materialDetailFixture();assert.equal(materialMatchesReadKey(data,scope,'material:'+id),true);assert.equal(materialMatchesReadKey(materialListFixture(),scope,'materials'),true);
 for(const value of [{...data,tenant_id:other},{...data,instance_id:other},{...data,material:{...data.material,material_id:other}}])assert.equal(materialMatchesReadKey(value,scope,'material:'+id),false);
 assert.equal(materialMatchesReadKey(data,scope,'material:'+other),false);assert.equal(materialMatchesReadKey(data,scope,'unrecognized'),false);
});
test('SC-UI-M3-23 a retry after an uncertain response cannot forget or replace the original upload tuple',async ctx=>{
 const client=new PortalClient();client.csrfToken='session-a';const a=uploadAttempt(),bodies:unknown[]=[],keys:(string|null)[]=[],versions:(string|null)[]=[];let calls=0;
 ctx.mock.method(globalThis,'fetch',async(_input:RequestInfo|URL,init:RequestInit)=>{bodies.push(init.body);keys.push(new Headers(init.headers).get('Idempotency-Key'));versions.push(new Headers(init.headers).get('If-Match'));if(++calls===1)throw new Error('lost response');return Response.json(materialReceipt);});
 holdMaterialUpload(client,'member',a);
 await assert.rejects(sendMaterialUpload(client,a),(e:unknown)=>e instanceof ApiError&&e.network);const original=restoreMaterialUpload(client,'member',a)!;assert.equal(original.hadUnknown,true);assert.equal(forgetRefusedMaterialUpload(client,'member',a),false);
 assert.throws(()=>holdMaterialUpload(client,'member',{...a,expected:'10',key:'new-key'}));const receipt=await sendMaterialUpload(client,original);assert.equal(receipt.material_id,id);assert.equal(releaseMaterialUpload(client,'member',original),true);assert.equal(heldMaterialUpload(client,'member',a),null);assert.deepEqual(bodies,[a.file,a.file]);assert.deepEqual(keys,[a.key,a.key]);assert.deepEqual(versions,['"9"','"9"']);
});
import {markMaterialUploadUnknown} from '../../modules/agent-commerce/supplier-console/state/material-upload';
test('SC-UI-M3-24 a late unknown response cannot resurrect a completed upload or disturb a newer tuple',()=>{
 const client={},a=uploadAttempt();holdMaterialUpload(client,'member',a);assert.equal(markMaterialUploadUnknown(client,'member',a),true);assert.equal(heldMaterialUpload(client,'member',a)?.hadUnknown,true);releaseMaterialUpload(client,'member',a);assert.equal(markMaterialUploadUnknown(client,'member',a),false);assert.equal(heldMaterialUpload(client,'member',a),null);
 const b=uploadAttempt({key:'new-key'});holdMaterialUpload(client,'member',b);assert.equal(markMaterialUploadUnknown(client,'member',a),false);assert.equal(heldMaterialUpload(client,'member',b)?.key,b.key);assert.equal(heldMaterialUpload(client,'member',b)?.hadUnknown,false);releaseMaterialUpload(client,'member',b);
});
