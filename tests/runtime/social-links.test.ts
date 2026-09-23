import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {authenticate,type Actor} from '../../modules/identity-membership/service.js';
import {visibleSocialLinks,ownSocialLinks} from '../../modules/identity-membership/social-links.js';
const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL,schema=`fp_social_links_${process.pid}_${Date.now()}`;
const database=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12}),app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any;actor:Actor};let owner:Session,viewer:Session,other:Session;
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);[owner,viewer,other]=await Promise.all(DEMO_USERS.map(user=>login(user.email)));});
async function request(path:string,session?:Session,body?:unknown,version?:number,key=randomUUID(),extra:Record<string,string>={}){const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra};if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version!==undefined)headers['If-Match']=`"${version}"`;}
 const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});return {status:response.status,data:await response.json() as any,response};}
async function login(email:string):Promise<Session>{const response=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(response.status,200);const cookie=response.response.headers.get('set-cookie')!.split(';')[0];return {cookie,csrf:response.data.csrf_token,user:response.data.user,actor:await authenticate(pool,cookie.split('=')[1])};}
const link=(patch:Record<string,unknown>={})=>({platform:'facebook',label:'粉絲專頁',url:'https://www.facebook.com/freedom-synthetic-page',audiences:[],...patch});
async function create(body=link(),session=owner,key=randomUUID()){const result=await request('/me/social-links',session,body,undefined,key);assert.equal(result.status,201,JSON.stringify(result.data));return result.data;}
async function visible(session=viewer,member=owner.user.user_id,query=''){return request(`/members/${member}/social-links${query}`,session);}
async function friendship(state='accepted'){const [low,high]=[owner.user.user_id,viewer.user.user_id].sort();await pool.query(`INSERT INTO member_friendships(community_id,low_ref,high_ref,requester_ref,state) VALUES($1,$2,$3,$4,$5) ON CONFLICT(community_id,low_ref,high_ref) DO UPDATE SET state=$5`,[DEMO_COMMUNITY,low,high,viewer.user.user_id,state]);}
async function guildTogether(state='active'){for(const session of [owner,viewer])await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_event_space',$4) ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state=$4`,[randomUUID(),DEMO_COMMUNITY,session.user.user_id,state]);}
async function squadTogether(){const id=randomUUID();await pool.query("INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref) VALUES($1,$2,'合成小隊','project','測试隱私',$3)",[id,DEMO_COMMUNITY,owner.user.user_id]);for(const session of [owner,viewer])await pool.query("INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')",[id,session.user.user_id]);return id;}

test('repeatable social links allow multiple Facebook pages and Instagram accounts beyond a small profile limit with stable paging',async()=>{
 const created=[];for(let i=0;i<8;i++)created.push(await create(link({label:'粉專 '+i,url:'https://www.facebook.com/synthetic-'+i})));for(let i=0;i<2;i++)created.push(await create(link({platform:'instagram',label:'IG '+i,url:'https://www.instagram.com/synthetic_'+i})));assert.equal(new Set(created.map(row=>row.link_id)).size,10);
 const first=await request('/me/social-links?limit=6',owner);assert.equal(first.data.total,10);assert.equal(first.data.next_offset,6);assert.equal(first.data.items.length,6);assert.ok(first.data.items.every((row:any)=>row.verified===false&&row.aggregate_version===1&&row.audiences.length===0));
 const next=await request('/me/social-links?limit=6&offset=6',owner);assert.equal(next.data.items.length,4);assert.equal(next.data.next_offset,null);assert.equal(new Set([...first.data.items,...next.data.items].map(row=>row.link_id)).size,10);assert.equal((await visible()).data.total,0);assert.equal((await visible(owner)).data.total,10);
 const beyond=await request('/me/social-links?offset=100',owner);assert.equal(beyond.data.total,10);assert.deepEqual(beyond.data.items,[]);assert.equal(beyond.data.next_offset,null);
});

test('per-entry edits require versions, reject cross-owner requests and serialize simultaneous edits',async()=>{
 const entry=await create(),body=link({label:'新的頁名',audiences:['friends','guild']});const path=`/me/social-links/${entry.link_id}/edit`;
 assert.equal((await request(path,owner,body)).status,428);assert.equal((await request(path,viewer,body,1)).status,404);
 const results=await Promise.all([request(path,owner,body,1),request(path,owner,{...body,label:'另一個修改'},1)]);assert.deepEqual(results.map(row=>row.status).sort(),[200,412]);const saved=results.find(row=>row.status===200)!.data;assert.equal(saved.aggregate_version,2);assert.deepEqual(saved.audiences,['friends','guild']);assert.equal(saved.verified,false);
 assert.equal((await request(`/me/social-links/${entry.link_id}/delete`,viewer,{},2)).status,404);assert.equal((await request(`/me/social-links/${entry.link_id}/delete`,owner,{},1)).status,412);
 assert.equal((await request('/me/social-links',owner,{...link(),verified:true})).status,422);
});

test('replays read the current owned value or tombstone while receipts and journals never contain private URLs',async()=>{
 const initialUrl='https://www.facebook.com/private-creation-secret',latestUrl='https://www.facebook.com/private-edited-secret',createKey=randomUUID(),createBody=link({url:initialUrl});const entry=await create(createBody,owner,createKey),editKey=randomUUID(),editBody=link({url:latestUrl,label:'更新的私密頁'}),path=`/me/social-links/${entry.link_id}`;
 const edited=await request(path+'/edit',owner,editBody,1,editKey);assert.equal(edited.status,200);const replay=await request('/me/social-links',owner,createBody,undefined,createKey);assert.equal(replay.data.url,latestUrl);assert.equal(replay.data.aggregate_version,2);assert.equal((await request('/me/social-links',owner,{...createBody,label:'不同內容'},undefined,createKey)).status,409);
 const deleteKey=randomUUID(),removed=await request(path+'/delete',owner,{},2,deleteKey);assert.equal(removed.status,200);assert.deepEqual(removed.data,{link_id:entry.link_id,deleted:true,aggregate_version:3});assert.deepEqual((await request(path+'/delete',owner,{},2,deleteKey)).data,removed.data);
 assert.deepEqual((await request(path+'/edit',owner,editBody,1,editKey)).data,removed.data);assert.deepEqual((await request('/me/social-links',owner,createBody,undefined,createKey)).data,removed.data);assert.equal((await request(path+'/edit',owner,editBody,3)).status,404);
 assert.equal((await request('/me/social-links',owner)).data.total,0);assert.equal((await visible(owner)).data.total,0);
 const traces=JSON.stringify({receipts:(await pool.query('SELECT response FROM command_receipts')).rows,journal:(await pool.query('SELECT to_jsonb(j) AS record FROM transition_journal j')).rows,outbox:(await pool.query('SELECT to_jsonb(o) AS record FROM outbox o')).rows});for(const secret of [initialUrl,latestUrl,'更新的私密頁'])assert.equal(traces.includes(secret),false,secret);
});

test('public projection counts only currently visible entries and audiences combine with OR then revoke immediately',async()=>{
 await create(link({label:'完全私密'}));const publicEntry=await create(link({label:'公開頁',url:'https://facebook.com/public-synthetic',audiences:['public','friends']}));assert.deepEqual(publicEntry.audiences,['public']);await create(link({label:'多重關係',audiences:['friends','guild']}));await create(link({label:'小隊頁',audiences:['squad']}));
 const initial=await visible();assert.equal(initial.status,200);assert.equal(initial.data.total,1);assert.equal(initial.data.items[0].link_id,publicEntry.link_id);assert.deepEqual(Object.keys(initial.data.items[0]).sort(),['link_id','platform','label','url','verified'].sort());assert.equal((await visible(viewer,owner.user.user_id,'?offset=1&limit=1')).data.total,1);assert.deepEqual((await visible(viewer,owner.user.user_id,'?offset=1&limit=1')).data.items,[]);
 await friendship('pending');assert.equal((await visible()).data.total,1);await friendship();assert.equal((await visible()).data.total,2);await guildTogether();await friendship('removed');assert.equal((await visible()).data.total,2);const squad=await squadTogether();assert.equal((await visible()).data.total,3);
 await guildTogether('left');assert.equal((await visible()).data.total,2);await pool.query("UPDATE member_squad_memberships SET state='left' WHERE squad_id=$1 AND user_id=$2",[squad,viewer.user.user_id]);assert.equal((await visible()).data.total,1);
 const edited=await request(`/me/social-links/${publicEntry.link_id}/edit`,owner,link({label:'改回私密',audiences:[]}),1);assert.equal(edited.status,200);assert.equal((await visible()).data.total,0);assert.equal((await visible(owner)).data.total,4);
});

test('a single projection snapshot never combines an old relationship with a newer private URL',async()=>{
 const beforeUrl='https://facebook.com/visible-before-revocation',afterUrl='https://facebook.com/private-after-revocation';await create(link({url:beforeUrl,audiences:['friends']}));await friendship();let queries=0;
 const wrapped={query:async(text:string,values:unknown[])=>{queries++;const result=await pool.query(text,values);await friendship('removed');await pool.query('UPDATE member_social_links SET url=$1,aggregate_version=aggregate_version+1 WHERE user_id=$2',[afterUrl,owner.user.user_id]);return result;}} as unknown as Pool;
 const captured=await visibleSocialLinks(wrapped,viewer.actor,owner.user.user_id);assert.equal(queries,1);assert.equal(captured.total,1);assert.equal(captured.items[0].url,beforeUrl);assert.equal(JSON.stringify(captured).includes(afterUrl),false);assert.equal((await visible()).data.total,0);
});

test('inactive, unfinished and foreign members cannot expose links and stale sessions cannot read or mutate',async()=>{
 const entry=await create(link({audiences:['public']}));const community=randomUUID(),foreignId=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Foreign']);await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) SELECT $1,$2,'foreign-social@example.invalid','Other',password_hash,$3 FROM users WHERE user_id=$4`,[foreignId,community,randomUUID(),owner.user.user_id]);const foreign=await login('foreign-social@example.invalid');assert.equal((await visible(foreign)).status,404);assert.equal((await request(`/me/social-links/${entry.link_id}/edit`,foreign,link(),1)).status,404);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[owner.user.user_id]);assert.equal((await visible()).status,404);await pool.query('UPDATE users SET onboarding_required=false WHERE user_id=$1',[owner.user.user_id]);await pool.query('UPDATE users SET active=false WHERE user_id=$1',[owner.user.user_id]);assert.equal((await visible()).status,404);await pool.query('UPDATE users SET active=true WHERE user_id=$1',[owner.user.user_id]);
 await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[owner.actor.session_hash]);assert.equal((await request('/me/social-links',owner)).status,401);await assert.rejects(ownSocialLinks(pool,owner.actor));assert.equal((await request(`/me/social-links/${entry.link_id}/delete`,owner,{},1)).status,401);
});

