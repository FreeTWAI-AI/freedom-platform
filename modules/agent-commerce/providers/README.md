# Commerce Provider Wire-Protocol Library (`commerce-providers`)

This module (`modules/agent-commerce/providers/ecpay/`) implements the shared, pure wire-protocol primitives for ECPay (綠界科技) payment (`EC-SPEC-04`), domestic logistics (`EC-SPEC-05`), and B2C e-invoice (`EC-SPEC-06`), together with the pure AIO credit-card one-time payment profile (`ecpay/aio-credit/`), the domestic logistics profile (`ecpay/domestic-logistics/`), and the B2C e-invoice profile (`ecpay/b2c-invoice/`).

## Scope: What This Library Is and Is Not

- **What it is**: Deterministic, worker-safe (Node.js + Cloudflare `workerd`) pure functions for `.NET`-compatible URL encoding, URL-encoded form parsing/serialization, `CheckMacValue` signing/verification (`SHA-256` and `MD5`), `AES-128-CBC` `Data` envelope encryption/decryption, legacy pipe response parsing (`1|...` / `0|...`), 20-character Crockford Base32 trade number generation, and ECPay's CDN word-filter guard (`findCdnBlockedTerm`). `ecpay/aio-credit/` holds the `ecpay.aio.credit.v1` field assembly and result mapping, `ecpay/domestic-logistics/` holds the `ecpay.logistics.domestic.v1` field assembly and result mapping, and `ecpay/b2c-invoice/` holds the `ecpay.invoice.b2c.v1` field assembly, request sealing, and allowlisted response/callback parsing on top of those primitives.
- **What it is not**: It performs **no I/O** (`fetch`, sockets, database queries, timers, clock reads via `Date.now()` / `new Date()`, environment reads, or logging). The core wire library has no endpoint-specific business rules; `ecpay/aio-credit/`, `ecpay/domestic-logistics/`, and `ecpay/b2c-invoice/` isolate the payment, domestic logistics, and B2C e-invoice protocol surfaces, while HTTP transport, retries, outbox scheduling, and database state machines live in their own domain adapters.

## Wire Formats and Official ECPay References

All page numbers below refer to `https://developers.ecpay.com.tw/<page>/`:

1. **`.NET`-Style URL Encoding (§A — pages `2902`, `2904`, `7424`, `7446`, `7958`, `38406`)**:
   - UTF-8 percent-encoding matching .NET `HttpUtility.UrlEncode`, normalized to uppercase hex prior to case transformations: `- _ . ! * ( )` remain literal, space (`%20`) becomes `+`, `~` becomes `%7E`, and `'` becomes `%27`.
2. **`CheckMacValue` Form MAC (§B — AIO payment pages `2902`, `2904`, `2878`; domestic logistics pages `7424`, `7446`, `8809`, `7418`; e-invoice allowance callback page `38242`)**:
   - All fields except `CheckMacValue` (case-insensitive), including empty values, are sorted ascending by `key.toLowerCase()` (ASCII code-unit order).
   - Framed as `HashKey=<key>&k1=v1&k2=v2...&HashIV=<iv>` using decoded field values, encoded with `dotnetUrlEncode`, converted entirely to `.toLowerCase()`, hashed with `SHA-256` (AIO payment) or `MD5` (legacy logistics and invoice allowance callback), and formatted as uppercase hex.
   - Verification parses the raw wire body directly (callers must never re-serialize or re-encode before verifying) and compares the uppercase MAC in constant time (`timingSafeEqual`) across all candidate keys without early exit.
3. **AES-128-CBC `Data` Envelope (§C — e-invoice pages `7958`, `38406`, `7896`)**:
   - Encryption: `JSON.stringify(payload)` → `dotnetUrlEncode` (without lower-casing) → `AES-128-CBC` with PKCS7 padding (`key = HashKey`, `iv = HashIV`, 16 UTF-8 bytes each) → Base64.
   - Decryption: strict Base64 validation (non-empty, length divisible by 4, decoded byte length a positive multiple of 16) → `AES-128-CBC` decrypt → `+` to space and `decodeURIComponent` (accepting both uppercase `%7B` and lowercase `%7b` escapes) → `JSON.parse`.
   - Request envelope: `{"PlatformID":"","MerchantID":"<id>","RqHeader":{"Timestamp":<unix seconds>},"Data":"<base64>"}`. Callers supply `timestamp` at send time (valid for 10 minutes at ECPay).
   - Response envelope: `{ TransCode, TransMsg, Data }`. Business success requires both `TransCode == 1` and decrypted `Data.RtnCode == 1` (accepting numeric `1` or string `"1"`).
4. **Legacy Logistics Pipe Responses (§D — page `8809`)**:
   - Background `Express/Create` returns `1|<signed form>` on creation or `0|<error message>` on rejection; `Helper/UpdateShipmentInfo`, `Express/CancelC2COrder`, and `Express/UpdateStoreInfo` return `1|OK`. Leading/trailing ASCII whitespace is stripped first and the body is split at the first `|` only.
   - Per `EC-SPEC-05` §5.3, unparseable bodies, `1|OK` without a form, malformed forms, or missing/mismatched MACs map to `{ kind: 'unknown', reason }` ("do not resend; query the same `MerchantTradeNo` first"), never "rejected".
5. **Callback Acknowledgement (§E — pages `2878`, `8809`, `38242`)**:
   - All form callbacks (`ReturnURL`, `ServerReplyURL`, allowance `ReturnURL`) acknowledge processing with exact plain-text body `1|OK` (`ECPAY_ACK`).

## Important Protocol Properties & Official Errata

- **Letter-Case Insensitivity of `CheckMacValue`**:
  Because step 4 of `CheckMacValue` lower-cases the entire `dotnetUrlEncode` output before hashing, the MAC does **not** authenticate the letter case of field keys or values (`MerchantTradeNo=d9rmxnrihuym` produces the exact same MAC as `MerchantTradeNo=D9RMXNrihUYM`). Callers must normalize identifiers (our trade numbers generated by `newTradeNumber` use uppercase ASCII only).
