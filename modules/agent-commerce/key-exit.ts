import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {isAbsolute} from 'node:path';
import {SHOP_KEY_PROFILE,type ShopKeyPolicy} from '../../packages/resource-scopes/shop-service.js';

export interface ShopExitBinding {
 readonly environment:'staging'|'public';readonly origin:string;readonly sourceSha:string;
 readonly database:string;readonly schema:string;readonly role:string;
 readonly host:string;readonly port:number;readonly connectionUser:string;
}
export interface ShopExitTarget {readonly binding:ShopExitBinding;close():Promise<void>}
interface InstalledWriter {readonly sourceSha:string;readonly policy:ShopKeyPolicy;readonly profile:typeof SHOP_KEY_PROFILE;readonly observedAt:number}
export interface ShopWriterObserver {observe(environment:'staging'|'public'):Promise<InstalledWriter>}
const witnessed=new WeakMap<InstalledWriter,{observer:ShopWriterObserver;binding:string}>();
const connections=new WeakMap<ShopExitTarget,{pool:Pool;endpoint:string}>();
const id=/^[A-Za-z_][A-Za-z0-9_]{0,62}$/,sha=/^[0-9a-f]{40}$/,hash=/^[0-9a-f]{64}$/;
const fail=():never=>{throw new Error('shop_exit_unavailable');};
const digest=(s:string)=>createHash('sha256').update(s).digest('hex');
function snapshot(raw:ShopExitBinding):Readonly<ShopExitBinding>{
 if(!raw||Object.keys(raw).sort().join(',')!=='connectionUser,database,environment,host,origin,port,role,schema,sourceSha'
  ||!['public','staging'].includes(raw.environment)||!sha.test(raw.sourceSha)
  ||![raw.database,raw.schema,raw.role].every(x=>typeof x==='string'&&id.test(x))
  ||!Number.isInteger(raw.port)||raw.port<1||raw.port>65535
  ||typeof raw.host!=='string'||!(/^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/.test(raw.host)||raw.host==='[::1]')
  ||raw.host.includes('..')||typeof raw.connectionUser!=='string'
  ||!(raw.connectionUser===raw.role||raw.connectionUser.startsWith(raw.role+'.')&&/^[A-Za-z0-9_-]{1,128}$/.test(raw.connectionUser.slice(raw.role.length+1))))fail();
 let url:URL;try{url=new URL(raw.origin);}catch{fail();}
 if(url!.origin!==raw.origin||url!.protocol!=='https:'||url!.username||url!.password)fail();
 if(new URL('https://'+raw.host).hostname!==raw.host)fail();
 return Object.freeze({...raw});
}
const bindingDigest=(b:ShopExitBinding)=>digest(JSON.stringify([b.environment,b.origin,b.sourceSha,b.host,b.port,b.connectionUser,b.database,b.schema,b.role]));
/** Exact private connection expectation. Routing username (role.branch) is
 * distinct from SQL current/session role. No caller-supplied pool or target
 * assertion can replace this URL check plus the SQL observation below. */
