import { navigate } from './navigation.js';
import { test, expect, type Locator, type Page } from './fixtures.js';
import { DEMO_PASSWORD, DEMO_USERS } from '../../packages/testing/seed.js';

const GRANT = 'fsu_synthetic_grant_token_for_e2e_only';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const blurbs = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 則：這個專案幫你把重複工作整理成可重用的流程。`);

function submission(id: string, status: 'awaiting_upload' | 'ready_for_review' | 'published', extra: Record<string, unknown> = {}) {
  const ready = status !== 'awaiting_upload';
  return {
    submission_id: id, status, aggregate_version: ready ? 3 : 1,
    project_id: status === 'published' ? 'project-1' : null,
    public_path: status === 'published' ? '/development/submissions/project-1' : null,
    created_at: '2026-09-23T01:00:00Z', updated_at: '2026-09-23T01:00:00Z',
    illustration_url: ready ? `/api/v1/me/skill-submissions/${id}/illustration` : null,
    grant_expires_at: null, grant_consumed_at: ready ? '2026-09-23T01:00:00Z' : null, grant_revoked_at: null,
    payload: ready ? {
      repository_url: 'https://github.com/example/skill-demo', title: '流程整理技能', description: '讀取 README 後整理出的真實介紹。',
      use_notes: '安裝 Node.js 後執行第一個範例。', demo_url: null, relationship: 'curator', share_introductions: blurbs,
    } : null,
    seed: null, upgrades_submission_id: null, catalog_book: null,
    ...extra,
  };
}

const seed = {
  repository_url: 'https://github.com/example/seeded-book', title: '種子技能', description: '登錄時寫的介紹。',
  use_notes: '先閱讀 README。', demo_url: null, relationship: 'curator',
};

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', { exact: true }).fill(DEMO_USERS[0].email);
  await page.getByLabel('密碼', { exact: true }).fill(DEMO_PASSWORD);
  await page.getByRole('button', { name: '登入', exact: true }).click();
  await expect(page.getByRole('heading', { name: '會員首頁', exact: true })).toBeVisible({ timeout: 20_000 });
}

async function settleIllustration(dialog: Locator) {
  const image = dialog.locator('.skill-upload-illustration');
  if (await image.count() === 0) return;
  await image.evaluate(element => element instanceof HTMLImageElement && element.complete ? undefined : new Promise<void>(resolve => {
    element.addEventListener('load', () => resolve(), { once: true });
    element.addEventListener('error', () => resolve(), { once: true });
  }));
}

async function expectInsideDialog(locator: Locator) {
  await expect(locator).toBeVisible();
  await expect.poll(() => locator.evaluate(element => {
    if (!element.isConnected) return false;
    const dialog = element.closest('dialog') as HTMLElement | null;
    if (!dialog) return false;
    const box = element.getBoundingClientRect();
    const dialogBox = dialog.getBoundingClientRect();
    const header = dialog.querySelector('.skill-upload-header')?.getBoundingClientRect();
    const style = getComputedStyle(dialog);
    const top = Math.max(dialogBox.top + (Number.parseFloat(style.borderTopWidth) || 0), header?.bottom ?? dialogBox.top);
    const bottom = dialogBox.bottom - (Number.parseFloat(style.borderBottomWidth) || 0);
    const left = dialogBox.left + (Number.parseFloat(style.borderLeftWidth) || 0);
    const right = dialogBox.right - (Number.parseFloat(style.borderRightWidth) || 0);
    return box.height > 0 && box.top >= top - 1 && box.bottom <= bottom + 1 && box.left >= left - 1 && box.right <= right + 1 && box.top >= -1 && box.bottom <= window.innerHeight + 1;
  }), 'element was not inside the dialog\'s visible area').toBe(true);
}

async function expectFullyInView(locator: Locator) {
  await expect(locator).toBeVisible();
  const placed = await locator.evaluate(element => {
    const button = element.getBoundingClientRect();
    const dialog = element.closest('dialog')!.getBoundingClientRect();
    const inside = (left: number, top: number, right: number, bottom: number) => button.left >= left - 1 && button.top >= top - 1 && button.right <= right + 1 && button.bottom <= bottom + 1;
    return {
      inDialog: inside(dialog.left, dialog.top, dialog.right, dialog.bottom),
      inView: inside(0, 0, window.innerWidth, window.innerHeight),
      height: button.height,
    };
  });
  expect(placed.inDialog).toBe(true);
  expect(placed.inView).toBe(true);
  expect(placed.height).toBeGreaterThanOrEqual(44);
}

function contrastOf(element: Element) {
  const style = getComputedStyle(element);
  const read = (value: string) => {
    const parts = value.match(/[\d.]+/g)?.map(Number) ?? [];
    return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts.length > 3 ? parts[3] : 1 };
  };
  const channel = (value: number) => { const s = value / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const luminance = (color: { r: number; g: number; b: number }) => 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
  const background = read(style.backgroundColor), foreground = read(style.color);
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return { alpha: background.a, ratio: (lighter + 0.05) / (darker + 0.05) };
}

test('a ready draft callout opens the preview with 送出技能 already in view', async ({ page }) => {
  const ready = submission('sub-ready', 'ready_for_review');
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (route.request().method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [ready] } });
    if (route.request().method() === 'GET') return route.fulfill({ json: ready });
    return route.fulfill({ json: ready });
  });
  await login(page);
  await navigate(page, '技能書架');
  const callout = page.locator('.skill-draft-callout');
  await expect(callout).toContainText('1 份技能草稿待你送出：流程整理技能');
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await callout.getByRole('button', { name: '預覽並送出', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
    const order = await dialog.evaluate(element => {
      const headings = [...element.querySelectorAll('h3')].map(node => node.textContent);
      return headings.indexOf('我的私人技能草稿') >= 0 && headings.indexOf('我的私人技能草稿') < headings.indexOf('交給 Agent 讀取專案');
    });
    expect(order).toBe(true);
    await expect(dialog.getByRole('region', { name: '預覽：流程整理技能', exact: true })).toBeVisible();
    await settleIllustration(dialog);
    await expectFullyInView(dialog.getByRole('button', { name: '送出技能', exact: true }));
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});

test('a seeded draft is completed in chat, and a different repository does not reuse it', async ({ page }) => {
  const seeded = submission('sub-seed', 'awaiting_upload', { seed, upgrades_submission_id: 'project-seed', aggregate_version: 1 });
  const seededReady = submission('sub-seed', 'ready_for_review', { seed, upgrades_submission_id: 'project-seed' });
  const grants: string[] = [];
  const uploads: string[] = [];
  let seedUploaded = false;
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (request.method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [seeded] } });
    if (request.method() === 'GET') return route.fulfill({ json: path.endsWith('/sub-seed') ? (seedUploaded ? seededReady : seeded) : submission('sub-new', 'ready_for_review') });
    if (path === '/me/skill-submissions' && request.method() === 'POST') {
      const created = submission('sub-new', 'awaiting_upload', { aggregate_version: 1 });
      return route.fulfill({ status: 201, json: { submission: created, upload_grant: { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: '/agent-api/v1/skill-submissions/sub-new' } } });
    }
    if (path.endsWith('/grant')) {
      grants.push(path);
      const id = path.split('/')[3];
      return route.fulfill({ json: { submission: { ...(id === 'sub-seed' ? seeded : submission('sub-new', 'awaiting_upload')), aggregate_version: 2 }, upload_grant: { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: `/agent-api/v1/skill-submissions/${id}` } } });
    }
    if (path.endsWith('/publish')) return route.fulfill({ json: submission('sub-seed', 'published', { seed, upgrades_submission_id: 'project-seed' }) });
    return route.fulfill({ json: seeded });
  });
  await page.route('**/agent-api/v1/skill-submissions/**', async route => {
    const path = new URL(route.request().url()).pathname;
    uploads.push(path);
    const id = path.split('/').pop();
    if (id === 'sub-seed') seedUploaded = true;
    return route.fulfill({ json: id === 'sub-seed' ? seededReady : submission('sub-new', 'ready_for_review') });
  });
  await login(page);
  await navigate(page, '技能書架');
  await page.getByRole('button', { name: '上傳技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  const paste = dialog.getByRole('textbox', { name: '貼上 JSON', exact: true });
  await paste.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await paste.fill(JSON.stringify({ repository_url: 'https://github.com/example/other-book', title: '另一件' }));
  await dialog.getByRole('button', { name: '用這份 JSON 建立草稿', exact: true }).click();
  await expect.poll(() => uploads.length).toBe(1);
  expect(uploads[0]).toContain('/sub-new');
  expect(grants.some(path => path.includes('sub-seed'))).toBe(false);
  await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();

  const callout = page.locator('.skill-draft-callout');
  await expect(callout).toContainText('「種子技能」還差 100 則分享介紹，就能升級成完整技能書。');
  await callout.getByRole('button', { name: '補上分享介紹', exact: true }).click();
  await expect(dialog.getByText('正在補完：種子技能', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('給聊天 AI 的說明', { exact: true })).toHaveValue(/種子技能/);
  await expect(dialog.getByLabel('公開儲存庫網址', { exact: true })).toHaveValue(seed.repository_url);
  await expect(dialog.getByRole('button', { name: '複製給聊天 AI', exact: true })).toBeFocused();
  await paste.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await paste.fill(JSON.stringify({ repository_url: 'https://github.com/Example/Seeded-Book', title: '種子技能' }));
  await dialog.getByRole('button', { name: '用這份 JSON 建立草稿', exact: true }).click();
  await expect(dialog.getByText('升級：種子技能', { exact: true })).toBeVisible();
  await expect.poll(() => grants.some(path => path.includes('sub-seed'))).toBe(true);
  await expect.poll(() => uploads.some(path => path.endsWith('/sub-seed'))).toBe(true);
  await expect(dialog.getByRole('region', { name: '預覽：流程整理技能', exact: true })).toBeVisible();
  await expect(dialog.getByText('送出後會取代簡易版；原本的作品連結會自動轉到完整版。', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '送出技能', exact: true }).click();
  await expect(dialog.getByRole('status').filter({ hasText: '技能已送出' })).toBeVisible();
});

test('an agent upload while the private instruction is open opens the preview', async ({ page }) => {
  let flip = false;
  const waiting = submission('sub-poll', 'awaiting_upload');
  const ready = submission('sub-poll', 'ready_for_review');
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    const current = flip ? ready : waiting;
    if (request.method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [current] } });
    if (request.method() === 'GET') return route.fulfill({ json: current });
    if (path === '/me/skill-submissions') {
      return route.fulfill({ status: 201, json: { submission: waiting, upload_grant: { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: '/agent-api/v1/skill-submissions/sub-poll' } } });
    }
    return route.fulfill({ json: current });
  });
  await login(page);
  await navigate(page, '技能書架');
  await page.clock.install();
  await page.getByRole('button', { name: '上傳技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await expect(dialog.getByText('尚未上傳內容', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '產生私人上傳指令', exact: true }).click();
  await expect(dialog.getByLabel('私人上傳指令', { exact: true })).toBeVisible();
  flip = true;
  await page.clock.fastForward(10_000);
  await expect(dialog.getByText('Agent 已上傳「流程整理技能」，請預覽後送出。', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('region', { name: '預覽：流程整理技能', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('私人上傳指令', { exact: true })).toHaveCount(0);
});

test('a paste still reaches a seeded draft after its grant expired', async ({ page }) => {
  const seeded = submission('sub-seed', 'awaiting_upload', { seed, upgrades_submission_id: 'project-seed', aggregate_version: 4, grant_expires_at: '2020-01-01T00:00:00Z' });
  const plain = submission('sub-plain', 'awaiting_upload', { aggregate_version: 2, grant_expires_at: '2099-01-01T00:00:00Z' });
  const seededReady = submission('sub-seed', 'ready_for_review', { seed, upgrades_submission_id: 'project-seed' });
  const grants: string[] = [];
  const created: string[] = [];
  const uploads: string[] = [];
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (request.method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [seeded, plain] } });
    if (request.method() === 'GET') return route.fulfill({ json: path.endsWith('/sub-seed') ? seededReady : plain });
    if (request.method() === 'POST' && path === '/me/skill-submissions') { created.push(path); return route.fulfill({ status: 201, json: { submission: submission('sub-new', 'awaiting_upload'), upload_grant: { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: '/agent-api/v1/skill-submissions/sub-new' } } }); }
    if (path.endsWith('/grant')) {
      grants.push(path);
      const id = path.split('/')[3];
      return route.fulfill({ json: { submission: id === 'sub-seed' ? seeded : plain, upload_grant: { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: `/agent-api/v1/skill-submissions/${id}` } } });
    }
    return route.fulfill({ json: seeded });
  });
  await page.route('**/agent-api/v1/skill-submissions/**', async route => {
    uploads.push(new URL(route.request().url()).pathname);
    return route.fulfill({ json: seededReady });
  });
  await login(page);
  await navigate(page, '技能書架');
  const callout = page.locator('.skill-draft-callout');
  await expect(callout).toContainText('「種子技能」還差 100 則分享介紹，就能升級成完整技能書。');
  await callout.getByRole('button', { name: '補上分享介紹', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await expect(dialog.getByText('正在補完：種子技能', { exact: true })).toBeVisible();
  const paste = dialog.getByRole('textbox', { name: '貼上 JSON', exact: true });
  await paste.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await paste.fill(JSON.stringify({ repository_url: 'https://github.com/Example/Seeded-Book', title: '種子技能' }));
  await dialog.getByRole('button', { name: '用這份 JSON 建立草稿', exact: true }).click();
  await expect.poll(() => grants).toEqual(['/me/skill-submissions/sub-seed/grant']);
  await expect.poll(() => uploads.some(path => path.endsWith('/sub-seed'))).toBe(true);
  expect(uploads.some(path => path.endsWith('/sub-plain') || path.endsWith('/sub-new'))).toBe(false);
  expect(created).toEqual([]);
});

test('publishing the last ready draft keeps the drafts section above the agent instructions', async ({ page }) => {
  const ready = submission('sub-ready', 'ready_for_review');
  const published = submission('sub-ready', 'published');
  let sent = false;
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (request.method() === 'POST' && path.endsWith('/publish')) { sent = true; return route.fulfill({ json: published }); }
    const current = sent ? published : ready;
    if (request.method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [current] } });
    return route.fulfill({ json: current });
  });
  await login(page);
  await navigate(page, '技能書架');
  await page.locator('.skill-draft-callout').getByRole('button', { name: '預覽並送出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await dialog.getByRole('button', { name: '送出技能', exact: true }).click();
  await expect(dialog.getByText('技能已送出，公開介紹頁已建立。', { exact: true })).toBeVisible();
  const order = await dialog.evaluate(element => {
    const headings = [...element.querySelectorAll('h3')].map(node => node.textContent);
    return headings.indexOf('我的私人技能草稿') >= 0 && headings.indexOf('我的私人技能草稿') < headings.indexOf('交給 Agent 讀取專案');
  });
  expect(order).toBe(true);
});

test('completing a seeded draft keeps the target line and copy button in view', async ({ page }) => {
  const seeded = submission('sub-seed', 'awaiting_upload', { seed, upgrades_submission_id: 'project-seed' });
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (route.request().method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [seeded] } });
    if (route.request().method() === 'GET') return route.fulfill({ json: seeded });
    return route.fulfill({ json: seeded });
  });
  await login(page);
  await navigate(page, '技能書架');
  const callout = page.locator('.skill-draft-callout');
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await callout.getByRole('button', { name: '補上分享介紹', exact: true }).click();
    const target = dialog.getByText('正在補完：種子技能', { exact: true });
    const copy = dialog.getByRole('button', { name: '複製給聊天 AI', exact: true });
    await expect(copy).toBeFocused();
    await expectInsideDialog(target);
    await expectInsideDialog(copy);
    const gap = await target.evaluate(element => {
      const header = element.closest('dialog')!.querySelector('.skill-upload-header')!.getBoundingClientRect();
      return element.getBoundingClientRect().top - header.bottom;
    });
    expect(gap).toBeGreaterThanOrEqual(8);
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
  await page.setViewportSize({ width: 390, height: 520 });
  await callout.getByRole('button', { name: '補上分享介紹', exact: true }).click();
  const shortCopy = dialog.getByRole('button', { name: '複製給聊天 AI', exact: true });
  await expect(shortCopy).toBeFocused();
  await expectInsideDialog(shortCopy);
});

test('the upload header stays above the submit footer and use notes keep their inset', async ({ page }) => {
  const ready = submission('sub-ready', 'ready_for_review');
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (route.request().method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [ready] } });
    return route.fulfill({ json: ready });
  });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '技能書架');
  await page.locator('.skill-draft-callout').getByRole('button', { name: '預覽並送出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await settleIllustration(dialog);
  const submit = dialog.getByRole('button', { name: '送出技能', exact: true });
  await expect(submit).toBeVisible();
  const submitOnTop = await submit.evaluate(element => {
    const box = element.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === element;
  });
  expect(submitOnTop).toBe(true);
  for (const theme of ['light', 'dark'] as const) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    const notes = dialog.locator('.skill-upload-preview .help-box');
    await expect(notes).toHaveCSS('padding-left', '12px');
    const inset = await notes.evaluate(element => {
      const strong = element.querySelector('strong');
      if (!strong) return -1;
      return strong.getBoundingClientRect().left - element.getBoundingClientRect().left;
    });
    expect(inset).toBeGreaterThanOrEqual(12);
  }
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  const placed = await dialog.evaluate(element => {
    const header = element.querySelector<HTMLElement>('.skill-upload-header');
    const footer = element.querySelector<HTMLElement>('.skill-upload-submit');
    const title = header?.querySelector('h2');
    if (!header || !footer || !title) return null;
    // The title centre is ~30px above the header bottom, so a 20px overlap stays in the padding and cannot see z-index.
    const target = () => title.getBoundingClientRect().top + title.getBoundingClientRect().height / 2 - 4;
    const max = Math.max(0, element.scrollHeight - element.clientHeight);
    let low = 0;
    let high = max;
    for (let step = 0; step < 28; step += 1) {
      element.scrollTop = (low + high) / 2;
      if (footer.getBoundingClientRect().top > target()) low = element.scrollTop;
      else high = element.scrollTop;
    }
    element.scrollTop = high;
    element.scrollTop += footer.getBoundingClientRect().top - target();
    const footerBox = footer.getBoundingClientRect();
    const headerBox = header.getBoundingClientRect();
    const titleBox = title.getBoundingClientRect();
    const x = titleBox.left + titleBox.width / 2;
    const y = titleBox.top + titleBox.height / 2;
    const hit = document.elementFromPoint(x, y);
    return {
      overlap: headerBox.bottom - footerBox.top,
      pointInsideFooter: x >= footerBox.left && x <= footerBox.right && y >= footerBox.top && y <= footerBox.bottom,
      titleMidFromHeaderBottom: headerBox.bottom - y,
      hitInHeader: Boolean(hit?.closest('.skill-upload-header')),
    };
  });
  expect(placed).not.toBeNull();
  expect(placed?.pointInsideFooter).toBe(true);
  expect(Math.abs((placed?.overlap ?? 0) - ((placed?.titleMidFromHeaderBottom ?? 0) + 4))).toBeLessThanOrEqual(2);
  expect(placed?.hitInHeader).toBe(true);
});

test('the stuck submit footer reaches the dialog bottom on a phone', async ({ page }) => {
  const ready = submission('sub-ready', 'ready_for_review');
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (route.request().method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [ready] } });
    return route.fulfill({ json: ready });
  });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '技能書架');
  await page.locator('.skill-draft-callout').getByRole('button', { name: '預覽並送出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  const footer = dialog.locator('.skill-upload-submit');
  await expect(footer).toBeVisible();
  await settleIllustration(dialog);
  await dialog.evaluate(element => { element.scrollTop = 0; });
  const gap = await footer.evaluate(element => {
    const dialogNode = element.closest('dialog')!;
    return Math.abs(dialogNode.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom);
  });
  expect(gap).toBeLessThanOrEqual(2);
});

const resultViewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }];

async function dialogTypography(dialog: Locator) {
  return dialog.evaluate(element => {
    const value = (node: Element | null) => node ? getComputedStyle(node) : null;
    const title = value(element.querySelector('.skill-upload-header h2'));
    const agent = [...element.querySelectorAll('section')].find(section => section.querySelector('h3')?.textContent === '交給 Agent 讀取專案');
    const heading = value(agent?.querySelector('h3') ?? null);
    const hint = value(element.querySelector('.field-hint'));
    const paragraph = value(agent?.querySelector('p') ?? null);
    return {
      titleSize: title?.fontSize ?? '',
      titleMarginTop: title?.marginTop ?? '',
      headingSize: heading?.fontSize ?? '',
      hintSize: hint?.fontSize ?? '',
      paragraphSize: paragraph?.fontSize ?? '',
    };
  });
}

test('publish, revoke, and chat upload show their results inside the drafts section', async ({ page }) => {
  const ready = submission('sub-ready', 'ready_for_review');
  const published = submission('sub-ready', 'published');
  const revoked = submission('sub-ready', 'ready_for_review', { status: 'revoked', aggregate_version: 4 });
  const chatReady = submission('sub-chat', 'ready_for_review');
  let publishedSent = false;
  let revokedSent = false;
  let uploaded = false;
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (request.method() === 'POST' && path.endsWith('/publish')) { publishedSent = true; return route.fulfill({ json: published }); }
    if (request.method() === 'POST' && path.endsWith('/revoke')) { revokedSent = true; return route.fulfill({ json: revoked }); }
    if (request.method() === 'POST' && path === '/me/skill-submissions') {
      const created = submission('sub-chat', 'awaiting_upload', { aggregate_version: 1 });
      return route.fulfill({ status: 201, json: { submission: created, upload_grant: { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: '/agent-api/v1/skill-submissions/sub-chat' } } });
    }
    if (request.method() === 'GET' && path === '/me/skill-submissions') {
      if (uploaded) return route.fulfill({ json: { items: [chatReady] } });
      const current = publishedSent ? published : revokedSent ? revoked : ready;
      return route.fulfill({ json: { items: [current] } });
    }
    if (path.endsWith('/sub-chat')) return route.fulfill({ json: chatReady });
    const current = publishedSent ? published : revokedSent ? revoked : ready;
    return route.fulfill({ json: current });
  });
  await page.route('**/agent-api/v1/skill-submissions/**', async route => {
    uploaded = true;
    return route.fulfill({ json: chatReady });
  });
  await login(page);
  for (const viewport of resultViewports) {
    publishedSent = false; revokedSent = false; uploaded = false;
    await page.setViewportSize(viewport);
    await navigate(page, '開源投稿');
    await navigate(page, '技能書架');
    await page.locator('.skill-draft-callout').getByRole('button', { name: '預覽並送出', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
    await settleIllustration(dialog);
    await dialog.getByRole('button', { name: '送出技能', exact: true }).click();
    const drafts = dialog.getByRole('region', { name: '我的私人技能草稿', exact: true });
    const publishedNotice = drafts.getByText('技能已送出，公開介紹頁已建立。', { exact: true });
    await expectInsideDialog(publishedNotice);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
    await expect(dialog).toBeHidden();

    publishedSent = false; revokedSent = false; uploaded = false;
    await navigate(page, '開源投稿');
    await navigate(page, '技能書架');
    await page.getByRole('button', { name: '上傳技能', exact: true }).click();
    await dialog.getByRole('button', { name: '撤銷草稿：流程整理技能', exact: true }).click();
    const revokedNotice = dialog.getByRole('region', { name: '我的私人技能草稿', exact: true }).getByText('草稿已撤銷，憑證無法再上傳。', { exact: true });
    await expectInsideDialog(revokedNotice);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
    await expect(dialog).toBeHidden();

    publishedSent = false; revokedSent = false; uploaded = false;
    await navigate(page, '開源投稿');
    await navigate(page, '技能書架');
    await page.getByRole('button', { name: '上傳技能', exact: true }).click();
    const paste = dialog.getByRole('textbox', { name: '貼上 JSON', exact: true });
    await paste.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await paste.fill(JSON.stringify({ repository_url: 'https://github.com/example/skill-demo', title: '流程整理技能' }));
    await dialog.getByRole('button', { name: '用這份 JSON 建立草稿', exact: true }).click();
    const uploadedNotice = dialog.getByRole('region', { name: '我的私人技能草稿', exact: true }).getByText('草稿已上傳，請預覽內容後再送出。', { exact: true });
    await expectInsideDialog(uploadedNotice);
    await expect(dialog.getByRole('alert')).toHaveCount(0);
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});

test('the upload dialog keeps the same type on the skill shelf and the open-source page', async ({ page }) => {
  await login(page);
  for (const viewport of resultViewports) {
    await page.setViewportSize(viewport);
    await navigate(page, '技能書架');
    await expect(page.getByRole('heading', { name: '公會指定技能書', level: 2, exact: true })).toHaveCSS('font-size', '18px');
    await expect(page.getByRole('heading', { name: '社群技能書', level: 2, exact: true })).toHaveCSS('font-size', '18px');
    await expect(page.locator('.skill-shelf-heading p.muted')).toHaveCSS('font-size', '14px');
    await page.getByRole('button', { name: '上傳技能', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
    await expect(dialog.getByRole('heading', { name: '交給 Agent 讀取專案', exact: true })).toBeVisible();
    const fromShelf = await dialogTypography(dialog);
    await expect(page.getByRole('heading', { name: '社群技能書', level: 2, exact: true })).toHaveCSS('font-size', '18px');
    await expect(page.locator('.skill-shelf-heading p.muted')).toHaveCSS('font-size', '14px');
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
    await expect(dialog).toBeHidden();

    await navigate(page, '開源投稿');
    await page.getByText('使用 Agent 或聊天 AI 協助整理（進階）', { exact: true }).click();
    await page.getByRole('button', { name: '上傳技能', exact: true }).click();
    await expect(dialog.getByRole('heading', { name: '交給 Agent 讀取專案', exact: true })).toBeVisible();
    expect(await dialogTypography(dialog)).toEqual(fromShelf);
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
  }
});

test('member card headings keep their margin outside the upload dialog', async ({ page }) => {
  await login(page);
  await navigate(page, '我的名片');
  const heading = page.locator('.account-panel .member-card-body h4').first();
  await expect(heading).toBeVisible();
  await expect(heading).toHaveCSS('margin-top', '0px');
  await navigate(page, '我可以賣東西');
  await expect(page.getByRole('heading', { name: '挑選這次想賣的商品', exact: true })).toBeVisible();
  const photo = page.locator('.shop-product img');
  if (await photo.count()) await expect(photo.first()).toHaveCSS('object-fit', 'contain');
});

test('a loading draft refresh stays dim inside the dialog', async ({ page }) => {
  let gate: Promise<void> | null = null;
  let release = () => {};
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
    if (route.request().method() === 'GET' && path === '/me/skill-submissions') {
      if (gate) await gate;
      return route.fulfill({ json: { items: [] } });
    }
    return route.fallback();
  });
  await login(page);
  for (const tab of ['開源投稿', '技能書架'] as const) {
    await navigate(page, tab);
    const advanced = page.getByText('使用 Agent 或聊天 AI 協助整理（進階）', { exact: true });
    if (await advanced.count()) await advanced.click();
    await page.getByRole('button', { name: '上傳技能', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
    const refresh = dialog.getByRole('button', { name: '重新整理草稿', exact: true });
    await expect(refresh).toBeEnabled();
    gate = new Promise(resolve => { release = resolve; });
    await refresh.click();
    await expect(refresh).toBeDisabled();
    await expect(refresh).toHaveCSS('opacity', '0.55');
    release();
    gate = null;
    await expect(refresh).toBeEnabled();
    await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
    await expect(dialog).toBeHidden();
  }
});

test('a phone shows a publish conflict in the drafts section', async ({ page }) => {
  const ready = submission('sub-ready', 'ready_for_review');
  const problem = { title: '草稿已變更', detail: '這份草稿已在別處更新，請重新整理後再送出。' };
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
    if (request.method() === 'POST' && path.endsWith('/publish')) return route.fulfill({ status: 409, contentType: 'application/problem+json', json: problem });
    if (request.method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [ready] } });
    return route.fulfill({ json: ready });
  });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '技能書架');
  await page.locator('.skill-draft-callout').getByRole('button', { name: '預覽並送出', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await settleIllustration(dialog);
  await dialog.getByRole('button', { name: '送出技能', exact: true }).click();
  const drafts = dialog.getByRole('region', { name: '我的私人技能草稿', exact: true });
  const alert = drafts.getByRole('alert');
  await expect(alert).toHaveText(`${problem.title}：${problem.detail}`);
  await expect(alert).toHaveClass('banner banner-error');
  await expectInsideDialog(alert);
  await expect(drafts.getByText('技能已送出，公開介紹頁已建立。')).toHaveCount(0);
  await expect(dialog.getByRole('region', { name: '交給 Agent 讀取專案', exact: true }).getByRole('alert')).toHaveCount(0);
});

test('handing a seeded draft to an agent brings the instruction into view', async ({ page }) => {
  const seeded = submission('sub-seed', 'awaiting_upload', { seed, upgrades_submission_id: 'project-seed' });
  await page.route('**/api/v1/me/skill-submissions**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace('/api/v1', '');
    if (request.method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [seeded] } });
    if (request.method() === 'GET') return route.fulfill({ json: seeded });
    if (path.endsWith('/grant')) return route.fulfill({ json: { submission: { ...seeded, aggregate_version: 2 }, upload_grant: { token: GRANT, expires_at: '2099-01-01T00:00:00Z', submit_url: '/agent-api/v1/skill-submissions/sub-seed' } } });
    return route.fulfill({ json: seeded });
  });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await navigate(page, '技能書架');
  await page.getByRole('button', { name: '上傳技能', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await dialog.getByRole('button', { name: '交給 Agent：種子技能', exact: true }).click();
  const instruction = dialog.getByLabel('私人上傳指令', { exact: true });
  const copy = dialog.getByRole('button', { name: '複製', exact: true });
  await expect(copy).toBeFocused();
  await expectInsideDialog(instruction);
  await expectInsideDialog(copy);
});

for (const theme of ['light', 'dark', 'versefolk'] as const) {
  test(`draft callout and submit footer stay opaque in ${theme}`, async ({ page }) => {
    await page.addInitScript(value => localStorage.setItem('freedom-theme', value), theme);
    const ready = submission('sub-ready', 'ready_for_review');
    await page.route('**/api/v1/me/skill-submissions**', async route => {
      const path = new URL(route.request().url()).pathname.replace('/api/v1', '');
      if (path.endsWith('/illustration')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
      if (route.request().method() === 'GET' && path === '/me/skill-submissions') return route.fulfill({ json: { items: [ready] } });
      return route.fulfill({ json: ready });
    });
    await login(page);
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await navigate(page, '技能書架');
    const callout = page.locator('.skill-draft-callout');
    await callout.getByRole('button', { name: '預覽並送出', exact: true }).click();
    const footer = page.locator('.skill-upload-submit');
    await expect(footer).toBeVisible();
    for (const locator of [callout, footer]) {
      const contrast = await locator.evaluate(contrastOf);
      expect(contrast.alpha).toBe(1);
      expect(contrast.ratio).toBeGreaterThanOrEqual(4.5);
    }
  });
}

function fullBook(title: string) {
  const blurbs = Array.from({ length: 100 }, (_, index) => `第 ${index + 1} 則：${title} 把重複工作整理成可重用的流程。`);
  return JSON.stringify({
    repository_url: 'https://github.com/freetwai-test/simple-work',
    title,
    description: '讀取 README 後整理出的完整介紹。',
    use_notes: '安裝後先閱讀 README，再執行第一個範例。',
    demo_url: null,
    relationship: 'curator',
    share_introductions: blurbs,
  });
}

async function publishSimple(page: Page, title: string) {
  await navigate(page, '開源投稿');
  await expect(page.getByRole('button', { name: '上傳技能', exact: true })).toBeHidden();
  await page.getByLabel('GitHub 專案網址', { exact: true }).fill('https://github.com/freetwai-test/simple-work');
  await page.getByLabel('作品名稱', { exact: true }).fill(title);
  await page.getByLabel('一句話介紹', { exact: true }).fill('幫創作者把零散想法整理成合作提案。');
  await page.getByRole('button', { name: '預覽投稿', exact: true }).click();
  await page.getByLabel('我同意公開這份作品介紹與來源關係', { exact: true }).check();
  await page.getByRole('button', { name: '確認並公開', exact: true }).click();
  const completed = page.getByRole('region', { name: '投稿完成' });
  await expect(completed).toBeVisible();
  const path = await completed.getByRole('link', { name: '查看作品頁 ↗' }).getAttribute('href');
  return { completed, path: path! };
}

test('the simple form upgrades into a full skill book and the old link follows it', async ({ page }) => {
  const stamp = `${Date.now()}-${test.info().repeatEachIndex}`;
  const simpleTitle = `簡易工具 ${stamp}`;
  const fullTitle = `完整技能書 ${stamp}`;
  await login(page);
  const { completed, path } = await publishSimple(page, simpleTitle);
  await expect(completed).toContainText('想讓更多人看懂這個工具？補上 100 則分享介紹和示意圖，就能升級成完整技能書。送出前，現在的版本保持不變。');
  await expect(page.getByRole('button', { name: '上傳技能', exact: true })).toBeHidden();
  await completed.getByRole('button', { name: '補上 100 則分享介紹和示意圖', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await expect(dialog.getByText(`正在補完：${simpleTitle}`, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '複製給聊天 AI', exact: true })).toBeFocused();
  await expect(page.getByText('使用 Agent 或聊天 AI 協助整理（進階）', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '上傳技能', exact: true })).toBeHidden();
  const paste = dialog.getByRole('textbox', { name: '貼上 JSON', exact: true });
  await paste.evaluate(element => element.scrollIntoView({ block: 'center', inline: 'nearest' }));
  await paste.fill(fullBook(fullTitle));
  await dialog.getByRole('button', { name: '用這份 JSON 建立草稿', exact: true }).click();
  await expect(dialog.getByText(`升級：${simpleTitle}`, { exact: true })).toBeVisible();
  await expect(page.getByText('繼續未公開的草稿')).toHaveCount(0);
  const preview = dialog.getByRole('region', { name: `預覽：${fullTitle}`, exact: true });
  await expect(preview).toBeVisible();
  await expect(preview.getByText('送出後會取代簡易版；原本的作品連結會自動轉到完整版。', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '送出技能', exact: true }).click();
  await expect(dialog.getByText('技能已送出，公開介紹頁已建立。', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '關閉上傳技能', exact: true }).click();
  await navigate(page, '技能書架');
  const library = page.locator('.community-skill-library');
  await expect(library.getByRole('heading', { name: fullTitle, exact: true })).toBeVisible();
  await expect(library.getByRole('heading', { name: simpleTitle, exact: true })).toHaveCount(0);
  const redirected = await page.request.get(`${path}?intro=7`, { maxRedirects: 0 });
  expect(redirected.status()).toBe(302);
  const location = redirected.headers().location ?? '';
  expect(location).toContain('?intro=7');
  expect(location).not.toContain(path);
  await page.goto(path!);
  await expect(page.getByText(fullTitle).first()).toBeVisible();
  expect(new URL(page.url()).pathname).not.toBe(path);
});

test('the shelf callout upgrades a published simple submission into a new draft', async ({ page }) => {
  const stamp = `${Date.now()}-${test.info().repeatEachIndex}`;
  const title = `簡易書架 ${stamp}`;
  await login(page);
  await publishSimple(page, title);
  await navigate(page, '技能書架');
  const callout = page.locator('.skill-draft-callout');
  await expect(callout).toContainText(`「${title}」目前是簡易版。補上 100 則分享介紹和示意圖，就能升級成完整技能書。`);
  await callout.getByRole('button', { name: '升級成完整技能書', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '上傳技能', exact: true });
  await expect(dialog.getByText(`正在補完：${title}`, { exact: true })).toBeVisible();
  await expect(dialog.getByText(`升級：${title}`, { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '複製給聊天 AI', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: `撤銷草稿：${title}`, exact: true }).click();
  await expect(dialog.getByText('草稿已撤銷，憑證無法再上傳。', { exact: true })).toBeVisible();
});
