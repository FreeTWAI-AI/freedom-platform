import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createLocalJWKSet,exportJWK,generateKeyPair,SignJWT} from 'jose';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {createAdminAccessVerifier} from '../../modules/platform-admin/access.js';
const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_admin_candidates_${process.pid}_${Date.now()}`,database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const issuer='https://candidate-test.cloudflareaccess.com',audience='guild-candidate-tests',email='candidate-admin@example.invalid',adminId=randomUUID(),pair=await generateKeyPair('RS256');
const jwk=await exportJWK(pair.publicKey),verifier=createAdminAccessVerifier({issuer,audience,csrfSecret:'candidate-test-csrf-secret-123456789',keySet:createLocalJWKSet({keys:[{...jwk,kid:'candidate-test',alg:'RS256'}]})});
const app=createApp(pool,origin,'local',{adminVerifier:verifier}),guild='guild_event_space';let jwt='',csrf='';
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);await pool.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,email,'候選查詢管理員']);jwt=await sign(email);csrf=(await verifier(new Request(origin,{headers:{'Cf-Access-Jwt-Assertion':jwt}}))).csrfToken;});
async function sign(value:string){const now=Math.floor(Date.now()/1000);return new SignJWT({type:'app',email:value,sub:'verified-candidate-admin',iss:issuer,aud:audience,iat:now,nbf:now,exp:now+600}).setProtectedHeader({alg:'RS256',kid:'candidate-test'}).sign(pair.privateKey);}
async function request(path:string,body?:unknown,options:{version?:number;headers?:Record<string,string>}={}){const headers:Record<string,string>={Origin:origin,'Cf-Access-Jwt-Assertion':jwt,'X-Admin-CSRF':csrf,...options.headers};if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();if(options.version!==undefined)headers['If-Match']=`"${options.version}"`;}
 const response=await app.request(origin+'/admin/api'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any};}
async function candidates(query:Record<string,string|number>={},key=guild){return request('/guilds/'+key+'/master-candidates?'+new URLSearchParams(Object.entries(query).map(([k,v])=>[k,String(v)])));}
async function user(name:string,options:{email?:string;community?:string;active?:boolean}={}){const id=randomUUID();await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active) SELECT $1,$2,$3,$4,password_hash,$5,$6 FROM users WHERE user_id=$7`,[id,options.community??DEMO_COMMUNITY,options.email??id+'@example.invalid',name,randomUUID(),options.active??true,DEMO_USERS[0].user_id]);return id;}
async function join(id:string,state='active',community=DEMO_COMMUNITY,key=guild){await pool.query('INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,$4,$5)',[randomUUID(),community,id,key,state]);}

test('eligible candidates include active nonmembers before pagination and search can reach someone beyond the first 25 rows',async()=>{
 for(let i=0;i<35;i++)await user('A'+String(i).padStart(2,'0')+' 尚未入會');const target=await user('Zulu 真正公會會員');await join(target);await user('A00 已停用',{active:false});
 const oldPage=await request('/members?limit=25');assert.equal(oldPage.status,200);assert.ok(!oldPage.data.items.some((m:any)=>m.user_id===target));
 const result=await candidates();assert.equal(result.status,200);assert.equal(result.data.total,39);assert.equal(result.data.next_offset,20);assert.equal(result.data.items.length,20);assert.ok(result.data.items.every((m:any)=>m.active&&m.eligible&&!m.joined&&m.eligibility_reason===null));
 const all=await candidates({scope:'all',limit:20});assert.equal(all.data.items.length,20);assert.equal(all.data.total,40);assert.equal(all.data.next_offset,20);assert.ok(all.data.items.some((m:any)=>!m.active&&!m.eligible&&m.eligibility_reason==='inactive'));
 const search=await candidates({q:'Zulu'});assert.deepEqual(search.data.items.map((m:any)=>m.user_id),[target]);assert.equal(search.data.items[0].joined,true);assert.equal(search.data.items[0].eligible,true);assert.equal(search.data.items[0].is_expert,false);assert.equal(search.data.items[0].expert_version,null);
});

test('candidate eligibility is independent of joining and leaving removes the current officer marker',async()=>{
 const current=await user('候選甲'),inactive=await user('候選乙',{active:false}),left=await user('候選丙'),absent=await user('候選丁');await join(current);await join(inactive);await join(left,'left');
 await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[DEMO_COMMUNITY,guild,current]);
 const all=await candidates({q:'候選',scope:'all'});assert.equal(all.status,200);const rows=new Map<string,any>(all.data.items.map((m:any)=>[m.user_id,m]));assert.equal(rows.get(current).is_current,true);assert.equal(rows.get(current).eligible,true);assert.equal(rows.get(current).joined,true);assert.equal(rows.get(inactive).eligibility_reason,'inactive');
 for(const id of [left,absent]){assert.equal(rows.get(id).joined,false);assert.equal(rows.get(id).eligible,true);assert.equal(rows.get(id).eligibility_reason,null);}assert.ok([...rows.values()].filter(m=>m.user_id!==current).every(m=>m.is_current===false));
 assert.deepEqual((await candidates({q:'候選'})).data.items.map((m:any)=>m.user_id).sort(),[current,left,absent].sort());
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2",[current,guild]);const changed=(await candidates({q:'候選甲',scope:'all'})).data.items[0];assert.equal(changed.is_current,false);assert.equal(changed.joined,false);assert.equal(changed.eligible,true);assert.equal(changed.eligibility_reason,null);assert.equal((await candidates({q:'候選'})).data.total,3);
});

