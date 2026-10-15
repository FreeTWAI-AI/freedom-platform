# Contract ownership

`preview/v1/definition.mjs` is the authoring source for the **implemented member-session preview API**. `node scripts/build-contract-bundle.mjs` generates OpenAPI 3.1.1, TypeScript response/request definitions, protocol metadata and a hashed portable SDK bundle. SDK source is in `packages/sdk`; consumers must never edit generated vendor files.

The `preview-contract` module descriptor owns the preview authoring/generated
bundle, shared SDK source/generated protocol, bundle generator and direct
`runtime.preview-protocol` consumer test. Keeping that infrastructure out of an
individual product module lets context and verification select its real boundary
instead of treating every preview change as an unmapped whole-repository change.

The full production planning contracts remain authored once in `docs/platform-plan/contracts/`. Three manifest/event schemas are mechanically exported with the bundle; they are not independently authored copies. Moving all historical planning tests/paths is a separate migration. Exporting an event schema does not activate event delivery or executor APIs.

The local foundation [common identity references](common/README.md) have a separate Zod/TypeScript authoring source and generated JSON Schemas. They are not yet published in a ReleaseSet or preview SDK bundle; reserved service/site shapes do not enable those identities at runtime.

The guild launchpad family (`guild-launchpad/v1`) has a separate Zod authoring source and generated JSON Schemas. `npm run contracts:guild-launchpad` regenerates them and `npm run check:guild-launchpad-contracts` checks the bytes. They are not yet published in a ReleaseSet or the preview bundle and grant no authority.

The combined pagination candidate uses revision `0.4.1`: `listWorksPage` adds a bounded cursor page while legacy `listWorks` stays complete; `listCatalog` and `listCampaigns` use their declared bounded offset pages. These operations share one generated protocol and SDK. Existing exact consumer pins must be deliberately adopted before release; this source candidate does not claim deployed or consumer acceptance.

Consumers pin a full `freedom-platform` commit and bundle SHA-256 in `contracts.lock.json`. The copied verifier checks every artifact locally and, with `--remote`, against that exact GitHub source. This proves byte identity, not official approval or release status. A contract change requires deliberate regeneration, review, updated pins and producer/consumer tests.

New exports use a thin entrypoint backed by the shared contribution-tools implementation. Existing v1 pins and preview bytes remain valid; v2 ReleaseSet verification requires independently supplied publisher approval. The [governance implementation](../governance/README.md) documents the exact-byte signature profile and evidence limits. Adding governance schemas does not publish a production contract or require existing consumers to upgrade immediately.

Current HTTP transport: JSON over HTTPS (HTTP loopback for development), `/api/v1`, member cookie + CSRF + exact Origin, explicit `Idempotency-Key`, quoted integer `If-Match`, structured problem responses. Native SDK writes never retry themselves or follow redirects. Protocol hash negotiation rejects version skew before mutation. No secrets belong in a manifest, bundle, URL, generated page or frontend build.

`PlatformClient.call` reads path `params` only from an own property of its options object; inherited `params` records/getters are ignored, and omission/undefined means an empty record. The supplied params must be a plain record with its realm's `Object.prototype` or a null prototype; iframe/VM plain records are supported without copying. Null, primitives, arrays, dates and class/custom-prototype instances fail with `TypeError` before any request, including those from another realm. Required placeholders are read only from own properties, never inherited IDs/keys. Existing UUID/key syntax and unknown own-name checks still apply; null-prototype options and params records support the same commands and version/idempotency rules. An own params getter is evaluated once.

`PlatformClient.call` accepts `query` only for operations declaring query metadata and reads it only from an own property of its options object. Inherited query records/getters are ignored; an own getter is evaluated once. Omission/undefined means no query parameters; otherwise supply a plain record with its realm's `Object.prototype` or a null prototype, including iframe/VM records without copying. Null, primitives, arrays, dates and class/custom-prototype query instances fail with `TypeError` before any request, including those from another realm. Only own properties of the query record supply values, and unknown own names remain errors. Each value must satisfy the operation's generated query schema; null-prototype options and query records support the same continuation parameters as ordinary records.

Public storefront purpose tokens, agent device flow, leased workers, provider credentials, callbacks and signed project status remain separate production contracts. This preview must not claim those APIs already exist or relax the Portal's CORS/session protections to simulate them.
