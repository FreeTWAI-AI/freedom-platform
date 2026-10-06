# Principal and resource-scope mapping

This server-only package implements member mapping and the closed, shop-backed service resolver in [shop-service.ts](shop-service.ts). Both use current database authority on the caller's transaction. A common schema reference alone cannot authenticate a member, execution device or website service. The member helper below retains its existing interface and receipts.

## Authoritative records

The additive [076 migration](../../migrations/076_principal_resource_scopes.sql) created the member mappings without copying or modifying existing data. Later migrations extend the backing shapes without renaming or changing that applied SQL.

| Mapping | Database constraint | Meaning |
| --- | --- | --- |
| person principal → user | unique, non-null FK to `users.user_id` | Opaque principal UUID is independent of user ID; email is never identity matching. |
| community scope → community | unique, non-null community FK; no owner principal | Scope does not invent a community owner or replace membership/domain rules. |
| personal scope → person principal | unique composite FK to `(principal_id, kind)`; generated owner kind is `person`; no community ref | One personal scope per person; no future service principal can silently acquire one. |

Both tables accept only `active`/`disabled` status. [118](../../migrations/118_shop_service_identity.sql) adds a service principal backed by exactly one existing `commerce_shops` row and a site scope composite-bound to that same shop/service. It preserves the person-only personal-owner FK. Identity fields are immutable; UPDATE cannot transfer a mapping and DELETE is rejected, so a DML client cannot delete/reinsert it to reset status or rebind an ID. Disable it instead. This is not protection against a privileged schema owner disabling triggers or truncating tables. Account erasure/purge requires a separately reviewed lifecycle; there is no deletion endpoint here.

[Common reference schemas](../../contracts/common/README.md) describe wire shapes; support still depends on a real adapter and backing. The service implementation here supports only the existing shop API, not generic website services or owner private Work. It publishes no consumer ReleaseSet.

## Shop service context

`lockShopService(q, authorization, host)` requires the actual opaque bearer key, active shop owner, current key expiry/revocation, and the v2 key's exact purpose/issuer/audience/environment. These expectations come from the installed host's validated origin/environment and explicit `FREEDOM_SHOP_KEY_POLICY`; request headers, model keys and caller principal IDs supply none of them. New owner-issued `fw_shop_v2_` credentials use `freedom.shop-service-key/v1`, purpose `shop-api`, issuer equal to `APP_ORIGIN`, and audience `APP_ORIGIN + /shop-api/v1`. Shop payment mode (`test`/`live`) is unrelated to deployment environment.

The resolver locks owner → key → service principal → site scope → existing community commerce advisory lock → current shop. Lazy mapping uses unique backing plus a separate read of the committed winner and never re-enables disabled rows. The returned service/site is distinct from the administrative owner's person/personal identity. `assertShopServiceClock` accepts only a live context on the same SQL client and rechecks the key after waits; callers must `forgetShopService` on both success and failure. Current row locks provide revocation ordering, not cancellation of an earlier committed operation or a promise about network delivery after COMMIT.

The closed [cancel adapter](../../modules/agent-commerce/service-command.ts) uses the existing command core, a server-derived order UUID receipt key, current own-order authorization before replay, and the shared transaction context/journal. Only pending → cancelled creates one `commerce_order_cancellation` fact at version 1. A prior legacy cancellation can gain a compatible receipt without inventing a new transition. Receipt SELECT/INSERT and domain/journal waits are followed by key clock checks; a failure rolls back inventory, order, facts and receipt together. Other existing shop operations retain their business dedupe and dynamic readback; converting their remaining mutation receipts/audit is still open.

Missing policy closes shop credential access and issuance with 503 while member routes remain available. Explicit `legacy-compatible` accepts existing unbound keys using their original shop authority and expiry/revoke checks, without a fabricated service principal. Explicit `purpose-bound-only` refuses them. Migration does not stamp, rotate or revoke live keys. See the executable, read-only [exit procedure](../../modules/agent-commerce/README.md); local compatibility tests are not evidence that deployed issuers or live legacy keys have retired.

## Current member context

`withMemberScope(pool, {actor, scope, lockUser?}, authorize, run)` resolves `personal`/`community`, or checks an exact typed scope reference. It locks/checks the current member session, lazily ensures mappings, checks current mapping status, calls mandatory domain authorization, then calls `run` using the **same transaction client**. Failure rolls back mapping creation as well as callback effects.

