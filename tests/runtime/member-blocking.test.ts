import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import type {Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {login} from '../../modules/identity-membership/service.js';
import type {Actor} from '../../modules/identity-membership/service.js';
import {blockState,listBlocks,changeBlock} from '../../modules/identity-membership/blocks.js';
import {changeFriendship,listFriends,createSquad,changeSquadMembership,listMembers} from '../../modules/identity-membership/members.js';
import {sendDirectMessage,conversationMessages,conversationActivity,listConversations,markConversationRead} from '../../modules/member-communications/service.js';
import {sendChannelMessage,channelMessages,listChannels} from '../../modules/member-communications/channels.js';
import {inviteToSquad,resolveSquadInvitation} from '../../modules/identity-membership/squad-invitations.js';
import {memberRecommendations,friendDirectory} from '../../modules/identity-membership/member-connections.js';
import {Problem} from '../../packages/shared/problem.js';
import {BlockStateSchema,BlockListSchema} from '../../packages/shared/member-blocking.js';

const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_member_blocking_${process.pid}_${Date.now()}`,database=createPool(url);
const pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:12});
const [A,B,C]=DEMO_USERS.map(user=>user.user_id),origin='http://127.0.0.1:4310';
let actors:Actor[]=[];
before(async()=>{await database.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await database.query(`DROP SCHEMA ${schema} CASCADE`);await database.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
  actors=await Promise.all(DEMO_USERS.map(async user=>(await login(pool,user.email,DEMO_PASSWORD)).actor));
});
const cmd=(actor:Actor,operation:string,body:unknown={},expected?:number,key:string=randomUUID()):Command=>({actor,operation,key,body,expected:expected===undefined?undefined:String(expected)});
const block=(actor:Actor,id:string,expected?:number,key?:string)=>changeBlock(pool,cmd(actor,'block',{},expected,key),id,'block');
const unblock=(actor:Actor,id:string,expected?:number,key?:string)=>changeBlock(pool,cmd(actor,'unblock',{},expected,key),id,'unblock');
const friend=(actor:Actor,id:string,action:'request'|'accept'|'remove',expected?:number)=>changeFriendship(pool,cmd(actor,`friend/${id}/${action}`,{},expected),id,action);
const dm=(actor:Actor,id:string,key=randomUUID())=>sendDirectMessage(pool,cmd(actor,`POST /api/v1/me/conversations/${id}/messages`,{body:'保留的歷史訊息'},undefined,key),id);
const problem=(code:string)=>(error:unknown)=>error instanceof Problem&&error.code===code;
const count=async(table:string)=>(await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n as number;
async function barrier(run:()=>Promise<unknown>){
  const q=await pool.connect();await q.query('BEGIN');
  const [low,high]=[A,B].sort();
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`friend/${DEMO_COMMUNITY}/${low}/${high}`]);
  const holder=(await q.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
  const pending=run();
  try{
    const deadline=Date.now()+5000;
    for(;;){
      const waiting=(await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND pid<>pg_backend_pid()',[holder])).rowCount;
      if(waiting)break;
      assert.ok(Date.now()<deadline,'operation must actually wait on the pair lock');
      await pool.query('SELECT pg_sleep(0.005)'); // PostgreSQL lock-state polling, not guessed operation completion.
    }
    return {q,pending};
  }catch(error){await q.query('ROLLBACK');q.release();await pending.catch(()=>{});throw error;}
}

test('blocking removes accepted friendship silently; reciprocal sends/requests/accepts denied; unblock restores no friendship',async()=>{
  const [a,b]=actors;await friend(a,B,'request');await friend(b,A,'accept',1);await dm(a,B);
  const notices=await count('member_notifications');
  assert.equal((await block(a,B)).aggregate_version,1);
  assert.equal(await count('member_notifications'),notices);
  assert.deepEqual(await listFriends(pool,a),[]);assert.deepEqual(await listFriends(pool,b),[]);
  for(const [actor,id] of [[a,B],[b,A]] as const){
    await assert.rejects(dm(actor,id),problem('recipient_unavailable'));
    await assert.rejects(friend(actor,id,'request'),problem('recipient_unavailable'));
    await assert.rejects(friend(actor,id,'accept',3),problem('recipient_unavailable'));
    assert.equal((await conversationMessages(pool,actor,id,{})).can_send,false);
    assert.equal((await conversationActivity(pool,actor,id)).can_send,false);
    assert.equal((await listConversations(pool,actor,{})).items[0].can_send,false);
  }
  assert.equal((await conversationMessages(pool,b,A,{})).items.length,1);
  await markConversationRead(pool,cmd(b,'read'),A);
  assert.equal((await conversationMessages(pool,a,B,{})).items[0].read_at!==null,true);
  const removed=await unblock(a,B,1);assert.equal(removed.aggregate_version,2);assert.equal('can_contact' in removed,false);
  assert.deepEqual(await listFriends(pool,a),[]);assert.deepEqual(await listFriends(pool,b),[]);
  await dm(b,A);assert.equal(await count('member_direct_messages'),2);
});

test('pending invitation removed without decline notice; own list private and inverse setting undisclosed',async()=>{
  const [a,b,c]=actors;await friend(b,A,'request');const notices=await count('member_notifications');await block(a,B);
  assert.equal(await count('member_notifications'),notices);assert.deepEqual(await listFriends(pool,b),[]);
  const mine=BlockListSchema.parse(await listBlocks(pool,a,{}));assert.deepEqual(mine.items.map(row=>row.user_id),[B]);
  assert.deepEqual(await listBlocks(pool,b,{}),{items:[],next_offset:null});assert.deepEqual(await listBlocks(pool,c,{}),{items:[],next_offset:null});
  assert.deepEqual(await blockState(pool,b,A),{user_id:A,blocked_by_me:false,aggregate_version:null});
  await block(b,A);await unblock(a,B,1);assert.deepEqual(await blockState(pool,a,B),{user_id:B,blocked_by_me:false,aggregate_version:2});
  await assert.rejects(dm(a,B),problem('recipient_unavailable'));
  const outsider=randomUUID(),community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'其他合成社群']);
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,$2,$3,'不可揭露',password_hash,$4 FROM users WHERE user_id=$5`,[outsider,community,`${outsider}@example.invalid`,randomUUID(),A]);
  await assert.rejects(block(a,outsider),problem('member_not_found'));await assert.rejects(blockState(pool,a,outsider),problem('member_not_found'));
  await assert.rejects(block(a,A),problem('self_block'));
  await assert.rejects(pool.query(`INSERT INTO member_interaction_blocks(community_id,owner_ref,target_ref,state) VALUES($1,$2,$3,'active')`,[DEMO_COMMUNITY,A,outsider]),{code:'23503'});
});

