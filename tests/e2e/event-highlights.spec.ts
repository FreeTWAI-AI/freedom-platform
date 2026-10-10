import {mkdirSync} from 'node:fs';
import sharp from 'sharp';
import {test, expect, type BrowserContext, type Page} from './fixtures.js';
import {navigate, signOut} from './navigation.js';

const COMMUNITY = '10000000-0000-4000-8000-000000000001';
const MAKER = '20000000-0000-4000-8000-000000000001';
const GUILD_VIEWER = '71000000-0000-4000-8000-0000000000ac';
const GUILD_MEMBERSHIP = '71000000-0000-4000-8000-0000000000ad';
const HOST = '71000000-0000-4000-8000-0000000000aa';
const ONLINE = '71000000-0000-4000-8000-000000000001';
const GUILD = '71000000-0000-4000-8000-000000000002';
const HIDDEN = '71000000-0000-4000-8000-000000000003';
const UPCOMING = '71000000-0000-4000-8000-000000000004';
const LOCATION = '地點密語e2e-location';
const MEETING = 'https://secret-meet.example/e2e-room';
const YOUTUBE = 'https://www.youtube.com/watch?v=abcdefghijk&utm_source=share';
const SHOTS = process.env.AUDIT_EVIDENCE_DIR ?? 'test-results/event-highlights';
const GUILD_COPY = '公會夥伴在現場交流，結束後公開回顧。';
const MEMBER_COPY = '這是一場會員活動，活動說明只提供給會員。';
const EVENT_IDS = [ONLINE, GUILD, HIDDEN, UPCOMING];

test.describe.configure({mode: 'serial'});
test.setTimeout(180000);

let thumbJpeg: Buffer;

async function allowLocal(context: BrowserContext) {
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith('https://i.ytimg.com/')) return route.fulfill({status: 200, contentType: 'image/jpeg', body: thumbJpeg});
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost') || url.startsWith('http://[::1]')) return route.continue();
    return route.abort('blockedbyclient');
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
}

async function login(page: Page, email = 'maker@local.test') {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill(email);
  await page.getByLabel('密碼', {exact: true}).fill('freedom-local-demo');
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.locator('.shell')).toBeVisible();
}

async function openHighlights(page: Page) {
  await navigate(page, '活動集錦');
  await expect(page.getByRole('heading', {name: '活動集錦', level: 1, exact: true})).toBeVisible();
}

async function noOverflow(page: Page, label: string) {
  const extra = await page.evaluate(() => ({
    page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    images: [...document.querySelectorAll('img')].filter(img => img.getBoundingClientRect().width > document.documentElement.clientWidth + 1).length,
  }));
  expect(extra.page, label).toBeLessThanOrEqual(1);
  expect(extra.images, label).toBe(0);
}

async function setTheme(page: Page, theme: 'light' | 'dark' | 'versefolk') {
  await page.evaluate(value => {
    localStorage.setItem('freedom-theme', value);
    document.documentElement.dataset.theme = value;
  }, theme);
}

/** Poll until a colour transition (0.16s) has finished and the computed colour stays put. */
async function settledColors(page: Page, selector: string) {
  const read = () => page.locator(selector).first().evaluate(element => {
    const style = getComputedStyle(element);
    return {backgroundColor: style.backgroundColor, color: style.color};
  });
  let previous = '';
  let stable = 0;
  let latest = {backgroundColor: '', color: ''};
  for (let attempt = 0; attempt < 15; attempt += 1) {
    latest = await read();
    const key = `${latest.backgroundColor}|${latest.color}`;
    if (key === previous) {
      stable += 1;
      if (stable >= 2) return latest;
    } else {
      stable = 0;
      previous = key;
    }
    await page.waitForTimeout(200);
  }
  return latest;
}

async function paints(page: Page, selector: string) {
  return page.locator(selector).first().evaluate(element => {
    const parse = (value: string) => {
      const match = value.match(/rgba?\(([^)]+)\)/);
      if (!match) return null;
      const parts = match[1].split(',').map(part => Number.parseFloat(part.trim()));
      return {r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1};
    };
    const opaque = (node: Element | null): string => {
      if (!node) return getComputedStyle(document.body).backgroundColor;
      const color = getComputedStyle(node).backgroundColor;
      const parts = parse(color);
      if (!parts || parts.a === 0) return opaque(node.parentElement);
      return color;
    };
    const style = getComputedStyle(element);
    return {color: style.color, background: opaque(element)};
  });
}

