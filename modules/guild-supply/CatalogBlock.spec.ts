import {test, expect} from '@playwright/test';

test('supply block handles viewer, read failures, existing catalog and delegated launch without a database', async ({page}) => {
  const requests: string[] = [];page.on('request', request => requests.push(request.url()));
  await page.goto('/');
  await page.getByRole('combobox', {name: '區塊', exact: true}).selectOption('guild-block.supply-catalog.v1');
  const card = page.getByRole('region', {name: '區塊畫面'});
  await expect(card.getByRole('button', {name: '山間茶作 · 示範供貨'})).toBeVisible();
  await expect(card.getByText('待辦：待確認售價申請 2、供貨版本需重新公開 1、缺貨商品 0')).toBeVisible();
  await card.getByRole('button', {name: '山間茶作 · 示範供貨'}).click();
  await expect(page.getByText(/預覽導向：#stores\/.*\/supply/)).toBeVisible();
  await card.getByRole('button', {name: '開始供貨設定'}).click();
  await expect(page.getByText(/預覽啟動：hosted-store/)).toBeVisible();
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('read_only');
  await expect(card.getByRole('button', {name: '開始供貨設定'})).toHaveCount(0);
  await expect(card.getByRole('button', {name: '山間茶作 · 示範供貨'})).toBeVisible();
  await expect(card.getByText('待辦：待確認售價申請 2、供貨版本需重新公開 1、缺貨商品 0')).toBeVisible();
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('visitor');
  await expect(card.getByText(/登入後可查看/)).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(card.getByText('山間茶作 · 示範供貨')).toHaveCount(0);
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('member');
  for (const [scenario, text] of [['loading','正在讀取供貨商品庫'], ['empty','目前沒有可讀取的供貨商品庫'], ['denied','目前身分無法讀取'], ['unavailable','此環境尚未提供'], ['error','暫時無法讀取']] as const) {
    await page.getByRole('combobox', {name: '資料情境', exact: true}).selectOption(scenario);
    await expect(card.getByText(text, {exact: false})).toBeVisible();
    if (scenario !== 'empty') await expect(card.getByRole('button', {name: '開始供貨設定'})).toHaveCount(0);
  }
  await card.getByRole('button', {name: '重新讀取'}).click();
  await expect(card.getByRole('alert')).toBeVisible();
  await page.getByRole('combobox', {name: '資料情境', exact: true}).selectOption('ready');
  await expect(card.getByRole('button', {name: '山間茶作 · 示範供貨'})).toBeVisible();
  await expect(card.getByText('待辦：待確認售價申請 2、供貨版本需重新公開 1、缺貨商品 0')).toBeVisible();
  await page.getByRole('combobox', {name: '區塊', exact: true}).selectOption('unknown');
  await expect(card.getByText(/版本目前無法使用/)).toBeVisible();
  expect(requests.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
});

test('supply example fits three themes and phone/tablet/desktop widths', async ({page}, info) => {
  await page.goto('/');await page.getByRole('combobox', {name: '區塊', exact: true}).selectOption('guild-block.supply-catalog.v1');
  await expect(page.getByRole('button', {name: '山間茶作 · 示範供貨'})).toBeVisible();
  for (const theme of ['light','dark','versefolk']) for (const width of [390,768,1440]) {
    await page.getByRole('combobox', {name: '外觀', exact: true}).selectOption(theme); await page.setViewportSize({width, height: 960});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: info.outputPath(`supply-${theme}-${width}.png`), fullPage: true});
  }
});
