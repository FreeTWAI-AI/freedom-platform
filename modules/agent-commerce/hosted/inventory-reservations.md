# Durable local inventory reservations

Supplier-only catalogs expose the existing owner-controlled reservation setting
at `#stores/{tenant}/{instance}/supply`. The current owner can open or stop new
30-minute reservations and follow the supplier-order link without a retail slug
or a retail publication. The control requires a successful owner-only setting
read; a manage grant alone does not expose it. Host admission OFF prevents opening
but retains stopping and historical order reads. Cooperating retailers still need
the exact supplier consent, a published selection and their own reservation opt-in.
Uncertain command responses retain the original key, payload and version for retry.
The supplier order page links back to the same supply catalog. These controls do
not provide payment, fulfilment or cancellation of another retailer's orders.

This is the first inventory-portability increment under #234. It gives existing
direct and shared reservations stable hold identities; it does not move stock,
install an external runtime, or enable a new product capability.

`commerce_items.stock/reserved` remains the only balance. Migration 162 adds
`commerce_inventory_reservations`: one immutable `reservation_id` for each
`(order_id,item_id)`, with the original supplier, quantity and deadline. A hold
can transition once from `held` to `released`. It contains no buyer profile,
price, cart snapshot or credential. Terminal history remains retained under the
existing undecided retention policy; there is no deletion or TTL job.

The internal `ReservationInventory` port resolves a hold only within its bound
item/supplier source. Its caller must first authorize the addressed order, then
take the existing instance/community/profile/order and sorted item locks. An
opaque order or hold ID grants no access. The hold query is not an HTTP endpoint
or a tenant export permission. Repeating a matching reserve while held returns
the same ID without changing stock; a changed quantity conflicts. Release
repeats return the same terminal hold, and a released ID cannot reserve again.

Order receipts still return only the order reference and recheck current
authority. Order, all lines, holds, physical balance, journal and receipt commit
in the same SQL transaction. Deferred database checks require each hosted
order's holds to match its immutable lines and state, and each hosted item's
reserved balance to equal H + A: active holds plus remaining paid allocations.
Migration 168 adds the hosted_checkout profile and retained allocations/movements;
v1 reservations still produce H only. `inventoryPositions(q, itemIds)` returns
stock, held, allocated and available after checking that equality; callers must
authorize the item IDs before using it. Imported commerce is excluded.
Cancellation and expiry use retained supply provenance even after withdrawal;
current offer availability must not prevent releasing an existing reservation.

## Upgrade and recovery

Migration 162 backfills active and terminal hosted history without adjusting
stock or rewriting orders. It aborts if retained orders and balances disagree.
An operator must investigate such a mismatch; the migration never manufactures
a balancing hold or resets stock. The added table and functions belong in the
same database backup/restore as orders and items.

The migration establishes a hosted **writer floor**: a pre-162 binary can read
the old DTOs but cannot commit hosted order/balance changes without matching
holds. Deploy with new admissions paused and a bounded migration/application
handover; validate buyer/seller recovery after the new writer is installed.
Do not describe reverting only the Worker to a pre-162 binary as a working
reservation rollback. Restore remains quarantined until current authority and
revocations are reconciled; this increment does not resolve T-047.

## Remaining externalization work

Before a real handoff, add a separately authorized owned export/import, a single
writer generation fencing every stock editor, and an authenticated standalone
runtime/database that preserves these hold IDs. Persist a versioned operation
before any network call, query unknown outcomes, and reconcile current supply
consent before finalizing an order. A network call inside this SQL transaction
is not an implementation of that protocol. Existing direct/shared v1 wire
contracts continue to mean an atomically committed local reservation.

Completion still requires the actual external instance with central B/C stores:
A has 10 units, concurrent 6+5 cannot reserve 11; lost responses and retries use
the original operation; active holds survive handoff, cancellation and expiry;
stale/restore-era writers refuse; unrelated tenant D is unchanged. Payment,
fulfilment, general module export and Foundation completion remain outside this
local increment. Execution evidence belongs in the PR/operator receipt, not in
the existence of these sources.
