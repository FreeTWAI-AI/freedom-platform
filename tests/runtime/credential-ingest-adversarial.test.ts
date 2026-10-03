import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {CompactSign,base64url} from 'jose';
import {setTimeout as delay} from 'node:timers/promises';
import {createExecutionPrerequisites} from '../../modules/agent-execution/prerequisites.js';
import {profile} from './credential-ingest-fixtures/shared.js';
import {ingestFixture,httpsFetch} from './credential-ingest-helpers.js';

type Fixture=Awaited<ReturnType<typeof ingestFixture>>;
const bytes=(text:string)=>Array.from(new TextEncoder().encode(text));
const claims=(assertion:string)=>JSON.parse(new TextDecoder().decode(base64url.decode(assertion.split('.')[1])));
const formHeaders=(f:Fixture)=>({Origin:f.mainOrigin,'Content-Type':'application/x-www-form-urlencoded','Sec-Fetch-Mode':'navigate','Sec-Fetch-Site':'cross-site','Sec-Fetch-Dest':'document'});
async function setup(f:Fixture,human:Awaited<ReturnType<Fixture['configured']>>,priorBootstrap?:any) {
 const issued=priorBootstrap?null:await f.issue(human,human.model.modelConnectionId);if(issued)assert.equal(issued.status,201,await issued.clone().text());const bootstrap=priorBootstrap??await issued!.json() as any;
 const response=await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:formHeaders(f),body:'assertion='+bootstrap.assertion});
 assert.equal(response.status,200,await response.clone().text());const html=await response.text(),csrf=/data-csrf="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];assert(csrf);
 const cookie=response.headers.get('Set-Cookie')!.split(';')[0];assert.match(cookie,/^__Host-fp_broker_setup=/);assert.match(response.headers.get('Set-Cookie')!,/Secure; HttpOnly; SameSite=Strict/);
 return {bootstrap,cookie,csrf,html,headers:{Origin:f.setupOrigin,Cookie:cookie,'X-FP-Broker-CSRF':csrf,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'same-origin','Sec-Fetch-Dest':'empty'}};
}
async function prepared(f:Fixture,human:Awaited<ReturnType<Fixture['configured']>>,priorBootstrap?:any) {const state=await setup(f,human,priorBootstrap);const response=await httpsFetch(f.setupOrigin+'/credential-setup/prepare',{method:'POST',headers:{...state.headers,'Content-Type':'application/json'},body:'{"consent":true}'});assert.equal(response.status,200,await response.clone().text());return state;}
const secretRequest=(f:Fixture,s:Awaited<ReturnType<typeof setup>>,extra:Record<string,string>={})=>({path:'/credential-setup/secret',authorizationRef:s.bootstrap.authorizationRef,headers:{...s.headers,'Content-Type':'application/octet-stream','Content-Length':String(f.secret.length),...extra},bytes:bytes(f.secret)});
async function counts(f:Fixture){return (await f.owner.query(`SELECT (SELECT count(*)::int FROM broker_model_credentials) credentials,(SELECT count(*)::int FROM broker_credential_vault) cipher,(SELECT count(*)::int FROM scoped_command_receipts WHERE operation='broker.credential.create') receipts`)).rows[0];}
async function sqlBlocked(f:Fixture,holder:any){const pid=(await holder.query('SELECT pg_backend_pid() pid')).rows[0].pid;for(let i=0;i<300;i++){if((await f.admin.query('SELECT count(*)::int n FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows[0].n)return;await delay(10);}assert.fail('Actual SQL wait not observed');}

test('INGEST-ADV genuine bootstrap does not prepare custody, is one-use, and requires current protected capture before key DOM',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),s=await setup(f,human);assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});
  const replay=await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:formHeaders(f),body:'assertion='+s.bootstrap.assertion});assert(replay.status>=400);assert.equal(replay.headers.get('Set-Cookie'),null);assert(!await replay.text().then(t=>t.includes('id="credential-key"')));
  const key=randomUUID(),first=await f.issue(human,human.model.modelConnectionId,{'Idempotency-Key':key}),second=await f.issue(human,human.model.modelConnectionId,{'Idempotency-Key':key});assert.equal(first.status,201);assert.equal(second.status,201);const fresh=await first.json() as any;assert.deepEqual(fresh,await second.json());
  await f.broker.request('captureReady',false);const denied=await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:formHeaders(f),body:'assertion='+fresh.assertion});assert(denied.status>=400);assert(!await denied.text().then(t=>t.includes('id="credential-key"')));
  const deniedPrepare=await httpsFetch(f.setupOrigin+'/credential-setup/prepare',{method:'POST',headers:{...s.headers,'Content-Type':'application/json'},body:'{"consent":true}'});assert(deniedPrepare.status>=400);assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});assert.equal((await f.broker.request('snapshot')).reads.length,0);
 }finally{await f.cleanup();}
});

