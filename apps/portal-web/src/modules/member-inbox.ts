import {useCallback,useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {ApiError} from '../api';

/** Fired after the server confirms a read or a sent message so the menu re-reads real totals. */
export const INBOX_UPDATED='freedom-inbox-updated';
export const INBOX_ALL_READ='freedom-inbox-all-read';
export const announceInboxChange=()=>window.dispatchEvent(new Event(INBOX_UPDATED));

export function useReadAllInbox(client:PortalClient){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=useRef<string|null>(null),locked=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  async function markAll(){
    if(locked.current)return;
    locked.current=true;setBusy(true);setError('');key.current??=crypto.randomUUID();
    try{
      await client.post('/me/inbox/read-all',{},{idempotencyKey:key.current,suppressConsole:true});
      key.current=null;
      window.dispatchEvent(new Event(INBOX_ALL_READ));announceInboxChange();
    }catch(cause){
      if(cause instanceof ApiError&&!cause.network&&cause.status>0&&cause.status<500)key.current=null;
      if(alive.current)setError('尚未確認全部已讀，請再按一次重試。');
    }finally{locked.current=false;if(alive.current)setBusy(false)}
  }
  return {busy,error,markAll};
}

/** undefined = not read yet, null = could not be confirmed; never guessed as 0. */
export type InboxUnread=number|null|undefined;

// Four separate sources: notifications, private conversations, guild and squad chat. Messages
// do not create notifications, so they never double count. Each is a one-item list read: no
// history is opened here, and one failed source makes the whole total unconfirmed.
const SOURCES=['/me/notifications?limit=1&offset=0','/me/conversations?limit=1&offset=0','/me/channels?kind=guild&limit=1&offset=0','/me/channels?kind=squad&limit=1&offset=0'];
const CHAT_SOURCES=[...SOURCES.slice(1),'/me/channels?kind=world&limit=1&offset=0'];
export function useInboxUnread(client:PortalClient,scope:'inbox'|'messages'='inbox'){
  const [total,setTotal]=useState<InboxUnread>(undefined);
  const generation=useRef(0);
  const refresh=useCallback(async()=>{
    const current=++generation.current;
    try{
      const pages=await Promise.all((scope==='messages'?CHAT_SOURCES:SOURCES).map(path=>client.get<{unread_count:number}>(path,{skipAuthHandler:true,background:true,coalesce:true})));
      if(current!==generation.current)return;
      const sum=pages.reduce((value,page)=>value+page.unread_count,0);
      setTotal(pages.every(page=>Number.isSafeInteger(page.unread_count)&&page.unread_count>=0)&&Number.isSafeInteger(sum)?sum:null);
    }catch{if(current===generation.current)setTotal(null);}
  },[client,scope]);
  useEffect(()=>{
    const update=()=>void refresh();
    update();
    // No polling: the window regaining focus, a confirmed write or a membership change re-reads.
    const events=['focus','online',INBOX_UPDATED,'freedom-profile-updated'];
    for(const name of events)window.addEventListener(name,update);
    return()=>{generation.current++;for(const name of events)window.removeEventListener(name,update);};
  },[refresh]);
  return {total,refresh};
}
