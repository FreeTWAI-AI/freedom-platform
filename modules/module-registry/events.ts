import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { scopedJournal } from '../../packages/scoped-commands/index.js';
import type { TenantScopeContext } from '../../packages/resource-scopes/index.js';

/** Journal while a member command is active. The operation string must be that command. */
export async function journalCommand(q: PoolClient, context: TenantScopeContext, input: {
  aggregateType: string;
  id: string;
  version: string;
  operation: string;
  eventType?: string;
  data: Record<string, unknown>;
}) {
  await scopedJournal(q, context, {
    aggregate_type: input.aggregateType,
    id: input.id,
    version: input.version,
    operation: input.operation,
    eventType: input.eventType,
    data: input.data,
  });
}

/**
 * The step executor has no member session, so it cannot open a scoped command.
 * The row shape matches scopedJournal for the original actor and the tenant scope.
 */
export async function journalExecutor(q: PoolClient, tenantId: string, principalId: string, input: {
  aggregateType: string;
  id: string;
  version: string;
  eventType: string;
  data: Record<string, unknown>;
}) {
  const scope = (await q.query<{ scope_id: string }>(
    `SELECT scope_id FROM resource_scopes WHERE tenant_ref=$1 AND kind='tenant'`,
    [tenantId],
  )).rows[0];
  if (!scope) return;
  const transition = randomUUID();
  await q.query(
    `INSERT INTO scoped_transition_journal(transition_id,scope_id,scope_kind,principal_id,principal_kind,
       authn_kind,aggregate_type,aggregate_id,aggregate_version,operation,data)
     VALUES($1,$2,'tenant',$3,'person','member_session',$4,$5,$6,'application.launch',$7::jsonb)`,
    [transition, scope.scope_id, principalId, input.aggregateType, input.id, input.version, JSON.stringify(input.data)],
  );
  const payload = {
    subject_principal: { principal_id: principalId, kind: 'person' },
    authn_kind: 'member_session',
    scope: { scope_id: scope.scope_id, kind: 'tenant' },
    aggregate_type: input.aggregateType,
    aggregate_id: input.id,
    aggregate_version: input.version,
    data: input.data,
  };
  await q.query(
    `INSERT INTO scoped_outbox(event_id,transition_id,scope_id,scope_kind,event_type,payload)
     VALUES($1,$2,$3,'tenant',$4,$5::jsonb)`,
    [randomUUID(), transition, scope.scope_id, input.eventType, JSON.stringify(payload)],
  );
}
