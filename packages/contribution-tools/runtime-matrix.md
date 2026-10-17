# Diagnostic runtime matrix

Eight separate CI hosts can each run one deterministic partition against their own PostgreSQL server (the tools still accept six and four). This does not change the local `runLocalSuite(..., 'runtime.full')` default four-process behavior. Each matrix invocation creates and cleans exactly one fresh nonce database through the existing owned-database helper, runs one test process with `--test-concurrency=1`, and preserves its original process report. Arbitrary files, commands, partition counts or indexes are refused.

```sh
node scripts/runtime-full.mjs --partition-count 8 --partition-index 0 --output .freedom/reports/runtime-partition-0.json
node scripts/runtime-aggregate.mjs --partition-count 8 --input-dir .freedom/reports/runtime-partitions --output .freedom/reports/runtime-full-matrix.json
```

Use indexes 0 through 7 on separate hosts. Upload each `runtime-partition-N.json` even on failure, then download the eight files into one flat input directory. A fragment has schema `freedom.runtime-partition/v1` and check ID `runtime.partition.N`; it cannot represent a full-suite pass. Both its outer and nested cleanup flags must be true for acceptance. Failed artifacts remain intact and are never overwritten by aggregation.

The producer snapshots the actual Git HEAD and full selected source manifest before execution and again after cleanup, rejecting tracked-tree changes. The manifest contains sorted `{path,source_sha256}` entries for all current full-suite files, including the closed baseline; deterministic partition membership uses the reviewed static scheduling weights in `partitionRuntimeFiles`, assigning estimated longest files first to the least-loaded partition with index tie-breaking. The current weights are per-file minimum serial durations from the file-progress segments of hosted runs 38968059268 and 38960147348 (October 16, the commerce candidates) and 38003118152 (October 9). No run passed: 38968059268 timed out partition 1 and failed partition 5's database cleanup, 38960147348 timed out partition 3 and 38003118152 timed out partitions 1 and 4. Timing observations never turn those results into passes. The parser rejects an incomplete final segment unless the log is named with `--partial-log`; a timed-out segment then contributes only its completed files, never the file in flight, and its counters must still match. Those historical reporters clamped `elapsed_ms` at 1,200,000, below their 1,500-second budget; saturated files have no measured duration. The current strict/partial admission rules below supersede the historical omission behavior. Run 38000643429 is no longer an input: its hosts were about 30% faster than run 38960147348 in aggregate, against 21% for run 38003118152, and a minimum across all three understated the files measured only on October 16.

The October 9 weights covered 320 files. On the October 16 candidate, 411 files were selected and the unmeasured ones kept the 10-second default, including 40 new commerce runtime files; the 39 that completed took about 1,370 seconds together. Partition 3 reached its 1,500-second deadline with 49/69 files completed. The other five passed: partitions 2 and 5 finished their files in about 900 and 970 seconds, partitions 0, 1 and 4 in 1,380–1,525. That first regenerated fixture covered 395 measured files; the other 16 candidate files kept the 10-second default. Their estimated six loads are 1,085–1,090 seconds of per-file minima. Run 38960147348's own durations, with October 9 durations scaled by 1.35 for the 20 files it never completed, give 1,244–1,342 seconds per partition under the new allocation. That assumes `commerce-provider-accounts.test.ts` takes about 40 seconds after its secret scan became one statement per scan; its weight still records the 215 seconds of the measured run. Estimates require a fresh coherent hosted run; they are neither throughput guarantees nor acceptance evidence. No runner, case, file, cleanup, partition deadline or aggregate-window requirement changed.

Historical regeneration used the eighteen job logs (retain failure results separately): the fourteen complete partitions with `--log`, and partition 1 of run 38968059268, partition 3 of run 38960147348 and partitions 1 and 4 of run 38003118152 with `--partial-log`. Partition 5 of run 38968059268 completed all 69 files before its cleanup failed, so it is a complete segment:

```sh
node scripts/ci/derive-runtime-weights.mjs --root . \
  --note "Progress segments of runs 38968059268 (2026-10-16; p1 timed out, p5 failed database cleanup after all files completed), 38960147348 (2026-10-16; p3 timed out) and 38003118152 (2026-10-09; p1,p4 timed out); timed-out partitions add completed files only. No run passed." \
  --output packages/contribution-tools/runtime-file-weights.mjs \
  --costs-output packages/contribution-tools/test/fixtures/runtime-hosted-costs-20261016.json \
  --log <complete unsaturated partition log> ... --partial-log <explicit historical incomplete or saturated log> ...
```

The October 9 command, with the ten complete logs of runs 38000643429 and 38003118152, still reproduces `runtime-hosted-costs-disk-20261009.json` exactly. Historical October 7 and October 9 cost fixtures remain unchanged. Their hotspot, maximum and four-partition bounds still pass with the new weights; the October 9 fixture no longer asserts a 15-second spread, because the weights no longer come from it. The October 16 fixture test checks six and eight partitions against the 1,500-second host budget. At about 1,630 seconds of minima per partition, the full suite no longer fits four 1,200-second partitions, so no four-partition bound is asserted for it. This does not claim that a local four-process full run has acquired the legacy matrix budget.

