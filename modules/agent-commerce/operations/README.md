# Commerce host operations

`readCommerceSettings` defaults console/checkout/quarantine off and accepts only
exact `true`/`false`. FREEDOM_COMMERCE_CONSOLE_ENABLED=true requires
FREEDOM_GUILD_LAUNCHPAD_ENABLED=true; checkout=true requires console=true. The
parser always sets consoleEnabled; its optional type keeps older fixtures
compatible, and absence is off. Worker/deployment readiness applies the same
commerce_launchpad_required and commerce_console_required dependency errors. `providerProfiles` is empty
unless `FREEDOM_COMMERCE_PROVIDER_PROFILES` lists implemented IDs, comma-separated
without whitespace, empty entries or duplicates. Only `ecpay.aio.credit.v1` is
implemented. Invalid configuration fails readiness with a fixed value-free code.
A nonempty Worker list requires a usable credential keyring and COMMERCE_JOURNAL
R2 binding; Node refuses a nonempty list because it has no journal binding.
Only the local E2E host installs memory storage and a fixture gateway.

Production wiring installs store admission and, when configured, the payment
port. Shipping, policy and commerce email adapters remain absent. Admission
requires an unrevoked row in the current `providerEnvironment()`, every capability
registered by storefront 1.1.0 and an active payment service whose profile the
host lists. An empty profile list refuses admission. A 1.0.0 store needs its
owner upgrade first. Lifecycle lock waits recheck admission before creation.
Retained order reads, seller obligations and machine hold expiry continue when
checkout is disabled. Console=false leaves all seller checkout/case routes on
the JSON 404 catch-all. Console=true mounts them inside the launchpad member
boundary; it grants no capability itself. Quarantine keeps seller reads available
and refuses every seller write and on-demand query with commerce_quarantined.

Independent active platform admins admit/revoke stores only in their community.
An admin with any active membership in the tenant cannot decide either command.
Receipts retain the decision; revocation is final and re-admission creates a new
row. Reasons are bounded operational notes, never personal data or credentials.
There are no seed admissions or body-selected provider environments.

## External-effect journal

`journal/journal.ts` defines `EffectJournalPort` and strict allowlisted records.
The host environment is local/staging/public. The key is
`<environment>/<yyyy>/<mm>/<dd>/<kind>/<id>` from the occurrence's UTC date;
the body is sorted canonical JSON with application/json content type. Only
identifiers, trade/amount/currency, purpose/profile, state, credential-version and
release metadata are accepted. No personal data or key material enters the log.
The R2 adapter conditionally creates with `etagDoesNotMatch: '*'`. An existing
identical object is an idempotent success; different bytes give journal_conflict.
Other failures give journal_unavailable. Errors never contain record data.
The in-memory adapter has identical semantics and is test/E2E-only.

Setup commands append `commerce_control_events` in their domain transaction.
Their immutable detail excludes credential fields, fingerprints, routing refs
and request bodies. `flushControlEvents(pool, journal, {eventIds?, limit})`
appends control.<kind> outside a database transaction, then fills journaled_at
once. Account and admission routes try it after commit, preserving the command
response on failure and logging only a fixed name. Activation-payment routes do
not flush; their confirmation control event waits for the scheduled pass. The scheduler backfills
unjournaled rows independently. Each failed row logs only its event ID and a fixed
reason, then later rows continue. Flush returns written/failed counts; a poison
record remains available for a later retry without blocking unrelated controls. Payment handoff requires its own journal append
before token consumption; journal failure leaves the link available for retry.

## Scheduling and provider entry paths

`due-work.ts` maintains the non-PII cross-tenant `commerce_due_work` schedule:
`payment_query` targets an attempt to query, and `payment_window_end` targets its
60-minute confirmation deadline. `scheduleDueWork` upserts by kind/target using
LEAST, so an earlier request wins and a retry never postpones work. `runDueCommerceWork` claims at most 200 due rows cross-tenant with
`FOR UPDATE SKIP LOCKED`, gives them two-minute leases and commits before dispatch.
Each handler binds and validates its own tenant in separate transactions; queries
extend their attempt lease to 60 seconds and make the external call only after
commit. The exact lease timestamp is the ownership token. The claim filters to the
handler table’s kinds, leaving other kinds available for a newer binary. The executor stops after 50
external calls or five minutes and releases unstarted claims. Errors log only
kind and a fixed code. Finished rows are deleted; `failure_count` tracks consecutive
indefinite results separately from total runs and `last_query_at` tracks calls.
A query needs transport/keyring, but no listed profile or active service, so old
payment responsibility can still reconcile. The tenant/instance must be active.
HTTP 403 waits 30 minutes on that account's payment service only.

Notifications and recorded browser returns queue targeted execution through
`PlatformRuntime.afterResponse` after their scheduling transaction commits. Each
work item has a 25-second bound. The Worker gathers them in `ctx.waitUntil`, waits
with `Promise.allSettled`, then ends its pool. An abandoned timed-out query leaves
its lease for cron recovery. Node runs detached with fixed-name failure logging;
tests can install an awaitable collector. The hook spends no notification budget.
Quarantine and absent transport/keyring suppress it. The ten-minute cron is fallback.
Queries write verified inbox facts, never an external-effect journal record.

`provider-entry-paths.ts` recognizes exactly the payment callback POST and the
browser-return POST with lowercase 26-character account refs. The platform gate
retains Host checks while skipping Origin, JSON and cookie/session processing
for those two machine entries. Other methods under their prefixes return 404.
Budgets live in checkout's constants table and commit in separate short
transactions; browser-return exhaustion suppresses writes while preserving the
verified redirect. The pre-verification notification allowance is keyed by
account and network, so one network cannot exhaust another sender’s budget. No provider source-IP allowlist is assumed.

Quarantine stops new commerce effects, the hold sweep, deferred payment
application and control-event backfill. Verified callbacks still retain their
inbox facts for ordered replay. When quarantine is off, the Worker runs deferred
payment application before the hold sweep, then due work, then the journal flush, with independent
fixed-name error handlers. A failing deferred event logs only its ID and skips
later events of that attempt in the run while other attempts continue. The result
reports applied/failed/skipped counts; partial failures receive a fixed Worker log.
Settlement also retains holds protected by unapplied
verified paid notifications or query results, so placements cannot release them before recovery.
See [payment confirmation](../payments/README.md) for slot/backoff, window-end and
automatic cancellation rules.

Release capabilities commerce.hosted-checkout.v1 (168) and
commerce.hosted-payment.v1 (169) are mandatory for planned or retained schema
floors; they grant no payment, email, invoice or deployment authority. See
[EC-SPEC-10](../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md)
and [EC-SPEC-09](../../../docs/platform-plan/execution/commerce/EC-SPEC-09-security-ci-tests.md).
