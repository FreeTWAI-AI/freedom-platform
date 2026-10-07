import {useEffect,useId,useRef,useState,type KeyboardEvent,type ReactNode} from 'react';
import type {TabId} from '../types';
import {WORKSHOP_THEMES,useWorkshopTheme} from '../workshop-theme';
import './MemberSettings.css';
import {LANGUAGES,useLanguage} from '../language';

export const SETTINGS_PAGES=[['account','我的名片'],['todos','待辦清單']] as const satisfies readonly (readonly [TabId,string])[];
const LANGUAGE_COUNT=LANGUAGES.length+1;
const LOGOUT_INDEX=SETTINGS_PAGES.length+LANGUAGE_COUNT+WORKSHOP_THEMES.length;

/** The account menu: personal pages, appearance and sign-out. Messages stay with the notification bell. */
export function SettingsMenu({current,avatar,name,onSelect,onLogout,logoutDisabled=false}:{current:TabId;avatar:ReactNode;name:string;onSelect:(id:TabId)=>void;onLogout:()=>void;logoutDisabled?:boolean}){
  const {theme,selectTheme}=useWorkshopTheme();
  const {preference,selectLanguage,t}=useLanguage();
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
    else if(event.key==='ArrowUp'){event.preventDefault();show(LOGOUT_INDEX);}
  }
  function menuKey(event:KeyboardEvent){
    const last=LOGOUT_INDEX;
    const next={ArrowDown:focusIndex===last?0:focusIndex+1,ArrowUp:focusIndex===0?last:focusIndex-1,Home:0,End:last}[event.key];
    if(next!==undefined){event.preventDefault();setFocusIndex(next);items.current[next]?.focus();}
    else if(event.key==='Escape'){event.preventDefault();close(true);}
    // Tab keeps its native behaviour; close after focus has already moved on.
    else if(event.key==='Tab')setTimeout(()=>setOpen(false));
  }
  return <div className="settings-menu" ref={root}>
    <button ref={button} type="button" className="btn btn-ghost topbar-profile settings-menu-button" aria-label={t('settings.title')} title={`${t('settings.title')} · ${name}`} aria-haspopup="menu" aria-expanded={open} aria-controls={open?menuId:undefined}
      onClick={()=>open?close(false):show(0)} onKeyDown={buttonKey}>
      <span aria-hidden="true">{avatar}</span><span className="settings-menu-name">{name}</span>
      <svg className="settings-menu-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
    {open&&<div id={menuId} className="settings-menu-list" role="menu" aria-label={t('settings.profile')} onKeyDown={menuKey}>
      {/* The trigger drops the name on narrow screens; the menu still says whose account this is. */}
      <span className="settings-menu-identity" role="presentation">{name}</span>
      {SETTINGS_PAGES.map(([id,label],index)=>{
        return <button key={id} ref={node=>{items.current[index]=node;}} type="button" role="menuitem" tabIndex={index===focusIndex?0:-1}
          className={`settings-menu-item${current===id?' is-current':''}`} aria-current={current===id?'page':undefined}
          onFocus={()=>setFocusIndex(index)} onClick={()=>{setOpen(false);onSelect(id);}}>
          {t(`nav.${id}`)}</button>;
      })}
      <span className="settings-menu-heading" role="presentation">{t('settings.language')}</span>
      {(['auto',...LANGUAGES.map(([id])=>id)] as const).map((id,offset)=>{const index=SETTINGS_PAGES.length+offset,label=id==='auto'?t('language.auto'):LANGUAGES.find(([key])=>key===id)![1];return <button key={id} ref={node=>{items.current[index]=node;}} type="button" role="menuitemradio" aria-checked={preference===id} tabIndex={index===focusIndex?0:-1} className="settings-menu-item" onFocus={()=>setFocusIndex(index)} onClick={()=>selectLanguage(id)} lang={id==='auto'?undefined:id}>{label}</button>;})}
      <span className="settings-menu-heading" role="presentation">{t('settings.appearance')}</span>
      {WORKSHOP_THEMES.map(([id,label],offset)=>{const index=SETTINGS_PAGES.length+LANGUAGE_COUNT+offset;return <button key={id} ref={node=>{items.current[index]=node;}} type="button" role="menuitemradio" aria-checked={theme===id} tabIndex={index===focusIndex?0:-1} className="settings-menu-item settings-theme-option" onFocus={()=>setFocusIndex(index)} onClick={()=>selectTheme(id)}><span className="settings-theme-indicator" aria-hidden="true"/>{label}</button>})}
      <span className="settings-menu-separator" role="separator"/>
      <button ref={node=>{items.current[LOGOUT_INDEX]=node;}} type="button" role="menuitem" tabIndex={LOGOUT_INDEX===focusIndex?0:-1}
        className="settings-menu-item settings-menu-logout" aria-disabled={logoutDisabled||undefined}
        onFocus={()=>setFocusIndex(LOGOUT_INDEX)} onClick={()=>{if(logoutDisabled)return;close(true);onLogout();}}>
        <svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3M16 17l5-5-5-5M21 12H9"/></svg>{t('settings.logout')}</button>
    </div>}
  </div>;
}
