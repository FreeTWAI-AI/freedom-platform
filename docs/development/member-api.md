# Member accounts, privacy and small teams

These APIs extend the current server; they are not yet in the pinned preview SDK.
Chat history search adds `GET /me/conversations/:userId/messages/search` and
`GET /me/channels/:kind/:key/messages/search`. Both require the existing session
and current conversation/channel access. Parameters are `q` (trimmed, 1–100
characters), `limit` (1–50, default 20) and an optional message UUID `cursor`.
They return `items` and `next_cursor`; cursor membership is checked against the
same community and conversation. Wildcards are treated literally, results are
newest first, and searching writes no read receipts. A 1500ms SQL timeout returns
`503 message_search_busy`. See [chat experience](social-chat-experience.md).
Notification, direct-message and owner-initiated squad invitation endpoints are
documented in [member settings and messages](member-settings-messages.md).
Requests use the existing session cookie and same-origin JSON. All authenticated
POSTs require CSRF and Idempotency-Key; updates to an existing version require
`If-Match: "<aggregate_version>"`. Authentication/register is the exception and
uses persisted rate limits instead. IDs are UUIDs.

## Member reporting and moderation cases

This surface is default OFF. Only `FREEDOM_MEMBER_REPORTING_ENABLED=true`
enables it; `/api/v1/site` exposes `member_reporting_enabled`. Disabled reporting
routes return 404 before session authentication. Existing messaging and channel
permissions are unchanged.

- `POST /me/reports`: `{target_kind,target_id,reason,note}`. Targets are visible
  `post`, `comment`, `direct_message`, `channel_message`, or `member` UUIDs.
  The server checks current visibility and captures immutable evidence, rather
  than accepting a client-supplied snapshot. Returns a case number and status.
  Repeated reports by the same reporter for the same target reuse the case;
  at most 20 new cases per reporter per hour are allowed.
- `GET /me/reports`: only the current reporter's case numbers, status and public
  outcome summary; no private evidence or reporter identity is disclosed.
- `GET /admin/reports`: private cases and evidence, restricted to active
  platform administrators with verified email. Guild titles confer no access.
- `POST /admin/reports/:id/transition`: `{state,reason,summary,action}`, with
  `If-Match` and `Idempotency-Key`. States progress from `received` to
  `in_progress` to `closed`; actions are `none`, `hide`, or `restore`.
  Hide/restore uses existing post/comment moderation; messages and members can
  be reviewed without changing their visibility or account permissions.
  Handler, reason, action and version are audited. Content moderation, case
  status, audit and command receipt commit together; a failed action does not
  mark a case handled. Stale versions and invalid state transitions return 409.
  Restoring a hidden asset-thumbnail post whose current asset pointer was retired
  returns 409 `report_restore_media_unavailable`; content, retained thumbnail
  evidence, and case state are unchanged. Text-only posts and comments remain
  restorable. Full asset-image restoration is not implemented by this guard.

Reports are not sent to the reported member. Other members cannot read cases
or evidence, including private-message evidence they could not originally see.
Migration `141_member_reports.sql` is newly added; maintainers must renumber it
at merge if required. Evidence retention period and an owner-approved general
rules/appeal page are deferred to #261; no appeal contact is invented here.

The E2E runner adds an isolated reporting-enabled pass to the default suite.
`npm run test:e2e -- tests/e2e/member-reporting.spec.ts` enables the flag for that
invocation automatically; ordinary suite passes retain reporting's default OFF.

## Existing member APIs

Generic JSON mutations accept at most 32 KiB of UTF-8 body bytes. The limit is
enforced while streaming, including requests without `Content-Length`; oversized
streams are cancelled with `413 body_too_large` before their remainder is read.
Binary uploads and signed machine transports retain their own bounded readers.

HTTPS deployments use `__Host-freedom_session` with `Secure`, `HttpOnly`,
`SameSite=Strict`, `Path=/` and no `Domain`. Only explicitly configured local
HTTP loopback hosts use `freedom_local_session` without `Secure`. Cookie names
come from trusted configured origin, not forwarding headers. HTTPS readers do
not accept the old name: existing HTTPS sessions must log in again after this
cutover. The member boundary, administrative member-linking and promotion
click attribution all use this policy. Duplicate selected session cookies,
including whitespace around names or identical values, return
`403 credential_kind_rejected`; the platform rejects them before reading a
mutation body or creating, replacing or revoking sessions.

