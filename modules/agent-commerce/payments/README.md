# Freedom Commerce Payments (`commerce-payments`)

Hosted ECPay credit payments use immutable attempts, a verified inbox and a
read-only QueryTradeInfo/V5 confirmation query. The browser sends the checkout
form; the server transport sends only the confirmation query. Pure refund and
allocation rules remain under `rules/`; provider refund execution belongs to wp04-refund-api.

## Attempts, handoff and buyer reads

Placement creates attempt 1 after durable inventory holds, pinning the account,
merchant, environment and credential version. Every amount passes the credit
profile's whole-TWD range (5–999,999,999 TWD). Trade-number collisions draw fresh
numbers up to five times. Creation schedules query work at +10 minutes and a
separate confirmation-window end at +60 minutes. An order has at most one issued
attempt; a superseded attempt retains its own payment responsibility.

A 256-bit handoff token lives for 15 minutes by database time. Only its SHA-256
hash is stored; minting revokes older live tokens of that attempt. The page checks
quarantine, checkout, profile/gateway, tenant/instance, payment service, admission,
open order and live holds before unsealing its pinned credentials. Failures keep
the token. A `payment_handoff` journal append occurs outside a transaction before
consumption; order/attempt locks then protect its one handoff. Concurrent reuse
returns 410. Callback, browser-return and back URLs come only from `gateway.ts`.
The page uses no-store, no-referrer, noindex, escaped fields and a bounded CSP.

Buyer order reads expose only a coarse latest attempt and
`overpaid|confirmed|refunded|pending|simulated|unpaid`. Here `confirmed` retains checkout's
application definition; it does not itself assert server-query confirmation.
Overpaid, after-cancel or amount-mismatch applications produce `overpaid` while
any such amount remains unrefunded. After all are refunded, confirmed applications
still win; otherwise the state is `refunded`. Any unapplied application keeps
resume off permanently, before and after its refund. `can_resume_payment` reads the resume and re-pay gates without
calling ECPay, charging budgets, unsealing credentials or reading provider routes.
A summary batch belongs to one tenant and instance.

## Inbox, query phases and keys

Notifications accept bounded 16 KiB forms and verify current-first usable keys,
merchant and trade. The response `1|OK` follows commit. Quarantine retains known
notification facts unapplied. Browser returns verify independently, retain one
browser hint per attempt and redirect even if hint storage fails. They never
apply payments. Activation returns/back links lead to `/`; order links use the
stored slug. Only exact callback and browser-return POST paths skip Origin/JSON
gates; Host checks remain. Notification budgets bind account and network.

The query engine has three phases: a tenant-bound transaction takes domain locks,
loads in-memory keys and commits a 60-second lease; a fresh signed request is sent
with no transaction or checked-out client; a new transaction records and applies
the result. Order writers share checkout/order, advisory attempt and attempt-row
locks. Activation queries lock tenant/account first, then advisory/attempt rows.
Event rows precede the due-work row. A lost lease never drops verified facts;
only its owner may change that lease's schedule.

New queries sign with the account's **current** payment credential. Responses
verify against all unretired versions, current first. Definite events record the
verifying version; unknown results carry no key index and retain no version.
`providerEnvironment()` alone chooses sandbox/live. Queries require an active
tenant and instance, but can reconcile suspended/retired services and unlisted
profiles. Missing keyrings, unusable credentials and environment mismatches make
no call and retain a closed due-work error code.

Production transport pins the exact environment origin and QueryTradeInfo/V5
path, sends a manual-redirect POST, times out after 10 seconds and reads at most
64 KiB. The guarded local fixture verifies request MAC/freshness and answers from
synthetic trade state. Tests and the E2E server install only that fixture.

Every verified result about this merchant/trade becomes its own query event with
response-body SHA-256, a trigger and allowlisted facts, never a raw body, key,
card field or provider message. Verification/identity failures and transport
errors create no event. Verified missing/invalid fields and unrecognized numeric
statuses retain the closed unknown reason/field/status. HTTP 403 throttles only
this account's payment queries for 30 minutes without increasing failure count.
Queries are read-only external calls and write no external-effect journal record.

Notification and query events apply in `(received_at,event_id)` order; browser
hints never block. A later event waits for older unapplied payment events.
Deferred replay dispatches by source, and a failed event skips the rest of its
attempt for that run. Unapplied paid facts protect holds. Both sources apply a
payment once with `payment_ref=attempt_id`; late payments retain after-cancel,
unallocatable and overpaid outcomes and exceptions. Query-paid facts can lack a
payment date; paid notifications still require it. Matching query-paid confirms
the attempt. A paid attempt contradicted by unpaid/failed opens
`payment_unconfirmed` without losing its paid facts.

