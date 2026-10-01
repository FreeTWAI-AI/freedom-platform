import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';
import {answerGuildQuestions,quickJoin} from './quick-join.js';
async function signup(page:Page,name:string,start=true,guild='guild_ai_vibe'){
  if(start)await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill(name);
  await page.getByLabel('電子郵件',{exact:true}).fill(`connections-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-connections-password');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('heading',{name:`${name}，歡迎來到自由工坊。`})).toBeVisible();
  await quickJoin(page,guild);
}
test('mobile newcomer sees all guilds, can filter and enters after one choice without an assessment',async({page})=>{
  await page.setViewportSize({width:320,height:720});await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill('手機快速參與者');
  await page.getByLabel('電子郵件',{exact:true}).fill(`quick-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-connections-password');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  const quick=page.getByRole('region',{name:'快速加入公會'});
  await expect(quick.getByRole('radio')).toHaveCount(18);
  await quick.getByRole('button',{name:'影音與創作',exact:true}).click();await expect(quick.getByRole('radio')).toHaveCount(6);
  await quick.getByRole('button',{name:'全部主題',exact:true}).click();await expect(quick.getByRole('radio')).toHaveCount(18);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/issue-42-quick-entry-320.png',fullPage:true});
  await quick.locator('input[value="guild_ai_vibe"]').check();
  await quick.getByRole('button',{name:/下一步：回答 \d+ 個小問題/}).click();
  await answerGuildQuestions(quick);
  await quick.getByRole('button',{name:'加入公會，開始參與'}).click();
  await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
  await navigate(page,'我的定位');await expect(page.getByText('已選擇公會',{exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'補充／繼續探索定位'})).toBeVisible();
  await navigate(page,'技能書架');await expect(page.getByRole('region',{name:'已解鎖技能書',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('a shared card opens anonymously, survives reload, rotates and can be disabled',async({page,browser})=>{
  await signup(page,'分享名片作者');await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();await navigate(page,'我的名片');
  const settings=page.getByRole('region',{name:'分享我的工坊名片'});
  await expect(settings.getByRole('checkbox',{name:'在分享頁顯示我的頭像'})).not.toBeChecked();
  await settings.getByRole('button',{name:'建立分享連結'}).click();
  const openCard=settings.getByRole('link',{name:'開啟名片',exact:true});
  await expect(openCard).toBeVisible();
  const first=await openCard.getAttribute('href'),guestContext=await browser.newContext({viewport:{width:320,height:720}}),guest=await guestContext.newPage();
  try{
    await guest.goto(first!);await expect(guest.getByRole('heading',{name:'分享名片作者的工坊名片'})).toBeVisible();await expect(guest.getByRole('button',{name:'加入自由工坊／登入'})).toBeVisible();
    await guest.reload();await expect(guest.getByRole('heading',{name:'分享名片作者的工坊名片'})).toBeVisible();expect(await guest.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await guest.screenshot({path:'test-results/issue-42-public-card-320.png',fullPage:true});
    await settings.getByRole('button',{name:'更新連結',exact:true}).click();await expect(openCard).not.toHaveAttribute('href',first!);const second=await openCard.getAttribute('href');
    await guest.reload();await expect(guest.getByRole('heading',{name:'暫時無法開啟這張名片'})).toBeVisible();
    await guest.goto(second!);await expect(guest.getByRole('heading',{name:'分享名片作者的工坊名片'})).toBeVisible();
    await settings.getByRole('button',{name:'停用分享'}).click();await expect(settings.getByRole('button',{name:'建立分享連結'})).toBeVisible();await guest.reload();await expect(guest.getByRole('heading',{name:'暫時無法開啟這張名片'})).toBeVisible();
  }finally{await guestContext.close();}
});
test('invited visitor signs up, returns to the card and becomes a friend only after acceptance',async({page,browser})=>{
  await signup(page,'邀請發起人');await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();await navigate(page,'我的名片');
  const sharing=page.getByRole('region',{name:'分享我的工坊名片'});await sharing.getByRole('button',{name:'建立分享連結'}).click();const openCard=sharing.getByRole('link',{name:'開啟名片',exact:true});await expect(openCard).toBeVisible();const url=await openCard.getAttribute('href');
  const context=await browser.newContext(),guest=await context.newPage();let releaseAccept=()=>{};
  try{
    await guest.goto(url!);await guest.getByRole('button',{name:'加入自由工坊／登入'}).click();await signup(guest,'受邀共創夥伴',false);
    await expect(guest.getByRole('heading',{name:'邀請發起人的工坊名片'})).toBeVisible();await guest.getByRole('button',{name:'邀請成為好友',exact:true}).click();await expect(guest.getByText('好友邀請待回覆',{exact:true})).toBeVisible();
    await guest.getByRole('button',{name:'返回會員首頁'}).click();await navigate(guest,'我的好友');await guest.getByRole('button',{name:'送出的邀請',exact:true}).click();await expect(guest.locator('.friends-panel').getByRole('heading',{name:'邀請發起人',exact:true})).toBeVisible();
    await navigate(page,'我的好友');await page.getByRole('button',{name:'收到的邀請',exact:true}).click();const friend=page.locator('.friends-panel .directory-member').filter({has:page.getByRole('heading',{name:'受邀共創夥伴',exact:true})});
    let accepted=false;const acknowledgement=new Promise<void>(resolve=>{releaseAccept=resolve;});
    await page.route('**/api/v1/friends/*/accept',async route=>{const response=await route.fetch();expect(response.status()).toBe(200);accepted=true;await acknowledgement;await route.fulfill({response});});
    await friend.getByRole('button',{name:'接受邀請'}).click();await expect.poll(()=>accepted).toBe(true);
    await page.getByRole('button',{name:'我的好友',exact:true}).last().click();await expect(page.locator('.friends-panel').getByRole('heading',{name:'受邀共創夥伴',exact:true})).toBeVisible();
    const refreshed=page.waitForResponse(response=>response.request().method()==='GET'&&response.url().includes('/api/v1/friends/directory?'));releaseAccept();expect(new URL((await refreshed).url()).searchParams.get('scope')).toBe('accepted');
    await expect(page.locator('.friends-panel').getByRole('heading',{name:'受邀共創夥伴',exact:true})).toBeVisible();
    await page.getByRole('button',{name:'我的好友',exact:true}).last().click();await expect(page.locator('.friends-panel').getByRole('heading',{name:'受邀共創夥伴',exact:true})).toBeVisible();
    await page.getByLabel('搜尋好友名稱').fill('受邀共創夥伴');await expect(page.locator('.friends-panel .directory-member')).toHaveCount(1);await page.screenshot({path:'test-results/issue-42-friends-desktop.png',fullPage:true});
    await page.setViewportSize({width:320,height:720});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/issue-42-friends-320.png',fullPage:true});
    await navigate(guest,'會員首頁');await navigate(guest,'我的好友');await expect(guest.locator('.friends-panel').getByRole('heading',{name:'邀請發起人',exact:true})).toBeVisible();
  }finally{releaseAccept();await context.close();}
});
test('home recommends a shared-guild member and guild topic filtering works in all themes',async({page,browser})=>{
  const context=await browser.newContext({baseURL:new URL(test.info().project.use.baseURL as string).origin}),candidate=await context.newPage();
  try{
    await signup(candidate,'共讀推薦夥伴',true,'guild_human_design');await expect(candidate.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
    await signup(page,'共讀探索者',true,'guild_human_design');await expect(page.getByRole('heading',{name:'會員首頁',level:1})).toBeVisible();
    const recommendation=page.getByRole('region',{name:'認識一位工坊夥伴'});await expect(recommendation.getByRole('heading',{name:'共讀推薦夥伴',exact:true})).toBeVisible();await expect(recommendation.getByText('你們都加入了人類圖研究所')).toBeVisible();
    await recommendation.getByRole('button',{name:'查看名片'}).click();await expect(recommendation.locator('.member-card')).toBeVisible();await recommendation.getByRole('button',{name:'換一位'}).click();await expect(recommendation.locator('.connection-person h3')).not.toHaveText('共讀推薦夥伴');
    await navigate(page,'職業公會');await page.getByRole('button',{name:'AI 與技術',exact:true}).click();await expect(page.locator('.guild-card')).toHaveCount(8);await expect(page.locator('.guild-card').filter({hasText:'音樂創作與MV公會'})).toHaveCount(0);
    const settingsButton=page.getByRole('button',{name:'設定',exact:true});
    for(const [name,theme] of [['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']]){
      if(await settingsButton.getAttribute('aria-expanded')!=='true')await settingsButton.click();
      await page.getByRole('menuitemradio',{name,exact:true}).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    }
    await settingsButton.click();
    await page.setViewportSize({width:320,height:720});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/issue-42-guild-tags-320.png',fullPage:true});
  }finally{await context.close();}
});
test('admin reads a transparent rules report and requests only a due refresh',async({page})=>{
  let refreshes=0;
  await page.route('**/admin/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    if(path.endsWith('/bootstrap'))return route.fulfill({json:{admin:{admin_id:'fixture-admin',display_name:'管理者',email:'fixture@example.test',role:'super_admin',community_id:'fixture'},csrf_token:'synthetic-csrf',summary:{members:1,active_members:1,pending_guild_applications:0,guilds:0,admins:1},available_skill_books:[]}});
    if(path.includes('/guild-discovery')){if(route.request().method()==='POST')refreshes++;return route.fulfill({json:{generated_at:null,next_attempt_at:null,ai_configured:false,report:{method:'rules',ai_status:'not_configured',catalog_count:18,pairs:[{guild_keys:['guild_ai_vibe','guild_ai_field'],names:['AI 開發公會','AI 導入與驗證公會'],reason:'共同 AI 主題',difference:'開發與驗證的目的不同',suggestion:'clarify',shared_topics:['AI 與技術'],shared_books:[]}]}}});}
    return route.fulfill({json:{items:[],next_offset:null}});
  });
  await page.goto('/admin');await page.getByRole('button',{name:'公會管理',exact:true}).click();await page.getByRole('button',{name:'查看分析'}).click();await expect(page.getByText('AI 開發公會 × AI 導入與驗證公會')).toBeVisible();await expect(page.getByText('AI 分析尚未啟用；管理者可依部署文件設定分析模型。目錄比對仍可使用。')).toBeVisible();
  await page.getByRole('button',{name:'更新到期分析'}).click();await expect.poll(()=>refreshes).toBe(1);await expect(page.getByText('分析不會改動公會、會員或技能書。下一次可更新：尚未排定。')).toBeVisible();
});
