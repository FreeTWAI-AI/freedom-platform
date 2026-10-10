import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL,transaction} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {eventInvitationDeadline,ensureGuestCapability,resolveGuestParticipation,readGuestEventParticipation,mutateGuestEventParticipation,reconcileEventWaitlist,countEventSeats,processEventWaitlist} from '../../modules/community/event-waitlist.js';
import {setRsvp,registerPublicEvent,cancelEvent} from '../../modules/community/events.js';
import {mutateEventWaitlist,readEventParticipation,updateEventSchedule} from '../../modules/community/event-waitlist.js';
import {Problem} from '../../packages/shared/problem.js';
import type {Command} from '../../packages/db/index.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';

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
