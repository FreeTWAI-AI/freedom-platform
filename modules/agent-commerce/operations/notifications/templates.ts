import { StoreSlugSchema } from '../../../../contracts/guild-launchpad/v1/storefront.js';
import { SERVICE_KEYS, methodOfService, type ServiceKey } from '../../fulfilment/rules/index.js';

export const COMMERCE_EMAIL_TEMPLATES = [
  'order_confirmed',
  'paid_unallocatable',
  'order_access',
  'shipment_handed_over',
  'aftersale_reply',
] as const;

export type CommerceEmailTemplate = (typeof COMMERCE_EMAIL_TEMPLATES)[number];

export interface RenderedCommerceEmail {
  readonly template: CommerceEmailTemplate;
  readonly subject: string;
  readonly text: string;
  readonly replyTo: string | null;
}

export class CommerceEmailTemplateError extends Error {
  readonly code = 'invalid_input' as const;
  constructor() {
    super('invalid_input');
    this.name = 'CommerceEmailTemplateError';
  }
}

/** Closed map keyed by ServiceKey; keys match SERVICE_KEYS exactly (EC-SPEC-10 §6.1). */
export const CARRIER_LABELS: Readonly<Record<ServiceKey, string>> = Object.freeze({
  'ecpay.logistics.home.tcat': '黑貓宅急便',
  'ecpay.logistics.home.post': '中華郵政',
  'ecpay.logistics.cvs.unimartc2c': '7-ELEVEN 店到店',
  'ecpay.logistics.cvs.famic2c': '全家店到店',
  'ecpay.logistics.cvs.hilifec2c': '萊爾富店到店',
});

// Display number pattern from PublicOrderSchema in contracts/guild-launchpad/v1/hosted-checkout.ts
const DISPLAY_NUMBER_PATTERN = /^[0-9]{6}-[0-9A-HJKMNP-TV-Z]{6}$/;

// Link token pattern from modules/agent-commerce/checkout/access.ts
const LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

// Order ref = lowercase UUID
const ORDER_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Tracking number pattern from providers/ecpay/domestic-logistics/create-order.ts (BOOKING_NOTE_PATTERN)
const TRACKING_NUMBER_PATTERN = /^[0-9A-Za-z-]{1,50}$/;

export interface BaseCommerceEmailInput {
  origin: string;
  store: {
    slug: string;
    name: string;
    contactEmail: string | null;
  };
  displayNumber: string;
  orderRef: string;
  accessToken?: string | null;
}

export interface OrderConfirmedItemInput {
  title: string;
  variantLabel: string | null;
  quantity: number;
}

export interface OrderConfirmedEmailInput extends BaseCommerceEmailInput {
  template: 'order_confirmed';
  accessToken: string;
  items: OrderConfirmedItemInput[];
  totalMinor: number;
}

export interface PaidUnallocatableEmailInput extends BaseCommerceEmailInput {
  template: 'paid_unallocatable';
}

export interface OrderAccessEmailInput extends BaseCommerceEmailInput {
  template: 'order_access';
  accessToken: string;
}

export interface ShipmentHandedOverEmailInput extends BaseCommerceEmailInput {
  template: 'shipment_handed_over';
  serviceKey: ServiceKey;
  trackingNumber: string | null;
}

export interface AftersaleReplyEmailInput extends BaseCommerceEmailInput {
  template: 'aftersale_reply';
}

export type CommerceEmailInput =
  | OrderConfirmedEmailInput
  | PaidUnallocatableEmailInput
  | OrderAccessEmailInput
  | ShipmentHandedOverEmailInput
  | AftersaleReplyEmailInput;

function validateOrigin(origin: unknown): string {
  if (typeof origin !== 'string') {
    throw new CommerceEmailTemplateError();
  }
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new CommerceEmailTemplateError();
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new CommerceEmailTemplateError();
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new CommerceEmailTemplateError();
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new CommerceEmailTemplateError();
  }
  if (parsed.protocol === 'https:') {
    return parsed.origin;
  }
  if (parsed.protocol === 'http:') {
    const loopback = ['localhost', '127.0.0.1', '[::1]'];
    if (loopback.includes(parsed.hostname)) {
      return parsed.origin;
    }
  }
  throw new CommerceEmailTemplateError();
}

