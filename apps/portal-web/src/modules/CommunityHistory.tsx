import {useEffect,useMemo,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import './CommunityHistory.css';

type Category='platform'|'official'|'personal';
type Kind='issue'|'pr';
type Repository={name:string;title:string;category:Category;url:string};
type Item={kind:Kind;repository:string;number:number;title:string;url:string;author:string|null;created_at:string;updated_at:string;state:'open'|'closed';state_reason?:string|null;merged_at?:string|null};
type Page={items:Item[];has_more:boolean;checked_at:string};
type View='ranking'|'issue'|'pr';
const categories:{id:Category;label:string}[]=[{id:'platform',label:'平台結構'},{id:'official',label:'官方技能'},{id:'personal',label:'私人技能'}];
const key=(repo:string,kind:Kind)=>`${repo.toLowerCase()}/${kind}`;
const resolved=(item:Item)=>item.state==='closed'&&item.state_reason!=='not_planned';
const updated=(item:Item)=>Boolean(item.merged_at);
const safeLink=(url:string)=>{try{const value=new URL(url);return value.protocol==='https:'&&value.hostname==='github.com'&&!value.username&&!value.password?url:null;}catch{return null;}};

export function CommunityHistory({client}:{client:PortalClient}){
  const [repos,setRepos]=useState<Repository[]>([]),[catalogError,setCatalogError]=useState(''),[catalogLoading,setCatalogLoading]=useState(true);
  const [view,setView]=useState<View>('ranking'),[category,setCategory]=useState<Category>('platform');
  const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[revision,setRevision]=useState(0);
  const [reload,setReload]=useState(0);
  const [progress,setProgress]=useState({done:0,total:0}),[failures,setFailures]=useState<string[]>([]);
  const cache=useRef(new Map<string,Item[]>()),pending=useRef(new Map<string,Promise<Item[]>>()),run=useRef(0);
  useEffect(()=>{let active=true;setCatalogLoading(true);void client.get<{items:Repository[]}>('/community/github-history/repositories')
    .then(value=>{if(active){setRepos(value.items);setCatalogError('');}})
    .catch(error=>{if(active)setCatalogError(error instanceof Error?error.message:'儲存庫清單暫時無法載入。');})
    .finally(()=>{if(active)setCatalogLoading(false);});return()=>{active=false;};},[client,reload]);
  const loadRepo=async(repo:Repository,kind:Kind):Promise<Item[]>=>{
    const id=key(repo.name,kind),stored=cache.current.get(id);if(stored)return stored;
    const running=pending.current.get(id);if(running)return running;
    const task=(async()=>{const items:Item[]=[];for(let page=1;page<=10000;page++){
      const result=await client.get<Page>(`/community/github-history/items?repository=${encodeURIComponent(repo.name)}&kind=${kind}&page=${page}`,{background:true});
      items.push(...result.items);if(!result.has_more){cache.current.set(id,items);return items;}
    }throw Error('GitHub 歷史超過可讀取頁數，請到原始儲存庫查看。');})().finally(()=>pending.current.delete(id));
    pending.current.set(id,task);return task;
  };
  useEffect(()=>{
    if(!repos.length)return;
    const current=++run.current,scope=repos.filter(repo=>view==='ranking'||repo.category===category);
    const jobs=scope.flatMap(repo=>(view==='ranking'?(['issue','pr'] as Kind[]):[view]).map(kind=>({repo,kind})));
    let next=0,done=0;const errors:string[]=[];setProgress({done:0,total:jobs.length});setFailures([]);
    const worker=async()=>{while(next<jobs.length){const job=jobs[next++];try{await loadRepo(job.repo,job.kind);}catch{errors.push(`${job.repo.title} · ${job.kind==='issue'?'想法':'更新'}`);}
      done++;if(run.current===current){setProgress({done,total:jobs.length});setFailures([...errors]);setRevision(value=>value+1);}}
    };
    void Promise.all(Array.from({length:Math.min(3,jobs.length)},()=>worker()));
    return()=>{run.current++;};
  // revision is only a render signal for completed repository reads.
  },[client,repos,view,category,reload]);

  const scope=repos.filter(repo=>repo.category===category),allRepos=new Map(repos.map(repo=>[repo.name.toLowerCase(),repo]));
  const records=useMemo(()=>{
    const sources=view==='ranking'?repos:scope,kinds:Kind[]=view==='ranking'?['issue','pr']:[view];
    return sources.flatMap(repo=>kinds.flatMap(kind=>cache.current.get(key(repo.name,kind))??[]));
  },[repos,scope,view,revision]);
  const complete=progress.total>0&&progress.done===progress.total&&failures.length===0;
  const ranking=useMemo(()=>{
    const totals=new Map<string,{login:string;ideas:number;edits:number}>();
    for(const item of records){const login=item.author;if(!login||login.endsWith('[bot]'))continue;
      const id=login.toLowerCase(),row=totals.get(id)??{login,ideas:0,edits:0};
      if(item.kind==='issue')row.ideas++;else row.edits++;totals.set(id,row);
    }
    return [...totals.values()];
  },[records]);
  const leaderboards=[
    {title:'想法排行榜',value:(row:typeof ranking[number])=>row.ideas,unit:'Issue'},
    {title:'編修排行榜',value:(row:typeof ranking[number])=>row.edits,unit:'PR'},
    {title:'貢獻排行榜',value:(row:typeof ranking[number])=>row.ideas*5+row.edits*20,unit:'分'},
  ];
  const term=query.trim().toLocaleLowerCase();
  const visible=records.filter(item=>!term||[item.title,item.author??'',item.repository,String(item.number)].join(' ').toLocaleLowerCase().includes(term))
    .filter(item=>status==='all'||(view==='issue'?resolved(item):updated(item))===(status==='done'))
    .sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.repository.localeCompare(b.repository)||b.number-a.number);
  return <section className="community-history stack" aria-label="GitHub 共創紀錄">
    <div className="experience-heading"><h2>使用者排行榜與歷史紀錄</h2><span>以 GitHub 原始紀錄為準</span></div>
    <p className="muted">涵蓋平台結構、公會指定的官方技能，以及其他已收錄或登錄的公開技能 Repo。以 GitHub 作者帳號計算；Issue 每件 5 分，PR 每件 20 分。這些分數只用於本頁排行，不計入會員 XP。</p>
    <div className="community-history-nav" role="group" aria-label="共創紀錄類型">
      {([['ranking','使用者排行榜'],['issue','歷史想法'],['pr','歷史更新']] as const).map(([id,label])=><button key={id} type="button" className={`btn ${view===id?'btn-primary':'btn-ghost'}`} aria-pressed={view===id} onClick={()=>{setView(id);setQuery('');setStatus('all');}}>{label}</button>)}
    </div>
    {catalogLoading&&<p role="status">正在讀取儲存庫清單…</p>}
    {catalogError&&<div role="alert" className="banner banner-error">{catalogError} <button type="button" className="btn btn-ghost" onClick={()=>setReload(value=>value+1)}>重新讀取</button></div>}
    {repos.length>0&&<>
      {view!=='ranking'&&<div className="community-history-categories" role="group" aria-label="儲存庫分類">{categories.map(item=><button type="button" key={item.id} className={`btn ${category===item.id?'btn-primary':'btn-ghost'}`} aria-pressed={category===item.id} onClick={()=>setCategory(item.id)}>{item.label} <span>{repos.filter(repo=>repo.category===item.id).length}</span></button>)}</div>}
      {progress.done<progress.total&&<p role="status">正在讀取 GitHub 歷史：{progress.done}/{progress.total} 個儲存庫資料集。</p>}
      {failures.length>0&&<div role="alert" className="banner banner-info">部分儲存庫暫時無法讀取：{failures.join('、')}。目前資料不完整。 <button type="button" className="btn btn-ghost" onClick={()=>setReload(value=>value+1)}>重新讀取</button></div>}
      {view==='ranking'?complete?<div className="community-leaderboards">{leaderboards.map(board=><section className="card community-leaderboard" key={board.title}><h3>{board.title}</h3><ol>{ranking.filter(row=>board.value(row)>0).sort((a,b)=>board.value(b)-board.value(a)||a.login.localeCompare(b.login)).map(row=><li key={row.login}><a href={`https://github.com/${encodeURIComponent(row.login)}`} target="_blank" rel="noopener noreferrer">{row.login}</a><strong>{board.value(row)} {board.unit}</strong></li>)}</ol>{!ranking.some(row=>board.value(row)>0)&&<p className="empty">目前沒有紀錄。</p>}</section>)}</div>:<p className="empty">完整讀取所有分類後顯示榜單，避免以部分資料排名。</p>
      :<>
        <div className="experience-filters"><label className="field">搜尋{view==='issue'?'想法':'更新'}<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="標題、作者或 Repo"/></label><label className="field">狀態<select value={status} onChange={event=>setStatus(event.target.value)}><option value="all">全部狀態</option><option value="done">{view==='issue'?'已解決':'已更新'}</option><option value="pending">{view==='issue'?'未解決':'未更新'}</option></select></label></div>
        <p className="muted">{categories.find(item=>item.id===category)?.label} · {scope.length} 個 Repo · 已讀取 {records.length} 筆{!complete?'（載入中或部分資料）':''}</p>
        {visible.length?<ol className="community-history-list">{visible.map(item=><li key={`${item.repository}/${item.kind}/${item.number}`}><div className="community-history-row"><span className={`community-history-state ${(view==='issue'?resolved(item):updated(item))?'is-done':''}`}>{view==='issue'?(resolved(item)?'已解決':'未解決'):(updated(item)?'已更新':'未更新')}</span><div><a href={safeLink(item.url)??'#'} target="_blank" rel="noopener noreferrer">{item.title}</a><p>{allRepos.get(item.repository.toLowerCase())?.title??item.repository} · #{item.number} · {item.author??'已刪除帳號'} · {formatIsoLocal(item.created_at)}</p></div></div></li>)}</ol>:complete?<p className="empty">此分類目前沒有符合條件的紀錄。</p>:null}
      </>}
    </>}
  </section>;
}
