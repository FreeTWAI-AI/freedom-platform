import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,type Command} from '../../packages/db/index.js';
import {Problem} from '../../packages/shared/problem.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {login} from '../../modules/identity-membership/service.js';
import {
  listChannels,channelMessages,sendChannelMessage,markChannelRead,CHANNEL_MESSAGE_RATE_LIMIT,
} from '../../modules/member-communications/channels.js';

// Core behaviour of guild/squad channels on the mounted API. The exhaustive
// permission matrix and lock races live in member-channel-access.test.ts.
const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_member_channels_${process.pid}_${Date.now()}`,database=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user_id:string};
const [A,B,C]=DEMO_USERS.map(user=>user.user_id);
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});

async function request(path:string,session?:Session,body?:unknown,options:{key?:string;csrf?:string;ifMatch?:string}={}){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':options.csrf??session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';if(options.key!=='')headers['Idempotency-Key']=options.key??randomUUID();if(options.ifMatch)headers['If-Match']=options.ifMatch;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any};
}
async function signIn(email:string):Promise<Session>{
  const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password:DEMO_PASSWORD})});
  const data=await response.json() as any;assert.equal(response.status,200,JSON.stringify(data));
  return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token,user_id:data.user.user_id};
}
const signInAll=()=>Promise.all(DEMO_USERS.map(user=>signIn(user.email)));
/** Synthetic member sharing the demo password hash; not a real person. */
async function extraMember(label:string,community=DEMO_COMMUNITY,state:{ready?:boolean}={}){
  const id=randomUUID(),email=`${label}-${id.slice(0,8)}@example.invalid`;
  if(community!==DEMO_COMMUNITY)await pool.query('INSERT INTO communities VALUES($1,$2) ON CONFLICT DO NOTHING',[community,'合成的其他社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,$2,$3,$4,password_hash,$5,$6 FROM users WHERE user_id=$7`,[id,community,email,`合成會員${label}`,randomUUID(),state.ready===false,A]);
  return {id,email};
}
// Synthetic membership fixtures; channel access derives only from these rows.
const joinGuild=(user:string,key:string,community=DEMO_COMMUNITY,state='active')=>pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state)
  VALUES($1,$2,$3,$4,$5) ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state=$5`,[randomUUID(),community,user,key,state]);
async function squad(owner:string,members:string[]=[],name='合成小隊',community=DEMO_COMMUNITY){
  const id=randomUUID();
  await pool.query(`INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref) VALUES($1,$2,$3,'project','合成目的',$4)`,[id,community,name,owner]);
  for(const user of [owner,...members])await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[id,user]);
  return id;
}
/** Custom guild in the global catalog, optionally approved for one community. */
async function customGuild(hex:string,name:string,approvedIn:string|null){
  const key=`guild_custom_${hex}`;
  await pool.query(`INSERT INTO positioning_guild_catalog(guild_key,profession_key,name,purpose,first_step,module_key) VALUES($1,$2,$3,'合成','合成','guilds')`,[key,`custom_${hex}`,name]);
  if(approvedIn)await pool.query(`INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason,state,approved_guild_key)
    SELECT $1,$2,user_id,$3,'合成','合成','approved',$4 FROM users WHERE community_id=$2 LIMIT 1`,[randomUUID(),approvedIn,name,key]);
  return key;
}
const count=async(sql:string,values:unknown[]=[])=>(await pool.query(`SELECT count(*)::int AS n FROM ${sql}`,values)).rows[0].n as number;
const tableCounts=async()=>({channels:await count('member_chat_channels'),messages:await count('member_channel_messages'),reads:await count('member_channel_reads'),receipts:await count('command_receipts')});
const noPrivate=(data:unknown)=>{const text=JSON.stringify(data);for(const needle of ['@local.test','@example.invalid','password','csrf','token_hash','email','avatar'])assert.ok(!text.includes(needle),`leaked ${needle}: ${text}`);};
const post=(session:Session,kind:string,key:string,body:string,options:{key?:string}={})=>request(`/me/channels/${kind}/${key}/messages`,session,{body},options);
const read=(session:Session,kind:string,key:string,through:string,options:{key?:string}={})=>request(`/me/channels/${kind}/${key}/read`,session,{through_message_id:through},options);
const messages=(session:Session,kind:string,key:string,query='')=>request(`/me/channels/${kind}/${key}/messages${query}`,session);

test('the list shows every joined room, including empty ones, sorted and paged with total unread and no bodies, and GET writes nothing',async()=>{
  const [a,b]=await signInAll();
  for(const key of ['guild_marketing','guild_ai_vibe','guild_platform_engineering'])await joinGuild(A,key);
  await joinGuild(B,'guild_ai_vibe');await joinGuild(A,'guild_ai_project',DEMO_COMMUNITY,'left');
  const s1=await squad(A,[B],'合成小隊一'),s2=await squad(B,[],'合成小隊二');
  await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'pending')`,[s2,A]);
  const empty=await tableCounts(),emptyList=await request('/me/channels?kind=guild',a);
  assert.equal(emptyList.status,200,JSON.stringify(emptyList.data));
  assert.deepEqual(emptyList.data,{items:['guild_ai_vibe','guild_marketing','guild_platform_engineering'].map(key=>({kind:'guild',channel_key:key,name:emptyList.data.items.find((i:any)=>i.channel_key===key).name,unread_count:0,last_message_at:null})),unread_count:0,next_offset:null});
  assert.equal(emptyList.data.items[0].name,'AI 開發公會');
  const squads=await request('/me/channels?kind=squad',a);
  assert.deepEqual(squads.data,{items:[{kind:'squad',channel_key:s1,name:'合成小隊一',unread_count:0,last_message_at:null}],unread_count:0,next_offset:null});
  await request(`/me/channels/guild/guild_marketing/messages`,a);await request(`/me/channels/squad/${s1}/messages`,a);
  assert.deepEqual(await tableCounts(),empty,'GET must not create channel, message, read or receipt rows');

  assert.equal((await post(b,'guild','guild_ai_vibe','第一則')).status,201);
  assert.equal((await post(b,'guild','guild_ai_vibe','第二則')).status,201);
  assert.equal((await post(a,'guild','guild_platform_engineering','自己的訊息')).status,201);
  assert.equal((await post(b,'squad',s1,'小隊訊息')).status,201);
  const first=await request('/me/channels?kind=guild&limit=2',a),second=await request('/me/channels?kind=guild&limit=2&offset=2',a);
  // Newest activity first, empty rooms last, ties by key; own messages are never unread.
  assert.deepEqual(first.data.items.map((i:any)=>[i.channel_key,i.unread_count]),[['guild_platform_engineering',0],['guild_ai_vibe',2]]);
  assert.deepEqual(second.data.items.map((i:any)=>[i.channel_key,i.last_message_at]),[['guild_marketing',null]]);
  assert.equal(first.data.unread_count,2);assert.equal(second.data.unread_count,2);assert.equal(first.data.next_offset,2);assert.equal(second.data.next_offset,null);
  assert.ok(first.data.items[0].last_message_at>first.data.items[1].last_message_at);assert.match(first.data.items[0].last_message_at,/Z$/);
  for(const item of first.data.items)assert.deepEqual(Object.keys(item).sort(),['channel_key','kind','last_message_at','name','unread_count']);
  const text=JSON.stringify(first.data);for(const body of ['第一則','第二則','自己的訊息'])assert.ok(!text.includes(body),'list must not include bodies');
  assert.equal((await request('/me/channels?kind=squad',a)).data.unread_count,1,'unread total is per requested kind');
  for(const query of ['','kind=dm','kind=guild&limit=0','kind=guild&limit=51','kind=guild&offset=-1','kind=guild&offset=10001','kind=guild&limit=abc','kind=guild&unknown=1']){
    const bad=await request(`/me/channels?${query}`,a);assert.equal(bad.status,422,query);
  }
});

