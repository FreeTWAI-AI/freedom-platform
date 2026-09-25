import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { transaction } from '../../packages/db/index.js';
import { Problem, requireCondition } from '../../packages/shared/problem.js';
import { audit, type AdminActor } from '../platform-admin/service.js';

// GitHub's documented manifest handshake:
// https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest
// https://docs.github.com/en/rest/apps/apps#create-a-github-app-from-a-manifest
const organization = 'FreeTWAI-AI', maxResponseBytes = 64 * 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const callbackInput = z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/), state: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
const appResponse = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  slug: z.string().max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  html_url: z.url(), external_url: z.url(),
  owner: z.object({ login: z.string(), type: z.literal('Organization') }),
  permissions: z.record(z.string(), z.string()), events: z.array(z.string()),
  client_id: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/),
  client_secret: z.string().min(16).max(2048),
});
type AppRow = { community_id: string; app_id: string; app_slug: string; html_url: string; client_id: string; client_secret_encrypted: string };
export type GitHubAppSetupStatus = { configured: false } | { configured: true; app_id: string; app_slug: string; html_url: string };

function publicApp(row: AppRow): GitHubAppSetupStatus {
  return { configured: true, app_id: String(row.app_id), app_slug: row.app_slug, html_url: row.html_url };
}
function encryptionKey(value: string): Buffer {
  const bytes = Buffer.from(value, 'base64');
  requireCondition(bytes.length === 32 && bytes.toString('base64') === value, 503, 'github_setup_unavailable', 'GitHub 連線設定尚未準備完成。');
  return bytes;
}
function normalizedOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new Problem(503, 'github_setup_unavailable', 'GitHub 回呼網址尚未設定完成。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  requireCondition((url.protocol === 'https:' || (url.protocol === 'http:' && local)) && !url.username && !url.password &&
    url.pathname === '/' && !url.search && !url.hash, 503, 'github_setup_unavailable', 'GitHub 回呼網址尚未設定完成。');
  return url.origin;
}
const associatedData = (community: string, appId: string, clientId: string) => Buffer.from(`github-social-app/${community}/${appId}/${clientId}`);
function encryptSecret(secret: string, key: Buffer, community: string, appId: string, clientId: string): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(associatedData(community, appId, clientId));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), encrypted.toString('base64url')].join('.');
}
function decryptSecret(row: AppRow, key: Buffer): string {
  try {
    const parts = row.client_secret_encrypted.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1' || parts.slice(1).some(part => !/^[A-Za-z0-9_-]+$/.test(part))) throw Error();
    const [, iv, tag, ciphertext] = parts.map((part, index) => index ? Buffer.from(part, 'base64url') : Buffer.alloc(0));
    if (iv.length !== 12 || tag.length !== 16 || !ciphertext.length) throw Error();
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(associatedData(row.community_id, String(row.app_id), row.client_id)); decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch { throw new Problem(503, 'github_setup_unavailable', 'GitHub 連線設定暫時無法讀取。'); }
}
async function requireAdmin(q: Pool | PoolClient, admin: AdminActor, lock = false) {
  requireCondition((await q.query(`SELECT 1 FROM platform_admins WHERE admin_id=$1 AND community_id=$2 AND email=$3 AND active${lock ? ' FOR SHARE' : ''}`,
    [admin.admin_id, admin.community_id, admin.email])).rowCount === 1, 403, 'admin_required', '管理權限已變更，請重新登入。');
}
async function setupLock(q: PoolClient, admin: AdminActor) {
  // Keep the role lock before the admin row lock, matching role mutations.
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`admin-roles/${admin.community_id}`]);
  await requireAdmin(q, admin, true);
  await q.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['github-app-setup']);
}
async function existingApp(q: Pool | PoolClient, community: string): Promise<AppRow | undefined> {
  return (await q.query('SELECT * FROM github_social_apps WHERE community_id=$1', [community])).rows[0];
}
async function ensureUnconfigured(q: PoolClient) {
  requireCondition((await q.query('SELECT 1 FROM github_social_apps LIMIT 1')).rowCount === 0, 409, 'github_app_already_configured', 'GitHub App 已設定；不會以新的 App 覆蓋既有連線。');
}

export async function githubAppSetupStatus(pool: Pool, admin: AdminActor): Promise<GitHubAppSetupStatus> {
  await requireAdmin(pool, admin);
  const existing = await existingApp(pool, admin.community_id);
  return existing ? publicApp(existing) : { configured: false };
}

export async function startGitHubAppSetup(pool: Pool, admin: AdminActor, origin: string, tokenKey: string) {
  encryptionKey(tokenKey); const site = normalizedOrigin(origin);
  return transaction(pool, async q => {
    await setupLock(q, admin); await ensureUnconfigured(q);
    // A fresh attempt replaces this admin's abandoned tab. Keep successful
    // receipts for safe callback retries, but do not accumulate expired states.
    await q.query(`DELETE FROM github_app_setup_states WHERE consumed_at IS NULL
      AND (expires_at<=now() OR (community_id=$1 AND admin_id=$2))`, [admin.community_id, admin.admin_id]);
    const state = randomBytes(32).toString('base64url');
    const saved = (await q.query(`INSERT INTO github_app_setup_states(state_hash,community_id,admin_id,origin,expires_at)
      VALUES($1,$2,$3,$4,now()+interval '10 minutes') RETURNING expires_at`, [hash(state), admin.community_id, admin.admin_id, site])).rows[0];
    const manifest = { name: `freedom-workshop-${randomBytes(6).toString('hex')}`, description: '自由工坊技能書：由會員授權，為原作者的公開作品點星星。',
      url: site, redirect_url: `${site}/admin/github/callback`, callback_urls: [`${site}/github/callback`], public: true,
      hook_attributes: { url: `${site}/github/events`, active: false }, default_permissions: { starring: 'write', metadata: 'read' } };
    return { target: `https://github.com/organizations/${organization}/settings/apps/new?state=${encodeURIComponent(state)}`,
      manifest: JSON.stringify(manifest), expires_at: (saved.expires_at as Date).toISOString() };
  });
}

