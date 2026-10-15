# Diagnostic runtime matrix

Six separate CI hosts can each run one deterministic partition against their own PostgreSQL server. This does not change the local `runLocalSuite(..., 'runtime.full')` default four-process behavior. Each matrix invocation creates and cleans exactly one fresh nonce database through the existing owned-database helper, runs one test process with `--test-concurrency=1`, and preserves its original process report. Arbitrary files, commands, partition counts or indexes are refused.

```sh
node scripts/runtime-full.mjs --partition-count 6 --partition-index 0 --output .freedom/reports/runtime-partition-0.json
node scripts/runtime-aggregate.mjs --partition-count 6 --input-dir .freedom/reports/runtime-partitions --output .freedom/reports/runtime-full-matrix.json
```

Use indexes 0 through 5 on separate hosts. Upload each `runtime-partition-N.json` even on failure, then download the six files into one flat input directory. A fragment has schema `freedom.runtime-partition/v1` and check ID `runtime.partition.N`; it cannot represent a full-suite pass. Both its outer and nested cleanup flags must be true for acceptance. Failed artifacts remain intact and are never overwritten by aggregation.

The producer snapshots the actual Git HEAD and full selected source manifest before execution and again after cleanup, rejecting tracked-tree changes. The manifest contains sorted `{path,source_sha256}` entries for all current full-suite files, including the closed baseline; deterministic partition membership uses the reviewed static scheduling weights in `partitionRuntimeFiles`, assigning estimated longest files first to the least-loaded partition with index tie-breaking. The current weights are per-file minimum serial durations from complete file-progress segments of the October 9 disk rehearsals: all six partitions of run 38000643429 and partitions 0, 2, 3 and 5 of run 38003118152. Both full runs remain unsuccessful: the first failed cleanup; the second timed out partitions 1 and 4. Timing observations never turn those results into passes. The parser still rejects an incomplete final segment; the two timed-out segments are not inputs to the generated weights.

The previous October 7 weights covered 247 files and estimated each current partition at about 545 seconds. On the October 9 candidate, partitions 1 and 4 reached the unchanged deadline with only 51/54 and 52/54 files completed, respectively; all six cleanup proofs succeeded. The new generated fixture covers 320 measured files, rounded up to whole seconds (at least 1). All 323 candidate files remain selected, with the three unmeasured files retaining the 10-second default. Their estimated six loads are 752–753 seconds. Estimates require a fresh coherent hosted run; they are neither throughput guarantees nor acceptance evidence. No runner, case, file, cleanup, partition deadline or aggregate-window requirement changed.

Regenerate from the ten original job logs (retain failure results separately):

```sh
node scripts/ci/derive-runtime-weights.mjs --root . \
  --note "Complete file-progress segments: disk rehearsal38000643429 partitions0-5 and38003118152 partitions0,2,3,5 (2026-10-09); both runs are unsuccessful." \
  --output packages/contribution-tools/runtime-file-weights.mjs \
  --costs-output packages/contribution-tools/test/fixtures/runtime-hosted-costs-disk-20261009.json \
  --log <complete partition log> ...
```

Historical October 7 cost fixtures remain unchanged; their earlier hotspot and four-partition regression bounds still pass with the new weights. The current disk-fixture test uses the existing 900-second six-partition and 1,200-second legacy four-partition capacity. This does not claim that a local four-process full run has acquired the legacy matrix budget.

Each process retains the original sorted file order. Unknown files receive the same default weight and remain mandatory; file counts need not be equal. Producer, aggregate and local full runner import the same candidate implementation, not a separately installed timing registry. New selections change the manifest and must be rerun together. Untracked build output does not imply a tracked source change.

## Current queue capacity and attempt isolation, 2026-10-15

Six-partition aggregation now permits a 10,800-second (180-minute) wall span:
six existing 1,500-second partition budgets plus 1,800 seconds of queue gaps.
The partitions may therefore run sequentially when hosted capacity is busy.
Each partition still has its 1,500-second absolute execution/provisioning budget
and 24-second cleanup reserve; each Actions job still times out at 40 minutes.
The four-partition 1,200 / 1,800-second limits and local full-suite runner are
unchanged. Queue allowance never grants an individual test process more time.

Run `38695036914`, attempt 1, demonstrated the previous scheduling assumption
was invalid: partition 3's runtime step began at 07:08:57 UTC, partition 5
finished at 07:54:49, and partition 0 did not begin until 07:59:29. This already
exceeded the old aggregate window despite successful individual partitions.
These are job-step observations, not a passing full-suite result. The original
run retains its original checks and cannot be repaired by changing this source.

CI uploads `runtime-partition-<run_attempt>-<index>` and downloads only
`runtime-partition-<current_run_attempt>-*` from the current workflow run.
The six inner JSON filenames remain unchanged. A failed-only retry cannot
borrow earlier-attempt passes; missing current-attempt fragments fail closed.
After a runtime or aggregate failure, rerun all six partitions together (the
complete workflow), never splice artifacts across attempts. Aggregate diagnostic
artifacts also include the attempt, preserving previous failures without name
conflicts. All six fragments still require the exact candidate and source
manifest, complete file/case union, individual deadlines and verified cleanup.

