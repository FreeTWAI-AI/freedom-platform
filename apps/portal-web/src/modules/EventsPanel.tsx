import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { PortalClient } from '../api';
import type { SessionPayload } from '../types';
import { formatIsoLocal, hoursFromNowLocalInput, localInputToIso } from '../format';
import { useModuleMutation } from './shared';
import {announceInboxChange} from './member-inbox';
import {uploadEventBanner,uploadEventVideo} from './event-banner-client';
import {EventCalendar} from './EventCalendar';
import './MemberExperience.css';

export type CommunityEvent = {
  event_id:string; organizer_ref:string; organizer_name:string; title:string; description:string;
  starts_at:string; ends_at:string; mode:'online'|'in_person'|'hybrid'; location:string;
  event_kind:'reading_group'|'meetup'|'guild_skill_exchange'|'other';topic:string|null;online_url:string|null;visibility:'workshop'|'guild'|'referral'|'open';banner_url:string|null;banner_orientation:'landscape'|'portrait'|null;video_url:string|null;video_mime:'video/mp4'|'video/webm'|null;
  capacity:number|null; state:'pending'|'published'|'rejected'|'cancelled'; aggregate_version:number;
  attending_count:number; my_rsvp:'going'|'cancelled'|null;guild_key:string|null;review_guild_key:string|null;can_review:boolean;review_reason:string|null;
};
type Guild={guild_key:string;name:string};
type Bulletin={bulletin_id:string;message:string;created_at:string};
export type EventDraft = {title:string;description:string;starts_at:string;ends_at:string;mode:CommunityEvent['mode'];event_kind:CommunityEvent['event_kind'];topic:string;location:string;online_url:string;capacity:string;guild_key:string;visibility:CommunityEvent['visibility']};
export const blankEvent=():EventDraft=>({title:'',description:'',starts_at:hoursFromNowLocalInput(24),ends_at:hoursFromNowLocalInput(25),mode:'online',event_kind:'other',topic:'',location:'',online_url:'',capacity:'',guild_key:'',visibility:'workshop'});
function localTime(iso:string) {
  const date=new Date(iso), local=new Date(date.getTime()-date.getTimezoneOffset()*60_000);
  return local.toISOString().slice(0,16);
}
const fromEvent=(item:CommunityEvent):EventDraft=>({title:item.title,description:item.description,starts_at:localTime(item.starts_at),ends_at:localTime(item.ends_at),mode:item.mode,event_kind:item.event_kind??'other',topic:item.topic??'',location:item.location,online_url:item.online_url??'',capacity:item.capacity===null?'':String(item.capacity),guild_key:item.guild_key??'',visibility:item.visibility??'workshop'});
export const eventPayload=(value:EventDraft)=>({...value,starts_at:localInputToIso(value.starts_at),ends_at:localInputToIso(value.ends_at),topic:value.topic.trim()||null,online_url:value.online_url.trim()||null,capacity:value.capacity===''?null:Number(value.capacity),guild_key:value.guild_key||null});
const modeLabel:Record<CommunityEvent['mode'],string>={online:'線上',in_person:'實體',hybrid:'線上與實體'};
const kindLabel:Record<CommunityEvent['event_kind'],string>={reading_group:'線上讀書會',meetup:'聚會',guild_skill_exchange:'公會技能交流',other:'其他活動'};
const reviewerFor=(value:EventDraft,guilds:Guild[])=>value.event_kind==='guild_skill_exchange'
  ?guilds.find(guild=>guild.guild_key===value.guild_key)?.name??'所選主辦公會'
  :value.mode==='online'?'會員與社群營運公會':'活動與空間公會';
const capacityChoices=['10','20','30','50','100','200','500'];
const participationUrl=(location:string)=>{try{const url=new URL(location);return url.protocol==='https:'&&!url.username&&!url.password?url.href:null;}catch{return null;}};
const referralCode=(id:string)=>{
  const match=/^#events\/([0-9a-f-]{36})(?:\?(.*))?$/.exec(window.location.hash);
  const pathId=/^\/events\/([0-9a-f-]{36})\/?$/.exec(window.location.pathname)?.[1];
  const fromLink=match?.[1]===id?new URLSearchParams(match[2]??'').get('ref'):pathId===id?new URLSearchParams(window.location.search).get('ref'):null;
  if(fromLink&&/^[A-Za-z0-9_-]{16,32}$/.test(fromLink))try{localStorage.setItem(`freedom-event-referral:${id}`,fromLink)}catch{/* A copied link still works. */}
  try{return fromLink??localStorage.getItem(`freedom-event-referral:${id}`)}catch{return fromLink}
};

