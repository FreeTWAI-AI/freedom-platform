# Closed member Run and execution prerequisite records

`createExecutionRuns(pool)` in [runs.ts](runs.ts) persists one logical Run tied
to a real personal Work. This is a server-only, unmounted member service. Every
metadata/receipt response contains `operational_authority: false`. It does not
invoke a model, issue a Grant/permit, select a runtime, dispatch an action or
publish a Result. No current model or execution credential is required for
these record-management operations.

## Narrow API

- `create(actor, {key, workId, expectedWorkVersion})`: create an unexecuted Run
  from the current version of an owned draft Work. Actual current 085 policy
  must permit private metadata persistence. This is not execution approval.
- `read(actor, {runId})`: bounded owner-only metadata, without title, objective,
  content, raw Asset keys, session identifiers or owner/scope internals.
- `pause(actor, {key, runId, expectedVersion})`: retain the unexecuted record and
  increment both independent fencing counters plus the Run aggregate version.
- `stop(actor, {key, runId, expectedVersion})`: cancel the unexecuted record and
  increment both counters and the Run version. Terminal records cannot revive.

All versions/epochs use positive signed-64-bit decimal strings, never Number.
Input keys/IDs use existing scoped-command/canonical identity constraints.
Unknown fields are rejected; there are no caller policy/provider/store options.
The TypeScript inputs require an expected version. Runtime parsing deliberately
allows its absence through to the shared `checkVersion`, which returns the
existing 428 `version_required` before any new-effect INSERT/UPDATE. Malformed
versions are schema errors; stale versions are 412. SQL NOT NULL constraints
are an additional direct-DML guard, not the service's missing-version handler.
The member Actor must come from the existing trusted member authentication path;
the service still revalidates current user/session/principal/personal scope.
An Actor-shaped object or the returned DTO is not standalone authentication.

The DTO is `{runId, workId, inputWorkVersion, aggregateVersion, state,
taskLeaseEpoch, controlEpoch, operational_authority:false}`. It is NOT a complete
execution `RunSnapshot` and cannot enter an operational adapter as a permit.
The owner's visible epochs are non-secret metadata, not bearer credentials or
an authorization proof. The separate closed member HTTP factory below composes
this service; production app/Node/Worker remain unmounted.

## SQL and transitions

[086](../../migrations/086_execution_runs.sql) adds only `execution_runs`:
the complete Work/mode/scope/person/user FK reuses the real 084 personal target.
Identity, original `input_work_version`, creation time and the creation-time
private persistence policy revision are immutable; DELETE is rejected. The
policy revision is historical provenance, never an active Grant or binding.

Initial state is `created`, with Run version/task epoch/control epoch each 1.
These names are a strict subset of the existing central `RunState`, not another
general-purpose execution state machine:

| Before | Allowed member control | After |
| --- | --- | --- |
| created | pause | paused |
| paused | pause with fresh Run version | paused, fresh fences |
| created / paused | stop | cancelled |
| cancelled | none | terminal |

Each actual control transition advances all three counters by exactly one;
they are distinct fields and must never be substituted for one another. Future
task/control operations may advance different domains, but this closed slice
only has owner pause/stop: both deliberately fence both domains, as does the
central decision kernel. A new-key pause on paused is another fencing decision;
same-key replay is not. This does not claim independently advancing operations
already exist in this slice. Future
execution activation must introduce genuine current Attempt and lease semantics
before these counters could participate in runtime authorization. This migration
does **not** add an unfenced nullable Attempt reference, fake Grant, TaskLease,
control ACK, recovery generation default, dispatch, model binding or Result FK.
Later migrations must add actual backing records and FKs atomically; an Attempt
cannot be created until its immutable runtime/connection/Grant/inference binding
exists. Multiple unexecuted Runs per Work are allowed, not concurrent controllers.

INSERT checks real current draft Work version and real 085 policy under row
locks; the invoker-rights trigger qualifies backing tables with `TG_TABLE_SCHEMA`
so TEMP/search_path cannot substitute a fabricated Work/policy. Runtime DML
privileges do not imply authority to change schema or disable these guards.
There is no policy/Work-active check on control UPDATE: withdrawal or archive
must not prevent cancelling retained records. No Run operation changes the
Work aggregate version, collaboration facts or immutable human Results.
`created_at` is the database's row-construction wall-clock sample, not a request
receipt timestamp or proof of commit time (a direct SQL INSERT can wait in its
BEFORE trigger after the default was sampled). It is retained for database
history; the intentionally minimal DTO is not a general audit-query API.

