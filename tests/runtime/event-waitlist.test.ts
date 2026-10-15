import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {Pool,type PoolClient} from 'pg';
import {createPool,LOCAL_DATABASE_URL,transaction} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {eventInvitationDeadline,ensureGuestCapability,resolveGuestParticipation,readGuestEventParticipation,mutateGuestEventParticipation,reconcileEventWaitlist,countEventSeats,processEventWaitlist} from '../../modules/community/event-waitlist.js';
import {setRsvp,registerPublicEvent,cancelEvent,getEventShareCode} from '../../modules/community/events.js';
import {mutateEventWaitlist,readEventParticipation,updateEventSchedule,setEventWaitlistPolicy} from '../../modules/community/event-waitlist.js';
import {Problem} from '../../packages/shared/problem.js';
import type {Command} from '../../packages/db/index.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';

import type {EventParticipation} from '../../modules/community/event-waitlist.js';
const url=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_waitlist_${process.pid}_${Date.now()}`;
const admin=createPool(url),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
let eventId:string,actors:Actor[];
const start=new Date('2099-01-01T12:00:00Z');
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);eventId=randomUUID();
  actors=(await Promise.all(DEMO_USERS.map(user=>login(pool,user.email,DEMO_PASSWORD)))).map(result=>result.actor);
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,capacity,state,visibility,waitlist_enabled,response_window_minutes)
    VALUES($1,$2,$3,'合成活動','隔離候補驗證',$4,$5,'online','合成線上地址',1,'published','open',true,30)`,[eventId,DEMO_COMMUNITY,DEMO_USERS[0].user_id,start,new Date(start.getTime()+3600000)]);
});
async function capability(email:string){return transaction(pool,async q=>{await q.query('SELECT 1 FROM community_events WHERE event_id=$1 FOR UPDATE',[eventId]);return ensureGuestCapability(q,eventId,{email,name:'合成訪客'});});}
async function action(token:string,verb:'join'|'accept'|'decline'|'cancel'|'register',key=randomUUID()){
  const current=await readGuestEventParticipation(pool,eventId,token);
  const body={action:verb,expected_version:current.event_version};
  return {result:await mutateGuestEventParticipation(pool,eventId,token,body,key),body,key};
}
const actor=(index:number)=>actors[index];
const memberCommand=(index:number,operation:string,body:unknown,expected?:number):Command=>({actor:actor(index),operation,key:randomUUID(),body,...(expected===undefined?{}:{expected:String(expected)})});
test('reply window is explicit and every deadline is capped at the current start',()=>{
  const now=new Date('2099-01-01T11:55:00Z');
  assert.equal(eventInvitationDeadline(now,start,30).toISOString(),start.toISOString());
  assert.equal(eventInvitationDeadline(now,start,2).toISOString(),'2099-01-01T11:57:00.000Z');
  for(const value of [0,-1,1.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>eventInvitationDeadline(now,start,value));
});
test('FIFO offers reserve one seat, declining advances exactly once and acceptance writes the original guest RSVP',async()=>{
  const first=await capability('first@local.test'),second=await capability('second@local.test');
  const joined=await action(first,'join');assert.equal(joined.result.waitlist?.status,'invited');
  assert.equal((await action(second,'join')).result.waitlist?.status,'queued');assert.equal(await countEventSeats(pool,eventId),1);
  const declined=await action(first,'decline');assert.equal(declined.result.waitlist?.status,'declined');
  const offered=await readGuestEventParticipation(pool,eventId,second);assert.equal(offered.waitlist?.status,'invited');
  const invitation=(await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,'second@local.test'])).rows[0].invitation_id;
  await mutateGuestEventParticipation(pool,eventId,first,declined.body,declined.key);
  assert.equal((await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,'second@local.test'])).rows[0].invitation_id,invitation);
  const accepted=await action(second,'accept');assert.equal(accepted.result.rsvp_state,'going');assert.equal(await countEventSeats(pool,eventId),1);
  const original=(await pool.query('SELECT state,confirmed_at,email_sent_at FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,'second@local.test'])).rows[0];
  assert.equal(original.state,'going');assert.ok(original.confirmed_at);assert.equal(original.email_sent_at,null);
  await mutateGuestEventParticipation(pool,eventId,second,accepted.body,accepted.key);assert.equal(await countEventSeats(pool,eventId),1);
});
test('expiry advances FIFO transactionally and a failed invite provider is not retried as a second logical invitation',async()=>{
  const first=await capability('expiry@local.test'),second=await capability('next@local.test');await action(first,'join');await action(second,'join');
  let calls=0;const fail=async()=>{calls++;throw new Error('synthetic provider rejection');};
  await processEventWaitlist(pool,fail,'https://example.test');await processEventWaitlist(pool,fail,'https://example.test');assert.equal(calls,1);
  assert.equal((await readGuestEventParticipation(pool,eventId,first)).waitlist?.delivery_status,'failed');
  const deadline=(await pool.query('SELECT expires_at FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,'expiry@local.test'])).rows[0].expires_at;
  await transaction(pool,q=>reconcileEventWaitlist(q,eventId,new Date(deadline)));
  assert.equal((await readGuestEventParticipation(pool,eventId,first)).waitlist?.status,'expired');assert.equal((await readGuestEventParticipation(pool,eventId,second)).waitlist?.status,'invited');
  assert.equal(await countEventSeats(pool,eventId,new Date(deadline)),1);
});
test('joining an expired invitation requeues behind existing candidates before the worker sweep',async()=>{
  const first=await capability('rejoin-expired@local.test'),second=await capability('ahead@local.test');
  await action(first,'join');await action(second,'join');
  await pool.query("UPDATE community_event_waitlist SET invited_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE event_id=$1 AND guest_email=$2",[eventId,'rejoin-expired@local.test']);
  const rejoined=await action(first,'join');
  assert.equal(rejoined.result.waitlist?.status,'queued');
  assert.equal((await readGuestEventParticipation(pool,eventId,second)).waitlist?.status,'invited');
  assert.equal((await action(second,'decline')).result.waitlist?.status,'declined');
  assert.equal((await readGuestEventParticipation(pool,eventId,first)).waitlist?.status,'invited');
});
for(const kind of ['member','guest'] as const)for(const swept of [false,true])test(`${kind} cannot accept an expired invitation ${swept?'after':'before'} reconciliation or persist a success receipt`,async()=>{
  const email='expired-accept@local.test',token=kind==='guest'?await capability(email):null;
  if(token)await action(token,'join');
  else{
    const current=await readEventParticipation(pool,actor(1),eventId);
    await mutateEventWaitlist(pool,memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'join'},current.event_version),eventId);
  }
  await pool.query("UPDATE community_event_waitlist SET invited_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE event_id=$1",[eventId]);
  if(swept)await transaction(pool,q=>reconcileEventWaitlist(q,eventId));
  const current=token?await readGuestEventParticipation(pool,eventId,token):await readEventParticipation(pool,actor(1),eventId);
  const input=memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'accept'},current.event_version);
  const run=()=>token?mutateGuestEventParticipation(pool,eventId,token,{action:'accept',expected_version:current.event_version},input.key):mutateEventWaitlist(pool,input,eventId);
  for(let attempt=0;attempt<2;attempt++)await assert.rejects(run,error=>{
    assert.ok(error instanceof Problem);assert.equal(error.status,409);assert.equal(error.code,'invitation_unavailable');return true;
  });
  assert.equal((await pool.query("SELECT 1 FROM community_event_rsvps WHERE event_id=$1 AND state='going' UNION ALL SELECT 1 FROM community_event_guest_rsvps WHERE event_id=$1 AND state='going'",[eventId])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM command_receipts WHERE user_id=$1 AND operation=$2 AND idempotency_key=$3',[actor(1).user_id,input.operation,input.key])).rowCount,0);
  assert.equal((await pool.query('SELECT 1 FROM community_event_guest_commands WHERE event_id=$1 AND command_id=$2',[eventId,input.key])).rowCount,0);
  // A rejected command rolls back its reconciliation; the existing sweep still expires it.
  await transaction(pool,q=>reconcileEventWaitlist(q,eventId));
  const final=token?await readGuestEventParticipation(pool,eventId,token):await readEventParticipation(pool,actor(1),eventId);
  assert.equal(final.waitlist?.status,'expired');assert.equal(final.rsvp_state,null);
});
test('email capabilities never autojoin or auto-register; source visibility revocation denies the prior capability',async()=>{
  const token=await capability('capability@local.test');assert.equal(token.length,43);
  assert.equal(await capability('capability@local.test'),token);
  const source=await resolveGuestParticipation(pool,eventId,token);assert.equal(source.going,false);assert.equal(source.event.online_url,null);
  assert.equal((await readGuestEventParticipation(pool,eventId,token)).waitlist,null);assert.equal(await countEventSeats(pool,eventId),0);
  await pool.query("UPDATE community_events SET visibility='workshop' WHERE event_id=$1",[eventId]);
  await assert.rejects(resolveGuestParticipation(pool,eventId,token));
});

