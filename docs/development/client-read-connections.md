# Forked client read connections (v1)

A fork is source code, not platform authority. The storefront and supplier templates obtain a **read connection** only after the signed-in member approves it on Freedom Workshop. Tokens cannot write platform data, sign into the website, view member contacts, operate work, or call arbitrary API endpoints. Product publication, supply decisions and listing changes remain in the platform web UI.

## Pairing protocol

Base platform defaults to `https://freetwai.com`; clients must use HTTPS outside loopback, never follow redirects when sending credentials, and never ask for a platform password. POST requests use JSON and an `Origin` equal to the configured platform origin. Browser CORS is intentionally not enabled for arbitrary fork origins: this protocol runs in a Node client/server, not untrusted web JavaScript.

1. `POST /api/v1/client-connections/start` body `{kind:"storefront"|"supplier",client_name}`. Response 201 `{device_secret,user_code,verification_uri,expires_in:300,interval:5,scope}`. `device_secret` is confidential; show only `user_code` and the verification URL to the person.
2. Person signs in, finishes positioning, opens the account read-connections panel and enters the code. `GET /api/v1/client-connections/:userCode` returns `{user_code,kind,client_name,scope,expires_at,state:"pending",read_only:true}`. They review the client name and scope. Storefront requires selecting their own store.
3. `POST /api/v1/client-connections/:userCode/approve` uses their browser session, CSRF and `Idempotency-Key`. Body `{confirmed:true,store_id}` for storefront; `{confirmed:true}` for supplier. Response `{approved:true,connection_id,scope,read_only:true}`. Pending codes expire in 5 minutes; new accounts cannot approve until onboarding is complete.
4. Client polls `POST /api/v1/client-connections/poll` with `{device_secret}`, no more than once per 5 seconds. Response 200 `{status:"authorization_pending",interval:5}`; 429 `{status:"slow_down",interval:5}` plus `Retry-After`; 400 `{status:"invalid_grant"}` for nonexistent, expired, consumed or revoked requests. After approval: 200 `{status:"authorized",access_token,token_type:"Bearer",connection_id,scope,store_id,expires_at,api_base_path:"/client-api/v1",read_only:true}`. Token is returned **once**, expires in 7 days, and is stored only as a SHA-256 hash by the server. Losing that response requires a fresh pairing.
5. Store bearer token only in a private local file (0600, ignored by git), not browser storage, URL, generated HTML, screenshots or logs.

The user code is 80 random bits and the device secret is 256 random bits. Public start and poll operations have persistent network and global rate budgets; signed-in lookup and approvals also have budgets. Approval is not implicit in receiving or knowing a code.

## Read gateway

Send `Authorization: Bearer <access_token>` to `/client-api/v1`. Every request checks active user, completed onboarding, expiry, revocation and resource scope in the same PostgreSQL transaction as the read. No browser session or synthetic Actor is created.

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

## Review and revoke

`GET /api/v1/me/client-connections` returns `{items:[{connection_id,client_name,kind,scope,store_id,aggregate_version,created_at,expires_at,revoked_at,read_only:true}]}`. `POST /api/v1/me/client-connections/:id/revoke` uses `{}`, CSRF, `Idempotency-Key` and the listed `If-Match` version. Revocation invalidates reads immediately; it also prevents a pending approved client from exchanging its device secret. Only the owner can revoke. Maximum 20 active connections per member.

No external client writes or delegated GitHub permissions are implemented by this protocol. Skill-book repository access and GitHub fork permissions are independent of the platform bearer token.
