import {randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {test,expect,type Page} from './fixtures.js';
import {navigate} from './navigation.js';

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
    if(parts[3]==='activity'&&request.method()==='GET'){
      if(!channel?.member)return denied();
      return route.fulfill({json:{latest_sequence:channel.messages[0]?.sequence??'0',unread_count:unread(channel)}});
    }
    if(parts[3]==='messages'&&request.method()==='GET'){
      log.history.push(info);
      if(!channel?.member)return denied();
      const after=url.searchParams.get('after_sequence'),items=after===null?channel.messages:channel.messages.filter(item=>BigInt(item.sequence)>BigInt(after)).reverse();
      return answer('history',info,{channel:{kind,channel_key:key,name:channel.name},items:items.slice(offset,offset+limit).map(item=>({...item})),unread_count:unread(channel),next_offset:after===null&&offset+limit<items.length?offset+limit:null,...(after!==null?{next_after_sequence:items.length>limit?items[limit-1].sequence:null}:{})});
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
  await page.getByRole('button',{name:'登入',exact:true}).click();await expect(page.getByRole('button',{name:'設定',exact:true})).toBeVisible();
  return (await (await page.request.get('/api/v1/session')).json()).user.user_id as string;
}
async function open(page:Page,server:{me:{id:string}},hash='#messages'){server.me.id=await login(page,hash);}
const tab=(page:Page,name:string)=>page.locator('.messages-categories').getByRole('tab',{name:new RegExp(`^${name}`),includeHidden:true});
const panel=(page:Page,name:string)=>page.getByRole('tabpanel',{name:new RegExp(`^${name}`)});
async function noOverflow(page:Page){expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);}
async function visibility(page:Page,state:'visible'|'hidden'){
  await page.evaluate(value=>{Object.defineProperty(document,'visibilityState',{configurable:true,value});document.dispatchEvent(new Event('visibilitychange'));},state);
}
async function latestVisible(page:Page,log:ReturnType<Page['locator']>){await log.evaluate(node=>{node.scrollTop=node.scrollHeight});await visibility(page,'visible');}
async function shot(page:Page,name:string){mkdirSync(SHOTS,{recursive:true});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:`${SHOTS}/${name}.png`,fullPage:true,animations:'disabled'});}
/** Holds matching answers after their snapshot is taken, like a slow server. */
function holder(){
  const held:(()=>void)[]=[];
  return {held,wait:()=>new Promise<void>(resolve=>held.push(resolve)),release:()=>held.splice(0).forEach(done=>done())};
}
/** Full history pages of one room. The console feed uses the same limit, so a hold can include that one extra copy. */
const openPages=(log:{history:Info[]},kind:Kind,key:string)=>log.history.filter(item=>item.kind===kind&&item.key===key&&item.limit>1&&item.offset===0).length;

test('five tabs keep their order and keyboard behaviour without mixing room histories',async({page})=>{
  await page.setViewportSize({width:320,height:780});
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3],['Makers','合成公會乙',0]],squad:[[squadA,'合成小隊甲',2]]});
  await open(page,server);
  const tabs=page.getByRole('tab');
  await expect(tabs).toHaveCount(5);
  const labels=['私人訊息','公會閒聊','小隊閒聊','世界聊天','通知'];
  for(const [index,label] of labels.entries())await expect(tabs.nth(index)).toHaveAccessibleName(new RegExp(`^${label}`));
  await expect(tabs).toHaveText([/^私訊/,/^公會/,/^群組/,/^公開/,/^通知/]);
  await expect(tab(page,'公會閒聊')).toContainText('3 則未讀');await expect(tab(page,'小隊閒聊')).toContainText('2 則未讀');
  await expect(tab(page,'私人訊息')).toContainText('沒有未讀');await expect(tab(page,'通知')).toContainText('沒有未讀');
  // Roving tabindex, arrow keys wrap, Home/End jump; each tab controls its own panel.
  await tab(page,'私人訊息').focus();
  const expectSelected=async(label:string)=>{
    const current=tab(page,label);
    await expect(current).toBeFocused();await expect(current).toHaveAttribute('aria-selected','true');await expect(current).toHaveAttribute('tabindex','0');
    await expect(page.locator('#'+await current.getAttribute('aria-controls'))).toBeVisible();
    for(const name of labels.filter(item=>item!==label)){await expect(tab(page,name)).toHaveAttribute('aria-selected','false');await expect(tab(page,name)).toHaveAttribute('tabindex','-1');}
  };
  for(const label of ['公會閒聊','小隊閒聊','世界聊天','通知','私人訊息']){await page.keyboard.press('ArrowRight');await expectSelected(label);}
  await page.keyboard.press('ArrowUp');await expectSelected('通知');
  await page.keyboard.press('ArrowLeft');await expectSelected('世界聊天');
  await page.keyboard.press('Home');await expectSelected('私人訊息');
  await page.keyboard.press('End');await expectSelected('通知');
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
  // Window focus re-checks the lists. The console can read history without marking messages read.
  const lists=server.log.lists.length;await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>server.log.lists.length).toBeGreaterThan(lists);
  await tab(page,'小隊閒聊').click();await expect(panel(page,'小隊閒聊').locator('[data-channel-key]')).toHaveCount(1);
  await tab(page,'公會閒聊').click();await noOverflow(page);await shot(page,'4tabs-320');
  expect(server.log.history.every(item=>item.limit===20&&item.offset===0)).toBe(true);expect(server.log.reads).toEqual([]);
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
  expect(server.log.reads).toEqual([]);

  await visibility(page,'hidden');
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
  expect(server.log.history.filter(item=>item.key==='guild-01'&&item.offset===20)).toHaveLength(2);
  // A background document may load a history but must not mark it read.
  expect(server.log.reads).toEqual([]);
  const channel=server.get('guild','guild-01'),shownNewest=channel.messages[0].message_id;
  // A message arrives after the page was drawn: the read covers only what the member saw.
  channel.messages.unshift(server.message(channel,'畫面之後才到的合成訊息'));
  const background=holder();server.control.gate=(what,info)=>what==='history'&&info.limit===50?background.wait():undefined;
  await latestVisible(page,thread.getByRole('log'));
  await expect(thread.getByRole('note')).toContainText('還有 1 則較新的未讀訊息');
  expect(server.log.reads.map(item=>item.through)).toEqual([shownNewest]);expect(server.log.reads[0].csrf).toBeTruthy();expect(server.log.reads[0].idempotency).toBeTruthy();
  await expect(tab(page,'公會閒聊')).toContainText('1 則未讀');await expect(list.getByRole('button',{name:'合成公會 01',exact:true})).toContainText('1 則未讀');
  await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  background.release();
  await expect(bubbles.last()).toHaveText('畫面之後才到的合成訊息');
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
  expect(server.log.reads).toEqual([]);
});

