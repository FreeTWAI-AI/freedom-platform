import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {quickJoin} from './quick-join.js';
import {DEMO_COMMUNITY} from '../../packages/testing/seed.js';
mkdirSync('test-results',{recursive:true});
const themes=[['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']] as const;
const widths=[390,820,1280] as const;

async function account(page:Page,name:string){
  const email=`connections51-${randomUUID()}@example.test`;
  await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill(name);
  await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-connections-password');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('heading',{name:`${name}，歡迎來到自由工坊。`})).toBeVisible();
  return email;
}
async function joinGuild(page:Page){
  await quickJoin(page);
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
}
async function hintContrast(page:Page){
  return page.locator('.home-assessment-hint').evaluate(element=>{
    const style=getComputedStyle(element);
    const channel=(value:number)=>value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4;
    const parts=(color:string)=>color.match(/[\d.]+/g)!.map(Number);
    const lum=(color:string)=>{const [r,g,b]=parts(color).slice(0,3).map(part=>channel(part/255));return 0.2126*r+0.7152*g+0.0722*b;};
    const background=style.backgroundColor,backgroundParts=parts(background);
    const foreground=lum(style.color),surface=lum(background);
    const guild=document.querySelector('.home-member-guild');
    return {
      ratio:(Math.max(foreground,surface)+0.05)/(Math.min(foreground,surface)+0.05),
      alpha:backgroundParts.length>3?backgroundParts[3]:1,
      fontSize:parseFloat(style.fontSize),
      inIdentity:Boolean(element.closest('.home-member-identity')),
      inActions:Boolean(element.closest('.home-member-actions')),
      inNext:Boolean(element.closest('.home-next-step')),
      belowGuild:guild?element.getBoundingClientRect().top>guild.getBoundingClientRect().top:false,
    };
  });
}
async function shareControlWidths(page:Page,full:boolean){
  const settings=page.getByRole('region',{name:'分享我的工坊名片'});
  const metrics=await settings.evaluate(section=>{
    const style=getComputedStyle(section);
    const content=section.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight);
    return [...section.querySelectorAll<HTMLElement>(':scope > .btn, :scope .actions :is(.btn, a.btn)')].map(element=>({
      name:(element.textContent??'').trim(),width:element.getBoundingClientRect().width,content,
    }));
  });
  expect(metrics.length).toBeGreaterThan(0);
  for(const item of metrics){
    if(full)expect(item.width,item.name).toBeGreaterThan(item.content-2);
    else expect(item.width,`${item.name} ${item.width} of ${item.content}`).toBeLessThan(item.content-24);
  }
}
async function noOverflow(page:Page,label:string){
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),label).toBe(true);
}
async function shellTheme(page:Page,name:string,theme:string){
  const settings=page.getByRole('button',{name:'設定',exact:true});
  if(await settings.getAttribute('aria-expanded')!=='true')await settings.click();
  await page.getByRole('menuitemradio',{name,exact:true}).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
}
async function previewTheme(page:Page,name:string,label:string,theme:string){
  const menu=page.locator('.preview-profile-menu');
  if(!await menu.evaluate(element=>(element as HTMLDetailsElement).open))await menu.locator('summary').click();
  await menu.getByRole('radio',{name:label,exact:true}).check();
  await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await menu.locator('summary').click();
}
async function pressedDiffers(page:Page,group:string){
  const paint=(pressed:boolean)=>page.locator(`${group} .btn[aria-pressed="${pressed}"]`).first().evaluate(element=>{
    const style=getComputedStyle(element);
    return `${style.backgroundColor}|${style.borderTopColor}|${style.borderTopWidth}`;
  });
  expect(await paint(true),group).not.toBe(await paint(false));
}

