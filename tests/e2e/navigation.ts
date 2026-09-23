import { expect, type Page } from './fixtures.js';

/** Follow the same visible navigation a member uses, including phone menus and groups. */
export async function navigate(page: Page, name: string) {
  await expect(page.locator('.shell')).toBeVisible();
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
