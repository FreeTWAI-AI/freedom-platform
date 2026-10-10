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
- `POST /auth/login`: `{email,password,code?}`. Enabled MFA accounts first return
  `401 totp_required` without a session; submit the same email/password with a
  six-digit authenticator code or an unused backup code to complete login.
  Password login does not verify email or link providers; slugs confer no ownership.
- `POST /auth/reset/request`: `{email}`; requires the configured recovery sender
  and returns the same result for existing and unknown accounts.
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
- `GET /friends`: `{items:[{user_id,nickname,state,requester_ref,aggregate_version}]}`.
- `POST /friends/:id/request|accept|remove`: `{}`. First request needs no version;
  accept/remove and renewed removed friendship need current version. Only the
  recipient can accept. Pending requests grant **no** contact access. Remove
  revokes access immediately. Repeat requests do not accept another's invitation.
- `GET /squads?limit=20&offset=0`: `{items,next_offset,kinds}`. Items include
  `squad_id,name,kind,purpose,owner_ref,owner_name,member_count,membership`.
  Membership is null or `{state,aggregate_version}` for the current user.
- `POST /squads`: `{name,kind,purpose,communication_channel_name?}`. Kinds keep
  their persisted keys: `project` 開源專案合作團隊, `mutual_help` 生意機會合作團隊,
  `coaching` 技能學習陪跑小隊, `social` 吃喝玩樂交流小隊. Creator becomes its
  first active member. The portal opens member search immediately after creation;
  the owner can also use the directory card's 邀請夥伴 action. Invitations retain
  recipient consent and grant no membership or contact access before acceptance.
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

Private outcome JSON and authenticated skill backlink HTML hold current
user/session locks through their database projection and recheck expiry with
the database clock after its last query. Member media takes separate short
session-and-ACL snapshots before and after object I/O; revoked or expired
sessions return `401 session_expired` even when the underlying event is public.
The anonymous media endpoint continues to enforce its own public policy.

Local isolated database/browser checks are not trusted CI, deployment,
flag-on, actual attendance, formal acceptance, XP or external delivery evidence.

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

ICS has stable event UID, UTC start/end, aggregate-version SEQUENCE, cancellation
STATUS and RFC text escaping/octet folding. It does not turn private locations
or joining links into a public calendar feed. Import is a manual snapshot:
redownload after changes; no automatic subscription/update is promised.
Isolated browser download, UTC/time-zone and independent parser checks do not
claim an actual Apple/Google Calendar import, external Email delivery, Worker
cron deployment, attendance rate, XP, ticketing or payment completion.

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
embeds its own definition (`participation-metrics/v2`): cohort, time zone,
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
Moderation case time is `not_available`: this build has no reporting or case
workflow, so no number is invented.

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
