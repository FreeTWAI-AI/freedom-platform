import {useCallback,useEffect,useLayoutEffect,useRef,useState,type ReactNode} from 'react';
import type {PortalClient} from '../api';
import type {TabId} from '../types';
import {useGitHubSocialStore} from './GitHubSocial';
import type {GuildSummary,OnboardingView} from './Onboarding';
import './MemberSettings.css';

type TaskState='loading'|'error'|'unavailable'|'todo'|'done';
const stateLabels:Record<TaskState,string>={loading:'讀取中',error:'狀態讀取失敗',unavailable:'尚未啟用',todo:'待完成',done:'已完成'};

type Onboarding={completed:boolean;primaryGuildKey:string|null;bookCount:number};
type Guild={key:string;name:string;active:boolean};
type Sources={onboarding:Onboarding;directory:Guild[];avatar:boolean;social:number};
type SourceId=keyof Sources;
type Source<T>={value?:T;loading:boolean;error:string};
const SOURCE_IDS:SourceId[]=['onboarding','directory','avatar','social'];
const fail=(cause:unknown)=>cause instanceof Error&&cause.message?cause.message:'暫時無法讀取，請稍後重試。';
const malformed=()=>Error('回傳的資料不完整，暫時無法確認。');
const isRecord=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null;

/** Each reader returns only facts the API actually stated; missing fields are errors, never "not done". */
const readers:{[K in SourceId]:[string,(value:unknown)=>Sources[K]]}={
  onboarding:['/me/onboarding',value=>{
    const view=value as Partial<OnboardingView>;
    if(!isRecord(view)||typeof view.completed!=='boolean'||!Array.isArray(view.skill_books)||!(view.primary_guild_key===null||typeof view.primary_guild_key==='string'))throw malformed();
    return {completed:view.completed,primaryGuildKey:view.primary_guild_key||null,bookCount:view.skill_books.length};
  }],
  directory:['/guilds/directory',value=>{
    const items=isRecord(value)?value.items:undefined;if(!Array.isArray(items))throw malformed();
    return (items as Partial<GuildSummary>[]).map(item=>{
      if(!isRecord(item)||typeof item.guild_key!=='string'||!(item.membership===null||isRecord(item.membership)))throw malformed();
      return {key:item.guild_key,name:typeof item.name==='string'?item.name:item.guild_key,active:item.membership?.state==='active'};
    });
  }],
  avatar:['/me/account',value=>{
    const avatar=isRecord(value)?value.avatar:undefined;
    if(!isRecord(avatar)||!(avatar.avatar_url===null||typeof avatar.avatar_url==='string'))throw malformed();
    return Boolean(avatar.avatar_url);
  }],
  social:['/me/social-links?limit=1&offset=0',value=>{
    if(!isRecord(value)||!Array.isArray(value.items))throw malformed();
    const items=value.items;
    return typeof value.total==='number'&&value.total>=items.length?value.total:items.length;
  }],
};

type Card={key:string;required:boolean;title:string;state:TaskState;body:ReactNode;action?:ReactNode;error?:string;retry?:{label:string;busy:boolean;run:()=>void}};
const loadingCard=(text:string)=>({state:'loading' as const,body:<p>{text}</p>});
const rank=(state:TaskState)=>state==='done'?1:0;

