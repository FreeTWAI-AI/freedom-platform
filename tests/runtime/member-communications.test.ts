import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,transaction,type Command} from '../../packages/db/index.js';
import {Problem} from '../../packages/shared/problem.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {notifyMember,type NotifyMemberInput} from '../../modules/member-communications/notifications.js';
import {
  listNotifications,markNotificationRead,listConversations,conversationMessages,sendDirectMessage,markConversationRead,
} from '../../modules/member-communications/service.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_member_comms_${process.pid}_${Date.now()}`,database=createPool(databaseUrl);
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
const notice=(recipient:string,overrides:Partial<NotifyMemberInput>={}):NotifyMemberInput=>({community_id:DEMO_COMMUNITY,recipient_ref:recipient,kind:'friend_request',source_key:`test/${randomUUID()}`,title:'合成通知',body:'合成內容',action:{tab:'members',resource_id:B},...overrides});
const notify=(input:NotifyMemberInput)=>transaction(pool,q=>notifyMember(q,input));
const count=async(sql:string,values:unknown[]=[])=>(await pool.query(`SELECT count(*)::int AS n FROM ${sql}`,values)).rows[0].n as number;
const noPrivate=(data:unknown)=>{const text=JSON.stringify(data);for(const needle of ['@local.test','@example.invalid','password','csrf','token_hash','email'])assert.ok(!text.includes(needle),`leaked ${needle}: ${text}`);};

test('notification inbox pages newest first with stable ties, counts unread across pages and GET never marks read',async()=>{
  const [a,b]=await signInAll();
  const ids:string[]=[];for(let i=0;i<5;i++)ids.push((await notify(notice(A,{title:`通知 ${i}`})))!.notification_id);
  await notify(notice(B));
  await pool.query("UPDATE member_notifications SET created_at=timestamptz '2026-09-01T00:00:00Z'+make_interval(mins=>$2) WHERE notification_id=ANY($1)",[ids.slice(0,3),0]);
  await pool.query("UPDATE member_notifications SET created_at=timestamptz '2026-09-02T00:00:00Z' WHERE notification_id=ANY($1)",[ids.slice(3)]);
  const first=await request('/me/notifications?limit=2',a),second=await request('/me/notifications?limit=2&offset=2',a),third=await request('/me/notifications?limit=2&offset=4',a);
  for(const page of [first,second,third]){assert.equal(page.status,200,JSON.stringify(page.data));assert.equal(page.data.unread_count,5);assert.deepEqual(Object.keys(page.data).sort(),['items','next_offset','unread_count']);}
  assert.equal(first.data.next_offset,2);assert.equal(second.data.next_offset,4);assert.equal(third.data.next_offset,null);
  const all=[...first.data.items,...second.data.items,...third.data.items],expected=[...[ids[3],ids[4]].sort().reverse(),...ids.slice(0,3).sort().reverse()];
  assert.deepEqual(all.map((n:any)=>n.notification_id),expected);
  const item=all[0];assert.deepEqual(Object.keys(item).sort(),['action','body','created_at','kind','notification_id','read_at','title']);
  assert.equal(item.created_at,'2026-09-02T00:00:00.000Z');assert.equal(item.read_at,null);assert.deepEqual(item.action,{tab:'members',resource_id:B});
  assert.equal(await count("member_notifications WHERE read_at IS NOT NULL"),0);
  assert.equal((await request('/me/notifications',b)).data.items.length,1);noPrivate(first.data);
  for(const query of ['limit=0','limit=51','offset=-1','offset=10001','limit=abc','unknown=1']){const bad=await request(`/me/notifications?${query}`,a);assert.equal(bad.status,422,query);}
  const incomplete=await extraMember('onboarding',DEMO_COMMUNITY,{ready:false}),pending=await signIn(incomplete.email);
  assert.equal((await request('/me/notifications',pending)).data.code,'onboarding_required');
});

