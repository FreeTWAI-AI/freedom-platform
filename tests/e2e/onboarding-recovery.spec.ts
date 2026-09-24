import {randomUUID} from 'node:crypto';
import {test,expect,type Page,type Route} from './fixtures.js';

async function startStepThree(page:Page){
  await page.goto('/');await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill('定位恢復測試夥伴');await page.getByLabel('電子郵件',{exact:true}).fill(`recovery-${randomUUID()}@example.test`);await page.getByLabel('密碼',{exact:true}).fill('freedom-recovery-test-2026');
  await page.getByRole('button',{name:'註冊並開始定位',exact:true}).click();
  for(const title of ['你喜歡怎麼做事？','遇到這些情境，你會怎麼做？']){
    await expect(page.getByRole('heading',{name:title,exact:true})).toBeVisible();
    for(const question of await page.locator('.quiz-question').all())await question.getByRole('radio').first().check();
    await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();
  }
  await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？',exact:true})).toBeVisible();
  await page.getByLabel('你的職業／目前身分',{exact:true}).fill('保留的私人職業答案');
}
function record(route:Route){return {body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key'],version:route.request().headers()['if-match']};}
function expectExactRetry(writes:ReturnType<typeof record>[]){expect(writes).toHaveLength(2);expect(writes[0].key).toBeTruthy();expect(writes[1]).toEqual(writes[0]);}

async function expectPreservedUnknown(page:Page){
  await expect(page.getByRole('alert')).toContainText('目前頁面的答案仍保留，請重試保存。');
  await expect(page.getByRole('heading',{name:'你從哪裡來，帶著哪些能力？',exact:true})).toBeVisible();
  await expect(page.getByLabel('你的職業／目前身分',{exact:true})).toHaveValue('保留的私人職業答案');
  await expect(page.getByLabel('你的職業／目前身分',{exact:true})).toBeDisabled();await expect(page.getByRole('button',{name:'上一步',exact:true})).toBeDisabled();
  await expect(page.getByRole('navigation',{name:'主要工作區'})).toHaveCount(0);
  await expect(page.getByRole('alert')).not.toContainText(/Cloudflare|<html>|Connection timed out/);
}

test('HTML 522 preserves step-three answers, disables edits while pending, and only retries the exact save on request',async({page})=>{
  await startStepThree(page);const writes:ReturnType<typeof record>[]=[];let release!:()=>void,started!:()=>void;
  const pending=new Promise<void>(resolve=>{release=resolve;}),requested=new Promise<void>(resolve=>{started=resolve;});
  await page.route('**/api/v1/me/onboarding/answers',async route=>{writes.push(record(route));if(writes.length===1){started();await pending;return route.fulfill({status:522,headers:{'content-type':'text/html','cf-ray':'8c1234567890abcd-TPE','x-freedom-request-id':'d58b4bd0-43bb-4736-992e-c2b21bf5f68a'},body:'<html><title>Cloudflare Error 522: Connection timed out</title></html>'});}return route.continue();});
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();await requested;
  await expect(page.getByLabel('你的職業／目前身分',{exact:true})).toBeDisabled();release();await expectPreservedUnknown(page);expect(writes).toHaveLength(1);
  await page.getByText('問題資訊',{exact:true}).click();await expect(page.getByRole('alert')).toContainText('HTTP：522');await expect(page.getByRole('alert')).toContainText('8c1234567890abcd-TPE');await expect(page.getByRole('alert')).toContainText('d58b4bd0-43bb-4736-992e-c2b21bf5f68a');
  await page.setViewportSize({width:320,height:844});await page.getByRole('alert').scrollIntoViewIfNeeded();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:'test-results/onboarding-recovery-phone.png'});
  await page.getByRole('button',{name:'重試保存',exact:true}).click();await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();expectExactRetry(writes);
  const saved=await (await page.request.get('/api/v1/me/onboarding')).json();expect(saved.draft.occupation).toBe('保留的私人職業答案');expect(saved.draft.aggregate_version).toBe(3);
});

test('committed step-three save with a lost JSON 522 response replays its receipt and later edits use the recovered version',async({page})=>{
  await startStepThree(page);const writes:ReturnType<typeof record>[]=[];let committedVersion=0;
  await page.route('**/api/v1/me/onboarding/answers',async route=>{writes.push(record(route));if(writes.length===1){const committed=await route.fetch();expect(committed.status()).toBe(200);committedVersion=(await committed.json()).draft.aggregate_version;return route.fulfill({status:522,json:{title:'Cloudflare Error 522',detail:'Connection timed out at origin',code:'conflict'}});}return route.continue();});
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();await expectPreservedUnknown(page);await expect(page.getByRole('button',{name:'重讀保存版本',exact:true})).toHaveCount(0);
  expect((await (await page.request.get('/api/v1/me/onboarding')).json()).draft.aggregate_version).toBe(committedVersion);expect(writes).toHaveLength(1);
  await page.getByRole('button',{name:'重試保存',exact:true}).click();await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();expectExactRetry(writes);
  expect((await (await page.request.get('/api/v1/me/onboarding')).json()).draft.aggregate_version).toBe(committedVersion);
  await page.getByRole('button',{name:'上一步',exact:true}).click();await page.getByLabel('你的職業／目前身分',{exact:true}).fill('恢復後主動修改的職業');await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();
  expect(writes).toHaveLength(3);expect(writes[2].version).toBe(`"${committedVersion}"`);expect(writes[2].key).not.toBe(writes[1].key);const saved=await (await page.request.get('/api/v1/me/onboarding')).json();expect(saved.draft.aggregate_version).toBe(committedVersion+1);expect(saved.draft.occupation).toBe('恢復後主動修改的職業');
});

