import { useEffect, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import { BrandPoster, CommunityLinks } from './Community';
import { formatIsoLocal } from '../format';
import {EventFields,blankEvent,eventPayload,type EventDraft} from './EventsPanel';
import {NotificationBell} from './NotificationBell';
import {PreviewProfileMenu} from './PreviewProfileMenu';
import {announceInboxChange} from './member-inbox';
import './MemberExperience.css';
import {QuickStart} from './QuickStart';

type PreviewTask = {work_item_id:string;title:string;objective:string;gain:string;claim_window_expires_at:string};
type PreviewEvent = {event_id:string;title:string;starts_at:string;mode:'online'|'in_person'|'hybrid';state:string};
type Catalog = {skill_books:{id:string;title:string;description:string;repository_url:string;upstream_url?:string;introduction_url?:string|null}[]};
const publicRepo=(url:string)=>{try{const parsed=new URL(url);return parsed.protocol==='https:'&&parsed.hostname==='github.com'&&!parsed.username&&!parsed.password?url:null}catch{return null}};
const publicWebsite=(url?:string|null)=>{try{const parsed=new URL(url??'');return parsed.protocol==='https:'&&!parsed.username&&!parsed.password?parsed.href:null}catch{return null}};
export function WelcomePreview({client,name,onStart,onCompleted,onLogout}:{client:PortalClient;name:string;onStart:()=>void;onCompleted:()=>void;onLogout:()=>void}) {
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
  return <main className="welcome-preview"><div className="welcome-preview-top"><BrandPoster compact/><div className="experience-actions"><NotificationBell client={client} onOpen={()=>setNotice('完成定位後即可使用完整通知與訊息頁。')}/><PreviewProfileMenu name={name} onLogout={onLogout}/></div></div>
    <section className="welcome-hero"><p className="eyebrow">帳號已建立 · 下一步</p><h1>{name}，歡迎來到自由工坊。</h1><p>選一個感興趣的公會，就能開始閱讀免費技能書、與夥伴交流和參與工作。公會可以隨時再換或增加。</p></section>
    <QuickStart client={client} onCompleted={onCompleted}/>
    <details className="welcome-optional"><summary>想先探索其他參與方式？</summary><div className="experience-actions"><button type="button" className="btn btn-ghost" onClick={onStart}>開始／繼續定位 →</button><button type="button" className="btn btn-ghost" onClick={()=>setShowForm(value=>!value)}>提交公開活動</button></div><p className="field-hint">定位測驗可稍後補做，不影響快速加入。</p></details>
    {showForm&&<form className="card experience-editor" onSubmit={e=>void submit(e)}><h2>提交公開活動</h2><p>提交後由平台管理員或主辦公會長審核，並在系統公告欄記錄。</p><EventFields value={draft} onChange={setDraft} guilds={guilds}/><div className="experience-actions"><button className="btn btn-primary" disabled={saving}>送出審核</button><button type="button" className="btn btn-ghost" onClick={()=>setShowForm(false)}>返回</button></div></form>}
    {notice&&<p className="banner banner-info" role="status">{notice}</p>}
    {error&&<p role="status" className="banner banner-info">{error}</p>}
    <div className="welcome-preview-grid"><section className="card"><h2>近期活動</h2>{events.length?events.map(item=><article key={item.event_id}><strong>{item.title}</strong><p>{formatIsoLocal(item.starts_at)} · {item.state==='pending'?'我提交的活動，待審核':item.mode==='online'?'線上':'實體／混合'}</p></article>):<p>目前沒有即將舉辦的活動。</p>}</section>
    <section className="card"><h2>可參與的工作</h2>{tasks.length?tasks.map(item=><article key={item.work_item_id}><strong>{item.title}</strong><p>{item.objective}</p></article>):<p>目前沒有開放認領的工作。</p>}</section>
    <section className="card"><h2>免費技能書</h2>{books.length?books.map(book=>{const website=publicWebsite(book.introduction_url),original=publicRepo(book.upstream_url??book.repository_url);return <article key={book.id}><strong>{book.title}</strong><p>{book.description}</p>{original&&<a href={original} target="_blank" rel="noopener noreferrer">開啟原作 ↗</a>}{website&&<a href={website} target="_blank" rel="noopener noreferrer">前往作者網站 ↗</a>}</article>;}):<p>正在整理技能書。</p>}</section></div>
    <p className="welcome-preview-note">選擇主要公會後可進入完整會員工作區；定位測驗可稍後補做。活動報名與任務認領不計分。</p><CommunityLinks/>
  </main>;
}
