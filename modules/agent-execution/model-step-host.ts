import { createHash, randomUUID } from 'node:crypto';
import { exchange } from './model-step-node-transport.js';
import { z } from 'zod';
import { openRouterModelPath, readOpenRouterKey, assertOpenRouterModel } from './openrouter-profile.js';
import { ModelStepBindingSchema, ModelStepContextSchema, ModelStepLimits, ModelStepUsageSchema,
  type ModelStepBinding, type ModelStepEvidenceOrigin, type ModelStepUsage } from '../../contracts/execution/v2/model-step.js';
import { MemberExecutionVersionSchema } from '../../contracts/execution/v1/member-execution.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { AdapterFault, copyModelBytes, parseModelJson } from './adapters/common.js';
import { createByokTextAdapter, type ByokObservation } from './adapters/byok.js';

declare const verifiedBrand: unique symbol;
declare const capabilityBrand: unique symbol;
declare const observationBrand: unique symbol;
export interface OpaqueVerifiedModelBinding { readonly [verifiedBrand]: never }
export interface OpaqueModelStepCapability { readonly [capabilityBrand]: never }
export interface OpaqueModelObservation { readonly [observationBrand]: never }
export interface RecoveryObservation { readonly generation: string; readonly expiresAt: string }
/** The resolver transfers ownership of fresh key bytes to the host. The host
 * clears that buffer on acceptance, rejection and late timeout completion. */
export interface ResolvedModelCredential { readonly key: Uint8Array; readonly expiresAt: string }
export interface ModelStepHost {
  verify(binding: ModelStepBinding): Promise<OpaqueVerifiedModelBinding>;
  dispatch(capability: OpaqueModelStepCapability, contextBytes: Uint8Array): Promise<OpaqueModelObservation>;
}
export interface VerifiedModelBindingData {
  readonly binding: ModelStepBinding; readonly bindingId: string; readonly evidenceDigest: string;
  readonly recoveryGeneration: string; readonly expiresAt: string; readonly evidenceOrigin: ModelStepEvidenceOrigin;
  readonly adapterProfile: 'byok-text/v1';
}
export interface ModelObservationData extends VerifiedModelBindingData {
  readonly text: string; readonly outputSha256: string; readonly outputByteSize: number;
  readonly reportedModelRef: string; readonly usage: ModelStepUsage;
}
interface PrivateVerified { data: VerifiedModelBindingData; host: object; credentialDigest: string; recover: () => Promise<RecoveryObservation>; resolve: (binding: ModelStepBinding) => Promise<ResolvedModelCredential> }
interface PrivateCapability { binding: ModelStepBinding; verified: PrivateVerified; expiresAt: string; consumed: boolean; beforeDispatch: () => Promise<void> }
interface PrivateObservation { data: ModelObservationData; capability: OpaqueModelStepCapability; verified: PrivateVerified }
const verifiedBindings = new WeakMap<object, PrivateVerified>();
const capabilities = new WeakMap<object, PrivateCapability>();
const observations = new WeakMap<object, PrivateObservation>();
const hostIdentities = new WeakMap<object, object>();
const byok = createByokTextAdapter();
const time = z.iso.datetime({ precision: 3 });
// Official GET model profiles checked 2026-10-03:
// https://developers.openai.com/api/reference/resources/models/methods/retrieve
// https://platform.claude.com/docs/en/api/http/models/retrieve
const nonnegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const openaiModel = z.object({ id: z.string(), object: z.literal('model'), created: nonnegativeInteger,
  owned_by: z.string(), shutdown_date: z.iso.date().nullable().optional() }).strict();
