import {createContext,useContext,useEffect,useId,useRef,useState,type ReactNode} from 'react';
import {ApiError,type PortalClient} from '../api';
import './MemberReporting.css';

export type ReportKind='post'|'comment'|'direct_message'|'channel_message'|'member';
type Reason='harassment'|'spam'|'fraud'|'other';
export type ReportCase={case_id:string;case_number:string;state:'received'|'in_progress'|'closed';aggregate_version:number;summary:string|null;created_at:string};
export type AdminReportCase=ReportCase&{target_kind:ReportKind;target_id:string;reason:Reason;note?:string|null;evidence?:unknown;image_url?:string|null;handler_user_id:string|null;processing_reason:string|null;action:'none'|'hide'|'restore'};
const stateLabel={received:'已收到',in_progress:'處理中',closed:'已結案'};
const reasons:[Reason,string][]=[['harassment','騷擾'],['spam','垃圾訊息'],['fraud','詐騙'],['other','其他']];
const policy='正式檢舉規則、保留期限與人工申訴管道尚未提供。請勿把私人證據貼到 GitHub。';
type Target={kind:ReportKind;id:string;label:string};
const ReportingContext=createContext<((target:Target,trigger:HTMLButtonElement)=>void)|null>(null);

export function ReportButton({kind,id,label}:{kind:ReportKind;id:string;label:string}){
  const open=useContext(ReportingContext);
  return open?<button type="button" className="btn btn-ghost report-entry" aria-label={`檢舉${label}`} aria-haspopup="dialog" onClick={event=>open({kind,id,label},event.currentTarget)}>檢舉</button>:null;
}

