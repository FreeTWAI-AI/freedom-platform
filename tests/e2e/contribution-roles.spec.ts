import {randomUUID} from 'node:crypto';
import {e2eOrigin} from '../../packages/testing/e2e-origin.js';
import {test,expect,type Page,type Locator} from './fixtures.js';
import {navigate} from './navigation.js';

const origin=e2eOrigin();
async function login(page:Page,email:string){
  const result=await page.request.post('/api/v1/auth/login',{headers:{Origin:origin},data:{email,password:'freedom-local-demo'}});
  expect(result.status()).toBe(200);return result.json();
}
async function post(page:Page,session:any,path:string,data:unknown,version?:number){
  const result=await page.request.post('/api/v1'+path,{headers:{Origin:origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID(),...(version===undefined?{}:{'If-Match':`"${version}"`})},data});
  expect(result.ok(),await result.text()).toBeTruthy();return result.json();
}
async function acceptedWork(makerPage:Page,maker:any,ownerPage:Page,owner:any){
  const title=`共同成果 ${randomUUID().slice(0,8)}`;
  const work=await post(ownerPage,owner,'/work-items',{title,objective:'一同改善手機上的工作流程',acceptance_criteria:'完成交付並保留各自分工',gain:'可重用的成果',estimated_minutes:15,maximum_minutes:30,claim_by:new Date(Date.now()+86400000).toISOString(),finish_by:new Date(Date.now()+172800000).toISOString(),will_review:true});
  let claim=await post(makerPage,maker,`/work-items/${work.work_item_id}:claim`,{claimant_type:'user',acting_profession_membership_ref:maker.user.profession_membership_ref,expected_aggregate_version:work.aggregate_version,terms_status:'declared',participation_terms_revision:work.participation_terms_revision,participation_terms_sha256:work.participation_terms_sha256},work.aggregate_version);
  claim=await post(makerPage,maker,`/work-claims/${claim.claim_id}:start`,{},claim.aggregate_version);
  claim=await post(makerPage,maker,`/work-claims/${claim.claim_id}:submit`,{summary:'完成真正的工作交付',artifact_ref:'artifact:contribution-browser-delivery'},claim.aggregate_version);
  claim=await post(ownerPage,owner,`/work-claims/${claim.claim_id}:begin-review`,{},claim.aggregate_version);
  await post(ownerPage,owner,`/work-claims/${claim.claim_id}:decide`,{decision:'accept',feedback:'符合驗收條件',submission_sha256:claim.latest_submission.sha256},claim.aggregate_version);
  return {...work,title};
}
async function tasks(page:Page,title:string){
  await page.goto('/');await navigate(page,'社群任務');
  await page.getByLabel('工坊工作狀態').selectOption('all');
  const card=page.locator('.experience-card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await expect(card).toBeVisible();return card;
}
async function openRoles(card:Locator){
  const roles=card.locator('.work-contribution-roles');
  await roles.locator(':scope > summary').focus();await roles.locator(':scope > summary').press('Enter');
  await expect(roles.getByLabel('我完成了什麼')).toBeVisible();return roles;
}
async function fillRole(roles:Locator,role='proposal',summary='提出手機使用需求，並核對三種主題的操作。'){
  await roles.getByRole('combobox',{name:'我的角色',exact:true}).selectOption(role);
  await roles.getByLabel('我完成了什麼').fill(summary);
  await roles.getByLabel('成果引用',{exact:false}).fill('artifact:mobile-review-v1');
  await roles.getByRole('checkbox').check();
}

test('three real members declare, confirm, amend and withdraw roles; cooperation shows evidence once per accepted Work',async({page,browser,baseURL})=>{
  test.setTimeout(120_000);
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  const makerContext=await browser.newContext({baseURL}),ownerContext=await browser.newContext({baseURL});
  const makerPage=await makerContext.newPage(),ownerPage=await ownerContext.newPage();
  try{
    const maker=await login(makerPage,'maker@local.test'),owner=await login(ownerPage,'reviewer@local.test');
    const makerBefore=await makerPage.request.get('/api/v1/me/contribution-outcomes');expect(makerBefore.ok()).toBeTruthy();const makerBaseline=(await makerBefore.json()).accepted_count;
    await login(page,'client@local.test');
    const work=await acceptedWork(makerPage,maker,ownerPage,owner);
    await page.setViewportSize({width:390,height:844});
    let reads=0;page.on('request',request=>{if(request.method()==='GET'&&request.url().includes(`/work-items/${work.work_item_id}/contribution-roles`))reads++;});
    const card=await tasks(page,work.title);
    await expect(page.getByRole('region',{name:'我的成果紀錄'})).toContainText('0 件已驗收工作');
    expect(reads).toBe(0);
    let roles=await openRoles(card);await fillRole(roles);
    await roles.screenshot({path:'test-results/contribution-role-form-light-390.png'});
    await roles.getByRole('button',{name:'保存角色署名',exact:true}).click();
    await expect(roles.getByText('署名已保存，等待合作成員確認。')).toBeVisible();
    await expect(roles.getByRole('article',{name:'示範合作方的提案署名'})).toContainText('本人填寫 · 待確認');
    const ownerCard=await tasks(ownerPage,work.title),ownerRoles=await openRoles(ownerCard);
    const ownReview=ownerRoles.getByRole('article',{name:'示範合作方的提案署名'});
    await ownReview.getByRole('button',{name:'閱讀並確認'}).click();
    await ownReview.getByRole('button',{name:'確認這個版本的角色'}).click();
    await expect(ownReview).toContainText('合作成員已確認');
    await tasks(page,work.title);
    const outcomes=page.getByRole('region',{name:'我的成果紀錄'});
    await expect(outcomes).toContainText('1 件已驗收工作');
    await expect(outcomes).toContainText(work.title);await expect(outcomes).toContainText('示範需求者 確認');
    roles=await openRoles(card);
    await fillRole(roles,'testing','在手機逐項驗收排版與鍵盤操作。');
    await roles.getByRole('button',{name:'保存角色署名',exact:true}).click();
    await expect(roles.getByRole('article',{name:'示範合作方的測試與驗收署名'})).toBeVisible();
    await tasks(ownerPage,work.title);const refreshedOwner=await openRoles(ownerCard);
    const testReview=refreshedOwner.getByRole('article',{name:'示範合作方的測試與驗收署名'});
    await testReview.getByRole('button',{name:'閱讀並確認'}).click();await testReview.getByRole('button',{name:'確認這個版本的角色'}).click();
    await expect(testReview).toContainText('合作成員已確認');
    await tasks(page,work.title);await expect(outcomes).toContainText('1 件已驗收工作');
    for(const [profile,theme,label,width] of [['light','light','自由工坊－明亮',390],['dark','dark','自由工坊－夜航',320],['versefolk','versefolk','自由工坊－敘生',1280],['guide-dragon','dark','新手導覽－龍娘',320],['guide-ai-sister','light','新手導覽－AI Sister',390]] as const){
      await page.setViewportSize({width,height:900});
      await page.getByRole('button',{name:'設定',exact:true}).click();
      await page.getByRole('menuitemradio',{name:label,exact:true}).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
      await expect(page.locator('html')).toHaveAttribute('data-experience-profile',profile);
      await expect(outcomes).toBeVisible();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await outcomes.screenshot({path:`test-results/contribution-outcomes-${profile}-${width}.png`});
    }
    roles=await openRoles(card);const proposal=roles.getByRole('article',{name:'示範合作方的提案署名'});
    await proposal.getByRole('button',{name:'修改署名'}).click();
    await expect(roles.getByRole('checkbox')).not.toBeChecked();
    await roles.getByLabel('我完成了什麼').fill('修正後的提案說明，必須重新確認。');await roles.getByRole('checkbox').check();
    await roles.getByRole('button',{name:'提交修改，重新確認'}).click();await expect(proposal).toContainText('本人填寫 · 待確認');
    await proposal.getByRole('button',{name:'撤回署名'}).click();await expect(proposal).toContainText('已撤回');
    await roles.getByRole('article',{name:'示範合作方的測試與驗收署名'}).getByRole('button',{name:'撤回署名'}).click();
    await expect(outcomes).toContainText('0 件已驗收工作');
    await tasks(page,work.title);await expect(outcomes).toContainText('0 件已驗收工作');
    await tasks(makerPage,work.title);await expect(makerPage.getByRole('region',{name:'我的成果紀錄'})).toContainText(`${makerBaseline+1} 件已驗收工作`);
    await navigate(makerPage,'工坊夥伴');
    const partner=makerPage.locator('.directory-member').filter({has:makerPage.getByRole('heading',{name:'示範合作方',exact:true})});
    await partner.getByText('更多資料',{exact:true}).click();
    await expect(partner.getByRole('region',{name:'夥伴的成果紀錄'})).toContainText('0 件已驗收工作');
    await expect(partner).not.toContainText('修正後的提案說明');expect(errors).toEqual([]);
  }finally{await makerContext.close();await ownerContext.close();}
});

test('a committed declaration with a lost response retries the same receipt; unavailable outcomes are never shown as zero',async({page,browser,baseURL})=>{
  test.setTimeout(90_000);
  const ownerContext=await browser.newContext({baseURL}),ownerPage=await ownerContext.newPage();
  try{
    const owner=await login(ownerPage,'reviewer@local.test');await login(page,'client@local.test');
    const title=`重送署名 ${randomUUID().slice(0,8)}`;
    const work=await post(ownerPage,owner,'/work-items',{title,objective:'未知回應可恢復',acceptance_criteria:'重送不會建立兩份署名',gain:'避免重複',estimated_minutes:10,maximum_minutes:20,claim_by:new Date(Date.now()+86400000).toISOString(),finish_by:new Date(Date.now()+172800000).toISOString(),will_review:true});
    let unavailable=true;await page.route('**/api/v1/me/contribution-outcomes?*',route=>unavailable?route.fulfill({status:503,json:{error:'temporarily_unavailable'}}):route.continue());
    const card=await tasks(page,title),outcomes=page.getByRole('region',{name:'我的成果紀錄'});
    await expect(outcomes.getByRole('alert')).toBeVisible();await expect(outcomes).not.toContainText('0 件已驗收工作');
    unavailable=false;await outcomes.getByRole('button',{name:'重新讀取成果'}).click();await expect(outcomes).toContainText('0 件已驗收工作');
    const roles=await openRoles(card);await fillRole(roles);
    const keys:string[]=[];let lost=false;
    await page.route(`**/api/v1/work-items/${work.work_item_id}/contribution-roles`,async route=>{
      if(route.request().method()!=='POST')return route.continue();
      keys.push(route.request().headers()['idempotency-key']);
      if(!lost){lost=true;const committed=await route.fetch();expect(committed.status()).toBe(201);await route.abort('failed');}else await route.continue();
    });
    await roles.getByRole('button',{name:'保存角色署名',exact:true}).click();
    await expect(roles.getByRole('alert')).toBeVisible();await expect(roles.getByLabel('我完成了什麼')).toHaveValue('提出手機使用需求，並核對三種主題的操作。');
    await roles.getByRole('button',{name:'保存角色署名',exact:true}).click();
    await expect(roles.getByText('署名已保存，等待合作成員確認。')).toBeVisible();
    expect(keys).toHaveLength(2);expect(keys[1]).toBe(keys[0]);await expect(roles.getByRole('article',{name:'示範合作方的提案署名'})).toHaveCount(1);
  }finally{await ownerContext.close();}
});
