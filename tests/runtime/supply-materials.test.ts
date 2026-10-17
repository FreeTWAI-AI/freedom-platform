import assert from 'node:assert/strict';
import {after,before,beforeEach,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {digest} from '../../packages/db/index.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {capacitySummary} from '../../modules/opportunity-project-work/tenant-capacity.js';
import {SupplyMaterialsSchema,SupplyMaterialDetailSchema,PartnerMaterialsSchema} from '../../contracts/guild-launchpad/v1/supplier-console.js';
import {readPartnerMaterial} from '../../modules/agent-commerce/supplier-console/materials.js';
import {withTenantRead} from '../../packages/resource-scopes/index.js';
import {storeCapabilities} from '../../modules/agent-commerce/hosted/capabilities.js';
import {authenticate} from '../../modules/identity-membership/service.js';
import {TENANT_CURSOR_TEST_KEY} from './tenant-cursor-fixture.js';
import {createRegistryHarness,type RegistryHarness,type Reply,type Session} from './module-registry-harness.js';

const supplierGuild='guild_product_quality_supply',retailGuild='guild_commerce_sales';
const catalog={name:'合成供貨目錄',description:'只提供供貨資料',currency:'TWD'};
const product={title:'供貨茶杯',description:'經授權的商品介紹',cost_minor:400,stock:100};
const terms={cost_minor:400,shipping_minor:50,shipping_terms:'確認後三天出貨',return_terms:'瑕疵請聯絡供貨方'};
type Store={owner:Session;tenantId:string;instanceId:string;root:string};
let h:RegistryHarness,runtime:Pool,app:ReturnType<typeof createApp>,closed:ReturnType<typeof createApp>;
let fault:((row:any)=>void)|undefined;
const allStatements:string[]=[];
const statements:{text:string;values:any[]}[]=[],role=`supply_materials_${process.pid}_${Date.now()}`;
const ok=(reply:Reply,status=200)=>{assert.equal(reply.status,status,JSON.stringify(reply.data));return reply.data;};
const get=(s:Store,path:string,session=s.owner,target=app)=>h.call('GET',s.root+path,session,undefined,{},target);
const send=(s:Store,path:string,body:unknown={},version?:string,method='POST',session=s.owner)=>
  h.call(method,s.root+path,session,body,{'Idempotency-Key':randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},app);
const profileRow=async(s:Store)=>(await h.pool.query('SELECT * FROM commerce_storefront_profiles WHERE instance_id=$1',[s.instanceId])).rows[0];
async function open(name:string,guild=supplierGuild,owner?:Session,release='hosted-store@1.0.0'):Promise<Store> {
  owner??=(await h.person(name)).session;await h.fullMember(owner.user.user_id,guild);
  const {tenantId,workspaceId}=await h.createTenant(owner,name);
  const planned=await h.plan(owner,tenantId,h.planBody(guild,workspaceId,'hosted-store',release));ok(planned,201);
  const launched=await h.launch(owner,tenantId,planned);assert.ok([200,202].includes(launched.status),JSON.stringify(launched.data));
  assert.equal(launched.data.state,'succeeded');
  const instanceId=(await h.pool.query("SELECT instance_id FROM module_instances WHERE tenant_id=$1 AND module_key='storefront'",[tenantId])).rows[0].instance_id;
  return {owner,tenantId,instanceId,root:`/tenants/${tenantId}/storefronts/${instanceId}`};
}
async function supplier(name=catalog.name,owner?:Session) {
  const s=await open(name,supplierGuild,owner);ok(await send(s,'/supply-profile',{...catalog,name}),201);return s;
}
async function retailer(name='零售 B') {
  const s=await open(name,retailGuild);ok(await send(s,'/setup',{name,slug:`retail-${randomUUID().slice(0,12)}`,currency:'TWD'}),201);return s;
}
async function supplyProduct(s:Store,input=product) {
  const made=ok(await send(s,'/supply-products',input),201);
  const item=ok(await get(s,'/supply-products')).items.find((r:any)=>r.product_id===made.product_id);
  const saved=ok(await send(s,`/products/${item.product_id}/supply-terms`,{...terms,cost_minor:input.cost_minor},item.version,'PATCH'));
  return {...item,version:saved.version};
}
const offer=async(s:Store,item:any)=>ok(await send(s,`/products/${item.product_id}/supply-offer`,{},item.version));
const propose=async(s:Store,o:any)=>ok(await send(s,'/distribution-selections',{offer_id:o.offer_id,terms_sha256:o.terms_sha256,retail_price_minor:1200}),201);
const accept=async(s:Store,l:any)=>ok(await send(s,`/supply-requests/${l.selection_id}/decision`,{decision:'accepted',listing_sha256:l.listing_sha256},l.version));
async function invite(s:Store,person:Session,capabilities:string[],memberRole:'operator'|'admin'|'viewer'='operator') {
  const principal=await h.candidate(s.owner,person.user.user_id);
  const invitation=await h.post(`/tenants/${s.tenantId}/invitations`,s.owner,{invitee_principal_id:principal,role:memberRole,
    instance_capabilities:capabilities.length?[{instance_id:s.instanceId,capabilities}]:[],expires_at:new Date(Date.now()+86400000).toISOString()});
  ok(invitation,201);await h.accept(person,s.tenantId,invitation);return principal;
}
function privateReply(reply:Reply) {
  assert.equal(reply.response.headers.get('cache-control'),'private, no-store');assert.match(reply.response.headers.get('vary')??'',/Cookie/);
}
before(async()=>{
  const url=process.env.TEST_DATABASE_URL;
  assert.ok(url&&['127.0.0.1','localhost'].includes(new URL(url).hostname)&&new URL(url).pathname.startsWith('/fp_'));
  h=await createRegistryHarness('fp_supply_materials');
  await h.admin.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    GRANT USAGE ON SCHEMA ${h.schema} TO ${role}; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA ${h.schema} TO ${role};
    GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA ${h.schema} TO ${role}; GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${h.schema} TO ${role}`);
  const runtimeUrl=new URL(url);runtimeUrl.username=role;runtimeUrl.password='';
  runtime=new Pool({connectionString:runtimeUrl.toString(),options:`-c search_path=${h.schema} -c statement_timeout=20000`,max:6});
  runtime.on('connect',client=>{
    const native=client.query;
    client.query=function(this:typeof client,...args:any[]) {
      const first=args[0],text=typeof first==='string'?first:first?.text;
      if(text)allStatements.push(text);
      if(text?.includes('/* supplier-console:'))statements.push({text,values:args[1]??first?.values});
      const result=(native as Function).apply(this,args);
      if(text?.includes('/* supplier-console:')&&fault)return result.then((result:any)=>{fault!(result.rows[0]);return result;});
      return result;
    } as typeof client.query;
  });
  app=createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,supplierConsoleEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
  closed=createApp(runtime,h.origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});
});
after(async()=>{
  await runtime?.end();if(h){await h.stop();const admin=new Pool({connectionString:process.env.TEST_DATABASE_URL});
    try{await admin.query(`DROP ROLE ${role}`);}finally{await admin.end();}}
});
beforeEach(async()=>{
  fault=undefined;await h.reset();statements.length=0;allStatements.length=0;
  for(const guild of [supplierGuild,retailGuild])await h.pool.query(`INSERT INTO guild_application_offerings
    (offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,'hosted-store','hosted-store@1.0.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)`,[randomUUID(),DEMO_COMMUNITY,guild]);
});
const materialInput=(kind='copy',product_id:string|null=null)=>({kind,product_id,title:'合作素材',description:'已授權的介紹',...(kind==='copy'?{body:'第一版文案'}:{})});
const make=async(s:Store,input=materialInput())=>ok(await send(s,'/supply-materials',input),201);
const path=(m:any,suffix='')=>`/supply-materials/${m.material_id}${suffix}`;
const detail=async(s:Store,m:any)=>SupplyMaterialDetailSchema.parse(ok(await get(s,path(m))));
const partnerId=async(s:Store)=>(await profileRow(s)).storefront_shop_id as string;
async function read(s:Store,path:string,schema:{parse:(v:unknown)=>any},session=s.owner) {
  allStatements.length=0;statements.length=0;const r=await get(s,path,session);privateReply(r);ok(r);
  assert.equal(statements.length,1);assert.doesNotMatch(statements[0].text,/FOR (?:UPDATE|SHARE)/i);
  assert.match(r.data.as_of,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);return schema.parse(r.data);
}
const list=(s:Store)=>read(s,'/supply-materials',SupplyMaterialsSchema);
const visible=(s:Store,session=s.owner)=>read(s,'/partner-materials',PartnerMaterialsSchema,session);
async function mutation(s:Store,m:any,suffix:string,body:unknown={},method='POST') {
  const key=randomUUID(),run=()=>h.call(method,s.root+path(m,suffix),s.owner,body,{'Idempotency-Key':key,'If-Match':`"${m.version}"`},app);
  const r=await run();privateReply(r);const data=ok(r);const replay=await run();privateReply(replay);assert.deepEqual(ok(replay),data);
  assert.deepEqual(Object.keys(data).sort(),['material_id','version']);assert.equal(data.version,String(BigInt(m.version)+1n));
  assert.equal(r.response.headers.get('etag'),`"${data.version}"`);return data;
}
async function refused(s:Store,m:any,suffix:string,body:unknown,code:string,status=409,method='POST') {
  const before=(await h.pool.query('SELECT aggregate_version FROM supply_materials WHERE material_id=$1',[m.material_id])).rows[0];
  const counts=(await h.pool.query(`SELECT (SELECT count(*) FROM supply_material_grants WHERE material_id=$1) AS grants,
    (SELECT count(*) FROM scoped_transition_journal WHERE aggregate_id=$1) AS facts`,[m.material_id])).rows[0];
  const r=await send(s,path(m,suffix),body,m.version,method);ok(r,status);privateReply(r);assert.equal(r.data.code,code);
  assert.deepEqual((await h.pool.query('SELECT aggregate_version FROM supply_materials WHERE material_id=$1',[m.material_id])).rows[0],before);
  assert.deepEqual((await h.pool.query(`SELECT (SELECT count(*) FROM supply_material_grants WHERE material_id=$1) AS grants,
    (SELECT count(*) FROM scoped_transition_journal WHERE aggregate_id=$1) AS facts`,[m.material_id])).rows[0],counts);
}
async function journey() {
  const a=await supplier('供應 A'),c=await supplier('供應 C'),b=await retailer('零售 B'),d=await retailer('零售 D');
  const item=await supplyProduct(a),other=await supplyProduct(a,{...product,title:'另一項商品'}),foreign=await supplyProduct(c);
  const o=await offer(a,item),o2=await offer(a,other),co=await offer(c,foreign);
  const lb=await accept(a,await propose(b,o)),ld=await propose(d,o2);await propose(b,o2);await propose(b,co);
  return {a,b,c,d,item,other,o,o2,lb,ld};
}

test('SC-09 records shapes, own product validation, capacity and fail-closed projections',async()=>{
  const a=await supplier(),c=await supplier('另一供應商'),b=await retailer(),item=await supplyProduct(a),foreign=await supplyProduct(c);
  const image=await make(a,materialInput('image')),video=await make(a,materialInput('video',item.product_id)),copy=await make(a);
  assert.equal(image.version,'1');assert.equal(copy.version,'2');
  const r=await list(a);assert.equal(r.active,3);assert.equal(r.total,3);assert.equal(r.truncated,false);
  assert.deepEqual(r.items.map((m:any)=>m.material_id),[copy.material_id,video.material_id,image.material_id]);
  const d=await read(a,path(copy),SupplyMaterialDetailSchema);assert.equal(d.material.current!.content.kind,'copy');assert.equal(d.material.version_count,1);
  assert.equal((await detail(a,image)).material.current,null);assert.deepEqual((await detail(a,video)).material.subject,{kind:'product',product_id:item.product_id,sku:item.sku,title:item.title});
  const actor=await authenticate(runtime,a.owner.cookie.split('=')[1].split(';')[0]);
  const capacity=await withTenantRead(runtime,{actor,tenantId:a.tenantId,capabilitiesForRole:storeCapabilities},(q,ctx)=>capacitySummary(q,ctx.scope.scope_id,a.tenantId));
  assert.deepEqual(r.capacity,{state:'ready',limit_bytes:Number(capacity.limit),used_bytes:Number(capacity.used),reserved_bytes:Number(capacity.reserved),remaining_bytes:Number(BigInt(capacity.limit!)-BigInt(capacity.used)-BigInt(capacity.reserved))});
  const sellerProduct=ok(await send(b,'/products',{title:'店家自有商品',price_minor:900,stock:1}),201);
  for(const id of [foreign.product_id,sellerProduct.product_id,randomUUID()]) {
    const r=await send(a,'/supply-materials',materialInput('image',id));ok(r,422);assert.equal(r.data.code,'material_product_invalid');
  }
  ok(await send(a,`/products/${item.product_id}/remove`,{},item.version));assert.deepEqual((await detail(a,video)).material.subject,{kind:'product',product_id:item.product_id,sku:null,title:null});
  await h.pool.query("UPDATE tenant_capacity_policies SET max_retained_bytes=9007199254740992,revision=revision+1");ok(await get(a,'/supply-materials'),500);
  for(const id of [copy.material_id,randomUUID()])ok(await get(c,`/supply-materials/${id}`),404);
  await h.pool.query('DELETE FROM tenant_capacity_policies');assert.deepEqual((await list(a)).capacity,{state:'unavailable'});
  fault=r=>{r.items[0].version_count=99;};ok(await get(a,'/supply-materials'),500);fault=undefined;
  fault=r=>{r.material.version_count=99;};ok(await get(a,path(copy)),500);fault=undefined;
  fault=()=>{throw new Error('synthetic query failure');};ok(await get(a,'/supply-materials'),500);fault=undefined;
});

test('SC-09 commands, exact versions, receipts, replay, CAS and withdrawal',async()=>{
  const {a,b,d}=await journey(),bid=await partnerId(b),did=await partnerId(d);
  const key=randomUUID(),input=materialInput();
  const create=()=>h.call('POST',a.root+'/supply-materials',a.owner,input,{'Idempotency-Key':key},app);
  let m=ok(await create(),201);privateReply(await create());assert.equal(m.version,'2');assert.deepEqual(ok(await create(),201),m);
  const different=await h.call('POST',a.root+'/supply-materials',a.owner,{...input,title:'另一個內容'},{'Idempotency-Key':key},app);ok(different,409);assert.equal(different.data.code,'idempotency_conflict');
  m=await mutation(a,m,'',{description:'更新描述'},'PATCH');
  await refused(a,{...m,version:'2'},'',{title:'過期'},'version_conflict',412,'PATCH');
  const missing=await send(a,path(m),{title:'缺少版本'},undefined,'PATCH');ok(missing,428);assert.equal(missing.data.code,'version_required');
  m=await mutation(a,m,'/copy',{body:'第二版'});
  m=await mutation(a,m,'/access',{access:'public_use',confirm_public_use:true});
  m=await mutation(a,m,'/access',{access:'public_use',confirm_public_use:true});
  m=await mutation(a,m,'/grants',{partner_ids:[bid,did]});
  let d1=await detail(a,m);assert.equal(d1.material.active_grants,2);assert.deepEqual(d1.partners.map(p=>[p.name,p.cooperation,p.granted]),[['零售 B','sellable',true],['零售 D','awaiting',true]]);
  m=await mutation(a,m,`/grants/${bid}/revoke`);await refused(a,m,`/grants/${bid}/revoke`,{},'not_found',404);
  m=await mutation(a,m,'/grants',{partner_ids:[bid]});
  const replayKey=randomUUID(),old={...m},body={title:'新標題'};
  const update=()=>h.call('PATCH',a.root+path(old),a.owner,body,{'Idempotency-Key':replayKey,'If-Match':`"${old.version}"`},app);
  m=ok(await update());assert.deepEqual(ok(await update()),m);
  const cross=await make(a);const crossReply=await h.call('PATCH',a.root+path(cross),a.owner,body,{'Idempotency-Key':replayKey,'If-Match':`"${old.version}"`},app);
  ok(crossReply,409);assert.equal(crossReply.data.code,'idempotency_conflict');
  m=await mutation(a,m,'/withdraw');
  d1=await detail(a,m);assert.equal(d1.material.state,'withdrawn');assert.equal(d1.material.active_grants,0);assert.ok(d1.grants.every(g=>g.revoked_at!==null));
  const revoked=(await h.pool.query('SELECT DISTINCT revoked_at FROM supply_material_grants WHERE material_id=$1 AND revoked_at=(SELECT max(revoked_at) FROM supply_material_grants WHERE material_id=$1)',[m.material_id])).rows;assert.equal(revoked.length,1);
  for(const [suffix,body,method] of [['',{title:'禁止'},'PATCH'],['/copy',{body:'禁止'},'POST'],['/access',{access:'partners'},'POST'],['/grants',{partner_ids:[bid]},'POST'],[`/grants/${bid}/revoke`,{},'POST'],['/withdraw',{},'POST']] as const)
    await refused(a,m,suffix,body,'material_withdrawn',409,method);
  assert.deepEqual((await list(a)).items.map((r:any)=>r.material_id),[cross.material_id,m.material_id]);
  const facts=(await h.pool.query("SELECT aggregate_version::text AS version,operation FROM scoped_transition_journal WHERE aggregate_type='supply_material' AND aggregate_id=$1 ORDER BY aggregate_version",[m.material_id])).rows;
  assert.equal(facts.length,Number(m.version)-1);assert.equal(facts[0].version,'2');assert.equal(facts.at(-1).operation,'storefront.supply-material.withdraw');
  assert.equal((await h.pool.query('SELECT count(*)::int n FROM supply_material_versions WHERE material_id=$1',[m.material_id])).rows[0].n,2);
});

test('SC-09 active-material and immutable-version limits retain bounded history',async()=>{
  const a=await supplier();let m=await make(a);const image=await make(a,materialInput('image'));
  await refused(a,image,'/copy',{body:'文案'},'material_kind_mismatch');
  await h.pool.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,title,created_by_principal_id)
    SELECT gen_random_uuid(),tenant_id,instance_id,scope_id,'image','合成素材',created_by_principal_id FROM supply_materials
    CROSS JOIN generate_series(1,198) WHERE material_id=$1`,[m.material_id]);
  const refusedCreate=await send(a,'/supply-materials',materialInput());ok(refusedCreate,409);assert.equal(refusedCreate.data.code,'material_limit');
  m=await mutation(a,m,'/withdraw');await make(a,materialInput('video'));const list1=await list(a);assert.equal(list1.active,200);assert.equal(list1.total,201);assert.equal(list1.truncated,true);assert.equal(list1.items.length,200);
  // A separate instance remains independent of the active-material limit.
  const c=await supplier('版本測試');let v=await make(c);
  for(let no=2;no<=100;no++)await h.pool.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,body,created_by_principal_id)
    SELECT gen_random_uuid(),material_id,tenant_id,instance_id,scope_id,'copy',$2,'合成版本',created_by_principal_id FROM supply_materials WHERE material_id=$1`,[v.material_id,no]);
  await h.pool.query(`UPDATE supply_materials SET current_version_id=(SELECT version_id FROM supply_material_versions WHERE material_id=$1 AND version_no=100),aggregate_version=aggregate_version+1 WHERE material_id=$1`,[v.material_id]);v={...v,version:'3'};
  await refused(c,v,'/copy',{body:'第101版'},'material_version_limit');const d=await detail(c,v);assert.equal(d.versions.length,50);assert.equal(d.versions_truncated,true);assert.equal(d.versions[0].version_no,100);assert.equal(d.versions.at(-1)!.version_no,51);
});