test('URL validation allows real HTTPS provider links but rejects unsafe schemes, credentials, platform mismatches and private literals',async()=>{
 for(const url of ['javascript:alert(1)','data:text/html,x','http://facebook.com/page','https://name:secret@facebook.com/page','https://localhost/page','https://localtest.local/page','https://intranet.internal/page','https://127.0.0.1/','https://2130706433/','https://0x7f000001/','https://10.1.2.3/','https://172.16.1.1/','https://192.168.1.1/','https://169.254.169.254/','https://[::1]/','https://[::]/','https://[fd00::1]/','https://[fe80::1]/','https://[::ffff:127.0.0.1]/','https://[::ffff:0:7f00:1]/','\nhttps://example.com/','https://example.com/\r','https://example.com/\nprivate'])assert.equal((await request('/me/social-links',owner,link({platform:'website',url}))).status,422,url);
 for(const url of ['https://instagram.com/not-facebook','https://facebook.com.attacker.invalid/page','https://attacker-facebook.com/page'])assert.equal((await request('/me/social-links',owner,link({url}))).status,422,url);
 for(const body of [link({platform:'instagram',url:'https://www.instagram.com/community.one'}),link({platform:'threads',url:'https://www.threads.com/@community'}),link({platform:'website',url:'https://example.org/community'}),link({platform:'x',url:'https://x.com/example'})])assert.equal((await request('/me/social-links',owner,body)).status,201);
 for(const body of [link({label:''}),link({label:'a'.repeat(81)}),link({url:'https://example.com/'+ 'a'.repeat(2048)}),link({audiences:['guild','guild']}),link({audiences:['private']}),link({platform:'imaginary'})])assert.equal((await request('/me/social-links',owner,body)).status,422);
});

