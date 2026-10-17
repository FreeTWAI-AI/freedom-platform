import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { Browser, Page } from '@playwright/test';
import { expect } from './fixtures.js';
import { apiLogin, enableStore, fixtureStore } from './hosted-order-fixture.js';
import { setupE2ePayment } from './hosted-payment-fixture.js';
import { isolatedTransaction } from '../../packages/resource-scopes/tenant-transaction.js';
import { mapPersonPrincipal } from '../../packages/resource-scopes/index.js';
import {
  applyConfirmedPayment,
  cancelUnpaidOrder,
  freezeCheckout,
  placeCheckoutOrder,
  type CheckoutPorts,
} from '../../modules/agent-commerce/checkout/index.js';
import { createAccessLink } from '../../modules/agent-commerce/checkout/access.js';
import { publicOrder } from '../../modules/agent-commerce/checkout/public-order.js';
import { PublicStoreProjectionSchema, StoreViewSchema } from '../../contracts/guild-launchpad/v1/storefront.js';
import {
  CheckoutErrorSchema,
  PublicOrderSchema,
  type PublicOrder,
} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';
import { syntheticShippingPort } from '../../scripts/synthetic-shipping-quote.js';

export const e2eCheckoutPorts: CheckoutPorts = {
  admission: { allowed: () => true },
  // One parcel per supplier group keeps the storefront order fixture's 6000 shipping total.
  shipping: syntheticShippingPort({ fee_per_parcel_minor: 6000 }),
};

export async function setupStorefrontOrderStore(db: Pool, browser: Browser, origin: string) {
  const store = await fixtureStore(db, browser, origin);
  await enableStore(db, store.instance);
  await setupE2ePayment(db, browser, origin, store);
  const profileRow = (
    await db.query<{ storefront_shop_id: string }>(
      'SELECT storefront_shop_id FROM commerce_storefront_profiles WHERE instance_id=$1',
      [store.instance],
    )
  ).rows[0];
  expect(profileRow).toBeDefined();

  const publicRes = await fetch(`${origin}/api/v1/public/stores/${store.slug}`);
  expect(publicRes.status).toBe(200);
  const projection = PublicStoreProjectionSchema.parse(await publicRes.json());

  return {
    ...store,
    storefront_shop_id: profileRow.storefront_shop_id,
    revision: projection.revision,
    storeName: projection.name,
  };
}

export type SeededOrderStore = Awaited<ReturnType<typeof setupStorefrontOrderStore>>;

export interface SeedOrderOptions {
  quantity?: number;
  buyerUserId?: string;
  cancelReason?: 'buyer_cancelled' | 'seller_cancelled' | 'payment_not_completed';
  confirmPayment?: boolean;
  contact?: { name: string; email: string; phone: string };
}

export async function seedStorefrontOrder(db: Pool, store: SeededOrderStore, options: SeedOrderOptions = {}) {
  const quantity = options.quantity ?? 1;
  const contact = options.contact ?? {
    name: '合成買家甲',
    email: 'synthetic-order-buyer@example.test',
    phone: '0900123456',
  };

  return isolatedTransaction(db, async q => {
    const mapped = options.buyerUserId ? await mapPersonPrincipal(q, options.buyerUserId) : null;
    const buyerPrincipalId = mapped ? mapped.principal_id : null;
    const checkoutStore = { storefront_shop_id: store.storefront_shop_id };

    const checkout = await freezeCheckout(
      q,
      checkoutStore,
      {
        publication_revision: store.revision,
        lines: [{ sku: store.product.sku, quantity }],
        contact,
        delivery: { method: 'synthetic', address: '合成測試地址 1 號' },
        invoice: null,
        consents: [],
        idempotencyKey: randomUUID(),
        ...(buyerPrincipalId ? { memberPrincipalId: buyerPrincipalId } : {}),
      },
      e2eCheckoutPorts,
    );

    let order = await placeCheckoutOrder(
      q,
      checkoutStore,
      {
        checkoutId: checkout.checkout_id,
        termsSha256: checkout.terms_sha256,
        clientOrderId: randomUUID(),
        buyerPrincipalId,
        environment: 'sandbox',
      },
      e2eCheckoutPorts,
    );

    const token = await createAccessLink(q, {
      tenant_id: store.tenant,
      instance_id: store.instance,
      checkout_id: checkout.checkout_id,
      order_id: order.order_id,
    });

    if (options.cancelReason) {
      const actor =
        options.cancelReason === 'buyer_cancelled'
          ? 'buyer'
          : options.cancelReason === 'seller_cancelled'
            ? 'seller'
            : 'system';
      order = await cancelUnpaidOrder(q, checkoutStore, order.order_id, actor, options.cancelReason);
    }

    if (options.confirmPayment) {
      await applyConfirmedPayment(q, {
        orderId: order.order_id,
        paymentRef: randomUUID(),
        amountMinor: order.terms.total_minor,
        currency: order.terms.currency,
        simulated: false,
      });
    }

    const view = await publicOrder(
      q,
      {
        instanceId: store.instance,
        tenantId: store.tenant,
        projection: { slug: store.slug, name: store.storeName },
      },
      order.order_id,
    );

    return {
      checkout,
      order,
      view,
      token,
      orderPath: `/shops/${store.slug}/orders/${order.order_id}`,
      linkPath: `/shops/${store.slug}/orders/${order.order_id}#access=${token}`,
    };
  });
}

