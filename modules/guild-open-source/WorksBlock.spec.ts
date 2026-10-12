import {test, expect} from '@playwright/test';

test('open-source block retains separate private work and published submission flows', async ({page}) => {
  await page.goto('/');await page.getByRole('combobox', {name: '區塊', exact: true}).selectOption('guild-block.open-source-works.v1');
  const card = page.getByRole('region', {name: '區塊畫面'});
  await expect(card.getByText('社區活動行事曆 · 合成開源作品')).toBeVisible();
  await expect(card.getByText(/作品 · 私人草稿/)).toBeVisible();
  await expect(card.getByText(/技能投稿 · 已發布/)).toBeVisible();
  await card.getByRole('button', {name: '查看我的內容'}).click();await expect(page.getByText('預覽導向：#my-content')).toBeVisible();
  await card.getByRole('button', {name: '準備技能投稿'}).click();await expect(page.getByText('預覽導向：#opensource')).toBeVisible();
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('read_only');await expect(card.getByRole('button', {name: '準備技能投稿'})).toHaveCount(0);
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('visitor');await expect(card.getByText(/登入後可查看/)).toBeVisible();await expect(card.getByText('社區活動行事曆 · 合成開源作品')).toHaveCount(0);
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('member');
  for (const [scenario, text] of [['empty','還沒有作品或技能投稿'],['denied','目前身分無法讀取'],['error','暫時無法讀取']] as const) {
    await page.getByRole('combobox', {name: '資料情境', exact: true}).selectOption(scenario); await expect(card.getByText(text, {exact: false})).toBeVisible();
  }
});
