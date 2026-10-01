import {useEffect,useRef} from 'react';
import {WORKSHOP_THEMES,useWorkshopTheme} from '../workshop-theme';
import './MemberSettings.css';

/** Profile controls remain available before the member workspace is unlocked. */
export function PreviewProfileMenu({name,onLogout,onExplore,disabled=false}:{name:string;onLogout:()=>void;onExplore?:()=>void;disabled?:boolean}){
  const {theme,selectTheme}=useWorkshopTheme();
  const details=useRef<HTMLDetailsElement>(null);
  useEffect(()=>{
    const outside=(event:PointerEvent)=>{if(details.current?.open&&!details.current.contains(event.target as Node))details.current.open=false};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'&&details.current?.open){details.current.open=false;details.current.querySelector('summary')?.focus()}};
    document.addEventListener('pointerdown',outside);document.addEventListener('keydown',escape);
    return()=>{document.removeEventListener('pointerdown',outside);document.removeEventListener('keydown',escape)};
  },[]);
  return <details ref={details} className="settings-menu preview-profile-menu">
    <summary className="btn btn-ghost settings-menu-button" aria-label={`個人檔案：${name}`}><span className="preview-profile-avatar" aria-hidden="true">{name.trim().slice(0,1)||'我'}</span><span className="settings-menu-name">{name}</span><svg className="settings-menu-chevron" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6"/></svg></summary>
    <div className="settings-menu-list" aria-label="個人檔案">
      <fieldset className="settings-theme-group"><legend>外觀主題</legend>{WORKSHOP_THEMES.map(([id,label])=><label key={id} className="settings-menu-item settings-theme-option"><input type="radio" name="preview-theme" value={id} checked={theme===id} onChange={()=>selectTheme(id)}/>{label}</label>)}</fieldset>
      {onExplore&&<button type="button" className="settings-menu-item" disabled={disabled} onClick={()=>{details.current?.removeAttribute('open');onExplore()}}>先逛逛社群</button>}
      <button type="button" className="settings-menu-item" disabled={disabled} onClick={onLogout}>登出</button>
    </div>
  </details>;
}
