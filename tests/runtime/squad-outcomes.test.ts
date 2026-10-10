import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {createPool,type Command} from '../../packages/db/index.js';
import {Problem} from '../../packages/shared/problem.js';
import {tokenHash,type Actor} from '../../modules/identity-membership/service.js';
import {createSquadOutcomeDraft,updateOwnSquadOutcome,publishOwnSquadOutcome,withdrawOwnSquadOutcome,readPublishedSquadOutcome,readOwnSquadOutcome,readSquadOutcome,listSquadOutcomes,listOwnSquadOutcomes} from '../../modules/identity-membership/squad-outcomes.js';

const connectionString=process.env.TEST_DATABASE_URL;
if(!connectionString)throw new Error('Squad outcome tests require explicit isolated TEST_DATABASE_URL.');
const schema=`fp_squad_outcomes_${process.pid}_${Date.now()}`;
const admin=createPool(connectionString),pool=new Pool({connectionString,options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
const community=randomUUID(),otherCommunity=randomUUID();let initialized=false;
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);initialized=true;await migrate(pool);});
after(async()=>{await pool.end();if(initialized)await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities CASCADE');await pool.query('INSERT INTO communities VALUES($1,$2),($3,$4)',[community,'Synthetic A',otherCommunity,'Synthetic B']);});
async function member(communityId=community,testAccount=false):Promise<Actor> {
 const id=randomUUID();const row=(await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic author','not-a-login-hash',$4) RETURNING *`,[id,communityId,id+(testAccount?'@example.invalid':'@outcome-fixture.example.org'),randomUUID()])).rows[0];
 const hash=tokenHash(randomUUID());await pool.query(`INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,'synthetic',now()+interval '1 hour')`,[hash,id]);return {...row,session_hash:hash,csrf_token:'synthetic'};
}
async function squad(owner:Actor) {
 const id=randomUUID();await pool.query(`INSERT INTO member_squads(squad_id,community_id,name,kind,purpose,owner_ref) VALUES($1,$2,'Consented squad','project','Synthetic purpose',$3)`,[id,owner.community_id,owner.user_id]);await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[id,owner.user_id]);return id;
}
const input=(actor:Actor,operation:string,body:unknown={},expected?:number,key=randomUUID()):Command=>({actor,operation,key,body,expected:expected===undefined?undefined:String(expected)});
const viewer=(actor:Actor)=>({communityId:actor.community_id,userId:actor.user_id});
const status=(code:number)=>(error:unknown)=>error instanceof Problem&&error.status===code;
const draftBody={title:'Actual authored outcome',summary:'Original authored summary',artifact_url:'https://example.org/artifact'};
async function draft(owner:Actor,squadId:string) {return createSquadOutcomeDraft(pool,input(owner,`squad/${squadId}/draft`,draftBody),squadId);}
async function publish(owner:Actor,id:string,audience:'squad'|'community'|'public',version=1) {return publishOwnSquadOutcome(pool,input(owner,`outcome/${id}/publish`,{audience,consent_to_share:true},version),id);}

test('drafts preserve self authorship, private visibility and bounded source without arbitrary references',async()=>{
 const owner=await member(),peer=await member(),outside=await member(otherCommunity),sid=await squad(owner);
 await assert.rejects(draft(peer,sid),status(403));await assert.rejects(draft(outside,sid),status(404));
 for(const body of [{...draftBody,author_ref:peer.user_id},{...draftBody,result_id:randomUUID()},{...draftBody,title:'x'.repeat(121)},{...draftBody,summary:' '},{...draftBody,artifact_url:'http://example.org'},{...draftBody,artifact_url:'https://127.0.0.1/a'},{...draftBody,artifact_url:'https://user:password@example.org/a'}])await assert.rejects(createSquadOutcomeDraft(pool,input(owner,'invalid',body),sid));
 const row=await draft(owner,sid);assert.equal(row.author.user_id,owner.user_id);assert.equal(row.state,'draft');assert.equal(row.consent_recorded_at,null);
 await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));await assert.rejects(readSquadOutcome(pool,peer,row.outcome_id),status(404));await assert.rejects(readOwnSquadOutcome(pool,outside,row.outcome_id),status(404));
 assert.equal((await listSquadOutcomes(pool,peer,sid)).items.length,0);assert.equal((await listOwnSquadOutcomes(pool,owner)).items.length,1);
 const updated=await updateOwnSquadOutcome(pool,input(owner,'edit',{...draftBody,title:'Revised'},1),row.outcome_id);assert.equal(updated.aggregate_version,2);assert.equal(updated.title,'Revised');
 for(const table of ['private_work_results','private_model_work_results','tenant_work_results'])assert.equal((await pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n,0);
});

test('explicit consent, CAS and receipts prevent stale or conflicting publication',async()=>{
 const owner=await member(),sid=await squad(owner),row=await draft(owner,sid);
 await assert.rejects(publishOwnSquadOutcome(pool,input(owner,'publish',{audience:'public'},1),row.outcome_id));
 await assert.rejects(publishOwnSquadOutcome(pool,input(owner,'publish',{audience:'public',consent_to_share:false},1),row.outcome_id));
 await assert.rejects(publishOwnSquadOutcome(pool,input(owner,'publish',{audience:'public',consent_to_share:true}),row.outcome_id),status(428));
 const cmd=input(owner,'publish',{audience:'public',consent_to_share:true},1),published=await publishOwnSquadOutcome(pool,cmd,row.outcome_id);
 assert.deepEqual(await publishOwnSquadOutcome(pool,cmd,row.outcome_id),published);assert.equal(published.aggregate_version,2);assert(published.consent_recorded_at);assert(published.published_at);
 await assert.rejects(publishOwnSquadOutcome(pool,{...cmd,body:{audience:'community',consent_to_share:true}},row.outcome_id),status(409));
 await assert.rejects(withdrawOwnSquadOutcome(pool,input(owner,'withdraw',{},1),row.outcome_id),status(412));
 await assert.rejects(updateOwnSquadOutcome(pool,input(owner,'edit',draftBody,2),row.outcome_id),status(409));
 assert.equal((await readPublishedSquadOutcome(pool,row.outcome_id,null)).title,row.title);
});

test('squad, community and public audiences recheck current viewer membership and onboarding',async()=>{
 const owner=await member(),peer=await member(),outsider=await member(otherCommunity),sid=await squad(owner),row=await draft(owner,sid);
 await publish(owner,row.outcome_id,'squad');await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,viewer(peer)),status(404));
 await pool.query(`INSERT INTO member_squad_memberships(squad_id,user_id,state) VALUES($1,$2,'active')`,[sid,peer.user_id]);assert.equal((await readPublishedSquadOutcome(pool,row.outcome_id,viewer(peer))).outcome_id,row.outcome_id);
 await pool.query(`UPDATE member_squad_memberships SET state='left' WHERE squad_id=$1 AND user_id=$2`,[sid,peer.user_id]);await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,viewer(peer)),status(404));
 await withdrawOwnSquadOutcome(pool,input(owner,'withdraw',{},2),row.outcome_id);await publish(owner,row.outcome_id,'community',3);
 assert.equal((await readPublishedSquadOutcome(pool,row.outcome_id,viewer(peer))).audience,'community');await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,viewer(outsider)),status(404));
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[peer.user_id]);await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,viewer(peer)),status(404));
 await pool.query('UPDATE users SET onboarding_required=false,active=false WHERE user_id=$1',[peer.user_id]);await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,viewer(peer)),status(404));
});