Each process retains the original sorted file order. Unknown files receive the same default weight and remain mandatory; file counts need not be equal. Producer, aggregate and local full runner import the same candidate implementation, not a separately installed timing registry. New selections change the manifest and must be rerun together. Untracked build output does not imply a tracked source change.

## Eight partitions, 2026-10-16

CI now runs eight partitions. Each keeps the 1,500-second absolute budget and the
24-second cleanup reserve; the aggregate permits eight budgets plus 1,800 seconds
of queue gaps, a 13,800-second (230-minute) wall span. Six and four partitions
remain accepted by both tools with their existing limits, and the local full-suite
default is unchanged.

Run 38968059268 (PR #863 head `e266c86e`, the commerce candidate after its
weights were regenerated) selected 411 files. No case failed. Partition 1 reached
its 1,476-second test allowance with 64/69 files completed. Partition 5 completed
all 69 files and 906 cases in 1,036 seconds, then failed cleanup: its `DROP
DATABASE` exceeded the 16-second read timeout. The passing partitions took
1,014, 1,367, 1,415 and 1,412 seconds, three of them within 5% of the allowance.
Many files ran far above their minima on these hosts (for example, 22 to 108
seconds and 9 to 82 seconds), so weights cannot keep six partitions inside the
budget: recomputing the six-way allocation with these weights and this run's
durations still gives a heaviest partition of about 1,430 seconds before
provisioning. The same durations give about 1,040 seconds for the heaviest of
eight partitions.

