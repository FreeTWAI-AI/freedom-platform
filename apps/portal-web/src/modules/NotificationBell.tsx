import {lazy,useCallback,useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import type {TabId} from '../types';
import {formatIsoLocal} from '../format';
import {useLanguage} from '../language';
import {INBOX_UPDATED,announceInboxChange,useReadAllInbox,type InboxUnread} from './member-inbox';
import {PageLoadBoundary} from '../LazyPage';
const Notifications=lazy(()=>import('./MemberMessages').then(module=>({default:module.Notifications})));
import './NotificationBell.css';

export type BellAction={tab:'members'|'squads'|'guilds'|'guild-workspace'|'messages'|'events';resource_id:string|null};
type Notice={notification_id:string;title:string;body:string;created_at:string;read_at:string|null;action:BellAction|null};
type Page={items:Notice[];unread_count:number};
const tabs=new Set<TabId>(['members','squads','guilds','guild-workspace','messages','events']);
const validAction=(action:BellAction|null)=>action&&tabs.has(action.tab)&&(!action.resource_id||/^[0-9a-z_-]{1,100}$/i.test(action.resource_id))?action:null;

export function NotificationBell({client,onNavigate}:{client:PortalClient;onNavigate?:(action:BellAction)=>void}){
  const {t}=useLanguage();
  const [page,setPage]=useState<Page|null>(null),[error,setError]=useState(false),[actionError,setActionError]=useState(false),[open,setOpen]=useState(false),[busy,setBusy]=useState<string|null>(null),[loading,setLoading]=useState(false);
  const [showAll,setShowAll]=useState(false);
  const updateUnread=useCallback((count:InboxUnread)=>{if(typeof count==='number'){setError(false);setPage(value=>({...value??{items:[]},unread_count:count}));}else if(count===null)setError(true);},[]);
  const keys=useRef(new Map<string,string>());
  const all=useReadAllInbox(client,'notifications'),generation=useRef(0),alive=useRef(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  const refresh=useCallback(async()=>{
    if(!alive.current)return;
    const current=++generation.current,session=client.sessionGeneration;
    const valid=()=>alive.current&&current===generation.current&&session===client.sessionGeneration;
    setLoading(true);setError(false);
    try{
      // Only overlapping identical reads share transport; settled results are never cached.
      const next=await client.get<Page>('/me/notifications?limit=6&offset=0',{background:true,coalesce:true});
      if(valid()){setPage(next);setError(false);}
    }catch{if(valid()){setPage(null);setError(true);}}
    finally{if(valid())setLoading(false);}
  },[client]);
  useEffect(()=>{
    alive.current=true;void refresh();const update=()=>void refresh();
    const events=['focus','online',INBOX_UPDATED];
    for(const event of events)window.addEventListener(event,update);
    return()=>{alive.current=false;generation.current++;for(const event of events)window.removeEventListener(event,update);};
  },[refresh]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{if(event.target instanceof Node&&!root.current?.contains(event.target))setOpen(false);};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setOpen(false);trigger.current?.focus();}};
    window.addEventListener('pointerdown',outside);window.addEventListener('keydown',escape);
    return()=>{window.removeEventListener('pointerdown',outside);window.removeEventListener('keydown',escape);};
  },[open]);
  async function choose(item:Notice){
    if(busy)return;
    const session=client.sessionGeneration,valid=()=>alive.current&&session===client.sessionGeneration;
    setActionError(false);setBusy(item.notification_id);
    if(!item.read_at){
      const key=keys.current.get(item.notification_id)??crypto.randomUUID();keys.current.set(item.notification_id,key);
      try{
        const result=await client.post<{read_at:string}>(`/me/notifications/${item.notification_id}/read`,{},{idempotencyKey:key});
        if(!valid())return;
        keys.current.delete(item.notification_id);
        setPage(current=>current?{...current,items:current.items.map(value=>value.notification_id===item.notification_id?{...value,read_at:result.read_at}:value),unread_count:Math.max(0,current.unread_count-1)}:current);
        // The single confirmed event refreshes this bell and the other inbox consumers.
        announceInboxChange();
      }catch{if(!valid())return;setActionError(true);}
    }
    if(!valid())return;
    setBusy(null);
    const action=validAction(item.action);if(action&&onNavigate){setOpen(false);onNavigate(action);}else setShowAll(true);
  }
  return <div ref={root} className="notification-bell"><button ref={trigger} type="button" className="btn btn-ghost notification-bell-trigger" aria-label={error?t('notice.unknown'):page?.unread_count?t('notice.count',{count:page.unread_count}):page?t('notice.title'):t('notice.pending')} aria-expanded={open} onClick={()=>{setOpen(!open);if(!open)void refresh();}}>
    <svg aria-hidden="true" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/></svg>{error?<b className="notification-bell-count">?</b>:Boolean(page?.unread_count)&&<b className="notification-bell-count">{page!.unread_count>99?'99+':page!.unread_count}</b>}
  </button>{open&&<div className="notification-bell-popover" role="region" aria-label={t('notice.recent')}><div className="notification-bell-head"><strong>{t('notice.title')}</strong><button type="button" className="btn btn-ghost" disabled={all.busy||!!busy} onClick={()=>void all.markAll()}>{all.busy?t('notice.marking'):t('notice.markAll')}</button></div>
    <p className="field-hint">{t('notice.scope')}</p>{all.error&&<p role="alert">{t('notice.allError')}</p>}
    {!showAll&&loading&&<p className="field-hint" role="status">{t('notice.loading')}</p>}
    {!showAll&&error&&<div><p role="alert">{t('notice.loadError')}</p><button type="button" className="btn btn-ghost" onClick={()=>void refresh()}>{t('feedback.retry')}</button></div>}
    {!showAll&&actionError&&<p role="alert">{t('notice.readError')}</p>}{!showAll&&!error&&!loading&&page?.items.length===0&&<p>{t('notice.empty')}</p>}
    {!showAll&&page?.items.map(item=><button key={item.notification_id} type="button" className={`notification-bell-item${item.read_at?'':' is-unread'}`} disabled={all.busy||busy===item.notification_id} onClick={()=>void choose(item)}><strong>{item.title}</strong><span>{item.body}</span><small>{formatIsoLocal(item.created_at)} · {busy===item.notification_id?t('notice.marking'):item.read_at?t('notice.read'):t('notice.unread')}</small></button>)}
    {showAll?<PageLoadBoundary label={t('notice.title')} onHome={()=>setOpen(false)}><Notifications client={client} onUnread={updateUnread} onNavigate={tab=>{setOpen(false);onNavigate?.({tab:tab as BellAction['tab'],resource_id:null});}} onOpenPeer={id=>{setOpen(false);onNavigate?.({tab:'messages',resource_id:id});}}/></PageLoadBoundary>:<button type="button" className="btn btn-ghost notification-bell-all" onClick={()=>setShowAll(true)}>{t('notice.seeAll')}</button>}
  </div>}</div>;
}
