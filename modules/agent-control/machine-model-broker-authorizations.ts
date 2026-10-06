import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { RuntimeEnvironmentSchema } from '../../contracts/execution/v1/runtime-registration.js';
import { BootstrapClientIdSchema } from '../../contracts/execution/v1/bootstrap.js';
import { CredentialRecoveryFloorSchema } from '../../contracts/execution/v2/model-credential.js';
import * as c from '../../contracts/execution/v3/machine-model-broker.js';
import { digest } from '../../packages/db/index.js';
import { runCommandCore } from '../../packages/db/command-core.js';
import { transaction } from '../../packages/db/transaction.js';
import { freezeTree, snapshotInput } from '../../packages/execution-state/decode.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import type { RecoveryObservation } from '../agent-execution/model-step-host.js';
import { type MachineModelSubject, type MachineTextAuthority } from './machine-text-authority.js';

declare const invocationBrand: unique symbol;
export interface OpaqueMachineBrokerInvocation { readonly [invocationBrand]: never }
export interface MachineBrokerBinding {
  readonly ownerUserId: string; readonly principalId: string; readonly scopeId: string;
  readonly runtimeDeviceId: string; readonly connectionId: string; readonly familyId: string;
  readonly authorizationId: string; readonly brokerAuthorizationId: string; readonly stepId: string;
  readonly attemptId: string; readonly runId: string; readonly grantId: string; readonly approvalId: string;
  readonly modelConnectionId: string; readonly modelVersion: string; readonly credentialId: string;
  readonly credentialGeneration: string; readonly recoveryGeneration: string; readonly environment: string; readonly clientId: string;
}
export interface MachineBrokerInvocationData {
  readonly command: c.MachineModelBrokerCommand; readonly binding: MachineBrokerBinding;
  readonly commandDigest: string; readonly recoveryGeneration: string; readonly expiresAt: string;
}
interface Row {
  authorization_id: string; machine_authorization_id: string; owner_user_id: string; owner_principal_id: string; scope_id: string;
  environment: string; client_id: string; runtime_device_id: string; connection_id: string; family_id: string;
  grant_id: string; approval_id: string; step_id: string; attempt_id: string; credential_id: string; credential_generation: string;
  model_connection_id: string; model_version: string; recovery_generation: string; command_key: string; command: c.MachineModelBrokerCommand;
  command_digest: string; proof_digest: string; access_token_digest: string; expected_version: string; nonce_hash: string;
  assertion: c.MachineModelBrokerAssertionPayload; issued_at: Date; expires_at: Date; consumed_at: Date | null;
}
interface Captured { identity: object; row: Row; data: MachineBrokerInvocationData }
const invocations = new WeakMap<object, Captured>();
const invalid = (): never => { requireCondition(false, 403, 'machine_broker_authorization_invalid', '機器模型授權無效。'); throw new Problem(403, 'machine_broker_authorization_invalid', '機器模型授權無效。'); };
const consumed = (): never => { requireCondition(false, 409, 'machine_broker_authorization_consumed', '機器模型授權已使用。'); throw new Problem(409, 'machine_broker_authorization_consumed', '機器模型授權已使用。'); };
const parse = <T>(schema: z.ZodType<T>, raw: unknown): T => freezeTree(schema.parse(snapshotInput(raw)));
const ordered = (value: unknown): unknown => !value || typeof value !== 'object' ? value : Array.isArray(value) ? value.map(ordered)
  : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered((value as Record<string, unknown>)[key])]));
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export const machineBrokerCommandDigest = (command: c.MachineModelBrokerCommand): string => createHash('sha256')
  .update(JSON.stringify(ordered(parse(c.MachineModelBrokerCommandSchema, command)))).digest('hex');
const Digest = z.string().regex(/^[0-9a-f]{64}$(?![\s\S])/);
const columns = `a.credential_generation::text,a.model_version::text,a.recovery_generation::text,a.expected_version::text`;

function bindingOf(row: Row): MachineBrokerBinding {
  return freezeTree({ ownerUserId: row.owner_user_id, principalId: row.owner_principal_id, scopeId: row.scope_id,
    runtimeDeviceId: row.runtime_device_id, connectionId: row.connection_id, familyId: row.family_id,
    authorizationId: row.machine_authorization_id, brokerAuthorizationId: row.authorization_id, stepId: row.step_id,
    attemptId: row.attempt_id, runId: '', grantId: row.grant_id, approvalId: row.approval_id,
    modelConnectionId: row.model_connection_id, modelVersion: row.model_version, credentialId: row.credential_id,
    credentialGeneration: row.credential_generation, recoveryGeneration: row.recovery_generation,
    environment: row.environment, clientId: row.client_id });
}

