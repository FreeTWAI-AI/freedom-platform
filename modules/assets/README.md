# Closed member-avatar upload lifecycle

This ASSET-A increment composes the [scoped member command core](../../packages/scoped-commands/index.ts) with [asset-storage](../../packages/asset-storage/README.md). It is an internal prototype, not an enabled product flow. There are no routes, Worker bindings, legacy avatar replacement handlers, private Work writes, execution/Grant adapters or automatic cleanup.

## One version authority, not a live avatar cutover

The target is the real `member_avatars.user_id` FK and **its existing `aggregate_version` is the only version authority**. Prepare creates a metadata-only avatar row when absent, as the existing avatar domain does. Finalize increments that real version and writes a typed sidecar pointer atomically, but preserves `image_bytes`. Legacy avatar routes still read those legacy bytes; this increment must not be described as a completed avatar replacement or read bridge.

`member_avatar_asset_targets.linked_at_version` is only the real version observed at attachment. It is never independently incremented. A subsequent legacy save/delete advances the real version and makes the sidecar stale; `readTarget` returns `assetId: null` at the new real version. A later prototype finalize still uses real avatar CAS. A production bridge must define all live read/presence surfaces, legacy-writer fencing, pointer invalidation/cutover and rollback floor before any route can call this service.

## Internal API

`createAvatarAssetService(pool, dependencies)` captures a trusted `ObjectStore`, `AvatarNormalizer`, and `resolvePolicy(q, context, targetUserId)` function. The policy resolver runs inside the same transaction and must only do local/database work; if its policy can change, lock its backing records until commit. A true-returning test resolver is not production data-policy evidence. Callers cannot send serialized policy or storage verification evidence.

| Method | Input beyond authenticated server Actor | Result |
| --- | --- | --- |
| `prepare` | `key`, own `targetUserId`, `expectedVersion`, input `contentType`, actual expected `byteSize`, input `sha256` | Stable intent/asset/representation IDs and expiry |
| `claim` | `key`, `intentId` | Fixed IDs plus bigint-string fence, UUID lease token and lease expiry |
| `write` | `key`, `intentId`, `fence`, `leaseToken`; separately a byte stream | Stored intent/asset IDs, no object key or bytes |
| `finalize` | `key`, `intentId`, `fence`, `leaseToken` | Intent/asset/target IDs and real aggregate version |
| `readTarget` | No target ID; current owner only | Own target ID, matching sidecar asset ID or null, real aggregate version |

Input objects are strict: pass the listed fields, not an entire claim response. Keys use the scoped core's 8–128 character alphanumeric/underscore/hyphen profile. Actor and request fields are snapshotted before awaits. This adapter currently accepts only personal scopes and completed, active members; administration, guild membership and knowledge of an intent ID do not confer access.

The lease token is a correlation nonce, not a bearer credential. It is retained in the member's scoped claim receipt for idempotent replay; every use also checks current session/principal/scope/domain/policy and fence. A claim receipt may return its historical lease after takeover/expiry; that lease is unusable because write/finalize require the current fence/token and unexpired lease. A finalized success replay returns only historical metadata after current authorization and policy checks. It never reattaches an old pointer or modifies the current avatar version.

## Durable phases and lock boundaries

Prepare validates current authority/persistence policy, real target version and concurrent reservations, then persists a pending Asset and prepared intent bound to its source manifest and policy revision. Scoped receipt identity is principal/auth-kind/scope/operation/key; generated UUIDs never change the request digest. Intent identity, source manifest, target, expected version and expiry cannot be rebound.

Claim increments a monotonic bigint fence and installs a new UUID nonce with a bounded lease. An active lease blocks takeover. A stored intent can be claimed after lease expiry without changing its object identity. Lease extension requires a new fence; administrative shortening is allowed to invalidate a lease. Intent/lease decisions use database `clock_timestamp()` after target/intent/asset locks, not transaction-start time.

