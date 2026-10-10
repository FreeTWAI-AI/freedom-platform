import {test,expect,type Page} from './member-feature-fixture.js';
import {DEMO_PASSWORD,DEMO_USERS} from '../../packages/testing/seed.js';

async function login(page:Page){
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill(DEMO_USERS[0].email);
  await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.locator('.shell')).toBeVisible();
}
const isOpen=(url:string)=>/\/api\/v1\/community-search\/operations\/[^/]+\/open$/.test(new URL(url).pathname);

test.describe('metrics enabled',()=>{
  let release:()=>void=()=>{},accepted:()=>void=()=>{};
  let held=Promise.resolve(),arrived=Promise.resolve();
  test.use({memberFeatures:{communitySearchEnabled:true,participationMetricsEnabled:true},
    memberRequestGate:{before:async request=>{if(isOpen(request.url)){accepted();await held;}}}
  });
  test.beforeEach(()=>{
    held=new Promise<void>(resolve=>{release=resolve});
    arrived=new Promise<void>(resolve=>{accepted=resolve});
  });
  test.afterEach(()=>release());
  test('a real search open completes after leaving the document for a skill page',async({page,e2eAuthPool})=>{
    await login(page);
    const result=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/community-search');
    await page.goto('/#community-search?q='+encodeURIComponent('技能'));
    const payload=await (await result).json();
    expect(payload.operation_id).toBeTruthy();
    const link=page.getByRole('region',{name:'社群內容搜尋結果'}).locator('a[href^="/development/skills/"]').first();
    const destination=await link.getAttribute('href');
    expect(destination).toMatch(/^\/development\/skills\//);
    // Observe transport options without replacing the actual network request.
    await page.evaluate(()=>{
      const original=window.fetch.bind(window);
      window.fetch=(input,init)=>{
        if(String(input).includes('/community-search/operations/'))sessionStorage.setItem('test-search-open-keepalive',String(init?.keepalive===true));
        return original(input,init);
      };
    });
    try{
      await link.click();
      await arrived;
      await expect(page).toHaveURL(new RegExp(destination!+'$'));
      expect((await e2eAuthPool.query('SELECT opened_at FROM community_search_operations WHERE operation_id=$1',[payload.operation_id])).rows[0].opened_at).toBeNull();
    }finally{release();}
    // The old document's requestfinished event is detached on navigation; the
    // durable database row is the observable completion, after releasing HTTP.
    expect(await page.evaluate(()=>sessionStorage.getItem('test-search-open-keepalive'))).toBe('true');
    await expect.poll(async()=>(await e2eAuthPool.query('SELECT opened_kind,opened_at IS NOT NULL AS opened FROM community_search_operations WHERE operation_id=$1',[payload.operation_id])).rows[0]).toEqual({opened_kind:'skill_book',opened:true});
  });
});

test.describe('metrics disabled',()=>{
  test.use({memberFeatures:{communitySearchEnabled:true,participationMetricsEnabled:false}});
  test('ordinary search and navigation record no metric while disabled',async({page,e2eAuthPool})=>{
    await login(page);
    const before=Number((await e2eAuthPool.query('SELECT count(*) FROM community_search_operations')).rows[0].count);
    const result=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/community-search');
    await page.goto('/#community-search?q='+encodeURIComponent('技能'));
    expect((await (await result).json()).operation_id).toBeUndefined();
    await page.getByRole('region',{name:'社群內容搜尋結果'}).locator('a[href^="/development/skills/"]').first().click();
    await expect(page).toHaveURL(/\/development\/skills\/[^/]+$/);
    expect(Number((await e2eAuthPool.query('SELECT count(*) FROM community_search_operations')).rows[0].count)).toBe(before);
  });
});
