# Disabled worker-unit routing proposal

This is a small **proposal model and transport-injected adapter**, not an installed CI controller.
`worker-unit-routing.mjs` is not imported by a workflow, CLI or consumer export.
The model's `enabled` argument defaults to false; even `true` only produces data marked
`executionAuthorized: false`. It cannot read credentials, call providers, publish
checks, update refs or run candidate code. All current GitHub checks and provider
permissions remain unchanged. No live CircleCI run is requested by this increment. The adapter and fixed HTTP transports invoke only mocks during verification; both switches default off.

Scope is only the existing complete `ci.worker-unit` suite. The existing
`static-worker` lane still owns contracts, checks, builds, dry runs and media
restore checks as well as worker tests. Do not remove that lane. This change
avoids the browser capacity work (#796), sharding (#788), and pagination (#804).
The generated source inventory is the only shared file requiring reconciliation.

## Behavior and evidence

`createLedger` constructs a synthetic/bootstrap cycle. `proposeRoute` accepts an
exact repository/source SHA/runner SHA/suite digest/attempt binding and returns a
new ledger proposal without mutating its inputs. Repository and suite are fixed.
The reviewed cost contract includes an exact config SHA, resource class, whole-job
maximum duration and credits, and an evidence digest. Tests use invented cost
contracts; there is **no verified production cost contract** in this change.

Admission is at most 300,000 credits per cycle, with 100,000 headroom against a
controller-owned conservative remaining-credit lower bound. Outstanding **and
finished** reservations count at their full maximum. Inputs must share the same
cycle, be fresh, and leave time for the maximum job before cycle end. Unknown
quota, an outage, unsupported events/forks, or an exhausted budget select GitHub
only before any CircleCI reservation. There is no automatic cycle rollover,
credit refund, reservation expiry, or pruning. At 1,000 entries the model holds;
operators must reconcile/retain history before a separately designed rollover.
Never replace a ledger with `createLedger()` to recover capacity or erase an
unknown dispatch. The adapter retains bounded cycle history for cross-cycle ownership, described below. Automatic rollover, pruning and billing settlement remain activation gaps.

One source/suite has one provider choice; a repeated or altered attempt does not
allocate again. A CircleCI proposal starts in `dispatch_unknown`, with the full
reservation and reviewed cost contract already present. The future adapter must
persist it before the POST. An unknown POST acknowledgement, outage, controller
crash or unconfirmed cancellation retains that reservation and blocks both
redispatch and fallback. Disabling routing does not override existing attempts.

`reconcile` accepts only structurally checked **controller observations**, bound
to source/runner/suite/attempt and exact pipeline/job. It does not authenticate
those observations. Retain the full authenticated evidence outside this model;
the stored digest references it. Candidate JSON, a digest, `complete: true`, and
provider job success alone are not proof. A future adapter must compare the exact
baseline-plus-discovered file set and complete per-case evidence from the existing
pinned runner, reject omissions/duplicates/stale or contradictory results, and
establish trustworthy observation provenance outside candidate execution.

Assertion failures, suite timeout, incomplete coverage, zero tests and skipped or
cancelled cases cannot pass. Failure overrides a claimed infrastructure outcome.
Terminal results cannot be overwritten by a later success. Confirmed cancellation
remains cancelled, with no automatic fallback. Only independently reconciled
infrastructure failure or confirmed non-dispatch yields `fallback_proposal`.
That is **not a dispatch instruction** from the model. The transport-injected adapter now atomically records and deduplicates a separate GitHub fallback attempt before calling its dispatch port. The fixed HTTP dispatch construction is now implemented but is not installed or enabled. Never classify an ordinary failed/timeout suite
as infrastructure failure to get a green rerun. Reserved cost remains held even
after reconciliation; billing settlement is outside this bounded increment.

## Operational-ref investigation

The proposed ref is `refs/heads/ci-worker-unit-ledger`, containing `ledger.json`.
It has not been created. `ledgerCommitProposal` returns only bytes, their hash,
exact observed head as the **sole parent**, and `force: false`.

A future installed writer would read the current ref and bounded ledger, compute
its proposal, create immutable blob/tree/commit objects, then update the ref with
`{sha: proposedCommit, force: false}`. Two commits based on the same observed head
are siblings; after one wins, the other's update is non-fast-forward and fails.
The loser must reread/recompute admission, never merge stale reservations or
force an update. Every transition, including reconciliation/fallback, needs the
same serialization. Ref reads and commit ancestry must be independently checked.
The injected adapter supplies this protocol to the fixed HTTP storage port; no live writer is installed here.

A timed-out ref PATCH is ambiguous. Read the ref and its retained immutable
history to establish whether this exact proposal committed; neither a timeout
nor an advanced head is proof of rejection. An acknowledged winning reservation
allows only that live owner to make its one POST. On a restart, a committed
`dispatch_unknown` row is **not permission to POST**: reconcile first. This
conservatively strands a reservation if the process crashes before dispatch;
there is no atomic transaction spanning GitHub's ref update and CircleCI's API.
Do not claim exactly-once dispatch without proving provider deduplication.

Local tests demonstrate sibling rejection using a temporary bare Git repository.
They do not exercise GitHub REST atomicity, permissions, branch protections,
network loss, authenticated CircleCI results or distributed crash recovery.
`contents:write` is repository-wide, not a ref-scoped capability. Allowlisting the
general GitHub Actions App cannot distinguish this controller from other
same-repository workflows. A ledger writable by untrusted candidate workflows
cannot enforce a trustworthy hard budget. Force-false alone is not authorization.

## Minimum separately reviewed activation work

1. Verify a distinct protected writer identity and operational-ref restrictions
   that exclude candidate workflows; prevent force updates/deletion and audit
   bypass. Install a reviewed immutable controller separately from candidate
   execution. No suitable identity/protection has been verified or enabled here.
2. Verify the actual CircleCI organization/project/pipeline and v2 personal-token
   support and minimum scope in its current UI. The newer scoped-token announcement
   and older full-access documentation differ; do not assume Admin. Provisioning,
   token storage and security-policy changes require separate approval. Never
   attach provider credentials, writer tokens or privileged contexts to candidate
   npm/build/test execution; include fork/merge-group trust handling before moving
   either event from GitHub.
3. Pin an eligible resource class in reviewed config and establish an enforceable
   **whole-job** maximum (checkout/install/build/dry runs/test/artifact overhead,
   services and cancellation latency). `no_output_timeout` is a silence detector,
   not a wall-clock limit. The historical 143-credit run is not a maximum. Prove
   a fresh conservative quota source and account for other writers/usage. Delayed
   Insights totals are not billing-grade admission evidence. Usage exports are
   asynchronous reconciliation evidence (research reported 10 creates/org/day),
   not admission locks. Do not poll exports per commit. This repository's 300k
   admission budget is not a hard organization-wide bill cap against other repos,
   manual reruns, uncapped jobs or noncompute charges. If no enforceable maximum
   and authoritative lower bound exist, leave routing disabled/on GitHub.
4. Verify the implemented HTTP transports with an approved installed identity.
   Local fixtures now cover lost acknowledgements, retained cross-cycle ownership
   and atomic fallback ownership. Live terminal evidence provenance, cycle
   creation/retention and crash recovery still require verification. Do not promote
   synthetic fixtures into provider evidence. Prove candidate isolation from the
   writer, runner installation and observation publisher; #718's runner refetch
   is not an independent sandbox against malicious candidate code.
5. Obtain exact-current-candidate worker evidence and maintainer review, then
   separately review activation and any required-check change. Preserve the full
   suite and static-worker's other duties. Remove duplicate worker execution only
   after the replacement and fail-closed aggregation are proven. No activation,
   check removal, merge or deployment is authorized by this implementation.

## Maintainer checks and historical limits

Run from the repository root with Node 24 and Git:

```sh
node --test packages/contribution-tools/test/worker-unit-{routing,dispatch,http}.test.mjs
python3 scripts/update-inventory.py
npm run verify:inventory
git diff --check
```

The test is also discovered by the existing governance suite; no workflow changes
are needed. No database, npm dependency, provider credential or network is needed
for these focused tests. Do not trigger a duplicate full CI for these fixtures.
Full platform runtime/browser checks remain required hosted evidence, not a claim
made by the local test result.

Base inspected: `3c1ff74476d4072f5a1b8b179a1bb0faecefc461`.
Fetched #718 head: `e9fd9cbdd2e40d38066fc41e42832cd7110321ed`.
The delegated historical CircleCI pipeline 2 observation was 38 files/109 tests,
143 credits and 7m07s, on candidate and runner
`1e584aa8734addfe251c7f081cf51cc84a52567f`. It is not #718 head evidence or this
branch's evidence; it was not rerun here. That pilot omits `resource_class`;
the observed Docker Large default is not a stable cost contract.


## Executable adapter slice (disabled, local transports only)

`worker-unit-dispatch.mjs` exports `workerUnitAdapter(ports, {enabled:false})`
and `createDispatchState(cycles)`. There is no CLI or ambient feature flag. With
its default switch, dispatch/reconcile/fallback return disabled without reading
or calling any port. Opting in permits calls to explicitly supplied trusted
ports. This is executable protocol logic tested with local storage/provider
fixtures, **not verified live routing or an installed HTTP integration**.

The fixed ports are:

| Port | Request / obligation |
| --- | --- |
| `read` | Read the fixed operational ref, return exact `head` and parsed `state`; bounded strict JSON acquisition must happen in the installed port. |
| `commit` | Receive fixed ref/path, complete bytes/digest, sole parent and `force:false`; create immutable objects and confirm that exact ref update with `status:committed`, matching `sha256`, and resulting commit `head`. Rejection/unknown never grants ownership. |
| `dispatch` | Receive only provider, exact worker binding and reviewed cost contract; call one fixed reviewed provider workflow/pipeline, propagate attempt identity, return acknowledged pipeline/run ID. No candidate command, URL, config branch or credential input is accepted by the adapter. |
| `observe` | Receive provider, expected binding/cost contract and known pipeline/job. Fetch authenticated provider and complete runner evidence; return a bound model observation, or `state:unknown`. A no-match search alone is not proof of non-dispatch. |

Every call receives an AbortSignal and a bounded deadline (default 5 seconds,
maximum 30 seconds). No transport call is automatically retried. A timeout can
mean that a remote write/POST completed; ports must honor cancellation where
possible, but an abort never proves non-execution. Exceptions return stable
reasons without echoing potentially credential-bearing transport messages.

Storage contains up to 12 ordered non-overlapping cycle ledgers plus a separate
GitHub fallback ledger, with at most 1,000 total attempts and 2 MiB serialized
state. Every primary source/suite has exactly one owner across **all** retained
cycles. Fallback has a deterministic distinct attempt ID, the same exact
source/runner/suite, and at most one GitHub owner. State validation rejects
fallback without its retained, reconciled CircleCI infrastructure/non-dispatch
parent. No automatic deletion or cycle creation is implemented. A new cycle
must retain all previous ownership, and unresolved CircleCI reservations in a
previous cycle block new admission rather than silently resetting the budget.
These retained ledgers do not establish billing settlement or an unlimited
archive: stop at the bounds and separately review rollover/retention.

`dispatch(input)` computes the existing route and atomically stores the
reservation/ownership before its single POST. Only the invocation receiving the
matching successful commit acknowledgement can POST; rejected or unknown commits
hold. Known provider pipeline IDs are persisted with a second atomic update.
A lost second update still cannot permit redispatch. Fork/merge-group events
return `github_native` without any port calls; existing GitHub workflows retain
responsibility for those unsupported events.

`reconcile(binding)` fetches evidence through `observe` and atomically persists
only the exact owned binding. Running observations bind the exact job. Unknown,
stale or malformed evidence does not release ownership. Terminal failures cannot
be overwritten by later success. Both CircleCI and GitHub outcomes use the same
failure classification; fallback test failure is not a successful recovery.

`fallback(binding)` requires the retained primary CircleCI state to be
`infra_failure` or `not_dispatched`. It atomically claims the deterministic
GitHub attempt, then sends once. Concurrent callers, lost commit or POST
acknowledgements, subsequent cycles and restarts cannot create a second fallback.
Cancellation alone never qualifies. An interrupted owner can strand an unknown
attempt; reconciliation is required, never a timer-based takeover. The adapter
does not request remote cancellation: cancellation evidence is reconciled through
the observation port, and cancelling the controller preserves unknown ownership.

### Exact live prerequisites requiring separate approval

- A distinct installed GitHub writer with repository **Contents read/write** for
  immutable blob/tree/commit creation and the operational-ref update. This is a
  repository-wide grant: separately approved ref rules must exclude unrelated
  candidate workflows, force updates/deletion and unintended bypass. No general
  Actions identity allowlist is sufficient evidence of that isolation.
- GitHub **Actions write** for the one reviewed fallback `workflow_dispatch`,
  plus run/job/artifact read access for reconciliation. Its fixed workflow must
  accept exact candidate/runner/suite/attempt data and execute without controller
  credentials. This PR does not add that workflow or request Checks write.
- A separately provisioned CircleCI v2 personal credential whose actual scoped
  UI/API permits the required pipeline trigger and pipeline/workflow/job/artifact
  reads with the minimum proven Read/Write scope. Admin is not assumed. Verify
  project/pipeline IDs and no attached candidate-visible provider secrets.
- An independently reviewed immutable controller installation, authenticated
  evidence acquisition and secret-free candidate execution, enforced whole-job
  resource/cost bound and fresh conservative quota source. The fixture switches
  and `assurance:transport-fixture-unverified` outputs do not grant these powers.

No credentials were created or stored, no security policy changed, and no live
provider operation was tested. The local tests verify the protocol under the
stated port contracts; they do not prove those contracts are enforced by GitHub,
CircleCI, an operating system or an external evidence publisher.


## Fixed HTTP transport slice (mock-verified, not activated)

`workerUnitHttp(config, {enabled:false, credentials, fetchImpl, verifyEvidence})`
constructs the four adapter ports. The default calls neither credential providers
nor HTTP. Tests inject synthetic strings and a mock `fetchImpl`; no real token
was accessed, stored or transmitted. Enabled construction accepts only fixed
FreeTWAI/freedom-platform GitHub endpoints and CircleCI v2 endpoints under
`https://circleci.com/api/v2`, with an explicitly verified GitHub-App-style
`circleci/<organization-UUID>/<project-UUID>` slug and pipeline definition UUID.
There is no arbitrary URL, OAuth slug guess, environment-token lookup or auth
bootstrap. The existing App publisher cannot be reused unchanged: it grants
check-publishing/read permissions, not the distinct ref writer this needs.

The Git transport reads the operational ref, then the exact commit/tree/blob;
only a one-file regular `ledger.json` tree is accepted and the blob's Git SHA is
recomputed. Existing strict JSON parsing rejects duplicate keys and malformed
UTF-8 before schema validation. Writes create immutable blob/tree/commit objects
and PATCH the fixed ref with one parent and `force:false`. An initial stale head
returns rejected; any uncertain PATCH acknowledgement stays unknown with no retry.
No ref bootstrap/creation, force update, delete or repository setting API exists.

Every request and overall port call has a deadline (default 5 seconds, at most
30 seconds), including credential acquisition, streaming JSON and evidence hook.
JSON responses are capped at 4 MB, ledger content at 2 MB. Redirects, foreign
response URLs, non-success statuses, oversized content and parse errors fail
closed. Credentials are held only for their request, sent in the provider's auth
header, never cached or reflected in errors. Provider response messages and raw
exceptions are replaced with `worker_http_unavailable`. There are no retries,
artifact-URL fetches or cross-origin credential forwarding.

Before dispatch, GitHub must resolve the configured lightweight config/workflow
tag to its separately pinned exact commit. Tags must be protected immutable by
the approved installation; the read-before-POST check is not an atomic tag lock.
CircleCI receives the fixed definition, config/checkout tag and candidate SHA,
runner SHA, suite digest and attempt parameters. **#718's existing config does
not accept all of those parameters**: a separately reviewed compatible config
must declare/validate them, pin the resource class, use the reviewed runner and
retain their source evidence. Do not point this transport at the historical
pilot and claim it is already ready for automated routing.

The current [GitHub workflow dispatch API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
documents a run ID response; a legacy 204 is accepted only as an unidentified
acknowledgement and never converted to a made-up run ID. CircleCI's
[pipeline-definition trigger](https://circleci.com/docs/api/v2/index.html#operation/triggerPipelineRun)
uses config/checkout refs and parameters. A non-created/ambiguous response is not
proof of non-dispatch. Ref semantics are documented in
[GitHub's update-reference API](https://docs.github.com/en/rest/git/refs#update-a-reference).
These docs were consulted on 2026-10-16; endpoints were not exercised live.

Observation reads only known pipeline/run IDs, verifies project/repository and
config/workflow revision, and admits only one workflow/job without pagination.
GitHub additionally requires workflow_dispatch, run attempt 1 and the exact
source/attempt run name. Missing pipeline identity, extra jobs/pages, unsupported
CircleCI revision fields or absent evidence verifier return unknown. No search
miss proves non-dispatch. A separately installed trusted `verifyEvidence` hook
must validate complete retained file/case evidence, attempt/source/runner/config
identity and authentic provenance. Its returned job must match the actual
provider job; provider failure cannot be turned into a passed suite. Metadata
alone is deliberately insufficient, so the stock transport cannot mark tests
passed or enable fallback without that independently reviewed hook.

### Fallback feasibility and remaining activation actions

`worker-unit-fallback.yml.disabled` is a concrete template under this package,
not an active workflow. It has `permissions:{}`, a default-false dispatch input
and hard `if:false`; uses public anonymous Git fetches, fixed Node/PostgreSQL,
existing build/dry-run prerequisites and `run-pinned-suite.mjs`; and never passes
controller credentials or references secrets. Source/runner/attempt inputs are
validated through environment variables, not interpolated shell commands. Here
`suite_digest` means SHA-256 of the reviewed runner's `pinned-suites.mjs` bytes;
the exact runner commit separately binds the implementation. It refetches the
runner after candidate prerequisites as the pilot does. This is **not an
independent sandbox** against malicious candidate processes. Trusted report
collection/upload is not simulated; the existing candidate-produced report
cannot by itself satisfy `verifyEvidence`. The template has not run on GitHub.

The small remaining operator decisions are:

1. Approve the distinct writer identity/ref restrictions and minimum GitHub
   Contents/Actions plus verified CircleCI token scopes; provision them outside
   candidate jobs through the installation's credential provider, not this repo.
2. Review/install immutable config/workflow tags, compatible CircleCI parameters
   and pinned cost bound, the disabled fallback template, bootstrap cycle ledger,
   and the independently trusted evidence collector. These are installation and
   evidence-trust prerequisites, not merely missing API keys. If they are not
   available, retaining native GitHub is the substantially simpler safe route.
3. Authorize a bounded same-source canary of trigger, unknown-result recovery,
   genuine failure and fallback before enabling routing. Required GitHub checks
   remain duplicated until a separate adoption review explicitly removes them.

The code is ready for this integration review, not unattended live activation.
No schedule, controller service, token, protection, workflow activation, required
check replacement or actual billed pipeline was created in this task.
