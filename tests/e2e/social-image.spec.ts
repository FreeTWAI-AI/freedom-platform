import sharp from 'sharp';
import {randomFillSync} from 'node:crypto';
import {test, expect, type Page} from './fixtures.js';
import {navigate, selectSocialFeed} from './navigation.js';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill('maker@local.test');
  await page.getByLabel('密碼', {exact: true}).fill('freedom-local-demo');
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.locator('.shell')).toBeVisible();
  await navigate(page, '社群分享');
  await page.getByRole('button', {name: '建立貼文', exact: true}).click();
}

test('a full-size photo is prepared automatically and an unknown publication retries identical image bytes', async ({page, e2eAuthPool}) => {
  await login(page);
  const text = `E2E 原始照片 ${Date.now()}`, commands: {key: string; body: string}[] = [];
  const composer = page.getByRole('dialog', {name: '建立貼文', exact: true});
  await composer.getByLabel('貼文內容', {exact: true}).fill(text);
  // A real PNG larger than 2 MiB and wider than the server's 4096px input ceiling.
  const photo = await sharp({create: {width: 5000, height: 1200, channels: 3, background: '#2a6f4b'}}).png({compressionLevel: 0}).toBuffer();
  expect(photo.length).toBeGreaterThan(2 * 1024 * 1024);
  await composer.getByLabel('貼文圖片（選填）').setInputFiles({name: '原始照片.png', mimeType: 'image/png', buffer: photo});
  const preview = composer.getByRole('img', {name: '待發布圖片預覽'});
  await expect(preview).toHaveJSProperty('naturalWidth', 1600);
  await expect(preview).toHaveJSProperty('naturalHeight', 384);
  await expect(composer.getByRole('alert')).toHaveCount(0);
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({width, height: 900});
    expect(await composer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({path: `test-results/social-image-${width}.png`});
  }
  await page.route('**/api/v1/social-posts/notes', async route => {
    commands.push({key: route.request().headers()['idempotency-key'], body: route.request().postData()!});
    if (commands.length === 1) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await composer.getByRole('button', {name: '發布貼文', exact: true}).click();
  await expect(composer.getByRole('button', {name: '重試發布', exact: true})).toBeVisible();
  await expect(preview).toBeVisible();
  await expect(composer.getByLabel('貼文圖片（選填）')).toBeDisabled();
  const image = JSON.parse(commands[0].body).image, bytes = Buffer.from(image.data_base64, 'base64');
  expect(bytes.length).toBeLessThanOrEqual(512 * 1024);
  expect(image.mime_type).toBe('image/webp');
  const metadata = await sharp(bytes).metadata();
  expect(metadata.exif).toBeUndefined();
  await composer.getByRole('button', {name: '重試發布', exact: true}).click();
  await expect(composer).toBeHidden();
  expect(commands).toHaveLength(2); expect(commands[1]).toEqual(commands[0]);
  expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM community_social_posts WHERE note=$1', [text])).rows[0].n).toBe(1);
  await expect(page.locator('.social-card').filter({hasText: text}).locator('img.social-thumb')).toHaveJSProperty('naturalWidth', 640);
});

test('EXIF orientation, transparent small images, and invalid replacement preserve the usable draft', async ({page}) => {
  await login(page);
  const composer = page.getByRole('dialog', {name: '建立貼文', exact: true}), picker = composer.getByLabel('貼文圖片（選填）');
  await composer.getByLabel('貼文內容', {exact: true}).fill('保留這段文字');
  const jpeg = await sharp({create: {width: 1200, height: 800, channels: 3, background: '#2a6f4b'}}).withMetadata({orientation: 6}).jpeg().toBuffer();
  await picker.setInputFiles({name: 'portrait.jpg', mimeType: 'image/jpeg', buffer: jpeg});
  const preview = composer.getByRole('img', {name: '待發布圖片預覽'});
  await expect(preview).toHaveJSProperty('naturalWidth', 800);
  await expect(preview).toHaveJSProperty('naturalHeight', 1200);
  const previous = await preview.getAttribute('src');
  await picker.setInputFiles({name: 'broken.png', mimeType: 'image/png', buffer: Buffer.from('not an image')});
  await expect(composer.getByRole('alert')).toContainText('圖片無法讀取');
  await expect(preview).toHaveAttribute('src', previous!);
  await expect(composer.getByLabel('貼文內容', {exact: true})).toHaveValue('保留這段文字');
  const transparent = await sharp({create: {width: 32, height: 48, channels: 4, background: {r: 0, g: 0, b: 0, alpha: 0}}}).png().toBuffer();
  await picker.setInputFiles({name: 'transparent.png', mimeType: 'image/png', buffer: transparent});
  await expect(preview).toHaveJSProperty('naturalWidth', 32);
  await expect(preview).toHaveJSProperty('naturalHeight', 48);
  expect(await preview.evaluate(async img => {
    const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
    const context = canvas.getContext('2d')!; context.drawImage(img as HTMLImageElement, 0, 0);
    return context.getImageData(0, 0, 1, 1).data[3];
  })).toBe(0);
  await composer.getByRole('button', {name: '移除圖片', exact: true}).click();
  await expect(preview).toHaveCount(0);
  await expect(picker).toHaveValue('');
});

test('external link thumbnails accept normal photos and replacements use the same automatic preparation', async ({page}) => {
  await login(page); await page.keyboard.press('Escape');
  await page.getByRole('button', {name: '動態選項', exact: true}).click();
  await page.getByRole('button', {name: '分享外部連結', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '分享外部連結', exact: true});
  const title = `E2E 連結原始照片 ${Date.now()}`;
  await dialog.getByLabel('連結', {exact: true}).fill(`https://example.org/photo-${Date.now()}`);
  await dialog.getByLabel('標題（選填）').fill(title);
  const photo = {name: 'large.png', mimeType: 'image/png', buffer: await sharp({create: {width: 2400, height: 1600, channels: 3, background: '#2a6f4b'}}).png({compressionLevel: 0}).toBuffer()};
  const sizes: Promise<number>[] = [];
  page.on('response', response => {const request = response.request(); if (request.method() === 'PUT' && request.url().includes('/thumbnail')) sizes.push(request.allHeaders().then(headers => Number(headers['content-length'])));});
  await dialog.getByLabel('縮圖（選填，會自動調整大小）').setInputFiles(photo);
  await expect(dialog.getByText('已選擇：large.png')).toBeVisible();
  await dialog.getByRole('button', {name: '分享貼文', exact: true}).click();
  await expect(dialog).toBeHidden(); await selectSocialFeed(page, '全部動態');
  const card = page.locator('.social-card').filter({has: page.getByRole('heading', {name: title, exact: true})});
  await expect(card.locator('img.social-thumb')).toHaveJSProperty('naturalWidth', 640);
  await card.getByText('⋯', {exact: true}).click();
  await card.getByLabel('更換縮圖', {exact: true}).setInputFiles(photo);
  await expect(page.getByText('縮圖已更新。')).toBeVisible();
  await expect.poll(() => sizes.length).toBe(2); expect((await Promise.all(sizes)).every(size => size > 0 && size <= 512 * 1024)).toBe(true);
});

test('dense photos are reduced to the upload budget and oversized or animated headers are refused without losing the draft', async ({page}) => {
  await login(page);
  const composer = page.getByRole('dialog', {name: '建立貼文', exact: true}), picker = composer.getByLabel('貼文圖片（選填）');
  await composer.getByLabel('貼文內容', {exact: true}).fill('細節多的照片也不用自己壓縮');
  const noisy = await sharp(randomFillSync(Buffer.alloc(1400 * 1400 * 3)), {raw: {width: 1400, height: 1400, channels: 3}}).png().toBuffer();
  await picker.setInputFiles({name: 'detail.png', mimeType: 'image/png', buffer: noisy});
  const preview = composer.getByRole('img', {name: '待發布圖片預覽'});
  await expect(preview).toBeVisible();
  expect(await preview.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeLessThan(1400);
  const sent = page.waitForRequest(request => request.method() === 'POST' && request.url().endsWith('/social-posts/notes'));
  await composer.getByRole('button', {name: '發布貼文', exact: true}).click();
  expect(Buffer.from((await sent).postDataJSON().image.data_base64, 'base64').length).toBeLessThanOrEqual(512 * 1024);
  await expect(composer).toBeHidden();
  await page.getByRole('button', {name: '建立貼文', exact: true}).click();
  await composer.getByLabel('貼文內容', {exact: true}).fill('細節多的照片也不用自己壓縮');
  const lossless = await sharp({create: {width: 12, height: 18, channels: 3, background: 'white'}}).webp({lossless: true}).toBuffer();
  await picker.setInputFiles({name: 'small.webp', mimeType: 'image/webp', buffer: lossless});
  await expect(preview).toHaveJSProperty('naturalWidth', 12);
  await expect(preview).toHaveJSProperty('naturalHeight', 18);
  const accepted = await preview.getAttribute('src');
  const huge = await sharp({create: {width: 1, height: 1, channels: 3, background: 'white'}}).png().toBuffer();
  huge.writeUInt32BE(9000, 16); huge.writeUInt32BE(9000, 20);
  await picker.setInputFiles({name: 'dimensions.png', mimeType: 'image/png', buffer: huge});
  await expect(composer.getByRole('alert')).toContainText('解析度過高');
  const animated = Buffer.alloc(30); animated.write('RIFF', 0); animated.writeUInt32LE(22, 4); animated.write('WEBPVP8X', 8); animated.writeUInt32LE(10, 16); animated[20] = 2;
  await picker.setInputFiles({name: 'animation.webp', mimeType: 'image/webp', buffer: animated});
  await expect(composer.getByRole('alert')).toContainText('靜態');
  await expect(preview).toHaveAttribute('src', accepted!);
  await expect(composer.getByLabel('貼文內容', {exact: true})).toHaveValue('細節多的照片也不用自己壓縮');

});