const anthropicModel = z.object({ id: z.string(), type: z.literal('model'), display_name: z.string(), created_at: z.iso.datetime(),
  // Descriptive model capabilities are not this request's effective tool set;
  // the fixed HTTPS request profile explicitly sets tools=[], tool_choice=none.
  capabilities: z.record(z.string(), z.unknown()).nullable().optional(),
  max_input_tokens: nonnegativeInteger.nullable().optional(), max_tokens: nonnegativeInteger.nullable().optional(),
}).strict();
const recoverySchema = z.object({ generation: MemberExecutionVersionSchema, expiresAt: time }).strict();
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (code: ConstructorParameters<typeof AdapterFault>[0]): never => { throw new AdapterFault(code); };
const token = <T>(): T => Object.freeze(Object.create(null)) as T;
const fresh = (expiresAt: string) => { if (!time.safeParse(expiresAt).success || Date.parse(expiresAt) <= Date.now()) fail('execution_authority_unavailable'); };
async function boundedHostPort<T>(operation: () => Promise<T>, discard?: (value: T) => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = performance.now() + 3000;
  const pending = Promise.resolve().then(operation).then(value => {
    if (expired || performance.now() >= deadline) {
      discard?.(value); return fail('execution_authority_unavailable');
    }
    return value;
  });
  try { return await Promise.race([pending, new Promise<never>((_, reject) => {
    timer = setTimeout(() => { expired = true; reject(new AdapterFault('execution_authority_unavailable')); }, 3000);
  })]); } catch (error) { if (error instanceof AdapterFault) throw error; return fail('execution_authority_unavailable'); }
  finally { if (timer) clearTimeout(timer); }
}

function clearTransferredCredential(raw: unknown): void {
  try {
    if (!raw || typeof raw !== 'object') return;
    const descriptor = Object.getOwnPropertyDescriptor(raw, 'key');
    if (descriptor && 'value' in descriptor && descriptor.value instanceof Uint8Array) {
      Uint8Array.prototype.fill.call(descriptor.value, 0);
    }
  } catch { /* A malformed port result must not prevent clearing other buffers. */ }
}

export function parseModelStepBinding(raw: unknown): ModelStepBinding {
  try {
    const binding = ModelStepBindingSchema.parse(snapshotInput(raw));
    if (BigInt(binding.baseRunVersion) + 1n !== BigInt(binding.runVersion)
      || BigInt(binding.baseTaskLeaseEpoch) + 1n !== BigInt(binding.taskLeaseEpoch)) fail('invalid_input');
    return freezeTree(binding);
  } catch { return fail('invalid_input'); }
}
const sameBinding = (a: ModelStepBinding, b: unknown) => JSON.stringify(a) === JSON.stringify(parseModelStepBinding(b));
/** No assets, ambient files, truncation, locale normalization or prompt injection
 * from request JSON. Only exact server-resolved title/objective are encoded. */