test('marking a notification read is own-recipient only, idempotent, replay-safe and needs CSRF plus Idempotency-Key',async()=>{
  const [a,b]=await signInAll();
  const own=(await notify(notice(A)))!.notification_id,other=(await notify(notice(A)))!.notification_id,foreign=(await notify(notice(B)))!.notification_id;
  const key=randomUUID(),path=`/me/notifications/${own}/read`;
  assert.equal((await request(path,a,{},{key:''})).data.code,'idempotency_required');
  assert.equal((await request(path,a,{},{csrf:'x'.repeat(43)})).data.code,'csrf_rejected');
  assert.equal((await request(path,a,{extra:true})).status,422);assert.equal(await count('member_notifications WHERE read_at IS NOT NULL'),0);
  const first=await request(path,a,{},{key});assert.equal(first.status,200,JSON.stringify(first.data));
  assert.deepEqual(Object.keys(first.data).sort(),['notification_id','read_at']);assert.equal(first.data.notification_id,own);assert.match(first.data.read_at,/Z$/);
  assert.deepEqual((await request(path,a,{},{key})).data,first.data);
  assert.equal((await request(path,a,{},{key,ifMatch:'"3"'})).data.code,'idempotency_conflict');
  assert.equal((await request(path,a,{})).data.read_at,first.data.read_at);
  assert.equal((await request(`/me/notifications/${own.toUpperCase()}/read`,a,{})).data.read_at,first.data.read_at);
  // Another member's or an unknown notification is indistinguishable and untouched.
  assert.equal((await request(`/me/notifications/${foreign}/read`,a,{})).status,404);assert.equal((await request(`/me/notifications/${randomUUID()}/read`,a,{})).status,404);
  assert.equal((await request('/me/notifications/not-a-uuid/read',a,{})).status,422);
  assert.equal((await pool.query('SELECT read_at FROM member_notifications WHERE notification_id=$1',[foreign])).rows[0].read_at,null);
  const list=await request('/me/notifications',a);assert.equal(list.data.unread_count,1);assert.equal(list.data.items.find((n:any)=>n.notification_id===other).read_at,null);
  assert.equal((await request('/me/notifications',b)).data.unread_count,1);
});

test('notifyMember rejects arbitrary actions, extra fields and cross-community recipients, and deduplicates by source key',async()=>{
  const outsider=await extraMember('outside',randomUUID());
  const bad:Partial<NotifyMemberInput>[]=[
    {action:{tab:'members',resource_id:'https://example.invalid/phish'}},
    {action:{tab:'guilds',resource_id:'javascript:alert(1)'}},
    {action:{tab:'external',resource_id:null} as any},
    {action:{tab:'members',resource_id:null,href:'/x'} as any},
    {extra:'field'} as any,
    {kind:'direct_message' as any},{title:'  '},{body:'x'.repeat(2001)},{source_key:''},
  ];
  for(const overrides of bad)await assert.rejects(notify(notice(A,overrides)),/notification_input_invalid/,JSON.stringify(overrides));
  await assert.rejects(notify(notice(outsider.id)),/notification_recipient_outside_community/);
  await assert.rejects(notify(notice(randomUUID())),/notification_recipient_outside_community/);
  assert.equal(await count('member_notifications'),0);
  const source='dedup/one',first=await notify(notice(A,{source_key:source})),again=await notify(notice(A,{source_key:source,title:'不同標題'}));
  assert.ok(first);assert.equal(again,null);assert.equal(await count('member_notifications WHERE source_key=$1',[source]),1);
  assert.ok(await notify(notice(B,{source_key:source})),'same source key for another recipient is separate');
  assert.ok(await notify(notice(A,{action:{tab:'guilds',resource_id:'guild_custom_'+'Ab'.repeat(16)}})));
  assert.ok(await notify(notice(A,{action:null})));
});

