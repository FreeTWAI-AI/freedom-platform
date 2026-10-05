import type { FileHandle } from 'node:fs/promises';
import { z } from 'zod';
import { NativeTextLimits, NativeTextReceiptSchema, type NativeTextBinding, type NativeTextReceipt } from '../../../contracts/execution/v3/native-text-invocation.js';
import { freezeTree, snapshotInput } from '../../../packages/execution-state/decode.js';
import { AdapterFault, type CliArtifact, type CliObservation } from './common.js';
import { nativeArtifactSnapshot, pinNativeExecutable, runPinnedNative, isolatedNativeArguments } from './native-executable.js';
import { GROK_NATIVE_TEXT_PROFILE, grokTextArguments, nativeBinding, nativeContext, nativeDigest, checkFixtureControls, decodeFixtureText } from './native-text-profile.js';

declare const authorityBrand: unique symbol;
export interface NativeTextStartAuthority { readonly [authorityBrand]: true }
export interface NativeTextClaim { readonly issuedAt: string; readonly startExpiresAt: string }
/** TRUSTED HOST PORTS, never a request body. D2b must commit an exact one-use
 * Attempt claim in SQL, and check current Grant/epochs at assertCurrent. This
 * primitive has no HTTP registration or verifier that can install these ports. */
export interface NativeTextAuthorityPorts {
  claim(binding: NativeTextBinding): Promise<NativeTextClaim>;
  assertCurrent(binding: NativeTextBinding): Promise<void>;
}
interface Authority { claim: NativeTextAuthorityPorts['claim']; current: NativeTextAuthorityPorts['assertCurrent']; spent: Set<string> }
const authorities = new WeakMap<object, Authority>();
function ownFunctions(raw: object, names: readonly string[]): Record<string, Function> {
  if (!raw || Object.getPrototypeOf(raw) !== Object.prototype || Reflect.ownKeys(raw).length !== names.length) throw new AdapterFault('invalid_input');
  const d = Object.getOwnPropertyDescriptors(raw), found: Record<string, Function> = {};
  for (const name of names) {
    if (!d[name]?.enumerable || !('value' in d[name]) || typeof d[name].value !== 'function') throw new AdapterFault('invalid_input');
    found[name] = d[name].value.bind(raw);
  }
  return found;
}
export function createNativeTextStartAuthority(ports: NativeTextAuthorityPorts): NativeTextStartAuthority {
  const p = ownFunctions(ports, ['claim','assertCurrent']);
  const token = Object.freeze(Object.create(null)) as NativeTextStartAuthority;
  authorities.set(token, { claim: p.claim as Authority['claim'], current: p.assertCurrent as Authority['current'], spent: new Set() });
  return token;
}
async function bounded<T>(work: () => Promise<T>, timeoutMs = 3000): Promise<T> {
  const started = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  try {
    const result = await Promise.race([Promise.resolve().then(work).then(value => {
      if (expired && value instanceof Uint8Array) value.fill(0); return value;
    }), new Promise<never>((_resolve,reject) => { timer = setTimeout(() => { expired = true; reject(new AdapterFault('execution_authority_unavailable')); }, timeoutMs); })]);
    if (performance.now() - started >= timeoutMs) { if (result instanceof Uint8Array) result.fill(0); throw new AdapterFault('execution_authority_unavailable'); }
    return result;
  } finally { if (timer) clearTimeout(timer); }
}
export interface NativeTextAssessment {
  readonly profile: 'grok-1.0.46-text/v1'; readonly support: 'unavailable'|'synthetic_only';
  readonly authentication: 'unverified'; readonly effectiveTools: 'unverified'|'synthetic_empty';
  readonly ordinaryCredentialCustody: 'unverified'; readonly operational_authority: false;
}
const unavailable: NativeTextAssessment = Object.freeze({ profile: 'grok-1.0.46-text/v1', support: 'unavailable',
  authentication: 'unverified', effectiveTools: 'unverified', ordinaryCredentialCustody: 'unverified', operational_authority: false });
