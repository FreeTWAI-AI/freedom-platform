import { useCallback,useEffect,useRef,useState,type FormEvent } from 'react';
import { useModuleMutation,type ModulePanelProps } from './shared';
import type { TabId } from '../types';
import { SkillBookIntro } from './SkillBookIntro';
import { Onboarding, SkillBooks, guildMasterLabel, type GuildSummary, type OnboardingView, type SkillBook } from './Onboarding';
import { loadLabels, type MemberCardData } from './Membership';
import './GuildDesign.css';

type Profile={profile_id:string;aggregate_version:number;source:'self_declared';real_world_occupations:string[];background:string;strengths:string[];goals:string;weekly_minutes:number;desired_roles:string[];selected_tracks:string[];confirmed_at:string};
type Track={track_key:string;name:string;description:string;guild_key:string;guild_name:string;role_key:string;first_result:string;estimated_minutes:number};
type Recommendation={module_key:TabId;track_key:string;name:string;guild_key:string;guild_name:string;reason:string;first_result:string;estimated_minutes:number;time_note:string|null};
type View={profile:Profile|null;tracks:Track[];recommendations:Recommendation[]};
const roles=[['supplier','供貨商'],['seller','銷售者'],['creator','作品作者'],['promoter','行銷推廣者'],['helper','專業協作者']] as const;
const words=(value:string)=>[...new Set(value.split(/[,，、\n]/).map(v=>v.trim()).filter(Boolean))];
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
  const [view,setView]=useState<View|null>(null),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null);
  const [occupations,setOccupations]=useState(''),[background,setBackground]=useState(''),[strengths,setStrengths]=useState(''),[goals,setGoals]=useState(''),[minutes,setMinutes]=useState(120);
  const preferencesInitialized=useRef(false),preferencesTouched=useRef(false),[prefilledFields,setPrefilledFields]=useState<string[]>([]);
  const [selectedRoles,setSelectedRoles]=useState<string[]>([]),[tracks,setTracks]=useState<string[]>([]),[confirmed,setConfirmed]=useState(false),[saved,setSaved]=useState(false),[search,setSearch]=useState(''),[showAll,setShowAll]=useState(false);
  const {mutate,busy,error}=useModuleMutation(client);
  const fill=(data:View)=>{setView(data);if(data.profile){const p=data.profile;setOccupations(p.real_world_occupations.join('、'));setBackground(p.background);setStrengths(p.strengths.join('、'));setGoals(p.goals);setMinutes(p.weekly_minutes);setSelectedRoles(p.desired_roles);setTracks(p.selected_tracks);}setConfirmed(false);};
  async function load(){setLoading(true);setLoadError(null);try{fill(await client.get<View>('/me/positioning'));}catch(e){setLoadError(failure(e));}finally{setLoading(false);}}
  useEffect(()=>{void load();},[client]);
  useEffect(()=>{
    if(!view||view.profile||!summary?.assessment.completed||preferencesInitialized.current)return;
    preferencesInitialized.current=true;
    if(preferencesTouched.current)return;
    const fields:string[]=[];
    // A retake draft is not the member's confirmed occupation. Skills always
    // come from the published member projection, never onboarding.draft.
    if(summary.assessment.state==='completed'&&summary.assessment.draft?.occupation){setOccupations(summary.assessment.draft.occupation);fields.push('現實職業／目前身分');}
    const featured=summary.member.featured_capabilities??summary.member.capabilities.slice(0,3);
    if(featured.length){setStrengths(featured.map(id=>id.startsWith('custom:')?id.slice(7):summary.labels[id]??id).join('、'));fields.push('我擅長的事');}
    setPrefilledFields(fields);
  },[view,summary]);
  async function submit(event:FormEvent){event.preventDefault();setSaved(false);const result=await mutate<Profile>('/me/positioning',{real_world_occupations:words(occupations),background,strengths:words(strengths),goals,weekly_minutes:minutes,desired_roles:selectedRoles,selected_tracks:tracks,confirmed},view?.profile?.aggregate_version);if(result){try{fill(await client.get<View>('/me/positioning'));setSaved(true);}catch(e){setLoadError('合作偏好已保存；建議載入失敗，請重新整理。');}}}
  const toggle=(current:string[],key:string,set:(value:string[])=>void)=>set(current.includes(key)?current.filter(v=>v!==key):[...current,key]);
  const filteredTracks=view?.tracks.filter(t=>`${t.name} ${t.description} ${t.guild_name}`.includes(search))??[];
  const visibleTracks=search||showAll?filteredTracks:filteredTracks.filter((t,index)=>index<6||tracks.includes(t.track_key));
  if(retaking&&assessment)return <Onboarding client={client} initial={assessment} optional onCompleted={()=>{setRetaking(false);window.dispatchEvent(new Event('freedom-profile-updated'));}}/>;
  return <section className="module-panel positioning-panel" aria-labelledby="positioning-title">
    <header className="section-heading positioning-heading"><div><p className="eyebrow">YOUR PLACE IN FREEDOM</p><h2 id="positioning-title">我的定位</h2><p>從已選擇的公會與專長出發，挑一本技能書，開始你的下一個成果。</p></div><div className="direction-orbit" aria-hidden="true"><span>↗</span></div></header>
    {summaryLoading&&<p role="status">正在載入你的定位結果…</p>}
    {summaryError&&<div className="banner banner-error" role="alert"><p>定位結果暫時無法載入：{summaryError}</p><button type="button" className="btn btn-ghost" onClick={()=>void loadSummary()}>重新載入定位結果</button></div>}
    {!summaryLoading&&!summaryError&&assessment&&member&&<section className="card positioning-result" aria-labelledby="positioning-result-title">
      <div className="positioning-result-heading"><div><p className="eyebrow">YOUR POSITION</p><h3 id="positioning-result-title">我的定位結果</h3></div>{assessment.completed&&<span className="badge">已完成定位</span>}</div>
      {member.positioning_title&&<p className="positioning-result-role">{member.positioning_title}</p>}
      <dl className="positioning-result-guilds"><div><dt>主要公會</dt><dd>{member.primary_guild?.name??'尚未選擇'}</dd></div><div><dt>次要公會</dt><dd>{member.secondary_guilds.map(g=>g.name).join('、')||'先專注在主要公會'}</dd></div></dl>
      {featuredLabels.length>0&&<div className="positioning-featured"><h4>擅長的能力</h4><div className="tag-list">{featuredLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>)}</div></div>}
      <details className="positioning-result-skills"><summary>我的能力與裝備 · {abilityLabels.length} 項能力／{equipmentLabels.length} 項裝備</summary><div><section><h4>我的能力</h4><div className="tag-list">{abilityLabels.length?abilityLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>):<p className="muted">可以隨時補充，也可以先開始閱讀技能書。</p>}</div></section><section><h4>我的裝備</h4><div className="tag-list">{equipmentLabels.length?equipmentLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>):<p className="muted">尚未填寫裝備，不影響參與公會。</p>}</div></section></div></details>
      <div className="positioning-result-next"><p>{member.primary_guild?`前往${member.primary_guild.name}找夥伴，或從已領取的技能書開始練習。`:'探索感興趣的公會，認識夥伴與公會技能書。'}</p><div className="actions"><button type="button" className="btn btn-primary" onClick={()=>onNavigate?.('guilds')}>前往我的公會</button>{firstBook&&<SkillBookIntro book={firstBook} guildName={firstBook.guild_keys.includes(member.primary_guild?.guild_key??'')?member.primary_guild?.name:undefined} label="閱讀我的技能書"/>}</div></div>
      <div className="positioning-result-adjust"><button type="button" className="btn btn-ghost" onClick={()=>setRetaking(true)}>{assessment.completed?'調整定位與技能':'開始探索我的定位'}</button>{assessment.completed&&assessment.state!=='completed'&&<p className="field-hint">調整中的草稿尚未取代這份已確認的定位。</p>}</div>
    </section>}
    <details className="card positioning-form-card positioning-preferences"><summary>合作偏好（選填）</summary><p className="muted">有具體合作目標時，再補充想做的事與可投入時間；不需要再做一次定位，也不影響公會與技能書。</p>
      {loading&&<p role="status">正在載入合作偏好…</p>}
      {loadError&&<div role="alert">{loadError}<button type="button" className="btn btn-ghost" onClick={()=>void load()}>重新載入合作偏好</button></div>}
      {!loading&&view&&<><p className="field-hint">{view.profile?`已保存第 ${view.profile.aggregate_version} 版 · 本人自述`:'依需要填寫並保存，作為尋找合作方向的參考。'}</p>
      {!view.profile&&prefilledFields.length>0&&<p className="field-hint">已從你確認過的定位帶入：{prefilledFields.join('、')}。內容尚未保存，可以先修改。</p>}
      <form onSubmit={submit} onChange={()=>{preferencesTouched.current=true;}} className="form-grid positioning-form">
        <label className="field">現實職業／目前身分<input value={occupations} maxLength={800} onChange={e=>setOccupations(e.target.value)} placeholder="例如：餐飲業者、上班族、學生；可用頓號分隔"/></label>
        <label className="field">背景與手上的資源<textarea value={background} maxLength={1200} onChange={e=>setBackground(e.target.value)} placeholder="你做過什麼？有商品、設備、人脈或既有作品嗎？"/></label>
        <label className="field">我擅長的事<input value={strengths} maxLength={1200} onChange={e=>setStrengths(e.target.value)} placeholder="例如：攝影、溝通、整理資料；可用頓號分隔"/></label>
        <label className="field">我現在想完成的事<textarea required value={goals} maxLength={1000} onChange={e=>setGoals(e.target.value)} placeholder="例如：把自家茶葉整理成商品，找到第一位合作銷售者"/></label>
        <label className="field">每週可投入時間（分鐘）<input type="number" min={0} max={10080} required value={minutes} onChange={e=>setMinutes(Number(e.target.value))}/><small>填 0 也可以，先瀏覽與收藏方向。</small></label>
        <fieldset className="fieldset"><legend>我想怎麼參與（可複選）</legend>{roles.map(([key,label])=><label className="checkbox-row" key={key}><input type="checkbox" checked={selectedRoles.includes(key)} onChange={()=>toggle(selectedRoles,key,setSelectedRoles)}/>{label}</label>)}</fieldset>
        <fieldset className="fieldset positioning-tracks"><legend>想探索的職業方向（最多 3 個）</legend><p>方向是你的選擇；加入公會另由你確認。共有 {view.tracks.length} 個方向可探索。</p>
          <label className="field">搜尋職業方向<input type="search" value={search} onChange={e=>setSearch(e.target.value)} placeholder="輸入食品、銷售、開源、剪輯…"/></label>
          <p>目前已選：{tracks.length?view.tracks.filter(t=>tracks.includes(t.track_key)).map(t=>t.name).join('、'):'尚未選擇，也可以先保存目標。'}</p>
          <div className="card-grid positioning-track-grid">{visibleTracks.map(t=><label className="card checkbox-card" key={t.track_key}><input type="checkbox" checked={tracks.includes(t.track_key)} disabled={!tracks.includes(t.track_key)&&tracks.length>=3} onChange={()=>toggle(tracks,t.track_key,setTracks)}/><strong>{t.name}</strong><span>{t.description}</span><small>{t.guild_name}</small></label>)}</div>
          {!search&&<button type="button" className="btn" onClick={()=>setShowAll(!showAll)}>{showAll?'收起完整清單':`查看全部 ${view.tracks.length} 個方向`}</button>}
          {search&&!filteredTracks.length&&<p>沒有符合的方向。你仍可在目標欄寫下自己的想法。</p>}
        </fieldset>
        <label className="checkbox-row"><input type="checkbox" required checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>這些是我目前的想法，我確認保存</label>
        <div className="actions"><button type="submit" className="btn btn-primary" disabled={busy||!confirmed}>{busy?'保存中…':'保存合作偏好'}</button><button type="button" onClick={()=>void load()} disabled={busy}>重新載入已保存內容</button></div>
        {error&&<p role="alert">{error}</p>}{saved&&<p role="status">合作偏好已保存。你可以隨時調整。</p>}
      </form>
      {!!view.profile&&view.recommendations.length>0&&<section className="card positioning-next" aria-labelledby="positioning-next"><p className="eyebrow">START SOMETHING</p><h3 id="positioning-next">依合作偏好整理的建議</h3><p>依照你已保存的方向與角色整理；不判定能力，也不影響參與資格。</p>
        <div className="card-grid">{view.recommendations.map(r=><article className="card" key={r.track_key}><h4>{r.name}</h4><p>{r.reason}</p><p>先完成：{r.first_result}</p><p>預估 {r.estimated_minutes} 分鐘 · {r.guild_name}</p>{r.time_note&&<p>{r.time_note}</p>}<div className="actions"><button type="button" className="btn btn-primary" onClick={()=>onNavigate?.(r.module_key)}>開始這個方向</button><button type="button" className="btn" onClick={()=>onNavigate?.('guilds')}>看看職業公會</button></div></article>)}</div>
      </section>}</>}
    </details>
  </section>;
}

