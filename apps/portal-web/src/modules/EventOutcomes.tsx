import {useCallback,useEffect,useState} from 'react';
import {ApiError,type PortalClient} from '../api';

type Ref={kind:'work'|'skill_book'|'squad_outcome';id:string;title?:string;path?:string;author?:{user_id:string|null;display_name:string}|null;unavailable?:boolean;audience?:string};
type Outcome={outcome_id:string;event_id:string;title:string;summary:string;audience:'public'|'community'|'guild';state:'draft'|'published'|'withdrawn';aggregate_version:number;author:{user_id:string;display_name:string};refs:Ref[];media_ids:string[]};
const names={work:'社群作品',skill_book:'技能書',squad_outcome:'小隊成果'};
const key=(ref:Ref)=>`${ref.kind}/${ref.id}`;
const message=(reason:unknown)=>reason instanceof Error?reason.message:'這次未能完成，請重新載入後再試。';

export function EventOutcomes({client,eventId,onBindingChange,onChanged}:{client:PortalClient;eventId:string;onBindingChange:(id:string|null)=>void;onChanged:()=>Promise<void>}){
 const [items,setItems]=useState<Outcome[]>([]),[own,setOwn]=useState<Outcome[]>([]),[sources,setSources]=useState<Ref[]>([]);
 const [editing,setEditing]=useState<Outcome|null>(null),[title,setTitle]=useState(''),[summary,setSummary]=useState('');
 const [audience,setAudience]=useState<Outcome['audience']>('community'),[selected,setSelected]=useState<Ref[]>([]),[consent,setConsent]=useState(false);
 const [error,setError]=useState(''),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false);
 const load=useCallback(async()=>{
  const [published,history,available]=await Promise.all([
   client.get<{items:Outcome[]}>(`/event-highlights/${eventId}/outcomes`),
   client.get<{items:Outcome[]}>(`/event-highlights/${eventId}/outcomes/own`),
   client.get<{items:Ref[]}>(`/event-highlights/${eventId}/outcome-references`),
  ]);
  setItems(published.items);setOwn(history.items);setSources(available.items);
 },[client,eventId]);
 useEffect(()=>{
  let active=true;setItems([]);setOwn([]);setSources([]);setEditing(null);onBindingChange(null);
  void load().catch(reason=>{if(active)setError(message(reason));});
  return()=>{active=false;onBindingChange(null);};
 },[load,onBindingChange]);
 function edit(item:Outcome){
  setEditing(item);setTitle(item.title);setSummary(item.summary);setAudience(item.audience);
  setSelected(item.refs.map(ref=>({kind:ref.kind,id:ref.id})));setConsent(false);setError('');
  onBindingChange(item.state==='withdrawn'?null:item.outcome_id);
 }
 const dirty=Boolean(editing&&(title!==editing.title||summary!==editing.summary||audience!==editing.audience||selected.map(key).join('|')!==editing.refs.map(key).join('|')));
 async function reloadEditing(){
  if(!editing)return;setBusy(true);setError('');
  try{edit(await client.get<Outcome>(`/event-outcomes/${editing.outcome_id}`));}catch(reason){setError(message(reason));}finally{setBusy(false);}
 }
 async function save(event:React.FormEvent){
  event.preventDefault();setBusy(true);setError('');setNotice('');
  try{
   const value=await client.post<Outcome>(editing?`/event-outcomes/${editing.outcome_id}/update`:`/event-highlights/${eventId}/outcomes`,{title,summary,audience,refs:selected.map(({kind,id})=>({kind,id}))},{idempotencyKey:crypto.randomUUID(),...(editing?{ifMatch:editing.aggregate_version}:{})});
   edit(value);setNotice('摘要草稿已儲存。下方補上媒體時會綁定這份草稿，明確發布前只有你可閱讀。');
   await load();await onChanged();
  }catch(reason){setError(message(reason));}finally{setBusy(false);}
 }
 async function mutate(item:Outcome,action:'publish'|'withdraw'){
  setBusy(true);setError('');setNotice('');
  try{
   if(action==='publish'&&(!consent||dirty))throw new Error('請先儲存最新內容並確認發布權利與範圍。');
   const value=await client.post<Outcome>(`/event-outcomes/${item.outcome_id}/${action}`,action==='publish'?{consent_to_share:true}:{},{idempotencyKey:crypto.randomUUID(),ifMatch:item.aggregate_version});
   if(editing?.outcome_id===item.outcome_id)edit(value);
   setConsent(false);setNotice(action==='publish'?'活動精華已依所選範圍發布。':'精華已撤下；綁定媒體與成果反向連結也停止顯示。');
   await load();await onChanged();
  }catch(reason){
   setError(message(reason));
   if(reason instanceof ApiError&&reason.status===412)setNotice('版本已變更。目前輸入保留；重新載入原紀錄會明確取代這些未儲存內容。');
  }finally{setBusy(false);}
 }
 return <section className="card stack outcome-section" aria-label="活動精華與成果">
  <h2>活動精華與成果</h2>
  <p className="field-hint">只整理自己有權分享的摘要與媒體。不可擷取私人對話、私有 Result；活動連結不代表出席、驗收或 XP。來源撤下或權限變更時，相關摘要、媒體與反向連結會停止顯示。</p>
  {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
  <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void load().catch(reason=>setError(message(reason)))}>重新載入精華與來源</button>
  {items.map(item=><article key={item.outcome_id} className="stack">
   <h3>{item.title}</h3><p>作者：{item.author.display_name}</p><p className="multiline-text">{item.summary}</p>
   {item.refs.length>0&&<ul>{item.refs.map(ref=><li key={key(ref)}>
    {ref.path&&ref.title?<a href={ref.path}>{ref.title}</a>:<span>來源目前不可閱讀</span>}
    {ref.author&&` · 作者：${ref.author.display_name}`}
   </li>)}</ul>}
  </article>)}
  <details><summary>整理自己的精華、媒體與成果來源</summary><div className="stack">
   {own.map(item=><div className="actions" key={item.outcome_id}>
    <span>{item.title} · {item.state==='draft'?'私人草稿':item.state==='published'?'已發布':'已撤下'}</span>
    <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>edit(item)}>選取這份精華</button>
    {item.state==='published'&&<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void mutate(item,'withdraw')}>撤下這份精華</button>}
   </div>)}
   <form className="stack" onSubmit={save}>
    <h3>{editing?'編輯自己的精華':'建立自己的精華'}</h3>
    <label className="field">精華標題<input required maxLength={120} value={title} disabled={busy||editing?.state==='published'} onChange={event=>{setTitle(event.target.value);setConsent(false);}}/></label>
    <label className="field">活動摘要<textarea required maxLength={4000} rows={4} value={summary} disabled={busy||editing?.state==='published'} onChange={event=>{setSummary(event.target.value);setConsent(false);}}/></label>
    <label className="field">發布範圍<select value={audience} disabled={busy||editing?.state==='published'} onChange={event=>{setAudience(event.target.value as Outcome['audience']);setConsent(false);}}><option value="community">社群會員</option><option value="guild">主辦公會目前成員</option><option value="public">任何人（公開）</option></select></label>
    <fieldset disabled={busy||editing?.state==='published'}><legend>相關成果（選填，最多 8 項）</legend>
     <p className="field-hint">作品只對社群會員開放，不能綁定到公開精華。小隊成果與技能書仍依原作者目前發布權限。</p>
     {sources.map(ref=><label className="choice" key={key(ref)}>
      <input type="checkbox" checked={selected.some(value=>key(value)===key(ref))} onChange={event=>{setConsent(false);setSelected(values=>event.target.checked?[...values,{kind:ref.kind,id:ref.id}]:values.filter(value=>key(value)!==key(ref)));}} disabled={selected.length>=8&&!selected.some(value=>key(value)===key(ref))}/>
      {names[ref.kind]} · {ref.title} {ref.author?` · ${ref.author.display_name}`:''}
     </label>)}
     {selected.filter(ref=>!sources.some(value=>key(value)===key(ref))).map(ref=><label className="choice" key={key(ref)}><input type="checkbox" checked onChange={()=>setSelected(values=>values.filter(value=>key(value)!==key(ref)))}/>原來源目前不可閱讀；取消勾選以移除</label>)}
    </fieldset>
    <div className="actions">
     <button className="btn btn-secondary btn-small" disabled={busy||editing?.state==='published'}>儲存私人草稿</button>
     <button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>{setEditing(null);setTitle('');setSummary('');setAudience('community');setSelected([]);setConsent(false);onBindingChange(null);}}>建立另一份</button>
     {editing&&<button type="button" className="btn btn-secondary btn-small" disabled={busy} onClick={()=>void reloadEditing()}>重新載入原紀錄（取代未儲存輸入）</button>}
    </div>
    {editing&&editing.state==='draft'&&<>
     <p>下方媒體上傳目前綁定最後儲存的精華：{editing.title}。成功項目保留；失敗不會抹除摘要。</p>
     <label className="choice"><input type="checkbox" checked={consent} disabled={busy||dirty} onChange={event=>setConsent(event.target.checked)}/>我有權向所選範圍發布摘要、連結與綁定媒體，已保留真實作者及來源，並取得涉及人物所需同意。</label>
     <button type="button" className="btn btn-secondary btn-small" disabled={busy||!consent||dirty} onClick={()=>void mutate(editing,'publish')}>發布已儲存精華與綁定媒體</button>
    </>}
    {editing?.state==='published'&&<p>已發布內容須先撤下才能修改；新增媒體仍需確認原發布授權。</p>}
    {!editing&&<p className="field-hint">尚未選取精華。下方新增媒體會沿用原活動集錦的閱讀範圍；要保持私人草稿，請先儲存並選取精華。</p>}
   </form>
  </div></details>
 </section>;
}
