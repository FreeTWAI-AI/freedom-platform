export type CartCurrency = 'TWD' | 'USD';

export interface StoredCartLine {
  sku: string;
  quantity: number;
  title: string;
  price_minor: number;
  currency: CartCurrency;
}

export interface StoredCart {
  revision: string;
  lines: StoredCartLine[];
}

export const STORE_SLUG_PATTERN = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const PRODUCT_SKU_PATTERN = /^P[0-9]{4,23}$/;
export const REVISION_PATTERN = /^[1-9][0-9]{0,18}$/;
export const MAX_CART_LINES = 50;
export const MAX_LINE_QUANTITY = 99;
export const MAX_TITLE_LENGTH = 120;

const CART_KEY_PREFIX = 'freedom.shop.cart.v1:';

export function cartStorageKey(slug: string): string {
  return `${CART_KEY_PREFIX}${slug}`;
}

export function isValidStoreSlug(value: string): boolean {
  return STORE_SLUG_PATTERN.test(value);
}

export function isValidProductSku(value: string): boolean {
  return PRODUCT_SKU_PATTERN.test(value);
}

export function isValidRevision(value: string): boolean {
  return REVISION_PATTERN.test(value);
}

export function isValidTitle(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= MAX_TITLE_LENGTH;
}

export function isValidPriceMinor(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isValidCurrency(value: unknown): value is CartCurrency {
  return value === 'TWD' || value === 'USD';
}

export function isValidQuantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= MAX_LINE_QUANTITY;
}

export function emptyCart(): StoredCart {
  return { revision: '', lines: [] };
}

export function cartCount(cart: StoredCart): number {
  return cart.lines.reduce((total, line) => total + line.quantity, 0);
}

export function readCart(slug: string): StoredCart {
  if (!isValidStoreSlug(slug)) return emptyCart();
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(cartStorageKey(slug));
  } catch {
    return emptyCart();
  }
  if (!raw) return emptyCart();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyCart();
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyCart();
  }

  const candidate = parsed as { revision?: unknown; lines?: unknown };
  if (typeof candidate.revision !== 'string' || !isValidRevision(candidate.revision) || !Array.isArray(candidate.lines)) {
    return emptyCart();
  }

  const seenSkus = new Set<string>();
  const lines: StoredCartLine[] = [];
  for (const item of candidate.lines) {
    if (lines.length >= MAX_CART_LINES) break;
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rawLine = item as Record<string, unknown>;
    const sku = rawLine.sku;
    const quantity = rawLine.quantity;
    const title = rawLine.title;
    const priceMinor = rawLine.price_minor;
    const currency = rawLine.currency;
    if (typeof sku !== 'string' || !isValidProductSku(sku)) continue;
    if (seenSkus.has(sku)) continue;
    if (!isValidQuantity(quantity)) continue;
    if (!isValidTitle(title)) continue;
    if (!isValidPriceMinor(priceMinor)) continue;
    if (!isValidCurrency(currency)) continue;

    seenSkus.add(sku);
    lines.push({
      sku,
      quantity,
      title,
      price_minor: priceMinor,
      currency,
    });
  }

  if (lines.length === 0) {
    return emptyCart();
  }

  return {
    revision: candidate.revision,
    lines,
  };
}

export function writeCart(slug: string, cart: StoredCart): boolean {
  if (!isValidStoreSlug(slug)) return false;
  const key = cartStorageKey(slug);
  try {
    if (cart.lines.length === 0) {
      window.localStorage.removeItem(key);
      return true;
    }
    if (!isValidRevision(cart.revision)) return false;
    const payload = JSON.stringify({
      revision: cart.revision,
      lines: cart.lines.slice(0, MAX_CART_LINES).map(line => ({
        sku: line.sku,
        quantity: line.quantity,
        title: line.title,
        price_minor: line.price_minor,
        currency: line.currency,
      })),
    });
    window.localStorage.setItem(key, payload);
    return true;
  } catch {
    return false;
  }
}

export function subscribe(slug: string, callback: () => void): () => void {
  const key = cartStorageKey(slug);
  function handleStorage(event: StorageEvent) {
    if (event.key === key || event.key === null) {
      callback();
    }
  }
  window.addEventListener('storage', handleStorage);
  return () => window.removeEventListener('storage', handleStorage);
}
