import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import type { Actor } from '../identity-membership/service.js';
import { OpaqueId } from '../../contracts/common/v1/identity.js';
import { ExecutionVersion, RunState } from '../../contracts/execution/v1/state.js';
import { withMemberScope, type MemberScopeContext } from '../../packages/resource-scopes/index.js';
import { scopedMemberCommand, scopedJournal } from '../../packages/scoped-commands/index.js';
import { assertCurrentSessionClock } from '../../packages/db/member-session.js';
import { checkVersion } from '../../packages/db/index.js';
import { requireCondition } from '../../packages/shared/problem.js';
import { resolvePrivateWorkPersistencePolicy } from '../autopilot-work/policy.js';

const maximum = 9223372036854775807n;
const version = ExecutionVersion.refine(value => BigInt(value) <= maximum);
const key = z.string().min(8).max(128).regex(/^[A-Za-z0-9_-]+$(?![\s\S])/);
const createSchema = z.object({ key, workId: OpaqueId, expectedWorkVersion: version.optional() }).strict();
const controlSchema = z.object({ key, runId: OpaqueId, expectedVersion: version.optional() }).strict();
const readSchema = z.object({ runId: OpaqueId }).strict();
const closedState = RunState.extract(['created', 'paused', 'cancelled']);
export interface CreateExecutionRunInput { key: string; workId: string; expectedWorkVersion: string }
export interface ControlExecutionRunInput { key: string; runId: string; expectedVersion: string }
export interface ReadExecutionRunInput { runId: string }
export interface ExecutionRunMetadata {
  readonly runId: string; readonly workId: string; readonly inputWorkVersion: string;
  readonly aggregateVersion: string; readonly state: z.infer<typeof closedState>;
  readonly taskLeaseEpoch: string; readonly controlEpoch: string;
  readonly operational_authority: false;
}
interface Work { work_item_id: string; aggregate_version: string; state: string }
interface Run {
  run_id: string; work_item_id: string; input_work_version: string; aggregate_version: string;
  state: z.infer<typeof closedState>; task_lease_epoch: string; control_epoch: string;
}
const columns = 'run_id,work_item_id,input_work_version::text,aggregate_version::text,state,task_lease_epoch::text,control_epoch::text';
const metadata = (row: Run): ExecutionRunMetadata => Object.freeze({ runId: row.run_id, workId: row.work_item_id,
  inputWorkVersion: row.input_work_version, aggregateVersion: row.aggregate_version, state: closedState.parse(row.state),
  taskLeaseEpoch: row.task_lease_epoch, controlEpoch: row.control_epoch, operational_authority: false });

/** Server-only member records. NOT execution authentication/preflight. There is
 * no Grant/Attempt/dispatch, provider, machine identity or HTTP registration. */
