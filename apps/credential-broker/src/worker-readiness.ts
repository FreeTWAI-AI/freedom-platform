import { base64url, compactVerify } from 'jose';
import { z } from 'zod';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import { SignedCredentialRecoveryHeaderSchema } from '../../../contracts/execution/v2/model-credential.js';
import { parseBoundedJson } from '../../../packages/execution-state/decode.js';

/** Broker-only protected-surface readiness port for direct credential setup.
 *
 * Every call reads the installed readiness authority afresh (no cache) and
 * verifies a short-lived pinned Ed25519 statement bound to this exact setup
 * origin/environment/authority. This is only the transport/verification side
 * of the spec 20 readiness adapter: a valid signature proves which authority
 * spoke, NOT that edge/APM/logging/browser capture is actually disabled. That
 * operational fact belongs to the authority's own owner acceptance. */
const Label=SignedCredentialRecoveryHeaderSchema.shape.kid;
const Time=z.iso.datetime({precision:3});
export const CaptureReadinessHeaderSchema=z.object({alg:z.literal('EdDSA'),typ:z.literal('freedom-credential-capture-readiness+jws'),kid:Label}).strict();
export const CaptureReadinessClaimsSchema=z.object({profile:z.literal('credential-broker.capture-readiness/v1'),
  purpose:z.literal('credential-broker.capture-readiness'),authority:Label,environment:RuntimeEnvironmentSchema,
  origin:z.string().max(256),captureDisabled:z.literal(true),issuedAt:Time,expiresAt:Time}).strict();
export const CAPTURE_READINESS_URI='https://freedom-private-ai.internal/internal/credential-ingest/readiness';
const limits=Object.freeze({compact:2048,header:256,payload:1024,lifetime:60_000});
export interface SignedCaptureReadinessOptions {
  environment:RuntimeEnvironment;authority:string;origin:string;
  pinnedKeys:ReadonlyMap<string,CryptoKey>;readSignedReadiness:()=>Promise<string>;
}
const fail=():never=>{throw new Error('credential_ingest_unavailable');};
function segment(raw:string,max:number):Uint8Array{
  if(!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw)||raw.length>Math.ceil(max*4/3))fail();
  const value=base64url.decode(raw);if(value.byteLength>max||base64url.encode(value)!==raw)fail();return value;
}
const json=(bytes:Uint8Array)=>parseBoundedJson(new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes));
export function createSignedCaptureReadiness(options:SignedCaptureReadinessOptions){
  const environment=RuntimeEnvironmentSchema.parse(options.environment),authority=Label.parse(options.authority),origin=options.origin;
  const read=options.readSignedReadiness;
  if(typeof origin!=='string'||new URL(origin).origin!==origin||typeof read!=='function'||!(options.pinnedKeys instanceof Map)
    ||options.pinnedKeys.size<1||options.pinnedKeys.size>16)fail();
  const keys=new Map(options.pinnedKeys);
  for(const [kid,key] of keys){Label.parse(kid);
    if(!(key instanceof CryptoKey)||key.type!=='public'||key.algorithm.name!=='Ed25519'||key.usages.length!==1||key.usages[0]!=='verify')fail();}
  let latest=0;
  return async function assertProtectedSurface(input:Readonly<{origin:string;purpose:'credential-ingest'}>):Promise<void>{
    if(!input||input.origin!==origin||input.purpose!=='credential-ingest')fail();
    const raw=await read();
    if(typeof raw!=='string'||raw.length>limits.compact)fail();
    const parts=raw.split('.');if(parts.length!==3)fail();
    const header=CaptureReadinessHeaderSchema.parse(json(segment(parts[0],limits.header)));
    const claims=CaptureReadinessClaimsSchema.parse(json(segment(parts[1],limits.payload)));
    if(segment(parts[2],64).byteLength!==64)fail();
    const key=keys.get(header.kid);if(!key)return fail();
    await compactVerify(raw,key,{algorithms:['EdDSA']});
    const now=Date.now(),issued=Date.parse(claims.issuedAt),expires=Date.parse(claims.expiresAt);
    if(claims.authority!==authority||claims.environment!==environment||claims.origin!==origin||issued>now||expires<=now
      ||expires<=issued||expires-issued>limits.lifetime||issued<latest)fail();
    latest=issued;
  };
}
