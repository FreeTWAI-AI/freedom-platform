import {chromium,errors} from '@playwright/test';
// @ts-expect-error Canonical tooling is JavaScript without a declaration file.
import {createIngestBrowserDiagnostic} from '../../packages/contribution-tools/test-failure-diagnostic.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {ingestFixture,httpsFetch,observeIngestBrowserPage} from './credential-ingest-helpers.js';
import {profile} from './credential-ingest-fixtures/shared.js';
import {createPrivateWorkCommands} from '../../modules/opportunity-project-work/private-commands.js';
import {resolvePrivateWorkPersistencePolicy} from '../../modules/autopilot-work/policy.js';
import {createExecutionRuns} from '../../modules/agent-execution/runs.js';
import {createExecutionPrerequisites} from '../../modules/agent-execution/prerequisites.js';

test('INGEST-RATE genuine owner polling shares the unchanged execution quota and denies dispatch at its boundary',{timeout:90000},async()=>{
 const f=await ingestFixture();try{
  const human=await f.configured();
  const work=await createPrivateWorkCommands(f.app,{resolvePolicy:resolvePrivateWorkPersistencePolicy}).create(human.actor,{key:randomUUID(),title:'Synthetic quota boundary',objective:'Synthetic private draft'});
  const run=await createExecutionRuns(f.app).create(human.actor,{key:randomUUID(),workId:work.workId,expectedWorkVersion:'1'});
  const grant=await createExecutionPrerequisites(f.app,{environment:profile.environment,clientId:profile.clientId}).grants.create(human.actor,{key:randomUUID(),runId:run.runId,expectedRunVersion:'1',expectedWorkVersion:'1',connectionId:human.initial.connectionId,expectedConnectionVersion:'1',modelConnectionId:human.model.modelConnectionId,expectedModelVersion:'1',consent:true});
  await f.owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens)
   VALUES($1,$2,$3,'local',$4,$5,1,true,16384,20)`,[randomUUID(),human.context.scope.scope_id,human.context.subject_principal.principal_id,profile.clientId,JSON.stringify(human.model.selection)]);
  const issued=await f.issue(human,human.model.modelConnectionId);assert.equal(issued.status,201);const bootstrap=await issued.json() as any;
  const setup=await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:{Origin:f.mainOrigin,'Content-Type':'application/x-www-form-urlencoded','Sec-Fetch-Mode':'navigate','Sec-Fetch-Site':'cross-site','Sec-Fetch-Dest':'document'},body:'assertion='+bootstrap.assertion});
  assert.equal(setup.status,200);const csrf=/data-csrf="([A-Za-z0-9_-]{43})"/.exec(await setup.text())?.[1];assert(csrf);
  const headers={Origin:f.setupOrigin,Cookie:setup.headers.get('Set-Cookie')!.split(';')[0],'X-FP-Broker-CSRF':csrf,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'same-origin','Sec-Fetch-Dest':'empty'};
  assert.equal((await httpsFetch(f.setupOrigin+'/credential-setup/prepare',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{"consent":true}'})).status,200);
  assert.equal((await httpsFetch(f.setupOrigin+'/credential-setup/secret',{method:'POST',headers:{...headers,'Content-Type':'application/octet-stream','Content-Length':String(Buffer.byteLength(f.secret))},body:f.secret})).status,200);
  // No seeded counters: each observation genuinely charges the same SQL-backed
  // network bucket used by approval, activation and execution.
  for(let i=0;i<57;i++){
   const response=await httpsFetch(f.mainOrigin+'/api/v1/me/credential-ingests/'+bootstrap.authorizationRef,{headers:{Cookie:human.headers.Cookie,Origin:f.mainOrigin}});
   assert.equal(response.status,200);assert.equal((await response.json() as any).state,'committed');
  }
  const approval=await f.post(human,'/api/v1/me/model-step-approvals',{runId:run.runId,grantId:grant.grantId,expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20});assert.equal(approval.status,201);
  const activated=await f.post(human,'/api/v1/me/model-steps',{approvalId:(await approval.json() as any).approvalId,expectedRunVersion:'1'});assert.equal(activated.status,201);const step=await activated.json() as any;
  const response=await f.post(human,`/api/v1/me/model-steps/${step.stepId}:execute`,{});
  assert.equal(response.status,429);assert.equal((await response.json() as any).code,'member_model_http_rate_limited');assert.equal(response.headers.get('Retry-After'),'60');
  assert.equal(f.posts.length,0);assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,0);
 }finally{await f.cleanup();}
});

test('INGEST-RATE browser fixture waits for an actual delayed custody commit before its single owner observation',{timeout:90000},async()=>{
 const f=await ingestFixture(),holder=await f.owner.connect();let pending:ReturnType<typeof f.approved>|undefined;
 try{
  const lock=BigInt('0x'+randomBytes(6).toString('hex')).toString();
  await f.owner.query(`CREATE FUNCTION fixture_rate_commit_wait() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
   IF NEW.operation='broker.credential.create' THEN PERFORM pg_advisory_xact_lock(${lock}); END IF; RETURN NEW; END $$;
   CREATE TRIGGER fixture_rate_commit_wait BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION fixture_rate_commit_wait()`);
  await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock($1)',[lock]);
  const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;
  pending=f.approved();const completed=pending.then(()=>{throw Error('Actual custody commit must reach the SQL barrier');});
  const blocked=(async()=>{for(let i=0;i<1000;i++){
   if((await f.admin.query('SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) blocked',[pid])).rows[0].blocked)return;
   await delay(20);
  }throw Error('Actual custody SQL barrier was not reached');})();
  await Promise.race([blocked,completed]);
  await delay(250);
  const observations=(snapshot:any)=>snapshot.received.filter((r:any)=>r.method==='GET'&&r.path.startsWith('/api/v1/me/credential-ingests/'));
  assert.equal(observations(await f.main.request('snapshot')).length,0,'Pending custody must not consume the owner execution quota');
  await holder.query('COMMIT');const approved=await pending;
  assert.equal(observations(await f.main.request('snapshot')).length,1);assert(approved.credential.credentialId);assert.equal(f.posts.length,0);
 }finally{await holder.query('ROLLBACK');holder.release();if(pending)await pending.catch(()=>{});await f.cleanup();}
});

test('controlled Chromium secret abort records request failure and preserves actual ACK TimeoutError without secret data',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const context=await browser.newContext(),page=await context.newPage(),origin='https://synthetic-broker.invalid';
  const diagnostic=createIngestBrowserDiagnostic(),detach=observeIngestBrowserPage(page,origin,diagnostic);
  await context.route('**/*',async route=>{
   if(route.request().url()===origin+'/credential-setup/prepare')await route.fulfill({status:200,headers:{'Access-Control-Allow-Origin':'*'},body:'{}'});
   else await route.abort('timedout');
  });
  await page.setContent('<div id="credential-status"></div>');
  await page.evaluate(async origin=>{await fetch(origin+'/credential-setup/prepare',{method:'POST'});try{await fetch(origin+'/credential-setup/secret',{method:'POST',body:'PRIVATE_SYNTHETIC_KEY'});}catch{}},origin);
  diagnostic.phase('ack_wait');let caught:unknown;
  try{await page.locator('#credential-status').filter({hasText:'已收到設定服務回覆'}).waitFor({timeout:100});}catch(error){caught=error;assert.equal(diagnostic.annotate(error),error);}
  assert(caught instanceof errors.TimeoutError);const value=(caught as Error&{freedom_ingest:unknown}).freedom_ingest;
  assert.deepEqual(value,{phase:'ack_wait',prepare_state:'response',prepare_status:200,secret_state:'failed',secret_status:null,custody:'not_checked'});
  assert(!JSON.stringify(value).includes('PRIVATE'));assert(!JSON.stringify(value).includes(origin));detach();await context.close();
 }finally{await browser.close();}
});

