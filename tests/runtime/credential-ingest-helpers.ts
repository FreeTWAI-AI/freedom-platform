// @ts-expect-error Canonical tooling is JavaScript without a declaration file.
import {createIngestBrowserDiagnostic} from '../../packages/contribution-tools/test-failure-diagnostic.mjs';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID, randomBytes, X509Certificate } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as tlsRequest } from 'node:https';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium,type Browser,type BrowserContext,type Page,type Request as BrowserRequest,type Response as BrowserResponse } from '@playwright/test';
import {profile,fileStore,listen,closeServer} from './credential-ingest-fixtures/shared.js';
import { CompactSign, exportJWK, generateKeyPair } from 'jose';
import { Pool } from 'pg';
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
import type { BootstrapSessionHost } from '../../contracts/execution/v1/bootstrap-session.js';
import type { ModelSelection } from '../../contracts/execution/v1/member-execution.js';
import { ModelStepMetadataSchema } from '../../contracts/execution/v2/model-step.js';


/** Exact fixture routes only; never read URLs into diagnostics or inspect bodies. */
export function observeIngestBrowserPage(page:Page,setupOrigin:string,diagnostic:{observe(kind:string,event:string,status?:number):void}){
 const kind=(r:BrowserRequest)=>r.method()==='POST'?(r.url()===setupOrigin+'/credential-setup/prepare'?'prepare':r.url()===setupOrigin+'/credential-setup/secret'?'secret':null):null;
 const request=(r:BrowserRequest)=>{const k=kind(r);if(k)diagnostic.observe(k,'request');};
 const response=(r:BrowserResponse)=>{const k=kind(r.request());if(k)diagnostic.observe(k,'response',r.status());};
 const failed=(r:BrowserRequest)=>{const k=kind(r);if(k)diagnostic.observe(k,'failed');};
 page.on('request',request);page.on('response',response);page.on('requestfailed',failed);
 return()=>{page.off('request',request);page.off('response',response);page.off('requestfailed',failed);};
}

/** Failure-only snapshot, not proof that the attempted command committed. */
export async function readIngestCustodyDiagnostic(connectionString:string,schema:string,modelConnectionId:string){
 const pool=new Pool({connectionString,max:1,connectionTimeoutMillis:1000,query_timeout:1000,
  options:`-c search_path=${schema} -c statement_timeout=1000 -c default_transaction_read_only=on`});
 try{const n=(await pool.query("SELECT count(*)::int n FROM (SELECT 1 FROM broker_model_credentials WHERE model_connection_id=$1 AND state='active' LIMIT 2) c",[modelConnectionId])).rows[0]?.n;
  return n===0?'absent':n===1?'one_active':n===2?'multiple_active':'unavailable';
 }catch{return 'unavailable';}finally{await pool.end().catch(()=>{});}
}

