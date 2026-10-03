import type { PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import type { RecoveryObservation } from '../agent-execution/model-step-host.js';
import type { RuntimeEnvironment } from '../../contracts/execution/v1/runtime-registration.js';
import type { ModelCredentialBinding } from '../../contracts/execution/v2/model-credential.js';
import type { CredentialIngestCommand,CredentialIngestBootstrapClaims,CredentialIngestSetupMetadata,CredentialIngestOwnerOutcome } from '../../contracts/execution/v2/model-credential-ingest.js';

declare const ingestInvocationBrand:unique symbol;
export interface OpaqueCredentialIngestInvocation {readonly [ingestInvocationBrand]:never}
export interface CredentialIngestAuthorizationOptions {
  environment:RuntimeEnvironment;clientId:string;issuer:string;audience:string;setupOrigin:string;
  recover:()=>Promise<RecoveryObservation>;
}
export interface CredentialIngestInvocationData {
  actor:Actor;command:CredentialIngestCommand;authorizationRef:string;nonce:string;commandDigest:string;
  recoveryGeneration:string;expiresAt:string;setupExpiresAt:string;model:CredentialIngestSetupMetadata['model'];
}
/** Pure API contract only. No implementation or fallback authority is installed
 * by this declaration. Claim arguments are server-generated/verified inputs. */
export interface CredentialIngestAuthorizations {
  issue(actor:Actor,input:{command:CredentialIngestCommand;nonce:string}):Promise<CredentialIngestBootstrapClaims>;
  claimBootstrap(claims:CredentialIngestBootstrapClaims,input:{cookieHash:string;csrfHash:string}):Promise<OpaqueCredentialIngestInvocation>;
  read(invocation:OpaqueCredentialIngestInvocation):CredentialIngestInvocationData;
  claimSubmission(invocation:OpaqueCredentialIngestInvocation,input:{binding:ModelCredentialBinding;writeExpiresAt:string;cookieHash:string;csrfHash:string}):Promise<void>;
  assertCurrent(q:PoolClient,invocation:OpaqueCredentialIngestInvocation):Promise<void>;
  readOwnerOutcome(actor:Actor,authorizationRef:string):Promise<CredentialIngestOwnerOutcome>;
}
