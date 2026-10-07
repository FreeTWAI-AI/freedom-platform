import assert from 'node:assert/strict';
import {before,after,test} from 'node:test';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {createServer,createConnection,type Socket} from 'node:net';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {Pool} from 'pg';
import {CompactSign} from 'jose';
import {migrate} from '../../scripts/database.js';
import {tokenHash} from '../../modules/identity-membership/service.js';
import {MemberModelSettingsOverviewSchema} from '../../contracts/execution/v2/member-model-settings.js';
import {DeviceAuthorizationBeginResultSchema,DeviceAuthorizationPollResultSchema} from '../../contracts/execution/v1/device-pairing.js';

const rawUrl=process.env.TEST_DATABASE_URL;
if(!rawUrl)throw new Error('Owned fp_* TEST_DATABASE_URL required.');
const adminUrl=new URL(rawUrl),socketDirectory=adminUrl.searchParams.get('host');
if(!/^\/fp_[a-z0-9_]+$/.test(adminUrl.pathname)
  || (socketDirectory ? !socketDirectory.startsWith('/') : !['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname)))
  throw new Error('Owned fp_* Unix-socket or loopback TCP TEST_DATABASE_URL required.');
const rolePassword=randomBytes(24).toString('hex');
const database=`fp_worker_ai_${process.pid}_${Date.now()}`,migrator=database+'_owner',runtime=database+'_app';
const admin=new Pool({connectionString:rawUrl});
function roleUrl(role:string){const url=new URL(rawUrl!);url.pathname='/'+database;url.username=role;url.password=rolePassword;return url.href;}
const owner=new Pool({connectionString:roleUrl(migrator)}),app=new Pool({connectionString:roleUrl(runtime)});
// Pool.end() resolves after removing clients, before their sockets necessarily close.
// Wait for actual client end events before DROP FORCE, so teardown cannot kill an idle closing client.
const closedClients:Promise<void>[]=[];
for(const pool of [owner,app])pool.on('connect',client=>closedClients.push(new Promise<void>(resolve=>client.once('end',resolve))));
const sockets=new Set<Socket>(),proxy=socketDirectory?createServer(client=>{const upstream=createConnection(join(socketDirectory!,'.s.PGSQL.5432'));
  for(const socket of [client,upstream]){sockets.add(socket);socket.on('close',()=>sockets.delete(socket));socket.on('error',()=>{client.destroy();upstream.destroy();});}client.pipe(upstream).pipe(client);}):undefined;
let created=false,mf:Miniflare,directory:string;
const origin='https://platform.test',clientId='native-worker-private-ai';
const requestKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),responseKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']),recoveryKeys=await crypto.subtle.generateKey('Ed25519',true,['sign','verify']);
const issuerKeys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
async function jwk(key:CryptoKey){const {kty,crv,x,y,d}=await crypto.subtle.exportKey('jwk',key);return {kty,crv,x,...(y?{y}:{}),...(d?{d}:{})};}
const community=randomUUID(),user=randomUUID(),cookie=randomBytes(32).toString('base64url'),csrf=randomBytes(32).toString('base64url');
const headers={Cookie:'freedom_local_session='+cookie,'X-CSRF-Token':csrf,Origin:origin,'Content-Type':'application/json'};
const paths={begin:'/execution-api/v1/auth/device-authorizations',token:'/execution-api/v1/auth/token',inspect:'/api/v1/me/device-authorizations/inspect',decide:'/api/v1/me/device-authorizations/decide',list:'/api/v1/me/agent-connections',status:'/execution-api/v1/bootstrap'};
before(async()=>{
  await admin.query(`CREATE ROLE ${migrator} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    CREATE ROLE ${runtime} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`);
  await admin.query(`CREATE DATABASE ${database} OWNER ${migrator}`);created=true;await migrate(owner);
  const template=await readFile('deploy/cloudflare/sql/20-runtime-grants.psql','utf8'),replace=(s:string)=>s.replaceAll(':"runtime"',`"${runtime}"`).replaceAll(":'runtime'",`'${runtime}'`);
  const q=await owner.connect();try{await q.query(replace(template.slice(template.indexOf('BEGIN;'),template.indexOf('-- BEGIN PRIVATE POLICY GRANTS'))));
    for(const marker of ['PRIVATE POLICY GRANTS','BROKER CREDENTIAL EXCLUSIONS','MODEL BROKER AUTHORIZATION EXCLUSIONS'])for(const row of(await q.query(replace(template.split('-- BEGIN '+marker+'\n')[1].split('\n\\gexec')[0]))).rows)await q.query(Object.values(row)[0] as string);
    await q.query('COMMIT');}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
  await owner.query("INSERT INTO communities VALUES($1,'Native Worker synthetic community')",[community]);
  await owner.query("INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Native Worker member','not-a-login',$4)",[user,community,user+'@example.invalid',randomUUID()]);
  await owner.query("INSERT INTO sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,clock_timestamp()+interval '1 hour')",[tokenHash(cookie),user,csrf]);
  const hyperdriveUrl=new URL(roleUrl(runtime));
  if(proxy){await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const address=proxy.address();assert(address&&typeof address==='object');
    hyperdriveUrl.hostname='127.0.0.1';hyperdriveUrl.port=String(address.port);hyperdriveUrl.searchParams.delete('host');}
  const tcp=hyperdriveUrl.href;
  directory=await mkdtemp(resolve('.wrangler/fp-composition-'));await mkdir(join(directory,'assets'));await writeFile(join(directory,'assets/index.html'),'<!doctype html><title>Native Worker test</title>');
  const bootstrap={environment:'staging-next',clientId,issuer:'https://issuer.test/',audience:origin+'/',bootstrapUri:origin+paths.status,beginUri:origin+paths.begin,pollUri:origin+paths.token,
    verificationUri:origin+'/device',clientDisplayName:'Native Worker synthetic client',issuerKid:'bootstrap-issuer',keys:[{kid:'bootstrap-issuer',purpose:'bootstrap_access',environment:'staging-next',
      publicJwk:await jwk(issuerKeys.publicKey),notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
  const profile={environment:'staging-next',platformOrigin:origin,clientId,issuer:'main-staging',audience:'broker-staging',brokerIdentity:'broker-staging',responseAudience:'main-staging',requestKid:'main-request',
    responseKeys:[{keyId:'broker-response',publicJwk:await jwk(responseKeys.publicKey)}],recoveryAuthority:'recovery-staging',recoveryKeys:[{keyId:'recovery-key',publicJwk:await jwk(recoveryKeys.publicKey)}],settingsSelections:[],bootstrap};
  const bindings={FREEDOM_ENV:'staging',APP_ORIGIN:origin,FREEDOM_RELEASE_SHA:'a'.repeat(40),FREEDOM_DATABASE_NAME:database,FREEDOM_PRIVATE_AI_ENABLED:'true',
    FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify(profile),FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify(await jwk(requestKeys.privateKey)),FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY:JSON.stringify(await jwk(issuerKeys.privateKey))};
  const unavailable="let calls=0; export default {fetch(request){if(new URL(request.url).pathname==='/counter')return Response.json({calls});calls++;return Response.json({code:'unavailable'},{status:503});}};";
  mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'platform-private-ai',modules:true,scriptPath:resolve(process.env.FREEDOM_WORKERD_BUNDLE_DIR??'.wrangler/dry-run/local','worker.js'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings,
    hyperdrives:{HYPERDRIVE:tcp},r2Buckets:{MEDIA:'synthetic-private-assets'},serviceBindings:{MODEL_BROKER:'broker-unavailable',CREDENTIAL_RECOVERY_STATE:'state-unavailable',CREDENTIAL_RECOVERY_FLOOR:'floor-unavailable'},
    assets:{directory:join(directory,'assets'),binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true},assetConfig:{not_found_handling:'none'}}},
    {name:'synthetic-ingress',modules:true,compatibilityDate:'2026-09-21',serviceBindings:{MAIN:'platform-private-ai'},script:"export default {fetch(request,env){const url=new URL(request.url);const headers=new Headers(request.headers);headers.set('Host','platform.test');const origin=headers.get('X-Synthetic-Origin');headers.delete('X-Synthetic-Origin');if(origin)headers.set('Origin',origin);return env.MAIN.fetch(new Request('https://platform.test'+url.pathname+url.search,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));}};"},
    ...['broker-unavailable','state-unavailable','floor-unavailable'].map(name=>({name,modules:true,script:unavailable,compatibilityDate:'2026-09-21'}))]}));await mf.ready;
});
after(async()=>{await mf?.dispose();for(const socket of sockets)socket.destroy();if(proxy?.listening)await new Promise<void>(r=>proxy.close(()=>r()));
  await app.end();await owner.end();await Promise.all(closedClients);try{if(created){await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);await admin.query(`DROP ROLE ${runtime},${migrator}`);}}finally{await admin.end();}
  if(directory)await rm(directory,{recursive:true,force:true});});
