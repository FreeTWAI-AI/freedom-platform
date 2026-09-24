import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { emptyContacts } from '../../modules/identity-membership/members.js';
import { tokenHash,type Actor } from '../../modules/identity-membership/service.js';
import { inviteToSquad,receivedSquadInvitations,resolveSquadInvitation,squadInvitations,UNAVAILABLE_MEMBER } from '../../modules/identity-membership/squad-invitations.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_squad_invites_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:number|string,key:string=randomUUID()) {
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
const session=(r:any):Session=>({cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user});
async function signIn(email:string):Promise<Session>{const r=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));return session(r);}
const actorOf=(s:Session):Actor=>({...s.user,community_id:DEMO_COMMUNITY,session_hash:tokenHash(s.cookie.slice(s.cookie.indexOf('=')+1)),csrf_token:s.csrf});
async function parties(){return {owner:await signIn(DEMO_USERS[0].email),recipient:await signIn(DEMO_USERS[1].email),third:await signIn(DEMO_USERS[2].email)};}
async function squad(owner:Session,name='邀請測試小隊'){const made=await request('/squads',owner,{name,kind:'project',purpose:'合成邀請測試'});assert.equal(made.status,201);return made.data.squad_id as string;}
const invite=(owner:Session,squadId:string,recipient:string,key?:string)=>request(`/squads/${squadId}/invitations`,owner,{recipient_ref:recipient},undefined,key);
const resolve=(s:Session,id:string,action:string,version?:string,key?:string)=>request(`/squad-invitations/${id}/${action}`,s,{},version,key);
async function membership(squadId:string,userId:string){return (await pool.query('SELECT state,aggregate_version FROM member_squad_memberships WHERE squad_id=$1 AND user_id=$2',[squadId,userId])).rows[0];}
async function notifications(userId:string){return (await pool.query('SELECT kind,source_key,title,action_tab,action_resource_id FROM member_notifications WHERE recipient_ref=$1 ORDER BY source_key',[userId])).rows;}
async function lineOf(viewer:Session,ownerId:string){return (await request('/members/'+ownerId,viewer)).data.contacts.line;}
async function otherMember(email:string,options:{community?:string;active?:boolean;onboarded?:boolean;name?:string}={}) {
  const id=randomUUID();
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,$8,password_hash,$4,$5,$6 FROM users WHERE user_id=$7`,[id,options.community??DEMO_COMMUNITY,email,randomUUID(),options.active??true,options.onboarded===false,DEMO_USERS[0].user_id,options.name??'合成會員']);
  return id;
}
// The shared HTTP serializer emits every aggregate_version as a JSON safe integer.
const dtoKeys=['aggregate_version','created_at','invitation_id','owner_name','owner_ref','recipient_name','recipient_ref','resolved_at','squad_id','squad_name','state','updated_at'];

test('owner invitation stays private until the recipient accepts; replay and new keys never re-join after leaving',async()=>{
  const {owner,recipient,third}=await parties();
  const saved=await request('/me/account',owner);assert.equal((await request('/me/account',owner,{nickname:'隊主',contacts:{...emptyContacts(),line:{value:'squad-only-line',audiences:['squad']}}},saved.data.aggregate_version)).status,200);
  const squadId=await squad(owner);
  const created=await invite(owner,squadId,recipient.user.user_id);assert.equal(created.status,200,JSON.stringify(created.data));
  assert.deepEqual(Object.keys(created.data).sort(),dtoKeys);assert.equal(created.data.state,'pending');assert.equal(created.data.aggregate_version,1);assert.equal(created.data.resolved_at,null);
  assert.equal(created.response.headers.get('etag'),'"1"');assert.ok(!JSON.stringify(created.data).includes('@local.test'));
  const id=created.data.invitation_id;
  // Pending invitation grants neither membership nor squad-only contacts.
  assert.equal(await membership(squadId,recipient.user.user_id),undefined);assert.equal(await lineOf(recipient,owner.user.user_id),undefined);
  assert.deepEqual((await request(`/squads/${squadId}`,recipient)).data.members.map((m:any)=>m.user_id),[owner.user.user_id]);
  assert.deepEqual(await notifications(recipient.user.user_id),[{kind:'squad_invitation',source_key:`squad-invitation:${id}`,title:`隊主邀請你加入小隊「邀請測試小隊」`,action_tab:'squads',action_resource_id:squadId}]);
  assert.equal((await pool.query('SELECT body FROM member_notifications WHERE recipient_ref=$1',[recipient.user.user_id])).rows[0].body,'前往小隊集合，接受或婉拒邀請。');
  // Same pending with a new key returns the existing row: no new row, version or notification.
  const again=await invite(owner,squadId,recipient.user.user_id);assert.equal(again.data.invitation_id,id);assert.equal(again.data.aggregate_version,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_squad_invitations')).rows[0].n,1);
  assert.equal((await notifications(recipient.user.user_id)).length,1);
  const keyed=randomUUID();assert.equal((await invite(owner,squadId,recipient.user.user_id,keyed)).data.invitation_id,id);
  const conflict=await invite(owner,squadId,third.user.user_id,keyed);assert.equal(conflict.status,409);assert.equal(conflict.data.code,'idempotency_conflict');
  // Only the recipient sees received invitations; only the owner sees outbound history.
  assert.deepEqual((await request('/me/squad-invitations',recipient)).data.items.map((i:any)=>i.invitation_id),[id]);
  assert.equal((await request('/me/squad-invitations?state=all',third)).data.items.length,0);
  assert.equal((await request('/me/squad-invitations',owner)).data.items.length,0);
  assert.equal((await request(`/squads/${squadId}/invitations`,owner)).data.items.length,1);
  for(const viewer of [recipient,third])assert.equal((await request(`/squads/${squadId}/invitations`,viewer)).status,403);
  // Version, party and action checks.
  assert.equal((await resolve(recipient,id,'accept')).status,428);
  assert.equal((await resolve(recipient,id,'accept','2')).status,412);
  assert.equal((await resolve(owner,id,'accept','1')).status,403);assert.equal((await resolve(owner,id,'decline','1')).status,403);
  assert.equal((await resolve(recipient,id,'withdraw','1')).status,403);
  for(const action of ['accept','decline','withdraw'])assert.equal((await resolve(third,id,action,'1')).status,404);
  assert.equal((await request(`/squad-invitations/${id}/accept`,recipient,{squad_id:squadId},'1')).status,422);
  const acceptKey=randomUUID(),accepted=await resolve(recipient,id,'accept','1',acceptKey);assert.equal(accepted.status,200,JSON.stringify(accepted.data));
  assert.equal(accepted.data.state,'accepted');assert.equal(accepted.data.aggregate_version,2);assert.ok(accepted.data.resolved_at);
  assert.deepEqual(await membership(squadId,recipient.user.user_id),{state:'active',aggregate_version:'1'});
  assert.equal(await lineOf(recipient,owner.user.user_id),'squad-only-line');
  assert.deepEqual((await notifications(owner.user.user_id)).map(n=>n.source_key),[`squad-invitation:${id}:accepted`]);
  // Replay returns the stored result without writing membership or notifications.
  const replay=await resolve(recipient,id,'accept','1',acceptKey);assert.equal(replay.status,200);assert.deepEqual(replay.data,accepted.data);
  assert.deepEqual(await membership(squadId,recipient.user.user_id),{state:'active',aggregate_version:'1'});assert.equal((await notifications(owner.user.user_id)).length,1);
  const left=await request(`/squads/${squadId}/leave`,recipient,{},'1');assert.equal(left.status,200);assert.equal(await lineOf(recipient,owner.user.user_id),undefined);
  const afterLeave=await resolve(recipient,id,'accept','1',acceptKey);assert.equal(afterLeave.status,200);assert.equal(afterLeave.data.state,'accepted');
  const newKey=await resolve(recipient,id,'accept','2');assert.equal(newKey.status,409);assert.equal(newKey.data.code,'squad_invitation_not_pending');
  assert.deepEqual(await membership(squadId,recipient.user.user_id),{state:'left',aggregate_version:'2'});assert.equal(await lineOf(recipient,owner.user.user_id),undefined);
  assert.equal((await notifications(owner.user.user_id)).length,1);
  // An explicit re-invite after leaving is a new invitation id; history stays.
  const reinvite=await invite(owner,squadId,recipient.user.user_id);assert.equal(reinvite.status,200);assert.notEqual(reinvite.data.invitation_id,id);
  assert.deepEqual((await request('/me/squad-invitations?state=all',recipient)).data.items.map((i:any)=>i.state),['pending','accepted']);
  assert.deepEqual((await request('/me/squad-invitations',recipient)).data.items.map((i:any)=>i.invitation_id),[reinvite.data.invitation_id]);
});

test('decline and withdraw are terminal, notify the other party once and allow an explicit new invitation',async()=>{
  const {owner,recipient,third}=await parties();const squadId=await squad(owner);
  const first=(await invite(owner,squadId,recipient.user.user_id)).data;
  const declineKey=randomUUID(),declined=await resolve(recipient,first.invitation_id,'decline','1',declineKey);assert.equal(declined.status,200);assert.equal(declined.data.state,'declined');
  assert.equal((await resolve(recipient,first.invitation_id,'decline','1',declineKey)).data.aggregate_version,2);
  assert.equal((await resolve(recipient,first.invitation_id,'accept','2')).status,409);assert.equal((await resolve(owner,first.invitation_id,'withdraw','2')).status,409);
  assert.equal(await membership(squadId,recipient.user.user_id),undefined);
  const second=(await invite(owner,squadId,recipient.user.user_id)).data;assert.notEqual(second.invitation_id,first.invitation_id);
  const withdrawn=await resolve(owner,second.invitation_id,'withdraw','1');assert.equal(withdrawn.status,200);assert.equal(withdrawn.data.state,'withdrawn');
  assert.equal((await resolve(recipient,second.invitation_id,'accept','2')).status,409);assert.equal(await membership(squadId,recipient.user.user_id),undefined);
  assert.deepEqual((await notifications(owner.user.user_id)).map(n=>n.source_key),[`squad-invitation:${first.invitation_id}:declined`]);
  assert.deepEqual((await notifications(recipient.user.user_id)).map(n=>n.source_key).sort(),[`squad-invitation:${first.invitation_id}`,`squad-invitation:${second.invitation_id}`,`squad-invitation:${second.invitation_id}:withdrawn`].sort());
  // Owner list: pending first, then newest; pagination is bounded.
  await invite(owner,squadId,third.user.user_id);
  const list=await request(`/squads/${squadId}/invitations?limit=2&offset=0`,owner);assert.deepEqual(list.data.items.map((i:any)=>i.state),['pending','withdrawn']);assert.equal(list.data.next_offset,2);
  assert.deepEqual((await request(`/squads/${squadId}/invitations?limit=2&offset=2`,owner)).data.items.map((i:any)=>i.state),['declined']);
  for(const query of ['limit=51','offset=-1','state=pending','extra=1'])assert.equal((await request(`/squads/${squadId}/invitations?${query}`,owner)).status,422);
  for(const query of ['state=accepted','limit=0','extra=1'])assert.equal((await request(`/me/squad-invitations?${query}`,recipient)).status,422);
});

test('only the current owner may invite an eligible same-community member; forged and odd ids are rejected',async()=>{
  const {owner,recipient,third}=await parties();const squadId=await squad(owner);
  assert.equal((await invite(owner,squadId,owner.user.user_id)).data.code,'squad_self_invitation');
  assert.equal((await invite(third,squadId,recipient.user.user_id)).status,403);
  assert.equal((await request(`/squads/${squadId}/invitations`,owner,{recipient_ref:recipient.user.user_id,owner_ref:third.user.user_id})).status,422);
  assert.equal((await request(`/squads/${squadId}/invitations`,owner,{recipient_ref:'not-a-uuid'})).status,422);
  assert.equal((await request('/squads/not-a-uuid/invitations',owner,{recipient_ref:recipient.user.user_id})).status,422);
  assert.equal((await request(`/squad-invitations/not-a-uuid/accept`,recipient,{},'1')).status,422);
  assert.equal((await invite(owner,randomUUID(),recipient.user.user_id)).status,404);
  const foreignCommunity=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[foreignCommunity,'Other']);
  const foreign=await otherMember('foreign@local.test',{community:foreignCommunity}),inactive=await otherMember('inactive@local.test',{active:false}),incomplete=await otherMember('incomplete@local.test',{onboarded:false});
  for(const id of [foreign,inactive,incomplete,randomUUID()]){const r=await invite(owner,squadId,id);assert.equal(r.status,404,id);assert.equal(r.data.code,'member_not_found');}
  const outsider=await signIn('foreign@local.test');
  assert.equal((await request(`/squads/${squadId}/invitations`,outsider)).status,404);assert.equal((await invite(outsider,squadId,recipient.user.user_id)).status,404);
  // Already-active members cannot be invited.
  const join=await request(`/squads/${squadId}/request`,third,{});await request(`/squads/${squadId}/members/${third.user.user_id}/accept`,owner,{},join.data.aggregate_version);
  const member=await invite(owner,squadId,third.user.user_id);assert.equal(member.status,409);assert.equal(member.data.code,'squad_member_already');
  // Letter case never splits locks or receipts: the same pending invitation comes back.
  const lower=(await invite(owner,squadId,recipient.user.user_id)).data;
  const key=randomUUID();const upper=await request(`/squads/${squadId.toUpperCase()}/invitations`,owner,{recipient_ref:recipient.user.user_id.toUpperCase()},undefined,key);
  assert.equal(upper.status,200);assert.equal(upper.data.invitation_id,lower.invitation_id);
  assert.equal((await request(`/squads/${squadId}/invitations`,owner,{recipient_ref:recipient.user.user_id.toUpperCase()},undefined,key)).data.invitation_id,lower.invitation_id,'lowercase path replays the uppercase receipt');
  assert.equal((await request(`/squads/${squadId}/invitations`,owner,{recipient_ref:third.user.user_id},undefined,key)).status,409,'one receipt per normalized operation');
  const accepted=await resolve(recipient,lower.invitation_id.toUpperCase(),'accept','1');assert.equal(accepted.status,200);assert.equal(accepted.data.invitation_id,lower.invitation_id);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1',[squadId])).rows[0].n,1);
});

test('current eligibility is rechecked on every read, write and receipt replay, including direct service calls',async()=>{
  const {owner,recipient}=await parties();const squadId=await squad(owner);
  const id=(await invite(owner,squadId,recipient.user.user_id)).data.invitation_id;
  const acceptKey=randomUUID();assert.equal((await resolve(recipient,id,'accept','1',acceptKey)).status,200);
  const second=await squad(owner,'第二隊');const pending=(await invite(owner,second,recipient.user.user_id)).data.invitation_id;
  const third=await squad(owner,'第三隊');const declinable=(await invite(owner,third,recipient.user.user_id)).data.invitation_id;
  const fourth=await squad(owner,'第四隊');const withdrawable=(await invite(owner,fourth,recipient.user.user_id)).data.invitation_id;
  await pool.query('UPDATE users SET active=false WHERE user_id=$1',[owner.user.user_id]);
  // An inactive owner hides received invitations and blocks accepts and accept replays,
  // but the recipient may still decline, with the owner's name anonymized.
  assert.equal((await request('/me/squad-invitations?state=all',recipient)).data.items.length,0);
  assert.equal((await resolve(recipient,pending,'accept','1')).status,404);
  assert.equal((await resolve(recipient,id,'accept','1',acceptKey)).status,404);
  const declined=await resolve(recipient,declinable,'decline','1');assert.equal(declined.status,200);
  assert.equal(declined.data.state,'declined');assert.equal(declined.data.owner_name,UNAVAILABLE_MEMBER);
  await pool.query('UPDATE users SET active=true WHERE user_id=$1',[owner.user.user_id]);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[recipient.user.user_id]);
  // The owner still sees (anonymized) and may withdraw pending rows to an ineligible recipient.
  const listed=(await request(`/squads/${second}/invitations`,owner)).data.items;
  assert.deepEqual(listed.map((i:any)=>[i.invitation_id,i.recipient_ref,i.recipient_name]),[[pending,recipient.user.user_id,UNAVAILABLE_MEMBER]]);
  const withdrawn=await resolve(owner,withdrawable,'withdraw','1');assert.equal(withdrawn.status,200);assert.equal(withdrawn.data.recipient_name,UNAVAILABLE_MEMBER);
  // Service calls outside HTTP middleware apply the same onboarding gate.
  const actor=actorOf(recipient);
  await assert.rejects(receivedSquadInvitations(pool,actor,{}),{status:403,code:'onboarding_required'});
  await assert.rejects(resolveSquadInvitation(pool,{actor,operation:'direct accept',key:randomUUID(),body:{},expected:'1'},pending,'accept'),{status:403,code:'onboarding_required'});
  await assert.rejects(inviteToSquad(pool,{actor,operation:'direct invite',key:randomUUID(),body:{recipient_ref:owner.user.user_id}},second),{status:403});
  await assert.rejects(squadInvitations(pool,actor,second,{}),{status:403,code:'onboarding_required'});
  assert.equal((await pool.query("SELECT state FROM member_squad_invitations WHERE invitation_id=$1",[pending])).rows[0].state,'pending');
  // Completed onboarding restores the same pending invitation.
  await pool.query('UPDATE users SET onboarding_completed_at=now() WHERE user_id=$1',[recipient.user.user_id]);
  assert.equal((await resolve(recipient,pending,'accept','1')).status,200);
});

test('a failing notification rolls back the invitation or answer, and retrying the same key then succeeds once',async()=>{
  const {owner,recipient}=await parties();const squadId=await squad(owner);
  await pool.query(`CREATE FUNCTION fail_notification() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic notification failure'; END $$`);
  await pool.query(`CREATE TRIGGER fail_invite BEFORE INSERT ON member_notifications FOR EACH ROW WHEN (NEW.source_key NOT LIKE '%:%:%') EXECUTE FUNCTION fail_notification()`);
  const key=randomUUID();
  try {
    assert.equal((await invite(owner,squadId,recipient.user.user_id,key)).status,500);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_squad_invitations')).rows[0].n,0);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM command_receipts WHERE idempotency_key=$1",[key])).rows[0].n,0);
  } finally {await pool.query('DROP TRIGGER fail_invite ON member_notifications');}
  const created=await invite(owner,squadId,recipient.user.user_id,key);assert.equal(created.status,200);const id=created.data.invitation_id;
  await pool.query(`CREATE TRIGGER fail_accept BEFORE INSERT ON member_notifications FOR EACH ROW WHEN (NEW.source_key LIKE '%:accepted') EXECUTE FUNCTION fail_notification()`);
  try {
    assert.equal((await resolve(recipient,id,'accept','1',key)).status,500);
    assert.equal(await membership(squadId,recipient.user.user_id),undefined);
    assert.equal((await pool.query('SELECT state,aggregate_version FROM member_squad_invitations WHERE invitation_id=$1',[id])).rows[0].state,'pending');
  } finally {await pool.query('DROP TRIGGER fail_accept ON member_notifications');await pool.query('DROP FUNCTION fail_notification()');}
  assert.equal((await resolve(recipient,id,'accept','1',key)).status,200);assert.equal((await membership(squadId,recipient.user.user_id)).state,'active');
  assert.equal((await notifications(recipient.user.user_id)).length,1);assert.equal((await notifications(owner.user.user_id)).length,1);
});

