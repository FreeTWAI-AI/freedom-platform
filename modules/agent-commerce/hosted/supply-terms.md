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
fulfilment or agreement is created. A foreign selection already referencing this
item blocks this editor until its offer/version consent path is implemented.

Next integration must support independent many-to-many selections (including
five suppliers and five sellers), fixed-version supplier decisions, one stock
authority and per-supplier order visibility. It must reuse existing selections,
acceptances and transfers while adding explicit cross-party authorization;
removing the legacy `origin='imported'` filter is insufficient. The current direct
reservation profile must not be used to accept foreign supply without that work.
