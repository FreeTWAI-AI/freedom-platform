# Seven-source media inventory

`scripts/media-inventory.ts` is the read-only operations entry for the seven existing database media sources. It reports aggregate counts and sizes, never source bytes, user IDs, URLs or credentials. It performs no backfill, object verification, garbage collection, backup, restore or cutover.

Use `npm run media:inventory -- --help`. Every run requires an explicit environment, expected database, schema, role and source/release SHA. The SHA is operator declared; the report labels it `operator_declared_not_runtime_verified`, rather than asserting the deployed version was observed. The default is a plan with `execution:not_run` and never opens a database or reads its connection secret.

To run the aggregate inventory, supply `FREEDOM_MEDIA_DATABASE_URL` privately and add `--execute-readonly`. There is no `DATABASE_URL` or local database fallback. Local targets must use `fp_*` database and schema names on loopback, optionally with a Unix socket. Staging/public URLs require `sslmode=verify-full`. The connected database and role must match the explicit target, and superuser/BYPASSRLS roles are rejected. This command's existence does not authorize reading staging or public data.

The library holds one repeatable-read, read-only transaction with statement and lock deadlines. All source queries use a fixed registry and fully qualified identifiers. Views, foreign tables and RLS-filtered source tables are classified unavailable. Missing required columns produce null counts and an incomplete report; permission/query errors abort and roll back. Counts remain decimal strings, including values above JavaScript's safe integer range. No source names, rows or SQL diagnostics from unexpected errors are echoed.

| Source purpose | Stored byte limit | Classification |
| --- | ---: | --- |
| member.avatar | 128 KiB | Nullable legacy bytes |
| skill.submission-image | 512 KiB | Nullable legacy bytes |
| community.event-banner | 512 KiB | Stored image |
| community.event-video | 20 MiB | Declared MP4/WebM MIME |
| community.event-highlight | 1 MiB image / 200 KiB thumb writer limit | Both variants, incomplete active pairs, unknown variants, orphan/removed parents |
| community.social-thumbnail | 512 KiB | Stored image |
| member.service-cover | 512 KiB | Stored image |

These are measured source/schema limits in `MEDIA_SOURCES`, including the historical highlight SQL limit of 1 MiB for either variant. Image MIME provenance is the existing writer, with `unknownMimeCount:null`; this inventory does not decode images or verify content hashes. A complete aggregate report therefore still has `migrationReadiness:not_evaluated`, `contentDigests:not_run`, `dataMoved:false` and `restore:not_run`. This inventory does not enumerate every media read/write entry or detect all base64/JSON/local-disk sources.

See [media migration specification](../../docs/platform-plan/execution/unified-foundation/05-media-migration.md). The storage profiles and streaming primitive live in [asset-storage](../asset-storage/README.md); All seven purposes now have finite domain adapters; event highlights publish their original image/thumb pair atomically and skill illustrations retain the original upload-grant authority. Manual and automatic social thumbnail writes use the same profile; automatic creation publishes the original post, typed pointer and receipt atomically. R2-only still requires historical legacy-source and retained-byte floors to be satisfied. Service-cover backfill is member-owner authorized and resumable, not an all-member operator migrator. All-source production inventory, migration and remote DB+R2 restore/cutover remain. Historical migrations are unchanged; later schema additions keep legacy defaults.


The [object transfer module](backup-transfer.ts) copies the exact pinned immutable representations into a separately supplied backup ObjectStore and verifies full source and destination bytes. It bounds object count, total bytes and each representation; interrupted copies can reuse verified immutable destinations. Current pin identity/protection is checked before and after I/O. Restore validates the full manifest and current trusted host authorization before storage access, and rechecks authorization after effects. It never restores database permissions or rewinds deletion/revocation authority.

The [backup coordinator](backup-coordinator.ts) commits the maintenance capture barrier, exports a PostgreSQL snapshot, and makes both the reference collector and the trusted `pg_dump` port import that same snapshot. Concurrent later writes therefore cannot enter the dump without entering its reference manifest. The exporter closes after the completed dump; bounded object copy follows without SQL row locks. Pins remain until an explicit host retention/reconciliation decision, including when a copy fails. The enabled host needs a pool with at least two connections. Dump ports must persist and hash the exact snapshot/schema output; this module performs no shell command or environment lookup.