test('the last seat is atomic across the original member and public guest registration paths',async()=>{
  const member=memberCommand(1,`POST /events/${eventId}/rsvp`,{going:true});
  const guest={name:'合成訪客',email:'last-seat@local.test'};
  const outcomes=await Promise.allSettled([
    setRsvp(pool,member,eventId,true),
    registerPublicEvent(pool,eventId,guest,async()=>{},'https://example.test',true)
  ]);
  assert.equal(outcomes.filter(row=>row.status==='fulfilled').length,1);
  const rejected=outcomes.find(row=>row.status==='rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof Problem);assert.equal(rejected.reason.status,409);assert.equal(rejected.reason.code,'event_full');
  assert.equal(await countEventSeats(pool,eventId),1);
  if(outcomes[0].status==='fulfilled')await setRsvp(pool,member,eventId,true);
  else await registerPublicEvent(pool,eventId,guest,async()=>{},'https://example.test',true);
  assert.equal(await countEventSeats(pool,eventId),1);
});

async function eventLockWaiters(blockerPid:number){
  // Follow the owned wait queue: the second waiter can wait behind the first waiter.
  return (await admin.query<{pid:number;xact_start:Date}>(`WITH RECURSIVE waiters AS (
    SELECT pid FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))
    UNION SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid=ANY(pg_blocking_pids(a.pid))
  ) SELECT a.pid,a.xact_start FROM waiters w JOIN pg_stat_activity a USING(pid)
    WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND a.query LIKE '%FROM community_events WHERE event_id=$1%'`,[blockerPid])).rows;
}
async function waitForEventLockCount(blockerPid:number,count:number){
  for(let attempt=0;attempt<200;attempt++){
    const waiters=await eventLockWaiters(blockerPid);if(waiters.length===count)return waiters;
    await delay(20);
  }
  assert.fail(`expected ${count} requests waiting behind the owned event blocker`);
}
async function rollbackEventBlocker(blocker:PoolClient){
  try{await blocker.query('ROLLBACK');}catch(error){blocker.release(true);throw error;}
  blocker.release();
}

for(const reactivated of [false,true])test(`guest admission starts its hold after the event lock wait (reactivated=${reactivated})`,async()=>{
  const guest={name:'合成入場訪客',email:'admission-clock@local.test'};
  const previous=reactivated?(await pool.query<{registration_attempt_id:string}>(`INSERT INTO community_event_guest_rsvps(event_id,email,name,state,created_at)
    VALUES($1,$2,$3,'cancelled',clock_timestamp()-interval '1 hour') RETURNING registration_attempt_id`,[eventId,guest.email,guest.name])).rows[0]:null;
  const blocker=await pool.connect();
  let pending:Promise<{value:unknown;error:unknown}>|undefined,providerCalls=0;
  try{
    await blocker.query('BEGIN');await blocker.query('SELECT event_id FROM community_events WHERE event_id=$1 FOR UPDATE',[eventId]);
    const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=registerPublicEvent(pool,eventId,guest,async()=>{providerCalls++;},'https://example.test')
      .then(value=>({value,error:null}),error=>({value:null,error}));
    const waiters=await waitForEventLockCount(pid,1);
    await blocker.query('SELECT pg_sleep(0.02)');
    const releasedAt=(await blocker.query<{at:Date}>('SELECT clock_timestamp() AS at')).rows[0].at;
    assert.ok(waiters[0].xact_start.getTime()<releasedAt.getTime(),'admission transaction began before the owned lock was released');
    await blocker.query('ROLLBACK');
    const result=await pending;assert.equal(result.error,null);assert.equal(providerCalls,1);
    const current=(await pool.query<{created_at:Date;state:string;registration_attempt_id:string}>('SELECT created_at,state,registration_attempt_id FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,guest.email])).rows[0];
    assert.ok(current.created_at.getTime()>=releasedAt.getTime(),'a new hold starts after admission acquires the event lock');
    assert.equal(current.state,'going');
    if(previous)assert.notEqual(current.registration_attempt_id,previous.registration_attempt_id);
  }finally{try{await rollbackEventBlocker(blocker);}finally{if(pending)await pending;}}
});

for(const accepted of [true,false])test(`guest provider result survives only hold expiry after authorized handoff (accepted=${accepted})`,async()=>{
  const guest={name:'合成提供者訪客',email:'provider-hold@local.test'};
  let providerCalls=0;
  const result=await registerPublicEvent(pool,eventId,guest,async(_to,_subject,body)=>{
    providerCalls++;assert.ok(body.includes('私人參與管理'));
    // Dispatch was authorized with a live hold. Let only that hold expire while the provider waits.
    const hold=(await pool.query<{live:boolean}>(`UPDATE community_event_guest_rsvps SET created_at=clock_timestamp()-interval '9 minutes 58 seconds'
      WHERE event_id=$1 AND email=$2 AND state='pending' RETURNING created_at>clock_timestamp()-interval '10 minutes' AS live`,[eventId,guest.email])).rows[0];
    assert.equal(hold.live,true);
    await pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM created_at+interval '10 minutes'-clock_timestamp()))+0.02) FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2",[eventId,guest.email]);
    assert.equal((await pool.query<{expired:boolean}>("SELECT created_at<=clock_timestamp()-interval '10 minutes' AS expired FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2",[eventId,guest.email])).rows[0].expired,true);
    if(!accepted)throw new Error('synthetic provider rejection');
  },'https://example.test',true).then(value=>({value,error:null}),error=>({value:null,error}));
  assert.equal(providerCalls,1);
  if(accepted){assert.equal(result.error,null);assert.deepEqual(result.value,{registered:true,provider_status:'provider_accepted'});}
  else{assert.ok(result.error instanceof Problem);assert.equal(result.error.status,503);assert.equal(result.error.code,'event_email_delivery_failed');}
  const current=(await pool.query<{state:string;email_sent_at:Date|null;provider_status:string}>(`SELECT r.state,r.email_sent_at,c.provider_status
    FROM community_event_guest_rsvps r JOIN community_event_guest_capabilities c USING(event_id,email) WHERE r.event_id=$1 AND r.email=$2`,[eventId,guest.email])).rows[0];
  assert.equal(current.state,accepted?'going':'pending');assert.equal(current.email_sent_at!==null,accepted);
  assert.equal(current.provider_status,accepted?'provider_accepted':'pending');assert.equal(await countEventSeats(pool,eventId),accepted?1:0);
  assert.equal((await pool.query<{future:boolean}>('SELECT starts_at>clock_timestamp() AS future FROM community_events WHERE event_id=$1',[eventId])).rows[0].future,true);
});

