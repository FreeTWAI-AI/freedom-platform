import {useEffect,useState} from 'react';
import type {PortalClient} from '../api';
import type {TabId} from '../types';
import type {GuildSummary} from './Onboarding';
import {SkillBookIntro} from './SkillBookIntro';
import {openMemberChat} from './chat-entry';

type Work={work_item_id:string;title:string;objective:string};
export function GuildNextSteps({client,onNavigate}:{client:PortalClient;onNavigate?:(id:TabId)=>void}){
  const [guilds,setGuilds]=useState<GuildSummary[]|null>(null),[unlocked,setUnlocked]=useState<string[]>([]),[work,setWork]=useState<Work|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  useEffect(()=>{
    let active=true;setError('');
    void Promise.allSettled([client.get<{items:GuildSummary[]}>('/guilds/directory'),client.get<{items:{book_id:string}[]}>('/me/skill-books'),client.get<{items:Work[]}>('/task-board/preview')]).then(results=>{
      if(!active)return;
      if(results[0].status==='fulfilled')setGuilds(results[0].value.items);else setGuilds(null);
      setUnlocked(results[1].status==='fulfilled'?results[1].value.items.map(item=>item.book_id):[]);
      setWork(results[2].status==='fulfilled'?results[2].value.items[0]??null:null);
      if(results.some(result=>result.status==='rejected'))setError('部分下一步暫時無法載入，仍可使用下方入口。');
    });
    const refresh=()=>setRevision(value=>value+1);window.addEventListener('freedom-profile-updated',refresh);
    return()=>{active=false;window.removeEventListener('freedom-profile-updated',refresh)};
  },[client,revision]);
  const guild=guilds?.find(item=>item.is_primary&&item.membership?.state==='active')??guilds?.find(item=>item.membership?.state==='active');
  const book=guild?.skill_books.find(item=>unlocked.includes(item.book_id??item.id??''));
  return <section className="guild-next-steps" aria-labelledby="next-steps-heading">
    <header><p className="eyebrow">從一件小事開始</p><h2 id="next-steps-heading">{guild?`加入${guild.name}之後，你可以…`:'今天想做什麼？'}</h2><p className="muted">{guild?.first_step||'學一項技能、認識一個夥伴，再把想法一起做出來。'}</p></header>
    {error&&<div role="status" className="banner banner-info">{error}<button type="button" className="btn btn-ghost" onClick={()=>setRevision(value=>value+1)}>重讀下一步</button></div>}
    <div className="next-step-grid">
      <article><span className="next-step-number" aria-hidden="true">1</span><h3>學一個能用上的技能</h3><p>{book?book.title:'到技能書架挑一份免費資源，從你想做的事情開始。'}</p>{book?<SkillBookIntro book={book} guildName={guild?.name} label="閱讀第一本技能書"/>:<button className="btn btn-primary" onClick={()=>onNavigate?.('skills')}>挑選免費技能書</button>}</article>
      <article><span className="next-step-number" aria-hidden="true">2</span><h3>認識同公會的夥伴</h3><p>介紹你想學什麼、能提供什麼，或說出現在卡住的地方。</p>{guild?<button className="btn btn-ghost" onClick={()=>openMemberChat('guild',guild.guild_key)}>進入{guild.name}聊天室</button>:<button className="btn btn-ghost" onClick={()=>onNavigate?.('guilds')}>選擇感興趣的公會</button>}</article>
      <article><span className="next-step-number" aria-hidden="true">3</span><h3>一起完成一件事</h3><p>{work?work.title:'可以分享作品與需求，找到願意一起試做的人。'}</p><button className="btn btn-ghost" onClick={()=>onNavigate?.(work?'tasks':'showcase')}>{work?'查看這項社群任務':'分享作品與需求'}</button></article>
    </div>
  </section>;
}