export function connectShopExitTarget(raw:ShopExitBinding,configured:string):ShopExitTarget{
 const binding=snapshot(raw),url=new URL(configured),local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 const keys=[...url.searchParams.keys()];
 if(!['postgres:','postgresql:'].includes(url.protocol)||url.hostname!==binding.host||Number(url.port||5432)!==binding.port
  ||decodeURIComponent(url.username)!==binding.connectionUser||decodeURIComponent(url.pathname.slice(1))!==binding.database
  ||url.hash||keys.some(k=>!['sslmode','host'].includes(k))||keys.some(k=>url.searchParams.getAll(k).length!==1)
  ||(local?!/^fp_[a-z0-9_]+$/.test(binding.database):url.searchParams.get('sslmode')!=='verify-full'||url.searchParams.has('host'))
  ||(local&&url.searchParams.has('sslmode')&&!['disable','verify-full'].includes(url.searchParams.get('sslmode')!))
  ||(url.searchParams.has('host')&&(!local||!isAbsolute(url.searchParams.get('host')!))))fail();
 // Explicit parameters and a password callback prevent fallback to PGHOST,
 // PGPASSWORD, PGSSLMODE or .pgpass. Never retain the credential URL in output.
 const password=decodeURIComponent(url.password);
 const pool=new Pool({host:url.searchParams.get('host')??binding.host.replace(/^\[|\]$/g,''),port:binding.port,user:binding.connectionUser,database:binding.database,
  password:()=>password,ssl:url.searchParams.get('sslmode')==='verify-full'?{rejectUnauthorized:true}:false,
  sslnegotiation:'postgres',application_name:'freedom-shop-key-exit',client_encoding:'UTF8',
  options:`-c search_path=${binding.schema} -c default_transaction_read_only=on`,max:1,connectionTimeoutMillis:5000,query_timeout:6000});
 const target:ShopExitTarget=Object.freeze({binding,async close(){connections.delete(target);await pool.end();}});
 // A plain SQL role is not a distinct database target. A branch routing suffix
 // is part of the explicitly selected endpoint; no inference from SQL role.
 const route=binding.connectionUser===binding.role?null:binding.connectionUser.slice(binding.role.length+1);
 connections.set(target,{pool,endpoint:JSON.stringify([binding.host,binding.port,route,url.searchParams.get('host'),binding.database,binding.schema])});return target;
}
/** Explicit operator-selected target bindings and approved source SHA, not a
 * candidate-supplied observation. HTTPS health must itself report installed
 * policy/profile and exact release. Access redirects/unavailable fields fail.
 * This observes the configured endpoints; it does not discover every deployment. */
export function createShopWriterObserver(raw:readonly ShopExitBinding[],fetcher:typeof fetch=globalThis.fetch):ShopWriterObserver{
 const bindings=raw.map(snapshot);
 if(bindings.length!==2||new Set(bindings.map(x=>x.environment)).size!==2||new Set(bindings.map(x=>x.origin)).size!==2)fail();
 const observer:ShopWriterObserver=Object.freeze({async observe(environment:'staging'|'public'):Promise<InstalledWriter>{
  const binding=bindings.find(x=>x.environment===environment);if(!binding)fail();
  const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const deadline=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('shop_exit_unavailable'));},5000);});
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{
   const response=await Promise.race([fetcher(binding!.origin+'/api/v1/health',{method:'GET',redirect:'error',credentials:'omit',cache:'no-store',headers:{Accept:'application/json'},signal:controller.signal}),deadline]);
   if(response.status!==200||response.redirected||!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')||!response.body)fail();
   reader=response.body!.getReader();let size=0,chunks=0;const parts:Uint8Array[]=[];
   for(;;){const next=await Promise.race([reader.read(),deadline]);if(next.done)break;if(++chunks>128||(size+=next.value.byteLength)>8192)fail();parts.push(next.value);}
   const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(parts)));
   if(value.status!=='ok'||value.mode!==environment||value.release_sha!==binding!.sourceSha
    ||value.shop_key_issuer_profile!==SHOP_KEY_PROFILE||!['legacy-compatible','purpose-bound-only'].includes(value.shop_key_policy))fail();
   const observation=Object.freeze({sourceSha:value.release_sha,policy:value.shop_key_policy,profile:SHOP_KEY_PROFILE,observedAt:Date.now()});
   witnessed.set(observation,{observer,binding:bindingDigest(binding!)});return observation;
  }catch{return fail();}finally{clearTimeout(timer!);if(reader){void reader.cancel().catch(()=>{});try{reader.releaseLock();}catch{}}}
 }});
 return observer;
}
function installed(observer:ShopWriterObserver,binding:ShopExitBinding,value:InstalledWriter){
 const proof=witnessed.get(value);
 if(!proof||proof.observer!==observer||proof.binding!==bindingDigest(binding)||value.sourceSha!==binding.sourceSha
  ||value.profile!==SHOP_KEY_PROFILE||!['legacy-compatible','purpose-bound-only'].includes(value.policy)
  ||!Number.isSafeInteger(value.observedAt)||value.observedAt>Date.now()||Date.now()-value.observedAt>30000)fail();
}
interface KeyRow {token_hash:string;credential_profile:string;purpose:string|null;issuer:string|null;audience:string|null;environment:string|null}
async function observeKeys(target:{pool:Pool},binding:ShopExitBinding){
 const q=await target.pool.connect();
 try{
  await q.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await q.query("SET LOCAL statement_timeout='5s'");await q.query("SET LOCAL lock_timeout='2s'");
  const identity=(await q.query(`SELECT current_database() database,current_schema() schema,current_user role,session_user session_role,
   rolsuper,rolbypassrls,current_setting('transaction_read_only') readonly FROM pg_roles WHERE rolname=current_user`)).rows[0];
  if(!identity||identity.database!==binding.database||identity.schema!==binding.schema||identity.role!==binding.role||identity.session_role!==binding.role
   ||identity.rolsuper!==false||identity.rolbypassrls!==false||identity.readonly!=='on')fail();
  // No views, foreign tables or RLS-filtered inventory can establish full coverage.
  const table=(await q.query(`SELECT c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname=$1 AND c.relname='commerce_shop_keys'`,[binding.schema])).rows[0];
  if(!table||table.relkind!=='r'||table.relrowsecurity||table.relforcerowsecurity)fail();
  const rows=(await q.query<KeyRow>(`SELECT token_hash,credential_profile,purpose,issuer,audience,environment
   FROM "${binding.schema}".commerce_shop_keys WHERE revoked_at IS NULL AND expires_at>clock_timestamp() ORDER BY shop_id LIMIT 10001`)).rows;
  if(rows.length>10000||rows.some(row=>!hash.test(row.token_hash)))fail();
  await q.query('COMMIT');return rows;
 }catch{await q.query('ROLLBACK').catch(()=>{});fail();}finally{q.release();}
}
/** Read-only, bounded two-target observation; no token stamping, rotation,
 * deletes or policy writes. Secrets and per-key hashes stay local to this call. */
