import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {CompactSign} from 'jose';
import {DeviceAuthorizationBeginResultSchema,DeviceAuthorizationPollResultSchema} from '../../../contracts/execution/v1/device-pairing.js';
import {nativeBrokerSqlFixture,minimalJwk,profile,modelSelection} from './native-broker-sql.js';

type ExtensionContext=Parameters<NonNullable<Parameters<typeof nativeBrokerSqlFixture>[0]>>[0];
export type NativeBrokerFixture=Awaited<ReturnType<typeof nativeBrokerSqlFixture>>;
export type SyntheticMember=Awaited<ReturnType<NativeBrokerFixture['member']>>;
export const setupOrigin='https://synthetic-credential-setup.test';
export const ingestProfile={setupOrigin,issuer:'synthetic-main-ingest',audience:'synthetic-broker-ingest',keyId:'main-ingest'};

/** Actual Wrangler main bundle; generated keys and ingress are synthetic local
 * fixtures. This does not attest browser/public ingress or real owner consent. */
export async function installNativeMain(context:ExtensionContext,ingestKeys:CryptoKeyPair,setupWorker='broker') {
  const {directory,workers,mainOrigin,database,requestKeys,responseKeys,recoveryKeys,appHyperdrive}=context;
  const bootstrapKeys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']);
  const bootstrap={environment:profile.environment,clientId:profile.clientId,issuer:'https://synthetic-issuer.test/',audience:mainOrigin+'/',
    bootstrapUri:mainOrigin+'/execution-api/v1/bootstrap',beginUri:mainOrigin+'/execution-api/v1/auth/device-authorizations',pollUri:mainOrigin+'/execution-api/v1/auth/token',
    verificationUri:mainOrigin+'/device',clientDisplayName:'Synthetic native local integration',issuerKid:'bootstrap',keys:[{kid:'bootstrap',purpose:'bootstrap_access',
      environment:profile.environment,publicJwk:await minimalJwk(bootstrapKeys.publicKey),notBeforeMs:0,notAfterMs:Number.MAX_SAFE_INTEGER,revoked:false}]};
  const mainProfile={...profile,platformOrigin:mainOrigin,brokerIdentity:'synthetic-broker',responseAudience:'synthetic-main',requestKid:'request',
    responseKeys:[{keyId:'response',publicJwk:await minimalJwk(responseKeys.publicKey)}],recoveryAuthority:'synthetic-recovery',
    recoveryKeys:[{keyId:'recovery',publicJwk:await minimalJwk(recoveryKeys.publicKey)}],settingsSelections:[modelSelection],bootstrap,ingest:ingestProfile};
  const outdir=join(directory,'main');
  await promisify(execFile)(process.execPath,['node_modules/wrangler/bin/wrangler.js','deploy','--dry-run','--env','','--outdir',outdir],{maxBuffer:1024*1024});
  const assets=join(directory,'main-assets');await mkdir(assets);await writeFile(join(assets,'index.html'),'<!doctype html><title>Synthetic local private AI integration</title>');
  workers.push({name:'main',modules:true,scriptPath:join(outdir,'worker.js'),compatibilityDate:'2026-09-21',compatibilityFlags:['nodejs_compat'],
    bindings:{FREEDOM_ENV:'staging',APP_ORIGIN:mainOrigin,FREEDOM_RELEASE_SHA:'a'.repeat(40),FREEDOM_DATABASE_NAME:database,FREEDOM_PRIVATE_AI_ENABLED:'true',
      FREEDOM_PRIVATE_AI_PROFILE:JSON.stringify(mainProfile),FREEDOM_PRIVATE_AI_REQUEST_KEY:JSON.stringify(await minimalJwk(requestKeys.privateKey)),
      FREEDOM_PRIVATE_AI_INGEST_KEY:JSON.stringify(await minimalJwk(ingestKeys.privateKey)),FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY:JSON.stringify(await minimalJwk(bootstrapKeys.privateKey))},
    hyperdrives:{HYPERDRIVE:appHyperdrive},r2Buckets:{MEDIA:'synthetic-broker-private-assets'},
    serviceBindings:{MODEL_BROKER:'broker',CREDENTIAL_RECOVERY_STATE:'recovery-state',CREDENTIAL_RECOVERY_FLOOR:'recovery-floor'},
    assets:{directory:assets,binding:'ASSETS',routerConfig:{has_user_worker:true,invoke_user_worker_ahead_of_assets:true},assetConfig:{not_found_handling:'none'}}},
    {name:'synthetic-browser-ingress',modules:true,compatibilityDate:'2026-09-21',serviceBindings:{MAIN:'main',SETUP:setupWorker},bindings:{MAIN_ORIGIN:mainOrigin,SETUP_ORIGIN:setupOrigin},
      script:`export default {fetch(request,env){const url=new URL(request.url),setup=url.pathname.startsWith('/setup/');
        const path=url.pathname.slice(setup?6:5),origin=setup?env.SETUP_ORIGIN:env.MAIN_ORIGIN,headers=new Headers(request.headers);
        headers.set('Host',new URL(origin).host);const browserOrigin=headers.get('X-Synthetic-Origin');headers.delete('X-Synthetic-Origin');if(browserOrigin)headers.set('Origin',browserOrigin);
        return env[setup?'SETUP':'MAIN'].fetch(new Request(origin+path,{method:request.method,headers,body:['GET','HEAD'].includes(request.method)?undefined:request.body,redirect:'manual'}));}};`});
}
export async function nativeCall(f:NativeBrokerFixture,target:'main'|'setup',path:string,init:RequestInit={}) {
  const headers=new Headers(init.headers);if(headers.has('Origin')){headers.set('X-Synthetic-Origin',headers.get('Origin')!);headers.delete('Origin');}
  return (await f.mf.getWorker('synthetic-browser-ingress')).fetch('https://synthetic.test/'+target+path,{...init,headers} as never) as unknown as Promise<Response>;
}
export async function expectJson(response:Response,status=200){assert.equal(response.status,status,await response.clone().text());return response.json() as Promise<any>;}
export async function memberPost(f:NativeBrokerFixture,human:SyntheticMember,path:string,body:unknown,version:string|null='1',status=200){
  return expectJson(await nativeCall(f,'main',path,{method:'POST',headers:{...human.headers,'Content-Type':'application/json','Idempotency-Key':randomUUID(),
    ...(version===null?{}:{'If-Match':'"'+version+'"'})},body:JSON.stringify(body)}),status);
}
/** Actual native begin/review/approve/challenge/poll; synthetic member/device only. */
export async function nativePair(f:NativeBrokerFixture,human:SyntheticMember){
  const keys=await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'},true,['sign','verify']),publicJwk=await minimalJwk(keys.publicKey);
  const begin='/execution-api/v1/auth/device-authorizations',token='/execution-api/v1/auth/token';
  const sign=(typ:string,payload:unknown,jwk?:unknown)=>new CompactSign(new TextEncoder().encode(typeof payload==='string'?payload:JSON.stringify(payload)))
    .setProtectedHeader({alg:'ES256',typ,...(jwk?{jwk:jwk as never}:{})}).sign(keys.privateKey);
  const base={client_id:profile.clientId,environment:profile.environment,runtime_kind:'agent-kit',scope:'bootstrap.status.read',htm:'POST'};
  const devicePost=(path:string,body:unknown,proof:string)=>nativeCall(f,'main',path,{method:'POST',headers:{'Content-Type':'application/json',DPoP:proof},body:JSON.stringify(body)});
  const authorization=DeviceAuthorizationBeginResultSchema.parse(await expectJson(await devicePost(begin,{publicJwk,runtimeKind:'agent-kit'},
    await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_begin',jti:randomUUID(),iat:Math.floor(Date.now()/1000),htu:f.mainOrigin+begin},publicJwk)),201));
  const reviewed=await memberPost(f,human,'/api/v1/me/device-authorizations/inspect',{userCode:authorization.userCode},null);
  await memberPost(f,human,'/api/v1/me/device-authorizations/decide',{userCode:authorization.userCode,authorizationId:reviewed.authorizationId,requestDigest:reviewed.requestDigest,decision:'approve'},null);
  const poll=async(enrollmentProof?:string)=>DeviceAuthorizationPollResultSchema.parse(await expectJson(await devicePost(token,{grantType:'device_code',authorizationId:authorization.authorizationId,
    deviceCode:authorization.deviceCode,...(enrollmentProof?{enrollmentProof}:{})},await sign('freedom-device-pairing+jwt',{...base,purpose:'device_pairing_poll',jti:randomUUID(),
      iat:Math.floor(Date.now()/1000),htu:f.mainOrigin+token,authorization_id:authorization.authorizationId,nonce:authorization.nonce,request_digest:authorization.requestDigest,
      device_code_hash:createHash('sha256').update(authorization.deviceCode,'ascii').digest('base64url')},publicJwk))));
  const challenge=await poll();assert.equal(challenge.status,'proof_required');if(challenge.status!=='proof_required')throw Error('Missing actual native challenge');
  await new Promise(r=>setTimeout(r,challenge.interval*1000+20));const issued=await poll(await sign('freedom-runtime-enrollment+jws',challenge.challenge.payload));
  assert.equal(issued.status,'issued');if(issued.status!=='issued')throw Error('Missing native issuance');return issued;
}
