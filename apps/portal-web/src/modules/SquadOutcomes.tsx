import {useCallback,useEffect,useState} from 'react';
import {ApiError,type PortalClient} from '../api';
import {EventOutcomeBacklinks} from './EventOutcomeBacklinks';

type Outcome={outcome_id:string;squad_id:string;squad_name:string;title:string;summary:string;artifact_url:string|null;author:{user_id:string;display_name:string};audience:'squad'|'community'|'public';state:'draft'|'published'|'withdrawn';aggregate_version:number};
const audienceName={squad:'目前小隊成員',community:'社群會員',public:'任何人（公開）'};
const errorMessage=(error:unknown)=>error instanceof Error?error.message:'這次未能完成，請重新載入後再試。';

export function SquadOutcomeDetail({client,id,eventLinksEnabled=false}:{client:PortalClient;id:string;eventLinksEnabled?:boolean}){
 const [outcome,setOutcome]=useState<Outcome|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{
  let active=true;setOutcome(null);setError('');
  void client.get<Outcome>(`/squad-outcomes/${id}`).then(value=>{if(active)setOutcome(value);}).catch(reason=>{if(active)setError(errorMessage(reason));});
  return()=>{active=false;};
 },[client,id,revision]);
 if(error)return <section className="card stack outcome-section"><p role="alert">{error}</p><button className="btn btn-secondary btn-small" onClick={()=>setRevision(value=>value+1)}>重新載入成果</button><a href="#squads">返回小隊</a></section>;
 if(!outcome)return <p role="status">正在載入小隊成果…</p>;
 return <article className="card stack outcome-section">
  <a href="#squads">返回小隊</a><h2>{outcome.title}</h2>
  <p>小隊：{outcome.squad_name} · 作者：{outcome.author.display_name}</p>
  <p>{audienceName[outcome.audience]} · {outcome.state==='published'?'已發布':outcome.state==='draft'?'私人草稿':'已撤下'}</p>
  <p className="multiline-text">{outcome.summary}</p>
  {outcome.artifact_url&&<a href={outcome.artifact_url} target="_blank" rel="noopener noreferrer">開啟作者提供的成果來源 ↗</a>}
  {outcome.state==='published'&&outcome.audience==='public'&&<a href={`/squad-outcomes/${outcome.outcome_id}`} target="_blank" rel="noopener noreferrer">公開成果頁 ↗</a>}
  {eventLinksEnabled&&outcome.state==='published'&&<EventOutcomeBacklinks client={client} kind="squad_outcome" sourceId={outcome.outcome_id}/>}
 </article>;
}