async function decision(s:Store,l:any,value:string) {return ok(await send(s,`/supply-requests/${l.selection_id}/decision`,{decision:value,listing_sha256:l.listing_sha256},l.version));}

test('SC-09 grants use current cooperation, reject mixed batches atomically and detect duplicates',async()=>{
  const {a,b,c,d,item,o,o2,lb,ld}=await journey(),bid=await partnerId(b),did=await partnerId(d),cid=await partnerId(c);
  let productMaterial=await make(a,materialInput('copy',item.product_id));
  for(const invalid of [did,cid,await partnerId(a),randomUUID()])await refused(a,productMaterial,'/grants',{partner_ids:[bid,invalid]},'partner_not_eligible');
  productMaterial=await mutation(a,productMaterial,'/grants',{partner_ids:[bid]});await refused(a,productMaterial,'/grants',{partner_ids:[bid]},'already_granted');
  let brand=await make(a);brand=await mutation(a,brand,'/grants',{partner_ids:[did]});
  await decision(a,ld,'declined');await refused(a,await make(a),'/grants',{partner_ids:[did]},'partner_not_eligible');
  await decision(a,lb,'revoked');await refused(a,await make(a,materialInput('copy',item.product_id)),'/grants',{partner_ids:[bid]},'partner_not_eligible');
  // B still has awaiting cooperation on another product, sufficient for brand materials.
  await mutation(a,await make(a),'/grants',{partner_ids:[bid]});
  ok(await send(a,`/supply-offers/${o2.offer_id}/withdraw`,{},o2.version));
  await refused(a,await make(a),'/grants',{partner_ids:[bid]},'partner_not_eligible');
  assert.equal(o.state,'offered');
});

