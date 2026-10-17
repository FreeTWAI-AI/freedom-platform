# Freedom Commerce Fulfilment (`commerce-fulfilment`)

This module provides the shipping settings layer and pure, I/O-free domain rule functions for Freedom Commerce fulfilment and logistics planning, following EC-SPEC-05 §1.1, §2.2–§2.6, §3.1–§3.5, §5.1, §6.3, and §6.4.

## Scope & Status

### What exists now
- Pure rule functions and TypeScript types under `rules/` (`errors.ts`, `types.ts`, `taipei.ts`, `postal.ts`, `recipient.ts`, `ship-by.ts`, `plan.ts`, `tracking.ts`, `index.ts`).
- Deterministic group clustering, service choice, first-fit parcel packing, fee calculation, recipient validation, ship-by deadline calculation, official ECPay status mapping, tracking state transitions, and logistics event application.
- The `rules/` library is 100% pure: no database access, no network calls, no system clock reads, no locale-sensitive formatters, no environment access, no console logging, no side-effects. All times are passed as epoch milliseconds. `quote/` is a separate SQL-local adapter and is not part of that pure library.
- All returned objects and nested arrays are deeply frozen with `Object.freeze`. Caller input objects and arrays are never mutated, aliased, or frozen.

### Dependencies
- `commerce-providers`: Imports the public export `findCdnBlockedTerm` from `ecpay/index.ts` for CDN blocked term checks on recipient names and addresses.

### What does not yet exist (deferred to future fulfilment domain milestone)
- Shipment and agreement tables and migrations (e.g. `commerce_fulfilment_agreements`, `commerce_fulfilment_orders`, `commerce_fulfilment_recipients`, `commerce_cvs_selection_sessions`, `commerce_shipments`, `commerce_logistics_operations`, `commerce_logistics_events`).
- Shipment HTTP routes and provider callbacks (carrier callbacks, store checkout CVS map selection, printing endpoints).
- ECPay API integrations (MD5 CheckMacValue generation, `Express/Create`, `Express/map`, `QueryLogisticsTradeInfo/V5`, label printing forms).
- Exception case lifecycle and outbox workers (`commerce_exception_cases`, outbox operation dispatcher).
- Reverse logistics, cold chain (chilled/frozen), and Cash on Delivery (COD).

## Public Exports