test('flag OFF unregisters management but saved blocks protect real API consumers; strict empty input and canonical receipt path',async()=>{
  const [a,b]=actors,enabled=createApp(pool,origin,'local',{memberBlockingEnabled:true}),disabled=createApp(pool,origin,'local',{memberBlockingEnabled:false});
  const headers={Origin:origin,Cookie:`freedom_session=${''}`};
  // Use the actual login endpoint to obtain the deployed cookie shape.
  const session=await enabled.request(origin+'/api/v1/auth/login',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:DEMO_USERS[0].email,password:DEMO_PASSWORD})});
  const loginBody=await session.json() as {csrf_token:string};headers.Cookie=session.headers.get('set-cookie')!.split(';')[0];
  const key=randomUUID(),writeHeaders={...headers,'X-CSRF-Token':loginBody.csrf_token,'Idempotency-Key':key,'Content-Type':'application/json'};
  const path=`/api/v1/me/blocks/${B}/block`;
  const first=await enabled.request(origin+path,{method:'POST',headers:writeHeaders,body:'{}'});assert.equal(first.status,200);BlockStateSchema.parse(await first.json());
  const alias=await enabled.request(origin+path.replace(B,B.toUpperCase()),{method:'POST',headers:writeHeaders,body:'{}'});assert.equal(alias.status,200);assert.equal(await count('member_interaction_blocks'),1);
  assert.equal((await disabled.request(origin+'/api/v1/site')).status,200);
  assert.equal((await (await disabled.request(origin+'/api/v1/site')).json() as any).member_blocking_enabled,false);
  assert.equal((await (await enabled.request(origin+'/api/v1/site')).json() as any).member_blocking_enabled,true);
  for(const action of ['block','unblock'])assert.equal((await disabled.request(origin+`/api/v1/me/blocks/${B}/${action}`,{method:'POST',headers:writeHeaders,body:'{}'})).status,404);
  assert.equal((await disabled.request(origin+'/api/v1/me/blocks',{headers})).status,404);
  const blocked=await disabled.request(origin+`/api/v1/me/conversations/${B}/messages`,{method:'POST',headers:{...writeHeaders,'Idempotency-Key':randomUUID()},body:JSON.stringify({body:'不應寫入'})});assert.equal(blocked.status,409);
  await assert.rejects(dm(b,A),problem('recipient_unavailable'));
  assert.equal((await enabled.request(origin+path,{method:'POST',headers:{...writeHeaders,'Idempotency-Key':randomUUID()},body:'{"reason":"private"}'})).status,422);
  assert.equal(await count('member_direct_messages'),0);
  assert.equal((await pool.query("SELECT response FROM command_receipts WHERE operation LIKE '%/blocks/%' LIMIT 1")).rows[0].response.updated,true);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM outbox o JOIN transition_journal t ON t.transition_id=o.transition_id WHERE t.aggregate_type='member_interaction_block'")).rows[0].n,0);
});

