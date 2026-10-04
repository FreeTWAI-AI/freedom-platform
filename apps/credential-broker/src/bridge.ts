import { base64url, compactVerify, CompactSign } from 'jose';
import { ModelBrokerLimits as limits, ModelBrokerRequestSchema, ModelBrokerAssertionPayloadSchema,
  ModelBrokerProtectedHeaderSchema, ModelBrokerResponseProtectedHeaderSchema, ModelBrokerResponsePayloadSchema,
  ModelBrokerResponseEnvelopeSchema, ModelBrokerProblemCodeSchema,
  type ModelBrokerAssertionPayload, type ModelBrokerResponseEnvelope, type ModelBrokerResponsePayload } from '../../../contracts/execution/v2/model-broker-bridge.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../contracts/execution/v1/bootstrap.js';
import { freezeTree, parseBoundedJson, snapshotInput } from '../../../packages/execution-state/decode.js';
import { Problem } from '../../../packages/shared/problem.js';
import type { createModelBrokerAuthorizations } from '../../../modules/agent-control/model-broker-authorizations.js';
import type { BrokerModelExecution } from './execution.js';

export interface BrokerBridgeOptions {
  environment: RuntimeEnvironment; clientId: string; issuer: string; requestAudience: string;
  brokerId: string; responseAudience: string; requestKeys: ReadonlyMap<string, CryptoKey>;
  responseSigningKey: CryptoKey; responseKeyId: string;
  authorizations: ReturnType<typeof createModelBrokerAuthorizations>; execution: BrokerModelExecution;
}
const genuineBridges=new WeakSet<object>();
function denied(): never { throw new Problem(403, 'model_broker_authorization_invalid', 'Broker authorization is invalid.'); }
function segment(raw: string, maximum: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw) || raw.length > Math.ceil(maximum * 4 / 3)) denied();
  const bytes = base64url.decode(raw);
  if (bytes.byteLength > maximum || base64url.encode(bytes) !== raw) denied();
  return bytes;
}
function json(bytes: Uint8Array): unknown {
  const value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  let nodes = 0;
  function visit(child: unknown, depth: number) {
    if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) denied();
    if (child && typeof child === 'object') for (const item of Object.values(child)) visit(item, depth + 1);
  }
  visit(value, 0); return value;
}
function current(payload: ModelBrokerAssertionPayload) {
  const issued = Date.parse(payload.issuedAt), expiry = Date.parse(payload.expiresAt), now = Date.now();
  if (issued > now || expiry <= now || expiry <= issued || expiry - issued > limits.authorizationMs) denied();
}

/** No Actor, plaintext, prompt, endpoint or opaque evidence enters this port.
 * Signature authenticates the narrow statement; current SQL authorizations
 * and the existing domain guards still decide every effect. */
