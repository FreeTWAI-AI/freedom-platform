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
- Optional `ingest`: exactly `{setupOrigin,issuer,audience,keyId}`. The setup origin
  must be canonical HTTPS, without a path, and use a different hostname from the
  platform. These values must match the independently installed broker ingest
  receiver. It is a browser destination, never a provider endpoint.

`FREEDOM_PRIVATE_AI_REQUEST_KEY` is a **main assertion signer**, a secret JSON JWK
with exactly `{kty:'OKP',crv:'Ed25519',x,d}`. It imports nonextractable with only
`sign` usage. Broker response keys must be independent of this signer; the existing
client proves direction separation cryptographically. Optional bootstrap requires
its independent `FREEDOM_PRIVATE_AI_BOOTSTRAP_KEY`, exactly the public P-256 JWK
fields plus `d`; its genuine factory verifies host/key correspondence. Missing or
extra bootstrap key/profile combination fails closed. No default issuer/key exists.

Optional ingest requires `FREEDOM_PRIVATE_AI_INGEST_KEY`, another main-only
Ed25519 private JWK with exactly `{kty:'OKP',crv:'Ed25519',x,d}`. It is imported
nonextractable for signing only. Composition cryptographically rejects reuse of
the model request signer, any broker response verifier or any recovery verifier.
A missing key/profile half, malformed key or unexpected profile field gates the
whole private product. Omitting both retains existing private routes and leaves
credential ingest unavailable.

The genuine ingest client uses the existing main SQL authorization issuer and
signed recovery reader. It signs only an owner-authorized handoff; the browser
posts that handoff to `setupOrigin/credential-setup`, prepares the existing setup
session at `/credential-setup/prepare`, and sends the secret directly to
`/credential-setup/secret`. No additional main service binding is needed. The
browser CSP setup destination is derived from this same genuine installed client.
The main Worker receives no provider secret, including during rotation.

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
configuration and staging/browser acceptance remain **not_run**. Optional ingest
wiring is now installed by this Worker composition; its native workerd tests prove
child dispatch, derived browser destination, malformed/partial rejection and signer
isolation without SQL or provider capability. A separate Node-runtime composition
test uses restricted PostgreSQL roles to verify owner/session-bound signed handoff
issuance, refusal of secret fields and recovery/session withdrawal, owner metadata
reads during recovery outage, and vault read denial. It uses synthetic enrollment
and recovery signatures, with no provider or broker execution capability. These
tests do not prove native Worker SQL ingest or actual secret ingestion.
Optional bootstrap wiring has synthetic target-runtime SQL acceptance above. Existing Node
browser/SQL evidence must not be reported as these target-runtime checks. All
remote resource/secret changes require the existing deployment authorization.


## Owner workflow validation for an installed release

Record the exact source/deployed Worker versions, environment and policy revisions
with each outcome. Keep session cookies, setup assertions, member IDs and provider
metadata in the private operational journal. The following routes already compose
in the main product; installing bindings does not constitute their acceptance.

| Owner action | Existing main route / authority | Required evidence |
| --- | --- | --- |
| Pair actual device | `/execution-api/v1/auth/device-authorizations`, owner `/api/v1/me/device-authorizations/inspect` and `/decide`, token exchange | Actual device key proof and owner approval; no fixture substitution. |
| Select model and billing | `/api/v1/me/model-settings`, existing `/model-connections` | Owner chooses the precise offered model/custody/billing selection; metadata remains unverified until broker verification. |
| Supply BYOK credential | `/api/v1/me/credential-ingests`, independent setup origin | Main response contains only signed handoff; secret never enters main origin, logs or SQL role. Broker confirms matching owner/session/recovery and metadata only. |
| Save/edit private draft | `/api/v1/me/private-work`, `/:id/edit` | Current personal persistence policy; only owner can read title/objective. |
| Approve and execute once | Existing Grant/Run routes, `/model-step-approvals`, `/model-steps`, `/:id:execute` | Exact model and export approval; one committed dispatch, no resubmission after ambiguous acknowledgement. |
| View private Result | `/api/v1/me/private-work/:id/results/current` and result history | Broker finalized immutable private R2 bytes; main owner-authorized read verifies bytes and current policy. |
| Stop/revoke | `/model-steps/:id:stop`, `/model-step-approvals/:id:revoke`, existing connection/model/Grant revocations | In-flight and subsequent effects blocked under current backing; metadata controls remain usable after persistence policy withdrawal. |

Owner model choice and credentials remain prerequisites for actual model acceptance.
The main-side optional handoff does not install an independent setup hostname,
broker ingest/capture receiver, provider host, credential vault or durable recovery
authority. Keep each unaccepted environment/purpose disabled until those original
contracts and the real owner flow have evidence.
