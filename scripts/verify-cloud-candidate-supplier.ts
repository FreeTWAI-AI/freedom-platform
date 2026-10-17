// Import-safe synthetic supplier acceptance. Identifiers belong only in the private handle.
import {randomBytes,randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {access,lstat,open,readFile,realpath,rename,rm} from 'node:fs/promises';
import {dirname,isAbsolute,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {Account,CandidateClient,PhaseContext,PhaseId,RunOptions,Secrets} from './verify-cloud-candidate-lib.js';

export const SUPPLIER_PHASES=['supplier-journey','supplier-photo','supplier-reservations','supplier-recheck'] as const;
export type SupplierRole='supplier'|'seller'|'buyer';
export function supplierRoles(phases:readonly PhaseId[]):SupplierRole[]{
  const roles=new Set<SupplierRole>();
  if(phases.some(id=>SUPPLIER_PHASES.includes(id as typeof SUPPLIER_PHASES[number])))roles.add('supplier');
  if(phases.some(id=>['supplier-journey','supplier-reservations','supplier-recheck'].includes(id)))roles.add('seller');
  if(phases.includes('supplier-reservations'))roles.add('buyer');
  return [...roles];
}
type Handle={candidate_origin:string;run_tag:string;created_at:string;supplier:{tenant_id:string;instance_id:string;product_id:string;offer_id:string};seller:{tenant_id:string;instance_id:string;selection_id:string;slug:string};expected:{supplier_name:string;product_name:string;description:string;seller_name:string;cost_minor:number;stock:number;shipping_minor:number;shipping_terms:string;return_terms:string;terms_version:string;retail_price_minor:number;decision_state:string};publication?:{revision:string;sku:string};reservation?:{order_id:string;state:string};photo?:{read_path:string;version:string}};
type Bookmark=(ctx:PhaseContext,account:Account,visit:(page:any)=>Promise<void>)=>Promise<void>;
const root=(h:Handle,role:'supplier'|'seller')=>`/api/v1/tenants/${h[role].tenant_id}/storefronts/${h[role].instance_id}`;
const isId=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const isVersion=(value:unknown):value is string=>typeof value==='string'&&/^[1-9][0-9]{0,18}$/.test(value);
const isSku=(value:unknown):value is string=>typeof value==='string'&&/^P[0-9]{4,}$/.test(value);
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export function supplierRun(options:RunOptions,client:CandidateClient,secrets:Secrets,png:()=>Uint8Array,bookmark:Bookmark){
  let handle:Handle|null=null,created=false,cleaned=false,journalRecorded=false;
  const sessions=new Map<SupplierRole,CandidateClient>(),loginReplies=new Map<SupplierRole,number>();
  const remember=(value:unknown,key='',content=true):void=>{
    if(typeof value==='string'){
      for(const id of value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)??[])secrets.add(id);
      if(!key||/_id$|_sha256$|_digest$|csrf|email|password|slug|read_path|run_tag/.test(key)||(content&&/_name$|^name$|^title$|description|shipping_terms|return_terms/.test(key)))secrets.add(value);
    }else if(value&&typeof value==='object'){if(/_digest$/.test(key)&&typeof (value as any).value==='string')secrets.add((value as any).value);for(const [name,item] of Object.entries(value))remember(item,name,content);}
  };
  const send=async(c:CandidateClient,method:string,path:string,input:Parameters<CandidateClient['request']>[2]={})=>{
    const reply=await c.request(method,path,input);
    // Register response identifiers, not public names or fixed Problem titles; expected private text is registered separately.
    remember(reply.json(),'',false);return reply;
  };
  const read=async(ctx:PhaseContext,c:CandidateClient,path:string,id:string)=>{const reply=await send(c,'GET',path);ctx.check(id,reply.status===200,`status ${reply.status}`);return reply.json();};
  async function preflight(ctx:PhaseContext){
    if(options.target.mode==='public'||!supplierRoles(options.phases).length)return;
    if(options.phases.includes('supplier-recheck'))ctx.check('supplier_expectation_configured',options.expectSupplierConsole==='on'||options.expectSupplierConsole==='off');
    const roles=supplierRoles(options.phases),accounts=roles.map(role=>options.supplierAccounts?.[role]);
    ctx.check('supplier_accounts_available',accounts.every(Boolean));
    for(const account of accounts){remember(account?.email);remember(account?.password);}
    ctx.check('supplier_accounts_distinct',new Set(accounts.map(a=>a!.email.toLowerCase())).size===roles.length&&new Set(accounts.map(a=>a!.label)).size===roles.length);
    const path=options.supplierHandleFile;
    ctx.check('supplier_handle_absolute',typeof path==='string'&&isAbsolute(path));
    const checkout=await realpath(fileURLToPath(new URL('..',import.meta.url))),parent=await realpath(dirname(path!)).catch(()=>null);
    const outside=(value:string)=>{const part=relative(checkout,value);return part==='..'||part.startsWith('../');};
    ctx.check('supplier_handle_outside_checkout',outside(resolve(path!))&&parent!==null&&outside(resolve(parent!,path!.slice(dirname(path!).length+1))));
    if(options.phases.some(id=>['supplier-journey','supplier-photo','supplier-reservations'].includes(id)))ctx.check('supplier_handle_parent_writable',await access(parent!,constants.W_OK|constants.X_OK).then(()=>true,()=>false));
    const info=await lstat(path!).catch(error=>{ctx.check('supplier_handle_accessible',error?.code==='ENOENT');return null;});
    if(options.phases.includes('supplier-journey')){ctx.check('supplier_handle_not_existing',info===null);return;}
    ctx.check('supplier_handle_private',!!info&&info.isFile()&&!info.isSymbolicLink()&&(info.mode&0o077)===0&&info.size<4096&&(typeof process.getuid!=='function'||info.uid===process.getuid()));
    let value:Handle|null=null;try{value=JSON.parse(await readFile(path!,'utf8'));}catch{/* fixed check below */}
    remember(value);ctx.check('supplier_handle_valid',validHandle(value));
    ctx.check('supplier_handle_origin',value!.candidate_origin===options.target.origin);
    handle=value;remember(handle);
  }
  function validHandle(value:unknown):value is Handle{
    const h=value as Handle|undefined,e=h?.expected;
    return !!h&&typeof h.candidate_origin==='string'&&/^[0-9a-f]{8}$/.test(h.run_tag)&&Number.isFinite(Date.parse(h.created_at))&&!!h.supplier&&!!h.seller&&[h.supplier.tenant_id,h.supplier.instance_id,h.supplier.product_id,h.supplier.offer_id,h.seller.tenant_id,h.seller.instance_id,h.seller.selection_id].every(isId)&&h.seller.slug===`wp07-${h.run_tag}`&&!!e&&['supplier_name','product_name','description','seller_name','shipping_terms','return_terms','terms_version','decision_state'].every(key=>typeof e[key as keyof typeof e]==='string')&&['cost_minor','stock','shipping_minor','retail_price_minor'].every(key=>Number.isSafeInteger(e[key as keyof typeof e]))&&(!h.publication||(isVersion(h.publication.revision)&&isSku(h.publication.sku)))&&(!h.reservation||(isId(h.reservation.order_id)&&['reserved','cancelled'].includes(h.reservation.state)))&&(!h.photo||(typeof h.photo.read_path==='string'&&h.photo.read_path.startsWith(root(h,'supplier')+'/products/'+h.supplier.product_id+'/photo/')&&/^\d+$/.test(h.photo.version)));
  }
  async function persist(ctx:PhaseContext,exclusive=false){
    remember(handle);const data=JSON.stringify(handle);ctx.check('supplier_handle_bounded',Buffer.byteLength(data)<4096);
    const path=options.supplierHandleFile!,temporary=path+'.'+randomBytes(8).toString('hex')+'.tmp';
    try{if(exclusive){const file=await open(path,'wx',0o600);try{await file.writeFile(data);}finally{await file.close();}created=true;return;}
    try{const file=await open(temporary,'wx',0o600);try{await file.writeFile(data);}finally{await file.close();}await rename(temporary,path);}finally{await rm(temporary,{force:true});}}catch{ctx.check('supplier_handle_written',false);}
  }
  async function login(ctx:PhaseContext,role:SupplierRole){
    const existing=sessions.get(role);if(existing)return existing;
    const account=options.supplierAccounts![role]!,session=client.withoutSession();sessions.set(role,session);
    const reply=await send(session,'POST','/api/v1/auth/login',{json:{email:account.email,password:account.password},csrf:null});
    loginReplies.set(role,reply.status);const body=reply.json();if(typeof body?.csrf_token==='string')session.csrf=body.csrf_token;
    ctx.check('supplier_login_200',reply.status===200);
    ctx.check('supplier_login_account',body?.user?.email?.toLowerCase()===account.email.toLowerCase());
    ctx.check('supplier_login_session',session.hasSession()&&typeof body?.csrf_token==='string');session.csrf=body.csrf_token;return session;
  }
  async function logout(ctx:PhaseContext,role:SupplierRole){
    const session=sessions.get(role);if(!session)return;
    if(!session.hasSession()){const status=loginReplies.get(role),restored=status!==undefined&&status>=400&&status<500;sessions.delete(role);ctx.cleanup(`${role} synthetic account session`,restored?'restored':'restore_failed');return restored;}
    let restored=false;try{
      if(!session.csrf){const current=await send(session,'GET','/api/v1/session');if(current.status===401&&current.json()?.code==='session_expired')restored=true;else if(current.status===200&&typeof current.json()?.csrf_token==='string')session.csrf=current.json().csrf_token;}
      if(!restored){const reply=await send(session,'POST','/api/v1/auth/logout',{json:{}});restored=reply.status===200&&!session.hasSession();}
    }catch{/* cleanup is reported without remote text */}
    ctx.cleanup(`${role} synthetic account session`,restored?'restored':'restore_failed');
    if(restored)sessions.delete(role);return restored;
  }
  async function cleanup(ctx:PhaseContext){if(cleaned)return;cleaned=true;for(const role of [...sessions.keys()])await logout(ctx,role);}
  async function guard(ctx:PhaseContext,photo=false){
    if(options.target.mode==='public')ctx.skip('production_supplier_phases_guarded');
    const site=await read(ctx,client,'/api/v1/site','supplier_site_200');
    if(site.supplier_console_enabled!==true)ctx.skip('supplier_console_disabled');
    if(photo&&site.hosted_store_photo_uploads_enabled!==true)ctx.skip('photo_uploads_disabled');
  }
  function current(ctx:PhaseContext){ctx.check('supplier_handle_available',handle!==null&&(created||!options.phases.includes('supplier-journey')));return handle!;}
  async function launch(ctx:PhaseContext,c:CandidateClient,name:string,guild:string){
    if(!journalRecorded){journalRecorded=true;ctx.cleanup('journal facts and supplier decisions','residual_expected');}
    const role=guild==='guild_product_quality_supply'?'supplier':'seller';
    ctx.cleanup(role==='supplier'?`synthetic supply business, products, terms and published supply version: root deactivates every tenant owned by the dedicated account ${options.supplierAccounts!.supplier!.label} created at or after started_at (names start with "WP07 合成供貨"); the private handle, when present, lists the exact ids`:`synthetic seller store and selection: root deactivates every tenant owned by the dedicated account ${options.supplierAccounts!.seller!.label} created at or after started_at (names start with "WP07 合成選物"); the private handle, when present, lists the exact ids`,'cleanup_required');
    const space=await send(c,'POST','/api/v1/tenants',{json:{display_name:name},idempotency:true});ctx.check('supplier_tenant_created',space.status===201);
    const tenant=space.json()?.tenant?.tenant_id,workspace=space.json()?.workspace?.workspace_id;ctx.check('supplier_launch_identifiers',isId(tenant)&&isId(workspace));
    const plan=await send(c,'POST',`/api/v1/tenants/${tenant}/application-launch-plans`,{json:{guild_key:guild,workspace_id:workspace,application_key:'hosted-store',release_ref:'hosted-store@1.1.0',installation_choice:'create_new',dependencies:[{requirement_key:'storefront',choice:'create',configuration:{}}],configuration:{}},idempotency:true});
    if(plan.status===403&&['full_membership_required','guild_membership_required','guild_full_membership_required','guild_full_member_required'].includes(plan.json()?.code))ctx.skip('synthetic_account_not_store_eligible');
    ctx.check('supplier_launch_plan_created',plan.status===201);const p=plan.json();ctx.check('supplier_launch_plan_values',isId(p?.plan_id)&&isVersion(p?.version)&&p?.configuration_digest?.algorithm==='sha256'&&/^[0-9a-f]{64}$/.test(p.configuration_digest.value));
    const install=await send(c,'POST',`/api/v1/tenants/${tenant}/application-installations`,{json:{plan_id:p.plan_id,expected_plan_version:p.version,configuration_digest:p.configuration_digest},idempotency:true});
    if(install.status===403&&['full_membership_required','guild_membership_required','guild_full_membership_required','guild_full_member_required'].includes(install.json()?.code))ctx.skip('synthetic_account_not_store_eligible');
    ctx.check('supplier_installation_succeeded',install.status===200&&install.json()?.state==='succeeded'&&isId(install.json()?.operation_id));
    const view=await read(ctx,c,`/api/v1/tenants/${tenant}/application-installations/by-operation/${install.json().operation_id}`,'supplier_installation_read');
    const instance=view.modules?.find((m:any)=>m.requirement_key==='storefront')?.instance_id;ctx.check('supplier_storefront_present',isId(instance));return {tenant_id:tenant,instance_id:instance};
  }
  function productMatches(p:any,h:Handle,consoleRead=false){const e=h.expected;return p?.product_id===h.supplier.product_id&&p.title===e.product_name&&p.description===e.description&&(consoleRead?p.supply_price_minor:p.cost_minor)===e.cost_minor&&p.stock===e.stock&&(!consoleRead||(p.reserved===0&&p.available===e.stock));}
  function termsMatch(t:any,h:Handle){const e=h.expected;return t?.cost_minor===e.cost_minor&&t.shipping_minor===e.shipping_minor&&t.shipping_terms===e.shipping_terms&&t.return_terms===e.return_terms;}
  function selectionMatches(s:any,h:Handle){return s?.selection_id===h.seller.selection_id&&s.seller_name===h.expected.seller_name&&s.retail_price_minor===h.expected.retail_price_minor&&s.state===h.expected.decision_state&&s.offer?.offer_id===h.supplier.offer_id&&s.offer.product_id===h.supplier.product_id&&s.offer.source_version===h.expected.terms_version&&termsMatch(s.offer.terms,h);}
  async function journey(ctx:PhaseContext){
    await guard(ctx);const tag=randomBytes(4).toString('hex');remember(tag);
    const expected={supplier_name:`WP07 合成供貨 ${tag}`,product_name:`WP07 合成商品 ${tag}`,description:'合成商品說明',seller_name:`WP07 合成選物 ${tag}`,cost_minor:15000,stock:10,shipping_minor:2000,shipping_terms:'合成出貨條款',return_terms:'合成退貨條款',terms_version:'2',retail_price_minor:22000,decision_state:'sellable'};
    remember(expected);const a=await login(ctx,'supplier'),b=await login(ctx,'seller');
    const supplier=await launch(ctx,a,expected.supplier_name,'guild_product_quality_supply'),r=`/api/v1/tenants/${supplier.tenant_id}/storefronts/${supplier.instance_id}`;
    const before=await read(ctx,a,r+'/supply-profile','supplier_profile_read');ctx.check('supplier_setup_required',before.setup_state==='setup_required');
    const profile=await send(a,'POST',r+'/supply-profile',{json:{name:expected.supplier_name,description:'合成供貨事業',currency:'TWD'},idempotency:true});ctx.check('supplier_profile_created',profile.status===201);
    const initial=await read(ctx,a,r+'/supplier-console/overview','supplier_initial_overview');ctx.check('supplier_initial_metrics_ready_zero',Object.keys(initial.metrics??{}).length===4&&['offered_products','pending_requests','active_reservation_lines','out_of_stock_products'].every(key=>initial.metrics[key]?.state==='ready'&&initial.metrics[key].count===0));ctx.check('supplier_initial_no_todo',initial.todos?.state==='ready'&&initial.todos.items.length===0);
    const key=randomUUID(),body={title:expected.product_name,description:expected.description,cost_minor:expected.cost_minor,stock:expected.stock};
    const first=await send(a,'POST',r+'/supply-products',{json:body,idempotency:key});ctx.check('supplier_product_created',first.status===201);const productId=first.json()?.product_id;ctx.check('supplier_product_identifier',isId(productId)&&isVersion(first.json()?.version));
    const replay=await send(a,'POST',r+'/supply-products',{json:body,idempotency:key});ctx.check('supplier_replay_same_product',replay.status===201&&replay.json()?.product_id===productId);
    const list=await read(ctx,a,r+'/supplier-console/products','supplier_product_list');const matching=list.items?.filter((p:any)=>p.title===expected.product_name);ctx.check('supplier_single_product',matching?.length===1&&matching[0].product_id===productId&&matching[0].description===expected.description&&matching[0].supply_price_minor===expected.cost_minor&&matching[0].stock===expected.stock&&matching[0].reserved===0&&matching[0].available===expected.stock);
    const input={cost_minor:expected.cost_minor,shipping_minor:expected.shipping_minor,shipping_terms:expected.shipping_terms,return_terms:expected.return_terms};
    const terms=await send(a,'PATCH',r+`/products/${productId}/supply-terms`,{json:input,idempotency:true,ifMatch:first.json().version});ctx.check('supplier_terms_saved',terms.status===200);expected.terms_version=terms.json().version;
    const stale=await send(a,'PATCH',r+`/products/${productId}/supply-terms`,{json:{...input,shipping_minor:9999},idempotency:true,ifMatch:first.json().version});ctx.check('supplier_stale_if_match_412',stale.status===412);
    const unchanged=await read(ctx,a,r+`/products/${productId}/supply-terms`,'supplier_terms_read');ctx.check('supplier_stale_write_unchanged',Object.entries(input).every(([k,v])=>unchanged[k]===v)&&unchanged.version===expected.terms_version);
    const published=await send(a,'POST',r+`/products/${productId}/supply-offer`,{json:{},idempotency:true,ifMatch:terms.json().version});ctx.check('supplier_offer_published',published.status===200&&published.json()?.state==='offered');
    const offer=published.json();ctx.check('supplier_offer_identifier',isId(offer?.offer_id)&&offer.product_id===productId);
    const offered=await read(ctx,a,r+'/supplier-console/overview','supplier_offered_overview');ctx.check('supplier_public_supply_count',offered.metrics?.offered_products?.state==='ready'&&offered.metrics.offered_products.count===1);
    const seller=await launch(ctx,b,expected.seller_name,'guild_commerce_sales'),s=`/api/v1/tenants/${seller.tenant_id}/storefronts/${seller.instance_id}`,slug=`wp07-${tag}`;remember(slug);
    const setup=await send(b,'POST',s+'/setup',{json:{name:expected.seller_name,slug,currency:'TWD'},idempotency:true});ctx.check('supplier_seller_setup',setup.status===201);
    const catalog=await read(ctx,b,s+'/supply-catalog','supplier_seller_catalog');const version=catalog.items?.find((v:any)=>v.terms?.title===expected.product_name);ctx.check('supplier_catalog_version',version?.offer_id===offer.offer_id&&version?.source_version===expected.terms_version);
    const proposal=await send(b,'POST',s+'/distribution-selections',{json:{offer_id:version.offer_id,terms_sha256:version.terms_sha256,retail_price_minor:expected.retail_price_minor},idempotency:true});ctx.check('supplier_selection_created',proposal.status===201);
    const overview=await read(ctx,a,r+'/supplier-console/overview','supplier_request_overview');const todo=overview.todos?.items?.find((t:any)=>t.kind==='request_pending'&&t.product_id===productId);ctx.check('supplier_request_discovered',isId(todo?.selection_id)&&todo.selection_id===proposal.json()?.selection_id);
    const request=await read(ctx,a,r+`/supplier-console/requests/${todo.selection_id}`,'supplier_request_read');const selection=request.request;
    ctx.check('supplier_request_values',selection.selection_id===todo.selection_id&&request.product?.product_id===productId&&selection.offer?.offer_id===offer.offer_id&&selection.seller_name===expected.seller_name&&selection.retail_price_minor===expected.retail_price_minor&&Object.entries(input).every(([k,v])=>selection.offer.terms[k]===v)&&selection.retail_price_minor-selection.offer.terms.cost_minor-selection.offer.terms.shipping_minor===5000);
    const decision=await send(a,'POST',r+`/supply-requests/${selection.selection_id}/decision`,{json:{decision:'accepted',listing_sha256:selection.listing_sha256},idempotency:true,ifMatch:selection.version});ctx.check('supplier_request_accepted',decision.status===200&&decision.json()?.state==='sellable');
    handle={candidate_origin:options.target.origin,run_tag:tag,created_at:(options.now?.()??new Date()).toISOString(),supplier:{...supplier,product_id:productId,offer_id:offer.offer_id},seller:{...seller,selection_id:selection.selection_id,slug},expected};
    const selections=await read(ctx,b,s+'/distribution-selections','supplier_seller_selection_read');ctx.check('supplier_seller_sellable',selectionMatches(selections.items?.find((v:any)=>v.selection_id===selection.selection_id),handle));
    ctx.check('supplier_j02_logout',await logout(ctx,'supplier')===true);const fresh=await login(ctx,'supplier');
    const profileAfter=await read(ctx,fresh,r+'/supply-profile','supplier_j02_profile');ctx.check('supplier_j02_business',profileAfter.instance_id===supplier.instance_id&&profileAfter.catalog?.name===expected.supplier_name);
    // The console API rejects query parameters; the UI filters offered products in memory.
    const again=await read(ctx,fresh,r+'/supplier-console/products','supplier_j02_products');const product=again.items?.find((p:any)=>p.product_id===productId);ctx.check('supplier_j02_values',productMatches(product,handle,true)&&product.offer?.offer_id===offer.offer_id);
    await persist(ctx,true);ctx.metric('replay_same_product',true);ctx.metric('stale_write_rejected',true);ctx.metric('fresh_login_matched',true);
  }
  async function publicReads(ctx:PhaseContext,h:Handle,published=false){
    const replies=[];for(const suffix of ['', '/media'])replies.push(await send(client,'GET',`/api/v1/public/stores/${h.seller.slug}${suffix}`,{session:false}));
    const covered=replies.every(reply=>reply.status===200);ctx.check('supplier_public_read_status',covered||(!published&&replies.every(reply=>reply.status===404)));
    if(!covered)return false;
    const bodies=replies.map(reply=>reply.json());for(const body of bodies)ctx.check('supplier_public_json',body&&typeof body==='object'&&!Array.isArray(body));
    // Anchor every published read, even when the photo phase observes an already published store, to authenticated publication evidence.
    ctx.check('supplier_publication_recorded',!!h.publication);const [store,media]=bodies,pin=h.publication!;
    ctx.check('supplier_public_store_matches',store.slug===h.seller.slug&&store.name===h.expected.seller_name&&store.currency==='TWD'&&store.revision===pin.revision);
    const products=Array.isArray(store.products)?store.products.filter((p:any)=>p?.sku===pin.sku):[];
    ctx.check('supplier_public_product_matches',products.length===1&&products[0].title===h.expected.product_name&&products[0].description===h.expected.description&&products[0].price_minor===h.expected.retail_price_minor);
    ctx.check('supplier_public_media_matches',media.profile==='freedom.hosted-store-media/v1'&&media.slug===h.seller.slug&&media.revision===pin.revision&&Array.isArray(media.photos));
    const noPhoto=(value:any):boolean=>!value||typeof value!=='object'||Object.entries(value).every(([key,item])=>!((key==='photo'||key==='read_path')&&item!==null)&&(key!=='photos'||Array.isArray(item)&&item.length===0)&&noPhoto(item));
    for(const body of bodies){const text=JSON.stringify(body);ctx.check('supplier_private_fields_not_public',!text.includes('cost_minor')&&!text.includes(h.supplier.product_id)&&(!h.photo||!text.includes(h.photo.read_path)));ctx.check('supplier_public_photo_absent',noPhoto(body));}
    return true;
  }
  async function photo(ctx:PhaseContext){
    await guard(ctx,true);const h=current(ctx),a=await login(ctx,'supplier'),r=root(h,'supplier');
    const media=await read(ctx,a,r+'/product-media','supplier_media_read'),item=media.items?.find((v:any)=>v.product_id===h.supplier.product_id);ctx.check('supplier_media_product_present',!!item);
    const uploaded=await send(a,'POST',r+`/products/${h.supplier.product_id}/photo`,{bytes:png(),contentType:'image/png',idempotency:true,ifMatch:item.version});ctx.check('supplier_photo_uploaded',uploaded.status===200);
    const result=uploaded.json(),image=result.current?.photo;ctx.check('supplier_photo_metadata',result.product_id===h.supplier.product_id&&result.changed===true&&isVersion(result.current?.version)&&result.completed_version===result.current.version&&result.current.version!==item.version&&image?.read_path===r+`/products/${h.supplier.product_id}/photo/${result.current.version}`&&image.content_type==='image/webp'&&image.width===320&&image.height===240);h.photo={read_path:image.read_path,version:result.current.version};remember(h.photo);ctx.cleanup('retained synthetic product photo version','residual_expected');await persist(ctx);
    const privateRead=await send(a,'GET',image.read_path);ctx.check('supplier_photo_private_read',privateRead.status===200&&privateRead.headers.get('content-type')?.startsWith('image/webp')===true&&/no-store/.test(privateRead.headers.get('cache-control')??'')&&privateRead.bytes===image.byte_size);
    const bytes=Buffer.from(privateRead.body());let width=0,height=0;
    if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP')for(let at=12;at+8<=bytes.length;){const type=bytes.toString('ascii',at,at+4),size=bytes.readUInt32LE(at+4),p=at+8;if(p+size>bytes.length)break;if(type==='VP8X'&&size>=10){width=1+bytes.readUIntLE(p+4,3);height=1+bytes.readUIntLE(p+7,3);break;}if(type==='VP8 '&&size>=10){width=bytes.readUInt16LE(p+6)&16383;height=bytes.readUInt16LE(p+8)&16383;break;}if(type==='VP8L'&&size>=5&&bytes[p]===47){const bits=bytes.readUInt32LE(p+1);width=1+(bits&16383);height=1+((bits>>>14)&16383);break;}at=p+size+(size&1);}
    ctx.check('supplier_photo_dimensions',width===320&&height===240);const covered=await publicReads(ctx,h);ctx.metric('private_photo_verified',true);ctx.metric('public_projection',covered?'covered_published':'not_covered_unpublished');ctx.metric('public_projection_private',covered?true:null);
  }
  async function reservationLine(ctx:PhaseContext,a:CandidateClient,h:Handle,state:string){const page=await read(ctx,a,root(h,'supplier')+'/supply-reservations','supplier_reservations_read');const lines=page.items?.filter((o:any)=>o.order_id===h.reservation!.order_id);ctx.check('supplier_reservation_own_line',page.items?.length===1&&lines?.length===1&&lines[0].state===state&&lines[0].items?.length===1&&lines[0].items[0].product_id===h.supplier.product_id&&lines[0].items[0].quantity===1);}
  async function reservations(ctx:PhaseContext){
    await guard(ctx);const h=current(ctx),a=await login(ctx,'supplier'),r=root(h,'supplier');
    const setting=await read(ctx,a,r+'/reservation-setting','supplier_reservation_setting');if(setting.admission_enabled!==true)ctx.skip('reservations_admission_off');
    const b=await login(ctx,'seller'),s=root(h,'seller'),sellerSetting=await read(ctx,b,s+'/reservation-setting','supplier_seller_reservation_setting');if(sellerSetting.admission_enabled!==true)ctx.skip('reservations_admission_off');
    ctx.check('supplier_reservations_initially_off',setting.reservation_enabled===false&&sellerSetting.reservation_enabled===false);
    let buyer:CandidateClient|null=null,order:any=null,cancelKey:string|null=null,cancelled=false,reservationAttempted=false;const touched:{client:CandidateClient;root:string;role:string}[]=[];
    const cancel=async()=>{const reply=await send(buyer!,'POST',`/api/v1/me/reservations/${order.order_id}/cancel`,{json:{},ifMatch:order.version,idempotency:cancelKey!});return reply;};
    try{
      for(const [c,path,v,role] of [[a,r,setting.version,'supplier'],[b,s,sellerSetting.version,'seller']] as const){touched.push({client:c,root:path,role});const enabled=await send(c,'PATCH',path+'/reservation-setting',{json:{reservation_enabled:true},ifMatch:v,idempotency:true});ctx.check('supplier_reservations_enabled',enabled.status===200&&enabled.json()?.reservation_enabled===true);}
      const store=await read(ctx,b,s,'supplier_seller_store_read'),published=await send(b,'POST',s+'/publish',{json:{},ifMatch:store.version,idempotency:true});ctx.check('supplier_seller_published',published.status===200);
      const page=await read(ctx,b,s,'supplier_published_store_read'),selections=await read(ctx,b,s+'/distribution-selections','supplier_reservation_selection');const selected=selections.items?.find((v:any)=>v.selection_id===h.seller.selection_id);ctx.check('supplier_reservation_selection_sellable',selectionMatches(selected,h));
      ctx.check('supplier_published_store_matches',page.store?.slug===h.seller.slug&&page.store.name===h.expected.seller_name&&page.store.currency==='TWD'&&page.publication?.state==='published'&&isVersion(page.publication.current_revision)&&published.json()?.publication?.state==='published'&&published.json().publication.current_revision===page.publication.current_revision);
      ctx.check('supplier_published_selection_sku',isSku(selected.sku));h.publication={revision:page.publication.current_revision,sku:selected.sku};await persist(ctx);
      await publicReads(ctx,h,true);ctx.metric('public_projection_private',true);if(h.photo)ctx.metric('public_photo_checked',true);buyer=await login(ctx,'buyer');
      const quote=await send(buyer,'POST',`/api/v1/hosted-stores/${h.seller.slug}/reservation-quotes`,{json:{publication_revision:page.publication.current_revision,items:[{sku:selected.sku,quantity:1}]},idempotency:true});ctx.check('supplier_quote_created',quote.status===201);
      const q=quote.json();reservationAttempted=true;const placed=await send(buyer,'POST',`/api/v1/hosted-stores/${h.seller.slug}/reservation-orders`,{json:{quote_id:q.quote_id,terms_sha256:q.terms_sha256,client_order_id:randomUUID()},idempotency:true});ctx.check('supplier_reservation_created',placed.status===201&&placed.json()?.state==='reserved'&&isId(placed.json()?.order_id)&&isVersion(placed.json()?.version));order=placed.json();cancelKey=randomUUID();h.reservation={order_id:order.order_id,state:'reserved'};await persist(ctx);
      await reservationLine(ctx,a,h,'reserved');const list=await read(ctx,a,r+'/supplier-console/products','supplier_reserved_products'),product=list.items?.find((p:any)=>p.product_id===h.supplier.product_id);ctx.check('supplier_reserved_stock',product?.stock===h.expected.stock&&product.reserved===1&&product.available===h.expected.stock-1);
      const conflict=await send(a,'PATCH',r+`/supply-products/${h.supplier.product_id}`,{json:{stock:0},ifMatch:product.version,idempotency:true});ctx.check('supplier_stock_below_reserved_409',conflict.status===409);
      const after=await read(ctx,a,r+'/supplier-console/products','supplier_stock_conflict_read'),unchanged=after.items?.find((p:any)=>p.product_id===h.supplier.product_id);ctx.check('supplier_stock_conflict_unchanged',unchanged?.stock===h.expected.stock&&unchanged.reserved===1&&unchanged.available===h.expected.stock-1);
      const first=await cancel();ctx.check('supplier_cancelled',first.status===200&&first.json()?.state==='cancelled');cancelled=true;h.reservation.state='cancelled';await persist(ctx);
      const replay=await cancel();ctx.check('supplier_cancel_replay',replay.status===200&&same(replay.json(),first.json()));await reservationLine(ctx,a,h,'cancelled');
      const restored=await read(ctx,a,r+'/supplier-console/products','supplier_released_products');ctx.check('supplier_stock_released_once',productMatches(restored.items?.find((p:any)=>p.product_id===h.supplier.product_id),h,true));ctx.metric('reservation_cancelled',true);ctx.metric('stock_released_once',true);
    }finally{
      if(order&&!cancelled){try{const reply=await cancel();if(reply.status===200&&reply.json()?.state==='cancelled'){cancelled=true;h.reservation!.state='cancelled';await persist(ctx);}}catch{/* retained reservation is reported below */}}
      if(reservationAttempted)ctx.cleanup(`synthetic reservation and its retained history: root cancels every reservation by the dedicated account ${options.supplierAccounts!.buyer!.label} created at or after started_at in tenants owned by ${options.supplierAccounts!.seller!.label} (names start with "WP07 合成選物"), then deactivates those tenants and the ${options.supplierAccounts!.supplier!.label} tenants (names start with "WP07 合成供貨"); the private handle, when present, lists the exact ids`,cancelled?'residual_expected':'cleanup_required');
      for(const item of touched.reverse()){let restored=false;try{const now=await send(item.client,'GET',item.root+'/reservation-setting');if(now.status===200){const body=now.json();if(body.reservation_enabled===false)restored=true;else{const off=await send(item.client,'PATCH',item.root+'/reservation-setting',{json:{reservation_enabled:false},ifMatch:body.version,idempotency:true});restored=off.status===200&&off.json()?.reservation_enabled===false;}}}catch{/* fixed cleanup result */}ctx.cleanup(`${item.role} reservation setting`,restored?'restored':'restore_failed');}
    }
  }
  async function recheck(ctx:PhaseContext){
    if(options.target.mode==='public')ctx.skip('production_supplier_phases_guarded');const h=current(ctx),e=h.expected;
    const site=await read(ctx,client,'/api/v1/site','supplier_recheck_site');ctx.check('supplier_console_state_mismatch',site.supplier_console_enabled===(options.expectSupplierConsole==='on'));
    ctx.metric('expected_state',options.expectSupplierConsole);const a=await login(ctx,'supplier'),b=await login(ctx,'seller'),r=root(h,'supplier'),s=root(h,'seller');
    const profile=await read(ctx,a,r+'/supply-profile','supplier_legacy_profile');ctx.check('supplier_legacy_business_matches',profile.instance_id===h.supplier.instance_id&&profile.catalog?.name===e.supplier_name);
    const products=await read(ctx,a,r+'/supply-products','supplier_legacy_products');ctx.check('supplier_legacy_product_matches',products.items?.length===1&&productMatches(products.items[0],h));
    const terms=await read(ctx,a,r+`/products/${h.supplier.product_id}/supply-terms`,'supplier_legacy_terms');ctx.check('supplier_legacy_terms_match',termsMatch(terms,h)&&terms.stock===e.stock&&terms.reserved===0&&terms.available===e.stock&&terms.version===(h.photo?.version??e.terms_version));
    const offers=await read(ctx,a,r+'/supply-offers','supplier_legacy_offers'),offer=offers.items?.find((v:any)=>v.offer_id===h.supplier.offer_id);ctx.check('supplier_legacy_offer_matches',offer?.state==='offered'&&offer.source_version===e.terms_version&&offer.terms?.title===e.product_name&&offer.terms.description===e.description&&termsMatch(offer.terms,h));
    const selections=await read(ctx,b,s+'/distribution-selections','supplier_legacy_selections');ctx.check('supplier_legacy_selection_matches',selectionMatches(selections.items?.find((v:any)=>v.selection_id===h.seller.selection_id),h));
    if(h.reservation)await reservationLine(ctx,a,h,h.reservation.state);ctx.metric('legacy_reads_matched',true);
    if(options.expectSupplierConsole==='off'){
      for(const path of ['/supplier-console/overview','/supplier-console/products',`/supplier-console/requests/${h.seller.selection_id}`]){const reply=await send(a,'GET',r+path);ctx.check('supplier_console_routes_404',reply.status===404);}ctx.metric('console_routes_404',true);ctx.metric('console_reads_matched',null);
    }else{
      const overview=await read(ctx,a,r+'/supplier-console/overview','supplier_recheck_overview');ctx.check('supplier_console_overview_matches',overview.tenant_id===h.supplier.tenant_id&&overview.instance_id===h.supplier.instance_id&&overview.metrics?.offered_products?.count===1&&overview.metrics.pending_requests.count===0&&overview.metrics.active_reservation_lines.count===0);
      const list=await read(ctx,a,r+'/supplier-console/products','supplier_recheck_products');ctx.check('supplier_console_product_matches',list.items?.length===1&&productMatches(list.items[0],h,true)&&list.items[0].offer?.offer_id===h.supplier.offer_id);
      const request=await read(ctx,a,r+`/supplier-console/requests/${h.seller.selection_id}`,'supplier_recheck_request');ctx.check('supplier_console_request_matches',request.product?.product_id===h.supplier.product_id&&selectionMatches(request.request,h));ctx.metric('console_reads_matched',true);ctx.metric('console_routes_404',null);
    }
    ctx.check('browser_required',!!options.browser);
    await bookmark(ctx,options.supplierAccounts!.supplier!,async page=>{
      const landing=await page.goto(options.target.origin+'/',{waitUntil:'domcontentloaded'});ctx.check('supplier_bookmark_landing',landing?.status()===200);
      await page.getByLabel('電子郵件',{exact:true}).fill(options.supplierAccounts!.supplier!.email);await page.getByLabel('密碼',{exact:true}).fill(options.supplierAccounts!.supplier!.password);await page.getByRole('button',{name:'登入',exact:true}).click();await page.getByRole('button',{name:'設定',exact:true}).waitFor({state:'visible',timeout:20000});
      await page.goto(`${options.target.origin}/#stores/${h.supplier.tenant_id}/${h.supplier.instance_id}/supply/products/${h.supplier.product_id}`,{waitUntil:'domcontentloaded'});
      const on=options.expectSupplierConsole==='on',area=page.locator(on?'.supplier-console':'.hosted-supply-catalog');await area.getByRole('heading',{name:on?'商品詳情：'+e.product_name:e.supplier_name,exact:true}).first().waitFor({state:'visible',timeout:20000});ctx.check('supplier_bookmark_business_found',await page.getByText('找不到這間商店',{exact:false}).count()===0&&await page.getByText('找不到這個供貨商品庫',{exact:false}).count()===0);
      if(on){
        const stock=area.getByText(new RegExp('^庫存 '+e.stock+'／.*／可用 '+e.stock+'$'));await stock.waitFor({state:'visible',timeout:20000});
        const form=area.getByRole('form',{name:'儲存供貨條件',exact:true});await form.waitFor({state:'visible',timeout:20000});
        for(const [label,value] of [['供貨單價',(e.cost_minor/100).toFixed(2)],['每件運費',(e.shipping_minor/100).toFixed(2)],['出貨條件',e.shipping_terms],['退貨條件',e.return_terms]])ctx.check('supplier_bookmark_values_match',await form.getByRole('textbox',{name:label,exact:true}).inputValue({timeout:20000})===value);
      }else{
        const card=area.locator('article.hosted-store-product').filter({has:page.getByRole('heading',{name:e.product_name,exact:true})});await card.waitFor({state:'visible',timeout:20000});
        // Match formatMinor's fixed TWD display without importing portal code into the tool.
        const amount=new Intl.NumberFormat('zh-TW',{style:'currency',currency:'TWD',minimumFractionDigits:2,maximumFractionDigits:2}).format(e.cost_minor/100);
        for(const text of ['供貨單價 '+amount,'庫存 '+e.stock,e.description])ctx.check('supplier_bookmark_values_match',await card.getByText(text,{exact:true}).count()===1);
      }
      ctx.metric('bookmark',on?'console_page':'old_page');ctx.metric('bookmark_values_matched',true);
    });
  }
  return {preflight,cleanup,phases:{'supplier-journey':journey,'supplier-photo':photo,'supplier-reservations':reservations,'supplier-recheck':recheck}};
}
