import {useEffect,useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import type {TabId} from '../types';
import type {PortalClient} from '../api';
import {useInboxUnread} from './member-inbox';
import './MemberSettings.css';

export const SETTINGS_PAGES=[['account','我的名片'],['todos','待辦清單'],['messages','我的訊息']] as const satisfies readonly (readonly [TabId,string])[];

/** Personal pages and messages stay reachable from the header as well as navigation. */
export function SettingsMenu({client,current,avatar,name,onSelect}:{client:PortalClient;current:TabId;avatar:ReactNode;name:string;onSelect:(id:TabId)=>void}){
  const {total}=useInboxUnread(client);
  const unread=total===null?'未讀數未確認':total===undefined?'':total>0?`${total} 則未讀`:'';
  const [open,setOpen]=useState(false),[focusIndex,setFocusIndex]=useState(0);
  const root=useRef<HTMLDivElement>(null),button=useRef<HTMLButtonElement>(null),items=useRef<(HTMLButtonElement|null)[]>([]);
  const menuId=useId();
  useEffect(()=>{if(open)items.current[focusIndex]?.focus();},[open,focusIndex]);
  // A route change (including browser Back) closes the menu; App already moves focus to main.
  useEffect(()=>setOpen(false),[current]);
  useEffect(()=>{
    if(!open)return;
    const outside=(event:PointerEvent)=>{
      if(root.current?.contains(event.target as Node))return;
      setOpen(false);
      // A click on another control keeps its focus; a blank area must not strand focus on <body>.
      setTimeout(()=>{if(!document.activeElement||document.activeElement===document.body)button.current?.focus();});
    };
    document.addEventListener('pointerdown',outside);
    return()=>document.removeEventListener('pointerdown',outside);
  },[open]);
  function show(index:number){setFocusIndex(index);setOpen(true);}
  function close(returnFocus:boolean){setOpen(false);if(returnFocus)button.current?.focus();}
  function buttonKey(event:KeyboardEvent){
    if(event.key==='ArrowDown'){event.preventDefault();show(0);}
    else if(event.key==='ArrowUp'){event.preventDefault();show(SETTINGS_PAGES.length-1);}
  }
  function menuKey(event:KeyboardEvent){
    const last=SETTINGS_PAGES.length-1;
    const next={ArrowDown:focusIndex===last?0:focusIndex+1,ArrowUp:focusIndex===0?last:focusIndex-1,Home:0,End:last}[event.key];
    if(next!==undefined){event.preventDefault();setFocusIndex(next);items.current[next]?.focus();}
    else if(event.key==='Escape'){event.preventDefault();close(true);}
    // Tab keeps its native behaviour; close after focus has already moved on.
    else if(event.key==='Tab')setTimeout(()=>setOpen(false));
  }
  return <div className="settings-menu" ref={root}>
    <button ref={button} type="button" className="btn btn-ghost topbar-profile settings-menu-button" aria-label="設定" aria-description={unread?`我的訊息${unread}`:undefined} title={`設定 · ${name}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open?menuId:undefined}
      onClick={()=>open?close(false):show(0)} onKeyDown={buttonKey}>
      <span aria-hidden="true">{avatar}</span><span className="settings-menu-name">{name}</span>{typeof total==='number'&&total>0&&<span className="settings-dot" aria-hidden="true"/>}</button>
    {open&&<div id={menuId} className="settings-menu-list" role="menu" aria-label="個人檔案" onKeyDown={menuKey}>
      {SETTINGS_PAGES.map(([id,label],index)=>{
        return <button key={id} ref={node=>{items.current[index]=node;}} type="button" role="menuitem" tabIndex={index===focusIndex?0:-1}
          className={`settings-menu-item${current===id?' is-current':''}`} aria-current={current===id?'page':undefined}
          onFocus={()=>setFocusIndex(index)} onClick={()=>{setOpen(false);onSelect(id);}}>
          {label}{id==='messages'&&unread&&<span className={`settings-menu-badge${total===null?' is-unknown':''}`} aria-hidden="true">{unread}</span>}</button>;
      })}
    </div>}
  </div>;
}
