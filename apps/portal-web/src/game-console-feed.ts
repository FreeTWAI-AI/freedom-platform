import type {PortalClient} from './api'
import {createConsoleEvent, type GameConsoleEvent} from './game-console-core'
import {bulletinConsoleChannel, consoleChannel, githubConsoleChannel, githubConsoleMessage, notificationConsoleChannel} from './game-console-routing'

type Notice = {notification_id:string;kind?:string;title:string;body:string;created_at:string;read_at:string|null}
type DirectMessage = {message_id:string;sender_ref:string;body:string;created_at:string;read_at:string|null}
type Conversation = {participant:{user_id:string;display_name:string};unread_count:number;last_message:DirectMessage}
type Room = {kind:'guild'|'squad';channel_key:string;name:string;unread_count:number;last_message_at:string|null}
type RoomMessage = {message_id:string;sender_ref:string;sender_name:string;body:string;created_at:string}
type Announcement = {announcement_id:string;title:string;body:string;guild_name:string;updated_at:string}
type PublishedSkill = {submission_id:string;title:string;published_at:string}
type Project = {project_id:string;title:string;created_at?:string;source_kind:'member_project'|'community_pilot'}
type Page<T> = {items:T[]}
type GitHubEvents={items:{id:string;number:number|null;title:string;url:string;actor:string;created_at:string;kind:string}[]}
type EventBulletin={bulletin_id:string;kind?:string;message:string;created_at:string}
type AcceptedWork={contribution_id:string;title:string;member_name:string;accepted_at:string}

export async function readWorldChatFeed(client:PortalClient):Promise<GameConsoleEvent[]> {
  const page=await client.get<Page<RoomMessage>>('/me/channels/world/world/messages?limit=20&offset=0',{background:true})
  return page.items.map(item=>createConsoleEvent({id:`room:${item.message_id}`,channel:consoleChannel('world_chat'),kind:'chat',source:item.sender_name,message:item.body,createdAt:item.created_at}))
}