test('an expired invitation does not reserve a seat after the event lock wait',async()=>{
  async function member(email:string,name:string){
    const id=randomUUID();
    await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required,onboarding_completed_at,email_verified_at)
      SELECT $1,community_id,$2,$3,password_hash,$4,false,now(),now() FROM users WHERE user_id=$5`,[id,email,name,randomUUID(),DEMO_USERS[0].user_id]);
    return (await login(pool,email,DEMO_PASSWORD)).actor;
  }
  const organizer=await member('seat-organizer@example.test','主辦');
  const invitee=await member('seat-invitee@example.test','受邀');
  const other=await member('seat-other@example.test','其他人');
  const id=randomUUID();
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,capacity,state,visibility)
    VALUES($1,$2,$3,'名額鎖測試','隔離鎖等待',$4,$5,'in_person','合成場地',1,'published','open')`,[id,DEMO_COMMUNITY,organizer.user_id,start,new Date(start.getTime()+3600000)]);
  await pool.query(`INSERT INTO community_event_waitlist(entry_id,event_id,member_ref,status,invited_at,expires_at,invitation_id)
    VALUES($1,$2,$3,'invited',clock_timestamp(),clock_timestamp()+interval '30 minutes',$4)`,[randomUUID(),id,invitee.user_id,randomUUID()]);
  const blocker=await pool.connect();
  const settle=(pending:Promise<unknown>)=>pending.then(()=>({error:null as Problem|null}),error=>{assert.ok(error instanceof Problem);return {error};});
  let otherPending:Promise<{error:Problem|null}>|undefined,inviteePending:Promise<{error:Problem|null}>|undefined;
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT event_id FROM community_events WHERE event_id=$1 FOR UPDATE',[id]);
    const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    otherPending=settle(setRsvp(pool,{actor:other,operation:`events/${id}/rsvp`,key:randomUUID(),body:{going:true}},id));
    await waitForEventLockCount(pid,1);
    inviteePending=settle(setRsvp(pool,{actor:invitee,operation:`events/${id}/rsvp`,key:randomUUID(),body:{going:true}},id));
    const waiters=await waitForEventLockCount(pid,2);
    const deadline=(await pool.query<{expires_at:Date}>("UPDATE community_event_waitlist SET expires_at=clock_timestamp()+interval '1 second' WHERE event_id=$1 AND member_ref=$2 RETURNING expires_at",[id,invitee.user_id])).rows[0].expires_at;
    assert.ok(waiters.every(waiter=>waiter.xact_start.getTime()<deadline.getTime()),'both transaction clocks must precede the invitation deadline');
    await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.02) FROM community_event_waitlist WHERE event_id=$1 AND member_ref=$2',[id,invitee.user_id]);
    assert.equal((await pool.query<{expired:boolean}>('SELECT expires_at<=clock_timestamp() AS expired FROM community_event_waitlist WHERE event_id=$1 AND member_ref=$2',[id,invitee.user_id])).rows[0].expired,true);
    await blocker.query('ROLLBACK');
  }finally{try{await rollbackEventBlocker(blocker);}finally{await Promise.allSettled([otherPending,inviteePending].filter((pending):pending is Promise<{error:Problem|null}>=>pending!==undefined));}}
  const [otherResult,inviteeResult]=await Promise.all([otherPending!,inviteePending!]);
  assert.equal(otherResult.error,null);
  assert.equal(inviteeResult.error?.status,409);
  assert.equal(inviteeResult.error?.code,'event_full');
  assert.equal(await countEventSeats(pool,id),1);
});


