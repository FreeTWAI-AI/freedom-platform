import {test,expect,type Page} from './fixtures.js';
import sharp from 'sharp';
import type {Pool} from 'pg';
import {signOut} from './navigation.js';

// Requires seeded demo members and FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE=1 (in-memory store, enabled policy row).
const png=await sharp({create:{width:8,height:8,channels:3,background:{r:255,g:255,b:255}}}).png().toBuffer();
const image={name:'screenshot.png',mimeType:'image/png',buffer:png};
async function openDirect(page:Page,controls=true){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await page.goto('/#messages');const panel=page.getByRole('tabpanel',{name:/^私人訊息/});
  await panel.getByLabel('搜尋會員').fill('示範需求者');await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();
  await panel.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();
  const thread=panel.locator('.messages-thread');await expect(thread.getByRole('textbox')).toBeVisible();
  if(controls)await expect(thread.getByRole('button',{name:'附加圖片',exact:true})).toBeVisible();return thread;
}

async function assertOneStoredImage(db:Pool,caption:string,payload:string){
  const rows=(await db.query(`SELECT m.message_id,m.sender_ref,m.recipient_ref,t.image_id FROM member_direct_messages m
    JOIN member_message_image_asset_targets t ON t.message_id=m.message_id WHERE m.body=$1`,[caption])).rows;
  expect(rows).toHaveLength(1);expect(rows[0].image_id).toBe(JSON.parse(payload).image_id);
  const users=(await db.query("SELECT user_id,email FROM users WHERE email=ANY($1::text[])",[['maker@local.test','reviewer@local.test']])).rows;
  expect(rows[0].sender_ref).toBe(users.find(row=>row.email==='maker@local.test')?.user_id);
  expect(rows[0].recipient_ref).toBe(users.find(row=>row.email==='reviewer@local.test')?.user_id);
}