export function encodeModelStepContext(raw: unknown): Uint8Array {
  try {
    const value = ModelStepContextSchema.parse(snapshotInput(raw));
    if (value.title.includes('\0') || value.objective.includes('\0')) fail('invalid_input');
    const bytes = new TextEncoder().encode(JSON.stringify({ schema: 'model-step.context/v1', title: value.title, objective: value.objective }));
    if (bytes.byteLength > ModelStepLimits.inputBytes) fail('invalid_input');
    return bytes;
  } catch { return fail('invalid_input'); }
}
function context(raw: Uint8Array, binding: ModelStepBinding): { bytes: Uint8Array; prompt: string } {
  const bytes = copyModelBytes(raw, ModelStepLimits.inputBytes);
  if (bytes.byteLength !== binding.inputByteSize || digest(bytes) !== binding.contextSha256) fail('invalid_input');
  const canonical = encodeModelStepContext(parseModelJson(bytes));
  if (digest(canonical) !== binding.contextSha256) fail('invalid_input');
  return { bytes, prompt: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}
function getVerified(raw: OpaqueVerifiedModelBinding): PrivateVerified {
  if (!raw || typeof raw !== 'object') fail('execution_authority_unavailable');
  const value = verifiedBindings.get(raw); if (!value) fail('execution_authority_unavailable'); return value!;
}
function getCapability(raw: OpaqueModelStepCapability): PrivateCapability {
  if (!raw || typeof raw !== 'object') fail('execution_authority_unavailable');
  const value = capabilities.get(raw); if (!value) fail('execution_authority_unavailable'); return value!;
}
function getObservation(raw: OpaqueModelObservation): PrivateObservation {
  if (!raw || typeof raw !== 'object') fail('execution_authority_unavailable');
  const value = observations.get(raw); if (!value) fail('execution_authority_unavailable'); return value!;
}
export function readVerifiedModelBinding(raw: OpaqueVerifiedModelBinding, binding: ModelStepBinding): VerifiedModelBindingData {
  const value = getVerified(raw); if (!sameBinding(value.data.binding, binding)) fail('execution_authority_unavailable');
  fresh(value.data.expiresAt); return value.data;
}
/** PRIVATE service adapter entry, called only after the fresh begin transaction
 * commits. JSON, copied token objects and receipts cannot mint a capability. */
export function createModelStepCapability(binding: ModelStepBinding, verified: OpaqueVerifiedModelBinding, expiresAt: string, beforeDispatch: () => Promise<void>): OpaqueModelStepCapability {
  const proof = getVerified(verified), data = readVerifiedModelBinding(verified, binding);
  fresh(expiresAt);
  if (typeof beforeDispatch !== 'function' || Date.parse(expiresAt) > Date.parse(data.expiresAt) || Date.parse(expiresAt) > Date.now() + 5000) fail('execution_authority_unavailable');
  const cap = token<OpaqueModelStepCapability>();
  capabilities.set(cap, { binding: data.binding, verified: proof, expiresAt, consumed: false, beforeDispatch }); return cap;
}
export function readModelStepCapability(raw: OpaqueModelStepCapability) {
  const value = getCapability(raw);
  return Object.freeze({ binding: value.binding, verified: value.verified.data, expiresAt: value.expiresAt, consumed: value.consumed });
}
export function readModelObservation(raw: OpaqueModelObservation, capability: OpaqueModelStepCapability): ModelObservationData {
  const value = getObservation(raw);
  if (value.capability !== capability || !getCapability(capability).consumed) fail('execution_authority_unavailable');
  return value.data;
}
export function readBoundModelObservation(raw: OpaqueModelObservation, binding: ModelStepBinding): ModelObservationData {
  const value = getObservation(raw);
  if (!sameBinding(value.data.binding, binding)) fail('execution_authority_unavailable'); return value.data;
}
/** The finalizer must accept observations from its configured host instance,
 * even if another trusted fixture/provider host has the same data labels. */
export function assertModelObservationHost(raw: OpaqueModelObservation, host: ModelStepHost): void {
  const observation = getObservation(raw);
  if (!host || typeof host !== 'object' || hostIdentities.get(host) !== observation.verified.host) fail('execution_authority_unavailable');
}
async function recovery(recover: () => Promise<RecoveryObservation>): Promise<RecoveryObservation> {
  try { const result = recoverySchema.parse(snapshotInput(await boundedHostPort(recover))); fresh(result.expiresAt); return Object.freeze(result); }
  catch { return fail('execution_authority_unavailable'); }
}
export async function assertModelObservationCurrent(raw: OpaqueModelObservation): Promise<void> {
  const observation = getObservation(raw), current = await recovery(observation.verified.recover);
  fresh(observation.data.expiresAt);
  if (current.generation !== observation.data.recoveryGeneration) fail('execution_authority_unavailable');
  const resolved = await credential(observation.verified.resolve, observation.data.binding);
  try { if (digest(resolved.key) !== observation.verified.credentialDigest) fail('authentication_unavailable'); fresh(resolved.expiresAt); fresh(observation.data.expiresAt); }
  finally { resolved.key.fill(0); }
}
async function credential(resolve: (binding: ModelStepBinding) => Promise<ResolvedModelCredential>, binding: ModelStepBinding): Promise<ResolvedModelCredential> {
  let raw: unknown, key: Uint8Array | undefined;
  try {
    raw = await boundedHostPort(() => resolve(binding), clearTransferredCredential);
    if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).length !== 2) fail('authentication_unavailable');
    const descriptors = Object.getOwnPropertyDescriptors(raw);
    if (!descriptors.key || !descriptors.expiresAt || Object.values(descriptors).some(d => !d.enumerable || !('value' in d))) fail('authentication_unavailable');
    key = copyModelBytes(descriptors.key.value, 4096);
    const expiresAt: unknown = descriptors.expiresAt.value;
    if (typeof expiresAt !== 'string' || !time.safeParse(expiresAt).success || Date.parse(expiresAt) <= Date.now()) fail('authentication_unavailable');
    if (!key.byteLength || key.some(byte => !(byte >= 48 && byte <= 57 || byte >= 65 && byte <= 90
      || byte >= 97 && byte <= 122 || byte === 45 || byte === 46 || byte === 95))) fail('authentication_unavailable');
    const result = { key, expiresAt: expiresAt as string };
    key = undefined;
    return result;
  } catch { return fail('authentication_unavailable'); }
  finally { clearTransferredCredential(raw); key?.fill(0); }
}