test('guild applications show review progress, focus the result and stay readable',async({page,e2eAuthPool})=>{
  const name='申請進度夥伴',email=await account(page,name);
  await joinGuild(page);
  const userId=(await e2eAuthPool.query('SELECT user_id FROM users WHERE email=$1',[email])).rows[0].user_id as string;
  try{
    await navigate(page,'職業公會');
    await page.getByRole('button',{name:'申請創建公會',exact:true}).click();
    await expect(page.locator('#guild-application input[name="profession"]')).toHaveAttribute('maxlength','160');
    const requested='田野紀錄公會';
    await page.getByLabel('希望成立的公會名稱').fill(requested);
    await page.getByLabel('專業／職業領域').fill('田野調查');
    await page.getByLabel('為什麼想成立？希望一起做什麼？').fill('希望一起整理可以重用的田野觀察方法。');
    await page.getByRole('button',{name:'送出創建公會申請',exact:true}).click();
    const banner=page.getByRole('status').filter({hasText:'謝謝你的申請'});
    await expect(banner).toBeFocused();
    await expect(banner).toHaveText(`謝謝你的申請！「${requested}」已送出，正在審核中。審核結果會通知你，也可以在下方「我的公會申請」查看進度。`);
    await expect(page.locator('#guild-application')).toHaveCount(0);
    await expect(page.getByRole('button',{name:'申請創建公會',exact:true})).toHaveAttribute('aria-expanded','false');
    await page.getByRole('button',{name:'申請創建公會',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'謝謝你的申請'})).toHaveCount(0);
    await expect(page.locator('#guild-application')).toBeVisible();
    await page.getByRole('button',{name:'收起創建申請',exact:true}).click();
    const pending=page.locator('.guild-application-item',{hasText:requested});
    await expect(pending.locator('.guild-application-status')).toHaveText('待審核');
    await expect(pending).toContainText('管理員審核後會通知你。');
    await page.screenshot({path:'test-results/mc51-guild-pending-1280.png',fullPage:true});
    await e2eAuthPool.query(`INSERT INTO guild_creation_applications(application_id,community_id,user_id,name,profession,reason,state,reviewed_at,review_reason,approved_guild_key,created_at)
      VALUES($1,$2,$3,'已通過的田野公會','田野調查','希望把田野觀察整理成可以一起重用的方法。','approved',now(),'已整理成 AI 開發公會。','guild_ai_vibe',now()-make_interval(mins => 1)),
            ($4,$2,$3,'需要調整的公會','田野整理','原本的理由還不夠具體，想依審查說明再送一次。','declined',now(),'請把想一起做的第一步寫得更具體。',NULL,now()-make_interval(mins => 2)),
            ($5,$2,$3,'較早的申請甲','記錄','這是一件較早送出、仍在等待的申請。','pending',NULL,NULL,NULL,now()-make_interval(mins => 3)),
            ($6,$2,$3,'較早的申請乙','記錄','這是另一件較早送出、仍在等待的申請。','pending',NULL,NULL,NULL,now()-make_interval(mins => 4))`,
      [randomUUID(),DEMO_COMMUNITY,userId,randomUUID(),randomUUID(),randomUUID()]);
    await page.reload();
    const section=page.getByRole('region',{name:'我的公會申請'});
    await expect(section.getByRole('heading',{name:'我的公會申請',level:2})).toBeVisible();
    await expect(section.locator('.guild-application-item')).toHaveCount(3);
    await expect(section).toContainText('待審核');
    await expect(section).toContainText('已通過');
    await expect(section).toContainText('未通過');
    await expect(section).not.toContainText(/\b(pending|approved|declined)\b/);
    const search=page.getByPlaceholder('名稱、專業、會長或技能書');
    expect((await section.boundingBox())!.y).toBeLessThan((await search.boundingBox())!.y);
    await section.getByRole('button',{name:'顯示全部 5 件申請',exact:true}).click();
    await expect(section.locator('.guild-application-item')).toHaveCount(5);
    await expect(section.getByRole('button',{name:'收合',exact:true})).toHaveAttribute('aria-expanded','true');
    const approved=section.locator('.guild-application-item',{hasText:'已通過的田野公會'});
    const declined=section.locator('.guild-application-item',{hasText:'需要調整的公會'});
    await expect(approved).toContainText('專業：田野調查');
    await expect(approved).toContainText(/送出時間：2026/);
    await expect(approved).toContainText(/審核時間：2026/);
    await expect(approved).toContainText('審查說明：已整理成 AI 開發公會。');
    await expect(declined).toContainText('審查說明：請把想一起做的第一步寫得更具體。');
    await expect(declined).toContainText('可依審查說明調整後重新申請。');
    for(const width of widths){
      await page.setViewportSize({width,height:width===390?844:900});
      await noOverflow(page,`${width}px guild applications`);
      await page.screenshot({path:`test-results/mc51-guild-applications-${width}.png`,fullPage:true});
    }
    await page.setViewportSize({width:1280,height:900});
    for(const [label,theme] of themes){
      await shellTheme(page,label,theme);
      const paints=await section.locator('.guild-application-status').evaluateAll(nodes=>{
        const channel=(value:number)=>value<=0.03928?value/12.92:((value+0.055)/1.055)**2.4;
        const lum=(color:string)=>{const [r,g,b]=color.match(/[\d.]+/g)!.slice(0,3).map(Number).map(part=>channel(part/255));return 0.2126*r+0.7152*g+0.0722*b;};
        const seen=new Map<string,{fg:string;bg:string;ratio:number}>();
        for(const node of nodes){
          const state=[...node.classList].find(name=>name.startsWith('is-'));
          if(!state||seen.has(state))continue;
          const style=getComputedStyle(node),fg=style.color,bg=style.backgroundColor,a=lum(fg),b=lum(bg);
          seen.set(state,{fg,bg,ratio:(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05)});
        }
        return [...seen.entries()].map(([state,paint])=>({state,...paint}));
      });
      expect(paints.map(paint=>paint.state).sort(),theme).toEqual(['is-approved','is-declined','is-pending']);
      for(const paint of paints)expect(paint.ratio,`${theme} ${paint.state}`).toBeGreaterThanOrEqual(4.5);
      const colors=paints.map(paint=>paint.fg),backgrounds=paints.map(paint=>paint.bg);
      expect(new Set(colors).size,theme).toBe(3);expect(new Set(backgrounds).size,theme).toBe(3);
      if(theme!=='light')await page.screenshot({path:`test-results/mc51-guild-applications-${theme}.png`,fullPage:true});
    }
    await approved.getByRole('button',{name:'查看公會',exact:true}).click();
    await expect(page.locator('[data-guild-key="guild_ai_vibe"]')).toBeFocused();
    await expect(search).toHaveValue('AI 開發公會');
    await declined.getByRole('button',{name:'修改後重新申請',exact:true}).click();
    await expect(page.getByLabel('希望成立的公會名稱')).toHaveValue('需要調整的公會');
    await expect(page.getByLabel('專業／職業領域')).toHaveValue('田野整理');
    await expect(page.getByLabel('為什麼想成立？希望一起做什麼？')).toHaveValue('原本的理由還不夠具體，想依審查說明再送一次。');
    await expect(page.getByLabel('希望成立的公會名稱')).toBeFocused();
    await page.screenshot({path:'test-results/mc51-guild-revise-1280.png',fullPage:true});
    await page.getByRole('button',{name:'收起創建申請',exact:true}).click();
    await page.getByRole('button',{name:'申請創建公會',exact:true}).click();
    await expect(page.getByLabel('希望成立的公會名稱')).toHaveValue('');
    await expect(page.getByLabel('專業／職業領域')).toHaveValue('');
    await expect(page.getByLabel('為什麼想成立？希望一起做什麼？')).toHaveValue('');
    await page.getByLabel('希望成立的公會名稱').fill('第二件田野公會');
    await page.getByLabel('專業／職業領域').fill('田野調查');
    await page.getByLabel('為什麼想成立？希望一起做什麼？').fill('希望一起整理可以重用的田野觀察方法。');
    await page.getByRole('button',{name:'送出創建公會申請',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'謝謝你的申請'})).toBeVisible();
    await declined.getByRole('button',{name:'修改後重新申請',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'謝謝你的申請'})).toHaveCount(0);
    await expect(page.getByLabel('希望成立的公會名稱')).toHaveValue('需要調整的公會');
    await page.getByRole('button',{name:'收起創建申請',exact:true}).click();
    await page.getByRole('button',{name:'申請創建公會',exact:true}).click();
    await page.getByLabel('希望成立的公會名稱').fill('第三件田野公會');
    await page.getByLabel('專業／職業領域').fill('田野調查');
    await page.getByLabel('為什麼想成立？希望一起做什麼？').fill('希望一起整理可以重用的田野觀察方法。');
    await page.getByRole('button',{name:'送出創建公會申請',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'謝謝你的申請'})).toBeVisible();
    await search.fill('');
    await page.getByRole('button',{name:'加入音樂創作與MV公會',exact:true}).click();
    await expect(page.getByRole('status').filter({hasText:'已加入音樂創作與MV公會'})).toBeVisible();
    await expect(page.getByRole('status').filter({hasText:'謝謝你的申請'})).toHaveCount(0);
  }finally{
    await e2eAuthPool.query('DELETE FROM guild_creation_applications WHERE user_id=$1',[userId]);
  }
});

