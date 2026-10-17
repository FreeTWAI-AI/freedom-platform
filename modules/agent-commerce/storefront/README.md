# Commerce storefront buyer pages

Buyer pages under `/shops/:slug` that need browser code, and the storefront
client bundle they share (EC-SPEC-01 §3, EC-SPEC-02 §4.2 and §6).

- Server HTML for these pages lives in this directory. The routes stay in
  `apps/platform-api/src/routes/hosted-store.ts` next to the other `/shops`
  pages.
- The client entry lives in `apps/portal-web/src/storefront/`. Vite emits it
  under the fixed name `assets/storefront.js`, which is served `no-store` like
  the other fixed-name files. It uses only the `shop-` styles in `/shops.css`
  and never loads the portal app, themes, navigation or chat.
- Orders are read only through the public checkout API (`hosted-checkout`).
  The pages show no data that the API did not return.
- Before Ted authorises `FREEDOM_COMMERCE_EMAIL_ENABLED`, B10 shows the
  EC-SPEC-10 §6.2 explanation and collects no Email.

Status: `pages.ts` renders the B04 cart shell (`cartPageHtml`), the B05 checkout
shell (`checkoutPageHtml`), the B07 order
shell (`orderPageHtml`), the 404 order-missing page (`orderMissingHtml`), the
B10 order-access guidance page (`orderAccessPageHtml`), the B06 payment return
shell (`paymentReturnPageHtml`) and the 404 payment-return-missing page
(`paymentReturnMissingHtml`);
`apps/portal-web/src/storefront/main.tsx`, `payment-view.ts` and `cart-store.ts`
persist per-store browser carts, sync the B01/B03 header cart count and live
announcer, mount `#shop-add-to-cart` with the B03 modal cart sheet, mount
`#shop-cart` to price the B04 cart via
`POST /api/v1/public/stores/:slug/cart-quotes`, mount `#shop-order` (B07) to
redeem one-time links, display order/payment state (`需要你處理` and `付款`),
start or resume payment via `POST …/payment-handoffs`, query payment results via
`POST …/payment-queries` and forget browser device access, and mount
`#shop-pay-return` (B06) to poll the order for up to two minutes after a
provider browser return and render the payment outcome without exposing contact
data, line items or amounts.

`checkout-page.tsx` freezes server quotes before placing an order, displays
server payment availability, and supports offline payments with meetup pickup.
CVS store selection and invoice fields remain pending their provider workflows.
The checkout key and contact values stay in memory. A placement stores only its
checkout reference, terms hash, payment method and client order ID in tab session
storage before sending, so a lost response or refresh can retry the same intent.
Recovered intents retain the current cart because its original contents are not
persisted with the intent; another tab may have prepared a newer purchase.
No bank instructions or contact data are persisted in browser storage.
`offline-order.tsx` displays authorized, frozen bank/meetup instructions, seller
confirmation and deadlines, and offers refresh and buyer cancellation. It never
starts a payment attempt. An optional `meetup_notes` order field supplies public
notes from the frozen shipping groups, rather than current merchant settings.
