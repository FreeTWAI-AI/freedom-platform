import {test, expect, type Page} from './fixtures.js';
import {navigate} from './navigation.js';

async function login(page: Page) {
  await page.goto('/');
  await page.getByLabel('電子郵件', {exact: true}).fill('maker@local.test');
  await page.getByLabel('密碼', {exact: true}).fill('freedom-local-demo');
  await page.getByRole('button', {name: '登入', exact: true}).click();
  await expect(page.locator('.shell')).toBeVisible();
  await navigate(page, '社群分享');
  await page.getByRole('button',{name:'建立貼文',exact:true}).click();
}
function card(page: Page, text: string) { return page.locator('.social-card').filter({has: page.locator('.social-note').filter({hasText: text})}); }

test('write a native post, like, comment, remove and reload without duplicate effects', async ({page}) => {
  await login(page);
  const text = `E2E 工坊作品 ${Date.now()}\n想找夥伴一起完成`;
  await page.getByLabel('貼文內容', {exact: true}).fill(text);
  await page.getByRole('button', {name: '發布貼文', exact: true}).click();
  const post = card(page, text);
  await expect(post).toBeVisible();
  await expect(page.getByRole('dialog',{name:'建立貼文',exact:true})).toBeHidden();
  await expect(post.getByRole('link', {name: '開啟原文 ↗'})).toHaveCount(0);
  await post.getByRole('button', {name: '讚 · 0', exact: true}).click();
  await expect(post.getByRole('button', {name: '已讚 · 1', exact: true})).toHaveAttribute('aria-pressed', 'true');
  await post.getByRole('button', {name: '留言 · 0', exact: true}).click();
  await post.getByLabel('寫留言', {exact: true}).fill('<script>window.bad=true</script>\n一起合作');
  await post.getByRole('button', {name: '送出留言', exact: true}).click();
  await expect(post.locator('.social-comment')).toContainText('<script>window.bad=true</script>');
  await expect(post.locator('.social-comment script')).toHaveCount(0);
  await expect(post.getByRole('button', {name: '留言 · 1', exact: true})).toBeVisible();
  await page.screenshot({path: 'test-results/social-feed-desktop.png', fullPage: true});
  await post.getByRole('button', {name: '刪除留言', exact: true}).click();
  await post.getByRole('button', {name: '確定刪除留言', exact: true}).click();
  await expect(post.getByRole('button', {name: '留言 · 0', exact: true})).toBeVisible();
  await page.reload();
  await expect(card(page, text)).toHaveCount(1);
  await expect(card(page, text).getByRole('button', {name: '已讚 · 1', exact: true})).toBeVisible();
  await card(page, text).getByRole('button', {name: '刪除', exact: true}).click();
  await card(page, text).getByRole('button', {name: '確定刪除', exact: true}).click();
  await expect(card(page, text)).toHaveCount(0);
});

test('lost publication response keeps the same command and recovers exactly one post', async ({page, e2eAuthPool}) => {
  await login(page);
  const text = `E2E 不確定結果 ${Date.now()}`;
  const keys: string[] = [];
  await page.route('**/api/v1/social-posts/notes', async route => {
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) { await route.fetch(); await route.abort('failed'); }
    else await route.continue();
  });
  await page.getByLabel('貼文內容', {exact: true}).fill(text);
  await page.getByRole('button', {name: '發布貼文', exact: true}).click();
  await expect(page.getByRole('button', {name: '重試發布', exact: true})).toBeVisible();
  await expect(page.getByLabel('貼文內容', {exact: true})).toHaveValue(text);
  await expect(page.getByLabel('貼文內容', {exact: true})).toBeDisabled();
  await page.getByRole('button', {name: '重試發布', exact: true}).click();
  await expect(card(page, text)).toHaveCount(1);
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM community_social_posts WHERE note=$1', [text])).rows[0].n).toBe(1);
});

