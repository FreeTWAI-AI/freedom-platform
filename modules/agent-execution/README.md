# Closed member Run records

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
The member Actor must come from the existing trusted member authentication path;
the service still revalidates current user/session/principal/personal scope.
An Actor-shaped object or the returned DTO is not standalone authentication.

The DTO is `{runId, workId, inputWorkVersion, aggregateVersion, state,
taskLeaseEpoch, controlEpoch, operational_authority:false}`. It is NOT a complete
execution `RunSnapshot` and cannot enter an operational adapter as a permit.

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

## Transactions, replay and revocation

Commands reuse `scopedMemberCommand` and `scopedJournal`, preserving the existing
member receipt namespace and current authorization-before-replay ordering.
Lock order is current member/session/principal/scope → receipt advisory → Work
→ Run (for existing records) → policy (create only). Run identity is looked up
first without a lock solely to resolve the immutable Work lock order. It never
escapes before full owner/Work/Run authorization. Scope SHARE locks are not
upgraded. No network or object I/O occurs anywhere in these callbacks.

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
are unchanged. HTTP/UI, credentials, actual model choice, runtime proofs,
Attempt/Grant backing, external recovery authority and deployment remain absent.
