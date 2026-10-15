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

export function orderPageHtml(store: StorefrontStoreHeading, orderRef: string): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  const ref = escapeHtml(orderRef);
  return storefrontShell(
    store,
    `訂單｜${store.name}｜自由工坊`,
    `<section class="shop-order" id="shop-order" data-store-slug="${slug}" data-store-name="${name}" data-order-ref="${ref}" aria-labelledby="shop-order-title" aria-busy="true"><h1 id="shop-order-title">訂單</h1><p role="status">正在讀取訂單…</p><noscript><p>查看訂單需要開啟瀏覽器的 JavaScript。</p></noscript></section>`,
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

export function orderAccessPageHtml(store: StorefrontStoreHeading): string {
  const slug = escapeHtml(store.slug);
  const name = escapeHtml(store.name);
  return storefrontShell(
    store,
    `找回訂單｜${store.name}｜自由工坊`,
    `<section class="shop-order"><h1>找回訂單</h1><p>這間店目前不寄確認信，請用這個瀏覽器回到訂單，或聯絡店家。</p><div class="shop-order-actions"><a href="/shops/${slug}">回到「${name}」</a></div></section>`,
  );
}
