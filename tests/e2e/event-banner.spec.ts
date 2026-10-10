import sharp from 'sharp';
import {test, expect, type Page} from './fixtures.js';
import {navigate} from './navigation.js';

async function createDraft(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill('maker@local.test');
  await page.getByLabel('密碼', {exact: true}).fill('freedom-local-demo');
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await navigate(page, '社群活動');
  await page.getByRole('button', {name: '＋ 提交活動'}).click();
  const form = page.locator('form.experience-editor');
  const title = `自動處理海報 ${Date.now()}`;
  await form.getByLabel('活動名稱').fill(title);
  await form.getByLabel('活動說明').fill('保留活動說明與原始海報，不必自己壓縮。');
  await form.getByLabel('線上場地').fill('Discord 讀書會場地');
  return {form, title};
}

async function holdDecoder(page: Page) {
  // Hold the real browser decoder, then release it after the form has changed.
  await page.evaluate(() => {
    const decode = window.createImageBitmap.bind(window);
    Object.assign(window, {releasePoster: () => {}});
    window.createImageBitmap = ((...args: Parameters<typeof createImageBitmap>) => new Promise<ImageBitmap>(resolve => {
      Object.assign(window, {releasePoster: async () => resolve(await decode(...args))});
    })) as typeof createImageBitmap;
    Object.assign(window, {restorePosterDecoder: () => {window.createImageBitmap = decode;}});
  });
}

test('large event posters are prepared on create and edit, preserving orientation and a usable draft after invalid input', async ({page}, testInfo) => {
  const {form, title} = await createDraft(page);
  for (const width of [390, 1440]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 900});
    await form.getByLabel('活動海報（選填）').scrollIntoViewIfNeeded();
    await page.screenshot({path: testInfo.outputPath(`before-selection-${width}.png`)});
  }
  const original = await sharp({create: {width: 5000, height: 1200, channels: 3, background: '#366177'}}).png({compressionLevel: 0}).toBuffer();
  expect(original.length).toBeGreaterThan(512 * 1024);
  const uploads: {bytes: Buffer; type: string; orientation: string}[] = [];
  await page.route('**/api/v1/events/*/banner', async route => {
    const request = route.request();
    if (request.method() === 'POST') uploads.push({bytes: request.postDataBuffer()!, type: request.headers()['content-type'], orientation: request.headers()['x-poster-orientation']});
    await route.continue();
  });
  await form.getByLabel('活動海報（選填）').setInputFiles({name: '原始海報.png', mimeType: 'image/png', buffer: original});
  await expect(form.getByText('已選擇 原始海報.png', {exact: false})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({width, height: width === 390 ? 844 : 900});
    await form.getByLabel('活動海報（選填）').scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({path: testInfo.outputPath(`prepared-${width}.png`)});
  }
  await form.getByRole('button', {name: '送出審核'}).click();
  const card = page.locator('.experience-card').filter({has: page.getByRole('heading', {name: title, exact: true})});
  await expect(card.locator('.experience-banner-image')).toBeVisible();
  expect(uploads).toHaveLength(1);
  expect(uploads[0].type).toBe('image/webp');
  expect(uploads[0].bytes.length).toBeLessThanOrEqual(512 * 1024);
  expect(uploads[0].orientation).toBe('landscape');
  expect(await sharp(uploads[0].bytes).metadata()).toMatchObject({width: 1600, height: 384});

  await card.getByRole('button', {name: '編輯草稿'}).click();
  const picker = card.getByLabel('活動海報（選填）');
  const portrait = await sharp({create: {width: 1200, height: 800, channels: 3, background: '#366177'}}).withMetadata({orientation: 6}).jpeg().toBuffer();
  await picker.setInputFiles({name: '直式照片.jpg', mimeType: 'image/jpeg', buffer: portrait});
  await expect(card.getByText('已選擇 直式照片.jpg', {exact: false})).toBeVisible();
  await picker.setInputFiles({name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image')});
  await expect(page.getByRole('alert')).toContainText('圖片無法讀取');
  await expect(card.getByText('已選擇 直式照片.jpg', {exact: false})).toBeVisible();
  await expect(card.getByLabel('活動說明')).toHaveValue('保留活動說明與原始海報，不必自己壓縮。');
  await expect(card.getByRole('button', {name: '儲存修改'})).toBeDisabled();
  await picker.setInputFiles({name: '直式照片.jpg', mimeType: 'image/jpeg', buffer: portrait});
  await card.getByRole('button', {name: '儲存修改'}).click();
  await expect(card.locator('form')).toHaveCount(0);
  expect(uploads).toHaveLength(2);
  expect(uploads[1].orientation).toBe('portrait');
  expect(uploads[1].bytes.length).toBeLessThanOrEqual(512 * 1024);
  const metadata = await sharp(uploads[1].bytes).metadata();
  expect(metadata).toMatchObject({width: 800, height: 1200});
  expect(metadata.exif).toBeUndefined();
});

test('pending poster processing blocks submission and cannot overwrite a replacement or a reopened form', async ({page}) => {
  const {form} = await createDraft(page);
  await holdDecoder(page);
  const image = await sharp({create: {width: 120, height: 80, channels: 3, background: '#366177'}}).png().toBuffer();
  await form.getByLabel('活動海報（選填）').setInputFiles({name: '舊照片.png', mimeType: 'image/png', buffer: image});
  await expect(form.getByRole('status')).toHaveText('正在處理圖片…');
  await expect(form.getByRole('button', {name: '送出審核'})).toBeDisabled();
  await page.evaluate(() => (window as unknown as {restorePosterDecoder(): void}).restorePosterDecoder());
  await form.getByLabel('活動海報（選填）').setInputFiles({name: '新照片.png', mimeType: 'image/png', buffer: image});
  await expect(form.getByText('已選擇 新照片.png', {exact: false})).toBeVisible();
  await page.evaluate(() => (window as unknown as {releasePoster(): Promise<void>}).releasePoster());
  await expect(form.getByText('已選擇 新照片.png', {exact: false})).toBeVisible();
  await expect(form.getByText('已選擇 舊照片.png', {exact: false})).toHaveCount(0);
  await holdDecoder(page);
  await form.getByLabel('活動海報（選填）').setInputFiles({name: '取消的照片.png', mimeType: 'image/png', buffer: image});
  await expect(form.getByRole('status')).toHaveText('正在處理圖片…');
  await form.getByRole('button', {name: '返回', exact: true}).click();
  await page.getByRole('button', {name: '＋ 提交活動'}).click();
  await page.evaluate(() => (window as unknown as {releasePoster(): Promise<void>}).releasePoster());
  await expect(form.getByText('已選擇', {exact: false})).toHaveCount(0);
  await expect(form.getByRole('status')).toHaveCount(0);
  await expect(form.getByRole('button', {name: '送出審核'})).toBeEnabled();
});
