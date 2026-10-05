import { z } from 'zod';
import { parseBoundedJson } from '../../../packages/execution-state/decode.js';
import { MemberExecutionVersionSchema } from '../../../contracts/execution/v1/member-execution.js';
import { RuntimeEnvironmentSchema } from '../../../contracts/execution/v1/runtime-registration.js';
import { SignedCredentialRecoveryHeaderSchema } from '../../../contracts/execution/v2/model-credential.js';

/** Public installation profile. Private JWK `d`, KEKs, member ids and provider
 * credentials are not fields. Strict objects reject them. */
const Label = SignedCredentialRecoveryHeaderSchema.shape.kid;
const Environment = RuntimeEnvironmentSchema.exclude(['local']);
const Digest = z.string().regex(/^[0-9a-f]{64}$/);

export const AuthorityStateProfileSchema = z.object({
  purpose: z.literal('recovery-state'),
  environment: Environment,
  authority: Label,
  keyId: Label,
  generation: MemberExecutionVersionSchema,
}).strict();
export const AuthorityFloorProfileSchema = z.object({
  purpose: z.literal('recovery-floor'),
  environment: Environment,
  authority: Label,
  generation: MemberExecutionVersionSchema,
}).strict();
export const AuthorityReadinessProfileSchema = z.object({
  purpose: z.literal('capture-readiness'),
  environment: Environment,
  authority: Label,
  keyId: Label,
  setupOrigin: z.string().min(1).max(256),
  capturePolicySha256: Digest,
  capturePolicyVersion: MemberExecutionVersionSchema,
}).strict();
export const AuthorityProfileSchema = z.discriminatedUnion('purpose', [
  AuthorityStateProfileSchema,
  AuthorityFloorProfileSchema,
  AuthorityReadinessProfileSchema,
]);
export type AuthorityProfile = z.infer<typeof AuthorityProfileSchema>;

export const AUTHORITY_ORIGIN = 'https://freedom-private-ai.internal';
/** Existing client paths. One deployed instance serves exactly one of these. */
export const AUTHORITY_PATHS = Object.freeze({
  'recovery-state': '/internal/credential-recovery/state',
  'recovery-floor': '/internal/credential-recovery/floor',
  'capture-readiness': '/internal/credential-ingest/readiness',
} as const);

/** Durable Object name. Generation and policy digest are storage values, not
 * identity, so a later operator release keeps the same object. */
export function authorityObjectName(profile: Pick<AuthorityProfile, 'purpose' | 'environment' | 'authority'>): string {
  return `${profile.purpose}\n${profile.environment}\n${profile.authority}`;
}

export function exactHttpsOrigin(value: string): boolean {
  try { return value.startsWith('https://') && new URL(value).origin === value; } catch { return false; }
}

/** Configuration is read independently by the Worker and its Durable Object. */
export interface AuthorityPublicBindings {
  FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED?: string;
  FREEDOM_AUTHORITY_PURPOSE?: string;
  FREEDOM_AUTHORITY_ENVIRONMENT?: string;
  FREEDOM_AUTHORITY_PROFILE?: string;
}
export function installedAuthorityProfile(env: AuthorityPublicBindings): AuthorityProfile {
  if (env.FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED !== 'true' || !env.FREEDOM_AUTHORITY_PROFILE || env.FREEDOM_AUTHORITY_PROFILE.length > 4096) throw new Error('authority_unavailable');
  const profile = AuthorityProfileSchema.parse(parseBoundedJson(env.FREEDOM_AUTHORITY_PROFILE));
  if (profile.purpose !== env.FREEDOM_AUTHORITY_PURPOSE || profile.environment !== env.FREEDOM_AUTHORITY_ENVIRONMENT
    || profile.purpose === 'capture-readiness' && !exactHttpsOrigin(profile.setupOrigin)) throw new Error('authority_unavailable');
  return profile;
}
