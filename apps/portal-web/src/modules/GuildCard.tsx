import {useEffect,useId,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {guildMasterLabel,type GuildSummary} from './Onboarding';
import {GuildName} from './GuildName';
import {GuildLeadership} from './GuildLeadership';
import {GuildMembers} from './GuildMembers';
import {GuildAnnouncements} from './GuildWorkspace';
import {SkillBookIntro} from './SkillBookIntro';
import {GuildTags} from './GuildFilters';
import {openMemberChat} from './chat-entry';
import {SkillBookStarGate} from './SkillBookCover';

export type GuildCategorySlot={pending:boolean;selected:boolean;section:string;onToggle?:()=>void;actionId?:string};
export function GuildCard({guild:g,client,busy,onPrimary,onMembership,onSecondary,secondaryFull=false,viewerId,onChanged,categorySlot,launchpadEnabled=false,onLaunchpad}:{guild:GuildSummary;client:PortalClient;busy:boolean;onPrimary:()=>void;onMembership:()=>void;onSecondary?:()=>void;secondaryFull?:boolean;viewerId?:string;onChanged?:()=>void;categorySlot?:GuildCategorySlot;launchpadEnabled?:boolean;onLaunchpad?:()=>void}) {
  const [panel,setPanel]=useState<'books'|'members'|'announcements'|null>(null);
  const dialog=useRef<HTMLDialogElement>(null),trigger=useRef<HTMLButtonElement|null>(null),titleId=useId();
  const active=g.membership?.state==='active',firstBook=g.skill_books[0],legacyPrimary=!categorySlot&&g.is_primary;
  const title=`${g.name}${panel==='books'?'技能書庫':panel==='members'?'成員':'公告'}`;
  const badge=categorySlot?(categorySlot.selected?'本類主力':categorySlot.pending?'分類整理中':active?'已加入':'未加入'):g.is_primary?'主要公會':g.is_secondary?'次要公會':active?'已加入':'未加入';
  useEffect(()=>{if(panel&&!dialog.current?.open)dialog.current?.showModal();},[panel]);
  function open(value:NonNullable<typeof panel>,button:HTMLButtonElement){trigger.current=button;setPanel(value);}
  function close(){dialog.current?.close();setPanel(null);trigger.current?.focus();}
  return <article className={`card guild-card${legacyPrimary||categorySlot?.selected?' primary-guild':active?' joined-guild':''}`} aria-label={g.name} data-guild-key={g.guild_key} tabIndex={-1}>
    <div className="guild-card-content">
      <div className="card-head guild-card-topline"><h3><GuildName name={g.name} alias={g.alias}/></h3><span className="badge">{badge}</span></div>
      <GuildLeadership masterName={guildMasterLabel(g)} masterId={g.guild_master?.user_id} masterAvatarUrl={g.guild_master?.avatar_url} experts={g.guild_experts}/>
      <p className="guild-purpose multiline-text">{g.purpose}</p>{active&&g.membership?.member_tier==='intern'&&<p className="field-hint guild-intern-notice" role="status">你是這個公會的實習成員：可以閱讀公會內容、在公會聊天室聊天。想發布或編輯，可以在聊天室跟會長打聲招呼，會長能把你設為正式成員。</p>}<GuildTags tags={g.tags}/>
      <div className="guild-book-list"><strong>入門技能</strong>{firstBook?<SkillBookIntro book={firstBook} guildName={g.name} label={firstBook.title}/>:<p className="muted">技能書整理中</p>}</div>
      <SkillBookStarGate books={g.skill_books}/>
    </div>
    <div className="guild-card-controls">
      {active&&<div className="guild-first-step"><p className="multiline-text">{g.first_step}</p><button type="button" className="btn btn-ghost" onClick={()=>openMemberChat('guild',g.guild_key)}>進入公會聊天室</button></div>}
      <button type="button" className="btn btn-ghost" aria-haspopup="dialog" onClick={event=>open('books',event.currentTarget)}>公會技能書庫 · {g.skill_books.length}</button>
      <div className="guild-card-links"><button type="button" className="btn btn-ghost" aria-haspopup="dialog" onClick={event=>open('members',event.currentTarget)}>查看成員</button>{active&&<button type="button" className="btn btn-ghost" aria-haspopup="dialog" onClick={event=>open('announcements',event.currentTarget)}>公會公告</button>}{launchpadEnabled&&<button type="button" className="btn btn-ghost" onClick={onLaunchpad}>啟動台</button>}</div>
      <div className="actions">{categorySlot&&active&&!categorySlot.pending&&categorySlot.onToggle&&<button type="button" className="btn btn-ghost" data-category-action={categorySlot.actionId} disabled={busy} onClick={categorySlot.onToggle}>{categorySlot.selected?'取消本類主力':'設為本類主力'}</button>}{!categorySlot&&active&&!g.is_primary&&<button className="btn btn-primary" disabled={busy} onClick={onPrimary}>設為主要公會</button>}{!categorySlot&&active&&!g.is_primary&&onSecondary&&<button type="button" className="btn btn-ghost" disabled={busy||(!g.is_secondary&&secondaryFull)} onClick={onSecondary}>{g.is_secondary?'取消次要公會':'設為次要公會'}</button>}<button type="button" className="btn btn-ghost" disabled={busy||legacyPrimary} onClick={onMembership}>{active?'退出':'加入'}{g.name}</button></div>
      {categorySlot?.pending&&<p className="field-hint">分類整理中，仍可使用公會工作區。</p>}
      {legacyPrimary&&<p className="field-hint">退出前，請先更換主要公會。</p>}
      {!categorySlot&&active&&!g.is_primary&&!g.is_secondary&&secondaryFull&&<p className="field-hint">次要公會已滿 2 個。先取消其中一個。</p>}
    </div>
    <dialog ref={dialog} className="guild-detail-dialog" aria-labelledby={titleId} onCancel={event=>{if(event.target===event.currentTarget){event.preventDefault();close();}}} onClose={event=>{if(event.target===event.currentTarget)setPanel(null);}}>
      <header className="guild-detail-heading"><h2 id={titleId}>{title}</h2><button type="button" className="btn btn-ghost" aria-label="關閉公會視窗" autoFocus onClick={close}>關閉</button></header>
      {panel==='books'&&<div className="guild-library-books">{g.skill_books.map((book,index)=><div className="guild-library-entry" key={book.id??book.book_id}><div><span className="field-hint">{index===0?'入門技能':`技能 ${index+1}`}</span><p>{book.guide?.beginner?.purpose??book.description}</p></div><SkillBookIntro book={book} guildName={g.name} label={book.title}/></div>)}{!g.skill_books.length&&<p>技能書整理中</p>}</div>}
      {panel==='members'&&<GuildMembers key={`${g.guild_key}:${g.membership?.aggregate_version??'none'}`} client={client} guildKey={g.guild_key} guildName={g.name} masterId={g.guild_master?.user_id} expertIds={g.guild_experts?.map(expert=>expert.user_id)} viewerId={viewerId} expertCount={g.guild_experts?.length??0} onChanged={onChanged}/>}
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