test('concurrent invites, invite-vs-request, withdraw-vs-accept and owner-accept-vs-invite-accept stay consistent',async()=>{
  const {owner,recipient,third}=await parties();
  // Concurrent duplicate invites with different keys: one row, one notification.
  const dup=await squad(owner,'重複邀請');
  const invites=await Promise.all(Array.from({length:6},()=>invite(owner,dup,recipient.user.user_id)));
  assert.ok(invites.every(r=>r.status===200));assert.equal(new Set(invites.map(r=>r.data.invitation_id)).size,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1',[dup])).rows[0].n,1);
  assert.equal((await notifications(recipient.user.user_id)).length,1);
  // Invite vs join request: both recorded, neither activates membership.
  const both=await squad(owner,'邀請與申請');
  const [invited,requested]=await Promise.all([invite(owner,both,third.user.user_id),request(`/squads/${both}/request`,third,{})]);
  assert.equal(invited.status,200);assert.equal(requested.status,200);assert.deepEqual(await membership(both,third.user.user_id),{state:'pending',aggregate_version:'1'});
  // Owner accepts the join request first: accepting the invite only settles it.
  const ownerFirst=await request(`/squads/${both}/members/${third.user.user_id}/accept`,owner,{},'1');assert.equal(ownerFirst.status,200);
  const settle=await resolve(third,invited.data.invitation_id,'accept','1');assert.equal(settle.status,200);assert.equal(settle.data.state,'accepted');
  assert.deepEqual(await membership(both,third.user.user_id),{state:'active',aggregate_version:'2'});
  // Invite accepted first: the owner's stale join-request accept is a version conflict.
  const reverse=await squad(owner,'反向競態');
  const join=await request(`/squads/${reverse}/request`,recipient,{});const inv=(await invite(owner,reverse,recipient.user.user_id)).data;
  assert.equal((await resolve(recipient,inv.invitation_id,'accept','1')).status,200);
  const stale=await request(`/squads/${reverse}/members/${recipient.user.user_id}/accept`,owner,{},join.data.aggregate_version);assert.equal(stale.status,412);
  assert.deepEqual(await membership(reverse,recipient.user.user_id),{state:'active',aggregate_version:'2'});
  // Truly concurrent owner accept vs invite accept: one active membership, never double-bumped.
  for(let round=0;round<4;round++){
    const racing=await squad(owner,`同時接受 ${round}`);const pendingJoin=await request(`/squads/${racing}/request`,third,{});const pendingInvite=(await invite(owner,racing,third.user.user_id)).data;
    const [ownerAccept,inviteAccept]=await Promise.all([request(`/squads/${racing}/members/${third.user.user_id}/accept`,owner,{},pendingJoin.data.aggregate_version),resolve(third,pendingInvite.invitation_id,'accept','1')]);
    assert.equal(inviteAccept.status,200);assert.ok([200,412].includes(ownerAccept.status),String(ownerAccept.status));
    assert.deepEqual(await membership(racing,third.user.user_id),{state:'active',aggregate_version:'2'});
  }
  // Withdraw vs accept can never both succeed (a second owner keeps under the 10-squad limit).
  for(let round=0;round<6;round++){
    const racing=await squad(third,`撤回競態 ${round}`);const pendingInvite=(await invite(third,racing,recipient.user.user_id)).data;
    const [withdrawn,accepted]=await Promise.all([resolve(third,pendingInvite.invitation_id,'withdraw','1'),resolve(recipient,pendingInvite.invitation_id,'accept','1')]);
    assert.equal([withdrawn,accepted].filter(r=>r.status===200).length,1,`${withdrawn.status}/${accepted.status}`);
    assert.ok([409,412].includes((withdrawn.status===200?accepted:withdrawn).status));
    const state=(await pool.query('SELECT state FROM member_squad_invitations WHERE invitation_id=$1',[pendingInvite.invitation_id])).rows[0].state;
    assert.equal((await membership(racing,recipient.user.user_id))?.state,state==='accepted'?'active':undefined);
  }
});

test('direct reads reject an actor whose session expired, while a legacy member without required onboarding may read',async()=>{
  const {owner,recipient}=await parties();const squadId=await squad(owner);await invite(owner,squadId,recipient.user.user_id);
  assert.equal((await pool.query('SELECT onboarding_required FROM users WHERE user_id=$1',[recipient.user.user_id])).rows[0].onboarding_required,false);
  assert.equal((await receivedSquadInvitations(pool,actorOf(recipient),{})).items.length,1);assert.equal((await squadInvitations(pool,actorOf(owner),squadId,{})).items.length,1);
  await pool.query("UPDATE sessions SET expires_at=now()-interval '1 second' WHERE user_id=ANY($1)",[[owner.user.user_id,recipient.user.user_id]]);
  await assert.rejects(receivedSquadInvitations(pool,actorOf(recipient),{}),{status:401,code:'session_expired'});
  await assert.rejects(squadInvitations(pool,actorOf(owner),squadId,{}),{status:401,code:'session_expired'});
});

test('direct reads reject an actor whose session was revoked by logout',async()=>{
  const {owner,recipient}=await parties();const squadId=await squad(owner);await invite(owner,squadId,recipient.user.user_id);
  const [ownerActor,recipientActor]=[actorOf(owner),actorOf(recipient)];
  for(const s of [owner,recipient])assert.equal((await request('/auth/logout',s,{})).status,200);
  await assert.rejects(receivedSquadInvitations(pool,recipientActor,{}),{status:401,code:'session_expired'});
  await assert.rejects(squadInvitations(pool,ownerActor,squadId,{}),{status:401,code:'session_expired'});
  // A fresh login reads the same invitation again.
  assert.equal((await receivedSquadInvitations(pool,actorOf(await signIn(DEMO_USERS[1].email)),{})).items.length,1);
});

test('the 50 pending-invitation limit holds when different recipients are invited at the same time',async()=>{
  const {owner}=await parties();
  const members=await Promise.all(Array.from({length:51},(_,i)=>otherMember(`limit-${i}@local.test`)));
  const pendingCount=async(id:string)=>(await pool.query(`SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1 AND state='pending'`,[id])).rows[0].n;
  for(let round=0;round<5;round++){
    const squadId=await squad(owner,`上限競態 ${round}`);
    // 49 existing pending invitations, each to a different member.
    await pool.query(`INSERT INTO member_squad_invitations(invitation_id,community_id,squad_id,owner_ref,recipient_ref,state)
      SELECT gen_random_uuid(),$1,$2,$3,r,'pending' FROM unnest($4::uuid[]) AS r`,[DEMO_COMMUNITY,squadId,owner.user.user_id,members.slice(0,49)]);
    const keys=[randomUUID(),randomUUID()],targets=members.slice(49);
    const results=await Promise.all(targets.map((id,i)=>invite(owner,squadId,id,keys[i])));
    const ok=results.filter(r=>r.status===200),failed=results.filter(r=>r.status!==200);
    assert.equal(ok.length,1,results.map(r=>r.status).join('/'));assert.equal(failed[0].status,409);assert.equal(failed[0].data.code,'squad_invitation_limit');
    assert.equal(await pendingCount(squadId),50);
    const loser=results.indexOf(failed[0]);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM member_notifications WHERE recipient_ref=$1 AND action_resource_id=$2',[targets[loser],squadId])).rows[0].n,0);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1 AND recipient_ref=$2`,[squadId,targets[loser]])).rows[0].n,0);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE idempotency_key=$1',[keys[loser]])).rows[0].n,0);
  }
  // The full list still pages within the existing 50-row bound.
  const squadId=(await pool.query(`SELECT squad_id FROM member_squads WHERE name='上限競態 0'`)).rows[0].squad_id;
  const page=await request(`/squads/${squadId}/invitations?limit=50`,owner);assert.equal(page.data.items.length,50);assert.equal(page.data.next_offset,null);
  assert.equal((await request(`/squads/${squadId}/invitations?limit=20&offset=40`,owner)).data.items.length,10);
});