- **Logistics Query V5 Sample Erratum (Page `7418`)**:
  ECPay's documentation page `7418` (`QueryLogisticsTradeInfo/V5`) lists a sample response that includes three V5-added fields (`SenderName`, `SenderPhone`, `SenderCellPhone`), but prints `CheckMacValue=B655FB0F67E8F89DB9DD997D19C3B62D`, which is the MD5 over the pre-V5 field set without those three fields. Including the three V5 fields yields `9FB2FDBE42AD47754F33CF85C3133E9C`. Our verifier always authenticates all received fields and therefore rejects the stale `B655...` MAC when the V5 sender fields are present.

## CDN Word Filter (Page `7400`)

- **The Rule and Why Ours Is Stricter**: ECPay's CDN (page `7400`) blocks requests whose parameter values contain case-insensitive shell command words (`net localgroup`, `net.exe`, `nmap.exe`, `nc.exe`, `traceroute`, `tracert`, `telnet.exe`, `tclsh`, `tftp`, `wguest.exe`, `wsh.exe`, `rcmd.exe`, `ftp.exe`, `echo`, `cmd32.exe`, `cmd.exe`, `cmd` with `/c`, `cd` followed by `/`, `\`, or `..`, `chmod` with `+x`), or the shell characters `;`, `|`, and backtick when followed by command names, as well as HTML tags. `findCdnBlockedTerm(value)` applies a deliberately stricter stateless regular expression (`[;|`]|net\s+localgroup|cmd32\.exe|cmd\.exe|cmd\s*\/c|net\.exe|nmap\.exe|nc\.exe|telnet\.exe|wguest\.exe|wsh\.exe|rcmd\.exe|ftp\.exe|traceroute|tracert|tclsh|tftp|echo|cd\s*(?:\/|\\|\.\.)|chmod\s*\+x`, case-insensitive, without `g`/`y` flags) that blocks any of those words and rejects `;`, `|`, or `` ` `` anywhere in a value so we never depend on ECPay's exact undocumented command list.
- **Where It Is Applied**:
  - Every request builder across `aio-credit/` and `domestic-logistics/` runs `assertCdnSafe` on every field value before signing or creating the request/form.
  - Every request builder in `b2c-invoice/` checks the sealed JSON request body with `findCdnBlockedTerm` and re-encrypts `Data` with leading JSON whitespace after the opening `{` if the Base64 ciphertext spells a blocked term (`cd/`, `echo`, `tftp`, etc.).
  - `assertValidEcpayHttpsUrl` forbids `?` (even an empty query), restricts `pathname` to `^/[A-Za-z0-9._~/-]*$` (no `%`-escapes, non-ASCII, or `;`/`|`/`` ` ``), and runs `assertCdnSafe` on the full URL.
  - `newTradeNumber` draws up to 16 candidates and returns the first for which `findCdnBlockedTerm` is `null` (because random Base32 characters can spell `TFTP` or `TRACERT`), throwing `invalid_input` if all 16 are blocked.
  - In `aio-credit/`, `buildItemName` falls back to `{store}商品一批 x1` if the joined line items exceed 200 UTF-16 code units or match `findCdnBlockedTerm` (and further falls back to `商品一批 x1` if the sanitized store name itself matches `findCdnBlockedTerm`), and `buildCreditCheckoutForm` falls back `TradeDesc` from `'Freedom order ' + displayNumber` to `'Freedom order'` if `displayNumber` matches `findCdnBlockedTerm`.
- **Domain Responsibility**: Fulfilment and payment domain code must validate buyer/shipper names and addresses at intake and must check generated references and callback URL segments with `findCdnBlockedTerm` (for example, an account reference ending in `cd` followed by `/` in a callback path like `.../abcd/logistics` matches `cd/` and is blocked).

## Key-Handling Rules

- Callers decrypt sealed account credentials (`EC-SPEC-04` §1.3) at the adapter boundary and pass them into this library exclusively via `EcpayKeyPair.of(hashKey, hashIV)` and `EcpayCreditCheckCode.of(checkCode)`.
- Both `hashKey` and `hashIV` must match `^[A-Za-z0-9]{16}$`; `CreditCheckCode` must match `^[0-9]{8}$`.
- Raw secret material is stored in module-private `WeakMap`s and is never exposed on public properties; `toString()`, `toJSON()`, and `nodejs.util.inspect.custom` all return redacted placeholders (`[redacted]` / `EcpayKeyPair [redacted]` / `EcpayCreditCheckCode [redacted]`).
- `EcpayProtocolError` uses a closed set of error codes with fixed English messages and never embeds keys, inputs, plaintexts, ciphertexts, or `cause`.

## Public Exports (`modules/agent-commerce/providers/ecpay/index.ts`)

- `EcpayProtocolError` / `type EcpayErrorCode`: Structured protocol exception with a closed union of error codes and fixed, secret-free English messages.
- `EcpayKeyPair`: Opaque, redacted holder for a validated 16-byte alphanumeric `HashKey` and `HashIV` pair (`EcpayKeyPair.of(hashKey, hashIV)`).
- `dotnetUrlEncode(value)`: Encodes a string according to ECPay's `.NET` URL-encoding rules; throws `invalid_text` on lone UTF-16 surrogates.
- `formUrlDecode(component)`: Converts `+` to space and percent-decodes a form component; throws `malformed_form` on invalid escapes.
- `parseForm(body, options?)` / `type FormFields` / `type ParseFormOptions`: Parses a raw string or `Uint8Array` form body (default max 16,384 bytes and 128 fields) preserving field order and rejecting case-insensitive duplicate keys.
- `encodeForm(fields)`: Serializes `FormFields` or a `Record<string, string>` into a `dotnetUrlEncode(k)=dotnetUrlEncode(v)` query string.
- `computeCheckMacValue(fields, keys, algorithm)`: Computes the uppercase hex `SHA-256` or `MD5` `CheckMacValue` for a field collection.
- `signFields(fields, keys, algorithm)`: Appends `['CheckMacValue', mac]` to `fields`; rejects inputs that already contain `CheckMacValue`.
- `verifySignedForm(body, keys, algorithm, options?)` / `type VerifySignedFormResult`: Parses and verifies a signed form body against one or more `EcpayKeyPair`s in constant time without throwing on malformed input, returning a null-prototype frozen `fields` map and matched `keyIndex`.
- `aesEncryptString(plain, keys)` / `aesDecryptString(base64, keys)`: Raw `AES-128-CBC` / PKCS7 / strict Base64 string encryption and decryption.
- `encryptData(payload, keys)` / `decryptData(data, keys)`: URL-encoded JSON `Data` cipher helpers used by e-invoice and omni-logistics envelopes.
- `newTradeNumber(prefix, randomBytes?)` / `isTradeNumber(value, prefix?)`: Generates and validates 20-character (`<prefix>` + 19 Crockford Base32 chars from 95 random bits) trade numbers, re-rolling up to 16 times if a candidate hits the CDN word guard.
- `findCdnBlockedTerm(value)`: Returns the leftmost substring blocked by the ECPay CDN word/character guard, or `null` when safe.
- `parsePipeResponse(text)` / `type PipeResponse`: Parses legacy `1|<rest>` and `0|<message>` responses, stripping control characters and truncating error messages to 200 code points.
- `aio`: `{ sign, verify }` bound to `SHA-256` for AIO payment forms, callbacks, and trade queries.
- `logistics`: `{ sign, verify, parseCreateResponse }` bound to `MD5` for domestic logistics forms, callbacks, queries, and `Express/Create` pipe responses.
- `invoice`: `{ buildEnvelope, openResponse, verifyAllowanceCallback }` for low-level e-invoice AES envelopes and MD5 allowance callbacks (invoice domain code must use `ecpay/b2c-invoice/` builders and parsers instead of calling `invoice.buildEnvelope` / `invoice.openResponse` directly).
- `ECPAY_ORIGINS` / `ECPAY_ACK`: Frozen map of official `sandbox` (stage) and `live` origins for `payment`, `logistics`, and `invoice`, plus the `'1|OK'` callback acknowledgement constant.

## AIO Credit-Card Profile (`modules/agent-commerce/providers/ecpay/aio-credit/index.ts`)

### Public Exports

- `ECPAY_AIO_CREDIT_PROFILE`: Profile identifier constant `'ecpay.aio.credit.v1'`.
- `checkCreditAvailability(input)`: Pure gate checking `currency === 'TWD'`, whole-TWD minor units (`% 100 === 0` across `totalMinor` and all `amountsMinor`), and minimum total (`>= 500` minor units = NT$5) without rounding or truncation.
- `formatTaipeiDateTime(epochMs)` / `parseTaipeiDateTime(text)`: Formats and strictly parses `yyyy/MM/dd HH:mm:ss` timestamps in `Asia/Taipei` (`UTC+8`, no DST) using integer/UTC calendar arithmetic.
- `doActionWindow(epochMs)` / `nextDayCancelEarliest(authorisedAtEpochMs)`: Enforces ECPay's daily auto-capture maintenance window (`[20:15:00.000, 20:31:00.000)` Taipei blocked, retry at `20:31:00.000`) and next-day `06:00:00.000` Taipei cancellation boundary (page `2885`).
- `buildItemName(lines, storeName)` / `buildCreditCheckoutForm(input, keys)`: Sanitizes line items into ECPay's `#`-separated `ItemName` (with length and CDN word-filter fallbacks) and builds the signed `/Cashier/AioCheckOut/V5` form with a fixed 14-field order.
- `parsePaymentNotification(body, keys, options)` / `parsePaymentBrowserReturn(body, keys, options)`: Verifies and parses `ReturnURL` server notifications (allowlist-only, stripping card PAN fragments and `auth_code`) and `OrderResultURL` browser returns.
- `buildTradeInfoQuery(input, keys)` / `parseTradeInfoResponse(body, keys, options)`: Builds signed `/Cashier/QueryTradeInfo/V5` requests and maps signed responses into `paid`, `unpaid`, `failed`, `amount_mismatch`, `trade_no_mismatch`, or `unknown`.
- `EcpayCreditCheckCode` / `buildCreditDetailQuery(input, keys, checkCode)` / `parseCreditDetailResponse(text, options)`: Redacted 8-digit merchant check-code wrapper, signed `/CreditDetail/QueryTrade/V2` request builder, and unsigned JSON response parser.
- `planCreditRefund(input)`: Pure refund decision table mapping current credit-detail status and amounts to a sequence of `DoAction` steps (`C`, `R`, `E`, `N`) or a typed `not_refundable` reason.
- `buildDoActionRequest(input, keys)` / `parseDoActionResponse(text, options)`: Builds signed `/CreditDetail/DoAction` requests and parses unsigned form responses after verifying echoed `MerchantID`, `MerchantTradeNo`, and `TradeNo`.
- `EcpayServerRequest`: Immutable server-to-server `POST` descriptor whose URL-encoded body is stored in a module-private `WeakMap` and redacted in `toJSON()`, `toString()`, and `util.inspect`.

### Protocol Rules & Design Rationale

- **`ItemName` & `TradeDesc` Sanitisation and CDN Fallbacks**: Each line name replaces `#` (ECPay item delimiter), `<` / `>` (HTML injection), `|` / `;` / `` ` `` (which trip ECPay's CDN command-injection filter), C0/DEL/C1 controls, lone UTF-16 surrogates, and zero-width/bidi formatting characters (`U+200B–U+200F`, `U+202A–U+202E`, `U+2060–U+206F`, `U+FEFF`) with spaces, collapses whitespace runs to a single ASCII space, and substitutes `商品` when empty. If the joined `{name} x{quantity}` string exceeds 200 UTF-16 code units or matches `findCdnBlockedTerm`, `buildItemName` falls back to `{store}商品一批 x1` (with `storeName` sanitized and cut at 40 code points without splitting surrogate pairs, or `商品一批 x1` if empty or if `findCdnBlockedTerm(store)` is non-null). Similarly, `TradeDesc` is `'Freedom order ' + displayNumber`, falling back to `'Freedom order'` when `findCdnBlockedTerm(displayNumber)` is non-null, and every field value is verified with `assertCdnSafe` before signing.
- **Checkout Callback URL Rules**: `returnUrl`, `orderResultUrl`, and `clientBackUrl` must be canonical (`new URL(u).href === u`), `https:`, credential-free, default port (`443` omitted), fragment-free, query-free (no `?`), `<= 200` characters, with `pathname` matching `^/[A-Za-z0-9._~/-]*$`, hosted on a multi-label lowercase DNS name (non-numeric TLD, no IPv4/IPv6 literals), free of `&`, `<`, `>`, `"`, `'`, space, `%26`, `%3C`, and `%3c`, and accepted by `assertCdnSafe`.
- **Browser Returns Carry No Outcome**: `parsePaymentBrowserReturn` verifies the MAC and returns only `{ kind: 'return', merchantTradeNo, keyIndex }`. Browser posts to `OrderResultURL` are never payment evidence (`EC-SPEC-04` §4.2, `EC-AT18`); the caller only uses the return to trigger a server-side query.
- **Upper-Cased Identifiers**: Because `CheckMacValue` lower-cases the URL-encoded string before hashing, letter case is not authenticated by the MAC, and ECPay treats `MerchantTradeNo` case-insensitively. `parsePaymentNotification`, `parsePaymentBrowserReturn`, `parseTradeInfoResponse`, and `parseDoActionResponse` normalize `MerchantTradeNo` and `TradeNo` to uppercase so a case-altered replay maps to the same payment attempt and dedupe key.
- **Resilient Fee Parsing**: `chargeFeeMinor` (`PaymentTypeChargeFee`) and `handlingChargeMinor` (`HandlingCharge`) accept `^[0-9]{1,9}(\.[0-9]{1,2})?$` via string arithmetic (`10.5` → `1050` minor units) and fall back to `null` on any other format so a fee-format change at ECPay never rejects a valid paid notification or query.
- **Production-Only Endpoints & `EcpayServerRequest` Redaction**: `CreditDetail/QueryTrade/V2` and `CreditDetail/DoAction` exist only in production (`https://payment.ecpay.com.tw/CreditDetail/...`); calling their builders with `environment: 'sandbox'` throws `unsupported_environment`. Because `CreditDetail/QueryTrade/V2` embeds `CreditCheckCode` in the signed form body, all server-to-server builders return `EcpayServerRequest`, which hides the form body behind `bodyText()` and redacts `toJSON()`, `toString()`, and `util.inspect`.
- **Refund Decision Table (`planCreditRefund`) & `DoAction` Unknown Handling**: After rejecting `unauthorized` (`not_authorised`), `voided` (`already_voided`), and `refundedMinor + requestedMinor > paidMinor` (`exceeds_paid`), `planCreditRefund` plans:

  | `status` | Full (`refundedMinor === 0 && requestedMinor === paidMinor`) | Partial / Subsequent |
  | --- | --- | --- |
  | `authorized`, `capture_cancelled` | `[N paid]` | `refundedMinor === 0` → `[C paid, R requested]`; `refundedMinor > 0` → `state_inconsistent` |
  | `capture_pending` | `[E paid, N paid]` | `[R requested]` |
  | `captured` | `[R requested]` | `[R requested]` |

  In `parseDoActionResponse`, `{ kind: 'unknown', reason }` means **"result unknown — never resend, query `QueryTrade/V2` first"** (`EC-SPEC-04` §7.4).

## Domestic Logistics Profile (`modules/agent-commerce/providers/ecpay/domestic-logistics/index.ts`)

### Public Exports

- `ECPAY_DOMESTIC_LOGISTICS_PROFILE`: Profile identifier constant `'ecpay.logistics.domestic.v1'`.
- `ECPAY_LOGISTICS_SUBTYPES` / `subTypeForServiceKey(serviceKey)`: Frozen descriptor table for the five supported subtypes (`UNIMARTC2C`, `FAMIC2C`, `HILIFEC2C`, `TCAT`, `POST`) and exact lookup from service key (`ecpay.logistics.cvs.*` / `ecpay.logistics.home.*`).
- `buildCvsCreateOrderRequest(input, keys)` / `buildHomeCreateOrderRequest(input, keys)`: Builds signed `/Express/Create` `EcpayServerRequest`s for C2C store-to-store and home-delivery (`TCAT` / `POST`) shipments.
- `parseCreateOrderResponse(text, keys, options)`: Verifies and parses `Express/Create` `1|<form>` / `0|<message>` responses into `created`, `rejected`, or `unknown` without exposing recipient PII.
- `parseLogisticsNotification(body, keys, options)`: Verifies MD5 `ServerReplyURL` status callbacks and extracts allowlisted status, amount, timestamp, dedupe key, and `bodySha256`.
- `buildLogisticsQueryRequest(input, keys)` / `parseLogisticsQueryResponse(text, keys, options)`: Builds signed `/Helper/QueryLogisticsTradeInfo/V5` requests (by `AllPayLogisticsID` or `MerchantTradeNo`) and parses responses into `found`, `rejected`, or `unknown`.
- `buildPrintLabelForm(input, keys)`: Builds signed browser POST forms (`EcpayBrowserForm`) for C2C and home-delivery label printing endpoints (`PrintUniMartC2COrderInfo`, `PrintFAMIC2COrderInfo`, `PrintHILIFEC2COrderInfo`, `helper/printTradeDocument`).
- `buildCvsMapForm(input)` / `parseCvsMapReturn(body, options)`: Builds unsigned `/Express/map` browser POST forms and validates/sanitizes unsigned browser store-selection returns.
- `buildCancelC2COrderRequest(input, keys)` / `buildUpdateStoreRequest(input, keys)` / `parseLogisticsAckResponse(text)`: Builds signed `/Express/CancelC2COrder` (7-ELEVEN C2C only) and `/Express/UpdateStoreInfo` (C2C pickup store `StoreType=01`) requests and parses `1|OK` / `0|<message>` responses.
- `EcpayServerRequest` / `EcpayBrowserForm`: Redacted holders for server-to-server POST requests (`bodyText()`) and browser auto-submit forms (`fields()`).

### Protocol Rules & Design Rationale

- **Fixed `GoodsName` (`訂購商品`)**: Both create-order builders always send `GoodsName=訂購商品` ("ordered goods"). Because shipping labels are visible to carrier personnel and convenience-store staff, the label must not disclose what the buyer purchased, and a fixed constant cannot violate ECPay's `GoodsName` character rules or trigger the CDN word filter.
- **Party Rules & No PII in Results**: The domain normalizes buyer/shipper inputs before calling; the builders enforce person name weight `4–10` (`^(?:\p{Script=Han}|[A-Za-z])+$` with Han = 2 and Latin = 1), mobile phone `^09[0-9]{8}$`, postal zip `^(?:[0-9]{3}|[0-9]{5}|[0-9]{6})$`, home address `7–60` code points (no leading/trailing whitespace, C0/C1 controls, lone surrogates, or `<`/`>`/`&`), store ID `^[0-9A-Za-z]{1,6}$`, and CDN safety on every field. Per `EC-SPEC-05` §6.1–§6.2, none of `parseCreateOrderResponse`, `parseLogisticsNotification`, or `parseLogisticsQueryResponse` ever returns, stores, or logs recipient or sender names, phones, emails, or addresses.
- **Upper-Cased `MerchantTradeNo` vs. Exact-Case Label Identifiers**: Because MD5 `CheckMacValue` is case-insensitive, `MerchantTradeNo` is upper-cased in parsed results so case-altered replays match the same shipment and dedupe key. By contrast, `CVSPaymentNo`, `CVSValidationNo`, `ShipmentNo`, and `BookingNote` are returned with their exact received casing because they are echoed back to ECPay in subsequent print, cancel, or store-update calls.
- **Lenient Optional Fields & `ignoredFields`**: Optional fields in create responses, V5 query responses, and map returns (`UpdateStatusDate`, `CVSPaymentNo`, `CVSValidationNo`, `BookingNote`, `LogisticsType`, `HandlingCharge`, `ShipChargeDate`, `TradeDate`, `ShipmentNo`, `CVSOutSide`) map empty/absent values to `null`. If an optional field is non-empty but fails its format pattern, it maps to `null` and its field name is appended to `ignoredFields` in deterministic order rather than failing a validly signed response.
- **`unknown` Create Result Means Query First**: In `parseCreateOrderResponse`, `{ kind: 'unknown', reason }` means **"do not resend; query the same `MerchantTradeNo` first"** (`EC-SPEC-05` §5.3) via `QueryLogisticsTradeInfo/V5` so a timeout or unparseable response never creates a duplicate parcel or double-charges shipping.
- **Browser-Only, Redacted Print Forms (`EcpayBrowserForm`)**: ECPay's label endpoints must be opened by the shipper's browser via a top-level form POST (a server-side `fetch` only receives an intermediate page, and iframes do not work). Because anyone holding the signed print fields can reopen the label page, `EcpayBrowserForm` stores its field tuples in a module-private `WeakMap` and redacts `toJSON()`, `toString()`, and `util.inspect`.
- **Untrusted CVS Map Return**: `/Express/map` and its browser callback carry no `CheckMacValue`. `parseCvsMapReturn` validates field formats and sanitizes/truncates `CVSStoreName` (≤ 10 code points) and `CVSAddress` (≤ 60 code points), but **the entire return is untrusted browser input** until the calling route verifies `extraData` against an active, non-expired selection session (`EC-SPEC-05` §3.6).
- **C2C Order Validity & Known Rejection Codes**: C2C drop-off validity windows (page `7444`) are 5 calendar days for `UNIMARTC2C` (7-ELEVEN), 6 days for `FAMIC2C` (FamilyMart), and 7 days for `HILIFEC2C` (Hi-Life). Known `Express/Create` rejection codes (page `7426`) include `10500040` (goods amount out of range), `10500036` (receiver name length/format), `10500049` (insufficient ECPay balance), `10500066` (goods weight out of range), and `10500067` (POST return handling not configured in the ECPay merchant backend).
- **To Verify on ECPay Stage (Needs Ted's Authorisation)**:
  - Exact response when `Express/Create` is called with a duplicate `MerchantTradeNo`.
  - Exact `QueryLogisticsTradeInfo/V5` response format for an unknown order (`0|<message>` vs. signed form).
  - Exact C2C combined spelling of `LogisticsType` in `QueryLogisticsTradeInfo/V5` responses (e.g. `CVS_UNIMARTC2C` vs. `CVS_UNIMART`).
  - Character set and encoding behavior of `/Express/map` browser returns across chains.
  - Whether ECPay measures home-delivery address length (`7–60`) in Unicode code points, UTF-16 code units, or Big5/UTF-8 bytes.
  - Distinguishing HTTP `403` rate-limiting (calling too fast, wait 30 minutes) from an HTTP `403` / block page triggered by the CDN word filter.
  - Whether bare command words without shell characters (such as `echo` or `tftp` inside an ordinary name or URL) actually trip ECPay's live CDN filter.

## B2C e-invoice profile (`ecpay/b2c-invoice/`, `ecpay.invoice.b2c.v1`)

### Public Exports (`modules/agent-commerce/providers/ecpay/b2c-invoice/index.ts`)

- `ECPAY_B2C_INVOICE_PROFILE` / `ECPAY_B2C_INVOICE_PATHS` / `type EcpayInvoiceOperation`: Profile identifier `'ecpay.invoice.b2c.v1'` and frozen map of the fifteen `/B2CInvoice/*` endpoint paths.
- `EcpayJsonRequest` / `type RedactedJsonRequestJson`: Immutable server-to-server `POST` (`Content-Type: application/json`) request holder whose encrypted JSON body is stored in a module-private `WeakMap` and only exposed via `bodyText()` (`toJSON()`, `toString()`, and `util.inspect` redact the body).
- `isInvoiceEmail(value)`: Validates e-mail addresses (`<= 80` ASCII characters matching our strict subset of ECPay's `[7896]` pattern, one address only).
- `buildIssueInvoiceRequest` / `parseIssueInvoiceResponse`: Issue a B2C cloud e-invoice (`/B2CInvoice/Issue`, `[7896]`).
- `buildVoidWithReissueRequest` / `parseVoidWithReissueResponse`: Void and reissue an invoice in one call (`/B2CInvoice/VoidWithReIssue`, `[7918]`).
- `buildVoidInvoiceRequest` / `parseVoidInvoiceResponse`: Void an issued invoice (`/B2CInvoice/Invalid`, `[7906]`).
- `buildAllowanceRequest` / `parseAllowanceResponse`: Issue a paper/merchant-notified allowance (`/B2CInvoice/Allowance`, `[7901]`).
- `buildOnlineAllowanceRequest` / `parseOnlineAllowanceResponse`: Issue an online buyer-consent allowance (`/B2CInvoice/AllowanceByCollegiate`, `[15391]`).
- `buildVoidAllowanceRequest` / `parseVoidAllowanceResponse`: Void a finalized allowance (`/B2CInvoice/AllowanceInvalid`, `[7911]`).
- `buildCancelOnlineAllowanceRequest` / `parseCancelOnlineAllowanceResponse`: Cancel a pending or consented online allowance (`/B2CInvoice/AllowanceInvalidByCollegiate`, `[7913]`).
- `buildGetIssueRequest` / `parseGetIssueResponse`: Query an issued invoice by `RelateNumber` or by `InvoiceNo` + `InvoiceDate` (`/B2CInvoice/GetIssue`, `[7923]`).
- `buildGetAllowanceListRequest` / `parseGetAllowanceListResponse`: Query allowances by `AllowanceNo` (`SearchType="0"`), invoice issue date (`SearchType="1"`), or allowance date (`SearchType="2"`) (`/B2CInvoice/GetAllowanceList`, `[7928]`).
- `buildGetInvalidRequest` / `parseGetInvalidResponse`: Query a voided invoice (`/B2CInvoice/GetInvalid`, `[7933]`).
- `buildGetAllowanceInvalidRequest` / `parseGetAllowanceInvalidResponse`: Query a voided allowance (`/B2CInvoice/GetAllowanceInvalid`, `[7943]`).
- `buildCheckBarcodeRequest` / `parseCheckBarcodeResponse` / `classifyBarcodeCheck`: Check mobile carrier barcode validity (`/B2CInvoice/CheckBarcode`, `[7886]`).
- `buildCheckLoveCodeRequest` / `parseCheckLoveCodeResponse` / `classifyLoveCodeCheck`: Check donation love code validity (`/B2CInvoice/CheckLoveCode`, `[7891]`).
- `buildCompanyNameRequest` / `parseCompanyNameResponse` / `classifyCompanyNameCheck`: Query company registration name by 8-digit UBN (`/B2CInvoice/GetCompanyNameByTaxID`, `[32089]`).
- `buildWordSettingRequest` / `parseWordSettingResponse` / `wordTrackRemaining`: Query assigned invoice word tracks (`/B2CInvoice/GetInvoiceWordSetting`, `[7881]`) and compute remaining numbers on a track.
- `parseAllowanceConsentCallback(body, keys, options?)`: Verify and parse the MD5 form POST callback sent to `ReturnURL` when a buyer consents to an online allowance (`[15391]`; MD5 vector `[38242]`).
- `classifyInvoiceHttpStatus(status)`: Classify HTTP status codes (`200` → `'response'`, `403` → `'throttled'` `[7854]`, other `100..599` → `'unknown'`).

### Endpoint Table

Every operation is an HTTPS `POST` to `ECPAY_ORIGINS.invoice[environment] + ECPAY_B2C_INVOICE_PATHS[op]` with `Content-Type: application/json`:

| Operation (`op`) | Path | `Data` JSON keys in exact order |
| --- | --- | --- |
| `issue` | `/B2CInvoice/Issue` | `MerchantID`, `RelateNumber`, `CustomerID` (`""`), `CustomerIdentifier`, `CustomerName`, `CustomerAddr` (`""`), `CustomerPhone` (`""`), `CustomerEmail`, `Print` (`"0"`), `Donation`, `LoveCode`, `CarrierType`, `CarrierNum`, `TaxType` (`"1"`), `SalesAmount`, `InvoiceRemark`, `InvType` (`"07"`), `vat` (`"1"`), `Items` |
| `voidWithReissue` | `/B2CInvoice/VoidWithReIssue` | `MerchantID`, `VoidModel` (`{InvoiceNo, VoidReason}`), `IssueModel` (`{RelateNumber, InvoiceDate, CustomerID..Items}` — no `MerchantID` inside `IssueModel`) |
| `void` | `/B2CInvoice/Invalid` | `MerchantID`, `InvoiceNo`, `InvoiceDate` (`yyyy-MM-dd`), `Reason` |
| `allowance` | `/B2CInvoice/Allowance` | `MerchantID`, `InvoiceNo`, `InvoiceDate`, `AllowanceNotify` (`"E"`), `CustomerName`, `NotifyMail`, `NotifyPhone` (`""`), `AllowanceAmount`, `Items` |
| `onlineAllowance` | `/B2CInvoice/AllowanceByCollegiate` | `MerchantID`, `InvoiceNo`, `InvoiceDate`, `AllowanceNotify` (`"E"`), `CustomerName`, `NotifyMail`, `AllowanceAmount`, `Items`, `ReturnURL` |
| `voidAllowance` | `/B2CInvoice/AllowanceInvalid` | `MerchantID`, `InvoiceNo`, `AllowanceNo`, `Reason` |
| `cancelOnlineAllowance` | `/B2CInvoice/AllowanceInvalidByCollegiate` | `MerchantID`, `InvoiceNo`, `AllowanceNo`, `Reason` |
| `getIssue` | `/B2CInvoice/GetIssue` | `MerchantID`, `RelateNumber` — or `MerchantID`, `InvoiceNo`, `InvoiceDate` |
| `getAllowanceList` | `/B2CInvoice/GetAllowanceList` | `MerchantID`, `SearchType` (`"0"`), `AllowanceNo` — or `MerchantID`, `SearchType` (`"1"` or `"2"`), `InvoiceNo`, `Date` (`yyyy-MM-dd`) |
| `getInvalid` | `/B2CInvoice/GetInvalid` | `MerchantID`, `RelateNumber`, `InvoiceNo`, `InvoiceDate` |
| `getAllowanceInvalid` | `/B2CInvoice/GetAllowanceInvalid` | `MerchantID`, `InvoiceNo`, `AllowanceNo` |
| `checkBarcode` | `/B2CInvoice/CheckBarcode` | `MerchantID`, `BarCode` |
| `checkLoveCode` | `/B2CInvoice/CheckLoveCode` | `MerchantID`, `LoveCode` |
| `companyName` | `/B2CInvoice/GetCompanyNameByTaxID` | `MerchantID`, `UnifiedBusinessNo` |
| `wordSetting` | `/B2CInvoice/GetInvoiceWordSetting` | `MerchantID`, `InvoiceYear`, `InvoiceTerm`, `UseStatus`, `InvoiceCategory` (`1`), and `InvType` only when non-null |

### Protocol Rules & Design Rationale

- **Domain Boundary**: Invoice domain code must always call the builders and parsers in `ecpay/b2c-invoice/` rather than calling `invoice.buildEnvelope` or `invoice.openResponse` directly.
- **Request Body & CDN Whitespace Sealing (`sealInvoiceRequest`)**:
  - Each request body is `{"PlatformID":"","MerchantID":"<id>","RqHeader":{"Timestamp":<unix seconds>},"Data":"<base64>"}` with keys in that exact order and `MerchantID` always formatted as a string.
  - Because `AES-128-CBC` uses the merchant's fixed `HashIV`, the same `Data` plaintext always encrypts to the exact same Base64 ciphertext. A Base64 ciphertext can spell shell substrings blocked by ECPay's CDN (`cd/`, `echo`, `tftp`, etc., `[7400]`) by chance (~2.5% of issue requests), and a naive retry would produce the identical blocked ciphertext.
  - `sealInvoiceRequest` checks the full JSON request body with `findCdnBlockedTerm`. On attempt `0` it encrypts the plain `JSON.stringify(data)` output (identical to `encryptData(data, keys)`). If blocked, it retries for `n = 1..15` by inserting `n` ASCII spaces immediately after the opening `{` (`'{' + ' '.repeat(n) + json.slice(1)`), which is semantically identical JSON and alters the first 16-byte plaintext block so CBC cascades a completely different ciphertext across the entire `Data` string. After 16 blocked attempts it throws `EcpayProtocolError('invalid_input')`.
- **Result Kinds (`InvoiceCallResult<T>`) & Caller Semantics**:
  - `ok`: `TransCode == 1`, `RtnCode == 1`, and all required response fields and echo checks succeeded.
  - `not_accepted`: ECPay transport-level rejection (`TransCode != 1`); ECPay did not accept the request envelope.
  - `rejected`: ECPay business rejection (`TransCode == 1` and `RtnCode != 1`); ECPay processed the request and said no.
  - `unknown`: Unparseable JSON, merchant mismatch, Base64/AES/URL-decode failure, missing or malformed required field, or echoed identifier mismatch (`invoice_no_mismatch`, `relate_number_mismatch`, `allowance_no_mismatch`). Callers must **not** assume the operation succeeded or failed — always query first (`GetIssue`, `GetAllowanceList`, `GetInvalid`, `GetAllowanceInvalid`) before retrying.
  - `classifyInvoiceHttpStatus(status)`: HTTP `200` carries a response body (`'response'`); HTTP `403` means throttled ("called too often, pause 30 minutes", `[7854]`, `'throttled'`); any other status in `100..599` carries no trustworthy body (`'unknown'`).
- **Buyer Mapping (`Print` is always `"0"`)**:

  | Buyer `type` | `CustomerIdentifier` | `CustomerName` | `Donation` | `LoveCode` | `CarrierType` | `CarrierNum` |
  | --- | --- | --- | --- | --- | --- | --- |
  | `member_carrier` | `""` | `""` | `"0"` | `""` | `"1"` | `""` |
  | `mobile_barcode` | `""` | `""` | `"0"` | `""` | `"3"` | barcode (`^\/[0-9A-Z+\-.]{7}$`) |
  | `citizen_cert` | `""` | `""` | `"0"` | `""` | `"2"` | certificate (`^[A-Z]{2}[0-9]{14}$`) |
  | `donation` | `""` | `""` | `"1"` | love code (`^[0-9]{3,7}$`) | `""` | `""` |
  | `company` (no barcode) | ubn (`^[0-9]{8}$`) | title (`1..60` code points) | `"0"` | `""` | `"1"` | `""` |
  | `company` (with barcode) | ubn (`^[0-9]{8}$`) | title (`1..60` code points) | `"0"` | `""` | `"3"` | barcode (`^\/[0-9A-Z+\-.]{7}$`) |

- **Item Rules & Omitted Fields**:
  - `Items` (for `issue`, `voidWithReissue`, `allowance`, and `onlineAllowance`) has 1..200 entries serialized with exact key order `{ItemSeq, ItemName, ItemCount, ItemWord, ItemPrice, ItemAmount}` where `ItemSeq` starts at `1`, `ItemCount` is `1..99`, and `ItemPrice`, `ItemAmount`, `SalesAmount`, and `AllowanceAmount` are whole-TWD JSON numbers (`minor / 100`, `amountMinor === count * priceMinor`, sum of `amountMinor` equals the total).
  - Builders never send `ClearanceMark`, `TaxAmount`, `ItemTaxType`, `ItemRemark`, a `Reason` field on allowances, `ProductServiceId`, or `InvoiceHeader`.
- **Void-With-Reissue (`[7918]`)**:
  - `buildVoidWithReissueRequest` nests `VoidModel: { InvoiceNo, VoidReason }` and `IssueModel: { RelateNumber, InvoiceDate, ... }` without `MerchantID` inside `IssueModel`. `RelateNumber` and `InvoiceDate` (`yyyy-MM-dd HH:mm:ss`) are the **original** invoice's values (`[7918]`). `parseVoidWithReissueResponse` does not enforce an `InvoiceNo` echo check so the domain layer can compare whether ECPay kept the original number.
- **Allowlisted Results, Dropped PII, & `rtnMsg`/`transMsg` Hygiene**:
  - Response parsers copy only allowlisted status, number, timestamp, and amount fields into frozen result objects.
  - Every buyer PII and network field returned by ECPay is dropped and never returned, stored, or logged: `GetIssue` drops `IIS_Customer_Name`, `IIS_Customer_Email`, `IIS_Customer_Addr`, `IIS_Customer_Phone`, `IIS_Identifier`, `IIS_Carrier_Num`, `IIS_Love_Code`, `IIS_IP`, item lines, and QR data; `GetAllowanceList` drops `IA_Send_Mail`, `IA_Send_Phone`, `IIS_Customer_Name`, `IA_IP`, `IA_Identifier`, and item lines (note that pending online allowances are not listed in `GetAllowanceList`, `[7928]`); `GetInvalid` and `GetAllowanceInvalid` drop `II_Buyer_Identifier` and `AI_Buyer_Identifier`; `parseAllowanceConsentCallback` drops `RtnMsg`.
  - Because `rtnMsg` and `transMsg` are ECPay free text and may echo buyer request values (such as e-mail, carrier number, or UBN), callers must treat `rtnMsg` and `transMsg` as buyer data and **never log them**.
- **Online Allowance Consent Callback (`[15391]`, MD5 vector `[38242]`)**:
  - `parseAllowanceConsentCallback` verifies the MD5 `CheckMacValue` via `invoice.verifyAllowanceCallback`, requires `RtnCode === '1'` (ECPay only notifies buyer consent; any other value returns `unexpected_rtn_code`), requires `IA_Allow_No` and `IA_Invoice_No`, parses optional `IA_Date` and `IIS_Remain_Allowance_Amt` (falling back to `null` if absent or unparseable), and computes `bodySha256`.
  - The callback payload carries no `MerchantID`; the platform identifies the merchant account from the callback URL path and replies with `1|OK` (`ECPAY_ACK`) only after committing.
- **Lookup Classifiers & Company-Name Stop Codes (`[32089]`)**:
  - `classifyBarcodeCheck` and `classifyLoveCodeCheck` map `ok` (`exists: true` / `false`) to `'valid'` or `'invalid'` and any other result to `'indeterminate'`.
  - `classifyCompanyNameCheck` maps `ok` to `{ kind: 'found', companyName }`, maps `rejected` with `rtnCode` `'1200125'` (invalid UBN checksum) or `'2027000'` (invalid UBN length) to `{ kind: 'invalid_ubn' }` (hard stop), and maps every other outcome (including `'7'` "not registered but checksum valid" and `'9000001'` "MOF system error", `[32089]`) to `{ kind: 'indeterminate' }` (do not block issuance).
- **Word Tracks (`[7881]`) & `wordTrackRemaining`**:
  - `parseWordSettingResponse` accepts `InvoiceInfo` as either a JSON array or a single object (because the official example in `[7881]` is malformed), accepts `InvoiceTerm` and `UseStatus` (`1..6`) as JSON numbers or digit strings, and maps missing or empty `InvoiceNo` to `lastUsed: null`.
  - `wordTrackRemaining(track)` returns `Number(end) - Number(lastUsed)` when `lastUsed` is non-null and within `start..end`, or `null` otherwise.
- **Unverified Until ECPay Stage**:
  - Whether ECPay accepts leading JSON whitespace inside decrypted `Data`.
  - Whether the `einvoice` CDN filters Base64 ciphertexts inside JSON request bodies at all.
  - Whether `MerchantID` sent as a JSON string is accepted across all fifteen endpoints.
  - Whether empty `CustomerName` and `NotifyPhone` strings are accepted on `Allowance` and `AllowanceByCollegiate`.
  - The exact JSON type of `MerchantID` in ECPay response envelopes.
  - Whether `VoidWithReIssue` always retains the original `InvoiceNo`.
  - The exact `RtnCode` returned by `GetIssue` when an invoice is not found.
  - What `GetInvoiceWordSetting` returns in `InvoiceNo` before the first number of a track is used, and whether `InvoiceInfo` is always an array or sometimes a single object.
  - Whether response date-times ever use `/` separators (`yyyy/MM/dd HH:mm:ss`) instead of `-` (`yyyy-MM-dd HH:mm:ss`).
  - Whether `ItemName` length limits are enforced in Unicode code points, UTF-16 code units, or bytes, and how emoji are handled.
  - Which request fields `RtnMsg` and `TransMsg` may echo on errors.

## Node and `workerd` Parity Verification

- `tests/runtime/ecpay-protocol.test.ts`, `tests/runtime/ecpay-aio-credit.test.ts`, `tests/runtime/ecpay-domestic-logistics.test.ts`, and `tests/runtime/ecpay-b2c-invoice.test.ts` run all official and golden test vectors from `tests/worker/ecpay-fixtures/` plus negative, boundary, key-rotation, prototype-pollution, CDN word-guard, PII-stripping, and redaction checks under Node (`node:test`). All `aio-credit`, `domestic-logistics`, and `b2c-invoice` golden vectors were computed independently outside the repository from the official SHA-256, MD5, and AES-128-CBC rules (pages `2902`/`2904`, `7424`, `7418`, `7958`, `38406`).
- `tests/worker/ecpay-protocol-workerd.test.ts`, `tests/worker/ecpay-aio-credit-workerd.test.ts`, `tests/worker/ecpay-domestic-logistics-workerd.test.ts`, and `tests/worker/ecpay-b2c-invoice-workerd.test.ts` bundle `protocol-worker.ts`, `aio-credit-worker.ts`, `domestic-logistics-worker.ts`, and `b2c-invoice-worker.ts` with `esbuild` (`platform: 'neutral'`, `external: ['node:*']`), execute every vector, golden, parser outcome, refund cell, weight rule, word-track helper, lookup classifier, profile descriptor, and CDN guard vector inside Cloudflare `workerd` via Miniflare (`nodejs_compat`), and assert bit-for-bit equality against both the expected vector constants and the Node results.