export function SquadOutcomePublisher({client,squadId,owner,actorId,eventLinksEnabled=false}:{client:PortalClient;squadId:string;owner:boolean;actorId:string;eventLinksEnabled?:boolean}){
 const [items,setItems]=useState<Outcome[]>([]),[nextOffset,setNextOffset]=useState<number|null>(null);
 const [editing,setEditing]=useState<Outcome|null>(null),[title,setTitle]=useState(''),[summary,setSummary]=useState(''),[url,setUrl]=useState('');
 const [audience,setAudience]=useState<Outcome['audience']>('squad'),[consent,setConsent]=useState(false);
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const dirty=Boolean(editing&&(title!==editing.title||summary!==editing.summary||url!==(editing.artifact_url??'')));
 const load=useCallback(async(offset=0)=>{
  const value=await client.get<{items:Outcome[];next_offset:number|null}>(`/squads/${squadId}/outcomes?offset=${offset}`);
  setItems(previous=>offset?[...previous.filter(item=>!value.items.some(next=>next.outcome_id===item.outcome_id)),...value.items]:value.items);
  setNextOffset(value.next_offset);
 },[client,squadId]);
 useEffect(()=>{
  setEditing(null);setTitle('');setSummary('');setUrl('');setError('');setNotice('');
  void load().catch(reason=>setError(errorMessage(reason)));
 },[load]);
 function edit(item:Outcome){
  setEditing(item);setTitle(item.title);setSummary(item.summary);setUrl(item.artifact_url??'');
  setAudience(item.audience);setConsent(false);setError('');setNotice('');
 }
 async function reloadEditing(){
  if(!editing)return;
  setBusy(true);setError('');
  try{edit(await client.get<Outcome>(`/squad-outcomes/${editing.outcome_id}`));}catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}
 }
 async function save(event:React.FormEvent){
  event.preventDefault();setBusy(true);setError('');setNotice('');
  try{
   const result=await client.post<Outcome>(editing?`/squad-outcomes/${editing.outcome_id}/edit`:`/squads/${squadId}/outcomes`,{title,summary,artifact_url:url.trim()||null},{idempotencyKey:crypto.randomUUID(),...(editing?{ifMatch:editing.aggregate_version}:{})});
   edit(result);setNotice('私人草稿已儲存；尚未發布。');await load();
  }catch(reason){setError(errorMessage(reason));}finally{setBusy(false);}
 }
 async function action(item:Outcome,operation:'publish'|'withdraw'){
  setBusy(true);setError('');setNotice('');
  try{
   if(operation==='publish'&&(!consent||dirty))throw new Error('請先儲存最新內容並明確確認發布權利與範圍。');
   const result=await client.post<Outcome>(`/squad-outcomes/${item.outcome_id}/${operation}`,operation==='publish'?{audience,consent_to_share:true}:{},{idempotencyKey:crypto.randomUUID(),ifMatch:item.aggregate_version});
   if(editing?.outcome_id===item.outcome_id)edit(result);
   setConsent(false);setNotice(operation==='publish'?'成果已依所選範圍發布。':'成果已撤下；活動連結與公開頁會依目前權限停止顯示。');await load();
  }catch(reason){
   setError(errorMessage(reason));
   if(reason instanceof ApiError&&reason.status===412)setNotice('版本已變更。目前輸入保留；重新載入原紀錄會明確取代這些未儲存內容。');
  }finally{setBusy(false);}
 }
 return <section className="stack outcome-section" aria-label="小隊成果">
  <h3>小隊成果</h3><p className="field-hint">這裡是作者明確發布的成果，不是小隊名冊、出席或私人 Result；不代表官方驗收或 XP。</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void load().catch(reason=>setError(errorMessage(reason)))}>重新載入成果列表</button>
  {items.map(item=><article className="card stack" key={item.outcome_id}>
   <h4><a href={`#squad-outcomes/${item.outcome_id}`}>{item.title}</a></h4>
   <p>{audienceName[item.audience]} · {item.state==='published'?'已發布':item.state==='draft'?'草稿':'已撤下'}</p>
   <p className="multiline-text">{item.summary}</p><p>作者：{item.author.display_name}</p>
   {eventLinksEnabled&&item.state==='published'&&<EventOutcomeBacklinks client={client} kind="squad_outcome" sourceId={item.outcome_id}/>}
   {owner&&item.author.user_id===actorId&&<div className="actions">
    {item.state!=='published'&&<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>edit(item)}>編輯這份成果</button>}
    {item.state==='published'&&<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void action(item,'withdraw')}>撤下這份成果</button>}
   </div>}
  </article>)}
  {nextOffset!==null&&<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void load(nextOffset).catch(reason=>setError(errorMessage(reason)))}>載入更多成果</button>}
  {!items.length&&<p>目前沒有你可閱讀的小隊成果。</p>}
  {owner&&<form className="stack" onSubmit={save}>
   <h4>{editing?'編輯自己的成果':'建立自己的成果草稿'}</h4>
   <label className="field">成果標題<input required maxLength={120} value={title} disabled={busy||editing?.state==='published'} onChange={event=>{setTitle(event.target.value);setConsent(false);}}/></label>
   <label className="field">成果摘要<textarea required maxLength={4000} rows={4} value={summary} disabled={busy||editing?.state==='published'} onChange={event=>{setSummary(event.target.value);setConsent(false);}}/></label>
   <label className="field">成果來源連結（選填）<input type="url" maxLength={2000} value={url} disabled={busy||editing?.state==='published'} onChange={event=>{setUrl(event.target.value);setConsent(false);}}/></label>
   <div className="actions">
    <button className="btn btn-secondary btn-small" disabled={busy||editing?.state==='published'}>儲存私人草稿</button>
    <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>{setEditing(null);setTitle('');setSummary('');setUrl('');setConsent(false);setAudience('squad');}}>建立另一份</button>
    {editing&&<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void reloadEditing()}>重新載入原紀錄（取代未儲存輸入）</button>}
   </div>
   {editing&&editing.state!=='published'&&<>
    <label className="field">發布範圍<select value={audience} disabled={busy} onChange={event=>{setAudience(event.target.value as Outcome['audience']);setConsent(false);}}><option value="squad">目前小隊成員</option><option value="community">社群會員</option><option value="public">任何人（公開）</option></select></label>
    <label className="choice"><input type="checkbox" checked={consent} disabled={busy||dirty} onChange={event=>setConsent(event.target.checked)}/>我有權發布文字與來源、已取得涉及人物所需同意，並同意向所選範圍分享作者與小隊名稱。這不是平台正式驗收。</label>
    <button type="button" className="btn btn-secondary btn-small" disabled={busy||!consent||dirty} onClick={()=>void action(editing,'publish')}>依所選範圍發布已儲存草稿</button>
    <p className="field-hint">修改後請先儲存。已發布成果須先撤下才能編輯。</p>
   </>}
   {editing?.state==='published'&&<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void action(editing,'withdraw')}>撤下後再編輯</button>}
  </form>}
 </section>;
}