export async function planShopKeyLegacyExit(raw:readonly ShopExitTarget[],observer?:ShopWriterObserver){
 const blocked=(code:string)=>({format:'freedom.shop-key-exit/v1',status:'unavailable',legacy_exit:false,mutations:0,deployment_authority:false,issues:[code]});
 try{
  const targets=raw.map(t=>{const actual=connections.get(t);if(!actual)fail();return {...actual!,binding:snapshot(t.binding)};});
  if(targets.length!==2||new Set(targets.map(t=>t.binding.environment)).size!==2
   ||new Set(targets.map(t=>t.endpoint)).size!==2||!observer)fail();
  const records=[];const active=new Set<string>();let duplicates=0;
  for(const target of targets){
   const before=await observer!.observe(target.binding.environment);installed(observer!,target.binding,before);
   const rows=await observeKeys(target,target.binding);
   const after=await observer!.observe(target.binding.environment);installed(observer!,target.binding,after);
   if(before.sourceSha!==after.sourceSha||before.policy!==after.policy||before.profile!==after.profile)fail();
   let legacy=0,invalid=0;
   for(const row of rows!){
    if(active.has(row.token_hash))duplicates++;active.add(row.token_hash);
    if(row.credential_profile==='legacy-shop-key/v1')legacy++;
    else if(row.credential_profile!==SHOP_KEY_PROFILE||row.purpose!=='shop-api'||row.issuer!==target.binding.origin
     ||row.audience!==target.binding.origin+'/shop-api/v1'||row.environment!==target.binding.environment)invalid++;
   }
   records.push({environment:target.binding.environment,target_identity_sha256:bindingDigest(target.binding),source_sha:after.sourceSha,
    installed_policy:after.policy,installed_issuer_profile:after.profile,observed_at:new Date(after.observedAt).toISOString(),
    active_keys:rows!.length,active_legacy_keys:legacy,invalid_bound_keys:invalid});
  }
  const issues=[];if(records.some(r=>r.active_legacy_keys))issues.push('active_legacy_keys');if(records.some(r=>r.invalid_bound_keys))issues.push('invalid_bound_keys');if(duplicates)issues.push('cross_environment_key_reuse');
  const report={format:'freedom.shop-key-exit/v1',status:issues.length?'blocked':'eligible_for_review',legacy_exit:false,mutations:0,deployment_authority:false,
   scope:'operator_selected_two_target_endpoints',sources:records,cross_environment_duplicate_count:duplicates,issues,
   remaining:['Verify complete active/retained issuer inventory and rollback floor with the deployment operator.','Explicitly approve and observe purpose-bound-only rollout; this observation performs no policy change.']};
  return {...report,report_sha256:digest(JSON.stringify(report))};
 }catch{return blocked('target_or_installed_writer_unavailable');}
}