export function MemberReportingProvider({client,enabled,children}:{client:PortalClient;enabled:boolean;children:ReactNode}){
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement|null>(null),title=useId();
  const [target,setTarget]=useState<Target|null>(null),[reason,setReason]=useState<Reason>('harassment'),[note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[result,setResult]=useState<ReportCase|null>(null);
  const pending=useRef<{body:{target_kind:ReportKind;target_id:string;reason:Reason;note?:string};key:string}|null>(null),lock=useRef(false),alive=useRef(true),generation=client.sessionGeneration;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{if(target&&enabled)dialog.current?.showModal();},[target,enabled]);
  const close=()=>{dialog.current?.close();setTarget(null);trigger.current?.focus();};
  async function send(){
    if(!target||lock.current||client.sessionGeneration!==generation)return;
    const command=pending.current??{body:{target_kind:target.kind,target_id:target.id,reason,...(note.trim()?{note:note.trim()}:{})},key:crypto.randomUUID()};
    pending.current=command;lock.current=true;setBusy(true);setError('');
    try{const value=await client.post<ReportCase>('/me/reports',command.body,{idempotencyKey:command.key,suppressConsole:true});if(!alive.current||generation!==client.sessionGeneration)return;pending.current=null;setResult(value);}
    catch(cause){if(!alive.current||generation!==client.sessionGeneration)return;if(cause instanceof ApiError&&!cause.network&&cause.status<500)pending.current=null;setError(cause instanceof Error?cause.message:'尚未確認檢舉結果，請重試同一筆檢舉。');}
    finally{lock.current=false;if(alive.current&&generation===client.sessionGeneration)setBusy(false);}
  }
  const open=(next:Target,button:HTMLButtonElement)=>{trigger.current=button;if(pending.current){const held=pending.current.body;setTarget({kind:held.target_kind,id:held.target_id,label:'先前尚未確認的內容'});}else{setReason('harassment');setNote('');setError('');setResult(null);setTarget(next);}};
  return <ReportingContext.Provider value={enabled?open:null}>{children}{enabled&&<dialog ref={dialog} className="report-dialog" aria-labelledby={title} onCancel={event=>{event.preventDefault();close();}}><div className="stack"><header className="card-head"><h2 id={title}>檢舉{target?.label}</h2><button type="button" className="btn btn-ghost" onClick={close}>關閉檢舉</button></header><p className="field-hint">{policy}</p>{result?<p role="status">已收到檢舉，案件編號：{result.case_number} · {stateLabel[result.state]}</p>:<form className="stack" onSubmit={event=>{event.preventDefault();void send();}} aria-busy={busy}><label className="field">檢舉原因<select value={reason} disabled={busy||Boolean(pending.current)} onChange={event=>setReason(event.target.value as Reason)}>{reasons.map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label><label className="field">補充說明（選填）<textarea rows={3} value={note} disabled={busy||Boolean(pending.current)} onChange={event=>setNote(event.target.value)}/></label>{error&&<p className="banner banner-error" role="alert">{error}</p>}{pending.current&&error&&<p role="status">結果尚未確認；保留同一筆內容與操作識別碼，重試不會另建案件。</p>}<button className="btn btn-primary" disabled={busy}>{busy?'送出中…':pending.current?'重試同一筆檢舉':'送出檢舉'}</button></form>}</div></dialog>}</ReportingContext.Provider>;
}

export function OwnReports({client}:{client:PortalClient}){
  const enabled=useContext(ReportingContext),[open,setOpen]=useState(false),[items,setItems]=useState<ReportCase[]|null>(null),[cursor,setCursor]=useState<string|null>(null),[error,setError]=useState(''),[loading,setLoading]=useState(false),sequence=useRef(0),generation=client.sessionGeneration;
  useEffect(()=>()=>{sequence.current++;},[]);
  async function load(next?:string){
    const ticket=++sequence.current;setError('');setLoading(true);
    try{const value=await client.get<{items:ReportCase[];next_cursor:string|null}>('/me/reports'+(next?'?cursor='+encodeURIComponent(next):''),{suppressConsole:true});
      if(ticket===sequence.current&&generation===client.sessionGeneration){setItems(previous=>next?[...(previous??[]),...value.items.filter(item=>!previous?.some(old=>old.case_id===item.case_id))]:value.items);setCursor(value.next_cursor);}}
    catch(cause){if(ticket===sequence.current&&generation===client.sessionGeneration){if(cause instanceof ApiError&&[401,403,404].includes(cause.status)){setItems(null);setCursor(null);}setError(cause instanceof Error?cause.message:'案件暫時無法讀取。');}}
    finally{if(ticket===sequence.current&&generation===client.sessionGeneration)setLoading(false);}
  }
  if(!enabled)return null;
  return <section className="card stack"><button type="button" className="btn btn-ghost" aria-expanded={open} onClick={()=>{setOpen(!open);if(!open)void load();}}>我的檢舉案件</button>{open&&<><h3>我的檢舉案件</h3><p className="field-hint">{policy}</p>{loading&&<p role="status">載入案件…</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}{items?.map(item=><article className="stack" key={item.case_id}><strong>{item.case_number} · {stateLabel[item.state]}</strong><time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString('zh-TW')}</time><p>{item.summary??'尚無處理摘要'}</p></article>)}{items?.length===0&&<p>目前沒有檢舉案件。</p>}<div className="button-row"><button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void load()}>更新檢舉案件</button>{cursor&&<button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void load(cursor)}>更多檢舉案件</button>}</div></>}</section>;
}

const targetLabels:Record<ReportKind,string>={post:'社群貼文',comment:'社群留言',direct_message:'私人訊息',channel_message:'頻道訊息',member:'會員名片'};
function ReportEvidence({item}:{item:AdminReportCase}){
  const evidence=item.evidence as {captured_at?:string;content?:Record<string,unknown>},content=evidence?.content??{};
  const fields=[['nickname','會員名稱'],['display_name','作者'],['title','標題'],['body','內容'],['note','貼文內容'],['url','原始連結'],['sticker_id','貼圖']] as const;
  return <div className="stack">
    {item.note&&<p>補充說明：{item.note}</p>}
    {evidence?.captured_at&&<p className="field-hint">證據保存時間：<time dateTime={evidence.captured_at}>{new Date(evidence.captured_at).toLocaleString('zh-TW')}</time></p>}
    {fields.map(([key,label])=>typeof content[key]==='string'&&content[key]?<p key={key} className="report-evidence-copy"><strong>{label}：</strong>{content[key]}</p>:null)}
    {item.image_url&&<img className="report-evidence-image" src={item.image_url} alt="檢舉當時的私人訊息圖片"/>}
    <details><summary>核對完整證據紀錄</summary><pre>{JSON.stringify(item.evidence,null,2)}</pre></details>
  </div>;
}

type ReportAction='none'|'hide'|'restore';
type TransitionBody={state:'in_progress'|'closed';reason:string;summary:string;action:ReportAction};