test('social URLs never enter directory search or public development data and routes retain authentication, CSRF and pagination guards',async()=>{
 const needle='never-index-this-private-social-url';await create(link({url:'https://facebook.com/'+needle}));for(const term of [needle,'https://facebook.com/'+needle]){const result=await request('/members?search='+encodeURIComponent(term),viewer);assert.equal(result.status,200);assert.equal(result.data.total,0);}
 const development=await app.request(origin+'/api/v1/development-map');assert.equal(development.status,200);assert.equal((await development.text()).includes(needle),false);
 assert.equal((await request('/me/social-links')).status,401);const anonymous=await app.request(origin+`/api/v1/members/${owner.user.user_id}/social-links`);assert.equal(anonymous.status,401);
 assert.equal((await request('/me/social-links',owner,link(),undefined,randomUUID(),{'X-CSRF-Token':''})).status,403);assert.equal((await request('/me/social-links',owner,link(),undefined,randomUUID(),{Origin:'https://other.example'})).status,403);
 for(const suffix of ['?limit=51','?limit=0','?offset=-1','?unknown=field']){assert.equal((await request('/me/social-links'+suffix,owner)).status,422);assert.equal((await visible(viewer,owner.user.user_id,suffix)).status,422);}
 await pool.query('UPDATE users SET onboarding_required=true WHERE user_id=$1',[viewer.user.user_id]);assert.equal((await visible()).status,403);
});