The v1 JSON remains diagnostic, candidate-controlled evidence: it does not
authenticate a GitHub attempt. Same-run/attempt isolation belongs to the CI
artifact transport above. Synthetic regressions check sequential 150-minute
capacity, the 180-minute boundary and one millisecond over, alongside unchanged
partition/four-partition rejections; workflow regressions require attempt-scoped
uploads/downloads without cross-run overrides. Hosted verification remains
required, and a queue exceeding the finite allowance still fails.

## Earlier partition capacity increase, 2026-10-15

Six-partition invocations now have a 1,500-second absolute budget, including
provisioning and the unchanged 24-second cleanup reserve. The 40-minute CI job
timeout and 2,400-second aggregate window remain unchanged. Four-partition
limits stay at 1,200 / 1,800 seconds; local full-suite behavior is unchanged.

PR #680 at head `93c6dc3f` used candidate and runner `79ecb76e`. In run
`38675206937`, partition 3 first completed all 62 files and 888 cases in
1,034.944 seconds of test progress, then failed database cleanup. Attempt 2
completed 55 files and 830 cases before the whole-process timeout; cleanup
passed. The same 55 file hashes took 956.817 seconds of measured file work
in attempt 1 and 1,146.151 seconds in attempt 2, about 20% longer. Of these,
54 files were slower. The next file previously needed 46.702 seconds but had
only about 26.5 seconds left. This supports a capacity limit, not an observed
individual test hang. Both original attempts remain failed.

Using the faster original durations for the seven unfinished files gives a
1,224.308-second completion projection, already above the former test budget.
Allowing the observed 20% variance for that tail still leaves about 236 seconds
within the new 1,476-second test allowance, before provisioning cost. This is
finite scheduling headroom, not a completion guarantee. No files, assertions,
case requirements, weights, cleanup checks or process termination rules change.

The aggregate still rejects fragments whose earliest start to latest end is
over 40 minutes. If a failed-only retry would exceed that window, run the full
six-partition matrix on one immutable candidate instead. The observed mixed
attempts spanned 86 minutes 29.418 seconds and could not pass aggregation even
if the retried partition passed. This capacity fix requires one fresh complete
matrix on the reviewed new candidate; its result cannot turn the original
head's failures into success. Delayed cross-attempt reuse needs a separately
reviewed identity and selection rule; the current v1 format does not provide it.

Existing matrix regressions retain all source, union, case and cleanup
rejections, plus the four-partition limits. Six-partition boundaries now accept
1,500 seconds and reject one millisecond more, while the 2,400-second aggregate
boundary and a delayed failed-only fragment remain rejected when exceeded.

## Historical capacity change, 2026-10-10

The October 10 source gave six partitions 1,200 seconds each and a 2,400-second aggregate window. Legacy four-partition limits remained 1,200 / 1,800 seconds; the local full-suite default was unchanged. At that time, the installed `fa2fcdef` runner still used six-partition 900 / 1,800 seconds until a separately reviewed trusted-source rollout. That source change did not update the workflow pin, ruleset, permissions or runner hardware.

Evidence: [run 38043467019](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/38043467019) completed all six runtime partitions with final test-progress elapsed times 813/678/866/842/859/841 seconds. [Run 38046517453](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/38046517453) recorded 575/timeout/590/848/576/677 seconds. Its partition 1 completed 51 files with zero failures and verified cleanup; those same source hashes took 665 seconds previously and 865 seconds this time. The remaining tenant-policy-operator file previously completed in 6.17 seconds. These are hosted timing observations, not a passing result for the timed-out run or a throughput guarantee.

The unchanged 24-second cleanup reserve left roughly 875 seconds for tests. The prior 866-second completion had little headroom. A 1,200-second fragment leaves approximately 310 seconds beyond that observed test duration after the reserve, while remaining finite. The six-partition aggregate window keeps the same two-fragment-budget allowance for one coherent run. Weight-only rescheduling was insufficiently robust across the two observations; no scheduling weights, historical cost fixtures, file selections or case expectations are changed here.

`runtime-full.mjs` accepts `--partition-count 4` or `6`; `runtime-aggregate.mjs` defaults to four. Producer and aggregate share the partition budget. The producer still provisions one owned nonce database, runs one serial test process, reserves cleanup time and verifies cleanup before success. The aggregate independently recomputes current HEAD and the full manifest and requires distinct indexes, exact source/candidate identities, deterministic file and case unions, nonempty complete counts, zero failures/skips/cancellations/todo, unique case identities and verified cleanup. Missing or malformed JSON and noncanonical UTC timestamps fail. Both each fragment's duration and the whole earliest-start/latest-end span are checked. Delayed failed-only reruns cannot splice in fragments outside the applicable aggregate window.

Boundary regressions accept exactly 1,200 seconds and reject 1,200 seconds plus one millisecond for six-partition fragments; they accept exactly 2,400 seconds and reject 2,400 seconds plus one millisecond for the six-partition run. Existing four-partition and missing/source/cleanup/case rejection tests remain in place. Hosted verification on the proposed trusted runner remains required; local synthetic fixtures do not establish real runtime throughput.


The combined evidence digest hashes the six complete fragments ordered by index; individual original output hashes remain separately available. This is diagnostic candidate-controlled evidence, not authenticated supervisor evidence. All aggregate results retain `gate_enforced:false` and `merge_authorized:false`; this tool supplies no installed App gate, deployment approval or provider access. Local negative tests use synthetic reports and do not prove actual full-suite execution or hosted throughput.
