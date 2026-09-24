import {useCallback,useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';

/** Fired after the server confirms a read or a sent message so the menu re-reads real totals. */
export const INBOX_UPDATED='freedom-inbox-updated';
export const announceInboxChange=()=>window.dispatchEvent(new Event(INBOX_UPDATED));

/** undefined = not read yet, null = could not be confirmed; never guessed as 0. */
export type InboxUnread=number|null|undefined;

// Four separate sources: notifications, private conversations, guild and squad chat. Messages
// do not create notifications, so they never double count. Each is a one-item list read: no
// history is opened here, and one failed source makes the whole total unconfirmed.
const SOURCES=['/me/notifications?limit=1&offset=0','/me/conversations?limit=1&offset=0','/me/channels?kind=guild&limit=1&offset=0','/me/channels?kind=squad&limit=1&offset=0'];
export function useInboxUnread(client:PortalClient){
  const [total,setTotal]=useState<InboxUnread>(undefined);
  const generation=useRef(0);
  const refresh=useCallback(async()=>{
    const current=++generation.current;
    try{
      const pages=await Promise.all(SOURCES.map(path=>client.get<{unread_count:number}>(path,{skipAuthHandler:true})));
      if(current!==generation.current)return;
      setTotal(pages.every(page=>Number.isSafeInteger(page.unread_count)&&page.unread_count>=0)?pages.reduce((sum,page)=>sum+page.unread_count,0):null);
    }catch{if(current===generation.current)setTotal(null);}
  },[client]);
  useEffect(()=>{
    const update=()=>void refresh();
    update();
    // No polling: the window regaining focus, a confirmed write or a membership change re-reads.
    const events=['focus',INBOX_UPDATED,'freedom-profile-updated'];
    for(const name of events)window.addEventListener(name,update);
    return()=>{generation.current++;for(const name of events)window.removeEventListener(name,update);};
  },[refresh]);
  return {total,refresh};
}
