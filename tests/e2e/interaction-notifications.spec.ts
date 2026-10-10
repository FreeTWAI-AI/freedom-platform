import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {e2eOrigin} from '../../packages/testing/e2e-origin.js';
import {signOut,navigate} from './navigation.js';

// #403 with the real API: another member comments, the author opens the notice and lands on the post.
async function login(page:Page,email:string){
  await page.goto('/');
  await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();
  await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
}
async function post(page:Page,path:string,data:unknown){
  const session=await (await page.request.get('/api/v1/session')).json();
  const response=await page.request.post(`/api/v1${path}`,{headers:{Origin:e2eOrigin(),'X-CSRF-Token':session.csrf_token,'Idempotency-Key':randomUUID()},data});
  expect(response.ok(),path).toBe(true);return response.json();
}

for(const filter of ['note','tag'] as const)test(`a comment notification opens a paged link from the settled ${filter} filter and is consumed on leaving`,async({page,e2eAuthPool})=>{
  const text=`E2E 通知貼文 ${randomUUID().slice(0,8)}`;
  await login(page,'maker@local.test');
  const created=await post(page,'/social-posts',{url:`https://example.com/notifications/${randomUUID()}`,title:text,note:text});
  // Push the post below the first page so focusing must page through the feed.
  for(let i=0;i<26;i++)await e2eAuthPool.query(`INSERT INTO community_social_posts(community_id,author_user_id,kind,url,platform,title,note,state,tags)
    SELECT community_id,author_user_id,'note',NULL,'other',$2,$2,'active',ARRAY['notification_filter'] FROM community_social_posts WHERE post_id=$1`,[created.post_id,`${text} filler ${i} #notification_filter`]);
  await signOut(page);await login(page,'reviewer@local.test');
  await post(page,`/social-posts/${created.post_id}/comments`,{text:'E2E 很棒的作品'});
  await post(page,`/social-posts/${created.post_id}/like`,{liked:true});
  await signOut(page);await login(page,'maker@local.test');
  try{
    const card=page.locator(`#social-post-${created.post_id}`);
    // Already mounted with the settled default note filter: the link is excluded.
    await navigate(page,'社群分享');await expect(page.locator('.social-zone')).toHaveAttribute('aria-busy','false');
    await expect(card).toHaveCount(0);
    if(filter==='tag'){
      await page.locator('.social-card').getByRole('button',{name:'#notification_filter',exact:true}).first().click();
      await expect(page.locator('.social-active-tag')).toContainText('#notification_filter');
      await expect(page.locator('.social-zone')).toHaveAttribute('aria-busy','false');
    }
    // Bell: choosing the comment notice opens the social feed focused on the post, past the first page.
    await page.locator('.notification-bell-trigger').click();
    const popover=page.locator('.notification-bell-popover');
    await popover.locator('.notification-bell-item',{hasText:'在你的貼文留言'}).filter({hasText:text}).click();
    await expect(card).toBeFocused({timeout:15000});
    await expect(card).toContainText(text);
    await page.screenshot({path:'test-results/notification-post-focus.png'});
    // Notification list: the like notice's 查看貼文 does the same.
    const trigger=page.locator('.notification-bell-trigger');
    if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded','true');
    await popover.locator('.notification-bell-all').click();
    const item=page.locator('[data-notification]').filter({hasText:'對你的貼文按讚'}).filter({hasText:text});
    await expect(item).toBeVisible();
    await item.getByRole('button',{name:'查看貼文',exact:true}).click();
    await expect(card).toBeFocused({timeout:15000});
    // Ordinary navigation back must not consume this old notification again.
    await navigate(page,'會員首頁');await navigate(page,'社群分享');
    await expect(page.locator('.social-zone')).toHaveAttribute('aria-busy','false');
    await expect(card).toHaveCount(0);
  }finally{
    await e2eAuthPool.query('DELETE FROM member_notifications WHERE action_resource_id=$1',[created.post_id]);
    await e2eAuthPool.query('DELETE FROM community_social_posts WHERE post_id=$1 OR note LIKE $2',[created.post_id,text+' filler %']);
  }
});
