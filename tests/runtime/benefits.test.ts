import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {Pool} from 'pg';
import {createPool,LOCAL_DATABASE_URL} from '../../packages/db/index.js';
import {migrate} from '../../scripts/database.js';
import {seedLocal,DEMO_WORK,DEMO_USERS,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {createApp} from '../../apps/platform-api/src/app.js';

const origin='http://127.0.0.1:4310',databaseUrl=process.env.TEST_DATABASE_URL??LOCAL_DATABASE_URL;
const schema=`fp_benefits_test_${process.pid}_${Date.now()}`,admin=createPool(databaseUrl);
const pool=new Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`,max:12});
const app=createApp(pool,origin),path=`/work-items/${DEMO_WORK}/benefit-observations`;
type Session={cookie:string;csrf:string;user:any};
before(async()=>{await admin.query(`CREATE SCHEMA ${schema}`);await migrate(pool);});
after(async()=>{await pool.end();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();});
beforeEach(async()=>{await pool.query('TRUNCATE communities,login_attempts CASCADE');await seedLocal(pool);});
async function request(path:string,session?:Session,body?:unknown,version?:string|number,key:string=randomUUID(),extra:Record<string,string>={}){
 const headers:Record<string,string>={Origin:origin,...(session?{Cookie:session.cookie,'X-CSRF-Token':session.csrf}:{})};
 if(body!==undefined){headers['Content-Type']='application/json';headers['Idempotency-Key']=key;if(version)headers['If-Match']=`"${version}"`;}
 Object.assign(headers,extra);
 const response=await app.request(origin+'/api/v1'+path,{method:body===undefined?'GET':'POST',headers,body:body===undefined?undefined:JSON.stringify(body)});
 return {status:response.status,data:await response.json() as any,response};
}
async function signIn(index=0):Promise<Session>{const result=await request('/auth/login',undefined,{email:DEMO_USERS[index].email,password:DEMO_PASSWORD});assert.equal(result.status,200);return {cookie:result.response.headers.get('set-cookie')!.split(';')[0],csrf:result.data.csrf_token,user:result.data.user};}
async function work(session:Session){return (await request('/work-items',session)).data.items.find((w:any)=>w.work_item_id===DEMO_WORK);}
async function participate(maker:Session){
 const w=await work(maker),r=await request(`/work-items/${DEMO_WORK}:claim`,maker,{claimant_type:'user',acting_profession_membership_ref:maker.user.profession_membership_ref,expected_aggregate_version:w.aggregate_version,terms_status:'declared',participation_terms_revision:w.participation_terms_revision,participation_terms_sha256:w.participation_terms_sha256},w.aggregate_version);
 assert.equal(r.status,201,JSON.stringify(r.data));return action(maker,r.data,'start');
}
async function action(member:Session,claim:any,action:string,body:unknown={}){const r=await request(`/work-claims/${claim.claim_id}:${action}`,member,body,claim.aggregate_version);assert.equal(r.status,200,JSON.stringify(r.data));return r.data;}
async function accept(maker:Session,owner:Session,claim:any){let c=await action(maker,claim,'submit',{summary:'可重用說明已完成',artifact_ref:'artifact:benefit-test'});c=await action(owner,c,'begin-review');return action(owner,c,'decide',{decision:'accept',feedback:'符合完成條件',submission_sha256:c.latest_submission.sha256});}
const report=(role:'beneficiary'|'contributor',claim:string|null=null)=>({work_claim_ref:claim,role,outcome:'gained',actual_gain:'私人經驗：節省重複整理時間',evidence_refs:['artifact:private-benefit-ref'],would_participate_again:true,effort_minutes:null,supersedes_observation_ref:null});

test('optional self-reports persist across application restart, conform to canonical schema and never change accepted contribution facts',async()=>{
 const maker=await signIn(),owner=await signIn(1);let claim=await participate(maker);claim=await accept(maker,owner,claim);
 const before=await work(maker),empty=await request(path,maker);assert.equal(empty.status,200,JSON.stringify(empty.data));assert.equal(empty.data.summary.outcomes.not_reported,2);assert.equal(empty.data.summary.both_participants_reported_gained,false);
 const input=report('contributor',claim.claim_id),created=await request(path,maker,input,before.aggregate_version);assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.observation_revision,1);assert.deepEqual(created.data.report.effort_minutes,null);
 const fresh=createApp(pool,origin),persisted=await fresh.request(origin+'/api/v1'+path,{headers:{Cookie:maker.cookie}}),view:any=await persisted.json();assert.equal(view.own_observation.observation_id,created.data.observation_id);assert.equal(view.summary.outcomes.gained,1);assert.equal(view.summary.outcomes.not_reported,1);
 const script=`import json,sys\nfrom jsonschema import Draft202012Validator,FormatChecker\ns=json.load(open('docs/platform-plan/contracts/work-participation.schema.json'))\nv=Draft202012Validator(s,format_checker=FormatChecker())\nd=json.load(sys.stdin)\nfor key,name in [('request','BenefitObservationRequest'),('response','BenefitObservationReceipt')]: v.evolve(schema={'$ref':'#/$defs/'+name}).validate(d[key])\nprint('valid')\n`;
 assert.match(execFileSync('python3',['-c',script],{input:JSON.stringify({request:input,response:created.data}),encoding:'utf8'}),/valid/);
 assert.equal((await work(maker)).aggregate_version,before.aggregate_version);assert.equal((await pool.query('SELECT count(*) FROM contributions')).rows[0].count,'1');assert.equal((await request('/dashboard',maker)).data.summary.accepted_count,1);
 assert.equal((await pool.query('SELECT count(*) FROM receipt_observations')).rows[0].count,'0');assert.equal((await request('/health')).data.money_movement_enabled,false);
});

test('beneficiary and contributor report independently; others see only aggregate outcomes and missing reports stay unknown',async()=>{
 const maker=await signIn(),owner=await signIn(1),claim=await participate(maker),version=(await work(maker)).aggregate_version;
 assert.equal((await request(path,owner,report('beneficiary'),version)).status,201);
 let view=(await request(path,maker)).data;assert.equal(view.own_observation,null);assert.equal(view.summary.outcomes.not_reported,1);assert.equal(JSON.stringify(view).includes('私人經驗'),false);assert.equal(JSON.stringify(view).includes('private-benefit-ref'),false);
 assert.equal((await request(path,maker,report('contributor',claim.claim_id),version)).status,201);
 view=(await request(path,maker)).data;assert.equal(view.summary.both_participants_reported_gained,true);assert.equal(view.summary.independent_people_verified,false);assert.equal(view.summary.income_verified,false);assert.equal(view.summary.evidence_level,'self_reported');
 const privateText=JSON.stringify((await pool.query('SELECT data FROM transition_journal')).rows)+JSON.stringify((await pool.query('SELECT payload FROM outbox')).rows);assert.equal(privateText.includes('私人經驗'),false);assert.equal(privateText.includes('private-benefit-ref'),false);
});

test('reports are append-only, concurrent corrections reject stale lineage and the first receipt replays after the work advances',async()=>{
 const maker=await signIn(),owner=await signIn(1),claim=await participate(maker),version=(await work(maker)).aggregate_version,input=report('contributor',claim.claim_id),key=randomUUID();
 const first=await request(path,maker,input,version,key);assert.equal(first.status,201);
 await accept(maker,owner,claim);assert.deepEqual((await request(path,maker,input,version,key)).data,first.data);
 assert.equal((await request(path,maker,{...input,outcome:'unconfirmed'},version,key)).status,409);
 const nextVersion=(await work(maker)).aggregate_version,change={...input,outcome:'partly_gained',actual_gain:'只完成一部分',supersedes_observation_ref:first.data.observation_id};
 const parallel=await Promise.all([request(path,maker,change,nextVersion),request(path,maker,{...change,actual_gain:'另一份修改'},nextVersion)]);assert.deepEqual(parallel.map(r=>r.status).sort(),[201,409]);
 const rows=(await pool.query('SELECT observation_revision,report FROM work_benefit_observations ORDER BY observation_revision')).rows;assert.equal(rows.length,2);assert.deepEqual(rows[0].report,input);assert.equal(rows[1].observation_revision,2);
 const current=(await request(path,maker)).data;assert.equal(current.summary.outcomes.gained,0);assert.equal(current.summary.outcomes.partly_gained,1);assert.equal(current.summary.reported,1);assert.equal(current.summary.both_participants_reported_gained,false);
});

test('first-person role, claim and community boundaries reject arbitrary reporters, observers and unstarted work',async()=>{
 const maker=await signIn(),owner=await signIn(1),other=await signIn(2),initial=await work(owner);
 assert.equal((await request(path,owner,report('beneficiary'),initial.aggregate_version)).data.code,'participation_not_started');
 const claim=await participate(maker),version=(await work(maker)).aggregate_version;
 assert.equal((await request(path,other)).status,404);assert.equal((await request(path,other,report('beneficiary'),version)).status,404);
 assert.equal((await request(path,maker,report('beneficiary'),version)).status,403);assert.equal((await request(path,owner,report('contributor',claim.claim_id),version)).status,403);
 assert.equal((await request(path,maker,report('contributor',randomUUID()),version)).status,403);
 assert.equal((await request(path,owner,report('beneficiary',claim.claim_id),version)).status,403);
 assert.equal((await request(path,maker,{...report('contributor',claim.claim_id),reporter_principal_ref:owner.user.user_id},version)).status,422);
 const community=randomUUID();await pool.query('INSERT INTO communities VALUES($1,$2)',[community,'不同社群']);await pool.query('UPDATE users SET community_id=$1 WHERE user_id=$2',[community,other.user.user_id]);
 assert.equal((await request(path,await signIn(2))).status,404);assert.equal((await pool.query('SELECT count(*) FROM work_benefit_observations')).rows[0].count,'0');
});

test('unknown and no-gain are valid, effort stays nullable, and identity, version, CSRF and evidence checks are enforced',async()=>{
 const maker=await signIn(),claim=await participate(maker),version=(await work(maker)).aggregate_version;
 const input={...report('contributor',claim.claim_id),outcome:'unconfirmed',actual_gain:null,evidence_refs:[],would_participate_again:null,effort_minutes:{platform_maintenance:null,coordination_friction:null,collaborative_value:0,paid_delivery:null}};
 assert.equal((await request(path,maker,input)).status,428);assert.equal((await request(path,maker,input,version+1)).status,412);
 assert.equal((await request(path,maker,input,version,randomUUID(),{'X-CSRF-Token':''})).status,403);
 assert.equal((await request(path,undefined,input,version,randomUUID(),{Authorization:'Bearer fw_read_not_a_browser_session'})).status,401);
 assert.equal((await request(path,maker,{...input,outcome:'gained'},version)).status,422);assert.equal((await request(path,maker,{...input,evidence_refs:['https://private.example.test/secret']},version)).status,422);
 assert.equal((await request(path,maker,{...input,effort_minutes:{...input.effort_minutes,paid_delivery:-1}},version)).status,422);
 const saved=await request(path,maker,input,version);assert.equal(saved.status,201,JSON.stringify(saved.data));assert.deepEqual(saved.data.report.effort_minutes,input.effort_minutes);assert.equal(saved.data.report.would_participate_again,null);
 const correction=await request(path,maker,{...input,outcome:'not_gained',supersedes_observation_ref:saved.data.observation_id},version);assert.equal(correction.status,201);assert.equal((await request(path,maker)).data.summary.outcomes.not_gained,1);
 await pool.query('UPDATE users SET onboarding_required=true,onboarding_completed_at=NULL WHERE user_id=$1',[maker.user.user_id]);assert.equal((await request(path,maker)).status,403);
});