function validateSlug(slug: unknown): string {
  if (typeof slug !== 'string') {
    throw new CommerceEmailTemplateError();
  }
  const result = StoreSlugSchema.safeParse(slug);
  if (!result.success || result.data !== slug) {
    throw new CommerceEmailTemplateError();
  }
  return result.data;
}

export function sanitizeSellerText(raw: unknown, limit: number): string {
  // 1. reject non-strings
  if (typeof raw !== 'string') {
    throw new CommerceEmailTemplateError();
  }
  // 2. normalize('NFC')
  let s = raw.normalize('NFC');
  // 3. replace every C0 control, DEL, C1 control, U+2028, U+2029 and U+0085 with a space
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g, ' ');
  // 4. remove bidi controls (U+061C, U+200E, U+200F, U+202A–U+202E, U+2066–U+2069)
  //    and zero-width / BOM characters (U+200B–U+200D, U+2060, U+FEFF)
  s = s.replace(/[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u200B-\u200D\u2060\uFEFF]/g, '');
  // 5. collapse whitespace runs (including U+3000) to one ASCII space
  s = s.replace(/[\s\u3000]+/g, ' ');
  // 6. trim
  s = s.trim();
  // 7. reject lone surrogates
  if (!s.isWellFormed() || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s)) {
    throw new CommerceEmailTemplateError();
  }
  // 8. if longer than field limit in code points, cut to limit - 1 code points and append … (never split surrogate pair)
  const codePoints = Array.from(s);
  if (codePoints.length > limit) {
    s = codePoints.slice(0, limit - 1).join('') + '…';
  }
  // Empty after this → error
  if (s.length === 0) {
    throw new CommerceEmailTemplateError();
  }
  return s;
}

function validateContactEmail(email: unknown): string | null {
  if (email === null || email === undefined) {
    return null;
  }
  if (typeof email !== 'string') {
    throw new CommerceEmailTemplateError();
  }
  if (email.length === 0 || email.length > 254) {
    throw new CommerceEmailTemplateError();
  }
  if (!/^[\u0021-\u007E]+$/.test(email)) {
    throw new CommerceEmailTemplateError();
  }
  if (/[\s\u0000-\u001F\u007F-\u009F,;<>"()[\]\\]/.test(email)) {
    throw new CommerceEmailTemplateError();
  }
  const parts = email.split('@');
  if (parts.length !== 2) {
    throw new CommerceEmailTemplateError();
  }
  const [local, domain] = parts;
  if (local.length < 1 || local.length > 64) {
    throw new CommerceEmailTemplateError();
  }
  if (!domain.includes('.')) {
    throw new CommerceEmailTemplateError();
  }
  if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) {
    throw new CommerceEmailTemplateError();
  }
  return email;
}

function validateDisplayNumber(val: unknown): string {
  if (typeof val !== 'string' || !DISPLAY_NUMBER_PATTERN.test(val)) {
    throw new CommerceEmailTemplateError();
  }
  return val;
}

function validateOrderRef(val: unknown): string {
  if (typeof val !== 'string' || !ORDER_REF_PATTERN.test(val)) {
    throw new CommerceEmailTemplateError();
  }
  return val;
}

function validateAccessToken(token: unknown, required: boolean): string | null {
  if (token === null || token === undefined) {
    if (required) {
      throw new CommerceEmailTemplateError();
    }
    return null;
  }
  if (typeof token !== 'string' || !LINK_TOKEN_PATTERN.test(token)) {
    throw new CommerceEmailTemplateError();
  }
  return token;
}

function validateItems(items: unknown): Array<{ title: string; variantLabel: string | null; quantity: number }> {
  if (!Array.isArray(items) || items.length < 1 || items.length > 100) {
    throw new CommerceEmailTemplateError();
  }
  return items.map(item => {
    if (!item || typeof item !== 'object') {
      throw new CommerceEmailTemplateError();
    }
    const raw = item as Record<string, unknown>;
    const title = sanitizeSellerText(raw.title, 120);
    let variantLabel: string | null = null;
    if (raw.variantLabel !== null && raw.variantLabel !== undefined) {
      variantLabel = sanitizeSellerText(raw.variantLabel, 60);
    }
    const q = raw.quantity;
    if (typeof q !== 'number' || !Number.isInteger(q) || q < 1 || q > 9999) {
      throw new CommerceEmailTemplateError();
    }
    return { title, variantLabel, quantity: q };
  });
}