test('direct messages: compose with a ready member, trimmed plain text, idempotent 201 and strict validation',async()=>{
  const [a,b]=await signInAll(),path=`/me/conversations/${B}/messages`;
  const empty=await request(path,a);assert.equal(empty.status,200,JSON.stringify(empty.data));
  assert.deepEqual(empty.data,{participant:{user_id:B,display_name:DEMO_USERS[1].display_name,avatar_url:null},can_send:true,items:[],next_offset:null,unread_count:0});
  const key=randomUUID(),text='  <b>你好</b> [連結](https://example.invalid)\r\n第二行  ';
  const sent=await request(path,a,{body:text},{key});assert.equal(sent.status,201,JSON.stringify(sent.data));
  assert.deepEqual(Object.keys(sent.data).sort(),['body','created_at','message_id','read_at','recipient_ref','sender_ref']);
  assert.equal(sent.data.body,'<b>你好</b> [連結](https://example.invalid)\n第二行');assert.equal(sent.data.sender_ref,A);assert.equal(sent.data.recipient_ref,B);assert.equal(sent.data.read_at,null);
  const replay=await request(path,a,{body:text},{key});assert.equal(replay.status,201);assert.deepEqual(replay.data,sent.data);
  assert.equal((await request(path,a,{body:'不同內容'},{key})).data.code,'idempotency_conflict');
  assert.equal(await count('member_direct_messages'),1);
  // The receipt stores only the id: message text never enters command receipts or journals.
  assert.equal(await count("command_receipts WHERE response::text LIKE '%你好%'"),0);assert.equal(await count("transition_journal WHERE data::text LIKE '%你好%'"),0);
  assert.equal(await count('member_notifications'),0,'direct messages do not create notifications');
  for(const body of [{body:''},{body:'  \n '},{body:'字'.repeat(2001)},{body:'a\u0000b'},{body:42},{},{body:'hi',sender_ref:B},{body:'hi',recipient_ref:C}]){
    const rejected=await request(path,a,body);assert.equal(rejected.status,422,JSON.stringify(body));
  }
  assert.equal((await request(path,a,{body:'字'.repeat(2000)})).status,201);assert.equal((await request(path,a,{body:'😀'.repeat(2000)})).status,201);
  assert.equal((await request(path,a,{body:'no csrf'},{csrf:'y'.repeat(43)})).data.code,'csrf_rejected');
  assert.equal((await request(path,a,{body:'no key'},{key:''})).data.code,'idempotency_required');
  assert.equal((await request(`/me/conversations/${A}/messages`,a,{body:'self'})).data.code,'self_conversation');
  assert.equal((await request(`/me/conversations/${A}/messages`,a)).data.code,'self_conversation');
  assert.equal((await request('/me/conversations/nope/messages',a)).status,422);
  assert.equal((await request(`${path}?limit=51`,a)).status,422);assert.equal((await request(`${path}?before=x`,a)).status,422);
  assert.equal(await count('member_direct_messages'),3);
  const inbox=await request('/me/conversations',b);assert.equal(inbox.data.unread_count,3);noPrivate(inbox.data);
});

test('direct messages reject unauthenticated, cross-community, unready and disabled members without history',async()=>{
  const [a]=await signInAll();
  const outsider=await extraMember('outside',randomUUID()),unready=await extraMember('unready',DEMO_COMMUNITY,{ready:false}),disabled=await extraMember('disabled');
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[disabled.id]);
  for(const id of [outsider.id,unready.id,disabled.id,randomUUID()]){
    assert.equal((await request(`/me/conversations/${id}/messages`,a)).status,404,id);
    assert.equal((await request(`/me/conversations/${id}/messages`,a,{body:'hello'})).status,404,id);
    assert.equal((await request(`/me/conversations/${id}/read`,a,{})).status,404,id);
  }
  const anonymous=await app.request(origin+`/api/v1/me/conversations/${B}/messages`,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID()},body:JSON.stringify({body:'hi'})});
  assert.equal(anonymous.status,401);
  const unreadySender=await signIn(unready.email);assert.equal((await request(`/me/conversations/${B}/messages`,unreadySender,{body:'hi'})).data.code,'onboarding_required');
  // A session for a since-disabled sender is rejected before any write.
  const suspended=await extraMember('suspended'),session=await signIn(suspended.email);await pool.query('UPDATE users SET active=false WHERE user_id=$1',[suspended.id]);
  assert.equal((await request(`/me/conversations/${B}/messages`,session,{body:'hi'})).status,401);
  assert.equal(await count('member_direct_messages'),0);
});