test('pending rows to members who became unavailable can be withdrawn to release the 50 limit, anonymized on replay',async()=>{
  const {owner}=await parties();const squadId=await squad(owner,'釋放上限');
  const gone=await otherMember('cap-gone@local.test',{name:'即將停用甲'}),incomplete=await otherMember('cap-incomplete@local.test',{name:'尚未完成乙'});
  const [goneSession,incompleteSession]=[await signIn('cap-gone@local.test'),await signIn('cap-incomplete@local.test')];
  const others=await Promise.all(Array.from({length:50},(_,i)=>otherMember(`cap-${i}@local.test`,{name:`上限夥伴${i}`})));
  const pendingCount=async()=>(await pool.query(`SELECT count(*)::int AS n FROM member_squad_invitations WHERE squad_id=$1 AND state='pending'`,[squadId])).rows[0].n;
  const goneInvite=(await invite(owner,squadId,gone)).data,incompleteInvite=(await invite(owner,squadId,incomplete)).data;
  assert.equal(goneInvite.recipient_name,'即將停用甲');
  await pool.query(`INSERT INTO member_squad_invitations(invitation_id,community_id,squad_id,owner_ref,recipient_ref,state)
    SELECT gen_random_uuid(),$1,$2,$3,r,'pending' FROM unnest($4::uuid[]) AS r`,[DEMO_COMMUNITY,squadId,owner.user.user_id,others.slice(0,48)]);
  assert.equal(await pendingCount(),50);
  await pool.query(`UPDATE users SET active=false,display_name='停用後新名' WHERE user_id=$1`,[gone]);
  await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[incomplete]);
  const leaks=['即將停用甲','停用後新名','尚未完成乙'];
  const noLeak=(data:unknown)=>{const text=JSON.stringify(data);for(const name of leaks)assert.ok(!text.includes(name),`${name} leaked`);};
  // Owner history keeps both rows under their original opaque refs; eligible names are unchanged.
  const history=(await request(`/squads/${squadId}/invitations?limit=50`,owner)).data;assert.equal(history.items.length,50);noLeak(history);
  const byRef=new Map(history.items.map((i:any)=>[i.recipient_ref,i]));
  for(const ref of [gone,incomplete])assert.equal((byRef.get(ref) as any).recipient_name,UNAVAILABLE_MEMBER);
  assert.equal((byRef.get(others[0]) as any).recipient_name,'上限夥伴0');
  // Accept and new invites keep the strict two-party gate; the limit is still full.
  assert.equal((await resolve(goneSession,goneInvite.invitation_id,'accept','1')).status,401);
  const incompleteAccept=await resolve(incompleteSession,incompleteInvite.invitation_id,'accept','1');assert.equal(incompleteAccept.status,403);assert.equal(incompleteAccept.data.code,'onboarding_required');
  assert.equal((await invite(owner,squadId,gone)).status,404);assert.equal((await invite(owner,squadId,incomplete)).status,404);
  const full=await invite(owner,squadId,others[48]);assert.equal(full.status,409);assert.equal(full.data.code,'squad_invitation_limit');
  // Withdrawing one unavailable recipient's row frees exactly one slot.
  const key=randomUUID(),withdrawn=await resolve(owner,goneInvite.invitation_id,'withdraw','1',key);assert.equal(withdrawn.status,200,JSON.stringify(withdrawn.data));
  assert.equal(withdrawn.data.state,'withdrawn');assert.equal(withdrawn.data.aggregate_version,2);assert.equal(withdrawn.data.recipient_ref,gone);assert.equal(withdrawn.data.recipient_name,UNAVAILABLE_MEMBER);noLeak(withdrawn.data);
  assert.equal(await pendingCount(),49);
  const replay=await resolve(owner,goneInvite.invitation_id,'withdraw','1',key);assert.equal(replay.status,200);assert.deepEqual(replay.data,withdrawn.data);noLeak(replay.data);
  assert.equal((await resolve(owner,goneInvite.invitation_id,'withdraw','2')).status,409);
  const refill=await invite(owner,squadId,others[48]);assert.equal(refill.status,200);assert.equal(refill.data.recipient_name,'上限夥伴48');
  assert.equal(await pendingCount(),50);
  assert.equal((await invite(owner,squadId,others[49])).data.code,'squad_invitation_limit');
  // Notifications and receipts once each; the inactive recipient's notice grants nothing.
  assert.deepEqual((await notifications(gone)).map(n=>n.source_key),[`squad-invitation:${goneInvite.invitation_id}`,`squad-invitation:${goneInvite.invitation_id}:withdrawn`]);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM command_receipts WHERE idempotency_key=$1',[key])).rows[0].n,1);
  assert.equal(await membership(squadId,gone),undefined);
  assert.equal((await pool.query(`SELECT state FROM member_squad_invitations WHERE invitation_id=$1`,[incompleteInvite.invitation_id])).rows[0].state,'pending');
});

