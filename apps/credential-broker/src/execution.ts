import type { Pool, PoolClient } from 'pg';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';
import { resolvePrivateWorkPersistencePolicy } from '../../../modules/autopilot-work/policy.js';
import { createModelStepService } from '../../../modules/agent-execution/model-step-service.js';
import { createModelStepRunner } from '../../../modules/agent-execution/model-step-runner.js';
import { bindModelStepInvocationDeadline } from '../../../modules/agent-execution/model-step-invocation.js';
import { createPrivateModelResultService } from '../../../modules/agent-execution/model-results.js';
import { createByokModelStepHost, createLocalFixtureModelStepHost, type RecoveryObservation } from '../../../modules/agent-execution/model-step-host.js';
import type { ModelStepMetadata } from '../../../contracts/execution/v2/model-step.js';
import type { RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import type { createModelBrokerAuthorizations, OpaqueModelBrokerInvocation } from '../../../modules/agent-control/model-broker-authorizations.js';
import { Problem } from '../../../packages/shared/problem.js';
import { createBrokerCredentialStore } from './store.js';
import type { CredentialVault } from './vault.js';

type Authorizations = ReturnType<typeof createModelBrokerAuthorizations>;
export interface BrokerModelExecutionOptions {
  cipherPool: Pool; executorPool: Pool; environment: RuntimeEnvironment; clientId: string;
  vault: CredentialVault; recover: () => Promise<RecoveryObservation>; store: ObjectStore;
  authorizations: Authorizations;
  /** Explicit synthetic local protocol only. Never read from an RPC command. */
  fixtureOrigin?: string;
  maxBundles?: number;
}
function unavailable(): never { throw new Problem(503, 'model_broker_registry_unavailable', 'Broker execution is unavailable.'); }

/** The original host proof, capability, observation, Result finalizer and all
 * provider/context/ObjectStore I/O live together in this broker process. SQL
 * records cannot recreate a missing proof after restart or on another replica. */
export function createBrokerModelExecution(options: BrokerModelExecutionOptions) {
  const { cipherPool, executorPool, environment, clientId, vault, recover, store, authorizations,
    fixtureOrigin, maxBundles = 128 } = options;
  if (!cipherPool || !executorPool || cipherPool === executorPool || !vault || typeof recover !== 'function'
    || !store || !authorizations || !Number.isSafeInteger(maxBundles) || maxBundles < 1 || maxBundles > 128
    || fixtureOrigin !== undefined && environment !== 'local') unavailable();
  const credentials = createBrokerCredentialStore(cipherPool, { environment, clientId, vault, recover });
  type Bundle = { steps: ReturnType<typeof createModelStepService>;
    runner: ReturnType<typeof createModelStepRunner>; expires: number; stepsOwned: Set<string>; busy: number };
  const bundles = new Map<string, Bundle>(), stepBundles = new Map<string, string>();
  let pendingActivations = 0;
  // Activation ACK replay is metadata only, never another call to activate.
  const activations = new Map<string, { key: string; stepId: string }>();
  function remove(key: string, bundle: Bundle) {
    bundles.delete(key);
    for (const stepId of bundle.stepsOwned) stepBundles.delete(stepId);
    for (const [authorizationRef, entry] of activations) if (entry.key === key) activations.delete(authorizationRef);
  }
  function prune() {
    for (const [key, bundle] of bundles) if (!bundle.busy && bundle.expires <= Date.now()) remove(key, bundle);
  }
  return Object.freeze({
    async run(invocation: OpaqueModelBrokerInvocation, fresh: boolean): Promise<ModelStepMetadata> {
      const context = authorizations.read(invocation);
      const { actor, command, credentialPin } = context;
      // Every command captures its own immutable closure; concurrent commands
      // never change the authority of an already minted capability.
      const guard = bindModelStepInvocationDeadline((q: PoolClient) => authorizations.assertCurrent(q, invocation), context.expiresAt);
      const key = JSON.stringify([context.sessionIdentity, environment, clientId, context.modelConnectionId,
        context.modelVersion, credentialPin.credentialId, credentialPin.expectedGeneration]);
      prune();
      let bundle = bundles.get(key);
      if (command.operation === 'execute') {
        if (!bundle || stepBundles.get(command.input.stepId) !== key || !bundle.stepsOwned.has(command.input.stepId)) unavailable();
      } else if (!fresh) {
        const previous = activations.get(context.authorizationRef);
        if (!bundle || !previous || previous.key !== key || !bundle.stepsOwned.has(previous.stepId)) unavailable();
        return bundle.steps.read(actor, { stepId: previous.stepId }, guard);
      } else if (!bundle) {
        if (bundles.size >= maxBundles) unavailable();
        const resolveCredential = await credentials.createResolver(actor, credentialPin);
        const host = fixtureOrigin === undefined
          ? createByokModelStepHost({ recover, resolveCredential })
          : createLocalFixtureModelStepHost({ recover, resolveCredential, environment: 'local', origin: fixtureOrigin });
        const steps = createModelStepService(executorPool, { environment, clientId, host });
        const resultFinalizer = createPrivateModelResultService(executorPool, { steps, host, store, resolvePolicy: resolvePrivateWorkPersistencePolicy });
        const runner = createModelStepRunner({ service: steps, host, resultFinalizer });
        bundle = { steps, runner, expires: Math.min(Date.now() + 90_000, Date.parse(context.credentialExpiresAt), Date.parse(context.sessionExpiresAt)), stepsOwned: new Set(), busy: 0 };
        if (!Number.isFinite(bundle.expires) || bundle.expires <= Date.now()) unavailable();
        // A competing activation can finish resolver creation while we await.
        const existing = bundles.get(key);
        if (existing) bundle = existing;
        else { if (bundles.size >= maxBundles) unavailable(); bundles.set(key, bundle); }
      }
      if (!bundle || bundle.expires <= Date.now()) unavailable();
      bundle.busy++;
      try {
        if (command.operation === 'activate') {
          // Reserve memory capacity before activation effects; concurrent
          // activations cannot all pass a check against the same old size.
          if (stepBundles.size + pendingActivations >= 128 || activations.size + pendingActivations >= 128) unavailable();
          pendingActivations++;
          try {
            const metadata = await bundle.steps.activate(actor, command.input, guard);
            bundle.stepsOwned.add(metadata.stepId); stepBundles.set(metadata.stepId, key);
            activations.set(context.authorizationRef, { key, stepId: metadata.stepId });
            bundle.expires = Math.min(bundle.expires, Date.parse(metadata.expiresAt));
            return metadata;
          } finally { pendingActivations--; }
        }
        if (!fresh) return bundle.steps.read(actor, { stepId: command.input.stepId }, guard);
        return (await bundle.runner.execute(actor, command.input, guard)).metadata;
      } finally { bundle.busy--; }
    },
  });
}
export type BrokerModelExecution = ReturnType<typeof createBrokerModelExecution>;
