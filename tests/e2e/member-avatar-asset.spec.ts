import { createHash } from 'node:crypto';
import { connect } from 'node:net';
import sharp from 'sharp';
import { navigate, signOut } from './navigation.js';
import { e2eOrigin } from '../../packages/testing/e2e-origin.js';
import { DEMO_USERS } from '../../packages/testing/seed.js';
import { test, expect, type APIResponse, type Page } from './fixtures.js';
import type { Pool } from 'pg';

// The main Playwright pass shares one schema with the legacy avatar spec.
// Tests exist only in the dedicated r2_only pass, so this file adds no skips.
const enabled = process.env.FREEDOM_E2E_AVATAR_ASSET_FIXTURE === '1';
const makerId = DEMO_USERS[0].user_id;
const reviewerId = DEMO_USERS[1].user_id;

function proof(message: { op: 'list' | 'get'; key?: string }): Promise<{ ok: boolean; keys?: string[]; sha256?: string; byte_size?: number; bytes_b64?: string }> {
  return new Promise((resolve, reject) => {
    void import('../../packages/testing/e2e-avatar-asset-fixture.js').then(({ avatarAssetProofSocketPath }) => {
      const socket = connect(avatarAssetProofSocketPath());
      let raw = '', settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error('avatar proof socket timeout')), 5000);
      socket.on('error', error => fail(error));
      socket.on('data', chunk => {
        if (settled) return;
        raw += chunk;
        const newline = raw.indexOf('\n');
        if (newline < 0) {
          if (raw.length > 300_000) fail(new Error('avatar proof socket overflow'));
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.end();
        try { resolve(JSON.parse(raw.slice(0, newline))); } catch (error) { reject(error instanceof Error ? error : new Error('avatar proof socket response')); }
      });
      socket.on('close', () => { if (!settled) fail(new Error('avatar proof socket closed')); });
      // Write only after the unix socket is connected so the line is not queued into a lost buffer.
      socket.on('connect', () => socket.write(JSON.stringify(message) + '\n'));
    }, reject);
  });
}

async function loginAs(page: Page, email: string) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(email);
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('button', { name: '設定', exact: true })).toBeVisible();
  await navigate(page, '我的名片');
}

