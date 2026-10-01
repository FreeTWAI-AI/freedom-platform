import {useEffect,useState,type FormEvent} from 'react';
import type {PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import './PublicEventPage.css';

type PublicEvent={event_id:string;title:string;description:string;starts_at:string;ends_at:string;mode:'online'|'in_person'|'hybrid';location:string;online_url:string|null;event_kind:string;topic:string|null;visibility:'referral'|'open';capacity:number|null;attending_count:number;organizer_name:string;banner_url:string|null;video_url:string|null;video_mime:'video/mp4'|'video/webm'|null};
const safeUrl=(value:string|null)=>{try{const url=new URL(value??'');return url.protocol==='https:'&&!url.username&&!url.password?url.href:null}catch{return null}};
const savedCode=(id:string)=>{
  const match=/^#events\/([0-9a-f-]{36})(?:\?(.*))?$/.exec(window.location.hash);
  const pathId=/^\/events\/([0-9a-f-]{36})\/?$/.exec(window.location.pathname)?.[1];
  const linkCode=match?.[1]===id?new URLSearchParams(match[2]??'').get('ref'):pathId===id?new URLSearchParams(window.location.search).get('ref'):null;
  if(linkCode&&/^[A-Za-z0-9_-]{16,32}$/.test(linkCode))try{localStorage.setItem(`freedom-event-referral:${id}`,linkCode)}catch{/* Link stays usable. */}
  try{return linkCode??localStorage.getItem(`freedom-event-referral:${id}`)}catch{return linkCode}
};

export function PublicEventPage({client,id,onLogin}:{client:PortalClient;id:string;onLogin:()=>void}){
  const [event,setEvent]=useState<PublicEvent|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState('');
  const [name,setName]=useState(''),[email,setEmail]=useState(''),[saving,setSaving]=useState(false),[notice,setNotice]=useState('');
  const [code,setCode]=useState(()=>savedCode(id));
  useEffect(()=>{setCode(savedCode(id));let active=true;setLoading(true);setError('');void client.get<PublicEvent>(`/public/events/${id}`,{skipAuthHandler:true}).then(value=>{if(active)setEvent(value)}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:'活動暫時無法載入。')}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[client,id]);
  async function register(e:FormEvent){e.preventDefault();if(!event||saving)return;setSaving(true);setError('');try{await client.post(`/public/events/${id}/register`,{name,email,referral_code:code},{skipAuthHandler:true});setNotice('報名資料已送出，參與資訊已寄到你的 Email。請檢查收件匣。');}
    catch(cause){setError(cause instanceof Error?cause.message:'報名未完成，請稍後再試。')}finally{setSaving(false)}}
  const started=Boolean(event&&Date.parse(event.starts_at)<=Date.now()),ended=Boolean(event&&Date.parse(event.ends_at)<=Date.now()),full=Boolean(event&&event.capacity!==null&&event.attending_count>=event.capacity);
  const locationLink=safeUrl(event?.location??null),onlineLink=safeUrl(event?.online_url??null);
  return <div className="public-event-page"><header><img src="/brand/freedom-workshop.webp" alt="自由工坊"/><button type="button" className="btn btn-ghost" onClick={onLogin}>會員登入</button></header><main className="public-event-content">
    {loading&&<p role="status">正在載入活動…</p>}
    {!loading&&!event&&<div className="card stack"><h1>活動目前無法公開查看</h1><p>{error||'請從會員分享的連結開啟，或登入工坊查看。'}</p><button type="button" className="btn btn-primary" onClick={onLogin}>前往會員入口</button></div>}
    {event&&<article className="card public-event-card"><p className="eyebrow">社群活動 · {event.visibility==='referral'?'推薦連結公開':'完全公開'}</p>{ended&&<span className="event-ended-badge">已結束</span>}<h1>{event.title}</h1><p className="muted">由 {event.organizer_name} 發起</p>{event.banner_url&&<img className="public-event-poster" src={event.banner_url} alt="活動海報"/>}{event.video_url&&<video className="public-event-poster" controls preload="metadata" aria-label={`${event.title} 的活動影片`}><source src={event.video_url} type={event.video_mime??undefined}/></video>}
      {event.topic&&<p><strong>主題：</strong>{event.topic}</p>}<p className="public-event-description">{event.description}</p>
      <dl className="public-event-meta"><div><dt>時間</dt><dd>{formatIsoLocal(event.starts_at)} ～ {formatIsoLocal(event.ends_at)}（依裝置時區）</dd></div><div><dt>地點</dt><dd>{locationLink?<a href={locationLink} target="_blank" rel="noopener noreferrer">開啟地點連結</a>:event.location}</dd></div>{onlineLink&&<div><dt>線上參與</dt><dd><a href={onlineLink} target="_blank" rel="noopener noreferrer">開啟線上連結</a></dd></div>}</dl>
      <p className="muted">{event.attending_count}{event.capacity===null?' 人已報名':` / ${event.capacity} 人已報名`}</p>
      {!started&&!full&&<form className="public-event-register" onSubmit={e=>void register(e)}><h2>報名活動</h2>{event.visibility==='referral'&&!code&&<p className="banner banner-info">這場活動須從會員分享的連結報名，請向分享者取得連結。</p>}<label className="field">你的名字<input required maxLength={80} value={name} onChange={e=>setName(e.target.value)}/></label><label className="field">接收參與資料的 Email<input required type="email" maxLength={200} value={email} onChange={e=>setEmail(e.target.value)}/></label><p className="field-hint">活動參與資訊會寄到這個信箱。分享碼已包含在連結中，無須手動輸入。</p><button className="btn btn-primary" disabled={saving||Boolean(notice)||event.visibility==='referral'&&!code}>{saving?'寄送中…':'報名並寄送參與資料'}</button></form>}
      {full&&!started&&<p className="banner banner-info">活動名額已滿。</p>}{started&&!ended&&<p className="banner banner-info">活動已開始，報名已結束。</p>}{notice&&<p role="status" className="banner banner-info">{notice}</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}
    </article>}
  </main></div>;
}