test('conversations show only own pairs sorted by latest message, with per-pair and total unread counts and read marking',async()=>{
  const [a,b,c]=await signInAll();
  const send=(from:Session,to:string,body:string)=>request(`/me/conversations/${to}/messages`,from,{body}).then(r=>{assert.equal(r.status,201,JSON.stringify(r.data));return r.data;});
  await send(a,B,'A1');await send(a,B,'A2');await send(c,B,'C1');await send(b,A,'B1');
  const ofB=await request('/me/conversations',b);assert.equal(ofB.data.unread_count,3);
  assert.deepEqual(ofB.data.items.map((i:any)=>[i.participant.user_id,i.last_message.body,i.unread_count,i.can_send]),[[A,'B1',2,true],[C,'C1',1,true]]);
  assert.deepEqual(Object.keys(ofB.data.items[0]).sort(),['can_send','last_message','participant','unread_count']);
  const ofA=await request('/me/conversations',a);assert.equal(ofA.data.unread_count,1);assert.deepEqual(ofA.data.items.map((i:any)=>i.participant.user_id),[B]);
  assert.ok(!JSON.stringify(ofA.data).includes('C1'));noPrivate(ofA.data);
  // A has no history with C: the thread is empty, never another pair's messages.
  const aWithC=await request(`/me/conversations/${C}/messages`,a);assert.deepEqual(aWithC.data.items,[]);assert.equal(aWithC.data.unread_count,0);
  const thread=await request(`/me/conversations/${A}/messages`,b);assert.deepEqual(thread.data.items.map((m:any)=>m.body),['B1','A2','A1']);assert.equal(thread.data.unread_count,2);
  assert.equal((await request('/me/conversations',b)).data.unread_count,3,'GET does not mark read');
  const key=randomUUID(),read=await request(`/me/conversations/${A}/read`,b,{},{key});assert.equal(read.status,200,JSON.stringify(read.data));
  assert.deepEqual(Object.keys(read.data).sort(),['read_at','updated_count','user_id']);assert.equal(read.data.user_id,A);assert.equal(read.data.updated_count,2);
  assert.deepEqual((await request(`/me/conversations/${A}/read`,b,{},{key})).data,read.data);
  assert.equal((await request(`/me/conversations/${A}/read`,b,{})).data.updated_count,0);
  assert.equal((await request(`/me/conversations/${A}/read`,b,{nope:1})).status,422);
  const after=await request('/me/conversations',b);assert.equal(after.data.unread_count,1);assert.deepEqual(after.data.items.map((i:any)=>i.unread_count),[0,1]);
  // Marking is directional: B's message to A stays unread for A; A sees its own sent messages as read by B.
  const aThread=await request(`/me/conversations/${B}/messages`,a);assert.equal(aThread.data.unread_count,1);
  assert.deepEqual(aThread.data.items.map((m:any)=>[m.body,m.read_at===null]),[['B1',true],['A2',false],['A1',false]]);
  assert.equal((await request(`/me/conversations/${C}/read`,a,{})).data.updated_count,0);
  assert.equal((await pool.query("SELECT read_at FROM member_direct_messages WHERE body='C1'")).rows[0].read_at,null);
});

test('message and conversation pages are stable and counts stay constant across pages',async()=>{
  const [a,b,c]=await signInAll();const extra=await extraMember('peer'),d=await signIn(extra.email);
  for(let i=0;i<5;i++)assert.equal((await request(`/me/conversations/${B}/messages`,a,{body:`m${i}`})).status,201);
  await request(`/me/conversations/${B}/messages`,c,{body:'from c'});await request(`/me/conversations/${B}/messages`,d,{body:'from d'});
  const pages=[];for(let offset=0;offset!==null;){const page=await request(`/me/conversations/${A}/messages?limit=2&offset=${offset}`,b);assert.equal(page.data.unread_count,5);pages.push(page.data);offset=page.data.next_offset;}
  assert.equal(pages.length,3);assert.deepEqual(pages.flatMap(p=>p.items.map((m:any)=>m.body)),['m4','m3','m2','m1','m0']);
  const first=await request('/me/conversations?limit=2',b),second=await request('/me/conversations?limit=2&offset=2',b);
  assert.equal(first.data.next_offset,2);assert.equal(second.data.next_offset,null);assert.equal(first.data.unread_count,7);assert.equal(second.data.unread_count,7);
  assert.deepEqual([...first.data.items,...second.data.items].map((i:any)=>i.participant.user_id),[extra.id,C,A]);
  assert.equal((await request('/me/conversations?offset=10001',b)).status,422);
});

