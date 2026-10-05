import { z } from 'zod';
import type { Pool } from 'pg';
import { DeviceAuthorizationHostSchema } from '../../../contracts/execution/v1/device-pairing.js';
import { RuntimePublicJwkSchema,RuntimeEnvironmentSchema } from '../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../contracts/execution/v1/bootstrap.js';
import { BrokerModelSelectionSchema,CredentialRecoveryFloorSchema } from '../../../contracts/execution/v2/model-credential.js';
import { createR2ObjectStore,type AssetR2Binding } from '../../../packages/asset-storage/r2.js';
import { parseBoundedJson } from '../../../packages/execution-state/decode.js';
import { createSignedRecoverySource } from '../../credential-broker/src/recovery.js';
import { createCredentialIngestAuthorizations } from '../../../modules/agent-control/credential-ingest-authorizations.js';
import { createCredentialIngestClient } from './credential-ingest-client.js';
import { createModelBrokerClient } from './model-broker-client.js';
import { bindPrivateAiProductTransport,bindPrivateAiProductBrowserPolicy,createPrivateAiProductTransport } from './private-ai-product.js';
import { bindPrivateAiJsonService,createModelBrokerServiceBindingExchange,type PrivateAiServiceBinding } from './model-broker-service-binding.js';
import type { FreedomEnv } from './env.js';

export interface WorkerPrivateAiBindings {
  FREEDOM_PRIVATE_AI_ENABLED?:string;
  /** Closed public trust profile; cannot specify provider URLs or member identity. */
  FREEDOM_PRIVATE_AI_PROFILE?:string;
  /** Main assertion signer only. Broker response/KEK/provider keys never belong here. */
  FREEDOM_PRIVATE_AI_REQUEST_KEY?:string;
  /** Optional independent ES256 bootstrap issuer, only when profile.bootstrap is installed. */
  FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY?:string;
  /** Independent main-only signer for the optional browser credential handoff. */
  FREEDOM_PRIVATE_AI_INGEST_KEY?:string;
  MODEL_BROKER?:PrivateAiServiceBinding;
  CREDENTIAL_RECOVERY_STATE?:PrivateAiServiceBinding;
  CREDENTIAL_RECOVERY_FLOOR?:PrivateAiServiceBinding;
  MEDIA?:AssetR2Binding;
}
const Label=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$(?![\s\S])/);
const Kid=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const X=z.string().length(43).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const PublicKey=z.object({kty:z.literal('OKP'),crv:z.literal('Ed25519'),x:X}).strict();
const Keys=z.array(z.object({keyId:Kid,publicJwk:PublicKey}).strict()).min(1).max(16);
export const WorkerPrivateAiProfileSchema=z.object({environment:RuntimeEnvironmentSchema,platformOrigin:z.string().min(1).max(256),clientId:BootstrapClientIdSchema,issuer:Label,audience:Label,
  brokerIdentity:Label,responseAudience:Label,requestKid:Kid,responseKeys:Keys,recoveryAuthority:Kid,recoveryKeys:Keys,
  settingsSelections:z.array(BrokerModelSelectionSchema).max(50),bootstrap:DeviceAuthorizationHostSchema.optional(),
  ingest:z.object({setupOrigin:z.string().min(1).max(256),issuer:Label,audience:Label,keyId:Kid}).strict().optional()}).strict();
const SignedState=z.object({signedState:z.string().min(1).max(4096)}).strict();
const root='https://freedom-private-ai.internal';
async function verificationKeys(raw:z.infer<typeof Keys>) {
  const keys=new Map<string,CryptoKey>();for(const item of raw){if(keys.has(item.keyId))throw new Error('invalid_private_ai_profile');
    keys.set(item.keyId,await crypto.subtle.importKey('jwk',item.publicJwk,{name:'Ed25519'},false,['verify']));}return keys;
}
/** workerd may import a JWK whose public coordinates do not match d.
 * Prove the declared public key before using it for signer separation. */
async function importSigningKey(jwk:JsonWebKey,algorithm:'Ed25519'|{name:'ECDSA';namedCurve:'P-256'}) {
  const key=await crypto.subtle.importKey('jwk',jwk,algorithm,false,['sign']);
  const {d:privateMaterial,...publicJwk}=jwk;
  const publicKey=await crypto.subtle.importKey('jwk',publicJwk,algorithm,false,['verify']);
  const operation=algorithm==='Ed25519'?'Ed25519':{name:'ECDSA',hash:'SHA-256'};
  const probe=crypto.getRandomValues(new Uint8Array(32));
  const signature=await crypto.subtle.sign(operation,key,probe);
  if(!await crypto.subtle.verify(operation,publicKey,signature,probe))throw new Error('private_ai_unavailable');
  return {key,publicKey};
}
/** Request-scoped genuine product: owns only main Hyperdrive, private R2 and
 * main signing key. No process.env, Node listener, cipher pool or provider host.
 * Missing/invalid complete installation affects private AI only, never login. */
