import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Pool } from 'pg';
import { z } from 'zod';
import { createPool,LOCAL_DATABASE_URL,digest } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_WORK,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { hashPassword,tokenHash } from '../../modules/identity-membership/service.js';
import { readSessionCookie } from '../../apps/platform-api/src/session-cookie.js';
import { execFileSync } from 'node:child_process';
const pythonCommand=process.platform==='win32'?'python':'python3';

const origin='http://127.0.0.1:4310';
const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_runtime_test_${process.pid}_${Date.now()}`;
const admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
interface Session {cookie:string;csrf:string;user:any}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts,auth_rate_limits CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:any,version?:string,key=randomUUID(),extra:Record<string,string>={}) {
  const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{}),...extra};
  if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
  const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,data:await response.json() as any,response};
}
async function signIn(email=DEMO_USERS[0].email):Promise<Session> {
  const r=await request('/auth/login',undefined,{email,password:DEMO_PASSWORD});assert.equal(r.status,200,JSON.stringify(r.data));
  const cookie=r.response.headers.get('set-cookie')!.split(';')[0];return {cookie,csrf:r.data.csrf_token,user:r.data.user};
}
async function work(session:Session,id=DEMO_WORK){return (await request('/work-items',session)).data.items.find((w:any)=>w.work_item_id===id);}
function claimBody(session:Session,item:any){return {claimant_type:'user',acting_profession_membership_ref:session.user.profession_membership_ref,expected_aggregate_version:item.aggregate_version,terms_status:'declared',participation_terms_revision:item.participation_terms_revision,participation_terms_sha256:item.participation_terms_sha256};}
async function claim(session:Session,id=DEMO_WORK){const w=await work(session,id);const r=await request(`/work-items/${id}:claim`,session,claimBody(session,w),w.aggregate_version);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;}
async function action(session:Session,c:any,name:string,body:any={}){const r=await request(`/work-claims/${c.claim_id}:${name}`,session,body,c.aggregate_version);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function submitted(maker:Session){let c=await claim(maker);c=await action(maker,c,'start');return action(maker,c,'submit',{summary:'完成三個步驟與合成範例。',artifact_ref:'artifact:example-v1'});}
async function newWork(owner:Session,overrides:any={}) {
  const body={title:'新的有限工作',objective:'解決一個真實問題',acceptance_criteria:'交付可重用說明',gain:'自願留下公共成果，不保證報酬',estimated_minutes:20,maximum_minutes:30,claim_by:new Date(Date.now()+86400000).toISOString(),finish_by:new Date(Date.now()+2*86400000).toISOString(),will_review:true,...overrides};
  const r=await request('/work-items',owner,body);assert.equal(r.status,201,JSON.stringify(r.data));return r.data;
}
async function acceptFor(member:Session,reviewer:Session) {
  const item=await newWork(reviewer);
  let current=await claim(member,item.work_item_id);
  current=await action(member,current,'start');
  current=await action(member,current,'submit',{summary:'已完成合成驗收步驟。',artifact_ref:`artifact:owner-proof-${randomUUID()}`});
  current=await action(reviewer,current,'begin-review');
  return action(reviewer,current,'decide',{decision:'accept',feedback:'合成工作符合驗收條件。',submission_sha256:current.latest_submission.sha256});
}
const readSubmission=z.object({submission_id:z.uuid(),summary:z.string(),artifact_ref:z.string(),sha256:z.string(),revision:z.number().int()}).strict();
const readClaim=z.object({claim_id:z.uuid(),claimant_ref:z.uuid(),state:z.string(),latest_submission:readSubmission.nullable(),feedback:z.string().nullable()});
const readWork=z.object({work_item_id:z.uuid(),title:z.string(),review_capacity:z.enum(['available','waiting_reviewer_capacity']),my_claim:readClaim.nullable()});
const readWorkPage=z.object({items:z.array(readWork)});
const readCursorWorkPage=readWorkPage.extend({next_cursor:z.string().nullable()}).strict();
const readDashboard=z.object({now:z.array(readWork),next:z.array(readWork),gained:z.array(z.unknown()),review_queue:z.array(z.object({claim:readClaim,work_item:readWork,claimant_name:z.string()}))});
const readMember=z.object({user_id:z.uuid(),profession_membership_ref:z.uuid()});


test('work list keeps complete ordering, own claims and latest submission revisions',async()=>{
  const maker=await signIn(),other=await signIn(DEMO_USERS[2].email);
  const makerUser=readMember.parse(maker.user),otherUser=readMember.parse(other.user);
  const initial=readWorkPage.parse((await request('/work-items',maker)).data);
  assert.equal(initial.items.find(item=>item.work_item_id===DEMO_WORK)?.my_claim,null);
  const ownClaim=await claim(maker);
  const claimed=readWorkPage.parse((await request('/work-items',maker)).data);
  assert.equal(claimed.items.find(item=>item.work_item_id===DEMO_WORK)?.my_claim?.claim_id,ownClaim.claim_id);
  assert.equal(claimed.items.find(item=>item.work_item_id===DEMO_WORK)?.my_claim?.latest_submission,null);
  await pool.query("UPDATE work_items SET created_at='2001-02-01T00:00:00Z' WHERE work_item_id=$1",[DEMO_WORK]);
  const expected=new Map<string,{owner:string|null;claimId:string;latest:number|null;label:number;capacity:'available'|'waiting_reviewer_capacity'}>();
  for(let i=0;i<16;i++) {
    const id=randomUUID(),claimId=randomUUID(),user=i%3===0?otherUser:makerUser;
    await pool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,
      participation_terms_sha256,claim_window_expires_at,due_at,created_at)
      SELECT $1,community_id,owner_ref,$2,objective,acceptance_criteria,gain,'open',participation_terms,participation_terms_sha256,
      claim_window_expires_at,due_at,'2001-01-01T00:00:00Z' FROM work_items WHERE work_item_id=$3`,[id,`batch-${i}`,DEMO_WORK]);
    if(i%4===0)await pool.query('INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until,revoked_at) VALUES($1,$2,$3,$4)',
      [id,DEMO_USERS[1].user_id,i<=4?'2099-01-01':'2000-01-01',i===4?new Date('2001-01-01'):null]);
    expected.set(id,{owner:i%5===0?null:user.user_id,claimId,latest:i%5!==0&&i%2!==0?3:null,label:i,capacity:i===0?'available':'waiting_reviewer_capacity'});
    if(i%5===0)continue;
    await pool.query(`INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot,feedback)
      SELECT $1,work_item_id,$2,$3,'changes_requested',participation_terms_revision,participation_terms_sha256,participation_terms,$4
      FROM work_items WHERE work_item_id=$5`,[claimId,user.user_id,user.profession_membership_ref,`feedback-${i}`,id]);
    if(i%2===0)continue;
    for(let revision=1;revision<=3;revision++)await pool.query('INSERT INTO submissions(submission_id,claim_id,revision,summary,artifact_ref,sha256) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(),claimId,revision,`revision-${revision}`,`artifact:batch-${i}-${revision}`,'a'.repeat(64)]);
  }
  for(const [session,user] of [[maker,makerUser],[other,otherUser]] as const) {
    const result=await request('/work-items',session);assert.equal(result.status,200);
    const value=readWorkPage.parse(result.data);
    assert.deepEqual(value.items.map(item=>item.work_item_id),[DEMO_WORK,...[...expected.keys()].sort()]);
    for(const item of value.items) {
      const fixture=expected.get(item.work_item_id);if(!fixture)continue;
      assert.equal(item.review_capacity,fixture.capacity);
      if(fixture.owner!==user.user_id) {assert.equal(item.my_claim,null);continue;}
      assert.ok(item.my_claim);assert.equal(item.my_claim.claim_id,fixture.claimId);assert.equal(item.my_claim.claimant_ref,user.user_id);
      assert.equal(item.my_claim.feedback,`feedback-${fixture.label}`);
      if(fixture.latest===null)assert.equal(item.my_claim.latest_submission,null);
      else {
        assert.ok(item.my_claim.latest_submission);assert.equal(item.my_claim.latest_submission.revision,fixture.latest);
        assert.equal(item.my_claim.latest_submission.summary,'revision-3');assert.equal(item.my_claim.latest_submission.artifact_ref,`artifact:batch-${fixture.label}-3`);
      }
    }
  }
});

