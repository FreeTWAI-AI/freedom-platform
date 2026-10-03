import { z } from 'zod';
import { OpaqueId } from '../../common/v1/identity.js';
import { MemberExecutionVersionSchema, ModelConnectionMetadataSchema } from '../v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../v1/bootstrap.js';
import { ModelCredentialCreateSchema, ModelCredentialRotateSchema, ModelCredentialMetadataSchema } from './model-credential.js';

/** Metadata shapes do not authorize a secret read, mint a private intent, prove
 * capture is disabled or authenticate a provider. No secret has a JSON schema. */
export const CredentialIngestLimits = Object.freeze({ authorizationMs:60_000, setupMs:60_000, writeMs:30_000,
  responseMs:10_000, bodyMs:5000, secretBytes:4096, chunks:128, compactBytes:8192,
  headerBytes:512, payloadBytes:6144, jsonDepth:12, jsonNodes:256 });
const Label=z.string().min(1).max(160).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$(?![\s\S])/);
const Kid=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Nonce=z.string().length(43).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const Digest=z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const Time=z.iso.datetime({precision:3});
const Origin=z.string().min(1).max(256).url();
const Compact=z.string().min(1).max(CredentialIngestLimits.compactBytes).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$(?![\s\S])/);
export const CredentialIngestCommandSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('create'),input:ModelCredentialCreateSchema}).strict(),
  z.object({operation:z.literal('rotate'),input:ModelCredentialRotateSchema}).strict(),
]);
// Primary version and idempotency key are supplied only by HTTP headers.
export const CredentialIngestIssueInputSchema=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('create'),modelConnectionId:OpaqueId,consent:z.literal(true)}).strict(),
  z.object({operation:z.literal('rotate'),credentialId:OpaqueId,replacementModelConnectionId:OpaqueId,
    expectedReplacementModelVersion:MemberExecutionVersionSchema,consent:z.literal(true)}).strict(),
]);
export const CredentialIngestBootstrapProtectedHeaderSchema=z.object({alg:z.literal('EdDSA'),
  typ:z.literal('freedom-credential-ingest-bootstrap+jws'),kid:Kid}).strict();
export const CredentialIngestResponseProtectedHeaderSchema=z.object({alg:z.literal('EdDSA'),
  typ:z.literal('freedom-credential-ingest-response+jws'),kid:Kid}).strict();
export const CredentialIngestBootstrapClaimsSchema=z.object({profile:z.literal('credential-ingest.bootstrap/v1'),
  issuer:Label,audience:Label,purpose:z.literal('credential-broker.ingest-bootstrap'),setupOrigin:Origin,
  environment:RuntimeEnvironmentSchema,clientId:BootstrapClientIdSchema,operation:z.enum(['create','rotate']),
  authorizationRef:OpaqueId,nonce:Nonce,commandDigest:Digest,recoveryGeneration:MemberExecutionVersionSchema,
  issuedAt:Time,expiresAt:Time}).strict();
export const CredentialIngestBootstrapRequestSchema=z.object({authorizationRef:OpaqueId,nonce:Nonce,assertion:Compact}).strict();
export const CredentialIngestSetupMetadataSchema=z.object({authorizationRef:OpaqueId,operation:z.enum(['create','rotate']),
  model:ModelConnectionMetadataSchema,expiresAt:Time,operational_authority:z.literal(false)}).strict();
export const CredentialIngestOwnerOutcomeSchema=z.object({authorizationRef:OpaqueId,operation:z.enum(['create','rotate']),
  state:z.enum(['issued','setup_claimed','submission_claimed','committed']),
  credential:ModelCredentialMetadataSchema.nullable(),operational_authority:z.literal(false)}).strict();
export const CredentialIngestProblemCodeSchema=z.enum(['credential_ingest_unavailable','credential_ingest_authorization_invalid',
  'credential_ingest_registry_unavailable','credential_ingest_outcome_unknown','credential_ingest_submission_consumed']);
export const CredentialIngestResponseClaimsSchema=z.object({profile:z.literal('credential-ingest.response/v1'),
  issuer:Label,audience:Label,purpose:z.literal('credential-broker.ingest-response'),environment:RuntimeEnvironmentSchema,
  clientId:BootstrapClientIdSchema,authorizationRef:OpaqueId,nonce:Nonce,commandDigest:Digest,
  recoveryGeneration:MemberExecutionVersionSchema,issuedAt:Time,expiresAt:Time,
  outcome:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('setup'),setup:CredentialIngestSetupMetadataSchema}).strict(),
    z.object({kind:z.literal('metadata'),credential:ModelCredentialMetadataSchema}).strict(),
    z.object({kind:z.literal('problem'),code:CredentialIngestProblemCodeSchema}).strict(),
  ]),operational_authority:z.literal(false)}).strict();
export const CredentialIngestResponseEnvelopeSchema=z.object({response:Compact}).strict();
export type CredentialIngestCommand=z.infer<typeof CredentialIngestCommandSchema>;
export type CredentialIngestIssueInput=z.infer<typeof CredentialIngestIssueInputSchema>;
export type CredentialIngestBootstrapClaims=z.infer<typeof CredentialIngestBootstrapClaimsSchema>;
export type CredentialIngestBootstrapRequest=z.infer<typeof CredentialIngestBootstrapRequestSchema>;
export type CredentialIngestSetupMetadata=z.infer<typeof CredentialIngestSetupMetadataSchema>;
export type CredentialIngestOwnerOutcome=z.infer<typeof CredentialIngestOwnerOutcomeSchema>;
export type CredentialIngestResponseClaims=z.infer<typeof CredentialIngestResponseClaimsSchema>;
export type CredentialIngestResponseEnvelope=z.infer<typeof CredentialIngestResponseEnvelopeSchema>;
