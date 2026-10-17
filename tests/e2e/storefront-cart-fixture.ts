import { randomUUID } from 'node:crypto';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Pool } from 'pg';
import type { Browser, Page } from '@playwright/test';
import { expect } from './fixtures.js';
import { apiLogin, member, ownedSchema } from './hosted-order-fixture.js';
import { TENANT_CURSOR_TEST_KEY } from '../runtime/tenant-cursor-fixture.js';
import { ports } from '../runtime/hosted-checkout-harness.js';
import { LOCAL_DATABASE_URL } from '../../packages/db/index.js';
import { DEMO_COMMUNITY } from '../../packages/testing/seed.js';
import { e2eSchema } from '../../packages/testing/e2e-auth-isolation.js';
import { createApp } from '../../apps/platform-api/src/app.js';
import { CreateResultSchema } from '../../contracts/guild-launchpad/v1/tenant.js';
import {
  InstallationViewSchema,
  LaunchPlanSchema,
  RegistryOperationSchema,
} from '../../contracts/guild-launchpad/v1/module-registry.js';
import {
  ProductViewSchema,
  PublicStoreProjectionSchema,
  StoreViewSchema,
  type ProductView,
} from '../../contracts/guild-launchpad/v1/storefront.js';
import {
  CartQuoteInputSchema,
  CartQuoteResponseSchema,
  CheckoutErrorSchema,
} from '../../contracts/guild-launchpad/v1/hosted-checkout.js';

export type VerifiedCartQuote = ReturnType<typeof CartQuoteResponseSchema.parse>;
export type VerifiedCheckoutError = ReturnType<typeof CheckoutErrorSchema.parse>;

export function buildVerifiedQuote(quote: VerifiedCartQuote): VerifiedCartQuote {
  return CartQuoteResponseSchema.parse(quote);
}

export function buildVerifiedError(
  status: number,
  code: VerifiedCheckoutError['code'],
  detail: string,
): VerifiedCheckoutError {
  return CheckoutErrorSchema.parse({
    type: 'about:blank',
    title: code,
    status,
    code,
    detail,
  });
}

export function assertExactQuoteInput(rawBody: string | null) {
  expect(rawBody).not.toBeNull();
  const parsed = JSON.parse(rawBody!) as Record<string, unknown>;
  CartQuoteInputSchema.parse(parsed);
  expect(Object.keys(parsed).sort()).toEqual(['lines', 'publication_revision']);
  const lines = parsed.lines as Record<string, unknown>[];
  for (const line of lines) {
    expect(Object.keys(line).sort()).toEqual(['quantity', 'sku']);
  }
  return parsed as { publication_revision: string; lines: { sku: string; quantity: number }[] };
}

export async function openCartListener(db: Pool) {
  await ownedSchema(db);
  const schema = e2eSchema(process.env.FREEDOM_E2E_SCHEMA);
  const listenerPool = new Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL,
    options: `-c search_path=${schema} -c application_name=${schema}`,
    max: 8,
  });
  listenerPool.on('error', () => {});
  let app: ReturnType<typeof createApp> | undefined;
  const server = serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: request => (app ? app.fetch(request) : new Response(null, { status: 503 })),
  });
  try {
    if (!server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.once('listening', resolve);
        server.once('error', reject);
      });
    }
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw Error('Owned loopback listener unavailable.');
    }
    const origin = `http://127.0.0.1:${address.port}`;
    app = createApp(listenerPool, origin, 'local', {
      guildLaunchpadEnabled: true,
      tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY,
      commerceSettings: { checkoutEnabled: true, consoleEnabled: true, quarantine: false, providerProfiles: [] },
      commercePorts: {
        admission: { allowed: () => true },
        shipping: ports.shipping,
      },
    });
    app.use('/*', serveStatic({ root: './apps/portal-web/dist' }));
    app.get('*', serveStatic({ path: './apps/portal-web/dist/index.html' }));
    return {
      origin,
      close: async () => {
        try {
          if ('closeAllConnections' in server) server.closeAllConnections();
          await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
        } finally {
          await listenerPool.end();
        }
      },
    };
  } catch (error) {
    try {
      if ('closeAllConnections' in server) server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    } finally {
      await listenerPool.end().catch(() => {});
    }
    throw error;
  }
}

