import { base64url, compactVerify, CompactSign } from 'jose';
import { MachineModelBrokerLimits as limits, MachineModelBrokerRequestSchema, MachineModelBrokerAssertionPayloadSchema,
  MachineModelBrokerProtectedHeaderSchema, MachineModelBrokerResponseProtectedHeaderSchema, MachineModelBrokerResponsePayloadSchema,
  MachineModelBrokerResponseEnvelopeSchema, MachineModelBrokerProblemCodeSchema,
  type MachineModelBrokerAssertionPayload, type MachineModelBrokerResponseEnvelope, type MachineModelBrokerResponsePayload } from '../../../contracts/execution/v3/machine-model-broker.js';
import { RuntimeEnvironmentSchema, type RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../../contracts/execution/v1/bootstrap.js';
import { freezeTree, parseBoundedJson, snapshotInput } from '../../../packages/execution-state/decode.js';
import { Problem } from '../../../packages/shared/problem.js';
import type { MachineModelBrokerAuthorizations } from '../../../modules/agent-control/machine-model-broker-authorizations.js';
import type { MachineBrokerModelExecution } from './machine-execution.js';

export interface MachineBrokerBridgeOptions {
  environment: RuntimeEnvironment; clientId: string; issuer: string; requestAudience: string;
  brokerId: string; responseAudience: string; requestKeys: ReadonlyMap<string, CryptoKey>;
  responseSigningKey: CryptoKey; responseKeyId: string;
  authorizations: MachineModelBrokerAuthorizations; execution: MachineBrokerModelExecution;
}
function denied(): never { throw new Problem(403, 'machine_broker_authorization_invalid', '機器模型授權無效。'); }
function segment(raw: string, maximum: number): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$(?![\s\S])/.test(raw) || raw.length > Math.ceil(maximum * 4 / 3)) denied();
  const bytes = base64url.decode(raw);
  if (bytes.byteLength > maximum || base64url.encode(bytes) !== raw) denied();
  return bytes;
}
function json(bytes: Uint8Array): unknown {
  const value = parseBoundedJson(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes));
  let nodes = 0;
  const visit = (child: unknown, depth: number) => {
    if (++nodes > limits.jsonNodes || depth > limits.jsonDepth) denied();
    if (child && typeof child === 'object') for (const item of Object.values(child)) visit(item, depth + 1);
  };
  visit(value, 0); return value;
}
function current(payload: MachineModelBrokerAssertionPayload) {
  const issued = Date.parse(payload.issuedAt), expiry = Date.parse(payload.expiresAt), now = Date.now();
  if (issued > now || expiry <= now || expiry <= issued || expiry - issued > limits.authorizationMs) denied();
}
/** Machine purpose only. A member assertion is not a machine authorization, and
 * this port never accepts an Actor, prompt, endpoint or key selector. */
