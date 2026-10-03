# Closed operator media backfill

Migration105 installs the closed `member.service-cover` operator profile;
migration107 extends the same host to `community.event-video`. Banner/social/
skill/highlight/avatar operator adapters are not installed. Existing cover
personal owner mappings and video organizer/person/community mappings must
already be canonical; run bounded canonical scope backfill separately when
necessary. Neither host creates member sessions, machine principals, scoped
member receipts, or permission to reactivate an owner.

`planOperatorBackfill` requires the exact database/schema/dedicated login role,
environment, operator-declared release SHA, job UUID, MEDIA logical store,
trusted installation binding ID, migration ID, row/byte limits and lease limit.
Its SHA-256 binds that closed plan. An administrator separately installs a
finite-expiry approval row with this hash. Default policy is absent/disallowed.
The role must be a dedicated `fp_media_migrator_*` or `freedom_media_migrator`
login with neither superuser nor BYPASSRLS. Caller SET ROLE is not equivalent:
locked approval binds `session_user` and host validation binds `current_user`.
Migrations105/107 grant no activation or privileges. The explicit
`deploy/cloudflare/sql/40-media-backfill-operator-grants.psql` installer grants
only the closed host requirements and rejects privileged/member roles, schema
CREATE access, and inherited/PUBLIC authority writes. Its exact SQL block is
executed in the PostgreSQL tests; source bytes and policy remain unwritable. Application/execution roles
must not receive policy writes or execution of the operator-only ports.

`createOperatorCoverBackfill(pool, {store, logicalStore, storeBindingId}).run(plan)`
retains its cover-only boundary. `createOperatorMediaBackfill` selects one of
the two fixed profiles from the separately approved plan. Every SQL phase checks the actual database/login,
ordinary non-RLS source tables, exact live operator approval, and canonical
100 storage consent. Consent must be explicit bridge mode with a revision and
retained quota. Operator approval cannot grant storage consent. The migrator
has no UPDATE privilege on either policy, users, principals or resource scopes.
Closed SQL-standard security-definer ports acquire required read locks without
those write grants. Their table dependencies bind at migration time, PUBLIC
execution is revoked, and publication pins pg_catalog plus its migration schema
for existing attachment triggers. Only the administrator owns that schema.

A job lease/fence and a common intent lease/fence independently prevent stale
commits. Each phase flushes deferred constraints, then checks the exact live
approval/job/intent clock after its last write or audit wait immediately before
COMMIT. The actual PostgreSQL final-audit lock test crosses the lease deadline
and proves that the whole publication phase rolls back. Durable items reference the **same** `asset_upload_intents` and `assets`;
there is no second blob catalog or alternate storage key. The source binding
pins real owner/community/state/version/scope and actual original byte SHA.
A fresh transaction rereads and hashes the source after object I/O, including
same-size byte changes without a domain version update. Changed/disabled owners
or source changes become stale, leave the common pending asset unpublished, and
advance only this job's cursor. Cover missing mappings/invalid source stop unavailable. Video missing/disabled
organizer, principal or community scope, malformed/oversized legacy bytes, and
other unavailable authority are audited as `blocked_source`. These rows do not
create Assets or claim successful migration. Stale and blocked counts persist
in the original append-only audit; reports include fresh remaining-legacy
metadata so cursor exhaustion cannot claim all sources were migrated.
No repeatable-read snapshot or resumable exported PostgreSQL snapshot is claimed.

Cover WebP and exact original video MP4/WebM bytes are validated through the shared profile and copied byte for byte.
Object I/O uses shared immutable PUT and actual full-GET SHA verification outside
SQL locks. An unknown PUT records `object_outcome_unknown` when the same job fence
still owns the job. Its common pending intent/key remain discoverable; a new
claim after **both** leases expire reconciles the identical immutable object.
Late PUT cannot publish through an expired job/intent lease. Storage diagnostics
never appear in reports. No automatic cloud adapter, bucket credentials or retry
worker is installed.

Publication updates the original typed cover/video pointer, common asset/intent
and original service/event aggregate version atomically. Historical published
and ended video is eligible under current organizer READ authority: this does
not grant the future-pending-only permission to replace its content. The source
binding pins original MIME, state, organizer, community, version and SHA; public
GET/HEAD/range authorization stays with the original event reader. Historical bytea is retained;
no source deletion, cutover, r2_only activation or bypass of original read ACL
occurs. Ready objects enter existing backup capture/pins. Unrecorded late PUTs
remain pending-intent reconciliation work; backup object enumeration alone is
not proof that these effects were reconciled. Existing deletion GC supports
avatars only: domain-media pending/late-object cleanup is **not installed** and this
host never deletes an object or claims a complete domain-media GC/restore workflow.

A batch attempts at most 16 rows and reserves conservatively six bounded 512 KiB
content reads per attempted row against a 3–8 MiB cap (at most two worst-case
rows with current caps). Video is exactly one attempted row per run, reserving
six bounded20MiB reads against120–128MiB. `--purpose community.event-video`
selects that closed plan; omitted purpose remains cover for compatibility.
SQL/lock waits cap at five seconds each; a job/intent
lease is 1–60 seconds. Each object operation has that finite invocation deadline;
an underlying immutable PUT may finish late, so fencing and reconciliation are
required. `contentReadUpperBound` is a conservative bound, not measured traffic.
A cursor is a durable per-job UUID keyset position. Completion applies to that
scan and `allSourcesMigrated` is limited to fresh profile source metadata, not
remote object integrity or a timeless proof: inserts behind the cursor require a new approved job
and separate fresh verification/delta. This is not an all-seven backfill claim.

`scripts/media-backfill.ts` exports `runMediaBackfill(args, env, installedHost?)`.
Default dry run validates and prints the plan without touching the database or
reading environment secrets. `--execute` without an explicitly installed trusted
host returns `trusted_backfill_host_not_installed`; it is **not** a general
operational cloud CLI. A trusted operator application may inject the host and
must supply its separately approved exact target and store binding. Reports
contain aggregate results and the job ID, never source bytes, object keys,
connection secrets or raw database/storage errors.
