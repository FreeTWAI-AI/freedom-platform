import {useEffect,useMemo,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import {issueResolved,pullClosedUnmerged,pullUpdated,withRanks} from '../../../../packages/shared/github-leaderboard';
import './CommunityHistory.css';

type Category='platform'|'official'|'personal';
type Kind='issue'|'pr';
type SyncStatus='syncing'|'ok'|'unreadable';
type Repository={name:string;title:string;category:Category;url:string;sync:{status:SyncStatus;last_synced_at:string|null}};
type Item={kind:Kind;repository:string;number:number;title:string;url:string;author:string|null;created_at:string;updated_at:string;state:'open'|'closed';state_reason?:string|null;merged_at?:string|null};
type Page={items:Item[];has_more:boolean;checked_at:string|null;stale?:boolean;unavailable?:string};
type Ranked={login:string;count:number};
type Boards={ideas:Ranked[];edits:Ranked[];contributions:Ranked[];complete:boolean;oldest_synced_at:string|null;syncing:string[];unreadable:string[]};
type View='ranking'|'issue'|'pr';
type Cached={items:Item[];stale?:boolean;unavailable?:string};
const categories:{id:Category;label:string}[]=[{id:'platform',label:'平台結構'},{id:'official',label:'官方技能'},{id:'personal',label:'私人技能'}];
const SYNCING='部分儲存庫仍在同步中，活動件數尚未完整。';
const UNREADABLE='沒有權限讀取這個儲存庫（可能已設為私有或已刪除）';
// GITHUB_HISTORY_PAGE_CAP in modules/community/github-history.ts
const PAGE_CAP=100;
const PAGE_SIZE=40;
const keyOf=(repo:string,kind:Kind)=>`${repo.toLowerCase()}/${kind}`;
const safeLink=(url:string)=>{try{const value=new URL(url);return value.protocol==='https:'&&value.hostname==='github.com'&&!value.username&&!value.password?url:null;}catch{return null;}};

function SyncNotes({syncing,unreadable,onRetry}:{syncing:string[];unreadable:string[];onRetry:()=>void}){
  if(!syncing.length&&!unreadable.length)return null;
  return <>
    {syncing.length>0&&<div role="status" className="banner banner-info"><span>{SYNCING}</span><span>{syncing.join('、')}</span><button type="button" className="btn btn-ghost" onClick={onRetry}>重新讀取</button></div>}
    {unreadable.map(name=><p key={name} className="muted">{name}：{UNREADABLE}</p>)}
  </>;
}

export function CommunityHistory({client}:{client:PortalClient}){
  const [repos,setRepos]=useState<Repository[]>([]),[catalogError,setCatalogError]=useState(''),[catalogLoading,setCatalogLoading]=useState(true);
  const [view,setView]=useState<View>('ranking'),[category,setCategory]=useState<Category>('platform');
  const [query,setQuery]=useState(''),[status,setStatus]=useState('all'),[revision,setRevision]=useState(0);
  const [reload,setReload]=useState(0),[shown,setShown]=useState(PAGE_SIZE);
  const [boards,setBoards]=useState<Boards|null>(null),[boardsError,setBoardsError]=useState(''),[boardsLoading,setBoardsLoading]=useState(false);
  const [listProgress,setListProgress]=useState({done:0,total:0}),[listFailures,setListFailures]=useState<string[]>([]);
  const cache=useRef(new Map<string,Cached>()),pending=useRef(new Map<string,Promise<Cached>>()),run=useRef(0),generation=useRef(0);
  const retry=()=>{generation.current+=1;cache.current.clear();pending.current.clear();setReload(value=>value+1);};
  useEffect(()=>{let active=true;setCatalogLoading(true);void client.get<{items:Repository[]}>('/community/github-history/repositories')
    .then(value=>{if(active){setRepos(value.items);setCatalogError('');}})
    .catch(error=>{if(active)setCatalogError(error instanceof Error?error.message:'儲存庫清單暫時無法載入。');})
    .finally(()=>{if(active)setCatalogLoading(false);});return()=>{active=false;};},[client,reload]);
  useEffect(()=>{
    if(view!=='ranking')return;
    let active=true;setBoardsLoading(true);
    void client.get<Boards>('/community/github-history/leaderboards')
      .then(value=>{if(active){setBoards(value);setBoardsError('');}})
      .catch(error=>{if(active)setBoardsError(error instanceof Error?error.message:'排行榜暫時無法載入。');})
      .finally(()=>{if(active)setBoardsLoading(false);});
    return()=>{active=false;};
  },[client,view,reload]);
  useEffect(()=>{setShown(PAGE_SIZE);},[view,category,query,status]);
  const loadRepo=async(repo:Repository,kind:Kind,gen:number):Promise<Cached>=>{
    const id=keyOf(repo.name,kind),stored=cache.current.get(id);if(stored)return stored;
    const running=pending.current.get(id);if(running)return running;
    const task=(async():Promise<Cached>=>{
      const items:Item[]=[];let stale=false;let unavailable:string|undefined;
      for(let page=1;page<=PAGE_CAP;page++){
        const result=await client.get<Page>(`/community/github-history/items?repository=${encodeURIComponent(repo.name)}&kind=${kind}&page=${page}`,{background:true});
        items.push(...result.items);stale||=Boolean(result.stale);unavailable??=result.unavailable;
        if(!result.has_more){
          if(generation.current!==gen)throw Error('cancelled');
          const value={items,stale,unavailable};cache.current.set(id,value);return value;
        }
      }
      if(generation.current!==gen)throw Error('cancelled');const value={items,stale,unavailable};cache.current.set(id,value);return value;
    })();
    pending.current.set(id,task);
    void task.then(()=>{if(pending.current.get(id)===task)pending.current.delete(id);},()=>{if(pending.current.get(id)===task)pending.current.delete(id);});
    return task;
  };
  useEffect(()=>{
    if(view==='ranking'||!repos.length){setListProgress({done:0,total:0});setListFailures([]);return;}
    const current=++run.current,gen=generation.current,scope=repos.filter(repo=>repo.category===category);
    if(!scope.length){setListProgress({done:0,total:0});setListFailures([]);return;}
    let next=0,done=0;const errors:string[]=[];setListProgress({done:0,total:scope.length});setListFailures([]);
    const worker=async()=>{while(next<scope.length&&run.current===current){const repo=scope[next++];try{await loadRepo(repo,view,gen);}catch(error){if(error instanceof Error&&error.message==='cancelled')return;errors.push(repo.name);}
      done++;if(run.current===current){setListProgress({done,total:scope.length});setListFailures([...errors]);setRevision(value=>value+1);}}
    };
    void Promise.all(Array.from({length:Math.min(3,scope.length)},()=>worker()));
    return()=>{run.current++;};
  },[client,repos,view,category,reload]);

  const scope=repos.filter(repo=>repo.category===category),allRepos=new Map(repos.map(repo=>[repo.name.toLowerCase(),repo]));
  const records=useMemo(()=>view==='ranking'?[]:scope.flatMap(repo=>cache.current.get(keyOf(repo.name,view))?.items??[]),[repos,scope,view,revision]);
  const listDone=listProgress.total>0&&listProgress.done===listProgress.total;
  const listIncomplete=listFailures.length>0||scope.some(repo=>Boolean(cache.current.get(keyOf(repo.name,view as Kind))?.unavailable));
  const term=query.trim().toLocaleLowerCase();
  const visible=records.filter(item=>!term||[item.title,item.author??'',item.repository,String(item.number)].join(' ').toLocaleLowerCase().includes(term))
    .filter(item=>status==='all'||(view==='issue'?issueResolved(item.state):pullUpdated(item.merged_at))===(status==='done'))
    .sort((a,b)=>b.created_at.localeCompare(a.created_at)||a.repository.localeCompare(b.repository)||b.number-a.number);
  const pageItems=visible.slice(0,shown);
  const listSyncing=scope.filter(repo=>repo.sync.status==='syncing').map(repo=>repo.name);
  const listUnreadable=scope.filter(repo=>repo.sync.status==='unreadable').map(repo=>repo.name);
  const leaderboards=boards?[
    {title:'Issue 活動件數',formula:'包含開放與已關閉的 Issue。',rows:boards.ideas,unit:'Issue'},
    {title:'PR 活動件數',formula:'包含待處理、已合併與已關閉未合併的 PR。',rows:boards.edits,unit:'PR'},
  ]:[];
  return <section className="community-history stack" aria-label="GitHub 共創紀錄">
    <div className="experience-heading"><h2>GitHub 活動與歷史紀錄</h2><span>以 GitHub 原始紀錄為準</span></div>
    <p className="muted">這裡記錄 GitHub 的提案與程式協作活動，保留原始作者。活動件數不代表成果品質、信任度或合作資格；提案、設計、測試與服務的成果角色，請到上方已驗收工作查看。</p><details className="community-source-scope"><summary>統計範圍與署名規則</summary><p>涵蓋平台結構、公會指定的官方技能，以及其他已收錄的公開技能 Repo。活動榜計入已在平台連結 GitHub 的會員，以及從頁面「提出想法」或「參與編修」送出、且帶有頁面標記的 Issue／PR。其他帳號仍出現在歷史清單，活動榜不計入。來源保留 GitHub 原作者，不把對話提案、自填帳號或共同參與者改記為 PR 作者。</p><p>已關閉 Issue 不一定完成；已合併 PR 不等於已部署或通過會員驗收。</p></details>
    <div className="community-history-nav" role="group" aria-label="共創紀錄類型">
      {([['ranking','GitHub 活動榜'],['issue','Issue 歷史'],['pr','PR 歷史']] as const).map(([id,label])=><button key={id} type="button" className={`btn ${view===id?'btn-primary':'btn-ghost'}`} aria-pressed={view===id} onClick={()=>{setView(id);setQuery('');setStatus('all');}}>{label}</button>)}
    </div>
    {catalogLoading&&<p role="status">正在讀取儲存庫清單…</p>}
    {catalogError&&<div role="alert" className="banner banner-error"><span>{catalogError}</span> <button type="button" className="btn btn-ghost" onClick={retry}>重新讀取</button></div>}
    {!catalogLoading&&!catalogError&&repos.length===0&&<p className="empty">目前沒有可統計的儲存庫。</p>}
    {repos.length>0&&<>
      {view!=='ranking'&&<div className="community-history-categories" role="group" aria-label="儲存庫分類">{categories.map(item=><button type="button" key={item.id} className={`btn ${category===item.id?'btn-primary':'btn-ghost'}`} aria-pressed={category===item.id} onClick={()=>setCategory(item.id)}>{item.label} <span>{repos.filter(repo=>repo.category===item.id).length}</span></button>)}</div>}
      {view==='ranking'?<>
        {boardsLoading&&!boards&&<p role="status">正在讀取歷史紀錄</p>}
        {boardsError&&<div role="alert" className="banner banner-error"><span>{boardsError}</span><button type="button" className="btn btn-ghost" onClick={retry}>重新讀取</button></div>}
        {boards&&<>
          <p className="muted">最早來源同步時間：{formatIsoLocal(boards.oldest_synced_at)} · {boards.complete?'目前來源已同步':'資料不完整'}</p>
          <SyncNotes syncing={boards.syncing} unreadable={boards.unreadable} onRetry={retry}/>
          <p className="hint">活動榜依件數排序；未收錄或尚未同步的來源不計入目前件數。</p><div className="community-leaderboards">{leaderboards.map(board=><section className="card community-leaderboard" key={board.title}><h3>{board.title}</h3>{board.formula&&<p className="formula">{board.formula}</p>}<ol>{withRanks(board.rows).map(row=><li key={row.login}><span className="community-rank"><span className="sr-only">第 </span>{row.rank}<span className="sr-only"> 名</span></span><a href={`https://github.com/${encodeURIComponent(row.login)}`} target="_blank" rel="noopener noreferrer">{row.login}</a><strong>{row.count} {board.unit}</strong></li>)}</ol>{!board.rows.length&&<p className="empty">目前沒有紀錄。</p>}</section>)}</div>
          <details className="card community-legacy-score"><summary>舊版 GitHub 活動分（僅供查閱）</summary><p className="hint">每個 Issue 5 分，每個 PR 20 分（Issue × 5 + PR × 20）。不計入會員經驗、獎勵、驗收或找夥伴排序，不能用來判斷信任度。</p><ul>{boards.contributions.map(row=><li key={row.login}><a href={`https://github.com/${encodeURIComponent(row.login)}`} target="_blank" rel="noopener noreferrer">{row.login}</a><span>{row.count} 分</span></li>)}</ul></details>
        </>}
      </>:scope.length===0?<p className="empty">此分類目前沒有符合條件的紀錄。</p>:<>
        <SyncNotes syncing={listSyncing} unreadable={listUnreadable} onRetry={retry}/>{scope.some(repo=>cache.current.get(keyOf(repo.name,view))?.stale||cache.current.get(keyOf(repo.name,view))?.unavailable)&&<p role="status" className="banner banner-info">部分歷史是較早的快取或暫時無法讀取；目前清單可能不完整。</p>}
        {listProgress.total>0&&listProgress.done<listProgress.total&&<p role="status" aria-live="polite">正在讀取歷史紀錄</p>}
        {listFailures.length>0&&<div role="alert" className="banner banner-error"><span>有些歷史暫時無法顯示。</span><button type="button" className="btn btn-ghost" onClick={retry}>重新讀取</button></div>}
        <div className="experience-filters"><label className="field">搜尋{view==='issue'?'想法':'更新'}<input type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder="標題、作者或 Repo"/></label><label className="field">狀態<select value={status} onChange={event=>setStatus(event.target.value)}><option value="all">全部狀態</option><option value="done">{view==='issue'?'已關閉':'已合併'}</option><option value="pending">{view==='issue'?'開放中':'尚未合併'}</option></select></label></div>
        <p className="muted">{categories.find(item=>item.id===category)?.label} · {scope.length} 個 Repo · 已讀取 {records.length} 筆{!listDone?' · 載入中':''}</p>
        {pageItems.length?<ol className="community-history-list">{pageItems.map(item=>{
          const done=view==='issue'?issueResolved(item.state):pullUpdated(item.merged_at);
          const href=safeLink(item.url);
          const hint=view==='pr'&&pullClosedUnmerged(item.state,item.merged_at);
          return <li key={`${item.repository}/${item.kind}/${item.number}`}><div className="community-history-row"><span className="community-history-status"><span className={`community-history-state ${done?'is-done':''}`}>{view==='issue'?(done?'已關閉':'開放中'):(done?'已合併':hint?'已關閉未合併':'待處理')}</span></span><div>{href?<a href={href} target="_blank" rel="noopener noreferrer">{item.title}</a>:<span>{item.title}</span>}<p>{allRepos.get(item.repository.toLowerCase())?.title??item.repository} · #{item.number} · {item.author??'已刪除帳號'} · 建立 {formatIsoLocal(item.created_at)} · 更新 {formatIsoLocal(item.updated_at)}</p></div></div></li>;
        })}</ol>:listDone&&!listIncomplete?<p className="empty">此分類目前沒有符合條件的紀錄。</p>:null}
        {visible.length>shown&&<button type="button" className="btn btn-ghost" onClick={()=>setShown(value=>value+PAGE_SIZE)}>顯示更多（{visible.length-shown}）</button>}
      </>}
    </>}
  </section>;
}
