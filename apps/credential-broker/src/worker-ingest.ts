import type { Pool } from 'pg';
import { z } from 'zod';
import type { RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import type { RecoveryObservation } from '../../../modules/agent-execution/model-step-host.js';
import { createCredentialIngestAuthorizations } from '../../../modules/agent-control/credential-ingest-authorizations.js';
import { bindPrivateAiJsonService, type PrivateAiServiceBinding } from '../../platform-api/src/model-broker-service-binding.js';
import { createCredentialIngestService, credentialIngestOrigins } from './ingest.js';
import { createCredentialIngestHttp } from './ingest-http.js';
import { renderProtectedCredentialSetup, protectedCredentialSetupScript, protectedCredentialSetupStyles } from './setup-ui.js';
import { createSignedCaptureReadiness, CAPTURE_READINESS_URI } from './worker-readiness.js';
import type { CredentialVault } from './vault.js';
import type { BrokerWorkerIngestSchema } from './worker-profile.js';

/** Headers the Cloudflare edge itself adds to an inbound request. They carry no
 * authority for setup and are removed before the existing strict allowlist in
 * createCredentialIngestHttp; every other unknown header is still rejected. */
const edgeHeaders=new Set(['cf-connecting-ip','cf-connecting-ipv6','cf-ipcountry','cf-ray','cf-visitor','cf-worker','cf-ew-via','cf-pseudo-ipv4',
  'cdn-loop','x-forwarded-for','x-forwarded-proto','x-real-ip','true-client-ip']);
const edgeHeader=(name:string)=>edgeHeaders.has(name);
export function stripEdgeHeaders(request:Request):Request{
  const headers=new Headers();
  for(const [name,value] of request.headers)if(!edgeHeader(name.toLowerCase()))headers.append(name,value);
  // Re-wrapping keeps the original native body stream unread; the existing
  // transport pulls it lazily only after its SQL submission claim.
  return new Request(request,{headers});
}
export interface BrokerIngestCompositionOptions {
  ingest:z.infer<typeof BrokerWorkerIngestSchema>;environment:RuntimeEnvironment;clientId:string;mainOrigin:string;
  cipherPool:Pool;vault:CredentialVault;recover:()=>Promise<RecoveryObservation>;
  requestKeys:ReadonlyMap<string,CryptoKey>;readinessKeys:ReadonlyMap<string,CryptoKey>;
  responseSigningKey:CryptoKey;readiness:PrivateAiServiceBinding;brand:Uint8Array;
}
/** Composes the existing direct setup service/HTTP transport for workerd.
 * Uses only the cipher SQL port, the existing SQL authorizations, the original
 * vault/store and signed recovery. No body adapter: the native request stream
 * goes to the existing readCredentialIngestBytes. */
export async function composeBrokerIngest(options:BrokerIngestCompositionOptions){
  const {ingest,environment,clientId,mainOrigin}=options;
  credentialIngestOrigins(mainOrigin,ingest.setupOrigin);
  const readState=bindPrivateAiJsonService(options.readiness);
  const assertProtectedSurface=createSignedCaptureReadiness({environment,authority:ingest.readinessAuthority,origin:ingest.setupOrigin,pinnedKeys:options.readinessKeys,
    readSignedReadiness:async()=>(await readState(CAPTURE_READINESS_URI,z.object({signedReadiness:z.string().max(2048)}).strict())).signedReadiness});
  const authorizations=createCredentialIngestAuthorizations(options.cipherPool,{environment,clientId,issuer:ingest.issuer,audience:ingest.audience,
    setupOrigin:ingest.setupOrigin,recover:options.recover});
  const service=await createCredentialIngestService({cipherPool:options.cipherPool,mainOrigin,setupOrigin:ingest.setupOrigin,environment,clientId,
    vault:options.vault,recover:options.recover,authorizations,issuer:ingest.issuer,requestAudience:ingest.audience,requestKeys:options.requestKeys,
    responseSigningKey:options.responseSigningKey,responseKeyId:ingest.responseKeyId,responseIssuer:ingest.responseIssuer,
    responseAudience:ingest.responseAudience,assertProtectedSurface});
  const http=createCredentialIngestHttp({service,mainOrigin,setupOrigin:ingest.setupOrigin,renderProtectedSetup:renderProtectedCredentialSetup,
    protectedAssets:{javascript:protectedCredentialSetupScript,stylesheet:protectedCredentialSetupStyles,brand:options.brand}});
  const fetch=http.fetch.bind(http);
  return Object.freeze({origin:ingest.setupOrigin,fetch:(request:Request)=>fetch(stripEdgeHeaders(request))});
}
export type BrokerIngestComposition=Awaited<ReturnType<typeof composeBrokerIngest>>;
