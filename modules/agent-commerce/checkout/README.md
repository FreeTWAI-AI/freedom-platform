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
and movements are append-only and deduplicate their source identities. Allocation
command identities are also retained when cancellation creates no movement. No new
table allows DELETE. Contact revisions insert new rows; only a single complete
PII redaction can update a contact, clearing its salt and retaining its original
salted digest. Customer identity/store/creation fields are immutable; member and
email-verification labels may only be filled once. Customer redaction replaces
email with `redacted:{customer_id}`, clears email verification and fixes
`redacted_at` once; all later updates fail. A later checkout with the real email
creates a new customer, while historical checkout/order references remain. Customers and
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
Physical/command references take a global advisory lock after the order locks;
reference comparisons see committed facts even across communities.
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
is `hashJSON({contact, delivery, invoice, salt})`, using a fresh 16-byte
`crypto.randomBytes` salt encoded as 32 lowercase hex characters. The contact
row holds the salt only while unredacted; placement recomputes with that stored
salt. Only the digest enters terms. A standalone `computeCheckoutTerms` result
uses a fresh ephemeral salt; freezing creates the retained contact and digest.
Every input string, including object keys at any depth and fields stripped by
validation, must be well-formed Unicode and contain no U+0000; otherwise
`invalid_checkout_json` (422) occurs before writes.
Delivery/invoice JSON follows the same integer-only
encoding and bounded UTF-8 size. Shipping ports return references and amounts,
never addresses or personal fields.

Checkout creation/revision keys are hashed independently of content. An additional
append-only `commerce_checkout_idempotency_keys` table retains each command's
keyed request digest and original non-PII response, so revising a draft cannot erase an
earlier key or silently change its replay result. Both freeze `request_sha256`
columns contain HMAC-SHA256 keyed by the plaintext idempotency key (UTF-8) over
`canonicalJSON({input, checkout_id, member_principal_id})`, in lowercase hex. The
plaintext key is never stored; the retained key identifier is an independent
SHA-256 hash. Checkout identity and the
24-hour deadline remain fixed across revisions. Changing contact email resolves
the corresponding store customer; placed orders retain their original customer
and contact references. Placement is idempotent within
(checkout, client order ID), independently of member identity.

## Function contracts

All `q` arguments are caller-owned `PoolClient` transactions; only the sweep takes
a pool. Store admission defaults to false and shipping defaults to
`shipping_not_configured`. Ports run within the transaction and must not call a
provider. A confirmed payment is exactly an application whose outcome is in
`CONFIRMED_PAYMENT_OUTCOMES = {converted, allocated, unallocatable}`. Simulated,
amount-mismatch, after-cancel and overpaid outcomes do not confirm payment. The
shared SQL helper applies this definition to payment application, both cancellation
paths and unresolved-order detection. An open order without a confirmed payment
blocks a new placement on that checkout with its reference in `unresolved_order`.

A customer/member link is a seller-facing label, independent of order read access.
Both customer upsert and placement fill it only when currently NULL and the member
is an active person principal whose active user has a verified email matching
`email_normalized` after `lower(btrim(users.email))`. Other cases silently leave
it unchanged, including shared family email, mismatched/unverified email and guest
checkout. Placement still records the authenticated member as `buyer_principal_id`;
order access depends on that identity or access grants, never this label.

| Function | Contract |
| --- | --- |
| `ensureCustomer(q, store, email, memberPrincipalId?)` | Normalize/upsert per store; fill an empty member label only by active verified matching email; preserve existing labels without blocking checkout. |
| `computeCheckoutTerms(q, store, input, ports?)` | Validate 1–50 unique SKUs, quantities 1–99; resolve current server prices/consent and quote shipping; return terms/hash using a fresh ephemeral contact salt. |
| `freezeCheckout(q, store, input, ports?)` | Create or revise the draft and insert a contact; replay equal keyed content, conflict on different content. |
| `placeCheckoutOrder(q, store, input, ports?)` | Require admission, settle bounded due holds, recompute terms and atomically create order/lines/sidecar/holds; report every SKU's available quantity on shortage. |
| `cancelUnpaidOrder(q, store, orderId, actor, reason)` | Open and no confirmed payment only; release holds and cancel once; repeat cancellation returns current sidecar. |
| `settleDueCheckoutHolds(q, itemIds, bounds?)` | Release due checkout holds, keeping orders open; at most 50 items and 99 orders per item. |
| `sweepDueCheckoutHolds(pool, {limit?})` | Process at most 200 selected orders with isolated machine transactions; no cron registration. |
| `applyConfirmedPayment(q, input)` | Deduplicate verified payment reference; record simulated/mismatch/after-cancel/overpaid or convert/allocate/unallocatable atomically. |
| `retryAllocation(q, store, orderId)` | Retry a retained unallocatable fact after restock, all items or none; preserve the original payment outcome on replay. |
| `releaseAllocation(q, store, input)` | Release all or selected unshipped quantities once per command/allocation; cancel with paid_cancelled only when every remaining quantity and every shipped quantity are zero; partially shipped orders remain open. |
| `cancelPaidOrder(q, store, {orderId, commandRef})` | Lock as releaseAllocation; require open, confirmed payment and no shipped units; release all remaining allocations and cancel with paid_cancelled, version + 1. Without allocations, only the sidecar changes. Cancelled replay returns the same row; retryAllocation then refuses. No refund is created. |
| `recordHandover(q, store, input)` | Ship bounded allocation quantities once per shipment/allocation; printing or creating a shipment has no stock effect. |
| `restockReturn(q, store, input)` | Restock once per return/allocation, bounded by shipped minus already restocked. |
| `inventoryPositions(q, itemIds)` in hosted/inventory | Return a map of stock/held/allocated/available; throw reservation_inconsistent (409) when reserved differs from H+A; caller authorizes item access. |

Reference replay compares recorded content before inventory guards. A shipment
must have the same multiset of `(order_id, item_id, quantity)`; otherwise
`shipment_ref_conflict` (409). A return must match order, item, allocation and
quantity; otherwise `return_ref_conflict` (409). Release/paid-cancellation command
references are global to one order, including cancellation without allocations.
Another order, or explicit release lines differing from the recorded
`(item_id, quantity)` set, yields `command_ref_conflict` (409); omitted lines
replay the recorded command. Every conflict leaves counters, stock and movements
unchanged. Paid cancellation without a confirmed payment is
`payment_not_confirmed` (409); any shipped unit is `order_partially_shipped` (409).

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
