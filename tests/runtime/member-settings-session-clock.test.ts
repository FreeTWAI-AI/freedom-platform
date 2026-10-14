import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {Pool} from 'pg';
import {z} from 'zod';
import {LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {readSessionCookie} from '../../apps/platform-api/src/session-cookie.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
const database=z.string().min(1).parse(process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL),schema=`fp_settings_clock_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:database}),pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,application_name:schema,max:12});
const origin='http://127.0.0.1:4334',app=createApp(pool,origin),record=z.record(z.string(),z.unknown());

const email=`${randomUUID()}@example.test`,password='freedom-settings-clock-password';
type Session={cookie:string;csrf:string;id:string};let session:Session;
type RequestResult={status:number;data:Record<string,unknown>;cookie:string|null};
async function request(path:string,body?:unknown,version?:number,key=randomUUID(),anonymous=false):Promise<RequestResult>{
 const headers:Record<string,string>={Origin:origin};if(session&&!anonymous){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf;}
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version!==undefined)headers['If-Match']=`"${version}"`;}
 const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:record.parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
function hash(){const raw=readSessionCookie(session.cookie,origin);assert.ok(raw);return tokenHash(raw);}
async function expiry(seconds:number){assert.equal((await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[hash(),seconds])).rowCount,1);}
async function waitFor(holder:number){const deadline=Date.now()+8000;for(;;){const waiting=z.object({waiting:z.boolean()}).parse((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting',[schema,holder])).rows[0]).waiting;if(waiting)return;assert.ok(Date.now()<deadline,'HTTP request must actually wait in PG');await setImmediate();}}
async function expireNow(){assert.equal(z.object({active:z.boolean()}).parse((await pool.query('SELECT expires_at>clock_timestamp() AS active FROM sessions WHERE token_hash=$1',[hash()])).rows[0]).active,true);await pool.query('SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp())::double precision)+0.04) FROM sessions WHERE token_hash=$1',[hash()]);assert.equal(z.object({expired:z.boolean()}).parse((await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1',[hash()])).rows[0]).expired,true);}
async function blockedGet(path:string,expired:boolean){
 const gate=await admin.connect();let pending:Promise<RequestResult>|undefined;
 try{await expiry(expired?2:300);await gate.query('BEGIN');await gate.query(`LOCK TABLE ${schema}.member_social_links IN ACCESS EXCLUSIVE MODE`);const holder=z.object({pid:z.number()}).parse((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]).pid;pending=request(path);await waitFor(holder);if(expired)await expireNow();await gate.query('ROLLBACK');return await pending;}finally{await gate.query('ROLLBACK');gate.release();if(pending)await pending;}
}
async function blockedReadback(action:'create'|'edit'|'delete',expired:boolean){
 await expiry(300);const marker=`readback-private-${randomUUID()}`,body={platform:'website',label:'私人連結',url:`https://example.test/${marker}`,audiences:[]};
 let id:string|undefined;
 if(action!=='create'){const initial=await request('/me/social-links',body);assert.equal(initial.status,201);id=z.object({link_id:z.uuid()}).parse(initial.data).link_id;}
 const key=randomUUID(),path=action==='create'?'/me/social-links':`/me/social-links/${id}/${action}`,payload=action==='delete'?{}:body;
 const first=await admin.connect(),gate=await admin.connect();let pending:Promise<RequestResult>|undefined,lock:Promise<unknown>|undefined;
 try{
  await pool.query(`CREATE OR REPLACE FUNCTION pause_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.idempotency_key='${key}' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${schema}/${key}',0)); END IF; RETURN NEW; END $$`);
  await first.query('SELECT pg_advisory_lock(hashtextextended($1,0))',[`${schema}/${key}`]);const holder=z.object({pid:z.number()}).parse((await first.query('SELECT pg_backend_pid() AS pid')).rows[0]).pid;
  await expiry(expired?5:300);pending=request(path,payload,action==='create'?undefined:1,key);await waitFor(holder);
  await gate.query('BEGIN');const gatePid=z.object({pid:z.number()}).parse((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]).pid;lock=gate.query(`LOCK TABLE ${schema}.member_social_links IN ACCESS EXCLUSIVE MODE`);
  const deadline=Date.now()+8000;for(;;){const queued=z.object({queued:z.boolean()}).parse((await admin.query('SELECT cardinality(pg_blocking_pids($1))>0 AS queued',[gatePid])).rows[0]).queued;if(queued)break;assert.ok(Date.now()<deadline,'table lock must queue behind the uncommitted mutation');await setImmediate();}
  await first.query('SELECT pg_advisory_unlock_all()');await lock;await waitFor(gatePid);
  assert.equal(z.object({count:z.number()}).parse((await pool.query('SELECT count(*)::int AS count FROM command_receipts WHERE idempotency_key=$1',[key])).rows[0]).count,1,'mutation receipt must already be committed before readback waits');
  if(expired)await expireNow();await gate.query('ROLLBACK');const result=await pending;
  assert.equal(result.status,expired?401:action==='create'?201:200);if(expired){assert.equal(result.data.code,'session_expired');assert.equal(JSON.stringify(result.data).includes(marker),false);}else assert.equal(JSON.stringify(result.data).includes(marker),action!=='delete');
  const facts=z.object({link_id:z.uuid(),aggregate_version:z.string(),deleted:z.boolean()}).parse((await pool.query('SELECT link_id,aggregate_version,deleted_at IS NOT NULL AS deleted FROM member_social_links WHERE user_id=$1 AND url=$2',[session.id,body.url])).rows[0]);
  assert.equal(facts.aggregate_version,action==='create'?'1':'2');assert.equal(facts.deleted,action==='delete');
  console.log(JSON.stringify({action,expired,status:result.status,private_url:JSON.stringify(result.data).includes(marker),committed_version:facts.aggregate_version,deleted:facts.deleted}));
  const login=await request('/auth/login',{email,password},undefined,randomUUID(),true);assert.equal(login.status,200);const auth=z.object({csrf_token:z.string(),user:z.object({user_id:z.uuid()})}).parse(login.data);assert.ok(login.cookie);session={cookie:login.cookie.split(';')[0],csrf:auth.csrf_token,id:auth.user.user_id};
  const replay=await request(path,payload,action==='create'?undefined:1,key);assert.equal(replay.status,action==='create'?201:200);const current=z.object({link_id:z.uuid(),aggregate_version:z.number(),url:z.string().optional(),deleted:z.boolean().optional()}).parse(replay.data);assert.equal(current.link_id,facts.link_id);assert.equal(current.aggregate_version,Number(facts.aggregate_version));assert.equal(current.deleted??false,action==='delete');assert.equal(current.url,action==='delete'?undefined:body.url);
  assert.equal(z.object({count:z.number()}).parse((await pool.query('SELECT count(*)::int AS count FROM member_social_links WHERE user_id=$1 AND url=$2',[session.id,body.url])).rows[0]).count,1,'same command replay must not create duplicates or resurrect the deleted value');
  return result;
 }finally{await first.query('SELECT pg_advisory_unlock_all()');if(lock)await lock;await gate.query('ROLLBACK');first.release();gate.release();if(pending)await pending;}
}
test('private owner projections fence SQL waits and committed link commands recover by replay after relogin',async()=>{
try{
 await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);
 const registered=await request('/auth/register',{email,nickname:'設定期限合成會員',password},undefined,randomUUID(),true);assert.equal(registered.status,201);const parsed=z.object({csrf_token:z.string(),user:z.object({user_id:z.uuid()})}).parse(registered.data);assert.ok(registered.cookie);session={cookie:registered.cookie.split(';')[0],csrf:parsed.csrf_token,id:parsed.user.user_id};
 assert.equal((await request('/me/onboarding/quick-start',{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);
 assert.equal((await request('/me/member-card-share',{enabled:false,include_avatar:false,links:[{label:'未公開私人設定',url:'https://example.test/share-settings-private'}]})).status,200);
 assert.equal((await request('/me/social-links',{platform:'website',label:'私人連結',url:'https://example.test/social-owner-private',audiences:[]})).status,201);
 for(const item of [{path:'/me/member-card-share',marker:'share-settings-private'},{path:'/me/social-links',marker:'social-owner-private'},{path:`/members/${session.id}/social-links`,marker:'social-owner-private'}]){for(const expired of [true,false]){const result=await blockedGet(item.path,expired);console.log(JSON.stringify({path:item.path,expired,status:result.status,private_value:JSON.stringify(result.data).includes(item.marker)}));assert.equal(result.status,expired?401:200);assert.equal(JSON.stringify(result.data).includes(item.marker),!expired);if(expired)assert.equal(result.data.code,'session_expired');}}
 await pool.query('CREATE FUNCTION pause_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$');
 await pool.query('CREATE TRIGGER pause_receipt AFTER INSERT ON command_receipts FOR EACH ROW EXECUTE FUNCTION pause_receipt()');
 for(const action of ['create','edit','delete'] as const)for(const expired of [true,false])await blockedReadback(action,expired);
 console.log(JSON.stringify({consumer_cases:12,complete:true}));
}finally{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();}
});
