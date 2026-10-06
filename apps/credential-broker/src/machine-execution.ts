import type { Pool, PoolClient } from 'pg';
import type { ObjectStore } from '../../../packages/asset-storage/index.js';
import { transaction } from '../../../packages/db/transaction.js';
import { createModelStepServiceWithAuthority } from '../../../modules/agent-execution/model-step-service.js';
import { createModelStepRunner } from '../../../modules/agent-execution/model-step-runner.js';
import { bindModelStepInvocationDeadline } from '../../../modules/agent-execution/model-step-invocation.js';
import { createPrivateModelResultServiceWithAuthority } from '../../../modules/agent-execution/model-results.js';
import { openSqlMachineModel } from '../../../modules/agent-execution/machine-model-step.js';
import { createByokModelStepHost, createLocalFixtureModelStepHost, createUnavailableModelStepHost, type RecoveryObservation } from '../../../modules/agent-execution/model-step-host.js';
import type { ModelStepMetadata } from '../../../contracts/execution/v2/model-step.js';
import type { RuntimeEnvironment } from '../../../contracts/execution/v1/runtime-registration.js';
import type { MachineModelBrokerAuthorizations, OpaqueMachineBrokerInvocation } from '../../../modules/agent-control/machine-model-broker-authorizations.js';
import { Problem } from '../../../packages/shared/problem.js';
import { createMachineCredentialResolver } from './store.js';
import type { CredentialVault } from './vault.js';

export interface MachineBrokerModelExecutionOptions {
  cipherPool: Pool; executorPool: Pool; environment: RuntimeEnvironment; clientId: string;
  vault: CredentialVault; recover: () => Promise<RecoveryObservation>; store: ObjectStore;
  authorizations: MachineModelBrokerAuthorizations; fixtureOrigin?: string; maxBundles?: number;
}
function unavailable(): never { throw new Problem(503, 'machine_broker_unavailable', '機器模型執行暫時無法使用。'); }

/** One claimed machine authorization, one provider dispatch. Scope is rebuilt
 * from the SQL pins. A consumed authorization returns metadata and does not send. */
export function createMachineBrokerModelExecution(options: MachineBrokerModelExecutionOptions) {
  const { cipherPool, executorPool, environment, clientId, vault, recover, store, authorizations, fixtureOrigin, maxBundles = 128 } = options;
  if (!cipherPool || !executorPool || cipherPool === executorPool || !vault || typeof recover !== 'function' || !store || !authorizations
    || !Number.isSafeInteger(maxBundles) || maxBundles < 1 || maxBundles > 128 || fixtureOrigin !== undefined && environment !== 'local') unavailable();
  let busy = 0;
  return Object.freeze({
    async run(invocation: OpaqueMachineBrokerInvocation, fresh: boolean): Promise<ModelStepMetadata> {
      const context = authorizations.read(invocation), binding = context.binding;
      const opened = () => openSqlMachineModel({ environment, clientId, binding, assertCurrent: (q: PoolClient) => authorizations.assertCurrent(q, invocation) });
      const guard = bindModelStepInvocationDeadline((q: PoolClient) => authorizations.assertCurrent(q, invocation), context.expiresAt);
      if (!fresh) {
        const sql = opened(), steps = createModelStepServiceWithAuthority(executorPool, { environment, clientId, host: createUnavailableModelStepHost() }, sql.ports);
        return steps.read(sql.subject, { stepId: binding.stepId }, guard);
      }
      if (busy >= maxBundles) unavailable();
      busy++;
      try {
        const assertMachine = async () => {
          await transaction(executorPool, async q => {
            const state = (await q.query<{ state: string }>('SELECT state FROM model_text_steps WHERE step_id=$1', [binding.stepId])).rows[0]?.state;
            // After begin commits, this is the pre-send fence a concurrent revoke can wait behind.
            if (state === 'dispatched') await q.query('SELECT authorization_id FROM execution_machine_broker_authorizations WHERE authorization_id=$1 FOR UPDATE', [binding.brokerAuthorizationId]);
            await authorizations.assertCurrent(q, invocation);
          });
        };
        const resolveCredential = await createMachineCredentialResolver(cipherPool, { environment, clientId, vault, recover, assertMachine, pin: {
          credentialId: binding.credentialId, expectedGeneration: binding.credentialGeneration, ownerUserId: binding.ownerUserId,
          ownerPrincipalId: binding.principalId, scopeId: binding.scopeId, runtimeDeviceId: binding.runtimeDeviceId, connectionId: binding.connectionId,
          familyId: binding.familyId, modelConnectionId: binding.modelConnectionId, modelVersion: binding.modelVersion,
          recoveryGeneration: binding.recoveryGeneration, environment, clientId } });
        const host = fixtureOrigin === undefined
          ? createByokModelStepHost({ recover, resolveCredential })
          : createLocalFixtureModelStepHost({ recover, resolveCredential, environment: 'local', origin: fixtureOrigin });
        const sql = opened(), steps = createModelStepServiceWithAuthority(executorPool, { environment, clientId, host }, sql.ports);
        const resultFinalizer = createPrivateModelResultServiceWithAuthority(executorPool, { steps, host, store, resolvePolicy: sql.ports.persistencePolicy }, sql.ports);
        const runner = createModelStepRunner({ service: steps, host, resultFinalizer });
        return (await runner.execute(sql.subject, context.command.input, guard)).metadata;
      } finally { busy--; }
    },
  });
}
export type MachineBrokerModelExecution = ReturnType<typeof createMachineBrokerModelExecution>;
