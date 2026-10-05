import { MemberExecutionVersionSchema } from '../../../contracts/execution/v1/member-execution.js';
import { parseBoundedJson } from '../../../packages/execution-state/decode.js';
import { AuthorityProfileSchema, type AuthorityProfile, installedAuthorityProfile, type AuthorityPublicBindings } from './profile.js';

const STORAGE_IDENTITY = 'identity';
const STORAGE_KIND = 'kind';
const STORAGE_HIGH_WATER = 'high-water';
const INTERNAL_URL = 'https://freedom-private-ai-authority.internal/current';

/** Structural subset of the workerd storage transaction. No delete method is used. */
interface GenerationTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: string): Promise<void>;
}
interface GenerationState {
  storage: { transaction<T>(closure: (txn: GenerationTransaction) => Promise<T>): Promise<T> };
}

export interface AuthorityGenerationRecord { kind: 'generation' | 'capture-policy'; value: string }

/** Persistent monotonic authority for one purpose/environment/authority.
 * Storage is the only generation or digest source. Instance fields are not
 * consulted, and this object has no reset or public advance method. */
export class AuthorityGeneration {
  constructor(private readonly ctx: GenerationState, private readonly env: AuthorityPublicBindings) {}

  async fetch(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method !== 'GET' || url.href !== INTERNAL_URL || url.search !== '' || url.hash !== '') throw new Error('authority_unavailable');
      if (request.headers.has('content-length') || request.headers.has('transfer-encoding')) throw new Error('authority_unavailable');
      const installed = installedAuthorityProfile(this.env);
      if (JSON.stringify(configuredFrom(request)) !== JSON.stringify(installed)) throw new Error('authority_unavailable');
      const record = await this.ctx.storage.transaction((txn) => this.reconcile(txn, installed));
      return Response.json(record);
    } catch {
      return Response.json({ code: 'private_ai_authority_unavailable' }, { status: 503, headers: { 'cache-control': 'private, no-store' } });
    }
  }

  private async reconcile(txn: GenerationTransaction, configured: AuthorityProfile): Promise<AuthorityGenerationRecord> {
    const identity = `${configured.purpose}\n${configured.environment}\n${configured.authority}`;
    const storedIdentity = await txn.get<string>(STORAGE_IDENTITY);
    if (storedIdentity === undefined) await txn.put(STORAGE_IDENTITY, identity);
    else if (storedIdentity !== identity) throw new Error('authority_unavailable');
    if (configured.purpose === 'capture-readiness') return this.policy(txn, configured);
    return this.generation(txn, configured.generation);
  }

  private async generation(txn: GenerationTransaction, configured: string): Promise<AuthorityGenerationRecord> {
    const next = MemberExecutionVersionSchema.parse(configured);
    const kind = await txn.get<string>(STORAGE_KIND);
    const stored = await txn.get<string>(STORAGE_HIGH_WATER);
    if (stored === undefined) {
      if (kind !== undefined) throw new Error('authority_unavailable');
      await txn.put(STORAGE_KIND, 'generation');
      await txn.put(STORAGE_HIGH_WATER, next);
      return { kind: 'generation', value: next };
    }
    if (kind !== 'generation') throw new Error('authority_unavailable');
    const current = MemberExecutionVersionSchema.parse(stored);
    if (BigInt(next) < BigInt(current)) throw new Error('authority_rollback');
    if (BigInt(next) > BigInt(current)) await txn.put(STORAGE_HIGH_WATER, next);
    return { kind: 'generation', value: BigInt(next) > BigInt(current) ? next : current };
  }

  private async policy(txn: GenerationTransaction, configured: Extract<AuthorityProfile, { purpose: 'capture-readiness' }>): Promise<AuthorityGenerationRecord> {
    const kind = await txn.get<string>(STORAGE_KIND);
    const stored = await txn.get<string>(STORAGE_HIGH_WATER);
    const version = await txn.get<string>('policy-version');
    const origin = await txn.get<string>('policy-origin');
    if (stored === undefined) {
      if (kind !== undefined || version !== undefined || origin !== undefined) throw new Error('authority_unavailable');
    } else {
      if (kind !== 'capture-policy' || !/^[0-9a-f]{64}$/.test(stored) || typeof origin !== 'string') throw new Error('authority_unavailable');
      const current = MemberExecutionVersionSchema.parse(version);
      if (BigInt(configured.capturePolicyVersion) < BigInt(current)) throw new Error('authority_rollback');
      if (configured.capturePolicyVersion === current && (configured.capturePolicySha256 !== stored || configured.setupOrigin !== origin)) throw new Error('authority_policy_mismatch');
    }
    await txn.put(STORAGE_KIND, 'capture-policy');
    await txn.put(STORAGE_HIGH_WATER, configured.capturePolicySha256);
    await txn.put('policy-version', configured.capturePolicyVersion);
    await txn.put('policy-origin', configured.setupOrigin);
    return { kind: 'capture-policy', value: configured.capturePolicySha256 };
  }
}

function configuredFrom(request: Request): AuthorityProfile {
  const raw = request.headers.get('x-fp-authority-profile');
  if (!raw || raw.length > 4096 || request.headers.get('x-fp-authority-signing-key')) throw new Error('authority_unavailable');
  return AuthorityProfileSchema.parse(parseBoundedJson(raw));
}