test('an expired guest hold does not share the last seat after the event lock wait',async()=>{
  async function member(email:string,name:string){
    const id=randomUUID();
    await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required,onboarding_completed_at,email_verified_at)
      SELECT $1,community_id,$2,$3,password_hash,$4,false,now(),now() FROM users WHERE user_id=$5`,[id,email,name,randomUUID(),DEMO_USERS[0].user_id]);
    return (await login(pool,email,DEMO_PASSWORD)).actor;
  }
  const organizer=await member('hold-organizer@example.test','主辦');
  const other=await member('hold-other@example.test','其他人');
  const id=randomUUID();
  const email='held-guest@example.test';
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,capacity,state,visibility)
    VALUES($1,$2,$3,'來賓名額','隔離鎖等待',$4,$5,'in_person','合成場地',1,'published','open')`,[id,DEMO_COMMUNITY,organizer.user_id,start,new Date(start.getTime()+3600000)]);
  await pool.query(`INSERT INTO community_event_guest_rsvps(event_id,email,name,state,created_at)
    VALUES($1,$2,'合成來賓','pending',clock_timestamp())`,[id,email]);
  const blocker=await pool.connect();
  const settle=(pending:Promise<unknown>)=>pending.then(()=>({error:null as Problem|null}),error=>{assert.ok(error instanceof Problem);return {error};});
  let memberPending:Promise<{error:Problem|null}>|undefined,guestPending:Promise<{error:Problem|null}>|undefined;
  try{
    await blocker.query('BEGIN');
    await blocker.query('SELECT event_id FROM community_events WHERE event_id=$1 FOR UPDATE',[id]);
    const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    memberPending=settle(setRsvp(pool,{actor:other,operation:`events/${id}/rsvp`,key:randomUUID(),body:{going:true}},id));
    await waitForEventLockCount(pid,1);
    guestPending=settle(registerPublicEvent(pool,id,{name:'合成來賓',email},async()=>{},'http://127.0.0.1:4310'));
    const waiters=await waitForEventLockCount(pid,2);
    const deadline=(await pool.query<{expires_at:Date}>("UPDATE community_event_guest_rsvps SET created_at=clock_timestamp()-interval '9 minutes 58 seconds' WHERE event_id=$1 AND email=$2 RETURNING created_at+interval '10 minutes' AS expires_at",[id,email])).rows[0].expires_at;
    assert.ok(waiters.every(waiter=>waiter.xact_start.getTime()<deadline.getTime()),'both transaction clocks must precede the guest-hold deadline');
    await pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM created_at+interval '10 minutes'-clock_timestamp()))+0.02) FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2",[id,email]);
    assert.equal((await pool.query<{expired:boolean}>("SELECT created_at<=clock_timestamp()-interval '10 minutes' AS expired FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2",[id,email])).rows[0].expired,true);
    await blocker.query('ROLLBACK');
  }finally{try{await rollbackEventBlocker(blocker);}finally{await Promise.allSettled([memberPending,guestPending].filter((pending):pending is Promise<{error:Problem|null}>=>pending!==undefined));}}
  const [memberResult,guestResult]=await Promise.all([memberPending!,guestPending!]);
  assert.equal(memberResult.error,null);
  assert.equal(guestResult.error?.status,409);
  assert.equal(guestResult.error?.code,'event_full');
  assert.equal(await countEventSeats(pool,id),1);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM community_event_guest_rsvps WHERE event_id=$1 AND state='going'`,[id])).rows[0].n,0);
});


for(const expires of [true,false])test(`guest provider handoff checks its live hold after the second event wait (expires=${expires})`,async()=>{
  const guest={name:'合成交接訪客',email:'dispatch-hold@local.test'};
  await pool.query("UPDATE community_events SET visibility='referral',location='https://example.test/private-location',online_url='https://example.test/private-joining' WHERE event_id=$1",[eventId]);
  const {code}=await getEventShareCode(pool,actor(0),eventId);
  const first=await pool.connect(),second=await pool.connect();
  let pending:Promise<{value:unknown;error:unknown}>|undefined,secondLock:Promise<unknown>|undefined,providerCalls=0;
  try{
    await first.query('BEGIN');await first.query('SELECT event_id FROM community_events WHERE event_id=$1 FOR UPDATE',[eventId]);
    const firstPid=(await first.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    pending=registerPublicEvent(pool,eventId,{...guest,referral_code:code},async(_to,_subject,body)=>{
      providerCalls++;assert.ok(body.includes('https://example.test/private-location'));assert.ok(body.includes('https://example.test/private-joining'));
    },'https://example.test').then(value=>({value,error:null}),error=>({value:null,error}));
    await waitForEventLockCount(firstPid,1);
    // Queue this barrier after admission, so it holds the event only during the confirmation transaction.
    await second.query('BEGIN');const secondPid=(await second.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    secondLock=second.query('SELECT event_id FROM community_events WHERE event_id=$1 FOR UPDATE',[eventId]);
    void secondLock.catch(()=>{});
    await waitForEventLockCount(firstPid,2);
    await first.query('ROLLBACK');await secondLock;
    const waiters=await waitForEventLockCount(secondPid,1);
    const hold=(await pool.query<{expires_at:Date;registration_attempt_id:string}>(`UPDATE community_event_guest_rsvps
      SET created_at=clock_timestamp()-interval '10 minutes'+make_interval(secs=>$3)
      WHERE event_id=$1 AND email=$2 AND state='pending' RETURNING created_at+interval '10 minutes' AS expires_at,registration_attempt_id`,[eventId,guest.email,expires?1:60])).rows[0];
    assert.ok(hold);assert.ok(waiters.every(waiter=>waiter.xact_start.getTime()<hold.expires_at.getTime()));
    if(expires)await pool.query("SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM created_at+interval '10 minutes'-clock_timestamp()))+0.02) FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2",[eventId,guest.email]);
    else await delay(1100);
    assert.equal((await pool.query<{live:boolean}>("SELECT created_at>clock_timestamp()-interval '10 minutes' AS live FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2",[eventId,guest.email])).rows[0].live,!expires);
    assert.equal(providerCalls,0);await second.query('ROLLBACK');const result=await pending;
    assert.equal(providerCalls,expires?0:1);
    if(expires){assert.ok(result.error instanceof Problem);assert.equal(result.error.code,'event_closed');assert.equal(result.error.status,409);}
    else{assert.equal(result.error,null);assert.deepEqual(result.value,{registered:true,provider_status:'provider_accepted'});}
    const current=(await pool.query<{state:string;email_sent_at:Date|null;registration_attempt_id:string}>('SELECT state,email_sent_at,registration_attempt_id FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,guest.email])).rows[0];
    assert.equal(current.state,expires?'pending':'going');assert.equal(current.email_sent_at===null,expires);assert.equal(current.registration_attempt_id,hold.registration_attempt_id);
  }finally{
    try{await rollbackEventBlocker(first);}finally{
      try{await rollbackEventBlocker(second);}finally{await Promise.allSettled([pending,secondLock].filter((operation):operation is Promise<unknown>=>operation!==undefined));}
    }
  }
});

for(const participationEnabled of [false,true])for(const previouslyConfirmed of [false,true])test(`guest confirmation cannot cross start during provider wait (participation=${participationEnabled}, prior=${previouslyConfirmed})`,async()=>{
  const guest={name:'合成截止訪客',email:'provider-deadline@local.test'};
  if(previouslyConfirmed)await registerPublicEvent(pool,eventId,guest,async()=>{},'https://example.test',participationEnabled);
  const previous=(await pool.query<{state:string;email_sent_at:Date|null}>('SELECT state,email_sent_at FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,guest.email])).rows[0];
  let providerCalls=0,returnedAfterStart=false,connects=0,releases=0,providerClient:PoolClient|undefined;
  const providerPool={async connect(){
    const client=await pool.connect();connects++;providerClient=client;
    return {query:client.query.bind(client),release(destroy?:boolean){providerClient=undefined;releases++;client.release(destroy);}};
  }} as unknown as Pool;
  await assert.rejects(registerPublicEvent(providerPool,eventId,guest,async()=>{
    providerCalls++;
    assert.ok(providerClient);
    // Establish the real deadline only once dispatch begins, on the native client already holding the event lock.
    // The transaction helper retains BEGIN/ROLLBACK/release; no clock or product query is replaced.
    await providerClient.query("UPDATE community_events SET starts_at=clock_timestamp()+interval '3 seconds',ends_at=clock_timestamp()+interval '1 hour' WHERE event_id=$1",[eventId]);
    await providerClient.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM starts_at-clock_timestamp()))+0.02) FROM community_events WHERE event_id=$1',[eventId]);
    returnedAfterStart=(await providerClient.query<{started:boolean}>('SELECT starts_at<=clock_timestamp() AS started FROM community_events WHERE event_id=$1',[eventId])).rows[0].started;
  },'https://example.test',participationEnabled),cause=>cause instanceof Problem&&cause.status===409&&cause.code==='event_closed');
  assert.equal(providerCalls,1);assert.equal(returnedAfterStart,true);
  assert.equal(connects,2);assert.equal(releases,2);assert.equal(providerClient,undefined);
  const current=(await pool.query<{state:string;email_sent_at:Date|null}>('SELECT state,email_sent_at FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,guest.email])).rows[0];
  assert.equal(current.state,previouslyConfirmed?'going':'pending');assert.deepEqual(current.email_sent_at,previous?.email_sent_at??null);
});

test('guest confirmation rejects start reached while provider acceptance bookkeeping waits',async()=>{
  const guest={name:'合成鎖等待訪客',email:'bookkeeping-deadline@local.test'},blocker=await pool.connect();
  let providerCalls=0,inTransaction=false;
  try{
    await blocker.query('BEGIN');inTransaction=true;
    const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    await pool.query("UPDATE community_events SET starts_at=clock_timestamp()+interval '3 seconds',ends_at=clock_timestamp()+interval '1 hour' WHERE event_id=$1",[eventId]);
    const confirmation=registerPublicEvent(pool,eventId,guest,async()=>{
      providerCalls++;
      await blocker.query('SELECT email FROM community_event_guest_capabilities WHERE event_id=$1 AND email=$2 FOR UPDATE',[eventId,guest.email]);
    },'https://example.test',true);
    const rejected=assert.rejects(confirmation,cause=>cause instanceof Problem&&cause.status===409&&cause.code==='event_closed');
    let waiting=false;
    for(let attempt=0;attempt<100&&!waiting;attempt++){
      waiting=(await pool.query<{waiting:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;
      if(!waiting)await delay(10);
    }
    assert.equal(waiting,true,'provider acceptance update must reach the owned row lock');
    await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM starts_at-clock_timestamp()))+0.02) FROM community_events WHERE event_id=$1',[eventId]);
    await blocker.query('ROLLBACK');inTransaction=false;await rejected;assert.equal(providerCalls,1);
    const current=(await pool.query<{state:string;email_sent_at:Date|null}>('SELECT state,email_sent_at FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,guest.email])).rows[0];
    assert.equal(current.state,'pending');assert.equal(current.email_sent_at,null);
  }finally{if(inTransaction)await blocker.query('ROLLBACK');blocker.release();}
});

test('the original RSVP consumes its own invitation rather than allocating a second seat',async()=>{
  const current=await readEventParticipation(pool,actor(1),eventId);
  const join=memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'join'},current.event_version);
  const invited=await mutateEventWaitlist(pool,join,eventId);assert.equal(invited.waitlist?.status,'invited');
  await setRsvp(pool,memberCommand(1,`POST /events/${eventId}/rsvp`,{going:true}),eventId,true);
  assert.equal((await readEventParticipation(pool,actor(1),eventId)).waitlist?.status,'accepted');
  assert.equal(await countEventSeats(pool,eventId),1);
  await setRsvp(pool,memberCommand(1,`POST /events/${eventId}/rsvp`,{going:false}),eventId,true);
  assert.equal(await countEventSeats(pool,eventId),0);
});

for(const participationEnabled of [false,true])for(const previous of ['missing','cancelled'] as const)test(`public guest registration consumes its own invitation with a ${previous} RSVP (participation=${participationEnabled})`,async()=>{
  const email='invited-public@local.test',token=await capability(email);
  if(previous==='cancelled')await pool.query("INSERT INTO community_event_guest_rsvps(event_id,email,name,state) VALUES($1,$2,'合成訪客','cancelled')",[eventId,email]);
  assert.equal((await action(token,'join')).result.waitlist?.status,'invited');
  let sent=0;
  const result=await registerPublicEvent(pool,eventId,{name:'合成訪客',email:email.toUpperCase()},async to=>{assert.equal(to,email);sent++;},'https://example.test',participationEnabled);
  assert.deepEqual(result,{registered:true,provider_status:'provider_accepted'});assert.equal(sent,1);
  const current=await readGuestEventParticipation(pool,eventId,token);
  assert.equal(current.rsvp_state,'going');assert.equal(current.waitlist?.status,'accepted');
  assert.equal(await countEventSeats(pool,eventId),1);
  assert.equal((await pool.query('SELECT count(*)::int AS count FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,email])).rows[0].count,1);
  await pool.query("UPDATE community_event_waitlist SET invited_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1 AND guest_email=$2",[eventId,email]);
  await transaction(pool,q=>reconcileEventWaitlist(q,eventId));
  assert.equal((await readGuestEventParticipation(pool,eventId,token)).waitlist?.status,'accepted');
});

for(const policyDisabled of [false,true])for(const participationEnabled of [false,true])for(const firstProviderAccepted of [false,true])test(`a live guest hold protects its credited offer across admission and confirmation (policyDisabled=${policyDisabled}, participation=${participationEnabled}, firstProviderAccepted=${firstProviderAccepted})`,async()=>{
  const email='gap-public@local.test',token=await capability(email),next=await capability('gap-next@local.test');
  await action(token,'join');await action(next,'join');
  const invitation=(await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,email])).rows[0].invitation_id;
  let connects=0,sends=0,gapDeliveries=0,gapStatus:string|undefined;
  const gapPool={async connect(){
    if(++connects===2){
      if(policyDisabled){
        const current=await readEventParticipation(pool,actor(0),eventId);
        await setEventWaitlistPolicy(pool,memberCommand(0,`PATCH /events/${eventId}/waitlist-policy`,{waitlist_enabled:false,response_window_minutes:null},current.event_version),eventId);
        await processEventWaitlist(pool,async()=>{gapDeliveries++;},'https://example.test',undefined,eventId);
      }else{
        await pool.query("UPDATE community_event_waitlist SET invited_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1 AND guest_email=$2",[eventId,email]);
        await transaction(pool,q=>reconcileEventWaitlist(q,eventId));
      }
      gapStatus=(await pool.query('SELECT status FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,email])).rows[0].status;
      assert.equal((await pool.query('SELECT state FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,email])).rows[0].state,'pending');
    }
    return pool.connect();
  }} as unknown as Pool;
  const run=()=>registerPublicEvent(gapPool,eventId,{name:'合成交易間隔訪客',email},async()=>{
    sends++;if(sends===1&&!firstProviderAccepted)throw Error('synthetic provider rejection');
  },'https://example.test',participationEnabled);
  if(!firstProviderAccepted){
    await assert.rejects(run,error=>error instanceof Problem&&error.status===503&&error.code==='event_email_delivery_failed');
    assert.equal((await pool.query('SELECT state FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,email])).rows[0].state,'pending');
  }
  assert.deepEqual(await run(),{registered:true,provider_status:'provider_accepted'});
  const current=await readGuestEventParticipation(pool,eventId,token);
  assert.equal(current.rsvp_state,'going');assert.equal(current.waitlist?.status,'accepted');
  assert.equal(gapStatus,'invited');assert.equal(sends,firstProviderAccepted?1:2);assert.equal(gapDeliveries,0);
  assert.equal((await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,email])).rows[0].invitation_id,invitation);
  assert.equal((await readGuestEventParticipation(pool,eventId,next)).waitlist?.status,policyDisabled?'cancelled':'queued');
  assert.equal(await countEventSeats(pool,eventId),1);
});

test('a policy-blocked unsent claim becomes dispatchable once after a failed public registration and re-enable',async()=>{
  const email='claimed-hold@local.test',token=await capability(email);await action(token,'join');
  let publicSends=0;
  await assert.rejects(registerPublicEvent(pool,eventId,{name:'合成已入場訪客',email},async()=>{
    publicSends++;throw Error('synthetic public provider rejection');
  },'https://example.test',true),cause=>cause instanceof Problem&&cause.status===503&&cause.code==='event_email_delivery_failed');
  const invitation=(await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,email])).rows[0].invitation_id;
  let connects=0,sends=0;
  const gapPool={query:pool.query.bind(pool),async connect(){
    if(++connects===3){
      assert.equal((await readGuestEventParticipation(pool,eventId,token)).waitlist?.delivery_status,'unknown');
      const current=await readEventParticipation(pool,actor(0),eventId);
      await setEventWaitlistPolicy(pool,memberCommand(0,`PATCH /events/${eventId}/waitlist-policy`,{waitlist_enabled:false,response_window_minutes:null},current.event_version),eventId);
    }
    return pool.connect();
  }} as unknown as Pool;
  await processEventWaitlist(gapPool,async()=>{sends++;},'https://example.test',undefined,eventId);
  const current=await readGuestEventParticipation(pool,eventId,token);
  assert.equal(sends,0);assert.equal(current.rsvp_state,'pending');assert.equal(current.waitlist?.status,'invited');
  assert.equal(publicSends,1);assert.equal(current.waitlist?.delivery_status,'pending');assert.equal(await countEventSeats(pool,eventId),1);
  await setEventWaitlistPolicy(pool,memberCommand(0,`PATCH /events/${eventId}/waitlist-policy`,{waitlist_enabled:true,response_window_minutes:30},current.event_version),eventId);
  const send=async(to:string)=>{assert.equal(to,email);sends++;};
  assert.equal((await processEventWaitlist(pool,send,'https://example.test',undefined,eventId)).provider_accepted,1);
  assert.equal((await processEventWaitlist(pool,send,'https://example.test',undefined,eventId)).provider_accepted,0);
  const delivered=await readGuestEventParticipation(pool,eventId,token);
  assert.equal(sends,1);assert.equal(delivered.waitlist?.delivery_status,'provider_accepted');assert.equal(delivered.waitlist?.status,'invited');assert.equal(delivered.rsvp_state,'pending');
  assert.equal((await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,email])).rows[0].invitation_id,invitation);
  assert.equal(await countEventSeats(pool,eventId),1);
});

test('a possibly-sent unknown invitation is not reset or retried by a policy round trip',async()=>{
  const email='possibly-sent@local.test',token=await capability(email);await action(token,'join');
  await pool.query("INSERT INTO community_event_guest_rsvps(event_id,email,name,state,created_at) VALUES($1,$2,'合成已入場訪客','pending',clock_timestamp())",[eventId,email]);
  await pool.query(`CREATE FUNCTION reject_invitation_bookkeeping() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.delivery_status='provider_accepted' THEN RAISE EXCEPTION 'synthetic bookkeeping failure'; END IF; RETURN NEW; END $$`);
  await pool.query('CREATE TRIGGER reject_invitation_bookkeeping BEFORE UPDATE ON community_event_waitlist FOR EACH ROW EXECUTE FUNCTION reject_invitation_bookkeeping()');
  let sends=0;const send=async()=>{sends++;};
  try{
    await assert.rejects(processEventWaitlist(pool,send,'https://example.test',undefined,eventId),/synthetic bookkeeping failure/);
  }finally{
    await pool.query('DROP TRIGGER reject_invitation_bookkeeping ON community_event_waitlist');
    await pool.query('DROP FUNCTION reject_invitation_bookkeeping()');
  }
  assert.equal((await readGuestEventParticipation(pool,eventId,token)).waitlist?.delivery_status,'unknown');
  for(const enabled of [false,true]){
    const current=await readGuestEventParticipation(pool,eventId,token);
    await setEventWaitlistPolicy(pool,memberCommand(0,`PATCH /events/${eventId}/waitlist-policy`,{waitlist_enabled:enabled,response_window_minutes:enabled?30:null},current.event_version),eventId);
    await processEventWaitlist(pool,send,'https://example.test',undefined,eventId);
  }
  const current=await readGuestEventParticipation(pool,eventId,token);
  assert.equal(sends,1);assert.equal(current.waitlist?.delivery_status,'unknown');assert.equal(current.waitlist?.status,'invited');assert.equal(await countEventSeats(pool,eventId),1);
});

for(const gate of ['expired','started','cancelled','ineligible','replaced'] as const)test(`policy rollback leaves a ${gate} claim unknown`,async()=>{
  const email='blocked-claim@local.test',token=await capability(email);await action(token,'join');
  await pool.query("INSERT INTO community_event_guest_rsvps(event_id,email,name,state,created_at) VALUES($1,$2,'合成已入場訪客','pending',clock_timestamp())",[eventId,email]);
  let connects=0,sends=0;
  const gapPool={query:pool.query.bind(pool),async connect(){
    if(++connects===3){
      const current=await readEventParticipation(pool,actor(0),eventId);
      await setEventWaitlistPolicy(pool,memberCommand(0,`PATCH /events/${eventId}/waitlist-policy`,{waitlist_enabled:false,response_window_minutes:null},current.event_version),eventId);
      if(gate==='expired')await pool.query("UPDATE community_event_waitlist SET invited_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",[eventId]);
      if(gate==='started')await pool.query("UPDATE community_events SET starts_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",[eventId]);
      if(gate==='cancelled')await pool.query("UPDATE community_events SET state='cancelled' WHERE event_id=$1",[eventId]);
      if(gate==='ineligible')await pool.query('UPDATE community_event_guest_capabilities SET verified_at=NULL WHERE event_id=$1',[eventId]);
      if(gate==='replaced')await pool.query('UPDATE community_event_waitlist SET invitation_id=$2 WHERE event_id=$1',[eventId,randomUUID()]);
    }
    return pool.connect();
  }} as unknown as Pool;
  await processEventWaitlist(gapPool,async()=>{sends++;},'https://example.test',undefined,eventId);
  assert.equal(sends,0);
  assert.equal((await pool.query('SELECT delivery_status FROM community_event_waitlist WHERE event_id=$1',[eventId])).rows[0].delivery_status,'unknown');
});

for(const closed of ['started','cancelled'] as const)test(`a ${closed} event cancels an invitation despite its guest admission hold`,async()=>{
  const email='closed-hold@local.test',token=await capability(email);await action(token,'join');
  await pool.query("INSERT INTO community_event_guest_rsvps(event_id,email,name,state,created_at) VALUES($1,$2,'合成已入場訪客','pending',clock_timestamp())",[eventId,email]);
  if(closed==='started')await pool.query("UPDATE community_events SET starts_at=clock_timestamp()-interval '1 minute' WHERE event_id=$1",[eventId]);
  else{
    const current=await readEventParticipation(pool,actor(0),eventId);
    await cancelEvent(pool,memberCommand(0,`POST /events/${eventId}/cancel`,{},current.event_version),eventId,true);
  }
  await transaction(pool,q=>reconcileEventWaitlist(q,eventId));
  assert.equal((await readGuestEventParticipation(pool,eventId,token)).waitlist?.status,'cancelled');
});

test('an expired guest hold cannot extend an expired offer or block the next candidate',async()=>{
  const email='old-hold-offer@local.test',first=await capability(email),next=await capability('old-hold-next@local.test');
  await action(first,'join');await action(next,'join');
  await pool.query("INSERT INTO community_event_guest_rsvps(event_id,email,name,state,created_at) VALUES($1,$2,'合成過期保留','pending',clock_timestamp()-interval '11 minutes')",[eventId,email]);
  await pool.query("UPDATE community_event_waitlist SET invited_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1 AND guest_email=$2",[eventId,email]);
  await transaction(pool,q=>reconcileEventWaitlist(q,eventId));
  assert.equal((await readGuestEventParticipation(pool,eventId,first)).waitlist?.status,'expired');
  assert.equal((await pool.query('SELECT state FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2',[eventId,email])).rows[0].state,'cancelled');
  assert.equal((await readGuestEventParticipation(pool,eventId,next)).waitlist?.status,'invited');
  assert.equal(await countEventSeats(pool,eventId),1);
});

test('public guest registration cannot consume another guest invitation or an expired offer reassigned to the next guest',async()=>{
  const email='expired-public@local.test',first=await capability(email),second=await capability('next-public@local.test');
  await action(first,'join');await action(second,'join');
  let sent=0;
  await assert.rejects(registerPublicEvent(pool,eventId,{name:'合成訪客',email:'uninvited@local.test'},async()=>{sent++;},'https://example.test',true),error=>error instanceof Problem&&error.code==='event_full');
  await pool.query("UPDATE community_event_waitlist SET invited_at=now()-interval '2 seconds',expires_at=now()-interval '1 second' WHERE event_id=$1 AND guest_email=$2",[eventId,email]);
  await transaction(pool,q=>reconcileEventWaitlist(q,eventId));
  await assert.rejects(registerPublicEvent(pool,eventId,{name:'合成訪客',email},async()=>{sent++;},'https://example.test',true),error=>error instanceof Problem&&error.code==='event_full');
  assert.equal(sent,0);assert.equal(await countEventSeats(pool,eventId),1);
  assert.equal((await readGuestEventParticipation(pool,eventId,first)).waitlist?.status,'expired');
  assert.equal((await readGuestEventParticipation(pool,eventId,second)).waitlist?.status,'invited');
  assert.equal((await pool.query('SELECT 1 FROM community_event_guest_rsvps WHERE event_id=$1',[eventId])).rowCount,0);
});

test('rejoining after withdrawal starts at the back and the factual history survives row reuse',async()=>{
  await setRsvp(pool,memberCommand(0,`POST /events/${eventId}/rsvp`,{going:true}),eventId,true);
  const first=await capability('rejoin-first@local.test'),second=await capability('rejoin-second@local.test');
  await action(first,'join');await action(second,'join');await action(first,'cancel');await action(first,'join');
  await setRsvp(pool,memberCommand(0,`POST /events/${eventId}/rsvp`,{going:false}),eventId,true);
  assert.equal((await readGuestEventParticipation(pool,eventId,second)).waitlist?.status,'invited');
  assert.equal((await readGuestEventParticipation(pool,eventId,first)).waitlist?.status,'queued');
  const history=(await pool.query(`SELECT t.from_status,t.to_status FROM community_event_waitlist_transitions t
    JOIN community_event_waitlist w USING(entry_id) WHERE w.event_id=$1 AND w.guest_email=$2 ORDER BY t.transition_id`,[eventId,'rejoin-first@local.test'])).rows;
  assert.deepEqual(history.map(row=>[row.from_status,row.to_status]),[[null,'queued'],['queued','left'],['left','queued']]);
});

test('a no-op join with a new key preserves the queue and does not manufacture a second event transition',async()=>{
  await setRsvp(pool,memberCommand(0,`POST /events/${eventId}/rsvp`,{going:true}),eventId,true);
  const before=await readEventParticipation(pool,actor(1),eventId);
  const joined=await mutateEventWaitlist(pool,memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'join'},before.event_version),eventId);
  const repeated=await mutateEventWaitlist(pool,memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'join'},joined.event_version),eventId);
  assert.deepEqual(repeated,joined);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM transition_journal WHERE aggregate_type='community_event' AND aggregate_id=$1 AND actor_ref=$2",[eventId,DEMO_USERS[1].user_id])).rows[0].count,1);
});

test('capacity reduction retracts the newest invitation without cancelling a confirmed RSVP',async()=>{
  await pool.query('UPDATE community_events SET capacity=3 WHERE event_id=$1',[eventId]);
  await setRsvp(pool,memberCommand(0,`POST /events/${eventId}/rsvp`,{going:true}),eventId,true);
  const first=await capability('capacity-first@local.test'),second=await capability('capacity-second@local.test');
  await action(first,'join');await action(second,'join');
  const current=await readEventParticipation(pool,actor(0),eventId);
  await updateEventSchedule(pool,memberCommand(0,`PATCH /events/${eventId}/schedule`,{starts_at:start.toISOString(),ends_at:new Date(start.getTime()+3600000).toISOString(),capacity:2},current.event_version),eventId);
  assert.equal((await readGuestEventParticipation(pool,eventId,first)).waitlist?.status,'invited');
  assert.equal((await readGuestEventParticipation(pool,eventId,second)).waitlist?.status,'queued');
  assert.equal((await readEventParticipation(pool,actor(0),eventId)).rsvp_state,'going');
  assert.equal(await countEventSeats(pool,eventId),2);
});

test('capacity reduction respects an admitted guest hold instead of retaining an extra unconsumed invitation',async()=>{
  await pool.query('UPDATE community_events SET capacity=3 WHERE event_id=$1',[eventId]);
  await setRsvp(pool,memberCommand(0,`POST /events/${eventId}/rsvp`,{going:true}),eventId,true);
  const older=await capability('capacity-unconsumed@local.test'),email='capacity-admitted@local.test',held=await capability(email);
  await action(older,'join');await action(held,'join');
  const invitation=(await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,email])).rows[0].invitation_id;
  let connects=0;
  const gapPool={async connect(){
    if(++connects===2){
      const current=await readEventParticipation(pool,actor(0),eventId);
      await updateEventSchedule(pool,memberCommand(0,`PATCH /events/${eventId}/schedule`,{starts_at:start.toISOString(),ends_at:new Date(start.getTime()+3600000).toISOString(),capacity:2},current.event_version),eventId);
      assert.equal(await countEventSeats(pool,eventId),2);
    }
    return pool.connect();
  }} as unknown as Pool;
  await registerPublicEvent(gapPool,eventId,{name:'合成已入場訪客',email},async()=>{},'https://example.test',true);
  assert.equal((await readGuestEventParticipation(pool,eventId,older)).waitlist?.status,'queued');
  assert.equal((await readGuestEventParticipation(pool,eventId,held)).waitlist?.status,'accepted');
  assert.equal((await pool.query('SELECT invitation_id FROM community_event_waitlist WHERE event_id=$1 AND guest_email=$2',[eventId,email])).rows[0].invitation_id,invitation);
  assert.equal((await readEventParticipation(pool,actor(0),eventId)).rsvp_state,'going');
  assert.equal(await countEventSeats(pool,eventId),2);
});

test('event cancellation stops unsent invitations and retains cancellation history without sending stale offers',async()=>{
  const token=await capability('cancelled-offer@local.test');await action(token,'join');
  const current=await readEventParticipation(pool,actor(0),eventId);
  await cancelEvent(pool,memberCommand(0,`POST /events/${eventId}/cancel`,{},current.event_version),eventId,true);
  let calls=0;
  const processed=await processEventWaitlist(pool,async()=>{calls++;},'https://example.test');
  const own=await readGuestEventParticipation(pool,eventId,token);
  assert.equal(own.event_state,'cancelled');assert.equal(own.waitlist?.status,'cancelled');
  assert.equal(calls,1);assert.equal(processed.provider_accepted,1);
  assert.equal((await pool.query("SELECT count(*)::int AS count FROM community_event_waitlist WHERE event_id=$1 AND status='invited'",[eventId])).rows[0].count,0);
});

test('bounded sweeps rotate past full queues instead of starving a later expired invitation',async()=>{
  const ids=[eventId,...Array.from({length:100},()=>randomUUID())].sort();
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,capacity,state,visibility,waitlist_enabled,response_window_minutes)
    SELECT id,$2,$3,'合成滿額活動','有界輪詢驗證',$4,$5,'online','合成地址',1,'published','open',true,30 FROM unnest($1::uuid[]) id`,
  [ids.filter(id=>id!==eventId),DEMO_COMMUNITY,DEMO_USERS[0].user_id,start,new Date(start.getTime()+3600000)]);
  await pool.query(`INSERT INTO community_event_rsvps(rsvp_id,event_id,user_id,state,confirmed_at)
    SELECT ids.rsvp_id,ids.event_id,$3,'going',now() FROM unnest($1::uuid[],$2::uuid[]) AS ids(rsvp_id,event_id)`,
  [ids.map(()=>randomUUID()),ids,DEMO_USERS[0].user_id]);
  const now=new Date(),last=ids.at(-1)!;
  await pool.query(`INSERT INTO community_event_waitlist(entry_id,event_id,member_ref,status,joined_at,invitation_id,invited_at,expires_at,delivery_status)
    SELECT ids.entry_id,ids.event_id,$3,CASE WHEN ids.event_id=$4 THEN 'invited' ELSE 'queued' END,$5,
      CASE WHEN ids.event_id=$4 THEN $6::uuid END,CASE WHEN ids.event_id=$4 THEN $7::timestamptz END,
      CASE WHEN ids.event_id=$4 THEN $8::timestamptz END,CASE WHEN ids.event_id=$4 THEN 'recorded' ELSE 'pending' END
    FROM unnest($1::uuid[],$2::uuid[]) AS ids(entry_id,event_id)`,
  [ids.map(()=>randomUUID()),ids,DEMO_USERS[1].user_id,last,new Date(now.getTime()-3600000),randomUUID(),new Date(now.getTime()-1801000),new Date(now.getTime()-1000)]);
  const noGuestMail=async()=>{throw new Error('No guest source in this fixture');};
  await processEventWaitlist(pool,noGuestMail,'https://example.test',now);
  assert.equal((await readEventParticipation(pool,actor(1),last)).waitlist?.status,'invited');
  assert.equal((await pool.query('SELECT max(aggregate_version)::int AS version FROM community_events WHERE event_id=ANY($1::uuid[])',[ids])).rows[0].version,1);
  await processEventWaitlist(pool,noGuestMail,'https://example.test',now);
  assert.equal((await readEventParticipation(pool,actor(1),last)).waitlist?.status,'expired');
  assert.equal(await countEventSeats(pool,last,now),1);
});

