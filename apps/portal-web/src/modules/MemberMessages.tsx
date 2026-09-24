import {useCallback,useEffect,useRef,useState,type FormEvent,type KeyboardEvent} from 'react';
import {ApiError,type PortalClient} from '../api';
import {formatIsoLocal} from '../format';
import type {SessionPayload,TabId} from '../types';
import {MemberAvatar} from './MemberAvatar';
import {MemberChannels} from './MemberChannels';
import {announceInboxChange,type InboxUnread} from './member-inbox';
import type {MemberCardData} from './Membership';
import './MemberSettings.css';

type ActionTab='members'|'squads'|'guilds'|'guild-workspace'|'messages';
type NotificationAction={tab:ActionTab;resource_id:string|null};
type Notice={notification_id:string;kind:string;title:string;body:string;created_at:string;read_at:string|null;action:NotificationAction|null};
type NoticePage={items:Notice[];unread_count:number;next_offset:number|null};
type Participant={user_id:string;display_name:string;avatar_url:string|null};
type Message={message_id:string;sender_ref:string;recipient_ref:string;body:string;created_at:string;read_at:string|null};
type Conversation={participant:Participant;can_send:boolean;last_message:Message;unread_count:number};
type ConversationPage={items:Conversation[];unread_count:number;next_offset:number|null};
type Thread={participant:Participant;can_send:boolean;items:Message[];next_offset:number|null;unread_count:number};
type MemberPage={items:MemberCardData[];total:number;next_offset:number|null};
type Props={client:PortalClient;session:SessionPayload;onNavigate:(id:TabId)=>void};

const PAGE=20,MAX_BODY=2000;
// Actions map to fixed in-app pages only; a notification can never supply a link.
const actionLabels:Record<ActionTab,string>={members:'前往工坊夥伴',squads:'前往小隊集合',guilds:'前往職業公會','guild-workspace':'前往公會管理',messages:'開啟私訊'};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fail=(cause:unknown,fallback='暫時無法讀取，請稍後重試。')=>cause instanceof Error&&cause.message?cause.message:fallback;
/** No response, timeout or 5xx: the server may already have applied the write. */
const unconfirmed=(cause:unknown)=>!(cause instanceof ApiError)||cause.network||cause.status===0||cause.status>=500;
const merge=<T,>(current:T[],next:T[],id:(value:T)=>string)=>{const seen=new Set(current.map(id));return [...current,...next.filter(value=>!seen.has(id(value)))];};
const usableAction=(action:NotificationAction|null)=>!action||!Object.hasOwn(actionLabels,action.tab)||action.tab==='messages'&&!uuid.test(action.resource_id??'')?null:action;
const unreadText=(count:InboxUnread)=>count===undefined?'':count===null?'未讀數未確認':count>0?`${count} 則未讀`:'沒有未讀';

type View='notifications'|'guild'|'squad'|'direct';
const VIEWS:readonly (readonly [View,string])[]=[['notifications','通知'],['guild','公會閒聊'],['squad','小隊閒聊'],['direct','私人訊息']];

