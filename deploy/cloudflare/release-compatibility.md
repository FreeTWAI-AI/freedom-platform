# Local release compatibility and rollback floor

`preflight.mjs compatibility` checks a bounded source/schema/data-shape matrix.
It does **not** authenticate evidence, approve a release, observe a live database,
prove a backup or restore, or authorize deployment, cleanup or execution.
There is no production capability approval record checked into this slice.

```sh
node deploy/cloudflare/preflight.mjs compatibility --compatibility-input /path/to/request.json
node deploy/cloudflare/preflight.mjs all --compatibility-input /path/to/request.json
node --test deploy/cloudflare/test/release-compatibility*.test.mjs
```

An ordinary CLI invocation has no trusted host port and returns `unavailable`
(nonzero exit), even if candidate JSON claims it is approved. `all` runs this
check only when its input is explicitly supplied; a requested unavailable or
incompatible result fails `all`. Existing `all` without that input makes no
compatibility claim. `--execute` remains refused. No network or database is read
by this check, and it never imports or executes a file named in the request.

## Inputs and authority separation

The request file is strict UTF-8 JSON, at most 16 KiB, with duplicate keys,
symlinks, nonregular files, unknown fields and unsupported shapes rejected.
It contains exactly:

```json
{
  "schema": "freedom.release-compatibility-request/v1",
  "environment": "next",
  "candidate": {
    "source_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "artifact_sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  },
  "enable_shapes": []
}
```

Those identities are a request, not proof that a local checkout produced the
artifact. A fixed, independently trusted host calls
`evaluateReleaseCompatibility(request, { scan, host })`, or invokes
`run(argv, { compatibilityHost: host })` from the existing preflight module.
The latter always obtains `scan` through the existing repository migration
scanner. There is deliberately no CLI flag, environment variable, JSON field
or dynamic adapter import that constructs `host`.

The host is trusted **by the caller's contract**, not self-authenticated by its
`schema`, `evidence_id`, matching digests or this library. A privileged integration
must pin its own evaluator/reader and approve source-to-artifact provenance and
capability evidence outside candidate control. Calling the exported function
with fabricated host data can produce a fabricated *local diagnostic*, never a
deployment permit. Authentication/observation transport and the operator's real
release helper remain integration gates; this slice does not inspect that helper.

The host data has these exact fields (arrays are bounded and contain no duplicate
values; identities and schema rows have the same structure as the request/scanner):

| Field | Required meaning |
| --- | --- |
| `schema` | `freedom.release-compatibility-host/v1` |
| `target` | `{environment, database_identity, recovery_generation}`; environment is `next` or `staging-next`, database identity is an opaque nonsecret ID, generation a positive decimal string |
| `now_ms`, `max_age_ms` | trusted host time and explicit observation freshness bound, at most 300,000 ms; candidate clock is not used |
| `rollback_floor_shapes` | independently retained historical shape watermark; never erase this just because a feature is disabled or a DB snapshot is restored |
| `observation` | complete current observation described below, from an independently authenticated reader |
| `release_records` | independently approved or withdrawn exact source/artifact capability records, described below |

`observation` contains exactly `evidence_id`, `observed_at_ms`, `target`,
`schema_ledger`, `schema_ledger_digest`, `enabled_shapes`, `written_shapes`,
`active_releases`, and `complete: true`. Its target must exactly match the host
target, including the externally maintained recovery generation. Future, stale,
incomplete and empty-active-release observations are unavailable. Every consumer
still able to access this database must appear in `active_releases`; do not omit
an older Worker, cron, helper or reader to make a rolling deployment pass. This
v1 intentionally cannot certify an empty/incompletely observed environment.

The host must collect a consistent observation and maintain durable historical
shape watermarks. The evaluator cannot detect a host lying about completeness or
an independently retained watermark. A snapshot rollback must not roll back the
host's generation or historical floor. This is an **input requirement**, not a
claim that the runtime now enforces recovery generations or that a restore is safe.

The reader must account for durable prepared and abandoned upload intents,
retained/orphaned objects and private Work/Result history, not just ready Assets
or currently attached pointers. Deleted, archived, expired or retired records can
still matter to old writers, background readers and retained bytes. A disabled
feature, removed live pointer, missing-object observation or restored older DB
does not erase that historical compatibility obligation. The host must retain
the relevant shape in its independent rollback floor; this library neither
collects those rows nor supplies evidence that they can safely be forgotten.

This v1 models **shape history**, not an independent historical minimum schema
ledger or policy-capability history. For example, a host supplying a restored
schema 084 and the private-human-Result shape retains ACL/history requirements,
but does not cause this evaluator to infer that schema 085 previously existed.
Its conditional `work.server-policy.v1` requirement applies when 085 is planned.
A locally compatible 084 diagnostic is therefore **not approval to restore or
roll back across 085**. The real restore gate must separately retain and enforce
historical minimum ledger/capability requirements; that gate remains unavailable
here. `restore_proof` is always false, including in this counterexample.

