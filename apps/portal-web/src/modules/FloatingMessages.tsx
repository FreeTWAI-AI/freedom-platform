import type {PortalClient} from '../api';
import {useLanguage} from '../language';
import {useInboxUnread} from './member-inbox';
import './FloatingMessages.css';

/** A shortcut into the same inbox, with no hidden chat, read receipts or polling. */
export function FloatingMessages({client,onOpen}:{client:PortalClient;onOpen:()=>void}){
  const {t}=useLanguage(),{total}=useInboxUnread(client,'messages');
  const label=t(total===undefined?'chat.launchLoading':total===null?'chat.launchUnknown':total>0?'chat.launchUnread':'chat.launch',{count:total??0});
  return <button className="floating-messages" type="button" onClick={onOpen} aria-label={label} title={label}>
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H5l-3 2V11.5A8.5 8.5 0 0 1 10.5 3h2A8.5 8.5 0 0 1 21 11.5Z"/><path d="M7 10h9M7 14h6"/></svg>
    <span className="floating-messages-label">{t('chat.short')}</span>
    {(total===null||typeof total==='number'&&total>0)&&<span className="floating-messages-badge" aria-hidden="true">{total===null?'?':total>99?'99+':total}</span>}
  </button>;
}
