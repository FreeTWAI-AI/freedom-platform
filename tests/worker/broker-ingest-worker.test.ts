import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash,randomUUID,randomBytes} from 'node:crypto';
import {createServer as netServer,createConnection,type Socket} from 'node:net';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {CompactSign,compactVerify,exportJWK,generateKeyPair} from 'jose';
import {Pool} from 'pg';
import {migrate} from '../../scripts/database.js';
import {authenticate,hashPasswordAsync,login} from '../../modules/identity-membership/service.js';
import {withMemberScope} from '../../packages/resource-scopes/index.js';
import {createDeviceAuthorizations} from '../../modules/agent-control/device-authorizations.js';
import {createBootstrapSessions} from '../../modules/agent-control/bootstrap-sessions.js';
import {createRuntimeRegistrationChallenge,parseRuntimePublicJwk} from '../../modules/agent-control/runtime-proof.js';
import {createExecutionPrerequisites} from '../../modules/agent-execution/prerequisites.js';
import {createCredentialIngestAuthorizations} from '../../modules/agent-control/credential-ingest-authorizations.js';
import {createCredentialIngestClient} from '../../apps/platform-api/src/credential-ingest-client.js';
import {createMemberCredentialIngestHttpTransport} from '../../apps/platform-api/src/routes/member-credential-ingest-http.js';
import {canonicalEd25519Component} from '../../apps/credential-broker/src/worker-keys.js';
import type {BootstrapSessionHost} from '../../contracts/execution/v1/bootstrap-session.js';
import type {ModelSelection} from '../../contracts/execution/v1/member-execution.js';
import {brokerBundleModules} from './broker-fixtures/bundle-modules.js';

// Native workerd coverage for the broker Worker direct setup host. Main side is
// the real main ingest client/route on the app role; broker side is the actual
// Wrangler bundle. Synthetic keys, readiness and DB only: this is not owner,
// provider, capture-disabled or deployment acceptance.
const environment='staging-next' as const,clientId='native-broker-ingest',mainOrigin='https://staging.freetwai.com',setupOrigin='https://credential-setup.staging.freetwai.test';
const ingestIssuer='synthetic-main-ingest',ingestAudience='synthetic-broker-ingest';
const modelSelection:ModelSelection={providerRef:'openai',modelRef:'synthetic-model',processingLocation:'provider_remote',artifactCustody:'platform_asset',credentialCustody:'platform_vault',engineLocation:'platform',billingSource:'user_byok'};
const secret='SYNTHETIC_NATIVE_INGEST_SECRET_ONLY';
const requiredCsp="default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'";
const iso=(time=Date.now())=>new Date(time).toISOString();
const hash=(value:string)=>createHash('sha256').update(value,'ascii').digest('base64url');
async function minimalJwk(key:CryptoKey){const {kty,crv,x,y,d}=await crypto.subtle.exportKey('jwk',key);return {kty,crv,x,...(y?{y}:{}),...(d?{d}:{})} as {kty:'OKP';crv:'Ed25519';x:string;d?:string};}
const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
/** Same 32 bytes, different 43-char string: flip an unused trailing pad bit. */
function padAlias(x:string){const last=alphabet.indexOf(x.at(-1)!);return x.slice(0,-1)+alphabet[last^1];}
async function template(owner:Pool,file:string,role:string,variable:string) {
  const source=(await readFile(new URL('../../deploy/cloudflare/sql/'+file,import.meta.url),'utf8')).replace(/^\\set .*$/mg,'').replaceAll(':"'+variable+'"','"'+role+'"').replaceAll(":'"+variable+"'","'"+role+"'");
  const q=await owner.connect();try{const pieces=source.split('\\gexec');for(let i=0;i<pieces.length;i++){const result=await q.query(pieces[i]);if(i<pieces.length-1){const last=Array.isArray(result)?result[result.length-1]:result;for(const row of last.rows)await q.query(Object.values(row)[0] as string);}}}catch(error){await q.query('ROLLBACK');throw error;}finally{q.release();}
}

