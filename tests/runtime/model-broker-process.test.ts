import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { Readable } from 'node:stream';
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, writeFile, link, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { CompactSign, exportJWK, generateKeyPair, importJWK } from 'jose';
import { Pool, type PoolClient } from 'pg';
import { migrate } from '../../scripts/database.js';
import { authenticate, hashPasswordAsync, login, type Actor } from '../../modules/identity-membership/service.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { createDeviceAuthorizations } from '../../modules/agent-control/device-authorizations.js';
import { createBootstrapSessions } from '../../modules/agent-control/bootstrap-sessions.js';
import { createRuntimeRegistrationChallenge, parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { createPrivateWorkCommands } from '../../modules/opportunity-project-work/private-commands.js';
import { createExecutionRuns } from '../../modules/agent-execution/runs.js';
import { createExecutionPrerequisites } from '../../modules/agent-execution/prerequisites.js';
import { resolvePrivateWorkPersistencePolicy } from '../../modules/autopilot-work/policy.js';
import { createPrivateResultService } from '../../modules/autopilot-work/results.js';
import { assertObjectKey, validateRange, type ObjectStore, type ObjectMetadata } from '../../packages/asset-storage/index.js';
import type { BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';
import type { ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import type { ModelBrokerRequest } from '../../contracts/execution/v2/model-broker-bridge.js';
import { ModelStepMetadataSchema } from '../../contracts/execution/v2/model-step.js';

const self = fileURLToPath(import.meta.url);
export const profile = { environment: 'local' as const, clientId: 'independent-process-bridge', issuer: 'synthetic-main', audience: 'synthetic-broker' };
const modelSelection: ModelSelection = {providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
const iso = (time = Date.now()) => new Date(time).toISOString();
const hash = (value: string) => createHash('sha256').update(value, 'ascii').digest('base64url');
const secret = 'SYNTHETIC_PROCESS_ONLY_PROVIDER_SECRET';
const output = 'SYNTHETIC_PRIVATE_PROCESS_RESULT';
export function barrier() { let release!:()=>void; const promise=new Promise<void>(r=>{release=r;}); return {promise,release}; }

/** Attach rejection handling immediately, including before the provider gate. */
export function boundedSqlSinkObservation(request:Promise<unknown>,budgetMs:number) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  const expired=new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('SQL sink observation deadline exceeded')),budgetMs);});
  return Promise.race([request,expired]).then(
    ()=>({entered:true as const}),error=>({error}),
  ).finally(()=>clearTimeout(timer));
}