export function GuildsPanel({client}:ModulePanelProps) {
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
      <div className="guild-hub-copy"><p className="eyebrow">FIND YOUR GUILD</p><h2 id="guilds-title">職業公會</h2><p>找到一起精進專業的人。可以加入多個公會，再選一個作為主力；每個公會都有自己的技能書。</p><button className="btn btn-ghost" aria-expanded={showApply} aria-controls="guild-application" onClick={()=>setShowApply(!showApply)}>{showApply?'收起創建申請':'申請創建公會'}</button></div>
      <div className="guild-hub-art" aria-hidden="true"><img src="/art/rpg/workshop-hub.webp" alt="" width="1536" height="1024"/><span>FREEDOM / GUILD NETWORK</span></div>
    </header>
    {!loading&&!loadError&&<div className="guild-overview" aria-label="我的公會概況"><div><strong>{guilds.length}</strong><span>職業公會</span></div><div><strong>{joinedCount}</strong><span>已加入公會</span></div><div><strong>{books.length}</strong><span>我的技能書</span></div></div>}
    {loading&&<p role="status">正在載入職業公會…</p>}{loadError&&<div role="alert">{loadError}<button onClick={()=>void load()}>重新載入公會</button></div>}{error&&<p role="alert">{error}</p>}{notice&&<p role="status" className="banner status-note">{notice}</p>}
    {showApply&&<form id="guild-application" className="card stack guild-application" onSubmit={apply}><h3>讓你的專業，也有自己的公會</h3><label className="field">希望成立的公會名稱<input name="name" required minLength={2} maxLength={100}/></label><label className="field">專業／職業領域<input name="profession" required maxLength={120}/></label><label className="field">為什麼想成立？希望一起做什麼？<textarea name="reason" required minLength={10} maxLength={2000}/></label><p className="muted">送出的是創建申請。公會長與公會成立會經後續安排，不會自動授予權限。</p><button className="btn btn-primary" disabled={busy}>送出創建公會申請</button>{applications.map((a,index)=><p key={a.application_id??index}>{a.name} · {a.state==='pending'?'待討論':a.state}</p>)}</form>}
    <div className="card-grid guild-directory">{sortedGuilds.map(g=><article className={`card guild-card${g.is_primary?' primary-guild':g.membership?.state==='active'?' joined-guild':''}`} key={g.guild_key} aria-label={g.name}>
      <div className="guild-card-topline"><span className="guild-orbit" aria-hidden="true"><span/></span>{g.is_primary?<span className="badge">主要公會</span>:g.membership?.state==='active'?<span className="badge">次要公會</span>:<span className="guild-card-kicker">GUILD / 自由工坊</span>}</div>
      <div className="card-head"><h3>{g.name}</h3></div><p className="guild-master">公會長：{guildMasterLabel(g)}</p><p className="guild-purpose">{g.purpose}</p><p className="guild-first-step">可以先做：{g.first_step}</p><small>{typeof g.track_count==='number'?`${g.track_count} 個職業方向 · `:''}公開知識與共同學習免費</small>
      <div className="guild-book-list"><strong>公會技能庫</strong>{g.skill_books.length?g.skill_books.map(book=><SkillBookIntro key={book.book_id} book={book} guildName={g.name} label={book.title}/>):<p className="muted">技能書整理中</p>}</div>
      <div className="actions">{g.membership?.state==='active'&&!g.is_primary&&<button className="btn btn-primary" disabled={busy} onClick={()=>void primary(g)}>設為主要公會</button>}<button type="button" className="btn btn-ghost" disabled={busy||g.is_primary} onClick={()=>void change(g)}>{g.membership?.state==='active'?'退出':'加入'}{g.name}</button></div>{g.is_primary&&<p className="field-hint">若要退出，先將另一個已加入的公會設為主要公會。</p>}
    </article>)}</div>
    <section className="stack guild-bookshelf"><header className="section-heading"><p className="eyebrow">YOUR SKILL LIBRARY</p><h3>我的技能書架</h3><p className="muted">技能書是可以閱讀與 Fork 的專案。Fork 會前往 GitHub，由你登入並確認；不會自動安裝或取得你的帳號權限。</p></header>{books.length?<SkillBooks books={books}/>:<p className="guild-books-empty">加入公會，就能取得第一本技能書。</p>}</section>
  </section>;
}
