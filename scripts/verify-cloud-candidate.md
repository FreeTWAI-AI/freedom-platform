# Cloud candidate acceptance checklist

Tool: `scripts/verify-cloud-candidate.ts` (CLI) and `scripts/verify-cloud-candidate-lib.ts` (import-safe library).
Local tests of the tool: `tests/e2e/cloud-candidate-acceptance.spec.ts`.

## Current state (2026-09-24)

- Candidate Workers, PlanetScale databases and Hyperdrive configurations are not yet provisioned. Four candidate Access apps have been created and GET-verified, as recorded in [the 2026-09-24 migration status](../docs/development/cloudflare-migration-status-2026-09-24.md). `https://staging-next.freetwai.com` and `https://next.freetwai.com` are **not provisioned**.
- Every remote gate below is **not_run**. A passing local spec only shows the tool works against the isolated loopback E2E server. Its report says `harness: local_harness`, `cloud_proof: false`. The local Node server's health has the five Node fields only; the harness checks that shape and reports `provenance: not_asserted_local_node`, so it proves no runtime or release SHA.
- `cloud_proof: true` needs an `execute` against a candidate where every selected phase passed, including health with the Worker runtime and the expected release SHA. It proves nothing about Cloudflare, the candidate databases or production performance.
- The old live hosts `freetwai.com` and `staging.freetwai.com` cannot be addressed by this tool. The old `verify-staging.mjs`, `verify-public.mjs` and `verify-member-settings.mjs` are not imported or reused. They hard-code old hosts, use demo accounts, create accounts or read member inboxes.

## What the tool can address

| `--target` | Origin | Expected `health.mode` |
| --- | --- | --- |
| `staging-next` | `https://staging-next.freetwai.com` | `staging` |
| `next` | `https://next.freetwai.com` | `public` |

Only these exact strings are accepted, either as the name or as the exact origin with at most one trailing `/`. Everything else is rejected before any request: other hosts, lookalikes, punycode, uppercase, ports, paths, queries, fragments, userinfo and `http:`. There is no bypass flag. The loopback harness target is only reachable from library code in tests.

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
   When this file is given, `anonymous` also requires the unauthenticated request to be challenged (a 3xx to `*.cloudflareaccess.com`, or 401/403). The challenge is never followed. Token issuance, rotation and revocation follow Cloudflare's [service token documentation](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/). The file check only requires `[A-Za-z0-9._-]` values, so underscore-prefixed token formats are accepted.
5. **GitHub (optional)**: the full OAuth, App installation and consent flow needs an authorized synthetic GitHub identity. It is not provided, so it stays **not_run**. The `github-handoff` phase only checks the platform's authorization URL shape and never requests the provider.

6. **Root preflight: no query-result cache on authorization reads.** If the candidate reaches its managed PostgreSQL database through Cloudflare Hyperdrive, every binding used by auth, session, permission, guild membership or eligibility queries must have query caching disabled. Root proves this from the provider API configuration of each binding (`caching.disabled === true`) and records it privately. Hyperdrive can cache `SELECT` results, and writes do not invalidate them ([query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/)). An HTTP `no-store` header or an app-reported environment flag is **not** proof. Provider credentials and configuration introspection stay with root; this tool makes no provider API calls. The same requirement applies to any other pooler or cache in front of the database (no managed PostgreSQL candidate is provisioned yet; this tool does not assume a provider). This tool's guild-cache first same-URL reads after a commit are runtime freshness evidence only, not proof of provider configuration.

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

# Bounded anonymous GET load (health + static only), explicit limits; health is added and verified first
npx tsx scripts/verify-cloud-candidate.ts execute --target next --expected-version <version> --expected-release-sha <40-hex commit> \
  --phases load --load-requests 120 --load-concurrency 4 --load-rps 10 --load-max-error-rate 0.01 --load-max-p95-ms 2000 \
  > /path/to/private/reports/next-load.json