Amount mismatches apply the trade amount to an order, recording the existing
`amount_mismatch` outcome, and open a case. Trade-number mismatches open
`contradicting_event` without an application. Both are definite for scheduling,
even though attempt state is unchanged: their durable event stops future queries,
including after case closure, cancellation or window end. Such orders remain open
until an explicit seller cancellation or later payment facts resolve them.

## Schedule, confirmation window and cancellation

`commerce_due_work` is the query schedule and lease; there is no payment outbox.
Inside the 60-minute window, issued/superseded handed-off attempts use the next
creation-relative slot at 10, 20, 40 or 60 minutes. Consecutive indefinite results
increment `failure_count`; transport/verification failures back off 1, 2, 5 then
10 minutes, capped by the next slot. A definite result resets that count.
After the window, verified unknown results run every 10 minutes and other failures
use the same backoff. At window end +24 hours they open `payment_unconfirmed` and
stop. Paid/unconfirmed attempts use backoff until paid +24 hours, opening the
exception at paid +60 minutes while continuing to query. Throttling waits until
its account deadline and does not advance backoff.

Never-handed-off attempts make no query call. Their window-end row expires issued
or superseded attempts directly; handed-off attempts schedule a query immediately.
Every window row is then deleted. Confirmed, failed, expired and mismatch attempts
need no query row. At or after an attempt's window, `settleOrderPayments` cancels
an open order only when it lacks a confirmed application, **all** attempts are
failed/expired and none has an unapplied payment event. It calls checkout's
`cancelUnpaidOrder(...,'system','payment_not_completed')`, releasing holds and
revoking tokens through the existing hook. Replays have no effects. Outstanding
issued, superseded or paid attempts prevent automatic cancellation.

The Worker runs deferred apply, hold sweep, due work and journal flush in that
order. Committed notification/return scheduling also queues targeted execution
through `afterResponse`; the Worker keeps its pool open until collected work
settles. The 10-minute cron is the fallback. Quarantine disables both paths.
See [operations](../operations/README.md) for leases, budgets and time limits.

## Re-pay and on-demand queries

The single buyer pay endpoint remains
`POST /api/v1/public/stores/:slug/orders/:order_ref/payment-handoffs` with `{}`.
It resumes an issued unhanded attempt first. Otherwise it checks, in order: open
order; live held inventory; no paid/confirmed attempt or confirmed application;
no overpaid/after-cancel/amount-mismatch application; fewer than five attempts;
a failed latest attempt or a handoff at least 60 seconds ago; no latest unapplied
paid or pending-confirmation event. The initial delay returns
`payment_result_pending` with Retry-After seconds remaining.

A failed attempt needs no query. Other eligible attempts require a live verified
unpaid/failed query. Paid facts apply before `payment_already_applied`; a busy
lease, unknown result or query failure returns `payment_result_pending`. A new
transaction rechecks every condition and the latest identity, supersedes an old
issued attempt, creates its successor with new 10/60-minute deadlines and mints
the handoff. Concurrent re-pays cannot create a third attempt. A late superseded
payment still applies, and a second payment makes the order overpaid.

`POST .../orders/:order_ref/payment-queries` accepts `{}`, proves the same buyer
access as order reads and uses the resume quarantine/checkout gates. It selects
the newest handed-off issued/superseded/paid attempt without a definite mismatch.
It returns the current parsed public order after one query, or 409 pending for a
busy lease; no candidate means no call. Network budget is 30/10 minutes. The
order budgets, shared with re-pay and seller queries, are 1/minute and
10/hour. Budgets commit in their own short transaction before any provider call;
429 includes Retry-After. Reads never spend them.

Payments also injects checkout's unresolved-order port. An older open order
without a confirmed payment blocks placement only with a paid attempt, a handed-off
issued/superseded attempt, or an unhanded issued attempt backed by live holds.
M1's original fallback remains when the payment port is absent.

## Payment service activation

Provider accounts have no lifecycle. Owners/admins use the setup command wrapper,
account If-Match, Idempotency-Key and fresh `commerce.provider_account.write`
verification to create an activation payment. The tenant/instance must be active;
the payment service must be draft with current credentials and a listed profile
and installed gateway, outside quarantine. Another account's active payment
service for the same instance/environment/profile refuses with the existing
`provider_service_conflict`. No service is suspended or retired implicitly.
The account allowance is 10 activation commands/hour. Buyer checkout/admission
flags do not apply.

