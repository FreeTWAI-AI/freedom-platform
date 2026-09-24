import {useEffect,useState} from 'react';
import type {TabId} from '../types';
import {useGitHubSocialStore} from './GitHubSocial';
import './MemberSettings.css';

type TaskState='loading'|'error'|'unavailable'|'todo'|'done';
const stateLabels:Record<TaskState,string>={loading:'讀取中',error:'狀態讀取失敗',unavailable:'尚未啟用',todo:'待完成',done:'已完成'};

/** Task completion is derived from the real GitHub connection; members cannot tick it by hand. */
export function MemberTasks({onNavigate}:{onNavigate:(id:TabId)=>void}){
  const store=useGitHubSocialStore();
  const [busy,setBusy]=useState(false),[connectError,setConnectError]=useState('');
  useEffect(()=>{void store.loadAccount();},[store]);
  const {value,loading,error}=store.account;
  const state:TaskState=error?'error':!value?'loading':value.connected?'done':value.configured?'todo':'unavailable';
  async function connect(){
    setBusy(true);setConnectError('');
    try{window.location.assign(await store.connect('#todos'));}
    catch(cause){setConnectError(cause instanceof Error?cause.message:'無法連結 GitHub，請重試。');setBusy(false);}
  }
  const retry=<button className="btn btn-ghost" type="button" disabled={loading||busy} onClick={()=>{setConnectError('');void store.refreshConnection();}}>重新讀取 GitHub 連結</button>;
  return <section className="member-tasks" aria-labelledby="member-tasks-required">
    <h2 id="member-tasks-required" className="member-section-title">必做待辦</h2>
    <ul className="messages-list">
      <li><article className="member-task" aria-labelledby="task-github-title" data-task="github" data-task-state={state}>
        <div className="member-task-heading"><h3 id="task-github-title">連結 GitHub</h3>
          <span className={`task-state task-state-${state}`} role="status">{stateLabels[state]}</span></div>
        {state==='loading'&&<p>正在確認 GitHub 連結…</p>}
        {state==='error'&&<><p role="alert">{error}</p><div className="member-task-actions">{retry}</div></>}
        {state==='unavailable'&&<><p>GitHub 連結目前尚未啟用，這項待辦暫時無法完成；啟用後即可連結。</p><div className="member-task-actions">{retry}</div></>}
        {state==='todo'&&<><p>連結你的 GitHub，管理技能書按星與開發授權。</p>
          <div className="member-task-actions"><button className="btn btn-primary" type="button" disabled={busy||loading} onClick={()=>void connect()}>{busy?'前往 GitHub…':'連結 GitHub'}</button></div></>}
        {state==='done'&&<><p>已連結 <strong>@{value?.github_user?.login??'GitHub'}</strong>。</p>
          <div className="member-task-actions"><button className="btn btn-ghost" type="button" onClick={()=>onNavigate('account')}>到我的名片管理 GitHub 連結</button></div></>}
        {connectError&&<p role="alert">{connectError}</p>}
      </article></li>
    </ul>
  </section>;
}