test('INGEST-ADV wrong purpose/signature/origin and noncanonical bootstrap never render a key surface',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),response=await f.issue(human,human.model.modelConnectionId);assert.equal(response.status,201);const bootstrap=await response.json() as any,payload=claims(bootstrap.assertion);
  const sign=(body:any)=>new CompactSign(new TextEncoder().encode(JSON.stringify(body))).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-ingest-bootstrap+jws',kid:'main-ingest-1'}).sign(f.ingestKeys.privateKey);
  for(const body of [{...payload,purpose:'model-broker.execute'},{...payload,audience:'wrong'},{...payload,setupOrigin:f.mainOrigin},{...payload,nonce:'A'.repeat(43)}]){const denied=await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:formHeaders(f),body:'assertion='+await sign(body)});assert(denied.status>=400);assert.equal(denied.headers.get('Set-Cookie'),null);assert(!await denied.text().then(t=>t.includes('id="credential-key"')));}
  const segments=bootstrap.assertion.split('.');segments[2]=(segments[2][0]==='A'?'B':'A')+segments[2].slice(1);assert((await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:formHeaders(f),body:'assertion='+segments.join('.')})).status>=400);
  for(const body of ['assertion='+bootstrap.assertion+'&extra=true','assertion='+bootstrap.assertion+'&assertion='+bootstrap.assertion])assert((await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:formHeaders(f),body})).status>=400);
  assert((await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:{...formHeaders(f),Origin:'https://foreign.test'},body:'assertion='+bootstrap.assertion})).status>=400);
  assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});
 }finally{await f.cleanup();}
});

test('INGEST-ADV concurrent submission commits one irreversible claim and the loser never pulls its secret',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),s=await prepared(f,human);
  const outcomes=await Promise.all([f.broker.request('direct',secretRequest(f,s)),f.broker.request('direct',secretRequest(f,s))]);assert.equal(outcomes.filter(r=>r.pulls===1).length,1);assert.equal(outcomes.filter(r=>r.pulls===0).length,1);assert.equal(outcomes.find(r=>r.pulls===1)?.cleared,true);assert.equal(outcomes.find(r=>r.pulls===1)?.submissionAlreadyCommitted,true);
  assert.deepEqual(await counts(f),{credentials:1,cipher:1,receipts:1});assert.equal(f.posts.length,0);
  const replay=await f.broker.request('direct',secretRequest(f,s));assert.equal(replay.pulls,0);assert(replay.status>=400);
  f.recovery.unavailable=true;const owner=await httpsFetch(f.mainOrigin+'/api/v1/me/credential-ingests/'+s.bootstrap.authorizationRef,{headers:{Cookie:human.headers.Cookie}});assert.equal(owner.status,200);assert.equal((await owner.json() as any).state,'committed');
 }finally{await f.cleanup();}
});

