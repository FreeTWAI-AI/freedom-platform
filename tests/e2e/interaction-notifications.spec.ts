import {randomUUID} from 'node:crypto';
import {test,expect,type Page} from './fixtures.js';
import {e2eOrigin} from '../../packages/testing/e2e-origin.js';
import {signOut} from './navigation.js';

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

test('a comment notifies the author, whose bell and notification list open the commented post',async({page,e2eAuthPool})=>{
  const text=`E2E 通知貼文 ${randomUUID().slice(0,8)}`;
  await login(page,'maker@local.test');
  const created=await post(page,'/social-posts/notes',{text});
  // Push the post below the first page so focusing must page through the feed.
  for(let i=0;i<26;i++)await e2eAuthPool.query(`INSERT INTO community_social_posts(community_id,author_user_id,kind,url,platform,title,note,state)
    SELECT community_id,author_user_id,'note',NULL,'other',$2,$2,'active' FROM community_social_posts WHERE post_id=$1`,[created.post_id,`E2E 填充 ${i}`]);
  await signOut(page);await login(page,'reviewer@local.test');
  await post(page,`/social-posts/${created.post_id}/comments`,{text:'E2E 很棒的作品'});
  await post(page,`/social-posts/${created.post_id}/like`,{liked:true});
  await signOut(page);await login(page,'maker@local.test');
  try{
    const card=page.locator(`#social-post-${created.post_id}`);
    // Bell: choosing the comment notice opens the social feed focused on the post, past the first page.
    await page.locator('.notification-bell-trigger').click();
    const popover=page.locator('.notification-bell-popover');
    await popover.locator('.notification-bell-item',{hasText:'在你的貼文留言'}).click();
    await expect(card).toBeFocused({timeout:15000});
    await expect(card).toContainText(text);
    await page.screenshot({path:'test-results/notification-post-focus.png'});
    // Notification list: the like notice's 查看貼文 does the same.
    const trigger=page.locator('.notification-bell-trigger');
    if(await trigger.getAttribute('aria-expanded')!=='true')await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded','true');
    await popover.locator('.notification-bell-all').click();
    const item=page.locator('[data-notification]').filter({hasText:'對你的貼文按讚'});
    await expect(item).toBeVisible();
    await item.getByRole('button',{name:'查看貼文',exact:true}).click();
    await expect(card).toBeFocused({timeout:15000});
  }finally{
    await e2eAuthPool.query("DELETE FROM community_social_posts WHERE note LIKE 'E2E 填充 %'");
  }
});
