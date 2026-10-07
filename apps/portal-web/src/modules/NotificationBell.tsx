import {useCallback,useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import type {TabId} from '../types';
import {formatIsoLocal} from '../format';
import {INBOX_UPDATED,announceInboxChange,useReadAllInbox} from './member-inbox';
import './NotificationBell.css';

export type BellAction={tab:'members'|'squads'|'guilds'|'guild-workspace'|'messages'|'events';resource_id:string|null};
type Notice={notification_id:string;title:string;body:string;created_at:string;read_at:string|null;action:BellAction|null};
type Page={items:Notice[];unread_count:number};
const tabs=new Set<TabId>(['members','squads','guilds','guild-workspace','messages','events']);
const validAction=(action:BellAction|null)=>action&&tabs.has(action.tab)&&(!action.resource_id||/^[0-9a-z_-]{1,100}$/i.test(action.resource_id))?action:null;

export function NotificationBell({client,onOpen,onNavigate}:{client:PortalClient;onOpen:()=>void;onNavigate?:(action:BellAction)=>void}){
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(''),[actionError,setActionError]=useState(''),[open,setOpen]=useState(false),[busy,setBusy]=useState<string|null>(null);
  const keys=useRef(new Map<string,string>());
  const all=useReadAllInbox(client),generation=useRef(0);
  const refresh=useCallback(async()=>{const current=++generation.current;try{const next=await client.get<Page>('/me/notifications?limit=6&offset=0',{background:true});if(current!==generation.current)return;setPage(next);setError('');}catch{if(current===generation.current){setPage(null);setError('通知暫時無法載入。');}}},[client]);
  useEffect(()=>{void refresh();const update=()=>void refresh();window.addEventListener('focus',update);window.addEventListener(INBOX_UPDATED,update);return()=>{window.removeEventListener('focus',update);window.removeEventListener(INBOX_UPDATED,update);};},[refresh]);
  async function choose(item:Notice){
    if(busy)return;setActionError('');setBusy(item.notification_id);
    if(!item.read_at){
      const key=keys.current.get(item.notification_id)??crypto.randomUUID();keys.current.set(item.notification_id,key);
      try{
        const result=await client.post<{read_at:string}>(`/me/notifications/${item.notification_id}/read`,{},{idempotencyKey:key});
        keys.current.delete(item.notification_id);
        setPage(current=>current?{...current,items:current.items.map(value=>value.notification_id===item.notification_id?{...value,read_at:result.read_at}:value),unread_count:Math.max(0,current.unread_count-1)}:current);
        announceInboxChange();void refresh();
      }catch{setActionError('這則通知暫時無法標為已讀；你仍可在對應頁面處理。');}
    }
    setBusy(null);
    const action=validAction(item.action);if(action&&onNavigate)onNavigate(action);else onOpen();
  }
  return <div className="notification-bell"><button type="button" className="btn btn-ghost notification-bell-trigger" aria-label={error?'通知，未讀數未確認':`通知${page?.unread_count?`，${page.unread_count} 則未讀`:''}`} aria-expanded={open} onClick={()=>{setOpen(value=>!value);void refresh();}}>
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg>{error?<b className="notification-bell-count">?</b>:Boolean(page?.unread_count)&&<b className="notification-bell-count">{page!.unread_count>99?'99+':page!.unread_count}</b>}
  </button>{open&&<div className="notification-bell-popover" role="region" aria-label="最近通知"><div className="notification-bell-head"><strong>通知</strong><button type="button" className="btn btn-ghost" disabled={all.busy||!!busy} onClick={()=>void all.markAll()}>{all.busy?'標記中…':'全部標為已讀'}</button></div>
    <p className="field-hint">包含私訊與已加入聊天室的未讀提醒。</p>{all.error&&<p role="alert">{all.error}</p>}
    {error&&<p role="alert">{error}</p>}{actionError&&<p role="alert">{actionError}</p>}{!error&&page?.items.length===0&&<p>目前沒有通知。</p>}
    {page?.items.map(item=><button key={item.notification_id} type="button" className={`notification-bell-item${item.read_at?'':' is-unread'}`} disabled={all.busy||busy===item.notification_id} onClick={()=>void choose(item)}><strong>{item.title}</strong><span>{item.body}</span><small>{formatIsoLocal(item.created_at)} · {item.read_at?'已讀':'未讀'}</small></button>)}
    <button type="button" className="btn btn-ghost notification-bell-all" onClick={()=>{setOpen(false);onOpen();}}>查看所有通知與訊息</button>
  </div>}</div>;
}
