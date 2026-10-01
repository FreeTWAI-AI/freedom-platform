import { useCallback,useEffect,useRef,useState,type FormEvent } from 'react';
import { useModuleMutation,type ModulePanelProps } from './shared';
import { SkillBookIntro } from './SkillBookIntro';
import { Onboarding, guildMasterLabel, type GuildSummary, type OnboardingView } from './Onboarding';
import { loadLabels, type MemberCardData } from './Membership';
import './GuildDesign.css';
import {GuildCard,useUniformGuildCards} from './GuildCard';
import {GuildAnswersSection} from './GuildQuestions';
import {GuildTopicFilter} from './GuildFilters';
import {formatIsoLocal} from '../format';
import type {GuildTopic} from '../../../../packages/shared/guild-topics';

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
  return <section className="module-panel positioning-panel" aria-label="定位結果">
    {summaryLoading&&<p role="status">正在載入你的定位結果…</p>}
    {summaryError&&<div className="banner banner-error" role="alert"><p>定位結果暫時無法載入：{summaryError}</p><button type="button" className="btn btn-ghost" onClick={()=>void loadSummary()}>重新載入定位結果</button></div>}
    {!summaryLoading&&!summaryError&&assessment&&member&&<section className="card positioning-result" aria-labelledby="positioning-result-title">
      <div className="positioning-result-heading"><h2 id="positioning-result-title">我的定位結果</h2>{assessment.completed&&<span className="badge">{assessment.entry_mode==='quick'?'已選擇公會':'已完成定位'}</span>}</div>
      {member.positioning_title&&<p className="positioning-result-role">{member.positioning_title}</p>}
      <dl className="positioning-result-guilds"><div><dt>主要公會</dt><dd>{member.primary_guild?.name??'尚未選擇'}</dd></div><div><dt>次要公會</dt><dd>{member.secondary_guilds.map(g=>g.name).join('、')||'先專注在主要公會'}</dd></div></dl>
      {featuredLabels.length>0&&<div className="positioning-featured"><h3>擅長的能力</h3><div className="tag-list">{featuredLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>)}</div></div>}
      <div className="positioning-result-next"><div className="actions"><button type="button" className="btn btn-primary" onClick={()=>onNavigate?.('guilds')}>前往我的公會</button>{firstBook&&<SkillBookIntro book={firstBook} guildName={firstBook.guild_keys.includes(member.primary_guild?.guild_key??'')?member.primary_guild?.name:undefined} label="閱讀我的技能書"/>}</div></div>
      <div className="positioning-result-adjust"><button type="button" className="btn btn-ghost" onClick={()=>setRetaking(true)}>{assessment.entry_mode==='quick'?'補充／繼續探索定位':assessment.completed?'重新探索定位':'開始探索我的定位'}</button>{assessment.completed&&assessment.entry_mode!=='quick'&&assessment.state!=='completed'&&<p className="field-hint">調整中的草稿尚未取代這份已確認的定位。</p>}</div>
      <details className="positioning-result-skills"><summary>我的能力與裝備 · {abilityLabels.length} 項能力／{equipmentLabels.length} 項裝備</summary><div><section><h3>我的能力</h3><div className="tag-list">{abilityLabels.length?abilityLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>):<p className="muted">可以隨時補充，也可以先開始閱讀技能書。</p>}</div></section><section><h3>我的裝備</h3><div className="tag-list">{equipmentLabels.length?equipmentLabels.map((label,index)=><span className="pill" key={`${index}-${label}`}>{label}</span>):<p className="muted">尚未填寫裝備，不影響參與公會。</p>}</div></section></div></details>
    </section>}
    <GuildAnswersSection client={client}/>
  </section>;
}

type GuildPreferences={primary_guild_key:string|null;secondary_guild_keys?:string[];aggregate_version?:number};
type GuildApplication={application_id:string;name:string;profession:string;reason:string;state:string;created_at:string;reviewed_at:string|null;review_reason:string|null;approved_guild_key:string|null;approved_guild_name:string|null};
const applicationStatus:Record<string,string>={pending:'待審核',approved:'已通過',declined:'未通過'};

