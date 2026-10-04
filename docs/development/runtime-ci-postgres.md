# Runtime CI PostgreSQL storage and cleanup

The failed f900595 runtime-full run 37168543325 exhausted its existing test deadline. Its PostgreSQL logs recorded checkpoint synchronization of hundreds of thousands of files, including a 194-second checkpoint; cleanup then hit the former two-second DROP DATABASE timeout. The artifact has no completed shard JSON results: its zero test_count does not mean no cases executed. Storage/checkpoint overhead is a supported contributor, not an independently isolated measurement of every timeout cause.

Only the disposable runtime-full GitHub service uses a bounded 4 GiB tmpfs at `/var/lib/postgresql`. The pinned PostgreSQL 18 image places PGDATA at `/var/lib/postgresql/18/docker`; mounting the earlier `/data` path would miss it. The read-only prerequisite checks the exact service ID/image, Docker tmpfs configuration, actual filesystem type/size/used space, PGDATA, and runner RAM (at least 6 GiB). Checkpoint completion target zero removes pacing on this disposable service. `fsync` and `full_page_writes` remain on. This configuration is not a persistent database or recovery recommendation.

Cleanup retains the suite's 24-second reserve and uses one absolute 20-second deadline across connections, queries, backend settlement and verification. Each DROP gets at most six seconds within that shared deadline, further divided fairly across remaining registered names while reserving four seconds for final reconciliation. Exact invocation names and owner/session identities remain required. A lost DROP acknowledgement is reconciled on a fresh identity-checked connection after settling the prior cleanup backend; success requires all registered names absent. Changed ownership fails closed and preserves the foreign database. The supplied database is never deleted.

Local verification on an owned network-none PostgreSQL 18.6 tmpfs container: existing five integration cases plus lost-ack and foreign-owner counterexamples passed 7/7; governance passed 251/251 under its original 60-second cap. The lost-ack case failed against the prior cleanup implementation and passed after the fix. Storage readback passed with the actual 4 GiB tmpfs and PGDATA; the helper's GitHub-hosted environment guard was explicitly simulated locally. These checks do not establish the remote runner's RAM, tmpfs peak use, whole-suite duration or a GitHub pass. The next actual GitHub run must supply those results. Product runtime sources and the 900-second full-suite deadline are unchanged.

The runtime-full host now defaults to four independently owned databases and four sequential test processes. Explicit shard counts remain closed to 1, 2 and 4; deterministic round-robin partitions preserve the exact selected file/case union. The disposable CI service sets and reads back `max_locks_per_transaction=256` for concurrent DDL fixtures. This is CI-only capacity configuration, not production tuning. Four shards are a throughput hypothesis; the two-shard remote run on 8c3fea1 timed out despite fast checkpoints and verified cleanup. No incomplete or partial shard report can produce a pass.

A local post-build run also exposed a distinct CREATE DATABASE timeout before any tests started. Provisioning now uses one monotonic 20-second budget for all owned names, clamped to the original full-suite deadline minus its cleanup reserve. Metadata queries retain their two-second limit; each CREATE is bounded to at most six seconds and the remaining provision budget. Names are registered before CREATE, and any failure still settles the exact owner backend and verifies deletion on a fresh connection. A real PostgreSQL 2.2-second server delay failed with the earlier metadata timeout and passes with the separate bounded DDL budget. This does not increase the 900-second suite cap.

Fixed-source `6c6918d` subsequently completed all 196 files and 2,620 cases in four 49-file shards in 297.557 seconds, with zero failures/skips and verified cleanup. The preceding six native-fixture failures remain retained; immediate targeted tests and the controlled full retry passed without source or compiler-timeout changes. The earlier raw setup cause is not adjudicated. Fifteen-second storage sampling observed at most 1,659,172 KiB of the 4 GiB tmpfs across 20 samples; this is not a continuous peak measurement. Root integration separately passed eight actual PostgreSQL cases and 266 governance cases under the original cap. This local result does not establish a remote four-shard GitHub pass.