test('SC-09 partner projection pins exact shop, current version, cooperation products and offer title',async()=>{
  const {a,b,c,d,item,other,o,o2,lb,ld}=await journey(),bid=await partnerId(b),did=await partnerId(d);
  // The private product title changes after the immutable cooperation offer.
  ok(await send(a,`/supply-products/${item.product_id}`,{title:'私人草稿的新標題'},item.version,'PATCH'));
  let brand=await make(a),productMat=await make(a,materialInput('copy',item.product_id));
  brand=await mutation(a,brand,'/grants',{partner_ids:[bid,did]});productMat=await mutation(a,productMat,'/grants',{partner_ids:[bid]});
  await make(c);assert.equal((await visible(c)).items.length,0);
  const projected=await visible(b);assert.deepEqual(projected.items.map((m:any)=>m.material_id),[brand.material_id,productMat.material_id]);
  assert.deepEqual(projected.items[0].applies_to,[item.product_id,other.product_id].sort());assert.deepEqual(projected.items[1].subject,{kind:'product',product_id:item.product_id,title:o.terms.title});
  for(const m of projected.items) {
    assert.deepEqual(Object.keys(m).sort(),['material_id','kind','supplier_name','subject','applies_to','title','description','access','current'].sort());
    assert.deepEqual(Object.keys(m.current).sort(),['version_id','version_no','created_at','content'].sort());assert.deepEqual(Object.keys(m.current.content).sort(),['body','kind']);
    assert.deepEqual(Object.keys(m.subject).sort(),m.subject.kind==='brand'?['kind']:['kind','product_id','title']);
  }
  assert.deepEqual(Object.keys(projected).sort(),['profile','tenant_id','instance_id','as_of','items','truncated'].sort());
  const actor=await authenticate(runtime,b.owner.cookie.split('=')[1].split(';')[0]);const oldVersion=projected.items[0].current.version_id;
  const readable=(version:string)=>withTenantRead(runtime,{actor,tenantId:b.tenantId,capabilitiesForRole:storeCapabilities},q=>readPartnerMaterial(q,bid,brand.material_id,version));
  assert.ok(await readable(oldVersion));brand=await mutation(a,brand,'/copy',{body:'合作的最新版本'});assert.equal(await readable(oldVersion),null);
  assert.equal((await visible(b)).items[0].current.content.body,'合作的最新版本');
  const viewer=(await h.person('店家唯讀者')).session;await invite(b,viewer,['store:read'],'viewer');assert.equal((await visible(b,viewer)).items.length,2);
  brand=await mutation(a,brand,`/grants/${bid}/revoke`);assert.deepEqual((await visible(b)).items.map((m:any)=>m.material_id),[productMat.material_id]);
  productMat=await mutation(a,productMat,'/withdraw');assert.deepEqual((await visible(b)).items,[]);
  assert.equal((await visible(d)).items.length,1);await decision(a,ld,'declined');assert.deepEqual((await visible(d)).items,[]);
  // Ended cooperation hides a still-active grant without needing a revoke.
  brand=await mutation(a,brand,'/grants',{partner_ids:[bid]});await decision(a,lb,'revoked');
  assert.equal((await visible(b)).items.length,1);ok(await send(a,`/supply-offers/${o2.offer_id}/withdraw`,{},o2.version));assert.deepEqual((await visible(b)).items,[]);
});