export function EventFields({value,onChange,guilds=[],guildLocked=false}:{value:EventDraft;onChange:(next:EventDraft)=>void;guilds?:Guild[];guildLocked?:boolean}) {
  const set=<K extends keyof EventDraft>(key:K,next:EventDraft[K])=>onChange({...value,[key]:next});
  return <div className="experience-fields">
    <label className="field">活動名稱<input required maxLength={120} value={value.title} onChange={e=>set('title',e.target.value)}/></label>
    <label className="field">活動類型<select value={value.event_kind} disabled={guildLocked} onChange={e=>{const event_kind=e.target.value as EventDraft['event_kind'];onChange({...value,event_kind,mode:event_kind==='reading_group'?'online':value.mode,visibility:event_kind==='guild_skill_exchange'?value.visibility:value.visibility==='guild'?'workshop':value.visibility});}}><option value="reading_group">線上讀書會</option><option value="meetup">聚會</option><option value="guild_skill_exchange">公會技能交流</option><option value="other">其他活動</option></select></label>
    {value.event_kind==='reading_group'&&<label className="field">讀書會主題<input required maxLength={160} value={value.topic} onChange={e=>set('topic',e.target.value)} placeholder="例如：本週閱讀與討論的書或章節"/></label>}
    <label className="field">活動說明<textarea required maxLength={3000} rows={4} value={value.description} onChange={e=>set('description',e.target.value)}/></label>
    <div className="experience-row"><label className="field">開始時間<input required type="datetime-local" value={value.starts_at} onChange={e=>set('starts_at',e.target.value)}/></label><label className="field">結束時間<input required type="datetime-local" value={value.ends_at} onChange={e=>set('ends_at',e.target.value)}/></label></div>
    <div className="experience-row"><label className="field">形式<select value={value.mode} disabled={guildLocked||value.event_kind==='reading_group'} onChange={e=>set('mode',e.target.value as EventDraft['mode'])}><option value="online">線上</option><option value="in_person">實體</option><option value="hybrid">線上與實體</option></select></label><label className="field">{value.mode==='online'?'線上場地':'實體地點'}<input required maxLength={300} list={value.mode==='online'?'online-event-venues':undefined} value={value.location} onChange={e=>set('location',e.target.value)} placeholder={value.mode==='online'?'例如：Discord 讀書會場地':'例如：台北市的聚會地點'}/></label></div>
    {value.mode==='online'&&<datalist id="online-event-venues"><option value="Discord 讀書會場地"/><option value="Discord 語音頻道"/><option value="Google Meet"/><option value="Zoom"/></datalist>}
    <label className="field">{value.mode==='in_person'?'線上直播連結（選填）':'線上參與連結'}<input type="url" pattern="https://.*" required={value.mode==='hybrid'} maxLength={500} value={value.online_url} onChange={e=>set('online_url',e.target.value)} placeholder="https://"/>{value.mode==='hybrid'&&<small>同時提供實體地點與線上參與連結。</small>}</label>
    <label className="field">人數上限<select value={capacityChoices.includes(value.capacity)||!value.capacity?value.capacity:'custom'} onChange={e=>set('capacity',e.target.value==='custom'?'1':e.target.value)}><option value="">不限人數</option>{capacityChoices.map(count=><option key={count} value={count}>{count} 人</option>)}<option value="custom">自訂人數</option></select>{value.capacity&&!capacityChoices.includes(value.capacity)&&<input aria-label="自訂人數上限" type="number" min={1} max={500} value={value.capacity} onChange={e=>set('capacity',e.target.value)}/>}</label>
    <label className="field">主辦公會<select value={value.guild_key} required={value.event_kind==='guild_skill_exchange'} disabled={guildLocked} onChange={e=>set('guild_key',e.target.value)}><option value="">不指定主辦公會</option>{guilds.map(guild=><option key={guild.guild_key} value={guild.guild_key}>{guild.name}</option>)}</select>{guildLocked&&<small>提交後不能更換主辦公會、形式或類型。</small>}</label>
    <label className="field">參與範圍<select value={value.visibility} disabled={guildLocked} onChange={e=>set('visibility',e.target.value as EventDraft['visibility'])}>{value.event_kind==='guild_skill_exchange'&&<option value="guild">僅主辦公會成員</option>}<option value="workshop">僅自由工坊會員</option><option value="referral">公開頁面，須會員分享連結報名；線上資料寄 Email</option><option value="open">完全公開，所有人可直接查看與報名</option></select></label>
    {value.visibility==='referral'&&<p className="field-hint">海報、影片與活動說明都會公開。請勿在這些內容中放入線上參與連結或 QR 碼。</p>}
    <p className="field-hint">審核：{reviewerFor(value,guilds)}的公會長，或平台管理員。</p>
  </div>;
}