async function acceptanceSnapshot(){
  return (await pool.query<{snapshot:unknown}>(`SELECT jsonb_build_object(
    'event',(SELECT aggregate_version FROM community_events WHERE event_id=$1),
    'waitlist',(SELECT jsonb_agg(to_jsonb(w) ORDER BY entry_id) FROM community_event_waitlist w WHERE event_id=$1),
    'transitions',(SELECT jsonb_agg(to_jsonb(t) ORDER BY transition_id) FROM community_event_waitlist_transitions t JOIN community_event_waitlist w USING(entry_id) WHERE w.event_id=$1),
    'member_rsvps',(SELECT jsonb_agg(to_jsonb(r) ORDER BY rsvp_id) FROM community_event_rsvps r WHERE event_id=$1),
    'guest_rsvps',(SELECT jsonb_agg(to_jsonb(r) ORDER BY email) FROM community_event_guest_rsvps r WHERE event_id=$1),
    'member_receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY idempotency_key) FROM command_receipts r WHERE operation=$2),
    'guest_receipts',(SELECT jsonb_agg(to_jsonb(r) ORDER BY command_id) FROM community_event_guest_commands r WHERE event_id=$1),
    'journal',(SELECT jsonb_agg(to_jsonb(t) ORDER BY transition_id) FROM transition_journal t WHERE aggregate_id=$1)
  ) AS snapshot`,[eventId,`POST /events/${eventId}/waitlist`])).rows[0].snapshot;
}

