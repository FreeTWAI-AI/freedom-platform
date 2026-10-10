import sharp from 'sharp';
import {test,expect,type Page} from './fixtures.js';
async function login(page:Page){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.locator('.shell')).toBeVisible();}
function card(page:Page,text:string){return page.locator('.social-card').filter({has:page.locator('.social-note').filter({hasText:text})});}

test('wall tools publish topics, mentions, check-ins and pictures; social comments and share controls work at every width',async({page})=>{
 const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await login(page);
 await page.getByRole('button',{name:'新增照片貼文',exact:true}).click();
 const compose=page.getByRole('dialog',{name:'建立貼文',exact:true}),text=`一起分享今日作品 ${Date.now()}`;
 await compose.getByLabel('貼文內容',{exact:true}).fill(text+' #作品');
 await compose.getByLabel('貼文主題').selectOption('work');await compose.getByRole('button',{name:'打卡',exact:true}).click();await compose.getByLabel('打卡地點',{exact:true}).fill('台北松菸');
 await compose.getByRole('button',{name:'標註會員',exact:true}).click();await compose.getByLabel('搜尋標註會員').fill('示範需求者');
 const person=compose.locator('.social-mention-choice').first();await expect(person).toBeVisible();await person.click();
 const png=await sharp({create:{width:480,height:300,channels:3,background:'#728a41'}}).png().toBuffer();
 await compose.getByLabel('貼文圖片（選填）').setInputFiles({name:'作品.png',mimeType:'image/png',buffer:png});await expect(compose.getByAltText('待發布圖片預覽')).toBeVisible();
 await compose.getByRole('button',{name:'發布貼文',exact:true}).click();const post=card(page,text);await expect(post).toBeVisible();await expect(post).toContainText('作品分享');await expect(post).toContainText('台北松菸');await expect(post.locator('.social-note .social-text-link').filter({hasText:'@'})).toHaveCount(1);
 await post.getByRole('button',{name:'讚 · 0',exact:true}).click();await post.getByRole('button',{name:'查看按讚名單'}).click();const people=page.getByRole('dialog',{name:'按讚名單',exact:true});await expect(people).toContainText('示範創作者');await page.keyboard.press('Escape');await expect(post.getByRole('button',{name:'查看按讚名單'})).toBeFocused();
 await post.getByRole('button',{name:'留言 · 0',exact:true}).click();await post.getByLabel('寫留言',{exact:true}).fill('看起來不錯 ');
 await post.getByRole('button',{name:'插入 emoji'}).click();await post.getByRole('button',{name:'插入 😂',exact:true}).click();
 await post.getByLabel('留言圖片',{exact:true}).setInputFiles({name:'回覆.png',mimeType:'image/png',buffer:png});await expect(post.getByAltText('留言圖片預覽')).toBeVisible();await post.getByRole('button',{name:'送出留言',exact:true}).click();
 const comment=post.locator('.social-comment').first();await expect(comment).toContainText('看起來不錯 😂');await expect(comment.getByAltText('留言附圖')).toBeVisible();await expect(comment.getByAltText('留言附圖')).toHaveJSProperty('naturalWidth',480);
 await comment.getByRole('button',{name:'留言讚 · 0',exact:true}).click();await expect(comment.getByRole('button',{name:'留言已讚 · 1',exact:true})).toBeVisible();
 await post.getByLabel('寫留言',{exact:true}).fill('保留的草稿');await post.getByRole('button',{name:'選擇貼圖',exact:true}).click();await post.getByRole('button',{name:'工坊夥伴',exact:true}).click();await post.getByRole('button',{name:'傳送貼圖：加油',exact:true}).click();await expect(post.locator('.social-comment')).toHaveCount(2);await expect(post.getByLabel('寫留言',{exact:true})).toHaveValue('保留的草稿');await expect(post.locator('.social-comment').last().getByRole('img',{name:'貼圖：加油'})).toBeVisible();
 const stickerComment=post.locator('.social-comment').last();await stickerComment.getByLabel('留言選項',{exact:true}).click();await stickerComment.getByRole('button',{name:'編輯留言',exact:true}).click();await stickerComment.getByLabel('編輯留言',{exact:true}).fill('一起加油 🎉');await stickerComment.getByRole('button',{name:'儲存留言',exact:true}).click();await expect(stickerComment).toContainText('一起加油 🎉');await expect(stickerComment.getByRole('img',{name:'貼圖：加油'})).toBeVisible();
 for(const width of [1440,768,390]){
  await page.setViewportSize({width,height:1000});await page.evaluate(()=>window.scrollTo(0,0));expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`test-results/social-wall-${width}.png`,fullPage:false});
 }
 await post.locator('.social-comments').screenshot({path:'test-results/social-wall-comments-390.png'});
 for(const theme of ['dark','versefolk']){await page.evaluate(v=>{document.documentElement.dataset.theme=v;window.scrollTo(0,0);},theme);await page.screenshot({path:`test-results/social-wall-${theme}-390.png`,fullPage:false});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
 await page.evaluate(()=>document.documentElement.dataset.theme='light');await post.getByRole('button',{name:'分享到其他社群',exact:true}).click();const share=page.getByRole('dialog',{name:'分享貼文',exact:true});await share.getByRole('button',{name:'了解並開啟',exact:true}).click();for(const name of ['X','Instagram','Facebook','Threads'])await expect(share.getByRole('button',{name,exact:true})).toHaveAttribute('aria-pressed','true');
 await share.getByRole('button',{name:'加入貼文照片',exact:true}).click();await expect(share.locator('.social-share-files li')).toHaveCount(1);await share.getByRole('button',{name:'準備分享',exact:true}).click();await expect(share).toContainText('本人確認完成 0/4');await page.keyboard.press('Escape');await expect(post.getByRole('button',{name:'分享到其他社群',exact:true})).toBeFocused();
 await post.getByRole('button',{name:'#作品',exact:true}).click();await expect(page.locator('.social-active-tag')).toContainText('#作品');await expect(card(page,text)).toBeVisible();await page.getByRole('button',{name:'清除標籤篩選',exact:true}).click();
 expect(errors).toEqual([]);
});