- `GET /api/v1/site`: brand, registration_enabled, demo_accounts_enabled, community.
- `POST /auth/register`: `{email,password,nickname?,contacts?}`. Password 12–128
  characters, nickname up to 60. A missing or blank nickname becomes
  `新夥伴 <8 hex characters>`; the email is never used as a display name. Returns the existing session JSON and cookie (201).
  Optional social contacts are `discord`, `github`, `line`, each `{value,audiences?}`
  with a private default. Registration has exactly one email input: `email`.
  A separate `contacts.email` input is rejected. Contact email always comes from
  the login identity; its audience starts empty (private).
- `POST /auth/login`: existing `{email,password}`. Password login does not verify
  email or automatically link providers. Slugs confer no GitHub/Discord/LINE
  ownership or privileged action.
- `POST /auth/reset/request`: `{email}`; requires the configured recovery sender
  and returns the same result for existing and unknown accounts.
- `POST /auth/reset/confirm`: `{token,password}`; a valid one-use mailbox link
  changes the password, revokes old sessions, clears account lockout and issues a
  new session atomically. Returns `{reset,expires_after_minutes,user,csrf_token}`
  with the same session cookie/lifetime as login; the session cookie already sent
  by this browser is also revoked, as on login. Invalid, expired and inactive
  proofs are rejected. See [password-recovery.md](password-recovery.md).
- `GET /me/account`: `{user_id,nickname,identity_label,login_email,email_verified,contacts,
  aggregate_version}`. Each contact additionally has `verified:false`.
- `POST /me/account`: `{nickname,identity_label?,contacts}` (all four contact entries, **without**
  `verified`); social entries are `{value,audiences}`; email is **only**
  `{audiences}`. Sending `email.value` is rejected. GET still includes the
  authoritative email value for display. This API cannot change the login email.
  Returns current account, never another member's private settings.
  `identity_label` is optional `male | female | alien | ai | null`: omitted preserves
  the current value, null clears it. Default null; self-selected, never inferred.
  It is visible with the authenticated same-community card, and does not grant authority.
  Nickname is the editable community display name; use the name familiar to your community.
- `GET /members?limit=20&offset=0`: `{items,total,next_offset}`. Limit 1–50.
  Optional `search`, `guild_key`, `primary_guild_key`, `capability`, and `sort`
  filters combine before pagination. `capability` accepts a catalog capability ID
  and matches an exact ability in the member's published profile; custom ability
  labels remain available through `search`. Each card:
  `{user_id,nickname,identity_label,positioning_title,primary_guild,secondary_guilds,joined_guilds,capabilities,
  equipment,contacts,is_self,friendship}`. Only visible nonempty contact values
  are present in `contacts` (a string map), not concealed values or settings.
- `GET /members/:id`: same card; inactive, incomplete and other-community users
  return 404. No authenticated access to people until 完成加入（選定主要公會）.
- `GET /friends`: `{items:[{user_id,nickname,state,requester_ref,aggregate_version}]}`.
- `POST /friends/:id/request|accept|remove`: `{}`. First request needs no version;
  accept/remove and renewed removed friendship need current version. Only the
  recipient can accept. Pending requests grant **no** contact access. Remove
  revokes access immediately. Repeat requests do not accept another's invitation.
- `GET /squads?limit=20&offset=0`: `{items,next_offset,kinds}`. Items include
  `squad_id,name,kind,purpose,owner_ref,owner_name,member_count,membership`.
  Membership is null or `{state,aggregate_version}` for the current user.
- `POST /squads`: `{name,kind,purpose}`. `kind=project|mutual_help` (專案小隊／共同
  目標互助小隊; provisional labels). Creator becomes its first active member.
- `GET /squads/:id`: squad plus `members` with `user_id,nickname,state,
  aggregate_version`. Pending members visible only to themselves and owner.