test('revoked publisher is not a published source; self management and withdrawal remain available',async()=>{
 const owner=await member(),replacement=await member(),sid=await squad(owner),row=await draft(owner,sid);await publish(owner,row.outcome_id,'public');
 await pool.query(`UPDATE member_squads SET owner_ref=$2 WHERE squad_id=$1`,[sid,replacement.user_id]);
 for(const scope of [null,viewer(owner),viewer(replacement)])await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,scope),status(404));
 assert.equal((await readOwnSquadOutcome(pool,owner,row.outcome_id)).state,'published');
 await assert.rejects(withdrawOwnSquadOutcome(pool,input(replacement,'withdraw',{},2),row.outcome_id),status(404));
 const withdrawn=await withdrawOwnSquadOutcome(pool,input(owner,'withdraw',{},2),row.outcome_id);assert.equal(withdrawn.state,'withdrawn');assert(withdrawn.withdrawn_at);
 await assert.rejects(publish(owner,row.outcome_id,'public',3),status(403));await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));
});

test('publisher account, squad membership and test classification are live ACL inputs',async()=>{
 const owner=await member(),peer=await member(),sid=await squad(owner),row=await draft(owner,sid);await publish(owner,row.outcome_id,'public');
 await pool.query(`UPDATE member_squad_memberships SET state='left' WHERE squad_id=$1 AND user_id=$2`,[sid,owner.user_id]);await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));
 await pool.query(`UPDATE member_squad_memberships SET state='active' WHERE squad_id=$1 AND user_id=$2`,[sid,owner.user_id]);
 await pool.query('UPDATE users SET active=false WHERE user_id=$1',[owner.user_id]);await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));
 await pool.query('UPDATE users SET active=true,onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[owner.user_id]);await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));
 await pool.query('UPDATE users SET onboarding_required=false,email=$2 WHERE user_id=$1',[owner.user_id,owner.user_id+'@example.invalid']);
 await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,viewer(peer)),status(404));assert.equal((await readPublishedSquadOutcome(pool,row.outcome_id,viewer(owner))).author.user_id,owner.user_id);
});

