import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import type { SessionPayload } from '../types';
import { formatIsoLocal, hoursFromNowLocalInput, localInputToIso } from '../format';
import { useModuleMutation } from './shared';
import {announceInboxChange} from './member-inbox';
import './MemberExperience.css';

export type CommunityEvent = {
  event_id:string; organizer_ref:string; organizer_name:string; title:string; description:string;
  starts_at:string; ends_at:string; mode:'online'|'in_person'|'hybrid'; location:string;
  capacity:number|null; state:'pending'|'published'|'rejected'|'cancelled'; aggregate_version:number;
  attending_count:number; my_rsvp:'going'|'cancelled'|null;guild_key:string|null;can_review:boolean;review_reason:string|null;
};
type Guild={guild_key:string;name:string};
type Bulletin={bulletin_id:string;message:string;created_at:string};
export type EventDraft = {title:string;description:string;starts_at:string;ends_at:string;mode:CommunityEvent['mode'];location:string;capacity:string;guild_key:string};
export const blankEvent=():EventDraft=>({title:'',description:'',starts_at:hoursFromNowLocalInput(24),ends_at:hoursFromNowLocalInput(25),mode:'online',location:'',capacity:'',guild_key:''});
function localTime(iso:string) {
  const date=new Date(iso), local=new Date(date.getTime()-date.getTimezoneOffset()*60_000);
  return local.toISOString().slice(0,16);
}
const fromEvent=(item:CommunityEvent):EventDraft=>({title:item.title,description:item.description,starts_at:localTime(item.starts_at),ends_at:localTime(item.ends_at),mode:item.mode,location:item.location,capacity:item.capacity===null?'':String(item.capacity),guild_key:item.guild_key??''});
export const eventPayload=(value:EventDraft)=>({...value,starts_at:localInputToIso(value.starts_at),ends_at:localInputToIso(value.ends_at),capacity:value.capacity===''?null:Number(value.capacity),guild_key:value.guild_key||null});
const modeLabel:Record<CommunityEvent['mode'],string>={online:'線上',in_person:'實體',hybrid:'線上與實體'};
const participationUrl=(location:string)=>{try{const url=new URL(location);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};

export function EventFields({value,onChange,guilds=[],guildLocked=false}:{value:EventDraft;onChange:(next:EventDraft)=>void;guilds?:Guild[];guildLocked?:boolean}) {
  const set=<K extends keyof EventDraft>(key:K,next:EventDraft[K])=>onChange({...value,[key]:next});
  return <div className="experience-fields">
    <label className="field">活動名稱<input required maxLength={120} value={value.title} onChange={e=>set('title',e.target.value)}/></label>
    <label className="field">活動說明<textarea required maxLength={3000} rows={4} value={value.description} onChange={e=>set('description',e.target.value)}/></label>
    <div className="experience-row"><label className="field">開始時間<input required type="datetime-local" value={value.starts_at} onChange={e=>set('starts_at',e.target.value)}/></label><label className="field">結束時間<input required type="datetime-local" value={value.ends_at} onChange={e=>set('ends_at',e.target.value)}/></label></div>
    <div className="experience-row"><label className="field">形式<select value={value.mode} onChange={e=>set('mode',e.target.value as EventDraft['mode'])}><option value="online">線上</option><option value="in_person">實體</option><option value="hybrid">線上與實體</option></select></label><label className="field">地點或參與連結<input required maxLength={300} value={value.location} onChange={e=>set('location',e.target.value)} placeholder="例如：台北市／視訊會議連結"/></label></div>
    <label className="field">人數上限（留空表示不限）<input type="number" min={1} max={500} value={value.capacity} onChange={e=>set('capacity',e.target.value)}/></label>
    <label className="field">主辦公會與審核者<select value={value.guild_key} disabled={guildLocked} onChange={e=>set('guild_key',e.target.value)}><option value="">不指定公會，由平台管理員審核</option>{guilds.map(guild=><option key={guild.guild_key} value={guild.guild_key}>{guild.name}（由公會長或平台管理員審核）</option>)}</select>{guildLocked&&<small>提交後不能更換審核公會。</small>}</label>
  </div>;
}

export function EventsPanel({client,session}:{client:PortalClient;session:SessionPayload}) {
  const [items,setItems]=useState<CommunityEvent[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  const [creating,setCreating]=useState(false),[draft,setDraft]=useState<EventDraft>(blankEvent);
  const [editing,setEditing]=useState<string|null>(null),[editDraft,setEditDraft]=useState<EventDraft>(blankEvent);
  const [guilds,setGuilds]=useState<Guild[]>([]),[bulletins,setBulletins]=useState<Bulletin[]>([]);
  const [reviewing,setReviewing]=useState<string|null>(null),[reviewReason,setReviewReason]=useState('');
  const [notice,setNotice]=useState('');
  const {mutate,busy,error}=useModuleMutation(client);
  const load=useCallback(async()=>{setLoading(true);setLoadError('');try{const [events,directory,announcements]=await Promise.all([
    client.get<{items:CommunityEvent[]}>('/events'),client.get<{items:Guild[]}>('/guilds/directory'),client.get<{items:Bulletin[]}>('/events/bulletins')]);
    setItems(events.items);setGuilds(directory.items);setBulletins(announcements.items);
  }catch(cause){setLoadError(cause instanceof Error?cause.message:'活動暫時無法載入。');}finally{setLoading(false);}},[client]);
  useEffect(()=>{void load();},[load]);
  async function save(event:FormEvent) {
    event.preventDefault();setNotice('');
    const current=items.find(item=>item.event_id===editing);
    const result=current
      ?await mutate<CommunityEvent>(`/events/${current.event_id}/update`,eventPayload(editDraft),current.aggregate_version)
      :await mutate<CommunityEvent>('/events',eventPayload(draft));
    if(result){setCreating(false);setEditing(null);setDraft(blankEvent());setNotice(current?'活動已更新，仍待審核。':'活動已送出審核，核准後開放報名。');announceInboxChange();window.dispatchEvent(new Event('freedom-world-facts-updated'));await load();}
  }
  async function action(item:CommunityEvent,kind:'cancel'|'rsvp',going=false) {
    setNotice('');
    const result=await mutate<CommunityEvent>(`/events/${item.event_id}/${kind}`,kind==='cancel'?{}:{going},kind==='cancel'?item.aggregate_version:undefined);
    if(result){setNotice(kind==='cancel'?'活動已取消。':going?'報名完成。':'已取消報名。');await load();}
  }
  async function review(item:CommunityEvent,decision:'approve'|'reject'){
    const reason=reviewReason.trim();if(!reason){setNotice('請填寫審核理由。');return;}
    const result=await mutate<CommunityEvent>(`/events/${item.event_id}/review`,{decision,reason},item.aggregate_version);
    if(result){setReviewing(null);setReviewReason('');setNotice(decision==='approve'?'活動已核准並公告。':'活動已退回並通知發佈者。');announceInboxChange();window.dispatchEvent(new Event('freedom-world-facts-updated'));await load();}
  }
  const upcoming=items.filter(item=>item.state==='published'&&Date.parse(item.ends_at)>Date.now());
  const pending=items.filter(item=>item.state==='pending');
  const past=items.filter(item=>item.state==='rejected'||item.state==='cancelled'||item.state==='published'&&Date.parse(item.ends_at)<=Date.now());
  const render=(item:CommunityEvent)=>{
    const started=Date.parse(item.starts_at)<=Date.now(),mine=item.organizer_ref===session.user.user_id;
    const canJoin=item.state==='published'&&!started;
    const link=participationUrl(item.location);
    return <article className="card experience-card" key={item.event_id}>
      <div className="experience-card-head"><div><span className="experience-kicker">{modeLabel[item.mode]} · {item.state==='pending'?'待審核':item.state==='rejected'?'未通過審核':item.state==='cancelled'?'已取消':started?'進行中／已結束':'開放報名'}</span><h3>{item.title}</h3></div>{item.state==='published'&&<span className="experience-count">{item.attending_count}{item.capacity===null?' 人報名':` / ${item.capacity} 人`}</span>}</div>
      <p>{item.description}</p><dl className="experience-meta"><div><dt>時間</dt><dd>{formatIsoLocal(item.starts_at)} ～ {formatIsoLocal(item.ends_at)}（依裝置時區）</dd></div><div><dt>地點</dt><dd>{link?<a href={link} target="_blank" rel="noopener noreferrer">開啟參與連結 ↗</a>:item.location}</dd></div><div><dt>發佈者</dt><dd>{item.organizer_name}（會員活動）</dd></div></dl>
      {item.state==='rejected'&&item.review_reason&&<p className="banner banner-info">審核理由：{item.review_reason}</p>}
      <div className="experience-actions">{canJoin&&<button type="button" className={item.my_rsvp==='going'?'btn btn-ghost':'btn btn-primary'} disabled={busy||(item.my_rsvp!=='going'&&item.capacity!==null&&item.attending_count>=item.capacity)} onClick={()=>void action(item,'rsvp',item.my_rsvp!=='going')}>{item.my_rsvp==='going'?'取消報名':item.capacity!==null&&item.attending_count>=item.capacity?'名額已滿':'我要參加'}</button>}{mine&&item.state==='pending'&&!started&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{setEditing(item.event_id);setEditDraft(fromEvent(item));setCreating(false);}}>編輯草稿</button>}{mine&&(item.state==='pending'||item.state==='published')&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void action(item,'cancel')}>取消活動</button>}{item.can_review&&<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>{setReviewing(item.event_id);setReviewReason('');}}>審核活動</button>}</div>
      {editing===item.event_id&&<form className="experience-editor" onSubmit={e=>void save(e)}><EventFields value={editDraft} onChange={setEditDraft} guilds={guilds} guildLocked/><div className="experience-actions"><button className="btn btn-primary" disabled={busy}>儲存修改</button><button type="button" className="btn btn-ghost" onClick={()=>setEditing(null)}>返回</button></div></form>}
      {reviewing===item.event_id&&<div className="experience-editor"><label className="field">審核理由<textarea required minLength={1} maxLength={500} value={reviewReason} onChange={e=>setReviewReason(e.target.value)}/></label><div className="experience-actions"><button type="button" className="btn btn-primary" disabled={busy||!reviewReason.trim()} onClick={()=>void review(item,'approve')}>核准並公告</button><button type="button" className="btn btn-ghost" disabled={busy||!reviewReason.trim()} onClick={()=>void review(item,'reject')}>退回</button><button type="button" className="btn btn-ghost" onClick={()=>setReviewing(null)}>返回</button></div></div>}
    </article>;
  };
  return <section className="experience-panel stack" aria-label="活動發佈區">
    <div className="experience-intro"><div><p className="eyebrow">MEET / LEARN / BUILD</p><h2>和社群一起碰面、分享、動手做。</h2><p>任何已登入會員都能提交公開活動。平台管理員或主辦公會長核准後開放報名；提交與核准都會進系統公告欄並發通知。</p></div><button type="button" className="btn btn-primary" onClick={()=>{setCreating(v=>!v);setEditing(null);}}>＋ 提交活動</button></div>
    {creating&&<form className="card experience-editor" onSubmit={e=>void save(e)}><h3>提交公開活動</h3><EventFields value={draft} onChange={setDraft} guilds={guilds}/><div className="experience-actions"><button className="btn btn-primary" disabled={busy}>送出審核</button><button type="button" className="btn btn-ghost" onClick={()=>setCreating(false)}>返回</button></div></form>}
    {notice&&<p role="status" className="banner banner-info">{notice}</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}{loadError&&<div role="alert" className="banner banner-error">{loadError}<button className="btn btn-ghost" onClick={()=>void load()}>重試</button></div>}
    {loading&&<p role="status">正在載入活動…</p>}
    {!loading&&<>{pending.length>0&&<><div className="experience-heading"><h2>待審核活動</h2><span>{pending.length} 場</span></div><div className="experience-grid">{pending.map(render)}</div></>}
      <div className="experience-heading"><h2>即將舉辦</h2><span>{upcoming.length} 場</span></div>{upcoming.length?<div className="experience-grid">{upcoming.map(render)}</div>:<p className="empty">目前沒有即將舉辦的活動。你可以提交第一場。</p>}
      {past.length>0&&<details className="experience-history"><summary>查看已結束、取消或退回的活動（{past.length}）</summary><div className="experience-grid">{past.map(render)}</div></details>}
      <div className="experience-heading"><h2>系統公告欄</h2><span>最近 {bulletins.length} 則</span></div>{bulletins.length?<ol className="experience-bulletins">{bulletins.map(item=><li key={item.bulletin_id}><span>{item.message}</span><time dateTime={item.created_at}>{formatIsoLocal(item.created_at)}</time></li>)}</ol>:<p className="empty">目前沒有活動公告。</p>}
    </>}
  </section>;
}
