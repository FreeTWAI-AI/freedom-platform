import {test,expect,type Page} from './fixtures.js';

const original='https://github.com/Hao0321/claude-skill-social-post';
const metrics={book_id:'social-post',repository_url:original,stargazers_count:127,forks_count:18,open_issues_count:4,subscribers_count:6,pushed_at:'2026-09-20T10:00:00Z',language:'TypeScript',archived:false,checked_at:'2026-09-23T10:00:00Z',stale:false,error:null};
async function login(page:Page,email='maker@local.test'){
  await page.goto('/');await page.getByLabel('電子郵件',{exact:true}).fill(email);await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
}
async function book(page:Page){
  await page.getByRole('button',{name:'自由工坊社群',exact:true}).click();
  const library=page.locator('.community-library');await library.getByLabel('搜尋技能書',{exact:true}).fill('社群貼文');
  const card=library.locator('article[data-book-id="social-post"]');await card.scrollIntoViewIfNeeded();return card;
}

test('visible book widgets share actual metrics and confirmed Star state across cards and dialogs',async({page})=>{
  let accounts=0,starReads=0,starred=false;const reads=new Map<string,number>(),writes:{starred:boolean;confirmed:boolean}[]=[];
  await page.route('**/api/v1/me/github',route=>{accounts++;return route.fulfill({json:{configured:true,connected:true,github_user:{id:'synthetic-owner',login:'synthetic-owner'}}});});
  await page.route('**/api/v1/github/books/*/metrics',route=>{const id=route.request().url().split('/').at(-2)!;reads.set(id,(reads.get(id)??0)+1);return route.fulfill({json:{...metrics,book_id:id}});});
  await page.route('**/api/v1/me/github/books/*/star',route=>{
    if(route.request().method()==='POST'){
      const body=route.request().postDataJSON();writes.push(body);expect(route.request().headers()['x-csrf-token']).toBeTruthy();expect(route.request().headers()['idempotency-key']).toBeTruthy();starred=body.starred;
    }else if(route.request().url().includes('/social-post/'))starReads++;
    return route.fulfill({json:{book_id:'social-post',starred,connected:true,confirmed:true}});
  });
  await login(page);
  // All guild dialogs exist in the DOM, but closed dialogs must not contact GitHub.
  await page.getByRole('button',{name:'職業公會',exact:true}).click();await expect(page.getByRole('button',{name:'供應端工作台',exact:true})).toBeVisible();expect(reads.size).toBe(0);
  const card=await book(page),widget=card.locator('.github-book-social');
  await expect(widget.getByRole('button',{name:'Star',exact:true})).toBeEnabled();
  await expect(widget.locator('dd')).toHaveText(['127','18','4','6','2026/9/20']);
  await expect(widget.getByRole('link',{name:'原作者 GitHub ↗',exact:true})).toHaveAttribute('href',original);
  await expect(widget.getByRole('link',{name:'Fork 專案 ↗',exact:true})).toHaveAttribute('href',`${original}/fork`);
  expect(accounts).toBe(1);expect(reads.get('social-post')).toBe(1);expect(reads.size).toBeLessThan(22);
  await card.getByRole('button',{name:'閱讀技能書',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Hao 社群貼文技能書',exact:true});
  await expect(modal.getByRole('button',{name:'Star',exact:true})).toBeEnabled();expect(starReads).toBe(1);expect(reads.get('social-post')).toBe(1);
  await modal.getByRole('button',{name:'Star',exact:true}).click();await expect(modal.getByRole('button',{name:'取消 Star',exact:true})).toHaveAttribute('aria-pressed','true');
  // The provider's public count still says 127; a local click must not invent 128.
  await expect(modal.locator('.github-book-metrics dd').first()).toHaveText('127');
  await page.keyboard.press('Escape');await expect(widget.getByRole('button',{name:'取消 Star',exact:true})).toBeVisible();
  await widget.getByRole('button',{name:'取消 Star',exact:true}).click();await expect(widget.getByRole('button',{name:'Star',exact:true})).toHaveAttribute('aria-pressed','false');
  expect(writes).toEqual([{starred:true,confirmed:true},{starred:false,confirmed:true}]);
  await page.setViewportSize({width:320,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('unconfigured and unavailable GitHub states never fabricate counts or offer a fake connection',async({page})=>{
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:false,connected:false,github_user:null}}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:{...metrics,stargazers_count:null,forks_count:null,open_issues_count:null,subscribers_count:null,pushed_at:null,language:null,checked_at:null,error:'github_unavailable'}}));
  await login(page);const card=await book(page);
  await expect(card.getByRole('button',{name:'GitHub 連結尚未啟用',exact:true})).toBeDisabled();
  await expect(card.locator('.github-book-metrics dd')).toHaveText(['—','—','—','—','—']);
  await expect(card.getByText('GitHub 數據暫時無法讀取',{exact:true})).toBeVisible();
  await expect(card.getByRole('button',{name:'重讀數據',exact:true})).toBeEnabled();
});

test('GitHub connect navigates to real authorization and returning never stars automatically',async({page})=>{
  let connected=false,starWrites=0;const connects:unknown[]=[];
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:true,connected,github_user:connected?{id:'synthetic-link',login:'synthetic-link'}:null}}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:metrics}));
  await page.route('**/api/v1/me/github/books/*/star',route=>{if(route.request().method()==='POST')starWrites++;return route.fulfill({json:{book_id:'social-post',starred:false,connected}});});
  await page.route('**/api/v1/me/github/connect',route=>{connects.push(route.request().postDataJSON());expect(route.request().headers()['x-csrf-token']).toBeTruthy();return route.fulfill({json:{authorization_url:'https://github.com/login/oauth/authorize?client_id=synthetic-test-client&state=synthetic-test-state'}});});
  await page.route('https://github.com/login/oauth/authorize?*',route=>route.fulfill({contentType:'text/html',body:'<p>Synthetic authorization page</p>'}));
  await login(page);const card=await book(page);await card.getByRole('button',{name:'連結 GitHub 後 Star',exact:true}).click();
  await expect(page).toHaveURL(/^https:\/\/github\.com\/login\/oauth\/authorize\?/);expect(connects).toEqual([{return_to:'#community'}]);expect(starWrites).toBe(0);
  connected=true;await page.goto('/#community');const returned=await book(page);await expect(returned.getByRole('button',{name:'Star',exact:true})).toBeEnabled();expect(starWrites).toBe(0);
});