test('pasted comment image and unknown delivery keep one upload and comment; reload preserves media and read counts',async({page})=>{
 await login(page);await page.getByRole('button',{name:'建立貼文',exact:true}).click();const text=`貼上照片測試 ${Date.now()}`;await page.getByLabel('貼文內容',{exact:true}).fill(text);await page.getByRole('button',{name:'發布貼文',exact:true}).click();const post=card(page,text);
 await post.getByRole('button',{name:'留言 · 0',exact:true}).click();
 const png=await sharp({create:{width:80,height:50,channels:3,background:'#539db8'}}).png().toBuffer();
 await post.getByLabel('寫留言',{exact:true}).evaluate((area,base64)=>{const bytes=Uint8Array.from(atob(base64),c=>c.charCodeAt(0));const data=new DataTransfer();data.items.add(new File([bytes],'clipboard.png',{type:'image/png'}));area.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));},png.toString('base64'));
 await expect(post.getByAltText('留言圖片預覽')).toBeVisible();let attempts=0;const keys:string[]=[];
 await page.route('**/api/v1/social-posts/*/comments',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}keys.push(route.request().headers()['idempotency-key']);const response=await route.fetch();if(++attempts===1)await route.abort('failed');else await route.fulfill({response});});
 await post.getByRole('button',{name:'送出留言',exact:true}).click();await expect(post.getByRole('button',{name:'重試留言',exact:true})).toBeEnabled();await post.getByRole('button',{name:'重試留言',exact:true}).click();await expect(post.locator('.social-comment')).toHaveCount(1);expect(keys[0]).toBe(keys[1]);
 await page.reload();await post.getByRole('button',{name:'留言 · 1',exact:true}).click();await expect(post.getByAltText('留言附圖')).toBeVisible();await post.locator('.social-post-header').scrollIntoViewIfNeeded();await expect(post.locator('.social-interaction-summary')).toContainText('已讀 1 人');
 await post.getByLabel('留言選項',{exact:true}).click();await post.getByRole('button',{name:'刪除留言',exact:true}).click();await post.getByRole('button',{name:'確定刪除留言',exact:true}).click();await expect(post.locator('.social-comment')).toHaveCount(0);
});


