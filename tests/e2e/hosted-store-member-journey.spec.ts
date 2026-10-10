import { randomUUID } from 'node:crypto';
import { test, expect, type Page } from './fixtures.js';
import { navigate, signOut } from './navigation.js';
import { quickJoin } from './quick-join.js';
import { DEMO_COMMUNITY, DEMO_PASSWORD } from '../../packages/testing/seed.js';
import { hashPassword } from '../../modules/identity-membership/service.js';

const guild = 'guild_commerce_sales';
async function register(page: Page, nickname: string) {
  const email = `merchant-journey-${randomUUID()}@example.test`;
  await page.goto('/');
  await page.getByRole('button', {name: '建立帳號', exact: true}).click();
  await page.getByLabel('社群顯示名稱', {exact: true}).fill(nickname);
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '建立帳號，先逛工坊', exact: true}).click();
  await quickJoin(page, guild);
  await expect(page.getByRole('heading', {name: '會員首頁', level: 1})).toBeVisible();
  return email;
}
async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill(DEMO_PASSWORD);
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.getByRole('button', {name: '設定', exact: true})).toBeVisible();
}
async function guildHome(page: Page) {
  await page.goto('/#guilds/' + guild);
  await expect(page.getByRole('region', {name: '主要動作', exact: true})).toBeVisible();
}

test('registered intern obtains guild approval through the UI, opens a store, publishes a template and returns privately', async ({page, browser, baseURL, e2eAuthPool}, info) => {
  test.setTimeout(120_000);
  // The existing guild officer is fixture infrastructure. Neither merchant is
  // inserted, promoted or given a tenant/grant with SQL or direct API calls.
  const officerId = randomUUID(), officerEmail = `merchant-officer-${officerId}@example.test`;
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    VALUES($1,$2,$3,'商店驗收會長',$4,$5,false)`, [officerId, DEMO_COMMUNITY, officerEmail, hashPassword(DEMO_PASSWORD), randomUUID()]);
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, officerId, guild]);
  await e2eAuthPool.query('INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)', [DEMO_COMMUNITY, guild, officerId]);
  const officer = await browser.newContext({baseURL}), stranger = await browser.newContext({baseURL}), publicContext = await browser.newContext({baseURL});
  try {
    const nickname = `新店主 ${randomUUID().slice(0, 8)}`, email = await register(page, nickname);
    await guildHome(page);
    const primary = page.getByRole('region', {name: '主要動作', exact: true});
    await expect(primary.getByRole('button', {name: '建立我的商店', exact: true})).toBeDisabled();
    const officerPage = await officer.newPage(); await login(officerPage, officerEmail);
    await navigate(officerPage, '職業公會');
    const card = officerPage.getByRole('article').filter({has: officerPage.getByRole('heading', {name: /電商/})});
    await expect(card).toHaveCount(1);
    await card.getByRole('button', {name: '查看成員', exact: true}).click();
    const dialog = officerPage.getByRole('dialog');
    await dialog.getByRole('searchbox', {name: '搜尋公會成員'}).fill(nickname);
    await dialog.getByRole('button', {name: '搜尋成員', exact: true}).click();
    const member = dialog.locator('.directory-member'); await expect(member).toHaveCount(1);
    await member.getByRole('button', {name: '設為正式成員', exact: true}).click();
    await expect(member.locator('.guild-member-tier-full')).toHaveText('正式成員');
    await page.reload();
    await primary.getByRole('button', {name: '建立我的商店', exact: true}).click();
    const flow = page.getByRole('region', {name: '啟動應用', exact: true});
    await flow.getByLabel('業務空間名稱', {exact: true}).fill('新會員選物工作室');
    await flow.getByRole('button', {name: '建立業務空間', exact: true}).click();
    await flow.getByRole('button', {name: '產生啟動方案', exact: true}).click();
    await flow.getByRole('button', {name: '確認啟動', exact: true}).click();
    await flow.getByRole('button', {name: '設定我的商店', exact: true}).click();
    await expect(page).toHaveURL(/#stores\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);
    const storeHash = new URL(page.url()).hash, slug = 'member-' + randomUUID().slice(0, 8);
    const setup = page.getByRole('form', {name: '建立商店', exact: true});
    await setup.getByLabel('商店名稱', {exact: true}).fill('新會員選物店');
    await setup.getByLabel('商店網址', {exact: true}).fill(slug);
    await setup.getByRole('button', {name: '建立商店', exact: true}).click();
    const product = page.getByRole('form', {name: '新增商品', exact: true});
    await product.getByLabel('商品名稱', {exact: true}).fill('手作茶杯');
    await product.getByLabel('價格（新臺幣 TWD）', {exact: true}).fill('350');
    await product.getByLabel('庫存', {exact: true}).fill('10');
    await product.getByRole('button', {name: '新增商品', exact: true}).click();
    await expect(page.locator('.hosted-store-product')).toContainText('手作茶杯');
    await page.getByRole('radio', {name: /^直列目錄/}).check();
    await page.getByRole('button', {name: '儲存版型', exact: true}).click();
    await expect(page.locator('.hosted-store').getByRole('status')).toContainText('已儲存版型');
    const popup = page.waitForEvent('popup'); await page.getByRole('link', {name: '預覽已儲存的展示頁', exact: true}).click();
    const preview = await popup;
    await expect(preview.locator('.shop-products-list article')).toHaveCount(1);
    const publicPage = await publicContext.newPage(); await publicPage.goto('/shops/' + slug);
    await expect(publicPage.getByRole('heading', {name: '新會員選物店', exact: true})).toHaveCount(0);
    await page.getByRole('button', {name: '發布展示頁', exact: true}).click();
    await expect(page.locator('.hosted-store').getByRole('status')).toContainText('已發布・第 1 版');
    await publicPage.reload(); await expect(publicPage.locator('.shop-products-list article')).toHaveCount(1);
    expect(await publicPage.locator('main').innerHTML()).toBe(await preview.locator('main').innerHTML());
    await preview.close();
    await signOut(page); await login(page, email); await guildHome(page);
    await primary.getByRole('button', {name: '進入我的商店', exact: true}).click();
    await expect(page).toHaveURL(new RegExp(storeHash + '$'));
    await expect(page.getByRole('radio', {name: /^直列目錄/})).toBeChecked();
    await expect(page.locator('.hosted-store-product')).toContainText('手作茶杯');
    const strangerPage = await stranger.newPage(); await register(strangerPage, '另一位新會員');
    await strangerPage.goto('/' + storeHash);
    await expect(strangerPage.locator('.hosted-store')).toContainText('找不到這間商店');
    await expect(strangerPage.getByRole('form', {name: '新增商品', exact: true})).toHaveCount(0);
    await page.screenshot({path: info.outputPath('registered-merchant-return.png'), fullPage: true});
    await publicPage.screenshot({path: info.outputPath('registered-merchant-public.png'), fullPage: true});
  } finally {
    await officer.close(); await stranger.close(); await publicContext.close();
    await e2eAuthPool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3', [DEMO_COMMUNITY, guild, officerId]);
  }
});