- `POST /squads/:id/request`: `{}` requests admission; no immediate group access.
- `POST /squads/:id/members/:userId/accept`: owner accepts an existing pending
  request with that membership's version. Cannot add an unconsenting member.
- `POST /squads/:id/leave`: member leaves with current membership version, revoking
  squad-scoped contact access. Owner transfer/deletion is not implemented; owner
  cannot leave. No three-person minimum or commercial eligibility is implied.

Contact visibility uses `audiences`, an array of unique values from
`public`, `friends`, `squad`, `guild` (at most four). `[]` means private.
Selected groups combine with **OR**: `['friends','guild']` exposes a contact to
accepted friends **or** current guild partners. `public` supersedes subsets and
is returned/stored as `['public']`. Public means signed-in members of the same
community; there is no anonymous people endpoint. Friends requires an accepted
mutual friendship; squad/guild requires both members to have active membership.
Every read rechecks these relationships in the same PostgreSQL statement
snapshot as the contact value. No hidden email, password hashes, private
assessment answers or equipment secrets are included.

Migration `008_contact_visibility.sql` converts prior scalar visibility fields
to audience arrays. If a former separately editable contact email differs from
the login email (including a blank contact email), its audience resets to private
so replacing the address cannot accidentally publish the login identity. Prior
sharing of the same address is preserved. Changed records increment their
aggregate version; open editors must refresh. Reads also normalize legacy
stored rows, but new writes accept only the new strict audience-array shape.

New accounts have a server-enforced onboarding gate. Only session/logout,
account settings, assessment definition/answers/evaluation/completion, quick-start,
current guild catalog/join/leave/primary and own skill-books are available until
完成加入（選定主要公會） (`onboarding_completed_at` is recorded). Quick start also requires `guild_answers` for every question of the primary guild; see [onboarding-api.md](onboarding-api.md). Those answers stay on the member's own positioning record. The positioning
test can be finished later and is not required to pass this gate.
Legacy demo accounts preserve prior behavior. Public deployments must use a new
DB with no demo seed and explicitly set `FREEDOM_REGISTRATION_COMMUNITY_ID`.
Public registration rejects the reserved `@local.test` demo domain so a public signup cannot trigger the startup demo-account guard. No password reset endpoint exists until a recovery mechanism is configured; a user-entered email or social slug is never sufficient proof for an administrator to reset credentials.
`FREEDOM_TRUST_CF=true` trusts CF-Connecting-IP **only** from a loopback socket;
root must bind the listener to loopback behind Tunnel. Other clients use their
real socket IP; in-process requests share one budget. Registration caps are 8 per
network / 15 min, 3 per email / 15 min and 100 global / min; login 60 per network /
15 min, 240 global / min plus 10 failures per account / 15 min. PostgreSQL persists
these limits across worker restarts. Password hashing uses async scrypt.

## Event submission budget

