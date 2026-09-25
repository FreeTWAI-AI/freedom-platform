# Cloud candidate acceptance checklist

Tool: `scripts/verify-cloud-candidate.ts` (CLI) and `scripts/verify-cloud-candidate-lib.ts` (import-safe library).
Local tests of the tool: `tests/e2e/cloud-candidate-acceptance.spec.ts`.

## Current state (2026-09-24)

- Both candidates run app `aed75a2636a0680b2fb9cf1ecd31ed14cbcb6293` on Workers. Root ran verifier `9bec626` against each. Each canonical account report has `cloud_proof: true` and overall pass, with 132 checks in the 10 selected phases: preflight, health, protocol, assets, anonymous, session, browser, guild-cache, avatar and logout. `staging-next` finished at 19:39 UTC and `next` at 20:12:32 UTC. `github-handoff` and `load` were not selected in those runs. A separate bounded `load` run passed 120/120 on each candidate. Root then cleaned up both synthetic accounts and the temporary Access tokens. See [the 2026-09-24 migration status](../docs/development/cloudflare-migration-status-2026-09-24.md) §7.
- Two later runs the same day selected `preflight`, `health`, `registration`, `messages` and `messages-mobile` against that same app. Both reports have `cloud_proof: true` and overall pass, and the temporary Access grants and synthetic `cand-reg-*` members were cleaned up after each run. `staging-next` (2026-09-24T22:44:03Z→22:46:38Z) passed preflight 5/5, health 12/12, registration 16/16, messages 44/44 and messages-mobile 12/12. `next` (2026-09-24T23:27:11Z→23:29:11Z) passed preflight 5/5, health 12/12, registration 16/16, messages 34/34 and messages-mobile 12/12. The earlier 132-check runs predate the `registration`, `messages` and `messages-mobile` phases. See [the 2026-09-24 migration status](../docs/development/cloudflare-migration-status-2026-09-24.md) §9.
- Earlier failed attempts are kept as failure history, not proof: a `staging-next` browser crash in the verifier (no JSON; fixed by `3a4c434`) and a first `next` report that failed with `github_setup_unavailable` (restored GitHub App config under a fresh key; handled by a reviewed candidate-only isolation step, not a verifier bypass). Verifier fixes `3a4c434` and `9bec626` change only the tool, not the app or the deployed artifact.
- A passing local spec only shows the tool works against the isolated loopback E2E server. Its report says `harness: local_harness`, `cloud_proof: false`. The local Node server's health has the five Node fields only; the harness checks that shape and reports `provenance: not_asserted_local_node`, so it proves no runtime or release SHA.
- `cloud_proof: true` needs an `execute` against a candidate where every selected phase passed, including health with the Worker runtime and the expected release SHA. It covers the selected remote checks against that runtime and release. It does not establish unselected flows, provider configuration or production performance. The earlier 132-check runs on 2026-09-24 did not select registration or messaging. Later runs the same day did; a phase counts only for the run that selects it. Provider GET evidence, such as Hyperdrive `caching.disabled`, is recorded separately by root.
- `staging.freetwai.com` cannot be addressed by this tool. `https://freetwai.com` is addressable only as `--target public` (production after the Workers cutover). The old `verify-staging.mjs`, `verify-public.mjs` and `verify-member-settings.mjs` are not imported or reused. They hard-code old hosts, use demo accounts, create accounts or read member inboxes.

## What the tool can address

| `--target` | Origin | Expected `health.mode` |
| --- | --- | --- |
| `staging-next` | `https://staging-next.freetwai.com` | `staging` |
| `next` | `https://next.freetwai.com` | `public` |
| `public` | `https://freetwai.com` | `public` |

Only these exact strings are accepted, either as the name or as the exact origin with at most one trailing `/`. Everything else is rejected before any request: other hosts, lookalikes, punycode, uppercase, ports, paths, queries, fragments, userinfo and `http:`. There is no bypass flag. The loopback harness target is only reachable from library code in tests. Report filenames use the target name (`public-account.json`, `public-messages.json`). The report field `target.name` is that same allowlisted name.