interface HostOptions {
  recover: () => Promise<RecoveryObservation>;
  resolveCredential: (binding: ModelStepBinding) => Promise<ResolvedModelCredential>;
}
function ports(raw: HostOptions) {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype) fail('invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const name of ['recover', 'resolveCredential']) if (!descriptors[name] || !('value' in descriptors[name])
    || !descriptors[name].enumerable || typeof descriptors[name].value !== 'function') fail('invalid_input');
  return { recover: descriptors.recover.value as HostOptions['recover'], resolve: descriptors.resolveCredential.value as HostOptions['resolveCredential'] };
}
const providerNetwork = Object.freeze({
  openai: Object.freeze({ origin: 'https://api.openai.com', auth: 'bearer' }),
  anthropic: Object.freeze({ origin: 'https://api.anthropic.com', auth: 'anthropic' }),
  openrouter: Object.freeze({ origin: 'https://openrouter.ai', auth: 'bearer' }),
});
function networkProfile(provider: string) {
  if (!Object.hasOwn(providerNetwork, provider)) return fail('unsupported_selection');
  return providerNetwork[provider as keyof typeof providerNetwork];
}
function authHeaders(binding: ModelStepBinding, key: Uint8Array): Record<string, string> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(key);
  return networkProfile(binding.selection.providerRef).auth === 'bearer'
    ? { Authorization: `Bearer ${text}` }
    : { 'x-api-key': text, 'anthropic-version': '2023-06-01' };
}
/** Native fixed-origin HTTP transport: no redirect, proxy environment, custom
 * fetch/URL, request body or TLS trust override enters a public input. */