export async function createMachineBrokerBridge(options: MachineBrokerBridgeOptions) {
  const environment = RuntimeEnvironmentSchema.parse(options.environment), clientId = BootstrapClientIdSchema.parse(options.clientId);
  const { issuer, requestAudience, brokerId, responseAudience, responseSigningKey, responseKeyId, authorizations, execution } = options;
  const keys = new Map<string, CryptoKey>();
  const configuration = () => { throw new Problem(503, 'machine_broker_unavailable', '機器模型執行暫時無法使用。'); };
  if (!authorizations || !execution || typeof execution.run !== 'function'
    || ![issuer, requestAudience, brokerId, responseAudience].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$(?![\s\S])/.test(value))
    || issuer === brokerId || requestAudience === responseAudience
    || !(responseSigningKey instanceof CryptoKey) || responseSigningKey.type !== 'private'
    || responseSigningKey.algorithm.name !== 'Ed25519' || !responseSigningKey.usages.includes('sign')) configuration();
  const responseHeader = MachineModelBrokerResponseProtectedHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-machine-model-broker-response+jws', kid: responseKeyId });
  if (!options.requestKeys || options.requestKeys.size < 1 || options.requestKeys.size > 16) configuration();
  for (const [kid, key] of options.requestKeys) {
    MachineModelBrokerProtectedHeaderSchema.parse({ alg: 'EdDSA', typ: 'freedom-machine-model-broker-assertion+jws', kid });
    if (!(key instanceof CryptoKey) || key.type !== 'public' || key.algorithm.name !== 'Ed25519' || key.usages.length !== 1 || key.usages[0] !== 'verify') configuration();
    keys.set(kid, key);
  }
  const separation = new TextEncoder().encode('freedom/machine-model-broker/key-direction-separation/v1');
  const signature = await crypto.subtle.sign('Ed25519', responseSigningKey, separation);
  for (const key of keys.values()) if (await crypto.subtle.verify('Ed25519', key, signature, separation)) configuration();
  return Object.freeze({
    async handle(raw: unknown): Promise<MachineModelBrokerResponseEnvelope> {
      let payload: MachineModelBrokerAssertionPayload;
      try {
        const request = MachineModelBrokerRequestSchema.parse(snapshotInput(raw));
        const parts = request.assertion.split('.');
        const header = MachineModelBrokerProtectedHeaderSchema.parse(json(segment(parts[0], limits.headerBytes)));
        payload = freezeTree(MachineModelBrokerAssertionPayloadSchema.parse(json(segment(parts[1], limits.payloadBytes))));
        if (segment(parts[2], 64).byteLength !== 64) denied();
        const key = keys.get(header.kid);
        if (!key || payload.issuer !== issuer || payload.audience !== requestAudience || payload.environment !== environment
          || payload.clientId !== clientId || payload.authorizationRef !== request.authorizationRef || payload.nonce !== request.nonce
          || payload.purpose !== 'machine-model-broker.execute') denied();
        current(payload);
        await compactVerify(request.assertion, key, { algorithms: ['EdDSA'] });
        current(payload);
      } catch (error) { if (error instanceof Problem && error.code === 'machine_broker_authorization_invalid') throw error; return denied(); }
      let outcome: MachineModelBrokerResponsePayload['outcome'];
      try {
        const { invocation, fresh } = await authorizations.claim(payload);
        outcome = { kind: 'metadata', step: await execution.run(invocation, fresh) };
      } catch (error) {
        const code = (error as { code?: string })?.code;
        const normalized = code === 'outcome_unknown' ? 'model_step_outcome_unknown' : code;
        const parsed = MachineModelBrokerProblemCodeSchema.safeParse(normalized);
        outcome = { kind: 'problem', code: parsed.success ? parsed.data : 'machine_broker_unavailable' };
      }
      const issued = Date.now();
      const response = MachineModelBrokerResponsePayloadSchema.parse({ profile: 'machine-model-broker.response/v1', issuer: brokerId,
        audience: responseAudience, purpose: 'machine-model-broker.response', environment, clientId,
        authorizationRef: payload.authorizationRef, nonce: payload.nonce, commandDigest: payload.commandDigest,
        recoveryGeneration: payload.recoveryGeneration, issuedAt: new Date(issued).toISOString(),
        expiresAt: new Date(issued + limits.responseMs).toISOString(), outcome, operational_authority: false });
      const bytes = new TextEncoder().encode(JSON.stringify(response));
      if (bytes.byteLength > limits.payloadBytes) throw new Problem(503, 'machine_broker_unavailable', '機器模型執行暫時無法使用。');
      const compact = await new CompactSign(bytes).setProtectedHeader(responseHeader).sign(responseSigningKey);
      if (Date.now() >= issued + limits.responseMs) throw new Problem(503, 'machine_broker_unavailable', '機器模型執行暫時無法使用。');
      return freezeTree(MachineModelBrokerResponseEnvelopeSchema.parse({ response: compact }));
    },
  });
}
export type MachineBrokerBridge = Awaited<ReturnType<typeof createMachineBrokerBridge>>;
