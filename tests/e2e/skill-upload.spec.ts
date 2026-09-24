import { navigate } from './navigation.js';
import { test, expect, type Page, type Request } from './fixtures.js';

// Synthetic credentials only; the browser endpoints are mocked so no real grant is minted.
const GRANT = 'fsu_synthetic_grant_token_for_e2e_only';
const KEY = 'fsk_synthetic_cli_key_for_e2e_only';
const blurbs = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 則：這個專案幫你把重複工作整理成可重用的流程。`);
type Status = 'awaiting_upload' | 'ready_for_review' | 'published' | 'revoked';
type Recorded = { method: string; path: string; headers: Record<string, string>; body: unknown };

function submission(id: string, status: Status, version: number, withPayload = false) {
  return {
    submission_id: id, status, aggregate_version: version, project_id: status === 'published' ? 'project-1' : null,
    public_path: status === 'published' ? '/opensource' : null, created_at: '2026-09-23T01:00:00Z', updated_at: '2026-09-23T01:00:00Z',
    illustration_url: withPayload ? `/api/v1/me/skill-submissions/${id}/illustration` : null,
    grant_expires_at: status === 'awaiting_upload' ? new Date(Date.now() + 60 * 60_000).toISOString() : null,
    grant_consumed_at: withPayload ? '2026-09-23T01:00:00Z' : null,
    grant_revoked_at: status === 'revoked' ? '2026-09-23T01:00:00Z' : null,
    payload: withPayload ? {
      repository_url: 'https://github.com/example/skill-demo', title: '流程整理技能', description: '讀取 README 後整理出的真實介紹。',
      use_notes: '安裝 Node.js 後執行第一個範例。', demo_url: 'javascript:alert(1)', relationship: 'maintainer', share_introductions: blurbs,
    } : null,
  };
}

async function mockUploads(page: Page, options: { grant?: (path: string) => Record<string, string> | undefined } = {}) {
  const requests: Recorded[] = [];
  const items = new Map([
    ['sub-ready', submission('sub-ready', 'ready_for_review', 3, true)],
    ['sub-waiting', submission('sub-waiting', 'awaiting_upload', 2)],
    ['sub-revoked', submission('sub-revoked', 'revoked', 5)],
  ]);
  const keys = [{ key_id: 'key-old', label: '舊筆電', scope: 'skill:submit', expires_at: '2026-12-01T00:00:00Z', revoked_at: null as string | null }];
  let keyFailures = 1;
  const grant = options.grant ?? (() => ({ token: GRANT, expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), submit_url: '/agent-api/v1/skill-submissions/sub-new' }));
  const record = (request: Request) => {
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    requests.push({ method: request.method(), path, headers: request.headers(), body: request.postDataJSON() });
    return path;
  };
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request(), path = record(request), id = path.split('/')[3];
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64') });
    if (request.method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [...items.values()] } });
    if (request.method() === 'GET') return route.fulfill({ json: items.get(id) });
    if (path === '/me/skill-submissions') {
      const created = submission('sub-new', 'awaiting_upload', 1); items.set(created.submission_id, created);
      return route.fulfill({ status: 201, json: { submission: created, upload_grant: grant(path) } });
    }
    const current = items.get(id)!, action = path.split('/')[4];
    const next = { ...current, aggregate_version: current.aggregate_version + 1, status: action === 'revoke' ? 'revoked' : action === 'publish' ? 'published' : current.status } as ReturnType<typeof submission>;
    if (action === 'publish') Object.assign(next, { project_id: 'project-1', public_path: '/opensource' });
    items.set(id, next);
    return route.fulfill({ json: action === 'grant' ? { submission: next, upload_grant: grant(path) } : next });
  });
  await page.route('**/api/v1/me/skill-upload-keys**', async route => {
    const request = route.request(), path = record(request);
    if (request.method() === 'GET') return route.fulfill({ json: { items: keys } });
    if (path.endsWith('/revoke')) { keys[0].revoked_at = '2026-09-23T02:00:00Z'; items.get('sub-waiting')!.grant_revoked_at = '2026-09-23T02:00:00Z'; return route.fulfill({ json: keys[0] }); }
    if (keyFailures-- > 0) return route.fulfill({ status: 403, json: { title: '需要重新確認', detail: '請重新登入後再建立金鑰。' } });
    const body = request.postDataJSON() as { label: string; expires_in_days: number };
    const key = { key_id: 'key-new', label: body.label, scope: 'skill:submit', expires_at: '2026-10-23T00:00:00Z', revoked_at: null };
    keys.unshift(key);
    return route.fulfill({ status: 201, json: { key, token: KEY } });
  });
  return requests;
}

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill('maker@local.test');
  await page.getByLabel('密碼', { exact: true }).fill('freedom-local-demo');
  await page.getByRole('button', { name: '登入', exact: true }).click();
}

async function expectNoStoredSecret(page: Page, secret: string) {
  const stored = await page.evaluate(() => JSON.stringify([{ ...localStorage }, { ...sessionStorage }, location.href]));
  expect(stored).not.toContain(secret);
}

test('skill shelf issues a private scoped Agent instruction only on request and drops it on Escape', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const logs: string[] = []; page.on('console', message => logs.push(message.text()));
  const requests = await mockUploads(page);
  await login(page); await navigate(page, '技能書架');
  const trigger = page.getByRole('button', { name: '上傳技能', exact: true });
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('流程整理技能', { exact: true })).toBeVisible();
  expect(requests.filter(request => request.method === 'POST')).toEqual([]);
  await expect(dialog.locator('textarea')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/skill-upload-dialog.png' });

  await dialog.getByRole('button', { name: '產生私人上傳指令', exact: true }).click();
  const instruction = dialog.getByLabel('私人上傳指令', { exact: true });
  await expect(instruction).toBeVisible();
  const create = requests.find(request => request.method === 'POST' && request.path === '/me/skill-submissions')!;
  expect(create.headers['x-csrf-token']).toBeTruthy();
  expect(create.headers['idempotency-key']).toBeTruthy();
  expect(create.body).toEqual({});

  const origin = new URL(page.url()).origin, text = await instruction.inputValue();
  expect(text).toContain(`POST ${origin}/agent-api/v1/skill-submissions/sub-new\nAuthorization: Bearer ${GRANT}`);
  expect(text).toContain(`${origin}/development/skill-upload/SKILL.md`);
  expect(text).toContain('目前工作目錄');
  expect(text).toContain('剛好 100 則彼此不同');
  expect(text).toContain('"share_introductions"');
  expect(text.split(GRANT)).toHaveLength(2);
  await dialog.getByRole('button', { name: '複製', exact: true }).click();
  await expect(dialog.getByText('已複製，只貼給你選擇的 Agent。', { exact: true })).toBeVisible();
  const clipboard = await page.evaluate(() => navigator.clipboard.readText());
  expect(clipboard).toBe(text);
  for (const cookie of await context.cookies()) expect(clipboard).not.toContain(cookie.value);
  expect(clipboard).not.toMatch(/^cookie:/im);
  await expectNoStoredSecret(page, GRANT);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.content()).not.toContain(GRANT);
  await trigger.click();
  await expect(dialog.locator('textarea')).toHaveCount(0);
  await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expectNoStoredSecret(page, GRANT);
  expect(logs.join('\n')).not.toContain(GRANT);
});

test('replayed, expired and off-origin grants never display a token and offer a replacement grant', async ({ page }) => {
  const responses = [
    undefined,
    { token: GRANT, expires_at: '2026-01-01T00:00:00Z', submit_url: '/agent-api/v1/skill-submissions/sub-waiting' },
    { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: 'https://attacker.example/agent-api/v1/skill-submissions/sub-waiting' },
  ];
  const requests = await mockUploads(page, { grant: () => responses.shift() });
  await login(page); await navigate(page, '技能書架');
  await page.getByRole('button', { name: '上傳技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await dialog.getByRole('button', { name: '產生私人上傳指令', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('重新產生指令');
  await dialog.getByRole('button', { name: /^重新產生指令：/ }).first().click();
  await expect(dialog.getByRole('alert')).toContainText('已過期');
  const regrant = requests.find(request => request.path.endsWith('/grant'))!;
  expect(regrant.headers['if-match']).toMatch(/^"\d+"$/);
  expect(regrant.headers['x-csrf-token']).toBeTruthy();
  await dialog.getByRole('button', { name: /^重新產生指令：/ }).first().click();
  await expect(dialog.getByRole('alert')).toContainText('不是本站位址');
  await expect(dialog.locator('textarea')).toHaveCount(0);
  expect(await page.content()).not.toContain(GRANT);
  const revoked = dialog.locator('.skill-upload-item[data-status="revoked"]');
  await expect(revoked).toContainText('已撤銷');
  await expect(revoked.getByRole('button')).toHaveCount(0);
});

test('owner previews all 100 share introductions and explicitly sends with CSRF, If-Match and consent', async ({ page }) => {
  const requests = await mockUploads(page);
  let published = 0;
  await login(page); await navigate(page, '開源投稿');
  await page.route('**/api/v1/opensource/projects', route => { if (route.request().method() === 'GET') published++; return route.fallback(); });
  await page.getByRole('button', { name: '上傳技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await dialog.getByRole('button', { name: '預覽：流程整理技能', exact: true }).click();
  const preview = dialog.getByRole('region', { name: '預覽：流程整理技能', exact: true });
  await expect(preview).toContainText('讀取 README 後整理出的真實介紹。');
  await expect(preview).toContainText('安裝 Node.js 後執行第一個範例。');
  await expect(preview).toContainText('維護者（自行聲明）');
  await expect(preview.getByRole('img', { name: '流程整理技能的投稿插圖', exact: true })).toHaveAttribute('src', '/api/v1/me/skill-submissions/sub-ready/illustration');
  await expect(preview.getByRole('link', { name: 'https://github.com/example/skill-demo ↗', exact: true })).toHaveAttribute('rel', /noopener/);
  await expect(preview.locator('a[href^="javascript:"]')).toHaveCount(0);
  const list = preview.locator('.skill-upload-blurbs');
  await expect(list).not.toHaveAttribute('open');
  await list.getByText('分享短文 100 則', { exact: true }).click();
  const texts = await list.locator('li').allTextContents();
  expect(texts).toHaveLength(100); expect(new Set(texts).size).toBe(100);
  expect(await list.locator('ol').evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect(preview).toContainText('介紹、示意圖與分享短文會公開在網路上');
  await expect(preview).toContainText('社群候選作品；正式收錄另由工坊審核');

  await preview.getByRole('button', { name: '送出技能', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '技能已送出' })).toBeVisible();
  const send = requests.find(request => request.path === '/me/skill-submissions/sub-ready/publish')!;
  expect(send.body).toEqual({ consent_to_share: true });
  expect(send.headers['if-match']).toBe('"3"');
  expect(send.headers['x-csrf-token']).toBeTruthy();
  expect(send.headers['idempotency-key']).toBeTruthy();
  await expect(dialog.locator('.skill-upload-item[data-status="published"]')).toContainText('已送出');
  await expect.poll(() => published).toBeGreaterThan(0);
});

test('CLI keys keep typed fields on auth errors, show the token once and revoke without If-Match', async ({ page }) => {
  const requests = await mockUploads(page);
  await login(page); await navigate(page, '技能書架');
  const trigger = page.getByRole('button', { name: '上傳技能', exact: true });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await dialog.getByText('安裝上傳工具與長期金鑰', { exact: true }).click();
  await expect(dialog.getByRole('link', { name: '下載上傳工具', exact: true })).toHaveAttribute('href', '/downloads/freedom-skill-client.tgz');
  await expect(dialog.getByRole('link', { name: '安裝說明 ↗', exact: true })).toHaveAttribute('href', '/development/skill-upload');
  await expect(dialog).toContainText('不能送出公開');
  await expect(dialog.getByLabel('有效天數', { exact: true })).toHaveValue('30');
  await dialog.getByLabel('金鑰名稱', { exact: true }).fill('工作桌機');
  await dialog.getByLabel('有效天數', { exact: true }).fill('45');
  await dialog.getByRole('button', { name: '建立金鑰', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('請重新登入後再建立金鑰。');
  await expect(dialog.getByLabel('金鑰名稱', { exact: true })).toHaveValue('工作桌機');
  await expect(dialog.getByLabel('有效天數', { exact: true })).toHaveValue('45');
  await dialog.getByRole('button', { name: '建立金鑰', exact: true }).click();
  await expect(dialog.getByLabel('金鑰：工作桌機', { exact: true })).toHaveValue(KEY);
  await expect(dialog).toContainText('只顯示這一次');
  const issue = requests.filter(request => request.method === 'POST' && request.path === '/me/skill-upload-keys').at(-1)!;
  expect(issue.body).toEqual({ label: '工作桌機', expires_in_days: 45 });
  expect(issue.headers['x-csrf-token']).toBeTruthy();
  await expectNoStoredSecret(page, KEY);

  await dialog.getByRole('button', { name: '撤銷金鑰：工作桌機', exact: true }).click();
  const revoke = requests.find(request => request.path.endsWith('/revoke') && request.path.startsWith('/me/skill-upload-keys'))!;
  expect(revoke.headers['idempotency-key']).toBeTruthy();
  expect(revoke.headers['if-match']).toBeUndefined();
  await expect(dialog.getByLabel('金鑰：工作桌機', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText(/上傳憑證已撤銷/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  expect(await page.content()).not.toContain(KEY);
});

for (const mode of ['draft', 'key'] as const) {
  test(`closing during ${mode} issuance never restores its secret after reopening`, async ({ page }) => {
    await mockUploads(page);
    const endpoint = mode === 'draft' ? '/me/skill-submissions' : '/me/skill-upload-keys';
    let release!: () => void, pending = false;
    const responseGate = new Promise<void>(resolve => { release = resolve; });
    await page.route(`**/api/v1${endpoint}`, async route => {
      if (route.request().method() !== 'POST') return route.fallback();
      pending = true; await responseGate;
      await route.fulfill({ status: 201, json: mode === 'draft'
        ? { submission: submission('sub-delayed', 'awaiting_upload', 1), upload_grant: { token: GRANT, expires_at: new Date(Date.now() + 60 * 60_000).toISOString(), submit_url: '/agent-api/v1/skill-submissions/sub-delayed' } }
        : { key: { key_id: 'key-delayed', label: '延遲金鑰', scope: 'skill:submit', expires_at: '2099-01-01T00:00:00Z', revoked_at: null }, token: KEY } });
    });
    await login(page); await navigate(page, '技能書架');
    const trigger = page.getByRole('button', { name: '上傳技能', exact: true });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
    if (mode === 'key') {
      await dialog.getByText('安裝上傳工具與長期金鑰', { exact: true }).click();
      await dialog.getByLabel('金鑰名稱', { exact: true }).fill('延遲金鑰');
      await dialog.getByRole('button', { name: '建立金鑰', exact: true }).click();
    } else await dialog.getByRole('button', { name: '產生私人上傳指令', exact: true }).click();
    await expect.poll(() => pending).toBe(true);
    await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    await trigger.click();
    const response = page.waitForResponse(value => value.url().endsWith(`/api/v1${endpoint}`) && value.request().method() === 'POST');
    release(); await response;
    if (mode === 'key') await dialog.getByText('安裝上傳工具與長期金鑰', { exact: true }).click();
    await expect(dialog.getByRole('button', { name: mode === 'key' ? '建立金鑰' : '產生私人上傳指令', exact: true })).toBeEnabled();
    await expect(dialog.locator('textarea')).toHaveCount(0);
    expect(await page.content()).not.toContain(mode === 'draft' ? GRANT : KEY);
    await expectNoStoredSecret(page, mode === 'draft' ? GRANT : KEY);
  });
}

test('open-source panel keeps manual GitHub form folded and the upload dialog fits a 320px phone', async ({ page }) => {
  await mockUploads(page);
  await page.setViewportSize({ width: 320, height: 720 });
  await login(page); await navigate(page, '開源投稿');
  const manual = page.locator('details.manual-upload');
  await expect(manual).not.toHaveAttribute('open');
  await expect(page.getByRole('heading', { name: '登錄開源作品', exact: true })).toBeHidden();
  await manual.getByText('手動上傳', { exact: true }).click();
  await expect(manual.getByRole('heading', { name: '登錄開源作品', exact: true })).toBeVisible();
  await expect(manual.getByRole('button', { name: '從 GitHub 登錄', exact: true })).toBeVisible();

  const trigger = page.getByRole('button', { name: '上傳技能', exact: true });
  await expect(trigger).toHaveCount(1);
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await dialog.getByText('安裝上傳工具與長期金鑰', { exact: true }).click();
  await page.screenshot({ path: 'test-results/skill-upload-phone.png' });
  await dialog.getByRole('button', { name: '產生私人上傳指令', exact: true }).click();
  await expect(dialog.getByLabel('私人上傳指令', { exact: true })).toBeVisible();
  const layout = await dialog.evaluate(element => ({
    fits: element.scrollWidth <= element.clientWidth && element.getBoundingClientRect().right <= window.innerWidth,
    page: document.documentElement.scrollWidth <= window.innerWidth,
    small: [...element.querySelectorAll<HTMLElement>('button, a.btn, summary')].filter(control => control.offsetParent && control.getBoundingClientRect().height < 44).map(control => control.textContent),
    fonts: [...element.querySelectorAll<HTMLElement>('input, textarea')].map(field => parseFloat(getComputedStyle(field).fontSize)),
  }));
  expect(layout.fits).toBe(true);
  expect(layout.page).toBe(true);
  expect(layout.small).toEqual([]);
  expect(Math.min(...layout.fonts)).toBeGreaterThanOrEqual(16);
});
