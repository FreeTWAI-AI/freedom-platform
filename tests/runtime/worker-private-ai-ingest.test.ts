import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {Pool} from 'pg';
import {CompactSign,compactVerify,exportJWK,generateKeyPair} from 'jose';
import {migrate} from '../../scripts/database.js';
import {login,hashPassword} from '../../modules/identity-membership/service.js';
import {withMemberScope} from '../../packages/resource-scopes/index.js';
import {transaction} from '../../packages/db/transaction.js';
import {createRuntimeRegistrations} from '../../modules/agent-control/runtime-registration.js';
import {parseRuntimePublicJwk} from '../../modules/agent-control/runtime-proof.js';
import {createAgentConnections} from '../../modules/agent-control/agent-connections.js';
import {insertInitialRefreshFamily} from '../../modules/agent-control/bootstrap-session-store.js';
import {createExecutionPrerequisites} from '../../modules/agent-execution/prerequisites.js';
import {CredentialIngestBootstrapClaimsSchema,CredentialIngestHandoffSchema} from '../../contracts/execution/v2/model-credential-ingest.js';
import {workerPrivateAiPorts} from '../../apps/platform-api/src/worker-private-ai.js';

const connectionString=process.env.TEST_DATABASE_URL;
if(!connectionString)throw Error('Explicit isolated fp_* TEST_DATABASE_URL required');
const local=new URL(connectionString);
if(!/^\/fp_[a-z0-9_]+$/.test(local.pathname)||!(local.searchParams.get('host')?.startsWith('/')||['127.0.0.1','localhost','[::1]'].includes(local.hostname)))throw Error('Isolated local fp_* TEST_DATABASE_URL required');
const schema=`fp_worker_ingest_${process.pid}_${Date.now()}`,migrator=schema+'_owner',runtime=schema+'_app';
const admin=new Pool({connectionString});
const roleUrl=(role:string)=>{const url=new URL(connectionString);url.username=role;url.password='';return url.href;};
const owner=new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema}`}),app=new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema}`});
const environment='staging-next',origin='https://platform.test',clientId='synthetic-worker-ingest-sql',setupOrigin='https://setup.test';
const selection={providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset' as const,
  credentialCustody:'platform_vault' as const,engineLocation:'platform' as const,billingSource:'user_byok' as const};