test('INGEST-ADV JSON secret, foreign cookies, CSRF and current recovery floor deny before the application secret reader',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),s=await prepared(f,human);
  for(const changed of ([{'Content-Type':'application/json'},{Cookie:human.headers.Cookie},{'X-FP-Broker-CSRF':'A'.repeat(43)},{Origin:f.mainOrigin}] as Record<string,string>[])){const response=await httpsFetch(f.setupOrigin+'/credential-setup/secret',{method:'POST',headers:secretRequest(f,s,changed).headers,body:f.secret});assert(response.status>=400);}
  f.recovery.floor='2';const denied=await httpsFetch(f.setupOrigin+'/credential-setup/secret',{method:'POST',headers:secretRequest(f,s).headers,body:f.secret});const envelope=await denied.json() as any;assert.equal(claims(envelope.response).outcome.kind,'problem');assert((await f.broker.request('snapshot')).requests.filter((r:any)=>r.path==='/credential-setup/secret').every((r:any)=>r.readCalls===0));assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});assert.equal(f.posts.length,0);
 }finally{await f.cleanup();}
});

test('INGEST-ADV copied cookie and SQL claim cannot revive private setup on a wrong replica or restarted process',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),s=await prepared(f,human),replica=await f.spawnReplica();const wrong=await replica.request('direct',secretRequest(f,s));assert.equal(wrong.pulls,0);assert(wrong.status>=400);
  const restarted=await f.restartBroker();const denied=await restarted.request('direct',secretRequest(f,s));assert.equal(denied.pulls,0);assert(denied.status>=400);assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});
  const retry=await httpsFetch(f.setupOrigin+'/credential-setup',{method:'POST',headers:formHeaders(f),body:'assertion='+s.bootstrap.assertion});assert(retry.status>=400);assert.equal(retry.headers.get('Set-Cookie'),null);
 }finally{await f.cleanup();}
});

test('INGEST-ADV command-only expiry during the actual last receipt INSERT rolls back ciphertext, index and custody receipt',{timeout:60000},async()=>{
 const f=await ingestFixture();let holder:any;try{const human=await f.configured();await f.main.request('issuerDeadline',Date.now()+3500);const s=await prepared(f,human),expiry=Date.parse(claims(s.bootstrap.assertion).expiresAt);
  const lock='independent-ingest-receipt-'+randomUUID();await f.owner.query(`CREATE FUNCTION ingest_validation_receipt_gate() RETURNS trigger LANGUAGE plpgsql AS $gate$ BEGIN IF NEW.operation='broker.credential.create' THEN PERFORM pg_advisory_xact_lock(hashtextextended('${lock}',0)); END IF; RETURN NEW; END $gate$;CREATE TRIGGER z_ingest_validation_gate BEFORE INSERT ON scoped_command_receipts FOR EACH ROW EXECUTE FUNCTION ingest_validation_receipt_gate()`);
  holder=await f.owner.connect();await holder.query('BEGIN');await holder.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[lock]);
  const pending=f.broker.request('direct',secretRequest(f,s));await sqlBlocked(f,holder);
  const sessionExpiry=(await f.owner.query('SELECT expires_at FROM sessions WHERE token_hash=$1',[human.actor.session_hash])).rows[0].expires_at;assert(sessionExpiry.getTime()>expiry+30000);assert(Date.parse(claims(f.recovery.raw).expiresAt)>expiry+30000);
  await delay(Math.max(0,expiry-Date.now()+50));await holder.query('COMMIT');holder.release();holder=undefined;const result=await pending;assert.equal(result.pulls,1);assert.equal(result.cleared,true);
  assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});const row=(await f.owner.query('SELECT submission_claimed_at,committed_at FROM credential_ingest_authorizations WHERE authorization_id=$1',[s.bootstrap.authorizationRef])).rows[0];assert(row.submission_claimed_at);assert.equal(row.committed_at,null);assert.equal(f.posts.length,0);
 }finally{if(holder){await holder.query('ROLLBACK');holder.release();}await f.cleanup();}
});

