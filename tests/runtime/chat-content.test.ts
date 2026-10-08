import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {CHAT_STICKERS,WORKSHOP_STICKERS} from '../../modules/member-communications/stickers.js';
import {FREETWAI_STICKERS} from '../../modules/member-communications/freetwai-stickers.js';
import {MessageContentInput} from '../../modules/member-communications/content.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_chat_content_${process.pid}_${Date.now()}`,database=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:8}),app=createApp(pool,origin);
const [A,B,C]=DEMO_USERS.map(user=>user.user_id),guild='guild_platform_engineering';
type Session={cookie:string;csrf:string};
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
  await pool.query('DELETE FROM positioning_profession_memberships WHERE user_id=$1 AND guild_key=$2',[C,guild]);
  for(const user of [A,B])await pool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state)
    VALUES($1,$2,$3,$4,'active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active'`,[randomUUID(),DEMO_COMMUNITY,user,guild]);});
async function sessions(){return Promise.all(DEMO_USERS.map(async user=>{
  const r=await app.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:user.email,password:DEMO_PASSWORD})});
  const data=await r.json() as any;assert.equal(r.status,200,JSON.stringify(data));return {cookie:r.headers.get('set-cookie')!.split(';')[0],csrf:data.csrf_token};
}));}
async function request(path:string,session:Session,body?:unknown,key=randomUUID(),csrf=session.csrf){
  const r=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:session.cookie,'X-CSRF-Token':csrf,...(body===undefined?{}:{'Content-Type':'application/json','Idempotency-Key':key})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,data:await r.json() as any};
}
const room=`/me/channels/guild/${guild}/messages`,dm=(id:string)=>`/me/conversations/${id}/messages`;

test('all 48 supplied sticker IDs pass both PostgreSQL constraints, unknown IDs stay refused, and new sticker DTOs persist through the real API',async()=>{
  assert.equal(FREETWAI_STICKERS.length,48);assert.equal(new Set(CHAT_STICKERS.map(item=>item.id)).size,52);
  for(const sticker of FREETWAI_STICKERS)assert.deepEqual(MessageContentInput.parse({sticker_id:sticker.id}),{sticker_id:sticker.id});
  const [a,b]=await sessions();assert.equal((await request(room,a,{body:'建立實際公會頻道'})).status,201);
  const ids=FREETWAI_STICKERS.map(item=>item.id),bodies=FREETWAI_STICKERS.map(item=>'[貼圖] '+item.label);
  // Catalog constraint fixtures are older history, outside the live send rate budget.
  await pool.query(`INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,sticker_id,created_at) SELECT $1,$2,$3,body,id,CURRENT_TIMESTAMP-interval '2 minutes' FROM unnest($4::text[],$5::text[]) AS supplied(id,body)`,[DEMO_COMMUNITY,A,B,ids,bodies]);
  await pool.query(`INSERT INTO member_channel_messages(community_id,kind,channel_key,sequence,sender_ref,body,sticker_id,created_at) SELECT $1,'guild',$2,ordinal+1,$3,body,id,CURRENT_TIMESTAMP-interval '2 minutes' FROM unnest($4::text[],$5::text[]) WITH ORDINALITY AS supplied(id,body,ordinal)`,[DEMO_COMMUNITY,guild,A,ids,bodies]);
  await pool.query("UPDATE member_chat_channels SET last_sequence=49 WHERE community_id=$1 AND kind='guild' AND channel_key=$2",[DEMO_COMMUNITY,guild]);
  await assert.rejects(()=>pool.query("INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,sticker_id) VALUES($1,$2,$3,'unknown','freetwai-v2-unknown')",[DEMO_COMMUNITY,A,B]),{code:'23514'});
  await assert.rejects(()=>pool.query("INSERT INTO member_channel_messages(community_id,kind,channel_key,sequence,sender_ref,body,sticker_id) VALUES($1,'guild',$2,50,$3,'unknown','freetwai-v2-unknown')",[DEMO_COMMUNITY,guild,A]),{code:'23514'});
  for(const path of [room,dm(B)]){
    const sticker=FREETWAI_STICKERS[47],saved=await request(path,a,{sticker_id:sticker.id});assert.equal(saved.status,201,JSON.stringify(saved.data));assert.deepEqual(saved.data.sticker,{id:sticker.id,label:sticker.label});
  }
  const messages=(await request(dm(A),b)).data.items;assert.ok(messages.some((message:any)=>message.sticker?.id==='freetwai-v2-cry'));
  assert.equal((await request(dm(B),a,{sticker_id:'freetwai-v2-unknown'})).status,422);
});

test('all original stickers persist in group and direct history with readable legacy bodies and idempotent retries',async()=>{
  const [a,b]=await sessions();
  for(const path of [room,dm(B)])for(const sticker of WORKSHOP_STICKERS){
    const key=randomUUID(),body={sticker_id:sticker.id},first=await request(path,a,body,key);
    assert.equal(first.status,201,JSON.stringify(first.data));assert.deepEqual(first.data.sticker,{id:sticker.id,label:sticker.label});assert.equal(first.data.body,`[貼圖] ${sticker.label}`);
    assert.deepEqual((await request(path,a,body,key)).data,first.data);
    assert.equal((await request(path,a,{sticker_id:CHAT_STICKERS.find(item=>item.id!==sticker.id)!.id},key)).data.code,'idempotency_conflict');
  }
  const channels=(await request(room,b)).data,direct=(await request(dm(A),b)).data;
  assert.equal(channels.items.length,4);assert.equal(direct.items.length,4);assert.equal(channels.unread_count,4);assert.equal(direct.unread_count,4);
  const preview=(await request('/me/conversations',b)).data.items.find((item:any)=>item.participant.user_id===A);
  assert.equal(preview.last_message.sticker.id,CHAT_STICKERS[3].id);
  assert.deepEqual(Object.keys((await request(room.replace('/messages','/activity'),b)).data).sort(),['latest_sequence','unread_count']);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM command_receipts WHERE response::text LIKE '%sticker%' OR response::text LIKE '%貼圖%' OR response::text LIKE '%reply%' ")).rows[0].n,0);
});

test('text-only DTOs remain compatible and the API rejects arbitrary media, forged quote text and mixed content',async()=>{
  const [a]=await sessions();
  for(const path of [room,dm(B)]){
    const legacy=await request(path,a,{body:'  <b>文字</b>\r\n第二行  '});assert.equal(legacy.status,201);assert.equal(legacy.data.body,'<b>文字</b>\n第二行');
    assert.equal('sticker' in legacy.data,false);assert.equal('reply_to' in legacy.data,false);
    for(const body of [{},{sticker_id:'unknown'},{sticker_id:'https://example.invalid/image.png'},{body:'hi',sticker_id:CHAT_STICKERS[0].id},{body:'hi',media_url:'https://example.invalid'},
      {body:'hi',reply_to:{body:'forged'}},{body:'hi',reply_to_message_id:'nope'},{sticker_id:CHAT_STICKERS[0].id,sticker:{label:'forged'}},{body:'\u0000'}]){
      assert.equal((await request(path,a,body)).status,422,JSON.stringify(body));
    }
  }
});

test('incoming and sticker replies derive quotes from the database, survive page boundaries and keep quote bodies bounded',async()=>{
  const [a,b]=await sessions();
  for(const [path,reverse] of [[room,room],[dm(B),dm(A)]]){
    const parent=await request(reverse,b,{body:'🙂'.repeat(170)+'<script>not markup</script>'});assert.equal(parent.status,201);
    const first=await request(path,a,{sticker_id:CHAT_STICKERS[1].id,reply_to_message_id:parent.data.message_id.toUpperCase()});assert.equal(first.status,201,JSON.stringify(first.data));
    assert.equal(first.data.reply_to.message_id,parent.data.message_id);assert.equal(first.data.reply_to.sender_ref,B);assert.equal(first.data.reply_to.sender_name,DEMO_USERS[1].display_name);
    assert.equal([...first.data.reply_to.body].length,160);
    const nested=await request(reverse,b,{body:'一起合作',reply_to_message_id:first.data.message_id});assert.equal(nested.status,201);
    assert.deepEqual(nested.data.reply_to.sticker,{id:CHAT_STICKERS[1].id,label:CHAT_STICKERS[1].label});assert.equal('reply_to' in nested.data.reply_to,false);
    const page=await request(path+'?limit=1',a);assert.equal(page.data.items[0].reply_to.message_id,first.data.message_id);assert.equal(page.data.next_offset,1);
  }
});

test('reply IDs cannot cross direct-message pairs, channel scopes, message tables or communities',async()=>{
  const [a,b,c]=await sessions();
  const otherPair=await request(dm(C),b,{body:'private B-C'}),ownDirect=await request(dm(B),a,{body:'private A-B'});
  const world=await request('/me/channels/world/world/messages',a,{body:'world message'}),ownRoom=await request(room,a,{body:'guild message'});
  for(const [path,id] of [[dm(B),otherPair.data.message_id],[dm(B),ownRoom.data.message_id],[room,ownDirect.data.message_id],[room,world.data.message_id],['/me/channels/world/world/messages',ownRoom.data.message_id],[room,randomUUID()]]){
    const rejected=await request(path,a,{body:'reply',reply_to_message_id:id});assert.equal(rejected.status,404,JSON.stringify(rejected.data));assert.equal(rejected.data.code,'reply_not_available');
  }
  assert.equal((await request(room,c,{sticker_id:CHAT_STICKERS[0].id})).status,404,'a sticker grants no guild membership');
  await assert.rejects(pool.query(`INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,reply_to_message_id) VALUES($1,$2,$3,'bypass',$4)`,[DEMO_COMMUNITY,A,B,otherPair.data.message_id]),(error:any)=>error.code==='23503');
  await assert.rejects(pool.query(`INSERT INTO member_channel_messages(community_id,kind,channel_key,sequence,sender_ref,body,reply_to_message_id) VALUES($1,'guild',$2,999,$3,'bypass',$4)`,[DEMO_COMMUNITY,guild,A,world.data.message_id]),(error:any)=>error.code==='23503');
});

test('sticker and reply commands retain CSRF, replay eligibility and rate limits',async()=>{
  const [a,b]=await sessions(),key=randomUUID(),payload={sticker_id:CHAT_STICKERS[0].id};
  assert.equal((await request(room,a,payload,randomUUID(),'invalid')).data.code,'csrf_rejected');
  const first=await request(room,a,payload,key);assert.equal(first.status,201);
  await pool.query("UPDATE positioning_profession_memberships SET state='left' WHERE user_id=$1 AND guild_key=$2",[A,guild]);
  assert.equal((await request(room,a,payload,key)).status,404);assert.equal((await request(room,a)).status,404);
  for(let i=0;i<20;i++)assert.equal((await request(dm(A),b,payload)).status,201);
  assert.equal((await request(dm(A),b,payload)).data.code,'message_rate_limited');
});

test('foreign-community originals and hidden world verification messages cannot be quoted',async()=>{
  const [a,b]=await sessions(),community=randomUUID(),user=randomUUID();
  await pool.query("INSERT INTO communities(community_id,name) VALUES($1,'合成其他社群')",[community]);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,$2,$3,'其他社群',password_hash,$4,false FROM users WHERE user_id=$5`,[user,community,`outside-${user}@example.test`,randomUUID(),A]);
  const privateId=(await pool.query("INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body) VALUES($1,$2,$3,'other community') RETURNING message_id",[community,user,C])).rows[0].message_id;
  assert.equal((await request(dm(B),a,{body:'quote',reply_to_message_id:privateId})).data.code,'reply_not_available');
  await pool.query('UPDATE users SET email=$1 WHERE user_id=$2',[`verification-${B}@example.invalid`,B]);
  const hidden=await request('/me/channels/world/world/messages',b,{body:'verification body'});assert.equal(hidden.status,201);
  const before=await request('/me/channels/world/world/messages',a);assert.equal(before.data.items.length,0);
  assert.equal((await request('/me/channels/world/world/messages',a,{body:'quote',reply_to_message_id:hidden.data.message_id})).data.code,'reply_not_available');
  assert.equal((await request('/me/channels/world/world/messages',b,{sticker_id:CHAT_STICKERS[0].id,reply_to_message_id:hidden.data.message_id})).status,201,'viewer may quote their own visible verification message');
});

