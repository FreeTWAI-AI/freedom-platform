import { useCallback,useEffect,useRef,useState,type FormEvent } from 'react';
import { useModuleMutation,type ModulePanelProps } from './shared';
import { SkillBookIntro } from './SkillBookIntro';
import { Onboarding, SkillBooks, guildMasterLabel, type GuildSummary, type OnboardingView, type SkillBook } from './Onboarding';
import { loadLabels, type MemberCardData } from './Membership';
import './GuildDesign.css';
import {GuildAnnouncements} from './GuildWorkspace';
import {GuildMembers} from './GuildMembers';
import {GuildLeadership} from './GuildLeadership';

function failure(error:unknown){return error instanceof Error?error.message:'暫時無法取得資料，請重試。';}

export function PositioningPanel({client,session,onNavigate}:ModulePanelProps) {
  const [summary,setSummary]=useState<{assessment:OnboardingView;member:MemberCardData;labels:Record<string,string>}|null>(null),[retaking,setRetaking]=useState(false);
  const [summaryLoading,setSummaryLoading]=useState(true),[summaryError,setSummaryError]=useState<string|null>(null),summaryGeneration=useRef(0);
  const loadSummary=useCallback(async()=>{
    const generation=++summaryGeneration.current;
    setSummaryLoading(true);setSummaryError(null);
    try {
      const [assessment,member,labels]=await Promise.all([client.get<OnboardingView>('/me/onboarding'),client.get<MemberCardData>(`/members/${session.user.user_id}`),loadLabels(client)]);
      if(generation===summaryGeneration.current)setSummary({assessment,member,labels});
    } catch(e) {if(generation===summaryGeneration.current)setSummaryError(failure(e));}
    finally {if(generation===summaryGeneration.current)setSummaryLoading(false);}
  },[client,session.user.user_id]);
  useEffect(()=>{void loadSummary();const refresh=()=>{void loadSummary();};window.addEventListener('freedom-profile-updated',refresh);return()=>{summaryGeneration.current++;window.removeEventListener('freedom-profile-updated',refresh);};},[loadSummary]);
  const assessment=summary?.assessment,member=summary?.member;
  const abilityLabels=member?[...member.capabilities.map(id=>summary?.labels[id]??id),...(member.custom_capabilities??[])]:[];
  const equipmentLabels=member?[...member.equipment.map(id=>summary?.labels[id]??id),...(member.custom_equipment??[])]:[];
  const featuredLabels=member?(member.featured_capabilities??member.capabilities.slice(0,3)).slice(0,3).map(id=>id.startsWith('custom:')?id.slice(7):summary?.labels[id]??id):[];
  const firstBook=assessment?.skill_books.find(book=>member?.primary_guild&&book.guild_keys.includes(member.primary_guild.guild_key))??assessment?.skill_books[0];
  if(retaking&&assessment)return <Onboarding client={client} initial={assessment} optional onCompleted={()=>{setRetaking(false);window.dispatchEvent(new Event('freedom-profile-updated'));}}/>;
  return <section className="module-panel positioning-panel" aria-labelledby="positioning-title">
    <header className="section-heading positioning-heading"><div><p className="eyebrow">YOUR PLACE IN FREEDOM</p><h2 id="positioning-title">我的定位</h2></div><div className="direction-orbit" aria-hidden="true"><span>↗</span></div></header>
    {summaryLoading&&<p role="status">正在載入你的定位結果…</p>}
    {summaryError&&<div className="banner banner-error" role="alert"><p>定位結果暫時無法載入：{summaryError}</p><button type="button" className="btn btn-ghost" onClick={()=>void loadSummary()}>重新載入定位結果</button></div>}
    {!summaryLoading&&!summaryError&&assessment&&member&&<section className="card positioning-result" aria-labelledby="positioning-result-title">
      <div className="positioning-result-heading"><div><p className="eyebrow">YOUR POSITION</p><h3 id="positioning-result-title">我的定位結果</h3></div>{assessment.completed&&<span className="badge">已完成定位</span>}</div>
      {member.positioning_title&&<p className="positioning-result-role">{member.positioning_title}</p>}
      <dl className="positioning-result-guilds"><div><dt>主要公會</dt><dd>{member.primary_guild?.name??'尚未選擇'}</dd></div><div><dt>次要公會</dt><dd>{member.secondary_guilds.map(g=>g.name).join('、')||'先專注在主要公會'}</dd></div></dl>
      {featuredLabels.length>0&&<div className="positioning-featured"><h4>擅長的能力</h4><div className="tag-list">{featuredLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>)}</div></div>}
      <details className="positioning-result-skills"><summary>我的能力與裝備 · {abilityLabels.length} 項能力／{equipmentLabels.length} 項裝備</summary><div><section><h4>我的能力</h4><div className="tag-list">{abilityLabels.length?abilityLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>):<p className="muted">可以隨時補充，也可以先開始閱讀技能書。</p>}</div></section><section><h4>我的裝備</h4><div className="tag-list">{equipmentLabels.length?equipmentLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>):<p className="muted">尚未填寫裝備，不影響參與公會。</p>}</div></section></div></details>
      <div className="positioning-result-next"><div className="actions"><button type="button" className="btn btn-primary" onClick={()=>onNavigate?.('guilds')}>前往我的公會</button>{firstBook&&<SkillBookIntro book={firstBook} guildName={firstBook.guild_keys.includes(member.primary_guild?.guild_key??'')?member.primary_guild?.name:undefined} label="閱讀我的技能書"/>}</div></div>
      <div className="positioning-result-adjust"><button type="button" className="btn btn-ghost" onClick={()=>setRetaking(true)}>{assessment.completed?'重新探索定位':'開始探索我的定位'}</button>{assessment.completed&&assessment.state!=='completed'&&<p className="field-hint">調整中的草稿尚未取代這份已確認的定位。</p>}</div>
    </section>}
  </section>;
}