test('canonical Ed25519 JWK components reject pad-bit aliases and wrong lengths',()=>{
  const x=Buffer.from(randomBytes(32)).toString('base64url');assert.equal(canonicalEd25519Component(x),x);
  for(const bad of [padAlias(x),x.slice(0,42),x+'A','A'.repeat(42)+'=',x.slice(0,42)+'+',undefined])assert.throws(()=>canonicalEd25519Component(bad));
});

test('actual broker Worker setup host: main-signed bootstrap, native secret body, vault commit and fail-closed variants',{timeout:120000},async()=>{
  const raw=process.env.TEST_DATABASE_URL;if(!raw||!/^\/fp_[a-z0-9_]+$/.test(new URL(raw).pathname))throw Error('Owned fp_* test database URL required');
  const adminUrl=new URL(raw),socket=adminUrl.searchParams.get('host');if(!socket&&!['127.0.0.1','localhost','[::1]'].includes(adminUrl.hostname))throw Error('Owned loopback/socket DB only');
  const database='freedom_staging_next',roles={owner:'fp_bi_owner_'+process.pid,app:'fp_bi_app_'+process.pid,broker:'freedom_staging_next_broker',executor:'freedom_staging_next_broker_executor'},password=randomBytes(24).toString('hex');
  const admin=new Pool({connectionString:raw}),roleUrl=(role:string)=>{const url=new URL(raw);url.pathname='/'+database;url.username=role;url.password=password;return url.href;};
  const owner=new Pool({connectionString:roleUrl(roles.owner)}),app=new Pool({connectionString:roleUrl(roles.app)}),cipher=new Pool({connectionString:roleUrl(roles.broker)});
  const closedClients:Promise<void>[]=[];
  for(const pool of [owner,app,cipher])pool.on('connect',client=>closedClients.push(new Promise<void>(resolve=>client.once('end',resolve))));
  const sockets=new Set<Socket>(),proxy=socket?netServer(client=>{const upstream=createConnection(join(socket,'.s.PGSQL.5432'));for(const s of [client,upstream]){sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{client.destroy();upstream.destroy();});}client.pipe(upstream).pipe(client);}):undefined;
  let created=false,mf:Miniflare|undefined,directory:string|undefined;
  try{
    await admin.query(Object.values(roles).map(role=>`CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT`).join(';'));
    await admin.query(`CREATE DATABASE ${database} OWNER ${roles.owner}`);created=true;await migrate(owner);
    await template(owner,'20-runtime-grants.psql',roles.app,'runtime');await template(owner,'40-credential-broker-grants.psql',roles.broker,'broker');await template(owner,'45-model-broker-execution-grants.psql',roles.executor,'executor');
    let port:string|undefined;if(proxy){await new Promise<void>(r=>proxy.listen(0,'127.0.0.1',r));const address=proxy.address();assert(address&&typeof address==='object');port=String(address.port);}
    const hyperdrive=(role:string)=>{const url=new URL(roleUrl(role));if(proxy){url.hostname='127.0.0.1';url.port=port!;url.searchParams.delete('host');}return url.href;};
    const gen=()=>crypto.subtle.generateKey('Ed25519',true,['sign','verify']) as Promise<CryptoKeyPair>;
    const [execRequest,execResponse,recoveryKeys,mainIngest,ingestResponse,readinessKeys,unrelated]=await Promise.all([gen(),gen(),gen(),gen(),gen(),gen(),gen()]);
    const now=Date.now(),recoveryExpires=iso(now+240000);
    const signedState=await new CompactSign(new TextEncoder().encode(JSON.stringify({profile:'credential-broker.recovery/v1',purpose:'credential-broker.recovery',authority:'synthetic-recovery',environment,generation:'1',issuedAt:iso(now),expiresAt:recoveryExpires}))).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-recovery+jws',kid:'recovery'}).sign(recoveryKeys.privateKey);
    const recover=async()=>({generation:'1',expiresAt:recoveryExpires});
    const pin=async(keyId:string,key:CryptoKey)=>({keyId,publicJwk:await minimalJwk(key)});
    const ingest={setupOrigin,issuer:ingestIssuer,audience:ingestAudience,requestKeys:[await pin('main-ingest',mainIngest.publicKey)],responseIssuer:'synthetic-broker-ingest-response',
      responseAudience:'synthetic-main-ingest-response',responseKeyId:'broker-ingest',readinessAuthority:'synthetic-readiness',readinessKeys:[await pin('readiness',readinessKeys.publicKey)]};
    const workerProfile={environment,platformOrigin:mainOrigin,clientId,issuer:'synthetic-main',requestAudience:'synthetic-broker',brokerId:'synthetic-broker',responseAudience:'synthetic-main',responseKeyId:'response',
      requestKeys:[await pin('request',execRequest.publicKey)],recoveryKeys:[await pin('recovery',recoveryKeys.publicKey)],recoveryAuthority:'synthetic-recovery',databaseName:database,cipherRole:roles.broker,executorRole:roles.executor,currentKekId:'test-kek',ingest};
    const kek=crypto.getRandomValues(new Uint8Array(32));
    const execJwk=await minimalJwk(execResponse.privateKey),ingestJwk=await minimalJwk(ingestResponse.privateKey),unrelatedX=(await minimalJwk(unrelated.publicKey)).x;
    const bindings={FREEDOM_BROKER_ENABLED:'true',FREEDOM_BROKER_ENVIRONMENT:environment,APP_ORIGIN:mainOrigin,FREEDOM_BROKER_PROFILE:JSON.stringify(workerProfile),
      FREEDOM_BROKER_RESPONSE_KEY:JSON.stringify(execJwk),FREEDOM_BROKER_INGEST_RESPONSE_KEY:JSON.stringify(ingestJwk),
      FREEDOM_BROKER_KEKS:JSON.stringify([{keyId:'test-kek',jwk:{kty:'oct',k:Buffer.from(kek).toString('base64url')}}])};kek.fill(0);
    const profileWith=(change:(p:typeof workerProfile)=>void)=>{const p=structuredClone(workerProfile);change(p);return JSON.stringify(p);};
    directory=await mkdtemp(resolve('.wrangler/broker-ingest-'));
    const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--config','wrangler.broker.example.jsonc','--env','staging-next','--outdir',directory],{maxBuffer:1024*1024});
    const brokerWorker={name:'broker',modules:brokerBundleModules(directory),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],bindings,
      hyperdrives:{CIPHER_HYPERDRIVE:hyperdrive(roles.broker),EXECUTOR_HYPERDRIVE:hyperdrive(roles.executor)},r2Buckets:{MEDIA:'synthetic-broker-private-assets'},
      serviceBindings:{CREDENTIAL_RECOVERY_STATE:'recovery-state',CREDENTIAL_RECOVERY_FLOOR:'recovery-floor',CREDENTIAL_INGEST_READINESS:'readiness'}};
    const variant=(name:string,changes:Record<string,string|undefined>,serviceBindings:Record<string,string>=brokerWorker.serviceBindings)=>({...brokerWorker,name,serviceBindings,
      bindings:Object.fromEntries(Object.entries({...bindings,...changes}).filter(([,v])=>v!==undefined)) as Record<string,string>});
    const {CREDENTIAL_INGEST_READINESS:_omit,...withoutReadiness}=brokerWorker.serviceBindings;
    const variants=[
      variant('no-ingest',{FREEDOM_BROKER_PROFILE:profileWith(p=>{delete (p as {ingest?:unknown}).ingest;})}),
      variant('no-readiness-binding',{},withoutReadiness),
      variant('missing-ingest-key',{FREEDOM_BROKER_INGEST_RESPONSE_KEY:undefined}),
      // workerd imports {x:unrelated,d:real}; the sign/verify proof must refuse both secrets.
      variant('mismatch-ingest-key',{FREEDOM_BROKER_INGEST_RESPONSE_KEY:JSON.stringify({...ingestJwk,x:unrelatedX})}),
      variant('mismatch-exec-key',{FREEDOM_BROKER_RESPONSE_KEY:JSON.stringify({...execJwk,x:unrelatedX})}),
      variant('ingest-equals-exec-key',{FREEDOM_BROKER_INGEST_RESPONSE_KEY:JSON.stringify(execJwk)}),
      // Noncanonical pad-bit aliases of identities already used by another purpose.
      variant('alias-ingest-response',{FREEDOM_BROKER_INGEST_RESPONSE_KEY:JSON.stringify({...ingestJwk,x:padAlias(ingestJwk.x)})}),
      variant('alias-readiness-of-response',{FREEDOM_BROKER_PROFILE:profileWith(p=>{p.ingest.readinessKeys[0].publicJwk.x=padAlias(ingestJwk.x);})}),
      variant('alias-ingest-pin-of-exec-pin',{FREEDOM_BROKER_PROFILE:profileWith(p=>{p.ingest.requestKeys[0].publicJwk.x=padAlias(p.requestKeys[0].publicJwk.x);})}),
      variant('reuse-exec-pin-as-ingest-pin',{FREEDOM_BROKER_PROFILE:profileWith(p=>{p.ingest.requestKeys[0].publicJwk.x=p.requestKeys[0].publicJwk.x;})}),
      variant('same-host-setup',{FREEDOM_BROKER_PROFILE:profileWith(p=>{p.ingest.setupOrigin=mainOrigin;})}),
    ];
    const readinessScript=`let signed=null;export default {async fetch(request){const url=new URL(request.url);if(url.pathname==='/set'){signed=(await request.json()).signed;return new Response('ok');}if(url.pathname!=='/internal/credential-ingest/readiness'||signed===null)return new Response('',{status:503});return Response.json({signedReadiness:signed});}};`;
    // Synthetic ingress reconstructs the exact requested headers and a known-length
    // body inside workerd. Miniflare's Node proxy otherwise adds Host/transport
    // headers and Undici rewrites Sec-Fetch-Mode. This is not live edge evidence.
    const ingress={name:'synthetic-ingress',modules:true,compatibilityDate:'2026-09-21',
      serviceBindings:Object.fromEntries([brokerWorker,...variants].map(w=>[w.name,w.name])),
      script:`export default {async fetch(request,env){const p=await request.json();const headers=new Headers(p.headers);headers.set('Host',new URL(p.url).host);const body=p.body===null?undefined:Uint8Array.from(p.body).buffer;return env[p.target].fetch(new Request(p.url,{method:p.method,headers,body}));}};`};
    mf=new Miniflare(convertV4MiniflareOptions({workers:[brokerWorker,...variants,ingress,
      {name:'readiness',modules:true,script:readinessScript,compatibilityDate:'2026-09-21'},
      {name:'recovery-state',modules:true,script:`export default {fetch(){return Response.json({signedState:${JSON.stringify(signedState)}});}};`,compatibilityDate:'2026-09-21'},
      {name:'recovery-floor',modules:true,script:`export default {fetch(){return Response.json({generation:'1',expiresAt:${JSON.stringify(recoveryExpires)}});}};`,compatibilityDate:'2026-09-21'}]}));await mf.ready;
    const ingressWorker=await mf.getWorker('synthetic-ingress');
    const worker=(target:string)=>({async fetch(url:string,init:RequestInit={}){
      const body=init.body===undefined||init.body===null?null:typeof init.body==='string'?new TextEncoder().encode(init.body):init.body;
      if(body!==null&&!(body instanceof Uint8Array))throw Error('Synthetic ingress expects bytes');
      return ingressWorker.fetch('https://synthetic-ingress.test/',{method:'POST',body:JSON.stringify({target,url,method:init.method??'GET',headers:[...new Headers(init.headers)],body:body===null?null:[...body]})}) as unknown as Promise<Response>;
    }});
    const broker=worker('broker'),readiness=await mf.getWorker('readiness');
    async function setReadiness(claims:Record<string,unknown>|null,key=readinessKeys.privateKey,kid='readiness'){
      const signed=claims===null?null:await new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({alg:'EdDSA',typ:'freedom-credential-capture-readiness+jws',kid}).sign(key);
      assert.equal((await readiness.fetch('https://readiness.internal/set',{method:'POST',body:JSON.stringify({signed})})).status,200);
    }
    const readyClaims=(change:Record<string,unknown>={})=>{const t=Date.now();return {profile:'credential-broker.capture-readiness/v1',purpose:'credential-broker.capture-readiness',authority:'synthetic-readiness',environment,origin:setupOrigin,captureDisabled:true,issuedAt:iso(t-1000),expiresAt:iso(t+50000),...change};};

    // Main: actual ingest client + member route on the ordinary app role.
    const mainAuthorizations=createCredentialIngestAuthorizations(app,{environment,clientId,issuer:ingestIssuer,audience:ingestAudience,setupOrigin,recover});
    const client=await createCredentialIngestClient(app,{origin:mainOrigin,environment,clientId,setupOrigin,issuer:ingestIssuer,audience:ingestAudience,keyId:'main-ingest',signingKey:mainIngest.privateKey,authorizations:mainAuthorizations});
    const mainRoute=await createMemberCredentialIngestHttpTransport(app,{origin:mainOrigin,environment,clientId,ingest:client});
    const prerequisites=createExecutionPrerequisites(app,{environment,clientId});
    async function member(){
      const user=randomUUID(),community=randomUUID(),email=user+'@example.invalid';
      await owner.query("INSERT INTO communities VALUES($1,'Synthetic ingest community')",[community]);
      await owner.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref) VALUES($1,$2,$3,'Synthetic ingest owner',$4,$5)`,[user,community,email,await hashPasswordAsync('synthetic-password-only'),randomUUID()]);
      const session=await login(app,email,'synthetic-password-only');const actor=await authenticate(app,session.token);
      await withMemberScope(app,{actor,scope:'personal'},async()=>{},async()=>{});
      return {actor,token:session.token,headers:{Cookie:'__Host-freedom_session='+session.token,'X-CSRF-Token':actor.csrf_token,Origin:mainOrigin}};
    }
    async function model(human:Awaited<ReturnType<typeof member>>){
      const issuer=await generateKeyPair('ES256'),device=await generateKeyPair('ES256'),publicJwk=parseRuntimePublicJwk(await exportJWK(device.publicKey));
      const host:BootstrapSessionHost={environment,clientId,issuerKid:'pairing-issuer',issuer:'https://issuer.example.invalid/',audience:'https://platform.example.invalid/',bootstrapUri:'https://platform.example.invalid/execution-api/v1/bootstrap',refreshUri:'https://platform.example.invalid/execution-api/v1/auth/refresh',nonceUri:'https://platform.example.invalid/execution-api/v1/auth/nonce',keys:[{kid:'pairing-issuer',purpose:'bootstrap_access',environment,publicJwk:parseRuntimePublicJwk(await exportJWK(issuer.publicKey)),notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
      const {refreshUri:_r,nonceUri:_n,...baseHost}=host;
      const pairingHost={...baseHost,beginUri:'https://platform.example.invalid/device/begin',pollUri:'https://platform.example.invalid/device/poll',verificationUri:'https://platform.example.invalid/device',clientDisplayName:'Synthetic ingest device'};
      const pairing=await createDeviceAuthorizations(app,{host:pairingHost,signingKey:issuer.privateKey}),sessions=await createBootstrapSessions(app,{host,signingKey:issuer.privateKey});
      const sign=(typ:string,claims:Record<string,unknown>)=>new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader({alg:'ES256',typ,jwk:publicJwk}).sign(device.privateKey);
      const clock=async()=>Number((await owner.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text ms')).rows[0].ms);
      const base={client_id:clientId,environment,runtime_kind:'agent-kit',scope:'bootstrap.status.read',htm:'POST'};
      const started=await pairing.begin({publicJwk,runtimeKind:'agent-kit',proof:await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_begin',jti:randomUUID(),iat:Math.floor(await clock()/1000),htu:pairingHost.beginUri})});
      await pairing.decide(human.actor,{key:randomUUID(),userCode:started.userCode,authorizationId:started.authorizationId,requestDigest:started.requestDigest,decision:'approve'});
      const row=(await owner.query('SELECT c.* FROM runtime_registration_challenges c JOIN device_authorizations a USING(challenge_id) WHERE a.authorization_id=$1',[started.authorizationId])).rows[0];
      const challenge=createRuntimeRegistrationChallenge({challenge_id:row.challenge_id,runtime_device_id:row.runtime_device_id,owner_member_id:row.owner_user_id,owner_principal_id:row.owner_principal_id,scope_id:row.scope_id,environment:row.environment,key_thumbprint:row.key_thumbprint,nonce:row.nonce,issued_at:row.issued_at.toISOString(),expires_at:row.expires_at.toISOString()});
      const enrollmentProof=await new CompactSign(new TextEncoder().encode(challenge.payload)).setProtectedHeader({alg:'ES256',typ:'freedom-runtime-enrollment+jws'}).sign(device.privateKey);
      const initial=await pairing.poll({authorizationId:started.authorizationId,deviceCode:started.deviceCode,enrollmentProof,proof:await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_poll',jti:randomUUID(),iat:Math.floor(await clock()/1000),htu:pairingHost.pollUri,authorization_id:started.authorizationId,request_digest:started.requestDigest,nonce:started.nonce,device_code_hash:hash(started.deviceCode)})});
      assert.equal(initial.status,'issued');if(initial.status!=='issued')throw Error('Pairing did not issue');
      await sessions.refresh({familyId:initial.refresh.familyId,refreshHandle:initial.refresh.handle,proof:await sign('freedom-bootstrap-refresh+jwt',{purpose:'bootstrap_refresh',client_id:clientId,environment,connection_id:initial.connectionId,family_id:initial.refresh.familyId,generation:initial.refresh.generation,refresh_handle_hash:hash(initial.refresh.handle),jti:randomUUID(),iat:Math.floor(await clock()/1000),htm:'POST',htu:host.refreshUri})});
      return prerequisites.models.create(human.actor,{key:randomUUID(),connectionId:initial.connectionId,expectedConnectionVersion:'1',selection:modelSelection});
    }
    async function handoff(human:Awaited<ReturnType<typeof member>>,modelConnectionId:string){
      const response=await mainRoute.fetch(new Request(mainOrigin+'/api/v1/me/credential-ingests',{method:'POST',headers:{...human.headers,'Content-Type':'application/json','Idempotency-Key':randomUUID(),'If-Match':'"1"'},body:JSON.stringify({operation:'create',modelConnectionId,consent:true})}));
      assert.equal(response.status,201,await response.clone().text());return await response.json() as {authorizationRef:string;nonce:string;assertion:string;setupOrigin:string;expiresAt:string;operational_authority:false};
    }
    const navigation={'Content-Type':'application/x-www-form-urlencoded',Origin:mainOrigin,'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document','Sec-Fetch-User':'?1'};
    const bootstrap=(worker:typeof broker,assertion:string,extra:Record<string,string>={})=>worker.fetch(setupOrigin+'/credential-setup',{method:'POST',redirect:'manual',headers:{...navigation,...extra},body:'assertion='+assertion});
    const asset=(name:string)=>worker(name).fetch(setupOrigin+'/credential-setup.css');
    const readOutcome=async(human:Awaited<ReturnType<typeof member>>,ref:string)=>{const r=await mainRoute.fetch(new Request(mainOrigin+'/api/v1/me/credential-ingests/'+ref,{headers:human.headers}));assert.equal(r.status,200,await r.clone().text());return await r.json() as {state:string;credential:unknown;operational_authority:false};};

    // Composition: actual bundle serves the protected asset only with a complete, separated profile.
    await setReadiness(readyClaims());
    const css=await asset('broker');assert.equal(css.status,200,await css.clone().text());assert.equal(css.headers.get('Content-Type'),'text/css; charset=utf-8');
    const brand=await broker.fetch(setupOrigin+'/credential-setup-brand.webp');assert.equal(brand.status,200);
    assert.deepEqual(new Uint8Array(await brand.arrayBuffer()),new Uint8Array(await readFile(new URL('../../apps/portal-web/public/brand/freedom-workshop.webp',import.meta.url))));
    assert.equal((await asset('no-ingest')).status,403,'profile without ingest never serves a setup host');
    assert.equal((await asset('same-host-setup')).status,403,'same-host setup must not serve the separate protected host');
    for(const name of variants.slice(1).map(v=>v.name).filter(name=>name!=='same-host-setup')){const r=await asset(name);assert.equal(r.status,503,name);assert.deepEqual(await r.json(),{code:'credential_ingest_unavailable',operational_authority:false});}
    assert.equal((await broker.fetch('https://foreign-setup.staging.freetwai.test/credential-setup.css')).status,403);
    assert.equal((await broker.fetch(mainOrigin+'/credential-setup.css')).status,403);
    const bridgeMismatch=await worker('mismatch-exec-key').fetch('https://freedom-private-ai.internal/internal/model-execution',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(bridgeMismatch.status,503,'mismatched execution response JWK also disables the bridge');

    const human=await member(),modelConnection=await model(human);
    const first=await handoff(human,modelConnection.modelConnectionId);
    assert.equal(first.setupOrigin,setupOrigin);assert.equal(first.operational_authority,false);

    // Readiness withdrawn/stale/foreign: no cookie, authorization not consumed.
    const noCookie=(r:{headers:{getSetCookie():string[]}})=>assert.equal(r.headers.getSetCookie().length,0);
    for(const claims of [null,readyClaims({origin:'https://other.staging.freetwai.test'}),readyClaims({environment:'next'}),readyClaims({authority:'other-authority'}),
      readyClaims({issuedAt:iso(Date.now()-120000),expiresAt:iso(Date.now()-60000)}),readyClaims({expiresAt:iso(Date.now()+120000)})]){
      await setReadiness(claims);const r=await bootstrap(broker,first.assertion);assert.equal(r.status,503,JSON.stringify(claims));noCookie(r);
    }
    await setReadiness(readyClaims(),unrelated.privateKey);{const r=await bootstrap(broker,first.assertion);assert.equal(r.status,503);noCookie(r);}
    assert.equal((await readOutcome(human,first.authorizationRef)).state,'issued');
    await setReadiness(readyClaims());

    // Header/origin profile: unknown header and wrong Origin are still rejected before any claim.
    {const r=await bootstrap(broker,first.assertion,{'X-Unknown-Edge':'1'});assert.equal(r.status,403);noCookie(r);}
    {const r=await bootstrap(broker,first.assertion,{Origin:setupOrigin});assert.equal(r.status,403);noCookie(r);}
    {const r=await bootstrap(broker,first.assertion,{'Sec-Fetch-Site':'same-origin'});assert.equal(r.status,403);noCookie(r);}
    assert.equal((await readOutcome(human,first.authorizationRef)).state,'issued');

    // Positive bootstrap with Cloudflare edge-added headers (finite strip list).
    const page=await bootstrap(broker,first.assertion,{'CF-Ray':'0000000000000000-SJC','CF-Connecting-IP':'192.0.2.1','X-Forwarded-For':'192.0.2.1','X-Forwarded-Proto':'https','CF-Visitor':'{"scheme":"https"}'});
    const html=await page.text();assert.equal(page.status,200,html);
    assert.equal(page.headers.get('Content-Security-Policy'),requiredCsp);assert.equal(page.headers.get('Cache-Control'),'private, no-store');
    const cookies=page.headers.getSetCookie();assert.equal(cookies.length,1);
    const cookieMatch=/^__Host-fp_broker_setup=([A-Za-z0-9_-]{43}); Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=\d+$/.exec(cookies[0]);assert(cookieMatch,cookies[0]);
    const csrf=/data-csrf="([A-Za-z0-9_-]{43})"/.exec(html)?.[1];assert(csrf);assert(!html.includes(first.assertion));
    assert.equal((await readOutcome(human,first.authorizationRef)).state,'setup_claimed');
    {const r=await bootstrap(broker,first.assertion);assert.equal(r.status,403,'bootstrap is one-use');noCookie(r);}
    const setupHeaders={Origin:setupOrigin,Cookie:'__Host-fp_broker_setup='+cookieMatch[1],'X-FP-Broker-CSRF':csrf,'Sec-Fetch-Site':'same-origin','Sec-Fetch-Mode':'same-origin','Sec-Fetch-Dest':'empty'};

    // Secret before prepare is refused; service-level tests separately cover lazy body reads.
    {const r=await broker.fetch(setupOrigin+'/credential-setup/secret',{method:'POST',headers:{...setupHeaders,'Content-Type':'application/octet-stream'},body:new TextEncoder().encode(secret)});
      assert.equal(r.status,409);assert.deepEqual(await r.json(),{code:'credential_ingest_submission_consumed',operational_authority:false});}
    assert.equal((await readOutcome(human,first.authorizationRef)).state,'setup_claimed','premature submission cannot claim or commit SQL');
    const second=first,h2=setupHeaders;
    {const r=await broker.fetch(setupOrigin+'/credential-setup/prepare',{method:'POST',headers:{...h2,'X-FP-Broker-CSRF':randomBytes(32).toString('base64url'),'Content-Type':'application/json'},body:'{"consent":true}'});assert.equal(r.status,403,'foreign CSRF rejected');}
    const prepared=await broker.fetch(setupOrigin+'/credential-setup/prepare',{method:'POST',headers:{...h2,'Content-Type':'application/json'},body:'{"consent":true}'});
    assert.equal(prepared.status,200,await prepared.clone().text());const preparedBody=await prepared.json() as {expiresAt:string;operational_authority:false};assert.equal(preparedBody.operational_authority,false);
    const submitted=await broker.fetch(setupOrigin+'/credential-setup/secret',{method:'POST',headers:{...h2,'Content-Type':'application/octet-stream'},body:new TextEncoder().encode(secret)});
    const submittedText=await submitted.text();assert.equal(submitted.status,200,submittedText);assert(!submittedText.includes(secret));
    assert.match(submitted.headers.getSetCookie()[0],/^__Host-fp_broker_setup=; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=0$/);
    const response=(JSON.parse(submittedText) as {response:string}).response;
    await assert.rejects(compactVerify(response,execResponse.publicKey),'ingest response is not signed by the execution response key');
    const verified=await compactVerify(response,ingestResponse.publicKey);assert.equal(verified.protectedHeader.kid,'broker-ingest');
    const claims=JSON.parse(new TextDecoder().decode(verified.payload));
    assert.equal(claims.purpose,'credential-broker.ingest-response');assert.equal(claims.authorizationRef,second.authorizationRef);assert.equal(claims.outcome.kind,'metadata');assert.equal(claims.operational_authority,false);
    const outcome=await readOutcome(human,second.authorizationRef);assert.equal(outcome.state,'committed');assert(outcome.credential);assert(!JSON.stringify(outcome).includes(secret));
    const vault=(await cipher.query('SELECT * FROM broker_credential_vault')).rows;assert.equal(vault.length,1);assert(!JSON.stringify(vault).includes(secret));assert(!JSON.stringify(vault).includes(Buffer.from(secret).toString('base64')));
    await assert.rejects(app.query('SELECT envelope FROM broker_credential_vault'),error=>(error as {code:string}).code==='42501');
    // Replay of the consumed setup: registry entry gone, still one credential.
    {const r=await broker.fetch(setupOrigin+'/credential-setup/secret',{method:'POST',headers:{...h2,'Content-Type':'application/octet-stream'},body:new TextEncoder().encode(secret)});assert.equal(r.status,403);}
    assert.equal((await cipher.query('SELECT count(*)::int n FROM broker_credential_vault')).rows[0].n,1);
  }finally{await mf?.dispose();for(const s of sockets)s.destroy();if(proxy?.listening)await new Promise<void>(r=>proxy.close(()=>r()));await Promise.all([owner.end(),app.end(),cipher.end()]);await Promise.all(closedClients);if(created){await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);await admin.query(`DROP ROLE ${Object.values(roles).join(',')}`);}await admin.end();if(directory)await rm(directory,{recursive:true,force:true});}
});
