import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {transaction,type Command} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {login,type Actor} from '../../modules/identity-membership/service.js';
import {Problem} from '../../packages/shared/problem.js';
import {setRsvp,cancelEvent} from '../../modules/community/events.js';
import {ensureGuestCapability,readGuestEventParticipation,mutateGuestEventParticipation,updateEventSchedule} from '../../modules/community/event-waitlist.js';
import {readEventReminder,saveEventReminder,readGuestEventReminder,saveGuestEventReminder,processEventReminders,reconcileEventReminders} from '../../modules/community/event-reminders.js';
import {readNotificationPreferences,saveNotificationPreferences} from '../../modules/member-communications/notification-preferences.js';

const url=process.env.TEST_DATABASE_URL;
if(!url)throw new Error('TEST_DATABASE_URL must name a disposable database');
const schema=`fp_reminder_delivery_${process.pid}_${Date.now()}`;
const admin=new Pool({connectionString:url}),pool=new Pool({connectionString:url,options:`-c search_path=${schema}`,max:8});
const start=new Date('2099-01-01T12:00:00Z'),due=new Date('2099-01-01T11:00:00Z');
let eventId:string,actors:Actor[];
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{
  await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);
  await pool.query('UPDATE users SET email_verified_at=now() WHERE community_id=$1',[DEMO_COMMUNITY]);
  actors=(await Promise.all(DEMO_USERS.map(user=>login(pool,user.email,DEMO_PASSWORD)))).map(value=>value.actor);
  eventId=randomUUID();
  await pool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,capacity,state,visibility)
    VALUES($1,$2,$3,'提醒邊界活動','隔離提醒驗證',$4,$5,'online','合成線上地址',NULL,'published','open')`,[eventId,DEMO_COMMUNITY,actors[0].user_id,start,new Date(start.getTime()+3600000)]);
});
const command=(actor:Actor,operation:string,body:unknown,expected?:number|string):Command=>({actor,operation,key:randomUUID(),body,...(expected===undefined?{}:{expected:String(expected)})});
const problem=(status:number,code?:string)=>(error:unknown)=>error instanceof Problem&&error.status===status&&(code===undefined||error.code===code);
async function going(index=1){await setRsvp(pool,command(actors[index],`events/${eventId}/rsvp`,{going:true}),eventId,true);}
async function optIn(channel:'email'|'in_app'='email',index=1){const current=await readEventReminder(pool,actors[index],eventId);return saveEventReminder(pool,command(actors[index],`events/${eventId}/reminder`,{enabled:true,minutes_before_start:60,channel},current.version),eventId);}
async function reminder(index=1){return (await pool.query('SELECT * FROM community_event_reminders WHERE event_id=$1 AND member_ref=$2',[eventId,actors[index].user_id])).rows[0];}
async function attempts(){return (await pool.query('SELECT * FROM community_event_reminder_attempts ORDER BY starts_at,channel')).rows;}
async function notices(){return (await pool.query("SELECT * FROM member_notifications WHERE kind='event_start_reminder' ORDER BY notification_id")).rows;}
async function guest(email='guest@local.test'){
  const token=await transaction(pool,async q=>{await q.query('SELECT 1 FROM community_events WHERE event_id=$1 FOR UPDATE',[eventId]);return ensureGuestCapability(q,eventId,{email,name:'合成訪客'});});
  const current=await readGuestEventParticipation(pool,eventId,token);
  await mutateGuestEventParticipation(pool,eventId,token,{action:'register',expected_version:current.event_version},randomUUID());
  return token;
}
async function guestReminder(token:string,enabled=true,channel:'email'|'in_app'='email'){
  const current=await readGuestEventReminder(pool,eventId,token);
  return saveGuestEventReminder(pool,eventId,token,{command_id:randomUUID(),expected_version:current.version,enabled,...(enabled?{minutes_before_start:60,channel}:{})});
}
async function reschedule(instant:Date){
  const version=(await pool.query('SELECT aggregate_version FROM community_events WHERE event_id=$1',[eventId])).rows[0].aggregate_version;
  return updateEventSchedule(pool,command(actors[0],`events/${eventId}/schedule`,{starts_at:instant.toISOString(),ends_at:new Date(instant.getTime()+3600000).toISOString(),capacity:null},version),eventId);
}
async function preferences(events:'instant'|'off',quiet=false){
  const current=await readNotificationPreferences(pool,actors[1],false);
  return saveNotificationPreferences(pool,command(actors[1],'me/notification-preferences',{categories:{...current.categories,events},quiet_hours:{enabled:quiet,time_zone:'UTC',start:'10:00',end:'11:30'},muted_channel_ids:[]},current.version),false);
}

test('Going is required and RSVP alone never opts into a reminder',async()=>{
  await assert.rejects(optIn(),problem(409,'rsvp_required'));
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM community_event_reminders')).rows[0].n,0);
  await going();assert.equal((await readEventReminder(pool,actors[1],eventId)).enabled,false);
  let calls=0;await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:due});assert.equal(calls,0);
  await optIn();assert.equal((await reminder()).enabled,true);
  await assert.rejects(saveEventReminder(pool,command(actors[1],'stale-reminder',{enabled:false},1),eventId),problem(412));
});

test('concurrent first reminder choices reject a stale tab rather than overwriting its acknowledged choice',async()=>{
  await going();
  const prior=await readEventReminder(pool,actors[1],eventId);
  const outcomes=await Promise.allSettled([
    saveEventReminder(pool,command(actors[1],'first-reminder',{enabled:true,minutes_before_start:60,channel:'email'},prior.version),eventId),
    saveEventReminder(pool,command(actors[1],'first-reminder',{enabled:true,minutes_before_start:90,channel:'in_app'},prior.version),eventId)
  ]);
  const accepted=outcomes.filter(result=>result.status==='fulfilled'),rejected=outcomes.filter(result=>result.status==='rejected');
  assert.equal(accepted.length,1);assert.equal(rejected.length,1);
  assert.equal(problem(412)(rejected[0].reason),true);
  const current=await readEventReminder(pool,actors[1],eventId);
  assert.equal(current.minutes_before_start,accepted[0].value.minutes_before_start);
  assert.equal(current.channel,accepted[0].value.channel);
  assert.ok(current.version>prior.version);
});

test('guest opt-in is email-only, token-scoped, idempotent and bound to confirmed own participation',async()=>{
  const token=await guest();
  await assert.rejects(guestReminder(token,true,'in_app'),problem(422,'guest_email_required'));
  await assert.rejects(readGuestEventReminder(pool,randomUUID(),token),problem(404));
  await assert.rejects(readGuestEventReminder(pool,eventId,'A'.repeat(43)),problem(404));
  const current=await readGuestEventReminder(pool,eventId,token),body={command_id:randomUUID(),expected_version:current.version,enabled:true,minutes_before_start:60,channel:'email'};
  const saved=await saveGuestEventReminder(pool,eventId,token,body);
  assert.deepEqual(await saveGuestEventReminder(pool,eventId,token,body),saved);
  await assert.rejects(saveGuestEventReminder(pool,eventId,token,{...body,minutes_before_start:30}),problem(409,'idempotency_conflict'));
  const sent:string[]=[];await processEventReminders(pool,async(to)=>{sent.push(to);},{enabled:true,now:due});
  assert.deepEqual(sent,['guest@local.test']);assert.equal((await readGuestEventReminder(pool,eventId,token)).status,'provider_accepted');
  assert.equal((await notices()).length,0);assert.equal((await attempts()).length,1);
  const participation=await readGuestEventParticipation(pool,eventId,token);
  await mutateGuestEventParticipation(pool,eventId,token,{action:'cancel',expected_version:participation.event_version},randomUUID());
  await assert.rejects(guestReminder(token),problem(409,'rsvp_required'));
});

test('disabling, withdrawing RSVP and event cancellation suppress unsent due reminders',async()=>{
  for(const action of ['disable','withdraw','cancel'] as const){
    await going();const saved=await optIn();
    if(action==='disable')await saveEventReminder(pool,command(actors[1],'disable-reminder',{enabled:false},saved.version),eventId);
    if(action==='withdraw')await setRsvp(pool,command(actors[1],'withdraw-rsvp',{going:false}),eventId,true);
    if(action==='cancel'){
      const version=(await pool.query('SELECT aggregate_version FROM community_events WHERE event_id=$1',[eventId])).rows[0].aggregate_version;
      await cancelEvent(pool,command(actors[0],'cancel-event',{},version),eventId,true);
    }
    assert.equal((await reminder()).enabled,false);assert.equal((await reminder()).status,'cancelled');
    let calls=0;await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:due});assert.equal(calls,0);
    assert.equal((await attempts()).length,0);assert.equal((await notices()).length,0);
  }
});

test('guest cancellation invalidates unsent reminders without provider handoff',async()=>{
  const token=await guest();await guestReminder(token);
  const current=await readGuestEventParticipation(pool,eventId,token);
  await mutateGuestEventParticipation(pool,eventId,token,{action:'cancel',expected_version:current.event_version},randomUUID());
  let calls=0;await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:due});
  assert.equal(calls,0);assert.equal((await readGuestEventReminder(pool,eventId,token)).status,'cancelled');assert.equal((await attempts()).length,0);
});

test('rescheduling reconciles due date and fences stale source before claiming',async()=>{
  await going();await optIn();const later=new Date(start.getTime()+7200000);await reschedule(later);
  const row=await reminder();assert.equal(row.starts_at.toISOString(),later.toISOString());assert.equal(row.due_at.toISOString(),'2099-01-01T13:00:00.000Z');
  assert.equal(String(row.event_version),(await pool.query('SELECT aggregate_version FROM community_events WHERE event_id=$1',[eventId])).rows[0].aggregate_version);
  let calls=0;await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:due});assert.equal(calls,0);assert.equal((await attempts()).length,0);
  // Simulate a source update not yet reconciled; the processor must re-read the event, not dispatch the stale due row.
  await pool.query('UPDATE community_events SET starts_at=$2,ends_at=$3,aggregate_version=aggregate_version+1 WHERE event_id=$1',[eventId,new Date(later.getTime()+7200000),new Date(later.getTime()+10800000)]);
  await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:new Date('2099-01-01T13:00:00Z')});assert.equal(calls,0);assert.equal((await attempts()).length,0);
  assert.equal((await reminder()).due_at.toISOString(),'2099-01-01T15:00:00.000Z');
});

test('identical start, lead and channel never duplicate an attempt, including schedule round trips',async()=>{
  await going();await optIn();let calls=0;const send=async()=>{calls++;};
  await processEventReminders(pool,send,{enabled:true,now:due});await optIn();
  await transaction(pool,q=>reconcileEventReminders(q,eventId,due));await processEventReminders(pool,send,{enabled:true,now:due});
  await reschedule(new Date(start.getTime()+7200000));await reschedule(start);
  await processEventReminders(pool,send,{enabled:true,now:due});assert.equal(calls,1);assert.equal((await attempts()).length,1);
  await reschedule(new Date(start.getTime()+7200000));await processEventReminders(pool,send,{enabled:true,now:new Date('2099-01-01T13:00:00Z')});
  assert.equal(calls,2);assert.equal((await attempts()).length,2);assert.equal((await reminder()).status,'provider_accepted');
});

test('sender failure and unknown physical outcome remain failed and are never automatically retried',async()=>{
  await going();await optIn();let physicalHandoffs=0;
  const unknown=async()=>{physicalHandoffs++;throw new Error('synthetic connection lost after provider handoff; outcome unknown');};
  await processEventReminders(pool,unknown,{enabled:true,now:due});assert.equal((await reminder()).status,'failed');
  assert.deepEqual((await attempts()).map(row=>row.status),['failed']);assert.equal((await notices()).length,0);
  await processEventReminders(pool,unknown,{enabled:true,now:due});await optIn();await processEventReminders(pool,unknown,{enabled:true,now:due});
  assert.equal(physicalHandoffs,1);assert.equal((await attempts()).length,1);assert.equal((await readEventReminder(pool,actors[1],eventId)).status,'failed');
});

test('provider acceptance is distinct from an in-app record, and concurrent processors hand off once',async()=>{
  await going(1);await going(2);await optIn('email',1);await optIn('in_app',2);let calls=0;
  const send=async(to:string)=>{calls++;assert.equal(to,actors[1].email);};
  await Promise.all([processEventReminders(pool,send,{enabled:true,now:due}),processEventReminders(pool,send,{enabled:true,now:due})]);
  assert.equal(calls,1);assert.equal((await reminder(1)).status,'provider_accepted');assert.equal((await reminder(2)).status,'recorded');
  assert.deepEqual((await attempts()).map(row=>row.status).sort(),['provider_accepted','recorded']);
  const rows=await notices();assert.equal(rows.length,1);assert.equal(rows[0].recipient_ref,actors[2].user_id);assert.equal(rows[0].action_resource_id,eventId);assert.equal(rows[0].action_tab,'events');
});

test('an explicit sender rejection records one failed attempt without subsequent provider calls',async()=>{
  await going();await optIn();let calls=0;
  const reject=async()=>{calls++;throw new Error('synthetic provider rejected the request');};
  await processEventReminders(pool,reject,{enabled:true,now:due});
  await processEventReminders(pool,reject,{enabled:true,now:new Date('2099-01-01T11:30:00Z')});
  assert.equal(calls,1);assert.equal((await reminder()).status,'failed');
  assert.deepEqual((await attempts()).map(row=>row.status),['failed']);assert.equal((await notices()).length,0);
});

for(const revocation of ['inactive','onboarding','guild','guest-source','guest-verification'] as const)test(`current ${revocation} revocation prevents provider handoff`,async()=>{
  let token:string|undefined;
  if(revocation==='guild'){
    await pool.query("UPDATE community_events SET visibility='guild',event_kind='guild_skill_exchange',guild_key='guild_event_space' WHERE event_id=$1",[eventId]);
    await pool.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_event_space','active') ON CONFLICT(community_id,user_id,guild_key) DO UPDATE SET state='active'",[randomUUID(),DEMO_COMMUNITY,actors[1].user_id]);
  }
  if(revocation.startsWith('guest')){token=await guest();await guestReminder(token);}
  else{await going();await optIn();}
  if(revocation==='inactive')await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[1].user_id]);
  if(revocation==='onboarding')await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[actors[1].user_id]);
  if(revocation==='guild')await pool.query("UPDATE positioning_profession_memberships SET state='left',left_at=now() WHERE user_id=$1 AND guild_key='guild_event_space'",[actors[1].user_id]);
  if(revocation==='guest-source')await pool.query("UPDATE community_events SET visibility='workshop' WHERE event_id=$1",[eventId]);
  if(revocation==='guest-verification')await pool.query('UPDATE community_event_guest_capabilities SET verified_at=NULL WHERE event_id=$1',[eventId]);
  let calls=0;await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:due});
  assert.equal(calls,0);assert.equal((await attempts()).length,0);assert.equal((await notices()).length,0);
  const rows=(await pool.query('SELECT enabled,status FROM community_event_reminders WHERE event_id=$1',[eventId])).rows;
  assert.deepEqual(rows,[{enabled:false,status:'cancelled'}]);
});

test('unverified member email blocks email but does not invent an email requirement for in-app records',async()=>{
  await going();await optIn();await pool.query('UPDATE users SET email_verified_at=NULL WHERE user_id=$1',[actors[1].user_id]);
  let calls=0;await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:due});assert.equal(calls,0);assert.equal((await reminder()).status,'cancelled');assert.equal((await attempts()).length,0);
  await optIn('in_app');await processEventReminders(pool,async()=>{calls++;},{enabled:true,now:due});
  assert.equal(calls,0);assert.equal((await reminder()).status,'recorded');assert.equal((await notices()).length,1);
});

test('quiet hours defer in-app claims while events-off cancels them; explicit email opt-in is independent',async()=>{
  await going();await optIn('in_app');await preferences('instant',true);let calls=0;const send=async()=>{calls++;};
  await processEventReminders(pool,send,{enabled:true,now:due});assert.equal((await reminder()).status,'pending');assert.equal((await attempts()).length,0);assert.equal((await notices()).length,0);
  await processEventReminders(pool,send,{enabled:true,now:new Date('2099-01-01T11:30:00Z')});assert.equal((await reminder()).status,'recorded');assert.equal((await notices()).length,1);
  await reschedule(new Date(start.getTime()+7200000));await preferences('off');
  await processEventReminders(pool,send,{enabled:true,now:new Date('2099-01-01T13:00:00Z')});assert.equal((await reminder()).status,'cancelled');assert.equal((await attempts()).length,1);
  await optIn('email');await processEventReminders(pool,send,{enabled:true,now:new Date('2099-01-01T13:00:00Z')});assert.equal(calls,1);assert.equal((await reminder()).status,'provider_accepted');
});

test('flag-off processor does not reconcile, cancel, claim or send business state',async()=>{
  await going();await optIn();await pool.query('UPDATE users SET active=false WHERE user_id=$1',[actors[1].user_id]);
  const beforeRow=await reminder();let calls=0;
  assert.deepEqual(await processEventReminders(pool,async()=>{calls++;},{enabled:false,now:due}),{processed:0});
  assert.deepEqual(await reminder(),beforeRow);assert.equal(calls,0);assert.equal((await attempts()).length,0);assert.equal((await notices()).length,0);
});
