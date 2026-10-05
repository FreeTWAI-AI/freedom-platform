# Dragon guide publisher evidence — 2026-10-05 UTC

The operator published the exact #116 / `a8e2c2e82f1da1919f54a71002c7134ae216b2e3`
Dragon manifest to separate staging and production GUIDE_STATIC origins. Both
buckets contain **338 unique objects / 37,769,448 bytes** for the 364 logical IDs.
Every object was fetched back in full through the authenticated provider API and
checked against its manifest SHA-256, byte length and `image/webp` MIME. The local
plan separately decoded all source WebP files and checked their dimensions.

| Environment | GUIDE_STATIC bucket | Readback |
| --- | --- | --- |
| staging | `freedom-staging-next-guide-static` | 338/338 |
| production (`next`) | `freedom-next-guide-static` | 338/338 |

The operator read back both bucket identities and origin settings before and
after upload: managed `r2.dev` access disabled, zero custom public domains.
No existing bucket was repurposed. Uploads used digest keys; existing bytes were
verified rather than replaced. Per-object request references and check times are
in the receipts. These are operator records of authenticated provider responses,
not provider-signed attestations or proof of deployed browser behavior.

- [Receipt set](../../contracts/guide-packs/receipts/dragon-v1-20261004.json)
- [Staging full readback](../../contracts/guide-packs/receipts/dragon-v1-20261004-staging.json)
- [Production full readback](../../contracts/guide-packs/receipts/dragon-v1-20261004-next.json)

Exact manifest SHA-256:
`506d5fe7eb653874286baeb58b3bc47f44e243279104fae2d9a8ada2a65723ee`.
The activation code pin binds the exact receipt-set bytes; that set binds both
complete receipts. CI checks that each receipt covers the manifest's entire
unique object set, sizes, MIME, private origin and separate target identity.

## Activation and deployment gates

The receipt phase completed with both Workers still on `d269a8d` and the guide
release OFF. This separate change enables the reviewed code pin. It does not
deploy a Worker or set a live host flag. The native host still requires
`FREEDOM_PUBLIC_GUIDE_ENABLED=true` and its own `GUIDE_STATIC` binding. Default
Node servers and Workers without that flag remain off.

Manifest initialization is shared per native bucket binding in the Worker
isolate, including concurrent initialization. Host disablement is checked on
every installation call; changing the binding selects a separate service.
The cache contains no R2 reads, response streams or image bytes, so every asset
GET/HEAD still performs its own full integrity verification.

After this change passes CI, independent review and normal merge, the operator
must deploy the merged SHA to staging and validate the three legacy themes make
zero guide requests, the opt-in Dragon flow works, denied/unjoined access cannot
mount it, and page/account/theme changes clean up pending work. Only successful
staging acceptance permits production deployment and live version verification.
Provider readback receipts alone are not staging/production HTTP or browser
acceptance. At this record's creation no new Worker was deployed.

## Existing MEDIA preserved

Provider snapshots confirmed MEDIA still maps to
`freedom-foundation-candidate-20261004-media` in staging and
`freedom-foundation-production-20261004-media` in production. All six media host
flags remain ON. Separate read-only database transactions confirmed six domain
policies plus `member.avatar` remain in bridge mode and asset GC stays OFF.
Private AI remains OFF. Publisher actions touched only the two new guide buckets.

The operator prepared private deployment overlays from the accepted current
installation, preserving all existing variables, MEDIA, Hyperdrive, secrets,
routes and other bindings. The task's private helper is separate from the shared
release helper; crossed guide buckets, MEDIA drift, media flags being turned off,
unapproved SHA and premature guide activation fail its checks. Historical
repository MEDIA templates must not replace the accepted live overlay.

## Validation and coordination

Before preparing this activation change, the exact #116 base passed a fresh
frontend build, typecheck, 63 focused runtime tests, 19 Chromium guide cases,
one native workerd/R2 case, four R2-purpose tests and 48 related deployment
regression tests. Those browser cases use an isolated local PostgreSQL fixture;
they are not remote acceptance. Activation-head validation belongs to the PR's
actual CI results and operator test logs.

[Coordination with the active #117 work](https://github.com/FreeTWAI-AI/freedom-platform/pull/117#issuecomment-5986532811)
keeps its SQL, recovery, consumer governance and Private AI scope separate. Any
subsequent platform release must preserve the approved GUIDE_STATIC and MEDIA
overlays and recheck the live release before writing.
