# Platform hold operator runbook

In this release, a suspended instance is a member suspension only when its
`suspension_operation_id` points to that tenant's and instance's own
`module.instance.suspend` operation and its current deployment is `suspended`.
Every other suspended instance is a platform hold. Owner and admin resume return
409 `instance_security_hold`; owner archive returns the same error (admins do
not have archive capability). New Work and Result writes and manual-work enable
return 409 `work_instance_unavailable`. Reads remain available, and instance
detail reports `suspension: { kind: 'platform', operation_id: null,
suspended_at: null, reason: null }`. No HTTP route places or releases a hold.

An operator with direct database access may use this runbook for an approved
incident. Production writes require the platform owner's explicit approval.
Connect with psql using only this environment's migrator role, which owns the
tables; do not use `postgres` or any other superuser. Every block binds
`freedom.tenant_id` for its own transaction. The migrator is not subject to row
security because it owns the tables and row security is not forced. Select the
reviewed database and schema explicitly when connecting. Set `expected_database`
from the approved environment configuration, independently of the connection
string, as in the [capacity policy operator](../../docs/development/tenant-capacity-policy.md).

## Setup and transaction handling

Replace these synthetic values with the approved incident's target. The last
variable is needed only for release-member, copied from the recorded hold row.
These psql setup commands are separate from the tested SQL blocks.

```psql
\set ON_ERROR_STOP on
\set expected_database fp_incident_example
\set tenant_id 11111111-1111-4111-8111-111111111111
\set instance_id 22222222-2222-4222-8222-222222222222
\set suspension_operation_id 33333333-3333-4333-8333-333333333333
```

Run read first. Each action block below opens a transaction and leaves it open.
If its last statement returned exactly one row, run `COMMIT;`. Otherwise run
`ROLLBACK;`: nothing has changed, and run read to see why. On any SQL error,
including a lock timeout, run `ROLLBACK;` before reading or retrying. Finish
promptly so the open transaction does not keep other writers waiting.
Read closes its own read-only transaction with `ROLLBACK;`.

Record the time, operator, approval, reason, and full output row of every hold
and release in the incident record. In particular, retain `previous_status` and
`previous_suspension_operation_id` from hold: active requires release-active;
member-suspended requires release-member with that exact pointer. Never use
release-active to override a member's suspension. If the recorded row or current
history disagrees, roll back and investigate rather than editing the predicates.

The actions lock the instance `FOR NO KEY UPDATE`, then its current deployment
`FOR NO KEY UPDATE`, in separate statements, as lifecycle does. Work takes
`FOR SHARE` in the same order. After the locks, each action uses one
data-modifying statement; deployment changes depend on the instance update's
`RETURNING` rows. The transaction commits both changes together or rolls back
both. A member-suspended deployment is already suspended and hold leaves its
version unchanged.

## Read the current state

The row includes the latest lifecycle operation ordered by `accepted_at`, then
`operation_id`, and the same unfinished-launch predicate as lifecycle. A missing
row means this tenant/instance pair is absent or invisible to the connected role.
The `database` column helps diagnose an incorrect connection.