/** Immutable actual filesystem bytes, shared by path across the two children. */
export function fileStore(directory: string): ObjectStore {
  const file=(key:Parameters<ObjectStore['head']>[0])=>{assertObjectKey(key);return join(directory,key.replaceAll('/','_'));};
  const read=async(key:Parameters<ObjectStore['head']>[0])=>{try{return JSON.parse(await readFile(file(key),'utf8')) as {metadata:ObjectMetadata;bytes:string};}catch(error){if((error as {code?:string}).code==='ENOENT')return null;throw error;}};
  return {putImmutable:async(key,value)=>{const pending=join(directory,'pending-'+randomUUID());await writeFile(pending,JSON.stringify({metadata:value.metadata,bytes:Buffer.from(value.bytes).toString('base64')}),{flag:'wx'});try{await link(pending,file(key));return 'created';}catch(error){if((error as {code?:string}).code==='EEXIST')return 'exists';throw error;}finally{await rm(pending,{force:true});}},head:async key=>{const v=await read(key);return v?{metadata:v.metadata}:null;},get:async(key,range)=>{const v=await read(key);if(!v)return null;let bytes=new Uint8Array(Buffer.from(v.bytes,'base64'));if(range){validateRange(range,bytes.byteLength);bytes=bytes.slice(range.offset,range.offset+range.length);}return {metadata:v.metadata,body:new ReadableStream({start(c){c.enqueue(bytes);c.close();}})};},delete:async key=>{if(!await read(key))return 'missing';await rm(file(key));return 'deleted';}};
}
async function listen(server:Server) { await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();assert(address&&typeof address==='object');return `http://127.0.0.1:${address.port}`; }
async function closeServer(server:Server) { server.closeAllConnections();await new Promise<void>((r,j)=>server.close(e=>e?j(e):r())); }
async function template(owner:Pool,schema:string,file:string,role:string,variable:string) {
  const source=(await readFile(new URL('../../deploy/cloudflare/sql/'+file,import.meta.url),'utf8')).replace(/^\\set .*$/mg,'').replaceAll('SCHEMA public','SCHEMA '+schema).replaceAll("n.nspname='public'","n.nspname='"+schema+"'").replaceAll("'public','CREATE'","'"+schema+"','CREATE'").replaceAll(':"'+variable+'"','"'+role+'"').replaceAll(":'"+variable+"'","'"+role+"'");
  const q=await owner.connect();try{const pieces=source.split('\\gexec');for(let i=0;i<pieces.length;i++){const result=await q.query(pieces[i]);if(i<pieces.length-1){const last=Array.isArray(result)?result[result.length-1]:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}}}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
}
interface ChildHandle { child:ChildProcess; logs:()=>string; request:(kind:string,value?:unknown)=>Promise<any>; close:()=>Promise<void> }
async function childProcess(kind:string,config:Record<string,unknown>):Promise<ChildHandle> {
  const child=fork(self,['--bridge-child',kind],{execArgv:['--import','tsx'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe','ipc']});
  let logs='',serial=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  child.stdout!.on('data',chunk=>{logs+=String(chunk);});child.stderr!.on('data',chunk=>{logs+=String(chunk);});
  child.on('message',(message:any)=>{const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);if(message.error)waiter.reject(new Error(message.error));else waiter.resolve(message.value);}});
  child.on('exit',()=>{for(const waiter of pending.values())waiter.reject(new Error('Fixture child exited: '+logs));pending.clear();});
  const request=(kind:string,value?:unknown)=>new Promise<any>((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});child.send({id,kind,value});});
  const handle={child,logs:()=>logs,request,close:async()=>{if(child.exitCode!==null)return;try{await request('close');}finally{child.kill();}}};
  try{await request('init',config);return handle;}catch(error){child.kill();throw error;}
}

