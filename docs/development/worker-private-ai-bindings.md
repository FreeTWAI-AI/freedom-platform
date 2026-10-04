# Private AI Worker binding candidate

This increment adds request-scoped composition to the real platform Worker and
native service-binding transport for [the existing authenticated broker
contract](../../contracts/execution/v2/model-broker-bridge.ts). It does not deploy
a broker, establish provider/capture readiness, or configure staging/public.
The normal Wrangler configuration remains explicitly disabled.

`workerPrivateAiPorts` captures this request's main Hyperdrive pool, the existing
`MEDIA` private asset bucket, server trust profile and native service bindings.
It constructs the genuine product and signed reference client, then binds them to
the same pool/origin/environment. Invalid or incomplete installation leaves
private AI routes gated; member login/ordinary routes retain their normal ports.
It never imports a Node process listener, accesses `process.env`, resolves a
provider key, or supplies a cipher database/KEK. Worker builds replace the native
provider HTTP transport with a failing adapter while retaining canonical opaque
proof registries. Node broker provider transport remains separate.

## Declared candidate bindings

[wrangler.private-ai.example.jsonc](../../wrangler.private-ai.example.jsonc) is a
non-deployable example with zero Hyperdrive IDs, replacement service/bucket names,
no routes and `FREEDOM_PRIVATE_AI_ENABLED=false`. It declares separate staging and
production service names. Its `MEDIA` must name the existing environment's one
private asset bucket; it does not introduce another storage authority.

| Binding | Authority and fixed request |
| --- | --- |
| `HYPERDRIVE` | Existing main role; caching disabled by infrastructure configuration. Runtime grants exclude ciphertext and broker write/claim authority. |
| `MEDIA` | Existing private environment asset bucket, through canonical R2 ObjectStore. |
| `MODEL_BROKER` | Native private service binding; POST `https://freedom-private-ai.internal/internal/model-execution`, canonical signed request envelope only. |
| `CREDENTIAL_RECOVERY_STATE` | Separately managed signed external recovery state; GET `/internal/credential-recovery/state` at the same fixed internal origin, closed `{signedState}` response. |
| `CREDENTIAL_RECOVERY_FLOOR` | Separately persisted monotonic authority, independent of the platform PostgreSQL/R2 snapshots; GET `/internal/credential-recovery/floor`, original `CredentialRecoveryFloorSchema`. |

The three native bindings must be distinct objects. This check prevents accidental
reuse inside composition; names/objects alone do not prove deployed isolation or
independent persistence. Broker/recovery infrastructure remains operator evidence.

## Closed profile and secret ownership

Enable only with literal `FREEDOM_PRIVATE_AI_ENABLED=true` and the complete
`FREEDOM_PRIVATE_AI_PROFILE` JSON string. The exported
`WorkerPrivateAiProfileSchema` rejects extra fields and requires:

- `environment`: `staging-next` for `FREEDOM_ENV=staging`, `next` for `public`.
- `platformOrigin`: exact current `APP_ORIGIN`; checked before DB/binding calls.
- `clientId`, `issuer`, `audience`, `brokerIdentity`, `responseAudience`, `requestKid`.
- `responseKeys` and `recoveryKeys`: 1–16 `{keyId,publicJwk}` entries, public
  Ed25519 JWKs with exactly `{kty:'OKP',crv:'Ed25519',x}`. Duplicate key IDs fail.
- `recoveryAuthority` and `settingsSelections`: original closed BYOK catalog DTOs,
  maximum 50; model metadata remains unverified.
- Optional `bootstrap`: original `DeviceAuthorizationHostSchema`, checked by the
  genuine bootstrap factory against the same product origin/environment/client.

`FREEDOM_PRIVATE_AI_REQUEST_KEY` is a **main assertion signer**, a secret JSON JWK
with exactly `{kty:'OKP',crv:'Ed25519',x,d}`. It imports nonextractable with only
`sign` usage. Broker response keys must be independent of this signer; the existing
client proves direction separation cryptographically. Optional bootstrap requires
its independent `FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY`, exactly the public P-256 JWK
fields plus `d`; its genuine factory verifies host/key correspondence. Missing or
extra bootstrap key/profile combination fails closed. No default issuer/key exists.

The main Worker must never receive a broker response private key, vault KEK,
provider API key, cipher-role connection string, recovery signer, or monotonic
floor write capability. The independently composed broker needs its own narrow
executor and cipher roles, existing SQL grant exclusions, broker response signer,
KEK and current recovery/capture/provider ports. A signed envelope authenticates a
narrow purpose; the original-session SQL claim still decides effects.

## Native exchange and receiver boundary

`createModelBrokerServiceBindingExchange` posts only the original closed request
schema. It rejects redirects, cookies, content encoding, invalid media/UTF-8,
duplicate keys and oversized output; calls have an outer deadline and the bounded
body reader. Main's genuine broker client verifies the independent signed response
and re-reads current owner SQL. No plaintext, prompt, Actor, endpoint override or
opaque execution handle enters this exchange.

`createBrokerServiceBindingReceiver` accepts only a bridge registered by the
actual `createBrokerBridge` constructor, fixed POST URL and machine credential
mode. Copied/forged handles are refused. The bridge verifies pinned Ed25519
operation/purpose/environment/client/issuer/audience and current SQL authority.
The adapter itself does not bootstrap a broker Worker or manufacture execution
ports. Its early URL/method/credential checks run before the body reader.

## Verification and remaining work

The native workerd transport tests use real service-binding calls between two
workers and independent genuine Ed25519 signatures. Their broker deliberately
has no member SQL authority and returns a signed unavailable-registry result;
this proves transport/purpose authentication, not provider execution. Additional
checks cover wrong profiles before I/O, forged handles, redirects and bounded
output. The real Wrangler main bundle loads in workerd with the pinned
compatibility date; missing bindings remain unavailable and native provider
transport/listeners are excluded.

The actual Wrangler bundle also runs in native workerd with Hyperdrive connected
to an owned synthetic PostgreSQL 18.6 database using a restricted application role.
It verifies member model metadata and genuine device pairing, owner approval,
one-time signed bootstrap exchange, connection revocation and blocked refresh.
Broker/recovery calls remain zero for those flows. A synthetic native ingress
Worker supplies canonical requests because Miniflare's Node entry rewrites Host
and rejects foreign Origin headers; this is not public ingress/browser evidence.
The main SQL role cannot read the credential vault.

Full Worker + Hyperdrive member SQL → independent broker SQL/provider execution,
credential setup/capture ingress, signed recovery service deployment, real bucket
configuration and staging/browser acceptance remain **not_run**. No ingest port
is installed by this Worker composition. Optional bootstrap wiring has synthetic target-runtime SQL acceptance above. Existing Node
browser/SQL evidence must not be reported as these target-runtime checks. All
remote resource/secret changes require the existing deployment authorization.