test('tombstone CAS, unknown-result same-key replay and stale key do not duplicate; GET never creates setting',async()=>{
  const [a]=actors;assert.equal((await blockState(pool,a,B)).aggregate_version,null);assert.equal(await count('member_interaction_blocks'),0);
  const key=randomUUID();await block(a,B,undefined,key);await block(a,B,undefined,key);
  assert.equal(await count('member_interaction_blocks'),1);
  await assert.rejects(unblock(a,B),problem('version_required'));await assert.rejects(unblock(a,B,2),problem('version_conflict'));
  await unblock(a,B,1);assert.equal((await block(a,B,undefined,key)).blocked_by_me,false,'old receipt rereads authoritative current setting');
  await assert.rejects(block(a,B,1),problem('version_conflict'));await assert.rejects(block(a,B),problem('version_required'));
  assert.equal((await block(a,B,2)).aggregate_version,3);
  const messageKey=randomUUID();await unblock(a,B,3);await dm(a,B,messageKey);await block(a,B,4);
  await assert.rejects(dm(a,B,messageKey),problem('recipient_unavailable'));assert.equal(await count('member_direct_messages'),1);
});

test('live qualification/session, inactive own target removal and masked list profile',async()=>{
  const [a,b]=actors;await block(a,B);
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[B]);
  assert.equal((await listBlocks(pool,a,{})).items[0].nickname,null);
  assert.equal((await unblock(a,B,1)).blocked_by_me,false);await assert.rejects(block(a,B,2),problem('member_not_found'));
  await pool.query('UPDATE users SET active=true WHERE user_id=$1',[B]);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[A]);
  await assert.rejects(listBlocks(pool,a,{}),problem('onboarding_required'));await assert.rejects(friend(a,B,'request'),problem('onboarding_required'));
  await pool.query('UPDATE users SET onboarding_required=false WHERE user_id=$1',[A]);await pool.query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1',[b.session_hash]);
  await assert.rejects(blockState(pool,b,A),problem('session_expired'));
});

test('pair barrier makes committed block deny waiting send and invite; reciprocal block races have no deadlock',async()=>{
  const [a,b]=actors;
  for(const run of [()=>dm(b,A),()=>friend(b,A,'request')]){
    const held=await barrier(run);
    const denial=assert.rejects(held.pending,problem('recipient_unavailable'));
    try{await held.q.query(`INSERT INTO member_interaction_blocks(community_id,owner_ref,target_ref,state) VALUES($1,$2,$3,'active') ON CONFLICT(community_id,owner_ref,target_ref) DO UPDATE SET state='active'`,[DEMO_COMMUNITY,A,B]);await held.q.query('COMMIT');}finally{held.q.release();}
    await denial;
  }
  assert.equal(await count('member_direct_messages'),0);assert.equal(await count('member_friendships'),0);
  await pool.query('DELETE FROM member_interaction_blocks');
  const results=await Promise.all([block(a,B),block(b,A)]);assert.equal(results.every(result=>result.blocked_by_me),true);
});

test('barrier crosses session expiry before new send or successful receipt replay and creates no extra effect',async()=>{
  const [a]=actors,key=randomUUID();await dm(a,B,key);
  for(const attemptKey of [key,randomUUID()]){
    await pool.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",[a.session_hash]);
    const expires=await barrier(()=>dm(a,B,attemptKey)),expired=assert.rejects(expires.pending,problem('session_expired'));
    try{
      // The real PostgreSQL decision clock cannot be advanced with JavaScript fake timers.
      while((await expires.q.query('SELECT expires_at>clock_timestamp() AS live FROM sessions WHERE token_hash=$1',[a.session_hash])).rows[0].live)await expires.q.query('SELECT pg_sleep(0.01)');
      await expires.q.query('COMMIT');
    }finally{expires.q.release();}
    await expired;assert.equal(await count('member_direct_messages'),1);
  }
});

