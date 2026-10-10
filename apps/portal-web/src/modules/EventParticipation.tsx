import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ApiError,type PortalClient,type RequestOptions} from '../api';
import type {SessionPayload} from '../types';
import {formatIsoLocal,localInputToIso} from '../format';
import './EventParticipation.css';

export type EventParticipationDTO={
  event_id:string;event_version:number;event_state:'pending'|'published'|'rejected'|'cancelled';starts_at:string;waitlist_enabled:boolean;response_window_minutes:number|null;
  rsvp_state:'pending'|'going'|'cancelled'|null;available_seats:number|null;
  waitlist:null|{status:'queued'|'invited'|'accepted'|'declined'|'left'|'expired'|'cancelled';aggregate_version:number;joined_at:string;invited_at:string|null;expires_at:string|null;delivery_status:string};
};
export type EventReminderDTO={version:number;enabled:boolean;minutes_before_start:number|null;channel:'in_app'|'email'|null;status:'pending'|'provider_accepted'|'recorded'|'cancelled'|'failed'|null};
export type EventParticipationProps={client:PortalClient;session:SessionPayload;eventId:string;eventVersion:number;rsvpState?:'going'|'cancelled'|null;referralCode?:string|null;onChanged?:()=>void};
export type GuestEventParticipationProps={client:PortalClient;id:string;referralCode?:string|null};
export type OrganizerParticipationEvent={event_id:string;aggregate_version:number;starts_at:string;ends_at:string;capacity:number|null;state:string};
export type EventParticipationOrganizerProps={client:PortalClient;session:SessionPayload;event:OrganizerParticipationEvent;onChanged?:()=>void};

/** The private email capability is read only from a fragment, never a query or storage. */
export function readEventParticipationToken(hash=window.location.hash):string|null{
  const match=/^#participation=([A-Za-z0-9_-]{43})$/.exec(hash);
  return match?.[1]??null;
}
const positive=(value:string)=>/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))&&Number(value)>0;
const options=(token:string|null):Omit<RequestOptions,'body'>=>token?{eventParticipationToken:token,skipAuthHandler:true,suppressConsole:true}:{suppressConsole:true};
type FrozenRequest={method:'POST'|'PATCH';path:string;body:unknown;key:string;version?:number};

