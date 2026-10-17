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

Event `starts_at`/`ends_at` (create, edit and schedule), Work
`claim_by`/`finish_by`, and receipt `received_at` share the existing ISO datetime
syntax with `Z` or a numeric offset (`±HH:MM`). Years must be AD 0001–9999 and
offset hours must be below 16 (including valid ±15:59 boundaries). The existing
ISO grammar rejects compact offsets such as `+1600` and `+1559`; this fix does
not enable a new format. Invalid values
return `422 validation_failed` before business writes or command/quota effects;
the same idempotency key can then submit a corrected value. Valid input keeps
its raw fractional precision through SQL binding; existing ordering, future-time,
receipt-time, ownership and version checks still apply.

Display-only external links (`public_url`, `demo_url`, marketing `share_url`,
author-claim evidence and squad artifact links) retain the existing public HTTPS
policy. Host checks ignore the single terminal DNS root dot: `printer.local.`
and the absolute single-label name `printer.` are refused just like their
non-absolute forms. A permitted public FQDN keeps its `URL.href` serialization, including
the terminal dot, path, query and fragment. These hostname policy rejections return
`422 invalid_external_url` before command facts are written; correcting the
link may reuse the same key. These URLs are not fetched or embedded by this
validator, and this change does not rewrite historical records or add DNS reads.

Catalog product `photo_url` and imported-shop `website_url`, product `photo_url`
and payment URLs use their own existing HTTPS policies, with the same terminal
DNS root-dot comparison. URL syntax and length checks must succeed before their
URL-dependent refinements run. Malformed values and private-host rejections
return `422 validation_failed`, not a URL-constructor error; rejected commands
write no business facts and can be corrected using the same key. Catalog photos
still permit otherwise-allowed public non-default ports and fragments; shop
URLs still refuse both. Permitted catalog/shop strings retain their spelling.
These guards add no DNS/network reads and do not rewrite historical URLs.

The runtime-neutral API envelope rejects `%00` (an encoded NUL) in the path or
query of `/api/v1/` requests with `422 validation_failed`, after host validation
and before route authentication or SQL. This applies even to anonymous requests
and otherwise unused query parameters; the error reveals no resource state.
Literal `%00` text must be encoded as `%2500` and keeps the route's normal
validation and authentication. Public HTML routes and request bodies retain
their existing validation; this is not a universal body-text NUL validator.

The generic JSON reader rejects decoded unpaired UTF-16 surrogates in string
values or object keys with `422 validation_failed`, including nested objects and
arrays. It does not replace or remove input characters. Valid surrogate pairs,
ordinary Unicode, newlines and literal backslash escape text retain their exact
values. Malformed JSON remains `400 invalid_json`; existing body limits and Origin
checks are unchanged. Rejection happens before a domain command can reserve its
idempotency key. Binary uploads, signed webhooks and dedicated child transports
retain their own raw-body readers; this policy does not replace those protocols.

Presence refresh has a live-session/active-member guard; authentication reads
the current Actor after that potentially blocking update, using the database clock.
Expiry, session revocation or member deactivation during a presence lock wait
returns `401 session_expired`, without a user/CSRF projection or renewed cookie.
This keeps the existing two database queries and the absolute, non-sliding
30-day session lifetime. Existing domain-level current-session and
authorization checks remain unchanged; presence is not an authorization grant.

## Community content search cursor boundary (#716)

`GET /api/v1/community-search` is available only with
`FREEDOM_COMMUNITY_SEARCH_ENABLED=true` (default off; otherwise 404).
Anonymous reads retain public-source visibility; a current member session adds
only that member's authorized community content.

Continue with the returned `next_cursor` unchanged. Its existing base64url tuple
has exactly three newline-separated fields: UTC sort text with six fractional
digits, a supported content kind, and a nonempty ID of at most 100 characters.
IDs may be skill-book slugs, not only UUIDs. Decoded C0 controls (including NUL)
and DEL in the ID, or any extra tuple field (even empty), return
`422 invalid_cursor` before source queries or search-operation recording.
Invalid cursors disclose no content or input fragments. Ordering continues to
compare the original microsecond sort strings; it does not round through
JavaScript dates. No feature activation or deployment is implied by this fix.

`GET /api/v1/community-search/mine` reads the member's taggable content on
one transaction client, awaiting posts, works, events and book appointments
sequentially. It does not rely on pg's deprecated implicit concurrent-query
queue. Source SQL, per-kind limits, current skill-book authority and response
shape stay unchanged; the final database-clock session check still runs after
all four projections. This changes neither feature activation nor driver version.

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
- `GET /admin/reports`: case summaries only, restricted to active platform
  administrators with verified email. Guild titles confer no access. Both list
  routes accept `limit` (1–50, default 20), optional `state`, and a descending
  `case_number` cursor. `state=open` selects received/in-progress cases;
  `state=all` or omitted state preserves the unfiltered list contract.
  `next_cursor` is null after the final page; new cases do
  not shift older pages. Lists never select private notes or evidence.
  Cursors retain the PostgreSQL bigint range `1`–`9223372036854775807` as
  strings, not JavaScript numbers. Bounded decimal-format validation short-circuits
  before `BigInt` conversion: text, fractions, exponent notation and out-of-range
  values return `422 validation_failed`, not an uncaught conversion error.
  Invalid list queries remain `no-store`, return no items/private evidence and
  create no report, receipt, journal or outbox entry. The existing anonymous
  `401`, non-admin `403` for valid queries and feature-OFF `404` boundaries remain unchanged.
- `GET /admin/reports/:id`: separately authorized case detail, including private
  notes and the immutable server snapshot. Member evidence retains the card
  content visible to the reporter, including only contacts they could see;
  transient presence, last-seen, self and friendship fields are not retained.
  Retracted messages are not reportable.
- `GET /admin/reports/:id/image`: admin-only private-message image evidence.
  Capture pins the existing immutable image target/object identity and digest;
  it does not expose the participant image route or trust a live message after
  retraction or reporter deactivation. Existing message-image targets/objects remain permanent and outside
  domain GC. No bytes are copied into receipts, JSON evidence, or public storage.
  The reader checks session/admin authority before and after object I/O and serves
  `private, no-store`, `Vary: Cookie`, and `nosniff`. The host needs the existing
  message-image object store; missing transport fails closed.
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
Pending migration `160_member_reports.sql` follows the integrated account and
participation migrations 156–159; published 001–148 bytes remain unchanged.
Evidence retention period and an owner-approved general rules/appeal page are
deferred to #261; no appeal contact is invented here.

The browser spec uses the existing per-test local HTTP feature fixture on the
owned schema. Enabled and default-OFF cases run in the ordinary suite, including
`npm run test:e2e -- tests/e2e/member-reporting.spec.ts`; no extra CI pass or trusted
pin change is needed. The admin view loads evidence on demand and supports state
filters and additional pages. Unknown transition results retain their exact
body/version/key and prevent list replacement until the same operation resolves.

