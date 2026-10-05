# Private AI authority candidates

These Workers are the missing backing services for the existing private-AI
clients. They do not replace the broker, the main Worker, or the verifiers.

Each purpose is a separate deployment with its own Durable Object namespace.
The example Wrangler config leaves every flag `false`, sets `workers_dev` and
`preview_urls` to `false`, and declares no public routes, Hyperdrive, R2, or
keys. This repository does not deploy them.

| Instance | Client path | Response | Signer |
| --- | --- | --- | --- |
| `recovery-state` | `GET https://freedom-private-ai.internal/internal/credential-recovery/state` | `{signedState}` using `SignedCredentialRecoveryStateSchema` | Ed25519 secret `FREEDOM_AUTHORITY_SIGNING_KEY` |
| `recovery-floor` | `GET https://freedom-private-ai.internal/internal/credential-recovery/floor` | `CredentialRecoveryFloorSchema` | none |
| `capture-readiness` | `GET https://freedom-private-ai.internal/internal/credential-ingest/readiness` | `{signedReadiness}` using `CaptureReadinessClaimsSchema` | a different Ed25519 secret |

The floor must not be given a signing key. State and readiness keys are not
interchangeable. No member id, provider credential, or private key is written
to Durable Object storage.

## Generation

Recovery state and recovery floor each persist one monotonically increasing
generation in their own object. The object name is `purpose`, `environment`,
and `authority`. It does not include the generation, and nothing in this
Worker deletes or resets storage.

The configured generation arrives only as operator config
(`FREEDOM_AUTHORITY_PROFILE`). There is no public write or advance route. A
read-only GET may initialize an empty object to that generation inside one
storage transaction. A later config lower than the stored generation fails
closed, including after the isolate is evicted. A higher config is an explicit
operator release and becomes the stored generation. SQL snapshots, R2 objects,
and process memory are not the authority.

The existing `createSignedRecoverySource` verifier still has to observe the
same generation from the signed state and the floor. These Workers do not call
each other.

Claims are short-lived: recovery responses last 120000 ms, inside the
verifier's 300000 ms maximum. Floor `expiresAt` is minted on each read. The
persisted value is the generation.

## Capture readiness

Readiness signs `captureDisabled: true` only when the installed profile
contains an operator-supplied `capturePolicySha256`. The signature proves that
this authority produced that claim. It does not prove that edge logs, tracing,
or body capture are disabled.

Operational capture verification is **unavailable** until root reads the live
ingress controls back. A fresh signed claim is not that readback.

The digest is stored in that instance's Durable Object. Removing it from the
profile fails closed and leaves the stored digest in place. Each operator release requires `capturePolicyVersion`, a positive decimal revision.
The Durable Object persists that revision, digest and setup origin transactionally.
Lower revisions, or a changed digest/origin at the same revision, fail closed,
including after restart. A changed policy requires a strictly larger revision.
The stable object name excludes policy revision/digest; retain its namespace
and identity across releases. Never recreate storage to bypass a rollback denial.
The Durable Object independently validates its own enabled installed profile and
requires an exact match with the caller profile. Caller headers cannot advance
or initialize a different profile. Keep this namespace private to its script.

## Enablement

`FREEDOM_PRIVATE_AI_AUTHORITY_ENABLED` must be the literal `true` before a
request is served. The checked-in example keeps it `false` on the default
script and on all six environment scripts. Enabling a staging instance, and
any production instance, remains a separate root decision. Broker and main
private-AI flags are unchanged by this package.

## Limits

- No cloud deploy, secret creation, or provider call is performed here.
- The broker example still points its service bindings at placeholders. This
  package does not edit that config or the installation preflight.
- A local Miniflare test is not multi-replica Cloudflare evidence.
- Signing-key rotation is picked up on the next request because the key is
  imported per request. Generation storage is not rotated with the key.
- Clock skew that makes `issuedAt` later than the verifier's clock fails closed
  in the existing verifier.