export async function updateAndRepublishStore(
  browser: Browser,
  origin: string,
  store: SeededOrderStore,
  updates: { storeName: string; productTitle: string; stock?: number },
): Promise<SeededOrderStore> {
  const context = await browser.newContext({ baseURL: origin });
  try {
    const session = await apiLogin(context, origin, store.seller.email);
    const headers = (version?: string) => ({
      Origin: origin,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      ...(version ? { 'If-Match': `"${version}"` } : {}),
    });

    const beforeStore = StoreViewSchema.parse(await (await context.request.get(`/api/v1${store.root}`)).json());
    const patchStoreRes = await context.request.patch(`/api/v1${store.root}`, {
      data: { name: updates.storeName },
      headers: headers(beforeStore.version!),
    });
    expect(patchStoreRes.status()).toBe(200);

    const patchProductRes = await context.request.patch(`/api/v1${store.root}/products/${store.product.product_id}`, {
      data: {
        title: updates.productTitle,
        ...(updates.stock !== undefined ? { stock: updates.stock } : {}),
      },
      headers: headers(store.product.version),
    });
    expect(patchProductRes.status()).toBe(200);

    const afterStore = StoreViewSchema.parse(await (await context.request.get(`/api/v1${store.root}`)).json());
    const publishRes = await context.request.post(`/api/v1${store.root}/publish`, {
      data: {},
      headers: headers(afterStore.version!),
    });
    expect(publishRes.status()).toBe(200);

    const publicRes = await fetch(`${origin}/api/v1/public/stores/${store.slug}`);
    expect(publicRes.status).toBe(200);
    const projection = PublicStoreProjectionSchema.parse(await publicRes.json());

    return {
      ...store,
      revision: projection.revision,
      storeName: projection.name,
    };
  } finally {
    await context.close();
  }
}

export function buildVerifiedOrder(base: PublicOrder, patch: Partial<PublicOrder>): PublicOrder {
  return PublicOrderSchema.parse({ ...base, ...patch });
}

export function buildVerifiedError(
  status: number,
  code: ReturnType<typeof CheckoutErrorSchema.parse>['code'],
  detail: string,
) {
  return CheckoutErrorSchema.parse({
    type: 'about:blank',
    title: code,
    status,
    code,
    detail,
  });
}

export async function assertResponsiveLayout(
  page: Page,
  widths: readonly number[],
  screenshotPrefix?: (width: number) => string,
) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate(() => {
      const noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth;
      const allButtons = [...document.querySelectorAll<HTMLElement>('.shop-button')];
      const buttons = allButtons
        .filter(el => el.getClientRects().length > 0)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return { width: rect.width, height: rect.height, text: el.textContent?.trim() ?? '' };
        });
      return { noHorizontalOverflow, totalButtons: allButtons.length, buttons };
    });
    expect(metrics.noHorizontalOverflow, `scrollWidth overflow at ${width}px`).toBe(true);
    if (metrics.totalButtons > 0) {
      expect(metrics.buttons.length, `visible buttons at ${width}px`).toBeGreaterThan(0);
    }
    for (const btn of metrics.buttons) {
      expect(btn.height, `button "${btn.text}" height at ${width}px`).toBeGreaterThanOrEqual(44);
      if (width >= 768) {
        expect(btn.width, `button "${btn.text}" width at ${width}px`).toBeLessThanOrEqual(480);
      }
    }
    if (screenshotPrefix) {
      await page.screenshot({ path: screenshotPrefix(width), fullPage: true });
    }
  }
}
