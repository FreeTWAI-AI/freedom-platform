import { useCallback, useEffect, useState } from 'react';
import type { PortalClient } from '../api';
import type { TabId, WorkItem } from '../types';
import { formatIsoLocal } from '../format';
import './MemberExperience.css';

type Records = {policy:string;accepted_count:number;entries:{contribution_id:string;work_item_id:string;decision_id:string;title:string;accepted_at:string;acting_profession_membership_ref:string}[]};
type Project = {project_id:string;title:string;goal:string;repository_url:string;repository_full_name:string};
type Issue = {number:number;title:string;url:string;labels:string[];assignees:string[]};
type Activity = {issues:Issue[];checked_at:string;truncated:boolean;stale_reason?:'github_rate_limited';unavailable_reason?:'github_rate_limited'};
const safeGitHub=(url:string)=>{try{const parsed=new URL(url);return parsed.protocol==='https:'&&parsed.hostname==='github.com'&&!parsed.username&&!parsed.password?url:null;}catch{return null;}};

export function TaskBoardPanel({client,onNavigate}:{client:PortalClient;onNavigate:(tab:TabId)=>void}) {
  const [works,setWorks]=useState<WorkItem[]>([]),[projects,setProjects]=useState<Project[]>([]),[records,setRecords]=useState<Records|null>(null);
  const [loading,setLoading]=useState(true),[error,setError]=useState(''),[query,setQuery]=useState(''),[scope,setScope]=useState<'open'|'all'>('open');
  const [selected,setSelected]=useState(''),[activity,setActivity]=useState<Activity|null>(null),[activityLoading,setActivityLoading]=useState(false),[activityError,setActivityError]=useState('');
  const load=useCallback(async()=>{
    setLoading(true);setError('');
    const results=await Promise.allSettled([client.get<{items:WorkItem[]}>('/work-items'),client.get<{items:Project[]}>('/co-creation/projects'),client.get<Records>('/me/contribution-records')]);
    if(results[0].status==='fulfilled')setWorks(results[0].value.items);else setError('社群工作暫時無法載入。');
    if(results[1].status==='fulfilled')setProjects(results[1].value.items);else setError(value=>value+' GitHub 共創專案暫時無法載入。');
    if(results[2].status==='fulfilled')setRecords(results[2].value);else setError(value=>value+' 驗收紀錄暫時無法載入。');
    setLoading(false);
  },[client]);
  useEffect(()=>{void load();},[load]);
  useEffect(()=>{
    if(!selected){setActivity(null);return;}
    let active=true;setActivity(null);setActivityError('');setActivityLoading(true);
    void client.get<Activity>(`/co-creation/projects/${encodeURIComponent(selected)}/activity`).then(value=>{if(active)setActivity(value);}).catch(cause=>{if(active)setActivityError(cause instanceof Error?cause.message:'Issue 暫時無法載入。');}).finally(()=>{if(active)setActivityLoading(false);});
    return()=>{active=false;};
  },[client,selected]);
  const term=query.trim().toLocaleLowerCase();
  const visibleWorks=works.filter(item=>(scope==='all'||(item.state==='open'&&Date.parse(item.claim_window_expires_at)>Date.now()))&&(!term||[item.title,item.objective,item.gain].join(' ').toLocaleLowerCase().includes(term)));
  const visibleIssues=(activity?.issues??[]).filter(issue=>!term||[issue.title,...issue.labels].join(' ').toLocaleLowerCase().includes(term));
  const selectedProject=projects.find(project=>project.project_id===selected);
  const repositoryUrl=safeGitHub(selectedProject?.repository_url??'');
  return <section className="experience-panel stack" aria-label="社群任務榜">
    <div className="experience-intro"><div><p className="eyebrow">COMMUNITY TASKS</p><h2>從一件做得到的事開始共創。</h2><p>社群工作在工坊認領與驗收；GitHub Issue 依專案原始紀錄協作。兩種來源各自保留實際狀態。</p></div></div>
    <div className="experience-points card"><div><span className="experience-kicker">我的驗收工作</span><strong>{records?.accepted_count??'—'} 件</strong><p>每件通過驗收的工作保留工作、決定與當時職業身分的來源。分數規則另訂；這裡不顯示暫定分數。</p></div><details><summary>查看驗收紀錄（{records?.accepted_count??0} 件）</summary>{records?.entries.length?<ol>{records.entries.map(entry=><li key={entry.contribution_id}><strong>{entry.title}</strong> · {formatIsoLocal(entry.accepted_at)}<small>來源工作：{entry.work_item_id} · 驗收決定：{entry.decision_id}</small></li>)}</ol>:<p>完成並通過一件社群工作驗收後，紀錄會出現在這裡。</p>}</details></div>
    <div className="experience-filters"><label className="field">搜尋任務<input type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="例如：設計、文件、開發"/></label><label className="field">工坊工作狀態<select value={scope} onChange={e=>setScope(e.target.value as 'open'|'all')}><option value="open">可認領</option><option value="all">全部</option></select></label><button type="button" className="btn btn-ghost" onClick={()=>void load()}>重新整理</button></div>
    {error&&<p role="alert" className="banner banner-error">{error}</p>}{loading&&<p role="status">正在載入任務…</p>}
    <div className="experience-heading"><h2>工坊工作</h2><span>{visibleWorks.length} 件</span></div>
    {visibleWorks.length?<div className="experience-grid">{visibleWorks.map(item=><article className="card experience-card" key={item.work_item_id}><div className="experience-card-head"><div><span className="experience-kicker">{item.state==='open'?'開放認領':item.state==='accepted'?'已驗收':'認領中'}</span><h3>{item.title}</h3></div></div><p>{item.objective}</p><p><strong>參與收穫：</strong>{item.gain}</p><p className="muted">認領期限：{formatIsoLocal(item.claim_window_expires_at)}</p><div className="experience-actions"><button className="btn btn-primary" type="button" onClick={()=>onNavigate('workbench')}>{item.state==='open'?'查看並認領':'查看工作紀錄'}</button></div></article>)}</div>:!loading&&<p className="empty">目前沒有符合條件的工坊工作。</p>}
    <div className="experience-heading"><h2>GitHub 共創 Issue</h2><span>以原專案為準</span></div>
    <label className="field experience-project-picker">選擇共創專案<select value={selected} onChange={e=>setSelected(e.target.value)}><option value="">選擇專案以查看 Issue</option>{projects.map(project=><option key={project.project_id} value={project.project_id}>{project.title}</option>)}</select></label>
    {selected&&<>{selectedProject&&<p className="muted">{selectedProject.goal}</p>}{activityLoading&&<p role="status">正在讀取 GitHub Issue…</p>}{activityError&&<p role="alert" className="banner banner-error">{activityError}</p>}{activity?.unavailable_reason&&<p role="status" className="banner banner-info">GitHub 暫時限制查詢，這次無法確認任務清單。請直接到 GitHub 查看；稍後可回來更新。</p>}{activity&&!activity.unavailable_reason&&<>{activity.stale_reason==='github_rate_limited'&&<p role="status" className="banner banner-info">GitHub 暫時限制查詢；以下是 {formatIsoLocal(activity.checked_at)} 讀取的資料，可能已有變更。</p>}{activity.truncated&&<p className="banner banner-info">顯示部分 Issue；完整清單請開啟 GitHub 專案。</p>}{visibleIssues.length?<div className="experience-grid">{visibleIssues.map(issue=><article className="card experience-card" key={issue.number}><span className="experience-kicker">Issue #{issue.number} · {issue.assignees.length?'已有認領者':'尚無認領者'}</span><h3>{issue.title}</h3>{issue.labels.length>0&&<p className="muted">{issue.labels.join(' · ')}</p>}<div className="experience-actions">{safeGitHub(issue.url)&&<a className="btn btn-ghost" href={issue.url} target="_blank" rel="noopener noreferrer">到 GitHub 查看 ↗</a>}</div></article>)}</div>:<p className="empty">這個專案目前沒有符合搜尋的開放 Issue。</p>}</>}{repositoryUrl&&<a className="experience-source" href={repositoryUrl} target="_blank" rel="noopener noreferrer">查看完整 GitHub 專案 ↗</a>}</>}
  </section>;
}
