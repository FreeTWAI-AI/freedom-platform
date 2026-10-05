# Independent model broker Worker candidate

This candidate composes the existing genuine credential vault, authorization
registry, model host, runner, private Result finalizer and authenticated bridge in
an independent Worker. It is disabled by default and is not a deployment record.
The main platform Worker must never receive the broker KEK ring, cipher role,
response private signer or provider resolver.

`wrangler.broker.example.jsonc` uses the native HTTPS provider adapter only in
this broker bundle. The ordinary platform bundle still has the unavailable
provider adapter; Node's original provider transport remains available unchanged.
The example has no public routes, worker previews or generated key defaults.
An optional direct credential setup host is composed only with the complete
independent ingest profile and readiness binding described below.

## Explicit bindings

- `FREEDOM_BROKER_ENABLED`: only literal `true` opts in.
- `FREEDOM_BROKER_ENVIRONMENT`: `staging-next` or `next`.
- `APP_ORIGIN`: exact corresponding existing platform origin.
- `FREEDOM_BROKER_PROFILE`: closed JSON matching `BrokerWorkerProfileSchema`.
  It pins environment, platformOrigin, clientId, main issuer/requestAudience,
  brokerId/responseAudience/responseKeyId, requestKeys, recoveryKeys,
  recoveryAuthority, databaseName, cipherRole, executorRole and currentKekId.
- `FREEDOM_BROKER_RESPONSE_KEY`: broker-only minimal private Ed25519 JWK.
- `FREEDOM_BROKER_KEKS`: broker-only bounded ring of `{keyId,jwk}` entries,
  each a minimal AES-256 octet JWK. Imported handles are nonextractable; key
  material is never returned by HTTP or included in logs.
- `CIPHER_HYPERDRIVE`: dedicated canonical `<databaseName>_broker` login,
  provisioned through the existing `40-credential-broker-grants.psql`.
- `EXECUTOR_HYPERDRIVE`: different canonical `<databaseName>_broker_executor`
  login, provisioned through `45-model-broker-execution-grants.psql`.
- `MEDIA`: the environment's existing private asset bucket, not another store.
- `CREDENTIAL_RECOVERY_STATE` and `CREDENTIAL_RECOVERY_FLOOR`: distinct private
  native service bindings. Their fixed `/internal/credential-recovery/state`
  and `/internal/credential-recovery/floor` paths supply the existing signed
  recovery statement and independent monotonic floor. No recovery fallback.

The profile pins `freedom_staging_next`/`https://staging.freetwai.com` or
`freedom_next`/`https://freetwai.com` and the matching dedicated roles. Wrong
profile, origin, duplicate keys, missing ports, shared role bindings or unsuitable
roles fail closed. Each request checks current DB/role identity, nonadministrative
privileges, no memberships, and the expected vault rights. The executor cannot
read or write vault ciphertext.

## Optional direct credential setup host

The closed `ingest` profile pins `setupOrigin`, main request `issuer`/`audience`,
`requestKeys`, separate `responseIssuer`/`responseAudience`/`responseKeyId`,
`readinessAuthority` and `readinessKeys`. `setupOrigin` must be a distinct HTTPS
origin. Main carries only its ingest request signer and response public pins;
the protected setup form sends secret bytes directly to this broker host.

`FREEDOM_BROKER_INGEST_RESPONSE_KEY` is a separate minimal private Ed25519 JWK.
The Worker verifies a fresh private-key signature under the declared public `x`,
requires canonical 32-byte base64url `x`/`d`, and rejects public identities reused
across execution, ingest, recovery and readiness purposes. Native workerd accepts
some inconsistent private JWKs at import, so successful import alone is insufficient.

`CREDENTIAL_INGEST_READINESS` must resolve the private fixed endpoint
`https://freedom-private-ai.internal/internal/credential-ingest/readiness`.
It supplies `{signedReadiness}`: an EdDSA compact JWS with type
`freedom-credential-capture-readiness+jws`, approved key ID, exact environment,
setup origin and authority, `captureDisabled:true`, and a validity window of at
most 60 seconds. Missing, expired, foreign or invalid statements fail closed.
The signature proves what the authority asserted; it does not independently
prove that edge logs, tracing, body capture or other capture systems are disabled.
An operator must establish that authority and validate the real ingress before
installing a setup hostname. The repository example intentionally omits it.

