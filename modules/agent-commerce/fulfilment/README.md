# Freedom Commerce Fulfilment (`commerce-fulfilment`)

This module provides the pure, I/O-free domain rule functions for Freedom Commerce fulfilment and logistics planning, following EC-SPEC-05 §1.1, §2.2–§2.6, §3.1–§3.5, §5.1, §6.3, and §6.4.

## Scope & Status

### What exists now
- Pure rule functions and TypeScript types under `rules/` (`errors.ts`, `types.ts`, `taipei.ts`, `postal.ts`, `recipient.ts`, `ship-by.ts`, `plan.ts`, `tracking.ts`, `index.ts`).
- Deterministic group clustering, service choice, first-fit parcel packing, fee calculation, recipient validation, ship-by deadline calculation, and tracking state transition logic.
- 100% pure execution: no database access, no network calls, no system clock reads, no locale-sensitive formatters, no environment access, no console logging, no side-effects. All times are passed as epoch milliseconds.
- All returned objects and nested arrays are deeply frozen with `Object.freeze`.

### What does not yet exist (deferred to future fulfilment domain milestone)
- Database tables and migrations (e.g. `commerce_ship_from_locations`, `commerce_shipping_profile_versions`, `commerce_item_shipping_attributes`, `commerce_fulfilment_agreements`, `commerce_fulfilment_orders`, `commerce_fulfilment_recipients`, `commerce_cvs_selection_sessions`, `commerce_shipments`, `commerce_logistics_operations`, `commerce_logistics_events`).
- HTTP routes and provider callbacks (carrier callbacks, store checkout CVS map selection, printing endpoints).
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
- `normalizeCvsStoreSelection(raw)`: Validates and normalizes ECPay electronic map callback store parameters.
- `computeShipBy(confirmedAtEpochMs, options)`: Calculates promised shipping deadline (23:59:59 Asia/Taipei) across working days and daily cutoff.
- `planDelivery(input, method)`: Deterministically partitions order lines into delivery groups, packs parcels, and calculates fees for a method.
- `availableMethods(input)`: Evaluates all seller delivery options in order and returns each method with its plan or unavailable reasons.
- `SHIPMENT_STATE_ORDER`: Numeric precedence table for tracking lifecycle states (0 to 8, voided = null).
- `mapLogisticsStatus(subType, rtnCode)`: Strictly maps verified ECPay carrier tracking codes to shipment states and exceptions.
- `applyTrackingState(current, incoming)`: Pure state machine advancing forward and return tracking states according to monotonicity rules.
- `toTaipeiDateTime(epochMs)` / `fromTaipeiDateTime(...)`: Pure calendar conversion utilities for Asia/Taipei (UTC+08:00 fixed).

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

## Recipient Validation and C2 Mobile Rule

All text fields are normalized using Unicode NFKC.
- Names must contain only Han ideographs and Latin alphabet characters (no digits, spaces, symbols, emoji, or dots). Han characters count as weight 2 (per code point, including surrogate pairs like `𠮷`), ASCII letters count as weight 1. Valid total weight is 4 to 10.
- Mobile numbers: Must be a valid Taiwan mobile number matching `^09[0-9]{8}$`. Numbers in international format `+8869xxxxxxxx` are normalized to `09xxxxxxxx`.
- **C2 Mobile Rule**: Convenience store pickup strictly requires a mobile number for SMS pickup notifications [8809]. Home delivery in C2 also strictly requires a mobile number so couriers can coordinate delivery.
- Addresses: Stripped of control characters (C0, DEL, C1) and whitespace runs collapsed. Must be 7 to 60 Unicode code points (<= 6 is `too_short`, > 60 is `too_long` per [7414]).
- Postal prefixes: Must be 3, 5, or 6 digits, with the first 3 digits matching an official Taiwan postal prefix.

## Postal Prefix Source

