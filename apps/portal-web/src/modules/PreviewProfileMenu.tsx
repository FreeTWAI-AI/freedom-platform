import type {PortalClient} from '../api';
import {AccountDeactivation} from './AccountDeactivation';
import {useEffect,useRef,useState} from 'react';
import {WORKSHOP_THEMES,useWorkshopTheme} from '../workshop-theme';
import './MemberSettings.css';
import {LanguagePicker,useLanguage} from '../language';

/** Profile controls remain available before the member workspace is unlocked. */
export function PreviewProfileMenu({client,name,onLogout,onExplore,disabled=false}:{client:PortalClient;name:string;onLogout:()=>void;onExplore?:()=>void;disabled?:boolean}){
  const [deactivationOpen,setDeactivationOpen]=useState(false);
  const {theme,selectTheme}=useWorkshopTheme();
  const {language,t}=useLanguage();
  const details=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(details.current?.open&&!details.current.contains(event.target as Node))details.current.open=false};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&details.current?.open){details.current.open=false;details.current.querySelector('summary')?.focus()}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)};
  },[]);
  return <details ref={details} className="settings-menu preview-profile-menu" lang={language}>
    <summary className="btn btn-ghost settings-menu-button" aria-label={`${t('settings.profile')}：${name}`}><span className="preview-profile-avatar" aria-hidden="true">{name.trim().slice(0,1)||'我'}</span><span className="settings-menu-name">{name}</span><svg className="settings-menu-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></summary>
    <div className="settings-menu-list" aria-label={t('settings.profile')}>
      <LanguagePicker/>
      <fieldset className="settings-theme-group"><legend>{t('settings.appearance')}</legend>{WORKSHOP_THEMES.map(([id,label])=><label key={id} className="settings-menu-item settings-theme-option" lang="zh-Hant"><input type="radio" name="preview-theme" value={id} checked={theme===id} onChange={()=>selectTheme(id)}/>{label}</label>)}</fieldset>
      {onExplore&&<button type="button" className="settings-menu-item" disabled={disabled} onClick={()=>{details.current?.removeAttribute('open');onExplore()}}>{t('settings.explore')}</button>}
      <button type="button" className="settings-menu-item" disabled={disabled} aria-expanded={deactivationOpen} onClick={()=>setDeactivationOpen(open=>!open)}>停用帳號</button>
      {deactivationOpen&&<AccountDeactivation client={client} disabled={disabled}/>}
      <button type="button" className="settings-menu-item" disabled={disabled} onClick={onLogout}>{t('settings.logout')}</button>
    </div>
  </details>;
}
