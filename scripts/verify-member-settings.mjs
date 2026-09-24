import {expect as baseExpect} from '@playwright/test';
const expect=baseExpect.configure({timeout:15000});

/** Read-only HTTPS checks. The caller supplies its own authenticated request context. */
export async function verifyMemberSettings(page,{navigate,get,emptyInbox=false}) {
  const read=async path=>{
    const response=await get(path);
    expect(response.status(),path).toBe(200);
    return response.json();
  };
  const [github,notifications,conversations,guildChannels,squadChannels]=await Promise.all([
    read('/me/github'),read('/me/notifications?limit=20&offset=0'),read('/me/conversations?limit=20&offset=0'),
    read('/me/channels?kind=guild&limit=20&offset=0'),read('/me/channels?kind=squad&limit=20&offset=0'),
  ]);
  for(const inbox of [notifications,conversations]) {
    expect(Array.isArray(inbox.items)).toBe(true);
    expect(Number.isInteger(inbox.unread_count)&&inbox.unread_count>=0).toBe(true);
    if(emptyInbox)expect(inbox).toMatchObject({items:[],unread_count:0,next_offset:null});
  }
  for(const channels of [guildChannels,squadChannels]) {
    expect(Array.isArray(channels.items)).toBe(true);
    expect(Number.isInteger(channels.unread_count)&&channels.unread_count>=0).toBe(true);
  }
  // Checking the available channel list must not fetch conversations or write to real channels.
  const channelContentRequests=[];
  const track=request=>{if(/\/api\/v1\/me\/channels\/(guild|squad)\/[^/]+\/(messages|read)$/.test(new URL(request.url()).pathname))channelContentRequests.push(request.method());};
  page.on('request',track);
  try {
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
    const tabs=page.getByRole('tablist',{name:'訊息類型'}).getByRole('tab');
    await expect(tabs).toHaveCount(4);
    for(const [index,name] of ['通知','公會閒聊','小隊閒聊','私人訊息'].entries())await expect(tabs.nth(index)).toHaveAccessibleName(new RegExp('^'+name));
    const notificationTab=page.getByRole('tab',{name:/^通知/});
    await expect(notificationTab).toContainText(notifications.unread_count?`${notifications.unread_count} 則未讀`:'沒有未讀');
    if(emptyInbox)await expect(page.getByText('目前沒有通知。',{exact:true})).toBeVisible();
    for(const [label,channels] of [['公會閒聊',guildChannels],['小隊閒聊',squadChannels]]) {
      const tab=page.getByRole('tab',{name:new RegExp('^'+label)});
      await tab.click();await expect(tab).toHaveAttribute('aria-selected','true');
      await expect(tab).toContainText(/沒有未讀|\d+ 則未讀/);
      const panel=page.getByRole('tabpanel',{name:new RegExp('^'+label)});
      const items=panel.locator('.member-channel-list button[data-channel-key]');
      await expect(items).toHaveCount(channels.items.length);
      expect(await items.evaluateAll(nodes=>nodes.map(node=>node.getAttribute('data-channel-key')).sort())).toEqual(channels.items.map(item=>item.channel_key).sort());
      await expect(panel.getByRole('alert')).toHaveCount(0);
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Channel list fits the viewport').toBe(true);
    }
    const directTab=page.getByRole('tab',{name:/^私人訊息/});
    await directTab.click();
    await expect(directTab).toContainText(conversations.unread_count?`${conversations.unread_count} 則未讀`:'沒有未讀');
    await expect(page.getByRole('heading',{level:1})).toHaveCount(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'Personal pages fit the viewport').toBe(true);
  }
  expect(channelContentRequests,'Listing channels never loads chat history or writes').toEqual([]);
  } finally {page.off('request',track);}
}