test('SC-09 authority, strict inputs, private headers and every flag-off route',async()=>{
  const a=await supplier(),b=await retailer(),m=await make(a),bid=await partnerId(b),outsider=(await h.person('非成員')).session;
  const viewer=(await h.person('素材唯讀者')).session;await invite(a,viewer,['store:read'],'viewer');
  const routes:[string,string,unknown][]=[['GET','/supply-materials',undefined],['GET',path(m),undefined],['GET','/partner-materials',undefined],
    ['POST','/supply-materials',materialInput()],['PATCH',path(m),{title:'標題'}],['POST',path(m,'/copy'),{body:'文案'}],
    ['POST',path(m,'/access'),{access:'partners'}],['POST',path(m,'/grants'),{partner_ids:[bid]}],
    ['POST',path(m,`/grants/${bid}/revoke`),{}],['POST',path(m,'/withdraw'),{}]];
  for(const [method,path,body] of routes) {
    const headers={'Idempotency-Key':randomUUID(),...(method==='POST'&&path==='/supply-materials'?{}:{'If-Match':`"${m.version}"`})};
    ok(await h.call(method,a.root+path,a.owner,body,headers,closed),404);
    ok(await h.call(method,a.root+path,undefined,body,headers,app),401);
    for(const who of [outsider,b.owner]) {const r=await h.call(method,a.root+path,who,body,headers,app);ok(r,404);assert.equal(r.data.code,'not_found');privateReply(r);}
    if(path!=='/partner-materials'){const r=await h.call(method,a.root+path,viewer,body,headers,app);ok(r,403);assert.equal(r.data.code,'capability_denied');privateReply(r);}
    const query=await h.call(method,a.root+path+'?unknown=1',a.owner,body,headers,app);ok(query,422);privateReply(query);
  }
  for(const [method,p,body] of routes.filter(([method,p])=>p.startsWith(path(m))&&method!=='GET')) {
    const r=await h.call(method,b.root+p,b.owner,body,{'Idempotency-Key':randomUUID(),'If-Match':`"${m.version}"`},app);ok(r,404);assert.equal(r.data.code,'not_found');
  }
  const notReady=await open('尚未設定');for(const p of ['/supply-materials','/partner-materials']){const r=await get(notReady,p);ok(r,409);assert.equal(r.data.code,'storefront_not_set_up');}
  for(const p of ['/supply-materials/nope','/supply-materials?x=1&x=2'])ok(await get(a,p),422);
});

