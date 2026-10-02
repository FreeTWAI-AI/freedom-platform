# Closed member private Work/Result HTTP transport

`createPrivateWorkTransport(pool, { origin, freedomEnv, store? })` in
[private-work-transport.ts](private-work-transport.ts) is an **unmounted** router
factory. Tests may mount it under `/api/v1`; neither `createPlatformApp` nor the
Worker imports or registers it. Production retains only its existing two private
Work GET routes. This is local transport evidence, not private-feature activation.
No pending PR, UI, migration, model, cloud policy or binding is changed.

## Fixed member boundary

The factory independently authenticates the real `freedom_local_session` cookie.
It never trusts a previously injected Actor, bearer/Agent credential, request
owner/scope, or caller policy. [The shared member middleware](../member-boundary.ts)
was extracted from the existing platform app, retaining its cookie, timing-safe
CSRF comparison, authentication and onboarding rules except for the fail-closed
empty-token guard described below. Production passes its unchanged
onboarding exception list; this factory passes no exception. All private paths
require completed onboarding, including HEAD and failed command replays.

A narrowly approved hardening rejects an empty/non-string stored CSRF token
before comparison. The legacy schema allows an empty string, although normal
login/registration always generate a random nonempty token. A malformed DB row
must not make an absent/empty header pass a zero-byte equality check. Tests use
an actual empty-token session and both production and closed routers; ordinary
generated-token requests still succeed. No other auth semantics are changed.

The configured host/origin allowlists come from the existing environment helpers.
Unsafe methods require an allowed Origin and the existing `X-CSRF-Token` compared
to the authenticated member session. Actual services then lock and revalidate
current user/session, principal, scope and exact Work ownership; no admin/guild
role expands access. Error bodies use fixed text and a bounded internal code
allowlist, never Zod property names, request text, raw storage/SQL errors or keys.

Every response/error is `Cache-Control: private, no-store`, `Vary: Cookie`,
`X-Content-Type-Options: nosniff`, `X-Robots-Tag: noindex, nofollow`,
`Referrer-Policy: no-referrer` and `Cross-Origin-Resource-Policy: same-origin`.
No public share, crawler or unauthenticated alias is provided.

## Routes and representations

Paths below are relative to the factory; the test mount adds `/api/v1`.

| Method/path | Body/query | Success |
| --- | --- | --- |
| GET `/me/private-work` | existing `q`, `limit`, `offset` | existing owner-only list/count projection |
| GET `/me/private-work/:id` | no query | existing owner-only Work DTO |
| POST `/me/private-work` | `{title, objective}` | 201 `{workId, aggregateVersion, state}` |
| POST `/me/private-work/:id/edit` | complete `{title, objective}` | 200 same receipt shape |
| POST `/me/private-work/:id/archive` | `{}` | 200 same receipt shape, archived |
| GET `/me/private-work/:id/results` | `limit` 1–50, `offset` 0–10000 | bounded metadata history |
| GET `/me/private-work/:id/results/current` | no query | current verified text DTO, or JSON null when no Result |
| GET `/me/private-work/:id/results/:resultId` | no query | exact historical verified text DTO |

Work GET uses the old snake_case DTO with numeric `aggregate_version`: unsafe
bigints fail with `version_overflow`, matching the actual existing `createApp`
adapter. IDs/title/objective/state/version/created_at are explicitly projected;
there is no spread of DB rows into a new response. Command receipts and Result
DTOs preserve their canonical decimal-string versions. Command successes set
`ETag: "<aggregateVersion>"`; this is a CAS hint, not a public/cache validator.

Result text is JSON string data, even for `text/markdown`; this router never
renders HTML/Markdown, fetches arbitrary URLs, signs a download URL, or returns
raw object keys, scope IDs, bucket details or credentials. Future UI must render
untrusted text safely. Result provenance remains `human`; reading it is not AI
execution, submission, acceptance, publication or XP evidence.

