import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, randomUUID, randomBytes, sign, type KeyObject } from 'node:crypto';
import { Pool } from 'pg';
import { z } from 'zod';
import { migrate } from '../../scripts/database.js';
import { withMemberScope } from '../../packages/resource-scopes/index.js';
import { tokenHash, type Actor } from '../../modules/identity-membership/service.js';
import { parseRuntimePublicJwk, createRuntimeRegistrationChallenge } from '../../modules/agent-control/runtime-proof.js';
import { DeviceAuthorizationBeginResultSchema, DeviceAuthorizationPollResultSchema, DeviceAuthorizationReviewSchema,
  type DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';
import { BootstrapNonceSchema } from '../../contracts/execution/v1/bootstrap-status.js';
import { createBootstrapHttpTransport } from '../../apps/platform-api/src/routes/bootstrap-http.js';
import { createPrivateAiProductTransport } from '../../apps/platform-api/src/private-ai-product.js';
import { createUnavailableModelStepHost } from '../../modules/agent-execution/model-step-host.js';
import { createWorkerHandler } from '../../apps/platform-api/src/worker.js';
import { createApp } from '../../apps/platform-api/src/app.js';

// Fixture follows member-device-bootstrap-http.test.ts; owns only its unique schema/roles.
const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_adversarial_http_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
const admin = new Pool({connectionString});
function roleUrl(role: string) { const url = new URL(connectionString!); url.username = role; url.password = ''; return url.toString(); }
const owner = new Pool({connectionString:roleUrl(migrator),options:`-c search_path=${schema} -c statement_timeout=10000`});
const app = new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema} -c statement_timeout=10000`,max:12});
let created = false;
let transport: Awaited<ReturnType<typeof createBootstrapHttpTransport>>, signingKey: CryptoKey;
const origin = 'https://platform.example.invalid';
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
  const grants = template.split('-- BEGIN PRIVATE POLICY GRANTS\n')[1].split('\n\\gexec')[0]
    .replaceAll(":'runtime'",`'${runtime}'`).replace("n.nspname='public'",`n.nspname='${schema}'`);
  const q = await owner.connect();
  try { await q.query(prefix); const rows=await q.query(grants); assert.equal(rows.rowCount,2);
    for (const row of rows.rows) await q.query(Object.values(row)[0] as string); await q.query('COMMIT'); }
  catch(error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  signingKey = await crypto.subtle.importKey('jwk',issuer.privateKey.export({format:'jwk'}),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  // Only this synthetic host supplies a network port using an explicit test header.
  const product = await createPrivateAiProductTransport(app,{origin,environment:host.environment,clientId:host.clientId,
    host:createUnavailableModelStepHost(),store:{async get(){return null;},async head(){return null;},async putImmutable(){return 'created';},async delete(){return 'missing';}},
    bootstrap:{host,signingKey},sourceNetwork:r=>r.headers.get('X-Test-Network') ?? 'synthetic-default'});
  transport = createApp(app,origin,'staging',{privateAiProduct:product});
});
after(async () => { await app.end(); await owner.end();
  try { if(created) await admin.query(`DROP SCHEMA ${schema} CASCADE; DROP ROLE ${runtime},${migrator}`); }
  finally { await admin.end(); } });
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
type Issued=Extract<z.infer<typeof DeviceAuthorizationPollResultSchema>,{status:'issued'}>;
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
async function approved() {
  const f=await begun(),human=await member();
  const review=DeviceAuthorizationReviewSchema.parse(await(await expect(await send(paths.inspect,{userCode:f.authorization.userCode},human.headers),200)).json());
  assert.equal(review.requestDigest,f.authorization.requestDigest); assert.equal(review.scope,'bootstrap.status.read');
  const decision={userCode:f.authorization.userCode,authorizationId:review.authorizationId,requestDigest:review.requestDigest,decision:'approve'};
  await expect(await send(paths.decide,decision,{...human.headers,'Idempotency-Key':randomUUID()}),200);
  return {...f,...human};
}
async function paired(publicChallenge=false) {
  const f=await approved(); let payload:unknown;
  if(publicChallenge) {
    const challenge=DeviceAuthorizationPollResultSchema.parse(await(await poll(f)).json());
    assert.equal(challenge.status,'proof_required'); if(challenge.status!=='proof_required')throw Error('Missing public challenge');
    payload=challenge.challenge.payload;
    await new Promise(resolve=>setTimeout(resolve,challenge.interval*1000+20));
  } else {
    // Other cases read only the synthetic enrollment payload to avoid a five-second interval each.
    const row=(await owner.query('SELECT * FROM runtime_registration_challenges WHERE owner_user_id=$1',[f.actor.user_id])).rows[0];
    payload=createRuntimeRegistrationChallenge({challenge_id:row.challenge_id,owner_member_id:row.owner_user_id,owner_principal_id:row.owner_principal_id,
      scope_id:row.scope_id,runtime_device_id:row.runtime_device_id,environment:row.environment,key_thumbprint:row.key_thumbprint,nonce:row.nonce,
      issued_at:row.issued_at.toISOString(),expires_at:row.expires_at.toISOString()}).payload;
  }
  const enrollmentProof=signed(f.key.privateKey,{alg:'ES256',typ:'freedom-runtime-enrollment+jws'},payload);
  const issued=DeviceAuthorizationPollResultSchema.parse(await(await poll(f,enrollmentProof)).json());
  assert.equal(issued.status,'issued'); if(issued.status!=='issued')throw Error('Genuine HTTP exchange required');
  return {...f,issued};
}
type Paired=Awaited<ReturnType<typeof paired>>;
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


const inertStore={async get(){return null;},async head(){return null;},async putImmutable(){return 'created' as const;},async delete(){return 'missing' as const;}};
function options(){return {origin,environment:host.environment,clientId:host.clientId,host:createUnavailableModelStepHost(),store:inertStore};}

test('installation rejects genuine but unrelated issuer private key before producing product',async()=>{
  const other=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
  const wrongKey=await crypto.subtle.importKey('jwk',other.privateKey.export({format:'jwk'}),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  await assert.rejects(createPrivateAiProductTransport(app,{...options(),bootstrap:{host,signingKey:wrongKey}}));
});
test('installation cannot be forged with a transport-shaped object, copied brand, or absent signing port',async()=>{
  for(const forged of [{fetch:async()=>Response.json({operational_authority:true})},{...transport},{}])
    assert.throws(()=>createApp(app,origin,'staging',{privateAiProduct:forged as never}));
  for(const bootstrap of [{host},{signingKey},{host,signingKey:{type:'private',algorithm:{name:'ECDSA',namedCurve:'P-256'},usages:['sign'],extractable:false}}])
    await assert.rejects(createPrivateAiProductTransport(app,{...options(),bootstrap:bootstrap as never}));
});
test('installation is bound to exact pool, main origin and environment',async()=>{
  const product=await createPrivateAiProductTransport(app,{...options(),bootstrap:{host,signingKey}});
  assert.throws(()=>createApp(owner,origin,'staging',{privateAiProduct:product}));
  assert.throws(()=>createApp(app,'https://other.example.invalid','staging',{privateAiProduct:product}));
  assert.throws(()=>createApp(app,origin,'public',{privateAiProduct:product}));
});
for(const kind of ['revoked-session','expired-session','deactivated-member'] as const)
 test('a previously reviewed pending pairing cannot be approved by '+kind,async()=>{
  const f=await begun(),m=await member();
  const review=DeviceAuthorizationReviewSchema.parse(await(await expect(await send(paths.inspect,{userCode:f.authorization.userCode},m.headers),200)).json());
  if(kind==='deactivated-member')await owner.query('UPDATE users SET active=false WHERE user_id=$1',[m.actor.user_id]);
  else await owner.query(kind==='revoked-session'?'UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1':
    "UPDATE sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",[m.actor.session_hash]);
  await expect(await send(paths.decide,{userCode:f.authorization.userCode,authorizationId:review.authorizationId,
    requestDigest:review.requestDigest,decision:'approve'},{...m.headers,'Idempotency-Key':randomUUID()}),401);
  assert.equal((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=$1',[f.authorization.authorizationId])).rows[0].state,'pending');
 });

test('approval cannot substitute another pending request or another reviewed digest',async()=>{
  const a=await begun(),b=await begun(),m=await member();
  const review=DeviceAuthorizationReviewSchema.parse(await(await expect(await send(paths.inspect,{userCode:a.authorization.userCode},m.headers),200)).json());
  for(const override of [{authorizationId:b.authorization.authorizationId},{requestDigest:b.authorization.requestDigest}]){
    const response=await send(paths.decide,{userCode:a.authorization.userCode,authorizationId:review.authorizationId,
      requestDigest:review.requestDigest,decision:'approve',...override},{...m.headers,'Idempotency-Key':randomUUID()});
    assert.equal(response.status,404,await response.clone().text());
  }
  assert.deepEqual((await owner.query('SELECT state FROM device_authorizations WHERE authorization_id=ANY($1::uuid[]) ORDER BY authorization_id',
    [[a.authorization.authorizationId,b.authorization.authorizationId]])).rows.map(r=>r.state),['pending','pending']);
});

test('member deactivation invalidates issued bootstrap and refresh while retaining evidence',async()=>{
  const f=await paired();
  await owner.query('UPDATE users SET active=false WHERE user_id=$1',[f.actor.user_id]);
  await expect(await nonce(f),401);await expect(await refresh(f),401);await expect(await readStatus(f),401);
  assert.equal((await owner.query('SELECT count(*)::int n FROM device_authorizations WHERE authorization_id=$1',[f.authorization.authorizationId])).rows[0].n,1);
  assert.equal((await owner.query('SELECT count(*)::int n FROM agent_connections WHERE connection_id=$1',[f.issued.connectionId])).rows[0].n,1);
});

test('bootstrap status token cannot authorize private Work or model mutation',async()=>{
  const f=await paired(),headers=await statusHeaders(f,f.issued.accessToken,f.issued.nonce);
  for(const path of ['/api/v1/me/private-work','/api/v1/me/model-steps']){
    const response=await send(path,{title:'must not create'},{...headers,Origin:origin});
    assert([400,401,403].includes(response.status),await response.clone().text());
  }
  assert.equal((await owner.query('SELECT count(*)::int n FROM work_items')).rows[0].n,0);
});

test('uninstalled Node and actual Worker reject streamed device body before pulling it',async()=>{
  const worker=createWorkerHandler({createPool:()=>new Pool({connectionString:roleUrl(runtime),options:`-c search_path=${schema}`})});
  const env={FREEDOM_ENV:'staging',APP_ORIGIN:origin,FREEDOM_RELEASE_SHA:'a'.repeat(40),FREEDOM_DATABASE_NAME:new URL(connectionString!).pathname.slice(1),
    HYPERDRIVE:{connectionString:roleUrl(runtime)},ASSETS:{fetch:async()=>new Response('unused')}};
  for(const path of [paths.begin,paths.token,paths.inspect,paths.decide,paths.list+'/'+randomUUID()+':revoke']){
    for(const engine of ['Node','Worker']){
      let pulls=0;const body=new ReadableStream<Uint8Array>({pull(){pulls++;}},{highWaterMark:0});
      const request=new Request(origin+path,{method:'POST',body,duplex:'half'} as RequestInit);
      const response=engine==='Node'?await createApp(app,origin,'staging').fetch(request):await worker.fetch(request,env,{waitUntil(){}});
      await expect(response,503);assert.equal((await response.json()).code,'private_ai_product_unavailable');assert.equal(pulls,0,engine);
    }
  }
});


test('mounted security fixture uses actual isolated low-privilege role and cannot create schema objects',async()=>{
  const role=(await app.query('SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];
  assert.deepEqual(role,{current_user:runtime,session_user:runtime,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false});
  await assert.rejects(app.query('CREATE TABLE forbidden_fixture_ddl(id integer)'),{code:'42501'});
});
