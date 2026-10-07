import {chromium,type Browser,type BrowserContext,type Page} from '@playwright/test';
import {serveStatic} from '@hono/node-server/serve-static';
import {X509Certificate} from 'node:crypto';
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID, randomBytes, sign, type KeyObject } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer, request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { getRequestListener } from '@hono/node-server';
import { Pool } from 'pg';
import { z } from 'zod';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
// @ts-expect-error Shared dependency-free verifier environment is implemented in JS.
import { verificationEnvironment } from '../../packages/contribution-tools/process-env.mjs';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { parseRuntimePublicJwk } from '../../modules/agent-control/runtime-proof.js';
import { DeviceAuthorizationBeginResultSchema, DeviceAuthorizationPollResultSchema,
  type DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';
import { BootstrapNonceSchema } from '../../contracts/execution/v1/bootstrap-status.js';
import { createPrivateAiProductTransport } from '../../apps/platform-api/src/private-ai-product.js';
import { createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_device_browser_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({connectionString});
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema} -c statement_timeout=10000`});
const app = new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
let created = false;
let transport:{request:typeof trustedRequest}, signingKey: CryptoKey;
let origin = 'https://device.test';
let tlsServer:ReturnType<typeof createServer>,browser:Browser,certificate:string,tlsDirectory:string;
const contexts:BrowserContext[]=[];
const clientLogs=new WeakMap<Page,string[]>();
const pageErrors=new WeakMap<Page,string[]>();
let modelHostCalls=0;
const paths = {begin:'/execution-api/v1/auth/device-authorizations',token:'/execution-api/v1/auth/token',nonce:'/execution-api/v1/auth/nonce',
  status:'/execution-api/v1/bootstrap',inspect:'/api/v1/me/device-authorizations/inspect',decide:'/api/v1/me/device-authorizations/decide',list:'/api/v1/me/agent-connections'};
const issuer = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
const host: DeviceAuthorizationHost = {environment:'staging-next',clientId:'mounted-bootstrap-synthetic',issuer:'https://issuer.example.invalid/',audience:origin+'/',
  bootstrapUri:origin+paths.status,beginUri:origin+paths.begin,pollUri:origin+paths.token,verificationUri:origin+'/device',clientDisplayName:'Synthetic client',
  issuerKid:'synthetic-issuer',keys:[{kid:'synthetic-issuer',purpose:'bootstrap_access',environment:'staging-next',publicJwk:parseRuntimePublicJwk(issuer.publicKey.export({format:'jwk'})),
    notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
before(async () => {
  await admin.query(`CREATE ROLE ${migrator} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE SCHEMA ${schema} AUTHORIZATION ${migrator}; GRANT USAGE ON SCHEMA ${schema} TO ${runtime}`);
  created=true; await migrate(owner);
  const template = await readFile(new URL('../../deploy/cloudflare/sql/20-runtime-grants.psql',import.meta.url),'utf8');
  const prefix = template.slice(template.indexOf('BEGIN;'),template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))
    .replaceAll('SCHEMA public',`SCHEMA ${schema}`).replaceAll(':"runtime"',`"${runtime}"`);
  const exclusions = [
    { marker:'PRIVATE POLICY GRANTS', tables:['private_work_persistence_policy','model_inference_export_policy'] },
    { marker:'BROKER CREDENTIAL EXCLUSIONS', tables:['broker_model_credentials','broker_credential_vault','credential_ingest_preparations'] },
    { marker:'MODEL BROKER AUTHORIZATION EXCLUSIONS', tables:['model_broker_authorizations','credential_ingest_authorizations','execution_machine_broker_authorizations'] },
  ].map(({marker,tables})=>({tables,sql:template.split('-- BEGIN '+marker+'\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'",`'${runtime}'`).replace("n.nspname='public'",`n.nspname='${schema}'`)}));
  const q = await owner.connect();
  try { await q.query(prefix);for(const exclusion of exclusions){const rows=await q.query(exclusion.sql);
    const statements=rows.rows.map(row=>Object.values(row)[0] as string);
    assert.deepEqual(statements.map(sql=>/REVOKE ALL PRIVILEGES ON TABLE ([a-z_]+) FROM/.exec(sql)?.[1]).sort(),[...exclusion.tables].sort());
    for(const statement of statements)await q.query(statement);}await q.query('COMMIT'); }
  catch(error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  tlsDirectory=await mkdtemp(join(tmpdir(),'fp-device-browser-tls-'));
  const generated=spawnSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1',
    '-subj','/CN=device.test','-addext','subjectAltName=DNS:device.test','-keyout',join(tlsDirectory,'key.pem'),'-out',join(tlsDirectory,'cert.pem')],
    {env:verificationEnvironment(),encoding:'utf8',timeout:10000});
  assert.equal(generated.status,0,generated.stderr);
  certificate=await readFile(join(tlsDirectory,'cert.pem'),'utf8');
  tlsServer=createServer({key:await readFile(join(tlsDirectory,'key.pem')),cert:certificate});
  await new Promise<void>(resolve=>tlsServer.listen(0,'127.0.0.1',resolve));
  origin='https://device.test:'+(tlsServer.address() as AddressInfo).port;
  Object.assign(host,{audience:origin+'/',bootstrapUri:origin+paths.status,beginUri:origin+paths.begin,pollUri:origin+paths.token,verificationUri:origin+'/device'});
  signingKey = await crypto.subtle.importKey('jwk',issuer.privateKey.export({format:'jwk'}),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  const unavailableModel=createUnavailableModelStepHost();
  const modelHost={async verify(...args:Parameters<typeof unavailableModel.verify>){modelHostCalls++;return unavailableModel.verify(...args);},
    async dispatch(...args:Parameters<typeof unavailableModel.dispatch>){modelHostCalls++;return unavailableModel.dispatch(...args);}};
  const product = await createPrivateAiProductTransport(app,{origin,environment:host.environment,clientId:host.clientId,
    host:modelHost,store:{async get(){return null;},async head(){return null;},async putImmutable(){return 'created';},async delete(){return 'missing';}},
    bootstrap:{host,signingKey},sourceNetwork:()=>randomUUID()});
  const main=createApp(app,origin,'staging',{privateAiProduct:product});
  main.use('/*',serveStatic({root:process.env.FREEDOM_DEVICE_BROWSER_DIST ?? './apps/portal-web/dist'}));
  main.get('*',serveStatic({path:(process.env.FREEDOM_DEVICE_BROWSER_DIST ?? './apps/portal-web/dist')+'/index.html'}));
  tlsServer.on('request',getRequestListener(request=>main.fetch(request),{overrideGlobalObjects:false}));
  transport={request:trustedRequest};
  const spki=createHash('sha256').update(new X509Certificate(certificate).publicKey.export({type:'spki',format:'der'})).digest('base64');
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_EXECUTABLE_PATH,
    args:['--host-resolver-rules=MAP device.test 127.0.0.1','--no-proxy-server','--ignore-certificate-errors-spki-list='+spki]});
});
after(async () => {
  await Promise.all(contexts.map(context=>context.close()));await browser?.close();
  if(tlsServer?.listening){tlsServer.closeAllConnections();await new Promise<void>(resolve=>tlsServer.close(()=>resolve()));}
  await app.end();await owner.end();
  try{if(created)await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`);}finally{await admin.end();}
  if(tlsDirectory)await rm(tlsDirectory,{recursive:true,force:true});
});
async function trustedRequest(input:string|Request,init?:RequestInit):Promise<Response> {
  const request=input instanceof Request?input:new Request(input,init),body=request.body?Buffer.from(await request.arrayBuffer()):undefined;
  return new Promise((resolve,reject)=>{
    const req=httpsRequest(request.url,{method:request.method,headers:Object.fromEntries(request.headers),ca:certificate,family:4,
      lookup:(_hostname,_options,callback)=>callback(null,'127.0.0.1',4)},res=>{
      const chunks:Buffer[]=[];res.on('data',chunk=>chunks.push(Buffer.from(chunk)));res.on('end',()=>{
        const headers=new Headers();for(const [key,value] of Object.entries(res.headers)){if(Array.isArray(value))for(const item of value)headers.append(key,item);else if(value!==undefined)headers.set(key,value);}
        resolve(new Response(Buffer.concat(chunks),{status:res.statusCode!,headers}));
      });
    });req.on('error',reject);req.end(body);
  });
}
async function browserPage(human:Awaited<ReturnType<typeof member>>) {
  const context=await browser.newContext();contexts.push(context);
  await context.addCookies([{name:'__Host-freedom_session',value:human.raw,url:origin,secure:true,httpOnly:true,sameSite:'Strict'}]);
  await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort());
  const page=await context.newPage(),logs:string[]=[],errors:string[]=[];clientLogs.set(page,logs);pageErrors.set(page,errors);
  page.on('console',message=>logs.push(message.text()));page.on('pageerror',error=>errors.push(error.message));
  const html=await page.goto(host.verificationUri);assert.equal(html?.status(),200);
  assert(html!.headers()['content-security-policy'].includes("form-action 'self'"));
  await page.getByRole('region',{name:'裝置與連線',exact:true}).waitFor();return page;
}
const encode=(v:unknown)=>Buffer.from(typeof v==='string'?v:JSON.stringify(v)).toString('base64url');
const hash=(v:string)=>createHash('sha256').update(v,'ascii').digest('base64url');
function signed(key:KeyObject,header:unknown,payload:unknown) {
  const data=encode(header)+'.'+encode(payload);
  return data+'.'+sign('sha256',Buffer.from(data),{key,dsaEncoding:'ieee-p1363'}).toString('base64url');
}
async function now() { return Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp()))::text n')).rows[0].n); }
function device() { const keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  return {...keys,publicJwk:parseRuntimePublicJwk(keys.publicKey.export({format:'jwk'}))}; }
type Device=ReturnType<typeof device>;
type Begin=z.infer<typeof DeviceAuthorizationBeginResultSchema>;
async function send(path:string,value:unknown,headers:Record<string,string>={},api=transport,requestOrigin=origin) {
  return api.request(requestOrigin+path,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Network':randomUUID(),...headers},body:JSON.stringify(value)});
}
async function expect(response:Response,status:number) { assert.equal(response.status,status,await response.clone().text()); return response; }
async function beginProof(key:Device,overrides:Record<string,unknown>={},config=host) {
  return signed(key.privateKey,{alg:'ES256',typ:'freedom-device-pairing+jwt',jwk:key.publicJwk},{purpose:'device_pairing_begin',client_id:config.clientId,
    environment:config.environment,runtime_kind:'agent-kit',scope:'bootstrap.status.read',jti:randomUUID(),iat:await now(),htm:'POST',htu:config.beginUri,...overrides});
}
async function begun() {
  const key=device(),proof=await beginProof(key);
  const response=await expect(await send(paths.begin,{publicJwk:key.publicJwk,runtimeKind:'agent-kit'},{DPoP:proof}),201);
  return {key,proof,authorization:DeviceAuthorizationBeginResultSchema.parse(await response.json())};
}
async function member() {
  const user=randomUUID(),community=randomUUID(),raw=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
  await owner.query("INSERT INTO communities VALUES($1,'Synthetic HTTP community')",[community]);
  const row=(await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    VALUES($1,$2,$3,'Synthetic HTTP member','not-a-login',$4) RETURNING *`,[user,community,user+'@example.invalid',randomUUID()])).rows[0];
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[tokenHash(raw),user,csrf]);
  const actor:Actor={...row,session_hash:tokenHash(raw),csrf_token:csrf};
  await withMemberScope(app,{actor,scope:'personal'},async()=>{},async()=>{});
  return {actor,raw,csrf,headers:{Cookie:'__Host-freedom_session='+raw,'X-CSRF-Token':csrf,Origin:origin}};
}
async function pollProof(f:{key:Device;authorization:Begin},overrides:Record<string,unknown>={}) {
  return signed(f.key.privateKey,{alg:'ES256',typ:'freedom-device-pairing+jwt',jwk:f.key.publicJwk},{purpose:'device_pairing_poll',client_id:host.clientId,
    environment:'staging-next',runtime_kind:'agent-kit',scope:'bootstrap.status.read',jti:randomUUID(),iat:await now(),htm:'POST',htu:host.pollUri,
    authorization_id:f.authorization.authorizationId,nonce:f.authorization.nonce,request_digest:f.authorization.requestDigest,
    device_code_hash:hash(f.authorization.deviceCode),...overrides});
}
async function poll(f:{key:Device;authorization:Begin},enrollmentProof?:string) {
  return expect(await send(paths.token,{grantType:'device_code',authorizationId:f.authorization.authorizationId,deviceCode:f.authorization.deviceCode,
    ...(enrollmentProof?{enrollmentProof}:{})},{DPoP:await pollProof(f)}),200);
}
type Paired=Awaited<ReturnType<typeof uiPair>>;
async function refresh(f:Paired,current=f.issued.refresh,overrides:Record<string,unknown>={}) {
  const proof=signed(f.key.privateKey,{alg:'ES256',typ:'freedom-bootstrap-refresh+jwt',jwk:f.key.publicJwk},{purpose:'bootstrap_refresh',client_id:host.clientId,
    environment:'staging-next',connection_id:f.issued.connectionId,family_id:current.familyId,generation:current.generation,refresh_handle_hash:hash(current.handle),
    jti:randomUUID(),iat:await now(),htm:'POST',htu:host.pollUri,...overrides});
  return send(paths.token,{grantType:'refresh_token',familyId:current.familyId,refreshHandle:current.handle},{DPoP:proof});
}
async function nonce(f:Paired,accessToken=f.issued.accessToken) {
  const proof=signed(f.key.privateKey,{alg:'ES256',typ:'freedom-bootstrap-nonce+jwt',jwk:f.key.publicJwk},{purpose:'bootstrap_nonce',client_id:host.clientId,
    environment:'staging-next',connection_id:f.issued.connectionId,jti:randomUUID(),iat:await now(),htm:'POST',htu:origin+paths.nonce,ath:hash(accessToken)});
  return send(paths.nonce,{connectionId:f.issued.connectionId},{Authorization:'DPoP '+accessToken,DPoP:proof});
}
async function statusHeaders(f:Paired,accessToken:string,challenge:z.infer<typeof BootstrapNonceSchema>) {
  const proof=signed(f.key.privateKey,{alg:'ES256',typ:'dpop+jwt',jwk:f.key.publicJwk},{jti:randomUUID(),iat:await now(),htm:'GET',htu:host.bootstrapUri,
    ath:hash(accessToken),nonce:challenge.nonce});
  return {Authorization:'DPoP '+accessToken,DPoP:proof,'X-Freedom-Connection':f.issued.connectionId,'X-Freedom-Nonce':challenge.nonceId,'X-Test-Network':randomUUID()};
}
async function readStatus(f:Paired,accessToken=f.issued.accessToken,challenge=f.issued.nonce) {
  return transport.request(host.bootstrapUri,{headers:await statusHeaders(f,accessToken,challenge)});
}


async function uiPair() {
  const f=await begun(),human=await member(),page=await browserPage(human);
  const panel=page.getByRole('region',{name:'裝置與連線',exact:true});
  await panel.getByLabel('裝置配對代碼',{exact:true}).fill(f.authorization.userCode);
  const read=page.waitForResponse(response=>response.url()===origin+paths.inspect&&response.request().method()==='POST');
  await panel.getByRole('button',{name:'讀取配對請求',exact:true}).click();assert.equal((await read).status(),200);
  await panel.getByRole('checkbox',{name:'我確認這是我正在配對的裝置，並核准讀取 bootstrap 狀態。',exact:true}).check();
  const approve=page.waitForResponse(response=>response.url()===origin+paths.decide&&response.request().method()==='POST');
  await panel.getByRole('button',{name:'核准裝置',exact:true}).click();assert.equal((await approve).status(),200);
  const first=DeviceAuthorizationPollResultSchema.parse(await(await poll(f)).json());
  assert.equal(first.status,'proof_required');if(first.status!=='proof_required')throw Error('Missing actual public enrollment challenge');
  await new Promise(resolve=>setTimeout(resolve,first.interval*1000+30));
  const enrollmentProof=signed(f.key.privateKey,{alg:'ES256',typ:'freedom-runtime-enrollment+jws'},first.challenge.payload);
  const issued=DeviceAuthorizationPollResultSchema.parse(await(await poll(f,enrollmentProof)).json());
  assert.equal(issued.status,'issued');if(issued.status!=='issued')throw Error('Actual signed exchange missing');
  return {...f,...human,issued,page,panel,enrollmentProof};
}
async function assertMainSafe(page:Page,secrets:string[]) {
  const state=await page.evaluate(()=>({html:document.documentElement.outerHTML,local:JSON.stringify({...localStorage}),session:JSON.stringify({...sessionStorage}),url:location.href}));
  for(const secret of secrets)for(const value of [...Object.values(state),...clientLogs.get(page)??[]])assert(!value.includes(secret),'Bootstrap secret retained in portal state');
  assert.deepEqual(pageErrors.get(page),[]);
  assert.equal(await page.locator('input[type=password]').count(),0);
  assert.equal((await owner.query('SELECT count(*)::int n FROM model_text_steps')).rows[0].n,0);
  assert.equal(modelHostCalls,0);
}
async function capturePortal(page:Page,name:string){
  const directory=process.env.FREEDOM_DEVICE_BROWSER_REPORT ?? '.freedom/reports/member-device-browser';await mkdir(directory,{recursive:true});
  for(const width of [390,768,1440]){await page.setViewportSize({width,height:960});
    assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'Portal overflow');
    await page.screenshot({path:join(directory,name+'-'+width+'.png'),fullPage:true});}
}
test('DEVICE-BROWSER actual TLS portal reviews and approves bootstrap-only pairing; signed exchange is one time',{timeout:60000},async()=>{
  const f=await uiPair();
  await expect(await readStatus(f),200);
  await expect(await send(paths.token,{grantType:'device_code',authorizationId:f.authorization.authorizationId,deviceCode:f.authorization.deviceCode,
    enrollmentProof:f.enrollmentProof},{DPoP:await pollProof(f)}),401);
  const ownerList=await trustedRequest(origin+paths.list,{headers:f.headers});assert.equal(ownerList.status,200);
  assert.equal((await ownerList.json() as {items:unknown[]}).items.length,1);
  await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),error=>(error as {code:string}).code==='42501');
  for(const query of ['SELECT * FROM credential_ingest_preparations','INSERT INTO credential_ingest_preparations DEFAULT VALUES','UPDATE credential_ingest_preparations SET expires_at=expires_at','DELETE FROM credential_ingest_preparations'])
    await assert.rejects(app.query(query),error=>(error as {code:string}).code==='42501','Main runtime cannot read or mutate broker preparation deadlines');
  await assertMainSafe(f.page,[f.authorization.deviceCode,f.issued.accessToken,f.issued.refresh.handle,f.issued.nonce.nonce]);
  await capturePortal(f.page,'owner-connection-'+f.issued.connectionId);
});
test('DEVICE-BROWSER actual portal revokes owner connection and blocks issued status, nonce and refresh',{timeout:60000},async()=>{
  const f=await uiPair();
  await f.page.reload();
  await f.panel.getByLabel('管理的裝置連線').selectOption(f.issued.connectionId);
  await f.panel.getByRole('checkbox',{name:'我確認撤銷目前選取的裝置連線。',exact:true}).check();
  const revoked=f.page.waitForResponse(response=>response.url()===origin+paths.list+'/'+f.issued.connectionId+':revoke'&&response.request().method()==='POST');
  await f.panel.getByRole('button',{name:'撤銷裝置連線',exact:true}).click();const response=await revoked;assert.equal(response.status(),200);
  assert.equal((await response.json()).state,'revoked');
  await expect(await readStatus(f),401);await expect(await nonce(f),401);await expect(await refresh(f),401);
  assert.equal((await owner.query('SELECT state FROM bootstrap_refresh_families WHERE family_id=$1',[f.issued.refresh.familyId])).rows[0].state,'revoked');
  await assertMainSafe(f.page,[f.authorization.deviceCode,f.issued.accessToken,f.issued.refresh.handle,f.issued.nonce.nonce]);
});
