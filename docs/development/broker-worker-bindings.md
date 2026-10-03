# Independent model broker Worker candidate

This candidate composes the existing genuine credential vault, authorization
registry, model host, runner, private Result finalizer and authenticated bridge in
an independent Worker. It is disabled by default and is not a deployment record.
The main platform Worker must never receive the broker KEK ring, cipher role,
response private signer or provider resolver.

`wrangler.broker.example.jsonc` uses the native HTTPS provider adapter only in
this broker bundle. The ordinary platform bundle still has the unavailable
provider adapter; Node's original provider transport remains available unchanged.
There are no public routes, worker previews, generated key defaults or ingress
credential routes in this candidate.

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

## Request and proof lifetime

Only the existing signed, bounded machine statement enters the fixed private
`https://freedom-private-ai.internal/internal/model-execution` receiver. Original
purpose/environment/client/nonce/digest/signature and current original session,
connection, credential, consent and SQL claim checks remain authoritative.
There is no transported Actor, prompt, provider URL or execution capability.

The existing opaque activation bundles must survive activation to execution in
the same broker isolate. A cache contains genuine factories and opaque proof
registries, not SQL clients. AsyncLocalStorage routes their SQL proxies into the
current request's separate Hyperdrive pools, which are always ended after that
request. Calls outside the request scope fail. Pools/clients never persist in the
isolate cache. Another isolate or restarted Worker cannot reconstruct proof from
SQL; it returns unavailable, preserving the original fail-closed behavior.
This candidate does not claim cross-replica affinity, Durable Object execution,
or recovery of an interrupted dispatch.

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
gaps. Direct credential ingest is not installed by this Worker. No resources,
secrets or staging/live routes are changed by local dry runs or these tests.
