# Public guide assets: bounded release candidate

This increment implements an opt-in Dragon guide asset path. It does **not**
publish a release, create a bucket, upload art, grant credentials, deploy a
Worker, or claim that provider/publisher acceptance has passed. Production
release is OFF in `packages/public-guide-assets/release.ts`; its publisher
receipt remains `null`. No environment variable can override that code pin.

## Public content, private origin

The dedicated `GUIDE_STATIC` R2 binding is for `platform-public` guide artwork.
Its origin bucket must remain private: no `r2.dev` or custom public bucket domain.
The same-origin Worker is the only public reader. The member `MEDIA` binding
continues to have purpose `member-private`; it is never used as a guide fallback.
The app's guide port exposes only `release` and `fetch`; the native R2 adapter
captures only `get` and accepts only digests in the pinned manifest. There is no
arbitrary key, URL proxy, upload, listing, deletion, executable code or SVG API.

`deploy/cloudflare/environments.json` declares separate optional target names,
not provisioned-resource evidence or a requirement to create new physical buckets.
An operator may instead review a compatible existing platform-public bucket and
set its exact manifest name plus `referenced_preexisting: true`. Such an entry is
excluded from this plan's owned mutation targets while retaining exact binding
checks and environment separation. A public-purpose bucket with an incompatible
public-domain/ACL policy is not silently repurposed; that requires separate
operator review. No current provider inventory was read by this change.
`r2-purposes.mjs` verifies exact purpose / binding /
per-environment bucket mappings. It rejects public origins, crossed MEDIA and
GUIDE_STATIC buckets, crossed staging/public names, duplicate or unknown bindings,
and alternate preview stores. The generic Wrangler checker uses this same strict
check; the media checker selects the explicit MEDIA purpose rather than assuming
that exactly one private bucket exists. The broker still accepts only MEDIA.

This work does not edit media ACLs, consent, share-generation validation,
PostgreSQL policy or media lifecycle. Preserve the latest operator-approved
MEDIA domain flags, bridge/persistence policies, bucket binding and GC setting.
Those settings are independent of the default-OFF guide release. Repository
templates and this local guide fixture are not evidence of live operator state.
Never replace the accepted operator release overlay with historical all-OFF or
partial-rollout settings.

The architecture already describes public sanitized and private R2 in
[architecture](../platform-plan/02-architecture-repositories.md) and
[hosting](../platform-plan/08-bootstrap-hosting-project-lifecycle.md). The
[09:03 migration record](../platform-plan/execution/unified-foundation/actual-migration-2026-10-04.md)
records separate private R2 bindings, but is not a complete current bucket
inventory. Neither this repository nor a placeholder name establishes whether an
approved reusable public-purpose bucket currently exists. Verify current operator
inventory and provider readback before selecting an actual mapping.

## Release and request contract

- `GET /api/v1/guide-packs/release` returns `{ "enabled": false }` by default
- An explicitly installed local fixture returns `enabled: true`, `pack`, `version`
  and `manifestSha256`; this endpoint always uses `Cache-Control: no-store`
- Only exact `GET` / `HEAD` requests to
  `/public/guide-packs/dragon/{version}/{sha256}.webp` can return an object
- Every object must be listed in the release-pinned manifest; unknown versions,
  digests, extensions, queries, methods and Range requests terminate with 404
- Invalid/corrupt storage data fails closed with 503; missing objects return 404
- The entire guide namespace is terminal before mutation parsing and SPA/static
  fallback, including missing, disabled and malformed guide paths
- Every successful GET **and HEAD** verifies actual bounded bytes, byte count,
  SHA-256, static WebP structure and pinned dimensions before sending success
- Only that validated 200 result explicitly overrides platform no-store with
  `public, max-age=31536000, immutable`; all guide errors remain no-store
- Responses use fixed image/webp, nosniff and same-origin resource policy; R2
  custom metadata, ETags and claimed hashes cannot authorize success
