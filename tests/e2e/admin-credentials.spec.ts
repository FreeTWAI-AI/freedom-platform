import {test, expect} from './fixtures.js';

let dropCredentialSchema: (() => Promise<void>) | undefined;
test.afterEach(async () => {
  const drop = dropCredentialSchema;
  dropCredentialSchema = undefined;
  if (drop) await drop();
});

test('admin credential card requests renewal and warns before GitHub expiry', async ({page, browser}) => {
  test.setTimeout(90_000);
  const [{Pool}, {serve}, {serveStatic}, {createPool, LOCAL_DATABASE_URL}, {migrate}, {seedLocal, DEMO_COMMUNITY, DEMO_USERS}, {createApp}, {Problem}, {randomUUID}] = await Promise.all([
    import('pg'), import('@hono/node-server'), import('@hono/node-server/serve-static'), import('../../packages/db/index'), import('../../scripts/database'), import('../../packages/testing/seed'), import('../../apps/platform-api/src/app'), import('../../packages/shared/problem'), import('node:crypto'),
  ]);
  const database = process.env.TEST_DATABASE_URL ?? LOCAL_DATABASE_URL;
  const schema = `fp_credentials_browser_${process.pid}_${Date.now()}`;
  const dbAdmin = createPool(database);
  const pool = new Pool({connectionString: database, options: `-c search_path=${schema}`, application_name: schema});
  dbAdmin.on('error', () => {});
  pool.on('error', () => {});
  const adminId = randomUUID();
  let server: ReturnType<typeof serve> | undefined;
  let clean: Awaited<ReturnType<typeof browser.newContext>> | undefined;
  let dropping: Promise<void> | undefined;
  const dropSchema = () => dropping ??= (async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    try { await pool.end(); } catch { /* still drop */ }
    await dbAdmin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND pid<>pg_backend_pid()', [schema]).catch(() => {});
    try { await dbAdmin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); } finally { await dbAdmin.end(); }
  })();
  dropCredentialSchema = dropSchema;
  try {
    await dbAdmin.query(`CREATE SCHEMA ${schema}`);
    await migrate(pool);
    await seedLocal(pool);
    await pool.query('INSERT INTO platform_admins(admin_id, community_id, email, display_name) VALUES($1,$2,$3,$4)', [adminId, DEMO_COMMUNITY, DEMO_USERS[0].email, '測試管理員']);
    let app: ReturnType<typeof createApp>;
    server = serve({fetch: request => app.fetch(request), hostname: '127.0.0.1', port: 0});
    await new Promise<void>(resolve => server!.listening ? resolve() : server!.once('listening', resolve));
    const address = server.address();
    expect(address && typeof address !== 'string').toBeTruthy();
    const origin = `http://127.0.0.1:${(address as {port: number}).port}`;
    app = createApp(pool, origin, 'local', {adminVerifier: async request => {
      if (request.headers.get('X-Synthetic-Admin') !== 'owner') throw new Problem(401, 'admin_identity_required', '請先通過管理員信箱驗證。');
      return {email: DEMO_USERS[0].email, subject: 'verified-synthetic-owner', csrfToken: 'synthetic-owner-csrf'};
    }});
    app.use('/*', serveStatic({root: './apps/portal-web/dist'}));
    app.get('*', serveStatic({path: './apps/portal-web/dist/index.html'}));
    clean = await browser.newContext();
    const plain = await clean.newPage();
    await plain.goto(origin + '/admin');
    await expect(plain.getByRole('heading', {name: '需要管理員驗證', exact: true})).toBeVisible();
    await expect(plain.getByRole('heading', {name: '憑證到期', exact: true})).toHaveCount(0);
    await expect(plain.getByText('將於')).toHaveCount(0);
    await plain.goto(origin + '/');
    await plain.getByLabel('電子郵件', {exact: true}).fill(DEMO_USERS[0].email);
    await plain.getByLabel('密碼', {exact: true}).fill('freedom-local-demo');
    await plain.getByRole('button', {name: '登入', exact: true}).click();
    await expect(plain.locator('.shell')).toBeVisible();
    await expect(plain.getByRole('heading', {name: '憑證到期', exact: true})).toHaveCount(0);
    await expect(plain.getByText('GitHub 讀取權杖')).toHaveCount(0);
    await page.context().setExtraHTTPHeaders({'X-Synthetic-Admin': 'owner'});
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(origin + '/admin');
    await expect(page.getByRole('heading', {name: '憑證到期', exact: true})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'GitHub 讀取權杖', exact: true})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Cloudflare 部署權杖', exact: true})).toBeVisible();
    await expect(page.getByText('尚未檢查', {exact: true})).toHaveCount(2);
    await expect(page.getByRole('link', {name: '在 GitHub 管理權杖', exact: true})).toHaveAttribute('href', 'https://github.com/settings/personal-access-tokens');
    const renew = page.getByRole('button', {name: '續期', exact: true});
    await expect(renew).toBeEnabled();
    const posted = page.waitForResponse(response => response.url().endsWith('/admin/api/credentials/cloudflare_deploy_token/renewals') && response.request().method() === 'POST');
    await renew.click();
    const created = await posted;
    expect(created.status()).toBe(201);
    expect(created.request().headers()['x-admin-csrf']).toBe('synthetic-owner-csrf');
    const pending = page.getByRole('button', {name: '已送出，等待維護者主機處理（通常 5 分鐘內）'});
    await expect(pending).toBeVisible();
    await expect(pending).toBeDisabled();
    expect((await pool.query('SELECT state FROM platform_credential_renewal_requests')).rows).toEqual([{state: 'pending'}]);
    await pool.query(`INSERT INTO platform_credential_status(credential_key, status, expires_at, checked_at, source)
      VALUES('github_metrics_token', 'ok', now() + interval '10 days' + interval '6 hours', now(), 'github_response')`);
    await page.getByRole('button', {name: '重新整理', exact: true}).click();
    const banner = page.getByRole('link', {name: 'GitHub 讀取權杖 將於 10 天後到期', exact: true});
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('href', '#admin-credentials');
    await expect(page.getByText('即將到期', {exact: true})).toBeVisible();
    await expect(page.getByText(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/).first()).toBeVisible();
    for (const [width, height] of [[390, 844], [820, 900], [1280, 800], [320, 720]] as const) {
      await page.setViewportSize({width, height});
      await expect(page.getByRole('heading', {name: '憑證到期', exact: true})).toBeVisible();
      await expect(banner).toBeVisible();
      await expect(pending).toBeDisabled();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px`).toBe(true);
    }
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await page.screenshot({path: 'test-results/admin-credentials-390-light.png', fullPage: true});
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({path: 'test-results/admin-credentials-390-dark.png', fullPage: true});
    await page.setViewportSize({width: 1280, height: 800});
    await page.screenshot({path: 'test-results/admin-credentials-1280-dark.png', fullPage: true});
  } finally {
    try { await clean?.close(); await page.goto('about:blank'); }
    finally { await dropSchema(); }
  }
});