const iso=(time=Date.now())=>new Date(time).toISOString();
const hash=(value:string)=>createHash('sha256').update(value,'ascii').digest('base64url');
const modelSelection:ModelSelection={providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
export function barrier(){let release!:()=>void;const promise=new Promise<void>(r=>{release=r;});return {promise,release};}
export async function template(owner:Pool,schema:string,file:string,role:string,variable:string) {
  const source=(await readFile(new URL('../../deploy/cloudflare/sql/'+file,import.meta.url),'utf8')).replace(/^\\set .*$/mg,'').replaceAll('SCHEMA public','SCHEMA '+schema).replaceAll("n.nspname='public'","n.nspname='"+schema+"'").replaceAll("'public','CREATE'","'"+schema+"','CREATE'").replaceAll(':"'+variable+'"','"'+role+'"').replaceAll(":'"+variable+"'","'"+role+"'");
  const q=await owner.connect();try{const pieces=source.split('\\gexec');for(let i=0;i<pieces.length;i++){const result=await q.query(pieces[i]);if(i<pieces.length-1){const last=Array.isArray(result)?result[result.length-1]:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}}}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
}
export interface ChildHandle { child:ChildProcess; logs:()=>string; request:(kind:string,value?:unknown)=>Promise<any>; close:()=>Promise<void> }
async function childProcess(kind:string,config:Record<string,unknown>):Promise<ChildHandle> {
  const child=fork(fileURLToPath(new URL('./credential-ingest-fixtures/'+kind+'-child.ts',import.meta.url)),[],{execArgv:['--import','tsx'],env:{PATH:process.env.PATH,LANG:'C.UTF-8'},stdio:['ignore','pipe','pipe','ipc']});
  let logs='',serial=0;const pending=new Map<number,{resolve:(v:any)=>void;reject:(e:Error)=>void}>();
  child.stdout!.on('data',chunk=>{logs+=String(chunk);});child.stderr!.on('data',chunk=>{logs+=String(chunk);});
  child.on('message',(message:any)=>{const waiter=pending.get(message.id);if(waiter){pending.delete(message.id);if(message.error)waiter.reject(new Error(message.error));else waiter.resolve(message.value);}});
  child.on('exit',()=>{for(const waiter of pending.values())waiter.reject(new Error('Fixture child exited: '+logs));pending.clear();});
  const request=(kind:string,value?:unknown)=>new Promise<any>((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject});child.send({id,kind,value});});
  const handle={child,logs:()=>logs,request,close:async()=>{if(child.exitCode!==null)return;try{await request('close');}finally{child.kill();}}};
  try{await request('init',config);return handle;}catch(error){child.kill();throw error;}
}


const fixtureCertificates = new Map<string,string>();