test('messages are strict plain text with stable per-room sequences, identity-only sender fields, CSRF and idempotent replay without stored text',async()=>{
  const [a,b]=await signInAll();
  await joinGuild(A,'guild_marketing');await joinGuild(B,'guild_marketing');const s=await squad(B,[A]);
  const path='/me/channels/guild/guild_marketing/messages';
  for(const body of [{body:''},{body:' \r\n\t '},{body:'a\u0000b'},{body:'bell\u0007'},{body:'x'.repeat(2001)},{body:'😀'.repeat(2001)},{body:1},{body:'ok',extra:true},{}]){
    const bad=await request(path,a,body);assert.equal(bad.status,422,JSON.stringify(body));
  }
  assert.equal((await request(path,a,{body:'hi'},{key:''})).data.code,'idempotency_required');
  assert.equal((await request(path,a,{body:'hi'},{csrf:'x'.repeat(43)})).data.code,'csrf_rejected');
  assert.equal(await count('member_channel_messages'),0);
  const max=await post(a,'guild','guild_marketing','😀'.repeat(2000));assert.equal(max.status,201,JSON.stringify(max.data));
  const key=randomUUID(),sent=await post(a,'guild','guild_marketing','  第一行\r\n第二行<b>x</b>\r  ',{key});
  assert.equal(sent.status,201,JSON.stringify(sent.data));
  assert.deepEqual(Object.keys(sent.data).sort(),['body','channel_key','created_at','kind','message_id','sender_name','sender_ref','sequence']);
  assert.deepEqual({...sent.data,message_id:undefined,created_at:undefined},{message_id:undefined,created_at:undefined,kind:'guild',channel_key:'guild_marketing',sequence:'2',
    sender_ref:A,sender_name:DEMO_USERS[0].display_name,body:'第一行\n第二行<b>x</b>'});
  assert.match(sent.data.created_at,/^\d{4}-\d\d-\d\dT.*Z$/);noPrivate(sent.data);
  // Replay returns the same row, needs no new budget and keeps text out of receipts.
  assert.deepEqual((await post(a,'guild','guild_marketing','  第一行\r\n第二行<b>x</b>\r  ',{key})),{status:201,data:sent.data});
  assert.equal((await post(a,'guild','guild_marketing','不同內容',{key})).data.code,'idempotency_conflict');
  const receipts=(await pool.query("SELECT response::text FROM command_receipts WHERE operation LIKE 'POST %/me/channels/%'")).rows.map(r=>r.response);
  assert.ok(receipts.length>=2);for(const response of receipts){assert.deepEqual(Object.keys(JSON.parse(response)),['message_id']);assert.ok(!response.includes('第一行'));}
  for(const table of ['transition_journal','outbox'])assert.equal(await count(`${table} t WHERE t::text LIKE '%第一行%'`),0);
  assert.equal(await count('member_notifications'),0,'channel posts create no notifications');

  // Sequences are per room: the squad starts at 1 independently.
  assert.equal((await post(b,'squad',s,'小隊一')).data.sequence,'1');
  assert.equal((await post(b,'guild','guild_marketing','第三則')).data.sequence,'3');
  const upper=await post(a,'squad',s.toUpperCase(),'大寫路徑');assert.equal(upper.data.channel_key,s);assert.equal(upper.data.sequence,'2');
  const page=await messages(a,'guild','guild_marketing','?limit=2'),rest=await messages(a,'guild','guild_marketing','?limit=2&offset=2');
  assert.deepEqual(page.data.channel,{kind:'guild',channel_key:'guild_marketing',name:'成長與行銷公會'});
  assert.deepEqual(page.data.items.map((m:any)=>m.sequence),['3','2']);assert.deepEqual(rest.data.items.map((m:any)=>m.sequence),['1']);
  assert.equal(page.data.next_offset,2);assert.equal(rest.data.next_offset,null);assert.equal(page.data.unread_count,1);
  assert.deepEqual(Object.keys(page.data).sort(),['channel','items','next_offset','unread_count']);noPrivate(page.data);
  for(const query of ['?limit=0','?limit=51','?offset=10001','?kind=guild'])assert.equal((await messages(a,'guild','guild_marketing',query)).status,422,query);
});