HEAD follows the corresponding GET, including all current authority and, for
content, both service checks around object I/O; only the response body is omitted.
Range and conditional headers are not implemented: authorized reads return full
200 JSON (never 206/304), unauthorized reads still fail. This can read the whole
bounded object for HEAD, deliberately preferring correct verification to a new
unproven metadata-only authorization path. It does not promise revocation of
bytes already returned to a client.

## Mutation parsing and policy

All writes require an 8–128 character `[A-Za-z0-9_-]` `Idempotency-Key`.
Edit/archive also require a single strong quoted positive PostgreSQL bigint
`If-Match`; missing is 428, malformed/weak/list/star/overflow is 400, stale is 412.
Create rejects `If-Match`. The transport invokes the existing command service;
the service owns request digests, receipt replay, current authorization and real
Work CAS. No alternate HTTP receipt table or duplicated write SQL is added.

Bodies use the narrow JSON grammar of a flat object containing string fields,
or `{}`. Nested objects, arrays, numbers, duplicate keys (including escaped
spellings), prototype keys and malformed encodings are rejected. This is not a
general JSON/canonicalization implementation. JSON must be UTF-8 and have
`application/json`, optionally `charset=utf-8`; Content-Encoding is unsupported.
Actual streamed bytes, not Content-Length alone, are limited to 32 KiB through
the existing Asset bounded reader. Domain validators further bound title to
120 characters/480 bytes and objective to 16 KiB, and reject lone surrogates,
NUL/unsupported control characters and whitespace-only content. Unknown fields
cannot configure owner, scope, store, policy, quotas, provenance or execution.

The cap is a **byte bound**, not a stream deadline or slow-client defense. Reader
cancellation can itself wait; the runtime host must separately enforce its
request time/concurrency budget. A future production mount must also reconcile
the existing app's earlier JSON body reader, which currently consumes requests
before module handlers. No unbounded outer reader can be treated as protected by
this inner cap. This factory has not been mounted there as a workaround.

Both command and Result services close over the actual 085
`resolvePrivateWorkPersistencePolicy`. There is no optional resolver callback or
environment default in this factory. Missing/disabled policy rejects new
create/edit and their replays. Archive remains policy-independent human control;
it retains SQL history, not erasure. Existing Work list/detail remain policy-
independent current owner reads; Result list/content require current policy.

## Optional object store and read linearization

`store` is only a trusted construction-time port. Without it, a closed unavailable
store is supplied to the real Result service—not a fake store or legacy fallback.
Metadata history can still be read after Work/owner/policy checks. Current Result
returns null for an authorized Work with no Result. For existing content, the
service authorizes the exact Work and Result and resolves policy before GET,
then returns sanitized 503; peer/random Work and nonexistent historical Result
remain 404, revoked session 401. Store absence never turns those checks into a
global pre-authorization 503 shortcut.

With a store, the existing service releases DB locks before bounded GET and
verifies bytes/metadata/digest. Its second transaction rechecks session/owner,
scope, Work version, exact Result and current policy before returning text.
That second authorization is the read linearization point. Revoke/archive/version
or policy change during storage I/O rejects the response; no fallback is allowed.

## Evidence and remaining gates

[Author tests](../../../../tests/runtime/private-work-http.test.ts) cover the
real cookie boundary, scoped commands/policy/replay, strict headers, actual
stream limits, escaped duplicates/UTF-8/BOM/surrogates, exact legacy DTO
comparison, bigint overflow, missing-store behavior and no production mount.
[Independent tests](../../../../tests/runtime/private-work-http-adversarial.test.ts)
cover real PostgreSQL lock waits crossing session expiry, post-GET revocation,
policy/archive/version changes, owner isolation and same-key/CAS concurrency.
They use explicit disposable `fp_*` schemas and synthetic text/stores, not live
data or deployed bindings. Shared auth extraction also needs ordinary legacy
identity/Work regression tests, not only these new-route cases.

Production mount, trusted route/surface registration and complete consumer
review remain separate work. Upload prepare/claim/write/finalize HTTP, UI/model
generation, private sharing, GC/retention/backup/restore, actual R2 deployment and
formal activation are deliberately absent. Existing closed service proofs do
not authorize sending model output through this human-only boundary.