Each `release_records` entry contains exactly:

- `source_sha`, `artifact_sha256`, `evidence_id`;
- `status`: `approved` or `withdrawn`;
- `environments`: supported environment IDs;
- `schema_ledger_digests`: exact tested full ledger digests, not numeric ranges;
- `capabilities`: reviewed IDs from the table below;
- `approved_at_ms`, `expires_at_ms`: current approval validity window.

An exact identity match is required for **every** active binary and the candidate.
Matching only source SHA, semver, newest migration number or a candidate's claimed
capabilities is insufficient. A withdrawn/expired record cannot be recovered by
a matching schema digest. An evidence ID is a bounded audit reference, not a URL,
credential or authentication mechanism. Reports do not echo raw host input.

Requested enablement is not authorization to change configuration. Before using
the diagnostic, an integrating host must independently account for every shape
the actual proposed configuration can enable; an omitted `enable_shapes` entry
cannot serve as proof that the candidate will not enable it. This library does
not inspect or apply a cloud overlay or a persistence-policy update.

## Supported rules

The existing scanner's `sha256(JSON.stringify(sql))` convention is unchanged.
The evaluator validates ordered full filename/digest ledgers, first migration 001,
the historical missing 022, no duplicates or other gaps, and exact reviewed names
076–085. Recognizing the 085 filename does not approve its SQL digest or a release;
exact independently approved ledger support is still required. Schema below 075
and unknown extensions are unavailable. Applied DB
ledger must be an exact prefix of the planned scanner ledger. Every binary must
have approved support for **both** full observed and full planned ledger digests.
This conservative rule blocks an unsafe old binary before an expand migration,
not merely after the first new-shape write. No SQL file or migration is changed.

| Capability | Narrow evidence it represents |
| --- | --- |
| `platform.legacy.v1` | existing platform wire/read/write behavior supported for the exact approved ledger; always required |
| `work.explicit-wire.v1` | explicit legacy Work DTO projection and mode-safe handling; required by schema 077 even with no private writes, because old row spread can leak added metadata |
| `avatar.asset-bridge.v1` | source-routed avatar reads/presence, same current ACL around external I/O, missing-object fail-closed behavior and legacy-writer fencing; not an R2 binding/backup proof |
| `work.personal-owner-acl.v1` | current personal owner/scope checks and private Work compatibility without exposing it through old community projections |
| `work.private-human-result.v1` | profile-bound private text lifecycle, typed Work target, immutable human Result history and legal reads; never model/Run provenance |
| `work.server-policy.v1` | current DB-backed private persistence revision/quota resolver; required for any private shape when schema 085 is planned, never a caller-supplied blanket persistence allowance |

| Shape | Minimum schema | Additional capabilities |
| --- | --- | --- |
| `avatar.asset.v1` | 080 | avatar bridge |
| `work.private.v1` | 081 | personal owner ACL |
| `work.private-human-result.v1` | 084 | personal owner ACL + human Result |

Schema 085 alone does not enable a private shape. When it is planned, any private
shape in the required union also requires `work.server-policy.v1` from every
binary. This guards policy-aware rollback without claiming HTTP/UI activation,
private cleanup, model execution or approved production configuration.

Required shapes are the union of requested enablement, current enabled shapes,
already written shapes, and independent historical rollback floors. Turning a
feature off never subtracts a stored-data requirement. Observed enabled/written
shapes also require their schema already applied. New enablement requires its
schema in the planned ledger. Unknown profiles, policy versions or execution
capabilities fail closed rather than borrowing human Result or avatar support.

`compatible` means only that these explicit, bounded local matrix checks passed
under the supplied trusted-host assumptions. Every report keeps
`deployment_authority`, `restore_proof`, and `execution_authority` false.
It does not activate the avatar storage policy, private mutation routes, R2-only
writes, cleanup, a model adapter, or a Run/Grant. Backup policy, actual object-copy
verification, restore/revocation reconciliation, binding checks, approved release
slot, app/grants probes and deployment authorization remain separate gates.

## Test evidence and limits

Dedicated tests use synthetic host approvals/observations plus the actual local
scanner ledger. Counterexamples cover the schema-077/no-write leakage floor,
mixed old binaries, disabled-but-written shapes, historical watermarks, wrong
source/artifact/target/generation, stale/future evidence, withdrawn approvals,
ledger name/digest/order/gap differences, unknown extensions, candidate
self-approval, bounded data and actual CLI failure propagation. No live release,
database, private helper, production approval or cloud restore was exercised.