test('a recipient may decline invitations from an owner who later became inactive; replays never reveal the owner name',async()=>{
  const {recipient}=await parties();
  await otherMember('fading-owner@local.test',{name:'原本隊主'});const owner=await signIn('fading-owner@local.test');
  const early=await squad(owner,'先婉拒'),late=await squad(owner,'後婉拒');
  const earlyInvite=(await invite(owner,early,recipient.user.user_id)).data,lateInvite=(await invite(owner,late,recipient.user.user_id)).data;
  const earlyKey=randomUUID(),earlyDecline=await resolve(recipient,earlyInvite.invitation_id,'decline','1',earlyKey);
  assert.equal(earlyDecline.status,200);assert.equal(earlyDecline.data.owner_name,'原本隊主');
  await pool.query(`UPDATE users SET active=false,display_name='停用隊主新名' WHERE user_id=$1`,[owner.user.user_id]);
  const noLeak=(data:unknown)=>{for(const name of ['原本隊主','停用隊主新名'])assert.ok(!JSON.stringify(data).includes(name),`${name} leaked`);};
  // The received list still filters an inactive owner, and accept stays blocked.
  assert.equal((await request('/me/squad-invitations?state=all',recipient)).data.items.length,0);
  assert.equal((await resolve(recipient,lateInvite.invitation_id,'accept','1')).status,404);
  // Declining the already-known pending row works through the service and replays anonymized.
  const actor=actorOf(recipient),lateKey=randomUUID(),command={actor,operation:`POST /api/v1/squad-invitations/${lateInvite.invitation_id}/decline`,key:lateKey,body:{},expected:'1'};
  const declined=await resolveSquadInvitation(pool,command,lateInvite.invitation_id,'decline');
  assert.equal(declined.state,'declined');assert.equal(declined.aggregate_version,'2');assert.equal(declined.owner_ref,owner.user.user_id);assert.equal(declined.owner_name,UNAVAILABLE_MEMBER);noLeak(declined);
  assert.deepEqual(await resolveSquadInvitation(pool,command,lateInvite.invitation_id,'decline'),declined);
  // A receipt stored while the owner was visible keeps its state/version but masks the name now.
  const earlyReplay=await resolve(recipient,earlyInvite.invitation_id,'decline','1',earlyKey);assert.equal(earlyReplay.status,200);
  assert.deepEqual({...earlyReplay.data,owner_name:earlyDecline.data.owner_name},earlyDecline.data);assert.equal(earlyReplay.data.owner_name,UNAVAILABLE_MEMBER);noLeak(earlyReplay.data);
  // The inactive owner receives each decline notice once, in the same transaction; no membership is created.
  assert.deepEqual((await notifications(owner.user.user_id)).map(n=>n.source_key).sort(),[`squad-invitation:${earlyInvite.invitation_id}:declined`,`squad-invitation:${lateInvite.invitation_id}:declined`].sort());
  for(const id of [early,late])assert.equal(await membership(id,recipient.user.user_id),undefined);
  assert.equal((await request('/me/squad-invitations?state=all',recipient)).data.items.length,0);
});
