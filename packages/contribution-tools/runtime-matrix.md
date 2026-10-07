# Diagnostic runtime matrix

Six separate CI hosts can each run one deterministic partition against their own PostgreSQL server. This does not change the local `runLocalSuite(..., 'runtime.full')` default four-process behavior. Each matrix invocation creates and cleans exactly one fresh nonce database through the existing owned-database helper, runs one test process with `--test-concurrency=1`, and preserves its original process report. Arbitrary files, commands, partition counts or indexes are refused.

```sh
node scripts/runtime-full.mjs --partition-count 6 --partition-index 0 --output .freedom/reports/runtime-partition-0.json
node scripts/runtime-aggregate.mjs --partition-count 6 --input-dir .freedom/reports/runtime-partitions --output .freedom/reports/runtime-full-matrix.json
```

Use indexes 0 through 5 on separate hosts. Upload each `runtime-partition-N.json` even on failure, then download the six files into one flat input directory. A fragment has schema `freedom.runtime-partition/v1` and check ID `runtime.partition.N`; it cannot represent a full-suite pass. Both its outer and nested cleanup flags must be true for acceptance. Failed artifacts remain intact and are never overwritten by aggregation.

The producer snapshots the actual Git HEAD and full selected source manifest before execution and again after cleanup, rejecting tracked-tree changes. The manifest contains sorted `{path,source_sha256}` entries for all current full-suite files, including the closed baseline; deterministic partition membership uses the reviewed static scheduling weights in `partitionRuntimeFiles`, assigning estimated longest files first to the least-loaded partition with index tie-breaking. The weights are per-file minimum serial durations across four hosted runs 37555767674, 37557794766, 37559364439 and 37567098443, rounded up to whole seconds (at least 1). Unmeasured files receive the 10 s default. To regenerate weights, download each partition job log of recent green runs, keep the freedom.test-progress lines, and run:

```sh
node scripts/ci/derive-runtime-weights.mjs --root . \
  --note "Hosted runs 37555767674, 37557794766, 37559364439 and 37567098443 (2026-10-07), four serial partitions each." \
  --output packages/contribution-tools/runtime-file-weights.mjs \
  --costs-output packages/contribution-tools/test/fixtures/runtime-hosted-costs-20261007.json \
  --log <partition log> ...
```

Each process retains the original sorted file order. Unknown files receive the same default weight and remain mandatory; file counts need not be equal. Producer, aggregate and local full runner import the same candidate implementation, not a separately installed timing registry. New selections change the manifest and must be rerun together. Untracked build output does not imply a tracked source change.

`runtime-full.mjs` accepts `--partition-count 4` or `6`. `runtime-aggregate.mjs` without `--partition-count` means four partitions, which is the form the ruleset-pinned workflow uses until the central pin upgrade. The aggregate independently recomputes current HEAD and the full manifest. It requires distinct indexes, exact source/candidate identities, exact deterministic file and case unions, complete nonempty per-file counts, zero failures/skips/cancellations/todo, unique case identities and verified database cleanup. Missing or malformed JSON, including duplicate keys, fails. All UTC timestamps must be canonical. Each fragment, including producer provisioning and cleanup, must fit its own partition budget, and the aggregate rechecks every fragment's span. The budget is an interim 1,200 seconds: four 900-second partitions no longer fit the suite on slower hosted runners, and the budget returns to 900 seconds once six partitions run under the upgraded central pin. The 1,800-second window ties the fragments to one coherent run, so queue time does not count against a partition's budget, but a run whose whole span exceeds 1,800 seconds still fails even when every fragment passes.

The combined evidence digest hashes the six complete fragments ordered by index; individual original output hashes remain separately available. This is diagnostic candidate-controlled evidence, not authenticated supervisor evidence. All aggregate results retain `gate_enforced:false` and `merge_authorized:false`; this tool supplies no installed App gate, deployment approval or provider access. Local negative tests use synthetic reports and do not prove actual full-suite execution or hosted throughput.