test('read cursors are scoped to one room, only move forward, exclude own messages and never swallow later posts',async()=>{
  const [a,b]=await signInAll();
  await joinGuild(A,'guild_marketing');await joinGuild(B,'guild_marketing');await joinGuild(B,'guild_ai_vibe');const s=await squad(A,[B]);
  const m1=(await post(b,'guild','guild_marketing','一')).data,m2=(await post(b,'guild','guild_marketing','二')).data;
  await post(a,'guild','guild_marketing','自己');const m4=(await post(b,'guild','guild_marketing','四')).data;
  const squadMessage=(await post(b,'squad',s,'小隊')).data,foreign=(await post(b,'guild','guild_ai_vibe','別的公會')).data;
  assert.equal((await messages(a,'guild','guild_marketing')).data.unread_count,3);
  assert.equal(await count('member_channel_reads'),0,'GET does not mark anything read');
  for(const through of [squadMessage.message_id,foreign.message_id,randomUUID()])
    assert.equal((await read(a,'guild','guild_marketing',through)).data.code,'channel_message_not_found');
  assert.equal((await request('/me/channels/guild/guild_marketing/read',a,{through_message_id:'nope'})).status,422);
  assert.equal((await request('/me/channels/guild/guild_marketing/read',a,{through_message_id:m1.message_id,extra:1})).status,422);
  const key=randomUUID(),marked=await read(a,'guild','guild_marketing',m2.message_id.toUpperCase(),{key});
  assert.equal(marked.status,200,JSON.stringify(marked.data));
  assert.deepEqual(Object.keys(marked.data).sort(),['channel_key','kind','read_at','read_sequence']);
  assert.deepEqual({...marked.data,read_at:undefined},{kind:'guild',channel_key:'guild_marketing',read_sequence:'2',read_at:undefined});
  assert.equal((await messages(a,'guild','guild_marketing')).data.unread_count,1,'only the later message from B stays unread');
  const back=await read(a,'guild','guild_marketing',m1.message_id);
  assert.deepEqual(back.data,marked.data,'an older message neither moves the cursor back nor touches read_at');
  const m5=(await post(b,'guild','guild_marketing','五')).data;
  assert.deepEqual((await read(a,'guild','guild_marketing',m2.message_id.toUpperCase(),{key})).data,marked.data,'replay returns the stored result');
  assert.equal((await messages(a,'guild','guild_marketing')).data.unread_count,2);
  assert.equal((await read(a,'guild','guild_marketing',m4.message_id)).data.read_sequence,'4');
  assert.equal((await request('/me/channels?kind=guild',a)).data.unread_count,1);
  assert.equal((await read(a,'guild','guild_marketing',m5.message_id)).data.read_sequence,'5');
  assert.equal((await request('/me/channels?kind=guild',a)).data.unread_count,0);
  assert.equal((await request('/me/channels?kind=squad',a)).data.unread_count,1,'squad cursor is independent');
  assert.equal((await request('/me/channels?kind=guild',b)).data.unread_count,1,'B still has A\'s message unread');
});