test('phone group lists and scrolled history never auto-read; returning to latest reads only the active group',async({page})=>{
  await page.setViewportSize({width:320,height:844});
  const server=await channelServer(page,{guild:[['builders','合成公會甲',30],['makers','合成公會乙',2]],squad:[[squadA,'合成小隊甲',1]]});
  await open(page,server);await tab(page,'公會閒聊').click();const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread');
  await visibility(page,'hidden');await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();
  await expect(thread.locator('.messages-bubbles>li')).toHaveCount(20);expect(server.log.reads).toEqual([]);
  await guild.getByRole('button',{name:'← 返回公會列表',exact:true}).click();await visibility(page,'visible');
  await expect(thread).toBeHidden();expect(server.log.reads).toEqual([]);
  await guild.getByRole('button',{name:'合成公會乙',exact:true}).click();
  await expect.poll(()=>server.get('guild','makers').read).toBe(BigInt(server.get('guild','makers').messages[0].sequence));
  expect(server.log.reads.map(item=>item.key)).toEqual(['makers']);expect(server.get('guild','builders').read).toBe(0n);expect(server.get('squad',squadA).read).toBe(0n);
  await guild.getByRole('button',{name:'← 返回公會列表',exact:true}).click();await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();
  await expect.poll(()=>server.log.reads.length).toBe(2);
  const log=thread.getByRole('log');await log.evaluate(node=>{node.scrollTop=0;node.dispatchEvent(new Event('scroll'));});
  const channel=server.get('guild','builders');channel.messages.unshift(server.message(channel,'歷史瀏覽中收到的新訊息'));
  await expect(thread.getByRole('button',{name:'有新訊息 · 回到最新',exact:true})).toBeVisible();
  expect(server.log.reads).toHaveLength(2);expect(BigInt(channel.messages[0].sequence)>channel.read).toBe(true);
  await thread.getByRole('button',{name:'有新訊息 · 回到最新',exact:true}).click();
  await expect.poll(()=>channel.read).toBe(BigInt(channel.messages[0].sequence));expect(server.log.reads.map(item=>item.key)).toEqual(['makers','builders','builders']);
  await expect(tab(page,'小隊閒聊')).toContainText('1 則未讀');await noOverflow(page);await shot(page,'group-auto-read-320');
});

test('a lost auto-read ACK preserves its boundary and key until explicit recovery',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3],['makers','合成公會乙',2]]});
  let failed=false;server.control.fail=what=>{if(what==='read'&&!failed){failed=true;return '500'}};
  await open(page,server);await tab(page,'公會閒聊').click();const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(thread.getByRole('alert')).toContainText('標為已讀未完成');
  expect(server.log.reads).toHaveLength(1);const original=server.log.reads[0];
  const channel=server.get('guild','builders');channel.messages.unshift(server.message(channel,'確認回覆遺失後的新訊息'));
  await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();await expect(thread.locator('.messages-bubbles .messages-body').last()).toHaveText('確認回覆遺失後的新訊息');
  await expect(thread.getByRole('alert')).toContainText('標為已讀未完成');expect(server.log.reads).toHaveLength(1);
  await thread.getByRole('button',{name:'重試標為已讀',exact:true}).click();
  await expect.poll(()=>server.log.reads.length).toBe(3);expect(server.log.reads[1]).toEqual(original);
  expect(server.log.reads[2].through).toBe(channel.messages[0].message_id);expect(server.log.reads[2].idempotency).not.toBe(original.idempotency);
  await expect(tab(page,'公會閒聊')).toContainText('2 則未讀');expect(server.get('guild','makers').read).toBe(0n);
});