function AdminReportItem({client,item,onSaved,onDenied,onHeld}:{client:PortalClient;item:AdminReportCase;onSaved:(item:ReportCase)=>void;onDenied:()=>void;onHeld:(held:boolean)=>void}){
  const [reason,setReason]=useState(''),[summary,setSummary]=useState(''),[action,setAction]=useState<ReportAction>('none'),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const [detail,setDetail]=useState<AdminReportCase|null>(null),[detailError,setDetailError]=useState(''),[detailBusy,setDetailBusy]=useState(false),detailTicket=useRef(0);
  const pending=useRef<{body:TransitionBody;key:string;version:number}|null>(null),lock=useRef(false),alive=useRef(true),generation=client.sessionGeneration;
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  async function send(){
    if(lock.current||generation!==client.sessionGeneration||(item.state==='closed'&&!pending.current))return;
    const command=pending.current??{body:{state:item.state==='received'?'in_progress':'closed',reason:reason.trim(),summary:summary.trim(),action},key:crypto.randomUUID(),version:item.aggregate_version};
    pending.current=command;onHeld(true);lock.current=true;setBusy(true);setError('');
    try{
      const value=await client.post<ReportCase>(`/admin/reports/${encodeURIComponent(item.case_id)}/transition`,command.body,{idempotencyKey:command.key,ifMatch:command.version,suppressConsole:true});
      if(!alive.current||generation!==client.sessionGeneration)return;
      pending.current=null;onHeld(false);onSaved(value);setReason('');setSummary('');setAction('none');
    }catch(cause){
      if(!alive.current||generation!==client.sessionGeneration)return;
      if(cause instanceof ApiError&&!cause.network&&cause.status<500){pending.current=null;onHeld(false);if([401,403,404].includes(cause.status)){onDenied();return;}}
      setError(cause instanceof Error?cause.message:'案件操作結果尚未確認，請重試同一筆操作。');
    }finally{lock.current=false;if(alive.current&&generation===client.sessionGeneration)setBusy(false);}
  }
  async function readEvidence(){
    const ticket=++detailTicket.current;setDetailBusy(true);setDetailError('');
    try{const value=await client.get<AdminReportCase>(`/admin/reports/${encodeURIComponent(item.case_id)}`,{suppressConsole:true});if(alive.current&&ticket===detailTicket.current&&generation===client.sessionGeneration)setDetail(value);}
    catch(cause){if(alive.current&&ticket===detailTicket.current&&generation===client.sessionGeneration){setDetail(null);if(cause instanceof ApiError&&[401,403,404].includes(cause.status)){onDenied();return;}setDetailError(cause instanceof Error?cause.message:'證據暫時無法讀取。');}}
    finally{if(alive.current&&ticket===detailTicket.current&&generation===client.sessionGeneration)setDetailBusy(false);}
  }
  return <article className="card stack report-admin-case" aria-label={`案件 ${item.case_number}`}>
    <h3>{item.case_number} · {stateLabel[item.state]}</h3>
    <p>檢舉原因：{reasons.find(([value])=>value===item.reason)?.[1]??item.reason}</p>
    <p>內容類型：{targetLabels[item.target_kind]}</p>
    <details onToggle={event=>{if(event.target!==event.currentTarget)return;if(event.currentTarget.open)void readEvidence();else{detailTicket.current++;setDetail(null);setDetailBusy(false);}}}><summary>查看案件證據</summary>
      {detailBusy&&<p role="status">載入證據…</p>}{detailError&&<p role="alert">{detailError}</p>}
      {detail&&<ReportEvidence item={detail}/>}
    </details>
    <p>處理摘要：{item.summary??'尚無處理摘要'}</p>
    <p>處理人：{item.handler_user_id??'尚未指派'}</p>
    <p>處理理由：{item.processing_reason??'尚無處理理由'}</p>
    <p>已記錄內容動作：{{none:'不變更內容',hide:'隱藏內容',restore:'恢復內容'}[item.action]??'尚無內容動作'}</p>
    {(item.state!=='closed'||Boolean(pending.current))&&<form className="stack" onSubmit={event=>{event.preventDefault();void send();}} aria-busy={busy}>
      <label className="field">處理理由<textarea required rows={2} value={reason} disabled={busy||Boolean(pending.current)} onChange={event=>setReason(event.target.value)}/></label>
      <label className="field">處理摘要<textarea required rows={2} value={summary} disabled={busy||Boolean(pending.current)} onChange={event=>setSummary(event.target.value)}/></label>
      <label className="field">內容動作<select value={action} disabled={busy||Boolean(pending.current)} onChange={event=>setAction(event.target.value as ReportAction)}><option value="none">不變更內容</option>{(item.target_kind==='post'||item.target_kind==='comment')&&<><option value="hide">隱藏內容</option><option value="restore">恢復內容</option></>}</select></label>
      {error&&<p className="banner banner-error" role="alert">{error}</p>}
      {pending.current&&error&&<p role="status">結果尚未確認；保留原處理內容、版本與操作識別碼。案件尚未顯示為處理完成。</p>}
      <button type="submit" className="btn btn-primary" disabled={busy||!reason.trim()||!summary.trim()}>{busy?'送出中…':pending.current?'重試同一筆案件操作':item.state==='received'?'開始處理':'結案'}</button>
    </form>}
  </article>;
}

