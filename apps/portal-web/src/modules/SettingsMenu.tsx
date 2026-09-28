import {useEffect,useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import type {TabId} from '../types';
import {WORKSHOP_THEMES,useWorkshopTheme} from '../workshop-theme';
import './MemberSettings.css';

export const SETTINGS_PAGES=[['account','我的名片'],['todos','待辦清單']] as const satisfies readonly (readonly [TabId,string])[];

/** Personal pages and appearance settings; messages remain available from the notification bell. */
export function SettingsMenu({current,avatar,name,onSelect}:{current:TabId;avatar:ReactNode;name:string;onSelect:(id:TabId)=>void}){
  const {theme,selectTheme}=useWorkshopTheme();
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
    else if(event.key==='ArrowUp'){event.preventDefault();show(SETTINGS_PAGES.length+WORKSHOP_THEMES.length-1);}
  }
  function menuKey(event:KeyboardEvent){
    const last=SETTINGS_PAGES.length+WORKSHOP_THEMES.length-1;
    const next={ArrowDown:focusIndex===last?0:focusIndex+1,ArrowUp:focusIndex===0?last:focusIndex-1,Home:0,End:last}[event.key];
    if(next!==undefined){event.preventDefault();setFocusIndex(next);items.current[next]?.focus();}
    else if(event.key==='Escape'){event.preventDefault();close(true);}
    // Tab keeps its native behaviour; close after focus has already moved on.
    else if(event.key==='Tab')setTimeout(()=>setOpen(false));
  }
  return <div className="settings-menu" ref={root}>
    <button ref={button} type="button" className="btn btn-ghost topbar-profile settings-menu-button" aria-label="設定" title={`設定 · ${name}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open?menuId:undefined}
      onClick={()=>open?close(false):show(0)} onKeyDown={buttonKey}>
      <span aria-hidden="true">{avatar}</span><span className="settings-menu-name">{name}</span></button>
    {open&&<div id={menuId} className="settings-menu-list" role="menu" aria-label="個人檔案" onKeyDown={menuKey}>
      {SETTINGS_PAGES.map(([id,label],index)=>{
        return <button key={id} ref={node=>{items.current[index]=node;}} type="button" role="menuitem" tabIndex={index===focusIndex?0:-1}
          className={`settings-menu-item${current===id?' is-current':''}`} aria-current={current===id?'page':undefined}
          onFocus={()=>setFocusIndex(index)} onClick={()=>{setOpen(false);onSelect(id);}}>
          {label}</button>;
      })}
      <span className="settings-menu-heading" role="presentation">外觀主題</span>
      {WORKSHOP_THEMES.map(([id,label],offset)=>{const index=SETTINGS_PAGES.length+offset;return <button key={id} ref={node=>{items.current[index]=node;}} type="button" role="menuitemradio" aria-checked={theme===id} tabIndex={index===focusIndex?0:-1} className="settings-menu-item settings-theme-option" onFocus={()=>setFocusIndex(index)} onClick={()=>selectTheme(id)}><span className="settings-theme-indicator" aria-hidden="true"/>{label}</button>})}
    </div>}
  </div>;
}
