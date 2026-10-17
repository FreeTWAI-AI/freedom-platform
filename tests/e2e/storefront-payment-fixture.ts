import { randomUUID } from 'node:crypto';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import type { Pool } from 'pg';
import { expect } from './fixtures.js';
import { apiLogin } from './hosted-order-fixture.js';
import { createE2ePaymentOrder } from './hosted-payment-fixture.js';
import {
  assertResponsiveLayout,
  buildVerifiedError,
  buildVerifiedOrder,
} from './storefront-order-fixture.js';
import {
  CheckoutErrorSchema,
  CheckoutResponseSchema,
  PaymentHandoffResponseSchema,
  PlaceOrderResponseSchema,
  PublicOrderSchema,
  type PublicOrder,
} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';

export const RESPONSIVE_WIDTHS = [1440, 1280, 768, 390, 320] as const;

export {
  assertResponsiveLayout,
  buildVerifiedError,
  buildVerifiedOrder,
  createE2ePaymentOrder,
  apiLogin,
  CheckoutErrorSchema,
  PaymentHandoffResponseSchema,
  PublicOrderSchema,
};

export function buildVerifiedHandoff(attemptRef: string = randomUUID(), tokenChar = 'H') {
  return PaymentHandoffResponseSchema.parse({
    handoff_url: `/pay/ecpay/${tokenChar.repeat(43).slice(0, 43)}`,
    attempt_ref: attemptRef,
    expires_at: '2026-10-16T03:00:00.000Z',
  });
}

export async function readOrderDtoWithPageCookies(
  page: Page,
  storeSlug: string,
  orderRef: string,
): Promise<PublicOrder> {
  const response = await page.request.get(
    `/api/v1/public/stores/${encodeURIComponent(storeSlug)}/orders/${encodeURIComponent(orderRef)}`,
  );
  expect(response.status()).toBe(200);
  return PublicOrderSchema.parse(await response.json());
}

export async function placeAdditionalPaymentOrder(
  origin: string,
  context: BrowserContext,
  storeSlug: string,
  sku: string,
  options: {
    revision?: string;
    contact?: { name: string; email: string; phone: string };
  } = {},
) {
  const root = `/api/v1/public/stores/${encodeURIComponent(storeSlug)}`;
  const checkoutRes = await context.request.post(`${root}/checkouts`, {
    data: {
      publication_revision: options.revision ?? '1',
      lines: [{ sku, quantity: 1 }],
      contact: options.contact ?? {
        name: '合成付款買家乙',
        email: 'synthetic-payment-buyer@example.test',
        phone: '0911222333',
      },
      delivery: { method: 'synthetic', address: '合成測試地址 2 號' },
      invoice: null,
      consents: [],
    },
    headers: { Origin: origin, 'Idempotency-Key': randomUUID() },
  });
  expect(checkoutRes.status()).toBe(201);
  const checkout = CheckoutResponseSchema.parse(await checkoutRes.json());

  const placeRes = await context.request.post(`${root}/checkouts/${checkout.checkout_ref}/orders`, {
    data: {
      terms_sha256: checkout.terms_sha256,
      client_order_id: randomUUID(),
    },
    headers: { Origin: origin },
  });
  expect(placeRes.status()).toBe(201);
  const placed = PlaceOrderResponseSchema.parse(await placeRes.json());
  expect(placed.payment).not.toBeNull();
  return {
    checkout,
    order: placed.order,
    payment: placed.payment!,
  };
}

export async function createMemberPaymentOrder(
  db: Pool,
  browser: Browser,
  origin: string,
) {
  const memberContext = await browser.newContext({ baseURL: origin });
  try {
    const p = await createE2ePaymentOrder(db, browser, origin, memberContext);
    await apiLogin(memberContext, origin, p.store.buyer.email);
    const memberPlaced = await placeAdditionalPaymentOrder(origin, memberContext, p.store.slug, p.store.product.sku, {
      contact: {
        name: '合成會員買家',
        email: p.store.buyer.email,
        phone: '0922333444',
      },
    });
    return {
      store: p.store,
      guestOrder: p.order,
      guestPayment: p.payment,
      memberOrder: memberPlaced.order,
      memberPayment: memberPlaced.payment,
    };
  } finally {
    await memberContext.close();
  }
}

export async function advancePaymentReturnPolls(
  page: Page,
  orderRef: string,
  pollCount: number,
) {
  for (let i = 0; i < pollCount; i += 1) {
    const pollWait = page.waitForResponse(
      res => res.url().endsWith(`/orders/${orderRef}`) && res.request().method() === 'GET',
    );
    await page.clock.runFor(5000);
    await pollWait;
  }
}