test('INGEST-ADV a secret reader resolving after its actual command deadline is cleared and cannot publish custody',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured();await f.main.request('issuerDeadline',Date.now()+2200);const s=await prepared(f,human);const result=await f.broker.request('direct',{...secretRequest(f,s),delayMs:3000});assert.equal(result.pulls,1);
  await delay(3100);assert((await f.broker.request('snapshot')).reads.every((r:any)=>r.cleared));assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});assert.equal(f.posts.length,0);
 }finally{await f.cleanup();}
});

test('INGEST-ADV last protected-capture callback withdrawing the original SQL session prevents the first secret pull',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),s=await prepared(f,human);await f.broker.request('captureHook',f.recoveryOrigin+'/capture/'+s.bootstrap.authorizationRef);
  const result=await f.broker.request('direct',secretRequest(f,s));assert((await f.owner.query('SELECT revoked_at FROM sessions WHERE token_hash=$1',[human.actor.session_hash])).rows[0].revoked_at);assert.deepEqual(await counts(f),{credentials:0,cipher:0,receipts:0});assert.equal(result.pulls,0,'The last capture observation revoked the original session before any authorized read');
 }finally{await f.cleanup();}
});

test('INGEST-ADV actual response signing await cannot deliver committed metadata after original session withdrawal',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),s=await prepared(f,human);await f.broker.request('signHook',f.recoveryOrigin+'/sign/'+s.bootstrap.authorizationRef);
  const result=await f.broker.request('direct',secretRequest(f,s));assert.equal(result.pulls,1);const envelope=JSON.parse(result.body);const outcome=envelope.response?claims(envelope.response).outcome:null;assert((await f.owner.query('SELECT revoked_at FROM sessions WHERE token_hash=$1',[human.actor.session_hash])).rows[0].revoked_at);assert.deepEqual(await counts(f),{credentials:1,cipher:1,receipts:1});assert.equal(result.cleared,true);assert.notEqual(outcome?.kind,'metadata','The real Ed25519 signing await revoked the original SQL session before delivery');
 }finally{await f.cleanup();}
});

