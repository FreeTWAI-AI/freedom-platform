# Local migration operator installation

C5b adds two real local entrypoints to the same migration executor:
`scripts/migrate-installed.mjs` and `runInstalledMigrations(pool, options)` for
an external operator wrapper. The existing `db:migrate` path still selects the
legacy manifest profile, keeps its `Promise<void>` API and delegates to the same
`packages/db/migration-runner.mjs`. There is no second SQL execution algorithm.

This is a review candidate, not an update of the live private operator pipeline.
Historical inspected restore/bootstrap wrappers imported a pinned repo
`migrate()`; their old source paths have not been changed. This operator and
preflight still select the legacy scanner. The release-compatibility library
also implements host profile v3 for exact digest sets; this entry does not
select it. DAG installations additionally refuse any
target whose database and schema do not start with `fp_`. This is a compatibility
fence for isolated tests, not proof that a name or database is authorized.
Formal DAG deployment requires the separately reviewed release-floor transition.
Legacy 117/118/119 may still be added by their assigned owners; 116 is not frozen
as a permanent frontier.

## Host-owned source and pins

Load `migration-operator.mjs` from independently reviewed operator tooling,
never a candidate-controlled module. Call `prepareMigrationInstallation` with
an exact source commit, an explicit host-selected profile and an installation
parent outside the candidate repo. The candidate must be a clean checkout of
that exact commit. The adapter compares regular source files to Git blobs,
refuses alternates/grafts, and snapshots the three-file runner closure, SQL
catalog and source package lock into a new private directory. Source/core bytes,
profile, plan and full ledger digests are recorded.

The returned hashes are **not self-approval**. The host separately reviews and
stores the expected installation digest, source commit and profile digest.
`runInstalledMigrations` requires all three; an installation's own JSON cannot
choose them. The host also supplies the existing pool and exact database,
session role and schema target. No secret/config file is read by this adapter.
The source package lock is provenance only: the caller remains responsible for
its independently installed Node/pg driver and operator tooling. This packet
does not certify a runtime cache or establish a new release authority.

At execution the adapter checks every installed byte and refuses extra files,
links, changed source/profile and absent pins. It imports the verified runner
closure from a fresh private copy, with SQL strings already captured. The
transaction validates target and complete applied-ledger closure, sets the DAG
protocol setting only for an admitted DAG profile, executes pending nodes,
verifies the final observed ledger, then commits. Any mismatch rolls back.
Ledger reads are bounded at 4,097 rows; a catalog supports at most 4,096 files.

The operator invokes the repository CLI with its independently held pins:

```sh
node scripts/migrate-installed.mjs \
  --installation /operator/installed/migration-install-EXAMPLE \
  --expected-installation <host-pinned-sha256> \
  --expected-source <host-pinned-commit> \
  --expected-profile <host-pinned-sha256> \
  --database fp_owned_validation --role postgres --schema fp_owned_case
```

`DATABASE_URL` must be supplied through the existing private host environment;
there is no fallback to the ordinary local database. Launch the reviewed CLI
with a sanitized Node environment, without candidate NODE_OPTIONS, preload or
lookup paths. An external wrapper can instead hold these pins as constants and
pass its existing pool directly to `runInstalledMigrations`. Fixed host inputs
are the trust boundary; arbitrary JSON/command-line values are not authorization.
Receipts contain source/profile/installation/ledger digests and applied names,
never SQL or credentials, and always state `deployment_authorized: false`.

## Verification and limits

```sh
node --test deploy/cloudflare/test/migration-operator.test.mjs
node --import tsx --test tests/integration/migration-entrypoints-postgres.test.ts
```

The second command owns a network-none PostgreSQL 18.6 container and uses
synthetic Git branches, real merges in both orders, external installation
directories and actual Node subprocesses for both entrypoints. Both A→B, B→A
and empty replay produce identical SQL data, constraints and canonical ledgers.
It checks rerun/no-op, exact error codes for target/unknown-ledger/digest/pin
failures, and atomic rollback after an unexpected final ledger. Create intent
and ownership labels handle unknown Docker acknowledgements; unresolved cleanup
fails and preserves the socket/intent for reconciliation.

These tests demonstrate two local entrances into one executor. They do not
claim a live private helper upgrade, cloud migration, production rollback, or
that host profile v3 is installed on this operator path. UF:INT-23 still needs
those applicable operator and release integration receipts before formal v2
naming opens.