// Extra storefronts in an existing seller tenant retain real identity/mapping,
// offer, selection and material-grant constraints; no per-store HTTP launch loop.
async function clonePartners(b:Store,l:any,count:number) {
  const p=await profileRow(b),source=(await h.pool.query('SELECT snapshot FROM commerce_selections WHERE selection_id=$1',[l.selection_id])).rows[0].snapshot;
  const fixtures=Array.from({length:count},(_,n)=>{const seller_id=randomUUID(),snapshot={...source,seller_shop_id:seller_id};
    return {instance_id:randomUUID(),binding_id:randomUUID(),supply_id:randomUUID(),seller_id,selection_id:randomUUID(),name:`合成店 ${String(n).padStart(3,'0')}`,snapshot,hash:digest(snapshot)};});
  const data=JSON.stringify(fixtures),shape=`jsonb_to_recordset($1) AS f(instance_id uuid,binding_id uuid,supply_id uuid,seller_id uuid,selection_id uuid,name text,snapshot jsonb,hash text)`;
  const q=await h.pool.connect();try {
    await q.query('BEGIN');
    await q.query(`INSERT INTO module_instances(instance_id,tenant_id,module_key,application_release_ref,data_schema_version,contract_ref,status,binding_id,created_by_principal_id,origin_guild_key,module_release_ref)
      SELECT f.instance_id,i.tenant_id,i.module_key,i.application_release_ref,i.data_schema_version,i.contract_ref,'archived',f.binding_id,i.created_by_principal_id,i.origin_guild_key,i.module_release_ref
      FROM ${shape} CROSS JOIN module_instances i WHERE i.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO deployment_bindings(binding_id,tenant_id,instance_id,mode,environment,contract_ref,state)
      SELECT f.binding_id,d.tenant_id,f.instance_id,'hosted',d.environment,d.contract_ref,'retired' FROM ${shape} CROSS JOIN deployment_bindings d WHERE d.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,origin,mode,accepting_orders,name,description,website_url,contact,currency,manifest_sha256)
      SELECT ids.id,s.community_id,s.owner_id,ids.kind,'hosted','test',false,f.name,'合成測試','','',s.currency,replace(ids.id::text,'-','')||replace(ids.id::text,'-','')
      FROM ${shape} CROSS JOIN LATERAL (VALUES(f.supply_id,'internal'),(f.seller_id,'public')) ids(id,kind) CROSS JOIN commerce_shops s WHERE s.shop_id=$2`,[data,p.storefront_shop_id]);
    await q.query(`INSERT INTO commerce_storefront_profiles(instance_id,tenant_id,supply_shop_id,storefront_shop_id,created_by_principal_id)
      SELECT f.instance_id,p.tenant_id,f.supply_id,f.seller_id,p.created_by_principal_id FROM ${shape} CROSS JOIN commerce_storefront_profiles p WHERE p.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO commerce_resource_tenants(resource_kind,resource_id,tenant_id,instance_id,source_owner_id,mapping_state)
      SELECT 'shop',ids.id,p.tenant_id,f.instance_id,p.created_by_principal_id,'confirmed' FROM ${shape}
      CROSS JOIN LATERAL (VALUES(f.supply_id),(f.seller_id)) ids(id) CROSS JOIN commerce_storefront_profiles p WHERE p.instance_id=$2`,[data,b.instanceId]);
    await q.query(`INSERT INTO commerce_selections(selection_id,shop_id,item_id,retail_price_minor,sale_terms,snapshot,listing_sha256,hosted_offer_id,hosted_sku)
      SELECT f.selection_id,f.seller_id,l.item_id,l.retail_price_minor,l.sale_terms,f.snapshot,f.hash,l.hosted_offer_id,l.hosted_sku
      FROM ${shape} CROSS JOIN commerce_selections l WHERE l.selection_id=$2`,[data,l.selection_id]);
    await q.query('COMMIT');
  }catch(e){await q.query('ROLLBACK');throw e;}finally{q.release();}
  return fixtures;
}

