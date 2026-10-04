# Private scheduled media operator caller

The foundation profile still contains two Workers. This caller is a separately
reviewed add-on, not an implicit third Worker or permission to run backfill.
Its entrypoint is `apps/media-operator-caller/src/worker.ts`; its HTTP handler
always returns 404. The default example has no routes, workers.dev, preview
URLs or cron schedule, and `FREEDOM_MEDIA_CALLER_ENABLED:false`.

`planMediaOperatorCaller()` in `lib/media-caller.mjs` takes the closed request
`{schema:"freedom.media-operator-caller-request/v1",foundation,callerName,storeBindingId}`
and emits an unavailable admission report plus an OFF config. `foundation` must
be the existing foundation-only request; the sole service binding targets its
exact operator name and the named `MediaOperator` entrypoint. No caller DB, R2,
secret, model, broker or machine binding is installed.

For a later separately approved installation, provision the exact private
Service Binding and independently review its provider account/IAM permissions
and target readback. Install one existing `planOperatorBackfill()` output as
`FREEDOM_MEDIA_CALLER_PLAN`, with its exact digest, release, environment and store
binding ID in the corresponding caller variables. Then approve an explicit cron
and activation separately. This increment performs none of those operations.
Do not put member-supplied input into these variables or give this Worker HTTP
execution ingress. `scripts/media-backfill.ts` still does not acquire a remote
provider port; its dry-run can prepare the existing plan, which must match the
operator's current canonical SQL approval before execution.

Each platform scheduled event validates and submits exactly one bounded plan
for one of the seven existing purposes. The caller adds no retry loop and never
rewrites plans, approvals, quotas or job state. Repeated or overlapping events,
and unknown PUT/RPC acknowledgements, must converge through the existing
operator's job/intent CAS, leases and durable effect fences. A failed caller
acknowledgement is not evidence that the operator performed no work.

The operator rechecks installed target/environment/release/store/purpose and
current restricted SQL role/approval before every attempt. It does not identify
an individual caller in-method. A private Service Binding is a provider-installed
capability; control of who can install that capability remains an external
acceptance requirement, not proof inferred from config or a method name.
Cache-disabled Hyperdrive/physical branch identity, canonical policy/consent,
source retention and remote byte/ACL/restore acceptance remain required.

The native workerd fixture exercises the scheduled caller and actual named RPC
transport for seven bounded plans, OFF/tamper rejection and ambiguous response
without automatic retry. Its receiving operator is a synthetic fixture; it does
not prove real SQL approval, R2 effects or remote installation. Existing real
operator SQL/R2 fixtures remain separate. No provider deployment/activation or
real account/credential access follows from local bundle or test success.
