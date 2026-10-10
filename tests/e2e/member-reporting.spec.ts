import {randomUUID} from 'node:crypto';
import {test,expect,type BrowserContext,type Page} from './fixtures.js';
import {closeChat,navigate,openChat} from './navigation.js';
import {DEMO_USERS,DEMO_COMMUNITY,DEMO_PASSWORD} from '../../packages/testing/seed.js';

test.skip(process.env.FREEDOM_MEMBER_REPORTING_ENABLED!=='true','Member reporting runs in its isolated feature-enabled pass.');
const themes=[['自由工坊－明亮','light'],['自由工坊－夜航','dark'],['自由工坊－敘生','versefolk']] as const;
for(const width of [1280,390,320])for(const [themeName,theme] of themes){
  test(`member reports preserve unknown commands and restrict evidence at ${width}px ${theme}`,async({browser,baseURL,e2eAuthPool:db})=>{
    const contexts:BrowserContext[]=[],ids=[randomUUID(),randomUUID(),randomUUID()],emails=ids.map(id=>`reporting-${id}@example.test`),names=ids.map(id=>`合成檢舉 ${id.slice(0,8)}`),adminId=randomUUID();
    let caseId:string|undefined;
    async function login(index:number,withChat=true){
      const context=await browser.newContext({baseURL,viewport:{width,height:900}});contexts.push(context);
      await context.route(url=>!['localhost','127.0.0.1'].includes(url.hostname),route=>route.abort());
      const page=await context.newPage();await page.goto('/');
      await page.getByLabel('電子郵件',{exact:true}).fill(emails[index]);await page.getByLabel('密碼',{exact:true}).fill(DEMO_PASSWORD);
      await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.locator('.shell')).toBeVisible();
      // Theme first: the floating chat is modal and would cover the account menu.
      const settings=page.getByRole('button',{name:'設定',exact:true});if(await settings.getAttribute('aria-expanded')!=='true')await settings.click();
      await page.getByRole('menuitemradio',{name:themeName,exact:true}).click();
      await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
      if(await settings.getAttribute('aria-expanded')==='true')await settings.click();
      if(withChat){await openChat(page);await expect(page.locator('.messages-categories')).toBeVisible();}
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
      await closeChat(page);
      await navigate(page,'我的名片');await page.getByRole('button',{name:'我的檢舉案件',exact:true}).click();
      await expect(page.getByRole('heading',{name:'我的檢舉案件',exact:true})).toBeVisible();await expect(page.locator('article').filter({hasText:'已收到'})).toBeVisible();
      await expect(page.locator('body')).not.toContainText('合成私人補充說明');await bounds(page);
      const admin=await login(2,false),adminPanel=admin.getByRole('region',{name:'平台檢舉案件',exact:true});await adminPanel.getByRole('button',{name:'平台檢舉案件',exact:true}).click();
      // The queue row has no note or evidence; opening the case loads both.
      const item=adminPanel.locator('article').filter({hasText:message});await expect(item).toBeVisible();await expect(item).not.toContainText('合成私人補充說明');
      await item.locator('summary').focus();await item.locator('summary').press('Enter');await expect(item.locator('pre')).toContainText('合成私人檢舉證據');await expect(item).toContainText('合成私人補充說明');await bounds(admin);
      await item.getByLabel('處理理由').fill('已核對合成證據');await item.getByLabel('處理摘要').fill('合成案件正在處理');await item.getByLabel('內容動作').selectOption('none');
      const transitions:{body:string|null;key:string|undefined;version:string|undefined}[]=[];let loseTransition=true;
      await admin.route(`**/api/v1/admin/reports/${caseId}/transition`,async route=>{
        transitions.push({body:route.request().postData(),key:route.request().headers()['idempotency-key'],version:route.request().headers()['if-match']});
        const response=await route.fetch();if(loseTransition){loseTransition=false;return route.abort();}await route.fulfill({response});
      });
      await item.getByRole('button',{name:'開始處理',exact:true}).click();await expect(item.getByRole('alert')).toBeVisible();await expect(item.getByRole('heading')).toContainText('已收到');
      await item.getByRole('button',{name:'重試同一筆案件操作',exact:true}).click();await expect(item.getByRole('heading')).toContainText('處理中');expect(transitions[1]).toEqual(transitions[0]);expect(transitions[0].version).toMatch(/^"\d+"$/);
      await item.getByLabel('處理理由').fill('核對完成');await item.getByLabel('處理摘要').fill('合成案件已結案，未變更內容');await item.getByRole('button',{name:'結案',exact:true}).click();await expect(item.getByRole('heading')).toContainText('已結案');await expect(item.getByRole('button',{name:'結案',exact:true})).toHaveCount(0);
      await page.getByRole('button',{name:'更新檢舉案件',exact:true}).click();await expect(page.locator('article').filter({hasText:'合成案件已結案'})).toContainText('已結案');
      await db.query('UPDATE platform_admins SET active=false WHERE admin_id=$1',[adminId]);await adminPanel.getByRole('button',{name:'更新平台檢舉案件',exact:true}).click();await expect(adminPanel).toHaveCount(0);await expect(admin.locator('body')).not.toContainText('合成私人補充說明');
    }finally{
      await Promise.all(contexts.map(context=>context.close()));
      await db.query('DELETE FROM member_reports WHERE reporter_user_id=ANY($1::uuid[])',[ids]);
      await db.query('DELETE FROM platform_admins WHERE admin_id=$1',[adminId]);
      await db.query('DELETE FROM member_direct_messages WHERE sender_ref=ANY($1::uuid[]) OR recipient_ref=ANY($1::uuid[])',[ids]);
      for(const table of ['positioning_guild_officers','positioning_profession_memberships','member_accounts','sessions','member_client_errors','command_receipts'])await db.query(`DELETE FROM ${table} WHERE user_id=ANY($1::uuid[])`,[ids]);
      await db.query('DELETE FROM member_notifications WHERE recipient_ref=ANY($1::uuid[])',[ids]);
      await db.query('DELETE FROM outbox WHERE transition_id IN (SELECT transition_id FROM transition_journal WHERE actor_ref=ANY($1::uuid[]))',[ids]);
      await db.query('DELETE FROM transition_journal WHERE actor_ref=ANY($1::uuid[])',[ids]);
      await db.query('DELETE FROM users WHERE user_id=ANY($1::uuid[])',[ids]);
    }
  });
}