test('SC-09 200-grant boundary, partner truncation and same-tenant storefront isolation',async()=>{
  const a=await supplier(),b=await retailer(),item=await supplyProduct(a),offered=await offer(a,item),selected=await propose(b,offered);
  const copies=await clonePartners(b,selected,201),bid=await partnerId(b);let m=await make(a);
  m=await mutation(a,m,'/grants',{partner_ids:[bid]});
  const otherMaterial=await make(a);await mutation(a,otherMaterial,'/grants',{partner_ids:[copies[0].seller_id]});
  const actor=await authenticate(runtime,b.owner.cookie.split('=')[1].split(';')[0]);
  const d0=await detail(a,m);
  const otherShop=await withTenantRead(runtime,{actor,tenantId:b.tenantId,capabilitiesForRole:storeCapabilities},q=>readPartnerMaterial(q,copies[0].seller_id,m.material_id,d0.material.current!.version_id));
  assert.equal(otherShop,null,'grant for another storefront in this tenant is insufficient even with cooperation');
  assert.equal((await visible(b)).items.length,1);
  const d=await detail(a,m);assert.equal(d.partners.length,200);assert.equal(d.partners_truncated,true);
  assert.deepEqual(d.partners.map(p=>p.partner_id),(await h.pool.query(`SELECT shop_id FROM commerce_shops WHERE shop_id=ANY($1::uuid[]) ORDER BY name,shop_id`,[[bid,...copies.map(x=>x.seller_id)]])).rows.slice(0,200).map(p=>p.shop_id));
  m=await mutation(a,m,'/grants',{partner_ids:copies.slice(0,199).map(x=>x.seller_id)});
  await refused(a,m,'/grants',{partner_ids:[copies[199].seller_id]},'material_grant_limit');
  assert.equal((await detail(a,m)).material.active_grants,200);
  m=await mutation(a,m,'/withdraw');assert.deepEqual((await visible(b)).items,[]);
  const distinct=(await h.pool.query('SELECT count(DISTINCT revoked_at)::int n FROM supply_material_grants WHERE material_id=$1',[m.material_id])).rows[0].n;assert.equal(distinct,1);
});

