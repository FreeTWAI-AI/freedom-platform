import { z } from 'zod';
import { DeviceAuthorizationHostSchema } from '../../../contracts/execution/v1/device-pairing.js';
import { RuntimeEnvironmentSchema } from '../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../contracts/execution/v1/bootstrap.js';
import { BrokerModelSelectionSchema } from '../../../contracts/execution/v2/model-credential.js';

const Label=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$(?![\s\S])/);
const Kid=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
export const PrivateAiKeyComponentSchema=z.string().length(43).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
export const PrivateAiPublicKeySchema=z.object({kty:z.literal('OKP'),crv:z.literal('Ed25519'),x:PrivateAiKeyComponentSchema}).strict();
export const PrivateAiPinnedKeysSchema=z.array(z.object({keyId:Kid,publicJwk:PrivateAiPublicKeySchema}).strict()).min(1).max(16);
/** The same closed public profile is consumed by runtime composition and offline release preparation. */
export const WorkerPrivateAiProfileSchema=z.object({environment:RuntimeEnvironmentSchema,platformOrigin:z.string().min(1).max(256),clientId:BootstrapClientIdSchema,issuer:Label,audience:Label,
  brokerIdentity:Label,responseAudience:Label,requestKid:Kid,responseKeys:PrivateAiPinnedKeysSchema,recoveryAuthority:Kid,recoveryKeys:PrivateAiPinnedKeysSchema,
  settingsSelections:z.array(BrokerModelSelectionSchema).max(50),bootstrap:DeviceAuthorizationHostSchema.optional(),
  ingest:z.object({setupOrigin:z.string().min(1).max(256),issuer:Label,audience:Label,keyId:Kid}).strict().optional()}).strict();
