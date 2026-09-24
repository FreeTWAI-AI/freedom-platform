import {mkdirSync} from 'node:fs';
import {test,expect,type Page} from './fixtures.js';

// Synthetic data only, served by route fixtures that follow the backend channel DTO. The real
// API is covered by tests/e2e/member-channels-real.spec.ts; these cases pin the UI boundaries.
const SHOTS='/tmp/freedom-member-channels-ui-shots';
type Kind='guild'|'squad';
type Message={message_id:string;kind:Kind;channel_key:string;sequence:string;sender_ref:string;sender_name:string;body:string;created_at:string};
type Channel={kind:Kind;key:string;name:string;member:boolean;denied:403|404;messages:Message[];read:bigint};
type What='list'|'history'|'send'|'read';
type Info={kind:Kind;key?:string;limit:number;offset:number};
const other='30000000-0000-4000-8000-00000000000a';
const squadA='40000000-0000-4000-8000-00000000000a',squadB='40000000-0000-4000-8000-00000000000b';
// Past Number.MAX_SAFE_INTEGER, so ordering by Number would collapse neighbours.
let sequence=9007199254740990n;

test.beforeEach(async({page})=>{
  await page.route(url=>!['127.0.0.1','localhost'].includes(url.hostname),route=>route.abort());
  await page.route('**/api/v1/me/skill-books',route=>route.fulfill({json:{items:[]}}));
  await page.route(/\/api\/v1\/me\/(notifications|conversations)(\?.*)?$/,route=>route.fulfill({json:{items:[],unread_count:0,next_offset:null}}));
});

async function channelServer(page:Page,setup:{guild?:[string,string,number][];squad?:[string,string,number][]}){
  const me={id:''},store=new Map<string,Channel>();
  const log={lists:[] as Info[],history:[] as Info[],sends:[] as {key:string;body:string;idempotency:string;csrf:string;ifMatch?:string}[],reads:[] as {key:string;through:string;idempotency:string;csrf:string}[]};
  const control:{fail?:(what:What,info:Info)=>'500'|'503'|'403'|'404'|'abort'|undefined;gate?:(what:What,info:Info)=>Promise<void>|undefined}={};
  const message=(channel:Channel,body:string,sender=other,name='合成夥伴'):Message=>{
    sequence++;return {message_id:`${channel.key}-m${sequence}`,kind:channel.kind,channel_key:channel.key,sequence:String(sequence),sender_ref:sender,sender_name:name,body,created_at:new Date(Date.UTC(2026,8,24,1,0,Number(sequence%3600n))).toISOString()};
  };
  const add=(kind:Kind,key:string,name:string,count:number)=>{
    const channel:Channel={kind,key,name,member:true,denied:404,messages:[],read:0n};
    for(let n=1;n<=count;n++)channel.messages.unshift(message(channel,`${name} 合成訊息 ${n}`));
    store.set(`${kind}:${key}`,channel);return channel;
  };
  for(const [key,name,count] of setup.guild??[])add('guild',key,name,count);
  for(const [key,name,count] of setup.squad??[])add('squad',key,name,count);
  const unread=(channel:Channel)=>channel.messages.filter(item=>BigInt(item.sequence)>channel.read&&item.sender_ref!==me.id).length;
  const get=(kind:Kind,key:string)=>store.get(`${kind}:${key}`)!;
  await page.route(/\/api\/v1\/me\/channels(\?|\/)/,async route=>{
    const request=route.request(),url=new URL(request.url()),parts=url.pathname.split('/').slice(4);
    const limit=Number(url.searchParams.get('limit')??20),offset=Number(url.searchParams.get('offset')??0);
    const answer=async(what:What,info:Info,json:unknown,status=200)=>{
      const outcome=control.fail?.(what,info);
      await control.gate?.(what,info);
      if(outcome==='abort')return route.abort();
      if(outcome==='500'||outcome==='503')return route.fulfill({status:Number(outcome),json:{title:'合成故障'}});
      if(outcome==='403'||outcome==='404')return route.fulfill({status:Number(outcome),json:{title:'頻道無法使用',code:'channel_not_available'}});
      return route.fulfill({status,json});
    };
    if(parts.length===1){
      const kind=url.searchParams.get('kind') as Kind,info={kind,limit,offset};log.lists.push(info);
      const all=[...store.values()].filter(item=>item.kind===kind&&item.member);
      // The snapshot is taken on arrival; a held answer is the old state.
      return answer('list',info,{items:all.slice(offset,offset+limit).map(item=>({kind,channel_key:item.key,name:item.name,unread_count:unread(item),last_message_at:item.messages[0]?.created_at??null})),
        unread_count:all.reduce((sum,item)=>sum+unread(item),0),next_offset:offset+limit<all.length?offset+limit:null});
    }
    const kind=parts[1] as Kind,key=decodeURIComponent(parts[2]),channel=store.get(`${kind}:${key}`),info={kind,key,limit,offset};
    const denied=()=>route.fulfill({status:channel?.denied??404,json:{title:'頻道無法使用',code:'channel_not_available'}});
    if(parts[3]==='messages'&&request.method()==='GET'){
      log.history.push(info);
      if(!channel?.member)return denied();
      return answer('history',info,{channel:{kind,channel_key:key,name:channel.name},items:channel.messages.slice(offset,offset+limit).map(item=>({...item})),unread_count:unread(channel),next_offset:offset+limit<channel.messages.length?offset+limit:null});
    }
    const headers=request.headers();
    if(parts[3]==='messages'&&request.method()==='POST'){
      const body=request.postDataJSON().body as string;
      log.sends.push({key,body,idempotency:headers['idempotency-key'],csrf:headers['x-csrf-token'],ifMatch:headers['if-match']});
      if(!channel?.member)return denied();
      const outcome=control.fail?.('send',info);
      let sent=channel.messages.find(item=>item.message_id===`sent-${headers['idempotency-key']}`);
      if(!sent&&outcome!=='abort'){sent={...message(channel,body,me.id,'我'),message_id:`sent-${headers['idempotency-key']}`};channel.messages.unshift(sent);}
      await control.gate?.('send',info);
      if(outcome==='abort')return route.abort();
      // '500' commits the message but loses the response, like a proxy failure after the write.
      if(outcome==='500')return route.fulfill({status:500,json:{}});
      return route.fulfill({status:201,json:sent});
    }
    if(parts[3]==='read'){
      const through=request.postDataJSON().through_message_id as string;
      log.reads.push({key,through,idempotency:headers['idempotency-key'],csrf:headers['x-csrf-token']});
      if(!channel?.member)return denied();
      const target=channel.messages.find(item=>item.message_id===through)!;
      if(BigInt(target.sequence)>channel.read)channel.read=BigInt(target.sequence);
      return answer('read',info,{kind,channel_key:key,read_sequence:String(channel.read),read_at:'2026-09-24T10:00:00Z'});
    }
    return route.fulfill({status:404,json:{}});
  });
  return {me,store,log,control,get,message};
}