/** Completion is derived from the member's real records; nothing here can be ticked by hand. */
export function MemberTasks({client,onNavigate}:{client:PortalClient;onNavigate:(id:TabId)=>void}){
  const store=useGitHubSocialStore();
  const [busy,setBusy]=useState(false),[connectError,setConnectError]=useState('');
  const [sources,setSources]=useState<{[K in SourceId]:Source<Sources[K]>}>(()=>({onboarding:{loading:true,error:''},directory:{loading:true,error:''},avatar:{loading:true,error:''},social:{loading:true,error:''}}));
  const generations=useRef<Record<SourceId,number>>({onboarding:0,directory:0,avatar:0,social:0});
  const mounted=useRef(true);
  const sectionRef=useRef<HTMLDivElement>(null),lastFocus=useRef<{element:HTMLElement;task:string}|null>(null);

  const load=useCallback((id:SourceId)=>{
    const generation=++generations.current[id];
    // A re-read is unknown until it answers: never keep showing an older "done".
    setSources(current=>({...current,[id]:{loading:true,error:''}}));
    const [path,read]=readers[id];
    const settle=(next:Source<unknown>)=>{if(mounted.current&&generation===generations.current[id])setSources(current=>({...current,[id]:next}));};
    client.get<unknown>(path).then(value=>{
      try{settle({value:read(value),loading:false,error:''});}catch(cause){settle({loading:false,error:fail(cause)});}
    },cause=>settle({loading:false,error:fail(cause)}));
  },[client]);

  useEffect(()=>{
    mounted.current=true;
    const all=()=>SOURCE_IDS.forEach(load);
    const refresh=()=>{all();void store.refreshConnection();};
    all();void store.loadAccount();
    window.addEventListener('focus',refresh);window.addEventListener('freedom-profile-updated',refresh);
    return()=>{mounted.current=false;window.removeEventListener('focus',refresh);window.removeEventListener('freedom-profile-updated',refresh);};
  },[load,store]);

  // Cards re-order and swap their buttons as states change; keep keyboard focus in the same card.
  useLayoutEffect(()=>{
    const last=lastFocus.current,section=sectionRef.current;
    if(!last||!section||document.activeElement&&document.activeElement!==document.body)return;
    const card=section.querySelector<HTMLElement>(`[data-task="${last.task}"]`);
    const target=last.element.isConnected&&!(last.element as HTMLButtonElement).disabled?last.element:card;
    target?.focus({preventScroll:true});
  });
  const tracked=(event:React.FocusEvent<HTMLDivElement>)=>{
    const task=(event.target as HTMLElement).closest<HTMLElement>('[data-task]')?.dataset.task;
    lastFocus.current=task?{element:event.target as HTMLElement,task}:null;
  };
  const left=(event:React.FocusEvent<HTMLDivElement>)=>{
    if(event.relatedTarget&&!event.currentTarget.contains(event.relatedTarget as Node))lastFocus.current=null;
  };

  async function connect(){
    setBusy(true);setConnectError('');
    try{window.location.assign(await store.connect('#todos'));}
    catch(cause){setConnectError(cause instanceof Error?cause.message:'無法連結 GitHub，請重試。');setBusy(false);}
  }
  const go=(tab:TabId,label:string,primary:boolean)=><button className={`btn ${primary?'btn-primary':'btn-ghost'}`} type="button" onClick={()=>onNavigate(tab)}>{label}</button>;
  const retrying=(ids:SourceId[],label:string)=>{
    const failed=ids.filter(id=>sources[id].error);
    return {label,busy:ids.some(id=>sources[id].loading),run:()=>failed.forEach(load)};
  };

  const {onboarding,directory,avatar,social}=sources;
  const cards:Card[]=[];

  // Positioning: only the recorded completion counts; a legacy exemption from the gate is not completion.
  cards.push({key:'onboarding',required:true,title:'完成定位',
    ...(onboarding.error?{state:'error',body:null,error:onboarding.error,retry:retrying(['onboarding'],'重新讀取定位狀態')}
      :!onboarding.value?loadingCard('正在確認定位進度…')
      :onboarding.value.completed?{state:'done',body:<p>定位已完成，可隨時重新探索。</p>,action:go('positioning','查看我的定位',false)}
      :{state:'todo',body:<p>完成定位問答，找到適合你的公會方向。</p>,action:go('positioning','前往我的定位',true)})});

  // Primary guild: the chosen key must be a guild the member is actively in right now.
  const primaryKey=onboarding.value?.primaryGuildKey,primary=primaryKey?directory.value?.find(guild=>guild.key===primaryKey):undefined;
  const primaryDeps:SourceId[]=primaryKey===null?['onboarding']:['onboarding','directory'];
  const primaryError=primaryDeps.map(id=>sources[id].error).find(Boolean);
  cards.push({key:'primary-guild',required:true,title:'設定主要公會',
    ...(primaryError?{state:'error',body:null,error:primaryError,retry:retrying(primaryDeps,'重新讀取主要公會狀態')}
      :!onboarding.value||primaryKey&&!directory.value?loadingCard('正在確認主要公會…')
      :primary?.active?{state:'done',body:<p>主要公會：<strong>{primary.name}</strong>。</p>,action:go('guilds','查看職業公會',false)}
      :{state:'todo',body:<p>{primaryKey?'目前的主要公會不在已加入狀態，請重新選一個已加入的公會。':'加入公會後，選一個作為主要公會。'}</p>,action:go('guilds','前往職業公會',true)})});

  // GitHub keeps its original wording and flow; OAuth only starts from the member's own click.
  const github=store.account;
  const githubState:TaskState=github.error?'error':!github.value?'loading':github.value.connected?'done':github.value.configured?'todo':'unavailable';
  const githubRetry={label:'重新讀取 GitHub 連結',busy:github.loading||busy,run:()=>{setConnectError('');void store.refreshConnection();}};
  cards.push({key:'github',required:true,title:'連結 GitHub',state:githubState,
    ...(githubState==='loading'?{body:<p>正在確認 GitHub 連結…</p>}
      :githubState==='error'?{body:null,error:github.error,retry:githubRetry}
      :githubState==='unavailable'?{body:<p>GitHub 連結目前尚未啟用，這項待辦暫時無法完成；啟用後即可連結。</p>,retry:githubRetry}
      :githubState==='todo'?{body:<p>連結你的 GitHub，管理技能書按星與開發授權。</p>,action:<button className="btn btn-primary" type="button" disabled={busy||github.loading} onClick={()=>void connect()}>{busy?'前往 GitHub…':'連結 GitHub'}</button>}
      :{body:<p>已連結 <strong>@{github.value?.github_user?.login??'GitHub'}</strong>。</p>,action:go('account','到我的名片管理 GitHub 連結',false)})});

  cards.push({key:'avatar',required:false,title:'上傳頭像',
    ...(avatar.error?{state:'error',body:null,error:avatar.error,retry:retrying(['avatar'],'重新讀取頭像狀態')}
      :avatar.value===undefined?loadingCard('正在確認頭像…')
      :avatar.value?{state:'done',body:<p>已上傳頭像。</p>,action:go('account','到我的名片管理頭像',false)}
      :{state:'todo',body:<p>上傳一張頭像，讓夥伴更容易認出你。</p>,action:go('account','前往我的名片上傳頭像',true)})});

  cards.push({key:'social-link',required:false,title:'新增社群連結',
    ...(social.error?{state:'error',body:null,error:social.error,retry:retrying(['social'],'重新讀取社群連結狀態')}
      :social.value===undefined?loadingCard('正在確認社群連結…')
      :social.value>0?{state:'done',body:<p>已新增 {social.value} 個社群連結。</p>,action:go('account','到我的名片管理社群連結',false)}
      :{state:'todo',body:<p>在名片加上一個社群連結，每筆可各自設定公開範圍。</p>,action:go('account','前往我的名片新增連結',true)})});

  cards.push({key:'skill-book',required:false,title:'領取第一本技能書',
    ...(onboarding.error?{state:'error',body:null,error:onboarding.error,retry:retrying(['onboarding'],'重新讀取技能書狀態')}
      :!onboarding.value?loadingCard('正在確認技能書…')
      :onboarding.value.bookCount>0?{state:'done',body:<p>已領取 {onboarding.value.bookCount} 本技能書。</p>,action:go('skills','查看技能書架',false)}
      :{state:'todo',body:<p>到技能書架免費領取第一本技能書。</p>,action:go('skills','前往技能書架',true)})});

  const group=(required:boolean,id:string,title:string)=><section className="member-tasks-group" aria-labelledby={id}>
    <h2 id={id} className="member-section-title">{title}</h2>
    <ul className="messages-list">
      {cards.filter(card=>card.required===required).sort((a,b)=>rank(a.state)-rank(b.state)).map(card=>{
        const retry=card.retry;
        return <li key={card.key}><article className="member-task" tabIndex={-1} aria-labelledby={`task-${card.key}-title`} data-task={card.key} data-task-state={card.state}>
          <div className="member-task-heading"><h3 id={`task-${card.key}-title`}>{card.title}</h3>
            <span className={`task-state task-state-${card.state}`} role="status">{stateLabels[card.state]}</span></div>
          {card.error&&<p role="alert">{card.error}</p>}
          {card.body}
          {(card.action||retry)&&<div className="member-task-actions">{card.action}
            {retry&&<button className="btn btn-ghost" type="button" disabled={retry.busy} onClick={retry.run}>{retry.label}</button>}</div>}
          {card.key==='github'&&connectError&&<p role="alert">{connectError}</p>}
        </article></li>;
      })}
    </ul>
  </section>;

  return <div className="member-tasks" ref={sectionRef} onFocus={tracked} onBlur={left}>
    {group(true,'member-tasks-required','必做待辦')}
    {group(false,'member-tasks-suggested','建議待辦')}
  </div>;
}
