import {useCallback,useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';

/** Fired after the server confirms a read or a sent message so the menu re-reads real totals. */
export const INBOX_UPDATED='freedom-inbox-updated';
export const announceInboxChange=()=>window.dispatchEvent(new Event(INBOX_UPDATED));

/** undefined = not read yet, null = could not be confirmed; never guessed as 0. */
export type InboxUnread=number|null|undefined;

// Direct messages do not create notifications, so the two totals never double count.
export function useInboxUnread(client:PortalClient){
  const [total,setTotal]=useState<InboxUnread>(undefined);
  const generation=useRef(0);
  const refresh=useCallback(async()=>{
    const current=++generation.current;
    try{
      const [notices,direct]=await Promise.all([
        client.get<{unread_count:number}>('/me/notifications?limit=1&offset=0',{skipAuthHandler:true}),
        client.get<{unread_count:number}>('/me/conversations?limit=1&offset=0',{skipAuthHandler:true}),
      ]);
      if(current===generation.current)setTotal(notices.unread_count+direct.unread_count);
    }catch{if(current===generation.current)setTotal(null);}
  },[client]);
  useEffect(()=>{
    const update=()=>void refresh();
    update();
    window.addEventListener('focus',update);window.addEventListener(INBOX_UPDATED,update);
    return()=>{generation.current++;window.removeEventListener('focus',update);window.removeEventListener(INBOX_UPDATED,update);};
  },[refresh]);
  return {total,refresh};
}
