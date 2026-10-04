# Closed banner and social operator extension (109)

The existing operator host now selects four finite source profiles: cover, video,
event banner and social thumbnail. This increment adds only the latter two.
The command accepts `--purpose community.event-banner` or
`--purpose community.social-thumbnail`; omitted purpose still means cover.
The default validates a plan without reading environment variables or opening
SQL. `--execute` requires an installed trusted host, independently bound MEDIA
ObjectStore, dedicated non-super LOGIN role, exact database/schema/release/plan
approval and canonical persistence consent. The release SHA remains operator
specified, not an observation of deployed runtime identity.

Banner source is the original WebP `community_event_banners.image_bytes`, capped
at 512 KiB. The current active organizer/person and community scope establish
historical organizer **read** authority; a past or cancelled event is not rejected
merely because future upload eligibility ended. Its state and original orientation
are pinned and preserved. Migration does not make cancelled/pending content public.
Social source is the original 512 KiB WebP thumbnail and actual `source` enum
(`youtube`, `page`, `upload`). The post must remain active with its current active
author/person/community scope. The binding includes original URL, platform,
title, nullable note, state, internal media version and source enum, in addition
to bytes SHA/size and canonical owner/scope. Free text is encoded as UTF-8 hex
in the SQL/host fingerprint to prevent separator ambiguity. No preview URL is
fetched, no normalization is rerun and no authority is inferred from source labels.

One host continues to use the same job, items, audit, common upload intents,
Assets, object metadata, typed pointers and 108 write-effect ledger. Separate
finite cursors and item columns cannot mix profiles. SHA/version/provenance is
reread in fresh transactions before PUT and publication; no SQL lock spans R2
I/O. The same final approval/job/intent decision clock runs after SQL publication
and audit waits. Six SQL-standard, schema-bound ports grant only original
read-authority locking, canonical consent locking and validated source-selector
publication. PUBLIC execution is revoked. The operator installer grants no INSERT
on original domains/attachments and no UPDATE on original bytes, provenance,
owner, state or source selector; only the validated publication port changes the
selector. Original bytes are retained, and original URL/ACL read paths remain.

Both image profiles retain the existing 3–8 MiB batch budget and 1–16 row input
limit; the conservative six-read allowance further limits effective row count.
Each original row/object is bounded at 512 KiB. Invalid header, inactive owner,
missing canonical mappings and unavailable source authority are audited as blocked.
The report checks fresh remaining legacy rows and never claims all seven source
profiles migrated. Resume is a cursor over new snapshots, not a preserved snapshot.
An unknown PUT may replay the same common identities under a new fence, but its
old unknown effect remains unknown and blocks GC. This tool does not reconcile
unknown effects, activate GC, purge SQL bytes, cut over, restore, approve plans,
manufacture member sessions/receipts or establish cloud configuration.

`tests/runtime/operator-banner-social-backfill.test.ts` uses full migrations owned
by a managed non-super role, a separate restricted operator LOGIN and native
local Miniflare R2. It verifies exact 512 KiB byte preservation and native readback,
original public visibility, partial/resumed cursor, orientation and free-text
provenance races without a version change, blocked anomalies, uncertain PUT
history, canonical prohibition after I/O, privilege denial and dry CLI behavior.
Hash/lifecycle code runs in Node; only R2 I/O is native in this suite. No remote
source/bucket was accessed and no staging/public authorization is implied.
