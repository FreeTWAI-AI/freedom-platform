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
test('SC-UI-S2-04 local calendar dates become ISO half-open bounds including month/year and DST transitions',()=>{
 const before=process.env.TZ;
 try{
  process.env.TZ='Asia/Taipei';
  const q=reservationFilterParams({state:'reserved',partner:id,product:other,from:'2026-10-01',to:'2026-10-15'})!;
  assert.deepEqual(Object.fromEntries(q),{state:'reserved',partner_id:id,product_id:other,from:'2026-09-30T16:00:00.000Z',to:'2026-10-15T16:00:00.000Z'});
  assert.deepEqual(Object.fromEntries(reservationFilterParams({from:'2026-12-31',to:'2026-12-31'})!),{from:'2026-12-30T16:00:00.000Z',to:'2026-12-31T16:00:00.000Z'});
  assert.equal(reservationFilterParams({to:'2024-02-29'})?.get('to'),'2024-02-29T16:00:00.000Z');
  assert.equal(reservationFilterParams({from:'2026-02-30'}),null);assert.equal(reservationFilterParams({to:'bad'}),null);
  assert.equal(reservationFilterParams({from:'2026-10-16',to:'2026-10-15'}),null);
  assert.equal(reservationFilterParams({})?.size,0);
  process.env.TZ='America/New_York';
  const dst=reservationFilterParams({from:'2026-03-08',to:'2026-03-08'})!;
  assert.equal(dst.get('from'),'2026-03-08T05:00:00.000Z');assert.equal(dst.get('to'),'2026-03-09T04:00:00.000Z');
  const fall=reservationFilterParams({from:'2026-11-01',to:'2026-11-01'})!;
  assert.equal(fall.get('from'),'2026-11-01T04:00:00.000Z');assert.equal(fall.get('to'),'2026-11-02T05:00:00.000Z');
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