test('chat navigation defaults to private conversations and the bell explicitly opens notifications',async({page})=>{
  const server=await channelServer(page,{});await open(page,server);
  await expect(tab(page,'私人訊息')).toHaveAttribute('aria-selected','true');
  for(let i=0;i<2;i++){
    await page.getByRole('button',{name:/^通知/}).click();await page.getByRole('button',{name:'查看所有通知與訊息',exact:true}).click();
    await expect(tab(page,'通知')).toHaveAttribute('aria-selected','true');await tab(page,'私人訊息').click();
  }
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('freedom-open-channel',{detail:{kind:'world',key:'world'}})));
  await expect(panel(page,'世界聊天')).toBeVisible();
  await navigate(page,'會員首頁');
  // The navigation helper's message shortcut uses the bell and opens notifications.
  // Exercise the actual primary chat entry here instead.
  await page.getByRole('navigation',{name:'主要工作區'}).getByRole('button',{name:'我的訊息',exact:true}).click();
  await expect(tab(page,'私人訊息')).toHaveAttribute('aria-selected','true');
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('freedom-open-channel',{detail:{kind:'world',key:'world'}})));
  await expect(panel(page,'世界聊天')).toBeVisible();await navigate(page,'會員首頁');
  await page.getByRole('button',{name:/^通知/}).click();await page.getByRole('button',{name:'查看所有通知與訊息',exact:true}).click();
  await expect(tab(page,'通知')).toHaveAttribute('aria-selected','true');await tab(page,'私人訊息').click();
  await page.evaluate(()=>window.dispatchEvent(new CustomEvent('freedom-open-channel',{detail:{kind:'world',key:'world'}})));
  await expect(panel(page,'世界聊天')).toBeVisible();await navigate(page,'會員首頁');
  await page.evaluate(()=>{window.location.hash='messages'});
  await expect(tab(page,'私人訊息')).toHaveAttribute('aria-selected','true');
  await page.getByRole('button',{name:'建立群組',exact:true}).click();await expect(page).toHaveURL(/#squads$/);
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
  holding=true;await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();await expect.poll(()=>hold.held.length).toBeGreaterThanOrEqual(1);holding=false;
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
  await expect(guild.locator('.messages-side')).toBeHidden();await guild.getByRole('button',{name:'← 返回公會列表',exact:true}).click();
  await guild.getByRole('button',{name:'合成公會乙',exact:true}).click();
  await expect(thread.getByRole('heading',{level:2})).toHaveText('合成公會乙・公會閒聊');await expect(thread.getByText('這個頻道還沒有訊息。')).toBeVisible();
  hold.release();server.control.gate=undefined;await page.waitForTimeout(300);
  await expect(thread.getByRole('heading',{level:2})).toHaveText('合成公會乙・公會閒聊');await expect(thread.getByText(/合成公會甲 合成訊息/)).toHaveCount(0);
  await expect(guild.getByRole('button',{name:'合成公會乙',exact:true,includeHidden:true})).toHaveAttribute('aria-current','true');
  // A slow answer for one squad does not land in another squad either.
  const squadHold=holder();server.control.gate=(what,info)=>what==='history'&&info.key===squadA?squadHold.wait():undefined;
  await guild.getByRole('button',{name:'← 返回公會列表',exact:true}).click();
  await tab(page,'小隊閒聊').click();
  const squad=panel(page,'小隊閒聊'),squadThread=squad.locator('.messages-thread');
  await expect(squadThread).toBeHidden();await expect(squadThread.locator('.messages-bubbles')).toHaveCount(0);
  await squad.getByRole('button',{name:'合成小隊甲',exact:true}).click();await squad.getByRole('button',{name:'← 返回小隊列表',exact:true}).click();await squad.getByRole('button',{name:'合成小隊乙',exact:true}).click();
  await expect(squadThread.locator('.messages-bubbles .messages-body')).toHaveText(['合成小隊乙 合成訊息 1']);
  squadHold.release();server.control.gate=undefined;await page.waitForTimeout(300);
  await expect(squadThread.locator('.messages-bubbles .messages-body')).toHaveText(['合成小隊乙 合成訊息 1']);
  await squad.getByRole('button',{name:'← 返回小隊列表',exact:true}).click();await squad.getByRole('button',{name:'合成小隊甲',exact:true}).click();
  await expect(squadThread.locator('.messages-bubbles .messages-body')).toHaveText(['合成小隊甲 合成訊息 1','合成小隊甲 合成訊息 2']);
  await noOverflow(page);await shot(page,'squad-320');
  // Each panel holds only its own kind; the private panel holds none.
  await expect(squad.getByText(/合成公會/)).toHaveCount(0);await expect(guild.getByText(/合成小隊/)).toHaveCount(0);
  await expect(panel(page,'私人訊息').getByText(/合成(公會|小隊)/)).toHaveCount(0);
  await squad.getByRole('button',{name:'← 返回小隊列表',exact:true}).click();
  await tab(page,'公會閒聊').click();await guild.getByRole('button',{name:'回到目前對話',exact:true}).click();await expect(thread.getByRole('heading',{level:2})).toHaveText('合成公會乙・公會閒聊');
  await guild.getByRole('button',{name:'← 返回公會列表',exact:true}).click();
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(thread.locator('.messages-bubbles .messages-body')).toHaveCount(3);
  await noOverflow(page);await shot(page,'guild-320');
});