Sources: [Docker tmpfs semantics](https://docs.docker.com/engine/storage/tmpfs/), [official PostgreSQL image PGDATA layout](https://hub.docker.com/_/postgres), and [PostgreSQL checkpoint and durability settings](https://www.postgresql.org/docs/18/runtime-config-wal.html).


Exact `2f7d633` remote run [37174100522](https://github.com/FreeTWAI-AI/freedom-platform/actions/runs/37174100522) failed. Four partitions on one runner did not establish a pass: only one finished (613 passing cases), while three exceeded the original runtime budget. Bounded progress recorded 158 completed files, 2,205 observed cases and 13 failures in six files; database cleanup was verified. These partial counts do not represent the complete 196-file/2,620-case union. The six files subsequently passed 36/36 in a local diagnostic run; their exact remote failure causes remain unverified, with no fixture lifetime or assertion changes.

The candidate workflow now runs four literal matrix indexes on four independent runners and PostgreSQL services, with `fail-fast: false`. Each producer owns one fresh database and one sequential test process. The separate aggregate downloads only the current workflow's fixed artifact names and recomputes candidate identity, tracked-source cleanliness, complete deterministic file/case union and cleanup. The earliest producer start through latest producer end must fit the same 900-second window; delayed partition starts can therefore fail the aggregate. Cancelled, skipped, missing or failed matrix jobs fail the final verification. CPU count and cgroup quota are read back on each runner rather than inferred from public runner documentation. See the [diagnostic matrix contract](../../packages/contribution-tools/runtime-matrix.md). Actual hosted matrix execution is still required; these source changes and synthetic counterexamples are not a remote pass or an authenticated App gate.


The new producer completed one genuine local partition at `27cbd7d`: 49 files,
718 passing cases, zero failures/skips/cancellations/todo, 328.551 seconds and
verified nonce-database cleanup. This is one partition, not a matrix or full-suite
pass. Failed-case diagnostics now add only an existing case hash, finite failure
classification and optional host-validated test declaration line, globally capped
at 64 records. They retain no assertion/message/stack/name/environment and never
participate in final result admission. A hang after failure preserves the bounded
diagnostic but still fails without a complete final report.


The `8e1b325` local governance unit adapter exhausted its unchanged 60-second
cap while running the existing synthetic full/subset union fixture; the failure
and partial progress remain retained. That fixture separately passed in 44.44
seconds. Its test block and all seven assertions have been moved unchanged to a
required standalone integration step in `governance-consumers`, before the unit
suite. The remaining runner unit cases passed 13/13 in 3.47 seconds. This keeps
all baseline execution/deduplication checks and does not expand any unit, runtime
or workflow deadline; the new complete unit result must be reported separately.


Remote `8ca270a` failed before runtime execution: the diagnostic CPU step assumed
`/sys/fs/cgroup/cpu.max` existed. It did not; one actual runner reported `nproc=4`.
The readback now handles v2 and both fixed v1 CPU paths, explicitly reporting an
unexposed quota when none are readable. Absence never proves an unlimited quota.
Actual local and missing-file checks both succeeded. No runtime prerequisite,
assertion, deadline or required result is waived by this diagnostic compatibility
fix; missing partition artifacts still fail aggregation.


Actual `dd3ae0e` hosted matrix completed all 196 files/2,620 unique cases in
576.165 seconds with all four cleanups verified: 2,619 passed and one failed,
zero skipped/cancelled/todo. The native prerequisite and runtime cases now pass
after the bounded observed AppArmor deleted-entry fix. The broker adversarial
final Result-INSERT expiry case is the remaining failure; its closed progress
record does not contain assertion details, so no SQL/HTTP or TTL cause is inferred.

At candidate750b808, partition one ran a fixed eight-case broker checkpoint after the native
prerequisite and before its full producer. Clean environment, explicit disposable
local `fp_` database admission, process-group 90-second/256KiB limits, bounded TAP
and strict closed JSON require exact eight passed cases and zero skipped cases.
All eight still execute in the full deterministic partition. This diagnostic
does not expand the aggregate's earliest-start-to-latest-end 900-second window
or the job's 40-minute cap. Local eight-case passes and synthetic skip/count/URL
rejections are candidate diagnostics, not a hosted failure fix or trusted gate.


The blocking checkpoint at750b808 hit its diagnostic90-second bound and prevented
one mandatory partition from starting. The next candidate removes that extra
execution and instead retains bounded FD4 failure records during the original
mandatory producer for exactly the broker-adversarial and media-verify files.
All196files and all eight broker cases remain mandatory; test-only fixture
settlement and controlled-clock corrections do not remove any assertions.

FD4 is separate from existing FD3/progress and final closed JSON. Its host-side
decoder allows only source-pinned paths, unique case hashes, finite error/cause
codes, fixed message classifications and small numeric/Boolean comparisons;
no raw messages, stacks, names, environment or object comparisons are emitted.
The independent256KiB/64-record limit never changes admission. A subsequent
hang preserves diagnostics but still fails without a full final report;65failed
cases retain all65primary records even when diagnostics cap at64. Author36/36
affected checks and independent16/16 focused cases passed, zero skips. The
required900-second global window and40-minute job cap remain unchanged.
Generated Node lines/classifications still cannot always locate literal TS
assertions; these are untrusted candidate diagnostics, not App evidence.

Actual subsequent PR head9339e27 completed Verify run37182554068 against
immutable merge checkout6204a4c7b11d03936809ffdc29940b29c0b7023e: all196files,
2,620unique cases passed, zero fail/skip/cancel/todo, four cleanups verified,
560.555seconds within the original900-second window. Root verified the four
partition archives and aggregate archive digests, exact closed source/manifest
bindings and complete unique-case union before accepting the result. The actual
broker8/8 and media13/13 passed inside that mandatory producer; no duplicate
checkpoint was required. All Verify jobs succeeded. Separate CodeQL failure,
uninstalled trusted gate and actual cloud/data acceptance remain release gates.
Earlier failures and bounded test-fixture counterexamples remain retained;
this pass does not identify the original Ubuntu assertion causes.

## PR 85–104 integration source union (2026-10-04)

The integration rebased on PR 108 `f5bede3a7fb898e6183b2f13e6bd93583cea9669` adds four runtime source files to that upstream snapshot: `chat-content.test.ts`, `member-card-qr.test.ts`, `member-session-lifecycle.test.ts`, and `direct-message-receipts.test.ts`. The current union is **200 files**, dynamically divided into four **50-file** partitions. Historical 196-file / 49-file evidence above remains evidence only for its recorded upstream source; it is not a result for this candidate. The full-suite file-set, unique-case, deadline, cleanup, and zero-failure requirements are unchanged.
