import {randomUUID} from 'node:crypto';
import {chmod,mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import {test,expect} from './fixtures.js';
import {ownedSchema} from './hosted-order-fixture.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {FakeObjectStore} from '../../packages/asset-storage/fake-store.js';
import {hashPassword} from '../../modules/identity-membership/service.js';
import {TENANT_CURSOR_TEST_KEY} from '../runtime/tenant-cursor-fixture.js';
import metadata from '../../contracts/preview/v1/metadata.json' with {type:'json'};
import packageMetadata from '../../package.json' with {type:'json'};
import {PHASES,WRITE_DESCRIPTIONS,CandidateClient,Secrets,syntheticPng,accountFileRequired,candidateTarget,fetchTransport,localHarnessTarget,runCandidate,selectPhases,
  type Account,type PhaseId,type PhaseContext,type Report,type RunOptions,type Target,type Transport,type TransportRequest} from '../../scripts/verify-cloud-candidate-lib.js';
import {main,parseArgs} from '../../scripts/verify-cloud-candidate.js';
import {supplierRun} from '../../scripts/verify-cloud-candidate-supplier.js';

const supplierPhases=['supplier-journey','supplier-photo','supplier-reservations','supplier-recheck'] as const;
const target=candidateTarget('staging'),sha='0123456789abcdef0123456789abcdef01234567';
const password='WP07-synthetic-password-only';
const accounts={supplier:{email:'wp07-supplier@example.test',password,label:'wp07-supplier'},seller:{email:'wp07-seller@example.test',password,label:'wp07-seller'},buyer:{email:'wp07-buyer@example.test',password,label:'wp07-buyer'}};
const health=(mode='staging')=>({status:'ok',mode,version:'1.2.3',money_movement_enabled:false,official:false,shop_key_policy:'unconfigured',shop_key_issuer_profile:null,...(mode==='local'?{}:{runtime:'cloudflare-workers',release_sha:sha})});
type Wire={status:number;json?:unknown;headers?:Record<string,string>;body?:Uint8Array;cookies?:string[]};
function mock(handler:(request:TransportRequest)=>Wire|Promise<Wire>){
  const calls:TransportRequest[]=[];
  const transport:Transport=async request=>{calls.push(request);const reply=await handler(request),headers=new Headers({'content-type':'application/json','cache-control':'private, no-store',...reply.headers});
    for(const cookie of reply.cookies??[])headers.append('set-cookie',cookie);
    return {status:reply.status,headers,body:reply.body??Buffer.from(JSON.stringify(reply.json??{}))};};
  return {transport,calls};
}
const paths=(calls:TransportRequest[])=>calls.map(call=>`${call.method} ${new URL(call.url).pathname}`);
const phase=(report:Report,id:string)=>report.phases.find(p=>p.id===id)!;
const base=(phases:readonly string[],handle:string,extra:Partial<RunOptions>={}):RunOptions=>({target,run:'execute',phases:selectPhases(phases),expectedVersion:'1.2.3',expectedReleaseSha:sha,contract:metadata,supplierAccounts:accounts,supplierHandleFile:handle,...extra});
async function temporary(run:(handle:string,directory:string)=>Promise<void>){const directory=await mkdtemp(join(tmpdir(),'wp07-'));try{await run(join(directory,'handle.json'),directory);}finally{await rm(directory,{recursive:true,force:true});}}
function handle(origin=target.origin){return {candidate_origin:origin,run_tag:'abcd1234',created_at:'2026-10-16T00:00:00.000Z',
  supplier:{tenant_id:randomUUID(),instance_id:randomUUID(),product_id:randomUUID(),offer_id:randomUUID()},
  seller:{tenant_id:randomUUID(),instance_id:randomUUID(),selection_id:randomUUID(),slug:'wp07-abcd1234'},
  expected:{supplier_name:'WP07 合成供貨 abcd1234',product_name:'WP07 合成商品 abcd1234',description:'合成商品說明',seller_name:'WP07 合成選物 abcd1234',cost_minor:15000,stock:10,shipping_minor:2000,shipping_terms:'合成出貨條款',return_terms:'合成退貨條款',terms_version:'2',retail_price_minor:22000,decision_state:'sellable'}};}
async function save(path:string,value:unknown){await writeFile(path,JSON.stringify(value),{mode:0o600});}
function cleanReport(report:Report,logs:string[],secrets:Iterable<string>){const text=JSON.stringify(report)+'\n'+logs.join('\n');expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);for(const secret of secrets)if(secret.length>=6)expect(text).not.toContain(secret);expect(report.redaction_applied,JSON.stringify(report).match(/.{0,80}\[REDACTED\].{0,80}/g)?.join('\n')).toBe(false);}

