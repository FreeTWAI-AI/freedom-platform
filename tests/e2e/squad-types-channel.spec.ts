import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import {navigate,signOut} from './navigation.js';
import {test,expect,type Page} from './fixtures.js';

async function member(pool:Pool,label:string){
  const id=randomUUID(),email=`squad-channel-${id}@local.test`;
  await pool.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required)
    SELECT $1,community_id,$2,$3,password_hash,$4,false FROM users WHERE email='maker@local.test'`,[id,email,label,randomUUID()]);
  return email;
}
async function login(page:Page,email:string){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}

test('a coaching squad shows its public channel and owner can rename it on desktop and phone',async({page,e2eAuthPool})=>{
  const owner=await member(e2eAuthPool,'陪跑隊主'),viewer=await member(e2eAuthPool,'路過會員'),name=`陪跑練習 ${randomUUID().slice(0,8)}`;
  await page.setViewportSize({width:1440,height:900});
  await login(page,owner);await navigate(page,'小隊集合');
  await page.getByRole('button',{name:'成立一支小隊',exact:true}).click();
  const form=page.locator('form').filter({has:page.getByRole('heading',{name:'成立一支小隊'})});
  await form.getByLabel('小隊名稱').fill(name);
  await form.getByLabel('小隊類型').selectOption('coaching');
  await form.getByLabel('我們想一起完成什麼').fill('每週互相陪伴練習。');
  await form.getByLabel('小隊溝通頻道名稱（選填）').fill('LINE 陪跑交流');
  await form.getByRole('button',{name:'成立小隊'}).click();
  const detail=page.getByRole('region',{name:'小隊詳情'});
  await expect(detail.getByText('溝通頻道：LINE 陪跑交流')).toBeVisible();
  await page.screenshot({path:'test-results/squad-channel-desktop.png'});
  await detail.getByRole('button',{name:'成員與管理'}).click();
  await detail.locator('.squad-manage > summary').click();
  await detail.getByLabel('小隊溝通頻道名稱',{exact:true}).fill('LINE 新頻道');
  await detail.getByRole('button',{name:'儲存頻道名稱'}).click();
  await expect(detail.getByText('溝通頻道：LINE 新頻道')).toBeVisible();
  await signOut(page);
  await login(page,viewer);await navigate(page,'小隊集合');
  await page.getByLabel('搜尋小隊',{exact:true}).fill(name);
  await page.getByLabel('篩選小隊類型').selectOption('coaching');
  const card=page.locator('.expedition-squad').filter({hasText:name});
  await expect(card.getByText('技能學習陪跑小隊')).toBeVisible();
  await expect(card.getByText('溝通頻道：LINE 新頻道')).toBeVisible();
  await card.getByRole('button',{name:`查看小隊：${name}`}).click();
  await expect(detail.getByText('溝通頻道：LINE 新頻道')).toBeVisible();
  await expect(detail.getByRole('button',{name:'儲存頻道名稱'})).toHaveCount(0);
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:'test-results/squad-channel-phone.png',fullPage:true,animations:'disabled'});
});

test('four kinds share one compact directory; creation and owner cards open invitations directly',async({page,e2eAuthPool})=>{
  const owner=await member(e2eAuthPool,'四類隊長'),peer=await member(e2eAuthPool,'小隊受邀夥伴');
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await login(page,owner);await navigate(page,'小隊集合');
  await expect(page.getByLabel('小隊名稱',{exact:true})).toHaveCount(0);
  const kinds=[['project','開源專案合作團隊'],['mutual_help','生意機會合作團隊'],['coaching','技能學習陪跑小隊'],['social','吃喝玩樂交流小隊']];
  for(const [kind,label] of kinds){
    await page.getByRole('button',{name:'成立一支小隊',exact:true}).click();
    await expect(page.getByLabel('小隊名稱',{exact:true})).toBeFocused();
    await page.getByLabel('小隊名稱',{exact:true}).fill(label+'測試');
    await page.getByRole('combobox',{name:'小隊類型',exact:true}).selectOption(kind);
    await page.getByLabel('我們想一起完成什麼').fill('一起規劃下一次聚會，分享想法和共同完成的成果。');
    await page.getByRole('button',{name:'成立小隊',exact:true}).click();
    const detail=page.getByRole('region',{name:'小隊詳情'});
    await expect(detail.getByLabel('搜尋要邀請的夥伴')).toBeVisible();
    await expect(page.getByLabel('搜尋小隊',{exact:true})).toBeHidden();
    await expect(detail.locator('.squad-manage')).toHaveCount(0);
    await detail.getByRole('button',{name:'返回小隊列表'}).click();
    await page.getByLabel('只看我的小隊',{exact:true}).check();
    await page.getByLabel('篩選小隊類型').selectOption(kind);
    const card=page.locator('.expedition-squad');
    await expect(card).toHaveCount(1);await expect(card.getByText(label,{exact:true})).toBeVisible();
    await page.getByRole('button',{name:'清除小隊篩選'}).click();
    await page.getByLabel('只看我的小隊',{exact:true}).check();
  }
  await expect(page.locator('.expedition-squad')).toHaveCount(4);
  for(const width of [1440,768,390]){
    await page.setViewportSize({width,height:900});
    await page.evaluate(()=>window.scrollTo(0,0));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`test-results/squads-directory-${width}.png`,fullPage:true,animations:'disabled'});
  }
  for(const theme of ['dark','versefolk']){
    await page.evaluate(theme=>{document.documentElement.dataset.theme=theme;window.scrollTo(0,0);},theme);
    await page.screenshot({path:`test-results/squads-directory-${theme}.png`,fullPage:true,animations:'disabled'});
  }
  await page.evaluate(()=>{document.documentElement.dataset.theme='light';});
  await page.getByRole('button',{name:'邀請夥伴：吃喝玩樂交流小隊測試',exact:true}).click();
  const detail=page.getByRole('region',{name:'小隊詳情'});
  await detail.getByLabel('搜尋要邀請的夥伴').fill('小隊受邀夥伴');
  await detail.getByRole('button',{name:'搜尋夥伴',exact:true}).click();
  await detail.getByRole('button',{name:'邀請 小隊受邀夥伴',exact:true}).click();
  await expect(detail.getByText('已邀請，等候回覆')).toBeVisible();
  await page.evaluate(()=>window.scrollTo(0,0));
  await expect(detail).toContainText('隊長：四類隊長');
  await page.screenshot({path:'test-results/squads-invite-390.png',fullPage:true,animations:'disabled'});
  await signOut(page);await login(page,peer);await navigate(page,'小隊集合');
  await expect(page.getByRole('button',{name:'邀請夥伴：吃喝玩樂交流小隊測試',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'接受邀請：吃喝玩樂交流小隊測試',exact:true})).toBeVisible();
  expect(errors).toEqual([]);
});
