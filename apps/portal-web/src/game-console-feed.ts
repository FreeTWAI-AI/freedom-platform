import type {PortalClient} from './api'
import {createConsoleEvent, type GameConsoleEvent} from './game-console-core'
import {bulletinConsoleChannel, consoleChannel, githubConsoleChannel, githubConsoleMessage, notificationConsoleChannel} from './game-console-routing'

type Notice = {notification_id:string;kind?:string;title:string;body:string;created_at:string;read_at:string|null}
type Announcement = {announcement_id:string;title:string;body:string;guild_name:string;updated_at:string}
type PublishedSkill = {submission_id:string;title:string;published_at:string}
type Project = {project_id:string;title:string;created_at?:string;source_kind:'member_project'|'community_pilot'}
type Page<T> = {items:T[]}
type GitHubEvents={items:{id:string;number:number|null;title:string;url:string;actor:string;created_at:string;kind:string}[]}
type EventBulletin={bulletin_id:string;kind?:string;message:string;created_at:string}
type AcceptedWork={contribution_id:string;title:string;member_name:string;accepted_at:string}

/** Activity and public announcements only. Chat bodies are read by an explicitly selected room. */
export async function readConsoleFeed(client:PortalClient, _userId:string, includeWorld=true,preferencesEnabled=false):Promise<GameConsoleEvent[]> {
  const load=async<T,>(path:string):Promise<Page<T>>=>{
    try{return await client.get<Page<T>>(path,{background:true})}catch{return {items:[]}}
  }
  const [notices,announcements,skills,projects,github,eventBulletins,acceptedWork,following] = await Promise.all([
    load<Notice>(preferencesEnabled?'/me/notification-preferences/reminders':'/me/notifications?limit=20&offset=0'),
    includeWorld?load<Announcement>('/me/guild-announcements'):Promise.resolve({items:[] as Announcement[]}),
    includeWorld?load<PublishedSkill>('/skill-submissions/published?limit=10'):Promise.resolve({items:[] as PublishedSkill[]}),
    includeWorld?load<Project>('/co-creation/projects'):Promise.resolve({items:[] as Project[]}),
    includeWorld?load<GitHubEvents['items'][number]>('/pages/github-events'):Promise.resolve({items:[] as GitHubEvents['items']}),
    includeWorld?load<EventBulletin>(preferencesEnabled?'/me/notification-preferences/event-reminders':'/events/bulletins'):Promise.resolve({items:[] as EventBulletin[]}),
    includeWorld?load<AcceptedWork>('/community/accepted-work'):Promise.resolve({items:[] as AcceptedWork[]}),
    preferencesEnabled?client.get<{items:{id:string;title:string;path:string}[];generated_at:string}>('/me/notification-preferences/following-reminders',{background:true}).catch(()=>null):Promise.resolve(null),
  ])
  const events = notices.items.filter(item=>item.read_at===null).map(item=>createConsoleEvent({
    id:`notice:${item.notification_id}`,channel:notificationConsoleChannel(item.kind),kind:'status',source:'通知',
    message:item.title,detail:item.body,createdAt:item.created_at,
  }))
  for(const item of following?.items??[])events.push(createConsoleEvent({
    id:`following:${item.id}`,channel:notificationConsoleChannel(undefined),kind:'status',source:'追蹤更新',
    message:item.title,detail:item.path,createdAt:following!.generated_at,
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
  return events.sort((a,b)=>a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))
}