function supplierMock(knobs:{disabled?:boolean;photo?:boolean;photoProtocol?:boolean;publicPhoto?:boolean;admission?:boolean;replayDifferent?:boolean;staleAccepted?:boolean;siteOff?:boolean;legacyChanged?:boolean;consoleOff?:boolean;consoleStillOn?:boolean;ineligible?:boolean;offFailure?:'500'|'throw';logoutFailure?:'500'|'throw';uploadFailure?:boolean;stockAccepted?:boolean;decisionFailure?:boolean;beforeHandle?:()=>Promise<void>;mixedPublic?:boolean;publicLeak?:'photo'|'read_path'|'private_path'|'product_id'|'cost_minor';publicFault?:'empty-store'|'empty-products'|'wrong-store'|'wrong-name'|'wrong-sku'|'wrong-title'|'wrong-price'|'wrong-revision'|'wrong-both-revisions'|'empty-media-body'|'wrong-media-store'|'wrong-media-revision'}={},existing=handle()){
  const h=existing,known=new Set<string>([password,...Object.values(accounts).map(a=>a.email),'wp07-csrf-value']),sessions=new Set<string>(),roles=new Map<string,string>();
  const settings={supplier:{reservation_enabled:false,admission_enabled:knobs.admission!==false,version:'1'},seller:{reservation_enabled:false,admission_enabled:knobs.admission!==false,version:'1'}};
  let published=false,order:any=null,cancelBody:string|undefined,cancelHeaders:Record<string,string>|undefined;const publicStatuses:number[]=[];
  const readPath=`/api/v1/tenants/${h.supplier.tenant_id}/storefronts/${h.supplier.instance_id}/products/${h.supplier.product_id}/photo/3`,photoBytes=Buffer.alloc(30);
  photoBytes.write('RIFF');photoBytes.writeUInt32LE(22,4);photoBytes.write('WEBPVP8X',8);photoBytes.writeUInt32LE(10,16);photoBytes.writeUIntLE(319,24,3);photoBytes.writeUIntLE(239,27,3);
  const image={content_type:'image/webp',byte_size:photoBytes.length,width:320,height:240,read_path:readPath};
  let product:any=null,terms:any=null,offer:any=null,selection:any=null,created=0,login=0,termsWritten=false;
  const seed=()=>{const e=h.expected;product={product_id:h.supplier.product_id,title:e.product_name,description:e.description,cost_minor:e.cost_minor,stock:e.stock,reserved:0,available:e.stock,version:'2',sku:'P0001'};terms={...e,product_id:product.product_id,stock:e.stock,reserved:0,available:e.stock,version:e.terms_version};offer={offer_id:h.supplier.offer_id,product_id:product.product_id,state:'offered',terms:{...terms,title:e.product_name,description:e.description},terms_sha256:'a'.repeat(64),source_version:'2',version:'1'};selection={selection_id:h.seller.selection_id,offer,retail_price_minor:e.retail_price_minor,seller_name:e.seller_name,state:e.decision_state,sku:'P0001',listing_sha256:'b'.repeat(64),version:'2'};};
  const server=mock(async request=>{
    const path=new URL(request.url).pathname,body=typeof request.body==='string'?JSON.parse(request.body):{},method=request.method;
    const ok=(json:unknown,status=200):Wire=>({status,json});
    if(path==='/api/v1/health')return ok(health());
    if(path==='/api/v1/site')return ok({supplier_console_enabled:!knobs.disabled&&!knobs.siteOff,hosted_store_photo_uploads_enabled:knobs.photo===true});
    if(path==='/api/v1/auth/login'){const cookie=`wp07-cookie-${++login}`.padEnd(43,'x');sessions.add(cookie);roles.set(cookie,body.email);known.add(cookie);return {...ok({user:{user_id:randomUUID(),email:body.email},csrf_token:'wp07-csrf-value'}),cookies:[`__Host-freedom_session=${cookie}; Path=/; Secure; HttpOnly; SameSite=Strict`]};}
    if(path==='/api/v1/auth/logout'){if(knobs.logoutFailure&&roles.get((request.headers.Cookie??'').split('=')[1])===accounts.seller.email){if(knobs.logoutFailure==='throw')throw new TypeError('synthetic transport');return ok({},500);}sessions.delete((request.headers.Cookie??'').split('=')[1]);return {...ok({}),cookies:['__Host-freedom_session=; Path=/; Secure; Max-Age=0']};}
    if(path==='/api/v1/tenants'){const seller=body.display_name.includes('選物');h.expected[seller?'seller_name':'supplier_name']=body.display_name;return ok({tenant:{tenant_id:seller?h.seller.tenant_id:h.supplier.tenant_id},workspace:{workspace_id:randomUUID()}},201);}
    if(path.endsWith('/application-launch-plans')){expect(body.release_ref).toBe('hosted-store@1.1.0');return knobs.ineligible?{status:403,json:{code:'guild_full_member_required'}}:ok({plan_id:randomUUID(),version:'1',configuration_digest:{algorithm:'sha256',value:'c'.repeat(64)}},201);}
    if(path.endsWith('/application-installations'))return ok({operation_id:randomUUID(),state:'succeeded'});
    if(path.includes('/application-installations/by-operation/'))return ok({modules:[{requirement_key:'storefront',instance_id:path.includes(h.seller.tenant_id)?h.seller.instance_id:h.supplier.instance_id}]});
    if(path.endsWith('/supply-profile'))return method==='POST'?ok({instance_id:h.supplier.instance_id,version:'1',created:true},201):ok({setup_state:product?'ready':'setup_required',tenant_id:h.supplier.tenant_id,instance_id:h.supplier.instance_id,catalog:product?{name:h.expected.supplier_name}:null});
    if(path.endsWith('/setup')){h.seller.slug=body.slug;return ok({},201);}
    if(knobs.photoProtocol){
      if(path.endsWith('/product-media'))return ok({items:[{product_id:h.supplier.product_id,version:'2',photo:null}]});
      if(path.endsWith('/photo')){if(knobs.uploadFailure)return ok({},500);expect(method).toBe('POST');expect(request.headers['Content-Type']).toBe('image/png');expect(request.headers['If-Match']).toBe('"2"');expect(request.headers['X-CSRF-Token']).toBe('wp07-csrf-value');expect(request.headers.Origin).toBe(target.origin);expect(request.headers['Idempotency-Key']).toBeTruthy();expect(Buffer.from(request.body!).subarray(0,8)).toEqual(Buffer.from([137,80,78,71,13,10,26,10]));product.version=terms.version='3';return ok({product_id:h.supplier.product_id,completed_version:'3',changed:true,current:{version:'3',photo:image}});}
      if(path===readPath)return {status:200,body:photoBytes,headers:{'content-type':'image/webp'}};
    }
    if(path.startsWith('/api/v1/public/stores/')){const media=path.endsWith('/media'),status=published||knobs.mixedPublic&&media?200:404;publicStatuses.push(status);if(status===404)return ok({code:'not_found'},404);
      const leak=knobs.publicLeak,photo=knobs.publicPhoto||leak==='photo',item:any={sku:'P0001',title:h.expected.product_name,description:h.expected.description,price_minor:h.expected.retail_price_minor,photo:photo?{read_path:'/shops/'+h.seller.slug+'/media/1/P0001'}:null};
      if(leak==='read_path')item.read_path='/shops/'+h.seller.slug+'/media/1/P0001';if(leak==='private_path')item.description=readPath;if(leak==='product_id')item.product_id=h.supplier.product_id;if(leak==='cost_minor')item.cost_minor=h.expected.cost_minor;
      const projection:any={slug:h.seller.slug,name:h.expected.seller_name,currency:'TWD',revision:'1',products:[item]},publicMedia:any={profile:'freedom.hosted-store-media/v1',slug:h.seller.slug,revision:'1',photos:photo?[item]:[]};
      switch(knobs.publicFault){
        case 'empty-store':return ok(media?publicMedia:{});
        case 'empty-products':projection.products=[];break;
        case 'wrong-store':projection.slug='another-synthetic-store';break;
        case 'wrong-name':projection.name='另一間合成商店';break;
        case 'wrong-sku':item.sku='P9999';break;
        case 'wrong-title':item.title='另一件合成商品';break;
        case 'wrong-price':item.price_minor++;break;
        case 'wrong-revision':projection.revision='2';break;
        case 'wrong-both-revisions':projection.revision=publicMedia.revision='2';break;
        case 'empty-media-body':return ok(media?{}:projection);
        case 'wrong-media-store':publicMedia.slug='another-synthetic-store';break;
        case 'wrong-media-revision':publicMedia.revision='2';break;
      }
      return ok(media?publicMedia:projection);}
    if(path.endsWith('/publish')){published=true;return ok({publication:{state:'published',current_revision:'1'}});}
    if(path===`/api/v1/tenants/${h.seller.tenant_id}/storefronts/${h.seller.instance_id}`)return ok({version:'1',store:{slug:h.seller.slug,name:h.expected.seller_name,currency:'TWD'},publication:{state:published?'published':'never_published',current_revision:published?'1':null}});
    if(path.endsWith('/reservation-quotes'))return ok({quote_id:randomUUID(),terms_sha256:'d'.repeat(64)},201);
    if(path.endsWith('/reservation-orders')){expect(settings.supplier.reservation_enabled&&settings.seller.reservation_enabled&&published).toBe(true);order={order_id:randomUUID(),state:'reserved',version:'1'};product.reserved=1;product.available=9;return ok(order,201);}
    if(path.endsWith('/supply-reservations'))return ok({items:order?[{...order,items:[{product_id:h.supplier.product_id,quantity:1}]}]:[]});
    if(path.endsWith('/cancel')){if(cancelBody!==undefined){expect(request.body).toBe(cancelBody);expect(request.headers['Idempotency-Key']).toBe(cancelHeaders!['Idempotency-Key']);expect(request.headers['If-Match']).toBe(cancelHeaders!['If-Match']);}else{cancelBody=request.body as string;cancelHeaders=request.headers;}order={...order,state:'cancelled',version:'2'};product.reserved=0;product.available=10;return ok(order);}
    if(path.includes('/supply-products/')&&method==='PATCH')return ok({},knobs.stockAccepted?200:409);
    if(path.endsWith('/supply-products')&&method==='POST'){
      if(!created++){h.expected.product_name=body.title;h.expected.description=body.description;seed();product.version='1';}
      return ok({product_id:knobs.replayDifferent&&created>1?randomUUID():product.product_id,version:'1'},201);
    }
    if(path.includes('/supply-terms')){
      if(method==='PATCH'){if(termsWritten&&request.headers['If-Match']==='"1"')return ok({},knobs.staleAccepted?200:412);termsWritten=true;terms={...body,product_id:h.supplier.product_id,stock:10,reserved:0,available:10,version:'2'};product.version='2';return ok(terms);}
      if(!product)seed();return ok(terms);
    }
    if(path.endsWith('/supply-offer')){offer={offer_id:h.supplier.offer_id,product_id:product.product_id,state:'offered',terms:{...terms,title:product.title,description:product.description},terms_sha256:'a'.repeat(64),source_version:'2',version:'1'};return ok(offer);}
    if(path.endsWith('/supply-catalog')||path.endsWith('/supply-offers')){if(!product)seed();return ok({items:[offer]});}
    if(path.endsWith('/distribution-selections')&&method==='POST'){selection={...body,selection_id:h.seller.selection_id,offer,seller_name:h.expected.seller_name,state:'awaiting_supply_acceptance',sku:'P0001',listing_sha256:'b'.repeat(64),version:'1'};return ok(selection,201);}
    if(path.endsWith('/decision')){if(knobs.decisionFailure)return ok({},500);await knobs.beforeHandle?.();selection.state='sellable';selection.version='2';return ok(selection);}
    if(path.endsWith('/distribution-selections')){if(!product)seed();return ok({items:[selection]});}
    if(path.endsWith('/reservation-setting')){const role=path.includes(h.seller.tenant_id)?'seller':'supplier',setting=settings[role];if(method==='PATCH'){expect(request.headers['If-Match']).toBe('"'+setting.version+'"');if(role==='seller'&&body.reservation_enabled===false&&knobs.offFailure){if(knobs.offFailure==='throw')throw new TypeError('synthetic transport');return ok({},500);}setting.reservation_enabled=body.reservation_enabled;setting.version=String(Number(setting.version)+1);}return ok(setting);}
    if(path.includes('/supplier-console/')){
      if(knobs.consoleOff&&!knobs.consoleStillOn)return ok({},404);
      if(path.endsWith('/overview'))return ok({tenant_id:h.supplier.tenant_id,instance_id:h.supplier.instance_id,metrics:Object.fromEntries(['offered_products','pending_requests','active_reservation_lines','out_of_stock_products'].map(key=>[key,{state:'ready',count:key==='offered_products'&&offer?1:0}])),todos:{state:'ready',items:selection?.state==='awaiting_supply_acceptance'?[{kind:'request_pending',selection_id:selection.selection_id,product_id:h.supplier.product_id}]:[]}});
      if(path.includes('/requests/')){if(!product)seed();return ok({request:selection,product:{product_id:h.supplier.product_id,offer}});}
      if(!product)return ok({items:[]});return ok({items:[{...product,supply_price_minor:product.cost_minor,offer,cooperation:{sellable:selection?.state==='sellable'?1:0}}]});
    }
    if(path.endsWith('/supply-products')){if(!product)seed();return ok({items:[{...product,cost_minor:knobs.legacyChanged?1:product.cost_minor}]});}
    return ok({},404);
  });
  return {...server,h,known,sessions,seed,readPath,settings,publicStatuses,order:()=>order};
}