`SERVICE_ACTIVATION_AMOUNT_MINOR=1000` is the adjustable single constant for the
NT$10 self-payment. The merchant pays their own account (sandbox test card or
an explicitly authorized controlled live payment). An issued handed-off activation
inside its window, or a paid activation, blocks another start. Attempts have a
per-account sequence and no order. The scoped receipt contains **only**
`{attempt_ref}`. After its commit the route mints a token; receipt replays mint
fresh tokens only while that same attempt remains issued and unhanded.

Activation handoff requires draft service, tenant/instance, profile/gateway and
quarantine gates, without order/holds/checkout admission. Its item is
`收款服務驗證 x1`; its display number is the Taipei creation day plus six Crockford
base32 characters from the first thirty SHA-256 bits of the attempt ID. It uses
the same gateway URLs and `payment_handoff` journal kind.

A notification alone marks paid and cannot activate. A matching paid query
confirms and calls `activateProviderService` in the same transaction under a
savepoint. Existing 409 state/conflict refusals roll back only that savepoint:
confirmed payment/event facts remain, all services stay as they are, and no false
activation control event is written. Other errors propagate. Successful activation
records its control event for the Worker's normal journal flush. Failed/expired
attempts allow another activation. Views expose nullable `payment_activation`
with ready/awaiting_result/paid/confirmed/failed/expired and no sensitive facts.

The platform never refunds activation payments. A merchant may refund in ECPay's
back office. This module never voids authorizations, creates logistics orders or
issues invoices. wp04-refund-api adds provider refund execution, its durable outbox and credit-detail
queries/DoAction. M4 adds refunds of confirmed order payments; buyer payment pages
already consume the coarse payment axes.

## Provider setup and credential storage

Owners/admins create accounts, save/rotate keys and suspend/resume/retire services
with fresh proof and account CAS. Reads require store management or finance
capability. Ordinary store grants confer no account-write authority. Saving or
rotating keys never calls a provider. The current credential changes immediately;
older unretired versions remain usable for verification. Only one payment service
per instance/environment/profile can be active; the merchant changes accounts
by explicitly suspending/retiring the old service and verifying the new one.

Accounts, services and credentials use tenant RLS. `COMMERCE_CREDENTIAL_KEYS` is
optional, with 1–8 comma-separated `key_id:base64` entries and no whitespace.
Each canonical base64 key decodes to 32 bytes; IDs match
`^[a-z0-9][a-z0-9_-]{0,31}$`. The first key seals, all installed keys unseal.
Missing keys refuse writes; invalid configuration fails startup with a fixed code.
AES-256-GCM binds account/purpose/environment/version as AAD. Receipts retain
only a keyed credential fingerprint, not keys. Changed secrets or a host-keyring
rotation make an old key-save command conflict on replay.

`resealProviderCredentials` remains an internal tenant-bound function without an
operator route/CLI/job. Keep installed sealing keys until all online rows have
been resealed; retain offline keys through backup retention. The current provider
credential cannot be retired. Non-PII provider entry routes resolve stored tenant
identity before binding RLS and confer no authority themselves. Account refs are
128-bit lowercase Crockford strings; handoff routes store bearer hashes only.

See [payment rules](../../../docs/platform-plan/execution/commerce/EC-SPEC-04-payment.md),
[orders/inventory](../../../docs/platform-plan/execution/commerce/EC-SPEC-03-order-inventory.md),
[security/tests](../../../docs/platform-plan/execution/commerce/EC-SPEC-09-security-ci-tests.md)
and [release/recovery](../../../docs/platform-plan/execution/commerce/EC-SPEC-10-release-operations.md).

## Offline payments

Bank transfer and cash on meetup sit beside immediate card. `payments/offline/`
owns settings, the payment-methods port, seller confirmation and the grace-window
handler. Checkout does not import that implementation. Hosts inject
`CheckoutPaymentMethodsPort`, whose `offlinePaymentRequiresMember` defaults to
true when the port omits it. Quote display remaps an available offline option to
`member_required` for a guest. Placement enforces the same flag and writes no
checkout order when it refuses.

Settings rows are append-only. Account number, account name, bank name, branch
name, note and the payment reference stay out of receipts, control-event detail,
journal rows and Problem detail. A finance seller view may include the reference.

`confirmOfflinePayment`, `completeMeetup` and `recordMeetupHandover` go through
`sellerCheckoutCommand`. Meetup completion requires both `store:orders:manage`
and `store:fulfil`. These commands write no journal, matching
`commerce.refund.record`. Authorization takes no commerce row locks. The seller
path then locks the store instance, the community and the profile, and applies
the payment with `applyConfirmedPaymentHeld`. Expiry locks the community and then
the profile, and never the instance. A meetup stock failure throws
`meetup_stock_unavailable` before `openException`, so the receipt rolls back with
the payment.

