import {useEffect,useState} from 'react';
import {ApiError,type PortalClient} from '../api';
export function EventOutcomeBacklinks({client,kind,sourceId,publicRead=false}:{client:PortalClient;kind:'work'|'skill_book'|'squad_outcome';sourceId:string;publicRead?:boolean}){
 const [items,setItems]=useState<{outcome_id:string;event_id:string;event_title:string;title:string;path:string}[]>([]),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 useEffect(()=>{let current=true;setItems([]);setError('');void client.get<{items:{outcome_id:string;event_id:string;event_title:string;title:string;path:string}[]}>(`${publicRead?'/public':''}/event-outcome-backlinks/${kind}/${encodeURIComponent(sourceId)}`,{background:true}).then(value=>{if(current)setItems(value.items);}).catch(reason=>{if(current&&!(reason instanceof ApiError&&reason.status===404))setError(reason instanceof Error?reason.message:'活動來源目前無法讀取。');});return()=>{current=false;};},[client,kind,sourceId,publicRead,revision]);
 if(!items.length&&!error)return null;
 return <section className="stack outcome-section" aria-label="來自哪場活動"><h3>來自哪場活動</h3>{items.length>0&&<ul>{items.map(item=><li key={item.outcome_id}><a href={item.path}>{item.event_title} · {item.title}</a></li>)}</ul>}{error&&<><p role="alert">{error}</p><button type="button" className="btn btn-secondary btn-small" onClick={()=>setRevision(value=>value+1)}>重新載入活動來源</button></>}</section>;
}