test('failed GitHub reads and writes preserve platform login and private state does not cross member sessions',async({page})=>{
  let brokenRead=true,member='first',starred=false;
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:true,connected:true,github_user:{id:member,login:`synthetic-${member}`}}}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:{...metrics,stale:true}}));
  await page.route('**/api/v1/me/github/books/*/star',route=>{
    if(route.request().method()==='POST')return route.fulfill({status:503,json:{detail:'GitHub 暫時無法回應。'}});
    if(brokenRead)return route.fulfill({status:401,json:{detail:'GitHub 連結需要重新確認。'}});
    return route.fulfill({json:{book_id:'social-post',starred,connected:true}});
  });
  await login(page);const card=await book(page);await expect(card.getByRole('alert')).toContainText('GitHub 連結需要重新確認');await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
  await expect(card.getByText(/上次取得的數據/)).toBeVisible();
  brokenRead=false;await card.getByRole('button',{name:'重讀 Star 狀態',exact:true}).click();await expect(card.getByRole('button',{name:'Star',exact:true})).toBeEnabled();
  await card.getByRole('button',{name:'Star',exact:true}).click();await expect(card.getByRole('alert')).toContainText('Star 操作未確認');await expect(card.getByRole('button',{name:'Star',exact:true})).toHaveAttribute('aria-pressed','false');await expect(card.locator('.github-book-metrics dd').first()).toHaveText('127');
  starred=true;await card.getByRole('button',{name:'重讀 Star 狀態',exact:true}).click();await expect(card.getByRole('button',{name:'取消 Star',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'登出',exact:true}).click();member='second';starred=false;await login(page,'client@local.test');const second=await book(page);await expect(second.getByRole('button',{name:'Star',exact:true})).toHaveAttribute('aria-pressed','false');await expect(second.getByRole('button',{name:'取消 Star',exact:true})).toHaveCount(0);
});

test('account disconnect clears shared Star state and distinguishes local removal from GitHub grant revocation',async({page})=>{
  let connected=true;
  await page.route('**/api/v1/me/github',route=>route.fulfill({json:{configured:true,connected,github_user:connected?{id:'synthetic-owner',login:'synthetic-owner'}:null}}));
  await page.route('**/api/v1/github/books/*/metrics',route=>route.fulfill({json:metrics}));
  await page.route('**/api/v1/me/github/books/*/star',route=>route.fulfill({json:{book_id:'social-post',starred:true,connected}}));
  await page.route('**/api/v1/me/github/disconnect',route=>{expect(route.request().method()).toBe('POST');expect(route.request().headers()['x-csrf-token']).toBeTruthy();connected=false;return route.fulfill({json:{connected:false,provider_revoked:false}});});
  await login(page);const card=await book(page);await expect(card.getByRole('button',{name:'取消 Star',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'我的名片',exact:true}).click();const panel=page.locator('.github-connection-panel');
  await expect(panel).toContainText('@synthetic-owner');await panel.getByRole('button',{name:'解除 GitHub 連結',exact:true}).click();
  await expect(panel.getByRole('status')).toContainText('已解除工坊連結；可到 GitHub 設定撤銷授權。');
  await expect(panel.getByRole('link',{name:'GitHub 授權設定 ↗',exact:true})).toHaveAttribute('href','https://github.com/settings/apps/authorizations');
  await expect(panel.getByRole('button',{name:'連結 GitHub',exact:true})).toBeEnabled();
  const disconnected=await book(page);await expect(disconnected.getByRole('button',{name:'連結 GitHub 後 Star',exact:true})).toBeEnabled();await expect(disconnected.getByRole('button',{name:'取消 Star',exact:true})).toHaveCount(0);
});