const pairs=await Promise.all(Array.from({length:4},()=>generateKeyPair('EdDSA',{extractable:true})));
const minimal=async(key:CryptoKey)=>{const {kty,crv,x,d}=await exportJWK(key);return {kty,crv,x,...(d?{d}:{})};};
let created=false,externalCalls=0,unavailable=false;
let ports:NonNullable<Awaited<ReturnType<typeof workerPrivateAiPorts>>>;
before(async()=>{
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created=true;await migrate(owner);
  const template=await readFile('deploy/cloudflare/sql/20-runtime-grants.psql','utf8');
  const substitute=(sql:string)=>sql.replaceAll('SCHEMA public',`SCHEMA ${schema}`).replaceAll("'public'",`'${schema}'`).replaceAll(':"runtime"',`"${runtime}"`).replaceAll(":'runtime'",`'${runtime}'`);
  const q=await owner.connect();try{
    await q.query(substitute(template.slice(template.indexOf('BEGIN;'),template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))));
    for(const marker of ['PRIVATE POLICY GRANTS','BROKER CREDENTIAL EXCLUSIONS','MODEL BROKER AUTHORIZATION EXCLUSIONS'])
      for(const row of(await q.query(substitute(template.split('-- BEGIN '+marker+'\n')[1].split('\n\\gexec')[0]))).rows)await q.query(Object.values(row)[0] as string);
    await q.query('COMMIT');
  }catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  const forbidden=()=>{externalCalls++;throw Error('No broker/provider/R2 call authorized by this fixture');};
  ports=(await workerPrivateAiPorts(app,{FREEDOM_PRIVATE_AI_ENABLED:'true',FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify(await minimal(pairs[0].privateKey)),
    FREEDOM_PRIVATE_AI_INGEST_KEY:JSON.stringify(await minimal(pairs[3].privateKey)),FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify({environment,platformOrigin:origin,clientId,
      issuer:'main-staging',audience:'broker-staging',brokerIdentity:'broker-staging',responseAudience:'main-staging',requestKid:'main-request',
      responseKeys:[{keyId:'broker-response',publicJwk:await minimal(pairs[1].publicKey)}],recoveryAuthority:'recovery-staging',
      recoveryKeys:[{keyId:'recovery-key',publicJwk:await minimal(pairs[2].publicKey)}],settingsSelections:[selection],
      ingest:{setupOrigin,issuer:'main-ingest',audience:'broker-ingest',keyId:'ingest-key'}}),MODEL_BROKER:{fetch:async()=>forbidden()},
    CREDENTIAL_RECOVERY_FLOOR:{fetch:async()=>unavailable?new Response(null,{status:503}):Response.json({generation:'1',expiresAt:new Date(Date.now()+60000).toISOString()})},
    CREDENTIAL_RECOVERY_STATE:{fetch:async()=>{
      if(unavailable)return new Response(null,{status:503});
      const now=Date.now(),signedState=await new CompactSign(new TextEncoder().encode(JSON.stringify({profile:'credential-broker.recovery/v1',purpose:'credential-broker.recovery',
        authority:'recovery-staging',environment,generation:'1',issuedAt:new Date(now).toISOString(),expiresAt:new Date(now+60000).toISOString()})))
        .setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-recovery+jws',kid:'recovery-key'}).sign(pairs[2].privateKey);
      return Response.json({signedState});}},MEDIA:{put:forbidden,get:forbidden,head:forbidden,delete:forbidden} as never},
    {origin,freedomEnv:'staging'}))!;assert(ports);
});
after(async()=>{await app.end();await owner.end();try{if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);}finally{await admin.end();}});
async function member(){
  const user=randomUUID(),community=randomUUID(),email=user+'@example.invalid';
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic composition test')",[community]);
  await owner.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic member',$4,$5)",[user,community,email,hashPassword('synthetic-password'),randomUUID()]);
  const session=await login(app,email,'synthetic-password');
  const context=await withMemberScope(app,{actor:session.actor,scope:'personal'},async()=>{},async(_q,c)=>c);
  await owner.query("INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit) VALUES($1,'work.private-draft',$2,1,true,1048576)",[context.scope.scope_id,context.subject_principal.principal_id]);
  const enrollment=createRuntimeRegistrations(app,{environment}),keys=await generateKeyPair('ES256',{extractable:true});
  const challenge=await enrollment.begin(session.actor,{key:randomUUID(),publicJwk:parseRuntimePublicJwk(await exportJWK(keys.publicKey))});
  const proof=await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(keys.privateKey);
  const device=await enrollment.confirm(session.actor,{key:randomUUID(),challengeId:challenge.challenge_id,proof});
  const connection=await createAgentConnections(app,{environment,clientId}).create(session.actor,{key:randomUUID(),runtimeDeviceId:device.runtimeDeviceId});
  await transaction(app,q=>insertInitialRefreshFamily(q,connection.connectionId,new Date(connection.issuedAt),new Date(connection.expiresAt)));
  const model=await createExecutionPrerequisites(app,{environment,clientId}).models.create(session.actor,{key:randomUUID(),connectionId:connection.connectionId,expectedConnectionVersion:'1',selection});
  const headers={Cookie:'__Host-freedom_session='+session.token,'X-CSRF-Token':session.actor.csrf_token,Origin:origin,'Content-Type':'application/json','If-Match':'"1"'};
  return {session,model,headers};
}
const issue=(human:Awaited<ReturnType<typeof member>>,extra:Record<string,unknown>={})=>ports.privateAiProduct(new Request(origin+'/api/v1/me/credential-ingests',{
  method:'POST',headers:{...human.headers,'Idempotency-Key':randomUUID()},body:JSON.stringify({operation:'create',modelConnectionId:human.model.modelConnectionId,consent:true,...extra})}));
test('Worker composition issues only an owner-bound signed handoff through restricted main SQL; recovery/session withdrawal fail closed',async()=>{
  const human=await member();assert.equal(ports.privateAiSetupOrigin(),setupOrigin);
  const response=await issue(human);assert.equal(response.status,201,await response.clone().text());
  const handoff=CredentialIngestHandoffSchema.parse(await response.json());
  const verified=await compactVerify(handoff.assertion,pairs[3].publicKey,{algorithms:['EdDSA']});
  const claims=CredentialIngestBootstrapClaimsSchema.parse(JSON.parse(new TextDecoder().decode(verified.payload)));
  assert.equal(claims.environment,environment);assert.equal(claims.clientId,clientId);assert.equal(claims.setupOrigin,setupOrigin);
  assert.equal(claims.authorizationRef,handoff.authorizationRef);assert.equal(claims.issuer,'main-ingest');assert.equal(claims.audience,'broker-ingest');
  const row=(await owner.query('SELECT owner_user_id,original_session_hash FROM credential_ingest_authorizations WHERE authorization_id=$1',[handoff.authorizationRef])).rows[0];
  assert.equal(row.owner_user_id,human.session.actor.user_id);assert.equal(row.original_session_hash,human.session.actor.session_hash);
  assert.equal((await issue(human,{secret:'synthetic-must-not-enter-main'})).status,400);
  unavailable=true;assert.notEqual((await issue(human)).status,201);
  const read=await ports.privateAiProduct(new Request(origin+'/api/v1/me/credential-ingests/'+handoff.authorizationRef,{headers:{Cookie:human.headers.Cookie}}));
  assert.equal(read.status,200,'Owner metadata reads survive recovery outage');unavailable=false;
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[human.session.actor.session_hash]);
  assert.equal((await issue(human)).status,401);
  await assert.rejects(app.query('SELECT * FROM broker_credential_vault'),{code:'42501'});
  assert.equal(externalCalls,0);
});
