# Guild launchpad contracts (v1, local)

Authoring sources:

- [v1/primitives.ts](v1/primitives.ts) — `Version`, `NonNegativeDecimal`, `OpaqueId` (re-exported from common identity, not redefined), `StableKey`, `GuildKey`, `page`, and problem shapes.
- [v1/guild-preferences.ts](v1/guild-preferences.ts) — category preference and classification documents.
- [v1/tenant.ts](v1/tenant.ts) — tenant, workspace, member, and invitation documents.
- [v1/config.ts](v1/config.ts) — launchpad config document. Cross-field checks stay on the server.
- [v1/tenant-work.ts](v1/tenant-work.ts) — tenant manual Work, human Results, module instances, and workspace launchpad context. The work module owns this source. URL query parsers stay in TypeScript.

`npm run contracts:guild-launchpad` writes one JSON Schema per wire document beside those sources, and one bundle at [v1/tenant-work.schema.json](v1/tenant-work.schema.json). `npm run check:guild-launchpad-contracts` compares the exact bytes and does not write. JSON Schema is Draft 2020-12, generated from the Zod source. Generated files are never hand-edited. The thirty per-document files stay beside the bundle; the bundle does not replace them.

## Pinned artifacts

The tenant-work family key is `guild-launchpad.tenant-work`, version `1`, behavior profile `freedom.tenant-work/v1`. Its pinned artifact is `v1/tenant-work.schema.json`, owned by the guild-workspace module. Any byte change to that bundle needs a new release row in a later slice, never an edit of an existing pin.

This family is not published in a ReleaseSet or the preview bundle. A successful parse grants no identity, membership, capability, current version, or quota.