`runtime-hosted-costs-20261016.json` now covers 404 files; per-file minima total
about 6,140 seconds, about 1,027 seconds per six-way partition and 770 seconds
per eight-way partition. Each run uses two more hosted runners. These are
scheduling estimates, not acceptance evidence; the new matrix still requires one
fresh complete hosted run.

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
After a runtime or aggregate failure, rerun all partitions together (the
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

## Timing integrity investigation, 2026-10-17

The six-partition execution budget is already 1,500 seconds, but the diagnostic
reporter still clamped elapsed time at 1,200 seconds. In successful
[Verify 38994475692, partition 3](https://github.com/FreeTWAI/freedom-platform/actions/runs/38994475692/job/117285301639),
all 63 files completed, yet 19 progress records reached that old ceiling.
Ten files were affected; nine had both endpoints equal to 1,200,000 ms and would
be assigned zero measured duration (rounded to weight 1). Complete file counts
therefore did not establish complete timing evidence. The original successful
test result remains successful; only its late-file scheduling measurements are
unusable. The other five partitions' timing records did not reach the ceiling.

The reporter's diagnostic bound now matches the existing 1,500-second execution
budget for both six and eight partitions. Strict `--log` input rejects any
started/completed record at either the
legacy 1,200,000-ms ceiling or the current 1,500,000-ms ceiling, and rejects
invalid/out-of-range elapsed values. An exact natural hit on a ceiling is also
conservatively rejected because v1 records cannot distinguish it from clamping.
No incomplete or saturated partition is silently dropped from a strict refresh.

Explicit `--partial-log` preserves historical scheduling estimates: it admits
only matched completed files, omits files with either endpoint at either ceiling,
and never invents a duration for in-flight or unstarted files. Both modes reject
invalid start/end values, reversed durations and inconsistent counters. The CLI
marks partial cost output `input_completeness: partial_scheduling_estimates`,
lists the partial log names, and emits a warning. These estimates cannot serve as
a complete refresh; retain the original logs, source identities and missing-file
accounting. Historical saturated logs must now be explicitly named partial even
if their file counts were complete. Parse/validation failure (including an empty
partial segment) occurs before either existing output is overwritten.

Existing weights and their historical fixture remain unchanged. Collect complete,
unsaturated per-file evidence from a future ordinary required run, verify source
hashes and the full current eight-partition union, then evaluate a separate weight refresh.
Do not infer missing durations from zero deltas or substitute log arrival times
for the reporter's monotonic clock. Tests exercise late-file emission/decoding,
legacy saturation rejection and the unchanged failed-timeout result boundary.
This fixes measurement fidelity; no hosted speedup is demonstrated or promised.
Suite budgets, selection, case checks, cleanup, scheduling and security are unchanged.

Pre-Commerce run 39002101887 used runner/candidate `cc65d3d4` and verified
371 files across six partitions; 23 endpoints exceeded 1,200,000 ms, reaching
1,365,634 ms without clipping. It proves late timing retention, not complete
Commerce-source coverage or acceleration. Browser shards took 30.4/30.9 minutes
and remained the critical path. Await ordinary eight-partition CI on the
integrated source before considering weights or a matched whole-run comparison.
The earlier local focused 29/30 result remains a failure: the unchanged one-second
timeout fixture saw zero completed files. Controlled child-start pauses of 100 ms
and 1,200 ms under the same 1,000 ms host deadline yielded one and zero completed
files respectively, both correctly failing with test_timeout. This demonstrates
the fixture startup-scheduling dependency, not the original delay’s exact cause;
the isolated pass does not erase it. No deadline or assertion was relaxed.

## Historical capacity change, 2026-10-10

The October 10 source gave six partitions 1,200 seconds each and a 2,400-second aggregate window. Legacy four-partition limits remained 1,200 / 1,800 seconds; the local full-suite default was unchanged. At that time, the installed `fa2fcdef` runner still used six-partition 900 / 1,800 seconds until a separately reviewed trusted-source rollout. That source change did not update the workflow pin, ruleset, permissions or runner hardware.

Evidence: [run 38043467019](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/38043467019) completed all six runtime partitions with final test-progress elapsed times 813/678/866/842/859/841 seconds. [Run 38046517453](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/38046517453) recorded 575/timeout/590/848/576/677 seconds. Its partition 1 completed 51 files with zero failures and verified cleanup; those same source hashes took 665 seconds previously and 865 seconds this time. The remaining tenant-policy-operator file previously completed in 6.17 seconds. These are hosted timing observations, not a passing result for the timed-out run or a throughput guarantee.

The unchanged 24-second cleanup reserve left roughly 875 seconds for tests. The prior 866-second completion had little headroom. A 1,200-second fragment leaves approximately 310 seconds beyond that observed test duration after the reserve, while remaining finite. The six-partition aggregate window keeps the same two-fragment-budget allowance for one coherent run. Weight-only rescheduling was insufficiently robust across the two observations; no scheduling weights, historical cost fixtures, file selections or case expectations are changed here.

`runtime-full.mjs` accepts `--partition-count 4` or `6`; `runtime-aggregate.mjs` defaults to four. Producer and aggregate share the partition budget. The producer still provisions one owned nonce database, runs one serial test process, reserves cleanup time and verifies cleanup before success. The aggregate independently recomputes current HEAD and the full manifest and requires distinct indexes, exact source/candidate identities, deterministic file and case unions, nonempty complete counts, zero failures/skips/cancellations/todo, unique case identities and verified cleanup. Missing or malformed JSON and noncanonical UTC timestamps fail. Both each fragment's duration and the whole earliest-start/latest-end span are checked. Delayed failed-only reruns cannot splice in fragments outside the applicable aggregate window.

Boundary regressions accept exactly 1,200 seconds and reject 1,200 seconds plus one millisecond for six-partition fragments; they accept exactly 2,400 seconds and reject 2,400 seconds plus one millisecond for the six-partition run. Existing four-partition and missing/source/cleanup/case rejection tests remain in place. Hosted verification on the proposed trusted runner remains required; local synthetic fixtures do not establish real runtime throughput.


The combined evidence digest hashes the six complete fragments ordered by index; individual original output hashes remain separately available. This is diagnostic candidate-controlled evidence, not authenticated supervisor evidence. All aggregate results retain `gate_enforced:false` and `merge_authorized:false`; this tool supplies no installed App gate, deployment approval or provider access. Local negative tests use synthetic reports and do not prove actual full-suite execution or hosted throughput.

## Bounded nonce-backend settlement (2026-10-17, #873)

[Verify39032894806 partition0](https://github.com/FreeTWAI/freedom-platform/actions/runs/39032894806/job/117396873274)
at head602ab0 / runner bd78372e completed53 files and807 cases, then failed
cleanup. DROP lost its acknowledgement after16057ms; the exact cleaner backend
was still present after the1s termination wait, so the old single readback failed
at17265ms. PostgreSQL logged termination around18.7s; this does not establish
that the database was absent. The final checkpoint was57ms. The cleanup source
matched prior green82806434 and main4e4b9f20; no WP07-causation or checkpoint-delay
claim is supported. Original failed artifact12101472856 remains failure evidence.

After a false termination acknowledgement, the helper now rechecks only the
same PID + owner + nonce application identity, at100ms intervals with bounded
metadata queries. It sends termination once, reserves the last1000ms for fresh
positive database-absence verification, and keeps the original20s absolute
cleanup deadline /24s suite reserve. Both query configuration and read timeouts
respect that reserve. A backend still present at the settlement cutoff fails;
an absent backend alone never passes cleanup. Database presence, identity or
ownership mismatch, unavailable observation and deadline expiry remain failures.
No retry of DROP, larger budget or parsing of late server logs is introduced.

Controlled transport/clock cases exercise the actual helper: unknown DROP ACK
at16.057s, termination after18.7s, never terminating, database still present,
settlement only at19.5s and absence observed after20s. These are sequencing
counterexamples, not a native reproduction of the hosted delay. Native wait/
lock/I/O capture was unavailable locally: no PostgreSQL binary/cached container
image, and the pinned CI image pull returned Forbidden. Existing source-bound
matrix checks and ordinary required CI remain mandatory; no blind full-suite
rerun is evidence for this change.
