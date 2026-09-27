import type {PortalClient} from './api'
import {createConsoleEvent, type GameConsoleEvent} from './game-console-core'

type Notice = {notification_id:string;title:string;body:string;created_at:string;read_at:string|null}
type DirectMessage = {message_id:string;sender_ref:string;body:string;created_at:string;read_at:string|null}
type Conversation = {participant:{user_id:string;display_name:string};unread_count:number;last_message:DirectMessage}
type Room = {kind:'guild'|'squad';channel_key:string;name:string;unread_count:number;last_message_at:string|null}
type RoomMessage = {message_id:string;sender_ref:string;sender_name:string;body:string;created_at:string}
type Announcement = {announcement_id:string;title:string;body:string;guild_name:string;updated_at:string}
type PublishedSkill = {submission_id:string;title:string;published_at:string}
type Project = {project_id:string;title:string;created_at?:string;source_kind:'member_project'|'community_pilot'}
type Page<T> = {items:T[]}

/** Read only: the existing message pages remain the authority for membership and read receipts. */
export async function readConsoleFeed(client:PortalClient, userId:string, includeWorld=true):Promise<GameConsoleEvent[]> {
  const load=async<T,>(path:string):Promise<Page<T>>=>{
    try{return await client.get<Page<T>>(path)}catch{return {items:[]}}
  }
  const [notices,conversations,guilds,squads,announcements,skills,projects] = await Promise.all([
    load<Notice>('/me/notifications?limit=20&offset=0'),
    load<Conversation>('/me/conversations?limit=20&offset=0'),
    load<Room>('/me/channels?kind=guild&limit=50&offset=0'),
    load<Room>('/me/channels?kind=squad&limit=50&offset=0'),
    includeWorld?load<Announcement>('/me/guild-announcements'):Promise.resolve({items:[] as Announcement[]}),
    includeWorld?load<PublishedSkill>('/skill-submissions/published?limit=10'):Promise.resolve({items:[] as PublishedSkill[]}),
    includeWorld?load<Project>('/co-creation/projects'):Promise.resolve({items:[] as Project[]}),
  ])
  const events = notices.items.filter(item=>item.read_at===null).map(item=>createConsoleEvent({
    id:`notice:${item.notification_id}`,channel:'system',kind:'status',source:'通知',
    message:item.title,detail:item.body,createdAt:item.created_at,
  }))
  for(const item of announcements.items)events.push(createConsoleEvent({
    id:`guild:${item.announcement_id}:${item.updated_at}`,channel:'world',kind:'broadcast',source:`公會公告 · ${item.guild_name}`,
    message:item.title,detail:item.body,createdAt:item.updated_at,
  }))
  for(const item of skills.items.slice(0,10))events.push(createConsoleEvent({
    id:`skill:${item.submission_id}`,channel:'world',kind:'broadcast',source:'技能書發布',
    message:`技能書「${item.title}」已建立公開介紹頁。`,createdAt:item.published_at,
  }))
  for(const item of projects.items.filter(item=>item.source_kind==='member_project'&&item.created_at).slice(0,10))events.push(createConsoleEvent({
    id:`project:${item.project_id}`,channel:'world',kind:'broadcast',source:'共創任務',
    message:`共創任務「${item.title}」已發布。`,createdAt:item.created_at!,
  }))
  // Only unread peers are opened. A conversation's last message might be our own,
  // so its summary alone cannot stand in for an incoming message.
  const peers=conversations.items.filter(item=>item.unread_count>0).slice(0,8)
  const rooms=[...guilds.items,...squads.items].filter(item=>item.unread_count>0).slice(0,8)
  const [directPages,roomPages]=await Promise.all([
    Promise.allSettled(peers.map(item=>client.get<Page<DirectMessage>>(`/me/conversations/${encodeURIComponent(item.participant.user_id)}/messages?limit=20&offset=0`))),
    Promise.allSettled(rooms.map(item=>client.get<Page<RoomMessage>>(`/me/channels/${item.kind}/${encodeURIComponent(item.channel_key)}/messages?limit=20&offset=0`))),
  ])
  directPages.forEach((result,index)=>{
    if(result.status!=='fulfilled')return
    const peer=peers[index]
    for(const item of result.value.items.filter(message=>message.sender_ref!==userId&&message.read_at===null))events.push(createConsoleEvent({
      id:`direct:${item.message_id}`,channel:'social',kind:'chat',source:`私訊 · ${peer.participant.display_name}`,
      message:item.body,createdAt:item.created_at,
    }))
  })
  roomPages.forEach((result,index)=>{
    if(result.status!=='fulfilled')return
    const room=rooms[index]
    for(const item of result.value.items.filter(message=>message.sender_ref!==userId).slice(0,room.unread_count))events.push(createConsoleEvent({
      id:`room:${item.message_id}`,channel:'social',kind:'chat',source:`${room.kind==='guild'?'公會':'小隊'} · ${room.name} · ${item.sender_name}`,
      message:item.body,createdAt:item.created_at,
    }))
  })
  return events.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))
}
