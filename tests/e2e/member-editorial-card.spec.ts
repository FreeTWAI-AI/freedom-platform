import {randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import sharp from 'sharp';
import jsQR from 'jsqr';
import {test,expect,type Page,type Locator} from './fixtures.js';
import {navigate} from './navigation.js';
import {quickJoin} from './quick-join.js';
const SHOTS=process.env.AUDIT_EVIDENCE_DIR??'test-results/member-editorial-card';
mkdirSync(SHOTS,{recursive:true});
async function decode(bytes:Buffer){const {data,info}=await sharp(bytes).ensureAlpha().raw().toBuffer({resolveWithObject:true});return jsQR(new Uint8ClampedArray(data),info.width,info.height)?.data;}
async function shareUrl(settings:Locator){const link=settings.getByRole('link',{name:'開啟名片',exact:true});await expect(link).toHaveAttribute('href',/\/member-cards\//);return (await link.getAttribute('href'))!;}
async function signup(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill('Hao');await page.getByLabel('電子郵件',{exact:true}).fill(`editorial-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-editorial-password');await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await quickJoin(page);await navigate(page,'我的名片');
}

test('real profile fills the template, opt-in QR and downloaded image follow rotation and revocation',async({page,browser,e2eAuthPool})=>{
  test.setTimeout(150000);await signup(page);
  const account=await (await page.request.get('/api/v1/me/account')).json();
  await e2eAuthPool.query(`INSERT INTO onboarding_assessments(assessment_id,community_id,user_id,assessment_version,assessment_sha256,state,published_profile,occupation,answers)
    SELECT $1,community_id,user_id,'fixture',$2,'completed',$3,'不公開職業','{"private":"私人答案"}' FROM users WHERE user_id=$4`,[randomUUID(),'0'.repeat(64),JSON.stringify({capabilities:[],custom_capabilities:['產品設計','使用者體驗','開源共創'],featured_capabilities:['custom:產品設計','custom:使用者體驗','custom:開源共創'],equipment:['私人設備']}),account.user_id]);
  // A generated geometric avatar is test data, not a portrait of a real member.
  const avatar=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#f6f8fb"/><circle cx="128" cy="96" r="48" fill="#3044ff"/><path d="M40 256v-35a88 88 0 0 1 176 0v35" fill="#08090b"/></svg>')).png().toBuffer();
  await page.getByLabel('選擇頭像',{exact:true}).setInputFiles({name:'synthetic-avatar.png',mimeType:'image/png',buffer:avatar});
  await page.getByRole('button',{name:'保存頭像',exact:true}).click();
  const settings=page.getByRole('region',{name:'分享我的工坊名片'}),preview=settings.getByRole('complementary',{name:'名片預覽'});
  await expect(settings.getByRole('button',{name:'工坊誌',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(preview.locator('.ecard-name')).toHaveText('Hao');await expect(preview.locator('.ecard-capabilities')).toContainText('使用者體驗');
  await expect(preview.getByRole('img',{name:'這張名片的專屬 QR Code'})).toHaveCount(0);await expect(preview.getByRole('img',{name:'Hao的頭像'})).toHaveCount(0);
  await settings.getByRole('checkbox',{name:'在分享頁顯示我的頭像'}).check();await expect(preview.getByRole('img',{name:'Hao的頭像'})).toBeVisible();
  await settings.getByLabel('一句話介紹').fill('讓創意，成為一起完成的作品。');
  await settings.getByLabel('連結名稱',{exact:true}).fill('探索我的作品');await settings.getByLabel('連結網址',{exact:true}).fill('https://example.com/portfolio');await settings.getByRole('button',{name:'加入連結',exact:true}).click();
  await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();
  const first=await shareUrl(settings);await expect(preview.getByRole('img',{name:'這張名片的專屬 QR Code'})).toBeVisible();
  expect(await decode(await preview.locator('.ecard-qr svg').screenshot())).toBe(first);
  const guestContext=await browser.newContext(),guest=await guestContext.newPage();
  try{
    await guest.goto(first);await expect(guest.locator('.ecard')).toHaveAttribute('data-design','editorial');await expect(guest.getByRole('img',{name:'Hao的頭像'})).toBeVisible();
    const publicData=await (await guest.request.get('/api/v1/public'+new URL(first).pathname)).json();
    for(const privateValue of [account.user_id,account.login_email,'不公開職業','私人答案','私人設備'])expect(JSON.stringify(publicData)).not.toContain(privateValue);
    await guest.setViewportSize({width:1280,height:980});await expect(guest.locator('.ecard-editorial .member-avatar')).toHaveCSS('width','120px');await expect(guest.locator('.ecard-editorial .member-avatar')).toHaveCSS('height','144px');await guest.screenshot({path:`${SHOTS}/public-desktop.png`,fullPage:true});await guest.locator('.ecard').screenshot({path:`${SHOTS}/template.png`});
    for(const width of [390,320]){await guest.setViewportSize({width,height:920});const portrait=await guest.locator('.ecard-editorial .member-avatar').evaluate(element=>({width:parseFloat(getComputedStyle(element).width),height:parseFloat(getComputedStyle(element).height)}));expect(portrait.width).toBeCloseTo(76.8,1);expect(portrait.height).toBeCloseTo(97.6,1);expect(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await decode(await guest.locator('.ecard-qr svg').screenshot())).toBe(first);await guest.screenshot({path:`${SHOTS}/public-${width}.png`,fullPage:true});}
    const downloading=guest.waitForEvent('download');await guest.getByRole('button',{name:'下載名片 PNG',exact:true}).click();const downloaded=await downloading;
    expect(downloaded.suggestedFilename()).toBe('freedom-workshop-card.png');const image=readFileSync((await downloaded.path())!);expect(await decode(image)).toBe(first);
    await downloaded.saveAs(`${SHOTS}/downloaded-card.png`);
    const firstOwnerDownload=page.waitForEvent('download');await preview.getByRole('button',{name:'下載名片 PNG',exact:true}).click();const ownerImageBefore=readFileSync((await (await firstOwnerDownload).path())!);
    const beforeAvatar=await preview.locator('.member-avatar img').getAttribute('src');
    await page.getByLabel('選擇頭像',{exact:true}).setInputFiles({name:'updated-avatar.png',mimeType:'image/png',buffer:await sharp({create:{width:256,height:256,channels:3,background:'#3044ff'}}).png().toBuffer()});
    await page.getByRole('button',{name:'保存頭像',exact:true}).click();await expect(preview.locator('.member-avatar img')).not.toHaveAttribute('src',beforeAvatar!);
    const afterAvatar=await preview.locator('.member-avatar img').getAttribute('src');expect(Number(new URL(afterAvatar!,page.url()).searchParams.get('v'))).toBeGreaterThan(Number(new URL(beforeAvatar!,page.url()).searchParams.get('v')));
    const secondOwnerDownload=page.waitForEvent('download');await preview.getByRole('button',{name:'下載名片 PNG',exact:true}).click();const ownerImageAfter=readFileSync((await (await secondOwnerDownload).path())!);
    expect(ownerImageAfter.equals(ownerImageBefore)).toBe(false);expect(await decode(ownerImageAfter)).toBe(first);
    await settings.getByLabel('一句話介紹').fill('尚未保存的介紹');await expect(preview.getByRole('button',{name:'下載名片 PNG',exact:true})).toBeDisabled();
    await expect(settings.locator('.ecard-save-status')).toContainText('已自動儲存，分享頁就是這個樣子。');await expect(preview.getByRole('button',{name:'下載名片 PNG',exact:true})).toBeEnabled();
    const oldImage=await guest.getByRole('img',{name:'Hao的頭像'}).getAttribute('src');
    await settings.getByRole('button',{name:'更新連結',exact:true}).click();await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).not.toHaveAttribute('href',first);const second=await shareUrl(settings);
    expect(await decode(await preview.locator('.ecard-qr svg').screenshot())).toBe(second);expect((await guest.request.get(oldImage!)).status()).toBe(404);
    await guest.reload();await expect(guest.getByRole('heading',{name:'暫時無法開啟這張名片'})).toBeVisible();await expect(guest.locator('.ecard-qr')).toHaveCount(0);
    await guest.goto(second);await settings.getByRole('button',{name:'停用分享',exact:true}).click();await expect(preview.locator('.ecard-qr')).toHaveCount(0);await expect(preview.getByRole('button',{name:'下載名片 PNG',exact:true})).toHaveCount(0);
    await guest.reload();await expect(guest.getByRole('heading',{name:'暫時無法開啟這張名片'})).toBeVisible();
  }finally{await guestContext.close();}
});

test('long names, absent avatar and empty optional fields fit mobile; profile edits update the preview',async({page,browser})=>{
  test.setTimeout(120000);await signup(page);
  const settings=page.getByRole('region',{name:'分享我的工坊名片'}),preview=settings.getByRole('complementary',{name:'名片預覽'}),longName='W'.repeat(60);
  await page.locator('.account-settings').getByLabel('社群顯示名稱',{exact:true}).fill(longName);await page.getByRole('button',{name:'保存個人資料與公開範圍',exact:true}).click();
  await expect(preview.locator('.ecard-name')).toHaveText(longName);await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();const url=await shareUrl(settings);
  const privateCard=page.locator('.member-profile-card');
  for(const theme of ['light','dark','versefolk']){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.dispatchEvent(new Event('freedom-theme-changed'));},theme);
    await expect(privateCard.locator('.ecard-name')).toHaveCSS('color','rgb(8, 9, 11)');
    expect(await privateCard.locator('.ecard-name').evaluate(element=>{const box=element.getBoundingClientRect(),card=element.closest('.ecard')!.getBoundingClientRect();return box.right<=card.right&&box.left>=card.left;})).toBe(true);
  }
  const context=await browser.newContext(),guest=await context.newPage();try{
    for(const width of [1280,820,390,320]){
      await guest.setViewportSize({width,height:900});await guest.goto(url);await expect(guest.locator('.ecard-name')).toHaveText(longName);await expect(guest.locator('.editorial-empty')).toHaveText('專長探索中');await expect(guest.locator('.ecard-headline')).toHaveCount(0);await expect(guest.locator('.ecard-links')).toHaveCount(0);await expect(guest.locator('.member-avatar img')).toHaveCount(0);
      expect(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);expect(await decode(await guest.locator('.ecard-qr svg').screenshot())).toBe(url);
    }
    for(const theme of ['light','dark','versefolk']){await guest.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await expect(guest.locator('.ecard-name')).toHaveCSS('color','rgb(8, 9, 11)');await expect(guest.locator('.editorial-portrait')).toHaveCSS('background-color','rgb(196, 255, 32)');}
    await guest.locator('.ecard-qr').focus();await expect(guest.locator('.ecard-qr')).toBeFocused();await expect(guest.locator('.ecard-qr')).toHaveCSS('outline-style','solid');
    await guest.screenshot({path:`${SHOTS}/long-name-320.png`,fullPage:true});
  }finally{await context.close();}
});

test('export failure has a usable fallback and a retry stays available',async({page,browser})=>{
  await signup(page);const settings=page.getByRole('region',{name:'分享我的工坊名片'});await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();
  const context=await browser.newContext(),guest=await context.newPage();try{
    await guest.goto(await shareUrl(settings));await expect(guest.locator('.ecard-qr')).toBeVisible();
    // Simulate the browser refusing canvas export rather than altering production code.
    await guest.evaluate(()=>{HTMLCanvasElement.prototype.toBlob=function(){throw new DOMException('Canvas blocked','SecurityError');};});
    await guest.getByRole('button',{name:'下載名片 PNG',exact:true}).click();await expect(guest.getByRole('status')).toContainText('圖片暫時無法下載，請重試或直接分享名片連結。');
    await expect(guest.getByRole('button',{name:'下載名片 PNG',exact:true})).toBeEnabled();await expect(guest.locator('.ecard-qr')).toHaveAttribute('href',await shareUrl(settings));
  }finally{await context.close();}
});