test('one sender budget covers guild and squad sends under concurrency, while same-key requests and replays add nothing',async()=>{
  const [a]=await signInAll();
  await joinGuild(A,'guild_marketing');const s=await squad(A);
  const early=randomUUID(),first=await post(a,'guild','guild_marketing','先送',{key:early});assert.equal(first.status,201);
  const sameKey=randomUUID(),dupes=await Promise.all(Array.from({length:4},()=>post(a,'squad',s,'同一鍵',{key:sameKey})));
  assert.deepEqual(new Set(dupes.map(r=>r.status)),new Set([201]));assert.equal(new Set(dupes.map(r=>r.data.message_id)).size,1);
  const burst=await Promise.all(Array.from({length:24},(_,i)=>i%2?post(a,'guild','guild_marketing',`g${i}`):post(a,'squad',s,`s${i}`)));
  const ok=burst.filter(r=>r.status===201),limited=burst.filter(r=>r.status===429);
  assert.equal(ok.length,CHANNEL_MESSAGE_RATE_LIMIT-2);assert.equal(limited.length,24-ok.length);
  for(const r of limited)assert.equal(r.data.code,'message_rate_limited');
  assert.equal(await count('member_channel_messages'),CHANNEL_MESSAGE_RATE_LIMIT);
  for(const kind of ['guild','squad']){
    const rows=(await pool.query('SELECT sequence::int AS n FROM member_channel_messages WHERE kind=$1 ORDER BY sequence',[kind])).rows.map(r=>r.n);
    assert.deepEqual(rows,rows.map((_,i)=>i+1),`${kind} sequences are gap-free and unique`);
    assert.equal((await pool.query('SELECT last_sequence::int AS n FROM member_chat_channels WHERE kind=$1',[kind])).rows[0].n,rows.length);
  }
  assert.deepEqual(await post(a,'guild','guild_marketing','先送',{key:early}),first,'a replay is not blocked by the budget');
  await pool.query("UPDATE member_channel_messages SET created_at=created_at-interval '61 seconds'");
  assert.equal((await post(a,'squad',s,'窗口過後')).status,201);
});

