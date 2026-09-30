import {randomUUID} from 'node:crypto';
import type {Page} from '@playwright/test';
import {navigate} from './navigation.js';
import {test, expect} from './fixtures.js';
import {DEMO_COMMUNITY, DEMO_USERS} from '../../packages/testing/seed.js';
import {E2E_AUTHOR_CLAIM_ADMIN_EMAIL, E2E_AUTHOR_CLAIM_ADMIN_TOKEN} from '../../packages/testing/e2e-admin.js';

const STATEMENT = '我是這份影片工具包的原創作者，請核對 GitHub 歷史。';
const EVIDENCE = 'https://github.com/Hao0321/video-autopilot-kit';

/** A fresh schema has no unlocked books, so the search box only appears on the locked shelf. */
async function videoCard(page: Page) {
  await navigate(page, '技能書架');
  const library = page.locator('.community-library');
  const search = page.getByLabel('搜尋技能書', {exact: true});
  const locked = page.getByRole('button', {name: '未解鎖', exact: true});
  const preview = page.getByRole('button', {name: '免費預覽技能書', exact: true});
  await expect(search.or(locked).or(preview)).toBeVisible();
  if (!(await search.isVisible())) {
    if (await preview.isVisible()) await preview.click();
    else await locked.click();
  }
  await expect(search).toBeVisible();
  await search.fill('影片自動化');
  const card = library.locator('article[data-book-id="video-autopilot"]');
  const onShelf = await card.waitFor({state: 'visible', timeout: 8000}).then(() => true, () => false);
  if (!onShelf) {
    await locked.click();
    await expect(search).toBeVisible();
    await search.fill('影片自動化');
    await expect(card).toBeVisible();
  }
  return card;
}

test('member submits an original-author claim and an admin verification changes the public status', async ({page, browser, e2eAuthPool}) => {
  test.setTimeout(120_000);
  await e2eAuthPool.query(`INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)
    ON CONFLICT(email) DO UPDATE SET active=true, community_id=EXCLUDED.community_id, display_name=EXCLUDED.display_name`, [randomUUID(), DEMO_COMMUNITY, E2E_AUTHOR_CLAIM_ADMIN_EMAIL, '認領審核員']);
  await e2eAuthPool.query('DELETE FROM github_social_connections WHERE user_id=$1 OR github_user_id=$2', [DEMO_USERS[0].user_id, '9900112233']);
  await e2eAuthPool.query("INSERT INTO github_social_connections(user_id,community_id,github_user_id,github_login,encrypted_tokens) VALUES($1,$2,'9900112233','maker-claims-demo','e2e-not-a-token')", [DEMO_USERS[0].user_id, DEMO_COMMUNITY]);
  try {
    await page.setViewportSize({width: 390, height: 844});
    await page.goto('/');
    await page.getByLabel('電子郵件', {exact: true}).fill('maker@local.test');
    await page.getByLabel('密碼', {exact: true}).fill('freedom-local-demo');
    await page.getByRole('button', {name: '登入', exact: true}).click();
    const card = await videoCard(page);
    await card.getByRole('button', {name: /^(閱讀|預覽)技能書$/}).click();
    const dialog = page.getByRole('dialog', {name: '影片自動化工具包', exact: true});
    await expect(dialog.getByRole('heading', {name: '認領這件原作', exact: true})).toBeVisible();
    await dialog.getByRole('textbox', {name: '聲明', exact: true}).fill(STATEMENT);
    await dialog.getByLabel('證據網址（建議提供）').fill(EVIDENCE);
    await dialog.getByRole('checkbox', {name: '我聲明這是本人提出的角色與說明，並了解審核完成前不會顯示為已核實。'}).check();
    await dialog.getByRole('button', {name: '送出認領', exact: true}).click();
    await expect(dialog.getByText('已送出認領，等待審核。審核完成前不會顯示為已核實。')).toBeVisible();
    await expect(dialog.locator('.skill-book-badges [data-author-claim-status="pending"]')).toHaveText('認領審核中');
    await expect(dialog.locator('p[data-author-claim-status="pending"]')).toHaveText('認領審核中');
    await expect(card.locator('.skill-library-description [data-author-claim-status="pending"]')).toHaveText('認領審核中');
    for (const width of [820, 390]) {
      await page.setViewportSize({width, height: width === 820 ? 1100 : 844});
      expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }

    const adminContext = await browser.newContext({viewport: {width: 1280, height: 900}});
    const adminPage = await adminContext.newPage();
    await adminPage.route('**/admin/api/**', async route => {
      const headers = {...route.request().headers(), 'cf-access-jwt-assertion': E2E_AUTHOR_CLAIM_ADMIN_TOKEN};
      await route.continue({headers});
    });
    await adminPage.goto('/admin');
    await adminPage.getByRole('button', {name: '作者認領審核', exact: true}).click();
    const claim = adminPage.locator('article', {hasText: STATEMENT});
    await expect(claim).toBeVisible();
    await expect(claim).toContainText('88001122');
    await expect(adminPage.getByText('1382968090')).toHaveCount(0);
    for (const width of [1280, 820, 390]) {
      await adminPage.setViewportSize({width, height: 900});
      expect(await claim.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    }
    await adminPage.setViewportSize({width: 1280, height: 900});
    await claim.getByLabel('審核理由').fill('已核對公開的原作紀錄。');
    await claim.getByRole('button', {name: '核實', exact: true}).click();
    await expect(adminPage.getByText('管理操作已保存，並留下操作紀錄。')).toBeVisible();
    await adminContext.close();

    await page.setViewportSize({width: 1280, height: 900});
    await page.goto('/');
    const verifiedCard = await videoCard(page);
    const verified = verifiedCard.locator('[data-author-claim-status="verified_original_author"]');
    await expect(verified).toHaveText('已核實原作者');
    await page.setViewportSize({width: 390, height: 844});
    await expect(verified).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.goto('/development/skills/video-autopilot');
    await expect(page.locator('[data-author-claim-status="verified_original_author"]')).toHaveText('已核實原作者');
    await expect(page.locator('body')).toContainText('@maker-claims-demo');
    const html = await page.content();
    expect(html).not.toContain(STATEMENT);
    expect(html).not.toContain('已驗證');
    await page.setViewportSize({width: 820, height: 1100});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    await e2eAuthPool.query("UPDATE repo_credit_claims SET state='revoked', version=version+1 WHERE state IN ('pending','verified','disputed')");
    await e2eAuthPool.query('DELETE FROM github_social_connections WHERE user_id=$1', [DEMO_USERS[0].user_id]);
  }
});
