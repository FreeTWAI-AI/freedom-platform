import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {createPlatformApp} from '../../apps/platform-api/src/platform-app.js';
import {nodeRuntime} from '../../apps/platform-api/src/app.js';
import {createShopWriterObserver,connectShopExitTarget,planShopKeyLegacyExit,type ShopExitBinding,type ShopWriterObserver,type ShopExitTarget} from '../../modules/agent-commerce/key-exit.js';
import {runShopKeyExit} from '../../scripts/shop-key-legacy-exit.js';
import {tokenHash} from '../../modules/identity-membership/service.js';

const configured=process.env.TEST_DATABASE_URL;assert(configured,'Explicit isolated TEST_DATABASE_URL required');
const url=new URL(configured);assert.match(url.pathname,/^\/fp_[a-z0-9_]+$/);assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname));
const admin=new Pool({connectionString:url.href});
const state=await Promise.all((['public','staging'] as const).map(async(environment,n)=>{
 const schema='fp_key_exit_'+randomUUID().replaceAll('-',''),role='fp_key_reader_'+randomUUID().replaceAll('-','');
 const binding:ShopExitBinding={environment,origin:`https://shop-${environment}.example.invalid`,sourceSha:(n?'b':'a').repeat(40),host:url.hostname,port:Number(url.port||5432),connectionUser:role,database:decodeURIComponent(url.pathname.slice(1)),schema,role};
 const owner=new Pool({connectionString:url.href,options:`-c search_path=${schema}`});
 const readUrl=new URL(url);readUrl.username=role;readUrl.password='';
 const reader=new Pool({connectionString:readUrl.href,options:`-c search_path=${schema} -c default_transaction_read_only=on`}),target=connectShopExitTarget(binding,readUrl.href);
 let healthMode:'actual'|'old-profile'|'wrong-source'|'access'|'oversize'='actual';
 const runtime=nodeRuntime(environment,binding.origin,{shopKeyPolicy:'legacy-compatible'});runtime.health={release_sha:binding.sourceSha};
 const app=createPlatformApp(owner,binding.origin,environment,runtime);
 const server=createServer(async(req,res)=>{
  if(healthMode==='access'){res.writeHead(302,{Location:'https://access.example.invalid'});res.end();return;}
  if(healthMode==='oversize'){res.writeHead(200,{'Content-Type':'application/json'});res.end('x'.repeat(8193));return;}
  const response=await app.request(binding.origin+req.url,{method:'GET'}),body=await response.json() as any;
  if(healthMode==='old-profile')delete body.shop_key_issuer_profile;
  if(healthMode==='wrong-source')body.release_sha='c'.repeat(40);
  res.writeHead(response.status,{'Content-Type':'application/json'});res.end(JSON.stringify(body));
 });
 return {binding,owner,reader,target,readUrl,server,setMode:(mode:typeof healthMode)=>{healthMode=mode;},created:false,roleCreated:false};
}));
before(async()=>{
 for(const s of state){await admin.query(`CREATE SCHEMA ${s.binding.schema}`);s.created=true;await migrate(s.owner);
  await admin.query(`CREATE ROLE ${s.binding.role} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);s.roleCreated=true;
  await admin.query(`GRANT USAGE ON SCHEMA ${s.binding.schema} TO ${s.binding.role}`);
  await admin.query(`GRANT SELECT ON ${s.binding.schema}.commerce_shop_keys TO ${s.binding.role}`);
  await new Promise<void>(resolve=>s.server.listen(0,'127.0.0.1',resolve));
 }
});
after(async()=>{for(const s of state){await new Promise<void>(resolve=>s.server.close(()=>resolve()));await s.target.close();await s.reader.end();await s.owner.end();
 if(s.created)await admin.query(`DROP SCHEMA ${s.binding.schema} CASCADE`);if(s.roleCreated)await admin.query(`DROP ROLE ${s.binding.role}`);}await admin.end();});
beforeEach(async()=>{for(const s of state){s.setMode('actual');await s.owner.query('TRUNCATE communities CASCADE');}});
const targets=()=>state.map(s=>s.target);
const fetcher:typeof fetch=async(input,init)=>{
 const incoming=new URL(String(input)),s=state.find(x=>x.binding.origin===incoming.origin);assert(s);assert.equal(incoming.pathname,'/api/v1/health');
 assert.equal(init?.method,'GET');assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
 return fetch('http://127.0.0.1:'+(s.server.address() as AddressInfo).port+incoming.pathname,init);
};
const observer=()=>createShopWriterObserver(state.map(s=>s.binding),fetcher);
async function key(which:number,profile:'legacy'|'bound',hash=tokenHash(randomBytes(32).toString('base64url'))){
 const {owner,binding}=state[which],community=randomUUID(),user=randomUUID(),shop=randomUUID();
 await owner.query("INSERT INTO communities VALUES($1,'Synthetic')",[community]);
 await owner.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic','not-a-login-hash',$4)",[user,community,user+'@example.invalid',randomUUID()]);
 await owner.query("INSERT INTO commerce_shops(shop_id,community_id,owner_id,kind,name,description,website_url,contact,currency,manifest_sha256) VALUES($1,$2,$3,'public','Synthetic','Synthetic','https://shop.example.invalid','Synthetic','TWD',$4)",[shop,community,user,shop]);
 if(profile==='legacy')await owner.query("INSERT INTO commerce_shop_keys(shop_id,token_hash,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",[shop,hash]);
 else await owner.query(`INSERT INTO commerce_shop_keys(shop_id,token_hash,expires_at,credential_profile,purpose,issuer,audience,environment)
  VALUES($1,$2,clock_timestamp()+interval '1 hour','freedom.shop-service-key/v1','shop-api',$3,$4,$5)`,[shop,hash,binding.origin,binding.origin+'/shop-api/v1',binding.environment]);
 return {shop,hash};
}

test('default CLI plan reads neither target nor credential; two actual read-only identities plus HTTP floor can produce only review eligibility',async()=>{
 const plan=await runShopKeyExit([]);assert.equal(plan.status,'plan_only');assert.equal((plan as any).database_reads,0);
 await key(0,'bound');await key(1,'bound');
 const result=await planShopKeyLegacyExit(targets(),observer());assert.equal(result.status,'eligible_for_review');assert.equal(result.legacy_exit,false);assert.equal(result.deployment_authority,false);
 assert.equal((result as any).sources.length,2);assert.deepEqual((result as any).sources.map((x:any)=>x.active_keys),[1,1]);
 for(const s of state){assert(!JSON.stringify(result).includes(s.binding.role));assert(!JSON.stringify(result).includes(s.binding.schema));}
});

test('active unbound key blocks exit; expiry/revoke reduce active count without planner mutation',async()=>{
 const a=await key(0,'legacy'),b=await key(1,'legacy');let result=await planShopKeyLegacyExit(targets(),observer());
 assert.equal(result.status,'blocked');assert.deepEqual(result.issues,['active_legacy_keys']);
 await state[0].owner.query('UPDATE commerce_shop_keys SET revoked_at=clock_timestamp() WHERE shop_id=$1',[a.shop]);
 await state[1].owner.query("UPDATE commerce_shop_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE shop_id=$1",[b.shop]);
 result=await planShopKeyLegacyExit(targets(),observer());assert.equal(result.status,'eligible_for_review');
 assert.equal((await state[0].owner.query('SELECT count(*)::int n FROM commerce_shop_keys')).rows[0].n,1);
});

test('cross-environment hash reuse is counted without disclosure, and cloned wrong binding blocks',async()=>{
 const a=await key(0,'bound');await key(1,'bound',a.hash);
 const result=await planShopKeyLegacyExit(targets(),observer());assert.equal(result.status,'blocked');assert.equal((result as any).cross_environment_duplicate_count,1);assert(!JSON.stringify(result).includes(a.hash));
 await state[1].owner.query('UPDATE commerce_shop_keys SET issuer=$1,audience=$2,environment=$3',[state[0].binding.origin,state[0].binding.origin+'/shop-api/v1','public']);
 assert((await planShopKeyLegacyExit(targets(),observer())).issues.includes('invalid_bound_keys'));
});

for(const mode of ['old-profile','wrong-source','access','oversize'] as const)test('actual HTTP '+mode+' is unavailable, not assumed from requested source',async()=>{
 state[1].setMode(mode);assert.equal((await planShopKeyLegacyExit(targets(),observer())).status,'unavailable');
});

test('missing/fabricated installed observations, incomplete targets, wrong SQL identity and privileged role cannot approve exit',async()=>{
 assert.equal((await planShopKeyLegacyExit(targets())).status,'unavailable');
 const fake={observe:async()=>({sourceSha:state[0].binding.sourceSha,policy:'legacy-compatible',profile:'freedom.shop-service-key/v1',observedAt:Date.now()})} as ShopWriterObserver;
 assert.equal((await planShopKeyLegacyExit(targets(),fake)).status,'unavailable');
 assert.equal((await planShopKeyLegacyExit(targets().slice(0,1),observer())).status,'unavailable');
 const wrongBinding={...state[0].binding,database:'fp_wrong'},wrongUrl=new URL(state[0].readUrl);wrongUrl.pathname='/fp_wrong';
 const wrong=connectShopExitTarget(wrongBinding,wrongUrl.href);
 try{const t=[wrong,state[1].target];assert.equal((await planShopKeyLegacyExit(t,createShopWriterObserver(t.map(x=>x.binding),fetcher))).status,'unavailable');}finally{await wrong.close();}
 const adminBinding={...state[0].binding,role:decodeURIComponent(url.username),connectionUser:decodeURIComponent(url.username)},privileged=connectShopExitTarget(adminBinding,url.href);
 try{const t=[privileged,state[1].target];assert.equal((await planShopKeyLegacyExit(t,createShopWriterObserver(t.map(x=>x.binding),fetcher))).status,'unavailable');}finally{await privileged.close();}
 const forged={binding:state[0].binding,close:async()=>{}} as ShopExitTarget;
 assert.equal((await planShopKeyLegacyExit([forged,state[1].target],observer())).status,'unavailable');
});

test('database-level readonly adapter cannot mutate and an RLS-filtered table is unavailable',async()=>{
 await assert.rejects(()=>state[0].reader.query('DELETE FROM commerce_shop_keys'),(error:unknown)=>['25006','42501'].includes((error as {code:string}).code));
 await state[0].owner.query('ALTER TABLE commerce_shop_keys ENABLE ROW LEVEL SECURITY');
 try{assert.equal((await planShopKeyLegacyExit(targets(),observer())).status,'unavailable');}
 finally{await state[0].owner.query('ALTER TABLE commerce_shop_keys DISABLE ROW LEVEL SECURITY');}
});

test('exact endpoint includes host/port/routing username while SQL role stays independent; malformed TLS/URL overrides reject before connect',async()=>{
 const base={...state[0].binding,host:'db-one.example.invalid',port:5432,role:'fp_reader',connectionUser:'fp_reader.branch_one'},raw='postgresql://fp_reader.branch_one:synthetic@db-one.example.invalid:5432/'+state[0].binding.database+'?sslmode=verify-full';
 // Pool creation is lazy: these checks perform no remote connection. Actual
 // routing and provider branch identity still require controlled operator proof.
 const accepted=connectShopExitTarget(base,raw);await accepted.close();
 const second=connectShopExitTarget({...base,host:'db-two.example.invalid',connectionUser:'fp_reader.branch_two'},raw.replace('db-one','db-two').replace('branch_one','branch_two'));await second.close();
 const encoded=connectShopExitTarget(base,raw.replace('fp_reader.branch_one','fp_reader%2Ebranch_one'));await encoded.close();
 for(const value of [raw.replace('db-one','db-other'),raw.replace(':5432/',':5433/'),raw.replace('branch_one','branch_wrong'),
  raw.replace('verify-full','no-verify'),raw.replace('?sslmode=verify-full',''),raw+'&sslmode=disable',raw+'&ssl=false',raw+'&options=x',raw+'&host=another.example.invalid',raw+'#fragment'])
  assert.throws(()=>connectShopExitTarget(base,value),/shop_exit_unavailable/);
 assert.throws(()=>connectShopExitTarget({...base,host:'DB-ONE.example.invalid'},raw),/shop_exit_unavailable/);
 assert.throws(()=>connectShopExitTarget({...base,host:'db-one.example.invalid.'},raw),/shop_exit_unavailable/);
 const sameEndpoint=connectShopExitTarget({...state[1].binding,schema:state[0].binding.schema},state[1].readUrl.href);
 try{const t=[state[0].target,sameEndpoint];assert.equal((await planShopKeyLegacyExit(t,createShopWriterObserver(t.map(x=>x.binding),fetcher))).status,'unavailable');}
 finally{await sameEndpoint.close();}
});

test('actual SQL session cannot masquerade as the base role merely because its connection username has a routing suffix',async()=>{
 const base='fp_route_'+randomUUID().replaceAll('-',''),route=base+'.branch_one',s=state[0];
 await admin.query(`CREATE ROLE "${route}" LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
 let target:ShopExitTarget|undefined;
 try{
  await admin.query(`GRANT USAGE ON SCHEMA ${s.binding.schema} TO "${route}"`);
  await admin.query(`GRANT SELECT ON ${s.binding.schema}.commerce_shop_keys TO "${route}"`);
  const configured=new URL(s.readUrl);configured.username=route;
  target=connectShopExitTarget({...s.binding,role:base,connectionUser:route},configured.href);
  const selected=[target,state[1].target];assert.equal((await planShopKeyLegacyExit(selected,createShopWriterObserver(selected.map(x=>x.binding),fetcher))).status,'unavailable');
 }finally{await target?.close();await admin.query(`DROP OWNED BY "${route}"`);await admin.query(`DROP ROLE "${route}"`);}
});

test('explicit connection does not inherit ambient PG target, TLS or SQL option settings',async()=>{
 const values={PGHOST:'not-a-target.example.invalid',PGPORT:'9',PGUSER:'not_the_role',PGDATABASE:'not_the_database',
  PGSSLMODE:'no-verify',PGOPTIONS:'-c default_transaction_read_only=off',PGPASSWORD:'not-an-approved-secret',PGPASSFILE:'/nonexistent/synthetic-pgpass'};
 const prior=new Map(Object.keys(values).map(name=>[name,process.env[name]])),selected:ShopExitTarget[]=[];
 try{Object.assign(process.env,values);for(const s of state)selected.push(connectShopExitTarget(s.binding,s.readUrl.href));
  assert.equal((await planShopKeyLegacyExit(selected,observer())).status,'eligible_for_review');
 }finally{await Promise.all(selected.map(x=>x.close()));for(const [name,value] of prior){if(value===undefined)delete process.env[name];else process.env[name]=value;}}
});
