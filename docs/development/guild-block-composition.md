# Reviewed guild block composition

This source candidate extracts the supplier launchpad entry and adds an upcoming-events
example for `guild_event_space`. It does not enable an app marketplace or runtime plugins.
It does not close Foundation/M1 or claim that two real guild developers tried the workflow.

## Small build-time seam

The existing [composition](../../apps/portal-web/src/modules/guild-blocks/composition.ts)
is the only registration list. Each bundled entry has an ID, explicit version `1`, guild
keys, one of two slots (`primary` or `after_core`), existing surface IDs and a statically
imported React component. The host uses the existing page error boundary so a failing
additional block does not replace the seven core sections. Unsupported versions,
invalid slots and conflicting primary entries fall back to the original primary/core
with an explicit unavailable message. This is defensive handling of reviewed build
configuration, not a sandbox for arbitrary components.

The stored `guild-launchpad.config/v1` contract stays unchanged: exactly seven known
block kinds, strict fields, and `extensions: {}`. It cannot select a component, script,
URL, capability or composition version. There is no new server config, migration,
permission, package, framework, external loader or dynamic import path.

Custom guilds retain their published config. For the supplier guild, a customized
recommendation order still controls the primary action: the supplier block applies
only when the existing primary is the offered hosted-store release and the applications
block is enabled. Manual-workspace and other primaries retain their existing rendering.
The event example is an appended read-only build-time block, not an eighth editable v1
block. It is deliberately not configurable in the existing seven-block editor.

## Examples and authority

- Supplier: reuses `MyStoreAction` and its existing `/me/supply-catalogs` reader.
  Opening a catalog or list routes to the existing `SupplyCatalogList` /
  `HostedSupplyCatalog` domain; those components are not duplicated. Starting setup
  invokes the original application launch flow, with original leave/pending-result
  guards and authoritative API eligibility. Intern and visitor rules remain unchanged.
- Events: reads only existing member `GET /events`; shows at most three published
  future events already readable by this member, ordered by time and ID. This is the
  member's accessible event list, not a new guild-wide authorization rule or only
  events hosted by that guild. No location, joining URL, attendee list, RSVP, submission
  or other write is exposed. Detail/list links return to `#events/:id` / `#events` through
  the host's existing navigation guard. Public/visitor views do not fetch this API.
  The original list is not cursor-paged: it retains all current/own rows and caps
  only other ended published history. The three-item preview therefore does not
  filter just the first page of a paged feed.
  Leaving, changing guild/account/session or retrying aborts/discards obsolete reads.

The public [UI interface](../../packages/shared/guild-block-ui.ts) is type-only and
owned/exported by the existing shared module. It has a structural read port and accepts
the existing application DTO as a type parameter; it imports no shell, client or domain
implementation. Domain components depend on this neutral interface, never on the host.

The [guild descriptor](../../modules/guild-workspace/freedom.module.json) owns the host
and composition and declares its hosted-distribution/community dependencies. The supplier
example belongs to [hosted distribution](../../modules/agent-commerce/hosted/freedom.module.json),
and the event example belongs to the community descriptor. References
point to the existing [commerce](../../modules/agent-commerce/freedom.module.json) and
[community](../../modules/community/freedom.module.json) surfaces. There is no second
ownership/capability manifest. Surface references describe dependencies; they grant no
runtime authority and do not prove ACL correctness.

## Add a third reviewed block

1. Implement a normal React component using `GuildBlockContext` and existing domain
   contracts/API; keep writes in their original domain flow. Use design tokens, explicit
   loading/empty/error states, abort/session fencing, and `navigate` for internal links.
2. Add one static import and versioned entry in the composition list, referencing real
   existing surface IDs. Update the owning descriptor/dependencies if needed. A new API
   or authority boundary is a separate reviewed task, not implied by this seam.
3. Add a synthetic state fixture and behavior tests. Do not edit `App.tsx` or
   `GuildLaunchpad.tsx` for another block using these slots. The third-component test
   demonstrates that bounded path; it is not a claim of unlimited plugin compatibility.
4. Keep required CI unchanged and pass the full existing checks before publication.

## Standalone synthetic preview

After installing the repository's exact dependencies:

```sh
npm run typecheck
npm run build
node node_modules/vite/bin/vite.js build --config apps/portal-web/guild-block-preview/vite.config.ts
node node_modules/vite/bin/vite.js preview --config apps/portal-web/guild-block-preview/vite.config.ts
```

Open `http://127.0.0.1:4337` in your local browser. Select either guild and loading,
empty, error, member, visitor or intern state. Toggle simulated leave blocking and
check the displayed navigation destination. This separate Vite entry uses only mock
reads and mocked action callbacks; no PostgreSQL, account or live API is needed.
It is not part of the production Vite inputs and must not be deployed as production UI.
The core-section placeholder is labelled as a placeholder, not an entire launchpad test.

Focused source checks (no database):

```sh
node --import tsx --test tests/runtime/guild-block-composition.test.ts tests/runtime/launchpad-profile-defaults.test.ts
npm run check:guild-launchpad-contracts
```

These tests cover strict v1/custom config, recommendation fallback, supplier destination,
visitor/intern rendering, invalid build entries, existing surface references, event
projection/states and adding a third synthetic block. They do not replace real session,
revocation, PostgreSQL, full-browser, CI or real-user acceptance evidence. The existing
`npm test`, `npm run test:e2e`, contract/repository checks and required CI remain required.