- `FulfilmentRuleError`: Error class thrown exclusively for caller programming errors; exposes `code: 'invalid_input'` with a fixed English message and never leaks input values.
- `SERVICE_KEYS`: Array of the five active C2 logistics service keys (`ecpay.logistics.home.tcat`, `ecpay.logistics.home.post`, `ecpay.logistics.cvs.unimartc2c`, `ecpay.logistics.cvs.famic2c`, `ecpay.logistics.cvs.hilifec2c`).
- `DELIVERY_METHODS`: Array of buyer-facing delivery methods (`home`, `cvs:UNIMARTC2C`, `cvs:FAMIC2C`, `cvs:HILIFEC2C`).
- `UNAVAILABLE_REASONS`: Array of standard line unavailability reason codes.
- `TEMPERATURES`: Array of product temperature tiers (`ambient`, `chilled`, `frozen`).
- `CVS_PARCEL_VALUE_MAX_MINOR`: Maximum declared value per convenience store parcel (2,000,000 minor = NT$20,000).
- `POST_MAX_WEIGHT_G`: Maximum package weight for Chunghwa Post (20,000 g = 20 kg).
- `methodOfService(key)`: Maps a service key to its buyer delivery method (`home`, `cvs:UNIMARTC2C`, etc.) or throws `FulfilmentRuleError`.
- `logisticsSubTypeOfService(key)`: Maps a service key to its ECPay logistics sub-type (`TCAT`, `POST`, `UNIMARTC2C`, `FAMIC2C`, `HILIFEC2C`) or throws `FulfilmentRuleError`.
- `POSTAL_SOURCE`: Metadata identifying the official Chunghwa Post 3-digit postal prefix source document and retrieval date.
- `isKnownPostalPrefix(prefix)`: Returns whether a 3-digit string is an officially recognized Taiwan postal prefix (368 total).
- `isOutlyingPostalPrefix(prefix)`: Returns whether a 3-digit prefix belongs to Taiwan outlying islands (Kinmen, Matsu, Penghu, Green Island, Orchid Island, Liuqiu, Pratas, Spratly, Diaoyutai).
- `validateRecipientName(raw)`: Normalizes (NFKC) and validates recipient real name (4–10 char weight, Han=2, ASCII=1).
- `normalizeMobile(raw)`: Normalizes (NFKC) and validates Taiwan mobile numbers to 10-digit `09xxxxxxxx` format.
- `validateHomeRecipient(raw)`: Validates full home delivery recipient details (name, mobile, 3/5/6-digit postal code, 7–60 char address).
- `validateCvsRecipient(raw)`: Validates convenience store pickup recipient details (name, mobile).
- `normalizeCvsStoreSelection(raw)`: Validates and normalizes ECPay electronic map callback store parameters (supports `CVSOutSide` and 22-division address fallback for Hi-Life).
- `computeShipBy(confirmedAtEpochMs, options)`: Calculates promised shipping deadline (23:59:59 Asia/Taipei) across working days and daily cutoff.
- `planDelivery(input, method)`: Deterministically partitions order lines into delivery groups, packs parcels, and calculates fees for a method.
- `availableMethods(input)`: Evaluates all seller delivery options in order and returns each method with its plan or unavailable reasons.
- `SHIPMENT_STATE_ORDER`: Numeric precedence table for tracking lifecycle states (0 to 8, voided = null).
- `ALL_SHIPMENT_STATES`: Array of all recognized shipment lifecycle states.
- `VALID_INCOMING_STATES`: Array of shipment states that can be received from carrier tracking updates.
- `mapLogisticsStatus(subType, rtnCode)`: Strictly maps official ECPay carrier tracking codes across all five C2 sub-types to domain status results (`progress`, `exception`, `informational`, `ops_review`, `unmapped`).
- `applyTrackingState(current, incoming)`: Pure state machine advancing forward and return tracking states according to monotonicity rules, computing `record_handover`.
- `applyLogisticsEvent(input)`: Applies an untrusted ECPay tracking event callback to a shipment, updating state, recording handover, opening domain exceptions per §6.4 rules, and flagging ops reviews.
- Domain types: `TrackingExceptionKind`, `LogisticsStatusResult`, `ApplyTrackingResult`, `LogisticsEventInput`, `LogisticsEventOutcome`.

## Line Eligibility Reason Precedence

When checking if a line can be shipped using a given delivery method, rules are evaluated in the following strict order (the first failure is returned as the line reason):
1. `fulfilment_not_agreed`: The line has `fulfilment.kind === 'not_agreed'`.
2. `shipping_attributes_missing`: Physical item shipping attributes are null.
3. `method_unsupported`: The seller does not offer this delivery method in `delivery_options`.
4. `method_unsupported`: The shipper (seller for `self`, supplier for `drop_ship`) lacks an active profile service matching the method, or the drop-ship agreement does not authorize the service.
5. `method_unsupported`: Convenience store pickup was chosen, but the item has `cvs_allowed === false`.
6. `temperature_unsupported`: The candidate profile services do not match the item's temperature requirement (C2 supports ambient only).
7. `too_large`: A single unit of the item exceeds candidate limits for weight (capped at 20 kg for Chunghwa Post), longest side, or dimension sum (L+W+H).
8. `cvs_value_limit`: Convenience store pickup was chosen, but item unit price exceeds NT$20,000 (`2_000_000` minor units).
9. `outlying_unsupported`: Delivery to an outlying island is requested, but the seller option excludes outlying islands, or candidate services do not allow outlying islands (Chunghwa Post only delivers to the main island).

## Service Choice and Refined Group Key

