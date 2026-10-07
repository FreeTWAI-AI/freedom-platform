# Switch the existing daily backup services to the coordinator

These are portable installation and rollback instructions. The actual environment
results and installation state are recorded in the
[daily coordinator acceptance receipt](../platform-plan/execution/unified-foundation/r2-recovery-retirement-2026-10-04.md#新-daily-coordinator-與既有服務切換2026-10-05).
Use that record to distinguish manual wrapper acceptance, installed service
configuration and observed timer execution; a one-time restore alone proves none
of the later scheduling steps.

The public runner is [media-backup-daily.ts](../../scripts/media-backup-daily.ts);
its fixed sequence and private adapter types are in
[backup-daily.ts](../../packages/media-migration/backup-daily.ts).
Provider access, host unit installation and real acceptance belong to the operator.

The current services are `freedom-next-backup.service` (production) and
`freedom-staging-next-backup.service` (staging). Root's live readback recorded
04:30 and 04:45 UTC respectively, both persistent with jitter. Preserve their
actual timer definitions/readbacks; do not infer a schedule from this document.
The older tracked `deploy/staging/backup.sh` and public/staging Compose units are
retired and must not be installed for these new cloud databases.

## Operator adapter

Export one `dailyBackupAdapter` object from an explicit operator-controlled module.
The module must do no allocation or provider work at import time. The CLI requires
its absolute real path and SHA-256, the exact clean operator checkout commit, the
deployed source release, environment, logical database, schema, and existing 0700
operator-owned state directory. Adapter-entry hashing does not approve transitive
imports: keep the entire private adapter code/dependencies under operator control.
It is trusted host code, not a sandboxed plugin.

The five methods use existing ports rather than a new provider abstraction:

| Method | Required operation |
| --- | --- |
| `preflight(context)` | Return `observeMediaGcState` from the explicit source DB/schema; independently verify deployed GC remains OFF, the correct branch-qualified credentials/buckets and release, and sequence-rewinding writers are fenced. May open owned source pools/locks, but no backup/restore allocation or policy change. |
| `openCapture(context)` | Return source `pool`, coordinator `options`, persisted-dump `DumpSource`, and local `ArchiveStore`. It may prepare the maintenance port, but must not run a separate dump. The public runner forces `snapshotEvidence:true` and the requested target, then directly calls `createConsistentAssetBackup`. |
| `publishAndOpen(context, sealed)` | Publish only this sealed set and its objects without overwrite, fully download the remote copy, verify transport digest, and return distinct archive/object readers over that downloaded copy plus the publication boundary below. No local-cache fallback, HEAD-only verification, or success based only on an upload ACK. |
| `openRestore(context)` | Create a new empty owned PG18 target and private native R2 destination, return their existing restore ports. The target must have no app binding, external network or exposure. |
| `cleanup(context)` | On success or any failure, close this run's pools/processes, remove only its owned restore resources, restore GC OFF and independently observe it. Return `{gc, ownedResourcesRemaining:0}` only after actual readback. Never release pins, delete archives/backup objects, roll back revocations or touch another run. |

`context` contains environment (`production`, `staging`; `local` only for library
tests), database, schema, deployed `sourceRelease`, `operatorSource`, fresh `setId`,
`createdAt`, private `runDirectory`, and `signal`. Methods are captured/bound before
the first await. Every subprocess/network operation must have its own deadline,
respond to the signal, and kill/wait for owned children on abort. `cleanup` must
work even if preflight or openCapture failed partway; it may use only this run's
explicit context and owned-resource records.

`publishAndOpen` also returns `publication`. For a provider conditional create,
use `{mode:'provider_create_only', atomicCreateOnly:true}`. The existing REST
transport may instead use `{mode:'unique_single_writer', atomicCreateOnly:false}`:
one operator owns a private `daily-v2/{environment}/{UUID}` namespace, holds a
per-environment database advisory lock, reserves a fresh CLI UUID/private run
directory, requires remote404, persists an exclusive one-PUT intent before sending,
and never repeats a PUT after any uncertain result. A complete downloaded digest
must match. Keep key/digest/intent/readback evidence privately. This explicit
single-writer assumption is **not atomic provider create-only** and cannot protect
against a second writer bypassing that namespace ownership. The public report
retains this distinction; it does not manufacture a provider CAS guarantee.
Local recovery-set members still use the existing atomic create-only ArchiveStore.

The existing read-only backup role is not a maintenance writer. Keep the dump /
evidence reader and explicitly scoped maintenance role separate; do not add a
migrator or app writer credential to the old backup env file. The snapshot writer
must use the coordinator's `snapshotId`, database and schema, PG18 custom format,
TLS `verify-full` with the existing trust roots, complete stream digest, fsync and
atomic publication. It must never create a second independent snapshot. Restore
must consume the entire digest-checked stream with `pg_restore --single-transaction
--exit-on-error`, stopping the child on stream error. Keep pools small and serialise
the two environment jobs with one host-owned lock: both databases share the same
connection-limited cluster.

## Row security from migration 125

[Migration 125](../../migrations/125_tenant_row_security.sql) enables row security
on the tenant tables without forcing it. `pg_dump` sets `row_security = off` by
default and fails for a dump role that is neither a superuser, a role with
`BYPASSRLS`, nor the table owner. `--enable-row-security` dumps only the rows
visible to that role; without a tenant context this is not a full-data backup.

Before migration 125 is applied to an environment, the operator must confirm
that the reviewed full-data backup path for that environment can read every row
of the row-security tables. Keep the dump role's attribute readback and, after
the first backup that includes migration 125, per-table row counts from that
backup compared with counts taken by the table owner. The backup role and
adapter remain operator-managed outside this repository.

## Invoke and independently accept

Install a reviewed private wrapper at
`~/.local/libexec/freedom-daily-recovery-backup`. It accepts only `production` or
`staging`, takes one shared nonblocking `flock` for both environments, selects the
explicit corresponding adapter/DB config, changes to the immutable clean source
checkout, and executes the following command with fully expanded absolute paths
and reviewed hashes. A busy lock must fail visibly; it is not backup success.
The wrapper is also the manual acceptance entrypoint, so timer and acceptance
cannot silently use different arguments.

```sh
/ABSOLUTE/PINNED/node --import tsx /ABSOLUTE/PINNED/SOURCE/scripts/media-backup-daily.ts \
  --adapter /ABSOLUTE/PRIVATE/adapter.mts --adapter-sha256 EXACT_ADAPTER_SHA256 \
  --environment staging --database freedom_staging_next --schema public \
  --release EXACT_DEPLOYED_RELEASE_SHA --operator-source EXACT_OPERATOR_SOURCE_SHA \
  --state-dir /ABSOLUTE/PRIVATE/daily-recovery-runs
```

For production use environment `production` and database `freedom_next`; never
pass the historical `next`/`staging-next` deployment aliases as archive environments.
The CLI creates a new 0700 set-ID directory and create-only, fsynced 0600 records.
`started.json` identifies the exact source/adapter/target. `completed.json` exists
only after same-snapshot capture, sealing, complete downloaded-copy readback,
actual SQL evidence/native-object restore, GC/fence/tombstone readback and owned
cleanup pass. Otherwise the command exits nonzero with `failed.json` or
`unavailable.json`; upstream diagnostics and credentials are not printed.

First execute the exact wrapper once for staging, then production, with the old
services inactive. These are real new backups, not `--dry-run` claims. An independent
operator check must reopen the recorded remote set, match manifest/dump/evidence
digests, verify the actual restored rows/objects and quarantine, and confirm target
cleanup/GC OFF. A local JSON `passed` alone is not independent acceptance. Keep the
original services/timers and last verified archives unchanged until both exact
configurations have passed. Record environment, set/manifest/dump hashes, adapter
and source pins, actual service arguments, resource cleanup and remote readback.

SIGTERM requests cancellation and still runs cleanup when ports return. The CLI
requests abort after 20 minutes; the service has an independent 30-minute process
deadline and 120-second stop deadline. SIGKILL/host loss can prevent any finally
block. A started-only run is incomplete: reconcile its owned resources and actual
GC state before a new run. Do not infer no upload/capture effect from a missing ACK.
There is no blind retry, auto-recapture, automatic resume, or deletion here. For an
operator-authorized resume, retain and revalidate the original capture/dump/objects
and use the existing create-only seal/readback/restore APIs; never label newly
captured SQL as the old set. Old successful sets remain untouched on every failure.

## Atomic service switch, readback and rollback

Use the two reviewed drop-ins:

- [Production coordinator.conf](../../deploy/operator-backup/freedom-next-backup.service.d/coordinator.conf)
- [Staging coordinator.conf](../../deploy/operator-backup/freedom-staging-next-backup.service.d/coordinator.conf)

They reset **both `ExecStart` and `ExecStartPost`**. The current post-command runs
`offsite-daily.mjs next/staging` and expects the legacy dump naming/flow; retaining
it would fail or process the wrong dump after a successful coordinator run. No
timer unit is supplied or changed. Existing EnvironmentFile/renewal configuration
is preserved; the new adapter must explicitly select its own required authority.

1. Privately save `systemctl --user cat` for both services and timers, existing
   drop-ins and hashes, actual ExecStart/ExecStartPost, timer calendars, persistent
   and jitter settings, next trigger and enablement. Save the old private wrapper
   and pins too. Do not publish credentials or raw unit env values.
2. After independent acceptance, stop only these two timers for the short switch
   window and confirm both services are inactive. If a service is running, wait
   for its bounded completion; do not race an in-progress dump. Do not alter any
   renewal, app, media or maintenance schedule.
3. Stage each reviewed drop-in as a new file in the destination service drop-in
   directory, mode0600. Preserve any existing file at that exact name. Fsync the
   staged file, atomically rename within the same directory, then fsync the
   directory. Do not edit the base service or delete unrelated overrides. Review
   any later-sorted drop-ins before continuing; they must not restore legacy commands.
4. `systemctl --user daemon-reload`; inspect effective `ExecStart`, `ExecStartPost`,
   timeout, UMask and wrapper identity. Require exactly the new command and empty
   ExecStartPost. Compare timer files/calendars/persistence/jitter with the saved
   values. Do not accept a merely present timer as a successful backup.
5. Start each existing service manually, sequentially. Require unit result/exit0,
   a new completed set for that invocation, actual remote readback and cleanup.
   Then resume the original timers and verify their next triggers. The next real
   scheduled invocation must produce another new complete set; capture that receipt
   before saying daily automation is installed and observed.
6. On switch/readback failure, keep timers stopped, reconcile only the failed
   run's owned resources/GC state, atomically restore the saved drop-ins or remove
   only the newly installed ones, daemon-reload and verify the exact original
   commands. Resume the preserved schedules only after the fallback's existing
   disabled-GC/superset preconditions hold. Never expose a partial restored target.

This switch improves the existing host-dependent schedule; it does not move it
to an independent cloud scheduler, enable GC, implement retention, provide PITR,
approve cloud failover/cutover, or create cross-account disaster isolation. The
quarantined restore does not re-establish current owner/revocation authority.
Sequence evidence remains ascending noncycling lower-bound evidence, not MVCC.

## Verification

```sh
node --import tsx --test --test-concurrency=1 tests/runtime/media-backup-daily.test.ts
npm run test:media-restore -- --archive-only
npm run typecheck
```

The existing archive drill also exercises the daily composition with actual
PG18 dump/restore, distinct filesystem archive copies, native local R2, full
readback and cleanup. This remains synthetic local evidence, not a remote provider
or timer installation claim. Failure tests cover wrong target/GC preconditions,
partial capture, cleanup failure, changed tombstones, aborted execution and mutable
adapter references. Root retains responsibility for actual hosted installation.