export function createExecutionRuns(pool: Pool) {
  async function eligible(q: PoolClient, actor: Actor) {
    const row = await q.query('SELECT user_id FROM users WHERE user_id=$1 AND (NOT onboarding_required OR onboarding_completed_at IS NOT NULL)', [actor.user_id]);
    requireCondition(row.rowCount === 1, 403, 'onboarding_required', '請先完成加入。');
  }
  async function lockWork(q: PoolClient, context: MemberScopeContext, actor: Actor, workId: string): Promise<Work> {
    const row = (await q.query<Work>(`SELECT work_item_id,aggregate_version::text,state FROM work_items
      WHERE work_item_id=$1 AND work_mode='personal_execution' AND owner_ref=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR UPDATE`,
    [workId, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這項執行紀錄。');
    return row;
  }
  async function lockRun(q: PoolClient, context: MemberScopeContext, actor: Actor, runId: string): Promise<Run> {
    // Identity is immutable. This first bounded lookup resolves lock order only;
    // no private metadata escapes before Work and Run have both been locked.
    const identity = (await q.query<{ work_item_id: string }>(`SELECT work_item_id FROM execution_runs
      WHERE run_id=$1 AND owner_user_id=$2 AND owner_principal_id=$3 AND scope_id=$4`,
    [runId, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    requireCondition(identity, 404, 'not_found', '找不到這項執行紀錄。');
    await lockWork(q, context, actor, identity.work_item_id);
    const row = (await q.query<Run>(`SELECT ${columns} FROM execution_runs
      WHERE run_id=$1 AND owner_user_id=$2 AND owner_principal_id=$3 AND scope_id=$4 FOR UPDATE`,
    [runId, actor.user_id, context.subject_principal.principal_id, context.scope.scope_id])).rows[0];
    requireCondition(row, 404, 'not_found', '找不到這項執行紀錄。');
    return row;
  }
  async function record(q: PoolClient, context: MemberScopeContext, operation: string, row: Run) {
    await scopedJournal(q, context, { aggregate_type: 'execution_run', id: row.run_id,
      version: row.aggregate_version, operation, data: { workId: row.work_item_id, state: row.state,
        taskLeaseEpoch: row.task_lease_epoch, controlEpoch: row.control_epoch, operational_authority: false },
      eventType: 'freedom.execution.run.recorded.v1' });
    return metadata(row);
  }
  async function create(actor: Actor, raw: CreateExecutionRunInput): Promise<ExecutionRunMetadata> {
    actor = Object.freeze({ ...actor });
    const input = Object.freeze(createSchema.parse(raw)), operation = 'execution.run.create';
    let work!: Work, policyRevision!: string;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'private_work', id: input.workId }, expected: input.expectedWorkVersion, body: {} },
    async (q, context) => {
      await eligible(q, actor);
      work = await lockWork(q, context, actor, input.workId);
      requireCondition(work.state === 'draft', 409, 'private_work_archived', '這個工作已封存。');
      policyRevision = (await resolvePrivateWorkPersistencePolicy(q, context)).revision;
    }, async (q, context) => {
      checkVersion(work.aggregate_version, input.expectedWorkVersion);
      await assertCurrentSessionClock(q, actor);
      const row = (await q.query<Run>(`INSERT INTO execution_runs(run_id,work_item_id,scope_id,owner_principal_id,owner_user_id,input_work_version,persistence_policy_revision)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING ${columns}`,
      [randomUUID(), input.workId, context.scope.scope_id, context.subject_principal.principal_id, actor.user_id, input.expectedWorkVersion, policyRevision])).rows[0];
      return record(q, context, operation, row);
    });
  }
  async function control(actor: Actor, raw: ControlExecutionRunInput, action: 'pause' | 'stop'): Promise<ExecutionRunMetadata> {
    actor = Object.freeze({ ...actor });
    const input = Object.freeze(controlSchema.parse(raw)), operation = `execution.run.${action}`;
    let current!: Run;
    return scopedMemberCommand(pool, { actor, scope: 'personal', operation, key: input.key,
      target: { kind: 'execution_run', id: input.runId }, expected: input.expectedVersion, body: {} },
    async (q, context) => {
      await eligible(q, actor); current = await lockRun(q, context, actor, input.runId);
      // Deliberately no persistence/model policy or Work draft requirement:
      // stopping stored unexecuted records remains possible after withdrawal.
    }, async (q, context) => {
      checkVersion(current.aggregate_version, input.expectedVersion);
      requireCondition(current.state !== 'cancelled', 409, 'execution_run_terminal', '這項執行紀錄已取消。');
      requireCondition([current.aggregate_version, current.task_lease_epoch, current.control_epoch].every(value => BigInt(value) < maximum),
        409, 'execution_run_version_exhausted', '這項執行紀錄無法再更新。');
      await assertCurrentSessionClock(q, actor);
      const row = (await q.query<Run>(`UPDATE execution_runs SET state=$2,aggregate_version=aggregate_version+1,
        task_lease_epoch=task_lease_epoch+1,control_epoch=control_epoch+1 WHERE run_id=$1 AND aggregate_version=$3 RETURNING ${columns}`,
      [input.runId, action === 'pause' ? 'paused' : 'cancelled', input.expectedVersion])).rows[0];
      requireCondition(row, 412, 'version_conflict', '資料已更新，請重新整理後再操作。');
      return record(q, context, operation, row);
    });
  }
  async function read(actor: Actor, raw: ReadExecutionRunInput): Promise<ExecutionRunMetadata> {
    actor = Object.freeze({ ...actor });
    const input = Object.freeze(readSchema.parse(raw));
    return withMemberScope(pool, { actor, scope: 'personal' }, async q => { await eligible(q, actor); }, async (q, context) => {
      const row = await lockRun(q, context, actor, input.runId);
      await assertCurrentSessionClock(q, actor);
      return metadata(row);
    });
  }
  return Object.freeze({ create, read,
    pause: (actor: Actor, input: ControlExecutionRunInput) => control(actor, input, 'pause'),
    stop: (actor: Actor, input: ControlExecutionRunInput) => control(actor, input, 'stop') });
}
