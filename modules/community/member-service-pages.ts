import { escapeHtml } from '../development/service.js';
import { SERVICE_CATEGORIES, SERVICE_CATEGORY_LABELS, SERVICE_MODE_LABELS, type ServiceCategory, type ServiceMode } from '../../packages/shared/member-service.js';

export type PublicServiceCard = {
  service_id: string; title: string; category: ServiceCategory; summary: string;
  price_text: string | null; area_text: string | null; owner_name: string; has_cover: boolean; updated_at: string;
};
export type PublicServicePage = PublicServiceCard & {
  description: string | null; service_mode: ServiceMode; contacts: { label: string; url: string }[];
};

const BRAND = '/brand/freedom-workshop.webp';

function abs(origin: string, path: string) { return `${origin}${path}`; }
function listPath(category: string, before?: string) {
  const query = new URLSearchParams();
  if (category) query.set('category', category);
  if (before) query.set('before', before);
  const text = query.toString();
  return text ? `/services?${text}` : '/services';
}
function coverPath(id: string) { return `/api/v1/public/member-services/${id}/cover`; }
function paragraphs(value: string) {
  return value.split(/\n+/).filter(part => part.trim()).map(part => `<p>${escapeHtml(part.trim())}</p>`).join('');
}
function shell(origin: string, title: string, head: string, body: string) {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>${head}<link rel="stylesheet" href="/services.css"></head><body>${body}<footer class="service-foot"><a href="/">加入自由工坊</a><a href="/services">在自由工坊看更多社員服務</a></footer></body></html>`;
}
function meta(origin: string, path: string, title: string, description: string, image: { url: string; width: number; height: number }) {
  const url = abs(origin, path), src = escapeHtml(image.url);
  return `<link rel="canonical" href="${escapeHtml(url)}"><meta name="description" content="${escapeHtml(description)}"><meta property="og:type" content="website"><meta property="og:site_name" content="自由工坊"><meta property="og:locale" content="zh_TW"><meta property="og:url" content="${escapeHtml(url)}"><meta property="og:title" content="${escapeHtml(title)}"><meta property="og:description" content="${escapeHtml(description)}"><meta property="og:image" content="${src}"><meta property="og:image:width" content="${image.width}"><meta property="og:image:height" content="${image.height}"><meta name="twitter:card" content="summary_large_image"><meta name="twitter:title" content="${escapeHtml(title)}"><meta name="twitter:description" content="${escapeHtml(description)}"><meta name="twitter:image" content="${src}">`;
}
function media(service: { service_id: string; has_cover: boolean }, origin: string) {
  return service.has_cover
    ? `<img class="service-cover" src="${escapeHtml(coverPath(service.service_id))}" alt="" width="1200" height="675">`
    : '';
}
function placeholder(category: ServiceCategory) {
  return `<div class="service-placeholder">${escapeHtml(SERVICE_CATEGORY_LABELS[category])}</div>`;
}

export function serviceMissingHtml(origin: string) {
  const head = `<meta name="robots" content="noindex"><meta name="description" content="這項服務目前沒有公開。">`;
  const body = `<main class="service-missing"><h1>找不到這項服務</h1><p>這項服務目前沒有公開。</p></main>`;
  return shell(origin, '找不到這項服務｜自由工坊', head, body);
}

export function serviceListHtml(origin: string, category: string, cards: PublicServiceCard[], nextCursor: string | null) {
  const title = '社員服務｜自由工坊';
  const description = '社員的本業服務。假髮、課程、設計、語言教學與其他專業工作。';
  const chips = [{ id: '', label: '全部' }, ...SERVICE_CATEGORIES.map(id => ({ id, label: SERVICE_CATEGORY_LABELS[id] }))].map(item => {
    const current = item.id === category;
    return `<a href="${escapeHtml(listPath(item.id))}"${current ? ' aria-current="page"' : ''}>${escapeHtml(item.label)}</a>`;
  }).join('');
  const items = cards.map(card => {
    const facts = [card.price_text, card.area_text].filter(Boolean).map(value => escapeHtml(value!)).join(' · ');
    return `<article class="service-card"><a class="service-card-link" href="/services/${card.service_id}">${card.has_cover ? media(card, origin) : placeholder(card.category)}<h2>${escapeHtml(card.title)}</h2></a><p class="service-category">${escapeHtml(SERVICE_CATEGORY_LABELS[card.category])}</p><p class="service-owner">${escapeHtml(card.owner_name)}</p><p class="service-summary">${escapeHtml(card.summary)}</p>${facts ? `<p class="service-facts">${facts}</p>` : ''}</article>`;
  }).join('');
  const next = nextCursor ? `<p class="service-more"><a href="${escapeHtml(listPath(category, nextCursor))}">下一頁</a></p>` : '';
  const body = `<main><header class="service-banner"><p class="service-mark">自由工坊</p><h1>社員服務</h1><p>${escapeHtml(description)}</p></header><nav class="service-chips" aria-label="分類">${chips}</nav>${cards.length ? `<div class="service-grid">${items}</div>` : '<p class="service-empty">目前沒有公開的社員服務。</p>'}${next}</main>`;
  return shell(origin, title, meta(origin, listPath(category), title, description, { url: abs(origin, BRAND), width: 1280, height: 720 }), body);
}

export function serviceDetailHtml(origin: string, service: PublicServicePage) {
  const title = `${service.title}｜${service.owner_name} 的服務｜自由工坊`;
  const image = service.has_cover
    ? { url: abs(origin, coverPath(service.service_id)), width: 1200, height: 675 }
    : { url: abs(origin, BRAND), width: 1280, height: 720 };
  const facts = [
    service.price_text ? `<div><dt>價格</dt><dd>${escapeHtml(service.price_text)}</dd></div>` : '',
    service.area_text ? `<div><dt>地區</dt><dd>${escapeHtml(service.area_text)}</dd></div>` : '',
    `<div><dt>方式</dt><dd>${escapeHtml(SERVICE_MODE_LABELS[service.service_mode])}</dd></div>`,
  ].join('');
  const contacts = service.contacts.map(contact => `<a class="service-contact" href="${escapeHtml(contact.url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(contact.label)}</a>`).join('');
  const body = `<main class="service-detail"><p class="service-mark">自由工坊</p>${service.has_cover ? media(service, origin) : placeholder(service.category)}<p class="service-category">${escapeHtml(SERVICE_CATEGORY_LABELS[service.category])}</p><h1>${escapeHtml(service.title)}</h1><p class="service-owner">${escapeHtml(service.owner_name)}</p><p class="service-summary">${escapeHtml(service.summary)}</p>${service.description ? `<div class="service-copy">${paragraphs(service.description)}</div>` : ''}<dl class="service-facts">${facts}</dl><div class="service-contacts">${contacts}</div></main>`;
  return shell(origin, title, meta(origin, `/services/${service.service_id}`, title, service.summary, image), body);
}
