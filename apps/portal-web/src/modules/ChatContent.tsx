import {useEffect,useId,useRef,useState} from 'react';
import type {MessageContent,MessageContentInput,MessageReply} from '../../../../modules/member-communications/content-types';
import {CHAT_STICKERS,CHAT_STICKER_ATLAS,findChatSticker} from '../../../../modules/member-communications/stickers';
import './ChatContent.css';

export type RichChatDraft={sticker_id?:string;reply?:MessageReply};
const EMPTY:RichChatDraft={};
/** Conversation drafts live only in this mounted chat, never in browser storage. */
export function useRichChatDraft(){
  const [drafts,setDrafts]=useState<Record<string,RichChatDraft>>({});
  return {
    get:(key:string)=>drafts[key]??EMPTY,
    change:(key:string,value:Partial<RichChatDraft>)=>setDrafts(current=>({...current,[key]:{...current[key],...value}})),
    clear:(key:string,expected?:RichChatDraft)=>setDrafts(current=>{if(expected&&(current[key]??EMPTY)!==expected)return current;const {[key]:_,...rest}=current;return rest;}),
  };
}
export function chatPayload(body:string,draft:RichChatDraft):MessageContentInput{
  return {...(draft.sticker_id?{sticker_id:draft.sticker_id}:{body:body.trim()}),...(draft.reply?{reply_to_message_id:draft.reply.message_id}:{})};
}
export const sameChatPayload=(a:MessageContentInput,b:MessageContentInput)=>a.body===b.body&&a.sticker_id===b.sticker_id&&a.reply_to_message_id===b.reply_to_message_id;
export function quoteMessage(message:{message_id:string;sender_ref:string;body:string}&MessageContent,sender_name:string):MessageReply{
  return {message_id:message.message_id,sender_ref:message.sender_ref,sender_name,body:[...message.body].slice(0,160).join(''),...(message.sticker?{sticker:message.sticker}:{})};
}
export function ChatSticker({id,thumbnail=false}:{id:string;thumbnail?:boolean}){
  const sticker=findChatSticker(id),[broken,setBroken]=useState(false);
  useEffect(()=>setBroken(false),[id,thumbnail]);
  if(!sticker)return null;
  if(broken)return <span className="messages-body">[貼圖] {sticker.label}</span>;
  return <span className="chat-sticker" role="img" aria-label={`貼圖：${sticker.label}`} data-sticker-id={id}>
    {'image' in sticker?<img className="chat-sticker-image" src={thumbnail?sticker.thumbnail:sticker.image} width={thumbnail?144:512} height={thumbnail?144:512} loading="lazy" alt="" decoding="async" draggable={false} onError={()=>setBroken(true)}/>:<img src={CHAT_STICKER_ATLAS} alt="" decoding="async" draggable={false} onError={()=>setBroken(true)} style={{left:`-${sticker.column*100}%`,top:`-${sticker.row*100}%`}}/>}
  </span>;
}
export function ChatBody({message}:{message:{body:string}&MessageContent}){
  return message.sticker?<ChatSticker id={message.sticker.id}/>:<p className="messages-body">{message.body}</p>;
}
export function ChatQuote({reply}:{reply:MessageReply}){
  return <blockquote className="chat-quote" aria-label="回覆的訊息" data-reply-to={reply.message_id}>
    <strong>{reply.sender_name}</strong><span>{reply.sticker?`[貼圖] ${reply.sticker.label}`:reply.body}</span>
  </blockquote>;
}
export function ChatExtras({draft,onChange,disabled,target}:{draft:RichChatDraft;onChange:(value:Partial<RichChatDraft>)=>void;disabled:boolean;target:string}){
  const [open,setOpen]=useState(false),[search,setSearch]=useState(''),[pack,setPack]=useState('freetwai-v2');
  const id=useId(),toggle=useRef<HTMLButtonElement>(null),input=useRef<HTMLInputElement>(null);
  useEffect(()=>{setOpen(false);setSearch('');},[target]);
  useEffect(()=>{if(open)input.current?.focus();},[open]);
  const close=()=>{setOpen(false);toggle.current?.focus();};
  const matches=CHAT_STICKERS.filter(item=>item.pack===pack&&`${item.label} ${item.keywords}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <div className="chat-extras">
    {draft.reply&&<div className="chat-reply-draft"><ChatQuote reply={draft.reply}/><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>onChange({reply:undefined})}>取消回覆</button></div>}
    {draft.sticker_id&&<div className="chat-sticker-preview" aria-label="待送出的貼圖"><ChatSticker id={draft.sticker_id}/><span>{findChatSticker(draft.sticker_id)?.label}</span><button className="btn btn-ghost" type="button" disabled={disabled} onClick={()=>onChange({sticker_id:undefined})}>改寫文字</button></div>}
    <button className="btn btn-ghost" ref={toggle} type="button" aria-label="選擇貼圖" title="選擇貼圖" disabled={disabled} aria-expanded={open} aria-controls={id} onClick={()=>open?close():setOpen(true)}><svg className="chat-sticker-trigger" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="12" cy="12" r="9"/><path d="M8 14.5q4 4 8 0"/><path d="M8.5 9h.01M15.5 9h.01" strokeWidth="3"/></svg><span>選擇貼圖</span></button>
    {open&&<section className="chat-sticker-picker" id={id} aria-label="工坊貼圖" onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}}}>
      <div className="chat-picker-heading"><strong>自由工坊貼圖</strong><button className="btn btn-ghost" type="button" onClick={close}>關閉貼圖</button></div>
      <div className="chat-sticker-packs" role="group" aria-label="貼圖包">{[['freetwai-v2','自由工坊'],['workshop-v1','工坊夥伴']].map(([key,label])=><button className="btn btn-ghost" key={key} type="button" aria-pressed={pack===key} onClick={()=>{setPack(key);setSearch('')}}>{label}</button>)}</div>
      <label className="field">搜尋貼圖<input ref={input} type="search" value={search} maxLength={80} onKeyDown={event=>{if(event.key==='Enter')event.preventDefault();}} onChange={event=>setSearch(event.target.value)} placeholder="例如：加油、合作"/></label>
      <div className="chat-sticker-grid">{matches.map(item=><button key={item.id} className="chat-sticker-choice" type="button" disabled={disabled} aria-label={`選用貼圖：${item.label}`} aria-pressed={draft.sticker_id===item.id} onClick={()=>{onChange({sticker_id:item.id});close();}}><ChatSticker id={item.id} thumbnail/><span>{item.label}</span></button>)}</div>
      {matches.length===0&&<p role="status">沒有符合的貼圖，請換個關鍵字。</p>}
    </section>}
  </div>;
}