test('leaving a channel clears its history and composer at once, and a late answer cannot bring it back',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3],['Makers','合成公會乙',1]],squad:[[squadA,'合成小隊甲',2]]});
  const hold=holder();let holding=false;
  // Hold only this room's re-read. The console feed reads every recent room with the same limit.
  server.control.gate=(what,info)=>holding&&what==='history'&&info.kind==='guild'&&info.key==='builders'&&info.limit>1&&info.offset===0?hold.wait():undefined;
  await page.setViewportSize({width:320,height:780});
  await open(page,server);await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(bubbles).toHaveCount(3);
  const box=thread.getByLabel('在 合成公會甲 發言');await box.fill('離會前的草稿');
  // A re-read snapshots the old history, then the member leaves before it answers.
  const before=openPages(server.log,'guild','builders');
  holding=true;await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  await expect.poll(()=>{const added=openPages(server.log,'guild','builders')-before;return hold.held.length===added&&added>=1&&added<=2;}).toBe(true);
  holding=false;
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
  // The panel refreshes with limit 20. The console feed lists rooms with limit 50 and must not be held.
  server.control.gate=(what,info)=>holding&&what==='list'&&info.kind==='guild'&&info.limit===20?hold.wait():undefined;
  await open(page,server);await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊'),thread=guild.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  await guild.getByRole('button',{name:'載入更多公會頻道',exact:true}).click();
  await guild.getByRole('button',{name:'合成公會 22',exact:true}).click();await expect(bubbles).toHaveCount(2);
  await expect.poll(()=>server.get('guild','guild-22').read).toBe(BigInt(server.get('guild','guild-22').messages[0].sequence));
  await expect(thread.getByText('正在同步已讀…',{exact:true})).toHaveCount(0);await expect(guild.getByRole('button',{name:'重新整理公會頻道',exact:true})).toBeVisible();
  // The first page cannot prove the channel is gone: the open channel is checked on its own and stays.
  const before=server.log.history.filter(item=>item.key==='guild-22'&&item.limit===1).length;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect.poll(()=>server.log.history.filter(item=>item.key==='guild-22'&&item.limit===1).length).toBe(before+1);
  await page.waitForTimeout(200);await expect(bubbles).toHaveCount(2);await expect(thread.locator('textarea')).toHaveCount(1);
  // After leaving, the same check closes it.
  server.get('guild','guild-22').member=false;
  await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);

  // A complete list without the open channel closes it without another history read.
  await guild.getByRole('button',{name:'合成公會 01',exact:true}).click();await expect(bubbles).toHaveCount(2);
  await expect.poll(()=>server.get('guild','guild-01').read).toBe(BigInt(server.get('guild','guild-01').messages[0].sequence));
  await expect(thread.getByText('正在同步已讀…',{exact:true})).toHaveCount(0);await expect(guild.getByRole('button',{name:'重新整理公會頻道',exact:true})).toBeVisible();
  for(let n=3;n<=21;n++)server.get('guild',`guild-${String(n).padStart(2,'0')}`).member=false;
  server.get('guild','guild-01').member=false;
  const reads=server.log.history.filter(item=>item.key==='guild-01'&&item.limit===1).length;
  await guild.getByRole('button',{name:'重新整理公會頻道',exact:true}).click();
  await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');await expect(bubbles).toHaveCount(0);
  expect(server.log.history.filter(item=>item.key==='guild-01'&&item.limit===1)).toHaveLength(reads);
  await expect(guild.locator('[data-channel-key]')).toHaveCount(1);

  // A list answer taken before the member left must not put the channel back.
  await guild.getByRole('button',{name:'合成公會 02',exact:true}).click();await expect(bubbles).toHaveCount(2);
  await expect.poll(()=>server.get('guild','guild-02').read).toBe(BigInt(server.get('guild','guild-02').messages[0].sequence));
  await expect(thread.getByText('正在同步已讀…',{exact:true})).toHaveCount(0);await expect(guild.getByRole('button',{name:'重新整理公會頻道',exact:true})).toBeVisible();
  holding=true;await guild.getByRole('button',{name:'重新整理公會頻道',exact:true}).click();await expect.poll(()=>hold.held.length).toBe(1);holding=false;
  server.get('guild','guild-02').member=false;
  // The fast activity check may revoke before a manual-refresh button can be clicked.
  // Keep the stale list held until live access has actually been refused.
  await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。',{timeout:3000});
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
  await visibility(page,'hidden');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();await expect(bubbles).toHaveCount(3);
  const box=thread.getByLabel('在 合成公會甲 發言');await box.fill('已讀後的草稿');
  const channel=server.get('guild','builders');
  // Arrives after the page was drawn, so the read cannot cover it.
  channel.messages.unshift(server.message(channel,'標記後才看到的合成訊息'));
  const background=holder();server.control.gate=(what,info)=>what==='history'&&info.limit===50?background.wait():undefined;
  await latestVisible(page,thread.getByRole('log'));
  await expect(thread.getByRole('alert')).toContainText('已標為已讀，但目前未讀數未確認');
  await expect(thread.getByRole('alert')).not.toContainText('標為已讀未完成');
  await expect(thread.getByText('3 則未讀')).toHaveCount(0);await expect(thread.getByRole('button',{name:/標為已讀/})).toHaveCount(0);
  await expect(bubbles).toHaveCount(3);await expect(box).toHaveValue('已讀後的草稿');
  await thread.getByRole('alert').getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  background.release();
  await expect(bubbles.last()).toHaveText('標記後才看到的合成訊息');await expect(thread.getByRole('alert')).toHaveCount(0);
  // Displaying the newer message now syncs its own boundary automatically.
  await expect(tab(page,'公會閒聊')).toContainText('沒有未讀');await expect(box).toHaveValue('已讀後的草稿');
  await expect.poll(()=>server.log.reads.length).toBe(2);
});

