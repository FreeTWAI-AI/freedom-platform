import {useEffect,useId,useRef,useState} from 'react';
import type {PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import {MemberAvatar} from './MemberAvatar';

type Attendee={kind:'member';user_id:string;nickname:string;avatar_url:string|null;registered_at:string}|{kind:'guest';registered_at:string};
type Page={items:Attendee[];total:number;next_offset:number|null};

/** Organizer-only registration list. Guests appear only as a registration time; no contact data is shown. */
export function EventAttendees({client,event,onClose}:{client:PortalClient;event:{event_id:string;title:string}|null;onClose:()=>void}){
  const dialog=useRef<HTMLDialogElement>(null),id=useId(),request=useRef(0);
  const [items,setItems]=useState<Attendee[]>([]),[total,setTotal]=useState(0),[next,setNext]=useState<number|null>(null),[loading,setLoading]=useState(false),[error,setError]=useState('');
  async function load(offset:number){
    if(!event)return;
    const token=++request.current;setLoading(true);setError('');
    try{
      const page=await client.get<Page>(`/events/${event.event_id}/attendees?limit=50&offset=${offset}`);
      if(token!==request.current)return;
      setItems(current=>offset?[...current,...page.items]:page.items);setTotal(page.total);setNext(page.next_offset);
    }catch(cause){if(token===request.current)setError(cause instanceof Error?cause.message:'報名名單暫時無法讀取。');}
    finally{if(token===request.current)setLoading(false);}
  }
  useEffect(()=>{
    const element=dialog.current;if(!element)return;
    if(event){setItems([]);setTotal(0);setNext(null);if(!element.open)element.showModal();void load(0);}
    else{request.current++;if(element.open)element.close();}
  },[event?.event_id]);
  return <dialog ref={dialog} className="event-attendees-dialog" aria-labelledby={`${id}-title`} onCancel={e=>{e.preventDefault();onClose();}}>
    {event&&<div className="stack">
      <header className="event-attendees-head"><h3 id={`${id}-title`}>報名名單</h3><button type="button" className="btn btn-ghost" onClick={onClose}>關閉</button></header>
      <p className="muted">{event.title} · 目前 {total} 人報名</p>
      <p className="field-hint">只有主辦者看得到。公開報名的訪客只顯示報名時間，聯絡資料不在這裡顯示。</p>
      {error&&<div className="banner banner-error" role="alert">{error}<button type="button" className="btn btn-ghost" onClick={()=>void load(items.length)}>重試</button></div>}
      {!loading&&!error&&items.length===0&&<p className="empty">還沒有人報名。</p>}
      {items.length>0&&<ol className="event-attendee-list">{items.map((item,index)=><li key={item.kind==='member'?item.user_id:`guest-${index}`}>
        {item.kind==='member'?<><MemberAvatar nickname={item.nickname} avatarUrl={item.avatar_url}/><strong>{item.nickname}</strong></>:<><span className="event-attendee-guest" aria-hidden="true">訪</span><strong>公開報名訪客</strong></>}
        <time dateTime={item.registered_at}>{formatIsoLocal(item.registered_at)}</time>
      </li>)}</ol>}
      {loading&&<p role="status">正在讀取報名名單…</p>}
      {next!==null&&!loading&&<button type="button" className="btn btn-ghost" onClick={()=>void load(next)}>載入更多</button>}
    </div>}
  </dialog>;
}
