import { createHash, randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { base64url, compactVerify, CompactSign } from 'jose';
import { createMachineModelBrokerAuthorizations } from '../../../modules/agent-control/machine-model-broker-authorizations.js';
import { createMachineModelStepService } from '../../../modules/agent-execution/machine-model-step.js';
import { createUnavailableModelStepHost, type RecoveryObservation } from '../../../modules/agent-execution/model-step-host.js';
import type { MachineModelSubject, MachineTextAuthority } from '../../../modules/agent-control/machine-text-authority.js';
import { MachineModelBrokerLimits as limits, MachineModelBrokerAssertionPayloadSchema, MachineModelBrokerCommandSchema,
  MachineModelBrokerProtectedHeaderSchema, MachineModelBrokerRequestSchema, MachineModelBrokerResponseEnvelopeSchema,
  MachineModelBrokerResponsePayloadSchema, MachineModelBrokerResponseProtectedHeaderSchema,
  type MachineModelBrokerRequest, type MachineModelBrokerResponseEnvelope } from '../../../contracts/execution/v3/machine-model-broker.js';
import type { RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import type { ModelStepBeginInput, ModelStepMetadata } from '../../../contracts/execution/v2/model-step.js';
import { freezeTree, parseBoundedJson, snapshotInput } from '../../../packages/execution-state/decode.js';
import { CredentialRecoveryFloorSchema } from '../../../contracts/execution/v2/model-credential.js';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';
import { Problem } from '../../../packages/shared/problem.js';

declare const machineBrokerClientBrand: unique symbol;
export interface MachineModelBrokerClient { readonly [machineBrokerClientBrand]: never }
export interface MachineModelBrokerClientOptions {
  origin: string; environment: RuntimeEnvironment; clientId: string; issuer: string; audience: string;
  requestKey: CryptoKey; requestKid: string; responseKeys: ReadonlyMap<string, CryptoKey>;
  brokerIdentity: string; responseAudience: string; recover: () => Promise<RecoveryObservation>;
  exchange: (request: MachineModelBrokerRequest) => Promise<MachineModelBrokerResponseEnvelope>; store: ObjectStore;
}
type Client = { pool: Pool; origin: string; environment: string; clientId: string;
  execute: (authority: MachineTextAuthority, subject: MachineModelSubject, digests: { proofDigest: string; accessTokenDigest: string }, input: ModelStepBeginInput, signal?: AbortSignal) => Promise<ModelStepMetadata> };
const clients = new WeakMap<object, Client>();
const statuses: Record<string, number> = { machine_broker_authorization_invalid: 403, machine_broker_authorization_consumed: 409,
  machine_broker_unavailable: 503, model_step_binding_stale: 409, model_step_outcome_unknown: 503, model_step_result_unavailable: 409, idempotency_conflict: 409, request_aborted: 400 };
const messages: Record<string, string> = { machine_broker_unavailable: '機器模型執行暫時無法使用。', machine_broker_authorization_invalid: '機器模型授權無效。', machine_broker_authorization_consumed: '機器模型授權已使用。' };
function unavailable(): never { throw new Problem(503, 'machine_broker_unavailable', messages.machine_broker_unavailable!); }
function segment(raw: string, maximum: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw) || raw.length > Math.ceil(maximum * 4 / 3)) unavailable();
  const bytes = base64url.decode(raw);
  if (bytes.byteLength > maximum || base64url.encode(bytes) !== raw) unavailable();
  return bytes;
}
function json(bytes: Uint8Array): unknown {
  const parsed = parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); let nodes = 0;
  const visit = (value: unknown, depth: number) => { if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) unavailable();
    if (value && typeof value === 'object') for (const child of Object.values(value)) visit(child, depth + 1); };
  visit(parsed, 0); return parsed;
}
function known(error: unknown): error is Problem { return error instanceof Problem && Object.hasOwn(statuses, error.code); }
/** Main-side machine issuer. It stores digests and pins only, and it has no
 * vault key, ciphertext pool or credential resolver. */
