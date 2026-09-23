# Contract ownership

`preview/v1/definition.mjs` is the authoring source for the **implemented member-session preview API**. `node scripts/build-contract-bundle.mjs` generates OpenAPI 3.1.1, TypeScript response/request definitions, protocol metadata and a hashed portable SDK bundle. SDK source is in `packages/sdk`; consumers must never edit generated vendor files.

The full production planning contracts remain authored once in `docs/platform-plan/contracts/`. Three manifest/event schemas are mechanically exported with the bundle; they are not independently authored copies. Moving all historical planning tests/paths is a separate migration. Exporting an event schema does not activate event delivery or executor APIs.

Consumers pin a full `freedom-platform` commit and bundle SHA-256 in `contracts.lock.json`. The copied verifier checks every artifact locally and, with `--remote`, against that exact GitHub source. This proves byte identity, not official approval or release status. A contract change requires deliberate regeneration, review, updated pins and producer/consumer tests.

Current HTTP transport: JSON over HTTPS (HTTP loopback for development), `/api/v1`, member cookie + CSRF + exact Origin, explicit `Idempotency-Key`, quoted integer `If-Match`, structured problem responses. Native SDK writes never retry themselves or follow redirects. Protocol hash negotiation rejects version skew before mutation. No secrets belong in a manifest, bundle, URL, generated page or frontend build.

Public storefront purpose tokens, agent device flow, leased workers, provider credentials, callbacks and signed project status remain separate production contracts. This preview must not claim those APIs already exist or relax the Portal's CORS/session protections to simulate them.