<!-- platform-hold:read -->
```sql
BEGIN READ ONLY;
SELECT set_config('freedom.tenant_id', :'tenant_id', true);
SELECT current_database() AS database, i.tenant_id, i.instance_id,
       i.status, i.version AS instance_version, i.suspension_operation_id,
       d.state AS deployment_state, d.version AS deployment_version,
       CASE
         WHEN i.status = 'active' THEN 'active'
         WHEN i.status = 'suspended' AND d.state = 'suspended' AND EXISTS (
           SELECT 1 FROM module_provision_operations o
           WHERE o.tenant_id = i.tenant_id
             AND o.instance_id = i.instance_id
             AND o.operation_id = i.suspension_operation_id
             AND o.operation_kind = 'module.instance.suspend'
         ) THEN 'member_suspension'
         WHEN i.status = 'suspended' THEN 'platform_hold'
         ELSE i.status
       END AS classification,
       latest.operation_kind AS latest_lifecycle_kind,
       latest.operation_id AS latest_lifecycle_operation_id,
       latest.accepted_at AS latest_lifecycle_at,
       EXISTS (
           SELECT 1 FROM module_provision_operations o
           WHERE o.tenant_id = i.tenant_id
             AND o.operation_kind = 'application.launch'
             AND o.state IN ('requested', 'running', 'needs_reconciliation')
             AND (
               EXISTS (SELECT 1 FROM module_provision_steps s
                       WHERE s.tenant_id = o.tenant_id
                         AND s.operation_id = o.operation_id
                         AND s.instance_id = i.instance_id)
               OR EXISTS (SELECT 1 FROM application_module_links l
                          WHERE l.tenant_id = o.tenant_id
                            AND l.installation_id = o.installation_id
                            AND l.instance_id = i.instance_id)
             )
         ) AS unfinished_launch
FROM module_instances i
LEFT JOIN deployment_bindings d
  ON d.tenant_id = i.tenant_id
 AND d.instance_id = i.instance_id
 AND d.binding_id = i.binding_id
LEFT JOIN LATERAL (
  SELECT o.operation_kind, o.operation_id, o.accepted_at
  FROM module_provision_operations o
  WHERE o.tenant_id = i.tenant_id
    AND o.instance_id = i.instance_id
    AND o.operation_kind IN ('module.instance.suspend', 'module.instance.resume', 'module.instance.archive')
  ORDER BY o.accepted_at DESC, o.operation_id DESC
  LIMIT 1
) latest ON true
WHERE i.tenant_id = :'tenant_id'::uuid
  AND i.instance_id = :'instance_id'::uuid;
ROLLBACK;
```

## Place a hold

Only active instances with active current deployments or member suspensions are
eligible. An unfinished application launch using the instance through either a
step or installation link blocks the hold. The pointer is cleared even when the
member had already suspended the instance; retaining it would let owner resume
undo the platform hold.

<!-- platform-hold:hold -->
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('freedom.tenant_id', :'tenant_id', true);
SELECT i.instance_id
FROM module_instances i
WHERE i.tenant_id = :'tenant_id'::uuid
  AND i.instance_id = :'instance_id'::uuid
FOR NO KEY UPDATE;
SELECT d.binding_id
FROM deployment_bindings d
JOIN module_instances i
  ON i.tenant_id = d.tenant_id
 AND i.instance_id = d.instance_id
 AND i.binding_id = d.binding_id
WHERE i.tenant_id = :'tenant_id'::uuid
  AND i.instance_id = :'instance_id'::uuid
FOR NO KEY UPDATE OF d;