function validateTotalMinor(totalMinor: unknown): number {
  if (
    typeof totalMinor !== 'number' ||
    !Number.isInteger(totalMinor) ||
    totalMinor < 0 ||
    totalMinor > Number.MAX_SAFE_INTEGER
  ) {
    throw new CommerceEmailTemplateError();
  }
  return totalMinor;
}

function validateServiceKey(key: unknown): ServiceKey {
  if (typeof key !== 'string' || !SERVICE_KEYS.includes(key as ServiceKey)) {
    throw new CommerceEmailTemplateError();
  }
  return key as ServiceKey;
}

function validateTrackingNumber(val: unknown): string | null {
  if (val === null || val === undefined) {
    return null;
  }
  if (typeof val !== 'string' || !TRACKING_NUMBER_PATTERN.test(val)) {
    throw new CommerceEmailTemplateError();
  }
  return val;
}

export function formatTwd(minor: number): string {
  const validated = validateTotalMinor(minor);
  const major = Math.floor(validated / 100);
  const rem = validated % 100;
  const majorStr = String(major).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  if (rem === 0) {
    return `NT$${majorStr}`;
  }
  const remStr = String(rem).padStart(2, '0');
  return `NT$${majorStr}.${remStr}`;
}

function validateCommon(input: unknown, tokenRequired: boolean) {
  if (!input || typeof input !== 'object') {
    throw new CommerceEmailTemplateError();
  }
  const raw = input as Record<string, unknown>;
  const origin = validateOrigin(raw.origin);
  if (!raw.store || typeof raw.store !== 'object') {
    throw new CommerceEmailTemplateError();
  }
  const rawStore = raw.store as Record<string, unknown>;
  const slug = validateSlug(rawStore.slug);
  const storeName = sanitizeSellerText(rawStore.name, 80);
  const contactEmail = validateContactEmail(rawStore.contactEmail);
  const displayNumber = validateDisplayNumber(raw.displayNumber);
  const orderRef = validateOrderRef(raw.orderRef);
  const accessToken = validateAccessToken(raw.accessToken, tokenRequired);

  return { origin, slug, storeName, contactEmail, displayNumber, orderRef, accessToken };
}

function buildOrderLink(origin: string, slug: string, orderRef: string, accessToken: string | null): string {
  const base = `${origin}/shops/${slug}/orders/${orderRef}`;
  return accessToken ? `${base}#access=${accessToken}` : base;
}

function buildStoreUrl(origin: string, slug: string): string {
  return `${origin}/shops/${slug}`;
}

function buildLinkParagraph(orderUrl: string): string {
  return `查看訂單請開啟以下連結：\n${orderUrl}`;
}

function buildLinkNoteParagraph(hasToken: boolean): string {
  if (hasToken) {
    return '此連結有效期限為 7 天，只能使用一次；使用後會在此瀏覽器開啟訂單，請勿轉寄給他人。';
  }
  return '此連結可在先前下單或開啟過此訂單的瀏覽器直接查看；若更換裝置或瀏覽器，可至店家頁面以訂購時的 Email 與訂單編號重新取得查看連結。';
}

function buildFooterParagraph(
  storeName: string,
  contactEmail: string | null,
  storeUrl: string,
  isOrderAccess: boolean,
): string {
  const lines: string[] = [
    `這封信由自由工坊代「${storeName}」僅就此筆訂單發送，不含任何行銷廣告。`,
  ];
  if (contactEmail !== null) {
    lines.push(`店家聯絡 Email：${contactEmail}`);
  } else {
    lines.push('店家的聯絡方式請見店家頁面：');
    lines.push(storeUrl);
  }
  if (!isOrderAccess) {
    lines.push('若你沒有在這間店下單，請忽略這封信。');
  }
  return lines.join('\n');
}

const UTF8_ENCODER = new TextEncoder();

