import {useEffect,useState} from 'react';
import type {PortalClient} from '../api';

type Submission={submission_id:string;title:string;description:string;public_path:string;illustration_url:string|null;source:{repository_full_name:string}};

export function CommunitySubmissions({client,revision=0}:{client:PortalClient;revision?:number}){
  const [items,setItems]=useState<Submission[]>([]),[error,setError]=useState(false),[retry,setRetry]=useState(0),[query,setQuery]=useState('');
  useEffect(()=>{
    let active=true;setError(false);
    void client.get<{items:Submission[]}>('/skill-submissions/published').then(result=>{if(active)setItems(result.items);}).catch(()=>{if(active)setError(true);});
    return()=>{active=false;};
  },[client,revision,retry]);
  if(error)return <p role="alert" className="field-hint">社群投稿暫時無法載入。<button type="button" className="btn btn-ghost" onClick={()=>setRetry(value=>value+1)}>重讀社群投稿</button></p>;
  if(!items.length)return null;
  const filtered=items.filter(item=>[item.title,item.description,item.source.repository_full_name].some(value=>value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())));
  return <details className="card community-submissions"><summary>社群投稿 · {items.length}</summary><div className="stack">
    <label className="field">搜尋社群投稿<input type="search" value={query} onChange={event=>setQuery(event.target.value)}/></label>
    <div className="card-grid">{filtered.map(item=><article className="card stack" key={item.submission_id}>
      <div className="skill-library-heading">{item.illustration_url&&<img src={item.illustration_url} width="80" height="48" loading="lazy" alt=""/>}<div className="skill-library-copy"><p className="eyebrow">社群投稿</p><h3>{item.title}</h3></div></div>
      <p className="skill-library-purpose">{item.description.length>130?item.description.slice(0,130)+'…':item.description}</p>
      <a className="btn btn-ghost" href={item.public_path}>閱讀介紹與分享 ↗</a>
    </article>)}</div>{!filtered.length&&<p className="field-hint">沒有符合的投稿。</p>}
  </div></details>;
}
