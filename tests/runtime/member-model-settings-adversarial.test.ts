import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {MemberModelSettingsOverviewSchema} from '../../contracts/execution/v2/member-model-settings.js';
import {createMemberModelSettings} from '../../modules/agent-execution/member-model-settings.js';
import {settingsFixture} from './member-model-settings-helpers.js';
import {profile} from './member-model-settings-fixtures/shared.js';

test('MODEL-SETTINGS-ADV actual parent history is owner/env/client bound and app role never reads ciphertext',{timeout:60000},async()=>{
 const f=await settingsFixture();try{const member=await f.configured();
  const response=await f.get(member,'/api/v1/me/model-settings');assert.equal(response.status,200,await response.clone().text());assert.equal(response.headers.get('Referrer-Policy'),'no-referrer');const metadata=MemberModelSettingsOverviewSchema.parse(await response.json());
  assert.equal(metadata.setup.state,'installed');if(metadata.setup.state==='installed')assert.equal(metadata.setup.setupOrigin,f.setupOrigin);assert.equal(metadata.models.length,1);assert.equal(metadata.models[0].modelConnectionId,member.model.modelConnectionId);assert.equal(metadata.connections[0].connectionId,member.initial.connectionId);assert.equal(metadata.operational_authority,false);
  const foreign=await f.member(),foreignResponse=await f.get(foreign,'/api/v1/me/model-settings');assert.equal(foreignResponse.status,200);assert.equal((await foreignResponse.json() as any).models.length,0);
  for(const changed of [{environment:'local' as const,clientId:profile.clientId},{environment:profile.environment,clientId:'foreign-settings-client'}]){const service=createMemberModelSettings(f.app,{...changed,selections:metadata.selectionOptions});assert.equal((await service.readOverview(member.actor)).models.length,0);}
  f.recovery.unavailable=true;await f.owner.query('UPDATE private_work_persistence_policy SET persistence_allowed=false, revision=revision+1');const offline=await f.get(member,'/api/v1/me/model-settings');assert.equal(offline.status,200);assert.equal((await offline.json() as any).models[0].modelConnectionId,member.model.modelConnectionId);assert.equal(f.posts.length,0);
  for(const sql of ['SELECT envelope FROM broker_credential_vault',`SET ROLE ${f.roles.broker}`])await assert.rejects(f.app.query(sql),(e:any)=>e.code==='42501');
  const text=JSON.stringify(metadata);for(const forbidden of ['"binding"','"envelope"','"session_hash"','"csrf_token"',f.secret,Buffer.from(f.secret).toString('base64')])assert(!text.includes(forbidden));
 }finally{await f.cleanup();}
});

test('MODEL-SETTINGS-ADV parent rejects methods, machine credentials, read bodies and conditional headers before original application pull',{timeout:60000},async()=>{
 const f=await settingsFixture();try{const member=await f.configured();
  for(const input of [{method:'POST',path:'/api/v1/me/model-settings',headers:member.headers},{method:'GET',path:'/api/v1/me/model-settings?foreign=true',headers:member.headers},{method:'GET',path:'/api/v1/me/model-settings',headers:{...member.headers,Authorization:'Bearer fake'}},{method:'GET',path:'/api/v1/me/model-settings',headers:{...member.headers,'If-None-Match':'"1"'}},{method:'POST',path:'/api/v1/me/model-settings',headers:{...member.headers,'Content-Type':'application/json'},body:'{}'}]){const result=await f.main.request('direct',input);assert(result.status>=400,JSON.stringify(result));assert.equal(result.pulls,0);}
  await f.owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[member.actor.session_hash]);const denied=await f.get(member,'/api/v1/me/model-settings');assert.equal(denied.status,401);
 }finally{await f.cleanup();}
});

test('MODEL-SETTINGS-ADV absent trusted ingest keeps CSP self-only while safe owner history and catalog absence remain explicit',{timeout:60000},async()=>{
 const f=await settingsFixture({installed:false,catalog:false});try{const member=await f.configured(),response=await f.get(member,'/api/v1/me/model-settings');assert.equal(response.status,200);const metadata=MemberModelSettingsOverviewSchema.parse(await response.json());assert.deepEqual(metadata.setup,{state:'unavailable'});assert.equal(metadata.selectionOptions.length,0);assert.equal(metadata.models.length,1);
  const html=await f.get(member,'/');assert.equal(html.status,200);assert.equal(html.headers.get('Referrer-Policy'),'no-referrer');const csp=html.headers.get('Content-Security-Policy')!;assert(csp.includes("form-action 'self'"));assert(!csp.includes(f.setupOrigin));
  const rejected=await f.main.request('direct',{path:'/api/v1/me/credential-ingests',method:'POST',headers:{...member.headers,'Content-Type':'application/json','If-Match':'"1"','Idempotency-Key':randomUUID()},body:'{}'});assert.equal(rejected.status,503);assert.equal(rejected.pulls,0);
 }finally{await f.cleanup();}
});

