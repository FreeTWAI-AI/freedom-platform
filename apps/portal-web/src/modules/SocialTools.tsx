import {useEffect,useId,useRef,useState,type ReactNode} from 'react';
import type {PortalClient} from '../api';
import {MemberAvatar} from './MemberAvatar';

export type Mention={user_id:string;display_name:string};
export const SOCIAL_TOPICS={mood:'近況心情',event:'社群活動',work:'作品分享'} as const;
export function SocialIcon({name}:{name:'camera'|'smile'|'like'|'comment'|'share'|'send'|'pin'|'eye'}){
 const paths:Record<string,ReactNode>={
 camera:<><path d="M4 7h4l2-3h4l2 3h4v13H4z"/><circle cx="12" cy="13" r="3.5"/></>,
 smile:<><circle cx="12" cy="12" r="9"/><path d="M8 14q4 5 8 0M8 9h1m6 0h1"/></>,
 like:<path d="M7 10v11H3V10zm0 0 5-7c3 0 2 4 1 7h6c2 0 2 2 1 5l-2 6H7"/>,
 comment:<path d="M21 11a9 9 0 0 1-9 9H8l-5 2 1-6a9 9 0 1 1 17-5ZM8 9h8m-8 4h5"/>,
 share:<path d="m14 3 7 7-7 7v-5C6 12 4 16 3 20 2 11 6 7 14 7z"/>,
 send:<path d="m3 3 18 9-18 9 4-9zm4 9h14"/>,
 pin:<><path d="M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 0 1 14 0Z"/><circle cx="12" cy="9" r="2.5"/></>,
 eye:<><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></>,
 };
 return <svg className="social-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">{paths[name]}</svg>;
}
export function SocialMemberLink({client,member,children}:{client:PortalClient;member:Mention;children?:ReactNode}){
 const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement>(null),seq=useRef(0),id=useId();
 const [card,setCard]=useState<{nickname:string;avatar_url?:string;primary_guild?:{name:string}|null}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 useEffect(()=>()=>{++seq.current;},[]);
 async function show(){const token=++seq.current;setCard(null);setError('');setBusy(true);dialog.current?.showModal();try{const next=await client.get<NonNullable<typeof card>>(`/members/${member.user_id}`);if(seq.current===token)setCard(next);}catch(e){if(seq.current===token)setError(e instanceof Error?e.message:'會員資料暫時無法載入。');}finally{if(seq.current===token)setBusy(false);}}
 function close(){++seq.current;dialog.current?.close();trigger.current?.focus();}
 return <><button ref={trigger} type="button" className="social-text-link" onClick={()=>void show()}>{children??member.display_name}</button><dialog ref={dialog} className="social-publish-dialog social-member-dialog" aria-labelledby={id} onCancel={e=>{e.preventDefault();close();}}><header className="social-publish-head"><h2 id={id}>會員名片</h2><button className="btn btn-ghost" type="button" onClick={close}>關閉名片</button></header>{busy&&<p role="status">載入中…</p>}{error&&<p role="alert">{error}</p>}{card&&<div className="social-member-summary"><MemberAvatar nickname={card.nickname} avatarUrl={card.avatar_url}/><strong>{card.nickname}</strong>{card.primary_guild&&<p>{card.primary_guild.name}</p>}</div>}</dialog></>;
}
export function SocialRichText({client,text,mentions=[],onTag}:{client:PortalClient;text:string;mentions?:Mention[];onTag?:(tag:string)=>void}){
 const names=new Map(mentions.map(item=>[`@${item.display_name}`,item]));
 const escaped=[...names.keys()].sort((a,b)=>b.length-a.length).map(s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const pattern=new RegExp(`(${[...escaped,'(?<![\\p{L}\\p{N}_])#[\\p{L}\\p{N}_]{1,50}(?![\\p{L}\\p{N}_])'].join('|')})`,'gu');
 return <>{text.split(pattern).map((part,index)=>names.has(part)?<SocialMemberLink key={index} client={client} member={names.get(part)!}>{part}</SocialMemberLink>:part.startsWith('#')&&/^#[\p{L}\p{N}_]{1,50}$/u.test(part)&&onTag?<button type="button" className="social-text-link" key={index} onClick={()=>onTag(part.slice(1))}>{part}</button>:part)}</>;
}
export function SocialTextTools({client,text,onChange,mentions,onMentions,disabled,maxLength=1000}:{client:PortalClient;text:string;onChange:(s:string)=>void;mentions:Mention[];onMentions:(v:Mention[])=>void;disabled:boolean;maxLength?:number}){
 const [mode,setMode]=useState<'emoji'|'mention'|null>(null),[dismissed,setDismissed]=useState<string|null>(null),[search,setSearch]=useState(''),[items,setItems]=useState<Mention[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const id=useId(),trigger=useRef<HTMLButtonElement>(null);
 const at=/(?:^|\s)@([^@#\n]{0,40})$/.exec(text);
 const query=mode==='mention'?search:text===dismissed?undefined:at?.[1],showMention=mode==='mention'||query!==undefined;
 useEffect(()=>{if(!showMention||disabled)return;let active=true;setBusy(true);setError('');const timer=setTimeout(()=>{void client.get<{items:{user_id:string;nickname:string}[]}>(`/members?limit=6&search=${encodeURIComponent(query??'')}`).then(page=>{if(active)setItems(page.items.map(item=>({user_id:item.user_id,display_name:item.nickname})));}).catch(e=>{if(active)setError(e instanceof Error?e.message:'會員暫時無法載入。');}).finally(()=>{if(active)setBusy(false);});},200);return()=>{active=false;clearTimeout(timer);};},[client,showMention,query,disabled]);
 function choose(member:Mention){const value=at?text.slice(0,text.lastIndexOf('@'))+`@${member.display_name} `:`${text}${text&&!text.endsWith(' ')?' ':''}@${member.display_name} `;if(value.length>maxLength||mentions.length>=10&&!mentions.some(m=>m.user_id===member.user_id)){setError('文字或標註人數已達上限。');return;}onChange(value);onMentions([...new Map([...mentions,member].map(m=>[m.user_id,m])).values()]);setMode(null);setSearch('');setDismissed(value);const area=trigger.current?.closest('form')?.querySelector('textarea');area?.focus();}
 return <div className="social-text-tools">
 <div className="social-tool-buttons"><button ref={trigger} type="button" className="social-icon-button" aria-label="插入 emoji" title="插入 emoji" disabled={disabled} aria-expanded={mode==='emoji'} aria-controls={id} onClick={()=>setMode(mode==='emoji'?null:'emoji')}><SocialIcon name="smile"/></button><button type="button" className="social-icon-button" disabled={disabled} aria-label="標註會員" title="標註會員" aria-expanded={showMention} aria-controls={id} onClick={()=>setMode(mode==='mention'?null:'mention')}>@</button></div>
 {!disabled&&(mode==='emoji'||showMention)&&<section className="social-text-picker" id={id} aria-label={mode==='emoji'?'emoji':'標註會員'} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();setMode(null);setDismissed(text);trigger.current?.focus();}}}>
 {mode==='emoji'?<div className="social-emoji-grid">{['😀','😂','😍','🥰','👍','👏','🎉','❤️','🙏','💪','🔥','✨'].map(emoji=><button key={emoji} type="button" aria-label={`插入 ${emoji}`} disabled={text.length+emoji.length>maxLength} onClick={()=>{onChange(text+emoji);setMode(null);trigger.current?.focus();}}>{emoji}</button>)}</div>:<><label className="field">搜尋會員<input type="search" aria-label="搜尋標註會員" maxLength={40} value={query??''} onChange={e=>{setMode('mention');setSearch(e.target.value);}}/></label>{busy?<p role="status">搜尋中…</p>:items.map(member=><button className="social-mention-choice" type="button" key={member.user_id} onClick={()=>choose(member)}><MemberAvatar nickname={member.display_name}/><span>{member.display_name}</span></button>)}{!busy&&!items.length&&!error&&<p>沒有符合的會員。</p>}{error&&<p role="alert">{error}</p>}</>}
 </section>}
 </div>;
}
