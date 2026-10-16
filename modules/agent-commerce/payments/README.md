# Freedom Commerce Payments (`commerce-payments`)

This module implements inbound hosted ECPay credit payments and provider account
setup with sealed credentials. The browser submits the signed checkout form;
this module builds or sends no server-to-server provider request. Pure refund
and allocation rules remain under `rules/`.

## Attempts and one-time handoff

The runtime injects `CheckoutPaymentPort` into checkout through `commercePorts`.
Placement creates attempt 1 in the order transaction after its durable holds,
pinning the active payment service, provider environment, merchant and credential
version. A collision draws a fresh trade number at most five times. It schedules
`payment_query` at creation +10 minutes and `payment_window_end` at +60 minutes.
Creation and placement validate every unit/net/shipping amount and the total with
the protocol profile: whole TWD, total 5–999,999,999 TWD. The four availability
reasons map to fixed Chinese errors; unknown reasons fail closed.

A placement replay or buyer-authorized resume can mint a new 256-bit handoff
token only before the first handoff. `commerce_entry_routes` retains its SHA-256
and a database-clock 15-minute expiry, revoking older live tokens atomically.
The GET page checks host settings, quarantine, tenant/instance liveness, the
listed profile and installed gateway, active service, admission, open order and
live holds before unsealing the attempt's pinned credential. Failures preserve
the token. A journal append outside any database transaction precedes setting
`journaled_at`; consumption then locks the attempt before the route, rechecks
eligibility and revokes the route while filling `handed_off_at`. One attempt can
be handed off once. A concurrent loser receives 410.

The minimal Traditional Chinese page has escaped hidden fields, external script
and stylesheet, an immediate noscript submit, a 10-second manual fallback with
a one-use click handler, and a back-forward cache guard that reveals the stored
order back link without resubmitting. Both buttons read 前往綠界付款. Only valid token paths extend CSP `form-action` to the configured
gateway action origin. Every payment page uses no-store, no-referrer and noindex.

`gateway.ts` is the only constructor of provider callback/return/back URLs.
Production uses a validated HTTPS platform origin and the protocol library's
exact sandbox/live checkout action. ClientBackURL contains only the attempt UUID,
so store slugs cannot introduce a CDN-blocked term. The branded fixture gateway
is refused outside local hosts and can be installed only by tests/E2E.

## Verified inbox and browser returns

`POST /api/v1/provider-callbacks/ecpay/{account_ref}/payment` accepts bounded
16 KiB form bodies, rejects duplicate or invalid field names and verifies the
merchant and CheckMacValue with current-first usable credential versions. Known
attempts require their creating version or a newer unretired version. No cookie
or member principal participates. Only the two exact POST entry patterns skip
Origin/JSON gates; Host validation stays in force and other methods return 404.

`commerce_hosted_payment_events` is the allowlisted verified inbox, separate from
the imported-shop payment reports. It retains raw-body SHA-256, canonical dedupe
SHA-256 and safe provider facts, never raw bodies, card digits, authorization
codes or provider messages. A deduped replay acknowledges without applying twice.
The acknowledgement is exactly `1|OK`, sent only after transaction commit.
Quarantine acknowledges and retains known events unapplied. Scheduler recovery
applies them in received-time/event-ID order, each with the same order/attempt
locks in its own transaction. Synchronous application checks for older unapplied
notifications of the same attempt after those locks and the event lock, leaving
later events deferred until the earlier facts commit. Browser hints do not block.
Retained paid facts protect still-held inventory until application.

Paid notifications set the attempt once, apply the verified order payment and
schedule confirmation queries. Simulations have no inventory effect; amount
mismatches leave the attempt unchanged. Unmatched, mismatched, unallocatable,
after-cancel, overpaid and contradictory payments open retailer exception cases.
Failed and pending-confirmation facts follow the explicit state machine. Provider
facts are set once, confirmed is final and retained attempts/events cannot be
deleted. Cancellation revokes all handoff routes and schedules immediate queries
for handed-off issued/superseded attempts in the cancellation transaction.

