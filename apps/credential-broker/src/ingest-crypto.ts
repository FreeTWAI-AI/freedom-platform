import { base64url, compactVerify, CompactSign } from 'jose';
import * as c from '../../../contracts/execution/v2/model-credential-ingest.js';
import { parseBoundedJson, freezeTree, snapshotInput } from '../../../packages/execution-state/decode.js';
import { Problem } from '../../../packages/shared/problem.js';
import type { RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';

const invalid = (): never => { throw new Problem(403,'credential_ingest_authorization_invalid','Credential setup is unavailable.'); };
async function bounded<T>(operation:()=>Promise<T>):Promise<T>{
  const end=performance.now()+3000;let timer:ReturnType<typeof setTimeout>|undefined;
  try{const result=await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{
    timer=setTimeout(()=>reject(new Problem(503,'credential_ingest_unavailable','Credential setup is unavailable.')),3000);})]);
    if(performance.now()>=end)invalid();return result;
  }finally{if(timer)clearTimeout(timer);}
}
function key(key:CryptoKey,kind:'public'|'private') {
  if(!(key instanceof CryptoKey)||key.type!==kind||key.algorithm.name!=='Ed25519'
    ||key.usages.length!==1||key.usages[0]!== (kind==='public'?'verify':'sign')) invalid();
}
function segment(raw:string,max:number):Uint8Array {
  if(!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw)||raw.length>Math.ceil(max*4/3))invalid();
  const bytes=base64url.decode(raw);if(bytes.length>max||base64url.encode(bytes)!==raw)invalid();return bytes;
}
function json(bytes:Uint8Array):unknown {
  const value=parseBoundedJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));let nodes=0;
  function visit(item:unknown,depth:number){if(++nodes>c.CredentialIngestLimits.jsonNodes||depth>c.CredentialIngestLimits.jsonDepth)invalid();
    if(item&&typeof item==='object')for(const child of Object.values(item))visit(child,depth+1);}
  visit(value,0);return value;
}
export function assertCredentialIngestClaimsCurrent(payload:c.CredentialIngestBootstrapClaims):void {
  const issued=Date.parse(payload.issuedAt),expires=Date.parse(payload.expiresAt),now=Date.now();
  if(issued>now||expires<=now||expires<=issued||expires-issued>c.CredentialIngestLimits.authorizationMs)invalid();
}
export async function signCredentialIngestBootstrap(raw:c.CredentialIngestBootstrapClaims,signingKey:CryptoKey,kid:string):Promise<string> {
  key(signingKey,'private');const payload=c.CredentialIngestBootstrapClaimsSchema.parse(snapshotInput(raw));
  const header=c.CredentialIngestBootstrapProtectedHeaderSchema.parse({alg:'EdDSA',typ:'freedom-credential-ingest-bootstrap+jws',kid});
  assertCredentialIngestClaimsCurrent(payload);const bytes=new TextEncoder().encode(JSON.stringify(payload));
  if(bytes.length>c.CredentialIngestLimits.payloadBytes)invalid();
  const assertion=await bounded(()=>new CompactSign(bytes).setProtectedHeader(header).sign(signingKey));
  assertCredentialIngestClaimsCurrent(payload);
  return c.CredentialIngestBootstrapRequestSchema.parse({authorizationRef:payload.authorizationRef,nonce:payload.nonce,assertion}).assertion;
}
export interface CredentialIngestCryptoOptions {
  environment:RuntimeEnvironment;clientId:string;issuer:string;requestAudience:string;setupOrigin:string;
  requestKeys:ReadonlyMap<string,CryptoKey>;responseSigningKey:CryptoKey;responseKeyId:string;responseIssuer:string;responseAudience:string;
}
export async function createCredentialIngestCrypto(options:CredentialIngestCryptoOptions) {
  const {environment,clientId,issuer,requestAudience,setupOrigin,responseSigningKey,responseKeyId,responseIssuer,responseAudience}=options;
  key(responseSigningKey,'private');
  c.CredentialIngestBootstrapClaimsSchema.shape.issuer.parse(issuer);c.CredentialIngestBootstrapClaimsSchema.shape.audience.parse(requestAudience);
  c.CredentialIngestBootstrapClaimsSchema.shape.environment.parse(environment);c.CredentialIngestBootstrapClaimsSchema.shape.clientId.parse(clientId);
  c.CredentialIngestResponseClaimsSchema.shape.issuer.parse(responseIssuer);c.CredentialIngestResponseClaimsSchema.shape.audience.parse(responseAudience);
  const responseHeader=c.CredentialIngestResponseProtectedHeaderSchema.parse({alg:'EdDSA',typ:'freedom-credential-ingest-response+jws',kid:responseKeyId});
  if(issuer===responseIssuer||requestAudience===responseAudience||!options.requestKeys||options.requestKeys.size<1||options.requestKeys.size>16)invalid();
  const keys=new Map<string,CryptoKey>();for(const [kid,publicKey]of options.requestKeys){
    c.CredentialIngestBootstrapProtectedHeaderSchema.parse({alg:'EdDSA',typ:'freedom-credential-ingest-bootstrap+jws',kid});key(publicKey,'public');keys.set(kid,publicKey);}
  const separation=new TextEncoder().encode('freedom/credential-ingest/signing-directions/v1');
  await bounded(async()=>{const signature=await crypto.subtle.sign('Ed25519',responseSigningKey,separation);
    for(const publicKey of keys.values())if(await crypto.subtle.verify('Ed25519',publicKey,signature,separation))invalid();});
  return Object.freeze({
    async verify(assertion:string):Promise<c.CredentialIngestBootstrapClaims>{
      try {
        if(typeof assertion!=='string'||assertion.length>c.CredentialIngestLimits.compactBytes)invalid();
        const parts=assertion.split('.');if(parts.length!==3)invalid();
        const header=c.CredentialIngestBootstrapProtectedHeaderSchema.parse(json(segment(parts[0],c.CredentialIngestLimits.headerBytes)));
        const payload=freezeTree(c.CredentialIngestBootstrapClaimsSchema.parse(json(segment(parts[1],c.CredentialIngestLimits.payloadBytes))));
        if(segment(parts[2],64).length!==64)invalid();const publicKey=keys.get(header.kid);
        if(!publicKey||payload.issuer!==issuer||payload.audience!==requestAudience||payload.setupOrigin!==setupOrigin
          ||payload.environment!==environment||payload.clientId!==clientId)invalid();
        assertCredentialIngestClaimsCurrent(payload);await bounded(()=>compactVerify(assertion,publicKey!,{algorithms:['EdDSA']}));
        assertCredentialIngestClaimsCurrent(payload);return payload;
      }catch{return invalid();}
    },
    async response(context:Pick<c.CredentialIngestBootstrapClaims,'authorizationRef'|'nonce'|'commandDigest'|'recoveryGeneration'>,
      outcome:c.CredentialIngestResponseClaims['outcome']):Promise<c.CredentialIngestResponseEnvelope>{
      const now=Date.now(),expires=now+c.CredentialIngestLimits.responseMs;
      const payload=c.CredentialIngestResponseClaimsSchema.parse({profile:'credential-ingest.response/v1',issuer:responseIssuer,audience:responseAudience,
        purpose:'credential-broker.ingest-response',environment,clientId,authorizationRef:context.authorizationRef,nonce:context.nonce,
        commandDigest:context.commandDigest,recoveryGeneration:context.recoveryGeneration,issuedAt:new Date(now).toISOString(),expiresAt:new Date(expires).toISOString(),
        outcome,operational_authority:false});const bytes=new TextEncoder().encode(JSON.stringify(payload));
      if(bytes.length>c.CredentialIngestLimits.payloadBytes)invalid();
      const response=await bounded(()=>new CompactSign(bytes).setProtectedHeader(responseHeader).sign(responseSigningKey));
      if(Date.now()>=expires)invalid();return freezeTree(c.CredentialIngestResponseEnvelopeSchema.parse({response}));
    },
  });
}