`npm run test:media-restore` creates only its own labeled, pinned PostgreSQL18 test container with tmpfs, no network or published ports. It executes actual `pg_dump`/`pg_restore` into a new isolated database and copies actual local native R2 objects. The drill verifies migration ledger hashes, exclusion of a concurrent writer, retired-object capture, GC protection, byte hashes, current external deletion veto, and member-session invalidation after restore. The launcher checks the exact container identity before cleanup. The expanded local drill covers all seven purposes and eight variants through original factories/APIs and ten actual captured objects. It checks typed pointers, original URLs/DTOs/cache behavior, private/inactive access denial and restored session fencing. This is not remote R2/offsite backup, full production recovery/floor/grants/outbox acceptance, a retention decision or release authorization. A --no-privileges dump also strips the operator functions’ PUBLIC revocations: the canonical runtime grants correctly refuse that unsafe restore; exact source lockdown must precede app installation. The reusable `media:restore-acl` tool checks the full canonical migration ledger and only the twenty-four exact reviewed105/107/109/110/111 functions, then restores their PUBLIC revocations before runtime installation. It changes no application grants or recovery authority. Dispatch must stay fenced until current external revocations, tombstones, grants, outbox and unknown provider effects have been reconciled.

The [content verifier](verify.ts), invoked with `npm run media:verify -- --help`, reads bounded batches across all seven original sources and eight variants. It computes actual legacy and immutable-object SHA-256, rechecks source/pointer metadata and bytes after I/O, emits resume cursors and compares supplied baseline records. Skill and highlight Asset pointers are included; highlight structural pair inventory accepts NULL retained bytes only for an explicit Asset parent, while actual object verification still requires both typed published pointers. No installed ObjectStore yields `asset_verification_not_run`, and a missing/tampered variant yields an incomplete report. Cursors are scan positions, not point-in-time snapshots. Reports do not prove decoding, remote storage, global migration or cutover readiness.

The [operator cover host](operator-backfill.ts) and `npm run media:backfill -- --help` provide seven closed operator profiles: historical avatars, service covers, exact MP4/WebM event videos, original event banners and social thumbnails, skill illustrations and atomic highlight pairs. The default only validates a plan; execution needs an explicitly installed trusted host, exact operator approval and separately bound ObjectStore. It preserves source bytes and cannot cut over or purge. The [installation SQL](../../deploy/cloudflare/sql/40-media-backfill-operator-grants.psql) grants a dedicated role only; it does not approve a plan or enable persistence. All seven operator profiles are implemented locally; covered historical avatars remain excluded from the old avatar GC, and general cleanup activation still requires current policy and reconciled effect/backup evidence. Video backfill uses current historical organizer read authority, copies original bytes, and reports fresh remaining legacy sources; it does not grant future upload authority or claim global completion.

The inactive [native operator Worker](../../docs/development/media-operator-worker.md) exposes only private service-binding RPC and HTTP404, with request-owned SQL clients and native MEDIA. Its fixed installed purpose set is avatar/cover/video/banner/social/skill/highlight, further narrowed by the private installation profile. Candidate bindings and release/profile pins do not prove remote bucket/cache/role identity or install a main-platform caller. [Main Worker media preflight](../../deploy/cloudflare/media-preflight.md) reports seven-purpose declarations and their unverified runtime/provider prerequisites; the baseline is unavailable and never deployment-ready.


Historical avatar backfill preserves the original128KiB bytes under the closed
member.avatar profile and member.avatar.legacy-bytes.v1 transform. Old avatar
readers cannot consume that representation. Before publishing one, the trusted
release observation must include avatar.legacy-bytes.v1 for every active or
retained reader and schema111, in addition to the original avatar bridge.
Ordinary avatar writes keep the existing NULL profile; migration alone enables
neither representation publication nor deletion.

The [isolated candidate admission CLI](../../deploy/cloudflare/candidate/README.md)
generates review-only main/broker/operator configs from an explicit installation
request and the existing environment manifest. It does not create resources,
read credentials or change operating staging/live routes. Its default request
contains placeholders and exits unavailable. Remote physical isolation,
private bucket/bytes, installed role/policy/fleet evidence and actual cloud
acceptance must be supplied separately. Broker remains OFF because its existing
origin contract does not permit the proposed separate candidate hostname.
