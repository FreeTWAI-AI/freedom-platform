import { test,before,after,beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { createPool,LOCAL_DATABASE_URL,digest } from '../../packages/db/index.js';
import { migrate } from '../../scripts/database.js';
import { seedLocal,DEMO_WORK,DEMO_USERS,DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { hashPassword } from '../../modules/identity-membership/service.js';
import { execFileSync } from 'node:child_process';

const origin='http://127.0.0.1:4310';
const databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_runtime_test_${process.pid}_${Date.now()}`;
const admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin);
interface Session {cookie:string;csrf:string;user:any}
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
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
  assert.equal(dashboard.gained[0].artifact_ref,'artifact:example-v2');assert.equal(dashboard.now.length,0);
  assert.equal((await pool.query('SELECT count(*) FROM contributions')).rows[0].count,'1');
  assert.equal((await pool.query('SELECT count(*) FROM work_decisions')).rows[0].count,'2');
  assert.equal((await pool.query("SELECT count(*) FROM outbox WHERE event_type='freedom.work.submission.accepted.v1'")).rows[0].count,'1');
});
test('concurrent exclusive claims have one winner and preserve atomic facts',async()=>{
  const a=await signIn(),b=await signIn(DEMO_USERS[2].email),w=await work(a);
  const outcomes=await Promise.all([a,b].map(s=>request(`/work-items/${w.work_item_id}:claim`,s,claimBody(s,w),w.aggregate_version)));
  assert.deepEqual(outcomes.map(r=>r.status).sort(),[201,412]);
  assert.equal((await pool.query('SELECT count(*) FROM work_claims')).rows[0].count,'1');
  assert.equal((await work(a)).state,'claiming_closed');
});
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
  assert.equal((await request(`/work-items/${DEMO_WORK}:claim`,other,claimBody(other,w),w.aggregate_version)).status,404);
});
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
  const receipt={amount_minor:120000,currency:'TWD',evidence_ref:'receipt:bank-demo-001',received_at:new Date().toISOString()};
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
  assert.match(execFileSync('python3',['-c',script],{input:JSON.stringify({request:body,response:response.data}),encoding:'utf8'}),/valid/);
});
test('generated participation terms conform to the existing schema, including maximum text lengths',async()=>{
  const owner=await signIn(DEMO_USERS[1].email),w=await newWork(owner,{objective:'a'.repeat(1000),acceptance_criteria:'b'.repeat(1000)});
  const script=`import json,sys\nfrom jsonschema import Draft202012Validator,FormatChecker\nschema=json.load(open('docs/platform-plan/contracts/work-participation.schema.json'))\nDraft202012Validator(schema,format_checker=FormatChecker()).validate(json.load(sys.stdin))\nprint('valid')\n`;
  assert.match(execFileSync('python3',['-c',script],{input:JSON.stringify(w.participation_terms),encoding:'utf8'}),/valid/);
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