`offline_payment_window_end` is due at `expires_at + 72h`. Before that grace
ends, a due row is moved to the grace end. After it, an open unpaid offline order
is cancelled with `payment_not_completed`. Confirmation is still accepted while
the order remains open. `settleOrderPayments` ignores every method other than
`immediate_card`. The handler runs with no keyring, transport or journal.

`payments/offline/` may import checkout, operations and fulfilment. Checkout adds
no import from `payments/`. `operations/due-work.ts` may import
`payments/offline/window.ts`. Operations does not otherwise import payments.

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
These pure rules form the application-level validator. M2 database triggers bind manual unapplied refunds to their payment application,
serialize its cumulative cap, preserve append-only rows and defer exact nonempty
line balancing until commit. The route applies settlement-unit/date rules. M4
will add order-item/quantity and delivery-group refund ledger constraints when
confirmed-payment refunds become available.


## Manual unapplied refunds and seller queries

`refunds.ts` records a merchant's external manual refund, without calling ECPay,
voiding an authorization or sending mail. Only unapplied overpaid, after_cancel
and amount_mismatch applications qualify; confirmed and simulated money cannot
be refunded here. The request uses store:refund and Idempotency-Key, without
If-Match. It locks the store, order, attempts and every application/inventory row
before inserting one refund and one unapplied line. checkUnappliedRefund enforces
positive whole-currency units (TWD 100 minor units) and the remaining application
cap. PostgreSQL serializes concurrent inserts on that application and rejects an
over-cap sum. Both non-PII ledgers are RLS-exempt with explicit participant ACL
catalog entries, like checkout payment applications.

refunded_on must lie between the Taipei payment date and the database's Taipei
today: attempt payment_date, else earliest paid/mismatch event date, else
application creation. References contain only 1–64 ASCII letters/digits/_/-.
A full application refund closes its matching open case once, with resolver and
fixed note 店家已登記全額退款。; partial records leave it open, and an already
human-closed case does not prevent recording. A reference-only scoped receipt
re-projects the refund after the command in the same transaction. Finance read
lists at most 100 records oldest first. Every manual_record returns
recorded_without_provider=true, displayed as 商家自行退款（平台未經綠界確認）.

Seller payment-queries use the existing CheckoutPaymentActions.query with
trigger=seller (buyer remains the default). Store read plus either order-read or
finance-read authority and the order's stored store binding are checked before
spending the shared order budgets. There is no seller network/principal budget
or command receipt. Attempt-choice rechecks authority, then queryAttempt commits
the lease and releases the client before transport. No candidate makes no call;
a busy lease gives 409 payment_result_pending; success re-reads the current seller
DTO. Console gates mounting, checkout-off does not block servicing, and quarantine
blocks querying. Queries, notifications and the scheduler never close cases.

The buyer's refunded state is final: 已退款 with the recorded-full-refund copy,
no polling or payment/query action, even if a DTO incorrectly permits resume.
See [seller routes](../checkout/README.md),
[EC-SPEC-04 §7.2/§7.5](../../../docs/platform-plan/execution/commerce/EC-SPEC-04-payment.md)
and [EC-SPEC-03 §3.2](../../../docs/platform-plan/execution/commerce/EC-SPEC-03-order-inventory.md).

## Logistics sub-types (M3 settings)

[EC-SPEC-05 §2.2](../../../docs/platform-plan/execution/commerce/EC-SPEC-05-fulfilment.md)
adds one retained `commerce_logistics_services` row per account/service key. The
account's `logistics` purpose owns all credentials; sub-types own no credentials.
Multiple logistics purpose rows may be active for a store/environment (sandbox C2C
and home use different merchants), while only one sub-type per service key may be
active. Payment and invoice retain the existing one-active-purpose constraint.

Under the store's `/provider-accounts/:account_id`, POST `/logistics-services`
creates a draft; POST `/logistics-services/:service_key/suspend`, `/resume` and
`/retire` change its state. Owner/admin authority, fresh verification with purpose
`commerce.provider_account.write`, account `If-Match`, account revision bumps and
control-event journaling use the existing account command. `accountView` lists
non-retired sub-types in service-key order. There is no public activation command.

`activateLogisticsService(q, { accountId, serviceKey, activationRef })` is an internal
transaction function for wp05-activation, whose caller binds the stored tenant and
owns the verification evidence. It locks tenant/account, logistics purpose, then
sub-type; activates a draft purpose with the same reference before activating the
draft sub-type; bumps the account and records system control events. It makes no
provider call. Activation facts cannot be replaced. Resolution belongs exclusively
to `fulfilment/settings/logistics.ts`; both purpose and sub-type must be active.