test('cursor work list preserves microsecond ordering, legacy completeness and older personal projections',async()=>{
  const maker=await signIn(),ownClaim=await claim(maker);
  assert.equal(ownClaim.work_item_id,DEMO_WORK);
  await pool.query("UPDATE work_items SET created_at='2001-02-01T00:00:00Z' WHERE work_item_id=$1",[DEMO_WORK]);
  const expected:string[]=[];
  for(let index=0;index<30;index++) {
    const id=randomUUID(),fraction=`123${String(index).padStart(3,'0')}`;
    await pool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,
      participation_terms_sha256,claim_window_expires_at,due_at,created_at)
      SELECT $1,community_id,owner_ref,$2,objective,acceptance_criteria,gain,'open',participation_terms,participation_terms_sha256,
      claim_window_expires_at,due_at,$3::timestamptz FROM work_items WHERE work_item_id=$4`,
    [id,`cursor-${String(index).padStart(2,'0')}`,`2030-01-01T00:00:00.${fraction}Z`,DEMO_WORK]);
    expected.unshift(id);
  }
  const legacy=readWorkPage.parse((await request('/work-items',maker)).data);
  assert.deepEqual(legacy.items.map(item=>item.work_item_id),[...expected,DEMO_WORK]);
  const pages:typeof legacy.items=[];let cursor:string|null=null;let pageCount=0;
  do {
    const path=`/work-items/page${cursor?`?cursor=${encodeURIComponent(cursor)}`:''}`;
    const result=await request(path,maker);assert.equal(result.status,200,JSON.stringify(result.data));
    const page=readCursorWorkPage.parse(result.data);assert.ok(page.items.length<=24);
    if(pageCount===0){assert.equal(page.items.length,24);assert.ok(page.next_cursor);}
    pages.push(...page.items);cursor=page.next_cursor;pageCount++;
    assert.ok(pageCount<10,'cursor pagination did not terminate');
  }while(cursor);
  assert.deepEqual(pages.map(item=>item.work_item_id),legacy.items.map(item=>item.work_item_id));
  assert.equal(new Set(pages.map(item=>item.work_item_id)).size,pages.length);
  const dashboard=readDashboard.parse((await request('/dashboard',maker)).data);
  assert.equal(dashboard.now.some(item=>item.work_item_id===DEMO_WORK),true);
  assert.equal(dashboard.next.length,24);
  const first=readCursorWorkPage.parse((await request('/work-items/page',maker)).data);
  for(const path of [
    '/work-items/page?cursor=not-base64!',
    '/work-items/page?pagination=cursor',
    `/work-items/page?cursor=${encodeURIComponent(first.next_cursor!)}&cursor=${encodeURIComponent(first.next_cursor!)}`,
  ]) assert.equal((await request(path,maker)).status,422,path);
});

test('work search and open scope apply before pagination, including older literal matches',async()=>{
  const maker=await signIn(),ids=Array.from({length:30},()=>randomUUID());
  await pool.query(`UPDATE work_items SET title='Needle%_ older',objective='ObjectiveOnly',gain='GainOnly',
    state='open',claim_window_expires_at='2099-01-01',created_at='2001-01-01' WHERE work_item_id=$1`,[DEMO_WORK]);
  for(let index=0;index<ids.length;index++)await pool.query(`INSERT INTO work_items(
    work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,
    participation_terms_sha256,claim_window_expires_at,due_at,created_at)
    SELECT $1,community_id,owner_ref,$2,objective,acceptance_criteria,gain,$3,participation_terms,
    participation_terms_sha256,$4,due_at,'2030-01-01' FROM work_items WHERE work_item_id=$5`,
    [ids[index],index===0?'Needle%_ closed':index===1?'Needle%_ expired':index===2?'NeedleXY closed':`closed work ${index}`,
      index===1?'open':'claiming_closed',index===1?'2000-01-01':'2099-01-01',DEMO_WORK]);
  const unfiltered=readCursorWorkPage.parse((await request('/work-items/page',maker)).data);
  assert.equal(unfiltered.items.length,24);assert.equal(unfiltered.items.some(item=>item.work_item_id===DEMO_WORK),false);
  const open=await request('/work-items/page?scope=open',maker);assert.equal(open.status,200);
  assert.deepEqual(readCursorWorkPage.parse(open.data).items.map(item=>item.work_item_id),[DEMO_WORK]);
  for(const search of ['needle%_','ObjectiveOnly','GainOnly']){
    const filtered=await request('/work-items/page?scope=open&search='+encodeURIComponent(search),maker);
    assert.equal(filtered.status,200);
    assert.deepEqual(readCursorWorkPage.parse(filtered.data).items.map(item=>item.work_item_id),[DEMO_WORK]);
    assert.equal(filtered.data.next_cursor,null);
  }
  const all=await request('/work-items/page?scope=all&search='+encodeURIComponent('needle%_'),maker);
  assert.equal(all.status,200);
  assert.deepEqual(readCursorWorkPage.parse(all.data).items.map(item=>item.work_item_id),[...ids.slice(0,2).sort(),DEMO_WORK]);
  for(const query of ['scope=unknown','search='+encodeURIComponent('x'.repeat(2001)),'scope=open&scope=all'])
    assert.equal((await request('/work-items/page?'+query,maker)).status,422);
});

test('dashboard keeps ordered eligible reviewers and latest revisions without exposing internal join keys',async()=>{
  const maker=DEMO_USERS[0],reviewer=DEMO_USERS[1],client=DEMO_USERS[2],session=await signIn(reviewer.email);
  async function addClaim(label:string,createdAt:string,state:string,claimant:{user_id:string,profession_membership_ref:string},revisions:number[]|null,feedback:string|null=null,route:{until?:string,revoked?:Date|null}={}) {
    const id=randomUUID(),claimId=randomUUID();
    await pool.query(`INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,participation_terms,
      participation_terms_sha256,claim_window_expires_at,due_at,created_at)
      SELECT $1,community_id,owner_ref,$2,objective,acceptance_criteria,gain,'claiming_closed',participation_terms,participation_terms_sha256,
      claim_window_expires_at,due_at,'2026-01-01T00:00:00Z' FROM work_items WHERE work_item_id=$3`,[id,label,DEMO_WORK]);
    await pool.query('INSERT INTO work_review_routes(work_item_id,reviewer_ref,valid_until,revoked_at) VALUES($1,$2,$3,$4)',
      [id,reviewer.user_id,route.until??'2099-01-01T00:00:00Z',route.revoked??null]);
    await pool.query(`INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot,feedback,created_at)
      SELECT $1,work_item_id,$2,$3,$4,participation_terms_revision,participation_terms_sha256,participation_terms,$5,$6 FROM work_items WHERE work_item_id=$7`,
      [claimId,claimant.user_id,claimant.profession_membership_ref,state,feedback,createdAt,id]);
    if(revisions)for(const revision of revisions)await pool.query('INSERT INTO submissions(submission_id,claim_id,revision,summary,artifact_ref,sha256) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(),claimId,revision,`${label}-r${revision}`,`artifact:${label}-${revision}`,'b'.repeat(64)]);
    return claimId;
  }
  const self=await addClaim('self','2020-01-01T00:00:00Z','submitted',reviewer,[7]);
  const expired=await addClaim('expired','2020-02-01T00:00:00Z','submitted',maker,[8],null,{until:'2000-01-01T00:00:00Z'});
  const revoked=await addClaim('revoked','2020-03-01T00:00:00Z','submitted',maker,[9],null,{revoked:new Date('2020-03-02T00:00:00Z')});
  const changes=await addClaim('changes','2020-04-01T00:00:00Z','changes_requested',client,[10]);
  const empty=await request('/dashboard',session);assert.equal(empty.status,200);assert.deepEqual(readDashboard.parse(empty.data).review_queue,[]);
  const kept=await addClaim('kept','2026-02-01T00:00:00Z','submitted',maker,[2,1,3],'請看最新一版。');
  const first=await request('/dashboard',session);assert.equal(first.status,200);
  const one=readDashboard.parse(first.data).review_queue;assert.deepEqual(one.map(row=>row.claim.claim_id),[kept]);
  assert.equal(one[0].claim.latest_submission?.revision,3);assert.equal(one[0].claim.latest_submission?.summary,'kept-r3');
  assert.equal(one[0].claim.feedback,'請看最新一版。');assert.equal(one[0].claimant_name,maker.display_name);assert.equal(one[0].work_item.title,'kept');
  const missing=await addClaim('missing','2026-03-01T00:00:00Z','submitted',maker,null);
  const reviewing=await addClaim('reviewing','2026-03-15T00:00:00Z','in_review',client,[1]);
  const clientLatest=await addClaim('client-latest','2026-04-01T00:00:00Z','submitted',client,[4,1]);
  const fifth=await addClaim('fifth','2026-05-01T00:00:00Z','in_review',maker,[1]);
  const sixth=await addClaim('sixth','2026-06-01T00:00:00Z','submitted',client,[2]);
  const result=await request('/dashboard',session);assert.equal(result.status,200);
  const many=readDashboard.parse(result.data).review_queue;assert.deepEqual(many.map(row=>row.claim.claim_id),[kept,missing,reviewing,clientLatest,fifth,sixth]);
  assert.equal(many[2].claim.state,'in_review');assert.equal(many[3].claim.latest_submission?.revision,4);
  assert.equal(many[1].claim.latest_submission,null);assert.equal(many[2].claimant_name,client.display_name);
  for(const hidden of [self,expired,revoked,changes])assert.equal(many.some(row=>row.claim.claim_id===hidden),false);
});
async function waitForReadLock(pid:number,table:string,finished:()=>boolean) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const rows=z.array(z.object({query:z.string()})).parse((await pool.query('SELECT query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows);
    if(rows.some(row=>row.query.includes(table)))return;
    assert.equal(finished(),false,'read finished before the expected domain lock wait');
    await delay(10);
  }
  throw new Error(`domain ${table} lock wait not observed`);
}
async function sessionAlive(hash:string) {
  return z.object({alive:z.boolean()}).parse((await pool.query('SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS alive FROM sessions WHERE token_hash=$1',[hash])).rows[0]).alive;
}
for(const target of [{path:'/work-items',table:'submissions'},{path:'/work-items/page',table:'submissions'},{path:'/dashboard',table:'contributions'}] as const) {
  test(`${target.path} rejects session expiry after its final own submission or post-list wait`,async()=>{
    const maker=await signIn(),claim=readClaim.parse(await submitted(maker));assert.ok(claim.latest_submission);
    for(const expires of [true,false]) {
      const reader=await signIn(),token=readSessionCookie(reader.cookie,origin);assert.ok(token);const hash=tokenHash(token);
      assert.equal((await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[hash,expires?2:60])).rowCount,1);
      const locker=await pool.connect();let pending:ReturnType<typeof request>|undefined;
      try {
        await locker.query('BEGIN');await locker.query(`LOCK TABLE ${target.table} IN ACCESS EXCLUSIVE MODE`);
        const {pid}=z.object({pid:z.number().int()}).parse((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0]);
        let finished=false;pending=request(target.path,reader);void pending.then(()=>{finished=true},()=>{finished=true});
        await waitForReadLock(pid,target.table,()=>finished);
        if(expires) {
          const deadline=Date.now()+4000;
          while(await sessionAlive(hash)) {assert.ok(Date.now()<deadline,'session did not expire on the database clock');await delay(10);}
        }else await delay(2100);
        assert.equal(await sessionAlive(hash),!expires);await locker.query('COMMIT');
        const result=await pending;assert.equal(result.status,expires?401:200);
        if(expires) {
          assert.equal(z.object({code:z.string()}).parse(result.data).code,'session_expired');
          const raw=JSON.stringify(result.data);for(const value of [claim.claim_id,claim.latest_submission.submission_id,claim.latest_submission.summary,claim.latest_submission.artifact_ref])assert.equal(raw.includes(value),false);
        }else {
          const item=target.path.startsWith('/work-items')?readWorkPage.parse(result.data).items.find(row=>row.work_item_id===DEMO_WORK)
            :readDashboard.parse(result.data).now.find(row=>row.work_item_id===DEMO_WORK);
          assert.equal(item?.my_claim?.claim_id,claim.claim_id);assert.deepEqual(item?.my_claim?.latest_submission,claim.latest_submission);
        }
      }finally {await locker.query('ROLLBACK');locker.release();if(pending)await pending.catch(()=>{});}
    }
  });
}
test('dashboard review expiry advances between statements within its session transaction',async()=>{
  const maker=await signIn(),reviewer=await signIn(DEMO_USERS[1].email),claim=readClaim.parse(await submitted(maker));
  const locker=await pool.connect();let pending:ReturnType<typeof request>|undefined;
  try {
    await locker.query('BEGIN');await locker.query('LOCK TABLE contributions IN ACCESS EXCLUSIVE MODE');
    const {pid}=z.object({pid:z.number().int()}).parse((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0]);
    let finished=false;pending=request('/dashboard',reviewer);void pending.then(()=>{finished=true},()=>{finished=true});
    await waitForReadLock(pid,'contributions',()=>finished);
    assert.equal((await pool.query("UPDATE work_review_routes SET valid_until=clock_timestamp()+interval '200 milliseconds' WHERE work_item_id=$1 AND reviewer_ref=$2",[DEMO_WORK,DEMO_USERS[1].user_id])).rowCount,1);
    const deadline=Date.now()+3000;
    while(z.object({alive:z.boolean()}).parse((await pool.query('SELECT valid_until>clock_timestamp() AS alive FROM work_review_routes WHERE work_item_id=$1 AND reviewer_ref=$2',[DEMO_WORK,DEMO_USERS[1].user_id])).rows[0]).alive) {assert.ok(Date.now()<deadline,'review lease did not expire');await delay(10);}
    await locker.query('COMMIT');const result=await pending;assert.equal(result.status,200);
    assert.equal(readDashboard.parse(result.data).review_queue.some(row=>row.claim.claim_id===claim.claim_id),false);
    assert.ok(claim.latest_submission);assert.equal(JSON.stringify(result.data).includes(claim.latest_submission.summary),false);
  }finally {await locker.query('ROLLBACK');locker.release();if(pending)await pending.catch(()=>{});}
});

test('login → claim → submit → request changes → resubmit → independent acceptance → persisted gains',async()=>{
  const maker=await signIn(),reviewer=await signIn(DEMO_USERS[1].email);
  let c=await submitted(maker);c=await action(reviewer,c,'begin-review');
  c=await action(reviewer,c,'decide',{decision:'changes_requested',feedback:'請補上預期輸出。',submission_sha256:c.latest_submission.sha256});
  assert.equal((await request('/dashboard',maker)).data.gained.length,0);
  const first=c.latest_submission.submission_id;
  c=await action(maker,c,'submit',{summary:'已加入預期輸出及完整步驟。',artifact_ref:'artifact:example-v2'});
  assert.notEqual(c.latest_submission.submission_id,first);
  c=await action(reviewer,c,'begin-review');
  const body={decision:'accept',feedback:'符合這件工作的驗收條件。',submission_sha256:c.latest_submission.sha256},key=randomUUID();
  const accepted=await request(`/work-claims/${c.claim_id}:decide`,reviewer,body,c.aggregate_version,key);
  assert.equal(accepted.status,200);assert.equal(accepted.data.state,'accepted');
  const replay=await request(`/work-claims/${c.claim_id}:decide`,reviewer,body,c.aggregate_version,key);
  assert.deepEqual(replay.data,accepted.data);
  const freshApp=createApp(pool,origin); // Recreated application reads PostgreSQL facts, no process-local projections.
  const result=await freshApp.request(origin+'/api/v1/dashboard',{headers:{Cookie:maker.cookie}});
  const dashboard:any=await result.json();assert.equal(dashboard.gained.length,1);assert.equal(dashboard.gained[0].official,false);
  const records=(await request('/me/contribution-records',maker)).data;
  assert.equal(records.accepted_count,1);assert.equal(records.total,undefined);assert.equal(records.next_offset,null);
  assert.equal(records.entries[0].work_item_id,DEMO_WORK);
  assert.ok(records.entries[0].decision_id);
  assert.equal(records.entries[0].acting_profession_membership_ref,maker.user.profession_membership_ref);
  const world=(await request('/community/accepted-work',maker)).data.items;
  assert.ok(world.some((item:any)=>item.contribution_id===records.entries[0].contribution_id&&item.member_name===maker.user.display_name));
  assert.equal(dashboard.gained[0].artifact_ref,'artifact:example-v2');assert.equal(dashboard.now.length,0);
  assert.equal((await pool.query('SELECT count(*) FROM contributions')).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM work_decisions')).rows[0].count,'2');
  assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE event_type='freedom.work.submission.accepted.v1'")).rows[0].count,'1');
});
test('personal contribution records return bounded stable pages with an exact count',async()=>{
  const maker=await signIn(),reviewer=await signIn(DEMO_USERS[1].email);
  const source=await acceptFor(maker,reviewer);
  await pool.query(`UPDATE contributions SET accepted_at='2002-01-01T00:00:00Z' WHERE work_item_id=$1`,[source.work_item_id]);
  await pool.query(`WITH generated AS (
      SELECT value,
        ('95000000-0000-4000-8000-'||lpad(value::text,12,'0'))::uuid AS work_id,
        ('95100000-0000-4000-8000-'||lpad(value::text,12,'0'))::uuid AS claim_id,
        ('95200000-0000-4000-8000-'||lpad(value::text,12,'0'))::uuid AS submission_id,
        ('95300000-0000-4000-8000-'||lpad(value::text,12,'0'))::uuid AS decision_id,
        ('95400000-0000-4000-8000-'||lpad(value::text,12,'0'))::uuid AS contribution_id
      FROM generate_series(0,21) value),
    source_work AS (SELECT * FROM work_items WHERE work_item_id=$4),
    inserted_works AS (
      INSERT INTO work_items(work_item_id,community_id,owner_ref,title,objective,acceptance_criteria,gain,state,
        participation_terms,participation_terms_sha256,claim_window_expires_at,due_at,created_at)
      SELECT g.work_id,w.community_id,w.owner_ref,'分頁成果 '||g.value,w.objective,w.acceptance_criteria,w.gain,'accepted',
        w.participation_terms,w.participation_terms_sha256,w.claim_window_expires_at,w.due_at,'2001-01-01T00:00:00Z'
      FROM generated g CROSS JOIN source_work w RETURNING work_item_id),
    inserted_claims AS (
      INSERT INTO work_claims(claim_id,work_item_id,claimant_ref,acting_profession_membership_ref,state,terms_revision,terms_sha256,terms_snapshot)
      SELECT g.claim_id,g.work_id,$1,$2,'accepted',1,w.participation_terms_sha256,w.participation_terms
      FROM generated g JOIN inserted_works i ON i.work_item_id=g.work_id CROSS JOIN source_work w RETURNING claim_id),
    inserted_submissions AS (
      INSERT INTO submissions(submission_id,claim_id,revision,summary,artifact_ref,sha256)
      SELECT g.submission_id,g.claim_id,1,'分頁成果摘要','artifact:pagination-'||g.value,repeat('a',64)
      FROM generated g JOIN inserted_claims i ON i.claim_id=g.claim_id RETURNING submission_id),
    inserted_decisions AS (
      INSERT INTO work_decisions(decision_id,claim_id,submission_id,reviewer_ref,decision,feedback,submission_sha256)
      SELECT g.decision_id,g.claim_id,g.submission_id,$3,'accept','分頁驗收',repeat('a',64)
      FROM generated g JOIN inserted_submissions i ON i.submission_id=g.submission_id RETURNING decision_id)
    INSERT INTO contributions(contribution_id,claim_id,user_id,community_id,work_item_id,decision_id,title,summary,artifact_ref,accepted_at)
      SELECT g.contribution_id,g.claim_id,$1,w.community_id,g.work_id,g.decision_id,'分頁成果 '||g.value,'分頁成果摘要','artifact:pagination-'||g.value,'2001-01-01T00:00:00Z'
      FROM generated g JOIN inserted_decisions i ON i.decision_id=g.decision_id CROSS JOIN source_work w`,
  [maker.user.user_id,maker.user.profession_membership_ref,reviewer.user.user_id,source.work_item_id]);
  const sourceContribution=(await pool.query('SELECT contribution_id FROM contributions WHERE work_item_id=$1',[source.work_item_id])).rows[0].contribution_id as string;
  const expected=[sourceContribution,...Array.from({length:22},(_,index)=>`95400000-0000-4000-8000-${index.toString().padStart(12,'0')}`).reverse()];

  const first=await request('/me/contribution-records?limit=10&offset=0',maker);
  assert.equal(first.status,200);assert.equal(first.data.entries.length,10);assert.equal(first.data.accepted_count,23);assert.equal(first.data.next_offset,10);
  const second=(await request('/me/contribution-records?limit=10&offset=10',maker)).data;
  const final=(await request('/me/contribution-records?limit=10&offset=20',maker)).data;
  assert.deepEqual([...first.data.entries,...second.entries,...final.entries].map((row:any)=>row.contribution_id),expected);
  assert.equal(second.accepted_count,23);assert.equal(second.next_offset,20);
  assert.equal(final.entries.length,3);assert.equal(final.accepted_count,23);assert.equal(final.next_offset,null);
  assert.deepEqual((await request('/me/contribution-records?limit=10&offset=30',maker)).data,{policy:'accepted_work_facts_v1',accepted_count:23,entries:[],next_offset:null});
  for(const query of ['limit=0','limit=51','limit=1.5','offset=-1','offset=1.5','extra=1'])
    assert.equal((await request(`/me/contribution-records?${query}`,maker)).status,422,query);
  const other=await signIn(DEMO_USERS[2].email),isolated=(await request('/me/contribution-records',other)).data;
  assert.equal(isolated.accepted_count,0);assert.deepEqual(isolated.entries,[]);
});

test('personal contribution references reject expired SQL waits and preserve current owner facts',async()=>{
  const maker=await signIn(),other=await signIn(DEMO_USERS[2].email),reviewer=await signIn(DEMO_USERS[1].email);
  const own=await acceptFor(maker,reviewer),foreign=await acceptFor(other,reviewer);
  const entry=z.object({contribution_id:z.uuid(),claim_id:z.uuid(),work_item_id:z.uuid(),decision_id:z.uuid(),title:z.string(),
    accepted_at:z.string(),acting_profession_membership_ref:z.uuid(),reviewer_ref:z.uuid()}).strict();
  const records=z.object({policy:z.literal('accepted_work_facts_v1'),accepted_count:z.number().int(),entries:z.array(entry),next_offset:z.number().int().nullable()}).strict();
  const original=records.parse((await request('/me/contribution-records',maker)).data);
  const otherRecords=records.parse((await request('/me/contribution-records',other)).data);
  assert.equal(original.accepted_count,1);assert.equal(otherRecords.accepted_count,1);
  assert.deepEqual(original.entries.map(row=>row.work_item_id),[z.uuid().parse(own.work_item_id)]);
  assert.deepEqual(otherRecords.entries.map(row=>row.work_item_id),[z.uuid().parse(foreign.work_item_id)]);
  assert.equal(original.entries[0].claim_id,z.uuid().parse(own.claim_id));
  assert.equal(original.entries[0].acting_profession_membership_ref,z.uuid().parse(maker.user.profession_membership_ref));
  assert.equal(original.entries[0].reviewer_ref,z.uuid().parse(reviewer.user.user_id));
  assert.deepEqual(records.parse((await request('/me/contribution-records',reviewer)).data).entries,[]);
  for(const row of otherRecords.entries)for(const value of [row.contribution_id,row.claim_id,row.work_item_id,row.decision_id,row.acting_profession_membership_ref])
    assert.equal(JSON.stringify(original).includes(value),false);
  for(const expires of [true,false]){
    const reader=await signIn(),token=readSessionCookie(reader.cookie,origin);assert.ok(token);
    const hash=tokenHash(token);
    assert.equal((await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[hash,expires?2:60])).rowCount,1);
    const locker=await pool.connect();
    let pending:Promise<{status:number;data:unknown}>|undefined;
    async function isAlive(){return z.object({alive:z.boolean()}).parse((await pool.query(
      'SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS alive FROM sessions WHERE token_hash=$1',[hash])).rows[0]).alive;}
    try{
      await locker.query('BEGIN');await locker.query('LOCK TABLE work_claims IN ACCESS EXCLUSIVE MODE');
      const {pid}=z.object({pid:z.number().int()}).parse((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0]);
      let finished=false;pending=request('/me/contribution-records',reader);
      void pending.then(()=>{finished=true},()=>{finished=true});
      const deadline=Date.now()+5000;let blocked=false;
      while(Date.now()<deadline){
        blocked=(await pool.query(`SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
          WHERE $1=ANY(pg_blocking_pids(a.pid)) AND NOT l.granted AND l.relation='work_claims'::regclass
          AND a.wait_event_type='Lock'`,[pid])).rowCount!==0;
        if(blocked)break;assert.equal(finished,false);await delay(10);
      }
      assert.equal(blocked,true,'contribution reader must reach its native claim relation wait');
      if(expires){
        const expiryDeadline=Date.now()+4000;
        while(await isAlive()){assert.ok(Date.now()<expiryDeadline);await delay(10);}
      }else await delay(2100);
      assert.equal(await isAlive(),!expires);await locker.query('COMMIT');
      const result=await pending;
      if(expires){
        assert.equal(result.status,401);assert.equal(z.object({code:z.string()}).parse(result.data).code,'session_expired');
        const raw=JSON.stringify(result.data);
        for(const row of [...original.entries,...otherRecords.entries])for(const value of
          [row.contribution_id,row.claim_id,row.work_item_id,row.decision_id,row.acting_profession_membership_ref])assert.equal(raw.includes(value),false);
      }else{
        assert.equal(result.status,200);assert.deepEqual(records.parse(result.data),original);
      }
    }finally{
      await locker.query('ROLLBACK');locker.release();if(pending)await pending.catch(()=>{});
    }
  }
  assert.deepEqual(records.parse((await request('/me/contribution-records',maker)).data),original);
  assert.deepEqual(records.parse((await request('/me/contribution-records',other)).data),otherRecords);
  assert.equal((await pool.query('SELECT count(*) FROM contributions')).rows[0].count,'2');
  assert.equal((await pool.query('SELECT count(*) FROM work_decisions')).rows[0].count,'2');
});
test('concurrent exclusive claims have one winner and preserve atomic facts',async()=>{
  const a=await signIn(),b=await signIn(DEMO_USERS[2].email),w=await work(a);
  const outcomes=await Promise.all([a,b].map(s=>request(`/work-items/${w.work_item_id}:claim`,s,claimBody(s,w),w.aggregate_version)));
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[201,412]);
  assert.equal((await pool.query('SELECT count(*) FROM work_claims')).rows[0].count,'1');
  assert.equal((await work(a)).state,'claiming_closed');
});
const windowClaim=z.object({claim_id:z.uuid(),work_item_id:z.uuid(),claimant_ref:z.uuid(),state:z.string(),aggregate_version:z.number().int()});
const windowWork=z.object({work_item_id:z.uuid(),aggregate_version:z.number().int(),participation_terms_revision:z.number().int(),participation_terms_sha256:z.string()});
const windowFacts=z.object({state:z.string(),version:z.string(),claims:z.string(),journal:z.string(),events:z.string(),receipts:z.string()});
async function currentWindowFacts(id:string,key:string,userId:string) {
  return windowFacts.parse((await pool.query(`SELECT w.state,w.aggregate_version::text AS version,
    (SELECT count(*)::text FROM work_claims WHERE work_item_id=w.work_item_id) AS claims,
    (SELECT count(*)::text FROM transition_journal WHERE aggregate_id=w.work_item_id OR aggregate_id IN(SELECT claim_id FROM work_claims WHERE work_item_id=w.work_item_id)) AS journal,
    (SELECT count(*)::text FROM outbox o JOIN transition_journal j USING(transition_id) WHERE j.aggregate_id=w.work_item_id OR j.aggregate_id IN(SELECT claim_id FROM work_claims WHERE work_item_id=w.work_item_id)) AS events,
    (SELECT count(*)::text FROM command_receipts WHERE idempotency_key=$2 AND user_id=$3) AS receipts
    FROM work_items w WHERE work_item_id=$1`,[id,key,userId])).rows[0]);
}
async function claimWindowAlive(id:string) {
  return z.object({alive:z.boolean()}).parse((await pool.query('SELECT claim_window_expires_at>clock_timestamp() AS alive FROM work_items WHERE work_item_id=$1',[id])).rows[0]).alive;
}
async function waitForClaimWindowCommand(pid:number,sql:string,finished:()=>boolean) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const rows=z.array(z.object({query:z.string()})).parse((await pool.query('SELECT query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows);
    if(rows.some(row=>row.query.includes(sql)))return;
    assert.equal(finished(),false,'claim finished before its expected domain wait');await delay(10);
  }
  throw new Error(`expected claim window wait not observed: ${sql}`);
}
for(const kind of ['work-lock','claim-insert','receipt-insert','receipt-replay'] as const) {
  test(`claim window after ${kind} rolls back only new claims and preserves historical receipts`,async()=>{
    const owner=await signIn(DEMO_USERS[1].email),maker=await signIn(),user=z.object({user_id:z.uuid(),profession_membership_ref:z.uuid()}).parse(maker.user);
    for(const expires of [true,false]) {
      const work=windowWork.parse(await newWork(owner,{will_review:false})),key=randomUUID();
      const body={claimant_type:'user',acting_profession_membership_ref:user.profession_membership_ref,expected_aggregate_version:work.aggregate_version,
        terms_status:'declared',participation_terms_revision:work.participation_terms_revision,participation_terms_sha256:work.participation_terms_sha256};
      let original:unknown;
      if(kind==='receipt-replay') {const result=await request(`/work-items/${work.work_item_id}:claim`,maker,body,String(work.aggregate_version),key);assert.equal(result.status,201);original=result.data;}
      const before=await currentWindowFacts(work.work_item_id,key,user.user_id);
      assert.equal((await pool.query('UPDATE work_items SET claim_window_expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE work_item_id=$1',[work.work_item_id,expires?2:90])).rowCount,1);
      const locker=await pool.connect();let pending:Promise<{status:number;data:unknown;response:Response}>|undefined;
      try {
        await locker.query('BEGIN');
        if(kind==='work-lock')await locker.query('SELECT work_item_id FROM work_items WHERE work_item_id=$1 FOR UPDATE',[work.work_item_id]);
        else if(kind==='claim-insert')await locker.query('LOCK TABLE work_claims IN SHARE MODE');
        else if(kind==='receipt-insert')await locker.query('LOCK TABLE command_receipts IN SHARE MODE');
        else await locker.query('LOCK TABLE command_receipts IN ACCESS EXCLUSIVE MODE');
        const {pid}=z.object({pid:z.number().int()}).parse((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0]);
        let finished=false;pending=request(`/work-items/${work.work_item_id}:claim`,maker,body,String(work.aggregate_version),key);void pending.then(()=>{finished=true},()=>{finished=true});
        await waitForClaimWindowCommand(pid,kind==='work-lock'?'FOR UPDATE':kind==='claim-insert'?'INSERT INTO work_claims':kind==='receipt-insert'?'INSERT INTO command_receipts':'SELECT * FROM command_receipts',()=>finished);
        if(expires) {
          const deadline=Date.now()+4000;
          while(await claimWindowAlive(work.work_item_id)) {assert.ok(Date.now()<deadline,'claim window did not expire on the database clock');await delay(10);}
        }else await delay(2100);
        assert.equal(await claimWindowAlive(work.work_item_id),!expires);
        assert.equal(z.object({alive:z.boolean()}).parse((await pool.query('SELECT bool_and(revoked_at IS NULL AND expires_at>clock_timestamp()) AS alive FROM sessions WHERE user_id=$1',[user.user_id])).rows[0]).alive,true);
        await locker.query('COMMIT');const result=await pending;
        if(expires&&kind!=='receipt-replay') {
          assert.equal(result.status,409);assert.equal(z.object({code:z.string()}).parse(result.data).code,'claim_window_closed');
          assert.deepEqual(await currentWindowFacts(work.work_item_id,key,user.user_id),before);
        }else {
          assert.equal(result.status,201);const claim=windowClaim.parse(result.data);assert.equal(claim.state,'claimed');assert.equal(claim.claimant_ref,user.user_id);
          const after=await currentWindowFacts(work.work_item_id,key,user.user_id);assert.equal(after.claims,'1');assert.equal(after.receipts,'1');
          if(original!==undefined) {assert.deepEqual(result.data,original);assert.deepEqual(after,before);}
          if(expires&&kind==='receipt-replay') {
            const started=await request(`/work-claims/${claim.claim_id}:start`,maker,{},String(claim.aggregate_version));assert.equal(started.status,200);
            const current=windowClaim.parse(started.data);assert.equal(current.state,'in_progress');
            const state=await currentWindowFacts(work.work_item_id,key,user.user_id);
            const replay=await request(`/work-items/${work.work_item_id}:claim`,maker,body,String(work.aggregate_version),key);
            assert.equal(replay.status,201);assert.deepEqual(replay.data,original);assert.deepEqual(await currentWindowFacts(work.work_item_id,key,user.user_id),state);
            assert.deepEqual(z.object({state:z.string(),version:z.string()}).parse((await pool.query('SELECT state,aggregate_version::text AS version FROM work_claims WHERE claim_id=$1',[claim.claim_id])).rows[0]),{state:'in_progress',version:String(current.aggregate_version)});
          }
        }
      }finally {await locker.query('ROLLBACK');locker.release();if(pending)await pending.catch(()=>{});}
    }
  });
}

test('missing reviewer does not block claim; expired invitation cannot erase an established claim',async()=>{
  const owner=await signIn(DEMO_USERS[1].email),maker=await signIn();const w=await newWork(owner,{will_review:false});
  assert.equal(w.review_capacity,'waiting_reviewer_capacity');let c=await claim(maker,w.work_item_id);
  await pool.query("UPDATE work_items SET claim_window_expires_at=now()-interval '1 day' WHERE work_item_id=$1",[w.work_item_id]);
  c=await action(maker,c,'start');assert.equal(c.state,'in_progress');
  assert.equal((await request('/dashboard',owner)).data.review_queue.length,0);
});
test('expired claim window and changed participation terms reject before writing',async()=>{
  const maker=await signIn(),w=await work(maker),body=claimBody(maker,w);
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,maker,{...body,participation_terms_sha256:'a'.repeat(64)},w.aggregate_version)).status,409);
  await pool.query("UPDATE work_items SET claim_window_expires_at=now()-interval '1 second' WHERE work_item_id=$1",[DEMO_WORK]);
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,maker,body,w.aggregate_version)).data.code,'claim_window_closed');
  assert.equal((await pool.query('SELECT count(*) FROM work_claims')).rows[0].count,'0');
});
test('a committed work creation can be replayed after its claim deadline without creating another work',async t=>{
  const owner=await signIn(DEMO_USERS[1].email),now=Date.now(),key=randomUUID();
  const body={title:'延後重試的工作',objective:'確認未知回應的結果',acceptance_criteria:'同一操作只建立一次',gain:'自願公共成果',estimated_minutes:10,maximum_minutes:20,claim_by:new Date(now+86400000).toISOString(),finish_by:new Date(now+2*86400000).toISOString(),will_review:false};
  const created=await request('/work-items',owner,body,undefined,key);assert.equal(created.status,201);
  t.mock.method(Date,'now',()=>now+3*86400000);
  const replay=await request('/work-items',owner,body,undefined,key);assert.equal(replay.status,201);assert.deepEqual(replay.data,created.data);
  assert.equal((await request('/work-items',owner,body)).status,422);
  assert.equal((await pool.query('SELECT count(*) FROM work_items')).rows[0].count,'2');
});
test('session, Origin and CSRF controls reject forged mutations and revoked cookies',async()=>{
  const maker=await signIn(),w=await work(maker),body=claimBody(maker,w);
  assert.equal((await request('/dashboard')).status,401);
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,maker,body,w.aggregate_version,randomUUID(),{'X-CSRF-Token':'fake'})).status,403);
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,maker,body,w.aggregate_version,randomUUID(),{Origin:'https://evil.example'})).status,403);
  const logout=await request('/auth/logout',maker,{});assert.equal(logout.status,200);
  assert.equal((await request('/dashboard',maker)).status,401);
});
test('staging login uses secure cookies and preserves Origin, Host and CSRF enforcement',async()=>{
  const stagingOrigin='https://staging.freetwai.com';
  const staging=createApp(pool,stagingOrigin,'staging');
  const credentials=JSON.stringify({email:DEMO_USERS[0].email,password:DEMO_PASSWORD});
  for(const rejectedOrigin of [origin,'https://evil.example','null']) {
    const denied=await staging.request(stagingOrigin+'/api/v1/auth/login',{
      method:'POST',headers:{Origin:rejectedOrigin,'Content-Type':'application/json'},body:credentials,
    });
    assert.equal(denied.status,403);assert.equal(denied.headers.get('set-cookie'),null);
  }
  assert.equal((await staging.request('https://evil.example/api/v1/health')).status,403);
  const loggedIn=await staging.request(stagingOrigin+'/api/v1/auth/login',{
    method:'POST',headers:{Origin:stagingOrigin,'Content-Type':'application/json'},body:credentials,
  });
  assert.equal(loggedIn.status,200);
  const setCookie=loggedIn.headers.get('set-cookie')!;
  assert.match(setCookie,/; Secure/);assert.match(setCookie,/; HttpOnly/);assert.match(setCookie,/; SameSite=Strict/);
  const session:any=await loggedIn.json();
  const headers={Cookie:setCookie.split(';')[0],Origin:stagingOrigin,'Content-Type':'application/json'};
  assert.equal((await staging.request(stagingOrigin+'/api/v1/session',{headers})).status,200);
  assert.equal((await staging.request(stagingOrigin+'/api/v1/auth/logout',{method:'POST',headers,body:'{}'})).status,403);
  const logout=await staging.request(stagingOrigin+'/api/v1/auth/logout',{
    method:'POST',headers:{...headers,'X-CSRF-Token':session.csrf_token},body:'{}',
  });
  assert.equal(logout.status,200);
  assert.equal((await staging.request(stagingOrigin+'/api/v1/session',{headers})).status,401);
});
test('localhost alias works on the configured port while other ports and remote hosts are rejected',async()=>{
  const credentials={email:DEMO_USERS[0].email,password:DEMO_PASSWORD};
  const r=await request('/auth/login',undefined,credentials,undefined,randomUUID(),{Origin:'http://localhost:4310'});
  assert.equal(r.status,200);
  const session={cookie:r.response.headers.get('set-cookie')!.split(';')[0],csrf:r.data.csrf_token,user:r.data.user};
  const w=await work(session);
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,session,claimBody(session,w),w.aggregate_version,randomUUID(),{Origin:'http://localhost:4310'})).status,201);
  for(const origin of ['http://localhost:4312','http://127.0.0.1.evil.example:4310','null','https://localhost:4310']) {
    assert.equal((await request('/auth/login',undefined,credentials,undefined,randomUUID(),{Origin:origin})).status,403);
  }
});
const reviewClockClaim=z.object({claim_id:z.uuid(),work_item_id:z.uuid(),state:z.string(),aggregate_version:z.number().int(),
  latest_submission:z.object({submission_id:z.uuid(),summary:z.string(),artifact_ref:z.string(),sha256:z.string(),revision:z.number().int()}).nullable().optional()});
const reviewClockFacts=z.object({state:z.string(),version:z.string(),work_state:z.string(),work_version:z.string(),
  decisions:z.string(),contributions:z.string(),journal:z.string(),events:z.string(),receipts:z.string()});
async function currentReviewFacts(claim:z.infer<typeof reviewClockClaim>,key:string,userId:string) {
  return reviewClockFacts.parse((await pool.query(`SELECT c.state,c.aggregate_version::text AS version,w.state AS work_state,w.aggregate_version::text AS work_version,
    (SELECT count(*)::text FROM work_decisions WHERE claim_id=c.claim_id) AS decisions,
    (SELECT count(*)::text FROM contributions WHERE claim_id=c.claim_id) AS contributions,
    (SELECT count(*)::text FROM transition_journal WHERE aggregate_id IN(c.claim_id,c.work_item_id)) AS journal,
    (SELECT count(*)::text FROM outbox o JOIN transition_journal j USING(transition_id) WHERE j.aggregate_id IN(c.claim_id,c.work_item_id)) AS events,
    (SELECT count(*)::text FROM command_receipts WHERE idempotency_key=$2 AND user_id=$3) AS receipts
    FROM work_claims c JOIN work_items w USING(work_item_id) WHERE c.claim_id=$1`,[claim.claim_id,key,userId])).rows[0]);
}
async function reviewAlive(workId:string,userId:string) {
  return z.object({alive:z.boolean()}).parse((await pool.query('SELECT valid_until>clock_timestamp() AS alive FROM work_review_routes WHERE work_item_id=$1 AND reviewer_ref=$2',[workId,userId])).rows[0]).alive;
}
async function waitForReviewCommand(pid:number,sql:string,finished:()=>boolean) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const rows=z.array(z.object({query:z.string()})).parse((await pool.query('SELECT query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows);
    if(rows.some(row=>row.query.includes(sql)))return;
    assert.equal(finished(),false,'command completed before the expected SQL wait');await delay(10);
  }
  throw new Error(`expected review command wait not observed: ${sql}`);
}
for(const kind of ['claim-lock','route-lock','decision-insert','receipt-insert','receipt-replay'] as const) {
  test(`review authority expires after ${kind} without committing or losing a legal receipt`,async()=>{
    const maker=await signIn(),reviewer=await signIn(DEMO_USERS[1].email),userId=z.object({user_id:z.uuid()}).parse(reviewer.user).user_id;
    for(const expires of [true,false]) {
      const work=z.object({work_item_id:z.uuid()}).parse(await newWork(reviewer));
      let c=reviewClockClaim.parse(await claim(maker,work.work_item_id));
      c=reviewClockClaim.parse(await action(maker,c,'start'));
      c=reviewClockClaim.parse(await action(maker,c,'submit',{summary:`review-clock-${kind}-${expires}`,artifact_ref:`artifact:review-clock-${kind}-${expires}`}));
      const key=randomUUID();let name='begin-review';let body:unknown={};let original:unknown;let version=c.aggregate_version;
      if(kind==='decision-insert') {
        c=reviewClockClaim.parse(await action(reviewer,c,'begin-review'));version=c.aggregate_version;name='decide';assert.ok(c.latest_submission);
        body={decision:'accept',feedback:'符合合成驗收條件。',submission_sha256:c.latest_submission.sha256};
      }
      if(kind==='receipt-replay') {const result=await request(`/work-claims/${c.claim_id}:${name}`,reviewer,body,String(version),key);assert.equal(result.status,200);original=result.data;}
      const before=await currentReviewFacts(c,key,userId);
      assert.equal((await pool.query('UPDATE work_review_routes SET valid_until=clock_timestamp()+make_interval(secs=>$3) WHERE work_item_id=$1 AND reviewer_ref=$2',[c.work_item_id,userId,expires?2:90])).rowCount,1);
      const locker=await pool.connect();let pending:Promise<{status:number;data:unknown;response:Response}>|undefined;
      try {
        await locker.query('BEGIN');
        if(kind==='claim-lock')await locker.query('SELECT claim_id FROM work_claims WHERE claim_id=$1 FOR UPDATE',[c.claim_id]);
        else if(kind==='route-lock')await locker.query('SELECT work_item_id FROM work_review_routes WHERE work_item_id=$1 AND reviewer_ref=$2 FOR UPDATE',[c.work_item_id,userId]);
        else if(kind==='decision-insert')await locker.query('LOCK TABLE work_decisions IN SHARE MODE');
        else if(kind==='receipt-insert')await locker.query('LOCK TABLE command_receipts IN SHARE MODE');
        else await locker.query('LOCK TABLE command_receipts IN ACCESS EXCLUSIVE MODE');
        const {pid}=z.object({pid:z.number().int()}).parse((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0]);
        let finished=false;pending=request(`/work-claims/${c.claim_id}:${name}`,reviewer,body,String(version),key);void pending.then(()=>{finished=true},()=>{finished=true});
        await waitForReviewCommand(pid,kind==='claim-lock'?'FOR UPDATE OF c':kind==='route-lock'?'FROM work_review_routes':kind==='decision-insert'?'INSERT INTO work_decisions':kind==='receipt-insert'?'INSERT INTO command_receipts':'SELECT * FROM command_receipts',()=>finished);
        if(expires) {
          const deadline=Date.now()+4000;
          while(await reviewAlive(c.work_item_id,userId)) {assert.ok(Date.now()<deadline,'review authority did not expire on the database clock');await delay(10);}
        }else await delay(2100);
        assert.equal(await reviewAlive(c.work_item_id,userId),!expires);
        assert.equal(z.object({alive:z.boolean()}).parse((await pool.query('SELECT bool_and(revoked_at IS NULL AND expires_at>clock_timestamp()) AS alive FROM sessions WHERE user_id=$1',[userId])).rows[0]).alive,true);
        await locker.query('COMMIT');const result=await pending;
        if(expires) {
          assert.equal(result.status,403);assert.equal(z.object({code:z.string()}).parse(result.data).code,'review_authority_required');
          assert.deepEqual(await currentReviewFacts(c,key,userId),before);
          assert.ok(c.latest_submission);const raw=JSON.stringify(result.data);
          for(const value of [c.claim_id,c.latest_submission.submission_id,c.latest_submission.summary,c.latest_submission.artifact_ref])assert.equal(raw.includes(value),false);
          await pool.query("UPDATE work_review_routes SET valid_until=clock_timestamp()+interval '90 seconds' WHERE work_item_id=$1 AND reviewer_ref=$2",[c.work_item_id,userId]);
        }else assert.equal(result.status,200);
        const recovered=expires?await request(`/work-claims/${c.claim_id}:${name}`,reviewer,body,String(version),key):result;
        assert.equal(recovered.status,200);
        const value=reviewClockClaim.parse(recovered.data);assert.equal(value.state,name==='decide'?'accepted':'in_review');
        if(original!==undefined)assert.deepEqual(recovered.data,original);
        const after=await currentReviewFacts(c,key,userId);
        assert.equal(after.receipts,'1');assert.equal(after.decisions,name==='decide'?'1':'0');assert.equal(after.contributions,name==='decide'?'1':'0');
        const replay=await request(`/work-claims/${c.claim_id}:${name}`,reviewer,body,String(version),key);
        assert.equal(replay.status,200);assert.deepEqual(replay.data,recovered.data);assert.deepEqual(await currentReviewFacts(c,key,userId),after);
      }finally {await locker.query('ROLLBACK');locker.release();if(pending)await pending.catch(()=>{});}
    }
  });
}

test('review route is scoped, revocable, independent, and checked again for idempotent replay',async()=>{
  const maker=await signIn(),reviewer=await signIn(DEMO_USERS[1].email),outsider=await signIn(DEMO_USERS[2].email);let c=await submitted(maker);
  for(const s of [maker,outsider])assert.equal((await request(`/work-claims/${c.claim_id}:begin-review`,s,{},c.aggregate_version)).status,403);
  const key=randomUUID(),oldVersion=c.aggregate_version;
  const begun=await request(`/work-claims/${c.claim_id}:begin-review`,reviewer,{},oldVersion,key);assert.equal(begun.status,200);
  await pool.query('UPDATE work_review_routes SET revoked_at=now()');
  assert.equal((await request(`/work-claims/${c.claim_id}:begin-review`,reviewer,{},oldVersion,key)).status,403);
  assert.equal((await request(`/work-claims/${c.claim_id}:decide`,reviewer,{decision:'accept',feedback:'不能通過',submission_sha256:c.latest_submission.sha256},begun.data.aggregate_version)).status,403);
  assert.equal((await pool.query('SELECT count(*) FROM contributions')).rows[0].count,'0');
});
test('different body on same idempotency key, stale version, and altered result digest are rejected',async()=>{
  const maker=await signIn(),reviewer=await signIn(DEMO_USERS[1].email);let c=await claim(maker);
  assert.equal((await request(`/work-claims/${c.claim_id}:start`,maker,{},'9')).status,412);
  c=await action(maker,c,'start');const key=randomUUID(),body={summary:'第一版',artifact_ref:'artifact:v1'};
  const sent=await request(`/work-claims/${c.claim_id}:submit`,maker,body,c.aggregate_version,key);assert.equal(sent.status,200);
  assert.equal((await request(`/work-claims/${c.claim_id}:submit`,maker,{...body,summary:'改版'},c.aggregate_version,key)).status,409);
  c=await action(reviewer,sent.data,'begin-review');
  assert.equal((await request(`/work-claims/${c.claim_id}:decide`,reviewer,{decision:'accept',feedback:'通過',submission_sha256:'f'.repeat(64)},c.aggregate_version)).status,409);
  assert.equal((await pool.query('SELECT count(*) FROM work_decisions')).rows[0].count,'0');
});
test('a downstream database failure rolls back decision, contribution, state, event and receipt together',async()=>{
  const maker=await signIn(),reviewer=await signIn(DEMO_USERS[1].email);let c=await submitted(maker);c=await action(reviewer,c,'begin-review');
  await pool.query("CREATE FUNCTION refuse_test_contribution() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic storage failure'; END $$");
  await pool.query('CREATE TRIGGER refuse_test BEFORE INSERT ON contributions FOR EACH ROW EXECUTE FUNCTION refuse_test_contribution()');
  try {
    const r=await request(`/work-claims/${c.claim_id}:decide`,reviewer,{decision:'accept',feedback:'符合條件',submission_sha256:c.latest_submission.sha256},c.aggregate_version);
    assert.equal(r.status,500);assert.equal(JSON.stringify(r.data).includes('synthetic storage'),false);
    assert.equal((await pool.query('SELECT count(*) FROM work_decisions')).rows[0].count,'0');
    assert.equal((await pool.query('SELECT state FROM work_claims WHERE claim_id=$1',[c.claim_id])).rows[0].state,'in_review');
    assert.equal((await work(maker)).state,'claiming_closed');
  } finally {await pool.query('DROP TRIGGER refuse_test ON contributions');await pool.query('DROP FUNCTION refuse_test_contribution()');}
});
test('cross-community users cannot enumerate or mutate another community work',async()=>{
  const community=randomUUID(),user=randomUUID(),profession=randomUUID();
  await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'Other']);
  await pool.query('INSERT INTO users VALUES($1,$2,$3,$4,$5,$6,true)',[user,community,'other@local.test','Other',hashPassword(DEMO_PASSWORD),profession]);
  const other=await signIn('other@local.test'),maker=await signIn(),w=await work(maker);
  assert.deepEqual((await request('/work-items',other)).data.items,[]);
  assert.deepEqual((await request('/work-items/page',other)).data,{items:[],next_cursor:null});
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,other,claimBody(other,w),w.aggregate_version)).status,404);
});
test('simple showcase generates its record, keeps legacy refs and validates optional public links',async()=>{
  const maker=await signIn(),key=randomUUID();
  const body={title:'我的作品',description:'一個可用的範例',public_url:'https://example.com/work',consent_to_share:true};
  const shared=await request('/showcases',maker,body,undefined,key);
  assert.equal(shared.status,201,JSON.stringify(shared.data));
  assert.match(shared.data.artifact_ref,/^artifact:[0-9a-f-]{36}$/);
  assert.equal(shared.data.public_url,body.public_url);
  assert.deepEqual((await request('/showcases',maker,body,undefined,key)).data,shared.data);
  assert.equal((await request('/showcases',maker)).data.items.length,1);
  for(const public_url of ['javascript:alert(1)','http://example.com','https://user:secret@example.com','https://127.0.0.1/x','https://192.168.1.10/x']){
    assert.equal((await request('/showcases',maker,{...body,public_url})).status,422,public_url);
  }
  assert.equal((await request('/showcases',maker,{...body,consent_to_share:false})).status,422);
  assert.equal((await request('/showcases',undefined,body)).status,401);
  const legacy=await request('/showcases',maker,{title:'舊作品',description:'保留既有紀錄',artifact_ref:'artifact:legacy-v1',consent_to_share:true});
  assert.equal(legacy.data.artifact_ref,'artifact:legacy-v1');assert.equal(legacy.data.public_url,null);
});

const businessOpportunity=z.object({opportunity_id:z.uuid(),provider_ref:z.uuid(),client_ref:z.uuid(),need:z.string(),aggregate_version:z.number().int()});
const businessReceipt=z.object({receipt_id:z.uuid(),amount_minor:z.string(),currency:z.string(),evidence_ref:z.string(),received_at:z.string(),verification_status:z.string()});
const businessEngagement=z.object({engagement_id:z.uuid(),opportunity_id:z.uuid(),provider_ref:z.uuid(),client_ref:z.uuid(),scope:z.string(),acceptance_criteria:z.string(),
  amount_minor:z.string(),currency:z.string(),terms_sha256:z.string(),aggregate_version:z.number().int(),state:z.string(),delivery_ref:z.string().nullable(),receipt:businessReceipt.nullable()});
async function privateBusinessFixture(provider:Session,client:Session,label:string) {
  const shared=await request('/showcases',provider,{title:`business-${label}`,description:'合成公開作品',artifact_ref:`artifact:public-${label}`,consent_to_share:true});
  assert.equal(shared.status,201);const showcase=z.object({showcase_id:z.uuid()}).parse(shared.data);
  const proposed=await request('/opportunities',client,{showcase_id:showcase.showcase_id,need:`private-need-${label}`});
  assert.equal(proposed.status,201);const opportunity=businessOpportunity.parse(proposed.data);
  const quoted=await request(`/opportunities/${opportunity.opportunity_id}/engagements`,provider,{scope:`private-scope-${label}`,acceptance_criteria:`private-criteria-${label}`,amount_minor:123400,currency:'TWD'},String(opportunity.aggregate_version));
  assert.equal(quoted.status,201);let engagement=businessEngagement.parse(quoted.data);
  for(const [session,action,body] of [[client,'agree',{terms_sha256:engagement.terms_sha256}],[provider,'deliver',{artifact_ref:`artifact:private-delivery-${label}`}],[client,'accept',{terms_sha256:engagement.terms_sha256}]] as const) {
    const result=await request(`/engagements/${engagement.engagement_id}:${action}`,session,body,String(engagement.aggregate_version));assert.equal(result.status,200);engagement=businessEngagement.parse(result.data);
  }
  const receivedAt=z.object({received_at:z.string()}).parse((await pool.query('SELECT clock_timestamp()::text AS received_at')).rows[0]).received_at;
  const wait=Math.max(0,Date.parse(receivedAt)-Date.now());assert.ok(wait<5000);if(wait)await delay(wait+5);
  const reported=await request(`/engagements/${engagement.engagement_id}/receipts`,provider,{amount_minor:123400,currency:'TWD',evidence_ref:`receipt:synthetic-private-${label}`,received_at:new Date(Date.parse(receivedAt)).toISOString()},String(engagement.aggregate_version));
  assert.equal(reported.status,201);engagement=businessEngagement.parse(reported.data);
  const confirmed=await request(`/engagements/${engagement.engagement_id}:confirm-receipt`,client,{},String(engagement.aggregate_version));
  assert.equal(confirmed.status,200);engagement=businessEngagement.parse(confirmed.data);assert.equal(engagement.receipt?.verification_status,'counterparty_confirmed');
  return {opportunity,engagement};
}
async function waitForBusinessRead(pid:number,sql:string,finished:()=>boolean) {
  const deadline=Date.now()+5000;
  while(Date.now()<deadline) {
    const rows=z.array(z.object({query:z.string()})).parse((await pool.query('SELECT query FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows);
    if(rows.some(row=>row.query.includes(sql)))return;
    assert.equal(finished(),false,'read finished before its expected domain SQL wait');await delay(10);
  }
  throw new Error(`expected business read lock wait not observed: ${sql}`);
}
async function businessSessionAlive(hash:string) {
  return z.object({alive:z.boolean()}).parse((await pool.query('SELECT revoked_at IS NULL AND expires_at>clock_timestamp() AS alive FROM sessions WHERE token_hash=$1',[hash])).rows[0]).alive;
}
for(const target of [{path:'/opportunities',table:'opportunities',role:'provider'},{path:'/engagements',table:'receipt_observations',role:'client'}] as const) {
  test(`${target.path} private bilateral projection rejects session expiry after its domain wait`,async()=>{
    const provider=await signIn(),client=await signIn(DEMO_USERS[2].email),foreignProvider=await signIn(DEMO_USERS[1].email);
    const own=await privateBusinessFixture(provider,client,'own'),foreign=await privateBusinessFixture(foreignProvider,client,'foreign');
    const page=target.path==='/opportunities'?z.object({items:z.array(businessOpportunity)}):z.object({items:z.array(businessEngagement)});
    const providerResult=await request(target.path,provider),foreignResult=await request(target.path,foreignProvider);assert.equal(providerResult.status,200);assert.equal(foreignResult.status,200);
    const providerRaw=JSON.stringify(providerResult.data),foreignRaw=JSON.stringify(foreignResult.data);
    assert.ok(providerRaw.includes(target.path==='/opportunities'?own.opportunity.opportunity_id:own.engagement.engagement_id));
    assert.ok(foreignRaw.includes(target.path==='/opportunities'?foreign.opportunity.opportunity_id:foreign.engagement.engagement_id));
    for(const value of [foreign.opportunity.opportunity_id,foreign.opportunity.need,foreign.engagement.engagement_id,foreign.engagement.scope,foreign.engagement.receipt?.evidence_ref]) {assert.ok(value);assert.equal(providerRaw.includes(value),false);}
    for(const value of [own.opportunity.opportunity_id,own.opportunity.need,own.engagement.engagement_id,own.engagement.scope,own.engagement.receipt?.evidence_ref]) {assert.ok(value);assert.equal(foreignRaw.includes(value),false);}
    const expected=page.parse((await request(target.path,target.role==='provider'?provider:client)).data);
    for(const expires of [true,false]) {
      const reader=await signIn(target.role==='provider'?DEMO_USERS[0].email:DEMO_USERS[2].email),token=readSessionCookie(reader.cookie,origin);assert.ok(token);const hash=tokenHash(token);
      assert.equal((await pool.query('UPDATE sessions SET expires_at=clock_timestamp()+make_interval(secs=>$2) WHERE token_hash=$1',[hash,expires?2:60])).rowCount,1);
      const locker=await pool.connect();let pending:Promise<{status:number;data:unknown;response:Response}>|undefined;
      try {
        await locker.query('BEGIN');await locker.query(`LOCK TABLE ${target.table} IN ACCESS EXCLUSIVE MODE`);
        const {pid}=z.object({pid:z.number().int()}).parse((await locker.query('SELECT pg_backend_pid() AS pid')).rows[0]);
        let finished=false;pending=request(target.path,reader);void pending.then(()=>{finished=true},()=>{finished=true});
        await waitForBusinessRead(pid,target.path==='/opportunities'?'FROM opportunities o':'FROM engagements e',()=>finished);
        if(expires) {
          const deadline=Date.now()+4000;
          while(await businessSessionAlive(hash)) {assert.ok(Date.now()<deadline,'session did not expire on the database clock');await delay(10);}
        }else await delay(2100);
        assert.equal(await businessSessionAlive(hash),!expires);await locker.query('COMMIT');const result=await pending;
        assert.equal(result.status,expires?401:200);
        if(expires) {
          assert.equal(z.object({code:z.string()}).parse(result.data).code,'session_expired');const raw=JSON.stringify(result.data);
          for(const value of [own.opportunity.opportunity_id,own.opportunity.need,own.engagement.engagement_id,own.engagement.scope,own.engagement.acceptance_criteria,own.engagement.delivery_ref,own.engagement.receipt?.evidence_ref]) {assert.ok(value);assert.equal(raw.includes(value),false);}
        }else assert.deepEqual(page.parse(result.data),expected);
      }finally {await locker.query('ROLLBACK');locker.release();if(pending)await pending.catch(()=>{});}
    }
  });
}

test('showcase → opportunity → bilateral cooperation → delivery → receipt observation is private and never moves money',async()=>{
  const maker=await signIn(),client=await signIn(DEMO_USERS[2].email),outsider=await signIn(DEMO_USERS[1].email);
  const shared=await request('/showcases',maker,{title:'可重用報表模板',description:'從合成資料產生週報',artifact_ref:'artifact:report-v1',consent_to_share:true});assert.equal(shared.status,201);
  assert.equal((await request('/showcases',client)).data.items.length,1);
  const opp=await request('/opportunities',client,{showcase_id:shared.data.showcase_id,need:'協助調整週報欄位'});assert.equal(opp.status,201);
  const quote=await request(`/opportunities/${opp.data.opportunity_id}/engagements`,maker,{scope:'調整三個欄位',acceptance_criteria:'合成範例產出正確週報',amount_minor:120000,currency:'TWD'},opp.data.aggregate_version);assert.equal(quote.status,201,JSON.stringify(quote.data));let e=quote.data;
  assert.deepEqual((await request('/engagements',outsider)).data.items,[]);
  assert.equal((await request(`/engagements/${e.engagement_id}:agree`,maker,{terms_sha256:e.terms_sha256},e.aggregate_version)).status,404);
  assert.equal((await request(`/engagements/${e.engagement_id}:agree`,client,{terms_sha256:'b'.repeat(64)},e.aggregate_version)).status,409);
  for(const [s,action,body] of [[client,'agree',{terms_sha256:e.terms_sha256}],[maker,'deliver',{artifact_ref:'artifact:delivery-v1'}],[client,'accept',{terms_sha256:e.terms_sha256}]] as const) {
    const r=await request(`/engagements/${e.engagement_id}:${action}`,s,body,e.aggregate_version);assert.equal(r.status,200,JSON.stringify(r.data));e=r.data;
  }
  // Agreement uses the DB clock; the future-time guard uses the Node clock.
  // Let the host catch up to this real DB timestamp instead of inventing a receipt time.
  const receivedAt=(await pool.query('SELECT now()')).rows[0].now.toISOString(),clockWait=Math.max(0,Date.parse(receivedAt)-Date.now());
  assert.ok(clockWait<5000,'Host and PostgreSQL test clocks differ by five seconds or more.');
  if(clockWait)await new Promise(resolve=>setTimeout(resolve,clockWait+5));
  const receipt={amount_minor:120000,currency:'TWD',evidence_ref:'receipt:bank-demo-001',received_at:receivedAt};
  assert.equal((await request(`/engagements/${e.engagement_id}/receipts`,maker,{...receipt,amount_minor:1200},e.aggregate_version)).status,422);
  assert.equal((await request(`/engagements/${e.engagement_id}/receipts`,maker,{...receipt,received_at:new Date(Date.now()+86400000).toISOString()},e.aggregate_version)).data.code,'invalid_receipt_time');
  assert.equal((await request(`/engagements/${e.engagement_id}/receipts`,maker,{...receipt,received_at:'2020-01-01T00:00:00.000Z'},e.aggregate_version)).data.code,'invalid_receipt_time');
  assert.equal((await request(`/engagements/${e.engagement_id}/receipts`,client,receipt,e.aggregate_version)).status,404);
  const key=randomUUID(),old=e.aggregate_version;
  const reported=await request(`/engagements/${e.engagement_id}/receipts`,maker,receipt,old,key);assert.equal(reported.status,201,JSON.stringify(reported.data));e=reported.data;
  assert.equal(e.receipt.verification_status,'self_reported');
  assert.deepEqual((await request(`/engagements/${e.engagement_id}/receipts`,maker,receipt,old,key)).data,e);
  const confirmed=await request(`/engagements/${e.engagement_id}:confirm-receipt`,client,{},e.aggregate_version);assert.equal(confirmed.status,200);assert.equal(confirmed.data.receipt.verification_status,'counterparty_confirmed');
  assert.equal((await pool.query('SELECT count(*) FROM receipt_observations')).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM contributions')).rows[0].count,'0');
  assert.equal((await request('/health')).data.money_movement_enabled,false);
});
test('invalid input, fabricated user identity and missing consent are rejected',async()=>{
  const maker=await signIn();
  assert.equal((await request('/showcases',maker,{title:'作品',description:'測試',artifact_ref:'https://private.example/secret',consent_to_share:true})).status,422);
  assert.equal((await request('/showcases',maker,{title:'作品',description:'測試',artifact_ref:'artifact:ok',consent_to_share:false})).status,422);
  const w=await work(maker);
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,maker,{...claimBody(maker,w),claimant_ref:DEMO_USERS[2].user_id},w.aggregate_version)).status,422);
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,maker,claimBody(maker,w))).status,400);
});
test('implemented claim request and response validate against existing canonical OpenAPI',async()=>{
  const maker=await signIn(),w=await work(maker),body=claimBody(maker,w);
  const response=await request(`/work-items/${DEMO_WORK}:claim`,maker,body,w.aggregate_version);
  assert.equal(response.status,201);assert.equal(typeof response.data.aggregate_version,'number');
  const script=`import json,sys,yaml\nfrom jsonschema import Draft202012Validator\napi=yaml.safe_load(open('docs/platform-plan/contracts/openapi-outline.yaml'))\ndata=json.load(sys.stdin)\nfor name,obj in [('ClaimWorkItemRequest',data['request']),('WorkClaim',data['response'])]:\n validator=Draft202012Validator(api)\n validator.evolve(schema={'$ref':'#/components/schemas/'+name}).validate(obj)\nprint('canonical claim request/response valid')\n`;
  assert.match(execFileSync(pythonCommand,['-X','utf8','-c',script],{input:JSON.stringify({request:body,response:response.data}),encoding:'utf8'}),/valid/);
});
test('generated participation terms conform to the existing schema, including maximum text lengths',async()=>{
  const owner=await signIn(DEMO_USERS[1].email),w=await newWork(owner,{objective:'a'.repeat(1000),acceptance_criteria:'b'.repeat(1000)});
  const script=`import json,sys\nfrom jsonschema import Draft202012Validator,FormatChecker\nschema=json.load(open('docs/platform-plan/contracts/work-participation.schema.json'))\nDraft202012Validator(schema,format_checker=FormatChecker()).validate(json.load(sys.stdin))\nprint('valid')\n`;
  assert.match(execFileSync(pythonCommand,['-X','utf8','-c',script],{input:JSON.stringify(w.participation_terms),encoding:'utf8'}),/valid/);
  const r=await request('/work-items',owner,{title:'長度邊界',objective:'a'.repeat(1001),acceptance_criteria:'有效條件',gain:'公共成果',estimated_minutes:10,maximum_minutes:20,claim_by:new Date(Date.now()+86400000).toISOString(),finish_by:new Date(Date.now()+2*86400000).toISOString(),will_review:false});
  assert.equal(r.status,422);
});
test('new work has no fabricated reuse license while existing Work and Claim terms retain their historical bytes and hashes',async()=>{
  const owner=await signIn(DEMO_USERS[1].email),maker=await signIn(),old=await work(owner);
  // Simulate a persisted pre-upgrade row without rewriting it through an API.
  const legacy={...old.participation_terms,reuse:{...old.participation_terms.reuse,artifact_license_ref:'local-demo-author-consent'}},legacyHash=digest(legacy);
  await pool.query('UPDATE work_items SET participation_terms=$1,participation_terms_sha256=$2 WHERE work_item_id=$3',[JSON.stringify(legacy),legacyHash,DEMO_WORK]);
  const existingClaim=await claim(maker),fresh=await newWork(owner);
  assert.deepEqual(fresh.participation_terms.reuse,{visibility:'community',artifact_license_ref:null,consent_required:true});
  await seedLocal(pool); // Repeat bootstrap must not replace already persisted terms.
  const persisted=await work(maker),claimRow=(await pool.query('SELECT terms_snapshot,terms_sha256 FROM work_claims WHERE claim_id=$1',[existingClaim.claim_id])).rows[0];
  assert.deepEqual(persisted.participation_terms,legacy);assert.equal(persisted.participation_terms_sha256,legacyHash);
  assert.deepEqual(claimRow.terms_snapshot,legacy);assert.equal(claimRow.terms_sha256,legacyHash);
});
test('logout revokes an existing session and unsuccessful login does not issue a cookie',async()=>{
  const bad=await request('/auth/login',undefined,{email:DEMO_USERS[0].email,password:'wrong'});assert.equal(bad.status,401);assert.equal(bad.response.headers.get('set-cookie'),null);
  const s=await signIn();assert.match(s.cookie,/freedom_local_session=/);
  await request('/auth/logout',s,{});assert.equal((await request('/session',s)).status,401);
});