Every request is built from the fixed origin plus a path that starts with `/`. Redirects are never followed (`redirect: 'manual'`, `maxRedirects: 0` in the browser phase). Access headers are only sent to that origin. In the browser phase, requests to any other origin are aborted and counted.

## Prerequisites root must supply before executing (not in this repo)

1. **Candidate deployment** on the exact origin, with its own database. It must not share the old staging or public database. It is the Cloudflare Worker build, with `FREEDOM_RELEASE_SHA` set to the full commit under test, so health reports `runtime: cloudflare-workers` and that `release_sha`. `health.version` must equal the release under test. Root passes the same commit as `--expected-release-sha`.
2. **Dedicated synthetic account**, provisioned by root in the new candidate database only:
   - Not a demo account (`@local.test` and the demo password are refused) and not a real member.
   - Onboarding completed or legacy-ready. Its primary guild is **not** `guild_ai_vibe` or `guild_ai_field`. It has no active membership in either, so the guild-cache baseline is not eligible.
   - No avatar, and no GitHub link, unless those phases are meant to report `not_run`.
   - Record the pending/snapshot facts before the run: user id, membership rows, avatar, sessions. Keep that record privately. The tool never prints ids.
3. **Account file**: a private JSON file, mode `0600`, owned by the operator, absolute path, bound to the candidate origin:
   ```json
   {"candidate_origin":"https://staging-next.freetwai.com","label":"cand-staging-01","email":"<synthetic email>","password":"<dedicated secret>","synthetic":true}
   ```
4. **Staging Access (optional)**: a temporary Access service token in a private `0600` file, bound to the origin:
   ```json
   {"candidate_origin":"https://staging-next.freetwai.com","client_id":"<id>","client_secret":"<secret>"}
   ```
   When this file is given for `staging-next` or `next`, `anonymous` also requires the unauthenticated request to be challenged (a 3xx to `*.cloudflareaccess.com`, or 401/403). The challenge is never followed. Token issuance, rotation and revocation follow Cloudflare's [service token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). The file check only requires `[A-Za-z0-9._-]` values, so underscore-prefixed token formats are accepted. Do not pass this file for `public`. That host has no whole-host Access application: an unauthenticated `GET /` must reach the app. `/admin` stays behind Access and this tool does not request it. App-level anonymous checks (401 `login_required`, `no-store`, no session cookie) still run.
5. **GitHub (optional)**: the full OAuth, App installation and consent flow needs an authorized synthetic GitHub identity. It is not provided, so it stays **not_run**. The `github-handoff` phase only checks the platform's authorization URL shape and never requests the provider.

6. **Root preflight: no query-result cache on authorization reads.** If the candidate reaches its managed PostgreSQL database through Cloudflare Hyperdrive, every binding used by auth, session, permission, guild membership or eligibility queries must have query caching disabled. Root proves this from the provider API configuration of each binding (`caching.disabled === true`) and records it privately. Hyperdrive can cache `SELECT` results, and writes do not invalidate them ([query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)). An HTTP `no-store` header or an app-reported environment flag is **not** proof. Provider credentials and configuration introspection stay with root; this tool makes no provider API calls. The same requirement applies to any other pooler or cache in front of the database (this tool does not assume a provider). This tool's guild-cache first same-URL reads after a commit are runtime freshness evidence only, not proof of provider configuration.

Credentials never go in argv. The CLI only accepts known flags with validated values. File contents are never printed.

## Commands (placeholders only)