/** Native HTTPS trusts only the certificate belonging to this fixture origin. */
export async function httpsFetch(url:string,options:{method?:string;headers?:Record<string,string>;body?:string|Uint8Array}={}) {
  const target=new URL(url),ca=fixtureCertificates.get(target.origin);if(!ca)throw Error('No trusted fixture certificate for '+target.origin);return new Promise<Response>((resolve,reject)=>{const req=tlsRequest({hostname:'127.0.0.1',port:target.port,servername:target.hostname,ca,path:target.pathname+target.search,method:options.method??'GET',headers:{Host:target.host,...options.headers}},res=>{const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>{const headers=new Headers();for(const [key,value]of Object.entries(res.headers))if(value!==undefined)for(const val of Array.isArray(value)?value:[value])headers.append(key,val);resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers}));});});req.on('error',reject);req.end(options.body);});
}
export async function ingestFixture() {
  const connectionString=process.env.TEST_DATABASE_URL;
  if(!connectionString||!/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))throw Error('Explicit isolated fp_* TEST_DATABASE_URL required');
  const secret='SYNTHETIC_DIRECT_INGEST_KEY_'+randomUUID().replaceAll('-','');
  const output='SYNTHETIC_DIRECT_INGEST_MODEL_OUTPUT';
  const schema=`fp_ingest_${process.pid}_${Date.now()}_${Math.floor(Math.random()*10000)}`;
  const roles={owner:schema+'_owner',app:schema+'_app',broker:schema+'_broker',executor:schema+'_exec'};
  const admin=new Pool({connectionString});
  const roleUrl=(role:string)=>{const url=new URL(connectionString);url.username=role;url.password='';return url.toString();};
  const pool=(role:string)=>new Pool({connectionString:roleUrl(role),options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
  const owner=pool(roles.owner),app=pool(roles.app),executor=pool(roles.executor),brokerPool=pool(roles.broker);
  const directory=await mkdtemp(join(tmpdir(),'fp-ingest-'));
  const ingestKeys=await generateKeyPair('EdDSA',{extractable:true});
  const issuerKeys=await generateKeyPair('EdDSA',{extractable:true}),responseKeys=await generateKeyPair('EdDSA',{extractable:true}),recoveryKeys=await generateKeyPair('EdDSA',{extractable:true});
  const recovery={generation:'1',floor:'1',unavailable:false,raw:''};
  async function refreshRecovery() { const now=Date.now();recovery.raw=await new CompactSign(new TextEncoder().encode(JSON.stringify({profile:'credential-broker.recovery/v1',purpose:'credential-broker.recovery',authority:'synthetic-external-recovery',environment:'local',generation:recovery.generation,issuedAt:iso(now),expiresAt:iso(now+120000)}))).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-recovery+jws',kid:'recovery-1'}).sign(recoveryKeys.privateKey); }
  await refreshRecovery();
  const external=createServer(async(req,res)=>{if(req.url?.match(/^\/(capture|sign)\//)){const ref=req.url.split('/').at(-1);const row=(await owner.query('SELECT original_session_hash,submission_claimed_at,committed_at FROM credential_ingest_authorizations WHERE authorization_id=$1',[ref])).rows[0];if(req.url.startsWith('/sign/')?row?.committed_at:row?.submission_claimed_at)await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[row.original_session_hash]);res.end('{}');return;}if(recovery.unavailable){res.writeHead(503);res.end();return;}res.setHeader('Content-Type','application/json');res.end(req.url==='/signed'?JSON.stringify({signed:recovery.raw}):JSON.stringify({generation:recovery.floor,expiresAt:iso(Date.now()+120000)}));});
  const recoveryOrigin=await listen(external);
  const posts:{body:any;authorization:string|undefined}[]=[];
  let providerGate:ReturnType<typeof barrier>|undefined,providerEntered=barrier();
  const provider=createServer(async(req,res)=>{try{assert.equal(req.headers.authorization,'Bearer '+secret);if(req.method==='GET'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-model',object:'model',created:0,owned_by:'synthetic'}));return;}const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));posts.push({body:JSON.parse(Buffer.concat(chunks).toString()),authorization:req.headers.authorization});providerEntered.release();await providerGate?.promise;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({id:'synthetic-response',object:'response',model:'synthetic-model',status:'completed',output:[{id:'message',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:output,annotations:[]}]}],usage:{input_tokens:3,output_tokens:4,total_tokens:7}}));}catch{res.destroy();}});
  const providerOrigin=await listen(provider);
  let main:ChildHandle|undefined,broker:ChildHandle|undefined,created=false;const replicas:ChildHandle[]=[];
  const kekBytes=randomBytes(32).toString('base64');
  const tlsDirectory=await mkdtemp(join(tmpdir(),'fp-ingest-tls-'));
  const execute=promisify(execFile);
  await execute('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-keyout',join(tlsDirectory,'key.pem'),'-out',join(tlsDirectory,'cert.pem'),'-subj','/CN=broker.test','-addext','subjectAltName=DNS:broker.test,DNS:platform.test']);
  const tls={key:await readFile(join(tlsDirectory,'key.pem'),'utf8'),cert:await readFile(join(tlsDirectory,'cert.pem'),'utf8')};
  async function reservedOrigin(host:string){const server=createServer();const origin=await listen(server);await closeServer(server);return `https://${host}:${new URL(origin).port}`;}
  const mainOrigin=await reservedOrigin('platform.test'),setupOrigin=await reservedOrigin('broker.test');
  fixtureCertificates.set(mainOrigin,tls.cert);fixtureCertificates.set(setupOrigin,tls.cert);
  const certificatePin=createHash('sha256').update(new X509Certificate(tls.cert).publicKey.export({type:'spki',format:'der'})).digest('base64');
  let browser:Browser|undefined;const contexts:BrowserContext[]=[];
  const common={schema,...profile,recoveryOrigin,recoveryPublicJwk:await exportJWK(recoveryKeys.publicKey),directory,tls,mainOrigin,setupOrigin};
  const brokerConfig={...common,cipherUrl:roleUrl(roles.broker),executorUrl:roleUrl(roles.executor),providerOrigin,kekBytes,executionPublicJwk:await exportJWK(issuerKeys.publicKey),ingestPublicJwk:await exportJWK(ingestKeys.publicKey),responsePrivateJwk:await exportJWK(responseKeys.privateKey)};
  try {
    await admin.query(Object.values(roles).map(role=>`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`).join(';')+`;CREATE SCHEMA ${schema} AUTHORIZATION ${roles.owner};GRANT USAGE ON SCHEMA ${schema} TO ${roles.app},${roles.broker},${roles.executor}`);created=true;
    await migrate(owner);await template(owner,schema,'20-runtime-grants.psql',roles.app,'runtime');await template(owner,schema,'40-credential-broker-grants.psql',roles.broker,'broker');
    await template(owner,schema,'45-model-broker-execution-grants.psql',roles.executor,'executor');
    broker=await childProcess('broker',brokerConfig);
    const brokerInternalOrigin=await broker.request('origin');
    main=await childProcess('main',{...common,appUrl:roleUrl(roles.app),brokerInternalOrigin,executionPrivateJwk:await exportJWK(issuerKeys.privateKey),ingestPrivateJwk:await exportJWK(ingestKeys.privateKey),responsePublicJwk:await exportJWK(responseKeys.publicKey)});
  } catch(error) {fixtureCertificates.delete(mainOrigin);fixtureCertificates.delete(setupOrigin);await main?.close();await broker?.close();await closeServer(provider);await closeServer(external);await Promise.all([app.end(),executor.end(),brokerPool.end(),owner.end()]);if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${Object.values(roles).join(',')}`);await admin.end();await rm(directory,{recursive:true,force:true});await rm(tlsDirectory,{recursive:true,force:true});throw error;}
  const executionOrigin=await main.request('executionOrigin');
  const options={environment:profile.environment,clientId:profile.clientId};
  const prerequisites=createExecutionPrerequisites(app,options),runs=createExecutionRuns(app),works=createPrivateWorkCommands(app,{resolvePolicy:resolvePrivateWorkPersistencePolicy});
  async function member() {
    const user=randomUUID(),community=randomUUID(),email=user+'@example.invalid';
    await owner.query("INSERT INTO communities VALUES($1,'Synthetic process community')",[community]);
    await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic process owner',$4,$5)`,[user,community,email,await hashPasswordAsync('synthetic-password-only'),randomUUID()]);
    const session=await login(app,email,'synthetic-password-only');const actor=await authenticate(app,session.token);
    const context=await withMemberScope(app,{actor,scope:'personal'},async()=>{},async(_q,c)=>c);
    await owner.query(`INSERT INTO private_work_persistence_policy(scope_id,purpose,owner_principal_id,revision,persistence_allowed,retained_byte_limit) VALUES($1,'work.private-draft',$2,1,true,10485760)`,[context.scope.scope_id,context.subject_principal.principal_id]);
    return {actor,context,token:session.token,headers:{Cookie:'freedom_local_session='+session.token,'X-CSRF-Token':actor.csrf_token,Origin:executionOrigin}};
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
  async function post(human:Awaited<ReturnType<typeof member>>,path:string,value:unknown,headers:Record<string,string>={}) { return fetch(executionOrigin+path,{method:'POST',headers:{...human.headers,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"',...headers},body:JSON.stringify(value)}); }
  async function issue(human:Awaited<ReturnType<typeof member>>,modelConnectionId:string,headers:Record<string,string>={}) {
    return httpsFetch(mainOrigin+'/api/v1/me/credential-ingests',{method:'POST',headers:{...human.headers,Origin:mainOrigin,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"',...headers},body:JSON.stringify({operation:'create',modelConnectionId,consent:true})});
  }
  async function browserContext(human:Awaited<ReturnType<typeof member>>) {
    browser??=await chromium.launch({headless:true,args:['--ignore-certificate-errors-spki-list='+certificatePin,'--host-resolver-rules=MAP platform.test 127.0.0.1, MAP broker.test 127.0.0.1','--no-proxy-server']});
    const context=await browser.newContext();contexts.push(context);
    await context.route('**/*',route=>{const origin=new URL(route.request().url()).origin;return [mainOrigin,setupOrigin].includes(origin)?route.continue():route.abort();});
    await context.addCookies([{name:'freedom_local_session',value:human.token,domain:'platform.test',path:'/',secure:true,httpOnly:true,sameSite:'Strict'}]);
    return context;
  }
  async function navigateSetup(context:BrowserContext,assertion:string,diagnostic?:{phase(value:string):void}) {
    const page=await context.newPage();diagnostic?.phase('navigation_blank');await page.goto(mainOrigin+'/__fixture_blank');
    diagnostic?.phase('navigation_submit');await page.evaluate(({setupOrigin,assertion})=>{const form=document.createElement('form');form.method='POST';form.action=setupOrigin+'/credential-setup';const input=document.createElement('input');input.name='assertion';input.value=assertion;form.append(input);document.body.append(form);form.submit();},{setupOrigin,assertion});
    diagnostic?.phase('navigation_wait');await page.waitForURL(setupOrigin+'/credential-setup');return page;
  }
  async function ingestBrowser(human:Awaited<ReturnType<typeof member>>,modelConnectionId:string) {
    const diagnostic=createIngestBrowserDiagnostic();let context:BrowserContext|undefined;const detach:(()=>void)[]=[];
    const watch=(page:Page)=>{detach.push(observeIngestBrowserPage(page,setupOrigin,diagnostic));};
    try{
    // Browser startup is fixture preparation, not part of the signed setup lifetime.
    context=await browserContext(human);context.on('page',watch);
    diagnostic.phase('issue');const response=await issue(human,modelConnectionId);assert.equal(response.status,201,await response.clone().text());const bootstrap=await response.json() as any;
    const page=await navigateSetup(context,bootstrap.assertion,diagnostic);
    diagnostic.phase('screenshot');if(process.env.INGEST_SCREENSHOT_DIR){await mkdir(process.env.INGEST_SCREENSHOT_DIR,{recursive:true});for(const width of [390,768,1440]){await page.setViewportSize({width,height:1000});await page.screenshot({path:join(process.env.INGEST_SCREENSHOT_DIR,`protected-setup-${width}.png`),fullPage:true});}}
    diagnostic.phase('key_fill');await page.locator('#credential-key').fill(secret);diagnostic.phase('consent_check');await page.locator('#credential-consent').check();diagnostic.phase('submit_click');await page.locator('#credential-submit').click();
    // This success helper expects the browser's actual broker acknowledgement.
    // Owner polling shares the real execution_member quota with approve/activate/
    // execute; racing up to 100 reads can exhaust 60/min before execution starts.
    diagnostic.phase('ack_wait');await page.locator('#credential-status').filter({hasText:'已收到設定服務回覆'}).waitFor({timeout:10000});
    diagnostic.phase('owner_read');const read=await httpsFetch(mainOrigin+'/api/v1/me/credential-ingests/'+bootstrap.authorizationRef,{headers:{...human.headers,Origin:mainOrigin}});
    assert.equal(read.status,200);const outcome:any=await read.json();
    diagnostic.phase('owner_assert');assert.equal(outcome?.state,'committed',JSON.stringify({outcome,status:await page.locator('#credential-status').textContent(),sqlErrors:await broker!.request('sqlErrors'),broker:await broker!.request('snapshot')}));
    diagnostic.phase('page_close');await page.close();return outcome.credential;
    }catch(error){
      // One failure-only local fixture observation, never owner HTTP polling or
      // raw SQL/error output. MVCC reads do not wait for pending row writers.
      diagnostic.custody(await readIngestCustodyDiagnostic(roleUrl(roles.owner),schema,modelConnectionId));
      throw diagnostic.annotate(error);
    }finally{context?.off('page',watch);for(const remove of detach)remove();}
  }
  async function configured() { const human=await member(),initial=await paired(human);const model=await prerequisites.models.create(human.actor,{key:randomUUID(),connectionId:initial.connectionId,expectedConnectionVersion:'1',selection:modelSelection});return {...human,initial,model}; }
  async function approved() {
    const human=await member(),initial=await paired(human);
    const work=await works.create(human.actor,{key:randomUUID(),title:'Synthetic process private work',objective:'SYNTHETIC_PROCESS_PRIVATE_OBJECTIVE'});
    const run=await runs.create(human.actor,{key:randomUUID(),workId:work.workId,expectedWorkVersion:'1'});
    const model=await prerequisites.models.create(human.actor,{key:randomUUID(),connectionId:initial.connectionId,expectedConnectionVersion:'1',selection:modelSelection});
    const grant=await prerequisites.grants.create(human.actor,{key:randomUUID(),runId:run.runId,expectedRunVersion:'1',expectedWorkVersion:'1',connectionId:initial.connectionId,expectedConnectionVersion:'1',modelConnectionId:model.modelConnectionId,expectedModelVersion:'1',consent:true});
    await owner.query(`INSERT INTO model_inference_export_policy(policy_id,scope_id,owner_principal_id,environment,client_id,selection,revision,export_allowed,max_prompt_bytes,max_output_tokens) VALUES($1,$2,$3,'local',$4,$5,1,true,16384,20)`,[randomUUID(),human.context.scope.scope_id,human.context.subject_principal.principal_id,options.clientId,JSON.stringify(modelSelection)]);
    const credential=await ingestBrowser(human,model.modelConnectionId);
    const response=await post(human,'/api/v1/me/model-step-approvals',{runId:run.runId,grantId:grant.grantId,expectedGrantVersion:'1',expectedWorkVersion:'1',consent:true,maxOutputTokens:20});assert.equal(response.status,201,await response.clone().text());
    return {...human,initial,work,run,model,grant,credential,approval:await response.json() as any};
  }
  async function activated() {const f=await approved();const response=await post(f,'/api/v1/me/model-steps',{approvalId:f.approval.approvalId,expectedRunVersion:'1'});assert.equal(response.status,201,await response.clone().text());return {...f,step:ModelStepMetadataSchema.parse(await response.json())};}
  async function cleanup() { fixtureCertificates.delete(mainOrigin);fixtureCertificates.delete(setupOrigin);providerGate?.release();await Promise.all(contexts.map(c=>c.close()));await browser?.close();await Promise.all(replicas.map(p=>p.close()));await main?.close();await broker?.close();await closeServer(provider);await closeServer(external);await Promise.all([app.end(),executor.end(),brokerPool.end(),owner.end()]);await admin.query(`DROP SCHEMA ${schema} CASCADE;DROP ROLE ${Object.values(roles).join(',')}`);await admin.end();await rm(directory,{recursive:true,force:true});await rm(tlsDirectory,{recursive:true,force:true}); }
  return {schema,roles,owner,app,executor,brokerPool,admin,directory,secret,output,posts,main:main!,broker:broker!,mainOrigin,setupOrigin,executionOrigin,recoveryOrigin,issuerKeys,ingestKeys,responseKeys,recovery,refreshRecovery,member,paired,configured,issue,browserContext,navigateSetup,ingestBrowser,approved,activated,post,cleanup,async restartBroker(){await broker!.close();broker=await childProcess('broker',brokerConfig);return broker;},async spawnReplica(){const replica=await childProcess('broker',{...brokerConfig,listenSetup:false});replicas.push(replica);return replica;},holdProvider(){providerGate=barrier();providerEntered=barrier();return {entered:providerEntered.promise,release:providerGate.release};}};
}