`POST /pay/ecpay/return/{account_ref}` verifies independently and redirects to the
stored order's payment-return URL. It records a browser hint and schedules a
query, at most once per attempt per minute; it never changes an attempt, order or
inventory. The network limit still verifies and redirects but suppresses writes.
Quarantine also suppresses writes. `GET /pay/ecpay/back/{attempt_id}` reads the
stored store slug and redirects to its order without effects. Buyer summaries
expose only confirmed/pending/simulated/unpaid, a coarse latest-attempt state and
whether resume is currently available. Summary reads run eligibility gates through
keyring presence without unsealing credentials or reading provider routes; actual
token issuance and handoff build the credential context. Each summary batch must
belong to one tenant and instance.

## Next slices

wp04-queries adds QueryTradeInfo, due-work claiming/execution, payment-window end,
confirmation, definite-unpaid re-pay, on-demand queries and verified activation.
This slice does not enter `confirmed`, `superseded` or `expired_unpaid` attempts;
it creates only attempt 1 and schedules work. Refund persistence, outbox/executor,
credit-detail queries and DoAction arrive with wp04-refunds. Exception resolution
and the buyer return UI arrive with their console/UI jobs.

Credentials are not checked with a provider request at save or rotation time.
The recommendation is that wp04-queries prove them through a verified activation
payment and its confirmation query before service activation, as agreed for
[EC-SPEC-04 §1.4](../../../docs/platform-plan/execution/commerce/EC-SPEC-04-payment.md).
See [payment rules](../../../docs/platform-plan/execution/commerce/EC-SPEC-04-payment.md),
[security/tests](../../../docs/platform-plan/execution/commerce/EC-SPEC-09-security-ci-tests.md)
and [release/recovery](../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md).

## Provider setup and credential storage

Tenant owners and admins can create ECPay accounts, install or rotate payment,
logistics and invoice credentials, and suspend, resume or retire services. Every
write requires account CAS (after creation), an idempotency key, and fresh
`commerce.provider_account.write` verification. Ordinary store grants never
confer account write authority. Reads require `store:manage` or
`store:finance:read`, and return allowlisted account/service metadata only.
The platform environment selects exactly one provider environment: local and
staging use sandbox; public uses live. Account refs are never included in views.

Accounts, services and credentials use tenant RLS. Immutable identities and
retained credential versions are enforced in schema 169. New services are draft;
activation is an internal function for a verified provider transaction, with no
HTTP activation route. Only one service per store/environment/profile can be
active. Rotation advances the current credential immediately and keeps service
state; older unretired versions remain usable for in-flight provider work.
Wrong keys surface as signature failures. Saving or rotating credentials makes
no provider call; verified activation is implemented by wp04-queries. Current
credentials cannot be retired.

`COMMERCE_CREDENTIAL_KEYS` is optional. Its format is comma-separated
`key_id:base64` entries with no whitespace; ids match
`^[a-z0-9][a-z0-9_-]{0,31}$`, and each canonical base64 value decodes to 32 bytes.
There are 1–8 unique ids. The first key seals new credentials; all keys can unseal.
Missing keys leave reads available and refuse writes with 503. Malformed host
configuration fails startup without exposing its value.

AES-256-GCM retains nonce, tag and ciphertext, with account, purpose, environment
and credential version bound in AAD. Receipts contain a keyed credential
fingerprint, never raw key fields. Its HMAC key is derived from the active host
key using `freedom.commerce-credential-fingerprint.v1`; the fingerprint binds
account, purpose, profile and all supplied credential fields. Replaying with
changed secrets **or after a keyring rotation** returns 409 idempotency conflict.

A new sealing key can be prepended while retaining every installed key.
`resealProviderCredentials` is an internal function; no operator route, CLI or
job exists yet. Under the runtime role, one call reseals at most `limit` rows of
the tenant bound in the caller-owned transaction only. Until an operator
procedure exists, do not remove any online key: rows still sealed with it would
become unreadable. Keep retired keys offline through the backup retention period
so historical backups remain recoverable.

