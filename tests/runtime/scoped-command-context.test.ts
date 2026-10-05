import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { registerScopedCommand, authorizeScopedCommand, currentScopedCommand, forgetScopedCommand,
  bindScopedExecutionFact, type ScopedFactContext } from '../../packages/scoped-commands/command-context.js';
test('SCOPED-CONTEXT live registration is transaction/operation-specific and cannot be cloned or reused', () => {
  const context: ScopedFactContext = Object.freeze({ authn_kind: 'execution_token',
    subject_principal: { principal_id: randomUUID(), kind: 'person' as const }, scope: { scope_id: randomUUID(), kind: 'personal' as const } });
  const q = {} as PoolClient, other = {} as PoolClient;
  assert.throws(() => currentScopedCommand(q, context));
  registerScopedCommand(context, q, 'execution.model-step.begin');
  assert.throws(() => currentScopedCommand(q, context));
  assert.throws(() => registerScopedCommand(context, q, 'different.operation'));
  authorizeScopedCommand(context);
  assert.equal(currentScopedCommand(q, context).operation, 'execution.model-step.begin');
  assert.throws(() => currentScopedCommand(other, context));
  assert.throws(() => currentScopedCommand(q, { ...context }));
  bindScopedExecutionFact(q, context, { authorizationId: randomUUID(), attemptId: randomUUID(), grantId: randomUUID(),
    runtimeDeviceId: randomUUID(), connectionId: randomUUID() });
  assert(currentScopedCommand(q, context).execution);
  assert.throws(() => bindScopedExecutionFact(q, context, currentScopedCommand(q, context).execution!));
  forgetScopedCommand(context);
  assert.throws(() => currentScopedCommand(q, context));
  assert.throws(() => authorizeScopedCommand(context));
});