test('welcome keeps one primary action and selected filters stay distinct in every theme',async({page,browser})=>{
  const name='快速加入夥伴';
  await account(page,name);
  await page.setViewportSize({width:1280,height:900});
  await expect(page.locator('.welcome-preview .btn-primary')).toHaveCount(1);
  await expect(page.locator('.welcome-preview .btn-primary')).toHaveText('下一步：回答小問題');
  await page.getByText('想先探索其他參與方式？',{exact:true}).click();
  const hero=page.getByRole('button',{name:'開始／繼續定位 →',exact:true});
  await expect(hero).toHaveClass(/btn-ghost/);await expect(hero).not.toHaveClass(/btn-primary/);
  await page.screenshot({path:'test-results/mc51-welcome-1280.png',fullPage:true});
  for(const [label,theme] of themes){
    await previewTheme(page,name,label,theme);
    await pressedDiffers(page,'.welcome-preview .guild-topic-filter');
  }
  await page.setViewportSize({width:390,height:844});
  await noOverflow(page,'390 welcome');
  await page.screenshot({path:'test-results/mc51-welcome-390.png',fullPage:true});
  await page.setViewportSize({width:1280,height:900});
  await joinGuild(page);
  await shellTheme(page,'自由工坊－明亮','light');
  await expect(page.getByRole('button',{name:'補做定位測驗',exact:true})).toHaveClass(/btn-ghost/);
  await expect(page.getByRole('button',{name:'編輯我的名片',exact:true})).toBeVisible();
  await expect(page.getByText('完成定位後，名片會顯示擅長能力，也更容易遇到合適的夥伴。',{exact:true})).toBeVisible();
  await page.screenshot({path:'test-results/mc51-home-cta-1280.png',fullPage:true});
  await page.setViewportSize({width:390,height:844});
  await noOverflow(page,'390 home cta');
  await page.screenshot({path:'test-results/mc51-home-cta-390.png',fullPage:true});
  for(const [label,theme] of themes){
    await shellTheme(page,label,theme);
    for(const width of widths){
      await page.setViewportSize({width,height:width===390?844:900});
      await noOverflow(page,`${theme} ${width} home hint`);
      const paint=await hintContrast(page);
      expect(paint.ratio,`${theme} ${width}`).toBeGreaterThanOrEqual(4.5);
      expect(paint.alpha,`${theme} ${width}`).toBe(1);
      expect(paint.fontSize,`${theme} ${width}`).toBeGreaterThanOrEqual(14);
      expect(paint.inIdentity,`${theme} ${width}`).toBe(true);
      expect(paint.inActions,`${theme} ${width}`).toBe(false);
      expect(paint.inNext,`${theme} ${width}`).toBe(false);
      expect(paint.belowGuild,`${theme} ${width}`).toBe(true);
      const next=page.locator('.home-next-step');
      await expect(next).toHaveCount(1);
      await expect(next).toContainText('到技能書架選一本技能書閱讀，開始練習。');
      await expect(next).not.toContainText('補做定位測驗');
    }
  }
  await page.setViewportSize({width:1280,height:900});
  await navigate(page,'我的好友');
  await page.screenshot({path:'test-results/mc51-friends-1280.png',fullPage:true});
  for(const [label,theme] of themes){await shellTheme(page,label,theme);await pressedDiffers(page,'.friend-scopes');}
  await page.setViewportSize({width:390,height:844});
  await noOverflow(page,'390 friends');
  await page.screenshot({path:'test-results/mc51-friends-390.png',fullPage:true});
  await page.setViewportSize({width:820,height:900});
  await noOverflow(page,'820 friends');
  await page.setViewportSize({width:1280,height:900});
  await navigate(page,'職業公會');
  for(const [label,theme] of themes){await shellTheme(page,label,theme);await pressedDiffers(page,'.guilds-panel .guild-topic-filter');}
  await navigate(page,'我的名片');
  const settings=page.getByRole('region',{name:'分享我的工坊名片'});
  await expect(settings.getByRole('checkbox',{name:'在分享頁顯示我的頭像'})).not.toBeChecked();
  await page.screenshot({path:'test-results/mc51-share-settings-1280.png',fullPage:true});
  await shareControlWidths(page,false);
  await page.setViewportSize({width:820,height:900});
  await shareControlWidths(page,false);
  await page.setViewportSize({width:390,height:844});
  await shareControlWidths(page,true);
  await page.setViewportSize({width:1280,height:900});
  await settings.getByRole('button',{name:'建立分享連結',exact:true}).click();
  await expect(settings.getByRole('button',{name:'複製連結',exact:true})).toBeVisible();
  await expect(settings.getByRole('link',{name:'開啟名片',exact:true})).toBeVisible();
  await shareControlWidths(page,false);
  await page.setViewportSize({width:820,height:900});
  await shareControlWidths(page,false);
  await page.setViewportSize({width:390,height:844});
  await shareControlWidths(page,true);
  await page.setViewportSize({width:1280,height:900});
  const shareUrl=await settings.getByLabel('名片邀請連結').inputValue();
  const guestContext=await browser.newContext({viewport:{width:1280,height:900}}),guest=await guestContext.newPage();
  try{
    await guest.goto(shareUrl);
    await expect(guest.getByRole('heading',{name:`${name}的工坊名片`})).toBeVisible();
    await guest.screenshot({path:'test-results/mc51-public-card-1280.png',fullPage:true});
    await guest.setViewportSize({width:390,height:844});
    await noOverflow(guest,'390 public card');
    await guest.screenshot({path:'test-results/mc51-public-card-390.png',fullPage:true});
  }finally{await guestContext.close();}
  const token='c'.repeat(43);
  const card=await page.request.get(`/member-cards/${token}`);
  expect(card.status()).toBe(200);
  expect(card.headers()['x-robots-tag']).toBe('noindex, nofollow');
  expect(await card.text()).toContain('<html');
  expect((await page.request.get(`/member-cards/${token}/`)).headers()['x-robots-tag']).toBe('noindex, nofollow');
  for(const path of ['/','/guilds',`/member-cards/${'c'.repeat(10)}`])expect((await page.request.get(path)).headers()['x-robots-tag'],path).toBeUndefined();
});