export function GuildsPanel({client,onNavigate}:ModulePanelProps) {
  const [query,setQuery]=useState(''),[scope,setScope]=useState<'all'|'joined'>('all'),[topic,setTopic]=useState<GuildTopic|''>('');
  const [guilds,setGuilds]=useState<GuildSummary[]>([]),[loading,setLoading]=useState(true),[loadError,setLoadError]=useState<string|null>(null),[notice,setNotice]=useState(''),[answerGuild,setAnswerGuild]=useState('');
  const [preferences,setPreferences]=useState<GuildPreferences|null>(null),[editing,setEditing]=useState(false),[secondaryDraft,setSecondaryDraft]=useState<string[]>([]);
  const [applications,setApplications]=useState<GuildApplication[]>([]),[showApply,setShowApply]=useState(false),[showAllApplications,setShowAllApplications]=useState(false);
  const [draft,setDraft]=useState({name:'',profession:'',reason:''}),[applicationSuccess,setApplicationSuccess]=useState(''),[focusDraft,setFocusDraft]=useState(false),[focusGuild,setFocusGuild]=useState<string|null>(null);
  const generation=useRef(0),successRef=useRef<HTMLParagraphElement>(null),nameRef=useRef<HTMLInputElement>(null);
  const {mutate,busy,error,setError}=useModuleMutation(client);
  const load=useCallback(async()=>{
    const sequence=++generation.current;setLoading(true);setLoadError(null);setError(null);
    try{
      const [g,p,a]=await Promise.all([client.get<{items:GuildSummary[]}>('/guilds/directory'),client.get<GuildPreferences>('/me/guild-preferences'),client.get<{items:GuildApplication[]}>('/guild-applications')]);
      if(sequence===generation.current){setGuilds(g.items);setPreferences(p);setApplications(a.items);}
    }catch(e){if(sequence===generation.current)setLoadError(failure(e));}
    finally{if(sequence===generation.current)setLoading(false);}
  },[client,setError]);
  useEffect(()=>{void load();return()=>{generation.current++;};},[load]);
  useEffect(()=>{if(applicationSuccess)successRef.current?.focus();},[applicationSuccess]);
  useEffect(()=>{if(showApply&&focusDraft){nameRef.current?.focus();setFocusDraft(false);}},[showApply,focusDraft]);
  useEffect(()=>{
    if(!focusGuild||loading)return;
    const card=document.querySelector<HTMLElement>(`[data-guild-key="${CSS.escape(focusGuild)}"]`);
    if(!card)return;
    card.focus();card.scrollIntoView({block:'nearest'});setFocusGuild(null);
  },[focusGuild,loading,guilds,query,scope,topic]);
  function announce(message:string,guildName=''){setApplicationSuccess('');setNotice(message);setAnswerGuild(guildName);}
  async function change(g:GuildSummary){
    setApplicationSuccess('');
    const joining=g.membership?.state!=='active';setNotice('');setAnswerGuild('');
    const result=await mutate(`/guilds/${g.guild_key}/${joining?'join':'leave'}`,{},g.membership?.aggregate_version);
    if(result){setEditing(false);announce(joining?`已加入${g.name}，技能書已解鎖。`:`已退出${g.name}，已解鎖的技能書保留。`,joining?g.name:'');await load();window.dispatchEvent(new Event('freedom-profile-updated'));}
  }
  async function primary(g:GuildSummary){setApplicationSuccess('');const result=await mutate(`/guilds/${g.guild_key}/primary`,{},preferences?.aggregate_version);if(result){setEditing(false);announce(`主要公會已設為${g.name}。`);await load();window.dispatchEvent(new Event('freedom-profile-updated'));}}
  async function saveSecondary(event:FormEvent){event.preventDefault();setApplicationSuccess('');const result=await mutate('/me/guild-preferences/secondary',{secondary_guild_keys:secondaryDraft},preferences?.aggregate_version);if(result){setEditing(false);announce('次要公會已儲存。');await load();window.dispatchEvent(new Event('freedom-profile-updated'));}}
  async function apply(event:FormEvent<HTMLFormElement>){
    event.preventDefault();setApplicationSuccess('');
    const submitted={name:draft.name.trim(),profession:draft.profession.trim(),reason:draft.reason.trim()};
    const result=await mutate('/guild-applications',submitted);
    if(result){setDraft({name:'',profession:'',reason:''});setShowApply(false);setApplicationSuccess(`謝謝你的申請！「${submitted.name}」已送出，正在審核中。審核結果會通知你，也可以在下方「我的公會申請」查看進度。`);await load();}
  }
  function openApply(){if(showApply){setShowApply(false);return;}setApplicationSuccess('');setDraft({name:'',profession:'',reason:''});setShowApply(true);}
  function revise(application:GuildApplication){setApplicationSuccess('');setDraft({name:application.name,profession:application.profession,reason:application.reason});setShowApply(true);setFocusDraft(true);}
  function viewGuild(guild:GuildSummary){setScope('all');setTopic('');setQuery(guild.name);setFocusGuild(guild.guild_key);}
  // Preferences are authoritative. Directory flags are only a compatibility
  // fallback; active membership is still required for either featured role.
  const primaryKey=preferences?preferences.primary_guild_key:guilds.find(g=>g.is_primary)?.guild_key;
  const secondaryKeys=(preferences?.secondary_guild_keys??guilds.filter(g=>g.is_secondary).sort((a,b)=>(a.secondary_position??0)-(b.secondary_position??0)).map(g=>g.guild_key)).filter((key,index,keys)=>key!==primaryKey&&keys.indexOf(key)===index&&guilds.some(g=>g.guild_key===key&&g.membership?.state==='active')).slice(0,2);
  const classified=guilds.map(g=>({...g,is_primary:g.guild_key===primaryKey&&g.membership?.state==='active',is_secondary:secondaryKeys.includes(g.guild_key)}));
  const search=query.trim().toLocaleLowerCase();
  const visible=classified.filter(g=>(scope==='all'||g.membership?.state==='active')&&(!topic||g.tags?.includes(topic))&&(!search||[g.name,g.purpose,guildMasterLabel(g),...(g.guild_experts??[]).map(expert=>expert.display_name),...g.skill_books.map(book=>book.title)].join(' ').toLocaleLowerCase().includes(search)));
  const groups=[
    {key:'featured',title:'主要與次要公會',items:visible.filter(g=>g.is_primary||g.is_secondary).sort((a,b)=>(a.is_primary?-1:secondaryKeys.indexOf(a.guild_key))-(b.is_primary?-1:secondaryKeys.indexOf(b.guild_key)))},
    {key:'joined',title:'其他已加入公會',items:visible.filter(g=>g.membership?.state==='active'&&!g.is_primary&&!g.is_secondary)},
    {key:'unjoined',title:'未加入公會',items:visible.filter(g=>g.membership?.state!=='active')},
  ];
  const layoutKey=JSON.stringify([loading,loadError,groups.map(group=>group.items.map(g=>g.guild_key))]);
  const cardsRoot=useUniformGuildCards(layoutKey);
  const joinedCount=guilds.filter(g=>g.membership?.state==='active').length;
  const visibleApplications=showAllApplications?applications:applications.slice(0,3);
  async function toggleSecondary(g:GuildSummary){
    const removing=secondaryKeys.includes(g.guild_key);
    if(!removing&&secondaryKeys.length>=2)return;
    setApplicationSuccess('');
    const next=removing?secondaryKeys.filter(key=>key!==g.guild_key):[...secondaryKeys,g.guild_key];
    const result=await mutate('/me/guild-preferences/secondary',{secondary_guild_keys:next},preferences?.aggregate_version);
    if(result){setEditing(false);announce(removing?`已取消${g.name}的次要公會。`:`已將${g.name}設為次要公會。`);await load();window.dispatchEvent(new Event('freedom-profile-updated'));}
  }
  return <section className="module-panel guilds-panel" aria-label="公會目錄">
    <header className="guild-hub-heading">
      {!loading&&!loadError&&<p className="guild-overview" aria-label="我的公會概況"><span>已加入 <strong>{joinedCount}</strong> 個公會</span><span>共 {guilds.length} 個公會</span></p>}
      <div className="actions"><button type="button" className="btn btn-ghost" onClick={()=>onNavigate?.('skills')}>前往技能書架</button><button type="button" className="btn btn-ghost" aria-expanded={showApply} aria-controls="guild-application" onClick={openApply}>{showApply?'收起創建申請':'申請創建公會'}</button></div>
    </header>
    {applicationSuccess&&<p ref={successRef} role="status" tabIndex={-1} className="banner status-note">{applicationSuccess}</p>}
    {notice&&<div role="status" className="banner status-note guild-join-notice"><span>{notice}</span>{answerGuild&&<button type="button" className="btn btn-ghost" onClick={()=>onNavigate?.('positioning')}>回答{answerGuild}的小問題</button>}</div>}
    {loadError&&<div className="banner banner-error" role="alert"><p>{loadError}</p><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重新載入公會</button></div>}
    {error&&<div className="banner banner-error" role="alert"><p>{error}</p><button className="btn btn-ghost" disabled={busy} onClick={()=>{setEditing(false);void load();}}>重新載入公會</button></div>}
    {showApply&&<form id="guild-application" className="card stack guild-application" onSubmit={apply}><h2>申請創建公會</h2><label className="field">希望成立的公會名稱<input ref={nameRef} name="name" required minLength={2} maxLength={100} value={draft.name} onChange={event=>setDraft({...draft,name:event.target.value})}/></label><label className="field">專業／職業領域<input name="profession" required maxLength={160} value={draft.profession} onChange={event=>setDraft({...draft,profession:event.target.value})}/></label><label className="field">為什麼想成立？希望一起做什麼？<textarea name="reason" required minLength={10} maxLength={2000} value={draft.reason} onChange={event=>setDraft({...draft,reason:event.target.value})}/></label><p className="muted">由管理員確認成立與公會長人選。</p><button className="btn btn-primary" disabled={busy}>送出創建公會申請</button></form>}
    {applications.length>0&&<section className="guild-application-section" aria-labelledby="guild-applications-heading"><h2 id="guild-applications-heading">我的公會申請</h2><div className="guild-application-list">{visibleApplications.map(application=>{
      const listed=guilds.find(guild=>guild.guild_key===application.approved_guild_key);
      const status=application.state==='pending'||application.state==='approved'||application.state==='declined'?application.state:'unknown';
      return <article className="guild-application-item" key={application.application_id} aria-label={application.name}>
        <div className="guild-application-head"><h3>{application.name}</h3><span className={`guild-application-status is-${status}`}>{applicationStatus[application.state]??'狀態待確認'}</span></div>
        <p className="guild-application-meta">專業：{application.profession}</p>
        <p className="guild-application-meta">送出時間：{formatIsoLocal(application.created_at)}</p>
        {application.reviewed_at&&<p className="guild-application-meta">審核時間：{formatIsoLocal(application.reviewed_at)}</p>}
        {application.state!=='pending'&&application.review_reason&&<p>審查說明：{application.review_reason}</p>}
        {application.state==='pending'&&<p className="field-hint">管理員審核後會通知你。</p>}
        {application.state==='approved'&&(listed?<button type="button" className="btn btn-ghost" onClick={()=>viewGuild(listed)}>查看公會</button>:<p className="guild-application-meta">{application.approved_guild_name}</p>)}
        {application.state==='declined'&&<><p className="field-hint">可依審查說明調整後重新申請。</p><button type="button" className="btn btn-ghost" onClick={()=>revise(application)}>修改後重新申請</button></>}
      </article>;
    })}</div>{applications.length>3&&<button type="button" className="btn btn-ghost" aria-expanded={showAllApplications} onClick={()=>setShowAllApplications(value=>!value)}>{showAllApplications?'收合':`顯示全部 ${applications.length} 件申請`}</button>}</section>}
    <div className="guild-directory-tools">
      <label className="field">搜尋公會<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="名稱、專業、會長或技能書" maxLength={100}/></label>
      <div className="guild-scope" role="group" aria-label="公會範圍"><button type="button" className="btn btn-ghost" aria-pressed={scope==='all'} onClick={()=>setScope('all')}>全部公會</button><button type="button" className="btn btn-ghost" aria-pressed={scope==='joined'} onClick={()=>setScope('joined')}>已加入</button></div>
    </div>
    <GuildTopicFilter value={topic} onChange={setTopic}/>
    {loading&&<p role="status">正在載入職業公會…</p>}
    {!loading&&!loadError&&<>
      <div className="guild-secondary-toolbar"><button type="button" className="btn btn-ghost" aria-expanded={editing} aria-controls="secondary-guild-editor" disabled={busy} onClick={()=>{setSecondaryDraft(secondaryKeys);setEditing(!editing);}}>設定次要公會</button><span className="muted">主要 1 個・次要最多 2 個</span></div>
      {editing&&<form id="secondary-guild-editor" className="card guild-secondary-editor" onSubmit={saveSecondary}><fieldset disabled={busy}><legend>選擇次要公會 · {secondaryDraft.length} / 2</legend><div className="guild-secondary-choices">{classified.filter(g=>g.membership?.state==='active'&&!g.is_primary).map(g=><label key={g.guild_key} className="checkbox-row"><input type="checkbox" checked={secondaryDraft.includes(g.guild_key)} disabled={!secondaryDraft.includes(g.guild_key)&&secondaryDraft.length>=2} onChange={event=>setSecondaryDraft(current=>event.target.checked?[...current,g.guild_key]:current.filter(key=>key!==g.guild_key))}/>{g.name}{secondaryDraft.includes(g.guild_key)&&<span className="muted">次要 {secondaryDraft.indexOf(g.guild_key)+1}</span>}</label>)}</div>{joinedCount<2&&<p>先加入另一個公會，再設為次要公會。</p>}</fieldset><div className="actions"><button className="btn btn-primary" disabled={busy}>儲存次要公會</button><button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>setEditing(false)}>取消</button></div></form>}
      <div ref={cardsRoot} className="guild-groups">{groups.filter(group=>scope==='all'||group.key!=='unjoined').map(group=><section key={group.key} className="guild-group" aria-label={group.title}><header className="guild-group-heading"><h2>{group.title}</h2><span className="muted">{group.items.length}</span></header>{group.items.length?<div className="card-grid guild-directory">{group.items.map(g=><GuildCard key={g.guild_key} guild={g} client={client} busy={busy} onPrimary={()=>void primary(g)} onSecondary={()=>void toggleSecondary(g)} secondaryFull={secondaryKeys.length>=2} onMembership={()=>void change(g)}/>)}</div>:<p className="muted">{search?'沒有符合的公會。':group.key==='featured'?'加入公會後，設定主要與次要公會。':group.key==='joined'?'沒有其他已加入公會。':'所有公會都已加入。'}</p>}</section>)}</div>
    </>}
  </section>;
}
