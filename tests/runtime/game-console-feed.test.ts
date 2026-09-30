import test from 'node:test'
import assert from 'node:assert/strict'
import {readConsoleFeed} from '../../apps/portal-web/src/game-console-feed.js'
import type {PortalClient} from '../../apps/portal-web/src/api.js'

test('console restores sent and received chat history without changing read receipts',async()=>{
  const paths:string[]=[]
  const pages:Record<string,unknown>={
    '/me/notifications?limit=20&offset=0':{items:[
      {notification_id:'n1',title:'邀請',body:'加入小隊',created_at:'2026-09-26T12:00:00Z',read_at:null},
      {notification_id:'n2',title:'舊通知',body:'已讀',created_at:'2026-09-26T11:00:00Z',read_at:'2026-09-26T11:05:00Z'},
    ]},
    '/me/conversations?limit=20&offset=0':{items:[{participant:{user_id:'peer',display_name:'阿明'},unread_count:0,last_message:{sender_ref:'me'}}]},
    '/me/channels?kind=guild&limit=50&offset=0':{items:[{kind:'guild',channel_key:'guild_ai',name:'AI 公會',unread_count:0,last_message_at:'2026-09-26T12:02:00Z'}]},
    '/me/channels?kind=squad&limit=50&offset=0':{items:[]},
    '/me/guild-announcements':{items:[{announcement_id:'a1',title:'讀書會',body:'星期三集合',guild_name:'AI 公會',updated_at:'2026-09-26T12:03:00Z'}]},
    '/skill-submissions/published?limit=10':{items:[{submission_id:'s1',title:'攝影技能',published_at:'2026-09-26T12:04:00Z'}]},
    '/co-creation/projects':{items:[{project_id:'pilot',title:'內建專案',source_kind:'community_pilot'},{project_id:'p1',title:'共作',source_kind:'member_project',created_at:'2026-09-26T12:05:00Z'}]},
    '/events/bulletins':{items:[{bulletin_id:'b1',message:'阿明提交了公開活動「共作」。',created_at:'2026-09-26T12:07:00Z'}]},
    '/community/accepted-work':{items:[{contribution_id:'c1',title:'整理說明',member_name:'小惠',accepted_at:'2026-09-26T12:08:00Z'}]},
    '/me/channels/world/world/messages?limit=20&offset=0':{items:[{message_id:'w1',sender_ref:'peer',sender_name:'阿明',body:'大家好',created_at:'2026-09-26T12:06:00Z'}]},
    '/me/conversations/peer/messages?limit=20&offset=0':{items:[
      {message_id:'d1',sender_ref:'peer',body:'可以聊聊嗎？',created_at:'2026-09-26T12:01:00Z',read_at:null},
      {message_id:'d2',sender_ref:'me',body:'我的草稿',created_at:'2026-09-26T12:00:30Z',read_at:null},
    ]},
    '/me/channels/guild/guild_ai/messages?limit=20&offset=0':{items:[
      {message_id:'g1',sender_ref:'peer',sender_name:'阿明',body:'開會囉',created_at:'2026-09-26T12:02:00Z'},
      {message_id:'g0',sender_ref:'me',sender_name:'我',body:'較舊訊息',created_at:'2026-09-26T11:55:00Z'},
    ]},
  }
  const client={get:async(path:string)=>{paths.push(path);assert.ok(Object.hasOwn(pages,path),path);return pages[path]}} as PortalClient
  const events=await readConsoleFeed(client,'me')
  assert.deepEqual(events.map(event=>event.id),['room:g0','notice:n1','direct:d2','direct:d1','room:g1','guild:a1:2026-09-26T12:03:00Z','skill:s1','project:p1','room:w1','event-bulletin:b1','accepted-work:c1'])
  assert.deepEqual(events.map(event=>event.channel),['guild','system','direct','direct','guild','guild','system','system','world_chat','system','system'])
  assert.equal(events.find(event=>event.id==='direct:d2')?.source,'你 → 阿明')
  assert.equal(events.find(event=>event.id==='room:g0')?.source,'公會 · AI 公會 · 你')
  assert.ok(paths.every(path=>!path.endsWith('/read')))
  assert.ok(paths.includes('/pages/github-events'))
  assert.equal(paths.length,13)
})

test('GitHub announcements describe approved reviews and design claim comments as distinct events',async()=>{
  const client={get:async(path:string)=>path==='/pages/github-events'?{items:[
    {id:'101',number:7,title:'首頁導覽',url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/7#pullrequestreview-101',actor:'reviewer',created_at:'2026-09-27T12:00:00Z',kind:'pr_approved'},
    {id:'102',number:8,title:'定位設計',url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/8#issuecomment-102',actor:'designer',created_at:'2026-09-27T12:01:00Z',kind:'design_claimed'},
  ]}: {items:[]}} as PortalClient
  const events=await readConsoleFeed(client,'me')
  assert.deepEqual(events.map(event=>event.id),['github:101','github:102'])
  assert.match(events[0].message,/reviewer 核准 PR/)
  assert.match(events[1].message,/designer 表示願意接手 Issue 設計/)
})

test('GitHub closed, merged and release events stay on the announcement channel',async()=>{
  const client={get:async(path:string)=>path==='/pages/github-events'?{items:[
    {id:'201',number:4,title:'首頁導覽',url:'https://github.com/FreeTWAI-AI/freedom-platform/issues/4',actor:'member',created_at:'2026-09-27T12:02:00Z',kind:'issue_closed'},
    {id:'202',number:13,title:'改善手機導覽',url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/13',actor:'contributor-demo',created_at:'2026-09-27T12:03:00Z',kind:'pr_merged'},
    {id:'203',number:17,title:'關閉說明',url:'https://github.com/FreeTWAI-AI/freedom-platform/pull/17',actor:'contributor-demo',created_at:'2026-09-27T12:04:00Z',kind:'pr_closed'},
    {id:'204',number:null,title:'v1.2.0',url:'https://github.com/FreeTWAI-AI/freedom-platform/releases/tag/v1.2.0',actor:'member',created_at:'2026-09-27T12:05:00Z',kind:'release_published'},
  ]}:{items:[]}} as PortalClient
  const events=await readConsoleFeed(client,'me')
  assert.deepEqual(events.map(event=>event.channel),['system','system','system','system'])
  assert.match(events[0].message,/member 關閉 Issue：首頁導覽（#4）/)
  assert.match(events[1].message,/contributor-demo 合併 PR/)
  assert.match(events[2].message,/關閉 PR/)
  assert.equal(events[3].message,'member 發布版本：v1.2.0')
  assert.doesNotMatch(events[3].message,/#null/)
})

test('one unavailable feed source does not hide the other channels',async()=>{
  const client={get:async(path:string)=>{
    if(path==='/me/guild-announcements')throw new Error('temporarily unavailable')
    if(path==='/skill-submissions/published?limit=10')return {items:[{submission_id:'s2',title:'共享工具',published_at:'2026-09-26T12:00:00Z'}]}
    return {items:[]}
  }} as PortalClient
  const events=await readConsoleFeed(client,'me')
  assert.deepEqual(events.map(event=>event.id),['skill:s2'])
})
