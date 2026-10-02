# Member command compatibility core

`index.ts` retains the public `command(pool, input, authorize, run)`, `transaction`, `digest`, `journal` and `checkVersion` entrypoints. `command` is an alias of `memberCommand`. Existing callers and historical receipts do not migrate.

The internal orchestration in [command-core.ts](command-core.ts) depends on PostgreSQL types, transaction handling and neutral Problem errors, not the identity or execution domain. Server-owned adapter ports provide current authentication/locking, receipt serialization, digest and receipt storage. The member adapter is the only implemented adapter. No service/execution API or credential acceptance is enabled.

## Order and invariants

The member path remains: validate idempotency key → BEGIN → lock active user (`FOR SHARE`, or `FOR UPDATE` for user mutations) → lock current non-revoked/unexpired session → original user/operation/key advisory lock → current domain authorization → original request digest → receipt lookup → replay or domain mutation/receipt → COMMIT. All callbacks receive the same transaction client; errors roll back and release it.

The digest stays `digest({body, expected: expected ?? null})`. The historical sorted-key JSON encoder in `legacy-digest.ts` is unchanged; it is not JCS. Operation strings, receipt primary keys, response JSON and error codes remain unchanged. Scope/principal/attempt-based receipt namespaces must be implemented separately, never by pretending a service is a member.

The follow-on [resource-scopes package](../resource-scopes/README.md) shares only current member user/session locking through `member-session.ts`; it adds no scope check, query, mapping creation or new receipt behavior to the legacy `command()` path. Its separate context helper does not replace this command wrapper.

Ports are internal server functions, not a serialized VerifiedContext or an authorization proof. A future adapter must verify backing credentials and current authority inside this transaction, define lock ordering and a collision-free namespace, and pass real revocation/concurrency tests before exposing a route. No provider/object-store/network I/O belongs in core callbacks. Historical avatar normalization remains inside its existing command callback and is not fixed by this extraction.

## Regression evidence

[command-core.test.ts](../../tests/runtime/command-core.test.ts) uses actual migrations and a new `fp_command_core_*` schema. It exercises a fixed legacy digest, response/namespace compatibility, key validation, session/user/domain revocation before replay, body/version conflicts, two sessions sharing a key, actual PostgreSQL lock waits, both revocation/command ordering directions, and atomic rollback of domain, journal, outbox and receipt failures.

The first 14 cases passed against the original member implementation before extraction and passed again after extraction, together with the existing flows, avatar and access-session regressions (56 total cases). With the journal/outbox failure cases added, all 16 core cases passed in the complete 898-test runtime suite; the 20-test workerd suite also passed. Final results and environment failures/retries are recorded in the [spec handoff](../../docs/platform-plan/execution/unified-foundation/implementation-status.md). These tests do not prove any machine credential, principal mapping, new Asset storage or private Work authorization.

For database tests use a disposable database or an isolated `fp_*` schema; never migrate/seed/truncate `freedom_local.public`. This change adds no migration and reserves no number. The local governance verifier still reports runtime suite adapters/registration coverage as unavailable; manually recorded runtime results are not a trusted CI check.
