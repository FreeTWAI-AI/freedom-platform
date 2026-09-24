import {expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:15000});

/** Read-only HTTPS checks. The caller supplies its own authenticated request context. */
export async function verifyMemberSettings(page,{navigate,get,emptyInbox=false}) {
  const read=async path=>{
    const response=await get(path);
    expect(response.status(),path).toBe(200);
    return response.json();
  };
  const [github,notifications,conversations]=await Promise.all([
    read('/me/github'),read('/me/notifications?limit=20&offset=0'),read('/me/conversations?limit=20&offset=0'),
  ]);
  for(const inbox of [notifications,conversations]) {
    expect(Array.isArray(inbox.items)).toBe(true);
    expect(Number.isInteger(inbox.unread_count)&&inbox.unread_count>=0).toBe(true);
    if(emptyInbox)expect(inbox).toMatchObject({items:[],unread_count:0,next_offset:null});
  }
  for(const width of [1440,320]) {
    await page.setViewportSize({width,height:844});
    const settings=page.getByRole('button',{name:'設定',exact:true});
    if(await settings.getAttribute('aria-expanded')!=='true')await settings.click();
    const menu=page.getByRole('menu',{name:'設定',exact:true});
    await expect(menu.getByRole('menuitem')).toHaveCount(3);
    for(const [index,name] of ['我的名片','待辦清單','我的訊息'].entries())await expect(menu.getByRole('menuitem').nth(index)).toHaveAccessibleName(name);
    const box=await menu.boundingBox();
    expect(box&&box.x>=0&&box.x+box.width<=width,'Settings menu fits the viewport').toBe(true);
    await page.keyboard.press('Escape');await expect(settings).toBeFocused();
    await navigate(page,'待辦清單');
    await expect(page.getByRole('heading',{name:'待辦清單',level:1,exact:true})).toBeVisible();
    await expect(page.locator('[data-task="github"]')).toHaveAttribute('data-task-state',github.connected?'done':github.configured?'todo':'unavailable');
    await navigate(page,'我的訊息');
    await expect(page.getByRole('heading',{name:'我的訊息',level:1,exact:true})).toBeVisible();
    const notificationTab=page.getByRole('tab',{name:/^通知/});
    await expect(notificationTab).toContainText(notifications.unread_count?`${notifications.unread_count} 則未讀`:'沒有未讀');
    if(emptyInbox)await expect(page.getByText('目前沒有通知。',{exact:true})).toBeVisible();
    const directTab=page.getByRole('tab',{name:/^私訊/});
    await directTab.click();
    await expect(directTab).toContainText(conversations.unread_count?`${conversations.unread_count} 則未讀`:'沒有未讀');
    await expect(page.getByRole('heading',{level:1})).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Personal pages fit the viewport').toBe(true);
  }
}
