import {useEffect,useId,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {guildMasterLabel,type GuildSummary} from './Onboarding';
import {GuildLeadership} from './GuildLeadership';
import {GuildMembers} from './GuildMembers';
import {GuildAnnouncements} from './GuildWorkspace';
import {SkillBookIntro} from './SkillBookIntro';

export function GuildCard({guild:g,client,busy,onPrimary,onMembership}:{guild:GuildSummary;client:PortalClient;busy:boolean;onPrimary:()=>void;onMembership:()=>void}) {
  const [panel,setPanel]=useState<'books'|'members'|'announcements'|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement|null>(null),titleId=useId();
  const active=g.membership?.state==='active',firstBook=g.skill_books[0];
  const title=`${g.name}${panel==='books'?'技能書庫':panel==='members'?'成員':'公告'}`;
  useEffect(()=>{if(panel&&!dialog.current?.open)dialog.current?.showModal();},[panel]);
  function open(value:NonNullable<typeof panel>,button:HTMLButtonElement){trigger.current=button;setPanel(value);}
  function close(){dialog.current?.close();setPanel(null);trigger.current?.focus();}
  return <article className={`card guild-card${g.is_primary?' primary-guild':active?' joined-guild':''}`} aria-label={g.name} data-guild-key={g.guild_key}>
    <div className="guild-card-content">
      <div className="card-head guild-card-topline"><h3>{g.name}</h3><span className="badge">{g.is_primary?'主要公會':g.is_secondary?'次要公會':active?'已加入':'未加入'}</span></div>
      <GuildLeadership masterName={guildMasterLabel(g)} masterId={g.guild_master?.user_id} masterAvatarUrl={g.guild_master?.avatar_url} experts={g.guild_experts}/>
      <p className="guild-purpose">{g.purpose}</p>
      <div className="guild-book-list"><strong>入門技能</strong>{firstBook?<SkillBookIntro book={firstBook} guildName={g.name} label={firstBook.title}/>:<p className="muted">技能書整理中</p>}</div>
    </div>
    <div className="guild-card-controls">
      <button type="button" className="btn btn-ghost" aria-haspopup="dialog" onClick={event=>open('books',event.currentTarget)}>公會技能書庫 · {g.skill_books.length}</button>
      <div className="guild-card-links"><button type="button" className="btn btn-ghost" aria-haspopup="dialog" onClick={event=>open('members',event.currentTarget)}>查看成員</button>{active&&<button type="button" className="btn btn-ghost" aria-haspopup="dialog" onClick={event=>open('announcements',event.currentTarget)}>公會公告</button>}</div>
      <div className="actions">{active&&!g.is_primary&&<button className="btn btn-primary" disabled={busy} onClick={onPrimary}>設為主要公會</button>}<button type="button" className="btn btn-ghost" disabled={busy||g.is_primary} onClick={onMembership}>{active?'退出':'加入'}{g.name}</button></div>
      {g.is_primary&&<p className="field-hint">退出前，請先更換主要公會。</p>}
    </div>
    <dialog ref={dialog} className="guild-detail-dialog" aria-labelledby={titleId} onCancel={event=>{if(event.target===event.currentTarget){event.preventDefault();close();}}} onClose={event=>{if(event.target===event.currentTarget)setPanel(null);}}>
      <header className="guild-detail-heading"><h2 id={titleId}>{title}</h2><button type="button" className="btn btn-ghost" aria-label="關閉公會視窗" autoFocus onClick={close}>關閉</button></header>
      {panel==='books'&&<div className="guild-library-books">{g.skill_books.map((book,index)=><div className="guild-library-entry" key={book.id??book.book_id}><div><span className="field-hint">{index===0?'入門技能':`技能 ${index+1}`}</span><p>{book.guide?.beginner?.purpose??book.description}</p></div><SkillBookIntro book={book} guildName={g.name} label={book.title}/></div>)}{!g.skill_books.length&&<p>技能書整理中</p>}</div>}
      {panel==='members'&&<GuildMembers key={`${g.guild_key}:${g.membership?.aggregate_version??'none'}`} client={client} guildKey={g.guild_key} guildName={g.name} masterId={g.guild_master?.user_id} expertIds={g.guild_experts?.map(expert=>expert.user_id)}/>}
      {panel==='announcements'&&active&&<GuildAnnouncements client={client} guildKey={g.guild_key} expanded/>}
    </dialog>
  </article>;
}

// Measure intrinsic content, not stretched cards. Long names, portraits and
// responsive widths can change the required minimum height without clipping
// content while the next measurement is still pending.
export function useUniformGuildCards(key:string){
  const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    const node=root.current;if(!node)return;
    let frame=0;
    const measure=()=>{
      cancelAnimationFrame(frame);
      frame=requestAnimationFrame(()=>{
        let height=0;
        for(const card of node.querySelectorAll<HTMLElement>('.guild-card')){
          const content=card.querySelector<HTMLElement>('.guild-card-content'),controls=card.querySelector<HTMLElement>('.guild-card-controls');
          if(!content||!controls)continue;
          const style=getComputedStyle(card);
          height=Math.max(height,content.getBoundingClientRect().height+controls.getBoundingClientRect().height+parseFloat(style.rowGap||'0')+parseFloat(style.paddingTop)+parseFloat(style.paddingBottom)+parseFloat(style.borderTopWidth)+parseFloat(style.borderBottomWidth));
        }
        if(height)node.style.setProperty('--guild-card-height',`${Math.ceil(height)}px`);
      });
    };
    const observer=new ResizeObserver(measure);
    node.querySelectorAll('.guild-card-content,.guild-card-controls').forEach(element=>observer.observe(element));
    measure();return()=>{observer.disconnect();cancelAnimationFrame(frame);};
  },[key]);
  return root;
}
