import {readFileSync} from 'node:fs';
import {test,expect,type Page} from './fixtures.js';
import {createArExperience} from '../../packages/asset-storage/ar-target.js';

const pattern=readFileSync(new URL('../fixtures/community-ar/card.mind',import.meta.url));
const png=readFileSync(new URL('../fixtures/community-ar/card.png',import.meta.url));
const sdkPath=/AR_SDK_URL='([^']+)'/.exec(readFileSync(new URL('../../apps/portal-web/src/modules/community-ar/sdk-location.ts',import.meta.url),'utf8'))![1];
async function login(page:Page){await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();await page.goto('/#ar');await expect(page.getByRole('heading',{name:'把圖案變成認識你的入口'})).toBeVisible();}
async function publish(page:Page,bytes:Uint8Array,title:string){
  return page.evaluate(async({bytes,title})=>{
    const session=await (await fetch('/api/v1/session')).json(),headers={'Content-Type':'application/json','X-CSRF-Token':session.csrf_token,'Idempotency-Key':crypto.randomUUID()};
    const existing=await (await fetch('/api/v1/ar/targets')).json();
    for(const target of existing.items.filter((t:{title:string;state:string})=>t.title.startsWith('Synthetic')&&t.state==='published'))await fetch(`/api/v1/ar/targets/${target.target_id}/withdraw`,{method:'POST',headers:{...headers,'Idempotency-Key':crypto.randomUUID(),'If-Match':`"${target.aggregate_version}"`},body:'{}'});
    const create=await fetch('/api/v1/ar/targets',{method:'POST',headers,body:JSON.stringify({kind:'custom',title})});if(create.status!==201)throw new Error('AR fixture create '+create.status);const target=await create.json();
    const upload=await fetch(`/api/v1/ar/targets/${target.target_id}/pattern`,{method:'PUT',headers:{...headers,'Content-Type':'application/octet-stream','If-Match':'"1"'},body:new Uint8Array(bytes)});if(upload.status!==200)throw new Error('AR fixture upload '+upload.status);const uploaded=await upload.json();
    const result=await fetch(`/api/v1/ar/targets/${target.target_id}/publish`,{method:'POST',headers:{...headers,'If-Match':`"${uploaded.aggregate_version}"`},body:'{}'});if(result.status!==200)throw new Error('AR fixture publish '+result.status);return (await result.json()).share_path as string;
  },{bytes:Array.from(bytes),title});
}
test('AR-UI-01 real compile and editor publication recover a lost response without duplicating a target',async({page,e2eAuthPool})=>{
  test.setTimeout(120000);await e2eAuthPool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='synthetic-e2e-ar-v1',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='member.ar-target'");await login(page);await page.getByRole('button',{name:'製作圖案',exact:true}).click();
  await page.getByLabel('選擇衣服或海報上的圖片').setInputFiles({name:'synthetic-card.png',mimeType:'image/png',buffer:png});
  await expect(page.getByRole('img',{name:'待辨識的完整圖案'})).toBeVisible();await page.getByRole('button',{name:'編譯圖案',exact:true}).click();
  await expect(page.getByRole('button',{name:'用相機試掃',exact:true})).toBeEnabled({timeout:60000});
  await page.getByLabel('自訂文字、特效、圖片或影片').check();await page.getByLabel('要顯示的文字').fill('這是一件會說話的衣服！');await page.getByRole('button',{name:'用相機試掃',exact:true}).click();
  await expect(page.getByRole('button',{name:'開啟相機',exact:true})).toBeEnabled();await page.screenshot({path:'.rd/ar/local-trial.png',fullPage:true});
  await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByLabel('圖案名稱',{exact:true}).fill('Synthetic compiled editor');
  await expect(page.getByLabel('要顯示的文字')).toHaveValue('這是一件會說話的衣服！');
  let dropped=false;await page.route('**/api/v1/ar/targets/*/publish',async route=>{if(!dropped){dropped=true;const result=await route.fetch();expect(result.status()).toBe(200);await route.abort('failed');}else await route.continue();});
  await page.getByRole('button',{name:'發布 AR 圖案',exact:true}).click();await expect(page.getByRole('button',{name:'重試原發布',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'重試原發布',exact:true}).click();await expect(page.getByLabel('給朋友的掃描連結',{exact:true})).toBeVisible();
  const target=await page.evaluate(async()=>{const own=await (await fetch('/api/v1/ar/targets')).json();return own.items.filter((item:{title:string})=>item.title==='Synthetic compiled editor');});
  expect(target).toHaveLength(1);expect(target[0].state).toBe('published');
  await page.getByRole('button',{name:'掃描圖案',exact:true}).click();await expect(page.getByText('Synthetic compiled editor',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'我的圖案',exact:true}).click();
  await page.getByRole('link',{name:'開啟試掃',exact:true}).click();await expect(page.getByRole('button',{name:'開啟相機',exact:true})).toBeEnabled();
});
test('AR-UI-02 real tracker acquires positive video and rejects negative video; no injected detection events',async({page})=>{
  test.setTimeout(120000);await login(page);
  for(const name of ['positive','negative'])await page.route(`**/_ar-test/${name}.webm`,route=>route.fulfill({contentType:'video/webm',body:readFileSync(new URL(`../fixtures/community-ar/${name}.webm`,import.meta.url))}));
  const result=await page.evaluate(async({sdkPath,packet})=>{
    const {Controller}=await import(sdkPath);const output:Record<string,{found:number;frames:number}>=Object.create(null);
    for(const name of ['positive','negative']){
      const video=document.createElement('video');video.muted=true;video.playsInline=true;video.loop=true;video.src=`/_ar-test/${name}.webm`;await video.play();video.width=video.videoWidth;video.height=video.videoHeight;
      let found=0,frames=0;const controller=new Controller({inputWidth:video.width,inputHeight:video.height,maxTrack:1,warmupTolerance:3,missTolerance:8,onUpdate:(event:{type:string;worldMatrix:unknown})=>{if(event.type==='updateMatrix'&&event.worldMatrix)found++;if(event.type==='processDone')frames++;}});
      controller.addImageTargetsFromBuffer(new Uint8Array(packet).buffer);await controller.dummyRun(video);const running=controller.processVideo(video);
      await new Promise<void>((resolve,reject)=>{const deadline=performance.now()+30000;const timer=setInterval(()=>{if(frames>=60){clearInterval(timer);resolve();}else if(performance.now()>deadline){clearInterval(timer);reject(new Error('real inference produced too few frames'));}},50);});
      controller.stopProcessVideo();controller.dispose();controller.worker.terminate();await Promise.race([running,new Promise(resolve=>setTimeout(resolve,200))]);video.pause();video.src='';output[name]={found,frames};
    }return output;
  },{sdkPath,packet:Array.from(pattern)});
  expect(result.positive.frames).toBeGreaterThanOrEqual(60);expect(result.positive.found).toBeGreaterThan(0);expect(result.negative.frames).toBeGreaterThanOrEqual(60);expect(result.negative.found).toBe(0);
  await page.evaluate(result=>{document.documentElement.dataset.arInference=JSON.stringify(result);},result);
});
test('AR-UI-03 publish own custom content, reopen publicly, recover denied camera and stop a late stream',async({page,e2eAuthPool})=>{
  test.setTimeout(90000);await e2eAuthPool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='synthetic-e2e-ar-v1',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='member.ar-target'");
  await login(page);const path=await publish(page,createArExperience(pattern,{version:1,kind:'text',text:'Synthetic public AR text'}),'Synthetic public AR');
  await page.goto(path);await expect(page.getByRole('button',{name:'開啟相機',exact:true})).toBeEnabled();
  await page.evaluate(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{throw new DOMException('Denied','NotAllowedError');}});});
  await page.getByRole('button',{name:'開啟相機',exact:true}).click();await expect(page.getByRole('alert')).toContainText('相機權限');await expect(page.getByRole('button',{name:'重新開啟',exact:true})).toBeEnabled();
  await page.evaluate(()=>{const state=window as unknown as {resolveAr?: (stream:MediaStream)=>void;stoppedAr?:boolean};Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:()=>new Promise<MediaStream>(resolve=>state.resolveAr=resolve)});});
  await page.getByRole('button',{name:'重新開啟',exact:true}).click();await page.getByRole('button',{name:'取消',exact:true}).click();
  await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=640;canvas.height=480;const stream=canvas.captureStream(24);(window as any).resolveAr(stream);(window as any).lateArStream=stream;});
  await expect.poll(()=>page.evaluate(()=>(window as any).lateArStream.getTracks().every((track:MediaStreamTrack)=>track.readyState==='ended'))).toBe(true);
  await expect(page.getByText('相機已暫停',{exact:true})).toBeVisible();
});
test('AR-UI-04 narrow/mobile/desktop editor keeps controls reachable with all existing themes',async({page})=>{
  await login(page);await page.getByRole('button',{name:'製作圖案',exact:true}).click();await page.getByLabel('自訂文字、特效、圖片或影片').check();
  for(const theme of ['light','dark','versefolk','guide-dragon','guide-ai-sister'])for(const width of [320,390,1280]){
    await page.evaluate(theme=>{localStorage.setItem('freedom-theme',theme);window.dispatchEvent(new StorageEvent('storage',{key:'freedom-theme',newValue:theme}));},theme);
    await page.setViewportSize({width,height:900});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
    const modes=page.locator('.ar-modes button');for(const button of await modes.all())expect((await button.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.getByRole('button',{name:'特效',exact:true}).click();await page.getByLabel('選擇特效').selectOption('confetti');await expect(page.getByLabel('選擇特效')).toHaveValue('confetti');
    await page.screenshot({path:`.rd/ar/editor-${theme}-${width}.png`,fullPage:true});
  }
  await page.getByRole('button',{name:'圖片',exact:true}).click();await page.getByLabel('綁定圖片',{exact:true}).setInputFiles('tests/fixtures/community-ar/card.png');
  await page.locator('.ar-media-preview img').waitFor();
  expect(await page.locator('.ar-media-preview img').evaluate(async element=>{const image=element as HTMLImageElement;await image.decode();return image.naturalWidth;})).toBeGreaterThan(0);
  await page.getByRole('button',{name:'影片',exact:true}).click();await page.getByLabel('綁定影片',{exact:true}).setInputFiles('tests/fixtures/community-ar/positive.webm');
  await page.locator('.ar-media-preview video').waitFor();
  await page.locator('.ar-media-preview video').evaluate(async element=>{const video=element as HTMLVideoElement;video.muted=true;(window as any).arPreviewVideo=video;await video.play();});
  await expect.poll(()=>page.evaluate(()=>(window as any).arPreviewVideo.currentTime)).toBeGreaterThan(0);
  await page.getByRole('button',{name:'文字',exact:true}).click();expect(await page.evaluate(()=>(window as any).arPreviewVideo.paused)).toBe(true);
});
test('AR-UI-05 actual replay camera renders a tracked overlay, captures a photo and lights selected platform logos',async({page,e2eAuthPool})=>{
  test.setTimeout(90000);await e2eAuthPool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='synthetic-e2e-ar-v1',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='member.ar-target'");await login(page);
  const path=await publish(page,createArExperience(pattern,{version:1,kind:'effect',text:'Synthetic camera overlay',effect:'sparkle'}),'Synthetic AR camera');
  await page.route('**/_ar-test/positive.webm',route=>route.fulfill({contentType:'video/webm',body:readFileSync(new URL('../fixtures/community-ar/positive.webm',import.meta.url))}));
  await page.addInitScript(()=>{Object.defineProperty(navigator.mediaDevices,'getUserMedia',{configurable:true,value:async()=>{const replay=document.createElement('video');replay.src='/_ar-test/positive.webm';replay.loop=true;replay.muted=true;replay.playsInline=true;await replay.play();await new Promise<void>(resolve=>replay.requestVideoFrameCallback(()=>resolve()));(window as any).arReplay=replay;const stream=(replay as HTMLVideoElement&{captureStream:()=>MediaStream}).captureStream();(window as any).arTestStream=stream;return stream;}});});
  await page.goto(path);await expect(page.getByRole('button',{name:'開啟相機',exact:true})).toBeEnabled();await page.getByRole('button',{name:'開啟相機',exact:true}).click();
  await expect(page.getByRole('link',{name:'查看內容',exact:true})).toBeVisible({timeout:30000});
  expect(await page.locator('.ar-stage canvas').evaluate(node=>{const c=(node as HTMLCanvasElement).getContext('2d')!;return c.getImageData(0,0,c.canvas.width,c.canvas.height).data.some((v,i)=>i%4===3&&v>0);})).toBe(true);
  await page.getByRole('button',{name:'拍照',exact:true}).click();await expect(page.getByRole('img',{name:'剛拍攝的相機與 AR 合成照片'})).toBeVisible();
  await page.getByRole('button',{name:'X',exact:true}).click();await expect(page.getByRole('button',{name:'X',exact:true})).toHaveAttribute('aria-pressed','true');await page.getByRole('button',{name:'Facebook',exact:true}).click();await expect(page.getByRole('button',{name:'Facebook',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'暫停相機',exact:true}).click();await expect.poll(()=>page.evaluate(()=>(window as any).arTestStream.getTracks().every((track:MediaStreamTrack)=>track.readyState==='ended'))).toBe(true);
  await page.screenshot({path:'.rd/ar/capture-platforms.png',fullPage:true});
});

test('AR-UI-06 selecting an image preserves delayed initial targets, events and scene loads',async({page,e2eAuthPool})=>{
  test.setTimeout(120000);
  await e2eAuthPool.query("UPDATE domain_media_storage_policy SET mode='r2_only',policy_revision='synthetic-e2e-ar-v1',persistence_allowed=true,retained_byte_limit=104857600 WHERE purpose='member.ar-target'");
  await login(page);
  await publish(page,createArExperience(pattern,{version:1,kind:'text',text:'Synthetic delayed load'}),'Synthetic delayed-load target');
  await page.goto('/#skills');
  let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve),arrivals=new Set<string>();
  const responses:Promise<void>[]=[];
  for(const path of ['/ar/targets','/events','/ar/scene'])await page.route(`**/api/v1${path}`,async route=>{
    if(route.request().method()!=='GET')return route.continue();
    const response=await route.fetch();expect(response.status()).toBe(200);arrivals.add(path);
    const sent=held.then(()=>route.fulfill({response}));responses.push(sent);await sent;
  });
  try{
    await page.goto('/#ar');await expect.poll(()=>arrivals.size).toBe(3);
    await page.getByRole('button',{name:'製作圖案',exact:true}).click();
    await page.getByLabel('選擇衣服或海報上的圖片').setInputFiles({name:'synthetic-card.png',mimeType:'image/png',buffer:png});
    await expect(page.getByRole('img',{name:'待辨識的完整圖案'})).toBeVisible();
    release();await Promise.all(responses);
    await page.getByRole('button',{name:'掃描圖案',exact:true}).click();
    for(const width of [390,768,1440]){
      await page.setViewportSize({width,height:900});await page.screenshot({path:`.rd/ar-review/initial-load-${width}.png`,fullPage:true});
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    }
    await expect(page.getByText('正在找圖案…',{exact:true})).toHaveCount(0);
    await expect(page.getByText('Synthetic delayed-load target',{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'製作圖案',exact:true}).click();
    await expect(page.getByText('圖案儲存尚未啟用，可以先下載和試掃。',{exact:true})).toHaveCount(0);
    await page.getByRole('button',{name:'編譯圖案',exact:true}).click();
    await expect(page.getByRole('button',{name:'發布 AR 圖案',exact:true})).toBeEnabled({timeout:60000});
  }finally{release();await Promise.allSettled(responses);}
});

test('AR-UI-07 cancelling compilation leaves the selected image usable without a late abort error',async({page})=>{
  await login(page);await page.getByRole('button',{name:'製作圖案',exact:true}).click();
  await page.getByLabel('選擇衣服或海報上的圖片').setInputFiles({name:'synthetic-card.png',mimeType:'image/png',buffer:png});
  await expect(page.getByRole('img',{name:'待辨識的完整圖案'})).toBeVisible();
  await page.getByRole('button',{name:'編譯圖案',exact:true}).click();
  await page.getByRole('button',{name:'取消處理',exact:true}).click();
  await expect(page.getByText('已取消處理，圖片仍保留。',{exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'編譯圖案',exact:true})).toBeEnabled();
  await expect(page.locator('iframe[title="AR 圖案處理"]')).toHaveCount(0);
  await page.getByLabel('更換圖案',{exact:true}).setInputFiles({name:'replacement-card.png',mimeType:'image/png',buffer:png});
  await expect(page.getByText('圖片已留在裝置上，按「編譯圖案」繼續。',{exact:true})).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
