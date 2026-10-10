import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import type {Message,MessagePage,ConversationPage,ConversationActivity} from '../../modules/member-communications/types.js';
import type {ChannelMessage,ChannelMessagePage,ChannelActivity} from '../../modules/member-communications/channel-types.js';
import type {MessageSearchPage} from '../../modules/member-communications/message-search.js';

// #398: senders retract their own direct and channel messages. In-process requests,
// synthetic demo members and a disposable PostgreSQL schema only.
const origin='http://127.0.0.1:4312',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_message_retraction_${process.pid}_${Date.now()}`,database=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user_id:string};
type Retraction={message_id:string;retracted_at:string};
type Problem={code?:string};
const [A,B]=DEMO_USERS.map(user=>user.user_id);
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});

async function request<T=Problem>(path:string,session:Session,body?:unknown,key=randomUUID()){
  const headers:Record<string,string>={Origin:origin,Cookie:session.cookie,'X-CSRF-Token':session.csrf};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as T};
}
async function signIn(email:string):Promise<Session>{
  const response=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email,password:DEMO_PASSWORD})});
  const data=await response.json() as {csrf_token:string;user:{user_id:string}};assert.equal(response.status,200);
  return {cookie:response.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token,user_id:data.user.user_id};
}
async function send(from:Session,to:string,body:Record<string,unknown>):Promise<Message>{
  const result=await request<Message>(`/me/conversations/${to}/messages`,from,body);assert.equal(result.status,201,JSON.stringify(result.data));return result.data;
}

test('the sender retracts a direct message: both sides see a body-free placeholder, unread drops and search no longer finds it',async()=>{
  const a=await signIn(DEMO_USERS[0].email),b=await signIn(DEMO_USERS[1].email);
  const keep=await send(a,B,{body:'合成：保留的訊息'});
  const secret=await send(a,B,{body:'合成：不小心貼上的電話 0912'});
  const reply=await send(b,A,{body:'合成：收到',reply_to_message_id:secret.message_id});
  assert.equal((await request<MessagePage>(`/me/conversations/${A}/messages`,b)).data.unread_count,2);

  const key=randomUUID();
  const done=await request<Retraction>(`/me/conversations/${B}/messages/${secret.message_id.toUpperCase()}/retract`,a,{},key);
  assert.equal(done.status,200,JSON.stringify(done.data));
  assert.equal(done.data.message_id,secret.message_id);
  const replay=await request<Retraction>(`/me/conversations/${B}/messages/${secret.message_id}/retract`,a,{},key);
  assert.deepEqual(replay.data,done.data);
  const again=await request<Retraction>(`/me/conversations/${B}/messages/${secret.message_id}/retract`,a,{});
  assert.equal(again.status,200);assert.equal(again.data.retracted_at,done.data.retracted_at);

  for(const [viewer,peer] of [[a,B],[b,A]] as const){
    const page=await request<MessagePage>(`/me/conversations/${peer}/messages`,viewer);
    const row=page.data.items.find(item=>item.message_id===secret.message_id)!;
    assert.equal(row.body,'');assert.equal(row.retracted_at,done.data.retracted_at);
    assert.equal(row.sticker,undefined);assert.equal(row.reply_to,undefined);assert.equal(row.image,undefined);
    assert.equal(JSON.stringify(page.data).includes('0912'),false);
    // A quote of the retracted message disappears from the reply as well.
    assert.equal(page.data.items.find(item=>item.message_id===reply.message_id)!.reply_to,undefined);
    assert.equal(page.data.items.find(item=>item.message_id===keep.message_id)!.body,'合成：保留的訊息');
  }
  const inbox=await request<MessagePage>(`/me/conversations/${A}/messages`,b);
  assert.equal(inbox.data.unread_count,1);
  assert.equal((await request<ConversationPage>('/me/conversations',b)).data.unread_count,1);
  assert.equal((await request<ConversationActivity>(`/me/conversations/${A}/activity`,b)).data.unread_count,1);
  const search=await request<MessageSearchPage<Message>>(`/me/conversations/${A}/messages/search?q=0912`,b);
  assert.equal(search.status,200);assert.equal(search.data.items.length,0);
  // The audit trail keeps the row and only the stamp changes.
  assert.equal((await pool.query('SELECT body FROM member_direct_messages WHERE message_id=$1',[secret.message_id])).rows[0].body,'合成：不小心貼上的電話 0912');
});

test('only the sender can retract; strangers and malformed ids get no hint about the message',async()=>{
  const a=await signIn(DEMO_USERS[0].email),b=await signIn(DEMO_USERS[1].email),c=await signIn(DEMO_USERS[2].email);
  const sent=await send(a,B,{body:'合成：只能本人收回'});
  const recipient=await request(`/me/conversations/${A}/messages/${sent.message_id}/retract`,b,{});
  assert.equal(recipient.status,403);assert.equal(recipient.data.code,'message_not_own');
  const stranger=await request(`/me/conversations/${A}/messages/${sent.message_id}/retract`,c,{});
  assert.equal(stranger.status,404);
  assert.equal((await request(`/me/conversations/${B}/messages/not-a-uuid/retract`,a,{})).status,404);
  assert.equal((await request(`/me/conversations/${B}/messages/${randomUUID()}/retract`,a,{})).status,404);
  assert.equal((await request(`/me/conversations/${B}/messages/${sent.message_id}/retract`,a,{reason:'x'})).status,422);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_direct_messages WHERE retracted_at IS NOT NULL')).rows[0].n,0);
});

test('a sender retracts a world channel message; members see the placeholder, unread and search follow, others cannot retract it',async()=>{
  const a=await signIn(DEMO_USERS[0].email),b=await signIn(DEMO_USERS[1].email);
  const posted=await request<ChannelMessage>('/me/channels/world/world/messages',a,{body:'合成：世界頻道誤貼 secret-word'});
  assert.equal(posted.status,201,JSON.stringify(posted.data));
  await request<ChannelMessage>('/me/channels/world/world/messages',a,{body:'合成：第二則'});
  assert.equal((await request<ChannelActivity>('/me/channels/world/world/activity',b)).data.unread_count,2);
  const other=await request('/me/channels/world/world/messages/'+posted.data.message_id+'/retract',b,{});
  assert.equal(other.status,403);assert.equal(other.data.code,'message_not_own');
  const done=await request<Retraction>('/me/channels/world/world/messages/'+posted.data.message_id+'/retract',a,{});
  assert.equal(done.status,200,JSON.stringify(done.data));
  const page=await request<ChannelMessagePage>('/me/channels/world/world/messages',b);
  const row=page.data.items.find(item=>item.message_id===posted.data.message_id)!;
  assert.equal(row.body,'');assert.equal(row.retracted_at,done.data.retracted_at);
  assert.equal(JSON.stringify(page.data).includes('secret-word'),false);
  assert.equal(page.data.unread_count,1);
  assert.equal((await request<MessageSearchPage<ChannelMessage>>('/me/channels/world/world/messages/search?q=secret-word',b)).data.items.length,0);
  assert.equal((await request('/me/channels/world/world/messages/'+randomUUID()+'/retract',a,{})).status,404);
});


test('read-message retractions change body-free activity without changing message order or unread counts',async()=>{
 const a=await signIn(DEMO_USERS[0].email),b=await signIn(DEMO_USERS[1].email);
 for(const channel of [false,true]){
  const own=channel?'/me/channels/world/world':`/me/conversations/${B}`;
  const other=channel?own:`/me/conversations/${A}`;
  const first=await request<Message&ChannelMessage>(own+'/messages',a,{body:'old private body'});assert.equal(first.status,201);
  const last=await request<Message&ChannelMessage>(own+'/messages',a,{body:'newer message'});assert.equal(last.status,201);
  const read=await request(other+'/read',b,channel?{through_message_id:last.data.message_id}:{through_message_id:last.data.message_id});assert.equal(read.status,200,JSON.stringify(read.data));
  const before=await request<Record<string,unknown>>(other+'/activity',b);assert.equal(before.data.retraction_count,'0');assert.equal(before.data.unread_count,0);
  assert.equal((await request(own+'/messages/'+first.data.message_id+'/retract',a,{})).status,200);
  const after=await request<Record<string,unknown>>(other+'/activity',b);
  assert.deepEqual(after.data,{...before.data,retraction_count:'1'});
  assert.equal((await request(own+'/messages/'+first.data.message_id+'/retract',a,{})).status,200);
  assert.deepEqual((await request(other+'/activity',b)).data,after.data,'a repeated retraction cannot invent another change');
  assert.equal((await request<MessagePage>(other+'/messages',b)).data.retraction_count,'1');
 }
});

test('committed reply replay after retraction preserves its exact target acknowledgement but no quote content',async()=>{
 const {matchesDirectMessageAck,matchesChannelMessageAck}=await import('../../apps/portal-web/src/modules/message-image-client.js');
 const a=await signIn(DEMO_USERS[0].email),b=await signIn(DEMO_USERS[1].email);
 for(const channel of [false,true]){
  const own=channel?'/me/channels/world/world':`/me/conversations/${B}`;
  const other=channel?own:`/me/conversations/${A}`;
  const original=await request<Message&ChannelMessage>(own+'/messages',a,{body:'private quote never returns again'});assert.equal(original.status,201);
  const body={body:'my own reply',reply_to_message_id:original.data.message_id},key=randomUUID();
  const committed=await request<Message&ChannelMessage>(other+'/messages',b,body,key);assert.equal(committed.status,201);
  assert.equal((await request(own+'/messages/'+original.data.message_id+'/retract',a,{})).status,200);
  const replay=await request<Message&ChannelMessage>(other+'/messages',b,body,key);assert.equal(replay.status,201);
  assert.equal(replay.data.message_id,committed.data.message_id);assert.equal(replay.data.reply_to,undefined);
  assert.equal(replay.data.reply_to_message_id,original.data.message_id);assert.ok(!JSON.stringify(replay.data).includes('private quote'));
  assert.equal(channel?matchesChannelMessageAck(replay.data,{sender:B,kind:'world',channelKey:'world',payload:body}):matchesDirectMessageAck(replay.data,{sender:B,recipient:A,payload:body}),true);
  const fresh=await request<Message&ChannelMessage>(other+'/messages',b,body);assert.equal(fresh.status,201);assert.equal(fresh.data.reply_to_message_id,original.data.message_id,'an already-composed reply has the same explicit ACK');
 }
});