export function EventsPanel({client,session}:{client:PortalClient;session:SessionPayload}) {
  const [items,setItems]=useState<CommunityEvent[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState('');
  const [creating,setCreating]=useState(false),[draft,setDraft]=useState<EventDraft>(blankEvent);
  const [editing,setEditing]=useState<string|null>(null),[editDraft,setEditDraft]=useState<EventDraft>(blankEvent);
  const [bannerFile,setBannerFile]=useState<File|null>(null),[editBannerFile,setEditBannerFile]=useState<File|null>(null),[videoFile,setVideoFile]=useState<File|null>(null),[editVideoFile,setEditVideoFile]=useState<File|null>(null),[bannerError,setBannerError]=useState(''),[saving,setSaving]=useState(false);
  const [guilds,setGuilds]=useState<Guild[]>([]),[bulletins,setBulletins]=useState<Bulletin[]>([]);
  const [reviewing,setReviewing]=useState<string|null>(null),[reviewReason,setReviewReason]=useState('');
  const [notice,setNotice]=useState('');
  const [shareFor,setShareFor]=useState<string|null>(null),[shareUrl,setShareUrl]=useState('');
  const [reports,setReports]=useState<Record<string,{user_id:string;member_name:string;registrations:number}[]>>({});
  const selectedFromHash=()=>/^#events\/([0-9a-f-]{36})(?:\?.*)?$/.exec(window.location.hash)?.[1]??(!window.location.hash?/^\/events\/([0-9a-f-]{36})\/?$/.exec(window.location.pathname)?.[1]??null:null);
  const [selectedId,setSelectedId]=useState<string|null>(selectedFromHash),[selectedItem,setSelectedItem]=useState<CommunityEvent|null>(null);
  useEffect(()=>{const change=()=>setSelectedId(selectedFromHash());window.addEventListener('hashchange',change);window.addEventListener('popstate',change);return()=>{window.removeEventListener('hashchange',change);window.removeEventListener('popstate',change)}},[]);
  const {mutate,busy,error}=useModuleMutation(client);
  const load=useCallback(async()=>{setLoading(true);setLoadError('');try{const [events,directory,announcements]=await Promise.all([
    client.get<{items:CommunityEvent[]}>('/events'),client.get<{items:Guild[]}>('/guilds/directory'),client.get<{items:Bulletin[]}>('/events/bulletins')]);
    setItems(events.items);setGuilds(directory.items);setBulletins(announcements.items);
  }catch(cause){setLoadError(cause instanceof Error?cause.message:'活動暫時無法載入。');}finally{setLoading(false);}},[client]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{if(!selectedId||items.some(item=>item.event_id===selectedId)){setSelectedItem(null);return;}let active=true;void client.get<CommunityEvent>(`/events/${selectedId}`).then(item=>{if(active)setSelectedItem(item)}).catch(()=>{if(active)setSelectedItem(null)});return()=>{active=false}},[client,items,selectedId]);
  useEffect(()=>{if(selectedId)referralCode(selectedId)},[selectedId]);
  function chooseBanner(file:File|null,editingFile=false){
    setBannerError('');
    if(file&&(!['image/jpeg','image/png','image/webp'].includes(file.type)||file.size>512*1024||file.size===0)){
      setBannerError('Banner 請選擇 512 KiB 以下的 JPEG、PNG 或 WebP。');return;
    }
    if(editingFile)setEditBannerFile(file);else setBannerFile(file);
  }
  function chooseVideo(file:File|null,editingFile=false){
    setBannerError('');
    if(file&&(!['video/mp4','video/webm'].includes(file.type)||file.size>20*1024*1024||file.size===0)){
      setBannerError('影片請選擇 20 MiB 以下的 MP4 或 WebM。');return;
    }
    if(editingFile)setEditVideoFile(file);else setVideoFile(file);
  }
  async function save(event:FormEvent) {
    event.preventDefault();if(saving||bannerError)return;setSaving(true);setNotice('');
    const current=items.find(item=>item.event_id===editing);
    try{
      let result=current
        ?await mutate<CommunityEvent>(`/events/${current.event_id}/update`,eventPayload(editDraft),current.aggregate_version)
        :await mutate<CommunityEvent>('/events',eventPayload(draft));
      if(!result)return;
      let pendingBanner=current?editBannerFile:bannerFile,pendingVideo=current?editVideoFile:videoFile;
      try{
        if(pendingBanner){result=await uploadEventBanner(client,result,pendingBanner);pendingBanner=null;}
        if(pendingVideo){result=await uploadEventVideo(client,result,pendingVideo);pendingVideo=null;}
      }catch(cause){setBannerError(cause instanceof Error?cause.message:'媒體未能保存；活動已送出，請在活動卡片重試。');setCreating(false);setEditing(result.event_id);setEditDraft(fromEvent(result));setEditBannerFile(pendingBanner);setEditVideoFile(pendingVideo);await load();return;}
      setCreating(false);setEditing(null);setBannerFile(null);setEditBannerFile(null);setVideoFile(null);setEditVideoFile(null);setDraft(blankEvent());setNotice(current?'活動已更新，仍待審核。':'活動已送出審核，核准後開放報名。');announceInboxChange();window.dispatchEvent(new Event('freedom-world-facts-updated'));await load();
    }finally{setSaving(false);}
  }
  async function removeBanner(item:CommunityEvent){
    setBannerError('');setSaving(true);
    try{await client.post(`/events/${item.event_id}/banner/remove`,{},{ifMatch:item.aggregate_version});await load();setNotice('Banner 已移除。');}
    catch(cause){setBannerError(cause instanceof Error?cause.message:'Banner 未能移除。');}
    finally{setSaving(false);}
  }
  async function removeVideo(item:CommunityEvent){
    setBannerError('');setSaving(true);
    try{await client.post(`/events/${item.event_id}/video/remove`,{},{ifMatch:item.aggregate_version});await load();setNotice('影片已移除。');}
    catch(cause){setBannerError(cause instanceof Error?cause.message:'影片未能移除。');}
    finally{setSaving(false);}
  }
  async function action(item:CommunityEvent,kind:'cancel'|'rsvp',going=false) {
    setNotice('');
    const code=kind==='rsvp'&&going?referralCode(item.event_id):null;
    if(kind==='rsvp'&&going&&item.visibility==='referral'&&!code){setNotice('請從會員分享的活動連結進入，才能報名這場活動。');return;}
    const result=await mutate<CommunityEvent>(`/events/${item.event_id}/${kind}`,kind==='cancel'?{}:{going,referral_code:code},kind==='cancel'?item.aggregate_version:undefined);
    if(result){setNotice(kind==='cancel'?'活動已取消。':going?'報名完成。':'已取消報名。');await load();}
  }
  async function review(item:CommunityEvent,decision:'approve'|'reject'){
    const reason=reviewReason.trim();if(!reason){setNotice('請填寫審核理由。');return;}
    const result=await mutate<CommunityEvent>(`/events/${item.event_id}/review`,{decision,reason},item.aggregate_version);
    if(result){setReviewing(null);setReviewReason('');setNotice(decision==='approve'?'活動已核准並公告。':'活動已退回並通知發佈者。');announceInboxChange();window.dispatchEvent(new Event('freedom-world-facts-updated'));await load();}
  }
  async function share(item:CommunityEvent){
    try{
      const result=await client.post<{code:string}>(`/events/${item.event_id}/share-code`,{});
      const url=`${window.location.origin}/events/${item.event_id}?ref=${result.code}`;
      setShareFor(item.event_id);setShareUrl(url);
      if(navigator.share){try{await navigator.share({title:item.title,url});setNotice('已開啟分享。');return;}catch(error){if((error as Error).name==='AbortError')return;}}
      await navigator.clipboard.writeText(url);setNotice('活動專頁連結已複製，分享碼已包含在連結中。');
    }catch(cause){setNotice(cause instanceof Error?cause.message:'連結未能複製，請從下方欄位複製。');}
  }
  async function report(item:CommunityEvent){
    try{const result=await client.get<{items:{user_id:string;member_name:string;registrations:number}[]}>(`/events/${item.event_id}/referrals`);setReports(value=>({...value,[item.event_id]:result.items}));}
    catch(cause){setNotice(cause instanceof Error?cause.message:'分享統計暫時無法讀取。');}
  }
  const upcoming=items.filter(item=>item.state==='published'&&Date.parse(item.ends_at)>Date.now());
  const pending=items.filter(item=>item.state==='pending');
  const past=items.filter(item=>item.state==='rejected'||item.state==='cancelled'||item.state==='published'&&Date.parse(item.ends_at)<=Date.now());
  const render=(item:CommunityEvent)=>{
    const started=Date.parse(item.starts_at)<=Date.now(),mine=item.organizer_ref===session.user.user_id;
    const canJoin=item.state==='published'&&!started;
    const link=participationUrl(item.location),onlineLink=participationUrl(item.online_url??'');
    return <article className="card experience-card" key={item.event_id}>
      <div className="experience-card-head"><div><span className="experience-kicker">{kindLabel[item.event_kind]??'其他活動'} · {modeLabel[item.mode]} · {item.visibility==='guild'?'公會內部 · ':item.visibility==='workshop'?'工坊會員 · ':item.visibility==='referral'?'推薦連結公開 · ':'完全公開 · '}{item.state==='pending'?'待審核':item.state==='rejected'?'未通過審核':item.state==='cancelled'?'已取消':started?'進行中／已結束':'開放報名'}</span><h3>{item.title}</h3></div>{item.state==='published'&&<span className="experience-count">{item.attending_count}{item.capacity===null?' 人報名':` / ${item.capacity} 人`}</span>}</div>
      {item.banner_url&&<img className="experience-banner-image" src={item.banner_url} alt="活動海報" width={item.banner_orientation==='portrait'?900:1200} height={item.banner_orientation==='portrait'?1200:675}/>}
      {item.video_url&&<video className="experience-video" controls preload="metadata" aria-label={`${item.title} 的活動影片`}><source src={item.video_url} type={item.video_mime??undefined}/></video>}
      {item.topic&&<p>主題：{item.topic}</p>}<p>{item.description}</p><dl className="experience-meta"><div><dt>時間</dt><dd>{formatIsoLocal(item.starts_at)} ～ {formatIsoLocal(item.ends_at)}（依裝置時區）</dd></div><div><dt>地點</dt><dd>{link?<a href={link} target="_blank" rel="noopener noreferrer">開啟參與連結 ↗</a>:item.location}</dd></div>{onlineLink&&<div><dt>線上參與</dt><dd><a href={onlineLink} target="_blank" rel="noopener noreferrer">開啟線上連結 ↗</a></dd></div>}<div><dt>發佈者</dt><dd>{item.organizer_name}（會員活動）</dd></div></dl>
      {item.state==='rejected'&&item.review_reason&&<p className="banner banner-info">審核理由：{item.review_reason}</p>}
      <div className="experience-actions">{canJoin&&<button type="button" className={item.my_rsvp==='going'?'btn btn-ghost':'btn btn-primary'} disabled={busy||(item.my_rsvp!=='going'&&item.capacity!==null&&item.attending_count>=item.capacity)} onClick={()=>void action(item,'rsvp',item.my_rsvp!=='going')}>{item.my_rsvp==='going'?'取消報名':item.capacity!==null&&item.attending_count>=item.capacity?'名額已滿':'我要參加'}</button>}{item.state==='published'&&<><a className="btn btn-ghost" href={`#events/${item.event_id}`}>活動專頁</a><button type="button" className="btn btn-ghost" onClick={()=>void share(item)}>分享活動</button></>}{mine&&item.state==='published'&&<button type="button" className="btn btn-ghost" onClick={()=>void report(item)}>分享報名統計</button>}{mine&&item.state==='pending'&&!started&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>{setEditing(item.event_id);setEditDraft(fromEvent(item));setCreating(false);}}>編輯草稿</button>}{mine&&(item.state==='pending'||item.state==='published')&&<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void action(item,'cancel')}>取消活動</button>}{item.can_review&&<button type="button" className="btn btn-primary" disabled={busy} onClick={()=>{setReviewing(item.event_id);setReviewReason('');}}>審核活動</button>}</div>
      {shareFor===item.event_id&&shareUrl&&<div className="event-share-link"><label className="field">分享連結<input readOnly value={shareUrl} onFocus={event=>event.target.select()}/><small>推薦碼已包含在連結內；此瀏覽器再次開啟活動時會記住它。</small></label><button type="button" className="btn btn-ghost" onClick={()=>void navigator.clipboard.writeText(shareUrl).then(()=>setNotice('活動專頁連結已複製。')).catch(()=>setNotice('請選取上方連結手動複製。'))}>複製連結</button></div>}
      {reports[item.event_id]&&<div className="event-referral-report"><h4>依分享會員統計報名</h4>{reports[item.event_id].length?<ul>{reports[item.event_id].map(row=><li key={row.user_id}>{row.member_name}：{row.registrations} 人</li>)}</ul>:<p>尚無分享報名紀錄。</p>}</div>}
      {editing===item.event_id&&<form className="experience-editor" onSubmit={e=>void save(e)}><EventFields value={editDraft} onChange={setEditDraft} guilds={guilds} guildLocked/><label className="field">活動海報（選填）<input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} onChange={e=>chooseBanner(e.target.files?.[0]??null,true)}/><small>直式、橫式皆可；JPEG、PNG 或 WebP，512 KiB 以下。{editBannerFile?` 已選擇 ${editBannerFile.name}`:''}</small></label><label className="field">活動影片（選填）<input type="file" accept="video/mp4,video/webm" disabled={saving} onChange={e=>chooseVideo(e.target.files?.[0]??null,true)}/><small>MP4 或 WebM，20 MiB 以下。{editVideoFile?` 已選擇 ${editVideoFile.name}`:''}</small></label><div className="experience-actions"><button className="btn btn-primary" disabled={busy||saving||Boolean(bannerError)}>儲存修改</button>{bannerError&&(editBannerFile||editVideoFile)&&<button type="button" className="btn btn-ghost" onClick={()=>setBannerError('')}>重試保存</button>}{item.banner_url&&<button type="button" className="btn btn-ghost" disabled={saving} onClick={()=>void removeBanner(item)}>移除海報</button>}{item.video_url&&<button type="button" className="btn btn-ghost" disabled={saving} onClick={()=>void removeVideo(item)}>移除影片</button>}<button type="button" className="btn btn-ghost" onClick={()=>{setEditing(null);setEditBannerFile(null);setEditVideoFile(null);setBannerError('');}}>返回</button></div></form>}
      {reviewing===item.event_id&&<div className="experience-editor"><label className="field">審核理由<textarea required minLength={1} maxLength={500} value={reviewReason} onChange={e=>setReviewReason(e.target.value)}/></label><div className="experience-actions"><button type="button" className="btn btn-primary" disabled={busy||!reviewReason.trim()} onClick={()=>void review(item,'approve')}>核准並公告</button><button type="button" className="btn btn-ghost" disabled={busy||!reviewReason.trim()} onClick={()=>void review(item,'reject')}>退回</button><button type="button" className="btn btn-ghost" onClick={()=>setReviewing(null)}>返回</button></div></div>}
    </article>;
  };
  const selected=selectedId&&(items.find(item=>item.event_id===selectedId)??selectedItem);
  if(selectedId)return <section className="experience-panel stack" aria-label="活動專頁"><div className="experience-actions"><button className="btn btn-ghost" type="button" onClick={()=>{if(/^\/events\/[0-9a-f-]{36}\/?$/.test(window.location.pathname)){window.history.replaceState(null,'','/#events');window.dispatchEvent(new HashChangeEvent('hashchange'))}else window.location.hash='events'}}>返回活動列表與行事曆</button></div>{selected?render(selected):<p role="status">{loading?'正在載入活動…':'找不到這場活動，或目前無法查看。'}</p>}{notice&&<p role="status" className="banner banner-info">{notice}</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}</section>;
  return <section className="experience-panel stack" aria-label="活動發佈區">
    <div className="experience-intro"><div><p className="eyebrow">MEET / LEARN / BUILD</p><h2>和社群一起碰面、分享、動手做。</h2><p>已登入會員可提交活動。線上由會員與社群營運公會審核，實體及混合形式由活動與空間公會審核；公會技能交流由主辦公會審核，並可設定僅公會內部參與。平台管理員也能審核。核准後開放報名。</p></div><button type="button" className="btn btn-primary" onClick={()=>{setCreating(v=>!v);setEditing(null);}}>＋ 提交活動</button></div>
    {creating&&<form className="card experience-editor" onSubmit={e=>void save(e)}><h3>提交活動</h3><EventFields value={draft} onChange={setDraft} guilds={guilds}/><label className="field">活動海報（選填）<input type="file" accept="image/jpeg,image/png,image/webp" disabled={saving} onChange={e=>chooseBanner(e.target.files?.[0]??null)}/><small>直式、橫式皆可；JPEG、PNG 或 WebP，512 KiB 以下。{bannerFile?` 已選擇 ${bannerFile.name}`:''}</small></label><label className="field">活動影片（選填）<input type="file" accept="video/mp4,video/webm" disabled={saving} onChange={e=>chooseVideo(e.target.files?.[0]??null)}/><small>MP4 或 WebM，20 MiB 以下。{videoFile?` 已選擇 ${videoFile.name}`:''}</small></label><div className="experience-actions"><button className="btn btn-primary" disabled={busy||saving||Boolean(bannerError)}>送出審核</button><button type="button" className="btn btn-ghost" onClick={()=>{setCreating(false);setBannerFile(null);setVideoFile(null);setBannerError('');}}>返回</button></div></form>}
    {notice&&<p role="status" className="banner banner-info">{notice}</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}{bannerError&&<p role="alert" className="banner banner-error">{bannerError}</p>}{loadError&&<div role="alert" className="banner banner-error">{loadError}<button className="btn btn-ghost" onClick={()=>void load()}>重試</button></div>}
    {loading&&<p role="status">正在載入活動…</p>}
    {!loading&&<>{pending.length>0&&<><div className="experience-heading"><h2>待審核活動</h2><span>{pending.length} 場</span></div><div className="experience-grid">{pending.map(render)}</div></>}
      <EventCalendar events={upcoming} onOpen={id=>{window.location.hash=`events/${id}`}}/>
      <div className="experience-heading"><h2>即將舉辦</h2><span>{upcoming.length} 場</span></div>{upcoming.length?<div className="experience-grid">{upcoming.map(render)}</div>:<p className="empty">目前沒有即將舉辦的活動。你可以提交第一場。</p>}
      {past.length>0&&<details className="experience-history"><summary>查看已結束、取消或退回的活動（{past.length}）</summary><div className="experience-grid">{past.map(render)}</div></details>}
      <div className="experience-heading"><h2>系統公告欄</h2><span>最近 {bulletins.length} 則</span></div>{bulletins.length?<ol className="experience-bulletins">{bulletins.map(item=><li key={item.bulletin_id}><span>{item.message}</span><time dateTime={item.created_at}>{formatIsoLocal(item.created_at)}</time></li>)}</ol>:<p className="empty">目前沒有活動公告。</p>}
    </>}
  </section>;
}
