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
import {useLanguage} from '../language';

type PreviewTask = {work_item_id:string;title:string;objective:string;gain:string;claim_window_expires_at:string};
type PreviewEvent = {event_id:string;title:string;starts_at:string;mode:'online'|'in_person'|'hybrid';state:string};
type Catalog = {skill_books:{id:string;title:string;description:string;repository_url:string;upstream_url?:string;introduction_url?:string|null}[]};
const publicRepo=(url:string)=>{try{const parsed=new URL(url);return parsed.protocol==='https:'&&parsed.hostname==='github.com'&&!parsed.username&&!parsed.password?url:null}catch{return null}};
const publicWebsite=(url?:string|null)=>{try{const parsed=new URL(url??'');return parsed.protocol==='https:'&&!parsed.username&&!parsed.password?parsed.href:null}catch{return null}};
export function WelcomePreview({client,name,entryLabel,onStart,onCompleted,onLogout}:{client:PortalClient;name:string;entryLabel?:string;onStart:()=>void;onCompleted:()=>void;onLogout:()=>void}) {
  const {language,t}=useLanguage();
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
  return <main className="welcome-preview"><div className="welcome-preview-top"><BrandPoster compact/><div className="experience-actions"><NotificationBell client={client} onOpen={()=>setNotice('選擇主要公會、完成加入後即可使用完整通知與訊息頁。')}/><PreviewProfileMenu name={name} onLogout={onLogout}/></div></div>
    <section className="welcome-hero"><p className="eyebrow">{t('welcome.next')}</p><h1>{t('welcome.title',{name})}</h1><p>{t('welcome.intro')}</p>{entryLabel&&<p className="field-hint">{t('welcome.destination',{destination:entryLabel})}</p>}</section>
    <QuickStart client={client} onCompleted={onCompleted}/>
    <details className="welcome-optional"><summary>{t('welcome.optional')}</summary><div className="experience-actions"><button type="button" className="btn btn-ghost" onClick={onStart}>{t('welcome.assessment')}</button><button type="button" className="btn btn-ghost" onClick={()=>setShowForm(value=>!value)}>{t('welcome.event')}</button></div><p className="field-hint">{t('welcome.assessmentOptional')}</p></details>
    {showForm&&<form className="card experience-editor" onSubmit={e=>void submit(e)}><h2>提交公開活動</h2><p>提交後由平台管理員或主辦公會長審核，並在系統公告欄記錄。</p><EventFields value={draft} onChange={setDraft} guilds={guilds}/><div className="experience-actions"><button className="btn btn-primary" disabled={saving}>送出審核</button><button type="button" className="btn btn-ghost" onClick={()=>setShowForm(false)}>返回</button></div></form>}
    {notice&&<p className="banner banner-info" role="status">{notice}</p>}
    {error&&<p role="status" className="banner banner-info">{language==='zh-Hant'?error:t('error.generic')}</p>}
    <div className="welcome-preview-grid"><section className="card"><h2>{t('welcome.events')}</h2>{events.length?events.map(item=><article key={item.event_id} lang="zh-Hant"><strong>{item.title}</strong><p>{formatIsoLocal(item.starts_at)} · {item.state==='pending'?'我提交的活動，待審核':item.mode==='online'?'線上':'實體／混合'}</p></article>):<p>{t('welcome.noEvents')}</p>}</section>
    <section className="card"><h2>{t('welcome.tasks')}</h2>{tasks.length?tasks.map(item=><article key={item.work_item_id} lang="zh-Hant"><strong>{item.title}</strong><p className="multiline-text">{item.objective}</p></article>):<p>{t('welcome.noTasks')}</p>}</section>
    <section className="card"><h2>{t('welcome.books')}</h2>{books.length?books.map(book=>{const website=publicWebsite(book.introduction_url),original=publicRepo(book.upstream_url??book.repository_url);return <article key={book.id}><strong lang="zh-Hant">{book.title}</strong><p lang="zh-Hant">{book.description}</p>{original&&<a href={original} target="_blank" rel="noopener noreferrer">{t('welcome.original')}</a>}{website&&<a href={website} target="_blank" rel="noopener noreferrer">{t('welcome.website')}</a>}</article>;}):<p>{t('welcome.noBooks')}</p>}</section></div>
    <p className="welcome-preview-note">{t('welcome.note')}</p>{language!=='zh-Hant'&&<p className="field-hint">{t('language.scope')}</p>}<CommunityLinks/>
  </main>;
}