// An unknown outcome blocks newer commands until this exact command is retried.
// Draft inputs remain editable; acknowledgements and reloads never replace them.
function useParticipationTransport(client:PortalClient,scope:string,token:string|null){
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[stale,setStale]=useState(false),[retry,setRetry]=useState(false),[notice,setNotice]=useState(''),[receipt,setReceipt]=useState<unknown>(null);
  const pending=useRef<FrozenRequest|null>(null),inFlight=useRef(false),generation=useRef(0);
  const readSequence=useRef<Record<string,number>>({});
  const controllers=useRef<AbortController[]>([]);
  useEffect(()=>{generation.current++;pending.current=null;inFlight.current=false;setBusy(false);setRetry(false);setStale(false);setError('');setNotice('');setReceipt(null);return()=>{generation.current++;for(const controller of controllers.current)controller.abort();controllers.current=[];}},[client,scope,token]);
  const get=useCallback(async<T,>(path:string):Promise<T|undefined>=>{
    const epoch=generation.current,csrf=path.startsWith('/public/')?null:client.csrfToken,controller=new AbortController();controllers.current.push(controller);
    const sequence=(readSequence.current[path]??0)+1;readSequence.current[path]=sequence;
    try{const value=await client.get<T>(path,{...options(token),...(path.startsWith('/public/')?{skipAuthHandler:true}:{}),signal:controller.signal});if(epoch===generation.current&&(csrf===null||csrf===client.csrfToken)&&sequence===readSequence.current[path])return value;}
    catch(cause){if(epoch===generation.current&&(csrf===null||csrf===client.csrfToken)&&sequence===readSequence.current[path]&&!controller.signal.aborted)setError(token?'無法讀取私人參與資料，請確認信箱中的管理連結仍有效。':cause instanceof Error?cause.message:'資料無法載入，請重試。');}
    finally{controllers.current=controllers.current.filter(item=>item!==controller);}
  },[client,token]);
  async function send(request:FrozenRequest):Promise<boolean>{
    if(inFlight.current||stale)return false;
    const epoch=generation.current,csrf=request.path.startsWith('/public/')?null:client.csrfToken,controller=new AbortController();controllers.current.push(controller);inFlight.current=true;setBusy(true);setError('');setNotice('');
    try{
      const requestOptions={...options(token),...(request.path.startsWith('/public/')?{skipAuthHandler:true}:{}),idempotencyKey:request.key,ifMatch:request.version,signal:controller.signal};
      const result=await (request.method==='PATCH'?client.patch(request.path,request.body,requestOptions):client.post(request.path,request.body,requestOptions));
      if(epoch!==generation.current||csrf!==null&&csrf!==client.csrfToken)return false;
      pending.current=null;setReceipt(result);setRetry(false);setNotice('操作已確認；未送出的欄位仍保留。');return true;
    }catch(cause){
      if(epoch!==generation.current||csrf!==null&&csrf!==client.csrfToken||controller.signal.aborted)return false;
      const uncertain=!(cause instanceof ApiError)||cause.network||cause.status>=500;
      pending.current=uncertain?request:null;setRetry(uncertain);
      if(cause instanceof ApiError&&cause.status===412&&request.version!==undefined){setStale(true);setError('資料已由其他操作更新。請先重新載入最新狀態；你的輸入會保留，再確認送出。');}
      else setError(token?'私人參與操作未確認。管理連結可能失效或活動資格已變更；請重試或重新取得管理信。':cause instanceof Error?cause.message:'操作結果尚未確認，請重試原操作。');
      return false;
    }finally{controllers.current=controllers.current.filter(item=>item!==controller);if(epoch===generation.current&&(csrf===null||csrf===client.csrfToken)){inFlight.current=false;setBusy(false);}}
  }
  async function mutate(method:FrozenRequest['method'],path:string,body:Record<string,unknown>,version?:number){
    if(pending.current||inFlight.current||stale)return false;
    const key=crypto.randomUUID();
    const frozen={...body,...(token?{...(path.endsWith('/reminder')?{command_id:key}:{}),...(version!==undefined?{expected_version:version}:{})}:{})};
    return send({method,path,body:frozen,key,version});
  }
  return {get,mutate,busy,error,stale,retry,notice,receipt,blocked:busy||retry||stale,
    retryCommand:()=>pending.current?send(pending.current):Promise.resolve(false),
    reloaded:()=>{setStale(false);setError('');},setNotice};
}
type Transport={get:<T>(path:string)=>Promise<T|undefined>;mutate:(method:'POST'|'PATCH',path:string,body:Record<string,unknown>,version?:number)=>Promise<boolean>;busy:boolean;error:string;stale:boolean;retry:boolean;notice:string;receipt:unknown;blocked:boolean;retryCommand:()=>Promise<boolean>;reloaded:()=>void;setNotice:(value:string)=>void};
function Feedback({transport,reload}:{transport:Transport;reload?:()=>Promise<void>}){
  return <>
    {transport.notice&&<p role="status" className="field-hint">{transport.notice}</p>}
    {transport.error&&<p role="alert" className="banner banner-error">{transport.error}</p>}
    {transport.retry&&<button type="button" className="btn btn-ghost btn-small" disabled={transport.busy} onClick={()=>void transport.retryCommand().then(ok=>{if(ok&&reload)void reload();})}>重試原操作（保留原內容）</button>}
    {transport.stale&&reload&&<button type="button" className="btn btn-ghost btn-small" disabled={transport.busy} onClick={()=>void reload()}>載入最新狀態並保留輸入</button>}
  </>;
}
async function downloadCalendar(transport:Transport,path:string){
  const value=await transport.get<{calendar:string;filename:string}>(path);if(!value)return;
  const blob=new Blob([value.calendar],{type:'text/calendar;charset=utf-8'}),url=URL.createObjectURL(blob),anchor=document.createElement('a');
  anchor.href=url;anchor.download=value.filename.replace(/[\\/\r\n]/g,'_');document.body.append(anchor);anchor.click();anchor.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function ParticipationState({value,transport,action}:{value:EventParticipationDTO;transport:Transport;action:(action:string)=>void}){
  const own=value.waitlist,now=Date.now(),liveInvitation=own?.status==='invited'&&own.expires_at!==null&&Date.parse(own.expires_at)>now,active=own?.status==='queued'||liveInvitation,open=value.event_state==='published'&&Date.parse(value.starts_at)>now;
  return <div className="stack">
    <p>你的報名：{value.rsvp_state==='going'?'已報名':value.rsvp_state==='pending'?'郵件與報名尚未確認':value.rsvp_state==='cancelled'?'已取消':'尚未報名'}。{value.available_seats===0?'目前名額已滿。':value.available_seats===null?'名額不限。':`目前可用名額 ${value.available_seats}。`}</p>
    {!open&&<p className="field-hint">{value.event_state==='cancelled'?'活動已取消。':'活動目前不開放新的報名或候補。'}</p>}
    {own?.status==='invited'&&<p className="field-hint">邀請通知：{own.delivery_status==='provider_accepted'?'Email 服務已接受；不代表已送達':own.delivery_status==='recorded'?'站內通知已建立':own.delivery_status==='pending'?'等待寄送或通知':own.delivery_status==='failed'?'通知未確認送出':'通知結果尚未確認'}。</p>}
    {own&&<p role="status">{{queued:'候補中',invited:'已獲得名額邀請，尚未報名',accepted:'已接受邀請',declined:'已婉拒邀請',left:'已離開候補',expired:'邀請已逾期',cancelled:'候補已取消'}[own.status]}；原始加入時間：{formatIsoLocal(own.joined_at)}。候補依原始加入時間依序邀請，不會自動報名。{own.expires_at&&<> 回覆期限：<time dateTime={own.expires_at}>{formatIsoLocal(own.expires_at)}</time>（依裝置時區）。</>}</p>}
    {own?.status==='invited'&&!liveInvitation&&<p className="field-hint">邀請期限已過；請更新本人狀態，或依目前規則重新加入候補。</p>}
    {liveInvitation&&open&&<div className="experience-actions"><button type="button" className="btn btn-ghost btn-small" disabled={transport.blocked} onClick={()=>action('accept')}>接受邀請並報名</button><button type="button" className="btn btn-ghost btn-small" disabled={transport.blocked} onClick={()=>action('decline')}>婉拒邀請</button></div>}
    {own?.status==='queued'&&<button type="button" className="btn btn-ghost btn-small" disabled={transport.blocked} onClick={()=>action('leave')}>離開候補</button>}
    {open&&!active&&value.rsvp_state!=='going'&&value.waitlist_enabled&&<button type="button" className="btn btn-ghost btn-small" disabled={transport.blocked} onClick={()=>action('join')}>自願加入候補</button>}
    {!value.waitlist_enabled&&!active&&value.rsvp_state!=='going'&&<p className="field-hint">主辦者尚未開放候補；額滿不會自動加入。</p>}
  </div>;
}
function ReminderForm({value,transport,path,guest,reload,allowed}:{value:EventReminderDTO;transport:Transport;path:string;guest:boolean;reload:()=>Promise<void>;allowed:boolean}){
  const [enabled,setEnabled]=useState(value.enabled),[minutes,setMinutes]=useState(value.minutes_before_start===null?'':String(value.minutes_before_start)),[channel,setChannel]=useState<'email'|'in_app'>(guest?'email':value.channel??'in_app');
  async function submit(e:FormEvent){e.preventDefault();if(enabled&&(!positive(minutes)||!allowed))return;if(await transport.mutate('PATCH',path,{enabled,...(enabled?{minutes_before_start:Number(minutes),channel}:{})},value.version))await reload();}
  const status=value.status===null?'尚未設定':({pending:'等待提醒時間',provider_accepted:'Email 服務已接受；不代表已送達',recorded:'站內通知已建立',cancelled:'未寄出的提醒已取消',failed:'提醒未確認送出'}[value.status]);
  return <form className="stack" onSubmit={e=>void submit(e)}>
    <h3>自願活動提醒</h3>
    <p className="field-hint">目前狀態：{status}。提醒不等於報名；取消報名會取消尚未寄出的提醒。</p>
    {!allowed&&<p className="field-hint">活動目前不開放新的開始前提醒；你仍可取消提醒選擇。</p>}
    <label className="field"><span><input type="checkbox" checked={enabled} onChange={e=>setEnabled(e.target.checked)}/> 我想收到活動開始前提醒</span></label>
    {enabled&&<>
      <label className="field">開始前幾分鐘<input aria-label="開始前幾分鐘" required type="number" min={1} step={1} value={minutes} onChange={e=>setMinutes(e.target.value)}/></label>
      {!guest&&<label className="field">通知方式<select aria-label="通知方式" value={channel} onChange={e=>setChannel(e.target.value as 'email'|'in_app')}><option value="in_app">站內通知</option><option value="email">Email</option></select></label>}
      {guest&&<p className="field-hint">提醒寄到已驗證的報名信箱。</p>}
    </>}
    <button className="btn btn-ghost btn-small" disabled={transport.blocked||enabled&&(!positive(minutes)||!allowed)}>儲存提醒選擇</button>
  </form>;
}
function ParticipationPanel({client,eventId,eventVersion,rsvpState,token,actor,referralCode,onChanged}:{client:PortalClient;eventId:string;eventVersion?:number;rsvpState?:'going'|'cancelled'|null;token:string|null;actor:string;referralCode?:string|null;onChanged?:()=>void}){
  const base=`${token?'/public':''}/events/${eventId}`,transport=useParticipationTransport(client,`${actor}:${eventId}`,token);
  const [value,setValue]=useState<EventParticipationDTO|null>(null),[reminder,setReminder]=useState<EventReminderDTO|null>(null);
  const reload=useCallback(async()=>{const [participation,currentReminder]=await Promise.all([transport.get<EventParticipationDTO>(`${base}/participation`),transport.get<EventReminderDTO>(`${base}/reminder`)]);if(participation)setValue(participation);if(currentReminder)setReminder(currentReminder);if(participation&&currentReminder)transport.reloaded();},[base,transport.get]);
  // Sibling organizer commands refresh canonical metadata without remounting drafts.
  useEffect(()=>{if(eventVersion===undefined||!value||value.event_version<eventVersion)void reload();},[reload,eventVersion]);
  // RSVP lives on the event card and does not bump the event version; its server side also cancels unsent reminders.
  const seenRsvp=useRef(rsvpState);
  useEffect(()=>{if(seenRsvp.current===rsvpState)return;seenRsvp.current=rsvpState;void reload();},[reload,rsvpState]);
  async function action(action:string){if(!value)return;if(await transport.mutate('POST',`${base}/${token?'participation':'waitlist'}`,{action,...(referralCode?{referral_code:referralCode}:{})},value.event_version)){await reload();onChanged?.();}}
  const retryReload=async()=>{await reload();onChanged?.();};
  return <section className="event-participation stack" aria-label="本人活動參與設定">
    <h3>{token?'私人活動管理':'候補、行事曆與提醒'}</h3>
    {!value&&!transport.error&&<p role="status">正在讀取本人參與狀態…</p>}
    {value&&<>
      <ParticipationState value={value} transport={transport} action={action}/>
      {token&&(value.rsvp_state==='going'||value.rsvp_state==='pending')&&<button type="button" className="btn btn-ghost btn-small" disabled={transport.blocked} onClick={()=>void action('cancel')}>取消我的報名</button>}
      {token&&value.event_state==='published'&&Date.parse(value.starts_at)>Date.now()&&value.rsvp_state!=='going'&&value.waitlist?.status!=='invited'&&(value.rsvp_state==='pending'||value.available_seats===null||value.available_seats>0)&&<button type="button" className="btn btn-ghost btn-small" disabled={transport.blocked} onClick={()=>void action('register')}>確認報名此活動</button>}
      <div className="experience-actions">
        <button type="button" className="btn btn-ghost btn-small" disabled={transport.busy} onClick={()=>void downloadCalendar(transport,`${base}/calendar`)}>下載行事曆 .ics</button>
        <button type="button" className="btn btn-ghost btn-small" disabled={transport.busy} onClick={()=>void reload()}>更新本人狀態</button>
      </div>
      <p className="field-hint">行事曆使用 UTC 時刻；日曆軟體依你的時區顯示。改期後請重新下載；下載不會報名或開啟提醒。</p>
    </>}
    {reminder&&<ReminderForm value={reminder} transport={transport} path={`${base}/reminder`} guest={Boolean(token)} reload={reload} allowed={value?.rsvp_state==='going'&&value.event_state==='published'&&Date.parse(value.starts_at)>Date.now()}/>}
    <Feedback transport={transport} reload={retryReload}/>
    {!value&&transport.error&&!transport.stale&&!transport.retry&&<button type="button" className="btn btn-ghost btn-small" onClick={()=>void reload()}>重新讀取</button>}
  </section>;
}
export function EventParticipation({client,session,eventId,eventVersion,rsvpState,referralCode,onChanged}:EventParticipationProps){
  return <ParticipationPanel key={`${session.user.user_id}:${client.csrfToken}:${eventId}`} client={client} eventId={eventId} eventVersion={eventVersion} rsvpState={rsvpState} token={null} actor={session.user.user_id} referralCode={referralCode} onChanged={onChanged}/>;
}
function ManagementRequest({client,id,referralCode}:GuestEventParticipationProps){
  const transport=useParticipationTransport(client,`request:${id}`,null),[name,setName]=useState(''),[email,setEmail]=useState('');
  useEffect(()=>{if(typeof transport.receipt==='object'&&transport.receipt!==null&&'provider_status' in transport.receipt&&transport.receipt.provider_status==='provider_accepted')transport.setNotice('Email 服務已接受私人管理信；不代表郵件已送達。請檢查信箱。這不會自動報名或加入候補。');},[transport.receipt,transport.setNotice]);
  async function submit(e:FormEvent){e.preventDefault();await transport.mutate('POST',`/public/events/${id}/participation-request`,{name,email,referral_code:referralCode??null});}
  return <section className="event-participation stack">
    <form className="stack" onSubmit={e=>void submit(e)}>
      <h3>用 Email 管理自己的參與</h3>
      <p className="field-hint">已有報名或想在額滿時候補？先取得私人管理信，再自行選擇候補、取消或提醒。此處不會公開任何參與者資料。</p>
      <label className="field">你的名字<input required maxLength={80} autoComplete="name" value={name} onChange={e=>setName(e.target.value)}/></label>
      <label className="field">報名 Email<input required type="email" maxLength={200} autoComplete="email" value={email} onChange={e=>setEmail(e.target.value)}/></label>
      <button className="btn btn-ghost btn-small" disabled={transport.blocked}>寄送私人管理連結</button>
    </form>
    <Feedback transport={transport}/>
  </section>;
}
export function GuestEventParticipation(props:GuestEventParticipationProps){
  const [token,setToken]=useState(()=>readEventParticipationToken());
  useEffect(()=>{const update=()=>setToken(readEventParticipationToken());window.addEventListener('hashchange',update);window.addEventListener('popstate',update);return()=>{window.removeEventListener('hashchange',update);window.removeEventListener('popstate',update);}},[]);
  return token?<ParticipationPanel key={props.id+token} client={props.client} eventId={props.id} token={token} actor="guest"/>:<ManagementRequest key={props.id} {...props}/>;
}
function localTime(value:string){const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60_000).toISOString().slice(0,16);}
function OrganizerControls({client,event,onChanged}:Omit<EventParticipationOrganizerProps,'session'>){
  const transport=useParticipationTransport(client,`organizer:${event.event_id}`,null),[value,setValue]=useState<EventParticipationDTO|null>(null);
  const [latest,setLatest]=useState(event),policyTouched=useRef(false);
  const [enabled,setEnabled]=useState(false),[minutes,setMinutes]=useState(''),[initialized,setInitialized]=useState(false);
  const [starts,setStarts]=useState(()=>localTime(event.starts_at)),[ends,setEnds]=useState(()=>localTime(event.ends_at)),[capacity,setCapacity]=useState(event.capacity===null?'':String(event.capacity));
  const reload=useCallback(async()=>{const [next,current]=await Promise.all([transport.get<EventParticipationDTO>(`/events/${event.event_id}/participation`),transport.get<OrganizerParticipationEvent>(`/events/${event.event_id}`)]);if(next)setValue(next);if(current)setLatest(current);if(next&&current)transport.reloaded();},[event.event_id,transport.get]);
  useEffect(()=>{if(!value||value.event_version<event.aggregate_version)void reload();},[reload,event.aggregate_version]);
  useEffect(()=>{if(value&&!initialized){if(!policyTouched.current){setEnabled(value.waitlist_enabled);setMinutes(value.response_window_minutes===null?'':String(value.response_window_minutes));}setInitialized(true);}},[value,initialized]);
  async function policy(e:FormEvent){e.preventDefault();if(!value||enabled&&!positive(minutes))return;if(await transport.mutate('PATCH',`/events/${event.event_id}/waitlist-policy`,{waitlist_enabled:enabled,response_window_minutes:enabled?Number(minutes):null},value.event_version)){await reload();onChanged?.();}}
  async function schedule(e:FormEvent){
    e.preventDefault();if(!value||!starts||!ends||!Number.isFinite(Date.parse(starts))||!Number.isFinite(Date.parse(ends))||capacity!==''&&!positive(capacity))return;
    const starts_at=localInputToIso(starts),ends_at=localInputToIso(ends);if(Date.parse(ends_at)<=Date.parse(starts_at))return;
    if(await transport.mutate('PATCH',`/events/${event.event_id}/schedule`,{starts_at,ends_at,capacity:capacity===''?null:Number(capacity)},value.event_version)){await reload();onChanged?.();}
  }
  const invalidSchedule=!starts||!ends||!Number.isFinite(Date.parse(starts))||!Number.isFinite(Date.parse(ends))||Date.parse(ends)<=Date.parse(starts)||capacity!==''&&!positive(capacity);
  return <details className="event-participation">
    <summary>主辦者：候補規則與改期</summary>
    <div className="stack">
      <form className="stack" onSubmit={e=>void policy(e)}>
        <h3>候補回覆規則</h3>
        {value&&<p className="field-hint">目前已儲存：{value.waitlist_enabled?`開放候補，回覆期限 ${value.response_window_minutes} 分鐘`:'未開放候補'}。</p>}
        <label className="field"><span><input type="checkbox" checked={enabled} onChange={e=>{policyTouched.current=true;setEnabled(e.target.checked);}}/> 開放自願候補</span></label>
        {enabled&&<label className="field">每次邀請須在幾分鐘內回覆<input required min={1} step={1} type="number" value={minutes} onChange={e=>{policyTouched.current=true;setMinutes(e.target.value);}}/></label>}
        <p className="field-hint">必須明確選擇回覆時間，沒有預設期限。最晚以活動開始時間為限；邀請會保留名額，但只有接受才算報名。</p>
        <button className="btn btn-ghost btn-small" disabled={!value||transport.blocked||enabled&&!positive(minutes)}>儲存候補規則</button>
      </form>
      {latest.state==='published'&&<form className="stack" onSubmit={e=>void schedule(e)}>
        <h3>已發布活動的時間與容量</h3>
        <p className="field-hint">目前已儲存：{formatIsoLocal(latest.starts_at)} ～ {formatIsoLocal(latest.ends_at)}；容量 {latest.capacity===null?'不限':latest.capacity}。下方未送出的輸入不會被重新載入覆蓋。</p>
        <label className="field">開始時間（依裝置時區）<input required type="datetime-local" value={starts} onChange={e=>setStarts(e.target.value)}/></label>
        <label className="field">結束時間（依裝置時區）<input required type="datetime-local" value={ends} onChange={e=>setEnds(e.target.value)}/></label>
        <label className="field">人數上限（空白代表不限）<input type="number" min={1} step={1} value={capacity} onChange={e=>setCapacity(e.target.value)}/></label>
        <p className="field-hint">保留原類型、公會與可見範圍。降低容量不會強制取消既有報名；伺服器會拒絕低於已佔用名額的容量。</p>
        <button className="btn btn-ghost btn-small" disabled={!value||transport.blocked||invalidSchedule}>儲存時間與容量</button>
      </form>}
      <Feedback transport={transport} reload={async()=>{await reload();onChanged?.();}}/>
      {!value&&!transport.error&&<p role="status">正在讀取主辦設定…</p>}
      {!value&&transport.error&&!transport.stale&&!transport.retry&&<button className="btn btn-ghost btn-small" type="button" onClick={()=>void reload()}>重新讀取主辦設定</button>}
    </div>
  </details>;
}
export function EventParticipationOrganizer({client,session,event,onChanged}:EventParticipationOrganizerProps){return <OrganizerControls key={`${session.user.user_id}:${client.csrfToken}:${event.event_id}`} client={client} event={event} onChanged={onChanged}/>;}
