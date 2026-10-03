import { randomBytes } from 'node:crypto';
import { CompactSign } from 'jose';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Actor } from '../../../modules/identity-membership/service.js';
import type { CredentialIngestAuthorizations } from '../../../modules/agent-control/credential-ingest-authorizations.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../contracts/execution/v1/bootstrap.js';
import { CredentialIngestBootstrapClaimsSchema, CredentialIngestBootstrapProtectedHeaderSchema,
  CredentialIngestHandoffSchema, CredentialIngestCommandSchema, CredentialIngestLimits,
  CredentialIngestOwnerOutcomeSchema, type CredentialIngestCommand } from '../../../contracts/execution/v2/model-credential-ingest.js';
import { freezeTree, snapshotInput } from '../../../packages/execution-state/decode.js';
import { Problem } from '../../../packages/shared/problem.js';

declare const clientBrand: unique symbol;
export interface CredentialIngestClient { readonly [clientBrand]: never }
export { CredentialIngestHandoffSchema };
export interface CredentialIngestClientOptions {
  origin:string; environment:RuntimeEnvironment; clientId:string; setupOrigin:string; issuer:string; audience:string;
  keyId:string; signingKey:CryptoKey; authorizations:CredentialIngestAuthorizations;
}
const unavailable=()=>new Problem(503,'credential_ingest_unavailable','Credential setup is unavailable.');
const ports=new WeakMap<object,{pool:Pool;origin:string;environment:RuntimeEnvironment;clientId:string;
  issue:(actor:Actor,input:{command:CredentialIngestCommand})=>Promise<z.infer<typeof CredentialIngestHandoffSchema>>;
  readOwnerOutcome:CredentialIngestAuthorizations['readOwnerOutcome']}>();

/** Trusted main-only composition: no ciphertext pool, vault, provider or secret
 * body port. The signed bootstrap never supplies member identity to the broker. */
export async function createCredentialIngestClient(pool:Pool,raw:CredentialIngestClientOptions):Promise<CredentialIngestClient> {
  const names=['origin','environment','clientId','setupOrigin','issuer','audience','keyId','signingKey','authorizations'];
  if(!raw||Object.getPrototypeOf(raw)!==Object.prototype||Reflect.ownKeys(raw).length!==names.length)throw unavailable();
  const ds=Object.getOwnPropertyDescriptors(raw);
  if(names.some(k=>!ds[k]?.enumerable||!('value' in ds[k])))throw unavailable();
  const options=Object.fromEntries(names.map(k=>[k,ds[k].value])) as unknown as CredentialIngestClientOptions;
  const environment=RuntimeEnvironmentSchema.parse(options.environment),clientId=BootstrapClientIdSchema.parse(options.clientId);
  const fixedOrigin=(value:string)=>{
    if(typeof value!=='string'||/[?#%\\\x00-\x20\x7f-\uffff]/.test(value))throw unavailable();
    const u=new URL(value);if(u.protocol!=='https:'||u.origin!==value||u.username||u.password)throw unavailable();return u;
  };
  const origin=fixedOrigin(options.origin),setup=fixedOrigin(options.setupOrigin);
  if(origin.hostname===setup.hostname)throw unavailable();
  const {issuer,audience,keyId,signingKey}=options;
  const header=CredentialIngestBootstrapProtectedHeaderSchema.parse({alg:'EdDSA',typ:'freedom-credential-ingest-bootstrap+jws',kid:keyId});
  if(!(signingKey instanceof CryptoKey)||signingKey.type!=='private'||signingKey.algorithm.name!=='Ed25519'
    ||signingKey.usages.length!==1||signingKey.usages[0]!=='sign')throw unavailable();
  const auth=options.authorizations;
  if(!auth||typeof auth.issue!=='function'||typeof auth.readOwnerOutcome!=='function')throw unavailable();
  // Capture ports once; later mutation of host options cannot change authority.
  const issue=auth.issue.bind(auth),readOutcome=auth.readOwnerOutcome.bind(auth);
  const port=Object.freeze(Object.create(null)) as CredentialIngestClient;
  ports.set(port,{pool,origin:origin.origin,environment,clientId,async issue(actor,input){
    const command=freezeTree(CredentialIngestCommandSchema.parse(snapshotInput(input.command)));
    const originalActor=Object.freeze({...actor}),nonce=randomBytes(32).toString('base64url');
    const started=performance.now();let cancelled=false,timer:ReturnType<typeof setTimeout>|undefined;
    const active=()=>{if(cancelled||performance.now()-started>=45_000)throw unavailable();};
    const run=async()=>{
      active();const claims=freezeTree(CredentialIngestBootstrapClaimsSchema.parse(await issue(originalActor,{command,nonce})));active();
      const current=()=>{
        const now=Date.now(),issued=Date.parse(claims.issuedAt),expiry=Date.parse(claims.expiresAt);
        if(claims.issuer!==issuer||claims.audience!==audience||claims.environment!==environment||claims.clientId!==clientId
          ||claims.setupOrigin!==setup.origin||claims.operation!==command.operation||issued>now||expiry<=now||expiry<=issued
          ||expiry-issued>CredentialIngestLimits.authorizationMs)throw unavailable();
      };
      current();const bytes=new TextEncoder().encode(JSON.stringify(claims));
      if(bytes.byteLength>CredentialIngestLimits.payloadBytes)throw unavailable();
      const assertion=await new CompactSign(bytes).setProtectedHeader(header).sign(signingKey);active();current();
      // Signing may block. Re-use the original command/key to revalidate current
      // SQL authority after that last external wait; this never re-mints a grant.
      const after=CredentialIngestBootstrapClaimsSchema.parse(await issue(originalActor,{command,nonce}));active();
      if(JSON.stringify(after)!==JSON.stringify(claims))throw unavailable();current();
      return freezeTree(CredentialIngestHandoffSchema.parse({authorizationRef:claims.authorizationRef,nonce:claims.nonce,
        assertion,setupOrigin:setup.origin,expiresAt:claims.expiresAt,operational_authority:false}));
    };
    try{return await Promise.race([run(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(unavailable());},45_000);})]);}
    finally{cancelled=true;if(timer)clearTimeout(timer);}
  },async readOwnerOutcome(actor,ref){return freezeTree(CredentialIngestOwnerOutcomeSchema.parse(await readOutcome(Object.freeze({...actor}),ref)));}});
  return port;
}

export function bindCredentialIngestClient(port:CredentialIngestClient,pool:Pool,origin:string,environment:RuntimeEnvironment,clientId:string) {
  const client=port&&typeof port==='object'?ports.get(port):undefined;
  if(!client||client.pool!==pool||client.origin!==origin||client.environment!==environment||client.clientId!==clientId)throw unavailable();
  return Object.freeze({issue:client.issue,readOwnerOutcome:client.readOwnerOutcome});
}
