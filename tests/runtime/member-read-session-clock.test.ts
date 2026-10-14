import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate} from 'node:timers/promises';
import {Pool} from 'pg';
import {z} from 'zod';
import {migrate} from '../../scripts/database.js';
import {seedLocal} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {sampleGuildAnswers} from '../../modules/positioning/guild-questions.js';
import {readSessionCookie} from '../../apps/platform-api/src/session-cookie.js';
import {tokenHash} from '../../modules/identity-membership/service.js';

const database=z.string().min(1).parse(process.env.TEST_DATABASE_URL);
const schema=`fp_member_read_clock_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:database});
const pool=new Pool({connectionString:database,options:`-c search_path=${schema}`,application_name:schema,max:12});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin);
const sessionSchema=z.object({csrf_token:z.string(),user:z.object({user_id:z.uuid()})});
const recordSchema=z.record(z.string(),z.unknown());
type Session={cookie:string;csrf:string;id:string};
let viewer:Session;
const cases:Array<{label:string;path:string;marker:string}>=[];

async function request(path:string,session?:Session,body?:unknown,version?:number){
  const headers:Record<string,string>={Origin:origin};
  if(session){headers.Cookie=session.cookie;headers['X-CSRF-Token']=session.csrf;}
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=randomUUID();if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:recordSchema.parse(await response.json()),cookie:response.headers.get('set-cookie')};
}
async function member(nickname:string):Promise<Session>{
  const result=await request('/auth/register',undefined,{email:`${randomUUID()}@example.test`,nickname,password:'freedom-member-read-clock-password'});
  assert.equal(result.status,201);const parsed=sessionSchema.parse(result.data);assert.ok(result.cookie);
  const session={cookie:result.cookie.split(';')[0],csrf:parsed.csrf_token,id:parsed.user.user_id};
  assert.equal((await request('/me/onboarding/quick-start',session,{guild_keys:['guild_ai_vibe'],primary_guild_key:'guild_ai_vibe',confirmed:true,guild_answers:sampleGuildAnswers('guild_ai_vibe')})).status,200);
  return session;
}
async function contact(session:Session,marker:string,audiences:string[]){
  assert.equal((await request('/me/account',session,{nickname:'期限聯絡會員',contacts:{discord:{value:'',audiences:[]},github:{value:'',audiences:[]},line:{value:marker,audiences},email:{audiences:[]}}},1)).status,200);
}
function sessionHash(){const cookie=readSessionCookie(viewer.cookie,origin);assert.ok(cookie);return tokenHash(cookie);}

before(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);await seedLocal(pool);
  viewer=await member('期限觀看者');const friend=await member('期限好友'),guild=await member('期限公會');
  await contact(viewer,'clock-self-private',[]);await contact(friend,'clock-friends-only',['friends']);await contact(guild,'clock-guild-only',['guild']);
  assert.equal((await request(`/friends/${friend.id}/request`,viewer,{})).status,200);
  const incoming=await request('/friends/directory?scope=incoming',friend);
  const pending=z.object({items:z.array(z.object({user_id:z.uuid(),friendship:z.object({aggregate_version:z.number()})}))}).parse(incoming.data).items.find(item=>item.user_id===viewer.id);assert.ok(pending);
  assert.equal((await request(`/friends/${viewer.id}/accept`,friend,{},pending.friendship.aggregate_version)).status,200);
  const share=await request('/me/member-card-share',friend,{enabled:true,include_avatar:false});assert.equal(share.status,200);
  const token=z.object({share_path:z.string()}).parse(share.data).share_path.split('/').at(-1);assert.ok(token);
  cases.push(
    {label:'self card',path:`/members/${viewer.id}`,marker:'clock-self-private'},
    {label:'friend card',path:`/members/${friend.id}`,marker:'clock-friends-only'},
    {label:'member directory',path:'/members?limit=50',marker:'clock-friends-only'},
    {label:'friend directory',path:'/friends/directory?scope=accepted',marker:'clock-friends-only'},
    {label:'recommendations',path:'/members/recommendations?limit=3',marker:'clock-guild-only'},
    {label:'authenticated shared card',path:`/member-cards/${token}/member`,marker:'clock-friends-only'},
  );
});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});

async function blockedRead(path:string,expired:boolean){
  const gate=await admin.connect();let pending:ReturnType<typeof request>|undefined;
  try{
    const updated=await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[sessionHash(),expired?2:300]);assert.equal(updated.rowCount,1);
    await gate.query('BEGIN');await gate.query(`LOCK TABLE ${schema}.member_accounts IN ACCESS EXCLUSIVE MODE`);
    const holder=z.object({pid:z.number()}).parse((await gate.query('SELECT pg_backend_pid() AS pid')).rows[0]).pid;
    pending=request(path,viewer);
    const deadline=Date.now()+8000;
    for(;;){
      const waiting=z.object({waiting:z.boolean()}).parse((await admin.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=$1 AND $2=ANY(pg_blocking_pids(pid))) AS waiting`,[schema,holder])).rows[0]).waiting;
      if(waiting)break;
      assert.ok(Date.now()<deadline,'the private domain read must actually wait in PostgreSQL');await setImmediate();
    }
    assert.equal(z.object({active:z.boolean()}).parse((await pool.query('SELECT expires_at>clock_timestamp() AS active FROM sessions WHERE token_hash=$1',[sessionHash()])).rows[0]).active,true);
    if(expired){
      // This is a PostgreSQL decision-clock race; JavaScript fake timers cannot advance it.
      await pool.query('SELECT pg_sleep(greatest(0,extract(epoch FROM expires_at-clock_timestamp())::double precision)+0.04) FROM sessions WHERE token_hash=$1',[sessionHash()]);
      assert.equal(z.object({expired:z.boolean()}).parse((await pool.query('SELECT expires_at<=clock_timestamp() AS expired FROM sessions WHERE token_hash=$1',[sessionHash()])).rows[0]).expired,true);
    }
    await gate.query('ROLLBACK');return await pending;
  }finally{await gate.query('ROLLBACK');gate.release();if(pending)await pending;}
}

test('private contact projections reject expiry after a real domain wait and preserve current-session reads',async t=>{
  for(const item of cases)await t.test(item.label,async()=>{
    const denied=await blockedRead(item.path,true);
    assert.equal(denied.status,401);assert.equal(denied.data.code,'session_expired');
    assert.equal(JSON.stringify(denied.data).includes(item.marker),false);
    const valid=await blockedRead(item.path,false);
    assert.equal(valid.status,200);assert.equal(JSON.stringify(valid.data).includes(item.marker),true);
  });
});
