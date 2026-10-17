import { escapeHtml } from '../../../packages/shared/html.js';

export interface StorefrontStoreHeading {
  slug: string;
  name: string;
}

function storefrontShell(store: StorefrontStoreHeading, title: string, content: string, includeScript = false): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  const script = includeScript ? '<script type="module" src="/assets/storefront.js"></script>' : '';
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light"><title>${escapeHtml(title)}</title><link rel="stylesheet" href="/shops.css">${script}</head><body><a class="shop-skip-link" href="#main">跳到主要內容</a><header class="shop-top"><a href="/" aria-label="返回自由工坊"><img class="shop-logo" src="/brand/freedom-workshop.webp" alt="自由工坊" width="1280" height="720"></a><a class="shop-top-store" href="/shops/${slug}">${name}</a></header><main id="main" tabindex="-1">${content}</main><footer class="shop-footer"><p>這間店使用自由工坊開店。</p></footer></body></html>`;
}

export function cartPageHtml(store: StorefrontStoreHeading): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  return storefrontShell(
    store,
    `購物車｜${store.name}｜自由工坊`,
    `<section class="shop-cart" id="shop-cart" data-store-slug="${slug}" data-store-name="${name}" aria-labelledby="shop-cart-title" aria-busy="true"><h1 id="shop-cart-title" tabindex="-1">購物車</h1><p role="status">正在讀取購物車…</p><noscript><p>使用購物車需要開啟瀏覽器的 JavaScript。</p></noscript></section>`,
    true,
  );
}

export function checkoutPageHtml(store: StorefrontStoreHeading): string {
  return storefrontShell(store, `結帳｜${store.name}｜自由工坊`,
    `<section class="shop-order" id="shop-checkout" data-store-slug="${escapeHtml(store.slug)}" data-store-name="${escapeHtml(store.name)}" aria-labelledby="shop-checkout-title" aria-busy="true"><h1 id="shop-checkout-title" tabindex="-1">結帳</h1><p role="status">正在讀取購物車…</p><noscript><p>結帳需要開啟瀏覽器的 JavaScript。</p></noscript></section>`, true);
}

export function orderPageHtml(
  store: StorefrontStoreHeading,
  orderRef: string,
  options: { emailEnabled?: boolean } = {},
): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  const ref = escapeHtml(orderRef);
  const emailEnabled = options.emailEnabled === true ? 'true' : 'false';
  return storefrontShell(
    store,
    `訂單｜${store.name}｜自由工坊`,
    `<section class="shop-order" id="shop-order" data-store-slug="${slug}" data-store-name="${name}" data-order-ref="${ref}" data-email-enabled="${emailEnabled}" aria-labelledby="shop-order-title" aria-busy="true"><h1 id="shop-order-title">訂單</h1><p role="status">正在讀取訂單…</p><noscript><p>查看訂單需要開啟瀏覽器的 JavaScript。</p></noscript></section>`,
    true,
  );
}

export function orderMissingHtml(store: StorefrontStoreHeading): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  return storefrontShell(
    store,
    `找不到這筆訂單｜${store.name}｜自由工坊`,
    `<section class="shop-order"><h1>找不到這筆訂單</h1><p role="status">這個瀏覽器沒有這筆訂單的查看權限，或訂單不存在。訂單只能在下單時使用的瀏覽器，或以下單時登入的會員帳號查看。</p><div class="shop-order-actions"><a href="/shops/${slug}/order-access">找回訂單</a><a href="/shops/${slug}">回到「${name}」</a></div></section>`,
  );
}

export function orderAccessPageHtml(
  store: StorefrontStoreHeading,
  options: { emailEnabled?: boolean } = {},
): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  if (options.emailEnabled === true) {
    return storefrontShell(
      store,
      `找回訂單｜${store.name}｜自由工坊`,
      `<section class="shop-order" id="shop-order-access" data-store-slug="${slug}" data-store-name="${name}" aria-labelledby="shop-order-access-title" aria-busy="false"><h1 id="shop-order-access-title" tabindex="-1">找回訂單</h1><p>輸入下單時填寫的 Email 與訂單編號（例如 261015-ABCDEF），我們會把一次性查看連結寄到你的信箱。</p><form class="shop-order-section" method="post" novalidate><div class="shop-order-access-field"><label class="shop-add-label" for="shop-order-access-email">Email</label><input id="shop-order-access-email" class="shop-text-input" name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" required></div><div class="shop-order-access-field"><label class="shop-add-label" for="shop-order-access-display-number">訂單編號</label><input id="shop-order-access-display-number" class="shop-text-input" name="display_number" type="text" autocomplete="off" maxlength="80" placeholder="261015-ABCDEF" required></div><div class="shop-order-actions"><button type="submit" class="shop-button shop-pay-primary" disabled>寄送查看連結</button><a href="/shops/${slug}">回到「${name}」</a></div></form><noscript><p>寄送查看連結需要開啟瀏覽器的 JavaScript。</p></noscript></section>`,
      true,
    );
  }
  return storefrontShell(
    store,
    `找回訂單｜${store.name}｜自由工坊`,
    `<section class="shop-order"><h1>找回訂單</h1><p>這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。</p><div class="shop-order-actions"><a href="/shops/${slug}">回到「${name}」</a></div></section>`,
  );
}

export function paymentReturnPageHtml(store: StorefrontStoreHeading, orderRef: string, attemptRef: string): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  const ref = escapeHtml(orderRef);
  const attempt = escapeHtml(attemptRef);
  return storefrontShell(
    store,
    `付款結果｜${store.name}｜自由工坊`,
    `<section class="shop-pay-return" id="shop-pay-return" data-store-slug="${slug}" data-store-name="${name}" data-order-ref="${ref}" data-attempt-ref="${attempt}" aria-labelledby="shop-pay-return-title" aria-busy="true"><h1 id="shop-pay-return-title" tabindex="-1">付款結果確認中</h1><p role="status">正在向付款服務確認結果…</p><noscript><p>確認付款結果需要開啟瀏覽器的 JavaScript。</p><p><a href="/shops/${slug}/orders/${ref}">查看訂單</a></p></noscript></section>`,
    true,
  );
}

export function paymentReturnMissingHtml(store: StorefrontStoreHeading): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  return storefrontShell(
    store,
    `找不到這次付款｜${store.name}｜自由工坊`,
    `<section class="shop-order"><h1>找不到這次付款</h1><p role="status">這個付款連結不屬於這間商店，或已經失效。</p><div class="shop-order-actions"><a href="/shops/${slug}/order-access">找回訂單</a><a href="/shops/${slug}">回到「${name}」</a></div></section>`,
  );
}