test('mobile native feed uses readable text, 44px controls and no horizontal overflow', async ({page}) => {
  await page.setViewportSize({width: 390, height: 844});
  await login(page);
  const text = `E2E 手機發文 ${Date.now()}\n${Array.from({length:8},(_,index)=>`第 ${index+1} 段：分享作品和合作想法。`).join('\n')}`;
  await page.getByLabel('貼文內容', {exact: true}).fill(text);
  expect(await page.getByLabel('貼文內容').evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  expect((await page.getByRole('button',{name:'發布貼文',exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path:'test-results/social-publish-mobile.png'});
  await page.getByRole('button', {name: '發布貼文', exact: true}).click();
  const post = card(page, text);
  await expect(post).toBeVisible();
  const expand=post.getByRole('button',{name:'顯示全文',exact:true});
  await expect(expand).toHaveAttribute('aria-expanded','false');
  const summaryHeight=(await post.locator('.social-note').boundingBox())!.height;
  await expand.click();
  await expect(post.getByRole('button',{name:'收合',exact:true})).toHaveAttribute('aria-expanded','true');
  expect((await post.locator('.social-note').boundingBox())!.height).toBeGreaterThan(summaryHeight);
  await post.getByRole('button',{name:'收合',exact:true}).click();
  await expect(expand).toHaveAttribute('aria-expanded','false');
  await post.getByRole('button', {name: '留言 · 0', exact: true}).click();
  await post.getByLabel('寫留言', {exact: true}).fill('手機也能直接留言');
  await post.getByRole('button', {name: '送出留言', exact: true}).click();
  await expect(post.locator('.social-comment')).toContainText('手機也能直接留言');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  for (const control of [page.getByRole('button', {name: '建立貼文', exact: true}), post.getByRole('button', {name: '讚 · 0', exact: true})]) expect((await control.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({path: 'test-results/social-feed-mobile.png', fullPage: true});
});

test('home shows the timeline immediately and the composer keeps a draft when closed',async({page})=>{
  await page.setViewportSize({width:1440,height:1000});
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();
  const feed=page.getByRole('region',{name:'首頁社群動態'});
  await expect(feed).toBeVisible();
  const trigger=feed.getByRole('button',{name:'建立貼文',exact:true});await expect(trigger).toBeInViewport();
  expect(await feed.locator('xpath=ancestor::details').count()).toBe(0);
  const feedBox=(await feed.boundingBox())!,contextBox=(await page.locator('.home-context').boundingBox())!;
  expect(contextBox.x).toBeGreaterThanOrEqual(feedBox.x+feedBox.width);
  await trigger.click();const dialog=page.getByRole('dialog',{name:'建立貼文',exact:true});
  await expect(dialog.getByLabel('貼文內容')).toBeFocused();
  const text=`測試貼文 ${Date.now()}：完成 AI 作品，想找設計與行銷夥伴一起合作。`;
  await dialog.getByLabel('貼文內容').fill(text);await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();await expect(trigger).toBeFocused();
  await trigger.click();await expect(dialog.getByLabel('貼文內容')).toHaveValue(text);await dialog.getByRole('button',{name:'發布貼文',exact:true}).click();
  await expect(feed.locator('.social-card').filter({hasText:text})).toBeVisible();
  await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:'test-results/social-home-desktop.png'});
  await page.setViewportSize({width:390,height:844});await page.evaluate(()=>window.scrollTo(0,0));
  await expect(trigger).toBeInViewport();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/social-home-mobile.png'});
  await page.reload();await expect(feed.locator('.social-card').filter({hasText:text})).toHaveCount(1);
});

test('a failed comment keeps its draft and reuses the command after the server committed', async ({page, e2eAuthPool}) => {
  await login(page);
  const text = `E2E 留言重試 ${Date.now()}`;
  await page.getByLabel('貼文內容').fill(text); await page.getByRole('button', {name: '發布貼文', exact: true}).click();
  const post = card(page, text); await expect(post).toBeVisible();
  await post.getByRole('button', {name: '留言 · 0', exact: true}).click();
  const keys: string[] = [];
  await page.route('**/api/v1/social-posts/*/comments', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    keys.push(route.request().headers()['idempotency-key']);
    if (keys.length === 1) { await route.fetch(); await route.abort('failed'); } else await route.continue();
  });
  await post.getByLabel('寫留言').fill('重試只留一則'); await post.getByRole('button', {name: '送出留言', exact: true}).click();
  await expect(post.getByRole('button', {name: '重試留言', exact: true})).toBeVisible();
  await expect(post.getByLabel('寫留言')).toHaveValue('重試只留一則');
  await post.getByRole('button', {name: '重試留言', exact: true}).click();
  await expect(post.locator('.social-comment')).toHaveCount(1);
  expect(keys).toHaveLength(2); expect(keys[1]).toBe(keys[0]);
  expect((await e2eAuthPool.query("SELECT count(*)::int AS n FROM community_social_comments WHERE body='重試只留一則'")).rows[0].n).toBe(1);
});
