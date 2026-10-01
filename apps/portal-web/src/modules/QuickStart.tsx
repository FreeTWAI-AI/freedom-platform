import {useEffect,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {useModuleMutation} from './shared';
import type {GuildSummary,OnboardingView} from './Onboarding';
import {GuildTopicFilter,GuildTags} from './GuildFilters';
import type {GuildTopic} from '../../../../packages/shared/guild-topics';
export function QuickStart({client,onCompleted}:{client:PortalClient;onCompleted:()=>void}){
  const [guilds,setGuilds]=useState<GuildSummary[]>([]),[primary,setPrimary]=useState(''),[query,setQuery]=useState(''),[topic,setTopic]=useState<GuildTopic|''>('');
  const [loading,setLoading]=useState(true),[loadError,setLoadError]=useState(''),[recovering,setRecovering]=useState(false);
  const generation=useRef(0),{mutate,busy,error}=useModuleMutation(client);
  async function load(){const sequence=++generation.current;setLoading(true);setLoadError('');try{const data=await client.get<{items:GuildSummary[]}>('/guilds/directory');if(sequence===generation.current)setGuilds(data.items);}catch(cause){if(sequence===generation.current)setLoadError(cause instanceof Error?cause.message:'公會暫時無法載入。');}finally{if(sequence===generation.current)setLoading(false);}}
  useEffect(()=>{void load();return()=>{generation.current++;};},[client]);
  async function join(){if(!primary||busy||recovering)return;const result=await mutate<OnboardingView>('/me/onboarding/quick-start',{guild_keys:[primary],primary_guild_key:primary,confirmed:true});if(result?.completed)onCompleted();}
  async function recover(){setRecovering(true);setLoadError('');try{const current=await client.get<OnboardingView>('/me/onboarding');if(current.completed)onCompleted();else setLoadError('尚未完成加入，請再按一次「加入公會，開始參與」。');}catch(cause){setLoadError(cause instanceof Error?cause.message:'暫時無法確認加入狀態。');}finally{setRecovering(false);}}
  const visible=guilds.filter(g=>(!topic||g.tags?.includes(topic))&&(!query.trim()||`${g.name} ${g.purpose} ${g.skill_books.map(book=>book.title).join(' ')}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  return <section className="quick-start card stack" aria-label="快速加入公會">
    <header><h2>選一個公會，直接開始</h2><p>依興趣選擇主要公會，就能領技能書、認識夥伴。之後可加入更多公會，定位測驗隨時補做。</p></header>
    <label className="field">找感興趣的公會<input type="search" value={query} onChange={event=>setQuery(event.target.value)} maxLength={100} placeholder="例如：AI、影片、活動"/></label>
    <GuildTopicFilter value={topic} onChange={setTopic}/>
    <div className="actions quick-join-actions"><button type="button" className="btn btn-primary" disabled={!primary||loading||busy||recovering} onClick={()=>void join()}>{busy?'正在加入…':'加入公會，開始參與'}</button>{primary&&<span className="field-hint">已選：{guilds.find(g=>g.guild_key===primary)?.name}</span>}</div>
    {loading&&<p role="status">正在載入全部公會…</p>}
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" disabled={loading||busy} onClick={()=>void load()}>重讀公會</button></div>}
    {!loading&&!loadError&&<><p className="field-hint">顯示 {visible.length} / {guilds.length} 個公會</p><fieldset className="quick-guild-options" disabled={busy||recovering}><legend>選擇主要公會</legend>{visible.map(g=><label className={`quick-guild-option${primary===g.guild_key?' is-selected':''}`} key={g.guild_key}>
      <input type="radio" name="quick-primary" value={g.guild_key} checked={primary===g.guild_key} onChange={()=>setPrimary(g.guild_key)}/><span><strong>{g.name}</strong><span className="quick-guild-purpose">{g.purpose}</span><GuildTags tags={g.tags}/><span className="field-hint">{g.skill_books.length} 本免費技能書</span></span>
    </label>)}</fieldset>{!visible.length&&<p>沒有符合的公會，請換個關鍵字或主題。</p>}</>}
    {error&&<div className="banner banner-error" role="alert"><p>{error}</p><button type="button" className="btn btn-ghost" disabled={busy||recovering} onClick={()=>void recover()}>重讀加入狀態</button></div>}
  </section>;
}