```sh
# Plan: no network, no credential files read (reads only the local package.json and contract metadata). Every phase is not_run.
# --expected-release-sha may be omitted here; health then reports plan_only_execute_requires_expected_release_sha.
npx tsx scripts/verify-cloud-candidate.ts plan --target staging-next --phases health,protocol,assets,anonymous,guild-cache,load

# Read-only gates (default phases: health, protocol, assets, anonymous)
umask 077
FREEDOM_CANDIDATE_ACCESS_FILE=/path/to/private/access.json \
  npx tsx scripts/verify-cloud-candidate.ts execute --target staging-next --expected-version <version> --expected-release-sha <40-hex commit> \
  > /path/to/private/reports/staging-next-readonly.json

# Synthetic-account gates (writes only to that account; see Cleanup)
FREEDOM_CANDIDATE_ACCOUNT_FILE=/path/to/private/account.json FREEDOM_CANDIDATE_ACCESS_FILE=/path/to/private/access.json \
  npx tsx scripts/verify-cloud-candidate.ts execute --target staging-next --expected-version <version> --expected-release-sha <40-hex commit> \
  --phases health,protocol,assets,anonymous,session,browser,guild-cache,github-handoff,avatar \
  > /path/to/private/reports/staging-next-account.json

# Synthetic registration and messaging. No account file; these phases register their own cand-reg members.
# The same command with --target next or --target public leaves guild-channel checks not_run (real_history_guarded).
# It does not request /api/v1/me/channels/guild/. The mobile shell still GETs /api/v1/me/channels?kind=guild (summary only).
npx tsx scripts/verify-cloud-candidate.ts execute --target staging-next --expected-version <version> --expected-release-sha <40-hex commit> \
  --phases registration,messages,messages-mobile \
  > /path/to/private/reports/staging-next-messages.json

# Bounded anonymous GET load (health + static only), explicit limits; health is added and verified first
npx tsx scripts/verify-cloud-candidate.ts execute --target next --expected-version <version> --expected-release-sha <40-hex commit> \
  --phases load --load-requests 120 --load-concurrency 4 --load-rps 10 --load-max-error-rate 0.01 --load-max-p95-ms 2000 \
  > /path/to/private/reports/next-load.json
```

`execute` refuses to start (exit `2`, before any request or credential read) without `--expected-release-sha`, because every network run includes health. Uppercase hex is lowercased; anything but 40 hex characters is rejected.

## Production acceptance after cutover

After the zone route sends `freetwai.com` to the Worker, `--target public` (or the exact origin `https://freetwai.com`) addresses production. `health.mode` is `public`. The Worker `release_sha` check is the same as on the candidates. There is no whole-host Access application, so these commands do not set `FREEDOM_CANDIDATE_ACCESS_FILE`. Anonymous requests reach the app. `/admin` stays behind Access and is not requested.

The account file for the first command is bound to `https://freetwai.com` and is a dedicated synthetic account, not a real member. `registration`, `messages` and `messages-mobile` do not read an account file. They provision only `cand-reg-*` members. Treat `public` like `next`: real member history stays closed (no guild-channel routes), inboxes of other members are not read, and the run never touches another member. The login foreign-origin case is `candidate_origin` `https://next.freetwai.com`, because `https://freetwai.com` is this target.

```sh
umask 077
FREEDOM_CANDIDATE_ACCOUNT_FILE=/path/to/private/account.json \
  npx tsx scripts/verify-cloud-candidate.ts execute --target public --expected-version <version> --expected-release-sha <40-hex commit> \
  --phases health,protocol,assets,anonymous,session,browser,guild-cache,avatar,logout \
  > /path/to/private/reports/public-account.json

npx tsx scripts/verify-cloud-candidate.ts execute --target public --expected-version <version> --expected-release-sha <40-hex commit> \
  --phases registration,messages,messages-mobile \
  > /path/to/private/reports/public-messages.json
```

Deactivate every `cand-reg-*` member named in `cleanup.items` afterwards with the operator cleanup helper. The tool has no database access and cannot confirm that cleanup. No Access file is used for `public`.

