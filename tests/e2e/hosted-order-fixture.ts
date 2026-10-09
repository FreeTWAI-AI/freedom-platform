import {TENANT_CURSOR_TEST_KEY} from '../runtime/tenant-cursor-fixture.js';
import {randomUUID} from 'node:crypto';
import {serve} from '@hono/node-server';
import {serveStatic} from '@hono/node-server/serve-static';
import type {Pool} from 'pg';
import type {Browser, BrowserContext, Page} from '@playwright/test';
import {expect} from './fixtures.js';
import {DEMO_COMMUNITY, DEMO_PASSWORD, DEMO_USERS} from '../../packages/testing/seed.js';
import {e2eSchema} from '../../packages/testing/e2e-auth-isolation.js';
import {createApp} from '../../apps/platform-api/src/app.js';
import {CreateResultSchema} from '../../contracts/guild-launchpad/v1/tenant.js';
import {InstallationViewSchema, LaunchPlanSchema, RegistryOperationSchema} from '../../contracts/guild-launchpad/v1/module-registry.js';
import {StoreViewSchema, ProductViewSchema} from '../../contracts/guild-launchpad/v1/storefront.js';

export async function ownedSchema(db: Pool) {
  const url = new URL(process.env.TEST_DATABASE_URL ?? 'invalid:');
  if (!['127.0.0.1', 'localhost'].includes(url.hostname) || url.port === '54339' || !/^\/fp_[a-z0-9_]+$/.test(url.pathname)) throw Error('Explicit owned disposable loopback database required.');
  const schema = e2eSchema(process.env.FREEDOM_E2E_SCHEMA);
  expect((await db.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
}
export async function member(db: Pool, community = DEMO_COMMUNITY) {
  await ownedSchema(db);
  const id = randomUUID(), email = `buyer-ui-${id}@example.test`;
  const result = await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,active,onboarding_required)
    SELECT $1,$2,$3,'預留測試會員',password_hash,$4,true,false FROM users WHERE email=$5`, [id, community, email, randomUUID(), DEMO_USERS[0].email]);
  expect(result.rowCount).toBe(1); return {id, email};
}
export async function buyerLogin(page: Page, email: string, hash: string, origin?: string) {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  await page.goto(`${origin ?? ''}/${hash}`);
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
}
export async function apiLogin(context: BrowserContext, origin: string, email: string) {
  const response = await context.request.post(origin + '/api/v1/auth/login', {data: {email, password: DEMO_PASSWORD}, headers: {Origin: origin}});
  expect(response.status()).toBe(200); return response.json();
}
export async function fixtureStore(db: Pool, browser: Browser, origin: string) {
  await ownedSchema(db);
  const seller = await member(db), community = randomUUID();
  await db.query("INSERT INTO communities(community_id,name) VALUES($1,'買家隔離社群')", [community]);
  const buyer = await member(db, community), stranger = await member(db, community);
  await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,'guild_commerce_sales','active','full')`, [randomUUID(), DEMO_COMMUNITY, seller.id]);
  const context = await browser.newContext({baseURL: origin});
  try {
    const session = await apiLogin(context, origin, seller.email);
    const post = async (path: string, body: unknown, status = 200, version?: string) => {
      const response = await context.request.post('/api/v1' + path, {data: body, headers: {Origin: origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(), ...(version ? {'If-Match': `"${version}"`} : {})}});
      const raw = await response.json(); expect(response.status(), JSON.stringify(raw)).toBe(status); return raw;
    };
    const space = CreateResultSchema.parse(await post('/tenants', {display_name: '預留商品空間'}, 201));
    const tenant = space.tenant.tenant_id;
    const plan = LaunchPlanSchema.parse(await post(`/tenants/${tenant}/application-launch-plans`, {guild_key: 'guild_commerce_sales', workspace_id: space.workspace.workspace_id, application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0', installation_choice: 'create_new', dependencies: [{requirement_key: 'storefront', choice: 'create', configuration: {}}], configuration: {}}, 201));
    const operation = RegistryOperationSchema.parse(await post(`/tenants/${tenant}/application-installations`, {plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest}));
    expect(operation.state).toBe('succeeded');
    const installation = InstallationViewSchema.parse(await (await context.request.get(`/api/v1/tenants/${tenant}/application-installations/by-operation/${operation.operation_id}`)).json());
    const instance = installation.modules.find(link => link.requirement_key === 'storefront')!.instance_id;
    const root = `/tenants/${tenant}/storefronts/${instance}`, slug = `bu-${randomUUID()}`;
    await post(root + '/setup', {slug, name: '山邊小店', currency: 'TWD'}, 201);
    const product = ProductViewSchema.parse(await post(root + '/products', {title: '手作茶杯', description: '杯口手工成形。', price_minor: 35000, stock: 4}, 201));
    const current = StoreViewSchema.parse(await (await context.request.get('/api/v1' + root)).json());
    await post(root + '/publish', {}, 200, current.version!);
    expect((await db.query('SELECT reservation_enabled FROM commerce_storefront_profiles WHERE instance_id=$1', [instance])).rows).toEqual([{reservation_enabled: false}]);
    expect((await db.query('SELECT 1 FROM tenant_memberships m JOIN principals p ON p.principal_id=m.principal_id WHERE tenant_id=$1 AND p.user_ref=ANY($2::uuid[])', [tenant, [buyer.id, stranger.id]])).rowCount).toBe(0);
    return {seller, buyer, stranger, instance, tenant, slug, root, product};
  } finally {await context.close();}
}
export async function enableStore(db: Pool, instance: string) {
  await ownedSchema(db);
  expect((await db.query('UPDATE commerce_storefront_profiles SET reservation_enabled=true WHERE instance_id=$1', [instance])).rowCount).toBe(1);
}
/** Separate real HTTP host, default admission omitted; shares only this run's disposable schema. */
export async function offListener(db: Pool, discovery: boolean) {
  await ownedSchema(db);
  let app: ReturnType<typeof createApp> | undefined;
  const server = serve({hostname: '127.0.0.1', port: 0, fetch: request => app ? app.fetch(request) : new Response(null, {status: 503})});
  try {
    if (!server.listening) await new Promise<void>((resolve, reject) => {server.once('listening', resolve); server.once('error', reject);});
    const address = server.address(); if (!address || typeof address === 'string') throw Error('Owned loopback listener unavailable.');
    const origin = `http://127.0.0.1:${address.port}`;
    // Intentionally no hostedReservationsEnabled: proves actual Node default OFF.
    app = createApp(db, origin, 'local', {guildLaunchpadEnabled: discovery, tenantCursorSigningKey: TENANT_CURSOR_TEST_KEY});
    app.use('/*', serveStatic({root: './apps/portal-web/dist'}));
    app.get('*', serveStatic({path: './apps/portal-web/dist/index.html'}));
    return {origin, close: async () => {if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));}};
  } catch (error) {if ('closeAllConnections' in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); throw error;}
}