export async function setupCartFixtureStore(db: Pool, browser: Browser) {
  await ownedSchema(db);
  const listener = await openCartListener(db);
  const seller = await member(db);
  await db.query(
    `INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
     VALUES($1,$2,$3,'guild_commerce_sales','active','full')`,
    [randomUUID(), DEMO_COMMUNITY, seller.id],
  );

  const sellerContext = await browser.newContext({ baseURL: listener.origin });
  try {
    const session = await apiLogin(sellerContext, listener.origin, seller.email);
    const headers = (version?: string) => ({
      Origin: listener.origin,
      'X-CSRF-Token': session.csrf_token,
      'Idempotency-Key': randomUUID(),
      ...(version ? { 'If-Match': `"${version}"` } : {}),
    });
    const post = async (path: string, body: unknown, status = 200, version?: string) => {
      const response = await sellerContext.request.post('/api/v1' + path, {
        data: body,
        headers: headers(version),
      });
      const raw = await response.json();
      expect(response.status(), JSON.stringify(raw)).toBe(status);
      return raw;
    };
    const patch = async (path: string, body: unknown, version: string) => {
      const response = await sellerContext.request.patch('/api/v1' + path, {
        data: body,
        headers: headers(version),
      });
      const raw = await response.json();
      expect(response.status(), JSON.stringify(raw)).toBe(200);
      return raw;
    };

    const space = CreateResultSchema.parse(await post('/tenants', { display_name: '購物車測試空間' }, 201));
    const tenant = space.tenant.tenant_id;
    const plan = LaunchPlanSchema.parse(
      await post(
        `/tenants/${tenant}/application-launch-plans`,
        {
          guild_key: 'guild_commerce_sales',
          workspace_id: space.workspace.workspace_id,
          application_key: 'hosted-store',
          release_ref: 'hosted-store@1.1.0',
          installation_choice: 'create_new',
          dependencies: [{ requirement_key: 'storefront', choice: 'create', configuration: {} }],
          configuration: {},
        },
        201,
      ),
    );
    const operation = RegistryOperationSchema.parse(
      await post(`/tenants/${tenant}/application-installations`, {
        plan_id: plan.plan_id,
        expected_plan_version: plan.version,
        configuration_digest: plan.configuration_digest,
      }),
    );
    expect(operation.state).toBe('succeeded');
    const installation = InstallationViewSchema.parse(
      await (
        await sellerContext.request.get(`/api/v1/tenants/${tenant}/application-installations/by-operation/${operation.operation_id}`)
      ).json(),
    );
    const instance = installation.modules.find(link => link.requirement_key === 'storefront')!.instance_id;
    const root = `/tenants/${tenant}/storefronts/${instance}`;
    const slug = `cart-${randomUUID().slice(0, 12)}`;

    await post(root + '/setup', { slug, name: '山邊小店', currency: 'TWD' }, 201);

    const p1 = ProductViewSchema.parse(
      await post(
        root + '/products',
        { title: '手作茶杯', description: '杯口手工成形。', price_minor: 35000, stock: 5 },
        201,
      ),
    );
    const p2 = ProductViewSchema.parse(
      await post(
        root + '/products',
        { title: '亞麻茶席巾', description: '自然亞麻織紋。', price_minor: 12000, stock: 8 },
        201,
      ),
    );
    const p3 = ProductViewSchema.parse(
      await post(
        root + '/products',
        { title: '青瓷茶海', description: '手拉坯青瓷茶海。', price_minor: 48000, stock: 3 },
        201,
      ),
    );
    const soldOutProduct = ProductViewSchema.parse(
      await post(
        root + '/products',
        { title: '限量竹茶則', description: '手作竹製茶則。', price_minor: 22000, stock: 0 },
        201,
      ),
    );

    const republish = async () => {
      const current = StoreViewSchema.parse(await (await sellerContext.request.get('/api/v1' + root)).json());
      await post(root + '/publish', {}, 200, current.version!);
      const publicRes = await sellerContext.request.get(`/api/v1/public/stores/${slug}`);
      expect(publicRes.status()).toBe(200);
      return PublicStoreProjectionSchema.parse(await publicRes.json());
    };

    const initialProjection = await republish();

    const updatePriceAndRepublish = async (product: ProductView, priceMinor: number) => {
      const updated = ProductViewSchema.parse(
        await patch(`${root}/products/${product.product_id}`, { price_minor: priceMinor }, product.version),
      );
      const projection = await republish();
      return { product: updated, projection };
    };

    const removeProductAndRepublish = async (product: ProductView) => {
      await post(`${root}/products/${product.product_id}/remove`, {}, 200, product.version);
      return await republish();
    };

    const updateLongNamesAndRepublish = async (
      storeName: string,
      product: ProductView,
      productTitle: string,
    ) => {
      const currentStore = StoreViewSchema.parse(await (await sellerContext.request.get('/api/v1' + root)).json());
      await patch(root, { name: storeName }, currentStore.version!);
      const updatedProduct = ProductViewSchema.parse(
        await patch(`${root}/products/${product.product_id}`, { title: productTitle }, product.version),
      );
      const projection = await republish();
      return { product: updatedProduct, projection };
    };

    return {
      origin: listener.origin,
      slug,
      storeName: '山邊小店',
      root,
      instance,
      tenant,
      products: [p1, p2, p3] as const,
      soldOutProduct,
      revision: initialProjection.revision,
      updatePriceAndRepublish,
      removeProductAndRepublish,
      updateLongNamesAndRepublish,
      close: async () => {
        try {
          await sellerContext.close();
        } finally {
          await listener.close();
        }
      },
    };
  } catch (error) {
    try {
      await sellerContext.close();
    } finally {
      await listener.close();
    }
    throw error;
  }
}

