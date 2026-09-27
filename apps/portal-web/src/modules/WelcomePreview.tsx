import { useEffect, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import { BrandPoster, CommunityLinks } from './Community';
import { formatIsoLocal } from '../format';
import {EventFields,blankEvent,eventPayload,type EventDraft} from './EventsPanel';
import {NotificationBell} from './NotificationBell';
import {announceInboxChange} from './member-inbox';
import './MemberExperience.css';

type PreviewTask = {work_item_id:string;title:string;objective:string;gain:string;claim_window_expires_at:string};
type PreviewEvent = {event_id:string;title:string;starts_at:string;mode:'online'|'in_person'|'hybrid';state:string};
type Catalog = {skill_books:{id:string;title:string;description:string;repository_url:string}[]};
const publicRepo=(url:string)=>{try{const parsed=new URL(url);return parsed.protocol==='https:'&&parsed.hostname==='github.com'&&!parsed.username&&!parsed.password?url:null}catch{return null}};
export function WelcomePreview({client,name,onStart,onLogout}:{client:PortalClient;name:string;onStart:()=>void;onLogout:()=>void}) {
  const [events,setEvents]=useState<PreviewEvent[]>([]),[tasks,setTasks]=useState<PreviewTask[]>([]),[books,setBooks]=useState<Catalog['skill_books']>([]),[error,setError]=useState('');
  const [guilds,setGuilds]=useState<{guild_key:string;name:string}[]>([]),[draft,setDraft]=useState<EventDraft>(blankEvent),[showForm,setShowForm]=useState(false),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  useEffect(()=>{let active=true;void Promise.allSettled([client.get<{items:PreviewEvent[]}>('/events'),client.get<{items:PreviewTask[]}>('/task-board/preview'),client.get<Catalog>('/community')]).then(results=>{if(!active)return;
    if(results[0].status==='fulfilled')setEvents(results[0].value.items.filter(item=>item.state==='published'&&Date.parse(item.starts_at)>Date.now()).slice(0,3));
    if(results[1].status==='fulfilled')setTasks(results[1].value.items.slice(0,3));
    if(results[2].status==='fulfilled')setBooks(results[2].value.skill_books.slice(0,3));
    if(results.some(result=>result.status==='rejected'))setError('部分社群內容暫時無法載入，你仍可繼續探索。');
  });return()=>{active=false;};},[client]);
  useEffect(()=>{void client.get<{items:{guild_key:string;name:string}[]}>('/guilds/directory').then(value=>setGuilds(value.items)).catch(()=>setError('公會清單暫時無法載入；你仍可由平台管理員審核活動。'));},[client]);
  async function submit(event:FormEvent){event.preventDefault();setSaving(true);setError('');try{await client.post('/events',eventPayload(draft),{idempotencyKey:crypto.randomUUID()});setNotice('活動已送出審核；核准後才會開放報名。');setDraft(blankEvent());setShowForm(false);announceInboxChange();const page=await client.get<{items:PreviewEvent[]}>('/events');setEvents(page.items.slice(0,3));}catch(cause){setError(cause instanceof Error?cause.message:'活動未能送出，請重試。');}finally{setSaving(false);}}
  return <main className="welcome-preview"><div className="welcome-preview-top"><BrandPoster compact/><div className="experience-actions"><NotificationBell client={client} onOpen={()=>setNotice('完成定位後即可使用完整通知與訊息頁。')}/><button type="button" className="btn btn-ghost" onClick={onLogout}>登出</button></div></div>
    <section className="welcome-hero"><p className="eyebrow">WELCOME TO FREEDOM WORKSHOP</p><h1>{name}，歡迎來到自由工坊。</h1><p>帳號已建立。先看看社群正在做什麼；現在也可以提交公開活動。想認領工作或認識公會夥伴時，再完成定位與選擇公會。進度可以分段保存。</p><div className="experience-actions"><button type="button" className="btn btn-primary" onClick={onStart}>開始／繼續定位 →</button><button type="button" className="btn btn-ghost" onClick={()=>setShowForm(value=>!value)}>提交公開活動</button></div></section>
    {showForm&&<form className="card experience-editor" onSubmit={e=>void submit(e)}><h2>提交公開活動</h2><p>提交後由平台管理員或主辦公會長審核，並在系統公告欄記錄。</p><EventFields value={draft} onChange={setDraft} guilds={guilds}/><div className="experience-actions"><button className="btn btn-primary" disabled={saving}>送出審核</button><button type="button" className="btn btn-ghost" onClick={()=>setShowForm(false)}>返回</button></div></form>}
    {notice&&<p className="banner banner-info" role="status">{notice}</p>}
    {error&&<p role="status" className="banner banner-info">{error}</p>}
    <div className="welcome-preview-grid"><section className="card"><h2>近期活動</h2>{events.length?events.map(item=><article key={item.event_id}><strong>{item.title}</strong><p>{formatIsoLocal(item.starts_at)} · {item.state==='pending'?'我提交的活動，待審核':item.mode==='online'?'線上':'實體／混合'}</p></article>):<p>目前沒有即將舉辦的活動。</p>}</section>
    <section className="card"><h2>可參與的工作</h2>{tasks.length?tasks.map(item=><article key={item.work_item_id}><strong>{item.title}</strong><p>{item.objective}</p></article>):<p>目前沒有開放認領的工作。</p>}</section>
    <section className="card"><h2>免費技能書</h2>{books.length?books.map(book=><article key={book.id}><strong>{book.title}</strong><p>{book.description}</p>{publicRepo(book.repository_url)&&<a href={book.repository_url} target="_blank" rel="noopener noreferrer">閱讀技能書 ↗</a>}</article>):<p>正在整理技能書。</p>}</section></div>
    <p className="welcome-preview-note">這裡顯示公開探索資訊與你提交的活動；完成定位後可進入完整會員工作區。活動報名與任務認領不計分。</p><CommunityLinks/>
  </main>;
}
