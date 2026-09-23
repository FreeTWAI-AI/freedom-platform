import {useEffect,useRef,useState} from 'react';

type SetupStatus={configured:boolean;setup_available?:boolean;app_slug?:string;html_url?:string};
type Client={request<T>(path:string,body?:unknown):Promise<T>};
export function AdminGitHubSetup({client}:{client:Client}){
  const [status,setStatus]=useState<SetupStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const [parameters]=useState(()=>window.location.pathname==='/admin/github/callback'?new URLSearchParams(window.location.search):null);
  const complete=useRef<Promise<SetupStatus>|null>(null);
  useEffect(()=>{
    let active=true;
    if(parameters){
      if(!complete.current){
        window.history.replaceState(null,'','/admin');
        const code=parameters.get('code'),state=parameters.get('state');
        complete.current=code&&state?client.request<SetupStatus>('/github-app/complete',{code,state}):Promise.reject(Error('GitHub App 建立未完成，請重新開始。'));
      }
      setBusy(true);
      void complete.current.then(result=>{if(active)setStatus({...result,setup_available:true});}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:'GitHub App 設定未完成。');}).finally(()=>{if(active)setBusy(false);});
    }else void client.request<SetupStatus>('/github-app').then(result=>{if(active)setStatus(result);}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:'無法讀取 GitHub 設定。');});
    return()=>{active=false;};
  },[client,parameters]);
  async function begin(){
    if(busy)return;setBusy(true);setError('');
    try{
      const result=await client.request<{target:string;manifest:unknown}>('/github-app/start',{});
      const target=new URL(result.target);
      if(target.origin!=='https://github.com'||target.pathname!=='/organizations/FreeTWAI-AI/settings/apps/new'||target.username||target.password)throw Error('GitHub 設定網址不正確。');
      const form=document.createElement('form');form.method='POST';form.action=target.href;
      const manifest=document.createElement('input');manifest.type='hidden';manifest.name='manifest';manifest.value=typeof result.manifest==='string'?result.manifest:JSON.stringify(result.manifest);
      form.append(manifest);document.body.append(form);form.submit();
    }catch(cause){setError(cause instanceof Error?cause.message:'無法開始 GitHub 設定。');setBusy(false);}
  }
  return <section className="stack"><h2>GitHub 連結</h2>{error&&<p className="banner banner-error" role="alert">{error}</p>}{busy&&<p role="status">正在設定 GitHub…</p>}{status?.configured?<article className="card stack"><h3>GitHub App 已連結</h3><p>Star 需要 Starring 寫入與 Metadata 讀取權限。</p>{status.html_url&&<a href={status.html_url} target="_blank" rel="noopener noreferrer">{status.app_slug??'GitHub App'} ↗</a>}{status.app_slug&&<a href={`https://github.com/organizations/FreeTWAI-AI/settings/apps/${encodeURIComponent(status.app_slug)}/permissions`} target="_blank" rel="noopener noreferrer">檢查 GitHub App 權限 ↗</a>}{status.app_slug&&<a href={`https://github.com/apps/${encodeURIComponent(status.app_slug)}/installations/new`} target="_blank" rel="noopener noreferrer">安裝到技能書 Repo ↗</a>}</article>:<article className="card stack"><h3>啟用站內 Star</h3><p>由 FreeTWAI-AI 擁有者建立，需要星星操作與專案基本資料讀取權限。</p><button type="button" className="btn btn-primary" disabled={busy||!status?.setup_available} onClick={()=>void begin()}>建立 GitHub App</button>{status&&!status.setup_available&&<p className="field-hint">GitHub 連結設定尚未啟用。</p>}{error&&<a href="/admin">返回後台</a>}</article>}</section>;
}