export async function createBrokerBridge(options: BrokerBridgeOptions) {
  const environment = RuntimeEnvironmentSchema.parse(options.environment), clientId = BootstrapClientIdSchema.parse(options.clientId);
  const { issuer, requestAudience, brokerId, responseAudience, responseSigningKey, responseKeyId } = options;
  const authorizations = options.authorizations, execution = options.execution;
  const keys = new Map<string, CryptoKey>();
  const configuration = () => { throw new Problem(503, 'model_broker_unavailable', 'Broker ports are unavailable.'); };
  if (!authorizations || !execution || typeof execution.run !== 'function'
    || ![issuer, requestAudience, brokerId, responseAudience].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$(?![\s\S])/.test(value))
    || issuer === brokerId || requestAudience === responseAudience
    || !(responseSigningKey instanceof CryptoKey) || responseSigningKey.type !== 'private'
    || responseSigningKey.algorithm.name !== 'Ed25519' || !responseSigningKey.usages.includes('sign')) configuration();
  const responseHeader = ModelBrokerResponseProtectedHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-model-broker-response+jws', kid: responseKeyId });
  if (!options.requestKeys || options.requestKeys.size < 1 || options.requestKeys.size > 16) configuration();
  for (const [kid, key] of options.requestKeys) {
    ModelBrokerProtectedHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-model-broker-assertion+jws', kid });
    if (!(key instanceof CryptoKey) || key.type !== 'public' || key.algorithm.name !== 'Ed25519'
      || key.usages.length !== 1 || key.usages[0] !== 'verify') configuration();
    keys.set(kid, key);
  }
  // Different labels alone do not separate signing directions. Prove that the
  // response private key is not paired with any accepted request public key.
  const separation = new TextEncoder().encode('freedom/model-broker/key-direction-separation/v1');
  const signature = await crypto.subtle.sign('Ed25519', responseSigningKey, separation);
  for (const key of keys.values()) if (await crypto.subtle.verify('Ed25519', key, signature, separation)) configuration();
  const bridge=Object.freeze({
    async handle(raw: unknown): Promise<ModelBrokerResponseEnvelope> {
      let payload: ModelBrokerAssertionPayload;
      try {
        const request = ModelBrokerRequestSchema.parse(snapshotInput(raw));
        const parts = request.assertion.split('.');
        const header = ModelBrokerProtectedHeaderSchema.parse(json(segment(parts[0], limits.headerBytes)));
        payload = freezeTree(ModelBrokerAssertionPayloadSchema.parse(json(segment(parts[1], limits.payloadBytes))));
        if (segment(parts[2], 64).byteLength !== 64) denied();
        const key = keys.get(header.kid);
        if (!key || payload.issuer !== issuer || payload.audience !== requestAudience || payload.environment !== environment
          || payload.clientId !== clientId || payload.authorizationRef !== request.authorizationRef || payload.nonce !== request.nonce) denied();
        current(payload);
        await compactVerify(request.assertion, key, { algorithms: ['EdDSA'] });
        current(payload);
      } catch { return denied(); }
      let outcome: ModelBrokerResponsePayload['outcome'];
      try {
        const { invocation, fresh } = await authorizations.claim(payload);
        outcome = { kind: 'metadata', step: await execution.run(invocation, fresh) };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const normalized = code === 'outcome_unknown' ? 'model_step_outcome_unknown' : code;
        const parsed = ModelBrokerProblemCodeSchema.safeParse(normalized);
        outcome = { kind: 'problem', code: parsed.success ? parsed.data : 'model_broker_unavailable' };
      }
      // Response authority is deliberately absent; main must re-read owner SQL.
      const issued = Date.now();
      const response = ModelBrokerResponsePayloadSchema.parse({ profile: 'model-broker.response/v1', issuer: brokerId,
        audience: responseAudience, purpose: 'model-broker.response', environment, clientId,
        authorizationRef: payload.authorizationRef, nonce: payload.nonce, commandDigest: payload.commandDigest,
        recoveryGeneration: payload.recoveryGeneration, issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(issued + limits.responseMs).toISOString(), outcome, operational_authority: false });
      const bytes = new TextEncoder().encode(JSON.stringify(response));
      if (bytes.byteLength > limits.payloadBytes) throw new Problem(503, 'model_broker_unavailable', 'Broker response is unavailable.');
      const compact = await new CompactSign(bytes).setProtectedHeader(responseHeader).sign(responseSigningKey);
      if (Date.now() >= issued + limits.responseMs) throw new Problem(503, 'model_broker_unavailable', 'Broker response is unavailable.');
      return freezeTree(ModelBrokerResponseEnvelopeSchema.parse({ response: compact }));
    },
  });
  genuineBridges.add(bridge);return bridge;
}
export function assertGenuineBrokerBridge(bridge:BrokerBridge):void {
  if(!bridge||typeof bridge!=='object'||!genuineBridges.has(bridge))throw new Problem(503,'model_broker_unavailable','Broker ports are unavailable.');
}
export type BrokerBridge = Awaited<ReturnType<typeof createBrokerBridge>>;