export async function createMachineModelBrokerClient(pool: Pool, options: MachineModelBrokerClientOptions): Promise<MachineModelBrokerClient> {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype) unavailable();
  const d = Object.getOwnPropertyDescriptors(options), names = ['origin', 'environment', 'clientId', 'issuer', 'audience', 'requestKey', 'requestKid',
    'responseKeys', 'brokerIdentity', 'responseAudience', 'recover', 'exchange', 'store'];
  if (Reflect.ownKeys(options).length !== names.length || names.some(key => !d[key]?.enumerable || !('value' in d[key]))) unavailable();
  const { origin, environment, clientId, issuer, audience, requestKey, requestKid, brokerIdentity, responseAudience, recover, exchange, store } = options;
  const authorizations = createMachineModelBrokerAuthorizations(pool, { environment, clientId, issuer, audience, recover });
  const url = new URL(origin);
  if (url.origin !== origin || url.username || url.password || url.hash || url.search
    || (url.protocol !== 'https:' && (url.protocol !== 'http:' || environment !== 'local' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
    || typeof exchange !== 'function' || typeof recover !== 'function' || !store || issuer === brokerIdentity || audience === responseAudience
    || ![issuer, audience, brokerIdentity, responseAudience].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$(?![\s\S])/.test(value))
    || !(requestKey instanceof CryptoKey) || requestKey.type !== 'private' || requestKey.algorithm.name !== 'Ed25519' || !requestKey.usages.includes('sign')) unavailable();
  const header = MachineModelBrokerProtectedHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-machine-model-broker-assertion+jws', kid: requestKid });
  if (!options.responseKeys || options.responseKeys.size < 1 || options.responseKeys.size > 16) unavailable();
  const responseKeys = new Map<string, CryptoKey>();
  for (const [kid, key] of options.responseKeys) {
    MachineModelBrokerResponseProtectedHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-machine-model-broker-response+jws', kid });
    if (!(key instanceof CryptoKey) || key.type !== 'public' || key.algorithm.name !== 'Ed25519' || key.usages.length !== 1 || key.usages[0] !== 'verify') unavailable();
    responseKeys.set(kid, key);
  }
  const separation = new TextEncoder().encode('freedom/machine-model-broker/key-direction-separation/v1');
  const signed = await crypto.subtle.sign('Ed25519', requestKey, separation);
  for (const key of responseKeys.values()) if (await crypto.subtle.verify('Ed25519', key, signed, separation)) unavailable();
  async function execute(authority: MachineTextAuthority, subject: MachineModelSubject, digests: { proofDigest: string; accessTokenDigest: string }, raw: ModelStepBeginInput, signal?: AbortSignal): Promise<ModelStepMetadata> {
    const command = freezeTree(MachineModelBrokerCommandSchema.parse({ operation: 'execute', input: snapshotInput(raw) }));
    const proofDigest = /^[0-9a-f]{64}$(?![\s\S])/.test(digests.proofDigest) ? digests.proofDigest : unavailable();
    const accessTokenDigest = /^[0-9a-f]{64}$(?![\s\S])/.test(digests.accessTokenDigest) ? digests.accessTokenDigest : unavailable();
    if (proofDigest === accessTokenDigest) unavailable();
    const service = createMachineModelStepService(pool, { environment, clientId, authority, host: createUnavailableModelStepHost(), store });
    const claims = MachineModelBrokerAssertionPayloadSchema.parse(await authorizations.issue(authority, subject, { proofDigest, accessTokenDigest }, command, randomBytes(32).toString('base64url')));
    let timer: ReturnType<typeof setTimeout> | undefined, cancelled = false, exchanged = false; const started = performance.now();
    const active = () => { if (cancelled || signal?.aborted || performance.now() - started >= 45_000 || Date.parse(claims.expiresAt) <= Date.now()) unavailable(); };
    const freshRecovery = async () => { active(); const recovered = CredentialRecoveryFloorSchema.parse(snapshotInput(await recover()));
      active(); if (recovered.generation !== claims.recoveryGeneration || Date.parse(recovered.expiresAt) <= Date.now() || Date.parse(claims.expiresAt) <= Date.now()) unavailable(); };
    try {
      const perform = async () => {
        await freshRecovery();
        const assertion = await new CompactSign(new TextEncoder().encode(JSON.stringify(claims))).setProtectedHeader(header).sign(requestKey);
        const request = freezeTree(MachineModelBrokerRequestSchema.parse({ authorizationRef: claims.authorizationRef, nonce: claims.nonce, assertion }));
        await freshRecovery(); active(); exchanged = true; const rawResponse = await exchange(request); active();
        const envelope = MachineModelBrokerResponseEnvelopeSchema.parse(snapshotInput(rawResponse)), parts = envelope.response.split('.');
        const protectedHeader = MachineModelBrokerResponseProtectedHeaderSchema.parse(json(segment(parts[0], limits.headerBytes)));
        if (segment(parts[2], 64).byteLength !== 64) unavailable();
        const key = responseKeys.get(protectedHeader.kid); if (!key) throw new Problem(403, 'machine_broker_authorization_invalid', messages.machine_broker_authorization_invalid!);
        try { await compactVerify(envelope.response, key, { algorithms: ['EdDSA'] }); }
        catch { throw new Problem(403, 'machine_broker_authorization_invalid', messages.machine_broker_authorization_invalid!); }
        const response = MachineModelBrokerResponsePayloadSchema.parse(json(segment(parts[1], limits.payloadBytes)));
        const now = Date.now(), issued = Date.parse(response.issuedAt), expiry = Date.parse(response.expiresAt);
        if (response.issuer !== brokerIdentity || response.audience !== responseAudience || response.environment !== environment || response.clientId !== clientId
          || response.authorizationRef !== claims.authorizationRef || response.nonce !== claims.nonce || response.commandDigest !== claims.commandDigest
          || response.recoveryGeneration !== claims.recoveryGeneration || issued > now || expiry <= now || expiry <= issued || expiry - issued > limits.responseMs)
          throw new Problem(403, 'machine_broker_authorization_invalid', messages.machine_broker_authorization_invalid!);
        await freshRecovery();
        if (response.outcome.kind === 'problem') throw new Problem(statuses[response.outcome.code] ?? 503, response.outcome.code, messages[response.outcome.code] ?? messages.machine_broker_unavailable!);
        if (response.outcome.step.stepId !== command.input.stepId) unavailable();
        await freshRecovery();
        const latest = await service.readSubject(subject, response.outcome.step.stepId);
        active(); return latest;
      };
      return await Promise.race([perform(), new Promise<never>((_, reject) => { timer = setTimeout(() => { cancelled = true; reject(new Problem(503, 'machine_broker_unavailable', messages.machine_broker_unavailable!)); }, 45_000); })]);
    } catch (error) {
      if (exchanged) { try { await service.reconcileLost(subject, command.input.stepId); } catch { /* admission may already be gone; no second dispatch */ } }
      if (known(error)) throw error;
      return unavailable();
    } finally { cancelled = true; if (timer) clearTimeout(timer); }
  }
  const port = Object.freeze(Object.create(null)) as MachineModelBrokerClient;
  clients.set(port, { pool, origin, environment, clientId, execute });
  return port;
}
export function bindMachineModelBrokerClient(port: MachineModelBrokerClient, pool: Pool, origin: string, environment: string, clientId: string) {
  const client = port && typeof port === 'object' ? clients.get(port) : undefined;
  if (!client || client.pool !== pool || client.origin !== origin || client.environment !== environment || client.clientId !== clientId) unavailable();
  return Object.freeze({ execute: client.execute });
}
