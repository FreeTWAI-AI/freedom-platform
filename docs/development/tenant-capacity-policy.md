# Tenant capacity policy operator

[Migration 123](../../migrations/123_tenant_manual_work.sql) creates the policy table without a seed. Until an active default or tenant override exists, tenant writes fail with `policy_unconfigured`. The [module registry](../../modules/module-registry/README.md) owns the table; product code has no policy inserter.

An operator runs [tenant-policy.ts](../../scripts/tenant-policy.ts) with the table owner (migrator) connection passed explicitly through `--database-url`. The runtime role cannot write policy rows. The tool never reads `DATABASE_URL`; `--database-url` must name user, host, port and database explicitly (`postgresql://USER[:PASSWORD]@HOST:PORT/DATABASE`), and the connection is built from that URL alone, without consulting `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGOPTIONS`, `PGSSLMODE` or `.pgpass`. The query string may hold only `sslmode` (`verify-full` or `disable`) and non-empty `options`, once each; without `sslmode` the connection does not use TLS, so use `sslmode=verify-full` for any non-local target. Unix-socket URLs (`?host=` or a percent-encoded socket host) and any other parameter are refused with `invalid_database_url` before connecting, while port `54339` and database `freedom_local` are refused as `shared_local_database_refused` on the same values the connection uses. The `NODE_ENV=production` refusal is a client-process guard: it refuses running inside a production-configured process; it is not trusted server-environment detection and does not identify or refuse a database. The database target guard is `--expect-database`. Set `OPERATOR_DATABASE_URL` privately; keep it out of version control and shared logs. Successful reports identify the connected database and role without printing the connection string.

Every command requires `--expect-database <name>`, the database the operator intends to act on. The name is validated before connecting (`^[a-z_][a-z0-9_]{0,62}$`). The first query of the transaction compares it with `current_database()`. On a mismatch the tool rolls back and refuses with `database_mismatch` before taking any lock or reading or writing any policy or tenant row. Set `EXPECTED_DATABASE` from the target environment's reviewed configuration, not by copying it out of the URL being used: it is an independent statement of the intended target.

## Commands

`status` reads the active default, active overrides ordered by tenant, the newest 20 retired rows, and the total retired count:

```sh
npx tsx scripts/tenant-policy.ts status --database-url "$OPERATOR_DATABASE_URL" --expect-database "$EXPECTED_DATABASE"
```

`plan` requires every limit and writes nothing. It shows the active row to retire and the proposed insert. Add `--tenant <uuid>` for a tenant override; the tenant must exist. Revisions advance from the maximum across all active and retired rows of that scope.

```sh
npx tsx scripts/tenant-policy.ts plan --database-url "$OPERATOR_DATABASE_URL" \
  --expect-database "$EXPECTED_DATABASE" \
  --plan-ref interim-default-20261007 \
  --max-active-instances 10 --max-instances-per-module 3 \
  --max-concurrent-provisions 2 --max-work-items 1000 \
  --max-retained-bytes 104857600 --max-concurrent-jobs 2 --max-model-budget 0
```

`apply` without `--execute` produces the same read-only plan. After reviewing it, use `--execute` to retire the previous row and insert its replacement atomically:

```sh
npx tsx scripts/tenant-policy.ts apply --database-url "$OPERATOR_DATABASE_URL" \
  --expect-database "$EXPECTED_DATABASE" \
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

A pending tenant Result upload pins the tenant's effective policy revision (its override, otherwise the default) when prepared. If an apply changes that revision, claim, finalize and resume fail with `asset_policy_changed` (409), and the member must prepare the upload again. A Result read that overlaps the change can also return `asset_policy_changed` and can be retried. This is the existing fail-safe behavior; the tool does not change it.

Each invocation emits one JSON line: success on stdout, refusal or failure on stderr. Bigint fields are decimal strings and timestamps are ISO strings. Exit codes are `0` for success, `2` for validation/safety refusals or a missing tenant, and `1` for database or verification failure. `invalid_database_url` and `shared_local_database_refused` exit `2` before connecting. `database_mismatch` exits `2` and names `expected` and `connected` in the report; no policy or tenant row was locked, read or written, and no advisory lock was taken. `invalid_expected_database` exits `2`, refused before connecting; a missing `--expect-database` is refused with `missing_flag`. SQLSTATE `42501` reports `operator_privilege_required`: use the table owner (migrator) connection. A failed scope verification rolls back the replacement.
