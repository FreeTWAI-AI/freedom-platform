import {useState} from 'react';
import {ApiError} from '../api';
import type {ModulePanelProps} from './shared';
import {GitHubSocialStore} from './github-social-client';

type FollowState={username:string;connected:boolean;following:boolean|null;confirmed?:boolean};
export function GitHubAuthorFollow({username,client}:Pick<ModulePanelProps,'client'>&{username:string}){
  const [state,setState]=useState<FollowState|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[reauthorize,setReauthorize]=useState(false);
  const path=`/me/github/authors/${encodeURIComponent(username)}/follow`;
  async function read(){
    setBusy(true);setError('');setReauthorize(false);
    try{const value=await client.get<FollowState>(path);setState(value);if(!value.connected){setError('請先連結 GitHub。');setReauthorize(true);}}
    catch(cause){failure(cause);}
    finally{setBusy(false);}
  }
  function failure(cause:unknown){
    setState(null);setError(cause instanceof Error?cause.message:'GitHub 操作未確認，請重新查詢。');
    setReauthorize(cause instanceof ApiError&&['github_connect_required','github_reconnect_required','github_follow_permission_required','github_permission_required'].includes(cause.code??''));
  }
  async function toggle(){
    if(typeof state?.following!=='boolean')return;
    setBusy(true);setError('');setReauthorize(false);
    try{setState(await client.post<FollowState>(path,{following:!state.following,confirmed:true}));}
    catch(cause){failure(cause);}
    finally{setBusy(false);}
  }
  async function connect(){
    setBusy(true);setError('');
    try{
      const store=new GitHubSocialStore(client,true);await store.loadAccount(true);
      window.location.assign(await store.connect(window.location.hash||'#opensource'));
    }catch(cause){setError(cause instanceof Error?cause.message:'無法重新授權 GitHub。');setBusy(false);}
  }
  return <div className="stack"><div className="actions"><a href={`https://github.com/${encodeURIComponent(username)}`} target="_blank" rel="noopener noreferrer">GitHub 作者：{username} ↗</a>{typeof state?.following==='boolean'?<button className="btn btn-ghost" disabled={busy} aria-pressed={state.following} onClick={()=>void toggle()}>{busy?'處理中…':state.following?'Unfollow GitHub 作者':'Follow GitHub 作者'}</button>:<button className="btn btn-ghost" disabled={busy} onClick={()=>void read()}>{busy?'查詢中…':'查詢 GitHub Follow'}</button>}{reauthorize&&<button className="btn btn-ghost" disabled={busy} onClick={()=>void connect()}>連結／重新授權 GitHub</button>}</div><p className="hint">操作的是 GitHub 帳號追蹤，不是工坊站內追蹤；組織帳號不能 Follow。</p>{error&&<p role="alert" className="banner banner-error">{error}</p>}</div>;
}