/** Only a successful member-session API read grants evidence UI access. */
export function AdminReports({client}:{client:PortalClient}){
  const enabled=useContext(ReportingContext),[items,setItems]=useState<AdminReportCase[]|null>(null),[open,setOpen]=useState(false),[loading,setLoading]=useState(false),[error,setError]=useState(''),[cursor,setCursor]=useState<string|null>(null),[filter,setFilter]=useState(''),[heldCount,setHeldCount]=useState(0),held=useRef(new Set<string>()),sequence=useRef(0),generation=client.sessionGeneration;
  async function load(next?:string,state=filter){
    if(held.current.size)return;
    const ticket=++sequence.current;setLoading(true);setError('');
    const query=new URLSearchParams();if(next)query.set('cursor',next);if(state)query.set('state',state);
    try{const value=await client.get<{items:AdminReportCase[];next_cursor:string|null}>('/admin/reports'+(query.size?'?'+query.toString():''),{suppressConsole:true});if(ticket===sequence.current&&generation===client.sessionGeneration){setItems(previous=>next?[...(previous??[]),...value.items.filter(item=>!previous?.some(old=>old.case_id===item.case_id))]:value.items);setCursor(value.next_cursor);}}
    catch(cause){if(ticket===sequence.current&&generation===client.sessionGeneration){if(cause instanceof ApiError&&!cause.network&&[401,403,404].includes(cause.status)){setItems(null);setOpen(false);setCursor(null);}setError(cause instanceof Error?cause.message:'案件暫時無法讀取。');}}
    finally{if(ticket===sequence.current&&generation===client.sessionGeneration)setLoading(false);}
  }
  useEffect(()=>{if(enabled)void load();return()=>{sequence.current++;};},[enabled,client,generation]);
  if(!enabled||items===null)return null;
  return <section className="card stack report-admin" aria-label="平台檢舉案件">
    <button type="button" className="btn btn-ghost" aria-expanded={open} onClick={()=>{setOpen(!open);if(!open)void load();}}>平台檢舉案件</button>
    <div hidden={!open} className="stack"><h2>平台檢舉案件</h2><p className="field-hint">{policy}</p>
      <label className="field">案件狀態<select aria-label="案件狀態" value={filter} disabled={loading||heldCount>0} onChange={event=>{const state=event.target.value;setFilter(state);setItems([]);setCursor(null);void load(undefined,state);}}><option value="">全部狀態</option>{Object.entries(stateLabel).map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></label>
      {loading&&<p role="status">載入案件…</p>}{error&&<p role="alert">{error}</p>}
      {items.map(item=><AdminReportItem key={item.case_id} client={client} item={item} onHeld={pending=>{if(pending){held.current.add(item.case_id);sequence.current++;setLoading(false);}else held.current.delete(item.case_id);setHeldCount(held.current.size);}} onDenied={()=>{sequence.current++;held.current.clear();setHeldCount(0);setItems(null);setOpen(false);setCursor(null);}} onSaved={value=>{setItems(previous=>previous?.map(current=>current.case_id===value.case_id?{...current,...value}:current)??null);void load();}}/>)}
      {items.length===0&&<p>目前沒有檢舉案件。</p>}
      <div className="button-row"><button type="button" className="btn btn-ghost" disabled={loading||heldCount>0} onClick={()=>void load()}>更新平台檢舉案件</button>{cursor&&<button type="button" className="btn btn-ghost" disabled={loading||heldCount>0} onClick={()=>void load(cursor)}>更多平台檢舉案件</button>}</div>
    </div>
  </section>;
}
