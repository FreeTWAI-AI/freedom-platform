import {useEffect,useLayoutEffect,useId,useRef,useState,type FormEvent} from 'react';
import {ApiError,type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import type {SessionPayload,TabId} from '../types';
import {announceInboxChange,type InboxUnread} from './member-inbox';
import {logConsoleEvent} from '../game-console-core';
import {consoleChannel} from '../game-console-routing';
import './MemberSettings.css';

export type ChannelKind='guild'|'squad'|'world';
type ChannelSummary={kind:ChannelKind;channel_key:string;name:string;unread_count:number;last_message_at:string|null};
type ChannelPage={items:ChannelSummary[];unread_count:number;next_offset:number|null};
type ChannelMessage={message_id:string;kind:ChannelKind;channel_key:string;sequence:string;sender_ref:string;sender_name:string;body:string;created_at:string};
type History={channel:{kind:ChannelKind;channel_key:string;name:string};items:ChannelMessage[];unread_count:number;next_offset:number|null;next_after_sequence?:string|null};
type Activity={latest_sequence:string;unread_count:number};
type Pending={key:string;body:string;status:'sending'|'unknown'};
type Props={client:PortalClient;session:SessionPayload;kind:ChannelKind;onUnread:(count:InboxUnread)=>void;onNavigate:(id:TabId)=>void;active?:boolean;compact?:boolean;openChannel?:{key:string;request:number}|null};

const PAGE=20,MAX_BODY=2000,LIVE_POLL_MS=1000;
const copy={
  guild:{title:'公會閒聊',unit:'公會',pick:'從頻道列表選擇一個公會後才會讀取訊息。',empty:'你還沒有加入任何公會，加入後會出現該公會的閒聊頻道。',home:'guilds',homeLabel:'前往職業公會',back:'回到職業公會'},
  squad:{title:'小隊閒聊',unit:'小隊',pick:'從頻道列表選擇一個小隊後才會讀取訊息。',empty:'你還沒有加入任何小隊，加入後會出現該小隊的閒聊頻道。',home:'squads',homeLabel:'前往小隊集合',back:'回到小隊集合'},
  world:{title:'世界聊天',unit:'世界',pick:'所有會員可見的交流空間。',empty:'所有會員可在這裡交流。',home:'community',homeLabel:'前往自由工坊社群',back:'回到自由工坊社群'},
} as const satisfies Record<ChannelKind,Record<string,string>>;
const fail=(cause:unknown,fallback='暫時無法讀取，請稍後重試。')=>cause instanceof Error&&cause.message?cause.message:fallback;
/** No response, timeout or 5xx: the server may already have applied the write. */
const unconfirmed=(cause:unknown)=>!(cause instanceof ApiError)||cause.network||cause.status===0||cause.status>=500;
/** The member left (or never had) this channel: nothing already shown may stay on screen. */
const revoked=(cause:unknown)=>cause instanceof ApiError&&(cause.status===403||cause.status===404);
const merge=<T,>(current:T[],next:T[],id:(value:T)=>string)=>{const seen=new Set(current.map(id));return [...current,...next.filter(value=>!seen.has(id(value)))];};
// Sequences are integer strings that may exceed Number precision.
const compare=(a:string,b:string)=>{const x=BigInt(a),y=BigInt(b);return x<y?-1:x>y?1:0;};
const newestFirst=(items:ChannelMessage[])=>[...items].sort((a,b)=>compare(b.sequence,a.sequence));

/** One guild or squad chat tab: the list is read on its own; a channel's history only after the member picks it. */
export function MemberChannels({client,session,kind,onUnread,onNavigate,active=true,compact=false,openChannel}:Props){
  const me=session.user.user_id,text=copy[kind],uid=useId();
  const path=(key:string,rest:string)=>`/me/channels/${kind}/${encodeURIComponent(key)}/${rest}`;
  const [channels,setChannels]=useState<ChannelSummary[]>([]),[listNext,setListNext]=useState<number|null>(null);
  const [listStatus,setListStatus]=useState<'loading'|'ready'|'error'>('loading'),[listError,setListError]=useState('');
  const [listMore,setListMore]=useState({loading:false,error:''}),[listRefresh,setListRefresh]=useState({loading:false,error:''});
  const [selected,setSelected]=useState<{key:string;name:string}|null>(null),[history,setHistory]=useState<History|null>(null);
  const [status,setStatus]=useState<'idle'|'loading'|'ready'|'error'|'gone'>('idle'),[error,setError]=useState('');
  const [more,setMore]=useState({loading:false,error:''}),[refresh,setRefresh]=useState({loading:false,error:''});
  const [drafts,setDrafts]=useState<Record<string,string>>({}),[pending,setPending]=useState<Record<string,Pending>>({}),[sendErrors,setSendErrors]=useState<Record<string,string>>({});
  const [reading,setReading]=useState(false),[readError,setReadError]=useState(''),[newerUnseen,setNewerUnseen]=useState(false);
  // The read itself was confirmed; only the unread count after it is not known yet.
  const [countUnconfirmed,setCountUnconfirmed]=useState('');
  // listInFlight/threadInFlight record the full read still out, so a confirmed write can supersede it.
  const listGeneration=useRef(0),listInFlight=useRef<boolean|null>(null),listState=useRef(listStatus);listState.current=listStatus;
  const threadGeneration=useRef(0),threadInFlight=useRef<{key:string;quiet:boolean}|null>(null);
  // current is the selected key; epoch counts selections so a late 404 cannot close a newer selection of the same key.
  const current=useRef<string|null>(null),epoch=useRef(0),gone=useRef(new Set<string>()),readKeys=useRef(new Map<string,string>());
  const heading=useRef<HTMLHeadingElement>(null),focusThread=useRef(false),alive=useRef(true);
  const [roomQuery,setRoomQuery]=useState(''),[liveError,setLiveError]=useState(''),[hasNew,setHasNew]=useState(false);
  const [picking,setPicking]=useState(true);
  const scroll=useRef<HTMLDivElement>(null),stick=useRef(true),anchor=useRef<{top:number;height:number}|null>(null),polling=useRef(false),retryAt=useRef(0),failures=useRef(0);
  const snapshot=useRef({history,status,more,reading,active,sending:false});snapshot.current={history,status,more,reading,active:active&&(!compact||!picking),sending:pending[selected?.key??'']?.status==='sending'};
  const openedRequest=useRef<number|null>(null);
  const searched=useRef('');
  useLayoutEffect(()=>{
    const node=scroll.current;if(!node)return;
    if(anchor.current){node.scrollTop=anchor.current.top+node.scrollHeight-anchor.current.height;anchor.current=null;}
    else if(stick.current){node.scrollTop=node.scrollHeight;setHasNew(false);}
  },[history,selected?.key,pending[selected?.key??'']]);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;listGeneration.current++;threadGeneration.current++;};},[]);

  function revoke(key:string,since:number,reread=true){
    if(current.current===key&&epoch.current!==since)return;
    gone.current.add(key);
    if(current.current===key){
      // Dropping the generation discards every read of this history that is still out.
      threadGeneration.current++;threadInFlight.current=null;
      setHistory(null);setStatus('gone');setMore({loading:false,error:''});setRefresh({loading:false,error:''});setReadError('');setNewerUnseen(false);setCountUnconfirmed('');
    }
    setChannels(value=>value.filter(item=>item.channel_key!==key));
    setPending(({[key]:_,...rest})=>rest);setSendErrors(({[key]:_,...rest})=>rest);
    announceInboxChange();
    // A list read already out may still include the channel; replace it with one taken now.
    if(reread&&alive.current)void loadList(true);
  }
  /** A selected channel beyond the first page is checked on its own instead of being assumed gone. */
  async function probe(key:string){
    const since=epoch.current;
    try{await client.get<History>(path(key,'messages?limit=1&offset=0'));}catch(cause){if(alive.current&&revoked(cause))revoke(key,since);}
  }
  async function loadList(quiet=false){
    if(kind==='world'){setListStatus('ready');return;}
    const generation=++listGeneration.current;listInFlight.current=quiet;setListMore({loading:false,error:''});
    if(quiet)setListRefresh({loading:true,error:''});else{setListStatus('loading');setListError('');setListRefresh({loading:false,error:''});}
    try{
      const page=await client.get<ChannelPage>(`/me/channels?kind=${kind}&limit=${PAGE}&offset=0${roomQuery.trim()?`&search=${encodeURIComponent(roomQuery.trim())}`:''}`);
      if(generation!==listGeneration.current)return;
      listInFlight.current=null;setChannels(page.items);setListNext(page.next_offset);onUnread(page.unread_count);setListStatus('ready');setListRefresh({loading:false,error:''});
      const key=current.current;
      if(key&&!gone.current.has(key)&&!page.items.some(item=>item.channel_key===key)){
        if(page.next_offset===null&&!roomQuery.trim())revoke(key,epoch.current,false);else void probe(key);
      }
    }catch(cause){
      if(generation!==listGeneration.current)return;
      listInFlight.current=null;
      // A refused list means the open channel can no longer be shown either; no list re-read, so no loop.
      const key=current.current;if(key&&revoked(cause))revoke(key,epoch.current,false);
      // The list on screen is kept, but its total is no longer confirmed.
      if(quiet){setListRefresh({loading:false,error:fail(cause)});onUnread(null);}else{setListError(fail(cause));setListStatus('error');onUnread(null);}
    }
  }
  const handlers=useRef({loadList,loadThread,pullLatest});handlers.current={loadList,loadThread,pullLatest};
  useEffect(()=>{
    void handlers.current.loadList();
    // Coming back to the window or a membership change re-checks the list (never a history nobody opened).
    const recheck=()=>{if(listState.current==='ready')void handlers.current.loadList(true);};
    window.addEventListener('focus',recheck);window.addEventListener('freedom-profile-updated',recheck);
    return()=>{window.removeEventListener('focus',recheck);window.removeEventListener('freedom-profile-updated',recheck);};
  },[]);
  useEffect(()=>{
    const term=roomQuery.trim();if(term===searched.current)return;
    const timer=window.setTimeout(()=>{searched.current=term;void handlers.current.loadList(true)},250);
    return()=>window.clearTimeout(timer);
  },[roomQuery]);
  useEffect(()=>{
    if(!active)return;
    if(kind==='world'&&!current.current)select({kind,channel_key:'world',name:'世界聊天',unread_count:0,last_message_at:null});
    else if(openChannel&&openedRequest.current!==openChannel.request){openedRequest.current=openChannel.request;select({kind,channel_key:openChannel.key,name:channels.find(item=>item.channel_key===openChannel.key)?.name??text.unit,unread_count:0,last_message_at:null});}
  },[active,openChannel?.request]);
  useEffect(()=>{
    if(!active||compact&&picking)return;
    const update=()=>{if(document.visibilityState==='visible'&&navigator.onLine)void handlers.current.pullLatest();};
    const resume=()=>{retryAt.current=0;update();};
    update();const timer=window.setInterval(update,LIVE_POLL_MS);window.addEventListener('focus',resume);window.addEventListener('online',resume);document.addEventListener('visibilitychange',update);
    return()=>{window.clearInterval(timer);window.removeEventListener('focus',resume);window.removeEventListener('online',resume);document.removeEventListener('visibilitychange',update);};
  },[active,client,compact,picking]);
  async function pullLatest(){
    const key=current.current,shown=snapshot.current;
    if(!key||!shown.active||shown.status!=='ready'||!shown.history||shown.more.loading||shown.reading||shown.sending||threadInFlight.current||polling.current||Date.now()<retryAt.current)return;
    polling.current=true;const generation=threadGeneration.current,since=epoch.current;
    try{
      // Idle checks never download history bodies or refresh every joined room.
      const activity=await client.get<Activity>(path(key,'activity'),{background:true});
      if(!alive.current||generation!==threadGeneration.current||since!==epoch.current||current.current!==key||!snapshot.current.active||snapshot.current.sending)return;
      if(compare(activity.latest_sequence,shown.history.items[0]?.sequence??'0')<=0&&activity.unread_count===shown.history.unread_count){failures.current=0;retryAt.current=0;setLiveError('');return;}
      const value=await client.get<History>(path(key,`messages?limit=50&after_sequence=${shown.history.items[0]?.sequence??'0'}`),{background:true});
      if(!alive.current||generation!==threadGeneration.current||since!==epoch.current||current.current!==key||!snapshot.current.active)return;
      failures.current=0;retryAt.current=0;setLiveError('');
      setCountUnconfirmed('');setNewerUnseen(Boolean(value.next_after_sequence));
      if(kind==='world')onUnread(value.unread_count);
      setHistory(existing=>{
        if(!existing)return existing;
        const fresh=value.items.filter(item=>!existing.items.some(known=>known.message_id===item.message_id));
        if(fresh.length&&!stick.current)setHasNew(true);
        return {...existing,unread_count:value.unread_count,items:newestFirst(merge(value.items,existing.items,item=>item.message_id)),next_offset:existing.next_offset===null?null:existing.next_offset+fresh.length};
      });
      if(value.items.some(item=>!shown.history!.items.some(known=>known.message_id===item.message_id))){void loadList(true);announceInboxChange();}
    }catch(cause){
      if(!alive.current||generation!==threadGeneration.current||since!==epoch.current||current.current!==key)return;
      if(revoked(cause)){revoke(key,since);return;}
      retryAt.current=Date.now()+Math.min(60000,2000*2**Math.min(++failures.current,5));setLiveError('新訊息更新暫停，會自動重試。草稿仍保留，也可手動重讀。');
    }finally{polling.current=false;}
  }
  async function moreChannels(){
    if(listNext===null||listMore.loading)return;
    const generation=listGeneration.current;setListMore({loading:true,error:''});
    try{
      const page=await client.get<ChannelPage>(`/me/channels?kind=${kind}&limit=${PAGE}&offset=${listNext}${roomQuery.trim()?`&search=${encodeURIComponent(roomQuery.trim())}`:''}`);
      if(generation!==listGeneration.current)return;
      setChannels(value=>merge(value,page.items.filter(item=>!gone.current.has(item.channel_key)),item=>item.channel_key));setListNext(page.next_offset);onUnread(page.unread_count);setListMore({loading:false,error:''});
    }catch(cause){if(generation===listGeneration.current)setListMore({loading:false,error:fail(cause)});}
  }

  async function loadThread(key:string,quiet=false){
    const generation=++threadGeneration.current,since=epoch.current;threadInFlight.current={key,quiet};
    setMore({loading:false,error:''});setReadError('');
    if(quiet)setRefresh({loading:true,error:''});else{setStatus('loading');setError('');setRefresh({loading:false,error:''});setHistory(null);setNewerUnseen(false);setCountUnconfirmed('');}
    try{
      const value=await client.get<History>(path(key,`messages?limit=${PAGE}&offset=0`));
      if(generation===threadGeneration.current)threadInFlight.current=null;
      // A slower answer for an earlier selection must never replace the open channel.
      if(generation!==threadGeneration.current||current.current!==key)return;
      setHistory(existing=>quiet&&existing?{...value,items:newestFirst(merge(value.items,existing.items,item=>item.message_id)),next_offset:existing.next_offset===null?value.next_offset:Math.max(existing.next_offset,value.next_offset??0)+value.items.filter(item=>!existing.items.some(known=>known.message_id===item.message_id)).length}:{...value,items:newestFirst(value.items)});setStatus('ready');setRefresh({loading:false,error:''});setNewerUnseen(false);setCountUnconfirmed('');setLiveError('');
      if(kind==='world')onUnread(value.unread_count);
      // A re-read can show newer unread messages; the tab and list totals come from the kind list, never from this channel.
      // loadList never re-reads a history, so this cannot loop. The settings total re-reads its own four sources.
      if(quiet){void loadList(listInFlight.current??listState.current==='ready');announceInboxChange();}
    }catch(cause){
      if(generation===threadGeneration.current)threadInFlight.current=null;
      if(generation!==threadGeneration.current||current.current!==key)return;
      if(revoked(cause)){revoke(key,since);return;}
      if(quiet)setRefresh({loading:false,error:fail(cause)});else{setError(fail(cause));setStatus('error');}
    }
  }
  function select(item:ChannelSummary){
    current.current=item.channel_key;epoch.current++;gone.current.delete(item.channel_key);focusThread.current=true;
    stick.current=true;anchor.current=null;setHasNew(false);setLiveError('');retryAt.current=0;
    setSelected({key:item.channel_key,name:item.name});if(compact)setPicking(false);void loadThread(item.channel_key);
  }
  useEffect(()=>{if(status==='ready'&&focusThread.current){focusThread.current=false;heading.current?.focus();}},[status]);
  // A read that was already out when a write was confirmed may answer with the state before it.
  function rereadAfterWrite(key:string){
    if(listInFlight.current!==null)void loadList(listInFlight.current);
    const open=threadInFlight.current;if(open&&open.key===key&&current.current===key)void loadThread(key,open.quiet);
  }

  async function earlier(){
    if(!history||history.next_offset===null||more.loading||!selected)return;
    const generation=threadGeneration.current,key=selected.key,since=epoch.current;setMore({loading:true,error:''});
    try{
      const value=await client.get<History>(path(key,`messages?limit=${PAGE}&offset=${history.next_offset}`));
      if(generation!==threadGeneration.current||current.current!==key)return;
      if(scroll.current)anchor.current={top:scroll.current.scrollTop,height:scroll.current.scrollHeight};
      setHistory(existing=>existing&&{...existing,items:newestFirst(merge(existing.items,value.items,item=>item.message_id)),next_offset:value.next_offset});setMore({loading:false,error:''});
    }catch(cause){
      if(generation!==threadGeneration.current)return;
      if(revoked(cause)){revoke(key,since);return;}
      setMore({loading:false,error:fail(cause)});
    }
  }

  async function markRead(){
    if(!selected||!history||!history.items.length||reading)return;
    // Only through the newest message this member has actually been shown.
    const key=selected.key,through=history.items[0].message_id,since=epoch.current,generation=threadGeneration.current;
    setReading(true);setReadError('');setCountUnconfirmed('');
    const readKey=readKeys.current.get(`${key}:${through}`)??crypto.randomUUID();readKeys.current.set(`${key}:${through}`,readKey);
    try{
      await client.post<{read_sequence:string;read_at:string}>(path(key,'read'),{through_message_id:through},{idempotencyKey:readKey});
      readKeys.current.delete(`${key}:${through}`);announceInboxChange();
      if(!alive.current)return;
      rereadAfterWrite(key);
      if(listInFlight.current===null)void loadList(true);
      // Newer messages may have arrived meanwhile; their unread count comes from the server, never assumed 0.
      if(!threadInFlight.current){
        try{
          const latest=await client.get<History>(path(key,'messages?limit=1&offset=0'));
          if(!alive.current||generation!==threadGeneration.current||current.current!==key)return;
          const shownNewest=history.items[0].sequence,newest=latest.items[0]?.sequence;
          setHistory(value=>value&&{...value,unread_count:latest.unread_count});
          setNewerUnseen(latest.unread_count>0&&newest!==undefined&&compare(newest,shownNewest)>0);
        }catch(cause){
          if(!alive.current||generation!==threadGeneration.current||current.current!==key)return;
          if(revoked(cause)){revoke(key,since);return;}
          // Not zero and not the old count: re-reading the messages confirms it without another read.
          setCountUnconfirmed(fail(cause));
        }
      }
    }catch(cause){
      if(!unconfirmed(cause))readKeys.current.delete(`${key}:${through}`);
      if(!alive.current)return;
      if(revoked(cause)){revoke(key,since);return;}
      if(generation===threadGeneration.current)setReadError(`標為已讀未完成：${fail(cause,'請重試。')}`);
    }finally{if(alive.current)setReading(false);}
  }

  async function send(key:string){
    const previous=pending[key];
    if(previous?.status==='sending')return;
    const body=(drafts[key]??'').trim();
    if(!body){setSendErrors(value=>({...value,[key]:'請先輸入訊息內容。'}));return;}
    if([...body].length>MAX_BODY){setSendErrors(value=>({...value,[key]:`訊息最多 ${MAX_BODY} 字。`}));return;}
    // The same body after an unconfirmed result keeps its key so the server returns the original
    // message instead of storing a duplicate; only changed text becomes a new message.
    const attempt:Pending={key:previous?.status==='unknown'&&previous.body===body?previous.key:crypto.randomUUID(),body,status:'sending'};
    const since=epoch.current;
    setPending(value=>({...value,[key]:attempt}));setSendErrors(({[key]:_,...rest})=>rest);
    try{
      const message=await client.post<ChannelMessage>(path(key,'messages'),{body},{idempotencyKey:attempt.key});
      logConsoleEvent({channel:consoleChannel(kind==='guild'?'chat_sent_guild':kind==='world'?'chat_sent_world':'chat_sent_squad'),level:'success',kind:'status',source:text.unit,message:`已傳送訊息至「${selected?.name??text.unit+'頻道'}」。`});
      if(!alive.current)return;
      setPending(({[key]:_,...rest})=>rest);
      setDrafts(value=>{if((value[key]??'').trim()!==body)return value;const {[key]:_,...rest}=value;return rest;});
      if(gone.current.has(key))return;
      if(current.current===key){stick.current=true;setHistory(value=>value&&value.channel.channel_key===key?{...value,items:newestFirst(merge([message],value.items,item=>item.message_id)),next_offset:value.next_offset===null?null:value.next_offset+(value.items.some(item=>item.message_id===message.message_id)?0:1)}:value);}
      setChannels(value=>value.map(item=>item.channel_key===key?{...item,last_message_at:message.created_at}:item));
      rereadAfterWrite(key);
    }catch(cause){
      if(!alive.current)return;
      if(unconfirmed(cause)){
        setPending(value=>({...value,[key]:{...attempt,status:'unknown'}}));
        setSendErrors(value=>({...value,[key]:`傳送結果未確認：${fail(cause,'請重試。')} 以相同內容重試不會重複寄出。`}));
      }else if(revoked(cause)){revoke(key,since);}
      else{
        setPending(({[key]:_,...rest})=>rest);
        setSendErrors(value=>({...value,[key]:`訊息未送出：${fail(cause,'請修改後重試。')}`}));
      }
    }
  }

  const key=selected?.key,draft=key?drafts[key]??'':'',attempt=key?pending[key]:undefined,sendError=key?sendErrors[key]:undefined;
  const ids={list:`${uid}-list`,title:`${uid}-title`,error:`${uid}-send-error`};
  return <div className={`messages-layout member-channels${compact?' is-compact':''}`} data-channel-kind={kind}>
    {compact&&selected&&kind!=='world'&&<button type="button" className="btn btn-ghost messages-switch" aria-expanded={picking} aria-controls={`${uid}-picker`} onClick={()=>setPicking(value=>!value)}>{picking?'回到目前對話':`切換${text.unit}`}</button>}
    {kind!=='world'&&<section id={`${uid}-picker`} hidden={compact&&Boolean(selected)&&!picking} className="messages-side stack" aria-labelledby={ids.list}>
      <h2 id={ids.list} className="member-section-title">{text.unit}頻道</h2>
      <label className="field">搜尋{text.unit}頻道<input type="search" value={roomQuery} maxLength={100} onChange={event=>setRoomQuery(event.target.value)} placeholder="輸入頻道名稱"/></label>
      {listStatus==='loading'&&<p role="status">正在讀取{text.unit}頻道…</p>}
      {listStatus==='error'&&<div className="banner banner-error" role="alert">{text.unit}頻道讀取失敗：{listError}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadList()}>重新讀取{text.unit}頻道</button></div></div>}
      {listStatus==='ready'&&<div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={listRefresh.loading} onClick={()=>{if(!listRefresh.loading)void loadList(true);}}>{listRefresh.loading?`正在整理${text.unit}頻道…`:`重新整理${text.unit}頻道`}</button></div>}
      {listRefresh.error&&<p className="banner banner-error" role="alert">{text.unit}頻道重新整理失敗：{listRefresh.error}</p>}
      {listStatus==='ready'&&(channels.length===0&&listNext===null?<div className="stack"><p className="empty">{text.empty}</p><div className="messages-actions"><button className="btn btn-primary" type="button" onClick={()=>onNavigate(text.home)}>{text.homeLabel}</button></div></div>
        :<ul className="messages-list member-channel-list" aria-label={`${text.unit}頻道列表`}>
          {channels.filter(item=>item.name.toLocaleLowerCase().includes(roomQuery.trim().toLocaleLowerCase())).map(item=>{const meta=`${uid}-meta-${item.channel_key}`;return <li key={item.channel_key} className={item.unread_count?'is-unread':undefined}>
            <button type="button" className="messages-peer channel-button" data-channel-key={item.channel_key} aria-label={item.name} aria-describedby={meta}
              aria-current={key===item.channel_key?'true':undefined} onClick={()=>select(item)}>
              <span><strong>{item.name}</strong><br/><span className="messages-meta">{item.last_message_at?`最後訊息 ${formatIsoLocal(item.last_message_at)}`:'尚無訊息'}</span></span>
              {item.unread_count>0&&<span className="messages-count" aria-hidden="true">{item.unread_count} 則未讀</span>}
            </button>
            {/* The accessible name stays the channel name; time and unread count are its description. */}
            <span id={meta} hidden>{item.last_message_at?`最後訊息 ${formatIsoLocal(item.last_message_at)}`:'尚無訊息'}{item.unread_count>0?`，${item.unread_count} 則未讀`:'，沒有未讀'}</span>
          </li>;})}
        </ul>)}
      {listMore.error&&<p className="banner banner-error" role="alert">更多{text.unit}頻道讀取失敗：{listMore.error}</p>}
      {roomQuery.trim()&&listStatus==='ready'&&!listRefresh.loading&&!channels.some(item=>item.name.toLocaleLowerCase().includes(roomQuery.trim().toLocaleLowerCase()))&&<p className="empty">沒有符合的頻道，請換個關鍵字。</p>}
      {listStatus==='ready'&&listNext!==null&&<button className="btn btn-ghost" type="button" disabled={listMore.loading} onClick={()=>void moreChannels()}>{listMore.loading?'正在讀取…':listMore.error?`重試載入更多${text.unit}頻道`:`載入更多${text.unit}頻道`}</button>}
    </section>}
    <section hidden={compact&&kind!=='world'&&(!selected||picking)} className="messages-thread" aria-labelledby={ids.title} aria-busy={status==='loading'}>
      {!selected&&<><h2 id={ids.title}>{text.title}</h2><p className="muted">{text.pick}</p></>}
      {selected&&status==='gone'&&<>
        <h2 id={ids.title}>{selected.name}</h2>
        <div className="banner banner-error" role="alert">目前無法使用此頻道。<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>onNavigate(text.home)}>{text.back}</button></div></div>
      </>}
      {selected&&status!=='gone'&&<>
        <h2 id={ids.title} ref={heading} tabIndex={-1}>{kind==='world'?'世界聊天':history?`${history.channel.name}・${text.title}`:`${selected.name}・${text.title}`}</h2>
        <p className="messages-meta">{kind==='world'?'所有會員可見':'只顯示這個頻道的訊息'} · {liveError?'更新暫停':'新訊息自動更新'}</p>
        {liveError&&<p role="status" className="messages-meta">{liveError}</p>}
        {status==='loading'&&<p role="status">正在讀取訊息…</p>}
        {status==='error'&&<div className="banner banner-error" role="alert">訊息讀取失敗：{error}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadThread(selected.key)}>重新讀取訊息</button></div></div>}
        {status==='ready'&&history&&<>
          {/* Also the safe way to check an unconfirmed send: the pending key and draft stay as they are. */}
          <div className="messages-actions messages-refresh"><button className="btn btn-ghost" title="重新讀取訊息" type="button" aria-disabled={refresh.loading} onClick={()=>{if(!refresh.loading)void loadThread(selected.key,true);}}>{refresh.loading?'正在讀取訊息…':'重新讀取訊息'}</button></div>
          {refresh.error&&<p className="banner banner-error" role="alert">訊息重新讀取失敗：{refresh.error}</p>}
          <div className="messages-scroll" ref={scroll} role="log" aria-live="polite" aria-relevant="additions" tabIndex={0} aria-label={`${history.channel.name}對話紀錄`} onScroll={()=>{if(scroll.current){stick.current=scroll.current.scrollHeight-scroll.current.scrollTop-scroll.current.clientHeight<80;if(stick.current)setHasNew(false);}}}>
          {history.next_offset!==null&&<button className="btn btn-ghost" type="button" disabled={more.loading} onClick={()=>void earlier()}>{more.loading?'正在讀取…':more.error?'重試載入較早訊息':'載入較早訊息'}</button>}
          {more.error&&<p className="banner banner-error" role="alert">較早訊息讀取失敗：{more.error}</p>}
          {history.items.length===0?<p className="empty">這個頻道還沒有訊息。</p>:<ol className="messages-bubbles" aria-label="頻道訊息">
            {[...history.items].reverse().map(message=>{const mine=message.sender_ref===me;return <li key={message.message_id} className={mine?'is-mine':undefined} data-message-id={message.message_id}>
              <p className="messages-meta">{mine?'你':message.sender_name} · {formatIsoLocal(message.created_at)}</p>
              <p className="messages-body">{message.body}</p>
            </li>;})}
          </ol>}
          {attempt?.status==='sending'&&<div className="messages-pending" role="status" aria-label="傳送狀態"><p className="messages-body">{attempt.body}</p><p className="messages-meta">傳送中…</p></div>}
          </div>
          {hasNew&&<button className="btn btn-ghost messages-new" type="button" onClick={()=>{stick.current=true;scroll.current?.scrollTo({top:scroll.current.scrollHeight});setHasNew(false);}}>有新訊息 · 回到最新</button>}
          {countUnconfirmed&&<div className="banner banner-error" role="alert">已標為已讀，但目前未讀數未確認：{countUnconfirmed}<div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={refresh.loading} onClick={()=>{if(!refresh.loading)void loadThread(selected.key,true);}}>重新讀取訊息</button></div></div>}
          {!countUnconfirmed&&history.unread_count>0&&history.items.length>0&&(newerUnseen
            ?<p className="messages-meta" role="note">還有 {history.unread_count} 則較新的未讀訊息，重新讀取訊息後才能標為已讀。</p>
            :<div className="messages-actions"><span className="messages-meta">{history.unread_count} 則未讀</span><button className="btn btn-ghost" type="button" disabled={reading} onClick={()=>void markRead()}>{reading?'正在標記…':'標為已讀'}</button></div>)}
          {readError&&<div className="banner banner-error" role="alert">{readError}<div className="messages-actions"><button className="btn btn-ghost" type="button" disabled={reading} onClick={()=>void markRead()}>重試標為已讀</button></div></div>}
          <form className="messages-compose" onSubmit={(event:FormEvent)=>{event.preventDefault();void send(selected.key);}}>
            <label className="field"><span>{kind==='world'?'世界聊天訊息':`在 ${history.channel.name} 發言`}</span>
              <textarea value={draft} rows={3} readOnly={attempt?.status==='sending'} aria-describedby={sendError?ids.error:undefined}
                onKeyDown={event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.nativeEvent.isComposing&&event.keyCode!==229){event.preventDefault();void send(selected.key);}}}
                onChange={event=>{const value=event.target.value;setDrafts(drafts=>({...drafts,[selected.key]:value}));}}/></label>
            <p className="messages-meta">Enter 送出 · Shift+Enter 換行 · {[...draft].length}／{MAX_BODY} 字</p>
            {sendError&&<p id={ids.error} className="banner banner-error" role="alert">{sendError}</p>}
            <div className="messages-actions">
              <button className="btn btn-primary" type="submit" disabled={attempt?.status==='sending'}>{attempt?.status==='sending'?'正在送出…':attempt?.status==='unknown'&&draft.trim()===attempt.body?'重試送出':kind==='world'?'傳送':'送出'}</button>
            </div>
          </form>
        </>}
      </>}
    </section>
  </div>;
}
