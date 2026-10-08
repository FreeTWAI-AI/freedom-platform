import {useCallback,useEffect,useId,useRef,useState} from 'react';
import {BlockListSchema,BlockStateSchema} from '../../../../packages/shared/member-blocking';
import type {BlockList,BlockState} from '../../../../packages/shared/member-blocking';
import type {PortalClient} from '../api';
import {useModuleMutation} from './shared';
import {announceInboxChange} from './member-inbox';

// Keep an uncertain command's version and key until the member explicitly retries it.
export function MemberBlockingAction({client,userId,nickname,onChanged,active,onDismiss}:{client:PortalClient;userId:string;nickname:string;onChanged:()=>void|Promise<void>;active?:boolean;onDismiss?:()=>void}){
  const id=useId(),button=useRef<HTMLButtonElement>(null),region=useRef<HTMLDivElement>(null),trigger=useRef<HTMLElement|null>(null);
  const [open,setOpen]=useState(false),[state,setState]=useState<BlockState|null>(null),[loading,setLoading]=useState(false),[loadError,setLoadError]=useState(''),[notice,setNotice]=useState('');
  const [attempt,setAttempt]=useState<{action:'block'|'unblock';version:number|null}|null>(null);
  const {mutate,busy,error,setError,lastFailureUnknown}=useModuleMutation(client);
  const generation=useRef(0),alive=useRef(true),sending=useRef(false),onChangedRef=useRef(onChanged);
  onChangedRef.current=onChanged;
  const target=userId.toLowerCase();
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  const load=useCallback(async()=>{
    const current=++generation.current;setLoading(true);setLoadError('');setState(null);setError(null);setAttempt(null);
    try{const value=BlockStateSchema.parse(await client.get<unknown>(`/me/blocks/${target}`));if(alive.current&&current===generation.current)setState(value);}
    catch(cause){if(alive.current&&current===generation.current)setLoadError(cause instanceof Error?cause.message:'設定暫時無法讀取。');}
    finally{if(alive.current&&current===generation.current)setLoading(false);}
  },[client,target,setError]);
  function close(){if(sending.current)return;setOpen(false);generation.current++;setLoading(false);onDismiss?.();if(trigger.current?.isConnected)trigger.current.focus();else if(button.current)button.current.focus();else region.current?.closest('section')?.querySelector<HTMLButtonElement>('button')?.focus();}
  function show(){trigger.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setOpen(true);setNotice('');if(!attempt)void load();}
  useEffect(()=>{if(active)show();},[active]);
  useEffect(()=>{if(open&&active!==false)region.current?.focus();},[open,active]);
  async function confirm(){
    if(!state||sending.current)return;
    sending.current=true;setNotice('');const command=attempt??{action:state.blocked_by_me?'unblock':'block',version:state.aggregate_version};setAttempt(command);
    const value=await mutate<unknown>(`/me/blocks/${target}/${command.action}`,{},command.version??undefined);
    sending.current=false;if(!alive.current)return;
    if(value!==undefined){
      setAttempt(null);setState(null);setNotice('封鎖設定已保存；請以目前讀取的狀態為準。解除封鎖不會自動恢復好友關係。');
      announceInboxChange();void onChangedRef.current();await load();
    }
  }
  return <div className="stack" style={{minWidth:0,maxWidth:'100%',overflowWrap:'anywhere'}}>
    {active===undefined&&<div className="actions"><button ref={button} type="button" className="btn btn-ghost" aria-expanded={open} aria-controls={id} onClick={()=>open?close():show()}>封鎖設定</button></div>}
    {open&&<div id={id} ref={region} tabIndex={-1} role="region" aria-label={`對 ${nickname} 的封鎖設定`} className="card stack" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
      <strong>{nickname} · 我的封鎖設定</strong>
      <p>封鎖後，雙方都不能傳送私訊或建立、接受好友邀請，現有好友關係及待回覆邀請會移除。過去訊息、已讀操作、公會與小隊成員資格和共同聊天室不受影響。</p>
      <p className="field-hint">解除封鎖不會恢復好友關係，也不會自動送出保留的訊息草稿。</p>
      {loading&&<p role="status">正在讀取最新設定…</p>}
      {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重讀設定</button></div>}
      {state&&<><p>{state.blocked_by_me?'你已封鎖這位會員。':'你尚未封鎖這位會員。'}</p><div className="actions"><button type="button" className="btn btn-ghost" disabled={busy||loading||Boolean(error&&!lastFailureUnknown)} onClick={()=>void confirm()}>{busy?'正在保存…':attempt?'重試同一筆操作':state.blocked_by_me?'確認解除封鎖':'確認封鎖'}</button></div></>}
      {error&&<div className="banner banner-error" role="alert"><p>{error}</p>{lastFailureUnknown?<p>結果尚未確認。請重試同一筆操作；原本的操作識別碼與版本會保留。</p>:<button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void load()}>重讀最新設定</button>}</div>}
      {notice&&<p className="banner status-note" role="status">{notice}</p>}
      <div className="actions"><button type="button" className="btn btn-ghost" disabled={busy} onClick={close}>關閉設定</button></div>
    </div>}
  </div>;
}

