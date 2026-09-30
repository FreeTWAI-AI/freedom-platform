import {useEffect,useMemo,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import {contributionPoints,isGitHubBot,issueResolved,pullClosedUnmerged,pullUpdated} from '../../../../packages/shared/github-leaderboard';
import './CommunityHistory.css';

type Category='platform'|'official'|'personal';
type Kind='issue'|'pr';
type Repository={name:string;title:string;category:Category;url:string};
type Item={kind:Kind;repository:string;number:number;title:string;url:string;author:string|null;created_at:string;updated_at:string;state:'open'|'closed';state_reason?:string|null;merged_at?:string|null};
type Page={items:Item[];has_more:boolean;checked_at:string|null;stale?:boolean;unavailable?:string};
type View='ranking'|'issue'|'pr';
type Cached={items:Item[];stale:boolean;checked_at:string|null};
const categories:{id:Category;label:string}[]=[{id:'platform',label:'平台結構'},{id:'official',label:'官方技能'},{id:'personal',label:'私人技能'}];
const PAGE_CAP=100;
const PAGE_SIZE=40;
const keyOf=(repo:string,kind:Kind)=>`${repo.toLowerCase()}/${kind}`;
const safeLink=(url:string)=>{try{const value=new URL(url);return value.protocol==='https:'&&value.hostname==='github.com'&&!value.username&&!value.password?url:null;}catch{return null;}};

export function CommunityHistory({client}:{client:PortalClient}){
  const [repos,setRepos]=useState<Repository[]>([]),[catalogError,setCatalogError]=useState(''),[catalogLoading,setCatalogLoading]=useState(true);
  const [view,setView]=useState<View>('ranking'),[category,setCategory]=useState<Category>('platform');
  const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[revision,setRevision]=useState(0);
  const [reload,setReload]=useState(0),[shown,setShown]=useState(PAGE_SIZE);
  const [progress,setProgress]=useState({done:0,total:0}),[failures,setFailures]=useState<string[]>([]);
  const cache=useRef(new Map<string,Cached>()),pending=useRef(new Map<string,Promise<Cached>>()),run=useRef(0),generation=useRef(0);
  const retry=()=>{generation.current+=1;cache.current.clear();pending.current.clear();setReload(value=>value+1);};
  useEffect(()=>{let active=true;setCatalogLoading(true);void client.get<{items:Repository[]}>('/community/github-history/repositories')
    .then(value=>{if(active){setRepos(value.items);setCatalogError('');}})
    .catch(error=>{if(active)setCatalogError(error instanceof Error?error.message:'儲存庫清單暫時無法載入。');})
    .finally(()=>{if(active)setCatalogLoading(false);});return()=>{active=false;};},[client,reload]);
  useEffect(()=>{setShown(PAGE_SIZE);},[view,category,query,status]);
  const loadRepo=async(repo:Repository,kind:Kind,gen:number):Promise<Cached>=>{
    const id=keyOf(repo.name,kind),stored=cache.current.get(id);if(stored)return stored;
    const running=pending.current.get(id);if(running)return running;
    const task=(async():Promise<Cached>=>{
      const items:Item[]=[];let stale=false,checked:string|null=null;
      for(let page=1;page<=PAGE_CAP;page++){
        let result=await client.get<Page>(`/community/github-history/items?repository=${encodeURIComponent(repo.name)}&kind=${kind}&page=${page}`,{background:true});
        if(result.unavailable==='github_refresh_in_progress'&&result.items.length===0){
          await new Promise(resolve=>setTimeout(resolve,500));
          if(generation.current!==gen)throw Error('cancelled');
          result=await client.get<Page>(`/community/github-history/items?repository=${encodeURIComponent(repo.name)}&kind=${kind}&page=${page}`,{background:true});
        }
        if(result.unavailable&&result.items.length===0)throw Error(result.unavailable);
        items.push(...result.items);
        if(result.stale||result.unavailable)stale=true;
        if(result.checked_at)checked=result.checked_at;
        if(!result.has_more){
          if(generation.current!==gen)throw Error('cancelled');
          const value={items,stale,checked_at:checked};cache.current.set(id,value);return value;
        }
      }
      throw Error('truncated');
    })();
    pending.current.set(id,task);
    void task.finally(()=>{if(pending.current.get(id)===task)pending.current.delete(id);});
    return task;
  };
  useEffect(()=>{
    if(!repos.length){setProgress({done:0,total:0});setFailures([]);return;}
    const current=++run.current,gen=generation.current,scope=repos.filter(repo=>view==='ranking'||repo.category===category);
    const jobs=scope.flatMap(repo=>(view==='ranking'?(['issue','pr'] as Kind[]):[view]).map(kind=>({repo,kind})));
    if(!jobs.length){setProgress({done:0,total:0});setFailures([]);return;}
    let next=0,done=0;const errors:string[]=[];setProgress({done:0,total:jobs.length});setFailures([]);
    const worker=async()=>{while(next<jobs.length&&run.current===current){const job=jobs[next++];try{await loadRepo(job.repo,job.kind,gen);}catch(error){if(error instanceof Error&&error.message==='cancelled')return;errors.push(job.repo.name);}
      done++;if(run.current===current){setProgress({done,total:jobs.length});setFailures([...errors]);setRevision(value=>value+1);}}
    };
    void Promise.all(Array.from({length:Math.min(3,jobs.length)},()=>worker()));
    return()=>{run.current++;};
  },[client,repos,view,category,reload]);

  const scope=repos.filter(repo=>repo.category===category),allRepos=new Map(repos.map(repo=>[repo.name.toLowerCase(),repo]));
  const sources=view==='ranking'?repos:scope,kinds:Kind[]=view==='ranking'?['issue','pr']:[view];
  const records=useMemo(()=>sources.flatMap(repo=>kinds.flatMap(kind=>cache.current.get(keyOf(repo.name,kind))?.items??[])),[repos,scope,view,revision,sources,kinds]);
  const complete=progress.total>0&&progress.done===progress.total&&failures.length===0;
  const stale=complete&&sources.some(repo=>kinds.some(kind=>cache.current.get(keyOf(repo.name,kind))?.stale));
  const staleAt=sources.flatMap(repo=>kinds.map(kind=>cache.current.get(keyOf(repo.name,kind))?.checked_at)).find(Boolean)??null;
  const ranking=useMemo(()=>{
    const totals=new Map<string,{login:string;ideas:number;edits:number}>();
    for(const item of records){const login=item.author?.trim();if(!login||isGitHubBot(login))continue;
      const id=login.toLowerCase(),row=totals.get(id)??{login,ideas:0,edits:0};
      if(item.kind==='issue')row.ideas++;else row.edits++;totals.set(id,row);
    }
    return [...totals.values()];
  },[records]);
  const leaderboards=[
    {title:'想法排行榜',formula:'',value:(row:typeof ranking[number])=>row.ideas,unit:'Issue'},
    {title:'編修排行榜',formula:'',value:(row:typeof ranking[number])=>row.edits,unit:'PR'},
    {title:'貢獻排行榜',formula:'每個 Issue 5 分，每個 PR 20 分（Issue × 5 + PR × 20）。',value:(row:typeof ranking[number])=>contributionPoints(row.ideas,row.edits),unit:'分'},
  ];
  const term=query.trim().toLocaleLowerCase();
  const visible=records.filter(item=>!term||[item.title,item.author??'',item.repository,String(item.number)].join(' ').toLocaleLowerCase().includes(term))
    .filter(item=>status==='all'||(view==='issue'?issueResolved(item.state):pullUpdated(item.merged_at))===(status==='done'))
    .sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.repository.localeCompare(b.repository)||b.number-a.number);
  const pageItems=visible.slice(0,shown);
  return <section className="community-history stack" aria-label="GitHub 共創紀錄">
    <div className="experience-heading"><h2>使用者排行榜與歷史紀錄</h2><span>以 GitHub 原始紀錄為準</span></div>
    <p className="muted">涵蓋平台結構、公會指定的官方技能，以及其他已收錄的公開技能 Repo。排行以 GitHub 作者帳號計算：想法是 Issue 件數，編修是 PR 件數，貢獻是每個 Issue 5 分、每個 PR 20 分。這些分數只顯示在本頁，不計入會員經驗、獎勵或驗收。</p>
    <div className="community-history-nav" role="group" aria-label="共創紀錄類型">
      {([['ranking','使用者排行榜'],['issue','歷史想法'],['pr','歷史更新']] as const).map(([id,label])=><button key={id} type="button" className={`btn ${view===id?'btn-primary':'btn-ghost'}`} aria-pressed={view===id} onClick={()=>{setView(id);setQuery('');setStatus('all');}}>{label}</button>)}
    </div>
    {catalogLoading&&<p role="status">正在讀取儲存庫清單…</p>}
    {catalogError&&<div role="alert" className="banner banner-error"><span>{catalogError}</span> <button type="button" className="btn btn-ghost" onClick={retry}>重新讀取</button></div>}
    {!catalogLoading&&!catalogError&&repos.length===0&&<p className="empty">目前沒有可統計的儲存庫。</p>}
    {repos.length>0&&<>
      {view!=='ranking'&&<div className="community-history-categories" role="group" aria-label="儲存庫分類">{categories.map(item=><button type="button" key={item.id} className={`btn ${category===item.id?'btn-primary':'btn-ghost'}`} aria-pressed={category===item.id} onClick={()=>setCategory(item.id)}>{item.label} <span>{repos.filter(repo=>repo.category===item.id).length}</span></button>)}</div>}
      {progress.total>0&&progress.done<progress.total&&<p role="status" aria-live="polite">正在讀取 GitHub 歷史：{progress.done}/{progress.total} 個儲存庫資料集。</p>}
      {failures.length>0&&<div role="alert" className="banner banner-error"><strong>資料不完整</strong><span>有 {failures.length} 個資料集沒有讀完，先不顯示排行。</span><button type="button" className="btn btn-ghost" onClick={retry}>重新讀取</button></div>}
      {complete&&stale&&<div role="status" className="banner banner-info"><span>以下使用稍早的 GitHub 紀錄{staleAt?`（${formatIsoLocal(staleAt)}）`:''}。排行依照已讀完的清單。</span><button type="button" className="btn btn-ghost" onClick={retry}>重新讀取</button></div>}
      {view==='ranking'?complete?<div className="community-leaderboards">{leaderboards.map(board=>{
        const rows=ranking.filter(row=>board.value(row)>0).sort((a,b)=>board.value(b)-board.value(a)||a.login.localeCompare(b.login));
        return <section className="card community-leaderboard" key={board.title}><h3>{board.title}</h3>{board.formula&&<p className="formula">{board.formula}</p>}<ol>{rows.map(row=><li key={row.login}><a href={`https://github.com/${encodeURIComponent(row.login)}`} target="_blank" rel="noopener noreferrer">{row.login}</a><strong>{board.value(row)} {board.unit}</strong></li>)}</ol>{!rows.length&&<p className="empty">目前沒有紀錄。</p>}</section>;
      })}</div>:failures.length===0?<p className="empty">完整讀取所有分類後顯示榜單，避免以部分資料排名。</p>:null
      :scope.length===0?<p className="empty">此分類目前沒有符合條件的紀錄。</p>:<>
        <div className="experience-filters"><label className="field">搜尋{view==='issue'?'想法':'更新'}<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="標題、作者或 Repo"/></label><label className="field">狀態<select value={status} onChange={event=>setStatus(event.target.value)}><option value="all">全部狀態</option><option value="done">{view==='issue'?'已解決':'已更新'}</option><option value="pending">{view==='issue'?'未解決':'未更新'}</option></select></label></div>
        <p className="muted">{categories.find(item=>item.id===category)?.label} · {scope.length} 個 Repo · 已讀取 {records.length} 筆{failures.length?` · 資料不完整`:!complete?' · 載入中':''}</p>
        {pageItems.length?<ol className="community-history-list">{pageItems.map(item=>{
          const done=view==='issue'?issueResolved(item.state):pullUpdated(item.merged_at);
          const href=safeLink(item.url);
          const hint=view==='pr'&&pullClosedUnmerged(item.state,item.merged_at);
          return <li key={`${item.repository}/${item.kind}/${item.number}`}><div className="community-history-row"><span className="community-history-status"><span className={`community-history-state ${done?'is-done':''}`}>{view==='issue'?(done?'已解決':'未解決'):(done?'已更新':'未更新')}</span>{hint&&<span className="community-history-hint">未合併關閉</span>}</span><div>{href?<a href={href} target="_blank" rel="noopener noreferrer">{item.title}</a>:<span>{item.title}</span>}<p>{allRepos.get(item.repository.toLowerCase())?.title??item.repository} · #{item.number} · {item.author??'已刪除帳號'} · 建立 {formatIsoLocal(item.created_at)} · 更新 {formatIsoLocal(item.updated_at)}</p></div></div></li>;
        })}</ol>:complete||failures.length?<p className="empty">此分類目前沒有符合條件的紀錄。</p>:null}
        {visible.length>shown&&<button type="button" className="btn btn-ghost" onClick={()=>setShown(value=>value+PAGE_SIZE)}>顯示更多（{visible.length-shown}）</button>}
      </>}
    </>}
  </section>;
}
