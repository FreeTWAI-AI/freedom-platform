# Freedom Commerce Invoices (`commerce-invoices`)

This module provides the pure, I/O-free domain rule functions for Freedom Commerce electronic invoices (統一發票, Taiwan e-invoice), following EC-SPEC-06 §3.3, §3.5, and §3.7.

The module depends on `commerce-providers` only for the shared invoice email rule (`isInvoiceEmail`), which `ecpayBuyerFields` uses.

## Scope & Status

### What exists now
- Pure rule functions and TypeScript types under `rules/` (`errors.ts`, `ubn.ts`, `buyer.ts`, `items.ts`, `period.ts`, `corrections.ts`, `index.ts`).
- Deterministic calculation, validation, and correction suggestion logic with no side-effects, no network, no database, no environment or clock reads.

### What does not yet exist (deferred to future milestones)
- Database tables and migrations (e.g. `commerce_invoice_settings`, `commerce_invoice_documents`, `commerce_invoice_allowances`, `commerce_invoice_events`).
- HTTP routes and provider callbacks (seller invoice management, checkout buyer inputs, callback endpoints).
- ECPay API client integrations (AES encryption/decryption, HTTP requests to ECPay B2C invoice endpoints).
- Notification delivery (email/SMS dispatch for invoice issuance and allowance agreement links).

## Money Unit Rule

All monetary amounts are represented as an integer number of **minor units** (`100 minor = NT$1`).
Every money input (`netMinor`, `feeMinor`, `amountMinor`, `cumulativeAppliedMinor`, etc.) must be a non-negative safe integer and an exact multiple of 100 (representing whole NT$). Fractional NT$ amounts are strictly rejected with `InvoiceRuleError` (`invalid_input`).
Outputs intended for ECPay (`ItemPrice`, `ItemAmount`, `SalesAmount`, `AllowanceAmount`) are converted to whole NT$ integers (`minor / 100`).

## Unified Business Number (UBN / 統一編號)

