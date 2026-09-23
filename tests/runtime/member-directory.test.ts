import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {emptyContacts} from '../../modules/identity-membership/members.js';

const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,admin=createPool(databaseUrl),schema=`fp_member_directory_${process.pid}_${Date.now()}`;
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12}),origin='http://127.0.0.1:4310',app=createApp(pool,origin);
let headers:Record<string,string>={};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[0].email,password:DEMO_PASSWORD})});const data=await response.json() as any;headers={Origin:origin,Cookie:response.headers.get('set-cookie')!.split(';')[0],'X-CSRF-Token':data.csrf_token};});
async function get(query:string){const response=await app.request(origin+'/api/v1/'+query,{headers});return {status:response.status,data:await response.json() as any};}
async function directory(filters:Record<string,string|number>={}){return get('members?'+new URLSearchParams(Object.entries(filters).map(([k,v])=>[k,String(v)])));}
async function user(name:string,date:string='2026-09-20T12:00:00.000Z',options:{community?:string;active?:boolean;onboarding?:boolean}={}){const id=randomUUID();await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,created_at,active,onboarding_required)
 SELECT $1,$2,$3,$4,password_hash,$5,$6,$7,$8 FROM users WHERE user_id=$9`,[id,options.community??DEMO_COMMUNITY,id+'@example.invalid',name,randomUUID(),date,options.active??true,options.onboarding??false,DEMO_USERS[0].user_id]);return id;}
async function guild(id:string,key='guild_security',primary=false,state='active',community=DEMO_COMMUNITY){await pool.query('INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,joined_at) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),community,id,key,state,'2026-09-21T13:14:15.000Z']);if(primary)await pool.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)',[community,id,key]);}
async function profile(id:string,published:object){await pool.query(`INSERT INTO onboarding_assessments(assessment_id,community_id,user_id,assessment_version,assessment_sha256,state,published_profile,occupation,answers,capabilities,custom_capabilities,question_notes)
 VALUES($1,$2,$3,'fixture',$4,'draft',$5,'私密職業詞','{"preferred_result":"私密答案詞"}',ARRAY['private_draft_skill'],ARRAY['未公開新技能'],'{"preferred_result":"私密備註詞"}')`,[randomUUID(),DEMO_COMMUNITY,id,'0'.repeat(64),JSON.stringify(published)]);}

test('directory searches confirmed nickname, positioning title and skill labels without searching contact values or private drafts',async()=>{
 const id=await user('公開名片甲');await guild(id,'guild_security',true);await profile(id,{capabilities:['security_review','python'],custom_capabilities:['台語訪談'],equipment:[],featured_capabilities:['python']});
 const contacts={...emptyContacts(),github:{value:'privateGithubNeedle',audiences:[]},discord:{value:'privateDiscordNeedle',audiences:['friends']},line:{value:'publicContactNeedle',audiences:['public']},email:{audiences:[]}};
 await pool.query('INSERT INTO member_accounts(user_id,community_id,contacts) VALUES($1,$2,$3)',[id,DEMO_COMMUNITY,JSON.stringify(contacts)]);
 for(const search of ['公開名片','資安實踐者','安全檢查','PYTHON','台語訪談']){const result=await directory({search});assert.equal(result.status,200);assert.deepEqual(result.data.items.map((m:any)=>m.user_id),[id],search);assert.equal(result.data.total,1);}
 for(const search of ['privateGithubNeedle','privateDiscordNeedle','publicContactNeedle',id+'@example.invalid','私密職業詞','私密答案詞','私密備註詞','private_draft_skill','未公開新技能']){const result=await directory({search});assert.equal(result.status,200);assert.equal(result.data.total,0,search);assert.deepEqual(result.data.items,[]);}
 const card=(await get('members/'+id)).data;assert.deepEqual(card.contacts,{line:'publicContactNeedle'});assert.equal(card.primary_guild.joined_at,'2026-09-21T13:14:15.000Z');
});

test('guild filter matches current primary or secondary memberships and never counts left or other-community memberships',async()=>{
 const primary=await user('公會候選甲'),secondary=await user('公會候選乙'),left=await user('公會候選丙');await guild(primary,'guild_security',true);await guild(secondary,'guild_event_space',true);await guild(secondary,'guild_security');await guild(left,'guild_security',false,'left');
 const foreign=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[foreign,'別的社群']);const outsider=await user('公會候選外',undefined,{community:foreign});await guild(outsider,'guild_security',true,'active',foreign);
 const result=await directory({search:'公會候選',guild_key:'guild_security'});assert.equal(result.status,200);assert.equal(result.data.total,2);assert.deepEqual(result.data.items.map((m:any)=>m.user_id).sort(),[primary,secondary].sort());
 const card=result.data.items.find((m:any)=>m.user_id===secondary);assert.equal(card.secondary_guilds[0].joined_at,'2026-09-21T13:14:15.000Z');
 assert.equal((await directory({guild_key:'guild_not_existing'})).data.total,0);
 await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key='guild_security'",[primary]);
 assert.deepEqual((await directory({guild_key:'guild_security'})).data.items.map((m:any)=>m.user_id),[secondary]);
 assert.equal((await directory({search:'資安實踐者'})).data.total,0);
});

test('combined search, guild and sorting run before pagination across the complete directory',async()=>{
 const expected:{id:string;date:string}[]=[];
 for(let i=0;i<46;i++){const match=i>=24&&i%3===0,date=new Date(Date.UTC(2026,8,1,0,i)).toISOString(),id=await user(match?'後段搜尋目標':'不符合的前段'+i,date);if(i%2===0)await guild(id);if(match&&i%2===0)expected.push({id,date});}
 expected.sort((a,b)=>b.date.localeCompare(a.date)||a.id.localeCompare(b.id));
 const first=await directory({search:'後段搜尋',guild_key:'guild_security',sort:'newest',limit:2});assert.equal(first.status,200);assert.equal(first.data.total,expected.length);assert.equal(first.data.next_offset,2);assert.deepEqual(first.data.items.map((m:any)=>m.user_id),expected.slice(0,2).map(v=>v.id));
 const next=await directory({search:'後段搜尋',guild_key:'guild_security',sort:'newest',limit:2,offset:first.data.next_offset});assert.deepEqual(next.data.items.map((m:any)=>m.user_id),expected.slice(2,4).map(v=>v.id));assert.equal(next.data.total,expected.length);assert.equal(next.data.next_offset,null);
 const beyond=await directory({search:'後段搜尋',guild_key:'guild_security',sort:'newest',limit:2,offset:99});assert.deepEqual(beyond.data.items,[]);assert.equal(beyond.data.total,expected.length);assert.equal(beyond.data.next_offset,null);
});

test('newest and oldest use recorded joining dates and break timestamp ties by member id',async()=>{
 const older=await user('排序丙','2026-09-01T00:00:00.000Z'),newerA=await user('排序甲','2026-09-02T00:00:00.000Z'),newerB=await user('排序乙','2026-09-02T00:00:00.000Z'),ties=[newerA,newerB].sort();
 assert.deepEqual((await directory({search:'排序',sort:'newest'})).data.items.map((m:any)=>m.user_id),[...ties,older]);
 assert.deepEqual((await directory({search:'排序',sort:'oldest'})).data.items.map((m:any)=>m.user_id),[older,...ties]);
 const page=await directory({search:'排序',sort:'newest',limit:1});const page2=await directory({search:'排序',sort:'newest',limit:1,offset:page.data.next_offset});assert.equal(page.data.items[0].user_id,ties[0]);assert.equal(page2.data.items[0].user_id,ties[1]);assert.equal((await get('members/'+older)).data.joined_at,'2026-09-01T00:00:00.000Z');
});

test('nickname ordering is stable with duplicate names and query characters are literal',async()=>{
 const z=await user('Search Z'),a1=await user('Search A'),a2=await user('Search A'),wild=await user('100%_literal');
 assert.deepEqual((await directory({search:'Search ',sort:'nickname'})).data.items.map((m:any)=>m.user_id),[...[a1,a2].sort(),z]);
 assert.deepEqual((await directory({search:'%_'})).data.items.map((m:any)=>m.user_id),[wild]);assert.equal((await directory({search:"' OR true--"})).data.total,0);
 for(const filters of [{sort:'sql;drop'},{guild_key:"guild_security' OR true"},{search:'a'.repeat(101)},{search:'bad\u0000value'},{offset:-1},{limit:51}] as Record<string,string|number>[])assert.equal((await directory(filters)).status,422);
});

test('inactive, unfinished and other-community accounts stay absent from counts and matching results',async()=>{
 await user('隱藏搜尋目標','2026-09-20T00:00:00Z',{active:false});await user('隱藏搜尋目標','2026-09-20T00:00:00Z',{onboarding:true});const other=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[other,'另一個社群']);await user('隱藏搜尋目標','2026-09-20T00:00:00Z',{community:other});
 const result=await directory({search:'隱藏搜尋目標',sort:'newest'});assert.equal(result.status,200);assert.equal(result.data.total,0);assert.equal(result.data.next_offset,null);
 await pool.query('UPDATE users SET onboarding_required=true WHERE user_id=$1',[DEMO_USERS[0].user_id]);assert.equal((await directory({search:'隱藏搜尋目標'})).status,403);
});

test('new registrations retain observed timestamps while existing members receive the owner-designated launch day with provenance',async()=>{
 const result=await app.request(origin+'/api/v1/auth/register',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:'date-test@example.invalid',nickname:'註冊日期測試',password:'a-real-test-password'})});assert.equal(result.status,201);const data=await result.json() as any;
 const registered=(await pool.query('SELECT created_at,created_at_source FROM users WHERE user_id=$1',[data.user.user_id])).rows[0],created=registered.created_at;assert.ok(created instanceof Date);assert.equal(registered.created_at_source,'registered');const regHeaders={Origin:origin,Cookie:result.headers.get('set-cookie')!.split(';')[0]};const own=await app.request(origin+'/api/v1/me/account',{headers:regHeaders});const ownData=await own.json() as any;assert.equal(ownData.joined_at,created.toISOString());assert.equal(ownData.joined_at_source,'registered');
 // Apply the migration to the actual old shape: old members receive the
 // owner-designated launch date, and new rows get an observed timestamp.
 const historical=`fp_joined_history_${process.pid}_${Date.now()}`,q=await admin.connect();
 try{await q.query('BEGIN');await q.query(`CREATE SCHEMA ${historical}`);await q.query(`SET LOCAL search_path=${historical}`);await q.query('CREATE TABLE users(user_id uuid PRIMARY KEY,community_id uuid,active boolean,onboarding_required boolean,onboarding_completed_at timestamptz)');const old=randomUUID(),next=randomUUID();await q.query('INSERT INTO users VALUES($1,$2,true,false,NULL)',[old,DEMO_COMMUNITY]);await q.query(await readFile(new URL('../../migrations/024_member_joined_at.sql',import.meta.url),'utf8'));const previous=(await q.query('SELECT created_at,created_at_source FROM users WHERE user_id=$1',[old])).rows[0];assert.equal(previous.created_at.toISOString(),'2026-09-22T16:00:00.000Z');assert.equal(previous.created_at_source,'launch_day');await q.query('INSERT INTO users(user_id,community_id,active,onboarding_required) VALUES($1,$2,true,false)',[next,DEMO_COMMUNITY]);const current=(await q.query('SELECT created_at,created_at_source FROM users WHERE user_id=$1',[next])).rows[0];assert.ok(current.created_at instanceof Date);assert.equal(current.created_at_source,'registered');}finally{await q.query('ROLLBACK');q.release();}
});
