# Forked client read connections (v1)

A fork is source code, not platform authority. The storefront and supplier templates obtain a **read connection** only after the signed-in member approves it on Freedom Workshop. Tokens cannot write platform data, sign into the website, view member contacts, operate work, or call arbitrary API endpoints. Product publication, supply decisions and listing changes remain in the platform web UI.

## Pairing protocol

Base platform defaults to `https://freetwai.com`; clients must use HTTPS outside loopback, never follow redirects when sending credentials, and never ask for a platform password. POST requests use JSON and an `Origin` equal to the configured platform origin. Browser CORS is intentionally not enabled for arbitrary fork origins: this protocol runs in a Node client/server, not untrusted web JavaScript.

1. `POST /api/v1/client-connections/start` body `{kind:"storefront"|"supplier",client_name}`. Response 201 `{device_secret,user_code,verification_uri,expires_in:300,interval:5,scope}`. `device_secret` is confidential; show only `user_code` and the verification URL to the person.
2. Person signs in, finishes positioning, opens the account read-connections panel and enters the code. `GET /api/v1/client-connections/:userCode` returns `{user_code,kind,client_name,scope,expires_at,state:"pending",read_only:true}`. They review the client name and scope. Storefront requires selecting their own store.
3. `POST /api/v1/client-connections/:userCode/approve` uses their browser session, CSRF and `Idempotency-Key`. Body `{confirmed:true,store_id}` for storefront; `{confirmed:true}` for supplier. Response `{approved:true,connection_id,scope,read_only:true}`. Pending codes expire in 5 minutes. Approval locks the member first, then may wait on the pairing row and the `client-connections/<user>` advisory lock. It rechecks that deadline with `clock_timestamp()` after those waits and before creating a connection. A code that expires during any of them is rejected with `404 pairing_not_found`, and the same transaction leaves no connection, approval or command receipt. The existing command revalidate callback checks the pairing deadline after receipt writes as well; expiry rolls back the new connection, approval and receipt together. A previously committed approval remains replayable after its code expires. New accounts cannot approve until onboarding is complete.
4. Client polls `POST /api/v1/client-connections/poll` with `{device_secret}`, no more than once per 5 seconds. Response 200 `{status:"authorization_pending",interval:5}`; 429 `{status:"slow_down",interval:5}` plus `Retry-After`; 400 `{status:"invalid_grant"}` for nonexistent, expired, consumed or revoked requests. After approval: 200 `{status:"authorized",access_token,token_type:"Bearer",connection_id,scope,store_id,expires_at,api_base_path:"/client-api/v1",read_only:true}`. Issuance rechecks the pairing and connection deadlines with `clock_timestamp()` after the member lock and again after the `member_client_connections` row lock, so neither wait can mint a token for an expired pairing or connection. After both issuance writes, a joined pairing/connection deadline check rolls those writes back to the existing savepoint if either deadline was crossed; poll bookkeeping remains. Token is returned **once**, expires in 7 days, and is stored only as a SHA-256 hash by the server. Losing that response requires a fresh pairing.
5. Store bearer token only in a private local file (0600, ignored by git), not browser storage, URL, generated HTML, screenshots or logs.

The user code is 80 random bits and the device secret is 256 random bits. Public start and poll operations have persistent network and global rate budgets; signed-in lookup and approvals also have budgets. Approval is not implicit in receiving or knowing a code.

Signed-in code review uses the existing locked member-session transaction for
its pending-code query and projection, then refreshes the database session clock
before returning client metadata. Session expiry during a SQL wait returns
`401 session_expired` without `user_code`, client name, kind, scope or a renewed
cookie; a cached Actor also cannot bypass expiry, revocation or member inactivity.
The lookup rate budget remains outside that short transaction, so denial does
not refund the lookup. This read creates no connection, receipt or journal.
It does not change code expiry, approval, one-time polling or bearer authority;
the check is before returning the projection, not through commit/HTTP delivery.

## Read gateway

Send `Authorization: Bearer <access_token>` to `/client-api/v1`. Every request checks active user, completed onboarding, expiry, revocation and resource scope in the same PostgreSQL transaction as the read. Expiry uses `clock_timestamp()` after the member lock. `/connection` metadata checks it again after the credential-row lock, before any metadata is returned. List reads check it again after the data query. A credential-row wait that crosses expiry denies both. No browser session or synthetic Actor is created.

The HTTP authentication scheme is ASCII case-insensitive and accepts one or more
ASCII spaces before the credential, per [RFC 9110 §11.1](https://www.rfc-editor.org/rfc/rfc9110#section-11.1)
and [§11.4](https://www.rfc-editor.org/rfc/rfc9110#section-11.4).
For example, `bearer <access_token>` and `bEaReR   <access_token>` authenticate
the same exact token. The opaque `fw_read_` token is never lowercased or trimmed;
its prefix, format and case-sensitive hash lookup are unchanged. HTAB or other
whitespace is not a substitute for the ASCII-space separator. Polling still
reports `token_type:"Bearer"`; resource scope, expiry, revocation and GET-only
restrictions do not change.

| Route (GET only) | Scope |
|---|---|
| `/connection` | Current connection metadata, no credential |
| `/retail/catalog` | Storefront: community catalog |
| `/retail/stores` | Storefront: only the approved store |
| `/retail/listings` | Storefront: only approved store's listings |
| `/retail/stores/:id` | Storefront: ID must be approved store |
| `/retail/stores/:id/listings` | Storefront: ID must be approved store |
| `/supplier/products` | Supplier: member's own products and current offers |
| `/supplier/requests` | Supplier: member's own received supply requests |

List responses are `{items,read_only:true,limit:200}`. The first preview has a 200-item cap and does not yet support pagination. Other paths return 404; write methods return 405; unsupported query parameters return 422. Storefront cannot read supplier-only resources or another store, even another store owned by the same person. Storefront catalog access may contain the supply price and terms the approving member can already read; it is not a public retail feed.

Store-specific path IDs are validated UUIDs, and the approved-store scope compares
their lowercase UUID identity with PostgreSQL's stored value. Uppercase UUID
spelling therefore reads the same approved store or its listings; another store
is still 404, including another one owned by the same member. Response IDs keep
their PostgreSQL spelling. This comparison does not fold bearer credentials or
expand ownership, resource scope, or write permissions.

## Review and revoke

`GET /api/v1/me/client-connections` returns `{items:[{connection_id,client_name,kind,scope,store_id,aggregate_version,created_at,expires_at,revoked_at,read_only:true}]}`. `POST /api/v1/me/client-connections/:id/revoke` uses `{}`, CSRF, `Idempotency-Key` and the listed `If-Match` version. Revocation invalidates reads immediately; it also prevents a pending approved client from exchanging its device secret. Only the owner can revoke. Maximum 20 active connections per member.

The member list locks the current user/session and reads the projection on the same transaction client, then checks `clock_timestamp()` after the last potentially blocking query, before returning private data. If a projection wait crosses the session deadline, it returns 401 `session_expired` without `items`; valid sessions receive only their own connection metadata, never token/hash/secret fields. A bearer token cannot authenticate this member endpoint. This decision-time member-session check does not revoke the independently authenticated `/client-api/v1` bearer connection.

No external client writes or delegated GitHub permissions are implemented by this protocol. Skill-book repository access and GitHub fork permissions are independent of the platform bearer token.
