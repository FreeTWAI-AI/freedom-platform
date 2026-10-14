import {test, expect} from '@playwright/test';

const eventId = (n: number) => `70000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const earlier = '晨間讀書會 · 示範活動';
const later = '山間茶席 · 稍後場';
const hidden = ['別的公會夜談', '尚未送出的草稿', '已經結束的茶會', '尚未完成入會的活動列', '待審核的交流'];

test('upcoming events block keeps only this guild’s future published rows', async ({page}) => {
  const requests: string[] = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/');
  await page.getByRole('combobox', {name: '區塊', exact: true}).selectOption('guild-block.upcoming-events.v1');
  const card = page.getByRole('region', {name: '區塊畫面'});
  const rows = card.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0).getByRole('button')).toHaveText(earlier);
  await expect(rows.nth(0)).toContainText('線上');
  await expect(rows.nth(1).getByRole('button')).toHaveText(later);
  await expect(rows.nth(1)).toContainText('實體');
  for (const title of hidden) await expect(card.getByText(title)).toHaveCount(0);
  await rows.nth(0).getByRole('button', {name: earlier}).click();
  await expect(page.getByText(`預覽導向：#events/${eventId(11)}`, {exact: true})).toBeVisible();
  await card.getByRole('button', {name: '查看全部活動', exact: true}).click();
  await expect(page.getByText('預覽導向：#events', {exact: true})).toBeVisible();
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('read_only');
  await expect(card.getByRole('button', {name: earlier})).toBeVisible();
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('visitor');
  await expect(card.getByText(/登入後可查看/)).toBeVisible();
  await expect(card.getByRole('button')).toHaveCount(0);
  await expect(card.getByText(earlier)).toHaveCount(0);
  await page.getByRole('combobox', {name: '檢視身分', exact: true}).selectOption('member');
  for (const [scenario, text] of [['loading', '正在讀取近期活動'], ['empty', '這個公會目前沒有近期活動'], ['denied', '目前身分無法讀取'], ['unavailable', '此環境尚未提供'], ['error', '暫時無法讀取']] as const) {
    await page.getByRole('combobox', {name: '資料情境', exact: true}).selectOption(scenario);
    await expect(card.getByText(text, {exact: false})).toBeVisible();
    await expect(card.getByText(earlier)).toHaveCount(0);
    await expect(card.getByText(later)).toHaveCount(0);
    for (const title of hidden) await expect(card.getByText(title)).toHaveCount(0);
    if (scenario !== 'empty') await expect(card.getByRole('button', {name: '查看全部活動'})).toHaveCount(0);
  }
  await card.getByRole('button', {name: '重新讀取'}).click();
  await expect(card.getByRole('alert')).toBeVisible();
  await page.getByRole('combobox', {name: '資料情境', exact: true}).selectOption('missing-key');
  await expect(card.getByText('這個區塊需要在公會頁使用，才能列出公會活動。')).toBeVisible();
  await expect(card.getByText(earlier)).toHaveCount(0);
  await expect(card.getByRole('button', {name: '查看全部活動'})).toHaveCount(0);
  for (const title of hidden) await expect(card.getByText(title)).toHaveCount(0);
  await page.getByRole('combobox', {name: '資料情境', exact: true}).selectOption('ready');
  await expect(rows.nth(0).getByRole('button')).toHaveText(earlier);
  expect(requests.filter(url => new URL(url).pathname.startsWith('/api/'))).toEqual([]);
});

test('upcoming events example fits three themes and phone/tablet/desktop widths', async ({page}, info) => {
  await page.goto('/');
  await page.getByRole('combobox', {name: '區塊', exact: true}).selectOption('guild-block.upcoming-events.v1');
  await expect(page.getByRole('button', {name: earlier})).toBeVisible();
  for (const theme of ['light', 'dark', 'versefolk']) for (const width of [390, 768, 1440]) {
    await page.getByRole('combobox', {name: '外觀', exact: true}).selectOption(theme);
    await page.setViewportSize({width, height: 960});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: info.outputPath(`events-${theme}-${width}.png`), fullPage: true});
  }
});