const call=async(path:string,init?:RequestInit)=>{const requestHeaders=new Headers(init?.headers);requestHeaders.set('Host',new URL(origin).host);if(requestHeaders.has('Origin')){requestHeaders.set('X-Synthetic-Origin',requestHeaders.get('Origin')!);requestHeaders.delete('Origin');}const worker=await mf.getWorker('synthetic-ingress');return worker.fetch(origin+path,{...init,headers:requestHeaders} as never) as unknown as Promise<Response>;};
const post=(path:string,body:unknown,h:Record<string,string>)=>call(path,{method:'POST',headers:h,body:JSON.stringify(body)});
async function expect(response:Response,status:number){assert.equal(response.status,status,await response.clone().text());return response;}
async function signed(key:CryptoKey,typ:string,payload:unknown,publicJwk?:unknown){return new CompactSign(new TextEncoder().encode(typeof payload==='string'?payload:JSON.stringify(payload))).setProtectedHeader({alg:'ES256',typ,...(publicJwk?{jwk:publicJwk as never}:{})}).sign(key);}
async function noBrokerCalls(){for(const name of ['broker-unavailable','state-unavailable','floor-unavailable']){const worker=await mf.getWorker(name);assert.equal((await(await worker.fetch('https://internal.test/counter')).json() as {calls:number}).calls,0);}}
test('actual Wrangler Worker installs member SQL metadata on restricted Hyperdrive role without broker/recovery availability',async()=>{
  const response=await expect(await call('/api/v1/me/model-settings',{headers}),200),dto=MemberModelSettingsOverviewSchema.parse(await response.json());
  assert.deepEqual(dto.connections,[]);assert.equal(dto.setup.state,'unavailable');assert.equal(dto.operational_authority,false);
  const anonymous=await call('/api/v1/me/model-settings');assert.equal(anonymous.status,401);
  await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),error=>(error as {code:string}).code==='42501');
  const role=(await app.query('SELECT rolsuper,rolcreaterole,rolcreatedb,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.deepEqual(role,{rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolbypassrls:false});
  await noBrokerCalls();
});
test('actual Wrangler Worker genuine bootstrap pairing, member approval, one-time exchange and revocation use current SQL authority',{timeout:30000},async()=>{
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),publicJwk=await jwk(keys.publicKey);
  const base={client_id:clientId,environment:'staging-next',runtime_kind:'agent-kit',scope:'bootstrap.status.read',jti:randomUUID(),iat:Math.floor(Date.now()/1000),htm:'POST'};
  const beginProof=await signed(keys.privateKey,'freedom-device-pairing+jwt',{...base,purpose:'device_pairing_begin',htu:origin+paths.begin},publicJwk);
  const authorization=DeviceAuthorizationBeginResultSchema.parse(await(await expect(await post(paths.begin,{publicJwk,runtimeKind:'agent-kit'},{'Content-Type':'application/json',DPoP:beginProof}),201)).json());
  const review=await(await expect(await post(paths.inspect,{userCode:authorization.userCode},headers),200)).json() as {authorizationId:string;requestDigest:string};
  await expect(await post(paths.decide,{userCode:authorization.userCode,authorizationId:review.authorizationId,requestDigest:review.requestDigest,decision:'approve'},{...headers,'Idempotency-Key':randomUUID()}),200);
  const poll=async(enrollmentProof?:string)=>{const proof=await signed(keys.privateKey,'freedom-device-pairing+jwt',{...base,jti:randomUUID(),iat:Math.floor(Date.now()/1000),purpose:'device_pairing_poll',htu:origin+paths.token,
      authorization_id:authorization.authorizationId,nonce:authorization.nonce,request_digest:authorization.requestDigest,device_code_hash:createHash('sha256').update(authorization.deviceCode,'ascii').digest('base64url')},publicJwk);
    return post(paths.token,{grantType:'device_code',authorizationId:authorization.authorizationId,deviceCode:authorization.deviceCode,...(enrollmentProof?{enrollmentProof}:{})},{'Content-Type':'application/json',DPoP:proof});};
  const challenge=DeviceAuthorizationPollResultSchema.parse(await(await expect(await poll(),200)).json());assert.equal(challenge.status,'proof_required');if(challenge.status!=='proof_required')throw Error('Missing actual challenge');
  await new Promise(r=>setTimeout(r,challenge.interval*1000+20));const enrollmentProof=await signed(keys.privateKey,'freedom-runtime-enrollment+jws',challenge.challenge.payload);
  const issued=DeviceAuthorizationPollResultSchema.parse(await(await expect(await poll(enrollmentProof),200)).json());assert.equal(issued.status,'issued');if(issued.status!=='issued')throw Error('Missing actual issuance');
  await expect(await poll(enrollmentProof),401);
  const list=await(await expect(await call(paths.list,{headers}),200)).json() as {items:{connectionId:string}[];operational_authority:boolean};assert.equal(list.operational_authority,false);assert.equal(list.items[0].connectionId,issued.connectionId);
  await expect(await post(paths.list+'/'+issued.connectionId+':revoke',{},{...headers,'Idempotency-Key':randomUUID(),'If-Match':'"1"'}),200);
  assert.equal((await owner.query('SELECT state FROM bootstrap_refresh_families WHERE family_id=$1',[issued.refresh.familyId])).rows[0].state,'revoked');
  const refreshProof=await signed(keys.privateKey,'freedom-bootstrap-refresh+jwt',{purpose:'bootstrap_refresh',client_id:clientId,environment:'staging-next',connection_id:issued.connectionId,family_id:issued.refresh.familyId,
    generation:issued.refresh.generation,refresh_handle_hash:createHash('sha256').update(issued.refresh.handle,'ascii').digest('base64url'),jti:randomUUID(),iat:Math.floor(Date.now()/1000),htm:'POST',htu:origin+paths.token},publicJwk);
  await expect(await post(paths.token,{grantType:'refresh_token',familyId:issued.refresh.familyId,refreshHandle:issued.refresh.handle},{'Content-Type':'application/json',DPoP:refreshProof}),401);
  await noBrokerCalls();assert.equal((await owner.query('SELECT count(*)::int n FROM model_text_steps')).rows[0].n,0);
});