test('database sticker IDs and same-community reply constraints reject raw writes outside the catalog or scope',async()=>{
  const [a]=await sessions();
  await request(room,a,{body:'room exists'});
  for(const table of ['member_direct_messages','member_channel_messages']){
    const sql=table==='member_direct_messages'?"INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,sticker_id) VALUES($1,$2,$3,'bypass','unknown')":"INSERT INTO member_channel_messages(community_id,kind,channel_key,sequence,sender_ref,body,sticker_id) VALUES($1,'guild',$3,999,$2,'bypass','unknown')";
    await assert.rejects(pool.query(sql,table==='member_direct_messages'?[DEMO_COMMUNITY,A,B]:[DEMO_COMMUNITY,A,guild]),(error:any)=>error.code==='23514');
  }
  const parent=(await request(dm(B),a,{body:'same community only'})).data.message_id,foreign=randomUUID();await pool.query("INSERT INTO communities(community_id,name) VALUES($1,'合成其他社群')",[foreign]);
  await assert.rejects(pool.query("INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,reply_to_message_id) VALUES($1,$2,$3,'bypass',$4)",[foreign,A,B,parent]),(error:any)=>error.code==='23503');
});

test('a quoted original cannot be deleted alone; clearing its reference allows a later moderation workflow',async()=>{
  const [a,b]=await sessions();
  for(const [path,reverse,table] of [[room,room,'member_channel_messages'],[dm(B),dm(A),'member_direct_messages']]){
    const parent=await request(reverse,b,{body:'source'}),reply=await request(path,a,{body:'answer',reply_to_message_id:parent.data.message_id});assert.equal(reply.status,201);
    await assert.rejects(pool.query(`DELETE FROM ${table} WHERE message_id=$1`,[parent.data.message_id]),(error:any)=>error.code==='23503');
    await pool.query(`UPDATE ${table} SET reply_to_message_id=NULL WHERE message_id=$1`,[reply.data.message_id]);
    await pool.query(`DELETE FROM ${table} WHERE message_id=$1`,[parent.data.message_id]);
    const latest=await request(path,a);assert.equal(latest.data.items[0].body,'answer');assert.equal('reply_to' in latest.data.items[0],false);
  }
});