export function MemberMessages({client,session,onNavigate}:Props){
  const [view,setView]=useState<View>('notifications');
  const [noticeUnread,setNoticeUnread]=useState<InboxUnread>(),[guildUnread,setGuildUnread]=useState<InboxUnread>(),[squadUnread,setSquadUnread]=useState<InboxUnread>(),[directUnread,setDirectUnread]=useState<InboxUnread>();
  const unread:Record<View,InboxUnread>={notifications:noticeUnread,guild:guildUnread,squad:squadUnread,direct:directUnread};
  const [openPeer,setOpenPeer]=useState<{id:string;request:number}|null>(null);
  const tabs=useRef<Record<string,HTMLButtonElement|null>>({});
  function tabKey(event:KeyboardEvent){
    const index=VIEWS.findIndex(([id])=>id===view),last=VIEWS.length-1;
    const next={ArrowRight:index===last?0:index+1,ArrowLeft:index===0?last:index-1,Home:0,End:last}[event.key];
    if(next===undefined)return;
    event.preventDefault();
    const id=VIEWS[next][0];setView(id);tabs.current[id]?.focus();
  }
  return <section className="member-messages">
    <div className="messages-tabs" role="tablist" aria-label="訊息類型" onKeyDown={tabKey}>
      {VIEWS.map(([id,label])=><button key={id} ref={node=>{tabs.current[id]=node;}} type="button" role="tab" id={`messages-tab-${id}`} aria-controls={`messages-panel-${id}`}
        aria-selected={view===id} tabIndex={view===id?0:-1} className="btn btn-ghost" onClick={()=>setView(id)}>{label}{unread[id]!==undefined&&<span className="messages-count">{unreadText(unread[id])}</span>}</button>)}
    </div>
    {/* Every panel stays mounted so unsent drafts survive switching tabs; chat history is read only after a channel is chosen. */}
    <div id="messages-panel-notifications" role="tabpanel" aria-labelledby="messages-tab-notifications" hidden={view!=='notifications'}>
      <Notifications client={client} onUnread={setNoticeUnread} onNavigate={onNavigate} onOpenPeer={id=>{setView('direct');setOpenPeer(current=>({id,request:(current?.request??0)+1}));}}/>
    </div>
    <div id="messages-panel-guild" role="tabpanel" aria-labelledby="messages-tab-guild" hidden={view!=='guild'}>
      <MemberChannels client={client} session={session} kind="guild" onUnread={setGuildUnread} onNavigate={onNavigate}/>
    </div>
    <div id="messages-panel-squad" role="tabpanel" aria-labelledby="messages-tab-squad" hidden={view!=='squad'}>
      <MemberChannels client={client} session={session} kind="squad" onUnread={setSquadUnread} onNavigate={onNavigate}/>
    </div>
    <div id="messages-panel-direct" role="tabpanel" aria-labelledby="messages-tab-direct" hidden={view!=='direct'}>
      <DirectMessages client={client} session={session} onUnread={setDirectUnread} openPeer={openPeer}/>
    </div>
  </section>;
}

