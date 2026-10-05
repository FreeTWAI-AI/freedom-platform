# AI Sister guide publisher evidence — 2026-10-05 UTC

The operator published the AI Sister manifest reviewed in [PR #123](https://github.com/FreeTWAI-AI/freedom-platform/pull/123),
source `2325b2ddd41832306982417822f56c990c9dccc1`, merged as
`ead852367cdcb84f99a0067e57a0f3551d1561cc`. This source already includes
[PR #122](https://github.com/FreeTWAI-AI/freedom-platform/pull/122).

Both existing private GUIDE_STATIC buckets received **1,377 immutable objects /
62,044,286 bytes**. Every object was fetched back in full through the authenticated
provider API and checked against the manifest SHA-256, byte length and
`image/webp` MIME. The local publication plan separately decoded the original
WebP derivatives. Existing objects were verified rather than replaced.

| Environment | GUIDE_STATIC bucket | Full readback |
| --- | --- | --- |
| staging | `freedom-staging-next-guide-static` | 1,377 / 1,377 |
| production (`next`) | `freedom-next-guide-static` | 1,377 / 1,377 |

Before and after publication, authenticated provider reads confirmed each bucket's
identity, disabled managed `r2.dev` access and absence of custom public domains.
No buckets, domains or Worker bindings were created or changed. Only digest keys
under `guide-packs/ai-sister/ai-sister-v1-20261005/` were written; existing Dragon
objects and member MEDIA were untouched.

- [Receipt set](../../contracts/guide-packs/receipts/ai-sister-v1-20261005.json)
- [Staging complete receipt](../../contracts/guide-packs/receipts/ai-sister-v1-20261005-staging.json)
- [Production complete receipt](../../contracts/guide-packs/receipts/ai-sister-v1-20261005-next.json)

The exact manifest SHA-256 is
`b2fbf0d348ac72729c2170a0f95a6c407907fefb1f7bdfaeb7733b0c5a2795c2`.
The activation pin binds the receipt-set bytes, which bind both full receipts.
Each receipt contains the authenticated readback time and request reference per
object. These are operator records, not provider-signed attestations. The receipt
records `productionEnabled: false` because publication precedes activation.

## Activation and deployment

This separate activation change enables the AI Sister code pin after publication.
It still requires CI, independent review and normal merge. The native host also
requires `FREEDOM_PUBLIC_GUIDE_ENABLED=true` and the correct `GUIDE_STATIC` binding;
missing or disabled hosts remain OFF. Dragon retains its own release and receipts.

At publication both Workers remained on
`89f64ace3b9c24e493fc367b1b489dc8749ee20e`. Neither #122 nor #123 was deployed by
uploading these objects. Deploy the merged activation SHA, containing both PRs,
to staging first. Verify all three legacy themes make zero guide requests, both
guide themes render, AI Sister choice persists and changes outfit by page, and
page/account/theme/access transitions clean up the previous guide. Only successful
staging acceptance permits production deployment and live version verification.
Keep the daily backup release pins aligned with each accepted environment.

Provider receipts do not establish remote HTTP or browser acceptance. This record
does not claim a Worker deployment or live AI Sister activation.

## Existing settings preserved

Worker settings read before and after publication were identical. MEDIA maps to
`freedom-foundation-candidate-20261004-media` in staging and
`freedom-foundation-production-20261004-media` in production. The six media host
flags remain ON and Private AI remains OFF. Read-only database transactions
confirmed the six domain policies plus `member.avatar` stay in bridge mode and
asset GC is OFF. No SQL writes or migrations were performed for publication.

The [coordination note on #124](https://github.com/FreeTWAI-AI/freedom-platform/pull/124#issuecomment-5989289706)
keeps the unrelated Private AI work separate. Recheck live SHA and preserve the
current accepted GUIDE_STATIC / MEDIA overlay before either Worker deployment.