test('SC-09 supplier name uses newest cooperating offer and ungranted shops see no materials',async()=>{
  const a=await supplier('舊供應名稱'),b=await retailer(),d=await retailer('未授權店'),one=await supplyProduct(a),o=await offer(a,one);
  await propose(b,o);await propose(d,o);
  const p=ok(await get(a,'/supply-profile'));ok(await send(a,'/supply-profile',{name:'最新供應名稱'},p.version,'PATCH'));
  const two=await supplyProduct(a,{...product,title:'第二商品'}),o2=await offer(a,two);await propose(b,o2);
  const brand=await make(a),specific=await make(a,materialInput('copy',one.product_id));
  await mutation(a,brand,'/grants',{partner_ids:[await partnerId(b)]});await mutation(a,specific,'/grants',{partner_ids:[await partnerId(b)]});
  const r=await visible(b);assert.equal(r.items.find((m:any)=>m.material_id===brand.material_id).supplier_name,'最新供應名稱');
  assert.equal(r.items.find((m:any)=>m.material_id===specific.material_id).supplier_name,'舊供應名稱');assert.deepEqual((await visible(d)).items,[]);
});

test('SC-09 partner lists bound at 200 with deterministic ties and refuse corrupt answers',async()=>{
  const a=await supplier(),b=await retailer(),item=await supplyProduct(a),o=await offer(a,item);await propose(b,o);
  const bid=await partnerId(b),m=await make(a);await mutation(a,m,'/grants',{partner_ids:[bid]});
  const extra=(await h.pool.query(`INSERT INTO supply_materials(material_id,tenant_id,instance_id,scope_id,kind,title,description,created_by_principal_id,updated_at)
    SELECT gen_random_uuid(),tenant_id,instance_id,scope_id,'copy',title,description,created_by_principal_id,statement_timestamp()
    FROM supply_materials CROSS JOIN generate_series(1,200) WHERE material_id=$1 RETURNING material_id`,[m.material_id])).rows;
  await h.pool.query(`INSERT INTO supply_material_versions(version_id,material_id,tenant_id,instance_id,scope_id,kind,version_no,body,created_by_principal_id)
    SELECT gen_random_uuid(),material_id,tenant_id,instance_id,scope_id,'copy',1,'合成文案',created_by_principal_id FROM supply_materials WHERE material_id=ANY($1::uuid[])`,[extra.map(m=>m.material_id)]);
  await h.pool.query(`UPDATE supply_materials m SET current_version_id=v.version_id,aggregate_version=m.aggregate_version+1
    FROM supply_material_versions v WHERE v.material_id=m.material_id AND m.material_id=ANY($1::uuid[])`,[extra.map(m=>m.material_id)]);
  await h.pool.query(`INSERT INTO supply_material_grants(grant_id,material_id,tenant_id,instance_id,partner_shop_id,granted_by_principal_id)
    SELECT gen_random_uuid(),material_id,tenant_id,instance_id,$2,created_by_principal_id FROM supply_materials WHERE material_id=ANY($1::uuid[])`,[extra.map(m=>m.material_id),bid]);
  const page=await visible(b);assert.equal(page.items.length,200);assert.equal(page.truncated,true);
  assert.deepEqual(page.items.map((m:any)=>m.material_id),[m.material_id,...extra.map(m=>m.material_id)].sort().slice(0,200));
  fault=r=>{r.items[0].current.content={kind:'copy',body:''};};ok(await get(b,'/partner-materials'),500);fault=undefined;
});

