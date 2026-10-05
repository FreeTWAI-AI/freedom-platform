import { captureModelStepInvocation, type ModelStepInvocationGuard } from './model-step-invocation.js';
import type { Actor } from '../identity-membership/service.js';
import { BeginSchema, ModelStepMetadataSchema, type ModelStepBeginInput, type ModelStepMetadata } from '../../contracts/execution/v2/model-step.js';
import { snapshotInput, freezeTree } from '../../packages/execution-state/decode.js';
import { AdapterFault } from './adapters/common.js';
import { readModelStepCapability, type ModelStepHost, type OpaqueModelStepCapability, type OpaqueModelObservation } from './model-step-host.js';

export interface ModelStepRunnerService<A=Actor> {
  begin(actor: A, input: ModelStepBeginInput, guard?: ModelStepInvocationGuard): Promise<{ metadata: ModelStepMetadata; capability: OpaqueModelStepCapability | null }>;
  context(actor: A, capability: OpaqueModelStepCapability, guard?: ModelStepInvocationGuard): Promise<Uint8Array>;
  record(actor: A, capability: OpaqueModelStepCapability, observation: OpaqueModelObservation, guard?: ModelStepInvocationGuard): Promise<ModelStepMetadata>;
  unknown(actor: A, capability: OpaqueModelStepCapability): Promise<ModelStepMetadata>;
  read(actor: A, input: { stepId: string }, guard?: ModelStepInvocationGuard): Promise<ModelStepMetadata>;
}
export interface ModelStepResultFinalizer<Result,A=Actor> {
  finalize(actor: A, input: { key: string; stepId: string; expectedVersion: string }, observation: OpaqueModelObservation, guard?: ModelStepInvocationGuard): Promise<Result>;
}
/** One committed claim, one transport call, one typed private Result. The
 * transactional service owns every current-authority and durable journal check.
 * This orchestration never promotes a prepared codec or retries provider I/O. */
export function createModelStepRunner<Result,A=Actor>(options: {
  service: ModelStepRunnerService<A>; host: ModelStepHost; resultFinalizer: ModelStepResultFinalizer<Result,A>;
}) {
  const descriptor = Object.getOwnPropertyDescriptors(options);
  if (Object.getPrototypeOf(options) !== Object.prototype || Reflect.ownKeys(options).length !== 3
    || ['service', 'host', 'resultFinalizer'].some(key => !descriptor[key]?.enumerable || !('value' in descriptor[key]))) throw new AdapterFault('invalid_input');
  const service = descriptor.service.value as ModelStepRunnerService<A>;
  const host = descriptor.host.value as ModelStepHost;
  const finalizer = descriptor.resultFinalizer.value as ModelStepResultFinalizer<Result,A>;
  function method<T extends object, K extends keyof T>(port: T, name: K): T[K] {
    if (!port || typeof port !== 'object') throw new AdapterFault('invalid_input');
    const d = Object.getOwnPropertyDescriptor(port, name);
    if (!d || !('value' in d) || typeof d.value !== 'function') throw new AdapterFault('invalid_input');
    return d.value.bind(port);
  }
  const begin = method(service, 'begin'), context = method(service, 'context'), record = method(service, 'record'),
    unknown = method(service, 'unknown'), read = method(service, 'read'), dispatch = method(host, 'dispatch'), finalize = method(finalizer, 'finalize');
  return Object.freeze({
    async execute(actor: A, raw: ModelStepBeginInput, invocation?: ModelStepInvocationGuard): Promise<{ metadata: ModelStepMetadata; result: Result | null }> {
      const guard = captureModelStepInvocation(invocation);
      const input = freezeTree(BeginSchema.parse(snapshotInput(raw)));
      const begun = await begin(actor, input, guard);
      const metadata = freezeTree(ModelStepMetadataSchema.parse(snapshotInput(begun.metadata)));
      if (begun.capability === null) return Object.freeze({ metadata, result: null });
      const capability = begun.capability;
      const cap = readModelStepCapability(capability);
      if (cap.binding.stepId !== input.stepId || cap.binding.stepId !== metadata.stepId || cap.consumed) throw new AdapterFault('execution_authority_unavailable');
      let bytes: Uint8Array | undefined;
      try {
        bytes = await context(actor, capability, guard);
        const observation = await dispatch(capability, bytes);
        const recorded = await record(actor, capability, observation, guard);
        const result = await finalize(actor, { key: cap.binding.intentId, stepId: input.stepId, expectedVersion: recorded.aggregateVersion }, observation, guard);
        const latest = await read(actor, { stepId: input.stepId }, guard);
        return Object.freeze({ metadata: freezeTree(ModelStepMetadataSchema.parse(snapshotInput(latest))), result });
      } catch {
        // Committed dispatch claims remain spent even when execution never
        // reaches the provider or a response/commit ACK is lost. No retry.
        try { await unknown(actor, capability); } catch { /* Current auth may be gone; no private status is returned. */ }
        throw new AdapterFault('outcome_unknown');
      } finally { bytes?.fill(0); }
    },
  });
}