export interface NativeTextProcessAdapter {
  assess(): Promise<NativeTextAssessment>;
  /** loadContext transfers fresh owned bytes, cleared on success, failure and
   * late timeout. Returned text is private unverified output, not a Result. */
  invoke(binding: NativeTextBinding, authority: NativeTextStartAuthority,
    loadContext: () => Promise<Uint8Array>, signal?: AbortSignal): Promise<{ readonly receipt: NativeTextReceipt; readonly text: string }>;
}
const claimSchema = z.object({ issuedAt: z.iso.datetime({ precision: 3 }), startExpiresAt: z.iso.datetime({ precision: 3 }) }).strict();
function create(artifact: CliArtifact, fixture: boolean): NativeTextProcessAdapter {
  async function inspect(snapshot: FileHandle): Promise<void> {
    const observed = await runPinnedNative(snapshot, await isolatedNativeArguments(['--tools','','--no-subagents','--disable-web-search',
      '--permission-mode','dontAsk','inspect','--json']), { timeoutMs: 3000, combinedBytes: 32768 });
    try {
      if (observed.exitCode !== 0 || observed.signal !== null || observed.stderr.byteLength) throw new AdapterFault('effective_tool_policy_unavailable');
      if (!fixture) {
        // Grok1.0.46 inspect lists discovered config, not the effective built-in
        // tool catalog after --tools. Empty fresh-home config is not ordinary
        // authenticated custody. No prompt/auth/network is exposed to this probe.
        throw new AdapterFault('effective_tool_policy_unavailable');
      }
      checkFixtureControls(observed.stdout);
    } finally { observed.stdout.fill(0); observed.stderr.fill(0); }
  }
  return Object.freeze({
    async assess() {
      let snapshot: FileHandle | undefined;
      try {
        snapshot = await pinNativeExecutable(artifact); await inspect(snapshot);
        return Object.freeze({ ...unavailable, support: 'synthetic_only' as const, effectiveTools: 'synthetic_empty' as const });
      } catch { return unavailable; }
      finally { await snapshot?.close(); }
    },
    async invoke(raw: NativeTextBinding, token: NativeTextStartAuthority, loadContext: () => Promise<Uint8Array>, signal?: AbortSignal) {
      const binding = nativeBinding(raw), auth = authorities.get(token);
      if (!auth || typeof loadContext !== 'function' || signal !== undefined && !(signal instanceof AbortSignal)) throw new AdapterFault('execution_authority_unavailable');
      if (fixture && binding.environment !== 'local') throw new AdapterFault('unsupported_selection');
      if (signal?.aborted) throw new AdapterFault('execution_authority_unavailable');
      let snapshot: FileHandle | undefined, bytes: Uint8Array | undefined, observed: CliObservation | undefined, claimed = false;
      try {
        snapshot = await pinNativeExecutable(artifact);
        // Controls are established before claiming or loading any private data.
        await inspect(snapshot);
        if (auth.spent.has(binding.dispatchId) || auth.spent.size >= 128) throw new AdapterFault('execution_authority_unavailable');
        auth.spent.add(binding.dispatchId); claimed = true; // An ambiguous claim is never retried, even before process spawn.
        const claim = claimSchema.parse(snapshotInput(await bounded(() => auth.claim(binding))));
        const issued = Date.parse(claim.issuedAt), startExpiry = Date.parse(claim.startExpiresAt), leaseExpiry = Date.parse(binding.leaseExpiresAt);
        const started = performance.now(), remainingStart = startExpiry - Date.now(), remainingLease = leaseExpiry - Date.now();
        if (issued > Date.now() || Date.now() < Date.parse(binding.activatedAt) || startExpiry <= issued
          || startExpiry - issued > NativeTextLimits.startMs || startExpiry > leaseExpiry || remainingStart <= 0 || remainingLease <= 0) throw new Error();
        const currentTime = (starting: boolean) => {
          if (signal?.aborted || Date.now() >= leaseExpiry || performance.now() - started >= remainingLease
            || starting && (Date.now() >= startExpiry || performance.now() - started >= remainingStart)) throw new Error();
        };
        currentTime(true); await bounded(() => auth.current(binding)); currentTime(true);
        const context = await bounded(loadContext);
        try { bytes = nativeContext(context, binding); } finally { context.fill(0); }
        currentTime(true);
        const args = await isolatedNativeArguments(grokTextArguments);
        await bounded(() => auth.current(binding)); currentTime(true);
        observed = await runPinnedNative(snapshot, args, { timeoutMs: Math.min(binding.wallTimeoutMs, Math.max(1, leaseExpiry - Date.now())),
          combinedBytes: NativeTextLimits.stdoutBytes + NativeTextLimits.stderrBytes,
          stdoutBytes: NativeTextLimits.stdoutBytes, stderrBytes: NativeTextLimits.stderrBytes, input: bytes, signal });
        currentTime(false);
        if (observed.exitCode !== 0 || observed.signal !== null || observed.stderr.byteLength) throw new Error();
        const text = decodeFixtureText(observed.stdout);
        await bounded(() => auth.current(binding)); currentTime(false);
        const output = new TextEncoder().encode(text);
        const receipt = freezeTree(NativeTextReceiptSchema.parse({ profile: 'freedom.native-text.receipt/v1', dispatchId: binding.dispatchId,
          attemptId: binding.attemptId, runId: binding.runId, bindingSha256: nativeDigest(JSON.stringify(binding)), contextSha256: binding.contextSha256,
          adapterProfile: binding.adapterProfile, executableSha256: artifact.sha256, requestedModelRef: binding.requestedModelRef,
          reportedModelRef: binding.expectedReportedModelRef, evidenceOrigin: 'synthetic_local_fixture', assurance: 'local_observed',
          capability: 'assisted_local', localDispatches: 1, providerCalls: 'unknown', usageStatus: 'unknown', costStatus: 'unknown',
          outcome: 'observed_success', outputSha256: nativeDigest(output), outputByteSize: output.byteLength, operational_authority: false }));
        output.fill(0);
        return Object.freeze({ receipt, text });
      } catch (error) {
        if (claimed) throw new AdapterFault('outcome_unknown');
        if (error instanceof AdapterFault) throw error;
        throw new AdapterFault('execution_authority_unavailable');
      } finally { bytes?.fill(0); observed?.stdout.fill(0); observed?.stderr.fill(0); await snapshot?.close(); }
    },
  });
}
/** Production profile deliberately stays unavailable until effective tools and
 * ordinary CLI custody are proven. No ambient auth/profile/network is mounted. */
export function createGrokNativeTextProcessAdapter(executable: string): NativeTextProcessAdapter {
  return create(nativeArtifactSnapshot({ executable, version: GROK_NATIVE_TEXT_PROFILE.version, sha256: GROK_NATIVE_TEXT_PROFILE.sha256 }), false);
}
/** Local test host only: caller is trusted test configuration, not HTTP data.
 * Always network-none/empty-home; output can only be synthetic_local_fixture. */
export function createSyntheticNativeTextProcessAdapter(artifact: CliArtifact): NativeTextProcessAdapter {
  return create(nativeArtifactSnapshot(artifact), true);
}