test('INGEST-ADV genuine main rotation accepts its own exact transition and original owner history survives recovery outage',{timeout:60000},async()=>{
 const f=await ingestFixture();try{const human=await f.configured(),credential=await f.ingestBrowser(human,human.model.modelConnectionId);
  const prerequisites=createExecutionPrerequisites(f.app,{environment:profile.environment,clientId:profile.clientId});
  const replacement=await prerequisites.models.create(human.actor,{key:randomUUID(),connectionId:human.initial.connectionId,expectedConnectionVersion:'1',selection:human.model.selection});
  const issue=await httpsFetch(f.mainOrigin+'/api/v1/me/credential-ingests',{method:'POST',headers:{...human.headers,Origin:f.mainOrigin,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:JSON.stringify({operation:'rotate',credentialId:credential.credentialId,replacementModelConnectionId:replacement.modelConnectionId,expectedReplacementModelVersion:'1',consent:true})});
  assert.equal(issue.status,201,await issue.clone().text());const bootstrap=await issue.json() as any,s=await prepared(f,{...human,model:replacement},bootstrap);
  const submit=await httpsFetch(f.setupOrigin+'/credential-setup/secret',{method:'POST',headers:secretRequest(f,s).headers,body:f.secret});assert.equal(submit.status,200);assert.equal(claims((await submit.json() as any).response).outcome.kind,'metadata');
  const rows=(await f.owner.query('SELECT credential_id,state FROM broker_model_credentials')).rows;assert.equal(rows.find(r=>r.credential_id===credential.credentialId)?.state,'rotated');assert.equal(rows.filter(r=>r.state==='active').length,1);assert.equal((await f.owner.query('SELECT state FROM model_connections WHERE model_connection_id=$1',[human.model.modelConnectionId])).rows[0].state,'revoked');
  assert.equal((await f.owner.query("SELECT count(*)::int n FROM scoped_command_receipts WHERE operation='broker.credential.rotate'")).rows[0].n,1);assert.equal(f.posts.length,0);f.recovery.unavailable=true;
  const read=await httpsFetch(f.mainOrigin+'/api/v1/me/credential-ingests/'+bootstrap.authorizationRef,{headers:{Cookie:human.headers.Cookie}});assert.equal(read.status,200);const outcome=await read.json() as any;assert.equal(outcome.state,'committed');assert.equal(outcome.credential.modelConnectionId,replacement.modelConnectionId);assert.equal(outcome.operational_authority,false);
 }finally{await f.cleanup();}
});

test('INGEST-ADV actual parent app dispatches installed ingest and denies missing ports before reading the original stream',{timeout:60000},async()=>{
 const f=await ingestFixture();try{
  const {createApp}=await import('../../apps/platform-api/src/app.js');
  const {createPrivateAiProductTransport,bindPrivateAiProductTransport}=await import('../../apps/platform-api/src/private-ai-product.js');
  const {createCredentialIngestClient}=await import('../../apps/platform-api/src/credential-ingest-client.js');
  const {createCredentialIngestAuthorizations}=await import('../../modules/agent-control/credential-ingest-authorizations.js');
  const {createUnavailableModelStepHost}=await import('../../modules/agent-execution/model-step-host.js');
  const {fileStore}=await import('./credential-ingest-fixtures/shared.js');
  const origin='https://platform.test:5443',environment='staging-next' as const;
  const authorizations=createCredentialIngestAuthorizations(f.app,{environment,clientId:profile.clientId,issuer:profile.issuer,audience:profile.audience,setupOrigin:f.setupOrigin,recover:async()=>({generation:'1',expiresAt:new Date(Date.now()+60000).toISOString()})});
  const ingest=await createCredentialIngestClient(f.app,{origin,environment,clientId:profile.clientId,setupOrigin:f.setupOrigin,issuer:profile.issuer,audience:profile.audience,keyId:'parent-ingest-1',signingKey:f.ingestKeys.privateKey,authorizations});
  const options={origin,environment,clientId:profile.clientId,host:createUnavailableModelStepHost(),store:fileStore(f.directory)};
  const product=await createPrivateAiProductTransport(f.app,{...options,ingest}),withoutIngest=await createPrivateAiProductTransport(f.app,options);
  const direct=bindPrivateAiProductTransport(product,f.app,origin,'staging');
  const installed=createApp(f.app,origin,'staging',{privateAiProduct:product}),missingProduct=createApp(f.app,origin,'staging'),missingIngest=createApp(f.app,origin,'staging',{privateAiProduct:withoutIngest});
  const facts:any[]=[];
  for(const [name,app,expected]of [['installed',installed,401],['missing-product',missingProduct,503],['missing-ingest',missingIngest,503]] as const){
   for(const method of ['GET','POST'] as const){
    let pulls=0;const path='/api/v1/me/credential-ingests'+(method==='GET'?'/'+randomUUID():'');
    const headers={Origin:origin,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"'};
    const request=new Request(origin+path,{method,headers:method==='POST'?headers:{},...(method==='POST'?{body:new ReadableStream<Uint8Array>({pull(controller){pulls++;controller.enqueue(new TextEncoder().encode('{}'));controller.close();}},{highWaterMark:0}),duplex:'half'}:{})} as RequestInit);
    let childBody:any;
    if(name==='installed'){const baseline=await direct(new Request(origin+path,{method,headers:method==='POST'?headers:{}}));assert.equal(baseline.status,401);childBody=await baseline.json();assert.equal(childBody.code,'login_required');}
    const response=await app.fetch(request),body=await response.text();facts.push({name,method,status:response.status,expected,pulls,body,childBody,dispatchMatches:childBody===undefined||JSON.stringify(childBody)===body});
   }
  }
  // Collect all actual parent outcomes before asserting so the RED receipt also
  // records both missing-port paths and their original stream pulls.
  assert(facts.every(row=>row.status===row.expected&&row.pulls===0&&row.dispatchMatches),JSON.stringify(facts));
  for(const row of facts)if(row.name==='installed')assert.equal(JSON.parse(row.body).code,'login_required');
 }finally{await f.cleanup();}
});