async function login(page:Page,hash:string){
  await page.goto('/'+hash);
  await page.getByLabel('電子郵件',{exact:true}).fill('maker@local.test');await page.getByLabel('密碼',{exact:true}).fill('freedom-local-demo');
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'登出',exact:true})).toBeVisible();
  return (await (await page.request.get('/api/v1/session')).json()).user.user_id as string;
}
async function open(page:Page,server:{me:{id:string}},hash='#messages'){server.me.id=await login(page,hash);}
const tab=(page:Page,name:string)=>page.getByRole('tab',{name:new RegExp(`^${name}`)});
const panel=(page:Page,name:string)=>page.getByRole('tabpanel',{name:new RegExp(`^${name}`)});
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function shot(page:Page,name:string){mkdirSync(SHOTS,{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${SHOTS}/${name}.png`,fullPage:true,animations:'disabled'});}
/** Holds matching answers after their snapshot is taken, like a slow server. */
function holder(){
  const held:(()=>void)[]=[];
  return {held,wait:()=>new Promise<void>(resolve=>held.push(resolve)),release:()=>held.splice(0).forEach(done=>done())};
}

test('four tabs keep their exact order and keyboard behaviour, and only list channels until one is chosen',async({page})=>{
  await page.setViewportSize({width:320,height:780});
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3],['Makers','合成公會乙',0]],squad:[[squadA,'合成小隊甲',2]]});
  const bodies:string[]=[];page.on('request',request=>{if(/\/me\/channels\/(guild|squad)\//.test(request.url()))bodies.push(request.url());});
  await open(page,server);
  const tabs=page.getByRole('tab');
  await expect(tabs).toHaveCount(4);
  const labels=['通知','公會閒聊','小隊閒聊','私人訊息'];
  for(const [index,label] of labels.entries())await expect(tabs.nth(index)).toHaveText(new RegExp(`^${label}`));
  await expect(tab(page,'公會閒聊')).toContainText('3 則未讀');await expect(tab(page,'小隊閒聊')).toContainText('2 則未讀');
  await expect(tab(page,'私人訊息')).toContainText('沒有未讀');await expect(tab(page,'通知')).toContainText('沒有未讀');
  // Roving tabindex, arrow keys wrap, Home/End jump; each tab controls its own panel.
  await tab(page,'通知').focus();
  const expectSelected=async(label:string)=>{
    const current=tab(page,label);
    await expect(current).toBeFocused();await expect(current).toHaveAttribute('aria-selected','true');await expect(current).toHaveAttribute('tabindex','0');
    await expect(page.locator('#'+await current.getAttribute('aria-controls'))).toBeVisible();
    for(const name of labels.filter(item=>item!==label)){await expect(tab(page,name)).toHaveAttribute('aria-selected','false');await expect(tab(page,name)).toHaveAttribute('tabindex','-1');}
  };
  for(const label of ['公會閒聊','小隊閒聊','私人訊息','通知']){await page.keyboard.press('ArrowRight');await expectSelected(label);}
  await page.keyboard.press('ArrowLeft');await expectSelected('私人訊息');
  await page.keyboard.press('ArrowLeft');await expectSelected('小隊閒聊');
  await page.keyboard.press('Home');await expectSelected('通知');
  await page.keyboard.press('End');await expectSelected('私人訊息');
  // The top bar still owns the only h1.
  await expect(page.getByRole('heading',{level:1})).toHaveCount(1);await expect(page.getByRole('heading',{level:1})).toHaveText('我的訊息');
  for(const label of labels){
    await tab(page,label).click();await noOverflow(page);
    const box=(await tab(page,label).boundingBox())!;expect(box.height).toBeGreaterThanOrEqual(44);expect(box.x+box.width).toBeLessThanOrEqual(320);
  }
  await tab(page,'公會閒聊').click();
  const guilds=panel(page,'公會閒聊').locator('.member-channel-list');
  await expect(guilds.locator('[data-channel-key]')).toHaveCount(2);
  await expect(guilds.getByRole('button',{name:'合成公會甲',exact:true})).toHaveAttribute('data-channel-key','builders');
  await expect(guilds.getByRole('button',{name:'合成公會乙',exact:true})).toHaveAttribute('data-channel-key','Makers');
  await expect(guilds.getByRole('button',{name:'合成公會甲',exact:true})).toContainText('3 則未讀');
  for(const item of await guilds.getByRole('button').all())expect((await item.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  for(const selector of ['.messages-meta','.messages-count','.muted'])expect(await panel(page,'公會閒聊').locator(selector).first().evaluate(node=>parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(14);
  // Window focus re-checks the lists, but nothing opened a channel, so no history was read.
  const lists=server.log.lists.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>server.log.lists.length).toBeGreaterThan(lists);
  await tab(page,'小隊閒聊').click();await expect(panel(page,'小隊閒聊').locator('[data-channel-key]')).toHaveCount(1);
  await tab(page,'公會閒聊').click();await noOverflow(page);await shot(page,'4tabs-320');
  expect(server.log.history).toEqual([]);expect(bodies).toEqual([]);expect(server.log.reads).toEqual([]);
});

test('guild lists page and retry, history opens only on selection, and reads mark only what was shown',async({page})=>{
  const guilds=Array.from({length:22},(_,i):[string,string,number]=>[`guild-${String(i+1).padStart(2,'0')}`,`合成公會 ${String(i+1).padStart(2,'0')}`,i===0?25:0]);
  const server=await channelServer(page,{guild:guilds});
  let listFailures=1,moreFailures=1,earlierFailures=1;
  server.control.fail=(what,info)=>{
    if(what==='list'&&info.limit>1&&info.offset===0&&info.kind==='guild'&&listFailures-->0)return '500';
    if(what==='list'&&info.offset===20&&moreFailures-->0)return 'abort';
    if(what==='history'&&info.offset===20&&earlierFailures-->0)return '500';
  };
  await page.setViewportSize({width:1280,height:900});
  await open(page,server);
  await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),list=guild.locator('.member-channel-list');
  // A failed list is an error with retry, not an empty list and not zero.
  await expect(guild.getByRole('alert')).toContainText('公會頻道讀取失敗');await expect(guild.getByText(/還沒有加入任何公會/)).toHaveCount(0);
  await expect(tab(page,'公會閒聊')).toContainText('未讀數未確認');
  await guild.getByRole('button',{name:'重新讀取公會頻道',exact:true}).click();
  await expect(list.locator('[data-channel-key]')).toHaveCount(20);await expect(tab(page,'公會閒聊')).toContainText('25 則未讀');
  await guild.getByRole('button',{name:'載入更多公會頻道',exact:true}).click();
  await expect(guild.getByRole('alert')).toContainText('更多公會頻道讀取失敗');await expect(list.locator('[data-channel-key]')).toHaveCount(20);
  await guild.getByRole('button',{name:'重試載入更多公會頻道',exact:true}).click();
  await expect(list.locator('[data-channel-key]')).toHaveCount(22);await expect(guild.getByRole('button',{name:/載入更多公會頻道/})).toHaveCount(0);
  expect(server.log.history).toEqual([]);

  await list.getByRole('button',{name:'合成公會 01',exact:true}).click();
  const thread=guild.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  await expect(thread.getByRole('heading',{name:'合成公會 01・公會閒聊'})).toBeFocused();
  await expect(list.getByRole('button',{name:'合成公會 01',exact:true})).toHaveAttribute('aria-current','true');
  // Oldest of the loaded page first; big sequences keep their order.
  await expect(bubbles).toHaveCount(20);await expect(bubbles.first()).toHaveText('合成公會 01 合成訊息 6');await expect(bubbles.last()).toHaveText('合成公會 01 合成訊息 25');
  await thread.getByRole('button',{name:'載入較早訊息',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('較早訊息讀取失敗');await expect(bubbles).toHaveCount(20);
  await thread.getByRole('button',{name:'重試載入較早訊息',exact:true}).click();
  await expect(bubbles).toHaveCount(25);await expect(bubbles.first()).toHaveText('合成公會 01 合成訊息 1');
  await expect(thread.getByRole('button',{name:/載入較早訊息/})).toHaveCount(0);
  expect(server.log.history.map(item=>item.key)).toEqual(['guild-01','guild-01','guild-01']);
  // Opening is not reading.
  expect(server.log.reads).toEqual([]);
  const channel=server.get('guild','guild-01'),shownNewest=channel.messages[0].message_id;
  // A message arrives after the page was drawn: the read covers only what the member saw.
  channel.messages.unshift(server.message(channel,'畫面之後才到的合成訊息'));
  await thread.getByRole('button',{name:'標為已讀',exact:true}).click();
  await expect(thread.getByRole('note')).toContainText('還有 1 則較新的未讀訊息');
  expect(server.log.reads.map(item=>item.through)).toEqual([shownNewest]);expect(server.log.reads[0].csrf).toBeTruthy();expect(server.log.reads[0].idempotency).toBeTruthy();
  await expect(tab(page,'公會閒聊')).toContainText('1 則未讀');await expect(list.getByRole('button',{name:'合成公會 01',exact:true})).toContainText('1 則未讀');
  await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  await expect(bubbles.last()).toHaveText('畫面之後才到的合成訊息');
  await thread.getByRole('button',{name:'標為已讀',exact:true}).click();
  await expect(tab(page,'公會閒聊')).toContainText('沒有未讀');await expect(thread.getByRole('button',{name:/標為已讀/})).toHaveCount(0);
  await expect(thread.getByRole('note')).toHaveCount(0);
  expect(server.log.reads.map(item=>item.through)).toEqual([shownNewest,channel.messages[0].message_id]);
  await noOverflow(page);await shot(page,'guild-desktop');
});

test('an empty guild or squad membership offers the real page instead of a made-up channel',async({page})=>{
  const server=await channelServer(page,{});
  await open(page,server);
  await tab(page,'公會閒聊').click();
  await expect(panel(page,'公會閒聊').getByText('你還沒有加入任何公會，加入後會出現該公會的閒聊頻道。')).toBeVisible();
  await expect(panel(page,'公會閒聊').locator('[data-channel-key]')).toHaveCount(0);await expect(tab(page,'公會閒聊')).toContainText('沒有未讀');
  await tab(page,'小隊閒聊').click();
  await expect(panel(page,'小隊閒聊').getByText('你還沒有加入任何小隊，加入後會出現該小隊的閒聊頻道。')).toBeVisible();
  await panel(page,'小隊閒聊').getByRole('button',{name:'前往小隊集合',exact:true}).click();await expect(page).toHaveURL(/#squads$/);
  await page.goBack();await expect(page).toHaveURL(/#messages$/);
  await tab(page,'公會閒聊').click();await panel(page,'公會閒聊').getByRole('button',{name:'前往職業公會',exact:true}).click();await expect(page).toHaveURL(/#guilds$/);
  expect(server.log.history).toEqual([]);
});

test('sending is plain text, retries an unknown result once, and never lets an older re-read undo it',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',2],['Makers','合成公會乙',1]],squad:[[squadA,'合成小隊甲',1]]});
  const outcomes:('abort'|'500'|undefined)[]=[];const hold=holder();let holding=false;
  server.control.fail=what=>what==='send'?outcomes.shift():undefined;
  server.control.gate=(what,info)=>holding&&what==='history'&&info.limit>1?hold.wait():undefined;
  await open(page,server);await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();
  const box=thread.getByLabel('在 合成公會甲 發言');
  expect(await box.evaluate(node=>parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  outcomes.push('abort');
  await box.fill('  <b>純文字</b> 你好  ');await thread.getByRole('button',{name:'送出',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');await expect(box).toHaveValue('  <b>純文字</b> 你好  ');
  // Re-reading keeps the unconfirmed attempt, so the retry still deduplicates.
  await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();await expect(box).toHaveValue('  <b>純文字</b> 你好  ');
  await thread.getByRole('button',{name:'重試送出',exact:true}).click();
  await expect(bubbles.last()).toHaveText('<b>純文字</b> 你好');await expect(thread.locator('.messages-bubbles b')).toHaveCount(0);await expect(box).toHaveValue('');
  expect(server.log.sends.map(({key,body,idempotency})=>({key,body,idempotency}))).toEqual([{key:'builders',body:'<b>純文字</b> 你好',idempotency:server.log.sends[0].idempotency},{key:'builders',body:'<b>純文字</b> 你好',idempotency:server.log.sends[0].idempotency}]);
  expect(server.log.sends.every(item=>item.csrf&&item.idempotency&&item.ifMatch===undefined)).toBe(true);
  await expect(thread.locator('.messages-bubbles li.is-mine')).toHaveCount(1);
  // A committed write whose answer was lost: the same text reuses its key; changed text is a new message.
  outcomes.push('500');await box.fill('第二則');await thread.getByRole('button',{name:'送出',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');
  await thread.getByRole('button',{name:'重試送出',exact:true}).click();await expect(box).toHaveValue('');
  expect(server.log.sends[3].idempotency).toBe(server.log.sends[2].idempotency);await expect(thread.getByText('第二則',{exact:true})).toHaveCount(1);
  outcomes.push('abort');await box.fill('原稿');await thread.getByRole('button',{name:'送出',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('傳送結果未確認');
  await box.fill('改稿');await expect(thread.getByRole('button',{name:'送出',exact:true})).toBeVisible();await thread.getByRole('button',{name:'送出',exact:true}).click();await expect(box).toHaveValue('');
  expect(server.log.sends.slice(4).map(item=>item.body)).toEqual(['原稿','改稿']);expect(server.log.sends[5].idempotency).not.toBe(server.log.sends[4].idempotency);
  // The limit counts code points: 2000 emoji are allowed, 2001 are not sent.
  const sendsBefore=server.log.sends.length;
  await box.fill('😀'.repeat(2001));await thread.getByRole('button',{name:'送出',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('訊息最多 2000 字');expect(server.log.sends.length).toBe(sendsBefore);
  await box.fill('😀'.repeat(2000));await expect(thread.getByText('2000／2000 字')).toBeVisible();
  await thread.getByRole('button',{name:'送出',exact:true}).click();await expect(box).toHaveValue('');expect(server.log.sends.length).toBe(sendsBefore+1);

  // A re-read that snapshots before a confirmed send answers late; the sent message stays.
  holding=true;await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();await expect.poll(()=>hold.held.length).toBe(1);holding=false;
  await box.fill('競態中的確認訊息');await thread.getByRole('button',{name:'送出',exact:true}).click();
  await expect(bubbles.last()).toHaveText('競態中的確認訊息');await box.fill('送出後的新草稿');
  hold.release();await expect(thread.getByRole('button',{name:'重新讀取訊息',exact:true})).toBeVisible();await page.waitForTimeout(200);
  await expect(bubbles.last()).toHaveText('競態中的確認訊息');await expect(box).toHaveValue('送出後的新草稿');

  // Drafts are kept per channel and across tabs.
  await guild.getByRole('button',{name:'合成公會乙',exact:true}).click();
  const boxB=thread.getByLabel('在 合成公會乙 發言');await expect(boxB).toHaveValue('');await boxB.fill('給乙的草稿');
  await tab(page,'小隊閒聊').click();await panel(page,'小隊閒聊').getByRole('button',{name:'合成小隊甲',exact:true}).click();
  const squadBox=panel(page,'小隊閒聊').getByLabel('在 合成小隊甲 發言');await expect(squadBox).toHaveValue('');await squadBox.fill('給小隊的草稿');
  await tab(page,'私人訊息').click();await tab(page,'公會閒聊').click();await expect(boxB).toHaveValue('給乙的草稿');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(box).toHaveValue('送出後的新草稿');
  await tab(page,'小隊閒聊').click();await expect(squadBox).toHaveValue('給小隊的草稿');
  // Case-preserving guild keys and squad UUIDs are sent as encoded path segments.
  expect(server.log.history.some(item=>item.kind==='guild'&&item.key==='Makers')).toBe(true);
  expect(server.log.history.some(item=>item.kind==='squad'&&item.key===squadA)).toBe(true);
});

test('switching channels ignores slow answers and never mixes guild, squad or private history',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3],['Makers','合成公會乙',0]],squad:[[squadA,'合成小隊甲',2],[squadB,'合成小隊乙',1]]});
  const hold=holder();server.control.gate=(what,info)=>what==='history'&&info.key==='builders'?hold.wait():undefined;
  await page.setViewportSize({width:320,height:780});
  await open(page,server);await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(thread.getByRole('status')).toHaveText('正在讀取訊息…');
  await guild.getByRole('button',{name:'合成公會乙',exact:true}).click();
  await expect(thread.getByRole('heading',{level:2})).toHaveText('合成公會乙・公會閒聊');await expect(thread.getByText('這個頻道還沒有訊息。')).toBeVisible();
  hold.release();server.control.gate=undefined;await page.waitForTimeout(300);
  await expect(thread.getByRole('heading',{level:2})).toHaveText('合成公會乙・公會閒聊');await expect(thread.getByText(/合成公會甲 合成訊息/)).toHaveCount(0);
  await expect(guild.getByRole('button',{name:'合成公會乙',exact:true})).toHaveAttribute('aria-current','true');
  // A slow answer for one squad does not land in another squad either.
  const squadHold=holder();server.control.gate=(what,info)=>what==='history'&&info.key===squadA?squadHold.wait():undefined;
  await tab(page,'小隊閒聊').click();
  const squad=panel(page,'小隊閒聊'),squadThread=squad.locator('.messages-thread');
  await expect(squadThread.getByRole('heading',{level:2})).toHaveText('小隊閒聊');await expect(squadThread.locator('.messages-bubbles')).toHaveCount(0);
  await squad.getByRole('button',{name:'合成小隊甲',exact:true}).click();await squad.getByRole('button',{name:'合成小隊乙',exact:true}).click();
  await expect(squadThread.locator('.messages-bubbles .messages-body')).toHaveText(['合成小隊乙 合成訊息 1']);
  squadHold.release();server.control.gate=undefined;await page.waitForTimeout(300);
  await expect(squadThread.locator('.messages-bubbles .messages-body')).toHaveText(['合成小隊乙 合成訊息 1']);
  await squad.getByRole('button',{name:'合成小隊甲',exact:true}).click();
  await expect(squadThread.locator('.messages-bubbles .messages-body')).toHaveText(['合成小隊甲 合成訊息 1','合成小隊甲 合成訊息 2']);
  await noOverflow(page);await shot(page,'squad-320');
  // Each panel holds only its own kind; the private panel holds none.
  await expect(squad.getByText(/合成公會/)).toHaveCount(0);await expect(guild.getByText(/合成小隊/)).toHaveCount(0);
  await expect(panel(page,'私人訊息').getByText(/合成(公會|小隊)/)).toHaveCount(0);
  await tab(page,'公會閒聊').click();await expect(thread.getByRole('heading',{level:2})).toHaveText('合成公會乙・公會閒聊');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(thread.locator('.messages-bubbles .messages-body')).toHaveCount(3);
  await noOverflow(page);await shot(page,'guild-320');
});

test('leaving a channel clears its history and composer at once, and a late answer cannot bring it back',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3],['Makers','合成公會乙',1]],squad:[[squadA,'合成小隊甲',2]]});
  const hold=holder();let holding=false;
  server.control.gate=(what,info)=>holding&&what==='history'&&info.limit>1?hold.wait():undefined;
  await page.setViewportSize({width:320,height:780});
  await open(page,server);await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(bubbles).toHaveCount(3);
  const box=thread.getByLabel('在 合成公會甲 發言');await box.fill('離會前的草稿');
  // A re-read snapshots the old history, then the member leaves before it answers.
  holding=true;await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();await expect.poll(()=>hold.held.length).toBe(1);holding=false;
  server.get('guild','builders').member=false;
  await thread.getByRole('button',{name:'送出',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');
  await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);await expect(thread.getByRole('button',{name:/送出|標為已讀|重新讀取訊息/})).toHaveCount(0);
  await expect(thread.getByRole('button',{name:'回到職業公會',exact:true})).toBeVisible();
  await expect(guild.getByRole('button',{name:'合成公會甲',exact:true})).toHaveCount(0);await expect(tab(page,'公會閒聊')).toContainText('1 則未讀');
  hold.release();await expect.poll(()=>hold.held.length).toBe(0);await page.waitForTimeout(300);
  await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);await expect(thread.getByText(/合成公會甲 合成訊息/)).toHaveCount(0);
  await noOverflow(page);await shot(page,'revoked-320');
  // A 403 on opening a squad is treated the same; nothing is kept for it.
  const squadChannel=server.get('squad',squadA);squadChannel.member=false;squadChannel.denied=403;
  await tab(page,'小隊閒聊').click();const squad=panel(page,'小隊閒聊');
  await squad.getByRole('button',{name:'合成小隊甲',exact:true}).click();
  await expect(squad.getByRole('alert')).toContainText('目前無法使用此頻道。');await expect(squad.locator('.messages-bubbles, textarea')).toHaveCount(0);
  await squad.getByRole('button',{name:'回到小隊集合',exact:true}).click();await expect(page).toHaveURL(/#squads$/);
  await page.goBack();await tab(page,'公會閒聊').click();
  await panel(page,'公會閒聊').getByRole('button',{name:'合成公會乙',exact:true}).click();await expect(panel(page,'公會閒聊').locator('.messages-bubbles .messages-body')).toHaveCount(1);
  await expect(panel(page,'公會閒聊').getByRole('button',{name:/職業公會/})).toHaveCount(0);
});

test('a list re-read that no longer has the open channel closes it, and a paged list checks before closing',async({page})=>{
  const guilds=Array.from({length:22},(_,i):[string,string,number]=>[`guild-${String(i+1).padStart(2,'0')}`,`合成公會 ${String(i+1).padStart(2,'0')}`,2]);
  const server=await channelServer(page,{guild:guilds});
  const hold=holder();let holding=false;
  server.control.gate=(what,info)=>holding&&what==='list'&&info.limit>1?hold.wait():undefined;
  await open(page,server);await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  await guild.getByRole('button',{name:'載入更多公會頻道',exact:true}).click();
  await guild.getByRole('button',{name:'合成公會 22',exact:true}).click();await expect(bubbles).toHaveCount(2);
  // The first page cannot prove the channel is gone: the open channel is checked on its own and stays.
  const before=server.log.history.length;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>server.log.history.length).toBe(before+1);expect(server.log.history.at(-1)).toMatchObject({key:'guild-22',limit:1});
  await page.waitForTimeout(200);await expect(bubbles).toHaveCount(2);await expect(thread.locator('textarea')).toHaveCount(1);
  // After leaving, the same check closes it.
  server.get('guild','guild-22').member=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);

  // A complete list without the open channel closes it without another history read.
  await guild.getByRole('button',{name:'合成公會 01',exact:true}).click();await expect(bubbles).toHaveCount(2);
  for(let n=3;n<=21;n++)server.get('guild',`guild-${String(n).padStart(2,'0')}`).member=false;
  server.get('guild','guild-01').member=false;
  const reads=server.log.history.length;
  await guild.getByRole('button',{name:'重新整理公會頻道',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');await expect(bubbles).toHaveCount(0);
  expect(server.log.history.length).toBe(reads);
  await expect(guild.locator('[data-channel-key]')).toHaveCount(1);

  // A list answer taken before the member left must not put the channel back.
  await guild.getByRole('button',{name:'合成公會 02',exact:true}).click();await expect(bubbles).toHaveCount(2);
  holding=true;await guild.getByRole('button',{name:'重新整理公會頻道',exact:true}).click();await expect.poll(()=>hold.held.length).toBe(1);holding=false;
  server.get('guild','guild-02').member=false;
  await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');
  hold.release();await expect.poll(()=>hold.held.length).toBe(0);await page.waitForTimeout(300);
  await expect(guild.locator('[data-channel-key]')).toHaveCount(0);await expect(bubbles).toHaveCount(0);
  await expect(guild.getByText('你還沒有加入任何公會，加入後會出現該公會的閒聊頻道。')).toBeVisible();
});

test('a confirmed read whose unread re-check fails says the count is unconfirmed and recovers by re-reading',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3]]});
  let checkFails=1;
  server.control.fail=(what,info)=>what==='history'&&info.limit===1&&checkFails-->0?'503':undefined;
  await open(page,server);await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(bubbles).toHaveCount(3);
  const box=thread.getByLabel('在 合成公會甲 發言');await box.fill('已讀後的草稿');
  const channel=server.get('guild','builders');
  // Arrives after the page was drawn, so the read cannot cover it.
  channel.messages.unshift(server.message(channel,'標記後才看到的合成訊息'));
  await thread.getByRole('button',{name:'標為已讀',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('已標為已讀，但目前未讀數未確認');
  await expect(thread.getByRole('alert')).not.toContainText('標為已讀未完成');
  await expect(thread.getByText('3 則未讀')).toHaveCount(0);await expect(thread.getByRole('button',{name:/標為已讀/})).toHaveCount(0);
  await expect(bubbles).toHaveCount(3);await expect(box).toHaveValue('已讀後的草稿');
  await thread.getByRole('alert').getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  await expect(bubbles.last()).toHaveText('標記後才看到的合成訊息');await expect(thread.getByRole('alert')).toHaveCount(0);
  // The newer message is still unread and only a new, explicit read covers it.
  await expect(thread.getByText('1 則未讀',{exact:true})).toBeVisible();await expect(box).toHaveValue('已讀後的草稿');
  expect(server.log.reads).toHaveLength(1);
});

test('re-reading the open channel also re-reads its tab and list unread totals without marking anything read',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',2]],squad:[[squadA,'合成小隊甲',0],[squadB,'合成小隊乙',0]]});
  await open(page,server);await tab(page,'小隊閒聊').click();
  const squad=panel(page,'小隊閒聊'),thread=squad.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  const button=squad.getByRole('button',{name:'合成小隊甲',exact:true});
  await button.click();await expect(thread.getByText('這個頻道還沒有訊息。')).toBeVisible();
  await expect(tab(page,'小隊閒聊')).toContainText('沒有未讀');await expect(button).not.toContainText('則未讀');
  const box=thread.getByLabel('在 合成小隊甲 發言');await box.fill('回覆前的草稿');
  // Another member replies while this one has the room open; no window focus follows.
  const channel=server.get('squad',squadA);channel.messages.unshift(server.message(channel,'夥伴剛回覆的合成訊息'));
  await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  await expect(bubbles).toHaveText(['夥伴剛回覆的合成訊息']);await expect(thread.getByText('1 則未讀',{exact:true})).toBeVisible();
  await expect(tab(page,'小隊閒聊')).toContainText('1 則未讀');await expect(button).toContainText('1 則未讀');
  await expect(squad.getByRole('button',{name:'合成小隊乙',exact:true})).not.toContainText('則未讀');
  await expect(box).toHaveValue('回覆前的草稿');expect(server.log.reads).toEqual([]);
  // The other kind and the private tab keep their own totals.
  await expect(tab(page,'公會閒聊')).toContainText('2 則未讀');await expect(tab(page,'私人訊息')).toContainText('沒有未讀');
  await expect(squad.getByText(/合成公會/)).toHaveCount(0);await expect(panel(page,'私人訊息').getByText(/合成(公會|小隊)/)).toHaveCount(0);
  expect(server.log.history.filter(item=>item.kind==='guild')).toEqual([]);
});

test('a list refresh refused with 403 or 404 closes the open channel without reviving it or looping',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3]],squad:[[squadA,'合成小隊甲',2]]});
  const hold=holder();let holding=false,refuse:'403'|'404'|undefined;
  server.control.fail=(what,info)=>what==='list'&&info.limit>1?refuse:undefined;
  server.control.gate=(what,info)=>holding&&what==='history'&&info.limit>1?hold.wait():undefined;
  await open(page,server);
  for(const [name,unit,channelName,status] of [['公會閒聊','公會','合成公會甲','403'],['小隊閒聊','小隊','合成小隊甲','404']] as const){
    await tab(page,name).click();
    const scope=panel(page,name),thread=scope.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
    await scope.getByRole('button',{name:channelName,exact:true}).click();await expect(bubbles).not.toHaveCount(0);
    await thread.locator('textarea').fill('被拒前的草稿');
    // A re-read already out must not bring the history back after the refusal.
    holding=true;await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();await expect.poll(()=>hold.held.length).toBe(1);holding=false;
    refuse=status;const lists=server.log.lists.length;
    await scope.getByRole('button',{name:`重新整理${unit}頻道`,exact:true}).click();
    await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');
    await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);
    await expect(thread.getByRole('button',{name:unit==='公會'?'回到職業公會':'回到小隊集合',exact:true})).toBeVisible();
    hold.release();await expect.poll(()=>hold.held.length).toBe(0);await page.waitForTimeout(300);
    await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);
    expect(server.log.lists.slice(lists).filter(info=>info.limit>1)).toHaveLength(1);
    refuse=undefined;
  }
});

test('the settings menu adds all four unread sources and shows one failed source as unconfirmed',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3]],squad:[[squadA,'合成小隊甲',4]]});
  let squadFails=false;
  server.control.fail=(what,info)=>what==='list'&&info.kind==='squad'&&info.limit===1&&squadFails?'500':undefined;
  await page.route(/\/api\/v1\/me\/notifications\?limit=1&offset=0$/,route=>route.fulfill({json:{items:[],unread_count:1,next_offset:null}}));
  await page.route(/\/api\/v1\/me\/conversations\?limit=1&offset=0$/,route=>route.fulfill({json:{items:[],unread_count:2,next_offset:null}}));
  await open(page,server);
  const toggle=page.getByRole('button',{name:'設定',exact:true}),item=page.getByRole('menuitem',{name:'我的訊息',exact:true});
  await toggle.click();await expect(item).toContainText('10 則未讀');await page.keyboard.press('Escape');
  // The menu used one-item list reads only.
  expect(server.log.history).toEqual([]);expect(server.log.lists.filter(info=>info.limit===1).map(info=>info.kind).sort()).toEqual(expect.arrayContaining(['guild','squad']));
  // A confirmed read in a channel re-reads the menu total from the server.
  await tab(page,'公會閒聊').click();await panel(page,'公會閒聊').getByRole('button',{name:'合成公會甲',exact:true}).click();
  await panel(page,'公會閒聊').getByRole('button',{name:'標為已讀',exact:true}).click();await expect(tab(page,'公會閒聊')).toContainText('沒有未讀');
  await toggle.click();await expect(item).toContainText('7 則未讀');await page.keyboard.press('Escape');
  squadFails=true;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await toggle.click();await expect(item).toContainText('未讀數未確認');await expect(item).not.toContainText('則未讀');
  await expect(toggle.locator('.settings-dot')).toHaveCount(0);
});