test('new messages displayed in the active channel auto-read while other room totals stay unread',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',2]],squad:[[squadA,'合成小隊甲',0],[squadB,'合成小隊乙',0]]});
  await open(page,server);await tab(page,'小隊閒聊').click();
  const squad=panel(page,'小隊閒聊'),thread=squad.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
  const button=squad.getByRole('button',{name:'合成小隊甲',exact:true});
  await button.click();await expect(thread.getByText('這個頻道還沒有訊息。')).toBeVisible();
  await expect(tab(page,'小隊閒聊')).toContainText('沒有未讀');await expect(button).not.toContainText('則未讀');
  // The profile stays free of duplicate inbox indicators while channel badges update.
  const toggle=page.getByRole('button',{name:'設定',exact:true});await expect(toggle).not.toHaveAttribute('aria-description',/我的訊息/);
  const box=thread.getByLabel('在 合成小隊甲 發言');await box.fill('回覆前的草稿');
  // Another member replies while this one has the room open; no window focus follows.
  const channel=server.get('squad',squadA);channel.messages.unshift(server.message(channel,'夥伴剛回覆的合成訊息'));
  await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
  await expect(bubbles).toHaveText(['夥伴剛回覆的合成訊息']);
  await expect(tab(page,'小隊閒聊')).toContainText('沒有未讀');await expect(button).not.toContainText('則未讀');
  await expect(toggle).toHaveAttribute('aria-expanded','false');
  await expect(squad.getByRole('button',{name:'合成小隊乙',exact:true})).not.toContainText('則未讀');
  await expect(box).toHaveValue('回覆前的草稿');expect(server.log.reads.map(item=>item.through)).toEqual([channel.messages[0].message_id]);
  // The other kind and the private tab keep their own totals.
  await expect(tab(page,'公會閒聊')).toContainText('2 則未讀');await expect(tab(page,'私人訊息')).toContainText('沒有未讀');
  await expect(squad.getByText(/合成公會/)).toHaveCount(0);await expect(panel(page,'私人訊息').getByText(/合成(公會|小隊)/)).toHaveCount(0);
  // The console may read guild history for its world feed while this tab remains closed.
});

