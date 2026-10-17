import { PrivateProductPhotoSchema, PublicProductPhotoSchema, ProductPhotoSkuSchema } from '../../../contracts/guild-launchpad/v1/hosted-store-media.js';
import { DistributionPhotoItemSchema } from '../../../contracts/guild-launchpad/v1/supplier-console.js';
import type { PublicStoreProjection } from '../../../contracts/guild-launchpad/v1/storefront.js';
import { StoreTemplateSchema, type StoreTemplate } from '../../../contracts/guild-launchpad/v1/storefront-presentation.js';
import { escapeHtml as escape } from '../../../packages/shared/html.js';
import { formatMinor } from './format.js';

type Media = readonly {sku: string; photo: unknown | null}[];
const DistributionPhotoSchema = DistributionPhotoItemSchema.shape.photo.unwrap();
type Photo = ReturnType<typeof PrivateProductPhotoSchema.parse> | ReturnType<typeof PublicProductPhotoSchema.parse> | ReturnType<typeof DistributionPhotoSchema.parse>;
/** Only the public route supplies its configured origin; private preview never does. */
type PublicShare = {publicOrigin: string};
type PurchaseState = {open: false} | {open: true; product?: 'available' | 'sold_out'};
type PageOptions = PublicShare | {preview: true};
export function publicProduct(store: PublicStoreProjection, sku: string) {
  return ProductPhotoSkuSchema.safeParse(sku).success ? store.products.find(item => item.sku === sku) ?? null : null;
}
const productPath = (store: PublicStoreProjection, sku: string) => `/shops/${encodeURIComponent(store.slug)}/products/${encodeURIComponent(sku)}`;
const reservationPath = (store: PublicStoreProjection, sku?: string) => `/#reservations/${encodeURIComponent(store.slug)}${sku ? `/product/${encodeURIComponent(sku)}` : ''}`;
function paragraphs(text: string) {
  return text.split(/\n+/).filter(p => p.trim()).map(p => `<p>${escape(p.trim())}</p>`).join('');
}
function summary(text: string) {return [...text.replace(/\s+/g, ' ').trim()].slice(0, 180).join('');}
function photosFor(store: PublicStoreProjection, media: Media, share?: PublicShare) {
  const photos = new Map(media.map(item => [item.sku, item.photo === null ? null : PrivateProductPhotoSchema.or(PublicProductPhotoSchema).or(DistributionPhotoSchema).parse(item.photo)]));
  if (photos.size !== media.length || media.some(item => !store.products.some(product => product.sku === item.sku))) throw new Error('storefront_photo_product_mismatch');
  if (share && [...photos].some(([sku, photo]) => photo && (!PublicProductPhotoSchema.safeParse(photo).success || photo.read_path !== `/shops/${store.slug}/media/${store.revision}/${sku}`))) throw new Error('storefront_public_photo_required');
  return photos;
}
function picture(photo: Photo | null | undefined, title: string, eager = false) {
  return photo ? `<img class="shop-product-photo" src="${escape(photo.read_path)}" alt="${escape(title)}" width="${photo.width}" height="${photo.height}" loading="${eager ? 'eager' : 'lazy'}" decoding="async">`
    : '<div class="shop-photo-placeholder"><span>尚未提供商品照片</span></div>';
}
function metadata(name: string, description: string, path: string, photo: Photo | null | undefined, share?: PublicShare) {
  if (!share) return '';
  const origin = new URL(share.publicOrigin);
  if (!['https:', 'http:'].includes(origin.protocol) || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('storefront_public_origin_invalid');
  const absolute = (value: string) => escape(new URL(value, origin).href);
  const image = photo?.read_path ?? '/brand/freedom-workshop.webp';
  return `<link rel="canonical" href="${absolute(path)}"><meta property="og:type" content="website"><meta property="og:site_name" content="自由工坊"><meta property="og:locale" content="zh_TW"><meta property="og:title" content="${escape(name)}"><meta property="og:description" content="${escape(summary(description))}"><meta property="og:url" content="${absolute(path)}"><meta property="og:image" content="${absolute(image)}"><meta property="og:image:width" content="${photo?.width ?? 1280}"><meta property="og:image:height" content="${photo?.height ?? 720}"><meta property="og:image:alt" content="${escape(photo ? name : '自由工坊')}"><meta name="twitter:card" content="summary_large_image">`;
}
function shell(name: string, description: string, content: string, meta = '', preview = false, openSlug?: string) {
  const slug = openSlug !== undefined ? escape(openSlug) : undefined;
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escape(name)}｜自由工坊</title><meta name="description" content="${escape(summary(description))}">${meta}<link rel="stylesheet" href="/shops.css">${slug !== undefined ? '<script type="module" src="/assets/storefront.js"></script>' : ''}</head><body>${slug !== undefined ? '<a class="shop-skip-link" href="#main">跳到主要內容</a>' : ''}<header class="shop-top"><a href="/" aria-label="返回自由工坊"><img class="shop-logo" src="/brand/freedom-workshop.webp" alt="自由工坊" width="1280" height="720"></a>${slug !== undefined ? `<a class="shop-cart-link" href="/shops/${slug}/cart" data-store-slug="${slug}">購物車</a>` : '<span>會員的商品與商店</span>'}</header>${slug !== undefined ? '<p class="shop-sr-only" id="shop-cart-status" role="status"></p><main id="main" tabindex="-1">' : '<main>'}${content}</main><footer class="shop-footer"><p>${preview ? '店主已儲存的預覽，尚未對外發布。' : '由店主自行整理並發布的商品資訊。'}</p>${slug !== undefined ? `<a href="/shops/${slug}/order-access">找回訂單</a>` : '<a href="/#reservations">查詢我的預留</a>'}</footer></body></html>`;
}
function conditions(store: PublicStoreProjection) {
  return `<aside class="shop-notice" aria-label="預留與交易說明"><h2>看見喜歡的商品，下一步怎麼做？</h2><p>先查看商品，再登入確認這間商店目前是否開放預留。預留成功可保留 30 分鐘；此頁不提供付款，也不會安排出貨。</p><a href="${reservationPath(store)}">登入查看預留狀態</a></aside>`;
}
export function storeHtml(store: PublicStoreProjection, template: StoreTemplate = 'catalog-grid-v1', media: Media = [], options?: PageOptions, purchase?: PurchaseState) {
  const preview = options && 'preview' in options && options.preview;
  const share = options && 'publicOrigin' in options ? options : undefined;
  const open = !preview && purchase?.open === true;
  const list = StoreTemplateSchema.parse(template) === 'catalog-list-v1', photos = photosFor(store, media, share);
  const cover = store.products.map(product => photos.get(product.sku)).find(Boolean);
  const items = store.products.map(p => {
    const photo = picture(photos.get(p.sku), p.title), path = productPath(store, p.sku);
    const image = preview ? `<div class="shop-photo-link">${photo}</div>` : `<a class="shop-photo-link" href="${path}" aria-label="查看${escape(p.title)}">${photo}</a>`;
    const title = preview ? escape(p.title) : `<a href="${path}">${escape(p.title)}</a>`;
    const action = preview ? `<details class="shop-preview-description"><summary>預覽完整商品內容</summary>${paragraphs(p.description)}</details>`
      : `<a class="shop-button shop-button-secondary" href="${path}" aria-label="查看商品：${escape(p.title)}">查看商品<span aria-hidden="true"> →</span></a>`;
    return `<li><article>${image}<div class="shop-product-copy"><h3>${title}</h3><p class="shop-price">${escape(formatMinor(p.price_minor, store.currency))}</p><div class="shop-product-summary">${paragraphs(summary(p.description))}</div>${action}</div></article></li>`;
  }).join('');
  const banner = preview ? '<aside class="shop-preview-notice">這是未發布的預覽。發布後才會有可分享的商店與商品頁。</aside>' : '';
  return shell(store.name, store.description, `${banner}<header class="shop-brand-header"><p class="shop-eyebrow">${escape(store.brand ?? '獨立商店')}</p><h1>${escape(store.name)}</h1><div class="shop-introduction">${paragraphs(store.description)}</div><a class="shop-button" href="#products">瀏覽商品 <span aria-hidden="true">↓</span></a></header><section class="shop-catalog" aria-labelledby="products"><div class="shop-section-heading"><h2 id="products">店裡的商品</h2><p>${store.products.length} 件商品</p></div>${items ? `<ul class="shop-products${list ? ' shop-products-list' : ''}">${items}</ul>` : '<p class="shop-empty">店主正在準備商品，稍後再回來看看。</p>'}</section>${preview || open ? '' : conditions(store)}`, metadata(store.name, store.description, `/shops/${store.slug}`, cover, share), Boolean(preview), open ? store.slug : undefined);
}
export function productHtml(store: PublicStoreProjection, sku: string, media: Media = [], share?: PublicShare, purchase?: PurchaseState) {
  const product = publicProduct(store, sku);
  if (!product) return null;
  const open = purchase?.open === true;
  const photos = photosFor(store, media, share), photo = photos.get(sku);
  const action = open
    ? purchase.product === 'sold_out'
      ? '<p class="shop-availability">目前沒有可售數量</p>'
      : `<div class="shop-add" id="shop-add-to-cart" data-store-slug="${escape(store.slug)}" data-store-name="${escape(store.name)}" data-sku="${escape(sku)}" data-title="${escape(product.title)}" data-price-minor="${escape(String(product.price_minor))}" data-currency="${escape(store.currency)}" data-revision="${escape(store.revision)}"><noscript><p class="shop-action-note">加入購物車需要開啟瀏覽器的 JavaScript。</p></noscript></div>`
    : `<a class="shop-button" href="${reservationPath(store, sku)}">登入確認預留條件</a><p class="shop-action-note">先確認是否開放，再自行選擇數量與確認預留。尚未付款，不會安排出貨。</p>`;
  return shell(`${product.title}｜${store.name}`, product.description, `<nav class="shop-breadcrumb" aria-label="商品導覽"><a href="/shops/${escape(store.slug)}">← ${escape(store.name)}</a></nav><article class="shop-detail"><div class="shop-detail-photo">${picture(photo, product.title, true)}</div><div class="shop-detail-copy"><p class="shop-eyebrow">${escape(store.brand ?? store.name)}</p><h1>${escape(product.title)}</h1><p class="shop-price">${escape(formatMinor(product.price_minor, store.currency))}</p><div class="shop-description">${paragraphs(product.description) || '<p>店主尚未補充商品說明。</p>'}</div>${action}<p class="shop-product-ref">商品編號 ${escape(sku)}</p><a href="${productPath(store, sku)}">商品分享連結</a></div></article>${open ? '' : conditions(store)}`, metadata(`${product.title}｜${store.name}`, product.description, productPath(store, sku), photo, share), false, open ? store.slug : undefined);
}
export function storeMissingHtml(product = false) {
  const name = product ? '找不到這項商品' : '找不到這間商店', description = product ? '這項商品目前沒有公開。' : '這間商店目前沒有公開。';
  return shell(name, description, `<section class="shop-empty"><h1>${name}</h1><p>${description}</p><a href="/">返回自由工坊</a></section>`);
}