function Notifications({client,onUnread,onNavigate,onOpenPeer}:{client:PortalClient;onUnread:(count:InboxUnread)=>void;onNavigate:(id:TabId)=>void;onOpenPeer:(id:string)=>void}){
  const [items,setItems]=useState<Notice[]>([]),[nextOffset,setNextOffset]=useState<number|null>(null);
  const [status,setStatus]=useState<'loading'|'ready'|'error'>('loading'),[error,setError]=useState('');
  const [more,setMore]=useState<{loading:boolean;error:string}>({loading:false,error:''});
  const [busy,setBusy]=useState<Record<string,boolean>>({}),[itemErrors,setItemErrors]=useState<Record<string,{message:string;navigate:boolean}>>({});
  // A manual refresh keeps the loaded list (and the focused button) on screen until the new page arrives.
  const [refresh,setRefresh]=useState({loading:false,error:''});
  // inFlight is the quietness of the full read that is still out, or null.
  const generation=useRef(0),inFlight=useRef<boolean|null>(null),keys=useRef(new Map<string,string>()),alive=useRef(true);
  // Late responses after leaving the page must not navigate or overwrite anything.
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;generation.current++;};},[]);
  const load=useCallback(async(quiet=false)=>{
    const current=++generation.current;inFlight.current=quiet;setMore({loading:false,error:''});
    if(quiet)setRefresh({loading:true,error:''});else{setStatus('loading');setError('');setRefresh({loading:false,error:''});}
    try{
      const page=await client.get<NoticePage>(`/me/notifications?limit=${PAGE}&offset=0`);
      if(current!==generation.current)return;
      inFlight.current=null;setItems(page.items);setNextOffset(page.next_offset);onUnread(page.unread_count);setStatus('ready');setRefresh({loading:false,error:''});
    }catch(cause){
      if(current!==generation.current)return;
      inFlight.current=null;
      if(quiet){setRefresh({loading:false,error:fail(cause)});onUnread(null);}else{setError(fail(cause));setStatus('error');}
    }
  },[client,onUnread]);
  useEffect(()=>{void load();},[load]);
  async function loadMore(){
    if(nextOffset===null||more.loading)return;
    const current=generation.current;setMore({loading:true,error:''});
    try{
      const page=await client.get<NoticePage>(`/me/notifications?limit=${PAGE}&offset=${nextOffset}`);
      if(current!==generation.current)return;
      setItems(value=>merge(value,page.items,item=>item.notification_id));setNextOffset(page.next_offset);onUnread(page.unread_count);setMore({loading:false,error:''});
    }catch(cause){if(current===generation.current)setMore({loading:false,error:fail(cause)});}
  }
  async function refreshUnread(){
    // A failed refresh makes the total unknown instead of leaving a stale number on screen.
    try{const page=await client.get<NoticePage>('/me/notifications?limit=1&offset=0');if(alive.current)onUnread(page.unread_count);}catch{if(alive.current)onUnread(null);}
  }
  function go(action:NotificationAction){
    if(action.tab==='messages'){onOpenPeer(action.resource_id!);return;}
    onNavigate(action.tab);
  }
  async function markRead(item:Notice,then?:NotificationAction){
    const id=item.notification_id;if(busy[id])return;
    setBusy(value=>({...value,[id]:true}));setItemErrors(({[id]:_,...rest})=>rest);
    const key=keys.current.get(id)??crypto.randomUUID();keys.current.set(id,key);
    try{
      const result=await client.post<{notification_id:string;read_at:string}>(`/me/notifications/${encodeURIComponent(id)}/read`,{},{idempotencyKey:key});
      keys.current.delete(id);announceInboxChange();
      if(!alive.current)return;
      setItems(value=>value.map(entry=>entry.notification_id===id?{...entry,read_at:result.read_at}:entry));
      // A list read that was already out may answer with the old state; replace it with one taken now.
      if(inFlight.current!==null)void load(inFlight.current);
      void refreshUnread();
      if(then)go(then);
    }catch(cause){
      if(!unconfirmed(cause))keys.current.delete(id);
      if(!alive.current)return;
      setItemErrors(value=>({...value,[id]:{message:`標為已讀未完成：${fail(cause,'請重試。')}`,navigate:Boolean(then)}}));
    }finally{setBusy(({[id]:_,...rest})=>rest);}
  }
  if(status==='loading')return <p role="status">正在讀取通知…</p>;
  if(status==='error')return <div className="banner banner-error" role="alert">通知讀取失敗：{error}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void load()}>重新讀取通知</button></div></div>;
  return <div className="stack">
    <div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={refresh.loading} onClick={()=>{if(!refresh.loading)void load(true);}}>{refresh.loading?'正在整理通知…':'重新整理通知'}</button></div>
    {refresh.error&&<p className="banner banner-error" role="alert">通知重新整理失敗：{refresh.error}</p>}
    <h2 className="member-section-title">最新通知</h2>
    {items.length===0?<p className="empty">目前沒有通知。</p>:<ul className="messages-list" aria-label="通知">
      {items.map(item=>{
        const id=item.notification_id,action=usableAction(item.action),problem=itemErrors[id];
        return <li key={id} className={item.read_at?undefined:'is-unread'} data-notification={id}>
          <h3>{item.title}</h3>
          <p className="messages-body">{item.body}</p>
          <p className="messages-meta">{formatIsoLocal(item.created_at)} · {item.read_at?'已讀':'未讀'}</p>
          <div className="messages-actions">
            {action&&<button className="btn btn-primary" type="button" disabled={busy[id]} onClick={()=>item.read_at?go(action):void markRead(item,action)}>{actionLabels[action.tab]}</button>}
            {!item.read_at&&<button className="btn btn-ghost" type="button" disabled={busy[id]} onClick={()=>void markRead(item)}>{busy[id]?'正在標記…':'標為已讀'}</button>}
          </div>
          {problem&&<div className="banner banner-error" role="alert">{problem.message}<div className="messages-actions">
            <button className="btn btn-ghost" type="button" disabled={busy[id]} onClick={()=>void markRead(item,problem.navigate&&action?action:undefined)}>重試標為已讀</button>
            {problem.navigate&&action&&<button className="btn btn-ghost" type="button" onClick={()=>go(action)}>不標已讀，直接{actionLabels[action.tab]}</button>}
          </div></div>}
        </li>;
      })}
    </ul>}
    {more.error&&<div className="banner banner-error" role="alert">更多通知讀取失敗：{more.error}</div>}
    {nextOffset!==null&&<div className="messages-actions"><button className="btn btn-ghost" type="button" disabled={more.loading} onClick={()=>void loadMore()}>{more.loading?'正在讀取…':more.error?'重試載入更多通知':'載入更多通知'}</button></div>}
  </div>;
}