/** Read only: the existing message pages remain the authority for membership and read receipts. */
export async function readConsoleFeed(client:PortalClient, userId:string, includeWorld=true):Promise<GameConsoleEvent[]> {
  const load=async<T,>(path:string):Promise<Page<T>>=>{
    try{return await client.get<Page<T>>(path,{background:true})}catch{return {items:[]}}
  }
  const [notices,conversations,guilds,squads,announcements,skills,projects,github,eventBulletins,acceptedWork] = await Promise.all([
    load<Notice>('/me/notifications?limit=20&offset=0'),
    load<Conversation>('/me/conversations?limit=20&offset=0'),
    load<Room>('/me/channels?kind=guild&limit=50&offset=0'),
    load<Room>('/me/channels?kind=squad&limit=50&offset=0'),
    includeWorld?load<Announcement>('/me/guild-announcements'):Promise.resolve({items:[] as Announcement[]}),
    includeWorld?load<PublishedSkill>('/skill-submissions/published?limit=10'):Promise.resolve({items:[] as PublishedSkill[]}),
    includeWorld?load<Project>('/co-creation/projects'):Promise.resolve({items:[] as Project[]}),
    includeWorld?load<GitHubEvents['items'][number]>('/pages/github-events'):Promise.resolve({items:[] as GitHubEvents['items']}),
    includeWorld?load<EventBulletin>('/events/bulletins'):Promise.resolve({items:[] as EventBulletin[]}),
    includeWorld?load<AcceptedWork>('/community/accepted-work'):Promise.resolve({items:[] as AcceptedWork[]}),
  ])
  const events = notices.items.filter(item=>item.read_at===null).map(item=>createConsoleEvent({
    id:`notice:${item.notification_id}`,channel:notificationConsoleChannel(item.kind),kind:'status',source:'通知',
    message:item.title,detail:item.body,createdAt:item.created_at,
  }))
  for(const item of announcements.items)events.push(createConsoleEvent({
    id:`guild:${item.announcement_id}:${item.updated_at}`,channel:consoleChannel('guild_announcement'),kind:'broadcast',source:`公會公告 · ${item.guild_name}`,
    message:item.title,detail:item.body,createdAt:item.updated_at,
  }))
  for(const item of skills.items.slice(0,10))events.push(createConsoleEvent({
    id:`skill:${item.submission_id}`,channel:consoleChannel('skill_published'),kind:'broadcast',source:'技能書發布',
    message:`技能書「${item.title}」已建立公開介紹頁。`,createdAt:item.published_at,
  }))
  for(const item of projects.items.filter(item=>item.source_kind==='member_project'&&item.created_at).slice(0,10))events.push(createConsoleEvent({
    id:`project:${item.project_id}`,channel:consoleChannel('project_published'),kind:'broadcast',source:'共創任務',
    message:`共創任務「${item.title}」已發布。`,createdAt:item.created_at!,
  }))
  for(const item of github.items.slice(0,20))events.push(createConsoleEvent({
    id:`github:${item.id}`,channel:githubConsoleChannel(item.kind),kind:'broadcast',source:'GitHub · 自由工坊',
    message:githubConsoleMessage(item),detail:item.url,createdAt:item.created_at,
  }))
  for(const item of eventBulletins.items)events.push(createConsoleEvent({
    id:`event-bulletin:${item.bulletin_id}`,channel:bulletinConsoleChannel(item.kind),kind:'broadcast',source:'系統公告',
    message:item.message,createdAt:item.created_at,
  }))
  for(const item of acceptedWork.items)events.push(createConsoleEvent({
    id:`accepted-work:${item.contribution_id}`,channel:consoleChannel('accepted_work'),kind:'broadcast',source:'工作驗收',
    message:`${item.member_name} 完成的「${item.title}」已通過驗收。`,createdAt:item.accepted_at,
  }))
  // The console is a recent history, not just an unread inbox. Fetch both sides
  // of recent conversations so sent messages survive a new browser session.
  const peers=conversations.items.slice(0,8)
  const rooms=[...guilds.items,...squads.items].filter(item=>item.last_message_at)
    .sort((a,b)=>b.last_message_at!.localeCompare(a.last_message_at!)).slice(0,8)
  const [directPages,roomPages]=await Promise.all([
    Promise.allSettled(peers.map(item=>client.get<Page<DirectMessage>>(`/me/conversations/${encodeURIComponent(item.participant.user_id)}/messages?limit=20&offset=0`,{background:true}))),
    Promise.allSettled(rooms.map(item=>client.get<Page<RoomMessage>>(`/me/channels/${item.kind}/${encodeURIComponent(item.channel_key)}/messages?limit=20&offset=0`,{background:true}))),
  ])
  directPages.forEach((result,index)=>{
    if(result.status!=='fulfilled')return
    const peer=peers[index]
    for(const item of result.value.items)events.push(createConsoleEvent({
      id:`direct:${item.message_id}`,channel:consoleChannel('direct_chat'),kind:'chat',source:item.sender_ref===userId?`你 → ${peer.participant.display_name}`:`私訊 · ${peer.participant.display_name}`,
      message:item.body,createdAt:item.created_at,
    }))
  })
  roomPages.forEach((result,index)=>{
    if(result.status!=='fulfilled')return
    const room=rooms[index]
    for(const item of result.value.items)events.push(createConsoleEvent({
      id:`room:${item.message_id}`,channel:consoleChannel(room.kind==='guild'?'guild_chat':'squad_chat'),kind:'chat',source:`${room.kind==='guild'?'公會':'小隊'} · ${room.name} · ${item.sender_ref===userId?'你':item.sender_name}`,
      message:item.body,createdAt:item.created_at,
    }))
  })
  if(includeWorld){
    try{events.push(...await readWorldChatFeed(client))}catch{/* Other feeds remain available. */}
  }
  return events.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))
}
