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
  const officerRows = () => e2eAuthPool.query(
    'SELECT user_id,appointed_at FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2', [DEMO_COMMUNITY, guild]);
  const previousOfficers = (await officerRows()).rows;
  const officer = await browser.newContext({baseURL}), stranger = await browser.newContext({baseURL}), publicContext = await browser.newContext({baseURL});
  try {
    await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
      VALUES($1,$2,$3,'商店驗收會長',$4,$5,false)`, [officerId, DEMO_COMMUNITY, officerEmail, hashPassword(DEMO_PASSWORD), randomUUID()]);
    await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
      VALUES($1,$2,$3,$4,'active','full')`, [randomUUID(), DEMO_COMMUNITY, officerId, guild]);
    // Full-suite predecessors may already have appointed a guild officer.
    // Borrow only this fixture slot, retaining its appointment time for cleanup.
    await e2eAuthPool.query(`INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,$2,$3)
      ON CONFLICT(community_id,guild_key) DO UPDATE SET user_id=EXCLUDED.user_id`, [DEMO_COMMUNITY, guild, officerId]);
    const nickname = `新店主 ${randomUUID().slice(0, 8)}`, email = await register(page, nickname);
    await guildHome(page);
    const primary = page.getByRole('region', {name: '主要動作', exact: true});
    await expect(primary).toContainText('你是這個公會的實習成員');
    await expect(primary.getByRole('button', {name: '建立我的商店', exact: true})).toHaveCount(0);
    await expect(page.getByRole('article').filter({has: page.getByRole('heading', {name: '線上商店', exact: true})})
      .getByRole('button', {name: '啟動應用', exact: true})).toBeDisabled();
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
    await setup.getByLabel('商店介紹', {exact: true}).fill('新會員親手挑選的生活器物');
    await setup.getByRole('button', {name: '建立商店', exact: true}).click();
    const product = page.getByRole('form', {name: '新增商品', exact: true});
    await product.getByLabel('商品名稱', {exact: true}).fill('手作茶杯');
    await product.getByLabel('商品介紹', {exact: true}).fill('手工製作，適合日常品茶');
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
    // Publication preserves the saved catalog content, while preview-only
    // notices/details and public navigation intentionally use different markup.
    const catalogContent = (target: Page) => target.locator('main').evaluate(main => ({
      name: main.querySelector('h1')?.textContent,
      brand: main.querySelector('.shop-eyebrow')?.textContent,
      introduction: main.querySelector('.shop-introduction')?.textContent,
      count: main.querySelector('.shop-section-heading p')?.textContent,
      products: [...main.querySelectorAll('.shop-products-list article')].map(article => ({
        title: article.querySelector('h3')?.textContent,
        price: article.querySelector('.shop-price')?.textContent,
        description: article.querySelector('.shop-product-summary')?.textContent,
        placeholder: article.querySelector('.shop-photo-placeholder')?.textContent,
      })),
    }));
    const savedCatalog = await catalogContent(preview);
    expect(savedCatalog).toEqual({
      name: '新會員選物店', brand: '獨立商店', introduction: '新會員親手挑選的生活器物', count: '1 件商品',
      products: [{title: '手作茶杯', price: '$350.00',
        description: '手工製作，適合日常品茶', placeholder: '尚未提供商品照片'}],
    });
    expect(await catalogContent(publicPage)).toEqual(savedCatalog);
    await expect(preview.locator('.shop-preview-notice')).toContainText('這是未發布的預覽');
    await expect(preview.locator('.shop-preview-description')).toContainText('手工製作，適合日常品茶');
    await expect(preview.locator('main a[href^="/shops/"], main a[href^="/#reservations/"]')).toHaveCount(0);
    await expect(preview.locator('link[rel="canonical"], meta[property^="og:"]')).toHaveCount(0);
    await expect(publicPage.locator('.shop-preview-notice, .shop-preview-description')).toHaveCount(0);
    await expect(publicPage.getByRole('link', {name: '查看商品：手作茶杯', exact: true}))
      .toHaveAttribute('href', new RegExp(`^/shops/${slug}/products/P[0-9]{4,23}$`));
    await expect(publicPage.getByRole('complementary', {name: '預留與交易說明'})).toBeVisible();
    await expect(publicPage.getByRole('link', {name: '登入查看預留狀態', exact: true}))
      .toHaveAttribute('href', '/#reservations/' + slug);
    await expect(publicPage.locator('link[rel="canonical"]')).toHaveAttribute('href', new RegExp(`/shops/${slug}$`));
    await expect(publicPage.locator('meta[property="og:title"]')).toHaveAttribute('content', '新會員選物店');
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
    try {
      await officer.close(); await stranger.close(); await publicContext.close();
    } finally {
      if (previousOfficers.length) {
        await e2eAuthPool.query(`UPDATE positioning_guild_officers SET user_id=$4
          WHERE community_id=$1 AND guild_key=$2 AND user_id=$3`, [DEMO_COMMUNITY, guild, officerId, previousOfficers[0].user_id]);
      } else {
        await e2eAuthPool.query('DELETE FROM positioning_guild_officers WHERE community_id=$1 AND guild_key=$2 AND user_id=$3', [DEMO_COMMUNITY, guild, officerId]);
      }
      expect((await officerRows()).rows).toEqual(previousOfficers);
    }
  }
});
