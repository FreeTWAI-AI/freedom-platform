# Hosted checkout transaction core

This module implements EC-SPEC-03 inside the caller's PostgreSQL transaction.
A store argument is only a shop selector: stored profiles, selections and retained
order lines establish tenant and supplier provenance. Callers must authenticate
buyer capabilities or seller permissions before invoking participant commands.
The payment machine caller must verify the provider fact before invoking payment
application. No function performs external I/O.

## Inventory and retained facts

N is physical stock, H is the sum of held reservations, and A is the sum of
`quantity - shipped_quantity - released_quantity` on paid allocations.
`commerce_items.reserved = H + A`, and available is `N - H - A`.
Deferred constraints enforce the balance and exact frozen line/hold/allocation
bindings at commit, including writes made outside this module. Every order line
retains one hold forever; expiry releases it without cancelling the order.
Conversion releases the hold and creates A atomically without changing reserved.
Late payment allocates the entire order or records `unallocatable` without any A.
Shipment handover reduces N and A; inspected return restocking increases N only.
Allocation counters increase monotonically and must match immutable movements.

Checkout base orders and lines are immutable. The sidecar has one transition from
open to cancelled or closed, with version incremented by one. Payment applications
and movements are append-only and deduplicate their source identities. No new
table allows DELETE. Contact revisions insert new rows; only a single complete
PII redaction can update a contact, retaining its original digest. Customers and
contacts use tenant RLS; the domain binds tenant context from resolved store rows.
The non-PII tables have individual exemptions in the tenant data catalog. An
opaque reference, email or catalog entry never confers read authority.

## Lock order

Participant paths lock seller and supplier lifecycle rows in tenant/instance
order, then the community advisory lock, profile, checkout/sidecar, base order,
payment application, holds/allocations, and items in UUID order. Existing-order
machine payment/expiry/system cancellation paths omit lifecycle locks and never
acquire instance locks after acquiring the community lock. Community serialization
makes payment versus expiry or cancellation deterministic: the first commit wins.
A replayed payment reference returns before acquiring inventory locks or writing.
All writes and deferred checks must commit in the caller transaction; on any error
the caller must roll back the entire transaction.

## Canonical terms

`freedom.checkout-terms/v1` contains current publication identity/revision,
server-priced items and exact selection/supplier/offer/acceptance/listing bindings,
shipping groups and total, an explicit zero discount total, policy consent
references, payment method references and a contact digest. It contains no contact,
delivery address or invoice fields. Browser prices are not accepted as authority.
Pricing/bindings reuse the shared reservation resolver, including own products.

Canonical JSON recursively sorts object keys lexicographically, preserves array
order, emits compact JSON without whitespace, and permits null, strings, booleans
and safe integer numbers. Terms keys are ASCII; this is a deliberately scoped
encoding, not RFC 8785. Strings use JSON escaping and UTF-8 bytes; SHA-256 is
lowercase hex. SQL independently checks the same terms hash. The contact digest
covers the normalized contact object, delivery object and nullable invoice object;
only that digest enters terms. Delivery/invoice JSON follows the same integer-only
encoding and bounded UTF-8 size. Shipping ports return references and amounts,
never addresses or personal fields.

Checkout creation/revision keys are hashed independently of content. An additional
append-only `commerce_checkout_idempotency_keys` table retains each command's
request hash and original non-PII response, so revising a draft cannot erase an
earlier key or silently change its replay result. Checkout identity and the
24-hour deadline remain fixed across revisions. Changing contact email resolves
the corresponding store customer; placed orders retain their original customer
and contact references. Placement is idempotent within
(checkout, client order ID), independently of member identity.

## Function contracts

All `q` arguments are caller-owned `PoolClient` transactions; only the sweep takes
a pool. Store admission defaults to false and shipping defaults to
`shipping_not_configured`. Ports run within the transaction and must not call a
provider. The unresolved-order default refuses a second open order with no payment
application and returns its order reference in the typed `unresolved_order` error.

| Function | Contract |
| --- | --- |
| `ensureCustomer(q, store, email, memberPrincipalId?)` | Normalize/upsert per store; preserve an existing member link and reject conflicting member association. |
| `computeCheckoutTerms(q, store, input, ports?)` | Validate 1–50 unique SKUs, quantities 1–99; resolve current server prices/consent and quote shipping; return terms/hash. |
| `freezeCheckout(q, store, input, ports?)` | Create or revise the draft and insert a contact; replay equal keyed content, conflict on different content. |
| `placeCheckoutOrder(q, store, input, ports?)` | Require admission, settle bounded due holds, recompute terms and atomically create order/lines/sidecar/holds; report every SKU's available quantity on shortage. |
| `cancelUnpaidOrder(q, store, orderId, actor, reason)` | Open and no payment application only; release holds and cancel once; repeat cancellation returns current sidecar. |
| `settleDueCheckoutHolds(q, itemIds, bounds?)` | Release due checkout holds, keeping orders open; at most 50 items and 99 orders per item. |
| `sweepDueCheckoutHolds(pool, {limit?})` | Process at most 200 selected orders with isolated machine transactions; no cron registration. |
| `applyConfirmedPayment(q, input)` | Deduplicate verified payment reference; record simulated/mismatch/after-cancel/overpaid or convert/allocate/unallocatable atomically. |
| `retryAllocation(q, store, orderId)` | Retry a retained unallocatable fact after restock, all items or none; preserve the original payment outcome on replay. |
| `releaseAllocation(q, store, input)` | Release all or selected unshipped quantities once per command/allocation; cancel with paid_cancelled when nothing remains to ship. |
| `recordHandover(q, store, input)` | Ship bounded allocation quantities once per shipment/allocation; printing or creating a shipment has no stock effect. |
| `restockReturn(q, store, input)` | Restock once per return/allocation, bounded by shipped minus already restocked. |
| `inventoryPositions(q, itemIds)` in hosted/inventory | Return a map of stock/held/allocated/available; throw reservation_inconsistent (409) when reserved differs from H+A; caller authorizes item access. |

The internal `CheckoutInventory` sibling port provides convert, allocate,
releaseAllocation, ship and restock. It derives all supplier bindings from stored
order lines and checks conditional SQL updates and immutable movement history;
callers cannot supply tenant/shop authority to it.

## Deliberately outside this slice

There is no HTTP writer or public order reader, checkout capability credential,
store transaction admission implementation, payment attempt/provider integration,
refund execution, fulfilment/shipment aggregate, return case aggregate, invoice,
close command or scheduled cron. The functions accept verified payment, handover
and inspected-return facts from those future modules. Existing imported finance
and direct/shared v1 DTOs remain separate and filter their own profiles; their
literal-false payment/fulfilment fields retain their existing meaning. Schema 168
is expand-only and adds no release capability or writer floor.