This is a context/read transaction helper, **not a replacement for `command()`**: it provides no command receipt, idempotency, expected-version, journal or outbox guarantee. Do not implement a mutation by wrapping it here and bypassing command protections. The additive [scoped member adapter](../db/README.md#additive-scoped-member-commands) composes `lockMemberScope(q, input)` on its existing transaction client. That exported resolver performs the same user/session/principal/scope locks and returns the same frozen context, but does not start/commit a transaction or authorize a domain target. `withMemberScope` still owns its transaction and callback ordering. Nesting a second transaction is not a solution. No provider, object-store or network I/O belongs in either callback.

The input `Actor` must originate from the server's member authentication. The helper rechecks its user/community/session against the database; caller JSON or a previously returned frozen `MemberScopeContext` is not a credential. Domain authorization must read current domain authority, not infer it from a principal ID or scope. `requireSameScope(expected, actual)` checks both UUID and kind and returns a non-disclosing 404 on mismatch; it is only a necessary target check, not an ACL or a substitute for future resource-table composite FKs.

Selected-scope status is local to that scope: a disabled community scope does not disable the person's independent personal scope. A disabled principal blocks both. Neither status is wired into old member routes in this batch; it does not claim global account revocation. Existing active-user/session checks still govern those routes.

## Lock order and revocation

At PostgreSQL READ COMMITTED: BEGIN → active user (`FOR SHARE`, or `FOR UPDATE` from the outset if `lockUser`) → current session (`FOR SHARE`) → principal (`FOR SHARE`) → selected scope (`FOR SHARE`) → domain authorize → callback → COMMIT. Auth predicates are shared with the legacy member adapter through `lockMemberSession`; the legacy command order/digest are unchanged.

Concurrent first use uses UNIQUE + `INSERT … ON CONFLICT DO NOTHING`, then a separate SELECT that observes the committed winner. It never updates the winning mapping or re-enables a disabled row. PostgreSQL's [READ COMMITTED conflict behavior](https://www.postgresql.org/docs/18/transaction-iso.html#XACT-READ-COMMITTED) is why a single INSERT/SELECT snapshot is insufficient.

A status revocation that obtains its row lock first makes a later resolver observe disabled state. An already-authorized transaction holding the share lock finishes before revocation can commit; the next resolver rejects. This is the chosen linearization boundary, not cancellation of effects already committed. Multi-record revocation operations must follow the same user → session → principal → scope order and get their own concurrency tests before exposure. No new revoke endpoint is provided here.

## Bounded backfill

`backfillLegacyScopeBatch(pool, limit = 100)` is an explicit server-side maintenance primitive. It is not automatically run by the migration, startup, a cron job or a deployment script. This batch adds no production backfill CLI or authorization to operate production.

Each call processes at most 1–500 backing records in one transaction, with a 5-second lock timeout and 30-second statement timeout. First it locks missing communities in UUID order using `FOR UPDATE SKIP LOCKED` and creates their community scopes. If it processed any communities, it stops that phase at commit. A call with no available missing communities instead locks missing users and creates their person/personal mappings. Keeping phases in separate transactions avoids holding a newly inserted community scope while waiting for a member principal that a runtime request already holds.

The result contains only `processed`, per-kind `created` counts, and remaining community/user counts; it contains no member data or credentials. Counts are observations, not a durable cursor. Locked work may produce `processed: 0` with nonzero remaining counts; callers must use bounded retries/backoff and rerun later, not spin or declare completion. More users may arrive after a zero count. Lazy provisioning covers later first use.

Backfill includes inactive users as identity mappings, not active sessions/permissions. It never changes old memberships, roles, sessions, receipt hashes or responses; it never reactivates disabled rows. A failed batch rolls back entirely. Committed IDs are reused after retry; IDs from a rolled-back transaction are not published identities.

## Evidence and limits

[resource-scopes.test.ts](../../tests/runtime/resource-scopes.test.ts) uses fresh `fp_*` schemas and synthetic members. It covers validator/JSON Schema agreement, scope isolation, session/principal/scope revocation, immutable mappings, SQL constraints, concurrent first use/backfills, lock barriers, rollback/resume, a 075 upgrade preserving all legacy table hashes and replay, and non-superuser migration with DML-only runtime access. Its synthetic authorize callbacks test sequencing, not a complete private Work ACL.

See the [local delivery record](../../docs/platform-plan/execution/unified-foundation/implementation-status.md) for executed results and limitations. Test only disposable databases or isolated `fp_*` schemas; never migrate/seed/truncate `freedom_local.public`. No deployed grants-check, staging/prod migration, private Work matrix or machine-credential acceptance is claimed.

## Tenant scope

`lockTenantScope` resolves an authenticated person plus a server-checked tenant id. Lock order is session, person principal, the existing tenant `resource_scopes` row, the tenant row, then the actor's membership. It never inserts a tenant scope. `withMemberScope` and `lockMemberScope` still accept only `personal` and `community`; a `tenant` or `site` reference is rejected before a transaction starts. Missing tenant, scope, or active membership is the same 404 as a missing tenant. Suspended, recovery, and archived tenants still return context to an active member, with `tenant_status` set, so the domain can allow metadata reads.
