# Commerce upstream evaluation — 2026-09-23

Inspected public default-branch source and licenses, without running upstream
installers, application code, provider calls or payment actions. These are
reference candidates, not claims of sandbox/provider certification. No upstream
source code is copied into this implementation.

| Repository / inspected commit | Evidence and fit | Decision |
| --- | --- | --- |
| [amicalhq/refref](https://github.com/amicalhq/refref/tree/81af934fec3b20990a4d9af7ed472d0d14d73a82), last commit 2026-03-20 | AGPL-3.0. Next.js/React, Fastify, PostgreSQL/Drizzle. [`coredb/schema.ts`](https://github.com/amicalhq/refref/blob/81af934fec3b20990a4d9af7ed472d0d14d73a82/packages/coredb/src/schema.ts) models programs, participants, referrals, reward rules and rewards. Its `product` is a referral-program owner's app/business, not physical SKU/supply inventory. | Reference referral attribution and campaign UX for marketing. Do not adopt as supplier system or copy its auth/reward ledger into central commerce. |
| [tw-ecommerce-majordomo](https://github.com/asgard-ai-platform/tw-ecommerce-majordomo/tree/5dbab0cb341a7e113d0d51fbc6463b1a12481ece), last commit 2026-05-28 | MIT. Agent plugin with 29 skills and 12 MCP declarations. [`mcp.json`](https://github.com/asgard-ai-platform/tw-ecommerce-majordomo/blob/5dbab0cb341a7e113d0d51fbc6463b1a12481ece/mcp.json) launches other repositories through `uvx`, pointing at `main`; some services are private. Not a storefront/order backend. | Operations knowledge and future provider adapter discovery. Audit and pin individual providers before use; do not install the entire bundle into privileged runtime. |
| [taiwan-ecommerce-toolkit](https://github.com/Moksa1123/taiwan-ecommerce-toolkit/tree/6a0d253f76ea458231324c9752f9649ad1d795f6), last commit 2026-08-18 | MIT. TypeScript skill-install CLIs, CSV provider catalogs, Python search/recommendation tools and payment/logistics/invoice examples. [`payment-cli/package.json`](https://github.com/Moksa1123/taiwan-ecommerce-toolkit/blob/6a0d253f76ea458231324c9752f9649ad1d795f6/payment-cli/package.json) identifies a CLI; its npm test is the CLI help command. README's provider counts differ between sections. | Useful Taiwan integration references/examples, not an independently verified production SDK or retail platform. Validate each selected provider against official documentation and its sandbox. |
| [golershop](https://github.com/shsuishang/golershop/tree/8ef598e21c2a0f7d54a6745b5c8f4a009294a183), last commit 2026-05-18 | LGPL-3.0 LICENSE; README also describes copyright/commercial usage terms. Go 1.24/GoFrame, MySQL/Redis; separate Vue/UniApp interfaces. [`pay/consume_trade.go`](https://github.com/shsuishang/golershop/blob/8ef598e21c2a0f7d54a6745b5c8f4a009294a183/internal/logic/pay/consume_trade.go) debits/credits user-money balances; deposit/withdrawal code exists. No tracked `*_test.go` in inspected snapshot. | Reference SKU, catalog, logistics and order-management flows. Do not fork as Freedom's canonical core: wallets and stack/schema assumptions conflict with Seller-owned money and one PostgreSQL truth. License verification would be required before code reuse. |
| [line-bot-sdk-nodejs](https://github.com/line/line-bot-sdk-nodejs/tree/e4e2128ddf259d638ebd066cb0ad2b8704b62faf), last commit 2026-09-22 | Official Apache-2.0 TypeScript SDK. Inspected branch requires Node >=22; includes Messaging API, webhook models and raw-body HMAC verification. [`validate-signature.ts`](https://github.com/line/line-bot-sdk-nodejs/blob/e4e2128ddf259d638ebd066cb0ad2b8704b62faf/lib/validate-signature.ts) uses timing-safe comparison. | Preferred future LINE notification/webhook adapter. It is not commerce or LINE Pay. Pin a released package and check Workers compatibility before adoption. |

Dates above come from GitHub commit metadata at inspection; all five repositories
were unarchived. Recent commits alone are not evidence of production correctness.

## Implementation decision

Keep the modular monolith and central PostgreSQL from
[architecture §2–4](../../platform-plan/02-architecture-repositories.md) and
[module specifications §3–4](../../platform-plan/04-module-specifications.md).
Supplier and seller are separate product experiences using one membership.

The first working internal flow is:

1. Supplier submits a physical Product and immutable SupplierOfferVersion:
   photo, specification, net price, declared stock/unknown stock, delivery and
   return terms. Quality remains `unreviewed`.
2. Seller creates a Store and picks an exact supply version. Each immutable
   listing snapshot fixes actual price, seller, store and supply terms.
3. Seller sends that snapshot for supply confirmation; the supplier can accept
   or decline only the matching digest. Both screens read the same persisted
   decision. New prices require a new draft, not mutation of accepted history.
4. This iteration explicitly uses `internal_preview` confirmation. It does not
   claim canonical production A4, a signed DistributionAgreement, official QC,
   sellability, an order, payment or supplier payout.

Before real commerce, add Party/organization ownership, exact signed
DistributionAgreement and DistributionAcceptance, scoped QC evidence,
Seller-owned collection, inventory reservations, buyer/supply orders and verified
payment facts. The default remains `record_only` and platform money movement
disabled. A Store and checkout bind one Seller even with multiple Suppliers.

Auth, session/CSRF, command receipts, atomic PostgreSQL transactions, version
checks and the transition journal are shared with the existing core. Commerce
does not create its own users, wallet or authentication database. Module tables
have explicit community and owner scopes. Immutable supply/listing snapshots are
also protected at the database layer.