test('shared world channel and historical messages remain usable without changing memberships',async()=>{
  const [a,b]=actors;const message=await sendChannelMessage(pool,cmd(a,'channel',{body:'共用頻道保留'}),'world','world');
  const before=await listChannels(pool,a,{kind:'world'});await block(a,B);
  const after=await listChannels(pool,a,{kind:'world'});assert.deepEqual(after,before);
  assert.ok((await channelMessages(pool,b,'world','world',{})).items.some(item=>item.message_id===message.message_id));
  await sendChannelMessage(pool,cmd(b,'channel',{body:'封鎖後仍在世界頻道'}),'world','world');
  assert.equal((await channelMessages(pool,a,'world','world',{})).items.length,2);
});

test('actual queued block commits before concurrent send and pending accept, with one friendship removal',async()=>{
  const [a,b]=actors;await friend(a,B,'request');
  const held=await barrier(()=>block(a,B));
  const send=dm(b,A),accept=friend(b,A,'accept',1);
  const sendDenied=assert.rejects(send,problem('recipient_unavailable')),acceptDenied=assert.rejects(accept,problem('recipient_unavailable'));
  try{await held.q.query('COMMIT');}finally{held.q.release();}
  await held.pending;await Promise.all([sendDenied,acceptDenied]);
  assert.equal(await count('member_direct_messages'),0);
  const friendship=(await pool.query('SELECT state,aggregate_version FROM member_friendships WHERE community_id=$1',[DEMO_COMMUNITY])).rows[0];
  assert.equal(friendship.state,'removed');assert.equal(Number(friendship.aggregate_version),2);
  assert.equal(await count('member_notifications'),1,'only the original invitation is notified');
});

test('list pagination and strict bounded query are authoritative own settings only',async()=>{
  const [a]=actors;await block(a,B);await block(a,C);
  const first=await listBlocks(pool,a,{limit:1}),second=await listBlocks(pool,a,{limit:1,offset:1});
  assert.equal(first.items.length,1);assert.equal(first.next_offset,1);assert.equal(second.next_offset,null);
  assert.deepEqual([...first.items,...second.items].map(item=>item.user_id).sort(),[B,C].sort());
  for(const query of [{limit:51},{offset:10001},{limit:0},{unknown:1}])await assert.rejects(listBlocks(pool,a,query));
});

const squadFor=async(actor:Actor)=>(await createSquad(pool,cmd(actor,'create-squad',{name:'封鎖測試小隊',kind:'project',purpose:'合成封鎖回歸'}))).squad_id as string;
const squadInvite=(actor:Actor,squadId:string,target:string,key=randomUUID())=>inviteToSquad(pool,cmd(actor,`invite/${squadId}`,{recipient_ref:target},undefined,key),squadId);
const squadAccept=(actor:Actor,id:string,key=randomUUID())=>resolveSquadInvitation(pool,cmd(actor,`accept/${id}`,{},1,key),id,'accept');

test('block silently withdraws reciprocal pending squad invites; old invite/accept receipts cannot bypass it; accepted membership stays',async()=>{
  const [a,b]=actors,sa=await squadFor(a),sb=await squadFor(b),shared=await squadFor(a);
  const joined=await squadInvite(a,shared,B),acceptKey=randomUUID();await squadAccept(b,joined.invitation_id,acceptKey);
  const key=randomUUID(),outbound=await squadInvite(a,sa,B,key),inbound=await squadInvite(b,sb,A);
  const notices=await count('member_notifications');await block(a,B);
  assert.equal(await count('member_notifications'),notices);
  const rows=(await pool.query('SELECT invitation_id,state,aggregate_version FROM member_squad_invitations ORDER BY invitation_id')).rows;
  for(const id of [outbound.invitation_id,inbound.invitation_id])assert.deepEqual(rows.find(row=>row.invitation_id===id),{invitation_id:id,state:'withdrawn',aggregate_version:'2'});
  assert.equal(rows.find(row=>row.invitation_id===joined.invitation_id).state,'accepted');
  assert.equal((await pool.query('SELECT state FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2',[shared,B])).rows[0].state,'active');
  for(const run of [()=>squadInvite(a,sa,B,key),()=>squadInvite(b,sb,A),()=>squadAccept(b,outbound.invitation_id),()=>squadAccept(a,inbound.invitation_id),()=>squadAccept(b,joined.invitation_id,acceptKey)])await assert.rejects(run(),problem('recipient_unavailable'));
  assert.equal(await count('member_notifications'),notices);
  await unblock(a,B,1);
  assert.equal((await squadInvite(a,sa,B)).state,'pending');
});

