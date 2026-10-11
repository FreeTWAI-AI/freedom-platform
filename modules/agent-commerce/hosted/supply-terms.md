# Hosted supplier preparation

This slice saves private supplier terms on an existing hosted product. Mini's
[original direction](https://github.com/arumwu/freedom-platform/blob/c2237d735a92fbd9c9dd6e60165b472c89f0d0b7/docs/development/supplier-retail-pricing.md)
keeps supplier cost separate from each seller's retail price. The
[ERP module reference](https://github.com/mars-tw/freedom-erp-crm/blob/439e376fcc34c22ddba55e5ac736285d42971530/docs/templates.md)
informs inventory visibility and resumable work; its simulation is not a second
platform stock or payment authority. Cross-module follow-on stays under
[SP-10](../../../docs/platform-plan/execution/guild-launchpad/SP-10-domain-upstream-integration.md).

`GET/PATCH /tenants/:tenant_id/storefronts/:instance_id/products/:product_id/supply-terms`
requires the current member session and `store:write` on that exact instance.
Both the supplier shop and own retail selection must retain confirmed tenant
mappings. Readers with only `store:read` cannot read costs through this extension.
PATCH uses the existing product version, idempotency key, tenant command,
instance/community/profile lock ordering and current authorization before replay.
Private responses are `private, no-store`; receipts are scoped to the tenant and
actor. Journal payloads contain only the product ID and version.

The existing `commerce_items.price_minor` stores supply cost; shipping amount and
terms use the existing item columns. `commerce_selections.retail_price_minor`
remains the seller's price. Product creation initializes both prices as before;
subsequent retail edits cannot overwrite supply cost. The own selection version
serializes both editors. No new migration, item, stock balance or receipt system
is introduced. Available quantity is `stock - reserved`, from existing inventory;
this form cannot write stock or clear reservations.

The additive contract leaves the pinned storefront/v1 DTO and publication
allowlist unchanged. Saving supplier terms neither changes the public price nor
publishes private costs or shipping/return terms. Existing quotes retain their
immutable terms and product-version fences.

This is preparation, not an offer publication or distribution acceptance. The
UI says so; no supplier qualification, cross-tenant access, payment, automatic
fulfilment or agreement is created. An unmanaged legacy foreign selection still blocks this editor. Hosted foreign
selections reference immutable offers, so editing this private draft leaves their
accepted terms unchanged; explicitly publishing a replacement retires the old offer.

The [hosted distribution increment](distribution.md) implements independent
many-to-many proposals and fixed-version supplier decisions. Shared reservation
stock and per-supplier order visibility are still required next. It must reuse existing selections,
acceptances and transfers while adding explicit cross-party authorization;
removing the legacy `origin='imported'` filter is insufficient. The current direct
reservation profile must not be used to accept foreign supply without that work.

## Supply-only catalogs (schema164)

The supplier guild enters `#stores/supply`, then a private supply catalog on the
existing hosted-store instance. `POST .../supply-profile` accepts only name,
currency and optional description. It reuses an existing profile without changing
its IDs, retail publication or inventory. A new profile has a null slug: no public
URL, template selection or retail activation is required. Both technical shop
mappings remain so the existing offer, consent, order and stock authorities apply.

`GET .../supply-profile` exposes metadata under `store:read`; the cost-bearing
`GET/POST/PATCH .../supply-products` requires `store:write`. Setup requires
`store:manage`. Offer publication continues to require the existing publish
capability. Existing formal membership, tenant status, instance status, current
capability checks before replay, CSRF, idempotency and version fences remain.

New supply products use the existing inventory item and own selection, with
`own_retail_enabled=false`. Retail product lists and publication projections
exclude those selections. Editing supply cost never changes an existing retail
price. Historical own retail selections default to true. A null-slug profile is
excluded from `/me/stores` and rejected by retail setup/update, appearance,
preview, publication and retailer-proposal entry points. `/me/supply-catalogs`
includes reusable existing profiles. Retail activation is deliberately not an
operation in this increment; a future explicit upgrade must retain IDs and
require per-product retail opt-in before publishing any supplier placeholder.

Publish a supply offer, have a separate retailer propose its retail terms, and
let the supplier accept the exact version. Accepted offers, shared reservations,
held stock and supplier orders use the existing immutable snapshots and durable
holds. Reservation admission still requires the existing owner opt-ins; creating
a catalog grants no checkout, payment or fulfilment authority. The supply-only
UI exposes the existing owner-authorized reservation setting and supplier-order
entry without retail activation. Admission OFF blocks opening new reservations
but preserves stopping and reading retained supplier orders.

Migration164 changes only forward schema. Full database backups/restores must
retain null slugs, `own_retail_enabled`, both shop mappings, items, selection
versions, offers, consents and holds together. The existing whole-database backup
and module data catalog cover these fields; a retail-only CSV is not a restore.
Every active/candidate reader and writer requires
`commerce.hosted-supply-catalog.v1` at schema164, even when admission is disabled.
Do not roll back to an older binary that assumes every profile is a public store.

New supply setup/create/update commands follow the private Work command pattern:
receipts and HTTP command responses contain only instance/product IDs, version
and (for setup) the created flag. They contain no name, description, cost, URL or
raw input. The request contributes only its existing command digest. Exact-key
retries return the original metadata receipt after current authorization, even
when the resource has subsequently changed; effects are not repeated. The UI
then calls the separately authorized metadata/product GET for current content.
These GETs do not pretend to be the original command snapshot. Existing retail,
supply-terms and offer receipt shapes are preserved as legacy contracts.