The JSON report goes to stdout, and the caller keeps it as the canonical record. Progress lines on stderr carry phase names and statuses only. For `execute`, the exit code is `0` only when every selected phase passed, `1` for any fail, blocked or not_run phase, and `2` for usage or credential-file errors. `plan` exits `0` after printing the report even though every phase is `not_run`; that `0` means the plan was written, not that any phase passed, and usage errors still exit `2`.

## Phases and acceptance gates

| Phase | Gate (all must hold) | Writes |
| --- | --- | --- |
| preflight | Target allowlisted, expected version set, expected release SHA set (40 lowercase hex) when health runs on a candidate, local contract loaded, account present if needed. No network. | none |
| health | 200 JSON with `no-store`. Exact fields `status, mode, version, money_movement_enabled, official, runtime, release_sha`, no others. `ok`, mode matches target, version matches expected, `false`, `false`, `runtime` is exactly `cloudflare-workers`, `release_sha` is 40 lowercase hex and equals `--expected-release-sha`. No redirect. Only after all of these pass, `provenance` reports the runtime and the expected SHA. The old Node shape without `runtime`/`release_sha` fails `exact_fields`. | none |
| protocol | `/api/v1/protocol` deep-equals `contracts/preview/v1/metadata.json` | none |
| assets | Brand plus four RPG images: 200, `image/webp`, more than 1000 bytes. Records `cf-cache-status` and `cf-ray` presence as diagnostics only, not required. | none |
| anonymous | Session, guild preferences and development status return 401 `login_required` with `no-store` and no session cookie. Login is rejected with `origin_rejected` when Origin is missing, foreign, or a third host: the old live origin `https://freetwai.com` on `staging-next` and `next`, and `https://next.freetwai.com` (`candidate_origin`) on `public` (no credentials sent). Optional Access gate on `staging-next` and `next`. On `public`, unauthenticated `GET /` must reach the app (`anonymous_reaches_app`); there is no whole-host challenge. | none |
| session | Login. The cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` and host-only. Two `/session` reads (reload) return the same account. Missing or wrong CSRF gets 403 `csrf_rejected`. A foreign Origin with a valid CSRF token gets 403 `origin_rejected`. The session survives the rejected writes. | session |
| browser | Real Chromium: landing 200, UI login, the cookie is Secure/HttpOnly/Strict and not visible to scripts, reload keeps the session, UI logout clears it, no page errors. No screenshots. It never opens "我的訊息". The signed-in shell loads inbox previews by itself (including a last message body). Every request to `/api/v1/me/notifications`, `/api/v1/me/conversations` or `/api/v1/me/channels`, and anything under them, is aborted before it is fetched. Nothing fake is returned. `inbox_requests_blocked` counts them, `member_inbox: not_covered` is reported, and any inbox response reaching the page fails `no_inbox_response_received`. A failed `route.fetch`/`fulfill`/`abort` never escapes: it is aborted and counted as `stage:ErrorClass` in `routing_failures` (no message, URL, header or body) and fails `no_routing_failures`. Teardown aborts new requests, closes pages, drains in-flight route handlers, then closes the context with the route still installed; `teardown` and `routing_failures_during_teardown` report it, and a failed close fails `browser_teardown_clean`. If the UI logout did not complete, the browser's session cookie is revoked through the exact-origin API. | session |
| guild-cache | See below | own membership |
| github-handoff | If configured and not connected: `POST /me/github/connect` gives a `github.com/login/oauth/authorize` URL whose `redirect_uri` is `<origin>/github/callback`, with a 43-character state and PKCE S256. The URL is never requested and no consent is submitted. If unconfigured the phase is **not_run**, not pass. | OAuth state row |
| avatar | Only when the account has no avatar. Generated PNG upload goes through If-Match and Idempotency-Key. The private `image/webp` is `private, no-store`. Anonymous gets 401. Remove, then the old URL returns 404. The avatar is removed again in `finally`. | own avatar |
| registration | No account file. Identity `cand-reg-<8 hex>`, email `<label>@example.invalid`, password 32+ characters from `crypto.randomBytes`. Register returns 201 and the same session cookie policy as `session` (`Secure` on HTTPS, `HttpOnly`, `SameSite=Strict`, `Path=/`, host-only). Missing or foreign Origin is `403 origin_rejected` and creates no account. The same email again is `409 account_unavailable`. Two `GET /api/v1/session` reads agree (there is no `/api/v1/me/session`). Onboarding starts incomplete. A deterministic assessment from `GET /api/v1/assessment-definition` reaches `state: evaluated`. `POST /api/v1/me/onboarding/complete` sets the first built-in, non-development guild from `GET /api/v1/guilds` (catalog `guild_key` and the caller's own membership only; never `guild_ai_vibe`, `guild_ai_field`, or `GET /api/v1/guilds/directory`) as primary, with If-Match and Idempotency-Key, and onboarding reports complete. Replaying that command returns the stored response and does not change state. A stale If-Match on the same route is `412 version_conflict`. Logout returns 200, clears the cookie, and a replay is `401 session_expired`; login again is the same account with onboarding still complete. Member-todo sources report positioning `done`, primary guild `done` (catalog membership `active` and `primary_guild_key` from `GET /api/v1/me/guild-preferences`), and GitHub `unavailable` or `incomplete`. If any step throws after the 201, the session is still revoked and the label is still recorded `cleanup_required`. | one new member |
| messages | Requires `registration` in the same run. Registers member B the same way and completes positioning into A's primary guild. Direct message: A sends (201), B's unread for A is 1, the stored body matches, B marks read and unread is 0, A's unread stays 0, the same Idempotency-Key returns the stored message without a duplicate, and a foreign Origin is `403 origin_rejected`. Squad of only A and B: A creates it, invites B, B sees the invitation and a notification, B accepts, both list the squad channel, A sends, B's unread is 1, offset pages have unique message ids, B marks read, B leaves, and B's read and send are `404 channel_not_available` while A can still read. Notification mark-read decreases the unread count. On targets `next` and `public`, guild-channel sub-checks are `guild_channel: not_run` with reason `real_history_guarded`: the phase does not read or write any guild channel and does not call `GET /api/v1/guilds`. On `staging-next` and the local harness, A and B use the primary guild channel (send, unread, read, mark read). A second built-in guild, when used, is chosen from `GET /api/v1/guilds` and joined with `POST /api/v1/guilds/:key/join`; otherwise `secondary_guild: not_run` with reason `secondary_guild_join_unavailable`. If B's registration returns 201 and a later step throws, B's session is revoked on the exact origin and B's label is recorded `cleanup_required`. B does not leave the primary guild. `rate_limit: not_covered` (the 20-message limit is not exercised). | second member, one squad, messages |
| messages-mobile | Requires `messages`. Real Chromium, viewport 390×844, `deviceScaleFactor` 3, `isMobile`, `hasTouch`. Same origin guard, no screenshots, page-error capture and teardown as `browser`. Inbox paths are allowed because the browser session is only synthetic member A. Landing 200, UI login as A, open 「我的訊息」, the direct conversation with B shows the last body sent in `messages`, one UI send appears, direct-message unread badges stay consistent with own messages excluded, `document.documentElement.scrollWidth <= window.innerWidth`, and UI logout clears the cookie. On `next` and `public` the shell still requests `GET /api/v1/me/channels?kind=guild` (summary fields only: `channel_key`, `name`, `unread_count`, `last_message_at`) and `GET /api/v1/members/:id` for the member's own card. No guild-channel history is opened (`/api/v1/me/channels/guild/` is not requested). The settings dot may stay lit from that summary's unread count; the phase does not clear it. | one mobile browser session |
| load | Anonymous GETs of health and two static images only. Bounded by requests ≤600, concurrency ≤16, rps ≤30, timeout ≤30 s. Reports the actual request count, status distribution, network errors by class, error rate, p50/p95/p99 and duration. Passes only within the configured thresholds. It stays not_run until executed. | none |
| logout | Runs whenever a tool session exists. Returns 200 with `no-store` and clears the cookie. Replaying the revoked cookie gets 401 `session_expired`. | session revoked |

### guild-cache (grant/revoke and freshness)

Uses the real routes `POST /api/v1/guilds/:key/{join,leave}` (If-Match, Idempotency-Key, Origin, CSRF), `GET /api/v1/guilds` (catalog plus the caller's own membership, for If-Match and cleanup), and `GET /api/v1/me/development/skill/:book`. It does not call `GET /api/v1/guilds/directory`.

1. Baseline. The primary guild is not a development guild, and neither AI guild is active. Two identical status reads are both `eligible: false` and `no-store`. Otherwise the phase is **not_run**, and the tool never leaves memberships it did not create.
2. Joining `--dev-guild` (default `guild_ai_vibe`) returns `active` with a body version that is a positive safe integer `N` and a response ETag of exactly `"N"` or `W/"N"` (a compressing edge may weaken it); any other shape or number fails, and only the ETag kind is recorded. Requests always send a strong If-Match. The **first** status read after the commit must be `eligible: true` (`join_first_read_eligible`), and so must the next one. It is still `enabled: false` with no active grant. Eligibility is not a GitHub App grant or key.
3. A leave with a stale If-Match gets 412 `version_conflict`. The real leave returns `left`. The **first** read after it must be `eligible: false` (`leave_first_read_revoked`), and so must the next one. The skill-book grant count is unchanged, because guild books are kept after leaving.
4. Replaying the original join receipt (same Idempotency-Key and body) returns its stored response. Current authority stays `left` and not eligible.
5. A brand-new login sees `eligible: false`. The anonymous status read is 401 `login_required` with `no-store`.
6. `finally` re-reads the membership once a join was attempted, and leaves the guild if it is still active. It records `restored` only when the membership was read successfully and is not active, or when that leave returned `left`. A failed or unreadable lookup records `restore_failed`, never `restored`.

A stale first read fails the phase even if a later read would be fresh. The tool never polls or waits for a cache TTL to expire.

Only booleans, states, counts and version numbers are reported. No GitHub login, proposals, key ids, member ids or content.

## Requests on targets `next` and `public`

`public` follows this same list. It serves live member history, so guild-channel routes stay off, the same as `next`. Self-provisioned `cand-reg-*` accounts only. Never read another member's inbox.

Every `execute` also selects `health` (`GET /api/v1/health`) and `preflight` (no request). The three phases below do not call `GET /api/v1/guilds/directory`. That route returns every guild's `guild_master`, `guild_experts` (`user_id`, `display_name`, `avatar_url`) and pending nominee display names. Guild choice uses `GET /api/v1/guilds`, whose items are catalog fields (`guild_key`, `name`, `purpose`, `first_step`, `module_key`, `profession_key`, `catalog_version`, `track_count`) plus the caller's own `membership` (`membership_id`, `state`, `rank`, `aggregate_version`). The primary guild is read from `GET /api/v1/me/guild-preferences` (`primary_guild_key`, `secondary_guild_keys`, `aggregate_version`).

`GET /api/v1/guilds` exposes `guild_key`, which is enough to pick the first built-in, non-development guild (`guild_[a-z_]+`, skipping `guild_custom_*`, `guild_ai_vibe` and `guild_ai_field`).

### `registration` (HTTP client)

- `POST /api/v1/auth/register` (missing origin, foreign origin, the create, the duplicate)
- `POST /api/v1/auth/login` (rejected-origin proof, then login again)
- `GET /api/v1/session` (two agreeing reads, then the revoked-cookie replay)
- `GET /api/v1/me/onboarding`
- `GET /api/v1/assessment-definition`
- `POST /api/v1/me/onboarding/answers`
- `POST /api/v1/me/onboarding/evaluate`
- `GET /api/v1/guilds`
- `POST /api/v1/me/onboarding/complete` (complete, idempotent replay, stale If-Match)
- `GET /api/v1/me/guild-preferences` (after complete, after the idempotent replay, and again for the member-todo primary)
- `GET /api/v1/me/github`
- `POST /api/v1/auth/logout` (the check, and again in cleanup)

These responses name only the new member. `GET /api/v1/me/github` is that member's own connection status.

### `messages` on `next` and `public` (HTTP client)

Requires `registration`. Peer positioning is given A's primary guild key, so this phase does not call `GET /api/v1/guilds` or any `/api/v1/me/channels/guild/` route.

- `POST /api/v1/auth/login` (A)
- `POST /api/v1/auth/register` (B)
- `GET /api/v1/assessment-definition`
- `POST /api/v1/me/onboarding/answers`, `POST /api/v1/me/onboarding/evaluate`, `POST /api/v1/me/onboarding/complete`
- `GET /api/v1/me/guild-preferences` (B's stored primary)
- `POST /api/v1/me/conversations/:userId/messages` and `GET /api/v1/me/conversations/:userId/messages`
- `GET /api/v1/me/conversations`
- `POST /api/v1/me/conversations/:userId/read`
- `POST /api/v1/squads`
- `POST /api/v1/squads/:squadId/invitations`
- `GET /api/v1/me/squad-invitations`
- `GET /api/v1/me/notifications`
- `POST /api/v1/squad-invitations/:invitationId/accept`
- `GET /api/v1/me/channels?kind=squad`
- `POST /api/v1/me/channels/squad/:squadId/messages`, `GET /api/v1/me/channels/squad/:squadId/messages`, `POST /api/v1/me/channels/squad/:squadId/read`
- `GET /api/v1/squads/:squadId`
- `POST /api/v1/squads/:squadId/leave`
- `POST /api/v1/me/notifications/:notificationId/read`
- `POST /api/v1/auth/logout` (A and B)

Conversation participants, squad members, invitation names, notification text and squad-channel `sender_name` are only the two `cand-reg-*` members this run registered. The squad is new and contains only those two.

On `staging-next` and the local harness the same phase also calls `GET /api/v1/guilds`, `POST /api/v1/guilds/:key/join`, `POST /api/v1/guilds/:key/leave`, `GET /api/v1/me/channels?kind=guild` and `/api/v1/me/channels/guild/:key/messages` and `/read`. Those guild-channel calls stay off `next` and `public`.

### `messages-mobile` on `next` and `public` (browser shell)

The phase drives Chromium. It does not add its own HTTP client calls except a logout through the exact-origin API when UI logout did not finish. The signed-in shell requests:

- `GET /api/v1/session` and `GET /api/v1/site` before login
- `POST /api/v1/auth/login`
- `GET /api/v1/me/onboarding`
- `GET /api/v1/guild-workspace` (the caller's own officer and maintainer flags; empty for a new member)
- `GET /api/v1/members/:id` for this member's own card
- `GET /api/v1/assessment-definition` (home skill labels)
- inbox summaries: `GET /api/v1/me/notifications`, `GET /api/v1/me/conversations`, `GET /api/v1/me/channels?kind=guild`, `GET /api/v1/me/channels?kind=squad` (the menu uses `limit=1`; opening 「我的訊息」 uses `limit=20` because every panel stays mounted)
- `GET /api/v1/me/conversations/:userId/messages` and `POST /api/v1/me/conversations/:userId/messages` for the direct thread with B
- `POST /api/v1/auth/logout`

`GET /api/v1/me/channels?kind=guild` returns summary fields only: `channel_key`, `name`, `unread_count`, `last_message_at`. The summary has no message body and no sender. No channel history is opened on `next` or `public`: nothing requests a path containing `/api/v1/me/channels/guild/`. The member search `GET /api/v1/members` is not called. A window focus re-reads the same summaries and does not open history.

## Redaction

The report is built from whitelisted fields. Error reasons are check ids or `ErrorClass[:SYSCODE]`, never messages, URLs or stacks. Remote metadata strings (health `mode`/`version`, asset `content-type`/`cache-control`) are kept whole or replaced by `omitted_too_long`, never truncated, so a reflected secret cannot leak a prefix. Before output, every string in the report is scrubbed against the raw, URI-encoded and JSON-escaped form of every secret seen: password, email, Access id/secret, session cookie values, CSRF tokens, Idempotency-Key values, user id, OAuth URL, state and challenge, and avatar URL. `redaction_applied` is set from that scrub and is true when a secret had to be removed.

## Cleanup and rollback ownership

- The tool revokes its own sessions (including the browser session when the browser phase fails before UI logout), restores the test guild membership and removes its avatar. It records each item in `cleanup.items`.
- Expected residue on the dedicated synthetic account: a `left` membership row, retained guild skill-book grants, command receipts, revoked session rows, and an unconsumed OAuth state that expires in 10 minutes.
- `registration`, `messages` and `messages-mobile` do not read `FREEDOM_CANDIDATE_ACCOUNT_FILE`. They register `cand-reg-*` members themselves, revoke every session they opened, and record `cleanup_required` with those labels. Residue is the member row, positioning, guild membership, and any squad, message, notification and receipt rows that phase created. An account file supplied for other phases is ignored here.
- If registration returns 201 and a later step throws, that member's session is still revoked on the exact origin (best effort; the result is recorded) and the label is still `cleanup_required`. The same applies to member B inside `registerPeer` when positioning or any later step in that function throws after B's 201: B is revoked and named even though `messages` has not stored B on the run yet.
- **Root** deactivates each `cand-reg-*` member named in `cleanup.items` in the candidate database after acceptance, so the member can no longer log in, and removes or retains the rows listed above according to the candidate's retention practice. Root also deactivates or deletes the dedicated synthetic account when that account was used, and revokes the temporary Access service token and policy. The tool has no database access and no account-deletion API, so it cannot confirm remote cleanup.
- Rollback of the candidate deployment, DNS and Access belongs to root and the deploy owner, outside this tool.

## Not covered (explicit not_run until provided)

- Any phase that was not selected in a recorded run. The earlier 132-check runs on 2026-09-24 did not select `github-handoff`, `registration`, `messages` or `messages-mobile`. Later runs the same day selected `registration`, `messages` and `messages-mobile`; those runs did not select `github-handoff` or `load`.
- The full GitHub OAuth, App installation, consent and key issuance flow, which needs an authorized synthetic GitHub identity. A fresh `cand-reg-*` member only proves GitHub is `unavailable` or `incomplete`.
- Registration of anyone except the tool's own `cand-reg-*` members. The dedicated account file is still required for `session`, `browser`, `guild-cache`, `github-handoff`, `avatar` and `logout`.
- The account `browser` phase still does not read the inbox. It aborts `/api/v1/me/notifications`, `/api/v1/me/conversations` and `/api/v1/me/channels` and reports `member_inbox: not_covered`.
- Guild channel history on targets `next` and `public`. `messages` reports `guild_channel: not_run` with reason `real_history_guarded` and does not call those routes. `messages-mobile` does not open one either. The shell's `GET /api/v1/me/channels?kind=guild` is the summary list only. `staging-next` runs the history checks because that community is synthetic.
- The direct-message and channel rate limit (`429 message_rate_limited` after 20 messages in 60 seconds). `messages` reports `rate_limit: not_covered` so the run does not leave a burst of messages behind.
- Provider configuration (Hyperdrive or other database cache settings, Access policies). Root checks these; the tool has no provider access.
- Capacity or performance claims for Cloudflare or the database. Local load numbers are not evidence.
