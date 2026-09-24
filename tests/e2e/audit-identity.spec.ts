import { mkdirSync } from 'node:fs';
import { navigate } from './navigation.js';
import { test, expect, type Page } from './fixtures.js';

// 2026-09-24 identity/guild audit. Screenshots go to test-results/audit-identity/.
const password = 'freedom-workshop-member-2026';
const shots = 'test-results/audit-identity';
mkdirSync(shots, { recursive: true });
const viewports = [['desktop', { width: 1440, height: 900 }], ['phone', { width: 390, height: 844 }]] as const;

async function pageFits(page: Page, label: string) {
  const overflow = await page.evaluate(() => {
    const width = document.documentElement.clientWidth;
    return { scroll: document.documentElement.scrollWidth, width };
  });
  expect(overflow.scroll, `${label} scrolls sideways`).toBeLessThanOrEqual(overflow.width);
}

/** One page title; no subheading repeats it and no guide block is rendered twice. */
async function oneTitle(page: Page, label: string) {
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1, label).toHaveCount(1);
  const title = (await h1.innerText()).trim();
  await expect(page.getByRole('heading', { level: 2, name: title, exact: true }), `${label} repeats its h1`).toHaveCount(0);
  expect(await page.locator('.development-context').count(), `${label} development guides`).toBeLessThanOrEqual(1);
  await pageFits(page, label);
}

async function register(page: Page, nickname: string, shotPrefix?: string) {
  const email = `audit-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  await page.goto('/');
  await expect(page.getByRole('button', { name: '登入', exact: true })).toBeVisible();
  await oneTitle(page, 'login');
  if (shotPrefix) await page.screenshot({ path: `${shots}/${shotPrefix}-login.png`, fullPage: true });
  await page.getByRole('button', { name: '建立帳號', exact: true }).click();
  await oneTitle(page, 'register');
  if (shotPrefix) await page.screenshot({ path: `${shots}/${shotPrefix}-register.png`, fullPage: true });
  await page.getByLabel('喜歡的暱稱', { exact: true }).fill(nickname);
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill(password);
  await page.getByRole('button', { name: '註冊並開始定位', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你喜歡怎麼做事？' })).toBeVisible();
  return email;
}

async function onboard(page: Page, shotPrefix?: string) {
  const progress = page.getByRole('list', { name: '定位進度', exact: true });
  const step = async (name: string) => {
    await expect(progress.locator('[aria-current=step]')).toContainText(name);
    if (!shotPrefix) return;
    // The progress list is the single step indicator.
    await expect(page.getByText(/^0\d \/ 05$/)).toHaveCount(0);
    await oneTitle(page, `onboarding ${name}`);
    await page.screenshot({ path: `${shots}/${shotPrefix}-onboarding-${name}.png`, fullPage: true });
  };
  await step('做事偏好');
  for (const field of await page.locator('.quiz-question').all()) await field.getByRole('radio').first().check();
  await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '遇到這些情境，你會怎麼做？' })).toBeVisible();
  await step('能力情境');
  for (const field of await page.locator('.quiz-question').all()) await field.getByRole('radio').first().check();
  await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你從哪裡來，帶著哪些能力？' })).toBeVisible();
  await step('認識自己');
  await page.getByRole('button', { name: '保存，繼續下一步 →', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的裝備庫' })).toBeVisible();
  await step('整理裝備');
  await page.getByRole('button', { name: '看看適合我的公會', exact: true }).click();
  const card = page.locator('.recommendation-card').first();
  await card.getByRole('checkbox').check(); await card.getByRole('radio').check();
  await step('選擇公會');
  await page.getByRole('button', { name: '確認加入公會，領取技能書', exact: true }).click();
  await expect(page.getByRole('heading', { name: '你的第一段旅程，現在開始。' })).toBeVisible();
  if (shotPrefix) await oneTitle(page, 'onboarding done');
  await page.getByRole('button', { name: '進入自由工坊 →', exact: true }).click();
  await expect(page.locator('.shell')).toBeVisible();
}

for (const [label, viewport] of viewports) {
  test(`identity pages keep one title, no sideways scroll and one page guide on ${label}`, async ({ page }) => {
    test.setTimeout(90000);
    await page.setViewportSize(viewport);
    await register(page, `審查${label}`, label);
    await onboard(page, label);
    for (const [nav, title] of [['會員首頁', '會員首頁'], ['我的定位', '我的定位'], ['職業公會', '職業公會'], ['工坊夥伴', '工坊夥伴'], ['小隊集合', '小隊集合']] as const) {
      await navigate(page, nav);
      await expect(page.getByRole('heading', { level: 1, name: title, exact: true })).toBeVisible();
      await page.waitForLoadState('networkidle');
      await expect(page.getByRole('alert')).toHaveCount(0);
      await oneTitle(page, `${label} ${title}`);
      await page.screenshot({ path: `${shots}/${label}-${title}.png`, fullPage: true });
    }
    await page.getByRole('button', { name: '我的名片', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: '我的名片', exact: true })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await oneTitle(page, `${label} 我的名片`);
    await page.screenshot({ path: `${shots}/${label}-我的名片.png`, fullPage: true });
  });

  test(`re-exploring positioning inside the workspace does not duplicate the shell on ${label}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await register(page, `重測${label}`); await onboard(page);
    await navigate(page, '我的定位');
    await page.getByRole('button', { name: '重新探索定位', exact: true }).click();
    await expect(page.getByRole('heading', { name: '你喜歡怎麼做事？' })).toBeVisible();
    const main = page.locator('#main-content');
    await expect(main.locator('.development-context')).toHaveCount(1);
    await expect(main.locator('.community-footer')).toHaveCount(0);
    await expect(main.locator('.onboarding-brand')).toHaveCount(0);
    await oneTitle(page, `${label} retake`);
    await page.screenshot({ path: `${shots}/${label}-retake.png`, fullPage: true });
    await page.getByRole('button', { name: '返回我的定位', exact: true }).click();
    await expect(page.getByRole('heading', { name: '我的定位結果', exact: true })).toBeVisible();
    // Result sections sit under the h2 rather than skipping to h4.
    await expect(page.locator('.positioning-panel h4')).toHaveCount(0);
  });
}