for(const kind of ['member','guest'] as const)for(const phase of ['reconcile','rsvp','receipt'] as const)test(`${kind} acceptance rolls back when invitation expires during ${phase}`,async()=>{
  const email='crossing-deadline@local.test',oldEmail='old-reservation@local.test',token=kind==='guest'?await capability(email):null;
  if(token)await action(token,'join');
  else{
    const current=await readEventParticipation(pool,actor(1),eventId);
    await mutateEventWaitlist(pool,memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'join'},current.event_version),eventId);
  }
  await pool.query("INSERT INTO community_event_guest_rsvps(event_id,email,name,state,created_at) VALUES($1,$2,'合成舊預留','pending',clock_timestamp()-interval '11 minutes')",[eventId,oldEmail]);
  if(kind==='guest'&&phase==='rsvp')await pool.query("INSERT INTO community_event_guest_rsvps(event_id,email,name,state) VALUES($1,$2,'合成取消報名','cancelled')",[eventId,email]);
  const current=token?await readGuestEventParticipation(pool,eventId,token):await readEventParticipation(pool,actor(1),eventId);
  const input=memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'accept'},current.event_version),blocker=await pool.connect();
  let pending:Promise<{value:EventParticipation}|{error:unknown}>|undefined;
  try{
    await blocker.query('BEGIN');
    const pid=(await blocker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    if(phase==='reconcile')await blocker.query('SELECT email FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2 FOR UPDATE',[eventId,oldEmail]);
    if(phase==='rsvp'&&kind==='guest')await blocker.query('SELECT email FROM community_event_guest_rsvps WHERE event_id=$1 AND email=$2 FOR UPDATE',[eventId,email]);
    if(phase==='rsvp'&&kind==='member')await blocker.query('LOCK TABLE community_event_rsvps IN SHARE MODE');
    if(phase==='receipt')await blocker.query(`LOCK TABLE ${kind==='guest'?'community_event_guest_commands':'command_receipts'} IN SHARE MODE`);
    await pool.query("UPDATE community_event_waitlist SET expires_at=clock_timestamp()+interval '3 seconds' WHERE event_id=$1",[eventId]);
    const before=await acceptanceSnapshot();
    pending=(token?mutateGuestEventParticipation(pool,eventId,token,{action:'accept',expected_version:current.event_version},input.key):mutateEventWaitlist(pool,input,eventId))
      .then(value=>({value}),(error:unknown)=>({error}));
    let waiting=false;
    for(let attempt=0;attempt<100&&!waiting;attempt++){
      waiting=(await pool.query<{waiting:boolean}>('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',[pid])).rows[0].waiting;
      if(!waiting)await delay(10);
    }
    assert.equal(waiting,true,'acceptance reaches the owned PostgreSQL blocker');
    await pool.query('SELECT pg_sleep(GREATEST(0,EXTRACT(EPOCH FROM expires_at-clock_timestamp()))+0.02) FROM community_event_waitlist WHERE event_id=$1',[eventId]);
    await blocker.query('ROLLBACK');
    const outcome=await pending;assert.ok('error' in outcome);
    assert.ok(outcome.error instanceof Problem);assert.equal(outcome.error.status,409);assert.equal(outcome.error.code,'invitation_unavailable');
    assert.deepEqual(await acceptanceSnapshot(),before);
  }finally{await blocker.query('ROLLBACK');blocker.release();if(pending)await pending;}
});