test('supplier plan is offline and includes the four ordered write descriptions without the ordinary account',async()=>{
  const server=mock(()=>{throw Error('unexpected');});
  const report=await runCandidate({...base(supplierPhases,'missing'),run:'plan',transport:server.transport,expectSupplierConsole:'on'});
  expect(PHASES.slice(PHASES.indexOf('messages-mobile')+1,PHASES.indexOf('load'))).toEqual(supplierPhases);
  expect(accountFileRequired(selectPhases(supplierPhases))).toBe(false);
  expect(selectPhases(supplierPhases)).toEqual(['preflight','health',...supplierPhases]);
  for(const id of supplierPhases)expect(phase(report,id)).toMatchObject({status:'not_run',writes:WRITE_DESCRIPTIONS[id]});
  expect(server.calls).toEqual([]);
});

test('public guards precede dependencies, missing files and browser startup, including CLI role files',async()=>{
  const server=mock(()=>({status:200,json:health('public')}));
  const report=await runCandidate({...base(supplierPhases,'missing'),target:candidateTarget('public'),supplierAccounts:undefined,transport:server.transport,expectSupplierConsole:'off'});
  for(const id of supplierPhases)expect(phase(report,id)).toMatchObject({status:'not_run',reason:'production_supplier_phases_guarded'});
  expect(paths(server.calls)).toEqual(['GET /api/v1/health']);
  const originalFetch=globalThis.fetch,write=process.stdout.write;let output='';const requests:string[]=[];
  globalThis.fetch=async input=>{requests.push(String(input));return new Response(JSON.stringify(health('public')),{headers:{'content-type':'application/json','cache-control':'no-store'}});};
  process.stdout.write=((chunk:any)=>{output+=String(chunk);return true;}) as typeof write;
  try{await main(['execute','--target','public','--expected-release-sha',sha,'--expected-version','1.2.3','--phases',supplierPhases.join(','),'--expect-supplier-console','off'],Object.fromEntries(['SUPPLIER_ACCOUNT','SELLER_ACCOUNT','BUYER_ACCOUNT','SUPPLIER_HANDLE'].map(key=>[`FREEDOM_CANDIDATE_${key}_FILE`,join(tmpdir(),'wp07-missing-file')])));}
  finally{globalThis.fetch=originalFetch;process.stdout.write=write;}
  expect(JSON.parse(output).phases.filter((p:any)=>supplierPhases.includes(p.id)).map((p:any)=>p.reason)).toEqual(supplierPhases.map(()=>'production_supplier_phases_guarded'));
  expect(requests).toEqual([candidateTarget('public').origin+'/api/v1/health']);
});