Machine entry routes are non-PII routing records without tenant RLS: callbacks
must resolve the tenant before binding its context. Provider account refs encode
128 random bits in 26 lowercase Crockford base32 characters. Generation checks
all payment, logistics, invoice-allowance and buyer-return paths against the
public CDN guard, with at most 16 attempts. Token routes will retain SHA-256
hex digests only. The resolver returns identifiers and grants no authority;
provider verification and machine commands resolve the stored account before
binding its tenant.

## Public Exports

- `RefundRuleError`: Error class thrown exclusively for caller programming errors; exposes `code: 'invalid_input'` with a fixed English message and never leaks input values.
- `SETTLEMENT_UNITS`: Frozen array of supported settlement units in minor units (`[1, 100]` for USD and whole TWD).
- `REFUND_REQUEST_KINDS`: Frozen array of supported refund request kinds (`['cancel', 'return', 'refund_only']`).
- `REFUND_REASONS`: Frozen array of recognized aftersales reasons (`changed_mind`, `wrong_item`, `damaged`, `missing_parts`, `not_as_described`, `not_received`, `uncollected`, `lost`, `other`).
- `FAULT_REASONS`: Frozen array of seller- or carrier-fault reasons qualifying for shipping suggestions (`['wrong_item', 'damaged', 'missing_parts', 'not_as_described', 'not_received', 'lost']`).
- `refundNetForQuantity(input)`: Computes cumulative net price `net(j) = u × floor((L / u) × j / Q)` for `j` units using BigInt integer arithmetic.
- `itemRefundCap(input)`: Computes the maximum refundable amount for `k = units` additional units of an order line.
- `planRefund(input)`: Computes the suggested refund plan for an approved refund request, providing suggested item caps and shipping fee suggestions.
- `checkRefundAllocation(input)`: Validates seller-submitted refund allocation entries against item caps, attempt balance, and adjustment reason rules.
- `checkUnappliedRefund(input)`: Validates a refund against unapplied payment funds from an overpaid or paid-after-cancel attempt.
- Domain types: `SettlementUnit`, `RefundRequestKind`, `RefundReason`, `RefundOrderLine`, `RefundDeliveryGroup`, `RefundRequestLine`, `RefundRequest`, `RefundPlanInput`, `RefundPlanItem`, `RefundPlanShipping`, `RefundPlan`, `RefundAllocationInput`, `RefundAllocationErrorCode`, `RefundAllocationError`, `RefundLine`, `RefundAllocationResult`, `UnappliedRefundInput`, `UnappliedRefundErrorCode`, `UnappliedRefundError`, `UnappliedRefundResult`.

## Formulas and Core Rules

### Net Price and Item Cap Formulas

For an order line with net minor amount `L`, total quantity `Q`, settlement unit `u`, and previously refunded quantity `p` and amount `r`:

1. **Cumulative Net Formula**:
   `net(j) = u × floor((L / u) × j / Q)`
   Computed with `BigInt` to prevent integer overflow when `L × j` exceeds `2^53 − 1`.

2. **Item Refund Cap**:
   - For `k = 0` (price-difference refund): `cap = L − r`.
   - For `k ≥ 1` (refunding `k` units): `cap = min(net(p + k) − net(p), L − r)`.

#### The 290-元 Example
For `u = 100`, `L = 29000` (NT$290), and `Q = 3`:
- `net(0) = 0`
- `net(1) = 100 × floor(290 × 1 / 3) = 100 × 96 = 9600`
- `net(2) = 100 × floor(290 × 2 / 3) = 100 × 193 = 19300`
- `net(3) = 100 × floor(290 × 3 / 3) = 100 × 290 = 29000`