test('matching remains community scoped even if the foreign account has matching membership or appointment',async()=>{
 const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other community']);const outsider=await user('僅外部名稱',{community,email:'hidden-candidate@example.invalid'});await join(outsider,'active',community);await pool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)',[community,guild,outsider]);
 for(const scope of ['eligible','all']){assert.equal((await candidates({scope,q:'僅外部名稱'})).data.total,0);const result=await candidates({scope,q:'hidden-candidate@example.invalid'});assert.deepEqual(result.data.items,[]);assert.equal(result.data.next_offset,null);}
});

test('search matches literal nickname or email case insensitively and preserves stable pagination for duplicate names',async()=>{
 const ids:string[]=[];for(let i=0;i<5;i++){const id=await user('同名候選',{email:`Person${i}@example.invalid`});await join(id);ids.push(id);}ids.sort();const exact=await user('特殊 %_ 候選',{email:'Percent_Tag@example.invalid'});await join(exact);
 const first=await candidates({q:'同名',limit:2});assert.equal(first.data.total,5);assert.deepEqual(first.data.items.map((m:any)=>m.user_id),ids.slice(0,2));assert.equal(first.data.next_offset,2);
 const next=await candidates({q:'同名',limit:2,offset:2});assert.deepEqual(next.data.items.map((m:any)=>m.user_id),ids.slice(2,4));assert.equal(next.data.next_offset,4);const last=await candidates({q:'同名',limit:2,offset:4});assert.deepEqual(last.data.items.map((m:any)=>m.user_id),ids.slice(4));assert.equal(last.data.next_offset,null);
 const beyond=await candidates({q:'同名',offset:20});assert.deepEqual(beyond.data.items,[]);assert.equal(beyond.data.total,5);assert.equal(beyond.data.next_offset,null);
 assert.equal((await candidates({q:'pErSoN3@EXAMPLE.INVALID'})).data.total,1);assert.deepEqual((await candidates({q:'%_'})).data.items.map((m:any)=>m.user_id),[exact]);assert.equal((await candidates({q:"' OR true--"})).data.total,0);
 // The general admin member picker now uses the same literal semantics.
 assert.deepEqual((await request('/members?q='+encodeURIComponent('%_'))).data.items.map((m:any)=>m.user_id),[exact]);
});

test('the route requires verified active administration, validates query bounds and reports unknown guilds',async()=>{
 assert.equal((await request('/guilds/'+guild+'/master-candidates',undefined,{headers:{'Cf-Access-Jwt-Assertion':'','Cf-Access-Authenticated-User-Email':email}})).status,401);
 assert.equal((await request('/guilds/'+guild+'/master-candidates',undefined,{headers:{'Cf-Access-Jwt-Assertion':await sign('not-admin@example.invalid')}})).status,403);
 for(const query of [{scope:'friends'},{limit:0},{limit:101},{offset:-1},{offset:100001},{q:'a'.repeat(101)},{q:'bad\u0000value'},{unexpected:'field'}] as Record<string,string|number>[])assert.equal((await candidates(query)).status,422);
 assert.equal((await candidates({},'guild_missing_catalog_entry')).status,404);assert.equal((await candidates({},'x'.repeat(101))).status,422);
 await pool.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[adminId]);assert.equal((await candidates()).status,403);
});

test('candidate discovery never joins anyone, but an explicit versioned appointment atomically joins an active nonmember',async()=>{
 const first=await user('第一位尚未入會會員'),second=await user('第二位尚未入會會員'),inactive=await user('已停用人選',{active:false});await candidates({scope:'all'});
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM positioning_guild_officers')).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM positioning_profession_memberships WHERE user_id=ANY($1::uuid[])',[[first,second]])).rows[0].n,0);
 const path='/guilds/'+guild+'/master',body={user_id:first,reason:'管理員確認由此人帶領公會'};
 assert.equal((await request(path,body,{headers:{'X-Admin-CSRF':''}})).status,403);assert.equal((await request(path,{...body,user_id:inactive})).status,422);
 const appointed=await request(path,body);assert.equal(appointed.status,200,JSON.stringify(appointed.data));assert.equal((await candidates({q:'第一位'})).data.items[0].is_current,true);assert.equal((await candidates({q:'第一位'})).data.items[0].joined,true);
 assert.equal((await pool.query("SELECT state FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2",[first,guild])).rows[0].state,'active');assert.deepEqual((await pool.query('SELECT book_id FROM member_skill_book_grants WHERE user_id=$1 AND guild_key=$2',[first,guild])).rows.map(row=>row.book_id),['event-space']);
 assert.equal((await request(path,{...body,user_id:second},{version:appointed.data.aggregate_version+1})).status,412);
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM positioning_profession_memberships WHERE user_id=$1',[second])).rows[0].n,0);assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_skill_book_grants WHERE user_id=$1',[second])).rows[0].n,0);
 const next=await request(path,{...body,user_id:second},{version:appointed.data.aggregate_version});assert.equal(next.status,200,JSON.stringify(next.data));assert.equal((await candidates({q:'第二位'})).data.items[0].joined,true);assert.equal((await pool.query("SELECT count(*)::int AS n FROM platform_admin_audit WHERE action='appoint_guild_master'")).rows[0].n,2);
});
