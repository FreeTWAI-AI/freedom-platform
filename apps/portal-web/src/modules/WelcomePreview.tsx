import { useEffect, useState } from 'react';
import type { PortalClient } from '../api';
import { BrandPoster, CommunityLinks } from './Community';
import { formatIsoLocal } from '../format';
import './MemberExperience.css';

type PreviewTask = {work_item_id:string;title:string;objective:string;gain:string;claim_window_expires_at:string};
type PreviewEvent = {event_id:string;title:string;starts_at:string;mode:'online'|'in_person'|'hybrid';state:string};
type Catalog = {skill_books:{id:string;title:string;description:string;repository_url:string}[]};
const publicRepo=(url:string)=>{try{const parsed=new URL(url);return parsed.protocol==='https:'&&parsed.hostname==='github.com'&&!parsed.username&&!parsed.password?url:null}catch{return null}};
export function WelcomePreview({client,name,onStart,onLogout}:{client:PortalClient;name:string;onStart:()=>void;onLogout:()=>void}) {
  const [events,setEvents]=useState<PreviewEvent[]>([]),[tasks,setTasks]=useState<PreviewTask[]>([]),[books,setBooks]=useState<Catalog['skill_books']>([]),[error,setError]=useState('');
  useEffect(()=>{let active=true;void Promise.allSettled([client.get<{items:PreviewEvent[]}>('/events'),client.get<{items:PreviewTask[]}>('/task-board/preview'),client.get<Catalog>('/community')]).then(results=>{if(!active)return;
    if(results[0].status==='fulfilled')setEvents(results[0].value.items.filter(item=>item.state==='published'&&Date.parse(item.starts_at)>Date.now()).slice(0,3));
    if(results[1].status==='fulfilled')setTasks(results[1].value.items.slice(0,3));
    if(results[2].status==='fulfilled')setBooks(results[2].value.skill_books.slice(0,3));
    if(results.some(result=>result.status==='rejected'))setError('部分社群內容暫時無法載入，你仍可繼續探索。');
  });return()=>{active=false;};},[client]);
  return <main className="welcome-preview"><div className="welcome-preview-top"><BrandPoster compact/><button type="button" className="btn btn-ghost" onClick={onLogout}>登出</button></div>
    <section className="welcome-hero"><p className="eyebrow">WELCOME TO FREEDOM WORKSHOP</p><h1>{name}，歡迎來到自由工坊。</h1><p>帳號已建立。先看看社群正在做什麼；想認領工作、發佈活動或認識公會夥伴時，再完成定位與選擇公會。進度可以分段保存。</p><button type="button" className="btn btn-primary" onClick={onStart}>開始／繼續定位 →</button></section>
    {error&&<p role="status" className="banner banner-info">{error}</p>}
    <div className="welcome-preview-grid"><section className="card"><h2>近期活動</h2>{events.length?events.map(item=><article key={item.event_id}><strong>{item.title}</strong><p>{formatIsoLocal(item.starts_at)} · {item.mode==='online'?'線上':'實體／混合'}</p></article>):<p>目前沒有即將舉辦的活動。</p>}</section>
    <section className="card"><h2>可參與的工作</h2>{tasks.length?tasks.map(item=><article key={item.work_item_id}><strong>{item.title}</strong><p>{item.objective}</p></article>):<p>目前沒有開放認領的工作。</p>}</section>
    <section className="card"><h2>免費技能書</h2>{books.length?books.map(book=><article key={book.id}><strong>{book.title}</strong><p>{book.description}</p>{publicRepo(book.repository_url)&&<a href={book.repository_url} target="_blank" rel="noopener noreferrer">閱讀技能書 ↗</a>}</article>):<p>正在整理技能書。</p>}</section></div>
    <p className="welcome-preview-note">這裡只顯示公開探索資訊；完成定位後，才能進入完整會員工作區。活動報名與任務認領都不會自動產生貢獻值。</p><CommunityLinks/>
  </main>;
}