export async function bridgeFixture() {
  const connectionString=process.env.TEST_DATABASE_URL;
  if(!connectionString||!/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))throw Error('Explicit isolated fp_* TEST_DATABASE_URL required');
  const schema=`fp_bbridge_${process.pid}_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  const roles={owner:schema+'_owner',app:schema+'_app',broker:schema+'_broker',executor:schema+'_exec'};
  const admin=new Pool({connectionString});
  const roleUrl=(role:string)=>{const url=new URL(connectionString);url.username=role;url.password='';return url.toString();};
  const pool=(role:string)=>new Pool({connectionString:roleUrl(role),options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
  const owner=pool(roles.owner),app=pool(roles.app),executor=pool(roles.executor),brokerPool=pool(roles.broker);
  const directory=await mkdtemp(join(tmpdir(),'fp-bbridge-'));
  const issuerKeys=await generateKeyPair('EdDSA',{extractable:true}),responseKeys=await generateKeyPair('EdDSA',{extractable:true}),recoveryKeys=await generateKeyPair('EdDSA',{extractable:true});
  const recovery={generation:'1',floor:'1',unavailable:false,raw:''};
  async function refreshRecovery() { const now=Date.now();recovery.raw=await new CompactSign(new TextEncoder().encode(JSON.stringify({profile:'credential-broker.recovery/v1',purpose:'credential-broker.recovery',authority:'synthetic-external-recovery',environment:'local',generation:recovery.generation,issuedAt:iso(now),expiresAt:iso(now+120000)}))).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-recovery+jws',kid:'recovery-1'}).sign(recoveryKeys.privateKey); }
  await refreshRecovery();
  const external=createServer((req,res)=>{if(recovery.unavailable){res.writeHead(503);res.end();return;}res.setHeader('Content-Type','application/json');res.end(req.url==='/signed'?JSON.stringify({signed:recovery.raw}):JSON.stringify({generation:recovery.floor,expiresAt:iso(Date.now()+120000)}));});
  const recoveryOrigin=await listen(external);
  const posts:{body:any;authorization:string|undefined}[]=[];
  let providerGate:ReturnType<typeof barrier>|undefined,providerEntered=barrier();
  const provider=createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+secret);if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic'}));return;}const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));posts.push({body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization});providerEntered.release();await providerGate?.promise;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',output:[{id:'message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:output,annotations:[]}]}],usage:{input_tokens:3,output_tokens:4,total_tokens:7}}));}catch{res.destroy();}});
  const providerOrigin=await listen(provider);
  let main:ChildHandle|undefined,broker:ChildHandle|undefined,created=false;const replicas:ChildHandle[]=[];
  const kekBytes=randomBytes(32).toString('base64');
  const common={schema,...profile,recoveryOrigin,recoveryPublicJwk:await exportJWK(recoveryKeys.publicKey),directory};
  try {
    await admin.query(Object.values(roles).map(role=>`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`).join(';')+`;CREATE SCHEMA ${schema} AUTHORIZATION ${roles.owner};GRANT USAGE ON SCHEMA ${schema} TO ${roles.app},${roles.broker},${roles.executor}`);created=true;
    await migrate(owner);await template(owner,schema,'20-runtime-grants.psql',roles.app,'runtime');await template(owner,schema,'40-credential-broker-grants.psql',roles.broker,'broker');
    await template(owner,schema,'45-model-broker-execution-grants.psql',roles.executor,'executor');
    broker=await childProcess('broker',{...common,cipherUrl:roleUrl(roles.broker),executorUrl:roleUrl(roles.executor),providerOrigin,secret,kekBytes,issuerPublicJwk:await exportJWK(issuerKeys.publicKey),responsePrivateJwk:await exportJWK(responseKeys.privateKey)});
    const brokerOrigin=await broker.request('origin');
    main=await childProcess('main',{...common,appUrl:roleUrl(roles.app),brokerOrigin,issuerPrivateJwk:await exportJWK(issuerKeys.privateKey),responsePublicJwk:await exportJWK(responseKeys.publicKey)});
  } catch(error) {await main?.close();await broker?.close();await closeServer(provider);await closeServer(external);await Promise.all([app.end(),executor.end(),brokerPool.end(),owner.end()]);if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${Object.values(roles).join(',')}`);await admin.end();await rm(directory,{recursive:true,force:true});throw error;}
  const mainOrigin=await main.request('origin');
  const options={environment:profile.environment,clientId:profile.clientId};
  const prerequisites=createExecutionPrerequisites(app,options),runs=createExecutionRuns(app),works=createPrivateWorkCommands(app,{resolvePolicy:resolvePrivateWorkPersistencePolicy});
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
    const host:BootstrapSessionHost={...options,issuerKid:'pairing-issuer',issuer:'https://issuer.example.invalid/',audience:'https://platform.example.invalid/',bootstrapUri:'https://platform.example.invalid/execution-api/v1/bootstrap',refreshUri:'https://platform.example.invalid/execution-api/v1/auth/refresh',nonceUri:'https://platform.example.invalid/execution-api/v1/auth/nonce',keys:[{kid:'pairing-issuer',purpose:'bootstrap_access',environment:'local',publicJwk:parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
    const {refreshUri:_r,nonceUri:_n,...baseHost}=host;
    const pairingHost={...baseHost,beginUri:'https://platform.example.invalid/device/begin',pollUri:'https://platform.example.invalid/device/poll',verificationUri:'https://platform.example.invalid/device',clientDisplayName:'Synthetic bridge device'};
    const pairing=await createDeviceAuthorizations(app,{host:pairingHost,signingKey:issuer.privateKey});
    const sessions=await createBootstrapSessions(app,{host,signingKey:issuer.privateKey});
    const sign=(typ:string,claims:Record<string,unknown>)=>new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({alg:'ES256',typ,jwk:publicJwk}).sign(device.privateKey);
    const clock=async()=>Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms);
    const base={client_id:options.clientId,environment:'local',runtime_kind:'agent-kit',scope:'bootstrap.status.read',htm:'POST'};
    const started=await pairing.begin({publicJwk,runtimeKind:'agent-kit',proof:await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_begin',jti:randomUUID(),iat:Math.floor(await clock()/1000),htu:pairingHost.beginUri})});
    await pairing.decide(human.actor,{key:randomUUID(),userCode:started.userCode,authorizationId:started.authorizationId,requestDigest:started.requestDigest,decision:'approve'});
    const row=(await owner.query('SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id) WHERE a.authorization_id=$1',[started.authorizationId])).rows[0];
    const challenge=createRuntimeRegistrationChallenge({challenge_id:row.challenge_id,runtime_device_id:row.runtime_device_id,owner_member_id:row.owner_user_id,owner_principal_id:row.owner_principal_id,scope_id:row.scope_id,environment:row.environment,key_thumbprint:row.key_thumbprint,nonce:row.nonce,issued_at:row.issued_at.toISOString(),expires_at:row.expires_at.toISOString()});
    const enrollmentProof=await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(device.privateKey);
    const initial=await pairing.poll({authorizationId:started.authorizationId,deviceCode:started.deviceCode,enrollmentProof,proof:await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_poll',jti:randomUUID(),iat:Math.floor(await clock()/1000),htu:pairingHost.pollUri,authorization_id:started.authorizationId,request_digest:started.requestDigest,nonce:started.nonce,device_code_hash:hash(started.deviceCode)})});
    assert.equal(initial.status,'issued');if(initial.status!=='issued')throw Error('Pairing did not issue');
    const refresh=initial.refresh;
    await sessions.refresh({familyId:refresh.familyId,refreshHandle:refresh.handle,proof:await sign('freedom-bootstrap-refresh+jwt',{purpose:'bootstrap_refresh',client_id:options.clientId,environment:'local',connection_id:initial.connectionId,family_id:refresh.familyId,generation:refresh.generation,refresh_handle_hash:hash(refresh.handle),jti:randomUUID(),iat:Math.floor(await clock()/1000),htm:'POST',htu:host.refreshUri})});
    return initial;
  }
  // Each synthetic command owns its loopback connection. Avoid global Undici
  // keep-alive reuse across controlled long SQL waits; never retry a write.
  async function post(human:Awaited<ReturnType<typeof member>>,path:string,value:unknown,headers:Record<string,string>={}) { return fetch(mainOrigin+path,{method:'POST',headers:{...human.headers,Connection:'close','Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"',...headers},body:JSON.stringify(value)}); }
  async function approved() {
    const human=await member(),initial=await paired(human);
    const work=await works.create(human.actor,{key:randomUUID(),title:'Synthetic process private work',objective:'SYNTHETIC_PROCESS_PRIVATE_OBJECTIVE'});
    const run=await runs.create(human.actor,{key:randomUUID(),workId:work.workId,expectedWorkVersion:'1'});
    const model=await prerequisites.models.create(human.actor,{key:randomUUID(),connectionId:initial.connectionId,expectedConnectionVersion:'1',selection:modelSelection});
    const grant=await prerequisites.grants.create(human.actor,{key:randomUUID(),runId:run.runId,expectedRunVersion:'1',expectedWorkVersion:'1',connectionId:initial.connectionId,expectedConnectionVersion:'1',modelConnectionId:model.modelConnectionId,expectedModelVersion:'1',consent:true});
    await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,'local',$4,$5,1,true,16384,20)`,[randomUUID(),human.context.scope.scope_id,human.context.subject_principal.principal_id,options.clientId,JSON.stringify(modelSelection)]);
    const credential=await broker!.request('seed',{actor:human.actor,modelConnectionId:model.modelConnectionId});
    const response=await post(human,'/api/v1/me/model-step-approvals',{runId:run.runId,grantId:grant.grantId,expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20});assert.equal(response.status,201,await response.clone().text());
    return {...human,initial,work,run,model,grant,credential,approval:await response.json() as any};
  }
  async function activated() {const f=await approved();const response=await post(f,'/api/v1/me/model-steps',{approvalId:f.approval.approvalId,expectedRunVersion:'1'});assert.equal(response.status,201,await response.clone().text());return {...f,step:ModelStepMetadataSchema.parse(await response.json())};}
  async function cleanup() { providerGate?.release();await Promise.all(replicas.map(p=>p.close()));await main?.close();await broker?.close();await closeServer(provider);await closeServer(external);await Promise.all([app.end(),executor.end(),brokerPool.end(),owner.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${Object.values(roles).join(',')}`);await admin.end();await rm(directory,{recursive:true,force:true}); }
  return {schema,roles,owner,app,executor,brokerPool,admin,directory,posts,main:main!,broker:broker!,mainOrigin,brokerOrigin:await broker!.request('origin'),issuerKeys,responseKeys,recovery,refreshRecovery,member,approved,activated,post,cleanup,holdProvider(){providerGate=barrier();providerEntered=barrier();return {entered:providerEntered.promise,release:providerGate.release};},async spawnReplica(){const replica=await childProcess('broker',{...common,cipherUrl:roleUrl(roles.broker),executorUrl:roleUrl(roles.executor),providerOrigin,secret,kekBytes,issuerPublicJwk:await exportJWK(issuerKeys.publicKey),responsePrivateJwk:await exportJWK(responseKeys.privateKey)});replicas.push(replica);return replica;},async restartBroker(){await broker!.close();broker=await childProcess('broker',{...common,cipherUrl:roleUrl(roles.broker),executorUrl:roleUrl(roles.executor),providerOrigin,secret,kekBytes,issuerPublicJwk:await exportJWK(issuerKeys.publicKey),responsePrivateJwk:await exportJWK(responseKeys.privateKey)});return broker;}};
}

async function fixtureChild(kind:string) {
  const sockets:{pid:number;method:string;origin:string;path:string}[]=[];
  const actualRequest=http.request;http.request=((...args:any[])=>{if(args[0] instanceof URL)sockets.push({pid:process.pid,method:args[1]?.method??'GET',origin:args[0].origin,path:args[0].pathname});return Reflect.apply(actualRequest,http,args);}) as typeof http.request;syncBuiltinESMExports();
  let requests:any[]=[],exchangeMode='normal',issuerDeadline=Infinity,objectStorePuts=0;const sqlErrors:{code:string;message:string;statement:string}[]=[];
  let sqlSink:{kind:'result'|'asset_prepare_receipt';entered:ReturnType<typeof barrier>}|undefined;
  let config:any,pools:Pool[]=[],server:Server|undefined,origin='',bridge:any,store:ObjectStore,recover:()=>Promise<any>,credentials:any,execution:any,authorization:any;
  const pool=(url:string)=>{const p=new Pool({connectionString:url,options:`-c search_path=${config.schema} -c statement_timeout=10000`,max:12});p.on('connect',client=>{const original=client.query;client.query=((...args:any[])=>{const statement=typeof args[0]==='string'?args[0].trim():'';
    if(sqlSink&&((sqlSink.kind==='result'&&statement.startsWith('INSERT INTO private_model_work_results('))||(sqlSink.kind==='asset_prepare_receipt'&&statement.startsWith('INSERT INTO scoped_command_receipts(')&&args[1]?.[3]==='asset.upload.prepare')))sqlSink.entered.release();
    const result=Reflect.apply(original,client,args);if(result&&typeof result.catch==='function')return result.catch((error:any)=>{sqlErrors.push({code:error.code??'unknown',message:error.message,statement:typeof args[0]==='string'?args[0].trim().split('\n')[0]:''});throw error;});return result;}) as typeof client.query;});pools.push(p);return p;};
  process.on('message',async(message:any)=>{try{
    let value:unknown=null;
    if(message.kind==='init') {
      config=message.value;const actualStore=fileStore(config.directory);store={...actualStore,putImmutable:async(...args)=>{objectStorePuts++;return actualStore.putImmutable(...args);}};
      const {createSignedRecoverySource}=await import('../../apps/credential-broker/src/recovery.js');
      const recoveryKey=await importJWK(config.recoveryPublicJwk,'EdDSA') as CryptoKey;
      const signedRecover=createSignedRecoverySource({authority:'synthetic-external-recovery',environment:'local',pinnedKeys:[{keyId:'recovery-1',key:recoveryKey}],readSignedState:async()=>{const r=await fetch(config.recoveryOrigin+'/signed');if(!r.ok)throw Error('unavailable');return (await r.json() as any).signed;},readMonotonicFloor:async()=>{const r=await fetch(config.recoveryOrigin+'/floor');if(!r.ok)throw Error('unavailable');return await r.json();}}).recover;
      // Main test port may conservatively narrow a genuinely signed external
      // observation for command issuance; broker still sees its full lifetime.
      recover=kind==='main'?async()=>{const observed=await signedRecover();return {...observed,expiresAt:iso(Math.min(Date.parse(observed.expiresAt),issuerDeadline))};}:signedRecover;
      const {createModelBrokerAuthorizations}=await import('../../modules/agent-control/model-broker-authorizations.js');
      if(kind==='broker') {
        const cipher=pool(config.cipherUrl),executor=pool(config.executorUrl);
        const {createCredentialVault}=await import('../../apps/credential-broker/src/vault.js');
        const {createBrokerCredentialStore}=await import('../../apps/credential-broker/src/store.js');
        const rawKey=Buffer.from(config.kekBytes,'base64');const key=await crypto.subtle.importKey('raw',rawKey,{name:'AES-GCM'},false,['encrypt','decrypt']);rawKey.fill(0);
        const vault=createCredentialVault({kek:{current:async()=>({keyId:'child-synthetic-kek',key}),readById:async id=>id==='child-synthetic-kek'?key:null},recover});
        credentialsVaultSeal=async binding=>{const bytes=new TextEncoder().encode(config.secret);try{return await vault.seal(binding,bytes);}finally{bytes.fill(0);}};
        credentials=createBrokerCredentialStore(cipher,{environment:profile.environment,clientId:profile.clientId,vault,recover,credentialTtlSeconds:120});
        authorization=createModelBrokerAuthorizations(executor,{...profile,recover});
        const {createBrokerModelExecution}=await import('../../apps/credential-broker/src/execution.js');
        execution=createBrokerModelExecution({cipherPool:cipher,executorPool:executor,...profile,vault,recover,store,authorizations:authorization,fixtureOrigin:config.providerOrigin});
        const {createBrokerBridge}=await import('../../apps/credential-broker/src/bridge.js');
        bridge=await createBrokerBridge({...profile,requestAudience:profile.audience,brokerId:'synthetic-broker',responseAudience:'synthetic-main',requestKeys:new Map([['main-1',await importJWK(config.issuerPublicJwk,'EdDSA') as CryptoKey]]),responseSigningKey:await importJWK(config.responsePrivateJwk,'EdDSA') as CryptoKey,responseKeyId:'broker-1',authorizations:authorization,execution});
        const {createBrokerBridgeProcessServer}=await import('../../apps/credential-broker/src/process.js');
        // Bind the production fixed-path request handler to an already pinned
        // loopback origin; no provider endpoint is present in its wire request.
        const reservation=createServer();origin=await listen(reservation);const port=Number(new URL(origin).port);await closeServer(reservation);server=createBrokerBridgeProcessServer({origin,bridge});await new Promise<void>(r=>server!.listen(port,'127.0.0.1',r));
      } else {
        assert(!('secret' in config));assert(!('providerOrigin' in config));assert(!('cipherUrl' in config));assert(!('responsePrivateJwk' in config));
        const app=pool(config.appUrl);authorization=createModelBrokerAuthorizations(app,{...profile,recover});
        // Root integrates the reference-only product assembly; exact signature
        // is fixed before this fixture is considered executable evidence.
        const {createPrivateAiProductTransport,bindPrivateAiProductTransport}=await import('../../apps/platform-api/src/private-ai-product.js');
        // Origin is fixed after listening, then production product handles each
        // real streamed HTTP request (cookie+CSRF included).
        let handler:(r:Request)=>Promise<Response>;
        server=createServer(async(req,res)=>{try{const headers=new Headers();for(const [k,v] of Object.entries(req.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(','):v);const request=new Request(origin+req.url,{method:req.method,headers,...(['GET','HEAD'].includes(req.method!)?{}:{body:Readable.toWeb(req),duplex:'half'})} as RequestInit);const response=await handler(request);res.writeHead(response.status,Object.fromEntries(response.headers));res.end(Buffer.from(await response.arrayBuffer()));}catch{res.writeHead(500);res.end('{}');}});
        origin=await listen(server);
        const {createModelBrokerClient}=await import('../../apps/platform-api/src/model-broker-client.js');
        const port=await createModelBrokerClient(app,{origin,environment:'local',clientId:profile.clientId,issuer:profile.issuer,audience:profile.audience,requestKid:'main-1',requestKey:await importJWK(config.issuerPrivateJwk,'EdDSA') as CryptoKey,responseKeys:new Map([['broker-1',await importJWK(config.responsePublicJwk,'EdDSA') as CryptoKey]]),brokerIdentity:'synthetic-broker',responseAudience:'synthetic-main',recover,exchange:async (request:ModelBrokerRequest)=>{requests.push(request);const response=await fetch(config.brokerOrigin+'/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json',Connection:'close'},body:JSON.stringify(request)});if(!response.ok)throw Error('Broker unavailable');const envelope=await response.json() as any;if(exchangeMode==='dropNext'){exchangeMode='normal';throw Error('Synthetic ACK loss after actual broker response');}if(exchangeMode==='tamperNext'){exchangeMode='normal';envelope.response=envelope.response.slice(0,-1)+(envelope.response.endsWith('A')?'B':'A');}return envelope;}});
        const product=await createPrivateAiProductTransport(app,{origin,environment:'local',clientId:profile.clientId,broker:port,store} as never);
        handler=bindPrivateAiProductTransport(product,app,origin,'local');
      }
      value={pid:process.pid};
    } else if(message.kind==='origin')value=origin;
    else if(message.kind==='seed') {
      assert.equal(kind,'broker');const {getCredentialWriteBinding}=await import('../../apps/credential-broker/src/store.js');
      // Fixture-only IPC seed receives the Actor from the genuine parent login;
      // store.prepare/commit independently recheck that original SQL session.
      const actor=message.value.actor as Actor;
      const intent=await credentials.prepareCreate(actor,{key:randomUUID(),modelConnectionId:message.value.modelConnectionId,expectedModelVersion:'1',consent:true});
      const binding=getCredentialWriteBinding(intent);
      // Same vault instance as execution is retrieved from its owned store.
      // This test-only operation is IPC, never a public broker request route.
      value=await credentials.commit(actor,intent,await credentialsVaultSeal(binding));
    } else if(message.kind==='handle')value=await bridge.handle(message.value);
    else if(message.kind==='fake')value=await execution.run(message.value,false);
    else if(message.kind==='requests')value=requests;
    else if(message.kind==='sockets')value=sockets;
    else if(message.kind==='storeCounts')value={puts:objectStorePuts};
    else if(message.kind==='sqlErrors')value=sqlErrors;
    // Test-only observation at the actual restricted client's SQL submission.
    // It changes neither the query, transaction, deadline nor execution order.
    else if(message.kind==='observeSqlSink'){assert.equal(kind,'broker');assert(['result','asset_prepare_receipt'].includes(message.value));sqlSink={kind:message.value,entered:barrier()};value=true;}
    else if(message.kind==='sqlSinkEntered'){assert(sqlSink);await sqlSink.entered.promise;value=true;}
    else if(message.kind==='issuerDeadline'){issuerDeadline=message.value;value=true;}
    else if(message.kind==='exchangeMode'){exchangeMode=message.value;value=true;}
    else if(message.kind==='issue'){const actor=await authenticate(pools[0],message.value.token);const payload=await authorization.issue(actor,{operation:message.value.command.operation,command:message.value.command,nonce:message.value.nonce});const key=await importJWK(config.issuerPrivateJwk,'EdDSA') as CryptoKey;value={payload,request:{authorizationRef:payload.authorizationRef,nonce:payload.nonce,assertion:await new CompactSign(new TextEncoder().encode(JSON.stringify(payload))).setProtectedHeader({alg:'EdDSA',typ:'freedom-model-broker-assertion+jws',kid:'main-1'}).sign(key)}};}
    else if(message.kind==='keys')value={configKeys:Object.keys(config).sort(),envKeys:Object.keys(process.env).sort(),pid:process.pid};
    else if(message.kind==='close'){if(server)await closeServer(server);await Promise.all(pools.map(p=>p.end()));value=true;}
    else throw Error('Unknown fixture message');
    process.send!({id:message.id,value});
  }catch(error){process.send!({id:message.id,error:error instanceof Error?error.message:'Fixture failure'});}});
  let credentialsVaultSeal:(binding:any)=>Promise<any>;
}

if(process.argv.includes('--bridge-child'))await fixtureChild(process.argv.at(-1)!);
else if(resolve(process.argv[1]??'')===self)test('BROKER-PROCESS real two-child signed member closed loop publishes exactly one file-backed private model Result',async()=>{
  const f=await bridgeFixture();try{
    const member=await f.activated();assert.equal(f.posts.length,0);
    const response=await f.post(member,`/api/v1/me/model-steps/${member.step.stepId}:execute`,{});assert.equal(response.status,200,JSON.stringify({response:await response.clone().text(),posts:f.posts.length,sqlErrors:await f.broker.request('sqlErrors'),steps:(await f.owner.query('SELECT state FROM model_text_steps')).rows}));
    const step=ModelStepMetadataSchema.parse(await response.json());assert.equal(step.state,'succeeded');assert.equal(step.operational_authority,false);assert.equal(step.evidenceOrigin,'synthetic_local_fixture');
    assert.equal(f.posts.length,1);assert.equal((await readdir(f.directory)).length,1);const envelope=(await f.brokerPool.query('SELECT envelope FROM broker_credential_vault')).rows[0].envelope;assert(!JSON.stringify(envelope).includes(secret));assert.equal(member.credential.operational_authority,false);
    assert.equal((await f.owner.query('SELECT count(*)::int n FROM private_model_work_results')).rows[0].n,1);
    const results=createPrivateResultService(f.app,{store:fileStore(f.directory),resolvePolicy:resolvePrivateWorkPersistencePolicy});const result=await results.readCurrent(member.actor,{workId:member.work.workId});assert(result);assert.equal(result.text,output);assert.equal(result.provenance,'model');assert.equal(result.aggregateVersion,'2');assert.equal(result.model?.evidenceOrigin,'synthetic_local_fixture');
    const foreign=await f.member();await assert.rejects(results.readCurrent(foreign.actor,{workId:member.work.workId}));
    const mainKeys=await f.main.request('keys');assert.notEqual(mainKeys.pid,process.pid);assert.notEqual(mainKeys.pid,(await f.broker.request('keys')).pid);for(const forbidden of ['secret','kekBytes','cipherUrl','providerOrigin','responsePrivateJwk'])assert(!mainKeys.configKeys.includes(forbidden));
    for(const p of [f.app,f.executor,f.brokerPool]) {const role=(await p.query('SELECT rolsuper,rolbypassrls,rolinherit FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(role,{rolsuper:false,rolbypassrls:false,rolinherit:false});}
    for(const p of [f.app,f.executor])for(const sql of ['SELECT * FROM broker_credential_vault','SELECT envelope FROM broker_credential_vault',`SET ROLE ${f.roles.broker}`,`SET ROLE ${f.roles.owner}`])await assert.rejects(p.query(sql),(e:any)=>e.code==='42501');
    const wire=JSON.stringify(await f.main.request('requests'));for(const value of [secret,Buffer.from(secret).toString('base64'),'SYNTHETIC_PROCESS_PRIVATE_OBJECTIVE',output])assert(!(f.main.logs()+wire+JSON.stringify(step)).includes(value));
    const brokerSockets=await f.broker.request('sockets');assert.equal(brokerSockets.filter((s:any)=>s.method==='POST'&&s.path==='/v1/responses').length,1);assert(brokerSockets.every((s:any)=>s.pid===(f.broker.child.pid)));assert.deepEqual(await f.main.request('sockets'),[]);
    assert.deepEqual(f.posts[0].body.tools,[]);assert.equal(f.posts[0].body.model,'synthetic-model');
  }finally{await f.cleanup();}
});
