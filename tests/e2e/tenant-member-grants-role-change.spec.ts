import { randomUUID } from 'node:crypto';
import type { APIRequestContext, Page, Request } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { navigate } from './navigation.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { hashPassword } from '../../modules/identity-membership/service.js';
import { CreateResultSchema, InvitationViewSchema, MemberPageSchema } from '../../contracts/guild-launchpad/v1/tenant.js';

const WORK_KEYS = ['work:archive', 'work:create', 'work:read', 'work:result.write', 'work:write'];

async function post(request: APIRequestContext, origin: string, csrf: string, path: string, data: unknown, status: number, version?: string) {
  const response = await request.post(`/api/v1${path}`, { data, headers: {
    Origin: origin, 'X-CSRF-Token': csrf, 'Idempotency-Key': randomUUID(),
    ...(version ? { 'If-Match': `"${version}"` } : {}),
  } });
  const body = await response.json();
  expect(response.status(), JSON.stringify(body)).toBe(status);
  return body;
}

async function theme(page: Page, value: 'light' | 'dark') {
  await page.evaluate(id => {
    localStorage.setItem('freedom-theme', id);
    document.documentElement.dataset.theme = id;
    document.documentElement.dataset.experienceProfile = id;
    window.dispatchEvent(new Event('freedom-theme-changed'));
  }, value);
}

