import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {expect,type Page} from './fixtures.js';
import {DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';
import {hashPassword} from '../../modules/identity-membership/service.js';
import {CreateResultSchema} from '../../contracts/guild-launchpad/v1/tenant.js';
import {InstallationViewSchema,LaunchPlanSchema,RegistryOperationSchema} from '../../contracts/guild-launchpad/v1/module-registry.js';
const commerce='guild_commerce_sales',production='guild_commercial_production';
const storePage=(page:Page)=>page.locator('.hosted-store');
export async function person(db: Pool) {
  const id = randomUUID(), email = `store-${id}@example.test`;
  await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    VALUES($1,$2,$3,'商店測試會員',$4,$5,false)`, [id, DEMO_COMMUNITY, email, hashPassword(DEMO_PASSWORD), randomUUID()]);
  for (const key of [commerce, production]) await db.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, id, key]);
  await db.query('INSERT INTO guild_member_preferences(community_id,user_id,primary_guild_key) VALUES($1,$2,$3)', [DEMO_COMMUNITY, id, commerce]);
  return {id, email};
}
export async function login(page: Page, email: string) {
  await page.route(url => !['127.0.0.1', 'localhost'].includes(url.hostname), route => route.abort());
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
}
export async function open(page: Page, hash: string) {
  await page.evaluate(value => {window.location.hash = value;}, hash);
  if (hash.startsWith('guilds/')) await expect(page.locator('.guild-launchpad > .guild-launchpad-block')).toHaveCount(7);
  else await expect(storePage(page)).toBeVisible();
}
export async function post(page: Page, path: string, body: unknown, status: number, version?: string) {
  const session = await (await page.request.get('/api/v1/session')).json();
  const response = await page.request.post(`/api/v1${path}`, {data: body, headers: {
    Origin: new URL(page.url()).origin, 'X-CSRF-Token': session.csrf_token, 'Idempotency-Key': randomUUID(), ...(version ? {'If-Match': `"${version}"`} : {}),
  }});
  const result = await response.json(); expect(response.status(), JSON.stringify(result)).toBe(status); return result;
}
export async function launchStore(page: Page, name: string) {
  const space = CreateResultSchema.parse(await post(page, '/tenants', {display_name: name}, 201));
  const tenant = space.tenant.tenant_id;
  const plan = LaunchPlanSchema.parse(await post(page, `/tenants/${tenant}/application-launch-plans`, {
    guild_key: commerce, workspace_id: space.workspace.workspace_id, application_key: 'hosted-store', release_ref: 'hosted-store@1.0.0',
    installation_choice: 'create_new', dependencies: [{requirement_key: 'storefront', choice: 'create', configuration: {}}], configuration: {},
  }, 201));
  const operation = RegistryOperationSchema.parse(await post(page, `/tenants/${tenant}/application-installations`, {
    plan_id: plan.plan_id, expected_plan_version: plan.version, configuration_digest: plan.configuration_digest,
  }, 200));
  expect(operation.state).toBe('succeeded');
  const installation = InstallationViewSchema.parse(await (await page.request.get(`/api/v1/tenants/${tenant}/application-installations/by-operation/${operation.operation_id}`)).json());
  const instance = installation.modules.find(link => link.requirement_key === 'storefront')!.instance_id;
  return {root: `/tenants/${tenant}/storefronts/${instance}`, hash: `stores/${tenant}/${instance}`};
}