test('console disabled sends only health and site reads',async()=>temporary(async file=>{
  const server=supplierMock({disabled:true}),report=await runCandidate({...base(supplierPhases,file),transport:server.transport,expectSupplierConsole:'on'});
  expect(phase(report,'supplier-journey')).toMatchObject({status:'not_run',reason:'supplier_console_disabled'});
  for(const id of supplierPhases.slice(1))expect(phase(report,id).status).toBe('blocked');
  expect(report.overall).not.toBe('pass');expect(report.cloud_proof).toBe(false);expect(await stat(file).catch(()=>null)).toBeNull();cleanReport(report,[],server.known);
  expect(paths(server.calls)).toEqual(['GET /api/v1/health','GET /api/v1/site']);
  const direct=supplierMock({disabled:true}),again=await runCandidate({...base(['supplier-journey','supplier-recheck'],file),transport:direct.transport,expectSupplierConsole:'on'});expect(phase(again,'supplier-recheck').status).toBe('blocked');expect(paths(direct.calls)).toEqual(['GET /api/v1/health','GET /api/v1/site']);cleanReport(again,[],direct.known);
}));

test('supplier preflight refuses missing roles, duplicate identities and unsafe handle paths before any request',async()=>temporary(async(file,directory)=>{
  const existing=join(directory,'exists');await save(existing,{});
  const cases:[Partial<RunOptions>,string][]=[
    [{supplierAccounts:{seller:accounts.seller}},'supplier_accounts_available'],
    [{supplierAccounts:{supplier:accounts.supplier,seller:{...accounts.seller,email:accounts.supplier.email.toUpperCase()}}},'supplier_accounts_distinct'],
    [{supplierAccounts:{supplier:accounts.supplier,seller:{...accounts.seller,label:accounts.supplier.label}}},'supplier_accounts_distinct'],
    [{supplierHandleFile:'relative.json'},'supplier_handle_absolute'],
    [{supplierHandleFile:join(process.cwd(),'test-results','private.json')},'supplier_handle_outside_checkout'],
    [{supplierHandleFile:existing},'supplier_handle_not_existing'],
  ];
  for(const [extra,reason] of cases){const server=mock(()=>{throw Error('unexpected');});const report=await runCandidate({...base(['supplier-journey'],file,extra),transport:server.transport});expect(phase(report,'preflight')).toMatchObject({status:'fail',reason});expect(server.calls).toEqual([]);}
  const missingBuyer=mock(()=>{throw Error('unexpected');});const report=await runCandidate({...base(['supplier-journey','supplier-reservations'],file,{supplierAccounts:{supplier:accounts.supplier,seller:accounts.seller}}),transport:missingBuyer.transport});expect(phase(report,'preflight').reason).toBe('supplier_accounts_available');expect(missingBuyer.calls).toEqual([]);
}));

test('recheck preflight requires a private, parseable, exact-origin handle',async()=>temporary(async file=>{
  for(const variant of ['missing','public','foreign','invalid']){
    await rm(file,{force:true});if(variant!=='missing')await save(file,variant==='foreign'?handle('https://foreign.invalid'):handle());
    if(variant==='public')await chmod(file,0o644);if(variant==='invalid')await writeFile(file,'{');
    const server=mock(()=>{throw Error('unexpected');}),report=await runCandidate({...base(['supplier-recheck'],file),expectSupplierConsole:'on',transport:server.transport});
    expect(phase(report,'preflight').status).toBe('fail');expect(server.calls).toEqual([]);
  }
}));

test('recheck expectation flag has fixed strict usage errors',()=>{
  const argv=['plan','--target','staging','--phases','supplier-recheck'];
  expect(()=>parseArgs(argv)).toThrow(/^supplier-recheck requires --expect-supplier-console on\|off$/);
  for(const bad of ['true','ON','secret-value'])expect(()=>parseArgs([...argv,'--expect-supplier-console',bad])).toThrow(/^--expect-supplier-console must be on or off$/);
  expect(()=>parseArgs(['plan','--target','staging','--phases','supplier-journey','--expect-supplier-console','on'])).toThrow(/^--expect-supplier-console requires supplier-recheck$/);
  expect(parseArgs([...argv,'--expect-supplier-console','off']).expectSupplierConsole).toBe('off');
});

test('journey detects replay identity and stale CAS regressions, revokes sessions and blocks same-run recheck',async()=>{
  for(const [knobs,reason] of [[{replayDifferent:true},'supplier_replay_same_product'],[{staleAccepted:true},'supplier_stale_if_match_412']] as const)await temporary(async file=>{
    const server=supplierMock(knobs),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-recheck'],file),transport:server.transport,expectSupplierConsole:'on',log:line=>logs.push(line)});
    expect(phase(report,'supplier-journey')).toMatchObject({status:'fail',reason});expect(phase(report,'supplier-recheck').status).toBe('blocked');expect(server.sessions.size).toBe(0);cleanReport(report,logs,server.known);
  });
});

