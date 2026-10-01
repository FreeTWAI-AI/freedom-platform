import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';

const widths=[{width:390,height:844},{width:820,height:1100},{width:1280,height:800}] as const;
const fits=(page:Page)=>page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth);

test('members can open an ended event from the past list and the calendar',async({page,browser,e2eAuthPool,baseURL})=>{
  test.setTimeout(90_000);
  const id=randomUUID(),title=`過去共學 ${id.slice(0,8)}`,description='這場活動已經結束，仍可回來看說明。';
  const starts=new Date(Date.now()-45*24*60*60*1000),ends=new Date(starts.getTime()+2*60*60*1000);
  const months=(new Date().getFullYear()-starts.getFullYear())*12+(new Date().getMonth()-starts.getMonth());
  const monthLabel=starts.toLocaleDateString('zh-TW',{year:'numeric',month:'long'});
  await e2eAuthPool.query(`INSERT INTO community_events(event_id,community_id,organizer_ref,title,description,starts_at,ends_at,mode,location,state,visibility,event_kind)
    SELECT $1,community_id,user_id,$2,$3,$4,$5,'online','線上教室','published','open','other' FROM users WHERE email='maker@local.test'`,
  [id,title,description,starts.toISOString(),ends.toISOString()]);
  const anon=await browser.newContext({baseURL});
  try{
    await page.goto('/');
    await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');
    await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
    await page.getByRole('button',{name:'登入',exact:true}).click();
    await navigate(page,'社群活動');
    await expect(page.getByRole('heading',{name:'活動行事曆'})).toBeVisible();
    await expect(page.getByRole('grid',{name:new Date().toLocaleDateString('zh-TW',{year:'numeric',month:'long'})})).toBeVisible();
    for(const size of widths){
      await page.setViewportSize(size);
      const past=page.getByRole('region',{name:'過去的活動'});
      await expect(past).toBeVisible();
      await expect(past.locator('summary')).toHaveCount(0);
      await expect(past.locator('.experience-heading')).toContainText('1 場');
      await expect(past.getByRole('heading',{name:title})).toBeVisible();
      await expect(past.getByText('已結束').first()).toBeVisible();
      await expect(past.getByRole('button',{name:'我要參加',exact:true})).toHaveCount(0);
      await expect(past.getByRole('button',{name:'分享活動',exact:true})).toHaveCount(0);
      await expect(past.getByRole('button',{name:'報名',exact:true})).toHaveCount(0);
      const back=page.getByRole('button',{name:'上個月'});
      await expect(back).toBeEnabled();
      for(let step=0;step<months;step++)await back.click();
      const chip=page.getByRole('grid',{name:monthLabel}).getByRole('button',{name:`${title}，已結束`});
      await expect(chip).toBeVisible();
      await expect(chip).toHaveAttribute('data-ended','true');
      expect(await chip.evaluate(element=>{
        const probe=document.createElement('span');
        probe.style.color=getComputedStyle(document.documentElement).getPropertyValue('--muted').trim();
        document.body.append(probe);
        const muted=getComputedStyle(probe).color;
        probe.remove();
        return getComputedStyle(element).color===muted;
      })).toBe(true);
      expect(await fits(page)).toBe(true);
      for(let step=0;step<months;step++)await page.getByRole('button',{name:'下個月'}).click();
    }
    await page.setViewportSize(widths[2]);
    let monthsBack=0;
    while(await page.getByRole('button',{name:'上個月'}).isEnabled()){
      await page.getByRole('button',{name:'上個月'}).click();
      monthsBack+=1;
      expect(monthsBack).toBeLessThanOrEqual(12);
    }
    expect(monthsBack).toBe(12);
    await expect(page.getByRole('button',{name:'上個月'})).toBeDisabled();
    for(let step=0;step<monthsBack;step++)await page.getByRole('button',{name:'下個月'}).click();
    for(let step=0;step<months;step++)await page.getByRole('button',{name:'上個月'}).click();
    await page.getByRole('grid',{name:monthLabel}).getByRole('button',{name:`${title}，已結束`}).click();
    await expect(page).toHaveURL(new RegExp(`#events/${id}$`));
    const detail=page.getByRole('region',{name:'活動專頁'});
    for(const size of widths){
      await page.setViewportSize(size);
      await expect(detail.getByRole('heading',{name:title})).toBeVisible();
      await expect(detail.getByText('已結束').first()).toBeVisible();
      await expect(detail.getByText(description)).toBeVisible();
      await expect(detail).toContainText('人報名');
      await expect(detail.getByRole('button',{name:'我要參加',exact:true})).toHaveCount(0);
      await expect(detail.getByRole('button',{name:'分享活動',exact:true})).toHaveCount(0);
      await expect(detail.getByRole('alert')).toHaveCount(0);
      expect(await fits(page)).toBe(true);
    }
    const publicPage=await anon.newPage();
    await publicPage.goto(`/events/${id}`);
    for(const size of widths){
      await publicPage.setViewportSize(size);
      await expect(publicPage.getByRole('heading',{name:title})).toBeVisible();
      await expect(publicPage.getByText('已結束').first()).toBeVisible();
      await expect(publicPage.getByText(description)).toBeVisible();
      await expect(publicPage.getByText(/人已報名/)).toBeVisible();
      await expect(publicPage.getByRole('button',{name:'報名並寄送參與資料'})).toHaveCount(0);
      await expect(publicPage.getByRole('heading',{name:'報名活動'})).toHaveCount(0);
      await expect(publicPage.getByRole('alert')).toHaveCount(0);
      await expect(publicPage.getByText('活動目前無法公開查看')).toHaveCount(0);
      expect(await fits(publicPage)).toBe(true);
    }
  }finally{
    await anon.close();
    await e2eAuthPool.query('DELETE FROM community_events WHERE event_id=$1',[id]);
  }
});