async function saveAvatar(page: Page, color: string) {
  const fixture = await sharp({ create: { width: 320, height: 240, channels: 3, background: color } }).png().toBuffer();
  const editor = page.locator('.avatar-editor');
  await expect(editor.getByRole('heading', { name: '我的頭像', exact: true })).toBeVisible();
  await editor.getByLabel('選擇頭像', { exact: true }).setInputFiles({ name: 'synthetic-avatar.png', mimeType: 'image/png', buffer: fixture });
  await expect(editor.getByRole('img', { name: '頭像預覽', exact: true })).toBeVisible();
  await editor.getByRole('button', { name: '保存頭像', exact: true }).click();
  await expect(editor.getByRole('status')).toHaveText('頭像已保存，工坊夥伴現在可以看見。');
  const savedPhoto = page.locator('.member-card .member-avatar-photo img');
  await expect(savedPhoto).toBeVisible();
  const avatarUrl = await savedPhoto.getAttribute('src');
  expect(avatarUrl).toMatch(new RegExp(`^/api/v1/members/${color === '#1f8a4c' ? makerId : reviewerId}/avatar\\?v=`));
  await expect.poll(() => savedPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(256);
  await page.reload();
  await navigate(page, '我的名片');
  await expect(savedPhoto).toHaveAttribute('src', avatarUrl!);
  await expect.poll(() => savedPhoto.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(256);
  const response = await page.request.get(avatarUrl!);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toContain('image/webp');
  const body = Buffer.from(await response.body());
  return { avatarUrl: avatarUrl!, body, digest: createHash('sha256').update(body).digest('hex') };
}

async function storedAvatar(pool: Pool, userId: string) {
  const row = (await pool.query(`SELECT a.image_bytes IS NULL AS no_legacy, a.storage_source, o.object_key, o.content_sha256, o.byte_size, o.content_type
    FROM member_avatars a JOIN member_avatar_asset_targets t USING (user_id) JOIN asset_objects o USING (asset_id)
    WHERE a.user_id=$1`, [userId])).rows[0];
  expect(row?.no_legacy).toBe(true);
  expect(row.storage_source).toBe('asset');
  expect(row.content_type).toBe('image/webp');
  return row as { object_key: string; content_sha256: string; byte_size: number };
}

async function matchesObject(digest: string, body: Buffer, objectKey: string) {
  const listed = await proof({ op: 'list' });
  expect(listed.ok).toBe(true);
  expect(listed.keys).toContain(objectKey);
  const object = await proof({ op: 'get', key: objectKey });
  expect(object.ok).toBe(true);
  expect(object.sha256).toBe(digest);
  expect(object.byte_size).toBe(body.length);
  expect(Buffer.from(object.bytes_b64 ?? '', 'base64').equals(body)).toBe(true);
}

async function jsonCode(response: APIResponse) {
  return (await response.json()).code as string;
}

if (enabled) test('no-key and revoked-key members save avatars in shared R2 while private AI stays off', async ({ page, request, e2eAuthPool }) => {
  test.setTimeout(120_000);
  const policy = (await e2eAuthPool.query(`SELECT mode, persistence_allowed, policy_revision, retained_byte_limit::text
    FROM avatar_storage_policy WHERE profile='member.avatar'`)).rows[0];
  expect(policy).toEqual({ mode: 'r2_only', persistence_allowed: true, policy_revision: 'e2e-avatar-asset-1', retained_byte_limit: '10485760' });
  const keys = (await e2eAuthPool.query(`SELECT
      (SELECT count(*)::int FROM model_connections WHERE owner_user_id=$1) maker_models,
      (SELECT count(*)::int FROM broker_model_credentials WHERE owner_user_id=$1) maker_credentials,
      (SELECT c.state FROM broker_model_credentials c WHERE c.owner_user_id=$2) reviewer_credential,
      (SELECT m.state FROM model_connections m WHERE m.owner_user_id=$2) reviewer_model,
      (SELECT count(*)::int FROM member_card_shares) shares`, [makerId, reviewerId])).rows[0];
  expect(keys).toEqual({ maker_models: 0, maker_credentials: 0, reviewer_credential: 'revoked', reviewer_model: 'revoked', shares: 0 });
  expect((await request.get(`/api/v1/members/${makerId}/avatar`)).status()).toBe(401);
  const publicToken = 'a'.repeat(43);
  const publicAvatar = await request.get(`/api/v1/public/member-cards/${publicToken}/avatar`);
  expect(publicAvatar.status()).toBe(404);
  expect(await jsonCode(publicAvatar)).toBe('avatar_not_found');
  const denied = await proof({ op: 'get', key: 'not-an-object-key' });
  expect(denied.ok).toBe(false);

  await loginAs(page, 'maker@local.test');
  const maker = await saveAvatar(page, '#1f8a4c');
  const makerRow = await storedAvatar(e2eAuthPool, makerId);
  expect(makerRow.content_sha256).toBe(maker.digest);
  expect(makerRow.byte_size).toBe(maker.body.length);
  await matchesObject(maker.digest, maker.body, makerRow.object_key);
  expect((await request.get(maker.avatarUrl)).status()).toBe(401);
  const leaked = await request.get('/' + makerRow.object_key);
  expect(leaked.headers()['content-type'] ?? '').not.toContain('image/webp');
  expect(createHash('sha256').update(Buffer.from(await leaked.body())).digest('hex')).not.toBe(maker.digest);

  await signOut(page);
  await loginAs(page, 'reviewer@local.test');
  const reviewer = await saveAvatar(page, '#3044ff');
  expect(reviewer.digest).not.toBe(maker.digest);
  const reviewerRow = await storedAvatar(e2eAuthPool, reviewerId);
  expect(reviewerRow.content_sha256).toBe(reviewer.digest);
  expect(reviewerRow.byte_size).toBe(reviewer.body.length);
  expect(reviewerRow.object_key).not.toBe(makerRow.object_key);
  await matchesObject(reviewer.digest, reviewer.body, reviewerRow.object_key);
  const both = await proof({ op: 'list' });
  expect(both.keys?.slice().sort()).toEqual([makerRow.object_key, reviewerRow.object_key].sort());

  const session = await page.request.get('/api/v1/session');
  expect(session.status()).toBe(200);
  const csrf = (await session.json()).csrf_token as string;
  await navigate(page, '私人工作與 AI');
  await expect(page.getByRole('heading', { level: 1, name: '私人工作與 AI' })).toBeVisible();
  await expect(page.getByText('模型執行服務目前無法使用。尚未確認供應商登入、模型可用性或費用。', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '執行一次推論', exact: true })).toHaveCount(0);
  for (const path of ['/api/v1/me/model-settings', '/api/v1/me/model-steps', '/api/v1/me/model-credentials', '/api/v1/me/credential-ingests']) {
    const unavailable = await page.request.get(path);
    expect(unavailable.status()).toBe(503);
    expect(await jsonCode(unavailable)).toBe('private_ai_product_unavailable');
  }
  const connections = await page.request.post('/api/v1/me/model-connections', {
    headers: { Origin: e2eOrigin(), 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, data: {},
  });
  expect(connections.status()).toBe(404);
  expect(await jsonCode(connections)).toBe('not_found');

  const before = (await e2eAuthPool.query(`SELECT
    (SELECT count(*)::int FROM asset_objects o JOIN assets a USING (asset_id) WHERE a.owner_user_id IN ($1,$2)) objects,
    (SELECT count(*)::int FROM assets WHERE state='ready' AND owner_user_id IN ($1,$2)) ready,
    (SELECT count(*)::int FROM member_avatars WHERE user_id IN ($1,$2) AND image_bytes IS NOT NULL) legacy_bytes,
    (SELECT count(*)::int FROM command_receipts WHERE operation='POST /api/v1/me/avatar' AND user_id IN ($1,$2)) receipts`, [makerId, reviewerId])).rows[0];
  expect(before).toEqual({ objects: 2, ready: 2, legacy_bytes: 0, receipts: 2 });
  const version = (await (await page.request.get('/api/v1/me/avatar')).json()).aggregate_version;
  const reject = async (contentType: string, body: Buffer, status: number, code: string) => {
    const response = await page.request.post('/api/v1/me/avatar', {
      headers: { Origin: e2eOrigin(), 'Content-Type': contentType, 'X-CSRF-Token': csrf,
        'Idempotency-Key': crypto.randomUUID(), 'If-Match': `"${version}"` },
      data: body,
    });
    expect(response.status()).toBe(status);
    expect(await jsonCode(response)).toBe(code);
  };
  await reject('image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 415, 'avatar_format');
  await reject('image/png', Buffer.alloc(2 * 1024 * 1024 + 1), 413, 'avatar_too_large');
  const after = (await e2eAuthPool.query(`SELECT
    (SELECT count(*)::int FROM asset_objects o JOIN assets a USING (asset_id) WHERE a.owner_user_id IN ($1,$2)) objects,
    (SELECT count(*)::int FROM assets WHERE state='ready' AND owner_user_id IN ($1,$2)) ready,
    (SELECT count(*)::int FROM member_avatars WHERE user_id IN ($1,$2) AND image_bytes IS NOT NULL) legacy_bytes,
    (SELECT count(*)::int FROM command_receipts WHERE operation='POST /api/v1/me/avatar' AND user_id IN ($1,$2)) receipts,
    (SELECT count(*)::int FROM member_card_shares) shares`, [makerId, reviewerId])).rows[0];
  expect(after).toEqual({ ...before, shares: 0 });
  expect((await request.get(reviewer.avatarUrl)).status()).toBe(401);
  expect((await proof({ op: 'list' })).keys?.length).toBe(2);
});
