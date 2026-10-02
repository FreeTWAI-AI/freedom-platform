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
| `schema` | `freedom.release-compatibility-host/v2`; old v1 is unavailable, never silently upgraded |
| `target` | `{environment, database_identity, recovery_generation}`; environment is `next` or `staging-next`, database identity is an opaque nonsecret ID, generation a positive decimal string |
| `now_ms`, `max_age_ms` | trusted host time and explicit observation freshness bound, at most 300,000 ms; candidate clock is not used |
| `rollback_floor_shapes` | independently retained historical shape watermark; never erase this just because a feature is disabled or a DB snapshot is restored |
| `rollback_floor` | mandatory independently retained historical ledger/capability floor, described below; missing/null/empty is unavailable, not an empty-history default |
| `observation` | complete current observation described below, from an independently authenticated reader |
| `release_records` | independently approved or withdrawn exact source/artifact capability records, described below |

`observation` contains exactly `evidence_id`, `observed_at_ms`, `target`,
`schema_ledger`, `schema_ledger_digest`, `enabled_shapes`, `written_shapes`,
`active_releases`, and `complete: true`. Its target must exactly match the host
target, including the externally maintained recovery generation. Future, stale,
incomplete and empty-active-release observations are unavailable. Every consumer
still able to access this database must appear in `active_releases`; do not omit
an older Worker, cron, helper or reader to make a rolling deployment pass. This
profile intentionally cannot certify an empty/incompletely observed environment.

The host must collect a consistent observation and maintain durable historical
shape, ledger and capability watermarks outside the restorable database. The
evaluator cannot detect a host lying about completeness or replacing a retained
watermark with an older one. A snapshot rollback must not roll back the host's
generation or historical floor. This is an **input requirement**, not a claim
that the runtime now enforces recovery generations or that a restore is safe.

`rollback_floor` has exactly these fields:

| Field | Meaning |
| --- | --- |
| `evidence_id` | bounded nonsecret host audit reference; not a URL, signature or authority |
| `target` | same `{environment, database_identity, recovery_generation}` structure as current target; historical retained generation, not the restored DB's claim |
| `schema_ledger`, `schema_ledger_digest` | full historically retained minimum ledger, with the existing exact filename/SQL digest convention and ledger digest |
| `capabilities` | historical required capabilities from the same reviewed capability registry used by release approvals |

The retained environment and database identity must exactly match the current
host target. This profile has no cross-database restore-lineage authorization;
changing the database identity cannot create fresh history or adopt another
database's floor. The retained recovery generation must be **less than or equal
to** the current independently supplied generation, compared as bounded decimal
integers without JavaScript number rounding. Current observations still require
the exact current generation. Increasing a generation does not clear any floor.

The historical ledger must be an exact prefix of **both** current observed and
candidate-planned ledgers, including every SQL digest. A restored schema below
the floor is incompatible even if the candidate plans to reapply migrations;
repair requires a separately authorized operation and a new current observation
before a compatible diagnostic. Changed names/digests, gaps and unknown schema
extensions are never inferred compatible from a last migration number alone.

For one environment/database lineage, external retention must only extend its
ledger by exact prefix and union its capability and shape sets. It must preserve
`rollback_floor_shapes` when replacing/advancing `rollback_floor`. Floors do not
expire merely because old evidence is older than `max_age_ms`; that freshness
bound applies to the **current observation**, not to historical obligations.
An explicit baseline ledger and capability set are required even for a new
fixture/environment; this evaluator does not initialize or persist them. There
is no history reducer, collector, external checkpoint store or authentication
adapter in this slice. Cross-call monotonic retention remains a host obligation,
not something this stateless evaluator can prove from a supplied object.

The reader must account for durable prepared and abandoned upload intents,
retained/orphaned objects and private Work/Result history, not just ready Assets
or currently attached pointers. Deleted, archived, expired or retired records can
still matter to old writers, background readers and retained bytes. A disabled
feature, removed live pointer, missing-object observation or restored older DB
does not erase that historical compatibility obligation. The host must retain
the relevant shape in its independent rollback floor; this library neither
collects those rows nor supplies evidence that they can safely be forgotten.

Historical capability requirements retain their reviewed prerequisites even
when shape arrays are empty: human Result requires owner ACL and, from schema
085, server policy; closed member Run requires both owner ACL and server policy.
Every active/candidate approval must explicitly contain these capabilities;
the evaluator never upgrades a release's declared support. An owner-ACL-only
requirement may describe read/projection protection, so it does not imply Result,
Run or persistence support. Capability floors do not replace retained shape and
ledger evidence or prove that a corresponding data shape was written.

