import {useEffect,useRef,useState} from 'react';
import {ApiError,type PortalClient} from '../../api';
import {prepareArImage,type ArImage} from './image';
import {compileArImage} from './compile';
import {ArScanner,type LocalScan,type ScanEntry} from './Scanner';
import type {ArContent} from './render';
import {createArExperience,bindingMetadata,type ArBinding} from '../../../../../packages/asset-storage/ar-target';
import {ArContentEditor} from './Editor';
import './ar.css';

type Target={target_id:string;kind:'member'|'event'|'custom';event_id:string|null;title:string;aggregate_version:string;ready:boolean;state:'draft'|'published'|'withdrawn';share_path:string|null};
type Event={event_id:string;title:string;organizer_ref:string;state:string;visibility:string};
type Job={key:string;bytes:Uint8Array;body:{kind:'member'|'custom';title:string;scene_event_id?:string}|{kind:'event';title:string;event_id:string};target?:Target;uploaded?:{aggregate_version:string}};
const issue=(error:unknown)=>error instanceof Error?error.message:'操作未完成，請重試。';
function download(blob:Blob,name:string){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
export function CommunityArPanel({client,enabled,userId,registerLeave}:{client:PortalClient;enabled:boolean;userId:string;registerLeave:(guard:(()=>boolean)|null)=>void}){
  const [view,setView]=useState<'scan'|'create'|'mine'>('scan'),[targets,setTargets]=useState<Target[]>([]),[scene,setScene]=useState<ScanEntry[]>([]),[more,setMore]=useState(false),[events,setEvents]=useState<Event[]>([]),[eventFilter,setEventFilter]=useState(''),[publishing,setPublishing]=useState(false),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState('');
  const [sceneEvent,setSceneEvent]=useState('');
  const [binding,setBinding]=useState<ArBinding|undefined>(undefined);
  const [image,setImage]=useState<ArImage|null>(null),[bytes,setBytes]=useState<Uint8Array|null>(null),[progress,setProgress]=useState<number|null>(null),[title,setTitle]=useState(''),[kind,setKind]=useState<'member'|'event'|'custom'>('member'),[eventId,setEventId]=useState(''),[preview,setPreview]=useState<LocalScan|null>(null),[busy,setBusy]=useState(false),[unknown,setUnknown]=useState(false),[notice,setNotice]=useState(''),[error,setError]=useState(''),[scanEntries,setScanEntries]=useState<ScanEntry[]|null>(null),[sharedPath,setSharedPath]=useState('');
  const lifetime=useRef(0),mounted=useRef(false),owner=useRef(client.sessionGeneration),preparing=useRef<AbortController|null>(null),imageRef=useRef<ArImage|null>(null),job=useRef<Job|null>(null),mutation=useRef<{target:Target;action:'publish'|'withdraw';key:string}|null>(null),lock=useRef(false),unload=useRef(false),guard=useRef<()=>boolean>(()=>true),sceneGeneration=useRef(0);
  const current=(generation:number)=>mounted.current&&lifetime.current===generation&&client.sessionGeneration===owner.current;
  unload.current=busy||unknown||progress!==null||!!image;
  guard.current=()=>{if(busy||unknown){setError('原操作尚未確認，請先重試原操作後再離開。');return false;}return !image||window.confirm('這個圖案還留在裝置上。要離開並捨棄未發布的內容嗎？');};
  useEffect(()=>{mounted.current=true;registerLeave(()=>guard.current());const before=(e:BeforeUnloadEvent)=>{if(unload.current){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',before);return()=>{mounted.current=false;lifetime.current++;preparing.current?.abort();if(imageRef.current)URL.revokeObjectURL(imageRef.current.previewUrl);registerLeave(null);window.removeEventListener('beforeunload',before);};},[registerLeave]);
  async function load(){if(!enabled)return;const generation=lifetime.current;setLoading(true);setLoadError('');try{const [own,eventList]=await Promise.all([client.get<{items:Target[];publishing_enabled:boolean}>('/ar/targets'),client.get<{items:Event[]}>('/events')]);if(current(generation)){setTargets(own.items);setPublishing(own.publishing_enabled);setEvents(eventList.items.filter(e=>e.state==='published'&&['open','referral'].includes(e.visibility)));}}catch(error){if(current(generation))setLoadError(issue(error));}finally{if(current(generation))setLoading(false);}}
  useEffect(()=>{void load();},[enabled]);
  useEffect(()=>{if(!enabled)return;const serial=++sceneGeneration.current,generation=lifetime.current;const control=new AbortController();setScene([]);setLoadError('');
    void client.get<{items:ScanEntry[];more_available:boolean}>(`/ar/scene${eventFilter?`?event=${eventFilter}`:''}`,{signal:control.signal}).then(result=>{if(current(generation)&&serial===sceneGeneration.current){setScene(result.items);setMore(result.more_available);}}).catch(error=>{if(!control.signal.aborted&&current(generation))setLoadError(issue(error));});return()=>control.abort();},[enabled,eventFilter,client]);
  async function choose(file?:File){if(!file||busy||unknown)return;preparing.current?.abort();const control=new AbortController();preparing.current=control;const generation=++lifetime.current;setProgress(0);setError('');setBytes(null);setPreview(null);
    try{const next=await prepareArImage(file,control.signal);if(!current(generation)||control.signal.aborted){URL.revokeObjectURL(next.previewUrl);return;}if(imageRef.current)URL.revokeObjectURL(imageRef.current.previewUrl);imageRef.current=next;setImage(next);setTitle(value=>value||'我的 AR 圖案');setNotice('圖片已留在裝置上，按「編譯圖案」繼續。');}
    catch(error){if(current(generation)&&!control.signal.aborted)setError(issue(error));}finally{if(current(generation))setProgress(null);}}
  async function compile(){if(!image||progress!==null)return;preparing.current?.abort();const control=new AbortController();preparing.current=control;const generation=lifetime.current;setProgress(0);setError('');
    try{const result=await compileArImage(image.blob,control.signal,value=>{if(current(generation))setProgress(value);});if(current(generation)){setBytes(result);setNotice('圖案已編譯，可以試掃或發布。');}}
    catch(error){if(current(generation)&&!control.signal.aborted)setError(issue(error));}finally{if(current(generation))setProgress(null);}}
  function switchView(next:typeof view){if(busy||unknown){setError('請先重試原操作，確認結果後再切換。');return;}preparing.current?.abort();setProgress(null);setPreview(null);setScanEntries(null);setView(next);}
  async function publish(){
    if(lock.current||!bytes||!title.trim()||kind==='event'&&!eventId)return;lock.current=true;setBusy(true);setError('');setNotice('');const generation=lifetime.current;
    const value=job.current??{key:crypto.randomUUID(),bytes:createArExperience(bytes,kind==='custom'?binding:undefined),body:kind!=='event'?{kind,title:title.trim(),...(sceneEvent?{scene_event_id:sceneEvent}:{})}:{kind,title:title.trim(),event_id:eventId}};job.current=value;
    try{
      value.target??=await client.post<Target>('/ar/targets',value.body,{idempotencyKey:value.key});if(!current(generation))return;
      value.uploaded??=await client.putArPattern<{aggregate_version:string}>(value.target.target_id,value.bytes,{idempotencyKey:value.key,ifMatch:value.target.aggregate_version});if(!current(generation))return;
      const result=await client.post<Target>(`/ar/targets/${value.target.target_id}/publish`,{},{idempotencyKey:value.key,ifMatch:value.uploaded.aggregate_version});if(!current(generation))return;
      job.current=null;setUnknown(false);setSharedPath(result.share_path??'');setNotice('已發布。分享掃描連結，讓朋友把圖案放進相機。');setView('mine');if(imageRef.current)URL.revokeObjectURL(imageRef.current.previewUrl);imageRef.current=null;setImage(null);setBytes(null);await load();
    }catch(error){if(!current(generation))return;const uncertain=error instanceof ApiError&&error.network;setUnknown(uncertain);setError(uncertain?'尚未確認發布結果。請按「重試原發布」，會沿用同一筆操作。':issue(error));if(!uncertain){job.current=null;await load();}}
    finally{lock.current=false;if(current(generation))setBusy(false);}
  }
  async function change(target:Target,action:'publish'|'withdraw'){
    if(lock.current)return;lock.current=true;setBusy(true);setError('');const generation=lifetime.current,value=mutation.current??{target,action,key:crypto.randomUUID()};mutation.current=value;
    try{await client.post(`/ar/targets/${value.target.target_id}/${value.action}`,{},{idempotencyKey:value.key,ifMatch:value.target.aggregate_version});if(current(generation)){mutation.current=null;setUnknown(false);setNotice(value.action==='withdraw'?'已撤下，新的掃描不會提供這個圖案。':'已發布。');await load();}}
    catch(error){if(current(generation)){const uncertain=error instanceof ApiError&&error.network;setUnknown(uncertain);setError(uncertain?'尚未確認結果，請重試原操作。':issue(error));if(!uncertain){mutation.current=null;await load();}}}finally{lock.current=false;if(current(generation))setBusy(false);}
  }
  const locked=busy||unknown;const localContent:ArContent={title:title||'我的 AR 圖案',kind,binding:kind==='custom'&&binding?bindingMetadata(binding):undefined,version:'local',pattern_url:'',destination:'',content:{nickname:kind==='member'?'你的公開名片':undefined,title:kind==='event'?events.find(e=>e.event_id===eventId)?.title??'活動預覽':undefined,headline:'裝置上的試掃預覽，尚未發布'}};
  if(preview)return <ArScanner local={preview} client={client} entries={[]} onClose={()=>setPreview(null)}/>;
  if(scanEntries)return <ArScanner entries={scanEntries} client={client} onClose={()=>setScanEntries(null)}/>;
  return <div className="community-ar">
    <header className="ar-header"><p className="eyebrow">FREEDOM AR</p><h1>把圖案變成認識你的入口</h1><p>穿在衣服上、貼在海報上。朋友用相機掃圖案，就能開啟你願意分享的名片或活動。</p></header>
    <nav className="ar-modes" aria-label="AR 工作方式">{([['scan','掃描圖案'],['create','製作圖案'],['mine','我的圖案']] as const).map(([id,label])=><button key={id} type="button" aria-pressed={view===id} onClick={()=>switchView(id)}>{label}</button>)}</nav>
    {!enabled&&<p className="banner">線上發布尚未開放。可以先選圖案、編譯並用自己的裝置試掃。</p>}
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button className="btn btn-ghost" type="button" onClick={()=>{void load();setEventFilter('');}}>重新載入</button></div>}
    {error&&<p className="banner banner-error" role="alert">{error}</p>}<p className="ar-status" role="status">{notice}</p>
    {view==='scan'&&<section className="ar-card"><h2>今天想探索什麼？</h2><label>活動範圍<select value={eventFilter} onChange={event=>setEventFilter(event.target.value)}><option value="">社群最新公開圖案</option>{events.map(e=><option key={e.event_id} value={e.event_id}>{e.title}</option>)}</select></label>
      <p className="muted">只載入這次選擇的圖案；活動範圍不代表參加或身分認證。</p>{loading?<p role="status">正在找圖案…</p>:!scene.length?<div className="ar-empty"><strong>還沒有可掃描的圖案</strong><p>先做一張自己的衣服圖案，或請夥伴傳他的 AR 掃描連結。</p><button className="btn btn-primary" type="button" onClick={()=>switchView('create')}>製作第一個圖案</button></div>:<><ul className="ar-target-list">{scene.map(entry=><li key={entry.url}><span>{entry.title}</span><button className="btn btn-ghost" type="button" onClick={()=>setScanEntries([entry])}>掃這個圖案</button></li>)}</ul><button className="btn btn-primary" type="button" onClick={()=>setScanEntries(scene)}>掃這組圖案</button></>}{more&&<p className="field-hint">此範圍有更多圖案。請縮小活動範圍，或使用夥伴分享的專屬連結。</p>}
    </section>}
    {view==='create'&&<section className="ar-card ar-create"><div><h2>一張圖案，一個驚喜</h2><ol className="ar-steps"><li>選擇圖片</li><li>編譯與試掃</li><li>連到公開內容</li></ol>
      <label className="ar-upload">{image?'更換圖案':'選擇衣服或海報上的圖片'}<input type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event=>{void choose(event.target.files?.[0]);event.target.value='';}}/></label>
      <p className="field-hint">使用你有權分享的圖案。8 MB 以下，至少 128 × 128；不同人的圖案應容易區分。</p>
      {image&&<><img className="ar-target-preview" src={image.previewUrl} alt="待辨識的完整圖案"/><p>{image.advice}</p><p className="field-hint">{image.width} × {image.height} · 建議是圖片細節分析，仍需實際試掃。</p><div className="ar-actions"><button className="btn btn-primary" type="button" disabled={locked||progress!==null} onClick={()=>{void compile();}}>{bytes?'重新編譯':'編譯圖案'}</button><button className="btn btn-ghost" type="button" disabled={locked} onClick={()=>download(image.blob,'freedom-ar-pattern.png')}>下載印刷圖案</button></div></>}
      {progress!==null&&<div role="status"><label>正在處理圖案 <progress value={progress} max={100}/>{progress}%</label><button className="btn btn-ghost" type="button" onClick={()=>{preparing.current?.abort();setProgress(null);setNotice('已取消處理，圖片仍保留。');}}>取消處理</button></div>}
      {bytes&&<div className="ar-actions"><button className="btn btn-ghost" type="button" disabled={locked||kind==='custom'&&!binding} onClick={()=>setPreview({bytes:createArExperience(bytes,kind==='custom'?binding:undefined),content:localContent})}>用相機試掃</button><button className="btn btn-ghost" type="button" onClick={()=>download(new Blob([createArExperience(bytes,kind==='custom'?binding:undefined) as Uint8Array<ArrayBuffer>],{type:'application/octet-stream'}),kind==='custom'?'freedom-ar-experience.freedom-ar':'freedom-ar-pattern.mind')}>下載辨識檔</button></div>}
    </div><div className="ar-destination"><h3>朋友掃到後，會看見什麼？</h3><fieldset disabled={locked}><legend>公開內容</legend><label><input type="radio" name="ar-kind" checked={kind==='member'} onChange={()=>setKind('member')}/>我的公開名片</label><label><input type="radio" name="ar-kind" checked={kind==='event'} onChange={()=>setKind('event')}/>我主辦的公開活動</label><label><input type="radio" name="ar-kind" checked={kind==='custom'} onChange={()=>setKind('custom')}/>自訂文字、特效、圖片或影片</label></fieldset>
      {kind==='custom'&&<ArContentEditor disabled={locked} onBinding={setBinding}/>}
      {kind==='member'?<p>沿用「我的名片」的公開範圍。關閉分享或更換名片連結後，這個 AR 入口也會失效。<a href="/#account">設定公開名片</a></p>:kind==='event'?<label>選擇活動<select value={eventId} disabled={locked} onChange={e=>setEventId(e.target.value)}><option value="">選擇已發布的活動</option>{events.filter(e=>e.organizer_ref===userId).map(e=><option key={e.event_id} value={e.event_id}>{e.title}</option>)}</select></label>:null}
      {kind!=='event'&&<label>在哪個活動展示？（選填）<select value={sceneEvent} disabled={locked} onChange={e=>setSceneEvent(e.target.value)}><option value="">只放在自己的掃描連結與社群圖案清單</option>{events.map(e=><option key={e.event_id} value={e.event_id}>{e.title}</option>)}</select></label>}
      <label>圖案名稱<input value={title} disabled={locked} maxLength={60} placeholder="例如：我的活動 T-shirt" onChange={e=>setTitle(e.target.value)}/></label>
      <p className="field-hint">發布會保存辨識檔，內含圖案的灰階資料。相機畫面與拍攝照片不會自動上傳。</p>
      <button className="btn btn-primary" type="button" disabled={busy||!enabled||!publishing||!bytes||!title.trim()||kind==='event'&&!eventId||kind==='custom'&&!binding} onClick={()=>{void publish();}}>{busy?'處理中…':unknown?'重試原發布':'發布 AR 圖案'}</button>
      {enabled&&!publishing&&<p>圖案儲存尚未啟用，可以先下載和試掃。</p>}
    </div></section>}
    {view==='mine'&&<section className="ar-card"><h2>我的 AR 圖案</h2>{!targets.length?<div className="ar-empty"><p>尚未建立圖案。從一件活動衣服或一張海報開始。</p><button className="btn btn-primary" type="button" onClick={()=>switchView('create')}>製作圖案</button></div>:<ul className="ar-target-list">{targets.map(target=><li key={target.target_id}><div><strong>{target.title}</strong><p className="field-hint">{target.state==='published'?'已發布':target.state==='withdrawn'?'已撤下':target.ready?'已上傳，待發布':'草稿，尚未上傳'} · {target.kind==='member'?'公開名片':target.kind==='event'?'公開活動':'自訂內容'}</p></div><div className="ar-actions">{target.share_path&&<a className="btn btn-ghost" href={target.share_path}>開啟掃描頁</a>}<button className="btn btn-ghost" type="button" disabled={locked||!target.ready} onClick={()=>{void change(target,target.state==='published'?'withdraw':'publish');}}>{target.state==='published'?'撤下':'發布'}</button></div></li>)}</ul>}
      {unknown&&mutation.current&&<button className="btn btn-primary" type="button" disabled={busy} onClick={()=>{void change(mutation.current!.target,mutation.current!.action);}}>重試原操作</button>}
      {sharedPath&&<div className="ar-link-ready"><label>給朋友的掃描連結<input readOnly value={window.location.origin+sharedPath} onFocus={e=>e.target.select()}/></label><a className="btn btn-ghost" href={sharedPath}>開啟試掃</a></div>}
    </section>}
  </div>;
}
export function PublicArPage({client,token}:{client:PortalClient;token:string}){
  return <main className="public-ar-page community-ar"><a className="ar-brand" href="/">自由工坊</a><ArScanner key={token} client={client} entries={[{title:'公開 AR 圖案',url:`/api/v1/public/ar/${token}`} ]}/></main>;
}