- Source: 財政部財政資訊中心「營利事業統一編號檢查碼邏輯修正說明」 (<https://www.fia.gov.tw/singlehtml/3?cntId=c4d9cff38c8642ef8872774ee9987283>).
- Divisor change: Effective 2023-04-01 (112年4月1日), the modulus divisor changed from 10 to 5.
- Verification note: The digit weights `[1, 2, 1, 2, 1, 2, 4, 1]` and the 7th-digit rule (when the 7th digit is 7, `(S + 1) % 5 === 0` is also accepted) reflect the long-standing rule from the attachment of the document; **verify against the MOF attachment before release**. ECPay also performs validation on issuance (RtnCode `1200125`).

## Void Deadline & Periods

Invoices belong to two-month bimonthly periods (1–2月, 3–4月, 5–6月, 7–8月, 9–10月, 11–12月) based on Taiwan local time (UTC+08:00).
- Statutory void deadline (`voidDeadline`): 23:59:59 Taiwan time on the 13th day of the month immediately following the period (e.g., 1–2月 period deadline is March 13 23:59:59 Taiwan time; 11–12月 period deadline is January 13 of the following year 23:59:59 Taiwan time).
- Platform safety deadline (`platformVoidDeadline`): `voidDeadline - 2 hours` (buffer for clock skew, network latency, and approval processing).

ECPay Developer Documentation Sources:
- Issue API (`B2CInvoice/Issue`): <https://developers.ecpay.com.tw/7896/>
- Carrier / B2C Issue Specs: <https://developers.ecpay.com.tw/53662/>
- Allowance API (`Allowance`): <https://developers.ecpay.com.tw/7901/>
- Void API (`InvoiceInvalid`): <https://developers.ecpay.com.tw/7906/>
- Void Allowance API (`AllowanceInvalid`): <https://developers.ecpay.com.tw/7911/>
- Void With Re-issue API (`VoidWithReIssue`): <https://developers.ecpay.com.tw/7918/>

## Correction Suggestions & Reason Codes

`suggestInvoiceCorrection` evaluates the state of an issued invoice and refund facts to suggest the appropriate correction action (`void`, `void_and_reissue_new`, `allowance`, or `manual`).

| Suggestion / State | Reason Code | Description |
| --- | --- | --- |
| `none` | `unapplied_refund` | Refund is unapplied payment, which does not affect the invoice. |
| `none` | `invoice_not_issued` | Store mode is `not_issued`; no invoice was issued. |
| `none` | `invoice_failed` | Invoice issuance failed; correction is not applicable. |
| `none` | `invoice_voided` | Invoice has already been voided. |
| `wait` | `invoice_pending` | Invoice status is `queued`, `issuing`, or `unknown`; awaiting issuance resolution. |
| `wait` | `correction_in_progress` | Another correction is currently active on the invoice. |
| `suggest` (`manual`) | `manual_record` | Store mode is `manual_record` or invoice is in `recorded` status; manual out-of-band handling required. |
| `suggest` (`void`) | `full_refund_within_deadline` | Full refund within platform void deadline without unvoided allowances. |
| `suggest` (`void_and_reissue_new`) | `donation_partial_refund_within_deadline` | Donation invoice partial refund within platform void deadline. |
| `suggest` (`void_and_reissue_new`) | `preference_void_reissue_within_deadline` | Partial refund where store preference is void and reissue, within deadline. |
| `suggest` (`void_and_reissue_new`) | `allowance_impossible_void_reissue` | Partial refund where allowance is impossible, fallback to void and reissue within deadline. |
| `suggest` (`allowance`) | `full_refund_void_expired_allowance` | Full refund where void is not allowed (past deadline or unvoided allowances exist), but allowance is possible. |
| `suggest` (`allowance`) | `preference_allowance` | Partial refund where allowance is preferred and possible. |
| `suggest` (`allowance`) | `void_expired_allowance` | Partial refund where void and reissue was preferred but void is not allowed, falling back to allowance. |
| `suggest` (`manual`) | `donation_void_expired_manual` | Donation invoice partial refund past void deadline (donation invoices cannot issue allowances). |
| `suggest` (`manual`) | `no_automated_correction_available` | Neither void nor allowance is possible (e.g. past deadline and 50 allowances reached or pending allowance exists). |

## Public Exports

- `InvoiceRuleError`: Error thrown for invalid input; exposes `code: 'invalid_input'` with a fixed message.
- `assertMinorMoney(minor)`: Validates that an amount is a non-negative safe integer multiple of 100.
- `isValidUbn(value)`: Validates Taiwan Unified Business Number checksum under the 2023 divisor-5 logic.
- `normalizeInvoiceBuyer(input)`: Validates, normalises (NFKC, trimmed, uppercase codes), and strips disallowed fields for buyer invoice data.
- `ecpayBuyerFields(buyer, customerEmail)`: Generates exact ECPay B2C issue fields (`CustomerIdentifier`, `CustomerName`, `CarrierType`, `CarrierNum`, `Print`, `Donation`, `LoveCode`, `CustomerEmail`), validating customer email using the shared email rule from `commerce-providers`.
- `itemName(productName, variantLabel?, suffix?)`: Builds and truncates item names to 100 Unicode code points, keeping suffix intact.
- `splitUnits(amountMinor, quantity)`: Splits whole NT$ line totals into unit prices with integer NT$ rounding remainder.
- `invoiceItems(input)`: Converts order lines and shipping groups into 1–50 invoice items with whole NT$ sales totals.
- `allowanceItems(input)`: Converts refund lines into up to 200 allowance items (item split, price-only, shipping).
- `toEcpayItems(items, itemWord)`: Converts invoice/allowance items to ECPay row format (`ItemSeq`, `ItemName`, `ItemCount`, `ItemWord`, `ItemPrice`, `ItemAmount`).
- `ntdFromMinor(minor)`: Converts minor units into integer NT$ for ECPay `SalesAmount`/`AllowanceAmount`.
- `invoiceRemark(displayNumber)`: Formats standard invoice remark (`訂單 {displayNumber}`).
- `parseEcpayDateTime(value)`: Strictly parses ECPay Taiwan local time string into a UTC `Date`, requiring a single separator (`-` or `/`) and a year in the 2000–2099 range.
- `invoicePeriod(at)`: Determines the two-month period `{ year, startMonth }` for a given timestamp in Taiwan time.
- `voidDeadline(invoiceAt)`: Calculates statutory void deadline (23:59:59 Taiwan time on 13th of month after period).
- `platformVoidDeadline(invoiceAt)`: Calculates platform safety deadline (`voidDeadline - 2 hours`).
- `suggestInvoiceCorrection(invoice, refund, preference, now)`: Deterministically suggests correction action, alternatives, deadline, upload requirements, and urgency flag.
- `canVoidWithReissue(invoice, now)`: Checks whether an issued invoice can undergo VoidWithReIssue for buyer data corrections with unchanged amount; requires the invoice to be uploaded and requested within 46 hours of issue (source: https://support.ecpay.com.tw/6906/).