export async function assertCartResponsiveLayout(
  page: Page,
  widths: readonly number[],
  screenshotPrefix?: (width: number) => string,
  options: { checkSheet?: boolean } = {},
) {
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    const metrics = await page.evaluate((checkSheet: boolean) => {
      const noHorizontalOverflow = document.documentElement.scrollWidth <= window.innerWidth;
      const allButtons = [...document.querySelectorAll<HTMLElement>('.shop-button')];
      const buttons = allButtons
        .filter(el => el.getClientRects().length > 0)
        .map(el => {
          const rect = el.getBoundingClientRect();
          return { width: rect.width, height: rect.height, text: el.textContent?.trim() ?? '' };
        });

      let sheetRect: {
        top: number;
        right: number;
        bottom: number;
        left: number;
        width: number;
        height: number;
        viewportWidth: number;
        viewportHeight: number;
      } | null = null;

      if (checkSheet) {
        const sheet = document.querySelector<HTMLElement>('.shop-cart-sheet[open]');
        if (sheet) {
          const r = sheet.getBoundingClientRect();
          sheetRect = {
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            left: r.left,
            width: r.width,
            height: r.height,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
          };
        }
      }

      return { noHorizontalOverflow, totalButtons: allButtons.length, buttons, sheetRect };
    }, Boolean(options.checkSheet));

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

    if (options.checkSheet) {
      expect(metrics.sheetRect, `open sheet present at ${width}px`).not.toBeNull();
      const s = metrics.sheetRect!;
      if (width > 600) {
        expect(Math.abs(s.right - s.viewportWidth), `sheet right edge at ${width}px`).toBeLessThanOrEqual(1);
        expect(Math.abs(s.top), `sheet top edge at ${width}px`).toBeLessThanOrEqual(1);
        expect(Math.abs(s.height - s.viewportHeight), `sheet height at ${width}px`).toBeLessThanOrEqual(1);
        expect(s.width, `sheet max width at ${width}px`).toBeLessThanOrEqual(420.5);
      } else {
        expect(Math.abs(s.bottom - s.viewportHeight), `sheet bottom edge at ${width}px`).toBeLessThanOrEqual(1);
        expect(Math.abs(s.left), `sheet left edge at ${width}px`).toBeLessThanOrEqual(1);
        expect(Math.abs(s.width - s.viewportWidth), `sheet full width at ${width}px`).toBeLessThanOrEqual(1);
      }
    }

    if (screenshotPrefix) {
      await page.screenshot({ path: screenshotPrefix(width), fullPage: true });
    }
  }
}
