import { useCallback, useEffect, useRef, useState } from 'react';
import {requireCursorPage,type PortalClient} from '../api';
import type { TabId, WorkItem } from '../types';
import { formatIsoLocal } from '../format';
import { CommunityHistory } from './CommunityHistory';
import {MemberContributionOutcomes,WorkContributionRoles} from './ContributionOutcomes';
import './MemberExperience.css';

type Project = {project_id:string;title:string;goal:string;repository_url:string;repository_full_name:string};
type Issue = {number:number;title:string;url:string;labels:string[];assignees:string[]};
type Activity = {issues:Issue[];checked_at:string;truncated:boolean;stale_reason?:'github_rate_limited';unavailable_reason?:'github_sync_pending'|'github_unreadable'};
const safeGitHub=(url:string)=>{try{const parsed=new URL(url);return parsed.protocol==='https:'&&parsed.hostname==='github.com'&&!parsed.username&&!parsed.password?url:null;}catch{return null;}};

export function TaskBoardPanel({client,onNavigate}:{client:PortalClient;onNavigate:(tab:TabId)=>void}) {
  const [works,setWorks]=useState<WorkItem[]>([]),[projects,setProjects]=useState<Project[]>([]);
  const [outcomeRevision,setOutcomeRevision]=useState(0);
  const [loading,setLoading]=useState(true),[loadingMore,setLoadingMore]=useState(false),[error,setError]=useState(''),[pageError,setPageError]=useState(''),[query,setQuery]=useState(''),[scope,setScope]=useState<'open'|'all'>('open');
  const [nextCursor,setNextCursor]=useState<string|null>(null),[selected,setSelected]=useState(''),[activity,setActivity]=useState<Activity|null>(null),[activityLoading,setActivityLoading]=useState(false),[activityError,setActivityError]=useState('');
  const workRequests=useRef(0),search=query.trim();
  const load=useCallback(async()=>{
    const sequence=++workRequests.current;
    setLoading(true);setLoadingMore(false);setError('');setPageError('');setWorks([]);setNextCursor(null);
    const params=new URLSearchParams({scope,search});
    const results=await Promise.allSettled([client.get<unknown>(`/work-items/page?${params}`),client.get<{items:Project[]}>('/co-creation/projects')]);
    if(sequence!==workRequests.current)return;
    if(results[0].status==='fulfilled'){
      try{const page=requireCursorPage<WorkItem>(results[0].value,'工作列表');setWorks(page.items);setNextCursor(page.next_cursor);}
      catch{setWorks([]);setNextCursor(null);setError('社群工作暫時無法載入。');}
    }else{setWorks([]);setNextCursor(null);setError('社群工作暫時無法載入。');}
    if(results[1].status==='fulfilled')setProjects(results[1].value.items);else setError(value=>value+' GitHub 共創專案暫時無法載入。');
    setLoading(false);
  },[client,scope,search]);
  async function loadMore(){
    if(!nextCursor||loadingMore)return;
    const sequence=workRequests.current;
    setLoadingMore(true);setPageError('');
    try{
      const params=new URLSearchParams({scope,search,cursor:nextCursor});
      const page=requireCursorPage<WorkItem>(await client.get<unknown>(`/work-items/page?${params}`),'工作列表');
      if(sequence!==workRequests.current)return;
      setWorks(current=>{const known=new Set(current.map(item=>item.work_item_id));return [...current,...page.items.filter(item=>!known.has(item.work_item_id))];});
      setNextCursor(page.next_cursor);
    }catch{if(sequence===workRequests.current)setPageError('較早的工坊工作暫時無法載入。');}
    finally{if(sequence===workRequests.current)setLoadingMore(false);}
  }
  useEffect(()=>{
    setLoading(true);setLoadingMore(false);setWorks([]);setNextCursor(null);setPageError('');
    const timer=setTimeout(()=>void load(),search?250:0);
    return()=>{clearTimeout(timer);workRequests.current++;};
  },[load,search]);
  useEffect(()=>{
    if(!selected){setActivity(null);return;}
    let active=true;setActivity(null);setActivityError('');setActivityLoading(true);
    void client.get<Activity>(`/co-creation/projects/${encodeURIComponent(selected)}/activity`).then(value=>{if(active)setActivity(value);}).catch(cause=>{if(active)setActivityError(cause instanceof Error?cause.message:'Issue 暫時無法載入。');}).finally(()=>{if(active)setActivityLoading(false);});
    return()=>{active=false;};
  },[client,selected]);
  const term=query.trim().toLocaleLowerCase();
  const visibleWorks=works;
  const visibleIssues=(activity?.issues??[]).filter(issue=>!term||[issue.title,...issue.labels].join(' ').toLocaleLowerCase().includes(term));
  const selectedProject=projects.find(project=>project.project_id===selected);
  const repositoryUrl=safeGitHub(selectedProject?.repository_url??'');
  return <section className="experience-panel stack" aria-label="社群任務">
    <div className="experience-intro"><div><p className="eyebrow">COMMUNITY TASKS</p><h2>從一件做得到的事開始共創。</h2><p>社群工作在工坊認領與驗收；GitHub Issue 依專案原始紀錄協作。兩種來源各自保留實際狀態。</p></div></div>
    <div className="card"><MemberContributionOutcomes client={client} revision={outcomeRevision}/></div>
    <div className="experience-filters"><label className="field">搜尋任務<input data-guide-anchor="tasks:search" type="search" maxLength={2000} value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如：設計、文件、開發"/></label><label className="field">工坊工作狀態<select value={scope} onChange={e=>setScope(e.target.value as 'open'|'all')}><option value="open">可認領</option><option value="all">全部</option></select></label><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重新整理</button></div>
    {error&&<p role="alert" className="banner banner-error">{error}</p>}{loading&&<p role="status">正在載入任務…</p>}
    <div className="experience-heading"><h2>工坊工作</h2><span>{visibleWorks.length} 件</span></div>
    {visibleWorks.length?<div className="experience-grid">{visibleWorks.map(item=><article className="card experience-card" key={item.work_item_id}><div className="experience-card-head"><div><span className="experience-kicker">{item.state==='open'?'開放認領':item.state==='accepted'?'已驗收':'認領中'}</span><h3>{item.title}</h3></div></div><p className="multiline-text">{item.objective}</p><p><strong>參與收穫：</strong><span className="multiline-text">{item.gain}</span></p><p className="muted">認領期限：{formatIsoLocal(item.claim_window_expires_at)}</p><WorkContributionRoles client={client} workItemId={item.work_item_id} onChanged={()=>setOutcomeRevision(value=>value+1)}/><div className="experience-actions"><button className="btn btn-primary" type="button" onClick={()=>onNavigate('workbench')}>{item.state==='open'?'查看並認領':'查看工作紀錄'}</button></div></article>)}</div>:!loading&&<p className="empty">目前沒有符合條件的工坊工作。</p>}
    {pageError&&<p role="alert" className="banner banner-error">{pageError}</p>}
    {nextCursor&&<div className="actions"><button type="button" className="btn btn-secondary btn-small" disabled={loadingMore} onClick={()=>void loadMore()}>{loadingMore?'正在載入…':'載入較早的工坊工作'}</button></div>}
    <div className="experience-heading"><h2>GitHub 共創 Issue</h2><span>以原專案為準</span></div>
    <label className="field experience-project-picker">選擇共創專案<select data-guide-anchor="tasks:project" value={selected} onChange={e=>setSelected(e.target.value)}><option value="">選擇專案以查看 Issue</option>{projects.map(project=><option key={project.project_id} value={project.project_id}>{project.title}</option>)}</select></label>
    {selected&&<>{selectedProject&&<p className="muted multiline-text">{selectedProject.goal}</p>}{activityLoading&&<p role="status">正在讀取 GitHub Issue…</p>}{activityError&&<p role="alert" className="banner banner-error">{activityError}</p>}{activity?.unavailable_reason&&<p role="status" className="banner banner-info">{activity.unavailable_reason==='github_unreadable'?'目前無法同步這個 GitHub 儲存庫。請直接到 GitHub 查看。':'GitHub 資料同步中，這次還無法確認任務清單。請直接到 GitHub 查看，或稍後再回來。'}</p>}{activity&&!activity.unavailable_reason&&<>{activity.stale_reason==='github_rate_limited'&&<p role="status" className="banner banner-info">GitHub 暫時限制查詢；以下是 {formatIsoLocal(activity.checked_at)} 讀取的資料，可能已有變更。</p>}{activity.truncated&&<p className="banner banner-info">顯示部分 Issue；完整清單請開啟 GitHub 專案。</p>}{visibleIssues.length?<div className="experience-grid">{visibleIssues.map(issue=><article className="card experience-card" key={issue.number}><span className="experience-kicker">Issue #{issue.number} · {issue.assignees.length?'已有認領者':'尚無認領者'}</span><h3>{issue.title}</h3>{issue.labels.length>0&&<p className="muted">{issue.labels.join(' · ')}</p>}<div className="experience-actions">{safeGitHub(issue.url)&&<a className="btn btn-ghost" href={issue.url} target="_blank" rel="noopener noreferrer">到 GitHub 查看 ↗</a>}</div></article>)}</div>:<p className="empty">這個專案目前沒有符合搜尋的開放 Issue。</p>}</>}{repositoryUrl&&<a className="experience-source" href={repositoryUrl} target="_blank" rel="noopener noreferrer">查看完整 GitHub 專案 ↗</a>}</>}
    <CommunityHistory client={client}/>
  </section>;
}
