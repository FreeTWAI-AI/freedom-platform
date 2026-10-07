# Tenant capacity policy operator

[Migration 123](../../migrations/123_tenant_manual_work.sql) creates the policy table without a seed. Until an active default or tenant override exists, tenant writes fail with `policy_unconfigured`. The [module registry](../../modules/module-registry/README.md) owns the table; product code has no policy inserter.

An operator runs [tenant-policy.ts](../../scripts/tenant-policy.ts) with the table owner (migrator) connection passed explicitly through `--database-url`. The runtime role cannot write policy rows. The tool never reads `DATABASE_URL`, refuses `NODE_ENV=production`, and refuses the shared local database (port `54339` or database name `freedom_local`). Set `OPERATOR_DATABASE_URL` privately; keep it out of version control and shared logs. Reports identify the connected database and role without printing the connection string.

## Commands

`status` reads the active default, active overrides ordered by tenant, the newest 20 retired rows, and the total retired count:

```sh
npx tsx scripts/tenant-policy.ts status --database-url "$OPERATOR_DATABASE_URL"
```

`plan` requires every limit and writes nothing. It shows the active row to retire and the proposed insert. Add `--tenant <uuid>` for a tenant override; the tenant must exist. Revisions advance from the maximum across all active and retired rows of that scope.

```sh
npx tsx scripts/tenant-policy.ts plan --database-url "$OPERATOR_DATABASE_URL" \
  --plan-ref interim-default-20261007 \
  --max-active-instances 10 --max-instances-per-module 3 \
  --max-concurrent-provisions 2 --max-work-items 1000 \
  --max-retained-bytes 104857600 --max-concurrent-jobs 2 --max-model-budget 0
```

`apply` without `--execute` produces the same read-only plan. After reviewing it, use `--execute` to retire the previous row and insert its replacement atomically:

```sh
npx tsx scripts/tenant-policy.ts apply --database-url "$OPERATOR_DATABASE_URL" \
  --plan-ref interim-default-20261007 \
  --max-active-instances 10 --max-instances-per-module 3 \
  --max-concurrent-provisions 2 --max-work-items 1000 \
  --max-retained-bytes 104857600 --max-concurrent-jobs 2 --max-model-budget 0 \
  --execute
```

The interim staging default is planned as `plan_ref` `interim-default-20261007` with `max_active_instances` 10, `max_instances_per_module` 3, `max_concurrent_provisions` 2, `max_work_items` 1000, `max_retained_bytes` 104857600, `max_concurrent_jobs` 2, and `max_model_budget` 0. The operator applies it after reviewing `plan` output; this PR does not.

## Reviewed bounds

All limits are required unsigned decimal integers, with no leading zeros, signs, whitespace, decimals or exponents. Zero and the exact ceiling are accepted. Raising a ceiling needs a reviewed change.

| Limit | Ceiling |
| --- | ---: |
| `max_active_instances` | 50 |
| `max_instances_per_module` | 10 |
| `max_concurrent_provisions` | 5 |
| `max_work_items` | 10000 |
| `max_retained_bytes` | 1073741824 (1 GiB) |
| `max_concurrent_jobs` | 10 |

`max_model_budget` must be exactly `0`. NULL means unlimited and is refused. Private AI budgets need a later reviewed change. `plan_ref` must contain 1–120 Unicode code points; tenant IDs must be lowercase canonical UUIDs.

## Locking and results

Same-scope applies serialize on a transaction advisory lock. A tenant apply shares the runtime per-tenant policy lock, so in-flight tenant writes finish before replacement and later writes see the new override. The active row is also locked `FOR UPDATE` before retirement.

For the default scope, in-flight writes finish under the old row. A write whose policy read races the commit may fail once with `policy_unconfigured` and can be retried. The default lock does not take every tenant's advisory lock. `lock_timeout` is 10 s; a `lock_timeout` failure rolls back with nothing written and is safe to retry.

Each invocation emits one JSON line: success on stdout, refusal or failure on stderr. Bigint fields are decimal strings and timestamps are ISO strings. Exit codes are `0` for success, `2` for validation/safety refusals or a missing tenant, and `1` for database or verification failure. SQLSTATE `42501` reports `operator_privilege_required`: use the table owner (migrator) connection. A failed scope verification rolls back the replacement.