test('history with a now disabled or unready peer stays readable but cannot send',async()=>{
  const [a,b]=await signInAll();
  await request(`/me/conversations/${B}/messages`,a,{body:'before'});await request(`/me/conversations/${A}/messages`,b,{body:'reply'});
  await pool.query('INSERT INTO member_avatars(user_id,community_id,image_bytes) VALUES($1,$2,$3)',[B,DEMO_COMMUNITY,Buffer.from('synthetic')]);
  assert.match((await request('/me/conversations',a)).data.items[0].participant.avatar_url,new RegExp(`^/api/v1/members/${B}/avatar\\?v=`));
  for(const change of ['UPDATE users SET active=false WHERE user_id=$1','UPDATE users SET active=true,onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1']){
    await pool.query(change,[B]);
    const list=await request('/me/conversations',a);assert.equal(list.data.items[0].can_send,false);assert.equal(list.data.items[0].participant.avatar_url,null);
    const thread=await request(`/me/conversations/${B}/messages`,a);assert.equal(thread.status,200);assert.equal(thread.data.can_send,false);assert.equal(thread.data.items.length,2);
    assert.equal((await request(`/me/conversations/${B}/messages`,a,{body:'after'})).data.code,'recipient_unavailable');
    const read=await request(`/me/conversations/${B}/read`,a,{});assert.equal(read.status,200);
  }
  assert.equal(await count('member_direct_messages'),2);
});

test('per-sender rate limit holds under concurrency and replays are neither counted nor blocked',async()=>{
  const [a,b]=await signInAll(),path=`/me/conversations/${B}/messages`,firstKey=randomUUID();
  const first=await request(path,a,{body:'first'},{key:firstKey});assert.equal(first.status,201);
  const results=await Promise.all(Array.from({length:24},(_,i)=>request(path,a,{body:`burst ${i}`})));
  assert.equal(results.filter(r=>r.status===201).length,19);assert.equal(results.filter(r=>r.status===429).length,5);
  assert.ok(results.filter(r=>r.status===429).every(r=>r.data.code==='message_rate_limited'));
  assert.equal(await count('member_direct_messages WHERE sender_ref=$1',[A]),20);
  const replay=await request(path,a,{body:'first'},{key:firstKey});assert.equal(replay.status,201);assert.deepEqual(replay.data,first.data);
  assert.equal((await request(path,a,{body:'over'})).status,429);
  // Budgets are per sender, and reciprocal concurrent sends do not deadlock.
  const both=await Promise.all([request(`/me/conversations/${A}/messages`,b,{body:'reply'}),request(path,a,{body:'still limited'})]);
  assert.deepEqual(both.map(r=>r.status),[201,429]);
  await pool.query("UPDATE member_direct_messages SET created_at=created_at-interval '61 seconds' WHERE sender_ref=$1",[A]);
  assert.equal((await request(path,a,{body:'window passed'})).status,201);
});

test('reciprocal concurrent sends between two members all succeed',async()=>{
  const [a,b]=await signInAll();
  const results=await Promise.all(Array.from({length:10},(_,i)=>i%2?request(`/me/conversations/${A}/messages`,b,{body:`b${i}`}):request(`/me/conversations/${B}/messages`,a,{body:`a${i}`})));
  assert.ok(results.every(r=>r.status===201),JSON.stringify(results.map(r=>r.data)));
  assert.equal((await request(`/me/conversations/${B}/messages?limit=50`,a)).data.items.length,10);
});

// ---------- service-layer authority: a captured Actor is never trusted ----------
const actorOf=async(email:string)=>(await login(pool,email,DEMO_PASSWORD)).actor;
const cmd=(actor:Actor,operation:string,body:unknown={},key:string=randomUUID()):Command=>({actor,operation,key,body});
const privateReads=(actor:Actor)=>({
  listNotifications:()=>listNotifications(pool,actor,{}),
  listConversations:()=>listConversations(pool,actor,{}),
  conversationMessages:()=>conversationMessages(pool,actor,B,{}),
});
async function rejectsWith(run:()=>Promise<unknown>,status:number,code:string,label:string){
  let resolved=false;
  try{await run();resolved=true;}
  catch(error){assert.ok(error instanceof Problem,`${label}: expected Problem, got ${(error as any)?.code??error}`);assert.deepEqual([error.status,error.code],[status,code],label);}
  assert.ok(!resolved,`${label}: resolved (disclosed data) instead of ${status} ${code}`);
}
const setReady=(id:string,ready:boolean)=>pool.query('UPDATE users SET onboarding_required=$2,onboarding_completed_at=CASE WHEN $2 THEN NULL ELSE onboarding_completed_at END WHERE user_id=$1',[id,!ready]);