// Historical 1.0.0 fixtures above stay intact; new installations use the current release.
test('SC-09 current 1.1.0 material cooperation works with Commerce console and checkout OFF',async()=>{
  for(const guild of [supplierGuild,retailGuild])await h.pool.query(`INSERT INTO guild_application_offerings
    (offering_id,community_id,guild_key,application_key,release_ref,status,display_order,launch_policy_ref,version)
    VALUES($1,$2,$3,'hosted-store','hosted-store@1.1.0','offered',10,'{"policy_key":"hosted-store.launch","version":"1"}',1)
    ON CONFLICT (community_id,guild_key,application_key,release_ref) DO NOTHING`,[randomUUID(),DEMO_COMMUNITY,guild]);
  const site=ok(await h.call('GET','/site',undefined,undefined,{},app));
  assert.equal(site.supplier_console_enabled,true);assert.equal(site.commerce_console_enabled,false);assert.equal(site.commerce_checkout_enabled,false);
  const a=await open('新版供應',supplierGuild,undefined,'hosted-store@1.1.0'),b=await open('新版零售',retailGuild,undefined,'hosted-store@1.1.0');
  for(const s of [a,b])assert.equal((await h.pool.query('SELECT module_release_ref FROM module_instances WHERE instance_id=$1',[s.instanceId])).rows[0].module_release_ref,'storefront@1.1.0');
  ok(await send(a,'/supply-profile',{...catalog,name:'新版供應'}),201);
  ok(await send(b,'/setup',{name:'新版零售',slug:`current-${randomUUID().slice(0,12)}`,currency:'TWD'}),201);
  const item=await supplyProduct(a),o=await offer(a,item);await accept(a,await propose(b,o));
  const m=await mutation(a,await make(a,materialInput('copy',item.product_id)),'/grants',{partner_ids:[await partnerId(b)]});
  const view=await visible(b);assert.deepEqual(view.items.map((m:{material_id:string})=>m.material_id),[m.material_id]);assert.equal(view.items[0].current!.content.kind,'copy');
  ok(await get(b,'/checkout-orders'),404);assert.equal((await h.pool.query('SELECT count(*)::int AS n FROM commerce_checkout_orders')).rows[0].n,0);
});
