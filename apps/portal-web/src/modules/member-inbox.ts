import {useCallback,useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {ApiError} from '../api';

/** Fired after the server confirms a read or a sent message so the menu re-reads real totals. */
export const INBOX_UPDATED='freedom-inbox-updated';
export const INBOX_ALL_READ='freedom-inbox-all-read';
export const NOTIFICATIONS_READ='freedom-notifications-read';
export const announceInboxChange=()=>window.dispatchEvent(new Event(INBOX_UPDATED));

export function useReadAllInbox(client:PortalClient,scope:'inbox'|'notifications'='inbox'){
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const key=useRef<string|null>(null),locked=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false}},[]);
  async function markAll(){
    if(locked.current)return;
    const session=client.sessionGeneration,valid=()=>alive.current&&session===client.sessionGeneration;
    locked.current=true;setBusy(true);setError('');key.current??=crypto.randomUUID();
    try{
      await client.post('/me/inbox/read-all',scope==='notifications'?{scope}:{},{idempotencyKey:key.current,suppressConsole:true});
      // The shell still needs the confirmed totals after this page unmounts.
      // A different login must never receive the previous session’s acknowledgement.
      if(session!==client.sessionGeneration)return;
      key.current=null;
      window.dispatchEvent(new Event(scope==='notifications'?NOTIFICATIONS_READ:INBOX_ALL_READ));announceInboxChange();
    }catch(cause){
      if(!valid())return;
      if(cause instanceof ApiError&&!cause.network&&cause.status>0&&cause.status<500)key.current=null;
      setError('尚未確認全部已讀，請再按一次重試。');
    }finally{locked.current=false;if(valid())setBusy(false)}
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
export function useInboxUnread(client:PortalClient,scope:'inbox'|'messages'='inbox',preferencesEnabled:boolean|null=false){
  const [total,setTotal]=useState<InboxUnread>(undefined);
  const generation=useRef(0);
  const refresh=useCallback(async()=>{
    const current=++generation.current,session=client.sessionGeneration;
    const valid=()=>current===generation.current&&session===client.sessionGeneration;
    if(scope==='messages'&&preferencesEnabled===null){setTotal(undefined);return;}
    try{
      if(scope==='messages'&&preferencesEnabled){
        const [direct,channels]=await Promise.all([
          client.get<{unread_count:number}>(CHAT_SOURCES[0],{skipAuthHandler:true,background:true,coalesce:true}),
          client.get<{guild:number;squad:number;world:number}>('/me/notification-preferences/channel-reminders',{skipAuthHandler:true,background:true,coalesce:true}),
        ]);
        if(!valid())return;
        const counts=[direct.unread_count,channels.guild,channels.squad,channels.world],sum=counts.reduce((value,count)=>value+count,0);
        setTotal(counts.every(count=>Number.isSafeInteger(count)&&count>=0)&&Number.isSafeInteger(sum)?sum:null);return;
      }
      const pages=await Promise.all((scope==='messages'?CHAT_SOURCES:SOURCES).map(path=>client.get<{unread_count:number}>(path,{skipAuthHandler:true,background:true,coalesce:true})));
      if(!valid())return;
      const sum=pages.reduce((value,page)=>value+page.unread_count,0);
      setTotal(pages.every(page=>Number.isSafeInteger(page.unread_count)&&page.unread_count>=0)&&Number.isSafeInteger(sum)?sum:null);
    }catch{if(valid())setTotal(null);}
  },[client,scope,preferencesEnabled]);
  useEffect(()=>{
    const update=()=>void refresh();
    update();
    // Only enabled reminder policy needs a clock refresh for quiet-hour boundaries; no history is opened.
    const timer=scope==='messages'&&preferencesEnabled===true?window.setInterval(update,30000):undefined;
    const events=['focus','online',INBOX_UPDATED,'freedom-profile-updated','freedom-notification-preferences-updated'];
    for(const name of events)window.addEventListener(name,update);
    return()=>{generation.current++;window.clearInterval(timer);for(const name of events)window.removeEventListener(name,update);};
  },[refresh,scope,preferencesEnabled]);
  return {total,refresh};
}