Write first obtains a current authorized snapshot and commits that read transaction. It then consumes bounded input, verifies original input SHA-256 and size against the immutable manifest, fully normalizes the avatar, writes immutable bytes and verifies read-back using asset-storage. Only afterward does a scoped command recheck current authority/policy/lease and persist immutable `asset_objects` metadata plus `stored`. No byte content enters SQL, receipts, journal or outbox.

Finalize obtains current DB metadata, performs full object read-back verification **outside a transaction**, then runs a new scoped command. It rechecks current authority/policy/fence/expiry, real target CAS and stored evidence before atomically changing Asset to ready, updating sidecar and real avatar version, retiring any replaced prototype Asset, marking the intent finalized, and writing scoped journal/outbox/receipt. Receipt/journal/outbox/pointer failures roll back all these SQL effects. Already-written object bytes remain for a same-intent retry; a new claim fence is needed if the old lease expired.

The database lock order is current user → session → principal → personal scope → scoped receipt advisory lock (commands only) → real avatar → sidecar → intent → asset → trusted policy rows. All callers of a policy mutation must respect their chosen lock ordering. Initial/final storage checks use separate transactions; normalizer/store work never holds those row locks. The scoped command core checks current session expiry after blocking domain authorization. Asset inspection and target reads also call the shared database-clock expiry guard after their final potentially blocking query, before returning private metadata or releasing a snapshot to source processing/object I/O. Object verification is a pre-finalize observation, not a distributed atomic transaction with PostgreSQL; this prototype exposes no GC/delete path that could remove an object concurrently.

## Schema invariants and closed lifecycle surfaces

[Migration 079](../../migrations/079_asset_upload_lifecycle.sql), provisionally numbered until integration, creates `assets`, immutable `asset_objects`, `asset_upload_intents` and the typed avatar sidecar. Composite FKs bind actual user/principal/personal-scope, purpose, representation and policy. Pointer FKs require a ready Asset of the same user/scope/purpose. Assets must be inserted pending and intents prepared without a lease; direct ready/stored/finalized inserts cannot skip transition checks. A ready/stored transition requires its persisted representation. Required first-profile variants are exactly the single canonical avatar representation. These SQL constraints establish metadata relationships; only the trusted write path establishes actual object bytes/digest.

Default intent TTL is one hour (configurable 1–86400 seconds), lease is five minutes (1–3600), and concurrent pending-intent limit is three (1–100). Each intent reserves the maximum 128 KiB avatar output. The limit bounds simultaneous live reservations, **not lifetime physical storage**: expired/orphan/retired bytes remain. Expired intents are rejected based on their clock deadline, without a background state rewrite. A total retained-byte quota and reclamation policy are required before activation.

GC, deletion fences, backup pins/barriers, retention and orphan reconciliation remain closed. No service method calls `ObjectStore.delete`; SQL rejects deletion/rebinding of lifecycle rows and object metadata. This is not a claim that a late external PUT cannot recreate a manually deleted object. No automatic expiry deletion, R2 setup, backup/restore, private Work result or machine credential support is provided.

## Evidence

[Focused lifecycle tests](../../tests/runtime/asset-lifecycle.test.ts) register `ASSET-LIFE-01`–`14` against explicit disposable PostgreSQL and fresh `fp_asset_lifecycle_*` schemas, with real image decoding and fake object I/O. They cover durable phases, idempotency/quota, original source-manifest validation, fresh policy, owner/version checks, missing-object retry, SQL constraints, lease takeover, legacy-version invalidation, caller mutation across an await, strict input validation, and actual blocked-lock session expiry before metadata disclosure or source/object I/O. Independent race tests are maintained in a separate integration slice.

Executed local checks belong in the handoff, not inferred from this list. No staging/prod/cloud/HTTP/complete ASSET-A acceptance is implied. The remaining bridge, retained-byte quota, GC/backup, rollout and full private-work surfaces must pass their own acceptance before enabling this prototype.
