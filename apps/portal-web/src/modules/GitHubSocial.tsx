import {createContext,useContext,useEffect,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
import {PortalClient} from '../api';
import type {SessionPayload} from '../types';
import {GitHubSocialStore} from './github-social-client';

const SocialContext=createContext<GitHubSocialStore|null>(null);
const publicStore=new GitHubSocialStore(new PortalClient(),false);
export function GitHubSocialProvider({client,session,children}:{client:PortalClient;session:SessionPayload;children:ReactNode}){
  const store=useMemo(()=>new GitHubSocialStore(client,true),[client,session.user.user_id,session.csrf_token]);
  useEffect(()=>{const refresh=()=>void store.refreshConnection();window.addEventListener('freedom-github-updated',refresh);return()=>window.removeEventListener('freedom-github-updated',refresh);},[store]);
  return <SocialContext.Provider value={store}>{children}</SocialContext.Provider>;
}
export function GitHubConnectionPanel(){
  const store=useContext(SocialContext)??publicStore;
  useSyncExternalStore(store.subscribe,store.snapshot,store.snapshot);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[remoteRemaining,setRemoteRemaining]=useState(false);
  useEffect(()=>{void store.loadAccount();},[store]);
  if(!store.member)return null;
  const {value,loading}=store.account;
  async function connect(){setBusy(true);setError('');setNotice('');try{window.location.assign(await store.connect(window.location.hash||'#account'));}catch(cause){setError(cause instanceof Error?cause.message:'無法連結 GitHub，請重試。');setBusy(false);}}
  async function disconnect(){
    setBusy(true);setError('');setNotice('');
    try{const result=await store.disconnect(),remaining=result.provider_revoked!==true;setRemoteRemaining(remaining);setNotice(remaining?'已解除工坊連結；可到 GitHub 設定撤銷授權。':'已解除 GitHub 連結。');}
    catch(cause){setError(cause instanceof Error?cause.message:'解除連結結果待確認，請重新讀取。');}
    finally{setBusy(false);}
  }
  return <section className="card stack github-connection-panel"><h2>GitHub 連結</h2>
    {value?.connected?<><p>已連結 <strong>@{value.github_user?.login??'GitHub'}</strong></p><button className="btn btn-ghost" disabled={busy||loading} onClick={()=>void disconnect()}>{busy?'正在處理…':'解除 GitHub 連結'}</button></>:value?.configured?<><p className="muted">連結後，可直接在技能書上 Star 原作者專案。</p><button className="btn btn-ghost" disabled={busy||loading} onClick={()=>void connect()}>{busy?'前往 GitHub…':'連結 GitHub'}</button></>:<button className="btn btn-ghost" disabled>{loading?'確認 GitHub 連結…':'GitHub 連結尚未啟用'}</button>}
    {(error||store.account.error)&&<div className="banner banner-error" role="alert">{error||store.account.error}<button className="btn btn-ghost" disabled={busy||loading} onClick={()=>{setError('');void store.refreshConnection();}}>重新讀取 GitHub 連結</button></div>}
    {notice&&<p role="status">{notice}{remoteRemaining&&<> <a href="https://github.com/settings/apps/authorizations" target="_blank" rel="noopener noreferrer">GitHub 授權設定 ↗</a></>}</p>}
  </section>;
}
function count(value:number|null|undefined){return typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('zh-TW'):'—';}
function date(value:string|null|undefined){return value&&!Number.isNaN(Date.parse(value))?new Date(value).toLocaleDateString('zh-TW'):'—';}

export function GitHubBookSocial({bookId,repositoryUrl,showFork=true}:{bookId:string;repositoryUrl:string;showFork?:boolean}){
  const store=useContext(SocialContext)??publicStore;
  useSyncExternalStore(store.subscribe,store.snapshot,store.snapshot);
  const ref=useRef<HTMLDivElement>(null),[visible,setVisible]=useState(false),[connecting,setConnecting]=useState(false),[connectError,setConnectError]=useState('');
  const metrics=store.metric(bookId),star=store.star(bookId),account=store.account;
  useEffect(()=>{
    const node=ref.current;if(!node)return;
    if(typeof IntersectionObserver==='undefined'){setVisible(true);return;}
    const observer=new IntersectionObserver(entries=>{if(entries.some(item=>item.isIntersecting)){setVisible(true);observer.disconnect();}});
    observer.observe(node);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{if(visible){void store.loadMetrics(bookId);void store.loadAccount();}},[store,bookId,visible]);
  useEffect(()=>{if(visible&&account.value?.connected)void store.loadStar(bookId);},[store,bookId,visible,account.value]);
  const value=metrics.value,connected=account.value?.connected===true&&star.value?.connected!==false,known=typeof star.value?.starred==='boolean';
  const old=Boolean(value?.stale||value?.error||metrics.error),unknown=!value||value.error&&!value.checked_at;
  async function connect(){
    setConnecting(true);setConnectError('');
    try{window.location.assign(await store.connect(window.location.hash||'#community'));}
    catch(cause){setConnectError(cause instanceof Error?cause.message:'無法連結 GitHub，請重試。');setConnecting(false);}
  }
  return <div className="github-book-social" ref={ref} data-github-book={bookId} aria-label="原作者 GitHub 數據與操作">
    <div className="github-social-source"><a href={repositoryUrl} target="_blank" rel="noopener noreferrer">原作者 GitHub ↗</a>{value?.archived&&<span className="badge">已封存</span>}</div>
    <dl className="github-book-metrics">
      <div><dt>Stars</dt><dd>{count(value?.stargazers_count)}</dd></div>
      <div><dt>Forks</dt><dd>{count(value?.forks_count)}</dd></div>
      <div><dt>待處理 Issues／PR</dt><dd>{count(value?.open_issues_count)}</dd></div>
      <div><dt>追蹤</dt><dd>{count(value?.subscribers_count)}</dd></div>
      <div><dt>最近更新</dt><dd>{date(value?.pushed_at)}</dd></div>
    </dl>
    <p className="github-metrics-note">{metrics.loading&&!value?'正在讀取 GitHub 數據…':unknown?'GitHub 數據暫時無法讀取':`${old?'上次取得的數據':'數據更新'} · ${date(value?.checked_at)}`}{value?.language?` · ${value.language}`:''}</p>
    <div className="github-social-actions">
      {!store.member?<a className="btn btn-ghost" href="/#community">登入後 Star</a>:account.loading&&!account.value?<button className="btn btn-ghost" disabled>確認 GitHub 連結…</button>:account.error?<button className="btn btn-ghost" onClick={()=>void store.loadAccount(true)}>重新確認 GitHub 連結</button>:!account.value?.configured?<button className="btn btn-ghost" disabled>GitHub 連結尚未啟用</button>:!connected?<button className="btn btn-ghost" disabled={connecting} onClick={()=>void connect()}>{connecting?'前往 GitHub…':'連結 GitHub 後 Star'}</button>:<button className="btn btn-ghost skill-book-star" aria-pressed={known?star.value!.starred!:undefined} disabled={star.loading||star.saving||!known} onClick={()=>void store.toggleStar(bookId)}><span aria-hidden="true">{star.value?.starred?'★':'☆'}</span>{star.saving?'正在保存…':!known?'Star 狀態待確認':star.value?.starred?'取消 Star':'Star'}</button>}
      {showFork&&<a className="github-fork-link" href={`${repositoryUrl}/fork`} target="_blank" rel="noopener noreferrer">Fork 專案 ↗</a>}
      {(metrics.error||value?.error)&&<button className="github-retry" onClick={()=>void store.loadMetrics(bookId,true)} disabled={metrics.loading}>重讀數據</button>}
      {connected&&star.error&&<button className="github-retry" onClick={()=>void store.loadStar(bookId,true)} disabled={star.loading||star.saving}>重讀 Star 狀態</button>}
    </div>
    {(connectError||account.error||star.error)&&<p className="github-social-error" role="alert">{connectError||account.error||star.error}</p>}
  </div>;
}
