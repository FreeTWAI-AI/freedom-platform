import {randomUUID} from 'node:crypto';
import {test,expect,type BrowserContext,type Page} from './member-feature-fixture.js';
import {navigate} from './navigation.js';
import {DEMO_USERS,DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';

test.describe('reporting enabled',()=>{
test.use({memberFeatures:{memberReportingEnabled:true}});
const themes=[['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']] as const;
for(const width of [1440,768,390,320])for(const [themeName,theme] of themes){
  test(`member reports preserve unknown commands and restrict evidence at ${width}px ${theme}`,async({browser,baseURL,e2eAuthPool:db},testInfo)=>{
    const contexts:BrowserContext[]=[],ids=[randomUUID(),randomUUID(),randomUUID()],emails=ids.map(id=>`reporting-${id}@example.test`),names=ids.map(id=>`合成檢舉 ${id.slice(0,8)}`),adminId=randomUUID();
    let caseId:string|undefined;
    const paginated=width===1440&&theme==='light';
    const adminList=(url:URL)=>url.pathname==='/api/v1/admin/reports';
    async function login(index:number){
      const context=await browser.newContext({baseURL,viewport:{width,height:900}});contexts.push(context);
      await context.route(url=>!['localhost','127.0.0.1'].includes(url.hostname),route=>route.abort());
      const page=await context.newPage();await page.goto('/#home');
      await page.getByLabel('電子郵件',{exact:true}).fill(emails[index]);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
      await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.locator('.shell')).toBeVisible();
      const settings=page.getByRole('button',{name:'設定',exact:true});await settings.click();await page.getByRole('menuitemradio',{name:themeName,exact:true}).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
      if(await settings.getAttribute('aria-expanded')==='true')await settings.click();
      await page.locator('.floating-messages').click();
      await expect(page.locator('.messages-categories')).toBeVisible();
      return page;
    }
    async function bounds(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
    try{
      for(let i=0;i<ids.length;i++){
        await db.query(`INSERT INTO users(user_id,community_id,email,display_name,password_hash,profession_membership_ref,onboarding_required,email_verified_at)
          SELECT $1,$2,$3,$4,password_hash,$5,false,now() FROM users WHERE user_id=$6`,[ids[i],DEMO_COMMUNITY,emails[i],names[i],randomUUID(),DEMO_USERS[0].user_id]);
        await db.query("INSERT INTO positioning_profession_memberships(membership_id,community_id,user_id,guild_key,state) VALUES($1,$2,$3,'guild_ai_vibe','active')",[randomUUID(),DEMO_COMMUNITY,ids[i]]);
      }
      await db.query("INSERT INTO positioning_guild_officers(community_id,guild_key,user_id) VALUES($1,'guild_ai_vibe',$2)",[DEMO_COMMUNITY,ids[0]]);
      await db.query('INSERT INTO platform_admins(admin_id,community_id,email,display_name) VALUES($1,$2,$3,$4)',[adminId,DEMO_COMMUNITY,emails[2],names[2]]);
      const message=(await db.query('INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body) VALUES($1,$2,$3,$4) RETURNING message_id',[DEMO_COMMUNITY,ids[1],ids[0],'合成私人檢舉證據'])).rows[0].message_id as string;
      if(paginated){
        // Real old messages/cases owned only by these accounts; exceed one bounded page.
        await db.query(`WITH messages AS (INSERT INTO member_direct_messages(community_id,sender_ref,recipient_ref,body,created_at)
          SELECT $1,$2,$3,'合成分頁訊息 '||n,clock_timestamp()-interval '2 hours'-n*interval '1 second' FROM generate_series(1,21) n RETURNING message_id,body)
          INSERT INTO member_reports(community_id,reporter_user_id,target_kind,target_id,reason,evidence,created_at)
          SELECT $1,$3,'direct_message',message_id,'spam',jsonb_build_object('content',jsonb_build_object('body',body)),clock_timestamp()-interval '2 hours' FROM messages`,[DEMO_COMMUNITY,ids[1],ids[0]]);
      }
      const page=await login(0),panel=page.locator('#messages-panel-direct');
      await expect(page.getByRole('button',{name:'平台檢舉案件',exact:true})).toHaveCount(0);
      await panel.getByLabel('搜尋會員',{exact:true}).fill(names[1]);await panel.getByRole('button',{name:'搜尋會員',exact:true}).click();await panel.getByRole('button',{name:`傳訊給 ${names[1]}`,exact:true}).click();
      await expect(panel.locator('.messages-bubbles')).toContainText('合成私人檢舉證據');
      await expect(panel.getByRole('button',{name:/^檢舉/}).first()).toBeVisible();
      await panel.getByRole('button',{name:'搜尋訊息',exact:true}).click();
      const search=page.getByRole('dialog',{name:'搜尋訊息',exact:true});await search.getByLabel('搜尋這個對話的訊息').fill('私人檢舉');await search.getByRole('button',{name:'搜尋',exact:true}).click();
      const entry=search.locator(`[data-search-message-id="${message}"]`).getByRole('button',{name:'檢舉搜尋訊息',exact:true});await expect(entry).toBeVisible();
      expect((await entry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await entry.focus();await entry.press('Enter');
      const report=page.getByRole('dialog',{name:'檢舉搜尋訊息',exact:true});await expect(report).toBeVisible();await bounds(page);
      await report.getByLabel('檢舉原因').selectOption('harassment');await report.getByLabel('補充說明（選填）').fill('合成私人補充說明');
      const commands:{body:string|null;key:string|undefined}[]=[];let lose=true;
      await page.route('**/api/v1/me/reports',async route=>{
        if(route.request().method()!=='POST')return route.continue();
        commands.push({body:route.request().postData(),key:route.request().headers()['idempotency-key']});
        const response=await route.fetch();if(lose){lose=false;return route.abort();}await route.fulfill({response});
      });
      await report.getByRole('button',{name:'送出檢舉',exact:true}).click();await expect(report.getByRole('alert')).toBeVisible();await expect(report).not.toContainText('已收到檢舉，案件編號');
      await report.getByRole('button',{name:'重試同一筆檢舉',exact:true}).click();await expect(report.getByRole('status')).toContainText('已收到檢舉');expect(commands).toHaveLength(2);expect(commands[1]).toEqual(commands[0]);
      caseId=(await db.query('SELECT case_id FROM member_reports WHERE reporter_user_id=$1 AND target_id=$2',[ids[0],message])).rows[0].case_id;
      await report.press('Escape');await expect(entry).toBeFocused();await search.press('Escape');
      const back=panel.getByRole('button',{name:'← 返回對話列表',exact:true});
      if(await back.isVisible())await back.click();
      await page.locator('.floating-message-header button').click();
      await navigate(page,'我的名片');await page.getByRole('button',{name:'我的檢舉案件',exact:true}).click();
      await expect(page.getByRole('heading',{name:'我的檢舉案件',exact:true})).toBeVisible();await expect(page.locator('article').filter({hasText:'已收到'}).first()).toBeVisible();
      await expect(page.locator('body')).not.toContainText('合成私人補充說明');await bounds(page);
      if(paginated){
        const mine=page.locator('section').filter({has:page.getByRole('heading',{name:'我的檢舉案件',exact:true})}).last();
        await expect(mine.locator('article')).toHaveCount(20);await mine.getByRole('button',{name:'更多檢舉案件',exact:true}).click();
        await expect(mine.locator('article')).toHaveCount(22);await expect(mine.getByRole('button',{name:'更多檢舉案件',exact:true})).toHaveCount(0);
      }
      const admin=await login(2);await admin.locator('.floating-message-header button').click();const adminPanel=admin.getByRole('region',{name:'平台檢舉案件',exact:true});await adminPanel.getByRole('button',{name:'平台檢舉案件',exact:true}).click();
      if(paginated){await expect(adminPanel.locator('article')).toHaveCount(20);await adminPanel.getByRole('button',{name:'更多平台檢舉案件',exact:true}).click();await expect(adminPanel.locator('article')).toHaveCount(22);await expect(adminPanel.getByRole('button',{name:'更多平台檢舉案件',exact:true})).toHaveCount(0);}
      const item=adminPanel.locator('article').first();await expect(item).toBeVisible();await item.getByText('查看案件證據',{exact:true}).focus();await item.getByText('查看案件證據',{exact:true}).press('Enter');await expect(item.locator('.report-evidence-copy')).toContainText('合成私人檢舉證據');await bounds(admin);
      if(width>=768){expect((await item.getByRole('button',{name:'開始處理',exact:true}).boundingBox())!.width).toBeLessThan((await item.boundingBox())!.width/2);}
      await item.screenshot({path:testInfo.outputPath('report-case.png')});
      await admin.screenshot({path:testInfo.outputPath('report-admin.png'),fullPage:true});
      await item.getByLabel('處理理由').fill('已核對合成證據');await item.getByLabel('處理摘要').fill('合成案件正在處理');await item.getByLabel('內容動作').selectOption('none');
      let releaseList:(()=>void)|undefined;
      if(paginated){
        const blocked=new Promise<void>(resolve=>{releaseList=resolve;});
        let entered:()=>void=()=>{};const started=new Promise<void>(resolve=>{entered=resolve;});
        await admin.route(adminList,async route=>{const response=await route.fetch();entered();await blocked;await route.fulfill({response});});
        await adminPanel.getByRole('button',{name:'更新平台檢舉案件',exact:true}).click();await started;
      }
      const transitions:{body:string|null;key:string|undefined;version:string|undefined}[]=[];let loseTransition=true;
      await admin.route(`**/api/v1/admin/reports/${caseId}/transition`,async route=>{
        transitions.push({body:route.request().postData(),key:route.request().headers()['idempotency-key'],version:route.request().headers()['if-match']});
        const response=await route.fetch();if(loseTransition){loseTransition=false;return route.abort();}await route.fulfill({response});
      });
      await item.getByRole('button',{name:'開始處理',exact:true}).click();await expect(item.getByRole('alert')).toBeVisible();await expect(item.getByRole('heading')).toContainText('已收到');
      if(releaseList){const stale=admin.waitForResponse(response=>new URL(response.url()).pathname==='/api/v1/admin/reports');releaseList();await stale;await admin.unroute(adminList);await expect(item.getByRole('heading')).toContainText('已收到');}
      await expect(adminPanel.getByLabel('案件狀態',{exact:true})).toBeDisabled();await expect(adminPanel.getByRole('button',{name:'更新平台檢舉案件',exact:true})).toBeDisabled();
      await item.getByRole('button',{name:'重試同一筆案件操作',exact:true}).click();await expect(item.getByRole('heading')).toContainText('處理中');expect(transitions[1]).toEqual(transitions[0]);expect(transitions[0].version).toMatch(/^"\d+"$/);
      await item.getByLabel('處理理由').fill('核對完成');await item.getByLabel('處理摘要').fill('合成案件已結案，未變更內容');await item.getByRole('button',{name:'結案',exact:true}).click();await expect(item.getByRole('heading')).toContainText('已結案');await expect(item.getByRole('button',{name:'結案',exact:true})).toHaveCount(0);
      if(paginated){
        await adminPanel.getByLabel('案件狀態',{exact:true}).selectOption('open');await expect(adminPanel.locator('article')).toHaveCount(20);await expect(adminPanel).not.toContainText('合成案件已結案');
        await adminPanel.getByRole('button',{name:'更多平台檢舉案件',exact:true}).click();await expect(adminPanel.locator('article')).toHaveCount(21);
        await adminPanel.getByLabel('案件狀態',{exact:true}).selectOption('all');await expect(adminPanel.locator('article')).toHaveCount(20);await expect(adminPanel).toContainText('合成案件已結案');
        await adminPanel.getByRole('button',{name:'更多平台檢舉案件',exact:true}).click();await expect(adminPanel.locator('article')).toHaveCount(22);
        await adminPanel.getByLabel('案件狀態',{exact:true}).selectOption('closed');await expect(adminPanel.locator('article')).toHaveCount(1);await expect(adminPanel.locator('article')).toContainText('合成案件已結案');
        await adminPanel.getByLabel('案件狀態',{exact:true}).selectOption('received');await expect(adminPanel.locator('article')).toHaveCount(20);await expect(adminPanel).not.toContainText('合成案件已結案');
        await adminPanel.getByRole('button',{name:'更多平台檢舉案件',exact:true}).click();await expect(adminPanel.locator('article')).toHaveCount(21);
      }
      await page.getByRole('button',{name:'更新檢舉案件',exact:true}).click();await expect(page.locator('article').filter({hasText:'合成案件已結案'})).toContainText('已結案');
      await db.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[adminId]);await adminPanel.getByRole('button',{name:'更新平台檢舉案件',exact:true}).click();await expect(adminPanel).toHaveCount(0);await expect(admin.locator('body')).not.toContainText('合成私人補充說明');
    }finally{
      await Promise.allSettled(contexts.map(context=>context.close()));
      await db.query('DELETE FROM member_reports WHERE reporter_user_id=ANY($1::uuid[])',[ids]);
      await db.query('DELETE FROM platform_admins WHERE admin_id=$1',[adminId]);
      await db.query('DELETE FROM member_direct_messages WHERE sender_ref=ANY($1::uuid[]) OR recipient_ref=ANY($1::uuid[])',[ids]);
      for(const table of ['community_social_reads','positioning_guild_officers','positioning_profession_memberships','member_accounts','sessions','member_client_errors','command_receipts'])await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[ids]);
      await db.query('DELETE FROM member_notifications WHERE recipient_ref=ANY($1::uuid[])',[ids]);
      await db.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[ids]);
      await db.query('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[ids]);
      await db.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[ids]);
    }
  });
}

});
test.describe('reporting disabled',()=>{
  test.use({memberFeatures:{}});
  test('no reporting entry or authenticated evidence route is installed by default',async({page})=>{
    await page.goto('/#home');await page.getByLabel('電子郵件',{exact:true}).fill(DEMO_USERS[0].email);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);await page.getByRole('button',{name:'登入',exact:true}).click();
    await expect(page.locator('.shell')).toBeVisible();await navigate(page,'我的名片');
    await expect(page.getByRole('button',{name:'我的檢舉案件',exact:true})).toHaveCount(0);await expect(page.getByRole('region',{name:'平台檢舉案件',exact:true})).toHaveCount(0);
    const id=randomUUID();for(const path of ['/me/reports','/admin/reports',`/admin/reports/${id}`,`/admin/reports/${id}/image`])expect((await page.request.get('/api/v1'+path)).status(),path).toBe(404);
    expect((await (await page.request.get('/api/v1/site')).json()).member_reporting_enabled).toBe(false);
  });
});
