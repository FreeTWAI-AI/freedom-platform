import type { PublicStoreProjection } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { StoreTemplateSchema, type StoreTemplate } from '../../../contracts/guild-launchpad/v1/storefront-presentation.js';
import { escapeHtml } from '../../development/service.js';
import { formatMinor } from './format.js';

function paragraphs(text: string) {
  return text.split(/\n+/).filter(p => p.trim()).map(p => `<p>${escapeHtml(p.trim())}</p>`).join('');
}
function shell(name: string, description: string, content: string) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(name)}｜自由工坊</title><meta name="description" content="${escapeHtml(description)}"><link rel="stylesheet" href="/shops.css"></head><body><header class="shop-top"><a href="/"><img class="shop-logo" src="/brand/freedom-workshop.webp" alt="自由工坊" width="1280" height="720"></a></header><main>${content}</main></body></html>`;
}
export function storeHtml(store: PublicStoreProjection, template: StoreTemplate = 'catalog-grid-v1') {
  const list = StoreTemplateSchema.parse(template) === 'catalog-list-v1';
  const items = store.products.map(p => `<li><article><h3>${escapeHtml(p.title)}</h3><p class="shop-price">${escapeHtml(formatMinor(p.price_minor, store.currency))}</p>${paragraphs(p.description)}</article></li>`).join('');
  return shell(store.name, store.description, `<p class="shop-notice" role="note">商品展示頁不提供付款或出貨；預留狀態請登入查看。</p><div class="shop-actions"><a href="/#reservations/${encodeURIComponent(store.slug)}">登入查看預留狀態</a> · <a href="/#reservations">查詢我的預留</a></div><h1>${escapeHtml(store.name)}</h1>${store.brand ? `<p class="shop-brand">${escapeHtml(store.brand)}</p>` : ''}${paragraphs(store.description)}<section aria-labelledby="products"><h2 id="products">商品</h2><ul class="shop-products${list ? ' shop-products-list' : ''}">${items}</ul></section>`);
}
export function storeMissingHtml() {
  return shell('找不到這間商店', '這間商店目前沒有公開。', '<h1>找不到這間商店</h1><p>這間商店目前沒有公開。</p>');
}