test('account contacts align each field with its choices and state the privacy rules once', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await register(page, '名片審查'); await onboard(page);
  await page.getByRole('button', { name: '我的名片', exact: true }).click();
  await expect(page.getByRole('combobox', { name: '我是（選填）', exact: true }).locator('option')).toHaveText(['不顯示', '男', '女', '外星人', 'AI']);
  await expect(page.getByLabel('社群顯示名稱', { exact: true })).toBeVisible();
  await expect(page.getByText(/「平台公開」涵蓋所有已登入的工坊會員/)).toHaveCount(1);
  await expect(page.getByText(/社群帳號由本人填寫，尚未驗證身分/)).toHaveCount(1);
  for (const name of ['聯絡 E-mail', 'Discord 帳號', 'GitHub 帳號', 'LINE ID']) {
    const input = await page.getByRole('textbox', { name, exact: true }).boundingBox();
    const choices = page.getByRole('group', { name: `${name}可見範圍`, exact: true });
    await expect(choices).toHaveAttribute('aria-describedby', 'contact-audience-hint');
    const box = await choices.boundingBox();
    expect(Math.abs(input!.y - box!.y), `${name} field floats away from its choices`).toBeLessThan(48);
    expect(box!.height, `${name} choices stay compact`).toBeLessThan(160);
  }
  // Checking public still explains why narrower audiences are disabled.
  const line = page.getByRole('group', { name: 'LINE ID可見範圍', exact: true });
  await line.getByRole('checkbox', { name: '平台公開', exact: true }).check();
  await expect(line.getByRole('checkbox', { name: '平台好友', exact: true })).toBeDisabled();
  await expect(line.getByText('平台公開已包含好友、小隊與公會夥伴。')).toBeVisible();
  await expect(page.locator('.account-panel .member-card')).toContainText('尚未新增社群連結。');
  await expect(page.getByRole('button', { name: '前往技能書架', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await pageFits(page, 'phone account');
  await page.screenshot({ path: `${shots}/account-privacy-phone.png`, fullPage: true });
});

test('keyboard users land on a squad after creating or opening it and return on close', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, '小隊審查'); await onboard(page);
  await navigate(page, '小隊集合');
  await expect(page.getByRole('button', { name: '新增小隊', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '成立一支小隊', exact: true }).first().click();
  const name = page.getByLabel('小隊名稱', { exact: true });
  await expect(name).toBeFocused();
  const squad = `鍵盤小隊 ${Date.now()}`;
  await page.keyboard.type(squad);
  await page.getByLabel('我們想一起完成什麼', { exact: true }).fill('用鍵盤完成一個小目標。');
  await page.getByRole('button', { name: '成立小隊', exact: true }).focus();
  await page.keyboard.press('Enter');
  const heading = page.getByRole('heading', { name: `${squad}的夥伴`, exact: true });
  await expect(heading).toBeFocused();
  await expect(heading).toBeInViewport();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await expect(heading).toHaveCount(0);
  const open = page.getByRole('button', { name: `查看${squad}`, exact: true });
  await open.focus(); await page.keyboard.press('Enter');
  await expect(heading).toBeFocused();
  await page.getByRole('button', { name: '收起', exact: true }).click();
  await expect(open).toBeFocused();
  await expect(page.getByText(/^顯示 \d+ \/ \d+ 支小隊$/)).toBeVisible();
});

test('a failed guild directory load offers a styled retry that recovers', async ({ page }) => {
  await register(page, '公會重試'); await onboard(page);
  let fail = true;
  await page.route('**/api/v1/guilds/directory', route => fail ? route.fulfill({ status: 503, body: '' }) : route.fallback());
  await navigate(page, '職業公會');
  const alert = page.getByRole('alert').filter({ has: page.getByRole('button', { name: '重新載入公會', exact: true }) });
  await expect(alert).toHaveClass(/banner-error/);
  const retry = alert.getByRole('button', { name: '重新載入公會', exact: true });
  await expect(retry).toHaveClass(/btn/);
  fail = false; await retry.click();
  await expect(page.getByRole('heading', { name: '主要與次要公會', exact: true })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
