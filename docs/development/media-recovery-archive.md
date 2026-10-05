# Verified media recovery archives

The operator APIs in `packages/media-migration/backup-archive.ts` bind one completed `createConsistentAssetBackup` result to an immutable recovery-set manifest. They do not install a schedule, change GC policy, enable a feature, or approve a cutover.

The sequence is:

1. Run `createConsistentAssetBackup` with an explicit target, maintenance port, source/backup object stores and a trusted `DatabaseSnapshotWriter`. That writer must use the supplied `pg_dump --snapshot` and schema, persist the custom-format dump, and return its exact size/digest. Set `snapshotEvidence: true` to collect table evidence.
2. Pass the result, a new UUID set ID, environment, creation time and `DumpSource` to `sealRecoverySet`. Dump and evidence are written create-only; the manifest is published last. Existing differing bytes cause a conflict. Source pins remain held.
3. `readbackRecoverySet` independently reads the complete dump, evidence and every backup object's bytes. A successful optional receipt is bound to that manifest digest. Receipts are operator-host records, not signatures or proof against a malicious archive writer.
4. Restore into an empty, isolated logical database with `restoreRecoverySet`. Supply a `DatabaseRestoreWriter` using `pg_restore --single-transaction --exit-on-error`; it must consume the entire digest-checked stream and abort on any stream error. The function verifies restored evidence before restoring objects. A failed attempt may leave a restored database or some objects; keep it unexposed and discard/reconcile it explicitly.

`createFileArchiveStore` provides create-only local filesystem storage in an operator-controlled directory. It rejects traversal, symlinks and nonregular files and syncs the file and final directory. It does not provide off-host replication or tamper-proof storage. Remote storage remains an explicit `ArchiveStore` implementation supplied by the operator.

Table evidence checks all table columns, counts and full-row fingerprints from the exported MVCC snapshot. Every schema sequence, including standalone sequences, is recorded separately: PostgreSQL sequence state is not MVCC, so ascending `NO CYCLE` values are lower bounds, and advancement is reported. Missing/reset/redefined sequences fail comparison; descending or cycling sequences are unsupported. Sequence-rewinding writers must be fenced by the operator during backup.

`restoredReferenceAuthorization` binds the expected restored database/schema. Choose `current_authority` with an assertion that checks current external deletion/revocation facts, or explicitly choose `quarantine`. Quarantine is reported as `quarantine_not_approved_for_exposure`. Snapshot rows alone do not establish current permission. The selected mode, callback and exposure are captured before asynchronous restore work; callbacks still read current authority on every invocation. A result also lists outstanding migration, ACL, grant, session/authority-fencing and cutover steps. Even `current_authority_applied` does not mean those steps have run.

Retention is a **plan only**, with no default policy:

```sh
npx tsx scripts/media-backup-retention.ts \
  --archive-dir /absolute/operator/archive \
  --now 2026-10-05T00:00:00.000Z \
  --keep-verified 2 --min-retention-hours 168 \
  --max-readback-age-hours 24 --max-sets 1000
```

Review the returned plan and digest before any separate deletion or pin release. It retains an anchor per environment/database/schema lineage and never releases a capture shared with a kept set. Unknown sets or references withhold unsafe pruning. Object pruning assumes the backup object store is dedicated to this archive. No command here executes the plan or approves a retention policy.

Run the synthetic archive drill with the existing owned-container runner:

```sh
npm run test:media-restore -- --archive-only
```

It exercises the new coordinator → seal → full readback → PostgreSQL 18 restore → native local R2 path, concurrent-write exclusion, standalone sequence evidence, current-revocation refusal, quarantine provenance and corrupt-dump refusal. The default `npm run test:media-restore` retains the existing media/ACL restore drill. Both use synthetic fixtures; neither establishes live restore, actual storage replication, GC enablement, PITR or owner acceptance.