Lines from the same shipper sharing temperature and agreement are clustered:
- `(executor_shop_id, agreement_id or null, temperature)`
To prevent charging buyers for unnecessary extra parcels, the algorithm selects the first service in the shipper's profile order that satisfies **every** line in the cluster. If no single service can accommodate all lines (e.g. one item fits only on Post and another only on T-Cat), each line falls back to its own first eligible service.

Each delivery group is identified by the refined group key:
- `(executor_shop_id, agreement_id or null, ship_from_location_id, temperature, service_key)`
This guarantees that every delivery group represents exactly one physical dispatch stream, one legal agreement version, and one specific logistics carrier service. Groups are ordered by the input index of their first line (`g1`, `g2`, ...).

## Parcel Packing Algorithm

Within each delivery group, lines are expanded into individual units (in line input order):
1. `ship_alone`: If an item requires its own box (`ship_alone === true`), it immediately opens a dedicated parcel containing solely this unit. No subsequent units may ever be added to this parcel.
2. First-fit non-ship-alone packing: The unit is placed into the first existing non-ship-alone parcel of the group (in parcel creation order) that satisfies all of:
   - `parcel.weight_g + unit.weight_g <= effectiveMaxWeight(service)` (effective weight cap is 20 kg for Post).
   - If CVS: `parcel.declared_value_minor + unit.unit_price_minor <= 2_000_000` (NT$20,000 maximum).
   - If `max_per_parcel` is configured: the number of units of this line already in the parcel is less than `max_per_parcel`.
3. If no existing parcel can accommodate the unit, a new parcel is opened (`<group_ref>-p<n>`).
4. Resulting parcel line lists are sorted by original line input order.

## Fee Calculation Rules

- Base fee: `fee_per_parcel_minor` from the seller's option. If `free_over_minor` is set and `merchandise_net_minor >= free_over_minor`, the base fee is waived (0).
- Outlying surcharge: If destination is outlying and the seller option defines an outlying surcharge, `surcharge_per_parcel_minor` is charged per parcel.
- **Decision**: Free shipping waives only the base shipping fee; the outlying surcharge still applies when shipping is free.
- Group fee: `parcels.length * (base + surcharge)`.
- Order shipping total: Sum of group shipping amounts.
- **Decision**: If a shipper subsequently decides to split items into additional physical parcels during actual fulfillment, the buyer is never charged for extra parcels beyond the frozen checkout terms.

## Recipient Validation and Convenience Store Selection