type Pending={key:string;body:string;status:'sending'|'unknown'};

function DirectMessages({client,session,onUnread,openPeer}:{client:PortalClient;session:SessionPayload;onUnread:(count:InboxUnread)=>void;openPeer:{id:string;request:number}|null}){
  const me=session.user.user_id;
  const [conversations,setConversations]=useState<Conversation[]>([]),[convNext,setConvNext]=useState<number|null>(null);
  const [convStatus,setConvStatus]=useState<'loading'|'ready'|'error'>('loading'),[convError,setConvError]=useState(''),[convMore,setConvMore]=useState({loading:false,error:''});
  const [peer,setPeer]=useState<string|null>(null),[thread,setThread]=useState<Thread|null>(null);
  const [threadStatus,setThreadStatus]=useState<'idle'|'loading'|'ready'|'error'>('idle'),[threadError,setThreadError]=useState(''),[threadMore,setThreadMore]=useState({loading:false,error:''});
  const [drafts,setDrafts]=useState<Record<string,string>>({}),[pending,setPending]=useState<Record<string,Pending>>({}),[sendErrors,setSendErrors]=useState<Record<string,string>>({});
  const [reading,setReading]=useState(false),[readError,setReadError]=useState('');
  // Manual refreshes keep the loaded list/thread (and the focused button) on screen until the new page arrives.
  const [convRefresh,setConvRefresh]=useState({loading:false,error:''}),[threadRefresh,setThreadRefresh]=useState({loading:false,error:''});
  // The in-flight refs record the full read that is still out, so a confirmed write can supersede it.
  const convInFlight=useRef<boolean|null>(null),threadInFlight=useRef<{id:string;quiet:boolean}|null>(null);
  const convGeneration=useRef(0),threadGeneration=useRef(0),currentPeer=useRef<string|null>(null),readKeys=useRef(new Map<string,string>()),heading=useRef<HTMLHeadingElement>(null),focusThread=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;convGeneration.current++;threadGeneration.current++;};},[]);

  const loadConversations=useCallback(async(quiet=false)=>{
    const current=++convGeneration.current;convInFlight.current=quiet;setConvMore({loading:false,error:''});
    if(quiet)setConvRefresh({loading:true,error:''});else{setConvStatus('loading');setConvError('');setConvRefresh({loading:false,error:''});}
    try{
      const page=await client.get<ConversationPage>(`/me/conversations?limit=${PAGE}&offset=0`);
      if(current!==convGeneration.current)return;
      convInFlight.current=null;setConversations(page.items);setConvNext(page.next_offset);onUnread(page.unread_count);setConvStatus('ready');setConvRefresh({loading:false,error:''});
    }catch(cause){
      if(current!==convGeneration.current)return;
      convInFlight.current=null;
      // The list on screen is kept, but its total is no longer confirmed.
      if(quiet){setConvRefresh({loading:false,error:fail(cause)});onUnread(null);}else{setConvError(fail(cause));setConvStatus('error');}
    }
  },[client,onUnread]);
  useEffect(()=>{void loadConversations();},[loadConversations]);
  async function moreConversations(){
    if(convNext===null||convMore.loading)return;
    const current=convGeneration.current;setConvMore({loading:true,error:''});
    try{
      const page=await client.get<ConversationPage>(`/me/conversations?limit=${PAGE}&offset=${convNext}`);
      if(current!==convGeneration.current)return;
      setConversations(value=>merge(value,page.items,item=>item.participant.user_id));setConvNext(page.next_offset);onUnread(page.unread_count);setConvMore({loading:false,error:''});
    }catch(cause){if(current===convGeneration.current)setConvMore({loading:false,error:fail(cause)});}
  }

  const loadThread=useCallback(async(id:string,quiet=false)=>{
    const current=++threadGeneration.current;threadInFlight.current={id,quiet};
    setThreadMore({loading:false,error:''});setReadError('');
    if(quiet)setThreadRefresh({loading:true,error:''});else{setThreadStatus('loading');setThreadError('');setThreadRefresh({loading:false,error:''});setThread(null);}
    try{
      const value=await client.get<Thread>(`/me/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}&offset=0`);
      if(current===threadGeneration.current)threadInFlight.current=null;
      // A slower response for a previously selected member must never replace the open conversation.
      if(current!==threadGeneration.current||currentPeer.current!==id)return;
      setThread(value);setThreadStatus('ready');setThreadRefresh({loading:false,error:''});
    }catch(cause){
      if(current===threadGeneration.current)threadInFlight.current=null;
      if(current!==threadGeneration.current||currentPeer.current!==id)return;
      if(quiet)setThreadRefresh({loading:false,error:fail(cause)});else{setThreadError(fail(cause));setThreadStatus('error');}
    }
  },[client]);
  const select=useCallback((id:string,moveFocus:boolean)=>{
    if(id===me)return;
    currentPeer.current=id;focusThread.current=moveFocus;setPeer(id);void loadThread(id);
  },[loadThread,me]);
  useEffect(()=>{if(openPeer)select(openPeer.id,true);},[openPeer,select]);
  // A read that was already out when a write was confirmed may answer with the state before it.
  // Starting a new one supersedes it (and its busy flag), so the screen settles on a snapshot taken after the write.
  function rereadAfterWrite(id:string){
    if(convInFlight.current!==null)void loadConversations(convInFlight.current);
    const open=threadInFlight.current;if(open&&open.id===id&&currentPeer.current===id)void loadThread(id,open.quiet);
  }
  useEffect(()=>{if(threadStatus==='ready'&&focusThread.current){focusThread.current=false;heading.current?.focus();}},[threadStatus]);

  async function earlier(){
    if(!thread||thread.next_offset===null||threadMore.loading||!peer)return;
    const current=threadGeneration.current,id=peer;setThreadMore({loading:true,error:''});
    try{
      const value=await client.get<Thread>(`/me/conversations/${encodeURIComponent(id)}/messages?limit=${PAGE}&offset=${thread.next_offset}`);
      if(current!==threadGeneration.current||currentPeer.current!==id)return;
      setThread(existing=>existing&&{...existing,items:merge(existing.items,value.items,item=>item.message_id),next_offset:value.next_offset});setThreadMore({loading:false,error:''});
    }catch(cause){if(current===threadGeneration.current)setThreadMore({loading:false,error:fail(cause)});}
  }

  async function markRead(){
    if(!peer||reading)return;
    const id=peer,current=threadGeneration.current;setReading(true);setReadError('');
    const key=readKeys.current.get(id)??crypto.randomUUID();readKeys.current.set(id,key);
    try{
      const result=await client.post<{user_id:string;read_at:string;updated_count:number}>(`/me/conversations/${encodeURIComponent(id)}/read`,{},{idempotencyKey:key});
      readKeys.current.delete(id);announceInboxChange();
      if(!alive.current)return;
      setConversations(value=>value.map(item=>item.participant.user_id===id?{...item,unread_count:0}:item));
      if(currentPeer.current===id)setThread(value=>value&&value.participant.user_id===id?{...value,unread_count:0,items:value.items.map(message=>message.sender_ref===id&&!message.read_at?{...message,read_at:result.read_at}:message)}:value);
      rereadAfterWrite(id);
      try{const page=await client.get<ConversationPage>('/me/conversations?limit=1&offset=0');if(alive.current)onUnread(page.unread_count);}catch{if(alive.current)onUnread(null);}
    }catch(cause){
      if(!unconfirmed(cause))readKeys.current.delete(id);
      if(current===threadGeneration.current)setReadError(`標為已讀未完成：${fail(cause,'請重試。')}`);
    }finally{setReading(false);}
  }

  async function send(id:string){
    const previous=pending[id];
    if(previous?.status==='sending')return;
    const body=(drafts[id]??'').trim();
    if(!body){setSendErrors(value=>({...value,[id]:'請先輸入訊息內容。'}));return;}
    if([...body].length>MAX_BODY){setSendErrors(value=>({...value,[id]:`訊息最多 ${MAX_BODY} 字。`}));return;}
    // The same body after an unconfirmed result keeps its key so the server returns the original
    // message instead of storing a duplicate; only changed text becomes a new message.
    const attempt:Pending={key:previous?.status==='unknown'&&previous.body===body?previous.key:crypto.randomUUID(),body,status:'sending'};
    setPending(value=>({...value,[id]:attempt}));setSendErrors(({[id]:_,...rest})=>rest);
    try{
      const message=await client.post<Message>(`/me/conversations/${encodeURIComponent(id)}/messages`,{body},{idempotencyKey:attempt.key});
      announceInboxChange();
      setPending(({[id]:_,...rest})=>rest);
      setDrafts(value=>{if((value[id]??'').trim()!==body)return value;const {[id]:_,...rest}=value;return rest;});
      if(currentPeer.current===id)setThread(value=>value&&value.participant.user_id===id?{...value,items:merge([message],value.items,item=>item.message_id)}:value);
      setConversations(value=>{
        const existing=value.find(item=>item.participant.user_id===id);
        const participant=existing?.participant??(thread?.participant.user_id===id?thread.participant:null);
        if(!participant)return value;
        return [{participant,can_send:existing?.can_send??true,unread_count:existing?.unread_count??0,last_message:message},...value.filter(item=>item.participant.user_id!==id)];
      });
      rereadAfterWrite(id);
    }catch(cause){
      if(unconfirmed(cause)){
        setPending(value=>({...value,[id]:{...attempt,status:'unknown'}}));
        setSendErrors(value=>({...value,[id]:`傳送結果未確認：${fail(cause,'請重試。')} 以相同內容重試不會重複寄出。`}));
      }else{
        setPending(({[id]:_,...rest})=>rest);
        setSendErrors(value=>({...value,[id]:`訊息未送出：${fail(cause,'請修改後重試。')}`}));
      }
    }
  }

  const participant=thread?.participant,draft=peer?drafts[peer]??'':'',attempt=peer?pending[peer]:undefined,sendError=peer?sendErrors[peer]:undefined;
  return <div className="messages-layout">
    <div className="messages-side">
      <MemberPicker client={client} me={me} onSelect={id=>select(id,true)}/>
      <section className="stack" aria-labelledby="conversation-list-title">
        <h2 id="conversation-list-title" className="member-section-title">對話</h2>
        {convStatus==='loading'&&<p role="status">正在讀取對話…</p>}
        {convStatus==='error'&&<div className="banner banner-error" role="alert">對話讀取失敗：{convError}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadConversations()}>重新讀取對話</button></div></div>}
        {convStatus==='ready'&&<div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={convRefresh.loading} onClick={()=>{if(!convRefresh.loading)void loadConversations(true);}}>{convRefresh.loading?'正在整理對話…':'重新整理對話'}</button></div>}
        {convRefresh.error&&<p className="banner banner-error" role="alert">對話重新整理失敗：{convRefresh.error}</p>}
        {convStatus==='ready'&&(conversations.length===0?<p className="empty">還沒有私訊。可搜尋會員開始對話。</p>:<ul className="messages-list" aria-label="對話列表">
          {conversations.map(item=><li key={item.participant.user_id} className={item.unread_count?'is-unread':undefined}>
            <button type="button" className="messages-peer" aria-current={peer===item.participant.user_id?'true':undefined} onClick={()=>select(item.participant.user_id,true)}>
              <MemberAvatar nickname={item.participant.display_name} avatarUrl={item.participant.avatar_url}/>
              <span><strong>{item.participant.display_name}</strong><br/><span className="messages-meta">{item.last_message.sender_ref===me?'你：':''}{item.last_message.body.slice(0,40)}</span></span>
              {item.unread_count>0&&<span className="messages-count">{item.unread_count} 則未讀</span>}
            </button>
          </li>)}
        </ul>)}
        {convMore.error&&<p className="banner banner-error" role="alert">更多對話讀取失敗：{convMore.error}</p>}
        {convStatus==='ready'&&convNext!==null&&<button className="btn btn-ghost" type="button" disabled={convMore.loading} onClick={()=>void moreConversations()}>{convMore.loading?'正在讀取…':convMore.error?'重試載入更多對話':'載入更多對話'}</button>}
      </section>
    </div>
    <section className="messages-thread" aria-labelledby="messages-thread-title" aria-busy={threadStatus==='loading'}>
      {!peer&&<><h2 id="messages-thread-title">私人訊息</h2><p className="muted">從對話列表或會員搜尋選擇對象。</p></>}
      {peer&&<>
        <h2 id="messages-thread-title" ref={heading} tabIndex={-1}>{participant?`與 ${participant.display_name} 的對話`:'讀取對話中'}</h2>
        {threadStatus==='loading'&&<p role="status">正在讀取訊息…</p>}
        {threadStatus==='error'&&<div className="banner banner-error" role="alert">訊息讀取失敗：{threadError}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void loadThread(peer)}>重新讀取訊息</button></div></div>}
        {threadStatus==='ready'&&thread&&<>
          {/* Also the safe way to check an unconfirmed send: the pending key and draft stay as they are. */}
          <div className="messages-actions"><button className="btn btn-ghost" type="button" aria-disabled={threadRefresh.loading} onClick={()=>{if(!threadRefresh.loading)void loadThread(peer,true);}}>{threadRefresh.loading?'正在讀取訊息…':'重新讀取訊息'}</button></div>
          {threadRefresh.error&&<p className="banner banner-error" role="alert">訊息重新讀取失敗：{threadRefresh.error}</p>}
          {thread.next_offset!==null&&<button className="btn btn-ghost" type="button" disabled={threadMore.loading} onClick={()=>void earlier()}>{threadMore.loading?'正在讀取…':threadMore.error?'重試載入較早訊息':'載入較早訊息'}</button>}
          {threadMore.error&&<p className="banner banner-error" role="alert">較早訊息讀取失敗：{threadMore.error}</p>}
          {thread.items.length===0?<p className="empty">還沒有訊息。</p>:<ol className="messages-bubbles" aria-label="訊息">
            {[...thread.items].reverse().map(message=>{const mine=message.sender_ref!==thread.participant.user_id;return <li key={message.message_id} className={mine?'is-mine':undefined}>
              <p className="messages-meta">{mine?'你':thread.participant.display_name} · {formatIsoLocal(message.created_at)}{!mine&&!message.read_at?' · 未讀':''}</p>
              <p className="messages-body">{message.body}</p>
            </li>;})}
          </ol>}
          {thread.unread_count>0&&<div className="messages-actions"><span className="messages-meta">{thread.unread_count} 則未讀</span><button className="btn btn-ghost" type="button" disabled={reading} onClick={()=>void markRead()}>{reading?'正在標記…':'標為已讀'}</button></div>}
          {readError&&<div className="banner banner-error" role="alert">{readError}<div className="messages-actions"><button className="btn btn-ghost" type="button" disabled={reading} onClick={()=>void markRead()}>重試標為已讀</button></div></div>}
          {thread.can_send?<form className="messages-compose" onSubmit={(event:FormEvent)=>{event.preventDefault();void send(peer);}}>
            <label className="field"><span>寫給 {thread.participant.display_name} 的訊息</span>
              <textarea value={draft} readOnly={attempt?.status==='sending'} aria-describedby={sendError?'messages-send-error':undefined}
                onChange={event=>{const text=event.target.value;setDrafts(value=>({...value,[peer]:text}));}}/></label>
            <p className="messages-meta">{[...draft].length}／{MAX_BODY} 字</p>
            {sendError&&<p id="messages-send-error" className="banner banner-error" role="alert">{sendError}</p>}
            <div className="messages-actions">
              <button className="btn btn-primary" type="submit" disabled={attempt?.status==='sending'}>{attempt?.status==='sending'?'正在送出…':attempt?.status==='unknown'&&draft.trim()===attempt.body?'重試送出':'送出'}</button>
            </div>
          </form>:<p className="muted" role="note">對方目前無法接收私訊，仍可查看過去的訊息。</p>}
        </>}
      </>}
    </section>
  </div>;
}