- The endpoint intentionally does not expose a separate manifest URL; frontend
  logical IDs resolve through the bundled, pinned manifest after the host gate

Current limits: 512 logical assets, 2 MiB per object, 64 MiB total declared bytes,
256 KiB manifest, 4096×4096 dimensions. Reads are bounded before allocation or
success, with 5-second object/stream deadlines and a 4096-chunk bound. No partial
success is streamed before integrity verification. Local limits are not remote
Worker CPU, memory or cost acceptance.

## Manifest, exact bytes and source

`contracts/guide-packs/manifest.schema.json` is a closed JSON Schema generated from
`guideManifestSchema`. Root, source and asset records all reject unknown keys.
The manifest contains no self-hash. `release.ts` independently pins SHA-256 of the
exact UTF-8 JSON file bytes, including whitespace/newline; no parse/reserialize
or canonicalization can substitute for the exact-byte pin.
`dragon-manifest.generated.ts` embeds those identical bytes in the Worker bundle.
The local checker rejects any drift among source file, literal and pin.

The Dragon v1 candidate records
`https://github.com/mars-tw/freedom-platform` commit
`46a40342509a9278c3a7b8a940bce27b7f464227`. The manifest records provenance, not new
licensing rights, official status or publisher approval. Source attribution and
art review are retained with the art contribution.

There are 364 logical IDs, 338 unique digest paths and 41,016,186 logical bytes.
Aliases such as hero/frame-0 may share a digest only when byte length, MIME and
dimensions agree. Logical IDs themselves are unique and bounded relative names.
Actual WebP bytes live in `assets/guide-packs/dragon-v1-20261004/`, outside Vite's
public tree, so building the ordinary app does not publish the fixture files.

## Local-only validation

The Node adapter rejects fixture injection outside `FREEDOM_ENV=local`.
For the ordinary local server, set `FREEDOM_GUIDE_FIXTURE_ENABLED=true` explicitly;
absence leaves the release OFF. The E2E host installs the same local factory
under its own explicit fixture flag. The fixture reader rejects symlinks,
hard-linked files, mismatched size and non-manifest paths, then runs the same
response validation as R2. Fixture success is local evidence only.

Read-only publisher plan:

```sh
node --import tsx scripts/guide-pack-publish-plan.ts \
  --fixture-root assets/guide-packs/dragon-v1-20261004
```

The plan verifies every local file's actual bytes/SHA, WebP container, decoded
MIME and dimensions using sharp, along with the exact manifest pin. It emits
reviewable digest object keys, metadata and totals. It has no execute/upload or
credential argument, never creates a bucket and never changes release state.
Successful output explicitly retains `production_enabled=false`,
`provider_mutations=0`, `publisher_receipts=not_run`.

Before any future activation, a separately authorized publisher must establish
private-origin bucket identity and per-environment separation, publish immutable
objects, perform actual readback checks, retain receipts tied to the manifest pin,
and complete remote acceptance. The reviewed release pin and host flag may only
be enabled after that evidence; the present implementation does none of those
external actions.

## Focused checks

```sh
node --import tsx --test --test-concurrency=1 tests/runtime/guide-pack-assets.test.ts
node --import tsx --test --test-concurrency=1 tests/worker/guide-pack-assets.test.ts
node --test deploy/cloudflare/test/guide-r2-purposes.test.mjs \
  deploy/cloudflare/test/preflight.test.mjs \
  deploy/cloudflare/test/media-wrangler.test.mjs \
  deploy/cloudflare/test/broker-wrangler.test.mjs
npm run typecheck
```

Runtime checks exercise the real platform middleware and terminal SPA fallback;
the Worker check uses local workerd with separate ephemeral native R2 bindings.
Its synthetic manifest is a test harness injection, not a production release or
remote provider receipt. The existing member/private MEDIA object remains
untouched throughout its tests.
