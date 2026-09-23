import {test,expect,type Page,type Locator} from '@playwright/test';
const origin='http://127.0.0.1:4311';
async function login(page:Page,email:string){const r=await page.request.post('/api/v1/auth/login',{headers:{Origin:origin},data:{email,password:'freedom-local-demo'}});expect(r.status()).toBe(200);return r.json();}
async function post(page:Page,session:any,path:string,body:unknown,version?:number){
 const r=await page.request.post('/api/v1'+path,{headers:{Origin:origin,'X-CSRF-Token':session.csrf_token,'Idempotency-Key':crypto.randomUUID(),...(version?{'If-Match':`"${version}"`}:{})},data:body});
 expect(r.ok(),await r.text()).toBeTruthy();return r.json();
}
async function expectSaved(card:Locator){
 await expect(card.getByRole('status').filter({hasText:'已保存你的回報。修改會保留先前紀錄，不改變成果驗收。'})).toBeVisible();
 await expect(card.getByRole('status').filter({hasText:'正在讀取你的回報…'})).toBeHidden();
 await expect(card.getByRole('button',{name:'更新我的回報',exact:true})).toBeEnabled();
 await expect(card.getByRole('alert')).toHaveCount(0);
}
test('optional benefit reports load only when opened, persist privately and remain available after acceptance',async({page,browser,baseURL})=>{
 const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
 const ownerContext=await browser.newContext({baseURL}),ownerPage=await ownerContext.newPage();
 try{
  const owner=await login(ownerPage,'reviewer@local.test'),maker=await login(page,'maker@local.test');
  const title=`自願實益回報 ${Date.now()}`;
  const work=await post(ownerPage,owner,'/work-items',{title,objective:'讓參與者自願記下是否得到幫助',acceptance_criteria:'保留真實回報且不洩漏私人內容',gain:'共同改善工具，不保證收入',estimated_minutes:15,maximum_minutes:30,claim_by:new Date(Date.now()+86400000).toISOString(),finish_by:new Date(Date.now()+2*86400000).toISOString(),will_review:true});
  let claim=await post(page,maker,`/work-items/${work.work_item_id}:claim`,{claimant_type:'user',acting_profession_membership_ref:maker.user.profession_membership_ref,expected_aggregate_version:work.aggregate_version,terms_status:'declared',participation_terms_revision:work.participation_terms_revision,participation_terms_sha256:work.participation_terms_sha256},work.aggregate_version);
  claim=await post(page,maker,`/work-claims/${claim.claim_id}:start`,{},claim.aggregate_version);
  let reads=0;page.on('request',request=>{if(request.method()==='GET'&&request.url().includes('/benefit-observations'))reads++;});
  await page.goto('/#workbench');const card=page.locator('article.card').filter({has:page.getByRole('heading',{name:title,exact:true})});
  await expect(card).toBeVisible();expect(reads).toBe(0);
  await card.getByText('這次合作帶給我什麼（選填）',{exact:true}).click();
  await expect(card.getByLabel('這次有得到預期的幫助嗎？')).toBeVisible();expect(reads).toBe(1);
  await card.getByLabel('這次有得到預期的幫助嗎？').selectOption('partly_gained');
  await card.getByLabel('具體得到了什麼？').fill('只有我可見的測試心得');
  await card.getByRole('button',{name:'保存我的回報',exact:true}).click();await expectSaved(card);
  await page.reload();await card.getByText('這次合作帶給我什麼（選填）',{exact:true}).click();await expect(card.getByLabel('具體得到了什麼？')).toHaveValue('只有我可見的測試心得');
  await ownerPage.goto('/#workbench');const ownerCard=ownerPage.locator('article.card').filter({has:ownerPage.getByRole('heading',{name:title,exact:true})});
  await ownerCard.getByText('這次合作帶給我什麼（選填）',{exact:true}).click();
  await expect(ownerCard.getByLabel('這次有得到預期的幫助嗎？')).toHaveValue('unconfirmed');
  await expect(ownerCard).not.toContainText('只有我可見的測試心得');
  await ownerCard.getByRole('button',{name:'保存我的回報',exact:true}).click();await expectSaved(ownerCard);
  claim=await post(page,maker,`/work-claims/${claim.claim_id}:submit`,{summary:'完成可重用說明',artifact_ref:'artifact:benefit-browser-result'},claim.aggregate_version);
  claim=await post(ownerPage,owner,`/work-claims/${claim.claim_id}:begin-review`,{},claim.aggregate_version);
  await post(ownerPage,owner,`/work-claims/${claim.claim_id}:decide`,{decision:'accept',feedback:'符合完成條件',submission_sha256:claim.latest_submission.sha256},claim.aggregate_version);
  await page.reload();await expect(card.getByText('artifact:benefit-browser-result',{exact:true})).toBeVisible();
  await card.getByText('這次合作帶給我什麼（選填）',{exact:true}).click();await expect(card.getByLabel('這次有得到預期的幫助嗎？')).toHaveValue('partly_gained');
  await card.getByLabel('這次有得到預期的幫助嗎？').selectOption('not_gained');
  await card.getByLabel('想補充的經驗（選填）').fill('');await card.getByRole('button',{name:'更新我的回報',exact:true}).click();await expectSaved(card);
  expect(errors).toEqual([]);
 }finally{await ownerContext.close();}
});