test('direct service reads and read marks recheck live account, session, community and onboarding instead of a captured Actor',async()=>{
  const email=DEMO_USERS[0].email,b=await actorOf(DEMO_USERS[1].email),outsideCommunity=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[outsideCommunity,'合成的其他社群']);
  const noticeId=(await notify(notice(A)))!.notification_id;
  let a=await actorOf(email);
  await sendDirectMessage(pool,cmd(a,'send',{body:'合成私訊'}),B);await sendDirectMessage(pool,cmd(b,'send',{body:'合成回覆'}),A);
  // A valid captured actor still reads everything.
  const live=privateReads(a);
  assert.equal((await live.listNotifications()).items.length,1);assert.equal((await live.listConversations()).items.length,1);assert.equal((await live.conversationMessages()).items.length,2);
  // Successful receipts that later replays must not return once the viewer is no longer eligible.
  const noticeKey=randomUUID(),threadKey=randomUUID();
  const noticeRead=await markNotificationRead(pool,cmd(a,'notice-read',{},noticeKey),noticeId),threadRead=await markConversationRead(pool,cmd(a,'thread-read',{},threadKey),B);
  assert.equal(threadRead.updated_count,1);
  const state=async()=>(await pool.query(`SELECT (SELECT count(*) FROM command_receipts)::int AS receipts,(SELECT count(*) FROM member_direct_messages WHERE read_at IS NULL)::int AS unread_dm,
    (SELECT count(*) FROM member_notifications WHERE read_at IS NULL)::int AS unread_notices`)).rows[0];
  const scenarios:{label:string;revoke:(actor:Actor)=>Promise<Actor>;status:number;code:string}[]=[
    {label:'revoked session',status:401,code:'session_expired',revoke:async actor=>{await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[actor.session_hash]);return actor;}},
    {label:'expired session',status:401,code:'session_expired',revoke:async actor=>{await pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",[actor.session_hash]);return actor;}},
    {label:'disabled viewer',status:401,code:'session_expired',revoke:async actor=>{await pool.query('UPDATE users SET active=false WHERE user_id=$1',[A]);return actor;}},
    {label:'foreign community actor',status:401,code:'session_expired',revoke:async actor=>({...actor,community_id:outsideCommunity})},
    {label:'onboarding reset',status:403,code:'onboarding_required',revoke:async actor=>{await setReady(A,false);return actor;}},
  ];
  for(const scenario of scenarios){
    a=await actorOf(email);const stale=await scenario.revoke(a),before=await state();
    for(const [name,run] of Object.entries(privateReads(stale)))await rejectsWith(run,scenario.status,scenario.code,`${scenario.label} ${name}`);
    await rejectsWith(()=>markNotificationRead(pool,cmd(stale,'notice-read'),noticeId),scenario.status,scenario.code,`${scenario.label} markNotificationRead`);
    await rejectsWith(()=>markConversationRead(pool,cmd(stale,'thread-read'),B),scenario.status,scenario.code,`${scenario.label} markConversationRead`);
    // Receipt replay rechecks current eligibility before returning the stored response.
    await rejectsWith(()=>markNotificationRead(pool,cmd(stale,'notice-read',{},noticeKey),noticeId),scenario.status,scenario.code,`${scenario.label} markNotificationRead replay`);
    await rejectsWith(()=>markConversationRead(pool,cmd(stale,'thread-read',{},threadKey),B),scenario.status,scenario.code,`${scenario.label} markConversationRead replay`);
    assert.deepEqual(await state(),before,`${scenario.label} wrote nothing`);
    await pool.query('UPDATE users SET active=true WHERE user_id=$1',[A]);await setReady(A,true);
  }
  // Restored eligibility replays the original receipts unchanged.
  a=await actorOf(email);
  assert.deepEqual(await markNotificationRead(pool,cmd(a,'notice-read',{},noticeKey),noticeId),noticeRead);
  assert.deepEqual(await markConversationRead(pool,cmd(a,'thread-read',{},threadKey),B),threadRead);
});