## Transactions, replay and revocation

Commands reuse `scopedMemberCommand` and `scopedJournal`, preserving the existing
member receipt namespace and current authorization-before-replay ordering.
Lock order is current member/session/principal/scope → receipt advisory → Work
→ Run (for existing records) → policy (create only). Run identity is looked up
first without a lock solely to resolve the immutable Work lock order. It never
escapes before full owner/Work/Run authorization. Scope SHARE locks are not
upgraded. No network or object I/O occurs anywhere in these callbacks.
Read deliberately uses the same Work→Run UPDATE locks in its short transaction,
giving one conservative serialization point with edit/archive/control. This can
serialize concurrent reads and controls; no high-throughput performance claim
is made. A future SHARE-lock optimization needs its own revocation/clock/lock-
order evidence, not an unreviewed lock-strength change in this closed increment.

Create checks draft/current policy even on replay. Its new-effect Work CAS is
after replay lookup, so a valid historical create receipt can survive a later
human edit, but not archive or policy withdrawal. Read/pause/stop deliberately
remain available after archive or persistence withdrawal; they still require
current user/session/principal/scope and onboarding. Domain locks precede a
DB `clock_timestamp()` session refresh, including read and all replay paths.
Actor and inputs are snapshotted before the first await.

Run CAS, domain changes, scoped journal/outbox and receipt commit together.
Repeated same-key controls return the historical receipt without reapplying or
reattaching state. A later stop is never undone by replaying an earlier pause.
No scoped outbox consumer/dispatcher is enabled. Events contain explicit bounded
metadata only, not Work text. This increment has never dispatched anything, so
its local `cancelled` does not claim an offline runtime acknowledged a Stop.

## Evidence boundary

`tests/runtime/execution-runs.test.ts` exercises actual PostgreSQL identity/FK,
initial-state/transition guards, immutable input, same-key concurrency, Run CAS,
current authority/replay, policy withdrawal/archive, atomic fault rollback,
mutable-input barriers and real row waits crossing session expiry. Independent
adversarial and least-privilege tests remain separate review evidence.

This advances only durable member records/control prerequisites of AP:WORK-01,
AP:WORK-03 and AP:INV-04/11. It does not finish EXEC-A or AP:WORK-05–16, Grant/
handoff/late-evidence/billing/restore acceptance, or the private AI milestone.
The existing hypothetical decision kernel and its activation-unavailable result
are unchanged. HTTP/UI, model credentials and operational runtime bindings,
Operational execution Attempt/lease/recovery binding, external recovery authority
and deployment remain absent. The separate closed prerequisite service below now
persists member consent and blocked Attempt history; its member HTTP factory is
not registered in the production app.


## Member model selection, bounded consent and blocked Attempts

[prerequisites.ts](prerequisites.ts) exposes
`createExecutionPrerequisites(pool, {environment, clientId, grantTtlSeconds?})`
with frozen `models.create/read/revoke`, `grants.create/read/revoke`, and
`attempts.create/read` ports. The [spec](../../docs/platform-plan/execution/unified-foundation/13-member-execution-prerequisites.md)
and [central schemas](../../contracts/execution/v1/member-execution.ts) define
strict member inputs and metadata. Migration [092](../../migrations/092_execution_prerequisites.sql)
adds real immutable owner/scope-bound records while leaving 086 and its closed
Run transitions unchanged.

Models retain explicit unverified provider/model/processing/custody/billing
choices bound to a genuinely paired Runtime, connection and refresh family.
Grants retain exact current Work/Run versions, independent epochs, connection,
model, family and policy revision, with explicit consent and at most one hour
clipped to backing expiry. The trusted server may shorten TTL to 1–3600 seconds;
no caller TTL or credential is accepted. Active consent grants no operational
authority. Normal refresh rotation preserves the binding; expiry, revocation,
Work edits, Run controls or policy changes deny new creates and old create
receipts. Owner read/revoke remain available after backing withdrawal.

Attempts bind the original Grant snapshot immutably, with consecutive bounded
per-Run numbering and no activation transition. Every Attempt is
`preflight_blocked` with `model_authentication_unavailable` and
`model_adapter_unavailable`. Its nested Grant is historical metadata, never a
current authorization assertion. No inferred model login, fake inferenceRef,
currentAttempt pointer, lease, model I/O, Result or dispatch exists. All public
metadata explicitly reports `operational_authority: false`.

