import sharp from 'sharp';
import {test, expect, type Page} from './fixtures.js';
import {navigate, selectSocialFeed} from './navigation.js';

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

test('the phone homepage starts with member posts and one clear composer, with extra controls out of the wall',async({page,e2eAuthPool})=>{
  await page.setViewportSize({width:390,height:844});await login(page);
  const text=`E2E 清楚的動態牆 ${Date.now()}：分享我的新作品，歡迎一起討論。`;
  await page.getByLabel('貼文內容',{exact:true}).fill(text);await page.getByRole('button',{name:'發布貼文',exact:true}).click();
  const post=card(page,text);await expect(post).toBeVisible();
  const postId=(await post.getAttribute('id'))!.replace('social-post-','');
  const externalTitle=`E2E 外部連結 ${Date.now()}`;
  const inserted=await e2eAuthPool.query(`INSERT INTO community_social_posts(community_id,author_user_id,kind,url,platform,title,note,state)
    SELECT community_id,author_user_id,'link',$2,'other',$3,'外部內容仍可透過動態選項查看。','active'
    FROM community_social_posts WHERE post_id=$1 RETURNING post_id`,[postId,`https://example.com/feed-${postId}`,externalTitle]);
  try{
    await page.goto('/#home');const feed=page.getByRole('region',{name:'首頁社群動態'});
    await expect(feed.locator('.social-zone')).toHaveAttribute('data-feed','note');await expect(card(page,text)).toBeVisible();
    await expect(feed.getByRole('heading',{name:externalTitle,exact:true})).toHaveCount(0);
    await expect(feed.getByRole('combobox')).toHaveCount(0);
    await expect(feed.locator('details.social-composer')).toHaveCount(0);
    await expect(post.locator('.social-platform-badge')).toHaveCount(0);
    await expect(post.getByRole('button',{name:'刪除',exact:true})).toBeHidden();
    const trigger=feed.getByRole('button',{name:'建立貼文',exact:true}),options=feed.getByRole('button',{name:'動態選項',exact:true});
    await expect(trigger).toContainText('＋發文');
    for(const theme of ['light','dark','versefolk'])for(const width of [320,390]){
      await page.evaluate(value=>document.documentElement.dataset.theme=value,theme);
      await page.setViewportSize({width,height:844});await page.evaluate(()=>scrollTo(0,0));
      await expect(trigger).toBeInViewport();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      expect((await trigger.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      expect((await post.getByRole('button',{name:'讚 · 0',exact:true}).boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await page.screenshot({path:`test-results/social-postwall-${theme}-${width}.png`});
    }
    await options.click();await page.keyboard.press('Escape');await expect(options).toBeFocused();
    await selectSocialFeed(page,'全部動態');await expect(feed.getByRole('heading',{name:externalTitle,exact:true})).toBeVisible();
    await selectSocialFeed(page,'社群貼文');await expect(feed.getByRole('heading',{name:externalTitle,exact:true})).toHaveCount(0);
    await options.click();await page.getByRole('dialog',{name:'動態選項',exact:true}).getByRole('button',{name:'分享外部連結',exact:true}).click();
    const link=page.getByRole('dialog',{name:'分享外部連結',exact:true});await expect(link.getByLabel('連結',{exact:true})).toBeFocused();
    await link.getByLabel('連結',{exact:true}).fill('https://example.com/unpublished-draft');await page.keyboard.press('Escape');
    await expect(link).toBeHidden();await expect(options).toBeFocused();
    await options.click();await page.getByRole('dialog',{name:'動態選項',exact:true}).getByRole('button',{name:'分享外部連結',exact:true}).click();
    await expect(link.getByLabel('連結',{exact:true})).toHaveValue('https://example.com/unpublished-draft');await page.keyboard.press('Escape');
  }finally{await e2eAuthPool.query('DELETE FROM community_social_posts WHERE post_id=$1',[inserted.rows[0].post_id]);}
});

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
  await card(page, text).getByText('⋯',{exact:true}).click();
  await card(page, text).getByRole('button', {name: '刪除', exact: true}).click();
  await page.getByRole('dialog', {name: '刪除貼文？', exact: true}).getByRole('button', {name: '確定刪除', exact: true}).click();
  await expect(card(page, text)).toHaveCount(0);
});

test('a note publishes with its image, unusable files are refused before upload, and deleting confirms in a dialog', async ({page}) => {
  await login(page);
  const text = `E2E 附圖貼文 ${Date.now()}`;
  const composer = page.getByRole('dialog', {name: '建立貼文', exact: true}), picker = composer.getByLabel('貼文圖片（選填）');
  await composer.getByLabel('貼文內容', {exact: true}).fill(text);
  await picker.setInputFiles({name: 'huge.png', mimeType: 'image/png', buffer: Buffer.alloc(20 * 1024 * 1024 + 1, 1)});
  await expect(composer.getByRole('alert')).toContainText('這張圖片超過 20 MB');
  await picker.setInputFiles({name: 'anim.gif', mimeType: 'image/gif', buffer: Buffer.from('GIF89a')});
  await expect(composer.getByRole('alert')).toContainText('請選擇 JPEG、PNG 或 WebP 圖片。');
  await expect(composer.getByRole('img', {name: '待發布圖片預覽'})).toHaveCount(0);
  await expect(picker).toHaveValue('');
  const work = {name: 'work.png', mimeType: 'image/png', buffer: await sharp({create: {width: 800, height: 450, channels: 3, background: '#2a6f4b'}}).png().toBuffer()};
  await picker.setInputFiles(work);
  await expect(composer.getByRole('img', {name: '待發布圖片預覽'})).toBeVisible();
  await expect(picker).toHaveValue(/work\.png$/);
  await composer.getByRole('button', {name: '移除圖片', exact: true}).click();
  await expect(composer.getByRole('img', {name: '待發布圖片預覽'})).toHaveCount(0);
  await expect(picker).toHaveValue('');
  await picker.setInputFiles(work);
  await expect(composer.getByRole('img', {name: '待發布圖片預覽'})).toBeVisible();
  await expect(composer.getByRole('alert')).toHaveCount(0);
  await page.screenshot({path: 'test-results/social-compose-image-desktop.png'});
  await composer.getByRole('button', {name: '發布貼文', exact: true}).click();
  const post = card(page, text);
  await expect(post).toBeVisible();
  await expect(composer).toBeHidden();
  await expect(post.locator('img.social-thumb')).toHaveJSProperty('naturalWidth', 640);
  await post.getByText('⋯', {exact: true}).click();
  await expect(post.locator('.social-post-menu-actions')).toBeVisible();
  await expect(post.getByText('加入圖片')).toHaveCount(0);
  await expect(post.getByText('換圖片')).toHaveCount(0);
  await post.getByRole('button', {name: '刪除', exact: true}).click();
  const dialog = page.getByRole('dialog', {name: '刪除貼文？', exact: true});
  await expect(dialog).toContainText('刪除後無法復原');
  await expect(dialog.getByRole('button', {name: '取消', exact: true})).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(post.locator('summary')).toBeFocused();
  await expect(card(page, text)).toHaveCount(1);
  await page.setViewportSize({width: 390, height: 844});
  await post.getByRole('button', {name: '刪除', exact: true}).click();
  await expect(dialog).toBeVisible();
  expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(390);
  await page.screenshot({path: 'test-results/social-delete-dialog-390.png'});
  await dialog.getByRole('button', {name: '取消', exact: true}).click();
  await expect(dialog).toBeHidden();
  await post.getByRole('button', {name: '刪除', exact: true}).click();
  await dialog.getByRole('button', {name: '確定刪除', exact: true}).click();
  await expect(dialog).toBeHidden();
  await expect(card(page, text)).toHaveCount(0);
  await page.reload();
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

test('a late publication ACK preserves the newer filter and focus without hiding the saved post',async({page,e2eAuthPool})=>{
  await login(page);
  const text=`E2E 分類切換 ${Date.now()}`;
  let release!:()=>void,committed!:()=>void;
  const gate=new Promise<void>(resolve=>release=resolve),saved=new Promise<void>(resolve=>committed=resolve);
  await page.route('**/api/v1/social-posts/notes',async route=>{
    const response=await route.fetch();committed();await gate;await route.fulfill({response});
  });
  try{
    await page.getByLabel('貼文內容',{exact:true}).fill(text);
    await page.getByRole('button',{name:'發布貼文',exact:true}).click();await saved;
    await page.getByRole('button',{name:'關閉發文',exact:true}).click();
    const filter=page.getByRole('button',{name:'動態選項',exact:true});
    const loaded=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/social-posts'&&new URL(response.url()).searchParams.get('platform')==='youtube'&&response.request().method()==='GET');
    await selectSocialFeed(page,'YouTube');await loaded;
    await expect(page.getByText('正在載入貼文…',{exact:true})).toBeHidden();await filter.focus();
    release();await expect(page.getByText('貼文已發布。',{exact:true})).toBeVisible();
    await expect(page.locator('.social-zone')).toHaveAttribute('data-feed','youtube');await expect(filter).toBeFocused();
    await expect(card(page,text)).toHaveCount(0);
    await selectSocialFeed(page,'社群貼文');await expect(card(page,text)).toHaveCount(1);
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM community_social_posts WHERE note=$1',[text])).rows[0].n).toBe(1);

    // An unchanged external filter still switches to the saved native post.
    await selectSocialFeed(page,'YouTube');await page.getByRole('button',{name:'建立貼文',exact:true}).click();
    const next=`E2E 原分類發文 ${Date.now()}`;await page.getByLabel('貼文內容',{exact:true}).fill(next);
    await page.getByRole('button',{name:'發布貼文',exact:true}).click();
    await expect(page.locator('.social-zone')).toHaveAttribute('data-feed','note');await expect(card(page,next)).toHaveCount(1);
    await expect(page.getByRole('button',{name:'建立貼文',exact:true})).toBeFocused();
  }finally{release();}
});

test('sending during the first comment page keeps its snapshot, cursor and one copy of the new comment',async({page,e2eAuthPool})=>{
  await login(page);
  const text=`E2E 留言分頁交錯 ${Date.now()}`;await page.getByLabel('貼文內容',{exact:true}).fill(text);
  await page.getByRole('button',{name:'發布貼文',exact:true}).click();const post=card(page,text);await expect(post).toBeVisible();
  const postId=(await post.getAttribute('id'))!.replace('social-post-','');
  await e2eAuthPool.query(`INSERT INTO community_social_comments(post_id,community_id,author_user_id,body,created_at)
    SELECT p.post_id,p.community_id,p.author_user_id,'既有留言 '||lpad(i::text,2,'0'),now()-interval '1 minute'+i*interval '1 second'
    FROM community_social_posts p CROSS JOIN generate_series(1,26) i WHERE p.post_id=$1`,[postId]);
  await page.getByRole('button',{name:'更新動態',exact:true}).click();
  await expect(post.getByRole('button',{name:'留言 · 26',exact:true})).toBeVisible();
  let release!:()=>void,captured!:()=>void,held=false;
  const gate=new Promise<void>(resolve=>release=resolve),snapshot=new Promise<void>(resolve=>captured=resolve);
  let firstPage:{items:unknown[];next_cursor:string|null}|undefined;
  await page.route(`**/api/v1/social-posts/${postId}/comments*`,async route=>{
    const request=route.request();
    if(request.method()!=='GET'||new URL(request.url()).searchParams.has('cursor')||held)return route.continue();
    held=true;const response=await route.fetch();firstPage=await response.json();captured();await gate;await route.fulfill({response});
  });
  try{
    await post.getByRole('button',{name:'留言 · 26',exact:true}).click();await snapshot;
    expect(firstPage!.items).toHaveLength(24);expect(firstPage!.next_cursor).toBeTruthy();
    await post.getByLabel('寫留言',{exact:true}).fill('新留言必須和既有內容一起保留');
    await post.getByRole('button',{name:'送出留言',exact:true}).click();
    await expect(post.getByRole('button',{name:'留言 · 27',exact:true})).toBeVisible();
    await expect(post.locator('.social-comment')).toHaveCount(1);
    release();await expect(post.locator('.social-comment')).toHaveCount(25);
    await expect(post.getByText('既有留言 01',{exact:true})).toBeVisible();
    await post.getByRole('button',{name:'載入更多留言',exact:true}).click();
    await expect(post.locator('.social-comment')).toHaveCount(27);
    await expect(post.getByText('既有留言 26',{exact:true})).toBeVisible();
    await expect(post.getByText('新留言必須和既有內容一起保留',{exact:true})).toHaveCount(1);
    await expect(post.getByRole('button',{name:'載入更多留言',exact:true})).toHaveCount(0);
    expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM community_social_comments WHERE post_id=$1',[postId])).rows[0].n).toBe(27);
  }finally{release();}
});