export async function workerPrivateAiPorts(pool:Pool,bindings:WorkerPrivateAiBindings,config:{origin:string;freedomEnv:FreedomEnv}) {
  if(bindings.FREEDOM_PRIVATE_AI_ENABLED!=='true')return undefined;
  try {
    if(config.freedomEnv==='local'||!bindings.FREEDOM_PRIVATE_AI_PROFILE||bindings.FREEDOM_PRIVATE_AI_PROFILE.length>32768
      ||!bindings.FREEDOM_PRIVATE_AI_REQUEST_KEY||bindings.FREEDOM_PRIVATE_AI_REQUEST_KEY.length>4096
      ||!bindings.MODEL_BROKER||!bindings.CREDENTIAL_RECOVERY_STATE||!bindings.CREDENTIAL_RECOVERY_FLOOR||!bindings.MEDIA
      ||bindings.MODEL_BROKER===bindings.CREDENTIAL_RECOVERY_STATE||bindings.MODEL_BROKER===bindings.CREDENTIAL_RECOVERY_FLOOR
      ||bindings.CREDENTIAL_RECOVERY_STATE===bindings.CREDENTIAL_RECOVERY_FLOOR)throw new Error('private_ai_unavailable');

    const profile=WorkerPrivateAiProfileSchema.parse(parseBoundedJson(bindings.FREEDOM_PRIVATE_AI_PROFILE));
    const environment=config.freedomEnv==='staging'?'staging-next':'next';
    if(profile.environment!==environment||profile.platformOrigin!==config.origin)throw new Error('private_ai_unavailable');

    const privateJwk=PublicKey.extend({d:X}).strict().parse(parseBoundedJson(bindings.FREEDOM_PRIVATE_AI_REQUEST_KEY));
    const {key:requestKey,publicKey:requestPublicKey}=await importSigningKey(privateJwk,'Ed25519');
    const responseKeys=await verificationKeys(profile.responseKeys),recoveryKeys=await verificationKeys(profile.recoveryKeys);
    const readState=bindPrivateAiJsonService(bindings.CREDENTIAL_RECOVERY_STATE),readFloor=bindPrivateAiJsonService(bindings.CREDENTIAL_RECOVERY_FLOOR);
    const recovery=createSignedRecoverySource({environment,authority:profile.recoveryAuthority,
      pinnedKeys:[...recoveryKeys].map(([keyId,key])=>({keyId,key})),
      readSignedState:async()=> (await readState(root+'/internal/credential-recovery/state',SignedState)).signedState,
      readMonotonicFloor:()=>readFloor(root+'/internal/credential-recovery/floor',CredentialRecoveryFloorSchema)});

    const broker=await createModelBrokerClient(pool,{origin:config.origin,environment,clientId:profile.clientId,issuer:profile.issuer,audience:profile.audience,
      requestKey,requestKid:profile.requestKid,responseKeys,brokerIdentity:profile.brokerIdentity,responseAudience:profile.responseAudience,
      recover:recovery.recover,exchange:createModelBrokerServiceBindingExchange(bindings.MODEL_BROKER)});

    let bootstrap:Parameters<typeof createPrivateAiProductTransport>[1]['bootstrap'];
    if(profile.bootstrap){
      if(!bindings.FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY||bindings.FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY.length>4096)throw new Error('private_ai_unavailable');
      const jwk=RuntimePublicJwkSchema.extend({d:X}).strict().parse(parseBoundedJson(bindings.FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY));
      bootstrap={host:profile.bootstrap,signingKey:(await importSigningKey(jwk,{name:'ECDSA',namedCurve:'P-256'})).key};
    }else if(bindings.FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY)throw new Error('private_ai_unavailable');
    let ingest:Parameters<typeof createPrivateAiProductTransport>[1]['ingest'];
    if(profile.ingest){
      if(!bindings.FREEDOM_PRIVATE_AI_INGEST_KEY||bindings.FREEDOM_PRIVATE_AI_INGEST_KEY.length>4096)throw new Error('private_ai_unavailable');
      const jwk=PublicKey.extend({d:X}).strict().parse(parseBoundedJson(bindings.FREEDOM_PRIVATE_AI_INGEST_KEY));
      const {key:signingKey}=await importSigningKey(jwk,'Ed25519');
      // Purpose headers do not replace signer isolation. Verify actual key
      // correspondence instead of trusting key IDs or JWK labels.
      const separation=new TextEncoder().encode('freedom/private-ai/ingest-key-separation/v1');
      const signed=await crypto.subtle.sign('Ed25519',signingKey,separation);
      for(const key of [requestPublicKey,...responseKeys.values(),...recoveryKeys.values()]){
        if(await crypto.subtle.verify('Ed25519',key,signed,separation))throw new Error('private_ai_unavailable');
      }
      const {setupOrigin,issuer,audience,keyId}=profile.ingest;
      const authorizations=createCredentialIngestAuthorizations(pool,{environment,clientId:profile.clientId,issuer,audience,setupOrigin,recover:recovery.recover});
      ingest=await createCredentialIngestClient(pool,{origin:config.origin,environment,clientId:profile.clientId,setupOrigin,
        issuer,audience,keyId,signingKey,authorizations});
    }else if(bindings.FREEDOM_PRIVATE_AI_INGEST_KEY)throw new Error('private_ai_unavailable');
    const store=createR2ObjectStore(bindings.MEDIA);

    const product=await createPrivateAiProductTransport(pool,{origin:config.origin,environment,clientId:profile.clientId,broker,
      store,settingsSelections:profile.settingsSelections,...(bootstrap?{bootstrap}:{}),...(ingest?{ingest}:{})});
    return Object.freeze({privateAiProduct:bindPrivateAiProductTransport(product,pool,config.origin,config.freedomEnv),
      privateAiSetupOrigin:bindPrivateAiProductBrowserPolicy(product,pool,config.origin,config.freedomEnv)});
  }catch{return undefined;}
}
