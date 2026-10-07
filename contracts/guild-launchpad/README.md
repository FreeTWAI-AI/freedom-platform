# Guild launchpad contracts (v1, local)

Authoring sources:

- [v1/primitives.ts](v1/primitives.ts) — `Version`, `OpaqueId` (re-exported from common identity, not redefined), `StableKey`, `GuildKey`, `page`, and problem shapes.
- [v1/guild-preferences.ts](v1/guild-preferences.ts) — category preference and classification documents.
- [v1/tenant.ts](v1/tenant.ts) — tenant, workspace, member, and invitation documents.
- [v1/config.ts](v1/config.ts) — launchpad config document. Cross-field checks stay on the server.

`npm run contracts:guild-launchpad` writes one JSON Schema per wire document beside those sources. `npm run check:guild-launchpad-contracts` compares the exact bytes and does not write. JSON Schema is Draft 2020-12, generated from the Zod source. Generated files are never hand-edited.

This family is not published in a ReleaseSet or the preview bundle. A successful parse grants no identity, membership, capability, current version, or quota.