test('lost committed evaluation and completion responses retry their own command without repeating answer saves or unlocking early',async({page})=>{
  await startStepThree(page);await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();
  const answerWrites:ReturnType<typeof record>[]=[],evaluation:ReturnType<typeof record>[]=[],completion:ReturnType<typeof record>[]=[];
  await page.route('**/api/v1/me/onboarding/answers',async route=>{answerWrites.push(record(route));return route.continue();});
  await page.route('**/api/v1/me/onboarding/evaluate',async route=>{evaluation.push(record(route));if(evaluation.length===1){expect((await route.fetch()).status()).toBe(200);return route.abort('failed');}return route.continue();});
  await page.getByRole('button',{name:'看看適合我的公會',exact:true}).click();await expect(page.getByRole('button',{name:'重試保存',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();await expect(page.getByLabel('搜尋裝備',{exact:true})).toBeDisabled();expect(evaluation).toHaveLength(1);
  await page.getByRole('button',{name:'重試保存',exact:true}).click();await expect(page.getByRole('heading',{name:'找到同路人，開始一起做事。',exact:true})).toBeVisible();expectExactRetry(evaluation);expect(answerWrites).toHaveLength(1);
  const card=page.locator('.recommendation-card').first();await card.getByRole('checkbox').check();await card.getByRole('radio').check();
  await page.route('**/api/v1/me/onboarding/complete',async route=>{completion.push(record(route));if(completion.length===1){expect((await route.fetch()).status()).toBe(200);return route.fulfill({status:524,body:'<html>Cloudflare upstream timeout</html>'});}return route.continue();});
  await page.getByRole('button',{name:'確認加入公會，領取技能書',exact:true}).click();await expect(page.getByRole('button',{name:'重試保存',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。',exact:true})).toHaveCount(0);await expect(card.getByRole('checkbox')).toBeDisabled();
  await page.getByRole('button',{name:'重試保存',exact:true}).click();await expect(page.getByRole('heading',{name:'你的第一段旅程，現在開始。',exact:true})).toBeVisible();expectExactRetry(completion);expect(evaluation).toHaveLength(2);expect(answerWrites).toHaveLength(1);
});

test('known version conflicts reload only the saved version, preserve the local draft and require another explicit save',async({page})=>{
  await startStepThree(page);const writes:ReturnType<typeof record>[]=[];let concurrentVersion=0;
  await page.route('**/api/v1/me/onboarding/answers',async route=>{
    writes.push(record(route));if(writes.length===1){const response=await route.fetch({headers:{...route.request().headers(),'idempotency-key':randomUUID()},postData:JSON.stringify({...route.request().postDataJSON(),occupation:'另一分頁已保存的職業'})});expect(response.status()).toBe(200);concurrentVersion=(await response.json()).draft.aggregate_version;}
    return route.continue();
  });
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();await expect(page.getByRole('button',{name:'重讀保存版本',exact:true})).toBeVisible();await expect(page.getByLabel('你的職業／目前身分',{exact:true})).toHaveValue('保留的私人職業答案');await expect(page.getByRole('button',{name:'重試保存',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'重讀保存版本',exact:true}).click();await expect(page.getByText('已讀取最新保存版本，本頁答案仍保留。請確認後再次保存。',{exact:true})).toBeVisible();expect(writes).toHaveLength(1);await expect(page.getByLabel('你的職業／目前身分',{exact:true})).toHaveValue('保留的私人職業答案');
  expect((await (await page.request.get('/api/v1/me/onboarding')).json()).draft.occupation).toBe('另一分頁已保存的職業');
  await page.getByRole('button',{name:'保存，繼續下一步 →',exact:true}).click();await expect(page.getByRole('heading',{name:'你的裝備庫',exact:true})).toBeVisible();expect(writes).toHaveLength(2);expect(writes[1].version).toBe(`"${concurrentVersion}"`);expect(writes[1].key).not.toBe(writes[0].key);expect((await (await page.request.get('/api/v1/me/onboarding')).json()).draft.occupation).toBe('保留的私人職業答案');
});