test('store ineligibility is a precondition and photo/admission guards do not issue domain writes',async()=>temporary(async(file,directory)=>{
  const refused=supplierMock({ineligible:true}),report=await runCandidate({...base(['supplier-journey'],file),transport:refused.transport});
  expect(phase(report,'supplier-journey')).toMatchObject({status:'not_run',reason:'synthetic_account_not_store_eligible'});expect(refused.sessions.size).toBe(0);
  const photo=supplierMock(),photoReport=await runCandidate({...base(['supplier-journey','supplier-photo'],file),transport:photo.transport});
  expect(phase(photoReport,'supplier-journey').status).toBe('pass');expect(phase(photoReport,'supplier-photo')).toMatchObject({status:'not_run',reason:'photo_uploads_disabled'});
  expect(paths(photo.calls).slice(paths(photo.calls).lastIndexOf('GET /api/v1/site'))).toEqual(['GET /api/v1/site','POST /api/v1/auth/logout','POST /api/v1/auth/logout']);expect(photo.sessions.size).toBe(0);
  const reservation=supplierMock({admission:false}),reservationReport=await runCandidate({...base(['supplier-journey','supplier-reservations'],join(directory,'reservation.json')),transport:reservation.transport});
  expect(phase(reservationReport,'supplier-journey').status).toBe('pass');expect(phase(reservationReport,'supplier-reservations')).toMatchObject({status:'not_run',reason:'reservations_admission_off'});
    expect(paths(reservation.calls).slice(paths(reservation.calls).lastIndexOf('GET /api/v1/site'))).toEqual(['GET /api/v1/site',`GET /api/v1/tenants/${reservation.h.supplier.tenant_id}/storefronts/${reservation.h.supplier.instance_id}/reservation-setting`,'POST /api/v1/auth/logout','POST /api/v1/auth/logout']);expect(reservation.sessions.size).toBe(0);
}));

