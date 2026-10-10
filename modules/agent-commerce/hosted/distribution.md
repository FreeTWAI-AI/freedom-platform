# Hosted supply cooperation

This increment follows Mini's fixed [supplier/seller direction](supply-terms.md)
and SP-10. Any authorized shop operator can publish its own supply offers or
propose selections from other shops; guild membership does not grant another
tenant's permissions. A member can use both roles, with independent many-to-many
relations. Existing tenant, instance, command, selection and acceptance authority
remain in use.

An explicit supplier action publishes a minimal immutable offer: product text,
currency, supplier price, per-item shipping and shipping/return terms. Private
edits do not publish it. The catalog exposes only explicitly shared offers to
authorized shop writers in the same community and currency. Saving a replacement
offer withdraws the previous version. Historical snapshots remain retained.

Each seller proposes its own price. Its selection references the original item
and one exact offer; it creates no inventory row. The supplier signs that exact
listing digest and version through the existing append-only acceptance table.
Repricing clears active consent; a seller that stops adoption must submit a new
proposal before the supplier can accept again. Seller withdrawal records the
seller's own command rather than forging a supplier acceptance.

Private preview and explicit publication include only currently offered,
accepted selections. Text comes from the agreed snapshot, with a unique SKU from
the seller's existing sequence and the seller's price. Source inventory, supplier
costs, private media, tenant IDs and signatures never enter the public projection.
This first increment does not copy supplier photos: their separate grant and
retention rules remain to be implemented. A published page remains immutable;
withdrawal changes the next preview/publication, without rewriting history.

All writes use `storeCommand`, current `store:write`, confirmed own mappings,
instance/community/profile lock order, version CAS and existing receipt handling.
The shared community writer lock serializes proposals, decisions and withdrawal
without acquiring a foreign tenant or instance lock. Publishing an offer additionally
requires `store:publish`, including receipt replay; private editors alone cannot
share costs with other shop operators. No tenant context is rebound
to manufacture supplier membership. SQL constrains the offer/item relationship,
immutable offer bytes and seller/offer identity. The data catalog records the
supplier-owned snapshot and seller-owned selection separately; this is no export
or module portability implementation.

## Remaining reservation boundary

The current `hosted_direct_reservation` profile remains limited to its own supply
shop. It refuses foreign selections even if displayed and accepted. Its SQL guard,
quote checks, stock adapter, financial exclusions and deployment flags remain
unchanged. No shared-stock race, supplier order projection, payment or fulfilment
is claimed here. Next is a reviewed cross-party reservation authority using the
existing inventory port, including 10 items across B/C, 6+5 concurrency, cancellation
once, withdrawal fencing, expiry and historical release after suspension. It must
retain exact source/acceptance references on order lines and must not replace the
local transaction with an inline remote HTTP request.

Migration 144 is an unpublished successor to main's 143. Deployed 001–141 and
main's 142/143 bytes are unchanged; the only historical gap remains 022. A deploy
must first apply all pending migrations and retain a compatible backup/restore
operator. This document does not authorize deployment or claim live acceptance.

The catalog is capped at 100 and participant lists at 200 with explicit truncation.
Cursor continuation and cross-supplier photos remain subsequent work, not hidden
claims of complete ERP integration. The normal merchant journey and module
portability milestones retain their separate acceptance requirements.
