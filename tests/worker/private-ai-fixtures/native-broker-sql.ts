import assert from 'node:assert/strict';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {createServer as netServer,createConnection,type Socket} from 'node:net';
import {mkdtemp,mkdir,readFile,readdir,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions,type V4WorkerOptions,type V4ModuleDefinition} from 'miniflare';
import {CompactSign,exportJWK,generateKeyPair} from 'jose';
import {Pool} from 'pg';
import {migrate} from '../../../scripts/database.js';
import {authenticate,hashPasswordAsync,login} from '../../../modules/identity-membership/service.js';
import {withMemberScope} from '../../../packages/resource-scopes/index.js';
import {createDeviceAuthorizations} from '../../../modules/agent-control/device-authorizations.js';
import {createBootstrapSessions} from '../../../modules/agent-control/bootstrap-sessions.js';
import {createRuntimeRegistrationChallenge,parseRuntimePublicJwk} from '../../../modules/agent-control/runtime-proof.js';
import {createPrivateWorkCommands} from '../../../modules/opportunity-project-work/private-commands.js';
import {createExecutionRuns} from '../../../modules/agent-execution/runs.js';
import {createExecutionPrerequisites} from '../../../modules/agent-execution/prerequisites.js';
import {resolvePrivateWorkPersistencePolicy} from '../../../modules/autopilot-work/policy.js';
import type {ObjectStore} from '../../../packages/asset-storage/index.js';
import type {BootstrapSessionHost} from '../../../contracts/execution/v1/bootstrap-session.js';
import type {ModelSelection} from '../../../contracts/execution/v1/member-execution.js';
import type {ModelBrokerRequest} from '../../../contracts/execution/v2/model-broker-bridge.js';
import {ModelStepMetadataSchema} from '../../../contracts/execution/v2/model-step.js';
import {createCredentialVault} from '../../../apps/credential-broker/src/vault.js';
import {createBrokerCredentialStore,getCredentialWriteBinding} from '../../../apps/credential-broker/src/store.js';
import {createModelBrokerClient} from '../../../apps/platform-api/src/model-broker-client.js';
import {createPrivateAiProductTransport,bindPrivateAiProductTransport} from '../../../apps/platform-api/src/private-ai-product.js';
export const profile={environment:'staging-next' as const,clientId:'native-broker-worker',issuer:'synthetic-main',audience:'synthetic-broker'};
export const modelSelection:ModelSelection={providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
const iso=(time=Date.now())=>new Date(time).toISOString();
const hash=(value:string)=>createHash('sha256').update(value,'ascii').digest('base64url');
export const secret='SYNTHETIC_WORKER_PROVIDER_ONLY',output='SYNTHETIC_NATIVE_PRIVATE_RESULT';
export async function minimalJwk(key:CryptoKey){const {kty,crv,x,y,d}=await crypto.subtle.exportKey('jwk',key);return {kty,crv,x,...(y?{y}:{}),...(d?{d}:{})};}
async function template(owner:Pool,schema:string,file:string,role:string,variable:string) {
  const source=(await readFile(new URL('../../../deploy/cloudflare/sql/'+file,import.meta.url),'utf8')).replace(/^\\set .*$/mg,'').replaceAll('SCHEMA public','SCHEMA '+schema).replaceAll("n.nspname='public'","n.nspname='"+schema+"'").replaceAll("'public','CREATE'","'"+schema+"','CREATE'").replaceAll(':"'+variable+'"','"'+role+'"').replaceAll(":'"+variable+"'","'"+role+"'");
  const q=await owner.connect();try{const pieces=source.split('\\gexec');for(let i=0;i<pieces.length;i++){const result=await q.query(pieces[i]);if(i<pieces.length-1){const last=Array.isArray(result)?result[result.length-1]:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}}}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
}


/** Synthetic local workerd + restricted SQL fixture. Outbound provider fetch is
 * intercepted by another local Worker; no live provider or owner evidence. */
export async function nativeBrokerSqlFixture(extend?:(context:{workers:V4WorkerOptions[];brokerWorker:V4WorkerOptions;mainOrigin:string;
  database:string;appHyperdrive:string;directory:string;requestKeys:CryptoKeyPair;responseKeys:CryptoKeyPair;recoveryKeys:CryptoKeyPair;
  workerProfile:Record<string,unknown>})=>Promise<void>) {
  const raw=process.env.TEST_DATABASE_URL;if(!raw||!/^\/fp_[a-z0-9_]+$/.test(new URL(raw).pathname))throw Error('Owned fp_* test database URL required');
  const adminUrl=new URL(raw),socket=adminUrl.searchParams.get('host');if(!socket&&!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname))throw Error('Owned loopback/socket DB only');
  const database='freedom_staging_next',roles={owner:'fp_bw_owner_'+process.pid,app:'fp_bw_app_'+process.pid,broker:'freedom_staging_next_broker',executor:'freedom_staging_next_broker_executor'},password=randomBytes(24).toString('hex');
  const admin=new Pool({connectionString:raw}),roleUrl=(role:string)=>{const url=new URL(raw);url.pathname='/'+database;url.username=role;url.password=password;return url.href;};
  const owner=new Pool({connectionString:roleUrl(roles.owner)}),app=new Pool({connectionString:roleUrl(roles.app)}),cipher=new Pool({connectionString:roleUrl(roles.broker)}),executor=new Pool({connectionString:roleUrl(roles.executor)});
  // Pool.end() resolves after removing clients, before their sockets necessarily close.
  // Wait for actual client end events before DROP FORCE, so teardown cannot kill an idle closing client.
  const closedClients:Promise<void>[]=[];
  for(const pool of [owner,app,cipher,executor])pool.on('connect',client=>closedClients.push(new Promise<void>(resolve=>client.once('end',resolve))));
  const sockets=new Set<Socket>(),proxy=socket?netServer(client=>{const upstream=createConnection(join(socket,'.s.PGSQL.5432'));for(const socket of [client,upstream]){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{client.destroy();upstream.destroy();});}client.pipe(upstream).pipe(client);}):undefined;
  let created=false,mf:Miniflare|undefined,directory:string|undefined;
  const cleanup=async()=>{await mf?.dispose();for(const socket of sockets)socket.destroy();if(proxy?.listening)await new Promise<void>(r=>proxy.close(()=>r()));await Promise.all([owner.end(),app.end(),cipher.end(),executor.end()]);await Promise.all(closedClients);if(created){await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);await admin.query(`DROP ROLE ${Object.values(roles).join(',')}`);}await admin.end();if(directory)await rm(directory,{recursive:true,force:true});};
  try{
    await admin.query(Object.values(roles).map(role=>`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`).join(';'));
    await admin.query(`CREATE DATABASE ${database} OWNER ${roles.owner}`);created=true;await migrate(owner);
    await template(owner,'public','20-runtime-grants.psql',roles.app,'runtime');await template(owner,'public','40-credential-broker-grants.psql',roles.broker,'broker');await template(owner,'public','45-model-broker-execution-grants.psql',roles.executor,'executor');
    assert.deepEqual((await owner.query(`SELECT has_column_privilege($1,'assets','scope_kind','INSERT') AS scope_write,
      has_column_privilege($1,'assets','community_ref','INSERT') AS community_write,
      has_column_privilege($1,'asset_objects','profile_id','INSERT') AS media_profile_write`,[roles.executor])).rows,
    [{scope_write:false,community_write:false,media_profile_write:false}], 'private executor gains no media column writes');
    let port:string|undefined;if(proxy){await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const address=proxy.address();assert(address&&typeof address==='object');port=String(address.port);}
    function hyperdrive(role:string){const url=new URL(roleUrl(role));if(proxy){url.hostname='127.0.0.1';url.port=port!;url.searchParams.delete('host');}return url.href;}
    const requestKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),responseKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),recoveryKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
    const mainOrigin='https://staging.freetwai.com',now=Date.now(),expiresAt=iso(now+120000);
    const signedState=await new CompactSign(new TextEncoder().encode(JSON.stringify({profile:'credential-broker.recovery/v1',purpose:'credential-broker.recovery',authority:'synthetic-recovery',environment:'staging-next',generation:'1',issuedAt:iso(now),expiresAt}))).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-recovery+jws',kid:'recovery'}).sign(recoveryKeys.privateKey);
    const recover=async()=>({generation:'1',expiresAt});
    const kek=crypto.getRandomValues(new Uint8Array(32)),kekKey=await crypto.subtle.importKey('raw',kek,{name:'AES-GCM'},false,['encrypt','decrypt']);
    const vault=createCredentialVault({recover,kek:{current:async()=>({keyId:'test-kek',key:kekKey}),readById:async id=>id==='test-kek'?kekKey:null}});
    const credentials=createBrokerCredentialStore(cipher,{environment:profile.environment,clientId:profile.clientId,vault,recover,credentialTtlSeconds:120});
    const workerProfile={environment:profile.environment,platformOrigin:mainOrigin,clientId:profile.clientId,issuer:profile.issuer,requestAudience:profile.audience,brokerId:'synthetic-broker',responseAudience:'synthetic-main',responseKeyId:'response',requestKeys:[{keyId:'request',publicJwk:await minimalJwk(requestKeys.publicKey)}],recoveryKeys:[{keyId:'recovery',publicJwk:await minimalJwk(recoveryKeys.publicKey)}],recoveryAuthority:'synthetic-recovery',databaseName:database,cipherRole:roles.broker,executorRole:roles.executor,currentKekId:'test-kek'};
    const bindings={FREEDOM_BROKER_ENABLED:'true',FREEDOM_BROKER_ENVIRONMENT:'staging-next',APP_ORIGIN:mainOrigin,FREEDOM_BROKER_PROFILE:JSON.stringify(workerProfile),FREEDOM_BROKER_RESPONSE_KEY:JSON.stringify(await minimalJwk(responseKeys.privateKey)),FREEDOM_BROKER_KEKS:JSON.stringify([{keyId:'test-kek',jwk:{kty:'oct',k:Buffer.from(kek).toString('base64url')}}])};kek.fill(0);
    await mkdir(resolve('.wrangler'),{recursive:true});
    directory=await mkdtemp(resolve('.wrangler/broker-sql-'));
    const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','wrangler.broker.example.jsonc','--env','staging-next','--outdir',directory],{maxBuffer:1024*1024});
    const provider=`let posts=0,gets=0;export default {async fetch(request){const url=new URL(request.url);if(url.pathname==='/counts')return Response.json({posts,gets});if(url.hostname!=='api.openai.com'||request.headers.get('Authorization')!=='Bearer ${secret}')return new Response('',{status:401});if(request.method==='GET'){gets++;return Response.json({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic'});}posts++;const body=await request.json();if(body.tools.length!==0)return new Response('',{status:400});return Response.json({id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',output:[{id:'message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'${output}',annotations:[]}]}],usage:{input_tokens:3,output_tokens:4,total_tokens:7}});}};`;
    // Miniflare 5's V4 converter rejects modulesRules. Explicit modules preserve
    // Wrangler's binary setup-brand asset and use the real emitted entry first.
    const brokerModules:V4ModuleDefinition[]=[{type:'ESModule',path:join(directory,'worker.js')},
      ...(await readdir(directory)).filter(name=>name.endsWith('.webp')).sort().map(name=>({type:'Data' as const,path:join(directory!,name)}))];
    const brokerWorker={name:'broker',modules:brokerModules,modulesRoot:directory,compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings,hyperdrives:{CIPHER_HYPERDRIVE:hyperdrive(roles.broker),EXECUTOR_HYPERDRIVE:hyperdrive(roles.executor)},r2Buckets:{MEDIA:'synthetic-broker-private-assets'},serviceBindings:{CREDENTIAL_RECOVERY_STATE:'recovery-state',CREDENTIAL_RECOVERY_FLOOR:'recovery-floor'},outboundService:'synthetic-provider'};
    const workers:V4WorkerOptions[]=[brokerWorker,
      {...brokerWorker,name:'foreign-profile',bindings:{...bindings,FREEDOM_BROKER_ENVIRONMENT:'next'}},
      {...brokerWorker,name:'swapped-roles',hyperdrives:{CIPHER_HYPERDRIVE:hyperdrive(roles.executor),EXECUTOR_HYPERDRIVE:hyperdrive(roles.broker)}},
      {name:'synthetic-provider',modules:true,script:provider,compatibilityDate:'2026-09-21'},
      {name:'recovery-state',modules:true,script:`let unavailable=false;export default {fetch(request){const path=new URL(request.url).pathname;if(path==='/unavailable')unavailable=true;if(path==='/reset')unavailable=false;return unavailable?new Response(null,{status:503}):Response.json({signedState:${JSON.stringify(signedState)}});}};`,compatibilityDate:'2026-09-21'},
      {name:'recovery-floor',modules:true,script:`let generation='1';export default {fetch(request){if(new URL(request.url).pathname==='/invalidate')generation='2';if(new URL(request.url).pathname==='/reset')generation='1';return Response.json({generation,expiresAt:${JSON.stringify(expiresAt)}});}};`,compatibilityDate:'2026-09-21'}];
    await extend?.({workers,brokerWorker,mainOrigin,database,appHyperdrive:hyperdrive(roles.app),directory,requestKeys,responseKeys,recoveryKeys,workerProfile});
    mf=new Miniflare(convertV4MiniflareOptions({workers}));await mf.ready;
    const broker=await mf.getWorker('broker');
    const requests:ModelBrokerRequest[]=[];
    const client=await createModelBrokerClient(app,{origin:mainOrigin,...profile,requestKid:'request',requestKey:requestKeys.privateKey,responseKeys:new Map([['response',responseKeys.publicKey]]),brokerIdentity:'synthetic-broker',responseAudience:'synthetic-main',recover,exchange:async request=>{requests.push(request);const response=await broker.fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(request)});assert.equal(response.status,200,await response.clone().text());return response.json() as Promise<{response:string}>;}});
    const store={putImmutable:async()=>{throw Error('Main must not write Result');},head:async()=>null,get:async()=>null,delete:async()=>{throw Error('Main must not delete Result');}} as ObjectStore;
    const product=await createPrivateAiProductTransport(app,{origin:mainOrigin,environment:profile.environment,clientId:profile.clientId,broker:client,store});const mainFetch=bindPrivateAiProductTransport(product,app,mainOrigin,'staging');
    const options={environment:profile.environment,clientId:profile.clientId};const prerequisites=createExecutionPrerequisites(app,options),runs=createExecutionRuns(app),works=createPrivateWorkCommands(app,{resolvePolicy:resolvePrivateWorkPersistencePolicy});
  async function member() {
    const user=randomUUID(),community=randomUUID(),email=user+'@example.invalid';
    await owner.query("INSERT INTO communities VALUES($1,'Synthetic process community')",[community]);
    await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic process owner',$4,$5)`,[user,community,email,await hashPasswordAsync('synthetic-password-only'),randomUUID()]);
    const session=await login(app,email,'synthetic-password-only');const actor=await authenticate(app,session.token);
    const context=await withMemberScope(app,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
    await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit) VALUES($1,'work.private-draft',$2,1,true,10485760)`,[context.scope.scope_id,context.subject_principal.principal_id]);
    return {actor,context,token:session.token,headers:{Cookie:'freedom_local_session='+session.token,'X-CSRF-Token':actor.csrf_token,Origin:mainOrigin}};
  }
  async function paired(human:Awaited<ReturnType<typeof member>>) {
    const issuer=await generateKeyPair('ES256'),device=await generateKeyPair('ES256');
    const publicJwk=parseRuntimePublicJwk(await exportJWK(device.publicKey));
    const host:BootstrapSessionHost={...options,issuerKid:'pairing-issuer',issuer:'https://issuer.example.invalid/',audience:'https://platform.example.invalid/',bootstrapUri:'https://platform.example.invalid/execution-api/v1/bootstrap',refreshUri:'https://platform.example.invalid/execution-api/v1/auth/refresh',nonceUri:'https://platform.example.invalid/execution-api/v1/auth/nonce',keys:[{kid:'pairing-issuer',purpose:'bootstrap_access',environment:'staging-next',publicJwk:parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
    const {refreshUri:_r,nonceUri:_n,...baseHost}=host;
    const pairingHost={...baseHost,beginUri:'https://platform.example.invalid/device/begin',pollUri:'https://platform.example.invalid/device/poll',verificationUri:'https://platform.example.invalid/device',clientDisplayName:'Synthetic bridge device'};
    const pairing=await createDeviceAuthorizations(app,{host:pairingHost,signingKey:issuer.privateKey});
    const sessions=await createBootstrapSessions(app,{host,signingKey:issuer.privateKey});
    const sign=(typ:string,claims:Record<string,unknown>)=>new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({alg:'ES256',typ,jwk:publicJwk}).sign(device.privateKey);
    const clock=async()=>Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms);
    const base={client_id:options.clientId,environment:'staging-next',runtime_kind:'agent-kit',scope:'bootstrap.status.read',htm:'POST'};
    const started=await pairing.begin({publicJwk,runtimeKind:'agent-kit',proof:await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_begin',jti:randomUUID(),iat:Math.floor(await clock()/1000),htu:pairingHost.beginUri})});
    await pairing.decide(human.actor,{key:randomUUID(),userCode:started.userCode,authorizationId:started.authorizationId,requestDigest:started.requestDigest,decision:'approve'});
    const row=(await owner.query('SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id) WHERE a.authorization_id=$1',[started.authorizationId])).rows[0];
    const challenge=createRuntimeRegistrationChallenge({challenge_id:row.challenge_id,runtime_device_id:row.runtime_device_id,owner_member_id:row.owner_user_id,owner_principal_id:row.owner_principal_id,scope_id:row.scope_id,environment:row.environment,key_thumbprint:row.key_thumbprint,nonce:row.nonce,issued_at:row.issued_at.toISOString(),expires_at:row.expires_at.toISOString()});
    const enrollmentProof=await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(device.privateKey);
    const initial=await pairing.poll({authorizationId:started.authorizationId,deviceCode:started.deviceCode,enrollmentProof,proof:await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_poll',jti:randomUUID(),iat:Math.floor(await clock()/1000),htu:pairingHost.pollUri,authorization_id:started.authorizationId,request_digest:started.requestDigest,nonce:started.nonce,device_code_hash:hash(started.deviceCode)})});
    assert.equal(initial.status,'issued');if(initial.status!=='issued')throw Error('Pairing did not issue');
    const refresh=initial.refresh;
    await sessions.refresh({familyId:refresh.familyId,refreshHandle:refresh.handle,proof:await sign('freedom-bootstrap-refresh+jwt',{purpose:'bootstrap_refresh',client_id:options.clientId,environment:'staging-next',connection_id:initial.connectionId,family_id:refresh.familyId,generation:refresh.generation,refresh_handle_hash:hash(refresh.handle),jti:randomUUID(),iat:Math.floor(await clock()/1000),htm:'POST',htu:host.refreshUri})});
    return initial;
  }
  async function post(human:Awaited<ReturnType<typeof member>>,path:string,value:unknown,headers:Record<string,string>={}) { return mainFetch(new Request(mainOrigin+path,{method:'POST',headers:{...human.headers,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"',...headers},body:JSON.stringify(value)})); }
  async function approved() {
    const human=await member(),initial=await paired(human);
    const work=await works.create(human.actor,{key:randomUUID(),title:'Synthetic process private work',objective:'SYNTHETIC_PROCESS_PRIVATE_OBJECTIVE'});
    const run=await runs.create(human.actor,{key:randomUUID(),workId:work.workId,expectedWorkVersion:'1'});
    const model=await prerequisites.models.create(human.actor,{key:randomUUID(),connectionId:initial.connectionId,expectedConnectionVersion:'1',selection:modelSelection});
    const grant=await prerequisites.grants.create(human.actor,{key:randomUUID(),runId:run.runId,expectedRunVersion:'1',expectedWorkVersion:'1',connectionId:initial.connectionId,expectedConnectionVersion:'1',modelConnectionId:model.modelConnectionId,expectedModelVersion:'1',consent:true});
    await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,'staging-next',$4,$5,1,true,16384,20)`,[randomUUID(),human.context.scope.scope_id,human.context.subject_principal.principal_id,options.clientId,JSON.stringify(modelSelection)]);
    const intent=await credentials.prepareCreate(human.actor,{key:randomUUID(),modelConnectionId:model.modelConnectionId,expectedModelVersion:'1',consent:true});const binding=getCredentialWriteBinding(intent);const keyBytes=new TextEncoder().encode(secret);let credential;try{credential=await credentials.commit(human.actor,intent,await vault.seal(binding,keyBytes));}finally{keyBytes.fill(0);}
    const response=await post(human,'/api/v1/me/model-step-approvals',{runId:run.runId,grantId:grant.grantId,expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20});assert.equal(response.status,201,await response.clone().text());
    return {...human,initial,work,run,model,grant,credential,approval:await response.json() as any};
  }
  async function activated() {const f=await approved();const response=await post(f,'/api/v1/me/model-steps',{approvalId:f.approval.approvalId,expectedRunVersion:'1'});assert.equal(response.status,201,await response.clone().text());return {...f,step:ModelStepMetadataSchema.parse(await response.json())};}

    return {mf,broker,app,owner,cipher,executor,roles,requests,requestKeys,responseKeys,recoveryKeys,member,paired,post,approved,activated,
      mainOrigin,database,workerProfile,prerequisites,runs,works,cleanup};
  }catch(error){await cleanup();throw error;}
}