Creation/replay checks current backing under locks and revalidates after actual
scoped receipt reads and writes. Callback waits also recheck the current session
clock; any failure rolls back domain state, scoped journal/outbox and receipt.
The invoker-rights SQL guards qualify physical backing tables and preserve all
bigint snapshot versions as decimal text. They are structural DML guards, not
member authentication or model signature verification. These services remain
server-only; production transports remain unmounted, and bootstrap credentials
remain status-only.

## Closed member HTTP factory

[createMemberExecutionHttpTransport](../../apps/platform-api/src/routes/member-execution-http.ts)
composes the real Run and prerequisite services behind the existing member cookie,
CSRF and onboarding boundary. Its [wire schemas](../../contracts/execution/v1/member-execution-http.ts)
reject caller identity/authority, command keys and primary versions in body JSON.
Primary CAS comes from strong quoted If-Match, and every POST requires an
Idempotency-Key. Required secondary versions remain in strict typed JSON bodies.
The [HTTP spec](../../docs/platform-plan/execution/unified-foundation/14-member-execution-http.md)
defines exact paths, origin/host/method checks, bounded streams, committed abuse
charges, safe errors and owner-only historical reads.

All metadata remains operational_authority false, model selections unverified,
and Attempts preflight_blocked. A 201 Attempt response records a blocked attempt;
it never acknowledges model execution. No list/execute/dispatch/provider-test
endpoint or production mount is added. This transport writes only the existing
086/092 shapes and does not require a new migration or release capability.

## Three model adapter cores

[Private adapter factories](adapters/index.ts) cover Codex subscription, Claude Code
subscription and OpenAI/Anthropic BYOK in parallel. Selection is explicit; there
are no default providers/models, credential reads, network dispatch or fallback.
`prepare` returns a private candidate, `decode` returns bounded unverified text,
and every `invoke` rejects `execution_authority_unavailable`. CLI policy remains
unsupported; BYOK is candidate-only. Every output retains
`operational_authority:false`. These cores do not promote ModelConnection, Grant
or Attempt to operational execution and are not mounted into the app/Worker.

The [adapter spec](../../docs/platform-plan/execution/unified-foundation/15-model-adapter-cores.md)
defines version/digest pins, isolated metadata probes, strict response bounds,
requested versus reported models, usage uncertainty and remaining inference
export/permit/custody requirements. Runtime tests include private codecs, local
synthetic HTTP framing and real isolated native process counterexamples; they
do not claim authenticated provider inference.


## One-use private text profile

[16](../../docs/platform-plan/execution/unified-foundation/16-private-model-step.md)
adds explicit operator export policy/member approval, a real active Attempt and
running Run, a one-use dispatched journal, bounded fixed HTTPS BYOK host,
private model Result through the Asset lifecycle and shared human/model history.
The local fixture origin is explicitly synthetic.
[17](../../docs/platform-plan/execution/unified-foundation/17-private-ai-product.md)
adds a member UI and an explicit opaque Node product transport installation;
default Node/Worker hosts stay unavailable without configured ports. Native
subscription execution, ambient credentials, production recovery and deployment
are not enabled.
The older closed Run API returns `execution_run_profile_required` for this profile;
use ModelStep read/control ports. Public metadata never carries operational authority.

The [broker bridge](../../docs/platform-plan/execution/unified-foundation/19-authenticated-broker-bridge.md)
keeps the original host/service/runner/Result finalizer in one broker process.
An additional captured invocation guard runs on the real transaction client at
current-authority and final SQL sinks; it never replaces the domain checks.
Main product assembly can explicitly install an opaque reference client instead
of a local host. Reply metadata is authenticated and then read from owner SQL.
Missing registry proofs after restart or on another replica cannot be restored
from JSON, receipts or SQL verified_binding. Production trust remains uninstalled.

## Owner model and credential settings

[Spec21](../../docs/platform-plan/execution/unified-foundation/21-member-model-settings.md)
adds `createMemberModelSettings` and closed member settings HTTP routes. The
overview and individual credential history select only safe metadata under
current member/personal scope and exact environment/client authority. Their
availability does not depend on provider, recovery or private Work policy.
The existing ModelConnection and credential-ingest commands keep their own CAS
and consent; rotation first creates an immutable replacement ModelConnection.

The portal never accepts the provider key. It uses one native form POST to the
exact HTTPS broker origin captured from the same genuine installed ingest
client. Only installed HTML documents use strict-origin referrer policy, so
the broker can require the actual main Origin without receiving paths/queries.
Model revocation retains custody records and does not delete the encrypted key.
Configured choices, custody receipts and this settings UI do not prove model
authentication, provider readiness, execution authority or production trust.