test('any active member may use the room; guild keys keep case and custom guilds need an approval in the viewer community',async()=>{
  const [a,b,c]=await signInAll(),other=randomUUID(),outsider=await extraMember('outside',other);
  const upper=await customGuild('ABCDEF0123456789ABCDEF0123456789','合成大寫公會',DEMO_COMMUNITY);
  const elsewhere=await customGuild('0123456789abcdef0123456789abcdef','合成他社群公會',other);
  await joinGuild(A,upper);await joinGuild(B,upper);await joinGuild(A,elsewhere);await joinGuild(C,'guild_marketing');
  const list=await request('/me/channels?kind=guild',a);
  assert.deepEqual(list.data.items.map((i:any)=>[i.channel_key,i.name]),[[upper,'合成大寫公會']],'custom guild without an approval here is not a room');
  const sent=await post(a,'guild',upper,'大寫鍵');assert.equal(sent.status,201,JSON.stringify(sent.data));assert.equal(sent.data.channel_key,upper);
  assert.equal((await messages(b,'guild',upper)).data.unread_count,1,'a plain member without office sees the room');
  for(const [session,kind,key] of [[a,'guild',upper.toLowerCase()],[a,'guild',elsewhere],[b,'guild','guild_marketing'],[c,'guild',upper],[a,'squad',randomUUID()]] as const){
    for(const res of [await messages(session,kind,key),await post(session,kind,key,'x'),await read(session,kind,key,sent.data.message_id)]){
      assert.equal(res.status,404,`${kind}/${key}`);assert.equal(res.data.code,'channel_not_available');
    }
  }
  const foreignSquad=await squad(outsider.id,[],'他社群小隊',other);await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[foreignSquad,A]);
  assert.equal((await messages(a,'squad',foreignSquad)).data.code,'channel_not_available');
  for(const [kind,key] of [['dm','guild_marketing'],['guild','Guild_Marketing'],['guild','guild_custom_12'],['squad','not-a-uuid'],['guild','x'.repeat(101)]])
    assert.equal((await messages(a,kind,key)).status,422,`${kind}/${key}`);
  assert.equal((await request('/me/channels?kind=guild')).status,401);
  const incomplete=await extraMember('onboarding',DEMO_COMMUNITY,{ready:false}),pending=await signIn(incomplete.email);
  assert.equal((await request('/me/channels?kind=guild',pending)).data.code,'onboarding_required');
  // Direct service calls never trust a stale Actor.
  const actor=(await login(pool,DEMO_USERS[0].email,DEMO_PASSWORD)).actor;
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actor.session_hash]);
  const cmd=(body:unknown):Command=>({actor,operation:'test',key:randomUUID(),body});
  for(const call of [()=>listChannels(pool,actor,{kind:'guild'}),()=>channelMessages(pool,actor,'guild',upper,{}),
    ()=>sendChannelMessage(pool,cmd({body:'x'}),'guild',upper),()=>markChannelRead(pool,cmd({through_message_id:sent.data.message_id}),'guild',upper)])
    await assert.rejects(call,(error:unknown)=>error instanceof Problem&&error.status===401&&error.code==='session_expired');
});

test('members read full history from their first join; leaving revokes access but keeps the cursor for rejoining',async()=>{
  const [a,b]=await signInAll();const s=await squad(B);
  const m1=(await post(b,'squad',s,'加入前一')).data;await post(b,'squad',s,'加入前二');
  await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[s,A]);
  const joined=await messages(a,'squad',s);assert.deepEqual(joined.data.items.map((m:any)=>m.body),['加入前二','加入前一']);assert.equal(joined.data.unread_count,2);
  assert.equal((await read(a,'squad',s,m1.message_id)).data.read_sequence,'1');
  const earlyKey=randomUUID();assert.equal((await post(a,'squad',s,'離開前',{key:earlyKey})).status,201);
  // Real leave through the squads API.
  const left=await request(`/squads/${s}/leave`,a,{},{ifMatch:'"1"'});assert.equal(left.status,200,JSON.stringify(left.data));
  assert.deepEqual((await request('/me/channels?kind=squad',a)).data,{items:[],unread_count:0,next_offset:null});
  for(const res of [await messages(a,'squad',s),await post(a,'squad',s,'離開後'),await read(a,'squad',s,m1.message_id),await post(a,'squad',s,'離開前',{key:earlyKey})])
    assert.equal(res.data.code,'channel_not_available','no read, write or receipt replay after leaving');
  await post(b,'squad',s,'離開期間');
  assert.equal((await pool.query('SELECT last_read_sequence::int AS n FROM member_channel_reads WHERE user_id=$1',[A])).rows[0].n,1,'cursor is kept');
  await pool.query(`UPDATE member_squad_memberships SET state='active',aggregate_version=aggregate_version+1 WHERE squad_id=$1 AND user_id=$2`,[s,A]);
  const back=await messages(a,'squad',s);
  assert.deepEqual(back.data.items.map((m:any)=>m.body),['離開期間','離開前','加入前二','加入前一']);
  assert.equal(back.data.unread_count,2,'resumes from the prior cursor; own message is not unread');
  assert.equal((await request('/me/channels?kind=squad',a)).data.unread_count,2);
});