test('a list refresh refused with 403 or 404 closes the open channel without reviving it or looping',async({page})=>{
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3]],squad:[[squadA,'合成小隊甲',2]]});
  const hold=holder();let holding=false,refuse:'403'|'404'|undefined;
  const target:{kind:Kind;key:string}={kind:'guild',key:'builders'};
  server.control.fail=(what,info)=>what==='list'&&info.limit>1?refuse:undefined;
  server.control.gate=(what,info)=>holding&&what==='history'&&info.kind===target.kind&&info.key===target.key&&info.limit>1&&info.offset===0?hold.wait():undefined;
  await open(page,server);
  for(const [name,unit,channelName,status] of [['公會閒聊','公會','合成公會甲','403'],['小隊閒聊','小隊','合成小隊甲','404']] as const){
    await tab(page,name).click();
    const scope=panel(page,name),thread=scope.locator('.messages-thread'),bubbles=thread.locator('.messages-bubbles .messages-body');
    await scope.getByRole('button',{name:channelName,exact:true}).click();await expect(bubbles).not.toHaveCount(0);
    await thread.locator('textarea').fill('被拒前的草稿');
    // A re-read already out must not bring the history back after the refusal. The console may read this same room once.
    target.kind=unit==='公會'?'guild':'squad';target.key=unit==='公會'?'builders':squadA;
    const before=openPages(server.log,target.kind,target.key);
    holding=true;await thread.getByRole('button',{name:'重新讀取訊息',exact:true}).click();
    await expect.poll(()=>{const added=openPages(server.log,target.kind,target.key)-before;return hold.held.length===added&&added>=1&&added<=2;}).toBe(true);
    holding=false;
    refuse=status;const lists=server.log.lists.length;
    await scope.getByRole('button',{name:`重新整理${unit}頻道`,exact:true}).click();
    await expect(thread.getByRole('alert')).toContainText('目前無法使用此頻道。');
    await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);
    await expect(thread.getByRole('button',{name:unit==='公會'?'回到職業公會':'回到小隊集合',exact:true})).toBeVisible();
    hold.release();await expect.poll(()=>hold.held.length).toBe(0);await page.waitForTimeout(300);
    await expect(bubbles).toHaveCount(0);await expect(thread.locator('textarea')).toHaveCount(0);
    expect(server.log.lists.slice(lists).filter(info=>info.kind===(unit==='公會'?'guild':'squad')&&info.limit===20)).toHaveLength(1);
    refuse=undefined;
  }
});

const selectionShots='test-results/selection-palette';
type Paint={color:string;background:string;border:string;shadow:string;text:number;borderRatio:number;shadowRatio:number};
async function paintOf(page:Page,selector:string):Promise<Paint>{
  return page.locator(selector).evaluate(node=>{
    const style=getComputedStyle(node);
    const channel=(value:number)=>value<=0.04045?value/12.92:((value+0.055)/1.055)**2.4;
    const parts=(color:string)=>color.match(/[\d.]+/g)!.map(Number);
    const lum=(rgb:number[])=>0.2126*channel(rgb[0]/255)+0.7152*channel(rgb[1]/255)+0.0722*channel(rgb[2]/255);
    const ratio=(fg:number[],bg:number[])=>{const a=lum(fg),b=lum(bg);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);};
    const surface=(()=>{
      const layers:[number,number,number,number][]=[];
      for(let current:Element|null=node;current;current=current.parentElement){
        const raw=getComputedStyle(current).backgroundColor,bits=raw.match(/[\d.]+/g)?.map(Number);
        if(!bits)continue;
        const alpha=bits.length>3?bits[3]:1;
        if(alpha<=0)continue;
        layers.push([bits[0],bits[1],bits[2],alpha]);
        if(alpha>=1)break;
      }
      let [r,g,b]=[255,255,255];
      for(const [cr,cg,cb,alpha] of layers.reverse()){r=cr*alpha+r*(1-alpha);g=cg*alpha+g*(1-alpha);b=cb*alpha+b*(1-alpha);}
      return [r,g,b];
    })();
    const shadow=style.boxShadow.match(/rgba?\([^)]+\)/)?.[0]??'';
    return {
      color:style.color,background:style.backgroundColor,border:style.borderLeftColor,shadow:style.boxShadow,
      text:ratio(parts(style.color).slice(0,3),surface),
      borderRatio:ratio(parts(style.borderLeftColor).slice(0,3),surface),
      shadowRatio:shadow?ratio(parts(shadow).slice(0,3),surface):0,
    };
  });
}
function rejectBlue(paint:Paint,label:string){
  const serial=JSON.stringify(paint);
  for(const blue of ['52, 76, 189','52, 85, 184','72, 94, 118','238, 244, 255'])expect(serial,label).not.toContain(blue);
}
// Buttons transition background-color for 160ms; a mid-fade sample is one channel off the settled green.
async function settle(page:Page){
  await page.evaluate(()=>{for(const animation of document.getAnimations())if(animation instanceof CSSTransition)animation.finish();});
}