test('malformed successful image acknowledgements retain the exact upload and never publish without its photo',async({page})=>{
 await login(page);await page.getByRole('button',{name:'建立貼文',exact:true}).click();
 const text=`圖片回應驗證 ${Date.now()}`;await page.getByLabel('貼文內容',{exact:true}).fill(text);await page.getByRole('button',{name:'發布貼文',exact:true}).click();
 const post=card(page,text);await post.getByRole('button',{name:'留言 · 0',exact:true}).click();await post.getByLabel('寫留言',{exact:true}).fill('照片必須一起送出');
 const png=await sharp({create:{width:80,height:50,channels:3,background:'#539db8'}}).png().toBuffer();
 await post.getByLabel('留言圖片',{exact:true}).setInputFiles({name:'ack.png',mimeType:'image/png',buffer:png});await expect(post.getByAltText('留言圖片預覽')).toBeVisible();
 const uploads:{key:string;bytes:string}[]=[],comments:Record<string,unknown>[]=[];let canonical:Record<string,unknown>={};
 const invalid=[{}, {image_id:'not-a-uuid',content_type:'image/webp',byte_size:1}, {image_id:'11111111-1111-4111-8111-111111111111',content_type:'image/png',byte_size:1}, {image_id:'11111111-1111-4111-8111-111111111111',content_type:'image/webp',byte_size:1048577}];
 await page.route('**/api/v1/social-posts/*/comment-images',async route=>{
  uploads.push({key:route.request().headers()['idempotency-key'],bytes:route.request().postDataBuffer()!.toString('base64')});
  const response=await route.fetch();expect(response.status()).toBe(201);canonical=await response.json();
  const malformed=invalid[uploads.length-1];await route.fulfill(malformed?{response,json:malformed}:{response});
 });
 await page.route('**/api/v1/social-posts/*/comments',async route=>{if(route.request().method()==='POST')comments.push(route.request().postDataJSON());await route.continue();});
 for(let i=0;i<invalid.length;i++){
  await post.getByRole('button',{name:i?'重試留言':'送出留言',exact:true}).click();
  await expect(post.getByRole('button',{name:'重試留言',exact:true})).toBeEnabled();await expect(post.getByAltText('留言圖片預覽')).toBeVisible();
  expect(comments).toHaveLength(0);await expect(post.getByLabel('寫留言',{exact:true})).toHaveValue('照片必須一起送出');
 }
 await post.getByRole('button',{name:'重試留言',exact:true}).click();await expect(post.locator('.social-comment')).toHaveCount(1);await expect(post.getByAltText('留言附圖')).toBeVisible();
 expect(uploads).toHaveLength(invalid.length+1);for(const upload of uploads)expect(upload).toEqual(uploads[0]);
 expect(comments).toHaveLength(1);expect(comments[0].image_id).toBe(canonical.image_id);
});

test('removing mention text removes its selected identity from new post and comment commands',async({page})=>{
 await login(page);await page.getByRole('button',{name:'建立貼文',exact:true}).click();const compose=page.getByRole('dialog',{name:'建立貼文',exact:true});
 async function pick(scope:ReturnType<Page['locator']>){await scope.getByRole('button',{name:'標註會員',exact:true}).click();await scope.getByLabel('搜尋標註會員').fill('示範需求者');await scope.locator('.social-mention-choice').first().click();}
 await pick(compose);const text=`已移除標註 ${Date.now()}`;await compose.getByLabel('貼文內容',{exact:true}).fill(text);
 const sentPost=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/social-posts/notes'));await compose.getByRole('button',{name:'發布貼文',exact:true}).click();expect((await sentPost).postDataJSON().mention_ids).toEqual([]);
 const post=card(page,text);await post.getByRole('button',{name:'留言 · 0',exact:true}).click();await pick(post);await post.getByLabel('寫留言',{exact:true}).fill('這則留言沒有標註');
 const sentComment=page.waitForRequest(r=>r.method()==='POST'&&r.url().endsWith('/comments'));await post.getByRole('button',{name:'送出留言',exact:true}).click();expect((await sentComment).postDataJSON().mention_ids).toEqual([]);await expect(post.locator('.social-comment')).toHaveCount(1);
});