Refunding units one by one yields caps:
1. First unit (`p = 0`, `r = 0`, `k = 1`): `min(9600 − 0, 29000 − 0) = 9600` (NT$96).
2. Second unit (`p = 1`, `r = 9600`, `k = 1`): `min(19300 − 9600, 29000 − 9600) = 9700` (NT$97).
3. Third unit (`p = 2`, `r = 19300`, `k = 1`): `min(29000 − 19300, 29000 − 19300) = 9700` (NT$97).
Total refunded: `9600 + 9700 + 9700 = 29000 = L`.

If an earlier price difference of NT$50 (`r = 5000`, `p = 0`) was refunded:
1. First unit (`k = 1`): `min(9600 − 0, 29000 − 5000) = 9600`.
2. Second unit (`k = 1`): `min(19300 − 9600, 29000 − 14600) = min(9700, 14400) = 9700`.
3. Third unit (`k = 1`): `min(29000 − 19300, 29000 − 24300) = min(9700, 4700) = 4700` (capped by `L − r`).
Total refunded: `5000 + 9600 + 9700 + 4700 = 29000 = L`.

### Price-Difference Rule
Only `refund_only` requests support `k = 0` price-difference refunds. In this case, no units are marked as refunded (`p` remains unchanged), and the cap is strictly the unrefunded balance `L − r`. `cancel` and `return` requests require `1 ≤ k ≤ Q − p`.

### Shipping Suggestion Rule
Shipping entries are generated exclusively for delivery groups touched by the refund request (ordered by first touch in request line order). A request qualifies for a shipping fee refund if:
- `kind === 'cancel'` (any reason), or
- `reason` is one of `FAULT_REASONS` (`wrong_item`, `damaged`, `missing_parts`, `not_as_described`, `not_received`, `lost`).

Each line's covered units after the request is `covered_quantity + k` if the request qualifies and the line is in the request (`k = 0` adds nothing), else `covered_quantity`.
When **every** line in the delivery group has a covered unit count equal to its total quantity `Q`, the suggestion is the full remaining shipping fee (`F − s`); otherwise `0`.

### Allocation Checks and Order
When validating seller-submitted allocations in `checkRefundAllocation`, errors are collected in strict sequence (at most one error per entry):

1. **Item entries** (path `allocation.items[i].amount_minor`):
   - Amount not a multiple of `u` → `not_unit_multiple`.
   - Else amount > `cap_minor` → `above_cap`.
2. **Shipping entries** (path `allocation.shipping[i].amount_minor`):
   - Amount not a multiple of `u` → `not_unit_multiple`.
   - Else amount > `remaining_minor` → `above_cap`.
3. **Total amount** (path `allocation.total`, sum of all item and shipping amounts):
   - Total = 0 → `total_zero`.
   - Else total > `paid_minor − refunded_minor` → `above_attempt_balance`.
4. **Adjustment reason** (path `adjustment_reason`):
   - Reason trimmed with `String.prototype.trim`; empty string counts as `null`.
   - Contains U+0000 or a lone surrogate → `adjustment_reason_format`.
   - Else more than 500 code points (`[...text].length > 500`) → `adjustment_reason_too_long`.
   - Else `null` while any item amount is strictly below its cap → `adjustment_reason_required`. Lowering shipping fees requires no reason.

### Unapplied Refund Rule
`checkUnappliedRefund` validates refunds for payments not tied to order lines (e.g. overpayment or payment received after order cancellation). The refund amount is checked against the attempt's remaining unapplied balance (`unapplied_minor − refunded_minor`). Errors returned at path `amount_minor`:
- Amount not a multiple of `u` → `not_unit_multiple`.
- Else amount = 0 → `total_zero`.
- Else amount > `unapplied_minor − refunded_minor` → `above_cap`.

Unapplied refunds never alter order invoice documents.

### Database Trigger Invariant
These pure rules form the application-level validator. In M2, the PostgreSQL database trigger on `commerce_refund_lines` strictly repeats these hard invariants (multiples of `u`, sum matches refund amount, line amount ≤ `L`, line quantity ≤ `Q`, group shipping ≤ `F`, attempt balance not exceeded) under transaction row locks.
