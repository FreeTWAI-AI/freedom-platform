import { CompactSign } from 'jose';
import { z } from 'zod';
import { parseBoundedJson } from '../../../packages/execution-state/decode.js';
import {
  CredentialRecoveryFloorSchema,
  SignedCredentialRecoveryHeaderSchema,
  SignedCredentialRecoveryStateSchema,
} from '../../../contracts/execution/v2/model-credential.js';
import { CaptureReadinessClaimsSchema, CaptureReadinessHeaderSchema } from '../../credential-broker/src/worker-readiness.js';
import { importVerifiedEd25519Signer } from '../../credential-broker/src/worker-keys.js';
import { AuthorityGeneration } from './durable-generation.js';
import {
  AUTHORITY_ORIGIN,
  AUTHORITY_PATHS,
  authorityObjectName,
  installedAuthorityProfile,
  type AuthorityProfile,
} from './profile.js';

export { AuthorityGeneration };

/** Existing verifier rejects a recovery lifetime above 300000 ms and a
 * readiness lifetime above 60000 ms. These claims stay inside both limits. */
const RECOVERY_TTL_MS = 120_000;
const READINESS_TTL_MS = 30_000;
const INTERNAL_DO_URL = 'https://freedom-private-ai-authority.internal/current';

interface AuthorityGenerationNamespace {
  idFromName(name: string): { toString(): string };
  get(id: { toString(): string }): { fetch(input: RequestInfo, init?: RequestInit): Promise<Response> };
}
export interface AuthorityBindings {
  FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED?: string;
  FREEDOM_AUTHORITY_PURPOSE?: string;
  FREEDOM_AUTHORITY_ENVIRONMENT?: string;
  /** Closed public profile. Never a private JWK. */
  FREEDOM_AUTHORITY_PROFILE?: string;
  /** State and readiness only. Floor must not receive a signing key. */
  FREEDOM_AUTHORITY_SIGNING_KEY?: string;
  AUTHORITY_GENERATION?: AuthorityGenerationNamespace;
}

const SigningKeySchema = z.object({
  kty: z.literal('OKP'), crv: z.literal('Ed25519'), x: z.string(), d: z.string(),
}).strict();
const unavailable = () => Response.json({ code: 'private_ai_authority_unavailable' }, { status: 503, headers: { 'cache-control': 'private, no-store' } });
const rejected = (status: 405 | 404 | 400, code: string) => Response.json({ code }, { status, headers: { 'cache-control': 'private, no-store' } });

function iso(time: number): string {
  return new Date(time).toISOString();
}

function requestRejected(request: Request, profile: AuthorityProfile): Response | undefined {
  const url = new URL(request.url);
  if (request.method !== 'GET') return rejected(405, 'private_ai_authority_method_rejected');
  if (url.origin !== AUTHORITY_ORIGIN || url.search !== '' || url.hash !== '') return rejected(400, 'private_ai_authority_request_rejected');
  if (url.pathname !== AUTHORITY_PATHS[profile.purpose]) return rejected(404, 'private_ai_authority_path_rejected');
  if (request.headers.has('content-length') || request.headers.has('transfer-encoding')) return rejected(400, 'private_ai_authority_request_rejected');
  return undefined;
}

async function persisted(env: AuthorityBindings, profile: AuthorityProfile): Promise<{ kind: 'generation' | 'capture-policy'; value: string }> {
  const namespace = env.AUTHORITY_GENERATION;
  if (!namespace) throw new Error('authority_unavailable');
  const stub = namespace.get(namespace.idFromName(authorityObjectName(profile)));
  const response = await stub.fetch(INTERNAL_DO_URL, {
    method: 'GET',
    headers: { 'x-fp-authority-profile': JSON.stringify(profile) },
  });
  if (response.status !== 200) throw new Error('authority_unavailable');
  const body = z.object({
    kind: z.enum(['generation', 'capture-policy']),
    value: z.string().min(1).max(64),
  }).strict().parse(await response.json());
  if (profile.purpose === 'capture-readiness') {
    if (body.kind !== 'capture-policy' || body.value !== profile.capturePolicySha256) throw new Error('authority_unavailable');
  } else if (body.kind !== 'generation' || body.value !== profile.generation) throw new Error('authority_unavailable');
  return body;
}

async function signingKey(raw: string | undefined) {
  if (!raw || raw.length > 4096) throw new Error('authority_unavailable');
  return importVerifiedEd25519Signer(SigningKeySchema.parse(parseBoundedJson(raw)));
}

async function signedRecovery(profile: Extract<AuthorityProfile, { purpose: 'recovery-state' }>, key: CryptoKey, generation: string): Promise<string> {
  const now = Date.now();
  const claims = SignedCredentialRecoveryStateSchema.parse({
    profile: 'credential-broker.recovery/v1',
    purpose: 'credential-broker.recovery',
    authority: profile.authority,
    environment: profile.environment,
    generation,
    issuedAt: iso(now),
    expiresAt: iso(now + RECOVERY_TTL_MS),
  });
  const header = SignedCredentialRecoveryHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-credential-recovery+jws', kid: profile.keyId });
  return new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader(header).sign(key);
}

async function signedReadiness(profile: Extract<AuthorityProfile, { purpose: 'capture-readiness' }>, key: CryptoKey): Promise<string> {
  const now = Date.now();
  const claims = CaptureReadinessClaimsSchema.parse({
    profile: 'credential-broker.capture-readiness/v1',
    purpose: 'credential-broker.capture-readiness',
    authority: profile.authority,
    environment: profile.environment,
    origin: profile.setupOrigin,
    captureDisabled: true,
    issuedAt: iso(now),
    expiresAt: iso(now + READINESS_TTL_MS),
  });
  const header = CaptureReadinessHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-credential-capture-readiness+jws', kid: profile.keyId });
  const token = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader(header).sign(key);
  if (token.length > 2048) throw new Error('authority_unavailable');
  return token;
}

export default {
  async fetch(request: Request, env: AuthorityBindings): Promise<Response> {
    if (env.FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED !== 'true') return unavailable();
    try {
      const profile = installedAuthorityProfile(env);
      const rejection = requestRejected(request, profile);
      if (rejection) return rejection;
      if (profile.purpose === 'recovery-floor') {
        if (env.FREEDOM_AUTHORITY_SIGNING_KEY !== undefined) return unavailable();
        const stored = await persisted(env, profile);
        const floor = CredentialRecoveryFloorSchema.parse({ generation: stored.value, expiresAt: iso(Date.now() + RECOVERY_TTL_MS) });
        return Response.json(floor, { headers: { 'cache-control': 'private, no-store' } });
      }
      const key = await signingKey(env.FREEDOM_AUTHORITY_SIGNING_KEY);
      const stored = await persisted(env, profile);
      if (profile.purpose === 'recovery-state') {
        const signedState = await signedRecovery(profile, key.privateKey, stored.value);
        if (signedState.length > 4096) return unavailable();
        return Response.json({ signedState }, { headers: { 'cache-control': 'private, no-store' } });
      }
      return Response.json({ signedReadiness: await signedReadiness(profile, key.privateKey) }, { headers: { 'cache-control': 'private, no-store' } });
    } catch {
      return unavailable();
    }
  },
};