`POST /api/v1/events` permits five newly committed submissions per member in a
one-hour window. The PostgreSQL budget is locked and updated in the same
transaction as the event, bulletin, notifications and receipt; concurrent requests
cannot exceed it, and failed commands do not consume it. At capacity, new
submissions return `429 auth_rate_limited` without those side effects. Exact
Idempotency-Key replays remain available without consuming another slot.
Five per hour is a provisional value (#199); it is the named constant
`eventCreateLimit` in `modules/community/events.ts`.

## Member avatars

`GET /me/avatar` returns `{avatar_url:null|string,aggregate_version:number}`; the
same metadata is included as `avatar` in `/me/account`. Member cards include
`avatar_url` without bytes or other private settings.

`POST /me/avatar` accepts raw `image/jpeg`, `image/png` or `image/webp` bytes (not
JSON/multipart). Same-origin session, CSRF, Idempotency-Key and the avatar's own
If-Match revision are required. Maximum input is 2 MiB, static, at most4096×4096.
The server validates signatures and decodes pixels, auto-orients, crops centrally
to256×256 WebP and strips metadata; stored output is capped128KiB. Upload rate
limits are12/member/minute and120/global/minute. Account edits keep a separate
version so photo changes do not accidentally save nickname/contact drafts.

`POST /me/avatar/remove` takes `{}` and the same revision/CSRF/idempotency rules.
A tombstone retains revision history. `GET /members/:id/avatar?v=<revision>`
serves only the current photo to authenticated, active, completed members of the
same community. Responses are private/no-store; removed/old revisions are404;
anonymous callers are401. Migration016 stores normalized bytes in PostgreSQL,
so existing database backups include avatars. No external image URL fetching,
SVG, animated upload or anonymous avatar endpoint is enabled.

## Direct-message images (#230)

Optional and **off by default**. The Worker flag
`FREEDOM_MESSAGE_IMAGE_ENABLED="true"` (with MEDIA/IMAGES), or both injected Node
ports, installs the image routes. `/site` reports this installation state as
`message_images_enabled`; absent ports mean false and image routes answer 404.
New uploads also require the operator's `domain_media_storage_policy` row
`member.message-image`: non-legacy `mode` (`r2_only` recommended), policy revision,
at least 1 MiB retained capacity and `persistence_allowed=true`. If that policy
is unavailable, a new upload answers 503 while the site installation flag stays
true. Stopping new persistence does not revoke authorized reads of existing
images or erase an upload whose result is unknown. Apply migration `139_member_message_images.sql` before switching the
source, even with the feature off.

- `POST /me/conversations/:userId/images`: raw `image/jpeg|png|webp` bytes,
  session, CSRF and `Idempotency-Key` (no `If-Match`). Input at most 2 MiB, static,
  at most 4096×4096. Re-encoded to canonical WebP without metadata, longest edge
  1920 px, never enlarged. Rate limits are 12/member/minute and 120/global/minute.
  `201 {image_id, content_type:"image/webp", byte_size}`. Errors are Chinese problem
  documents: `415 message_image_format`, `413 message_image_too_large`,
  `422 invalid_message_image`, `409 asset_retained_quota`, `429`, `503`. The same key
  and bytes replay to the same `image_id`; the same key with other bytes is
  `409 idempotency_conflict`.
- `POST /me/conversations/:userId/messages` also accepts `{image_id, body?}`: an image
  alone (stored body `[圖片]`) or with a caption. An image never combines with a
  sticker and is never a client URL. The draft must be the caller's own upload for
  that exact recipient and unsent (`404 image_not_available`, `409 image_already_sent`).
  Channel messages still reject `image_id`.
- Messages, conversation previews and search results carry
  `image?: {content_type:"image/webp", byte_size}`; there is no URL field.
- `GET /me/conversations/:userId/messages/:messageId/image` returns the bytes to the
  sender or recipient of that message only (`404 media_not_found` otherwise, also
  when a session is revoked during the read). `Cache-Control: private, no-store`.

Retention, orphan drafts and deletion are documented in
[`modules/assets/message-image.md`](../../modules/assets/message-image.md); no cleanup
runs. Existing member blocks deny new upload phases, receipt replay and send;
current callers retain authorized historical reads. Reporting remains out of scope.

## Primary, secondary and other joined guilds

These preferences order a member's display; they never grant membership, offices,
private contact access, repository permission or additional skill books.

- `GET /me/guild-preferences` returns `{primary_guild_key,
  secondary_guild_keys,aggregate_version}`. `secondary_guild_keys` is an ordered
  array of at most two currently active memberships, excluding the primary.
- `POST /me/guild-preferences/secondary` accepts exactly
  `{secondary_guild_keys:string[]}` with session, CSRF, `Idempotency-Key` and the
  current preferences `If-Match`. An empty array explicitly clears the choices.
  Duplicates, more than two or including the primary return 422; a non-active
  or unknown guild returns 409. Missing/stale versions return 428/412. The
  response and ETag contain the new preferences version. All membership and
  preference changes share the per-member guild transaction lock.
- `GET /guilds/directory` adds `is_secondary:boolean` and
  `secondary_position:1|2|null`. Member cards add `joined_guilds` for remaining
  active memberships; `secondary_guilds` contains at most two in chosen order.
  Each guild entry retains `guild_key`, `name`, and `joined_at`.
- Migration `027_secondary_guild_preferences.sql` saves existing choices as the
  first two active non-primary guild keys in ascending key order (or `[]`).
  Setting a primary for the first time also saves the initial choices. Later
  joins, including administrator appointments, never displace these selections.
  NULL remains supported for legacy imports: reads project the same default
  without writing anything. Explicit `[]` never falls back to this rule.
- Changing the primary removes the new primary from the secondary choices. If
  a slot is available, the previous active primary goes last; explicitly empty
  choices stay empty. Changing to the same primary preserves the choices.
  Re-exploration uses this same rule and preserves explicit secondary order.
- Leaving a guild removes it from the chosen secondaries in the same transaction
  and advances the preferences version when needed. A legacy NULL preference is
  frozen to its effective choices at that point. Rejoining therefore does not
  silently restore a secondary slot. Other joined guilds remain available for
  selection and keep their existing skill grants.

## Three category primaries

These routes exist only when the guild-launchpad feature is enabled. They still
do not grant membership, offices, contact access, repository permission or skill
books. A community stays on the legacy primary/secondary model until a platform
admin switches that community. Before the switch, `POST /me/guild-preferences/v2/set`
returns 409 `preference_switch_pending`. After the switch, `POST /guilds/:key/primary`
and `POST /me/guild-preferences/secondary` return 409 `client_upgrade_required`.
`GET /me/guild-preferences` then adds `compatibility: "legacy_projection"` and
keeps the old fields as a read-only projection.

- `GET /guild-categories` is public. It returns
  `{catalog_revision, categories:[{category,label,section,items}], pending:[items]}`.
  Each item has `guild_key`, `name`, `alias`, `profession_title`, `category`,
  `category_review`, `capability_tags`, `active` and `catalog_revision`.
  `catalog_revision` is a positive decimal string, or null when that catalog
  guild has no classification row yet. A missing row is read as pending.
  Approved guilds sit in their category; pending guilds sit in `pending`.
- `GET /me/guild-preferences/v2` returns the member view:
  `{aggregate_version, primaries:[{category,guild_key}], invalidated, migration_state, legacy}`.
  `primaries` always has three rows, in order `internal`, `external`,
  `professional_industry`. Empty slots use `guild_key: null`. No preference-set
  row returns 503 `preference_mapping_unavailable` and writes nothing.
  `aggregate_version` is a JSON number on the wire. The response is
  `Cache-Control: private, no-store`.
- `POST /me/guild-preferences/v2/set` accepts exactly
  `{category, guild_key, catalog_revision}` with session, CSRF,
  `Idempotency-Key` and the preference `If-Match`. `guild_key: null` clears
  that category and carries the top-level catalog revision. A guild selection
  carries that guild's `catalog_revision`. Unknown JSON fields return 422
  `validation_failed`. A moved guild revision returns 409
  `catalog_revision_changed`. A pending, missing or mismatched category returns
  409 `guild_category_unresolved`. An inactive classification returns 409
  `guild_inactive`. A non-active membership returns 409 `active_guild_required`.
- `POST /guilds/:key/leave-v2` accepts `{clear_primary:boolean}` and the
  membership `If-Match`. When the guild is a category primary, also send the
  unquoted preference version in `X-Preference-Version`. Clearing that primary
  and leaving happen in one command. Private business data is not moved or
  deleted. After the switch, the legacy leave route returns 409
  `primary_clear_required` if the guild is still a category primary.

Platform-admin routes, also flag-gated: `GET /admin/api/guild-categories`,
`POST /admin/api/guilds/:key/classification` (If-Match of that guild's
`catalog_revision`), `POST /admin/api/guild-preferences/backfill` and
`POST /admin/api/guild-preferences/switch`. Backfill and switch do not use
If-Match. A missing classification row is 409 `guild_category_unresolved`;
404 `guild_not_found` only when the catalog guild itself is absent.
A member is a backfill or switch candidate when they have no preference set,
or the set is still `legacy`. `backfilled` and `switched` are already
reconciled and are not candidates. Before the switch, an old primary or
secondary write recomputes that member under the member lock. An ambiguous
plan (unknown category, left primary, inactive guild, or invalid secondary)
leaves the set in `legacy`, with empty category slots and a
`legacy_ambiguous` invalidation. That row does not count as mapped and does
not drop the member out of `blocked` / `remaining_blocked`. A later clean
plan moves the same set to `backfilled` and fills only the approved active
primary. `accept_blocked: false` returns 409 `preference_switch_blocked`
while any candidate is blocked; the refusal does not mark sets `switched`
and does not record a clean migration audit for the ambiguous snapshot.
Accepting the block still does not copy another guild into an empty slot
or change the legacy primary, legacy secondary, membership tier, skill
books, or contact visibility.

### Backfill script

The operator runs
`npx tsx scripts/guild-preferences-backfill.ts --database-url <url>`.
It defaults to a dry run; pass `--execute` to write, `--limit` to page the run,
and `--community-id` when the database has more than one community. The script
refuses `NODE_ENV=production`, port 54339 and a database named `freedom_local`,
and never reads `DATABASE_URL`.

Pass `--status` for a read-only snapshot. It first takes the guild catalog
lock at session level. Then it opens one `REPEATABLE READ READ ONLY`
transaction, so the snapshot includes every catalog-locked write committed
before the lock was granted. Preference writes wait while it runs. The
transaction is rolled back and the lock released even on error. It refuses
`--execute` and `--limit`. It prints JSON with
`totals` and one entry per community (or only the `--community-id` one). Entry
fields are `remaining`, `remaining_blocked`, `blocking_reasons` (the dry-run
reason codes), `blocking_reasons_complete`, `preference_sets` and
`switched_at`. `blocking_reasons` counts the listed blocked candidates by
reason code, and `blocking_reasons_complete` is false only when more than 500
candidates are blocked, because the dry run lists at most 500.

State is decided by the first matching rule (the first matching rule wins):
- `switched`: the community's `guild_preference_switch` row is `switched`.
- `blocked`: not switched, and at least one candidate has a block reason
  (`remaining_blocked > 0`). `POST /admin/api/guild-preferences/switch` with
  `accept_blocked: false` returns 409 `preference_switch_blocked` for this
  community.
- `legacy`: not switched, nothing is blocked, and candidates remain
  (`remaining > 0`). The backfill has not finished.
- `backfilled`: not switched and no candidate remains. A community with no
  candidates at all is also `backfilled`.

## Unified sharing entry (#258)

There is a single sharing entry: the existing top-bar “＋分享” launcher. This
candidate adds no second page, navigation item or home shortcut.
`FREEDOM_UNIFIED_SHARING_ENABLED=true` (Node and Worker default off; `/site`
exposes `unified_sharing_enabled`) only extends that dialog: each option states
who can see the result and what is merely a draft, and two entries are added,
“找人合作” (the original bilateral work-opportunity button on a community work)
and “發起共創邀請” (the original registered-source co-creation form). With the
flag off the dialog is unchanged. The candidate adds no database migration,
unified publishing route or permission.

Every option only navigates to the original form and moves focus to its real
control; nothing is submitted or prefilled. Original session/CSRF, ownership,
license, publication consent, visibility, CAS and idempotency policies remain
authoritative. Ordinary works do not require GitHub, Agent authorization or
JSON. “發文” uses the existing native note: visible to members of the same
community, published on send, with no draft state, typed question kind or
reply notification. This change does not alter those #193 contracts; a private
bilateral opportunity is not a public question.

Unsent work, manual submission and invitation inputs, consent, in-flight
mutation state and actual receipts survive same-account form unmounts only in
the current document's login-session memory (not flag-controlled). Reload,
logout, expiry, account switch or a replacement session for the same user clears
it, including when forms are unmounted. Reapplying the same client session
generation preserves drafts; the memory store never retains a CSRF token.
Server-saved private drafts retain their original persistence rules. Late
completions cannot update a new account or initiate its publication stage.
Unknown network outcomes reuse the original command's Idempotency-Key.
Successful receipts point to actual original work/submission/opportunity/
project readers, not provisional drafts or inferred acceptance. The entry itself
collects no content. Local verification is not deployment, flag-on or full #258
acceptance evidence.
