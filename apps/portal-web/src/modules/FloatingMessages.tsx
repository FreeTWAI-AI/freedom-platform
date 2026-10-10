import {useEffect,useRef,type ReactNode} from 'react';
import type {PortalClient} from '../api';
import {useLanguage} from '../language';
import {useInboxUnread} from './member-inbox';
// Load the shared styles before the floating overrides, even when chat code is lazy.
import './MemberSettings.css';
import './ChatWorkspace.css';
import './FloatingMessages.css';

/** One persistent inbox. Closing only hides it, so drafts and unknown sends survive. */
export function FloatingMessages({client,open,onToggle,onClose,children,preferencesEnabled=false}:{client:PortalClient;preferencesEnabled?:boolean|null;open:boolean;onToggle:()=>void;onClose:()=>void;children:ReactNode}){
  const {t}=useLanguage(),{total}=useInboxUnread(client,'messages',preferencesEnabled);
  const trigger=useRef<HTMLButtonElement>(null),heading=useRef<HTMLHeadingElement>(null);
  const label=open?t('chat.collapse'):t(total===undefined?'chat.launchLoading':total===null?'chat.launchUnknown':total>0?'chat.launchUnread':'chat.launch',{count:total??0});
  const close=()=>{onClose();trigger.current?.focus({preventScroll:true});};
  useEffect(()=>{if(open)heading.current?.focus({preventScroll:true});},[open]);
  return <>
    <section id="floating-message-panel" className="floating-message-panel" role="region" aria-labelledby="floating-message-title" hidden={!open}
      onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('dialog[open]')){event.preventDefault();event.stopPropagation();close();}}}>
      <header className="floating-message-header"><h2 id="floating-message-title" ref={heading} tabIndex={-1}>{t('nav.messages')}</h2>
        <button type="button" className="btn btn-ghost" onClick={close} aria-label={t('chat.collapse')} title={t('chat.collapse')}><span aria-hidden="true">×</span></button>
      </header>
      <div className="floating-message-content">{children}</div>
    </section>
    <button ref={trigger} className="floating-messages" type="button" onClick={onToggle} aria-label={label} title={label} aria-expanded={open} aria-controls="floating-message-panel">
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2V11.5A8.5 8.5 0 0 1 10.5 3h2A8.5 8.5 0 0 1 21 11.5Z"/><path d="M7 10h9M7 14h6"/></svg>
      <span className="floating-messages-label">{t('chat.short')}</span>
      {(total===null||typeof total==='number'&&total>0)&&<span className="floating-messages-badge" aria-hidden="true">{total===null?'?':total>99?'99+':total}</span>}
    </button>
  </>;
}