/** Main issues this row only after the caller's signed device admission.
 * The broker re-reads SQL itself. No session, token or proof bytes are stored. */
export function createMachineModelBrokerAuthorizations(pool: Pool, options: { environment: z.infer<typeof RuntimeEnvironmentSchema>;
  clientId: string; issuer: string; audience: string; recover: () => Promise<RecoveryObservation> }) {
  const descriptors = Object.getOwnPropertyDescriptors(options);
  requireCondition(Object.getPrototypeOf(options) === Object.prototype && Reflect.ownKeys(options).length === 5
    && ['environment', 'clientId', 'issuer', 'audience', 'recover'].every(key => descriptors[key]?.enumerable && 'value' in descriptors[key]),
  503, 'machine_broker_unavailable', '機器模型執行暫時無法使用。');
  const environment = RuntimeEnvironmentSchema.parse(descriptors.environment.value), clientId = BootstrapClientIdSchema.parse(descriptors.clientId.value);
  const issuer = descriptors.issuer.value as string, audience = descriptors.audience.value as string, recover = descriptors.recover.value as () => Promise<RecoveryObservation>;
  const identity = Object.freeze(Object.create(null));
  requireCondition(typeof recover === 'function' && [issuer, audience].every(value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$(?![\s\S])/.test(value)),
    503, 'machine_broker_unavailable', '機器模型執行暫時無法使用。');
  async function recovery(): Promise<RecoveryObservation> {
    const started = performance.now(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = parse(CredentialRecoveryFloorSchema, await Promise.race([Promise.resolve().then(recover), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('machine_broker_unavailable')), 3000);
      })]));
      if (performance.now() - started >= 3000 || Date.parse(result.expiresAt) <= Date.now()) invalid();
      return result;
    } catch (error) { if (error instanceof Problem) throw error; invalid(); throw new Error('machine_broker_authorization_invalid'); }
    finally { if (timer) clearTimeout(timer); }
  }
  async function currentRow(q: PoolClient, row: Row, r: RecoveryObservation): Promise<void> {
    try { await q.query('SELECT check_machine_model_admission(current_schema(),$1)', [row.machine_authorization_id]); }
    catch (error) { if ((error as { code?: string }).code === '23514') invalid(); throw error; }
    const live = (await q.query<Row & { run_id: string; lease_expires_at: Date; credential_expires_at: Date; now: Date }>(`SELECT b.authorization_id,b.machine_authorization_id,
      b.owner_user_id,b.owner_principal_id,b.scope_id,b.environment,b.client_id,b.runtime_device_id,b.connection_id,b.family_id,b.grant_id,b.approval_id,
      b.step_id,b.attempt_id,b.credential_id,b.credential_generation::text,b.model_connection_id,b.model_version::text,b.recovery_generation::text,
      b.command_key,b.command,b.command_digest,b.proof_digest,b.access_token_digest,b.expected_version::text,b.nonce_hash,b.assertion,b.issued_at,b.expires_at,b.consumed_at,
      a.run_id,s.lease_expires_at,c.expires_at credential_expires_at,clock_timestamp() now
      FROM execution_machine_broker_authorizations b
      JOIN execution_machine_authorizations a ON a.authorization_id=b.machine_authorization_id
      JOIN execution_machine_model_pins p ON p.authorization_id=a.authorization_id
      JOIN model_text_steps s ON s.step_id=b.step_id
      JOIN execution_grants g ON g.grant_id=b.grant_id AND g.state='active'
      JOIN broker_model_credentials c ON c.credential_id=b.credential_id AND c.generation=b.credential_generation AND c.state='active'
      WHERE b.authorization_id=$1 AND b.environment=$2 AND b.client_id=$3 AND b.recovery_generation=$4
        AND b.issued_at<=clock_timestamp() AND b.expires_at>clock_timestamp()
        AND p.credential_id=b.credential_id AND p.credential_generation=b.credential_generation
        AND a.step_id=b.step_id AND a.attempt_id=b.attempt_id AND a.grant_id=b.grant_id AND a.approval_id=b.approval_id
        AND a.runtime_device_id=b.runtime_device_id AND a.connection_id=b.connection_id AND a.family_id=b.family_id
        AND a.owner_user_id=b.owner_user_id AND a.owner_principal_id=b.owner_principal_id AND a.scope_id=b.scope_id
        AND a.recovery_generation=b.recovery_generation AND g.model_connection_id=b.model_connection_id AND g.model_version=b.model_version
        AND c.recovery_generation=b.recovery_generation AND c.expires_at>clock_timestamp()`,
    [row.authorization_id, environment, clientId, r.generation])).rows[0];
    if (!live || r.generation !== row.recovery_generation || live.command_digest !== row.command_digest || live.proof_digest !== row.proof_digest
      || live.access_token_digest !== row.access_token_digest || live.nonce_hash !== row.nonce_hash || live.step_id !== row.step_id
      || live.credential_id !== row.credential_id || live.grant_id !== row.grant_id || live.runtime_device_id !== row.runtime_device_id
      || Date.parse(r.expiresAt) <= live.now.getTime() || live.expires_at.getTime() <= Date.now() || live.lease_expires_at.getTime() <= Date.now()
      || live.credential_expires_at.getTime() <= Date.now()) invalid();
    (row as Row & { run_id?: string }).run_id = live.run_id;
  }
  async function assertCurrent(q: PoolClient, invocation: OpaqueMachineBrokerInvocation): Promise<void> {
    const captured = invocation && typeof invocation === 'object' ? invocations.get(invocation) : undefined;
    if (!captured || captured.identity !== identity) invalid();
    const r = await recovery(); await currentRow(q, captured!.row, r);
    const after = await recovery(); if (after.generation !== r.generation) invalid(); await currentRow(q, captured!.row, after);
  }
  function read(invocation: OpaqueMachineBrokerInvocation): MachineBrokerInvocationData {
    const captured = invocation && typeof invocation === 'object' ? invocations.get(invocation) : undefined;
    if (!captured || captured.identity !== identity) invalid(); return captured!.data;
  }
  async function issue(authority: MachineTextAuthority, subject: MachineModelSubject, digests: { proofDigest: string; accessTokenDigest: string },
    rawCommand: c.MachineModelBrokerCommand, nonce: string): Promise<c.MachineModelBrokerAssertionPayload> {
    const command = parse(c.MachineModelBrokerCommandSchema, rawCommand);
    const proofDigest = Digest.parse(digests.proofDigest), accessTokenDigest = Digest.parse(digests.accessTokenDigest);
    if (proofDigest === accessTokenDigest || !/^[A-Za-z0-9_-]{43}$(?![\s\S])/.test(nonce)) invalid();
    const described = authority.describe(subject);
    if (described.kind !== 'execute' || !described.binding || described.binding.stepId !== command.input.stepId) throw new Problem(403, 'machine_broker_authorization_invalid', '機器模型授權無效。');
    const binding = described.binding;
    const r = await recovery(); const commandDigest = machineBrokerCommandDigest(command);
    let ctx: Awaited<ReturnType<MachineTextAuthority['resume']>> | undefined, q0: PoolClient | undefined, assertion!: c.MachineModelBrokerAssertionPayload;
    const operation = 'execution.machine-broker.issue';
    try {
      return await runCommandCore(pool, {
        async authenticateAndLock(q) { q0 = q; ctx = await authority.resume(q, subject); await authority.current(q, subject); },
        async lockReceipt(q) { const scope = ctx!; await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['freedom.machine-model-broker/v1', scope.subject_principal.principal_id, 'execution_token', scope.scope.scope_id, operation, command.input.key])]); },
        requestDigest: () => digest({ profile: 'freedom.machine-model-broker/v1', commandDigest, proofDigest, accessTokenDigest, expectedVersion: command.input.expectedVersion, stepId: command.input.stepId }),
        async readReceipt(q) {
          await authority.current(q, subject); const scope = ctx!;
          const prior = (await q.query(`SELECT request_sha256,response FROM scoped_command_receipts WHERE principal_id=$1 AND authn_kind='execution_token' AND scope_id=$2 AND operation=$3 AND idempotency_key=$4`,
            [scope.subject_principal.principal_id, scope.scope.scope_id, operation, command.input.key])).rows[0];
          return prior ? { request_sha256: prior.request_sha256, response: parse(c.MachineModelBrokerAssertionPayloadSchema, prior.response) } : null;
        },
        async writeReceipt(q, requestHash, result) {
          const fact = authority.fact(q, ctx!); const scope = ctx!;
          await q.query(`INSERT INTO scoped_command_receipts(principal_id,authn_kind,scope_id,operation,idempotency_key,principal_kind,scope_kind,target_kind,target_id,request_sha256,response,
            execution_authorization_id,execution_attempt_id,execution_grant_id,execution_runtime_device_id,execution_connection_id)
            VALUES($1,'execution_token',$2,$3,$4,'person','personal','model_text_step',$5,$6,$7,$8,$9,$10,$11,$12)`,
          [scope.subject_principal.principal_id, scope.scope.scope_id, operation, command.input.key, command.input.stepId, requestHash, JSON.stringify(result),
            fact.authorizationId, fact.attemptId, fact.grantId, fact.runtimeDeviceId, fact.connectionId]);
          await authority.current(q, subject);
        },
      }, async q => { await authority.current(q, subject); }, async q => {
        const prior = (await q.query<Row>(`SELECT a.*,${columns} FROM execution_machine_broker_authorizations a WHERE a.step_id=$1`, [command.input.stepId])).rows[0];
        if (prior) {
          if (prior.command_key !== command.input.key) consumed();
          requireCondition(prior.command_digest === commandDigest && prior.proof_digest === proofDigest && prior.access_token_digest === accessTokenDigest,
            409, 'idempotency_conflict', '同一操作識別碼不可搭配不同內容。');
          assertion = parse(c.MachineModelBrokerAssertionPayloadSchema, prior.assertion); return assertion;
        }
        const nonceOwner = (await q.query('SELECT authorization_id FROM execution_machine_broker_authorizations WHERE nonce_hash=$1', [hash(nonce)])).rows[0];
        if (nonceOwner) invalid();
        const backing = (await q.query<{ credential_id: string; credential_generation: string; model_connection_id: string; model_version: string;
          recovery_generation: string; lease_expires_at: Date; grant_expires_at: Date; credential_expires_at: Date; connection_expires_at: Date;
          family_expires_at: Date; authorization_expires_at: Date; now: Date }>(`SELECT p.credential_id,p.credential_generation::text,g.model_connection_id,g.model_version::text,
          a.recovery_generation::text,s.lease_expires_at,g.expires_at grant_expires_at,c.expires_at credential_expires_at,ac.expires_at connection_expires_at,
          f.expires_at family_expires_at,a.expires_at authorization_expires_at,date_trunc('milliseconds',clock_timestamp()) now
          FROM execution_machine_authorizations a
          JOIN execution_machine_model_pins p ON p.authorization_id=a.authorization_id
          JOIN model_text_steps s ON s.step_id=a.step_id AND s.state='reserved' AND s.aggregate_version=$3
          JOIN execution_grants g ON g.grant_id=a.grant_id AND g.state='active'
          JOIN broker_model_credentials c ON c.credential_id=p.credential_id AND c.generation=p.credential_generation AND c.state='active'
            AND c.recovery_generation=a.recovery_generation AND c.model_connection_id=g.model_connection_id AND c.model_version=g.model_version
          JOIN agent_connections ac ON ac.connection_id=a.connection_id AND ac.state='active'
          JOIN bootstrap_refresh_families f ON f.family_id=a.family_id AND f.state='active'
          WHERE a.authorization_id=$1 AND a.step_id=$2 AND p.credential_id IS NOT NULL`,
        [binding.authorizationId, command.input.stepId, command.input.expectedVersion])).rows[0];
        if (!backing || backing.recovery_generation !== r.generation) invalid();
        const expires = new Date(Math.min(backing!.now.getTime() + c.MachineModelBrokerLimits.authorizationMs, Date.parse(r.expiresAt), backing!.lease_expires_at.getTime(),
          backing!.grant_expires_at.getTime(), backing!.credential_expires_at.getTime(), backing!.connection_expires_at.getTime(), backing!.family_expires_at.getTime(), backing!.authorization_expires_at.getTime()));
        if (expires <= backing!.now) invalid();
        assertion = parse(c.MachineModelBrokerAssertionPayloadSchema, { profile: 'machine-model-broker.assertion/v1', issuer, audience, operation: 'execute',
          purpose: 'machine-model-broker.execute', environment, clientId, authorizationRef: randomUUID(), nonce, commandDigest,
          recoveryGeneration: r.generation, issuedAt: backing!.now.toISOString(), expiresAt: expires.toISOString() });
        try {
          await q.query(`INSERT INTO execution_machine_broker_authorizations(authorization_id,machine_authorization_id,owner_user_id,owner_principal_id,scope_id,
            environment,client_id,runtime_device_id,connection_id,family_id,grant_id,approval_id,step_id,attempt_id,credential_id,credential_generation,
            model_connection_id,model_version,recovery_generation,command_key,command,command_digest,proof_digest,access_token_digest,expected_version,
            nonce_hash,assertion,issued_at,expires_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)`,
          [assertion.authorizationRef, binding.authorizationId, binding.ownerUserId, binding.principalId, binding.scopeId, environment, clientId, binding.runtimeDeviceId, binding.connectionId, binding.familyId,
            binding.grantId, binding.approvalId, binding.stepId, binding.attemptId, backing!.credential_id, backing!.credential_generation, backing!.model_connection_id, backing!.model_version,
            r.generation, command.input.key, JSON.stringify(command), commandDigest, proofDigest, accessTokenDigest, command.input.expectedVersion, hash(nonce),
            JSON.stringify(assertion), backing!.now, expires]);
        } catch (error) {
          const code = (error as { code?: string; constraint?: string }).code, constraint = (error as { constraint?: string }).constraint ?? '';
          if (code === '23505' && constraint.includes('nonce')) invalid();
          if (code === '23505') consumed();
          if (code === '23514') invalid();
          throw error;
        }
        await authority.current(q, subject); return assertion;
      });
    } finally { if (ctx && q0) authority.finish(q0, ctx); }
  }
  async function claim(raw: c.MachineModelBrokerAssertionPayload): Promise<Readonly<{ invocation: OpaqueMachineBrokerInvocation; fresh: boolean }>> {
    const payload = parse(c.MachineModelBrokerAssertionPayloadSchema, raw);
    if (payload.environment !== environment || payload.clientId !== clientId || payload.issuer !== issuer || payload.audience !== audience
      || payload.purpose !== 'machine-model-broker.execute' || Date.parse(payload.expiresAt) - Date.parse(payload.issuedAt) > c.MachineModelBrokerLimits.authorizationMs
      || Date.parse(payload.issuedAt) > Date.now() || Date.parse(payload.expiresAt) <= Date.now()) invalid();
    return transaction(pool, async q => {
      const row = (await q.query<Row>(`SELECT a.*,${columns} FROM execution_machine_broker_authorizations a WHERE a.authorization_id=$1 FOR UPDATE`, [payload.authorizationRef])).rows[0];
      if (!row || JSON.stringify(ordered(row.assertion)) !== JSON.stringify(ordered(payload)) || row.nonce_hash !== hash(payload.nonce)
        || machineBrokerCommandDigest(row.command) !== payload.commandDigest || row.command_digest !== payload.commandDigest) invalid();
      const found = (await q.query<{ run_id: string }>(`SELECT a.run_id FROM execution_machine_authorizations a WHERE a.authorization_id=$1`, [row!.machine_authorization_id])).rows[0];
      if (!found) invalid();
      const data = freezeTree({ command: parse(c.MachineModelBrokerCommandSchema, row!.command),
        binding: { ...bindingOf(row!), runId: found.run_id }, commandDigest: row!.command_digest, recoveryGeneration: row!.recovery_generation, expiresAt: row!.expires_at.toISOString() });
      const invocation = Object.freeze(Object.create(null)) as OpaqueMachineBrokerInvocation;
      invocations.set(invocation, { identity, row: row!, data });
      await assertCurrent(q, invocation);
      const fresh = !row!.consumed_at;
      if (fresh) await q.query(`UPDATE execution_machine_broker_authorizations SET consumed_at=date_trunc('milliseconds',clock_timestamp()) WHERE authorization_id=$1 AND consumed_at IS NULL`, [row!.authorization_id]);
      await assertCurrent(q, invocation);
      return Object.freeze({ invocation, fresh });
    });
  }
  return Object.freeze({ issue, claim, read, assertCurrent });
}
export type MachineModelBrokerAuthorizations = ReturnType<typeof createMachineModelBrokerAuthorizations>;