## Existing member APIs

Generic JSON mutations accept at most 32 KiB of UTF-8 body bytes. The limit is
enforced while streaming, including requests without `Content-Length`; oversized
streams are cancelled with `413 body_too_large` before their remainder is read.

The generic reader recognizes `application/json` type/subtype tokens
case-insensitively and accepts ASCII SP/HTAB optional whitespace before
semicolon-delimited parameters, as specified by
[RFC 9110 §8.3.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-8.3.1)
and [§5.6.6](https://www.rfc-editor.org/rfc/rfc9110.html#section-5.6.6).
Prefix lookalikes (`application/jsonp`), other media types and non-HTTP
whitespace do not match. This changes neither parameter/charset handling nor
the body, Origin, session or CSRF guards; JSON bytes still use strict UTF-8.

The generic JSON reader decodes those bytes as strict UTF-8. Invalid sequences
return `400 invalid_json` before authentication or a domain command, rather than
being replaced with `U+FFFD` and saved. Valid Unicode, including an intentionally
encoded `U+FFFD`, retains its value; multi-byte characters may span stream chunks.
The size limit still counts the original bytes before decoding.

Binary uploads and signed machine transports retain their own bounded readers.
After valid JSON syntax is established, this general reader rejects decoded
NUL characters in string values or object keys, including nested arrays/objects,
with `422 validation_failed` before routing or authentication. It never strips
or replaces input: literal backslash-`u0000` text, normal newlines and Unicode
retain their exact values. Malformed JSON remains `400 invalid_json`; a rejected
body does not reserve a domain command's Idempotency-Key. This check applies
only to the general JSON reader, not the binary, signed-webhook or dedicated
child transports that already own their original body streams.

Owner share settings (`GET /me/member-card-share`), the owner social-link list
and the authenticated member social-link projection hold current user/session
locks through the database read and recheck `clock_timestamp()` after its last
domain query. Expiry during a SQL wait returns `401 session_expired` without
private values. The social-link audience predicate, count and page remain in
one statement snapshot; a projection callback alone is not an authentication API.

Social-link create/edit/delete commands commit before their separate current-value
readback. That readback has the same session fence, including tombstones and
receipt replays. A late 401 does **not** roll back an already committed command:
after logging in again, explicitly retry the same body/version/Idempotency-Key
to recover its current value or tombstone, without duplication or resurrection.
The decision is before commit, not a guarantee throughout response transport;
anonymous public-card sharing retains its separate policy.

Own account reads (`GET /me/account`), account-save readbacks and
`GET /me/avatar` metadata hold the current user/session locks on the same
database transaction through their final metadata projection, then recheck
`clock_timestamp()` before returning private data. Expiry during a SQL wait
returns `401 session_expired`; valid sessions retain the existing DTOs, including
account access before guild onboarding. No image bytes or object-store I/O run
under these metadata locks. An account update already committed before its
readback is not rolled back by that later 401: after logging in again, replay
the same command body, original version and idempotency key to recover the
current account without another version increment or journal entry.

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

The main portal Workspace keeps its original identity and CSRF lifetime (#584).
Browser tabs share the session cookie, so the existing visible-page 60-second
heartbeat and visibility-change check compare successful `/session` responses
with both the Workspace's user ID and CSRF token. A different account or a new
session for the same account ends the old local Workspace and returns to login;
it neither silently adopts the replacement identity nor logs out the replacement
server session. Unmounted or superseded Workspace heartbeats cannot end a later
login. An unchanged session stays open; transient read failures retain the
Workspace, and existing 401 handling remains in place. This does not add
cross-tab broadcasting or change the heartbeat frequency.

The existing scheduled auth maintenance also prunes email-verification and
login-email-change proofs (#494), consumed or unused, once `expires_at` is more
than 24 hours old, matching password-reset proofs' grace period. Each table uses
the same per-run batch limit (default 500) and `FOR UPDATE SKIP LOCKED`; live,
recently expired and currently locked proofs stay untouched, with skipped stale
rows eligible on a later run. This removes short-lived proof/address metadata,
not members, sessions, account journals or business history. It adds no new cron,
permissions, feature flag or mail provider; deployment remains separately
authorized. Node does not acquire an automatic scheduler through this change.

- `GET /api/v1/site`: brand, registration_enabled, demo_accounts_enabled, community.
- `POST /auth/register`: `{email,password,nickname?,contacts?}`. Password 12–128
  characters, nickname up to 60. A missing or blank nickname becomes
  `新夥伴 <8 hex characters>`; the email is never used as a display name. Returns the existing session JSON and cookie (201).
  Optional social contacts are `discord`, `github`, `line`, each `{value,audiences?}`
  with a private default. Registration has exactly one email input: `email`.
  A separate `contacts.email` input is rejected. Contact email always comes from
  the login identity; its audience starts empty (private).
- `POST /auth/login`: `{email,password,code?}`. Enabled MFA accounts first return
  `401 totp_required` without a session; submit the same email/password with a
  six-digit authenticator code or an unused backup code to complete login.
  Password login does not verify email or link providers; slugs confer no ownership.
- `POST /auth/reset/request`: `{email}`; requires the configured recovery sender
  and returns the same result for existing and unknown accounts. Issuance locks
  the current mailbox first; a request waiting behind an email switch receives
  neither a proof nor a message for the old address (#552).
- `POST /auth/reset/confirm`: `{token,password}`; a valid one-use mailbox link
  changes the password and revokes old sessions atomically. Without MFA it returns
  `{reset,expires_after_minutes,user,csrf_token}` and a new session cookie.
  Enabled MFA instead returns `{reset:true,totp_required:true,expires_after_minutes}`
  without a session: return to login and supply the second factor. Resetting a
  password does not disable MFA or replenish its attempt budget. Invalid, expired
  and inactive proofs are rejected. See [password-recovery.md](password-recovery.md).
- `GET /me/totp`: `{enabled,backup_codes_remaining}` for the current member.
- `POST /me/totp/enable`: `{password,secret,code}`; secret is 20 browser-generated
  random bytes encoded as 32 uppercase Base32 characters. The browser shows the
  provisioning secret locally, never in an API response. A valid password and
  RFC 6238 SHA-1 code (six digits, 30 seconds, ±1 step) enable MFA and return ten
  96-bit backup codes once. Store them securely; only SHA-256 hashes are retained.
  Replay returns 409 rather than recovering plaintext codes. After a lost enable
  response, the UI rereads state and explains using the enrolled authenticator
  to disable/re-enroll for fresh codes; it never replays backup plaintext. State-only command
  receipts and metadata-only audit facts never contain secrets or backup codes.
- `POST /me/totp/disable`: `{password,code}`; requires password plus an unused
  authenticator or backup code. Successful disable deletes secret and code hashes.
  Enable/disable require CSRF and Idempotency-Key but no If-Match; both revoke
  all other member sessions. Reusing an operation key with changed content conflicts.
  Failed enrollment, disable and login second factors share a persisted per-user
  budget of ten failures per 15 minutes, serialized with the member row. New
  password-only submissions cannot reset it. Accepted counters are monotonically
  consumed, including enrollment, and backup deletion is atomic.

Hosts must install a dedicated `TOTP_ENCRYPTION_KEY` (canonical Base64 of 32 random
bytes) as a Node environment secret or Worker secret binding before enrollment.
The member secret is AES-256-GCM encrypted with user-bound associated data.
Missing/malformed keys fail closed with `503 totp_unavailable` for factor checks;
ordinary accounts still log in. Keep the key stable and securely backed up:
changing it without separately migrating ciphertext makes enabled factors unreadable.
No deployment, remote key installation or authenticator-device acceptance is implied.

The login form invalidates a pending authenticator challenge and clears its code
when the active authentication mode, email or password changes, not when a new
challenge arrives or its code is entered. Skip reset dispatches when the challenge
is already off and the code already empty. Unconditional same-value resets on
every credential keystroke can exhaust React's nested-update limit during rapid
native typing and lose an email character before registration succeeds. Keep
authenticator/backup-code entry intact while retaining credential/mode invalidation.

- `POST /me/account/email-verification/request`: `{}`; authenticated member with
  CSRF, including before onboarding completion. The account page exposes send/resend.
  Uses the existing transactional `eventEmailSender` adapter (Worker `EMAIL`
  binding; Node injection), with a verification-specific subject/body. Missing
  configuration returns 503 `email_verification_unavailable`; delivery failure
  returns 503 `email_verification_send_failed` and removes that proof.
  Persistent budgets: 3/member/hour, 12/network/hour, 500/global/hour.
- `POST /auth/email-verification/confirm`: `{token}`; same-origin JSON request,
  no login required. The mail link `/#verify-email/<token>` opens a confirmation
  page. A 30-minute, hashed, single-use proof marks only the issued login email
  verified; changed email, inactive user, expired/reused proof return 422
  `email_verification_link_invalid`. Successful confirmation consumes all
  outstanding verification proofs for that user, without logging in or changing
  passwords/sessions. Confirmation budgets: 30/network/hour, 500/global/hour.
  Expiry is rechecked against the database clock after consuming outstanding
  proofs, before the transaction returns (#492). Expiry during proof-lock or
  competing-proof waits rolls back verification and all proof consumption;
  another still-valid link remains usable.
  Apply migration `157_email_verification.sql` before using these routes; no
  deployment or mail-provider availability is implied by this implementation.
- `GET /me/account`: `{user_id,nickname,identity_label,login_email,email_verified,contacts,
  aggregate_version}`. Each contact additionally has `verified:false`.
- `POST /me/account/email-change/request`: authenticated, CSRF-protected
  `{email,password}`; verifies the current password and sends a 30-minute link
  to the normalized new address. Duplicate/current emails are rejected. Latest
  request replaces earlier proofs. Requires the existing generic mail sender
  (`eventEmailSender` / Worker `EMAIL`) and migration 156. The requesting session
  is checked again after proof replacement, before handing the committed proof to mail.
- `POST /auth/email-change/confirm`: `{token}`; the public `#change-email/<token>`
  page requires an explicit confirmation action (GET does not consume it).
  Proofs are one-use, SHA-256-only at rest, bound to the old email and password
  credential. Switching verifies the new mailbox, invalidates password-reset
  links, increments account version, audits without addresses/tokens, and
  revokes every session except the requesting session. An expired requesting
  session is not renewed. Old-address notification delivery failure rolls back
  the change and permits retry. Mail-provider acceptance is not an inbox delivery
  guarantee; a lost database commit after mail acceptance can cause a duplicate
  notification on retry. The old-address notice describes a change attempt, not
  committed success: delivery can cross the final proof expiry check, which still
  rolls the transaction back. No production delivery/deployment is claimed.
- `POST /me/account`: `{nickname,identity_label?,contacts}` (all four contact entries, **without**
  `verified`); social entries are `{value,audiences}`; email is **only**
  `{audiences}`. Sending `email.value` is rejected. GET still includes the
  authoritative email value for display. This API cannot change the login email.
  Returns current account, never another member's private settings.
  `identity_label` is optional `male | female | alien | ai | null`: omitted preserves
  the current value, null clears it. Default null; self-selected, never inferred.
  It is visible with the authenticated same-community card, and does not grant authority.
  Nickname is the editable community display name; use the name familiar to your community.
- `POST /me/password` (#397): `{current_password,new_password}`; the signed-in
  member re-proves the current password (same 10-failure/15-minute lockout as
  login, keyed per member), stores the new 12–128 character password, revokes
  every other session and keeps the proving session. Returns
  `{changed:true,revoked_sessions}`; wrong password → 403
  `current_password_invalid`, unchanged → 422 `password_unchanged`, locked → 429
  `password_change_rate_limited`. No command receipt: the password never enters
  a request digest; the journal records only the revoked count and advances the
  account `aggregate_version`.
- `GET /me/sessions`: `{items:[{current,created_at,last_seen_at,expires_at}],total}` —
  the member's live sessions (≤50, current first); no token material is returned.
- `POST /me/sessions/revoke-others`: `{}` with `Idempotency-Key`; ends every
  session except the current one and returns `{revoked_sessions,aggregate_version}`.
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
  私人名片、目錄、好友目錄與推薦在最後一個 domain query 後重驗目前 session；SQL 等待跨過 `expires_at` 時回 `401 session_expired`，不回傳私人聯絡資訊。
  `memberCards` 也在投影前（包括零筆結果）沿用 `assertInteractionMember` 重驗觀看者
  目前的 active／加入資格，不信任入站 middleware 留下的 ready Actor。user row 鎖等待
  期間若已提交加入資格重設，名片、目錄、好友與推薦均回 `403 onboarding_required`，
  不回 contacts、items 或 total；原 session 期限檢查仍獨立存在。原本不要求 onboarding
  的會員仍依既有 predicate 可讀；允許未完成加入者使用的帳號／加入流程未改。
  原生 HTTP 回歸用真 user row lock 覆蓋各 consumer 的非空／空結果與有效控制；
  這不是把加入限制塞進通用 `readWithMemberSession`，公開 opt-in 名片也未改。
- `GET /friends/directory?scope=accepted|incoming|outgoing&search=&limit=20&offset=0`:
  `{items,total,next_offset}` with the same privacy-filtered member cards. Scope and
  search are applied before the bounded 1–50 row page; blocked or no-longer-visible
  members are rechecked before return. The member directory reads the first incoming
  page and shows its total; a notification target outside that page is re-read through
  `GET /members/:id` and shown only while it is still an incoming request.
  A definitive focused-member 404 omits that target; transient lookup failures
  instead show the invitation error and retry the same focused lookup. Successful
  retry still rechecks incoming state and deduplicates the first-page target.
  “查看完整好友邀請” opens the full panel in incoming scope, not accepted friends;
  ordinary friend navigation retains its accepted-scope default.
- `POST /friends/:id/request|accept|remove`: `{}`. First request needs no version;
  accept/remove and renewed removed friendship need current version. Only the
  recipient can accept. Pending requests grant **no** contact access. Remove
  revokes access immediately. Repeat requests do not accept another's invitation.
- `GET /members/presence?ids=<comma-separated UUIDs>`: up to 50 IDs;
  `{items:[{user_id,last_seen_at,is_online}]}`, with a nullable last-seen timestamp.
- `GET /squads?limit=20&offset=0`: `{items,next_offset,kinds}`. Items include
  `squad_id,name,kind,purpose,owner_ref,owner_name,member_count,membership`.
  Membership is null or `{state,aggregate_version}` for the current user.
- `POST /squads`: `{name,kind,purpose,communication_channel_name?}`. Kinds keep
  their persisted keys: `project` 開源專案合作團隊, `mutual_help` 生意機會合作團隊,
  `coaching` 技能學習陪跑小隊, `social` 吃喝玩樂交流小隊. Creator becomes its
  first active member. The portal opens member search immediately after creation;
  the owner can also use the directory card's 邀請夥伴 action. Invitations retain
  recipient consent and grant no membership or contact access before acceptance.
- `GET /me/squad-invitations`: recipient-only `{items,next_offset}` with
  `state=pending|all`, `limit` 1–50 and bounded `offset`. Like the outgoing
  owner-only invitation list, it reads through `readWithMemberSession`:
  active user and current session locks, onboarding and domain queries on
  the same transaction client, then a final SQL wall-clock session check.
  A domain wait crossing session expiry returns `401 session_expired`,
  without private invitation rows or an empty-list success. Existing owner
  eligibility, community filters, visibility and pagination remain unchanged.
- `GET /squads/:id`: squad plus `members` with `user_id,nickname,state,
  aggregate_version`. Pending members visible only to themselves and owner.
- `POST /squads/:id/request`: `{}` requests admission; no immediate group access.
- `POST /squads/:id/members/:userId/accept`: owner accepts an existing pending
  request with that membership's version. Cannot add an unconsenting member.
- `POST /squads/:id/members/:userId/decline`: owner declines a pending request
  (membership becomes `left`; they may ask again). `.../remove`: owner removes an
  active member other than themself and the member receives a
  `squad_member_removed` notification. Both need the membership version (#400).
- `POST /squads/:id/leave`: member leaves with current membership version, revoking
  squad-scoped contact access. The owner cannot leave (`409
  squad_owner_cannot_leave`) until they transfer or disband.
- Owner-only, all with the squad `aggregate_version` as `If-Match` and the squad
  row locked before membership or invitation rows: `POST /squads/:id/profile`
  `{name,purpose}`; `POST /squads/:id/transfer` `{user_id}` to a current active,
  visible member under the same 10-squad owner limit (pending invitations the old
  owner sent are withdrawn); `POST /squads/:id/disband` `{}` sets `disbanded_at`,
  every membership becomes `left`, pending invitations are withdrawn, the squad
  leaves lists/detail (404) and its channel stops accepting reads/writes. History
  rows and the journal stay. Disbanded squads do not count toward the owner limit.
  The classification view excludes them even for the preceding Worker release;
  SQL triggers reject new pending/active memberships and pending/accepted
  invitations to disbanded squads, fencing old writers after rollback. Current
  channel reads also check the marker. A lost disband response is reconciled by
  detail reload: a 404 closes the stale owner controls and returns to the list.
  No three-person minimum or commercial eligibility is implied.

Squad detail and the owner-only invitation history hold the current member
user/session locks, then a `FOR SHARE` lock on the live squad, through their
database projections. Transfer and disband use the same user/session → squad
ordering and cannot change that owner/active grant between metadata and private
roster/history queries. A read serialized before cutover may return its then-legal
projection; it must not borrow old-owner metadata to reveal a pending request
created for the new owner, or pair active metadata with a disbanded roster.
After cutover, the former owner has ordinary member visibility, outbound history
requires the current owner, and disbanded detail is 404. The session clock is
rechecked after the last query before commit; this is not a guarantee during
response transport or a single MVCC snapshot for every roster fact.

Private presence, squad lists and squad detail recheck the viewer's current
active/onboarding qualification with `assertInteractionMember` inside that
member-session transaction, before any projection or empty-result return. If a
user-row wait ends after an onboarding reset commits, they return
`403 onboarding_required` without presence, squad, roster, items or kinds.
Legacy members with `onboarding_required=false` retain their existing access.
This does not add onboarding restrictions to the generic session helper or
the account/onboarding flows that intentionally allow unfinished membership.

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

## Personal contribution records

`GET /api/v1/me/contribution-records?limit=20&offset=0` returns the signed-in
member's durable community-collaboration acceptance facts. `limit` defaults to
20 and is capped at 50; `offset` must be a non-negative integer. The response
keeps `policy: accepted_work_facts_v1`, the exact full `accepted_count`, and the
existing private entry fields, plus `next_offset` (`null` on the final or an
empty trailing page). Entries are ordered by `accepted_at` descending and
`contribution_id` descending for stable timestamp ties.

The reader holds the current member session and executes the count and bounded
page in one PostgreSQL statement on the same transaction client. A relation
wait that crosses session expiry returns `401 session_expired` without a
partial page. Records remain scoped to the actor and community-collaboration
Work; the shared accepted-work feed and contribution-outcomes API are separate
projections.

## Legacy retail catalog pages

`GET /api/v1/retail/catalog?limit=20&offset=0` returns the signed-in member's
community catalog as a bounded page. `limit` defaults to 20 and is capped at 50;
`offset` must be a non-negative integer and unknown query keys are rejected.
The response is `{items,next_offset}`, where `next_offset` is `null` on the
final or an empty trailing page. Ordering is stable by `created_at` descending,
then `product_id` descending.

Each item retains the latest immutable supplier offer, supplier name,
community scope, verification-test-account exclusion, and
`internal_preview` limits. Pagination does not turn this legacy member catalog
into a public retail feed or enable checkout.

The generated `freedom.preview/v1` revision `0.4.1` SDK uses a separate
`CatalogPage` response; the supplier's full `ProductList` remains unchanged.
Call `client.call('listCatalog', {query:{limit:20,offset:0}})` and pass the
returned `next_offset` explicitly for the next page. The canonical query schema
also generates OpenAPI parameters and TypeScript types; unknown or out-of-range
query values are rejected before credentialed HTTP. Consumers must deliberately
update their exact source/bundle pins; protocol hash negotiation remains strict.

## Private marketing campaign pages

`GET /api/v1/marketing/campaigns?limit=20&offset=0` returns only the signed-in
member's private campaign drafts. `limit` defaults to 20 and is capped at 50;
`offset` must be a non-negative integer and unknown query keys are rejected.
The response is `{items,next_offset}`, with `next_offset: null` on the final or
an empty trailing page. Drafts use stable `created_at DESC, campaign_id DESC`
ordering, and each item retains its pinned source snapshot and manually
reported share records.
The regenerated `freedom.preview/v1` revision `0.4.1` bundle and SDK include
the bounded `CampaignList` response and its required nullable continuation.
Consumers must deliberately update their exact source/bundle pins; old SDKs
reject protocol skew rather than silently accepting a changed response.
Call `client.call('listCampaigns', {query:{limit:20,offset:0}})` and pass the
returned `next_offset` explicitly for the next page. The operation's declared
query parameters generate OpenAPI and TypeScript types and are validated before
credentialed HTTP; the SDK does not silently ignore pagination options.

Pagination does not publish drafts, write to an external platform, verify a
share, or infer reach, conversion, payment, or income.

## Organizer event referral reports

`GET /api/v1/events/:id/referrals?limit=20&offset=0` returns a bounded page of
sharing members' `user_id`, `member_name`, registrations and clicks only to the
same-community organizer. `limit` defaults to 20 and is capped at 50; `offset`
must be a non-negative integer. The response includes `items`, the exact
`total`, and `next_offset` (`null` on the final or an empty trailing page).
Rows are ordered by registrations descending, then member name and `user_id`
for stable ties. The Portal renders the first 20 rows and explicitly loads each
following page without discarding already-visible rows when a request fails.
Retry retains the offset of the failed request, separately from the last page's
`next_offset`. A failed offset-zero refresh therefore retries zero and replaces
the visible rows on success; a failed continuation retries its own offset and
appends only after success. Existing request/session generation fences still
discard superseded responses.

Other members receive `403 organizer_required`. The route holds current
user/session locks and runs the organizer authorization and report queries on
that same transaction client. After the final projection it checks the
PostgreSQL wall clock: a SQL wait crossing session expiry returns
`401 session_expired`, without a report page. Existing statistics,
verification-account exclusions and public event readers are unchanged.

## Member event bulletins

`GET /api/v1/events/bulletins` returns currently visible event bulletins,
including actor names and messages containing event titles. Guild-only events
remain limited to their organizer or current active guild members; other members
do not receive those items. The route holds current user/session locks while the
unchanged bulletin projection runs on the same transaction client, then checks
the PostgreSQL wall clock after its final query. A SQL wait crossing session
expiry returns `401 session_expired`, without an `items` projection. Visibility,
verification-account exclusions, ordering, the 30-item limit and public readers
are unchanged.

## Event submission budget

`POST /api/v1/events` permits five newly committed submissions per member in a
one-hour window. The PostgreSQL budget is locked and updated in the same
transaction as the event, bulletin, notifications and receipt; concurrent requests
cannot exceed it, and failed commands do not consume it. At capacity, new
submissions return `429 auth_rate_limited` without those side effects. Exact
Idempotency-Key replays remain available without consuming another slot.
Five per hour is a provisional value (#199); it is the named constant
`eventCreateLimit` in `modules/community/events.ts`.

## Member event detail session boundary

`GET /api/v1/events/:id` reads its existing authorized event DTO through
`readWithMemberSession`: active user and current session locks, all detail
queries on the same transaction client, then a `clock_timestamp()` session
check after the projection. A database wait that crosses session expiry returns
`401 session_expired`, without the event DTO or private `online_url`.
Existing event visibility, pending-owner/reviewer and referral redaction rules
are unchanged. This is a final database read decision, not a guarantee of
session validity through commit or HTTP delivery; it does not cover other event
routes. The shared `readEvent` background reminder path remains unchanged.

Standalone localhost HTTP evidence on isolated PostgreSQL 17 schemas used
password login and normal pending-event submission: both baseline and candidate
returned a nonempty private detail control; a confirmed projection lock wait
began while the session was live, and the database clock crossed expiry before
release. Baseline `afe8b692` returned the private DTO with HTTP 200; candidate
`a2230f24` returned HTTP 401 without event data. This synthetic local evidence
does not establish deployment or global event-route coverage.

## Member event list session boundary

`GET /api/v1/events` reads its existing member list through
`readWithMemberSession`: active user and current session locks, list SQL on the
same transaction client, then a `clock_timestamp()` session check after the
projection. A database wait that crosses session expiry returns
`401 session_expired`, without an `items` projection. Existing own-pending,
guild membership/reviewer visibility, newcomer-safe columns, history limits
and referral redaction are unchanged. This is a final database read decision,
not a guarantee of session validity through commit or HTTP delivery; it does
not cover other event routes or change background reminder reads.

Standalone localhost HTTP evidence on isolated PostgreSQL 17 schemas used
password login and normal pending-event submission: both baseline and candidate
returned a nonempty private list control containing the owner's pending event
and its `online_url`; a confirmed projection lock wait began while the session
was live, and the database clock crossed expiry before release. Baseline
`afe8b692` returned the private list with HTTP 200; candidate `8b743465` returned
HTTP 401 without activity data. This synthetic local evidence does not establish
deployment or independently exercise every visibility/newcomer variant.

## Event highlights and published squad outcomes (#257)

This source candidate adds `154_squad_outcomes.sql` and
`155_event_outcomes.sql`. Apply both **before switching source, even with
features off**: existing highlight media readers always check persisted
bindings. `FREEDOM_SQUAD_OUTCOMES_ENABLED` and
`FREEDOM_EVENT_OUTCOMES_ENABLED` default off; event outcomes require squad
outcomes, and an incomplete combination fails runtime configuration. Disabled
new API routes return 404 before authentication. Flags off do not erase
bindings or bypass their ACL. Do not roll back to a reader that ignores them.

The agreed publishing boundary is the current active squad owner publishing
their own authored outcome, not a formal #261 policy, roster projection,
private Result or inferred team acceptance. All member routes below use
`/api/v1`, existing session/CSRF and Idempotency-Key controls; edits, publishing
and withdrawal require quoted `If-Match` for the outcome's aggregate version.
Stale commands return 412 without replacing the browser's unsaved input.

| Route | Body / projection |
| --- | --- |
| `GET /squads/:id/outcomes?limit=&offset=` | Current readable outcomes; default 20, maximum 50; `next_offset` and offset at most 10000. |
| `POST /squads/:id/outcomes` | Private draft `{title,summary,artifact_url?}`; title 1–120, summary 1–4000; optional HTTPS public-host source link, no fetching. |
| `GET /squad-outcomes/:id` | Own management history or current published reader projection. |
| `POST /squad-outcomes/:id/edit` | Same draft fields; resets scope to squad and clears previous publication consent. |
| `POST /squad-outcomes/:id/publish` | `{audience:squad|community|public,consent_to_share:true}`; explicit rights, persons and author/squad-name sharing consent. |
| `POST /squad-outcomes/:id/withdraw` | `{}`; stops current published use without deleting truthful author history. |
| `GET /me/squad-outcomes` | Own authored history. |
| `GET /event-highlights/:id/outcomes` | Currently readable published recaps. |
| `GET /event-highlights/:id/outcomes/own` | Own drafts/published/withdrawn history, not another author's private data. |
| `GET /event-highlights/:id/outcome-references` | Bounded current, same-community source picker (at most 100). |
| `POST /event-highlights/:id/outcomes` | Private draft `{title,summary,audience:community|guild|public,refs:[{kind,id}]}`; maximum 8 unique references. |
| `GET /event-outcomes/:id` | Own management projection. |
| `GET /event-outcomes/:id/published` | Current published ACL, with no own-history exception. |
| `POST /event-outcomes/:id/update` | Same draft fields, clears publication consent; event/author cannot be rebound. |
| `POST /event-outcomes/:id/publish` | `{consent_to_share:true}` for the saved scope and current readable sources. |
| `POST /event-outcomes/:id/withdraw` | `{}`; hides bound media and backlinks. |
| `GET /event-outcome-backlinks/:kind/:sourceId` | Current authorized event/detail links, never cached private labels. |

Reference kinds are `work`, `skill_book` and `squad_outcome`; arbitrary,
foreign-community, withdrawn or unreadable targets are rejected. Work means
the original published community showcase, never a private Result, so it
cannot be placed in a public recap. Skill books use original curated or public
submission readers and retain attribution/self-declared relationship
boundaries. A squad source must still be published and currently readable;
own withdrawn history does not grant reuse. Guild scope requires an original
guild event and current publisher/viewer membership. Any unreadable source
hides the **whole** dependent recap, bound media and backlinks.

Legal current event members can author recaps for ended events; Going is not
required or asserted as attendance. Each event has at most 100 recap records.
The original photo/poster/link upload pipeline remains authoritative.
JSON link/image metadata may include `outcome_id`; raw photo/poster uploads
use `X-Event-Outcome-Id`. Binding verifies the same author/event in the
original atomic media transaction. A draft binding is private to its author;
it cannot become an anonymous gallery item until explicit eligible publication.
An invalid later file leaves earlier successes intact; the browser reloads
them and retains only failed/not-yet-sent files rather than re-uploading
successful ones. Uploading without a binding uses the original event ACL,
not an invented private gallery.

Anonymous equivalents use `/api/v1/public` for published squad/outcome,
event-outcome list and backlink reads. `/squad-outcomes/:id` is the canonical
public squad detail. Member source navigation uses `#showcase/:id`,
`#squad-outcomes/:id` and original skill canonical pages. Backlinks return
`#highlights/:eventId`; canonical skill HTML prefixes member fragments with
`/` so they actually return to the portal. Its personalized backlink HTML is
`no-store` with `Vary: Cookie`, without making private recap text OG metadata.

Anonymous original highlight HTML, metadata, banners and gallery bytes admit
only open/referral events; workshop/guild details return 404. Member media
routes `/event-highlights/media/:id/image|thumb` and
`/event-highlights/:id/banner` recheck current event/member and source ACL,
including a fence after object I/O. Media is `no-store`; disabling features
does not restore withdrawn bytes or detach bindings. Withdrawal cannot recall
previously downloaded or third-party-cached copies.

Member JSON reads `GET /event-highlights` and `GET /event-highlights/:id` run
their whole composed projection (events, items, bound-outcome authorization,
admin flag and quota) on one locked member session and recheck the database
clock after the last query. Expiry during a SQL wait returns
`401 session_expired` with no event list, detail, item or quota data,
including an otherwise empty page. Revocation or deactivation committed
before the corresponding user/session lock is acquired is rejected.
Writers queued behind the read's `FOR SHARE` locks wait for that read
transaction to finish; a still-valid read may therefore return 200.
Valid sessions keep the same DTOs, ordering,
cursor, visibility and 404 behavior; anonymous public HTML keeps its separate,
session-free contract.

Private outcome JSON and authenticated skill backlink HTML hold current
user/session locks through their database projection and recheck expiry with
the database clock after its last query. Member media takes separate short
session-and-ACL snapshots before and after object I/O; revoked or expired
sessions return `401 session_expired` even when the underlying event is public.
The anonymous media endpoint continues to enforce its own public policy.

Local isolated database/browser checks are not trusted CI, deployment,
flag-on, actual attendance, formal acceptance, XP or external delivery evidence.

## Public event registration page

The public `/public/events/:id/register` form owns its draft, saving state and
feedback by event identity. SPA navigation to another event starts a blank
form; late success or failure from the previous event cannot confirm, block
or unlock it. Returning to the first event creates a new form lifetime.
Same-event focus revalidation keeps unsent input. Leaving the page does not
cancel a committed registration or recall a provider-accepted email.

## Event calendar, reminders and waitlists (#256)

The candidate uses migration `153_event_participation.sql`. Apply it **before
switching source, even with the feature off**: existing RSVP capacity and guest
acknowledgement paths also use its columns. The new routes and UI require
`FREEDOM_EVENT_PARTICIPATION_ENABLED=true` (default off); disabled routes return
404 before authentication. Worker enablement requires a usable `EMAIL.send`
binding. This is not deployment, sender authorization or trusted CI evidence.

All routes below use `/api/v1`. Member routes retain session, CSRF,
Idempotency-Key and quoted If-Match controls:

- `GET /events/:id/participation`: current event version, own RSVP/waitlist and
  available seats, never other participants' identities or contact details.
- `POST /events/:id/waitlist`: `{action:join|leave|accept|decline,referral_code?}`.
- `PATCH /events/:id/waitlist-policy`: organizer-only
  `{waitlist_enabled,response_window_minutes}`; enabling requires an explicit
  positive safe-integer number of minutes, with no default window.
- `PATCH /events/:id/schedule`: organizer-only `{starts_at,ends_at,capacity}`;
  ISO timestamps, end after start, capacity null or 1–500.
- `GET /events/:id/calendar`: `{calendar,filename}` for a currently readable
  event. The browser downloads those bytes as a private `.ics` Blob.
- `GET|PATCH /events/:id/reminder`: the independent reminder version and choice;
  mutation `{enabled,minutes_before_start?,channel?}`. Enabling requires Going,
  an explicit positive safe-integer lead time and `in_app` or `email`.

The original `POST /public/events/:id/register` remains separate from the optional
participation API. After its event/reservation waits, it checks the current pending
hold against the database wall clock immediately before provider handoff. An
already-expired hold cannot send participation details; an existing confirmed
registration may resend. This does not recall a message handed off while its hold
was still valid or change the existing provider-in-flight transaction boundary.
Its confirmation transaction rechecks `starts_at` against the
database wall clock after provider handoff and all participation writes, before
commit. If that wait crosses the start, it returns `409 event_closed` and rolls
back this confirmation; the earlier pending reservation remains unconfirmed.
An already-confirmed registration and its earlier email marker are preserved.
The provider may already have accepted the notification, so this error does not
mean that no email was handed off or that an existing registration was erased.

Legal public guests request a mailbox management link with
`POST /public/events/:id/participation-request` and
`{name,email,referral_code?}`. Requesting it does not register, join the queue or
enable a reminder. Existing network/email/global registration budgets apply.
Its acknowledgement means provider acceptance, not inbox delivery.
The private link uses `#participation=<opaque-token>`; treat it as a bearer
credential and do not forward it. The client keeps it in memory and sends only
`X-Event-Participation-Token` to that event's guest participation, calendar or
reminder endpoint, never query parameters, storage, telemetry or ICS content.

- `GET /public/events/:id/participation|calendar|reminder` returns the authorized
  guest's projection. `POST .../participation` accepts member queue actions plus
  `register|cancel`, and `expected_version` matching the quoted event If-Match.
- `PATCH /public/events/:id/reminder` accepts the reminder choice plus
  `command_id` matching Idempotency-Key and numeric `expected_version` matching
  the reminder If-Match; guests may select only `email`.
- Guest command keys are 8–128 base64url characters. Exact command replays do
  not create another action or physical send. A stale version returns 412;
  the UI retains the draft. An unknown response freezes the submitted command
  for explicit retry with its original key/body/version, while retaining edits.

All new endpoints use `private, no-store` and `noindex, nofollow`. Reads and
dispatch recheck source visibility, current guild/account eligibility, referral
codes and verification-test exclusions. Cancelled history remains accessible
only with a genuine own RSVP or waitlist history; possession of an unrelated
link or a bare cancelled reservation does not grant access.

An event lock serializes capacity changes, original RSVP and queue commands.
Occupancy includes confirmed Going, unexpired ten-minute public guest
reservations and live offers, without counting an identity's own overlapping
reservation twice. The agreed deduplication boundary is member ID separately
from trimmed lowercase guest Email; no inferred member/guest identity linking,
mailbox-alias equivalence or real-person verification is claimed.
FIFO uses join time with a stable tie-breaker; leaving and rejoining goes to the
back. Offers reserve seats, require explicit acceptance and expire no later
than event start. Decline/expiry advances the queue. Capacity cannot fall below
confirmed/live pending occupancy; excess newest unaccepted offers return to
their original queue positions. Genuine transitions retain factual history,
not invented participant actions or attendance.

A new acceptance checks PostgreSQL's current clock after reconciliation and
eligibility reads, then again after the RSVP, queue/journal and success receipt
writes. Waiting past the original offer deadline returns
`409 invitation_unavailable`; crossing event start returns `409 event_closed`.
The new command and its reconciliation, transitions, RSVP and receipt roll
back together. Already-completed acceptances retain their factual history:
an exact successful receipt replay or an already-accepted Going no-op does not
become invalid merely because its historical offer deadline has passed.

The existing Worker ten-minute schedule performs bounded round-robin queue
reconciliation and reminder dispatch; affected mutations also dispatch queue
updates. There is no minute-precision SLA or automatic scheduler in Node.
Cancelled RSVP/event stops unsent reminders; rescheduling fences old attempts
and uses the current start. Durable attempt identities prevent repeating the
same start/lead/channel send, including a round-trip reschedule. Ambiguous
physical sends are not automatically retried. Reminder status `provider_accepted`
means only sender acceptance, `recorded` means a station notification was
recorded, and `pending|cancelled|failed` are not delivery claims. In-app starts
respect current notification preferences and quiet hours; essential invitation,
schedule and cancellation notices retain their transactional classification.

The candidate cutoff is bounded, but dispatch does not reuse a batch-start
timestamp after event/source/preference locks. Without an explicit fixture
`now`, the worker refreshes its clock for reconciliation, quiet-hour decisions
and the final notification/email handoff decision. An event already started
at that decision cancels unsent reminders, without a new notification or email.
If an attempt insert itself waited across the start, its durable `failed`
reservation remains while the reminder becomes `cancelled`; it is not delivery
evidence and is not retried. A fixed fixture `now` stays fixed. This does not
promise commit before event start or undo an email already handed to a sender.

ICS has stable event UID, UTC start/end, aggregate-version SEQUENCE, cancellation
STATUS and RFC text escaping/octet folding. It does not turn private locations
or joining links into a public calendar feed. Import is a manual snapshot:
redownload after changes; no automatic subscription/update is promised.
Guest calendar reads take the event's `FOR SHARE` lock before capability/RSVP
resolution and generate the ICS on that same transaction client. This follows
the event → capability order used by participation mutations: cancellation
already holding the event lock must commit before the reader selects its source.
Cancelled events retain only authorized history with `STATUS:CANCELLED`; a
cancelled RSVP no longer includes private location or joining links. This does
not recall previously downloaded calendar snapshots.
Isolated browser download, UTC/time-zone and independent parser checks do not
claim an actual Apple/Google Calendar import, external Email delivery, Worker
cron deployment, attendance rate, XP, ticketing or payment completion.

## Personal content inventory query compatibility (#573)

`GET /api/v1/me/content` requires an active member session and the existing
`FREEDOM_PERSONAL_CONTENT_ENABLED` flag. It reads the owner's original showcases,
skill submissions, events and social posts, including private and closed records;
it does not grant publication or bypass the original commands' authorization.

The inventory uses one transaction client and awaits its four source queries
sequentially, without relying on the driver's deprecated non-pipeline query queue.
Session/user locking and a final PostgreSQL physical-clock check still surround
the entire projection: a source lookup that waits beyond session expiry returns
`401 session_expired` without inventory data. The existing source SQL, ordering,
native states, visibility and actions remain unchanged. This source change is
not deployment, a driver upgrade or Foundation acceptance evidence.

## Optional first participation (#259)

This source candidate adds `152_first_participation.sql` on top of #344's
personal-content prerequisite. `FREEDOM_FIRST_PARTICIPATION_ENABLED` defaults off
in Node and Worker; `/site` exposes `first_participation_enabled`. Enabling it
requires `FREEDOM_PERSONAL_CONTENT_ENABLED`. Disabled routes return 404 before
authentication; invalid dependency combinations fail closed before pool/static work.

The optional home card follows lawful quick guild entry, not a compulsory
assessment, GitHub/AI binding or friendship. Its two choices return to original
consented showcase publishing or the selected primary guild's original chat.
Teaching examples are fictional and never prefill or publish. Native #193 public
questions are unavailable; guild chat is not a substitute public post.

`GET /api/v1/me/first-participation` returns versioned choice, selection time,
state, current completion, own private draft resume and reception preference.
`POST` accepts `{action:"choose",choice:"work"|"introduction"}` or an action of
`skip`, `dismiss`, `resume`, `request_reception`, `stop_reception`, with the
existing If-Match/Idempotency-Key contract. No client completion flag is accepted.
Selection, suppression and opt-in survive relogin; content is not copied.
Unknown transport outcomes retry the identical body/version/key. Late results
cannot navigate a subsequent account. Unsent chat is browser-memory-only.

Only an original first showcase-publication journal fact or actual own selected
guild message at/after selection completes a chosen path. Old publications,
private drafts and page opens do not. Projections recheck current ownership,
community, visibility and guild membership. A retracted introduction is unavailable;
retracted replies are excluded, and reception filters the original first source
before pagination. Later messages do not replace it. Withdrawal/revocation produces
`source_unavailable`, null completion and no cached title/link. Draft resume
opens original own content. Guild links preserve the selected guild after reload.

`GET /api/v1/first-participation/reception?offset=0&limit=20` lists explicitly
opted-in currently readable same-community requests, with ACL before pagination
(limit 1–50, offset 0–10000). `POST .../reception/:userId/claim` and `/release`
accept `{}` with the target If-Match/key. Eligible volunteers may claim another
member; concurrent claims have one winner. Disabled/ineligible claimants are
not presented as active. Stopping removes the request. No email/contact/private
draft is exposed. Claims do not send messages, add friends or certify identity,
quality or response. Guild reply counts include other-author replies only;
own work counts private opportunities and volunteers receive null.
Claim and release validate then normalize the target UUID to lowercase before
self checks, the per-requester advisory lock and database access. Equivalent
UUID spellings share one CAS decision: two volunteers using the same version
receive one success and one `412`, never two acknowledged claimants. The member
cannot claim or release their own request through alternate UUID casing; both
return `403 self_claim_forbidden`. Existing receipt identities remain unchanged.

Local verification is synthetic source evidence only. Consented real-human
newcomer trial, operational receptionist handoff, native #193 paths,
production activation and formal #261 policy acceptance remain unverified.

Build before the isolated `FREEDOM_E2E_FIRST_PARTICIPATION=1` browser pass.
After changing worktree dependency links, rebuild the portal: an existing bundle
can retain duplicate React instances and fail before the home card mounts.
The browser regression also rejects page runtime errors instead of diagnosing
an empty application as a missing guidance card.

## Event registration list (#401)

`GET /api/v1/events/:id/attendees?limit=20&offset=0` (limit 1–50) is
organizer-only (`403 organizer_required` for everyone else, including guild
reviewers, whose pending events have no registrations yet). It returns
`{items,total,next_offset}` for the same population as `attending_count`:
members currently `going` (verification-only test accounts excluded) and public
guests whose confirmation email was sent, oldest registration first. A member
item is `{kind:'member',user_id,nickname,avatar_url,registered_at}`; a guest item
is only `{kind:'guest',registered_at}` — no guest name, email, member email or
contacts. Cancelled RSVPs leave the list. Responses are `private, no-store`.

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

Both `GET /me/guild-preferences` and the feature-gated v2 read use one short
database transaction holding the current user/session locks through the full
projection. This includes v2's final legacy projection and the old reader's
optional community-switch compatibility lookup. They recheck the database
session clock after the last query; expiry during those waits returns
`401 session_expired`, not private preferences or a successful v2 ETag.
Valid reads retain their existing DTO/cache/ETag behavior, and the feature-off
v2 route and onboarding gates remain unchanged. These locks contain database
reads only, not provider or object-store I/O.

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
flag off the dialog is unchanged. When the guild launchpad is on (`/site`
`guild_launchpad_enabled`), the 「刊登商品」 submenu first offers 「在站內商店刊登」
(`#stores`) and 「供貨給其他店家」 (`#stores/supply`) above the two product-result
options; both only navigate and focus, with no new route, API or flag. The
candidate adds no database migration,
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

## Participation metrics (#262)

This source candidate adds `159_participation_metrics.sql` (number provisional
until merge order is known) and `FREEDOM_PARTICIPATION_METRICS_ENABLED`
(default off in Node and Worker; a non-boolean value fails closed). With the
flag off the report route does not exist and search records nothing.

`GET /admin/api/participation-metrics?from=YYYY-MM-DD&to=YYYY-MM-DD` is behind
the existing verified platform-admin identity, reads only that admin's own
community, is `no-store`, and is recomputed from current authoritative records
on every request, so there is no stored report to go stale or leak. The default
range is the last 28 Asia/Taipei days; the maximum is 366 days. Invalid calendar
dates return 422 before any report query. Search rates expose distinct excluded
test-account counts and excluded read counts for their own denominator. The response
embeds its own definition (`participation-metrics/v3`): cohort, time zone,
window, de-duplication and exclusions are part of the data, not tribal
knowledge.

Metrics: share and comment within 7 days of registration; a different human
active member's comment within 48 hours of an active native post (a
reproducible proxy, not a quality judgement); a later-calendar-day durable
participation event within 7 days of a first share; and search zero-result and open rates.
Cohort members and posts only enter a denominator after their window has fully
elapsed; the rest is `pending_window`. Fewer than 10 in a denominator returns
`rate: null, status: insufficient_sample`. Verification/test accounts, launch-day
backfilled joiners, authors replying to themselves, inactive or foreign
responders and removed content are excluded and test-account counts are shown.
`moderation_first_handling_48h` and `moderation_close_7d` count cases received
in the requested Asia/Taipei range. A case enters the denominator only after 48
hours, or 7 days, from `member_reports.created_at`. The numerator is the first
`transition` journal row whose state is `in_progress` or `closed` inside that
window. Both spans are observation windows, not service-level targets for
volunteer handlers; open cases still inside the window are `pending_window`,
not failures. `median_hours` is the median receipt-to-event duration in hours
over the numerator and is null when that numerator is below 10.
Verification/test-account reporters are excluded and counted as
`excluded_test_accounts`. `repeat_abuse` stays `not_available` until a
maintainer defines it (#262).

Search outcomes store only an operation id, member, time, whether it was the
first page, a result count and one opened content kind. Query text, filters,
titles, messages, email and media are never stored. The open signal is
accepted only from the member who ran the search. Its small same-origin CSRF
request uses keepalive across document navigation; this is an outcome signal,
not evidence that the target was read. Return uses timestamps of
native posts/comments, showcase consent, skill publication and recorded search
operations, not mutable session last-seen. It measures participation, not all
visits; removal/withdrawal of those authoritative facts can change the report.
Promotion clicks, RSVPs and reactions are not inputs and never become quality,
acceptance, XP or reward.

No real baseline was observed: production read access and the retention/opt-out
policy (#261) are not available, so any number here is synthetic evidence only.
