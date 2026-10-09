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
  test('native canvas preview keeps disguised HTML and SVG plus markup filenames inert',async({page})=>{
    const thread=await openDirect(page),draft=`Native preview draft ${crypto.randomUUID()}`,originalUrl=page.url();
    const posts:string[]=[],navigations:string[]=[];
    page.on('request',request=>{if(request.method()==='POST'&&/\/api\/v1\/me\/conversations\/[^/]+\/(images|messages)$/.test(new URL(request.url()).pathname))posts.push(request.url());});
    page.on('framenavigated',frame=>{if(frame===page.mainFrame()&&frame.url()!==originalUrl)navigations.push(frame.url());});
    await page.evaluate(()=>{(window as unknown as {messagePreviewExecuted:boolean}).messagePreviewExecuted=false;});
    await thread.evaluate(node=>{
      // Observe transient raw-file URL sinks as well as the final preview DOM.
      const state=window as unknown as {messagePreviewSinks:string[]};state.messagePreviewSinks=[];
      const inspect=(element:Element)=>{for(const name of ['src','href','data','srcdoc','style']){
        const value=element.getAttribute(name);if(value&&(/blob:|data:|<script/i.test(value)))state.messagePreviewSinks.push(`${name}:${value}`);
      }};
      new MutationObserver(records=>{for(const record of records){
        if(record.type==='attributes'){
          if(record.oldValue&&/blob:|data:|<script/i.test(record.oldValue))state.messagePreviewSinks.push(record.oldValue);
          inspect(record.target as Element);
        }
        for(const added of record.addedNodes)if(added instanceof Element){inspect(added);added.querySelectorAll('*').forEach(inspect);}
      }}).observe(node,{subtree:true,childList:true,attributes:true,attributeOldValue:true,attributeFilter:['src','href','data','srcdoc','style']});
    });
    await thread.getByRole('textbox').fill(draft);
    const script="globalThis.messagePreviewExecuted=true;location.hash='preview-script-executed'";
    for(const [kind,bytes] of [
      ['html',`<!doctype html><html><body><script>${script}</script></body></html>`],
      ['svg',`<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><script>${script}</script><rect width="8" height="8" fill="red"/></svg>`],
    ]){
      const name=`${kind}-<svg onload="globalThis.messagePreviewExecuted=true">.png`;
      await thread.locator('input[type=file]').setInputFiles({name,mimeType:'image/png',buffer:Buffer.from(bytes)});
      expect(await thread.locator('input[type=file]').evaluate((input:HTMLInputElement)=>input.files?.[0]?.type)).toBe('image/png');
      const preview=thread.getByLabel('待送出的圖片'),canvas=preview.getByRole('img',{name:'待送出的圖片預覽',exact:true});
      await expect(canvas).toHaveJSProperty('tagName','CANVAS');
      expect(await preview.locator('span:has(> small)').evaluate(node=>node.firstChild?.textContent)).toBe(name);
      // Native Chromium may reject the declared PNG or safely decode SVG pixels.
      // Wait for an actual decoder outcome, never replace createImageBitmap/canvas.
      await expect.poll(()=>preview.evaluate(node=>{
        if(node.querySelector('[role=status]'))return 'rejected';
        const canvas=node.querySelector('canvas')!,pixels=canvas.getContext('2d')!.getImageData(0,0,canvas.width,canvas.height).data;
        return pixels.some((value,index)=>index%4===3&&value>0)?'pixels':'pending';
      })).toMatch(/^(rejected|pixels)$/);
      if(await preview.getByRole('status').count())await expect(preview.getByRole('status')).toHaveText('圖片預覽無法載入，原圖仍保留。');
      await expect(preview.locator('script,svg,img,iframe,object,embed,a,[src],[href],[data],[srcdoc],[onload],[onerror]')).toHaveCount(0);
      await expect(thread.getByRole('textbox')).toHaveValue(draft);await expect(thread.getByRole('textbox')).toBeEditable();
      await expect(thread.getByRole('button',{name:'移除',exact:true})).toBeEnabled();await expect(thread.getByRole('button',{name:'附加圖片',exact:true})).toBeEnabled();
      await thread.getByRole('button',{name:'移除',exact:true}).click();await expect(preview).toHaveCount(0);
      await thread.locator('input[type=file]').setInputFiles(image);
      await expect.poll(()=>thread.getByLabel('待送出的圖片').locator('canvas').evaluate((node:HTMLCanvasElement)=>node.getContext('2d')!.getImageData(64,64,1,1).data[3])).toBe(255);
      await expect(thread.getByRole('textbox')).toHaveValue(draft);
      expect(await page.evaluate(()=>({executed:(window as unknown as {messagePreviewExecuted:boolean}).messagePreviewExecuted,sinks:(window as unknown as {messagePreviewSinks:string[]}).messagePreviewSinks}))).toEqual({executed:false,sinks:[]});
      await expect(page).toHaveURL(originalUrl);expect(navigations).toEqual([]);expect(posts).toEqual([]);
      await thread.getByRole('button',{name:'移除',exact:true}).click();
    }
  });

  test('failed local canvas preview preserves an unknown real upload and its original bytes',async({page,e2eAuthPool})=>{
    const thread=await openDirect(page),caption=`Canvas unknown ${crypto.randomUUID()}`;
    await page.evaluate(()=>{
      const control=window as unknown as {rejectPreview?:()=>void};
      window.createImageBitmap=()=>new Promise<ImageBitmap>((_resolve,reject)=>{control.rejectPreview=()=>reject(new Error('Controlled preview failure'));});
    });
    const uploads:{key:string;bytes:Buffer}[]=[];let imageId='',payload='';
    await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/images$/,async route=>{
      uploads.push({key:route.request().headers()['idempotency-key'],bytes:route.request().postDataBuffer()!});
      const response=await route.fetch();expect(response.status()).toBe(201);const canonical=await response.json();
      if(uploads.length===1){imageId=canonical.image_id;return route.abort();}
      expect(canonical.image_id).toBe(imageId);await route.fulfill({response});
    });
    page.on('request',request=>{if(request.method()==='POST'&&/\/messages$/.test(request.url()))payload=request.postData()!;});
    await thread.locator('input[type=file]').setInputFiles(image);
    await expect(thread.getByRole('img',{name:'待送出的圖片預覽',exact:true})).toHaveJSProperty('tagName','CANVAS');
    await expect.poll(()=>page.evaluate(()=>typeof (window as unknown as {rejectPreview?:()=>void}).rejectPreview)).toBe('function');
    expect(uploads).toHaveLength(0);
    await thread.getByRole('textbox').fill(caption);await thread.getByRole('button',{name:'送出',exact:true}).click();
    await expect(thread.getByRole('alert')).toContainText('圖片上傳未完成');
    await page.evaluate(()=>(window as unknown as {rejectPreview:()=>void}).rejectPreview());
    await expect(thread.getByLabel('待送出的圖片').getByRole('status')).toHaveText('圖片預覽無法載入，原圖仍保留。');
    await expect(thread.getByRole('textbox')).toHaveValue(caption);await expect(thread.getByRole('textbox')).toHaveAttribute('readonly','');
    await expect(thread.getByRole('button',{name:'移除',exact:true})).toBeDisabled();expect(uploads).toHaveLength(1);
    expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByLabel('待送出的圖片')).toHaveCount(0);
    expect(uploads).toHaveLength(2);expect(uploads[1].key).toBe(uploads[0].key);
    for(const upload of uploads)expect(upload.bytes.equals(png)).toBe(true);
    await expect(thread.getByRole('textbox')).toHaveValue('');await assertOneStoredImage(e2eAuthPool,caption,payload);
  });

  for(const mode of ['page','dock'] as const){
    async function openComposer(page:Page){
      const thread=await openDirect(page);
      if(mode==='page')return thread;
      await page.getByRole('button',{name:'展開訊息控制台'}).click();const dock=page.locator('.game-console-expanded');
      await dock.getByRole('tab',{name:'私人聊天',exact:true}).click();await dock.getByLabel('搜尋會員').fill('示範需求者');
      await dock.getByRole('button',{name:'搜尋會員',exact:true}).click();await dock.getByRole('button',{name:'傳訊給 示範需求者',exact:true}).click();
      return dock.locator('.messages-thread');
    }
    test(`${mode} first real image decoder rejection keeps an editable image, caption and reply`,async({page,e2eAuthPool})=>{
      const thread=await openComposer(page),quote=`Decoder quote ${crypto.randomUUID()}`,caption=`Rejected image ${crypto.randomUUID()}`;
      await thread.getByRole('textbox').fill(quote);await thread.getByRole('button',{name:'送出',exact:true}).click();
      await expect(thread.getByRole('textbox')).toHaveValue('');
      await thread.locator('.messages-bubbles>li').filter({hasText:quote}).getByRole('button',{name:'回覆你的訊息',exact:true}).click();
      const counts=async()=>(await e2eAuthPool.query(`SELECT (SELECT count(*)::int FROM assets) assets,
        (SELECT count(*)::int FROM asset_objects) objects,(SELECT count(*)::int FROM asset_upload_intents) intents,
        (SELECT count(*)::int FROM member_message_image_asset_targets) targets,(SELECT count(*)::int FROM member_direct_messages) messages`)).rows[0];
      const before=await counts(),wide=await sharp({create:{width:4097,height:1,channels:3,background:{r:255,g:255,b:255}}}).png().toBuffer();
      expect(wide.byteLength).toBeLessThan(2*1024*1024);let rejects=0;
      await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/images$/,async route=>{
        const response=await route.fetch();expect(response.status()).toBe(422);expect((await response.json()).code).toBe('invalid_message_image');rejects++;await route.fulfill({response});
      });
      await thread.locator('input[type=file]').setInputFiles({name:'too-wide.png',mimeType:'image/png',buffer:wide});
      await thread.getByRole('textbox').fill(caption);await thread.getByRole('button',{name:'送出',exact:true}).click();
      await expect(thread.getByRole('alert')).toContainText('訊息未送出');expect(rejects).toBe(1);
      await expect(thread.getByRole('button',{name:'重試送出',exact:true})).toHaveCount(0);
      await expect(thread.getByRole('textbox')).toBeEditable();await expect(thread.getByRole('textbox')).toHaveValue(caption);
      await expect(thread.getByLabel('待送出的圖片')).toContainText('too-wide.png');await expect(thread.locator('.chat-reply-draft')).toContainText(quote);
      await expect(thread.getByRole('button',{name:'取消回覆',exact:true})).toBeEnabled();
      await expect(thread.getByRole('button',{name:'附加圖片',exact:true})).toBeEnabled();
      expect(await counts()).toEqual(before);
      await thread.getByRole('textbox').fill(`${caption} edited`);await thread.getByRole('button',{name:'取消回覆',exact:true}).click();
      await thread.getByRole('button',{name:'移除',exact:true}).click();await expect(thread.getByLabel('待送出的圖片')).toHaveCount(0);
      await thread.locator('input[type=file]').setInputFiles(image);await expect(thread.getByLabel('待送出的圖片')).toContainText(image.name);
      expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(false);
      let dialogs=0;page.on('dialog',async dialog=>{dialogs++;await dialog.accept();});
      if(mode==='dock'){await page.getByRole('button',{name:'收合訊息控制台'}).click();await signOut(page);await expect(page.getByRole('button',{name:'登入',exact:true})).toBeVisible();}
      else {await page.evaluate(()=>{location.hash='home';});await expect(page).toHaveURL(/#home$/);}
      expect(dialogs).toBe(0);expect(await counts()).toEqual(before);
    });

    test(`${mode} unknown upload followed by decoder 422 retains the original tuple through message-stage 422`,async({page,e2eAuthPool})=>{
      const thread=await openComposer(page),caption=`Unknown decoder ${crypto.randomUUID()}`,quote=`Unknown reply ${crypto.randomUUID()}`;
      await thread.getByRole('textbox').fill(quote);await thread.getByRole('button',{name:'送出',exact:true}).click();await expect(thread.getByRole('textbox')).toHaveValue('');
      await thread.locator('.messages-bubbles>li').filter({hasText:quote}).getByRole('button',{name:'回覆你的訊息',exact:true}).click();
      const uploads:{key:string;bytes:Buffer}[]=[],keys:string[]=[],payloads:string[]=[];let imageId='';
      const rejection={status:422,contentType:'application/problem+json',json:{type:'about:blank',title:'Unprocessable Entity',status:422,code:'invalid_message_image',detail:'Controlled later decoder rejection'}};
      await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/images$/,async route=>{
        uploads.push({key:route.request().headers()['idempotency-key'],bytes:route.request().postDataBuffer()!});
        if(uploads.length===2)return route.fulfill(rejection);
        const response=await route.fetch();expect(response.status()).toBe(201);const canonical=await response.json();
        if(uploads.length===1){imageId=canonical.image_id;return route.abort();}
        expect(canonical.image_id).toBe(imageId);await route.fulfill({response});
      });
      await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages$/,async route=>{
        if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']);payloads.push(route.request().postData()!);
        const response=await route.fetch();expect(response.status()).toBe(201);
        if(keys.length===1)return route.fulfill(rejection);await route.fulfill({response});
      });
      await thread.locator('input[type=file]').setInputFiles(image);await thread.getByRole('textbox').fill(caption);await thread.getByRole('button',{name:'送出',exact:true}).click();
      await expect(thread.getByRole('alert')).toContainText('圖片上傳未完成');
      await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('Controlled later decoder rejection');
      await expect(thread.getByRole('textbox')).toHaveValue(caption);await expect(thread.getByRole('textbox')).toHaveAttribute('readonly','');
      await expect(thread.getByLabel('待送出的圖片')).toContainText(image.name);await expect(thread.locator('.chat-reply-draft')).toContainText(quote);
      for(const name of ['移除','附加圖片','取消回覆'])await expect(thread.getByRole('button',{name,exact:true})).toBeDisabled();
      expect(await page.evaluate(()=>{const event=new Event('beforeunload',{cancelable:true});window.dispatchEvent(event);return event.defaultPrevented;})).toBe(true);
      let blocked=0;page.on('dialog',async dialog=>{blocked++;await dialog.accept();});
      if(mode==='page'){await page.evaluate(()=>{location.hash='home';});await expect(page).toHaveURL(/#messages$/);}
      else {
        await page.getByRole('button',{name:'收合訊息控制台'}).click();await page.getByRole('button',{name:'設定',exact:true}).click();
        await page.getByRole('menu',{name:'個人檔案'}).getByRole('menuitem',{name:'登出',exact:true}).click();
        expect(await page.evaluate(async()=>(await fetch('/api/v1/session')).status)).toBe(200);await page.getByRole('button',{name:'展開訊息控制台'}).click();
      }
      expect(blocked).toBe(1);await expect(thread.getByRole('textbox')).toHaveValue(caption);
      await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');
      await expect(thread.getByRole('button',{name:'移除',exact:true})).toBeDisabled();
      await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByLabel('待送出的圖片')).toHaveCount(0);
      expect(uploads).toHaveLength(3);expect(new Set(uploads.map(row=>row.key)).size).toBe(1);for(const upload of uploads)expect(upload.bytes.equals(png)).toBe(true);
      expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);expect(payloads[1]).toBe(payloads[0]);expect(JSON.parse(payloads[0]).image_id).toBe(imageId);
      expect(JSON.parse(payloads[0]).reply_to_message_id).toBeTruthy();await assertOneStoredImage(e2eAuthPool,caption,payloads[0]);
      expect((await e2eAuthPool.query('SELECT count(*)::int AS n FROM member_message_image_asset_targets WHERE image_id=$1',[imageId])).rows[0].n).toBe(1);
      await expect(thread.getByRole('textbox')).toHaveValue('');await expect(thread.locator('.chat-reply-draft')).toHaveCount(0);
      if(mode==='page'){await page.evaluate(()=>{location.hash='home';});await expect(page).toHaveURL(/#home$/);}
      else {await page.getByRole('button',{name:'收合訊息控制台'}).click();await signOut(page);await expect(page.getByRole('button',{name:'登入',exact:true})).toBeVisible();}
      expect(blocked).toBe(1);
    });
  }

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

  for(const kind of ['text','sticker'] as const)test(`unknown ${kind} keeps its original tuple after a later definite rejection`,async({page,e2eAuthPool})=>{
    const thread=await openDirect(page),draft=`Original ${kind} ${crypto.randomUUID()}`,keys:string[]=[],payloads:string[]=[];let messageId='';
    const storedCount=async()=>(await e2eAuthPool.query("SELECT count(*)::int AS n FROM member_direct_messages WHERE sender_ref=(SELECT user_id FROM users WHERE email='maker@local.test') AND recipient_ref=(SELECT user_id FROM users WHERE email='reviewer@local.test')")).rows[0].n as number;
    const before=await storedCount();
    await thread.getByRole('textbox').fill(draft);
    if(kind==='sticker'){
      await thread.getByRole('button',{name:'選擇貼圖',exact:true}).click();await thread.getByRole('button',{name:'工坊夥伴',exact:true}).click();
      await thread.getByRole('button',{name:'選用貼圖：你好',exact:true}).click();
    }
    await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages$/,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      keys.push(route.request().headers()['idempotency-key']);payloads.push(route.request().postData()!);
      if(keys.length===2)return route.fulfill({status:400,contentType:'application/problem+json',json:{type:'about:blank',title:'Bad Request',status:400,detail:'Synthetic definite retry rejection'}});
      const response=await route.fetch();expect(response.status()).toBe(201);const canonical=await response.json();
      if(keys.length===1){messageId=canonical.message_id;return route.fulfill({response,json:{}});}
      expect(canonical.message_id).toBe(messageId);await route.fulfill({response});
    });
    await thread.getByRole('button',{name:'送出',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('訊息回應未能核對');
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('Synthetic definite retry rejection');
    await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');await expect(thread.getByRole('button',{name:'重試送出',exact:true})).toBeVisible();
    await expect(thread.getByRole('button',{name:'選擇貼圖',exact:true})).toBeDisabled();
    await expect(thread.locator('textarea')).toHaveValue(draft);
    if(kind==='text')await expect(thread.getByRole('textbox')).toHaveAttribute('readonly','');
    else {await expect(thread.getByLabel('待送出的貼圖')).toContainText('你好');await expect(thread.getByRole('button',{name:'改寫文字',exact:true})).toBeDisabled();}
    await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(thread.getByRole('button',{name:'重試送出',exact:true})).toHaveCount(0);
    expect(keys).toHaveLength(3);expect(new Set(keys).size).toBe(1);expect(new Set(payloads).size).toBe(1);
    expect(JSON.parse(payloads[0])).toEqual(kind==='text'?{body:draft}:{sticker_id:'workshop-v1-hello'});
    const rows=(await e2eAuthPool.query('SELECT message_id,body,sticker_id FROM member_direct_messages WHERE message_id=$1',[messageId])).rows;
    expect(rows).toEqual([{message_id:messageId,body:kind==='text'?draft:'[貼圖] 你好',sticker_id:kind==='text'?null:'workshop-v1-hello'}]);
    const receipts=(await e2eAuthPool.query('SELECT count(*)::int AS n FROM command_receipts WHERE idempotency_key=$1',[keys[0]])).rows;
    expect(receipts[0].n).toBe(1);expect(await storedCount()).toBe(before+1);
    if(kind==='sticker'){await expect(thread.getByLabel('待送出的貼圖')).toHaveCount(0);await expect(thread.getByRole('textbox')).toHaveValue(draft);}
    else await expect(thread.getByRole('textbox')).toHaveValue('');
  });

  test('a first definitely rejected text send stays editable and a changed intent gets a new key',async({page,e2eAuthPool})=>{
    const thread=await openDirect(page),draft=`First rejection ${crypto.randomUUID()}`,changed=`${draft} changed`,keys:string[]=[],payloads:string[]=[];
    await page.route(/\/api\/v1\/me\/conversations\/[^/]+\/messages$/,async route=>{
      if(route.request().method()!=='POST')return route.continue();keys.push(route.request().headers()['idempotency-key']);payloads.push(route.request().postData()!);
      if(keys.length===1)return route.fulfill({status:400,contentType:'application/problem+json',json:{type:'about:blank',title:'Bad Request',status:400,detail:'Synthetic first rejection'}});
      const response=await route.fetch();expect(response.status()).toBe(201);await route.fulfill({response});
    });
    await thread.getByRole('textbox').fill(draft);await thread.getByRole('button',{name:'送出',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('Synthetic first rejection');
    await expect(thread.getByRole('textbox')).toBeEditable();await expect(thread.getByRole('button',{name:'重試送出',exact:true})).toHaveCount(0);
    await thread.getByRole('textbox').fill(changed);await thread.getByRole('button',{name:'送出',exact:true}).click();await expect(thread.getByRole('textbox')).toHaveValue('');
    expect(keys).toHaveLength(2);expect(keys[1]).not.toBe(keys[0]);expect(payloads.map(value=>JSON.parse(value).body)).toEqual([draft,changed]);
    expect((await e2eAuthPool.query('SELECT body FROM member_direct_messages WHERE body=ANY($1::text[])',[[draft,changed]])).rows).toEqual([{body:changed}]);
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