WITH eligible AS MATERIALIZED (
  SELECT i.tenant_id, i.instance_id, i.binding_id,
         i.status AS previous_status,
         i.suspension_operation_id AS previous_suspension_operation_id,
         d.state AS previous_deployment_state, d.version AS previous_deployment_version
  FROM module_instances i
  JOIN deployment_bindings d
    ON d.tenant_id = i.tenant_id
   AND d.instance_id = i.instance_id
   AND d.binding_id = i.binding_id
  WHERE current_database() = :'expected_database'
    AND i.tenant_id = :'tenant_id'::uuid
    AND i.instance_id = :'instance_id'::uuid
    AND (
      (i.status = 'active' AND d.state = 'active')
      OR (i.status = 'suspended' AND d.state = 'suspended' AND EXISTS (
          SELECT 1 FROM module_provision_operations o
          WHERE o.tenant_id = i.tenant_id
            AND o.instance_id = i.instance_id
            AND o.operation_id = i.suspension_operation_id
            AND o.operation_kind = 'module.instance.suspend'
        ))
    )
    AND NOT EXISTS (
      SELECT 1 FROM module_provision_operations o
      WHERE o.tenant_id = i.tenant_id
        AND o.operation_kind = 'application.launch'
        AND o.state IN ('requested', 'running', 'needs_reconciliation')
        AND (
          EXISTS (SELECT 1 FROM module_provision_steps s
                  WHERE s.tenant_id = o.tenant_id
                    AND s.operation_id = o.operation_id
                    AND s.instance_id = i.instance_id)
          OR EXISTS (SELECT 1 FROM application_module_links l
                     WHERE l.tenant_id = o.tenant_id
                       AND l.installation_id = o.installation_id
                       AND l.instance_id = i.instance_id)
        )
    )
), changed_instance AS (
  UPDATE module_instances i
  SET status = 'suspended', suspension_operation_id = NULL, version = i.version + 1
  FROM eligible e
  WHERE i.tenant_id = e.tenant_id
    AND i.instance_id = e.instance_id
  RETURNING i.tenant_id, i.instance_id, i.binding_id, i.version AS instance_version,
            e.previous_status, e.previous_suspension_operation_id,
            e.previous_deployment_state, e.previous_deployment_version
), changed_deployment AS (
  -- Only an instance returned above can change its deployment.
  UPDATE deployment_bindings d
  SET state = 'suspended', version = d.version + 1
  FROM changed_instance i
  WHERE d.tenant_id = i.tenant_id
    AND d.instance_id = i.instance_id
    AND d.binding_id = i.binding_id
    AND d.state = 'active'
  RETURNING d.tenant_id, d.instance_id, d.version AS deployment_version
)
SELECT i.tenant_id, i.instance_id, i.previous_status,
       i.previous_suspension_operation_id, i.previous_deployment_state, i.instance_version,
       COALESCE(d.deployment_version, i.previous_deployment_version) AS deployment_version
FROM changed_instance i
LEFT JOIN changed_deployment d
  ON d.tenant_id = i.tenant_id AND d.instance_id = i.instance_id;
```

## Release an instance that was active

Use only when the recorded hold row says `previous_status = 'active'` and a NULL
previous suspension pointer. The current instance must be suspended with a NULL
pointer and a suspended current deployment. Its latest lifecycle operation must
be absent or a resume; a latest suspend refuses this release.

<!-- platform-hold:release-active -->
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('freedom.tenant_id', :'tenant_id', true);
SELECT i.instance_id
FROM module_instances i
WHERE i.tenant_id = :'tenant_id'::uuid
  AND i.instance_id = :'instance_id'::uuid
FOR NO KEY UPDATE;
SELECT d.binding_id
FROM deployment_bindings d
JOIN module_instances i
  ON i.tenant_id = d.tenant_id
 AND i.instance_id = d.instance_id
 AND i.binding_id = d.binding_id
WHERE i.tenant_id = :'tenant_id'::uuid
  AND i.instance_id = :'instance_id'::uuid
FOR NO KEY UPDATE OF d;

WITH eligible AS MATERIALIZED (
  SELECT i.tenant_id, i.instance_id, i.binding_id
  FROM module_instances i
  JOIN deployment_bindings d
    ON d.tenant_id = i.tenant_id
   AND d.instance_id = i.instance_id
   AND d.binding_id = i.binding_id
  LEFT JOIN LATERAL (
    SELECT o.operation_kind, o.operation_id, o.accepted_at
    FROM module_provision_operations o
    WHERE o.tenant_id = i.tenant_id
      AND o.instance_id = i.instance_id
      AND o.operation_kind IN ('module.instance.suspend', 'module.instance.resume', 'module.instance.archive')
    ORDER BY o.accepted_at DESC, o.operation_id DESC
    LIMIT 1
  ) latest ON true
  WHERE current_database() = :'expected_database'
    AND i.tenant_id = :'tenant_id'::uuid
    AND i.instance_id = :'instance_id'::uuid
    AND i.status = 'suspended'
    AND i.suspension_operation_id IS NULL
    AND d.state = 'suspended'
    AND (latest.operation_kind IS NULL OR latest.operation_kind = 'module.instance.resume')
), changed_instance AS (
  UPDATE module_instances i
  SET status = 'active', version = i.version + 1
  FROM eligible e
  WHERE i.tenant_id = e.tenant_id
    AND i.instance_id = e.instance_id
  RETURNING i.tenant_id, i.instance_id, i.binding_id, i.version AS instance_version
), changed_deployment AS (
  UPDATE deployment_bindings d
  SET state = 'active', version = d.version + 1
  FROM changed_instance i
  WHERE d.tenant_id = i.tenant_id
    AND d.instance_id = i.instance_id
    AND d.binding_id = i.binding_id
  RETURNING d.tenant_id, d.instance_id, d.version AS deployment_version
)
SELECT i.tenant_id, i.instance_id, i.instance_version, d.deployment_version
FROM changed_instance i
JOIN changed_deployment d
  ON d.tenant_id = i.tenant_id AND d.instance_id = i.instance_id;
```

