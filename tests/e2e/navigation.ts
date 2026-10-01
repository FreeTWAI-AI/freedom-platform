import { expect, type Page } from './fixtures.js';

/** Follow the same visible navigation a member uses, including phone menus and groups. */
export async function navigate(page: Page, name: string) {
  await expect(page.locator('.shell')).toBeVisible();
  if (name === '我的訊息') {
    await page.getByRole('button', { name: /^通知/ }).click();
    await page.getByRole('button', { name: '查看所有通知與訊息' }).click();
    return;
  }
  if (['我的名片', '待辦清單'].includes(name)) {
    const settings = page.getByRole('button', { name: '設定', exact: true });
    if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
    await page.getByRole('menuitem', { name, exact: true }).click();
    return;
  }
  const menu = page.getByRole('button', { name: '開啟選單', exact: true });
  if (await menu.isVisible()) await menu.click();
  const navigation = page.getByRole('navigation', { name: '主要工作區', includeHidden: true });
  await expect(navigation).toBeVisible();
  const target = navigation.getByRole('button', { name, exact: true, includeHidden: true });
  await expect(target).toHaveCount(1);
  const group = target.locator('xpath=ancestor::details[1]');
  if (await group.count() && !await group.evaluate(element => (element as HTMLDetailsElement).open)) await group.locator(':scope > summary').click();
  await target.click();
}

/** Sign out from the profile menu: 設定 in the workspace, or the profile menu shown before onboarding is done. */
export async function signOut(page: Page) {
  const settings = page.getByRole('button', { name: '設定', exact: true });
  const preview = page.locator('.preview-profile-menu');
  await expect(settings.or(preview)).toBeVisible();
  if (await preview.isVisible()) {
    if (!await preview.evaluate(element => (element as HTMLDetailsElement).open)) await preview.locator(':scope > summary').click();
    await preview.getByRole('button', { name: '登出', exact: true }).click();
  } else {
    if (await settings.getAttribute('aria-expanded') !== 'true') await settings.click();
    await page.getByRole('menu', { name: '個人檔案' }).getByRole('menuitem', { name: '登出', exact: true }).click();
  }
  await expect(page.getByRole('heading', { name: '登入', exact: true })).toBeVisible();
}
