import {useState} from 'react';
import type {ModulePanelProps} from './shared';
import {useGitHubSocialStore} from './GitHubSocial';

export function GitHubAuthorFollow({username}:Pick<ModulePanelProps,'client'>&{username:string}){
  const store=useGitHubSocialStore(),entry=store.follow(username),state=entry.value;
  const [connecting,setConnecting]=useState(false),[connectError,setConnectError]=useState('');
  const busy=entry.loading||entry.saving||connecting,error=connectError||entry.error;
  async function connect(){
    setConnecting(true);setConnectError('');
    try{
      await store.loadAccount(true);
      window.location.assign(await store.connect(window.location.hash||'#opensource'));
    }catch(cause){setConnectError(cause instanceof Error?cause.message:'無法重新授權 GitHub。');setConnecting(false);}
  }
  return <div className="stack"><div className="actions"><a href={`https://github.com/${encodeURIComponent(username)}`} target="_blank" rel="noopener noreferrer">GitHub 作者：{username} ↗</a>{typeof state?.following==='boolean'?<button className="btn btn-ghost" disabled={busy} aria-pressed={state.following} onClick={()=>{setConnectError('');void store.toggleFollow(username)}}>{busy?'處理中…':state.following?'Unfollow GitHub 作者':'Follow GitHub 作者'}</button>:<button className="btn btn-ghost" disabled={busy} onClick={()=>{setConnectError('');void store.loadFollow(username,true)}}>{busy?'查詢中…':'查詢 GitHub Follow'}</button>}{entry.reauthorize&&<button className="btn btn-ghost" disabled={busy} onClick={()=>void connect()}>連結／重新授權 GitHub</button>}</div><p className="hint">操作的是 GitHub 帳號追蹤，不是工坊站內追蹤；組織帳號不能 Follow。</p>{state?.connected===false&&<p role="alert">請先連結 GitHub。</p>}{error&&<p role="alert" className="banner banner-error">{error}</p>}</div>;
}
