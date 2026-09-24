import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { ApiError, type PortalClient } from '../api';
import { BrandPoster, CommunityLinks } from './Community';
import { SkillBookCard, type IntroBook } from './SkillBookIntro';
import { DevelopmentContext } from './DevelopmentContext';
import { CapabilityTree, CustomChoices, type ChoiceCategory } from './CapabilityTree';
import './GuildDesign.css';
import {GuildLeadership} from './GuildLeadership';

export type SkillBook = IntroBook & { book_id:string;fork_url:string|null;guild_keys:string[];granted_at?:string };
export type GuildSummary = { guild_key:string;name:string;purpose:string;first_step:string;track_count:number;guild_master:{user_id?:string;display_name:string;avatar_url?:string|null}|null;guild_experts?:{user_id:string;display_name:string;avatar_url?:string|null}[];guild_master_nominee?:{display_name:string;state:'pending'}|null;is_primary:boolean;is_secondary?:boolean;secondary_position?:number|null;skill_books:SkillBook[];membership:{state:string;aggregate_version:number}|null };
export function guildMasterLabel(guild?:GuildSummary){return guild?.guild_master?.display_name??(guild?.guild_master_nominee?.state==='pending'?`${guild.guild_master_nominee.display_name}（待連結會員帳號）`:'待任命');}
export type OnboardingView = {assessment_update_required?:boolean;current_assessment_version?:string;current_assessment_sha256?:string;required:boolean;completed:boolean;state:'new'|'draft'|'evaluated'|'completed';draft:null|{aggregate_version:number;assessment_version:string;assessment_sha256:string;answers:Record<string,string>;occupation:string;founding_interest:boolean;capabilities:string[];equipment:string[];custom_capabilities?:string[];custom_equipment?:string[];question_notes?:Record<string,string>;featured_capabilities?:string[]};result:null|{recommendations:{guild_key:string;name:string;reason:string;title:string}[]};primary_guild_key:string|null;skill_books:SkillBook[]};
type PendingSave = {kind:'answers'|'evaluate'|'complete';body:unknown;version?:number;key:string;step:number};
type Category = ChoiceCategory;
type Definition = {assessment_version:string;assessment_sha256:string;questions:{id:string;kind:'preference'|'ability';prompt:string;options:{id:string;label:string}[]}[];capability_categories:Category[];equipment_categories:Category[]};
export function SkillBooks({ books, headingLevel }: { books: SkillBook[]; headingLevel?: 2|3|4 }) {
  return <div className="card-grid skill-book-shelf">{books.map(book => <SkillBookCard key={book.id??book.book_id} book={book} headingLevel={headingLevel}/>)}</div>;
}
export function Onboarding({ client, initial, onCompleted, onLogout, optional = false }: {client:PortalClient;initial:OnboardingView;onCompleted:()=>void;onLogout?:()=>void;optional?:boolean}) {
  const [view,setView]=useState(initial), [definition,setDefinition]=useState<Definition|null>(null), [guilds,setGuilds]=useState<GuildSummary[]>([]), [loadError,setLoadError]=useState('');
  const [step,setStep]=useState(initial.state==='evaluated'&&!initial.assessment_update_required?4:0),[answers,setAnswers]=useState<Record<string,string>>(initial.draft?.answers??{}),[occupation,setOccupation]=useState(initial.draft?.occupation??''),[founding,setFounding]=useState(initial.draft?.founding_interest??false),[capabilities,setCapabilities]=useState<string[]>(initial.draft?.capabilities??[]),[equipment,setEquipment]=useState<string[]>(initial.draft?.equipment??[]),[selectedGuilds,setSelectedGuildsState]=useState<string[]>([]),[primary,setPrimaryState]=useState(''),[finished,setFinished]=useState(false);
  const guildChoicesInitialized=useRef(false),guildChoicesRef=useRef<HTMLFieldSetElement>(null);
  const guildHintId=useId();
  // A user's choice wins over a delayed first load or a retry. Programmatic
  // prefill below uses the state setters directly and runs only once.
  const setSelectedGuilds=(values:string[])=>{guildChoicesInitialized.current=true;setSelectedGuildsState(values);};
  const setPrimary=(value:string)=>{guildChoicesInitialized.current=true;setPrimaryState(value);};
  const [customCapabilities,setCustomCapabilities]=useState<string[]>(initial.draft?.custom_capabilities??[]),[customEquipment,setCustomEquipment]=useState<string[]>(initial.draft?.custom_equipment??[]),[questionNotes,setQuestionNotes]=useState<Record<string,string>>(initial.draft?.question_notes??{}),[featured,setFeatured]=useState<string[]>(initial.draft?.featured_capabilities??initial.draft?.capabilities.slice(0,3)??[]);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[retrySave,setRetrySave]=useState<PendingSave|null>(null),[versionConflict,setVersionConflict]=useState(false),[recoveryNotice,setRecoveryNotice]=useState(''),[errorInfo,setErrorInfo]=useState<ApiError|null>(null);
  const requestLock=useRef(false);
  const locked=busy||retrySave!==null;
  const primaryReady=!!primary&&selectedGuilds.includes(primary);
  const guildHint=!selectedGuilds.length?'請先勾選至少一個想加入的公會，再選擇主要公會。':!primaryReady?'還差一步：請選擇主要公會，才能完成定位。':'';
  function focusGuildChoices(){
    const choice=guildChoicesRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if(!choice)return;
    const details=choice.closest('details');if(details)details.open=true;
    choice.scrollIntoView({block:'center'});choice.focus({preventScroll:true});
  }
  async function load(){setLoadError('');try{const [d,g]=await Promise.all([client.get<Definition>('/assessment-definition'),client.get<{items:GuildSummary[]}>('/guilds/directory')]);setDefinition(d);setGuilds(g.items);
    if(optional&&!guildChoicesInitialized.current){
      guildChoicesInitialized.current=true;
      const active=g.items.filter(guild=>guild.membership?.state==='active');
      setSelectedGuildsState(active.map(guild=>guild.guild_key));
      setPrimaryState(active.find(guild=>guild.is_primary)?.guild_key??active.find(guild=>guild.guild_key===initial.primary_guild_key)?.guild_key??'');
    }
  }catch(e){setLoadError(e instanceof Error?e.message:'定位資料暫時無法讀取。');}}
  useEffect(()=>{void load();},[client]);
  const toggle=(values:string[],id:string,set:(v:string[])=>void)=>set(values.includes(id)?values.filter(v=>v!==id):[...values,id]);
  function command(kind:PendingSave['kind'],body:unknown,version=view.draft?.aggregate_version):PendingSave {
    return {kind,body:structuredClone(body),version,key:crypto.randomUUID(),step};
  }
  async function runSave(initialCommand:PendingSave){
    if(requestLock.current)return;
    requestLock.current=true;setBusy(true);setError(null);setErrorInfo(null);setVersionConflict(false);setRecoveryNotice('');
    let request=initialCommand;
    try {
      // The second stage is a distinct command. A lost evaluation response must
      // replay evaluation, never save the answers again with an old version.
      for(;;){
        const result=await client.post<OnboardingView>(`/me/onboarding/${request.kind}`,request.body,{idempotencyKey:request.key,ifMatch:request.version});
        if(!result||!['draft','evaluated','completed'].includes(result.state)||!Number.isInteger(result.draft?.aggregate_version))throw new ApiError({message:'回應未完整收到，尚未確認結果。請重試保存。',status:200,network:true});
        setView(result);
        if(request.kind==='answers'&&request.step===3){request={kind:'evaluate',body:{},version:result.draft?.aggregate_version,key:crypto.randomUUID(),step:3};continue;}
        setRetrySave(null);
        if(request.kind==='complete')setFinished(true);
        else setStep(request.kind==='evaluate'?4:request.step+1);
        window.scrollTo({top:0,behavior:'instant'});break;
      }
    } catch(cause){
      setError(cause instanceof Error?cause.message:'保存暫時無法完成，請重試。');
      setErrorInfo(cause instanceof ApiError?cause:null);
      const unknown=cause instanceof ApiError&&cause.network;
      setRetrySave(unknown?request:null);
      setVersionConflict(!unknown&&cause instanceof ApiError&&(cause.conflict||cause.status===428));
    } finally {requestLock.current=false;setBusy(false);}
  }
  async function next(event:FormEvent){
    event.preventDefault();if(!definition||locked||requestLock.current)return;
    await runSave(command('answers',{assessment_version:definition.assessment_version,assessment_sha256:definition.assessment_sha256,answers,occupation,founding_interest:founding,capabilities,equipment,custom_capabilities:customCapabilities,custom_equipment:customEquipment,question_notes:questionNotes,featured_capabilities:featured}));
  }
  async function finish(){
    if(locked||requestLock.current)return;
    if(!primary||!selectedGuilds.includes(primary)){setError('請加入至少一個公會，並選擇你的主要公會。');return;}
    await runSave(command('complete',{guild_keys:selectedGuilds,primary_guild_key:primary,confirmed:true}));
  }
  async function refreshVersion(){
    if(requestLock.current)return;requestLock.current=true;setBusy(true);
    try {const latest=await client.get<OnboardingView>('/me/onboarding');setView(latest);setError(null);setErrorInfo(null);setVersionConflict(false);setRecoveryNotice('已讀取最新保存版本，本頁答案仍保留。請確認後再次保存。');}
    catch(cause){setError(cause instanceof Error?cause.message:'暫時無法讀取保存版本。');setErrorInfo(cause instanceof ApiError?cause:null);}
    finally{requestLock.current=false;setBusy(false);}
  }
  const steps=['做事偏好','能力情境','認識自己','整理裝備','選擇公會'];
  const chosenQuestions=definition?.questions.filter(q=>q.kind===(step===0?'preference':'ability'))??[];
  const Container = optional ? 'section' : 'main';
  const Heading = optional ? 'h2' : 'h1';
  // Inside the workspace the shell already shows the brand, page guide and community links.
  return <Container className="onboarding-layout guild-onboarding"><header className="onboarding-header">{!optional&&<div className="brand onboarding-brand"><img src="/brand/freedom-workshop.webp" alt="自由工坊" width="1280" height="720"/><p className="eyebrow">FIND YOUR PLACE</p></div>}{onLogout&&<button className="btn btn-ghost" disabled={locked} onClick={onLogout}>登出</button>}{optional&&<button className="btn btn-ghost" disabled={locked} onClick={onCompleted}>返回我的定位</button>}</header>
    {!finished&&<><section className="onboarding-intro"><div className="onboarding-intro-copy"><p className="eyebrow">YOUR FIRST QUEST</p><Heading>每一種專長，都有自己的位置。</Heading><p>回答幾個問題，找到適合的公會，領取第一本技能書。</p><p className="field-hint">{optional?'這次可以重新選擇方向，既有公會與成果都會保留。':'完成定位與加入公會後，就可以開始使用會員工作區。'} 進度會在每一步保存。</p></div><div className="onboarding-route" aria-hidden="true"><span className="direction-orbit"><span>↗</span></span><span>FIND / BUILD / BELONG</span></div></section><ol className="onboarding-progress" aria-label="定位進度">{steps.map((label,index)=><li key={label} aria-current={step===index?'step':undefined} className={step===index?'is-current':step>index?'is-done':''}><span>{step>index?'✓':index+1}</span>{label}</li>)}</ol></>}
    {view.assessment_update_required&&!finished&&<p className="banner banner-info" role="status">定位題目已更新，請檢查原答案並完成新增題目。每一步保存後，就會使用目前這一版題目。</p>}
    {loadError&&<div className="banner banner-error" role="alert">{loadError}<button className="btn btn-ghost" onClick={()=>void load()}>重新載入</button></div>}{error&&<div className="banner banner-error" role="alert"><p>{error}</p>{retrySave&&<><p>目前頁面的答案仍保留，請重試保存。</p><button type="button" className="btn btn-primary" disabled={busy} onClick={()=>void runSave(retrySave)}>{busy?'正在重試…':'重試保存'}</button></>}{versionConflict&&<><p>本頁答案仍保留。先讀取最新版本，再確認保存。</p><button type="button" className="btn btn-ghost" disabled={busy} onClick={()=>void refreshVersion()}>重讀保存版本</button></>}{errorInfo&&<details><summary>問題資訊</summary><p>HTTP：{errorInfo.status||'未收到回應'}{errorInfo.cfRay&&<> · CF-Ray：{errorInfo.cfRay}</>}{errorInfo.requestId&&<> · 工坊請求：{errorInfo.requestId}</>}</p></details>}</div>}{recoveryNotice&&<p role="status" className="banner status-note">{recoveryNotice}</p>}
    {!definition&&!loadError&&<p role="status">正在準備你的定位旅程…</p>}
    {definition&&!finished&&step<4&&<form className="card onboarding-card stack" onSubmit={next}><fieldset disabled={locked} className="stack" style={{border:0,padding:0,margin:0,minWidth:0}} aria-label="定位答案">
      {step===2&&<><p className="eyebrow">03 / ABOUT YOU</p><h2>你從哪裡來，帶著哪些能力？</h2><label className="field">你的職業／目前身分<input value={occupation} onChange={e=>setOccupation(e.target.value)} maxLength={160} placeholder="例如：護理師、餐飲業者、設計師、學生"/></label><label className="checkbox-row"><input type="checkbox" checked={founding} onChange={e=>setFounding(e.target.checked)}/>我有興趣為自己的職業成立專業公會</label><p className="muted">勾選你會做的事；生活經驗也算。還在探索，可以略過。</p><CapabilityTree kind="能力" categories={definition.capability_categories} values={capabilities} onToggle={id=>{toggle(capabilities,id,setCapabilities);if(capabilities.includes(id))setFeatured(featured.filter(value=>value!==id));}}/><CustomChoices kind="能力" values={customCapabilities} onChange={values=>{setCustomCapabilities(values);setFeatured(featured.filter(value=>!value.startsWith('custom:')||values.includes(value.slice(7))));}}/><section className="featured-choice stack"><h3>最想讓夥伴認識的三項能力</h3><p className="field-hint">最多選 3 項放在名片上，其餘收進完整資料。也可以先不選。</p><p role="status">已精選 {featured.length} / 3 項</p><div className="selection-chips">{[...definition.capability_categories.flatMap(category=>category.options).filter(option=>capabilities.includes(option.id)),...customCapabilities.map(label=>({id:`custom:${label}`,label}))].map(option=><label className={featured.includes(option.id)?'selection-chip selected':'selection-chip'} key={option.id}><input type="checkbox" aria-label={`精選能力：${option.label}`} checked={featured.includes(option.id)} disabled={!featured.includes(option.id)&&featured.length>=3} onChange={()=>toggle(featured,option.id,setFeatured)}/>{option.label}</label>)}</div>{!capabilities.length&&!customCapabilities.length&&<p className="muted">選擇能力後，就能在這裡挑選名片上的重點。</p>}</section></>}
      {step===3&&<><p className="eyebrow">04 / YOUR EQUIPMENT</p><h2>你的裝備庫</h2><p className="muted">裝備就是你能使用的工具或訂閱。只勾名稱，不填密碼或金鑰；也可以略過。</p><CapabilityTree kind="裝備" categories={definition.equipment_categories} values={equipment} onToggle={id=>toggle(equipment,id,setEquipment)}/><CustomChoices kind="裝備" values={customEquipment} onChange={setCustomEquipment}/></>}
      {(step===0||step===1)&&<><p className="eyebrow">{step===0?'01 / YOUR WORK STYLE':'02 / EVERYDAY PRACTICE'}</p><h2>{step===0?'你喜歡怎麼做事？':'遇到這些情境，你會怎麼做？'}</h2><p className="muted">{step===0?'選最接近你的答案，不必選看起來最厲害的。':'這些小情境幫你找到適合練習的方向；不是資格認證，也不是心理診斷。'}</p>{chosenQuestions.map((question,index)=><fieldset key={question.id} className="quiz-question"><legend><span>{String(index+1).padStart(2,'0')}</span>{question.prompt}</legend><div className="quiz-options">{question.options.map(option=><label className={`quiz-option${answers[question.id]===option.id?' selected':''}`} key={option.id}><input type="radio" name={question.id} value={option.id} required checked={answers[question.id]===option.id} onChange={()=>setAnswers({...answers,[question.id]:option.id})}/>{option.label}</label>)}</div><details className="question-note"><summary>補充自己的想法（選填）</summary><label className="field">這一題的補充<textarea maxLength={500} value={questionNotes[question.id]??''} onChange={event=>setQuestionNotes({...questionNotes,[question.id]:event.target.value})}/></label><p className="field-hint">最多 500 字。只保留在你的定位資料，不公開，也不影響推薦分數。</p></details></fieldset>)}</>}
      <div className="onboarding-actions">{step>0&&<button className="btn btn-ghost" type="button" disabled={busy} onClick={()=>setStep(step-1)}>上一步</button>}<button className="btn btn-primary" disabled={busy}>{busy?'正在保存…':step===3?'看看適合我的公會':'保存，繼續下一步 →'}</button></div>
    </fieldset></form>}
    {!finished&&step===4&&<fieldset ref={guildChoicesRef} disabled={locked} className="stack" style={{border:0,padding:0,margin:0,minWidth:0}} aria-label="選擇公會"><header className="section-heading"><p className="eyebrow">YOUR NEXT CHAPTER</p><h2>找到同路人，開始一起做事。</h2><p>這些公會適合你先試試。可以加入多個，再選一個作為主力。</p></header><div className="recommendation-grid">{view.result?.recommendations.map((r,index)=>({...r,recommendationIndex:index})).sort((a,b)=>Number(b.guild_key===primary)-Number(a.guild_key===primary)||Number(selectedGuilds.includes(b.guild_key))-Number(selectedGuilds.includes(a.guild_key))).map((r)=><article className={`card recommendation-card ${selectedGuilds.includes(r.guild_key)?'selected':''}`} key={r.guild_key}><div className="recommendation-emblem" aria-hidden="true"><span className="guild-orbit"><span/></span></div><p className="eyebrow">{r.recommendationIndex===0?'推薦你先加入':'你也可以加入'}</p><h3>{r.name}</h3><span className="positioning-title">{r.title}</span><p>{r.reason}</p><GuildLeadership masterName={guildMasterLabel(guilds.find(g=>g.guild_key===r.guild_key))} masterId={guilds.find(g=>g.guild_key===r.guild_key)?.guild_master?.user_id} masterAvatarUrl={guilds.find(g=>g.guild_key===r.guild_key)?.guild_master?.avatar_url} experts={guilds.find(g=>g.guild_key===r.guild_key)?.guild_experts}/><label className="checkbox-row"><input type="checkbox" checked={selectedGuilds.includes(r.guild_key)} onChange={()=>{toggle(selectedGuilds,r.guild_key,setSelectedGuilds);if(primary===r.guild_key)setPrimary('');}}/>加入{r.name}</label>{selectedGuilds.includes(r.guild_key)&&<label className="checkbox-row"><input type="radio" name="primary-guild" checked={primary===r.guild_key} onChange={()=>setPrimary(r.guild_key)}/>設為主要公會</label>}</article>)}</div><details className="card other-guild-choices"><summary>查看其他公會，自行選擇</summary><div className="stack">{guilds.filter(g=>!view.result?.recommendations.some(r=>r.guild_key===g.guild_key)).sort((a,b)=>Number(b.guild_key===primary)-Number(a.guild_key===primary)||Number(selectedGuilds.includes(b.guild_key))-Number(selectedGuilds.includes(a.guild_key))).map(g=><div key={g.guild_key}><label className="checkbox-row"><input type="checkbox" checked={selectedGuilds.includes(g.guild_key)} onChange={()=>{toggle(selectedGuilds,g.guild_key,setSelectedGuilds);if(primary===g.guild_key)setPrimary('');}}/>{g.name}</label>{selectedGuilds.includes(g.guild_key)&&<label className="checkbox-row"><input type="radio" name="primary-guild" checked={primary===g.guild_key} onChange={()=>setPrimary(g.guild_key)}/>以{g.name}作為主要公會</label>}</div>)}</div></details><div className="card stack onboarding-confirmation">
      <p>將加入 {selectedGuilds.length} 個公會。</p>
      <div id={guildHintId} role="status" className="onboarding-guild-hint">{guildHint}</div>
      {selectedGuilds.length>0?<label className="field">主要公會（必選）<select required value={primary} aria-describedby={guildHint?guildHintId:undefined} onChange={event=>setPrimary(event.target.value)}><option value="">請選擇主要公會</option>{selectedGuilds.map(key=><option key={key} value={key}>{guilds.find(g=>g.guild_key===key)?.name??view.result?.recommendations.find(g=>g.guild_key===key)?.name??'已選公會'}</option>)}</select></label>:<button type="button" className="btn btn-ghost" onClick={focusGuildChoices}>前往選擇公會</button>}
      <p className="muted">加入後，對應的技能書會立即放進你的書架。你仍可在之後調整主要公會。</p><div className="actions"><button className="btn btn-ghost" disabled={busy} onClick={()=>setStep(0)}>調整我的答案</button><button className="btn btn-primary" disabled={busy||!primaryReady} aria-describedby={guildHint?guildHintId:undefined} onClick={()=>void finish()}>{busy?'正在加入…':'確認加入公會，領取技能書'}</button></div></div></fieldset>}
    {finished&&<section className="stack"><BrandPoster compact/><header className="section-heading"><p className="eyebrow">WELCOME TO FREEDOM WORKSHOP</p><Heading>你的第一段旅程，現在開始。</Heading><p>已加入公會；主要公會是 <strong>{guilds.find(g=>g.guild_key===view.primary_guild_key)?.name}</strong>。以下技能書已加入你的書架。</p></header><SkillBooks books={view.skill_books} headingLevel={optional?3:2}/><p className="field-hint">先讀技能書介紹。想自己修改時，再點 Fork，複製到自己的 GitHub。</p><button className="btn btn-primary" onClick={onCompleted}>進入自由工坊 →</button></section>}
    {!optional&&<><DevelopmentContext moduleId="onboarding"/><CommunityLinks/></>}
  </Container>;
}
