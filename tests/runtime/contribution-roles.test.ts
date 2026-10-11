import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {createPool} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_WORK,DEMO_USERS,DEMO_PASSWORD,DEMO_COMMUNITY} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {tokenHash} from '../../modules/identity-membership/service.js';

const databaseUrl=process.env.TEST_DATABASE_URL;
if(!databaseUrl||!['127.0.0.1','localhost','[::1]'].includes(new URL(databaseUrl).hostname)||!new URL(databaseUrl).pathname.startsWith('/fp_'))throw Error('Contribution tests require an explicit disposable loopback fp_* database.');
const schema=`fp_contribution_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl),pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const origin='http://127.0.0.1:4310',app=createApp(pool,origin);
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:string|number,key=randomUUID(),extra:Record<string,string>={}){
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version!==undefined)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function signIn(index=0):Promise<Session>{const result=await request('/auth/login',undefined,{email:DEMO_USERS[index].email,password:DEMO_PASSWORD});assert.equal(result.status,200,JSON.stringify(result.data));return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,user:result.data.user};}
async function action(session:Session,c:any,name:string,body:unknown={}){const result=await request(`/work-claims/${c.claim_id}:${name}`,session,body,c.aggregate_version);assert.equal(result.status,200,JSON.stringify(result.data));return result.data;}
async function accept(maker:Session,owner:Session,workId=DEMO_WORK){
  const work=(await request('/work-items',maker)).data.items.find((item:any)=>item.work_item_id===workId);
  let result=await request(`/work-items/${workId}:claim`,maker,{claimant_type:'user',acting_profession_membership_ref:maker.user.profession_membership_ref,expected_aggregate_version:work.aggregate_version,terms_status:'declared',participation_terms_revision:work.participation_terms_revision,participation_terms_sha256:work.participation_terms_sha256},work.aggregate_version);
  assert.equal(result.status,201,JSON.stringify(result.data));let claim=result.data;
  claim=await action(maker,claim,'start');claim=await action(maker,claim,'submit',{summary:'真正完成工作驗收',artifact_ref:'artifact:accepted-delivery'});
  claim=await action(owner,claim,'begin-review');return action(owner,claim,'decide',{decision:'accept',feedback:'交付符合條件',submission_sha256:claim.latest_submission.sha256});
}
const draft=(role='proposal',summary='提出需求並確認手機操作')=>({role,summary,evidence_ref:'artifact:member-evidence-v1',share_with_community:true});
const path=(workId=DEMO_WORK)=>`/work-items/${workId}/contribution-roles`;
async function declare(session:Session,role='proposal',workId=DEMO_WORK){const result=await request(path(workId),session,draft(role));assert.equal(result.status,201,JSON.stringify(result.data));return result.data;}
async function confirm(session:Session,claim:any){return request(`/contribution-roles/${claim.role_id}/confirm`,session,{payload_sha256:claim.payload_sha256},claim.aggregate_version);}
const outcomes=(session:Session,memberId?:string)=>request(memberId?`/members/${memberId}/contribution-outcomes`:'/me/contribution-outcomes',session);

test('three members keep separate roles, pending is explicit, and accepted outcomes deduplicate multiple roles and receipt replays',async()=>{
  const maker=await signIn(),owner=await signIn(1),proposer=await signIn(2);
  const idea=await declare(proposer),design=await declare(proposer,'design'),implementation=await declare(maker,'implementation');
  assert.equal((await outcomes(proposer)).data.accepted_count,0);assert.equal((await confirm(owner,idea)).data.code,'work_not_accepted');
  assert.equal((await request(path(),proposer)).data.items.find((row:any)=>row.role_id===idea.role_id).state,'pending');
  await accept(maker,owner);
  assert.equal((await outcomes(maker)).data.accepted_count,1);assert.equal((await outcomes(proposer)).data.accepted_count,0);
  for(const item of [idea,design,implementation])assert.equal((await confirm(owner,item)).status,200);
  const view=(await outcomes(proposer)).data;assert.equal(view.accepted_count,1);assert.deepEqual(view.entries[0].roles.map((r:any)=>r.role).sort(),['design','proposal']);
  assert.equal(view.entries[0].delivery_ref,null);assert.equal((await outcomes(maker)).data.accepted_count,1);
  const key=randomUUID(),repeat=await declare(proposer,'testing');
  const body={payload_sha256:repeat.payload_sha256},first=await request(`/contribution-roles/${repeat.role_id}/confirm`,owner,body,repeat.aggregate_version,key);
  assert.equal(first.status,200);assert.deepEqual((await request(`/contribution-roles/${repeat.role_id}/confirm`,owner,body,repeat.aggregate_version,key)).data,first.data);
  assert.equal((await outcomes(proposer)).data.accepted_count,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM contributions')).rows[0].n,1);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_contribution_confirmations')).rows[0].n,4);
  const journal=JSON.stringify((await pool.query("SELECT data FROM transition_journal WHERE aggregate_type='work_contribution_role'")).rows);
  assert.equal(journal.includes('提出需求'),false);assert.equal(journal.includes('member-evidence-v1'),false);
});

test('historical delivery references remain self-only before sharing and after confirmed roles are withdrawn',async()=>{
  const maker=await signIn(),owner=await signIn(1),observer=await signIn(2);await accept(maker,owner);
  const check=async(shared:boolean)=>{
    const own=await outcomes(maker),other=await outcomes(observer,maker.user.user_id);
    assert.equal(own.status,200);assert.equal(own.data.entries[0].delivery_ref,'artifact:accepted-delivery');
    assert.equal(other.status,200);assert.equal(other.data.accepted_count,1);
    assert.equal(other.data.entries[0].work_item_id,DEMO_WORK);
    assert.equal(other.data.entries[0].delivery_ref,null);
    assert.equal(JSON.stringify(other.data).includes('artifact:accepted-delivery'),false);
    assert.equal(other.data.entries[0].roles.length,shared?1:0);
    if(shared)assert.equal(other.data.entries[0].roles[0].evidence_ref,'artifact:member-evidence-v1');
    else assert.equal(JSON.stringify(other.data).includes('artifact:member-evidence-v1'),false);
  };
  await check(false);
  const role=await declare(maker,'implementation');await check(false);
  const confirmed=await confirm(owner,role);assert.equal(confirmed.status,200);await check(true);
  assert.equal((await request(`/contribution-roles/${role.role_id}/withdraw`,maker,{},confirmed.data.aggregate_version)).status,200);
  await check(false);
});

test('amendment clears current confirmation, stale version/hash rejects, and withdrawal removes live facts while retaining confirmation history',async()=>{
  const maker=await signIn(),owner=await signIn(1),member=await signIn(2);await accept(maker,owner);
  const role=await declare(member),confirmed=await confirm(owner,role);assert.equal(confirmed.status,200);
  const input={summary:'更新後的分工內容',evidence_ref:'artifact:member-evidence-v2',share_with_community:true};
  assert.equal((await request(`/contribution-roles/${role.role_id}/edit`,member,input)).status,428);
  assert.equal((await request(`/contribution-roles/${role.role_id}/edit`,member,input,role.aggregate_version)).status,412);
  const edited=await request(`/contribution-roles/${role.role_id}/edit`,member,input,confirmed.data.aggregate_version);assert.equal(edited.status,200);
  assert.equal((await outcomes(member)).data.accepted_count,0);
  const staleHash=await request(`/contribution-roles/${role.role_id}/confirm`,owner,{payload_sha256:role.payload_sha256},edited.data.aggregate_version);assert.equal(staleHash.data.code,'role_changed');
  const next=await confirm(owner,edited.data);assert.equal(next.status,200);assert.equal((await outcomes(member)).data.entries[0].roles[0].summary,input.summary);
  assert.equal((await request(`/contribution-roles/${role.role_id}/withdraw`,member,{},next.data.aggregate_version)).status,200);
  assert.equal((await outcomes(member)).data.accepted_count,0);assert.equal((await outcomes(maker)).data.accepted_count,1);
  assert.equal(JSON.stringify((await request(path(),maker)).data).includes(input.summary),false);
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_contribution_confirmations')).rows[0].n,2);
  await assert.rejects(pool.query('UPDATE work_contribution_confirmations SET confirmed_at=now()'),(e:any)=>e.code==='23514');
});

test('real accepted deliverer may acknowledge the initiator; self-confirmation and arbitrary observers never acquire review authority',async()=>{
  const maker=await signIn(),owner=await signIn(1),other=await signIn(2);await accept(maker,owner);
  const initiator=await declare(owner),observer=await declare(other),own=await declare(maker,'testing');
  assert.equal((await confirm(owner,initiator)).data.code,'self_confirmation');
  assert.equal((await confirm(other,own)).status,403);assert.equal((await confirm(maker,observer)).status,403);
  assert.equal((await confirm(maker,initiator)).status,200);
  const result=(await outcomes(owner)).data;assert.equal(result.accepted_count,1);assert.equal(result.entries[0].roles[0].confirmer_name,maker.user.display_name);
});

test('request identities, explicit sharing, receipt replay and community/private boundaries cannot be spoofed',async()=>{
  const maker=await signIn(),owner=await signIn(1),member=await signIn(2),key=randomUUID();
  assert.equal((await request(path(),member,{...draft(),member_ref:maker.user.user_id})).status,422);
  assert.equal((await request(path(),member,{...draft(),github_login:'tedashh'})).status,422);
  assert.equal((await request(path(),member,{...draft(),share_with_community:false})).status,422);
  assert.equal((await request(path(),member,draft(),undefined,key,{'X-CSRF-Token':''})).status,403);
  const first=await request(path(),member,draft(),undefined,key);assert.equal(first.status,201);
  assert.deepEqual((await request(path().replace(DEMO_WORK,DEMO_WORK.toUpperCase()),member,draft(),undefined,key)).data,first.data);
  assert.equal((await request(path(),member,draft('proposal','換內容重播'),undefined,key)).status,409);
  assert.equal((await request(path(),member,draft())).data.code,'role_already_recorded');
  assert.equal((await request(`/contribution-roles/${first.data.role_id}/edit`,maker,{summary:'冒名',evidence_ref:'artifact:fake',share_with_community:true},1)).status,403);
  assert.equal((await request(`/members/${member.user.user_id}/contribution-outcomes`)).status,401);
  const foreign=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[foreign,'另一社群']);await pool.query('UPDATE users SET community_id=$1 WHERE user_id=$2',[foreign,maker.user.user_id]);
  const foreignMember=await signIn();assert.equal((await request(path(),foreignMember)).status,404);assert.equal((await request(path(),foreignMember,draft('testing'))).status,404);
  assert.equal((await outcomes(foreignMember,member.user.user_id)).status,404);
  const privateId=randomUUID();
  const principal=randomUUID(),scope=randomUUID();
  await pool.query("INSERT INTO principals(principal_id,kind,user_ref,status) VALUES($1,'person',$2,'active')",[principal,owner.user.user_id]);
  await pool.query("INSERT INTO resource_scopes(scope_id,kind,owner_principal_id,status) VALUES($1,'personal',$2,'active')",[scope,principal]);
  await pool.query("INSERT INTO work_items(work_item_id,owner_ref,title,objective,state,work_mode,scope_id,owner_principal_id,participation_terms_revision) VALUES($1,$2,'私人工作','PRIVATE-CANARY','draft','personal_execution',$3,$4,NULL)",[privateId,owner.user.user_id,scope,principal]);
  assert.equal((await request(path(privateId),owner)).status,404);assert.equal((await request(path(privateId),owner,draft())).status,404);
  await assert.rejects(pool.query(`INSERT INTO work_contribution_roles(role_id,community_id,work_item_id,member_ref,role,summary,evidence_ref,payload_sha256) VALUES($1,$2,$3,$4,'proposal','fake','artifact:fake',$5)`,[randomUUID(),DEMO_COMMUNITY,privateId,owner.user.user_id,'0'.repeat(64)]),(e:any)=>e.code==='23503');
});

test('expired/revoked authority and session are rechecked before replay, and journal failure rolls back all role effects',async()=>{
  const maker=await signIn(),owner=await signIn(1),member=await signIn(2);await accept(maker,owner);
  const role=await declare(member),key=randomUUID(),body={payload_sha256:role.payload_sha256};
  assert.equal((await request(`/contribution-roles/${role.role_id}/confirm`,owner,body,role.aggregate_version,key)).status,200);
  await pool.query('UPDATE work_review_routes SET revoked_at=now() WHERE work_item_id=$1',[DEMO_WORK]);
  assert.equal((await request(`/contribution-roles/${role.role_id}/confirm`,owner,body,role.aggregate_version,key)).status,403);
  const before=(await pool.query('SELECT count(*)::int AS n FROM work_contribution_roles')).rows[0].n;
  await pool.query(`CREATE FUNCTION reject_role_fact() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.aggregate_type='work_contribution_role' THEN RAISE EXCEPTION 'synthetic fact failure'; END IF; RETURN NEW; END; $$`);
  await pool.query('CREATE TRIGGER reject_role_fact BEFORE INSERT ON transition_journal FOR EACH ROW EXECUTE FUNCTION reject_role_fact()');
  try{assert.equal((await request(path(),member,draft('testing'))).status,500);assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_contribution_roles')).rows[0].n,before);}finally{await pool.query('DROP TRIGGER reject_role_fact ON transition_journal');await pool.query('DROP FUNCTION reject_role_fact()');}
  await pool.query('UPDATE sessions SET expires_at=clock_timestamp()-interval \'1 second\' WHERE token_hash=$1',[tokenHash(member.cookie.split('=')[1])]);
  assert.equal((await request(path(),member)).status,401);
});

test('same titles do not merge distinct Work outcomes; paginated facts and newcomer zeros use real source identity',async()=>{
  const maker=await signIn(),owner=await signIn(1),member=await signIn(2);await accept(maker,owner);
  const title=(await request('/work-items',owner)).data.items.find((w:any)=>w.work_item_id===DEMO_WORK).title;
  const newWork=await request('/work-items',owner,{title,objective:'另一份工作的獨立範圍',acceptance_criteria:'完成交付',gain:'自願參與',estimated_minutes:10,maximum_minutes:20,claim_by:new Date(Date.now()+86400000).toISOString(),finish_by:new Date(Date.now()+172800000).toISOString(),will_review:true});assert.equal(newWork.status,201);
  await accept(maker,owner,newWork.data.work_item_id);
  assert.equal((await outcomes(maker)).data.accepted_count,2);assert.equal((await outcomes(member)).data.accepted_count,0);
  const first=(await request('/me/contribution-outcomes?limit=1',maker)).data,next=(await request('/me/contribution-outcomes?limit=1&offset=1',maker)).data;
  assert.equal(first.accepted_count,2);assert.equal(first.next_offset,1);assert.equal(next.next_offset,null);assert.notEqual(first.entries[0].work_item_id,next.entries[0].work_item_id);
  const claim=await declare(member);await confirm(owner,claim);
  await pool.query("INSERT INTO member_interaction_blocks(community_id,owner_ref,target_ref,state,aggregate_version) VALUES($1,$2,$3,'active',1)",[DEMO_COMMUNITY,member.user.user_id,maker.user.user_id]);
  assert.equal((await outcomes(maker,member.user.user_id)).status,404);assert.equal((await request(path(),maker)).data.items.some((item:any)=>item.member_ref===member.user.user_id),false);
});

test('review expiry after an observed role-lock wait rolls back confirmation; session expiry after a receipt INSERT wait rolls back declaration',async()=>{
  const maker=await signIn(),owner=await signIn(1),member=await signIn(2);await accept(maker,owner);const role=await declare(member);
  async function blockedBy(pid:number){
    const deadline=Date.now()+5000;
    while(Date.now()<deadline){if((await admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',[pid])).rows[0].blocked)return;await new Promise(resolve=>setTimeout(resolve,10));}
    throw Error('Did not observe the intended PostgreSQL lock wait.');
  }
  const blocker=await pool.connect();await blocker.query('BEGIN');const pid=(await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await blocker.query('SELECT 1 FROM work_contribution_roles WHERE role_id=$1 FOR UPDATE',[role.role_id]);
  const pending=confirm(owner,role);
  try{await blockedBy(pid);await pool.query('UPDATE work_review_routes SET valid_until=clock_timestamp()-interval \'1 second\' WHERE work_item_id=$1',[DEMO_WORK]);}
  finally{await blocker.query('COMMIT');blocker.release();}
  assert.equal((await pending).status,403);assert.equal((await pool.query('SELECT count(*)::int AS n FROM work_contribution_confirmations')).rows[0].n,0);
  const receiptBlocker=await pool.connect();await receiptBlocker.query('BEGIN');const receiptPid=(await receiptBlocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
  await receiptBlocker.query('LOCK TABLE command_receipts IN SHARE MODE');
  await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+interval \'2 seconds\' WHERE token_hash=$1',[tokenHash(member.cookie.split('=')[1])]);
  const declaration=request(path(),member,draft('testing'));
  try{await blockedBy(receiptPid);await pool.query('SELECT pg_sleep(2.1)');}
  finally{await receiptBlocker.query('COMMIT');receiptBlocker.release();}
  assert.equal((await declaration).status,401);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM work_contribution_roles WHERE role='testing'")).rows[0].n,0);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM transition_journal WHERE aggregate_type='work_contribution_role'")).rows[0].n,1);
});