All text fields are normalized using Unicode NFKC.
- Names: Must contain only Han ideographs and Latin alphabet characters (no digits, spaces, symbols, emoji, or dots). Han characters count as weight 2 (per code point, including surrogate pairs like `𠮷`), ASCII letters count as weight 1. Valid total weight is 4 to 10. After length and weight checks pass, names are checked against ECPay's CDN blocked terms (`findCdnBlockedTerm`); if matched (e.g. `Echo`, `ECHO`, `Tftp`), validation returns `blocked_term` so the buyer can provide an acceptable name (e.g. Chinese real name on ID card) before the request is rejected by ECPay's CDN. Order of checks: required -> format -> too_short/too_long -> blocked_term.
- Mobile numbers: Must be a valid Taiwan mobile number matching `^09[0-9]{8}$`. Numbers in international format `+8869xxxxxxxx` are normalized to `09xxxxxxxx`.
- **C2 Mobile Rule**: Convenience store pickup strictly requires a mobile number for SMS pickup notifications [8809]. Home delivery in C2 also strictly requires a mobile number so couriers can coordinate delivery.
- Addresses: Input containing a lone UTF-16 surrogate returns `format` before any cleaning (the same rule as ECPay's `assertHomeAddress`; valid surrogate pairs are accepted). Stripped of control characters (C0, DEL, C1) and whitespace runs collapsed. Checked for HTML characters: if the cleaned text contains `<`, `>`, or `&`, validation returns `format` (ECPay strictly forbids HTML in values; full-width `＆` normalizes to `&` under NFKC and is also rejected as `format`; format check precedes length checks). Must be 7 to 60 Unicode code points (<= 6 is `too_short`, > 60 is `too_long` per [7414]). After length checks pass, the cleaned address is checked against ECPay's CDN blocked terms (`findCdnBlockedTerm`; e.g. `cd/`, `echo`, `tftp`, `;`), returning `blocked_term` if any blocked term is found. Order of checks: required -> format (lone surrogate, then `<>&`) -> too_short/too_long -> blocked_term.
- Postal prefixes: Must be 3, 5, or 6 digits, with the first 3 digits matching an official Taiwan postal prefix.
- `blocked_term`: Added to `RecipientValidationCode`. Indicates the cleaned name or home address contains a command word or character blocked by ECPay's CDN. The buyer must rewrite it (for example, the English name `Echo` to the Chinese name on the ID card).

### Electronic Map Store Selection (`normalizeCvsStoreSelection`)

Validates callback parameters returned by ECPay's electronic store map:
- `sub_type`: Must be one of `UNIMARTC2C`, `FAMIC2C`, `HILIFEC2C`.
- `store_id`: 1–6 alphanumeric characters (`^[0-9A-Za-z]{1,6}$`) are accepted. If the cleaned ID is 7–9 alphanumeric characters (`^[0-9A-Za-z]{7,9}$`), validation returns `too_long` (because the electronic map allows a `CVSStoreID` of up to 9 characters [8795], but the logistics create call only accepts 6 [8809]; this allows the UI to instruct the buyer to choose another store). Any other value that is not 1–6 alphanumerics returns `format`. Store name and address originate from ECPay's map and are not submitted back to ECPay, so they receive no CDN check.
- `store_name`: Up to 10 Unicode code points.
- `store_address`: Up to 60 Unicode code points.
- `outside` and Outlying Detection:
  - If `outside` is provided as a non-empty string after trimming, it must be `'0'` or `'1'` (anything else returns `format` error); `outlying` is `true` if and only if `outside === '1'`.
  - Hi-Life C2C (`HILIFEC2C`) never provides `CVSOutSide` [8795]. If `outside` is absent (`undefined`, `null`, or empty string after trimming), no error is produced; `outlying` is determined by stripping all whitespace from the store address and testing whether it contains any of the 22 designated outlying island divisions and townships:
    `澎湖縣`, `金門縣`, `連江縣`, `馬公市`, `湖西鄉`, `白沙鄉`, `西嶼鄉`, `望安鄉`, `七美鄉`, `金城鎮`, `金湖鎮`, `金沙鎮`, `金寧鄉`, `烈嶼鄉`, `烏坵鄉`, `南竿鄉`, `北竿鄉`, `莒光鄉`, `東引鄉`, `琉球鄉`, `綠島鄉`, `蘭嶼鄉`.

## Postal Prefix Source

- Source: 中華郵政「臺灣地區郵遞區號前3碼一覽表」 (Chunghwa Post 3-digit Postal Prefix Table).
- Effective Date: 103.12.25 (2014-12-25; the 2020 3+3 postal code revision maintained the first 3 digits unchanged).
- URL: <https://www.post.gov.tw/post/internet/Download/index.jsp?ID=220306>
- Retrieved: 2026-10-15 by the integration lead.
- Maintenance notice: This table contains exactly 368 valid 3-digit prefixes. It must be re-checked whenever Chunghwa Post publishes an updated administrative subdivision postal listing.

## Ship-By Deadline Calculation

Calculates the seller commitment deadline (23:59:59.000 Asia/Taipei) from confirmation timestamp:
- If payment confirmation occurs on a working day strictly before `cutoff_time`, the start day is the confirmation day.
- Otherwise, the start day is the next working day after confirmation.
- `ship_by` is 23:59:59.000 Asia/Taipei on the `handling_days`-th working day following the start day.
- C2 operates without built-in public holidays; unexpected delays are handled via the unable-to-fulfil reporting flow (EC-SPEC-05 §4.5).

## Logistics Tracking Codes, State Machine and Event Processing

The status-code table follows EC-SPEC-05 §6.3 and the official ECPay「物流貨態代碼表」(xlsx, 2026-06-04); the copy in the repo is [ecpay-logistics-status-map.tsv](../../../docs/platform-plan/execution/commerce/ecpay-logistics-status-map.tsv); hashes and row counts are in `docs/platform-plan/execution/commerce/sources.md` §8.

### Code Mapping (`mapLogisticsStatus`)

The mapping key is `(sub_type, rtn_code)`. The same status code can mean entirely different outcomes depending on the logistics carrier sub-type:
- For example, code `5004` represents `returning` progress for T-Cat (`TCAT`), but is a `carrier_attention` exception for Hi-Life C2C (`HILIFEC2C`).
- Code `7003` represents `carrier_attention` exception for Hi-Life C2C, but `recipient_address_invalid` exception for T-Cat.

Only the five sub-types created in C2 operations (`UNIMARTC2C`, `FAMIC2C`, `HILIFEC2C`, `TCAT`, `POST`) are mapped (278 total rows). B2C sub-types and unknown sub-types are returned as `unmapped`.

Mapping outcomes fall into five distinct kinds:
1. `progress` (143 rows): Advances shipment state to `status.state`. May specify an associated domain exception (`uncollected` or `damaged`).
2. `exception` (115 rows): State remains unchanged; opens domain exception `status.exception` (`pickup_store_closed`, `recipient_address_invalid`, `uncollected`, `lost`, `damaged`, `contradicting_event`, or `carrier_attention`).
3. `informational` (9 rows): Known, non-disruptive carrier informational notices (e.g. store code migration, address modification requested, store confirmation in progress). State and exceptions remain unchanged; events are stored in the audit log.
4. `ops_review` (11 rows): Valid codes present in ECPay documentation that should not occur in standard C2 forward workflows (such as reverse logistics return codes and ambiguous codes like T-Cat `7029`「已回收」). State remains unchanged, and the event is queued for platform operations review.
5. `unmapped`: Sub-types or return codes not present in the table. State remains unchanged, and the event is queued for platform operations review. **Unmapped codes are preserved in the event log, never guessed.**

### Tracking State Machine (`applyTrackingState`)

Enforces forward progression, return branches, and contradiction detection:
1. `voided` shipments reject any incoming tracking event (`contradiction`, state remains `voided`).
2. Identical incoming state results in no change (`none`).
3. Initial states (order <= 1: `draft`, `creating`, `create_unknown`, `create_failed`) advance to any incoming tracking event.
4. Forward branch (`created` .. `delivered`):
   - Advances to higher-order forward events.
   - Ignores older out-of-order forward events (`ignore_older`).
   - `delivered` followed by a return event (`returning`, `returned`) is flagged as a `contradiction`.
   - Other forward states advance to return branch events (`returning`, `returned`).
5. Return branch (`returning`, `returned`):
   - Advances from `returning` to `returned`.
   - Ignores older return events (e.g. `returned` followed by `returning`).
   - `delivered` arriving after entering the return branch is flagged as a `contradiction`.
   - Other forward events arriving after entering the return branch are ignored (`ignore_older`).
6. `record_handover`: Handover must be recorded in inventory per EC-SPEC-05 §5.5 when parcel tracking first enters `handed_over` or later (including direct transitions into the return branch). `record_handover` evaluates to `true` exactly when `change === 'advance'`, `current` order is <= 2 (`draft` through `created`), and `next` order is >= 3 (`handed_over` through `returned`).

### Event Application (`applyLogisticsEvent`)

Applies untrusted carrier callbacks against the shipment's current state and active exception list per EC-SPEC-05 §6.4:
- Caller parameters: `sub_type`, `rtn_code`, `current` shipment state, and `open_exception_kinds` (kinds of currently open exceptions linked to this shipment).
- Caller errors throw `FulfilmentRuleError` for non-object inputs, invalid `current` state, or malformed `open_exception_kinds` (must be array <= 32 non-empty strings).
- Duplicate prevention: An exception is opened (`open_exception = kind`) only if `kind` is not already present in `open_exception_kinds`; otherwise `open_exception = null`.
- Rules:
  - `progress`:
    - If `change === 'advance'`:
      - If `status.exception` is not null, opens it.
      - Otherwise, if advancing into `returning` or `returned` from a non-return state when `open_exception_kinds` is empty, opens `carrier_attention` (unexplained return).
    - If `change === 'contradiction'`: opens `contradicting_event`.
    - If `none` or `ignore_older`: no exception opened.
  - `exception`:
    - If `current` is `delivered` or `voided`: opens `contradicting_event`.
    - If kind is `pickup_store_closed` or `recipient_address_invalid`: only opens if `current` order is 2–5 (`created` .. `ready_for_pickup`); otherwise no exception opened.
    - Otherwise: opens the exception kind.
  - `informational`: state unchanged, `change: 'none'`, `record_handover: false`, no exception, `daily_review: false`.
  - `ops_review` / `unmapped`: state unchanged, `change: 'none'`, `record_handover: false`, no exception, `daily_review: true`.
- Immutability guarantee: Caller input `open_exception_kinds` is never frozen, modified, or retained in return structures.

## Hosted shipping settings (M3)

The settings layer implements [EC-SPEC-05 §2](../../../docs/platform-plan/execution/commerce/EC-SPEC-05-fulfilment.md)
and the independent [store capabilities](../../../docs/platform-plan/execution/commerce/EC-SPEC-09-security-ci-tests.md).
It performs no provider call, quote, logistics-order creation or email delivery.
Migration 170 adds tenant-RLS `commerce_ship_from_locations` (personal data) and
`commerce_logistics_services`, plus non-PII, participant-ACL exempt
`commerce_shipping_profile_versions` and `commerce_item_shipping_attributes`.

The console flag mounts these routes below `/api/v1/tenants/:tenant_id/storefronts/:instance_id`:

| Routes | Capability in addition to `store:read` |
| --- | --- |
| GET `/ship-from-locations`, GET `/ship-from-locations/:location_id`, GET `/shipping-profile` | `store:manage` or `store:fulfil` |
| POST `/ship-from-locations`, POST `/ship-from-locations/:location_id/retire`, PUT `/shipping-profile` | `store:manage` |
| GET `/products/:product_id/shipping-attributes` | `store:read` |
| PUT `/products/:product_id/shipping-attributes` | `store:write` |

Writes require a live store and serialize on its instance row. They do not acquire
an order advisory lock, spend a budget or stop in commerce quarantine. An item's
attributes belong exclusively to its supply shop's confirmed tenant/instance;
a retailer's selection of a supplied item grants no settings access.

Every profile save appends the next integer version of `freedom.shipping-profile/v1`.
Every attribute save appends the next version per item. The highest version is current.
The first save permits absent `If-Match`; subsequent saves require the current quoted
version. Missing versions answer 428; stale or premature versions answer 412.
Responses carry the current version in `ETag`. Profile working days are sorted and
its SHA-256 covers `canonicalJSON(document)`; service order retains preference order.

Locations never change. Replacement creates a row linked by `replaces_location_id`,
retires the previous row and, if referenced, appends one profile version replacing
all sender/return references in the same transaction. Used roles must be preserved.
A referenced location cannot retire independently. Twenty unretired locations are
allowed per store. Sender validation uses `validateHomeRecipient` and retains its
normalized fields. Over HTTP, the platform JSON guard rejects raw NUL and lone
UTF-16 surrogates anywhere in a body with 422 `validation_failed`, before
authentication; the shared command boundary repeats that rejection with 400
`invalid_command_json` for any other caller. Other control characters in labels
and addresses produce 422 `shipping_input_invalid` field errors. Command receipts contain only `{ id }`; fresh commands and
replays project current rows within the same authorized transaction. No location
personal data belongs in a receipt, log, Problem detail, control event or journal.

Later quote work can rely on the current profile version and these functions:

- `logisticsAvailability(q, { instanceId, environment })` supplies five states in
  `SERVICE_KEYS` order and `profileServiceKeys`, the activated retained sub-types a
  profile may list under a non-retired purpose row. Suspended services may remain configured.
- `resolveLogisticsService(q, { instanceId, environment, serviceKey })` resolves an
  account, sub-type and current purpose credential version only when both states
  are active. This is the sole resolution policy; callers must not duplicate it.
- `currentItemShippingAttributes(q, itemIds)` returns a map of
  `{version, attributes}` for the latest saved row per item, omitting items with
  no saved attributes. `version` is the attribute row's decimal text.

The route option fixes sandbox/live environment; requests cannot choose it.
Fulfilment settings and the shipping route must never import payments or operations.
They read provider tables with SQL and import only fulfilment rules, hosted/checkout,
providers, packages, tenant HTTP helpers and contracts. Payments may import fulfilment;
contracts never import module code. This preserves the descriptor dependency graph.

## Hosted shipping quote

`createShippingQuotePort({environment})` is the production `ShippingQuotePort`.
Checkout injects it from the Node runtime and the Worker, ahead of payment ports
and any caller override. The port reads the seller's current shipping profile,
active logistics services and current item attributes with the checkout client
after the store is bound. It does not call ECPay. The `rules/` library stays
free of I/O; this adapter is the only place those reads happen.

No profile, or a profile with no delivery options, is 409 `shipping_not_configured`.
An unconfigured cart ignores delivery input and returns no options. Configured
checkout parses delivery before planning. An invalid cart is 422 `delivery_invalid`
before any plan, so a bad key cannot become a 500. Unknown object keys that are
ASCII identifiers of a safe path length use `delivery.<key>`. Unicode, punctuation,
empty and over-long keys use one generic `delivery` path and are not echoed.
Meetup names first reject a raw string longer than 40 UTF-16 units, then
NFKC-trim to 1–40 code points. They reject C0, DEL, C1 and unpaired surrogates.
A valid astral character inside that raw bound is accepted. ECPay name weight and
blocked-term rules do not apply to meetup. Lone surrogates in JSON are still
rejected by the shared platform boundary.

Own lines are `{kind:'self'}`. Supplied lines are `{kind:'not_agreed'}` and fail
with `fulfilment_not_agreed` for every offered method, including meetup. This
port never emits `drop_ship`. An agreements job can later pass a real agreement
into the planner; until then it must not relabel a supplied line as own. The
test helper's synthetic drop-ship agreements are not used here.

Meetup is stripped before `planDelivery`. The rules library still knows only the
four ECPay methods. An offered meetup option with only own lines freezes one
`self` group: the seller supply shop, the seller profile version, one parcel,
zero fees, no logistics, the seller note, no attribute versions, and
`destination_state: 'complete'`. A `drop_ship` meetup line is
`method_unsupported` and does not build a group. A supplied line is
`fulfilment_not_agreed`. An own line whose supplier shop is not the seller shop
fails `validateShippingQuote` as `shipping_quote_invalid`.

ECPay methods use `planDelivery` and `availableMethods`. The seller shop is the
executor. Services are the profile services whose logistics row is `active`, in
document order. A profile with options but no active service is configured, then
`method_unsupported`, not 409. Home outlying follows the postal prefix. Cart
option totals are always planned as main-island (`outlying: false`) and keep the
seller's free-over and outlying fields even when the option is unavailable.
The quoted method uses the buyer's postal outlying flag. Free shipping zeros the
base fee when merchandise reaches `free_over_minor`; an outlying surcharge is
still charged. CVS quotes freeze `destination_state: 'store_required'`. Checkout
refuses to place that state. The map job will attach the chosen store and can
then freeze `complete`. Fulfilment orders, shipments, labels and tracking are
unchanged.

`FulfilmentRuleError` from the rules library propagates. It is not rewritten
into a buyer 4xx. Successful plans pass `validateShippingQuote` before they are
returned. Cart results are parsed with the cart shipping schema or thrown as
`shipping_quote_invalid`. A method the seller does not offer is
`method_unsupported` for every line, before the fulfilment check, so a supplied
line on an unoffered method is not reported as `fulfilment_not_agreed`.
