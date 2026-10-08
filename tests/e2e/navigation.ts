import { expect, type Page } from './fixtures.js';

/** Member tools are secondary; open their visible disclosure before choosing one.
 * Sign-in uses the same disclosure; management may retain inline tools. */
export async function openPageTools(page:Page){
  // Wait for the actual toolbar to mount before inspecting its disclosure.
  // page.goto can finish while the first session/site reads are still pending.
  await expect(page.locator('.page-tools').first()).toBeVisible();
  const menu=page.locator('.page-tools-menu');
  if(await menu.count()){
    if(!await menu.evaluate(element=>(element as HTMLDetailsElement).open))await menu.locator(':scope > summary').click();
    await expect(menu).toHaveJSProperty('open',true);
  }
}

/** Reach the original profile/recommendation and module cards on the simple home. */
export async function expandHomeSections(page:Page){
  // Lazy home content may mount after the shell title becomes visible.
  await expect(page.locator('.home-personal')).toBeVisible();
  for(const selector of ['.home-personal','.home-module-section']){
    const section=page.locator(selector);
    if(await section.count()&&!await section.evaluate(element=>(element as HTMLDetailsElement).open))await section.locator(':scope > summary').click();
  }
}

export async function openFeatureSearch(page:Page){
  const menu=page.getByRole('button',{name:'開啟選單',exact:true});
  if(await menu.isVisible())await menu.click();
  const more=page.locator('.nav-more');
  if(!await more.evaluate(element=>(element as HTMLDetailsElement).open))await more.locator(':scope > summary').click();
}

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
  const groups = target.locator('xpath=ancestor::details');
  // Open the outer disclosure before its nested group, using visible controls.
  for (let index = 0; index < await groups.count(); index++) {
    const group = groups.nth(index);
    if (!await group.evaluate(element => (element as HTMLDetailsElement).open)) await group.locator(':scope > summary').click();
  }
  await target.click();
}

/** Choose an optional feed through the same secondary dialog a member opens. */
export async function selectSocialFeed(page: Page, name: string) {
  await page.getByRole('button', {name: '動態選項', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '動態選項', exact: true});
  await dialog.getByRole('button', {name, exact: true}).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('.social-zone')).toHaveAttribute('aria-busy', 'false');
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