```

`execute` refuses to start (exit `2`, before any request or credential read) without `--expected-release-sha`, because every network run includes health. Uppercase hex is lowercased; anything but 40 hex characters is rejected.

The JSON report goes to stdout, and the caller keeps it as the canonical record. Progress lines on stderr carry phase names and statuses only. Exit code: `0` only when every selected phase passed, `1` for any fail, blocked or not_run phase, and `2` for usage or credential-file errors.

## Phases and acceptance gates

| Phase | Gate (all must hold) | Writes |
| --- | --- | --- |
| preflight | Target allowlisted, expected version set, expected release SHA set (40 lowercase hex) when health runs on a candidate, local contract loaded, account present if needed. No network. | none |
| health | 200 JSON with `no-store`. Exact fields `status, mode, version, money_movement_enabled, official, runtime, release_sha`, no others. `ok`, mode matches target, version matches expected, `false`, `false`, `runtime` is exactly `cloudflare-workers`, `release_sha` is 40 lowercase hex and equals `--expected-release-sha`. No redirect. Only after all of these pass, `provenance` reports the runtime and the expected SHA. The old Node shape without `runtime`/`release_sha` fails `exact_fields`. | none |
| protocol | `/api/v1/protocol` deep-equals `contracts/preview/v1/metadata.json` | none |
| assets | Brand plus four RPG images: 200, `image/webp`, more than 1000 bytes. Records `cf-cache-status` and `cf-ray` presence as diagnostics only, not required. | none |
| anonymous | Session, guild preferences and development status return 401 `login_required` with `no-store` and no session cookie. Login is rejected with `origin_rejected` when Origin is missing, foreign or the old live origin (no credentials sent). Optional Access gate. | none |
| session | Login. The cookie is `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/` and host-only. Two `/session` reads (reload) return the same account. Missing or wrong CSRF gets 403 `csrf_rejected`. A foreign Origin with a valid CSRF token gets 403 `origin_rejected`. The session survives the rejected writes. | session |
| browser | Real Chromium: landing 200, UI login, the cookie is Secure/HttpOnly/Strict and not visible to scripts, reload keeps the session, UI logout clears it, no page errors. No screenshots. It never opens "我的訊息". The signed-in shell loads inbox previews by itself (including a last message body). Every request to `/api/v1/me/notifications`, `/api/v1/me/conversations` or `/api/v1/me/channels`, and anything under them, is aborted before it is fetched. Nothing fake is returned. `inbox_requests_blocked` counts them, `member_inbox: not_covered` is reported, and any inbox response reaching the page fails `no_inbox_response_received`. A failed `route.fetch`/`fulfill`/`abort` never escapes: it is aborted and counted as `stage:ErrorClass` in `routing_failures` (no message, URL, header or body) and fails `no_routing_failures`. Teardown aborts new requests, closes pages, drains in-flight route handlers, then closes the context with the route still installed; `teardown` and `routing_failures_during_teardown` report it, and a failed close fails `browser_teardown_clean`. If the UI logout did not complete, the browser's session cookie is revoked through the exact-origin API. | session |
| guild-cache | See below | own membership |
| github-handoff | If configured and not connected: `POST /me/github/connect` gives a `github.com/login/oauth/authorize` URL whose `redirect_uri` is `<origin>/github/callback`, with a 43-character state and PKCE S256. The URL is never requested and no consent is submitted. If unconfigured the phase is **not_run**, not pass. | OAuth state row |
| avatar | Only when the account has no avatar. Generated PNG upload goes through If-Match and Idempotency-Key. The private `image/webp` is `private, no-store`. Anonymous gets 401. Remove, then the old URL returns 404. The avatar is removed again in `finally`. | own avatar |
| load | Anonymous GETs of health and two static images only. Bounded by requests ≤600, concurrency ≤16, rps ≤30, timeout ≤30 s. Reports the actual request count, status distribution, network errors by class, error rate, p50/p95/p99 and duration. Passes only within the configured thresholds. It stays not_run until executed. | none |
| logout | Runs whenever a tool session exists. Returns 200 with `no-store` and clears the cookie. Replaying the revoked cookie gets 401 `session_expired`. | session revoked |

### guild-cache (grant/revoke and freshness)

Uses the real routes `POST /api/v1/guilds/:key/{join,leave}` (If-Match, Idempotency-Key, Origin, CSRF) and `GET /api/v1/me/development/skill/:book`.

1. Baseline. The primary guild is not a development guild, and neither AI guild is active. Two identical status reads are both `eligible: false` and `no-store`. Otherwise the phase is **not_run**, and the tool never leaves memberships it did not create.
2. Joining `--dev-guild` (default `guild_ai_vibe`) returns `active` with a matching ETag. The **first** status read after the commit must be `eligible: true` (`join_first_read_eligible`), and so must the next one. It is still `enabled: false` with no active grant. Eligibility is not a GitHub App grant or key.
3. A leave with a stale If-Match gets 412 `version_conflict`. The real leave returns `left`. The **first** read after it must be `eligible: false` (`leave_first_read_revoked`), and so must the next one. The skill-book grant count is unchanged, because guild books are kept after leaving.
4. Replaying the original join receipt (same Idempotency-Key and body) returns its stored response. Current authority stays `left` and not eligible.
5. A brand-new login sees `eligible: false`. The anonymous status read is 401 `login_required` with `no-store`.
6. `finally` re-reads the membership once a join was attempted, and leaves the guild if it is still active. It records `restored` only when the membership was read successfully and is not active, or when that leave returned `left`. A failed or unreadable lookup records `restore_failed`, never `restored`.

A stale first read fails the phase even if a later read would be fresh. The tool never polls or waits for a cache TTL to expire.

Only booleans, states, counts and version numbers are reported. No GitHub login, proposals, key ids, member ids or content.

## Redaction

The report is built from whitelisted fields. Error reasons are check ids or `ErrorClass[:SYSCODE]`, never messages, URLs or stacks. Remote metadata strings (health `mode`/`version`, asset `content-type`/`cache-control`) are kept whole or replaced by `omitted_too_long`, never truncated, so a reflected secret cannot leak a prefix. Before output, every string in the report is scrubbed against the raw, URI-encoded and JSON-escaped form of every secret seen: password, email, Access id/secret, session cookie values, CSRF tokens, user id, OAuth URL, state and challenge, and avatar URL. `redaction_applied` shows whether anything had to be removed.

## Cleanup and rollback ownership

- The tool revokes its own sessions (including the browser session when the browser phase fails before UI logout), restores the test guild membership and removes its avatar. It records each item in `cleanup.items`.
- Expected residue on the synthetic account: a `left` membership row, retained guild skill-book grants, command receipts, revoked session rows, and an unconsumed OAuth state that expires in 10 minutes.
- `cleanup.required` is `true` whenever the account was used. **Root** deactivates or deletes the dedicated synthetic account and its rows in the candidate database after acceptance, and revokes the temporary Access service token and policy. The tool has no database access and no account-deletion API, so it cannot confirm remote cleanup.
- Rollback of the candidate deployment, DNS and Access belongs to root and the deploy owner, outside this tool.

## Not covered (explicit not_run until provided)

- Any remote phase, until the candidate exists and root runs `execute`.
- The full GitHub OAuth, App installation, consent and key issuance flow, which needs an authorized synthetic GitHub identity.
- Registration of new members. The tool never registers accounts. Use the root-provisioned account.
- Member inbox, conversations, channel history and the "我的訊息" UI. These are intentionally never read. The browser phase aborts the shell's automatic inbox requests and reports `member_inbox: not_covered`.
- Provider configuration (Hyperdrive or other database cache settings, Access policies). Root checks these; the tool has no provider access.
- Capacity or performance claims for Cloudflare or the database. Local load numbers are not evidence.