function supported(binding: ModelStepBinding) {
  if (binding.selection.credentialCustody === 'official_cli' || binding.selection.billingSource !== 'user_byok'
    || binding.selection.processingLocation !== 'provider_remote' || binding.selection.artifactCustody !== 'platform_asset'
    || !Object.hasOwn(providerNetwork, binding.selection.providerRef)) fail('unsupported_selection');
  if (binding.selection.providerRef === 'openrouter') openRouterModelPath(binding.selection.modelRef);
}
function host(options: HostOptions, origin: ModelStepEvidenceOrigin, fixtureOrigin?: string): ModelStepHost {
  const captured = ports(options), identity = token<object>();
  const target = (binding: ModelStepBinding, path: string) => new URL(path, fixtureOrigin
    ?? networkProfile(binding.selection.providerRef).origin);
  const result: ModelStepHost = Object.freeze({
    async verify(raw: ModelStepBinding) {
      const binding = parseModelStepBinding(raw); supported(binding);
      if (origin === 'synthetic_local_fixture' && binding.environment !== 'local') fail('unsupported_selection');
      // This server host does not attest a native member runtime/keychain. A
      // future native host needs its own authenticated custody/runtime port.
      if (origin === 'provider_https' && (binding.selection.credentialCustody !== 'platform_vault'
        || binding.selection.engineLocation !== 'platform')) fail('unsupported_selection');
      const before = await recovery(captured.recover), resolved = await credential(captured.resolve, binding);
      let response: ByokObservation, credentialDigest: string, providerKeyExpiry: string | null = null;
      try {
        credentialDigest = digest(resolved.key);
        if (binding.selection.providerRef === 'openrouter') {
          const authenticated = await exchange(target(binding, '/api/v1/key'), 'GET', authHeaders(binding, resolved.key));
          providerKeyExpiry = readOpenRouterKey(authenticated.body).expiresAt;
          response = await exchange(target(binding, openRouterModelPath(binding.selection.modelRef)), 'GET', authHeaders(binding, resolved.key));
        } else response = await exchange(target(binding, `/v1/models/${encodeURIComponent(binding.selection.modelRef)}`), 'GET', authHeaders(binding, resolved.key));
      }
      finally { resolved.key.fill(0); }
      if (binding.selection.providerRef === 'openrouter') assertOpenRouterModel(response.body, binding.selection.modelRef, binding.maxOutputTokens);
      else {
      const observed = parseModelJson(response.body);
      const model = binding.selection.providerRef === 'openai' ? openaiModel.safeParse(observed) : anthropicModel.safeParse(observed);
      if (!model.success) return fail('model_mismatch');
      if (model.data.id !== binding.selection.modelRef) fail('model_mismatch');
      if ('shutdown_date' in model.data && model.data.shutdown_date && model.data.shutdown_date <= new Date().toISOString().slice(0, 10)) fail('unsupported_selection');
      if ('max_tokens' in model.data && model.data.max_tokens !== null && model.data.max_tokens !== undefined
        && model.data.max_tokens < binding.maxOutputTokens) fail('unsupported_selection');
      }
      const after = await recovery(captured.recover);
      if (before.generation !== after.generation) fail('execution_authority_unavailable');
      const expiresAt = new Date(Math.min(Date.now() + 90000, Date.parse(before.expiresAt), Date.parse(after.expiresAt), Date.parse(resolved.expiresAt), providerKeyExpiry ? Date.parse(providerKeyExpiry) : Infinity)).toISOString();
      fresh(expiresAt);
      const data: VerifiedModelBindingData = freezeTree({ binding, bindingId: randomUUID(), evidenceDigest: digest(response.body),
        recoveryGeneration: after.generation, expiresAt, evidenceOrigin: origin, adapterProfile: 'byok-text/v1' });
      const proof = token<OpaqueVerifiedModelBinding>();
      verifiedBindings.set(proof, { data, host: identity, credentialDigest, recover: captured.recover, resolve: captured.resolve }); return proof;
    },
    async dispatch(raw: OpaqueModelStepCapability, bytes: Uint8Array) {
      const cap = getCapability(raw);
      if (cap.verified.host !== identity || cap.consumed) fail('execution_authority_unavailable');
      fresh(cap.expiresAt); fresh(cap.verified.data.expiresAt);
      // Spend BEFORE the first await. Any subsequent failure cannot be retried
      // with this object even when the provider never received a request.
      cap.consumed = true;
      const input = context(bytes, cap.binding);
      let resolved: ResolvedModelCredential | undefined;
      let candidate: ReturnType<typeof byok.prepare> | undefined;
      let response: ByokObservation;
      try {
        const generation = await recovery(captured.recover);
        if (generation.generation !== cap.verified.data.recoveryGeneration) fail('execution_authority_unavailable');
        resolved = await credential(captured.resolve, cap.binding);
        candidate = byok.prepare({ selection: cap.binding.selection, prompt: input.prompt, maxOutputTokens: cap.binding.maxOutputTokens });
        if (digest(resolved.key) !== cap.verified.credentialDigest) fail('authentication_unavailable');
        const immediatelyBefore = await recovery(captured.recover);
        if (immediatelyBefore.generation !== cap.verified.data.recoveryGeneration) fail('execution_authority_unavailable');
        await boundedHostPort(cap.beforeDispatch);
        fresh(cap.expiresAt); fresh(cap.verified.data.expiresAt); fresh(resolved.expiresAt);
        const endpoint = new URL(candidate.endpoint);
        if (endpoint.origin !== networkProfile(cap.binding.selection.providerRef).origin) fail('unsupported_selection');
        response = await exchange(fixtureOrigin ? target(cap.binding, endpoint.pathname) : endpoint, 'POST', { ...candidate.headers, ...authHeaders(cap.binding, resolved.key) }, candidate.body);
      } finally { resolved?.key.fill(0); input.bytes.fill(0); candidate?.body.fill(0); }
      const decoded = byok.decode(response, { selection: cap.binding.selection, prompt: input.prompt, maxOutputTokens: cap.binding.maxOutputTokens });
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(decoded.text)) fail('invalid_response');
      if (decoded.reportedModelRef !== cap.binding.selection.modelRef) fail('model_mismatch');
      const usage = ModelStepUsageSchema.parse(decoded.usage);
      if (usage.inputTokens + usage.outputTokens !== usage.totalTokens || !Number.isSafeInteger(usage.totalTokens)) fail('invalid_response');
      const after = await recovery(captured.recover);
      if (after.generation !== cap.verified.data.recoveryGeneration) fail('execution_authority_unavailable');
      fresh(cap.verified.data.expiresAt);
      const output = new TextEncoder().encode(decoded.text);
      const data: ModelObservationData = freezeTree({ ...cap.verified.data, expiresAt: new Date(Math.min(Date.parse(cap.verified.data.expiresAt), Date.parse(after.expiresAt))).toISOString(),
        evidenceDigest: digest(response.body), text: decoded.text, outputSha256: digest(output), outputByteSize: output.byteLength,
        reportedModelRef: decoded.reportedModelRef!, usage });
      const result = token<OpaqueModelObservation>(); observations.set(result, { data, capability: raw, verified: cap.verified }); return result;
    },
  });
  hostIdentities.set(result, identity); return result;
}
/** No ambient credential or recovery source. Missing ports remain unavailable. */
export function createUnavailableModelStepHost(): ModelStepHost {
  return Object.freeze({ async verify() { return fail('execution_authority_unavailable'); }, async dispatch() { return fail('execution_authority_unavailable'); } });
}
export function createByokModelStepHost(options: HostOptions): ModelStepHost {
  ports(options);
  if (Reflect.ownKeys(options).some(name => name !== 'recover' && name !== 'resolveCredential')) fail('invalid_input');
  return host(options, 'provider_https');
}
/** Test-only caller chooses a loopback SERVER origin at factory creation. The
 * evidence origin remains synthetic, and staging/production bindings reject. */
export function createLocalFixtureModelStepHost(options: HostOptions & { environment: 'local'; origin: string }): ModelStepHost {
  const captured = ports(options), descriptors = Object.getOwnPropertyDescriptors(options);
  if (Reflect.ownKeys(options).some(name => !['recover', 'resolveCredential', 'environment', 'origin'].includes(String(name)))
    || !descriptors.environment || !('value' in descriptors.environment) || descriptors.environment.value !== 'local'
    || !descriptors.origin || !('value' in descriptors.origin) || typeof descriptors.origin.value !== 'string') fail('invalid_input');
  let origin: URL;
  try { origin = new URL(descriptors.origin.value as string); } catch { return fail('invalid_input'); }
  // Numeric loopback avoids trusting ambient DNS even in the fixture factory.
  if (origin.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(origin.hostname) || !origin.port
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash || origin.origin !== descriptors.origin.value) fail('invalid_input');
  return host({ recover: captured.recover, resolveCredential: captured.resolve }, 'synthetic_local_fixture', origin.origin);
}