function MemberPicker({client,me,onSelect}:{client:PortalClient;me:string;onSelect:(id:string)=>void}){
  const [query,setQuery]=useState(''),[searched,setSearched]=useState<string|null>(null);
  const [results,setResults]=useState<MemberCardData[]>([]),[next,setNext]=useState<number|null>(null);
  const [status,setStatus]=useState<'idle'|'loading'|'ready'|'error'>('idle'),[error,setError]=useState(''),[more,setMore]=useState({loading:false,error:''});
  const generation=useRef(0);
  const url=(search:string,offset:number)=>`/members?${new URLSearchParams({search,limit:String(PAGE),offset:String(offset)})}`;
  async function search(event?:FormEvent){
    event?.preventDefault();
    const text=query.trim();if(!text)return;
    const current=++generation.current;setSearched(text);setStatus('loading');setError('');setMore({loading:false,error:''});
    try{
      const page=await client.get<MemberPage>(url(text,0));
      if(current!==generation.current)return;
      setResults(page.items);setNext(page.next_offset);setStatus('ready');
    }catch(cause){if(current===generation.current){setError(fail(cause));setStatus('error');}}
  }
  async function loadMore(){
    if(next===null||searched===null||more.loading)return;
    const current=generation.current;setMore({loading:true,error:''});
    try{
      const page=await client.get<MemberPage>(url(searched,next));
      if(current!==generation.current)return;
      setResults(value=>merge(value,page.items,item=>item.user_id));setNext(page.next_offset);setMore({loading:false,error:''});
    }catch(cause){if(current===generation.current)setMore({loading:false,error:fail(cause)});}
  }
  const visible=results.filter(item=>item.user_id!==me&&!item.is_self);
  return <section className="stack messages-search" aria-labelledby="member-picker-title">
    <h2 id="member-picker-title" className="member-section-title">新對話</h2>
    <form className="stack" role="search" onSubmit={event=>void search(event)}>
      <label className="field"><span>搜尋會員</span><input type="search" value={query} maxLength={100} onChange={event=>setQuery(event.target.value)}/></label>
      <button className="btn btn-ghost" type="submit" disabled={!query.trim()||status==='loading'}>{status==='loading'?'搜尋中…':'搜尋會員'}</button>
    </form>
    {status==='error'&&<div className="banner banner-error" role="alert">會員搜尋失敗：{error}<div className="messages-actions"><button className="btn btn-ghost" type="button" onClick={()=>void search()}>重試搜尋</button></div></div>}
    {status==='ready'&&(visible.length===0&&next===null?<p className="empty">找不到符合「{searched}」的會員。</p>:<ul className="messages-list" aria-label="會員搜尋結果">
      {visible.map(item=><li key={item.user_id}><button type="button" className="messages-peer" onClick={()=>onSelect(item.user_id)}>
        <MemberAvatar nickname={item.nickname} avatarUrl={item.avatar_url}/><span>傳訊給 <strong>{item.nickname}</strong></span></button></li>)}
    </ul>)}
    {more.error&&<p className="banner banner-error" role="alert">更多會員讀取失敗：{more.error}</p>}
    {status==='ready'&&next!==null&&<button className="btn btn-ghost" type="button" disabled={more.loading} onClick={()=>void loadMore()}>{more.loading?'正在讀取…':more.error?'重試載入更多會員':'載入更多會員'}</button>}
  </section>;
}
