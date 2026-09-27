import {useCallback,useEffect,useState} from 'react';
import type {PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import {INBOX_UPDATED,announceInboxChange} from './member-inbox';
import './NotificationBell.css';

type Notice={notification_id:string;title:string;body:string;created_at:string;read_at:string|null};
type Page={items:Notice[];unread_count:number};

export function NotificationBell({client,onOpen}:{client:PortalClient;onOpen:()=>void}){
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(''),[open,setOpen]=useState(false);
  const refresh=useCallback(async()=>{try{setPage(await client.get<Page>('/me/notifications?limit=6&offset=0',{background:true}));setError('');}catch{setPage(null);setError('通知暫時無法載入。');}},[client]);
  useEffect(()=>{void refresh();const update=()=>void refresh();window.addEventListener('focus',update);window.addEventListener(INBOX_UPDATED,update);return()=>{window.removeEventListener('focus',update);window.removeEventListener(INBOX_UPDATED,update);};},[refresh]);
  return <div className="notification-bell"><button type="button" className="btn btn-ghost notification-bell-trigger" aria-label={error?'通知，未讀數未確認':`通知${page?.unread_count?`，${page.unread_count} 則未讀`:''}`} aria-expanded={open} onClick={()=>{setOpen(value=>!value);void refresh();}}>
    <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg><span>通知</span>{error?<b className="notification-bell-count">?</b>:Boolean(page?.unread_count)&&<b className="notification-bell-count">{page!.unread_count>99?'99+':page!.unread_count}</b>}
  </button>{open&&<div className="notification-bell-popover" role="region" aria-label="最近通知"><div className="notification-bell-head"><strong>通知</strong><button type="button" className="btn btn-ghost" onClick={()=>void refresh()}>更新</button></div>
    {error&&<p role="alert">{error}</p>}{!error&&page?.items.length===0&&<p>目前沒有通知。</p>}
    {page?.items.map(item=><article key={item.notification_id} className={item.read_at?'':'is-unread'}><strong>{item.title}</strong><p>{item.body}</p><small>{formatIsoLocal(item.created_at)}</small>{!item.read_at&&<button type="button" className="btn btn-ghost" onClick={async()=>{try{await client.post(`/me/notifications/${item.notification_id}/read`,{},{idempotencyKey:crypto.randomUUID()});announceInboxChange();await refresh();}catch{setError('標記已讀失敗，請稍後重試。');}}}>標記已讀</button>}</article>)}
    <button type="button" className="btn btn-ghost notification-bell-all" onClick={()=>{setOpen(false);onOpen();}}>查看所有通知與訊息</button>
  </div>}</div>;
}