The optional host uses only the restricted cipher SQL port. Setup and preparation
resume across broker instances from original cookie/CSRF hashes and the durable
one-use preparation record (migration 114). Each request rechecks the original
session, recovery generation, authorization and fixed expiry before creating a
new local handle; stored metadata cannot supply execution authority. Real
browser/Cloudflare routing acceptance remains a release condition. Known
Cloudflare edge headers are removed before the existing strict transport
allowlist; arbitrary `CF-*` headers are not exempt. Native secret-body reads stay
inside the existing authorization/claim path.

## Request and proof lifetime

Only the existing signed, bounded machine statement enters the fixed private
`https://freedom-private-ai.internal/internal/model-execution` receiver. Original
purpose/environment/client/nonce/digest/signature and current original session,
connection, credential, consent and SQL claim checks remain authoritative.
There is no transported Actor, prompt, provider URL or execution capability.

Activation persists an exact immutable binding and reservation in SQL, not an
executable proof. Execution on any broker instance first reads that owned reserved
step and performs fresh provider verification. Only the genuine new opaque proof,
matching recovery generation and evidence origin, can pass the locked SQL CAS and
mint one dispatch capability. Verification cannot extend the original lease.
Concurrent instances may perform read-only provider verification; only one consumes
the reservation. Dispatched, unknown or completed steps never gain another
capability. An interrupted dispatch is not recovered or retried.

Activation acknowledgement and spent authorization replay read SQL metadata only,
without provider verification or a credential resolver. AsyncLocalStorage still
routes SQL proxies into the current request's separate Hyperdrive pools, ended
after that request. Neither SQL clients nor executable proof registries must
survive across requests.

The runtime model-step tests use independent hosts/services against PostgreSQL;
the broker bridge adversarial test additionally uses separate child processes and
a restarted broker with genuine signed claims, restricted SQL roles and synthetic
loopback provider HTTP. These prove local continuity, not remote edge routing.

Native provider fetch preserves the original fixed host selection and bounded
response profile, refuses redirects, enforces deadlines/byte/chunk limits, and
never provides a caller-controlled HTTP proxy.

## Local verification and release gaps

`tests/worker/broker-worker.test.ts` builds the actual Wrangler candidate and loads
it in native workerd. Synthetic native outbound HTTPS proves real fetch GET/POST
and refusal of redirects/oversized output without paid calls.

`tests/worker/broker-worker-sql.test.ts` requires an explicitly owned `fp_*`
loopback/Unix PostgreSQL admin URL. It creates an owned dedicated
`freedom_staging_next` database with restricted roles, applies the original grants,
and removes only those fixture objects afterward. It exercises genuine signed
main-to-broker authorization, encrypted vault custody, native synthetic provider
POST, private R2 Result publication, owner reads, foreign-owner refusal, replay
without a second POST, revoked original session, recovery disagreement and swapped
role/profile denial. The synthetic outbound service is a test fixture, not a real
provider or deployment binding. Every configuration/secret is generated locally.

Remote Hyperdrive/R2/recovery identity and permissions, independent recovery/floor
service deployment, public platform and private broker rollout, real provider
acceptance, multi-replica routing and browser staging acceptance remain release
gaps. `tests/worker/broker-ingest-worker.test.ts` additionally exercises the native
setup bundle with synthetic main signatures, readiness withdrawal, key mismatch
and pad-bit aliases, header/CSRF refusal, encrypted vault commit and replay.
Its synthetic ingress reconstructs requested headers and known-length bodies
inside workerd to avoid Node proxy rewriting; it is not a live browser/edge test.
`private-ai-native-owner-flow.test.ts` exercises both native bundles through the
synthetic owner setup, private Result and Stop/Revoke flow. Neither test is
real owner consent, capture-policy or provider acceptance. No resources,
secrets or staging/live routes are changed by local dry runs or these tests.

## Repository candidate preflight

`npm run check:broker-worker-candidate` is a fixed, static-only check against
the canonical deployment manifest. It reports exact database/role/environment
mappings and required Hyperdrive cache-off readback, but always reports
`deployment_ready:false` and remote cloud `not_run`. Placeholder IDs, comments,
a cache-off variable or synthetic local acceptance cannot supply provider
readback or release authority. This does not replace the existing compatibility
ledger/grants checks or operator release procedure.

`npm run worker:dry-run:broker` bundles both disabled candidate profiles. The
standard verification workflow runs the static check and this dry run before
Worker acceptance tests. These commands do not create bindings, turn on the
broker, install secrets or make remote API calls.