The old host-v1 shape-only input is now rejected, not interpreted as proof that
schema/policy history was empty. A retained 085 ledger rejects a restored/planned
084 matrix even if every binary has approval for 084. A retained
`work.server-policy.v1` capability is required from every active/candidate binary
even if all current shape arrays are empty. These checks close the former
shape-only counterexample; they do **not** prove policy restoration. Restoring
older allowing policy rows under the same 085 schema can revive revoked policy
state. This evaluator neither reads nor reconciles per-scope policy revisions,
revocation/tombstones, DB+R2 backup sets, live grants or queue effects. Therefore
`restore_proof` remains false even when schema/capability history is compatible.

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
076–091. Recognizing a reviewed filename does not approve its SQL digest or a release;
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
| `work.server-policy.v1` | current DB-backed private persistence revision/quota resolver; required for any private shape when schema 085 is planned or retained, or whenever explicitly in the historical capability floor; never a caller-supplied blanket persistence allowance |
| `execution.member-run-record.v1` | owner-only closed Run records and human pause/stop controls, immutable Work input and independent fences; not Attempt/Grant, machine authentication or dispatch support |
| `execution.runtime-enrollment.v1` | current-member public-key challenge/enrollment/revocation, immutable identity and retained key tombstones; not device attestation, machine token or execution support |
| `execution.agent-connection-record.v1` | owner/runtime/client/environment-bound, expiring and revocable connection metadata; not token issuance, nonce replay prevention or machine authorization |
| `execution.bootstrap-status.v1` | current owner/runtime/connection and cryptographic checks plus single-use nonce/proof ID admission for minimal status only; not issuer, device-flow HTTP, private data or execution Grant support |
| `execution.device-authorization.v1` | closed device requests, exact member approval, genuine enrollment proof and one-time bootstrap issuance with durable throttling; not refresh families, HTTP/UI, production issuer trust or execution Grants |
| `execution.bootstrap-session.v1` | one-use refresh rotation, committed family/connection reuse revocation and purpose-bound machine nonce acquisition; not HTTP/UI, production issuer trust or execution Grants |

| Shape | Minimum schema | Additional capabilities |
| --- | --- | --- |
| `avatar.asset.v1` | 080 | avatar bridge |
| `work.private.v1` | 081 | personal owner ACL |
| `work.private-human-result.v1` | 084 | personal owner ACL + human Result |
| `execution.member-run-record.v1` | 086 | personal owner ACL + server persistence policy + closed member Run records |
| `execution.runtime-enrollment.v1` | 087 | closed runtime enrollment |
| `execution.agent-connection-record.v1` | 088 | closed runtime enrollment + agent connection records |
| `execution.bootstrap-status.v1` | 089 | runtime enrollment + connection records + bootstrap nonce admission |
| `execution.device-authorization.v1` | 090 | runtime enrollment + connection records + bootstrap nonce admission + closed device authorization |
| `execution.bootstrap-session.v1` | 091 | runtime enrollment + connection records + bootstrap nonce admission + refresh/session records |

Schema 085 alone does not enable a private shape. When it is planned or retained,
any private shape in the required union also requires `work.server-policy.v1` from every
binary. This guards policy-aware rollback without claiming HTTP/UI activation,
private cleanup, model execution or approved production configuration.

Likewise, 086 schema alone does not enable Run creation. Once closed Run records
are enabled/written or retained in history, every consumer needs their narrow
capability and owner/persistence protections. Records remain relevant after
pause/cancellation. This shape never means an execution Grant was approved or
an Agent may run; no Attempt, runtime connection or model path is activated.

087 alone likewise enables nothing. Pending/expired/consumed enrollment
challenges and enrolled/revoked registrations all count toward retained shape
history. Enrollment compatibility does not imply private Work persistence or
Run support, and successful key possession is not a runtime execution grant.

088 alone enables nothing. Active, expired and revoked connection records all
count toward retained shape history. Connection support requires runtime
enrollment support even when present only in the retained capability floor;
it implies neither private Work/Run support nor machine authentication. The
bootstrap signature verifier is cryptographic evidence only and does not create
an enabled shape or execution capability. These diagnostics protect retained
data; they do not require a separate transitional deployment or old-app rollback
release in the current forward-migration plan.

089 alone enables nothing. Pending, expired and consumed bootstrap nonce rows
all count as retained shape history. Bootstrap admission support requires both
connection and enrollment support, including capability-only history floors.
Nonce consumption or a successful status read never implies Run/Grant, private
Work, provider, public HTTP activation or token issuance support.

090 alone enables nothing. Pending, approved, denied, expired and consumed
device requests, poll-proof history and review buckets remain retained records.
Device authorization support requires bootstrap admission, connection and
enrollment support, including capability-only floors. A local one-time token
exchange is not production issuer approval, refresh support, HTTP/UI activation
or permission to execute. These checks do not call the issuer or mutate storage.

091 alone likewise enables nothing. Families (active, expired or revoked), spent
and current generations, and session proof ledgers all remain retained history.
Session support requires bootstrap, connection and enrollment capabilities, not
device authorization by itself. However, when 091 is planned or retained, required
device authorization also requires session support: its exchange must now create
the initial family atomically and return the forward-updated issued DTO. This
applies to capability-only history floors too. Historical 090 device support is
not retroactively reclassified. Neither capability authorizes private Work,
model access, production issuer use or execution.

Required capabilities union the independently retained capability floor with
the schema/shape-derived requirements; they apply to **every** active binary
and the candidate, not just to the newest release. Required shapes are the union of requested enablement, current enabled shapes,
already written shapes, and independent historical rollback floors. Turning a
feature off never subtracts a stored-data requirement. Observed enabled/written
shapes and independently retained historical shapes also require their schema
already applied. A retained shape can impose a stronger current-schema minimum
than the separately retained ledger; these components combine conservatively
rather than requiring identical watermarks. Planned migrations cannot satisfy
the historical shape requirement until a fresh observation confirms application.
New enablement requires its
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
ledger name/digest/order/gap differences, historical 085-to-084 rollback,
current schema below floor despite a repair plan, disabled historical policy
capabilities, cross-database/environment floor transplant, exact generation
comparisons beyond safe integers, absent/v1/invalid historical inputs, unknown extensions, candidate
self-approval, bounded data and actual CLI failure propagation. No live release,
database, private helper, production approval or cloud restore was exercised.