export function GuildsPanel({client}:ModulePanelProps) {
  const [memberGuild,setMemberGuild]=useState<string|null>(null);
  const [guilds,setGuilds]=useState<GuildSummary[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null),[notice,setNotice]=useState(''),[preferences,setPreferences]=useState<{primary_guild_key:string|null;aggregate_version?:number}|null>(null),[books,setBooks]=useState<SkillBook[]>([]),[applications,setApplications]=useState<{application_id:string;name:string;profession:string;state:string}[]>([]),[showApply,setShowApply]=useState(false);
  const {mutate,busy,error}=useModuleMutation(client);
  async function load(){setLoadError(null);try{const [g,p,b,a]=await Promise.all([client.get<{items:GuildSummary[]}>('/guilds/directory'),client.get<{primary_guild_key:string|null;aggregate_version?:number}>('/me/guild-preferences'),client.get<{items:SkillBook[]}>('/me/skill-books'),client.get<{items:typeof applications}>('/guild-applications')]);setGuilds(g.items);setPreferences(p);setBooks(b.items);setApplications(a.items);}catch(e){setLoadError(failure(e));}finally{setLoading(false);}}
  useEffect(()=>{void load();},[client]);
  async function change(g:GuildSummary){const joining=g.membership?.state!=='active';setNotice('');const result=await mutate(`/guilds/${g.guild_key}/${joining?'join':'leave'}`,{},g.membership?.aggregate_version);if(result){setNotice(joining?`已加入${g.name}，技能書已放入你的書架。`:`已退出${g.name}。既有成果與其他公會關係保留。`);await load();}}
  async function primary(g:GuildSummary){const result=await mutate(`/guilds/${g.guild_key}/primary`,{},preferences?.aggregate_version);if(result){setNotice(`主要公會已設為${g.name}。`);await load();window.dispatchEvent(new Event('freedom-profile-updated'));}}
  async function apply(event:FormEvent<HTMLFormElement>){event.preventDefault();const form=event.currentTarget,d=new FormData(form);const result=await mutate('/guild-applications',{name:d.get('name'),profession:d.get('profession'),reason:d.get('reason')});if(result){form.reset();setNotice('創建公會申請已送出，等待社群討論與安排。');await load();}}
  const sortedGuilds=[...guilds].sort((a,b)=>(a.is_primary?0:a.membership?.state==='active'?1:2)-(b.is_primary?0:b.membership?.state==='active'?1:2));
  const joinedCount=guilds.filter(g=>g.membership?.state==='active').length;
  return <section className="module-panel guilds-panel" aria-labelledby="guilds-title">
    <header className="guild-hub-heading">
      <div className="guild-hub-copy"><p className="eyebrow">FIND YOUR GUILD</p><h2 id="guilds-title">職業公會</h2><button className="btn btn-ghost" aria-expanded={showApply} aria-controls="guild-application" onClick={()=>setShowApply(!showApply)}>{showApply?'收起創建申請':'申請創建公會'}</button></div>
      <div className="guild-hub-art" aria-hidden="true"><img src="/art/rpg/workshop-hub.webp" alt="" width="1536" height="1024"/><span>FREEDOM / GUILD NETWORK</span></div>
    </header>
    {!loading&&!loadError&&<div className="guild-overview" aria-label="我的公會概況"><div><strong>{guilds.length}</strong><span>職業公會</span></div><div><strong>{joinedCount}</strong><span>已加入公會</span></div><div><strong>{books.length}</strong><span>我的技能書</span></div></div>}
    {loading&&<p role="status">正在載入職業公會…</p>}{loadError&&<div role="alert">{loadError}<button onClick={()=>void load()}>重新載入公會</button></div>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status" className="banner status-note">{notice}</p>}
    {showApply&&<form id="guild-application" className="card stack guild-application" onSubmit={apply}><h3>讓你的專業，也有自己的公會</h3><label className="field">希望成立的公會名稱<input name="name" required minLength={2} maxLength={100}/></label><label className="field">專業／職業領域<input name="profession" required maxLength={120}/></label><label className="field">為什麼想成立？希望一起做什麼？<textarea name="reason" required minLength={10} maxLength={2000}/></label><p className="muted">先送申請，由管理員確認成立與公會長人選。</p><button className="btn btn-primary" disabled={busy}>送出創建公會申請</button>{applications.map((a,index)=><p key={a.application_id??index}>{a.name} · {a.state==='pending'?'待討論':a.state}</p>)}</form>}
    <div className="card-grid guild-directory">{sortedGuilds.map(g=><article className={`card guild-card${g.is_primary?' primary-guild':g.membership?.state==='active'?' joined-guild':''}${memberGuild===g.guild_key?' members-open':''}`} key={g.guild_key} aria-label={g.name}>
      <div className="guild-card-topline"><span className="guild-orbit" aria-hidden="true"><span/></span>{g.is_primary?<span className="badge">主要公會</span>:g.membership?.state==='active'?<span className="badge">次要公會</span>:<span className="guild-card-kicker">GUILD / 自由工坊</span>}</div>
      <div className="card-head"><h3>{g.name}</h3></div><GuildLeadership masterName={guildMasterLabel(g)} masterId={g.guild_master?.user_id} masterAvatarUrl={g.guild_master?.avatar_url} experts={g.guild_experts}/><p className="guild-purpose">{g.purpose}</p><small>{typeof g.track_count==='number'?`${g.track_count} 個職業方向 · `:''}公開知識與共同學習免費</small>
      <div className="guild-book-list"><strong>公會技能庫</strong>{g.skill_books.length?g.skill_books.map(book=><SkillBookIntro key={book.id??book.book_id} book={book} guildName={g.name} label={book.title}/>):<p className="muted">技能書整理中</p>}</div>
      {g.membership?.state==='active'&&<GuildAnnouncements client={client} guildKey={g.guild_key}/>}
      <button type="button" className="btn btn-ghost" aria-expanded={memberGuild===g.guild_key} aria-controls={`members-${g.guild_key}`} onClick={()=>setMemberGuild(current=>current===g.guild_key?null:g.guild_key)}>{memberGuild===g.guild_key?'收起成員':'查看成員'}</button>
      {memberGuild===g.guild_key&&<GuildMembers key={`${g.guild_key}:${g.membership?.aggregate_version??'none'}`} client={client} guildKey={g.guild_key} guildName={g.name} masterId={g.guild_master?.user_id} expertIds={g.guild_experts?.map(expert=>expert.user_id)}/>}
      <div className="actions">{g.membership?.state==='active'&&!g.is_primary&&<button className="btn btn-primary" disabled={busy} onClick={()=>void primary(g)}>設為主要公會</button>}<button type="button" className="btn btn-ghost" disabled={busy||g.is_primary} onClick={()=>void change(g)}>{g.membership?.state==='active'?'退出':'加入'}{g.name}</button></div>{g.is_primary&&<p className="field-hint">若要退出，先將另一個已加入的公會設為主要公會。</p>}
    </article>)}</div>
    <section className="stack guild-bookshelf"><header className="section-heading"><p className="eyebrow">YOUR SKILL LIBRARY</p><h3>我的技能書架</h3></header>{books.length?<SkillBooks books={books}/>:<p className="guild-books-empty">加入公會，就能取得第一本技能書。</p>}</section>
  </section>;
}
