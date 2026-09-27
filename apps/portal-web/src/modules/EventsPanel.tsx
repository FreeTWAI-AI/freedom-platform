import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import type { SessionPayload } from '../types';
import { formatIsoLocal, hoursFromNowLocalInput, localInputToIso } from '../format';
import { useModuleMutation } from './shared';
import './MemberExperience.css';

export type CommunityEvent = {
  event_id:string; organizer_ref:string; organizer_name:string; title:string; description:string;
  starts_at:string; ends_at:string; mode:'online'|'in_person'|'hybrid'; location:string;
  capacity:number|null; state:'published'|'cancelled'; aggregate_version:number;
  attending_count:number; my_rsvp:'going'|'cancelled'|null;
};
type EventDraft = {title:string;description:string;starts_at:string;ends_at:string;mode:CommunityEvent['mode'];location:string;capacity:string};
const blank=():EventDraft=>({title:'',description:'',starts_at:hoursFromNowLocalInput(24),ends_at:hoursFromNowLocalInput(25),mode:'online',location:'',capacity:''});
function localTime(iso:string) {
  const date=new Date(iso), local=new Date(date.getTime()-date.getTimezoneOffset()*60_000);
  return local.toISOString().slice(0,16);
}
const fromEvent=(item:CommunityEvent):EventDraft=>({title:item.title,description:item.description,starts_at:localTime(item.starts_at),ends_at:localTime(item.ends_at),mode:item.mode,location:item.location,capacity:item.capacity===null?'':String(item.capacity)});
const payload=(value:EventDraft)=>({...value,starts_at:localInputToIso(value.starts_at),ends_at:localInputToIso(value.ends_at),capacity:value.capacity===''?null:Number(value.capacity)});
const modeLabel:Record<CommunityEvent['mode'],string>={online:'線上',in_person:'實體',hybrid:'線上與實體'};
const participationUrl=(location:string)=>{try{const url=new URL(location);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};

function EventFields({value,onChange}:{value:EventDraft;onChange:(next:EventDraft)=>void}) {
  const set=<K extends keyof EventDraft>(key:K,next:EventDraft[K])=>onChange({...value,[key]:next});
  return <div className="experience-fields">
    <label className="field">活動名稱<input required maxLength={120} value={value.title} onChange={e=>set('title',e.target.value)}/></label>
    <label className="field">活動說明<textarea required maxLength={3000} rows={4} value={value.description} onChange={e=>set('description',e.target.value)}/></label>
    <div className="experience-row"><label className="field">開始時間<input required type="datetime-local" value={value.starts_at} onChange={e=>set('starts_at',e.target.value)}/></label><label className="field">結束時間<input required type="datetime-local" value={value.ends_at} onChange={e=>set('ends_at',e.target.value)}/></label></div>
    <div className="experience-row"><label className="field">形式<select value={value.mode} onChange={e=>set('mode',e.target.value as EventDraft['mode'])}><option value="online">線上</option><option value="in_person">實體</option><option value="hybrid">線上與實體</option></select></label><label className="field">地點或參與連結<input required maxLength={300} value={value.location} onChange={e=>set('location',e.target.value)} placeholder="例如：台北市／視訊會議連結"/></label></div>
    <label className="field">人數上限（留空表示不限）<input type="number" min={1} max={500} value={value.capacity} onChange={e=>set('capacity',e.target.value)}/></label>
  </div>;
}

export function EventsPanel({client,session}:{client:PortalClient;session:SessionPayload}) {
  const [items,setItems]=useState<CommunityEvent[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  const [creating,setCreating]=useState(false),[draft,setDraft]=useState<EventDraft>(blank);
  const [editing,setEditing]=useState<string|null>(null),[editDraft,setEditDraft]=useState<EventDraft>(blank);
  const [notice,setNotice]=useState('');
  const {mutate,busy,error}=useModuleMutation(client);
  const load=useCallback(async()=>{setLoading(true);setLoadError('');try{const result=await client.get<{items:CommunityEvent[]}>('/events');setItems(result.items);}catch(cause){setLoadError(cause instanceof Error?cause.message:'活動暫時無法載入。');}finally{setLoading(false);}},[client]);
  useEffect(()=>{void load();},[load]);
  async function save(event:FormEvent) {
    event.preventDefault();setNotice('');
    const current=items.find(item=>item.event_id===editing);
    const result=current
      ?await mutate<CommunityEvent>(`/events/${current.event_id}/update`,payload(editDraft),current.aggregate_version)
      :await mutate<CommunityEvent>('/events',payload(draft));
    if(result){setCreating(false);setEditing(null);setDraft(blank());setNotice(current?'活動已更新。':'活動已發佈。');await load();}
  }
  async function action(item:CommunityEvent,kind:'cancel'|'rsvp',going=false) {
    setNotice('');
    const result=await mutate<CommunityEvent>(`/events/${item.event_id}/${kind}`,kind==='cancel'?{}:{going},kind==='cancel'?item.aggregate_version:undefined);
    if(result){setNotice(kind==='cancel'?'活動已取消。':going?'報名完成。':'已取消報名。');await load();}
  }
  const upcoming=items.filter(item=>item.state==='published'&&Date.parse(item.ends_at)>Date.now());
  const past=items.filter(item=>item.state!=='published'||Date.parse(item.ends_at)<=Date.now());
  const render=(item:CommunityEvent)=>{
    const started=Date.parse(item.starts_at)<=Date.now(),mine=item.organizer_ref===session.user.user_id;
    const canJoin=item.state==='published'&&!started;
    const link=participationUrl(item.location);
    return <article className="card experience-card" key={item.event_id}>
      <div className="experience-card-head"><div><span className="experience-kicker">{modeLabel[item.mode]} · {item.state==='cancelled'?'已取消':started?'進行中／已結束':'開放報名'}</span><h3>{item.title}</h3></div><span className="experience-count">{item.attending_count}{item.capacity===null?' 人報名':` / ${item.capacity} 人`}</span></div>
      <p>{item.description}</p><dl className="experience-meta"><div><dt>時間</dt><dd>{formatIsoLocal(item.starts_at)} ～ {formatIsoLocal(item.ends_at)}（依裝置時區）</dd></div><div><dt>地點</dt><dd>{link?<a href={link} target="_blank" rel="noopener noreferrer">開啟參與連結 ↗</a>:item.location}</dd></div><div><dt>發佈者</dt><dd>{item.organizer_name}（會員活動）</dd></div></dl>
      <div className="experience-actions">{canJoin&&<button type="button" className={item.my_rsvp==='going'?'btn btn-ghost':'btn btn-primary'} disabled={busy||(item.my_rsvp!=='going'&&item.capacity!==null&&item.attending_count>=item.capacity)} onClick={()=>void action(item,'rsvp',item.my_rsvp!=='going')}>{item.my_rsvp==='going'?'取消報名':item.capacity!==null&&item.attending_count>=item.capacity?'名額已滿':'我要參加'}</button>}{mine&&item.state==='published'&&!started&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{setEditing(item.event_id);setEditDraft(fromEvent(item));setCreating(false);}}>編輯活動</button>}{mine&&item.state==='published'&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void action(item,'cancel')}>取消活動</button>}</div>
      {editing===item.event_id&&<form className="experience-editor" onSubmit={e=>void save(e)}><EventFields value={editDraft} onChange={setEditDraft}/><div className="experience-actions"><button className="btn btn-primary" disabled={busy}>儲存修改</button><button type="button" className="btn btn-ghost" onClick={()=>setEditing(null)}>返回</button></div></form>}
    </article>;
  };
  return <section className="experience-panel stack" aria-label="活動發佈區">
    <div className="experience-intro"><div><p className="eyebrow">MEET / LEARN / BUILD</p><h2>和社群一起碰面、分享、動手做。</h2><p>會員可以發佈活動並管理報名。活動由發佈會員提供；報名不等於實際出席，也不累積貢獻值。</p></div><button type="button" className="btn btn-primary" onClick={()=>{setCreating(v=>!v);setEditing(null);}}>＋ 發佈活動</button></div>
    {creating&&<form className="card experience-editor" onSubmit={e=>void save(e)}><h3>發佈新活動</h3><EventFields value={draft} onChange={setDraft}/><div className="experience-actions"><button className="btn btn-primary" disabled={busy}>確認發佈</button><button type="button" className="btn btn-ghost" onClick={()=>setCreating(false)}>返回</button></div></form>}
    {notice&&<p role="status" className="banner banner-info">{notice}</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}{loadError&&<div role="alert" className="banner banner-error">{loadError}<button className="btn btn-ghost" onClick={()=>void load()}>重試</button></div>}
    {loading&&<p role="status">正在載入活動…</p>}
    {!loading&&<><div className="experience-heading"><h2>即將舉辦</h2><span>{upcoming.length} 場</span></div>{upcoming.length?<div className="experience-grid">{upcoming.map(render)}</div>:<p className="empty">目前沒有即將舉辦的活動。你可以發佈第一場。</p>}{past.length>0&&<details className="experience-history"><summary>查看已結束或取消的活動（{past.length}）</summary><div className="experience-grid">{past.map(render)}</div></details>}</>}
  </section>;
}