test('committed block denies an actually waiting squad invite and acceptance',async()=>{
  const [a,b]=actors,sa=await squadFor(a),sb=await squadFor(b);
  const invitation=await squadInvite(a,sa,B),notices=await count('member_notifications');
  // Queue the real block first on the same pair lock, then both other commands.
  const held=await barrier(()=>block(a,B));
  const inviteDenied=assert.rejects(squadInvite(b,sb,A),problem('recipient_unavailable'));
  const acceptDenied=assert.rejects(squadAccept(b,invitation.invitation_id),problem('recipient_unavailable'));
  try{await held.q.query('COMMIT');}finally{held.q.release();}
  await held.pending;await Promise.all([inviteDenied,acceptDenied]);
  assert.equal(await count('member_notifications'),notices);
  assert.equal((await pool.query('SELECT state FROM member_squad_invitations WHERE invitation_id=$1',[invitation.invitation_id])).rows[0].state,'withdrawn');
  assert.equal((await pool.query('SELECT 1 FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2',[sa,B])).rowCount,0);
});

test('squad join requests and existing request acceptance/replay share the block barrier; leaving remains available',async()=>{
  const [a,b]=actors,sa=await squadFor(a),key=randomUUID();
  const request=()=>changeSquadMembership(pool,cmd(b,`join/${sa}`,{},undefined,key),sa,'request');
  await request();await block(a,B);
  await assert.rejects(request(),problem('recipient_unavailable'));
  await assert.rejects(changeSquadMembership(pool,cmd(a,`approve/${sa}`,{},1),sa,'accept',B),problem('recipient_unavailable'));
  assert.equal((await changeSquadMembership(pool,cmd(b,`leave/${sa}`,{},1),sa,'leave')).state,'left');
  await unblock(a,B,1);
  assert.equal((await changeSquadMembership(pool,cmd(b,`join/${sa}`,{},2),sa,'request')).state,'pending');
});

test('recommendations and member/friend search exclude either block direction before count/page; own setting has no inverse signal',async()=>{
  const [a,b]=actors,beforeState=await blockState(pool,b,A);
  await block(a,B);
  assert.deepEqual(await blockState(pool,b,A),beforeState);
  for(const [actor,target] of [[a,B],[b,A]] as const){
    const page=await memberRecommendations(pool,actor,{limit:3});assert.equal(page.total,1);assert.deepEqual(page.items.map(row=>row.member.user_id),[C]);assert.equal(page.next_offset,0);
    const search=await listMembers(pool,actor,20,0,{search:DEMO_USERS.find(row=>row.user_id===target)!.display_name});assert.equal(search.total,0);assert.deepEqual(search.items,[]);assert.equal(search.next_offset,null);
    assert.deepEqual((await friendDirectory(pool,actor,{scope:'accepted',search:''})).items,[]);
  }
  await unblock(a,B,1);await block(b,A);
  assert.equal((await memberRecommendations(pool,a,{limit:3})).items.some(row=>row.member.user_id===B),false);
});

test('recommendations recheck a block committed after candidate selection and before returning cards',async()=>{
  const [a,b]=actors;let selected=false;
  const lateBlockPool=new Proxy(pool,{get(target,prop){
    if(prop!=='query'){const value=Reflect.get(target,prop);return typeof value==='function'?value.bind(target):value;}
    return async(...args:any[])=>{const result=await (pool.query as any)(...args);if(!selected&&String(args[0]).includes('AS picks')){selected=true;await block(b,A);}return result;};
  }});
  const page=await memberRecommendations(lateBlockPool,a,{limit:3});assert.equal(selected,true);assert.equal(page.total,2,'count remains the candidate snapshot');
  assert.deepEqual(page.items.map(row=>row.member.user_id),[C]);
});
