import type { Pool, PoolClient } from 'pg';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';
import { resolvePrivateWorkPersistencePolicy } from '../../../modules/autopilot-work/policy.js';
import { createModelStepService } from '../../../modules/agent-execution/model-step-service.js';
import { createModelStepRunner } from '../../../modules/agent-execution/model-step-runner.js';
import { bindModelStepInvocationDeadline } from '../../../modules/agent-execution/model-step-invocation.js';
import { createPrivateModelResultService } from '../../../modules/agent-execution/model-results.js';
import { createByokModelStepHost, createLocalFixtureModelStepHost, createUnavailableModelStepHost, type RecoveryObservation } from '../../../modules/agent-execution/model-step-host.js';
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

/** Opaque capabilities live only for one dispatch. A different broker may
 * continue a reserved SQL step after fresh provider verification, never by
 * interpreting stored verification metadata as authority. */
export function createBrokerModelExecution(options: BrokerModelExecutionOptions) {
  const { cipherPool, executorPool, environment, clientId, vault, recover, store, authorizations,
    fixtureOrigin, maxBundles = 128 } = options;
  if (!cipherPool || !executorPool || cipherPool === executorPool || !vault || typeof recover !== 'function'
    || !store || !authorizations || !Number.isSafeInteger(maxBundles) || maxBundles < 1 || maxBundles > 128
    || fixtureOrigin !== undefined && environment !== 'local') unavailable();
  const credentials = createBrokerCredentialStore(cipherPool, { environment, clientId, vault, recover });
  // Bound concurrent work, not durable ownership. No request depends on a
  // previous isolate's maps; SQL CAS/receipts decide whether dispatch is fresh.
  let busy = 0;
  const metadata = createModelStepService(executorPool, { environment, clientId, host: createUnavailableModelStepHost() });
  return Object.freeze({
    async run(invocation: OpaqueModelBrokerInvocation, fresh: boolean): Promise<ModelStepMetadata> {
      const context = authorizations.read(invocation);
      const { actor, command, credentialPin } = context;
      // Every command captures its own immutable closure; concurrent commands
      // never change the authority of an already minted capability.
      const guard = bindModelStepInvocationDeadline((q: PoolClient) => authorizations.assertCurrent(q, invocation), context.expiresAt);
      if (!fresh) return command.operation === 'activate'
        ? metadata.readActivation(actor, command.input, guard)
        : metadata.read(actor, { stepId: command.input.stepId }, guard);
      if (busy >= maxBundles) unavailable();
      busy++;
      try {
        const resolveCredential = await credentials.createResolver(actor, credentialPin);
        const host = fixtureOrigin === undefined
          ? createByokModelStepHost({ recover, resolveCredential })
          : createLocalFixtureModelStepHost({ recover, resolveCredential, environment: 'local', origin: fixtureOrigin });
        const steps = createModelStepService(executorPool, { environment, clientId, host });
        if (command.operation === 'activate') return await steps.activate(actor, command.input, guard);
        const resultFinalizer = createPrivateModelResultService(executorPool, { steps, host, store, resolvePolicy: resolvePrivateWorkPersistencePolicy });
        const runner = createModelStepRunner({ service: steps, host, resultFinalizer });
        return (await runner.execute(actor, command.input, guard)).metadata;
      } finally { busy--; }
    },
  });
}
export type BrokerModelExecution = ReturnType<typeof createBrokerModelExecution>;
