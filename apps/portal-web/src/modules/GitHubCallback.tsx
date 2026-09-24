import {useEffect,useRef,useState} from 'react';
import {PortalClient} from '../api';

export function GitHubCallback(){
  const [parameters]=useState(()=>new URLSearchParams(window.location.search));
  const [error,setError]=useState('');
  const operation=useRef<Promise<string>|null>(null);
  useEffect(()=>{
    let active=true;
    if(!operation.current){
      window.history.replaceState(null,'','/github/callback');
      operation.current=(async()=>{
        const state=parameters.get('state'),code=parameters.get('code');
        if(parameters.has('error')||!state||!code)throw Error('尚未連結 GitHub。');
        const client=new PortalClient(),session=await client.getSession();
        client.csrfToken=session.csrf_token;
        const result=await client.post<{return_to:string}>('/me/github/complete',{state,code});
        return /^#[a-z][a-z0-9_-]{0,63}$/.test(result.return_to)?'/'+result.return_to:/^\/development\/skills\/[a-z0-9-]+$/.test(result.return_to)?result.return_to:'/#skills';
      })();
    }
    void operation.current.then(target=>{if(active)window.location.replace(target);}).catch(cause=>{if(active)setError(cause instanceof Error?cause.message:'GitHub 連結未完成。');});
    return()=>{active=false;};
  },[parameters]);
  return <main className="centered"><section className="card stack"><p className="eyebrow">自由工坊</p><h1>連結 GitHub</h1>{error?<><p role="alert">{error}</p><a className="btn btn-primary" href="/#skills">返回技能書架</a></>:<p role="status">正在連結…</p>}</section></main>;
}