test('role changes preserve instance grants and confirm viewer narrowing and admin clearing', async ({ browser, baseURL, e2eAuthPool }, testInfo) => {
  test.setTimeout(120_000);
  const run = randomUUID().slice(0, 8);
  const people = ['owner', 'member'].map(kind => ({
    id: randomUUID(), email: `role-grants-${kind}-${run}@example.test`, name: `${kind === 'owner' ? '空間主人' : '工作夥伴'}${run}`,
  }));
  for (const person of people) {
    await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,$4,$5,$6,false)`, [person.id, DEMO_COMMUNITY, person.email, person.name, hashPassword(DEMO_PASSWORD), randomUUID()]);
  }
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,'guild_ai_field','active','full')`, [randomUUID(), DEMO_COMMUNITY, people[0].id]);
  const owner = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
  const member = await browser.newContext({ baseURL });
  const page = await owner.newPage();
  const origin = new URL(baseURL!).origin;
  try {
    const ownerLogin = await owner.request.post('/api/v1/auth/login', { data: { email: people[0].email, password: DEMO_PASSWORD }, headers: { Origin: origin } });
    expect(ownerLogin.status()).toBe(200);
    const ownerCsrf = (await ownerLogin.json()).csrf_token as string;
    const memberLogin = await member.request.post('/api/v1/auth/login', { data: { email: people[1].email, password: DEMO_PASSWORD }, headers: { Origin: origin } });
    expect(memberLogin.status()).toBe(200);
    const memberCsrf = (await memberLogin.json()).csrf_token as string;
    const created = CreateResultSchema.parse(await post(owner.request, origin, ownerCsrf, '/tenants', { display_name: `權限空間${run}`, workspace_name: '人工工作區' }, 201));
    const tenantId = created.tenant.tenant_id;
    const enabled = await post(owner.request, origin, ownerCsrf, `/tenants/${tenantId}/workspaces/${created.workspace.workspace_id}/manual-work`, { guild_key: 'guild_ai_field' }, 200);
    const instanceId = enabled.instance_id as string;
    const grants = [{ instance_id: instanceId, capabilities: WORK_KEYS }];
    const candidate = await owner.request.get(`/api/v1/tenants/invite-candidates?user_id=${people[1].id}`);
    expect(candidate.status()).toBe(200);
    const principalId = (await candidate.json()).principal_id as string;
    const invitation = InvitationViewSchema.parse(await post(owner.request, origin, ownerCsrf, `/tenants/${tenantId}/invitations`, {
      invitee_principal_id: principalId, role: 'operator', instance_capabilities: grants,
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    }, 201));
    await post(member.request, origin, memberCsrf, `/tenants/${tenantId}/invitations/${invitation.invitation_id}/accept`, {}, 200, invitation.version);
    const readMember = async () => {
      const response = await owner.request.get(`/api/v1/tenants/${tenantId}/members`);
      expect(response.status()).toBe(200);
      const found = MemberPageSchema.parse(await response.json()).items.find(item => item.principal_id === principalId);
      expect(found).toBeDefined();
      return found!;
    };
    const changes: Request[] = [];
    page.on('request', request => {
      if (request.method() === 'POST' && new URL(request.url()).pathname === `/api/v1/tenants/${tenantId}/members/${principalId}/change`) changes.push(request);
    });
    await page.goto('/');
    await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
    await navigate(page, '業務空間');
    const row = page.getByRole('region', { name: '成員', exact: true }).locator('li').filter({ hasText: people[1].name });
    const role = row.getByLabel('角色', { exact: true });
    await expect(role).toHaveValue('operator');
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('before-desktop-light.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await row.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('before-mobile-light.png') });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(row).toContainText(`人工工作 …${instanceId.slice(-6)}：封存、建立、讀取、上傳成果、編輯`);
    const initial = await readMember();
    await role.selectOption('operator');
    // A real API read is a barrier after the browser action; no timers or request mocks.
    expect(await readMember()).toEqual(initial);
    expect(changes).toHaveLength(0);

    await role.selectOption('viewer');
    const confirmation = row.getByRole('region', { name: '確認角色變更', exact: true });
    await expect(confirmation).toContainText(`人工工作 …${instanceId.slice(-6)}：封存、建立、上傳成果、編輯`);
    await expect(confirmation).not.toContainText('讀取');
    expect(await readMember()).toEqual(initial);
    expect(changes).toHaveLength(0);
    await row.getByRole('button', { name: '取消', exact: true }).click();
    await expect(role).toHaveValue('operator');
    await expect(confirmation).toHaveCount(0);
    expect(await readMember()).toEqual(initial);
    expect(changes).toHaveLength(0);

    await role.selectOption('viewer');
    await expect(confirmation).toBeVisible();
    for (const appearance of ['light', 'dark'] as const) {
      await theme(page, appearance);
      for (const width of [1440, 768, 390, 360]) {
        await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
        await confirmation.scrollIntoViewIfNeeded();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const controls = await confirmation.getByRole('button').evaluateAll(elements => elements.map(element => {
          const box = element.getBoundingClientRect();
          return { height: box.height, left: box.left, right: box.right };
        }));
        expect(controls).toHaveLength(2);
        for (const control of controls) {
          expect(control.height).toBeGreaterThanOrEqual(44);
          expect(control.left).toBeGreaterThanOrEqual(0);
          expect(control.right).toBeLessThanOrEqual(width);
        }
        await page.screenshot({ path: testInfo.outputPath(`confirmation-${width}-${appearance}.png`) });
      }
    }
    await row.getByRole('button', { name: '確認變更', exact: true }).click();
    await expect(role).toHaveValue('viewer');
    const viewer = await readMember();
    expect(viewer.instance_capabilities).toEqual([{ instance_id: instanceId, capabilities: ['work:read'] }]);
    expect(changes).toHaveLength(1);
    expect(changes[0].headers()['if-match']).toBe(`"${initial.version}"`);
    expect(changes[0].postDataJSON()).toMatchObject({ role: 'viewer', status: 'active', instance_capabilities: viewer.instance_capabilities });

    await role.selectOption('operator');
    await expect(row).toContainText(`${people[1].name}・操作者・使用中`);
    await expect(confirmation).toHaveCount(0);
    const operator = await readMember();
    expect(operator.instance_capabilities).toEqual(viewer.instance_capabilities);
    expect(changes).toHaveLength(2);
    expect(changes[1].headers()['if-match']).toBe(`"${viewer.version}"`);

    await role.selectOption('admin');
    await expect(confirmation).toContainText(`人工工作 …${instanceId.slice(-6)}：讀取`);
    expect(await readMember()).toEqual(operator);
    expect(changes).toHaveLength(2);
    await row.getByRole('button', { name: '確認變更', exact: true }).click();
    await expect(role).toHaveValue('admin');
    expect((await readMember()).instance_capabilities).toEqual([]);
    expect(changes).toHaveLength(3);
    expect(changes[2].postDataJSON()).toMatchObject({ role: 'admin', status: 'active', instance_capabilities: [] });
    expect(changes[2].headers()['if-match']).toBe(`"${operator.version}"`);
    expect(new Set(changes.map(request => request.headers()['idempotency-key'])).size).toBe(3);
    for (const request of changes) expect(request.headers()['idempotency-key']).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    await expect(row.locator('.tenant-member-grants')).toHaveCount(0);

    // Restore operator grants via the existing API, then exercise the page's revoke action.
    const admin = await readMember();
    await post(owner.request, origin, ownerCsrf, `/tenants/${tenantId}/members/${principalId}/change`, {
      role: 'operator', status: 'active', instance_capabilities: grants, reason: '恢復合成測試權限',
    }, 200, admin.version);
    await page.reload();
    await expect(role).toHaveValue('operator');
    await row.getByRole('button', { name: '撤銷', exact: true }).click();
    await expect(row).toContainText('已撤銷');
    expect(await readMember()).toMatchObject({ status: 'revoked', instance_capabilities: [] });
    expect(changes).toHaveLength(4);
    expect(changes[3].postDataJSON()).toMatchObject({ status: 'revoked', instance_capabilities: [] });
  } finally {
    await owner.close();
    await member.close();
    const ids = people.map(person => person.id);
    await e2eAuthPool.query('UPDATE sessions SET revoked_at=now() WHERE user_id=ANY($1::uuid[])', [ids]);
    await e2eAuthPool.query('UPDATE users SET active=false WHERE user_id=ANY($1::uuid[])', [ids]);
  }
});
