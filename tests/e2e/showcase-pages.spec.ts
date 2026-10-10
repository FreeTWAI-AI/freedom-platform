import {randomUUID} from 'node:crypto';
import {test,expect} from './fixtures.js';
import {navigate} from './navigation.js';

// #402: synthetic showcases in this run's schema; removed afterwards.
test('the community showcase list loads 20 at a time and a deep link past the first page still opens its card',async({page,e2eAuthPool})=>{
  const ids:string[]=[],tag=randomUUID().slice(0,8);
  for(let i=0;i<25;i++){
    const id=randomUUID();ids.push(id);
    await e2eAuthPool.query(`INSERT INTO showcases(showcase_id,community_id,owner_ref,title,description,artifact_ref,created_at)
      SELECT $1,community_id,user_id,$2,'合成分頁作品',$3,timestamptz '2001-01-01T00:00:00Z'+make_interval(mins=>$4) FROM users WHERE email='client@local.test'`,[id,`分頁作品 ${tag} ${i}`,`artifact:${id}`,i]);
  }
  try{
    await page.goto('/');
    await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await navigate(page,'作品與需求');
    const more=page.getByRole('button',{name:'載入更多作品',exact:true});
    await expect(more).toBeVisible();
    const cards=page.locator('[id^="showcase-"]');
    const before=await cards.count();
    expect(before).toBeLessThanOrEqual(20);
    await more.click();
    await expect.poll(()=>cards.count()).toBeGreaterThan(before);
    await page.setViewportSize({width:390,height:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);

    // The oldest synthetic showcase is beyond the first page; the deep link pages until it is shown and focused.
    await page.setViewportSize({width:1280,height:900});
    await page.goto(`/#showcase/${ids[0]}`);
    const target=page.locator(`#showcase-${ids[0]}`);
    await expect(target).toBeVisible({timeout:15000});
    await expect(target).toBeFocused();
    await expect(target).toContainText(`分頁作品 ${tag} 0`);
  }finally{
    await e2eAuthPool.query('DELETE FROM showcases WHERE showcase_id=ANY($1::uuid[])',[ids]);
  }
});