test('MODEL-SETTINGS-ADV whitespace duplicate original session cookies fail GET and ingest before application pull',{timeout:60000},async()=>{
 const f=await settingsFixture();try{const member=await f.configured(),other=await f.member();
  const cookie=member.headers.Cookie+'; __Host-freedom_session \t='+other.token;
  const settings=await f.main.request('direct',{path:'/api/v1/me/model-settings',method:'GET',headers:{Cookie:cookie}});
  const ingest=await f.main.request('direct',{path:'/api/v1/me/credential-ingests',method:'POST',headers:{...member.headers,Cookie:cookie,'Content-Type':'application/json','If-Match':'"1"','Idempotency-Key':randomUUID()},body:JSON.stringify({operation:'create',modelConnectionId:member.model.modelConnectionId,consent:true})});
  const observed={settings:{status:settings.status,pulls:settings.pulls},ingest:{status:ingest.status,pulls:ingest.pulls}};console.log('WHITESPACE_DUPLICATE_SAFE_RESULT',JSON.stringify(observed));assert(settings.status>=400,JSON.stringify(observed));assert(ingest.status>=400,JSON.stringify(observed));assert.equal(ingest.pulls,0,JSON.stringify(observed));
 }finally{await f.cleanup();}
});

test('MODEL-SETTINGS-ADV parent installation rejects copied and mismatched opaque ports, missing product never pulls settings bodies',{timeout:60000},async()=>{
 const f=await settingsFixture({product:false});try{const member=await f.member();const policy=await f.main.request('policyProbe');assert.deepEqual(policy.denied,[true,true,true,true]);assert.equal(policy.forgedInstall,true);assert.equal(policy.pinned,f.setupOrigin);
  for(const path of ['/api/v1/me/model-settings','/api/v1/me/model-credentials/'+randomUUID(),'/api/v1/me/credential-ingests']){const denied=await f.main.request('direct',{path,method:'POST',headers:{...member.headers,'Content-Type':'application/json','If-Match':'"1"','Idempotency-Key':randomUUID()},body:'{}'});assert.equal(denied.status,503);assert.equal(denied.pulls,0);}
  const html=await f.get(member,'/');assert.equal(html.status,200);assert(!html.headers.get('Content-Security-Policy')!.includes(f.setupOrigin));
 }finally{await f.cleanup();}
});

test('MODEL-SETTINGS-ADV actual original SQL lock delays history beyond only session expiry and releases no metadata',{timeout:60000},async()=>{
 const f=await settingsFixture();let blocker:any;try{const member=await f.configured();
  await f.owner.query("UPDATE sessions SET expires_at=clock_timestamp()+interval '3 seconds' WHERE token_hash=$1",[member.actor.session_hash]);
  blocker=await f.owner.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE broker_model_credentials IN ACCESS EXCLUSIVE MODE');
  const response=f.get(member,'/api/v1/me/model-settings');let blocked=false;
  for(let attempt=0;attempt<100;attempt++){const rows=await f.admin.query("SELECT query FROM pg_stat_activity WHERE usename=$1 AND wait_event_type='Lock'",[f.roles.app]);if(rows.rows.some((row:any)=>row.query.includes('broker_model_credentials'))){blocked=true;break;}await delay(20);}
  assert(blocked,'Original metadata SELECT did not reach real SQL lock');await delay(3200);await blocker.query('COMMIT');blocker.release();blocker=undefined;const denied=await response;assert.equal(denied.status,401);const body=await denied.text();assert(!body.includes(member.model.modelConnectionId));assert(!body.includes('selectionOptions'));
 }finally{if(blocker){await blocker.query('ROLLBACK');blocker.release();}await f.cleanup();}
});

test('MODEL-SETTINGS-ADV actual parent ingest refuses stale CAS and foreign owner, revoked original session refuses before body pull',{timeout:60000},async()=>{
 const f=await settingsFixture();try{const member=await f.configured(),foreign=await f.member();
  const input={operation:'create',modelConnectionId:member.model.modelConnectionId,consent:true};const stale=await f.post(member,'/api/v1/me/credential-ingests',input,{'If-Match':'"9"'});assert.equal(stale.status,403);assert.equal((await stale.json() as any).code,'credential_ingest_authorization_invalid');const wrong=await f.post(foreign,'/api/v1/me/credential-ingests',input);assert(wrong.status>=400);assert.equal((await f.owner.query('SELECT count(*)::int n FROM credential_ingest_authorizations')).rows[0].n,0);
  await f.owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[member.actor.session_hash]);const denied=await f.main.request('direct',{path:'/api/v1/me/credential-ingests',method:'POST',headers:{...member.headers,'Content-Type':'application/json','If-Match':'"1"','Idempotency-Key':randomUUID()},body:JSON.stringify(input)});assert.equal(denied.status,401);assert.equal(denied.pulls,0);
 }finally{await f.cleanup();}
});
