import { test, expect, type Page } from '@playwright/test';
import sharp from 'sharp';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '登出', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '我的名片', exact: true }).click();
}

test('member previews, saves, reloads and removes a synthetic avatar without saving nickname drafts', async ({ page, request }) => {
  await login(page);
  const fixture = await sharp({ create: { width: 320, height: 240, channels: 3, background: '#c4ff20' } }).png().toBuffer();
  const editor = page.locator('.avatar-editor');
  await expect(editor.getByRole('heading', { name: '我的頭像', exact: true })).toBeVisible();
  const nickname = page.getByLabel('喜歡的暱稱', { exact: true }), originalNickname = await nickname.inputValue();
  await nickname.fill('尚未保存的暱稱草稿');
  await editor.getByLabel('選擇頭像', { exact: true }).setInputFiles({ name: 'synthetic-avatar.png', mimeType: 'image/png', buffer: fixture });
  await expect(editor.getByRole('img', { name: '頭像預覽', exact: true })).toBeVisible();
  await expect(editor.getByText('尚未保存的預覽', { exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '保存頭像', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('頭像已保存，工坊夥伴現在可以看見。');
  await expect(nickname).toHaveValue('尚未保存的暱稱草稿');
  const savedPhoto = page.locator('.member-card .member-avatar-photo img');
  await expect(savedPhoto).toBeVisible();
  const avatarUrl = await savedPhoto.getAttribute('src');
  expect(avatarUrl).toMatch(/^\/api\/v1\/members\/[0-9a-f-]+\/avatar\?v=/);
  await expect.poll(() => savedPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(256);
  const anonymous = await request.get(avatarUrl!);
  expect(anonymous.status()).toBe(401);
  await page.reload();
  await page.getByRole('button', { name: '我的名片', exact: true }).click();
  await expect(nickname).toHaveValue(originalNickname);
  await expect(savedPhoto).toHaveAttribute('src', avatarUrl!);
  await expect.poll(() => savedPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(256);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await editor.getByRole('button', { name: '移除頭像', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('頭像已移除。');
  await expect(savedPhoto).toHaveCount(0);
  expect((await page.request.get(avatarUrl!)).status()).toBe(404);
  await page.reload();
  await page.getByRole('button', { name: '我的名片', exact: true }).click();
  await expect(editor.getByRole('heading', { name: '我的頭像', exact: true })).toBeVisible();
  await expect(savedPhoto).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '移除頭像', exact: true })).toHaveCount(0);
});

test('avatar editor rejects oversized or unsupported files and safely cancels a preview', async ({ page }) => {
  await login(page);
  const editor = page.locator('.avatar-editor'), input = editor.getByLabel('選擇頭像', { exact: true });
  await input.setInputFiles({ name: 'unsupported.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>') });
  await expect(editor.getByRole('alert')).toHaveText('請選擇 JPEG、PNG 或 WebP 圖片。');
  await expect(editor.getByRole('button', { name: '保存頭像', exact: true })).toBeDisabled();
  await input.setInputFiles({ name: 'too-large.png', mimeType: 'image/png', buffer: Buffer.alloc(2 * 1024 * 1024 + 1) });
  await expect(editor.getByRole('alert')).toHaveText('圖片需為 2 MB 以下的檔案。');
  const fixture = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#3044ff' } }).png().toBuffer();
  await input.setInputFiles({ name: 'synthetic-preview.png', mimeType: 'image/png', buffer: fixture });
  await expect(editor.getByRole('img', { name: '頭像預覽', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '取消預覽', exact: true }).click();
  await expect(editor.getByRole('img', { name: '頭像預覽', exact: true })).toHaveCount(0);
  await expect(editor.getByRole('button', { name: '保存頭像', exact: true })).toBeDisabled();
});

test('avatar editor reconciles a historical mutation receipt with a newer removal', async ({ page }) => {
  await login(page);
  const fixture = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#c4ff20' } }).png().toBuffer();
  await page.route('**/api/v1/me/avatar', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch(), receipt = await response.json();
    // A second tab removes the photo before the first tab receives its
    // successful (now historical) upload receipt.
    const removed = await page.request.post('/api/v1/me/avatar/remove', {
      headers: { Origin: 'http://127.0.0.1:4311', 'X-CSRF-Token': route.request().headers()['x-csrf-token'], 'Idempotency-Key': crypto.randomUUID(), 'If-Match': `"${receipt.aggregate_version}"` }, data: {},
    });
    expect(removed.status()).toBe(200);
    await route.fulfill({ response });
  });
  const editor = page.locator('.avatar-editor');
  await editor.getByLabel('選擇頭像', { exact: true }).setInputFiles({ name: 'synthetic-race.png', mimeType: 'image/png', buffer: fixture });
  await editor.getByRole('button', { name: '保存頭像', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('頭像已在其他視窗更新，這裡顯示的是目前版本。');
  await expect(editor.getByRole('button', { name: '移除頭像', exact: true })).toHaveCount(0);
  await expect(page.locator('.member-card .member-avatar-photo img')).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/me/avatar')).json()).avatar_url).toBeNull();
});

test('avatar confirmation failure offers a read-only retry without claiming the photo is visible', async ({ page }) => {
  await login(page);
  let blockRead = true, uploads = 0;
  await page.route('**/api/v1/me/avatar', async route => {
    if (route.request().method() === 'POST') { uploads++; await route.continue(); return; }
    if (blockRead) { blockRead = false; await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'Synthetic read failure' }) }); return; }
    await route.continue();
  });
  const fixture = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#3044ff' } }).png().toBuffer();
  const editor = page.locator('.avatar-editor');
  await editor.getByLabel('選擇頭像', { exact: true }).setInputFiles({ name: 'synthetic-recovery.png', mimeType: 'image/png', buffer: fixture });
  await editor.getByRole('button', { name: '保存頭像', exact: true }).click();
  await expect(editor.getByRole('alert')).toHaveText('操作已完成，但目前頭像暫時讀取失敗。請重新確認頭像。');
  await expect(editor.getByText('頭像已保存，工坊夥伴現在可以看見。', { exact: true })).toHaveCount(0);
  await expect(editor.getByLabel('選擇頭像', { exact: true })).toBeDisabled();
  await editor.getByRole('button', { name: '重新確認頭像', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('已重新確認目前頭像。');
  await expect(page.locator('.member-card .member-avatar-photo img')).toBeVisible();
  expect(uploads).toBe(1);
  await editor.getByRole('button', { name: '移除頭像', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('頭像已移除。');
});