async function boundedJson(response: Response): Promise<unknown> {
  const size = response.headers.get('content-length');
  if (size && (!/^\d+$/.test(size) || Number(size) > maxResponseBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new Problem(502, 'github_setup_provider_failed', 'GitHub 回傳的設定超出可讀取範圍。');
  }
  requireCondition(response.body, 502, 'github_setup_provider_failed', 'GitHub 尚未回傳完整設定。');
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      total += part.value.byteLength;
      requireCondition(total <= maxResponseBytes, 502, 'github_setup_provider_failed', 'GitHub 回傳的設定超出可讀取範圍。');
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
async function convertManifest(code: string, origin: string, fetcher: typeof fetch) {
  try {
    const response = await fetcher(`https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(10000), headers: {
        Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'Freedom-Workshop-GitHub-Setup',
      },
    });
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400) || response.status !== 201) { await response.body?.cancel().catch(() => {}); throw Error(); }
    // Zod strips PEM, webhook_secret, tokens and every other unneeded field.
    const app = appResponse.parse(await boundedJson(response));
    const expectedUrl = `https://github.com/apps/${app.slug}`;
    if (app.owner.login.toLowerCase() !== organization.toLowerCase() || normalizedOrigin(app.external_url) !== origin || app.html_url !== expectedUrl ||
      app.permissions.starring !== 'write' || app.permissions.metadata !== 'read' || Object.entries(app.permissions).some(([permission, value]) => permission !== 'starring' && !(permission === 'metadata' && value === 'read')) || app.events.length) throw Error();
    return app;
  } catch { throw new Problem(502, 'github_setup_provider_failed', 'GitHub App 尚未完成連線設定，請重試。若 GitHub 代碼已失效，請重新建立 App。'); }
}

export async function completeGitHubAppSetup(pool: Pool, admin: AdminActor, input: { code: string; state: string }, tokenKey: string, options: { fetcher?: typeof fetch } = {}): Promise<GitHubAppSetupStatus> {
  const { code, state } = callbackInput.parse(input), key = encryptionKey(tokenKey);
  return transaction(pool, async q => {
    await setupLock(q, admin);
    const pending = (await q.query(`SELECT * FROM github_app_setup_states WHERE state_hash=$1 AND admin_id=$2 AND community_id=$3 FOR UPDATE`,
      [hash(state), admin.admin_id, admin.community_id])).rows[0];
    requireCondition(pending, 400, 'github_setup_state_invalid', 'GitHub 設定連結無效，請重新開始。');
    if (pending.consumed_at) {
      requireCondition(pending.code_hash === hash(code), 409, 'github_setup_state_used', '這個 GitHub 設定連結已使用。');
      const receipt = await existingApp(q, admin.community_id);
      requireCondition(receipt && String(receipt.app_id) === String(pending.completed_app_id), 409, 'github_setup_state_used', '這個 GitHub 設定連結已使用。');
      return publicApp(receipt);
    }
    requireCondition(new Date(pending.expires_at).getTime() > Date.now(), 410, 'github_setup_state_expired', 'GitHub 設定連結已過期，請重新開始。');
    await ensureUnconfigured(q);
    // Provider errors roll back this transaction and leave the state retriable.
    // GitHub may already have consumed a code before a response was lost; that
    // case stays unconfigured and requires starting a fresh manifest setup.
    const app = await convertManifest(code, pending.origin, options.fetcher ?? fetch);
    const encrypted = encryptSecret(app.client_secret, key, admin.community_id, String(app.id), app.client_id);
    const row = (await q.query(`INSERT INTO github_social_apps(community_id,app_id,app_slug,html_url,client_id,client_secret_encrypted,configured_by)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [admin.community_id, app.id, app.slug, app.html_url, app.client_id, encrypted, admin.admin_id])).rows[0] as AppRow;
    await q.query(`UPDATE github_app_setup_states SET consumed_at=now(),code_hash=$2,completed_app_id=$3 WHERE state_hash=$1`, [hash(state), hash(code), app.id]);
    const result = publicApp(row);
    await audit(q, admin, 'github_app_setup', 'github_app', String(app.id), '建立技能書 GitHub 授權連線。', null, result);
    return result;
  });
}

/** Server-only: reload on each request so a completed setup works immediately. */
export async function readSocialConfig(pool: Pool, tokenKey: string): Promise<{ clientId: string; clientSecret: string; tokenKey: string; appId:string; appSlug:string } | null> {
  const rows = (await pool.query('SELECT * FROM github_social_apps LIMIT 2')).rows as AppRow[];
  if (!rows.length) return null;
  requireCondition(rows.length === 1, 503, 'github_setup_unavailable', 'GitHub 連線設定的社群範圍不明確。');
  return { clientId: rows[0].client_id, clientSecret: decryptSecret(rows[0], encryptionKey(tokenKey)), tokenKey,appId:String(rows[0].app_id),appSlug:rows[0].app_slug };
}
