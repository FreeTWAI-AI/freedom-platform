# Migration plan compatibility

This is the C5a prerequisite for UF:INT-23. The repository runner, public
Cloudflare scanner and fixed supervisor fixture now use one bounded planner.
They still admit only the legacy numeric profile. No v2 SQL file is installed,
no formal frontier is frozen at 116, and the private operator/release path has
not been upgraded. Pending legacy 117/118 retain their assigned names.

`migration-plan.mjs` is pure. `migration-files.mjs` loads regular local SQL
files without following links, bounds reads and decodes strict UTF-8 while
preserving BOMs and all historical content. The runner retains its transaction,
advisory lock `2026092000`, ledger columns and SHA256(JSON.stringify(sql))
encoding. It validates every applied name/digest and dependency before running
pending SQL, including unknown or non-closed ledgers restored from elsewhere.
No database row is inferred from a maximum/latest id.

## Closed DAG profile

Only callers explicitly supplying `freedom.migrations/dag-v2` to the pure
planner can plan synthetic mixed catalogs. Repository entrypoints always
select `freedom.migrations/legacy-v1`; a candidate manifest cannot activate v2.
The DAG profile contains a host-selected exact legacy name/digest set plus its
legacy numbering/gap policy. A maximum number alone is not a frontier. The
eventual installed host must authenticate that profile and source; the pure
function does not provide installation trust or deployment authorization.

New identities have this grammar:

```text
v2_YYYYMMDDTHHmmssSSSZ_<16 lowercase hexadecimal characters>_<lowercase slug>.sql
```

The timestamp is a valid UTC date with milliseconds; the suffix is a branch
collision discriminator. Time is only a deterministic tie-break, never
causality or an applied watermark. A renamed slug with the same timestamp and
suffix is a duplicate identity. Slugs start with a letter and contain at most
64 lowercase letters, digits or underscores; full names have at most 128 bytes.

Each v2 source starts with one canonical JSON comment, followed immediately by
the exact `MIGRATION_V2_GUARD` SQL prefix exported by the planner:

```text
-- freedom-migration: {"format":"freedom.migrations/dag-v2","depends_on":["<exact dependency filename>"]}
```

Dependencies are immutable because the comment is part of the historical SQL
digest. Legacy sources receive an implicit ordered chain without editing their
bytes. Every new node must transitively depend on the entire selected legacy
frontier. Missing/self/duplicate/cyclic dependencies, changed frontier bytes,
unknown applied entries and non-closed applied ledgers fail. Topological pending
order is independent of the canonical filename-sorted ledger and its historical
digest; an earlier-sorting file merged after a later file remains pending.
The planner verifies declared dependencies, not that arbitrary SQL commutes.
Reverse-order equivalence still requires real SQL fixtures and review.

The SQL prefix refuses execution without the expected transaction-local
protocol setting. It protects against an old runner executing every SQL file;
it is not a permission boundary against a DDL owner. A legacy scanner that
silently omits v2 files never executes the guard. Complete independent planned
versus observed ledger checks and host source/profile admission are mandatory
before enabling a real v2 catalog.

Limits are 4,096 source files, 4 MiB per SQL file, 64 MiB total SQL content,
16 KiB for a metadata line and 64 direct dependencies per v2 node. Oversize,
malformed UTF-8, directory and symlink inputs are rejected, never truncated.
Pure planner outputs are immutable local data, not a trusted receipt.

## Evidence and remaining transition

Focused checks:

```sh
node --test deploy/cloudflare/test/migration-plan.test.mjs
node --import tsx --test tests/runtime/migration-runner-plan.test.ts
node --import tsx --test tests/integration/migration-plan-postgres.test.ts
```

The last command owns a disposable PostgreSQL 18 container pinned to the
existing supervisor image, with no network and synthetic data only. It tests
the real repository runner's empty replay, legacy upgrade/no-op and invalid
restored ledger rejection, plus test-only DAG SQL execution in both merge
orders, empty replay and the old-runner guard. Its DAG executor is a fixture,
not proof that a private operator entrypoint is installed. The container and
schemas are removed after the run. No private config or TEST_DATABASE_URL is
read. Public scanner tests retain exact reviewed privileged-source exceptions.

C5b must bind the actual operator wrapper and repo entrypoint to the same
reviewed source/resolver and host-selected profile, then replay both real
entrypoints. Historical inspected operator wrappers delegated to a pinned repo
`migrate()`; that is not evidence of a current installed pending-migration path.
Do not create a second SQL executor to satisfy the two-entrypoint requirement.

The current release compatibility host still accepts only numeric ledgers,
positional prefixes and numeric shape dependencies. V2 needs a separately
reviewed profile: exact digest-set inclusion and dependency closure for observed,
planned and retained floors, and exact migration identities for new shapes.
Existing target, recovery-generation, capability, approval and freshness checks
remain mandatory. Old host profiles must continue rejecting unsupported v2 data.
Restored ACL lockdown still compares the complete canonical ledger. The fixed
supervisor now includes every SQL file plus the planner, loader and migration
manifest in its installation identity; its fixture rejects unactivated files.
The full repository inventory rule remains unchanged pending C7.