// The ordinary pass runs with the feature uninstalled and proves it is invisible; the image flows run only in the dedicated fixture pass.
if (process.env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE !== '1') {
  test('with the feature uninstalled the composer has no image controls and the routes do not exist',async({page})=>{
    const thread=await openDirect(page,false);
    await expect(thread.getByRole('button',{name:'附加圖片',exact:true})).toHaveCount(0);await expect(thread.locator('input[type=file]')).toHaveCount(0);
    expect(await page.evaluate(async()=>(await (await fetch('/api/v1/site')).json()).message_images_enabled)).toBe(false);
    const status=await page.evaluate(async()=>(await fetch('/api/v1/me/conversations/20000000-0000-4000-8000-000000000002/messages/20000000-0000-4000-8000-0000000000aa/image')).status);expect(status).toBe(404);
  });
}
if (process.env.FREEDOM_E2E_MESSAGE_IMAGE_FIXTURE === '1') {
  test('image upload and message retries reuse keys without another upload after its acknowledgement',async({page},testInfo)=>{
    const thread=await openDirect(page),uploads:string[]=[],sends:string[]=[],caption=`圖片說明 ${crypto.randomUUID()}`;
    await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/images$/,async route=>{
      uploads.push(route.request().headers()['idempotency-key']);const response=await route.fetch();expect(response.status()).toBe(201);
      if(uploads.length===1)return route.abort();await route.fulfill({response});
    });
    await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages$/,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      sends.push(route.request().headers()['idempotency-key']);expect(route.request().postDataJSON().image_id).toBeTruthy();
      const response=await route.fetch();expect(response.status()).toBe(201);if(sends.length===1)return route.abort();await route.fulfill({response});
    });
    await thread.locator('input[type=file]').setInputFiles(image);await thread.getByRole('textbox').fill(caption);
    await expect(thread.getByLabel('待送出的圖片')).toContainText('screenshot.png');await thread.getByRole('button',{name:'送出',exact:true}).click();
    await expect(thread.getByRole('alert')).toContainText('圖片上傳未完成');await expect(thread.getByRole('textbox')).toHaveValue(caption);
    await expect(thread.getByRole('textbox')).toHaveAttribute('readonly','');
    await expect(thread.getByRole('button',{name:'移除',exact:true})).toBeDisabled();
    await expect(thread.getByRole('button',{name:'附加圖片',exact:true})).toBeDisabled();
    for(const width of [1440,390]){await page.setViewportSize({width,height:900});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath(`dm-unknown-${width}.png`)});}
    await page.setViewportSize({width:1440,height:900});
    const panel=page.getByRole('tabpanel',{name:/^私人訊息/});
    await panel.getByLabel('搜尋會員').fill('示範合作方');await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();
    await panel.getByRole('button',{name:'傳訊給 示範合作方',exact:true}).click();
    await expect(thread.getByRole('textbox')).toHaveValue('');
    await panel.getByLabel('搜尋會員').fill('示範需求者');await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();
    await panel.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();
    await expect(thread.getByRole('textbox')).toHaveValue(caption);await expect(thread.getByLabel('待送出的圖片')).toContainText('screenshot.png');
    let notices=0;page.on('dialog',async dialog=>{notices++;await dialog.accept();});
    await page.evaluate(()=>{window.location.hash='home';});await expect(page).toHaveURL(/#messages$/);expect(notices).toBe(1);
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByLabel('待送出的圖片')).toHaveCount(0);
    await expect(thread.getByRole('textbox')).toHaveValue('');expect(uploads).toHaveLength(2);expect(uploads[1]).toBe(uploads[0]);expect(sends).toHaveLength(2);expect(sends[1]).toBe(sends[0]);
    const bubble=thread.locator('.messages-bubbles>li').filter({hasText:caption});await expect(bubble).toHaveCount(1);
    await expect(bubble.getByAltText('傳送的圖片')).toBeVisible();await expect.poll(()=>bubble.getByAltText('傳送的圖片').evaluate((node:HTMLImageElement)=>node.naturalWidth)).toBeGreaterThan(0);
  });

  test('dock unknown send blocks intentional logout and survives collapse until original retry confirms',async({page})=>{
    await openDirect(page);await page.getByRole('button',{name:'展開訊息控制台'}).click();
    const dock=page.locator('.game-console-expanded');await dock.getByRole('tab',{name:'私人聊天',exact:true}).click();
    await dock.getByLabel('搜尋會員').fill('示範需求者');await dock.getByRole('button',{name:'搜尋會員',exact:true}).click();
    await dock.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();
    const thread=dock.locator('.messages-thread'),caption=`Console original ${crypto.randomUUID()}`,keys:string[]=[],payloads:string[]=[];
    await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages$/,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      keys.push(route.request().headers()['idempotency-key']);payloads.push(route.request().postData()!);
      const response=await route.fetch();expect(response.status()).toBe(201);
      if(keys.length===1)return route.abort();await route.fulfill({response});
    });
    await thread.locator('input[type=file]').setInputFiles(image);await thread.getByRole('textbox').fill(caption);await thread.getByRole('button',{name:'送出',exact:true}).click();
    await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');
    await dock.getByRole('button',{name:'收合訊息控制台'}).click();
    let blocked=0;page.on('dialog',async dialog=>{blocked++;await dialog.accept();});
    let logouts=0;page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/v1/auth/logout'))logouts++;});
    await page.getByRole('button',{name:'設定',exact:true}).click();
    await page.getByRole('menu',{name:'個人檔案'}).getByRole('menuitem',{name:'登出',exact:true}).click();expect(blocked).toBe(1);expect(logouts).toBe(0);
    expect(await page.evaluate(async()=>(await fetch('/api/v1/session')).status)).toBe(200);
    await page.getByRole('button',{name:'展開訊息控制台'}).click();await expect(thread.getByRole('textbox')).toHaveValue(caption);
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByRole('textbox')).toHaveValue('');
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(payloads[1]).toBe(payloads[0]);
    await dock.getByRole('button',{name:'收合訊息控制台'}).click();await signOut(page);await expect(page.getByRole('button',{name:'登入',exact:true})).toBeVisible();
  });

  for(const malformed of ['empty','wrong-recipient'] as const)test(`committed image send with ${malformed} ACK keeps the exact retry tuple`,async({page,e2eAuthPool})=>{
    const thread=await openDirect(page),caption=`Malformed ACK ${crypto.randomUUID()}`,keys:string[]=[],payloads:string[]=[];let uploads=0;
    page.on('request',request=>{if(request.method()==='POST'&&/\/images$/.test(request.url()))uploads++;});
    await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages$/,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      keys.push(route.request().headers()['idempotency-key']);payloads.push(route.request().postData()!);
      const response=await route.fetch();expect(response.status()).toBe(201);
      if(keys.length===1){const canonical=await response.json();return route.fulfill({response,json:malformed==='empty'?{}:{...canonical,recipient_ref:canonical.sender_ref}});}
      await route.fulfill({response});
    });
    await thread.locator('input[type=file]').setInputFiles(image);await thread.getByRole('textbox').fill(caption);
    await thread.getByRole('button',{name:'送出',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('訊息回應未能核對');
    await expect(thread.getByRole('textbox')).toHaveValue(caption);await expect(thread.getByRole('textbox')).toHaveAttribute('readonly','');
    await expect(thread.getByLabel('待送出的圖片')).toContainText(image.name);await expect(thread.getByRole('button',{name:'移除',exact:true})).toBeDisabled();
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByLabel('待送出的圖片')).toHaveCount(0);
    expect(uploads).toBe(1);expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(payloads[1]).toBe(payloads[0]);
    await expect(thread.getByRole('textbox')).toHaveValue('');await expect(thread.locator('.messages-bubbles>li').filter({hasText:caption})).toHaveCount(1);
    await assertOneStoredImage(e2eAuthPool,caption,payloads[0]);
  });

  for(const mode of ['page-navigation','dock-logout'] as const)test(`${mode} and unload are guarded synchronously inside the initial send event`,async({page,e2eAuthPool})=>{
    let thread=await openDirect(page);
    if(mode==='dock-logout'){
      await page.getByRole('button',{name:'展開訊息控制台'}).click();const dock=page.locator('.game-console-expanded');
      await dock.getByRole('tab',{name:'私人聊天',exact:true}).click();await dock.getByLabel('搜尋會員').fill('示範需求者');
      await dock.getByRole('button',{name:'搜尋會員',exact:true}).click();await dock.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();thread=dock.locator('.messages-thread');
    }
    await thread.locator('input[type=file]').setInputFiles(image);const caption=`Synchronous guard ${crypto.randomUUID()}`;await thread.getByRole('textbox').fill(caption);
    if(mode==='dock-logout')await page.getByRole('button',{name:'設定',exact:true}).click();
    let notices=0,logouts=0;page.on('dialog',async dialog=>{notices++;await dialog.accept();});
    page.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/v1/auth/logout'))logouts++;});
    let sends=0;const keys:string[]=[],payloads:string[]=[];await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages$/,async route=>{
      if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']);payloads.push(route.request().postData()!);const response=await route.fetch();expect(response.status()).toBe(201);
      if(++sends===1)return route.abort();await route.fulfill({response});
    });
    // Run from the synchronous fetch call, before the first await in send can
    // yield or React can publish pending state/effects. A delayed route callback
    // would miss the exact same-event race this regression protects.
    await page.evaluate(mode=>{
      const original=window.fetch;let checked=false;
      const target=mode==='dock-logout'?Array.from(document.querySelectorAll<HTMLElement>('[role=menuitem]')).find(n=>n.textContent?.trim()==='登出'):Array.from(document.querySelectorAll<HTMLButtonElement>('nav[aria-label="主要工作區"] button')).find(n=>n.textContent?.trim()==='會員首頁');
      if(!target)throw Error('guard navigation control missing');
      window.fetch=(input,init)=>{
        if(!checked&&init?.method==='POST'&&/\/images$/.test(String(input))){
          checked=true;const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);
          document.documentElement.dataset.dmImmediateUnload=String(event.defaultPrevented);target.click();
        }
        return original(input,init);
      };
    },mode);
    await thread.locator('form.messages-compose').evaluate((form:HTMLFormElement)=>form.requestSubmit());
    await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');
    expect(await page.locator('html').getAttribute('data-dm-immediate-unload')).toBe('true');expect(notices).toBe(1);expect(logouts).toBe(0);
    await expect(page).toHaveURL(/#messages$/);await expect(thread.getByRole('textbox')).toHaveValue(caption);await expect(thread.getByLabel('待送出的圖片')).toBeVisible();
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByRole('textbox')).toHaveValue('');
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(payloads[1]).toBe(payloads[0]);await assertOneStoredImage(e2eAuthPool,caption,payloads[0]);
  });

  test('attachment validation, clipboard image and plain text paste remain distinct at phone width',async({page})=>{
    await page.setViewportSize({width:320,height:720});const thread=await openDirect(page);
    await thread.locator('input[type=file]').setInputFiles({name:'large.png',mimeType:'image/png',buffer:Buffer.alloc(2*1024*1024+1)});
    await expect(thread.getByRole('alert')).toContainText('圖片大小不可超過 2 MiB');await expect(thread.getByLabel('待送出的圖片')).toHaveCount(0);
    await thread.getByRole('textbox').evaluate(node=>{
      const data=new DataTransfer();data.items.add(new File(['gif'],'unsupported.gif',{type:'image/gif'}));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    });await expect(thread.getByRole('alert')).toContainText('圖片僅支援 JPEG、PNG 或 WebP');
    await thread.getByRole('textbox').evaluate((node,bytes)=>{
      const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],'clipboard.png',{type:'image/png'}));node.dispatchEvent(new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true}));
    },Array.from(png));await expect(thread.getByLabel('待送出的圖片')).toContainText('clipboard.png');
    const prevented=await thread.getByRole('textbox').evaluate(node=>{const data=new DataTransfer();data.setData('text/plain','文字');const event=new ClipboardEvent('paste',{clipboardData:data,bubbles:true,cancelable:true});node.dispatchEvent(event);return event.defaultPrevented;});expect(prevented).toBe(false);
    await thread.getByRole('button',{name:'移除',exact:true}).click();await expect(thread.getByLabel('待送出的圖片')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  });
}