function finalizeRenderedEmail(
  template: CommerceEmailTemplate,
  subject: string,
  text: string,
  replyTo: string | null,
): RenderedCommerceEmail {
  if (subject.length > 200 || /[\r\n\u0085\u2028\u2029]/.test(subject)) {
    throw new CommerceEmailTemplateError();
  }
  if (text.includes('\r') || text.includes('\t') || text.endsWith('\n')) {
    throw new CommerceEmailTemplateError();
  }
  for (const line of text.split('\n')) {
    if (line.endsWith(' ') || UTF8_ENCODER.encode(line).length > 998) {
      throw new CommerceEmailTemplateError();
    }
  }
  return Object.freeze({
    template,
    subject,
    text,
    replyTo,
  });
}

export function renderOrderConfirmedEmail(
  input: Omit<OrderConfirmedEmailInput, 'template'> | OrderConfirmedEmailInput,
): RenderedCommerceEmail {
  const { origin, slug, storeName, contactEmail, displayNumber, orderRef, accessToken } = validateCommon(input, true);
  const items = validateItems((input as Record<string, unknown>).items);
  const totalMinor = validateTotalMinor((input as Record<string, unknown>).totalMinor);

  const orderUrl = buildOrderLink(origin, slug, orderRef, accessToken);
  const storeUrl = buildStoreUrl(origin, slug);

  const p1 = `你向「${storeName}」建立的訂單 ${displayNumber} 已完成付款，店家將開始為你準備商品。`;

  const itemLines: string[] = ['訂單內容：'];
  const displayItems = items.slice(0, 10);
  for (const item of displayItems) {
    if (item.variantLabel !== null) {
      itemLines.push(`・${item.title}（${item.variantLabel}）× ${item.quantity}`);
    } else {
      itemLines.push(`・${item.title} × ${item.quantity}`);
    }
  }
  if (items.length > 10) {
    itemLines.push(`・以及另外 ${items.length - 10} 項商品`);
  }
  itemLines.push(`合計：${formatTwd(totalMinor)}`);
  const p2 = itemLines.join('\n');

  const p3 = buildLinkParagraph(orderUrl);
  const p4 = buildLinkNoteParagraph(true);
  const p5 = buildFooterParagraph(storeName, contactEmail, storeUrl, false);

  const subject = `自由工坊：「${storeName}」訂單 ${displayNumber} 已成立`;
  const text = [p1, p2, p3, p4, p5].join('\n\n');

  return finalizeRenderedEmail('order_confirmed', subject, text, contactEmail);
}

export function renderPaidUnallocatableEmail(
  input: Omit<PaidUnallocatableEmailInput, 'template'> | PaidUnallocatableEmailInput,
): RenderedCommerceEmail {
  const { origin, slug, storeName, contactEmail, displayNumber, orderRef, accessToken } = validateCommon(input, false);

  const orderUrl = buildOrderLink(origin, slug, orderRef, accessToken);
  const storeUrl = buildStoreUrl(origin, slug);

  const p1 = `你向「${storeName}」建立的訂單 ${displayNumber} 已完成付款。因商品目前庫存不足，暫時無法出貨。`;
  const p2 =
    '店家將確認庫存狀態，若補足庫存將為你出貨，或取消訂單並由店家辦理退款；後續處理結果將更新於訂單頁面。若有任何疑問，請透過下方的聯絡方式與店家聯繫。';
  const p3 = buildLinkParagraph(orderUrl);
  const p4 = buildLinkNoteParagraph(accessToken !== null);
  const p5 = buildFooterParagraph(storeName, contactEmail, storeUrl, false);

  const subject = `自由工坊：「${storeName}」訂單 ${displayNumber} 已付款，等待配貨`;
  const text = [p1, p2, p3, p4, p5].join('\n\n');

  return finalizeRenderedEmail('paid_unallocatable', subject, text, contactEmail);
}