## Restore the member suspension

Use the recorded `previous_suspension_operation_id`. It must be this tenant's
and instance's suspend operation and its latest lifecycle operation. This
restores only the pointer and advances the instance version; status and
deployment remain suspended. The owner may then resume through the API, subject
to the usual permissions and capacity checks. The original reason and time
remain in the operation log.

<!-- platform-hold:release-member -->
```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT set_config('freedom.tenant_id', :'tenant_id', true);
SELECT i.instance_id
FROM module_instances i
WHERE i.tenant_id = :'tenant_id'::uuid
  AND i.instance_id = :'instance_id'::uuid
FOR NO KEY UPDATE;
SELECT d.binding_id
FROM deployment_bindings d
JOIN module_instances i
  ON i.tenant_id = d.tenant_id
 AND i.instance_id = d.instance_id
 AND i.binding_id = d.binding_id
WHERE i.tenant_id = :'tenant_id'::uuid
  AND i.instance_id = :'instance_id'::uuid
FOR NO KEY UPDATE OF d;

WITH eligible AS MATERIALIZED (
  SELECT i.tenant_id, i.instance_id, latest.operation_id, d.version AS deployment_version
  FROM module_instances i
  JOIN deployment_bindings d
    ON d.tenant_id = i.tenant_id
   AND d.instance_id = i.instance_id
   AND d.binding_id = i.binding_id
  LEFT JOIN LATERAL (
    SELECT o.operation_kind, o.operation_id, o.accepted_at
    FROM module_provision_operations o
    WHERE o.tenant_id = i.tenant_id
      AND o.instance_id = i.instance_id
      AND o.operation_kind IN ('module.instance.suspend', 'module.instance.resume', 'module.instance.archive')
    ORDER BY o.accepted_at DESC, o.operation_id DESC
    LIMIT 1
  ) latest ON true
  WHERE current_database() = :'expected_database'
    AND i.tenant_id = :'tenant_id'::uuid
    AND i.instance_id = :'instance_id'::uuid
    AND i.status = 'suspended'
    AND i.suspension_operation_id IS NULL
    AND d.state = 'suspended'
    AND latest.operation_kind = 'module.instance.suspend'
    AND latest.operation_id = :'suspension_operation_id'::uuid
)
UPDATE module_instances i
SET suspension_operation_id = e.operation_id, version = i.version + 1
FROM eligible e
WHERE i.tenant_id = e.tenant_id
  AND i.instance_id = e.instance_id
RETURNING i.tenant_id, i.instance_id, i.suspension_operation_id,
          i.version AS instance_version, e.deployment_version;
```

## Limits and follow-up

SQL holds and releases write no `freedom.module.instance.status_changed.v1`
event, scoped journal, outbox or `platform_admin_audit` row. The incident record
is therefore required; these actions are not audited operator commands.
Release does not re-check the capacity policy or quotas: a held instance already
counts toward usage. An unfinished launch that uses the instance blocks hold.
This procedure handles only the hold form it creates, not every state classified
as a platform hold. An explicit hold marker and an audited operator command are
proposed follow-up work.