test('light and versefolk selection uses the workshop green palette',async({page})=>{
  test.setTimeout(90000);
  mkdirSync(selectionShots,{recursive:true});
  const peer='30000000-0000-4000-8000-0000000000b1';
  const participant={user_id:peer,display_name:'合成私訊',is_online:false,last_seen_at:null};
  await page.route(/\/api\/v1\/me\/conversations/,route=>{
    const url=route.request().url();
    if(url.includes('/activity'))return route.fulfill({json:{last_message_id:'peer-m1',unread_count:2,can_send:true}});
    if(url.includes('/messages')||url.endsWith('/read'))return route.fulfill({json:{participant,can_send:true,items:[{message_id:'peer-m1',sender_ref:peer,recipient_ref:'me',body:'合成私訊內容',created_at:'2026-09-24T01:00:00.000Z',read_at:null}],unread_count:2,next_offset:null}});
    return route.fulfill({json:{items:[{participant,can_send:true,unread_count:2,last_message:{message_id:'peer-m1',sender_ref:peer,recipient_ref:'me',body:'合成私訊內容',created_at:'2026-09-24T01:00:00.000Z',read_at:null}}],unread_count:2,next_offset:null}});
  });
  const server=await channelServer(page,{guild:[['builders','合成公會甲',3]]});
  await open(page,server);
  // Inspect unread selection colors before any foreground viewing acknowledges these rooms.
  await visibility(page,'hidden');
  await tab(page,'公會閒聊').click();
  const guild=panel(page,'公會閒聊');
  await guild.getByRole('button',{name:'合成公會甲',exact:true}).click();
  await expect(guild.locator('.messages-peer[aria-current="true"]')).toBeVisible();
  await tab(page,'私人訊息').click();
  const direct=panel(page,'私人訊息');
  await direct.getByRole('button',{name:/合成私訊/}).click();
  await expect(direct.locator('.messages-peer[aria-current="true"]')).toBeVisible();
  await tab(page,'公會閒聊').click();
  const nav='.workspace-navigation .nav-item.is-active';
  const selectedTab='.member-messages .messages-tabs [aria-selected="true"]';
  const channel='.member-messages .member-channel-list .messages-peer[aria-current="true"]';
  const directPeer='.member-messages #messages-panel-direct .messages-peer[aria-current="true"]';
  const channelCount=`${channel} .messages-count`;
  const tabCount=`${selectedTab} .messages-count`;
  for(const [label,theme,navBg,navText,navBar,tabBg,tabText,tabBorder,tabRing,mark,countBg,countText] of [
    ['自由工坊－明亮','light','rgb(242, 248, 220)','rgb(28, 38, 54)','none','rgb(238, 246, 216)','rgb(60, 101, 0)','rgb(154, 191, 78)','60, 101, 0','60, 101, 0','rgb(238, 246, 216)','rgb(60, 101, 0)'],
    ['自由工坊－夜航','dark','rgb(34, 44, 18)','rgb(244, 246, 239)','none','','rgb(208, 255, 83)','','208, 255, 83','196, 255, 32','rgb(39, 53, 21)','rgb(210, 255, 103)'],
    ['自由工坊－敘生','versefolk','rgb(237, 243, 219)','rgb(57, 47, 44)','none','rgb(237, 243, 219)','rgb(56, 76, 37)','rgb(155, 179, 120)','56, 76, 37','56, 76, 37','rgb(237, 243, 219)','rgb(56, 76, 37)'],
  ] as const){
    const settings=page.getByRole('button',{name:'設定',exact:true});
    if(await settings.getAttribute('aria-expanded')!=='true')await settings.click();
    await page.getByRole('menuitemradio',{name:label,exact:true}).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
    if(await settings.getAttribute('aria-expanded')==='true')await settings.click();
    if(await page.getByRole('button',{name:'收合訊息控制台'}).count())await page.getByRole('button',{name:'收合訊息控制台'}).click();
    for(const width of [1280,390]){
      await page.setViewportSize({width,height:width===390?844:900});
      if(width===390&&await guild.getByRole('button',{name:'← 返回公會列表',exact:true}).isVisible())await guild.getByRole('button',{name:'← 返回公會列表',exact:true}).click();
      const toggle=page.locator('.mobile-menu-toggle');
      if(width===390&&await toggle.getAttribute('aria-expanded')!=='true')await toggle.click();
      await settle(page);
      const active=await paintOf(page,nav);
      expect(active.background,`${theme} ${width} nav`).toBe(navBg);
      expect(active.color,`${theme} nav text`).toBe(navText);
      expect(active.shadow,`${theme} nav bar`).toContain(navBar);
      expect(active.text,`${theme} nav contrast`).toBeGreaterThanOrEqual(4.5);
      await expect(page.locator(nav)).toHaveClass(/is-active/);
      const tabPaint=await paintOf(page,selectedTab),channelPaint=await paintOf(page,channel),peerPaint=await paintOf(page,directPeer);
      const counts=[await paintOf(page,channelCount),await paintOf(page,tabCount)];
      await expect(page.locator(selectedTab)).toHaveAttribute('aria-selected','true');
      await expect(page.locator(channel)).toHaveAttribute('aria-current','true');
      await expect(page.locator(directPeer)).toHaveAttribute('aria-current','true');
      if(tabBg)expect(tabPaint.background,`${theme} tab`).toBe(tabBg);
      expect(tabPaint.color,`${theme} tab text`).toBe(tabText);
      if(tabBorder)expect(tabPaint.border,`${theme} tab border`).toBe(tabBorder);
      expect(tabPaint.shadow,`${theme} tab ring`).toContain(tabRing);
      expect(tabPaint.text,`${theme} tab contrast`).toBeGreaterThanOrEqual(4.5);
      expect(tabPaint.shadowRatio,`${theme} tab indicator`).toBeGreaterThanOrEqual(3);
      expect(channelPaint.border,`${theme} channel`).toBe(`rgb(${mark})`);
      expect(channelPaint.shadow,`${theme} channel bar`).toContain(mark);
      expect(channelPaint.shadow,`${theme} channel bar width`).toContain('4px');
      expect(channelPaint.shadowRatio,`${theme} channel indicator`).toBeGreaterThanOrEqual(3);
      expect(peerPaint.border,`${theme} peer`).toBe(`rgb(${mark})`);
      expect(peerPaint.borderRatio,`${theme} peer indicator`).toBeGreaterThanOrEqual(3);
      for(const count of counts){
        expect(count.background,`${theme} count`).toBe(countBg);
        expect(count.color,`${theme} count text`).toBe(countText);
        expect(count.text,`${theme} count contrast`).toBeGreaterThanOrEqual(4.5);
      }
      for(const [name,paint] of [['nav',active],['tab',tabPaint],['channel',channelPaint],['peer',peerPaint],['count',counts[0]]] as const)rejectBlue(paint,`${theme} ${width} ${name}`);
      if(width===1280){
        await page.locator('.sidebar').screenshot({path:`${selectionShots}/sidebar-${theme}-1280.png`});
        await page.locator('.member-messages').screenshot({path:`${selectionShots}/messages-${theme}-1280.png`});
      }else{
        await page.locator('.sidebar').screenshot({path:`${selectionShots}/menu-${theme}-390.png`});
        await toggle.click();
        // The phone sidebar is sticky, so an element shot would scroll the tabs underneath it.
        await page.locator('.sidebar').evaluate(node=>{node.style.position='relative';});
        await page.locator('.member-messages').screenshot({path:`${selectionShots}/messages-${theme}-390.png`});
        await page.locator('.sidebar').evaluate(node=>{node.style.position='';});
      }
    }
    await page.getByRole('button',{name:'展開訊息控制台'}).click();
    const dock=page.getByRole('complementary',{name:'訊息控制台',exact:true});
    await dock.getByRole('tab',{name:/^公會聊天/}).click();
    await dock.getByRole('button',{name:'合成公會甲',exact:true}).click();
    await dock.getByRole('button',{name:'切換公會',exact:true}).click();
    await settle(page);
    const consoleChannel=await paintOf(page,'.game-console .member-channel-list .messages-peer[aria-current="true"]');
    expect(consoleChannel.border,`${theme} console channel`).toBe(`rgb(${mark})`);
    expect(consoleChannel.shadowRatio,`${theme} console indicator`).toBeGreaterThanOrEqual(3);
    rejectBlue(consoleChannel,`${theme} console`);
    await expect(dock.locator('.messages-peer[aria-current="true"]')).toHaveAttribute('aria-current','true');
    await dock.screenshot({path:`${selectionShots}/console-${theme}-390.png`});
    await page.getByRole('button',{name:'收合訊息控制台'}).click();
  }
});

