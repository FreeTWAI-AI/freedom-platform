import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';
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
  const [sizeOpen,setSizeOpen]=useState(false),[width,setWidth]=useState(560),[height,setHeight]=useState(540);
  const [mobileHeight,setMobileHeight]=useState<number|null>(null);
  const label=open?t('chat.collapse'):t(total===undefined?'chat.launchLoading':total===null?'chat.launchUnknown':total>0?'chat.launchUnread':'chat.launch',{count:total??0});
  const close=()=>{onClose();trigger.current?.focus({preventScroll:true});};
  useEffect(()=>{if(open)heading.current?.focus({preventScroll:true});},[open]);
  return <>
    <section id="floating-message-panel" className="floating-message-panel" role="region" aria-labelledby="floating-message-title" hidden={!open}
      style={{'--chat-panel-width':`${width}px`,'--chat-panel-height':`${height}px`,...(mobileHeight===null?{}:{'--chat-mobile-height':`${mobileHeight}px`})} as CSSProperties}
      onKeyDown={event=>{if(event.key==='Escape'&&!event.defaultPrevented&&!document.querySelector('dialog[open]')){event.preventDefault();event.stopPropagation();close();}}}>
      <header className="floating-message-header"><h2 id="floating-message-title" ref={heading} tabIndex={-1}>{t('nav.messages')}</h2>
        <button type="button" className="btn btn-ghost floating-message-size-toggle" aria-expanded={sizeOpen} aria-controls="floating-message-size" onClick={()=>setSizeOpen(value=>!value)}>{t('chat.size')}</button>
        <button type="button" className="btn btn-ghost" onClick={close} aria-label={t('chat.collapse')} title={t('chat.collapse')}><span aria-hidden="true">×</span></button>
      </header>
      <div id="floating-message-size" className="floating-message-size" hidden={!sizeOpen}>
        <label className="floating-message-width">{t('chat.width')} <input type="range" min={440} max={1000} step={20} value={width} onChange={event=>setWidth(Number(event.target.value))}/></label>
        <label>{t('chat.height')} <input type="range" min={360} max={800} step={20} value={height} onChange={event=>{const value=Number(event.target.value);setHeight(value);setMobileHeight(value);}}/></label>
        <button type="button" className="btn btn-ghost" onClick={()=>{setWidth(560);setHeight(540);setMobileHeight(null);}}>{t('chat.sizeReset')}</button>
      </div>
      <div className="floating-message-content">{children}</div>
    </section>
    <button ref={trigger} className="floating-messages" type="button" onClick={onToggle} aria-label={label} title={label} aria-expanded={open} aria-controls="floating-message-panel">
      <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2V11.5A8.5 8.5 0 0 1 10.5 3h2A8.5 8.5 0 0 1 21 11.5Z"/><path d="M7 10h9M7 14h6"/></svg>
      <span className="floating-messages-label">{t('chat.short')}</span>
      {(total===null||typeof total==='number'&&total>0)&&<span className="floating-messages-badge" aria-hidden="true">{total===null?'?':total>99?'99+':total}</span>}
    </button>
  </>;
}