for(const kind of ['member','guest'] as const)test(`${kind} accepted history remains replayable after its invitation deadline`,async()=>{
  const token=kind==='guest'?await capability('accepted-history@local.test'):null;
  if(token)await action(token,'join');
  else{
    const current=await readEventParticipation(pool,actor(1),eventId);
    await mutateEventWaitlist(pool,memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'join'},current.event_version),eventId);
  }
  const current=token?await readGuestEventParticipation(pool,eventId,token):await readEventParticipation(pool,actor(1),eventId);
  const input=memberCommand(1,`POST /events/${eventId}/waitlist`,{action:'accept'},current.event_version);
  const body={action:'accept',expected_version:current.event_version};
  const accepted=token?await mutateGuestEventParticipation(pool,eventId,token,body,input.key):await mutateEventWaitlist(pool,input,eventId);
  await pool.query("UPDATE community_event_waitlist SET expires_at=clock_timestamp()-interval '1 second' WHERE event_id=$1",[eventId]);
  const before=await acceptanceSnapshot();
  const replay=token?await mutateGuestEventParticipation(pool,eventId,token,body,input.key):await mutateEventWaitlist(pool,input,eventId);
  assert.deepEqual(replay,accepted);assert.deepEqual(await acceptanceSnapshot(),before);
  const unchanged=token?await readGuestEventParticipation(pool,eventId,token):await readEventParticipation(pool,actor(1),eventId);
  const noOp=token?await mutateGuestEventParticipation(pool,eventId,token,{action:'accept',expected_version:unchanged.event_version},randomUUID())
    :await mutateEventWaitlist(pool,memberCommand(1,input.operation,{action:'accept'},unchanged.event_version),eventId);
  assert.deepEqual(noOp,unchanged);assert.equal(noOp.waitlist?.status,'accepted');assert.equal(noOp.rsvp_state,'going');
});
