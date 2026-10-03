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

See [media migration specification](../../docs/platform-plan/execution/unified-foundation/05-media-migration.md). The storage profiles and streaming primitive live in [asset-storage](../asset-storage/README.md); other six domain adapters, typed pointers, resumable backfill/delta, GC/backup coordination and DB+R2 restore are remaining implementation work. Existing migration files are unchanged.
