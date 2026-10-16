# Disabled worker-unit routing proposal

This is a small **offline proposal model**, not an installed CI controller.
`worker-unit-routing.mjs` is not imported by a workflow, CLI or consumer export.
Its `enabled` argument defaults to false; even `true` only produces data marked
`executionAuthorized: false`. It cannot read credentials, call providers, publish
checks, update refs or run candidate code. All current GitHub checks and provider
permissions remain unchanged. No CircleCI run is requested by this increment.

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
unknown dispatch. Cross-cycle deduplication/carry-forward is an activation gap.

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
That is **not a dispatch instruction**: a future adapter must atomically record
and deduplicate a separate GitHub fallback attempt before executing it; that
adapter is intentionally absent. Never classify an ordinary failed/timeout suite
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
No network adapter or writer is installed here.

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
4. Implement/test bounded authenticated ref/dispatch/reconciliation adapters,
   lost acknowledgements, cross-cycle carry-forward/deduplication, terminal
   evidence provenance, and atomic fallback-attempt ownership. Do not promote
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
node --test packages/contribution-tools/test/worker-unit-routing.test.mjs
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
