import {createContext,useContext,useEffect,useId,useMemo,useRef,useState,useSyncExternalStore,type ReactNode} from 'react';
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

export function GitHubBookSocial({bookId,repositoryUrl,showFork=true,compact=false}:{bookId:string;repositoryUrl:string;showFork?:boolean;compact?:boolean}){
  const store=useContext(SocialContext)??publicStore;
  const starCountId=useId();
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
  const secondaryMetrics=<><div><dt>待處理 Issues／PR</dt><dd>{count(value?.open_issues_count)}</dd></div><div><dt>追蹤</dt><dd>{count(value?.subscribers_count)}</dd></div><div><dt>最近更新</dt><dd>{date(value?.pushed_at)}</dd></div></>;
  const metricsNote=<p className="github-metrics-note">{metrics.loading&&!value?'正在讀取 GitHub 數據…':unknown?'GitHub 數據暫時無法讀取':`${old?'上次取得的數據':'數據更新'} · ${date(value?.checked_at)}`}{value?.language?` · ${value.language}`:''}</p>;
  const source=<div className="github-social-source"><a href={repositoryUrl} target="_blank" rel="noopener noreferrer">原作者 GitHub ↗</a>{value?.archived&&<span className="badge">已封存</span>}</div>;
  const accountLoading=account.loading&&!account.value;
  const actionLabel=!store.member?'登入後 Star':accountLoading?'確認 GitHub 連結…':account.error?'重新確認 GitHub 連結':!account.value?.configured?'GitHub 連結尚未啟用':!connected?connecting?'前往 GitHub…':'連結 GitHub 後 Star':star.saving?'正在保存…':!known?'Star 狀態待確認':star.value?.starred?'取消 Star':'Star';
  const actionHint=store.member&&account.value?.configured&&!connected&&!connecting&&!account.error?'連結 GitHub，回來後再點星星。':actionLabel;
  const disabled=account.error?false:Boolean(accountLoading||!account.value?.configured||connecting||connected&&(star.loading||star.saving||!known));
  const starIcon=connected&&known&&star.value?.starred?'★':'☆';
  const starContents=<><span className="github-star-icon" aria-hidden="true">{starIcon}</span><span className="github-star-count" id={starCountId}>{count(value?.stargazers_count)}</span></>;
  const forkContents=<><svg className="github-fork-icon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="6" cy="5" r="2.3"/><circle cx="18" cy="5" r="2.3"/><circle cx="12" cy="19" r="2.3"/><path d="M6 7.5v2.8c0 2.8 6 1.2 6 5.3v1.1M18 7.5v2.8c0 2.8-6 1.2-6 5.3"/></svg><span className="github-fork-count">{count(value?.forks_count)}</span></>;
  function starAction(){if(account.error)void store.loadAccount(true);else if(!connected)void connect();else if(known&&!star.loading&&!star.saving)void store.toggleStar(bookId);}
  const actionStatus=accountLoading||connecting||connected&&(!known||star.saving)?actionLabel:store.member&&!account.error&&!account.value?.configured?'GitHub Star 尚未啟用':null;
  return <div className={`github-book-social${compact?' github-book-social-compact':''}`} ref={ref} data-github-book={bookId} aria-label="原作者 GitHub 數據與操作">
    {!compact&&source}
    <div className="github-social-overview"><div className="github-social-actions">
      {!store.member?<a className="btn btn-ghost github-star-control" href="/#community" aria-label={actionLabel} aria-describedby={starCountId} title={actionLabel}>{starContents}</a>:<button className="btn btn-ghost skill-book-star github-star-control" aria-label={actionLabel} aria-description={actionHint} aria-describedby={starCountId} title={`${actionHint} · ${count(value?.stargazers_count)} Stars`} aria-pressed={connected&&known?star.value!.starred!:undefined} aria-busy={star.saving||connecting||accountLoading} disabled={disabled} onClick={starAction}>{starContents}</button>}
      {showFork?<a className="github-fork-link github-count-control" href={`${repositoryUrl}/fork`} target="_blank" rel="noopener noreferrer" aria-label="Fork 專案 ↗" title={`Fork 專案 · ${count(value?.forks_count)} Forks`}>{forkContents}</a>:<span className="github-count-control github-fork-stat" title="GitHub Forks" aria-label={`${count(value?.forks_count)} Forks`}>{forkContents}</span>}
      {(metrics.error||value?.error)&&<button className="github-retry" onClick={()=>void store.loadMetrics(bookId,true)} disabled={metrics.loading}>重讀數據</button>}
      {connected&&star.error&&<button className="github-retry" onClick={()=>void store.loadStar(bookId,true)} disabled={star.loading||star.saving}>重讀 Star 狀態</button>}
    </div>
    {compact&&<details className="github-metrics-details"><summary aria-label="更多 GitHub 數據">更多</summary><div className="github-metrics-expanded">{source}<dl className="github-book-metrics">{secondaryMetrics}</dl>{!unknown&&!old&&metricsNote}</div></details>}
    </div>
    {!compact&&<dl className="github-book-metrics">{secondaryMetrics}</dl>}
    {(!compact||unknown||old)&&metricsNote}
    {actionStatus&&<p className="github-action-status" role={star.saving||connecting?'status':undefined}>{actionStatus}</p>}
    {(connectError||account.error||star.error)&&<p className="github-social-error" role="alert">{connectError||account.error||star.error}</p>}
  </div>;
}