test('send receipt replay rechecks live sender and recipient eligibility',async()=>{
  const email=DEMO_USERS[0].email,key=randomUUID(),outsideCommunity=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[outsideCommunity,'合成的其他社群']);
  let a=await actorOf(email);const send=(actor:Actor)=>sendDirectMessage(pool,cmd(actor,'send',{body:'合成重送'},key),B);
  const sent=await send(a);
  await setReady(A,false);await rejectsWith(()=>send(a),403,'onboarding_required','sender onboarding reset');await setReady(A,true);
  await setReady(B,false);await rejectsWith(()=>send(a),409,'recipient_unavailable','recipient onboarding reset');await setReady(B,true);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[B]);await rejectsWith(()=>send(a),409,'recipient_unavailable','recipient disabled');await pool.query('UPDATE users SET active=true WHERE user_id=$1',[B]);
  await rejectsWith(()=>send({...a,community_id:outsideCommunity}),401,'session_expired','foreign community sender');
  await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[a.session_hash]);await rejectsWith(()=>send(a),401,'session_expired','revoked sender session');
  a=await actorOf(email);assert.deepEqual(await send(a),sent);assert.equal(await count('member_direct_messages'),1);
});

/** Resolves once `count` backends are waiting on the blocker's locks; fails if a read finishes without waiting. */
async function waitUntilBlocked(blockerPid:number,count:number,pending:Promise<unknown>[]){
  let settled=0;for(const p of pending)p.then(()=>settled++,()=>settled++);
  for(let i=0;i<1000;i++){
    const waiting=(await pool.query('SELECT count(*)::int AS n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[blockerPid])).rows[0].n;
    if(waiting>=count)return;
    assert.equal(settled,0,'a private read finished without waiting for the concurrent revocation');
    await new Promise(resolve=>setTimeout(resolve,5));
  }
  assert.fail('private reads never waited for the concurrent revocation');
}

test('private reads that wait behind a committing revocation retry on a fresh snapshot and disclose nothing',async()=>{
  await notify(notice(A));const b=await actorOf(DEMO_USERS[1].email);await sendDirectMessage(pool,cmd(b,'send',{body:'合成私訊'}),A);
  // Administration locks users before sessions; logout revokes the session row alone.
  const revocations:{label:string;steps:string[]}[]=[
    {label:'member disabled',steps:['UPDATE users SET active=false WHERE user_id=$1']},
    {label:'session revoked after locking the member',steps:['SELECT 1 FROM users WHERE user_id=$1 FOR UPDATE','UPDATE sessions SET revoked_at=now() WHERE user_id=$1']},
    {label:'session revoked alone',steps:['UPDATE sessions SET revoked_at=now() WHERE user_id=$1']},
    {label:'onboarding reset',steps:['UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1']},
  ];
  for(const revocation of revocations){
    const a=await actorOf(DEMO_USERS[0].email),blocker=await pool.connect();let pending:Promise<unknown>[]=[];
    try{
      const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
      await blocker.query('BEGIN');for(const step of revocation.steps)await blocker.query(step,[A]);
      pending=Object.values(privateReads(a)).map(run=>run());
      await waitUntilBlocked(pid,pending.length,pending);
      await blocker.query('COMMIT');
      const results=await Promise.allSettled(pending);
      const [status,code]=revocation.label==='onboarding reset'?[403,'onboarding_required']:[401,'session_expired'];
      for(const result of results){
        assert.equal(result.status,'rejected',`${revocation.label}: a stale read returned data`);
        const error=(result as PromiseRejectedResult).reason;
        assert.ok(error instanceof Problem,`${revocation.label}: raw ${error?.code} escaped`);assert.deepEqual([error.status,error.code],[status,code],revocation.label);
      }
    }finally{
      await blocker.query('ROLLBACK').catch(()=>{});blocker.release();await Promise.allSettled(pending);
      await pool.query('UPDATE users SET active=true WHERE user_id=$1',[A]);await setReady(A,true);
    }
  }
  const a=await actorOf(DEMO_USERS[0].email);assert.equal((await listConversations(pool,a,{})).items.length,1,'a fresh valid session reads again');
});
