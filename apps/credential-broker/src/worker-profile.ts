import {z} from 'zod';
import {RuntimeEnvironmentSchema} from '../../../contracts/execution/v1/runtime-registration.js';
import {BootstrapClientIdSchema} from '../../../contracts/execution/v1/bootstrap.js';
const bytes=z.string().regex(/^[A-Za-z0-9_-]{43}$/),label=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/);
export const BrokerWorkerPublicKeySchema=z.object({kty:z.literal('OKP'),crv:z.literal('Ed25519'),x:bytes}).strict();
const pin=z.object({keyId:label,publicJwk:BrokerWorkerPublicKeySchema}).strict();
export const BrokerWorkerProfileSchema=z.object({environment:RuntimeEnvironmentSchema.exclude(['local']),platformOrigin:z.url(),clientId:BootstrapClientIdSchema,
  issuer:label,requestAudience:label,brokerId:label,responseAudience:label,responseKeyId:label,
  requestKeys:z.array(pin).min(1).max(16),recoveryKeys:z.array(pin).min(1).max(16),recoveryAuthority:label,
  databaseName:z.string().regex(/^freedom_(staging_next|next)$/),cipherRole:z.string().regex(/^freedom_(staging_next|next)_broker$/),executorRole:z.string().regex(/^freedom_(staging_next|next)_broker_executor$/),
  currentKekId:label}).strict();
export const BrokerWorkerResponseKeySchema=BrokerWorkerPublicKeySchema.extend({d:bytes}).strict();
export const BrokerWorkerKekSchema=z.array(z.object({keyId:label,jwk:z.object({kty:z.literal('oct'),k:bytes}).strict()}).strict()).min(1).max(16);