- Source: 中華郵政「臺灣地區郵遞區號前3碼一覽表」 (Chunghwa Post 3-digit Postal Prefix Table).
- Effective Date: 103.12.25 (2014-12-25; the 2020 3+3 postal code revision maintained the first 3 digits unchanged).
- URL: <https://www.post.gov.tw/post/internet/Download/index.jsp?ID=220306>
- Retrieved: 2026-10-15 by Claude.
- Maintenance notice: This table contains exactly 368 valid 3-digit prefixes. It must be re-checked whenever Chunghwa Post publishes an updated administrative subdivision postal listing.

## Ship-By Deadline Calculation

Calculates the seller commitment deadline (23:59:59.000 Asia/Taipei) from confirmation timestamp:
- If payment confirmation occurs on a working day strictly before `cutoff_time`, the start day is the confirmation day.
- Otherwise, the start day is the next working day after confirmation.
- `ship_by` is 23:59:59.000 Asia/Taipei on the `handling_days`-th working day following the start day.
- C2 operates without built-in public holidays; unexpected delays are handled via the unable-to-fulfil reporting flow (EC-SPEC-05 §4.5).

## Logistics Tracking Codes and State Machine

ECPay Logistics Developer Documentation Sources:
- Callback Specs & Return Codes: <https://developers.ecpay.com.tw/7420/>
- Query Logistics Trade Info V5: <https://developers.ecpay.com.tw/7418/>
- C2C Order Cancel: <https://developers.ecpay.com.tw/7412/>
- Electronic Map Integration: <https://developers.ecpay.com.tw/8795/>
- Logistics Specification & Rules: <https://developers.ecpay.com.tw/8809/>
- Home Delivery Integration: <https://developers.ecpay.com.tw/7414/>
- Common Logistics Return Codes: <https://developers.ecpay.com.tw/62208/>
- Logistics Error Codes: <https://developers.ecpay.com.tw/10127/>
- Logistics Status Query: <https://developers.ecpay.com.tw/7410/>

### Verified Tracking Code Table

Only the verified codes below are mapped to shipment states and domain exceptions. Any unlisted code (including all TCAT and POST codes) is returned as `unmapped`. **Rule: Unmapped codes are preserved in the event log, never guessed.**

| Code | 7-ELEVEN B2C (`UNIMART`) | 7-ELEVEN C2C (`UNIMARTC2C`) | FamilyMart / Hi-Life (`FAMI`, `FAMIC2C`, `HILIFE`, `HILIFEC2C`) | Result State / Exception |
| --- | --- | --- | --- | --- |
| `300` | created | created | created | `created` |
| `2030` | in_transit | in_transit | — | `in_transit` |
| `3024` | — | — | in_transit | `in_transit` |
| `2063` | ready_for_pickup | — | — | `ready_for_pickup` |
| `2073` | — | ready_for_pickup | — | `ready_for_pickup` |
| `3018` | — | — | ready_for_pickup | `ready_for_pickup` |
| `2067` | delivered | delivered | — | `delivered` |
| `3022` | — | — | delivered | `delivered` |
| `2074` | returning | returning | — | `returning` + exception `uncollected` |
| `3020` | — | — | returning | `returning` + exception `uncollected` |
| `2098` | ready_for_pickup | ready_for_pickup | — | `ready_for_pickup` (secondary store delivery) |
| `2099` | — | returned | — | `returned` (returned to sender store) |
| `2037` | pickup_store_closed | — | — | exception_only `pickup_store_closed` |
| `7011` | — | — | pickup_store_closed (B2C `FAMI`/`HILIFE` only) | exception_only `pickup_store_closed` |

### Tracking State Transitions (`applyTrackingState`)

Enforces forward progression, branch returns, and contradiction detection:
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
6. `implies_handover`: Automatically flagged as `true` when advancing from a pre-handover state (order < 3: `draft`, `creating`, `create_unknown`, `create_failed`, `created`) to an in-transit or later state (order >= 4).