test('photo uses the private product protocol and rejects public photo aliases without leaking identifiers',async()=>{
  for(const publicPhoto of [false,true])await temporary(async file=>{
    const server=supplierMock({photo:true,photoProtocol:true,publicPhoto}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-photo'],file),transport:server.transport,log:line=>logs.push(line)});
    expect(phase(report,'supplier-journey').status).toBe('pass');expect(phase(report,'supplier-photo')).toMatchObject({status:'pass',metrics:{private_photo_verified:true,public_projection:'not_covered_unpublished',public_projection_private:null}});
    expect(server.publicStatuses).toEqual([404,404]);expect(paths(server.calls).some(p=>p.endsWith('/publish'))).toBe(false);
    const h=JSON.parse(await readFile(file,'utf8'));expect(h.photo).toEqual({read_path:server.readPath,version:'3'});expect((await stat(file)).mode&0o777).toBe(0o600);
    expect(paths(server.calls).slice(paths(server.calls).lastIndexOf('GET /api/v1/site'))).toEqual(['GET /api/v1/site',`GET /api/v1/tenants/${h.supplier.tenant_id}/storefronts/${h.supplier.instance_id}/product-media`,`POST /api/v1/tenants/${h.supplier.tenant_id}/storefronts/${h.supplier.instance_id}/products/${h.supplier.product_id}/photo`,`GET ${server.readPath}`,`GET /api/v1/public/stores/${h.seller.slug}`,`GET /api/v1/public/stores/${h.seller.slug}/media`,'POST /api/v1/auth/logout','POST /api/v1/auth/logout']);
    expect(server.sessions.size).toBe(0);cleanReport(report,logs,[...server.known,server.readPath,h.seller.slug]);
  });
});

test('recheck detects host, legacy and console OFF regressions and requires a browser',async()=>{
  for(const [knobs,state,reason] of [[{siteOff:true},'on','supplier_console_state_mismatch'],[{legacyChanged:true},'on','supplier_legacy_product_matches'],[{siteOff:true,consoleOff:true,consoleStillOn:true},'off','supplier_console_routes_404'],[{},'on','browser_required']] as const)await temporary(async file=>{
    const h=handle();await save(file,h);const server=supplierMock(knobs,h);server.seed();const logs:string[]=[];
    const report=await runCandidate({...base(['supplier-recheck'],file),transport:server.transport,expectSupplierConsole:state,log:line=>logs.push(line)});
    expect(phase(report,'supplier-recheck')).toMatchObject({status:'fail',reason});expect(server.sessions.size).toBe(0);cleanReport(report,logs,[...server.known,...(JSON.stringify(h).match(/[0-9a-f-]{36}/g)??[]),h.seller.slug]);
  });
});

test('published reservation baseline restores settings and sessions with operator cleanup still required',async()=>temporary(async file=>{
  const server=supplierMock(),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-reservations'],file),transport:server.transport,log:line=>logs.push(line)});
  expect(phase(report,'supplier-reservations').status).toBe('pass');expect(JSON.parse(await readFile(file,'utf8')).publication).toEqual({revision:'1',sku:'P0001'});expect(report).toMatchObject({overall:'pass',cloud_proof:true,cleanup:{required:true,restore_failed:false}});
  expect(server.settings.supplier.reservation_enabled||server.settings.seller.reservation_enabled).toBe(false);expect(server.sessions.size).toBe(0);expect(server.order().state).toBe('cancelled');expect(server.publicStatuses).toEqual([200,200]);cleanReport(report,logs,server.known);
}));

for(const publicFault of ['empty-store','empty-products','wrong-store','wrong-name','wrong-sku','wrong-title','wrong-price','wrong-revision','wrong-both-revisions','empty-media-body','wrong-media-store','wrong-media-revision'] as const)test(`published public projection rejects ${publicFault} and restores settings and sessions`,async()=>temporary(async file=>{
  const server=supplierMock({publicFault}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-reservations'],file),transport:server.transport,log:line=>logs.push(line)});
  expect(phase(report,'supplier-reservations').status).toBe('fail');expect(report).toMatchObject({overall:'fail',cloud_proof:false});
  expect(phase(report,'supplier-reservations').metrics?.public_projection_private).not.toBe(true);
  expect(server.publicStatuses).toEqual([200,200]);expect(server.order()).toBeNull();expect(paths(server.calls).some(path=>path.endsWith('/reservation-quotes'))).toBe(false);
  expect(server.settings.supplier.reservation_enabled||server.settings.seller.reservation_enabled).toBe(false);expect(server.sessions.size).toBe(0);
  for(const role of ['supplier','seller'])expect(report.cleanup.items).toContainEqual({phase:'supplier-reservations',item:`${role} reservation setting`,state:'restored'});
  cleanReport(report,logs,server.known);
}));

for(const pin of ['matched','missing','stale'] as const)test(`published photo phase requires the authenticated publication pin: ${pin}`,async()=>temporary(async file=>{
  const server=supplierMock({photo:true,photoProtocol:true}),logs:string[]=[];
  const first=await runCandidate({...base(['supplier-journey','supplier-reservations'],file),transport:server.transport,log:line=>logs.push(line)});
  expect(first.overall).toBe('pass');const saved=JSON.parse(await readFile(file,'utf8'));expect(saved.publication).toEqual({revision:'1',sku:'P0001'});
  if(pin==='missing')delete saved.publication;else if(pin==='stale')saved.publication.revision='2';await save(file,saved);
  // Exercise the real lower-level phase. The CLI still requires a same-run journey.
  const start=server.calls.length,secrets=new Secrets(),metrics:Record<string,unknown>={},cleanup:{item:string;state:string}[]=[];
  const ctx:PhaseContext={check(id,condition){if(!condition)throw Error(id);},metric(key,value){metrics[key]=value;},skip(reason):never{throw Error(reason);},cleanup(item,state){cleanup.push({item,state});}};
  const runner=supplierRun(base(['supplier-photo'],file,{supplierAccounts:{supplier:accounts.supplier}}),new CandidateClient(target,server.transport,null,secrets),secrets,syntheticPng,async()=>{throw Error('unexpected bookmark');});
  await runner.preflight(ctx);let failure:string|null=null;
  try{await runner.phases['supplier-photo'](ctx);}catch(error){failure=(error as Error).message;}finally{await runner.cleanup(ctx);}
  expect(failure).toBe(pin==='matched'?null:pin==='missing'?'supplier_publication_recorded':'supplier_public_store_matches');
  if(pin==='matched')expect(metrics).toMatchObject({public_projection:'covered_published',public_projection_private:true});else expect(metrics.public_projection_private).not.toBe(true);
  expect(server.publicStatuses).toEqual([200,200,200,200]);expect(paths(server.calls.slice(start)).filter(path=>path==='POST /api/v1/auth/login')).toHaveLength(1);
  expect(server.settings.supplier.reservation_enabled||server.settings.seller.reservation_enabled).toBe(false);expect(server.sessions.size).toBe(0);
  expect(cleanup).toContainEqual({item:'supplier synthetic account session',state:'restored'});cleanReport(first,logs,[...server.known,server.readPath]);
  expect(secrets.scrub({metrics,cleanup})).toEqual({value:{metrics,cleanup},hit:false});
}));

test('CLI photo-only stays blocked with an existing published handle and issues no domain writes',async()=>temporary(async file=>{
  const server=supplierMock({photo:true,photoProtocol:true});
  const first=await runCandidate({...base(['supplier-journey','supplier-reservations'],file),transport:server.transport});expect(first.overall).toBe('pass');
  const start=server.calls.length,report=await runCandidate({...base(['supplier-photo'],file,{supplierAccounts:{supplier:accounts.supplier}}),transport:server.transport});
  expect(phase(report,'supplier-photo')).toMatchObject({status:'blocked',reason:'requires supplier-journey pass'});expect(report).toMatchObject({overall:'blocked',cloud_proof:false});
  expect(paths(server.calls.slice(start))).toEqual(['GET /api/v1/health']);expect(server.sessions.size).toBe(0);expect(server.publicStatuses).toEqual([200,200]);cleanReport(report,[],server.known);
}));

test('failed seller OFF restores the supplier setting and revokes all sessions before failing the phase and run',async()=>{
  for(const offFailure of ['500','throw'] as const)await temporary(async file=>{
    const server=supplierMock({offFailure}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-reservations'],file),transport:server.transport,log:line=>logs.push(line)});
    expect(server.settings.supplier.reservation_enabled).toBe(false);expect(server.settings.seller.reservation_enabled).toBe(true);expect(server.sessions.size).toBe(0);expect(server.order().state).toBe('cancelled');
    const tail=server.calls.filter(c=>new URL(c.url).pathname.endsWith('/reservation-setting')).slice(-4);expect(paths(tail)).toEqual(['GET','PATCH','GET','PATCH'].map((m,i)=>`${m} /api/v1/tenants/${i<2?server.h.seller.tenant_id:server.h.supplier.tenant_id}/storefronts/${i<2?server.h.seller.instance_id:server.h.supplier.instance_id}/reservation-setting`));
    expect(report.cleanup.items).toEqual(expect.arrayContaining([{phase:'supplier-reservations',item:'seller reservation setting',state:'restore_failed'},{phase:'supplier-reservations',item:'supplier reservation setting',state:'restored'}]));
    expect(phase(report,'supplier-reservations')).toMatchObject({status:'fail',reason:'cleanup_restore_failed',checks:expect.arrayContaining([{id:'cleanup_restored',status:'fail'}])});expect(report).toMatchObject({overall:'fail',cloud_proof:false,cleanup:{restore_failed:true}});expect(logs).toContain('supplier-reservations: fail (cleanup_restore_failed)');cleanReport(report,logs,server.known);
  });
});

test('last supplier logout failure still logs out every other role and fails the final status',async()=>{
  for(const logoutFailure of ['500','throw'] as const)await temporary(async file=>{
    const server=supplierMock({logoutFailure}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-reservations'],file),transport:server.transport,log:line=>logs.push(line)});
    expect(server.sessions.size).toBe(1);expect(paths(server.calls).slice(-3)).toEqual(Array(3).fill('POST /api/v1/auth/logout'));
    for(const role of ['supplier','buyer'])expect(report.cleanup.items).toContainEqual({phase:'supplier-reservations',item:`${role} synthetic account session`,state:'restored'});
    expect(phase(report,'supplier-reservations')).toMatchObject({status:'fail',reason:'cleanup_restore_failed'});expect(report).toMatchObject({overall:'fail',cloud_proof:false,cleanup:{restore_failed:true}});expect(logs).toContain('supplier-reservations: fail (cleanup_restore_failed)');cleanReport(report,logs,server.known);
  });
});

test('CLI returns 1 for a restore failure using private role files and the same mock',async()=>temporary(async(file,directory)=>{
  const server=supplierMock({offFailure:'500'}),env:NodeJS.ProcessEnv={FREEDOM_CANDIDATE_SUPPLIER_HANDLE_FILE:file};
  for(const [role,account] of Object.entries(accounts)){const path=join(directory,role+'.json');await save(path,{...account,candidate_origin:target.origin,synthetic:true});env[`FREEDOM_CANDIDATE_${role.toUpperCase()}_ACCOUNT_FILE`]=path;}
  const original=globalThis.fetch,out=process.stdout.write,err=process.stderr.write;let output='';const logs:string[]=[];
  globalThis.fetch=async(input,init)=>{const request={url:String(input),method:init!.method!,headers:init!.headers as Record<string,string>,body:init!.body as string,timeoutMs:10000},reply=await server.transport(request);return new Response(new Uint8Array(reply.body),{status:reply.status,headers:reply.headers});};
  process.stdout.write=((chunk:any)=>{output+=String(chunk);return true;}) as typeof out;process.stderr.write=((chunk:any)=>{logs.push(String(chunk).trim());return true;}) as typeof err;
  let code:number;try{code=await main(['execute','--target','staging','--expected-release-sha',sha,'--expected-version','1.2.3','--phases','supplier-journey,supplier-reservations'],env);}finally{globalThis.fetch=original;process.stdout.write=out;process.stderr.write=err;}
  expect(code!).toBe(1);const report=JSON.parse(output);expect(report).toMatchObject({overall:'fail',cloud_proof:false,cleanup:{restore_failed:true}});expect(server.sessions.size).toBe(0);cleanReport(report,logs,server.known);
}));

test('published photo projections are verified and leaks appearing only after publish fail with cleanup',async()=>{
  for(const publicLeak of [undefined,'photo','read_path','private_path','product_id','cost_minor'] as const)await temporary(async file=>{
    const server=supplierMock({photo:true,photoProtocol:true,publicLeak}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-photo','supplier-reservations'],file),transport:server.transport,log:line=>logs.push(line)});
    expect(phase(report,'supplier-photo')).toMatchObject({status:'pass',metrics:{public_projection:'not_covered_unpublished',public_projection_private:null}});
    expect(phase(report,'supplier-reservations')).toMatchObject(publicLeak?{status:'fail',reason:['photo','read_path'].includes(publicLeak)?'supplier_public_photo_absent':publicLeak==='private_path'?'supplier_public_product_matches':'supplier_private_fields_not_public'}:{status:'pass',metrics:{public_projection_private:true,public_photo_checked:true}});
    expect(server.publicStatuses.slice(0,2)).toEqual([404,404]);expect(server.publicStatuses.slice(2)).toEqual([200,200]);expect(server.settings.supplier.reservation_enabled||server.settings.seller.reservation_enabled).toBe(false);expect(server.sessions.size).toBe(0);cleanReport(report,logs,[...server.known,server.readPath,server.h.seller.slug]);
  });
});

test('mixed unpublished public statuses fail with a fixed check',async()=>temporary(async file=>{
  const server=supplierMock({photo:true,photoProtocol:true,mixedPublic:true}),report=await runCandidate({...base(['supplier-journey','supplier-photo'],file),transport:server.transport});
  expect(phase(report,'supplier-photo')).toMatchObject({status:'fail',reason:'supplier_public_read_status'});expect(server.publicStatuses).toEqual([404,200]);expect(server.sessions.size).toBe(0);cleanReport(report,[],server.known);
}));

test('photo upload and reservation stock failures revoke sessions and preserve the original fixed reason',async()=>{
  for(const selected of ['supplier-photo','supplier-reservations'] as const)await temporary(async file=>{
    const server=supplierMock({photo:true,photoProtocol:true,uploadFailure:selected==='supplier-photo',stockAccepted:selected==='supplier-reservations',offFailure:selected==='supplier-reservations'?'throw':undefined}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey',selected],file),transport:server.transport,log:line=>logs.push(line)});
    expect(phase(report,selected)).toMatchObject({status:'fail',reason:selected==='supplier-photo'?'supplier_photo_uploaded':'supplier_stock_below_reserved_409'});expect(server.sessions.size).toBe(0);
    if(selected==='supplier-reservations'){expect(server.order().state).toBe('cancelled');expect(server.settings.supplier.reservation_enabled).toBe(false);expect(report.cleanup.items).toContainEqual({phase:selected,item:'seller reservation setting',state:'restore_failed'});expect(report.cleanup.items.some(i=>i.state==='residual_expected'&&i.item.includes('reservation'))).toBe(true);}
    expect(report.overall).toBe('fail');expect(report.cloud_proof).toBe(false);cleanReport(report,logs,server.known);
  });
});

test('stock failure cancels and turns both settings off before revoking every session',async()=>temporary(async file=>{
  const server=supplierMock({stockAccepted:true}),report=await runCandidate({...base(['supplier-journey','supplier-reservations'],file),transport:server.transport});
  expect(phase(report,'supplier-reservations')).toMatchObject({status:'fail',reason:'supplier_stock_below_reserved_409'});expect(server.order().state).toBe('cancelled');expect(server.settings.supplier.reservation_enabled||server.settings.seller.reservation_enabled).toBe(false);expect(server.sessions.size).toBe(0);
  for(const role of ['supplier','seller'])expect(report.cleanup.items).toContainEqual({phase:'supplier-reservations',item:`${role} reservation setting`,state:'restored'});cleanReport(report,[],server.known);
}));

for(const writeFailure of [false,true])test(`cleanup names account labels, time window and prefixes when ${writeFailure?'handle write':'decision'} fails`,async()=>{
  await temporary(async(file,directory)=>{
    const parent=join(directory,'private');await mkdir(parent);const path=join(parent,'handle.json');
    const server=supplierMock({decisionFailure:!writeFailure,beforeHandle:writeFailure?()=>rm(parent,{recursive:true}):undefined}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey'],path),transport:server.transport,log:line=>logs.push(line)});
    expect(phase(report,'supplier-journey')).toMatchObject({status:'fail',reason:writeFailure?'supplier_handle_written':'supplier_request_accepted'});expect(await stat(path).catch(()=>null)).toBeNull();expect(server.calls.filter(c=>new URL(c.url).pathname==='/api/v1/tenants')).toHaveLength(2);expect(server.sessions.size).toBe(0);
    const cleanup=report.cleanup.items.filter(i=>i.state==='cleanup_required').map(i=>i.item).join('\n');for(const text of ['wp07-supplier','wp07-seller','created at or after started_at','WP07 合成供貨','WP07 合成選物'])expect(cleanup).toContain(text);
    cleanReport(report,logs,[...server.known,server.h.seller.slug,server.h.expected.supplier_name.split(' ').at(-1)!]);
  });
});

test('restore failure fails the run while the last supplier phase remains not_run or blocked',async()=>{
  for(const blocked of [false,true])await temporary(async file=>{
    const server=supplierMock({logoutFailure:'500',staleAccepted:blocked}),logs:string[]=[],report=await runCandidate({...base(['supplier-journey','supplier-photo'],file),transport:server.transport,log:line=>logs.push(line)});
    expect(phase(report,'supplier-photo')).toMatchObject(blocked?{status:'blocked'}:{status:'not_run',reason:'photo_uploads_disabled'});expect(report).toMatchObject({overall:'fail',cloud_proof:false,cleanup:{restore_failed:true}});expect(server.sessions.size).toBe(1);cleanReport(report,logs,server.known);
  });
});

test('local harness: supplier acceptance and same-origin ON → OFF → ON bookmarks retain the exact synthetic data',async({browser,e2eAuthPool})=>{
  test.setTimeout(240000);await ownedSchema(e2eAuthPool);
  await temporary(async file=>{
    const identities:Record<string,Account>={},ids:string[]=[],known=new Set<string>([password]),logs:string[]=[];
    for(const [role,guild] of [['supplier','guild_product_quality_supply'],['seller','guild_commerce_sales'],['buyer','guild_commerce_sales']]){
      const id=randomUUID(),email=`wp07-${role}-${id}@example.test`;ids.push(id);known.add(id).add(email);
      await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required) VALUES($1,$2,$3,'WP07 合成會員',$4,$5,false)`,[id,DEMO_COMMUNITY,email,hashPassword(password),randomUUID()]);
      await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier) VALUES($1,$2,$3,$4,'active','full')`,[randomUUID(),DEMO_COMMUNITY,id,guild]);
      await e2eAuthPool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[DEMO_COMMUNITY,id,guild]);
      identities[role]={email,password,label:`wp07-${role}`};
    }
    const publicFields=new Set<string>(),storePhotoAssetStore=new FakeObjectStore();let app:ReturnType<typeof createApp>|undefined;
    const listener=serve({hostname:'127.0.0.1',port:0,fetch:request=>app?app.fetch(request):new Response(null,{status:503})});
    try{
      if(!listener.listening)await new Promise<void>((resolve,reject)=>{listener.once('listening',resolve);listener.once('error',reject);});
      const address=listener.address();if(!address||typeof address==='string')throw Error('Owned listener unavailable');
      const origin=`http://127.0.0.1:${address.port}`,local=localHarnessTarget(origin);
      const swap=(on:boolean)=>{app=createApp(e2eAuthPool,origin,'local',{guildLaunchpadEnabled:true,hostedReservationsEnabled:true,storePhotoAssetStore,...(on?{supplierConsoleEnabled:true}:{}),tenantCursorSigningKey:TENANT_CURSOR_TEST_KEY});app.use('/*',serveStatic({root:'./apps/portal-web/dist'}));app.get('*',serveStatic({path:'./apps/portal-web/dist/index.html'}));};
      const transport:Transport=async request=>{
        expect(new URL(request.url).origin).toBe(origin);
        for(const [key,value] of Object.entries(request.headers))if(/cookie|csrf|idempotency/i.test(key))known.add(value);
        const reply=await fetchTransport(request);for(const cookie of reply.headers.getSetCookie())known.add(cookie.split(';')[0].split('=')[1]);
        try{const text=Buffer.from(reply.body).toString();for(const id of text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)??[])known.add(id);const json=JSON.parse(text);if(new URL(request.url).pathname.startsWith('/api/v1/public/stores/')){const keys=(v:any):void=>{if(v&&typeof v==='object'){for(const [key,item] of Object.entries(v)){if(!Array.isArray(v))publicFields.add(key);keys(item);}}};keys(json);}if(json.csrf_token)known.add(json.csrf_token);}catch{/* binary response */}return reply;
      };
      const run=(selected:readonly string[],state:'on'|'off')=>runCandidate({...base(selected,file),target:local,expectedVersion:packageMetadata.version,expectedReleaseSha:null,supplierAccounts:identities,transport,browser,expectSupplierConsole:state,log:line=>logs.push(line)});
      swap(true);
      expect(await (await fetch(origin+'/api/v1/site')).json()).toMatchObject({commerce_console_enabled:false,commerce_checkout_enabled:false,supplier_console_enabled:true});
      const initial=await run(supplierPhases,'on');
      expect(initial.phases.filter(p=>p.status==='fail').map(p=>({phase:p.id,reason:p.reason,checks:p.checks.filter(c=>c.status==='fail')}))).toEqual([]);
      for(const id of ['supplier-journey','supplier-reservations','supplier-recheck'])expect(phase(initial,id).status,id).toBe('pass');
      expect(phase(initial,'supplier-photo')).toMatchObject({status:'not_run',reason:'photo_uploads_disabled'});
      expect(phase(initial,'supplier-reservations').metrics).toMatchObject({public_projection_private:true});
      expect(initial).toMatchObject({harness:'local_harness',cloud_proof:false});
      expect((await stat(file)).mode&0o777).toBe(0o600);const saved=JSON.parse(await readFile(file,'utf8'));expect(saved.reservation.state).toBe('cancelled');expect(saved.publication).toEqual({revision:expect.stringMatching(/^[1-9][0-9]*$/),sku:expect.stringMatching(/^P[0-9]{4,}$/)});
      expect((await e2eAuthPool.query('SELECT module_release_ref,application_release_ref FROM module_instances WHERE instance_id=ANY($1::uuid[])',[ [saved.supplier.instance_id,saved.seller.instance_id] ])).rows).toEqual(Array.from({length:2},()=>({module_release_ref:'storefront@1.1.0',application_release_ref:'hosted-store@1.1.0'})));
      for(const id of JSON.stringify(saved).match(/[0-9a-f-]{36}/g)??[])known.add(id);known.add(saved.seller.slug);
      swap(false);const off=await run(['supplier-recheck'],'off');expect(phase(off,'supplier-recheck')).toMatchObject({status:'pass',metrics:{console_routes_404:true,bookmark:'old_page',legacy_reads_matched:true,bookmark_values_matched:true}});
      swap(true);const on=await run(['supplier-recheck'],'on');expect(phase(on,'supplier-recheck')).toMatchObject({status:'pass',metrics:{bookmark:'console_page',legacy_reads_matched:true,console_reads_matched:true,bookmark_values_matched:true}});
      expect(JSON.parse(await readFile(file,'utf8'))).toEqual(saved);
      expect([...publicFields]).toEqual(expect.arrayContaining(['products','photos']));expect([...publicFields].filter(key=>['cost_minor','supply_price_minor','product_id','read_path','photo','shipping_minor','shipping_terms','return_terms'].includes(key))).toEqual([]);
      for(const report of [initial,off,on]){cleanReport(report,logs,known);expect(report).toMatchObject({harness:'local_harness',cloud_proof:false});}
      expect((await e2eAuthPool.query('SELECT count(*)::int n FROM sessions WHERE user_id=ANY($1::uuid[]) AND revoked_at IS NULL',[ids])).rows[0].n).toBe(0);
    }finally{if('closeAllConnections' in listener)listener.closeAllConnections();await new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));}
  });
});