test('quick start join bar clears the collapsed console ticker at 390px',async({page})=>{
  test.setTimeout(60000);
  mkdirSync(selectionShots,{recursive:true});
  await page.setViewportSize({width:390,height:844});
  await page.goto('/');
  await page.getByRole('button',{name:'建立帳號',exact:true}).click();
  await page.getByLabel('社群顯示名稱',{exact:true}).fill('選色夥伴');
  await page.getByLabel('電子郵件',{exact:true}).fill(`palette-${randomUUID()}@example.test`);
  await page.getByLabel('密碼',{exact:true}).fill('freedom-entry-2026');
  await page.getByRole('button',{name:'建立帳號，先逛工坊',exact:true}).click();
  await expect(page.getByRole('heading',{name:'選色夥伴，歡迎來到自由工坊。'})).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme','light');
  const quick=page.getByRole('region',{name:'快速加入公會'});
  await quick.locator('input[value="guild_ai_vibe"]').check();
  await quick.getByRole('button',{name:/下一步：回答 \d+ 個小問題/}).click();
  await expect(quick.getByRole('heading',{name:/關於AI 開發公會的 \d+ 個小問題/})).toBeVisible();
  await expect(page.locator('.game-console-ticker')).toBeVisible();
  await expect(page.locator('.game-console-expanded')).toBeHidden();
  await quick.locator('.guild-question').first().evaluate(node=>node.scrollIntoView({block:'start'}));
  const gap=await page.evaluate(()=>{
    const bar=document.querySelector<HTMLElement>('.quick-join-finish')!,ticker=document.querySelector<HTMLElement>('.game-console-ticker')!;
    const barBox=bar.getBoundingClientRect(),tickerBox=ticker.getBoundingClientRect();
    const point=document.elementFromPoint(barBox.left+barBox.width/2,Math.min(barBox.top+barBox.height/2,innerHeight-1));
    return {barBottom:barBox.bottom,tickerTop:tickerBox.top,bottom:getComputedStyle(bar).bottom,covered:point? !bar.contains(point):true};
  });
  expect(gap.bottom).toBe('60px');
  expect(gap.barBottom).toBeLessThanOrEqual(gap.tickerTop);
  expect(gap.covered).toBe(false);
  await page.screenshot({path:`${selectionShots}/quick-start-light-390.png`,fullPage:false});
});