export function renderOrderAccessEmail(
  input: Omit<OrderAccessEmailInput, 'template'> | OrderAccessEmailInput,
): RenderedCommerceEmail {
  const { origin, slug, storeName, contactEmail, displayNumber, orderRef, accessToken } = validateCommon(input, true);

  const orderUrl = buildOrderLink(origin, slug, orderRef, accessToken);
  const storeUrl = buildStoreUrl(origin, slug);

  const p1 = `有人申請了「${storeName}」訂單 ${displayNumber} 的查看連結。`;
  const p2 = buildLinkParagraph(orderUrl);
  const p3 = buildLinkNoteParagraph(true);
  const p4 = '若不是你提出申請，請忽略此信。';
  const p5 = buildFooterParagraph(storeName, contactEmail, storeUrl, true);

  const subject = `自由工坊：「${storeName}」訂單 ${displayNumber} 的查看連結`;
  const text = [p1, p2, p3, p4, p5].join('\n\n');

  return finalizeRenderedEmail('order_access', subject, text, contactEmail);
}

export function renderShipmentHandedOverEmail(
  input: Omit<ShipmentHandedOverEmailInput, 'template'> | ShipmentHandedOverEmailInput,
): RenderedCommerceEmail {
  const { origin, slug, storeName, contactEmail, displayNumber, orderRef, accessToken } = validateCommon(input, false);
  const serviceKey = validateServiceKey((input as Record<string, unknown>).serviceKey);
  const trackingNumber = validateTrackingNumber((input as Record<string, unknown>).trackingNumber);
  const isCvs = methodOfService(serviceKey) !== 'home';
  if (isCvs && trackingNumber !== null) {
    throw new CommerceEmailTemplateError();
  }

  const orderUrl = buildOrderLink(origin, slug, orderRef, accessToken);
  const storeUrl = buildStoreUrl(origin, slug);

  const p1 = `你向「${storeName}」建立的訂單 ${displayNumber} 有包裹已交寄。`;

  const logisticsLines: string[] = [`物流方式：${CARRIER_LABELS[serviceKey]}`];
  if (trackingNumber !== null) {
    logisticsLines.push(`包裹追蹤碼：${trackingNumber}`);
  }
  if (isCvs) {
    logisticsLines.push(
      '包裹送達門市時，超商將發送取件簡訊通知，你也可以在訂單頁面查看取件門市與包裹狀態。',
    );
  }
  const p2 = logisticsLines.join('\n');

  const p3 = buildLinkParagraph(orderUrl);
  const p4 = buildLinkNoteParagraph(accessToken !== null);
  const p5 = buildFooterParagraph(storeName, contactEmail, storeUrl, false);

  const subject = `自由工坊：「${storeName}」訂單 ${displayNumber} 有包裹已交寄`;
  const text = [p1, p2, p3, p4, p5].join('\n\n');

  return finalizeRenderedEmail('shipment_handed_over', subject, text, contactEmail);
}

export function renderAftersaleReplyEmail(
  input: Omit<AftersaleReplyEmailInput, 'template'> | AftersaleReplyEmailInput,
): RenderedCommerceEmail {
  const { origin, slug, storeName, contactEmail, displayNumber, orderRef, accessToken } = validateCommon(input, false);

  const orderUrl = buildOrderLink(origin, slug, orderRef, accessToken);
  const storeUrl = buildStoreUrl(origin, slug);

  const p1 = `你向「${storeName}」建立的訂單 ${displayNumber} 的售後申請有新回覆或進度更新。`;
  const p2 = buildLinkParagraph(orderUrl);
  const p3 = buildLinkNoteParagraph(accessToken !== null);
  const p4 = buildFooterParagraph(storeName, contactEmail, storeUrl, false);

  const subject = `自由工坊：「${storeName}」訂單 ${displayNumber} 有新回覆`;
  const text = [p1, p2, p3, p4].join('\n\n');

  return finalizeRenderedEmail('aftersale_reply', subject, text, contactEmail);
}

export function renderCommerceEmail(input: CommerceEmailInput): RenderedCommerceEmail {
  if (!input || typeof input !== 'object') {
    throw new CommerceEmailTemplateError();
  }
  switch (input.template) {
    case 'order_confirmed':
      return renderOrderConfirmedEmail(input);
    case 'paid_unallocatable':
      return renderPaidUnallocatableEmail(input);
    case 'order_access':
      return renderOrderAccessEmail(input);
    case 'shipment_handed_over':
      return renderShipmentHandedOverEmail(input);
    case 'aftersale_reply':
      return renderAftersaleReplyEmail(input);
    default:
      throw new CommerceEmailTemplateError();
  }
}