export function BlockedMembers({client}:{client:PortalClient}){
  const [offset,setOffset]=useState(0),[page,setPage]=useState<BlockList|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [blockingTarget,setBlockingTarget]=useState<string|null>(null),[blockingTargets,setBlockingTargets]=useState<string[]>([]);
  const generation=useRef(0);
  const load=useCallback(async()=>{const current=++generation.current;setLoading(true);setError('');try{const value=BlockListSchema.parse(await client.get<unknown>(`/me/blocks?limit=20&offset=${offset}`));if(current===generation.current)setPage(value);}catch(cause){if(current===generation.current)setError(cause instanceof Error?cause.message:'封鎖名單暫時無法載入。');}finally{if(current===generation.current)setLoading(false);}},[client,offset]);
  useEffect(()=>{setPage(null);void load();return()=>{generation.current++;};},[load]);
  return <section className="stack" aria-label="我的封鎖名單" aria-busy={loading}>
    <h3>我的封鎖名單</h3><p className="field-hint">只顯示你自己的設定。會員無法使用時仍可解除封鎖。</p>
    <div className="actions"><button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>void load()}>重新整理封鎖名單</button></div>
    {loading&&<p role="status">正在讀取封鎖名單…</p>}{error&&<p className="banner banner-error" role="alert">{error}</p>}
    {notice&&<p className="banner status-note" role="status">{notice}</p>}
    {page&&!page.items.length&&<p>這一頁沒有封鎖的會員。</p>}
    {page?.items.map(item=><div className="card stack" key={item.user_id} style={{minWidth:0,overflowWrap:'anywhere'}}><strong>{item.nickname??'目前無法使用的會員'}</strong><p className="field-hint">封鎖於 {new Date(item.blocked_at).toLocaleString('zh-TW')}</p><div className="actions"><button type="button" className="btn btn-ghost" onClick={()=>{setBlockingTargets(value=>value.includes(item.user_id)?value:[...value,item.user_id]);setBlockingTarget(item.user_id);}}>封鎖設定</button></div></div>)}
    {blockingTargets.map(id=><div key={id} hidden={blockingTarget!==id}><MemberBlockingAction client={client} userId={id} nickname={page?.items.find(item=>item.user_id===id)?.nickname??'目前無法使用的會員'} active={blockingTarget===id} onDismiss={()=>setBlockingTarget(null)} onChanged={()=>{setNotice('封鎖設定已保存；解除封鎖不會恢復好友關係。');return load();}}/></div>)}
    <div className="actions">{offset>0&&<button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>setOffset(value=>Math.max(0,value-20))}>上一頁封鎖名單</button>}{page?.next_offset!=null&&<button type="button" className="btn btn-ghost" disabled={loading} onClick={()=>setOffset(page.next_offset!)}>下一頁封鎖名單</button>}</div>
  </section>;
}
