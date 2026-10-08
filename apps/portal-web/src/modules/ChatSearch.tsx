import {useEffect,useId,useRef,useState,type FormEvent} from 'react';
import {ApiError,type PortalClient} from '../api';
import type {MessageContent} from '../../../../modules/member-communications/content-types';
import type {MessageSearchPage} from '../../../../modules/member-communications/message-search';
import {ChatBody,ChatQuote} from './ChatContent';
import {ChatTime} from './ChatWorkspace';

type Hit={message_id:string;sender_ref:string;sender_name?:string;body:string;created_at:string}&MessageContent;
type Results={query:string;items:Hit[];next_cursor:string|null};
type Phase='idle'|'loading'|'ready'|'error';

function SearchHit({item,query,me,otherName}:{item:Hit;query:string;me:string;otherName:string}){
  const [expanded,setExpanded]=useState(false),match=item.body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  let start=expanded?0:Math.max(0,match-70),end=expanded?item.body.length:Math.min(item.body.length,Math.max(match+query.length+120,200));
  // Keep UTF-16 pairs intact when an excerpt begins or ends inside an emoji.
  if(start>0&&/[\uDC00-\uDFFF]/.test(item.body[start]))start--;
  if(end<item.body.length&&/[\uDC00-\uDFFF]/.test(item.body[end]))end++;
  const clipped=start>0||end<item.body.length,body=item.body.slice(start,end),index=body.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  return <li data-search-message-id={item.message_id}>
    <p className="messages-meta"><strong>{item.sender_ref===me?'你':item.sender_name??otherName}</strong> · <ChatTime value={item.created_at}/></p>
    {item.reply_to&&<ChatQuote reply={item.reply_to}/>}
    {item.sticker?<ChatBody message={item}/>:<p className="messages-body">{start>0?'…':''}{index<0?body:<>{body.slice(0,index)}<mark>{body.slice(index,index+query.length)}</mark>{body.slice(index+query.length)}</>}{end<item.body.length?'…':''}</p>}
    {(clipped||expanded)&&<button className="btn btn-ghost" type="button" aria-expanded={expanded} onClick={()=>setExpanded(value=>!value)}>{expanded?'收合訊息':'展開完整訊息'}</button>}
  </li>;
}

/** Query/results stay in this dialog only; closing or hiding it cancels late reads. */
export function ChatSearch({client,resource,title,me,otherName=title,active,onOpenChange}:{
  client:PortalClient;resource:string;title:string;me:string;otherName?:string;active:boolean;onOpenChange:(open:boolean)=>void;
}){
  const id=useId(),dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null);
  const [open,setOpen]=useState(false),[query,setQuery]=useState(''),[phase,setPhase]=useState<Phase>('idle'),[result,setResult]=useState<Results|null>(null);
  const [more,setMore]=useState(false),[error,setError]=useState('');
  const generation=useRef(0),request=useRef<AbortController|null>(null),retry=useRef<{query:string;cursor?:string}|null>(null);
  function invalidate(){generation.current++;request.current?.abort();request.current=null;}
  function close(restore=true){
    invalidate();dialog.current?.close();setOpen(false);onOpenChange(false);setQuery('');setResult(null);setPhase('idle');setMore(false);setError('');retry.current=null;
    if(restore&&active&&trigger.current?.offsetParent!==null)trigger.current?.focus({preventScroll:true});
  }
  useEffect(()=>{if(open&&!dialog.current?.open){dialog.current?.showModal();input.current?.focus();}},[open]);
  useEffect(()=>{if(!active)close(false);},[active]);
  useEffect(()=>()=>{invalidate();onOpenChange(false);},[]);
  async function search(text:string,cursor?:string){
    const value=text.trim();if(!value)return;
    invalidate();const current=generation.current,controller=new AbortController();request.current=controller;retry.current={query:value,cursor};
    setError('');setMore(Boolean(cursor));if(!cursor){setResult(null);setPhase('loading');}
    try{
      const params=new URLSearchParams({q:value,limit:'20',...(cursor?{cursor}:{})});
      const page=await client.get<MessageSearchPage<Hit>>(`${resource}/search?${params}`,{signal:controller.signal});
      if(current!==generation.current)return;
      setResult(previous=>{const items=cursor&&previous?.query===value?previous.items:[],seen=new Set(items.map(item=>item.message_id));return {query:value,items:[...items,...page.items.filter(item=>!seen.has(item.message_id))],next_cursor:page.next_cursor};});
      setPhase('ready');retry.current=null;
    }catch(cause){if(current===generation.current){
      const refused=cause instanceof ApiError&&[401,403,404].includes(cause.status);
      if(refused){setResult(null);retry.current={query:value};}
      setError(cause instanceof Error?cause.message:'搜尋暫時無法使用。');if(!cursor||refused)setPhase('error');
    }}
    finally{if(current===generation.current){setMore(false);request.current=null;}}
  }
  function submit(event:FormEvent){event.preventDefault();void search(query);}
  return <>
    <button ref={trigger} className="btn btn-ghost chat-search-trigger" type="button" title="搜尋訊息" aria-label="搜尋訊息" aria-haspopup="dialog" aria-expanded={open} onClick={()=>{onOpenChange(true);setOpen(true);}}>
      <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>
    </button>
    <dialog ref={dialog} className="chat-search-dialog" aria-labelledby={`${id}-title`} onCancel={event=>{event.preventDefault();close();}}>
      <header><h2 id={`${id}-title`}>搜尋訊息</h2><button className="btn btn-ghost" type="button" aria-label="關閉搜尋" onClick={()=>close()}>關閉</button></header>
      <p className="chat-search-scope">{title}</p>
      <form onSubmit={submit} className="chat-search-form">
        <label className="field"><span className="chat-sr-only">搜尋這個對話的訊息</span><input ref={input} type="search" value={query} maxLength={100} placeholder="輸入關鍵字" onChange={event=>{invalidate();setQuery(event.target.value);setResult(null);setError('');setPhase('idle');setMore(false);retry.current=null;}}/></label>
        <button className="btn btn-primary" type="submit" disabled={!query.trim()||phase==='loading'||more}>{phase==='loading'?'搜尋中…':'搜尋'}</button>
      </form>
      {phase==='idle'&&<p className="muted">找回這個對話裡的文字訊息。</p>}
      {phase==='loading'&&<p role="status">正在搜尋「{query.trim()}」…</p>}
      {error&&<div className="banner banner-error" role="alert">搜尋未完成：{error}<button className="btn btn-ghost" type="button" onClick={()=>{const value=retry.current;if(value)void search(value.query,value.cursor);}}>重試搜尋</button></div>}
      {result&&<div className="chat-search-results">
        <p role="status">{result.items.length===0?'找不到符合的訊息。':`已載入 ${result.items.length} 則訊息`}</p>
        <ol aria-label="訊息搜尋結果">{result.items.map(item=><SearchHit key={item.message_id} item={item} query={result.query} me={me} otherName={otherName}/>)}</ol>
        {result.next_cursor&&<button className="btn btn-ghost" type="button" disabled={more} onClick={()=>void search(result.query,result.next_cursor!)}>{more?'正在讀取…':'更多搜尋結果'}</button>}
      </div>}
    </dialog>
  </>;
}
