import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
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
import { parseRuntimePublicJwk, createRuntimeRegistrationChallenge } from '../../modules/agent-control/runtime-proof.js';
import { DeviceAuthorizationBeginResultSchema, DeviceAuthorizationPollResultSchema, DeviceAuthorizationReviewSchema,
  type DeviceAuthorizationHost } from '../../contracts/execution/v1/device-pairing.js';
import { BootstrapRefreshResultSchema } from '../../contracts/execution/v1/bootstrap-session.js';
import { BootstrapNonceSchema, BootstrapStatusSchema } from '../../contracts/execution/v1/bootstrap-status.js';
import { createBootstrapHttpTransport } from '../../apps/platform-api/src/routes/bootstrap-http.js';
import { createApp } from '../../apps/platform-api/src/app.js';

const connectionString = process.env.TEST_DATABASE_URL;
if (!connectionString || !/^\/fp_[a-z0-9_]+$/.test(new URL(connectionString).pathname))
  throw new Error('Explicit isolated fp_* TEST_DATABASE_URL required.');
const schema = `fp_http_${process.pid}_${Date.now()}`, migrator = `${schema}_owner`, runtime = `${schema}_app`;
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
const host: DeviceAuthorizationHost = {environment:'local',clientId:'bootstrap-http-synthetic',issuer:'https://issuer.example.invalid/',audience:origin+'/',
  bootstrapUri:origin+paths.status,beginUri:origin+paths.begin,pollUri:origin+paths.token,verificationUri:origin+'/device',clientDisplayName:'Synthetic client',
  issuerKid:'synthetic-issuer',keys:[{kid:'synthetic-issuer',purpose:'bootstrap_access',environment:'local',publicJwk:parseRuntimePublicJwk(issuer.publicKey.export({format:'jwk'})),
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
  try { await q.query(prefix); const rows=await q.query(grants); assert.equal(rows.rowCount,1);
    await q.query(Object.values(rows.rows[0])[0] as string); await q.query('COMMIT'); }
  catch(error) { await q.query('ROLLBACK'); throw error; } finally { q.release(); }
  signingKey = await crypto.subtle.importKey('jwk',issuer.privateKey.export({format:'jwk'}),{name:'ECDSA',namedCurve:'P-256'},false,['sign']);
  // Only this synthetic host supplies a network port using an explicit test header.
  transport = await createBootstrapHttpTransport(app,{host,signingKey,sourceNetwork:r=>r.headers.get('X-Test-Network') ?? 'synthetic-default'});
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
  return {actor,raw,csrf,headers:{Cookie:'freedom_local_session='+raw,'X-CSRF-Token':csrf,Origin:origin}};
}
async function pollProof(f:{key:Device;authorization:Begin},overrides:Record<string,unknown>={}) {
  return signed(f.key.privateKey,{alg:'ES256',typ:'freedom-device-pairing+jwt',jwk:f.key.publicJwk},{purpose:'device_pairing_poll',client_id:host.clientId,
    environment:'local',runtime_kind:'agent-kit',scope:'bootstrap.status.read',jti:randomUUID(),iat:await now(),htm:'POST',htu:host.pollUri,
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
    environment:'local',connection_id:f.issued.connectionId,family_id:current.familyId,generation:current.generation,refresh_handle_hash:hash(current.handle),
    jti:randomUUID(),iat:await now(),htm:'POST',htu:host.pollUri,...overrides});
  return send(paths.token,{grantType:'refresh_token',familyId:current.familyId,refreshHandle:current.handle},{DPoP:proof});
}
async function nonce(f:Paired,accessToken=f.issued.accessToken) {
  const proof=signed(f.key.privateKey,{alg:'ES256',typ:'freedom-bootstrap-nonce+jwt',jwk:f.key.publicJwk},{purpose:'bootstrap_nonce',client_id:host.clientId,
    environment:'local',connection_id:f.issued.connectionId,jti:randomUUID(),iat:await now(),htm:'POST',htu:origin+paths.nonce,ath:hash(accessToken)});
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

test('HTTP real non-superuser roles and public pairing -> rotate -> sessionless nonce -> actual status',async()=>{
  for(const [pool,name] of [[owner,migrator],[app,runtime]] as const) assert.deepEqual((await pool.query(
    'SELECT current_user,session_user,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0],
    {current_user:name,session_user:name,rolsuper:false,rolcreatedb:false,rolcreaterole:false,rolbypassrls:false});
  assert.equal(signingKey.extractable,false);
  const f=await paired(true); assert.equal(f.issued.refresh.generation,'1');
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[f.actor.session_hash]);
  const next=BootstrapRefreshResultSchema.parse(await(await expect(await refresh(f),200)).json());
  assert.equal(next.refresh.generation,'2'); assert.notEqual(next.refresh.handle,f.issued.refresh.handle);
  const challenge=BootstrapNonceSchema.parse(await(await expect(await nonce(f,next.accessToken),201)).json());
  const response=await expect(await readStatus(f,next.accessToken,challenge),200);
  assert.equal(BootstrapStatusSchema.parse(await response.json()).operational_authority,false);
  assert.equal(response.headers.get('Cache-Control'),'private, no-store'); assert.equal(response.headers.get('Access-Control-Allow-Origin'),null);
  const stored=[];
  for(const table of ['device_authorizations','device_poll_proofs','runtime_registration_challenges','runtime_registrations',
    'agent_connections','bootstrap_nonces','bootstrap_refresh_families','bootstrap_refresh_generations','bootstrap_session_proofs',
    'scoped_command_receipts','scoped_outbox','scoped_transition_journal'])
    stored.push((await owner.query(`SELECT jsonb_agg(to_jsonb(t)) rows FROM ${table} t`)).rows[0]);
  for(const secret of [f.raw,f.csrf,f.authorization.deviceCode,f.authorization.userCode,f.proof,f.issued.accessToken,f.issued.refresh.handle,next.accessToken,next.refresh.handle]) {
    assert(!JSON.stringify(stored).includes(secret));
  }
});
test('HTTP verified old refresh reuse commits whole-family revoke and denies already issued credentials',async()=>{
  const f=await paired(),next=BootstrapRefreshResultSchema.parse(await(await expect(await refresh(f),200)).json());
  const challenge=BootstrapNonceSchema.parse(await(await expect(await nonce(f,next.accessToken),201)).json());
  await expect(await refresh(f),401); await expect(await nonce(f,next.accessToken),401); await expect(await readStatus(f,next.accessToken,challenge),401);
  const row=(await owner.query('SELECT f.state family,c.state connection FROM bootstrap_refresh_families f JOIN agent_connections c USING(connection_id) WHERE family_id=$1',[next.refresh.familyId])).rows[0];
  assert.deepEqual(row,{family:'revoked',connection:'revoked'});
});
test('HTTP invalid refresh signature cannot revoke valid family; successful use still rotates',async()=>{
  const f=await paired(); await expect(await refresh(f,f.issued.refresh,{htu:origin+'/wrong'}),401);
  await expect(await refresh(f),200);
});
test('HTTP HEAD and repeated status cannot consume or reuse one-use challenge',async()=>{
  const f=await paired(),headers=await statusHeaders(f,f.issued.accessToken,f.issued.nonce);
  const head=await expect(await transport.request(host.bootstrapUri,{method:'HEAD',headers}),405); assert.equal(head.headers.get('Allow'),'GET');
  await expect(await transport.request(host.bootstrapUri,{headers}),200); await expect(await transport.request(host.bootstrapUri,{headers}),401);
});
test('HTTP member list/read are owner-only metadata and revoke requires exact CAS and idempotency',async()=>{
  const f=await paired(),other=await member(),path=paths.list+'/'+f.issued.connectionId;
  const listing=await(await expect(await transport.request(origin+paths.list,{headers:f.headers}),200)).json() as {items:unknown[]};
  assert.equal(listing.items.length,1); for(const secret of [f.issued.accessToken,f.issued.refresh.handle,f.authorization.deviceCode,f.issued.nonce.nonce])assert(!JSON.stringify(listing).includes(secret));
  assert.equal(((await(await transport.request(origin+paths.list,{headers:other.headers})).json()) as {items:unknown[]}).items.length,0);
  await expect(await transport.request(origin+path,{headers:other.headers}),404);
  const read=await expect(await transport.request(origin+path,{headers:f.headers}),200); assert.equal(read.headers.get('ETag'),'"1"');
  const key=randomUUID();
  await expect(await send(path+':revoke',{}, {...f.headers,'Idempotency-Key':key}),428);
  await expect(await send(path+':revoke',{}, {...f.headers,'Idempotency-Key':key,'If-Match':'"2"'}),412);
  await expect(await send(path+':revoke',{}, {...other.headers,'Idempotency-Key':key,'If-Match':'"1"'}),404);
  const revoked=await expect(await send(path+':revoke',{}, {...f.headers,'Idempotency-Key':key,'If-Match':'"1"'}),200);
  assert.equal(revoked.headers.get('ETag'),'"2"');
  await expect(await send(path+':revoke',{}, {...f.headers,'Idempotency-Key':key,'If-Match':'"1"'}),200);
  await expect(await nonce(f),401);
});
test('HTTP member approval cannot use missing/wrong CSRF, expired cookie or injected actor',async()=>{
  const f=await begun(),m=await member();
  for(const csrf of ['',randomUUID()]) await expect(await send(paths.inspect,{userCode:f.authorization.userCode},{...m.headers,'X-CSRF-Token':csrf}),403);
  await expect(await send(paths.inspect,{userCode:f.authorization.userCode},{Origin:origin}),401);
  await expect(await send(paths.inspect,{userCode:f.authorization.userCode,actor:m.actor},m.headers),400);
  await owner.query('UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',[m.actor.session_hash]);
  await expect(await send(paths.inspect,{userCode:f.authorization.userCode},m.headers),401);
});
for(const [label,headers] of [
  ['missing origin',{}],['cross origin',{Origin:'https://other.example.invalid'}],['null origin',{Origin:'null'}],
  ['fetch cross-site',{Origin:origin,'Sec-Fetch-Site':'cross-site'}],['fetch same-site',{Origin:origin,'Sec-Fetch-Site':'same-site'}],
  ['bearer credential',{Origin:origin,Authorization:'Bearer synthetic'}],['machine proof',{Origin:origin,DPoP:'a.b.c'}],
] as const) test('HTTP member rejects '+label,async()=>{ const m=await member();
  await expect(await send(paths.inspect,{userCode:'00000-00000'},{Cookie:m.headers.Cookie,'X-CSRF-Token':m.csrf,...headers}),403); });
for(const [label,headers] of [
  ['cookie',{Cookie:'freedom_local_session=synthetic'}],['csrf',{'X-CSRF-Token':'synthetic'}],['bearer',{Authorization:'Bearer synthetic'}],
  ['cross origin',{Origin:'https://other.example.invalid'}],['null origin',{Origin:'null'}],['same site',{'Sec-Fetch-Site':'same-site'}],
  ['encoding',{'Content-Encoding':'gzip'}],
] as const) test('HTTP machine rejects '+label+' before proof or body',async()=>{
  await expect(await send(paths.begin,{},headers),label==='encoding'?415:403);
});
for(const [label,url,headers] of [
  ['cleartext',origin.replace('https:','http:')+paths.begin,{}],['wrong host','https://other.example.invalid'+paths.begin,{}],
  ['Host mismatch',origin+paths.begin,{Host:'other.example.invalid'}],['query',origin+paths.begin+'?token=synthetic',{}],
  ['percent path',origin+paths.begin.replace('auth','%61uth'),{}],
] as const) test('HTTP rejects '+label+' even with spoofed forwarding headers',async()=>{
  await expect(await transport.request(url,{method:'POST',headers:{...headers,'X-Forwarded-Proto':'https','X-Forwarded-Host':'platform.example.invalid','Content-Type':'application/json'},body:'{}'}),403);
});
test('HTTP routes fail closed for unsupported purpose, extra secret fields, body proof and mixed grant',async()=>{
  const id=randomUUID(),secret='A'.repeat(43);
  for(const value of [{grantType:'password'},{grantType:'refresh_token',familyId:id,refreshHandle:secret,authorizationId:id},
    {grantType:'device_code',authorizationId:id,deviceCode:secret,proof:'a.b.c'}])await expect(await send(paths.token,value,{DPoP:'a.b.c'}),400);
  await expect(await send(paths.begin,{publicJwk:device().publicJwk,runtimeKind:'agent-kit',nowMs:0},{DPoP:'a.b.c'}),400);
  await expect(await transport.request(origin+'/execution-api/v1/unknown'),404);
  await expect(await transport.request(origin+paths.begin,{method:'OPTIONS'}),405);
});
test('HTTP wrong environment, URI, purpose, private JWK and duplicated compact header cannot begin',async()=>{
  for(const claims of [{environment:'next'},{htu:host.pollUri},{purpose:'bootstrap_nonce'}]) {
    const key=device(); await expect(await send(paths.begin,{publicJwk:key.publicJwk,runtimeKind:'agent-kit'},{DPoP:await beginProof(key,claims)}),401);
  }
  const key=device(),proof=await beginProof(key);
  await expect(await send(paths.begin,{publicJwk:{...key.publicJwk,d:key.privateKey.export({format:'jwk'}).d},runtimeKind:'agent-kit'},{DPoP:proof}),400);
  await expect(await send(paths.begin,{publicJwk:key.publicJwk,runtimeKind:'agent-kit'},{DPoP:proof+', '+proof}),401);
});
for(const [label,raw] of [
  ['duplicate decoded key','{"runtimeKind":"agent-kit","runtime\\u004bind":"neo"}'],['nested duplicate','{"publicJwk":{"x":"a","x":"b"}}'],
  ['BOM','\ufeff{}'],['prototype key','{"__proto__":{}}'],['excess nesting','['.repeat(25)+']'.repeat(25)],
] as const) test('HTTP bounded JSON rejects '+label,async()=>{
  await expect(await transport.request(origin+paths.begin,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Network':randomUUID()},body:raw}),400);
});
test('HTTP body media type, actual bytes, declared size and UTF-8 are independently checked',async()=>{
  const cases:[BodyInit,Record<string,string>,number][]=[['{}',{'Content-Type':'application/x-www-form-urlencoded'},415],
    ['{}',{'Content-Length':'32769'},413],[' '.repeat(32769),{},413],['{}',{'Content-Length':'3'},400],
    [new Uint8Array([0xff]),{},400]];
  for(const [body,headers,status] of cases)await expect(await transport.request(origin+paths.begin,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Network':randomUUID(),...headers},body}),status);
});
test('HTTP chunk cap, cancellation rejection and caller abort finish without changing domain state',async()=>{
  const count=(await owner.query('SELECT count(*)::int n FROM device_authorizations')).rows[0].n;
  let cancelled=0;
  const stream=new ReadableStream<Uint8Array>({start(c){for(let i=0;i<129;i++)c.enqueue(new Uint8Array());},cancel(){cancelled++;return Promise.reject(Error('synthetic cancel secret'));}});
  const req=new Request(origin+paths.begin,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Network':randomUUID()},body:stream,duplex:'half'} as RequestInit);
  await expect(await transport.request(req),413); assert.equal(cancelled,1);
  const controller=new AbortController(),blocked=new ReadableStream<Uint8Array>();
  const response=transport.request(new Request(origin+paths.begin,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Network':randomUUID()},body:blocked,signal:controller.signal,duplex:'half'} as RequestInit));
  controller.abort(); await expect(await response,400);
  assert.equal((await owner.query('SELECT count(*)::int n FROM device_authorizations')).rows[0].n,count);
});
test('HTTP stalled body has bounded deadline even when cancel never finishes',async()=>{
  const stream=new ReadableStream<Uint8Array>({cancel(){return new Promise(()=>{});}}),started=Date.now();
  const response=await transport.request(new Request(origin+paths.begin,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Network':randomUUID()},body:stream,duplex:'half'} as RequestInit));
  await expect(response,408); assert(Date.now()-started>=4500); assert(Date.now()-started<8000);
});
test('HTTP malformed request limit is durable and serialized; default ignores all supplied IP headers',async()=>{
  const network='concurrent-'+randomUUID();
  const responses=await Promise.all(Array.from({length:21},()=>send(paths.begin,{}, {'X-Test-Network':network})));
  assert.equal(responses.filter(r=>r.status===400).length,20); assert.equal(responses.filter(r=>r.status===429).length,1);
  const denied=responses.find(r=>r.status===429)!; assert.equal(denied.headers.get('Retry-After'),'60');
  const defaultApi=await createBootstrapHttpTransport(app,{host,signingKey});
  for(let i=0;i<20;i++)await expect(await send(paths.begin,{}, {'X-Forwarded-For':randomUUID(),'CF-Connecting-IP':randomUUID()},defaultApi),400);
  await expect(await send(paths.begin,{}, {'X-Forwarded-For':'another','CF-Connecting-IP':'another'},defaultApi),429);
  const reconstructed=await createBootstrapHttpTransport(app,{host,signingKey});
  await expect(await send(paths.begin,{}, {},reconstructed),429);
});
test('HTTP fixed errors never echo submitted secret or raw stream/SQL diagnostics',async()=>{
  const secret='synthetic-http-secret-'+randomUUID();
  const response=await send(paths.begin,{secret},{DPoP:secret}); await expect(response,400);
  assert(!(await response.text()).includes(secret));
  const stream=new ReadableStream({start(c){c.error(Error(secret));}});
  const broken=await transport.request(new Request(origin+paths.begin,{method:'POST',headers:{'Content-Type':'application/json','X-Test-Network':randomUUID()},body:stream,duplex:'half'} as RequestInit));
  await expect(broken,400); assert(!(await broken.text()).includes(secret));
  const badSource=await createBootstrapHttpTransport(app,{host,signingKey,sourceNetwork:()=>{throw Error(secret);}});
  const denied=await send(paths.begin,{}, {},badSource); await expect(denied,503); assert(!(await denied.text()).includes(secret));
});
test('HTTP global cap bounds new network buckets and DB-clock expiry releases only the expired window',async()=>{
  const config={...host,clientId:'bootstrap-http-global-synthetic'};
  const api=await createBootstrapHttpTransport(app,{host:config,signingKey,sourceNetwork:r=>r.headers.get('X-Test-Network')!});
  for(let i=0;i<400;i++)await expect(await send(paths.begin,{}, {},api),400);
  const count=(await owner.query('SELECT count(*)::int n FROM auth_rate_limits')).rows[0].n;
  await expect(await send(paths.begin,{}, {},api),429);
  assert.equal((await owner.query('SELECT count(*)::int n FROM auth_rate_limits')).rows[0].n,count);
  const bucket=createHash('sha256').update(JSON.stringify(['freedom.bootstrap-http/v1','local',config.clientId,'begin','global','global'])).digest('hex');
  await owner.query("UPDATE auth_rate_limits SET window_start=clock_timestamp()-interval '61 seconds' WHERE bucket=$1",[bucket]);
  await expect(await send(paths.begin,{}, {},api),400);
  assert.equal((await owner.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[bucket])).rows[0].attempts,1);
});
test('HTTP later crypto failure does not refund an independently committed request charge',async()=>{
  const key=device(),network='invalid-proof-'+randomUUID();
  const bucket=createHash('sha256').update(JSON.stringify(['freedom.bootstrap-http/v1','local',host.clientId,'begin','network',network])).digest('hex');
  await expect(await send(paths.begin,{publicJwk:key.publicJwk,runtimeKind:'agent-kit'}, {'DPoP':await beginProof(key,{environment:'next'}),'X-Test-Network':network}),401);
  assert.equal((await owner.query('SELECT attempts FROM auth_rate_limits WHERE bucket=$1',[bucket])).rows[0].attempts,1);
});
test('HTTP production Node application keeps new machine and member routes closed without trust configuration',async()=>{
  const productionOrigin='http://127.0.0.1:4310',production=createApp(app,productionOrigin),m=await member();
  for(const path of [paths.begin,paths.token,paths.nonce,paths.inspect,paths.decide,paths.list+'/'+randomUUID()+':revoke'])
    await expect(await production.request(productionOrigin+path,{method:'POST',headers:{'Content-Type':'application/json',...m.headers,Origin:productionOrigin},body:'{}'}),404);
  await expect(await production.request(productionOrigin+paths.status),404);
});
test('HTTP configuration snapshots trust, rejects getters without running them and has no injected verifier',async()=>{
  let invoked=false;
  const bad={signingKey,get host(){invoked=true;return host;}};
  await assert.rejects(createBootstrapHttpTransport(app,bad),/invalid_bootstrap_http_configuration/); assert.equal(invoked,false);
  await assert.rejects(createBootstrapHttpTransport(app,{host,signingKey,verify:()=>true} as Parameters<typeof createBootstrapHttpTransport>[1]),/invalid_bootstrap_http_configuration/);
  await assert.rejects(createBootstrapHttpTransport(app,{host:{...host,beginUri:origin+'/other'},signingKey}),/invalid_bootstrap_http_configuration/);
  const mutable=structuredClone(host),api=await createBootstrapHttpTransport(app,{host:mutable,signingKey,sourceNetwork:()=>randomUUID()}); mutable.clientId='changed';
  const key=device(); await expect(await send(paths.begin,{publicJwk:key.publicJwk,runtimeKind:'agent-kit'},{DPoP:await beginProof(key)},api),201);
});
test('HTTP real ephemeral TLS socket verifies genuine signed begin and rejects cleartext Host spoofing',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fp-bootstrap-http-tls-'));
  const server=createServer(); let api:typeof transport|undefined;
  try {
    const result=spawnSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-days','1','-subj','/CN=localhost',
      '-keyout',join(dir,'key.pem'),'-out',join(dir,'cert.pem')],{env:verificationEnvironment(),encoding:'utf8',timeout:10000});
    assert.equal(result.status,0,result.stderr);
    server.setSecureContext({key:await readFile(join(dir,'key.pem')),cert:await readFile(join(dir,'cert.pem'))});
    server.on('request',getRequestListener(r=>api!.fetch(r),{overrideGlobalObjects:false}));
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve());});
    const socketOrigin='https://127.0.0.1:'+(server.address() as AddressInfo).port;
    const config={...host,clientId:'bootstrap-http-tls-synthetic',audience:socketOrigin+'/',bootstrapUri:socketOrigin+paths.status,beginUri:socketOrigin+paths.begin,pollUri:socketOrigin+paths.token,verificationUri:socketOrigin+'/device'};
    api=await createBootstrapHttpTransport(app,{host:config,signingKey});
    const key=device(),body=JSON.stringify({publicJwk:key.publicJwk,runtimeKind:'agent-kit'}),proof=await beginProof(key,{},config);
    const call=(headers:Record<string,string>)=>new Promise<{status:number;body:string}>((resolve,reject)=>{
      const req=httpsRequest(config.beginUri,{method:'POST',rejectUnauthorized:false,headers:{'Content-Type':'application/json',DPoP:proof,...headers}},res=>{
        let data='';res.setEncoding('utf8');res.on('data',chunk=>data+=chunk);res.on('end',()=>resolve({status:res.statusCode!,body:data}));});
      req.once('error',reject);req.end(body);
    });
    const response=await call({});assert.equal(response.status,201,response.body);DeviceAuthorizationBeginResultSchema.parse(JSON.parse(response.body));
    assert.equal((await call({Host:'platform.example.invalid','X-Forwarded-Host':new URL(socketOrigin).host})).status,403);
  } finally {server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(dir,{recursive:true,force:true});}
});