function contrast(a: string, b: string) {
  const channel = (value: string) => {
    const match = value.match(/rgba?\(([^)]+)\)/);
    if (!match) return 0;
    const [r, g, b] = match[1].split(',').map(part => Number.parseFloat(part.trim()) / 255);
    const linear = [r, g, b].map(part => part <= 0.03928 ? part / 12.92 : ((part + 0.055) / 1.055) ** 2.4);
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
  };
  const left = channel(a), right = channel(b);
  return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
}

test.beforeAll(async ({e2eAuthPool}) => {
  mkdirSync(SHOTS, {recursive: true});
  thumbJpeg = await sharp({create: {width: 16, height: 9, channels: 3, background: '#3044ff'}}).jpeg().toBuffer();
  const banner = await sharp({create: {width: 900, height: 1200, channels: 3, background: '#3044ff'}}).webp().toBuffer();
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref)
    SELECT $1,$2,$3,$4,password_hash,$5 FROM users WHERE user_id=$6`,
  [HOST, COMMUNITY, 'highlight-host-e2e@example.invalid', '驗收帳號', '71000000-0000-4000-8000-0000000000ab', MAKER]);
  await e2eAuthPool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,$2,'highlight-guild-viewer@local.test','集錦公會會員',password_hash,$3,false FROM users WHERE user_id=$4`,
  [GUILD_VIEWER,COMMUNITY,'71000000-0000-4000-8000-0000000000ae',MAKER]);
  await e2eAuthPool.query(`INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state,member_tier)
    VALUES($1,$2,$3,'guild_event_space','active','full')`,[GUILD_MEMBERSHIP,COMMUNITY,GUILD_VIEWER]);
  const rows = [
    [ONLINE, MAKER, '線上分享回顧', '這是一場已經結束的線上分享，歡迎回顧照片與影片。', "now()-interval '3 days'", "now()-interval '2 days'", 'online', 'open', 'other', null, MEETING],
    [GUILD, MAKER, '實體公會聚會', '公會夥伴在現場交流，結束後公開回顧。', "now()-interval '12 days'", "now()-interval '10 days'", 'in_person', 'guild', 'guild_skill_exchange', 'guild_event_space', null],
    [HIDDEN, HOST, '驗收帳號的活動', '這場不該出現在別人的活動集錦。', "now()-interval '3 hours'", "now()-interval '1 hour'", 'online', 'open', 'other', null, null],
    [UPCOMING, MAKER, '即將舉辦', '還沒結束，不該出現在活動集錦。', "now()+interval '1 day'", "now()+interval '2 days'", 'online', 'open', 'other', null, null],
  ] as const;
  for (const row of rows) {
    await e2eAuthPool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,online_url,state,visibility,event_kind,guild_key)
      VALUES ($1,$2,$3,$4,$5,${row[4]},${row[5]},$6,$7,$8,'published',$9,$10,$11)`,
    [row[0], COMMUNITY, row[1], row[2], row[3], row[6], LOCATION, row[10], row[7], row[8], row[9]]);
  }
  await e2eAuthPool.query(`INSERT INTO community_event_banners(event_id,image_bytes,orientation) VALUES ($1,$2,'portrait')`, [ONLINE, banner]);
});

test.afterAll(async ({e2eAuthPool}) => {
  await e2eAuthPool.query('DELETE FROM community_events WHERE event_id = ANY($1::uuid[])', [EVENT_IDS]);
  await e2eAuthPool.query('DELETE FROM positioning_profession_memberships WHERE membership_id=$1',[GUILD_MEMBERSHIP]);
  await e2eAuthPool.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])', [[HOST,GUILD_VIEWER]]);
});

test.beforeEach(async ({context, page}) => {
  await allowLocal(context);
  await page.route('https://i.ytimg.com/**', route => route.fulfill({status: 200, contentType: 'image/jpeg', body: thumbJpeg}));
});

test('the member list shows ended events newest first and filters by mode', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await login(page);
  await openHighlights(page);
  const cards = page.locator('.hl-grid article');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0)).toHaveAttribute('aria-label', '線上分享回顧');
  await expect(cards.nth(1)).toHaveAttribute('aria-label', '實體公會聚會');
  await expect(page.getByText('驗收帳號的活動')).toHaveCount(0);
  await expect(page.getByText('即將舉辦')).toHaveCount(0);
  await expect(cards.nth(0).locator('.hl-cover img')).toBeVisible();
  const titleGap = await cards.first().evaluate(article => {
    const cover = article.querySelector('.hl-cover')!.getBoundingClientRect();
    const title = article.querySelector('h2')!.getBoundingClientRect();
    return title.top - cover.bottom;
  });
  expect(titleGap).toBeGreaterThanOrEqual(8);
  await expect(cards.nth(1).locator('.hl-placeholder')).toContainText('實體');
  await expect(page.getByText(LOCATION)).toHaveCount(0);
  await expect(page.getByText(MEETING)).toHaveCount(0);
  await page.screenshot({path: `${SHOTS}/member-list-light-1280.png`, fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await noOverflow(page, 'member list 390');
  await page.screenshot({path: `${SHOTS}/member-list-light-390.png`, fullPage: true});
  await page.setViewportSize({width: 1280, height: 900});
  await setTheme(page, 'dark');
  await page.screenshot({path: `${SHOTS}/member-list-dark-1280.png`, fullPage: true});
  await setTheme(page, 'light');
  await page.getByRole('button', {name: '線上', exact: true}).click();
  await expect(page.getByRole('button', {name: '線上', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('article', {name: '線上分享回顧'})).toBeVisible();
  await expect(page.getByRole('article', {name: '實體公會聚會'})).toHaveCount(0);
  await page.getByRole('button', {name: '實體', exact: true}).click();
  await expect(page.getByRole('button', {name: '實體', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('article', {name: '實體公會聚會'})).toBeVisible();
  await expect(page.getByRole('article', {name: '線上分享回顧'})).toHaveCount(0);
  await page.getByRole('button', {name: '全部', exact: true}).click();
  await expect(cards).toHaveCount(2);
});

test('a member adds a video link, photos and a poster, then uses the lightbox', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await login(page);
  await page.goto(`/#highlights/${ONLINE}`);
  await expect(page.getByRole('heading', {name: '線上分享回顧', level: 2})).toBeVisible();
  const notice = page.locator('.hl-notice');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveText('公開活動的公開內容可供任何人閱讀；私人成果與草稿不會自動公開。');
  const banner = page.locator('.hl-frame img').first();
  await expect(banner).toBeVisible();
  await expect.poll(() => banner.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const fitted = await banner.evaluate(img => {
    const box = img.getBoundingClientRect();
    const frame = img.parentElement!.getBoundingClientRect();
    const style = getComputedStyle(img);
    return {
      height: box.height,
      viewport: window.innerHeight,
      fit: style.objectFit,
      frame: getComputedStyle(img.parentElement!).backgroundColor,
      center: Math.abs((box.left + box.right) / 2 - (frame.left + frame.right) / 2),
    };
  });
  expect(fitted.fit).toBe('contain');
  expect(fitted.frame).toBe('rgb(20, 22, 27)');
  expect(fitted.height).toBeLessThanOrEqual(fitted.viewport * 0.7 + 1);
  expect(fitted.height).toBeGreaterThan(120);
  expect(fitted.center).toBeLessThan(2);
  await page.getByText('補上照片或影片連結').click();
  await expect(page.getByText('你還可以新增：連結 10・照片 30・海報 3')).toBeVisible();
  await page.screenshot({path: `${SHOTS}/member-add-light-1280.png`, fullPage: true});
  await page.getByLabel('影片連結').fill(YOUTUBE);
  await page.getByRole('button', {name: '送出', exact: true}).click();
  const video = page.locator('.hl-item').filter({hasText: 'YouTube 影片'});
  await expect(video).toBeVisible();
  await expect(video.locator('img')).toHaveAttribute('src', 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg');
  await expect(video.getByText('主辦者')).toBeVisible();
  await page.getByLabel('影片連結').fill(`${YOUTUBE}&si=again`);
  await page.getByRole('button', {name: '送出', exact: true}).click();
  await expect(page.getByRole('alert')).toHaveText('這個連結已經在活動集錦裡了。');
  await expect(page.getByLabel('影片連結')).toHaveValue(`${YOUTUBE}&si=again`);
  let held = 0;
  await page.route(`**/api/v1/event-highlights/${ONLINE}/photos`, async route => {
    held += 1;
    if (held === 1) await new Promise(resolve => setTimeout(resolve, 900));
    await route.continue();
  });
  await page.getByRole('group', {name: '要補上的內容'}).getByRole('button', {name: '照片', exact: true}).click();
  const photos = [
    {name: 'one.jpg', mimeType: 'image/jpeg', buffer: await sharp({create: {width: 80, height: 40, channels: 3, background: '#2255aa'}}).jpeg().toBuffer()},
    {name: 'two.png', mimeType: 'image/png', buffer: await sharp({create: {width: 40, height: 80, channels: 3, background: '#c4ff20'}}).png().toBuffer()},
  ];
  await page.getByLabel('照片', {exact: true}).setInputFiles(photos);
  await page.getByLabel('標題（選填）').fill('現場照片');
  const progress = page.getByRole('status').filter({hasText: /正在上傳第/}).waitFor({timeout: 20000});
  await page.getByRole('button', {name: '送出', exact: true}).click();
  await progress;
  await expect(page.locator('.hl-shot')).toHaveCount(2);
  await page.getByRole('group', {name: '要補上的內容'}).getByRole('button', {name: '海報', exact: true}).click();
  await page.getByLabel('海報', {exact: true}).setInputFiles({name: 'poster.webp', mimeType: 'image/webp', buffer: await sharp({create: {width: 90, height: 50, channels: 3, background: '#ff8800'}}).webp().toBuffer()});
  await page.getByLabel('標題（選填）').fill('主視覺海報');
  await page.getByRole('button', {name: '送出', exact: true}).click();
  const posterImage = page.getByRole('img', {name: '主視覺海報'});
  await expect(posterImage).toBeVisible();
  await expect.poll(() => posterImage.evaluate(img => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  const frames = await page.locator('.hl-posters .hl-frame').evaluateAll(nodes => nodes.map(node => {
    const box = node.getBoundingClientRect();
    return {left: box.left, width: box.width};
  }));
  expect(frames.length).toBeGreaterThanOrEqual(2);
  expect(Math.abs(frames[0].left - frames[1].left)).toBeLessThanOrEqual(2);
  expect(Math.abs(frames[0].width - frames[1].width)).toBeLessThanOrEqual(2);
  const posterAlign = await page.locator('.hl-posters figure').filter({hasText: '主視覺海報'}).evaluate(figure => {
    const frame = figure.querySelector('.hl-frame')!.getBoundingClientRect();
    const image = figure.querySelector('img')!.getBoundingClientRect();
    const caption = figure.querySelector('figcaption')!.getBoundingClientRect();
    const button = figure.querySelector('button')!.getBoundingClientRect();
    return {
      imageCenter: Math.abs((image.left + image.right) / 2 - (frame.left + frame.right) / 2),
      captionLeft: Math.abs(caption.left - frame.left),
      buttonLeft: Math.abs(button.left - frame.left),
    };
  });
  expect(posterAlign.imageCenter).toBeLessThan(2);
  expect(posterAlign.captionLeft).toBeLessThanOrEqual(2);
  expect(posterAlign.buttonLeft).toBeLessThanOrEqual(2);
  const cells = page.locator('.hl-photo');
  await expect(cells).toHaveCount(2);
  for (const cell of await cells.all()) {
    const imageBox = await cell.locator('img').boundingBox();
    const buttonBox = await cell.getByRole('button', {name: /^移除/}).boundingBox();
    expect(imageBox).toBeTruthy();
    expect(buttonBox).toBeTruthy();
    expect(buttonBox!.y).toBeGreaterThanOrEqual(imageBox!.y + imageBox!.height - 1);
    expect(Math.abs((buttonBox!.x + buttonBox!.width / 2) - (imageBox!.x + imageBox!.width / 2))).toBeLessThan(imageBox!.width / 2);
  }
  await page.screenshot({path: `${SHOTS}/member-detail-light-1280.png`, fullPage: true});
  const thumbs = page.locator('.hl-shot');
  await thumbs.first().click();
  const dialog = page.getByRole('dialog', {name: '活動照片'});
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', {name: '下一張', exact: true}).click();
  await page.keyboard.press('ArrowLeft');
  await page.screenshot({path: `${SHOTS}/member-lightbox-light-1280.png`});
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(thumbs.first()).toBeFocused();
  page.once('dialog', dialogBox => dialogBox.accept());
  await page.getByRole('button', {name: '移除 現場照片', exact: true}).first().click();
  await expect(page.locator('.hl-shot')).toHaveCount(1);
  await page.getByRole('button', {name: '分享', exact: true}).click();
  await expect(page.getByText('已複製公開連結。').or(page.getByLabel('公開連結'))).toBeVisible();
});

test('another member cannot remove someone else\'s item, and the organizer can', async ({page}) => {
  await login(page, 'highlight-guild-viewer@local.test');
  await page.goto(`/#highlights/${GUILD}`);
  await expect(page.getByRole('heading', {name: '實體公會聚會', level: 2})).toBeVisible();
  await expect(page.getByRole('heading', {name: '海報', level: 2})).toBeVisible();
  await expect(page.getByRole('heading', {name: '錄影與影片', level: 2})).toBeVisible();
  await expect(page.getByRole('heading', {name: '活動照片', level: 2})).toBeVisible();
  await expect(page.getByText('還沒有人補上內容。參加過的夥伴可以上傳照片、海報或貼上影片連結。')).toBeVisible();
  await expect(page.getByText(GUILD_COPY)).toBeVisible();
  await expect(page.getByText(MEMBER_COPY)).toHaveCount(0);
  await expect(page.getByRole('button', {name: '展開', exact: true})).toBeVisible();
  await page.goto(`/#highlights/${ONLINE}`);
  await expect(page.getByRole('heading', {name: '線上分享回顧', level: 2})).toBeVisible();
  await expect(page.getByRole('button', {name: /^移除/})).toHaveCount(0);
  await page.getByText('補上照片或影片連結').click();
  await page.getByLabel('影片連結').fill('https://www.facebook.com/watch/highlight-e2e');
  await page.getByLabel('標題（選填）').fill('需求者補上的影片');
  await page.getByRole('button', {name: '送出', exact: true}).click();
  const own = page.locator('.hl-item').filter({hasText: '需求者補上的影片'});
  await expect(own.getByRole('button', {name: '移除', exact: true})).toBeVisible();
  await expect(page.getByRole('button', {name: /^移除/})).toHaveCount(1);
  await signOut(page);
  await login(page);
  await page.goto(`/#highlights/${ONLINE}`);
  page.once('dialog', dialogBox => dialogBox.accept());
  await own.getByRole('button', {name: '移除', exact: true}).click();
  await expect(page.getByText('需求者補上的影片')).toHaveCount(0);
});

test('signed-out visitors see public pages while guild highlights and private fields stay unavailable', async ({browser}) => {
  const guest = await browser.newContext();
  await allowLocal(guest);
  const page = await guest.newPage();
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto('/highlights');
  await expect(page.getByRole('heading', {name: '活動集錦', level: 1})).toBeVisible();
  await expect(page.getByRole('heading', {name: '線上分享回顧'})).toBeVisible();
  await expect(page.getByRole('heading', {name: '實體公會聚會'})).toHaveCount(0);
  await expect(page.getByText('驗收帳號的活動')).toHaveCount(0);
  await expect(page.getByText('即將舉辦')).toHaveCount(0);
  await expect(page.getByText(LOCATION)).toHaveCount(0);
  await expect(page.getByText(MEETING)).toHaveCount(0);
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '活動集錦｜自由工坊');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://freetwai.com/highlights');
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', /freedom-workshop\.webp$/);
  await page.screenshot({path: `${SHOTS}/public-list-light-1280.png`, fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await noOverflow(page, 'public list 390');
  await page.screenshot({path: `${SHOTS}/public-list-light-390.png`, fullPage: true});
  await page.setViewportSize({width: 820, height: 900});
  await noOverflow(page, 'public list 820');
  await page.setViewportSize({width: 1280, height: 900});
  const denied = await page.goto(`/highlights/${GUILD}`);
  expect(denied?.status()).toBe(404);
  await expect(page.getByRole('heading', {name: '實體公會聚會', level: 1})).toHaveCount(0);
  await expect(page.getByText(GUILD_COPY)).toHaveCount(0);
  expect(await page.content()).not.toContain(GUILD_COPY);
  expect((await page.request.get(`/api/v1/public/event-highlights/${GUILD}`)).status()).toBe(404);
  expect((await page.request.get(`/api/v1/public/event-highlights/${GUILD}/banner`)).status()).toBe(404);
  await page.screenshot({path: `${SHOTS}/public-guild-light-1280.png`, fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await noOverflow(page, 'public guild detail 390');
  await page.screenshot({path: `${SHOTS}/public-guild-light-390.png`, fullPage: true});
  await page.setViewportSize({width: 1280, height: 900});
  await page.goto(`/highlights/${ONLINE}`);
  await expect(page.getByRole('heading', {name: '線上分享回顧', level: 1})).toBeVisible();
  await expect(page.getByText('這是一場已經結束的線上分享，歡迎回顧照片與影片。')).toBeVisible();
  await expect(page.getByRole('heading', {name: '海報', level: 2})).toBeVisible();
  await expect(page.getByRole('heading', {name: '錄影與影片', level: 2})).toBeVisible();
  await expect(page.getByRole('heading', {name: '活動照片', level: 2})).toBeVisible();
  await expect(page.getByText('YouTube 影片')).toBeVisible();
  await expect(page.getByText('主視覺海報')).toBeVisible();
  await expect(page.getByRole('link', {name: '開啟影片 ↗'})).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abcdefghijk');
  await expect(page.getByText(LOCATION)).toHaveCount(0);
  await expect(page.getByText('secret-meet.example')).toHaveCount(0);
  await expect(page.getByRole('link', {name: '會員登入後補上照片或影片連結'})).toHaveAttribute('href', `/#highlights/${ONLINE}`);
  await expect(page.getByRole('link', {name: '加入自由工坊'})).toHaveAttribute('href', '/');
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute('content', '線上分享回顧｜自由工坊活動集錦');
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', `https://freetwai.com/highlights/${ONLINE}`);
  await expect(page.locator('meta[property="og:image"]')).toHaveAttribute('content', new RegExp(`/api/v1/public/event-highlights/${ONLINE}/banner$`));
  await expect(page.locator('meta[name="twitter:card"]')).toHaveAttribute('content', 'summary_large_image');
  await page.screenshot({path: `${SHOTS}/public-detail-light-1280.png`, fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await noOverflow(page, 'public detail 390');
  await page.screenshot({path: `${SHOTS}/public-detail-light-390.png`, fullPage: true});
  await page.emulateMedia({colorScheme: 'dark'});
  await page.setViewportSize({width: 1280, height: 900});
  await page.screenshot({path: `${SHOTS}/public-detail-dark-1280.png`, fullPage: true});
  await page.goto('/highlights');
  await page.screenshot({path: `${SHOTS}/public-list-dark-1280.png`, fullPage: true});
  await page.setViewportSize({width: 390, height: 844});
  await page.goto(`/highlights/${ONLINE}`);
  await page.screenshot({path: `${SHOTS}/public-detail-dark-390.png`, fullPage: true});
  await guest.close();
});

test('badges, chips and placeholders stay readable in light, dark and versefolk', async ({page}) => {
  await page.setViewportSize({width: 1280, height: 900});
  await login(page);
  await openHighlights(page);
  for (const theme of ['light', 'dark', 'versefolk'] as const) {
    await setTheme(page, theme);
    await page.goto('/#highlights');
    await expect(page.locator('.hl-mode-in_person')).toBeVisible();
    await settledColors(page, '.hl-chip[aria-pressed="true"]');
    await navigate(page, '社群分享');
    await page.getByRole('button',{name:'動態選項',exact:true}).click();
    const filter = page.getByRole('dialog',{name:'動態選項',exact:true}).getByRole('button', {name: '社群貼文', exact: true});
    await expect(filter).toBeVisible();
    await expect(filter).toHaveAttribute('aria-pressed','true');
    await settledColors(page, '.social-filter[aria-pressed="true"]');
    const socialFilter = await paints(page, '.social-filter[aria-pressed="true"]');
    expect(contrast(socialFilter.color, socialFilter.background), `${theme} social filter`).toBeGreaterThanOrEqual(4.5);
    expect(await filter.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await page.getByRole('button',{name:'關閉動態選項',exact:true}).click();
    await page.goto('/#highlights');
    await expect(page.locator('.hl-mode-in_person')).toBeVisible();
    const online = await paints(page, '.hl-mode-online');
    const room = await paints(page, '.hl-mode-in_person');
    const pressed = await paints(page, '.hl-chip[aria-pressed="true"]');
    const idle = await paints(page, '.hl-chip[aria-pressed="false"]');
    const placeholder = await paints(page, '.hl-placeholder');
    await page.goto(`/#highlights/${ONLINE}`);
    await expect(page.locator('.hl-platform').first()).toBeVisible();
    const platform = await paints(page, '.hl-platform');
    for (const [name, paint] of [['online', online], ['room', room], ['pressed', pressed], ['placeholder', placeholder], ['platform', platform]] as const) {
      expect(contrast(paint.color, paint.background), `${theme} ${name}`).toBeGreaterThanOrEqual(4.5);
    }
    expect(online.color, theme).not.toBe(room.color);
    expect(pressed.background !== idle.background || pressed.color !== idle.color, theme).toBe(true);
    expect(placeholder.background, theme).not.toBe(pressed.background);
  }
  await setTheme(page, 'light');
  await page.setViewportSize({width: 390, height: 844});
  await noOverflow(page, 'member detail 390');
  await page.screenshot({path: `${SHOTS}/member-detail-light-390.png`, fullPage: true});
  await setTheme(page, 'dark');
  await page.setViewportSize({width: 1280, height: 900});
  await page.screenshot({path: `${SHOTS}/member-detail-dark-1280.png`, fullPage: true});
  await page.setViewportSize({width: 820, height: 900});
  await noOverflow(page, 'member detail 820');
  await page.setViewportSize({width: 1280, height: 900});
  await noOverflow(page, 'member detail 1280');
  const guest = await page.context().browser()!.newContext({colorScheme: 'dark'});
  await allowLocal(guest);
  const publicPage = await guest.newPage();
  await publicPage.setViewportSize({width: 1280, height: 900});
  await publicPage.goto('/highlights');
  const current = await paints(publicPage, '.hl-chips a[aria-current]');
  const plain = await paints(publicPage, '.hl-chips a:not([aria-current])');
  const mark = await paints(publicPage, '.hl-mode');
  const blank = await paints(publicPage, '.hl-placeholder');
  expect(contrast(current.color, current.background), 'public dark chip').toBeGreaterThanOrEqual(4.5);
  expect(contrast(mark.color, mark.background), 'public dark mode').toBeGreaterThanOrEqual(4.5);
  expect(contrast(blank.color, blank.background), 'public dark placeholder').toBeGreaterThanOrEqual(4.5);
  expect(current.background !== plain.background || current.color !== plain.color).toBe(true);
  await guest.close();
  for (const theme of ['light', 'dark'] as const) {
    await setTheme(page, theme);
    for (const width of [1280, 390] as const) {
      await page.setViewportSize({width, height: width === 390 ? 844 : 900});
      await page.goto('/#highlights');
      const chips = page.locator('.hl-chips');
      await expect(chips).toBeVisible();
      await settledColors(page, '.hl-chip[aria-pressed="true"]');
      await chips.screenshot({path: `${SHOTS}/highlights-chips-${theme}-${width}.png`});
    }
  }
});