test('a quick-entry member can finish positioning later and the invitation disappears',async({page})=>{
  await account(page,'補做定位夥伴');
  await joinGuild(page);
  await expect(page.getByRole('button',{name:'補做定位測驗',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'補做定位測驗',exact:true}).click();
  await page.getByRole('button',{name:'補充／繼續探索定位',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你喜歡怎麼做事？'})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'遇到這些情境，你會怎麼做？'})).toBeVisible();
  for(const field of await page.locator('.quiz-question').all())await field.getByRole('radio').first().check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？'})).toBeVisible();
  await page.getByLabel('搜尋能力',{exact:true}).fill('剛開始探索');
  await page.getByRole('checkbox',{name:'剛開始探索，想從基礎學起',exact:true}).check();
  await page.getByRole('checkbox',{name:'精選能力：剛開始探索，想從基礎學起',exact:true}).check();
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的裝備庫'})).toBeVisible();
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();
  await expect(page.getByRole('button',{name:'確認加入公會，領取技能書',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'確認加入公會，領取技能書',exact:true}).click();
  await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。'})).toBeVisible();
  await page.getByRole('button',{name:'進入自由工坊 →',exact:true}).click();
  const refreshed=page.waitForResponse(response=>response.url().includes('/api/v1/me/onboarding')&&response.ok());
  await navigate(page,'會員首頁');
  expect((await (await refreshed).json()).assessment_completed).toBe(true);
  await expect(page.locator('.home-member-skills')).toContainText('剛開始探索，想從基礎學起');
  await expect(page.getByRole('button',{name:'補做定位測驗'})).toHaveCount(0);
  await expect(page.getByText('完成定位後，名片會顯示擅長能力，也更容易遇到合適的夥伴。')).toHaveCount(0);
  await page.screenshot({path:'test-results/mc51-home-after-assessment-1280.png',fullPage:true});
  for(const width of [390,820] as const){
    await page.setViewportSize({width,height:width===390?844:900});
    await noOverflow(page,`${width} home after assessment`);
  }
});