test('concurrent versioned edits commit one winner and database forbids rebinding source or tenant',async()=>{
 const owner=await member(),outside=await member(otherCommunity),sid=await squad(owner),row=await draft(owner,sid);
 const attempts=await Promise.allSettled(['One','Two'].map(title=>updateOwnSquadOutcome(pool,input(owner,'edit',{...draftBody,title},1),row.outcome_id)));
 assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1);assert.equal(attempts.filter(r=>r.status==='rejected'&&status(412)(r.reason)).length,1);
 await assert.rejects(pool.query('UPDATE member_squad_outcomes SET author_ref=$2 WHERE outcome_id=$1',[row.outcome_id,outside.user_id]),(e:any)=>e.code==='23514');
 await assert.rejects(pool.query(`INSERT INTO member_squad_outcomes(outcome_id,squad_id,community_id,author_ref,title,summary) VALUES($1,$2,$3,$4,'Title','Summary')`,[randomUUID(),sid,otherCommunity,outside.user_id]),(e:any)=>e.code==='23503');
});

test('owner change committed while publication waits cannot publish stale owner authority',async()=>{
 const owner=await member(),replacement=await member(),sid=await squad(owner),row=await draft(owner,sid);
 const blocker=await pool.connect();
 try {
  await blocker.query('BEGIN');
  await blocker.query('SELECT squad_id FROM member_squads WHERE squad_id=$1 FOR UPDATE',[sid]);
  const publishing=publish(owner,row.outcome_id,'public');
  // Attach rejection handling before releasing the lock, avoiding an unhandled promise.
  const rejected=assert.rejects(publishing,status(403));
  await blocker.query('UPDATE member_squads SET owner_ref=$2 WHERE squad_id=$1',[sid,replacement.user_id]);
  await blocker.query('COMMIT');
  await rejected;
  assert.equal((await readOwnSquadOutcome(pool,owner,row.outcome_id)).state,'draft');
  await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));
 } finally {await blocker.query('ROLLBACK');blocker.release();}
});

test('editing withdrawn content resets sharing consent and replay rechecks account eligibility',async()=>{
 const owner=await member(),sid=await squad(owner),row=await draft(owner,sid);
 await publish(owner,row.outcome_id,'public');
 const withdraw=input(owner,'withdraw',{},2);
 await withdrawOwnSquadOutcome(pool,withdraw,row.outcome_id);
 const edit=input(owner,'edit',{...draftBody,summary:'New private revision'},3);
 const revised=await updateOwnSquadOutcome(pool,edit,row.outcome_id);
 assert.equal(revised.state,'draft');assert.equal(revised.audience,'squad');assert.equal(typeof revised.aggregate_version,'number');
 assert.equal(revised.consent_recorded_at,null);assert.equal(revised.published_at,null);assert.equal(revised.withdrawn_at,null);
 await assert.rejects(readPublishedSquadOutcome(pool,row.outcome_id,null),status(404));
 assert.deepEqual(await updateOwnSquadOutcome(pool,edit,row.outcome_id),revised);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[owner.user_id]);
 await assert.rejects(updateOwnSquadOutcome(pool,edit,row.outcome_id),status(404));
 await assert.rejects(withdrawOwnSquadOutcome(pool,withdraw,row.outcome_id),status(404));
 await pool.query('UPDATE users SET onboarding_required=false,active=false WHERE user_id=$1',[owner.user_id]);
 await assert.rejects(withdrawOwnSquadOutcome(pool,withdraw,row.outcome_id),status(401));
});
