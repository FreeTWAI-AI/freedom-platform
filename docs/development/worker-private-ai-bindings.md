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
`sign` usage. Every imported private JWK (model request, optional ingest and
bootstrap) must pass a real sign/verify probe against its declared public
coordinates before installation: workerd import alone accepts mismatched Ed25519
`x`/`d` material. Broker response keys must be independent of this signer; the existing
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

The combined [native owner-flow test](../../tests/worker/private-ai-native-owner-flow.test.ts)
now runs both actual bundles with restricted Hyperdrive PostgreSQL roles, main
owner/session-authorized handoff, direct broker secret ingestion, encrypted vault
custody, one synthetic outbound provider POST, private R2 Result, owner read/edit,
foreign-owner refusal, recovery outage, Stop and Revoke. It uses locally generated
credentials, recovery/readiness statements and synthetic owner approval. This is
local integration evidence, not actual owner consent or provider acceptance.
The ingress fixture restores headers and known-length bodies inside workerd; it
cannot establish real browser/Cloudflare capture behavior or replica continuity.

Signed recovery/readiness service deployment, real bucket/binding configuration,
provider authentication and staging/browser acceptance remain **not_run** here.
The optional handoff and bootstrap are implemented, but their deployment and
actual owner workflow still require the evidence below. The broader P3 official
CLI, local keychain and cross-device paths retain their separate acceptance
requirements; this broker's BYOK result does not complete them.


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


## P3 installation worksheet and acceptance handoff

Complete this worksheet for one environment before adapting the existing main
and [broker candidate](broker-worker-bindings.md). This is an operator input list,
not an installation receipt. Keep the candidate flags OFF until installation and
release conditions have been assessed. Do not copy synthetic test keys, readiness
assertions, device approval or model labels into an owner installation.

| Input / relationship | Exact correspondence to record |
| --- | --- |
| Environment and origin | Main `environment`, broker `environment` and runtime environment agree: `staging-next` / `https://staging.freetwai.com` or `next` / `https://freetwai.com`. Pin source and deployed versions separately. |
| SQL identities | Broker `databaseName` is respectively `freedom_staging_next` or `freedom_next`; cipher and executor roles are that name plus `_broker` and `_broker_executor`. Main keeps its restricted application role. Record actual grants and all Hyperdrive cache-off readbacks. |
| Shared execution identity | Main and broker `clientId`, `issuer`, `responseAudience`, `recoveryAuthority` and recovery public pins agree. Main `audience` equals broker `requestAudience`; main `brokerIdentity` equals broker `brokerId`. |
| Model request / response keys | Main `requestKid` and request public key appear in broker `requestKeys`. Broker `responseKeyId` and response public key appear in main `responseKeys`. Private signers remain with their respective owners. |
| Credential setup | Both `ingest` profiles use exactly the same `setupOrigin`, `issuer` and `audience`. Main `ingest.keyId` and ingest public key appear in broker `ingest.requestKeys`. The setup hostname differs from the platform hostname. |
| Broker-only setup response | Assign broker `ingest.responseIssuer`, `responseAudience`, `responseKeyId` and its independent `FREEDOM_BROKER_INGEST_RESPONSE_KEY`. These are not the execution response identity, main ingest signer or recovery/readiness signer. |
| Recovery ports | Install both fixed state/floor bindings from the binding table, with current signed generation and independently persisted monotonic floor. Record state/floor agreement and fail-closed outage behavior. Neither authority is reconstructed from a platform DB/R2 backup. |
| Protected capture readiness | Install the broker-only `CREDENTIAL_INGEST_READINESS` binding, authority and public pins specified in the broker document. Record actual ingress logging/tracing/body-capture controls and their trusted readiness source. A fresh signed `captureDisabled:true` assertion alone is insufficient operational evidence. |
| Assets and secrets | Both Workers refer to the existing environment `MEDIA` bucket. Broker alone owns the KEK ring and cipher connection. Check purpose-separated key material, not merely different key IDs. Secrets and resource identifiers stay in the private installation record. |
| Device and model | Record the actual device/bootstrap host and owner's explicit selection. The current broker catalog accepts `providerRef` openai or anthropic, the owner's exact `modelRef`, `credentialCustody:platform_vault`, `engineLocation:platform`, `billingSource:user_byok`, `processingLocation:provider_remote`, `artifactCustody:platform_asset`. Metadata does not verify availability or authorize a charge/export. |

The owner's model/provider choice is still an unanswered input for this P3 work;
no default selection or owner credential has been supplied by this worksheet.
Provider authentication occurs only through the installed independent setup
surface and owner-approved workflow. Main does not need the provider secret.

For repository preparation, run the existing static check and bundle check:

```sh
npm run check:broker-worker-candidate
npm run worker:dry-run:broker
```

The static command takes no profile or credential arguments and deliberately
reports `deployment_ready:false`; these commands do not validate operator-filled
profiles, install remote bindings or authorize enabling a flag. Compare the
installation against the actual closed
[main schema](../../apps/platform-api/src/worker-private-ai.ts) and
[broker schema](../../apps/credential-broker/src/worker-profile.ts), then preserve
remote resource and permission readback through the existing release procedure.

Before actual owner model acceptance, verify the setup POST, prepare and secret
requests across real browser/edge routing. Setup sessions and activation proof
registries are isolate-local; cross-isolate/restart behavior must stay fail-closed.
Do not claim a usable multi-replica installation solely from the single-isolate
native test or silently regenerate authority after an unavailable/ambiguous result.

Use the owner-action table above as the acceptance sequence. Record each step as
`not_run`, `pass` or `fail`, with source/release, environment and a private receipt
reference. Include successful private Result bytes and an actual owner edit,
foreign-owner denial, Stop/Revoke, and controlled recovery/readiness withdrawal
before further effects. Preserve any failed or ambiguous attempt; never retry an
uncertain dispatch as a fresh paid execution. Publish only aggregate outcomes.
